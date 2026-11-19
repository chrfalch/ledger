const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Blocks this process for `ms` milliseconds; the ledger code is synchronous, so it cannot await a timer. */
export const sleep = (ms: number): void => void Atomics.wait(sleeper, 0, 0, ms);

/**
 * Sleeps for a random time up to LEDGER_TEST_DELAY_MS milliseconds, if set. Called between a read and the write that
 * depends on it, so a test that runs commands at once can make them overlap there. The time is random so that a
 * command that read first can write last.
 */
export function pauseForTest(): void {
  const ms = Number(process.env.LEDGER_TEST_DELAY_MS);
  if (ms > 0) sleep(Math.random() * ms);
}
