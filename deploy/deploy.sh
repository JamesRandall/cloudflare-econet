#!/bin/sh
# Tests, then deploys the official service to econet.acornplayground.org,
# then checks it answers. Needs `npx wrangler login` once, on an account
# with acornplayground.org.
set -e
cd "$(dirname "$0")/../econet"
npm ci
npm test
npx tsc --noEmit -p . && npx tsc --noEmit -p test
npx wrangler deploy --config ../deploy/wrangler.production.jsonc
curl -fsS https://econet.acornplayground.org/.well-known/acorn-econet
echo
node scripts/test-client.ts https://econet.acornplayground.org
