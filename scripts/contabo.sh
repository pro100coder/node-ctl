#!/usr/bin/env bash
# The Contabo API for what its Terraform provider does not model (ADR-0018):
#   contabo.sh image [name]         the id of a standard image (a UUID), ubuntu-24.04 by default
#   contabo.sh power on|off <name>  start or stop the instance whose display name is <name>
#   contabo.sh wait <name>          until that instance has finished provisioning (running or stopped)
# An instance is a monthly contract, so ./node-ctl stop powers it off instead of deleting it.
# Credentials come from the environment under the names the Terraform provider reads:
# CNTB_OAUTH2_CLIENT_ID, CNTB_OAUTH2_CLIENT_SECRET, CNTB_OAUTH2_USER, CNTB_OAUTH2_PASS.
set -euo pipefail
api=${CNTB_API:-https://api.contabo.com}
auth=${CNTB_OAUTH2_TOKEN_URL:-https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token}

token() { # a token lives minutes, and a wait for a new instance can take longer
  TOKEN=$(curl -fsS -X POST \
    --data-urlencode grant_type=password \
    --data-urlencode "client_id=${CNTB_OAUTH2_CLIENT_ID:-}" \
    --data-urlencode "client_secret=${CNTB_OAUTH2_CLIENT_SECRET:-}" \
    --data-urlencode "username=${CNTB_OAUTH2_USER:-}" \
    --data-urlencode "password=${CNTB_OAUTH2_PASS:-}" \
    "$auth" | jq -r '.access_token // empty')
  [ -n "$TOKEN" ] || { echo "Contabo refused the credentials: no access token" >&2; exit 1; }
}
token

# Every request needs its own x-request-id (a uuid4), which is also what Contabo support asks for.
cn() { curl -fsS -H "Authorization: Bearer $TOKEN" -H "x-request-id: $(uuidgen)" -H "Content-Type: application/json" "$@"; }

case ${1:-} in
  image)
    name=${2:-ubuntu-24.04}
    id=$(cn "$api/v1/compute/images?standardImage=true&size=100&name=$name" \
      | jq -r --arg n "$name" 'first(.data[] | select(.name == $n) | .imageId) // empty')
    [ -n "$id" ] || { echo "Contabo has no standard image named $name" >&2; exit 1; }
    echo "$id" ;;
  power)
    case ${2:-} in on) action=start ;; off) action=stop ;; *) echo "usage: contabo.sh power on|off <name>" >&2; exit 1 ;; esac
    name=${3?}
    # The display name is what Terraform sets to the machine's name; the OS hostname is cloud-init's.
    id=$(cn "$api/v1/compute/instances?size=100&displayName=$name" \
      | jq -r --arg n "$name" 'first(.data[] | select(.displayName == $n) | .instanceId) // empty')
    [ -n "$id" ] || { echo "no Contabo instance named $name" >&2; exit 1; }
    cn -X POST "$api/v1/compute/instances/$id/actions/$action" >/dev/null ;;
  wait)
    # A new instance provisions for minutes, and until it is done a firewall is refused with
    # 402 Payment required: the firewall add-on (free, but part of the contract) is not on it yet.
    # It arrives after the status already says running, so the add-on list is waited for too.
    # ponytail: any add-on counts, node-ctl orders none itself; match the firewall's id if one ever is.
    name=${2?}
    for _ in $(seq 1 90); do
      status=$(cn "$api/v1/compute/instances?size=100&displayName=$name" \
        | jq -r --arg n "$name" 'first(.data[] | select(.displayName == $n)
            | if (.addOns // []) == [] and (.status == "running" or .status == "stopped") then "waiting for its firewall add-on" else .status end) // empty')
      case $status in running | stopped) exit 0 ;; esac
      sleep 10
      token
    done
    echo "the Contabo instance $name is still ${status:-not found} after 15 minutes" >&2
    exit 1 ;;
  *) echo "usage: contabo.sh image [name] | power on|off <name> | wait <name>" >&2; exit 1 ;;
esac
