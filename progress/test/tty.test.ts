import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TtyRenderer } from '../src/render/tty.ts';
import { Sink, ev, tick } from './helpers.ts';

const tty = (columns?: number) => {
  const out = new Sink(true);
  return { out, r: new TtyRenderer(out, { color: false, columns }) };
};

test('nested actions are drawn under their parent while both run', async () => {
  const { out, r } = tty();
  r.handle(ev('a1', 'Build application', 'started'));
  r.handle(ev('a1', 'Build application', 'log', { message: 'Compiling sources' }));
  r.handle(ev('a2', 'Generating assets', 'started', { parent_action_id: 'a1' }));
  r.handle(ev('a2', 'Generating assets', 'log', { parent_action_id: 'a1', message: '3 files' }));
  await tick(40); // let a frame render mid-flight
  const screen = out.screen();
  const parent = screen.findIndex((l) => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Build application/.test(l));
  assert.notEqual(parent, -1, screen.join('\n'));
  assert.equal(screen[parent + 1], '├─ Compiling sources');
  assert.match(screen[parent + 2]!, /^└─ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Generating assets/);
  assert.equal(screen[parent + 3], '   └─ 3 files');
  r.close();
});

test('a failure keeps its last lines and reason inside the failed action, the sibling stays green', () => {
  const { out, r } = tty();
  const steps = ['Validate configuration', 'Build application', 'Run tests'];
  steps.forEach((name, i) => r.handle(ev(`a${i + 1}`, name, 'planned', { index: i + 1, total_steps: 3 })));
  r.handle(ev('a1', 'Validate configuration', 'started', { index: 1, total_steps: 3 }));
  r.handle(ev('a1', 'Validate configuration', 'completed', { index: 1, total_steps: 3, duration_ms: 100 }));
  r.handle(ev('a2', 'Build application', 'started', { index: 2, total_steps: 3 }));
  for (let i = 1; i <= 7; i++) r.handle(ev('a2', 'Build application', 'log', { message: `line ${i}` }));
  r.handle(ev('a2', 'Build application', 'failed', { message: 'TypeScript compilation failed', duration_ms: 2000 }));
  r.close();
  const screen = out.screen();
  assert.match(screen[0]!, /^✓ \[1\/3\] Validate configuration +0\.1s$/);
  assert.match(screen[1]!, /^✗ \[2\/3\] Build application +2\.0s$/);
  assert.deepEqual(screen.slice(2, 8), ['├─ line 3', '├─ line 4', '├─ line 5', '├─ line 6', '├─ line 7', '└─ TypeScript compilation failed']);
  assert.equal(screen[8], '○ [3/3] Run tests');
  assert.equal(screen.length, 9);
});

test('completed actions collapse to one line and are written to the scrollback once', async () => {
  const { out, r } = tty();
  r.handle(ev('a1', 'First', 'planned', { index: 1, total_steps: 2 }));
  r.handle(ev('a2', 'Second', 'planned', { index: 2, total_steps: 2 }));
  r.handle(ev('a1', 'First', 'started'));
  r.handle(ev('a1', 'First', 'log', { message: 'detail' }));
  r.handle(ev('a1', 'First', 'progress', { current: 1, total: 2 }));
  r.handle(ev('a1', 'First', 'completed', { duration_ms: 10 }));
  r.handle(ev('a2', 'Second', 'started'));
  await tick(200); // several frames go by; the frozen line above must not be repeated
  r.handle(ev('a2', 'Second', 'completed', { duration_ms: 200 }));
  r.close();
  const screen = out.screen();
  assert.match(screen[0]!, /^✓ \[1\/2\] First/);
  assert.match(screen[1]!, /^✓ \[2\/2\] Second/);
  assert.equal(screen.length, 2);
  assert.equal(out.text.split('✓ [1/2] First').length - 1, 1);
});

test('a cancelled action is marked as such', () => {
  const { out, r } = tty();
  r.handle(ev('a1', 'Wait for dev1', 'started'));
  r.handle(ev('a1', 'Wait for dev1', 'progress', { current: 7, total: 60, message: 'ssh: Could not resolve hostname dev1' }));
  r.handle(ev('a1', 'Wait for dev1', 'cancelled', { duration_ms: 1500 }));
  r.close();
  assert.match(out.screen()[0]!, /^◌ Wait for dev1 +1\.5s  cancelled$/);
});

test('live lines are cut to the terminal width so the region never wraps under the cursor maths', async () => {
  const { out, r } = tty(40);
  r.handle(ev('a1', 'Apply Terraform', 'started'));
  r.handle(ev('a1', 'Apply Terraform', 'log', { message: 'x'.repeat(100) }));
  await tick(40);
  const live = out.screen();
  assert.equal([...live.at(-1)!].length, 40);
  assert.match(live.at(-1)!, /^└─ x+…$/);
  assert.ok(live.every((l) => [...l].length <= 40), live.join('\n'));
  r.close();
});
