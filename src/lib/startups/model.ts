// Startup data shared by the server and the browser. Pure functions only, so unit tests cover them.
import { normalizeLink } from "@/lib/server/validate";

export type StartupStatus = "pending" | "approved" | "rejected";

/**
 * Seats in the Hall of Fame. Only approved flags take one. When the hall is full, new flags still come in
 * and wait as pending (the waitlist): the admin API refuses an approval past this number.
 */
export const SALON_SEATS = 50;

/** One quiet line about the seats left. `taken` is the number of approved flags. */
export function seatsLine(taken: number): string {
  const left = Math.max(0, SALON_SEATS - taken);
  if (left === 0) return "Salón completo · Lista de espera abierta";
  return `${left === 1 ? "Queda 1" : `Quedan ${left}`} de ${SALON_SEATS} lugares · Cada bandera se revisa`;
}

/** What a public page may show. No IP hash, no moderation fields. */
export interface PublicStartup {
  id: string;
  slug: string;
  name: string;
  /** Legacy: the form no longer asks for it. */
  city: string | null;
  /** Key from CATEGORIES. Null on flags hoisted before categories existed. */
  category: string | null;
  link: string;
  domain: string;
  logoUrl: string | null;
  bgColor: string;
  order: number;
  status: StartupStatus;
  featured: boolean;
  createdAt: string;
  approvedAt: string | null;
}

/**
 * What the startup does, for the form select. Stable keys go in the database; labels can change freely.
 * Adding a category needs no migration: the column only checks the key's shape.
 */
export const CATEGORIES = [
  { key: "ai", label: "Inteligencia artificial" },
  { key: "fintech", label: "Fintech" },
  { key: "saas", label: "SaaS / Software B2B" },
  { key: "ecommerce", label: "E-commerce / Marketplace" },
  { key: "devtools", label: "Herramientas para developers" },
  { key: "health", label: "Salud / Healthtech" },
  { key: "edtech", label: "Educación / Edtech" },
  { key: "agtech", label: "Agro / Agtech" },
  { key: "biotech", label: "Biotech" },
  { key: "climate", label: "Energía y clima" },
  { key: "logistics", label: "Logística y movilidad" },
  { key: "proptech", label: "Real estate / Proptech" },
  { key: "insurtech", label: "Seguros / Insurtech" },
  { key: "legaltech", label: "Legal / Legaltech" },
  { key: "hr", label: "Recursos humanos" },
  { key: "security", label: "Ciberseguridad" },
  { key: "crypto", label: "Cripto / Web3" },
  { key: "media", label: "Media y contenido" },
  { key: "gaming", label: "Gaming" },
  { key: "food", label: "Comida / Foodtech" },
  { key: "travel", label: "Turismo" },
  { key: "hardware", label: "Hardware / IoT" },
  { key: "other", label: "Otra" },
] as const;

export type CategoryKey = (typeof CATEGORIES)[number]["key"];

export function categoryLabel(key: string | null | undefined): string | null {
  return CATEGORIES.find((c) => c.key === key)?.label ?? null;
}

export const MAX_NAME = 60;

/** Paths that are app routes, not startups. */
export const RESERVED_SLUGS = new Set([
  "salon", "izar", "admin", "api", "files", "sample", "editar", "og", "opengraph-image", "twitter-image",
  "favicon", "robots", "sitemap", "manifest", "static", "_next", "flag", "flagar", "argentina", "about",
]);

/** "Pampa Labs S.A." -> "pampa-labs-s-a". Empty when nothing usable is left. */
export function slugify(name: string): string {
  return name
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export function isValidSlug(s: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(s) && !RESERVED_SLUGS.has(s);
}

export function cleanName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const t = input.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return t && t.length <= MAX_NAME ? t : null;
}

export function cleanCategory(input: unknown): CategoryKey | null {
  return CATEGORIES.find((c) => c.key === input)?.key ?? null;
}

export function isHexColor(s: unknown): s is string {
  return typeof s === "string" && /^#[0-9a-f]{6}$/.test(s);
}

export type StartupLinkResult =
  | { ok: true; url: string; domain: string; kind: "web" | "x" }
  | { ok: false; reason: string };

const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);
const X_RESERVED = new Set(["home", "explore", "search", "settings", "i", "intent", "share", "messages", "notifications"]);

/**
 * A website or an X profile. The identity key ("domain") is the bare domain for a website,
 * or "x.com/<handle>" for an X profile, so two startups on X do not collide.
 */
export function normalizeStartupLink(input: string): StartupLinkResult {
  const raw = input.trim();
  const handle = raw.match(/^@([A-Za-z0-9_]{1,15})$/);
  if (handle) return xLink(handle[1]);
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    if (X_HOSTS.has(u.hostname.toLowerCase())) {
      const h = u.pathname.split("/").filter(Boolean)[0] ?? "";
      if (!/^[A-Za-z0-9_]{1,15}$/.test(h) || X_RESERVED.has(h.toLowerCase())) {
        return { ok: false, reason: "Usá el link a tu perfil de X, por ejemplo x.com/tustartup." };
      }
      return xLink(h);
    }
  } catch {
    // Fall through: normalizeLink gives the error message.
  }
  const web = normalizeLink(raw);
  if (!web.ok) return { ok: false, reason: "Poné un link válido: tu web o tu perfil de X." };
  return { ok: true, url: web.url, domain: web.domain, kind: "web" };
}

function xLink(handle: string): StartupLinkResult {
  const h = handle.toLowerCase();
  return { ok: true, url: `https://x.com/${handle}`, domain: `x.com/${h}`, kind: "x" };
}

// ---------- Colors ----------

export type RGB = [number, number, number];

export function hexToRgb(h: string): RGB {
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
}

export function rgbToHex(rgb: RGB): string {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

function luminance([r, g, b]: RGB): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Most common opaque color of the logo, in coarse 4-bit buckets weighted by alpha.
 * Unlike a "brand color" pick, black and gray count: a black wordmark's dominant color is black.
 */
export function dominantColor(rgba: ArrayLike<number>): RGB | null {
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a < 128) continue;
    const key = ((rgba[i] >> 4) << 8) | ((rgba[i + 1] >> 4) << 4) | (rgba[i + 2] >> 4);
    const c = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    c.n += a;
    c.r += rgba[i] * a;
    c.g += rgba[i + 1] * a;
    c.b += rgba[i + 2] * a;
    counts.set(key, c);
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best ? [best.r / best.n, best.g / best.n, best.b / best.n].map(Math.round) as RGB : null;
}

/**
 * Default flag color: the logo's dominant color, inverted. When the inverse does not stand out
 * from the logo (mid grays invert to mid grays), white.
 */
export function defaultBackground(dominant: RGB | null): string {
  if (!dominant) return "#ffffff";
  const inv: RGB = [255 - dominant[0], 255 - dominant[1], 255 - dominant[2]];
  return contrast(inv, dominant) >= 3 ? rgbToHex(inv) : "#ffffff";
}
