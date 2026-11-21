// @ref LLP 0001#54-claims — D5, D17: a session claims the active task it works on; a claim with no activity expires.
import { withClaim, withoutClaim } from './edit.js';
import { fail, Failure } from './failure.js';
import { readText, writeAtomic } from './files.js';
import { claimText, parseLedger, type Claim } from './format.js';
import { checkoutRoot, mainCheckout } from './git.js';
import { withLock } from './lock.js';
import { samePath, worktreeLedger } from './paths.js';
import { loadTasks } from './registry.js';
import { readClaimExpiryMinutes } from './settings.js';
import { findNamed, onAnotherMachine, taskRef, theTask, worktreeTasks, type Task } from './tasks.js';
import type { Context } from './write.js';

/** How old the activity of a claim must be before touch writes it again, so a hook that touches at every turn rarely writes. */
const TOUCH_MINUTES = 15;

/** The time now; LEDGER_NOW, an ISO time, stands in for it. */
export function now(): Date {
  const fixed = process.env.LEDGER_NOW;
  if (!fixed) return new Date();
  const time = new Date(fixed);
  return Number.isNaN(time.getTime()) ? fail(`LEDGER_NOW is not a time such as 2026-11-20T10:00:00Z: ${fixed}`) : time;
}

const stamp = (time: Date): string => time.toISOString().replace(/\.\d{3}Z$/, 'Z');
const minutesSince = (time: string, at: Date): number => (at.getTime() - Date.parse(time)) / 60_000;

/** What tells a live claim from an expired one. */
export type ClaimClock = { now: Date; expiryMinutes: number };

export const claimClock = (home: string): ClaimClock => ({ now: now(), expiryMinutes: readClaimExpiryMinutes(home) });

const liveClaim = (claim: Claim | undefined, { now: at, expiryMinutes }: ClaimClock): Claim | undefined =>
  claim !== undefined && minutesSince(claim.active, at) < expiryMinutes ? claim : undefined;

/** The live claim of a session other than `session`; with no session known, any live claim. */
export function otherClaim(claim: Claim | undefined, session: string | undefined, clock: ClaimClock): Claim | undefined {
  const live = liveClaim(claim, clock);
  return live?.session === session ? undefined : live;
}

/** The refusal while another session holds a live claim. */
export class Held extends Failure {
  constructor(readonly held: Claim) {
    super(`held: ${claimText(held)}`, 3);
  }
}

/** The session a command acts for: `option`, else CLAUDE_CODE_SESSION_ID. */
export const knownSession = (option: string | undefined): string | undefined => option ?? (process.env.CLAUDE_CODE_SESSION_ID || undefined);

export function requiredSession(option: string | undefined): string {
  const session = knownSession(option) ?? fail('No session id: pass --session <id>, or run this in a Claude Code session, which sets CLAUDE_CODE_SESSION_ID.', 2);
  return /^\S+$/.test(session) ? session : fail(`"${session}" is no session id: a session id is one word, with no spaces.`, 2);
}

function ownTask(cwd: string): Task | undefined {
  const root = checkoutRoot(cwd);
  const main = root === undefined ? undefined : mainCheckout(root);
  if (root === undefined || main === undefined) return undefined;
  return worktreeTasks(main).find(({ file }) => samePath(file, worktreeLedger(root)));
}

/** The task `name` names, or that of the worktree the command runs in; only an active task, one with a worktree. */
function activeTask(context: Context, name: string | undefined): Task {
  if (name === undefined) return ownTask(context.cwd) ?? fail(`No task ledger in or above ${context.cwd}. Give the slug of an active task.`);
  const ref = taskRef(context.cwd, name);
  const tasks = loadTasks(context, [ref.main]);
  const task = findNamed(tasks, ref).find(({ place }) => place === 'worktree') ?? theTask(tasks, ref);
  if (task.place === 'worktree') return task;
  if (task.place === 'remote') fail(onAnotherMachine(task));
  return fail(`${task.slug} is not active: ${task.place === 'backlog' ? `it is in the backlog. ledger go ${task.slug} starts it.` : 'it is retired.'}`, 2);
}

/** What a claim reads and writes of a task: its ledger file, and its slug for the result. */
type ClaimedLedger = Pick<Task, 'slug' | 'file'>;

type ClaimState = { task: ClaimedLedger; text: string; stored?: Claim; live?: Claim; now: Date };

/** Runs `work` on the ledger of `task` and its live claim, read and written under the ledger's lock. */
function lockedClaim<T>(task: ClaimedLedger, clock: ClaimClock, work: (state: ClaimState) => T): T {
  return withLock(task.file, () => {
    const text = readText(task.file);
    const stored = parseLedger(text).location.claim;
    const live = liveClaim(stored, clock);
    return work({ task, text, now: clock.now, ...(stored === undefined ? {} : { stored }), ...(live === undefined ? {} : { live }) });
  });
}

function underLock<T>(context: Context, name: string | undefined, work: (state: ClaimState) => T): T {
  return lockedClaim(activeTask(context, name), claimClock(context.paths.home), work);
}

/** What a `--all` touch or release did: the slugs whose claim it changed, and a line for each task it could not do. */
export type AllResult = { changed: string[]; failures: string[] };

/**
 * Runs `work` on each active task of the repo the command runs in, under each ledger's own lock. A task that fails does
 * not stop the others, so one broken ledger leaves no other claim behind.
 */
function changedInRepo(context: Context, verb: string, work: (state: ClaimState) => boolean): AllResult {
  const main = mainCheckout(context.cwd) ?? fail(`${context.cwd} is not inside a git repository.`);
  const clock = claimClock(context.paths.home);
  const result: AllResult = { changed: [], failures: [] };
  for (const task of worktreeTasks(main)) {
    try {
      if (lockedClaim(task, clock, work)) result.changed.push(task.slug);
    } catch (error) {
      result.failures.push(`Could not ${verb} the claim on ${task.slug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

function writeClaim(task: ClaimedLedger, text: string, claim: Claim): void {
  writeAtomic(task.file, withClaim(text, claim) ?? fail(`${task.file} has no ## Location section to hold the claim.`));
}

export type ClaimResult = { slug: string; ledger: string; claim: Claim; tookOverFrom?: Claim };

/** `from` names the session this one continues, such as the one before a /clear: its claim passes over with no take-over. */
export type ClaimOptions = { takeOver: boolean; from?: string };

/** Claims `task` for `session`; refuses with Held while a session other than `session` or `from` holds it live, unless `takeOver`. */
export function claimLedger(context: Context, task: ClaimedLedger, session: string, { takeOver, from }: ClaimOptions): ClaimResult {
  return lockedClaim(task, claimClock(context.paths.home), ({ text, live, now: at }) => {
    const other = live === undefined || live.session === session || live.session === from ? undefined : live;
    if (other !== undefined && !takeOver) throw new Held(other);
    const time = stamp(at);
    const claim = { session, since: live?.session === session ? live.since : time, active: time };
    writeClaim(task, text, claim);
    return { slug: task.slug, ledger: task.file, claim, ...(other === undefined ? {} : { tookOverFrom: other }) };
  });
}

/** Claims the active task `name`, or that of the worktree the command runs in, as claimLedger does. */
export const claimTask = (context: Context, name: string | undefined, session: string, options: ClaimOptions): ClaimResult =>
  claimLedger(context, activeTask(context, name), session, options);

export const claimResultText = ({ slug, tookOverFrom }: ClaimResult): string => (tookOverFrom === undefined ? `claimed ${slug}` : `took over ${slug} from session ${tookOverFrom.session}`);

/** Marks the live claim of `session` active now, once its activity is TOUCH_MINUTES old; any other claim, or none, stays. */
function touchClaim(session: string): (state: ClaimState) => boolean {
  return ({ task, text, live, now: at }) => {
    if (live?.session !== session || minutesSince(live.active, at) < TOUCH_MINUTES) return false;
    writeClaim(task, text, { ...live, active: stamp(at) });
    return true;
  };
}

/** Removes the claim of `session`, live or expired; any other claim, or none, stays. */
function releaseClaim(session: string): (state: ClaimState) => boolean {
  return ({ task, text, stored }) => {
    if (stored?.session !== session) return false;
    writeAtomic(task.file, withoutClaim(text));
    return true;
  };
}

export function touchTask(context: Context, name: string | undefined, session: string): { slug: string; touched: boolean } {
  return underLock(context, name, (state) => ({ slug: state.task.slug, touched: touchClaim(session)(state) }));
}

export const touchAll = (context: Context, session: string): AllResult => changedInRepo(context, 'touch', touchClaim(session));

export function releaseTask(context: Context, name: string | undefined, session: string): { slug: string; released: boolean } {
  return underLock(context, name, (state) => ({ slug: state.task.slug, released: releaseClaim(session)(state) }));
}

export const releaseAll = (context: Context, session: string): AllResult => changedInRepo(context, 'release', releaseClaim(session));

/**
 * For a start with no session known, which claims nothing: refuses with Held to go to `task` while any session holds it
 * live. With `takeOver`, it removes that claim instead.
 */
export function refuseIfHeld(context: Context, task: Task, takeOver: boolean): void {
  const { claim } = task.ledger.location;
  const other = claim === undefined ? undefined : otherClaim(claim, undefined, claimClock(context.paths.home));
  if (other === undefined) return;
  if (!takeOver) throw new Held(other);
  withLock(task.file, () => writeAtomic(task.file, withoutClaim(readText(task.file))));
}
