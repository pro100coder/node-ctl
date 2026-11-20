// node-ctl.log: every run, what it said and its exit status, for a post-mortem. Plain lines only: the
// progress renderers write it their stamped lines (a live region is no record), and the command's own
// stdout and stderr are copied in as they are, as the bash tees did.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { stamp } from './progress/render/plain.ts';
import type { Out } from './progress/types.ts';

// One older generation is enough for a post-mortem; 10 MB of plain lines is weeks of runs.
const LIMIT = 10 * 1024 * 1024;

interface Log extends Out {
  line(text: string): void; // one stamped line, like the bash log()
}

// A log that cannot be written never stops a command: it is a record, not a step.
export function openLog(path: string, now: () => number = Date.now): Log {
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size > LIMIT) renameSync(path, `${path}.1`);
  } catch {}
  const write = (text: string) => {
    try {
      appendFileSync(path, text);
    } catch {}
  };
  return { write, line: (text) => write(`${stamp(now())} ${text}\n`) };
}

// What a user sees on the stream also lands in the log.
export function tee(out: Out, log: Out): Out {
  return {
    write(text: string) {
      log.write(text);
      return out.write(text);
    },
  };
}
