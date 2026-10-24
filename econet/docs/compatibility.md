# Compatibility

## With Acorn's software

Tested through MacBeeb's gateway, between two separate Econet networks
joined through a room (with 0 to 250ms of latency each way), all with
Acorn's own ROMs and servers, unmodified:

| What | Machines | Result |
|---|---|---|
| OSWORD &10 transmit to OSWORD &11 receive | Model B (DNFS) to Model B | ✓ at 0, 20, 80 and 250ms |
| "Not listening" when nobody's listening | Model B to Model B | ✓ |
| Immediate POKE then JSR | Model B to Model B | ✓ |
| Immediate PEEK and machine type | Model B to Master 128 (ANFS 4.25) | ✓ |
| Acorn Level 2 file server: log on, wrong password, save, `*ACCESS`, `*CAT`, load another user's file, save refused ("Insufficient access") | Model B and Master 128 clients, server on the other network | ✓ at 80ms |

| MacBeeb's printer server (BBC BASIC): `*FX5,4`, `VDU 2`, print, `VDU 3` | Model B client | ✓ at 80ms |
| Level 2: `*SAVE` and `*LOAD` of 1K, byte for byte | Model B client | ✓ at 20–150ms, varying |
| A message lost mid-transaction: the transaction fails, the next succeeds | Model B client, Level 2 | ✓ |
| Two MacBeeb processes, through this service (`wrangler dev`): a guest's Model B logs on to the host's Level 2 server and catalogues | Model B, Level 2 | ✓ |

Not yet tested across the Internet: Level 1 file server, broadcasts with
real software, ANFS sending immediate operations, RISC OS (MacArch).

(The tests are in MacBeeb's `EconetGatewayTests`.)

### What a station notices

- Time: each frame after the scout costs a round trip. A file server
  request is two transactions; at 80ms each way, about 0.6 seconds.
- The line is held while a frame crosses: other stations on the same local
  line wait for it (as they would for a slow station).
- A gateway takes one transaction at a time; a second, arriving
  meanwhile, is refused as "not listening", and NFS tries again.
- A line is held at most two seconds; past that the sender sees the line
  go quiet ("not listening" or "net error", as for a station that stopped
  answering).

## With AUN

This protocol is **not** AUN, and doesn't connect to AUN equipment or
software. The two meet at the same level: Econet operations between
stations, with transport between gateways. To bridge them, a gateway would
map:

| Here | AUN |
|---|---|
| A transaction's scout and data (stages 0 and 2) | One AUN Data packet (port, control, data) |
| The data's acknowledgement (final) | AUN Ack |
| NoReply after the scout | AUN NAK, or no answer |
| Immediate operations (port 0) | AUN Immediate and Immediate Reply |
| Broadcast | AUN Broadcast |
| Station numbers in a room (network 0) | Network.station, the room as one network |
| Transaction id | AUN sequence number |

Because this protocol carries each handshake frame and AUN carries
operations, an AUN bridge would answer scouts itself and forward the
data, as AUN's own Econet bridges do. That isn't built or tested.
