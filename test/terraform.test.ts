import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { Progress } from '../src/progress/progress.ts';
import { JsonRenderer } from '../src/progress/render/json.ts';
import type { ActionEvent } from '../src/progress/types.ts';
import { root, tfAccount, tfInit } from '../src/terraform.ts';
import { fakeBins, Sink } from './helpers.ts';

// A fake terraform that records, per call, its arguments and the account environment it ran with.
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'node-ctl-home-'));
  const calls = join(home, 'calls');
  const bins = fakeBins({
    terraform: `echo "$* | ws=\${TF_WORKSPACE-} acct=\${TF_VAR_account-} hc=\${HCLOUD_TOKEN-} cb=\${CNTB_OAUTH2_CLIENT_ID-}/\${CNTB_OAUTH2_CLIENT_SECRET-}/\${CNTB_OAUTH2_USER-}/\${CNTB_OAUTH2_PASS-} key=\${TF_VAR_ssh_public_key-} auto=\${TF_IN_AUTOMATION-}" >> ${calls}; echo planned`,
  });
  writeFileSync(join(home, 'key.pub'), 'ssh-ed25519 AAAA test\n');
  writeFileSync(
    join(home, 'node-ctl.yaml'),
    `hetzner: {main: t1}\ncontabo: {cb: {client_id: ci, client_secret: cs, user: u@e, password: pw}}\nssh_public_key_file: ${home}/key.pub\n`,
  );
  const config = loadConfig(join(home, 'node-ctl.yaml'), { HOME: home });
  const out = new Sink();
  const progress = new Progress(() => [new JsonRenderer(out)], new Sink());
  const read = () => readFileSync(calls, 'utf8').trim().split('\n');
  const events = () => out.lines().map((l) => JSON.parse(l) as ActionEvent);
  return { tf: { config, home, progress, env: { PATH: bins.PATH } }, read, events, home };
}

test('an account runs in its provider root and workspace, with its own credentials and no other account\'s', async () => {
  const { tf, read, home } = setup();
  await tfAccount(tf, 'main', ['apply', '-input=false', '-no-color', '-auto-approve']);
  await tfAccount(tf, 'cb', ['apply', '-input=false', '-no-color', '-auto-approve']);
  const applies = read().filter((l) => l.includes(' apply '));
  expect(applies).toEqual([
    `-chdir=${root(home, 'hetzner')} apply -input=false -no-color -auto-approve | ws=main acct=main hc=t1 cb=/// key=ssh-ed25519 AAAA test auto=1`,
    `-chdir=${root(home, 'contabo')} apply -input=false -no-color -auto-approve | ws=cb acct=cb hc= cb=ci/cs/u@e/pw key=ssh-ed25519 AAAA test auto=1`,
  ]);
  expect(process.env.HCLOUD_TOKEN).toBeUndefined();
  expect(process.env.TF_WORKSPACE).toBeUndefined();
});

test('the roots are unpacked first, and a root the unpack rewrote is initialised before its next command, once', async () => {
  const { tf, read, home } = setup();
  await tfAccount(tf, 'main', ['state', 'list']);
  await tfAccount(tf, 'main', ['output', '-json']);
  expect(readFileSync(join(home, 'terraform/main.tf'), 'utf8')).toContain('hcloud');
  expect(read().map((l) => l.split(' | ')[0])).toEqual([
    `-chdir=${root(home, 'hetzner')} init -input=false -no-color`,
    `-chdir=${root(home, 'hetzner')} state list`,
    `-chdir=${root(home, 'hetzner')} output -json`,
  ]);
  expect(read()[0]).toContain('ws= acct= hc= '); // init runs with no account's credentials
});

test('an explicit init (apply\'s first step) leaves nothing stale; captured output is the result, not log events', async () => {
  const { tf, read, events, home } = setup();
  await tfInit(tf, 'contabo');
  const r = await tfAccount({ ...tf, capture: true }, 'cb', ['output', '-json']);
  expect(r.stdout).toBe('planned\n');
  expect(read().map((l) => l.split(' | ')[0])).toEqual([
    `-chdir=${root(home, 'contabo')} init -input=false -no-color`,
    `-chdir=${root(home, 'contabo')} output -json`,
  ]);
  expect(events().filter((e) => e.event_type === 'log')).toHaveLength(0); // init had no open action, output was captured
});

test('a failed automatic init is the answer: the command it was for does not run', async () => {
  const { tf, home } = setup();
  const failing = fakeBins({ terraform: `echo "$*" >> ${home}/calls; case "$*" in *init*) exit 1 ;; esac` });
  const r = await tfAccount({ ...tf, env: { PATH: failing.PATH } }, 'main', ['apply']);
  expect(r.status).toBe(1);
  expect(readFileSync(join(home, 'calls'), 'utf8')).not.toContain('apply');
});

// The tailscale provider of both roots reads its OAuth client from the environment (versions.tf), and
// main.tf finds the machines in var.servers_dir: without either, an apply fails or plans every server away.
test('every account run gets the Tailscale OAuth client and the servers dir in use, and init gets neither', async () => {
  const home = mkdtempSync(join(tmpdir(), 'node-ctl-home-'));
  const calls = join(home, 'calls');
  const bins = fakeBins({
    terraform: `echo "$1 $2 | ts=\${TAILSCALE_OAUTH_CLIENT_ID-}/\${TAILSCALE_OAUTH_CLIENT_SECRET-} dir=\${TF_VAR_servers_dir-}" >> ${calls}`,
  });
  writeFileSync(join(home, 'node-ctl.yaml'), 'hetzner: {main: t1}\ncontabo: {cb: {client_id: ci, client_secret: cs, user: u@e, password: pw}}\ntailscale: {client_id: tsid, client_secret: tssecret}\n');
  const config = loadConfig(join(home, 'node-ctl.yaml'), { HOME: home });
  const tf = { config, home, servers: join(home, 'elsewhere'), progress: new Progress(() => [], new Sink()), env: { PATH: bins.PATH } };
  await tfInit(tf, 'hetzner');
  await tfAccount(tf, 'main', ['apply']);
  await tfAccount(tf, 'cb', ['apply']);
  const lines = readFileSync(calls, 'utf8').trim().split('\n').map((l) => l.replace(/^-chdir=\S+ /, ''));
  expect(lines).toEqual([
    'init | ts=/ dir=',
    `apply | ts=tsid/tssecret dir=${join(home, 'elsewhere')}`,
    'init | ts=/ dir=', // the contabo root is initialised before its first run
    `apply | ts=tsid/tssecret dir=${join(home, 'elsewhere')}`,
  ]);
});
