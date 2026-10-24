// The published test vectors (protocol/fixtures) match this codec, both ways.
import { describe, expect, it } from "vitest";
import fixtures from "../protocol/fixtures/traffic.json";
import { decodeTraffic, encodeTraffic, ProtocolError, TrafficType } from "../src/protocol";

const hex = (s: string) => new Uint8Array(s.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
const types: Record<string, TrafficType> = { frame: TrafficType.Frame, noReply: TrafficType.NoReply, broadcast: TrafficType.Broadcast };

describe("protocol fixtures", () => {
  for (const f of fixtures.valid) {
    it(`decodes and encodes ${f.name}`, () => {
      const t = decodeTraffic(hex(f.encoded));
      expect([t.type, t.final, t.stage, t.transaction, t.from, t.to]).toEqual([types[f.type], f.final, f.stage, f.transaction, f.from, f.to]);
      expect([...t.frame]).toEqual([...hex(f.frame)]);
      expect([...encodeTraffic(t)]).toEqual([...hex(f.encoded)]);
    });
  }
  for (const f of fixtures.invalid) {
    it(`refuses ${f.name}`, () => {
      try {
        decodeTraffic(hex(f.encoded));
        expect.unreachable();
      } catch (error) {
        expect((error as ProtocolError).code).toBe(f.error);
      }
    });
  }
});
