// node-ctl.yaml (ADR-0017): read once, narrowed here into a typed shape. Unlike the bash load_config,
// nothing lands in process.env: every credential is handed to the one call that needs it, as the
// environment of that child process (hc, cb, tf_account did the same per account).
import { existsSync, readFileSync } from 'node:fs';
import { UserError } from './errors.ts';

type Provider = 'hetzner' | 'contabo';

interface ContaboAccount {
  client_id: string;
  client_secret: string;
  user: string;
  password: string;
}

export interface Config {
  file: string; // as the messages name it
  hetzner: Record<string, string>; // tag → API token
  contabo: Record<string, ContaboAccount>;
  tailscale: { client_id: string; client_secret: string };
  restic: { repository: string; password: string; access_key_id: string; secret_access_key: string };
  sshPublicKeyFile: string;
  defaults: { type: string; location: string; contaboType: string; contaboLocation: string };
}

type Raw = Record<string, unknown>;

function mapping(v: unknown, file: string, key: string): Raw {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new UserError(`${file}: ${key} must be a mapping`);
  return v as Raw;
}

// jq -r printed any scalar as text, so a token YAML reads as a number stays the text of the file.
function str(v: unknown, file: string, key: string, fallback = ''): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  throw new UserError(`${file}: ${key} must be a string`);
}

export function loadConfig(file: string, env: Record<string, string | undefined>): Config {
  let doc: unknown = null;
  if (existsSync(file)) {
    try {
      doc = Bun.YAML.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new UserError(`${file} is not valid YAML`);
    }
  }
  const root = mapping(doc, file, 'the document');
  const section = (key: string) => mapping(root[key], file, key);
  const field = (raw: Raw, key: string, at: string, fallback = '') => str(raw[key], file, `${at}.${key}`, fallback);

  const hetzner: Record<string, string> = {};
  for (const [tag, token] of Object.entries(section('hetzner'))) hetzner[tag] = str(token, file, `hetzner.${tag}`);
  const contabo: Record<string, ContaboAccount> = {};
  for (const [tag, value] of Object.entries(section('contabo'))) {
    const a = mapping(value, file, `contabo.${tag}`);
    const at = `contabo.${tag}`;
    contabo[tag] = {
      client_id: field(a, 'client_id', at),
      client_secret: field(a, 'client_secret', at),
      user: field(a, 'user', at),
      password: field(a, 'password', at),
    };
  }
  const ts = section('tailscale');
  const restic = section('restic');
  const defaults = section('defaults');
  const contaboDefaults = mapping(defaults.contabo, file, 'defaults.contabo');
  const key = str(root.ssh_public_key_file, file, 'ssh_public_key_file', '~/.ssh/id_ed25519.pub');
  return {
    file,
    hetzner,
    contabo,
    tailscale: { client_id: field(ts, 'client_id', 'tailscale'), client_secret: field(ts, 'client_secret', 'tailscale') },
    restic: {
      repository: field(restic, 'repository', 'restic'),
      password: field(restic, 'password', 'restic'),
      access_key_id: field(restic, 'access_key_id', 'restic'),
      secret_access_key: field(restic, 'secret_access_key', 'restic'),
    },
    // only a leading ~, as ${SSH_PUBLIC_KEY_FILE/#\~/$HOME}
    sshPublicKeyFile: key.startsWith('~') ? `${env.HOME ?? ''}${key.slice(1)}` : key,
    defaults: {
      type: field(defaults, 'type', 'defaults', 'cx23'),
      location: field(defaults, 'location', 'defaults', 'nbg1'),
      contaboType: field(contaboDefaults, 'type', 'defaults.contabo', 'V45'),
      contaboLocation: field(contaboDefaults, 'location', 'defaults.contabo', 'EU'),
    },
  };
}

// Every tag, Hetzner first, each provider's sorted (jq keys): apply, check and the messages list them so.
export function accounts(c: Config): string[] {
  return [...Object.keys(c.hetzner).sort(), ...Object.keys(c.contabo).sort()];
}

// The account a tag names, undefined for an unknown tag. A tag under both providers cannot say where a
// machine lives, so it is refused at the lookup (as ensure_account did), not at load: init must still
// be able to read the file to fix it.
export function account(c: Config, tag: string): { tag: string; provider: Provider } | undefined {
  const h = Object.hasOwn(c.hetzner, tag);
  const k = Object.hasOwn(c.contabo, tag);
  if (h && k) throw new UserError(`the tag ${tag} names a Hetzner and a Contabo account in ${c.file}; a tag must name one`);
  if (h) return { tag, provider: 'hetzner' };
  if (k) return { tag, provider: 'contabo' };
  return undefined;
}

// The environment one call runs with for that account, under the names the Terraform providers and the
// APIs' clients read. Empty for an unknown tag (hc_tag ran with an empty token).
export function credentials(c: Config, tag: string): Record<string, string> {
  const a = account(c, tag);
  if (a?.provider === 'contabo') {
    const k = c.contabo[tag]!;
    return {
      CNTB_OAUTH2_CLIENT_ID: k.client_id,
      CNTB_OAUTH2_CLIENT_SECRET: k.client_secret,
      CNTB_OAUTH2_USER: k.user,
      CNTB_OAUTH2_PASS: k.password,
    };
  }
  return { HCLOUD_TOKEN: a ? c.hetzner[tag]! : '' };
}

export function tailscaleEnv(c: Config): Record<string, string> {
  return { TAILSCALE_OAUTH_CLIENT_ID: c.tailscale.client_id, TAILSCALE_OAUTH_CLIENT_SECRET: c.tailscale.client_secret };
}

// restic reads these names, on this computer and in the script piped to a machine.
export function resticEnv(c: Config): Record<string, string> {
  return {
    RESTIC_REPOSITORY: c.restic.repository,
    RESTIC_PASSWORD: c.restic.password,
    AWS_ACCESS_KEY_ID: c.restic.access_key_id,
    AWS_SECRET_ACCESS_KEY: c.restic.secret_access_key,
  };
}
