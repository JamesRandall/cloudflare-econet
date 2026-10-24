# Operations

## The service's own counts

Set an admin token (a secret, never in the configuration file):

```sh
npx wrangler secret put ADMIN_TOKEN            # add --config for the production deployment
```

Then `GET /v1/admin/metrics` with `Authorization: Bearer <token>` returns
the totals since the service began, and what's happening now:

```json
{"totals": {"roomsCreated": 12, "roomsClosed": 9, "joins": 20, "connections": 31, "reconnections": 4,
            "framesRelayed": 48211, "bytesRelayed": 1903322, "broadcasts": 3, "noReplies": 118,
            "refusedConnectionRate": 0, "refusedRoomRate": 0, "protocolErrors": 0, "screensRelayed": 2210},
 "now": {"activeRooms": 3, "connections": 7, "stations": 11}}
```

Rooms report their counts at most every half minute, and when someone
joins, connects or leaves, so the totals lag a little. "Active" rooms are
ones that have reported in the last five minutes. The counts have no room
ids, names, addresses or traffic in them.

Without `ADMIN_TOKEN`, the admin endpoints don't exist (404).

`./metrics.sh` does this for you: it reads the token from `.env.local`
(`ADMIN_TOKEN=...`, which git ignores) and prints the counts (another
service's with its address as an argument).

## Settings

In the Wrangler configuration's `vars` (empty means the default):

| Setting | Default | |
|---|---|---|
| `ROOM_CREATION` | `open` | `closed` stops new rooms (existing ones carry on) |
| `MAX_ACTIVE_ROOMS` | no limit | New rooms are refused (503 `serviceFull`) while this many are active |
| `INVITE_TTL_HOURS` | 24 | A new invitation's life |
| `ROOM_MESSAGES_PER_SECOND` | 2000 | A whole room's traffic, across all its members… |
| `ROOM_BYTES_PER_SECOND` | 1048576 | …and its bytes. Over either, frames are refused as "no reply", not queued |

Per-connection limits (400 messages, 256KB a second) and the protocol's
sizes are in `src/protocol.ts`.

## What to watch

Workers Observability (enabled in the configuration) has request counts,
errors and CPU time. Durable Objects' dashboard shows requests, WebSocket
messages, duration and storage, per class. Useful signs:

- **Rooms**: `RoomDurableObject` objects with activity.
- **Traffic**: WebSocket messages in; an Econet transaction is two to four
  each way.
- **Errors**: 5xx from the Worker; `rateLimited` sent to clients
  (per-connection limits hit).
- **Code lookups**: 404s and 429s on `/v1/invites/resolve` (guessing).

The service logs no tokens, codes, links or frames: `console.error` is used
only for unexpected failures, with the error message.

## Cleanup

Automatic, by each room's alarm:

- A disconnected member's stations are released after 5 minutes.
- A room whose host has been gone 30 minutes closes.
- A room nobody's connected to for 24 hours closes.
- Code index entries delete themselves when their invitation expires;
  rate-limit buckets when full again.

Closing a room deletes all its storage.

## Abuse

A room's host removes members (they're disconnected at once), withdraws
invitations, locks the room, or closes it. As the operator,
`DELETE /v1/admin/rooms/{id}` (with the admin token) closes any room for
everyone; its id is in its invitation link, before the dot. To stop new
rooms altogether, set `ROOM_CREATION` to `closed`; to tighten traffic,
lower the room limits, `LIMITS` or the HTTP rate limits, and redeploy.

## Outages

If the service is down, emulators' local networks keep working; shared
stations show as offline, and clients reconnect with backoff when it's
back. Rooms' state is in Durable Object storage and survives restarts and
deploys.

## Upgrades

Deploy as usual. Clients check the protocol version at `hello`; raise
`MINIMUM_PROTOCOL_VERSION` only when old clients truly can't work, since
they're told to upgrade and refused.
