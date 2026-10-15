import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { env, isProd } from "./env";

// A voter is a device, not a person: a random id in an httpOnly cookie. No account, no fingerprint.
// Clearing cookies makes a new voter, so the like route also caps likes per IP (see api/likes).

const COOKIE = "flagar_voter";
const ID = /^[0-9a-f]{32}$/;
const ONE_YEAR = 60 * 60 * 24 * 365;

/** Salted hash of a voter id. The raw id never reaches the database. */
function voterHash(id: string): string {
  return createHmac("sha256", env.ipHashSalt()).update(`voter:${id}`).digest("hex");
}

/** The voter's hash from the cookie, or null when the device has not voted yet. */
export async function readVoter(): Promise<string | null> {
  const id = (await cookies()).get(COOKIE)?.value;
  return id && ID.test(id) ? voterHash(id) : null;
}

/** The voter's hash. Sets a new cookie on the response when the device has none. Route handlers only. */
export async function ensureVoter(): Promise<string> {
  const store = await cookies();
  const current = store.get(COOKIE)?.value;
  if (current && ID.test(current)) return voterHash(current);
  const id = randomBytes(16).toString("hex");
  store.set(COOKIE, id, { httpOnly: true, secure: isProd, sameSite: "lax", path: "/", maxAge: ONE_YEAR });
  return voterHash(id);
}
