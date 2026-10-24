// Rate limits on the HTTP API (room creation, code lookups, joining): a
// token bucket per client address and action, each in its own small
// Durable Object (so no shared hot spot). Addresses are hashed, and kept
// only as long as the bucket's in use.

import { DurableObject } from "cloudflare:workers";
import { sha256 } from "./auth";
import type { Env } from "./service-info";

export type LimitedAction = "createRoom" | "resolveCode" | "join" | "ticket" | "landing";

/** Requests allowed per minute, with this much burst. */
const RULES: Record<LimitedAction, { perMinute: number; burst: number }> = {
  createRoom: { perMinute: 2, burst: 10 },
  resolveCode: { perMinute: 20, burst: 30 },
  join: { perMinute: 10, burst: 20 },
  ticket: { perMinute: 60, burst: 60 },
  landing: { perMinute: 60, burst: 60 },
};

export class RateLimiterDurableObject extends DurableObject<Env> {
  async take(action: LimitedAction): Promise<boolean> {
    const rule = RULES[action];
    const now = Date.now();
    const saved = (await this.ctx.storage.get<{ tokens: number; at: number }>("bucket")) ?? { tokens: rule.burst, at: now };
    const tokens = Math.min(rule.burst, saved.tokens + ((now - saved.at) / 60_000) * rule.perMinute);
    const allowed = tokens >= 1;
    await this.ctx.storage.put("bucket", { tokens: allowed ? tokens - 1 : tokens, at: now });
    // Forget it once it's full again.
    await this.ctx.storage.setAlarm(now + (60_000 * rule.burst) / rule.perMinute);
    return allowed;
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

/** Whether the caller may do `action` now. */
export async function allow(env: Env, request: Request, action: LimitedAction): Promise<boolean> {
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const key = await sha256(`${action}:${address}`);
  return env.LIMITS.get(env.LIMITS.idFromName(key)).take(action);
}
