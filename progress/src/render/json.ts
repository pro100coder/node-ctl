import type { ActionEvent, Renderer } from '../types.ts';

// One event per line, nothing dropped: the input of any other tool.
export class JsonRenderer implements Renderer {
  readonly #out: NodeJS.WritableStream;

  constructor(out: NodeJS.WritableStream) {
    this.#out = out;
  }

  handle(e: ActionEvent): void {
    this.#out.write(`${JSON.stringify(e)}\n`);
  }

  close(): void {}
}
