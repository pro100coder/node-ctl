// node-ctl: disposable dev machines on Hetzner Cloud or Contabo. The entry point: global options,
// help (answered before anything is read, so it works on a fresh install), then one command.
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { check } from './check.ts';
import { UserError } from './errors.ts';
import { accountsCommand, init } from './init.ts';
import { list } from './list.ts';
import { load, ssh } from './load.ts';
import { PAGES, USAGE } from './help.ts';
import { openLog, tee } from './log.ts';
import { paths } from './paths.ts';
import { cancel, whenCancelled } from './proc.ts';
import { stdinInput, type Input, type Ui } from './ui.ts';
import { Progress, renderersFor, resolveMode, type Mode } from './progress/progress.ts';
import type { Out } from './progress/types.ts';

// Set by bun build --define; a run from source has neither.
declare const NODE_CTL_VERSION: string | undefined;
declare const NODE_CTL_SHA: string | undefined;

interface Io {
  stdout: Out;
  stderr: Out;
  env: Record<string, string | undefined>;
  terminal: boolean; // stderr is a terminal: auto progress draws a live region there
  screen?: Out; // stderr past the log, where the renderers draw; stderr itself when there is no log
  color?: boolean;
  columns?: number;
  rows?: number;
  input?: Input; // stdin unless a test hands one in
  raw?: (on: boolean) => void; // the terminal's raw mode, for a drawn menu
}

interface Context {
  args: string[];
  yes: boolean; // --yes: the answer to every confirmation, for scripts
  progress: Progress;
  ui: Ui;
  io: Io;
}

// A handler that answers a number exits with it, as the bash command whose last step was a child's (ssh, load).
export type Handler = (ctx: Context) => Promise<number | void> | number | void;

// The dispatch table, in the order of the bash dispatch line; test/cli.test.ts holds every entry to a help page.
export const COMMANDS = [
  'create', 'stop', 'start', 'resize', 'volume', 'destroy', 'list', 'load', 'ports', 'expose', 'backup', 'archive',
  'restore', 'ssh', 'gitkey', 'hostkeys', 'autostop', 'cato', 'apply', 'test', 'check', 'init', 'accounts', 'version',
];

const version: Handler = ({ io }) => {
  const v = typeof NODE_CTL_VERSION === 'string' ? NODE_CTL_VERSION : 'dev';
  const sha = typeof NODE_CTL_SHA === 'string' && NODE_CTL_SHA ? ` (${NODE_CTL_SHA})` : '';
  io.stdout.write(`node-ctl ${v}${sha}\n`);
};

const ported = new Map<string, Handler>([
  ['version', version],
  ['list', list],
  ['load', load],
  ['ssh', ssh],
  ['check', check],
  ['init', init],
  ['accounts', accountsCommand],
]);

// Only the options before the command are global: after it every word is the command's (ssh passes them on).
export function parseGlobals(argv: string[]): { yes: boolean; progress: string | undefined; command: string; args: string[] } {
  const { tokens } = parseArgs({
    args: argv,
    options: { progress: { type: 'string' }, yes: { type: 'boolean' } },
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  let progress: string | undefined;
  let yes = false;
  for (const t of tokens) {
    if (t.kind === 'option' && t.name === 'progress') progress = t.value ?? '';
    else if (t.kind === 'option' && t.name === 'yes') yes = true;
    else return { yes, progress, command: argv[t.index]!, args: argv.slice(t.index + 1) };
  }
  return { yes, progress, command: '', args: [] };
}

function page(command: string): string {
  if (!Object.hasOwn(PAGES, command)) throw new UserError(`unknown command: ${command} (./node-ctl --help lists them)`);
  return PAGES[command]!;
}

const asksHelp = (a: string | undefined) => a === '-h' || a === '--help';

function helpFor(command: string, args: string[]): string | undefined {
  if (asksHelp(command)) return USAGE;
  if (command === 'help') return args[0] ? page(asksHelp(args[0]) ? 'help' : args[0]) : USAGE;
  // ssh hands everything after the name to the machine (ssh dev1 ls --help), so only its first argument can ask
  const asks = command === 'ssh' ? asksHelp(args[0]) : args.some(asksHelp);
  return asks ? page(command) : undefined;
}

// help and version touch nothing, so they work on a fresh install and leave no log behind; every other
// run lands in node-ctl.log with what it said and its exit status. ssh hands the terminal to the
// machine and load redraws a table every second: a screen, not a record, so only the frame is logged.
export async function main(argv: string[], io: Io, handlers: Map<string, Handler> = ported): Promise<number> {
  const globals = parseGlobals(argv);
  const command = globals.command === '--version' ? 'version' : globals.command;
  let help: string | undefined;
  try {
    help = helpFor(command, globals.args);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    io.stderr.write(`node-ctl: ${e.message}\n`);
    return e.code;
  }
  if (help !== undefined) {
    io.stdout.write(help);
    return 0;
  }
  if (command === 'version') return run(io, globals, command, handlers);
  const log = openLog(paths(io.env).log);
  log.line(`=== node-ctl ${(argv[0]?.startsWith('--progress=') ? argv.slice(1) : argv).join(' ')}`);
  const bare = command === 'ssh' || command === 'load';
  const logged: Io = bare ? io : { ...io, screen: io.stderr, stdout: tee(io.stdout, log), stderr: tee(io.stderr, log) };
  let code = 1; // a bug escapes with its stack, and the log still says how the run ended
  try {
    code = await run(logged, globals, command, handlers, bare ? undefined : log);
  } finally {
    log.line(`=== exit ${code}`);
  }
  return code;
}

type Globals = ReturnType<typeof parseGlobals>;

// The command against a cancel: Ctrl+C settles the open actions as cancelled and answers 130 (proc.ts
// waits for the children first), whatever the command was still waiting for.
function run(io: Io, globals: Globals, command: string, handlers: Map<string, Handler>, log?: Out): Promise<number> {
  let mode: Mode = 'plain';
  // The renderers draw on the bare stderr: a drawing is no record, the log gets their own plain lines.
  const progress = new Progress(
    () =>
      renderersFor(mode, io.screen ?? io.stderr, {
        events: io.env.NODE_CTL_EVENTS,
        color: io.color ?? false,
        columns: io.columns ?? 80,
        log,
      }),
    io.stderr,
  );
  const cancelled = new Promise<number>((resolve) =>
    whenCancelled(() => {
      progress.settle('cancelled');
      progress.close();
      resolve(130);
    }),
  );
  const setMode = (m: Mode) => {
    mode = m;
  };
  return Promise.race([cancelled, dispatch(io, globals, command, handlers, progress, setMode)]);
}

async function dispatch(
  io: Io,
  globals: Globals,
  command: string,
  handlers: Map<string, Handler>,
  progress: Progress,
  setMode: (m: Mode) => void,
): Promise<number> {
  try {
    setMode(
      resolveMode(globals.progress ?? (io.env.NODE_CTL_PROGRESS || 'auto'), {
        terminal: io.terminal,
        ci: Boolean(io.env.CI),
        dialogue: command === 'init' || command === 'accounts',
      }),
    );
    if (command === '') {
      io.stderr.write(USAGE);
      return 1;
    }
    if (!COMMANDS.includes(command)) {
      progress.warn(`unknown command: ${command}`);
      io.stderr.write(USAGE);
      return 1;
    }
    const handler = handlers.get(command);
    if (!handler) throw new UserError(`${command} is not implemented yet`);
    const input = io.input ?? stdinInput();
    const ui: Ui = {
      input,
      stderr: io.stderr,
      yes: globals.yes,
      home: io.env.HOME || homedir(),
      drawn: io.terminal && input.terminal && (io.columns ?? 0) >= 50,
      color: io.color ?? false,
      columns: io.columns ?? 80,
      rows: io.rows ?? 24,
      suspend: () => progress.suspend(),
      raw: io.raw,
    };
    const code = await handler({ args: globals.args, yes: globals.yes, progress, ui, io });
    progress.close();
    return code ?? 0;
  } catch (e) {
    progress.settle('failed', e instanceof Error ? e.message : String(e));
    progress.close(); // the final frame lands before the message
    if (!(e instanceof UserError)) throw e;
    io.stderr.write(`node-ctl: ${e.message}\n`);
    return e.code;
  }
}

// The process around main: the real streams, and Ctrl+C. A second Ctrl+C while the children are still
// finishing ends node-ctl at once. A cancel exits explicitly, since what the command was waiting for
// (a timer, a read) would keep the process alive; any other run ends by itself, so a pipe gets all of stdout.
export async function entry(argv: string[], handlers?: Map<string, Handler>): Promise<void> {
  const env = process.env;
  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    void cancel();
  });
  const code = await main(
    argv,
    {
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      terminal: Boolean(process.stderr.isTTY),
      color: (Boolean(process.stdout.isTTY) || Boolean(env.FORCE_COLOR)) && !env.NO_COLOR,
      columns: process.stderr.columns,
      rows: process.stderr.rows,
      raw: (on) => process.stdin.setRawMode?.(on),
    },
    handlers,
  );
  if (interrupted) process.exit(code);
  process.exitCode = code;
}

if (import.meta.main) await entry(process.argv.slice(2));
