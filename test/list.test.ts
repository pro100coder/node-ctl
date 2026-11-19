import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { table } from '../src/list.ts';
import { fakeBins, Sink } from './helpers.ts';

// A home with an inventory, a terraform that knows some addresses, and a tailnet with some peers.
function home(opts: { peers?: string; tf?: string; noTailscale?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'node-ctl-list-'));
  mkdirSync(join(dir, 'servers'));
  mkdirSync(join(dir, 'agents'));
  writeFileSync(join(dir, 'node-ctl.yaml'), 'hetzner: {main: t}\ncontabo: {cb: {client_id: a, client_secret: b, user: c, password: d}}\n');
  const bins: Record<string, string> = {
    terraform: `case "$TF_WORKSPACE" in main) echo '${opts.tf ?? '{"machines":{"value":{"dev1":{"ipv4":"1.2.3.4","ipv6":"2a01::1"}}}}'}' ;; cb) echo 'not json' ;; esac`,
    ps: 'echo "/usr/local/bin/node-ctl stop dev3"',
  };
  if (!opts.noTailscale) bins.tailscale = `echo '{"Peer":{${opts.peers ?? ''}}}'`;
  const { PATH } = fakeBins(bins);
  const put = (name: string, m: object) => writeFileSync(join(dir, 'servers', `${name}.json`), JSON.stringify(m));
  const run = async (args: string[], color = false) => {
    const stdout = new Sink();
    const env = { HOME: dir, NODE_CTL_HOME: dir, LAUNCH_AGENTS: join(dir, 'agents'), PATH };
    const code = await main(args, { stdout, stderr: new Sink(), env, terminal: false, color });
    return { code, out: stdout.text };
  };
  return { dir, put, run };
}

const peer = (name: string, online: boolean) => `"n${name}":{"DNSName":"${name}.tail.ts.net.","Online":${online}}`;

test('list --json is the bash jq shape, field for field and in that order, two spaces indented', async () => {
  const h = home({ peers: peer('dev1', true) });
  h.put('dev1', { state: 'running', account: 'main', open_ports: [22, 80], funnel: { '/': 80 }, started: 1700000000, extra: 1 });
  h.put('dev2', { state: 'stopped', account: 'main', open_ports: [22], started: 1600000000 });
  const r = await h.run(['list', '--json']);
  expect(r.code).toBe(0);
  expect(r.out).toBe(`[
  {
    "name": "dev1",
    "account": "main",
    "state": "ready",
    "ipv4": "1.2.3.4",
    "ipv6": "2a01::1",
    "open_ports": [
      22,
      80
    ],
    "funnel": {
      "/": 80
    },
    "started": 1700000000,
    "stops_at": null,
    "tailscale": "dev1.tail.ts.net"
  },
  {
    "name": "dev2",
    "account": "main",
    "state": "stopped",
    "ipv4": null,
    "ipv6": null,
    "open_ports": [
      22
    ],
    "funnel": {},
    "started": null,
    "stops_at": null,
    "tailscale": null
  }
]
`);
});

test('a running machine is ready once the tailnet sees it online, starting before, stopping while its stop runs', async () => {
  const h = home({ peers: [peer('dev1', true), peer('dev2', false), peer('dev4', true)].join(',') });
  h.put('dev1', { state: 'running', account: 'main' });
  h.put('dev2', { state: 'running', account: 'main' });
  h.put('dev3', { state: 'running', account: 'main', stopping: 4242 }); // ps says a node-ctl runs as 4242
  h.put('dev4', { state: 'stopped', account: 'main' }); // a stopped machine's leftover node is no name worth showing
  const rows = JSON.parse((await h.run(['list', '--json'])).out) as { state: string; tailscale: string | null }[];
  expect(rows.map((m) => `${m.state} ${m.tailscale}`)).toEqual(['ready dev1.tail.ts.net', 'starting null', 'stopping null', 'stopped null']);
});

test('without the Tailscale CLI a running machine keeps the inventory word', async () => {
  const h = home({ noTailscale: true });
  h.put('dev1', { state: 'running', account: 'main' });
  const app = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  if (await Bun.file(app).exists()) return; // found by its absolute path on this computer: nothing to test here
  expect(JSON.parse((await h.run(['list', '--json'])).out)[0].state).toBe('running');
});

test('a running machine shows when its launchd job stops it, from the "-ge <seconds>" the job holds', async () => {
  const h = home();
  h.put('dev1', { state: 'running', account: 'main', started: 1 });
  h.put('dev2', { state: 'stopped', account: 'main' });
  writeFileSync(join(h.dir, 'agents', 'com.node-ctl.stop.dev1.plist'), '<string>[ $(date +%s) -ge 4102444800 ]</string>');
  writeFileSync(join(h.dir, 'agents', 'com.node-ctl.stop.dev2.plist'), '<string>-ge 4102444800</string>');
  const rows = JSON.parse((await h.run(['list', '--json'])).out) as { stops_at: number | null }[];
  expect(rows.map((m) => m.stops_at)).toEqual([4102444800, null]);
});

test('an empty inventory is [] or "no machines"; the table aligns its columns and uptimes read d/h/m', async () => {
  const h = home({ peers: peer('dev1', true) });
  expect((await h.run(['list', '--json'])).out).toBe('[]\n');
  expect((await h.run(['list'])).out).toBe('no machines\n');
  const now = Math.floor(Date.now() / 1000);
  h.put('dev1', { state: 'running', account: 'main', open_ports: [22], funnel: { '/app': 8080 }, started: now - (3 * 86400 + 4 * 3600 + 120) });
  h.put('longer-name', { state: 'stopped', account: 'main', open_ports: [22] });
  const { out } = await h.run(['list']);
  expect(out.split('\n')[0]).toBe('NAME         ACCOUNT  STATE    UPTIME  AUTOSTOP  IPV4     TAILSCALE         PORTS  FUNNEL');
  expect(out.split('\n')[2]).toBe('dev1         main     ready    3d04h   -         1.2.3.4  dev1.tail.ts.net  22     https://dev1.tail.ts.net/app -> 8080');
  expect(out.split('\n')[3]).toBe('longer-name  main     stopped  -       -         -        -                 22     -');
});

test('a table pads every column but the last to its widest cell, two spaces apart, the header bold over a dim rule', () => {
  expect(table([['A', 'BB'], ['ccc', 'd']], false)).toBe('A    BB\n───────\nccc  d\n');
  expect(table([['A', 'B'], ['é', 'x']], true)).toBe('\x1b[1mA  B\x1b[0m\n\x1b[2m────\x1b[0m\né  x\n'); // widths count characters
});

test('accounts lists each provider\'s tags sorted, with the machines each holds', async () => {
  const h = home();
  h.put('dev1', { state: 'running', account: 'main' });
  h.put('dev2', { state: 'running', account: 'cb' });
  h.put('dev3', { state: 'running', account: 'main' });
  expect(JSON.parse((await h.run(['accounts', '--json'])).out)).toEqual([
    { provider: 'hetzner', tag: 'main', machines: 2 },
    { provider: 'contabo', tag: 'cb', machines: 1 },
  ]);
  expect((await h.run(['accounts'])).out).toBe('CLOUD    ACCOUNT  MACHINES\n──────────────────────────\nhetzner  main     2\ncontabo  cb       1\n');
  expect((await h.run(['accounts', 'bogus'])).code).toBe(1);
});
