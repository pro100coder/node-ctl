// The one place every credential meets every way out of the process: children's command lines and
// node-ctl.log. Fake terraform, ssh and tailscale record their whole argv; a run goes through main,
// so the log is the real one with its tee and its renderer.
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { loadConfig, resticEnv } from '../src/config.ts';
import { remote } from '../src/ssh.ts';
import { tfAccount, tfInit } from '../src/terraform.ts';
import { fakeBins, Sink } from './helpers.ts';

const SECRETS = {
  hetzner: 'hcloud-SECRET-token',
  contaboSecret: 'cntb-SECRET-client',
  contaboPassword: 'cntb-SECRET-password',
  tailscale: 'tskey-client-SECRET',
  resticPassword: 'restic-SECRET-pw',
  s3: 's3-SECRET-key',
  gitKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nGIT-SECRET-KEY\n-----END OPENSSH PRIVATE KEY-----',
};

test('no credential reaches a child argv or node-ctl.log, whatever the command hands to terraform and ssh', async () => {
  const home = mkdtempSync(join(tmpdir(), 'node-ctl-secrets-'));
  const argv = join(home, 'argv');
  const dump = `for a in "$0" "$@"; do echo "$a" >> ${argv}; done`;
  const bins = fakeBins({ terraform: `${dump}; echo Apply complete`, ssh: `${dump}; cat > /dev/null; echo done`, tailscale: `${dump}; echo 100.64.0.9` });
  writeFileSync(
    join(home, 'node-ctl.yaml'),
    `hetzner: {main: ${SECRETS.hetzner}}
contabo: {cb: {client_id: ci, client_secret: ${SECRETS.contaboSecret}, user: u@e, password: ${SECRETS.contaboPassword}}}
tailscale: {client_id: i, client_secret: ${SECRETS.tailscale}}
restic: {repository: "s3:test", password: ${SECRETS.resticPassword}, access_key_id: id, secret_access_key: ${SECRETS.s3}}
ssh_public_key_file: ${home}/key.pub
`,
  );
  const config = loadConfig(join(home, 'node-ctl.yaml'), { HOME: home });
  const exports = Object.entries(resticEnv(config)).map(([k, v]) => `export ${k}='${v}'`).join('\n');
  const log = join(home, 'node-ctl.log');
  const env = { NODE_CTL_HOME: home, NODE_CTL_LOG: log, NODE_CTL_PROGRESS: 'plain' };

  const code = await main(['backup', 'dev1'], { stdout: new Sink(), stderr: new Sink(), env, terminal: false }, new Map([
    [
      'backup',
      async ({ progress }) => {
        const tf = { config, home, progress, env: { PATH: bins.PATH } };
        await progress.withAction('Apply Terraform', 'apply', async () => {
          await tfInit(tf, 'hetzner');
          await tfAccount(tf, 'main', ['apply', '-auto-approve']);
          await tfAccount(tf, 'cb', ['apply', '-auto-approve']);
        });
        await progress.withAction('Snapshot /data of dev1', 'backup', async () => {
          await remote('dev1', `${exports}\nrestic backup /data`, { progress, env: { PATH: bins.PATH }, app: '/nonexistent' });
          await remote('dev1', `install -m 600 /dev/stdin ~/.ssh/id_ed25519 <<'KEY'\n${SECRETS.gitKey}\nKEY`, { progress, env: { PATH: bins.PATH }, app: '/nonexistent' });
        });
      },
    ],
  ]));

  expect(code).toBe(0);
  const args = readFileSync(argv, 'utf8');
  const logged = readFileSync(log, 'utf8');
  expect(args).toContain('apply'); // the fakes did run
  expect(logged).toContain('Apply complete');
  for (const secret of Object.values(SECRETS)) {
    for (const piece of secret.split('\n')) {
      expect(args).not.toContain(piece);
      expect(logged).not.toContain(piece);
    }
  }
  expect(process.env.HCLOUD_TOKEN).toBeUndefined();
  expect(process.env.RESTIC_PASSWORD).toBeUndefined();
});
