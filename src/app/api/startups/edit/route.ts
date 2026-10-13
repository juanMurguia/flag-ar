import { randomUUID } from "node:crypto";
import { alert } from "@/lib/server/alerts";
import { allowedOrigin, readForm, reply } from "@/lib/server/http";
import { LOGO_MAX_BYTES, reencodeLogo, storeLogo } from "@/lib/server/logo";
import { hashIp, limit } from "@/lib/server/ratelimit";
import { BUCKET_PUBLIC, serviceClient } from "@/lib/server/supabase";
import { clientIp, sniffImage } from "@/lib/server/validate";
import { cleanCategory, cleanName, isHexColor, isValidSlug } from "@/lib/startups/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BODY = LOGO_MAX_BYTES + 16 * 1024;

/**
 * "Pedir un cambio": stores a change request for a flag. Nothing changes on the flag itself; an admin
 * applies the request or discards it (/api/admin/edits). Anyone can ask, so the admin is the check.
 */
export async function POST(req: Request) {
  if (!allowedOrigin(req)) return reply(403, { message: "Forbidden." });
  const ipHash = hashIp(clientIp(req.headers));
  const rl = await limit("editreq-ip", ipHash, 5, "1 h");
  if (!rl.ok) return reply(429, { message: "Demasiados pedidos. Probá más tarde." }, { "retry-after": String(rl.retryAfter) });

  const form = await readForm(req, MAX_BODY);
  if (!form) return reply(400, { message: "Pedido inválido." });
  const slug = String(form.get("slug") ?? "");
  const name = cleanName(form.get("name"));
  const category = cleanCategory(form.get("category"));
  const bg = String(form.get("bg") ?? "").toLowerCase();
  const note = String(form.get("note") ?? "").trim().slice(0, 500) || null;
  if (!isValidSlug(slug) || !name || !category || !isHexColor(bg)) return reply(400, { message: "Revisá nombre, categoría y color." });

  const db = serviceClient();
  const { data: s, error } = await db
    .from("startups").select("id, slug, name, category, bg_color").eq("slug", slug).neq("status", "rejected").maybeSingle();
  if (error) return reply(500, { message: "Probá más tarde." });
  if (!s) return reply(404, { message: "No encontramos esa bandera." });

  // Per-flag cap too, so nobody buries the review queue under one flag from many IPs.
  const perFlag = await limit("editreq-flag", s.id as string, 5, "24 h");
  if (!perFlag.ok) return reply(429, { message: "Esta bandera ya tiene pedidos pendientes. Esperá la revisión." });

  const id = randomUUID();
  let logo: { path: string; hash: string } | null = null;
  const file = form.get("logo");
  if (file instanceof File && file.size > 0) {
    const raw = new Uint8Array(await file.arrayBuffer());
    if (!sniffImage(raw)) return reply(415, { message: "Usá un PNG, JPG o SVG." });
    try {
      const { png, hash } = await reencodeLogo(raw);
      const path = `r/${id}.png`;
      await storeLogo(path, png);
      logo = { path, hash };
    } catch {
      return reply(422, { message: "No pudimos leer esa imagen." });
    }
  }

  const same = name === s.name && category === s.category && bg === s.bg_color;
  if (same && !logo && !note) return reply(400, { message: "No cambiaste nada." });

  const { error: insErr } = await db.from("edit_requests").insert({
    id, startup_id: s.id, name, category, bg_color: bg, logo_path: logo?.path ?? null, file_hash: logo?.hash ?? null, note, ip_hash: ipHash,
  });
  if (insErr) {
    if (logo) await db.storage.from(BUCKET_PUBLIC).remove([logo.path]);
    return reply(500, { message: "No pudimos guardar el pedido." });
  }
  await alert(`edit:${s.id}`, `Change request for /${s.slug}. Review it in the admin (Edits).`, 600);
  return reply(200, { message: "Listo. Recibimos tu pedido: lo revisamos y, si está bien, lo aplicamos." });
}
