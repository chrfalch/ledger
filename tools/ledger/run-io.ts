import { AsyncLocalStorage } from 'node:async_hooks';
import { Writable } from 'node:stream';

/** The environment a ledger run reads and its child processes inherit, and the console it prints to. */
export type RunIo = { env: NodeJS.ProcessEnv; console: Console };

// Run-scoped rather than passed down: most of the code that reads these has no Context, git calls in particular. Only
// env and console are kept apart per run; the time limits and caches each run resets are shared, so runs in one
// process must not overlap in time.
const current = new AsyncLocalStorage<RunIo>();

export const inRun = <T>(io: RunIo, run: () => T): T => current.run(io, run);

/** The environment of the run in progress; outside a run, this process's. */
export const runEnv = (): NodeJS.ProcessEnv => current.getStore()?.env ?? process.env;

/** The console of the run in progress; outside a run, the global one. */
export const runConsole = (): Console => current.getStore()?.console ?? console;

/** A stream that keeps what is written to it. */
export class Collected extends Writable {
  readonly #chunks: Buffer[] = [];

  override _write(chunk: Buffer, _encoding: BufferEncoding, written: () => void): void {
    this.#chunks.push(chunk);
    written();
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString('utf8');
  }
}
