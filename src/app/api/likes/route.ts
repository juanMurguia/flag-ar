import { allowedOrigin, readJson, reply } from "@/lib/server/http";
import { countEvent, hashIp, limit } from "@/lib/server/ratelimit";
import { serviceClient } from "@/lib/server/supabase";
import { clientIp, networkKey } from "@/lib/server/validate";
import { ensureVoter, readVoter } from "@/lib/server/voter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The flags this device liked. Empty for a device that never voted. */
export async function GET() {
  const voter = await readVoter();
  if (!voter) return reply(200, { liked: [] });
  const { data, error } = await serviceClient()
    .from("startup_likes").select("startup_id").eq("voter_hash", voter).limit(5000);
  if (error) return reply(503, { message: "No pudimos leer tus likes." });
  return reply(200, { liked: data.map((r) => r.startup_id as string) });
}

/**
 * Like or unlike a flag. One like per device per flag (the cookie). Clearing cookies makes a new device,
 * so new likes are also capped per IP, per IP and flag, and per network. Unlikes are only rate limited.
 */
export async function POST(req: Request) {
  if (!allowedOrigin(req)) return reply(403, { message: "Forbidden." });
  const body = await readJson<{ id?: string; like?: boolean }>(req, 512);
  if (!body?.id || !UUID.test(body.id) || typeof body.like !== "boolean") return reply(400, { message: "Pedido inválido." });

  const ip = clientIp(req.headers);
  const ipHash = hashIp(ip);
  const voter = await ensureVoter();
  const tooMany = (retryAfter: number) =>
    reply(429, { message: "Demasiados likes. Probá más tarde." }, { "retry-after": String(retryAfter) });

  const perVoter = await limit("like-voter", voter, 60, "1 m");
  if (!perVoter.ok) return tooMany(perVoter.retryAfter);
  if (body.like) {
    // An office or a phone carrier shares one IP: a few likes per flag, many in total.
    const perFlag = await limit("like-ip-flag", hashIp(`${ip}|${body.id}`), 5, "24 h");
    if (!perFlag.ok) return tooMany(perFlag.retryAfter);
    const perIp = await limit("like-ip", ipHash, 100, "24 h");
    if (!perIp.ok) return tooMany(perIp.retryAfter);
    const perNet = await limit("like-net", hashIp(networkKey(ip)), 400, "24 h");
    if (!perNet.ok) return tooMany(perNet.retryAfter);
  }

  const { data, error } = await serviceClient().rpc("like_startup_tx", {
    p_id: body.id, p_voter_hash: voter, p_ip_hash: ipHash, p_like: body.like,
  });
  if (error) return reply(500, { message: "No pudimos guardar el like." });
  if (data === null) return reply(404, { message: "Esta bandera no está en el salón." });
  if (body.like) await countEvent("like").catch(() => {});
  return reply(200, { likes: Number(data), liked: body.like });
}
