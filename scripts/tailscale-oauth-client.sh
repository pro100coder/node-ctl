#!/usr/bin/env bash
# Creates the Tailscale OAuth client the module needs (scopes auth_keys and devices:core, tag:dev) and allows the tag
# in the policy. Needs TS_API_KEY, a personal API access token (admin console → Settings → Keys).
# Prints the pair as TAILSCALE_OAUTH_CLIENT_ID=/..._SECRET= lines, which `./node-ctl init tailscale` parses.
set -euo pipefail

api=https://api.tailscale.com/api/v2/tailnet/-
ts() { curl -fsS -u "$TS_API_KEY:" -H 'Content-Type: application/json' -H 'Accept: application/json' "$@"; }

# Rewrites the policy as plain JSON, so comments of a HuJSON policy are lost.
ts "$api/acl" | jq '.tagOwners["tag:dev"] = ["autogroup:admin"]' | ts --data-binary @- "$api/acl" >/dev/null
ts "$api/keys" -d '{"keyType":"client","scopes":["auth_keys","devices:core"],"tags":["tag:dev"],"description":"node-ctl"}' \
  | jq -r '"TAILSCALE_OAUTH_CLIENT_ID=\(.id)\nTAILSCALE_OAUTH_CLIENT_SECRET=\(.key)"'
