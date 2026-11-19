// One page per command, printed before anything is read: help must work on a fresh install.
// test/help.test.ts snapshots them, so a changed text is reviewed in the snapshot's diff.
export const USAGE = `usage: node-ctl [--progress=auto|tty|plain|json] <command> [args]
  init [step ...]              ask for missing credentials, verify, write node-ctl.yaml
  check                        verify node-ctl.yaml, host tools and API credentials
  accounts [--json]            the cloud accounts of node-ctl.yaml, with their machines
  accounts add|edit [hetzner|contabo]
                               add accounts of that cloud, or change what an existing tag holds
  create [name] [--account tag] [--type cx23] [--location nbg1] [--size GB] [--ports 22,80]
                               --account picks the cloud account (asked when node-ctl.yaml has several);
                               its tag says the provider, so --type and --location follow that one
                               without --type a terminal gets the Hetzner price list, then the
                               location when several can take the chosen type
                               --size adds a Hetzner Volume at /mnt/volume (asked otherwise; 0 = none)
  volume <name> <size>         add a Hetzner Volume at /mnt/volume to an existing machine (Hetzner only)
  ssh <name> [cmd ...]
  gitkey <name>                install the commit key on a machine that predates it or a rotation
  autostop <name> <time | off> stop a running machine then (as start --till), move that time, or off
  hostkeys <name>              record the host keys of a running machine again, here and in Orca's store
  cato <name> [account user]   sign the Cato client on name in again, through this computer's browser;
                               start does it for a machine that has one
  list [--json]                machines, states, addresses
  load [-f] [name]             cpu, memory, load average, disk busy and root disk usage, redrawn every second with -f;
                               without a name one row per running machine
  stop <name ...> | --all      Hetzner: delete the VPS, keep its disk (/data included) as a snapshot,
                               and its volume; Contabo: power the instance off (a monthly contract
                               stays). --all: every running machine
  start <name ...> [--type [type]] [--till time] | --all
                               Hetzner: new VPS from that snapshot, the volume attached again;
                               Contabo: power the instance on again
                               --type boots it as another server type (the price list resize
                               scrolls; without a value it asks), Hetzner only: the new disk
                               must hold the snapshot
  resize <name> [type] [--grow-disk|--keep-disk]   (Hetzner only)
                               another server type: a scrolling price list (up/down, enter); asks about the disk
  ports <name> [port ...]      show the public ports, or replace them (22 is always open)
  expose <name>                show what Tailscale Funnel publishes from name
  expose <name> <port> [/path] publish name:port on the internet at https://<name>.<tailnet>.ts.net/path
  expose <name> --rm </path>
  backup <name>                restic snapshot of /data and /mnt/volume (containers pause briefly)
  archive <name>               backup, then delete VPS, snapshot and volume
  restore <name> [snapshot] [--yes]  start if needed, then restore /data from restic
  destroy <name> [--yes]       delete VPS, snapshot and volume (asks for confirmation); on Contabo
                               it cancels the contract, which Contabo bills to the end of the period
  apply [name ...]             terraform apply for the whole inventory, then the agent setup to name (every running one)
  update [--force]             replace this binary with the latest release, at the same path, once its sha256 matches
  version
Progress goes to stderr as actions (--progress: auto is tty on a terminal, plain in a pipe or CI;
json is the raw event stream), results to stdout. Every run is appended to node-ctl.log.
On a terminal a missing <name> is asked (a menu of the machines the command can act on); create also
asks every option it is not given. Off a terminal a missing <name> is a usage error.
Environment: NODE_CTL_HOME=~/.node-ctl, and in it by default NODE_CTL_CONFIG=node-ctl.yaml, SERVERS_DIR=servers,
  NODE_CTL_LOG=node-ctl.log, GIT_KEY_FILE=keys/node-ctl_user_ed25519; NODE_CTL_PROGRESS, SKILLS_DIR=~/.claude/skills,
  CLAUDE_DIR=~/.claude, CLAUDE_JSON=~/.claude.json, LAUNCH_AGENTS=~/Library/LaunchAgents, NO_COLOR, FORCE_COLOR.
node-ctl <command> --help, or node-ctl help <command>: what one command does, its options, examples.
`;

export const PAGES: Record<string, string> = {
  init: `usage: node-ctl init [step ...]

Set up this computer: ask for every missing or broken credential, explain where to get it, verify it
and write node-ctl.yaml after each step, then terraform apply so every account knows the ssh key.
A value that already works is kept; a step named on the command line is asked again regardless.
A failed check repeats the question; Ctrl-C keeps what is saved so far.

Steps (in this order):
  ssh        the public key installed for node-ctl-user on every machine, and the Include line into ~/.ssh/config
  link       the node-ctl-migrate skill, unpacked into NODE_CTL_HOME, linked into SKILLS_DIR
  gitkey     generate the commit key every machine gets (GIT_KEY_FILE); kept once it exists
  hetzner    Hetzner accounts: a tag of your choice and that project's API token, one after another
  contabo    Contabo accounts: a tag, then client id, client secret, user and password
  tailscale  the Tailscale OAuth client that mints the machines' auth keys
  restic     the S3 bucket and password for archives (optional: empty disables archives)

Examples:
  node-ctl init                 first run: everything
  node-ctl init hetzner         add a Hetzner account or replace a token
  node-ctl init tailscale       rotate the Tailscale OAuth client
`,
  check: `usage: node-ctl check

Verify, without changing anything: the host tools (terraform, ssh and restic), the ssh key and agent,
node-ctl.yaml, every Hetzner and Contabo account's credentials, Tailscale and the restic bucket, then
that a running machine answers over the tailnet.
Exits 1 when something fails, with the command that fixes it.
`,
  accounts: `usage: node-ctl accounts [--json]
       node-ctl accounts add|edit [hetzner|contabo]

Without arguments: the cloud accounts of node-ctl.yaml, their cloud, tag and how many machines
each holds. add (or edit, the same dialogue) asks for one more account of that cloud, or new
credentials for an existing tag, verifies them and runs terraform apply. Without a cloud it asks.

Options:
  --json     the listing as a JSON array

Examples:
  node-ctl accounts
  node-ctl accounts add hetzner
  node-ctl accounts edit contabo
`,
  create: `usage: node-ctl create [<name>] [--account tag] [--type cx23] [--location nbg1] [--size GB] [--ports 22,80]

Create a new machine and wait until it answers over the tailnet (~3 min). The name is lowercase
letters, digits and dashes. A name that already exists is started instead (options are refused then).
On a terminal it asks what an option does not answer: the name, the account when there are several,
the server type (Hetzner: a price list with the locations that can take each type right now; Contabo:
its product line-up), the location, whether to add a volume, and the public ports. Off a terminal
the name is required, the defaults of node-ctl.yaml stand, there is no volume and only 22 is open.

Options:
  --account tag     the account to create it in; its tag says the provider
  --type type       server type (Hetzner, e.g. cx23) or product (Contabo)
  --location loc    location (Hetzner, e.g. nbg1) or region (Contabo)
  --size GB         a Hetzner Volume of that size at /mnt/volume; 0 = none (Hetzner only)
  --ports 22,80     public TCP ports (22 is always open)
Every option also takes --option=value.

Examples:
  node-ctl create dev1
  node-ctl create dev2 --account work --type cx33 --location fsn1 --size 0
  node-ctl create web --ports 22,80,443
`,
  volume: `usage: node-ctl volume <name> <size>

Add a Hetzner Volume of <size> GB at /mnt/volume to a machine that has none. A running machine
mounts it at once, a stopped one at its next start. Hetzner only: Contabo has no block storage.

Example:
  node-ctl volume dev1 50
`,
  ssh: `usage: node-ctl ssh <name> [cmd ...]

Log in as node-ctl-user over the tailnet, or run cmd there. Everything after the name goes to the
machine, --help included. Plain ssh node-ctl-<name> works too once node-ctl init has run.

Examples:
  node-ctl ssh dev1
  node-ctl ssh dev1 docker ps
`,
  gitkey: `usage: node-ctl gitkey <name>

Install the current commit key (GIT_KEY_FILE) as ~node-ctl-user/.ssh/id_ed25519 on a running
machine that was created before the key existed or before it was rotated. Every start does it anyway.
`,
  autostop: `usage: node-ctl autostop <name> <time | off>

Set, move or drop the stop of a running machine, as start --till does at a start: HH:MM (tomorrow
once past today), "YYYY-MM-DD HH:MM" in this computer's time zone, or how long from now: 6h, 6.9h,
90m. off drops it. list shows it under AUTOSTOP. The stop runs on this computer: a launchd job on
macOS, a systemd user timer on Linux (see start --help).

Examples:
  node-ctl autostop dev1 3h
  node-ctl autostop dev1 19:30
  node-ctl autostop dev1 off
`,
  hostkeys: `usage: node-ctl hostkeys <name>

Record a running machine's host keys again: drop its old entries from ~/.ssh/known_hosts and Orca's
stores, then add the keys it answers with now. create, start and restore already do this; use it for
a machine rebuilt outside the CLI.
`,
  cato: `usage: node-ctl cato <name> [account user]

Sign the Cato SDP client on a running machine in again. Its token is bound to the VPS it was issued
on, so a machine booted from its snapshot is disconnected until someone signs in, and Cato's Google
IdP only answers a real browser: the machine hands over the login URL, this computer's browser opens
it (two clicks: the Google account, then Continue), and the redirect to 127.0.0.1 reaches the machine
over an ssh port forward. account and user are stored in the inventory (.cato) the first time; from
then on start signs the machine in by itself once it is ready. The client itself is installed by hand.

Examples:
  node-ctl cato dev1 acme me@example.com
  node-ctl cato dev1
`,
  list: `usage: node-ctl list [--json]

Every machine of the inventory: account, state (ready once the tailnet sees it, starting until then,
stopping while a stop runs,
stopped, archived), how long a running one has been up (since its last start), when autostop
stops it, public IPv4, MagicDNS name, open ports and Funnel URLs.

Options:
  --json     a JSON array, with the IPv6, started and stops_at (epoch seconds) too; safe to parse: node-ctl list --json 2>/dev/null
`,
  load: `usage: node-ctl load [-f] [name]

CPU, memory, load average, disk busy time and root disk usage of a machine as bars (red past 70%),
sampled over one second. Without a name every running machine is one row of a table, all sampled
in parallel; a machine that does not answer says unreachable.

Options:
  -f, --follow   sample again every second: redrawn in place on a terminal, new lines in a pipe; Ctrl-C ends
`,
  stop: `usage: node-ctl stop <name ...> | --all

Stop the named machines, or every running one with --all. Without a name a terminal asks: every
running machine is the first line, then each of them; off a terminal it is a usage error.
Hetzner: the machine leaves the tailnet, its root disk (/data included) is written to a snapshot,
the VPS is deleted and the previous snapshot with it; a volume stays. Takes a few minutes.
Contabo: the instance is powered off and keeps its contract, disk and tailnet node.
A machine that fails to stop stays running in the inventory and nothing is lost: run stop again.
A stop cut short after its snapshot (the network gone while Terraform deletes the VPS) is finished the same way.

Examples:
  node-ctl stop dev1
  node-ctl stop dev1 dev2
  node-ctl stop --all       every running machine
`,
  start: `usage: node-ctl start <name ...> [--type [type]] [--till time] | --all

Bring stopped machines back as they were and wait until they answer; --all starts every stopped one,
with one Terraform apply for all of them. Without a name a terminal asks: every stopped machine is
the first line, then each of them; off a terminal it is a usage error. Hetzner: a new VPS from the disk
snapshot (kept as the last good copy), the volume attached again; its public addresses change.
Contabo: the instance is powered on. An archived machine needs node-ctl restore.

Options:
  --all          every stopped machine
  --type [type]  boot it as another server type (Hetzner only, one machine); without a value it shows the types
                 the location creates now whose disk holds the snapshot, and asks
  --till time    stop it then, by this computer's clock and time zone: HH:MM (tomorrow once past today) or
                 "YYYY-MM-DD HH:MM"; or after that long, counted from this command: 6h, 6.9h, 90m. The stop runs
                 here, so this computer must be on. macOS: a launchd job runs node-ctl stop; a Mac asleep or logged
                 out stops it on wake or at login; log: ~/Library/Logs/node-ctl-stop-<name>.log. Linux: a systemd
                 user timer (systemd-run --user) runs it, which needs lingering (sudo loginctl enable-linger $USER)
                 and is lost at a reboot; log: journalctl --user -u node-ctl-stop-<name>. Either retries a failed
                 stop every minute. A start without --till cancels an earlier one, autostop moves it.

Examples:
  node-ctl start dev1
  node-ctl start --all
  node-ctl start dev1 --type cx43
  node-ctl start dev1 --type        pick from the list
  node-ctl start dev1 --till 19:30
  node-ctl start dev1 --till "2026-12-01 09:00"
  node-ctl start dev1 --till 6.5h
`,
  resize: `usage: node-ctl resize <name> [type] [--grow-disk|--keep-disk]

Move a machine to another server type (Hetzner only); it reboots, its tailnet address stays.
Without a type it opens the types sold in its location, cheapest first: up/down (or k/j) and
page up/down move, enter picks, q cancels; types marked no are skipped. A stopped machine gets
the new type at its next start. If Hetzner refuses the type, the old one is put back and booted.

Options:
  --grow-disk    take the bigger disk of the new type (it never shrinks again)
  --keep-disk    keep the current disk (the default off a terminal; a terminal asks)

Examples:
  node-ctl resize dev1
  node-ctl resize dev1 cx43 --keep-disk
`,
  ports: `usage: node-ctl ports <name> [port ...]

Without ports: the public TCP ports of the machine's firewall. With ports: replace them all
(22 is always kept open).

Examples:
  node-ctl ports dev1
  node-ctl ports dev1 22 80 443
  node-ctl ports dev1 22          close everything else
`,
  expose: `usage: node-ctl expose <name>
       node-ctl expose <name> <port> [/path]
       node-ctl expose <name> --rm </path>

Publish a port of the machine on the internet through Tailscale Funnel, at
https://<name>.<tailnet>.ts.net/path (path / by default). Without a port: what is published now.
--rm takes a path off. A stopped machine gets the change at its next start. Funnel must be allowed
for the tailnet in the Tailscale admin console.

Examples:
  node-ctl expose dev1 3000
  node-ctl expose dev1 8080 /api
  node-ctl expose dev1 --rm /api
`,
  backup: `usage: node-ctl backup <name>

restic snapshot of /data (and /mnt/volume when there is one) of a running machine into the bucket
of node-ctl.yaml, tagged with the name. Docker is stopped while it runs. Needs node-ctl init restic.
`,
  archive: `usage: node-ctl archive <name>

backup, then delete the VPS, the disk snapshot and the volume: only the restic snapshot is left and
nothing is billed for the machine (on Contabo its contract is cancelled). node-ctl restore brings
it back.
`,
  restore: `usage: node-ctl restore <name> [snapshot] [--yes]

Start the machine if it is not running (an archived one is created again), then restore /data from
restic: the latest snapshot tagged with the name, or the snapshot id given. On a running machine
it overlays /data and asks first.

Options:
  --yes      do not ask

Examples:
  node-ctl restore dev1
  node-ctl restore dev1 4f2a9c1e --yes
`,
  destroy: `usage: node-ctl destroy <name> [--yes]

Delete the machine for good: the VPS, the disk snapshot and the volume, and its inventory entry.
It asks you to type the name. On Contabo it cancels the contract, which Contabo bills to the end
of the paid period. Run node-ctl backup first if /data matters.

Options:
  --yes      do not ask
`,
  apply: `usage: node-ctl apply [name ...]

terraform apply for the whole inventory, once per account, and rewrite ~/.ssh/config.d/node-ctl.
For after editing servers/<name>.json by hand. Then the named machines (every running one without a
name) get this computer's agent setup again, as create and start give it: CLAUDE.md, AGENTS.md, the
skills and the MCP servers. A named machine is also waited for, as start does, so apply <name> finishes a start
whose apply was cut short. Terraform always applies the whole inventory.

Examples:
  node-ctl apply
  node-ctl apply dev1
`,
  update: `usage: node-ctl update [--force]

Download the latest release for this OS and architecture, check its sha256 against the release's
checksums.txt and rename it over this binary. The path stays, so the launchd job (macOS) or systemd user
timer (Linux) of start --till runs the new binary; a download that fails or does not match leaves the old
one as it was. A link is followed: the file it points to is replaced. The latest release or an older one
changes nothing. NODE_CTL_RELEASES replaces https://github.com/pro100coder/node-ctl/releases.

Options:
  --force    install the latest release even if it is not newer; a dev build (version dev) needs it,
             since it has no version to compare

Examples:
  node-ctl update
  node-ctl version
`,
  version: `usage: node-ctl version

The version of this binary and the commit it was built from. Same as node-ctl --version.
`,
  help: `usage: node-ctl help [command]

The list of commands, or the page of one command (same as node-ctl <command> --help).
`,
};
