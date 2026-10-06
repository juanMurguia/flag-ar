import { timingSafeEqual } from "node:crypto";
import { alert } from "@/lib/server/alerts";
import { env } from "@/lib/server/env";
import { rebuildManifest } from "@/lib/server/manifest";
import { readEvents } from "@/lib/server/ratelimit";
import { BUCKET_PENDING, serviceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DENIED_RETENTION_DAYS = 90;
const SPIKE_429_PER_HOUR = 100;

function authorized(req: Request): boolean {
  const got = Buffer.from(req.headers.get("authorization") || "");
  const want = Buffer.from(`Bearer ${env.cronSecret()}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Called hourly by pg_cron + pg_net and daily by Vercel Cron.
 * Deletes files of denied requests, keeps the database awake, rebuilds the manifest, sends alerts.
 */
async function run(req: Request) {
  if (!authorized(req)) return new Response("Not Found", { status: 404 });
  const db = serviceClient();
  const report: Record<string, unknown> = {};

  try {
    // Keep-alive: one real query stops the Free plan inactivity pause.
    const { data: settings, error } = await db.from("settings").select("key, value");
    if (error) throw new Error(`settings: ${error.message}`);
    const queueCap = Number(settings?.find((s) => s.key === "queue_cap")?.value ?? 200);

    // Cleanup: files of denied or removed requests.
    const { data: stale, error: staleErr } = await db
      .from("logo_requests").select("id, file_path")
      .in("status", ["denied", "removed"]).not("file_path", "is", null).limit(500);
    if (staleErr) throw new Error(`cleanup read: ${staleErr.message}`);
    if (stale && stale.length > 0) {
      const { error: rmErr } = await db.storage.from(BUCKET_PENDING).remove(stale.map((r) => r.file_path as string));
      if (rmErr) throw new Error(`cleanup files: ${rmErr.message}`);
      const { error: updErr } = await db
        .from("logo_requests").update({ file_path: null }).in("id", stale.map((r) => r.id as string));
      if (updErr) throw new Error(`cleanup rows: ${updErr.message}`);
    }
    report.filesDeleted = stale?.length ?? 0;

    // Old denied rows go after the retention period. Block-list entries stay.
    const cutoff = new Date(Date.now() - DENIED_RETENTION_DAYS * 86_400_000).toISOString();
    const { count: purged, error: purgeErr } = await db
      .from("logo_requests").delete({ count: "exact" })
      .eq("status", "denied").is("file_path", null).lt("reviewed_at", cutoff);
    if (purgeErr) throw new Error(`purge: ${purgeErr.message}`);
    report.deniedRowsPurged = purged ?? 0;

    // Queue health
    const { count: pending, error: pendErr } = await db
      .from("logo_requests").select("id", { count: "exact", head: true }).eq("status", "pending");
    if (pendErr) throw new Error(`queue: ${pendErr.message}`);
    report.pending = pending ?? 0;
    if ((pending ?? 0) >= queueCap * 0.8) {
      await alert("queue-high", `Pending queue at ${pending}/${queueCap}.`, 6 * 3600);
    }

    // Fixes any stale manifest from a failed or racing write.
    await rebuildManifest();
  } catch (e) {
    console.error("[cron]", e);
    await alert("cron-db", `Cron job failed: ${(e as Error).message}`, 3600);
    return Response.json({ ok: false, ...report }, { status: 500 });
  }

  const spikes = await readEvents("upload-429", 1).catch(() => 0);
  report.lastHour429 = spikes;
  if (spikes > SPIKE_429_PER_HOUR) await alert("429-spike", `${spikes} upload requests got 429 in the last hour.`);

  return Response.json({ ok: true, ...report });
}

export const GET = run; // Vercel Cron
export const POST = run; // pg_cron + pg_net
