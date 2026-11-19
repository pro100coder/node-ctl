import type { ActionEvent, Out, Renderer } from '../types.ts';
import { fit, fmtDuration } from './util.ts';

type State = 'pending' | 'active' | 'completed' | 'failed' | 'cancelled';
type Detail = { text: string; progress?: boolean } | { node: Node };
interface Node {
  name: string;
  index?: number;
  total?: number;
  state: State;
  startedAt: number;
  duration?: number;
  message?: string;
  details: Detail[];
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ACTIVE_TAIL = 3; // lines kept under a running action
const FAILED_TAIL = 5; // lines kept under a failed one, plus the reason
const ICON: Record<State, string> = { pending: '○', active: '', completed: '✓', failed: '✗', cancelled: '◌' };

interface TtyOptions {
  color?: boolean;
  columns?: number;
  now?: () => number;
}

// Live blocks like BuildKit: finished top-level actions scroll away as one line, the region below
// them (running and pending actions) is redrawn in place.
export class TtyRenderer implements Renderer {
  readonly #out: Out;
  readonly #nodes = new Map<string, Node>();
  readonly #roots: Node[] = [];
  #frozen = 0; // roots already written to the scrollback, never redrawn
  #live = 0; // lines of the region currently drawn below them
  #frame = 0;
  #scheduled?: NodeJS.Timeout;
  #closed = false;
  readonly #ticker: NodeJS.Timeout;
  readonly #color: boolean;
  readonly #columns: number;
  readonly #now: () => number;

  constructor(out: Out, opts: TtyOptions = {}) {
    this.#out = out;
    this.#color = opts.color ?? true;
    this.#columns = opts.columns ?? 80;
    this.#now = opts.now ?? Date.now;
    this.#ticker = setInterval(() => {
      this.#frame++;
      if (this.#roots.slice(this.#frozen).some((r) => this.#active(r))) this.#render();
    }, 80);
    this.#ticker.unref();
  }

  #node(e: ActionEvent): Node {
    let n = this.#nodes.get(e.action_id);
    if (n) return n;
    n = { name: e.action_name, index: e.index, total: e.total_steps, state: 'pending', startedAt: this.#now(), details: [] };
    this.#nodes.set(e.action_id, n);
    const parent = e.parent_action_id ? this.#nodes.get(e.parent_action_id) : undefined;
    if (parent) parent.details.push({ node: n });
    else this.#roots.push(n);
    return n;
  }

  handle(e: ActionEvent): void {
    const n = this.#node(e);
    switch (e.event_type) {
      case 'planned':
        break;
      case 'started':
        n.state = 'active';
        n.startedAt = this.#now();
        break;
      case 'log':
        n.details.push({ text: `${e.stream ? `${e.stream}| ` : ''}${e.message ?? ''}` });
        break;
      case 'warning':
        n.details.push({ text: this.#c(33, `⚠ ${e.message ?? ''}`) });
        break;
      case 'progress': {
        const text = `${e.current}/${e.total}${e.message ? ` ${e.message}` : ''}`;
        const last = n.details.length - 1;
        const prev = n.details[last];
        if (prev && 'progress' in prev && prev.progress) n.details[last] = { text, progress: true };
        else n.details.push({ text, progress: true });
        break;
      }
      case 'completed':
      case 'failed':
      case 'cancelled':
        n.state = e.event_type;
        n.duration = e.duration_ms;
        n.message = e.message;
        break;
    }
    this.#schedule();
  }

  #schedule(): void {
    if (this.#scheduled || this.#closed) return;
    this.#scheduled = setTimeout(() => {
      this.#scheduled = undefined;
      this.#render();
    }, 16); // ponytail: coalesces bursts to ~60 fps; the ticker keeps spinners moving in between
    this.#scheduled.unref();
  }

  #active(n: Node): boolean {
    return n.state === 'active' || n.details.some((d) => 'node' in d && this.#active(d.node));
  }

  #settled(n: Node): boolean {
    return n.state !== 'pending' && !this.#active(n);
  }

  #render(): void {
    if (this.#closed) return;
    let out = this.#live ? `\x1b[${this.#live}A\x1b[0J` : '';
    while (this.#frozen < this.#roots.length && this.#settled(this.#roots[this.#frozen]!)) {
      out += `${this.#block(this.#roots[this.#frozen]!, '').join('\n')}\n`;
      this.#frozen++;
    }
    const lines = this.#roots.slice(this.#frozen).flatMap((r) => this.#block(r, '')).map((l) => fit(l, this.#columns));
    out += lines.map((l) => `${l}\n`).join('');
    this.#live = lines.length;
    if (out) this.#out.write(out);
  }

  #block(n: Node, indent: string): string[] {
    const lines = [this.#header(n)];
    const tail = n.state === 'active' ? ACTIVE_TAIL : n.state === 'failed' ? FAILED_TAIL : 0;
    const details: Detail[] = tail ? n.details.slice(-tail) : [];
    if (n.state === 'failed' && n.message) details.push({ text: this.#c(31, n.message) });
    details.forEach((d, i) => {
      const last = i === details.length - 1;
      const branch = `${indent}${last ? '└─ ' : '├─ '}`;
      if ('node' in d) {
        const sub = this.#block(d.node, `${indent}${last ? '   ' : '│  '}`);
        lines.push(branch + sub[0], ...sub.slice(1));
      } else lines.push(branch + d.text);
    });
    return lines;
  }

  #header(n: Node): string {
    const icon = n.state === 'active' ? FRAMES[this.#frame % FRAMES.length]! : ICON[n.state];
    const step = n.index ? `[${n.index}/${n.total}] ` : '';
    const left = `${icon} ${step}${n.name}`;
    const width = Math.max(24, Math.min(50, this.#columns - 12));
    const duration = n.state === 'pending' ? '' : fmtDuration(n.duration ?? this.#now() - n.startedAt);
    const pad = duration ? ' '.repeat(Math.max(1, width - left.length)) : '';
    const colored = this.#c(n.state === 'completed' ? 32 : n.state === 'failed' ? 31 : n.state === 'active' ? 36 : 2, icon);
    const tag = n.state === 'cancelled' ? this.#c(33, '  cancelled') : '';
    return `${colored} ${step}${n.name}${pad}${this.#c(2, duration)}${tag}`;
  }

  #c(code: number, s: string): string {
    return this.#color ? `\x1b[${code}m${s}\x1b[0m` : s;
  }

  close(): void {
    if (this.#closed) return;
    clearInterval(this.#ticker);
    if (this.#scheduled) clearTimeout(this.#scheduled);
    this.#render();
    this.#closed = true;
  }
}
