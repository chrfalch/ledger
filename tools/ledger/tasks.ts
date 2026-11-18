import path from 'node:path';
import { fail } from './failure.js';
import { folderEntries, readTimedText, type TimedText } from './files.js';
import { isReadableSlug, parseLedger, type Child, type ChildMark, type Ledger, type TaskRef } from './format.js';
import { mainCheckout, worktrees } from './git.js';
import { mainOfTaskWorktree, parseArchiveName, repoName, samePath, worktreeLedger } from './paths.js';
import type { LedgerStore } from './store.js';

export type Place = 'worktree' | 'backlog' | 'archive';
export type TaskStatus = 'active' | 'parked' | 'backlog' | 'retired';

/** One task ledger. `main` is unknown for a backlog or archive ledger that does not name it. */
export type Task = {
  slug: string;
  repo: string;
  main?: string;
  /** A worktree's .claude/ledger.md, or the store's location of a backlog ledger or archive copy. */
  file: string;
  /** The store's name of a backlog ledger or archive copy; for a worktree ledger, its folder's name. */
  name: string;
  place: Place;
  status: TaskStatus;
  /** A worktree's checked-out branch; for a backlog or archive ledger, its Location branch. */
  branch?: string;
  /** The archive date from the file name. */
  archived?: string;
  ledger: Ledger;
  mtimeMs: number;
  birthtimeMs: number;
};

export type ChildStatus = TaskStatus | 'missing';
export type ChildView = { slug: string; main: string; status: ChildStatus; next: string; report: readonly string[] };

const SKIPPED = new Set(['node_modules', '.git', 'Pods', 'DerivedData', 'build', 'dist']);
const SCAN_DEPTH = 7;

type Found = { file: string; name: string; place: Place; repo: string; fallbackSlug: string; mainOf: (ledger: Ledger) => string | undefined; branch?: string };

function toTask({ file, name, place, repo, fallbackSlug, mainOf, branch }: Found, { text, mtimeMs, birthtimeMs }: TimedText): Task {
  const ledger = parseLedger(text);
  const status: TaskStatus = place === 'archive' ? 'retired' : place === 'backlog' ? 'backlog' : ledger.parked ? 'parked' : 'active';
  const main = mainOf(ledger);
  const knownBranch = branch ?? ledger.location.branch;
  const archived = place === 'archive' ? parseArchiveName(name)?.date : undefined;
  return {
    slug: ledger.slug ?? fallbackSlug,
    repo,
    ...(main === undefined ? {} : { main }),
    file,
    name,
    place,
    status,
    ...(knownBranch === undefined ? {} : { branch: knownBranch }),
    ...(archived === undefined ? {} : { archived }),
    ledger,
    mtimeMs,
    birthtimeMs,
  };
}

/** A worktree's ledger is a plain file, not in the store: hooks read it from disk, through a symbolic link or not. */
function worktreeTask(found: Omit<Found, 'file'>, folder: string): Task | undefined {
  const file = worktreeLedger(folder);
  const read = readTimedText(file, { followLinks: true });
  return read && toTask({ ...found, file }, read);
}

export function backlogTasks(store: LedgerStore): Task[] {
  return store.backlog
    .repos()
    .flatMap((repo) => store.backlog.list(repo))
    .map((entry) =>
      toTask({ file: entry.location, name: entry.name, place: 'backlog', repo: entry.repo, fallbackSlug: entry.name, mainOf: ({ location }) => location.main }, entry),
    );
}

/** Archived ledgers, of one repo folder or of all. The slug is the title's; old copies were named after the branch. */
export function archivedTasks(store: LedgerStore, repo?: string): Task[] {
  const mainOf = ({ location: { main, worktree } }: Ledger): string | undefined => main ?? (worktree === undefined ? undefined : mainOfTaskWorktree(worktree));
  return (repo === undefined ? store.archive.repos() : [repo])
    .flatMap((name) => store.archive.list(name))
    .map((entry) => {
      const fallbackSlug = parseArchiveName(entry.name)?.slug ?? entry.name;
      return toTask({ file: entry.location, name: entry.name, place: 'archive', repo: entry.repo, fallbackSlug, mainOf }, entry);
    });
}

export function worktreeTasks(main: string): Task[] {
  return worktrees(main).flatMap(({ path: folder, branch }) => {
    const name = path.basename(folder);
    return worktreeTask({ name, place: 'worktree', repo: repoName(main), fallbackSlug: name, mainOf: () => main, branch }, folder) ?? [];
  });
}

/** The ledger of a folder that is in no git repository; the folder names its repo, as the old registry did. */
export function folderTask(folder: string): Task | undefined {
  const name = path.basename(folder);
  return worktreeTask({ name, place: 'worktree', repo: name, fallbackSlug: name, mainOf: () => undefined }, folder);
}

/** The folders that hold a `.claude/ledger.md`, git repository or not, found by walking `roots` the way the old registry scan did. */
export function scanLedgerFolders(roots: string[]): string[] {
  const folders: string[] = [];
  const walk = (folder: string, depth: number): void => {
    for (const entry of folderEntries(folder)) {
      if (!entry.isDirectory() || SKIPPED.has(entry.name)) continue;
      const child = path.join(folder, entry.name);
      if (entry.name === '.claude' && folderEntries(child).some(({ name }) => name === 'ledger.md')) folders.push(folder);
      if (depth < SCAN_DEPTH) walk(child, depth + 1);
    }
  };
  for (const root of roots) walk(root, 1);
  return folders;
}

const referencedMains = (task: Task): string[] =>
  [task.ledger.location.parent?.main, ...task.ledger.children.map(({ main }) => main)].filter((main) => main !== undefined);

/**
 * Every task ledger: the backlog, the archive, and the worktrees of the repos at `mains`, of the repos backlog ledgers
 * name, and of the repos any found ledger names as parent or child.
 */
export function findTasks(store: LedgerStore, mains: string[]): Task[] {
  const backlog = backlogTasks(store);
  const live: Task[] = [];
  const seen = new Set<string>();
  const queue = [...mains, ...backlog.flatMap((task) => [...(task.main === undefined ? [] : [task.main]), ...referencedMains(task)])];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const main = mainCheckout(next);
    if (main === undefined || seen.has(main)) continue;
    seen.add(main);
    const found = worktreeTasks(main).filter((task) => !live.some(({ file }) => file === task.file));
    live.push(...found);
    queue.push(...found.flatMap(referencedMains));
  }
  return [...live, ...backlog, ...archivedTasks(store)];
}

/** Archive copies name no main when their worktree was not under .claude/worktrees; then the repo folder name decides. */
export const inRepo = (task: Task, main: string): boolean => (task.main === undefined ? task.repo === repoName(main) : samePath(task.main, main));

const PRECEDENCE: Place[] = ['worktree', 'backlog', 'archive'];

/** A parent line without a main names a parent in the task's own repo. */
function namesParent(task: Task, parent: Required<TaskRef>): boolean {
  const named = task.ledger.location.parent;
  if (named === undefined || named.slug !== parent.slug) return false;
  return named.main === undefined ? inRepo(task, parent.main) : samePath(named.main, parent.main);
}

/**
 * The child `child` of `parent`, by disk: a worktree beats a backlog ledger, which beats an archive copy, the same rule
 * `ledger list` follows. A slug can be reused, so an archive copy counts only when it names this parent or no parent.
 */
export function locateChild(tasks: Task[], child: Required<TaskRef>, parent: Required<TaskRef>): Task | undefined {
  const named = tasks.filter((task) => task.slug === child.slug && inRepo(task, child.main));
  const counts = (task: Task): boolean => task.place !== 'archive' || namesParent(task, parent) || task.ledger.location.parent === undefined;
  for (const place of PRECEDENCE) {
    const found = named.filter((task) => task.place === place && counts(task)).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (found !== undefined) return found;
  }
  return undefined;
}

/** An archive copy of `child` names `parent`: a new task with that slug would share the parent's line with the retired one. */
export const wasChildOf = (tasks: Task[], child: Required<TaskRef>, parent: Required<TaskRef>): boolean =>
  tasks.some((task) => task.place === 'archive' && task.slug === child.slug && inRepo(task, child.main) && namesParent(task, parent));

export const notASlug = (slug: string): string => `"${slug}" is not a slug. A slug has only letters, digits, dots, underscores and hyphens.`;

/** `<slug>`, a task in the repo that holds `cwd`, or `<slug>@<path>`, a task in the repo that holds `<path>`. */
export function taskRef(cwd: string, name: string): Required<TaskRef> {
  const at = name.indexOf('@');
  const slug = at === -1 ? name : name.slice(0, at);
  if (!isReadableSlug(slug)) fail(notASlug(slug));
  const folder = at === -1 ? cwd : path.resolve(cwd, name.slice(at + 1));
  const main =
    mainCheckout(folder) ??
    fail(at === -1 ? `${cwd} is not inside a git repository. Name the repo of the task: ${slug}@<path>` : `${folder} is not inside a git repository.`);
  return { slug, main };
}

/** The one ledger of `ref`; with `live`, an archive copy does not count. */
export function theTask(tasks: Task[], ref: Required<TaskRef>, { live = false } = {}): Task {
  const named = findNamed(tasks, ref);
  const found = live ? named.filter(({ place }) => place !== 'archive') : named;
  if (found.length > 1) fail(`${found.length} ledgers in the repo at ${ref.main} have the slug ${ref.slug}: ${found.map(({ file }) => file).join(', ')}`);
  if (found.length === 0) fail(named.length > 0 ? `${ref.slug} is retired: only its archive copy is left, ${named[0].file}.` : `No task ledger has the slug ${ref.slug} in the repo at ${ref.main}.`);
  return found[0];
}

export const sameTask = (a: Required<TaskRef>, b: Required<TaskRef>): boolean => a.slug === b.slug && samePath(a.main, b.main);

/** The live ledgers of `ref` (worktree or backlog), else its newest archive copy. */
export function findNamed(tasks: Task[], { slug, main }: Required<TaskRef>): Task[] {
  const named = tasks.filter((task) => task.slug === slug && inRepo(task, main));
  const live = named.filter((task) => task.place !== 'archive');
  return live.length > 0 ? live : named.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 1);
}

/** The ## Children bullets that name a child: `<slug>@<path>`, or a slug some known ledger has. Any other bullet is prose. */
export function namedChildren(parent: Task, tasks: Task[]): Child[] {
  // Any repo on purpose: a bare bullet may name a child whose ledger is elsewhere; it then shows as missing, not vanishes.
  return parent.ledger.children.filter((line) => line.main !== undefined || tasks.some(({ slug }) => slug === line.slug));
}

const markTime = (mark?: ChildMark): number => (mark === undefined ? 0 : Date.parse(mark.date));

/**
 * The children `parent` lists, each with its status from disk; active first, then newest first, else in list order.
 * A child line without a main is in the parent's repo, `parentMain`.
 */
export function childrenOf(parent: Task, parentMain: string, tasks: Task[]): ChildView[] {
  const shown = namedChildren(parent, tasks).map((line) => {
    const main = line.main ?? parentMain;
    const found = locateChild(tasks, { slug: line.slug, main }, { slug: parent.slug, main: parentMain });
    const status: ChildStatus = found?.status ?? 'missing';
    const view: ChildView = {
      slug: line.slug,
      main,
      status,
      next: found === undefined || found.status === 'retired' ? '' : found.ledger.next,
      report: found?.ledger.report ?? [],
    };
    return { view, time: found?.mtimeMs ?? markTime(line.mark) };
  });
  const active = ({ view }: { view: ChildView }): number => Number(view.status === 'active');
  return shown.sort((a, b) => active(b) - active(a) || b.time - a.time).map(({ view }) => view);
}
