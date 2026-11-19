import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIn, setValue } from '../src/yaml.ts';

const FILE = `# credentials
hetzner:
  main: "t1" # the first project

tailscale:
  client_id: "" # Settings -> OAuth clients
  client_secret: ""
`;

test('a value replaces the one at its path; every comment and blank line elsewhere stays, and the result parses to it', () => {
  const out = setIn(FILE, ['tailscale', 'client_secret'], 'tskey-client-x');
  expect(out).toBe(FILE.replace('client_secret: ""', 'client_secret: "tskey-client-x"'));
  expect(Bun.YAML.parse(out)).toEqual({ hetzner: { main: 't1' }, tailscale: { client_id: '', client_secret: 'tskey-client-x' } });
});

test('a missing key is added at the end of its block, before the blank line that closes it; a missing section at the end', () => {
  const out = setIn(FILE, ['hetzner', 'work'], 't2');
  expect(out).toContain('  main: "t1" # the first project\n  work: "t2"\n\ntailscale:');
  const deep = setIn(out, ['contabo', 'cb', 'user'], 'u@x');
  expect(Bun.YAML.parse(deep)).toMatchObject({ hetzner: { main: 't1', work: 't2' }, contabo: { cb: { user: 'u@x' } } });
  expect(deep.startsWith('# credentials\n')).toBe(true);
});

test('a flow mapping on the path becomes a block, keeping what it held; an empty one is just replaced', () => {
  const out = setIn('hetzner: {main: t1}\ncontabo: {}\n', ['hetzner', 'work'], 't2');
  expect(Bun.YAML.parse(out)).toEqual({ hetzner: { main: 't1', work: 't2' }, contabo: {} });
  expect(Bun.YAML.parse(setIn(out, ['contabo', 'cb', 'password'], "it's \"quoted\": #1"))).toMatchObject({ contabo: { cb: { password: "it's \"quoted\": #1" } } });
});

test('a key of the same name deeper down is not the one at the path', () => {
  const text = 'restic:\n  password: "a"\npassword: "top"\n';
  expect(Bun.YAML.parse(setIn(text, ['password'], 'b'))).toEqual({ restic: { password: 'a' }, password: 'b' });
});

test('a missing file is seeded from the example, comments included, and written for its owner only', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'node-ctl-yaml-')), 'node-ctl.yaml');
  setValue(file, ['hetzner', 'main'], 'tok');
  const text = readFileSync(file, 'utf8');
  expect(text).toContain(readFileSync(join(import.meta.dir, '..', 'node-ctl.example.yaml'), 'utf8').split('\n')[0]!);
  expect((Bun.YAML.parse(text) as { hetzner: Record<string, string> }).hetzner.main).toBe('tok');
  expect(statSync(file).mode & 0o777).toBe(0o600);
  writeFileSync(file, 'hetzner:\n  main: "a"\n');
  setValue(file, ['hetzner', 'main'], 'b');
  expect(readFileSync(file, 'utf8')).toBe('hetzner:\n  main: "b"\n');
});
