# Acorn Internet Econet

Econet over the Internet, for Acorn emulators. Someone makes a room and
shares a link or a short code (`ACRN-7K42-P9M5-Q3S8`); someone else joins
from their own Mac, and the BBC Micros on each appear on the other's
network, talking to each other with Acorn's own network software: file
servers, printer servers, `*NET` and `*I AM`, programs passing messages.
No accounts, port-forwarding or network settings.

The service in the middle is a Cloudflare Worker and
Durable Objects, in TypeScript, under the GNU AGPLv3. It's independent
of any emulator. [MacBeeb](https://github.com/jamesrandall/macbeeb)
(BBC Micro) is its first client; MacArch (Archimedes) is planned. The
protocol is published here so anyone can write another.

## What's here

- `econet/`: the service's code, tests, documents and protocol schemas.
- `deploy/`: how the official service at econet.acornplayground.org
  is deployed (its Wrangler configuration and `deploy.sh`).

## What it carries, and what it doesn't

It carries Econet frames between the gateways in each emulator, and
manages rooms: who's in them, invitations, and which station number is
whose. It checks each frame's addresses against the stations its sender
holds, and passes it on.

It doesn't run any BBC or Archimedes code, serve files, render screens,
or look inside frames beyond their addresses. It keeps no traffic. Sharing
a machine on Econet shares nothing else: no screens, keyboards, debuggers
or files on the host Mac.

Timing is the hard part: Econet's handshake wants an answer within
microseconds, and the Internet takes milliseconds. The emulators' gateways
handle that, holding their lines while a frame crosses, so every
acknowledgement a BBC sees came from its real destination. See
[docs/protocol.md](econet/docs/protocol.md).

## Quick start

```sh
cd econet
npm install
npm test                     # the service, in Cloudflare's runtime
npm run dev                  # a local service at http://localhost:8787
node scripts/test-client.ts  # two scripted clients, against it
```

## Deploying

`econet/wrangler.jsonc` deploys to your own workers.dev subdomain as it is:

```sh
cd econet
npx wrangler login
npx wrangler deploy
```

Then point MacBeeb at it (Settings ▸ Networking ▸ Internet Econet Service).
No other services are needed: Durable Objects hold everything. See
[self-hosting](econet/docs/self-hosting.md), and for the official
deployment [deployment](econet/docs/deployment.md) and
[deploy](deploy/README.md).

## Costs and limits to watch

Each room is a Durable Object; connections hibernate between messages, so
an idle room costs nearly nothing (and heartbeats are answered without
waking it). Traffic is charged per WebSocket message and Durable Object
request: an Econet transaction is two to four messages each way. A busy
file transfer between two machines is in the region of a few hundred
messages a second while it lasts. Per-connection limits (400 messages and
256KB a second) and per-room ones (2000 and 1MB, adjustable) stop a runaway
program costing much; the operator's counts are behind an admin token. See
[docs/operations.md](econet/docs/operations.md).

## Documents

- [Architecture](econet/docs/architecture.md)
- [Protocol](econet/docs/protocol.md), with schemas in `econet/protocol/v1` and test
  vectors in `econet/protocol/fixtures`
- [Security and threat model](econet/docs/security.md)
- [Compatibility](econet/docs/compatibility.md): what works with Acorn's
  software, and how it differs from AUN
- [Self-hosting](econet/docs/self-hosting.md) and [deployment](econet/docs/deployment.md)
- [Operations](econet/docs/operations.md)

Public room directories are planned (phase 2), and not here yet.

## Licence

Copyright (C) 2026 James Randall

This program is free software: you can redistribute it and/or modify it
under the terms of the GNU Affero General Public License, version 3, as
published by the Free Software Foundation. It is distributed in the hope
that it will be useful, but without any warranty; see [LICENSE](LICENSE)
for details.
