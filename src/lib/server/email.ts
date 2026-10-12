import "server-only";
import { env, isProd } from "./env";

/** Sends a plain email through Resend. In dev without a key, prints it to the server log instead. */
export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  const key = env.resendKey();
  if (!key) {
    if (isProd) throw new Error("RESEND_API_KEY is required in production");
    console.info(`[email] to=${to} subject=${subject}\n${text}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.emailFrom(), to: [to], subject, text }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`resend ${res.status}`);
}
