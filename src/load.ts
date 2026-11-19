// ssh and load: the two commands that hand a machine's output straight to this terminal.
import type { Handler } from './cli.ts';
import { loadConfig } from './config.ts';
import { UserError } from './errors.ts';
import { sleep } from './http.ts';
import { exists, machineNames, readMachine } from './inventory.ts';
import { paths } from './paths.ts';
import { spawn } from './proc.ts';
import { addr, ensureKey, ensureTailscale, tssh } from './ssh.ts';
import { pickMachine, targeted } from './target.ts';
import report from '../scripts/load.sh' with { type: 'text' };

type Ctx = Parameters<Handler>[0];

function setup({ io }: Ctx) {
  const p = paths(io.env);
  return { p, config: loadConfig(p.config, io.env) };
}

// What every command that reaches a machine does first: the key in the agent, the tailnet on. False
// when ssh-add could not load the key (it said why on the terminal).
async function reachable(ctx: Ctx, publicKey: string): Promise<boolean> {
  if (!(await ensureKey(ctx.progress, publicKey, ctx.io.env))) return false;
  await ensureTailscale(ctx.io.env);
  return true;
}

export const ssh: Handler = async (ctx) => {
  const { p, config } = setup(ctx);
  let args = ctx.args;
  if (ctx.ui.input.terminal && !targeted(args)) args = [await pickMachine(ctx.ui, p.servers, 'ssh', ['running']), ...args];
  if (!(await reachable(ctx, config.sshPublicKeyFile))) return 1;
  const [name, ...rest] = args;
  if (!name) throw new UserError('usage: ./node-ctl ssh <name> [cmd ...]');
  const argv = tssh(`node-ctl-user@${await addr(name, ctx.io.env)}`, ...rest);
  return (await spawn(argv, { env: ctx.io.env, stdin: 'inherit', inherit: true })).status;
};

type OnLine = (line: string, stream: 'stdout' | 'stderr') => void;

// The metrics script on the machine; it loops there in plain and tty mode, one ssh for the whole stream.
async function sample(ctx: Ctx, name: string, mode: string, color: string, layout: string, onLine: OnLine): Promise<number> {
  const argv = tssh('-o', 'BatchMode=yes', `node-ctl-user@${await addr(name, ctx.io.env)}`, 'bash', '-s', '--', mode, color, layout);
  return (await spawn(argv, { env: ctx.io.env, stdin: report, onLine })).status;
}

// Every running machine as one row, one ssh stream each, all at once: a slow or unreachable machine
// holds up nobody. Each stream keeps its machine's latest row; the table is redrawn from them every second.
async function sampleAll(ctx: Ctx, servers: string, mode: string, color: string): Promise<void> {
  const names = machineNames(servers).filter((n) => readMachine(servers, n).state === 'running');
  if (!names.length) throw new UserError('no running machine');
  const w = Math.max(4, ...names.map((n) => n.length));
  const latest = new Map<string, string>();
  const streams = names.map((name) =>
    sample(ctx, name, mode === 'once' ? 'once' : 'plain', color, 'row', (line, stream) => {
      if (stream === 'stdout') latest.set(name, line);
    }).then((status) => {
      if (status !== 0) latest.set(name, 'unreachable');
    }),
  );
  let done = false;
  const all = Promise.all(streams).then(() => (done = true));
  const [B, D, N] = ctx.io.color ? ['\x1b[1m', '\x1b[2m', '\x1b[0m'] : ['', '', ''];
  const el = ctx.io.terminal ? '\x1b[K' : ''; // a shorter row erases the rest of the old one
  const cols = (...c: [string, number][]) => c.map(([s, n]) => s.padEnd(n)).join('  ');
  const rows = () => {
    const out = [`${B}${cols(['NAME', w], ['CPU', 15], ['RAM', 15], ['LOAD', 16], ['DISK', 15], ['ROOT', 15])}  FREE${N}`, `${D}${'─'.repeat(w + 94)}${N}`];
    for (const name of names) out.push(`${name.padEnd(w)}  ${latest.get(name) ?? '-'}${el}`);
    ctx.io.stdout.write(`${out.join('\n')}\n`);
  };
  if (mode === 'once') {
    await all;
    rows();
    return;
  }
  rows();
  while (!done) {
    await Promise.race([sleep(1000, ctx.io.env), all]);
    ctx.io.stdout.write(mode === 'tty' ? `\x1b[${names.length + 2}A` : '\n');
    rows();
  }
}

export const load: Handler = async (ctx) => {
  const { p, config } = setup(ctx);
  let name = '';
  let mode = 'once';
  for (const a of ctx.args) {
    if (a === '-f' || a === '--follow') mode = ctx.io.terminal ? 'tty' : 'plain'; // a pipe gets plain lines, a terminal a redraw
    else if (a.startsWith('-')) throw new UserError('usage: ./node-ctl load [-f] [name]');
    else name = a;
  }
  if (!(await reachable(ctx, config.sshPublicKeyFile))) return 1;
  const color = ctx.io.color ? 'color' : 'mono'; // colours are decided here, the machine only gets the word
  if (!name) return sampleAll(ctx, p.servers, mode, color);
  exists(config, p.servers, name);
  return sample(ctx, name, mode, color, 'block', (line, stream) => (stream === 'stdout' ? ctx.io.stdout : ctx.io.stderr).write(`${line}\n`));
};
