// Questions. Every question with a list of answers is a menu: on a terminal (stdin and stderr, 50
// columns at least) arrows (or j/k, PgUp/PgDn) move, enter picks, q cancels, in a window that follows
// the selection; anywhere else it is the numbered list and a typed answer, a number or the value
// itself. Only free text (a tag, a credential) is a plain ask. A port of the bash menu, menu_window,
// confirm and ask, down to what read -r did to an answer.
import { UserError } from './errors.ts';
import type { Out } from './progress/types.ts';

// Lines and keys from stdin, read as they are asked for: answers come one per question.
export class Input {
  readonly terminal: boolean;
  readonly #next: () => Promise<Uint8Array | undefined>;
  readonly #decoder = new TextDecoder();
  #buf = '';
  #ended = false;

  constructor(terminal: boolean, next: () => Promise<Uint8Array | undefined>) {
    this.terminal = terminal;
    this.#next = next;
  }

  async #more(): Promise<boolean> {
    if (this.#ended) return false;
    const chunk = await this.#next();
    if (!chunk) {
      this.#ended = true;
      this.#buf += this.#decoder.decode();
      return false;
    }
    this.#buf += this.#decoder.decode(chunk, { stream: true });
    return true;
  }

  // eof: no newline came, which made read fail (the text up to there is still returned).
  async line(): Promise<{ text: string; eof: boolean }> {
    for (;;) {
      const i = this.#buf.indexOf('\n');
      if (i >= 0) {
        const text = this.#buf.slice(0, i);
        this.#buf = this.#buf.slice(i + 1);
        return { text, eof: false };
      }
      if (!(await this.#more())) {
        const text = this.#buf;
        this.#buf = '';
        return { text, eof: true };
      }
    }
  }

  async key(): Promise<string | undefined> {
    while (!this.#buf) if (!(await this.#more())) return undefined;
    const ch = String.fromCodePoint(this.#buf.codePointAt(0)!);
    this.#buf = this.#buf.slice(ch.length);
    return ch;
  }
}

// The process's stdin, opened at the first question; the lock is released after every read, so a
// run that asked something still ends when its work does.
export function stdinInput(): Input {
  let stream: ReadableStream<Uint8Array> | undefined;
  return new Input(Boolean(process.stdin.isTTY), async () => {
    stream ??= Bun.stdin.stream();
    const reader = stream.getReader();
    try {
      const r = await reader.read();
      return r.done ? undefined : r.value;
    } finally {
      reader.releaseLock();
    }
  });
}

export interface Ui {
  input: Input;
  stderr: Out;
  yes: boolean; // --yes answers every confirmation
  home: string; // what a typed ~ stands for
  drawn: boolean; // stderr and stdin are a terminal of 50 columns at least
  color: boolean;
  columns: number;
  rows: number;
  suspend: () => void; // the live region closes before a question is drawn under it
  raw?: (on: boolean) => void; // the terminal hands over keys, unechoed
}

export interface Menu {
  values: string[]; // what each line answers
  lines: string[]; // what is shown for it
  header?: string; // a title row above the lines
  hint?: string; // what a mark in the lines means
  skip?: number[]; // lines (1-based) shown dimmed that the selection walks past
  any?: string; // a last line that asks for an answer the list does not have
}

// read -r: the prompt only when stdin is a terminal, leading and trailing blanks dropped.
async function read(ui: Ui, prompt: string): Promise<{ text: string; eof: boolean }> {
  if (ui.input.terminal) ui.stderr.write(prompt);
  const r = await ui.input.line();
  return { text: r.text.replace(/^[ \t]+|[ \t]+$/g, ''), eof: r.eof };
}

// "<value> <description>" lines into a menu's values and lines.
export function menuList(text: string): Pick<Menu, 'values' | 'lines'> {
  const rows = text.split('\n').filter((l) => l !== '');
  return { values: rows.map((l) => l.split(' ')[0]!), lines: rows.map((l) => ` ${l}`) };
}

// The answer; '' when nothing was picked (a number past the list, 0 with nothing to pick), undefined
// when cancelled. A typed answer that is not a number is returned as it is: the caller decides.
export async function menu(ui: Ui, question: string, m: Menu, preset = ''): Promise<string | undefined> {
  const n = m.values.length;
  const ok = (i: number) => !m.skip?.includes(i);
  let sel = 0; // the preset, else the first line that can be picked
  for (let i = 1; i <= n; i++) {
    if (!ok(i)) continue;
    if (sel === 0) sel = i;
    if (m.values[i - 1] === preset) sel = i;
  }
  if (sel === 0 && !m.any) return undefined;
  if (!ui.drawn) {
    if (m.header) ui.stderr.write(`\n     ${m.header}\n`);
    m.lines.forEach((l, i) => ui.stderr.write(`  ${String(i + 1).padStart(2)})${l}\n`));
    const r = await read(ui, `${question} or number [${sel ? m.values[sel - 1] : ''}]: `);
    if (r.eof) return undefined;
    const answer = r.text || String(sel);
    if (answer === '0') return '';
    if (/[^0-9]/.test(answer)) return answer;
    return m.values[Number(answer) - 1] ?? '';
  }
  ui.suspend();
  const lines = m.any ? [...m.lines, ` ${m.any}`] : m.lines;
  if (m.any && sel === 0) sel = lines.length;
  ui.raw?.(true);
  let picked: number | undefined;
  try {
    picked = await window(ui, question, { ...m, lines }, sel);
  } finally {
    ui.raw?.(false);
  }
  if (picked === undefined) return undefined;
  if (m.any && picked === lines.length) {
    const r = await read(ui, `  ${question}: `);
    return r.eof ? undefined : r.text;
  }
  return m.values[picked - 1];
}

// The window over the lines; the line picked, undefined when cancelled. Redrawn in place, so a line
// that would wrap is cut instead.
async function window(ui: Ui, question: string, m: Menu, start: number): Promise<number | undefined> {
  const [B, D, N, hl] = ui.color ? ['\x1b[1m', '\x1b[2m', '\x1b[0m', '\x1b[7m'] : ['', '', '', ''];
  const out = (s: string) => ui.stderr.write(s);
  const count = m.lines.length;
  const ok = (i: number) => !m.skip?.includes(i);
  const cut = (s: string) => [...s].slice(0, Math.max(ui.columns - 4, 0)).join('');
  let height = (ui.rows >= 10 ? ui.rows : 24) - 6; // no size to be had (a pty without one): 24
  height = Math.min(Math.max(height, 3), count);
  let sel = start;
  let top = sel - Math.floor(height / 2);
  let drawn = 0;
  out(`${B}?${N} ${question}\n`);
  const asked = Math.floor((question.length + 2 + ui.columns - 1) / ui.columns); // the rows it took, wrapped
  for (;;) {
    if (top > sel) top = sel;
    if (top <= sel - height) top = sel - height + 1;
    if (top < 1) top = 1;
    if (top > count - height + 1) top = count - height + 1;
    if (drawn) out(`\x1b[${drawn}A`);
    drawn = height + 1;
    if (m.header) {
      out(`   ${cut(m.header)}\x1b[K\n`);
      drawn++;
    }
    for (let i = top; i < top + height; i++) {
      const line = cut(m.lines[i - 1]!);
      if (i === sel) out(`${hl} > ${line}${hl && N}\x1b[K\n`);
      else if (ok(i)) out(`   ${line}\x1b[K\n`);
      else out(`   ${D}${line}${N}\x1b[K\n`);
    }
    out(`  ${D}${cut(`${m.hint ? `${m.hint} · ` : ''}↑↓ move · enter picks · q cancels (${sel}/${count})`)}${N}\x1b[K\n`);
    let step = 0;
    const key = await ui.input.key();
    if (key === undefined || key === 'q' || key === '\x04') return undefined; // ^D is a key here, not an end of input
    if (key === '\r' || key === '\n') break;
    if (key === '\x03') {
      // raw mode turned Ctrl+C into a key: it is still Ctrl+C
      ui.raw?.(false);
      process.kill(process.pid, 'SIGINT');
      return new Promise<never>(() => {});
    }
    if (key === 'k') step = -1;
    else if (key === 'j') step = 1;
    else if (key === '\x1b') {
      const esc = `${(await ui.input.key()) ?? ''}${(await ui.input.key()) ?? ''}`;
      if (esc === '[A') step = -1;
      else if (esc === '[B') step = 1;
      else if (esc === '[5' || esc === '[6') {
        await ui.input.key(); // the ~
        step = esc === '[5' ? -height : height;
      }
    }
    if (step === 0) continue;
    const dir = step > 0 ? 1 : -1;
    let i = Math.min(Math.max(sel + step, 1), count);
    while (i >= 1 && i <= count && !ok(i)) i += dir;
    if (i >= 1 && i <= count) sel = i; // nothing that way: stay where we are
  }
  // The answer replaces the window, so a run of questions reads as what was asked and answered
  out(`\x1b[${drawn + asked}A\x1b[J  ${question}: ${m.lines[sel - 1]!.replace(/^ /, '')}\n`);
  return sel;
}

// True for yes; no unless picked (or typed: y, yes), cancelling included.
export async function yesNo(ui: Ui, question: string): Promise<boolean> {
  const answer = await menu(ui, question, { values: ['no', 'yes'], lines: [' no', ' yes'] }, 'no');
  return answer === 'y' || answer === 'Y' || answer === 'yes';
}

// Asked on a terminal, answered by --yes anywhere else.
export async function confirm(ui: Ui, question: string, word: string): Promise<void> {
  if (ui.yes) return;
  if (!ui.input.terminal) throw new UserError('no terminal to confirm on; pass --yes');
  const { text } = await read(ui, `${question} Type ${word} to confirm: `);
  if (text !== word) throw new UserError('aborted');
}

// A free-text answer, the current value as its default; a secret is neither echoed nor shown.
export async function ask(ui: Ui, name: string, hint: string, current = '', secret = false): Promise<string> {
  ui.suspend();
  ui.stderr.write(`\n${hint}\n`);
  const prompt = !current ? `${name} [empty]: ` : secret ? `${name} [(set)]: ` : `${name} [${current}]: `;
  const r = secret && ui.input.terminal && ui.raw ? await hidden(ui, prompt) : await read(ui, prompt);
  if (r.eof) throw new UserError('aborted');
  if (secret) ui.stderr.write('\n');
  const value = r.text.replace(/^~/, ui.home);
  return value || current;
}

// read -s on a terminal: keys unechoed, backspace still edits.
async function hidden(ui: Ui, prompt: string): Promise<{ text: string; eof: boolean }> {
  ui.stderr.write(prompt);
  ui.raw!(true);
  let text = '';
  try {
    for (;;) {
      const k = await ui.input.key();
      if (k === undefined || k === '\x04') return { text, eof: true };
      if (k === '\r' || k === '\n') break;
      if (k === '\x03') {
        ui.raw!(false);
        process.kill(process.pid, 'SIGINT');
        return new Promise<never>(() => {});
      }
      if (k === '\x7f' || k === '\b') text = [...text].slice(0, -1).join('');
      else text += k;
    }
  } finally {
    ui.raw!(false);
  }
  return { text: text.replace(/^[ \t]+|[ \t]+$/g, ''), eof: false };
}
