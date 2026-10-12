import "server-only";
import { env, isProd } from "./env";

export function reply(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

/** Public POST routes accept only our own origins (CSRF and casual scripting). */
export function allowedOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  return env.allowedOrigins().includes(origin) || (!isProd && origin === new URL(req.url).origin);
}

/** Reads the body, but stops at `max` bytes even when Content-Length lies. */
export async function readCapped(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Multipart form, size-capped. Null on a bad or oversized body. */
export async function readForm(req: Request, max: number): Promise<FormData | null> {
  const type = req.headers.get("content-type") || "";
  if (!type.startsWith("multipart/form-data")) return null;
  const body = await readCapped(req, max);
  if (!body) return null;
  try {
    return await new Response(body, { headers: { "content-type": type } }).formData();
  } catch {
    return null;
  }
}

export async function readJson<T>(req: Request, max = 4096): Promise<T | null> {
  const body = await readCapped(req, max);
  if (!body) return null;
  try {
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    return null;
  }
}
