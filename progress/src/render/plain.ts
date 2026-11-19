import type { ActionEvent, Renderer } from '../types.ts';
import { fmtDuration } from './util.ts';

// Local "YYYY-MM-DD HH:MM:SS", the form of the run header node-ctl writes with date '+%F %T'.
const stamp = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// Append-only lines for pipes, CI and logs: no ANSI, every line carries its action's label.
export class PlainRenderer implements Renderer {
  readonly #out: NodeJS.WritableStream;
  readonly #labels = new Map<string, string>();
  readonly #progress = new Map<string, { at: number; line?: string }>(); // ponytail: at most one progress line per second per action
  readonly #now: () => number;
  readonly #stamped: boolean; // a log has no clock of its own: a post-mortem needs to know when each line happened

  constructor(out: NodeJS.WritableStream, now: () => number = Date.now, stamped = false) {
    this.#out = out;
    this.#now = now;
    this.#stamped = stamped;
  }

  #label(e: ActionEvent): string {
    let label = this.#labels.get(e.action_id);
    if (!label) {
      const parentPath = e.parent_action_id ? this.#labels.get(e.parent_action_id)?.replace(/^\[|\]$/g, '') : undefined;
      const path = parentPath ? `${parentPath} > ${e.key}` : e.key;
      label = `[${e.index ? `${e.index}/${e.total_steps} ` : ''}${path}]`;
      this.#labels.set(e.action_id, label);
    }
    return label;
  }

  #write(label: string, text: string): void {
    this.#out.write(`${this.#stamped ? `${stamp(this.#now())} ` : ''}${label} ${text}\n`);
  }

  #flushProgress(id: string, label: string): void {
    const p = this.#progress.get(id);
    if (p?.line) this.#write(label, p.line);
    this.#progress.delete(id);
  }

  handle(e: ActionEvent): void {
    const label = this.#label(e);
    const d = e.duration_ms === undefined ? '' : ` duration=${fmtDuration(e.duration_ms)}`;
    switch (e.event_type) {
      case 'planned':
        return;
      case 'started':
        return this.#write(label, `START ${e.action_name}`);
      case 'log':
        return this.#write(label, `${e.stream ? `${e.stream}| ` : ''}${e.message ?? ''}`);
      case 'warning':
        return this.#write(label, `WARN ${e.message ?? ''}`);
      case 'progress': {
        const line = `${e.current}/${e.total}${e.message ? ` ${e.message}` : ''}`;
        const last = this.#progress.get(e.action_id);
        if (!last || this.#now() - last.at >= 1000) {
          this.#progress.set(e.action_id, { at: this.#now() });
          this.#write(label, line);
        } else last.line = line;
        return;
      }
      case 'completed':
        this.#flushProgress(e.action_id, label);
        return this.#write(label, `DONE${e.message ? ` ${e.message}` : ''}${d}`);
      case 'failed':
        this.#flushProgress(e.action_id, label);
        return this.#write(label, `FAILED ${e.message ?? ''}${d}`);
      case 'cancelled':
        this.#flushProgress(e.action_id, label);
        return this.#write(label, `CANCELLED${d}`);
    }
  }

  close(): void {}
}
