#!/usr/bin/env bats
# node-ctl against stubbed terraform/ssh and a test HTTP server: inventory edits, command ordering, rendered remote scripts.

# The suite drives the compiled binary: setup_file builds dist/node-ctl once per run (not when no source is
# newer than it) and tests/stubs/node-ctl-bin runs it against tests/stubs/http-server.ts. NODE_CTL_BIN
# points the same suite at another binary (a release, say).
setup_file() {
  local root=$BATS_TEST_DIRNAME/..
  if [ -z "${NODE_CTL_BIN:-}" ]; then
    NODE_CTL_BIN=$root/dist/node-ctl
    if [ ! -x "$NODE_CTL_BIN" ] || [ -n "$(find "$root/src" "$root/scripts" "$root/terraform" "$root/skills" "$root/package.json" "$root/bun.lock" -type f -newer "$NODE_CTL_BIN" 2>/dev/null | head -1)" ]; then
      (cd "$root" && bun run build) >"$BATS_FILE_TMPDIR/build.log" 2>&1 || { cat "$BATS_FILE_TMPDIR/build.log" >&2; return 1; }
    fi
  fi
  case $NODE_CTL_BIN in /*) ;; *) NODE_CTL_BIN=$PWD/$NODE_CTL_BIN ;; esac
  export NODE_CTL_BIN
}

setup() {
  # the caller's shell may export credentials or colour settings; tests must never see them
  unset HCLOUD_TOKEN TAILSCALE_OAUTH_CLIENT_ID TAILSCALE_OAUTH_CLIENT_SECRET \
        RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY TS_API_KEY FORCE_COLOR NO_COLOR NODE_CTL_COLOR CI \
        NODE_CTL_SELF NODE_CTL_BIN_DIR NODE_CTL_UNAME_S NODE_CTL_UNAME_M
  export SERVERS_DIR="$BATS_TEST_TMPDIR/servers"
  export NODE_CTL_CONFIG="$BATS_TEST_TMPDIR/node-ctl.yaml" # never the repo's own node-ctl.yaml
  export STUB_LOG="$BATS_TEST_TMPDIR/stub.log"
  export NODE_CTL_LOG="$BATS_TEST_TMPDIR/node-ctl.log"
  export STUB_EVENTS="$BATS_TEST_TMPDIR/events.jsonl"
  export SSH_PUBLIC_KEY_FILE="$BATS_TEST_TMPDIR/key.pub"
  export SSH_DIR="$BATS_TEST_TMPDIR/ssh" # never the caller's own ~/.ssh
  export ORCA_PROFILES="$BATS_TEST_TMPDIR/orca" # never the caller's own Orca host-key stores
  export SKILLS_DIR="$BATS_TEST_TMPDIR/skills" # never the caller's own ~/.claude/skills
  export CLAUDE_DIR="$BATS_TEST_TMPDIR/claude" # never the caller's own ~/.claude
  export CLAUDE_JSON="$BATS_TEST_TMPDIR/claude.json" # never the caller's own MCP servers
  export LAUNCH_AGENTS="$BATS_TEST_TMPDIR/agents" # never the caller's own launchd jobs
  mkdir -p "$CLAUDE_DIR"
  echo "GLOBAL-TEST-INSTRUCTIONS" > "$CLAUDE_DIR/CLAUDE.md"
  echo "ssh-ed25519 AAAA test" > "$SSH_PUBLIC_KEY_FILE"
  export GIT_KEY_FILE="$BATS_TEST_TMPDIR/node-ctl_user_ed25519" # never the repo's own keys/
  echo "PRIVATE-TEST-KEY" > "$GIT_KEY_FILE"
  echo "ssh-ed25519 AAAAgit node-ctl-user commit key" > "$GIT_KEY_FILE.pub"
  export PATH="$BATS_TEST_DIRNAME/stubs:$PATH"
  export NODE_CTL_HOME="$BATS_TEST_TMPDIR/home" # never the caller's own ~/.node-ctl
  RAE="$BATS_TEST_DIRNAME/stubs/node-ctl-bin" # the binary, through the wrapper that gives it a test HTTP server
  PTY="$BATS_TEST_DIRNAME/pty" # runs a command on a terminal, which BSD and util-linux script(1) start differently
  : > "$STUB_LOG"
  # A complete configuration: one Hetzner account (stop/start/resize call its API, the test server
  # answers), a working OAuth client (create/start free the tailnet name through the Tailscale API) and
  # archive storage; check/init tests edit it for the missing/rejected paths.
  config
}

config() { # config [yq expression ...]: the complete configuration, then edits (e.g. '.hetzner = {}')
  local e
  printf 'hetzner:\n  main: t\ntailscale:\n  client_id: i\n  client_secret: tskey-client-s\nssh_public_key_file: %s\nrestic:\n  repository: s3:test\n  password: p w\n  access_key_id: id\n  secret_access_key: secret\n' "$SSH_PUBLIC_KEY_FILE" > "$NODE_CTL_CONFIG"
  for e in "$@"; do yq -i "$e" "$NODE_CTL_CONFIG"; done
}
cfg() { yq "$1" "$NODE_CTL_CONFIG"; } # a value of the configuration the CLI wrote

inv() { jq -r "${@:2}" "$SERVERS_DIR/$1.json"; }
line_of() { grep -n -F -- "$1" "$STUB_LOG" | tail -1 | cut -d: -f1; }
ev() { jq -cr "$1" "$STUB_EVENTS"; } # the JSON events of the run (NODE_CTL_EVENTS)
id_of() { ev "select(.event_type == \"started\" and .action_name == \"$1\") | .action_id" | head -1; }
said() { [[ "$output $(ev '.message // empty' | paste -s -d " " -)" == *"$1"* ]]; } # in what it printed or in what an action reported
macos_only() { [ "$(uname)" = Darwin ] || skip "launchd and BSD date are macOS only"; } # the Linux timer has its own tests

@test "create writes the inventory entry with defaults, applies and waits" {
  run "$RAE" create dev1
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .state)" = running ]
  [ "$(inv dev1 .type)" = cx23 ]
  [ "$(inv dev1 -c .open_ports)" = "[22]" ]
  [ "$(inv dev1 -c .funnel)" = "{}" ]
  grep -q "terraform: -chdir=terraform apply -input=false -no-color -auto-approve" "$STUB_LOG"
  grep -q "node-ctl-user@dev1 sudo cloud-init status --wait" "$STUB_LOG"
  [[ $output == *"ready: node-ctl ssh dev1"* ]] || false
}

@test "create honours options" {
  "$RAE" create dev1
  run "$RAE" create dev2 --type=cx33 --size 40 --ports 80,22,443
  [ "$status" -eq 0 ]
  [ "$(inv dev2 .type)" = cx33 ]
  [ "$(inv dev2 .volume_size)" = 40 ]
  [ "$(inv dev2 -c .open_ports)" = "[22,80,443]" ]
  "$RAE" create dev3 --ports "80 22" # the quoted form still works
  [ "$(inv dev3 -c .open_ports)" = "[22,80]" ]
}

@test "create adds a volume only when asked: off a terminal there is no question, --size 0 says no" {
  "$RAE" create dev1 # stdin is not a terminal here: no prompt, no volume
  [ "$(inv dev1 -c 'has("volume_size")')" = false ]
  "$RAE" create dev2 --size 0
  [ "$(inv dev2 -c 'has("volume_size")')" = false ]
  "$RAE" create dev3 --size 30
  [ "$(inv dev3 .volume_size)" = 30 ]
}

@test "create validates options before writing the inventory" {
  run "$RAE" create dev1 --size big
  [ "$status" -eq 1 ]
  [[ $output == *"not a volume size"* ]] || false
  [ ! -e "$SERVERS_DIR/dev1.json" ]
  run "$RAE" create dev1 --size
  [ "$status" -eq 1 ]
  [[ $output == *"--size needs a value"* ]] || false
  run "$RAE" create dev1 --colour red
  [ "$status" -eq 1 ]
  [[ $output == *"unknown option: --colour"* ]] || false
}

@test "create refuses options for a machine that already exists instead of ignoring them" {
  "$RAE" create dev1 --size 20
  "$RAE" stop dev1
  run "$RAE" create dev1 --size 50
  [ "$status" -eq 1 ]
  [[ $output == *"dev1 exists"*"destroy dev1"* ]] || false
  [ "$(inv dev1 .volume_size)" = 20 ]
  run "$RAE" create dev1 # without options it is a start
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .state)" = running ]
  run "$RAE" create dev1
  [ "$status" -eq 1 ]
  [[ $output == *"already running"* ]] || false
}

@test "create and start free the tailnet name before applying, in case a stale node squats it" {
  run "$RAE" create dev1
  [ "$status" -eq 0 ]
  [ "$(line_of 'tailnet/-/devices')" -lt "$(line_of 'terraform: -chdir=terraform apply')" ]
  "$RAE" stop dev1
  : > "$STUB_LOG"
  run "$RAE" start dev1
  [ "$status" -eq 0 ]
  [ "$(line_of 'tailnet/-/devices')" -lt "$(line_of 'terraform: -chdir=terraform apply')" ]
}

@test "restore frees the tailnet name of a machine it builds again, not of a powered-off Contabo one" {
  contabo
  devices='{"access_token":"at","devices":[{"id":"111","name":"dev1.tail.ts.net","hostname":"dev1","tags":["tag:dev"]}]}'
  mkdir -p "$SERVERS_DIR"
  echo '{"state":"archived","account":"main","open_ports":[22],"funnel":{}}' > "$SERVERS_DIR/dev1.json"
  STUB_CURL_BODY=$devices run "$RAE" restore dev1 # the archived node left the tailnet but still holds the name
  [ "$status" -eq 0 ]
  grep -q "http: DELETE .*api/v2/device/111" "$STUB_LOG"
  [ "$(line_of 'device/111')" -lt "$(line_of 'terraform: -chdir=terraform apply')" ]
  "$RAE" stop dev1; : > "$STUB_LOG"
  run "$RAE" restore dev1 # a Hetzner start boots a new VPS, as start does
  [ "$status" -eq 0 ]
  [ "$(line_of 'tailnet/-/devices')" -lt "$(line_of 'terraform: -chdir=terraform apply')" ]
  "$RAE" create cb1 --account cb; "$RAE" stop cb1; : > "$STUB_LOG"
  run "$RAE" restore cb1 # powered off: its node and name are its own
  [ "$status" -eq 0 ]
  ! grep -q "tailnet/-/devices" "$STUB_LOG" || false
}

@test "create deletes a device already squatting the name before provisioning the new one" {
  devices='{"access_token":"at","devices":[{"id":"111","name":"dev1.tail.ts.net","hostname":"dev1","tags":["tag:dev"]}]}'
  STUB_CURL_BODY=$devices run "$RAE" create dev1
  [ "$status" -eq 0 ]
  grep -q "http: DELETE .*api/v2/device/111" "$STUB_LOG"
  [ "$(line_of 'device/111')" -lt "$(line_of 'terraform: -chdir=terraform apply')" ]
  [ "$(grep -c "http: .*api.tailscale.com" "$STUB_LOG")" -eq 3 ] # token, list, delete (a stall must not hang create: the timeout of each call is a unit test)
}

@test "create never deletes a live node that only shares the raw OS hostname under a different tailnet name" {
  # a name collision from a past leave_tailnet race: a dead "dev1" node still squats the name while
  # a live, working machine ended up registered as "dev1-1" (same OS hostname, deduped tailnet name)
  devices='{"access_token":"at","devices":[
    {"id":"111","name":"dev1.tail.ts.net","hostname":"dev1","tags":["tag:dev"]},
    {"id":"444","name":"dev1-1.tail.ts.net","hostname":"dev1","tags":["tag:dev"]}
  ]}'
  STUB_CURL_BODY=$devices run "$RAE" create dev1
  [ "$status" -eq 0 ]
  grep -q "http: DELETE .*api/v2/device/111" "$STUB_LOG"
  ! grep -q "device/444" "$STUB_LOG" || false # dev1-1 is a different, live node: never touch it
}

@test "create refuses to provision when the tailnet name cannot be confirmed free" {
  STUB_FAIL=curl run "$RAE" create dev1
  [ "$status" -eq 1 ]
  [[ $output == *"could not confirm dev1 is free on the tailnet"* ]] || false
  ! grep -q "terraform: -chdir=terraform apply" "$STUB_LOG" || false
  [ ! -e "$SERVERS_DIR/dev1.json" ] # nothing written: the same command retries cleanly
  run "$RAE" create dev1
  [ "$status" -eq 0 ]
}

@test "a missing argument is a usage error with exit 1" {
  for c in start destroy ports expose backup archive restore ssh volume; do
    run "$RAE" $c
    [ "$status" -eq 1 ]
    [[ $output == "node-ctl: usage: node-ctl $c <name"* ]] || false
  done
  run "$RAE" create
  [ "$status" -eq 1 ]
  [[ $output == "node-ctl: usage: node-ctl create <name>"* ]] || false
}

@test "help goes to stdout with exit 0, version answers" {
  for h in --help -h help; do
    run bash -c "'$RAE' $h 2>/dev/null"
    [ "$status" -eq 0 ]
    [[ $output == "usage: node-ctl "*"NODE_CTL_LOG"* ]] || false
  done
  run "$RAE" --version
  [ "$status" -eq 0 ]
  [[ $output == node-ctl* ]] || false
  run "$RAE" version
  [ "$status" -eq 0 ]
  [[ $output == node-ctl* ]] || false
}

@test "progress goes to stderr, only the result to stdout" {
  run bash -c "'$RAE' create dev1 2>/dev/null"
  [ "$status" -eq 0 ]
  [ "$output" = "ready: node-ctl ssh dev1" ]
  run bash -c "'$RAE' create dev2 2>&1 >/dev/null"
  [[ $output != *"ready:"* ]] || false
  [ -n "$(id_of 'Wait for dev2')" ] # the narration went to the renderer, not to stdout
}

@test "a failed apply says the inventory is ahead of the infrastructure" {
  "$RAE" create dev1
  STUB_TF_RC=1 run "$RAE" stop dev1
  [ "$status" -eq 1 ]
  [[ $output == *"terraform apply failed"*"node-ctl apply"* ]] || false
  [ "$(inv dev1 .state)" = stopped ]
}

@test "a stop cut short in its apply is finished by running stop again, and only then is it done" {
  "$RAE" create dev1
  STUB_TF_RC=1 run "$RAE" stop dev1 # the network drops while Terraform deletes the VPS
  [ "$status" -eq 1 ]
  : > "$STUB_LOG"
  run "$RAE" stop dev1
  [ "$status" -eq 0 ]
  grep -q "terraform: -chdir=terraform apply" "$STUB_LOG"
  ! grep -q "create_image" "$STUB_LOG" || false # the disk is already kept: no second snapshot
  [ "$(inv dev1 .state)" = stopped ]
  run "$RAE" stop dev1 # a finished stop has nothing left to do
  [ "$status" -eq 1 ]
  [[ $output == *"dev1 is not running"* ]] || false
}

@test "the autostop job keeps retrying a stop whose apply failed instead of removing itself" {
  macos_only
  "$RAE" create dev1; "$RAE" stop dev1
  "$RAE" start dev1 --till "2099-06-01 18:30"
  job=$(job_script dev1 | sed 's/-ge [0-9]*/-ge 0/')
  STUB_TF_RC=1 run bash -c "$job"
  [ "$status" -ne 0 ]
  [ -e "$LAUNCH_AGENTS/com.node-ctl.stop.dev1.plist" ]
  : > "$STUB_LOG"
  bash -c "$job" # a minute later the network is back
  grep -q "terraform: -chdir=terraform apply" "$STUB_LOG"
  [ ! -e "$LAUNCH_AGENTS/com.node-ctl.stop.dev1.plist" ]
}

@test "a lost request while the server shuts down does not fail the stop" {
  "$RAE" create dev1
  STUB_CURL_FAIL_ONCE=/servers/7 run "$RAE" stop dev1
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .state)" = stopped ]
}

@test "a start cut short in its apply is finished by apply <name>, which waits for the machine as start does" {
  "$RAE" create dev1; "$RAE" stop dev1
  STUB_TF_RC=1 run "$RAE" start dev1
  [ "$status" -eq 1 ]
  [[ $output == *"node-ctl apply dev1"* ]] || false
  run "$RAE" start dev1
  [[ $output == *"dev1 is already running"*"node-ctl apply dev1"* ]] || false
  : > "$STUB_LOG"
  run "$RAE" apply dev1
  [ "$status" -eq 0 ]
  grep -q "node-ctl-user@dev1 sudo cloud-init status --wait" "$STUB_LOG"
  [ -s "$SSH_DIR/config.d/node-ctl" ]
}

@test "create rejects bad names" {
  run "$RAE" create Bad_Name
  [ "$status" -eq 1 ]
  [ ! -e "$SERVERS_DIR/Bad_Name.json" ]
}

# --- several accounts, on one provider or both ------------------------------------------------------------------

@test "create takes the only account silently, needs --account among several off a terminal, and applies in that account's workspace" {
  "$RAE" create dev1
  [ "$(inv dev1 .account)" = main ]
  grep -q "terraform: -chdir=terraform apply -input=false -no-color -auto-approve (workspace main, account main, token t)" "$STUB_LOG"
  config '.hetzner.work = "t2"'
  run "$RAE" create dev2 # stdin is not a terminal: nothing to ask on
  [ "$status" -eq 1 ]
  [[ $output == *"several accounts (hetzner/main hetzner/work): pass --account"* ]] || false
  [ ! -e "$SERVERS_DIR/dev2.json" ]
  run "$RAE" create dev2 --account nope
  [ "$status" -eq 1 ]
  [[ $output == *"no account nope"*"main work"* ]] || false
  : > "$STUB_LOG"; : > "$STUB_EVENTS"
  run "$RAE" create dev2 --account work
  [ "$status" -eq 0 ]
  [ "$(inv dev2 .account)" = work ]
  [ "$(ev 'select(.event_type == "log" and .action_name == "Write inventory") | .message')" = "$SERVERS_DIR/dev2.json: cx23 nbg1 ports 22, account work" ]
  # one apply per account, each in its own workspace with its own token; init once, since the providers are shared
  [ "$(grep -c "terraform: -chdir=terraform init" "$STUB_LOG")" -eq 1 ]
  grep -q "terraform: -chdir=terraform apply -input=false -no-color -auto-approve (workspace main, account main, token t)" "$STUB_LOG"
  grep -q "terraform: -chdir=terraform apply -input=false -no-color -auto-approve (workspace work, account work, token t2)" "$STUB_LOG"
  [ "$(ev 'select(.event_type == "completed" and (.action_name | startswith("terraform apply"))) | .action_name' | paste -s -d , -)" = "terraform apply (main),terraform apply (work)" ]
  run "$RAE" list
  [[ $output == *"dev1  main"* && $output == *"dev2  work"* ]] || false
  run bash -c "'$RAE' list --json 2>/dev/null"
  [ "$(jq -r 'map(.account) | join(",")' <<< "$output")" = "main,work" ]
}

@test "create asks which account on a terminal, by number or by tag" {
  config '.hetzner.work = "t2"'
  # script(1) lends a pty, so the question is asked; the answer arrives once the prompt is up (an early EOF would discard it)
  run bash -c "(/bin/sleep 1; printf '2\n'; /bin/sleep 3) | '$PTY' '$RAE' create dev1 --size 0 --type cx23"
  [[ $output == *"1) main"*"2) work"*"ready: node-ctl ssh dev1"* ]] || false
  [ "$(inv dev1 .account)" = work ]
  run bash -c "(/bin/sleep 1; printf 'main\n'; /bin/sleep 3) | '$PTY' '$RAE' create dev2 --size 0 --type cx23"
  [ "$(inv dev2 .account)" = main ]
  run bash -c "(/bin/sleep 1; printf 'nope\n'; /bin/sleep 3) | '$PTY' '$RAE' create dev3 --size 0 --type cx23"
  [[ $output == *"not an account: nope"* ]] || false
  [ ! -e "$SERVERS_DIR/dev3.json" ]
}

@test "create without a name asks it on a terminal, then the ports; off one the name is a usage error" {
  run "$RAE" create --size 0
  [ "$status" -eq 1 ]
  [[ $output == *"usage: node-ctl create <name>"* ]] || false
  run bash -c "(/bin/sleep 1; printf 'dev1\n'; /bin/sleep 1; printf '80,443\n'; /bin/sleep 3) | '$PTY' '$RAE' create --type cx23 --size 0"
  [[ $output == *"Name of the new machine"*"Public TCP ports"*"ready: node-ctl ssh dev1"* ]] || false
  [ "$(inv dev1 -c .open_ports)" = "[22,80,443]" ]
  run bash -c "(/bin/sleep 1; printf 'Bad_Name\n'; /bin/sleep 1) | '$PTY' '$RAE' create"
  [[ $output == *"name must be lowercase"* ]] || false
}

@test "a command without a name asks which machine on a terminal, offering only those it can act on" {
  "$RAE" create dev1; "$RAE" create dev2; "$RAE" create dev3
  "$RAE" stop dev2
  run "$RAE" start # off a terminal its own usage error stands
  [ "$status" -eq 1 ]
  [[ $output == *"usage: node-ctl start <name ...>"* ]] || false
  run bash -c "(/bin/sleep 1; printf '2\n'; /bin/sleep 3) | '$PTY' '$RAE' start"
  [[ $output == *"1) all: every stopped machine"*"2) dev2"*stopped* && $output != *"3) "* ]] || false # the running ones cannot be started
  [ "$(inv dev2 .state)" = running ]
  run bash -c "(/bin/sleep 1; printf 'dev3\n'; /bin/sleep 3) | '$PTY' '$RAE' destroy --yes" # options stay after the asked name
  [ ! -e "$SERVERS_DIR/dev3.json" ]
  run bash -c "(/bin/sleep 1; printf '1\n'; /bin/sleep 1; printf '30\n'; /bin/sleep 3) | '$PTY' '$RAE' volume"
  [[ $output == *"dev1: 30G at /mnt/volume"* ]] || false
  [ "$(inv dev1 .volume_size)" = 30 ]
  run bash -c "(/bin/sleep 1; printf 'nope\n'; /bin/sleep 1) | '$PTY' '$RAE' ports"
  [[ $output == *"not a machine: nope"* ]] || false
  run bash -c "'$PTY' '$RAE' start < /dev/null"
  [[ $output == *"no stopped machine for start"* ]] || false
}

@test "a bare stop or start on a terminal offers all of them first, then each one" {
  "$RAE" create dev1; "$RAE" create dev2; "$RAE" create dev3
  run bash -c "(/bin/sleep 1; printf '1\n'; /bin/sleep 3) | '$PTY' '$RAE' stop"
  [[ $output == *"1) all: every running machine"*"2) dev1"*"3) dev2"*"4) dev3"* ]] || false
  [ "$(inv dev1 .state)$(inv dev2 .state)$(inv dev3 .state)" = stoppedstoppedstopped ]
  run bash -c "(/bin/sleep 1; printf 'dev2\n'; /bin/sleep 3) | '$PTY' '$RAE' start"
  [ "$(inv dev1 .state)$(inv dev2 .state)$(inv dev3 .state)" = stoppedrunningstopped ]
  run bash -c "(/bin/sleep 1; printf 'q\n'; /bin/sleep 1) | '$PTY' '$RAE' start --type" # --type is one machine: no line for all
  [[ $output == *"1) dev1"* && $output != *"all: every"* ]] || false
}

@test "a name after the options is a name: a terminal is not asked for one" {
  "$RAE" create dev1; "$RAE" create dev2; "$RAE" stop --all
  run bash -c "'$PTY' '$RAE' start --till 2.9h dev2 < /dev/null"
  [[ $output != *"? machine"* && $output != *"aborted"* ]] || false
  [ "$(inv dev1 .state)$(inv dev2 .state)" = stoppedrunning ]
  run bash -c "'$PTY' '$RAE' start --till 2h < /dev/null" # an option's value is no name: it still asks
  [[ $output == *"1) dev1"* ]] || false
  [ "$(inv dev1 .state)" = stopped ]
}

@test "start takes several machines or --all, with one apply for all of them" {
  "$RAE" create dev1; "$RAE" create dev2; "$RAE" create dev3
  "$RAE" stop --all
  run "$RAE" start
  [ "$status" -eq 1 ]
  [[ $output == *"usage: node-ctl start <name ...> [--type [type]] [--till time] | --all"* ]] || false
  run "$RAE" start dev1 dev2 --type cx33
  [[ $output == *"--type takes one machine"* ]] || false
  : > "$STUB_LOG"
  run "$RAE" start dev1 dev2
  [ "$status" -eq 0 ]
  [[ $output == *"ready: node-ctl ssh dev1"*"ready: node-ctl ssh dev2"* ]] || false
  [ "$(inv dev3 .state)" = stopped ]
  [ "$(grep -c 'terraform: -chdir=terraform apply' "$STUB_LOG")" -eq 1 ]
  run "$RAE" start dev1 dev3
  [[ $output == *"dev1 is already running"* ]] || false
  [ "$(inv dev3 .state)" = stopped ] # refused before anything is touched
  run "$RAE" start --all
  [ "$status" -eq 0 ]
  [ "$(inv dev3 .state)" = running ]
  run "$RAE" start --all
  [[ $output == *"no stopped machine to start"* ]] || false
}

@test "the Hetzner API is called with the machine's own token, and a machine without a known account is refused first" {
  config '.hetzner.work = "t2"'
  "$RAE" create dev1 --account work; : > "$STUB_LOG"
  "$RAE" stop dev1
  grep -q "http: GET https://api.hetzner.cloud/v1/servers?name=dev1 auth=Bearer t2" "$STUB_LOG" # image.sh, snapshotting the disk
  ! grep -q "Bearer t .*api.hetzner.cloud" "$STUB_LOG" || false
  config # the work account is gone from the configuration
  : > "$STUB_LOG"
  run "$RAE" start dev1
  [ "$status" -eq 1 ]
  [[ $output == *"no account work in $NODE_CTL_CONFIG, which dev1 belongs to"* ]] || false
  ! grep -q "terraform:" "$STUB_LOG" || false
  run "$RAE" apply # every apply guards the whole inventory: an unmanaged machine would silently stay as it is
  [ "$status" -eq 1 ]
  [[ $output == *"no account work"* ]] || false
  config '.hetzner.work = "t2"'
  "$RAE" create dev2 --account main
  jq 'del(.account)' "$SERVERS_DIR/dev2.json" > "$SERVERS_DIR/x" && mv "$SERVERS_DIR/x" "$SERVERS_DIR/dev2.json" # an inventory entry from before accounts
  run "$RAE" ports dev2 # any command that looks the machine up (ssh alone takes any name)
  [ "$status" -eq 1 ]
  [[ $output == *"dev2 has no account: add \"account\": \"<tag>\" to $SERVERS_DIR/dev2.json (tags in $NODE_CTL_CONFIG: main work)"* ]] || false
}

# --- Contabo as a second provider (ADR-0018) ---------------------------------------------------

# One Contabo account next to the Hetzner one; a tag names exactly one account, on one provider.
contabo() { config '.contabo.cb = {"client_id": "ci", "client_secret": "cs", "user": "u@e", "password": "pw"}' "$@"; }

@test "create on a Contabo account looks the standard image up and applies in the Contabo root" {
  contabo
  run "$RAE" create dev1 --account cb
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .account)" = cb ]
  [ "$(inv dev1 .type)" = V45 ]      # the defaults of that provider, not Hetzner's
  [ "$(inv dev1 .location)" = EU ]
  [ "$(inv dev1 .image)" = img-ubuntu-24.04 ] # a UUID there, so it is resolved once and kept
  [ "$(inv dev1 -c 'has("volume_size")')" = false ]
  grep -q "http: GET .*standardImage=true.*name=ubuntu-24.04" "$STUB_LOG"
  grep -q "terraform: -chdir=terraform/contabo init" "$STUB_LOG"
  grep -q "terraform: -chdir=terraform/contabo apply -input=false -no-color -auto-approve (workspace cb, account cb, contabo ci/u@e/pw)" "$STUB_LOG"
  grep -q "terraform: -chdir=terraform apply -input=false -no-color -auto-approve (workspace main, account main, token t)" "$STUB_LOG"
  [[ $output == *"ready: node-ctl ssh dev1"* ]] || false
}

@test "a Contabo password with shell characters reaches the provider as it is" {
  config '.contabo.cb = {"client_id": "ci", "client_secret": "cs", "user": "u@e", "password": "p w'"'"'$(x)"}'
  run "$RAE" create dev1 --account cb
  [ "$status" -eq 0 ]
  grep -q -F "(workspace cb, account cb, contabo ci/u@e/p w'\$(x))" "$STUB_LOG"
}

@test "a new Contabo instance gets its firewall only once it has finished provisioning" {
  contabo # a firewall attached while it provisions is refused (402) and left behind in the account
  run "$RAE" create dev1 --account cb
  [ "$status" -eq 0 ]
  [ "$(grep -n 'apply -input=false -no-color -auto-approve -target=contabo_instance.dev\["dev1"\] (workspace cb' "$STUB_LOG" | cut -d: -f1)" \
    -lt "$(grep -n 'http: GET .*displayName=dev1' "$STUB_LOG" | head -1 | cut -d: -f1)" ]
  [ "$(grep -n 'http: GET .*displayName=dev1' "$STUB_LOG" | head -1 | cut -d: -f1)" \
    -lt "$(grep -n 'contabo apply -input=false -no-color -auto-approve (workspace cb' "$STUB_LOG" | cut -d: -f1)" ]
  [ "$(ev 'select(.event_type == "completed") | .action_name' | grep -c 'Wait for the dev1 instance')" -eq 1 ]
}

@test "machines whose firewall Terraform already holds cost a Contabo apply nothing extra" {
  contabo
  "$RAE" create dev1 --account cb
  : > "$STUB_LOG"
  STUB_TF_STATE='contabo_firewall.dev["dev1"]' run "$RAE" apply
  [ "$status" -eq 0 ]
  ! grep -q -- "-target=" "$STUB_LOG" || false
  ! grep -q "displayName=" "$STUB_LOG" || false
  grep -q "contabo apply -input=false -no-color -auto-approve (workspace cb" "$STUB_LOG"
}

@test "an instance that never finishes provisioning stops the apply before its firewall" {
  contabo
  STUB_CONTABO_STATUS=provisioning run "$RAE" create dev1 --account cb
  [ "$status" -ne 0 ]
  said "the Contabo instance dev1 is still provisioning after 15 minutes" || false
  [ "$(grep -c 'http: GET .*displayName=dev1' "$STUB_LOG")" -eq 90 ] # polled, with a fresh token each time
  ! grep -q "contabo apply -input=false -no-color -auto-approve (workspace cb" "$STUB_LOG" || false
}

@test "a running Contabo instance without its firewall add-on yet is still waited for" {
  contabo # Contabo reports running before the add-on is on the contract; a firewall then is a 402
  STUB_CONTABO_ADDONS='[]' run "$RAE" create dev1 --account cb
  [ "$status" -ne 0 ]
  said "the Contabo instance dev1 is still waiting for its firewall add-on after 15 minutes" || false
  ! grep -q "contabo apply -input=false -no-color -auto-approve (workspace cb" "$STUB_LOG" || false
}

@test "the account tag says the provider: create asks for one when both clouds are configured" {
  contabo
  run "$RAE" create dev1 # stdin is not a terminal: nothing to ask on
  [ "$status" -eq 1 ]
  [[ $output == *"several accounts (hetzner/main contabo/cb): pass --account"* ]] || false
  run bash -c "(/bin/sleep 1; printf '2\n'; /bin/sleep 3) | '$PTY' '$RAE' create dev1 --type V45" # --type: the account is the only question here
  [[ $output == *"1) main (hetzner)"*"2) cb (contabo)"* ]] || false
  [ "$(inv dev1 .account)" = cb ]
  run "$RAE" create dev2 --account nope
  [ "$status" -eq 1 ]
  [[ $output == *"no account nope"*"main cb"* ]] || false
}

@test "stop powers a Contabo instance off and start powers it on: no snapshot, and the tailnet node stays" {
  contabo
  "$RAE" create dev1 --account cb; : > "$STUB_LOG"; : > "$STUB_EVENTS"
  run "$RAE" stop dev1
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .state)" = stopped ]
  grep -q "http: POST .*compute/instances/99/actions/stop" "$STUB_LOG"
  ! grep -q "actions/create_image" "$STUB_LOG" || false # the disk stays where it is; there is nothing to snapshot
  ! grep -q "tailscale logout" "$STUB_LOG" || false     # the instance comes back with its node, so it keeps it
  ! grep -q "tailnet/-/devices" "$STUB_LOG" || false
  [ "$(ev 'select(.event_type == "planned") | .action_name' | paste -s -d ' ' -)" = "Power off Write inventory Apply Terraform" ]
  : > "$STUB_LOG"
  run "$RAE" start dev1
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .state)" = running ]
  grep -q "http: POST .*compute/instances/99/actions/start" "$STUB_LOG"
  ! grep -q "tailnet/-/devices" "$STUB_LOG" || false
}

@test "restore powers a stopped Contabo machine on before it waits for it" {
  contabo
  "$RAE" create dev1 --account cb
  "$RAE" stop dev1; : > "$STUB_LOG"
  run "$RAE" restore dev1
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .state)" = running ]
  grep -q "http: POST .*compute/instances/99/actions/start" "$STUB_LOG" # no apply would ever start it again
  [ "$(line_of 'actions/start')" -lt "$(line_of 'restic restore')" ]
}

@test "destroy of a Contabo machine cancels the contract and looks for no snapshot" {
  contabo
  "$RAE" create dev1 --account cb; : > "$STUB_LOG"; : > "$STUB_EVENTS"
  run "$RAE" destroy dev1 --yes
  [ "$status" -eq 0 ]
  [ ! -e "$SERVERS_DIR/dev1.json" ]
  ! grep -q "images?type=snapshot" "$STUB_LOG" || false
  [ "$(ev 'select(.event_type == "planned") | .action_name' | paste -s -d ' ' -)" = "Leave the tailnet Write inventory Apply Terraform Free the tailnet name" ]
}

@test "volume and resize stay Hetzner-only" {
  contabo
  "$RAE" create dev1 --account cb
  run "$RAE" volume dev1 40
  [ "$status" -eq 1 ]
  [[ $output == *"volumes are Hetzner-only"* ]] || false
  run "$RAE" resize dev1 V46
  [ "$status" -eq 1 ]
  [[ $output == *"resize is Hetzner-only"* ]] || false
  "$RAE" stop dev1
  run "$RAE" start dev1 --type V46
  [ "$status" -eq 1 ]
  [[ $output == *"--type is Hetzner-only"* ]] || false
  [ "$(inv dev1 .state)" = stopped ]
  run "$RAE" create dev2 --account cb --size 40
  [ "$status" -eq 1 ]
  [[ $output == *"a volume is Hetzner-only"* ]] || false
  [ ! -e "$SERVERS_DIR/dev2.json" ]
}

@test "check probes every Contabo account, and a tag that names two clouds is refused" {
  contabo
  run "$RAE" check
  [ "$status" -eq 0 ]
  grep -q "http: POST https://auth.contabo.com/.* body=.*client_id=ci.*client_secret=cs.*username=u@e.*password=pw" "$STUB_LOG"
  grep -q "http: GET .*compute/instances.* auth=Bearer at" "$STUB_LOG"
  [ "$(ev 'select(.event_type == "log" and .action_name == "accounts") | .message')" = "hetzner/main contabo/cb" ]
  [ -n "$(ev 'select(.event_type == "completed" and .action_name == "Contabo credentials (cb)")')" ]
  "$RAE" create dev1 --account main
  config '.contabo.main.client_id = "ci"' # the same tag on both clouds: no command can tell which
  run "$RAE" ports dev1
  [ "$status" -eq 1 ]
  [[ $output == *"the tag main names a Hetzner and a Contabo account"* ]] || false
}

@test "init contabo takes one account at a time and never a tag a Hetzner account owns" {
  answers cb ci cs u@e pw ""
  run "$RAE" init contabo < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  [ "$(cfg .contabo.cb.client_id)" = ci ]
  [ "$(cfg .contabo.cb.user)" = "u@e" ]
  [ "$(cfg .contabo.cb.password)" = pw ]
  grep -q "http: POST https://auth.contabo.com/.* body=.*client_id=ci" "$STUB_LOG"
  answers main ""
  run "$RAE" init contabo < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  said "already names a Hetzner account" || false
  [ "$(cfg '.contabo | keys | join(" ")')" = cb ]
}

@test "stop logs the node out of the tailnet before applying, start brings it back" {
  "$RAE" create dev1
  run "$RAE" stop dev1
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .state)" = stopped ]
  [ "$(line_of 'node-ctl-user@dev1 sudo systemd-run --quiet --on-active=2 tailscale logout')" -lt "$(line_of 'terraform: -chdir=terraform apply')" ]
  run "$RAE" start dev1
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .state)" = running ]
}

@test "stop keeps the root disk as an image, start boots from it and keeps it" {
  "$RAE" create dev1
  run "$RAE" stop dev1
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .image)" = 4711 ]
  grep -q "http: POST .*servers/7/actions/shutdown" "$STUB_LOG"
  [ "$(line_of 'actions/shutdown')" -lt "$(line_of 'actions/create_image')" ] # a snapshot of a running disk is one to fsck
  [ "$(line_of 'actions/create_image')" -lt "$(line_of 'images?type=snapshot')" ] # older snapshots go only once the new one is written
  [ "$(line_of 'images?type=snapshot')" -lt "$(line_of 'terraform: -chdir=terraform apply')" ]
  ! grep -q "http: DELETE .*images/4711" "$STUB_LOG" || false # the one just taken is the one to keep
  : > "$STUB_LOG"
  run "$RAE" start dev1
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .image)" = 4711 ] # /data rides the snapshot: it stays as the machine's last known good copy
  ! grep -q "images/4711" "$STUB_LOG" || false
}

@test "the next stop replaces the snapshot: the previous one goes, other machines' snapshots stay" {
  "$RAE" create dev1
  "$RAE" stop dev1
  "$RAE" start dev1
  : > "$STUB_LOG"
  STUB_CURL_BODY='{"access_token":"at","devices":[],"servers":[{"id":7}],"server":{"status":"off"},"image":{"id":"4712","status":"available"},
    "images":[{"id":4711,"description":"node-ctl dev1"},{"id":4712,"description":"node-ctl dev1"},{"id":4000,"description":"node-ctl dev2"},{"id":4001,"description":"mine"}]}' \
    run "$RAE" stop dev1
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .image)" = 4712 ]
  grep -q "http: DELETE .*images/4711" "$STUB_LOG"
  [ "$(line_of 'images/4712')" -lt "$(line_of 'images/4711')" ] # 4712 was polled to available before 4711 went
  ! grep -q "http: DELETE .*images/4712" "$STUB_LOG" || false
  ! grep -q "images/4000" "$STUB_LOG" || false
  ! grep -q "images/4001" "$STUB_LOG" || false
}

@test "a retried stop waits for the snapshot the timed-out one left instead of taking a second" {
  "$RAE" create dev1
  : > "$STUB_LOG"
  STUB_CURL_BODY='{"access_token":"at","devices":[],"servers":[{"id":7}],"server":{"status":"off"},"image":{"id":"4712","status":"available"},
    "images":[{"id":4712,"description":"node-ctl dev1","status":"creating"},{"id":4000,"description":"node-ctl dev2","status":"creating"}]}' \
    run "$RAE" stop dev1
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .image)" = 4712 ]
  ! grep -q "actions/create_image" "$STUB_LOG" || false # a second copy of the same disk would just be billed twice
  ! grep -q "actions/shutdown" "$STUB_LOG" || false
  grep -q "http: .*images/4712" "$STUB_LOG" # polled to available, then kept
  ! grep -q "images/4000" "$STUB_LOG" || false # another machine's unfinished snapshot is not this one
}

@test "stop --all stops every running machine, one apply for all of them; a bare stop never does" {
  "$RAE" create dev1; "$RAE" create dev2; "$RAE" create dev3
  "$RAE" stop dev3 # already stopped: not touched again
  : > "$STUB_LOG"
  run "$RAE" stop # off a terminal: a usage error, not every machine
  [ "$status" -eq 1 ]
  [[ $output == *"usage: node-ctl stop <name ...> | --all"* ]] || false
  [ "$(inv dev1 .state)" = running ]
  run "$RAE" stop --all
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .state)" = stopped ]
  [ "$(inv dev2 .state)" = stopped ]
  [ "$(grep -c 'terraform: -chdir=terraform apply' "$STUB_LOG")" -eq 1 ]
  [ "$(grep -c 'actions/create_image' "$STUB_LOG")" -eq 2 ]
  run "$RAE" stop --all
  [ "$status" -eq 1 ]
  [[ $output == *"no running machine to stop"* ]] || false
}

@test "stop takes several names and validates them all before it touches anything" {
  "$RAE" create dev1; "$RAE" create dev2; : > "$STUB_LOG"
  run "$RAE" stop dev1 nope
  [ "$status" -eq 1 ]
  [[ $output == *"no such machine: nope"* ]] || false
  [ "$(inv dev1 .state)" = running ]
  ! grep -q "actions/create_image" "$STUB_LOG" || false
  run "$RAE" stop dev1 dev2
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .state)" = stopped ]
  [ "$(inv dev2 .state)" = stopped ]
  [ "$(ev 'select(.event_type == "started" and .action_name == "Stop dev2") | .action_id' | wc -l)" -eq 1 ]
}

@test "a machine that cannot be snapshotted does not stop the others, and is named at the end" {
  "$RAE" create dev1; "$RAE" create dev2; : > "$STUB_LOG"
  STUB_FAIL=curl run "$RAE" stop dev1 dev2
  [ "$status" -eq 1 ]
  [ "$(inv dev1 .state)" = running ]
  [ "$(inv dev2 .state)" = running ]
  [[ $output == *"retry: node-ctl stop dev1 dev2"* ]] || false
}

@test "stop that cannot snapshot the root disk leaves the machine in the inventory as it was" {
  "$RAE" create dev1; : > "$STUB_LOG"
  STUB_FAIL=curl run "$RAE" stop dev1
  [ "$status" -eq 1 ]
  [ "$(inv dev1 .state)" = running ]
  [ "$(inv dev1 .image)" = null ]
  [[ $output == *"retry: node-ctl stop dev1"* ]] || false
  ! grep -q "terraform: -chdir=terraform apply" "$STUB_LOG" || false # the VPS is not deleted without its disk
}

@test "list says stopping while a stop of that machine still runs, not starting" {
  "$RAE" create dev1; "$RAE" create dev2
  STUB_FAIL=curl run "$RAE" stop dev1 # a stop that dies half way leaves its mark, of a process now gone
  [ "$(inv dev1 .stopping)" -gt 0 ]
  run "$RAE" list
  [[ $output == *"dev1  main     starting"* ]] || false
  bash -c 'exec -a node-ctl /bin/sleep 30' & # what list sees of a stop that is still at it
  jq --argjson p $! '.stopping = $p' "$SERVERS_DIR/dev1.json" > "$BATS_TEST_TMPDIR/j" && mv "$BATS_TEST_TMPDIR/j" "$SERVERS_DIR/dev1.json"
  run "$RAE" list
  kill $!
  [[ $output == *"dev1  main     stopping"* ]] || false
  [[ $output == *"dev2  main     starting"* ]] || false
  run bash -c "'$RAE' list --json 2>/dev/null"
  [ "$(jq -r '.[0].state' <<< "$output")" = starting ] # the process is gone again
  "$RAE" stop dev2
  [ "$(inv dev2 .stopping)" = null ] # a stop that finished takes its mark with it
}

@test "destroy and archive delete the machine's snapshot" {
  "$RAE" create dev1
  "$RAE" stop dev1
  run "$RAE" destroy dev1 --yes
  [ "$status" -eq 0 ]
  grep -q "http: DELETE .*images/4711" "$STUB_LOG"
  [ "$(line_of 'images/4711')" -lt "$(line_of 'terraform: -chdir=terraform apply')" ]
  [ ! -e "$SERVERS_DIR/dev1.json" ]
  "$RAE" create dev1; : > "$STUB_LOG"
  run "$RAE" archive dev1
  [ "$status" -eq 0 ]
  grep -q "http: DELETE .*images/4711" "$STUB_LOG" # restic holds the data now
  [ "$(line_of 'restic backup')" -lt "$(line_of 'images/4711')" ]
}

@test "volume adds a Hetzner Volume to a running machine and mounts it; a stopped one gets it at the next start" {
  "$RAE" create dev1; : > "$STUB_LOG"
  run "$RAE" volume dev1 40
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .volume_size)" = 40 ]
  [ "$(line_of 'terraform: -chdir=terraform apply')" -lt "$(line_of 'node-ctl-user@dev1 sudo bash -s')" ]
  grep -q -F '/mnt/volume' "$STUB_LOG" # mount-volume.sh went over ssh
  [[ $output == *"dev1: 40G at /mnt/volume"* ]] || false
  run "$RAE" volume dev1 50
  [ "$status" -eq 1 ]
  [[ $output == *"already has a volume"* ]] || false
  [ "$(inv dev1 .volume_size)" = 40 ]
  "$RAE" create dev2
  "$RAE" stop dev2; : > "$STUB_LOG"
  run "$RAE" volume dev2 big
  [ "$status" -eq 1 ]
  [[ $output == *"not a volume size"* ]] || false
  run "$RAE" volume dev2 40
  [ "$status" -eq 0 ]
  [ "$(inv dev2 .volume_size)" = 40 ]
  grep -q 'terraform: -chdir=terraform apply' "$STUB_LOG"
  ! grep -q 'bash -s' "$STUB_LOG" || false # nothing to mount it on yet
}

@test "start refuses archived machines and points at restore" {
  mkdir -p "$SERVERS_DIR"
  echo '{"state":"archived","account":"main","open_ports":[22],"funnel":{}}' > "$SERVERS_DIR/dev1.json"
  run "$RAE" start dev1
  [ "$status" -eq 1 ]
  [[ $output == *"restore dev1"* ]] || false
  [ "$(inv dev1 .state)" = archived ]
}

@test "ports always keeps 22 and rejects garbage" {
  "$RAE" create dev1
  "$RAE" ports dev1 8080 3000
  [ "$(inv dev1 -c .open_ports)" = "[22,3000,8080]" ]
  "$RAE" ports dev1 22
  [ "$(inv dev1 -c .open_ports)" = "[22]" ]
  run "$RAE" ports dev1 http
  [ "$status" -eq 1 ]
  [ "$(inv dev1 -c .open_ports)" = "[22]" ]
}

@test "ports without a list shows the ports instead of closing them" {
  "$RAE" create dev1 --ports 22,8080
  : > "$STUB_LOG"
  run bash -c "'$RAE' ports dev1 2>/dev/null"
  [ "$status" -eq 0 ]
  [ "$output" = $'22\n8080' ]
  [ "$(inv dev1 -c .open_ports)" = "[22,8080]" ]
  ! grep -q "terraform" "$STUB_LOG" || false
}

# The test server answers every request with this body, so it carries the fields the tailnet cleanup and
# the power-on need too.
# dev1's disk is 40G (primary_disk_size), so cx11 with its 20G disk is out too.
# locations[].available is the only availability Hetzner still answers (/datacenters is 410 Gone):
# nbg1 takes a ccx13 and refuses a cx43, for a resize and a start alike.
types() {
  export STUB_CURL_BODY='{"access_token":"at","devices":[],"servers":[{"id":"7","primary_disk_size":40}],
   "server":{"status":"off"},"image":{"id":"4711","status":"available"},"images":[],
   "server_types":[
    {"id":7,"name":"cx11","cores":1,"memory":2,"disk":20,"architecture":"x86","cpu_type":"shared","locations":[{"name":"nbg1","available":true}],"prices":[{"location":"nbg1","price_monthly":{"gross":"3.0000"}}]},
    {"id":1,"name":"cx22","cores":2,"memory":4,"disk":40,"architecture":"x86","cpu_type":"shared","locations":[{"name":"nbg1","available":true}],"prices":[{"location":"nbg1","price_monthly":{"gross":"4.5100"}}]},
    {"id":2,"name":"cx23","cores":4,"memory":8,"disk":40,"architecture":"x86","cpu_type":"shared","locations":[{"name":"nbg1","available":true}],"prices":[{"location":"nbg1","price_monthly":{"gross":"8.4900"}}]},
    {"id":3,"name":"cax21","cores":4,"memory":8,"disk":40,"architecture":"arm","cpu_type":"shared","locations":[{"name":"nbg1","available":true}],"prices":[{"location":"nbg1","price_monthly":{"gross":"6.9900"}}]},
    {"id":4,"name":"cx33","cores":8,"memory":16,"disk":80,"architecture":"x86","cpu_type":"shared","locations":[{"name":"fsn1","available":true}],"prices":[{"location":"fsn1","price_monthly":{"gross":"16.4000"}}]},
    {"id":5,"name":"ccx13","cores":2,"memory":8,"disk":80,"architecture":"x86","cpu_type":"dedicated","locations":[{"name":"nbg1","available":true}],"prices":[{"location":"nbg1","price_monthly":{"gross":"12.9900"}}]},
    {"id":6,"name":"cx43","cores":8,"memory":16,"disk":160,"architecture":"x86","cpu_type":"shared","locations":[{"name":"nbg1","available":false}],"prices":[{"location":"nbg1","price_monthly":{"gross":"20.0000"}}]}]}'
}

@test "resize offers the types cheapest first, with the machine's own among them, and applies the pick" {
  types # cax21 is ARM and cx33 is not sold in nbg1: neither belongs in the list at all
  "$RAE" create dev1
  : > "$STUB_LOG"
  run bash -c "echo 2 | '$RAE' resize dev1"
  [ "$status" -eq 0 ]
  [[ $output == *"cx11"*"20G"*"3.00"*"no"*"cx22"*"shared"*"40G"*"4.51"*"yes"*"* cx23"*"8.49"*"yes"*"ccx13"*"dedicated"*"80G"*"12.99"*"yes"* ]] || false # by price, current marked, CPU, DISK and MOVE shown
  [[ $output != *cax21* ]] || false # another architecture: an x86 machine cannot migrate to ARM
  [[ $output != *cx33* ]] || false  # not sold in nbg1
  [[ $output == *"with a 40G disk"* ]] || false
  [ "$(inv dev1 .type)" = cx22 ] # cheapest first: 1 is cx11, whose disk is too small, 2 the downgrade that fits
  [ "$(inv dev1 .keep_disk)" = true ] # same disk size: nothing to grow, nothing asked
  grep -q "terraform: -chdir=terraform apply" "$STUB_LOG"
  [[ $output == *"dev1: cx23 -> cx22"* ]] || false
  ! grep -q datacenters "$STUB_LOG" || false # 410 Gone at Hetzner since 2026-10-01
}

@test "resize grows the disk only on --grow-disk; the default keeps it, so a smaller type stays possible" {
  types
  "$RAE" create dev1
  run "$RAE" resize dev1 ccx13 # off a terminal nobody is asked: the disk stays
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .type)" = ccx13 ]
  [ "$(inv dev1 .keep_disk)" = true ]
  [[ $output == "dev1: cx23 -> ccx13" ]] || false
  run "$RAE" resize dev1 cx22 --grow-disk # same disk: the flag changes nothing
  [ "$(inv dev1 .keep_disk)" = true ]
  run "$RAE" resize dev1 --grow-disk ccx13
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .keep_disk)" = false ]
  [[ $output == *"dev1: cx22 -> ccx13, disk 80G"* ]] || false
  run "$RAE" resize dev1 cx22 --keep-disk # the stub's machine still reports a 40G disk, so the way down is open
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .keep_disk)" = true ]
}

@test "resize refuses a type whose disk is smaller than the machine's" {
  types
  "$RAE" create dev1
  : > "$STUB_LOG"
  run "$RAE" resize dev1 cx11
  [ "$status" -eq 1 ]
  [[ $output == *"disk is smaller than 40G"* ]] || false
  [ "$(inv dev1 .type)" = cx23 ]
  ! grep -q "terraform" "$STUB_LOG" || false
}

@test "resize takes the type as an argument and refuses one that is not on offer" {
  types
  "$RAE" create dev1
  run "$RAE" resize dev1 cx33
  [ "$status" -eq 1 ]
  [[ $output == *"cannot move to 'cx33'"* ]] || false
  [ "$(inv dev1 .type)" = cx23 ]
  run "$RAE" resize dev1 cx22
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .type)" = cx22 ]
}


@test "resize lists a type Hetzner will not move into, and refuses to pick it" {
  types # cx43 is sold in nbg1 but not available there
  "$RAE" create dev1
  run bash -c "echo | '$RAE' resize dev1"
  [ "$status" -eq 0 ]
  [[ $output == *"cx43"*"20.00"*"no"* ]] || false # still a row, with its price
  : > "$STUB_LOG"
  run "$RAE" resize dev1 cx43
  [ "$status" -eq 1 ]
  [[ $output == *"dev1 cannot move to cx43 in nbg1"* ]] || false
  [ "$(inv dev1 .type)" = cx23 ]
  ! grep -q "terraform" "$STUB_LOG" || false # refused before anything was applied
}
@test "resize keeps the type on an empty answer and never applies" {
  types
  "$RAE" create dev1
  : > "$STUB_LOG"
  run bash -c "echo | '$RAE' resize dev1"
  [ "$status" -eq 0 ]
  [[ $output == *"dev1 is already cx23"* ]] || false
  [ "$(inv dev1 .type)" = cx23 ]
  ! grep -q "terraform" "$STUB_LOG" || false
}

@test "resize of a stopped machine says the type applies at the next start" {
  types
  "$RAE" create dev1
  "$RAE" stop dev1
  run "$RAE" resize dev1 cx22
  [ "$status" -eq 0 ]
  [[ $output == *"not running"* ]] || false
  [ "$(inv dev1 .type)" = cx22 ]
}


@test "start --type boots a stopped machine as another type, from what its location creates now" {
  types
  "$RAE" create dev1
  "$RAE" stop dev1
  : > "$STUB_LOG"
  run "$RAE" start dev1 --type ccx13
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .type)" = ccx13 ]
  [ "$(inv dev1 .state)" = running ]
  [[ $output == *"starts as ccx13 instead of cx23"* ]] || false
  grep -q "terraform: -chdir=terraform apply" "$STUB_LOG"
}

@test "start --type refuses a type the snapshot does not fit or the location does not create" {
  types
  "$RAE" create dev1
  "$RAE" stop dev1
  : > "$STUB_LOG"
  run "$RAE" start dev1 --type cx11 # 20G for a 40G snapshot
  [ "$status" -eq 1 ]
  [[ $output == *"dev1 cannot start as cx11 in nbg1: its disk is smaller than 40G"* ]] || false
  run "$RAE" start dev1 --type cx43 # sold in nbg1, not available there
  [ "$status" -eq 1 ]
  [[ $output == *"dev1 cannot start as cx43 in nbg1"* ]] || false
  run "$RAE" start dev1 --type cx77
  [ "$status" -eq 1 ]
  [[ $output == *"lists the types that work"* ]] || false
  [ "$(inv dev1 .state)" = stopped ] # refused before anything was applied
  [ "$(inv dev1 .type)" = cx23 ]
  ! grep -q terraform "$STUB_LOG" || false
}

@test "a bare start --type asks, with the column saying what can be created" {
  types
  "$RAE" create dev1
  "$RAE" stop dev1
  run bash -c "echo 4 | '$RAE' start dev1 --type" # cheapest first: 4 is ccx13
  [ "$status" -eq 0 ]
  [[ $output == *CREATE* ]] || false
  [[ $output == *"cx11"*"3.00"*"no"*"* cx23"*"8.49"*"yes"*"ccx13"*"12.99"*"yes"*"cx43"*"20.00"*"no"* ]] || false
  [ "$(inv dev1 .type)" = ccx13 ]
}

@test "start without --type leaves the type alone and asks Hetzner nothing" {
  types
  "$RAE" create dev1
  "$RAE" stop dev1
  : > "$STUB_LOG"
  run "$RAE" start dev1
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .type)" = cx23 ]
  ! grep -q server_types "$STUB_LOG" || false
}

@test "a resize Hetzner refuses puts the type back and powers the machine on again" {
  types # STUB_TF_RC=1 is the apply that fails after Terraform has stopped the machine
  "$RAE" create dev1
  : > "$STUB_LOG"
  STUB_TF_RC=1 run "$RAE" resize dev1 ccx13
  [ "$status" -eq 1 ]
  [ "$(inv dev1 .type)" = cx23 ]
  grep -q "http: POST .*servers/7/actions/poweron" "$STUB_LOG"
  [[ $output == *"stayed on cx23"* ]] || false
}
@test "expose updates the inventory and replays the whole Funnel configuration on the machine" {
  "$RAE" create dev1
  run "$RAE" expose dev1 8080
  [ "$status" -eq 0 ]
  [ "$(inv dev1 '.funnel["/"]')" = 8080 ]
  grep -q 'node-ctl-user@dev1 sudo bash -s' "$STUB_LOG"
  [ "$(line_of 'tailscale funnel reset')" -lt "$(line_of 'tailscale funnel --bg --set-path / 8080')" ]
  [[ $output == *"https://dev1.tailtest.ts.net/ -> 8080"* ]] || false # the stub daemon knows the tailnet suffix
  : > "$STUB_LOG"
  STUB_TAILSCALE_IP=100.64.0.7 run "$RAE" expose dev1 3000 /api
  [ "$status" -eq 0 ]
  [ "$(inv dev1 -c .funnel)" = '{"/":8080,"/api":3000}' ]
  [[ $output == *"https://dev1.tailtest.ts.net/api -> 3000"* ]] || false
  grep -q -F 'tailscale funnel --bg --set-path / 8080' "$STUB_LOG"   # every entry again: reset wiped the machine's copy
  grep -q -F 'tailscale funnel --bg --set-path /api 3000' "$STUB_LOG"
  : > "$STUB_LOG"
  "$RAE" expose dev1 --rm /
  [ "$(inv dev1 -c .funnel)" = '{"/api":3000}' ]
  grep -q -F 'tailscale funnel reset' "$STUB_LOG"
  ! grep -q -F 'set-path / 8080' "$STUB_LOG" || false
}

@test "expose without arguments lists, --rm of an unknown path and a bad path are errors" {
  "$RAE" create dev1
  "$RAE" expose dev1 8080
  : > "$STUB_LOG"
  run bash -c "'$RAE' expose dev1 2>/dev/null"
  [ "$status" -eq 0 ]
  [ "$output" = "/ 8080" ]
  ! grep -q "tailscale funnel" "$STUB_LOG" || false
  run "$RAE" expose dev1 --rm /other
  [ "$status" -eq 1 ]
  [[ $output == *"nothing is published at /other on dev1"* ]] || false
  run "$RAE" expose dev1 8080 api
  [ "$status" -eq 1 ]
  [[ $output == *"must start with /"* ]] || false
  run "$RAE" expose dev1 http
  [ "$status" -eq 1 ]
  [[ $output == *"usage: node-ctl expose <name> <port> [/path]"* ]] || false
  [ "$(inv dev1 -c .funnel)" = '{"/":8080}' ]
  ! grep -q "tailscale funnel" "$STUB_LOG" || false # nothing reached the machine
  run "$RAE" expose dev1 --rm
  [ "$status" -eq 1 ]
  [[ $output == *"usage: node-ctl expose <name> --rm </path>"* ]] || false
}

@test "expose on a stopped machine only edits the inventory; start then configures Funnel" {
  "$RAE" create dev1
  "$RAE" stop dev1
  : > "$STUB_LOG"
  run "$RAE" expose dev1 8080
  [ "$status" -eq 0 ]
  [[ $output == *"not running"* ]] || false
  ! grep -q "tailscale funnel" "$STUB_LOG" || false
  run "$RAE" start dev1
  [ "$status" -eq 0 ]
  [ "$(line_of 'cloud-init status --wait')" -lt "$(line_of 'tailscale funnel --bg --set-path / 8080')" ]
  grep -q -F 'tailscale funnel reset' "$STUB_LOG"
}

@test "a machine that publishes nothing gets no Funnel call on start" {
  "$RAE" create dev1
  "$RAE" stop dev1
  : > "$STUB_LOG"
  "$RAE" start dev1
  ! grep -q "tailscale funnel" "$STUB_LOG" || false
}

@test "backup stops docker before restic, restarts it afterwards, never puts secrets on a command line" {
  "$RAE" create dev1
  run "$RAE" backup dev1
  [ "$status" -eq 0 ]
  grep -q 'node-ctl-user@dev1 sudo bash -s' "$STUB_LOG"
  grep -q -F 'export RESTIC_PASSWORD=p\ w' "$STUB_LOG"
  [ "$(line_of 'systemctl stop docker.socket docker')" -lt "$(line_of 'restic backup $paths --tag dev1')" ]
  grep -q -F 'mountpoint -q /mnt/volume || paths="/data /mnt/volume"' "$STUB_LOG" # the volume rides along when there is one
  grep -q -F "trap 'systemctl start docker' EXIT" "$STUB_LOG"
  ! grep 'ssh:' "$STUB_LOG" | grep -q RESTIC || false
}

@test "backup fails early without restic settings" {
  "$RAE" create dev1; : > "$STUB_LOG" # create's own remote script (the git key) is not backup's
  config 'del(.restic.password)'
  run "$RAE" backup dev1
  [ "$status" -eq 1 ]
  [[ $output == *restic.password* ]] || false
  ! grep -q 'bash -s' "$STUB_LOG" || false
}

@test "archive backs up, leaves the tailnet, then removes VPS and volume" {
  "$RAE" create dev1
  run "$RAE" archive dev1
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .state)" = archived ]
  [ "$(line_of 'restic backup $paths --tag dev1')" -lt "$(line_of 'node-ctl-user@dev1 sudo systemd-run --quiet --on-active=2 tailscale logout')" ]
  [ "$(line_of 'node-ctl-user@dev1 sudo systemd-run --quiet --on-active=2 tailscale logout')" -lt "$(line_of 'terraform: -chdir=terraform apply')" ]
}

@test "archive on Hetzner forgets the root disk snapshot it deleted; on Contabo the standard image stays" {
  contabo
  "$RAE" create dev1 --account main
  "$RAE" create cb1 --account cb
  jq '.image = "4242"' "$SERVERS_DIR/dev1.json" > "$BATS_TEST_TMPDIR/x" && mv "$BATS_TEST_TMPDIR/x" "$SERVERS_DIR/dev1.json"
  local standard; standard=$(inv cb1 .image)
  run "$RAE" archive dev1
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .state)" = archived ]
  [ "$(inv dev1 '.image // "none"')" = none ] # the next create boots the base image, not a snapshot that is gone
  run "$RAE" archive cb1
  [ "$status" -eq 0 ]
  [ -n "$standard" ] && [ "$(inv cb1 .image)" = "$standard" ] || false
  run "$RAE" restore cb1
  [ "$status" -eq 0 ]
  [ "$(inv cb1 .image)" = "$standard" ] # a new contract is made from it
}

@test "restore of an archived Hetzner machine that still names its deleted snapshot boots the base image" {
  mkdir -p "$SERVERS_DIR"
  echo '{"state":"archived","account":"main","image":"4242","open_ports":[22],"funnel":{}}' > "$SERVERS_DIR/dev1.json"
  run "$RAE" restore dev1
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .state)" = running ]
  [ "$(inv dev1 '.image // "none"')" = none ]
}

@test "restore starts an archived machine and restores the tagged snapshot" {
  mkdir -p "$SERVERS_DIR"
  echo '{"state":"archived","account":"main","open_ports":[22],"funnel":{}}' > "$SERVERS_DIR/dev1.json"
  run "$RAE" restore dev1
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .state)" = running ]
  [ "$(line_of 'terraform: -chdir=terraform apply')" -lt "$(line_of 'restic restore latest --tag dev1 --target /')" ]
  [ "$(line_of 'systemctl stop docker.socket docker')" -lt "$(line_of 'restic restore latest')" ]
  # docker made that device node on the new machine before the restore: restic cannot overwrite it and would fail
  grep -q -F 'restic restore latest --tag dev1 --target / --exclude /data/docker/volumes/backingFsBlockDev' "$STUB_LOG"
}

@test "restore with a snapshot id skips apply on a running machine" {
  "$RAE" create dev1
  : > "$STUB_LOG"
  run "$RAE" restore dev1 abc123 --yes
  [ "$status" -eq 0 ]
  grep -q -F 'restic restore abc123 --target /' "$STUB_LOG"
  ! grep -q 'terraform: -chdir=terraform apply' "$STUB_LOG" || false
}

@test "restore onto a running machine asks first; a stopped one needs no answer" {
  "$RAE" create dev1
  : > "$STUB_LOG"
  run "$RAE" restore dev1 # stdin is not a terminal here
  [ "$status" -eq 1 ]
  [[ $output == *"pass --yes"* ]] || false
  ! grep -q 'restic restore' "$STUB_LOG" || false
  "$RAE" stop dev1
  run "$RAE" restore dev1
  [ "$status" -eq 0 ]
  grep -q 'restic restore latest --tag dev1' "$STUB_LOG"
}

@test "destroy needs the name typed back, then removes the entry" {
  "$RAE" create dev1
  run bash -c "echo dev1 | '$RAE' destroy dev1" # a pipe is not a confirmation
  [ "$status" -eq 1 ]
  [[ $output == *"pass --yes"* ]] || false
  [ -e "$SERVERS_DIR/dev1.json" ]
  : > "$STUB_LOG"
  run "$RAE" destroy dev1 --yes
  [ "$status" -eq 0 ]
  [ ! -e "$SERVERS_DIR/dev1.json" ]
  grep -q 'node-ctl-user@dev1 sudo systemd-run --quiet --on-active=2 tailscale logout' "$STUB_LOG"
  grep -q 'terraform: -chdir=terraform apply' "$STUB_LOG"
}

@test "destroy deletes the machine's tailnet node last: a logged-out tagged node stays listed otherwise" {
  "$RAE" create dev1
  devices='{"access_token":"at","devices":[{"id":"111","name":"dev1.tail.ts.net","hostname":"dev1","tags":["tag:dev"]}]}'
  : > "$STUB_LOG"
  STUB_CURL_BODY=$devices run "$RAE" destroy dev1 --yes
  [ "$status" -eq 0 ]
  [ "$(line_of 'terraform: -chdir=terraform apply')" -lt "$(line_of 'http: DELETE')" ]
  grep -q "http: DELETE .*api/v2/device/111" "$STUB_LOG"
}

@test "the generated ssh config follows the running machines" {
  conf="$SSH_DIR/config.d/node-ctl"
  "$RAE" create dev1
  "$RAE" create dev2
  grep -qx "Host node-ctl-dev1" "$conf"
  grep -q "  User node-ctl-user" "$conf"
  grep -q "  UserKnownHostsFile /dev/null" "$conf" # same host-key stance as node-ctl ssh
  "$RAE" stop dev2
  ! grep -qx "Host node-ctl-dev2" "$conf" || false # a stopped machine has no address to offer
  "$RAE" destroy dev1 --yes
  ! grep -qx "Host node-ctl-dev1" "$conf" || false
  ! grep -q "^Host" "$conf" || false # the file stays, empty of hosts: nothing else is left to ssh to
}

@test "a machine that becomes ready replaces its host keys in ~/.ssh/known_hosts" {
  export STUB_TAILSCALE_IP=100.64.0.1
  known="$SSH_DIR/known_hosts"
  mkdir -p "$SSH_DIR"
  printf '100.64.0.1 ssh-ed25519 AAAAstale\ndev1.tailtest.ts.net ssh-ed25519 AAAAstale\nelsewhere ssh-ed25519 AAAAkeep\n' > "$known"
  run "$RAE" create dev1
  [ "$status" -eq 0 ]
  ! grep -q AAAAstale "$known" || false # the key of the machine this one replaced is gone
  grep -qx "100.64.0.1 ssh-ed25519 AAAAhostkey-100.64.0.1" "$known"
  grep -qx "dev1 ssh-ed25519 AAAAhostkey-dev1" "$known"
  grep -qx "dev1.tailtest.ts.net ssh-ed25519 AAAAhostkey-dev1.tailtest.ts.net" "$known"
  grep -q AAAAkeep "$known" # another host's entry is untouched
  # every start rebuilds the machine, so every start refreshes the keys
  : > "$known"
  "$RAE" stop dev1
  run "$RAE" start dev1
  [ "$status" -eq 0 ]
  grep -qx "100.64.0.1 ssh-ed25519 AAAAhostkey-100.64.0.1" "$known"
}

@test "a name nothing answers under still loses its stale host key" {
  export STUB_KEYSCAN_RC=1
  known="$SSH_DIR/known_hosts"
  mkdir -p "$SSH_DIR"
  printf 'dev1 ssh-ed25519 AAAAstale\n' > "$known"
  run "$RAE" create dev1
  [ "$status" -eq 0 ] # a key that cannot be recorded never stops a create
  ! grep -q AAAAstale "$known" || false
  [[ $output == *"could not record dev1's host key"* ]] || false
}

@test "a machine that becomes ready gets its key into Orca's own store too" {
  export STUB_TAILSCALE_IP=100.64.0.1
  store="$ORCA_PROFILES/local-default/ssh-host-keys.json"
  mkdir -p "$(dirname "$store")"
  printf '{"version":1,"hostKeys":[{"host":"100.64.0.1","port":22,"keyType":"ssh-ed25519","key":"AAAAstale","fingerprint":"SHA256:stale","acceptedAt":"2026-09-17T11:40:27.476Z"},{"host":"elsewhere","port":22,"keyType":"ssh-ed25519","key":"AAAAkeep"}]}' > "$store"
  run "$RAE" create dev1
  [ "$status" -eq 0 ]
  [ "$(jq -r '.version' "$store")" = 1 ] # the store keeps its shape; Orca reads it, not us
  [ "$(jq -r '.hostKeys | map(select(.host == "100.64.0.1")) | length' "$store")" = 1 ]
  [ "$(jq -r '.hostKeys[] | select(.host == "100.64.0.1") | .key' "$store")" = "AAAAhostkey-100.64.0.1" ]
  [ "$(jq -r '.hostKeys[] | select(.host == "100.64.0.1") | .fingerprint' "$store")" = "SHA256:fp-AAAAhostkey-100.64.0.1" ]
  [ "$(jq -r '.hostKeys[] | select(.host == "100.64.0.1") | .port' "$store")" = 22 ]
  [ "$(jq -r '.hostKeys[] | select(.host == "elsewhere") | .key' "$store")" = AAAAkeep ] # another host is untouched
}

@test "Orca's store loses the stale entry of a name nothing answers under, and a broken store is left alone" {
  export STUB_KEYSCAN_RC=1
  store="$ORCA_PROFILES/local-default/ssh-host-keys.json"
  mkdir -p "$(dirname "$store")"
  printf '{"version":1,"hostKeys":[{"host":"dev1","port":22,"key":"AAAAstale"}]}' > "$store"
  run "$RAE" create dev1
  [ "$status" -eq 0 ]
  [ "$(jq -r '.hostKeys | length' "$store")" = 0 ]
  printf 'not json at all' > "$store"
  run "$RAE" create dev2
  [ "$status" -eq 0 ] # a store we cannot read is not ours to repair, and never fails a create
  [ "$(cat "$store")" = "not json at all" ]
  [ ! -e "$store.tmp" ]
}

@test "no Orca on this computer is no reason to fail" {
  rm -rf "$ORCA_PROFILES"
  run "$RAE" create dev1
  [ "$status" -eq 0 ]
  [ ! -e "$ORCA_PROFILES" ] # nothing is created where Orca is not installed
}

@test "hostkeys records the keys of a machine that already runs" {
  export STUB_TAILSCALE_IP=100.64.0.1
  known="$SSH_DIR/known_hosts"
  store="$ORCA_PROFILES/local-default/ssh-host-keys.json"
  mkdir -p "$(dirname "$store")"
  "$RAE" create dev1
  printf '100.64.0.1 ssh-ed25519 AAAAstale\n' > "$known" # rebuilt behind the CLI's back
  printf '{"version":1,"hostKeys":[{"host":"100.64.0.1","port":22,"key":"AAAAstale"}]}' > "$store"
  run "$RAE" hostkeys dev1
  [ "$status" -eq 0 ]
  [[ $output == *"host keys of dev1 recorded"* ]] || false
  ! grep -q AAAAstale "$known" || false
  grep -qx "100.64.0.1 ssh-ed25519 AAAAhostkey-100.64.0.1" "$known"
  [ "$(jq -r '.hostKeys[] | select(.host == "100.64.0.1") | .key' "$store")" = "AAAAhostkey-100.64.0.1" ]
  run "$RAE" hostkeys dev2
  [ "$status" -eq 1 ]
  [[ $output == *"unknown machine"* || $output == *"dev2"* ]] || false
  "$RAE" stop dev1
  run "$RAE" hostkeys dev1
  [ "$status" -eq 1 ]
  [[ $output == *"not running"* ]] || false # a stopped machine has no address to ask
}

@test "init prepends the include to an existing ssh config" {
  blank
  mkdir -p "$SSH_DIR"
  printf 'Host *\n  ServerAliveInterval 60\n' > "$SSH_DIR/config"
  answers "" tok "" ""
  run "$RAE" init < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  [ "$(head -1 "$SSH_DIR/config")" = "Include config.d/node-ctl" ] # first: in ssh_config the first value of a keyword wins
  grep -q "ServerAliveInterval 60" "$SSH_DIR/config" # the user's own config is kept
  answers "" # everything verifies now, so the second run only has to skip archives again
  run "$RAE" init < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  [ "$(grep -c "Include config.d/node-ctl" "$SSH_DIR/config")" -eq 1 ] # idempotent
}

@test "list prints one row per machine" {
  "$RAE" create dev1
  "$RAE" expose dev1 8080 /app
  run "$RAE" list
  [ "$status" -eq 0 ]
  [[ $output == *"NAME  ACCOUNT  STATE     UPTIME  AUTOSTOP  IPV4  TAILSCALE  PORTS  FUNNEL"*"─────"*"dev1  main     starting  0m      -         -     -          22     /app -> 8080"* ]] || false # the tailnet does not see it yet
  [[ $output != *$'\e['* ]] || false # no colour codes off a tty
  : > "$STUB_LOG"
  STUB_TAILSCALE_PEERS=dev1=online run "$RAE" list
  [[ $output == *"dev1  main     ready  0m      -         -     dev1.tailtest.ts.net  22     https://dev1.tailtest.ts.net/app -> 8080"* ]] || false
  grep -q "tailscale: status --json" "$STUB_LOG"
  ! grep -q "tailscale: ip" "$STUB_LOG" || false # one call for the whole table
  STUB_TAILSCALE_PEERS=dev1=online run bash -c "'$RAE' list --json 2>/dev/null"
  [ "$(jq -r '.[0].tailscale' <<< "$output")" = dev1.tailtest.ts.net ]
  [ "$(jq -r '.[0].state' <<< "$output")" = ready ]
  FORCE_COLOR=1 run "$RAE" list
  [[ $output == *$'\e['* ]] || false
  FORCE_COLOR=1 NO_COLOR=1 run "$RAE" list
  [[ $output != *$'\e['* ]] || false
}

@test "list shows how long a running machine has been up and when its timer stops it" {
  macos_only
  "$RAE" create dev1; "$RAE" create dev2; "$RAE" stop dev2
  [ "$(inv dev1 .started)" -le "$(date +%s)" ]
  [ "$(inv dev1 .started)" -gt $(($(date +%s) - 60)) ]
  "$RAE" start dev2 --till "2099-06-01 18:30"
  jq '.started -= 3 * 86400 + 4 * 3600' "$SERVERS_DIR/dev2.json" > "$BATS_TEST_TMPDIR/j" && mv "$BATS_TEST_TMPDIR/j" "$SERVERS_DIR/dev2.json"
  run "$RAE" list
  [[ $output == *"NAME  ACCOUNT  STATE     UPTIME  AUTOSTOP          IPV4"* ]] || false
  [[ $output == *"dev1  main     starting  0m      -                 -"* ]] || false
  [[ $output == *"dev2  main     starting  3d04h   2099-06-01 18:30  -"* ]] || false
  run bash -c "'$RAE' list --json 2>/dev/null"
  [ "$(jq -r '.[1].stops_at' <<< "$output")" = "$(date -j -f '%Y-%m-%d %H:%M:%S' '2099-06-01 18:30:00' +%s)" ]
  [ "$(jq -r '.[0].stops_at' <<< "$output")" = null ]
  [ "$(jq -r '.[0].started' <<< "$output")" = "$(inv dev1 .started)" ]
  "$RAE" stop dev1
  run "$RAE" list # a stopped machine is not up, and has no timer
  [[ $output == *"dev1  main     stopped   -       -                 -"* ]] || false
}

@test "list --json is machine-readable" {
  "$RAE" create dev1 --ports 22,8080
  "$RAE" expose dev1 8080
  run bash -c "'$RAE' list --json 2>/dev/null"
  [ "$status" -eq 0 ]
  [ "$(jq -r '.[0].name' <<< "$output")" = dev1 ]
  [ "$(jq -c '.[0].open_ports' <<< "$output")" = "[22,8080]" ]
  [ "$(jq -r '.[0].funnel["/"]' <<< "$output")" = 8080 ]
  [ "$(jq -r '.[0].ipv4' <<< "$output")" = null ]
  [ "$(jq -r '.[0].ipv6' <<< "$output")" = null ]
  [ "$(jq -r '.[0].tailscale' <<< "$output")" = null ]
  [ "$(jq -r '.[0].state' <<< "$output")" = starting ]
  rm "$SERVERS_DIR/dev1.json"
  run "$RAE" list --json
  [ "$output" = "[]" ]
}

@test "list tells a machine the tailnet sees from one it does not, and hides a stopped machine's leftover node" {
  "$RAE" create dev1; "$RAE" create dev2; "$RAE" stop dev2
  STUB_TAILSCALE_PEERS="dev1=offline dev2=offline" run bash -c "'$RAE' list --json 2>/dev/null"
  [ "$(jq -r 'map("\(.name) \(.state) \(.tailscale)") | join(",")' <<< "$output")" = "dev1 starting null,dev2 stopped null" ]
  STUB_TAILSCALE_PEERS="dev1=online dev2=online" run bash -c "'$RAE' list --json 2>/dev/null"
  [ "$(jq -r 'map("\(.name) \(.state) \(.tailscale)") | join(",")' <<< "$output")" = "dev1 ready dev1.tailtest.ts.net,dev2 stopped null" ]
  STUB_TAILSCALE_DOWN=1 run bash -c "'$RAE' list --json 2>/dev/null" # a stopped tailnet says nothing about the machines
  [ "$status" -eq 0 ]
  [ "$(jq -r '.[0].state' <<< "$output")" = starting ]
}

@test "list keeps the inventory word when this host has no Tailscale CLI at all" {
  [ ! -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] || skip "Tailscale.app is installed here and found by its absolute path"
  "$RAE" create dev1
  mkdir "$BATS_TEST_TMPDIR/nots"; ln -s "$BATS_TEST_DIRNAME"/stubs/* "$BATS_TEST_TMPDIR/nots/"; rm "$BATS_TEST_TMPDIR/nots/tailscale"
  PATH="$BATS_TEST_TMPDIR/nots:${PATH#*/stubs:}" run bash -c "'$RAE' list --json 2>/dev/null"
  [ "$(jq -r '.[0].state' <<< "$output")" = running ]
}

@test "load runs the metrics script on the machine" {
  "$RAE" create dev1; : > "$STUB_LOG"
  run "$RAE" load dev1
  [ "$status" -eq 0 ]
  grep -q 'node-ctl-user@dev1 bash -s -- once mono' "$STUB_LOG"
  grep -q -F '/proc/loadavg' "$STUB_LOG"
  grep -q -F 'vmstat 1 2' "$STUB_LOG"
  grep -q -F '/proc/diskstats' "$STUB_LOG"
  grep -q -F 'df -m /' "$STUB_LOG"
  ! grep -q sudo "$STUB_LOG" || false # reading the load needs no root
  run "$RAE" load -f dev1
  [ "$status" -eq 0 ]
  grep -q 'node-ctl-user@dev1 bash -s -- plain mono' "$STUB_LOG" # the loop runs on the machine, one ssh for the whole stream
  FORCE_COLOR=1 run "$RAE" load dev1
  grep -q 'bash -s -- once color' "$STUB_LOG" # colours are decided here, the machine only gets the word
  run "$RAE" load --wat dev1
  [ "$status" -ne 0 ]
  run "$RAE" load nope
  [ "$status" -ne 0 ]
  [[ $output == *"no such machine: nope"* ]] || false
}

@test "load without a name samples every running machine in parallel, one row each" {
  "$RAE" create dev1; "$RAE" create longname2; "$RAE" create dev3
  "$RAE" stop dev3 # not running: no row
  : > "$STUB_LOG"
  STUB_SSH_OUT='[||      ]  20%  ROW' run "$RAE" load
  [ "$status" -eq 0 ]
  [ "$(grep -c 'bash -s -- once mono row' "$STUB_LOG")" -eq 2 ]
  [[ ${lines[0]} == "NAME       CPU"* ]] || false # the name column is as wide as the longest name
  [[ $output == *"dev1       [||      ]  20%  ROW"* ]] || false
  [[ $output == *"longname2  [||      ]  20%  ROW"* ]] || false
  [[ $output != *dev3* ]] || false
  STUB_SSH_RC=255 run "$RAE" load
  [[ $output == *"dev1       unreachable"* ]] || false
  run "$RAE" load -f
  [ "$status" -eq 0 ] # the table ends once every stream has
  grep -q 'bash -s -- plain mono row' "$STUB_LOG"
  "$RAE" stop --all
  run "$RAE" load
  [ "$status" -eq 1 ]
  [[ $output == *"no running machine"* ]] || false
}

@test "every command has a --help page, answered before the config is read and without touching anything" {
  # the dispatch table is the list of commands: one added there without a page fails here
  cmds=$(cd "$BATS_TEST_DIRNAME/.." && bun -e 'const { COMMANDS } = await import("./src/cli.ts"); console.log(COMMANDS.join(" "))')
  [ "$(wc -w <<< "$cmds")" -gt 20 ]
  export NODE_CTL_CONFIG=$BATS_TEST_TMPDIR/missing.yaml
  for c in $cmds help; do
    for h in --help -h; do
      run bash -c "'$RAE' $c $h 2>/dev/null"
      [ "$status" -eq 0 ]
      [[ $output == "usage: node-ctl $c"* ]] || false
    done
    run bash -c "'$RAE' help $c 2>/dev/null"
    [ "$status" -eq 0 ]
    [[ $output == "usage: node-ctl $c"* ]] || false
  done
  run "$RAE" create dev1 --type cx23 --help
  [ "$status" -eq 0 ]
  [[ $output == *"--location loc"* ]] || false
  [ ! -s "$STUB_LOG" ]
  [ ! -e "$SERVERS_DIR/dev1.json" ]
}

@test "ssh passes --help after the name to the machine" {
  run "$RAE" ssh dev1 ls --help
  [ "$status" -eq 0 ]
  grep -q "node-ctl-user@dev1 ls --help" "$STUB_LOG"
}

@test "help for an unknown command is an error" {
  run "$RAE" frobnicate --help
  [ "$status" -eq 1 ]
  [[ $output == *"unknown command: frobnicate"* ]] || false
  run "$RAE" help frobnicate
  [ "$status" -eq 1 ]
}

@test "unknown command prints usage" {
  run "$RAE" frobnicate
  [ "$status" -eq 1 ]
  [[ $output == "node-ctl: unknown command: frobnicate"*"usage:"* ]] || false
  run "$RAE"
  [ "$status" -eq 1 ]
  [[ $output == "usage:"* ]] || false
}

# --- check -----------------------------------------------------------------------------------

@test "check probes Hetzner, Tailscale and restic with the configured credentials" {
  run "$RAE" check
  [ "$status" -eq 0 ]
  [ "$output" = "all good" ]
  [ -z "$(ev 'select(.event_type == "failed")')" ]
  completed=$(ev 'select(.event_type == "completed") | .action_name')
  for name in Host terraform ssh restic "$NODE_CTL_CONFIG" accounts tailscale.client_id "Hetzner token (main)" "restic repository" Credentials "Tailscale on this host" Tailnet; do
    grep -qxF "$name" <<< "$completed" || false
  done
  # the binary reads YAML, edits JSON and calls the APIs itself: none of these is needed on the host
  for name in jq yq curl node; do ! grep -qxF "$name" <<< "$completed" || false; done
  [ "$(ev 'select(.event_type == "log" and .action_name == "accounts") | .message')" = hetzner/main ] # the accounts, by provider and tag
  [ "$(ev 'select(.event_type == "planned") | [.index, .total_steps] | @csv' | paste -s -d ' ' -)" = "1,4 2,4 3,4 4,4" ]
  grep -q "http: GET https://api.hetzner.cloud/.* auth=Bearer t$" "$STUB_LOG"
  grep -q "http: POST https://api.tailscale.com/.*oauth/token body=client_id=i&client_secret=tskey-client-s" "$STUB_LOG"
  grep -q "restic: cat config" "$STUB_LOG"
  grep -q "http: GET .*tailnet/-/devices auth=Bearer at" "$STUB_LOG"
  grep -q "tailscale: status" "$STUB_LOG"
  ! grep -q "node-ctl-user@" "$STUB_LOG" || false # no machine runs, so there is nothing to reach
  ! grep -q "restic: init" "$STUB_LOG" || false
}

@test "check reaches a running machine over the tailnet, and reports one that does not answer" {
  "$RAE" create dev1; "$RAE" create dev2; : > "$STUB_LOG"
  run "$RAE" check
  [ "$status" -eq 0 ]
  grep -q "BatchMode=yes node-ctl-user@dev1 true" "$STUB_LOG" # one machine is proof enough
  ! grep -q "node-ctl-user@dev2" "$STUB_LOG" || false
  STUB_SSH_RC=255 STUB_SSH_ERR="ssh: Could not resolve hostname dev1" run "$RAE" check
  [ "$status" -eq 1 ]
  [[ $(ev 'select(.event_type == "failed" and .action_name == "node-ctl-user@dev1") | .message') == *"MagicDNS"*"Could not resolve hostname dev1"* ]] || false
  [ "$(ev 'select(.event_type == "failed" and .action_name == "Tailnet") | .message')" = "1 of 2 checks failed" ]
  STUB_TAILSCALE_DOWN=1 run "$RAE" check
  [ "$status" -eq 1 ]
  [[ $(ev 'select(.event_type == "failed" and .action_name == "Tailscale on this host") | .message') == *"not running"* ]] || false
}

@test "check runs the credential probes as parallel children of Credentials, one per Hetzner account" {
  config '.hetzner.work = "t2"'
  run "$RAE" check
  [ "$status" -eq 0 ]
  parent=$(id_of Credentials)
  [ "$(ev "select(.event_type == \"started\" and .parent_action_id == \"$parent\") | .action_id" | sort | paste -s -d ' ' -)" = "c1-main c1-work c2 c3" ]
  grep -q "http: GET https://api.hetzner.cloud/.* auth=Bearer t$" "$STUB_LOG"
  grep -q "http: GET https://api.hetzner.cloud/.* auth=Bearer t2$" "$STUB_LOG"
  # all of them start before any finishes
  first_done=$(grep -n '"event_type":"completed"' "$STUB_EVENTS" | grep -E '"action_id":"c[123]' | head -1 | cut -d: -f1)
  last_start=$(grep -n '"event_type":"started"' "$STUB_EVENTS" | grep -E '"action_id":"c[123]' | tail -1 | cut -d: -f1)
  [ "$last_start" -lt "$first_done" ]
}

@test "check initialises an empty restic repository" {
  STUB_FAIL=restic-cat run "$RAE" check
  [ "$status" -eq 0 ]
  grep -q "restic: init" "$STUB_LOG"
}

@test "check stops at an empty value before touching the network" {
  config '.tailscale.client_secret = ""'
  run "$RAE" check
  [ "$status" -eq 1 ]
  [ "$(ev 'select(.event_type == "failed" and .action_name == "tailscale.client_secret") | .message')" = "empty: run node-ctl init" ]
  [[ $output == *"fix the failed checks"* ]] || false
  ! grep -q "http:" "$STUB_LOG" || false
  config '.hetzner = {}'
  run "$RAE" check
  [ "$status" -eq 1 ]
  [ "$(ev 'select(.event_type == "failed" and .action_name == "accounts") | .message')" = "no account: run node-ctl init hetzner, or node-ctl init contabo" ]
  ! grep -q "http:" "$STUB_LOG" || false
}

@test "check reports a rejected credential and exits non-zero" {
  STUB_FAIL=curl run "$RAE" check
  [ "$status" -eq 1 ]
  [[ $(ev 'select(.event_type == "failed" and .action_name == "Hetzner token (main)") | .message') == *"401"* ]] || false
  [ -n "$(ev 'select(.event_type == "failed" and .action_name == "Tailscale OAuth client")')" ]
  [ -n "$(ev 'select(.event_type == "failed" and .action_name == "Credentials")')" ]
}

@test "check refuses a broken configuration file and says what is missing" {
  echo 'hetzner: [' > "$NODE_CTL_CONFIG"
  run "$RAE" check
  [ "$status" -eq 1 ]
  [[ $output == *"$NODE_CTL_CONFIG is not valid YAML"* ]] || false
  rm "$NODE_CTL_CONFIG"
  run "$RAE" check
  [ "$status" -eq 1 ]
  [ "$(ev "select(.event_type == \"failed\" and .action_name == \"$NODE_CTL_CONFIG\") | .message")" = "missing: run node-ctl init" ]
}

# --- init ------------------------------------------------------------------------------------

answers() { printf '%s\n' "$@" > "$BATS_TEST_TMPDIR/answers"; }
# Nothing configured but the ssh key and a Tailscale client: the hetzner step asks for a tag (enter keeps
# the suggested "main"), its token, and a tag for one more account (empty = done); restic asks for the bucket.
blank() { config '.hetzner = {} | .restic = {} | .tailscale = {"client_id": "cid", "client_secret": "tskey-client-c"}'; }

@test "accounts lists every cloud account with the machines it holds" {
  config '.hetzner.work = "t2" | .contabo.cb = {"client_id": "ci", "client_secret": "cs", "user": "u@e", "password": "pw"}'
  "$RAE" create dev1 --account main
  "$RAE" create dev2 --account main
  "$RAE" create dev3 --account cb
  run "$RAE" accounts
  [ "$status" -eq 0 ]
  [ "$(sed -n '3,5p' <<< "$output")" = "hetzner  main     2
hetzner  work     0
contabo  cb       1" ]
  run "$RAE" accounts --json
  [ "$status" -eq 0 ]
  [ "$(jq -c 'map([.provider, .tag, .machines])' <<< "$output")" = '[["hetzner","main",2],["hetzner","work",0],["contabo","cb",1]]' ]
}

@test "accounts says so when no cloud account is configured" {
  config '.hetzner = {}'
  run "$RAE" accounts
  [ "$status" -eq 0 ]
  [[ $output == *"no cloud account in"* ]] || false
  run "$RAE" accounts --json
  [ "$status" -eq 0 ]
  [ "$output" = "[]" ]
}

@test "accounts add asks the cloud, then that cloud's step, and applies" {
  answers 2 cb ci cs u@e pw ""
  run "$RAE" accounts add < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  [ "$(cfg .contabo.cb.user)" = "u@e" ]
  [ "$(cfg .hetzner.main)" = t ] # the other steps of init are not asked
  ! grep -q "api.tailscale.com/api/v2/oauth/token" "$STUB_LOG" || false
  grep -q "http: POST https://auth.contabo.com/.* body=.*client_id=ci" "$STUB_LOG"
  grep -q "terraform: -chdir=terraform apply" "$STUB_LOG" # the ssh key is registered with the new account
  [ "$(ev 'select(.event_type == "planned") | .action_name' | paste -s -d , -)" = "contabo,Apply Terraform" ]
}

@test "accounts add asks again for an empty tag, since adding one is the point" {
  answers "" cb ci cs u@e pw ""
  run "$RAE" accounts add contabo < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  said "a tag is needed to add an account" || false
  [[ $output == *"A tag is needed"* ]] || false # and the prompt does not offer "empty = done" before the first one
  [ "$(cfg .contabo.cb.user)" = "u@e" ]
  answers cb2 ci cs u@e pw "" # once one is added, empty ends the dialogue as it does in init
  run "$RAE" accounts add contabo < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  [ "$(cfg '.contabo | keys | join(" ")')" = "cb cb2" ]
  answers ""
  run "$RAE" init contabo < "$BATS_TEST_TMPDIR/answers" # init keeps the skippable step it always had
  [ "$status" -eq 0 ]
  [[ $output != *"a tag is needed"* ]] || false
}

@test "a question drains the renderer first, so its lines never land inside the prompt" {
  answers main tok2 ""
  run "$RAE" init hetzner < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  [ "$(ev 'select(.event_type == "completed" and .action_name == "Hetzner token (main)")' | wc -l)" -eq 1 ] # and no event is lost across the question
  # as plain lines: the step, then the question, then the check, none inside another
  answers main tok3 ""
  NODE_CTL_PROGRESS=plain run "$RAE" init hetzner < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  n() { grep -n -F -- "$1" <<< "$output" | head -1 | cut -d: -f1; }
  [ "$(n 'START hetzner')" -lt "$(n 'Hetzner account: a short tag')" ]
  [ "$(n 'Hetzner account: a short tag')" -lt "$(n 'START Hetzner token (main)')" ]
  grep -qx 'Hetzner account: a short tag.*' <<< "$output" # a line of its own
}

@test "accounts edit replaces the credentials of a tag that already works" {
  answers main tok2 ""
  run "$RAE" accounts edit hetzner < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  [ "$(cfg .hetzner.main)" = tok2 ]
  [[ $output != *"kept"* ]] || false # an explicit edit asks, where init would keep a working token
  grep -q "http: GET https://api.hetzner.cloud/.* auth=Bearer tok2$" "$STUB_LOG"
}

@test "accounts refuses an unknown cloud and an unknown subcommand" {
  run "$RAE" accounts add nope
  [ "$status" -eq 1 ]
  [[ $output == *"not a cloud: nope (hetzner, contabo)"* ]] || false
  run "$RAE" accounts bogus
  [ "$status" -eq 1 ]
  [[ $output == *"usage: node-ctl accounts"* ]] || false
}

@test "init asks step by step, verifies every group and writes node-ctl.yaml" {
  blank
  answers "" tok "" s3:https://e/b akid asec "" # the ssh key and the preset tailscale client verify and are kept
  run "$RAE" init < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  [[ $output == *"done: node-ctl create dev1"* ]] || false
  [ "$(cfg .hetzner.main)" = tok ]
  [ "$(cfg .tailscale.client_id)" = cid ]
  [ "$(cfg .restic.repository)" = "s3:https://e/b" ]
  [ "$(cfg .restic.secret_access_key)" = asec ]
  [ "$(cfg .restic.password | wc -c)" -gt 30 ]
  [ "$(cfg .ssh_public_key_file)" = "$SSH_PUBLIC_KEY_FILE" ]
  [ "$(line_of 'api.hetzner.cloud')" -lt "$(line_of 'api.tailscale.com/api/v2/oauth/token')" ] # one credential group verified per step, in order
  [ "$(line_of 'api.tailscale.com/api/v2/oauth/token')" -lt "$(line_of 'restic: cat config')" ]
  grep -q "http: GET https://api.hetzner.cloud/.* auth=Bearer tok$" "$STUB_LOG"
}

@test "init seeds a missing node-ctl.yaml from the example and keeps its comments" {
  rm "$NODE_CTL_CONFIG"
  answers "$SSH_PUBLIC_KEY_FILE" "" tok "" ""
  run "$RAE" init ssh hetzner restic < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  [ "$(cfg .hetzner.main)" = tok ]
  [ "$(cfg .ssh_public_key_file)" = "$SSH_PUBLIC_KEY_FILE" ]
  grep -q "^# Hetzner Cloud accounts" "$NODE_CTL_CONFIG"
  grep -q "^#  location: nbg1" "$NODE_CTL_CONFIG"
}

@test "init hetzner takes several accounts, one tag and token at a time, and verifies each" {
  answers work tok2 home tok3 ""
  run "$RAE" init hetzner < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  [ "$(cfg '.hetzner | to_entries | map(.key + "=" + .value) | join(" ")')" = "main=t work=tok2 home=tok3" ]
  for t in t tok2 tok3; do grep -q "http: GET https://api.hetzner.cloud/.* auth=Bearer $t$" "$STUB_LOG"; done
  [ "$(ev 'select(.event_type == "completed" and (.action_name | startswith("Hetzner token"))) | .action_name' | sort | paste -s -d , -)" = "Hetzner token (home),Hetzner token (main),Hetzner token (work)" ]
  [[ $output == *"Configured: main"* ]] || false # the existing accounts are named, so a tag of theirs replaces a token
  answers "Bad Tag" work tok4 ""
  run "$RAE" init hetzner < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  said "a tag is lowercase letters" || false
  [ "$(cfg .hetzner.work)" = tok4 ]
  [ "$(cfg '.hetzner | length')" = 3 ]
}

@test "init creates the Tailscale OAuth client when the id is left empty" {
  config '.tailscale = {}' # everything else verifies and is kept: the only questions are the client id and the API key
  answers "" apikey
  run "$RAE" init < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  [ "$(cfg .tailscale.client_id)" = kid ]
  [ "$(cfg .tailscale.client_secret)" = tskey-client-k ]
  grep -q 'http: POST .*tailnet/-/acl auth=Basic apikey body=' "$STUB_LOG"
  grep -q '"autogroup:admin"' "$STUB_LOG" # the tagOwners entry was posted back
  grep -q 'http: POST .*tailnet/-/keys auth=Basic apikey body={"keyType":"client","scopes":\["auth_keys","devices:core"\],"tags":\["tag:dev"\]' "$STUB_LOG"
  ! grep -q "apikey" "$NODE_CTL_CONFIG" || false
}

@test "init repeats a step until its check passes" {
  blank
  answers "" bad1 "" main bad2 "" # the second round names the account, since main exists by then
  STUB_FAIL=curl run "$RAE" init < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 1 ]
  [ "$(ev 'select(.event_type == "log" and .message == "-> try again")' | wc -l)" -eq 2 ]
  [ "$(ev 'select(.event_type == "failed" and .action_name == "Hetzner token (main)")' | wc -l)" -eq 2 ] # both attempts, under the hetzner step
  [ "$(ev 'select(.event_type == "failed" and .action_name == "Hetzner token (main)") | .parent_action_id' | sort -u)" = "$(id_of hetzner)" ]
  [[ $output == *"aborted"* ]] || false
  [ "$(cfg .hetzner.main)" = bad2 ]
  ! grep -q "api.tailscale.com" "$STUB_LOG" || false
  ! grep -q "terraform" "$STUB_LOG" || false # nothing is applied while a credential is still broken
}

@test "check rejects a Tailscale auth key passed as an OAuth client" {
  config '.tailscale.client_id = "tskey-auth-k1" | .tailscale.client_secret = "tskey-auth-k1"'
  run "$RAE" check
  [ "$status" -eq 1 ]
  [[ $(ev 'select(.event_type == "failed" and .action_name == "Tailscale OAuth client") | .message') == "the client id is a tskey-* key"* ]] || false
  ! grep -q "api.tailscale.com" "$STUB_LOG" || false
  config '.tailscale.client_id = "k1" | .tailscale.client_secret = "tskey-auth-k1"'
  : > "$STUB_EVENTS"
  run "$RAE" check
  [ "$status" -eq 1 ]
  [[ $(ev 'select(.event_type == "failed" and .action_name == "Tailscale OAuth client") | .message') == "the secret must start with tskey-client-"* ]] || false
}

@test "init tailscale verifies the Tailscale client only" {
  answers k1 tskey-client-s
  run "$RAE" init tailscale < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  grep -q "api.tailscale.com" "$STUB_LOG"
  grep -q 'http: POST .*tailnet/-/keys auth=Bearer at body={"capabilities":{"devices":{"create":{"tags":\["tag:dev"\]' "$STUB_LOG" # the key Terraform mints
  grep -q 'http: DELETE .*tailnet/-/keys/kid' "$STUB_LOG"
  ! grep -q "api.hetzner.cloud" "$STUB_LOG" || false
  ! grep -q "restic:" "$STUB_LOG" || false
}

# --- restic is optional ----------------------------------------------------------------------

@test "check skips archives when restic.repository is empty" {
  config '.restic = {}'
  run "$RAE" check
  [ "$status" -eq 0 ]
  [[ $(ev 'select(.event_type == "log" and .action_name == "restic.repository") | .message') == "empty: archives disabled"* ]] || false
  [[ $(ev 'select(.event_type == "log" and .action_name == "restic.secret_access_key") | .message') == "empty: archives disabled"* ]] || false
  [ "$(ev 'select(.event_type == "completed" and .action_name == "restic repository") | .message')" = "archives disabled" ]
  [ -z "$(ev 'select(.event_type == "failed")')" ]
  grep -q "api.hetzner.cloud" "$STUB_LOG"
  ! grep -q "restic:" "$STUB_LOG" || false
}

@test "check skips a half-configured archive storage without failing" {
  config '.restic.password = "" | del(.restic.secret_access_key)'
  run "$RAE" check
  [ "$status" -eq 0 ]
  [ -z "$(ev 'select(.event_type == "log" and .action_name == "restic.repository")')" ]
  [[ $(ev 'select(.event_type == "log" and .action_name == "restic.password") | .message') == "empty: archives disabled"* ]] || false
  [ "$(ev 'select(.event_type == "completed" and .action_name == "restic repository") | .message')" = "archives disabled" ]
  [ -z "$(ev 'select(.event_type == "failed")')" ]
  grep -q "api.hetzner.cloud" "$STUB_LOG"
  ! grep -q "restic:" "$STUB_LOG" || false
}

@test "init skips archives when the bucket is left empty" {
  blank
  answers "" tok "" ""
  run "$RAE" init < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  [[ $output == *"done: node-ctl create dev1"* ]] || false
  grep -q "terraform: -chdir=terraform apply -input=false -no-color -auto-approve (workspace main, account main, token tok)" "$STUB_LOG" # the ssh key is registered before the first create
  [ "$(cfg .restic.repository)" = "" ]
  ! grep -q "restic: cat config" "$STUB_LOG" || false
}

@test "backup without archive storage points at init" {
  "$RAE" create dev1
  config '.restic.repository = ""'
  run "$RAE" backup dev1
  [ "$status" -eq 1 ]
  [[ $output == *"restic.repository is not set"*"node-ctl init"* ]] || false
}

# --- ssh key in the agent --------------------------------------------------------------------

@test "commands that use ssh load the private key into the agent once" {
  : > "${SSH_PUBLIC_KEY_FILE%.pub}"
  run "$RAE" create dev1
  [ "$status" -eq 0 ]
  [[ $output == *"loading ${SSH_PUBLIC_KEY_FILE%.pub} into ssh-agent"* ]] || false
  grep -q "^ssh-add: .*${SSH_PUBLIC_KEY_FILE%.pub}$" "$STUB_LOG" # macOS adds --apple-use-keychain
  [ "$(line_of 'ssh-add: ')" -lt "$(line_of 'terraform: -chdir')" ]
  : > "$STUB_LOG"
  STUB_AGENT_KEYS="ssh-ed25519 AAAA test" run "$RAE" stop dev1
  [ "$status" -eq 0 ]
  ! grep -q "^ssh-add: .*${SSH_PUBLIC_KEY_FILE%.pub}$" "$STUB_LOG" || false
}

@test "a public key without its private half is left to ssh" {
  run "$RAE" create dev1
  [ "$status" -eq 0 ]
  ! grep -q "ssh-add:" "$STUB_LOG" || false
}

@test "list, and apply without a running machine, never touch the agent" {
  : > "${SSH_PUBLIC_KEY_FILE%.pub}"
  "$RAE" create dev1; "$RAE" stop dev1; : > "$STUB_LOG"
  "$RAE" list >/dev/null; "$RAE" apply
  ! grep -q "ssh-add:" "$STUB_LOG" || false
}

# --- init keeps working values ---------------------------------------------------------------

@test "init keeps values that verify and asks only for the rest" {
  config '.restic = {}'
  answers ""
  run "$RAE" init < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  for step in hetzner tailscale; do
    [[ $(ev "select(.event_type == \"log\" and .action_name == \"$step\") | .message") == "configured and working, kept"* ]] || false
  done
  [ "$(ev 'select(.event_type == "planned") | .action_name' | paste -s -d ' ' -)" = "ssh link gitkey hetzner contabo tailscale restic Apply Terraform" ]
  [[ $output != *"Hetzner Cloud console"* ]] || false
  [[ $output == *"Optional: S3-compatible bucket"* ]] || false
  [ "$(cfg .hetzner.main)" = t ]
  [ "$(grep -c 'api.hetzner.cloud' "$STUB_LOG")" -eq 1 ] # verified once, in its own step
}

@test "init asks again for a value that is set but rejected" {
  answers ""
  STUB_FAIL=curl run "$RAE" init < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 1 ]
  [[ $output == *"Hetzner account"* ]] || false
  [[ $output != *"hetzner: configured and working"* ]] || false
}

@test "init <step> re-asks that step only" {
  answers main tok2 ""
  run "$RAE" init hetzner < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  [ "$(cfg .hetzner.main)" = tok2 ]
  [ "$(cfg .tailscale.client_id)" = i ] # the rest of the file is untouched
  [[ $output != *"kept"* ]] || false
  ! grep -q "api.tailscale.com" "$STUB_LOG" || false
  run "$RAE" init bogus
  [ "$status" -eq 1 ]
  [[ $output == *"unknown step: bogus"* ]] || false
}

# --- the git commit key ----------------------------------------------------------------------

@test "create installs the commit key for node-ctl-user, never on a command line" {
  run "$RAE" create dev1
  [ "$status" -eq 0 ]
  grep -q 'node-ctl-user@dev1 sudo bash -s' "$STUB_LOG"
  grep -q -F 'PRIVATE-TEST-KEY' "$STUB_LOG"
  grep -q -F 'chmod 600 ~node-ctl-user/.ssh/id_ed25519' "$STUB_LOG"
  grep -q -F 'chown node-ctl-user:node-ctl-user ~node-ctl-user/.ssh/id_ed25519 ~node-ctl-user/.ssh/config' "$STUB_LOG"
  grep -q -F 'StrictHostKeyChecking accept-new' "$STUB_LOG"
  ! grep 'ssh:' "$STUB_LOG" | grep -q PRIVATE-TEST-KEY || false
  [ "$(line_of 'cloud-init status --wait')" -lt "$(line_of 'PRIVATE-TEST-KEY')" ] # only a provisioned machine has the home
}

@test "create syncs this computer's agent instructions into the machine's home" {
  run "$RAE" create dev1
  [ "$status" -eq 0 ]
  grep -q -F 'GLOBAL-TEST-INSTRUCTIONS' "$STUB_LOG"
  grep -q -F "cat > ~node-ctl-user/.claude/CLAUDE.md" "$STUB_LOG"
  ! grep -q -F 'AGENTS.md' "$STUB_LOG" || false # no AGENTS.md here, nothing to write
  [ "$(line_of 'cloud-init status --wait')" -lt "$(line_of 'GLOBAL-TEST-INSTRUCTIONS')" ]
}

@test "start syncs AGENTS.md too, and skips the sync when neither file is there" {
  echo "AGENTS-TEST-INSTRUCTIONS" > "$CLAUDE_DIR/AGENTS.md"
  "$RAE" create dev1
  "$RAE" stop dev1; : > "$STUB_LOG"
  run "$RAE" start dev1
  [ "$status" -eq 0 ]
  grep -q -F 'GLOBAL-TEST-INSTRUCTIONS' "$STUB_LOG"
  grep -q -F 'AGENTS-TEST-INSTRUCTIONS' "$STUB_LOG"
  # both files ride one script: no other ssh call between them
  ! sed -n "$(line_of GLOBAL-TEST-INSTRUCTIONS),$(line_of AGENTS-TEST-INSTRUCTIONS)p" "$STUB_LOG" | grep -q '^ssh:' || false
  rm "$CLAUDE_DIR/CLAUDE.md" "$CLAUDE_DIR/AGENTS.md"
  "$RAE" stop dev1; : > "$STUB_LOG"
  run "$RAE" start dev1 # nothing left to sync: the machine is not touched for it
  [ "$status" -eq 0 ]
  ! grep -q -F 'node-ctl-user/.claude/' "$STUB_LOG" || false
}

@test "create pushes the skills, links followed, and merges the MCP servers into the machine's" {
  mkdir -p "$SKILLS_DIR" "$BATS_TEST_TMPDIR/checkout/tdd" "$BATS_TEST_TMPDIR/checkout/node-ctl-migrate"
  echo tdd > "$BATS_TEST_TMPDIR/checkout/tdd/SKILL.md"
  echo migrate > "$BATS_TEST_TMPDIR/checkout/node-ctl-migrate/SKILL.md"
  ln -s "$BATS_TEST_TMPDIR/checkout/tdd" "$SKILLS_DIR/tdd"
  ln -s "$BATS_TEST_TMPDIR/checkout/node-ctl-migrate" "$SKILLS_DIR/node-ctl-migrate"
  touch "$SKILLS_DIR/.DS_Store"
  echo '{"mcpServers":{"linear":{"type":"http","url":"https://mcp.linear.app/mcp","headers":{"Authorization":"MCP-TEST-TOKEN"}}},"oauthAccount":"ACCOUNT-TEST"}' > "$CLAUDE_JSON"
  run "$RAE" create dev1
  [ "$status" -eq 0 ]
  grep -q -F 'ssh: ' "$STUB_LOG"
  grep -q -F 'tar -xzf - -C node-ctl-skills --warning=no-unknown-keyword' "$STUB_LOG"
  grep -q -x 'tdd/SKILL.md' "$STUB_LOG" # the link's target went, not the link
  ! grep -q 'node-ctl-migrate\|DS_Store' "$STUB_LOG" || false
  grep -q -F 'c.mcpServers = { ...{"linear":' "$STUB_LOG"
  ! grep 'ssh:' "$STUB_LOG" | grep -q MCP-TEST-TOKEN || false # inside the piped script only
  ! grep -q ACCOUNT-TEST "$STUB_LOG" || false # the servers, never this computer's login
  [ "$(line_of 'cloud-init status --wait')" -lt "$(line_of 'MCP-TEST-TOKEN')" ]
}

@test "a skill deleted here is deleted on the machine, the agent's own skills stay" {
  export STUB_SSH_HOME="$BATS_TEST_TMPDIR/home"
  local on=$STUB_SSH_HOME/.claude/skills
  mkdir -p "$SKILLS_DIR/tdd" "$SKILLS_DIR/grill" "$on/mine"
  ln -s /nowhere "$on/grill" # the agent's own link, dangling, of a name pushed from here
  ln -s "$BATS_TEST_TMPDIR" "$on/local" # and one into a directory of the machine
  echo a > "$SKILLS_DIR/tdd/a.md"; echo b > "$SKILLS_DIR/tdd/b.md"; echo g > "$SKILLS_DIR/grill/SKILL.md"
  run "$RAE" create dev1
  [ "$status" -eq 0 ]
  [ -f "$on/tdd/b.md" ] && [ "$(readlink "$on/grill")" = /nowhere ] && [ -d "$on/mine" ] || false
  mkdir -p "$SKILLS_DIR/mine"; echo ours > "$SKILLS_DIR/mine/SKILL.md" # the agent's own of that name wins
  rm -r "$SKILLS_DIR/grill" "$SKILLS_DIR/tdd/b.md"
  run "$RAE" apply
  [ "$status" -eq 0 ]
  [ -f "$on/tdd/a.md" ] && [ ! -e "$on/tdd/b.md" ] && [ -d "$on/mine" ] || false
  rm -r "$SKILLS_DIR/tdd" # none left here: every pushed one goes, nothing else
  run "$RAE" apply
  [ "$status" -eq 0 ]
  [ ! -e "$on/tdd" ] && [ -d "$on/mine" ] && [ ! -e "$on/mine/SKILL.md" ] || false
  [ "$(readlink "$on/grill")" = /nowhere ] && [ "$(readlink "$on/local")" = "$BATS_TEST_TMPDIR" ] || false
}

@test "apply syncs the agent setup to every running machine, and only to those" {
  "$RAE" create dev1
  "$RAE" create dev2
  "$RAE" stop dev2; : > "$STUB_LOG"
  run "$RAE" apply
  [ "$status" -eq 0 ]
  [ "$(grep -c -F 'GLOBAL-TEST-INSTRUCTIONS' "$STUB_LOG")" -eq 1 ]
  grep -q -F "ssh: -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR node-ctl-user@dev1 sudo bash -s" "$STUB_LOG"
  ! grep -q 'node-ctl-user@dev2' "$STUB_LOG" || false
  STUB_SSH_RC=255 run "$RAE" apply # an unreachable machine costs its sync, not the apply
  [ "$status" -eq 0 ]
  [[ $output == *"could not sync the agent setup to dev1"* ]] || false
  "$RAE" start dev2; : > "$STUB_LOG"
  run "$RAE" apply dev2 # named: only those, and the row says which
  [ "$status" -eq 0 ]
  grep -q 'node-ctl-user@dev2' "$STUB_LOG" && ! grep -q 'node-ctl-user@dev1' "$STUB_LOG" || false
  ev 'select(.event_type == "completed") | .action_name' | grep -qx 'Sync the agent setup to dev2'
  "$RAE" stop dev2; : > "$STUB_LOG"
  run "$RAE" apply dev2 # a stopped or unknown name is refused before Terraform runs
  [ "$status" -ne 0 ] && [[ $output == *"dev2 is not running"* ]] || false
  run "$RAE" apply nope
  [ "$status" -ne 0 ] && [[ $output == *"no such machine: nope"* ]] || false
  ! grep -q 'terraform: .*apply' "$STUB_LOG" || false
}

run_mcpjs() { # run_mcpjs <home>: the last MCP merge script sent, run for real with that HOME (node here, not the stub)
  sed -n "/<<'MCPJS'/,/^MCPJS\$/p" "$STUB_LOG" | sed '1d;$d' > "$BATS_TEST_TMPDIR/mcp.js"
  HOME=$1 PATH=${PATH#"$BATS_TEST_DIRNAME/stubs:"} node "$BATS_TEST_TMPDIR/mcp.js"
}

@test "the user-scope merge only adds the servers the machine lacks, its own config wins" {
  mkdir -p "$BATS_TEST_TMPDIR/home"
  echo '{"mcpServers": {"linear": {"url": "new"}, "sentry": {"url": "added"}}, "oauthAccount": "here"}' > "$CLAUDE_JSON"
  echo '{"mcpServers": {"linear": {"url": "old"}, "theirs": {}}, "oauthAccount": "there"}' > "$BATS_TEST_TMPDIR/home/.claude.json"
  "$RAE" create dev1
  run_mcpjs "$BATS_TEST_TMPDIR/home"
  [ "$(jq -c '[.mcpServers.linear.url, (.mcpServers | keys), .oauthAccount]' "$BATS_TEST_TMPDIR/home/.claude.json")" = '["old",["linear","sentry","theirs"],"there"]' ]
}

@test "start and restore push the key again, so a rotated key reaches existing machines" {
  "$RAE" create dev1
  "$RAE" stop dev1; : > "$STUB_LOG"
  run "$RAE" start dev1
  [ "$status" -eq 0 ]
  grep -q -F 'PRIVATE-TEST-KEY' "$STUB_LOG"
  : > "$STUB_LOG"
  run "$RAE" restore dev1 --yes
  [ "$status" -eq 0 ]
  grep -q -F 'PRIVATE-TEST-KEY' "$STUB_LOG"
}

@test "create warns instead of failing when no commit key has been generated" {
  rm "$GIT_KEY_FILE"
  run "$RAE" create dev1
  [ "$status" -eq 0 ]
  [[ $output == *"has no commit key"*"node-ctl init gitkey"* ]] || false
  ! grep -q 'id_ed25519' "$STUB_LOG" || false
}

@test "init generates the commit key once and shows the public half" {
  blank
  rm "$GIT_KEY_FILE" "$GIT_KEY_FILE.pub"
  answers "" tok "" ""
  run "$RAE" init < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  grep -q "ssh-keygen: -q -t ed25519 -C node-ctl-user commit key -f $GIT_KEY_FILE" "$STUB_LOG" # no -N: the passphrase is asked on the terminal, not put in the process list
  [ -f "$GIT_KEY_FILE" ]
  [[ $(ev 'select(.action_name == "gitkey" and .event_type == "log") | .message') == *"ssh-ed25519 AAAAgit node-ctl-user commit key"* ]] || false
  : > "$STUB_LOG"; : > "$STUB_EVENTS"
  run "$RAE" init gitkey
  [ "$status" -eq 0 ]
  ! grep -q "ssh-keygen:" "$STUB_LOG" || false # an existing key is kept: it is registered with the git hosts
  [[ $(ev 'select(.action_name == "gitkey" and .event_type == "log") | .message') == *"keeping $GIT_KEY_FILE"* ]] || false
}

# --- ssh over the tailnet --------------------------------------------------------------------

@test "ssh never checks host keys: Tailscale authenticates the peer and a rebuilt machine has a new key" {
  "$RAE" create dev1
  run "$RAE" ssh dev1 uptime
  [ "$status" -eq 0 ]
  opts='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR'
  grep -q "ssh: $opts -o ConnectTimeout=5 -o BatchMode=yes node-ctl-user@dev1 sudo cloud-init status --wait" "$STUB_LOG"
  grep -q "ssh: $opts node-ctl-user@dev1 uptime" "$STUB_LOG"
  ! grep 'ssh:' "$STUB_LOG" | grep -v -q StrictHostKeyChecking=no || false
}

@test "create keeps trying while the name does not resolve, then reports the ssh error" {
  STUB_SSH_RC=255 STUB_SSH_ERR="ssh: Could not resolve hostname dev1" run "$RAE" create dev1
  [ "$status" -eq 1 ]
  [[ $output == *"dev1 is not reachable over the tailnet: ssh: Could not resolve hostname dev1"* ]] || false
  wait_id=$(id_of 'Wait for dev1')
  [ "$(ev "select(.event_type == \"progress\" and .action_id == \"$wait_id\") | .current" | paste -s -d ' ' -)" = "$(seq 1 60 | paste -s -d ' ' -)" ]
  [ "$(ev "select(.event_type == \"progress\" and .action_id == \"$wait_id\") | .total" | sort -u)" = 60 ]
  [ "$(ev "select(.event_type == \"progress\" and .action_id == \"$wait_id\") | .message" | sort -u)" = "ssh: Could not resolve hostname dev1" ]
  [[ $(ev "select(.event_type == \"failed\" and .action_id == \"$wait_id\") | .message") == "dev1 is not reachable over the tailnet"* ]] || false
  [ "$(ev 'select(.event_type == "failed") | .action_name' | paste -s -d ' ' -)" = "Wait for dev1" ] # the die failed only the open action
  [ "$(grep -c 'node-ctl-user@dev1 sudo cloud-init status --wait' "$STUB_LOG")" -eq 60 ]
}

@test "a machine whose cloud-init failed is reported at once" {
  STUB_SSH_RC=1 run "$RAE" create dev1
  [ "$status" -eq 1 ]
  [[ $output == *"cloud-init failed on dev1"* ]] || false
  [ "$(grep -c 'cloud-init status --wait' "$STUB_LOG")" -eq 1 ]
}

@test "a cloud-init whose only error is the provider's admin password is ready, with a warning" {
  STUB_CLOUD_INIT_RC=1 STUB_CLOUD_INIT_JSON='{"errors":["('"'"'set_passwords'"'"', ProcessExecutionError(\"chpasswd: (user admin) password not changed\"))"]}' \
    run "$RAE" create dev1
  [ "$status" -eq 0 ]
  said "failed only to set a password for the provider's admin user" || false
  [[ $output == *"ready: node-ctl ssh dev1"* ]] || false
}

@test "a cloud-init that failed elsewhere too is still a failure" {
  STUB_CLOUD_INIT_RC=1 STUB_CLOUD_INIT_JSON='{"errors":["('"'"'set_passwords'"'"', x)","('"'"'scripts_user'"'"', y)"]}' run "$RAE" create dev1
  [ "$status" -eq 1 ]
  [[ $output == *"cloud-init failed on dev1"* ]] || false
}

@test "ssh takes the address from the Tailscale daemon when it knows the machine, the name otherwise" {
  STUB_TAILSCALE_IP=100.64.0.7 run "$RAE" create dev1
  [ "$status" -eq 0 ]
  grep -q "tailscale: ip -4 dev1" "$STUB_LOG"
  grep -q "node-ctl-user@100.64.0.7 sudo cloud-init status --wait" "$STUB_LOG"
  : > "$STUB_LOG"
  run "$RAE" ssh dev1 uptime
  [ "$status" -eq 0 ]
  grep -q "node-ctl-user@dev1 uptime" "$STUB_LOG"
}

# --- leaving the tailnet ---------------------------------------------------------------------

@test "stop deletes the node through the API when the machine cannot log itself out" {
  "$RAE" create dev1; : > "$STUB_LOG"
  devices='{"access_token":"at","servers":[{"id":7}],"server":{"status":"off"},"image":{"id":"4711","status":"available"},"images":[],"devices":[{"id":"111","name":"dev1.tail.ts.net","hostname":"dev1","tags":["tag:dev"]},{"id":"222","name":"dev1.tail.ts.net","hostname":"dev1"},{"id":"333","name":"dev2.tail.ts.net","hostname":"dev2","tags":["tag:dev"]}]}'
  STUB_SSH_RC=255 STUB_CURL_BODY=$devices run "$RAE" stop dev1
  [ "$status" -eq 0 ]
  logout_id=$(id_of 'Leave the tailnet')
  [[ $(ev "select(.event_type == \"warning\" and .action_id == \"$logout_id\") | .message") == *"deleting its node through the API"* ]] || false
  [ "$(ev 'select(.event_type == "started" and .action_name == "tailscale-rm.sh dev1") | .parent_action_id')" = "$logout_id" ]
  grep -q "http: DELETE .*api/v2/device/111" "$STUB_LOG"
  ! grep -q "device/222" "$STUB_LOG" || false # a laptop with the same hostname is not ours
  ! grep -q "device/333" "$STUB_LOG" || false
  [ "$(line_of 'device/111')" -lt "$(line_of 'terraform: -chdir=terraform apply')" ]
  [ "$(inv dev1 .state)" = stopped ]
}

@test "the logout ssh speaks through its action: an unreachable machine does not print beside the renderer" {
  "$RAE" create dev1; : > "$STUB_LOG"
  STUB_SSH_RC=255 STUB_SSH_ERR='ssh: connect to host dev1 port 22: Operation timed out' run "$RAE" stop dev1
  [ "$status" -eq 0 ]
  logout_id=$(id_of 'Leave the tailnet')
  [ "$(ev "select(.event_type == \"log\" and .action_id == \"$logout_id\" and .stream == \"stderr\") | .message")" \
    = 'ssh: connect to host dev1 port 22: Operation timed out' ] # a row on the terminal would desync the live region
  [[ $output != *"Operation timed out"* ]] || false
}

@test "stop leaves the API alone when logout works" {
  "$RAE" create dev1; : > "$STUB_LOG"
  run "$RAE" stop dev1
  [ "$status" -eq 0 ]
  ! grep -q "tailscale-rm" "$STUB_LOG" || false
}

@test "check reports an OAuth client that cannot delete devices" {
  STUB_FAIL=curl-devices run "$RAE" check
  [ "$status" -eq 1 ]
  [[ $(ev 'select(.event_type == "failed" and .action_name == "Tailscale OAuth client") | .message') == *"devices:core"* ]] || false
}

# --- progress: actions, not lines -------------------------------------------------------------

@test "terraform runs as nested actions whose child-process lines carry their stream" {
  "$RAE" create dev1
  apply_id=$(id_of 'Apply Terraform')
  [ "$(ev 'select(.event_type == "started" and .action_name == "terraform init") | .parent_action_id')" = "$apply_id" ]
  tf_id=$(id_of 'terraform apply (main)')
  [ "$(ev "select(.event_type == \"started\" and .action_id == \"$tf_id\") | .parent_action_id")" = "$apply_id" ]
  [ "$(ev "select(.event_type == \"log\" and .action_id == \"$tf_id\") | [.stream, .message] | @tsv")" = $'stdout\thcloud_server.machine["dev1"]: Creating...' ]
  [ "$(ev 'select(.event_type == "completed") | .action_name' | paste -s -d ' ' -)" = "Free the tailnet name Write inventory terraform init terraform apply (main) Apply Terraform Wait for dev1 Install the git key Sync the agent setup to dev1" ]
  [ "$(ev 'select(.event_type == "planned") | "\(.index)/\(.total_steps) \(.key)"' | paste -s -d , -)" = "1/4 free,2/4 write,3/4 apply,4/4 wait" ]
  [ "$(ev 'select(.event_type == "started" and .action_name == "Write inventory") | .action_id')" = "$(ev 'select(.event_type == "planned" and .action_name == "Write inventory") | .action_id')" ]
}

@test "a failed terraform apply fails its own action, then the parent, with the stderr line kept under the child" {
  "$RAE" create dev1
  : > "$STUB_EVENTS"
  STUB_TF_RC=1 run "$RAE" stop dev1
  [ "$status" -eq 1 ]
  tf_id=$(id_of 'terraform apply (main)')
  [ "$(ev "select(.event_type == \"log\" and .action_id == \"$tf_id\" and .stream == \"stderr\") | .message")" = "Error: requested tags [tag:dev] are invalid" ]
  [ "$(ev 'select(.event_type == "failed") | "\(.action_name): \(.message)"' | paste -s -d '|' -)" = "terraform apply (main): terraform apply (main) exited with status 1|Apply Terraform: Apply Terraform exited with status 1" ]
  [ -z "$(ev 'select(.event_type == "failed" and .action_name == "Leave the tailnet")')" ]
}

@test "every log line of a command belongs to exactly one action, in order" {
  "$RAE" create dev1
  ev 'select(.event_type == "log") | .action_id' | while read -r id; do [ -n "$id" ]; done
  [ "$(ev 'select(.event_type == "log" and .action_name == "Write inventory") | .message')" = "$SERVERS_DIR/dev1.json: cx23 nbg1 ports 22, account main" ]
  [ "$(ev '[.action_id, .event_type] | @tsv' | grep -c .)" -eq "$(grep -c . "$STUB_EVENTS")" ] # one event per line, all with an action
}

@test "--progress selects the renderer, auto is plain off a terminal, and rejects other values" {
  NODE_CTL_PROGRESS=auto run "$RAE" check
  [ "$status" -eq 0 ]
  [[ $output == *"[1/4 host] START Host"* ]] || false
  : > "$STUB_LOG"; : > "$STUB_EVENTS"
  run "$RAE" --progress=json check
  [ "$status" -eq 0 ]
  [ "$(ev 'select(.event_type == "started") | .action_name' | head -1)" = Host ]
  [[ $output != *"START Host"* ]] || false
  : > "$STUB_LOG"
  NODE_CTL_PROGRESS=tty run "$RAE" check
  [ "$status" -eq 0 ]
  [[ $output == *"✓ [1/4] Host"* && $output != *"START Host"* ]] || false
  run "$RAE" --progress=fancy list
  [ "$status" -eq 1 ]
  [[ $output == *"--progress must be"* ]] || false
  : > "$STUB_LOG"; : > "$STUB_EVENTS"
  run bash -c "'$RAE' list 2>&1 >/dev/null"
  [ -z "$output" ] # no actions, no renderer
  [ ! -s "$STUB_EVENTS" ]
}

@test "Ctrl+C turns the open actions into cancelled and exits 130" {
  set -m # the background node-ctl gets its own process group, like a foreground command in a terminal
  STUB_SLEEP_REAL=1 STUB_SSH_RC=255 "$RAE" create dev1 2>/dev/null &
  pid=$!
  set +m
  for _ in $(seq 1 100); do grep -q '"action_name":"Wait for dev1".*"event_type":"started"' "$STUB_EVENTS" 2>/dev/null && break; /bin/sleep 0.1; done
  kill -INT -- "-$pid"
  status=0
  wait "$pid" || status=$?
  [ "$status" -eq 130 ]
  [ "$(ev 'select(.event_type == "cancelled") | .action_name')" = "Wait for dev1" ]
  [ -z "$(ev 'select(.event_type == "failed" or (.event_type == "completed" and .action_name == "Wait for dev1"))')" ]
  grep -q '=== exit 130' "$NODE_CTL_LOG"
}

@test "every run lands in the log with its output and exit status" {
  run "$RAE" create dev1
  grep -q '=== node-ctl create dev1' "$NODE_CTL_LOG"
  grep -q 'ready: node-ctl ssh dev1' "$NODE_CTL_LOG"
  grep -q '=== exit 0' "$NODE_CTL_LOG"
  run "$RAE" stop nope
  grep -q 'no such machine: nope' "$NODE_CTL_LOG"
  grep -q '=== exit 1' "$NODE_CTL_LOG"
}

@test "load is left out of the log: a redraw every second is a screen, not a record" {
  "$RAE" create dev1; : > "$NODE_CTL_LOG"
  STUB_SSH_OUT="LOAD-FRAME" run "$RAE" load -f dev1
  [ "$status" -eq 0 ]
  [[ $output == *LOAD-FRAME* ]] || false
  grep -q '=== node-ctl load -f dev1' "$NODE_CTL_LOG"
  grep -q '=== exit 0' "$NODE_CTL_LOG"
  ! grep -q LOAD-FRAME "$NODE_CTL_LOG" || false
}

@test "the renderer draws past the log and writes the log its own stamped lines, on a terminal and in a pipe" {
  stamped='^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8} \[1/4 host\] START Host$'
  out=$(NODE_CTL_PROGRESS=auto "$PTY" "$RAE" check </dev/null)
  [[ $out == *$'\e['*"Host"* && $out != *"START Host"* ]] || false # a live region on the terminal
  grep -qE "$stamped" "$NODE_CTL_LOG" # the log gets plain lines with their time
  ! grep -q $'\e' "$NODE_CTL_LOG" || false # and none of the drawing
  grep -q '=== node-ctl check' "$NODE_CTL_LOG"
  : > "$STUB_LOG"; : > "$NODE_CTL_LOG"
  NODE_CTL_PROGRESS=auto run "$RAE" check # an autostop job or a script: plain lines on stderr, a log with times
  [[ $output == *"[1/4 host] START Host"* ]] || false
  ! grep -qE '^[0-9-]+ [0-9:]+ ' <<< "$output" || false # stderr has no times
  grep -qE "$stamped" "$NODE_CTL_LOG"
}

@test "a log past 10 MB becomes node-ctl.log.1, replacing the previous one, and the run starts a new log" {
  dd if=/dev/zero of="$NODE_CTL_LOG" bs=1 count=0 seek=$((11 * 1024 * 1024)) 2>/dev/null
  echo "two runs ago" > "$NODE_CTL_LOG.1"
  run "$RAE" list
  [ "$(wc -c < "$NODE_CTL_LOG.1")" -gt 10000000 ]
  [ "$(wc -c < "$NODE_CTL_LOG")" -lt 10000 ]
  grep -q '=== node-ctl list' "$NODE_CTL_LOG"
  run "$RAE" list # a small log just grows
  [ "$(grep -c '=== node-ctl list' "$NODE_CTL_LOG")" -eq 2 ]
}

@test "apply is init and apply, then ssh only to sync the agent setup" {
  "$RAE" create dev1
  : > "$STUB_LOG"
  run "$RAE" apply
  [ "$status" -eq 0 ]
  [ "$(line_of 'terraform: -chdir=terraform init -input=false -no-color')" -lt "$(line_of 'terraform: -chdir=terraform apply -input=false -no-color -auto-approve')" ]
  [ "$(line_of 'terraform: -chdir=terraform apply -input=false -no-color -auto-approve')" -lt "$(grep -n -m1 '^ssh:' "$STUB_LOG" | cut -d: -f1)" ]
  [ "$(grep -c '^ssh:' "$STUB_LOG")" -eq 1 ]
}

@test "ssh refuses to run while Tailscale is stopped on this computer" {
  "$RAE" create dev1
  : > "$STUB_LOG"
  STUB_TAILSCALE_DOWN=1 run "$RAE" ssh dev1 uptime
  [ "$status" -ne 0 ]
  [[ $output == *"Tailscale is not running"* ]] || false
  ! grep -q "node-ctl-user@" "$STUB_LOG" || false # nothing was attempted over ssh
}

@test "gitkey pushes the commit key to a machine that already runs" {
  "$RAE" create dev1
  : > "$STUB_LOG"
  "$RAE" gitkey dev1
  grep -q -F 'PRIVATE-TEST-KEY' "$STUB_LOG"
  [ "$(ev 'select(.event_type == "completed") | .action_name' | tail -1)" = "Install the git key" ]
  run "$RAE" gitkey nope
  [ "$status" -ne 0 ]
  [[ $output == *"no such machine"* ]] || false
}

@test "runs through a symlink on PATH from another directory" {
  mkdir -p "$BATS_TEST_TMPDIR/bin" "$BATS_TEST_TMPDIR/elsewhere"
  ln -s "$RAE" "$BATS_TEST_TMPDIR/bin/node-ctl"
  run bash -c "cd '$BATS_TEST_TMPDIR/elsewhere' && PATH='$BATS_TEST_TMPDIR/bin:$PATH' node-ctl create dev1"
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .state)" = running ]
}

@test "init links the node-ctl-migrate skill into SKILLS_DIR, and leaves a foreign file alone" {
  blank
  answers "" tok "" ""
  run "$RAE" init < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  [ -L "$SKILLS_DIR/node-ctl-migrate" ]
  grep -q "^disable-model-invocation: true" "$SKILLS_DIR/node-ctl-migrate/SKILL.md" # only ever invoked by hand
  rm "$SKILLS_DIR/node-ctl-migrate"; echo other > "$SKILLS_DIR/node-ctl-migrate"
  answers ""
  run "$RAE" init link < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  [ "$(cat "$SKILLS_DIR/node-ctl-migrate")" = other ]
  [[ $(ev 'select(.event_type == "warning") | .message') == *"node-ctl-migrate exists and is not a symlink; left alone"* ]] || false
}

@test "init unpacks the skill into NODE_CTL_HOME, links it there, and links no node-ctl onto PATH" {
  blank
  answers "" tok "" ""
  mkdir -p "$BATS_TEST_TMPDIR/user"
  HOME="$BATS_TEST_TMPDIR/user" run "$RAE" init < "$BATS_TEST_TMPDIR/answers"
  [ "$status" -eq 0 ]
  [ "$(readlink "$SKILLS_DIR/node-ctl-migrate")" = "$NODE_CTL_HOME/skills/node-ctl-migrate" ]
  cmp "$NODE_CTL_HOME/skills/node-ctl-migrate/SKILL.md" "$BATS_TEST_DIRNAME/../skills/node-ctl-migrate/SKILL.md"
  [ ! -e "$BATS_TEST_TMPDIR/user/.local/bin/node-ctl" ] # install.sh puts the binary there, init never links one
  [ ! -L "$BATS_TEST_TMPDIR/user/.local/bin/node-ctl" ]
}

@test "create asks for a tariff only on a terminal: off one the defaults stand and nothing is fetched" {
  run "$RAE" create dev1
  [ "$status" -eq 0 ]
  [ "$(inv dev1 .type)" = cx23 ]
  [ "$(inv dev1 .location)" = nbg1 ]
  ! grep -q server_types "$STUB_LOG" || false
}

# The price list a new machine is created from: the test server answers every request with this body,
# so it carries what free_tailnet_name and wait_ready need too. cx33 is sold in two locations, which
# is the only case that asks a second question.
create_types() {
  export STUB_CURL_BODY='{"access_token":"at","devices":[],"servers":[{"id":7}],"server":{"status":"off"},
   "image":{"id":"4711","status":"available"},"images":[],
   "server_types":[
    {"id":4,"name":"cx33","cores":8,"memory":16,"disk":80,"cpu_type":"shared",
     "locations":[{"name":"nbg1","available":true},{"name":"fsn1","available":true}],
     "prices":[{"location":"nbg1","price_monthly":{"gross":"16.9000"}},{"location":"fsn1","price_monthly":{"gross":"16.4000"}}]},
    {"id":1,"name":"cx22","cores":2,"memory":4,"disk":40,"cpu_type":"shared",
     "locations":[{"name":"nbg1","available":true},{"name":"fsn1","available":false}],
     "prices":[{"location":"nbg1","price_monthly":{"gross":"4.5100"}},{"location":"fsn1","price_monthly":{"gross":"4.5100"}}]}]}'
}

@test "create offers the tariffs cheapest first and asks the location when that tariff is sold in several" {
  create_types
  # the second type, then the second of its two locations
  run bash -c "(/bin/sleep 1; printf '2\n'; /bin/sleep 1; printf '2\n'; /bin/sleep 3) | '$PTY' '$RAE' create dev1 --size 0"
  [[ $output == *LOCATIONS*cx22*4.51*nbg1*cx33*16.40*fsn1,nbg1* ]] || false # cheapest first, with where each is sold
  [[ $output == *"1) fsn1"*"2) nbg1"* ]] || false
  [ "$(inv dev1 .type)" = cx33 ]
  [ "$(inv dev1 .location)" = nbg1 ]
}

@test "create takes a tariff offered in one location without asking, and refuses a location that cannot take it" {
  create_types
  run bash -c "(/bin/sleep 1; printf '\n'; /bin/sleep 3) | '$PTY' '$RAE' create dev1 --size 0" # an empty answer takes the cheapest
  [ "$(inv dev1 .type)" = cx22 ]
  [ "$(inv dev1 .location)" = nbg1 ] # its only location: nothing to ask
  [[ $output != *"1) nbg1"* ]] || false
  run bash -c "(/bin/sleep 1; printf '\n'; /bin/sleep 3) | '$PTY' '$RAE' create dev2 --size 0 --location fsn1"
  [[ $output == *"fsn1 cannot take a cx22 right now, only nbg1 can"* ]] || false
  [ ! -e "$SERVERS_DIR/dev2.json" ]
}

@test "create on Contabo offers the products its API spec documents and every region, without prices" {
  contabo
  # the third product, then the second region
  run bash -c "(/bin/sleep 1; printf '3\n'; /bin/sleep 1; printf '2\n'; /bin/sleep 3) | '$PTY' '$RAE' create dev1 --account cb"
  grep -q 'api.contabo.com/api-v1.yaml' "$STUB_LOG" # read on every create, so a new line-up needs no release
  [[ $output == *"V153 Cloud VPS 4, 100 GB SSD"*"V93 VPS 10 Storage, 300 GB SSD"*"V16 VDS XXL, 720 GB NVMe"* ]] || false
  [[ $output != *EUR* ]] || false # Contabo's API carries no price, so none is shown
  [[ $output == *"1) EU"*"2) US-central"*"5) SIN"* ]] || false
  [ "$(inv dev1 .type)" = V93 ]
  [ "$(inv dev1 .location)" = US-central ]
}

@test "create on Contabo stops when the API spec cannot be read, unless --type answers it" {
  contabo
  run bash -c "STUB_CURL_BODY='openapi: 3.0.3' '$PTY' '$RAE' create dev1 --account cb < /dev/null"
  [[ $output == *"could not read the products from Contabo's API spec; --type answers it"* ]] || false
  [ ! -e "$SERVERS_DIR/dev1.json" ]
}

@test "create on Contabo takes a product id that is not in the documented table" {
  contabo # the table is a shortcut, not a whitelist: an id the spec does not list yet is taken as typed
  run bash -c "(/bin/sleep 1; printf 'V999\n'; /bin/sleep 1; printf '\n'; /bin/sleep 3) | '$PTY' '$RAE' create dev1 --account cb"
  [ "$(inv dev1 .type)" = V999 ]
  [ "$(inv dev1 .location)" = EU ] # an empty answer takes the first region
}

@test "create on Contabo asks nothing off a terminal and takes the configured defaults" {
  contabo
  run "$RAE" create dev1 --account cb
  [ "$(inv dev1 .type)" = V45 ]
  [ "$(inv dev1 .location)" = EU ]
  [[ $output != *"VDS XXL"* ]] || false
}

# A drawn menu needs a terminal with a size: script(1) lends one and stty gives it rows and columns.
# Each burst of keys answers one question; it arrives once the question is up (an early EOF would
# discard it).
drive() { # drive <keys per question ...> -- <node-ctl args>
  local feed='/bin/sleep 1'
  while [ "$1" != -- ]; do feed="$feed; printf '$1'; /bin/sleep 1"; shift; done
  shift
  run bash -c "($feed; /bin/sleep 2) | '$PTY' bash -c \"stty rows 30 cols 120; exec '$RAE' $*\""
}

@test "a question with several answers is a menu: arrows move, enter picks, the answer replaces it" {
  config '.hetzner.work = "t2"'
  drive '\e[B\n' -- create dev1 --size 0 --type cx23
  [[ $output == *"?"$'\e[0m'" account"*"↑↓ move · enter picks · q cancels (1/2)"*"account: work (hetzner)"* ]] || false
  [ "$(inv dev1 .account)" = work ]
  drive 'q' -- create dev2 --size 0 --type cx23
  [[ $output == *"aborted"* ]] || false
  [ ! -e "$SERVERS_DIR/dev2.json" ]
}

@test "the Contabo product menu walks with j/k, and its last line takes an id the spec does not list" {
  contabo
  drive 'jjk\n' '\n' -- create dev1 --account cb # down, down, up: the second product; enter: the first region
  [ "$(inv dev1 .type)" = V159 ]
  [ "$(inv dev1 .location)" = EU ]
  drive 'jjjj\n' 'V999\n' '\e[B\n' -- create dev2 --account cb
  [[ $output == *"another product: type it"* ]] || false
  [ "$(inv dev2 .type)" = V999 ]
  [ "$(inv dev2 .location)" = US-central ]
}

@test "the volume size is a menu on a drawn terminal" {
  drive 'j\n' -- create dev1 --type cx23
  [[ $output == *"Hetzner Volume at /mnt/volume: 10 GB"* ]] || false
  [ "$(inv dev1 .volume_size)" = 10 ]
}

@test "growing the disk on resize is a yes/no menu whose default keeps it" {
  types
  "$RAE" create dev1
  drive '\n' -- resize dev1 ccx13
  [ "$(inv dev1 .keep_disk)" = true ]
  drive '\e[B\n' -- resize dev1 ccx23 --grow-disk # the flag answers it: nothing is asked
  [[ $output != *"Grow the disk"* ]] || false
  run "$RAE" resize dev1 cx22 --keep-disk
  drive 'j\n' -- resize dev1 ccx13
  [ "$(inv dev1 .keep_disk)" = false ]
}

@test "accounts add offers the configured tags and a new one as a menu, without a way out before the first" {
  drive '\n' 'work\n' 't2\n' '\n' -- accounts add hetzner # enter: a new account, the default while none was added; then enter: done
  [[ $output == *"main: change it"*"a new account: type its tag"* ]] || false
  [[ $output == *"q cancels (2/2)"*"done adding accounts"* ]] || false # the first menu has no way out, the next one has
  [ "$(cfg .hetzner.work)" = t2 ]
  drive 'kk\n' 't3\n' '\n' -- accounts add hetzner # up past work: main, whose token is replaced
  [ "$(cfg .hetzner.main)" = t3 ]
}

CATO_URL='https://sso.ias.catonetworks.com/login?ws=acme&redirect_uri=http://127.0.0.1:41952'
@test "cato signs a running machine in through this computer's browser and remembers the account" {
  "$RAE" create dev1; : > "$STUB_LOG"
  STUB_CATO_OUT=$CATO_URL run "$RAE" cato dev1 acme me@example.com
  [ "$status" -eq 0 ]
  [[ $output == *"Cato connected on dev1"* ]] || false
  [ "$(inv dev1 .cato.account)" = acme ]
  [ "$(inv dev1 .cato.user)" = me@example.com ]
  grep -q -- "start --reset-cred --account 'acme' --user 'me@example.com'" "$STUB_LOG" # the script piped to the machine
  grep -q -- "-L 41952:127.0.0.1:41952 node-ctl-user@" "$STUB_LOG" # the forward, on the port of the URL
  grep -qx "open: $CATO_URL" "$STUB_LOG"
  [[ $(ev 'select(.action_name == "Sign in to Cato" and .event_type == "log") | .message' | paste -s -d ' ' -) == *"me@example.com"*"$CATO_URL"*"connected"* ]] || false
  : > "$STUB_LOG"
  STUB_CATO_OUT=$CATO_URL run "$RAE" cato dev1 # the account stays
  [ "$status" -eq 0 ]
  grep -q -- "--account 'acme' --user 'me@example.com'" "$STUB_LOG"
  : > "$STUB_LOG"
  STUB_CATO_OUT=connected run "$RAE" cato dev1 # a token that still works is left alone
  [ "$status" -eq 0 ]
  [[ $output == *"already connected"* ]] || false
  ! grep -q -- "-L 41952" "$STUB_LOG" || false
  ! grep -q "open:" "$STUB_LOG" || false
}

@test "cato refuses a machine without an account, a stopped one and a machine that answers no URL" {
  "$RAE" create dev1
  run "$RAE" cato dev1
  [ "$status" -eq 1 ]
  [[ $output == *"no Cato account yet"*"node-ctl cato dev1 <account> <user>"* ]] || false
  run "$RAE" cato dev1 acme
  [ "$status" -eq 1 ]
  [[ $output == *"usage: node-ctl cato"* ]] || false
  STUB_CATO_OUT='cato-sdp is not installed on dev1' STUB_CATO_RC=1 run "$RAE" cato dev1 acme me@example.com
  [ "$status" -eq 1 ]
  [[ $output == *"cato-sdp is not installed on dev1"* ]] || false
  ! grep -q "open:" "$STUB_LOG" || false
  "$RAE" stop dev1
  run "$RAE" cato dev1
  [ "$status" -eq 1 ]
  [[ $output == *"not running"* ]] || false
}

@test "start signs a machine with a Cato account in again once it is ready, and leaves the others alone" {
  "$RAE" create dev1
  STUB_CATO_OUT=$CATO_URL "$RAE" cato dev1 acme me@example.com
  "$RAE" stop dev1; : > "$STUB_LOG"
  STUB_CATO_OUT=$CATO_URL run "$RAE" start dev1
  [ "$status" -eq 0 ]
  [[ $output == *"ready: node-ctl ssh dev1"* ]] || false
  [ "$(grep -n -- '--reset-cred' "$STUB_LOG" | head -1 | cut -d: -f1)" -gt "$(grep -n -F 'PRIVATE-TEST-KEY' "$STUB_LOG" | head -1 | cut -d: -f1)" ] # after the ready steps
  grep -qx "open: $CATO_URL" "$STUB_LOG"
  "$RAE" stop dev1; : > "$STUB_LOG"
  STUB_CATO_OUT="no login URL from cato-sdp after 60s:" STUB_CATO_RC=1 run "$RAE" start dev1 # no URL: a warning, the start stands
  [ "$status" -eq 0 ]
  [[ $output == *"no login URL from cato-sdp"*"retry: node-ctl cato dev1"* ]] || false
  [[ $output == *"ready: node-ctl ssh dev1"* ]] || false
  "$RAE" create dev2
  "$RAE" stop dev2; : > "$STUB_LOG"
  run "$RAE" start dev2
  [ "$status" -eq 0 ]
  ! grep -q "cato-sdp" "$STUB_LOG" || false
  ! grep -q "open:" "$STUB_LOG" || false
}

job_script() { plutil -extract ProgramArguments.2 raw -o - "$LAUNCH_AGENTS/com.node-ctl.stop.$1.plist"; }

@test "start --till schedules a launchd job that stops the machine at that time of this computer's time zone" {
  macos_only
  "$RAE" create dev1; "$RAE" stop dev1; : > "$STUB_LOG"
  TZ=Europe/Berlin run "$RAE" start dev1 --till "2099-06-01 18:30"
  [ "$status" -eq 0 ]
  plist="$LAUNCH_AGENTS/com.node-ctl.stop.dev1.plist"
  plutil -lint "$plist"
  # 18:30 in Berlin is 16:30 UTC in summer
  [[ $(job_script dev1) == *"-ge $(date -j -u -f '%Y-%m-%d %H:%M:%S' '2099-06-01 16:30:00' +%s) "* ]] || false
  grep -q "launchctl: bootstrap gui/$(id -u) $plist" "$STUB_LOG"
  "$RAE" create dev2; "$RAE" stop dev2 # a bare time already past today is tomorrow
  run "$RAE" start dev2 --till "$(date -j -v-1M +%H:%M)"
  [ "$status" -eq 0 ]
  at=$(job_script dev2 | grep -o -- '-ge [0-9]*' | cut -d' ' -f2)
  [ "$at" -gt "$(date +%s)" ] && [ "$at" -le $(($(date +%s) + 86400)) ] || false
}

@test "start --till refuses a time it cannot read or one already past, before anything is touched" {
  "$RAE" create dev1; "$RAE" stop dev1; : > "$STUB_LOG"
  for t in 25:00 "2099-02-30 10:00" "tomorrow" "2000-01-01 10:00"; do
    run "$RAE" start dev1 --till "$t"
    [ "$status" -eq 1 ]
    [[ $output == *"--till"* ]] || false
  done
  run "$RAE" start dev1 --till
  [ "$status" -eq 1 ]
  [ "$(inv dev1 .state)" = stopped ]
  ! grep -q "terraform: .* apply" "$STUB_LOG" || false
  [ ! -e "$LAUNCH_AGENTS/com.node-ctl.stop.dev1.plist" ]
}

@test "the job stops a running machine once its time has come, then removes itself; a start without --till drops it" {
  macos_only
  "$RAE" create dev1; "$RAE" stop dev1
  "$RAE" start dev1 --till "2099-06-01 18:30"
  bash -c "$(job_script dev1)" # not yet: nothing happens
  [ "$(inv dev1 .state)" = running ]
  : > "$STUB_LOG"
  bash -c "$(job_script dev1 | sed 's/-ge [0-9]*/-ge 0/')"
  [ "$(inv dev1 .state)" = stopped ]
  [ ! -e "$LAUNCH_AGENTS/com.node-ctl.stop.dev1.plist" ]
  grep -q "launchctl: bootout gui/$(id -u)/com.node-ctl.stop.dev1" "$STUB_LOG"
  "$RAE" start dev1 --till "2099-06-01 18:30"
  "$RAE" stop dev1
  "$RAE" start dev1 # a job left from an earlier run would stop this one
  [ ! -e "$LAUNCH_AGENTS/com.node-ctl.stop.dev1.plist" ]
}

@test "start --till also takes how long the machine lives, in hours or minutes, fractions included" {
  macos_only
  "$RAE" create dev1; "$RAE" stop dev1
  before=$(date +%s)
  run "$RAE" start dev1 --till 6.9h
  [ "$status" -eq 0 ]
  at=$(job_script dev1 | grep -o -- '-ge [0-9]*' | cut -d' ' -f2)
  [ "$at" -ge $((before + 24840)) ] && [ "$at" -le $(($(date +%s) + 24840)) ] || false # 6.9 h = 6 h 54 min
  "$RAE" stop dev1
  before=$(date +%s)
  "$RAE" start dev1 --till 90m
  at=$(job_script dev1 | grep -o -- '-ge [0-9]*' | cut -d' ' -f2)
  [ "$at" -ge $((before + 5400)) ] && [ "$at" -le $(($(date +%s) + 5400)) ] || false
  "$RAE" stop dev1
  for t in 0m 0.0h 6 6x 1.h .5h -2h; do
    run "$RAE" start dev1 --till "$t"
    [ "$status" -eq 1 ]
    [[ $output == *"--till"* ]] || false
  done
  [ "$(inv dev1 .state)" = stopped ]
}

@test "autostop sets, moves or drops the stop of a running machine" {
  macos_only
  "$RAE" create dev1; "$RAE" create dev2; "$RAE" stop dev2; : > "$STUB_LOG"
  before=$(date +%s)
  run "$RAE" autostop dev1 2h
  [ "$status" -eq 0 ]
  at=$(job_script dev1 | grep -o -- '-ge [0-9]*' | cut -d' ' -f2)
  [ "$at" -ge $((before + 7200)) ]
  [ "$at" -le $(($(date +%s) + 7200)) ]
  run "$RAE" autostop dev1 "2099-06-01 18:30" # a later call moves it: one job per machine
  at=$(job_script dev1 | grep -o -- '-ge [0-9]*' | cut -d' ' -f2)
  [ "$at" = "$(date -j -f '%Y-%m-%d %H:%M:%S' '2099-06-01 18:30:00' +%s)" ]
  grep -q "launchctl: bootout gui/$(id -u)/com.node-ctl.stop.dev1" "$STUB_LOG"
  run "$RAE" autostop dev1 off
  [ "$status" -eq 0 ]
  [ ! -e "$LAUNCH_AGENTS/com.node-ctl.stop.dev1.plist" ]
  [ "$(inv dev1 .state)" = running ]
  run "$RAE" autostop dev2 2h # a stopped machine has nothing to stop
  [ "$status" -eq 1 ]
  [[ $output == *"dev2 is not running"*"start dev2 --till"* ]] || false
  [ ! -e "$LAUNCH_AGENTS/com.node-ctl.stop.dev2.plist" ]
  run "$RAE" autostop dev1
  [ "$status" -eq 1 ]
  [[ $output == *"usage: node-ctl autostop <name> <time | off>"* ]] || false
  run "$RAE" autostop dev1 soon
  [ "$status" -eq 1 ]
  [ ! -e "$LAUNCH_AGENTS/com.node-ctl.stop.dev1.plist" ]
}

# The systemd path: on Linux the binary takes it by itself; elsewhere NODE_CTL_PLATFORM, which only tests set, forces it.
linux() { if [ "$(uname)" = Linux ]; then "$RAE" "$@"; else NODE_CTL_PLATFORM=linux "$RAE" "$@"; fi; }
unit_file() { echo "$BATS_TEST_TMPDIR/systemd/node-ctl-stop-$1.$2"; } # what the systemd-run stub kept

@test "on Linux start --till runs a transient user timer at that moment in UTC, which list shows and a start without --till drops" {
  "$RAE" create dev1; "$RAE" stop dev1; : > "$STUB_LOG"
  TZ=Europe/Berlin run linux start dev1 --till "2099-06-01 18:30"
  [ "$status" -eq 0 ]
  # 18:30 in Berlin is 16:30 UTC in summer: the user manager's own time zone does not matter
  grep -q -- "^systemd-run: --user .*--unit=node-ctl-stop-dev1 --on-calendar=2099-06-01 16:30:00 UTC " "$STUB_LOG"
  grep -q -- " --property=Restart=on-failure --property=RestartSec=60 " "$STUB_LOG" # a failed stop is retried a minute later
  grep -q -- " --setenv=NODE_CTL_HOME=$NODE_CTL_HOME " "$STUB_LOG"
  [ ! -e "$LAUNCH_AGENTS/com.node-ctl.stop.dev1.plist" ]
  ! grep -q "^launchctl:" "$STUB_LOG" || false
  TZ=Europe/Berlin run linux list
  [[ $output == *"dev1  main     starting  0m      2099-06-01 18:30"* ]] || false
  linux stop dev1
  linux start dev1 # a timer left from an earlier run would stop this one
  grep -q "^systemctl: --user stop node-ctl-stop-dev1.timer node-ctl-stop-dev1.service" "$STUB_LOG"
  [ ! -e "$(unit_file dev1 timer)" ]
  run linux list
  [[ $output == *"dev1  main     starting  0m      -"* ]] || false
}

@test "on Linux the timer runs the stop through this binary, and one that fires for a machine stopped since does nothing" {
  "$RAE" create dev1
  linux autostop dev1 2h
  : > "$STUB_LOG"
  bash "$(unit_file dev1 service)" # the timer fires
  [ "$(inv dev1 .state)" = stopped ]
  grep -q "terraform: -chdir=terraform apply" "$STUB_LOG"
  : > "$STUB_LOG"
  run bash "$(unit_file dev1 service)"
  [ "$status" -eq 0 ] # exit 0: Restart=on-failure does not run it again
  [[ $output == *"dev1 is not running; nothing to stop"* ]] || false
  ! grep -q "terraform: .* apply" "$STUB_LOG" || false
}

@test "on Linux autostop moves or drops the timer of a running machine" {
  "$RAE" create dev1; : > "$STUB_LOG"
  linux autostop dev1 2h
  TZ=UTC linux autostop dev1 "2099-06-01 18:30" # one timer per machine: the earlier one goes first
  [ "$(grep -c "^systemd-run:" "$STUB_LOG")" -eq 2 ]
  [ "$(line_of "systemctl: --user stop node-ctl-stop-dev1.timer")" -lt "$(line_of "--on-calendar=2099-06-01 18:30:00 UTC")" ]
  TZ=UTC run linux list
  [[ $output == *"dev1  main     starting  0m      2099-06-01 18:30"* ]] || false
  run linux autostop dev1 off
  [ "$status" -eq 0 ]
  [[ $output == *"dev1 has no autostop"* ]] || false
  [ ! -e "$(unit_file dev1 timer)" ]
  [ "$(inv dev1 .state)" = running ]
}

@test "on Linux --till and autostop refuse without a user manager or without linger, say how to fix it, and change nothing" {
  "$RAE" create dev1; "$RAE" create dev2; "$RAE" stop dev2; : > "$STUB_LOG"
  STUB_NO_USER_MANAGER=1 run linux start dev2 --till 2h
  [ "$status" -eq 1 ]
  [[ $output == *"--till needs a systemd user manager"*"Failed to connect to bus"* ]] || false
  STUB_LINGER=no run linux start dev2 --till 2h
  [ "$status" -eq 1 ]
  [[ $output == *"--till needs lingering for $(id -un)"*"sudo loginctl enable-linger $(id -un)"* ]] || false
  STUB_LINGER=no run linux autostop dev1 19:30
  [ "$status" -eq 1 ]
  [[ $output == *"sudo loginctl enable-linger"* ]] || false
  [ "$(inv dev2 .state)" = stopped ]
  ! grep -q "^systemd-run:" "$STUB_LOG" || false
  ! grep -q "terraform: .* apply" "$STUB_LOG" || false
  ! grep -q "^loginctl: enable-linger" "$STUB_LOG" || false # never enabled for the user
}

# install.sh and update against releases the test server serves from $STUB_RELEASES, never GitHub.
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
release() { # release <tag>: the latest release, every asset a script that says its tag, its name and its arguments
  export STUB_RELEASES="$BATS_TEST_TMPDIR/releases"
  local a
  mkdir -p "$STUB_RELEASES"
  echo "$1" > "$STUB_RELEASES/tag"
  for a in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
    printf '#!/bin/sh\necho "node-ctl %s %s $*"\n' "$1" "node-ctl-$a" > "$STUB_RELEASES/node-ctl-$a"
  done
  (cd "$STUB_RELEASES" && sha256 node-ctl-* > checksums.txt)
}
# install.sh as curl ... | sh runs it, through the wrapper for its test server (NODE_CTL_RELEASES)
install_sh() { NODE_CTL_BIN=sh "$RAE" -s < "$BATS_TEST_DIRNAME/../install.sh"; }

@test "install.sh puts the latest release for this OS and architecture in ~/.local/bin as an executable file" {
  release v0.261120.1
  export HOME="$BATS_TEST_TMPDIR/h"
  run install_sh
  [ "$status" -eq 0 ]
  bin=$HOME/.local/bin/node-ctl
  [ -f "$bin" ] && [ -x "$bin" ] && [ ! -L "$bin" ] || false
  run "$bin"
  [[ $output == "node-ctl v0.261120.1 node-ctl-"* ]] || false
  cmp "$bin" "$STUB_RELEASES/$(echo "$output" | cut -d' ' -f3)"
  [ "$(ls -A "$HOME/.local/bin")" = node-ctl ] # no temporary file left
  run install_sh
  [[ $output == *"$HOME/.local/bin is not on PATH"* ]] || false
  PATH="$HOME/.local/bin:$PATH" run install_sh
  [[ $output != *"not on PATH"* ]] || false
}

@test "install.sh picks the asset of the OS and architecture uname reports, and refuses any other before downloading" {
  release v0.261120.1
  export NODE_CTL_BIN_DIR="$BATS_TEST_TMPDIR/bin"
  for pair in "Darwin arm64 darwin-arm64" "Darwin x86_64 darwin-x64" "Linux x86_64 linux-x64" "Linux aarch64 linux-arm64"; do
    set -- $pair
    NODE_CTL_UNAME_S=$1 NODE_CTL_UNAME_M=$2 run install_sh # uname overridden: only tests set these
    [ "$status" -eq 0 ]
    cmp "$NODE_CTL_BIN_DIR/node-ctl" "$STUB_RELEASES/node-ctl-$3"
  done
  : > "$STUB_LOG"
  NODE_CTL_UNAME_S=FreeBSD NODE_CTL_UNAME_M=x86_64 run install_sh
  [ "$status" -eq 1 ]
  [[ $output == *"unsupported OS: FreeBSD"* ]] || false
  NODE_CTL_UNAME_S=Linux NODE_CTL_UNAME_M=i686 run install_sh
  [ "$status" -eq 1 ]
  [[ $output == *"unsupported architecture: i686"* ]] || false
  ! grep -q "^http:" "$STUB_LOG" || false
  cmp "$NODE_CTL_BIN_DIR/node-ctl" "$STUB_RELEASES/node-ctl-linux-arm64" # what was there stays
}

@test "install.sh again installs the newer release over the old one, and replaces a link with the file" {
  export NODE_CTL_BIN_DIR="$BATS_TEST_TMPDIR/bin"
  release v0.261120.1
  install_sh
  release v0.261121.1
  run install_sh
  [ "$status" -eq 0 ]
  run "$NODE_CTL_BIN_DIR/node-ctl"
  [[ $output == "node-ctl v0.261121.1 "* ]] || false
  echo old > "$BATS_TEST_TMPDIR/checkout-node-ctl"
  ln -sf "$BATS_TEST_TMPDIR/checkout-node-ctl" "$NODE_CTL_BIN_DIR/node-ctl" # what the bash CLI's checkout left
  run install_sh
  [ "$status" -eq 0 ]
  [ ! -L "$NODE_CTL_BIN_DIR/node-ctl" ] # launchd and systemd jobs run the file, not a link into a checkout
  cmp "$NODE_CTL_BIN_DIR/node-ctl" "$STUB_RELEASES/$("$NODE_CTL_BIN_DIR/node-ctl" | cut -d' ' -f3)"
  [ "$(cat "$BATS_TEST_TMPDIR/checkout-node-ctl")" = old ]
}

@test "install.sh refuses a download whose sha256 does not match and leaves the installed binary byte for byte" {
  export NODE_CTL_BIN_DIR="$BATS_TEST_TMPDIR/bin"
  release v0.261120.1
  install_sh
  cp "$NODE_CTL_BIN_DIR/node-ctl" "$BATS_TEST_TMPDIR/before"
  release v0.261121.1
  for a in "$STUB_RELEASES"/node-ctl-*; do echo tampered >> "$a"; done
  run install_sh
  [ "$status" -eq 1 ]
  [[ $output == *"sha256"*"does not match"* ]] || false
  cmp "$NODE_CTL_BIN_DIR/node-ctl" "$BATS_TEST_TMPDIR/before"
  [ "$(ls -A "$NODE_CTL_BIN_DIR")" = node-ctl ]
}

installed_copy() { # a copy of the binary under test, which update may replace
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  cp "$NODE_CTL_BIN" "$BATS_TEST_TMPDIR/bin/node-ctl"
  cp "$NODE_CTL_BIN" "$BATS_TEST_TMPDIR/before"
  NODE_CTL_BIN=$BATS_TEST_TMPDIR/bin/node-ctl
}

@test "update refuses a dev build without --force and leaves the binary as it was" {
  release v0.261120.1
  installed_copy
  run "$RAE" update
  [ "$status" -eq 1 ]
  [[ $output == *"node-ctl dev is not a release"*"node-ctl update --force"* ]] || false
  cmp "$NODE_CTL_BIN" "$BATS_TEST_TMPDIR/before"
  run "$RAE" update --yes-please
  [ "$status" -eq 1 ]
  [[ $output == *"unknown option: --yes-please"* ]] || false
}

@test "update replaces the binary at the path the scheduled stop runs, and the job then runs the new one" {
  release v0.261120.1
  installed_copy
  "$RAE" create dev1
  NODE_CTL_SELF= linux autostop dev1 2h # the job runs the binary itself, as it does outside the suite
  grep -q "/bin/node-ctl --progress=plain stop dev1" "$(unit_file dev1 service)"
  run "$RAE" update --force
  [ "$status" -eq 0 ]
  [[ $output == *"node-ctl dev → v0.261120.1"* ]] || false
  [ -x "$NODE_CTL_BIN" ] && [ ! -L "$NODE_CTL_BIN" ] || false
  [ "$(ls -A "$BATS_TEST_TMPDIR/bin")" = node-ctl ]
  run bash "$(unit_file dev1 service)" # the timer fires
  [[ $output == "node-ctl v0.261120.1 node-ctl-"*" --progress=plain stop dev1" ]] || false
}

@test "update refuses a release whose sha256 does not match and the binary stays byte for byte" {
  release v0.261120.1
  for a in "$STUB_RELEASES"/node-ctl-*; do echo tampered >> "$a"; done
  installed_copy
  run "$RAE" update --force
  [ "$status" -eq 1 ]
  said "checksums.txt says" || false
  cmp "$NODE_CTL_BIN" "$BATS_TEST_TMPDIR/before"
  [ "$(ls -A "$BATS_TEST_TMPDIR/bin")" = node-ctl ]
  grep -q "http: GET https://github.com/pro100coder/node-ctl/releases/download/v0.261120.1/checksums.txt" "$STUB_LOG"
}

@test "apply hands Terraform the Tailscale OAuth client and the inventory in use, in the account's run only" {
  "$RAE" create dev1
  : > "$STUB_LOG"
  run "$RAE" apply
  [ "$status" -eq 0 ]
  grep -qx "tfenv: tailscale i/tskey-client-s servers $SERVERS_DIR" "$STUB_LOG" || false
  [ "$(grep -c '^tfenv:' "$STUB_LOG")" -eq "$(grep -c '^terraform: .*(workspace ' "$STUB_LOG")" ]
}
