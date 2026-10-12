import { alert } from "@/lib/server/alerts";
import { allowedOrigin, readJson, reply } from "@/lib/server/http";
import { hashIp, limit } from "@/lib/server/ratelimit";
import { invalidate } from "@/lib/server/startups";
import { serviceClient } from "@/lib/server/supabase";
import { clientIp } from "@/lib/server/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Reportar": one report per IP per flag. Three reports pull a flag out of the Hall of Fame for review. */
export async function POST(req: Request) {
  if (!allowedOrigin(req)) return reply(403, { message: "Forbidden." });
  const ipHash = hashIp(clientIp(req.headers));
  const rl = await limit("report-ip", ipHash, 10, "1 h");
  if (!rl.ok) return reply(429, { message: "Demasiados reportes. Probá más tarde." }, { "retry-after": String(rl.retryAfter) });

  const body = await readJson<{ id?: string; reason?: string }>(req);
  if (!body?.id || !UUID.test(body.id)) return reply(400, { message: "Pedido inválido." });
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 300) : "";

  const db = serviceClient();
  const { data: count, error } = await db.rpc("report_startup_tx", { p_id: body.id, p_ip_hash: ipHash, p_reason: reason });
  if (error) return reply(500, { message: "No pudimos guardar el reporte." });
  const n = Number(count);
  if (n >= 3) {
    const { data } = await db.from("startups").select("slug").eq("id", body.id).maybeSingle();
    if (data?.slug) invalidate(data.slug as string);
    await alert(`reports:${body.id}`, `/${data?.slug ?? body.id} has ${n} reports. It left the Hall of Fame until review.`, 3600);
  }
  return reply(200, { message: "Gracias. Lo vamos a revisar." });
}
