/**
 * Where ledger reads the time it decides by: claim expiry, dates it writes, the age of a lock, the daily check. Limits
 * on real waits, such as git timeouts and lock retries, stay on real time.
 */
export type Clock = {
  now(): Date;
  /** The local date, as the old scripts wrote it: YYYY-MM-DD. */
  today(): string;
};

export const systemClock: Clock = {
  now: () => new Date(),
  today: () => {
    const now = new Date();
    return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, '0')).join('-');
  },
};
