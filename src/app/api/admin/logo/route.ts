import { notFound, requireAdmin } from "@/lib/server/adminAuth";
import { sameOrigin } from "@/lib/server/csrf";
import { readForm, reply } from "@/lib/server/http";
import { LOGO_MAX_BYTES, logoPath, reencodeLogo, storeLogo } from "@/lib/server/logo";
import { invalidate } from "@/lib/server/startups";
import { isHexColor } from "@/lib/startups/model";
import { BUCKET_PUBLIC, serviceClient } from "@/lib/server/supabase";
import { sniffImage } from "@/lib/server/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = LOGO_MAX_BYTES + 16 * 1024;

/**
 * Admin replaces a flag's logo directly, with no change request. Same storage rules as an applied
 * edit: new versioned path, optimistic lock on edit_version, old file deleted. The admin picked the
 * file, so there is no review step and no NSFW check.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return notFound();
  const auth = await requireAdmin();
  if (!auth.ok) return notFound();

  const form = await readForm(req, MAX_BODY);
  const id = String(form?.get("id") ?? "");
  const file = form?.get("logo");
  const bg = String(form?.get("bg") ?? "").toLowerCase();
  if (!form || !UUID.test(id) || !(file instanceof File) || file.size === 0 || !isHexColor(bg)) return reply(400, { message: "Bad request." });

  const raw = new Uint8Array(await file.arrayBuffer());
  if (!sniffImage(raw)) return reply(415, { message: "Use a PNG, JPG or WebP." });
  let png: Buffer, hash: string;
  try {
    ({ png, hash } = await reencodeLogo(raw));
  } catch {
    return reply(422, { message: "Could not read that image." });
  }

  const db = serviceClient();
  const { data: s, error } = await db
    .from("startups").select("id, slug, logo_path, edit_version, status").eq("id", id).maybeSingle();
  if (error) return reply(500, { message: error.message });
  if (!s) return reply(404, { message: "Not found." });
  if (s.status === "rejected") return reply(409, { message: "Rejected flags have no logo." });

  const version = (s.edit_version as number) + 1;
  const newPath = logoPath(s.id as string, version);
  try {
    await storeLogo(newPath, png);
  } catch (e) {
    return reply(500, { message: (e as Error).message });
  }
  const now = new Date().toISOString();
  const { data: updated, error: upErr } = await db
    .from("startups")
    .update({ logo_path: newPath, file_hash: hash, bg_color: bg, edit_version: version, updated_at: now, reviewed_at: now, reviewed_by: auth.user.id })
    .eq("id", s.id).eq("edit_version", s.edit_version).select("id");
  if (upErr || !updated?.length) {
    await db.storage.from(BUCKET_PUBLIC).remove([newPath]);
    return reply(409, { message: upErr?.message ?? "The flag changed meanwhile. Reload and try again." });
  }
  if (s.logo_path) await db.storage.from(BUCKET_PUBLIC).remove([s.logo_path as string]);
  invalidate(s.slug as string);
  return reply(200, { message: "Logo replaced." });
}
