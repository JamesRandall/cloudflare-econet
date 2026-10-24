// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { decodeTraffic, TrafficType } from "../src/protocol";
import { call, connected, createRoom, joinRoom, scout } from "./helpers";

const ADMIN = "test-admin-token";

describe("operations", () => {
  it("refuse a room's traffic over its room-wide limit, telling the sender", async () => {
    const room = await createRoom();
    const guest = await joinRoom(room.roomId, room.invite.code);
    const host = await connected(room.roomId, room.memberToken);
    const visitor = await connected(room.roomId, guest.memberToken);
    host.send({ type: "claim", station: 1, kind: "BBC Model B", label: "A", role: "station" });
    await host.next("claimed");
    visitor.send({ type: "claim", station: 2, kind: "BBC Model B", label: "B", role: "station" });
    await visitor.next("claimed");
    for (let i = 0; i < 60; i++) visitor.ws.send(scout(2, 1, i));
    // Some get through; the rest come back as NoReply.
    await visitor.until(() => visitor.binary.length > 0);
    await new Promise((r) => setTimeout(r, 200));
    const refused = visitor.binary.map((b) => decodeTraffic(b)).filter((t) => t.type === TrafficType.NoReply);
    expect(refused.length).toBeGreaterThan(0);
    expect(host.binary.length).toBeGreaterThan(0);
    expect(host.binary.length + refused.length).toBe(60);
  });

  it("count what rooms do, for the operator only", async () => {
    expect((await call("GET", "/v1/admin/metrics")).status).toBe(404);
    expect((await call("GET", "/v1/admin/metrics", undefined, "wrong")).status).toBe(404);
    const before = (await call("GET", "/v1/admin/metrics", undefined, ADMIN)).body;
    const room = await createRoom();
    const guest = await joinRoom(room.roomId, room.invite.code);
    const host = await connected(room.roomId, room.memberToken);
    const visitor = await connected(room.roomId, guest.memberToken);
    host.send({ type: "claim", station: 1, kind: "BBC Model B", label: "A", role: "station" });
    await host.next("claimed");
    visitor.send({ type: "claim", station: 2, kind: "BBC Model B", label: "B", role: "station" });
    await visitor.next("claimed");
    visitor.ws.send(scout(2, 1));
    await host.until(() => host.binary.length > 0);
    // A disconnect makes the room report at once.
    visitor.close();
    await new Promise((r) => setTimeout(r, 200));
    const after = (await call("GET", "/v1/admin/metrics", undefined, ADMIN)).body;
    expect(after.totals.roomsCreated - before.totals.roomsCreated).toBeGreaterThanOrEqual(1);
    expect(after.totals.joins - before.totals.joins).toBeGreaterThanOrEqual(1);
    expect(after.totals.framesRelayed - before.totals.framesRelayed).toBeGreaterThanOrEqual(1);
    expect(after.now.activeRooms).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(after)).not.toContain(room.roomId);
  });

  it("let the operator close any room", async () => {
    const room = await createRoom();
    const guest = await joinRoom(room.roomId, room.invite.code);
    const visitor = await connected(room.roomId, guest.memberToken);
    expect((await call("DELETE", `/v1/admin/rooms/${room.roomId}`, undefined, "wrong")).status).toBe(404);
    expect((await call("DELETE", `/v1/admin/rooms/${room.roomId}`, undefined, ADMIN)).status).toBe(204);
    expect((await visitor.next("closing")).reason).toBe("roomClosed");
    expect((await call("GET", `/v1/rooms/${room.roomId}`, undefined, guest.memberToken)).status).toBe(404);
  });
});
