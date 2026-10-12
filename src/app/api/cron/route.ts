import { timingSafeEqual } from "node:crypto";
import { alert } from "@/lib/server/alerts";
import { env } from "@/lib/server/env";
import { moderateLogo } from "@/lib/server/logo";
import { readEvents } from "@/lib/server/ratelimit";
import { BUCKET_PUBLIC, serviceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const REJECTED_RETENTION_DAYS = 90;
const SPIKE_429_PER_HOUR = 100;
const NSFW_RETRY_BATCH = 10;

function authorized(req: Request): boolean {
  const got = Buffer.from(req.headers.get("authorization") || "");
  const want = Buffer.from(`Bearer ${env.cronSecret()}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Called hourly by pg_cron + pg_net and daily by Vercel Cron.
 * Keeps the database awake, retries missed NSFW checks, purges old rejected rows, sends alerts.
 */
async function run(req: Request) {
  if (!authorized(req)) return new Response("Not Found", { status: 404 });
  const db = serviceClient();
  const report: Record<string, unknown> = {};

  try {
    const { data: settings, error } = await db.from("settings").select("key, value");
    if (error) throw new Error(`settings: ${error.message}`);
    const queueCap = Number(settings?.find((s) => s.key === "queue_cap")?.value ?? 200);

    // NSFW checks that never ran (the function died after the response). Older than 5 minutes.
    const cutoff5 = new Date(Date.now() - 5 * 60_000).toISOString();
    const { data: unchecked, error: unErr } = await db
      .from("startups").select("id, slug, logo_path")
      .is("nsfw_score", null).not("logo_path", "is", null).neq("status", "rejected")
      .lt("created_at", cutoff5).limit(NSFW_RETRY_BATCH);
    if (unErr) throw new Error(`nsfw retry read: ${unErr.message}`);
    for (const r of unchecked ?? []) {
      const { data: blob } = await db.storage.from(BUCKET_PUBLIC).download(r.logo_path as string);
      if (blob) await moderateLogo(r.id as string, r.slug as string, r.logo_path as string, Buffer.from(await blob.arrayBuffer()));
    }
    report.nsfwRetried = unchecked?.length ?? 0;

    const cutoff = new Date(Date.now() - REJECTED_RETENTION_DAYS * 86_400_000).toISOString();
    const { count: purged, error: purgeErr } = await db
      .from("startups").delete({ count: "exact" })
      .eq("status", "rejected").is("logo_path", null).lt("reviewed_at", cutoff);
    if (purgeErr) throw new Error(`purge: ${purgeErr.message}`);
    report.rejectedPurged = purged ?? 0;

    const { count: pending, error: pendErr } = await db
      .from("startups").select("id", { count: "exact", head: true }).eq("status", "pending");
    if (pendErr) throw new Error(`queue: ${pendErr.message}`);
    report.pending = pending ?? 0;
    if ((pending ?? 0) >= queueCap * 0.8) {
      await alert("queue-high", `Pending queue at ${pending}/${queueCap}.`, 6 * 3600);
    }
  } catch (e) {
    console.error("[cron]", e);
    await alert("cron-db", `Cron job failed: ${(e as Error).message}`, 3600);
    return Response.json({ ok: false, ...report }, { status: 500 });
  }

  const spikes = await readEvents("upload-429", 1).catch(() => 0);
  report.lastHour429 = spikes;
  if (spikes > SPIKE_429_PER_HOUR) await alert("429-spike", `${spikes} hoist requests got 429 in the last hour.`);

  return Response.json({ ok: true, ...report });
}

export const GET = run; // Vercel Cron
export const POST = run; // pg_cron + pg_net
