// Host-key stores: the keys of a machine that was just rebuilt. node-ctl never checks a host key (see
// tssh), but everything else on this computer does: a rebuilt machine answers under the same names with
// a new key, and scp, rsync, git or an editor's remote session stops at "REMOTE HOST IDENTIFICATION HAS
// CHANGED" until someone clears the entry by hand. So whenever a machine becomes ready, its old entries
// go and the keys it answers with now take their place. Merged, never generated: other hosts stay.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from './command.ts';
import { toJson } from './inventory.ts';
import { spawn } from './proc.ts';
import { addr, tailnetSuffix } from './ssh.ts';

type Env = Record<string, string | undefined>;

// The names it answers under: its tailnet address, its name, its MagicDNS name.
async function names(name: string, env: Env): Promise<string[]> {
  const ip = await addr(name, env);
  const suffix = await tailnetSuffix(env);
  return [ip, ...(ip === name ? [] : [name]), ...(suffix ? [`${name}.${suffix}`] : [])];
}

const isFile = (f: string) => {
  try {
    return statSync(f).isFile();
  } catch {
    return false;
  }
};

// Orca ADE keeps host keys in its own JSON store, one per profile, and refuses a machine whose key
// changed: ~/.ssh/known_hosts does not reach it, so a rebuild locks the IDE out until someone edits that
// file by hand. Nothing when Orca is not installed.
function orcaStores(profiles: string): string[] {
  if (!existsSync(profiles)) return [];
  try {
    return readdirSync(profiles)
      .sort()
      .map((d) => join(profiles, d, 'ssh-host-keys.json'))
      .filter(isFile);
  } catch {
    return [];
  }
}

// The ed25519 key of the keyscan lines as an accepted entry of the store: it is what the machines offer
// and what the store holds. undefined when there is none.
async function orcaEntry(host: string, keys: string, env: Env): Promise<Record<string, unknown> | undefined> {
  const line = keys.split('\n').find((l) => /^[^ ]* ssh-ed25519 /.test(l));
  if (!line) return undefined;
  const r = await spawn(['ssh-keygen', '-lf', '-'], { env, stdin: `${line}\n` });
  const fp = r.stdout.split('\n')[0]!.trim().split(/\s+/)[1];
  if (!fp) return undefined;
  const acceptedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z'); // jq's todate: seconds
  return { host, port: 22, keyType: 'ssh-ed25519', key: line.split(' ').at(-1), fingerprint: fp, acceptedAt };
}

// Record the key it offers now, or just drop the stale one. A store that is not a JSON object with a
// list of keys is not ours to repair: it is left exactly as it is.
export async function updateOrcaKey(profiles: string, host: string, keys: string, env: Env): Promise<void> {
  const stores = orcaStores(profiles);
  if (!stores.length) return;
  const entry = await orcaEntry(host, keys, env);
  for (const store of stores) {
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(store, 'utf8'));
    } catch {
      continue;
    }
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) continue;
    const d = doc as Record<string, unknown>;
    const have = d.hostKeys ?? [];
    if (!Array.isArray(have)) continue;
    d.hostKeys = [...have.filter((k) => (k as { host?: unknown } | null)?.host !== host), ...(entry ? [entry] : [])];
    try {
      writeFileSync(`${store}.tmp`, toJson(d));
      renameSync(`${store}.tmp`, store);
    } catch {}
  }
}

// Replace the machine's entries with the keys it offers now; false when no name answered with one.
// The stale entry goes even when nothing answers under that name: a name MagicDNS does not resolve
// on this host (tailscale/tailscale#19139) has no key to record, but its old one lies.
// shortcut: the default file only; a UserKnownHostsFile of your own stays yours.
export async function refreshKnownHosts(run: Run, name: string): Promise<boolean> {
  const file = join(run.p.sshDir, 'known_hosts');
  try {
    mkdirSync(run.p.sshDir, { recursive: true });
    appendFileSync(file, '');
  } catch {
    return false;
  }
  let got = false;
  for (const host of await names(name, run.env)) {
    await spawn(['ssh-keygen', '-q', '-R', host, '-f', file], { env: run.env }); // a name that was never there is not an error
    const scan = await spawn(['ssh-keyscan', '-T', '10', host], { env: run.env });
    const keys = scan.status === 0 ? scan.stdout.replace(/\n+$/, '') : '';
    await updateOrcaKey(run.p.orcaProfiles, host, keys, run.env);
    if (!keys) continue;
    try {
      appendFileSync(file, `${keys}\n`);
    } catch {
      return false;
    }
    got = true;
  }
  return got;
}

// Never fatal: a missing entry only means ssh asks about the key once.
export async function updateKnownHosts(run: Run, name: string): Promise<void> {
  if (!(await refreshKnownHosts(run, name))) {
    run.progress.warn(`could not record ${name}'s host key in ${run.p.sshDir}/known_hosts; ssh asks about it`);
  }
}
