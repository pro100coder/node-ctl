import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type Handler } from '../src/cli.ts';
import { UserError } from '../src/errors.ts';
import { openLog } from '../src/log.ts';
import { Sink } from './helpers.ts';

const LIMIT = 10485760; // the bash rotation threshold: wc -c -le 10485760 kept the file
const logFile = () => join(mkdtempSync(join(tmpdir(), 'node-ctl-log-')), 'node-ctl.log');
const STAMP = String.raw`\d{4}-\d\d-\d\d \d\d:\d\d:\d\d`;

test('a log past 10 MB becomes .1, replacing the previous one; one of exactly 10 MB just grows', () => {
  const big = logFile();
  writeFileSync(big, '');
  truncateSync(big, LIMIT + 1);
  writeFileSync(`${big}.1`, 'two runs ago\n');
  openLog(big).line('=== node-ctl list');
  expect(statSync(`${big}.1`).size).toBe(LIMIT + 1);
  expect(readFileSync(big, 'utf8')).toMatch(new RegExp(`^${STAMP} === node-ctl list\n$`));

  const full = logFile();
  writeFileSync(full, '');
  truncateSync(full, LIMIT);
  openLog(full).line('=== node-ctl list');
  expect(statSync(full).size).toBeGreaterThan(LIMIT);
  expect(() => statSync(`${full}.1`)).toThrow();
});

test('a log that cannot be written never stops the command', () => {
  const log = openLog('/dev/null/not-a-dir/node-ctl.log');
  expect(() => log.line('=== node-ctl list')).not.toThrow();
});

// A command run in process: its stamped lines, what it printed, and the frame of the run.
async function runLogged(argv: string[], handler: Handler, extra: Record<string, string> = {}) {
  const log = logFile();
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await main(argv, { stdout, stderr, env: { NODE_CTL_LOG: log, NODE_CTL_PROGRESS: 'plain', ...extra }, terminal: false }, new Map([[argv.at(-2)!, handler]]));
  return { code, log: readFileSync(log, 'utf8'), stdout: stdout.text, stderr: stderr.text };
}

test('every run lands in the log: the command line, its output, the actions as stamped plain lines, and its exit status', async () => {
  const r = await runLogged(['--progress=plain', 'ports', 'dev1'], async ({ progress, io }) => {
    await progress.withAction('Open ports', 'ports', () => progress.log('22,80'));
    io.stdout.write('result line\n');
  });
  expect(r.code).toBe(0);
  const lines = r.log.split('\n');
  expect(lines[0]).toMatch(new RegExp(`^${STAMP} === node-ctl ports dev1$`));
  expect(r.log).toMatch(new RegExp(`${STAMP} \\[ports\\] START Open ports\n${STAMP} \\[ports\\] 22,80\n`));
  expect(r.log).toContain('result line\n');
  expect(lines.at(-2)).toMatch(new RegExp(`^${STAMP} === exit 0$`));
  expect(r.stderr).toContain('[ports] 22,80'); // the screen still gets its drawing, unstamped
  expect(r.stderr).not.toMatch(new RegExp(STAMP));
});

test('a die lands in the log with its message and exit status', async () => {
  const r = await runLogged(['stop', 'nope'], () => {
    throw new UserError('no such machine: nope');
  });
  expect(r.code).toBe(1);
  expect(r.log).toContain('node-ctl: no such machine: nope\n');
  expect(r.log).toMatch(new RegExp(`${STAMP} === exit 1\n$`));
});

test('ssh and load are a screen, not a record: only the frame of the run is logged', async () => {
  for (const command of ['ssh', 'load']) {
    const r = await runLogged([command, 'dev1'], async ({ progress, io }) => {
      await progress.withAction('Frame', 'frame', () => progress.log('LOAD-FRAME'));
      io.stdout.write('LOAD-FRAME\n');
    });
    expect(r.stdout).toBe('LOAD-FRAME\n');
    expect(r.log).toMatch(new RegExp(`^${STAMP} === node-ctl ${command} dev1\n${STAMP} === exit 0\n$`));
  }
});

test('help and version touch nothing: no log is written', async () => {
  const log = logFile();
  for (const argv of [['help'], ['version'], ['stop', '--help']]) {
    await main(argv, { stdout: new Sink(), stderr: new Sink(), env: { NODE_CTL_LOG: log }, terminal: false });
  }
  expect(() => statSync(log)).toThrow();
});
