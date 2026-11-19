// What the commands that act on machines share: their paths and config, the machine a terminal is
// asked for, the key and the tailnet they need, and steps whose failure is an exit status.
import type { Handler } from './cli.ts';
import { loadConfig, type Config } from './config.ts';
import { UserError } from './errors.ts';
import { paths } from './paths.ts';
import { ActionFailure, type Progress } from './progress/progress.ts';
import { ensureKey, ensureTailscale } from './ssh.ts';
import { pickMachine, targeted } from './target.ts';

export type Ctx = Parameters<Handler>[0];
type Env = Record<string, string | undefined>;

// One command's world: everything wait_ready and the steps around it need.
export interface Run {
  p: ReturnType<typeof paths>;
  config: Config;
  progress: Progress;
  env: Env;
}

export function setup(ctx: Ctx): Run {
  const p = paths(ctx.io.env);
  return { p, config: loadConfig(p.config, ctx.io.env), progress: ctx.progress, env: ctx.io.env };
}

// need "${1:-}" "<name> ...": a missing argument is a usage error.
export function need(command: string, value: string | undefined, usage: string): string {
  if (!value) throw new UserError(`usage: node-ctl ${command} ${usage}`);
  return value;
}

// The arguments, with the machine a terminal picked in front when they name none.
export async function target(ctx: Ctx, servers: string, command: string, states: string[], all?: string): Promise<string[]> {
  if (!ctx.ui.input.terminal || targeted(ctx.args)) return ctx.args;
  return [await pickMachine(ctx.ui, servers, command, states, all), ...ctx.args];
}

// What every command that reaches a machine does first: the key in the agent, the tailnet on. False
// when ssh-add could not load the key (it said why on the terminal).
export async function reach(run: Run): Promise<boolean> {
  if (!(await ensureKey(run.progress, run.config.sshPublicKeyFile, run.env))) return false;
  await ensureTailscale(run.env);
  return true;
}

// with_action over a child process: the step fails with its exit status.
export function step(progress: Progress, name: string, key: string, body: () => Promise<{ status: number }>): Promise<boolean> {
  return progress.withAction(name, key, async () => {
    const r = await body();
    if (r.status !== 0) throw new ActionFailure('', r.status);
  });
}

// with_action over an API call: what the script said on stderr is the error's message, its status 1.
export function call(progress: Progress, name: string, key: string, body: () => Promise<unknown>): Promise<boolean> {
  return step(progress, name, key, () =>
    body().then(
      () => ({ status: 0 }),
      (e: unknown) => {
        progress.log(e instanceof Error ? e.message : String(e), 'stderr');
        return { status: 1 };
      },
    ),
  );
}
