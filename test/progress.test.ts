import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserError } from '../src/errors.ts';
import { ActionFailure, Progress, renderersFor, resolveMode, slug } from '../src/progress/progress.ts';
import { JsonRenderer } from '../src/progress/render/json.ts';
import type { ActionEvent } from '../src/progress/types.ts';
import { Sink } from './helpers.ts';

// A Progress whose renderer is the raw JSON stream, read back as events; the clock moves 5 ms a call.
const recorded = () => {
  const out = new Sink();
  const stderr = new Sink();
  let t = 0;
  const p = new Progress(() => [new JsonRenderer(out)], stderr, () => (t += 5));
  const events = () => out.lines().map((l) => JSON.parse(l) as ActionEvent);
  return { p, events, stderr };
};
const brief = (e: ActionEvent) => [e.action_id, e.parent_action_id, e.key, e.event_type, e.index ?? null, e.message ?? null];

test('a planned step keeps its id and number when it starts; a nested action hangs under it', async () => {
  const { p, events } = recorded();
  p.plan('Write inventory', 'Apply Terraform');
  await p.withAction('Write inventory', 'inventory', () => p.log('dev1.json'));
  await p.withAction('Apply Terraform', 'apply', () => p.withAction('terraform init', 'init', () => {}));
  expect(events().map(brief)).toEqual([
    ['a1', null, 'write', 'planned', 1, null],
    ['a2', null, 'apply', 'planned', 2, null],
    ['a1', null, 'inventory', 'started', 1, null],
    ['a1', null, 'inventory', 'log', 1, 'dev1.json'],
    ['a1', null, 'inventory', 'completed', 1, null],
    ['a2', null, 'apply', 'started', 2, null],
    ['a3', 'a2', 'init', 'started', null, null],
    ['a3', 'a2', 'init', 'completed', null, null],
    ['a2', null, 'apply', 'completed', 2, null],
  ]);
});

test('every event gets the next seq and a timestamp; an ended action its duration since it started', async () => {
  const { p, events } = recorded();
  await p.withAction('Step', 'step', () => p.progress(1, 2));
  const all = events();
  expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
  expect(all.every((e) => !Number.isNaN(Date.parse(e.timestamp)))).toBe(true);
  expect(all.map((e) => e.duration_ms)).toEqual([undefined, undefined, 10]);
  expect(all[1]).toMatchObject({ event_type: 'progress', current: 1, total: 2 });
});

test('a body that fails without dying fails its action, answers false, and the next event belongs to the parent', async () => {
  const { p, events } = recorded();
  let answer: boolean | undefined;
  await p.withAction('Stop machines', 'stop', async () => {
    answer = await p.withAction('Stop dev1', 'dev1', () => {
      throw new ActionFailure();
    });
    await p.withAction('Stop dev2', 'dev2', () => {
      throw new ActionFailure('snapshot failed');
    });
    p.warn('dev1 stays running');
  });
  expect(answer).toBe(false);
  expect(events().map(brief)).toEqual([
    ['a1', null, 'stop', 'started', null, null],
    ['a2', 'a1', 'dev1', 'started', null, null],
    ['a2', 'a1', 'dev1', 'failed', null, 'Stop dev1 exited with status 1'],
    ['a3', 'a1', 'dev2', 'started', null, null],
    ['a3', 'a1', 'dev2', 'failed', null, 'snapshot failed'],
    ['a1', null, 'stop', 'warning', null, 'dev1 stays running'],
    ['a1', null, 'stop', 'completed', null, null],
  ]);
});

test('a die inside nested actions leaves them open; settling fails the innermost with the reason, each parent with its child', async () => {
  const { p, events } = recorded();
  const run = p.withAction('Start dev1', 'start', () =>
    p.withAction('Wait for dev1', 'ready', () => {
      throw new UserError('dev1 did not answer');
    }),
  );
  await expect(run).rejects.toThrow('dev1 did not answer');
  p.settle('failed', 'dev1 did not answer');
  expect(events().map(brief).slice(2)).toEqual([
    ['a2', 'a1', 'ready', 'failed', null, 'dev1 did not answer'],
    ['a1', null, 'start', 'failed', null, 'Wait for dev1 failed'],
  ]);
});

test('Ctrl+C cancels every open action, innermost first', async () => {
  const { p, events } = recorded();
  await p.withAction('Start dev1', 'start', () => p.withAction('Wait for dev1', 'ready', () => p.settle('cancelled'))).catch(() => {});
  const cancelled = events().filter((e) => e.event_type === 'cancelled');
  expect(cancelled.map((e) => e.action_name)).toEqual(['Wait for dev1', 'Start dev1']);
});

test('narration with no action open goes to stderr; the renderer opens with the first event, once', async () => {
  let opened = 0;
  const stderr = new Sink();
  const p = new Progress(() => (opened++, []), stderr);
  p.info('Writing node-ctl.yaml after every step');
  p.warn('no commit key');
  p.log('dropped: belongs to no action');
  expect(stderr.text).toBe('Writing node-ctl.yaml after every step\nnode-ctl: no commit key\n');
  expect(opened).toBe(0);
  await p.withAction('Step', 'step', () => p.info('inside'));
  p.close();
  expect(opened).toBe(1);
  expect(stderr.text).not.toContain('inside');
});

test('json mode appends one event per line to the NODE_CTL_EVENTS file, and stderr stays clean', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'node-ctl-events-')), 'events.jsonl');
  const stderr = new Sink();
  const p = new Progress(() => renderersFor('json', stderr, { events: file, color: false, columns: 80 }), stderr);
  expect(existsSync(file)).toBe(false);
  await p.withAction('Wait for dev1', 'ready', () => p.log('a "quoted"\nline'));
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  expect(lines.map((l) => (JSON.parse(l) as ActionEvent).event_type)).toEqual(['started', 'log', 'completed']);
  expect((JSON.parse(lines[1]!) as ActionEvent).message).toBe('a "quoted"\nline');
  expect(stderr.text).toBe('');
});

test('json mode without NODE_CTL_EVENTS is the raw stream on stderr', async () => {
  const stderr = new Sink();
  const p = new Progress(() => renderersFor('json', stderr, { color: false, columns: 80 }), stderr);
  await p.withAction('Step', 'step', () => {});
  expect(stderr.lines().map((l) => (JSON.parse(l) as ActionEvent).event_type)).toEqual(['started', 'completed']);
});

test('auto is tty on a terminal outside CI and plain elsewhere; a dialogue is plain unless json; anything else is refused', () => {
  const at = { terminal: true, ci: false, dialogue: false };
  expect(resolveMode('auto', at)).toBe('tty');
  expect(resolveMode('auto', { ...at, ci: true })).toBe('plain');
  expect(resolveMode('auto', { ...at, terminal: false })).toBe('plain');
  expect(resolveMode('tty', { ...at, dialogue: true })).toBe('plain');
  expect(resolveMode('json', { ...at, dialogue: true })).toBe('json');
  expect(() => resolveMode('fancy', at)).toThrow('--progress must be auto, tty, plain or json, got: fancy');
});

test('slug is the first word, lowercase, as the bash slug made it', () => {
  expect(slug('Wait for dev1')).toBe('wait');
  expect(slug('terraform apply (main)')).toBe('terraform');
  expect(slug('tailscale-rm.sh dev1')).toBe('tailscale');
  expect(slug('/data of dev1')).toBe('data');
  expect(slug('Ünder')).toBe('nder'); // one character, one dash, and one leading dash goes (tr in a UTF-8 locale)
  expect(slug('Связь dev1')).toBe('action');
});
