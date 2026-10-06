import "server-only";
import { createHmac } from "node:crypto";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { env, isProd } from "./env";

/** Salted hash of an IP address or network. The raw IP is never stored. */
export function hashIp(value: string): string {
  return createHmac("sha256", env.ipHashSalt()).update(value).digest("hex");
}

let redis: Redis | null | undefined;
export function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  const url = env.upstashUrl(), token = env.upstashToken();
  redis = url && token ? new Redis({ url, token }) : null;
  if (!redis && isProd) throw new Error("Upstash Redis is required in production");
  return redis;
}

export interface LimitResult {
  ok: boolean;
  retryAfter: number; // seconds
}

// Dev-only fallback so the app runs without Upstash. Not shared between instances.
const memory = new Map<string, number[]>();
function memoryLimit(key: string, limit: number, windowMs: number): LimitResult {
  const now = Date.now();
  const hits = (memory.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) return { ok: false, retryAfter: Math.ceil((hits[0] + windowMs - now) / 1000) };
  hits.push(now);
  memory.set(key, hits);
  return { ok: true, retryAfter: 0 };
}

const limiters = new Map<string, Ratelimit>();
function limiter(name: string, limit: number, window: `${number} ${"s" | "m" | "h"}`): Ratelimit | null {
  const r = getRedis();
  if (!r) return null;
  const id = `${name}:${limit}:${window}`;
  let l = limiters.get(id);
  if (!l) {
    l = new Ratelimit({ redis: r, limiter: Ratelimit.slidingWindow(limit, window), prefix: `rl:${name}` });
    limiters.set(id, l);
  }
  return l;
}

const WINDOW_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const;

/** Sliding-window limit. `key` must already be hashed. */
export async function limit(
  name: string, key: string, max: number, window: `${number} ${"s" | "m" | "h"}`,
): Promise<LimitResult> {
  const l = limiter(name, max, window);
  if (!l) {
    const [n, unit] = window.split(" ") as [string, "s" | "m" | "h"];
    return memoryLimit(`${name}:${key}`, max, Number(n) * WINDOW_MS[unit]);
  }
  const r = await l.limit(key);
  return { ok: r.success, retryAfter: Math.max(1, Math.ceil((r.reset - Date.now()) / 1000)) };
}

/** Fixed hourly counter with a cap read at call time (the cap lives in the settings table). */
export async function hourlyCounter(name: string, cap: number): Promise<LimitResult> {
  const hour = Math.floor(Date.now() / 3_600_000);
  const retryAfter = Math.ceil(((hour + 1) * 3_600_000 - Date.now()) / 1000);
  const r = getRedis();
  if (!r) return memoryLimit(`${name}:${hour}`, cap, 3_600_000);
  const key = `cnt:${name}:${hour}`;
  const n = await r.incr(key);
  if (n === 1) await r.expire(key, 3700);
  return { ok: n <= cap, retryAfter };
}

/** Counts events (for alert thresholds). */
export async function countEvent(name: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = `evt:${name}:${hour}`;
  await r.incr(key);
  await r.expire(key, 7300);
}

export async function readEvents(name: string, hoursAgo = 1): Promise<number> {
  const r = getRedis();
  if (!r) return 0;
  const hour = Math.floor(Date.now() / 3_600_000) - hoursAgo;
  return Number((await r.get(`evt:${name}:${hour}`)) ?? 0);
}

/** True once per key per TTL. Used to send each alert once, not on every request. */
export async function once(key: string, ttlSeconds: number): Promise<boolean> {
  const r = getRedis();
  if (!r) return true;
  return (await r.set(`once:${key}`, "1", { nx: true, ex: ttlSeconds })) === "OK";
}

// ---- Failure counter (failed admin sign-ins) ----

const memoryFailures = new Map<string, { n: number; until: number }>();

export async function failureCount(name: string, key: string): Promise<number> {
  const r = getRedis();
  if (!r) {
    const f = memoryFailures.get(`${name}:${key}`);
    return f && f.until > Date.now() ? f.n : 0;
  }
  return Number((await r.get(`fail:${name}:${key}`)) ?? 0);
}

export async function recordFailure(name: string, key: string, ttlSeconds: number): Promise<void> {
  const r = getRedis();
  if (!r) {
    const k = `${name}:${key}`;
    const f = memoryFailures.get(k);
    const live = f && f.until > Date.now();
    memoryFailures.set(k, { n: live ? f!.n + 1 : 1, until: live ? f!.until : Date.now() + ttlSeconds * 1000 });
    return;
  }
  const k = `fail:${name}:${key}`;
  const n = await r.incr(k);
  if (n === 1) await r.expire(k, ttlSeconds);
}
