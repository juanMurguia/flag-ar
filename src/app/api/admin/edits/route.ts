import { notFound, requireAdmin } from "@/lib/server/adminAuth";
import { sameOrigin } from "@/lib/server/csrf";
import { readJson, reply } from "@/lib/server/http";
import { logoPath } from "@/lib/server/logo";
import { invalidate } from "@/lib/server/startups";
import { BUCKET_PUBLIC, serviceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Action = "apply" | "discard";

/**
 * Change requests. "apply" copies the proposed state onto the flag (a new logo moves to the flag's
 * versioned path, the old one is deleted); "discard" drops the request and its logo. Either way the
 * request row is gone afterwards. The proxy already checked the session; this checks again.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return notFound();
  const auth = await requireAdmin();
  if (!auth.ok) return notFound();

  const body = await readJson<{ id?: string; action?: Action }>(req);
  if (!body?.id || !UUID.test(body.id) || (body.action !== "apply" && body.action !== "discard")) {
    return reply(400, { message: "Bad request." });
  }
  const db = serviceClient();
  const { data: r, error } = await db
    .from("edit_requests").select("id, startup_id, name, category, bg_color, logo_path, file_hash").eq("id", body.id).maybeSingle();
  if (error) return reply(500, { message: error.message });
  if (!r) return reply(404, { message: "Not found." });

  if (body.action === "discard") {
    if (r.logo_path) await db.storage.from(BUCKET_PUBLIC).remove([r.logo_path as string]);
    await db.from("edit_requests").delete().eq("id", r.id);
    return reply(200, { message: "Discarded." });
  }

  const { data: s, error: sErr } = await db
    .from("startups").select("id, slug, logo_path, edit_version, status").eq("id", r.startup_id).maybeSingle();
  if (sErr) return reply(500, { message: sErr.message });
  if (!s || s.status === "rejected") return reply(409, { message: "That flag is gone." });

  const version = (s.edit_version as number) + 1;
  const patch: Record<string, unknown> = {
    name: r.name, category: r.category, bg_color: r.bg_color, edit_version: version,
    updated_at: new Date().toISOString(), reviewed_at: new Date().toISOString(), reviewed_by: auth.user.id,
  };
  let newPath: string | null = null;
  if (r.logo_path) {
    // The admin just looked at this logo: that is the review. Move it to the flag's versioned name.
    newPath = logoPath(s.id as string, version);
    const { error: mvErr } = await db.storage.from(BUCKET_PUBLIC).move(r.logo_path as string, newPath);
    if (mvErr) return reply(500, { message: `storage: ${mvErr.message}` });
    Object.assign(patch, { logo_path: newPath, file_hash: r.file_hash });
  }
  // Optimistic lock: two admins applying two requests at once cannot both win.
  const { data: updated, error: upErr } = await db
    .from("startups").update(patch).eq("id", s.id).eq("edit_version", s.edit_version).select("id");
  if (upErr || !updated?.length) {
    if (newPath) await db.storage.from(BUCKET_PUBLIC).move(newPath, r.logo_path as string);
    return reply(409, { message: upErr?.message ?? "The flag changed meanwhile. Reload and try again." });
  }
  if (newPath && s.logo_path) await db.storage.from(BUCKET_PUBLIC).remove([s.logo_path as string]);
  await db.from("edit_requests").delete().eq("id", r.id);
  invalidate(s.slug as string);
  return reply(200, { message: "Applied." });
}
