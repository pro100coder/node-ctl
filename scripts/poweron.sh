#!/usr/bin/env bash
# Powers a server on, by name. Terraform stops a machine before changing its type and leaves it
# stopped when Hetzner refuses the new type; nothing in the configuration tracks power state, so
# no apply would ever start it again.
set -euo pipefail
api=https://api.hetzner.cloud/v1
id=$(curl -fsS -H "Authorization: Bearer $HCLOUD_TOKEN" "$api/servers?name=$1" | jq -r '.servers[0].id // empty')
[ -n "$id" ] || { echo "no server named $1" >&2; exit 1; }
curl -fsS -X POST -H "Authorization: Bearer $HCLOUD_TOKEN" "$api/servers/$id/actions/poweron" >/dev/null
