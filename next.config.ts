import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";

// @imgly/background-removal loads its ONNX model and WASM runtime from IMG.LY's CDN, on first use only.
const IMGLY = "https://staticimgly.com";
// unavatar.io finds a logo from the startup's link (X avatar or website icon). The browser calls it directly.
const UNAVATAR = "https://unavatar.io";

function csp(extra: { connect?: string; img?: string } = {}) {
  return [
    "default-src 'self'",
    // Next.js needs inline scripts for hydration. A nonce would make the flag page dynamic (no CDN cache).
    // 'wasm-unsafe-eval': the background-removal model runs on WebAssembly. It allows WASM, not JS eval.
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' ${IMGLY}${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${extra.img ?? ""}`.trim(),
    `connect-src 'self' ${IMGLY} ${UNAVATAR} ${extra.connect ?? ""}${isDev ? " ws:" : ""}`.trim(),
    "frame-src 'none'",
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
  // TensorFlow.js (NSFW check) is large and loads its own modules at run time: keep it out of the bundle.
  serverExternalPackages: ["@tensorflow/tfjs", "nsfwjs"],
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
  async redirects() {
    // The Hall of Fame moved to the home page. Keep old links working.
    return [{ source: "/salon", destination: "/", permanent: true }];
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
        source: "/api/salon",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Vercel-CDN-Cache-Control", value: "public, s-maxage=60, stale-while-revalidate=600, stale-if-error=86400" },
        ],
      },
      {
        // Logo names carry a version (s/<id>-<n>.png): a file never changes, so it caches forever.
        source: "/files/s/:name([0-9a-f-]+\.png)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
          { key: "Vercel-CDN-Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

export default config;
