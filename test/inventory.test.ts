import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { UserError } from '../src/errors.ts';
import { editMachine, ensureAccounts, exists, machineNames, readMachine, toJson, writeMachine } from '../src/inventory.ts';

const servers = () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'node-ctl-inv-')), 'servers');
  mkdirSync(dir);
  return dir;
};
const put = (dir: string, name: string, text: string) => writeFileSync(join(dir, `${name}.json`), text);
const config = (yaml: string) => {
  const file = join(mkdtempSync(join(tmpdir(), 'node-ctl-cfg-')), 'node-ctl.yaml');
  writeFileSync(file, yaml);
  return loadConfig(file, { HOME: '/u' });
};

// What jq 1.8 prints for {"a":"x\u007fy\u0001","b":[],"c":{},"d":[1,2],"e":{"/":8080},"f":1.5,"g":null,"h":"é/"} (jq .)
const JQ = `{
  "a": "x\\u007fy\\u0001",
  "b": [],
  "c": {},
  "d": [
    1,
    2
  ],
  "e": {
    "/": 8080
  },
  "f": 1.5,
  "g": null,
  "h": "é/"
}
`;

test('written JSON is what jq prints: two-space indent, empty containers inline, DEL escaped, a trailing newline', () => {
  expect(toJson({ a: 'x\u007fy\u0001', b: [], c: {}, d: [1, 2], e: { '/': 8080 }, f: 1.5, g: null, h: 'é/' })).toBe(JQ);
});

test('an edit keeps every field, unknown ones included, in their order, and appends a new one last, as a jq edit did', () => {
  const dir = servers();
  put(dir, 'dev1', '{"state":"running","account":"main","x_future":{"k":[1,"two"]},"type":"cx23","location":"nbg1","open_ports":[22],"funnel":{}}');
  editMachine(dir, 'dev1', (m) => {
    m.state = 'stopped';
    m.image = '42';
  });
  const text = readFileSync(join(dir, 'dev1.json'), 'utf8');
  expect(Object.keys(JSON.parse(text))).toEqual(['state', 'account', 'x_future', 'type', 'location', 'open_ports', 'funnel', 'image']);
  expect(text).toBe(
    toJson({ state: 'stopped', account: 'main', x_future: { k: [1, 'two'] }, type: 'cx23', location: 'nbg1', open_ports: [22], funnel: {}, image: '42' }),
  );
});

test('a write is atomic: the file is replaced by a rename, and no temporary file is left among the machines', () => {
  const dir = servers();
  put(dir, 'dev1', '{"state":"running"}');
  const before = statSync(join(dir, 'dev1.json')).ino;
  writeMachine(dir, 'dev1', { state: 'stopped' });
  expect(readdirSync(dir)).toEqual(['dev1.json']);
  expect(readMachine(dir, 'dev1').state).toBe('stopped');
  expect(statSync(join(dir, 'dev1.json')).ino).not.toBe(before); // a new file took the name: the old one was never truncated in place
});

test('an entry that is not JSON, or a known field of the wrong type, is a user error naming the file', () => {
  const dir = servers();
  put(dir, 'bad', '{"state":');
  expect(() => readMachine(dir, 'bad')).toThrow(`${join(dir, 'bad.json')} is not valid JSON`);
  put(dir, 'ports', '{"state":"running","open_ports":"22"}');
  expect(() => readMachine(dir, 'ports')).toThrow(`${join(dir, 'ports.json')}: open_ports must be a list of ports`);
});

test('machine names are the .json files, sorted; anything else in the directory is not a machine', () => {
  const dir = servers();
  for (const n of ['dev2', 'dev1']) put(dir, n, '{}');
  writeFileSync(join(dir, 'dev3.json.tmp'), '{}');
  writeFileSync(join(dir, 'notes.txt'), '');
  expect(machineNames(dir)).toEqual(['dev1', 'dev2']);
  expect(machineNames(join(dir, 'missing'))).toEqual([]);
});

test('exists refuses a machine with no entry, with no account, or of an account the configuration lacks', () => {
  const dir = servers();
  const c = config('hetzner: {main: t, work: t2}\n');
  put(dir, 'dev1', '{"state":"running","account":"main"}');
  put(dir, 'old', '{"state":"running"}');
  put(dir, 'gone', '{"state":"running","account":"nope"}');
  expect(exists(c, dir, 'dev1')).toEqual({ machine: { state: 'running', account: 'main' }, account: { tag: 'main', provider: 'hetzner' } });
  expect(() => exists(c, dir, 'nope')).toThrow(new UserError('no such machine: nope'));
  expect(() => exists(c, dir, 'old')).toThrow(
    `old has no account: add "account": "<tag>" to ${dir}/old.json (tags in ${c.file}: main work)`,
  );
  expect(() => exists(c, dir, 'gone')).toThrow(`no account nope in ${c.file}, which gone belongs to; ./node-ctl init`);
  expect(() => ensureAccounts(c, dir)).toThrow('no account nope'); // every machine, as apply guards the whole inventory
});
