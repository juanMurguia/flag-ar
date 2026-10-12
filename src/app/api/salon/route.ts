import { listApproved } from "@/lib/server/startups";

export const runtime = "nodejs";

/**
 * Every approved flag, compact, for the Hall of Fame. Served from Vercel's CDN:
 * one database read per region every minute at most, whatever the traffic.
 */
export async function GET() {
  try {
    const list = await listApproved();
    return Response.json(
      { count: list.length, startups: list },
      {
        headers: {
          "cache-control": "public, max-age=0, must-revalidate",
          "vercel-cdn-cache-control": "public, s-maxage=60, stale-while-revalidate=600, stale-if-error=86400",
        },
      },
    );
  } catch (e) {
    console.error("[salon]", (e as Error).message);
    return new Response("Service Unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  }
}
