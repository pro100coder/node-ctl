#!/usr/bin/env bash
# The root disk of a machine, kept as a Hetzner snapshot: it holds /data too, so it is the only copy
# of a stopped machine and a rollback point of a running one (ADR-0016).
#   image.sh create <name>          power the server off, snapshot its disk, print the image id
#   image.sh prune <name> [keep]    delete the machine's snapshots, all but the one to keep
#   image.sh disk <name> [image]    the root disk in GB: the server's, or its snapshot's while stopped
set -euo pipefail
api=https://api.hetzner.cloud/v1
hc() { curl -fsS -H "Authorization: Bearer $HCLOUD_TOKEN" "$@"; }

case ${1:-} in
  prune) # matched by description: the only mark create leaves, so no image needs migrating or labelling
    # ponytail: one page of snapshots; a project with 100+ of them needs pagination here
    hc "$api/images?type=snapshot&per_page=100" \
      | jq -r --arg d "node-ctl ${2?}" --arg k "${3:-}" '.images[] | select(.description == $d and (.id | tostring) != $k) | .id' \
      | while read -r id; do hc -X DELETE "$api/images/$id" >/dev/null; echo "deleted image $id"; done
    exit ;;
  disk)
    hc "$api/servers?name=${2?}" | jq -r '.servers[0].primary_disk_size // empty' | grep . && exit
    [ -n "${3:-}" ] || exit 1
    hc "$api/images/$3" | jq -r '.image.disk_size // empty' | grep .; exit ;;
  create) ;;
  *) echo "usage: image.sh create <name> | prune <name> [keep] | disk <name> [image]" >&2; exit 1 ;;
esac

name=${2?}

# A snapshot only ever starts being written here, and only with the server already off: one left in
# "creating" is a previous create that ran out of patience, so wait for that one instead of paying
# for a second copy of the same disk.
image=$(hc "$api/images?type=snapshot&per_page=100" \
  | jq -r --arg d "node-ctl $name" 'first(.images[] | select(.description == $d and .status == "creating") | .id) // empty')
if [ -n "$image" ]; then
  echo "snapshot $image of $name is still being written; waiting for it" >&2
else
  id=$(hc "$api/servers?name=$name" | jq -r '.servers[0].id // empty')
  [ -n "$id" ] || { echo "no server named $name" >&2; exit 1; }

  # ACPI shutdown first: a snapshot taken with dirty pages in flight is a filesystem to fsck at boot.
  # The server is about to be deleted anyway, so a guest that ignores ACPI gets the plug pulled.
  hc -X POST "$api/servers/$id/actions/shutdown" >/dev/null
  status=''
  for _ in $(seq 1 60); do
    status=$(hc "$api/servers/$id" | jq -r .server.status) || status='' # a dropped request is one more wait, not a failed stop
    [ "$status" != off ] || break
    sleep 5
  done
  [ "$status" = off ] || hc -X POST "$api/servers/$id/actions/poweroff" >/dev/null

  image=$(hc -X POST -H "Content-Type: application/json" \
    -d "{\"type\":\"snapshot\",\"description\":\"node-ctl $name\"}" \
    "$api/servers/$id/actions/create_image" | jq -r '.image.id // empty')
  [ -n "$image" ] || { echo "Hetzner returned no image for $name" >&2; exit 1; }
fi

# Deleting the server while its snapshot is still being written would take the snapshot with it.
# A full disk of some hundred GB takes its time; half an hour is what a stop is allowed to wait.
for _ in $(seq 1 360); do
  [ "$(hc "$api/images/$image" | jq -r .image.status)" != available ] || { echo "$image"; exit 0; }
  sleep 5
done
echo "image $image of $name is still being written; ./node-ctl stop $name waits for it again" >&2
exit 1
