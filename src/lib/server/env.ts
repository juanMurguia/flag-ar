import "server-only";

export const isProd = process.env.NODE_ENV === "production";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const env = {
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  publishableKey: () => required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
  // Service role key: server code only. Never prefix with NEXT_PUBLIC_.
  serviceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  ipHashSalt: () => required("IP_HASH_SALT"),
  cronSecret: () => required("CRON_SECRET"),
  // The Vercel Marketplace integration names these KV_REST_API_*.
  upstashUrl: () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  upstashToken: () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
  slackWebhook: () => process.env.SLACK_WEBHOOK_URL,
  /** Comma-separated list of origins allowed to POST to /api/upload. */
  allowedOrigins: () =>
    (process.env.ALLOWED_ORIGINS || "https://flag.ar,https://www.flag.ar")
      .split(",").map((s) => s.trim()).filter(Boolean),
};
