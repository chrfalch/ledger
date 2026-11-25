// @ref LLP 0001#9-awareness — D26 the report in a task folder, D27 the open trees outside one, D28 the status line.
import { isStatusValue, serializeLedger, type Claim } from './format.js';
import type { SessionLedgers } from './hooks.js';
import { isKind, STAGES } from './kinds.js';
import { samePath } from './paths.js';
import type { CheckedLine } from './pr-check.js';
import { parseRecord, type TaskRecord } from './record.js';
import { repoKey } from './repo-key.js';
import { dependenciesOf, dependencyTask, findNamed, inRepo, isDone, namedChildren, orderedChildren, storedRepoOf, type ListedChild, type RepoOf, type Task } from './tasks.js';
import { joined, plural } from './views.js';
import { shellWord } from './write.js';

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

/** The child's task, unless it is retired or has no ledger. */
const openTask = ({ line, task }: ListedChild): Task[] => (task !== undefined && task.place !== 'archive' && line.mark?.kind !== 'retired' ? [task] : []);

const isLive = ({ place, status }: Task): boolean => place !== 'archive' && status !== 'lost';

/**
 * The finalize gate of `task`, as `<slug>@<main>` when it is not a task of `repo`, the session's, so it names that repo's
 * task; the slug alone when the store knows no main checkout of its repo. A slug that starts with `-` follows `--`, or
 * the CLI would read it as an option.
 */
export function finalizeCommand(task: Task, repo: string): string {
  const { slug, main } = task;
  const ref = task.repoKeys.includes(repo) || main === undefined ? slug : shellWord(`${slug}@${main}`);
  return `ledger task gate finalize ${slug.startsWith('-') ? `-- ${ref}` : ref}`;
}

/** The tasks the report reads, and how it tells the repo of a checkout from them alone, as it runs no git in another repo. */
type Known = { tasks: Task[]; repoOf: RepoOf };

/** The children of `parent` that are not retired, by order. */
const openChildren = (parent: Task, { tasks, repoOf }: Known): Task[] =>
  parent.main === undefined ? [] : orderedChildren(parent, parent.main, tasks, undefined, repoOf).flatMap(openTask);

/**
 * The task `ledger tree next` would start under `parent`, by the rule of `nextToStart` but from the store alone: the
 * first backlog child, by order, that waits for no task not done; one with children of its own yields its first such child.
 */
function taskToStart(parent: Task, main: string | undefined, known: Known, seen: ReadonlySet<string> = new Set([parent.file])): Task | undefined {
  if (main === undefined) return undefined;
  for (const { ref, task } of orderedChildren(parent, main, known.tasks, undefined, known.repoOf)) {
    if (task?.place !== 'backlog' || seen.has(task.file)) continue;
    if (dependenciesOf(task).some((dependency) => !isDone(dependencyTask(known.tasks, dependency)))) continue;
    const next = namedChildren(task, known.tasks).length === 0 ? task : taskToStart(task, ref.main, known, new Set([...seen, task.file]));
    if (next !== undefined) return next;
  }
  return undefined;
}

/** What follows the last open child `task`, as the finalize question offers it: a task to start, the siblings to retire first, or the parent. */
function afterLastChild(task: Task, parent: Task, unretired: Task[], known: Known): string {
  const next = taskToStart(parent, parent.main, known);
  if (next !== undefined) return `Then: ${next.slug} (${next.status})`;
  const open = unretired.filter(({ file }) => file !== task.file).map(({ slug, status }) => `${slug} (${status})`);
  return open.length === 0 ? 'Then: last child: the parent finalizes next' : `Then: last open child: ${joined(open)} must be retired, then the parent finalizes next`;
}

/** A task on the path up from the session's task; `found` is undefined for a parent no ledger has. */
type Ancestor = { slug: string; found?: Task };

/** The parent `task` names, an active task first. */
function parentOf(task: Task, { tasks, repoOf }: Known): Ancestor | undefined {
  const parent = task.ledger.location.parent;
  if (parent === undefined) return undefined;
  const main = parent.main ?? task.main;
  const named = main === undefined ? [] : findNamed(tasks, { slug: parent.slug, main }, repoOf);
  const found = named.find(({ place }) => place === 'active') ?? named[0];
  return found === undefined ? { slug: parent.slug } : { slug: parent.slug, found };
}

/** The parents of `task`, nearest first, up to the root or to a task already on the path. */
function ancestorsOf(task: Task, known: Known): Ancestor[] {
  const seen = new Set([task.file]);
  const path: Ancestor[] = [];
  for (let parent = parentOf(task, known); parent !== undefined; parent = parent.found && parentOf(parent.found, known)) {
    if (parent.found !== undefined && seen.has(parent.found.file)) break;
    path.push(parent);
    if (parent.found !== undefined) seen.add(parent.found.file);
  }
  return path;
}

/** `root` and every task below it, each once. */
function treeOf(root: Task, known: Known): Task[] {
  const seen = new Map<string, Task>();
  const visit = (task: Task): void => {
    if (seen.has(task.file)) return;
    seen.set(task.file, task);
    for (const child of openChildren(task, known)) visit(child);
  };
  visit(root);
  return [...seen.values()];
}

/** Each task once, where it first comes. */
const uniqueTasks = (tasks: Task[]): Task[] => [...new Map(tasks.map((task) => [task.file, task])).values()];

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
  const unretired = parent === undefined ? [] : openChildren(parent, known);
  const children = unretired.filter(isLive);
  const at = children.findIndex(({ file }) => file === task.file);
  const siblings = children.filter(({ file }) => file !== task.file);
  const parents = ancestors.flatMap(({ found }) => found ?? []);
  const root = parents.at(-1) ?? task;
  const related = uniqueTasks([task, ...parents, ...treeOf(root, known), ...treeOf(task, known)]);

  const questions = record.questions
    .filter(({ resolved }) => !resolved)
    .map(({ id, text, blocks }) => `- Question ${id}: ${firstLine(text)}${blocks === undefined ? '' : ` (blocks step ${blocks})`}`);
  const blocked = [task, ...parents, ...siblings].flatMap(({ slug, status, ledger }) => {
    const detail = ledger.location.status?.detail;
    return status === 'blocked' ? [`- Blocked: ${slug}${detail === undefined ? '' : ` — ${firstLine(detail)}`}`] : [];
  });
  const advised = new Set(checked.flatMap(({ done }) => done ?? []));
  const done = related
    .filter(({ status, file }) => status === 'done' && !advised.has(file))
    .map((each) => `- ${each.ledger.location.pr === undefined ? 'Done' : 'PR merged'}: ${each.slug} — finalize with the question from \`${finalizeCommand(each, repo)}\``);
  const held = related.flatMap((each) => {
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
  const following = at === -1 ? undefined : children[at + 1];
  return [
    header(task, record),
    ...(needs.length === 0 ? ['Needs you: nothing.'] : needsSection(needs, ITEM_CAP)),
    ancestors.length === 0 ? `Where: ${path} (no parent)` : `Where: ${path}`,
    ...(siblings.length === 0 ? [] : [`Siblings: ${siblingStates.join(', ')}`]),
    nextLine(task),
    ...(at === -1 || parent === undefined ? [] : [following === undefined ? afterLastChild(task, parent, unretired, known) : `Then: ${following.slug} (${following.status})`]),
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
  const listedByParent = (task: Task): boolean => {
    const parent = parentOf(task, known)?.found;
    return parent !== undefined && inRepo(parent, main, known.repoOf) && openChildren(parent, known).some(({ file }) => file === task.file);
  };
  const roots = new Map<string, Task>();
  for (const task of here) {
    if (listedByParent(task)) continue;
    const kept = roots.get(task.slug);
    if (kept === undefined || rank(task) < rank(kept) || (rank(task) === rank(kept) && task.mtimeMs > kept.mtimeMs)) roots.set(task.slug, task);
  }
  const heads = [...roots.values()].filter((root) => treeOf(root, known).some(isLive));
  const shown = new Set(heads.flatMap((head) => treeOf(head, known)).map(({ file }) => file));
  // Parents that list each other in a loop leave no root; their live tasks still head a tree.
  for (const task of here) {
    if (!isLive(task) || shown.has(task.file)) continue;
    heads.push(task);
    for (const { file } of treeOf(task, known)) shown.add(file);
  }
  const needs = needsSection(checked.map(checkedItem), TREES_NEEDS_CAP);
  if (heads.length === 0) {
    return [...needs, 'No open task trees in this repo.', 'Ask the operator in one question widget: make a new task, or quick work (a small change with no task).'].join('\n');
  }
  const lines = heads
    .sort((a, b) => rank(a) - rank(b) || a.slug.localeCompare(b.slug))
    .map((head) => {
      const children = openChildren(head, known).filter(isLive).length;
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
