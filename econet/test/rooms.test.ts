import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { normaliseCode, newCode } from "../src/invites";
import { decodeTraffic, encodeTraffic, PROTOCOL_VERSION, TrafficType } from "../src/protocol";
import { call, connect, connected, createRoom, joinRoom, scout } from "./helpers";

describe("service", () => {
  it("describes itself", async () => {
    const r = await call("GET", "/.well-known/acorn-econet");
    expect(r.status).toBe(200);
    expect(r.body.service).toBe("acorn-internet-econet");
    expect(r.body.protocolVersions).toContain(1);
    expect(r.body.features.publicDirectory).toBe(false);
    expect(r.body.limits.maxStationsPerRoom).toBe(32);
  });
});

describe("codes", () => {
  it("are high-entropy, checked, and forgiving to type", () => {
    const codes = new Set(Array.from({ length: 200 }, newCode));
    expect(codes.size).toBe(200);
    const code = [...codes][0];
    expect(code).toMatch(/^ACRN-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(normaliseCode(code.toLowerCase())).toBe(code);
    expect(normaliseCode(code.replace(/-/g, " ").slice(5))).toBe(code);
    // One character wrong: the check character notices.
    const body = code.slice(5).replace(/-/g, "");
    const wrong = (body[0] === "0" ? "1" : "0") + body.slice(1);
    expect(normaliseCode(wrong)).toBeNull();
  });
});

describe("rooms", () => {
  it("are created with an invitation that resolves to a safe preview", async () => {
    const room = await createRoom("Classroom Network");
    expect(room.invite.url).toMatch(new RegExp(`^https://econet.example/join/${room.roomId}\\.`));
    const preview = await call("POST", "/v1/invites/resolve", { code: room.invite.code.toLowerCase().replace(/-/g, " ") });
    expect(preview.status).toBe(200);
    expect(preview.body.room.name).toBe("Classroom Network");
    expect(preview.body.roomId).toBe(room.roomId);
    expect(JSON.stringify(preview.body)).not.toContain(room.ownerToken);
    const byLink = await call("POST", "/v1/invites/resolve", { token: room.invite.url.split("/join/")[1] });
    expect(byLink.body.room.name).toBe("Classroom Network");
  });

  it("explain an unknown code without saying why", async () => {
    const r = await call("POST", "/v1/invites/resolve", { code: newCode() });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("inviteNotFound");
    expect(r.body.error.message).toMatch(/different Internet Econet service/);
  });

  it("let guests join by code or link, and show them to members", async () => {
    const room = await createRoom();
    const guest = await joinRoom(room.roomId, room.invite.code);
    const linkJoin = await call("POST", `/v1/rooms/${room.roomId}/join`, { token: room.invite.url.split("/join/")[1], displayName: "Second" });
    expect(linkJoin.status).toBe(201);
    const info = await call("GET", `/v1/rooms/${room.roomId}`, undefined, guest.memberToken);
    expect(info.status).toBe(200);
    expect(info.body.participants.map((p: any) => p.name)).toEqual(["Host", "Guest", "Second"]);
    expect(info.body.owner).toBe(false);
    // Only members.
    expect((await call("GET", `/v1/rooms/${room.roomId}`, undefined, "nonsense")).status).toBe(403);
  });

  it("refuse joins when locked, or with a withdrawn invitation", async () => {
    const room = await createRoom();
    expect((await call("PATCH", `/v1/rooms/${room.roomId}`, { locked: true }, room.ownerToken)).status).toBe(200);
    const locked = await call("POST", `/v1/rooms/${room.roomId}/join`, { code: room.invite.code });
    expect(locked.body.error.code).toBe("roomLocked");
    await call("PATCH", `/v1/rooms/${room.roomId}`, { locked: false }, room.ownerToken);
    // A guest can't manage the room.
    const guest = await joinRoom(room.roomId, room.invite.code);
    expect((await call("PATCH", `/v1/rooms/${room.roomId}`, { locked: true }, guest.memberToken)).status).toBe(403);
    expect((await call("DELETE", `/v1/rooms/${room.roomId}/invites/${room.invite.id}`, undefined, room.ownerToken)).status).toBe(204);
    expect((await call("POST", "/v1/invites/resolve", { code: room.invite.code })).status).toBe(404);
    // A new one works.
    const fresh = await call("POST", `/v1/rooms/${room.roomId}/invites`, { ttlSeconds: 600, maxUses: 1 }, room.ownerToken);
    expect(fresh.status).toBe(201);
    await joinRoom(room.roomId, fresh.body.code);
    // Used up.
    expect((await call("POST", `/v1/rooms/${room.roomId}/join`, { code: fresh.body.code })).body.error.code).toBe("inviteNotFound");
  });

  it("show an invitation page, and a dead end for a bad link", async () => {
    const room = await createRoom("Page Test");
    const token = room.invite.url.split("/join/")[1];
    const page = await call("GET", `/join/${token}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain("Page Test");
    expect(page.body).toContain("macbeeb://join?service=");
    expect((await call("GET", `/join/${room.roomId}.AAAAAAAAAAAAAAAAAAAAAA`)).status).toBe(404);
  });

  it("rate-limit code lookups", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++) {
      statuses.push((await call("POST", "/v1/invites/resolve", { code: newCode() }, undefined, "198.51.100.7")).status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(30)).toContain(429);
  });
});

describe("connections", () => {
  it("need a ticket, and use it once", async () => {
    const room = await createRoom();
    const ticket = await call("POST", `/v1/rooms/${room.roomId}/tickets`, undefined, room.memberToken);
    const url = `/v1/rooms/${room.roomId}/connect?ticket=${ticket.body.ticket}`;
    const { exports } = await import("cloudflare:workers");
    const first = await exports.default.fetch(`https://econet.example${url}`, { headers: { Upgrade: "websocket" } });
    expect(first.status).toBe(101);
    first.webSocket!.accept();
    const again = await exports.default.fetch(`https://econet.example${url}`, { headers: { Upgrade: "websocket" } });
    expect(again.status).toBe(403);
  });

  it("refuse an old client, saying to upgrade", async () => {
    const room = await createRoom();
    const client = await connect(room.roomId, room.memberToken);
    client.send({ type: "hello", protocolVersion: 0, client: { app: "MacBeeb", version: "0.9" } });
    const error = await client.next("error");
    expect(error.code).toBe("upgradeRequired");
    await client.until(() => client.closed);
  });

  it("lease stations, refuse a taken one, and relay frames only from their holder", async () => {
    const room = await createRoom();
    const guest = await joinRoom(room.roomId, room.invite.code);
    const host = await connected(room.roomId, room.memberToken);
    const visitor = await connected(room.roomId, guest.memberToken);

    host.send({ type: "claim", station: 1, kind: "BBC Master 128", label: "Master", role: "station" });
    expect((await host.next("claimed")).station).toBe(1);
    host.send({ type: "claim", station: 254, kind: "BBC Model B", label: "File Server", role: "fileServer" });
    await host.next("claimed");
    visitor.send({ type: "claim", station: 1, kind: "BBC Model B", label: "Mine", role: "station" });
    expect((await visitor.next("error")).code).toBe("stationTaken");
    visitor.send({ type: "claim", station: null, kind: "BBC Model B", label: "Mine", role: "station" });
    expect((await visitor.next("claimed")).station).toBe(2);
    const stations = await visitor.until(() => visitor.messages.filter((m) => m.type === "stations").at(-1)?.stations?.length === 3
      && visitor.messages.filter((m) => m.type === "stations").at(-1));
    expect(stations.stations.map((s: any) => [s.station, s.kind, s.online])).toEqual([
      [1, "BBC Master 128", true], [2, "BBC Model B", true], [254, "BBC Model B", true],
    ]);

    // Visitor's station 2 sends a scout to the file server: the host gets it, byte for byte.
    visitor.ws.send(scout(2, 254, 7));
    const received = decodeTraffic(await host.until(() => host.binary.shift()));
    expect([received.from, received.to, received.transaction, received.stage]).toEqual([2, 254, 7, 0]);
    expect([...received.frame]).toEqual([254, 0, 2, 0, 0x80, 0x77]);

    // Pretending to be the file server: refused.
    visitor.ws.send(scout(254, 1));
    expect((await visitor.next("error")).code).toBe("notYourStation");
    expect(host.binary.length).toBe(0);

    // To a station nobody has: the sender's told nobody answered.
    visitor.ws.send(scout(2, 99, 9));
    const noReply = decodeTraffic(await visitor.until(() => visitor.binary.shift()));
    expect([noReply.type, noReply.from, noReply.to, noReply.transaction]).toEqual([TrafficType.NoReply, 99, 2, 9]);

    // A broadcast reaches everyone else.
    const broadcast = encodeTraffic({ version: PROTOCOL_VERSION, type: TrafficType.Broadcast, final: false, stage: 0, transaction: 0,
      from: 1, to: 255, frame: new Uint8Array([255, 0, 1, 0, 0x80, 0x99, 1, 2, 3, 4, 5, 6, 7, 8]) });
    host.ws.send(broadcast);
    const heard = decodeTraffic(await visitor.until(() => visitor.binary.shift()));
    expect(heard.type).toBe(TrafficType.Broadcast);
    expect(host.binary.length).toBe(0);
  });

  it("refuse malformed traffic", async () => {
    const room = await createRoom();
    const host = await connected(room.roomId, room.memberToken);
    host.send({ type: "claim", station: 5, kind: "BBC Model B", label: "B", role: "station" });
    await host.next("claimed");
    // Header says 6 bytes; frame's addresses disagree.
    const bad = scout(5, 6);
    bad[9] = 7;
    host.ws.send(bad);
    expect((await host.next("error")).code).toBe("badAddress");
    host.ws.send(new Uint8Array([1, 2, 3]));
    expect((await host.next("error")).code).toBe("malformed");
  });

  it("keep a disconnected member's stations for a while, and give them back on reconnecting", async () => {
    const room = await createRoom();
    const guest = await joinRoom(room.roomId, room.invite.code);
    const host = await connected(room.roomId, room.memberToken);
    let visitor = await connected(room.roomId, guest.memberToken);
    visitor.send({ type: "claim", station: 3, kind: "BBC Model B", label: "B", role: "station" });
    await visitor.next("claimed");
    visitor.close();
    const offline = await host.until(() => host.messages.find((m) => m.type === "stations" && m.stations.some((s: any) => s.station === 3 && !s.online)));
    expect(offline).toBeTruthy();
    // Frames to it meanwhile: nobody answers.
    host.send({ type: "claim", station: 1, kind: "BBC Model B", label: "A", role: "station" });
    await host.next("claimed");
    host.ws.send(scout(1, 3));
    expect(decodeTraffic(await host.until(() => host.binary.shift())).type).toBe(TrafficType.NoReply);
    // Nobody else can take it.
    const other = await joinRoom(room.roomId, room.invite.code, "Other");
    const third = await connected(room.roomId, other.memberToken);
    third.send({ type: "claim", station: 3, kind: "BBC Model B", label: "Mine now", role: "station" });
    expect((await third.next("error")).code).toBe("stationTaken");
    // Back.
    visitor = await connected(room.roomId, guest.memberToken);
    const welcome = visitor.messages.find((m) => m.type === "welcome");
    expect(welcome.stations.find((s: any) => s.station === 3).online).toBe(true);
  });

  it("let the host remove a member, who's disconnected at once", async () => {
    const room = await createRoom();
    const guest = await joinRoom(room.roomId, room.invite.code);
    const visitor = await connected(room.roomId, guest.memberToken);
    expect((await call("DELETE", `/v1/rooms/${room.roomId}/participants/${guest.participantId}`, undefined, room.ownerToken)).status).toBe(204);
    expect((await visitor.next("closing")).reason).toBe("removed");
    await visitor.until(() => visitor.closed);
    expect((await call("POST", `/v1/rooms/${room.roomId}/tickets`, undefined, guest.memberToken)).status).toBe(403);
  });

  it("close the room for everyone", async () => {
    const room = await createRoom();
    const guest = await joinRoom(room.roomId, room.invite.code);
    const visitor = await connected(room.roomId, guest.memberToken);
    expect((await call("DELETE", `/v1/rooms/${room.roomId}`, undefined, room.ownerToken)).status).toBe(204);
    expect((await visitor.next("closing")).reason).toBe("roomClosed");
    expect((await call("GET", `/v1/rooms/${room.roomId}`, undefined, guest.memberToken)).status).toBe(404);
    expect((await call("POST", "/v1/invites/resolve", { code: room.invite.code })).status).toBe(404);
  });
});

describe("housekeeping", () => {
  it("lets leases go after the grace period, and closes the room when its host doesn't come back", async () => {
    const room = await createRoom();
    const guest = await joinRoom(room.roomId, room.invite.code);
    const host = await connected(room.roomId, room.memberToken);
    const visitor = await connected(room.roomId, guest.memberToken);
    visitor.send({ type: "claim", station: 4, kind: "BBC Model B", label: "B", role: "station" });
    await visitor.next("claimed");
    visitor.close();
    await host.until(() => host.messages.find((m) => m.type === "stations" && m.stations.some((s: any) => s.station === 4 && !s.online)));
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room.roomId));
    // Pretend the grace period's passed.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE stations SET offline_since = offline_since - ?", 6 * 60_000);
    });
    await runDurableObjectAlarm(stub);
    const info = await call("GET", `/v1/rooms/${room.roomId}`, undefined, room.memberToken);
    expect(info.body.stations).toEqual([]);

    // The host goes, and doesn't come back within its window: the room closes.
    host.close();
    await new Promise((r) => setTimeout(r, 100));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE participants SET last_seen = last_seen - ?", 31 * 60_000);
    });
    await runDurableObjectAlarm(stub);
    expect((await call("GET", `/v1/rooms/${room.roomId}`, undefined, guest.memberToken)).status).toBe(404);
  });
});
