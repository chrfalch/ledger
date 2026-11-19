import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LedgerPaths } from './paths.js';

// @ref LLP 0001#10-writing-the-ledger — D11: a failing hook lets the action through, so its failure is logged and reported at the next session start.

const MESSAGE_LIMIT = 500;

const hookFailureLog = (home: string): string => path.join(home, '.claude', 'ledger-hook-failures.log');
/** Holds the byte offset of the log up to which session start has reported. */
const reportedOffsetFile = (home: string): string => path.join(home, '.claude', 'ledger-hook-failures.reported');

export const oneLine = (message: string): string => message.replace(/\s+/g, ' ').trim();

/** Appends `<time>\t<hook>\t<message>` to the log; a log that cannot be written is skipped, because a hook must not fail twice. */
export function logHookFailure(home: string, hook: string, message: string, now = new Date()): void {
  try {
    mkdirSync(path.dirname(hookFailureLog(home)), { recursive: true });
    appendFileSync(hookFailureLog(home), `${now.toISOString().replace(/\.\d+Z$/, 'Z')}\t${oneLine(hook)}\t${[...oneLine(message)].slice(0, MESSAGE_LIMIT).join('')}\n`);
  } catch {}
}

export type HookFailureReport = { text: string; offset: number };

/** The report line for the failures logged since the last report, or undefined for none or a log that cannot be read. */
export function unreportedHookFailures({ home, tilde }: LedgerPaths): HookFailureReport | undefined {
  let log: Buffer;
  try {
    log = readFileSync(hookFailureLog(home));
  } catch {
    return undefined;
  }
  const lines = log.subarray(reportedOffset(home, log.length)).toString('utf8').split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return undefined;
  const count = lines.length === 1 ? '1 hook failure' : `${lines.length} hook failures`;
  const since = lines[0].split('\t')[0];
  return { text: `⚠ ${count} since ${since}, not yet reported. Log: ${tilde(hookFailureLog(home))}`, offset: log.length };
}

/** A log shorter than the offset was truncated or rotated, so all of it is new. */
function reportedOffset(home: string, logSize: number): number {
  try {
    const offset = Number(readFileSync(reportedOffsetFile(home), 'utf8').trim());
    return Number.isSafeInteger(offset) && offset >= 0 && offset <= logSize ? offset : 0;
  } catch {
    return 0;
  }
}

export function markHookFailuresReported(home: string, { offset }: HookFailureReport): void {
  try {
    writeFileSync(reportedOffsetFile(home), `${offset}\n`);
  } catch {}
}
