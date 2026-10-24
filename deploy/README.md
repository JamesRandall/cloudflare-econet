# Deploying econet.acornplayground.org

The official Internet Econet service: the code in `../econet`, deployed
with `wrangler.production.jsonc` here (its own Worker name, the custom
domain, and `PUBLIC_ORIGIN` for invitation links).

## First time

1. `acornplayground.org` must be a zone on the Cloudflare account.
2. `cd ../econet && npx wrangler login`
3. `./deploy.sh`: runs the tests, deploys, creates the custom domain's DNS
   record and certificate (Wrangler does this for `custom_domain` routes),
   then checks the service and runs the scripted test client against it.

## Updating

`./deploy.sh` again. Rooms in progress carry on; their connections pick up
the new code when they reconnect.

## Rolling back

`npx wrangler rollback --config ../deploy/wrangler.production.jsonc`
returns to the previous version (`npx wrangler deployments list` shows
them). Don't roll back across a Durable Object storage migration.

## Secrets

Only `ADMIN_TOKEN`, for the operator's counts (`econet/metrics.sh` reads
it from `econet/.env.local`, which isn't committed). Room credentials are
made per room.
