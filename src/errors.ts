// The bash die: a failure the user has to act on. The top level prints "node-ctl: <message>" on stderr
// and exits with the code; anything else that escapes is a bug and keeps its stack.
export class UserError extends Error {
  readonly code: number;

  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}
