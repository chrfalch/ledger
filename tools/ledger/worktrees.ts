import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fail } from './failure.js';
import { exists, folderEntries, isFolder, readTimedText, writeAtomic } from './files.js';
import { parseLedger, planProgress } from './format.js';
import { branchPrs, changedFiles, checkoutRoot, gitDir, ignoredPaths, inMainCheckout, lastCommitDate, mainCheckout, worktrees, type PullRequest, type Worktree } from './git.js';
import { samePath, worktreeLedger, type LedgerPaths } from './paths.js';
import { findTasks, locateChild, namedChildren, type Task } from './tasks.js';
import { heading, plural, table } from './views.js';
import { today, type Context } from './write.js';

const BUILD_FOLDER_NAMES = new Set(['.build', '.expo-prebuild', '.cache', 'build', '.DerivedData']);

/** Never pruned: `.claude` holds agent state, and keeping `node_modules` and `Pods` lets a pruned worktree build without reinstalling. */
const KEPT_FOLDER_NAMES = new Set(['.claude', 'node_modules', 'Pods']);

/** A folder whose size prints as 0.0 is not worth a line. */
const PRUNE_FLOOR_GB = 0.05;

const real = (file: string): string | undefined => {
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
};

/** The name bin/cc-dd-path gives the build folder of the main checkout. */
const MAIN_BUILD_FOLDER = '.main';

/** Where bin/cc-dd-path puts the Xcode build folders of every checkout of the repo at `main`: beside its worktrees, inside none. */
const buildRootOf = (main: string): string => path.join(main, '.claude', 'worktrees', '.build');

/**
 * The symbolic link among the build root `root`, <main>/.claude/worktrees and <main>/.claude, when there is one. A delete
 * in the build root would then land outside the main checkout, so every delete there is refused.
 */
export const linkAboveBuildFolders = (root: string): string | undefined =>
  [root, path.dirname(root), path.dirname(path.dirname(root))].find((folder) => lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink());

/** `keptBecause` says why the folder must not be deleted; `refused` when a symbolic link above it refuses every delete there. */
export type XcodeFolder = { path: string; keptBecause?: string; refused?: boolean };

/**
 * The Xcode build folder bin/cc-dd-path made for the checkout that holds `folder`, when there is one. Its name is the
 * checkout's folder name alone, so it is kept when it may also be another checkout's: when it is .main, or when another
 * linked worktree git lists has the same name in any case, which APFS takes for the same folder.
 */
export function xcodeFolderOf(folder: string): XcodeFolder | undefined {
  const main = mainCheckout(folder);
  const top = checkoutRoot(folder);
  const root = main === undefined ? undefined : real(main);
  if (main === undefined || root === undefined || top === undefined) return undefined;
  const own = path.join(buildRootOf(root), inMainCheckout(folder) ? MAIN_BUILD_FOLDER : path.basename(top));
  if (!isFolder(own)) return undefined;
  const link = linkAboveBuildFolders(path.dirname(own));
  if (link !== undefined) return { path: own, keptBecause: `${link} is a symbolic link`, refused: true };
  const name = path.basename(own).toLowerCase();
  if (name === MAIN_BUILD_FOLDER) return { path: own, keptBecause: 'it is the build folder of the main checkout' };
  const listed = worktrees(main);
  if (listed.length === 0) return { path: own, keptBecause: `git could not list the worktrees of ${main}, so another may share it` };
  const twin = listed.slice(1).find((worktree) => nameOf(worktree).toLowerCase() === name && !samePath(worktree.path, top));
  return twin === undefined ? { path: own } : { path: own, keptBecause: `the worktree ${twin.path} has the same name, so it may be its build folder too` };
}

/** The Xcode build folder bin/cc-dd-path made for the checkout that holds `folder`, when there is one that may be deleted. */
export function ownXcodeFolders(folder: string): string[] {
  const own = xcodeFolderOf(folder);
  return own === undefined || own.keptBecause !== undefined ? [] : [own.path];
}

const TRASH_PREFIX = '.cc-trash-';

/**
 * Moves the folders into one new trash folder in `trashParent`, which is instant on one disk, then deletes the trash in a
 * process of its own with no inherited output, so nothing waits for the delete. A folder that cannot be moved is deleted
 * at once. prune-orphans never takes a trash folder for a build folder.
 */
export function deleteInBackground(folders: string[], trashParent: string): void {
  const trash = trashCan();
  for (const folder of folders) trash.move(folder, trashParent);
  trash.empty();
}

/**
 * Moves folders into trash folders in their trash parent, then deletes every trash folder with one background rm. A
 * folder that cannot be moved is deleted at once. Two build folders can share a name, so the second gets another trash folder.
 */
function trashCan(): { move: (folder: string, trashParent: string) => void; empty: () => void } {
  const trashes: string[] = [];
  return {
    move(folder, trashParent) {
      const name = path.basename(folder);
      try {
        let trash = trashes.find((known) => path.dirname(known) === trashParent && !existsSync(path.join(known, name)));
        if (trash === undefined) {
          trash = mkdtempSync(path.join(trashParent, TRASH_PREFIX));
          trashes.push(trash);
        }
        renameSync(folder, path.join(trash, name));
      } catch {
        rmSync(folder, { recursive: true, force: true });
      }
    },
    empty() {
      const folders = trashes.splice(0);
      if (folders.length === 0) return;
      spawn('rm', ['-rf', '--', ...folders], { detached: true, stdio: 'ignore' })
        .on('error', (error) => console.error(`warning: rm could not start, so ${folders.join(', ')} ${folders.length === 1 ? 'is' : 'are'} left behind (${error.message}). Delete by hand.`))
        .unref();
    },
  };
}

/** du counts blocks in use; it exits non-zero when it cannot read some file, yet still prints the total of what it could. */
function sizeGb(folder: string): number | undefined {
  const kib = /^\d+/.exec(spawnSync('du', ['-sk', folder], { encoding: 'utf8' }).stdout ?? '')?.[0];
  return kib === undefined ? undefined : (Number(kib) * 1024) / 1e9;
}

const gbText = (gb: number | undefined): string => (gb === undefined ? '?' : gb.toFixed(1));

type Folder = { path: string; label: string; sizeGb?: number };

const totalGb = (folders: Folder[]): string => gbText(folders.reduce((sum, { sizeGb: size }) => sum + (size ?? 0), 0));

const folderTable = (folders: Folder[]): string[] =>
  table(
    ['folder', 'size GB'],
    [...folders].sort((a, b) => (b.sizeGb ?? -1) - (a.sizeGb ?? -1)).map(({ label, sizeGb: size }) => [label, gbText(size)]),
  );

const sized = (folder: string, label: string): Folder => {
  const size = sizeGb(folder);
  return { path: folder, label, ...(size === undefined ? {} : { sizeGb: size }) };
};

type Repo = { main: string; linked: Worktree[] };

/** The repo that holds the working folder, with its linked worktrees that are still on disk. */
function repoOf(cwd: string): Repo {
  const main = mainCheckout(cwd) ?? fail(`${cwd} is not inside a git repository.`);
  return { main, linked: worktrees(main).slice(1).filter(({ path: folder }) => existsSync(folder)) };
}

const nameOf = ({ path: folder }: Worktree): string => path.basename(folder);

/** A worktree's ledger: `activeChildren` when it lists children, counting those not retired; `parent` as its Location names it. */
export type WorktreeLedger = { slug: string; path: string; activeChildren?: number; parent?: string };

/** A value git or du could not read is left out; `pr` is null for no PR and left out when gh could not tell. */
export type WorktreeRow = { name: string; path: string; branch?: string; sizeGb?: number; lastCommit?: string; dirty?: number; ledger: WorktreeLedger | null; pr?: PullRequest | null };

/** The rows are largest first; `prError` says why gh could not tell the PRs. */
export type WorktreesList = { main: string; worktrees: WorktreeRow[]; totalGb: number; prError?: string };

function worktreeLedgerOf(task: Task, tasks: Task[], main: string): WorktreeLedger {
  const children = namedChildren(task, tasks);
  const parent = task.ledger.location.parent;
  const self = { slug: task.slug, main };
  return {
    slug: task.slug,
    path: task.file,
    ...(children.length === 0 ? {} : { activeChildren: children.filter((line) => locateChild(tasks, { slug: line.slug, main: line.main ?? main }, self)?.status !== 'retired').length }),
    ...(parent === undefined ? {} : { parent: parent.slug }),
  };
}

function ledgerCell(ledger: WorktreeLedger | null): string {
  if (ledger === null) return 'no';
  if (ledger.activeChildren !== undefined) return `parent of ${ledger.activeChildren}`;
  return ledger.parent === undefined ? 'yes' : `child of ${ledger.parent}`;
}

/** `ledger worktrees`: each linked worktree with its size, last commit, uncommitted files, ledger and PR, largest first. */
export function listWorktrees({ store, cwd }: Context): WorktreesList {
  const { main, linked } = repoOf(cwd);
  const tasks = linked.length === 0 ? [] : findTasks(store, [main]);
  let prError: string | undefined;
  const rows = linked.map((worktree): WorktreeRow => {
    const prs = worktree.branch === undefined ? [] : branchPrs(worktree.path, worktree.branch);
    if ('error' in prs) prError ??= prs.error;
    const task = tasks.find(({ place, file }) => place === 'worktree' && samePath(file, worktreeLedger(worktree.path)));
    const size = sizeGb(worktree.path);
    const lastCommit = lastCommitDate(worktree.path);
    const dirty = changedFiles(worktree.path)?.length;
    return {
      name: nameOf(worktree),
      path: worktree.path,
      ...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
      ...(size === undefined ? {} : { sizeGb: size }),
      ...(lastCommit === undefined ? {} : { lastCommit }),
      ...(dirty === undefined ? {} : { dirty }),
      ledger: task === undefined ? null : worktreeLedgerOf(task, tasks, main),
      ...('error' in prs ? {} : { pr: prs[0] ?? null }),
    };
  });
  rows.sort((a, b) => (b.sizeGb ?? -1) - (a.sizeGb ?? -1));
  const totalGb = rows.reduce((sum, { sizeGb: size }) => sum + (size ?? 0), 0);
  return { main, worktrees: rows, totalGb, ...(prError === undefined ? {} : { prError }) };
}

export function worktreesView({ worktrees: rows, totalGb, prError }: WorktreesList): string {
  if (rows.length === 0) return 'No linked worktrees.';
  const count = rows.length === 1 ? '1 worktree' : `${rows.length} worktrees, largest first`;
  const prCell = (pr: PullRequest | null | undefined): string => (pr === undefined ? '?' : pr === null ? 'none' : `${pr.state} #${pr.number}`);
  const cells = rows.map((row) => [row.name, gbText(row.sizeGb), row.lastCommit ?? '?', String(row.dirty ?? '?'), ledgerCell(row.ledger), prCell(row.pr)]);
  return [
    heading('Worktrees', count, `${totalGb.toFixed(1)} GB total`),
    '',
    ...table(['worktree', 'size GB', 'last commit', 'dirty', 'ledger', 'PR'], cells),
    ...(prError === undefined ? [] : ['', `PR is ? because ${prError}`]),
  ].join('\n');
}

/** The path segments of `file` below `base`; undefined unless it is strictly inside. */
export function below(base: string, file: string): string[] | undefined {
  const inside = path.relative(base, file);
  const segments = inside.split(path.sep);
  return inside === '' || path.isAbsolute(inside) || segments.includes('..') ? undefined : segments;
}

/** Why `folder` must not be deleted from `base`, judged on where it really lands rather than how it is spelled; undefined when it may. */
function deletionProblem(folder: string, base: string, isAllowed: (inside: string[]) => boolean): string | undefined {
  const spelled = below(base, folder);
  if (folder !== path.resolve(folder) || spelled === undefined || !isAllowed(spelled)) return 'it is not a build folder of this worktree.';
  if (lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink()) return 'it is a symbolic link.';
  const [own, allowed] = [real(folder), real(base)];
  if (own === undefined) return 'its real path could not be resolved.';
  if (allowed === undefined) return `the real path of ${base} could not be resolved.`;
  const inside = below(allowed, own);
  return inside !== undefined && isAllowed(inside) ? undefined : `it resolves to ${own}, outside the folders it may be deleted from.`;
}

const outsideKept = (segments: string[]): boolean => segments.every((segment) => !KEPT_FOLDER_NAMES.has(segment));

/** `skipped` are the folders a safety rule kept; `failures` the folders that could not be deleted. */
type Deleted = { deleted: Folder[]; skipped: string[]; failures: string[] };

type Pruned = { planned: Folder[] } | Deleted | { error: string };

const hasFailed = (pruned: Pruned): boolean => 'error' in pruned || ('failures' in pruned && pruned.failures.length > 0);

/** What a prune prints, and whether a folder could not be deleted, which makes the command exit 1. */
export type PruneReport = { text: string; failed: boolean };

const report = (text: string | string[], failed = false): PruneReport => ({ text: Array.isArray(text) ? text.join('\n') : text, failed });

const removeNow = (folder: string): void => rmSync(folder, { recursive: true, force: true });

/** `problemOf` gives why a folder is skipped, or a `stop` failure that leaves it and every folder after it. */
function deleteFolders(folders: Folder[], problemOf: (folder: Folder) => string | { stop: string } | undefined, remove = removeNow): Deleted {
  const deleted: Folder[] = [];
  const skipped: string[] = [];
  const failures: string[] = [];
  for (const folder of folders) {
    const problem = problemOf(folder);
    if (typeof problem === 'object') {
      failures.push(problem.stop);
      break;
    }
    if (problem !== undefined) {
      skipped.push(`Skipped ${folder.path}: ${problem}`);
      continue;
    }
    try {
      remove(folder.path);
      deleted.push(folder);
    } catch (error) {
      failures.push(`Could not delete ${folder.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { deleted, skipped, failures };
}

/** The git-ignored build folders of the linked worktree, and its folder in `.claude/worktrees/.build`, at `root` of at least 0.05 GB; deleted unless `dryRun`. */
function pruneBuildFolders(paths: LedgerPaths, root: string, dryRun: boolean, remove = removeNow): Pruned {
  const ignored = ignoredPaths(root);
  if (ignored === undefined) return { error: `Could not read the ignored files of ${path.basename(root)}: git status failed.` };
  const inWorktree = ignored
    .filter((entry) => entry.endsWith('/'))
    .map((entry) => entry.slice(0, -1).split('/'))
    .filter((segments) => BUILD_FOLDER_NAMES.has(segments.at(-1) ?? '') && outsideKept(segments))
    .map((segments) => sized(path.join(root, ...segments), segments.join('/')));
  const xcode = xcodeFolderOf(root);
  const own = xcode?.keptBecause === undefined ? xcode?.path : undefined;
  const folders = [...inWorktree, ...(own === undefined ? [] : [sized(own, paths.tilde(own))])].filter(({ sizeGb: size }) => size === undefined || size >= PRUNE_FLOOR_GB);
  const kept = xcode?.keptBecause === undefined ? undefined : `Skipped ${xcode.path}: ${xcode.keptBecause}.`;
  if (dryRun || (folders.length === 0 && kept === undefined)) return { planned: folders };
  const pruned = deleteFolders(
    folders,
    ({ path: folder }) => {
      if (folder.startsWith(`${root}${path.sep}`) || own === undefined) return deletionProblem(folder, root, outsideKept);
      const link = linkAboveBuildFolders(path.dirname(own));
      if (link !== undefined) return { stop: `Skipped ${own}: ${link} is a symbolic link.` };
      return deletionProblem(folder, path.dirname(own), (inside) => inside.length === 1 && inside[0] === path.basename(own));
    },
    remove,
  );
  if (kept !== undefined) (xcode?.refused ? pruned.failures : pruned.skipped).push(kept);
  return pruned;
}

const KEPT_NOTES = ["Folders inside the worktree's .claude folder are never deleted.", 'node_modules and Pods folders are kept, so the worktree still builds.'];

const folderCount = (folders: Folder[]): string => plural(folders.length, 'folder');

const freed = (deleted: Folder[]): string => `${totalGb(deleted)} GB freed in ${folderCount(deleted)}`;

function prunedLines(title: string, pruned: Pruned): string[] {
  if ('error' in pruned) return [heading(title, 'not pruned'), '', pruned.error];
  if ('planned' in pruned) return pruned.planned.length === 0 ? [heading(title, 'nothing to prune')] : [heading(title, `${totalGb(pruned.planned)} GB in ${folderCount(pruned.planned)}`), '', ...folderTable(pruned.planned)];
  return [heading(title, freed(pruned.deleted)), ...(pruned.deleted.length > 0 ? ['', ...folderTable(pruned.deleted)] : []), ...(pruned.skipped.length + pruned.failures.length > 0 ? ['', ...pruned.skipped, ...pruned.failures] : [])];
}

export type PruneOptions = { all: boolean; dryRun: boolean };

type WorktreePruned = { name: string; path: string; pruned: Pruned };

/** A prune of one linked worktree, or of each with `all`. */
export type PruneRun = PruneOptions & { worktrees: WorktreePruned[] };

/** `ledger worktrees prune <name>|--all [--dry-run]`. A single worktree whose ignored files git cannot read fails. */
export function pruneWorktrees({ paths, cwd }: Context, name: string | undefined, { all, dryRun }: PruneOptions): PruneRun {
  if ((name === undefined) === !all) fail('Give either a worktree name or --all: ledger worktrees prune <name>|--all [--dry-run]');
  const { linked } = repoOf(cwd);
  const matches = all ? linked : linked.filter((worktree) => nameOf(worktree) === name);
  if (!all && matches.length === 0) fail(`No linked worktree named "${name}". Worktrees: ${linked.map(nameOf).join(', ') || 'none'}`);
  if (!all && matches.length > 1) fail(`Two or more linked worktrees are named "${name}": ${matches.map(({ path: folder }) => folder).join(', ')}`);
  const worktrees = matches.map((worktree) => ({ name: nameOf(worktree), path: worktree.path, pruned: pruneBuildFolders(paths, worktree.path, dryRun) }));
  const [single] = worktrees;
  if (!all && 'error' in single.pruned) fail(single.pruned.error);
  return { all, dryRun, worktrees };
}

/** A prune as plain fields: `folders` are those planned on a dry run, else those deleted. */
export type PrunedFields = { name: string; path: string; folders: Folder[]; skipped: string[]; failures: string[]; error?: string };

export function prunedFields({ name, path: folder, pruned }: WorktreePruned): PrunedFields {
  if ('error' in pruned) return { name, path: folder, folders: [], skipped: [], failures: [], error: pruned.error };
  if ('planned' in pruned) return { name, path: folder, folders: pruned.planned, skipped: [], failures: [] };
  return { name, path: folder, folders: pruned.deleted, skipped: pruned.skipped, failures: pruned.failures };
}

export function pruneReport({ all, dryRun, worktrees: results }: PruneRun): PruneReport {
  if (all) {
    if (results.length === 0) return report('No linked worktrees.');
    if (results.every(({ pruned }) => 'planned' in pruned && pruned.planned.length === 0)) return report('Nothing to prune in any linked worktree.');
    const planned = results.flatMap(({ pruned }) => ('planned' in pruned ? pruned.planned : []));
    const deleted = results.flatMap(({ pruned }) => ('deleted' in pruned ? pruned.deleted : []));
    const lines = [
      dryRun ? heading('Prune every linked worktree', 'dry run', `${totalGb(planned)} GB in ${folderCount(planned)}`) : heading('Pruned every linked worktree', freed(deleted)),
      ...results.flatMap((result) => ['', ...prunedLines(result.name, result.pruned)]),
      ...(dryRun && planned.length > 0 ? ['', ...KEPT_NOTES, 'Run ledger worktrees prune --all to delete them.'] : []),
    ];
    return report(lines, results.some(({ pruned }) => hasFailed(pruned)));
  }
  const [{ name, pruned }] = results;
  if ('error' in pruned) return report(pruned.error, true);
  if ('planned' in pruned) {
    if (pruned.planned.length === 0) return report(`Nothing to prune in ${name}.`);
    return report([heading(`Prune ${name}`, 'dry run', `${totalGb(pruned.planned)} GB in ${folderCount(pruned.planned)}`), '', ...folderTable(pruned.planned), '', ...KEPT_NOTES, `Run ledger worktrees prune ${name} to delete them.`]);
  }
  return report(prunedLines(`Pruned ${name}`, pruned), hasFailed(pruned));
}

/** In a worktree's .claude folder: its finished task was pruned, or the prune failed, so nothing is tried again until the task is reopened. */
export const PRUNED_MARKER = 'build-folders-pruned';

/**
 * What auto-prune did: `unchanged` when the marker already matches the task, `unmarked` when a reopened task lost its
 * marker, `pruned` or `failed` for a finished task, `not-linked` for a ledger outside a linked worktree. `message` is the
 * line to show, when there is one; `folders` were deleted, `failures` could not be.
 */
export type AutoPruneResult = {
  ledger: string;
  worktree: string;
  marker: string;
  finished: boolean;
  outcome: 'unchanged' | 'unmarked' | 'pruned' | 'failed' | 'not-linked';
  folders?: Folder[];
  failures?: string[];
  error?: string;
  message?: string;
};

const isLinkedWorktree = (folder: string): boolean => {
  const main = mainCheckout(folder);
  return main !== undefined && worktrees(main).slice(1).some(({ path: linked }) => samePath(linked, folder));
};

/**
 * Where a folder's trash goes so a turn's end does not wait for the delete: the worktree's git dir, which is outside its
 * tree, so the trash never shows in its status. On another disk a move would be a copy, so the trash then goes beside it.
 */
function trashParent(folder: string, worktreeGitDir: string | undefined): string {
  try {
    if (worktreeGitDir !== undefined && statSync(folder).dev === statSync(worktreeGitDir).dev) return worktreeGitDir;
  } catch {}
  return path.dirname(folder);
}

/**
 * Prunes the build folders of the linked worktree of `ledger` once each time its plan is finished, and marks it with
 * PRUNED_MARKER; reopening the task drops the mark. A failed prune is marked too, so it is reported once.
 */
export function autoPrune({ paths }: Context, ledger: string): AutoPruneResult {
  const text = readTimedText(ledger, { followLinks: true })?.text ?? fail(`No ledger to read at ${ledger}.`);
  const { finished } = planProgress(parseLedger(text));
  const worktree = path.dirname(path.dirname(ledger));
  const name = path.basename(worktree);
  const marker = path.join(worktree, '.claude', PRUNED_MARKER);
  const facts = { ledger, worktree, marker, finished };
  if (finished === exists(marker)) return { ...facts, outcome: 'unchanged' };
  if (!finished) {
    rmSync(marker, { force: true });
    return { ...facts, outcome: 'unmarked' };
  }
  if (!isLinkedWorktree(worktree)) return { ...facts, outcome: 'not-linked' };
  let pruned: Pruned;
  const trash = trashCan();
  try {
    const own = gitDir(worktree);
    pruned = pruneBuildFolders(paths, worktree, false, (folder) => trash.move(folder, trashParent(folder, own)));
  } catch (error) {
    pruned = { error: error instanceof Error ? error.message : String(error) };
  } finally {
    trash.empty();
  }
  const date = today();
  const result: AutoPruneResult =
    'error' in pruned
      ? { ...facts, outcome: 'failed', error: pruned.error, message: `Did not prune ${name}. ${pruned.error}` }
      : { ...facts, outcome: 'pruned', ...prunedOf(pruned, name) };
  const note =
    result.outcome === 'failed'
      ? `ledger worktrees auto-prune could not prune the build folders of this worktree on ${date}, when its task was finished:\n${result.error}\nWhile this file exists, it does not try again. Run \`ledger worktrees prune ${name}\` to prune by hand.\n`
      : `ledger worktrees auto-prune pruned the build folders of this worktree on ${date}, because its task was finished. While this file exists, it does not prune them again.\n`;
  try {
    writeAtomic(marker, note);
  } catch (error) {
    result.message = `${result.message} Could not write ${marker}: ${error instanceof Error ? error.message : String(error)}. The next run tries ${name} again.`;
  }
  return result;
}

function prunedOf(pruned: Exclude<Pruned, { error: string }>, name: string): Pick<AutoPruneResult, 'folders' | 'failures' | 'message'> {
  if ('planned' in pruned) return { folders: [], failures: [], message: `The task is finished, and ${name} has no build folders to prune.` };
  const line = `Pruned the build folders of ${name}, because its task is finished: ${freed(pruned.deleted)}.`;
  const failures = [...pruned.skipped, ...pruned.failures];
  const left = failures.length;
  return {
    folders: pruned.deleted,
    failures,
    message: left === 0 ? line : `${line} ${left === 1 ? '1 folder was' : `${left} folders were`} not deleted; run \`ledger worktrees prune ${name}\` to see why.`,
  };
}

const ORPHAN_NOTE = 'An orphan is the build folder of a worktree that git no longer lists.';

/** `ledger worktrees prune-orphans [--dry-run]`: deletes the Xcode build folders that no checkout of the repo is named for. */
export function pruneOrphans({ paths, cwd }: Context, dryRun: boolean): PruneReport {
  const { main } = repoOf(cwd);
  const root = buildRootOf(real(main) ?? main);
  // Every worktree git lists counts, also one whose folder is gone for now. Lower case, because
  // APFS matches names regardless of case. Undefined when git lists nothing, not even the main
  // checkout: a failed list must not make every build folder an orphan.
  const linkedNames = (): Set<string> | undefined => {
    const listed = worktrees(main);
    return listed.length === 0 ? undefined : new Set(listed.slice(1).map((worktree) => nameOf(worktree).toLowerCase()));
  };
  const isOrphan = (name: string, linked: Set<string>): boolean => name !== MAIN_BUILD_FOLDER && !name.startsWith(TRASH_PREFIX) && !linked.has(name.toLowerCase());
  const link = linkAboveBuildFolders(root);
  if (link !== undefined) return report(`${paths.tilde(link)} is a symbolic link, so nothing was pruned.`, true);
  const linked = linkedNames();
  if (linked === undefined) return report(`Could not list the worktrees of ${paths.tilde(main)}, so nothing was pruned.`, true);
  const orphans = folderEntries(root)
    .map(({ name }) => name)
    .filter((name) => isFolder(path.join(root, name)) && isOrphan(name, linked))
    .map((name) => sized(path.join(root, name), name));
  const title = `orphans in ${paths.tilde(root)}`;
  if (orphans.length === 0) return report(`Nothing to prune: no ${title}.`);
  if (dryRun) return report([heading(`Prune ${title}`, 'dry run', `${totalGb(orphans)} GB in ${folderCount(orphans)}`), '', ...folderTable(orphans), '', ORPHAN_NOTE, 'Run ledger worktrees prune-orphans to delete them.']);
  const pruned = deleteFolders(orphans, ({ path: folder }) => {
    const linkNow = linkAboveBuildFolders(root);
    if (linkNow !== undefined) return { stop: `${paths.tilde(linkNow)} is a symbolic link, so ${folder} and the folders after it were not pruned.` };
    const linkedNow = linkedNames();
    if (linkedNow === undefined) return { stop: `Could not list the worktrees of ${paths.tilde(main)} again, so ${folder} and the folders after it were not pruned.` };
    return deletionProblem(folder, root, (inside) => inside.length === 1) ?? (isOrphan(path.basename(folder), linkedNow) ? undefined : 'it is no longer an orphan.');
  });
  return report(prunedLines(`Pruned ${title}`, pruned), hasFailed(pruned));
}
