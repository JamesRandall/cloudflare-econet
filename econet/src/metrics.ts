// SPDX-License-Identifier: AGPL-3.0-only
// Service-wide counts, for the operator: rooms report what they've done
// (counts only: no names, addresses or traffic) at most every half minute,
// and which are active. One Durable Object holds the totals; it's only
// written by those batched reports, so it isn't a hot spot.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./service-info";

/** What a room counts between reports. */
export interface Counts {
  roomsCreated: number;
  roomsClosed: number;
  joins: number;
  connections: number;
  reconnections: number;
  framesRelayed: number;
  bytesRelayed: number;
  broadcasts: number;
  noReplies: number;
  refusedConnectionRate: number;
  refusedRoomRate: number;
  protocolErrors: number;
  screensRelayed: number;
}

export function emptyCounts(): Counts {
  return {
    roomsCreated: 0, roomsClosed: 0, joins: 0, connections: 0, reconnections: 0, framesRelayed: 0, bytesRelayed: 0,
    broadcasts: 0, noReplies: 0, refusedConnectionRate: 0, refusedRoomRate: 0, protocolErrors: 0, screensRelayed: 0,
  };
}

/** A room counts as active if it's reported within this. */
const ACTIVE_WINDOW_MS = 5 * 60_000;

interface Activity {
  at: number;
  connections: number;
  stations: number;
}

export class MetricsDurableObject extends DurableObject<Env> {
  /** Adds a room's counts, and how busy it is now (null: it's closed;
   *  left out: unchanged). */
  async report(roomId: string, counts: Partial<Counts>, activity?: { connections: number; stations: number } | null) {
    const totals = { ...emptyCounts(), ...((await this.ctx.storage.get<Counts>("totals")) ?? {}) };
    for (const [key, value] of Object.entries(counts)) {
      (totals as any)[key] = ((totals as any)[key] ?? 0) + (value ?? 0);
    }
    await this.ctx.storage.put("totals", totals);
    if (activity) {
      await this.ctx.storage.put(`room:${roomId}`, { ...activity, at: Date.now() } satisfies Activity);
    } else if (activity === null) {
      await this.ctx.storage.delete(`room:${roomId}`);
    }
  }

  /** Rooms that have reported lately. */
  async activeRooms(): Promise<number> {
    return (await this.active()).length;
  }

  private async active(): Promise<Activity[]> {
    const now = Date.now();
    const rooms = await this.ctx.storage.list<Activity>({ prefix: "room:" });
    const stale: string[] = [];
    const active: Activity[] = [];
    for (const [key, activity] of rooms) {
      if (now - activity.at > ACTIVE_WINDOW_MS) stale.push(key); else active.push(activity);
    }
    if (stale.length) await this.ctx.storage.delete(stale);
    return active;
  }

  async snapshot() {
    const active = await this.active();
    return {
      totals: { ...emptyCounts(), ...((await this.ctx.storage.get<Counts>("totals")) ?? {}) },
      now: {
        activeRooms: active.length,
        connections: active.reduce((n, a) => n + a.connections, 0),
        stations: active.reduce((n, a) => n + a.stations, 0),
      },
    };
  }
}

export function metrics(env: Env) {
  return env.METRICS.get(env.METRICS.idFromName("metrics"));
}
