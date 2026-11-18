import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fail } from './failure.js';
import { exists, folderEntries, isFolder, readTimedText, writeAtomic } from './files.js';
import { parseLedger, planProgress } from './format.js';
import { branchPrs, changedFiles, checkoutRoot, gitDir, ignoredPaths, lastCommitDate, mainCheckout, worktrees, type PullRequest, type Worktree } from './git.js';
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

/**
 * The path prefix bin/cc-dd-path gives the Xcode build folders of the checkout that holds `folder`:
 * <DerivedData>/cc-<folder name>-<first 6 hex of the sha1 of its real path>-. Undefined outside a git checkout.
 */
export function buildFolderPrefix(paths: LedgerPaths, folder: string): string | undefined {
  const top = checkoutRoot(folder);
  const root = top === undefined ? undefined : real(top);
  if (root === undefined) return undefined;
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 6);
  return path.join(paths.derivedData, `cc-${path.basename(root)}-${hash}-`);
}

/** The rest after the prefix has no `<hex6>-` of its own, which would make it the folder of a worktree whose name starts with `<name>-<hex6>`. */
const isOwnXcodeFolder = (name: string, prefix: string): boolean => name.startsWith(prefix) && !/(^|-)[0-9a-f]{6}-/.test(name.slice(prefix.length));

/** The Xcode build folders bin/cc-dd-path made for the checkout that holds `folder`. */
export function ownXcodeFolders(paths: LedgerPaths, folder: string): string[] {
  const prefix = buildFolderPrefix(paths, folder);
  if (prefix === undefined) return [];
  return folderEntries(paths.derivedData)
    .map(({ name }) => name)
    .filter((name) => isOwnXcodeFolder(name, path.basename(prefix)) && isFolder(path.join(paths.derivedData, name)))
    .map((name) => path.join(paths.derivedData, name));
}

/**
 * Moves the folders into one new trash folder in `trashParent`, which is instant on one disk, then deletes the trash in a
 * process of its own with no inherited output, so nothing waits for the delete. A folder that cannot be moved is deleted
 * at once. The trash name starts with a dot, so it never matches a build folder prefix.
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
          trash = mkdtempSync(path.join(trashParent, '.cc-trash-'));
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
type Pruned = { planned: Folder[] } | { deleted: Folder[]; skipped: string[]; failures: string[] } | { error: string };

const hasFailed = (pruned: Pruned): boolean => 'error' in pruned || ('failures' in pruned && pruned.failures.length > 0);

/** What a prune prints, and whether a folder could not be deleted, which makes the command exit 1. */
export type PruneReport = { text: string; failed: boolean };

const report = (text: string | string[], failed = false): PruneReport => ({ text: Array.isArray(text) ? text.join('\n') : text, failed });

const removeNow = (folder: string): void => rmSync(folder, { recursive: true, force: true });

function deleteFolders(folders: Folder[], problemOf: (folder: Folder) => string | undefined, remove = removeNow): Pruned {
  const deleted: Folder[] = [];
  const skipped: string[] = [];
  const failures: string[] = [];
  for (const folder of folders) {
    const problem = problemOf(folder);
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

/** The git-ignored build folders and own Xcode folders of the linked worktree at `root` of at least 0.05 GB; deleted unless `dryRun`. */
function pruneBuildFolders(paths: LedgerPaths, root: string, dryRun: boolean, remove = removeNow): Pruned {
  const ignored = ignoredPaths(root);
  if (ignored === undefined) return { error: `Could not read the ignored files of ${path.basename(root)}: git status failed.` };
  const inWorktree = ignored
    .filter((entry) => entry.endsWith('/'))
    .map((entry) => entry.slice(0, -1).split('/'))
    .filter((segments) => BUILD_FOLDER_NAMES.has(segments.at(-1) ?? '') && outsideKept(segments))
    .map((segments) => sized(path.join(root, ...segments), segments.join('/')));
  const xcode = ownXcodeFolders(paths, root).map((folder) => sized(folder, `${paths.tilde(paths.derivedData)}/${path.basename(folder)}`));
  const prefix = path.basename(buildFolderPrefix(paths, root) ?? '');
  const folders = [...inWorktree, ...xcode].filter(({ sizeGb: size }) => size === undefined || size >= PRUNE_FLOOR_GB);
  if (dryRun || folders.length === 0) return { planned: folders };
  return deleteFolders(
    folders,
    ({ path: folder }) =>
      folder.startsWith(`${root}${path.sep}`)
        ? deletionProblem(folder, root, outsideKept)
        : deletionProblem(folder, paths.derivedData, (inside) => inside.length === 1 && prefix !== '' && isOwnXcodeFolder(inside[0], prefix)),
    remove,
  );
}

const KEPT_NOTES = ['Folders inside a .claude folder are never deleted.', 'node_modules and Pods folders are kept, so the worktree still builds.'];

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
      ? `ledger auto-prune could not prune the build folders of this worktree on ${date}, when its task was finished:\n${result.error}\nWhile this file exists, it does not try again. Run \`ledger worktrees prune ${name}\` to prune by hand.\n`
      : `ledger auto-prune pruned the build folders of this worktree on ${date}, because its task was finished. While this file exists, it does not prune them again.\n`;
  try {
    writeAtomic(marker, note);
  } catch (error) {
    result.message = `${result.message} Could not write ${marker}: ${error instanceof Error ? error.message : String(error)}. The next run tries ${name} again.`;
  }
  return result;
}

function prunedOf(pruned: Exclude<Pruned, { error: string }>, name: string): Pick<AutoPruneResult, 'folders' | 'failures' | 'message'> {
  if ('planned' in pruned) return { folders: [], failures: [], message: `The task is finished, and ${name} has no build folders to prune.` };
  const left = pruned.failures.length;
  const line = `Pruned the build folders of ${name}, because its task is finished: ${freed(pruned.deleted)}.`;
  const failures = [...pruned.skipped, ...pruned.failures];
  return {
    folders: pruned.deleted,
    failures,
    message: left === 0 ? line : `${line} ${left === 1 ? '1 folder was' : `${left} folders were`} not deleted; run \`ledger worktrees prune ${name}\` to see why.`,
  };
}

type Group = { kind: 'main' } | { kind: 'worktree'; name: string } | { kind: 'other' } | { kind: 'disk-not-connected' } | { kind: 'orphan' } | { kind: 'no-source' } | { kind: 'cache' };

const GROUP_ORDER: Group['kind'][] = ['main', 'worktree', 'other', 'disk-not-connected', 'orphan', 'no-source', 'cache'];

const GROUP_LABELS = {
  main: 'Main checkout',
  other: 'Other location',
  'disk-not-connected': 'Disk not connected',
  orphan: 'Orphan',
  'no-source': 'No source recorded',
  cache: 'Shared caches',
} as const;

const groupLabel = (group: Group): string => (group.kind === 'worktree' ? `Linked worktree ${group.name}` : GROUP_LABELS[group.kind]);

/** The WorkspacePath of a DerivedData folder's info.plist, with . and .. resolved; plutil reads the binary and the XML form alike. */
function workspacePath(folder: string): string | undefined {
  const plutil = spawnSync('plutil', ['-extract', 'WorkspacePath', 'raw', '-o', '-', path.join(folder, 'info.plist')], { encoding: 'utf8' });
  const value = plutil.status === 0 ? (plutil.stdout ?? '').replace(/\n$/, '') : '';
  return value.startsWith('/') ? path.resolve(value) : undefined;
}

/**
 * A disk is mounted at /Volumes/<name> on another device than /Volumes; an unmount can leave an empty folder behind on the
 * /Volumes device itself. The boot disk is the exception: macOS links it there to /.
 */
function isDiskConnected(file: string): boolean {
  const volume = /^\/Volumes\/[^/]+(?=\/.)/.exec(file)?.[0];
  if (volume === undefined) return true;
  try {
    return real(volume) === '/' || statSync(volume).dev !== statSync('/Volumes').dev;
  } catch {
    return false;
  }
}

/** Whether nothing is at `file`; any error but "no such entry" leaves that unknown, so the folder built from it is not an orphan. */
function isGone(file: string, folder: string): boolean {
  try {
    statSync(file);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return true;
    console.error(`warning: could not check ${file} (${code ?? String(error)}), so ${path.basename(folder)} is not counted as an orphan.`);
    return false;
  }
}

/** By the folder's WorkspacePath, never its name; the linked worktree with the longest matching path wins, as worktrees can sit inside each other. */
function groupOf(folder: string, { main, linked }: Repo): Group {
  const name = path.basename(folder);
  if (name.endsWith('.noindex') || name === 'SDKExplicitPrecompiledModules') return { kind: 'cache' };
  const workspace = workspacePath(folder);
  if (workspace === undefined) return { kind: 'no-source' };
  if (isGone(workspace, folder)) return isDiskConnected(workspace) ? { kind: 'orphan' } : { kind: 'disk-not-connected' };
  const [worktree] = linked.filter(({ path: root }) => workspace.startsWith(`${root}/`)).sort((a, b) => b.path.length - a.path.length);
  if (worktree !== undefined) return { kind: 'worktree', name: nameOf(worktree) };
  return workspace.startsWith(`${main}/`) ? { kind: 'main' } : { kind: 'other' };
}

type Grouped = Folder & { group: Group };

function derivedDataFolders(paths: LedgerPaths, repo: Repo): Grouped[] {
  return folderEntries(paths.derivedData)
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => {
      const folder = path.join(paths.derivedData, name);
      return { ...sized(folder, name), group: groupOf(folder, repo) };
    });
}

const ORPHAN_NOTE = 'An orphan was built from a project that no longer exists on disk.';

/** `ledger worktrees derived-data`: every DerivedData folder, grouped by the project it was built from. */
export function derivedDataView({ paths, cwd }: Context): string {
  const folders = derivedDataFolders(paths, repoOf(cwd));
  const label = paths.tilde(paths.derivedData);
  if (folders.length === 0) return `No folders in ${label}.`;
  const groups = new Map<string, Grouped[]>();
  const order = (folder: Grouped): number => GROUP_ORDER.indexOf(folder.group.kind);
  for (const folder of [...folders].sort((a, b) => order(a) - order(b) || groupLabel(a.group).localeCompare(groupLabel(b.group)))) {
    const key = groupLabel(folder.group);
    groups.set(key, [...(groups.get(key) ?? []), folder]);
  }
  const hasOrphans = folders.some(({ group }) => group.kind === 'orphan');
  return [
    heading(label, `${totalGb(folders)} GB in ${folderCount(folders)}`),
    ...[...groups].flatMap(([title, members]) => [
      '',
      heading(title, `${totalGb(members)} GB in ${folderCount(members)}`),
      ...folderTable(members),
      ...(members[0].group.kind === 'disk-not-connected' ? ['A folder here was built from a project on a disk that is not connected, so it is never deleted.'] : []),
    ]),
    ...(hasOrphans ? ['', ORPHAN_NOTE, 'Run ledger worktrees prune-orphans to delete the orphans.'] : []),
  ].join('\n');
}

/** `ledger worktrees prune-orphans [--dry-run]`: deletes the DerivedData folders whose project is gone from a connected disk. */
export function pruneOrphans({ paths, cwd }: Context, dryRun: boolean): PruneReport {
  const repo = repoOf(cwd);
  const orphans = derivedDataFolders(paths, repo).filter(({ group }) => group.kind === 'orphan');
  const title = `orphans in ${paths.tilde(paths.derivedData)}`;
  if (orphans.length === 0) return report(`Nothing to prune: no ${title}.`);
  if (dryRun) return report([heading(`Prune ${title}`, 'dry run', `${totalGb(orphans)} GB in ${folderCount(orphans)}`), '', ...folderTable(orphans), '', ORPHAN_NOTE, 'Run ledger worktrees prune-orphans to delete them.']);
  const pruned = deleteFolders(orphans, ({ path: folder }) => {
    const problem = deletionProblem(folder, paths.derivedData, (inside) => inside.length === 1);
    return problem ?? (groupOf(folder, repo).kind === 'orphan' ? undefined : 'it is no longer an orphan.');
  });
  return report(prunedLines(`Pruned ${title}`, pruned), hasFailed(pruned));
}
