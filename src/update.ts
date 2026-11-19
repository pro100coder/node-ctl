// node-ctl update: the latest release written over this binary at the same path (ADR-0023), so the launchd and
// systemd jobs, which run process.execPath, run the new one. Nothing is written before its sha256 matches.
import { chmodSync, lstatSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Handler } from './cli.ts';
import { UserError } from './errors.ts';
import { apiUrl } from './http.ts';
import type { Progress } from './progress/progress.ts';
import type { Out } from './progress/types.ts';
import { VERSION } from './version.ts';

type Env = Record<string, string | undefined>;

const RELEASE = /^v0\.\d{6}\.\d+$/;

export function assetFor(platform: string, arch: string): string {
  if ((platform === 'darwin' || platform === 'linux') && (arch === 'arm64' || arch === 'x64')) return `node-ctl-${platform}-${arch}`;
  throw new UserError(`there is no node-ctl release for ${platform}-${arch}, only for darwin and linux on arm64 and x64`);
}

// v0.YYMMDD.NUM: a part at a time as numbers, so .10 comes after .9.
export function newer(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => v.slice(1).split('.').map(Number)) as [number[], number[]];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

async function get(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new UserError(`${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function download(url: string): Promise<Uint8Array> {
  const res = await get(url);
  if (!res.ok) throw new UserError(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// The redirect of /latest names the tag, with no API call and so no API rate limit.
async function latestTag(env: Env): Promise<string> {
  const url = apiUrl(env, 'releases', '/latest');
  const res = await get(url, { redirect: 'manual' });
  const tag = /\/tag\/([^/?#]+)$/.exec(res.headers.get('location') ?? '')?.[1];
  if (!tag || !RELEASE.test(tag)) throw new UserError(`${url}: no latest release (HTTP ${res.status})`);
  return tag;
}

interface Update {
  env: Env;
  progress: Progress;
  stdout: Out;
  execPath: string;
  version: string;
  force: boolean;
  platform: string;
  arch: string;
}

export async function selfUpdate(u: Update): Promise<void> {
  const asset = assetFor(u.platform, u.arch);
  if (!RELEASE.test(u.version) && !u.force) {
    throw new UserError(`node-ctl ${u.version} is not a release (a dev build or a pre-release): nothing to compare the latest with; node-ctl update --force installs it anyway`);
  }
  let tag = '';
  await u.progress.withAction('Find the latest release', 'latest', async () => {
    tag = await latestTag(u.env);
  });
  if (!u.force && !newer(tag, u.version)) {
    u.stdout.write(`node-ctl ${u.version} is the latest release\n`);
    return;
  }
  // Pinned to the tag compared above: latest may move on between the two requests.
  let bytes: Uint8Array = new Uint8Array();
  await u.progress.withAction(`Download ${asset} ${tag}`, 'download', async () => {
    const base = apiUrl(u.env, 'releases', `/download/${tag}`);
    const sums = new TextDecoder().decode(await download(`${base}/checksums.txt`));
    const want = sums.split('\n').map((l) => /^([0-9a-f]{64}) [ *](\S+)$/.exec(l.trimEnd())).find((m) => m?.[2] === asset)?.[1];
    if (!want) throw new UserError(`checksums.txt has no ${asset} for ${tag}: nothing was replaced`);
    bytes = await download(`${base}/${asset}`);
    const got = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    if (got !== want) throw new UserError(`the sha256 of ${asset} ${tag} is ${got}, checksums.txt says ${want}: nothing was replaced`);
  });
  // A link is left in place: whatever runs it (a scheduled stop, PATH) gets the new binary through it.
  const target = lstatSync(u.execPath).isSymbolicLink() ? realpathSync(u.execPath) : u.execPath;
  await u.progress.withAction(`Replace ${target}`, 'replace', () => {
    // a temporary file in the same directory, so the rename is atomic: the path never holds half a binary
    const tmp = join(dirname(target), `.${basename(target)}.update-${process.pid}`);
    try {
      writeFileSync(tmp, bytes);
      chmodSync(tmp, 0o755);
      renameSync(tmp, target);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw new UserError(`could not replace ${target}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  if (target !== u.execPath) u.stdout.write(`${u.execPath} is a link: replaced ${target}\n`);
  u.stdout.write(`node-ctl ${u.version} → ${tag}\n`);
}

export const update: Handler = async ({ args, progress, io }) => {
  for (const a of args) if (a !== '--force') throw new UserError(a.startsWith('-') ? `unknown option: ${a}` : 'usage: node-ctl update [--force]');
  await selfUpdate({
    env: io.env,
    progress,
    stdout: io.stdout,
    execPath: process.execPath,
    version: VERSION,
    force: args.includes('--force'),
    platform: process.platform,
    arch: process.arch,
  });
};
