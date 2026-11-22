// @ref LLP 0001#4-storage — D9: only ledger store repair looks on disk for a task's folder, in folders the operator names; D10: a renamed remote.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { setLocationBullet, setLostMark } from './edit.js';
import { fail } from './failure.js';
import { folderEntries, isFolder } from './files.js';
import { lostText, parseLedger } from './format.js';
import { checkoutRoot, currentBranch, mainCheckout, repairWorktree } from './git.js';
import { moveLedger, namedMain, places, shown, type Place } from './migrate-repo-ids.js';
import { samePath } from './paths.js';
import { isRepoKey, repoKey, repoLabel } from './repo-key.js';
import { keyAndAliases, SharedWorktree, type Alias, type LedgerStore } from './store.js';
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

/** The active tasks of this machine, neither parked nor lost, whose recorded folder is gone. */
const missingTasks = (store: LedgerStore): Task[] =>
  activeTasks(store).filter((task) => task.status === 'active' && task.worktree !== undefined && !isFolder(task.worktree) && !onOtherMachine(task));

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
 * as a root may hold another. No symbolic link is followed.
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
  for (const root of roots) visit(root, 0);
  return [...found.values()];
}

const BUILD_FOLDERS = path.join('.claude', 'worktrees', '.build');

const isSkipped = (folder: string): boolean => ['.git', 'node_modules'].includes(path.basename(folder)) || folder.endsWith(path.sep + BUILD_FOLDERS);

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
  const roots = (search ?? []).map((folder) => path.resolve(cwd, folder));
  for (const root of roots) if (!isFolder(root)) fail(`${root} is no folder, so it was not searched.`);
  return roots;
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
    moves.push(`  ledger store repair ${ref} --to ${only === undefined ? '<folder>' : shellWord(only.folder)}`, `  ledger store repair ${ref} --lost`);
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
  if (task.ledger.parked !== undefined) fail(`${task.slug} is parked, so it was not pointed at ${folder}: --to repairs only a task that is active or lost.`);
  if (!isFolder(folder)) fail(`${folder} does not exist, so ${task.slug} was not pointed at it.`);
  const root = checkoutRoot(folder);
  const main = mainCheckout(folder);
  if (root === undefined || main === undefined) fail(`${folder} is not a git checkout. If its repo moved too, run git -C <main checkout> worktree repair ${shellWord(folder)} first.`);
  if (!samePath(root, folder)) fail(`${folder} is inside the checkout ${root}; name the checkout's top folder.`);
  if (samePath(main, folder)) fail(`${folder} is the main checkout of its repo, and an active task lives in a linked worktree.`);
  const key = repoKey(main);
  if (!sameRepo(context.store.aliases.read(), key, task.repo)) fail(`${folder} is a checkout of ${shown(key)}, not of ${shown(task.repo)}, the repo of ${task.slug}.`);
  const holder = otherHolder(context.store, folder, task);
  if (holder !== undefined) fail(`${holder.slug} of ${shown(holder.repo)} names ${folder} as its folder already.`);
  const branch = task.ledger.location.branch;
  const current = currentBranch(folder);
  if (current !== branch) fail(`${folder} is on ${current === undefined ? 'no branch' : `the branch ${current}`}, not on ${task.slug}'s branch ${branch ?? '(none recorded)'}.`);
  // The recorded main, not task.main, which may be inferred from the old folder: the next rename is found by the record.
  const recordedMain = task.ledger.location.main;
  const movedMain = recordedMain === undefined || !samePath(recordedMain, main) ? main : undefined;
  const would = (done: string, planned: string): string => (dryRun ? `Would ${planned}` : done);

  if (!dryRun) {
    // The lost mark names the old folder, so it goes before the worktree changes.
    const repoint = (text: string): string => {
      const found = setLostMark(text, undefined) ?? text;
      return withBullet(movedMain === undefined ? found : withBullet(found, 'main', movedMain), 'worktree', folder);
    };
    updateActive({ ...context, store: writable() }, task, repoint);
  }
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
  // A parked task goes back to active only; --to, which removes a lost mark, refuses it.
  if (task.ledger.parked !== undefined) fail(`${task.slug} is parked, so it was not marked lost: --lost marks only an active task.`);
  const { worktree, lost } = task.ledger.location;
  if (worktree !== undefined && isFolder(worktree)) {
    fail(`The folder of ${task.slug}, ${worktree}, is there, so it is not lost. If the task moved, point it at its new folder: ledger store repair ${refOf(context, task)} --to <folder>`);
  }
  if (lost !== undefined) return print(`${task.slug} is lost already, since ${lost.date}.`);
  const mark = { date: today() };
  const line = lostText(mark, worktree);
  if (!dryRun) updateActive({ ...context, store: writable() }, task, (text) => setLostMark(text, mark) ?? text);
  print(`${dryRun ? 'Would mark' : 'Marked'} ${task.slug} lost: ${line}.`);
}

/** A ledger's slug as findTasks sees it: its title's, else its store name. */
const slugOf = ({ name, text }: { name: string; text: string }): string => parseLedger(text).slug ?? name;

/** `ledger store repair --remote <old-key>`: as ledger store migrate --repo-ids, it moves only what is sure. Gives how many ledgers it left. */
function refileRemote({ store, cwd }: Context, writable: () => LedgerStore, old: string, dryRun: boolean, print: Print): number {
  const main = mainCheckout(cwd) ?? fail(`${cwd} is not inside a git repository. Run this in a checkout of the repo whose remote was renamed.`);
  const key = repoKey(main);
  if (!isRepoKey(old)) fail(`${old} is no repo key.`);
  if (old === key) fail(`${old} is the key of this repo now. Name the key it had before.`);
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
  if (ledgers.length === 0 && saved === undefined) fail(`No task is filed under ${old}, so nothing was moved.`);
  // findTasks hides a backlog task behind an active one of the same slug, so a slug in either place takes it in both.
  const liveSlugsOf = (each: string): string[] => [...store.backlog.list(each), ...store.active.list(each)].map(slugOf);
  const liveSlugs = new Set(keyAndAliases(aliases, key).filter((each) => each !== old).flatMap(liveSlugsOf));
  const pointing = [...aliases].flatMap(([alias, target]) => (target === old && alias !== key ? [alias] : []));
  // The tasks of an alias stay filed under it, so a clash cannot be left under old as a move is: it refuses them all.
  const clashes = pointing.flatMap((alias) => liveSlugsOf(alias).filter((slug) => liveSlugs.has(slug)).map((slug) => `${slug} of the alias ${alias}`));
  if (clashes.length > 0) {
    fail(`${shown(key)} has a live task with the slug of ${clashes.join(', ')}: re-pointing the aliases of ${old} would hide one task of each slug, so nothing was moved. Retire or rename one of each, then run this again.`);
  }
  /** Why the ledger stays under `old`, decided before anything moves; the store's own checks come at the move. */
  const conflict = (place: Place, ledger: { name: string; text: string }): string | undefined => {
    const main = namedMain(ledger.text);
    // As in ledger store migrate --repo-ids, an alias old → key already says where a ledger that names no main belongs.
    const now = main === undefined ? saved : keyNow(main);
    if (now === undefined) return main === undefined ? 'it names no main checkout, so its repo is not known' : `its main checkout ${main} is not one any more`;
    if (!sameRepo(aliases, now, key)) return `its main checkout ${main} is a checkout of ${shown(now)}`;
    const slug = slugOf(ledger);
    return place !== 'archive' && liveSlugs.has(slug) ? `${shown(key)} already has ${slug}` : undefined;
  };
  // A move the read store already refuses, as a taken archive name, must not open the store to write.
  const plan = ledgers.map((ledger) => ({ ...ledger, why: conflict(ledger.place, ledger) ?? moveLedger(store, ledger.place, { old, name: ledger.name, to: key }, true) }));

  print(`Move the tasks of ${shown(old)} to ${shown(key)}${dryRun ? ' · dry run, nothing changed' : ''}`);
  const act = (done: string, planned: string): string => (dryRun ? `would ${planned}` : done);
  let writer: LedgerStore | undefined;
  const target = (): LedgerStore => (dryRun ? store : (writer ??= writable()));
  let [moved, left] = [0, 0];
  for (const { place, name, why: kept } of plan) {
    const why = kept ?? moveLedger(target(), place, { old, name, to: key }, dryRun);
    if (why === undefined) moved++;
    else left++;
    print(why === undefined ? `${act('moved', 'move')} ${place} ${name}` : `left ${place} ${name}: ${why}`);
  }
  try {
    writer?.commit?.();
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    fail(`The store commit failed, so no alias was recorded, and the tasks moved from ${old} to ${key} are on this machine only; other machines still find them under ${old}. ${why}`);
  }
  if (left > 0) {
    const repoints = pointing.length === 0 ? '' : `, and left ${plural(pointing.length, 'alias', 'aliases')} of it as ${pointing.length === 1 ? 'it is' : 'they are'}`;
    print(`kept no alias for ${old}${repoints}: ${plural(left, 'ledger')} ${left === 1 ? 'is' : 'are'} still filed under it. Move or retire ${left === 1 ? 'it' : 'them'}, then run this again.`);
  } else {
    // A repo renamed back has key → old from the first rename; keeping it beside old → key would make a cycle.
    const renamedBack = aliases.get(key) === old;
    const removed: Alias[] = [...pointing.map((alias): Alias => [alias, old]), ...(renamedBack ? [[key, old] as const] : [])];
    const added: Alias[] = [...(saved === undefined ? [[old, key] as const] : []), ...pointing.map((alias): Alias => [alias, key])];
    if (!dryRun && removed.length + added.length > 0) target().aliases.replace(removed, added);
    if (saved === undefined) print(`${act('recorded', 'record')} ${old} as an alias of ${shown(key)}`);
    if (renamedBack) print(`${act('removed', 'remove')} the alias ${key} of ${shown(old)}, as ${key} is the key of this repo again`);
    for (const alias of pointing) print(`${act('re-pointed', 're-point')} the alias ${alias} from ${old} to ${shown(key)}`);
  }
  print(`${dryRun ? 'Would move' : 'Moved'} ${plural(moved, 'ledger')}; ${dryRun ? 'would leave' : 'left'} ${left} as ${left === 1 ? 'it is' : 'they are'}.`);
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
    if (slug !== undefined || remote !== undefined) fail('The store holds no task yet, so nothing was changed.');
    searchRoots(cwd, search);
    print('No problems found.');
    return 0;
  }
  const reading: Context = { paths, cwd, store };
  if (slug !== undefined && to !== undefined) return (pointTo(reading, writable, slug, to, dryRun, print), 0);
  if (slug !== undefined) return (markLost(reading, writable, slug, dryRun, print), 0);
  if (remote !== undefined) return refileRemote(reading, writable, remote, dryRun, print);
  return report(reading, search, print);
}
