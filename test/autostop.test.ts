// The scheduled stop (ADR-0019, ADR-0024): what --till means, the job each host gets, and the refusals
// that come before anything is scheduled. Run through main against fake launchctl/systemd binaries.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { tillAt } from '../src/autostop.ts';
import { main } from '../src/cli.ts';
import { UserError } from '../src/errors.ts';
import { fakeBins, Sink } from './helpers.ts';

const tz = process.env.TZ;
beforeAll(() => (process.env.TZ = 'Europe/Berlin'));
afterAll(() => (process.env.TZ = tz));

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();
const refused = (value: string, now = Date.now()) => {
  try {
    tillAt(value, now);
  } catch (e) {
    return e instanceof UserError ? e.message : `not a UserError: ${String(e)}`;
  }
  return 'accepted';
};

test('--till reads a date and time in this computer\'s time zone', () => {
  expect(tillAt('2099-06-01 18:30')).toBe(Date.UTC(2099, 5, 1, 16, 30) / 1000); // CEST is UTC+2
  expect(tillAt('2099-12-01 18:30')).toBe(Date.UTC(2099, 11, 1, 17, 30) / 1000); // CET is UTC+1
});

test('a bare HH:MM is today, or tomorrow once it has passed', () => {
  const now = at(2030, 3, 10, 12, 0);
  expect(tillAt('12:01', now)).toBe(at(2030, 3, 10, 12, 1) / 1000);
  expect(tillAt('12:00', now)).toBe(at(2030, 3, 11, 12, 0) / 1000); // this very minute is past too
  expect(tillAt('11:59', now)).toBe(at(2030, 3, 11, 11, 59) / 1000);
});

test('a lifetime counts from now and rounds to whole seconds, fractions included', () => {
  const now = 1_000_000_000_500;
  expect(tillAt('6.9h', now)).toBe(1_000_000_000 + 24840);
  expect(tillAt('90m', now)).toBe(1_000_000_000 + 5400);
  expect(tillAt('0.01m', now)).toBe(1_000_000_000 + 1); // 0.6 s rounds up, as awk's + 0.5
  expect(refused('0.008m', now)).toBe('--till 0.008m: the machine would stop at once');
  expect(refused('0m', now)).toBe('--till 0m: the machine would stop at once');
});

test('--till refuses what it cannot read, a time that does not exist and a date already past', () => {
  const usage = '--till takes HH:MM or "YYYY-MM-DD HH:MM" in this computer\'s time zone, or how long: 6h, 6.9h, 90m; not: ';
  for (const t of ['6', '6x', '1.h', '.5h', '-2h', 'tomorrow', '9:30', '2099-06-01T18:30']) expect(refused(t)).toBe(usage + t);
  expect(refused('')).toBe(`${usage}nothing`);
  expect(refused('25:00')).toBe('--till: not a time: 25:00');
  expect(refused('2099-02-30 10:00')).toBe('--till: not a time: 2099-02-30 10:00');
  expect(refused('2099-03-29 02:30')).toBe('--till: not a time: 2099-03-29 02:30'); // skipped by the switch to CEST
  expect(refused('2000-01-01 10:00')).toBe('--till 2000-01-01 10:00 is already past');
});

// A home with one running machine and fake launchctl, systemd-run, systemctl and loginctl that record their argv.
function home(bins: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'node-ctl-autostop-'));
  const rec = join(dir, 'rec');
  mkdirSync(join(dir, 'servers'));
  writeFileSync(join(dir, 'node-ctl.yaml'), 'hetzner: {main: t}\n');
  const put = (name: string, m: object) => writeFileSync(join(dir, 'servers', `${name}.json`), JSON.stringify({ account: 'main', ...m }));
  put('dev1', { state: 'running' });
  const record = (name: string, then = '') => `echo "${name} $*" >> ${rec}\n${then}`;
  const { PATH } = fakeBins({
    launchctl: record('launchctl'),
    'systemd-run': record('systemd-run'),
    systemctl: record('systemctl', 'case "$*" in *show*) echo Version=255 ;; esac'),
    loginctl: record('loginctl', 'echo Linger=yes'),
    terraform: record('terraform'),
    tailscale: "echo '{}'", // never the Tailscale CLI of this computer
    ...Object.fromEntries(Object.entries(bins).map(([k, v]) => [k, record(k, v)])),
  });
  const run = async (args: string[], extra: Record<string, string> = {}) => {
    const stdout = new Sink();
    const stderr = new Sink();
    const env = { HOME: dir, NODE_CTL_HOME: dir, LAUNCH_AGENTS: join(dir, 'agents'), NODE_CTL_PLATFORM: 'darwin', NODE_CTL_SELF: '/opt/node ctl/bin', PATH, ...extra };
    const code = await main(args, { stdout, stderr, env, terminal: false });
    return { code, out: stdout.text, err: stderr.text };
  };
  const calls = () => (existsSync(rec) ? readFileSync(rec, 'utf8') : '');
  const plist = join(dir, 'agents', 'com.node-ctl.stop.dev1.plist');
  const state = (name: string) => (JSON.parse(readFileSync(join(dir, 'servers', `${name}.json`), 'utf8')) as { state: string }).state;
  return { dir, put, run, calls, plist, state };
}

test.skipIf(process.platform !== 'darwin')('the launchd job is a valid plist', async () => {
  const h = home();
  expect((await h.run(['autostop', 'dev1', '2099-06-01 18:30'])).code).toBe(0);
  const lint = Bun.spawnSync(['plutil', '-lint', h.plist]);
  expect(lint.stdout.toString()).toBe(`${h.plist}: OK\n`);
});

test('the launchd job runs this binary by its absolute path with its NODE_CTL_HOME, and needs no jq', async () => {
  const h = home();
  expect((await h.run(['autostop', 'dev1', '2099-06-01 18:30'])).code).toBe(0);
  const job = readFileSync(h.plist, 'utf8');
  expect(job).toContain(`[ "$(date +%s)" -ge ${Date.UTC(2099, 5, 1, 16, 30) / 1000} ] || exit 0`);
  expect(job).toContain(`NODE_CTL_HOME='${h.dir}' NODE_CTL_SCHEDULED=1 '/opt/node ctl/bin' --progress=plain stop 'dev1' || exit 1`);
  expect(job).not.toContain('jq');
  expect(h.calls()).toContain(`launchctl bootstrap gui/${process.getuid!()} ${h.plist}`);
});

test('a scheduled stop of a machine stopped or destroyed since is done, not a failure to retry', async () => {
  const h = home();
  h.put('dev1', { state: 'stopped' });
  expect(await h.run(['stop', 'dev1'], { NODE_CTL_SCHEDULED: '1' })).toMatchObject({ code: 0, out: 'dev1 is not running; nothing to stop\n' });
  expect(await h.run(['stop', 'gone'], { NODE_CTL_SCHEDULED: '1' })).toMatchObject({ code: 0, out: 'gone is not running; nothing to stop\n' });
  expect(h.calls()).not.toContain('terraform');
  expect((await h.run(['stop', 'dev1'])).code).toBe(1); // by hand it still says so
});

test('on Linux the stop is a transient user timer at that moment in UTC, run by this binary with its home, retried a minute after a failure', async () => {
  const h = home();
  const r = await h.run(['autostop', 'dev1', '2099-06-01 18:30'], { NODE_CTL_PLATFORM: 'linux' });
  expect(r.code).toBe(0);
  const lines = h.calls().split('\n');
  const timer = lines.find((l) => l.startsWith('systemd-run '))!.replace(/--setenv=PATH=\S+ /, '');
  expect(timer).toBe(
    'systemd-run --user --quiet --collect --unit=node-ctl-stop-dev1 --on-calendar=2099-06-01 16:30:00 UTC ' +
      '--description=node-ctl stop dev1 at 2099-06-01 16:30:00 UTC --property=Restart=on-failure --property=RestartSec=60 ' +
      `--setenv=NODE_CTL_HOME=${h.dir} --setenv=NODE_CTL_SCHEDULED=1 /opt/node ctl/bin --progress=plain stop dev1`,
  );
  // the earlier timer goes first: one per machine
  expect(lines.findIndex((l) => l === 'systemctl --user stop node-ctl-stop-dev1.timer node-ctl-stop-dev1.service')).toBeLessThan(lines.indexOf(lines.find((l) => l.startsWith('systemd-run '))!));
  expect(existsSync(h.plist)).toBe(false);
});

test('on Linux a stop is not scheduled without a user manager or without linger, and the refusal says how to fix it', async () => {
  const user = userInfo().username;
  const noManager = home({ systemctl: 'echo "Failed to connect to bus: No medium found" >&2; exit 1' });
  const a = await noManager.run(['autostop', 'dev1', '2h'], { NODE_CTL_PLATFORM: 'linux' });
  expect(a.code).toBe(1);
  expect(a.err).toContain('node-ctl: --till needs a systemd user manager, and systemctl --user reaches none (Failed to connect to bus: No medium found)');
  const noLinger = home({ loginctl: 'echo Linger=no' });
  const b = await noLinger.run(['autostop', 'dev1', '2h'], { NODE_CTL_PLATFORM: 'linux' });
  expect(b.code).toBe(1);
  expect(b.err).toContain(`--till needs lingering for ${user}, or the timer dies with the session at logout; enable it once: sudo loginctl enable-linger ${user}`);
  for (const h of [noManager, noLinger]) expect(h.calls()).not.toContain('systemd-run');
  expect(noLinger.calls()).toContain(`loginctl show-user ${user} --property=Linger`);
});

test('a host that is neither macOS nor Linux has nothing to schedule with', async () => {
  const r = await home().run(['autostop', 'dev1', '2h'], { NODE_CTL_PLATFORM: 'win32' });
  expect(r.err).toBe('node-ctl: --till needs launchd (macOS) or a systemd user manager (Linux), and this is win32\n');
});

test('on Linux list reads when each timer stops its machine from the description the user manager lists', async () => {
  const h = home({
    systemctl: `case "$*" in *list-units*) printf '%s\\n' \\
      'node-ctl-stop-dev1.timer loaded active waiting node-ctl stop dev1 at 2099-06-01 16:30:00 UTC' \\
      '● node-ctl-stop-dev2.timer loaded failed failed node-ctl stop dev2 at 2099-06-02 00:00:00 UTC' \\
      'other.timer loaded active waiting at 2099-06-01 16:30:00 UTC' ;; esac`,
  });
  h.put('dev2', { state: 'running' });
  const rows = JSON.parse((await h.run(['list', '--json'], { NODE_CTL_PLATFORM: 'linux' })).out) as { name: string; stops_at: number | null }[];
  expect(rows.map((m) => [m.name, m.stops_at])).toEqual([
    ['dev1', Date.UTC(2099, 5, 1, 16, 30) / 1000],
    ['dev2', Date.UTC(2099, 5, 2) / 1000],
  ]);
});
