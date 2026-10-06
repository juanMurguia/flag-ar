import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { sessionClient } from "./supabase";

export type AdminCheck =
  | { ok: true; user: User; db: SupabaseClient }
  | { ok: false };

/**
 * Admin gate for server routes. Three checks, each one alone is enough to refuse:
 * 1. getUser(): the Auth server confirms the session.
 * 2. getClaims(): the verified JWT carries aal = "aal2" (TOTP done).
 * 3. is_admin(): the user has a row in public.admins.
 */
export async function requireAdmin(): Promise<AdminCheck> {
  const db = await sessionClient();
  const { data: userData, error: userErr } = await db.auth.getUser();
  if (userErr || !userData.user) return { ok: false };

  const { data: claimData, error: claimErr } = await db.auth.getClaims();
  if (claimErr || !claimData || claimData.claims.aal !== "aal2") return { ok: false };
  if (claimData.claims.sub !== userData.user.id) return { ok: false };

  const { data: isAdmin, error: rpcErr } = await db.rpc("is_admin");
  if (rpcErr || isAdmin !== true) return { ok: false };

  return { ok: true, user: userData.user, db };
}

export function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } });
}
