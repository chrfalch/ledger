import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fail } from './failure.js';
import { oneLine } from './hook-failures.js';
import { plural } from './views.js';

// @ref LLP 0000#hooks — the operator's override of the pre-tool-use gates, and the log of what it let through.

/** hooks/derived-data-gate.sh reads `untilEpoch` of this file too. */
export const rootMarker = (home: string): string => path.join(home, '.claude', 'ledger-root.json');
const rootLog = (home: string): string => path.join(home, '.claude', 'ledger-root.log');
/** Holds the byte offset of the log up to which session start has reported. */
const reportedOffsetFile = (home: string): string => path.join(home, '.claude', 'ledger-root.reported');

export const ROOT_MINUTES = { default: 30, max: 240 } as const;

/** The value of `ledger root on --minutes`. */
export function rootMinutes(value: string): number {
  const minutes = /^\d+$/.test(value) ? Number(value) : NaN;
  return minutes >= 1 && minutes <= ROOT_MINUTES.max ? minutes : fail(`--minutes takes a whole number from 1 to ${ROOT_MINUTES.max}, not "${value}".`);
}

type Marker = { since: string; until: string; untilEpoch: number };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
export type RootState = { on: false } | { on: true; since: string; until: Date; minutesLeft: number };

export function rootState(home: string, now: Date): RootState {
  let marker: unknown;
  try {
    marker = JSON.parse(readFileSync(rootMarker(home), 'utf8'));
  } catch {
    return { on: false };
  }
  if (!isRecord(marker) || typeof marker.untilEpoch !== 'number') return { on: false };
  const until = new Date(marker.untilEpoch * 1000);
  const left = until.getTime() - now.getTime();
  if (left <= 0) return { on: false };
  return { on: true, since: text(marker.since) || now.toISOString(), until, minutesLeft: Math.ceil(left / 60_000) };
}

/** A switch while on keeps `since`, so the marker still says when the operator first switched it on. */
export function switchRootOn(home: string, now: Date, minutes: number): RootState {
  const current = rootState(home, now);
  const untilEpoch = Math.floor(now.getTime() / 1000) + minutes * 60;
  const marker: Marker = { since: current.on ? current.since : now.toISOString(), until: new Date(untilEpoch * 1000).toISOString(), untilEpoch };
  mkdirSync(path.dirname(rootMarker(home)), { recursive: true });
  writeFileSync(rootMarker(home), `${JSON.stringify(marker)}\n`);
  return rootState(home, now);
}

export function switchRootOff(home: string): void {
  rmSync(rootMarker(home), { force: true });
}

const localTime = (at: Date): string => [at.getHours(), at.getMinutes()].map((part) => String(part).padStart(2, '0')).join(':');

export const rootStateText = (state: RootState): string =>
  state.on ? `Root override is on for ${plural(state.minutesLeft, 'minute')}, until ${localTime(state.until)}.` : 'Root override is off.';

export const rootSegment = (state: RootState): string => (state.on ? `ROOT ${state.minutesLeft}m` : '');

/** One call a gate would have denied: a Bash call names its command, a file tool its file. */
export type RootAction = { tool: string; cwd: string; reason: string } & ({ command: string } | { file: string });

/** A log that cannot be written is skipped, as a hook must not fail on its way to allowing a call. */
export function logRootAction(home: string, action: RootAction, now: Date): void {
  try {
    mkdirSync(path.dirname(rootLog(home)), { recursive: true });
    appendFileSync(rootLog(home), `${JSON.stringify({ at: now.toISOString().replace(/\.\d+Z$/, 'Z'), ...action })}\n`);
  } catch {}
}

const SUBJECT_LIMIT = 80;

/** A command keeps its start, which says what runs; a file keeps its end, which says what file it is. */
const shortened = (text: string, keep: 'start' | 'end'): string => {
  const chars = [...oneLine(text)];
  if (chars.length <= SUBJECT_LIMIT) return chars.join('');
  return keep === 'start' ? `${chars.slice(0, SUBJECT_LIMIT - 1).join('')}…` : `…${chars.slice(1 - SUBJECT_LIMIT).join('')}`;
};
const firstSentence = (reason: string): string => {
  const line = reason.split('\n')[0].trim();
  return /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line;
};

function actionLine(line: string): string | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(entry)) return undefined;
  const subject = typeof entry.command === 'string' ? shortened(entry.command, 'start') : shortened(text(entry.file), 'end');
  return `- ${text(entry.at)} ${text(entry.tool)}: ${subject} — ${firstSentence(text(entry.reason))}`;
}

export type RootReport = { text: string; offset: number };

/** The calls logged since the last report, one line each, or undefined for none or a log that cannot be read. */
export function unreportedRootActions(home: string): RootReport | undefined {
  let log: Buffer;
  try {
    log = readFileSync(rootLog(home));
  } catch {
    return undefined;
  }
  const lines = log
    .subarray(reportedOffset(home, log.length))
    .toString('utf8')
    .split('\n')
    .flatMap((line) => (line.trim() === '' ? [] : (actionLine(line) ?? [])));
  if (lines.length === 0) return undefined;
  return { text: ['Allowed only because ledger root was on:', ...lines].join('\n'), offset: log.length };
}

/** A log shorter than the offset was truncated, so all of it is new. */
function reportedOffset(home: string, logSize: number): number {
  try {
    const offset = Number(readFileSync(reportedOffsetFile(home), 'utf8').trim());
    return Number.isSafeInteger(offset) && offset >= 0 && offset <= logSize ? offset : 0;
  } catch {
    return 0;
  }
}

export function markRootActionsReported(home: string, { offset }: RootReport): void {
  try {
    writeFileSync(reportedOffsetFile(home), `${offset}\n`);
  } catch {}
}
