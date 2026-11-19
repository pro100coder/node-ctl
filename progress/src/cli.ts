// Renderer as a process: reads events as JSON lines on stdin, draws on stderr. A producer in any
// language (./node-ctl is bash) only has to print lines; seq, timestamp and duration are filled in here
// when it leaves them out. The producer resolves --progress=auto itself: it alone knows whether its
// stderr is a terminal, since this process only ever sees the pipe.
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { JsonRenderer } from './render/json.ts';
import { PlainRenderer } from './render/plain.ts';
import { TtyRenderer } from './render/tty.ts';
import type { ActionEvent, Renderer } from './types.ts';

const mode = process.argv.find((a) => a.startsWith('--progress='))?.slice('--progress='.length);
const renderer: Renderer =
  mode === 'json'
    ? new JsonRenderer(process.stderr)
    : mode === 'tty'
      ? new TtyRenderer(process.stderr, {
          color: !process.env.NO_COLOR,
          columns: process.stderr.columns ?? (Number(process.env.COLUMNS) || 80), // no tty here: the producer passes COLUMNS
        })
      : new PlainRenderer(process.stderr);
// The producer's log: plain lines stamped with the time, whatever the screen gets (a live region is no record).
const logPath = process.argv.find((a) => a.startsWith('--log='))?.slice('--log='.length);
const log = logPath ? new PlainRenderer(createWriteStream(logPath, { flags: 'a' }), Date.now, true) : undefined;
process.on('SIGINT', () => {}); // the producer decides what Ctrl+C means; drawing stops at end of input

let seq = 0;
const started = new Map<string, number>();
// Not process.stdin: the producer writes through a FIFO, and on macOS libuv never reports its EOF to a
// socket-style stdin, so the renderer would outlive node-ctl. Blocking reads off the thread pool do.
const rl = createInterface({ input: createReadStream('', { fd: 0 }) });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let raw: Partial<ActionEvent>;
  try {
    raw = JSON.parse(line) as Partial<ActionEvent>;
  } catch {
    process.stderr.write(`progress: not an event: ${line}\n`);
    return;
  }
  if (!raw.action_id || !raw.action_name || !raw.event_type) return;
  const now = Date.now();
  if (raw.event_type === 'started') started.set(raw.action_id, now);
  const event: ActionEvent = {
    ...raw,
    action_id: raw.action_id,
    action_name: raw.action_name,
    event_type: raw.event_type,
    parent_action_id: raw.parent_action_id ?? null,
    key: raw.key ?? raw.action_name,
    seq: raw.seq ?? ++seq,
    timestamp: raw.timestamp ?? new Date(now).toISOString(),
  };
  if (['completed', 'failed', 'cancelled'].includes(event.event_type) && event.duration_ms === undefined) {
    const at = started.get(event.action_id);
    if (at !== undefined) event.duration_ms = now - at;
  }
  renderer.handle(event);
  log?.handle(event);
});
rl.on('close', () => {
  renderer.close();
  log?.close();
});
