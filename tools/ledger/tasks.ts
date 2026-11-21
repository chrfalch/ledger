import path from 'node:path';
import { fail } from './failure.js';
import { folderEntries, readTimedText, type TimedText } from './files.js';
import { isReadableSlug, parseLedger, type Child, type Dependency, type Ledger, type TaskRef } from './format.js';
import { mainCheckout, worktrees } from './git.js';
import { mainOfTaskWorktree, parseArchiveName, samePath, worktreeLedger } from './paths.js';
import { repoKey } from './repo-key.js';
import { keyAndAliases, type LedgerStore } from './store.js';

/** `remote`: the read-only copy of a worktree ledger of another machine. */
export type Place = 'worktree' | 'remote' | 'backlog' | 'archive';
export type TaskStatus = 'active' | 'parked' | 'backlog' | 'retired';

/**
 * One task ledger. `main` is unknown for a backlog or archive ledger that does not name it, and for a remote one, as
 * its path is on another machine.
 */
export type Task = {
  slug: string;
  /** The key the ledger is filed under. */
  repo: string;
  /** The key `repo` is an alias of, for a ledger still filed under an old key. */
  currentRepo?: string;
  main?: string;
  /** A worktree's .claude/ledger.md, or the store's location of a backlog ledger, archive copy or remote copy. */
  file: string;
  /** The store's name of a backlog ledger, archive copy or remote copy; for a worktree ledger, its folder's name. */
  name: string;
  place: Place;
  /** The host folder of the machine whose worktree a remote task is in. */
  host?: string;
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

type Found = {
  file: string;
  name: string;
  place: Place;
  host?: string;
  repo: string;
  currentRepo?: string;
  fallbackSlug: string;
  mainOf: (ledger: Ledger) => string | undefined;
  branch?: string;
};

function toTask({ file, name, place, host, repo, currentRepo, fallbackSlug, mainOf, branch }: Found, { text, mtimeMs, birthtimeMs }: TimedText): Task {
  const ledger = parseLedger(text);
  const status: TaskStatus = place === 'archive' ? 'retired' : place === 'backlog' ? 'backlog' : ledger.parked ? 'parked' : 'active';
  const main = mainOf(ledger);
  const knownBranch = branch ?? ledger.location.branch;
  const archived = place === 'archive' ? parseArchiveName(name)?.date : undefined;
  return {
    slug: ledger.slug ?? fallbackSlug,
    repo,
    ...(currentRepo === undefined ? {} : { currentRepo }),
    ...(main === undefined ? {} : { main }),
    file,
    name,
    place,
    ...(host === undefined ? {} : { host }),
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
  const aliases = store.aliases.read();
  return store.backlog
    .repos()
    .flatMap((repo) => store.backlog.list(repo))
    .map((entry) =>
      toTask({ file: entry.location, name: entry.name, place: 'backlog', repo: entry.repo, currentRepo: aliases.get(entry.repo), fallbackSlug: entry.name, mainOf: ({ location }) => location.main }, entry),
    );
}

/** The copies of the worktree ledgers of other machines. This machine's own copies are skipped: its worktrees are read from disk. */
export function remoteTasks(store: LedgerStore): Task[] {
  const { active } = store;
  if (active === undefined) return [];
  const aliases = store.aliases.read();
  return active
    .hosts()
    .filter((host) => host !== active.host)
    .flatMap((host) => {
      const copies = active.copiesOf(host);
      return copies
        .repos()
        .flatMap((repo) => copies.list(repo))
        .map((entry) => toTask({ file: entry.location, name: entry.name, place: 'remote', host, repo: entry.repo, currentRepo: aliases.get(entry.repo), fallbackSlug: entry.name, mainOf: () => undefined }, entry));
    });
}

/** That `task`, a remote one, can only be read here. */
export const onAnotherMachine = ({ slug, host }: Task): string =>
  `${slug} is in a worktree on ${host}, and this machine has only a read-only copy of its ledger. Continue the task on ${host}.`;

/** Archived ledgers, of one repo, those under its aliases included, or of all. The slug is the title's; old copies were named after the branch. */
export function archivedTasks(store: LedgerStore, repo?: string): Task[] {
  const aliases = store.aliases.read();
  const mainOf = ({ location: { main, worktree } }: Ledger): string | undefined => main ?? (worktree === undefined ? undefined : mainOfTaskWorktree(worktree));
  return (repo === undefined ? store.archive.repos() : keyAndAliases(aliases, repo))
    .flatMap((name) => store.archive.list(name))
    .map((entry) => {
      const fallbackSlug = parseArchiveName(entry.name)?.slug ?? entry.name;
      return toTask({ file: entry.location, name: entry.name, place: 'archive', repo: entry.repo, currentRepo: aliases.get(entry.repo), fallbackSlug, mainOf }, entry);
    });
}

export function worktreeTasks(main: string): Task[] {
  return worktrees(main).flatMap(({ path: folder, branch }) => {
    const name = path.basename(folder);
    return worktreeTask({ name, place: 'worktree', repo: repoKey(main), fallbackSlug: name, mainOf: () => main, branch }, folder) ?? [];
  });
}

/** The ledger of a folder that is in no git repository; the folder's path is its repo key, as for a repo without remote. */
export function folderTask(folder: string): Task | undefined {
  const name = path.basename(folder);
  return worktreeTask({ name, place: 'worktree', repo: path.resolve(folder), fallbackSlug: name, mainOf: () => undefined }, folder);
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

/** A repo without remote is keyed by its main checkout's path, so a dependency's key can be the only way to find it. */
const referencedMains = ({ ledger: { location, children } }: Task): string[] => [
  ...[location.parent?.main, ...children.map(({ main }) => main)].filter((main) => main !== undefined),
  ...(location.dependencies ?? []).flatMap(({ repo }) => (repo !== undefined && path.isAbsolute(repo) ? [repo] : [])),
];

/**
 * Every task ledger: the backlog, the archive, the worktrees of the repos at `mains`, of the repos backlog ledgers name,
 * and of the repos any found ledger names as parent, child or, by path, dependency, and the copies of the worktree
 * ledgers of other machines. A task such a copy shows started is no longer in the backlog, even when this machine has
 * not pulled its removal yet. A copy with the repo key and slug of a worktree task here is left out, as this machine's
 * own copy under a "host" it had before. Repo keys are compared with an alias resolved, so a clone's folder name never
 * matters.
 */
export function findTasks(store: LedgerStore, mains: string[]): Task[] {
  const backlog = backlogTasks(store);
  const copies = remoteTasks(store);
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
  const remote = copies.filter((copy) => !live.some(({ slug, main }) => slug === copy.slug && main !== undefined && inRepo(copy, main)));
  const waiting = backlog.filter((task) => !remote.some((copy) => copy.slug === task.slug && currentKey(copy) === currentKey(task)));
  return [...live, ...remote, ...waiting, ...archivedTasks(store)];
}

/** The key of the repo a ledger in the store is filed under, with an alias resolved. */
const currentKey = (task: Task): string => task.currentRepo ?? task.repo;

/**
 * Whether `task` is a task of the repo at `main`. A worktree's ledger is one of the checkout that holds the worktree only.
 * A backlog ledger or archive copy is one of each clone of its repo, by its key with an alias resolved, never by the main
 * it names: that path may be a clone of another origin now.
 */
export const inRepo = (task: Task, main: string): boolean =>
  task.place === 'worktree' ? task.main !== undefined && samePath(task.main, main) : currentKey(task) === repoKey(main);

const PRECEDENCE: Place[] = ['worktree', 'remote', 'backlog', 'archive'];

/** A parent line without a main names a parent in the task's own repo. */
function namesParent(task: Task, parent: Required<TaskRef>): boolean {
  const named = task.ledger.location.parent;
  if (named === undefined || named.slug !== parent.slug) return false;
  return named.main === undefined ? inRepo(task, parent.main) : samePath(named.main, parent.main);
}

/**
 * The child `child` of `parent`, by disk: a worktree beats a remote copy, then a backlog ledger, then an archive copy,
 * the same rule `ledger list` follows. A slug can be reused, so an archive copy counts only when it names this parent or
 * no parent.
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

export const notASlug = (slug: string): string => `"${slug}" is not a slug. A slug has only letters, digits, dots, underscores and hyphens. It does not start with a dot.`;

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

/**
 * Whether `a` and `b` name one task, a task of `place`. Two clones of a repo share its backlog and archive, so a slug
 * named from each is one such task; a worktree task is only that of the clone that holds it.
 */
export const sameTask = (a: Required<TaskRef>, b: Required<TaskRef>, place: Place): boolean =>
  a.slug === b.slug && (samePath(a.main, b.main) || (place !== 'worktree' && repoKey(a.main) === repoKey(b.main)));

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

/** `items` by the order `orderOf` gives each, lowest first, then those without one; each tie keeps its place. */
export function inOrder<T>(items: readonly T[], orderOf: (item: T) => number | undefined): T[] {
  const rank = (item: T): number => orderOf(item) ?? Number.POSITIVE_INFINITY;
  return [...items].sort((a, b) => (rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1));
}

/** A ## Children line that names a task, with the task by disk; `task` is undefined for a child no ledger has. */
export type ListedChild = { line: Child; ref: Required<TaskRef>; task?: Task };

/** The children `parent` names, in the order of their lines. A line without a main is in the parent's repo, `parentMain`. */
export function listedChildren(parent: Task, parentMain: string, tasks: Task[]): ListedChild[] {
  return namedChildren(parent, tasks).map((line) => {
    const ref = { slug: line.slug, main: line.main ?? parentMain };
    return { line, ref, task: locateChild(tasks, ref, { slug: parent.slug, main: parentMain }) };
  });
}

/** listedChildren by the order of each child: its own `- order:`, or what `orderOf` gives, for an order `tasks` predates. */
export const orderedChildren = (parent: Task, parentMain: string, tasks: Task[], orderOf = (task: Task): number | undefined => task.ledger.location.order): ListedChild[] =>
  inOrder(listedChildren(parent, parentMain, tasks), ({ task }) => task && orderOf(task));

/** The children `parent` lists, each with its status from disk, by order. */
export function childrenOf(parent: Task, parentMain: string, tasks: Task[]): ChildView[] {
  return orderedChildren(parent, parentMain, tasks).map(({ ref, task }) => ({
    slug: ref.slug,
    main: ref.main,
    status: task?.status ?? 'missing',
    next: task === undefined || task.status === 'retired' ? '' : task.ledger.next,
    report: task?.ledger.report ?? [],
  }));
}

/** The key of the repo of `task`, with an old key it is still filed under resolved. */
const keyOf = (task: Task): string => task.currentRepo ?? task.repo;

/** The tasks `task` waits for, each with the key of its repo. */
export const dependenciesOf = (task: Task): Required<Dependency>[] => (task.ledger.location.dependencies ?? []).map(({ slug, repo }) => ({ slug, repo: repo ?? keyOf(task) }));

/** The ledger `dependency` names, by the rule of locateChild: a worktree, then the backlog, then the archive; the newest of each. */
export function dependencyTask(tasks: Task[], { slug, repo }: Required<Dependency>): Task | undefined {
  const named = tasks.filter((task) => task.slug === slug && keyOf(task) === repo).sort((a, b) => b.mtimeMs - a.mtimeMs);
  return PRECEDENCE.map((place) => named.find((task) => task.place === place)).find((task) => task !== undefined);
}

/** A task no ledger names is not done: it may be in a repo whose worktrees this command did not read. */
export const isDone = (task: Task | undefined): boolean => task !== undefined && (task.status === 'retired' || task.ledger.location.state === 'done');
