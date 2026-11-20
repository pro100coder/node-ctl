// list and accounts: the inventory as a table or as JSON, in the shape the bash jq programs printed,
// byte for byte (scripts and the migration check compare list --json).
import { stopTimes } from './autostop.ts';
import type { Handler } from './cli.ts';
import { accounts, loadConfig, type Config } from './config.ts';
import { UserError } from './errors.ts';
import { machineNames, readMachine, toJson } from './inventory.ts';
import { paths } from './paths.ts';
import type { Progress } from './progress/progress.ts';
import { spawn } from './proc.ts';
import { tailscaleCli } from './ssh.ts';
import { tfAccount } from './terraform.ts';

type Env = Record<string, string | undefined>;
type Addrs = Record<string, { ipv4?: unknown; ipv6?: unknown }>;

// The JQ_TABLE of the bash CLI: columns as wide as their widest cell, two spaces apart, the last one
// unpadded; the header bold and a rule under it, dimmed. Widths count code points, as jq's length.
export function table(rows: string[][], color: boolean): string {
  const [b, d, n] = color ? ['\x1b[1m', '\x1b[2m', '\x1b[0m'] : ['', '', ''];
  const len = (s: string) => [...s].length;
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => len(r[i] ?? ''))));
  const cells = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat(widths[i]! - len(c)))).join('  ');
  const width = widths.reduce((a, w) => a + w, 0) + 2 * (widths.length - 1);
  return [`${b}${cells(rows[0]!)}${n}`, `${d}${'─'.repeat(width)}${n}`, ...rows.slice(1).map(cells)].map((l) => `${l}\n`).join('');
}

// tf_machines: the addresses Terraform knows, every account merged. No state yet (or no terraform init):
// that account adds nothing.
async function addresses(config: Config, home: string, progress: Progress, env: Env): Promise<Addrs> {
  const all: Addrs = {};
  for (const tag of accounts(config)) {
    const r = await tfAccount({ config, home, progress, capture: true, env }, tag, ['output', '-json']);
    try {
      Object.assign(all, (JSON.parse(r.stdout) as { machines?: { value?: Addrs } }).machines?.value ?? {});
    } catch {}
  }
  return all;
}

// The tailnet's view, one call: tailscale up is the last step of provision.sh, so a running machine
// online there is ready, and one that is not is still starting. undefined without the CLI.
async function peers(env: Env): Promise<Record<string, { name: string; online: boolean }> | undefined> {
  const cli = tailscaleCli(env);
  if (!cli) return undefined;
  const seen: Record<string, { name: string; online: boolean }> = {};
  try {
    const status = JSON.parse((await spawn([cli, 'status', '--json'], { env })).stdout) as { Peer?: Record<string, { DNSName?: string; Online?: boolean }> };
    for (const p of Object.values(status.Peer ?? {})) {
      const name = (p.DNSName ?? '').replace(/\.$/, '');
      seen[name.split('.')[0]!] = { name, online: p.Online ?? false };
    }
  } catch {} // a stopped tailnet says nothing about the machines
  return seen;
}

// A stop's mark counts while its node-ctl still runs.
async function stillStopping(pid: unknown, env: Env): Promise<boolean> {
  return (await spawn(['ps', '-p', String(pid), '-o', 'command='], { env })).stdout.includes('node-ctl');
}

const two = (n: number) => String(n).padStart(2, '0');
function uptime(s: number): string {
  if (s >= 86400) return `${Math.floor(s / 86400)}d${two(Math.floor((s % 86400) / 3600))}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h${two(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 60)}m`;
}

// strflocaltime("%Y-%m-%d %H:%M")
function localTime(epoch: number): string {
  const t = new Date(epoch * 1000);
  return `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())} ${two(t.getHours())}:${two(t.getMinutes())}`;
}

export const list: Handler = async ({ args, progress, io }) => {
  const p = paths(io.env);
  const config = loadConfig(p.config, io.env);
  const json = args[0] === '--json';
  const names = machineNames(p.servers);
  if (!names.length) {
    io.stdout.write(json ? '[]\n' : 'no machines\n');
    return;
  }
  const machines = names.map((name) => ({ name, m: readMachine(p.servers, name) }));
  const tf = await addresses(config, p.home, progress, io.env);
  const ts = await peers(io.env);
  const stops = await stopTimes({ p, env: io.env });
  const stopping = new Set<string>();
  for (const { name, m } of machines) if (m.state === 'running' && m.stopping != null && (await stillStopping(m.stopping, io.env))) stopping.add(name);

  const rows = machines.map(({ name, m }) => {
    const running = m.state === 'running';
    const online = ts?.[name]?.online ?? false;
    let state = m.state ?? null;
    if (running) state = stopping.has(name) ? 'stopping' : !ts ? m.state! : online ? 'ready' : 'starting';
    return {
      name,
      account: m.account ?? null,
      state,
      ipv4: tf[name]?.ipv4 ?? null,
      ipv6: tf[name]?.ipv6 ?? null,
      open_ports: m.open_ports ?? null,
      funnel: m.funnel ?? {},
      started: running ? (m.started ?? null) : null,
      stops_at: running ? (stops[name] ?? null) : null,
      tailscale: running && online ? ts![name]!.name : null,
    };
  });
  if (json) {
    io.stdout.write(toJson(rows));
    return;
  }
  const now = Date.now() / 1000;
  const dash = (s: string) => s || '-';
  io.stdout.write(
    table(
      [
        ['NAME', 'ACCOUNT', 'STATE', 'UPTIME', 'AUTOSTOP', 'IPV4', 'TAILSCALE', 'PORTS', 'FUNNEL'],
        ...rows.map((r) => [
          r.name,
          r.account ?? '-',
          r.state ?? '',
          r.started !== null ? uptime(Math.floor(now - r.started)) : '-', // jq: 0 is true
          r.stops_at !== null ? localTime(r.stops_at) : '-',
          String(r.ipv4 ?? '-'),
          r.tailscale ?? '-',
          dash((r.open_ports ?? []).join(',')),
          dash(Object.entries(r.funnel).map(([path, port]) => `${r.tailscale ? `https://${r.tailscale}` : ''}${path} -> ${port}`).join(', ')),
        ]),
      ],
      io.color ?? false,
    ),
  );
};

const USAGE = 'usage: node-ctl accounts [--json] | accounts add|edit [hetzner|contabo]';

// The listing; add and edit are the init step of one cloud (init.ts).
export function listAccounts(args: string[], config: Config, servers: string, out: { write(s: string): unknown }, color: boolean): void {
  if (args[0] !== undefined && args[0] !== '--json') throw new UserError(USAGE);
  const json = args[0] === '--json';
  const counts: Record<string, number> = {};
  for (const name of machineNames(servers)) {
    const tag = readMachine(servers, name).account ?? '';
    counts[tag] = (counts[tag] ?? 0) + 1;
  }
  const rows = [
    ...Object.keys(config.hetzner).sort().map((tag) => ({ provider: 'hetzner', tag, machines: counts[tag] ?? 0 })),
    ...Object.keys(config.contabo).sort().map((tag) => ({ provider: 'contabo', tag, machines: counts[tag] ?? 0 })),
  ];
  if (!rows.length) out.write(json ? '[]\n' : `no cloud account in ${config.file}: node-ctl accounts add\n`);
  else if (json) out.write(toJson(rows));
  else out.write(table([['CLOUD', 'ACCOUNT', 'MACHINES'], ...rows.map((r) => [r.provider, r.tag, String(r.machines)])], color));
}
