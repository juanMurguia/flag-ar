// Magic edit links. Stateless: an HMAC over (startup id, edit version, email, expiry).
// The startup's edit_version goes up on every edit, so a link works for one edit only.
import { createHmac, timingSafeEqual } from "node:crypto";

export const TOKEN_TTL_SECONDS = 30 * 60;

export interface EditClaims {
  sid: string; // startup id
  v: number; // edit_version the link was issued for
  em: string; // email it was sent to (for the audit log)
  exp: number; // unix seconds
}

const b64 = (b: Buffer) => b.toString("base64url");

export function signEditToken(claims: EditClaims, secret: string): string {
  const body = b64(Buffer.from(JSON.stringify(claims)));
  const mac = b64(createHmac("sha256", secret).update(body).digest());
  return `${body}.${mac}`;
}

/** Returns the claims when the signature is good and the link has not expired. Does not check the version. */
export function verifyEditToken(token: string, secret: string, now = Date.now()): EditClaims | null {
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined || token.length > 1024) return null;
  const want = createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as EditClaims;
    if (typeof c.sid !== "string" || typeof c.v !== "number" || typeof c.exp !== "number") return null;
    return c.exp * 1000 > now ? c : null;
  } catch {
    return null;
  }
}
