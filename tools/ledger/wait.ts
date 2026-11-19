const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Blocks this process for `ms` milliseconds; the ledger code is synchronous, so it cannot await a timer. */
export const sleep = (ms: number): void => void Atomics.wait(sleeper, 0, 0, ms);

/** So a stray LEDGER_TEST_DELAY_MS can slow a command down, but never hang it. */
const MAX_TEST_DELAY_MS = 10_000;

/**
 * Sleeps for a random time up to LEDGER_TEST_DELAY_MS milliseconds, if set to a finite number, and at most 10 s. Called
 * between a read and the write that depends on it, so a test that runs commands at once can make them overlap there.
 * The time is random so that a command that read first can write last.
 */
export function pauseForTest(): void {
  const ms = Number(process.env.LEDGER_TEST_DELAY_MS);
  if (Number.isFinite(ms) && ms > 0) sleep(Math.random() * Math.min(ms, MAX_TEST_DELAY_MS));
}
