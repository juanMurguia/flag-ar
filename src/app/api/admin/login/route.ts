import { sameOrigin } from "@/lib/server/csrf";
import { failureCount, hashIp, recordFailure } from "@/lib/server/ratelimit";
import { sessionClient } from "@/lib/server/supabase";
import { clientIp } from "@/lib/server/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FAILURES = 5;
const WINDOW_S = 600;

/**
 * Password step of the admin sign-in. Runs on the server so the app can
 * rate limit failed attempts per IP (Supabase Auth limits them too).
 * The TOTP step runs in the browser with the session this sets.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return new Response("Not Found", { status: 404 });
  const key = hashIp(clientIp(req.headers));
  if ((await failureCount("admin-login", key)) >= MAX_FAILURES) {
    return Response.json(
      { message: "Too many failed attempts. Wait 10 minutes." },
      { status: 429, headers: { "retry-after": String(WINDOW_S) } },
    );
  }

  const { email, password } = (await req.json().catch(() => ({}))) as Record<string, string>;
  if (!email || !password || email.length > 320 || password.length > 1024) {
    return Response.json({ message: "Sign-in failed." }, { status: 400 });
  }

  const db = await sessionClient();
  const { data, error } = await db.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    await recordFailure("admin-login", key, WINDOW_S);
    return Response.json({ message: "Sign-in failed." }, { status: 401 });
  }

  const { data: factors } = await db.auth.mfa.listFactors();
  const verified = factors?.totp?.find((f) => f.status === "verified");
  return Response.json({ next: verified ? "verify" : "enroll", factorId: verified?.id ?? null });
}
