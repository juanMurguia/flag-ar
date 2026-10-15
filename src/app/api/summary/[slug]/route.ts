import { getSummary } from "@/lib/server/summary";
import { isValidSlug } from "@/lib/startups/model";

export const runtime = "nodejs";

/**
 * One line on what a flag's startup does, read from its site's meta tags. Takes a slug, never a URL:
 * the server fetches only links already on an approved flag. Served from the CDN for a day.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/summary/[slug]">) {
  const { slug } = await ctx.params;
  if (!isValidSlug(slug)) return Response.json({ summary: null }, { status: 404 });
  const summary = await getSummary(slug).catch(() => null);
  return Response.json(
    { summary },
    {
      headers: {
        "cache-control": "public, max-age=3600",
        "vercel-cdn-cache-control": "public, s-maxage=86400, stale-while-revalidate=604800",
      },
    },
  );
}
