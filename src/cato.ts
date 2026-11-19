// Cato's token is bound to the VPS it was issued on, so a machine booted from its snapshot has to sign in
// again, and its Google IdP only answers a real browser. The machine writes the login URL instead of
// opening a browser, this computer's browser answers it, and the redirect to 127.0.0.1 travels back over
// an ssh port forward. Everything on the machine runs as node-ctl-user: ~/.cato is its login.
import { need, reach, setup, target, type Ctx, type Run } from './command.ts';
import { UserError } from './errors.ts';
import { editMachine, exists, readMachine } from './inventory.ts';
import { ActionFailure } from './progress/progress.ts';
import { actionRun, spawn } from './proc.ts';
import { addr, remote, tssh } from './ssh.ts';

// The script that asks cato-sdp for a login URL (or says connected); the CLI there waits for the browser.
function requestScript(name: string, account: string, user: string): string {
  return `set -euo pipefail
sdp=$(command -v cato-sdp) || { echo "cato-sdp is not installed on ${name}"; exit 1; }
run() { sudo -u node-ctl-user -H "$@"; }
if run "$sdp" status 2>/dev/null | grep -q "pop name"; then echo connected; exit 0; fi
fake=~node-ctl-user/.cato-fakebrowser
install -d -o node-ctl-user -g node-ctl-user "$fake"
cat > "$fake/xdg-open" <<'XDG'
#!/bin/sh
echo "$@" > "$HOME/.cato-fakebrowser/url"
XDG
chmod 755 "$fake/xdg-open"
rm -f "$fake/url"
run "$sdp" stop > /dev/null 2>&1 || true
run env DISPLAY=:0 "PATH=$fake:$PATH" setsid nohup "$sdp" start --reset-cred --account '${account}' --user '${user}' \\
  --use-systemd-resolv 1 --reconn 30 > "$fake/log" 2>&1 < /dev/null &
for _ in $(seq 1 60); do [ -s "$fake/url" ] && break; sleep 1; done
[ -s "$fake/url" ] || { echo "no login URL from cato-sdp after 60s:"; cat "$fake/log"; exit 1; }
cat "$fake/url"
`;
}

// Until the client there says which PoP it is on, five minutes at most.
const WAIT = `for _ in $(seq 1 60); do
  pop=$(sudo -u node-ctl-user -H cato-sdp status 2>/dev/null | grep "pop name") && { echo "connected, $pop"; exit 0; }
  sleep 5
done
echo "still disconnected after 5 minutes:"; cat ~node-ctl-user/.cato-fakebrowser/log; exit 1
`;

// The browser of this computer: open on macOS, xdg-open on Linux.
export const browser = (platform: string) => (platform === 'darwin' ? 'open' : 'xdg-open');

// The browser here answers the URL; the redirect reaches the machine over the forward.
async function signIn(run: Run, name: string, user: string, url: string): Promise<void> {
  const { progress, env } = run;
  const port = /^\d*/.exec(url.includes('127.0.0.1:') ? url.slice(url.lastIndexOf('127.0.0.1:') + 10) : url)![0];
  if (!port) throw new ActionFailure(`no redirect port in the login URL: ${url}`);
  const forward = new AbortController();
  const target = `node-ctl-user@${await addr(name, env)}`;
  const tunnel = spawn(tssh('-N', '-o', 'ExitOnForwardFailure=yes', '-L', `${port}:127.0.0.1:${port}`, target), {
    env,
    signal: forward.signal,
    onLine: (line, stream) => progress.log(line, stream),
  });
  try {
    progress.log(`sign in as ${user} in the browser: ${url}`);
    const open = browser(process.platform);
    if (Bun.which(open, { PATH: env.PATH ?? '' })) await actionRun(progress, [open, url], { env });
    else progress.info(`open in a browser: ${url}`);
    const r = await remote(name, WAIT, { progress, env });
    if (r.status !== 0) throw new ActionFailure('', r.status);
  } finally {
    forward.abort();
    await tunnel;
  }
}

// cato_login: undefined when signed in (or a machine without .cato, which has nothing to do), otherwise
// why not; '' when the failed step already said it.
async function catoLogin(run: Run, name: string): Promise<string | undefined> {
  const cato = readMachine(run.p.servers, name).cato;
  if (!cato) return undefined;
  let url = '';
  let failure = '';
  const asked = await run.progress.withAction(`Request a Cato login URL from ${name}`, 'cato-url', async () => {
    const lines: string[] = [];
    const r = await remote(name, requestScript(name, cato.account, cato.user), { env: run.env, onLine: (l) => lines.push(l) });
    const out = lines.join('\n').replace(/\n+$/, '');
    if (r.status !== 0) {
      failure = out || `could not reach ${name}`;
      throw new ActionFailure(failure, r.status);
    }
    url = out.slice(out.lastIndexOf('\n') + 1);
  });
  if (!asked) return failure;
  if (url === 'connected') {
    run.progress.info(`Cato is already connected on ${name}`);
    return undefined;
  }
  const signed = await run.progress.withAction('Sign in to Cato', 'cato-signin', () =>
    signIn(run, name, cato.user, url).catch((e: unknown) => {
      if (e instanceof ActionFailure) failure = e.message;
      throw e;
    }),
  );
  return signed ? undefined : failure;
}

export const cato = async (ctx: Ctx): Promise<number | void> => {
  const run = setup(ctx);
  const args = await target(ctx, run.p.servers, 'cato', ['running']);
  if (!(await reach(run))) return 1;
  const [name, ...rest] = args;
  need('cato', name, '<name> [account user]');
  exists(run.config, run.p.servers, name!);
  const m = readMachine(run.p.servers, name!);
  if (m.state !== 'running') throw new UserError(`${name} is not running`);
  if (rest.length === 0) {
    if (!m.cato) throw new UserError(`${name} has no Cato account yet: ./node-ctl cato ${name} <account> <user>`);
  } else if (rest.length === 2) {
    editMachine(run.p.servers, name!, (e) => (e.cato = { account: rest[0]!, user: rest[1]! }));
  } else throw new UserError('usage: ./node-ctl cato <name> [account user]');
  const failed = await catoLogin(run, name!);
  if (failed !== undefined) throw new UserError(failed || `Cato sign-in failed on ${name}`);
  ctx.io.stdout.write(`Cato connected on ${name}\n`);
};
