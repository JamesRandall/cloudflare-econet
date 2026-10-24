# Deployment

The official service is at `https://econet.acornplayground.org`, deployed
from this repository with a production configuration kept alongside the
Acorn Playground deployment assets (its own Worker name, the custom domain,
and `PUBLIC_ORIGIN`). Its steps: tests, `wrangler deploy --config
wrangler.production.jsonc`, then the discovery check and the scripted test
client against the live service.

Anyone else: see [self-hosting.md](self-hosting.md). `wrangler.jsonc` here
deploys to your workers.dev subdomain.

## Environments

Keep production and development apart by Worker name: `wrangler dev` runs
locally (`.wrangler/` state, gitignored); a staging Worker can use its own
configuration file with another name and route. Each Worker has its own
Durable Objects, so rooms never cross.

## Rolling back

`npx wrangler deployments list`, then `npx wrangler rollback`. Durable
Object migrations aren't undone by a rollback: add new tables or columns in
a backward-compatible way (the room creates its tables if they're missing),
and don't roll back across a migration that renames or deletes a class.

## Configuration

| Variable | Meaning |
|---|---|
| `PUBLIC_ORIGIN` | The origin in invitation links and on the landing page. Empty: the request's own. |
| `SERVICE_NAME` | The name in discovery and on the landing page. |

Limits are in `src/protocol.ts` (`LIMITS`) and `src/rate-limits.ts`, and
room lifetimes at the top of `src/rooms/RoomDurableObject.ts`.
