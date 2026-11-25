// @ref LLP 0001#7-the-lifecycle — step 7: what the session start does with the PR of each waiting task (D20).
import { limitCloneGitCalls } from './clone.js';
import { prViews, type PrView } from './git.js';
import { limitLockWaits } from './lock.js';
import { findNamed, listedChildren, type Task } from './tasks.js';
import { markWaitingDone, sendBackToBuild, type Context } from './write.js';

/** gh gets this long for every PR together; the session start's git calls have their own limit. */
const PR_CHECK_MS = 3000;
/** The writes gh's answers ask for get this long from when gh is done, as the session start's git time may be up by then. */
const PR_UPDATE_MS = 2000;

let prCheckMs = PR_CHECK_MS;
let prUpdateMs = PR_UPDATE_MS;

/**
 * For tests only: how long gh gets for every PR together; the writes after it get the same share of that time. A module
 * the tests preload calls it. Gives the limit it replaces.
 */
export function limitPrCheckTimeForTests(ms: number): number {
  const replaced = prCheckMs;
  prCheckMs = ms;
  prUpdateMs = (ms * PR_UPDATE_MS) / PR_CHECK_MS;
  return replaced;
}

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PASSED_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILED_STATES = new Set(['FAILURE', 'ERROR']);

export type PrOutcome = { kind: 'merged' | 'closed' | 'ready' | 'pending' } | { kind: 'fix'; checksFailed: boolean; changesRequested: boolean };

/** What a PR asks of its task. A PR with no checks has passed them; one whose review is not required needs no approval. */
export function prOutcome({ state, reviewDecision, checks }: PrView): PrOutcome {
  if (state === 'MERGED') return { kind: 'merged' };
  if (state === 'CLOSED') return { kind: 'closed' };
  const checksFailed = checks.some(({ conclusion, state: status }) => FAILED_CONCLUSIONS.has(conclusion) || FAILED_STATES.has(status));
  const changesRequested = reviewDecision === 'CHANGES_REQUESTED';
  if (checksFailed || changesRequested) return { kind: 'fix', checksFailed, changesRequested };
  const passed = checks.every(({ conclusion, state: status }) => PASSED_CONCLUSIONS.has(conclusion) || status === 'SUCCESS');
  return { kind: passed && (reviewDecision === 'APPROVED' || reviewDecision === '') ? 'ready' : 'pending' };
}

type Placed = { task: Task; main: string };

/** `own`, then its root task, found up its parent lines, and every task below that root. */
function treeOf(tasks: Task[], own: Task, main: string): Task[] {
  let root: Placed = { task: own, main };
  const above = new Set([own.file]);
  for (let parent = own.ledger.location.parent; parent !== undefined; parent = root.task.ledger.location.parent) {
    const ref = { slug: parent.slug, main: parent.main ?? root.main };
    const found = findNamed(tasks, ref).find(({ place }) => place !== 'archive');
    if (found === undefined || above.has(found.file)) break;
    above.add(found.file);
    root = { task: found, main: ref.main };
  }
  const tree = [root];
  for (const { task, main: at } of tree) {
    for (const child of listedChildren(task, at, tasks)) {
      const { task: found } = child;
      if (found !== undefined && !tree.some(({ task: known }) => known.file === found.file)) tree.push({ task: found, main: child.ref.main });
    }
  }
  return [own, ...tree.map(({ task }) => task).filter(({ file }) => file !== own.file)];
}

/** The tasks a session start found: the active tasks of a main checkout's repo, or, when `own`, the task of its worktree. */
export type SessionTasks = { tasks: Task[]; own: boolean };

type WaitingPr = { task: Task; pr: string };

const waitsHere = (task: Task): boolean => task.status === 'waiting' && !task.elsewhere;

function waitingPr(task: Task): WaitingPr[] {
  const { pr } = task.ledger.location;
  return waitsHere(task) && pr !== undefined ? [{ task, pr }] : [];
}

/** Of the session's tasks, or of its own task's tree in `onDisk`, each that is waiting, names a PR, and is on this machine. */
function waitingPrs({ tasks, own }: SessionTasks, onDisk: Task[]): WaitingPr[] {
  const [first] = tasks;
  if (!own || first.main === undefined) return tasks.flatMap(waitingPr);
  return onDisk.some(waitsHere) ? treeOf(onDisk, first, first.main).flatMap(waitingPr) : [];
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').replace(/[.\s]+$/, '');

function outcomeLine(context: Context, task: Task, outcome: PrOutcome): string | undefined {
  const { slug } = task;
  switch (outcome.kind) {
    case 'merged':
      return markWaitingDone(context, task) ? `${slug}: PR merged; the task is done. Finalize it with the question from \`ledger task gate finalize ${slug}\`.` : undefined;
    case 'fix': {
      const why = outcome.checksFailed ? `PR checks failed${outcome.changesRequested ? ' and review asked for changes' : ''}` : 'PR review asked for changes';
      const moved = sendBackToBuild(context, task);
      return moved === undefined ? undefined : `${slug}: ${why}; the task is ${moved === 'build' ? 'back at build' : 'active again'}.`;
    }
    case 'closed':
      return `${slug}: PR closed without merging.`;
    case 'ready':
      return `${slug}: PR checks and review passed; ready to merge.`;
    case 'pending':
      return undefined;
  }
}

/**
 * Asks gh about the PR of each waiting task of the session, all at once, and acts on each answer: a merged PR makes its
 * task done, failed checks or a review that asks for changes send it back to build. Gives one line for each task that
 * needs the operator. `onDisk` is every task of the store, as the session start read them. Never throws: a failure is a
 * line too. Once gh is done, it sets this process's limit on lock waits and git calls in the clone anew, for the writes.
 */
export function prCheckLines(context: Context, session: SessionTasks, onDisk: Task[]): string[] {
  try {
    const waiting = waitingPrs(session, onDisk);
    if (waiting.length === 0) return [];
    const views = prViews(
      waiting.map(({ task, pr }) => ({ folder: task.main ?? context.cwd, pr })),
      prCheckMs,
    );
    const updatesEnd = Date.now() + prUpdateMs;
    limitLockWaits(updatesEnd);
    limitCloneGitCalls(updatesEnd);
    return waiting.flatMap(({ task }, index) => {
      const view = views[index];
      if ('error' in view) return [`${task.slug}: could not check the PR (${view.error}).`];
      try {
        return outcomeLine(context, task, prOutcome(view)) ?? [];
      } catch (error) {
        return [`${task.slug}: could not update the task (${messageOf(error)}).`];
      }
    });
  } catch (error) {
    return [`Could not check the PRs of the waiting tasks (${messageOf(error)}).`];
  }
}
