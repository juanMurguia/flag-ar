import "server-only";
import { env } from "./env";

/** Verifies an hCaptcha token with hCaptcha. Each token works once. */
export async function verifyCaptcha(token: string, ip: string): Promise<boolean> {
  if (!token || token.length > 8192) return false;
  const body = new URLSearchParams({
    secret: env.hcaptchaSecret(),
    response: token,
    sitekey: env.hcaptchaSiteKey(),
    remoteip: ip,
  });
  try {
    const res = await fetch("https://api.hcaptcha.com/siteverify", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
