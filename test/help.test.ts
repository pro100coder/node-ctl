import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { PAGES } from '../src/help.ts';
import { Sink } from './helpers.ts';

// The bash CLI is the oracle for every text help prints, until T07 deletes it. Only paths that end
// before anything is read or run: help, a page, an unknown command, no command.
const bash = join(import.meta.dir, '..', 'node-ctl');

test.skipIf(!existsSync(bash))('help, the pages and the usage errors are byte for byte those of the bash CLI', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'node-ctl-parity-'));
  const env = { ...process.env, NODE_CTL_LOG: join(tmp, 'log'), NODE_CTL_CONFIG: join(tmp, 'missing.yaml'), SERVERS_DIR: join(tmp, 'servers') };
  const cases = [[], ['help'], ['--help'], ['-h'], ['frobnicate'], ['help', 'frobnicate'], ['frobnicate', '--help']];
  for (const c of Object.keys(PAGES)) cases.push(['help', c], [c, '--help']);
  for (const argv of cases) {
    const p = Bun.spawnSync([bash, ...argv], { env, stdin: 'ignore' });
    const stdout = new Sink();
    const stderr = new Sink();
    const code = await main(argv, { stdout, stderr, env: {}, terminal: false });
    expect({ argv, code, out: stdout.text, err: stderr.text }).toEqual({ argv, code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() });
  }
});
