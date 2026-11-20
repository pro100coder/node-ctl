// What a machine that becomes ready gets from this computer, and what it must never take: the merge
// rules for MCP servers and skills, the host-key stores, the generated ssh config.
import { expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateSshConfig } from '../src/apply.ts';
import { browser } from '../src/cato.ts';
import type { Run } from '../src/command.ts';
import { loadConfig } from '../src/config.ts';
import { updateKnownHosts, updateOrcaKey } from '../src/hostkeys.ts';
import { writeMachine } from '../src/inventory.ts';
import { paths } from '../src/paths.ts';
import { Progress } from '../src/progress/progress.ts';
import { JsonRenderer } from '../src/progress/render/json.ts';
import type { ActionEvent } from '../src/progress/types.ts';
import { installAgentFiles, installGitKey, mcpScript } from '../src/ready.ts';
import { fakeBins, Sink } from './helpers.ts';

// A tailscale that knows no address and says the tailnet's suffix: nothing reaches the real daemon.
const TAILSCALE = 'case $1 in status) echo \'{"MagicDNSSuffix":"tailtest.ts.net"}\' ;; *) exit 1 ;; esac';

function world(bins: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'node-ctl-ready-'));
  const fake = fakeBins({ tailscale: TAILSCALE, ...bins });
  const env = { HOME: home, NODE_CTL_HOME: join(home, '.node-ctl'), ORCA_PROFILES: join(home, 'orca'), PATH: fake.PATH };
  const out = new Sink();
  const stderr = new Sink();
  const progress = new Progress(() => [new JsonRenderer(out)], stderr);
  const p = paths(env);
  const run: Run = { p, config: loadConfig(p.config, env), progress, env };
  const events = () => out.lines().map((l) => JSON.parse(l) as ActionEvent);
  return { home, run, stderr, events };
}

test('the MCP merge only adds the servers the machine lacks: one it has keeps its config, the rest of its file stays', async () => {
  const { home } = world();
  const here = join(home, 'here.json');
  writeFileSync(here, JSON.stringify({ mcpServers: { linear: { url: 'new' }, sentry: { url: 'added' } }, oauthAccount: 'here' }));
  const machine = join(home, 'machine');
  mkdirSync(machine);
  writeFileSync(join(machine, '.claude.json'), JSON.stringify({ mcpServers: { linear: { url: 'old' }, theirs: {} }, oauthAccount: 'there' }));
  const js = /<<'MCPJS'\n([\s\S]*)\nMCPJS\n$/.exec(mcpScript(here))![1]!;
  writeFileSync(join(home, 'mcp.js'), js);
  // the machine runs it with node; bun runs the same CommonJS
  const r = Bun.spawnSync([process.execPath, join(home, 'mcp.js')], { env: { HOME: machine } });
  expect(r.exitCode).toBe(0);
  const merged = JSON.parse(readFileSync(join(machine, '.claude.json'), 'utf8'));
  expect(merged).toEqual({ mcpServers: { linear: { url: 'old' }, theirs: {}, sentry: { url: 'added' } }, oauthAccount: 'there' });
});

test('no MCP servers here, or a file that is not JSON, sends nothing', () => {
  const { home } = world();
  const f = join(home, 'c.json');
  writeFileSync(f, '{"oauthAccount":"x"}');
  expect(mcpScript(f)).toBe('');
  writeFileSync(f, 'not json');
  expect(mcpScript(f)).toBe('');
  expect(mcpScript(join(home, 'missing.json'))).toBe('');
});

// An ssh that runs the skills' remote command for real, in a home of its own, on the archive it is fed
// (bsdtar knows no --warning); a script for sudo bash -s is recorded.
const sshInto = (machine: string, dump: string) =>
  `last=""; for a in "$@"; do last=$a; done
case $last in *node-ctl-skills*) cmd=$(printf '%s' "$last" | sed 's/--warning=no-unknown-keyword//'); HOME=${machine} bash -c "$cmd" ;; *) cat >> ${dump} ;; esac`;

test('skills land in ~/.claude/node-ctl-skills, replaced whole, linked from skills/; the agent\'s own stay and win', async () => {
  const machine = mkdtempSync(join(tmpdir(), 'node-ctl-machine-'));
  const { home, run } = world({ ssh: sshInto(machine, '/dev/null') });
  const here = run.p.skills;
  mkdirSync(join(here, 'tdd'), { recursive: true });
  mkdirSync(join(here, 'grill'));
  mkdirSync(join(home, 'checkout', 'linked'), { recursive: true });
  writeFileSync(join(here, 'tdd', 'a.md'), 'a');
  writeFileSync(join(here, 'tdd', 'b.md'), 'b');
  writeFileSync(join(here, 'grill', 'SKILL.md'), 'g');
  writeFileSync(join(home, 'checkout', 'linked', 'SKILL.md'), 'linked');
  symlinkSync(join(home, 'checkout', 'linked'), join(here, 'linked')); // links here are followed
  mkdirSync(join(here, 'node-ctl-migrate')); // drives this computer's node-ctl: never sent
  const on = join(machine, '.claude', 'skills');
  mkdirSync(join(on, 'mine'), { recursive: true });
  symlinkSync('/nowhere', join(on, 'grill')); // the agent's own, of a name pushed from here

  expect(await installAgentFiles(run, 'dev1')).toBe(true);
  expect(readFileSync(join(on, 'tdd', 'b.md'), 'utf8')).toBe('b');
  expect(readlinkSync(join(on, 'tdd'))).toBe('../node-ctl-skills/tdd');
  expect(lstatSync(join(machine, '.claude', 'node-ctl-skills', 'linked')).isDirectory()).toBe(true);
  expect(readlinkSync(join(on, 'grill'))).toBe('/nowhere');
  expect(existsSync(join(on, 'node-ctl-migrate'))).toBe(false);

  rmSync(join(here, 'grill'), { recursive: true });
  rmSync(join(here, 'tdd', 'b.md'));
  mkdirSync(join(here, 'mine')); // the agent's own of that name wins
  expect(await installAgentFiles(run, 'dev1')).toBe(true);
  expect(existsSync(join(on, 'tdd', 'a.md'))).toBe(true);
  expect(existsSync(join(on, 'tdd', 'b.md'))).toBe(false); // replaced whole: a file deleted here goes there
  expect(lstatSync(join(on, 'mine')).isSymbolicLink()).toBe(false);
  expect(readlinkSync(join(on, 'grill'))).toBe('/nowhere');
});

test('the commit key and the MCP tokens reach the machine only on stdin: never in argv, never in the events', async () => {
  const dump = mkdtempSync(join(tmpdir(), 'node-ctl-dump-'));
  const { run, events } = world({ ssh: `printf '%s\\n' "$@" >> ${dump}/argv; cat >> ${dump}/stdin` });
  mkdirSync(run.p.claudeDir, { recursive: true });
  writeFileSync(join(run.p.claudeDir, 'CLAUDE.md'), 'INSTRUCTIONS');
  writeFileSync(run.p.claudeJson, JSON.stringify({ mcpServers: { linear: { headers: { Authorization: 'MCP-SECRET-TOKEN' } } }, oauthAccount: 'LOGIN-SECRET' }));
  mkdirSync(run.p.skills, { recursive: true });
  mkdirSync(join(run.p.skills, 'tdd'));
  writeFileSync(join(run.p.skills, 'tdd', 'SKILL.md'), 'SKILL-SECRET-BODY');
  mkdirSync(join(run.p.gitKey, '..'), { recursive: true });
  writeFileSync(run.p.gitKey, 'GIT-SECRET-KEY\n');

  expect(await installGitKey(run, 'dev1')).toBe(true);
  expect(await installAgentFiles(run, 'dev1')).toBe(true);
  const argv = readFileSync(join(dump, 'argv'), 'utf8');
  const stdin = readFileSync(join(dump, 'stdin'));
  const logged = JSON.stringify(events());
  expect(stdin.toString('latin1')).toContain('GIT-SECRET-KEY');
  expect(stdin.toString('latin1')).toContain('MCP-SECRET-TOKEN');
  for (const secret of ['GIT-SECRET-KEY', 'MCP-SECRET-TOKEN', 'SKILL-SECRET-BODY', 'LOGIN-SECRET']) {
    expect(argv).not.toContain(secret);
    expect(logged).not.toContain(secret);
  }
  expect(stdin.toString('latin1')).not.toContain('LOGIN-SECRET'); // the servers, never this computer's login
});

const KEYGEN = `case $1 in -lf) read -r _ t k; echo "256 SHA256:fp-$k c (ED25519)" ;; -q) f=$5; [ ! -s "$f" ] || { grep -v "^$3 " "$f" > "$f.x"; mv "$f.x" "$f"; } ;; esac`;

test("an Orca store that is not valid JSON is left exactly as it is; a valid one gets the key in the stale one's place", async () => {
  const { run } = world({ 'ssh-keygen': KEYGEN });
  const broken = join(run.p.orcaProfiles, 'a', 'ssh-host-keys.json');
  const good = join(run.p.orcaProfiles, 'b', 'ssh-host-keys.json');
  mkdirSync(join(broken, '..'), { recursive: true });
  mkdirSync(join(good, '..'), { recursive: true });
  writeFileSync(broken, 'not json at all');
  writeFileSync(good, JSON.stringify({ version: 1, hostKeys: [{ host: 'dev1', key: 'STALE' }, { host: 'other', key: 'KEEP' }] }));
  await updateOrcaKey(run.p.orcaProfiles, 'dev1', 'dev1 ssh-rsa AAAArsa\ndev1 ssh-ed25519 AAAAnew', run.env);
  expect(readFileSync(broken, 'utf8')).toBe('not json at all');
  expect(existsSync(`${broken}.tmp`)).toBe(false);
  const store = JSON.parse(readFileSync(good, 'utf8'));
  expect(store.version).toBe(1);
  expect(store.hostKeys).toEqual([
    { host: 'other', key: 'KEEP' },
    { host: 'dev1', port: 22, keyType: 'ssh-ed25519', key: 'AAAAnew', fingerprint: 'SHA256:fp-AAAAnew', acceptedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/) },
  ]);
});

test('a host key that cannot be recorded is a warning, never a failure, and the stale entry still goes', async () => {
  const { run, stderr } = world({ 'ssh-keygen': KEYGEN, 'ssh-keyscan': 'exit 1' });
  mkdirSync(run.p.sshDir, { recursive: true });
  const known = join(run.p.sshDir, 'known_hosts');
  writeFileSync(known, 'dev1 ssh-ed25519 AAAAstale\nelsewhere ssh-ed25519 AAAAkeep\n');
  await updateKnownHosts(run, 'dev1');
  expect(readFileSync(known, 'utf8')).toBe('elsewhere ssh-ed25519 AAAAkeep\n');
  expect(stderr.text).toBe(`node-ctl: could not record dev1's host key in ${run.p.sshDir}/known_hosts; ssh asks about it\n`);
});

test('the ssh config is generated, never merged: only the running machines, whatever the file held', async () => {
  const { run } = world();
  mkdirSync(run.p.servers, { recursive: true });
  writeMachine(run.p.servers, 'dev1', { state: 'running' });
  writeMachine(run.p.servers, 'dev2', { state: 'stopped' });
  mkdirSync(join(run.p.sshConfig, '..'), { recursive: true });
  writeFileSync(run.p.sshConfig, 'Host by-hand\n  HostName 10.0.0.1\n');
  await updateSshConfig(run.p.servers, run.p.sshConfig, run.progress, run.env);
  expect(readFileSync(run.p.sshConfig, 'utf8')).toBe(
    '# Generated by node-ctl — edits are overwritten. Machines: node-ctl list\n\nHost node-ctl-dev1\n  HostName dev1\n  User node-ctl-user\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n',
  );
});

test('the Cato sign-in opens the browser with open on macOS and xdg-open on Linux', () => {
  expect(browser('darwin')).toBe('open');
  expect(browser('linux')).toBe('xdg-open');
});
