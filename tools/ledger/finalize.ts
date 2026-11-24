import { fail } from './failure.js';
import { buildGate, FINALIZE_GATE, type GateAction, type GateQuestion } from './gates.js';
import { childrenOf, findNamed, findTasks, inRepo, sameTask, taskRef, theTask, type Task } from './tasks.js';
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

/** What comes next in the tree: a child of `task` while it has any left, else a sibling to start or the parent to finalize. */
function upTheTree(tasks: Task[], linked: Linked, waitsForChildren: boolean, parent: Linked | undefined): GateAction[] {
  if (waitsForChildren) {
    const child = nextToStart(tasks, linked);
    return child === undefined ? [] : [start(child)];
  }
  if (parent === undefined) return [];
  const sibling = nextToStart(tasks, parent, linked.ref);
  if (sibling !== undefined) return [start(sibling)];
  const siblings = childrenOf(parent.task, parent.ref.main, tasks).filter((child) => !sameTask(child, linked.ref));
  if (siblings.some(({ status }) => status !== 'retired')) return [];
  const [slug, parentSlug] = [linked.task.slug, parent.ref.slug];
  return [{ label: `Finalize ${parentSlug}`, description: `With ${slug} retired, ${parentSlug} has no child left. This question is then asked again for ${parentSlug}.` }];
}

/**
 * The finalize question for the task `slug`, by default the task of the worktree `context.cwd` is in: retire it, retire
 * the other done tasks of its repo, and start or finalize what comes next in its tree. It runs no dry run itself.
 */
export function finalizeQuestion(context: Context, slug?: string): GateQuestion {
  const name = slug ?? currentTask(context.store, context.cwd)?.slug ?? fail('No task has the worktree you are in, so name one: ledger task gate finalize <slug>');
  const ref = taskRef(context.cwd, name);
  const tasks = findTasks(context.store);
  const linked = { task: theTask(tasks, ref), ref };
  const { task } = linked;
  const named = task.ledger.location.parent;
  const parentRef = named && { slug: named.slug, main: named.main ?? ref.main };
  const parentTask = parentRef && findNamed(tasks, parentRef).find(({ place }) => place !== 'archive');
  const parent = parentRef && parentTask && { task: parentTask, ref: parentRef };
  const waitsForChildren = childrenOf(task, ref.main, tasks).some(({ status }) => status !== 'retired');
  const actions = [
    ...(task.status === 'retired' || waitsForChildren ? [] : [retire(context, task)]),
    ...retireOthers(tasks, linked, parentRef),
    ...upTheTree(tasks, linked, waitsForChildren, parent),
  ];
  if (actions.length === 0) fail(`${task.slug} has nothing left to finalize. No task is ready to retire or to start.`);
  return buildGate(
    {
      name: FINALIZE_GATE,
      header: 'Finalize',
      question: (subject) =>
        named === undefined && !waitsForChildren ? `${subject} is finished. It is the top of its tree, so retiring it finishes the tree. What should happen next?` : `${subject} is finished. What should happen next?`,
      multiSelect: true,
      actions,
    },
    task.slug,
  );
}
