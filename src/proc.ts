// Child processes. actionRun is the bash action_run: every line the child prints becomes a log event
// of the open action (and through the log renderer a line of node-ctl.log). Credentials reach a child
// only through the env of that one call; a script reaches it on stdin, never in argv.
//
// Ctrl+C goes to the whole foreground process group, so the child gets it from the terminal itself.
// As bash did, node-ctl waits for the children to finish (their last lines land in the log), then
// settles the open actions as cancelled and exits 130; a child that died of SIGINT means the same.
import { constants } from 'node:os';
import type { Progress } from './progress/progress.ts';

type Stream = 'stdout' | 'stderr';

interface SpawnOptions {
  env?: Record<string, string | undefined>; // on top of this process's environment, for this child only
  cwd?: string;
  stdin?: string | Uint8Array | 'inherit'; // a script or an archive, or the terminal; nothing otherwise
  inherit?: boolean; // stdout and stderr are the terminal's (ssh-add asking for a passphrase)
  bytes?: boolean; // stdout is data (an archive), kept as it came in Result.bytes; onLine sees stderr only
  signal?: AbortSignal; // kills the child (an ssh port forward that lives as long as a step)
  onLine?: (line: string, stream: Stream) => void;
}

interface Result {
  status: number; // the exit status; 128 + the signal for a child killed by one, 127 when there is no such command
  stdout: string;
  stderr: string;
  bytes?: Uint8Array;
}

const live = new Set<Promise<unknown>>();
let onCancel: (() => void) | undefined;
let cancelling: Promise<never> | undefined;

// What a cancel does once every child is done: cli.ts settles the actions, ends the log, exits 130.
export function whenCancelled(fn: () => void): void {
  onCancel = fn;
  cancelling = undefined;
}

// Never resolves: the process ends in the handler.
export function cancel(): Promise<never> {
  cancelling ??= Promise.allSettled([...live]).then(() => {
    onCancel?.();
    return new Promise<never>(() => {});
  });
  return cancelling;
}

async function lines(stream: ReadableStream<Uint8Array>, name: Stream, onLine?: SpawnOptions['onLine']): Promise<string> {
  const decoder = new TextDecoder();
  let all = '';
  let pending = '';
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    all += text;
    if (!onLine) continue;
    const parts = (pending + text).split('\n');
    pending = parts.pop()!;
    for (const l of parts) onLine(l, name);
  }
  const rest = decoder.decode();
  all += rest;
  pending += rest;
  if (onLine && pending) onLine(pending, name); // a last line without a newline is still a line
  return all;
}

export async function spawn(argv: string[], opts: SpawnOptions = {}): Promise<Result> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...opts.env })) if (v !== undefined) env[k] = v;
  const [cmd, ...args] = argv;
  // resolved against the child's PATH, so a call can bring its own (the tests' fake binaries)
  const bin = cmd?.includes('/') ? cmd : Bun.which(cmd ?? '', { PATH: env.PATH ?? '' });
  if (!bin) {
    const message = `${cmd}: command not found`;
    opts.onLine?.(message, 'stderr');
    return { status: 127, stdout: '', stderr: `${message}\n` };
  }
  const out = opts.inherit ? 'inherit' : 'pipe';
  const proc = Bun.spawn([bin, ...args], {
    env,
    cwd: opts.cwd,
    stdin: opts.stdin === undefined ? 'ignore' : opts.stdin === 'inherit' ? 'inherit' : Buffer.from(opts.stdin),
    stdout: out,
    stderr: out,
    signal: opts.signal,
  });
  let bytes: Uint8Array | undefined;
  const readStdout = async (s: ReadableStream<Uint8Array>) => {
    if (!opts.bytes) return lines(s, 'stdout', opts.onLine);
    bytes = await new Response(s).bytes();
    return '';
  };
  const done = Promise.all([
    proc.stdout instanceof ReadableStream ? readStdout(proc.stdout) : '',
    proc.stderr instanceof ReadableStream ? lines(proc.stderr, 'stderr', opts.onLine) : '',
    proc.exited,
  ]);
  live.add(done);
  const [stdout, stderr] = await done.finally(() => live.delete(done));
  // Once Ctrl+C came, nothing goes on after a child: bash ran its INT trap however the child ended. A child
  // with an INT trap of its own can exit 130 before this process has run its handler: that is the Ctrl+C too.
  if (cancelling || proc.signalCode === 'SIGINT' || proc.exitCode === 130) return cancel();
  const signal = proc.signalCode ? constants.signals[proc.signalCode] : undefined;
  return { status: signal ? 128 + signal : (proc.exitCode ?? 1), stdout, stderr, ...(bytes ? { bytes } : {}) };
}

// json_str dropped carriage returns and ESC from a message: a progress bar's \r or a colour code is no text.
const clean = (line: string) => line.replace(/[\r\x1b]/g, '');

export function actionRun(progress: Progress, argv: string[], opts: Omit<SpawnOptions, 'onLine' | 'inherit'> = {}): Promise<Result> {
  return spawn(argv, { ...opts, onLine: (line, stream) => progress.log(clean(line), stream) });
}
