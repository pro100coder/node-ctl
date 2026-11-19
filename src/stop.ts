// stop, start and destroy: the commands where a machine's only copy is at stake. On Hetzner stop keeps the
// root disk (/data included) as a snapshot in .image and deletes the VPS; start boots the next VPS from it
// and keeps it, so a machine that has a snapshot is never without one. On Contabo an instance is a monthly
// contract: stop and start are power actions and the disk stays where it is (ADR-0018).
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { apply } from './apply.ts';
import { canSchedule, scheduleStop, tillAt } from './autostop.ts';
import { catoAfterStart } from './cato.ts';
import { call, need, reach, setup, target, type Ctx, type Run } from './command.ts';
import * as contabo from './contabo.ts';
import { freeTailnetName } from './create.ts';
import { UserError } from './errors.ts';
import { createImage, pruneImages } from './hetzner.ts';
import { editMachine, exists, machineNames, readMachine } from './inventory.ts';
import { ActionFailure } from './progress/progress.ts';
import { actionRun } from './proc.ts';
import { waitReady } from './ready.ts';
import { chooseType } from './resize.ts';
import { addr, tssh } from './ssh.ts';
import * as tailscale from './tailscale.ts';
import { confirm } from './ui.ts';

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));
const tagOf = (run: Run, name: string) => readMachine(run.p.servers, name).account ?? '';
const token = (run: Run, name: string) => run.config.hetzner[tagOf(run, name)] ?? '';
const onContabo = (run: Run, name: string) => exists(run.config, run.p.servers, name).account.provider === 'contabo';

// An inventory write as a step of its own: a full disk or a broken entry fails it with the reason.
export function writeInventory(run: Run, name: string, change: Parameters<typeof editMachine>[2]): Promise<boolean> {
  return run.progress.withAction('Write inventory', 'inventory', () => {
    try {
      editMachine(run.p.servers, name, change);
    } catch (e) {
      throw new ActionFailure(text(e));
    }
  });
}

// ts_logout: free the hostname in the tailnet before the VPS goes away; never fails, it warns.
export function leaveTailnet(run: Run, name: string): Promise<boolean> {
  const { progress, env } = run;
  return progress.withAction('Leave the tailnet', 'logout', async () => {
    // The session itself rides the tailnet: a logout run inline kills the tunnel under ssh, which then
    // waits out the TCP timeout (~30 min on macOS). A 2 s transient timer lets ssh disconnect first.
    const at = `node-ctl-user@${await addr(name, env)}`;
    const r = await actionRun(progress, tssh('-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', at, 'sudo', 'systemd-run', '--quiet', '--on-active=2', 'tailscale', 'logout'), { env });
    if (r.status === 0) return;
    progress.warn(`could not log ${name} out of Tailscale; deleting its node through the API`);
    if (!(await call(progress, `tailscale-rm.sh ${name}`, 'api', () => tailscale.removeNode(env, run.config.tailscale, name)))) {
      progress.warn(`could not delete the node either; remove ${name} in the admin console`);
    }
  });
}

// prune_images: nothing of a destroyed or archived machine stays billed.
export async function deleteSnapshot(run: Run, name: string): Promise<void> {
  const { progress, env } = run;
  const deleted = await call(progress, 'Delete the root disk snapshot', 'image', () => pruneImages(env, token(run, name), name, '', (l) => progress.log(l, 'stdout')));
  if (!deleted) progress.warn(`could not delete the snapshot of ${name}; delete it in the Hetzner console`);
}

export function power(run: Run, name: string, on: boolean): Promise<boolean> {
  return call(run.progress, on ? 'Power on' : 'Power off', 'power', () => contabo.power(run.env, run.config.contabo[tagOf(run, name)]!, name, on));
}

// keep_image: the server off, its disk snapshotted, the image written to the inventory, and only then the
// previous one deleted. A crash anywhere leaves the inventory naming a snapshot that exists.
function snapshotDisk(run: Run, name: string): Promise<boolean> {
  const { progress, env, p } = run;
  return progress.withAction('Snapshot the root disk', 'image', async () => {
    const t = token(run, name);
    let id: string;
    try {
      id = await createImage(env, t, name, (l) => progress.log(l, 'stderr'));
    } catch (e) {
      progress.log(text(e), 'stderr');
      throw new ActionFailure(`could not snapshot the root disk of ${name}`);
    }
    try {
      editMachine(p.servers, name, (m) => (m.image = id));
    } catch (e) {
      throw new ActionFailure(text(e));
    }
    progress.log(`root disk kept as image ${id}`);
    try {
      await pruneImages(env, t, name, id, (l) => progress.log(l, 'stdout'));
    } catch (e) {
      progress.log(text(e), 'stderr');
      progress.warn(`could not delete the previous snapshot of ${name}; delete it in the Hetzner console`);
    }
  });
}

// One machine, everything but the terraform apply the whole run shares. A machine whose disk could not be
// kept stays in the inventory as it is: powered off, its volume and disk untouched, and the same command
// tries again from there.
async function stopSteps(run: Run, name: string): Promise<boolean> {
  // Its node leaves the tailnet first and the snapshot takes minutes: list would call it starting all
  // that time. This process is the mark, so a stop that dies leaves nothing list believes.
  try {
    editMachine(run.p.servers, name, (m) => (m.stopping = process.pid));
  } catch (e) {
    run.progress.warn(text(e));
    return false;
  }
  if (onContabo(run, name)) {
    // The instance stays (and stays billed): powered off, its node keeps its place in the tailnet and
    // comes back with it. Nothing to log out of and nothing to snapshot (ADR-0018).
    if (!(await power(run, name, false))) return false;
  } else {
    await leaveTailnet(run, name); // while ssh still works: the snapshot then holds a tailscaled with no node
    if (!(await snapshotDisk(run, name))) return false;
  }
  // The mark stays until the apply has deleted the VPS (apply drops it): a stop cut short there is still
  // unfinished, so stop and its autostop job run again instead of leaving a billed server behind.
  return writeInventory(run, name, (m) => (m.state = 'stopped'));
}

const stopPlan = (run: Run, name: string, ...then: string[]) =>
  onContabo(run, name) ? run.progress.plan('Power off', 'Write inventory', ...then) : run.progress.plan('Leave the tailnet', 'Snapshot the root disk', 'Write inventory', ...then);

// Why that machine is still running, in its provider's words.
const stopFailed = (run: Run, name: string) =>
  onContabo(run, name)
    ? `could not power ${name} off; retry: ./node-ctl stop ${name}`
    : `could not snapshot the root disk of ${name}; it is powered off and nothing is lost, retry: ./node-ctl stop ${name}`;

// --all stops every running machine; no name at all is a question (or a usage error), never all of them.
export const stop = async (ctx: Ctx): Promise<number | void> => {
  const run = setup(ctx);
  const { p, config, progress, env } = run;
  // The scheduled stop (autostop.ts): a machine stopped by hand or destroyed since then is done with,
  // not a failure the job would retry every minute.
  const due = env.NODE_CTL_SCHEDULED && ctx.args.length === 1 ? ctx.args[0]! : undefined;
  if (due !== undefined) {
    const m = machineNames(p.servers).includes(due) ? readMachine(p.servers, due) : undefined;
    if (m?.state !== 'running' && m?.stopping == null) {
      ctx.io.stdout.write(`${due} is not running; nothing to stop\n`);
      return;
    }
  }
  const args = await target(ctx, p.servers, 'stop', ['running'], ctx.args.length ? undefined : 'every running machine');
  if (!(await reach(run))) return 1;
  const names: string[] = [];
  if (args[0] === '--all') {
    if (args.length !== 1) throw new UserError('--all takes no names');
    for (const name of machineNames(p.servers)) {
      if (readMachine(p.servers, name).state !== 'running') continue;
      exists(config, p.servers, name);
      names.push(name);
    }
    if (!names.length) throw new UserError('no running machine to stop');
  } else {
    need('stop', args[0], '<name ...> | --all');
    for (const name of args) {
      const m = exists(config, p.servers, name).machine;
      // a stop cut short in its apply is stopped and still marked: it only needs the apply
      if (m.state !== 'running' && !(m.state === 'stopped' && m.stopping != null)) throw new UserError(`${name} is not running`);
      if (m.state !== 'stopped') names.push(name);
    }
  }
  const failed: string[] = [];
  if (!names.length) progress.plan('Apply Terraform');
  else if (names.length === 1) {
    stopPlan(run, names[0]!, 'Apply Terraform');
    if (!(await stopSteps(run, names[0]!))) throw new UserError(stopFailed(run, names[0]!));
  } else {
    progress.plan(...names.map((n) => `Stop ${n}`), 'Apply Terraform');
    // One machine that cannot be snapshotted does not keep the others running: it stays in the inventory
    // as running, so the apply below leaves its VPS alone. One after the other, as the steps nest.
    for (const name of names) {
      const ok = await progress.withAction(`Stop ${name}`, 'machine', async () => {
        stopPlan(run, name);
        if (!(await stopSteps(run, name))) throw new ActionFailure(stopFailed(run, name));
      });
      if (!ok) failed.push(name);
    }
  }
  await apply(config, p, progress, env);
  if (failed.length) {
    const list = failed.join(' ');
    throw new UserError(`could not stop: ${list}; they are still in the inventory as running and nothing is lost, retry: ./node-ctl stop ${list}`);
  }
};

// Everything of one start up to the apply, its own steps planned in front of then; undefined when done,
// otherwise why not ('' when the failed step said it).
async function startSteps(run: Run, name: string, type: string, till: number | undefined, ...then: string[]): Promise<string | undefined> {
  const { progress } = run;
  const steps = ['Write inventory', ...(till === undefined ? [] : ['Schedule the stop'])];
  if (onContabo(run, name)) {
    // Its instance was only powered off, so it still holds its tailnet node and its name with it. A
    // machine that was never applied is powered on by nobody: the API has nothing to find, which is why
    // this is a warning and the apply below creates it.
    progress.plan('Power on', ...steps, ...then);
    if (!(await power(run, name, true))) progress.warn(`could not power ${name} on; the apply below creates it if it does not exist yet`);
  } else {
    progress.plan('Free the tailnet name', ...steps, ...then);
    if (!(await freeTailnetName(run, name))) return `could not confirm ${name} is free on the tailnet; fix Tailscale API access, then retry`;
  }
  const wrote = await writeInventory(run, name, (m) => {
    m.state = 'running';
    m.started = Math.floor(Date.now() / 1000);
    if (type) m.type = type;
  });
  if (!wrote || !(await scheduleStop(run, name, till))) return '';
  return undefined;
}

const usage = '<name ...> [--type [type]] [--till time] | --all';

export const start = async (ctx: Ctx): Promise<number | void> => {
  const run = setup(ctx);
  const { p, config, progress, env } = run;
  const args = await target(ctx, p.servers, 'start', ['stopped'], ctx.args.length ? undefined : 'every stopped machine');
  if (!(await reach(run))) return 1;
  const names: string[] = [];
  let all = false;
  let retype = false;
  let type = '';
  let till: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--type=')) [retype, type] = [true, a.slice('--type='.length)];
    else if (a === '--type') {
      retype = true; // a bare --type asks
      const v = args[i + 1];
      if (v && !v.startsWith('-')) [type, i] = [v, i + 1];
    } else if (a.startsWith('--till=')) till = tillAt(a.slice('--till='.length));
    else if (a === '--till') till = tillAt(args[++i] ?? '');
    else if (a === '--all') all = true;
    else if (a.startsWith('-')) throw new UserError(`unknown option: ${a}`);
    else names.push(a);
  }
  if (till !== undefined) await canSchedule(env);
  if (all) {
    if (names.length) throw new UserError('--all takes no names');
    names.push(...machineNames(p.servers).filter((n) => readMachine(p.servers, n).state === 'stopped'));
    if (!names.length) throw new UserError('no stopped machine to start');
  }
  need('start', names[0], usage);
  if (names.length > 1) {
    if (retype) throw new UserError('--type takes one machine');
    return startMany(ctx, run, names, till);
  }
  const name = names[0]!;
  const { machine, account } = exists(config, p.servers, name);
  if (machine.state === 'running') throw new UserError(`${name} is already running; if its start was cut short: ./node-ctl apply ${name}`);
  if (machine.state === 'archived') throw new UserError(`${name} is archived; use: ./node-ctl restore ${name}`);
  // There is no server to resize while a machine is stopped, only the snapshot of its disk: the type it
  // boots into is free to change here, as long as that type is sold in its location right now and its
  // disk holds the snapshot. Validated before the first action, not inside one.
  if (retype) {
    if (account.provider === 'contabo') throw new UserError('--type is Hetzner-only: a Contabo upgrade changes the contract, not the machine (ADR-0018)');
    const choice = await chooseType(run, ctx.ui, name, 'start', type);
    if (choice.type === choice.current) retype = false; // nothing to change: it starts as what it already is
    else progress.info(`${name} starts as ${choice.type} instead of ${choice.current}`);
    type = choice.type;
  }
  const failure = await startSteps(run, name, retype ? type : '', till, 'Apply Terraform', `Wait for ${name}`);
  if (failure !== undefined) throw new UserError(failure);
  await apply(config, p, progress, env, `./node-ctl apply ${name}`); // it finishes the start: wait_ready included
  if (!(await waitReady(run, name))) return 1;
  await catoAfterStart(run, name);
  ctx.io.stdout.write(`ready: ./node-ctl ssh ${name}\n`);
};

// One apply for all of them; one that cannot be prepared stays stopped.
async function startMany(ctx: Ctx, run: Run, names: string[], till: number | undefined): Promise<void> {
  const { p, config, progress, env } = run;
  for (const name of names) {
    const { state } = exists(config, p.servers, name).machine; // before the first action
    if (state === 'archived') throw new UserError(`${name} is archived; use: ./node-ctl restore ${name}`);
    if (state !== 'stopped') throw new UserError(`${name} is already running; if its start was cut short: ./node-ctl apply ${name}`);
  }
  progress.plan(...names.map((n) => `Start ${n}`), 'Apply Terraform', ...names.map((n) => `Wait for ${n}`));
  const started: string[] = [];
  const failed: string[] = [];
  for (const name of names) {
    const ok = await progress.withAction(`Start ${name}`, 'machine', async () => {
      const failure = await startSteps(run, name, '', till);
      if (failure !== undefined) throw new ActionFailure(failure);
    });
    (ok ? started : failed).push(name);
  }
  const why = () => `could not start: ${failed.join(' ')}; they are still stopped, retry: ./node-ctl start ${failed.join(' ')}`;
  if (!started.length) throw new UserError(why());
  await apply(config, p, progress, env, `./node-ctl apply ${started.join(' ')}`);
  for (const name of started) {
    if (!(await waitReady(run, name))) continue;
    await catoAfterStart(run, name);
    ctx.io.stdout.write(`ready: ./node-ctl ssh ${name}\n`);
  }
  if (failed.length) throw new UserError(why());
}

export const destroy = async (ctx: Ctx): Promise<number | void> => {
  const run = setup(ctx);
  const { p, config, progress, env } = run;
  const args = await target(ctx, p.servers, 'destroy', []);
  if (!(await reach(run))) return 1;
  const name = need('destroy', args[0], '<name> [--yes]');
  const { machine, account } = exists(config, p.servers, name);
  // Contabo keeps no snapshot, and deleting an instance there cancels a monthly contract (ADR-0018).
  const snap = account.provider !== 'contabo';
  let what = snap ? 'its disk and snapshot' : 'its disk; the Contabo contract is cancelled and billed to the end of the paid period';
  if (machine.volume_size) what += ' AND its volume';
  await confirm({ ...ctx.ui, yes: ctx.yes || args[1] === '--yes' }, `This deletes ${name}, ${what}.`, name);
  const up = machine.state === 'running';
  progress.plan(...(up ? ['Leave the tailnet'] : []), ...(snap ? ['Delete the root disk snapshot'] : []), 'Write inventory', 'Apply Terraform');
  if (up) await leaveTailnet(run, name);
  if (snap) await deleteSnapshot(run, name);
  const removed = await progress.withAction('Write inventory', 'inventory', () => {
    try {
      rmSync(join(p.servers, `${name}.json`));
    } catch (e) {
      throw new ActionFailure(text(e));
    }
  });
  if (!removed) return 1;
  await apply(config, p, progress, env);
};
