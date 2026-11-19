#!/usr/bin/env bash
# Hetzner server types as menu rows "name<TAB>cores<TAB>ram<TAB>cpu<TAB>disk<TAB>price<TAB>last", cheapest first.
#   server-types.sh create                          what a new machine can be: last = the locations
#                                                   that will create one now, price = the cheapest of theirs
#   server-types.sh move <location> <type> [disk]   what a machine could run as next: every type of its
#                                                   architecture sold in its location; last = yes|no, whether
#                                                   Hetzner will put it there now and it holds the disk (GB,
#                                                   default: its type's; a disk never shrinks)
# server_types[].locations[].available is the one answer Hetzner gives for both a resize and a create.
# A price predicts neither — the whole CX line is priced in fsn1, hel1 and nbg1 and sold in none of
# them — and /datacenters with its available/available_for_migration lists is gone (410 since
# 2026-10-01), though it offered every CAX type a create then refused. It is an indicator, not a
# promise, and a menu, not a gate: refused types stay in the move list, marked, and --type and
# --location go straight to Terraform, so a type the create list hides can still be asked for by name.
set -euo pipefail

case ${1:-} in
  create)
    filter='
    .server_types[] | select(.deprecation == null) | . as $s
    | [ $s.locations[] | select(.available) | .name ] as $where
    | [ $s.prices[] | select(.location as $l | $where | index($l)) ] as $p
    | select($p | length > 0)
    | { name: $s.name, cores: $s.cores, memory: $s.memory, cpu: $s.cpu_type, disk: $s.disk,
        price: ([ $p[].price_monthly.gross | tonumber ] | min * 100 | round / 100),
        last: ([ $p[].location ] | sort | join(",")) }' ;;
  move)
    filter='
    (.server_types | map(select(.name == $cur)) | first) as $now
    | if $now == null then error("unknown server type: \($cur)") else . end
    | (if $disk == "" then $now.disk else ($disk | tonumber) end) as $have
    | .server_types[] as $s
    | select($s.architecture == $now.architecture) # an x86 machine cannot migrate to ARM
    | $s.prices[] | select(.location == $loc)
    | { name: $s.name, cores: $s.cores, memory: $s.memory, cpu: $s.cpu_type, disk: $s.disk,
        price: (.price_monthly.gross | tonumber * 100 | round / 100),
        last: (if any($s.locations[]?; .available and .name == $loc) and $s.disk >= $have then "yes" else "no" end) }' ;;
  *) echo "usage: server-types.sh create | move <location> <type> [disk]" >&2; exit 1 ;;
esac

curl -fsS -H "Authorization: Bearer $HCLOUD_TOKEN" "https://api.hetzner.cloud/v1/server_types?per_page=100" |
  jq -r --arg loc "${2:-}" --arg cur "${3:-}" --arg disk "${4:-}" \
    "[ $filter ] | sort_by(.price)[] | [ .name, .cores, .memory, .cpu, .disk, .price, .last ] | @tsv"
