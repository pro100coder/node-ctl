import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ActionEvent } from '../src/types.ts';

// node-ctl feeds the renderer through a FIFO and waits for it to exit once fd 3 is closed. On macOS
// a socket-style stdin never sees the FIFO's EOF, which the renderers' own tests over streams cannot show.
async function runCli(mode: string, lines: string[], args: string[] = []): Promise<{ code: number | null; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'progress-'));
  const fifo = join(dir, 'events');
  execFileSync('mkfifo', [fifo]);
  const cli = join(import.meta.dirname, '../src/cli.ts');
  // The shell opens the FIFO as the renderer's own stdin; this process is then its only writer.
  const renderer = spawn('bash', ['-c', 'f=$1; shift; exec "$@" < "$f"', 'bash', fifo, process.execPath, cli, `--progress=${mode}`, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const out: string[] = [];
  renderer.stderr.on('data', (d) => out.push(String(d)));
  const w = openSync(fifo, 'w');
  for (const line of lines) writeSync(w, `${line}\n`);
  closeSync(w);
  const code = await new Promise<number | null>((resolve) => {
    const t = setTimeout(() => { renderer.kill(); resolve(-1); }, 5000);
    renderer.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  rmSync(dir, { recursive: true });
  return { code, stderr: out.join('') };
}

test('the renderer process exits when the FIFO it reads from is closed', async () => {
  const { code, stderr } = await runCli('plain', [
    '{"action_id":"a","action_name":"Step","key":"step","event_type":"started"}',
    '{"action_id":"a","action_name":"Step","key":"step","event_type":"completed"}',
  ]);
  assert.equal(code, 0, `renderer did not exit on EOF; stderr: ${stderr}`);
  assert.match(stderr, /^\[step\] DONE duration=/m);
});

test('what a producer leaves out is filled in: parent, seq, timestamp, and a duration from its start', async () => {
  const { code, stderr } = await runCli('json', [
    '{"action_id":"a","action_name":"Step","key":"step","event_type":"started"}',
    'not json',
    '{"action_id":"a","action_name":"Step","key":"step","event_type":"completed"}',
  ]);
  assert.equal(code, 0);
  assert.match(stderr, /^progress: not an event: not json$/m); // reported and skipped, the stream goes on
  const events = stderr.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as ActionEvent);
  assert.deepEqual(events.map((e) => [e.seq, e.parent_action_id, e.event_type]), [[1, null, 'started'], [2, null, 'completed']]);
  assert.ok(events.every((e) => !Number.isNaN(Date.parse(e.timestamp))));
  assert.equal(typeof events[1]!.duration_ms, 'number');
});

test('a terminal run also appends plain lines to the log: every line of a failed step, no escape codes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'progress-log-'));
  const log = join(dir, 'node-ctl.log');
  writeFileSync(log, 'an earlier run\n');
  const out = (message: string) => JSON.stringify({ action_id: 'a', action_name: 'Apply Terraform', key: 'apply', event_type: 'log', stream: 'stderr', message });
  const { code, stderr } = await runCli('tty', [
    '{"action_id":"a","action_name":"Apply Terraform","key":"apply","event_type":"started"}',
    out('Error: creating server: timeout'), // the cause, more lines above the end than the screen keeps
    ...Array.from({ length: 8 }, (_, i) => out(`  with hcloud_server.this[${i}]`)),
    '{"action_id":"a","action_name":"Apply Terraform","key":"apply","event_type":"failed","message":"exit 1"}',
  ], [`--log=${log}`]);
  const text = readFileSync(log, 'utf8');
  rmSync(dir, { recursive: true });
  assert.equal(code, 0);
  assert.match(stderr, /Apply Terraform/); // the screen still gets the live region
  assert.match(text, /^an earlier run\n\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[apply\] START Apply Terraform\n/); // stamped like the run header
  assert.match(text, / \[apply\] stderr\| Error: creating server: timeout$/m);
  assert.match(text, / \[apply\] FAILED exit 1 duration=/m);
  assert.doesNotMatch(text, /\x1b/);
});
