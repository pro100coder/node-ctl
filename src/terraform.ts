// Terraform on the host binary, state local to each root, one workspace per account (ADR-0015,
// ADR-0017). One root per provider: the Contabo provider asks its API for a token as soon as it is
// configured, so it cannot sit in a configuration an apply of a Hetzner account also loads (ADR-0018).
// The roots are embedded and unpacked into NODE_CTL_HOME first (ADR-0022); an unpack that wrote
// means new lock files or modules, so a root is initialised again before its next command.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { account, credentials, tailscaleEnv, type Config } from './config.ts';
import type { Progress } from './progress/progress.ts';
import { actionRun, spawn } from './proc.ts';
import { unpack } from './resources.ts';

type Provider = 'hetzner' | 'contabo';

interface Tf {
  config: Config;
  home: string; // NODE_CTL_HOME
  servers?: string; // the inventory in use (SERVERS_DIR): main.tf reads var.servers_dir, its own ../servers otherwise
  progress: Progress;
  capture?: boolean; // the output is the result (output -json, state list): no log events, as 2>/dev/null
  env?: Record<string, string | undefined>; // what the children inherit; this process's environment by default
}

const unpacked = new Set<string>(); // homes this process has unpacked
const stale = new Set<string>(); // roots whose .terraform no longer matches the lock file

export const root = (home: string, provider: Provider) => join(home, provider === 'contabo' ? 'terraform/contabo' : 'terraform');

function prepare(home: string): void {
  if (unpacked.has(home)) return;
  unpacked.add(home);
  if (unpack(home)) for (const p of ['hetzner', 'contabo'] as const) stale.add(root(home, p));
}

function publicKey(c: Config): string {
  try {
    return readFileSync(c.sshPublicKeyFile, 'utf8').replace(/\n+$/, ''); // $(cat file)
  } catch {
    return '';
  }
}

function run(tf: Tf, dir: string, args: string[], env: Record<string, string>) {
  const argv = ['terraform', `-chdir=${dir}`, ...args];
  const all = { ...tf.env, TF_IN_AUTOMATION: '1', TF_VAR_ssh_public_key: publicKey(tf.config), ...env };
  return tf.capture ? spawn(argv, { env: all }) : actionRun(tf.progress, argv, { env: all });
}

// terraform init of a provider's root, without any account's credentials (bash: tf <root> init).
export async function tfInit(tf: Tf, provider: Provider) {
  prepare(tf.home);
  const dir = root(tf.home, provider);
  const r = await run(tf, dir, ['init', '-input=false', '-no-color'], {});
  if (r.status === 0) stale.delete(dir);
  return r;
}

// tf_account <tag> <args ...>: in that account's provider root and workspace, with its credentials in
// the child's environment only. An unknown tag runs as Hetzner with an empty token, as hc_tag did.
export async function tfAccount(tf: Tf, tag: string, args: string[]) {
  prepare(tf.home);
  const provider = account(tf.config, tag)?.provider ?? 'hetzner';
  const dir = root(tf.home, provider);
  if (stale.has(dir)) {
    const init = await tfInit(tf, provider);
    if (init.status !== 0) return init;
  }
  // The tailscale provider of both roots reads its OAuth client from the environment, as bash exported it.
  const servers: Record<string, string> = tf.servers ? { TF_VAR_servers_dir: tf.servers } : {};
  return run(tf, dir, args, { TF_WORKSPACE: tag, TF_VAR_account: tag, ...tailscaleEnv(tf.config), ...servers, ...credentials(tf.config, tag) });
}
