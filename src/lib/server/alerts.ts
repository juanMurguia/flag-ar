import "server-only";
import { env } from "./env";
import { once } from "./ratelimit";

/**
 * Sends a Slack alert. Each `key` alerts at most once per `ttlSeconds`,
 * so a flood does not become a flood of messages.
 */
export async function alert(key: string, text: string, ttlSeconds = 3600): Promise<void> {
  const hook = env.slackWebhook();
  try {
    if (!(await once(`alert:${key}`, ttlSeconds))) return;
    if (!hook) {
      console.warn(`[alert] ${text}`);
      return;
    }
    await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `flag.ar: ${text}` }),
      signal: AbortSignal.timeout(4000),
    });
  } catch (e) {
    console.error("[alert] failed", e);
  }
}
