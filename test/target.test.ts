import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickMachine, targeted } from '../src/target.ts';
import { Input, type Ui } from '../src/ui.ts';
import { Sink } from './helpers.ts';

test('arguments target a machine when they hold a name or --all, wherever; the values of --till and --type are no name', () => {
  expect(targeted(['dev1'])).toBe(true);
  expect(targeted(['--yes', 'dev1'])).toBe(true);
  expect(targeted(['--all'])).toBe(true);
  expect(targeted(['--till', '18:00'])).toBe(false);
  expect(targeted(['--type', 'cx22', '--yes'])).toBe(false);
  expect(targeted(['--till', '18:00', 'dev1'])).toBe(true);
  expect(targeted(['--till', '--yes'])).toBe(false);
  expect(targeted([])).toBe(false);
});

function servers() {
  const dir = mkdtempSync(join(tmpdir(), 'node-ctl-target-'));
  writeFileSync(join(dir, 'dev1.json'), JSON.stringify({ state: 'running', type: 'cx22', location: 'nbg1', account: 'main' }));
  writeFileSync(join(dir, 'long-name.json'), JSON.stringify({ state: 'stopped', type: 'cx32', account: 'main' }));
  return dir;
}
const ui = (answer: string) => {
  const stderr = new Sink();
  const queue = [new TextEncoder().encode(answer)];
  const u: Ui = { input: new Input(false, async () => queue.shift()), stderr, yes: false, home: '/h', drawn: false, color: false, columns: 80, rows: 24, suspend: () => {}, raw: () => {} };
  return { u, stderr };
};

test('the machines on offer are those in the states the command acts on, aligned as column -t would', async () => {
  const t = ui('1\n');
  expect(await pickMachine(t.u, servers(), 'stop', [])).toBe('dev1');
  expect(t.stderr.text).toBe('   1) dev1       running  cx22  nbg1  main\n   2) long-name  stopped  cx32  main\n'); // no location: the cell collapses
  expect(await pickMachine(ui('1\n').u, servers(), 'start', ['stopped'])).toBe('long-name');
  expect(await pickMachine(ui('1\n').u, servers(), 'stop', ['running'], 'every running machine')).toBe('--all');
});

test('nothing to pick, a cancelled menu and an answer off the list are errors that say so', async () => {
  await expect(pickMachine(ui('1\n').u, servers(), 'start', ['archived'])).rejects.toThrow('no archived machine for start; node-ctl list');
  await expect(pickMachine(ui('').u, servers(), 'ssh', [])).rejects.toThrow('aborted');
  await expect(pickMachine(ui('dev9\n').u, servers(), 'ssh', [])).rejects.toThrow('not a machine: dev9');
});
