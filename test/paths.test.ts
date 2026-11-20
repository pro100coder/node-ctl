import { expect, test } from 'bun:test';
import { paths } from '../src/paths.ts';

test('by default the data lives in ~/.node-ctl, laid out as the checkout was, and the rest where it always was', () => {
  expect(paths({ HOME: '/u' }, '/cwd')).toEqual({
    home: '/u/.node-ctl',
    config: '/u/.node-ctl/node-ctl.yaml',
    servers: '/u/.node-ctl/servers',
    gitKey: '/u/.node-ctl/keys/node-ctl_user_ed25519',
    log: '/u/.node-ctl/node-ctl.log',
    terraform: '/u/.node-ctl/terraform',
    sshDir: '/u/.ssh',
    sshConfig: '/u/.ssh/config.d/node-ctl',
    skills: '/u/.claude/skills',
    claudeDir: '/u/.claude',
    claudeJson: '/u/.claude.json',
    orcaProfiles: '/u/Library/Application Support/orca/profiles',
    launchAgents: '/u/Library/LaunchAgents',
  });
});

test('NODE_CTL_HOME moves what lived in the checkout, nothing of the home directory', () => {
  const p = paths({ HOME: '/u', NODE_CTL_HOME: '/data/nc' }, '/cwd');
  expect([p.home, p.config, p.servers, p.gitKey, p.log, p.terraform]).toEqual([
    '/data/nc',
    '/data/nc/node-ctl.yaml',
    '/data/nc/servers',
    '/data/nc/keys/node-ctl_user_ed25519',
    '/data/nc/node-ctl.log',
    '/data/nc/terraform',
  ]);
  expect([p.sshDir, p.skills, p.claudeDir, p.launchAgents]).toEqual(['/u/.ssh', '/u/.claude/skills', '/u/.claude', '/u/Library/LaunchAgents']);
});

test('each override wins over NODE_CTL_HOME; an empty one counts as unset, as ${VAR:-default} did', () => {
  const p = paths(
    {
      HOME: '/u',
      NODE_CTL_HOME: '/nc',
      NODE_CTL_CONFIG: '/t/c.yaml',
      SERVERS_DIR: '/t/servers',
      GIT_KEY_FILE: '/t/key',
      NODE_CTL_LOG: '/t/log',
      SSH_DIR: '/t/ssh',
      SKILLS_DIR: '/t/skills',
      CLAUDE_DIR: '/t/claude',
      CLAUDE_JSON: '/t/claude.json',
      ORCA_PROFILES: '/t/orca',
      LAUNCH_AGENTS: '',
    },
    '/cwd',
  );
  expect(p).toEqual({
    home: '/nc',
    config: '/t/c.yaml',
    servers: '/t/servers',
    gitKey: '/t/key',
    log: '/t/log',
    terraform: '/nc/terraform',
    sshDir: '/t/ssh',
    sshConfig: '/t/ssh/config.d/node-ctl', // follows SSH_DIR
    skills: '/t/skills',
    claudeDir: '/t/claude',
    claudeJson: '/t/claude.json',
    orcaProfiles: '/t/orca',
    launchAgents: '/u/Library/LaunchAgents',
  });
});

test('a relative override is taken from the directory node-ctl runs in, so Terraform -chdir cannot change its meaning', () => {
  const p = paths({ HOME: '/u', SERVERS_DIR: 'servers', NODE_CTL_HOME: 'nc' }, '/work');
  expect([p.servers, p.home, p.config]).toEqual(['/work/servers', '/work/nc', '/work/nc/node-ctl.yaml']);
});
