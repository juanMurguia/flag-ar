import { createHash, randomUUID } from "node:crypto";
import { alert } from "@/lib/server/alerts";
import { env, isProd } from "@/lib/server/env";
import { countEvent, hashIp, hourlyCounter, limit } from "@/lib/server/ratelimit";
import { BUCKET_PENDING, serviceClient } from "@/lib/server/supabase";
import {
  MAX_BODY_BYTES, MAX_FILE_BYTES, MIN_FORM_MS, clientIp, networkKey, normalizeLink, sniffImage,
} from "@/lib/server/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAUSED = "Uploads are paused. Try again later.";
const SENT = "Sent for review. We show it after approval.";

function reply(status: number, message: string, headers: Record<string, string> = {}) {
  return Response.json({ message }, { status, headers: { "cache-control": "no-store", ...headers } });
}

async function readCapped(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

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

export async function POST(req: Request) {
  // ---- Layer 3: early reject (no body read yet) ----
  const origin = req.headers.get("origin");
  const sameOrigin = origin === new URL(req.url).origin;
  if (!origin || !(env.allowedOrigins().includes(origin) || (!isProd && sameOrigin))) {
    return reply(403, "Forbidden.");
  }
  if (!(req.headers.get("content-type") || "").startsWith("multipart/form-data")) {
    return reply(415, "Send the form as multipart/form-data.");
  }
  const declared = Number(req.headers.get("content-length"));
  if (!declared) return reply(411, "Content-Length is required.");
  if (declared > MAX_BODY_BYTES) return reply(413, "The file is too large. The limit is 512 KiB.");

  const ip = clientIp(req.headers);
  const ipHash = hashIp(ip);

  // ---- Layer 4: rate limits, before any parsing work ----
  const perIp = await limit("upload-ip", ipHash, 10, "1 h");
  const perNet = perIp.ok ? await limit("upload-net", hashIp(networkKey(ip)), 30, "1 h") : perIp;
  if (!perIp.ok || !perNet.ok) {
    await countEvent("upload-429");
    const r = !perIp.ok ? perIp : perNet;
    return reply(429, "Too many uploads. Try again later.", { "retry-after": String(r.retryAfter) });
  }

  // Body size is enforced while reading, even if Content-Length lies.
  const body = await readCapped(req, MAX_BODY_BYTES);
  if (!body) return reply(413, "The file is too large. The limit is 512 KiB.");
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": req.headers.get("content-type")! } }).formData();
  } catch {
    return reply(400, "Bad request.");
  }

  // ---- Layer 5: bot checks ----
  if (String(form.get("company") ?? "") !== "") return reply(200, SENT); // honeypot: drop silently
  const elapsed = Number(form.get("elapsed"));
  if (!Number.isFinite(elapsed) || elapsed < MIN_FORM_MS) return reply(400, "That was too fast. Try again.");

  // ---- Layer 6: cheap rules ----
  const file = form.get("logo");
  if (!(file instanceof File) || file.size === 0) return reply(400, "Add a logo file.");
  if (file.size > MAX_FILE_BYTES) return reply(413, "The file is too large. The limit is 512 KiB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) return reply(415, "Use a PNG, JPEG, or WebP file.");

  const link = normalizeLink(String(form.get("link") ?? ""));
  if (!link.ok) return reply(400, link.reason);

  const db = serviceClient();
  try {
    // ---- Circuit breakers ----
    const settings = await readSettings();
    if (!settings.uploadsEnabled) return reply(503, PAUSED);

    const { count, error: countErr } = await db
      .from("logo_requests").select("id", { count: "exact", head: true }).eq("status", "pending");
    if (countErr) throw new Error(`queue count: ${countErr.message}`);
    if ((count ?? 0) >= settings.queueCap) {
      await alert("queue-full", `Pending queue is full (${count}/${settings.queueCap}). Uploads are paused.`);
      return reply(503, PAUSED);
    }
    const site = await hourlyCounter("upload-site", settings.siteHourlyCap);
    if (!site.ok) {
      await alert("site-cap", `Site-wide upload cap reached (${settings.siteHourlyCap}/h). Uploads are paused.`);
      return reply(503, PAUSED, { "retry-after": String(site.retryAfter) });
    }

    // ---- Layer 7: database rules ----
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    const { data: blocked, error: blockErr } = await db
      .from("blocklist").select("kind")
      .or(`and(kind.eq.domain,value.eq.${link.domain}),and(kind.eq.file_hash,value.eq.${fileHash})`)
      .limit(1);
    if (blockErr) throw new Error(`blocklist: ${blockErr.message}`);
    if (blocked && blocked.length > 0) return reply(403, "This upload is not allowed.");

    // ---- Layer 8: quarantine ----
    const id = randomUUID();
    const path = `${id}.${kind.ext}`;
    const { error: upErr } = await db.storage.from(BUCKET_PENDING).upload(path, bytes, {
      contentType: kind.mime,
      upsert: false,
    });
    if (upErr) throw new Error(`storage: ${upErr.message}`);

    const { error: insErr } = await db.from("logo_requests").insert({
      id,
      website_url: link.url,
      domain: link.domain,
      file_hash: fileHash,
      file_path: path,
      ip_hash: ipHash,
    });
    if (insErr) {
      await db.storage.from(BUCKET_PENDING).remove([path]);
      if (insErr.code === "23505") {
        return reply(409, "This domain already has a logo on the flag or in review.");
      }
      throw new Error(`insert: ${insErr.message}`);
    }
    return reply(201, SENT);
  } catch (e) {
    console.error("[upload]", e);
    await alert("upload-db", `Upload route failed: ${(e as Error).message}`, 900);
    return reply(503, PAUSED);
  }
}
