/** An error for the person at the terminal: printed to stderr, and the command exits with `exitCode`. */
export class Failure extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

/** A declaration, not an arrow, so TypeScript narrows after `if (…) fail(…)`. */
export function fail(message: string, exitCode?: number): never {
  throw new Failure(message, exitCode);
}
