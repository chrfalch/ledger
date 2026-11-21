// @ref LLP 0001#54-claims — D5, D17: a session claims the active task it works on; a claim with no activity expires.
import { withClaim, withoutClaim } from './edit.js';
import { fail, Failure } from './failure.js';
import { claimText, parseLedger, type Claim } from './format.js';
import { checkoutRoot, mainCheckout } from './git.js';
import { loadTasks } from './registry.js';
import { repoKey } from './repo-key.js';
import { readClaimExpiryMinutes } from './settings.js';
import { activeTasks, activeTask as worktreeTask, findNamed, notOnThisMachine, taskRef, theTask, type Task } from './tasks.js';
import { updateActive, type Context } from './write.js';

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

function ownTask({ store, cwd }: Context): Task | undefined {
  const root = checkoutRoot(cwd);
  return root === undefined ? undefined : worktreeTask(store, root);
}

/** The task `name` names, or that of the worktree the command runs in; only an active task whose worktree is on this machine. */
function activeTask(context: Context, name: string | undefined): Task {
  const task = name === undefined ? (ownTask(context) ?? fail(`No task ledger in or above ${context.cwd}. Give the slug of an active task.`)) : namedTask(context, name);
  if (task.elsewhere) fail(notOnThisMachine(task));
  return task;
}

function namedTask(context: Context, name: string): Task {
  const ref = taskRef(context.cwd, name);
  const tasks = loadTasks(context);
  const task = findNamed(tasks, ref).find(({ place }) => place === 'active') ?? theTask(tasks, ref);
  if (task.place === 'active') return task;
  return fail(`${task.slug} is not active: ${task.place === 'backlog' ? `it is in the backlog. ledger go ${task.slug} starts it.` : 'it is retired.'}`, 2);
}

/** What a claim reads and writes of a task: its active record, and its slug and ledger for the result. */
type ClaimedLedger = Pick<Task, 'slug' | 'file' | 'repo' | 'name'>;

type ClaimState = { task: ClaimedLedger; text: string; stored?: Claim; live?: Claim; now: Date };

/** What a claim change returns, and the ledger text to write; none leaves the ledger as it is. */
type ClaimChange<T> = { result: T; text?: string };

/** Runs `work` on the ledger of `task` and its live claim, read and written as one change of its record. */
function lockedClaim<T>(context: Context, task: ClaimedLedger, clock: ClaimClock, work: (state: ClaimState) => ClaimChange<T>): T {
  let done: ClaimChange<T> | undefined;
  updateActive(context, task, (text) => {
    const stored = parseLedger(text).location.claim;
    const live = liveClaim(stored, clock);
    done = work({ task, text, now: clock.now, ...(stored === undefined ? {} : { stored }), ...(live === undefined ? {} : { live }) });
    return done.text;
  });
  return done === undefined ? fail(`The ledger ${task.file} is gone.`) : done.result;
}

function underLock<T>(context: Context, name: string | undefined, work: (state: ClaimState) => ClaimChange<T>): T {
  return lockedClaim(context, activeTask(context, name), claimClock(context.paths.home), work);
}

/** What a `--all` touch or release did: the slugs whose claim it changed, and a line for each task it could not do. */
export type AllResult = { changed: string[]; failures: string[] };

/**
 * Runs `work` on each active task of the repo the command runs in whose worktree is on this machine, one record change
 * each. A task that fails does not stop the others, so one broken ledger leaves no other claim behind.
 */
function changedInRepo(context: Context, verb: string, work: (state: ClaimState) => ClaimChange<boolean>): AllResult {
  const main = mainCheckout(context.cwd) ?? fail(`${context.cwd} is not inside a git repository.`);
  const clock = claimClock(context.paths.home);
  const result: AllResult = { changed: [], failures: [] };
  for (const task of activeTasks(context.store, repoKey(main)).filter(({ elsewhere }) => !elsewhere)) {
    try {
      if (lockedClaim(context, task, clock, work)) result.changed.push(task.slug);
    } catch (error) {
      result.failures.push(`Could not ${verb} the claim on ${task.slug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

const claimed = (task: ClaimedLedger, text: string, claim: Claim): string => withClaim(text, claim) ?? fail(`${task.file} has no ## Location section to hold the claim.`);

export type ClaimResult = { slug: string; ledger: string; claim: Claim; tookOverFrom?: Claim };

/** `from` names the session this one continues, such as the one before a /clear: its claim passes over with no take-over. */
export type ClaimOptions = { takeOver: boolean; from?: string };

/** Claims `task` for `session`; refuses with Held while a session other than `session` or `from` holds it live, unless `takeOver`. */
export function claimLedger(context: Context, task: ClaimedLedger, session: string, { takeOver, from }: ClaimOptions): ClaimResult {
  return lockedClaim(context, task, claimClock(context.paths.home), ({ text, live, now: at }) => {
    const other = live === undefined || live.session === session || live.session === from ? undefined : live;
    if (other !== undefined && !takeOver) throw new Held(other);
    const time = stamp(at);
    const claim = { session, since: live?.session === session ? live.since : time, active: time };
    return { result: { slug: task.slug, ledger: task.file, claim, ...(other === undefined ? {} : { tookOverFrom: other }) }, text: claimed(task, text, claim) };
  });
}

/** Claims the active task `name`, or that of the worktree the command runs in, as claimLedger does. */
export const claimTask = (context: Context, name: string | undefined, session: string, options: ClaimOptions): ClaimResult =>
  claimLedger(context, activeTask(context, name), session, options);

export const claimResultText = ({ slug, tookOverFrom }: ClaimResult): string => (tookOverFrom === undefined ? `claimed ${slug}` : `took over ${slug} from session ${tookOverFrom.session}`);

/** Marks the live claim of `session` active now, once its activity is TOUCH_MINUTES old; any other claim, or none, stays. */
function touchClaim(session: string): (state: ClaimState) => ClaimChange<boolean> {
  return ({ task, text, live, now: at }) => {
    if (live?.session !== session || minutesSince(live.active, at) < TOUCH_MINUTES) return { result: false };
    return { result: true, text: claimed(task, text, { ...live, active: stamp(at) }) };
  };
}

/** Removes the claim of `session`, live or expired; any other claim, or none, stays. */
function releaseClaim(session: string): (state: ClaimState) => ClaimChange<boolean> {
  return ({ text, stored }) => (stored?.session === session ? { result: true, text: withoutClaim(text) } : { result: false });
}

export function touchTask(context: Context, name: string | undefined, session: string): { slug: string; touched: boolean } {
  return underLock(context, name, (state) => {
    const { result: touched, text } = touchClaim(session)(state);
    return { result: { slug: state.task.slug, touched }, text };
  });
}

export const touchAll = (context: Context, session: string): AllResult => changedInRepo(context, 'touch', touchClaim(session));

export function releaseTask(context: Context, name: string | undefined, session: string): { slug: string; released: boolean } {
  return underLock(context, name, (state) => {
    const { result: released, text } = releaseClaim(session)(state);
    return { result: { slug: state.task.slug, released }, text };
  });
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
  updateActive(context, task, withoutClaim);
}
