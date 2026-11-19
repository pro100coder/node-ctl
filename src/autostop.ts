// start --till (ADR-0019), the T05d hook: start parses --till through tillAt before its first action and
// calls scheduleStop after it writes the inventory; nothing else of start knows about the job.
import type { Run } from './command.ts';
import { UserError } from './errors.ts';

// till_at: the moment (epoch seconds) a --till value names, refused with the reason before anything runs.
export function tillAt(_value: string): number {
  throw new UserError('start --till is not implemented yet');
}

// schedule_stop: with at, the launchd job that stops the machine then (its own "Schedule the stop" step,
// which start has already planned); without, only the job an earlier start left is dropped, so it cannot
// stop this one. False when the job could not be written.
// shortcut: dropping a job left by an earlier start is T05d's too; until then a start leaves it in place.
export async function scheduleStop(_run: Run, _name: string, _at: number | undefined): Promise<boolean> {
  return true;
}
