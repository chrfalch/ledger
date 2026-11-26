// @ref LLP 0001#9-awareness — D26 the report in a task folder, D27 the open trees outside one, D28 the status line.
import { nextInTree, type NextInTree } from './finalize.js';
import { isStatusValue, serializeLedger, type Claim } from './format.js';
import type { SessionLedgers } from './hooks.js';
import { isKind, STAGES } from './kinds.js';
import { samePath } from './paths.js';
import type { CheckedLine } from './pr-check.js';
import { parseRecord, type TaskRecord } from './record.js';
import { repoKey } from './repo-key.js';
import { findNamed, inRepo, orderedChildren, storedRepoOf, type ListedChild, type RepoOf, type Task } from './tasks.js';
import { joined, plural } from './views.js';
import { gateCommand } from './write.js';

/** The live claim of another session on a task, if any. */
export type HeldElsewhere = (task: Task) => Claim | undefined;

const ITEM_CAP = 5;
const SIBLING_CAP = 8;
const TREE_CAP = 12;
/** The report is read again on every turn, so it stays within this many lines. */
const REPORT_LINES = 20;

const recordOf = (task: Task): TaskRecord => parseRecord(serializeLedger(task.ledger));

/** A record with no kind is code, and one with no stage is at the first stage of its kind. */
function stageOf({ kind = 'code', stage }: TaskRecord): { kind: string; stage: string } {
  return { kind, stage: stage ?? (isKind(kind) ? STAGES[kind][0] : 'unknown') };
}

/** `items` as list lines, the first `cap` of them and then how many more. */
function capped(items: readonly string[], cap: number, more = (count: number): string => `- +${count} more`): string[] {
  return items.length <= cap ? [...items] : [...items.slice(0, cap), more(items.length - cap)];
}

const isLive = ({ place, status }: Task): boolean => place !== 'archive' && status !== 'lost';

/**
 * How to finalize `task`, found at the main checkout `main`, as words after "finalize": with the question `gateCommand`
 * names. When another repo's task has no known main, its slug alone would name a task of the session's repo, so the
 * gate is to be asked from a checkout of its own.
 */
export function finalizeAdvice(task: Task, repo: string, main = task.main): string {
  const gate = `with the question from \`${gateCommand('finalize', task, repo, main)}\``;
  return main === undefined && !task.repoKeys.includes(repo) ? `from a checkout of its repo, ${gate}` : gate;
}

/** The tasks the report reads, and how it tells the repo of a checkout from them alone, as it runs no git in another repo. */
type Known = { tasks: Task[]; repoOf: RepoOf };

type OpenChild = ListedChild & { task: Task };

/** A child is open while its ledger is: finalize reads the ledger, and the mark on the child's line is only a hint. */
const isOpen = (child: ListedChild): child is OpenChild => child.task !== undefined && child.task.place !== 'archive';

/**
 * The open children of `parent` at `main`, by order. Each child's `ref.main` is where its line puts it, which is the main
 * its own children resolve against, as finalize resolves them: a record may name its main as a relative path.
 */
const openChildren = (parent: Task, main: string | undefined, { tasks, repoOf }: Known): OpenChild[] =>
  main === undefined ? [] : orderedChildren(parent, main, tasks, undefined, repoOf).filter(isOpen);

/** The Then line for `next`, what the finalize question offers next in the tree; `last` is whether no live child follows the task. */
function thenLine(next: NextInTree | undefined, last: boolean, { tasks, repoOf }: Known): string | undefined {
  switch (next?.kind) {
    case 'child':
    case 'sibling': {
      if (next.ref === undefined) return undefined;
      const status = findNamed(tasks, next.ref, repoOf).at(0)?.status ?? 'missing';
      return `Then: ${next.ref.slug} (${status})`;
    }
    case 'wait': {
      const named = joined(capped(next.siblings.map(({ slug, status }) => `${slug} (${status})`), SIBLING_CAP, (count) => `${count} more`));
      return `Then: ${last ? 'last open child: ' : ''}${named} must be retired, then the parent finalizes next`;
    }
    case 'parent':
      return 'Then: last child: the parent finalizes next';
    case undefined:
      return undefined;
  }
}

/**
 * A task and the main checkout it was found at, undefined when none is known. Its children resolve against that main, and
 * its finalize advice names it: the main its record names may be relative or stale.
 */
type Placed = { task: Task; main?: string };

/** A task on the path up from the session's task; `found` is undefined for a parent no ledger has. */
type Ancestor = { slug: string; found?: Placed };

/** The parent `task` names, an active task first, at the main its parent line gives, else at `main`, where `task` was found. */
function parentOf(task: Task, main: string | undefined, { tasks, repoOf }: Known): Ancestor | undefined {
  const parent = task.ledger.location.parent;
  if (parent === undefined) return undefined;
  const at = parent.main ?? main;
  const named = at === undefined ? [] : findNamed(tasks, { slug: parent.slug, main: at }, repoOf);
  const found = named.find(({ place }) => place === 'active') ?? named[0];
  return found === undefined || at === undefined ? { slug: parent.slug } : { slug: parent.slug, found: { task: found, main: at } };
}

/** The parents of `task`, nearest first, up to the root or to a task already on the path. */
function ancestorsOf(task: Task, known: Known): Ancestor[] {
  const seen = new Set([task.file]);
  const path: Ancestor[] = [];
  for (let parent = parentOf(task, task.main, known); parent !== undefined; parent = parent.found && parentOf(parent.found.task, parent.found.main, known)) {
    if (parent.found !== undefined && seen.has(parent.found.task.file)) break;
    path.push(parent);
    if (parent.found !== undefined) seen.add(parent.found.task.file);
  }
  return path;
}

/** `root`, found at `main`, and every task below it, each once, each at the main its line gives. */
function treeOf(root: Task, main: string | undefined, known: Known): Placed[] {
  const seen = new Map<string, Placed>();
  const visit = (task: Task, at: string | undefined): void => {
    if (seen.has(task.file)) return;
    seen.set(task.file, { task, main: at });
    for (const child of openChildren(task, at, known)) visit(child.task, child.ref.main);
  };
  visit(root, main);
  return [...seen.values()];
}

/** Each task once, at the main where it first comes. */
const uniqueTasks = (placed: Placed[]): Placed[] => placed.filter(({ task }, index) => placed.findIndex((each) => each.task.file === task.file) === index);

/** A text of several lines would break the report's line cap, so an item shows only its first line. */
const firstLine = (text: string): string => text.split('\n', 1)[0];

const item = (line: string): string => `- ${firstLine(line)}`;

const checkedItem = ({ text }: CheckedLine): string => item(text);

/** The Needs you heading over the first `cap` of `items`; nothing for no item. */
const needsSection = (items: readonly string[], cap: number): string[] => (items.length === 0 ? [] : ['Needs you:', ...capped(items, cap)]);

function header(task: Task, record: TaskRecord): string {
  const { kind, stage } = stageOf(record);
  const where = task.worktree === undefined ? '' : ` in ${task.worktree}`;
  return `Task ${task.slug}${where} — ${task.status}, stage ${stage} (${kind}). Details: \`ledger show\`. Write with \`ledger notes\`, never by editing a file.`;
}

const nextLine = (task: Task): string => `Next: ${task.ledger.next || 'none written'}`;

/** The report for the one task a folder owns: what needs the operator, where the task is in its tree, and what comes next. */
function taskReport(task: Task, tasks: Task[], heldElsewhere: HeldElsewhere, checked: readonly CheckedLine[]): string[] {
  const record = recordOf(task);
  const repo = task.currentRepo ?? task.repo;
  const known: Known = { tasks, repoOf: storedRepoOf(tasks, task.main === undefined ? undefined : { main: task.main, key: repo }) };
  const ancestors = ancestorsOf(task, known);
  const parent = ancestors[0]?.found;
  const listed = parent === undefined ? [] : openChildren(parent.task, parent.main, known);
  const children = listed.map((child) => child.task).filter(isLive);
  const at = children.findIndex(({ file }) => file === task.file);
  const siblings = children.filter(({ file }) => file !== task.file);
  const placedParents = ancestors.flatMap(({ found }) => found ?? []);
  const parents = placedParents.map((each) => each.task);
  const root = placedParents.at(-1);
  const related = uniqueTasks([{ task, main: task.main }, ...placedParents, ...(root === undefined ? [] : treeOf(root.task, root.main, known)), ...treeOf(task, task.main, known)]);

  const questions = record.questions
    .filter(({ resolved }) => !resolved)
    .map(({ id, text, blocks }) => `- Question ${id}: ${firstLine(text)}${blocks === undefined ? '' : ` (blocks step ${blocks})`}`);
  const blocked = [task, ...parents, ...siblings].flatMap(({ slug, status, ledger }) => {
    const detail = ledger.location.status?.detail;
    return status === 'blocked' ? [`- Blocked: ${slug}${detail === undefined ? '' : ` — ${firstLine(detail)}`}`] : [];
  });
  const advised = new Set(checked.flatMap(({ done }) => done ?? []));
  const done = related
    .filter(({ task: { status, file } }) => status === 'done' && !advised.has(file))
    .map(({ task: each, main }) => `- ${each.ledger.location.pr === undefined ? 'Done' : 'PR merged'}: ${each.slug} — finalize ${finalizeAdvice(each, repo, main)}`);
  const held = related.flatMap(({ task: each }) => {
    const claim = heldElsewhere(each);
    return claim === undefined ? [] : [`- Held by another session: ${each.slug} (${claim.session} since ${claim.since})`];
  });
  const needs = [...checked.map(checkedItem), ...done, ...questions, ...blocked, ...held];

  const path = [...ancestors.map(({ slug }) => slug).reverse(), `**${task.slug}**`].join(' › ');
  const siblingStates = capped(
    siblings.map(({ slug, status }) => `${slug} ${status}`),
    SIBLING_CAP,
    (count) => `+${count} more`,
  );
  const next = at === -1 || task.main === undefined ? undefined : nextInTree(tasks, { task, ref: { slug: task.slug, main: task.main } }, known.repoOf);
  const then = thenLine(next, at === children.length - 1, known);
  return [
    header(task, record),
    ...(needs.length === 0 ? ['Needs you: nothing.'] : needsSection(needs, ITEM_CAP)),
    ancestors.length === 0 ? `Where: ${path} (no parent)` : `Where: ${path}`,
    ...(siblings.length === 0 ? [] : [`Siblings: ${siblingStates.join(', ')}`]),
    nextLine(task),
    ...(then === undefined ? [] : [then]),
  ];
}

/** Each task of a folder that owns several, with its Next step; the operator picks one. */
function choiceReport(ledgers: Task[], checked: readonly CheckedLine[]): string[] {
  const needs = needsSection(checked.map(checkedItem), ITEM_CAP);
  // Two lines a task, and room for the line that says how many more and the question.
  const fits = Math.floor((REPORT_LINES - needs.length - 2) / 2);
  const more = ledgers.length > fits ? [`+${ledgers.length - fits} more`] : [];
  return [...needs, ...ledgers.slice(0, fits).flatMap((task) => [header(task, recordOf(task)), nextLine(task)]), ...more, 'Ask the operator which task to continue.'];
}

/**
 * The SessionStart report for the ledgers a folder owns (D26). `tasks` are all known tasks, for the tree; `heldElsewhere`
 * gives the live claim of another session; `checked` is what the PR check of the session start found, a line each.
 */
export function sessionReport({ tasks: ledgers }: SessionLedgers, tasks: Task[], heldElsewhere: HeldElsewhere, checked: readonly CheckedLine[] = []): string {
  return (ledgers.length === 1 ? taskReport(ledgers[0], tasks, heldElsewhere, checked) : choiceReport(ledgers, checked)).join('\n');
}

const PLACE_ORDER: Task['place'][] = ['active', 'backlog', 'archive'];
const rank = ({ place }: Task): number => PLACE_ORDER.indexOf(place);

/** What the PR check found comes first; past this many items it leaves the trees room for their heading, one tree, how many more and the question. */
const TREES_NEEDS_CAP = REPORT_LINES - 6;

/**
 * The open trees of the repo at `main`, for a session outside any task (D27), under what the PR check found (`checked`):
 * each root task that is live or has a live task below it; a lost task is not live. A task heads a tree unless its parent
 * in this repo lists it as a child, so a live task under a missing, lost or forgetful parent is never hidden. An active
 * task lives only in a linked worktree, so a record that names the main checkout is none.
 */
export function openTreesReport(tasks: Task[], main: string, checked: readonly CheckedLine[] = []): string {
  const known: Known = { tasks, repoOf: storedRepoOf(tasks, { main, key: repoKey(main) }) };
  const here = tasks.filter((task) => inRepo(task, main, known.repoOf) && !(task.place === 'active' && task.worktree !== undefined && samePath(task.worktree, main)));
  // Every task of `here` is of the repo at `main`, so each walk below starts at `main`, never at a main a record names, which may be relative.
  const listedByParent = (task: Task): boolean => {
    const parent = parentOf(task, main, known)?.found;
    return parent !== undefined && inRepo(parent.task, main, known.repoOf) && openChildren(parent.task, parent.main, known).some((child) => child.task.file === task.file);
  };
  const roots = new Map<string, Task>();
  for (const task of here) {
    if (listedByParent(task)) continue;
    const kept = roots.get(task.slug);
    if (kept === undefined || rank(task) < rank(kept) || (rank(task) === rank(kept) && task.mtimeMs > kept.mtimeMs)) roots.set(task.slug, task);
  }
  const heads = [...roots.values()].filter((root) => treeOf(root, main, known).some(({ task }) => isLive(task)));
  const shown = new Set(heads.flatMap((head) => treeOf(head, main, known)).map(({ task }) => task.file));
  // Parents that list each other in a loop leave no root; their live tasks still head a tree.
  for (const task of here) {
    if (!isLive(task) || shown.has(task.file)) continue;
    heads.push(task);
    for (const { task: { file } } of treeOf(task, main, known)) shown.add(file);
  }
  const needs = needsSection(checked.map(checkedItem), TREES_NEEDS_CAP);
  if (heads.length === 0) {
    return [...needs, 'No open task trees in this repo.', 'Ask the operator in one question widget: make a new task, or quick work (a small change with no task).'].join('\n');
  }
  const lines = heads
    .sort((a, b) => rank(a) - rank(b) || a.slug.localeCompare(b.slug))
    .map((head) => {
      const children = openChildren(head, main, known).filter((child) => isLive(child.task)).length;
      return `- ${head.slug} ${head.status}${children === 0 ? '' : ` — ${plural(children, 'open child', 'open children')}`}`;
    });
  return [
    ...needs,
    'Open task trees in this repo:',
    ...capped(lines, Math.min(TREE_CAP, REPORT_LINES - needs.length - 3), (count) => `- +${count} more — \`ledger list\``),
    'Ask the operator in one question widget: continue one of these trees (name it), make a new task, or quick work (a small change with no task).',
  ].join('\n');
}

/** The status line text of a folder (D28): its task and stage, and its state unless plain active; empty when it owns none. */
export function statusLineText({ tasks, own }: SessionLedgers): string {
  if (!own || tasks.length === 0) return '';
  if (tasks.length > 1) return `${tasks.length} tasks`;
  const [task] = tasks;
  const { stage } = stageOf(recordOf(task));
  return `${task.slug} · ${stage}${isStatusValue(task.status) ? ` · ${task.status}` : ''}`;
}
