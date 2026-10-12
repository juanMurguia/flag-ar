import { after } from "next/server";
import { verifyEditToken } from "@/lib/server/editToken";
import { env } from "@/lib/server/env";
import { allowedOrigin, readForm, reply } from "@/lib/server/http";
import { LOGO_MAX_BYTES, logoPath, moderateLogo, reencodeLogo, storeLogo } from "@/lib/server/logo";
import { hashIp, limit } from "@/lib/server/ratelimit";
import { invalidate } from "@/lib/server/startups";
import { BUCKET_PUBLIC, serviceClient } from "@/lib/server/supabase";
import { clientIp, sniffImage } from "@/lib/server/validate";
import { cleanCategory, cleanName, isHexColor } from "@/lib/startups/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BODY = LOGO_MAX_BYTES + 16 * 1024;
const EXPIRED = "El link venció o ya se usó. Pedí uno nuevo.";

/** Checks a magic link token. GET answers what the edit form needs. */
async function claimsFrom(token: string) {
  const c = verifyEditToken(token, env.editTokenSecret());
  if (!c) return null;
  const { data } = await serviceClient()
    .from("startups").select("id, slug, name, category, bg_color, logo_path, edit_version, status")
    .eq("id", c.sid).maybeSingle();
  if (!data || data.edit_version !== c.v || data.status === "rejected") return null;
  return { claims: c, row: data };
}

export async function GET(req: Request) {
  const token = req.headers.get("x-edit-token") ?? "";
  const r = await claimsFrom(token);
  if (!r) return reply(401, { message: EXPIRED });
  return reply(200, {
    slug: r.row.slug, name: r.row.name, category: r.row.category, bgColor: r.row.bg_color,
    logoUrl: r.row.logo_path ? `/files/${r.row.logo_path}` : null,
  });
}

/** Applies one edit. A new logo sends the flag back to review (it stays on its own URL meanwhile). */
export async function POST(req: Request) {
  if (!allowedOrigin(req)) return reply(403, { message: "Forbidden." });
  const rl = await limit("edit-ip", hashIp(clientIp(req.headers)), 10, "1 h");
  if (!rl.ok) return reply(429, { message: "Demasiados intentos." }, { "retry-after": String(rl.retryAfter) });

  const form = await readForm(req, MAX_BODY);
  if (!form) return reply(400, { message: "Pedido inválido." });
  const r = await claimsFrom(String(form.get("token") ?? ""));
  if (!r) return reply(401, { message: EXPIRED });

  const name = cleanName(form.get("name"));
  const category = cleanCategory(form.get("category"));
  const bg = String(form.get("bg") ?? "").toLowerCase();
  if (!name || !category || !isHexColor(bg)) return reply(400, { message: "Revisá nombre, categoría y color." });

  const db = serviceClient();
  const version = r.claims.v + 1;
  const patch: Record<string, unknown> = {
    name, category, bg_color: bg, edit_version: version, updated_at: new Date().toISOString(),
  };

  let newLogo: { path: string; png: Buffer } | null = null;
  const file = form.get("logo");
  if (file instanceof File && file.size > 0) {
    const raw = new Uint8Array(await file.arrayBuffer());
    if (!sniffImage(raw)) return reply(415, { message: "Usá un PNG, JPG o SVG." });
    try {
      const { png, hash } = await reencodeLogo(raw);
      const path = logoPath(r.row.id as string, version);
      await storeLogo(path, png);
      newLogo = { path, png };
      Object.assign(patch, { logo_path: path, file_hash: hash, nsfw_score: null, status: "pending", approved_at: null });
    } catch {
      return reply(422, { message: "No pudimos leer esa imagen." });
    }
  }

  // Optimistic lock on edit_version: two tabs with the same link cannot both win.
  const { data: updated, error } = await db
    .from("startups").update(patch).eq("id", r.row.id).eq("edit_version", r.claims.v).select("id");
  if (error || !updated?.length) {
    if (newLogo) await db.storage.from(BUCKET_PUBLIC).remove([newLogo.path]);
    return reply(409, { message: EXPIRED });
  }
  if (newLogo && r.row.logo_path) await db.storage.from(BUCKET_PUBLIC).remove([r.row.logo_path as string]);

  invalidate(r.row.slug as string);
  if (newLogo) {
    const { path, png } = newLogo;
    after(() => moderateLogo(r.row.id as string, r.row.slug as string, path, png));
  }
  return reply(200, { slug: r.row.slug, message: newLogo ? "Listo. El logo nuevo vuelve a revisión para el salón." : "Listo." });
}
