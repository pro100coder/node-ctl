// Run by test/proc.test.ts in a process group of its own, as a terminal runs a foreground command:
// create's one step runs a child that says when it got Ctrl+C, then waits for it.
import { entry } from '../../src/cli.ts';
import { actionRun } from '../../src/proc.ts';

await entry(
  process.argv.slice(2),
  new Map([
    [
      'create',
      async ({ progress }) => {
        await progress.withAction('Wait for dev1', 'ready', async () => {
          const r = await actionRun(progress, ['sh', '-c', 'trap "echo got INT; exit 130" INT; echo started; while :; do sleep 0.1; done']);
          progress.log(`went on after the child: ${r.status}`);
        });
        await new Promise((r) => setTimeout(r, 30_000)); // what a cancel must not wait for
      },
    ],
  ]),
);
