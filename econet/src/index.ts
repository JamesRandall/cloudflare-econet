// SPDX-License-Identifier: AGPL-3.0-only
// The public HTTP API and WebSocket upgrade. Rooms are their own Durable
// Objects; this Worker checks requests' shapes and sizes, applies rate
// limits, finds the room, and passes the request on.

import { bearer, newId, sameHash, sha256 } from "./auth";
import { normaliseCode, parseLinkToken } from "./invites";
import { landingPage } from "./landing";
import { LIMITS } from "./protocol";
import { allow } from "./rate-limits";
import { metrics } from "./metrics";
import { RoomError, type InviteIssued } from "./rooms/RoomDurableObject";
import { publicOrigin, serviceInfo, setting, sourceURL, type Env } from "./service-info";

export { RoomDurableObject } from "./rooms/RoomDurableObject";
export { CodeIndexDurableObject } from "./rooms/CodeIndexDurableObject";
export { RateLimiterDurableObject } from "./rate-limits";
export { ScreensDurableObject } from "./rooms/ScreensDurableObject";
export { MetricsDurableObject } from "./metrics";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 4096;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function problem(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

async function readJSON(request: Request): Promise<any> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (length > MAX_BODY_BYTES) throw new RoomError(413, "tooLarge", "Request too large");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new RoomError(413, "tooLarge", "Request too large");
  if (text.trim() === "") return {};
  try {
    const value = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new RoomError(400, "malformed", "The body must be a JSON object");
  }
}

/** Text a person typed: trimmed, within `max`, printable. */
function field(value: unknown, max: number, name: string, fallback?: string): string {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    throw new RoomError(400, "malformed", `${name} is required`);
  }
  if (typeof value !== "string") throw new RoomError(400, "malformed", `${name} must be text`);
  const text = value.trim();
  if (text.length > max) throw new RoomError(400, "malformed", `${name} is at most ${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new RoomError(400, "malformed", `${name} has control characters`);
  return text || (fallback ?? "");
}

function roomStub(env: Env, roomId: string) {
  if (!/^[A-Za-z0-9_-]{16,32}$/.test(roomId)) throw new RoomError(404, "roomNotFound", "There's no such room");
  return env.ROOMS.get(env.ROOMS.idFromName(roomId));
}

function codeStub(env: Env, codeHash: string) {
  return env.CODES.get(env.CODES.idFromName(`code:${codeHash}`));
}

async function limited(env: Env, request: Request, action: Parameters<typeof allow>[2]) {
  if (!(await allow(env, request, action))) throw new RoomError(429, "rateLimited", "Too many requests: try again in a minute");
}

/** An invitation as the host sees it. */
function inviteBody(invite: InviteIssued, origin: string) {
  return {
    id: invite.id,
    code: invite.code,
    url: `${origin}/join/${invite.linkToken}`,
    expiresAt: new Date(invite.expiresAt).toISOString(),
    maxUses: invite.maxUses,
  };
}

async function registerCode(env: Env, roomId: string, invite: InviteIssued) {
  await codeStub(env, invite.codeHash).register({ roomId, inviteId: invite.id, expiresAt: invite.expiresAt });
}

/** The room and invite a typed code is for. */
async function resolveCode(env: Env, typed: unknown): Promise<{ roomId: string; code: string }> {
  const code = typeof typed === "string" ? normaliseCode(typed) : null;
  const unknown = new RoomError(404, "inviteNotFound",
    "That code isn't known here. It may have expired, or it may be for a different Internet Econet service.");
  if (!code) throw unknown;
  const entry = await codeStub(env, await sha256(code)).lookup();
  if (!entry) throw unknown;
  return { roomId: entry.roomId, code };
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const origin = publicOrigin(env, request);

  if (path === "/.well-known/acorn-econet" && method === "GET") {
    return json(serviceInfo(env, origin));
  }
  if (path === "/" && method === "GET") {
    return new Response(`${env.SERVICE_NAME || "Acorn Internet Econet"}: Econet rooms for Acorn emulators. See /.well-known/acorn-econet.\nSource code: ${sourceURL(env)}\n`,
      { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  // The landing page for an invitation link.
  let match = /^\/join\/([A-Za-z0-9_.-]+)$/.exec(path);
  if (match && method === "GET") {
    await limited(env, request, "landing");
    const parsed = parseLinkToken(match[1]);
    let preview = null;
    if (parsed) {
      try {
        preview = await roomStub(env, parsed.roomId).preview({ linkSecret: parsed.secret });
      } catch (error) {
        if (!(error instanceof RoomError)) throw error;
      }
    }
    return landingPage({ origin, token: match[1], preview, serviceName: env.SERVICE_NAME, source: sourceURL(env) });
  }

  // The operator's: with ADMIN_TOKEN set (a secret), the service's counts,
  // and closing any room.
  if (path.startsWith("/v1/admin/")) {
    const admin = (env as unknown as { ADMIN_TOKEN?: string }).ADMIN_TOKEN;
    const token = bearer(request);
    if (!admin || !token || !sameHash(await sha256(token), await sha256(admin))) return problem(404, "notFound", "Not found");
    if (path === "/v1/admin/metrics" && method === "GET") {
      return json(await metrics(env).snapshot());
    }
    const closing = /^\/v1\/admin\/rooms\/([A-Za-z0-9_-]+)$/.exec(path);
    if (closing && method === "DELETE") {
      await roomStub(env, closing[1]).adminClose();
      return new Response(null, { status: 204 });
    }
    return problem(404, "notFound", "Not found");
  }

  if (path === "/v1/rooms" && method === "POST") {
    await limited(env, request, "createRoom");
    // The operator's settings: room creation can be closed, and the number
    // of active rooms capped.
    if ((env as unknown as { ROOM_CREATION?: string }).ROOM_CREATION === "closed") {
      throw new RoomError(503, "creationClosed", "This service isn't making new rooms just now");
    }
    const maxRooms = setting(env, "MAX_ACTIVE_ROOMS", Infinity);
    if (Number.isFinite(maxRooms) && (await metrics(env).activeRooms()) >= maxRooms) {
      throw new RoomError(503, "serviceFull", "This service has as many rooms as it can take just now: try again later");
    }
    const body = await readJSON(request);
    const roomId = newId();
    const created = await roomStub(env, roomId).create({
      roomId,
      name: field(body.name, LIMITS.maxNameLength, "name", "Econet Network"),
      description: field(body.description, LIMITS.maxDescriptionLength, "description", ""),
      ownerName: field(body.displayName, LIMITS.maxNameLength, "displayName", "Host"),
      app: field(body.client?.app, 32, "client.app", "unknown"),
      screenSharing: body.screenSharing === true,
    });
    await registerCode(env, roomId, created.invite);
    return json({
      roomId,
      participantId: created.participantId,
      ownerToken: created.ownerToken,
      memberToken: created.memberToken,
      invite: inviteBody(created.invite, origin),
    }, 201);
  }

  if (path === "/v1/invites/resolve" && method === "POST") {
    await limited(env, request, "resolveCode");
    const body = await readJSON(request);
    let roomId: string;
    let preview;
    if (body.code !== undefined) {
      const resolved = await resolveCode(env, body.code);
      roomId = resolved.roomId;
      preview = await roomStub(env, roomId).preview({ code: resolved.code });
    } else {
      const parsed = typeof body.token === "string" ? parseLinkToken(body.token) : null;
      if (!parsed) throw new RoomError(404, "inviteNotFound", "That invitation isn't valid");
      roomId = parsed.roomId;
      preview = await roomStub(env, roomId).preview({ linkSecret: parsed.secret });
    }
    return json({ roomId, ...preview, inviteExpiresAt: new Date(preview.inviteExpiresAt).toISOString() });
  }

  match = /^\/v1\/rooms\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(path);
  if (match) {
    const roomId = match[1];
    const rest = match[2] ?? "";
    const room = roomStub(env, roomId);
    const token = bearer(request);
    const needToken = () => {
      if (!token) throw new RoomError(401, "unauthorised", "This needs the room's credentials");
      return token;
    };

    if (rest === "/join" && method === "POST") {
      await limited(env, request, "join");
      const body = await readJSON(request);
      let by: { code?: string; linkSecret?: string };
      if (body.code !== undefined) {
        const resolved = await resolveCode(env, body.code);
        if (resolved.roomId !== roomId) throw new RoomError(404, "inviteNotFound", "That invitation isn't valid");
        by = { code: resolved.code };
      } else {
        const parsed = typeof body.token === "string" ? parseLinkToken(body.token) : null;
        if (!parsed || parsed.roomId !== roomId) throw new RoomError(404, "inviteNotFound", "That invitation isn't valid");
        by = { linkSecret: parsed.secret };
      }
      const joined = await room.join({
        ...by,
        name: field(body.displayName, LIMITS.maxNameLength, "displayName", "Guest"),
        app: field(body.client?.app, 32, "client.app", "unknown"),
      });
      return json(joined, 201);
    }
    if (rest === "/tickets" && method === "POST") {
      await limited(env, request, "ticket");
      return json(await room.ticket(needToken()), 201);
    }
    if (rest === "/connect" && method === "GET") {
      return room.fetch(request);
    }
    // Screens: a connection of their own, to their own object, so they
    // never get in the way of the room's Econet.
    if (rest === "/screen-tickets" && method === "POST") {
      await limited(env, request, "ticket");
      return json(await room.screenTicket(needToken()), 201);
    }
    if (rest === "/screens" && method === "GET") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new RoomError(426, "upgradeRequired", "Expected a WebSocket");
      const redeemed = await room.redeemScreenTicket(url.searchParams.get("ticket") ?? "");
      if (!redeemed) throw new RoomError(403, "badTicket", "Invalid or expired ticket, or screen sharing isn't allowed");
      const headers = new Headers(request.headers);
      headers.set("X-Econet-Participant", redeemed.participantId);
      headers.set("X-Econet-Room", roomId);
      return env.SCREENS.get(env.SCREENS.idFromName(roomId)).fetch(new Request(request.url, { headers }));
    }
    if (rest === "" && method === "GET") {
      return json(await room.info(needToken()));
    }
    if (rest === "" && method === "PATCH") {
      const body = await readJSON(request);
      const change: { name?: string; description?: string; locked?: boolean; screenSharing?: boolean } = {};
      if (body.name !== undefined) change.name = field(body.name, LIMITS.maxNameLength, "name");
      if (body.description !== undefined) change.description = field(body.description, LIMITS.maxDescriptionLength, "description", "");
      if (body.locked !== undefined) change.locked = body.locked === true;
      if (body.screenSharing !== undefined) change.screenSharing = body.screenSharing === true;
      return json(await room.update(needToken(), change));
    }
    if (rest === "" && method === "DELETE") {
      await room.close(needToken());
      return new Response(null, { status: 204 });
    }
    if (rest === "/leave" && method === "POST") {
      await room.leave(needToken());
      return new Response(null, { status: 204 });
    }
    if (rest === "/invites" && method === "POST") {
      const body = await readJSON(request);
      const invite = await room.issueInvite(needToken(), { ttlSeconds: body.ttlSeconds, maxUses: body.maxUses });
      await registerCode(env, roomId, invite);
      return json(inviteBody(invite, origin), 201);
    }
    if (rest === "/invites" && method === "GET") {
      return json({ invites: await room.listInvites(needToken()) });
    }
    const invite = /^\/invites\/([A-Za-z0-9_-]+)$/.exec(rest);
    if (invite && method === "DELETE") {
      const codeHash = await room.revokeInvite(needToken(), invite[1]);
      if (codeHash) await codeStub(env, codeHash).remove();
      return new Response(null, { status: 204 });
    }
    const participant = /^\/participants\/([A-Za-z0-9_-]+)$/.exec(rest);
    if (participant && method === "DELETE") {
      await room.removeParticipant(needToken(), participant[1]);
      return new Response(null, { status: 204 });
    }
  }
  return problem(404, "notFound", "Not found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      // RPC errors arrive as plain Errors carrying RoomError's fields.
      const e = error as any;
      if (error instanceof RoomError) return problem(error.status, error.code, error.detail);
      const known = /^(\d{3}) (\w+): (.*)$/s.exec(e?.message ?? "");
      if (known) return problem(Number(known[1]), known[2], known[3]);
      console.error("unhandled", e?.message);
      return problem(500, "internal", "Something went wrong");
    }
  },
} satisfies ExportedHandler<Env>;
