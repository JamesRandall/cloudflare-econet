# Protocol, version 1

How Acorn emulators connect their machines' Econet to a room, and what
they say to each other through it. A client can be written from this, the
JSON Schemas in `protocol/v1`, and the test vectors in `protocol/fixtures`,
without reference to any emulator.

This is a room-relay protocol of its own, inspired by Acorn Universal
Networking's gateway concepts. It is **not** AUN, and it doesn't connect to
AUN equipment or software; see [compatibility.md](compatibility.md) for
where the two differ.

## Discovery

`GET /.well-known/acorn-econet` describes the deployment:

```json
{
  "service": "acorn-internet-econet",
  "name": "Acorn Internet Econet",
  "origin": "https://econet.example.org",
  "apiVersion": 1,
  "protocolVersions": [1],
  "minimumProtocolVersion": 1,
  "features": { "privateRooms": true, "joinCodes": true, "inviteLinks": true, "publicDirectory": false, "joinApproval": false },
  "limits": { "maxStationsPerRoom": 32, "maxParticipantsPerRoom": 16, "maxStationsPerParticipant": 16,
              "maxFrameBytes": 2048, "maxControlBytes": 4096, "maxMessagesPerSecond": 400, "maxBytesPerSecond": 262144,
              "maxNameLength": 64, "maxDescriptionLength": 280 }
}
```

A client checks `service`, that one of `protocolVersions` is one it speaks,
and the limits, before sending anything else. The limits are starting
values, not promises about hardware or Cloudflare.

## HTTP API

JSON in and out. Errors are `{"error": {"code": "...", "message": "..."}}`
with a fitting status; the message is fit to show a person. A service may
refuse new rooms for a while (503 `creationClosed` or `serviceFull`). Credentials go
in `Authorization: Bearer …`, never in a URL.

| Request | Body | Credential | Result |
|---|---|---|---|
| `POST /v1/rooms` | `name`, `description`, `displayName`, `client: {app, version}`, `screenSharing` (default false) | none (rate limited) | `201`: `roomId`, `participantId`, `ownerToken`, `memberToken`, `invite` |
| `POST /v1/invites/resolve` | `code`, or `token` (a link's) | none (rate limited) | `roomId`, `room`, `participants` (a count), `stations`, `inviteExpiresAt` |
| `POST /v1/rooms/{id}/join` | `code` or `token`, `displayName`, `client` | none (rate limited) | `201`: `participantId`, `memberToken`, `room` |
| `POST /v1/rooms/{id}/tickets` | | member | `201`: `ticket`, `expiresAt` (60 seconds, single use) |
| `GET /v1/rooms/{id}/connect?ticket=…` | WebSocket upgrade | the ticket | `101` |
| `GET /v1/rooms/{id}` | | member | `room`, `participantId`, `owner`, `participants`, `stations` |
| `PATCH /v1/rooms/{id}` | `name`, `description`, `locked`, `screenSharing` | owner | the room |
| `DELETE /v1/rooms/{id}` | | owner | `204`: closed for everyone |
| `POST /v1/rooms/{id}/leave` | | member | `204` (the host leaving closes the room) |
| `POST /v1/rooms/{id}/invites` | `ttlSeconds` (60 to 7 days), `maxUses` (1 to 1000) | owner | `201`: an invite |
| `GET /v1/rooms/{id}/invites` | | owner | `invites`: id, expiry, uses, revoked |
| `DELETE /v1/rooms/{id}/invites/{inviteId}` | | owner | `204` |
| `DELETE /v1/rooms/{id}/participants/{participantId}` | | owner | `204`: removed and disconnected |
| `POST /v1/rooms/{id}/screen-tickets` | | member (screen sharing allowed) | `201`: `ticket`, `expiresAt` |
| `GET /v1/rooms/{id}/screens?ticket=…` | WebSocket upgrade | the ticket | `101`: the room's screens (below) |
| `GET /join/{token}` | | the link | The invitation's web page |

An invite is `{id, code, url, expiresAt, maxUses}`. The code and the link
are two forms of the same invitation:

- **Code**: `ACRN-` and twelve Crockford base32 characters in three
  groups of four (eleven random, 55 bits, and a check character). Case, spaces,
  hyphens and the `ACRN` prefix don't matter when it's typed; `I` and `L`
  are read as `1`, `O` as `0`.
- **Link**: `https://<service>/join/<roomId>.<secret>`, the secret 128
  random bits. The page offers `macbeeb://join?service=<origin>&invite=<token>`
  and `macarch://join?…` to open an app.

New rooms come with one invitation: 24 hours, 20 uses. A code that's
unknown, expired, used up or withdrawn gets the same `404 inviteNotFound`,
which suggests it may belong to another deployment. A client never sends a
code to any service but the one it's set to use.

## The room's WebSocket

Get a ticket with the member token, then connect to `/connect?ticket=…`
(`wss://`). One connection per member: a new one replaces the old (which is
sent `closing` with reason `replaced`).

Text frames are control messages (JSON, at most `maxControlBytes`); binary
frames are Econet traffic. The text frame `ping` is answered `pong`, by the
runtime, without waking the room: send it every 20–30 seconds, and use the
time it takes for `status`.

### Control

The client speaks first:

```json
{"type": "hello", "protocolVersion": 1, "client": {"app": "MacBeeb", "version": "1.5"}}
```

Too old a version gets `error` `upgradeRequired`, then the connection
closes (code 4004). Otherwise:

```json
{"type": "welcome", "protocolVersion": 1, "participantId": "…", "owner": true,
 "room": {"id": "…", "name": "Classroom", "description": "", "locked": false},
 "participants": [{"id": "…", "name": "Host", "app": "MacBeeb", "owner": true, "online": true, "rttMs": 43}],
 "stations": [{"station": 254, "participantId": "…", "kind": "BBC Model B", "label": "File Server", "role": "fileServer", "online": true}],
 "limits": {…}}
```

Then, from the client:

- `{"type": "claim", "station": 2, "kind": "BBC Model B", "label": "BBC 2", "role": "station"}`: lease a
  station number for one of its machines. `station: null` lets the room
  choose (the lowest free, keeping 254 and 235, the usual file and printer
  servers', for those). Answered `claimed`, or `error` `stationTaken`.
  Roles are `station`, `fileServer`, `printServer`: descriptive, for others
  to show.
- `{"type": "release", "station": 2}`.
- `{"type": "status", "rttMs": 41}`: its round trip to the service, for
  others to show.

From the service: `room`, `participants`, `stations` (each whole, when it
changes), `claimed`, `error` (`code`, `message`, maybe `station`), and
`closing` (`roomClosed`, `removed`, `replaced`) before it closes the
connection (4001 removed, 4002 room closed, 4003 replaced).

A member whose connection drops keeps its stations for five minutes,
marked offline; reconnecting brings them back. If the host is gone for 30
minutes the room closes, and a room nobody's connected to for 24 hours
goes.

### Econet traffic

Each binary message is one of a transaction's frames, or a note that one
wasn't answered:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | Version: 1 |
| 1 | 1 | Type: 1 Frame, 2 NoReply, 3 Broadcast |
| 2 | 1 | Flags: bit 0 *final*, the transaction's last frame |
| 3 | 1 | Stage: the frame's place in its transaction, from 0 (the scout) |
| 4 | 4 | Transaction ID (big-endian), chosen by the gateway that saw the scout |
| 8 | 1 | From station |
| 9 | 1 | To station (255 for a broadcast) |
| 10 | 2 | Frame length (big-endian), at most `maxFrameBytes` |
| 12 | … | The Econet frame as it was on the line: destination station, destination network, source station, source network, then the rest. No flags or check bytes. Empty for NoReply. |

The service checks a message's shape, that the frame's addresses match its
header's, and that the sender holds the lease on its *from* station; then
passes it, unchanged, to the holder of *to* (or every other member, for a
broadcast). A frame to a station no one holds, or whose holder is offline,
comes back to its sender as NoReply.

Network numbers are 0: a room is one Econet network.

### How a gateway uses it

Econet's four-way handshake (scout, acknowledgement, data,
acknowledgement) needs each frame answered within about 15 bit-times. No
Internet is that quick, so a gateway never answers for a station that isn't
on its own line. Instead:

1. A local station sends a frame to a station in the room. The gateway
   holds its line with flags (a busy line isn't an idle one, so the sender
   keeps waiting) and sends the frame as a Frame, stage 0 for a scout.
2. The far gateway puts the frame on its line, as if from the sender.
3. If the real station answers, its next frame goes back the same way
   (stage + 1), and the first gateway stops its flags and puts it on its
   line. If it doesn't answer within 15 bit-times (allowing the line's
   delay, and a slow station's own flags), the far gateway sends NoReply,
   and the first stops its flags: its sender sees the line go quiet, as it
   would with nobody there.
4. And so on until the final frame, which isn't held for an answer.

Frames alternate between the two stations. Most transactions have four
(scout, acknowledgement, data, acknowledgement); the immediate operations
(port 0) PEEK and machine type have two (the scout, and the answer
carrying the data), as do HALT and CONTINUE (scout and acknowledgement).
The scout says which.

So an acknowledgement a station sees always came from its real
destination: delivery means delivery, and "not listening" is true. Each
transaction costs a round trip per frame after the scout, and holds both
lines meanwhile.

A gateway takes one transaction at a time. A scout arriving while it's busy
is refused with NoReply (the sender's NFS tries again), which also stops
two gateways each holding their line for the other from waiting forever. A
line is held at most two seconds.

Broadcasts are sent on without waiting, and nobody answers them.

## Screens

A room's host can allow members to share their machines' screens
(`screenSharing` on the room, off unless the host turns it on). Each member
then chooses whether to share theirs. Screens never travel with Econet
traffic: they have their own WebSocket, to their own Durable Object, so a
large image can't delay a frame.

Get a ticket (`POST /v1/rooms/{id}/screen-tickets`), then connect to
`/v1/rooms/{id}/screens?ticket=…`. Everything sent on it is a binary
screen image, relayed to every other member connected there:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | Version: 1 |
| 1 | 1 | Type: 16 (screen) |
| 2 | 1 | Station |
| 3 | 1 | Format: 1, JPEG |
| 4 | 2 | Width (big-endian), at most 1280 |
| 6 | 2 | Height (big-endian), at most 1024 |
| 8 | … | The image, at most `maxScreenBytes` (64KB) |

The service passes on an image only if the room allows screen sharing and
the station is the sender's (it asks the room, every ten seconds or so),
and at most one per station every `minScreenIntervalMs` (400ms). Anything
else is dropped, not queued: send the latest, when the last has gone. When
the host turns sharing off, or the room closes, screens connections close
(4005); a removed member's closes (4001). Nothing is stored.

## Versions

The protocol's version is in `hello` and in every binary message. A
service lists the versions it speaks and the oldest it accepts; a client
offers the newest it speaks, and the `welcome` says which is in use. New
optional fields may be added to JSON messages within a version: ignore
ones you don't know.
