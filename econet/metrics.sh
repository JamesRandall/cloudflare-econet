#!/bin/sh
# The service's counts (GET /v1/admin/metrics), with the admin token from
# .env.local (ADMIN_TOKEN=..., kept out of git).
#
#   ./metrics.sh                     the official service
#   ./metrics.sh https://other.example
set -e
cd "$(dirname "$0")"
service="${1:-https://econet.acornplayground.org}"
if [ ! -f .env.local ]; then
  echo "No .env.local here: put ADMIN_TOKEN=... in it." >&2
  exit 1
fi
token=$(sed -n 's/^ADMIN_TOKEN=//p' .env.local | head -n 1 | tr -d '\r' | sed 's/^["'"'"']//; s/["'"'"']$//')
if [ -z "$token" ]; then
  echo "No ADMIN_TOKEN in .env.local." >&2
  exit 1
fi
response=$(curl -sS -w '\n%{http_code}' -H "Authorization: Bearer $token" "$service/v1/admin/metrics")
status=$(printf '%s' "$response" | tail -n 1)
body=$(printf '%s' "$response" | sed '$d')
case "$status" in
  200)
    if command -v jq >/dev/null 2>&1; then printf '%s\n' "$body" | jq .; else printf '%s\n' "$body"; fi ;;
  404)
    echo "The service didn't accept the token (404): set the same one there with" >&2
    echo "  npx wrangler secret put ADMIN_TOKEN --config ../deploy/wrangler.production.jsonc" >&2
    exit 1 ;;
  *)
    echo "The service answered $status." >&2
    exit 1 ;;
esac
