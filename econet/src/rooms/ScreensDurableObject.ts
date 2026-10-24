// SPDX-License-Identifier: AGPL-3.0-only
// A room's screens: members sharing their machines' screens send small
// images, a few a second at most, and everyone else in the room sees them.
//
// Kept apart from the room's Econet on purpose: its own Durable Object
// (named by the room's id) and its own WebSocket per member, so an image
// never waits in front of an Econet frame, in a connection or in the
// room's object. Images aren't queued: one over its station's rate, or too
// large, is dropped. Nothing is stored.

import { DurableObject } from "cloudflare:workers";
import { decodeScreenHeader, LIMITS, ProtocolError } from "../protocol";
import { metrics } from "../metrics";
import type { Env } from "../service-info";

interface Attachment {
  participantId: string;
  roomId: string;
}

/** How long a room's yes to "may this member show this station" stands. */
const PERMISSION_TTL_MS = 10_000;

export class ScreensDurableObject extends DurableObject<Env> {
  /** Recent permission checks and when each station last sent (lost if the
   *  object's evicted, which only costs a check again). */
  private permissions = new Map<string, { allowed: boolean; at: number }>();
  private lastSent = new Map<string, number>();
  /** Screens relayed since the last report to the service's metrics. */
  private relayed = 0;
  private lastReport = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** The Worker's checked the member's ticket with the room: accept them. */
  async fetch(request: Request): Promise<Response> {
    const participantId = request.headers.get("X-Econet-Participant");
    const roomId = request.headers.get("X-Econet-Room");
    if (!participantId || !roomId || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Not here", { status: 400 });
    }
    for (const old of this.ctx.getWebSockets(participantId)) old.close(4003, "replaced");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [participantId]);
    pair[1].serializeAttachment({ participantId, roomId } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message === "string") return;
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;
    let station: number;
    try {
      station = decodeScreenHeader(message).station;
    } catch (error) {
      if (error instanceof ProtocolError) return;
      throw error;
    }
    // At most one image a station every so often: the rest are dropped.
    const key = `${attachment.participantId}:${station}`;
    const now = Date.now();
    if (now - (this.lastSent.get(key) ?? 0) < LIMITS.minScreenIntervalMs) return;
    if (!(await this.mayShow(attachment, station, now))) return;
    this.lastSent.set(key, now);
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      try { other.send(message); } catch {}
    }
    this.relayed += 1;
    if (now - this.lastReport > 30_000) {
      this.lastReport = now;
      const relayed = this.relayed;
      this.relayed = 0;
      this.ctx.waitUntil(metrics(this.env).report(attachment.roomId, { screensRelayed: relayed }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code === 1005 ? 1000 : code, "closing"); } catch {}
  }

  /** Whether the room says the member may show the station (asked again
   *  every few seconds: leases and the host's choice can change). */
  private async mayShow(attachment: Attachment, station: number, now: number): Promise<boolean> {
    const key = `${attachment.participantId}:${station}`;
    const cached = this.permissions.get(key);
    if (cached && now - cached.at < PERMISSION_TTL_MS) return cached.allowed;
    const room = this.env.ROOMS.get(this.env.ROOMS.idFromName(attachment.roomId));
    const allowed = await room.mayShowScreen(attachment.participantId, station);
    this.permissions.set(key, { allowed, at: now });
    return allowed;
  }

  /** The host turned screen sharing off, or closed the room. */
  async stopAll() {
    this.permissions.clear();
    for (const ws of this.ctx.getWebSockets()) ws.close(4005, "screen sharing off");
  }

  /** A member removed. */
  async stopParticipant(participantId: string) {
    for (const ws of this.ctx.getWebSockets(participantId)) ws.close(4001, "removed");
    for (const key of this.permissions.keys()) if (key.startsWith(`${participantId}:`)) this.permissions.delete(key);
  }
}
