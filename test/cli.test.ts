import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMANDS, main, parseGlobals } from '../src/cli.ts';
import { PAGES, USAGE } from '../src/help.ts';
import { Sink } from './helpers.ts';

// One in-process run: what it printed on each stream and its exit code. No terminal, no config.
// The log goes to a temporary file unless a test says otherwise: never the user's own ~/.node-ctl.
async function run(argv: string[], env: Record<string, string> = {}) {
  const stdout = new Sink();
  const stderr = new Sink();
  const log = join(mkdtempSync(join(tmpdir(), 'node-ctl-log-')), 'node-ctl.log');
  const code = await main(argv, { stdout, stderr, env: { NODE_CTL_LOG: log, ...env }, terminal: false });
  return { code, out: stdout.text, err: stderr.text };
}

test('every dispatched command has a help page that names it', () => {
  // the dispatch table is the list of commands: one added there without a page fails here
  expect(COMMANDS.length).toBeGreaterThan(20);
  for (const c of [...COMMANDS, 'help']) expect(PAGES[c]).toStartWith(`usage: ./node-ctl ${c}`);
});

test('help, --help and -h print the usage on stdout and exit 0, whatever --progress says', async () => {
  for (const argv of [['help'], ['--help'], ['-h'], ['--progress=fancy', 'help']]) {
    expect(await run(argv)).toEqual({ code: 0, out: USAGE, err: '' });
  }
});

test('a page is answered by help <command>, or by -h/--help anywhere after the command', async () => {
  expect(await run(['help', 'create'])).toEqual({ code: 0, out: PAGES.create!, err: '' });
  expect(await run(['create', 'dev1', '--type', 'cx23', '--help'])).toEqual({ code: 0, out: PAGES.create!, err: '' });
  expect(await run(['stop', '-h'])).toEqual({ code: 0, out: PAGES.stop!, err: '' });
  expect(await run(['help', '-h'])).toEqual({ code: 0, out: PAGES.help!, err: '' });
});

test('ssh hands everything after the name to the machine, --help included; only its first argument asks for the page', async () => {
  expect((await run(['ssh', '--help'])).out).toBe(PAGES.ssh!);
  const passed = await run(['ssh', 'dev1', 'ls', '--help']);
  expect(passed.out).toBe('');
  expect(passed.err).toBe('node-ctl: ssh is not implemented yet\n');
});

test('an unknown command is an error with the usage; asking for its page names it', async () => {
  expect(await run(['frobnicate'])).toEqual({ code: 1, out: '', err: `node-ctl: unknown command: frobnicate\n${USAGE}` });
  const page = { code: 1, out: '', err: 'node-ctl: unknown command: frobnicate (./node-ctl --help lists them)\n' };
  expect(await run(['frobnicate', '--help'])).toEqual(page);
  expect(await run(['help', 'frobnicate'])).toEqual(page);
  expect((await run(['help', 'toString'])).code).toBe(1); // a name off the object prototype is no page
  expect((await run(['constructor'])).code).toBe(1);
  expect(await run([])).toEqual({ code: 1, out: '', err: USAGE });
});

test('version and --version answer the build, dev when it was not built', async () => {
  expect(await run(['version'])).toEqual({ code: 0, out: 'node-ctl dev\n', err: '' });
  expect(await run(['--version'])).toEqual({ code: 0, out: 'node-ctl dev\n', err: '' });
});

test('--progress and NODE_CTL_PROGRESS are validated before any command runs', async () => {
  const refused = { code: 1, out: '', err: 'node-ctl: --progress must be auto, tty, plain or json, got: fancy\n' };
  expect(await run(['--progress=fancy', 'version'])).toEqual(refused);
  expect(await run(['version'], { NODE_CTL_PROGRESS: 'fancy' })).toEqual(refused);
  expect((await run(['--progress', 'json', 'version'], { NODE_CTL_PROGRESS: 'fancy' })).code).toBe(0); // the flag wins
});

test('a command not ported yet fails clearly and touches nothing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'node-ctl-home-'));
  const r = await run(['create', 'dev1'], { NODE_CTL_HOME: home, NODE_CTL_PROGRESS: 'json', NODE_CTL_EVENTS: join(home, 'events.jsonl') });
  expect(r).toEqual({ code: 1, out: '', err: 'node-ctl: create is not implemented yet\n' });
  expect(existsSync(join(home, 'events.jsonl'))).toBe(false);
});

test('global options come before the command; the same words after it belong to the command', () => {
  expect(parseGlobals(['--yes', '--progress', 'json', 'destroy', 'dev1', '--yes'])).toEqual({
    yes: true,
    progress: 'json',
    command: 'destroy',
    args: ['dev1', '--yes'],
  });
  expect(parseGlobals(['--progress=plain', 'ssh', 'dev1', '--yes'])).toEqual({ yes: false, progress: 'plain', command: 'ssh', args: ['dev1', '--yes'] });
  expect(parseGlobals(['--help'])).toEqual({ yes: false, progress: undefined, command: '--help', args: [] });
  expect(parseGlobals([])).toEqual({ yes: false, progress: undefined, command: '', args: [] });
});
