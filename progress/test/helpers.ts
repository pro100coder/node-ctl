import type { ActionEvent, EventType } from '../src/types.ts';
import { Writable } from 'node:stream';

export class Sink extends Writable {
  chunks: string[] = [];
  isTTY: boolean;
  columns = 80;

  constructor(isTTY = false) {
    super();
    this.isTTY = isTTY;
  }

  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(String(chunk));
    cb();
  }

  get text(): string {
    return this.chunks.join('');
  }

  lines(): string[] {
    return this.text.split('\n').filter((l) => l !== '');
  }

  // What a terminal would show: the redraw sequence removes the live region, everything else appends.
  screen(): string[] {
    const lines: string[] = [];
    for (const part of this.text.split(/(\x1b\[\d+A\x1b\[0J)/)) {
      const up = /^\x1b\[(\d+)A\x1b\[0J$/.exec(part);
      if (up) lines.splice(lines.length - Number(up[1]), Number(up[1]));
      else lines.push(...stripAnsi(part).split('\n').filter((l) => l !== ''));
    }
    return lines;
  }
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

let seq = 0;
// One event as cli.ts hands it to a renderer; the key is the first word of the name, like node-ctl's slug.
export function ev(action_id: string, action_name: string, event_type: EventType, extra: Partial<ActionEvent> = {}): ActionEvent {
  const key = action_name.toLowerCase().split(/[^a-z0-9]+/)[0]!;
  return { seq: ++seq, action_id, parent_action_id: null, action_name, key, event_type, timestamp: new Date().toISOString(), ...extra };
}
