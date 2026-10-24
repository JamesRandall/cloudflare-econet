import { describe, expect, it } from "vitest";
import { call, connected, connectScreens, createRoom, joinRoom, screen } from "./helpers";

describe("screens", () => {
  it("are relayed to everyone else, only for the sender's own stations", async () => {
    const room = await createRoom("Screens", { screenSharing: true });
    const guest = await joinRoom(room.roomId, room.invite.code);
    const visitor = await connected(room.roomId, guest.memberToken);
    visitor.send({ type: "claim", station: 7, kind: "BBC Model B", label: "B", role: "station" });
    await visitor.next("claimed");
    const welcome = visitor.messages.find((m) => m.type === "welcome");
    expect(welcome.room.screenSharing).toBe(true);

    const hostScreens = await connectScreens(room.roomId, room.memberToken);
    const guestScreens = await connectScreens(room.roomId, guest.memberToken);
    guestScreens.ws.send(screen(7));
    const got = await hostScreens.until(() => hostScreens.binary.shift());
    expect([got[1], got[2], got.length]).toEqual([16, 7, 108]);
    expect(guestScreens.binary.length).toBe(0);

    // Not its station: dropped.
    guestScreens.ws.send(screen(9));
    // Too soon after the last: dropped.
    guestScreens.ws.send(screen(7));
    await new Promise((r) => setTimeout(r, 150));
    expect(hostScreens.binary.length).toBe(0);
    // Later: through.
    await new Promise((r) => setTimeout(r, 400));
    guestScreens.ws.send(screen(7));
    expect((await hostScreens.until(() => hostScreens.binary.shift()))[2]).toBe(7);
  });

  it("aren't allowed unless the host says so, and stop when the host says not", async () => {
    const closed = await createRoom("No screens");
    expect((await call("POST", `/v1/rooms/${closed.roomId}/screen-tickets`, undefined, closed.memberToken)).status).toBe(403);

    const room = await createRoom("Screens", { screenSharing: true });
    const guest = await joinRoom(room.roomId, room.invite.code);
    const guestScreens = await connectScreens(room.roomId, guest.memberToken);
    expect((await call("PATCH", `/v1/rooms/${room.roomId}`, { screenSharing: false }, room.ownerToken)).status).toBe(200);
    await guestScreens.until(() => guestScreens.closed);
    expect(guestScreens.closed!.code).toBe(4005);
    expect((await call("POST", `/v1/rooms/${room.roomId}/screen-tickets`, undefined, guest.memberToken)).status).toBe(403);
  });
});
