// SPDX-License-Identifier: AGPL-3.0-only
// A tiny scripted client, no emulator needed: against a running service
// (`npm run dev`, or any deployment), it creates a room, joins it by code
// as a second participant, connects both, claims stations, relays a frame
// each way, checks a frame to nobody comes back as NoReply, reconnects,
// and closes the room.
//
//   node scripts/test-client.ts [https://econet.example.org]
//
// (Node 23.6+ runs TypeScript as it is.)

const service = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");

async function api(method: string, path: string, body?: unknown, token?: string) {
  const response = await fetch(service + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return json;
}

function frame(type: number, transaction: number, from: number, to: number, bytes: number[]) {
  const out = new Uint8Array(12 + bytes.length);
  const view = new DataView(out.buffer);
  out[0] = 1;
  out[1] = type;
  view.setUint32(4, transaction);
  out[8] = from;
  out[9] = to;
  view.setUint16(10, bytes.length);
  out.set(bytes, 12);
  return out;
}

class Client {
  messages: any[] = [];
  binary: Uint8Array[] = [];
  name: string;
  ws: WebSocket;
  constructor(name: string, ws: WebSocket) {
    this.name = name;
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        if (event.data !== "pong") this.messages.push(JSON.parse(event.data));
      } else {
        this.binary.push(new Uint8Array(event.data));
      }
    });
  }
  async until<T>(test: () => T | undefined | null | false, what: string): Promise<T> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const value = test();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`${this.name}: no ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  next(type: string) {
    return this.until(() => this.messages.find((m) => m.type === type && !m._seen && (m._seen = true)), type);
  }
  send(message: unknown) { this.ws.send(JSON.stringify(message)); }
}

async function connect(name: string, roomId: string, memberToken: string): Promise<Client> {
  const { ticket } = await api("POST", `/v1/rooms/${roomId}/tickets`, undefined, memberToken);
  const ws = new WebSocket(`${service.replace(/^http/, "ws")}/v1/rooms/${roomId}/connect?ticket=${encodeURIComponent(ticket)}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error(`${name}: couldn't connect`)));
  });
  const client = new Client(name, ws);
  client.send({ type: "hello", protocolVersion: 1, client: { app: "test-client", version: "1" } });
  await client.next("welcome");
  return client;
}

function step(text: string) {
  console.log(`✓ ${text}`);
}

const info = await api("GET", "/.well-known/acorn-econet");
step(`service ${info.name} (protocol ${info.protocolVersions.join(", ")})`);

const room = await api("POST", "/v1/rooms", { name: "Test Client Room", displayName: "Host", client: { app: "test-client", version: "1" } });
step(`room created, code ${room.invite.code}`);

const preview = await api("POST", "/v1/invites/resolve", { code: room.invite.code.toLowerCase().replace(/-/g, " ") });
step(`code resolves to "${preview.room.name}"`);
const guest = await api("POST", `/v1/rooms/${room.roomId}/join`, { code: room.invite.code, displayName: "Guest", client: { app: "test-client", version: "1" } });
step("guest joined by code");

const host = await connect("host", room.roomId, room.memberToken);
let visitor = await connect("guest", room.roomId, guest.memberToken);
step("both connected");

host.send({ type: "claim", station: 254, kind: "BBC Model B", label: "File Server", role: "fileServer" });
await host.next("claimed");
visitor.send({ type: "claim", station: null, kind: "BBC Master 128", label: "Master", role: "station" });
const { station } = await visitor.next("claimed");
step(`stations 254 (host) and ${station} (guest, chosen by the room)`);

// A scout from the guest to the file server, and the server's acknowledgement back.
visitor.ws.send(frame(1, 1, station, 254, [254, 0, station, 0, 0x80, 0x99]));
const scout = await host.until(() => host.binary.shift(), "scout");
host.ws.send(frame(1, 1, 254, station, [station, 0, 254, 0]));
const ack = await visitor.until(() => visitor.binary.shift(), "acknowledgement");
step(`relayed a scout (${scout.length} bytes) and its acknowledgement (${ack.length} bytes)`);

visitor.ws.send(frame(1, 2, station, 77, [77, 0, station, 0, 0x80, 0x99]));
const noReply = await visitor.until(() => visitor.binary.shift(), "NoReply");
if (noReply[1] !== 2) throw new Error("expected NoReply");
step("a frame to an empty station comes back as NoReply");

visitor.ws.close();
await host.until(() => host.messages.find((m) => m.type === "stations" && m.stations.some((s: any) => s.station === station && !s.online)), "offline");
visitor = await connect("guest", room.roomId, guest.memberToken);
const welcome = visitor.messages.find((m) => m.type === "welcome");
if (!welcome.stations.find((s: any) => s.station === station)?.online) throw new Error("lease not kept");
step("reconnected, and kept its station");

await api("DELETE", `/v1/rooms/${room.roomId}`, undefined, room.ownerToken);
await visitor.next("closing");
step("room closed");
host.ws.close();
visitor.ws.close();
