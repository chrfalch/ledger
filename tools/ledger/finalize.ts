import { fail } from './failure.js';
import { buildGate, FINALIZE_GATE, gateTask, type GateAction, type GateQuestion } from './gates.js';
import { repoKey } from './repo-key.js';
import { childrenOf, findNamed, inRepo, sameTask, type ChildView, type RepoOf, type Task } from './tasks.js';
import { currentTask, nextToStart, type Context } from './write.js';

// @ref LLP 0001#7-the-lifecycle — step 8, Finalize, and step 9, Up the tree (D21, D49).

type Ref = { slug: string; main: string };
type Linked = { task: Task; ref: Ref };

function retire({ store, cwd }: Context, task: Task): GateAction {
  const what = task.place === 'backlog' ? 'Archive its ledger' : 'Archive its ledger and remove its worktree and branch';
  const leaves = currentTask(store, cwd)?.file === task.file ? ' The session leaves the worktree first.' : '';
  return { label: `Retire ${task.slug}`, description: `${what}, once a dry run finds no problem.${leaves}` };
}

/**
 * The done tasks of the repo other than `task` and its parent, as one action, so the gate keeps to three (D33). A task
 * whose worktree is not on this machine is left out: retire refuses it here.
 */
function retireOthers(tasks: Task[], { task, ref }: Linked, parent: Ref | undefined): GateAction[] {
  const isParent = (each: Task): boolean => parent !== undefined && each.slug === parent.slug && inRepo(each, parent.main);
  const done = tasks
    .filter((each) => each.place === 'active' && !each.elsewhere && each.status === 'done' && inRepo(each, ref.main) && each.slug !== task.slug && !isParent(each))
    .map(({ slug }) => slug)
    .sort();
  if (done.length === 0) return [];
  const description =
    done.length === 1 ? `Retire ${done[0]} after a dry run finds no problem.` : `Retire ${done.slice(0, -1).join(', ')} and ${done.at(-1)}, each after a dry run finds no problem.`;
  return [{ label: 'Retire the other done tasks', description }];
}

const start = ({ slug }: Ref): GateAction => ({ label: `Start ${slug}`, description: `Start ${slug} with \`/ledger:go ${slug}\`, after any ticked retire.` });

/**
 * What comes next in the tree of a finished task: `child` while it has a child left, with the one to start if one can;
 * else `sibling`, the one to start; else `wait`, the siblings left before the parent finalizes; else `parent`, to finalize.
 */
export type NextInTree = { kind: 'child'; ref?: Ref } | { kind: 'sibling'; ref: Ref } | { kind: 'wait'; siblings: ChildView[] } | { kind: 'parent'; ref: Ref };

/** The parent `linked` names, at the main its parent line gives, else at the main `linked` is at. */
function parentRef({ task, ref }: Linked): Ref | undefined {
  const named = task.ledger.location.parent;
  return named && { slug: named.slug, main: named.main ?? ref.main };
}

/**
 * What comes next in the tree of `linked`, by the rule the finalize question and the session-start report both follow, so
 * the two never disagree. `linked.ref.main` is the checkout of the session: the task's children resolve against it.
 * `repoOf` tells the repo of a checkout: git for the gate, the store alone for the report.
 */
export function nextInTree(tasks: Task[], linked: Linked, repoOf: RepoOf): NextInTree | undefined {
  const left = (task: Task, main: string): ChildView[] => childrenOf(task, main, tasks, repoOf).filter(({ status }) => status !== 'retired');
  if (left(linked.task, linked.ref.main).length > 0) return { kind: 'child', ref: nextToStart(tasks, linked, undefined, repoOf) };
  const ref = parentRef(linked);
  const task = ref && findNamed(tasks, ref, repoOf).find(({ place }) => place !== 'archive');
  if (ref === undefined || task === undefined) return undefined;
  const sibling = nextToStart(tasks, { task, ref }, linked.ref, repoOf);
  if (sibling !== undefined) return { kind: 'sibling', ref: sibling };
  const siblings = left(task, ref.main).filter((child) => !sameTask(child, linked.ref, repoOf));
  return siblings.length > 0 ? { kind: 'wait', siblings } : { kind: 'parent', ref };
}

/** The gate's actions for `next`, what comes next in the tree of the task `slug`. */
function upTheTree(next: NextInTree | undefined, slug: string): GateAction[] {
  switch (next?.kind) {
    case 'child':
    case 'sibling':
      return next.ref === undefined ? [] : [start(next.ref)];
    case 'parent': {
      const parent = next.ref.slug;
      return [{ label: `Finalize ${parent}`, description: `With ${slug} retired, ${parent} has no child left. This question is then asked again for ${parent}.` }];
    }
    case 'wait':
    case undefined:
      return [];
  }
}

/**
 * The finalize question for the task `slug`, by default the task of the worktree `context.cwd` is in: retire it, retire
 * the other done tasks of its repo, and start or finalize what comes next in its tree. It runs no dry run itself.
 */
export function finalizeQuestion(context: Context, slug?: string): GateQuestion {
  const { task, ref, tasks } = gateTask(context, FINALIZE_GATE, slug);
  const linked = { task, ref };
  const parent = parentRef(linked);
  const next = nextInTree(tasks, linked, repoKey);
  const waitsForChildren = next?.kind === 'child';
  const actions = [
    ...(task.status === 'retired' || waitsForChildren ? [] : [retire(context, task)]),
    ...retireOthers(tasks, linked, parent),
    ...upTheTree(next, task.slug),
  ];
  if (actions.length === 0) fail(`${task.slug} has nothing left to finalize. No task is ready to retire or to start.`);
  return buildGate(
    {
      name: FINALIZE_GATE,
      header: 'Finalize',
      question: (subject) =>
        parent === undefined && !waitsForChildren ? `${subject} is finished. It is the top of its tree, so retiring it finishes the tree. What should happen next?` : `${subject} is finished. What should happen next?`,
      multiSelect: true,
      actions,
    },
    task.slug,
  );
}
