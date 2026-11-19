// start --till and autostop: a stop scheduled on this computer, because only here are the account tokens
// and the Terraform state (ADR-0019): a launchd job. It runs this binary by its absolute path with
// NODE_CTL_SCHEDULED set, so a machine stopped by hand in the meantime is nothing to do instead of an
// error retried forever.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { need, setup, type Ctx, type Run } from './command.ts';
import { UserError } from './errors.ts';
import { exists } from './inventory.ts';
import { ActionFailure } from './progress/progress.ts';
import { actionRun, spawn } from './proc.ts';

type Env = Record<string, string | undefined>;

// NODE_CTL_PLATFORM exists for the tests only.
const platformOf = (env: Env) => env.NODE_CTL_PLATFORM || process.platform;

const two = (n: number) => String(n).padStart(2, '0');
const local = (t: Date) => `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())} ${two(t.getHours())}:${two(t.getMinutes())}`;

// till_at: the moment (epoch seconds) a --till value names, by this computer's clock and time zone, or now
// plus that long; HH:MM already past is tomorrow. Refused with the reason before anything runs.
export function tillAt(t: string, now = Date.now()): number {
  const nowS = Math.floor(now / 1000);
  const span = /^([0-9]+(?:\.[0-9]+)?)([hm])$/.exec(t);
  if (span) {
    const s = Math.floor(Number(span[1]) * (span[2] === 'h' ? 3600 : 60) + 0.5); // awk's printf %d of x + 0.5
    if (s <= 0) throw new UserError(`--till ${t}: the machine would stop at once`);
    return nowS + s;
  }
  const m = /^(?:([0-9]{4})-([01][0-9])-([0-3][0-9]) )?([0-2][0-9]):([0-5][0-9])$/.exec(t);
  if (!m) throw new UserError(`--till takes HH:MM or "YYYY-MM-DD HH:MM" in this computer's time zone, or how long: 6h, 6.9h, 90m; not: ${t || 'nothing'}`);
  const today = new Date(now);
  const [y, mo, d] = m[1] ? [Number(m[1]), Number(m[2]) - 1, Number(m[3])] : [today.getFullYear(), today.getMonth(), today.getDate()];
  const at = (days: number) => new Date(y, mo, d + days, Number(m[4]), Number(m[5]));
  // Date rolls 25:00, February 30 or a time skipped by DST over instead of refusing them, as BSD date did
  if (local(at(0)).slice(m[1] ? 0 : 11) !== t) throw new UserError(`--till: not a time: ${t}`);
  let s = at(0).getTime() / 1000;
  if (s <= nowS) {
    if (m[1]) throw new UserError(`--till ${t} is already past`);
    s = at(1).getTime() / 1000;
  }
  return s;
}

// Refuses a host that cannot run the stop at that moment, before anything changes.
export function canSchedule(env: Env): void {
  if (platformOf(env) !== 'darwin') throw new UserError('--till needs launchd, which only macOS has');
}

// The command the job runs: this binary, which update replaces at the same path (ADR-0023). From source
// it is bun and the entry file. NODE_CTL_SELF is for the tests, whose binary runs behind a wrapper.
function self(env: Env): string[] {
  if (env.NODE_CTL_SELF) return [env.NODE_CTL_SELF];
  return Bun.main.startsWith('/$bunfs/') ? [process.execPath] : [process.execPath, Bun.main];
}

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const label = (name: string) => `com.node-ctl.stop.${name}`;
const plistOf = (run: Run, name: string) => join(run.p.launchAgents, `${label(name)}.plist`);
const domain = () => `gui/${process.getuid?.() ?? 0}`;

// launchd runs a job missed while the Mac slept on wake, and RunAtLoad at the next login; the job compares
// the clock itself, so neither stops the machine early. A failed stop exits 1 and is retried a minute later.
function plist(run: Run, name: string, at: number): string {
  const file = plistOf(run, name);
  const script = [
    `[ "$(date +%s)" -ge ${at} ] || exit 0`,
    `NODE_CTL_HOME=${q(run.p.home)} NODE_CTL_SCHEDULED=1 ${self(run.env).map(q).join(' ')} --progress=plain stop ${q(name)} || exit 1`,
    `rm -f ${q(file)}; launchctl bootout ${domain()}/${label(name)}`,
  ].join('\n');
  const log = xml(join(run.env.HOME || homedir(), 'Library', 'Logs', `node-ctl-stop-${name}.log`));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label(name)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string><string>-c</string>
    <string>${xml(script)}</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(run.env.PATH ?? '')}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

async function drop(run: Run, name: string): Promise<void> {
  if (platformOf(run.env) === 'darwin' && existsSync(plistOf(run, name))) {
    await spawn(['launchctl', 'bootout', `${domain()}/${label(name)}`], { env: run.env });
    rmSync(plistOf(run, name), { force: true });
  }
}

// schedule_stop: with at, the job that stops the machine then (its own "Schedule the stop" step, which the
// caller planned); without, only the job an earlier start left is dropped, so it cannot stop this one.
// False when the job could not be set.
export async function scheduleStop(run: Run, name: string, at: number | undefined): Promise<boolean> {
  if (at === undefined) {
    await drop(run, name);
    return true;
  }
  return run.progress.withAction('Schedule the stop', 'schedule', async () => {
    await drop(run, name); // one job per machine: a later call moves it
    try {
      mkdirSync(run.p.launchAgents, { recursive: true });
      writeFileSync(plistOf(run, name), plist(run, name, at));
    } catch (e) {
      throw new ActionFailure(e instanceof Error ? e.message : String(e));
    }
    const r = await actionRun(run.progress, ['launchctl', 'bootstrap', domain(), plistOf(run, name)], { env: run.env });
    if (r.status !== 0) throw new ActionFailure('', r.status);
    run.progress.log(`${name} stops at ${local(new Date(at * 1000))} ${zone(at)}`);
  });
}

// date's %Z where Intl knows an abbreviation (EST), its offset otherwise (GMT+2)
const zone = (at: number) =>
  new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date(at * 1000)).find((p) => p.type === 'timeZoneName')?.value ?? '';

// The moment each machine's job stops it, for list. A plist holds it as "-ge <seconds>" (one that does not
// say it once is no timer).
export async function stopTimes(run: Pick<Run, 'p' | 'env'>): Promise<Record<string, number>> {
  const stops: Record<string, number> = {};
  const dir = run.p.launchAgents;
  if (!existsSync(dir)) return stops;
  for (const f of readdirSync(dir).sort()) {
    const m = /^com\.node-ctl\.stop\.(.*)\.plist$/.exec(f);
    if (!m) continue;
    let text = '';
    try {
      text = readFileSync(join(dir, f), 'utf8');
    } catch {
      continue;
    }
    const at = text.match(/-ge [0-9]*/g);
    if (at?.length === 1 && at[0]!.length > 4) stops[m[1]!] = Number(at[0]!.slice(4));
  }
  return stops;
}

// start --till for a machine that is already running: the same job, moved or dropped.
export const autostop = async (ctx: Ctx): Promise<void> => {
  const run = setup(ctx);
  const [name, when] = ctx.args;
  need('autostop', when, '<name> <time | off>');
  if (exists(run.config, run.p.servers, name!).machine.state !== 'running') {
    throw new UserError(`${name} is not running; a start sets its autostop: ./node-ctl start ${name} --till <time>`);
  }
  if (when === 'off') {
    await scheduleStop(run, name!, undefined);
    ctx.io.stdout.write(`${name} has no autostop\n`);
    return;
  }
  const at = tillAt(when!);
  canSchedule(run.env);
  if (!(await scheduleStop(run, name!, at))) throw new UserError(`could not schedule the stop of ${name}`);
};
