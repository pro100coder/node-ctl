// The commands that change one machine in place: its public ports, its Funnel, its volume, its commit
// key and host keys, and apply, which also brings every running machine's agent setup up to date.
// Each edits servers/<name>.json, then applies or reaches the machine.
import { apply as applyTerraform } from './apply.ts';
import { need, reach, setup, step, target, type Ctx } from './command.ts';
import { UserError } from './errors.ts';
import { refreshKnownHosts } from './hostkeys.ts';
import { editMachine, exists, machineNames, readMachine } from './inventory.ts';
import { ActionFailure } from './progress/progress.ts';
import { installAgentFiles, installGitKey, updateFunnel, updateTailscale, waitReady } from './ready.ts';
import { RESOURCES } from './resources.ts';
import { remote, tailnetSuffix } from './ssh.ts';
import { read, menu, type Ui } from './ui.ts';

// ports_json: 22 always, then the others, numeric and once each; anything else is no port.
export function portList(ports: string[]): number[] {
  for (const p of ports) if (!/^[0-9]+$/.test(p)) throw new UserError(`not a port: ${p}`);
  return [...new Set([22, ...ports.map(Number)])].sort((a, b) => a - b);
}

// A Hetzner Volume is an extra disk at /mnt/volume for data too big for the root disk and its snapshots;
// it follows the machine through stop and start. GB, 0 for none: asked on a terminal only.
export async function askVolumeSize(ui: Ui): Promise<string> {
  if (!ui.input.terminal) return '0';
  if (ui.drawn) {
    // a typed answer would be a size, not a line number, so only a drawn menu offers a list
    const values = ['0', '10', '20', '50', '100', '200', '500'];
    const lines = [' none', ...values.slice(1).map((v) => ` ${v} GB`)];
    const size = await menu(ui, 'Hetzner Volume at /mnt/volume', { values, lines, any: 'another size: type it in GB' });
    if (size === undefined) throw new UserError('aborted');
    return size || '0';
  }
  return (await read(ui, 'Add a Hetzner Volume at /mnt/volume? Size in GB, empty for none: ')).text || '0';
}

const running = (servers: string, name: string) => readMachine(servers, name).state === 'running';

export const ports = async (ctx: Ctx): Promise<void> => {
  const { p, config, progress, env } = setup(ctx);
  const [name, ...list] = await target(ctx, p.servers, 'ports', []);
  need('ports', name, '<name> [port ...]');
  const { machine } = exists(config, p.servers, name!);
  // a bare call shows; closing everything is: node-ctl ports <name> 22
  if (!list.length) return void ctx.io.stdout.write((machine.open_ports ?? []).map((n) => `${n}\n`).join(''));
  const open = portList(list);
  progress.plan('Write inventory', 'Apply Terraform');
  await progress.withAction('Write inventory', 'inventory', () => editMachine(p.servers, name!, (m) => (m.open_ports = open)));
  await applyTerraform(config, p, progress, env);
};

// Tailscale Funnel publishes a port of the machine on the internet as https://<name>.<tailnet>.ts.net<path>.
export const expose = async (ctx: Ctx): Promise<number | void> => {
  const run = setup(ctx);
  const { p, config, progress, env } = run;
  const args = await target(ctx, p.servers, 'expose', []);
  if (!(await reach(run))) return 1;
  const [name, ...rest] = args;
  need('expose', name, '<name> [<port> [/path] | --rm </path>]');
  const funnel = exists(config, p.servers, name!).machine.funnel ?? {};
  if (!rest.length) return void ctx.io.stdout.write(Object.entries(funnel).map(([k, v]) => `${k} ${v}\n`).join(''));
  let path = '/';
  let port: number | undefined;
  if (rest[0] === '--rm') {
    path = need('expose', rest[1], '<name> --rm </path>');
    if (funnel[path] == null) throw new UserError(`nothing is published at ${path} on ${name}`);
  } else {
    if (!/^[0-9]+$/.test(rest[0]!)) throw new UserError('usage: node-ctl expose <name> <port> [/path]');
    port = Number(rest[0]);
    if (rest.length > 1) path = rest[1]!;
    if (!path.startsWith('/')) throw new UserError(`the path must start with /: ${path}`);
  }
  progress.plan('Write inventory', 'Configure Tailscale Funnel');
  await progress.withAction('Write inventory', 'inventory', () =>
    editMachine(p.servers, name!, (m) => {
      const f = { ...(m.funnel ?? {}) };
      if (port === undefined) delete f[path];
      else f[path] = port;
      m.funnel = f;
    }),
  );
  if (!running(p.servers, name!)) return progress.info(`${name} is not running: Funnel is configured at the next start`);
  if (!(await updateFunnel(run, name!))) return 1;
  if (port !== undefined) ctx.io.stdout.write(`https://${name}.${await tailnetSuffix(env)}${path} -> ${port}\n`);
};

export const volume = async (ctx: Ctx): Promise<number | void> => {
  const run = setup(ctx);
  const { p, config, progress, env } = run;
  const args = await target(ctx, p.servers, 'volume', ['running', 'stopped']);
  if (!(await reach(run))) return 1;
  const name = need('volume', args[0], '<name> <size GB>');
  let size = args[1] ?? '';
  if (!size && ctx.ui.input.terminal) {
    size = await askVolumeSize(ctx.ui);
    if (size === '0') throw new UserError('aborted');
  }
  need('volume', size, '<name> <size GB>');
  const { machine, account } = exists(config, p.servers, name);
  if (account.provider === 'contabo') throw new UserError('volumes are Hetzner-only: Contabo has no block storage to attach (ADR-0018)');
  if (!/^[1-9][0-9]*$/.test(size)) throw new UserError(`not a volume size in GB: ${size}`);
  if (machine.volume_size) throw new UserError(`${name} already has a volume (README: Growing a volume)`);
  const up = machine.state === 'running';
  progress.plan('Write inventory', 'Apply Terraform', ...(up ? ['Mount the volume'] : []));
  await progress.withAction('Write inventory', 'inventory', () => editMachine(p.servers, name, (m) => (m.volume_size = Number(size))));
  await applyTerraform(config, p, progress, env);
  // a stopped machine mounts it at the next start (provision.sh)
  if (up && !(await step(progress, 'Mount the volume', 'volume', () => remote(name, RESOURCES['scripts/mount-volume.sh']!, { progress, env })))) return 1;
  ctx.io.stdout.write(`${name}: ${size}G at /mnt/volume\n`);
};

// A machine created before the key existed, or before a rotation, gets the current one.
export const gitkey = async (ctx: Ctx): Promise<number | void> => {
  const run = setup(ctx);
  const args = await target(ctx, run.p.servers, 'gitkey', ['running']);
  if (!(await reach(run))) return 1;
  const name = need('gitkey', args[0], '<name>');
  exists(run.config, run.p.servers, name);
  if (!(await Bun.file(run.p.gitKey).exists())) throw new UserError(`no ${run.p.gitKey}: node-ctl init gitkey`);
  if (!running(run.p.servers, name)) throw new UserError(`${name} is not running`);
  if (!(await installGitKey(run, name))) return 1;
};

// A machine rebuilt behind the CLI's back, or a store that was stale before the CLI knew about it.
export const hostkeys = async (ctx: Ctx): Promise<number | void> => {
  const run = setup(ctx);
  const args = await target(ctx, run.p.servers, 'hostkeys', ['running']);
  if (!(await reach(run))) return 1;
  const name = need('hostkeys', args[0], '<name>');
  exists(run.config, run.p.servers, name);
  if (!running(run.p.servers, name)) throw new UserError(`${name} is not running`);
  const ok = await run.progress.withAction('Refresh the host keys', 'hostkeys', async () => {
    if (!(await refreshKnownHosts(run, name))) throw new ActionFailure('', 1);
  });
  if (!ok) throw new UserError(`nothing answered under any name of ${name}; its stale keys are gone, the new ones are not in yet`);
  ctx.io.stdout.write(`host keys of ${name} recorded\n`);
};

// The inventory applied, then every running machine's agent setup brought up to date. A named machine
// may be a start cut short (its VPS created only now): it gets everything a start gives it.
export const apply = async (ctx: Ctx): Promise<number | void> => {
  const run = setup(ctx);
  const { p, config, progress, env } = run;
  for (const name of ctx.args) {
    exists(config, p.servers, name);
    if (!running(p.servers, name)) throw new UserError(`${name} is not running`);
  }
  const names = ctx.args.length ? ctx.args : machineNames(p.servers).filter((n) => running(p.servers, n));
  await applyTerraform(config, p, progress, env);
  if (names.length && !(await reach(run))) return 1; // applied by now: no tailnet only stops the sync
  if (ctx.args.length) {
    for (const name of names) if (!(await waitReady(run, name))) return 1;
  } else {
    for (const name of names) if (!(await installAgentFiles(run, name))) progress.warn(`could not sync the agent setup to ${name}`);
  }
  // last: the restart it may bring could cut a step that comes after it
  for (const name of names) if (!(await updateTailscale(run, name))) progress.warn(`could not update Tailscale on ${name}`);
};
