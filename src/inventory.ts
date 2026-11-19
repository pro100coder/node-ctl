// servers/<name>.json, the source of truth Terraform derives every resource from. Fields this version
// does not know stay where they are: an entry is read as a whole object and only the fields a command
// sets change, as the jq edits did.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { account, accounts, type Config } from './config.ts';
import { UserError } from './errors.ts';

interface Machine {
  state?: string; // running | stopped | archived
  account?: string; // the tag of the account it lives in
  type?: string;
  location?: string;
  volume_size?: number; // GB, absent when it has no volume
  image?: string; // Hetzner: the disk snapshot; Contabo: the standard image
  open_ports?: number[];
  funnel?: Record<string, number>; // path → port
  started?: number; // epoch seconds of the last start
  stopping?: number; // pid of the stop that runs
  keep_disk?: boolean;
  cato?: { account: string; user: string };
  [field: string]: unknown;
}

// jq . and JSON.stringify(v, null, 2) differ only in DEL, which jq escapes; a raw DEL can only stand
// inside a string, so replacing it everywhere is safe.
// shortcut: numbers go through a JS double, so a literal like 1e3 or one past 2^53 is rewritten (jq kept it); no field holds one.
export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2).replace(/\x7f/g, '\\u007f')}\n`;
}

const file = (servers: string, name: string) => join(servers, `${name}.json`);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const SHAPES: Record<string, [string, (v: unknown) => boolean]> = {
  state: ['a string', (v) => typeof v === 'string'],
  account: ['a string', (v) => typeof v === 'string'],
  type: ['a string', (v) => typeof v === 'string'],
  location: ['a string', (v) => typeof v === 'string'],
  image: ['a string', (v) => typeof v === 'string'],
  volume_size: ['a number', (v) => typeof v === 'number'],
  started: ['a number', (v) => typeof v === 'number'],
  stopping: ['a number', (v) => typeof v === 'number'],
  keep_disk: ['true or false', (v) => typeof v === 'boolean'],
  open_ports: ['a list of ports', (v) => Array.isArray(v) && v.every((p) => Number.isInteger(p))],
  funnel: ['a map of paths to ports', (v) => isObject(v) && Object.values(v).every((p) => Number.isInteger(p))],
  cato: ['{account, user}', (v) => isObject(v) && typeof v.account === 'string' && typeof v.user === 'string'],
};

// null counts as absent: jq's // treated it so.
function parse(text: string, path: string): Machine {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new UserError(`${path} is not valid JSON`);
  }
  if (!isObject(v)) throw new UserError(`${path} is not valid JSON: not an object`);
  for (const [key, [what, ok]] of Object.entries(SHAPES)) {
    if (v[key] !== undefined && v[key] !== null && !ok(v[key])) throw new UserError(`${path}: ${key} must be ${what}`);
  }
  return v as Machine;
}

export function readMachine(servers: string, name: string): Machine {
  const path = file(servers, name);
  if (!existsSync(path)) throw new UserError(`no such machine: ${name}`);
  return parse(readFileSync(path, 'utf8'), path);
}

// A temporary file in the same directory, then a rename: a run cut short leaves the old entry or the new
// one, never half of either. The suffix keeps it out of the *.json the machines are listed by.
export function writeMachine(servers: string, name: string, machine: Machine): void {
  const path = file(servers, name);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, toJson(machine));
  renameSync(tmp, path);
}

export function editMachine(servers: string, name: string, change: (m: Machine) => void): Machine {
  const m = readMachine(servers, name);
  change(m);
  writeMachine(servers, name, m);
  return m;
}

// shortcut: plain code-unit order, which is the glob's for ASCII names; a non-ASCII name may sort apart from bash.
export function machineNames(servers: string): string[] {
  if (!existsSync(servers)) return [];
  return readdirSync(servers)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

// The entry and the account it lives in; refused with the bash messages before any action starts.
export function exists(c: Config, servers: string, name: string) {
  const machine = readMachine(servers, name);
  const tag = machine.account ?? '';
  if (!tag) {
    throw new UserError(`${name} has no account: add "account": "<tag>" to ${file(servers, name)} (tags in ${c.file}: ${accounts(c).join(' ')})`);
  }
  const found = account(c, tag);
  if (!found) throw new UserError(`no account ${tag} in ${c.file}, which ${name} belongs to; ./node-ctl init`);
  return { machine, account: found };
}

// A machine of an unknown account is in no workspace, and no apply would ever see it.
export function ensureAccounts(c: Config, servers: string): void {
  for (const name of machineNames(servers)) exists(c, servers, name);
}
