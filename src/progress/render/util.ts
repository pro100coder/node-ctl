export function fmtDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// A live line longer than the terminal wraps onto a second row, and the cursor-up that redraws the
// region then lands one row short, leaving the top of every frame behind. Colour codes take no room.
export function fit(line: string, columns: number): string {
  let visible = 0;
  let out = '';
  for (let i = 0; i < line.length; ) {
    const esc = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
    if (esc) {
      out += esc[0];
      i += esc[0].length;
      continue;
    }
    if (visible === columns - 1) return `${out}…${line.includes('\x1b[') ? '\x1b[0m' : ''}`;
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    out += ch;
    visible++;
    i += ch.length;
  }
  return out;
}
