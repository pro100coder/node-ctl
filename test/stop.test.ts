// The commands where data can be lost, run whole through main against a local fake of the Hetzner and
// Tailscale APIs and fake terraform/ssh: the snapshot that is the only copy of a stopped machine, the
// order of its writes and deletions, and a stop or start cut short.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import type { ActionEvent } from '../src/progress/types.ts';
import { fakeBins, Sink } from './helpers.ts';

type Route = (req: Request, url: URL) => Response | Promise<Response> | undefined;

const calls: string[] = [];
let route: Route = () => undefined;

// What Hetzner answers unless a test says otherwise: a running server 7 that shuts down at once, a
// snapshot 4711 written by the time it is first asked about, no snapshots before it.
function hetzner(req: Request, url: URL): Response {
  const p = url.pathname;
  if (p === '/v1/images') return Response.json({ images: [] });
  if (p === '/v1/servers') return Response.json({ servers: [{ id: 7, primary_disk_size: 40 }] });
  if (p === '/v1/servers/7') return Response.json({ server: { status: 'off' } });
  if (p.endsWith('/actions/create_image')) return Response.json({ image: { id: 4711 } });
  if (p.startsWith('/v1/images/') && req.method === 'GET') return Response.json({ image: { id: 4711, status: 'available' } });
  if (p === '/api/v2/oauth/token') return Response.json({ access_token: 'at' });
  if (p === '/api/v2/tailnet/-/devices') return Response.json({ devices: [] });
  return new Response('');
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    calls.push(`${req.method} ${url.pathname}${url.search}`);
    return (await route(req, url)) ?? hetzner(req, url);
  },
});
afterAll(() => server.stop(true));

let home = '';
let servers = '';
let rec = ''; // what the fakes record: their argv, ssh's stdin and environment

beforeEach(() => {
  calls.length = 0;
  route = () => undefined;
  home = mkdtempSync(join(tmpdir(), 'node-ctl-stop-'));
  servers = join(home, '.node-ctl', 'servers');
  rec = join(home, 'rec');
  mkdirSync(servers, { recursive: true });
  writeFileSync(join(home, 'key.pub'), 'ssh-ed25519 AAAA test\n');
  writeFileSync(
    join(home, '.node-ctl', 'node-ctl.yaml'),
    `hetzner: {main: t}
tailscale: {client_id: i, client_secret: s}
ssh_public_key_file: ${home}/key.pub
`,
  );
});

// ssh fails with SSH_RC, or with 1 when its script contains SSH_FAIL_ON; terraform's apply exits TF_RC.
function bins() {
  return fakeBins({
    terraform: `echo "terraform $*" >> ${rec}; case "$*" in *apply*) exit \${TF_RC:-0} ;; esac`,
    ssh: `echo "ssh $*" >> ${rec}; env >> ${rec}.env; in=$(cat); printf '%s\\n' "$in" >> ${rec}.stdin
[ -z "\${SSH_FAIL_ON:-}" ] || case $in in *"$SSH_FAIL_ON"*) exit 1 ;; esac
exit \${SSH_RC:-0}`,
    tailscale: 'case $1 in status) exit 0 ;; *) exit 1 ;; esac',
    'ssh-keygen': 'exit 0',
    'ssh-keyscan': 'exit 0',
  });
}

function machine(name: string, m: Record<string, unknown>): void {
  writeFileSync(join(servers, `${name}.json`), JSON.stringify({ account: 'main', type: 'cx23', location: 'nbg1', open_ports: [22], funnel: {}, ...m }));
}
const inv = (name: string) => JSON.parse(readFileSync(join(servers, `${name}.json`), 'utf8')) as Record<string, unknown>;
const recorded = (suffix = '') => (existsSync(rec + suffix) ? readFileSync(rec + suffix, 'utf8') : '');
const applies = () => recorded().split('\n').filter((l) => l.startsWith('terraform') && l.includes(' apply ')).length;

async function run(argv: string[], extra: Record<string, string> = {}) {
  const stdout = new Sink();
  const stderr = new Sink();
  const events = join(home, 'events.jsonl');
  const env = {
    HOME: home,
    PATH: bins().PATH,
    NODE_CTL_HOME: join(home, '.node-ctl'),
    SSH_DIR: join(home, 'ssh'),
    ORCA_PROFILES: join(home, 'orca'),
    LAUNCH_AGENTS: join(home, 'agents'),
    NODE_CTL_HETZNER_API: `http://127.0.0.1:${server.port}`,
    NODE_CTL_TAILSCALE_API: `http://127.0.0.1:${server.port}`,
    NODE_CTL_NO_WAIT: '1',
    NODE_CTL_PROGRESS: 'json',
    NODE_CTL_EVENTS: events,
    ...extra,
  };
  const code = await main(argv, { stdout, stderr, env, terminal: false });
  const ev = existsSync(events) ? readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ActionEvent) : [];
  return { code, out: stdout.text, err: stderr.text, events: ev, log: readFileSync(join(home, '.node-ctl', 'node-ctl.log'), 'utf8') };
}

// 1
test('a snapshot that is already being written is waited for, never a second one taken', async () => {
  machine('dev1', { state: 'running' });
  let polls = 0;
  route = (req, url) => {
    if (url.pathname === '/v1/images') return Response.json({ images: [{ id: 50, description: 'node-ctl dev1', status: 'creating' }] });
    if (url.pathname === '/v1/images/50') return Response.json({ image: { id: 50, status: ++polls < 3 ? 'creating' : 'available' } });
  };
  const r = await run(['stop', 'dev1']);
  expect(r.code).toBe(0);
  expect(calls.filter((c) => c.includes('create_image') || c.includes('/actions/shutdown'))).toEqual([]);
  expect(polls).toBe(3);
  expect(inv('dev1')).toMatchObject({ state: 'stopped', image: '50' });
});

// 2
test('the server is deleted only once its snapshot is available: one that never is leaves the machine running', async () => {
  machine('dev1', { state: 'running' });
  let failed = false;
  route = (req, url) => {
    if (url.pathname === '/v1/images/4711') {
      if (!failed) return (failed = true), new Response('busy', { status: 503 }); // a dropped poll is not available either
      return Response.json({ image: { id: 4711, status: 'creating' } });
    }
  };
  const r = await run(['stop', 'dev1']);
  expect(r.code).toBe(1);
  expect(r.err).toContain('could not snapshot the root disk of dev1; it is powered off and nothing is lost, retry: ./node-ctl stop dev1');
  expect(r.events.some((e) => e.message === 'image 4711 of dev1 is still being written; ./node-ctl stop dev1 waits for it again')).toBe(true);
  expect(applies()).toBe(0); // Terraform would delete the VPS, and the snapshot being written with it
  expect(inv('dev1').state).toBe('running');
  expect(inv('dev1').image).toBeUndefined();
});

// 3
test('the previous snapshot is deleted only after the new one is in the inventory; a failed deletion keeps it recorded', async () => {
  machine('dev1', { state: 'running', image: '100' });
  let seen: unknown = 'no delete';
  route = (req, url) => {
    if (url.pathname === '/v1/images' && calls.filter((c) => c.startsWith('GET /v1/images?')).length > 1) {
      return Response.json({ images: [{ id: 100, description: 'node-ctl dev1' }, { id: 4711, description: 'node-ctl dev1' }, { id: 9, description: 'node-ctl dev2' }] });
    }
    if (req.method === 'DELETE') {
      seen = inv('dev1').image; // what a crash right here would leave behind
      return new Response('down', { status: 500 });
    }
  };
  const r = await run(['stop', 'dev1']);
  expect(r.code).toBe(0);
  expect(seen).toBe('4711');
  expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual(['DELETE /v1/images/100']);
  expect(r.events.some((e) => e.event_type === 'warning' && e.message === 'could not delete the previous snapshot of dev1; delete it in the Hetzner console')).toBe(true);
  expect(inv('dev1')).toMatchObject({ state: 'stopped', image: '4711' });
});

// 4
test('one machine that cannot be stopped does not keep the others running, and stays running in the inventory', async () => {
  machine('dev1', { state: 'running' });
  machine('dev2', { state: 'running' });
  machine('dev3', { state: 'running' });
  route = (req, url) => {
    if (url.pathname === '/v1/servers' && url.searchParams.get('name') === 'dev2') return Response.json({ servers: [] });
  };
  const r = await run(['stop', '--all']);
  expect(r.code).toBe(1);
  expect(r.err).toContain('node-ctl: could not stop: dev2; they are still in the inventory as running and nothing is lost, retry: ./node-ctl stop dev2');
  expect([inv('dev1').state, inv('dev2').state, inv('dev3').state]).toEqual(['stopped', 'running', 'stopped']);
  expect(applies()).toBe(1); // the one apply deletes the stopped ones' servers and leaves dev2's alone
  const failed = r.events.find((e) => e.event_type === 'failed' && e.action_name === 'Stop dev2');
  expect(failed?.message).toBe('could not snapshot the root disk of dev2; it is powered off and nothing is lost, retry: ./node-ctl stop dev2');
});

// 7
test('a stop cut short in its apply is finished by stop again, with the apply alone', async () => {
  machine('dev1', { state: 'running' });
  const cut = await run(['stop', 'dev1'], { TF_RC: '1' });
  expect(cut.code).toBe(1);
  expect(inv('dev1')).toMatchObject({ state: 'stopped', image: '4711', stopping: expect.any(Number) });
  calls.length = 0;
  writeFileSync(rec, '');
  const again = await run(['stop', 'dev1']);
  expect(again.code).toBe(0);
  expect(applies()).toBe(1);
  expect(calls.filter((c) => c.includes('create_image') || c.includes('/v1/images'))).toEqual([]);
  expect(inv('dev1').stopping).toBeUndefined();
  const done = await run(['stop', 'dev1']);
  expect(done.code).toBe(1);
  expect(done.err).toContain('dev1 is not running');
});

test('a stop cut short while its snapshot is written leaves it running and marked, and stop again waits for that snapshot', async () => {
  machine('dev1', { state: 'running' });
  let ready = false;
  route = (req, url) => {
    if (url.pathname === '/v1/images/4711') return Response.json({ image: { id: 4711, status: ready ? 'available' : 'creating' } });
    if (url.pathname === '/v1/images' && calls.some((c) => c.includes('create_image'))) {
      return Response.json({ images: [{ id: 4711, description: 'node-ctl dev1', status: 'creating' }] }); // the listing lags the image
    }
  };
  expect((await run(['stop', 'dev1'])).code).toBe(1);
  expect(inv('dev1')).toMatchObject({ state: 'running', stopping: expect.any(Number) });
  ready = true;
  const before = calls.filter((c) => c.includes('create_image')).length;
  expect((await run(['stop', 'dev1'])).code).toBe(0);
  expect(calls.filter((c) => c.includes('create_image')).length).toBe(before);
  expect(inv('dev1')).toMatchObject({ state: 'stopped', image: '4711' });
});

test('a start cut short in its apply is finished by apply <name>, which waits for the machine; start again points there', async () => {
  machine('dev1', { state: 'stopped', image: '4711' });
  const cut = await run(['start', 'dev1'], { TF_RC: '1' });
  expect(cut.code).toBe(1);
  expect(cut.err).toContain('fix the cause, then: ./node-ctl apply dev1');
  expect(inv('dev1').state).toBe('running');
  const again = await run(['start', 'dev1']);
  expect(again.err).toContain('dev1 is already running; if its start was cut short: ./node-ctl apply dev1');
  writeFileSync(rec, '');
  expect((await run(['apply', 'dev1'])).code).toBe(0);
  expect(recorded()).toContain('node-ctl-user@dev1 sudo cloud-init status --wait');
});
