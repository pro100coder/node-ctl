#!/usr/bin/env bash
# Shared by ./node-ctl and scripts/: colour for the list table, and
# the event line every action emits. fd 3 is the renderer's stdin (see docs/adr/0010); the fields
# a producer leaves out (seq, timestamp, duration) are filled in by progress/src/cli.ts.
if [ "${NODE_CTL_COLOR:-}" = 1 ]; then
  B=$'\e[1m' D=$'\e[2m' N=$'\e[0m'
else
  # shellcheck disable=SC2034 # used by the list table in node-ctl
  B='' D='' N=''
fi

json_str() { # json_str <text>: a JSON string literal
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/}
  s=${s//$'\e'/} # ponytail: ESC alone is dropped, the rest of a colour code stays; nothing we run prints colour without a tty
  printf '"%s"' "$s"
}

slug() { # slug <name>: the first word, lowercase, as a short label
  local s
  s=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-')
  s=${s#-}
  s=${s%%-*}
  printf '%s' "${s:-action}"
}

emit_event() { # emit_event <id> <parent|""> <name> <key> <index|""> <total|""> <type> [extra json fields]
  local parent=null index=''
  [ -z "$2" ] || parent="\"$2\""
  [ -z "$5" ] || index=",\"index\":$5,\"total_steps\":$6"
  printf '{"action_id":"%s","parent_action_id":%s,"action_name":%s,"key":"%s"%s,"event_type":"%s"%s}\n' \
    "$1" "$parent" "$(json_str "$3")" "$4" "$index" "$7" "${8:+,$8}" >&3
}
