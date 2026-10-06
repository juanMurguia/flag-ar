import "server-only";
import { env, isProd } from "./env";

/** Admin POST routes accept only same-site requests from known origins. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  if (env.allowedOrigins().includes(origin)) return true;
  return !isProd && origin === new URL(req.url).origin;
}
