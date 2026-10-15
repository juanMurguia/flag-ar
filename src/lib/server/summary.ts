import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { unstable_cache } from "next/cache";
import { getStartup, tagFor } from "./startups";

/** Longest summary the card shows. Longer text is cut at a word. */
export const SUMMARY_MAX = 180;
const HTML_MAX = 512 * 1024;
const TIMEOUT_MS = 4000;
const MAX_HOPS = 3;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
}

/**
 * The site's own one-line pitch, from its <head>: og:description, then twitter:description, then
 * meta description. Null when the page has none. Pure: no network, so tests feed it HTML.
 */
export function parseSummary(html: string): string | null {
  const end = html.search(/<\/head>/i);
  const head = end >= 0 ? html.slice(0, end) : html;
  const metas = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase();
    const content = attr(tag, "content");
    if (key && content && !metas.has(key)) metas.set(key, content);
  }
  const raw = metas.get("og:description") ?? metas.get("twitter:description") ?? metas.get("description");
  if (!raw) return null;
  const text = decode(raw).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  if (text.length < 8) return null;
  if (text.length <= SUMMARY_MAX) return text;
  const cut = text.slice(0, SUMMARY_MAX - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 120 ? cut.lastIndexOf(" ") : cut.length).replace(/[\s,.;:–-]+$/, "")}…`;
}

/** True for loopback, private, link-local and other addresses a public site never uses. */
function isPrivate(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivate(v.slice(7));
    return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

/** The link comes from the database, but any owner can point it anywhere: only public http(s) hosts. */
async function isPublicUrl(u: URL): Promise<boolean> {
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.port && u.port !== "80" && u.port !== "443") return false;
  try {
    const addrs = await lookup(u.hostname.replace(/^\[|\]$/g, ""), { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivate(a.address));
  } catch {
    return false;
  }
}

async function readHead(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    // The tags live in <head>: stop once it closes or the cap is hit.
    if (size >= HTML_MAX || /<\/head>/i.test(new TextDecoder().decode(value))) break;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function fetchSummary(link: string): Promise<string | null> {
  let url: URL;
  try { url = new URL(link); } catch { return null; }
  // Redirects by hand: each hop gets the same public-host check.
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!(await isPublicUrl(url))) return null;
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "Mozilla/5.0 (compatible; FlagAR/1.0; +https://flag.ar)", accept: "text/html" },
    });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!next) return null;
      url = new URL(next, url);
      continue;
    }
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return parseSummary(await readHead(res));
  }
  return null;
}

/**
 * What a flag's startup does, in its own words. Cached a day per slug and dropped with the flag's tag,
 * so an edited link refetches. A failed fetch caches null too: a dead site costs one request a day.
 */
export function getSummary(slug: string): Promise<string | null> {
  return unstable_cache(
    async () => {
      const s = await getStartup(slug);
      if (!s || s.status !== "approved") return null;
      try {
        return await fetchSummary(s.link);
      } catch {
        return null;
      }
    },
    ["summary", slug],
    { tags: [tagFor(slug)], revalidate: 86400 },
  )();
}
