// SPDX-License-Identifier: AGPL-3.0-only
import { exports } from "cloudflare:workers";
import { encodeTraffic, PROTOCOL_VERSION, TrafficType } from "../src/protocol";

let address = 0;

/** A request from its own client address (so rate limits don't mix). */
export async function call(method: string, path: string, body?: unknown, token?: string, ip?: string) {
  const headers: Record<string, string> = { "CF-Connecting-IP": ip ?? `192.0.2.${(address++ % 250) + 1}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await exports.default.fetch(`https://econet.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (safeJSON(text) ?? text) : null } as { status: number; body: any };
}

function safeJSON(text: string) {
  try { return JSON.parse(text); } catch { return null; }
}

export async function createRoom(name = "Test Room", options: { screenSharing?: boolean } = {}) {
  const r = await call("POST", "/v1/rooms", { name, displayName: "Host", client: { app: "MacBeeb", version: "1.5" }, ...options });
  if (r.status !== 201) throw new Error(`create: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { roomId: string; participantId: string; ownerToken: string; memberToken: string; invite: { id: string; code: string; url: string } };
}

export async function joinRoom(roomId: string, code: string, name = "Guest") {
  const r = await call("POST", `/v1/rooms/${roomId}/join`, { code, displayName: name, client: { app: "MacBeeb", version: "1.5" } });
  if (r.status !== 201) throw new Error(`join: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { participantId: string; memberToken: string };
}

/** A connected client: its socket, and what it's been sent. */
export class Client {
  messages: any[] = [];
  binary: Uint8Array[] = [];
  closed: { code: number } | null = null;
  private waiters: (() => void)[] = [];

  constructor(public ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        if (event.data !== "pong") this.messages.push(JSON.parse(event.data));
      } else if (event.data instanceof Blob) {
        // (The runtime hands a client binary messages as Blobs.)
        event.data.arrayBuffer().then((buffer) => {
          this.binary.push(new Uint8Array(buffer));
          this.wake();
        });
        return;
      } else {
        this.binary.push(new Uint8Array(event.data as ArrayBuffer));
      }
      this.wake();
    });
    ws.addEventListener("close", (event) => {
      this.closed = { code: event.code };
      this.wake();
    });
  }

  private wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** Waits until `test` passes (up to two seconds). */
  async until<T>(test: () => T | undefined | null | false): Promise<T> {
    const deadline = Date.now() + 2000;
    for (;;) {
      const value = test();
      if (value) return value;
      if (Date.now() > deadline) throw new Error("timed out waiting");
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  next(type: string) {
    return this.until(() => this.messages.find((m) => m.type === type && !m._seen && (m._seen = true)));
  }

  send(message: unknown) {
    this.ws.send(JSON.stringify(message));
  }

  close() {
    this.ws.close(1000, "bye");
  }
}

export async function connect(roomId: string, memberToken: string): Promise<Client> {
  const ticket = await call("POST", `/v1/rooms/${roomId}/tickets`, undefined, memberToken);
  if (ticket.status !== 201) throw new Error(`ticket: ${ticket.status} ${JSON.stringify(ticket.body)}`);
  const response = await exports.default.fetch(`https://econet.example/v1/rooms/${roomId}/connect?ticket=${ticket.body.ticket}`, {
    headers: { Upgrade: "websocket" },
  });
  if (response.status !== 101 || !response.webSocket) throw new Error(`connect: ${response.status}`);
  return new Client(response.webSocket);
}

/** Connects and says hello. */
export async function connected(roomId: string, memberToken: string): Promise<Client> {
  const client = await connect(roomId, memberToken);
  client.send({ type: "hello", protocolVersion: 1, client: { app: "MacBeeb", version: "1.5" } });
  await client.next("welcome");
  return client;
}

/** A scout from `from` to `to`, as the gateway would send it. */
export function scout(from: number, to: number, transaction = 1) {
  return encodeTraffic({
    version: PROTOCOL_VERSION, type: TrafficType.Frame, final: false, stage: 0, transaction, from, to,
    frame: new Uint8Array([to, 0, from, 0, 0x80, 0x77]),
  });
}

/** The room's screens connection. */
export async function connectScreens(roomId: string, memberToken: string): Promise<Client> {
  const ticket = await call("POST", `/v1/rooms/${roomId}/screen-tickets`, undefined, memberToken);
  if (ticket.status !== 201) throw new Error(`screen ticket: ${ticket.status} ${JSON.stringify(ticket.body)}`);
  const response = await exports.default.fetch(`https://econet.example/v1/rooms/${roomId}/screens?ticket=${ticket.body.ticket}`, {
    headers: { Upgrade: "websocket" },
  });
  if (response.status !== 101 || !response.webSocket) throw new Error(`screens: ${response.status}`);
  return new Client(response.webSocket);
}

/** A screen image for `station` (a fake JPEG of `size` bytes). */
export function screen(station: number, size = 100) {
  const bytes = new Uint8Array(8 + size);
  bytes.set([1, 16, station, 1, 0x01, 0x40, 0x01, 0x00]);
  bytes.fill(0xAB, 8);
  return bytes;
}
