# Self-hosting

Anyone can run their own service, on their own Cloudflare account, without
anything from the official one.

## Deploy

You need a Cloudflare account (the Workers Free plan runs it; Durable
Objects with SQLite storage are available on it) and Node.js 22 or later.

```sh
git clone <this repository>
cd acorn-internet-econet
npm install
npx wrangler login
npx wrangler deploy
```

Wrangler prints the address: `https://acorn-internet-econet.<you>.workers.dev`.
Check it:

```sh
curl https://acorn-internet-econet.<you>.workers.dev/.well-known/acorn-econet
node scripts/test-client.ts https://acorn-internet-econet.<you>.workers.dev
```

### Your own domain

Add a route to `wrangler.jsonc` (the domain must be on your Cloudflare
account), and set `PUBLIC_ORIGIN` so invitation links use it:

```jsonc
"routes": [{ "pattern": "econet.example.org", "custom_domain": true }],
"vars": { "PUBLIC_ORIGIN": "https://econet.example.org", "SERVICE_NAME": "Example Econet" }
```

## Use it from MacBeeb

Settings ▸ Networking ▸ Internet Econet Service: choose **Custom service**,
enter the address, and click **Test Connection**. It checks the service
answers as this protocol and speaks a version MacBeeb does. Rooms made
from then on are on your service, and codes are looked up there.

Credentials are kept per service: switching back to the official service
leaves yours where they are, and an invitation from one never sends
anything to the other.

## Links and codes across deployments

A **link** names its service: opening one shows the service's host name
before joining, and joins there, without changing your setting (MacBeeb
offers to make it the default, separately).

A **code** doesn't: it's looked up on the service you're set to use. If
someone on another deployment reads you a code, it won't be found; MacBeeb
says so and lets you enter their service's address.

## Updating

`git pull`, `npm install`, `npm test`, `npx wrangler deploy`. Durable
Object storage migrations are in `wrangler.jsonc`; a deploy applies them.
Rooms in progress keep running on the old code until their connections
reconnect.
