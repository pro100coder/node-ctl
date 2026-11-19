import { expect, test } from 'bun:test';
import { JsonRenderer } from '../src/progress/render/json.ts';
import { PlainRenderer } from '../src/progress/render/plain.ts';
import type { ActionEvent } from '../src/progress/types.ts';
import { Sink, ev } from './helpers.ts';

const render = (events: ActionEvent[], now?: () => number) => {
  const out = new Sink();
  const r = new PlainRenderer(out, now);
  for (const e of events) r.handle(e);
  r.close();
  return out.lines();
};

test('nested actions hang under their parent by id, not by text', () => {
  const lines = render([
    ev('a1', 'Build application', 'started'),
    ev('a1', 'Build application', 'log', { message: 'Compiling sources' }),
    ev('a2', 'Generating assets', 'started', { parent_action_id: 'a1' }),
    ev('a2', 'Generating assets', 'log', { parent_action_id: 'a1', message: '3 files' }),
    ev('a2', 'Generating assets', 'completed', { parent_action_id: 'a1', duration_ms: 1200 }),
    ev('a1', 'Build application', 'completed', { duration_ms: 3400 }),
  ]);
  expect(lines).toEqual([
    '[build] START Build application',
    '[build] Compiling sources',
    '[build > generating] START Generating assets',
    '[build > generating] 3 files',
    '[build > generating] DONE duration=1.2s',
    '[build] DONE duration=3.4s',
  ]);
});

test('planned steps number their labels, and the numbers carry into the children', () => {
  const lines = render([
    ev('a1', 'Validate configuration', 'planned', { index: 1, total_steps: 2 }),
    ev('a2', 'Build application', 'planned', { index: 2, total_steps: 2 }),
    ev('a2', 'Build application', 'started', { index: 2, total_steps: 2 }),
    ev('a3', 'terraform init', 'started', { parent_action_id: 'a2' }),
  ]);
  expect(lines).toEqual(['[2/2 build] START Build application', '[2/2 build > terraform] START terraform init']);
});

test('a failure carries its reason, a child process line its stream, and nothing is coloured', () => {
  const lines = render([
    ev('a1', 'Build application', 'started'),
    ev('a1', 'Build application', 'log', { message: 'o1', stream: 'stdout' }),
    ev('a1', 'Build application', 'warning', { message: 'deprecated option' }),
    ev('a1', 'Build application', 'failed', { message: 'TypeScript compilation failed', duration_ms: 50 }),
  ]);
  expect(lines).toEqual([
    '[build] START Build application',
    '[build] stdout| o1',
    '[build] WARN deprecated option',
    '[build] FAILED TypeScript compilation failed duration=0.1s',
  ]);
  expect(lines.filter((l) => l.includes('\x1b'))).toEqual([]);
});

test('progress is at most one line a second, and the last value lands when the action ends', () => {
  const lines = render(
    [
      ev('a1', 'Wait for dev1', 'started'),
      ev('a1', 'Wait for dev1', 'progress', { current: 1, total: 60 }),
      ev('a1', 'Wait for dev1', 'progress', { current: 2, total: 60 }),
      ev('a1', 'Wait for dev1', 'progress', { current: 3, total: 60, message: 'no answer yet' }),
      ev('a1', 'Wait for dev1', 'completed'),
    ],
    () => 0, // time stands still: the second and third land in the same second
  );
  expect(lines).toEqual(['[wait] START Wait for dev1', '[wait] 1/60', '[wait] 3/60 no answer yet', '[wait] DONE']);
});

test('json mode writes every event as one line, unchanged', () => {
  const out = new Sink();
  const r = new JsonRenderer(out);
  const events = [ev('a1', 'Build application', 'started'), ev('a1', 'Build application', 'log', { message: 'a "quoted"\nline' })];
  for (const e of events) r.handle(e);
  expect(out.lines().map((l) => JSON.parse(l) as ActionEvent)).toEqual(events);
});

test('a stamped renderer, the one that writes the log, starts every line with the local time of day', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'Europe/Moscow'; // UTC+3 all year: the stamp is this computer's time, like the run header's
  try {
    const out = new Sink();
    const r = new PlainRenderer(out, () => Date.parse('2026-11-18T09:35:07.900Z'), true);
    r.handle(ev('a1', 'Apply Terraform', 'started'));
    r.handle(ev('a1', 'Apply Terraform', 'log', { stream: 'stderr', message: 'Error: timeout' }));
    r.close();
    expect(out.lines()).toEqual(['2026-11-18 12:35:07 [apply] START Apply Terraform', '2026-11-18 12:35:07 [apply] stderr| Error: timeout']);
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});
