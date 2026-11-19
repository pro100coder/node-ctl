// node-ctl: disposable dev machines on Hetzner Cloud or Contabo. The entry point: global options,
// help (answered before anything is read, so it works on a fresh install), then one command.
import { parseArgs } from 'node:util';
import { UserError } from './errors.ts';
import { PAGES, USAGE } from './help.ts';
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
  color?: boolean;
  columns?: number;
}

interface Context {
  args: string[];
  yes: boolean; // --yes: the answer to every confirmation, for scripts
  progress: Progress;
  io: Io;
}

type Handler = (ctx: Context) => Promise<void> | void;

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

const ported = new Map<string, Handler>([['version', version]]);

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

export async function main(argv: string[], io: Io): Promise<number> {
  const globals = parseGlobals(argv);
  const command = globals.command === '--version' ? 'version' : globals.command;
  let mode: Mode = 'plain';
  const progress = new Progress(
    () => renderersFor(mode, io.stderr, { events: io.env.NODE_CTL_EVENTS, color: io.color ?? false, columns: io.columns ?? 80 }),
    io.stderr,
  );
  try {
    const help = helpFor(command, globals.args);
    if (help !== undefined) {
      io.stdout.write(help);
      return 0;
    }
    mode = resolveMode(globals.progress ?? (io.env.NODE_CTL_PROGRESS || 'auto'), {
      terminal: io.terminal,
      ci: Boolean(io.env.CI),
      dialogue: command === 'init' || command === 'accounts',
    });
    if (command === '') {
      io.stderr.write(USAGE);
      return 1;
    }
    if (!COMMANDS.includes(command)) {
      progress.warn(`unknown command: ${command}`);
      io.stderr.write(USAGE);
      return 1;
    }
    const handler = ported.get(command);
    if (!handler) throw new UserError(`${command} is not implemented yet`);
    await handler({ args: globals.args, yes: globals.yes, progress, io });
    progress.close();
    return 0;
  } catch (e) {
    progress.settle('failed', e instanceof Error ? e.message : String(e));
    progress.close(); // the final frame lands before the message
    if (!(e instanceof UserError)) throw e;
    io.stderr.write(`node-ctl: ${e.message}\n`);
    return e.code;
  }
}

if (import.meta.main) {
  const env = process.env;
  process.exitCode = await main(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    env,
    terminal: Boolean(process.stderr.isTTY),
    color: (Boolean(process.stdout.isTTY) || Boolean(env.FORCE_COLOR)) && !env.NO_COLOR,
    columns: process.stderr.columns,
  });
}
