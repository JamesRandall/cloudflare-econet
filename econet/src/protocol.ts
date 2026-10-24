// The room protocol, version 1: what clients and the service say to each
// other over a room's WebSocket. Control messages are JSON text; Econet
// traffic is binary. docs/protocol.md describes it in full, and
// protocol/v1 has its schemas and examples.

export const PROTOCOL_VERSION = 1;
/** The oldest protocol a client may speak. */
export const MINIMUM_PROTOCOL_VERSION = 1;

/** Starting limits, not claims about hardware or Cloudflare: raise them
 *  after load testing. */
export const LIMITS = {
  maxStationsPerRoom: 32,
  maxParticipantsPerRoom: 16,
  maxStationsPerParticipant: 16,
  /** One Econet frame, addresses included (Acorn's largest are well under). */
  maxFrameBytes: 2048,
  /** A control message. */
  maxControlBytes: 4096,
  /** Per connection. */
  maxMessagesPerSecond: 400,
  maxBytesPerSecond: 262_144,
  maxNameLength: 64,
  maxDescriptionLength: 280,
  /** A screen image, and how often each station may send one. */
  maxScreenBytes: 65_536,
  minScreenIntervalMs: 400,
} as const;

// MARK: Econet traffic (binary)

/** What a binary message carries. */
export const enum TrafficType {
  /** A frame of a transaction: the four-way handshake's scout,
   *  acknowledgement and data, or an immediate operation's. */
  Frame = 1,
  /** The station a frame went to didn't answer it. */
  NoReply = 2,
  /** A frame to every station (255). */
  Broadcast = 3,
}

export const HEADER_BYTES = 12;

/** A decoded binary message.
 *
 *  Layout (big-endian):
 *    0  version (1)
 *    1  type (TrafficType)
 *    2  flags: bit 0, final (the transaction's last frame)
 *    3  stage: the frame's place in its transaction, from 0 (the scout)
 *    4  transaction id (u32), chosen by the gateway that saw the scout
 *    8  from station
 *    9  to station (255 for a broadcast)
 *    10 length of the frame (u16)
 *    12 the Econet frame as it was on the line: destination station and
 *       network, source station and network, then the rest; no flags or
 *       check bytes. Empty for NoReply.
 */
export interface Traffic {
  version: number;
  type: TrafficType;
  final: boolean;
  stage: number;
  transaction: number;
  from: number;
  to: number;
  frame: Uint8Array;
}

export class ProtocolError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export function encodeTraffic(t: Traffic): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES + t.frame.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = t.version;
  bytes[1] = t.type;
  bytes[2] = t.final ? 1 : 0;
  bytes[3] = t.stage;
  view.setUint32(4, t.transaction >>> 0);
  bytes[8] = t.from;
  bytes[9] = t.to;
  view.setUint16(10, t.frame.length);
  bytes.set(t.frame, HEADER_BYTES);
  return bytes;
}

/** Decodes and checks a binary message's shape (not who may send it). */
export function decodeTraffic(data: ArrayBuffer | Uint8Array): Traffic {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < HEADER_BYTES) throw new ProtocolError("malformed", "message too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[0];
  if (version !== PROTOCOL_VERSION) throw new ProtocolError("unsupportedVersion", `traffic version ${version}`);
  const type = bytes[1] as TrafficType;
  if (type !== TrafficType.Frame && type !== TrafficType.NoReply && type !== TrafficType.Broadcast) {
    throw new ProtocolError("malformed", `unknown traffic type ${type}`);
  }
  const length = view.getUint16(10);
  if (length !== bytes.length - HEADER_BYTES) throw new ProtocolError("malformed", "length doesn't match");
  if (length > LIMITS.maxFrameBytes) throw new ProtocolError("tooLarge", "frame too large");
  const t: Traffic = {
    version,
    type,
    final: (bytes[2] & 1) !== 0,
    stage: bytes[3],
    transaction: view.getUint32(4),
    from: bytes[8],
    to: bytes[9],
    frame: bytes.subarray(HEADER_BYTES),
  };
  if (!isStation(t.from)) throw new ProtocolError("badAddress", "bad source station");
  switch (type) {
    case TrafficType.Frame:
      if (t.frame.length < 4) throw new ProtocolError("malformed", "a frame has at least its four address bytes");
      if (!isStation(t.to)) throw new ProtocolError("badAddress", "bad destination station");
      break;
    case TrafficType.Broadcast:
      if (t.frame.length < 4) throw new ProtocolError("malformed", "a frame has at least its four address bytes");
      if (t.to !== 255) throw new ProtocolError("badAddress", "a broadcast is to station 255");
      break;
    case TrafficType.NoReply:
      if (t.frame.length !== 0) throw new ProtocolError("malformed", "no frame with NoReply");
      if (!isStation(t.to)) throw new ProtocolError("badAddress", "bad destination station");
      break;
  }
  // The frame's own addresses must agree with the header's.
  if (t.frame.length >= 4 && (t.frame[0] !== t.to || t.frame[2] !== t.from)) {
    throw new ProtocolError("badAddress", "the frame's addresses don't match");
  }
  return t;
}

/** A station number a machine can have: 1-254 (0 and 255 are broadcast). */
export function isStation(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 254;
}

// MARK: Control (JSON)

/** What a station is, for other participants to show. */
export type StationRole = "station" | "fileServer" | "printServer";

export interface StationClaim {
  /** The number wanted; null for the room to choose. */
  station: number | null;
  /** "BBC Model B", "BBC Master 128", "A5000"... */
  kind: string;
  label: string;
  role: StationRole;
}

export type ClientMessage =
  | { type: "hello"; protocolVersion: number; client: { app: string; version: string } }
  | ({ type: "claim" } & StationClaim)
  | { type: "release"; station: number }
  | { type: "status"; rttMs: number };

const ROLES: StationRole[] = ["station", "fileServer", "printServer"];

function text(value: unknown, max: number, name: string): string {
  if (typeof value !== "string") throw new ProtocolError("malformed", `${name} must be text`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) throw new ProtocolError("malformed", `${name} must be 1-${max} characters`);
  // Printable only: no control characters in names others will see.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new ProtocolError("malformed", `${name} has control characters`);
  return trimmed;
}

/** Parses and checks a control message from a client. */
export function parseClientMessage(raw: string): ClientMessage {
  if (raw.length > LIMITS.maxControlBytes) throw new ProtocolError("tooLarge", "control message too large");
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProtocolError("malformed", "not JSON");
  }
  if (typeof value !== "object" || value === null) throw new ProtocolError("malformed", "not an object");
  switch (value.type) {
    case "hello": {
      if (!Number.isInteger(value.protocolVersion)) throw new ProtocolError("malformed", "protocolVersion");
      return {
        type: "hello",
        protocolVersion: value.protocolVersion,
        client: { app: text(value.client?.app, 32, "client.app"), version: text(value.client?.version, 32, "client.version") },
      };
    }
    case "claim": {
      const station = value.station === null || value.station === undefined ? null : value.station;
      if (station !== null && !isStation(station)) throw new ProtocolError("badAddress", "stations are 1 to 254");
      const role = ROLES.includes(value.role) ? (value.role as StationRole) : "station";
      return { type: "claim", station, kind: text(value.kind, 32, "kind"), label: text(value.label, LIMITS.maxNameLength, "label"), role };
    }
    case "release": {
      if (!isStation(value.station)) throw new ProtocolError("badAddress", "stations are 1 to 254");
      return { type: "release", station: value.station };
    }
    case "status": {
      const rtt = Number(value.rttMs);
      if (!Number.isFinite(rtt) || rtt < 0 || rtt > 60_000) throw new ProtocolError("malformed", "rttMs");
      return { type: "status", rttMs: Math.round(rtt) };
    }
    default:
      throw new ProtocolError("malformed", "unknown message type");
  }
}

/** A room member as others see it: no tokens, addresses or OS identity. */
export interface ParticipantView {
  id: string;
  name: string;
  app: string;
  owner: boolean;
  online: boolean;
  rttMs: number | null;
}

export interface StationView {
  station: number;
  participantId: string;
  kind: string;
  label: string;
  role: StationRole;
  online: boolean;
}

export interface RoomView {
  id: string;
  name: string;
  description: string;
  locked: boolean;
  /** Members may share their machines' screens (the host's choice). */
  screenSharing: boolean;
}

// MARK: Screens (binary, on the room's screens connection)

/** A machine's screen, as one of its participant's sends it: only on the
 *  room's separate screens connection, never with its Econet traffic.
 *
 *  Layout (big-endian):
 *    0  version (1)
 *    1  type: 16 (screen)
 *    2  station
 *    3  format: 1 JPEG
 *    4  width (u16)
 *    6  height (u16)
 *    8  the image
 */
export interface Screen {
  station: number;
  format: number;
  width: number;
  height: number;
}

export const SCREEN_TYPE = 16;
export const SCREEN_HEADER_BYTES = 8;

export function decodeScreenHeader(data: ArrayBuffer): Screen {
  const bytes = new Uint8Array(data);
  if (bytes.length <= SCREEN_HEADER_BYTES) throw new ProtocolError("malformed", "screen message too short");
  if (bytes[0] !== PROTOCOL_VERSION || bytes[1] !== SCREEN_TYPE) throw new ProtocolError("malformed", "not a screen");
  if (bytes.length > LIMITS.maxScreenBytes + SCREEN_HEADER_BYTES) throw new ProtocolError("tooLarge", "screen image too large");
  if (bytes[3] !== 1) throw new ProtocolError("malformed", "unknown image format");
  const view = new DataView(data);
  const screen = { station: bytes[2], format: bytes[3], width: view.getUint16(4), height: view.getUint16(6) };
  if (!isStation(screen.station)) throw new ProtocolError("badAddress", "bad station");
  if (screen.width === 0 || screen.width > 1280 || screen.height === 0 || screen.height > 1024) throw new ProtocolError("malformed", "bad size");
  return screen;
}

export type ServerMessage =
  | {
      type: "welcome";
      protocolVersion: number;
      participantId: string;
      owner: boolean;
      room: RoomView;
      participants: ParticipantView[];
      stations: StationView[];
      limits: typeof LIMITS;
    }
  | { type: "room"; room: RoomView }
  | { type: "participants"; participants: ParticipantView[] }
  | { type: "stations"; stations: StationView[] }
  | { type: "claimed"; station: number }
  | { type: "error"; code: string; message: string; station?: number }
  | { type: "closing"; reason: "roomClosed" | "removed" | "replaced" };
