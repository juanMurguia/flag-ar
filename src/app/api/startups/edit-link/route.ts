import { TOKEN_TTL_SECONDS, signEditToken } from "@/lib/server/editToken";
import { sendEmail } from "@/lib/server/email";
import { env } from "@/lib/server/env";
import { allowedOrigin, readJson, reply } from "@/lib/server/http";
import { hashIp, limit } from "@/lib/server/ratelimit";
import { serviceClient } from "@/lib/server/supabase";
import { clientIp } from "@/lib/server/validate";
import { emailMatchesDomain, isValidSlug } from "@/lib/startups/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same answer whether or not the email matches: the route must not reveal anything about a flag.
const SENT = "Si ese mail es del dominio de la bandera, te mandamos un link. Vence en 30 minutos.";

/** Sends a magic edit link to an address on the startup's own domain. Owning the mailbox proves owning the flag. */
export async function POST(req: Request) {
  if (!allowedOrigin(req)) return reply(403, { message: "Forbidden." });
  const ipHash = hashIp(clientIp(req.headers));
  const rl = await limit("editlink-ip", ipHash, 5, "1 h");
  if (!rl.ok) return reply(429, { message: "Demasiados pedidos. Probá más tarde." }, { "retry-after": String(rl.retryAfter) });

  const body = await readJson<{ slug?: string; email?: string }>(req);
  const slug = String(body?.slug ?? "");
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!isValidSlug(slug) || email.length > 254) return reply(400, { message: "Pedido inválido." });

  const { data: s, error } = await serviceClient()
    .from("startups").select("id, slug, name, domain, edit_version").eq("slug", slug).neq("status", "rejected").maybeSingle();
  if (error) return reply(500, { message: "Probá más tarde." });
  if (!s) return reply(200, { message: SENT });
  if ((s.domain as string).includes("/")) {
    return reply(400, { message: "Las banderas con link de X no se pueden editar por mail. Escribinos a hola@flag.ar." });
  }
  if (!emailMatchesDomain(email, s.domain as string)) return reply(200, { message: SENT });

  // Per-flag cap too, so nobody floods a founder's inbox from many IPs.
  const perFlag = await limit("editlink-flag", s.id as string, 3, "1 h");
  if (!perFlag.ok) return reply(200, { message: SENT });

  const token = signEditToken(
    { sid: s.id as string, v: s.edit_version as number, em: email, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS },
    env.editTokenSecret(),
  );
  const url = `${env.siteUrl()}/${s.slug}/editar#t=${token}`;
  try {
    await sendEmail(
      email,
      `Editá la bandera de ${s.name} en flag.ar`,
      `Hola,\n\nAlguien pidió editar la bandera de ${s.name} en flag.ar.\nSi fuiste vos, entrá acá (vence en 30 minutos y sirve para una sola edición):\n\n${url}\n\nSi no fuiste vos, ignorá este mail.\n\nflag.ar`,
    );
  } catch (e) {
    console.error("[edit-link]", e);
    return reply(503, { message: "No pudimos mandar el mail. Probá más tarde." });
  }
  return reply(200, { message: SENT });
}
