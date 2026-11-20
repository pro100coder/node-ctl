// Where node-ctl reads and writes (ADR-0022). What the bash CLI kept in its checkout (config, inventory,
// commit key, log, Terraform roots and their state) lives in NODE_CTL_HOME, ~/.node-ctl by default, in the
// same layout: the roots find ../servers and ../../../scripts by relative paths. Each override keeps its
// name and meaning; an empty one counts as unset, as ${VAR:-default} did.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

interface Paths {
  home: string;
  config: string;
  servers: string;
  gitKey: string;
  log: string;
  terraform: string;
  sshDir: string;
  sshConfig: string; // generated, never merged: ssh node-ctl-<name> works outside the CLI
  skills: string; // where Claude Code looks for skills; init links node-ctl-migrate here
  claudeDir: string;
  claudeJson: string;
  orcaProfiles: string;
  launchAgents: string;
}

export function paths(env: Record<string, string | undefined>, cwd = process.cwd()): Paths {
  const user = env.HOME || homedir();
  // Absolute from here on: Terraform runs with -chdir, where a relative path would point elsewhere.
  const at = (override: string | undefined, fallback: string) => resolve(cwd, override || fallback);
  const home = at(env.NODE_CTL_HOME, join(user, '.node-ctl'));
  const sshDir = at(env.SSH_DIR, join(user, '.ssh'));
  return {
    home,
    config: at(env.NODE_CTL_CONFIG, join(home, 'node-ctl.yaml')),
    servers: at(env.SERVERS_DIR, join(home, 'servers')),
    gitKey: at(env.GIT_KEY_FILE, join(home, 'keys', 'node-ctl_user_ed25519')),
    log: at(env.NODE_CTL_LOG, join(home, 'node-ctl.log')),
    terraform: join(home, 'terraform'),
    sshDir,
    sshConfig: join(sshDir, 'config.d', 'node-ctl'),
    skills: at(env.SKILLS_DIR, join(user, '.claude', 'skills')),
    claudeDir: at(env.CLAUDE_DIR, join(user, '.claude')),
    claudeJson: at(env.CLAUDE_JSON, join(user, '.claude.json')),
    orcaProfiles: at(env.ORCA_PROFILES, join(user, 'Library', 'Application Support', 'orca', 'profiles')),
    launchAgents: at(env.LAUNCH_AGENTS, join(user, 'Library', 'LaunchAgents')),
  };
}
