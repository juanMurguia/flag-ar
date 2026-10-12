import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { alert } from "@/lib/server/alerts";
import { allowedOrigin, readForm, reply } from "@/lib/server/http";
import { LOGO_MAX_BYTES, logoPath, moderateLogo, reencodeLogo, storeLogo } from "@/lib/server/logo";
import { countEvent, hashIp, hourlyCounter, limit } from "@/lib/server/ratelimit";
import { invalidate } from "@/lib/server/startups";
import { BUCKET_PUBLIC, serviceClient } from "@/lib/server/supabase";
import { MIN_FORM_MS, clientIp, networkKey, sniffImage } from "@/lib/server/validate";
import {
  cleanCategory, cleanName, isHexColor, isValidSlug, normalizeStartupLink, slugify,
} from "@/lib/startups/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30; // the NSFW check runs after the response, inside this budget

const PAUSED = "Las altas están pausadas. Probá más tarde.";
const MAX_BODY = LOGO_MAX_BYTES + 16 * 1024;

async function readSettings() {
  const { data, error } = await serviceClient().from("settings").select("key, value");
  if (error) throw new Error(`settings: ${error.message}`);
  const map = new Map((data ?? []).map((r) => [r.key as string, r.value as unknown]));
  return {
    uploadsEnabled: map.get("uploads_enabled") !== false,
    queueCap: Number(map.get("queue_cap") ?? 200),
    siteHourlyCap: Number(map.get("site_hourly_cap") ?? 60),
  };
}

/** Free slug for a name: "pampa", then "pampa-2", "pampa-3"... */
async function freeSlug(name: string): Promise<string> {
  let base = slugify(name);
  if (!base || !isValidSlug(base)) base = `startup-${base}`.replace(/-+$/, "").slice(0, 40);
  const { data, error } = await serviceClient()
    .from("startups").select("slug").like("slug", `${base}%`).limit(500);
  if (error) throw new Error(`slug: ${error.message}`);
  const taken = new Set((data ?? []).map((r) => r.slug as string));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${randomUUID().slice(0, 6)}`;
}

/** "Izar mi bandera": creates the startup, stores the logo, and answers with its number and URL. */
export async function POST(req: Request) {
  if (!allowedOrigin(req)) return reply(403, { message: "Forbidden." });
  const declared = Number(req.headers.get("content-length"));
  if (!declared) return reply(411, { message: "Content-Length is required." });
  if (declared > MAX_BODY) return reply(413, { message: "El logo pesa demasiado. El máximo es 1 MB." });

  const ip = clientIp(req.headers);
  const ipHash = hashIp(ip);
  const perIp = await limit("hoist-ip", ipHash, 5, "1 h");
  const perNet = perIp.ok ? await limit("hoist-net", hashIp(networkKey(ip)), 20, "1 h") : perIp;
  if (!perIp.ok || !perNet.ok) {
    await countEvent("upload-429");
    return reply(429, { message: "Demasiados intentos. Probá en un rato." }, { "retry-after": String(perIp.ok ? perNet.retryAfter : perIp.retryAfter) });
  }

  const form = await readForm(req, MAX_BODY);
  if (!form) return reply(400, { message: "Pedido inválido." });
  if (String(form.get("company") ?? "") !== "") return reply(400, { message: "Pedido inválido." }); // honeypot
  const elapsed = Number(form.get("elapsed"));
  if (!Number.isFinite(elapsed) || elapsed < MIN_FORM_MS) return reply(400, { message: "Muy rápido. Probá de nuevo." });
  if (form.get("rights") !== "1") return reply(400, { message: "Confirmá que tenés derecho a usar el logo." });

  const name = cleanName(form.get("name"));
  if (!name) return reply(400, { message: "Poné el nombre de la startup (hasta 60 caracteres)." });
  const category = cleanCategory(form.get("category"));
  if (!category) return reply(400, { message: "Elegí a qué se dedica la startup." });
  const link = normalizeStartupLink(String(form.get("link") ?? ""));
  if (!link.ok) return reply(400, { message: link.reason });
  const bg = String(form.get("bg") ?? "").toLowerCase();
  if (!isHexColor(bg)) return reply(400, { message: "Color de fondo inválido." });

  const file = form.get("logo");
  if (!(file instanceof File) || file.size === 0) return reply(400, { message: "Subí el logo." });
  const raw = new Uint8Array(await file.arrayBuffer());
  if (!sniffImage(raw)) return reply(415, { message: "Usá un PNG, JPG o SVG." });

  let logo: { png: Buffer; hash: string };
  try {
    logo = await reencodeLogo(raw);
  } catch {
    return reply(422, { message: "No pudimos leer esa imagen. Probá con otro archivo." });
  }

  const db = serviceClient();
  try {
    const settings = await readSettings();
    if (!settings.uploadsEnabled) return reply(503, { message: PAUSED });
    const { count, error: countErr } = await db
      .from("startups").select("id", { count: "exact", head: true }).eq("status", "pending");
    if (countErr) throw new Error(`queue count: ${countErr.message}`);
    if ((count ?? 0) >= settings.queueCap) {
      await alert("queue-full", `Pending queue is full (${count}/${settings.queueCap}). New flags are paused.`);
      return reply(503, { message: PAUSED });
    }
    const site = await hourlyCounter("upload-site", settings.siteHourlyCap);
    if (!site.ok) {
      await alert("site-cap", `Site-wide cap reached (${settings.siteHourlyCap}/h). New flags are paused.`);
      return reply(503, { message: PAUSED }, { "retry-after": String(site.retryAfter) });
    }

    const { data: blocked, error: blockErr } = await db
      .from("blocklist").select("kind")
      .or(`and(kind.eq.domain,value.eq."${link.domain}"),and(kind.eq.file_hash,value.eq.${logo.hash})`)
      .limit(1);
    if (blockErr) throw new Error(`blocklist: ${blockErr.message}`);
    if (blocked && blocked.length > 0) return reply(403, { message: "Esta bandera no se puede izar." });

    const id = randomUUID();
    const path = logoPath(id, 0);
    await storeLogo(path, logo.png);

    // Two people can race for one slug. The unique index decides; the loser retries with a new slug.
    let row: { slug: string; order_number: number } | null = null;
    for (let attempt = 0; attempt < 3 && !row; attempt++) {
      const slug = await freeSlug(name);
      const { data, error } = await db.from("startups").insert({
        id, slug, name, category, link: link.url, domain: link.domain, logo_path: path, bg_color: bg,
        ip_hash: ipHash, file_hash: logo.hash, rights_confirmed_at: new Date().toISOString(),
      }).select("slug, order_number").single();
      if (!error) {
        row = data as { slug: string; order_number: number };
        break;
      }
      if (error.code === "23505" && error.message.includes("one_startup_per_domain")) {
        await db.storage.from(BUCKET_PUBLIC).remove([path]);
        return reply(409, { message: "Ese dominio ya tiene su bandera. Si es tuya, editala con el link mágico." });
      }
      if (error.code !== "23505") {
        await db.storage.from(BUCKET_PUBLIC).remove([path]);
        throw new Error(`insert: ${error.message}`);
      }
    }
    if (!row) throw new Error("insert: no free slug");

    invalidate(row.slug);
    after(() => moderateLogo(id, row.slug, path, logo.png));
    return reply(201, { slug: row.slug, order: Number(row.order_number), status: "pending" });
  } catch (e) {
    console.error("[startups]", e);
    await alert("upload-db", `Create route failed: ${(e as Error).message}`, 900);
    return reply(503, { message: PAUSED });
  }
}
