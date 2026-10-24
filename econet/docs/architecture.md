# Architecture

```text
Mac A: MacBeeb                                       Mac B: MacBeeb
BBC Micros on a local Econet line                    BBC Micros on a local Econet line
          │                                                     │
   Internet gateway (on the line)                       Internet gateway
          │                                                     │
          └──── WSS ──── Cloudflare Worker ──── WSS ────────────┘
                              │
                 One Durable Object per room
           members · invitations · station leases · relay
```

## Responsibilities

**The emulator** runs the machines and their local Econet, as it always
does: a room adds nothing to a network that isn't shared, and if the
service is unreachable the local network carries on.

**The gateway**, in the emulator, is a device on the local line that stands
in for the stations in the room. It hears frames for them, holds the line
with flags while each crosses the Internet, and puts their answers on the
line. It speaks for the remote stations only with frames their real
stations sent. (See [protocol.md](protocol.md), "How a gateway uses it".)

**The service** authenticates members, keeps invitations and station
leases, and relays frames between the members' connections, checking each
against the sender's leases. It never runs guest code or looks inside a
frame past its addresses.

## The service

- `src/index.ts`: the Worker. Routes the HTTP API and WebSocket upgrades,
  checks request sizes and shapes, applies rate limits, and finds rooms.
- `src/rooms/RoomDurableObject.ts`: one per room, named by its random id.
  SQLite storage holds the room, members (token hashes), invitations
  (hashes), station leases and connection tickets. WebSockets use the
  hibernation API: each socket's member is in its tag and attachment, so
  nothing depends on memory surviving eviction. Alarms let leases lapse,
  close a room whose host has gone, and clean up idle rooms.
- `src/rooms/CodeIndexDurableObject.ts`: one per join code, named by the
  code's hash, pointing at its room until it expires. No global table, and
  nothing to enumerate.
- `src/rate-limits.ts`: one tiny Durable Object per client address (hashed)
  and action, a token bucket.
- `src/protocol.ts`: the protocol's types, limits, binary codec and control
  message validation.
- `src/invites.ts`, `src/auth.ts`: codes, link tokens, credentials.
- `src/landing.ts`: the invitation page.

There's no database to run: a deployment is one `wrangler deploy`.

## Why a Durable Object per room

A room's members must agree on who holds which station, and its frames
must pass through one place that checks them. One object per room gives
that, in order, without a global hot spot: rooms scale across Cloudflare's
network independently. A room's traffic is bounded by one object's
throughput (see Cloudflare's current limits), which is far above what a
room's Econet can generate: a real Econet carried a few kilobytes a second.
