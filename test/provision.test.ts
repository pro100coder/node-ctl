import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = readFileSync(join(import.meta.dir, '../scripts/provision.sh'), 'utf8');

test('provisioning gives tailscaled and sshd a high CPU weight, once tailscaled is installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-ctl-provision-'));
  writeFileSync(join(dir, 'systemctl'), `#!/bin/sh\necho "$*" >> "${dir}/log"\n`);
  chmodSync(join(dir, 'systemctl'), 0o755);
  // Only the function runs: the rest of the script installs packages and needs root.
  const fn = script.match(/^prioritize_ssh\(\) \{[\s\S]*?^\}$/m)?.[0];
  expect(fn).toBeDefined();
  const run = Bun.spawnSync(['bash', '-euo', 'pipefail', '-c', `${fn}\nprioritize_ssh`], {
    env: { PATH: `${dir}:/usr/bin:/bin` },
  });
  expect(run.exitCode).toBe(0);
  expect(readFileSync(join(dir, 'log'), 'utf8')).toBe(
    'set-property tailscaled.service CPUWeight=1000\nset-property ssh.service CPUWeight=1000\n',
  );
  const main = script.slice(script.lastIndexOf('\nsetup_data\n'));
  expect(main.indexOf('\nprioritize_ssh')).toBeGreaterThan(main.indexOf('\ninstall_tailscale\n'));
});
