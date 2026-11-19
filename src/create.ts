// create: a new machine's inventory entry, then apply and wait_ready. Everything an option does not
// answer is asked on a terminal (account, tariff, location, volume, ports); off one the defaults of
// node-ctl.yaml stand. All of it is validated before the first action: a create refused there leaves
// nothing behind, and the same command retries cleanly.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { apply } from './apply.ts';
import { call, need, reach, setup, type Ctx, type Run } from './command.ts';
import { account as accountOf, accounts, type Config } from './config.ts';
import * as contabo from './contabo.ts';
import { UserError } from './errors.ts';
import { createRows, serverTypes } from './hetzner.ts';
import { writeMachine } from './inventory.ts';
import { askVolumeSize, portList } from './machine.ts';
import { waitReady } from './ready.ts';
import { pickType } from './resize.ts';
import * as tailscale from './tailscale.ts';
import { menu, menuList, read, type Ui } from './ui.ts';

const USAGE = '<name> [--account tag] [--type cx23] [--location nbg1] [--size GB] [--ports 22,80]';

// The account of a new machine; asked on a terminal when there are several.
async function pickAccount(ui: Ui, c: Config, given: string): Promise<string> {
  const tags = accounts(c);
  if (!tags.length) throw new UserError(`no cloud account in ${c.file}: ./node-ctl init hetzner, or ./node-ctl init contabo`);
  if (given) {
    if (!accountOf(c, given)) throw new UserError(`no account ${given} in ${c.file} (tags: ${tags.join(' ')})`);
    return given;
  }
  if (tags.length === 1) return tags[0]!;
  const provider = (tag: string) => (Object.hasOwn(c.hetzner, tag) ? 'hetzner' : 'contabo');
  if (!ui.input.terminal) throw new UserError(`several accounts (${tags.map((t) => `${provider(t)}/${t}`).join(' ')}): pass --account <tag>`);
  const tag = await menu(ui, 'account', menuList(tags.map((t) => `${t} (${provider(t)})`).join('\n')));
  if (tag === undefined) throw new UserError('aborted');
  if (!tags.includes(tag)) throw new UserError(`not an account: ${tag}`);
  return tag;
}

// "<value> <description>" lines: the value picked; one line is no question. With any, an answer that is
// not in the list is taken too (a list that is a shortcut, not the whole truth); without, it is ''.
async function pickFrom(ui: Ui, question: string, lines: string[], any = false): Promise<string> {
  if (lines.length <= 1) return lines[0]?.split(' ')[0] ?? '';
  const m = menuList(lines.join('\n'));
  const answer = await menu(ui, question, { ...m, ...(any ? { any: `another ${question}: type it` } : {}) });
  if (answer === undefined) throw new UserError('aborted');
  return any || m.values.includes(answer) ? answer : '';
}

// The tariff, then the location. Hetzner has a price list to read, so its types come with what they
// cost and where one can be created, and only a type several locations will take asks a second question.
// Contabo has neither prices nor a catalogue in its API (ADR-0018): its menu is the line-up its API spec
// documents and every region.
async function askTariff(run: Run, ui: Ui, tag: string, provider: string, location: string): Promise<{ type: string; location: string }> {
  if (provider === 'contabo') {
    const rows = await contabo.products(run.env);
    if (!rows.length) throw new UserError("could not read the products from Contabo's API spec; --type answers it");
    const type = await pickFrom(ui, 'product', rows, true);
    return { type, location: location || (await pickFrom(ui, 'region', contabo.REGIONS, true)) };
  }
  let rows;
  try {
    rows = await serverTypes(run.env, run.config.hetzner[tag] ?? '', createRows);
  } catch {
    throw new UserError('could not read the server types from the Hetzner API');
  }
  const picked = await pickType(ui, rows, '', 'LOCATIONS', 'LOCATIONS = where one can be created now');
  if (picked === undefined) throw new UserError('aborted');
  const row = rows.find((r) => r.name === picked);
  if (!row) throw new UserError('not a type on offer');
  const locs = row.last.split(',');
  if (location) {
    if (!locs.includes(location)) throw new UserError(`${location} cannot take a ${row.name} right now, only ${locs.join(', ')} can`);
    return { type: row.name, location };
  }
  const chosen = await pickFrom(ui, 'location', locs);
  if (!chosen) throw new UserError(`not a location that can take a ${row.name}`);
  return { type: row.name, location: chosen };
}

// tailscale-rm.sh: a stale node that squats the name would rename the new machine to <name>-1.
function freeTailnetName(run: Run, name: string): Promise<boolean> {
  return call(run.progress, 'Free the tailnet name', 'api', () => tailscale.removeNode(run.env, run.config.tailscale, name));
}

export const create = async (ctx: Ctx): Promise<number | void> => {
  const run = setup(ctx);
  const { p, config, progress } = run;
  const ui = ctx.ui;
  if (!(await reach(run))) return 1;
  let args = ctx.args;
  let name = '';
  if (args[0] && !args[0].startsWith('--')) [name, ...args] = args;
  else if (ui.input.terminal) {
    // no name: a terminal asks it, like everything an option does not answer
    const r = await read(ui, 'Name of the new machine: ');
    if (r.eof) throw new UserError('aborted');
    name = r.text;
  }
  need('create', name, USAGE);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new UserError('name must be lowercase letters, digits and dashes');
  const file = join(p.servers, `${name}.json`);
  if (await Bun.file(file).exists()) {
    if (args.length) {
      throw new UserError(`${name} exists; options only apply to a new machine (edit ${file} and ./node-ctl apply, or ./node-ctl destroy ${name} first)`);
    }
    // a machine that exists is started, whatever its provider does for that
    throw new UserError('start is not implemented yet'); // T05c: the start command goes here
  }
  const o = { account: '', type: '', location: '', size: '', ports: '' };
  while (args.length) {
    let [opt, ...rest] = args;
    const eq = opt!.indexOf('=');
    if (opt!.startsWith('--') && eq > 0) [opt, rest] = [opt!.slice(0, eq), [opt!.slice(eq + 1), ...rest]];
    if (!rest.length) throw new UserError(`${opt} needs a value`);
    const key = opt!.slice(2);
    if (!opt!.startsWith('--') || !Object.hasOwn(o, key)) throw new UserError(`unknown option: ${opt}`);
    o[key as keyof typeof o] = key === 'ports' ? rest[0]!.replaceAll(',', ' ') : rest[0]!;
    args = rest.slice(1);
  }
  const tag = await pickAccount(ui, config, o.account);
  const provider = accountOf(config, tag)!.provider;
  let { type, location } = o;
  if (!type && ui.input.terminal) ({ type, location } = await askTariff(run, ui, tag, provider, location));
  type ||= provider === 'contabo' ? config.defaults.contaboType : config.defaults.type;
  location ||= provider === 'contabo' ? config.defaults.contaboLocation : config.defaults.location;
  let size = o.size;
  let image = '';
  if (provider === 'contabo') {
    if (size && size !== '0') throw new UserError('a volume is Hetzner-only: Contabo has no block storage to attach (ADR-0018)');
    size = '0';
    try {
      image = await contabo.image(run.env, config.contabo[tag]!);
    } catch (e) {
      ctx.io.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      throw new UserError(`could not look up the Contabo image for ${name}; ./node-ctl check`);
    }
  } else if (!size) size = await askVolumeSize(ui);
  let ports = o.ports;
  if (!ports && ui.input.terminal) ports = (await read(ui, 'Public TCP ports besides 22 (e.g. 80,443), empty for none: ')).text.replaceAll(',', ' ');
  if (!/^[0-9]+$/.test(size)) throw new UserError(`not a volume size in GB: ${size}`);
  mkdirSync(p.servers, { recursive: true });
  const open = portList(ports.split(/[ \t\n]+/).filter(Boolean));
  progress.plan('Free the tailnet name', 'Write inventory', 'Apply Terraform', `Wait for ${name}`);
  if (!(await freeTailnetName(run, name))) throw new UserError(`could not confirm ${name} is free on the tailnet; fix Tailscale API access, then retry`);
  const gb = Number(size);
  await progress.withAction('Write inventory', 'inventory', () => {
    writeMachine(p.servers, name, {
      state: 'running',
      started: Math.floor(Date.now() / 1000),
      account: tag,
      type,
      location,
      ...(gb > 0 ? { volume_size: gb } : {}),
      ...(image ? { image } : {}),
      open_ports: open,
      funnel: {},
    });
    progress.log(`${file}: ${type} ${location} ports ${open.join(',')}${gb ? ` volume ${gb}G` : ''}, account ${tag}`);
  });
  await apply(config, p, progress, run.env);
  if (!(await waitReady(run, name))) return 1;
  ctx.io.stdout.write(`ready: ./node-ctl ssh ${name}\n`);
};
