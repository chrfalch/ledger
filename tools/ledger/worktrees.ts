import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fail } from './failure.js';
import { folderEntries, isFolder } from './files.js';
import { branchPrs, changedFiles, checkoutRoot, ignoredPaths, lastCommitDate, mainCheckout, worktrees, type Worktree } from './git.js';
import { samePath, worktreeLedger, type LedgerPaths } from './paths.js';
import { findTasks, locateChild, namedChildren, type Task } from './tasks.js';
import { heading, plural, table } from './views.js';
import type { Context } from './write.js';

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
  let trash: string | undefined;
  for (const folder of folders) {
    try {
      trash ??= mkdtempSync(path.join(trashParent, '.cc-trash-'));
      renameSync(folder, path.join(trash, path.basename(folder)));
    } catch {
      rmSync(folder, { recursive: true, force: true });
    }
  }
  if (trash === undefined) return;
  const folder = trash;
  spawn('rm', ['-rf', '--', folder], { detached: true, stdio: 'ignore' })
    .on('error', (error) => console.error(`warning: rm could not start, so ${folder} is left behind (${error.message}). Delete it by hand.`))
    .unref();
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

function ledgerCell(task: Task | undefined, tasks: Task[], main: string): string {
  if (task === undefined) return 'no';
  const children = namedChildren(task, tasks);
  if (children.length > 0) {
    const parent = { slug: task.slug, main };
    const active = children.filter((line) => locateChild(tasks, { slug: line.slug, main: line.main ?? main }, parent)?.status !== 'retired');
    return `parent of ${active.length}`;
  }
  const parent = task.ledger.location.parent;
  return parent === undefined ? 'yes' : `child of ${parent.slug}`;
}

/** `ledger worktrees`: each linked worktree with its size, last commit, uncommitted files, ledger and PR, largest first. */
export function worktreesTable({ store, cwd }: Context): string {
  const { main, linked } = repoOf(cwd);
  if (linked.length === 0) return 'No linked worktrees.';
  const tasks = findTasks(store, [main]);
  let prError: string | undefined;
  const rows = linked.map((worktree) => {
    const prs = worktree.branch === undefined ? [] : branchPrs(worktree.path, worktree.branch);
    if ('error' in prs) prError ??= prs.error;
    const pr = 'error' in prs ? '?' : prs[0] === undefined ? 'none' : `${prs[0].state} #${prs[0].number}`;
    const task = tasks.find(({ place, file }) => place === 'worktree' && samePath(file, worktreeLedger(worktree.path)));
    const size = sizeGb(worktree.path);
    const cells = [nameOf(worktree), gbText(size), lastCommitDate(worktree.path) ?? '?', String(changedFiles(worktree.path)?.length ?? '?'), ledgerCell(task, tasks, main), pr];
    return { cells, size: size ?? -1 };
  });
  rows.sort((a, b) => b.size - a.size);
  const total = rows.reduce((sum, { size }) => sum + Math.max(size, 0), 0);
  const count = linked.length === 1 ? '1 worktree' : `${linked.length} worktrees, largest first`;
  return [
    heading('Worktrees', count, `${total.toFixed(1)} GB total`),
    '',
    ...table(['worktree', 'size GB', 'last commit', 'dirty', 'ledger', 'PR'], rows.map(({ cells }) => cells)),
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

function deleteFolders(folders: Folder[], problemOf: (folder: Folder) => string | undefined): Pruned {
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
      rmSync(folder.path, { recursive: true, force: true });
      deleted.push(folder);
    } catch (error) {
      failures.push(`Could not delete ${folder.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { deleted, skipped, failures };
}

/** The git-ignored build folders and own Xcode folders of the linked worktree at `root` of at least 0.05 GB; deleted unless `dryRun`. */
function pruneBuildFolders(paths: LedgerPaths, root: string, dryRun: boolean): Pruned {
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
  return deleteFolders(folders, ({ path: folder }) =>
    folder.startsWith(`${root}${path.sep}`)
      ? deletionProblem(folder, root, outsideKept)
      : deletionProblem(folder, paths.derivedData, (inside) => inside.length === 1 && prefix !== '' && isOwnXcodeFolder(inside[0], prefix)),
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

/** `ledger worktrees prune <name>|--all [--dry-run]`. */
export function pruneWorktrees({ paths, cwd }: Context, name: string | undefined, { all, dryRun }: PruneOptions): PruneReport {
  if ((name === undefined) === !all) fail('Give either a worktree name or --all: ledger worktrees prune <name>|--all [--dry-run]');
  const { linked } = repoOf(cwd);
  if (all) {
    if (linked.length === 0) return report('No linked worktrees.');
    const results = linked.map((worktree) => ({ name: nameOf(worktree), pruned: pruneBuildFolders(paths, worktree.path, dryRun) }));
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
  const matches = linked.filter((worktree) => nameOf(worktree) === name);
  if (matches.length === 0) fail(`No linked worktree named "${name}". Worktrees: ${linked.map(nameOf).join(', ') || 'none'}`);
  if (matches.length > 1) fail(`Two or more linked worktrees are named "${name}": ${matches.map(({ path: folder }) => folder).join(', ')}`);
  const pruned = pruneBuildFolders(paths, matches[0].path, dryRun);
  if ('error' in pruned) fail(pruned.error);
  if ('planned' in pruned) {
    if (pruned.planned.length === 0) return report(`Nothing to prune in ${name}.`);
    return report([heading(`Prune ${name}`, 'dry run', `${totalGb(pruned.planned)} GB in ${folderCount(pruned.planned)}`), '', ...folderTable(pruned.planned), '', ...KEPT_NOTES, `Run ledger worktrees prune ${name} to delete them.`]);
  }
  return report(prunedLines(`Pruned ${name}`, pruned), hasFailed(pruned));
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
