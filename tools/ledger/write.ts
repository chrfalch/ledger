import path from 'node:path';
import { addChild, addDecision, addLocationBullet, fillLedger, markStarted, park, removeChildren, removeLine, unpark, withChildMain, withDesignRefsBullet } from './edit.js';
import { fail } from './failure.js';
import { exists, isFolder, readText, writeAtomic } from './files.js';
import { isNewSlug, isReadableSlug, parseLedger, type Child, type ChildMark, type Location, type TaskRef } from './format.js';
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
import { withLock } from './lock.js';
import { samePath, taskWorktree, worktreeLedger, type LedgerPaths } from './paths.js';
import { withHint } from './migrate-repo-ids.js';
import { repoKey } from './repo-key.js';
import { loadTasks } from './registry.js';
import { keyAndAliases, type Change, type LedgerStore } from './store.js';
import { pauseForTest } from './wait.js';
import { childrenOf, findNamed, inRepo, locateChild, namedChildren, notASlug, sameTask, taskRef, theTask, wasChildOf, type ChildStatus, type Place, type Task } from './tasks.js';

type Ref = Required<TaskRef>;
export type Context = { paths: LedgerPaths; cwd: string; store: LedgerStore };

/** A backlog ledger is in the store; a worktree ledger is the plain file that hooks read. */
export function readLedger({ store }: Context, task: Task): string {
  if (task.place === 'worktree') return readText(task.file);
  const collection = task.place === 'backlog' ? store.backlog : store.archive;
  return (collection.read(task.repo, task.name) ?? fail(`The ledger ${task.file} is gone.`)).text;
}

/** Rewrites a live ledger with `change` of its text as it is now, which may differ from the text in `task`. True when it was written. */
export function updateLedger({ store }: Context, task: Task, change: Change<string>): boolean {
  if (task.place === 'archive') throw new Error(`An archive copy is never changed: ${task.file}`);
  if (task.place === 'backlog') return store.backlog.update(task.repo, task.name, change);
  return withLock(task.file, () => {
    const text = change(readText(task.file));
    pauseForTest();
    if (text !== undefined) writeAtomic(task.file, text);
    return text !== undefined;
  });
}

/** The local date, as the old scripts wrote it. */
export function today(): string {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, '0')).join('-');
}

const oneLine = (text: string): string => text.trim().split(/\s+/).join(' ');

/** `text` as one shell word: unchanged when no character needs quoting, else in single quotes. */
export const shellWord = (text: string): string => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`);

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

/** The ledger template; with `refs`, it holds a `- design refs:` bullet for fillLedger to fill. */
function readTemplate(paths: LedgerPaths, refs: string | undefined): string {
  const file = path.join(paths.home, '.claude', 'ledger.template.md');
  let text: string;
  try {
    text = readText(file);
  } catch {
    return fail(`No ledger template at ${paths.tilde(file)}. Run ledger deploy to install it.`);
  }
  if (refs === undefined) return text;
  return withDesignRefsBullet(text) ?? fail(`--design-refs needs a ## Location section for its - design refs: line, and the template ${paths.tilde(file)} has none. Add the section, or leave out --design-refs.`);
}

/** The design refs a task names; else a repo with an llp/ folder records `none`, and any other repo no line. */
const designRefs = (root: string, named?: string): string | null => named ?? (isFolder(path.join(root, 'llp')) ? 'none' : null);

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

/** A new task: a backlog ledger, or, with --stack or --here, a worktree. `noted` is the ledger that got a Decisions line. */
export type CreatedTask = { slug: string; main: string; status: 'backlog' | 'active'; ledger: string; worktree?: string; branch?: string; base?: string; noted?: string; start?: string };

export function createdText({ status, ledger, worktree, branch, base, noted, start }: CreatedTask): string {
  const lines = worktree === undefined || branch === undefined || base === undefined ? [`ledger:  ${ledger}`, `status:  ${status}`] : startedLines({ worktree, branch, base, ledger });
  if (noted !== undefined) lines.push(`${worktree === undefined ? 'noted:  ' : 'noted   '} ${noted}`);
  if (start !== undefined) lines.push(`start:   ${start}`);
  return lines.join('\n');
}

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

export type TaskOptions = { goal?: string; designRefs?: string; stack?: boolean; here?: boolean; repo?: string };

export function createTask(context: Context, slug: string | undefined, { goal: rawGoal, designRefs: refs, stack = false, here = false, repo }: TaskOptions): CreatedTask {
  const { paths, cwd, store } = context;
  if (here && stack) fail('--here adds a ledger to this worktree, so it takes no --stack.');
  if (here && repo !== undefined) fail('--here adds a ledger to this worktree, so it takes no --repo.');
  if (stack && repo !== undefined) fail('--stack builds on the current branch, so it takes no --repo.');
  if (slug !== undefined && !isNewSlug(slug)) fail(slugRule(slug));
  if (refs !== undefined && !/^\d+(?:,\d+)*$/.test(refs)) fail(`--design-refs takes LLP numbers, comma-separated, such as 3,12. "${refs}" is not.`);
  const goal = rawGoal === undefined || oneLine(rawGoal) === '' ? undefined : oneLine(rawGoal);
  if (here) return hereTask(context, slug, goal, refs);
  if (slug === undefined) return fail('ledger task new needs a slug, or --here for this worktree.');

  const main = repoOf(cwd, repo === undefined ? cwd : path.resolve(cwd, repo));
  const template = readTemplate(paths, refs);
  const key = repoKey(main);
  const backlog = store.backlog.location(key, slug);
  const taken = (location = backlog): never => fail(`A backlog task ${slug} already exists: ${paths.tilde(location)}`);
  const filedUnder = keyAndAliases(store.aliases.read(), key).find((repo) => store.backlog.has(repo, slug));
  if (filedUnder !== undefined) taken(store.backlog.location(filedUnder, slug));
  const current = currentLedger(cwd);
  let created: CreatedTask;
  if (stack) {
    const base = currentBranch(cwd) ?? fail(`--stack needs a branch, but HEAD is detached in ${cwd}.`);
    const root = checkoutRoot(cwd) ?? cwd;
    const started = startWorktree(main, slug, slug, base, (filled) => fillLedger(template, { slug, goal, ...filled, designRefs: designRefs(root, refs) }));
    created = { slug, main, status: 'active', ...started };
  } else {
    checkTarget(main, slug, slug);
    pauseForTest();
    if (!store.backlog.create(key, slug, fillLedger(template, { slug, goal, main, designRefs: designRefs(main, refs) }))) taken();
    created = { slug, main, status: 'backlog', ledger: backlog };
  }
  const cwdMain = mainCheckout(cwd);
  const [named, start] = cwdMain !== undefined && samePath(cwdMain, main) ? [slug, `/ledger:go ${slug}`] : [`${slug} in ${main}`, `ledger go ${slug} --repo ${shellWord(main)}`];
  if (current !== undefined) {
    writeAtomic(current, addDecision(readText(current), `- New task ${named}: separate work, not part of this goal. ${start} starts it.`));
    created.noted = current;
  }
  refreshRegistry(context, [main]);
  return { ...created, start };
}

function hereTask(context: Context, given: string | undefined, goal: string | undefined, refs: string | undefined): CreatedTask {
  const { paths, cwd } = context;
  const main = repoOf(cwd);
  const worktree = checkoutRoot(cwd) ?? fail(`${cwd} is not inside a git repository.`);
  if (samePath(worktree, main)) fail(`--here needs a linked worktree, and ${cwd} is in the main checkout. A ledger lives only in a linked worktree.`);
  const ledger = worktreeLedger(worktree);
  if (exists(ledger)) fail(`This worktree already has a ledger: ${ledger}`);
  const branch = currentBranch(cwd);
  const slug = given ?? (branch?.split('/').at(-1) || path.basename(worktree));
  if (!isNewSlug(slug)) fail(`${slugRule(slug)} Name it: ledger task new --here <slug>`);
  const commit = commitOf(cwd, 'HEAD') ?? fail(`This worktree has no commit yet: ${worktree}`);
  const started: Started = { worktree, branch: branch ?? 'detached HEAD', base: `HEAD @ ${short(cwd, commit)}`, ledger };
  writeAtomic(ledger, fillLedger(readTemplate(paths, refs), { slug, goal, ...started, designRefs: designRefs(worktree, refs) }));
  excludeEvidence(main);
  refreshRegistry(context, [main]);
  return { slug, main, status: 'active', ...started };
}

/**
 * Starts the backlog task `slug` of the repo at `main`, filed under `repo`: the repo's key, or an old key that is an alias
 * of it. Exit codes: 2 no backlog task, 3 a task of another repo, 4 a ledger that names no repo.
 */
function promote(context: Context, slug: string, main: string, repo: string): Started {
  const { store } = context;
  const backlog = store.backlog.read(repo, slug) ?? fail(withHint(store, `No backlog task ${slug} for the repo at ${main}.`), 2);
  const { text } = backlog;
  const { location } = parseLedger(text);
  // Filed under this repo's key, so it is a task of this repo, also when its main line names another clone of it.
  location.main ?? fail(`The backlog ledger ${backlog.location} has no "- main:" line, so its repo is unknown.`, 4);
  const base = location.base?.ref ?? originHead(main) ?? currentBranch(main) ?? fail(`${main} has no origin/HEAD and a detached HEAD, so there is no branch to start from.`);
  const started = startWorktree(
    main,
    slug,
    location.branch ?? slug,
    base,
    ({ worktree, branch, base: from }) => fillLedger(text, { slug, worktree, branch, base: from }),
    () => {
      // A throw here makes startWorktree remove the new worktree and branch, so the task stays one backlog ledger.
      if (!store.backlog.remove(backlog.repo, backlog.name, text)) {
        fail(`Another command changed the backlog ledger ${backlog.location} while ${slug} was being started. Nothing was started. Run ledger go ${slug} again.`);
      }
    },
  );
  refreshRegistry(context, [main]);
  return started;
}

/**
 * What `ledger go` did. `chain` runs from the named task down to the child it started instead, empty when it started the
 * named task itself. `parent` is the started task's parent and `children` its own child tasks. `marked` is the parent
 * that now marks the task started; `unparked` the marker it removed.
 */
export type GoResult = {
  slug: string;
  main: string;
  ledger: string;
  worktree: string;
  branch?: string;
  base?: string;
  promoted: boolean;
  chain: Ref[];
  parent?: Ref;
  children: { slug: string; main: string; status: ChildStatus }[];
  unparked?: { date: string; reason: string };
  marked?: { parent: Ref; ledger: string };
  warnings: string[];
};

/**
 * Why no live ledger of this repo has the slug of `ref`, with the exit codes of promote: 3 for a task of another repo,
 * 1 for a retired task or a worktree folder in the way, else 2, as /ledger:go makes a new task only on 2.
 */
function refuseMissing(store: LedgerStore, tasks: Task[], { slug, main }: Ref): never {
  // A ledger that names this checkout but is filed under another key, an old folder name or the origin this path had, is
  // no task of another checkout: --repo would lead back here.
  const namesThis = (task: Task): boolean => task.main !== undefined && samePath(task.main, main);
  const elsewhere = tasks.find((task) => task.slug === slug && task.place !== 'archive' && !inRepo(task, main) && !namesThis(task));
  if (elsewhere !== undefined) {
    const owner = elsewhere.main ?? `named ${elsewhere.repo}`;
    const start = elsewhere.main === undefined ? '' : ` Run: ledger go ${slug} --repo ${shellWord(elsewhere.main)}`;
    fail(withHint(store, `No task ${slug} in the repo at ${main}: it is a task of the repo at ${owner}.${start}`), 3);
  }
  const archived = findNamed(tasks, { slug, main }).find(({ place }) => place === 'archive');
  if (archived !== undefined) fail(`${slug} is retired: only its archive copy is left, ${archived.file}.`);
  const folder = taskWorktree(main, slug);
  if (exists(folder)) fail(`The folder ${folder} exists, but no task ledger in it has the slug ${slug}.`);
  return fail(withHint(store, `No backlog task ${slug} for the repo at ${main}.`), 2);
}

/** The live ledger of `ref`: one in a worktree beats one in the backlog. */
const liveLedger = (tasks: Task[], ref: Ref): Task | undefined => {
  const live = findNamed(tasks, ref).filter(({ place }) => place !== 'archive');
  return live.find(({ place }) => place === 'worktree') ?? live[0];
};

/**
 * Starts a task, as /ledger:go does: a parent with a child still in the backlog starts that child instead, a backlog
 * task gets its worktree, a task with a worktree is only gone to. Then its parked marker is removed and its parent marks
 * it started; a parent that cannot be marked is a warning, not a failure. A parent in the backlog with no child left
 * there fails, as there is nothing to start. The slug names a ledger that exists, so the reading rule applies.
 */
export function goTask(context: Context, slug: string, repo: string | undefined): GoResult {
  const { cwd } = context;
  if (!isReadableSlug(slug)) fail(notASlug(slug));
  const named = { slug, main: repoOf(cwd, repo === undefined ? cwd : path.resolve(cwd, repo)) };
  const tasks = loadTasks(context, [named.main]);
  const task = liveLedger(tasks, named);
  let chain: Ref[] = [];
  if (task !== undefined && namedChildren(task, tasks).length > 0) {
    chain = firstToStart(tasks, { task, ref: named }) ?? [];
    if (chain.length === 0 && task.place === 'backlog') fail(`No child task of ${slug} is left in the backlog, so there is nothing to start. ledger tree show ${slug} shows its children.`);
  }
  const target = chain.at(-1) ?? named;
  if (!isReadableSlug(target.slug)) fail(notASlug(target.slug));
  const found = (chain.length === 0 ? task : liveLedger(tasks, target)) ?? refuseMissing(context.store, tasks, target);
  const place =
    found.place === 'worktree'
      ? { ledger: found.file, worktree: path.dirname(path.dirname(found.file)), ...(found.branch === undefined ? {} : { branch: found.branch }), promoted: false }
      : { ...promote(context, target.slug, target.main, found.repo), promoted: true };

  const text = readText(place.ledger);
  const { parked, location } = parseLedger(text);
  if (parked !== undefined) writeAtomic(place.ledger, unpark(text));
  const warnings: string[] = [];
  let marked: GoResult['marked'];
  const parent = location.parent && { slug: location.parent.slug, main: location.parent.main ?? target.main };
  if (parent !== undefined) {
    try {
      if (place.promoted) nameChildClone(context, parent, target);
      const change = changeParent(context, `${parent.slug}@${parent.main}`, 'start', `${target.slug}@${target.main}`);
      if (change.action === 'start' && change.marked) marked = { parent, ledger: change.ledger };
    } catch (error) {
      warnings.push(`${target.slug} is not marked started in ${parent.slug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  refreshRegistry(context, [target.main]);
  const children = childrenOf(found, target.main, tasks).map(({ slug: child, main, status }) => ({ slug: child, main, status }));
  return {
    ...target,
    ...place,
    chain,
    ...(parent === undefined ? {} : { parent }),
    children,
    ...(parked === undefined ? {} : { unparked: { date: parked.date, reason: parked.reason } }),
    ...(marked === undefined ? {} : { marked }),
    warnings,
  };
}

export function goText(context: Context, { ledger, worktree, branch, base, chain, unparked, marked }: GoResult): string {
  const name = nameFrom(context.cwd);
  return [
    ...(base === undefined ? [`worktree ${worktree}`, ...(branch === undefined ? [] : [`branch   ${branch}`]), `ledger   ${ledger}`] : startedLines({ worktree, branch: branch ?? '', base, ledger })),
    ...(chain.length === 0 ? [] : [`chain    ${chain.map(name).join(' ')}`]),
    ...(unparked === undefined ? [] : [`unparked ${unparked.date} — ${unparked.reason}`]),
    ...(marked === undefined ? [] : [`marked   ${marked.ledger}`]),
  ].join('\n');
}

export function liveTask(context: Context, name: string): Linked & { tasks: Task[] } {
  const ref = taskRef(context.cwd, name);
  const tasks = loadTasks(context, [ref.main]);
  return { task: theTask(tasks, ref, { live: true }), ref, tasks };
}

type ParkedMark = { date: string; reason: string };

export type ParkResult = Ref & { ledger: string; parked: ParkedMark };

/** `parked` is the marker removed; unparked is false when there was none. */
export type UnparkResult = Ref & { ledger: string; unparked: boolean; parked?: ParkedMark };

export function parkTask(context: Context, name: string, reason: string): ParkResult {
  if (oneLine(reason) === '') fail('A parked task needs a reason: ledger task park <slug> --reason <text>');
  const { task, ref } = liveTask(context, name);
  const parked = { date: today(), reason: oneLine(reason) };
  updateLedger(context, task, (text) => park(text, parkMarker(parked)));
  refreshRegistry(context, [ref.main]);
  return { ...ref, ledger: task.file, parked };
}

const parkMarker = ({ date, reason }: ParkedMark): string => `Parked: ${date} — ${reason}`;

export const parkText = ({ slug, parked }: ParkResult): string => `Parked ${slug}. ${parkMarker(parked)}`;

export function unparkTask(context: Context, name: string): UnparkResult {
  const { task, ref } = liveTask(context, name);
  const { parked } = task.ledger;
  if (parked === undefined) return { ...ref, ledger: task.file, unparked: false };
  updateLedger(context, task, unpark);
  refreshRegistry(context, [ref.main]);
  return { ...ref, ledger: task.file, unparked: true, parked: { date: parked.date, reason: parked.reason } };
}

export const unparkText = ({ slug, parked }: UnparkResult): string =>
  parked === undefined ? `${slug} is not parked.` : `Unparked ${slug}. It was parked on ${parked.date}${parked.reason ? `: ${parked.reason}` : ''}.`;

export type ParentAction = 'add' | 'remove' | 'start' | 'next';

/**
 * What `ledger tree <action> <parent>` did. A start that marks nothing says why: the line is `already-marked` with
 * `mark`, or the child is `retired`. A next names the chain from the parent down to the child to start, empty for none.
 */
export type ParentChange =
  | { action: 'add' | 'remove'; parent: Ref; child: Ref }
  | { action: 'start'; parent: Ref; child: Ref; ledger: string; marked: boolean; reason?: 'already-marked' | 'retired'; mark?: ChildMark['kind'] }
  | { action: 'next'; parent: Ref; chain: Ref[] };

/** The line to print, empty for none. */
export function parentChangeText({ cwd, paths }: Context, change: ParentChange): string {
  const name = nameFrom(cwd);
  switch (change.action) {
    case 'add':
      return `${name(change.child)} is a child of ${name(change.parent)}.`;
    case 'remove':
      return `${name(change.child)} is no longer a child of ${name(change.parent)}.`;
    case 'start':
      if (change.marked) return `Marked ${name(change.child)} started in ${paths.tilde(change.ledger)}.`;
      if (change.reason === 'retired') return `${name(change.child)} is retired, so it is not marked started.`;
      return `${name(change.child)} is already marked ${change.mark} in ${paths.tilde(change.ledger)}.`;
    case 'next':
      return change.chain.map(name).join(' ');
  }
}

/** `ledger tree <action> <parent> [<child>]`. */
export function changeParent(context: Context, parentName: string, action: ParentAction, childName: string | undefined): ParentChange {
  if (action === 'next') {
    if (childName !== undefined) fail('ledger tree next <parent> takes no child.');
    const { task, ref, tasks } = liveTask(context, parentName);
    return { action, parent: ref, chain: firstToStart(tasks, { task, ref }) ?? [] };
  }
  if (childName === undefined) return fail(`ledger tree ${action} <parent> needs a child: ledger tree ${action} ${parentName} <child>`);
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
type ParentLine = NonNullable<Location['parent']>;

/** The lines under the parent's ## Children that name `child`, a task of `place`: in the parent as it was read, or else in `text`. */
const linesOf = ({ task, ref }: Linked, child: Ref, place: Place, text?: string): Child[] =>
  (text === undefined ? task.ledger : parseLedger(text)).children.filter((line) => sameTask({ slug: line.slug, main: line.main ?? ref.main }, child, place));

/**
 * Every clone of a repo shares a backlog parent, and a worktree child is in one of them only, so the child's line in
 * such a parent names that clone's main checkout.
 */
const namesClone = (parent: Task, place: Place): boolean => parent.place === 'backlog' && place === 'worktree';

/**
 * After `go` put the backlog child `child` in a worktree, its line in a backlog parent names the clone it is in. A line
 * that names a clone with a worktree task of that slug is that task's, so it stays. A line that names a folder that is
 * no main checkout any more names a clone that is gone, of a repo no one can tell, so it is taken for this child's.
 */
function nameChildClone(context: Context, parentRef: Ref, child: Ref): void {
  if (/\s/.test(child.main)) return;
  const tasks = loadTasks(context, [parentRef.main]);
  const parent = liveLedger(tasks, parentRef);
  if (parent === undefined || !namesClone(parent, 'worktree')) return;
  const hasWorktreeTask = (main: string): boolean => tasks.some((task) => task.place === 'worktree' && task.slug === child.slug && task.main !== undefined && samePath(task.main, main));
  const isGone = (main: string): boolean => {
    const checkout = mainCheckout(main);
    return checkout === undefined || !samePath(checkout, main);
  };
  const namesChild = ({ slug, main }: Child): boolean =>
    main === undefined ? sameTask({ slug, main: parentRef.main }, child, 'backlog') : slug === child.slug && (isGone(main) || (sameTask({ slug, main }, child, 'backlog') && !hasWorktreeTask(main)));
  updateLedger(context, parent, (text) => {
    const line = parseLedger(text).children.find(namesChild);
    return line && withChildMain(text, line, child.main);
  });
}

/** The ## Children line of `child`, a task of `place`. */
const childLine = (parent: Linked, child: Ref, place: Place): string =>
  namesClone(parent.task, place) ? `- ${child.slug} @ ${child.main}` : `- ${linkFrom(parent.ref.main, child)}`;

/** Whether the `- parent:` line of a child in `childMain` names `parent`. */
const namesParent = (bullet: ParentLine | undefined, childMain: string, parent: Linked): bullet is ParentLine =>
  bullet !== undefined && sameTask({ slug: bullet.slug, main: bullet.main ?? childMain }, parent.ref, parent.task.place);

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
    const found = findNamed(tasks, ancestor).find(({ place }) => place !== 'archive');
    if (seen.some((known) => sameTask(known, ancestor, found?.place ?? 'backlog'))) break;
    seen.push(ancestor);
    next = found && parentOf(found, ancestor.main);
  }
  return seen;
}

function addChildTask(context: Context, tasks: Task[], parent: Linked, childRef: Ref): ParentChange {
  const name = nameFrom(context.cwd);
  if (sameTask(parent.ref, childRef, parent.task.place)) fail(`${name(childRef)} cannot be its own parent.`);
  const child = theTask(tasks, childRef, { live: true });
  if (wasChildOf(tasks, childRef, parent.ref)) fail(`${name(childRef)} is a retired child of ${name(parent.ref)}. Give the new task another slug.`);
  const current = parentOf(child, childRef.main);
  if (current !== undefined && !sameTask(current, parent.ref, parent.task.place)) {
    fail(`${name(childRef)} already has the parent ${name(current)}. First run: ledger tree remove ${name(current)} ${name(childRef)}`);
  }
  if (ancestors(tasks, parent).some((ancestor) => sameTask(ancestor, childRef, child.place))) {
    fail(`${name(childRef)} is already a parent of ${name(parent.ref)}, or of one of its parents. Making it a child of ${name(parent.ref)} would make a cycle.`);
  }
  const spaced = samePath(parent.ref.main, childRef.main) ? undefined : [parent.ref.main, childRef.main].find((main) => /\s/.test(main));
  if (spaced !== undefined) fail(`The repo at ${spaced} has whitespace in its path, so none of its tasks can be linked to a task in another repo.`);
  if (namesClone(parent.task, child.place) && /\s/.test(childRef.main)) {
    fail(`The repo at ${childRef.main} has whitespace in its path, so none of its worktree tasks can be a child of a backlog task.`);
  }

  // The child's line first: once it is written, running the same add again finishes the parent.
  if (current === undefined) {
    updateLedger(context, child, (text) => addLocationBullet(text, `- parent: ${linkFrom(childRef.main, parent.ref)}`) ?? fail(`${child.file} has no ## Location section.`));
  }
  updateLedger(context, parent.task, (text) => (linesOf(parent, childRef, child.place, text).length > 0 ? undefined : addChild(text, childLine(parent, childRef, child.place))));
  return { action: 'add', parent: parent.ref, child: childRef };
}

function removeChildTask(context: Context, tasks: Task[], parent: Linked, childRef: Ref): ParentChange {
  const name = nameFrom(context.cwd);
  const child = theTask(tasks, childRef, { live: true });
  if (!namesParent(child.ledger.location.parent, childRef.main, parent)) fail(`${name(childRef)} is not a child of ${name(parent.ref)}.`);
  // The parent first: until the child's line is gone, running the same remove again still finds the pair.
  updateLedger(context, parent.task, (text) => {
    const listed = linesOf(parent, childRef, child.place, text);
    return listed.length === 0 ? undefined : removeChildren(text, listed.map(({ line }) => line));
  });
  updateLedger(context, child, (text) => {
    const bullet = parseLedger(text).location.parent;
    return namesParent(bullet, childRef.main, parent) ? removeLine(text, bullet.line) : undefined;
  });
  return { action: 'remove', parent: parent.ref, child: childRef };
}

/** The Children mark is only a hint, so a marked line and a retired child are both left as they are. */
function startChildTask(context: Context, tasks: Task[], parent: Linked, childRef: Ref): ParentChange {
  const name = nameFrom(context.cwd);
  const notListed = (): never => fail(`${name(childRef)} is not listed under ## Children of ${name(parent.ref)}. Add it with: ledger tree add ${name(parent.ref)} ${name(childRef)}`);
  const child = locateChild(tasks, childRef, parent.ref);
  const place = child?.place ?? 'backlog';
  const [line] = linesOf(parent, childRef, place);
  if (line === undefined) notListed();
  if (!namedChildren(parent.task, tasks).includes(line)) fail(`${name(childRef)} names no task: its line under ## Children of ${name(parent.ref)} is a note, not a child.`);
  const started = { action: 'start', parent: parent.ref, child: childRef, ledger: parent.task.file } as const;
  if (line.mark !== undefined) return { ...started, marked: false, reason: 'already-marked', mark: line.mark.kind };
  if (child?.status === 'retired') return { ...started, marked: false, reason: 'retired' };
  let mark: ChildMark['kind'] | undefined;
  updateLedger(context, parent.task, (text) => {
    const [now] = linesOf(parent, childRef, place, text);
    if (now === undefined) return notListed();
    mark = now.mark?.kind;
    return mark === undefined ? markStarted(text, now, today()) : undefined;
  });
  return mark === undefined ? { ...started, marked: true } : { ...started, marked: false, reason: 'already-marked', mark };
}

/**
 * The chain from the parent down to its first child still in the backlog, by disk. A child with children of its own is
 * not started itself: its first such child is. A task already on the chain is a cycle and is skipped.
 */
function firstToStart(tasks: Task[], parent: Linked, chain: Ref[] = [parent.ref]): Ref[] | undefined {
  for (const line of namedChildren(parent.task, tasks)) {
    const child = { slug: line.slug, main: line.main ?? parent.ref.main };
    const found = locateChild(tasks, child, parent.ref);
    if (found?.place !== 'backlog' || chain.some((ref) => sameTask(ref, child, found.place))) continue;
    const picked = namedChildren(found, tasks).length === 0 ? [...chain, child] : firstToStart(tasks, { task: found, ref: child }, [...chain, child]);
    if (picked) return picked;
  }
  return undefined;
}
