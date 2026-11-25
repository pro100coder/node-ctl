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

// A machine booted from its snapshot keeps the tailscale it was stopped with, however old.
test('provisioning updates an installed tailscale before it joins, and joins even when the update fails', () => {
  const fn = script.match(/^install_tailscale\(\) \{[\s\S]*?^\}$/m)?.[0];
  expect(fn).toBeDefined();
  for (const status of [0, 1]) {
    const dir = mkdtempSync(join(tmpdir(), 'node-ctl-provision-'));
    writeFileSync(join(dir, 'tailscale'), `#!/bin/sh\necho "tailscale $*" >> "${dir}/log"\n[ "$1" != update ] || exit ${status}\n`);
    chmodSync(join(dir, 'tailscale'), 0o755);
    const run = Bun.spawnSync(['bash', '-euo', 'pipefail', '-c', `${fn}\ninstall_tailscale`], {
      env: { PATH: `${dir}:/usr/bin:/bin`, TS_AUTHKEY: 'tskey-test' },
    });
    expect(run.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'log'), 'utf8')).toBe(
      `tailscale update --yes\n${status ? 'tailscale version\n' : ''}tailscale up --auth-key=tskey-test --hostname=` +
        Bun.spawnSync(['hostname']).stdout.toString(),
    );
  }
});
