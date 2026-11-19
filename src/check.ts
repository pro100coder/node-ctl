// check, and the credential probes init runs after each step (scripts/check.sh). Every probe is an
// action; a group fails when any of its probes did, and says how many.
import { accessSync, constants, existsSync } from 'node:fs';
import type { Handler } from './cli.ts';
import * as contabo from './contabo.ts';
import { accounts, loadConfig, resticEnv, type Config } from './config.ts';
import { UserError } from './errors.ts';
import { request } from './http.ts';
import { machineNames, readMachine } from './inventory.ts';
import { paths } from './paths.ts';
import { ActionFailure, type Progress } from './progress/progress.ts';
import { spawn } from './proc.ts';
import { addr, ensureKey, tailscaleCli, tssh } from './ssh.ts';
import * as tailscale from './tailscale.ts';

type Env = Record<string, string | undefined>;
export type Group = 'hetzner' | 'contabo' | 'tailscale' | 'restic';

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));
// a failed call, then what it means: curl's error line came first, then the script's hint
const hinted = async <T>(call: Promise<T>, hint: string): Promise<T> => call.catch((e: unknown) => Promise.reject(new Error(`${text(e)}\n${hint}`)));

// archives are optional: any empty value means "no archives"
export const resticConfigured = (c: Config) => Object.values(c.restic).every(Boolean);

async function tailscaleClient(env: Env, client: Config['tailscale']): Promise<void> {
  // auth keys (tskey-auth-...) are the usual mix-up: the API answers 401 for them
  if (client.client_id.startsWith('tskey-')) throw new Error('the client id is a tskey-* key, but an OAuth client id looks like k1a2b3c4CNTRL');
  if (!client.client_secret.startsWith('tskey-client-')) {
    throw new Error('the secret must start with tskey-client-; an auth key from Settings -> Keys is not an OAuth client');
  }
  const headers = { Authorization: `Bearer ${await tailscale.token(env, client)}` };
  // A token proves nothing about the tag: mint the key Terraform will mint and throw it away, so a
  // missing tagOwners entry or a client generated without tag:dev fails here instead of in apply.
  const key = await hinted(
    request(env, 'tailscale', '/api/v2/tailnet/-/keys', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilities: { devices: { create: { tags: ['tag:dev'], ephemeral: true } } }, expirySeconds: 60, description: 'node-ctl check' }),
    }),
    'the client cannot mint a tag:dev key: allow the tag (tagOwners) and generate the client with tag:dev, or leave the client id empty in init',
  );
  const id = String((key as { id?: unknown } | null)?.id ?? 'null');
  await request(env, 'tailscale', `/api/v2/tailnet/-/keys/${id}`, { method: 'DELETE', headers }).catch(() => {});
  // stop/destroy delete the node through the API when the machine cannot log itself out
  await hinted(
    request(env, 'tailscale', '/api/v2/tailnet/-/devices', { headers }),
    'the client cannot list devices: regenerate it with scope devices:core (write) as well, or leave the client id empty in init',
  );
}

// An empty repository is expected before the first backup; initialising it is the check.
async function resticRepo(env: Record<string, string>): Promise<void> {
  if ((await spawn(['restic', 'cat', 'config'], { env })).status === 0) return;
  const init = await spawn(['restic', 'init'], { env });
  if (init.status !== 0) throw new Error(init.stderr.replace(/\n+$/, ''));
}

// A client that authenticates but cannot list instances is not a working account.
async function contaboAccount(env: Env, a: Config['contabo'][string]): Promise<void> {
  const wrong = 'no access token: the Client ID, Client Secret, API Username or its password is wrong (panel -> Account -> Security & Access)';
  const t = await hinted(contabo.token(env, a), wrong);
  if (!t) throw new Error(wrong);
  await hinted(contabo.compute(env, t, '/v1/compute/instances?size=1'), 'the token does not reach the compute API');
}

// check_creds [group]: the probes are independent round trips, so they run at once, each a child of
// the current action. True when all of them passed.
export async function probeCredentials(progress: Progress, config: Config, env: Env, group?: Group): Promise<boolean> {
  const wants = (g: Group) => !group || group === g;
  const runs: Promise<boolean>[] = [];
  if (wants('hetzner')) {
    for (const [tag, token] of Object.entries(config.hetzner)) {
      runs.push(
        progress.concurrent(`c1-${tag}`, `Hetzner token (${tag})`, 'hetzner', async () => {
          await request(env, 'hetzner', '/v1/servers?per_page=1', { headers: { Authorization: `Bearer ${token}` } });
        }),
      );
    }
  }
  if (wants('tailscale')) runs.push(progress.concurrent('c2', 'Tailscale OAuth client', 'tailscale', () => tailscaleClient(env, config.tailscale)));
  if (wants('restic')) {
    runs.push(
      progress.concurrent('c3', 'restic repository', 'restic', async () => {
        if (!resticConfigured(config)) return 'archives disabled';
        if (!Bun.which('restic', { PATH: env.PATH ?? '' })) throw new Error('restic is not installed on this host (brew install restic)');
        await resticRepo(resticEnv(config));
      }),
    );
  }
  if (wants('contabo')) {
    for (const [tag, a] of Object.entries(config.contabo)) {
      runs.push(progress.concurrent(`c4-${tag}`, `Contabo credentials (${tag})`, 'contabo', () => contaboAccount(env, a)));
    }
  }
  return (await Promise.all(runs)).every(Boolean);
}

// One child action per check: false fails it, a thrown error fails it with its message as the reason.
class Probes {
  probes = 0;
  failed = 0;
  readonly progress: Progress;

  constructor(progress: Progress) {
    this.progress = progress;
  }

  async probe(name: string, ok: string, fail: string, test: () => boolean | Promise<boolean>): Promise<void> {
    this.probes++;
    const key = name.toLowerCase().replace(/[^a-z0-9\n]/g, '-').replace(/^-/, '').replace(/-$/, '');
    const passed = await this.progress.withAction(name, key, async () => {
      let out = '';
      let pass = false;
      try {
        pass = await test();
      } catch (e) {
        out = text(e);
      }
      if (!pass) throw new ActionFailure(`${fail}${out ? `: ${out}` : ''}`);
      if (ok) this.progress.log(ok);
    });
    if (!passed) this.failed++;
  }

  // group: fails with how many of this group's probes did
  async group(body: () => Promise<void>): Promise<void> {
    const [f0, p0] = [this.failed, this.probes];
    await body();
    if (this.failed > f0) throw new ActionFailure(`${this.failed - f0} of ${this.probes - p0} checks failed`);
  }
}

const readable = (f: string) => {
  try {
    accessSync(f, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

const labels = (c: Config) => [...Object.keys(c.hetzner).sort().map((t) => `hetzner/${t}`), ...Object.keys(c.contabo).sort().map((t) => `contabo/${t}`)];

// jq, yq, curl and node are no longer needed on the host: the binary reads YAML, edits JSON and calls
// the APIs itself, and makes Contabo's request ids too (uuidgen).
export const check: Handler = async ({ progress, io }) => {
  const env = io.env;
  const p = paths(env);
  const config = loadConfig(p.config, env);
  const key = config.sshPublicKeyFile;
  const again = 'then run ./node-ctl check again';
  const on = (t: string) => Boolean(Bun.which(t, { PATH: env.PATH ?? '' }));
  const g = new Probes(progress);
  progress.plan('Host', `Config ${p.config}`, 'Credentials', 'Tailnet');
  await progress.withAction('Host', 'host', () =>
    g.group(async () => {
      for (const t of ['terraform', 'ssh']) await g.probe(t, '', 'not installed', () => on(t));
      await g.probe('restic', '', 'not installed: archives cannot be verified (brew install restic)', () => on('restic'));
      await g.probe('ssh key', key, `unreadable: ${key} (ssh_public_key_file in ${p.config})`, () => readable(key));
      await g.probe('ssh-agent', 'key loaded', `refused the key ${key}`, () => ensureKey(progress, key, env));
    }),
  );
  await progress.withAction(`Config ${p.config}`, 'config', () =>
    g.group(async () => {
      await g.probe(p.config, '', 'missing: run ./node-ctl init', () => existsSync(p.config));
      await g.probe('accounts', labels(config).join(' '), 'no account: run ./node-ctl init hetzner, or ./node-ctl init contabo', () => accounts(config).length > 0);
      await g.probe('tailscale.client_id', '', 'empty: run ./node-ctl init', () => Boolean(config.tailscale.client_id));
      await g.probe('tailscale.client_secret', '', 'empty: run ./node-ctl init', () => Boolean(config.tailscale.client_secret));
      for (const [k, v] of Object.entries(config.restic)) {
        await g.probe(`restic.${k}`, v ? '' : 'empty: archives disabled (./node-ctl init restic)', '', () => true);
      }
    }),
  );
  if (g.failed) throw new UserError(`fix the failed checks (or run ./node-ctl init), ${again}`);
  const creds = await progress.withAction('Credentials', 'credentials', async () => {
    if (!(await probeCredentials(progress, config, env))) throw new ActionFailure('a credential was rejected');
  });
  if (!creds) throw new UserError(`fix the failed checks (or run ./node-ctl init), ${again}`);
  const tailnet = await progress.withAction('Tailnet', 'tailnet', () =>
    g.group(async () => {
      const cli = tailscaleCli(env);
      if (cli) {
        await g.probe('Tailscale on this host', '', `not running (${cli} up)`, async () => {
          const r = await spawn([cli, 'status'], { env });
          if (r.status !== 0) throw new Error(r.stderr.replace(/\n+$/, ''));
          return true;
        });
      }
      // one running machine is proof enough
      const name = machineNames(p.servers).find((n) => readMachine(p.servers, n).state === 'running');
      if (!name) return;
      await g.probe(`node-ctl-user@${name}`, 'answers', 'not reachable: Tailscale not connected, or MagicDNS off on this host', async () => {
        const r = await spawn(tssh('-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', `node-ctl-user@${await addr(name, env)}`, 'true'), { env });
        if (r.status !== 0) throw new Error(r.stderr.replace(/\n+$/, ''));
        return true;
      });
    }),
  );
  if (!tailnet) throw new UserError(`fix the failed checks, ${again}`);
  io.stdout.write('all good\n');
};
