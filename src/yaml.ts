// cfg_set: one value into node-ctl.yaml with its comments kept, as yq -i did; a missing file is seeded
// from the example first. Bun.YAML only parses, so the edit is made on the lines: the file is block
// YAML (the example, init and yq all write it so), and a flow mapping on the way is rewritten as a block.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import example from '../node-ctl.example.yaml' with { type: 'text' };

const KEY = /^( *)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s#'"{[\]}][^:#]*?) *:(?: |$)/;
const plain = (k: string) => (/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(k) ? k : JSON.stringify(k));
const unquote = (k: string) => (k.startsWith('"') ? (JSON.parse(k) as string) : k.startsWith("'") ? k.slice(1, -1).replace(/''/g, "'") : k);
const indentOf = (line: string) => line.length - line.trimStart().length;
const content = (line: string) => line.trim() !== '';

function block(value: unknown, pad: string): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length
      ? [`${pad}${plain(k)}:`, ...block(v, `${pad}  `)]
      : [`${pad}${plain(k)}: ${JSON.stringify(v ?? null)}`],
  );
}

// The end of the block a key line opens: the next line with content at its indent or less, blank lines before it left out.
function blockEnd(lines: string[], at: number, limit: number): number {
  const ind = indentOf(lines[at]!);
  let end = at + 1;
  while (end < limit && !(content(lines[end]!) && indentOf(lines[end]!) <= ind)) end++;
  while (end > at + 1 && !content(lines[end - 1]!)) end--;
  return end;
}

// shortcut: a comment at the end of a replaced line is dropped (yq kept it); none of the values init writes has one.
export function setIn(text: string, path: string[], value: string): string {
  const lines = text.split('\n');
  let start = 0;
  let end = lines.length;
  while (end > 0 && !content(lines[end - 1]!)) end--;
  let pad = '';
  path.forEach((key, depth) => {
    const leaf = depth === path.length - 1;
    let at = -1;
    let childIndent = -1;
    for (let i = start; i < end; i++) {
      const m = KEY.exec(lines[i]!);
      if (!m) continue;
      if (childIndent < 0) childIndent = m[1]!.length;
      if (m[1]!.length === childIndent && unquote(m[2]!) === key) {
        at = i;
        break;
      }
    }
    if (childIndent >= 0) pad = ' '.repeat(childIndent);
    if (at < 0) {
      lines.splice(end, 0, leaf ? `${pad}${plain(key)}: ${JSON.stringify(value)}` : `${pad}${plain(key)}:`);
      start = end + 1;
      end = start;
      pad += '  ';
      return;
    }
    const m = KEY.exec(lines[at]!)!;
    const rest = lines[at]!.slice(m[0].length).replace(/ #.*$/, '').trim();
    const inner = blockEnd(lines, at, end);
    if (leaf) {
      lines.splice(at, inner - at, `${m[1]}${m[2]}: ${JSON.stringify(value)}`);
      return;
    }
    let flow: unknown = null;
    if (rest.startsWith('{')) flow = Bun.YAML.parse(rest);
    const children = block(flow, `${m[1]}  `);
    lines.splice(at, 1, `${m[1]}${m[2]}:`, ...children);
    start = at + 1;
    end = inner + children.length;
    pad = `${m[1]}  `;
  });
  return lines.join('\n');
}

export function setValue(file: string, path: string[], value: string): void {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : example;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, setIn(text, path, value), { mode: 0o600 });
  renameSync(tmp, file);
}
