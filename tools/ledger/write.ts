import path from 'node:path';
import { addChild, addDecision, addLocationBullet, fillLedger, markStarted, park, removeChildren, removeLine, unpark } from './edit.js';
import { fail } from './failure.js';
import { exists, isFolder, readText, writeAtomic } from './files.js';
import { isNewSlug, isReadableSlug, parseLedger, type Child, type TaskRef } from './format.js';
import {
  addWorktree,
  branchExists,
  checkoutRoot,
  commitOf,
  commonDir,
  currentBranch,
  isBranchName,
  mainCheckout,
  originHead,
  removeWorktree,
  shortCommit,
} from './git.js';
import { repoName, samePath, taskWorktree, worktreeLedger, type LedgerPaths } from './paths.js';
import { loadTasks } from './registry.js';
import type { LedgerStore } from './store.js';
import { findNamed, locateChild, namedChildren, notASlug, sameTask, taskRef, theTask, wasChildOf, type Task } from './tasks.js';

type Ref = Required<TaskRef>;
export type Context = { paths: LedgerPaths; cwd: string; store: LedgerStore };

/** A backlog ledger is in the store; a worktree ledger is the plain file that hooks read. */
export function readLedger({ store }: Context, task: Task): string {
  if (task.place === 'worktree') return readText(task.file);
  const collection = task.place === 'backlog' ? store.backlog : store.archive;
  return (collection.read(task.repo, task.name) ?? fail(`The ledger ${task.file} is gone.`)).text;
}

export function saveLedger({ store }: Context, task: Task, text: string): void {
  if (task.place === 'worktree') writeAtomic(task.file, text);
  else if (task.place === 'backlog') store.backlog.write(task.repo, task.name, text);
  else throw new Error(`An archive copy is never changed: ${task.file}`);
}

/** The local date, as the old scripts wrote it. */
export function today(): string {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, '0')).join('-');
}

const oneLine = (text: string): string => text.trim().split(/\s+/).join(' ');

/** `text` as one shell word: unchanged when no character needs quoting, else in single quotes. */
const shellWord = (text: string): string => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`);

const slugRule = (slug: string): string =>
  `"${slug}" cannot name a new task. A new slug starts with a lowercase letter or digit and has only lowercase letters, digits and hyphens.`;

function repoOf(cwd: string, folder = cwd): string {
  return mainCheckout(folder) ?? fail(`${folder} is not inside a git repository.`);
}

/** `<slug>` when the task is in the repo of `cwd`, else `<slug>@<main>`, the form every command takes. */
function nameFrom(cwd: string) {
  const here = mainCheckout(cwd);
  return ({ slug, main }: Ref): string => (here !== undefined && samePath(here, main) ? slug : `${slug}@${main}`);
}

/** How the ledger of a task in `fromMain` names `ref` in a line: `<slug>`, or `<slug> @ <main>` in another repo. */
const linkFrom = (fromMain: string, ref: Ref): string => (samePath(fromMain, ref.main) ? ref.slug : `${ref.slug} @ ${ref.main}`);

/** The ledger this command runs in: the one of the linked worktree that holds `cwd`. A main checkout has none. */
function currentLedger(cwd: string): string | undefined {
  const root = checkoutRoot(cwd);
  const main = mainCheckout(cwd);
  if (root === undefined || main === undefined || samePath(root, main)) return undefined;
  const file = worktreeLedger(root);
  return exists(file) ? file : undefined;
}

/** The registry is a cache of the disk; rebuilding it after a write keeps it in line. */
const refreshRegistry = (context: Context, mains: string[]): void => void loadTasks(context, mains);

function readTemplate(paths: LedgerPaths): string {
  const file = path.join(paths.home, '.claude', 'ledger.template.md');
  try {
    return readText(file);
  } catch {
    return fail(`No ledger template at ${paths.tilde(file)}. Run ledger deploy to install it.`);
  }
}

/** A repo with an llp/ folder records its design refs; `none` until a task names some. */
const designRefs = (root: string): string | null => (isFolder(path.join(root, 'llp')) ? 'none' : null);

function checkTarget(main: string, slug: string, branch: string): void {
  if (!isBranchName(main, branch)) fail(`${branch} is not a valid branch name.`);
  if (branchExists(main, branch)) fail(`The branch ${branch} already exists in ${main}.`);
  const folder = taskWorktree(main, slug);
  if (exists(folder)) fail(`The folder ${folder} already exists.`);
}

/** info/exclude is shared by every worktree of the repo and never committed. */
function excludeEvidence(main: string): void {
  const common = commonDir(main);
  if (common === undefined) return;
  const exclude = path.join(common, 'info', 'exclude');
  const current = exists(exclude) ? readText(exclude) : '';
  if (current.split('\n').includes('.claude/evidence/')) return;
  try {
    writeAtomic(exclude, `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}.claude/evidence/\n`);
  } catch {
    console.error(`warning: .claude/evidence/ was not added to ${exclude}`);
  }
}

const short = (folder: string, commit: string): string => shortCommit(folder, commit) ?? commit.slice(0, 7);

type Started = { worktree: string; branch: string; base: string; ledger: string };

const startedLines = ({ worktree, branch, base, ledger }: Started): string[] => [`worktree ${worktree}`, `branch   ${branch}`, `base     ${base}`, `ledger   ${ledger}`];

/**
 * A new branch at `base` in the worktree <main>/.claude/worktrees/<slug>, with the ledger `ledgerText` makes from the
 * Location values. `moved` runs once the ledger is written. Any failure removes the worktree and branch again.
 */
function startWorktree(main: string, slug: string, branch: string, base: string, ledgerText: (started: Started) => string, moved = (): void => {}): Started {
  const commit = commitOf(main, base) ?? fail(`${base} names no commit in ${main}.`);
  checkTarget(main, slug, branch);
  const worktree = taskWorktree(main, slug);
  const error = addWorktree(main, worktree, branch, commit);
  if (error !== undefined) fail(`Could not make the worktree ${worktree}: ${error}`);
  const started = { worktree, branch, base: `${base} @ ${short(main, commit)}`, ledger: worktreeLedger(worktree) };
  try {
    writeAtomic(started.ledger, ledgerText(started));
    moved();
  } catch (error) {
    removeWorktree(main, worktree, branch);
    throw error;
  }
  excludeEvidence(main);
  return started;
}

export type TaskOptions = { goal?: string; stack?: boolean; here?: boolean; repo?: string };

export function createTask(context: Context, slug: string | undefined, { goal: rawGoal, stack = false, here = false, repo }: TaskOptions): string {
  const { paths, cwd, store } = context;
  if (here && stack) fail('--here adds a ledger to this worktree, so it takes no --stack.');
  if (here && repo !== undefined) fail('--here adds a ledger to this worktree, so it takes no --repo.');
  if (stack && repo !== undefined) fail('--stack builds on the current branch, so it takes no --repo.');
  if (slug !== undefined && !isNewSlug(slug)) fail(slugRule(slug));
  const goal = rawGoal === undefined || oneLine(rawGoal) === '' ? undefined : oneLine(rawGoal);
  if (here) return hereTask(context, slug, goal);
  if (slug === undefined) return fail('ledger task needs a slug, or --here for this worktree.');

  const main = repoOf(cwd, repo === undefined ? cwd : path.resolve(cwd, repo));
  const template = readTemplate(paths);
  const repoFolder = repoName(main);
  const backlog = store.backlog.location(repoFolder, slug);
  if (store.backlog.has(repoFolder, slug)) fail(`A backlog task ${slug} already exists: ${paths.tilde(backlog)}`);
  const current = currentLedger(cwd);
  let lines: string[];
  if (stack) {
    const base = currentBranch(cwd) ?? fail(`--stack needs a branch, but HEAD is detached in ${cwd}.`);
    const root = checkoutRoot(cwd) ?? cwd;
    const started = startWorktree(main, slug, slug, base, (filled) => fillLedger(template, { slug, goal, ...filled, designRefs: designRefs(root) }));
    lines = startedLines(started);
  } else {
    checkTarget(main, slug, slug);
    store.backlog.write(repoFolder, slug, fillLedger(template, { slug, goal, main, designRefs: designRefs(main) }));
    lines = [`ledger:  ${backlog}`, 'status:  backlog'];
  }
  const cwdMain = mainCheckout(cwd);
  const [named, start] = cwdMain !== undefined && samePath(cwdMain, main) ? [slug, `/ledger:go ${slug}`] : [`${slug} in ${main}`, `ledger go ${slug} --repo ${shellWord(main)}`];
  if (current !== undefined) {
    writeAtomic(current, addDecision(readText(current), `- New task ${named}: separate work, not part of this goal. ${start} starts it.`));
    lines.push(`${stack ? 'noted   ' : 'noted:  '} ${current}`);
  }
  refreshRegistry(context, [main]);
  return [...lines, `start:   ${start}`].join('\n');
}

function hereTask(context: Context, given: string | undefined, goal: string | undefined): string {
  const { paths, cwd } = context;
  const main = repoOf(cwd);
  const worktree = checkoutRoot(cwd) ?? fail(`${cwd} is not inside a git repository.`);
  if (samePath(worktree, main)) fail(`--here needs a linked worktree, and ${cwd} is in the main checkout. A ledger lives only in a linked worktree.`);
  const ledger = worktreeLedger(worktree);
  if (exists(ledger)) fail(`This worktree already has a ledger: ${ledger}`);
  const branch = currentBranch(cwd);
  const slug = given ?? (branch?.split('/').at(-1) || path.basename(worktree));
  if (!isNewSlug(slug)) fail(`${slugRule(slug)} Name it: ledger task --here <slug>`);
  const commit = commitOf(cwd, 'HEAD') ?? fail(`This worktree has no commit yet: ${worktree}`);
  const started: Started = { worktree, branch: branch ?? 'detached HEAD', base: `HEAD @ ${short(cwd, commit)}`, ledger };
  writeAtomic(ledger, fillLedger(readTemplate(paths), { slug, goal, ...started, designRefs: designRefs(worktree) }));
  excludeEvidence(main);
  refreshRegistry(context, [main]);
  return startedLines(started).join('\n');
}

/**
 * Exit codes as the old promote had them: 2 no backlog task, 3 a task of another repo, 4 a ledger that names no repo.
 * The slug names a backlog ledger that exists, so the reading rule applies, not the rule for a new slug.
 */
export function goTask(context: Context, slug: string, repo: string | undefined): string {
  const { cwd, store } = context;
  if (!isReadableSlug(slug)) fail(notASlug(slug));
  const main = repoOf(cwd, repo === undefined ? cwd : path.resolve(cwd, repo));
  const backlog = store.backlog.read(repoName(main), slug) ?? fail(`No backlog task ${slug} for the repo at ${main}.`, 2);
  const { text } = backlog;
  const { location } = parseLedger(text);
  const owner = location.main ?? fail(`The backlog ledger ${backlog.location} has no "- main:" line, so its repo is unknown.`, 4);
  if (!samePath(owner, main)) fail(`The backlog task ${slug} belongs to the repo at ${owner}. Run: ledger go ${slug} --repo ${shellWord(owner)}`, 3);
  const base = location.base?.ref ?? originHead(main) ?? currentBranch(main) ?? fail(`${main} has no origin/HEAD and a detached HEAD, so there is no branch to start from.`);
  const started = startWorktree(
    main,
    slug,
    location.branch ?? slug,
    base,
    ({ worktree, branch, base: from }) => fillLedger(text, { slug, worktree, branch, base: from }),
    () => store.backlog.remove(backlog.repo, backlog.name),
  );
  refreshRegistry(context, [main]);
  return startedLines(started).join('\n');
}

function liveTask(context: Context, name: string): Linked & { tasks: Task[] } {
  const ref = taskRef(context.cwd, name);
  const tasks = loadTasks(context, [ref.main]);
  return { task: theTask(tasks, ref, { live: true }), ref, tasks };
}

export function parkTask(context: Context, name: string, reason: string): string {
  if (oneLine(reason) === '') fail('A parked task needs a reason: ledger park <slug> --reason <text>');
  const { task, ref } = liveTask(context, name);
  const marker = `Parked: ${today()} — ${oneLine(reason)}`;
  saveLedger(context, task, park(readLedger(context, task), marker));
  refreshRegistry(context, [ref.main]);
  return `Parked ${ref.slug}. ${marker}`;
}

export function unparkTask(context: Context, name: string): string {
  const { task, ref } = liveTask(context, name);
  const { parked } = task.ledger;
  if (parked === undefined) return `${ref.slug} is not parked.`;
  saveLedger(context, task, unpark(readLedger(context, task)));
  refreshRegistry(context, [ref.main]);
  return `Unparked ${ref.slug}. It was parked on ${parked.date}${parked.reason ? `: ${parked.reason}` : ''}.`;
}

export const PARENT_ACTIONS = ['add', 'remove', 'start', 'next'] as const;
export type ParentAction = (typeof PARENT_ACTIONS)[number];

const isParentAction = (action: string): action is ParentAction => (PARENT_ACTIONS as readonly string[]).includes(action);

/** `ledger parent <parent> <action> [<child>]`; the output is the line to print, empty for none. */
export function changeParent(context: Context, parentName: string, action: string, childName: string | undefined): string {
  if (!isParentAction(action)) return fail(`"${action}" is not something ledger parent does. Use add, remove, start or next.`);
  if (action === 'next') {
    if (childName !== undefined) fail('ledger parent <parent> next takes no child.');
    return nextChild(context, parentName);
  }
  if (childName === undefined) return fail(`ledger parent <parent> ${action} needs a child: ledger parent ${parentName} ${action} <child>`);
  const parentRef = taskRef(context.cwd, parentName);
  const childRef = taskRef(context.cwd, childName);
  const tasks = loadTasks(context, [parentRef.main, childRef.main]);
  const parent = theTask(tasks, parentRef, { live: true });
  const change = { add: addChildTask, remove: removeChildTask, start: startChildTask }[action];
  const output = change(context, tasks, { task: parent, ref: parentRef }, childRef);
  refreshRegistry(context, [parentRef.main, childRef.main]);
  return output;
}

type Linked = { task: Task; ref: Ref };

/** The lines under the parent's ## Children that name `child`. */
const linesOf = ({ task, ref }: Linked, child: Ref): Child[] => task.ledger.children.filter((line) => sameTask({ slug: line.slug, main: line.main ?? ref.main }, child));

/** The parent a ledger's Location names, in the task's own repo unless the line names another. */
function parentOf(task: Task, main: string): Ref | undefined {
  const parent = task.ledger.location.parent;
  return parent && { slug: parent.slug, main: parent.main ?? main };
}

/** The parent of a task, its parent, and so on, up to a task with no live ledger or one seen before. */
function ancestors(tasks: Task[], { task, ref }: Linked): Ref[] {
  const seen: Ref[] = [];
  let next = parentOf(task, ref.main);
  while (next !== undefined) {
    const ancestor = next;
    if (seen.some((known) => sameTask(known, ancestor))) break;
    seen.push(ancestor);
    const found = findNamed(tasks, ancestor).find(({ place }) => place !== 'archive');
    next = found && parentOf(found, ancestor.main);
  }
  return seen;
}

function addChildTask(context: Context, tasks: Task[], parent: Linked, childRef: Ref): string {
  const name = nameFrom(context.cwd);
  if (sameTask(parent.ref, childRef)) fail(`${name(childRef)} cannot be its own parent.`);
  const child = theTask(tasks, childRef, { live: true });
  if (wasChildOf(tasks, childRef, parent.ref)) fail(`${name(childRef)} is a retired child of ${name(parent.ref)}. Give the new task another slug.`);
  const current = parentOf(child, childRef.main);
  if (current !== undefined && !sameTask(current, parent.ref)) {
    fail(`${name(childRef)} already has the parent ${name(current)}. First run: ledger parent ${name(current)} remove ${name(childRef)}`);
  }
  if (ancestors(tasks, parent).some((ancestor) => sameTask(ancestor, childRef))) {
    fail(`${name(childRef)} is already a parent of ${name(parent.ref)}, or of one of its parents. Making it a child of ${name(parent.ref)} would make a cycle.`);
  }
  const spaced = samePath(parent.ref.main, childRef.main) ? undefined : [parent.ref.main, childRef.main].find((main) => /\s/.test(main));
  if (spaced !== undefined) fail(`The repo at ${spaced} has whitespace in its path, so none of its tasks can be linked to a task in another repo.`);

  // The child's line first: once it is written, running the same add again finishes the parent.
  if (current === undefined) {
    const text = addLocationBullet(readLedger(context, child), `- parent: ${linkFrom(childRef.main, parent.ref)}`) ?? fail(`${child.file} has no ## Location section.`);
    saveLedger(context, child, text);
  }
  if (linesOf(parent, childRef).length === 0) saveLedger(context, parent.task, addChild(readLedger(context, parent.task), `- ${linkFrom(parent.ref.main, childRef)}`));
  return `${name(childRef)} is a child of ${name(parent.ref)}.`;
}

function removeChildTask(context: Context, tasks: Task[], parent: Linked, childRef: Ref): string {
  const name = nameFrom(context.cwd);
  const child = theTask(tasks, childRef, { live: true });
  const bullet = child.ledger.location.parent;
  if (bullet === undefined || !sameTask({ slug: bullet.slug, main: bullet.main ?? childRef.main }, parent.ref)) fail(`${name(childRef)} is not a child of ${name(parent.ref)}.`);
  // The parent first: until the child's line is gone, running the same remove again still finds the pair.
  const listed = linesOf(parent, childRef);
  if (listed.length > 0) saveLedger(context, parent.task, removeChildren(readLedger(context, parent.task), listed.map(({ line }) => line)));
  saveLedger(context, child, removeLine(readLedger(context, child), bullet.line));
  return `${name(childRef)} is no longer a child of ${name(parent.ref)}.`;
}

/** The Children mark is only a hint, so a marked line and a retired child are both left as they are. */
function startChildTask(context: Context, tasks: Task[], parent: Linked, childRef: Ref): string {
  const { cwd, paths } = context;
  const name = nameFrom(cwd);
  const [line] = linesOf(parent, childRef);
  if (line === undefined) fail(`${name(childRef)} is not listed under ## Children of ${name(parent.ref)}. Add it with: ledger parent ${name(parent.ref)} add ${name(childRef)}`);
  if (!namedChildren(parent.task, tasks).includes(line)) fail(`${name(childRef)} names no task: its line under ## Children of ${name(parent.ref)} is a note, not a child.`);
  if (line.mark !== undefined) return `${name(childRef)} is already marked ${line.mark.kind} in ${paths.tilde(parent.task.file)}.`;
  if (locateChild(tasks, childRef, parent.ref)?.status === 'retired') return `${name(childRef)} is retired, so it is not marked started.`;
  saveLedger(context, parent.task, markStarted(readLedger(context, parent.task), line, today()));
  return `Marked ${name(childRef)} started in ${paths.tilde(parent.task.file)}.`;
}

/**
 * The chain from the parent down to its first child still in the backlog, by disk. A child with children of its own is
 * not started itself: its first such child is. A task already on the chain is a cycle and is skipped.
 */
function nextChild(context: Context, parentName: string): string {
  const { task, ref, tasks } = liveTask(context, parentName);
  const firstToStart = (parent: Linked, chain: Ref[]): Ref[] | undefined => {
    for (const line of namedChildren(parent.task, tasks)) {
      const child = { slug: line.slug, main: line.main ?? parent.ref.main };
      if (chain.some((ref) => sameTask(ref, child))) continue;
      const found = locateChild(tasks, child, parent.ref);
      if (found?.place !== 'backlog') continue;
      const picked = namedChildren(found, tasks).length === 0 ? [...chain, child] : firstToStart({ task: found, ref: child }, [...chain, child]);
      if (picked) return picked;
    }
    return undefined;
  };
  const picked = firstToStart({ task, ref }, [ref]);
  if (picked === undefined) {
    console.error(`No child task of ${ref.slug} is left in the backlog.`);
    return '';
  }
  return picked.map(nameFrom(context.cwd)).join(' ');
}
