#!/usr/bin/env bash
# Deletes a machine's node from the tailnet through the API, for a machine that can no longer
# run `tailscale logout` itself. Needs TAILSCALE_OAUTH_CLIENT_ID/_SECRET (load_config exports them
# from node-ctl.yaml) for a client with scope devices:core. Only tag:dev nodes are touched, never a laptop that shares the hostname.
#
# Matched on the tailnet-assigned name (the first label of .name, e.g. "dev1" of
# "dev1.tailnet.ts.net"), not the device's raw .hostname: two machines can report the same OS
# hostname (a name collision, e.g. a stale node still holding "dev1" while a rebuilt one runs as
# "dev1-1") and .hostname does not disambiguate them, so filtering on it can delete the wrong node.
set -euo pipefail

api=https://api.tailscale.com/api/v2
# A stalled connection otherwise hangs until the kernel gives up (~2 min) and fails the whole create;
# bound each request and retry it, deletion included (a repeat DELETE is a 404, and a rerun copes).
curl() { command curl "$@" --max-time 30 --retry 3 --retry-all-errors; }
token=$(curl -fsS -d "client_id=$TAILSCALE_OAUTH_CLIENT_ID" -d "client_secret=$TAILSCALE_OAUTH_CLIENT_SECRET" \
  "$api/oauth/token" | jq -r .access_token)
ids=$(curl -fsS -H "Authorization: Bearer $token" "$api/tailnet/-/devices" \
  | jq -r --arg h "$1" '.devices[] | select((.name | split(".")[0]) == $h and (.tags // [] | index("tag:dev"))) | .id')
for id in $ids; do
  curl -fsS -X DELETE -H "Authorization: Bearer $token" "$api/device/$id"
done
