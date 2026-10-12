import { notFound, requireAdmin } from "@/lib/server/adminAuth";
import { sameOrigin } from "@/lib/server/csrf";
import { readJson, reply } from "@/lib/server/http";
import { invalidate } from "@/lib/server/startups";
import { BUCKET_PUBLIC, serviceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Action = "approve" | "reject" | "feature" | "unfeature" | "clear-reports";
const ACTIONS = new Set<Action>(["approve", "reject", "feature", "unfeature", "clear-reports"]);

/** Moderation. The proxy already checked the session; this checks again (aal2 + admins row). */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return notFound();
  const auth = await requireAdmin();
  if (!auth.ok) return notFound();

  const body = await readJson<{ id?: string; action?: Action; reason?: string; blockDomain?: boolean; blockHash?: boolean }>(req);
  if (!body?.id || !UUID.test(body.id) || !body.action || !ACTIONS.has(body.action)) {
    return reply(400, { message: "Bad request." });
  }
  const db = serviceClient();
  const { data: row, error } = await db
    .from("startups").select("id, slug, domain, file_hash, logo_path, status").eq("id", body.id).maybeSingle();
  if (error) return reply(500, { message: error.message });
  if (!row) return reply(404, { message: "Not found." });

  const now = new Date().toISOString();
  const review = { reviewed_at: now, reviewed_by: auth.user.id };
  let patch: Record<string, unknown>;
  switch (body.action) {
    case "approve":
      if (!row.logo_path) return reply(409, { message: "This flag has no logo." });
      patch = { ...review, status: "approved", approved_at: now, reject_reason: null };
      break;
    case "reject":
      patch = { ...review, status: "rejected", reject_reason: body.reason?.trim().slice(0, 500) || null, logo_path: null, featured: false };
      break;
    case "feature":
      if (row.status !== "approved") return reply(409, { message: "Only approved flags can be featured." });
      patch = { featured: true };
      break;
    case "unfeature":
      patch = { featured: false };
      break;
    case "clear-reports":
      await db.from("startup_reports").delete().eq("startup_id", row.id);
      patch = { report_count: 0 };
      break;
  }
  const { error: upErr } = await db.from("startups").update(patch).eq("id", row.id);
  if (upErr) return reply(500, { message: upErr.message });

  if (body.action === "reject") {
    // A rejected logo leaves the public bucket: its URL must stop working too.
    if (row.logo_path) await db.storage.from(BUCKET_PUBLIC).remove([row.logo_path as string]);
    const blocks = [
      ...(body.blockDomain ? [{ kind: "domain", value: row.domain }] : []),
      ...(body.blockHash && row.file_hash ? [{ kind: "file_hash", value: row.file_hash }] : []),
    ];
    if (blocks.length) await db.from("blocklist").upsert(blocks, { onConflict: "kind,value", ignoreDuplicates: true });
  }
  invalidate(row.slug as string);
  return reply(200, { message: "Done." });
}
