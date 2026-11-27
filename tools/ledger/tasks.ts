import path from 'node:path';
import { fail } from './failure.js';
import { exists, isFolder, type TimedText } from './files.js';
import { isReadableSlug, parseLedger, type Child, type Dependency, type Ledger, type StatusValue, type TaskRef } from './format.js';
import { mainCheckout, worktrees, type Worktree } from './git.js';
import { mainOfTaskWorktree, parseArchiveName, samePath } from './paths.js';
import { repoKey } from './repo-key.js';
import { keyAndAliases, readable, type LedgerStore, type StoredLedger } from './store.js';

export type Place = 'active' | 'backlog' | 'archive';
export type TaskStatus = 'active' | StatusValue | 'lost' | 'backlog' | 'retired';

/** One task ledger. `main` is unknown for a backlog or archive ledger that does not name it. */
export type Task = {
  slug: string;
  /** The key the ledger is filed under. */
  repo: string;
  /** The key `repo` is an alias of, for a ledger still filed under an old key. */
  currentRepo?: string;
  /** Every key a checkout of the task's repo may have: its key now and each old key that is an alias of it. */
  repoKeys: readonly string[];
  main?: string;
  /** The store's location of the ledger. */
  file: string;
  /** The store's name of the ledger: the slug of an active or backlog ledger, the archive name of a copy. */
  name: string;
  /** The linked worktree of an active task. */
  worktree?: string;
  /** An active task whose worktree is not on this machine: one of another machine, or one whose worktree is gone. */
  elsewhere?: true;
  /** The machine an elsewhere task is on, when that is not this one: its record's host, or UNKNOWN_HOST for a record with none. */
  host?: string;
  place: Place;
  status: TaskStatus;
  /** The branch checked out in an active task's worktree; for a backlog or archive ledger, its Location branch. */
  branch?: string;
  /** The archive date from the file name. */
  archived?: string;
  ledger: Ledger;
  mtimeMs: number;
  birthtimeMs: number;
};

export type ChildStatus = TaskStatus | 'missing';
export type ChildView = { slug: string; main: string; status: ChildStatus; next: string; report: readonly string[] };

type Found = {
  file: string;
  name: string;
  place: Place;
  repo: string;
  aliases: ReadonlyMap<string, string>;
  fallbackSlug: string;
  mainOf: (ledger: Ledger) => string | undefined;
  branch?: string;
  worktree?: string;
  elsewhere?: boolean;
  host?: string;
};

/** The status of an active task with `ledger`. */
export const activeStatus = ({ location }: Ledger): TaskStatus => (location.lost ? 'lost' : (location.status?.value ?? 'active'));

function toTask({ file, name, place, repo, aliases, fallbackSlug, mainOf, branch, worktree, elsewhere, host }: Found, { text, mtimeMs, birthtimeMs }: TimedText): Task {
  const ledger = parseLedger(text);
  const currentRepo = aliases.get(repo);
  const status: TaskStatus = place === 'archive' ? 'retired' : place === 'backlog' ? 'backlog' : activeStatus(ledger);
  const main = mainOf(ledger);
  const knownBranch = branch ?? ledger.location.branch;
  const archived = place === 'archive' ? parseArchiveName(name)?.date : undefined;
  return {
    slug: ledger.slug ?? fallbackSlug,
    repo,
    ...(currentRepo === undefined ? {} : { currentRepo }),
    repoKeys: keyAndAliases(aliases, currentRepo ?? repo),
    ...(main === undefined ? {} : { main }),
    file,
    name,
    ...(worktree === undefined ? {} : { worktree }),
    ...(elsewhere ? { elsewhere: true } : {}),
    ...(host === undefined ? {} : { host }),
    place,
    status,
    ...(knownBranch === undefined ? {} : { branch: knownBranch }),
    ...(archived === undefined ? {} : { archived }),
    ledger,
    mtimeMs,
    birthtimeMs,
  };
}

export function backlogTasks(store: LedgerStore): Task[] {
  const aliases = store.aliases.read();
  return store.backlog
    .repos()
    .flatMap((repo) => store.backlog.list(repo))
    .map((entry) =>
      toTask({ file: entry.location, name: entry.name, place: 'backlog', repo: entry.repo, aliases, fallbackSlug: entry.name, mainOf: ({ location }) => location.main }, entry),
    );
}

/** Archived ledgers, of one repo, those under its aliases included, or of all. The slug is the title's; old copies were named after the branch. */
export function archivedTasks(store: LedgerStore, repo?: string): Task[] {
  const aliases = store.aliases.read();
  const mainOf = ({ location: { main, worktree } }: Ledger): string | undefined => main ?? (worktree === undefined ? undefined : mainOfTaskWorktree(worktree));
  return (repo === undefined ? store.archive.repos() : keyAndAliases(aliases, repo))
    .flatMap((name) => store.archive.list(name))
    .map((entry) => {
      const fallbackSlug = parseArchiveName(entry.name)?.slug ?? entry.name;
      return toTask({ file: entry.location, name: entry.name, place: 'archive', repo: entry.repo, aliases, fallbackSlug, mainOf }, entry);
    });
}

/** The checkout of a clone that is `folder`, with its branch; from one worktree listing per clone, however often asked. */
function checkoutFinder(): (main: string, folder: string) => Worktree | undefined {
  const listed = new Map<string, Worktree[]>();
  return (main, folder) => {
    const checkouts = listed.get(main) ?? worktrees(main);
    listed.set(main, checkouts);
    return checkouts.find(({ path: checkout }) => samePath(checkout, folder));
  };
}

/** How a task names the machine of an active record that names none, as one from before records named their host. */
export const UNKNOWN_HOST = 'unknown host';

/** Without `checkoutOf`, active records become tasks from the store and the file system alone, with no git call. */
type ActiveContext = { aliases: ReadonlyMap<string, string>; checkoutOf?: ReturnType<typeof checkoutFinder>; host: string | undefined; ownHosts: ReadonlySet<string> };

const activeContext = (store: LedgerStore, { git = true } = {}): ActiveContext => ({
  aliases: store.aliases.read(),
  ...(git ? { checkoutOf: checkoutFinder() } : {}),
  host: store.host,
  ownHosts: store.ownHosts ?? new Set(store.host === undefined ? [] : [store.host]),
});

/**
 * `entry` as a task. Its clone comes from the worktree's path, else from the record's main, and only then from git. It
 * is `elsewhere` when its record names a host that is none of this machine's, and unless git lists its worktree folder
 * as a checkout of that clone, a clone of the record's repo. Two machines can see one disk, so a worktree folder that is
 * here proves no record this machine's; the host does. Without git, a folder there that holds a .git entry stands in for
 * git's listing, as a plain folder left at the path is no checkout.
 */
function activeOf(entry: StoredLedger, { aliases, checkoutOf, host: thisHost, ownHosts }: ActiveContext): Task {
  const { location } = parseLedger(entry.text);
  const { worktree } = location;
  const folder = worktree !== undefined && isFolder(worktree);
  const main = (worktree === undefined ? undefined : mainOfTaskWorktree(worktree)) ?? location.main ?? (folder && checkoutOf !== undefined ? mainCheckout(worktree) : undefined);
  const otherHost = location.host !== undefined && thisHost !== undefined && !ownHosts.has(location.host);
  const resolved = (key: string): string => aliases.get(key) ?? key;
  // A lost task's old path may hold another task's worktree now, which must never count as this task's.
  const here = !otherHost && folder && location.lost === undefined && exists(path.join(worktree, '.git'));
  const checkout = here && checkoutOf !== undefined && main !== undefined && resolved(repoKey(main)) === resolved(entry.repo) ? checkoutOf(main, worktree) : undefined;
  const elsewhere = checkoutOf === undefined ? !here : checkout === undefined;
  const host = otherHost ? location.host : elsewhere && location.host === undefined ? UNKNOWN_HOST : undefined;
  const found = { file: entry.location, name: entry.name, place: 'active', repo: entry.repo, aliases, fallbackSlug: entry.name, mainOf: () => main, branch: checkout?.branch, worktree, elsewhere, host } as const;
  return toTask(found, entry);
}

/** The active record `entry` as a task. */
export const asActiveTask = (store: LedgerStore, entry: StoredLedger): Task => activeOf(entry, activeContext(store));

/** The active task whose worktree is `folder`, by the store's lookup, which fails when two records name the folder. */
export function activeTask(store: LedgerStore, folder: string): Task | undefined {
  const key = store.active.byWorktree(folder);
  const entry = key && readable(() => store.active.read(key.repo, key.slug));
  return entry && activeOf(entry, activeContext(store));
}

/** The active tasks of every repo, or of the repo whose key or old key is `repo`, under every key of it, by their records in the store. */
export function activeTasks(store: LedgerStore, repo?: string): Task[] {
  const context = activeContext(store);
  return (repo === undefined ? store.active.repos() : keyAndAliases(context.aliases, context.aliases.get(repo) ?? repo))
    .flatMap((each) => store.active.list(each))
    .map((entry) => activeOf(entry, context));
}

/** Why an elsewhere task is not written or gone to here. */
export const notOnThisMachine = ({ slug, worktree, host }: Pick<Task, 'slug' | 'worktree' | 'host'>): string => {
  const where = `the worktree ${worktree ?? 'its ledger names'}`;
  return host === undefined
    ? `${slug} is active in ${where}, which is not on this machine. Work on it there.`
    : `${slug} is active in ${where} on ${host}, which is not on this machine, and this machine has only a read-only copy of its ledger. Continue the task on ${host}.`;
};

/**
 * Every task ledger: the active ones, the backlog and the archive, of every repo. A backlog ledger with the repo and slug
 * of an active task is left out: the task has started, here or on another machine.
 */
export function findTasks(store: LedgerStore): Task[] {
  return withStarted(store, activeTasks(store));
}

function withStarted(store: LedgerStore, active: Task[]): Task[] {
  const key = (task: Task): string => `${task.currentRepo ?? task.repo}\n${task.slug}`;
  const started = new Set(active.map(key));
  return [...active, ...backlogTasks(store).filter((task) => !started.has(key(task))), ...archivedTasks(store)];
}

/**
 * findTasks from the store and the file system alone, with no git call, for the session start, which must not wait on
 * git once per task or in another repo. An active task is elsewhere when its record names another machine, or its folder
 * is gone, holds no .git entry, or is lost. Its main is its worktree's by path or its record's, else `main` for a task of
 * that repo, else the main another live task of its repo names.
 */
export function storedTasks(store: LedgerStore, main?: string): Task[] {
  const context = activeContext(store, { git: false });
  const tasks = withStarted(store, store.active.repos().flatMap((repo) => store.active.list(repo).map((entry) => activeOf(entry, context))));
  const mains = new Map(tasks.flatMap((task) => (task.main === undefined || task.place === 'archive' ? [] : [[keyOf(task), task.main] as const])));
  if (main !== undefined) {
    const key = repoKey(main);
    mains.set(context.aliases.get(key) ?? key, main);
  }
  return tasks.map((task) => {
    const known = task.place === 'active' && task.main === undefined ? mains.get(keyOf(task)) : undefined;
    return known === undefined ? task : { ...task, main: known };
  });
}

/**
 * Whether `task` is a task of the repo at `main`: a task of one repo key is one of each clone of the repo, by its key with
 * an alias of either resolved, never by the main it names, as that path may be a clone of another origin now.
 */
export function inRepo(task: Task, main: string, repoOf: RepoOf = repoKey): boolean {
  const key = repoOf(main);
  return key !== undefined && task.repoKeys.includes(key);
}

/** The repo key of the checkout at `main`, undefined when it is unknown: repoKey asks git, storedRepoOf only the store. */
export type RepoOf = (main: string) => string | undefined;

/**
 * repoKey from the store alone, for the session start, which must run no git in another repo: the key `known` has for
 * its main, else that of a live task whose main is `main`, by its ledger or by its parent's line for it, else undefined,
 * so a task there counts as not found.
 */
export function storedRepoOf(tasks: Task[], known?: { main: string; key: string }): RepoOf {
  const current = tasks.filter((task) => task.place !== 'archive');
  // A parent's child line can be stale, so a main a ledger names wins over one only a child line names.
  const live = [
    ...current.flatMap((task) => (task.main === undefined ? [] : [{ main: task.main, key: keyOf(task) }])),
    ...current.flatMap((task) => {
      const main = task.main === undefined ? mainNamedByParent(tasks, task) : undefined;
      return main === undefined ? [] : [{ main, key: keyOf(task) }];
    }),
  ];
  const keys = new Map<string, string | undefined>();
  const find = (main: string): string | undefined =>
    known !== undefined && samePath(main, known.main) ? known.key : live.find((each) => samePath(each.main, main))?.key;
  return (main) => {
    if (!keys.has(main)) keys.set(main, find(main));
    return keys.get(main);
  };
}

/** For a task whose ledger names no main: the main its parent in another repo names it by under ## Children, if any. */
export function mainNamedByParent(tasks: Task[], task: Task): string | undefined {
  const { slug, main } = task.ledger.location.parent ?? {};
  if (main === undefined) return undefined;
  const parent = tasks.find((each) => each.place !== 'archive' && each.slug === slug && each.main !== undefined && samePath(each.main, main));
  return parent?.ledger.children.find((line) => line.slug === task.slug)?.main;
}

const PRECEDENCE: Place[] = ['active', 'backlog', 'archive'];

/** A parent line without a main names a parent in the task's own repo. */
function namesParent(task: Task, parent: Required<TaskRef>, repoOf: RepoOf): boolean {
  const named = task.ledger.location.parent;
  if (named === undefined || named.slug !== parent.slug) return false;
  return named.main === undefined ? inRepo(task, parent.main, repoOf) : samePath(named.main, parent.main);
}

/**
 * The child `child` of `parent`: an active task beats a backlog ledger, which beats an archive copy, the same rule
 * `ledger list` follows. A slug can be reused, so an archive copy counts only when it names this parent or no parent.
 */
export function locateChild(tasks: Task[], child: Required<TaskRef>, parent: Required<TaskRef>, repoOf: RepoOf = repoKey): Task | undefined {
  const named = tasks.filter((task) => task.slug === child.slug && inRepo(task, child.main, repoOf));
  const counts = (task: Task): boolean => task.place !== 'archive' || namesParent(task, parent, repoOf) || task.ledger.location.parent === undefined;
  for (const place of PRECEDENCE) {
    const found = named.filter((task) => task.place === place && counts(task)).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (found !== undefined) return found;
  }
  return undefined;
}

/** An archive copy of `child` names `parent`: a new task with that slug would share the parent's line with the retired one. */
export const wasChildOf = (tasks: Task[], child: Required<TaskRef>, parent: Required<TaskRef>): boolean =>
  tasks.some((task) => task.place === 'archive' && task.slug === child.slug && inRepo(task, child.main) && namesParent(task, parent, repoKey));

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
 * Whether `a` and `b` name one task: a slug is one task per repo key, so a slug named from each clone of a repo is one.
 * Two checkouts whose key `repoOf` does not know are not one repo.
 */
export function sameTask(a: Required<TaskRef>, b: Required<TaskRef>, repoOf: RepoOf = repoKey): boolean {
  if (a.slug !== b.slug) return false;
  if (samePath(a.main, b.main)) return true;
  const key = repoOf(a.main);
  return key !== undefined && key === repoOf(b.main);
}

/** The live ledgers of `ref` (active or backlog), else its newest archive copy. */
export function findNamed(tasks: Task[], { slug, main }: Required<TaskRef>, repoOf: RepoOf = repoKey): Task[] {
  const named = tasks.filter((task) => task.slug === slug && inRepo(task, main, repoOf));
  const live = named.filter((task) => task.place !== 'archive');
  return live.length > 0 ? live : named.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 1);
}

/**
 * The ## Children bullets that name a child: `<slug>@<path>`, a slug marked started, as only a child's line gets one, or
 * a slug some known ledger has. Any other bullet is prose.
 */
export function namedChildren(parent: Task, tasks: Task[]): Child[] {
  // Any repo on purpose: a bare bullet may name a child whose ledger is elsewhere; it then shows as missing, not vanishes.
  // A retired mark with no ledger left is a child whose archive copy was deleted: done, so it must not block the parent.
  return parent.ledger.children.filter(
    (line) => line.main !== undefined || line.mark?.kind === 'started' || tasks.some(({ slug }) => slug === line.slug),
  );
}

/** `items` by the order `orderOf` gives each, lowest first, then those without one; each tie keeps its place. */
export function inOrder<T>(items: readonly T[], orderOf: (item: T) => number | undefined): T[] {
  const rank = (item: T): number => orderOf(item) ?? Number.POSITIVE_INFINITY;
  return [...items].sort((a, b) => (rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1));
}

/** A ## Children line that names a task, with the task by disk; `task` is undefined for a child no ledger has. */
export type ListedChild = { line: Child; ref: Required<TaskRef>; task?: Task };

/** The children `parent` names, in the order of their lines. A line without a main is in the parent's repo, `parentMain`. */
export function listedChildren(parent: Task, parentMain: string, tasks: Task[], repoOf: RepoOf = repoKey): ListedChild[] {
  return namedChildren(parent, tasks).map((line) => {
    const ref = { slug: line.slug, main: line.main ?? parentMain };
    return { line, ref, task: locateChild(tasks, ref, { slug: parent.slug, main: parentMain }, repoOf) };
  });
}

/** listedChildren by the order of each child: its own `- order:`, or what `orderOf` gives, for an order `tasks` predates. */
export const orderedChildren = (
  parent: Task,
  parentMain: string,
  tasks: Task[],
  orderOf = (task: Task): number | undefined => task.ledger.location.order,
  repoOf: RepoOf = repoKey,
): ListedChild[] => inOrder(listedChildren(parent, parentMain, tasks, repoOf), ({ task }) => task && orderOf(task));

/** The children `parent` lists, each with its status from disk, by order. */
export function childrenOf(parent: Task, parentMain: string, tasks: Task[], repoOf: RepoOf = repoKey): ChildView[] {
  return orderedChildren(parent, parentMain, tasks, undefined, repoOf).map(({ ref, task }) => ({
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

/**
 * The ledger `dependency` names, by the rule of locateChild: an active task, then the backlog, then the archive; the newest
 * of each. A dependency written before its repo was renamed names the old key, an alias of the task's repo now.
 */
export function dependencyTask(tasks: Task[], { slug, repo }: Required<Dependency>): Task | undefined {
  const named = tasks.filter((task) => task.slug === slug && task.repoKeys.includes(repo)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  return PRECEDENCE.map((place) => named.find((task) => task.place === place)).find((task) => task !== undefined);
}

/** A task no ledger names is not done: it may not be made yet. */
export const isDone = (task: Task | undefined): boolean => task !== undefined && (task.status === 'retired' || task.ledger.location.status?.value === 'done');
