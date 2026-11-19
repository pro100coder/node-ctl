// The machine a command acts on. A command that acts on one asks which on a terminal when its
// arguments name none; off one its own usage error stands. The states are those it can act on.
import { machineNames, readMachine } from './inventory.ts';
import { UserError } from './errors.ts';
import { menu, menuList, type Ui } from './ui.ts';

// targeted: whether the arguments already say what to act on, a name or --all, wherever it stands
// among the options; the value of --till and --type is no machine name.
export function targeted(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--all') return true;
    if (a === '--till' || a === '--type') {
      if (!(args[i + 1] ?? '-').startsWith('-')) i++;
    } else if (!a.startsWith('-')) return true;
  }
  return false;
}

// column -t: empty cells collapse, every cell but a row's last padded to its column's width plus two.
function columns(rows: string[][]): string[] {
  const cells = rows.map((r) => r.filter((c) => c !== ''));
  const widths: number[] = [];
  for (const r of cells) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, [...c].length)));
  return cells.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat(widths[i]! + 2 - [...c].length))).join(''));
}

// pick_machine: one of the machines in those states (any when none is given), its name; with all, the
// first line is --all, every one of them.
export async function pickMachine(ui: Ui, servers: string, command: string, states: string[], all?: string): Promise<string> {
  const rows = machineNames(servers).flatMap((name) => {
    const m = readMachine(servers, name);
    if (states.length && !states.includes(m.state ?? '')) return [];
    return [[name, m.state ?? '', m.type ?? '', m.location ?? '', m.account ?? '']];
  });
  if (!rows.length) throw new UserError(`no ${states.length ? `${states.join(' ')} ` : ''}machine for ${command}; node-ctl list`);
  const m = menuList(columns(rows).join('\n'));
  if (all) {
    m.values.unshift('--all');
    m.lines.unshift(` all: ${all}`);
  }
  const name = await menu(ui, 'machine', m);
  if (name === undefined) throw new UserError('aborted');
  if (!m.values.includes(name)) throw new UserError(`not a machine: ${name}`);
  return name;
}
