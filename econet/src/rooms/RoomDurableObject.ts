// SPDX-License-Identifier: AGPL-3.0-only
// One room: its members, invitations and station leases (in the object's
// SQLite storage), and the relay between its members' connections.
//
// WebSockets use the hibernation API: the object can be evicted from memory
// between messages, so nothing here relies on in-memory state surviving
// (each socket carries its participant in its tag and attachment; leases
// and members are in SQLite). Heartbeats ("ping" -> "pong") are answered
// by the runtime without waking the object.
//
// The room never looks inside Econet frames beyond their addresses: it
// checks the sender holds the source station's lease, and passes the frame
// to whoever holds the destination's.

import { DurableObject } from "cloudflare:workers";
import { newId, newToken, sameHash, sha256 } from "../auth";
import { newCode, newLinkToken } from "../invites";
import {
  decodeTraffic,
  encodeTraffic,
  LIMITS,
  MINIMUM_PROTOCOL_VERSION,
  parseClientMessage,
  PROTOCOL_VERSION,
  ProtocolError,
  TrafficType,
  type ParticipantView,
  type RoomView,
  type ServerMessage,
  type StationView,
} from "../protocol";
import { emptyCounts, metrics, type Counts } from "../metrics";
import { setting, type Env } from "../service-info";

/** How long a disconnected member keeps its stations, to reconnect. */
export const LEASE_GRACE_MS = 5 * 60_000;
/** How long the room waits for its host to come back before closing. */
export const OWNER_GRACE_MS = 30 * 60_000;
/** An empty room (nobody connected) goes after this. */
export const IDLE_EXPIRY_MS = 24 * 60 * 60_000;
/** A new invitation's life, unless asked otherwise, and the longest. */
export const INVITE_TTL_MS = 24 * 60 * 60_000;
export const MAX_INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_INVITE_USES = 20;
const TICKET_TTL_MS = 60_000;

/** An error for the client. Its message carries its status and code too,
 *  as "404 roomNotFound: ...", since only the message survives an RPC. */
export class RoomError extends Error {
  constructor(public status: number, public code: string, public detail: string) {
    super(`${status} ${code}: ${detail}`);
  }
}

export interface InviteIssued {
  id: string;
  code: string;
  codeHash: string;
  linkToken: string;
  expiresAt: number;
  maxUses: number;
}

export interface Preview {
  room: RoomView;
  participants: number;
  stations: { station: number; kind: string; label: string; role: string }[];
  inviteExpiresAt: number;
}

interface Attachment {
  participantId: string;
  hello: boolean;
}

export class RoomDurableObject extends DurableObject<Env> {
  private sql: SqlStorage;
  /** Per-connection rate buckets (reset if the object's evicted; fine). */
  private buckets = new Map<WebSocket, { messages: number; bytes: number; at: number; warned: number }>();
  /** The whole room's traffic, against its own limit. */
  private roomBucket: { messages: number; bytes: number; at: number } | null = null;
  /** Counts since the last report to the service's metrics. */
  private counts: Counts = emptyCounts();
  private lastReport = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS room (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, owner_hash TEXT NOT NULL,
          locked INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, last_activity INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS participants (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, app TEXT NOT NULL, token_hash TEXT NOT NULL,
          owner INTEGER NOT NULL, created INTEGER NOT NULL, last_seen INTEGER NOT NULL, rtt INTEGER);
        CREATE TABLE IF NOT EXISTS invites (
          id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, link_hash TEXT NOT NULL, expires INTEGER NOT NULL,
          max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS stations (
          station INTEGER PRIMARY KEY, participant TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL,
          role TEXT NOT NULL, offline_since INTEGER);
        CREATE TABLE IF NOT EXISTS tickets (hash TEXT PRIMARY KEY, participant TEXT NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS screen_tickets (hash TEXT PRIMARY KEY, participant TEXT NOT NULL, expires INTEGER NOT NULL);
      `);
      // Added after rooms were first made: whether members may share their
      // machines' screens (the host's choice).
      try {
        this.sql.exec("ALTER TABLE room ADD COLUMN screen_sharing INTEGER NOT NULL DEFAULT 0");
      } catch {
        // There already.
      }
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // MARK: The room's records

  private roomRow(): { id: string; name: string; description: string; owner_hash: string; locked: number; screen_sharing: number } | null {
    // A closed room's storage is gone, tables and all.
    try {
      const rows = this.sql.exec("SELECT id, name, description, owner_hash, locked, screen_sharing FROM room").toArray() as any[];
      return rows[0] ?? null;
    } catch {
      return null;
    }
  }

  private requireRoom() {
    const room = this.roomRow();
    if (!room) throw new RoomError(404, "roomNotFound", "There's no such room (it may have closed)");
    return room;
  }

  private roomView(): RoomView {
    const room = this.requireRoom();
    return { id: room.id, name: room.name, description: room.description, locked: room.locked !== 0,
      screenSharing: room.screen_sharing !== 0 };
  }

  private async ownerCheck(ownerToken: string) {
    const room = this.requireRoom();
    if (!sameHash(await sha256(ownerToken), room.owner_hash)) throw new RoomError(403, "notOwner", "Only the room's host can do that");
  }

  private async memberFor(token: string): Promise<{ id: string; owner: number; name: string; app: string }> {
    this.requireRoom();
    const hash = await sha256(token);
    const rows = this.sql.exec("SELECT id, owner, name, app FROM participants WHERE token_hash = ?", hash).toArray() as any[];
    if (!rows[0]) throw new RoomError(403, "notMember", "Not a member of this room (or removed from it)");
    return rows[0];
  }

  private touch() {
    this.sql.exec("UPDATE room SET last_activity = ?", Date.now());
  }

  // MARK: Creating and joining (called by the Worker)

  async create(input: { roomId: string; name: string; description: string; ownerName: string; app: string; screenSharing: boolean }) {
    if (this.roomRow()) throw new RoomError(409, "exists", "Room exists");
    const now = Date.now();
    const ownerToken = newToken();
    const memberToken = newToken();
    const participantId = newId();
    this.sql.exec(
      "INSERT INTO room (id, name, description, owner_hash, locked, created, last_activity, screen_sharing) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
      input.roomId, input.name, input.description, await sha256(ownerToken), now, now, input.screenSharing ? 1 : 0,
    );
    this.sql.exec(
      "INSERT INTO participants (id, name, app, token_hash, owner, created, last_seen) VALUES (?, ?, ?, ?, 1, ?, ?)",
      participantId, input.ownerName, input.app, await sha256(memberToken), now, now,
    );
    const invite = await this.newInvite(setting(this.env, "INVITE_TTL_HOURS", INVITE_TTL_MS / 3_600_000) * 3_600_000, DEFAULT_INVITE_USES);
    await this.schedule();
    this.count("roomsCreated");
    this.report(true);
    return { ownerToken, memberToken, participantId, invite };
  }

  private async newInvite(ttlMs: number, maxUses: number): Promise<InviteIssued> {
    const room = this.requireRoom();
    const id = newId();
    const code = newCode();
    const { token, secret } = newLinkToken(room.id);
    const codeHash = await sha256(code);
    const expiresAt = Date.now() + ttlMs;
    this.sql.exec(
      "INSERT INTO invites (id, code_hash, link_hash, expires, max_uses) VALUES (?, ?, ?, ?, ?)",
      id, codeHash, await sha256(secret), expiresAt, maxUses,
    );
    return { id, code, codeHash, linkToken: token, expiresAt, maxUses };
  }

  /** The invite a code or link secret is for, if it's still good. */
  private async findInvite(by: { code?: string; linkSecret?: string }) {
    const room = this.requireRoom();
    const rows = (by.code
      ? this.sql.exec("SELECT * FROM invites WHERE code_hash = ?", await sha256(by.code))
      : this.sql.exec("SELECT * FROM invites WHERE link_hash = ?", await sha256(by.linkSecret ?? ""))).toArray() as any[];
    const invite = rows[0];
    // The same answer whatever's wrong, so nothing leaks about the room.
    if (!invite || invite.revoked || invite.expires <= Date.now() || invite.uses >= invite.max_uses) {
      throw new RoomError(404, "inviteNotFound", "That invitation isn't valid: it may have expired or been withdrawn");
    }
    return { invite, room };
  }

  async preview(by: { code?: string; linkSecret?: string }): Promise<Preview> {
    const { invite } = await this.findInvite(by);
    const participants = (this.sql.exec("SELECT COUNT(*) AS n FROM participants").one() as any).n as number;
    const stations = this.sql.exec("SELECT station, kind, label, role FROM stations ORDER BY station").toArray() as any[];
    return { room: this.roomView(), participants, stations, inviteExpiresAt: invite.expires };
  }

  async join(input: { code?: string; linkSecret?: string; name: string; app: string }) {
    const { invite, room } = await this.findInvite(input);
    if (room.locked) throw new RoomError(403, "roomLocked", "The room's host isn't letting anyone new join just now");
    const count = (this.sql.exec("SELECT COUNT(*) AS n FROM participants").one() as any).n as number;
    if (count >= LIMITS.maxParticipantsPerRoom) throw new RoomError(409, "roomFull", "The room is full");
    const memberToken = newToken();
    const participantId = newId();
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO participants (id, name, app, token_hash, owner, created, last_seen) VALUES (?, ?, ?, ?, 0, ?, ?)",
      participantId, input.name, input.app, await sha256(memberToken), now, now,
    );
    this.sql.exec("UPDATE invites SET uses = uses + 1 WHERE id = ?", invite.id);
    this.touch();
    this.count("joins");
    this.report(true);
    this.broadcastParticipants();
    return { participantId, memberToken, room: this.roomView() };
  }

  /** A short-lived, single-use ticket for the WebSocket upgrade. */
  async ticket(memberToken: string): Promise<{ ticket: string; expiresAt: number }> {
    const member = await this.memberFor(memberToken);
    const ticket = newToken();
    const expiresAt = Date.now() + TICKET_TTL_MS;
    this.sql.exec("DELETE FROM tickets WHERE expires < ?", Date.now());
    this.sql.exec("INSERT INTO tickets (hash, participant, expires) VALUES (?, ?, ?)", await sha256(ticket), member.id, expiresAt);
    return { ticket, expiresAt };
  }

  // MARK: Members and the host

  async info(memberToken: string) {
    const member = await this.memberFor(memberToken);
    return {
      room: this.roomView(),
      participantId: member.id,
      owner: member.owner !== 0,
      participants: this.participantViews(),
      stations: this.stationViews(),
    };
  }

  async update(ownerToken: string, change: { name?: string; description?: string; locked?: boolean; screenSharing?: boolean }) {
    await this.ownerCheck(ownerToken);
    if (change.screenSharing !== undefined) {
      this.sql.exec("UPDATE room SET screen_sharing = ?", change.screenSharing ? 1 : 0);
      // No longer allowed: everyone's screens stop now.
      if (!change.screenSharing) await this.screens().stopAll();
    }
    if (change.name !== undefined) this.sql.exec("UPDATE room SET name = ?", change.name);
    if (change.description !== undefined) this.sql.exec("UPDATE room SET description = ?", change.description);
    if (change.locked !== undefined) this.sql.exec("UPDATE room SET locked = ?", change.locked ? 1 : 0);
    const room = this.roomView();
    this.broadcast({ type: "room", room });
    return room;
  }

  async issueInvite(ownerToken: string, options: { ttlSeconds?: number; maxUses?: number }) {
    await this.ownerCheck(ownerToken);
    const ttl = Math.min(MAX_INVITE_TTL_MS, Math.max(60_000, (options.ttlSeconds ?? INVITE_TTL_MS / 1000) * 1000));
    const uses = Math.min(1000, Math.max(1, Math.floor(options.maxUses ?? DEFAULT_INVITE_USES)));
    return this.newInvite(ttl, uses);
  }

  async listInvites(ownerToken: string) {
    await this.ownerCheck(ownerToken);
    return (this.sql.exec("SELECT id, expires, max_uses, uses, revoked FROM invites ORDER BY expires").toArray() as any[]).map((i) => ({
      id: i.id, expiresAt: i.expires, maxUses: i.max_uses, uses: i.uses, revoked: i.revoked !== 0,
    }));
  }

  async revokeInvite(ownerToken: string, inviteId: string): Promise<string | null> {
    await this.ownerCheck(ownerToken);
    const rows = this.sql.exec("SELECT code_hash FROM invites WHERE id = ?", inviteId).toArray() as any[];
    this.sql.exec("UPDATE invites SET revoked = 1 WHERE id = ?", inviteId);
    return rows[0]?.code_hash ?? null;
  }

  async removeParticipant(ownerToken: string, participantId: string) {
    await this.ownerCheck(ownerToken);
    const rows = this.sql.exec("SELECT owner FROM participants WHERE id = ?", participantId).toArray() as any[];
    if (!rows[0]) throw new RoomError(404, "participantNotFound", "No such participant");
    if (rows[0].owner) throw new RoomError(400, "isOwner", "The host can't remove themselves: close the room instead");
    this.dropParticipant(participantId, "removed");
  }

  async leave(memberToken: string) {
    const member = await this.memberFor(memberToken);
    if (member.owner) {
      await this.closeRoom();
    } else {
      this.dropParticipant(member.id, "removed");
    }
  }

  async close(ownerToken: string) {
    await this.ownerCheck(ownerToken);
    await this.closeRoom();
  }

  /** The operator closes a room (abuse): as its host closing it. */
  async adminClose() {
    if (this.roomRow()) await this.closeRoom();
  }

  /// The room's screens, which are relayed apart from its Econet.
  private screens() {
    const room = this.requireRoom();
    return this.env.SCREENS.get(this.env.SCREENS.idFromName(room.id));
  }

  /// A short-lived ticket for the room's screens connection.
  async screenTicket(memberToken: string): Promise<{ ticket: string; expiresAt: number }> {
    const member = await this.memberFor(memberToken);
    if (!this.roomView().screenSharing) throw new RoomError(403, "screenSharingOff", "The room's host hasn't allowed screen sharing");
    const ticket = newToken();
    const expiresAt = Date.now() + TICKET_TTL_MS;
    this.sql.exec("DELETE FROM screen_tickets WHERE expires < ?", Date.now());
    this.sql.exec("INSERT INTO screen_tickets (hash, participant, expires) VALUES (?, ?, ?)", await sha256(ticket), member.id, expiresAt);
    return { ticket, expiresAt };
  }

  /// A screens ticket, used up: who it's for, if it's good and sharing's
  /// allowed.
  async redeemScreenTicket(ticket: string): Promise<{ participantId: string } | null> {
    if (!this.roomRow()) return null;
    const hash = await sha256(ticket);
    const rows = this.sql.exec("SELECT participant, expires FROM screen_tickets WHERE hash = ?", hash).toArray() as any[];
    this.sql.exec("DELETE FROM screen_tickets WHERE hash = ?", hash);
    if (!rows[0] || rows[0].expires < Date.now() || !this.roomView().screenSharing) return null;
    return { participantId: rows[0].participant };
  }

  /// Whether a member may show a station's screen now: sharing's allowed
  /// and the station's theirs.
  async mayShowScreen(participantId: string, station: number): Promise<boolean> {
    const room = this.roomRow();
    if (!room || room.screen_sharing === 0) return false;
    const rows = this.sql.exec("SELECT participant FROM stations WHERE station = ?", station).toArray() as any[];
    return rows[0]?.participant === participantId;
  }

  private dropParticipant(participantId: string, reason: "removed") {
    for (const ws of this.ctx.getWebSockets(participantId)) {
      this.sendTo(ws, { type: "closing", reason });
      ws.close(4001, "removed");
    }
    this.sql.exec("DELETE FROM stations WHERE participant = ?", participantId);
    this.sql.exec("DELETE FROM tickets WHERE participant = ?", participantId);
    this.sql.exec("DELETE FROM participants WHERE id = ?", participantId);
    this.ctx.waitUntil(this.screens().stopParticipant(participantId));
    this.broadcastParticipants();
    this.broadcastStations();
  }

  private async closeRoom() {
    await this.screens().stopAll();
    this.count("roomsClosed");
    const room = this.roomRow();
    if (room) await metrics(this.env).report(room.id, this.takeCounts(), null);
    for (const ws of this.ctx.getWebSockets()) {
      this.sendTo(ws, { type: "closing", reason: "roomClosed" });
      ws.close(4002, "room closed");
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // MARK: Views

  private participantViews(): ParticipantView[] {
    const online = new Set(this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() as Attachment | null)?.participantId));
    return (this.sql.exec("SELECT id, name, app, owner, rtt FROM participants ORDER BY created").toArray() as any[]).map((p) => ({
      id: p.id, name: p.name, app: p.app, owner: p.owner !== 0, online: online.has(p.id), rttMs: p.rtt ?? null,
    }));
  }

  private stationViews(): StationView[] {
    return (this.sql.exec("SELECT station, participant, kind, label, role, offline_since FROM stations ORDER BY station").toArray() as any[]).map(
      (s) => ({ station: s.station, participantId: s.participant, kind: s.kind, label: s.label, role: s.role, online: s.offline_since === null }),
    );
  }

  // MARK: Connections

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    const ticket = url.searchParams.get("ticket") ?? "";
    const hash = await sha256(ticket);
    const rows = this.sql.exec("SELECT participant, expires FROM tickets WHERE hash = ?", hash).toArray() as any[];
    this.sql.exec("DELETE FROM tickets WHERE hash = ?", hash);
    if (!this.roomRow()) return new Response("No such room", { status: 404 });
    if (!rows[0] || rows[0].expires < Date.now()) return new Response("Invalid or expired ticket", { status: 403 });
    const participantId = rows[0].participant as string;
    const exists = this.sql.exec("SELECT id FROM participants WHERE id = ?", participantId).toArray().length > 0;
    if (!exists) return new Response("Not a member", { status: 403 });

    // One connection per member: a new one replaces the old.
    for (const old of this.ctx.getWebSockets(participantId)) {
      this.sendTo(old, { type: "closing", reason: "replaced" });
      old.close(4003, "replaced");
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [participantId]);
    server.serializeAttachment({ participantId, hello: false } satisfies Attachment);
    // Back: its stations are online again.
    const returning = (this.sql.exec("SELECT COUNT(*) AS n FROM stations WHERE participant = ? AND offline_since IS NOT NULL",
      participantId).one() as any).n > 0;
    this.count(returning ? "reconnections" : "connections");
    this.sql.exec("UPDATE stations SET offline_since = NULL WHERE participant = ?", participantId);
    this.sql.exec("UPDATE participants SET last_seen = ? WHERE id = ?", Date.now(), participantId);
    this.touch();
    this.report(true);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;
    try {
      if (typeof message === "string") {
        this.control(ws, attachment, message);
      } else {
        if (!attachment.hello) throw new ProtocolError("helloFirst", "Say hello first");
        if (!this.withinRate(ws, message.byteLength)) return;
        this.relay(ws, attachment.participantId, message);
      }
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.count("protocolErrors");
        this.sendTo(ws, { type: "error", code: error.code, message: error.message });
      } else {
        throw error;
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    await this.disconnected(ws);
    try { ws.close(code === 1005 ? 1000 : code, "closing"); } catch {}
  }

  async webSocketError(ws: WebSocket) {
    await this.disconnected(ws);
  }

  private async disconnected(ws: WebSocket) {
    this.buckets.delete(ws);
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment || !this.roomRow()) return;
    const stillHere = this.ctx.getWebSockets(attachment.participantId).some((other) => other !== ws);
    if (!stillHere) {
      const now = Date.now();
      this.sql.exec("UPDATE stations SET offline_since = ? WHERE participant = ? AND offline_since IS NULL", now, attachment.participantId);
      this.sql.exec("UPDATE participants SET last_seen = ? WHERE id = ?", now, attachment.participantId);
      this.broadcastParticipants(ws);
      this.broadcastStations(ws);
    }
    this.report(true);
    await this.schedule();
  }

  private control(ws: WebSocket, attachment: Attachment, raw: string) {
    const message = parseClientMessage(raw);
    if (message.type !== "hello" && !attachment.hello) throw new ProtocolError("helloFirst", "Say hello first");
    switch (message.type) {
      case "hello": {
        if (message.protocolVersion < MINIMUM_PROTOCOL_VERSION) {
          this.sendTo(ws, { type: "error", code: "upgradeRequired", message: `This service needs protocol ${MINIMUM_PROTOCOL_VERSION} or later: update the app` });
          ws.close(4004, "upgrade required");
          return;
        }
        attachment.hello = true;
        ws.serializeAttachment(attachment);
        const member = this.sql.exec("SELECT owner FROM participants WHERE id = ?", attachment.participantId).one() as any;
        this.sendTo(ws, {
          type: "welcome",
          protocolVersion: Math.min(PROTOCOL_VERSION, message.protocolVersion),
          participantId: attachment.participantId,
          owner: member.owner !== 0,
          room: this.roomView(),
          participants: this.participantViews(),
          stations: this.stationViews(),
          limits: LIMITS,
        });
        this.broadcastParticipants(ws);
        this.broadcastStations(ws);
        return;
      }
      case "claim": {
        const station = message.station ?? this.freeStation();
        if (station === null) throw new ProtocolError("roomFull", "No station numbers are free");
        const existing = this.sql.exec("SELECT participant FROM stations WHERE station = ?", station).toArray() as any[];
        if (existing[0] && existing[0].participant !== attachment.participantId) {
          this.sendTo(ws, { type: "error", code: "stationTaken", message: `Station ${station} is already in the room`, station });
          return;
        }
        if (!existing[0]) {
          const total = (this.sql.exec("SELECT COUNT(*) AS n FROM stations").one() as any).n;
          const mine = (this.sql.exec("SELECT COUNT(*) AS n FROM stations WHERE participant = ?", attachment.participantId).one() as any).n;
          if (total >= LIMITS.maxStationsPerRoom) throw new ProtocolError("roomFull", "The room has as many stations as it takes");
          if (mine >= LIMITS.maxStationsPerParticipant) throw new ProtocolError("tooManyStations", "That's as many stations as one member can have");
        }
        this.sql.exec(
          "INSERT OR REPLACE INTO stations (station, participant, kind, label, role, offline_since) VALUES (?, ?, ?, ?, ?, NULL)",
          station, attachment.participantId, message.kind, message.label, message.role,
        );
        this.sendTo(ws, { type: "claimed", station });
        this.broadcastStations();
        return;
      }
      case "release": {
        this.sql.exec("DELETE FROM stations WHERE station = ? AND participant = ?", message.station, attachment.participantId);
        this.broadcastStations();
        return;
      }
      case "status": {
        this.sql.exec("UPDATE participants SET rtt = ? WHERE id = ?", message.rttMs, attachment.participantId);
        this.broadcastParticipants();
        return;
      }
    }
  }

  /** The lowest station number nobody has, keeping 254 and 235 (the usual
   *  file and printer servers') for those. */
  private freeStation(): number | null {
    const used = new Set((this.sql.exec("SELECT station FROM stations").toArray() as any[]).map((s) => s.station));
    for (let n = 1; n <= 254; n++) {
      if (n === 235 || n === 254) continue;
      if (!used.has(n)) return n;
    }
    return null;
  }

  private relay(ws: WebSocket, participantId: string, data: ArrayBuffer) {
    const traffic = decodeTraffic(data);
    // The sender must hold its source station: no one speaks for another.
    const source = this.sql.exec("SELECT participant, offline_since FROM stations WHERE station = ?", traffic.from).toArray() as any[];
    if (!source[0] || source[0].participant !== participantId) {
      throw new ProtocolError("notYourStation", `Station ${traffic.from} isn't one of yours in this room`);
    }
    // The whole room's limit: over it, refused (its sender's told no one
    // answered, so its gateway lets its line go), not queued.
    if (!this.withinRoomRate(data.byteLength)) {
      this.count("refusedRoomRate");
      if (traffic.type === TrafficType.Frame) {
        ws.send(encodeTraffic({ version: PROTOCOL_VERSION, type: TrafficType.NoReply, final: false, stage: traffic.stage,
          transaction: traffic.transaction, from: traffic.to, to: traffic.from, frame: new Uint8Array() }));
      }
      return;
    }
    this.count("bytesRelayed", data.byteLength);
    this.report();
    if (traffic.type === TrafficType.Broadcast) {
      this.count("broadcasts");
      for (const other of this.ctx.getWebSockets()) {
        const a = other.deserializeAttachment() as Attachment | null;
        if (other !== ws && a?.hello && a.participantId !== participantId) other.send(data);
      }
      return;
    }
    const destination = this.sql.exec("SELECT participant, offline_since FROM stations WHERE station = ?", traffic.to).toArray() as any[];
    const target = destination[0] && destination[0].offline_since === null && destination[0].participant !== participantId
      ? this.ctx.getWebSockets(destination[0].participant).find((s) => (s.deserializeAttachment() as Attachment | null)?.hello)
      : undefined;
    if (target) {
      this.count("framesRelayed");
      target.send(data);
    } else if (traffic.type === TrafficType.Frame) {
      this.count("noReplies");
      // Nobody there: say so, so the sender's gateway lets its line go.
      ws.send(encodeTraffic({ version: PROTOCOL_VERSION, type: TrafficType.NoReply, final: false, stage: traffic.stage,
        transaction: traffic.transaction, from: traffic.to, to: traffic.from, frame: new Uint8Array() }));
    }
  }

  /** Per-connection limits: a frame over them is refused (its sender's
   *  told no one answered), not queued. */
  private withinRate(ws: WebSocket, bytes: number): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(ws) ?? { messages: LIMITS.maxMessagesPerSecond, bytes: LIMITS.maxBytesPerSecond, at: now, warned: 0 };
    const seconds = (now - bucket.at) / 1000;
    bucket.messages = Math.min(LIMITS.maxMessagesPerSecond, bucket.messages + seconds * LIMITS.maxMessagesPerSecond);
    bucket.bytes = Math.min(LIMITS.maxBytesPerSecond, bucket.bytes + seconds * LIMITS.maxBytesPerSecond);
    bucket.at = now;
    this.buckets.set(ws, bucket);
    if (bucket.messages >= 1 && bucket.bytes >= bytes) {
      bucket.messages -= 1;
      bucket.bytes -= bytes;
      return true;
    }
    this.count("refusedConnectionRate");
    if (now - bucket.warned > 1000) {
      bucket.warned = now;
      this.sendTo(ws, { type: "error", code: "rateLimited", message: "Too much traffic: some frames were refused" });
    }
    return false;
  }

  /** The whole room's traffic, a token bucket of its own (its rates are
   *  operator settings: ROOM_MESSAGES_PER_SECOND, ROOM_BYTES_PER_SECOND). */
  private withinRoomRate(bytes: number): boolean {
    const messages = setting(this.env, "ROOM_MESSAGES_PER_SECOND", 2000);
    const byteRate = setting(this.env, "ROOM_BYTES_PER_SECOND", 1_048_576);
    const now = Date.now();
    const bucket = this.roomBucket ?? { messages, bytes: byteRate, at: now };
    const seconds = (now - bucket.at) / 1000;
    bucket.messages = Math.min(messages, bucket.messages + seconds * messages);
    bucket.bytes = Math.min(byteRate, bucket.bytes + seconds * byteRate);
    bucket.at = now;
    this.roomBucket = bucket;
    if (bucket.messages < 1 || bucket.bytes < bytes) return false;
    bucket.messages -= 1;
    bucket.bytes -= bytes;
    return true;
  }

  // MARK: Metrics

  private count(key: keyof Counts, by = 1) {
    this.counts[key] += by;
  }

  private takeCounts(): Counts {
    const counts = this.counts;
    this.counts = emptyCounts();
    this.lastReport = Date.now();
    return counts;
  }

  /** Reports the room's counts and activity to the service's metrics, at
   *  most every half minute (or now). */
  private report(now = false) {
    const room = this.roomRow();
    if (!room || (!now && Date.now() - this.lastReport < 30_000)) return;
    const stations = (this.sql.exec("SELECT COUNT(*) AS n FROM stations WHERE offline_since IS NULL").one() as any).n as number;
    const activity = { connections: this.ctx.getWebSockets().length, stations };
    this.ctx.waitUntil(metrics(this.env).report(room.id, this.takeCounts(), activity));
  }

  // MARK: Telling everyone

  private sendTo(ws: WebSocket, message: ServerMessage) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Closing: it'll hear no more.
    }
  }

  private broadcast(message: ServerMessage, except?: WebSocket) {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      if (!(ws.deserializeAttachment() as Attachment | null)?.hello) continue;
      try { ws.send(text); } catch {}
    }
  }

  private broadcastParticipants(except?: WebSocket) {
    if (!this.roomRow()) return;
    this.broadcast({ type: "participants", participants: this.participantViews() }, except);
  }

  private broadcastStations(except?: WebSocket) {
    if (!this.roomRow()) return;
    this.broadcast({ type: "stations", stations: this.stationViews() }, except);
  }

  // MARK: Housekeeping

  /** Sets the alarm for the next thing due: a lease running out, the host's
   *  reconnect window, the room's idle expiry. */
  private async schedule() {
    if (!this.roomRow()) return;
    const times: number[] = [];
    const leases = this.sql.exec("SELECT MIN(offline_since) AS t FROM stations WHERE offline_since IS NOT NULL").one() as any;
    if (leases.t) times.push(leases.t + LEASE_GRACE_MS);
    const owner = this.sql.exec("SELECT id, last_seen FROM participants WHERE owner = 1").one() as any;
    if (owner && this.ctx.getWebSockets(owner.id).length === 0) times.push(owner.last_seen + OWNER_GRACE_MS);
    const room = this.sql.exec("SELECT last_activity FROM room").one() as any;
    times.push(room.last_activity + IDLE_EXPIRY_MS);
    await this.ctx.storage.setAlarm(Math.min(...times));
  }

  async alarm() {
    if (!this.roomRow()) return;
    const now = Date.now();
    // Leases not reclaimed in time.
    this.sql.exec("DELETE FROM stations WHERE offline_since IS NOT NULL AND offline_since + ? <= ?", LEASE_GRACE_MS, now);
    const owner = this.sql.exec("SELECT id, last_seen FROM participants WHERE owner = 1").one() as any;
    const ownerGone = owner && this.ctx.getWebSockets(owner.id).length === 0 && owner.last_seen + OWNER_GRACE_MS <= now;
    const anyone = this.ctx.getWebSockets().length > 0;
    const room = this.sql.exec("SELECT last_activity FROM room").one() as any;
    if (ownerGone || (!anyone && room.last_activity + IDLE_EXPIRY_MS <= now)) {
      await this.closeRoom();
      return;
    }
    this.broadcastStations();
    this.report(true);
    await this.schedule();
  }
}
