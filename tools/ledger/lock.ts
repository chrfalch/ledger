import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { fail } from './failure.js';
import { createFile, moveAside, putBack } from './files.js';
import { pauseForTest, sleep } from './wait.js';

const WAIT_MS = 5_000;
/** No ledger write holds a lock this long, so an older one was left by a process that hung or whose pid was reused. */
const STALE_MS = 60_000;
/** A reclaim guard is held for a moment only, so an older one was left by a process that hung or whose pid was reused. */
const GUARD_STALE_MS = 10_000;

let limit = Infinity;

/** Ends every later lock wait of this process by `until`, a time from Date.now(), the wait to release a lock too: for hooks. */
export function limitLockWaits(until: number): void {
  limit = until;
}

type Holder = { pid: number; since: string };

const lockText = (lock: string): string | undefined => {
  try {
    return readFileSync(lock, 'utf8');
  } catch {
    return undefined;
  }
};

/** The process that holds a lock; undefined for a text no lock was made with. */
function holderOf(text: string): Holder | undefined {
  try {
    const { pid, since } = JSON.parse(text) as Record<string, unknown>;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && typeof since === 'string' && Number.isFinite(Date.parse(since)) ? { pid, since } : undefined;
  } catch {
    return undefined;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const isLeftOver = ({ pid, since }: Holder, keepWhileRunning: boolean): boolean =>
  !isRunning(pid) || (!keepWhileRunning && Date.now() - Date.parse(since) > STALE_MS);

/** A lock text no lock was made with counts as left over too. */
const isLeftOverText = (text: string, keepWhileRunning: boolean): boolean => {
  const holder = holderOf(text);
  return holder === undefined || isLeftOver(holder, keepWhileRunning);
};

const isLeftOverGuard = (text: string): boolean => {
  const holder = holderOf(text);
  return holder === undefined || !isRunning(holder.pid) || Date.now() - Date.parse(holder.since) > GUARD_STALE_MS;
};

/** The nonce makes each text unique, so a text read before a removal stands for one take of a lock or guard only. */
const holderText = (): string => JSON.stringify({ pid: process.pid, since: new Date().toISOString(), nonce: randomUUID() } satisfies Holder & { nonce: string });

export type LockOptions = {
  /** How long to wait for another process to let go; five seconds by default. */
  waitMs?: number;
  /** Never take the lock from a process that still runs, however old the lock: for work that may take minutes. */
  keepWhileRunning?: boolean;
};

/**
 * Removes `file`, a lock or a reclaim guard, while it still holds `text`, and true; false, with nothing done, while
 * another process holds its guard `<file>.reclaim`. Either is only made by an exclusive create, with a unique text, and
 * only removed under its guard, by the process that holds the guard; so between the read here and the removal, nothing
 * can make or remove `file`. A guard left by a process that is gone, or held longer than a guard ever is, is removed the
 * same way, under a guard of its own; so of the processes that find it, only one removes it, and only that guard.
 */
function removeIfStill(file: string, text: string): boolean {
  const guard = `${file}.reclaim`;
  const mine = holderText();
  if (!createFile(guard, mine)) {
    const held = lockText(guard);
    if (held !== undefined && isLeftOverGuard(held)) removeIfStill(guard, held);
    return false;
  }
  try {
    if (lockText(file) === text) {
      pauseForTest();
      // Checked again once moved aside: a process that stalled here past GUARD_STALE_MS may find a lock taken since.
      const aside = moveAside(file);
      if (aside !== undefined) {
        if (lockText(aside) === text) rmSync(aside, { force: true });
        else putBack(aside, file);
      }
    }
    return true;
  } finally {
    // Another process takes this guard over only once it is older than GUARD_STALE_MS; then that one removes it.
    if (lockText(guard) === mine) rmSync(guard, { force: true });
  }
}

/** Takes `lock` and gives its text, or gives the process that still held it when the wait ran out. */
function take(lock: string, { waitMs = WAIT_MS, keepWhileRunning = false }: LockOptions): string | { holder?: Holder } {
  const deadline = Math.min(Date.now() + waitMs, limit);
  for (;;) {
    // Written whole through a hard link, so a waiting command never reads half a lock.
    const mine = holderText();
    if (createFile(lock, mine)) return mine;
    // Undefined both for a lock released since and for one that cannot be read, such as a folder; only time ends that wait.
    const text = lockText(lock);
    if (text !== undefined && isLeftOverText(text, keepWhileRunning)) {
      pauseForTest();
      if (removeIfStill(lock, text)) continue;
    }
    if (Date.now() >= deadline) return { holder: text === undefined ? undefined : holderOf(text) };
    sleep(10 + Math.random() * 40);
  }
}

/**
 * Removes this process's own lock. A guard another process holds is waited for; after WAIT_MS, or at the limit of
 * limitLockWaits, the lock stays, and is left over once this process ends.
 */
function release(lock: string, mine: string): void {
  const deadline = Math.min(Date.now() + WAIT_MS, limit);
  while (!removeIfStill(lock, mine) && Date.now() < deadline) sleep(1);
}

function holding<T>(lock: string, mine: string, work: () => T): T {
  try {
    return work();
  } finally {
    release(lock, mine);
  }
}

/**
 * Runs `work` while this process holds `<target>.lock`, a file that names its process and since when. Another command
 * waits for it with short sleeps, and gives up after `waitMs`. A lock whose process is gone was left behind, and is
 * taken over; so is one older than a minute, unless `keepWhileRunning`.
 */
export function withLock<T>(target: string, work: () => T, options: LockOptions = {}): T {
  const lock = `${target}.lock`;
  const taken = take(lock, options);
  if (typeof taken !== 'string') {
    const by = taken.holder === undefined ? '' : ` held by process ${taken.holder.pid} since ${taken.holder.since}`;
    fail(`Gave up waiting for the lock ${lock}${by}: another ledger command is writing ${target}. Try again. If no ledger command is running, delete the lock and ${lock}.reclaim, if it is there.`);
  }
  return holding(lock, taken, work);
}

/** Runs `work` under `<target>.lock` when no other process holds it, and gives its result; 'busy' at once otherwise. */
export function withLockIfFree<T>(target: string, work: () => T, { keepWhileRunning }: Pick<LockOptions, 'keepWhileRunning'> = {}): { value: T } | 'busy' {
  const lock = `${target}.lock`;
  const taken = take(lock, { waitMs: 0, keepWhileRunning });
  return typeof taken === 'string' ? holding(lock, taken, () => ({ value: work() })) : 'busy';
}
