// resize moves a running machine into another type; start --type boots a stopped one into it from its
// snapshot. Either way the type has to hold the disk and be on offer in the location, so both ask the
// same list and refuse the same way, before the first action. The disk follows the type only on
// request (keep_disk): a grown disk never shrinks, so every type with a smaller one is out from then on.
import { doApply, updateSshConfig } from './apply.ts';
import { call, need, setup, target, type Ctx, type Run } from './command.ts';
import { UserError } from './errors.ts';
import { diskOf, moveRows, powerOn, serverTypes, type TypeRow } from './hetzner.ts';
import { editMachine, exists, readMachine } from './inventory.ts';
import { menu, yesNo, type Ui } from './ui.ts';

const s = (v: unknown) => String(v);

// One aligned line, the machine's own type marked.
function typeRow(r: TypeRow, current: string): string {
  const mark = r.name === current ? '*' : ' ';
  return ` ${mark} ${r.name.padEnd(12)} ${s(r.cores).padStart(5)} ${s(r.memory).padStart(5)}G ${r.cpu.padStart(10)} ${s(r.disk).padStart(5)}G ${r.price.toFixed(2).padStart(9)} ${r.last}`;
}

// Hetzner offers more types than a terminal has rows, which is what the menu's window is for. Types it
// will not take right now stay in the list, dimmed and marked, but the selection walks past them: they
// are priced there and refusing one silently is what leaves a machine stopped. The chosen type (a typed
// one as it is); undefined when cancelled.
export function pickType(ui: Ui, rows: TypeRow[], current: string, last: string, hint: string): Promise<string | undefined> {
  const header = `   ${'TYPE'.padEnd(12)} ${'CORES'.padStart(5)} ${'RAM'.padStart(6)} ${'CPU'.padStart(10)} ${'DISK'.padStart(6)} ${'EUR/mo'.padStart(9)} ${last}`;
  const skip = rows.flatMap((r, i) => (r.last === 'no' ? [i + 1] : []));
  return menu(ui, 'type', { values: rows.map((r) => r.name), lines: rows.map((r) => typeRow(r, current)), header, hint, skip }, current);
}

const token = (run: Run, tag: string | undefined) => run.config.hetzner[tag ?? ''] ?? '';

interface Choice {
  current: string;
  location: string;
  disk: number;
  rows: TypeRow[];
  type: string; // the current one when nothing changes
}

// The type a machine moves to (resize) or starts as (start --type): the one given, or asked; refused
// with the reason when that type cannot take it.
export async function chooseType(run: Run, ui: Ui, name: string, verb: 'resize' | 'start', given: string): Promise<Choice> {
  const m = readMachine(run.p.servers, name);
  const [how, opt] = verb === 'start' ? ['start as', ' --type'] : ['move to', ''];
  const current = m.type ?? '';
  const location = m.location ?? '';
  const t = token(run, m.account);
  const found = await diskOf(run.env, t, name, m.image);
  let rows: TypeRow[];
  try {
    rows = await serverTypes(run.env, t, (types) => moveRows(types, location, current, found));
  } catch {
    throw new UserError('could not read the server types from the Hetzner API');
  }
  const disk = found ?? rows.find((r) => r.name === current)?.disk ?? 0;
  const movable = rows.filter((r) => r.last === 'yes').map((r) => r.name);
  if (!movable.length) {
    throw new UserError(`Hetzner offers no type in ${location} that takes the ${disk}G disk of ${name} right now; another location needs archive + create`);
  }
  let type = given;
  if (!type) {
    if (verb === 'start') {
      run.progress.info(`${name} is ${current} in ${location}; it boots from a ${disk}G snapshot, so a type with a smaller
disk, or one ${location} will not create right now, is marked no and the selection walks past it.`);
    } else {
      run.progress.info(`${name} is ${current} in ${location} with a ${disk}G disk; the machine reboots into the new type.
A type with a bigger disk can grow it (asked next; a grown disk never shrinks); one with a smaller disk,
or one Hetzner will not move a server into right now, is marked no and the selection walks past it.`);
    }
    // the heading says what a pick would actually do to that machine
    const [last, hint] =
      m.state === 'running'
        ? ['MOVE', '* current · no = Hetzner will not move it there now']
        : ['CREATE', '* current · no = too small for the snapshot, or not sold there now'];
    const picked = await pickType(ui, rows, current, last, hint);
    if (picked === undefined) throw new UserError(`nothing to read a type from; pass one: ./node-ctl ${verb} ${name}${opt} <type>`);
    type = picked;
  }
  const choice = { current, location, disk, rows, type };
  if (type === current || movable.includes(type)) return choice;
  if (rows.some((r) => r.name === type)) {
    throw new UserError(`${name} cannot ${how} ${type} in ${location}: its disk is smaller than ${disk}G, or Hetzner will not take it there right now (no in the list)`);
  }
  throw new UserError(`${name} cannot ${how} '${type}' in ${location}; ./node-ctl ${verb} ${name}${opt} lists the types that work`);
}

// Hetzner resizes a powered-off server, which Terraform does: the machine reboots, the tailnet address survives.
export const resize = async (ctx: Ctx): Promise<number | void> => {
  const run = setup(ctx);
  const { p, config, progress, env } = run;
  const [name, ...rest] = await target(ctx, p.servers, 'resize', ['running', 'stopped']);
  need('resize', name, '<name> [type] [--grow-disk|--keep-disk]');
  let given = '';
  let grow: boolean | undefined;
  for (const a of rest) {
    if (a === '--grow-disk') grow = true;
    else if (a === '--keep-disk') grow = false;
    else given = a;
  }
  const { account } = exists(config, p.servers, name!);
  if (account.provider === 'contabo') throw new UserError('resize is Hetzner-only: a Contabo upgrade changes the contract, not the machine (ADR-0018)');
  const { current, disk, rows, type } = await chooseType(run, ctx.ui, name!, 'resize', given);
  if (type === current) {
    ctx.io.stdout.write(`${name} is already ${current}\n`);
    return;
  }
  const grown = rows.find((r) => r.name === type)?.disk ?? 0;
  if (!(grown > disk)) grow = false; // nothing to grow into
  if (grow === undefined && ctx.ui.input.terminal) {
    grow = await yesNo(ctx.ui, `Grow the disk from ${disk}G to ${grown}G? It never shrinks again, so no smaller type afterwards`);
  }
  if (readMachine(p.servers, name!).state !== 'running') progress.info(`${name} is not running: the new type applies at the next start`);
  progress.plan('Write inventory', 'Apply Terraform');
  const write = (t: string, keep?: boolean) =>
    progress.withAction('Write inventory', 'inventory', () =>
      editMachine(p.servers, name!, (m) => {
        m.type = t;
        if (keep !== undefined) m.keep_disk = keep;
      }),
    );
  await write(type, grow !== true);
  // Terraform stops the machine before it changes the type, and a type Hetzner cannot place
  // (resource_unavailable: sold out in that location) leaves it stopped for good. Put the type back and boot it.
  if (!(await progress.withAction('Apply Terraform', 'apply', () => doApply(config, p, progress, env)))) {
    await write(current);
    if (!(await call(progress, `Power ${name} on again`, 'poweron', () => powerOn(env, token(run, account.tag), name!)))) {
      progress.warn(`could not power ${name} on; do it in the Hetzner console`);
    }
    throw new UserError(`${name} stayed on ${current}: Hetzner refused ${type} (see the apply output above)`);
  }
  await updateSshConfig(p.servers, p.sshConfig, progress, env);
  ctx.io.stdout.write(`${name}: ${current} -> ${type}${grow === true ? `, disk ${grown}G` : ''}\n`);
};
