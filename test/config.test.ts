import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { account, accounts, credentials, loadConfig, resticEnv, tailscaleEnv } from '../src/config.ts';
import { UserError } from '../src/errors.ts';

const file = (yaml: string) => {
  const path = join(mkdtempSync(join(tmpdir(), 'node-ctl-config-')), 'node-ctl.yaml');
  writeFileSync(path, yaml);
  return path;
};
const env = { HOME: '/home/u' };

const FULL = `
hetzner:
  main: t1
  work: t2
contabo:
  cb: {client_id: ci, client_secret: cs, user: u@e, password: pw}
tailscale: {client_id: i, client_secret: tskey-client-s}
restic: {repository: "s3:test", password: p w, access_key_id: id, secret_access_key: secret}
ssh_public_key_file: ~/.ssh/k.pub
`;

test('accounts are the Hetzner tags, then the Contabo ones; each names its provider and its own credentials', () => {
  const c = loadConfig(file(FULL), env);
  expect(accounts(c)).toEqual(['main', 'work', 'cb']);
  expect(account(c, 'work')).toEqual({ tag: 'work', provider: 'hetzner' });
  expect(account(c, 'cb')).toEqual({ tag: 'cb', provider: 'contabo' });
  expect(credentials(c, 'work')).toEqual({ HCLOUD_TOKEN: 't2' });
  expect(credentials(c, 'cb')).toEqual({
    CNTB_OAUTH2_CLIENT_ID: 'ci',
    CNTB_OAUTH2_CLIENT_SECRET: 'cs',
    CNTB_OAUTH2_USER: 'u@e',
    CNTB_OAUTH2_PASS: 'pw',
  });
  expect(account(c, 'nope')).toBeUndefined();
});

test('loading puts no credential into the process environment; they are handed out per call', () => {
  const before = { ...process.env };
  const c = loadConfig(file(FULL), env);
  expect(process.env).toEqual(before);
  expect(tailscaleEnv(c)).toEqual({ TAILSCALE_OAUTH_CLIENT_ID: 'i', TAILSCALE_OAUTH_CLIENT_SECRET: 'tskey-client-s' });
  expect(resticEnv(c)).toEqual({
    RESTIC_REPOSITORY: 's3:test',
    RESTIC_PASSWORD: 'p w',
    AWS_ACCESS_KEY_ID: 'id',
    AWS_SECRET_ACCESS_KEY: 'secret',
  });
});

test('a tag under both hetzner and contabo is refused wherever it is looked up', () => {
  const c = loadConfig(file('hetzner: {main: t}\ncontabo: {main: {client_id: ci}}\n'), env);
  const lookup = () => account(c, 'main');
  expect(lookup).toThrow(UserError);
  expect(lookup).toThrow(`the tag main names a Hetzner and a Contabo account in ${c.file}; a tag must name one`);
  expect(() => credentials(c, 'main')).toThrow('a tag must name one');
});

test('the public key path expands a leading ~ and defaults to ~/.ssh/id_ed25519.pub; defaults per provider', () => {
  expect(loadConfig(file(FULL), env).sshPublicKeyFile).toBe('/home/u/.ssh/k.pub');
  const bare = loadConfig(file('hetzner: {}\n'), env);
  expect(bare.sshPublicKeyFile).toBe('/home/u/.ssh/id_ed25519.pub');
  expect(bare.defaults).toEqual({ type: 'cx23', location: 'nbg1', contaboType: 'V45', contaboLocation: 'EU' });
  const set = loadConfig(file('defaults: {type: cx33, location: fsn1, contabo: {type: V46, location: US-east}}\n'), env);
  expect(set.defaults).toEqual({ type: 'cx33', location: 'fsn1', contaboType: 'V46', contaboLocation: 'US-east' });
});

test('a missing or empty file is an empty configuration, as yq read it', () => {
  const missing = loadConfig('/nonexistent/node-ctl.yaml', env);
  expect(accounts(missing)).toEqual([]);
  expect(tailscaleEnv(loadConfig(file(''), env))).toEqual({ TAILSCALE_OAUTH_CLIENT_ID: '', TAILSCALE_OAUTH_CLIENT_SECRET: '' });
});

test('a file that is not YAML, or a value of the wrong shape, is a user error naming the file and the key', () => {
  const broken = file('hetzner: [');
  expect(() => loadConfig(broken, env)).toThrow(`${broken} is not valid YAML`);
  const list = file('hetzner: [a, b]\n');
  expect(() => loadConfig(list, env)).toThrow(`${list}: hetzner must be a mapping`);
  const nested = file('contabo:\n  cb: secret\n');
  expect(() => loadConfig(nested, env)).toThrow(`${nested}: contabo.cb must be a mapping`);
  const token = file('hetzner:\n  main: {a: 1}\n');
  expect(() => loadConfig(token, env)).toThrow(`${token}: hetzner.main must be a string`);
});

test('a scalar that YAML reads as a number is the string the file holds, as jq -r printed it', () => {
  const c = loadConfig(file('hetzner:\n  main: 12345\n'), env);
  expect(credentials(c, 'main')).toEqual({ HCLOUD_TOKEN: '12345' });
});
