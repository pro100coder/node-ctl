// wait_ready: a machine that has just booted (create, start, restore, apply <name>) becomes one this
// computer can use. Only now does the tailnet know its address, so the ssh config and the host keys
// follow; then what its home lost or never had: the commit key, the agent's instructions, skills and
// MCP servers, and its Funnel. They ride the disk snapshot, so writing them on every start (and apply)
// is what makes an edit here reach a machine that already exists.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { updateSshConfig } from './apply.ts';
import { step, type Run } from './command.ts';
import { UserError } from './errors.ts';
import { sleep } from './http.ts';
import { updateKnownHosts } from './hostkeys.ts';
import { readMachine } from './inventory.ts';
import { actionRun, spawn } from './proc.ts';
import { addr, remote, tssh } from './ssh.ts';

const stat = (f: string) => {
  try {
    return statSync(f);
  } catch {
    return undefined;
  }
};
const text = (f: string) => readFileSync(f, 'utf8').replace(/\n+$/, ''); // $(cat file)

// ssh over the tailnet answers and cloud-init has finished, ten minutes at most.
async function waitLoop(run: Run, name: string): Promise<void> {
  const { progress, env } = run;
  const batch = async (command: string) => spawn(tssh('-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', `node-ctl-user@${await addr(name, env)}`, command), { env });
  let err = '';
  for (let i = 1; i <= 60; i++) {
    const r = await batch('sudo cloud-init status --wait >/dev/null');
    err = r.stderr.replace(/\n+$/, '');
    if (r.status === 0) return;
    if (r.status === 2) return progress.warn(`cloud-init finished with recoverable errors on ${name}`);
    if (r.status === 255) {
      progress.progress(i, 60, err || 'no answer yet');
      await sleep(10_000, env);
      continue;
    }
    // Contabo merges its own cloud-config into ours: a chpasswd for its default user admin, whom our
    // users list replaces, so that one step fails on every Contabo machine and nothing else does.
    if (onlyPasswords((await batch('sudo cloud-init status --format json || true')).stdout)) {
      return progress.warn(`cloud-init on ${name} failed only to set a password for the provider's admin user, which node-ctl-user replaces`);
    }
    throw new UserError(`cloud-init failed on ${name}; see: node-ctl ssh ${name} cat /var/log/cloud-init-output.log`);
  }
  throw new UserError(
    `${name} is not reachable over the tailnet: ${err || 'no answer'}\n  (Tailscale off or MagicDNS not answering on this host? node-ctl check tells; the machine's public address is in node-ctl list)`,
  );
}

function onlyPasswords(status: string): boolean {
  try {
    const errors = (JSON.parse(status) as { errors?: unknown }).errors;
    return Array.isArray(errors) && errors.length > 0 && errors.every((e) => typeof e === 'string' && /^[(].set_passwords./.test(e));
  } catch {
    return false;
  }
}

// One commit key for all machines: git on a disposable machine pushes as this key, so nothing on it has
// to be set up (or salvaged) per machine. The private half rides inside the piped script, never argv.
function gitKeyScript(key: string): string {
  return `set -euo pipefail
install -d -m 700 -o node-ctl-user -g node-ctl-user ~node-ctl-user/.ssh
touch ~node-ctl-user/.ssh/id_ed25519
chmod 600 ~node-ctl-user/.ssh/id_ed25519
cat > ~node-ctl-user/.ssh/id_ed25519 <<'KEY'
${key}
KEY
# an unknown host key must not stop a git clone on a machine nobody is watching
grep -qs accept-new ~node-ctl-user/.ssh/config ||
  printf 'Host *\\n\\tStrictHostKeyChecking accept-new\\n' >> ~node-ctl-user/.ssh/config
chmod 600 ~node-ctl-user/.ssh/config
chown node-ctl-user:node-ctl-user ~node-ctl-user/.ssh/id_ed25519 ~node-ctl-user/.ssh/config
`;
}

export async function installGitKey(run: Run, name: string): Promise<boolean> {
  if (!existsSync(run.p.gitKey)) {
    run.progress.warn(`no ${run.p.gitKey}: git on ${name} has no commit key (node-ctl init gitkey)`);
    return true;
  }
  const script = gitKeyScript(text(run.p.gitKey));
  return step(run.progress, 'Install the git key', 'gitkey', () => remote(name, script, { progress: run.progress, env: run.env }));
}

// One script for every file of CLAUDE.md and AGENTS.md that exists here; '' when none does.
function agentFilesScript(claudeDir: string): string {
  return ['CLAUDE.md', 'AGENTS.md']
    .filter((f) => stat(join(claudeDir, f))?.isFile())
    .map(
      (f) => `install -d -m 755 -o node-ctl-user -g node-ctl-user ~node-ctl-user/.claude
cat > ~node-ctl-user/.claude/${f} <<'AGENTFILE'
${text(join(claudeDir, f))}
AGENTFILE
chown node-ctl-user:node-ctl-user ~node-ctl-user/.claude/${f}
`,
    )
    .join('');
}

// The user-scope MCP servers here (tokens included) that the machine's ~/.claude.json lacks: a server
// already there keeps its config, edited there or not. Only mcpServers: the rest of that file is this
// computer's login. Node is on the machine for codex; '' when there is nothing to add.
export function mcpScript(claudeJson: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(claudeJson, 'utf8'));
  } catch {
    return '';
  }
  if (doc !== null && (typeof doc !== 'object' || Array.isArray(doc))) return '';
  const servers = JSON.stringify((doc as { mcpServers?: unknown } | null)?.mcpServers ?? {});
  if (servers === '{}') return '';
  return `sudo -u node-ctl-user -H node - <<'MCPJS'
const fs = require('fs'), f = require('os').homedir() + '/.claude.json'
const c = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}
c.mcpServers = { ...${servers}, ...c.mcpServers }
fs.writeFileSync(f, JSON.stringify(c, null, 2), { mode: 0o600 })
MCPJS
`;
}

// The skills to push: node-ctl-migrate drives this computer's node-ctl, a dangling link has nothing to send.
function skillNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((s) => !s.startsWith('.') && s !== 'node-ctl-migrate' && existsSync(join(dir, s)))
    .sort();
}

// On the machine they land in ~/.claude/node-ctl-skills, replaced whole, and ~/.claude/skills links to
// each: a link into it is ours, so a skill (or a file of one) deleted here goes there too, and the
// agent's own skills are never touched; one of the same name wins over ours.
const UNPACK_SKILLS = `set -e; cd ~/.claude && rm -rf node-ctl-skills && mkdir -p node-ctl-skills skills
      tar -xzf - -C node-ctl-skills --warning=no-unknown-keyword && cd skills
      for s in *; do [ ! -L "$s" ] || case $(readlink "$s") in ../node-ctl-skills/*) rm "$s" ;; esac; done
      for s in ../node-ctl-skills/*; do [ ! -e "$s" ] || [ -e "\${s##*/}" ] || [ -L "\${s##*/}" ] || ln -s "$s" .; done`;

// Links followed: skills here are often links into a checkout. The archive goes over stdin.
// shortcut: the whole tree on every sync; rsync if it grows.
async function pushSkills(run: Run, name: string): Promise<{ status: number }> {
  const { progress, env, p } = run;
  const list = skillNames(p.skills).map((s) => `${s}\n`).join('');
  const tar = await spawn(['tar', '-czhf', '-', '--no-xattrs', '--exclude', '.DS_Store', '-C', p.skills, '-T', '-'], {
    env: { ...env, COPYFILE_DISABLE: '1' },
    stdin: list,
    bytes: true,
    onLine: (line, stream) => progress.log(line, stream),
  });
  if (tar.status !== 0) return tar;
  return actionRun(progress, tssh(`node-ctl-user@${await addr(name, env)}`, UNPACK_SKILLS), { env, stdin: tar.bytes ?? new Uint8Array() });
}

export async function installAgentFiles(run: Run, name: string): Promise<boolean> {
  const script = (agentFilesScript(run.p.claudeDir) + mcpScript(run.p.claudeJson)).replace(/\n+$/, '');
  const skills = Boolean(stat(run.p.skills)?.isDirectory());
  if (!script && !skills) return true;
  return step(run.progress, `Sync the agent setup to ${name}`, 'agentmd', async () => {
    if (script) {
      const r = await remote(name, `set -euo pipefail\n${script}\n`, { progress: run.progress, env: run.env });
      if (r.status !== 0) return r;
    }
    return skills ? pushSkills(run, name) : { status: 0 };
  });
}

// Funnel's configuration lives in tailscaled's state on the root disk, which a rebuild throws away, so
// the inventory (.funnel: path -> port) is the source of truth and is replayed whole.
function funnelScript(funnel: Record<string, number>): string {
  const entries = Object.entries(funnel).map(([path, port]) => `tailscale funnel --bg --set-path ${path} ${port}\n`);
  return `set -euo pipefail\ntailscale funnel reset\n${entries.join('')}`;
}

export function updateFunnel(run: Run, name: string): Promise<boolean> {
  const script = funnelScript(readMachine(run.p.servers, name).funnel ?? {});
  return step(run.progress, 'Configure Tailscale Funnel', 'funnel', () => remote(name, script, { progress: run.progress, env: run.env }));
}

async function restoreFunnel(run: Run, name: string): Promise<boolean> {
  return Object.keys(readMachine(run.p.servers, name).funnel ?? {}).length ? updateFunnel(run, name) : true;
}

// The update restarts tailscaled, which carries this very session: in a unit of its own, a dropped ssh
// leaves apt running instead of killing it halfway through the package.
const UPDATE_TAILSCALE = `set -euo pipefail
systemd-run --unit=node-ctl-tailscale-update --collect --wait --pipe --quiet tailscale update --yes </dev/null
`;

export function updateTailscale(run: Run, name: string): Promise<boolean> {
  return step(run.progress, `Update Tailscale on ${name}`, 'tailscale', () => remote(name, UPDATE_TAILSCALE, { progress: run.progress, env: run.env }));
}

// False when a step after the wait failed (it said why); a machine that never answers is an error.
export async function waitReady(run: Run, name: string): Promise<boolean> {
  await run.progress.withAction(`Wait for ${name}`, 'ready', () => waitLoop(run, name));
  await updateSshConfig(run.p.servers, run.p.sshConfig, run.progress, run.env);
  await updateKnownHosts(run, name);
  return (await installGitKey(run, name)) && (await installAgentFiles(run, name)) && restoreFunnel(run, name);
}
