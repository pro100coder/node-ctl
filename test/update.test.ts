import { afterAll, beforeEach, expect, test } from 'bun:test';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserError } from '../src/errors.ts';
import { Progress } from '../src/progress/progress.ts';
import { assetFor, newer, selfUpdate } from '../src/update.ts';
import { Sink } from './helpers.ts';

// A release as GitHub serves it: /latest redirects to the tag's page, the files are under /download/<tag>/.
let release: { tag: string; files: Record<string, string> };
const seen: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    seen.push(path);
    if (path === '/latest') return new Response(null, { status: 302, headers: { location: `https://github.invalid/o/r/releases/tag/${release.tag}` } });
    const file = path.startsWith(`/download/${release.tag}/`) ? release.files[path.split('/').pop()!] : undefined;
    return file === undefined ? new Response('Not Found', { status: 404 }) : new Response(file);
  },
});
afterAll(() => server.stop(true));
const env = { NODE_CTL_RELEASES: `http://127.0.0.1:${server.port}` };

const NEW = '#!/bin/sh\necho new\n';
const sha = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex');
const ASSET = 'node-ctl-darwin-arm64';

beforeEach(() => {
  release = { tag: 'v0.261120.1', files: { [ASSET]: NEW, 'checksums.txt': `${sha('other')}  node-ctl-linux-x64\n${sha(NEW)}  ${ASSET}\n` } };
  seen.length = 0;
});

function installed(content = 'old binary'): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), 'node-ctl-update-'));
  const bin = join(dir, 'node-ctl');
  writeFileSync(bin, content, { mode: 0o755 });
  return { dir, bin };
}

function run(execPath: string, version: string, force = false) {
  const stdout = new Sink();
  const progress = new Progress(() => [], new Sink());
  return { stdout, done: selfUpdate({ env, progress, stdout, execPath, version, force, platform: 'darwin', arch: 'arm64' }) };
}

test('release versions compare by date, then by the number of that day, as numbers', () => {
  expect(newer('v0.261120.1', 'v0.261119.9')).toBe(true);
  expect(newer('v0.261119.10', 'v0.261119.9')).toBe(true);
  expect(newer('v0.261119.9', 'v0.261119.9')).toBe(false);
  expect(newer('v0.261118.3', 'v0.261119.1')).toBe(false);
});

test('the asset is named after the OS and architecture; anything else has none', () => {
  expect(assetFor('darwin', 'arm64')).toBe('node-ctl-darwin-arm64');
  expect(assetFor('darwin', 'x64')).toBe('node-ctl-darwin-x64');
  expect(assetFor('linux', 'x64')).toBe('node-ctl-linux-x64');
  expect(assetFor('linux', 'arm64')).toBe('node-ctl-linux-arm64');
  expect(() => assetFor('win32', 'x64')).toThrow(UserError);
  expect(() => assetFor('linux', 'ia32')).toThrow(UserError);
});

test('a newer release replaces the binary at its own path, executable, and says old -> new', async () => {
  const { dir, bin } = installed();
  const { stdout, done } = run(bin, 'v0.261119.2');
  await done;
  expect(readFileSync(bin, 'utf8')).toBe(NEW);
  expect(statSync(bin).mode & 0o777).toBe(0o755);
  expect(readdirSync(dir)).toEqual(['node-ctl']); // no temporary file left behind
  expect(seen).toContain(`/download/v0.261120.1/${ASSET}`); // the tag it compared, not whatever latest is by now
  expect(stdout.text).toBe('node-ctl v0.261119.2 → v0.261120.1\n');
});

test('a sha256 that does not match is refused and the old binary stays byte for byte', async () => {
  release.files[ASSET] = 'tampered';
  const { dir, bin } = installed();
  await expect(run(bin, 'v0.261119.2').done).rejects.toThrow(/sha256/);
  expect(readFileSync(bin, 'utf8')).toBe('old binary');
  expect(readdirSync(dir)).toEqual(['node-ctl']);
});

test('checksums.txt without the asset is refused as well', async () => {
  release.files['checksums.txt'] = `${sha(NEW)}  node-ctl-linux-x64\n`;
  const { bin } = installed();
  await expect(run(bin, 'v0.261119.2').done).rejects.toThrow(/checksums\.txt has no node-ctl-darwin-arm64/);
  expect(readFileSync(bin, 'utf8')).toBe('old binary');
});

test('the latest release or an older one downloads nothing', async () => {
  const { bin } = installed();
  const { stdout, done } = run(bin, 'v0.261120.1');
  await done;
  expect(stdout.text).toBe('node-ctl v0.261120.1 is the latest release\n');
  expect(seen).toEqual(['/latest']);
  expect(readFileSync(bin, 'utf8')).toBe('old binary');
});

test('a dev build is refused, since it has no version to compare; --force installs the release anyway', async () => {
  const { bin } = installed();
  await expect(run(bin, 'dev').done).rejects.toThrow(/dev build.*--force/);
  expect(readFileSync(bin, 'utf8')).toBe('old binary');
  const { stdout, done } = run(bin, 'dev', true);
  await done;
  expect(readFileSync(bin, 'utf8')).toBe(NEW);
  expect(stdout.text).toBe('node-ctl dev → v0.261120.1\n');
});

test('through a symlink the file it points to is replaced, the link stays, and it says so', async () => {
  const { dir, bin } = installed();
  const link = join(dir, 'link');
  symlinkSync(bin, link);
  const { stdout, done } = run(link, 'v0.261119.2');
  await done;
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readFileSync(bin, 'utf8')).toBe(NEW);
  expect(stdout.text).toContain(`${link} is a link: replaced ${realpathSync(bin)}`); // tmpdir is under /var -> /private/var on macOS
});

test('a release base that redirects nowhere is an error that names it', async () => {
  const bad = { NODE_CTL_RELEASES: 'http://127.0.0.1:1' };
  const { bin } = installed();
  await expect(selfUpdate({ env: bad, progress: new Progress(() => [], new Sink()), stdout: new Sink(), execPath: bin, version: 'v0.261119.1', force: false, platform: 'linux', arch: 'x64' })).rejects.toThrow(/127\.0\.0\.1:1\/latest/);
});
