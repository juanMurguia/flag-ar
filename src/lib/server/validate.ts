// Pure checks for the upload route. No I/O here, so unit tests cover them.

export const MAX_FILE_BYTES = 512 * 1024;
// Multipart overhead on top of the file: link, honeypot, field headers.
export const MAX_BODY_BYTES = MAX_FILE_BYTES + 16 * 1024;
export const MIN_FORM_MS = 3000;

export type ImageKind = { mime: "image/png" | "image/jpeg" | "image/webp"; ext: "png" | "jpg" | "webp" };

/** Reads the file signature. Returns null for anything that is not PNG, JPEG, or WebP. */
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return { mime: "image/png", ext: "png" };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

// Common URL shorteners. Extend as needed.
const SHORTENERS = new Set([
  "bit.ly", "bitly.com", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly",
  "cutt.ly", "shorturl.at", "rb.gy", "t.ly", "tiny.cc", "lnkd.in", "s.id", "v.gd", "bl.ink", "short.io",
  "linktr.ee", "qrco.de", "shorturl.com", "trib.al", "dlvr.it", "surl.li", "u.to", "x.co", "y2u.be",
]);

const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".arpa", ".test", ".invalid", ".example"];

export type LinkResult = { ok: true; url: string; domain: string } | { ok: false; reason: string };

/** Normalizes a website link. Adds https:// if missing. Returns the canonical URL and domain. */
export function normalizeLink(input: string): LinkResult {
  const raw = input.trim();
  if (!raw || raw.length > 2048) return { ok: false, reason: "Enter a valid website link." };
  if (/\s/.test(raw)) return { ok: false, reason: "Enter a valid website link." };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return { ok: false, reason: "Enter a valid website link." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "Use an http or https link." };
  if (u.username || u.password) return { ok: false, reason: "Enter a valid website link." };
  if (u.port && u.port !== "80" && u.port !== "443") return { ok: false, reason: "Enter a valid website link." };

  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || host.includes(":") || /^\d+(\.\d+){3}$/.test(host) || /^[\d.]+$/.test(host) || /^0x/i.test(host)) {
    return { ok: false, reason: "Use a domain name, not an IP address." };
  }
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: "Use a public domain name." };
  }
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9-]{1,63}$/.test(l) || l.startsWith("-") || l.endsWith("-"))) {
    return { ok: false, reason: "Enter a valid website link." };
  }
  if (!/^(xn--[a-z0-9-]+|[a-z]{2,63})$/.test(labels[labels.length - 1])) {
    return { ok: false, reason: "Enter a valid website link." };
  }
  const domain = host.replace(/^www\./, "");
  if (SHORTENERS.has(domain)) return { ok: false, reason: "Link shorteners are not allowed. Use your real domain." };

  u.hostname = host;
  u.hash = "";
  return { ok: true, url: u.toString(), domain };
}

/** Network key for rate limits: IPv4 /24 or IPv6 /64. */
export function networkKey(ip: string): string {
  const v4 = ip.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.\d+$/i);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  const full = expandIPv6(ip);
  if (full) return `${full.slice(0, 4).join(":")}::/64`;
  return ip;
}

function expandIPv6(ip: string): string[] | null {
  const addr = ip.split("%")[0].toLowerCase();
  if (!addr.includes(":")) return null;
  const [head, tail] = addr.split("::");
  if (addr.split("::").length > 2) return null;
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  if (fill < 0) return null;
  const parts = [...h, ...Array(fill).fill("0"), ...t];
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => p.padStart(4, "0"));
}

/** Client IP on Vercel. Vercel sets these headers; clients cannot override them there. */
export function clientIp(h: Headers): string {
  return (
    h.get("x-vercel-forwarded-for")?.split(",")[0].trim() ||
    h.get("x-real-ip")?.trim() ||
    h.get("x-forwarded-for")?.split(",")[0].trim() ||
    "0.0.0.0"
  );
}
