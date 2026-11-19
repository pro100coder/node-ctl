// init and accounts add|edit: node-ctl.yaml written step by step, each step asked until its check passes.
// A step whose values are present and work is kept without asking, unless it was named.
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync, accessSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { apply } from './apply.ts';
import { probeCredentials, resticConfigured, type Group } from './check.ts';
import type { Handler } from './cli.ts';
import { accounts, loadConfig, type Config } from './config.ts';
import { UserError } from './errors.ts';
import { listAccounts } from './list.ts';
import { paths } from './paths.ts';
import { spawn } from './proc.ts';
import { unpack } from './resources.ts';
import { ensureKey } from './ssh.ts';
import * as tailscale from './tailscale.ts';
import { ask, menu, type Ui } from './ui.ts';
import { setValue } from './yaml.ts';

type Ctx = Parameters<Handler>[0];
const STEPS = ['ssh', 'link', 'gitkey', 'hetzner', 'contabo', 'tailscale', 'restic'] as const;
type Step = (typeof STEPS)[number];
const INCLUDE = 'Include config.d/node-ctl'; // relative paths in ssh_config resolve under ~/.ssh
const TAG = /^[a-z0-9][a-z0-9-]*$/;

const readable = (f: string) => {
  try {
    accessSync(f, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

class Init {
  readonly ctx: Ctx;
  readonly p: ReturnType<typeof paths>;
  config: Config;
  force: boolean; // asked again even when the values work: the step was named
  readonly adding: boolean; // accounts add: an empty tag before the first account asks again

  constructor(ctx: Ctx, force: boolean, adding = false) {
    this.ctx = ctx;
    this.p = paths(ctx.io.env);
    this.config = loadConfig(this.p.config, ctx.io.env);
    this.force = force;
    this.adding = adding;
  }

  get progress() {
    return this.ctx.progress;
  }

  get ui(): Ui {
    return this.ctx.ui;
  }

  get env() {
    return this.ctx.io.env;
  }

  // cfg_set: the example seeds a missing file; what is written is read back at once
  set(path: string[], value: string): void {
    setValue(this.p.config, path, value);
    this.config = loadConfig(this.p.config, this.env);
  }

  creds(group: Group): Promise<boolean> {
    return probeCredentials(this.progress, this.config, this.env, group);
  }

  // ~/.ssh/config pulls the generated file in, so ssh node-ctl-dev1 works from anywhere. First on
  // purpose: in ssh_config the first value of a keyword wins, so a later Host * block of the user's
  // own cannot override what the generated entries set.
  sshInclude(): boolean {
    const main = join(this.p.sshDir, 'config');
    try {
      const old = existsSync(main) ? readFileSync(main, 'utf8') : '';
      if (old.split('\n').includes(INCLUDE)) return true;
      mkdirSync(this.p.sshDir, { recursive: true });
      writeFileSync(`${main}.tmp`, `${INCLUDE}\n\n${old}`);
      renameSync(`${main}.tmp`, main);
      this.progress.info(`added '${INCLUDE}' to ${main}`);
      return true;
    } catch {
      return false;
    }
  }

  // The skill ships inside the binary: unpacked into NODE_CTL_HOME, linked where Claude Code looks.
  get skill() {
    return { link: join(this.p.skills, 'node-ctl-migrate'), target: join(this.p.home, 'skills', 'node-ctl-migrate') };
  }

  async valid(step: Step): Promise<boolean> {
    const c = this.config;
    switch (step) {
      case 'ssh': // both fix what they check, like ensure_key loading the agent
        return readable(c.sshPublicKeyFile) && (await ensureKey(this.progress, c.sshPublicKeyFile, this.env)) && this.sshInclude();
      case 'link': {
        const { link, target } = this.skill;
        let to = '';
        try {
          to = readlinkSync(link);
        } catch {}
        return to === target && existsSync(join(target, 'SKILL.md'));
      }
      case 'gitkey':
        return readable(this.p.gitKey);
      case 'hetzner':
        return accounts(c).length > 0 && (await this.creds('hetzner'));
      case 'contabo': // no Contabo account is a valid answer
        return !Object.keys(c.contabo).length || this.creds('contabo');
      case 'tailscale':
        return Boolean(c.tailscale.client_id && c.tailscale.client_secret) && this.creds('tailscale');
      case 'restic':
        return resticConfigured(c) && this.creds('restic');
    }
  }

  // init_step: a working value is kept; otherwise the step is asked until its check passes
  async step(step: Step): Promise<void> {
    if (!this.force && (await this.valid(step))) {
      this.progress.log(`configured and working, kept (./node-ctl init ${step} to change)`);
      return;
    }
    while (!(await this.ask(step))) this.progress.info('-> try again');
  }

  ask(step: Step): Promise<boolean> {
    switch (step) {
      case 'ssh':
        return this.ssh();
      case 'link':
        return Promise.resolve(this.link());
      case 'gitkey':
        return this.gitkey();
      case 'hetzner':
        return this.hetzner();
      case 'contabo':
        return this.contabo();
      case 'tailscale':
        return this.tailscale();
      case 'restic':
        return this.restic();
    }
  }

  async ssh(): Promise<boolean> {
    const file = await ask(this.ui, 'ssh_public_key_file', 'Public key installed for node-ctl-user on every machine. No key yet? ssh-keygen -t ed25519', this.config.sshPublicKeyFile);
    if (!readable(file)) {
      this.progress.warn(`cannot read ${file}`);
      return false;
    }
    this.set(['ssh_public_key_file'], file);
    if (!(await ensureKey(this.progress, this.config.sshPublicKeyFile, this.env))) {
      this.progress.warn('ssh-agent could not load the key');
      return false;
    }
    if (!this.sshInclude()) this.progress.warn(`could not add '${INCLUDE}' to ${this.p.sshDir}/config; plain 'ssh <machine>' will not work`);
    return true;
  }

  // A symlink. Never fails: init must not stall on it. The binary is no longer linked anywhere:
  // install.sh puts it on PATH.
  link(): boolean {
    const { link, target } = this.skill;
    unpack(this.p.home);
    try {
      if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() === false) {
        this.progress.warn(`${link} exists and is not a symlink; left alone`);
        return true;
      }
      mkdirSync(dirname(link), { recursive: true });
      rmSync(link, { force: true });
      symlinkSync(target, link);
      this.progress.info(`linked ${link}`);
    } catch {
      this.progress.warn(`could not link ${link}`);
    }
    return true;
  }

  // Kept once generated: a new key would have to be registered with every git host again.
  async gitkey(): Promise<boolean> {
    const key = this.p.gitKey;
    if (readable(key)) this.progress.info(`keeping ${key} (delete it to generate a new one)`);
    else {
      this.progress.info(
        'ssh-keygen asks for a passphrase next; empty means none, which is what lets an agent on a\nmachine push unattended. A passphrase has to be typed on the machine at every push.',
      );
      // ssh-keygen asks on the terminal itself (a passphrase in -N would stand in the process list);
      // the live region steps aside first, so its prompt comes after the lines that explain it
      this.progress.suspend();
      let ok = false;
      try {
        mkdirSync(dirname(key), { recursive: true });
        ok = (await spawn(['ssh-keygen', '-q', '-t', 'ed25519', '-C', 'node-ctl-user commit key', '-f', key], { env: this.env, stdin: 'inherit', inherit: true })).status === 0;
      } catch {}
      if (!ok) {
        this.progress.warn(`could not generate ${key}`);
        return false;
      }
      this.progress.info(`generated ${key}; it is installed for node-ctl-user on every machine, keep a copy`);
    }
    let pub = '';
    try {
      pub = readFileSync(`${key}.pub`, 'utf8').replace(/\n+$/, '');
    } catch {}
    this.progress.info(`add this public key to your git host (GitHub: Settings -> SSH and GPG keys):\n${pub}`);
    return true;
  }

  // must_add: accounts add was asked for one account, so the first empty tag asks again instead of
  // quietly ending the dialogue; init walks every step, where an empty tag skips the cloud.
  mustAdd(added: number): boolean {
    if (!(this.adding && added === 0)) return false;
    this.progress.warn('a tag is needed to add an account; Ctrl-C to leave without one');
    return true;
  }

  // A tag is free text, but changing a configured one, adding one or stopping is a choice: where a
  // menu can be drawn it is one, and "a new account" asks for the tag the way ask does elsewhere.
  async tag(name: string, hint: string, configured: string[], added: number, empty: string, current = ''): Promise<string> {
    const stop = this.adding && added === 0 ? '' : empty.replace(/^Empty = /, '');
    if (this.ui.drawn && (configured.length || (stop && !current))) {
      const values = [...configured, '+', ...(stop ? [''] : [])];
      const lines = [...configured.map((t) => ` ${t}: change it`), ' a new account: type its tag', ...(stop ? [` ${stop}`] : [])];
      this.progress.suspend();
      this.ui.stderr.write(`\n${hint}\n`);
      const answer = await menu(this.ui, 'account', { values, lines }, stop ? '' : '+');
      if (answer === undefined) throw new UserError('aborted');
      if (answer !== '+') return answer;
      return ask(this.ui, name, "The new account's tag: lowercase letters, digits and dashes", current);
    }
    const means = this.adding && added === 0 ? 'A tag is needed' : empty;
    const listed = configured.length ? `\nConfigured: ${configured.join(' ')}; a tag of these changes it.` : '';
    return ask(this.ui, name, `${hint}${listed} ${means}`, current);
  }

  // Every account in turn: a tag of the user's choice, then that project's token; an empty tag ends the list.
  async hetzner(): Promise<boolean> {
    for (let added = 0; ; ) {
      const tag = await this.tag(
        'hetzner_account',
        'Hetzner account: a short tag of your choice for one Hetzner project (its API token is asked next).',
        Object.keys(this.config.hetzner).sort(),
        added,
        'Empty = done adding accounts',
        accounts(this.config).length ? '' : 'main',
      );
      if (!tag) {
        if (this.mustAdd(added)) continue;
        break;
      }
      if (!TAG.test(tag)) {
        this.progress.warn('a tag is lowercase letters, digits and dashes');
        continue;
      }
      const token = await ask(
        this.ui,
        'hetzner_token',
        'Hetzner Cloud console -> that project -> Security -> API tokens -> Generate API token, permission Read & Write',
        this.config.hetzner[tag] ?? '',
        true,
      );
      this.set(['hetzner', tag], token);
      added++;
    }
    if (!accounts(this.config).length) {
      this.progress.warn('at least one Hetzner account is needed');
      return false;
    }
    return this.creds('hetzner');
  }

  // Optional and asked the same way: a tag, then that account's API credentials (an OAuth client plus
  // the API user, all four on one page of the panel). The API user is its own identity, not the panel
  // login, and its password is set through a link the panel mails out.
  async contabo(): Promise<boolean> {
    for (let added = 0; ; ) {
      const tag = await this.tag(
        'contabo_account',
        'Contabo account: a short tag of your choice for one Contabo customer account\n(its API credentials are asked next).',
        Object.keys(this.config.contabo).sort(),
        added,
        'Empty = done, no Contabo',
      );
      if (!tag) {
        if (this.mustAdd(added)) continue;
        break;
      }
      if (!TAG.test(tag)) {
        this.progress.warn('a tag is lowercase letters, digits and dashes');
        continue;
      }
      if (this.config.hetzner[tag]) {
        this.progress.warn(`${tag} already names a Hetzner account; a tag names one account`);
        continue;
      }
      const now = this.config.contabo[tag] ?? { client_id: '', client_secret: '', user: '', password: '' };
      const id = await ask(this.ui, 'contabo_client_id', 'Customer Control Panel -> Account -> Security & Access -> API credentials: the Client ID', now.client_id);
      const secret = await ask(this.ui, 'contabo_client_secret', 'The Client Secret on that same page', now.client_secret, true);
      const user = await ask(this.ui, 'contabo_user', 'The Username of those API credentials — a generated address of its own, not the one you log in with', now.user);
      const password = await ask(
        this.ui,
        'contabo_password',
        "That API user's own password: the Send link button on that page mails a link to set it.\nNeither the panel password nor the Client Secret",
        now.password,
        true,
      );
      for (const [k, v] of [['client_id', id], ['client_secret', secret], ['user', user], ['password', password]] as const) this.set(['contabo', tag, k], v);
      added++;
    }
    return !Object.keys(this.config.contabo).length || this.creds('contabo');
  }

  async tailscale(): Promise<boolean> {
    let id = await ask(
      this.ui,
      'tailscale_client_id',
      `Tailscale OAuth client. Declare the tag first, otherwise the client form has no tag field:
  Access controls -> JSON editor -> add "tag:dev": ["autogroup:admin"] to tagOwners -> Save (Definitions -> Tags lists it).
Then Settings -> OAuth clients -> Generate: scopes Auth Keys (Write) and Devices Core (Write), Tags -> tag:dev. A client made before the tag existed must be regenerated.
Leave empty to create the client now from an API access token (Settings -> Keys -> Generate access token).
For ./node-ctl expose (Tailscale Funnel), also: JSON editor -> "nodeAttrs": [{"target": ["tag:dev"], "attr": ["funnel"]}], and DNS -> HTTPS Certificates -> Enable.`,
      this.config.tailscale.client_id,
    );
    let secret = this.config.tailscale.client_secret;
    if (!id) {
      // the access token is only used here, never written
      const apiKey = await ask(this.ui, 'TS_API_KEY', 'Tailscale API access token (delete it in the console once init is done)', this.env.TS_API_KEY ?? '', true);
      try {
        ({ client_id: id, client_secret: secret } = await tailscale.createClient(this.env, apiKey));
      } catch (e) {
        this.progress.warn(`could not create the OAuth client: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      secret = await ask(this.ui, 'tailscale_client_secret', 'Its client secret (shown once when the client was created)', secret, true);
    }
    this.set(['tailscale', 'client_id'], id);
    this.set(['tailscale', 'client_secret'], secret);
    return this.creds('tailscale');
  }

  async restic(): Promise<boolean> {
    const now = this.config.restic;
    const repository = await ask(
      this.ui,
      'restic_repository',
      `Optional: S3-compatible bucket for backup/archive/restore, as s3:https://ENDPOINT/BUCKET.
Hetzner: console -> Object Storage -> Create bucket (region of your machines, e.g. nbg1) -> Manage credentials -> Generate.
Empty = no archives (stop/start still keep the whole machine in its disk snapshot).`,
      now.repository,
    );
    if (!repository) {
      this.set(['restic', 'repository'], '');
      return true;
    }
    const keyId = await ask(this.ui, 'restic_access_key_id', 'S3 access key', now.access_key_id, true);
    const secretKey = await ask(this.ui, 'restic_secret_access_key', 'S3 secret key', now.secret_access_key, true);
    let password = await ask(
      this.ui,
      'restic_password',
      'Password every archive is encrypted with; losing it loses the archives. Empty = generate one',
      now.password,
      true,
    );
    if (!password) {
      password = generated();
      this.progress.info(`generated restic.password, keep a copy of ${this.p.config}`);
    }
    for (const [k, v] of [['repository', repository], ['access_key_id', keyId], ['secret_access_key', secretKey], ['password', password]] as const) {
      this.set(['restic', k], v);
    }
    return this.creds('restic');
  }
}

// 48 letters and digits, as head -c 200 /dev/urandom | tr -dc A-Za-z0-9 gave about
function generated(): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  while (out.length < 48) for (const b of crypto.getRandomValues(new Uint8Array(64))) if (b < 248 && out.length < 48) out += abc[b % 62]; // 248 = 4 * 62: no bias
  return out;
}

export const init: Handler = async (ctx) => {
  const named = ctx.args as Step[];
  for (const s of named) if (!STEPS.includes(s)) throw new UserError(`unknown step: ${s} (${STEPS.join(' ')})`);
  const run = new Init(ctx, named.length > 0);
  const steps = named.length ? named : [...STEPS];
  ctx.progress.info(`Writing ${run.p.config} after every step; a failed check repeats the step, Ctrl-C keeps what is saved so far.`);
  ctx.progress.plan(...steps, 'Apply Terraform');
  for (const s of steps) await ctx.progress.withAction(s, s, () => run.step(s));
  ctx.progress.info('credentials verified; registering the ssh key with Hetzner');
  await apply(run.config, run.p, ctx.progress, ctx.io.env);
  ctx.progress.info('done: ./node-ctl create dev1');
};

// Adding and changing are the same question (the init step of that cloud asks for a tag and replaces
// what an existing one holds), so this is a listing plus that step, without the rest of init.
export const accountsCommand: Handler = async (ctx) => {
  const [sub, cloud = ''] = ctx.args;
  if (sub !== 'add' && sub !== 'edit') {
    const p = paths(ctx.io.env);
    listAccounts(ctx.args, loadConfig(p.config, ctx.io.env), p.servers, ctx.io.stdout, ctx.io.color ?? false);
    return;
  }
  const provider = cloud || (await menu(ctx.ui, 'cloud', { values: ['hetzner', 'contabo'], lines: [' hetzner', ' contabo'] }));
  if (provider === undefined) throw new UserError('aborted');
  if (provider !== 'hetzner' && provider !== 'contabo') throw new UserError(`not a cloud: ${provider} (hetzner, contabo)`);
  const run = new Init(ctx, true, true); // an explicit add asks, where init would keep what already works
  ctx.progress.info(`Writing ${run.p.config} after every account; a failed check repeats the question, Ctrl-C keeps what is saved.`);
  ctx.progress.plan(provider, 'Apply Terraform');
  await ctx.progress.withAction(provider, provider, () => run.step(provider));
  await apply(run.config, run.p, ctx.progress, ctx.io.env);
};
