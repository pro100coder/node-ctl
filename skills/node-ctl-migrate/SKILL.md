---
name: node-ctl-migrate
description: Move the project in the current directory, code and Docker data included, onto the named node-ctl machine, prove it runs there and report.
argument-hint: <machine>
disable-model-invocation: true
---

# Migrate this project to the node-ctl machine `$ARGUMENTS`

The machine is `$ARGUMENTS`; with no argument, stop and ask for the name. Run from the project root.
`node-ctl` is on PATH (its `install.sh` puts it in `~/.local/bin`; `node-ctl init` links this skill, and the
machines it knows are in `~/.node-ctl/servers/`), so `node-ctl list`, `node-ctl ssh <name>` and plain `ssh node-ctl-<name>` work from here.
The machine is x86_64 Ubuntu with Docker, `node-ctl-user` (sudo, docker group), home `/data/node-ctl-home`.
Only `/data` survives a `node-ctl stop` + `start`; swap, packages and anything under `/usr` do not.

The order is a gate, then the move, then the same gate on the other side: nothing is copied until the
project is proven to run here, and nothing is reported done until the same proof passes there.

## Splitting the work

When the Agent tool is available, hand independent legwork to subagents and keep the gates yourself:

- steps 1 and 2 to one agent each, in parallel (reading the project and starting it do not wait for each other);
- step 4: one agent for the code sync, one per Docker volume, in parallel, each told exactly what to copy;
- step 6 to a fresh agent that has seen none of the move: give it only the machine name and the smoke check
  from step 2, so it proves the result instead of remembering it.

Every agent reports what it ran and what came back; you compare, decide and write the report.

## 1. Take stock

Read the project before touching anything: compose files, `.env*`, `bin/`/`Makefile` start scripts,
`.gitignore`, `.dockerignore`, `docker volume ls` and `docker compose ps` for the local stack.
Done when you have written down, and shown the user:

- the **start command** that brings the stack up (e.g. `docker compose up -d --build`, `bash bin/up`);
- **files to sync**: the tree plus the gitignored files the stack needs (`.env*`, local overrides, `var/`);
- **files to leave behind**: architecture-bound caches and builds (`node_modules`, `.venv`, `vendors/`,
  `.pnpm-store`, `.pip_cache`, `target/`), the machine rebuilds them for x86_64;
- **data to move**: named Docker volumes and bind-mounted data directories, with their sizes;
- **images the machine cannot pull** (private registries it has no login for): build them there from their Dockerfile;
- **ports** the project serves, and which of them the world must reach;
- **hostname-bound config**: `PUBLIC_HOST`, OAuth callbacks, webhooks, tokens minted against a URL.

## 2. Prove it runs here

Run the start command locally and wait for it to settle. Then write the **smoke check**: the smallest
commands that prove the project is up, and their expected answers — `docker compose ps` with every service
`running`/`healthy`, `curl -sf localhost:<port>/<health path>` with its status, a login page, a query against
the database. This check is the migration's acceptance test; step 6 runs it verbatim against the machine.

A service that does not come up locally is not carried across: tell the user what is broken and stop
here, unless they say it was broken before and should move as it is (then the smoke check excludes it and the report names it).
Done when the smoke check passes locally and is written down.

## 3. Have the machine

`node-ctl list`. A machine with that name that is `ready`: use it, and check that the ports from step 1 are free on
it (`ss -ltn`), since another project may already live there. Stopped: `node-ctl start <name>`.
Missing: `node-ctl create <name>`; it asks for the type, the location and a volume; a heavy image
build (native gems, grpc, large `pnpm install`) does not fit in 4 GB RAM, so pick a bigger type
or plan on `node-ctl resize` afterwards. Done when `ssh node-ctl-<name> true` returns 0.

## 4. Move code and data

Stop the local stack first (`docker compose stop`) so the data you copy is consistent. Code:

```sh
rsync -az --info=progress2 --exclude node_modules --exclude .venv ... ./ node-ctl-<name>:/data/node-ctl-home/<project>/
```

Data, one stream per named volume, no intermediate file:

```sh
docker run --rm -v <vol>:/v alpine tar cz -C /v . \
  | ssh node-ctl-<name> "docker volume create <vol> >/dev/null && docker run --rm -i -v <vol>:/v alpine tar xz -C /v"
```

Bind-mounted directories go with `rsync -az` to the same path under `/data`. Volume names carry the
compose project prefix (`<project>_postgres_data`): keep the name, or the new stack creates an empty one.
Done when `ssh node-ctl-<name> ls -la /data/node-ctl-home/<project>` shows the `.env*` files and none of the
excluded paths, and `ssh node-ctl-<name> docker system df -v` lists every volume from step 1 at about the local size.

## 5. Start it there

```sh
node-ctl ssh <name> 'cd /data/node-ctl-home/<project> && <start command>'
```

Long builds: run them under `nohup … > ../<project>-up.log 2>&1 &` and watch `node-ctl load <name>`;
ssh times out during a build that eats all RAM. A build that needs more than the machine has: a
temporary swapfile (`fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`,
gone after stop + start) or `node-ctl resize <name>`. Private images: `docker build` them on the machine first.
Done when the start command has returned and `docker compose ps` there lists every service.

## 6. Prove it runs there

Run the smoke check from step 2 on the machine, unchanged, through `node-ctl ssh <name> …`. Then publish:

- HTTP: `node-ctl expose <name> <port> [/path]` gives `https://<name>.<tailnet>.ts.net/path`.
- Raw TCP (databases, ssh tunnels): `node-ctl ports <name> 22 <port>`, then the public IPv4 from `node-ctl list`.
  That address changes at every `start`; the Funnel name does not.

Update the hostname-bound config from step 1 to the new URL, re-mint URL-bound tokens, restart what read
them, and run the HTTP part of the smoke check once more from the Mac against the public URL.
Done when every line of the smoke check gives the same answer there as it gave here, and the public URL answers.
A line that differs is a finding for the report, and a step 5 problem to fix first when it can be.

## 7. Report and hand over

Leave the local copy intact, its stack down (`docker compose down`). Two written things:

- A **note in the project** (`CLAUDE.md`, or the README where the project keeps such notes): the machine name,
  the path, the start command, the ports and URLs, what was excluded and how it is rebuilt, and what a
  `stop` + `start` loses (swap, images built by hand). Commit it.
- A **report** to the user, in the reply: what moved (code path, each volume with its size), what was left behind
  and why, the smoke check as a table — each line, its local answer, its remote answer — the public URL,
  the config that was changed for it, what stays broken or manual (the step 2 exception, private images,
  swap), and the commands to start and stop the stack there.

Done when the note is committed and the report is in front of the user.
