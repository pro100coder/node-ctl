import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Progress } from '../src/progress/progress.ts';
import { JsonRenderer } from '../src/progress/render/json.ts';
import type { ActionEvent } from '../src/progress/types.ts';
import { actionRun, spawn, whenCancelled } from '../src/proc.ts';
import { Sink } from './helpers.ts';

const recorded = () => {
  const out = new Sink();
  const p = new Progress(() => [new JsonRenderer(out)], new Sink());
  const events = () => out.lines().map((l) => JSON.parse(l) as ActionEvent);
  return { p, events };
};

test('a child line is a log event of the open action, on the stream it came from; a last line without a newline counts', async () => {
  const { p, events } = recorded();
  let status = -1;
  await p.withAction('Apply Terraform', 'apply', async () => {
    ({ status } = await actionRun(p, ['sh', '-c', 'echo creating; echo "Error: \\033[1mbad\\033[0m\r" >&2; printf tail; exit 3']));
  });
  expect(status).toBe(3);
  const logs = events().filter((e) => e.event_type === 'log');
  expect(logs.map((e) => [e.action_name, e.stream, e.message])).toContainAllValues([
    ['Apply Terraform', 'stdout', 'creating'],
    ['Apply Terraform', 'stderr', 'Error: [1mbad[0m'], // json_str dropped CR and ESC, nothing else
    ['Apply Terraform', 'stdout', 'tail'],
  ]);
});

test('the env of one call reaches that child only, never this process', async () => {
  const r = await spawn(['sh', '-c', 'printf %s "$HCLOUD_TOKEN"'], { env: { HCLOUD_TOKEN: 'per-call-token' } });
  expect(r).toEqual({ status: 0, stdout: 'per-call-token', stderr: '' });
  expect(process.env.HCLOUD_TOKEN).toBeUndefined();
  expect((await spawn(['sh', '-c', 'printf %s "${HCLOUD_TOKEN-unset}"'])).stdout).toBe('unset');
});

test('a script goes to the child on stdin; without one the child reads nothing', async () => {
  expect((await spawn(['sh', '-s'], { stdin: 'echo from-stdin' })).stdout).toBe('from-stdin\n');
  expect((await spawn(['cat'])).stdout).toBe('');
});

test('a command that does not exist is status 127 with the shell message; a child killed by a signal is 128 + it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-ctl-bin-'));
  const { p, events } = recorded();
  let missing = -1;
  await p.withAction('Step', 'step', async () => {
    missing = (await actionRun(p, ['terraform', 'init'], { env: { PATH: dir } })).status;
  });
  expect(missing).toBe(127);
  expect(events().find((e) => e.event_type === 'log')?.message).toBe('terraform: command not found');
  expect((await spawn(['sh', '-c', 'kill -TERM $$'])).status).toBe(143);
});

test('a command is looked up on the PATH of its own call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-ctl-bin-'));
  writeFileSync(join(dir, 'terraform'), '#!/bin/sh\necho fake terraform "$@"\n');
  chmodSync(join(dir, 'terraform'), 0o755);
  expect((await spawn(['terraform', 'init'], { env: { PATH: `${dir}:/usr/bin:/bin` } })).stdout).toBe('fake terraform init\n');
});

// Ctrl+C as a terminal sends it: to the whole process group of the foreground command.
test('Ctrl+C reaches the child, the open action is cancelled, the log keeps the child\'s last line, and node-ctl exits 130 at once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-ctl-int-'));
  const events = join(dir, 'events.jsonl');
  const log = join(dir, 'node-ctl.log');
  const fixture = join(import.meta.dir, 'fixtures/interrupt.ts');
  const job = Bun.spawn(['bash', '-c', 'set -m; "$0" "$1" create dev1 & echo $!; wait $!; echo "rc=$?"', process.execPath, fixture], {
    env: { ...process.env, NODE_CTL_PROGRESS: 'json', NODE_CTL_EVENTS: events, NODE_CTL_LOG: log },
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const reader = job.stdout.getReader();
  let out = new TextDecoder().decode((await reader.read()).value);
  const pid = Number(out.trim());
  // a failed expectation must not leave the fixture behind: it waits 30 s for nothing, or forever when stuck
  try {
    for (let i = 0; i < 100 && !(existsSync(events) && readFileSync(events, 'utf8').includes('"message":"started"')); i++) await Bun.sleep(50);
    const sent = Date.now();
    process.kill(-pid, 'SIGINT');
    for (let r = await reader.read(); !r.done; r = await reader.read()) out += new TextDecoder().decode(r.value);
    await job.exited;
    expect(out).toContain('rc=130');
    expect(Date.now() - sent).toBeLessThan(10_000); // the 30 s timer after the step was not waited for
    const all = readFileSync(events, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ActionEvent);
    expect(all.filter((e) => e.event_type === 'cancelled').map((e) => e.action_name)).toEqual(['Wait for dev1']);
    expect(all.some((e) => e.event_type === 'failed' || e.event_type === 'completed')).toBe(false);
    expect(all.some((e) => e.message?.startsWith('went on'))).toBe(false);
    const text = readFileSync(log, 'utf8');
    expect(text).toContain('[ready] stdout| got INT'); // the child had the signal, and its answer was logged
    expect(text).toContain('[ready] CANCELLED');
    expect(text).toMatch(/=== exit 130\n$/);
  } finally {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {} // already gone
  }
}, 20_000);

// The terminal's Ctrl+C reaches the child too, and a child with an INT trap can exit before this process
// has run its own handler: its 130 is the Ctrl+C then, and nothing may go on after it.
test('a child that exits 130 is a Ctrl+C: the command does not go on after it', async () => {
  let cancelled = false;
  whenCancelled(() => (cancelled = true));
  let went = false;
  void actionRun(recorded().p, ['sh', '-c', 'exit 130']).then(() => (went = true));
  for (let i = 0; i < 100 && !cancelled; i++) await Bun.sleep(10);
  expect(cancelled).toBe(true);
  expect(went).toBe(false);
  whenCancelled(() => {});
});
