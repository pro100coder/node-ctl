// Every ssh goes over the tailnet, where WireGuard already authenticates the peer, and a rebuilt
// machine (stop/start, restore) gets a fresh host key under the same name: host keys are neither
// needed nor stable, so they are not checked or recorded. Without this, BatchMode refuses every
// new machine ("Host key verification failed") and create never becomes ready.
import { existsSync, readFileSync } from 'node:fs';
import { UserError } from './errors.ts';
import type { Progress } from './progress/progress.ts';
import { actionRun, spawn } from './proc.ts';

type Env = Record<string, string | undefined>;

// tssh <args ...>: the argv of an ssh with node-ctl's options; callers add -o BatchMode=yes where nobody may be asked.
export function tssh(...args: string[]): string[] {
  return ['ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', ...args];
}

const APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

// The Tailscale CLI, wherever this host keeps it; undefined when Tailscale is not installed.
export function tailscaleCli(env: Env = process.env, app = APP): string | undefined {
  return Bun.which('tailscale', { PATH: env.PATH ?? '' }) ?? (existsSync(app) ? app : undefined);
}

// A machine's tailnet address: the local daemon knows it even while MagicDNS answers nothing
// (tailscale/tailscale#19139); the bare name, for MagicDNS, otherwise.
export async function addr(name: string, env: Env = process.env, app = APP): Promise<string> {
  const cli = tailscaleCli(env, app);
  if (cli) {
    const r = await spawn([cli, 'ip', '-4', name], { env });
    if (r.status === 0) return r.stdout.replace(/\n+$/, '');
  }
  return name;
}

// remote <name> <script>: the script runs as root on the machine, read from stdin, so the secrets it
// carries (restic keys, the commit key) never touch a command line. With a progress, its lines are
// logs of the open action (action_run remote); without one, they are the result.
export async function remote(name: string, script: string, opts: { progress?: Progress; env?: Env; app?: string } = {}) {
  const argv = tssh(`node-ctl-user@${await addr(name, opts.env, opts.app)}`, 'sudo', 'bash', '-s');
  return opts.progress ? actionRun(opts.progress, argv, { stdin: script, env: opts.env }) : spawn(argv, { stdin: script, env: opts.env });
}

// The private key sits in ssh-agent, so BatchMode ssh calls never need the passphrase. False only when
// ssh-add failed to load it.
export async function ensureKey(progress: Progress, publicKeyFile: string, env: Env = process.env, platform = process.platform): Promise<boolean> {
  const key = publicKeyFile.replace(/\.pub$/, '');
  if (!existsSync(key)) return true; // only the public half is here: ssh will find the private key elsewhere
  let id = '';
  try {
    id = readFileSync(publicKeyFile, 'utf8').split('\n')[0]!.split(' ').slice(0, 2).join(' ');
  } catch {}
  if (id && (await spawn(['ssh-add', '-L'], { env })).stdout.includes(id)) return true;
  if ((await spawn(['ssh-add', '-l'], { env })).status === 2) {
    progress.warn('no ssh-agent running; start one with: eval $(ssh-agent)');
    return true;
  }
  progress.info(`loading ${key} into ssh-agent (asked once; macOS keeps the passphrase in Keychain)`);
  const argv = platform === 'darwin' ? ['ssh-add', '--apple-use-keychain', key] : ['ssh-add', key];
  return (await spawn(argv, { env, stdin: 'inherit', inherit: true })).status === 0;
}

// With the tailnet off every ssh hangs or fails on a bare name: said before anything runs. Without
// the CLI MagicDNS is all there is, and ssh reports the rest.
export async function ensureTailscale(env: Env = process.env, app = APP): Promise<void> {
  const cli = tailscaleCli(env, app);
  if (cli && (await spawn([cli, 'status'], { env })).status !== 0) {
    throw new UserError(`Tailscale is not running on this computer; turn it on, then retry (${cli} up)`);
  }
}
