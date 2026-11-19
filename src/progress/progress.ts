// Every operational line belongs to an action (ADR-0010). Actions nest through a stack of ids; a step
// declared by plan() keeps its id when it starts, so its [n/N] survives. Events are calls in this
// process: the fields a producer used to leave to the renderer process (seq, timestamp, duration) are
// filled in here.
import { appendFileSync } from 'node:fs';
import { UserError } from '../errors.ts';
import { JsonRenderer } from './render/json.ts';
import { PlainRenderer } from './render/plain.ts';
import { TtyRenderer } from './render/tty.ts';
import type { ActionEvent, EventType, Out, Renderer } from './types.ts';

export type Mode = 'tty' | 'plain' | 'json';

// A body that fails without dying: its action is failed with this message, and withAction answers
// false so the caller decides (bash: a with_action body that returns non-zero, FAIL_MESSAGE its reason).
export class ActionFailure extends Error {
  readonly status: number;

  constructor(message = '', status = 1) {
    super(message);
    this.status = status;
  }
}

// The short label of the plain renderer: the first word, lowercase. Character by character like the
// bash slug under a UTF-8 locale (tr), so a non-ASCII name gets the same label as before.
export function slug(name: string): string {
  let s = name.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/[^a-z0-9\n]/gu, '-');
  if (s.startsWith('-')) s = s.slice(1);
  return s.split('-')[0] || 'action';
}

// auto is tty only when stderr is a terminal outside CI; a dialogue (init, accounts) cannot share the
// screen with a live region, so it is plain unless the raw stream was asked for.
export function resolveMode(requested: string, at: { terminal: boolean; ci: boolean; dialogue: boolean }): Mode {
  let mode: Mode;
  if (requested === 'auto') mode = at.terminal && !at.ci ? 'tty' : 'plain';
  else if (requested === 'tty' || requested === 'plain' || requested === 'json') mode = requested;
  else throw new UserError(`--progress must be auto, tty, plain or json, got: ${requested}`);
  return at.dialogue && mode !== 'json' ? 'plain' : mode;
}

// json goes to the file NODE_CTL_EVENTS names when there is one (the bats suite reads it there, and
// stderr stays what a user would see), to stderr otherwise.
export function renderersFor(
  mode: Mode,
  stderr: Out,
  opts: { events?: string; color: boolean; columns: number; log?: Out },
): Renderer[] {
  // whatever the screen gets, the log gets every line, plain and stamped with the time
  const log = opts.log ? [new PlainRenderer(opts.log, Date.now, true)] : [];
  if (mode === 'json') {
    const path = opts.events;
    return [new JsonRenderer(path ? { write: (text: string) => appendFileSync(path, text) } : stderr), ...log];
  }
  if (mode === 'tty') return [new TtyRenderer(stderr, { color: opts.color, columns: opts.columns }), ...log];
  return [new PlainRenderer(stderr), ...log];
}

interface Action {
  name: string;
  key: string;
  parent: string | null;
  index?: number;
  total?: number;
}

type Extra = Pick<ActionEvent, 'message' | 'stream' | 'current' | 'total'>;

export class Progress {
  readonly #open: () => Renderer[];
  readonly #stderr: Out;
  readonly #now: () => number;
  #renderers?: Renderer[]; // opened by the first event: a run without actions draws nothing
  readonly #stack: string[] = []; // open action ids, innermost last
  readonly #actions = new Map<string, Action>();
  readonly #planned: { parent: string | null; name: string; id: string }[] = [];
  readonly #started = new Map<string, number>();
  #aid = 0;
  #seq = 0;

  constructor(open: () => Renderer[], stderr: Out, now: () => number = Date.now) {
    this.#open = open;
    this.#stderr = stderr;
    this.#now = now;
  }

  get #current(): string | null {
    return this.#stack.at(-1) ?? null;
  }

  #emit(id: string, event_type: EventType, extra: Extra = {}): void {
    const a = this.#actions.get(id)!;
    const now = this.#now();
    const event: ActionEvent = {
      action_id: id,
      parent_action_id: a.parent,
      action_name: a.name,
      key: a.key,
      ...(a.index === undefined ? {} : { index: a.index, total_steps: a.total }),
      event_type,
      ...extra,
      seq: ++this.#seq,
      timestamp: new Date(now).toISOString(),
    };
    if (event_type === 'started') this.#started.set(id, now);
    const at = this.#started.get(id);
    if ((event_type === 'completed' || event_type === 'failed' || event_type === 'cancelled') && at !== undefined) event.duration_ms = now - at;
    this.#renderers ??= this.#open();
    for (const r of this.#renderers) r.handle(event);
  }

  // Pending steps under the current action, numbered [n/N].
  plan(...names: string[]): void {
    const parent = this.#current;
    names.forEach((name, i) => {
      const id = `a${++this.#aid}`;
      this.#actions.set(id, { name, key: slug(name), parent, index: i + 1, total: names.length });
      this.#planned.push({ parent, name, id });
      this.#emit(id, 'planned');
    });
  }

  // started, then completed or failed. An ActionFailure fails this action and answers false; anything
  // else (a UserError above all) leaves it open for settle() at the top level, as die does.
  async withAction(name: string, key: string, body: () => unknown): Promise<boolean> {
    const parent = this.#current;
    let id = this.#planned.findLast((p) => p.parent === parent && p.name === name)?.id;
    if (!id) id = `a${++this.#aid}`;
    this.#actions.set(id, { ...this.#actions.get(id), name, key, parent });
    this.#stack.push(id);
    this.#emit(id, 'started');
    try {
      await body();
    } catch (e) {
      if (!(e instanceof ActionFailure)) throw e;
      this.#stack.pop();
      this.#emit(id, 'failed', { message: e.message || `${name} exited with status ${e.status}` });
      return false;
    }
    this.#stack.pop();
    this.#emit(id, 'completed');
    return true;
  }

  log(message: string, stream?: 'stdout' | 'stderr'): void {
    const id = this.#current;
    if (id) this.#emit(id, 'log', stream ? { stream, message } : { message });
  }

  progress(current: number, total: number, message?: string): void {
    const id = this.#current;
    if (id) this.#emit(id, 'progress', message ? { current, total, message } : { current, total });
  }

  // Narration: an event of the open action, or a line on stderr when none is open (stdout is for results).
  info(message: string): void {
    if (this.#current) this.log(message);
    else this.#stderr.write(`${message}\n`);
  }

  warn(message: string): void {
    const id = this.#current;
    if (id) this.#emit(id, 'warning', { message });
    else this.#stderr.write(`node-ctl: ${message}\n`);
  }

  // Every open action, innermost first: failed (the innermost with the reason, each parent with the
  // name of the child that failed it) or cancelled (Ctrl+C).
  settle(how: 'failed' | 'cancelled', message = ''): void {
    let inner = '';
    for (let id = this.#stack.pop(); id; id = this.#stack.pop()) {
      if (how === 'cancelled') this.#emit(id, 'cancelled');
      else {
        this.#emit(id, 'failed', { message: inner || message });
        inner = `${this.#actions.get(id)!.name} failed`;
      }
    }
  }

  // The final frame lands before whatever the caller prints next.
  close(): void {
    for (const r of this.#renderers ?? []) r.close();
  }

  // A question shares the terminal with the live region, which would tear it apart: the renderers
  // are closed, and the next event opens new ones (bash: close_renderer, reopened by the next emit).
  suspend(): void {
    this.close();
    this.#renderers = undefined;
  }
}
