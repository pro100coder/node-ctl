import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAGES } from '../src/help.ts';
import { RESOURCES } from '../src/resources.ts';

// The shipped artefact, not the source: one compile each, about a second together.
const root = join(import.meta.dir, '..');
const dir = mkdtempSync(join(tmpdir(), 'node-ctl-build-'));

function compile(entry: string, out: string, ...flags: string[]): string {
  const outfile = join(dir, out);
  // run in the temporary directory: the compiler leaves a copy of the executable in its working directory
  const b = Bun.spawnSync([process.execPath, 'build', '--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', ...flags, join(root, entry), '--outfile', outfile], { cwd: dir });
  expect(b.exitCode, b.stderr.toString()).toBe(0);
  return outfile;
}

test('the binary prints the version and sha it was built with, and its help', () => {
  const bin = compile('src/cli.ts', 'node-ctl', '--define', 'NODE_CTL_VERSION="v0.261119.2"', '--define', 'NODE_CTL_SHA="abc1234"');
  const version = Bun.spawnSync([bin, 'version']);
  expect([version.exitCode, version.stdout.toString()]).toEqual([0, 'node-ctl v0.261119.2 (abc1234)\n']);
  const help = Bun.spawnSync([bin, 'help', 'create']);
  expect([help.exitCode, help.stdout.toString()]).toEqual([0, PAGES.create!]);
});

test('a compiled binary carries the embedded files and unpacks them', () => {
  const bin = compile('test/fixtures/unpack.ts', 'unpack');
  const home = join(dir, 'home');
  expect(Bun.spawnSync([bin, home]).exitCode).toBe(0);
  for (const [path, text] of Object.entries(RESOURCES)) expect(readFileSync(join(home, path), 'utf8')).toBe(text);
});
