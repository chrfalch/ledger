import type { EngineInterface, FsStat } from 'claude-code'

import { isoDate, summarize } from './ledger'
import { message, sessionFolder } from './lookup'
import { worktreeOf } from './retire'
import {
  autoPrunedMessage,
  basename,
  classifyDerivedData,
  derivedDataPrefix,
  dirtyCount,
  folderLabel,
  formatDerivedData,
  formatOrphanPlan,
  formatPruneAll,
  formatPruned,
  formatPrunedOrphans,
  formatPrunePlan,
  formatTable,
  ignoredBuildFolders,
  isDirectChild,
  isDiskConnected,
  isEmptyFolder,
  isOrphan,
  isOwnXcodeFolder,
  ledgerRole,
  parseCommand,
  parseMainWorktree,
  parsePrs,
  parseWorktrees,
  prLabel,
  pruneBase,
  realPathProblem,
  shortDate,
  sizeGb,
  USAGE,
  volumeOf,
  workspacePathOf,
  type DerivedDataEntry,
  type DerivedDataFolder,
  type PruneFolder,
  type Pruned,
  type PrunedWorktree,
  type PruneScope,
  type PullRequest,
  type RepoLayout,
  type Worktree,
  type WorktreeRow,
} from './worktrees'

type Ran = { stdout: string; failure?: string }

type PrLookup = { prs: PullRequest[] | null; error?: string }

async function run($: EngineInterface, argv: string[], cwd: string): Promise<Ran> {
  try {
    const { exitCode, stdout, stderr } = await $.process.run(argv, { cwd })
    return exitCode === 0 ? { stdout } : { stdout, failure: `failed (exit ${exitCode}): ${stderr.trim()}` }
  } catch (error) {
    return { stdout: '', failure: `did not run: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const okStdout = ({ stdout, failure }: Ran): string | null => (failure === undefined ? stdout : null)

export async function lookUpPrs($: EngineInterface, branch: string, cwd: string): Promise<PrLookup> {
  if (branch === '') return { prs: [] }
  const { stdout, failure } = await run($, ['gh', 'pr', 'list', '--head', branch, '--state', 'all', '--json', 'state,number'], cwd)
  if (failure !== undefined) return { prs: null, error: `gh pr list ${failure}` }
  const prs = parsePrs(stdout)
  return prs ? { prs } : { prs: null, error: 'gh pr list printed something that is not a JSON list' }
}

async function isFile($: EngineInterface, path: string): Promise<boolean> {
  try {
    return (await $.fs.stat(path)).kind === 'file'
  } catch {
    return false
  }
}

async function ledgerCell($: EngineInterface, ledger: string): Promise<Pick<WorktreeRow, 'hasLedger' | 'ledgerRole'>> {
  if (!(await isFile($, ledger))) return { hasLedger: false }
  try {
    const role = ledgerRole(summarize(await $.fs.read(ledger), '', 0))
    return role === undefined ? { hasLedger: true } : { hasLedger: true, ledgerRole: role }
  } catch {
    return { hasLedger: true }
  }
}

async function probe($: EngineInterface, { path, branch }: Worktree, cwd: string): Promise<{ row: WorktreeRow; prError?: string }> {
  const [du, status, log, ledger, { prs, error }] = await Promise.all([
    run($, ['du', '-sk', path], cwd),
    run($, ['git', '-C', path, 'status', '--porcelain'], cwd),
    run($, ['git', '-C', path, 'log', '-1', '--format=%cs'], cwd),
    ledgerCell($, `${path}/.claude/ledger.md`),
    lookUpPrs($, branch, cwd),
  ])
  const statusStdout = okStdout(status)
  const logStdout = okStdout(log)
  const row = {
    name: basename(path),
    // du exits non-zero when it cannot read some file, yet still prints the total of what it could.
    sizeGb: sizeGb(du.stdout),
    lastCommit: logStdout === null ? null : shortDate(logStdout),
    dirty: statusStdout === null ? null : dirtyCount(statusStdout),
    ...ledger,
    pr: prLabel(prs),
  }
  return { row, prError: error }
}

export async function linkedWorktrees($: EngineInterface, cwd: string): Promise<RepoLayout & { error?: string }> {
  const list = await run($, ['git', 'worktree', 'list', '--porcelain', '-z'], cwd)
  if (list.failure !== undefined) return { main: null, worktrees: [], error: `Could not list worktrees. git worktree list ${list.failure}` }
  const listed = parseWorktrees(list.stdout)
  const present = await Promise.all(listed.map(({ path }) => $.fs.exists(path)))
  return { main: parseMainWorktree(list.stdout), worktrees: listed.filter((_, index) => present[index]) }
}

/** The rows /ledger:worktrees shows. `prError` is why a PR could not be looked up, for the first worktree whose lookup failed. */
export async function worktreeRows($: EngineInterface, worktrees: Worktree[], cwd: string): Promise<{ rows: WorktreeRow[]; prError?: string }> {
  const probes = await Promise.all(worktrees.map(worktree => probe($, worktree, cwd)))
  return { rows: probes.map(({ row }) => row), prError: probes.find(({ prError }) => prError !== undefined)?.prError }
}

async function table($: EngineInterface, worktrees: Worktree[], cwd: string): Promise<string> {
  const { rows, prError } = await worktreeRows($, worktrees, cwd)
  return formatTable(rows, prError)
}

async function derivedDataPath($: EngineInterface): Promise<string | null> {
  const home = await $.env.get('HOME')
  return home?.startsWith('/') ? `${home}/Library/Developer/Xcode/DerivedData` : null
}

async function pruneScope($: EngineInterface, root: string): Promise<PruneScope> {
  return { root, derivedData: await derivedDataPath($), prefix: await derivedDataPrefix(root) }
}

async function xcodeBuildFolders($: EngineInterface, { derivedData, prefix }: PruneScope): Promise<string[]> {
  if (derivedData === null) return []
  try {
    const entries = await $.fs.list(derivedData)
    return entries.filter(({ name, kind }) => kind === 'dir' && isOwnXcodeFolder(name, prefix)).map(({ name }) => `${derivedData}/${name}`)
  } catch {
    return []
  }
}

function resolve($: EngineInterface, path: string): Promise<FsStat | undefined> {
  return $.fs.stat(path, { resolve: true }).catch(() => undefined)
}

/** Why `rm -rf` must not touch the path, judged on where it really lands rather than how it is spelled; undefined when it may. */
async function deletionProblem($: EngineInterface, path: string, scope: PruneScope): Promise<string | undefined> {
  const base = pruneBase(path, scope)
  if (base === null) return 'it is not a build folder of this worktree.'
  const [own, allowed] = await Promise.all([resolve($, path), resolve($, base)])
  if (own?.isLink) return 'it is a symbolic link.'
  if (own?.realPath === undefined) return 'its real path could not be resolved.'
  if (allowed?.realPath === undefined) return `the real path of ${base} could not be resolved.`
  return realPathProblem(own.realPath, allowed.realPath)
}

/** Deletes a folder that passed its safety checks; the text says why it could not. */
type Remove = (folder: PruneFolder) => Promise<string | undefined>

function removeNow($: EngineInterface, cwd: string): Remove {
  return async folder => {
    const { failure } = await run($, ['rm', '-rf', '--', folder.path], cwd)
    return failure === undefined ? undefined : `Could not delete ${folder.label}: rm ${failure}`
  }
}

/**
 * Moves the folder into a new trash folder, which is instant on one disk, then deletes the trash in its own process group
 * with no inherited output, so nothing waits for the delete; bin/cc-worktree-retire does the same. The trash goes in `$2`
 * only when stat puts it on the folder's disk, so a stat that fails or differs leaves it beside the folder.
 * /usr/bin/stat, because GNU coreutils can come first on PATH, and its stat -f reports on the file system instead.
 */
const MOVE_TO_TRASH = [
  'parent=${1%/*}',
  'device=$(/usr/bin/stat -f %d "$1" 2>/dev/null) && [ -n "$device" ] && [ "$device" = "$(/usr/bin/stat -f %d "$2" 2>/dev/null)" ] && parent=$2',
  'trash=$(mktemp -d "$parent/.cc-trash-XXXXXX") || exit 1',
  'mv -- "$1" "$trash/" || { rmdir "$trash"; exit 1; }',
  '(set -m; nohup rm -rf -- "$trash" </dev/null >/dev/null 2>&1 &)',
].join('\n')

/** The command that moves `folder` into a trash folder in `trashParent`, or beside `folder` when that cannot be used, and deletes the trash in the background. */
export function moveToTrashArgv(folder: string, trashParent: string): string[] {
  return ['sh', '-c', MOVE_TO_TRASH, 'sh', folder, trashParent]
}

/** `trashParent` is the worktree's own git dir, which is outside its tree, so the trash never shows in the worktree's git status. */
function removeInBackground($: EngineInterface, trashParent: string, cwd: string): Remove {
  return async folder => {
    const { failure } = await run($, moveToTrashArgv(folder.path, trashParent), cwd)
    return failure === undefined ? undefined : `Could not move ${folder.label} to the trash: ${failure}`
  }
}

/** The worktree's git dir, or '' when git cannot name it. */
async function gitDirOf($: EngineInterface, root: string, cwd: string): Promise<string> {
  const { stdout, failure } = await run($, ['git', '-C', root, 'rev-parse', '--absolute-git-dir'], cwd)
  return failure === undefined ? stdout.replace(/\n$/, '') : ''
}

async function deleteFolders(folders: PruneFolder[], problemOf: (folder: PruneFolder) => Promise<string | undefined>, remove: Remove): Promise<Pruned> {
  const failures = await Promise.all(
    folders.map(async folder => {
      const problem = await problemOf(folder)
      return problem === undefined ? remove(folder) : `Skipped ${folder.path}: ${problem}`
    }),
  )
  return { deleted: folders.filter((_, index) => failures[index] === undefined), failures: failures.filter(failure => failure !== undefined) }
}

/** `delete-in-background` returns once the folders are moved out of the way, for a caller that must not wait for the delete. */
export type PruneMode = 'dry-run' | 'delete' | 'delete-in-background'

/** Finds the non-empty build folders of the linked worktree at `root` and deletes those that pass `deletionProblem`, or in `dry-run` only plans. */
export async function pruneBuildFolders($: EngineInterface, root: string, mode: PruneMode, cwd: string): Promise<Pruned | { error: string }> {
  const scope = await pruneScope($, root)
  const [ignored, xcodePaths] = await Promise.all([run($, ['git', '-C', root, 'status', '--ignored', '--porcelain'], cwd), xcodeBuildFolders($, scope)])
  if (ignored.failure !== undefined) return { error: `Could not read the ignored files of ${basename(root)}. git status ${ignored.failure}` }
  const sized = await Promise.all(
    [...ignoredBuildFolders(ignored.stdout, root), ...xcodePaths].map(async path => ({
      path,
      label: folderLabel(path, root),
      sizeGb: sizeGb((await run($, ['du', '-sk', path], cwd)).stdout),
    })),
  )
  const folders = sized.filter(folder => !isEmptyFolder(folder))
  if (mode === 'dry-run' || folders.length === 0) return { planned: folders }
  const remove = mode === 'delete' ? removeNow($, cwd) : removeInBackground($, await gitDirOf($, root, cwd), cwd)
  return deleteFolders(folders, folder => deletionProblem($, folder.path, scope), remove)
}

const pruneMode = (dryRun: boolean): PruneMode => (dryRun ? 'dry-run' : 'delete')

/** Prunes the linked worktree named `name` as `pruneBuildFolders` does. */
export async function pruneWorktree($: EngineInterface, worktrees: Worktree[], name: string, dryRun: boolean, cwd: string): Promise<Pruned | { error: string }> {
  const [match, ...others] = worktrees.filter(({ path }) => basename(path) === name)
  if (match === undefined) {
    const names = worktrees.map(({ path }) => basename(path)).join(', ') || 'none'
    return { error: `No linked worktree named "${name}". Worktrees: ${names}` }
  }
  if (others.length > 0) return { error: `Two or more linked worktrees are named "${name}": ${[match, ...others].map(({ path }) => path).join(', ')}` }
  return pruneBuildFolders($, match.path, pruneMode(dryRun), cwd)
}

/** Prunes every linked worktree as `pruneBuildFolders` does; one that fails is reported in its own entry, and the others still run. */
export function pruneAll($: EngineInterface, worktrees: Worktree[], dryRun: boolean, cwd: string): Promise<PrunedWorktree[]> {
  return Promise.all(
    worktrees.map(async ({ path }) => ({
      name: basename(path),
      pruned: await pruneBuildFolders($, path, pruneMode(dryRun), cwd).catch(error => ({ error: message(error) })),
    })),
  )
}

/** In a worktree's `.claude` folder: its finished task was pruned, or the prune failed, so nothing is tried again until the task is reopened. */
export const PRUNED_MARKER = 'build-folders-pruned'

async function realPathOf($: EngineInterface, path: string): Promise<string> {
  return (await resolve($, path))?.realPath ?? path
}

/** Whether `root` is a linked worktree, judged on real paths, because git and the ledger may spell one folder differently. */
async function isLinkedWorktree($: EngineInterface, root: string, worktrees: Worktree[]): Promise<boolean> {
  const [own, ...linked] = await Promise.all([root, ...worktrees.map(({ path }) => path)].map(path => realPathOf($, path)))
  return linked.includes(own ?? root)
}

/** The line to log and the marker's text, after a prune of the finished task's worktree at `root`; undefined when `root` is not a linked worktree. */
async function pruneFinished($: EngineInterface, root: string, cwd: string): Promise<{ line: string; note: string } | undefined> {
  const name = basename(root)
  const today = isoDate(new Date())
  const failed = (reason: string) => ({
    line: `Did not prune ${name}. ${reason}`,
    note: `The ledger mod could not prune the build folders of this worktree on ${today}, when its task was finished:\n${reason}\nWhile this file exists, it does not try again. Run \`/ledger:worktrees prune ${name}\` to prune by hand.\n`,
  })
  try {
    const { worktrees, error } = await linkedWorktrees($, cwd)
    if (error !== undefined) return failed(error)
    if (!(await isLinkedWorktree($, root, worktrees))) return undefined
    const pruned = await pruneBuildFolders($, root, 'delete-in-background', cwd)
    if ('error' in pruned) return failed(pruned.error)
    return {
      line: autoPrunedMessage(name, pruned),
      note: `The ledger mod pruned the build folders of this worktree on ${today}, because its task was finished. While this file exists, it does not prune them again.\n`,
    }
  } catch (error) {
    return failed(message(error))
  }
}

/**
 * Prunes the build folders of a finished task's worktree once per finish, and deletes them in the background so the turn's
 * end does not wait. A failed prune is logged once too. A ledger that is not in a linked worktree is left alone. It logs one
 * line for each outcome and never throws.
 */
export async function autoPrune($: EngineInterface, ledger: string, isFinished: boolean): Promise<void> {
  const root = worktreeOf(ledger)
  const name = basename(root)
  const marker = `${root}/.claude/${PRUNED_MARKER}`
  try {
    const isMarked = await isFile($, marker)
    if (isFinished === isMarked) return
    const { path: cwd } = await sessionFolder($)
    if (!isFinished) {
      const { failure } = await run($, ['rm', '-f', '--', marker], cwd)
      if (failure !== undefined) $.ui.log(`Could not remove ${marker}, so ${name} is not pruned when its task is finished again: rm ${failure}`)
      return
    }
    const outcome = await pruneFinished($, root, cwd)
    if (outcome === undefined) return
    $.ui.log(outcome.line)
    await $.fs.write(marker, outcome.note).catch(error => $.ui.log(`Could not write ${marker}: ${message(error)}. The next turn end tries ${name} again.`))
  } catch (error) {
    $.ui.log(`Did not prune ${name}. ${message(error)}`)
  }
}

async function isVolumeConnected($: EngineInterface, volume: string, cwd: string): Promise<boolean> {
  // An absolute path, because GNU coreutils can come first on PATH, and its stat -f reports on the file system instead.
  const [own, volumes, link] = await Promise.all([
    run($, ['/usr/bin/stat', '-L', '-f', '%d', volume], cwd),
    run($, ['/usr/bin/stat', '-f', '%d', '/Volumes'], cwd),
    resolve($, volume),
  ])
  return isDiskConnected({ device: okStdout(own), volumesDevice: okStdout(volumes), linkTarget: link?.isLink ? (link.realPath ?? null) : null })
}

async function readDerivedDataEntry($: EngineInterface, derivedData: string, name: string, cwd: string): Promise<DerivedDataEntry> {
  // plutil reads the binary and the XML form Xcode writes alike, and fails when the file or the key is missing.
  const plist = await run($, ['plutil', '-extract', 'WorkspacePath', 'raw', '-o', '-', `${derivedData}/${name}/info.plist`], cwd)
  const workspacePath = workspacePathOf(okStdout(plist))
  if (workspacePath === null) return { name, workspacePath, exists: false, diskConnected: true }
  const volume = volumeOf(workspacePath)
  const [exists, diskConnected] = await Promise.all([$.fs.exists(workspacePath), volume === null || isVolumeConnected($, volume, cwd)])
  return { name, workspacePath, exists, diskConnected }
}

async function derivedDataFolders($: EngineInterface, derivedData: string | null, layout: RepoLayout, cwd: string): Promise<DerivedDataFolder[]> {
  if (derivedData === null) return []
  const entries = await $.fs.list(derivedData).catch(() => [])
  return Promise.all(
    entries
      .filter(({ kind }) => kind === 'dir')
      .map(async ({ name }) => {
        const path = `${derivedData}/${name}`
        const [entry, du] = await Promise.all([readDerivedDataEntry($, derivedData, name, cwd), run($, ['du', '-sk', path], cwd)])
        return { path, label: name, sizeGb: sizeGb(du.stdout), group: classifyDerivedData(entry, layout) }
      }),
  )
}

/** Every folder in DerivedData, with its size and the group its WorkspacePath puts it in. */
export async function listDerivedData($: EngineInterface, layout: RepoLayout, cwd: string): Promise<DerivedDataFolder[]> {
  return derivedDataFolders($, await derivedDataPath($), layout, cwd)
}

/** Why `rm -rf` must not touch the folder: it must really be a folder directly inside DerivedData, and still be an orphan now; undefined when it may. */
async function orphanDeletionProblem($: EngineInterface, path: string, derivedData: string, layout: RepoLayout, cwd: string): Promise<string | undefined> {
  if (!isDirectChild(path, derivedData)) return `it is not directly inside ${derivedData}.`
  const [own, allowed] = await Promise.all([resolve($, path), resolve($, derivedData)])
  if (own?.isLink) return 'it is a symbolic link.'
  if (own?.realPath === undefined) return 'its real path could not be resolved.'
  if (allowed?.realPath === undefined) return `the real path of ${derivedData} could not be resolved.`
  if (!isDirectChild(own.realPath, allowed.realPath)) return `it resolves to ${own.realPath}, which is not directly inside ${allowed.realPath}.`
  const entry = await readDerivedDataEntry($, derivedData, basename(path), cwd)
  return isOrphan(entry, layout) ? undefined : 'it is no longer an orphan.'
}

/** Finds the orphans in DerivedData and deletes those that pass `orphanDeletionProblem`, or with `dryRun` only plans. */
export async function pruneOrphans($: EngineInterface, layout: RepoLayout, dryRun: boolean, cwd: string): Promise<Pruned> {
  const derivedData = await derivedDataPath($)
  const orphans = (await derivedDataFolders($, derivedData, layout, cwd)).filter(({ group }) => group.kind === 'orphan')
  if (dryRun || derivedData === null || orphans.length === 0) return { planned: orphans }
  return deleteFolders(orphans, folder => orphanDeletionProblem($, folder.path, derivedData, layout, cwd), removeNow($, cwd))
}

/** The text /ledger:worktrees answers with for the arguments the operator typed. */
export async function worktreesCommand($: EngineInterface, args: string): Promise<string> {
  const command = parseCommand(args)
  if (command.kind === 'usage') return USAGE
  const { path: cwd } = await sessionFolder($)
  const { error, ...layout } = await linkedWorktrees($, cwd)
  if (error !== undefined) return error
  switch (command.kind) {
    case 'table':
      return table($, layout.worktrees, cwd)
    case 'prune': {
      const pruned = await pruneWorktree($, layout.worktrees, command.name, command.dryRun, cwd)
      if ('error' in pruned) return pruned.error
      return 'planned' in pruned ? formatPrunePlan(command.name, pruned.planned) : formatPruned(command.name, pruned.deleted, pruned.failures)
    }
    case 'prune-all':
      return formatPruneAll(await pruneAll($, layout.worktrees, command.dryRun, cwd), command.dryRun)
    case 'derived-data':
      return formatDerivedData(await listDerivedData($, layout, cwd))
    case 'prune-orphans': {
      const pruned = await pruneOrphans($, layout, command.dryRun, cwd)
      return 'planned' in pruned ? formatOrphanPlan(pruned.planned) : formatPrunedOrphans(pruned.deleted, pruned.failures)
    }
  }
}
