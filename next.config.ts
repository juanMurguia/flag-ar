import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const hcaptcha = "https://hcaptcha.com https://*.hcaptcha.com";

function csp(extra: { connect?: string; img?: string } = {}) {
  return [
    "default-src 'self'",
    // Next.js needs inline scripts for hydration. A nonce would make the flag page dynamic (no CDN cache).
    `script-src 'self' 'unsafe-inline' ${hcaptcha}${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'unsafe-inline' ${hcaptcha}`,
    `img-src 'self' data: blob: ${extra.img ?? ""}`.trim(),
    `connect-src 'self' ${hcaptcha} ${extra.connect ?? ""}${isDev ? " ws:" : ""}`.trim(),
    `frame-src ${hcaptcha}`,
    "worker-src 'self' blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

const common = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const config: NextConfig = {
  poweredByHeader: false,
  // A parent folder has its own lockfile. Pin the root so Next.js does not pick it.
  outputFileTracingRoot: import.meta.dirname,
  turbopack: { root: import.meta.dirname },
  async rewrites() {
    if (!supabaseUrl) return [];
    // Visitors only see flag.ar/files/*. Vercel's CDN caches the public bucket.
    return [
      { source: "/files/:path*", destination: `${supabaseUrl}/storage/v1/object/public/logos-public/:path*` },
    ];
  },
  async headers() {
    return [
      // Public site: no Supabase origin at all.
      { source: "/((?!admin|api/admin).*)", headers: [...common, { key: "Content-Security-Policy", value: csp() }] },
      // Admin app (":path*" also matches /admin): talks to Supabase with its own session.
      {
        source: "/admin/:path*",
        headers: [
          ...common,
          { key: "Content-Security-Policy", value: csp({ connect: supabaseUrl, img: supabaseUrl }) },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
      {
        source: "/files/manifest.json",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Vercel-CDN-Cache-Control", value: "public, s-maxage=30, stale-while-revalidate=300, stale-if-error=86400" },
        ],
      },
      {
        source: "/files/:name([0-9a-f-]+\.png)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
          { key: "Vercel-CDN-Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

export default config;
