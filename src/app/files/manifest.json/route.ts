import { env } from "@/lib/server/env";
import { BUCKET_PUBLIC } from "@/lib/server/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves manifest.json. This static route wins over the /files/* rewrite.
 * Why: on the Supabase Free plan the Storage CDN does not purge a file when it changes,
 * so the public URL (and even supabase-js download()) can serve an old manifest.
 * A removed logo would stay on the flag. The authenticated endpoint with a unique
 * query string skips that cache. Vercel's CDN caches this reply for 30 s,
 * so Supabase sees about 2 reads a minute per region.
 */
export async function GET() {
  const url = `${env.supabaseUrl()}/storage/v1/object/authenticated/${BUCKET_PUBLIC}/manifest.json?nonce=${Date.now()}`;
  const key = env.serviceRoleKey();
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${key}`, apikey: key },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`storage ${res.status}`);
    return new Response(await res.text(), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        // Same values as next.config.ts. Set here too, so a dynamic route cannot drop them.
        "cache-control": "public, max-age=0, must-revalidate",
        "vercel-cdn-cache-control": "public, s-maxage=30, stale-while-revalidate=300, stale-if-error=86400",
      },
    });
  } catch (e) {
    console.error("[manifest]", (e as Error).message);
    // 503, not 404: Vercel's stale-if-error keeps serving the last good copy.
    return new Response("Service Unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  }
}
