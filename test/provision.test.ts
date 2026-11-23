import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

// setup_swap against stubs: the machine's paths moved into a temporary directory, df answering `free` KiB.
const swap = (dir: string, free: number) => {
  const fn = script.match(/^setup_swap\(\) \{[\s\S]*?^\}$/m)?.[0];
  expect(fn).toBeDefined();
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, 'bin', name), `#!/bin/sh\necho "${name} $*" >> "${dir}/log"\n${body}\n`);
    chmodSync(join(dir, 'bin', name), 0o755);
  };
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, 'etc/sysctl.d'), { recursive: true });
  stub('df', `printf 'Avail\\n${free}\\n'`);
  stub('fallocate', `: > "$3"`);
  stub('mkswap', '');
  stub('sysctl', '');
  stub('swapon', `if [ "$1" = --show=NAME ]; then cat "${dir}/active" 2>/dev/null; else echo "$1" > "${dir}/active"; fi`);
  const body = fn!.replaceAll('/swapfile', `${dir}/swapfile`).replaceAll('/etc/', `${dir}/etc/`);
  return Bun.spawnSync(['bash', '-euo', 'pipefail', '-c', `${body}\nsetup_swap`], {
    env: { PATH: `${dir}/bin:/usr/bin:/bin` },
  });
};
const at = (dir: string, path: string) => (existsSync(join(dir, path)) ? readFileSync(join(dir, path), 'utf8') : '');

test('a new machine gets a 4G swapfile in fstab, switched on, with swappiness 10', () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-ctl-swap-'));
  expect(swap(dir, 50 * 1024 * 1024).exitCode).toBe(0);
  expect(at(dir, 'log')).toContain(`fallocate -l 4G ${dir}/swapfile`);
  expect(at(dir, 'log')).toContain(`mkswap ${dir}/swapfile`);
  expect(at(dir, 'active')).toBe(`${dir}/swapfile\n`);
  expect(at(dir, 'etc/fstab')).toBe(`${dir}/swapfile none swap sw 0 0\n`);
  expect(at(dir, 'etc/sysctl.d/99-swappiness.conf')).toBe('vm.swappiness=10\n');
  expect(at(dir, 'log')).toContain('sysctl -q vm.swappiness=10');
});

test('a machine booted from its snapshot keeps its swapfile: nothing is made or added twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-ctl-swap-'));
  swap(dir, 50 * 1024 * 1024);
  writeFileSync(join(dir, 'log'), '');
  expect(swap(dir, 50 * 1024 * 1024).exitCode).toBe(0);
  expect(at(dir, 'log')).not.toContain('fallocate');
  expect(at(dir, 'log')).not.toContain('mkswap');
  expect(at(dir, 'log')).not.toMatch(/^swapon (?!--show)/m);
  expect(at(dir, 'etc/fstab')).toBe(`${dir}/swapfile none swap sw 0 0\n`);
});

test('a root disk with under 6G free gets no swap, and provisioning goes on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-ctl-swap-'));
  const run = swap(dir, 6 * 1024 * 1024 - 1);
  expect(run.exitCode).toBe(0);
  expect(existsSync(join(dir, 'swapfile'))).toBe(false);
  expect(at(dir, 'etc/fstab')).toBe('');
  expect(at(dir, 'log')).not.toContain('fallocate');
});

test('swap is set up before the installers that need the memory', () => {
  const main = script.slice(script.lastIndexOf('\nsetup_data\n'));
  expect(main.indexOf('\nsetup_swap')).toBeGreaterThan(-1);
  expect(main.indexOf('\nsetup_swap')).toBeLessThan(main.indexOf('\ninstall_docker\n'));
});
