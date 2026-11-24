// @ref LLP 0001#4-storage — D9: only ledger store repair looks on disk for a task's folder, in folders the operator names; D10: a renamed remote.
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { setLocationBullet, setLostMark } from './edit.js';
import { fail } from './failure.js';
import { folderEntries, isFolder } from './files.js';
import { lostText, parseLedger } from './format.js';
import { checkoutRoot, currentBranch, mainCheckout, repairWorktree } from './git.js';
import { withLock } from './lock.js';
import { messageOf, moveLedger, namedMain, places, shown, type Place } from './migrate-repo-ids.js';
import { samePath } from './paths.js';
import { isRepoKey, repoKey, repoLabel } from './repo-key.js';
import { checkTransition, stateOf } from './states.js';
import { keyAndAliases, readable, SharedWorktree, type Alias, type LedgerStore } from './store.js';
import { activeTasks, taskRef, UNKNOWN_HOST, type Task } from './tasks.js';
import { heading, plural } from './views.js';
import { otherMachineRecord, readLedger, shellWord, today, updateActive, type Context } from './write.js';

type Print = (text: string) => void;

export type RepairOptions = { to?: string; lost: boolean; remote?: string; search?: string[]; dryRun: boolean };

/**
 * `store` is what every check reads: undefined while nothing is stored yet, as before a SQLite store's database exists.
 * `writable` opens the store to write, and is called only once every check has passed, so a refusal writes nothing.
 */
export type RepairContext = Omit<Context, 'store'> & { readonly store: LedgerStore | undefined; writable: () => LedgerStore };

export const SEARCH_DEPTH = 6;

const onOtherMachine = ({ host }: Task): boolean => host !== undefined && host !== UNKNOWN_HOST;

/** The active tasks of this machine, neither parked nor lost, whose recorded folder is gone: --to refuses a parked one. */
const missingTasks = (store: LedgerStore): Task[] =>
  activeTasks(store).filter((task) => task.status !== 'parked' && task.status !== 'lost' && task.worktree !== undefined && !isFolder(task.worktree) && !onOtherMachine(task));

/** The key the repo at `main` has now, when `main` is still a main checkout. */
function keyNow(main: string): string | undefined {
  const checkout = isFolder(main) ? mainCheckout(main) : undefined;
  return checkout !== undefined && samePath(checkout, main) ? repoKey(checkout) : undefined;
}

/** A repo key whose tasks name main checkouts that have another key now: `keys` maps each such key to one of them. */
type Renamed = { old: string; keys: Map<string, string> };

/**
 * Keys from before D10, folder names, are left to ledger store migrate --repo-ids. A named checkout whose key is the
 * same repo as `old`, once aliases are resolved, is no rename; another named checkout that still has `old` hides none.
 */
function renamedKeys(store: LedgerStore, aliases: ReadonlyMap<string, string>): Renamed[] {
  const repos = [...new Set(places.flatMap((place) => store[place].repos()))].filter((key) => key.includes('/')).sort();
  return repos.flatMap((old) => {
    const mains = new Set(places.flatMap((place) => store[place].list(old).flatMap(({ text }) => namedMain(text) ?? [])));
    const keys = new Map<string, string>();
    for (const main of mains) {
      const key = keyNow(main);
      if (key !== undefined && !sameRepo(aliases, key, old) && !keys.has(key)) keys.set(key, main);
    }
    return keys.size > 0 ? [{ old, keys }] : [];
  });
}

type Checkout = { folder: string; branch?: string };

/** The native realpath also gives the case a folder has on disk, so a case-insensitive volume spells each folder once. */
function canonicalPath(folder: string): string {
  try {
    return realpathSync.native(folder);
  } catch {
    return folder;
  }
}

/**
 * Each checkout in `roots` and in their folders down to SEARCH_DEPTH, with its branch, by its canonical path and once,
 * as a root may hold another. No symbolic link is followed, and a root is skipped when it or a folder above it would be
 * skipped in the search, by the names they have on disk.
 */
function checkoutsIn(roots: string[]): Checkout[] {
  const found = new Map<string, Checkout>();
  const visit = (folder: string, depth: number): void => {
    const entries = folderEntries(folder);
    const real = canonicalPath(folder);
    if (entries.some(({ name }) => name === '.git') && !found.has(real)) found.set(real, { folder: real, branch: currentBranch(folder) });
    if (depth === SEARCH_DEPTH) return;
    for (const entry of entries) {
      const child = path.join(folder, entry.name);
      if (entry.isDirectory() && !isSkipped(child)) visit(child, depth + 1);
    }
  };
  for (const root of roots) if (!isWithinSkipped(canonicalPath(root))) visit(root, 0);
  return [...found.values()];
}

const BUILD_FOLDERS = path.sep + path.join('.claude', 'worktrees', '.build');

/** In any case, as a disk that ignores case may hold Node_Modules, and one that does not is searched the same way. */
const isSkipped = (folder: string): boolean => {
  const lower = folder.toLowerCase();
  return ['.git', 'node_modules'].includes(path.basename(lower)) || lower.endsWith(BUILD_FOLDERS);
};

const isWithinSkipped = (folder: string): boolean => {
  const parent = path.dirname(folder);
  return isSkipped(folder) || (parent !== folder && isWithinSkipped(parent));
};

const resolved = (aliases: ReadonlyMap<string, string>, key: string): string => aliases.get(key) ?? key;

/** Whether the repo keys `a` and `b` name one repo: the same key, once an alias of either is resolved. */
const sameRepo = (aliases: ReadonlyMap<string, string>, a: string, b: string): boolean => resolved(aliases, a) === resolved(aliases, b);

/** Whether `folder` is a linked worktree, not a main checkout, of the repo `key`. */
function isWorktreeOf(aliases: ReadonlyMap<string, string>, folder: string, key: string): boolean {
  const main = mainCheckout(folder);
  return main !== undefined && !samePath(main, folder) && sameRepo(aliases, repoKey(main), key);
}

/** The active record of a task other than `task` that names `folder` as its folder. */
function otherHolder(store: LedgerStore, folder: string, { repo, name }: Task) {
  const holder = store.active.byWorktree(folder);
  return holder !== undefined && (holder.repo !== repo || holder.slug !== name) ? holder : undefined;
}

/** Fails when the active record of a task other than `task` names `folder`. */
function refuseTaken(store: LedgerStore, folder: string, task: Task): void {
  const holder = otherHolder(store, folder, task);
  if (holder !== undefined) fail(`${holder.slug} of ${shown(holder.repo)} names ${folder} as its folder already.`);
}

/**
 * Runs `write` while no other ledger store repair writes: --to, --lost and --remote each hold this lock. A record's lock
 * covers one record, so two --to runs that point two tasks at one folder would both find it free, and two --remote runs
 * would plan the same moves; under this lock the second finds what the first wrote. Kept while its process runs, as a
 * --remote run with many moves and a store commit may hold it past the minute after which a lock counts as left over.
 */
const withRepairLock = <T>({ paths }: Context, write: () => T): T => withLock(path.join(paths.home, '.claude', 'ledger-repair'), write, { keepWhileRunning: true });

/** Whether no active record but `task`'s names `folder`. A folder two records name counts as taken, so the report goes on. */
function isUnclaimed(store: LedgerStore, folder: string, task: Task): boolean {
  try {
    return otherHolder(store, folder, task) === undefined;
  } catch (error) {
    if (error instanceof SharedWorktree) return false;
    throw error;
  }
}

/**
 * How a command names `task`: `<slug>@<main>`, so it runs from any folder, with a main checkout of its repo that is
 * there: the one that holds cwd, else the one the record names, else one of the folders a search `found`.
 */
function refOf({ store, cwd }: Context, { slug, main, repo }: Task, found: readonly string[] = []): string {
  const aliases = store.aliases.read();
  const checkout = [mainCheckout(cwd), main, ...found.map(mainCheckout)].find((each) => {
    const key = each === undefined ? undefined : keyNow(each);
    return key !== undefined && sameRepo(aliases, key, repo);
  });
  return checkout === undefined ? `${slug}@<a checkout of ${repoLabel(repo)}>` : shellWord(`${slug}@${checkout}`);
}

function searchRoots(cwd: string, search: string[] | undefined): string[] {
  return (search ?? []).map((folder) => {
    // Each part as named, not resolved: path.resolve drops a `..` by the text, where the disk goes up from the folder a
    // symbolic link before it leads to, so /tmp/.. is / to path.resolve and /private on macOS.
    const named = path.isAbsolute(folder) ? folder : `${cwd}${path.sep}${folder}`;
    if (!isFolder(named)) fail(`${named} is no folder, so it was not searched.`);
    const parts = named.split(path.sep);
    const isLink = (end: number): boolean => lstatSync(parts.slice(0, end + 1).join(path.sep) || path.sep).isSymbolicLink();
    if (parts.some((_, end) => isLink(end))) {
      fail(`${named} goes through a symbolic link, and the search follows none, so it was not searched. Name the folder it leads to: ${realpathSync.native(named)}`);
    }
    return path.resolve(named);
  });
}

function report(context: Context, search: string[] | undefined, print: Print): number {
  const { store, cwd } = context;
  const roots = searchRoots(cwd, search);
  const aliases = store.aliases.read();
  const missing = missingTasks(store);
  const renamed = renamedKeys(store, aliases);
  const problems = missing.length + renamed.length;
  if (problems === 0) {
    print('No problems found.');
    return 0;
  }
  const checkouts = search === undefined || missing.length === 0 ? [] : checkoutsIn(roots);
  const lines = [heading('Store repair', plural(problems, 'problem'))];
  const moves: string[] = [];
  const refiles: string[] = [];
  if (missing.length > 0) lines.push('', 'Folder not found:');
  for (const task of missing) {
    const branch = task.ledger.location.branch;
    lines.push(`  ${task.slug} (${repoLabel(task.repo)}): ${task.worktree}, branch ${branch ?? 'not recorded'}`);
    const candidates =
      branch === undefined ? [] : checkouts.filter(({ folder, branch: on }) => on === branch && isWorktreeOf(aliases, folder, task.repo) && isUnclaimed(store, folder, task));
    if (search !== undefined) lines.push(...(candidates.length === 0 ? [`    no checkout on ${branch ?? 'its branch'} in ${roots.join(', ')}`] : candidates.map(({ folder }) => `    found ${folder}`)));
    const [only] = candidates.length === 1 ? candidates : [];
    // Any checkout of the repo names the task, on whatever branch.
    const ref = refOf(context, task, checkouts.map(({ folder }) => folder));
    moves.push(`  ledger store repair ${ref} --to ${only === undefined ? '<folder>' : shellWord(only.folder)}`);
    // --lost refuses a blocked, waiting or done task.
    if (task.status === 'active') moves.push(`  ledger store repair ${ref} --lost`);
  }
  if (renamed.length > 0) lines.push('', 'Remote renamed:');
  for (const { old, keys } of renamed) {
    lines.push(`  ${old} → ${[...keys.keys()].join(', ')}`);
    const [[, main]] = keys;
    refiles.push(keys.size === 1 ? `  cd ${shellWord(main)} && ledger store repair --remote ${shellWord(old)}` : `  ${old}: its tasks name checkouts of ${keys.size} repos now, so no one command files them; move each by hand`);
  }
  print(
    [
      ...lines,
      ...(moves.length === 0 ? [] : ['', 'Point each task at the folder it moved to, or mark it lost:', ...moves]),
      ...(refiles.length === 0 ? [] : ['', 'File the tasks of each renamed remote under its new key:', ...refiles]),
    ].join('\n'),
  );
  return problems;
}

function activeNamed(context: Context, name: string): Task {
  const { store, cwd } = context;
  const ref = taskRef(cwd, name);
  const key = resolved(store.aliases.read(), repoKey(ref.main));
  const found = activeTasks(store, key).filter(({ slug }) => slug === ref.slug);
  if (found.length === 0) fail(`${ref.slug} is not an active task of ${shown(key)}, so it was not repaired.`);
  if (found.length > 1) fail(`${found.length} active records of ${shown(key)} have the slug ${ref.slug}: ${found.map(({ file }) => file).join(', ')}`);
  const [task] = found;
  // updateActive refuses it too, but only once the store is open to write.
  const refused = otherMachineRecord(store, task.name, readLedger(context, task));
  if (refused !== undefined) fail(`${refused} Nothing was changed.`);
  return task;
}

const withBullet = (text: string, name: string, value: string | undefined): string => setLocationBullet(text, name, value) ?? text;

function pointTo(context: Context, writable: () => LedgerStore, name: string, to: string, dryRun: boolean, print: Print): void {
  const task = activeNamed(context, name);
  const folder = path.resolve(context.cwd, to);
  // By its parked mark, not its status, which a lost mark decides: --to must not make a parked task active.
  if (task.ledger.location.status?.value === 'parked') fail(`${task.slug} is parked, so it was not pointed at ${folder}: --to repairs only a task that is active or lost.`);
  // A status line under the lost mark stays, as nothing else could clear it on a lost task.
  if (task.status === 'lost') checkTransition(task.slug, 'lost', 'active');
  if (!isFolder(folder)) fail(`${folder} does not exist, so ${task.slug} was not pointed at it.`);
  const root = checkoutRoot(folder);
  const main = mainCheckout(folder);
  if (root === undefined || main === undefined) fail(`${folder} is not a git checkout. If its repo moved too, run git -C <main checkout> worktree repair ${shellWord(folder)} first.`);
  if (!samePath(root, folder)) fail(`${folder} is inside the checkout ${root}; name the checkout's top folder.`);
  if (samePath(main, folder)) fail(`${folder} is the main checkout of its repo, and an active task lives in a linked worktree.`);
  const key = repoKey(main);
  if (!sameRepo(context.store.aliases.read(), key, task.repo)) fail(`${folder} is a checkout of ${shown(key)}, not of ${shown(task.repo)}, the repo of ${task.slug}.`);
  refuseTaken(context.store, folder, task);
  const branch = task.ledger.location.branch;
  const current = currentBranch(folder);
  if (current !== branch) fail(`${folder} is on ${current === undefined ? 'no branch' : `the branch ${current}`}, not on ${task.slug}'s branch ${branch ?? '(none recorded)'}.`);
  // The recorded main, not task.main, which may be inferred from the old folder: the next rename is found by the record.
  let recordedMain = task.ledger.location.main;
  const namesMain = (recorded: string | undefined): boolean => recorded !== undefined && samePath(recorded, main);
  const would = (done: string, planned: string): string => (dryRun ? `Would ${planned}` : done);

  if (!dryRun) {
    const store = writable();
    // Checked again under the locks: the check above read the store before another repair may have written, such as
    // a --to that pointed the task into another clone of its repo, whose main checkout this one replaces.
    const repoint = (text: string): string => {
      refuseTaken(store, folder, task);
      recordedMain = parseLedger(text).location.main;
      // The lost mark names the old folder, so it goes before the worktree changes.
      const found = setLostMark(text, undefined) ?? text;
      return withBullet(namesMain(recordedMain) ? found : withBullet(found, 'main', main), 'worktree', folder);
    };
    withRepairLock(context, () => updateActive({ ...context, store }, task, repoint));
  }
  const movedMain = namesMain(recordedMain) ? undefined : main;
  const lines = [
    `${would('Pointed', 'point')} ${task.slug} at ${folder}; it named ${task.worktree ?? 'no folder'}.`,
    ...(movedMain === undefined ? [] : [`${would('Recorded', 'record')} its main checkout ${movedMain}${recordedMain === undefined ? '' : `; it was ${recordedMain}`}.`]),
    ...(task.status === 'lost' ? [`${would('Removed', 'remove')} its lost mark.`] : []),
  ];
  const repair = `git -C ${shellWord(main)} worktree repair ${shellWord(folder)}`;
  if (dryRun) return print([...lines, `Would run ${repair}.`].join('\n'));
  const error = repairWorktree(main, folder);
  print(lines.join('\n'));
  if (error !== undefined) fail(`The record names ${folder} now, but ${repair} failed: ${error}`);
  print(`Ran ${repair}.`);
}

function markLost(context: Context, writable: () => LedgerStore, name: string, dryRun: boolean, print: Print): void {
  const task = activeNamed(context, name);
  const state = stateOf(task.ledger.location);
  if (state !== 'lost') checkTransition(task.slug, state, 'lost');
  const refuseThere = (worktree: string | undefined): void => {
    if (worktree !== undefined && isFolder(worktree)) {
      fail(`The folder of ${task.slug}, ${worktree}, is there, so it is not lost. If the task moved, point it at its new folder: ledger store repair ${refOf(context, task)} --to <folder>`);
    }
  };
  const { worktree, lost } = task.ledger.location;
  refuseThere(worktree);
  if (lost !== undefined) return print(`${task.slug} is lost already, since ${lost.date}.`);
  const mark = { date: today() };
  const line = lostText(mark, worktree);
  // Checked again on the record as it is under its lock, which a --to may have pointed at a folder since.
  const markLostNow = (text: string): string => {
    refuseThere(parseLedger(text).location.worktree);
    return setLostMark(text, mark) ?? text;
  };
  if (!dryRun) withRepairLock(context, () => updateActive({ ...context, store: writable() }, task, markLostNow));
  print(`${dryRun ? 'Would mark' : 'Marked'} ${task.slug} lost: ${line}.`);
}

/** A ledger's slug as findTasks sees it: its title's, else its store name. */
const slugOf = ({ name, text }: { name: string; text: string }): string => parseLedger(text).slug ?? name;

/** Whether `a` and `b` are one file by device and inode, as two spellings on a disk that ignores case are. */
function isSameFile(a: string, b: string): boolean {
  const [x, y] = [a, b].map((file) => lstatSync(file, { throwIfNoEntry: false }));
  return x !== undefined && y !== undefined && x.dev === y.dev && x.ino === y.ino;
}

/** The key of the repo that holds `cwd`, to file the tasks of `old` under; it fails unless `old` is another repo key. */
function keyToFileUnder(cwd: string, old: string): string {
  const main = mainCheckout(cwd) ?? fail(`${cwd} is not inside a git repository. Run this in a checkout of the repo whose remote was renamed.`);
  const key = repoKey(main);
  if (!isRepoKey(old)) fail(`${old} is no repo key.`);
  if (old === key) fail(`${old} is the key of this repo now. Name the key it had before.`);
  return key;
}

const nothingFiledUnder = (old: string): never => fail(`No task is filed under ${old}, so nothing was moved.`);

/** `ledger store repair --remote <old-key>`: as ledger store migrate --repo-ids, it moves only what is sure. Gives how many ledgers it left. */
function refileRemote({ store, cwd }: Context, writable: () => LedgerStore, old: string, dryRun: boolean, print: Print): number {
  const key = keyToFileUnder(cwd, old);
  if (store.sharesFolder?.(old, key) === true) fail(`${old} and ${key}, the key of this repo, are the same repository folder in the store, so its tasks are filed under ${key} already. Nothing was changed.`);
  const problem = store.aliases.problem();
  if (problem !== undefined) fail(`${problem} So nothing was moved.`);
  const aliases = store.aliases.read();
  const saved = aliases.get(old);
  if (saved !== undefined && saved !== key) fail(`${old} is an alias of ${shown(saved)} already, so nothing was moved to ${shown(key)}.`);
  // A lookup resolves one alias, never a chain, so old → key → third would hide the tasks filed under old.
  const third = aliases.get(key);
  if (third !== undefined && third !== old) {
    fail(`${key}, the key of this repo, is an alias of ${shown(third)} already: filing ${old} under it would chain two aliases, so nothing was moved. If this repo was renamed back from ${third}, run ledger store repair --remote ${shellWord(third)} first.`);
  }
  const ledgers = places.flatMap((place) => store[place].list(old).map(({ name, text }) => ({ place, name, text })));
  const unreadable = places.flatMap((place) => store[place].unreadable(old).map((name) => ({ place, name })));
  // Evidence whose archive copy moved to `key` without it, as when its rename failed. Other evidence with no copy stays.
  const archive = store.archive;
  const names = archive.orphanEvidenceIn?.(old) ?? archive.orphanEvidence().flatMap(({ repo, name }) => (repo === old ? [name] : []));
  const strays = names.flatMap((name) => readable(() => archive.read(key, name)) ?? []);
  if (ledgers.length + unreadable.length + strays.length === 0 && saved === undefined) nothingFiledUnder(old);
  // A ledger a run that stopped left under both keys is the one under old, which its move finishes.
  const halfMoved = (place: 'backlog' | 'active', each: string, name: string): boolean => each === key && store[place].movedHalfway?.(old, name, key) === true;
  // findTasks hides a backlog task behind an active one of the same slug, so a slug in either place takes it in both.
  const liveOf = (each: string) =>
    (['backlog', 'active'] as const).flatMap((place) =>
      store[place].list(each).map((ledger) => ({ place, slug: slugOf(ledger), location: ledger.location, halfMoved: halfMoved(place, each, ledger.name) })),
    );
  const live = keyAndAliases(aliases, key).filter((each) => each !== old).flatMap(liveOf);
  const liveSlugsOf = (each: string): string[] => liveOf(each).map(({ slug }) => slug);
  const liveSlugs = new Set(live.flatMap(({ slug, halfMoved }) => (halfMoved ? [] : [slug])));
  const pointing = [...aliases].flatMap(([alias, target]) => (target === old && alias !== key ? [alias] : []));
  // The tasks of an alias stay filed under it, so a clash cannot be left under old as a move is: it refuses them all.
  const clashes = pointing.flatMap((alias) => liveSlugsOf(alias).filter((slug) => liveSlugs.has(slug)).map((slug) => `${slug} of the alias ${alias}`));
  if (clashes.length > 0) {
    fail(`${shown(key)} has a live task with the slug of ${clashes.join(', ')}: re-pointing the aliases of ${old} would hide one task of each slug, so nothing was moved. Retire or rename one of each, then run this again.`);
  }
  /** Why the ledger stays under `old`, decided before anything moves; the store's own checks come at the move. */
  const conflict = (place: Place, ledger: { name: string; text: string }): string | undefined => {
    // The earlier run checked the checkout before making the link. It may have disappeared since.
    if (!store[place].movedHalfway?.(old, ledger.name, key)) {
      const main = namedMain(ledger.text);
      // As in ledger store migrate --repo-ids, an alias old → key already says where a ledger that names no main belongs.
      const now = main === undefined ? saved : keyNow(main);
      if (now === undefined) return main === undefined ? 'it names no main checkout, so its repo is not known' : `its main checkout ${main} is not one any more`;
      if (!sameRepo(aliases, now, key)) return `its main checkout ${main} is a checkout of ${shown(now)}`;
    }
    if (place === 'archive') return undefined;
    // Its copy under key is the file its name resolves to there, which a disk that ignores case may list in another case.
    const destination = store[place].location(key, ledger.name);
    const isOwn = (each: (typeof live)[number]): boolean => each.halfMoved && each.place === place && isSameFile(each.location, destination);
    const others = new Set(live.flatMap((each) => (isOwn(each) ? [] : [each.slug])));
    // The old key may have only the Markdown that its copy's record used to hide.
    const slugs = [slugOf(ledger), ...live.flatMap((each) => (isOwn(each) ? [each.slug] : []))];
    const clash = slugs.find((slug) => others.has(slug));
    return clash === undefined ? undefined : `${shown(key)} already has ${clash}`;
  };
  // A move the read store already refuses, as a taken archive name, must not open the store to write.
  const planOf = (place: Place, name: string, why: string | undefined) => ({ place, name, why: why ?? moveLedger(store, place, { old, name, to: key }, true) });
  const plan = [
    ...ledgers.map((ledger) => ({ ...planOf(ledger.place, ledger.name, conflict(ledger.place, ledger)), what: `${ledger.place} ${ledger.name}` })),
    ...unreadable.map(({ place, name }) => ({ place, name, what: `${place} ${name}`, why: `its record ${store[place].location(old, name)} cannot be read; fix or remove it` })),
    ...strays.map((copy) => ({ ...planOf('archive', copy.name, conflict('archive', copy)), what: `the evidence of archive ${copy.name}` })),
  ];
  // A repo renamed back has key → old from the first rename; keeping it beside old → key would make a cycle.
  const renamedBack = aliases.get(key) === old;
  const removed: Alias[] = [...pointing.map((alias): Alias => [alias, old]), ...(renamedBack ? [[key, old] as const] : [])];
  const added: Alias[] = [...(saved === undefined ? [[old, key] as const] : []), ...pointing.map((alias): Alias => [alias, key])];
  // Before the moves, so a run that stops after them leaves the alias for a rerun to find; taken back when a ledger
  // stays, unless the commit fails.
  const aliasesFirst = !dryRun && removed.length + added.length > 0 && plan.every(({ why }) => why === undefined);

  print(`Move the tasks of ${shown(old)} to ${shown(key)}${dryRun ? ' · dry run, nothing changed' : ''}`);
  if (plan.length === 0) print(`Nothing is left under ${old} to move.`);
  const act = (done: string, planned: string): string => (dryRun ? `would ${planned}` : done);
  let writer: LedgerStore | undefined;
  const target = (): LedgerStore => (dryRun ? store : (writer ??= writable()));
  let [moved, left] = [0, 0];
  if (aliasesFirst) target().aliases.replace(removed, added);
  for (const { place, name, what, why: kept } of plan) {
    const why = kept ?? moveLedger(target(), place, { old, name, to: key }, dryRun);
    if (why === undefined) moved++;
    else left++;
    print(why === undefined ? `${act('moved', 'move')} ${what}` : `left ${what}: ${why}`);
  }
  try {
    writer?.commit?.();
    // The run that recorded the alias may have stopped between its moves and their commit, which no plan shows.
    if (!dryRun && saved !== undefined && store.commitPending !== undefined) target().commitPending?.(old, key);
  } catch (error) {
    // An alias is never committed, so it stays: once the problem is fixed, the next sync commits the moves.
    const alias = aliasesFirst || saved !== undefined ? ` ${old} is recorded as an alias of ${shown(key)} here.` : '';
    fail(`The store commit failed, so the tasks moved from ${old} to ${key} are on this machine only; other machines still find them under ${old}.${alias} Fix the problem below, then run ledger store sync.\n${messageOf(error)}`);
  }
  if (left > 0) {
    if (aliasesFirst) target().aliases.replace(added, removed);
    const repoints = pointing.length === 0 ? '' : `, and left ${plural(pointing.length, 'alias', 'aliases')} of it as ${pointing.length === 1 ? 'it is' : 'they are'}`;
    const alias = saved === undefined ? `kept no alias for ${old}` : `kept the alias ${old} of ${shown(key)}, recorded before`;
    print(`${alias}${repoints}: ${plural(left, 'ledger')} ${left === 1 ? 'is' : 'are'} still filed under it. Move or retire ${left === 1 ? 'it' : 'them'}, then run this again.`);
  } else {
    if (saved === undefined) print(`${act('recorded', 'record')} ${old} as an alias of ${shown(key)}`);
    if (renamedBack) print(`${act('removed', 'remove')} the alias ${key} of ${shown(old)}, as ${key} is the key of this repo again`);
    for (const alias of pointing) print(`${act('re-pointed', 're-point')} the alias ${alias} from ${old} to ${shown(key)}`);
  }
  if (plan.length > 0) print(`${dryRun ? 'Would move' : 'Moved'} ${plural(moved, 'ledger')}; ${dryRun ? 'would leave' : 'left'} ${left} as ${left === 1 ? 'it is' : 'they are'}.`);
  return left;
}

/** `ledger store repair`. Gives the problems it found or left, for exit 1. */
export function repairStore(context: RepairContext, slug: string | undefined, { to, lost, remote, search, dryRun }: RepairOptions, print: Print): number {
  if (slug !== undefined && remote !== undefined) fail(`--remote moves every task of a repo key, so it takes no task: drop ${slug}.`);
  if (slug !== undefined && search !== undefined) fail(`--search looks for the folder of every task whose folder is gone, so it takes no task: drop ${slug}.`);
  if (slug === undefined && (to !== undefined || lost)) fail(`${to === undefined ? '--lost' : '--to'} repairs one task: ledger store repair <slug> ${to === undefined ? '--lost' : '--to <folder>'}`);
  if (slug !== undefined && to === undefined && !lost) fail(`Say how to repair ${slug}: --to <folder> points it at the folder it moved to, --lost marks it lost.`);
  if (dryRun && to === undefined && !lost && remote === undefined) fail('--dry-run goes with --to, --lost or --remote; the report alone changes nothing.');
  const { paths, cwd, store, writable } = context;
  if (store === undefined) {
    if (remote !== undefined) {
      keyToFileUnder(cwd, remote);
      nothingFiledUnder(remote);
    }
    if (slug !== undefined) fail('The store holds no task yet, so nothing was changed.');
    searchRoots(cwd, search);
    print('No problems found.');
    return 0;
  }
  const reading: Context = { paths, cwd, store };
  if (slug !== undefined && to !== undefined) return (pointTo(reading, writable, slug, to, dryRun, print), 0);
  if (slug !== undefined) return (markLost(reading, writable, slug, dryRun, print), 0);
  if (remote !== undefined) {
    const refile = (): number => refileRemote(reading, writable, remote, dryRun, print);
    // Before the old key's ledgers are listed, as a run plans its moves by what it lists.
    return dryRun ? refile() : withRepairLock(reading, refile);
  }
  return report(reading, search, print);
}
