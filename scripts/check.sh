#!/usr/bin/env bash
# Credential checks against the real APIs, run by `./node-ctl check` and `./node-ctl init`. Optional argument limits the run to one group: hetzner | contabo | tailscale | restic.
# Every probe is an action under NODE_CTL_PARENT; the events go to stdout, the caller feeds the renderer.
set -euo pipefail
# shellcheck source=scripts/ui.sh
. "$(dirname "$0")/ui.sh"
exec 3>&1
PARENT=${NODE_CTL_PARENT:-}

check() { # check <id> <key> <name> <command ...>: stderr of a failing command is the reason
  local id=$1 key=$2 name=$3 out
  shift 3
  emit_event "$id" "$PARENT" "$name" "$key" "" "" started
  if out=$("$@" 2>&1 >/dev/null); then
    emit_event "$id" "$PARENT" "$name" "$key" "" "" completed
  else
    emit_event "$id" "$PARENT" "$name" "$key" "" "" failed "\"message\":$(json_str "$out")"
    return 1
  fi
}

restic_configured() { # archives are optional: any empty variable in the group means "no archives"
  local v
  for v in RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do [ -n "${!v:-}" ] || return 1; done
}

# shellcheck disable=SC2317,SC2329 # called through check()
restic_repo() { # an empty repository is expected before the first backup; initialising it is the check
  restic cat config >/dev/null 2>&1 || restic init >/dev/null
}

# shellcheck disable=SC2317,SC2329 # called through check()
contabo_account() { # contabo_account <client id> <client secret> <api user> <api password>
  # The same OAuth2 password grant the Terraform provider does, then one call to the API the token
  # is for: a client that authenticates but cannot list instances is not a working account.
  local token
  token=$(curl -fsS -X POST --data-urlencode grant_type=password --data-urlencode "client_id=$1" \
    --data-urlencode "client_secret=$2" --data-urlencode "username=$3" --data-urlencode "password=$4" \
    "${CNTB_OAUTH2_TOKEN_URL:-https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token}" \
    | jq -r '.access_token // empty')
  [ -n "$token" ] || { echo "no access token: the Client ID, Client Secret, API Username or its password is wrong (panel -> Account -> Security & Access)" >&2; return 1; }
  curl -fsS -H "Authorization: Bearer $token" -H "x-request-id: $(uuidgen)" \
    "${CNTB_API:-https://api.contabo.com}/v1/compute/instances?size=1" >/dev/null \
    || { echo "the token does not reach the compute API" >&2; return 1; }
}

# shellcheck disable=SC2317,SC2329 # called through check()
tailscale_client() { # auth keys (tskey-auth-...) are the usual mix-up: the API answers 401 for them
  case $TAILSCALE_OAUTH_CLIENT_ID:$TAILSCALE_OAUTH_CLIENT_SECRET in
    tskey-*:*) echo "the client id is a tskey-* key, but an OAuth client id looks like k1a2b3c4CNTRL" >&2; return 1 ;;
    *:tskey-client-*) ;;
    *) echo "the secret must start with tskey-client-; an auth key from Settings -> Keys is not an OAuth client" >&2; return 1 ;;
  esac
  local api=https://api.tailscale.com/api/v2 token id
  token=$(curl -fsS -d "client_id=$TAILSCALE_OAUTH_CLIENT_ID" -d "client_secret=$TAILSCALE_OAUTH_CLIENT_SECRET" \
    "$api/oauth/token" | jq -r .access_token)
  # A token proves nothing about the tag: mint the key Terraform will mint and throw it away, so a
  # missing tagOwners entry or a client generated without tag:dev fails here instead of in apply.
  id=$(curl -fsS -H "Authorization: Bearer $token" -H 'Content-Type: application/json' "$api/tailnet/-/keys" \
    -d '{"capabilities":{"devices":{"create":{"tags":["tag:dev"],"ephemeral":true}}},"expirySeconds":60,"description":"node-ctl check"}' \
    | jq -r .id) \
    || { echo "the client cannot mint a tag:dev key: allow the tag (tagOwners) and generate the client with tag:dev, or leave the client id empty in init" >&2; return 1; }
  curl -fsS -X DELETE -H "Authorization: Bearer $token" "$api/tailnet/-/keys/$id"
  # stop/destroy delete the node through the API when the machine cannot log itself out
  curl -fsS -H "Authorization: Bearer $token" "$api/tailnet/-/devices" >/dev/null \
    || { echo "the client cannot list devices: regenerate it with scope devices:core (write) as well, or leave the client id empty in init" >&2; return 1; }
}

# The probes are independent network round-trips: they run at once, each as its own action.
# (if, not case ;;&: the host bash on macOS is 3.2)
pids='' fail=0 group=${1:-all}
wants() { [ "$group" = "$1" ] || [ "$group" = all ]; }
if wants hetzner; then # one probe per account: NODE_CTL_ACCOUNTS is the .hetzner map of node-ctl.yaml (tag -> token)
  [ -n "${NODE_CTL_ACCOUNTS:-}" ] || NODE_CTL_ACCOUNTS='{}'
  while IFS=$'\t' read -r tag token; do
    check "c1-$tag" hetzner "Hetzner token ($tag)" curl -fsS -H "Authorization: Bearer $token" "https://api.hetzner.cloud/v1/servers?per_page=1" &
    pids="$pids $!"
  done < <(jq -r 'to_entries[] | [.key, .value] | @tsv' <<< "$NODE_CTL_ACCOUNTS")
fi
if wants tailscale; then
  check c2 tailscale "Tailscale OAuth client" tailscale_client &
  pids="$pids $!"
fi
if wants restic; then
  if ! restic_configured; then
    emit_event c3 "$PARENT" "restic repository" restic "" "" started
    emit_event c3 "$PARENT" "restic repository" restic "" "" completed '"message":"archives disabled"'
  elif ! command -v restic >/dev/null; then
    emit_event c3 "$PARENT" "restic repository" restic "" "" started
    emit_event c3 "$PARENT" "restic repository" restic "" "" failed '"message":"restic is not installed on this host (brew install restic)"'
    fail=1
  else
    check c3 restic "restic repository" restic_repo &
    pids="$pids $!"
  fi
fi
if wants contabo; then # one probe per Contabo account: NODE_CTL_CONTABO is the .contabo map of node-ctl.yaml
  [ -n "${NODE_CTL_CONTABO:-}" ] || NODE_CTL_CONTABO='{}'
  while IFS=$'\t' read -r tag id secret user password; do
    check "c4-$tag" contabo "Contabo credentials ($tag)" contabo_account "$id" "$secret" "$user" "$password" &
    pids="$pids $!"
  done < <(jq -r 'to_entries[] | [.key, (.value.client_id // ""), (.value.client_secret // ""),
                                 (.value.user // ""), (.value.password // "")] | @tsv' <<< "$NODE_CTL_CONTABO")
fi
for p in $pids; do wait "$p" || fail=1; done
exit $fail
