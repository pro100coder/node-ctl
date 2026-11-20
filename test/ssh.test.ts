import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Progress } from '../src/progress/progress.ts';
import { JsonRenderer } from '../src/progress/render/json.ts';
import type { ActionEvent } from '../src/progress/types.ts';
import { addr, ensureKey, remote, tssh } from '../src/ssh.ts';
import { fakeBins, Sink } from './helpers.ts';

const NO_APP = '/nonexistent/Tailscale';
const recorded = () => {
  const out = new Sink();
  const stderr = new Sink();
  const p = new Progress(() => [new JsonRenderer(out)], stderr);
  return { p, stderr, events: () => out.lines().map((l) => JSON.parse(l) as ActionEvent) };
};

test('tssh checks and records no host key, and keeps ssh quiet but for errors, as the bash tssh did', () => {
  expect(tssh('-o', 'BatchMode=yes', 'node-ctl-user@dev1', 'true')).toEqual([
    'ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR',
    '-o', 'BatchMode=yes', 'node-ctl-user@dev1', 'true',
  ]);
});

test('addr asks the Tailscale CLI for the tailnet address, and falls back to the bare name for MagicDNS', async () => {
  const knows = fakeBins({ tailscale: '[ "$1 $2 $3" = "ip -4 dev1" ] && echo 100.64.0.7' });
  expect(await addr('dev1', { PATH: knows.PATH }, NO_APP)).toBe('100.64.0.7');
  const unknown = fakeBins({ tailscale: 'exit 1' });
  expect(await addr('dev1', { PATH: unknown.PATH }, NO_APP)).toBe('dev1');
  const none = fakeBins({});
  expect(await addr('dev1', { PATH: none.PATH }, NO_APP)).toBe('dev1');
});

test('remote pipes the script to sudo bash -s on the machine: the command line carries nothing of it', async () => {
  const dump = mkdtempSync(join(tmpdir(), 'node-ctl-dump-'));
  const bins = fakeBins({
    tailscale: 'echo 100.64.0.7',
    ssh: `printf '%s\\n' "$@" > ${dump}/argv; cat > ${dump}/stdin; echo remote said hi`,
  });
  const { p, events } = recorded();
  const script = 'export RESTIC_PASSWORD=hunter2\nrestic snapshots\n';
  await p.withAction('Snapshot', 'backup', () => remote('dev1', script, { progress: p, env: { PATH: bins.PATH }, app: NO_APP }));
  expect(readFileSync(join(dump, 'argv'), 'utf8').trim().split('\n')).toEqual([
    ...tssh('node-ctl-user@100.64.0.7', 'sudo', 'bash', '-s').slice(1),
  ]);
  expect(readFileSync(join(dump, 'stdin'), 'utf8')).toBe(script);
  expect(events().find((e) => e.event_type === 'log')).toMatchObject({ action_name: 'Snapshot', stream: 'stdout', message: 'remote said hi' });
});

// ssh-add as a fake: -L lists $AGENT_KEYS, -l exits $AGENT_RC, adding records its arguments.
const agent = (keys: string, rc: number) => {
  const dump = mkdtempSync(join(tmpdir(), 'node-ctl-agent-'));
  const bins = fakeBins({
    'ssh-add': `case $1 in -L) echo "${keys}" ;; -l) exit ${rc} ;; *) echo "$@" >> ${dump}/added ;; esac`,
  });
  const key = join(dump, 'id_ed25519');
  writeFileSync(key, 'PRIVATE');
  writeFileSync(`${key}.pub`, 'ssh-ed25519 AAAAkey me@host\n');
  const added = () => {
    try {
      return readFileSync(join(dump, 'added'), 'utf8');
    } catch {
      return '';
    }
  };
  return { env: { PATH: bins.PATH }, pub: `${key}.pub`, key, added };
};

test('ensure_key loads the private key into ssh-agent only when the agent lacks it, with the Keychain on macOS', async () => {
  const loaded = agent('ssh-ed25519 AAAAkey other-comment', 0);
  expect(await ensureKey(recorded().p, loaded.pub, loaded.env, 'darwin')).toBe(true);
  expect(loaded.added()).toBe('');

  const mac = agent('', 1);
  const { p, stderr } = recorded();
  expect(await ensureKey(p, mac.pub, mac.env, 'darwin')).toBe(true);
  expect(mac.added()).toBe(`--apple-use-keychain ${mac.key}\n`);
  expect(stderr.text).toContain(`loading ${mac.key} into ssh-agent`);

  const linux = agent('', 1);
  await ensureKey(recorded().p, linux.pub, linux.env, 'linux');
  expect(linux.added()).toBe(`${linux.key}\n`);
});

test('ensure_key leaves it to ssh when only the public half is here, and warns when no agent runs', async () => {
  const noAgent = agent('', 2);
  const { p, stderr } = recorded();
  expect(await ensureKey(p, noAgent.pub, noAgent.env, 'darwin')).toBe(true);
  expect(noAgent.added()).toBe('');
  expect(stderr.text).toBe('node-ctl: no ssh-agent running; start one with: eval $(ssh-agent)\n');

  const publicOnly = agent('', 1);
  expect(await ensureKey(recorded().p, '/nonexistent/id_ed25519.pub', publicOnly.env, 'darwin')).toBe(true);
  expect(publicOnly.added()).toBe('');
});
