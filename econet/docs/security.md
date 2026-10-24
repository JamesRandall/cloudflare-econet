# Security and threat model

A private room is private because of access control, not because its
address is hard to guess.

## Credentials

| Credential | Strength | Kept by the service as | Kept by the client in | Lifetime |
|---|---|---|---|---|
| Owner token | 256 bits | SHA-256 | Keychain | The room's |
| Member token | 256 bits | SHA-256 | Keychain | Until removed or the room closes |
| Connection ticket | 256 bits | SHA-256 | Memory | 60 seconds, one use |
| Join code | 55 bits + check | SHA-256 (in the room and the code index) | Shown to the host | 24 hours by default, 20 uses |
| Invitation link | 128-bit secret | SHA-256 | Shown to the host | As its code |

Long-lived credentials go only in `Authorization` headers; the WebSocket
upgrade, which can't carry one, uses a ticket. Credentials are compared in
constant time. None are logged.

## Threats

**Guessing codes.** 55 bits, rate-limited per address (20 lookups a minute
after a burst of 30), expiring and use-limited. An unknown, expired or used
code gets the same answer as one that never existed. There's no listing.

**Token leakage.** A leaked member token lets someone connect as that
member until the host removes them (which disconnects them at once). A
leaked owner token gives control of the room: it never leaves the host's
Keychain except to this service, over TLS. Invitation links are bearer
capabilities: share them as you'd share a door code. The landing page sets
`Referrer-Policy: no-referrer`.

**Spoofing stations.** Every frame's source station must be leased by its
sender's connection, and the frame's own address bytes must match its
header. A guest can't speak as a file server it doesn't hold, or as
another member's machine. Leases are held by the room; a taken number is
refused.

**Malicious frames.** Frames are size-limited and their shapes checked;
the service doesn't interpret their contents. The gateways put only
well-formed frames on their lines, so a remote member can send a BBC
anything a station on its own Econet could: exactly the exposure of a real
network. Immediate operations (remote PEEK, POKE, JSR) are answered by the
BBC's own NFS, under its own protection mask (`*FX` 34 / &0D63); hosts who
don't trust a room shouldn't share machines into it.

**File servers.** A shared file server serves whoever can log on to it,
with its own accounts and passwords. Clients must make sharing a server an
explicit choice, and say that guests can read and write whatever its
accounts allow.

**Denial of service.** Per-connection message and byte rates; room,
participant and station caps; frames to absent stations answered at once
rather than queued; a gateway holds its line at most two seconds. HTTP
endpoints are rate-limited per address.

**Screens.** A machine's screen is only sent if its room's host allows
screen sharing and its owner chooses to share it; both are off unless
turned on. They go on a connection of their own, only to the room's
members, and aren't stored.

**Malicious rooms.** Joining a room exposes only the machines you share to
it, on Econet (and their screens, only if you choose to share them). The
protocol has no way to ask for keyboards, debuggers, files or anything else
on the Mac.

**Untrusted custom services.** A client's credentials are scoped to the
service they came from. An invitation from another service is shown with
its host name and doesn't change the client's default; codes are only ever
looked up on the service the client is set to use.

**Client crashes and skew.** The protocol's version is checked at `hello`
and in every frame; too old a client is told to upgrade. Unknown JSON
fields are ignored.

## What's kept

Rooms' names, descriptions and members' display names, token and
invitation hashes, station leases, and timestamps, for the room's life.
Rate-limit buckets (keyed by a hash of the client address) last minutes.
No traffic is stored. Closing a room deletes it.
