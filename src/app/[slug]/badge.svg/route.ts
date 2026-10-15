import { getStartup, listApproved } from "@/lib/server/startups";
import { bySeat, isValidSlug } from "@/lib/startups/model";

export const runtime = "nodejs";

const H = 28;
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const SKY = "#74ACDF";
const NAVY = "#0B1F3A";
const SUN = "#F6B40E";

/** Rough width of `s` at 11px bold. `textLength` then fits the glyphs to it exactly, whatever font loads. */
function textWidth(s: string) {
  return Math.ceil([...s].length * 6.9);
}

/**
 * Two parts, like a shields.io badge: "flag.ar" with a small Argentine flag, then the live rank.
 * The SVG holds no user text (no name), so nothing in it needs escaping.
 */
function badge(right: string) {
  const leftW = 76;
  const rightW = textWidth(right) + 20;
  const w = leftW + rightW;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" role="img" aria-label="flag.ar: ${right}">
<title>flag.ar: ${right}</title>
<clipPath id="r"><rect width="${w}" height="${H}" rx="6"/></clipPath>
<g clip-path="url(#r)">
<rect width="${leftW}" height="${H}" fill="${NAVY}"/>
<rect x="${leftW}" width="${rightW}" height="${H}" fill="${SKY}"/>
</g>
<g transform="translate(9 8)">
<rect width="18" height="12" rx="1.5" fill="#fff"/>
<rect width="18" height="4" rx="1.5" fill="${SKY}"/>
<rect y="8" width="18" height="4" rx="1.5" fill="${SKY}"/>
<circle cx="9" cy="6" r="1.6" fill="${SUN}"/>
</g>
<g font-family="${FONT}" font-size="11" font-weight="700">
<text x="33" y="18" fill="#fff" textLength="35" lengthAdjust="spacingAndGlyphs">flag.ar</text>
<text x="${leftW + 10}" y="18" fill="${NAVY}" textLength="${textWidth(right)}" lengthAdjust="spacingAndGlyphs">${right}</text>
</g>
</svg>`;
}

function svg(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // Opened on its own, the SVG may not run anything.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
      // Sites and READMEs embed it: the CDN answers, the rank is at most a few minutes old.
      "cache-control": "public, max-age=300",
      "vercel-cdn-cache-control": "public, s-maxage=300, stale-while-revalidate=3600, stale-if-error=86400",
    },
  });
}

/** flag.ar/<slug>/badge.svg: the startup's live rank in the Hall of Fame, to embed on its site or README. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isValidSlug(slug)) return new Response("Not Found", { status: 404 });
  try {
    const s = await getStartup(slug);
    if (!s) return new Response("Not Found", { status: 404 });
    if (s.status !== "approved") return svg(badge("En revisión"));
    // Same order as the hall's seats and its ranking.
    const list = [...(await listApproved())].sort(bySeat);
    const i = list.findIndex((x) => x.id === s.id);
    if (i < 0) return svg(badge("En el salón"));
    const likes = list[i].likes;
    return svg(badge(`#${i + 1} en el ranking · ${likes.toLocaleString("es-AR")} ${likes === 1 ? "like" : "likes"}`));
  } catch (e) {
    console.error("[badge]", (e as Error).message);
    return new Response("Service Unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  }
}
