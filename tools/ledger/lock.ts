import { readFileSync, rmSync } from 'node:fs';
import { fail } from './failure.js';
import { createFile } from './files.js';
import { sleep } from './wait.js';

const WAIT_MS = 5_000;
/** No ledger write holds a lock this long, so an older one was left by a process that hung or whose pid was reused. */
const STALE_MS = 60_000;

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

const isLeftOver = ({ pid, since }: Holder): boolean => !isRunning(pid) || Date.now() - Date.parse(since) > STALE_MS;

/**
 * Removes the lock only while it still holds `text`, so a lock another process has taken since is kept. Another
 * process can still take it between the read and the removal; that needs a left-over lock and two commands that both
 * find it within the same microseconds.
 */
function removeIfStill(lock: string, text: string): void {
  if (lockText(lock) === text) rmSync(lock, { force: true });
}

/**
 * Runs `work` while this process holds `<target>.lock`, a file that names its process and since when. Another command
 * waits for it with short sleeps, and gives up after five seconds. A lock whose process is gone, or older than a
 * minute, was left behind, and is taken over.
 */
export function withLock<T>(target: string, work: () => T): T {
  const lock = `${target}.lock`;
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    // Written whole through a hard link, so a waiting command never reads half a lock.
    const mine = JSON.stringify({ pid: process.pid, since: new Date().toISOString() } satisfies Holder);
    if (createFile(lock, mine)) {
      try {
        return work();
      } finally {
        removeIfStill(lock, mine);
      }
    }
    // Undefined both for a lock released since and for one that cannot be read, such as a folder; only time ends that wait.
    const text = lockText(lock);
    const holder = text === undefined ? undefined : holderOf(text);
    if (text !== undefined && (holder === undefined || isLeftOver(holder))) {
      removeIfStill(lock, text);
      continue;
    }
    if (Date.now() > deadline) {
      const by = holder === undefined ? '' : ` held by process ${holder.pid} since ${holder.since}`;
      fail(`Gave up waiting for the lock ${lock}${by}: another ledger command is writing ${target}. Try again. If no ledger command is running, delete the lock.`);
    }
    sleep(10 + Math.random() * 40);
  }
}
