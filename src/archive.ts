// backup, archive and restore: /data (and /mnt/volume when there is one) in restic (ADR-0007). An archived
// machine has no VPS and no disk snapshot left: restic is its only copy, so archive deletes nothing before
// the backup has exited 0. The restic credentials reach a machine only inside the script piped to it:
// never its argv, never the environment of ssh, never an event or the log.
import { apply } from './apply.ts';
import { need, reach, setup, target, type Ctx, type Run } from './command.ts';
import { freeTailnetName } from './create.ts';
import { resticEnv, type Config } from './config.ts';
import { UserError } from './errors.ts';
import { exists } from './inventory.ts';
import { ActionFailure } from './progress/progress.ts';
import { waitReady } from './ready.ts';
import { remote } from './ssh.ts';
import { deleteSnapshot, leaveTailnet, power, writeInventory } from './stop.ts';
import { confirm } from './ui.ts';

// Archives are optional: an empty value disables them, and every command that needs one says which.
function requireRestic(c: Config): void {
  for (const [key, value] of Object.entries(c.restic)) {
    if (!value) throw new UserError(`restic.${key} is not set in ${c.file}: archives need an S3 bucket, run node-ctl init restic`);
  }
}

const ANSI: Record<string, string> = { '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v', '\x1b': '\\E', "'": "\\'", '\\': '\\\\' };

// printf %q: the word bash reads back as the same value. Printable ASCII gets a backslash before every
// character the shell would act on; anything else becomes an ANSI-C $'...' string.
// shortcut: a non-ASCII letter goes into $'...' as it is, where bash in a UTF-8 locale would only backslash-quote; both read back the same.
function shellQuote(v: string): string {
  if (v === '') return "''";
  if (/[^\x20-\x7e]/.test(v)) {
    return `$'${[...v].map((c) => ANSI[c] ?? (c < ' ' || c === '\x7f' ? `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}` : c)).join('')}'`;
  }
  return v.replace(/[ '"\\|&;()<>!{}*[?\]^$`,]/g, '\\$&').replace(/^[#~]/, '\\$&').replace(/([=:])~/g, '$1\\~');
}

const exports = (c: Config) =>
  Object.entries(resticEnv(c))
    .map(([k, v]) => `export ${k}=${shellQuote(v)}\n`)
    .join('');

// docker stops first: a database mid-write is a backup that does not restore.
const backupScript = (c: Config, name: string) => `set -euo pipefail
${exports(c)}restic cat config >/dev/null 2>&1 || restic init
systemctl stop docker.socket docker
trap 'systemctl start docker' EXIT
paths=/data; ! mountpoint -q /mnt/volume || paths="/data /mnt/volume"
restic backup $paths --tag ${name}
`;

const restoreScript = (c: Config, selector: string) => `set -euo pipefail
${exports(c)}systemctl stop docker.socket docker
trap 'systemctl start docker' EXIT
restic restore ${selector} --target /
`;

// A script piped to the machine as one step; its exit status, 0 when it succeeded.
async function remoteStep(run: Run, title: string, key: string, name: string, script: string): Promise<number> {
  let status = 0;
  await run.progress.withAction(title, key, async () => {
    status = (await remote(name, script, { progress: run.progress, env: run.env })).status;
    if (status !== 0) throw new ActionFailure('', status);
  });
  return status;
}

const snapshotData = (run: Run, name: string) => remoteStep(run, `Snapshot /data of ${name}`, 'backup', name, backupScript(run.config, name));

// The machine named, known and running, with archive storage configured.
async function runningMachine(ctx: Ctx, run: Run, command: string) {
  const args = await target(ctx, run.p.servers, command, ['running']);
  if (!(await reach(run))) return undefined;
  const name = need(command, args[0], '<name>');
  const { machine, account } = exists(run.config, run.p.servers, name);
  requireRestic(run.config);
  if (machine.state !== 'running') throw new UserError(`${name} is not running`);
  return { name, account };
}

export const backup = async (ctx: Ctx): Promise<number | void> => {
  const run = setup(ctx);
  const m = await runningMachine(ctx, run, 'backup');
  if (!m) return 1;
  return (await snapshotData(run, m.name)) || undefined;
};

export const archive = async (ctx: Ctx): Promise<number | void> => {
  const run = setup(ctx);
  const m = await runningMachine(ctx, run, 'archive');
  if (!m) return 1;
  const { name } = m;
  const snap = m.account.provider !== 'contabo'; // no disk snapshot there; the apply cancels the contract
  run.progress.plan(`Snapshot /data of ${name}`, 'Leave the tailnet', ...(snap ? ['Delete the root disk snapshot'] : []), 'Write inventory', 'Apply Terraform');
  const status = await snapshotData(run, name);
  if (status) return status; // restic holds nothing yet: the machine stays as it is
  await leaveTailnet(run, name);
  if (snap) await deleteSnapshot(run, name); // restic holds the data now; the disk snapshot would only be billed
  const wrote = await writeInventory(run, name, (e) => {
    e.state = 'archived';
    if (snap) delete e.image; // the snapshot is gone: the next create boots the base image (on Contabo it is the standard image)
  });
  if (!wrote) return 1;
  await apply(run.config, run.p, run.progress, run.env);
};

export const restore = async (ctx: Ctx): Promise<number | void> => {
  const run = setup(ctx);
  const { p, config, progress, env } = run;
  const args = await target(ctx, p.servers, 'restore', []);
  if (!(await reach(run))) return 1;
  const name = need('restore', args[0], '<name> [snapshot] [--yes]');
  let snapshot = 'latest';
  let yes = ctx.yes;
  for (const a of args.slice(1)) {
    if (a === '--yes') yes = true;
    else snapshot = a;
  }
  const { machine, account } = exists(config, p.servers, name);
  requireRestic(config);
  const start = machine.state !== 'running';
  if (!start) await confirm({ ...ctx.ui, yes }, `This overlays snapshot ${snapshot} onto /data of the running machine ${name}.`, name);
  const selector = snapshot === 'latest' ? `latest --tag ${name}` : snapshot;
  // A stopped Contabo instance is powered off, and no apply would ever start it again (ADR-0018).
  const powerOn = start && account.provider === 'contabo';
  // Any other start is a new VPS joining the tailnet, and a stale node holding the name would make it <name>-1.
  const fresh = start && (account.provider !== 'contabo' || machine.state === 'archived');
  progress.plan(...(powerOn ? ['Power on'] : []), ...(fresh ? ['Free the tailnet name'] : []), ...(start ? ['Write inventory', 'Apply Terraform'] : []), `Wait for ${name}`, `Restore /data of ${name}`);
  if (powerOn && !(await power(run, name, true))) progress.warn(`could not power ${name} on; the apply below creates it if it does not exist yet`);
  if (fresh && !(await freeTailnetName(run, name))) throw new UserError(`could not confirm ${name} is free on the tailnet; fix Tailscale API access, then retry`);
  if (start) {
    const wrote = await writeInventory(run, name, (m) => {
      // archive deleted its disk snapshot; an archive written before it forgot that still names the snapshot
      if (machine.state === 'archived' && account.provider !== 'contabo') delete m.image;
      m.state = 'running';
      m.started = Math.floor(Date.now() / 1000);
    });
    if (!wrote) return 1;
    await apply(config, p, progress, env);
  }
  if (!(await waitReady(run, name))) return 1;
  const status = await remoteStep(run, `Restore /data of ${name}`, 'restore', name, restoreScript(config, selector));
  if (status) return status;
  ctx.io.stdout.write(`restored: node-ctl ssh ${name}\n`);
};
