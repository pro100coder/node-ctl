# node-ctl

Disposable dev machines on Hetzner Cloud whose disk outlives them. One command gives you a VPS with
Docker, Tailscale and a firewall; stopping it deletes the VPS but keeps the whole disk, your work and
Docker data included, as a snapshot; archiving parks everything in S3-compatible storage until you
need it again.

Machines can also live on **Contabo**, on several accounts of either cloud. A Contabo instance is a
monthly contract, so it is powered off rather than deleted by `stop`, and it has no volume and no
resize; everything else — provisioning, the tailnet, ports, Funnel, backups — is the same machine.

> **node-ctl creates paid cloud resources on your accounts.** `create`, `start`, `resize`, `volume` and
> every `terraform apply` it runs make servers, volumes, snapshots and firewalls that Hetzner bills by the
> hour, and a Contabo machine is a monthly contract billed to the end of its period, powered off or not. A
> stopped Hetzner machine still pays for its snapshot and its volume. A scheduled stop (`--till`, `autostop`)
> runs on the computer that set it: while that computer is off, the machine keeps running and billing.
> `destroy` and `archive` delete for good. Check `node-ctl list` and your providers' consoles.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/pro100coder/node-ctl/main/install.sh | sh
```

`install.sh` picks the release for this OS and architecture (macOS or Linux, arm64 or x86_64), checks its
sha256 against the release's `checksums.txt` and puts `node-ctl` in `~/.local/bin` (`NODE_CTL_BIN_DIR`
changes that); it says so when that directory is not on `PATH`. It needs `curl` or `wget`. Running it again
installs the latest release over the old binary.

Requirements on this computer:

- `terraform` (>= 1.7): `brew install hashicorp/tap/terraform`, or HashiCorp's packages on Linux.
- OpenSSH (`ssh`, `ssh-add`, `ssh-keygen`, `ssh-keyscan`), which macOS and Linux ship.
- Tailscale, logged into the tailnet the machines will join (see [This host](#1-this-host)).
- `restic`, optional: only `check` uses it, to verify the archive bucket; backups run on the machines.
- For `start --till` and `autostop` on Linux: a systemd user manager with lingering enabled
  (`sudo loginctl enable-linger $USER`).

`node-ctl check` tells what is missing.

### Update

```sh
node-ctl update
```

Downloads the latest release, checks its sha256 and renames it over the running binary, at the same path (a
link is followed and the file it points to is replaced), so scheduled stops run the new one. A download that
fails or does not match leaves the old binary as it was. `node-ctl version` prints the version and the commit.
Every push to `main` that passes CI is a release, numbered `v0.YYMMDD.N`.

### Uninstall

Destroy or archive the machines first if you want them gone: the Terraform state in `~/.node-ctl` is what knows
which cloud resources are yours, and without it they keep running and billing until you delete them in the
providers' consoles. Then:

```sh
node-ctl autostop <name> off          # for every machine with an AUTOSTOP in node-ctl list
rm ~/.local/bin/node-ctl
rm ~/.claude/skills/node-ctl-migrate  # the link init made
rm ~/.ssh/config.d/node-ctl           # and the "Include config.d/node-ctl" line in ~/.ssh/config
rm -r ~/.node-ctl                     # configuration, every secret, the inventory, the commit key, the state
```

### Building from source

[bun](https://bun.sh) 1.3, then:

```sh
bun install --frozen-lockfile
bun run build                 # dist/node-ctl, version "dev" (update needs --force to replace it)
bun run check                 # unit tests, tsc, knip
bats tests                    # the CLI suite against dist/node-ctl (bats-core, jq, yq, node; rebuilds when the sources changed)
for root in terraform terraform/contabo; do
  terraform -chdir=$root init -backend=false && terraform -chdir=$root test
done
```

A binary run from a checkout uses the same `~/.node-ctl` as the installed one; set `NODE_CTL_HOME` to keep
them apart.

## How it works

- A **machine** is a VPS whose root disk holds `/data`: `/data/node-ctl-home` is the home directory,
  `/data/docker` Docker's data-root. `stop` snapshots that disk, so images and named volumes survive
  the VPS too; the machine always keeps its latest snapshot, and never more than one.
- A **Hetzner Volume** is optional: an extra disk at `/mnt/volume` for data too big for the root
  disk, asked for by `create` or added with `node-ctl volume`, re-attached on every start.
- Every machine has its own public IPv4 and IPv6, created and deleted with the VPS: a stopped
  machine holds no address and pays for none.
- Every machine joins your **Tailscale** tailnet under its own name: `ssh node-ctl-user@dev1`, `http://dev1:8080`.
- Public exposure is a **cloud firewall** per machine (Hetzner's, or Contabo's on a Contabo account):
  port 22 only by default, changed with `node-ctl ports`. Nothing is configured on the hosts themselves.
- Publishing a service on the internet is **Tailscale Funnel**: `node-ctl expose dev1 8080` serves it
  at `https://dev1.<tailnet>.ts.net/`, TLS included, no DNS to set up.
- One machine hosts **any number of projects** (each under `~/<project>` with its own
  `docker compose`). The tool manages machines and routing, never projects.

## Setting up

```sh
node-ctl init
```

Everything node-ctl keeps lives in `~/.node-ctl` (`NODE_CTL_HOME`): `node-ctl.yaml`, the inventory
`servers/`, the commit key `keys/`, `node-ctl.log` and the Terraform roots with their state (see [Layout](#layout)).
`init` (step `link`) also unpacks the `node-ctl-migrate` skill there and links it into `~/.claude/skills`
(`SKILLS_DIR`): `/node-ctl-migrate <machine>` in Claude Code, run in any project directory, walks through moving
that project (code, Docker volumes, ports) onto a machine.

`init` asks for every credential in turn, says where to get it, verifies each group against its
API before moving on (the restic repository is initialised if the bucket is empty; archive storage
itself is optional), writes `~/.node-ctl/node-ctl.yaml` after every step (seeded from the template
`node-ctl.example.yaml` the binary carries, comments included), so you can stop and rerun it at any point, and finishes with `terraform
apply`, so the ssh key is registered with every Hetzner account before the first `create`. On a rerun every value that is
set and still works is kept without asking; `node-ctl init tailscale` (steps: `ssh link gitkey hetzner
contabo tailscale restic`) re-asks a step on purpose. `node-ctl check` repeats the
verification later, `node-ctl accounts` lists the accounts and `node-ctl accounts add` asks for one more. The reference below is what `init` asks for; the file can also be edited by hand.

```yaml
hetzner:                       # one entry per Hetzner project: a tag of your choice -> its API token
  work: <token>
  home: <token>
tailscale:
  client_id: k1a2b3c4CNTRL
  client_secret: tskey-client-...
ssh_public_key_file: ~/.ssh/id_ed25519.pub
restic:                        # optional; an empty repository means no archives
  repository: s3:https://nbg1.your-objectstorage.com/<bucket>
  password: ...
  access_key_id: ...
  secret_access_key: ...
defaults:                      # optional
  type: cx23
  location: nbg1
```

### 1. This host

- `terraform` and `ssh`, `restic` optionally (see [Install](#install)); `node-ctl check` tells what is missing.
- Tailscale, logged into the tailnet the machines will join, with **MagicDNS** enabled
  (admin console → DNS → MagicDNS). `ssh node-ctl-user@dev1` relies on the names resolving.
- An SSH key pair. `ssh_public_key_file` points at the public key (default
  `~/.ssh/id_ed25519.pub`; `ssh-keygen -t ed25519` if you have none). It is installed for `node-ctl-user` (passwordless sudo) on
  every machine. A passphrase is fine: the first command that needs ssh loads
  the key into `ssh-agent` and asks for it once; on macOS the passphrase then lives in Keychain.
  `node-ctl init` also adds `Include config.d/node-ctl` to `~/.ssh/config`: every command that changes the
  machines rewrites `~/.ssh/config.d/node-ctl` from the inventory, so `ssh node-ctl-dev1`, `scp`, `rsync` and
  editors that speak ssh reach a machine by name without `node-ctl ssh` — and without depending on
  MagicDNS, since the file carries the address the Tailscale daemon reports. It is generated: the
  entries follow `node-ctl list`, and anything you write into it is overwritten.
  `node-ctl` itself never checks a host key, but `git`, `rsync` and editors do: every `create`,
  `start` and `restore` refreshes the machine's entries in `~/.ssh/known_hosts` with the keys the
  rebuilt machine answers with, so nothing stops at "REMOTE HOST IDENTIFICATION HAS CHANGED".
  Orca ADE keeps host keys in its own store rather than in `known_hosts`, and that store is
  refreshed in the same pass. `node-ctl hostkeys <name>` repeats it for a machine that already
  runs — for one rebuilt outside the CLI, or a store that went stale before the CLI knew about it.
- A commit key. `node-ctl init` generates `~/.node-ctl/keys/node-ctl_user_ed25519`, asking `ssh-keygen`'s
  own passphrase question — leave it empty so agents on a machine can push unattended, or set one
  and type it at every push there. `init` prints its public half: add it to GitHub (Settings → SSH and GPG keys), GitLab or a deploy key of the
  repositories the machines work on. Every `create`, `start` and `restore` writes it to
  `~node-ctl-user/.ssh/id_ed25519` on the machine, so `git clone`/`push` over ssh works there without
  forwarding your own key. `node-ctl init gitkey` shows the public key again; delete the file to
  generate a new one (then re-register it; `node-ctl gitkey <name>` puts it on a machine that already
  runs, one created before the key existed included).
  `GIT_KEY_FILE` points somewhere else if you already have a key for this.
- Your agent setup. Every `create`, `start` and `restore` copies this computer's
  `~/.claude/CLAUDE.md` and `~/.claude/AGENTS.md` (`CLAUDE_DIR`, whichever exist), the skills in
  `~/.claude/skills` (`SKILLS_DIR`) and the user-scope MCP servers of `~/.claude.json` (`CLAUDE_JSON`) to
  `~node-ctl-user/` on the machine, so Claude Code there works with the same instructions, skills and
  servers you have here; an edit reaches an existing machine on its next start or `node-ctl apply`.
  A skill deleted here is deleted there; skills the agent on the machine added itself are left alone.
  Plugins and project-scope servers stay here; a stdio server needs its command on the machine too.
  An MCP server is added only when the machine has none of that name: one you edit there keeps your edit.

### 2. Hetzner Cloud → `hetzner`

Console → your project → Security → API tokens → Generate API token, permission **Read & Write**.
Terraform creates the servers, volumes and firewalls with it. `hetzner` maps a tag of your choice
(lowercase, e.g. the project's name) to that project's token, one entry per project; `init hetzner`
asks for them one by one. Every machine belongs to one account (`"account"` in `servers/<name>.json`):
`create` uses the only account silently, asks which one on a terminal when there are several, and
takes `--account <tag>` in scripts. Each account is its own Terraform workspace
(`~/.node-ctl/terraform/terraform.tfstate.d/<tag>`), so an `apply` runs once per account with that account's token.

### 2b. Contabo (optional) → `contabo`

Customer Control Panel → Account → **Security & Access** → *API credentials*: the Client ID, the Client
Secret and the Username. That username is the API user, an address of its own — not the one you log in
with — and it has its own password, which the **Send link** button on that page mails a link to set. `contabo` maps a tag
of your choice to those four values, one entry per Contabo account; `init contabo` asks for them and
verifies them, and an empty tag ends the step — no Contabo account is a valid answer.

A tag names exactly one account, on one cloud: `servers/<name>.json` keeps saying only `"account"`,
and that tag decides which provider, which credentials and which Terraform root
(`terraform/contabo/`, its own workspace per account) a machine belongs to. `create` shows the
provider next to each tag when it asks. `--type` is a Contabo product id (`V45` by default) and
`--location` a region (`EU`); `defaults.contabo.type` and `defaults.contabo.location` change them.
On a terminal `create` offers both: the regions the Terraform provider documents (`EU`, `US-central`,
`US-east`, `US-west`, `SIN`) and the product line-up of the API documentation, without prices —
Contabo's API carries none and has no endpoint that lists products at all, so `create` reads the
table in `createInstance`'s description from the public spec (`api.contabo.com/api-v1.yaml`) every
time. That list is only a shortcut: a product id typed in full is taken as it is.

What Contabo cannot do, and what the CLI does instead: `stop` powers the instance off and `start`
powers it on (the contract, the disk and the tailnet node stay, and Contabo keeps billing it);
`destroy` and `archive` cancel the contract, which Contabo bills to the end of the paid period;
`volume` and `resize` are refused. Ports need the firewall add-on on the contract, otherwise the
apply fails with the API's error.

### 3. Tailscale → `tailscale.client_id`, `tailscale.client_secret`

Terraform issues a single-use, pre-authorised auth key per machine through an OAuth client, so no
key is stored anywhere and machines join without approval.

1. Declare the tag first. Admin console → Access controls → **JSON editor**, add `tag:dev` to the
   `tagOwners` block (the default policy already has one, with `tag:example`) and save:
   ```json
   "tagOwners": {
     "tag:example": ["autogroup:admin"],
     "tag:dev":     ["autogroup:admin"]
   },
   ```
   Access controls → **Definitions → Tags** must now list `tag:dev` with owner `autogroup:admin`.
   Until it does, the OAuth client form of step 2 shows no tag field at all, and a client generated
   that way cannot mint `tag:dev` keys: `apply` then fails with
   `requested tags [tag:dev] are invalid or not permitted (400)`.
   If your policy is not the default allow-all, also add a rule letting your devices reach `tag:dev`.
   For `node-ctl expose` (Tailscale Funnel) the same editor needs a node attribute, and the tailnet
   needs HTTPS certificates (DNS → HTTPS Certificates → Enable):
   ```json
   "nodeAttrs": [
     { "target": ["tag:dev"], "attr": ["funnel"] }
   ],
   ```
2. Settings → OAuth clients → Generate OAuth client: scopes **Auth Keys → Write** and **Devices → Core → Write**, then the
   **Tags** field that appears under it → `tag:dev`.
3. Copy the client ID (looks like `k1a2b3c4CNTRL`) and the secret (`tskey-client-…`, shown once)
   into `node-ctl.yaml`. An **auth key** from Settings → Keys (`tskey-auth-…`) is a different thing and the
   API rejects it with 401. `init` and `check` verify the client by minting and deleting a `tag:dev`
   key, so a missing tag or a client generated without it is caught before `apply`. A client made
   before the tag existed cannot be fixed: delete it and generate a new one.

**From the terminal instead.** OAuth clients cannot be created by the `tailscale` CLI, but the
API does it, and `init` offers this when you leave the client ID empty. The one thing that still
needs the browser is a personal API access token: Settings → Keys → Generate access token (delete
it once you are done); `init tailscale` asks for it (or reads `TS_API_KEY`) and never stores it.
It allows `tag:dev` in the policy (posting it back as plain JSON, so comments of a HuJSON policy are
lost) and writes the new client's id and secret into `node-ctl.yaml`. The secret is not retrievable
later; create a new client if you lose it.



### 4. Archive storage (optional) → `restic`

Only `backup`, `archive` and `restore` need this: they send `/data` to an S3-compatible bucket
with restic. Leave `restic.repository` empty to go without archives; `stop`/`start` keep the whole
machine in its disk snapshot regardless, and those three commands refuse until the bucket is configured. For Hetzner
Object Storage: Console → Object Storage → Create bucket (any name, pick the region of your machines,
e.g. `nbg1`) → Manage credentials → Generate credentials.

- `restic.repository: s3:https://nbg1.your-objectstorage.com/<bucket>` (region prefix as shown in
  the bucket's details).
- `restic.password`: any long random string. Every archive is encrypted with it; losing it loses the
  archives.
- `restic.access_key_id` / `restic.secret_access_key`: the generated S3 credentials (restic reads them
  as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`).

Any other S3-compatible storage works the same way.

### 5. Verify

```sh
node-ctl check
```

Every line must read `ok`. A `FAIL` line names the variable or the API that rejected the value;
`node-ctl init` again fixes it in place.


## Quick start

```sh
curl -fsSL https://raw.githubusercontent.com/pro100coder/node-ctl/main/install.sh | sh
node-ctl init                 # asks for every credential, explains where to get it, verifies, writes ~/.node-ctl/node-ctl.yaml
node-ctl check                # every line must read ok
node-ctl create dev1          # ~3 min; asks for the type (Hetzner: a price list), its location and an extra volume
node-ctl ssh dev1             # the home directory is /data/node-ctl-home
```

## Commands

| Command | Effect |
|---|---|
| `node-ctl init [step ...]` | Ask for missing or broken credentials with a hint where to get them, verify, write `node-ctl.yaml`, `terraform apply` so the ssh key is registered with every account; named steps are re-asked (`init hetzner` adds accounts or replaces a token) |
| `node-ctl check` | Verify host tools, `node-ctl.yaml` and the credentials against every Hetzner and Contabo account, Tailscale and the restic bucket |
| `node-ctl accounts [--json]` | The cloud accounts of `node-ctl.yaml` — their cloud, tag and how many machines each holds |
| `node-ctl accounts add\|edit [hetzner\|contabo]` | Ask for one more account of that cloud (an existing tag replaces its credentials), verify it and `terraform apply`; the same dialogue as `init hetzner` / `init contabo` |
| `node-ctl create <name> [--account tag] [--type cx23] [--location nbg1] [--size GB] [--ports 22,80]` | New machine; without options, also brings a stopped one back (options only shape a new machine). With several accounts it asks which one on a terminal (each with its provider), `--account` answers. On a terminal, and on Hetzner, it then shows the types a location will actually take right now (`server_types[].locations[].available`, the only field that predicts a create: a price does not, and neither does the `available` list of `/datacenters`), cheapest first and with those locations, and asks for the location too when several can take it; `--type` and `--location` answer, and off a terminal `defaults.type` and `defaults.location` stand. On a terminal it also asks whether to add a Hetzner Volume at `/mnt/volume`; `--size` answers (`0` = none), and off a terminal there is none |
| `node-ctl volume <name> <size>` | Add a Hetzner Volume (GB) at `/mnt/volume` to an existing machine; mounted at once when it runs, at the next start otherwise (Hetzner only) |
| `node-ctl ssh <name> [cmd ...]` | ssh over the tailnet (plain `ssh node-ctl-<name>` works too, see below) |
| `node-ctl hostkeys <name>` | Record a running machine's host keys again — in `~/.ssh/known_hosts` and in Orca ADE's own store — for a machine rebuilt outside the CLI. `create`, `start` and `restore` already do it |
| `node-ctl cato <name> [account user]` | Sign the Cato SDP client on a running machine in again (the client itself is installed by hand). Its token is bound to the VPS it was issued on, so a machine booted from its snapshot comes up disconnected; Cato's Google SSO only answers a real browser, so the machine hands over the login URL, this computer's browser opens it (pick the account, Continue) and the redirect comes back over an ssh port forward. `account` and `user` are remembered in the inventory the first time; from then on `start` does it by itself once the machine is ready, and a failure there is a warning |
| `node-ctl list [--json]` | Machines, accounts, states (`ready` once the tailnet sees the machine, `starting` until then), public IPv4, MagicDNS names, ports, Funnel URLs (`--json` has the IPv6 too) |
| `node-ctl load [-f] [name]` | CPU, memory, load average, disk busy and root disk usage (with free space) as htop-style bars (green, red past 70%), sampled over one second of `vmstat`; without a name one row per running machine, sampled in parallel; `-f` redraws them in place every second |
| `node-ctl stop <name ...> \| --all` | Several names stop several machines, `--all` every running one; without a name a terminal offers a menu (all of them first, then each), anywhere else it is a usage error. Delete the VPS, keeping its root disk (`/data` included) as a Hetzner snapshot and its volume, if any (Hetzner bills powered-off servers, so there is no power-off). Takes a few minutes: the machine is shut down and its disk written out. The previous snapshot is deleted once the new one is written. On Contabo there is nothing to delete for free: the instance is powered off instead, and keeps its contract, its disk and its tailnet node |
| `node-ctl start <name ...> [--type [type]] [--till time] \| --all` | Several names (or `--all`, every stopped machine) start with one apply; without a name a terminal offers the same menu as `stop`. New VPS from that snapshot, the volume attached again — the machine comes back as it was, not as a fresh install. The snapshot stays: it is the machine's last known good copy. `--type` boots it as another server type (Hetzner only, the same window `resize` opens; without a value it asks): a start is a create, not a migration, so the column is `CREATE = yes/no` — what the location will actually create now, and only a type whose disk holds the snapshot. On Contabo it powers the instance on again. `--till 19:30` (or `"YYYY-MM-DD HH:MM"`, this computer's time zone; or a lifetime from now: `6h`, `6.9h`, `90m`) stops it then, from this computer: on macOS a launchd job runs `stop`, on wake or at login if the Mac was asleep or logged out; on Linux a systemd user timer (needs lingering, lost at a reboot); either retries a failed stop every minute. A start without `--till` cancels it |
| `node-ctl restart <name>` | Reboot the same VPS through its provider (Hetzner: an ACPI reboot; Contabo: a restart of the instance) and wait until it answers from the new boot. Works when ssh no longer does; disk, tailnet and public addresses stay. A machine too hung for an ACPI reboot needs `stop`, then `start` |
| `node-ctl resize <name> [type] [--grow-disk\|--keep-disk]` (Hetzner only) | Move the machine to another server type. Without one it opens the types sold in its location — cores, RAM, shared or dedicated CPU, disk and the monthly price, cheapest first, the machine's own type among them (`*`) — as a window you walk with up/down and page up/down, `enter` picks, `q` cancels; types Hetzner will not migrate into, or whose disk is smaller than the machine's, are shown with `MOVE = no` and skipped by the cursor. When the new type has a bigger disk it asks whether to grow the disk (a grown disk never shrinks, so smaller types are out from then on); `--grow-disk` / `--keep-disk` answer off a terminal, keep is the default |
| `node-ctl ports <name> [port ...]` | Show the public TCP ports, or replace them (22 is always included; `ports dev1 22` closes the rest) |
| `node-ctl expose <name> [<port> [/path] \| --rm </path>]` | Show what the machine publishes, or publish `name:port` on the internet at `https://<name>.<tailnet>.ts.net/path` through Tailscale Funnel |
| `node-ctl backup <name>` | restic snapshot of `/data`, and of `/mnt/volume` when there is one (Docker is stopped while it runs) |
| `node-ctl archive <name>` | `backup`, then delete VPS, disk snapshot and volume |
| `node-ctl restore <name> [snapshot] [--yes]` | Start the machine if needed and restore `/data` (latest snapshot tagged with the name, or the given id); on a running machine it asks first |
| `node-ctl destroy <name> [--yes]` | Delete VPS, disk snapshot **and** volume; asks you to type the name. On Contabo it cancels the contract, which is billed to the end of the paid period |
| `node-ctl apply [name ...]` | `terraform apply` for the whole inventory, then the agent setup (instructions, skills, MCP servers) to the named machines, every running one without a name |
| `node-ctl autostop <name> <time \| off>` | Set, move or drop the scheduled stop of a running machine, as `start --till` does; `list` shows it under AUTOSTOP |
| `node-ctl update [--force]` | Replace this binary with the latest release, at the same path, once its sha256 matches; `--force` installs it even when it is not newer (a `dev` build needs it) |
| `node-ctl version`, `--help` | |
| `node-ctl <command> --help`, `node-ctl help <command>` | What one command does, its options and examples; works before `node-ctl.yaml` exists |

Results (the `list` table or JSON, `ready: …`, ports, Funnel URLs) go to stdout; progress and errors go to
stderr, so `node-ctl list --json 2>/dev/null` is safe to parse. Confirmations are asked on a terminal only;
in a script pass `--yes`. Every question with a list of answers — account, cloud, type, product,
location, volume size, yes/no — is a menu: up/down (or `j`/`k`, page up/down) move, `enter` picks, `q`
cancels, and the answer replaces the menu once picked. Where the terminal cannot draw it (no terminal
on stdin and stderr, or fewer than 50 columns) it is the numbered list and a typed number or value.
Free text (a tag, a credential) is typed. Colour follows the terminal, `NO_COLOR` and `FORCE_COLOR`. Every run exits 1 on
any error. `node-ctl --help` lists the environment variables (`NODE_CTL_CONFIG`, `SERVERS_DIR`, `NODE_CTL_LOG`, …).

### Progress

Every command is a plan of **actions** (`Write inventory`, `Apply Terraform`, `Wait for dev1`, …); a
line of output belongs to the action that produced it, and a child process (Terraform, ssh, restic)
has each of its lines tagged with the action that ran it and the stream it came from. On a terminal
finished actions collapse to one line and only the running ones are redrawn:

```
✓ [1/3] Write inventory                       0.0s
✓ [2/3] Apply Terraform                     118.3s
⠹ [3/3] Wait for dev1                        71.0s
└─ 7/60 ssh: Could not resolve hostname dev1
```

A failed action keeps its last lines and the reason under it; nested actions (`terraform apply`
under `Apply Terraform`, the three credential probes of `check`, which run in parallel) sit under
their parent. `--progress=` (first argument) or `NODE_CTL_PROGRESS` selects the renderer: `auto`
(default: `tty` on a terminal, `plain` elsewhere), `plain` (append-only, no ANSI, one label per
line: `[2/3 apply > apply] stderr| Error: …`), `json` (one event per line: `action_id`,
`parent_action_id`, `action_name`, `event_type`, `message`, `current`/`total`, `stream`,
`timestamp`, `duration_ms`). `init` always uses `plain`, its prompts cannot share the screen with
a live region (nor does `accounts`). Ctrl+C marks the open actions `cancelled` and exits 130.

## Machine states

The inventory is `~/.node-ctl/servers/<name>.json` (no secrets). `state` decides what exists:

| state | VPS | Disk snapshot | Volume (if any) | `/data` lives in |
|---|---|---|---|---|
| `running` | yes | the last `stop`'s, if ever stopped | attached | the root disk |
| `stopped` | no | yes | kept | the snapshot |
| `archived` | no | no | no | restic snapshot in S3 |

On Contabo the same states mean: `running` the instance is up, `stopped` it is powered off (the
contract and the disk stay, and so does the bill), `archived` the contract is cancelled and `/data`
is in restic. There is no disk snapshot there, so a stopped Contabo machine is not a rollback point:
what `node-ctl backup` put in restic is the only copy.

No file = no machine. `node-ctl list` refines `running` with what this host's Tailscale sees:
`ready` when the machine is online in the tailnet (joining it is the last step of provisioning),
`starting` until then; without a Tailscale CLI on the host it just says `running`.

## Publishing a service

```sh
node-ctl expose dev1 8080            # https://dev1.<tailnet>.ts.net/    -> dev1:8080
node-ctl expose dev1 3000 /api       # https://dev1.<tailnet>.ts.net/api -> dev1:3000
node-ctl expose dev1                 # what is published
node-ctl expose dev1 --rm /api
```

Tailscale Funnel serves the machine's port to the whole internet under its tailnet name, with a
certificate Tailscale obtains; the project only needs to publish the port on the machine
(`ports: ["8080:80"]` in its compose file), no firewall port and no DNS record. The map of paths
to ports lives in `servers/<name>.json`, and `start` and `restore` put it back on a rebuilt
machine (`stop` logs the node out, and a logged-out tailscaled keeps no Funnel configuration). The name
is fixed to `<name>.<tailnet>.ts.net` and the public addresses of a machine change at every
`start`, so nothing may point DNS at them; a custom domain is a project's own reverse proxy on
the machine with 80/443 in `node-ctl ports`. Funnel needs the `funnel` node attribute for `tag:dev`
and HTTPS certificates enabled in the tailnet (see Tailscale above).

## Backups

- `backup` stops Docker for the duration of the snapshot, so containers pause for seconds to minutes.
- `restore` on a running machine overlays the snapshot onto `/data`; files created after the
  snapshot are not deleted.
- The disk snapshot `stop` takes holds `/data`, so a stopped machine has one copy of its data
  there; a running machine that was stopped before has the previous one. Hetzner has no volume
  snapshots: for `/mnt/volume` the restic repository is the only copy besides the volume itself.

## Troubleshooting

- **What happened?** Every run appends its command line, output and exit status to `~/.node-ctl/node-ctl.log`
  (`NODE_CTL_LOG=path` moves it; `help` and `version` are not logged); read it before re-running a command that failed. Progress lands there
  as plain lines stamped with the time, every line of a failed step included, whatever the screen showed;
  `ssh` and `load` are not recorded beyond their command line and exit status. Past 10 MB the log becomes
  `node-ctl.log.1` (one older generation is kept). When stdout or stderr is redirected the two streams
  reach the log through separate writers, so their relative order there is approximate.
- **`terraform apply failed: the inventory is updated, the infrastructure is not`.** The
  `servers/<name>.json` edit is done; fix what Terraform complained about and run `node-ctl apply`.
- **`create` ends with "not reachable over the tailnet: …".** The ssh error after the colon says
  why. `Could not resolve hostname`: MagicDNS is not answering on this host (a known macOS bug,
  tailscale/tailscale#19139); `node-ctl` itself asks the Tailscale CLI for addresses and keeps
  working, but `ssh node-ctl-user@dev1` and `http://dev1:8080` need the fix in Tailscale. `Permission
  denied`: the private key is not in `ssh-agent`; `node-ctl check` loads it (no agent yet:
  `eval $(ssh-agent)` first). `node-ctl check` probes this host's Tailscale and one running machine
  and fails the same way, so run it before the next `create`.
- **`Host key verification failed` / `REMOTE HOST IDENTIFICATION HAS CHANGED`.** Every `start`
  rebuilds the machine, so its host key changes; `create`, `start` and `restore` rewrite the entries
  in `~/.ssh/known_hosts` and in Orca ADE's store for you. A machine rebuilt outside the CLI, or a
  store that went stale before the CLI knew about it, is fixed with `node-ctl hostkeys <name>`.
- **A node `dev1-1` appears in the tailnet.** `stop`/`destroy` could neither run `tailscale logout`
  on the machine nor delete its node through the API (an OAuth client without `devices:core`?
  `node-ctl check` tells); delete the stale `dev1` node in the admin console.
- **`create` waits for minutes.** Installing Docker, Node and the agents takes 2–4 minutes.
  Much longer: `ssh node-ctl-user@<IPv4 from node-ctl list>` (the machine is not on the tailnet yet) and
  read `/var/log/cloud-init-output.log`.
- **`expose` answers `Funnel is not enabled`** (or the URL does not open). The tailnet lacks the
  `funnel` node attribute for `tag:dev` or HTTPS certificates; both are set in the admin console
  (see Tailscale above), then `node-ctl expose <name> <port>` again.
- **A type is `no` in the list.** The selection walks past it and naming it is an error, but it
  stays in the list with its price: a price you cannot have is worth seeing next to the ones you
  can. The question behind the column depends on the machine: a running one is migrated
  (`MOVE`, `available_for_migration`), a stopped one is created from its snapshot
  (`CREATE`, `locations[].available`). The two disagree often — `nbg1` creates a `cx23` happily and
  still refuses to move a server into one — so a type `resize` refuses may well start:
  `node-ctl stop <name>`, then `node-ctl start <name> --type <type>`. Types of another
  architecture (ARM for an x86 machine), or not sold in that location, are not listed at all.
- **A resize was refused anyway** (`resource_unavailable`: the type sold out between the list and
  the apply, or `MOVE` went stale). Terraform had stopped the machine before changing its type, so
  `resize` puts the old type back in the inventory and powers the machine on again; it keeps
  running on the old type and nothing on `/data` is touched. If the power-on itself failed, the
  Hetzner console has the button.
- **Growing a volume.** Raise `volume_size` in `servers/<name>.json`, `node-ctl apply`, then on the
  machine `resize2fs /dev/disk/by-id/scsi-0HC_Volume_*`. Growing the root disk is `resize` into a
  type with a bigger disk, answering yes.

## Layout

What node-ctl keeps on this computer, in `~/.node-ctl` (`NODE_CTL_HOME`; `node-ctl --help` lists the
variables that move single files):

```
node-ctl.yaml        every secret: accounts, Tailscale OAuth client, restic
servers/             the inventory, one JSON per machine
keys/                node-ctl_user_ed25519, the commit key installed on every machine
node-ctl.log         every run (node-ctl.log.1 past 10 MB)
terraform/           the Hetzner root, unpacked from the binary, with terraform.tfstate.d/<account>/ and .terraform/
terraform/contabo/   the Contabo root, the same way
terraform/modules/   the shared cloud-init module (unpacked)
scripts/             the scripts cloud-init runs on a machine (unpacked)
skills/              the node-ctl-migrate skill (unpacked; init links it into ~/.claude/skills)
```

Every new version unpacks its own `*.tf`, modules, lock files and scripts there and never touches
`terraform.tfstate.d/` or `.terraform/`; an edit to an unpacked file does not survive the next version.
This state is the only record of which cloud resources are yours: back up `~/.node-ctl` with the rest of
your home directory.

The source tree:

```
src/                 the CLI (TypeScript, compiled by bun into one binary); src/progress/ draws the actions
test/                unit tests (bun test)
tests/               bats suite for the binary, with stubbed terraform/ssh/restic/tailscale and a test HTTP server for the APIs
node-ctl.example.yaml  configuration template, embedded; init seeds node-ctl.yaml from it
terraform/           Hetzner root: machines, volumes, firewalls, Tailscale keys, one workspace per account; tests/ with mocked providers
terraform/contabo/   Contabo root: instances, firewalls, Tailscale keys, one workspace per account; its own tests/
terraform/modules/cloud-init/  the cloud-config both roots render, so a machine is the same machine on either cloud
scripts/             scripts that run on the machines: provision.sh, mount-volume.sh (cloud-init), load.sh (piped over ssh)
skills/              the node-ctl-migrate Claude Code skill
install.sh           the installer; .github/ holds CI and the release job
```

