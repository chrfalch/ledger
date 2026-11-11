import { formatTime, taskName } from '../../mods/ledger/hooks/ledger.js';
import { colors } from './colors.js';
import type { Archive, DerivedDataSection, Overview, PruneFolder, Pruned, PrunedWorktree, Shown, WorktreeRow } from './hooks.js';
import { table, truncate } from './table.js';

const TEXT_WIDTH = 80;

const STATUS_COLORS: Record<string, (text: string) => string> = {
  active: colors.green,
  parked: colors.yellow,
  backlog: colors.cyan,
  archived: colors.dim,
  retired: colors.dim,
  missing: colors.red,
};

const statusLabel = (status: string): string => (STATUS_COLORS[status] ?? String)(status);

const heading = (title: string, ...facts: string[]): string => [colors.bold(title), ...facts].join(colors.dim(' · '));

const header = (...names: string[]): string[] => names.map(name => colors.dim(name));

const updated = (iso: string): string => colors.dim(formatTime(Date.parse(iso)));

const unknown = (value: string | number | null | undefined): string => (value === null || value === undefined ? colors.yellow('?') : String(value));

/** Dims what /ledger:all adds to a slug: the arrow of a child, and the parent a task names. */
const slugCell = (name: string): string => name.replace(/↳ /, colors.dim('↳ ')).replace(/ \(parent: .*\)$/, colors.dim('$&'));

export function overviewView({ tasks, backlog }: Overview): string {
  const total = tasks.length + backlog.length;
  const active = tasks.filter(({ status }) => status === 'active').length;
  const counts = [`${total} ${total === 1 ? 'task' : 'tasks'}`, `${active} active`, ...(backlog.length > 0 ? [`${backlog.length} backlog`] : [])];
  const sections = [heading('All task ledgers', counts.join(', '))];
  if (tasks.length > 0) {
    const rows = tasks.map(({ entry, name, status, next }) => [entry.repo, slugCell(name), statusLabel(status), updated(entry.updated), truncate(next, TEXT_WIDTH)]);
    sections.push(table(header('repo', 'slug', 'status', 'updated', 'next'), rows).join('\n'));
  }
  if (backlog.length > 0) {
    const rows = backlog.map(({ entry, name, goal }) => [entry.repo, slugCell(name), updated(entry.updated), truncate(goal, TEXT_WIDTH)]);
    sections.push([colors.bold('Backlog'), ...table(header('repo', 'slug', 'updated', 'goal'), rows)].join('\n'));
  }
  return sections.join('\n\n');
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const highlight = (text: string, term: string): string => text.replace(new RegExp(escapeRegExp(term), 'gi'), found => colors.bold(colors.yellow(found)));

/** `count` describes the ledgers in the words of /ledger:archive. `repo` is null for every repo, which adds a repo column. */
export function archiveView({ repo, ledgers }: Archive, term: string, count: string): string {
  const everyRepo = repo === null;
  const rows = ledgers.map(ledger => [
    colors.dim(ledger.date),
    ...(everyRepo ? [ledger.repo] : []),
    ledger.slug,
    colors.dim(ledger.branch),
    truncate(ledger.goal, TEXT_WIDTH),
    ...(term ? [highlight(truncate(ledger.match ?? '', TEXT_WIDTH), term)] : []),
  ]);
  const columns = header('date', ...(everyRepo ? ['repo'] : []), 'slug', 'branch', 'goal', ...(term ? ['match'] : []));
  return [heading('Archived ledgers', repo ?? 'every repo', count), '', ...table(columns, rows)].join('\n');
}

export function parentView({ parent, goal, children }: Shown): string {
  if (children.length === 0) return `${parent} has no child tasks.`;
  const count = children.length === 1 ? '1 child' : `${children.length} children`;
  const active = children.filter(({ status }) => status === 'active').length;
  const rows = children.flatMap(child => [
    [taskName(child), statusLabel(child.status), truncate(child.next, TEXT_WIDTH)],
    ...(child.report ?? []).map(line => ['', '', colors.dim(line.trimEnd())]),
  ]);
  return [heading(`Parent task ${parent}`, `${count}, ${active} active`), ...(goal ? [goal] : []), '', ...table(header('task', 'status', 'next'), rows)].join('\n');
}

function prCell(pr: string): string {
  if (pr === '?') return colors.yellow(pr);
  if (pr === 'none') return colors.dim(pr);
  if (pr.startsWith('OPEN ')) return colors.green(pr);
  if (pr.startsWith('MERGED ')) return colors.magenta(pr);
  return colors.dim(pr);
}

const dirtyCell = (dirty: number | null): string => (dirty === null ? unknown(dirty) : dirty === 0 ? colors.dim('0') : colors.yellow(String(dirty)));

/** `prError` is why the PR column shows ? on a row. */
export function worktreesView(rows: WorktreeRow[], prError?: string): string {
  if (rows.length === 0) return 'No linked worktrees.';
  const sorted = [...rows].sort((a, b) => (b.sizeGb ?? -1) - (a.sizeGb ?? -1));
  const totalGb = rows.reduce((sum, row) => sum + (row.sizeGb ?? 0), 0);
  const count = rows.length === 1 ? '1 worktree' : `${rows.length} worktrees, largest first`;
  const lines = table(
    header('worktree', 'size GB', 'last commit', 'dirty', 'ledger', 'PR'),
    sorted.map(row => [
      row.name,
      unknown(row.sizeGb?.toFixed(1)),
      unknown(row.lastCommit),
      dirtyCell(row.dirty),
      row.hasLedger ? (row.ledgerRole ?? 'yes') : colors.dim('no'),
      prCell(row.pr),
    ]),
    ['left', 'right', 'left', 'right'],
  );
  return [heading('Worktrees', count, `${totalGb.toFixed(1)} GB total`), '', ...lines, ...(prError ? ['', colors.dim(`PR is ? because ${prError}`)] : [])].join('\n');
}

const DERIVED_DATA = '~/Library/Developer/Xcode/DerivedData';
const ORPHANS = `orphans in ${DERIVED_DATA}`;
const ORPHAN_NOTE = colors.dim('An orphan was built from a project that no longer exists on disk.');
const DISK_NOT_CONNECTED_NOTE = colors.dim('A folder here was built from a project on a disk that is not connected, so it is never deleted.');
const PRUNE_ORPHANS = colors.bold('ledger worktrees prune-orphans');

/** The text as one shell word, so a printed command still works when pasted. */
const shellWord = (text: string): string => (/^[\w./@%+=:,-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`);

const totalGb = (folders: PruneFolder[]): string => `${folders.reduce((sum, { sizeGb }) => sum + (sizeGb ?? 0), 0).toFixed(1)} GB`;

const folderCount = (folders: PruneFolder[]): string => (folders.length === 1 ? '1 folder' : `${folders.length} folders`);

const sizeOf = (folders: PruneFolder[]): string => `${totalGb(folders)} in ${folderCount(folders)}`;

function folderTable(folders: PruneFolder[]): string[] {
  const sorted = [...folders].sort((a, b) => (b.sizeGb ?? -1) - (a.sizeGb ?? -1));
  return table(header('folder', 'size GB'), sorted.map(({ label, sizeGb }) => [label, unknown(sizeGb?.toFixed(1))]), ['left', 'right']);
}

/** `notes` end with the command that deletes what the plan lists. */
const planView = (title: string, folders: PruneFolder[], notes: string[]): string =>
  [heading(title, 'dry run', sizeOf(folders)), '', ...folderTable(folders), '', ...notes].join('\n');

const freed = (deleted: PruneFolder[]): string => `${totalGb(deleted)} freed in ${folderCount(deleted)}`;

function deletedView(title: string, deleted: PruneFolder[], failures: string[]): string {
  return [
    heading(title, freed(deleted)),
    ...(deleted.length > 0 ? ['', ...folderTable(deleted)] : []),
    ...(failures.length > 0 ? ['', ...failures.map(failure => colors.yellow(failure))] : []),
  ].join('\n');
}

const KEPT_NOTES = [colors.dim('Folders inside a .claude folder are never deleted.'), colors.dim('node_modules and Pods folders are kept, so the worktree still builds.')];

/** What `ledger worktrees prune <name>` planned or deleted in the linked worktree `name`. */
export function pruneView(name: string, pruned: Pruned): string {
  if ('deleted' in pruned) return deletedView(`Pruned ${name}`, pruned.deleted, pruned.failures);
  if (pruned.planned.length === 0) return `Nothing to prune in ${name}.`;
  return planView(`Prune ${name}`, pruned.planned, [...KEPT_NOTES, `Run ${colors.bold(`ledger worktrees prune ${shellWord(name)}`)} to delete them.`]);
}

function worktreeSection({ name, pruned }: PrunedWorktree): string[] {
  if ('error' in pruned) return [heading(name, colors.yellow('not pruned')), colors.yellow(pruned.error)];
  if ('planned' in pruned) return pruned.planned.length === 0 ? [heading(name, colors.dim('nothing to prune'))] : [heading(name, sizeOf(pruned.planned)), ...folderTable(pruned.planned)];
  return [heading(name, freed(pruned.deleted)), ...(pruned.deleted.length > 0 ? folderTable(pruned.deleted) : []), ...pruned.failures.map(failure => colors.yellow(failure))];
}

/** What `ledger worktrees prune --all` planned or deleted: a section per linked worktree, under the total. */
export function pruneAllView(results: PrunedWorktree[], dryRun: boolean): string {
  if (results.length === 0) return 'No linked worktrees.';
  if (results.every(({ pruned }) => 'planned' in pruned && pruned.planned.length === 0)) return 'Nothing to prune in any linked worktree.';
  const planned = results.flatMap(({ pruned }) => ('planned' in pruned ? pruned.planned : []));
  const deleted = results.flatMap(({ pruned }) => ('deleted' in pruned ? pruned.deleted : []));
  return [
    dryRun ? heading('Prune every linked worktree', 'dry run', sizeOf(planned)) : heading('Pruned every linked worktree', freed(deleted)),
    ...results.flatMap(result => ['', ...worktreeSection(result)]),
    ...(dryRun && planned.length > 0 ? ['', ...KEPT_NOTES, `Run ${colors.bold('ledger worktrees prune --all')} to delete them.`] : []),
  ].join('\n');
}

export function pruneOrphansView(pruned: Pruned): string {
  if ('deleted' in pruned) return deletedView(`Pruned ${ORPHANS}`, pruned.deleted, pruned.failures);
  if (pruned.planned.length === 0) return `Nothing to prune: no ${ORPHANS}.`;
  return planView(`Prune ${ORPHANS}`, pruned.planned, [ORPHAN_NOTE, `Run ${PRUNE_ORPHANS} to delete them.`]);
}

export function derivedDataView(sections: DerivedDataSection[]): string {
  if (sections.length === 0) return `No folders in ${DERIVED_DATA}.`;
  return [
    heading(DERIVED_DATA, sizeOf(sections.flatMap(({ folders }) => folders))),
    ...sections.flatMap(({ label, kind, folders }) => [
      '',
      heading(label, sizeOf(folders)),
      ...folderTable(folders),
      ...(kind === 'disk-not-connected' ? ['', DISK_NOT_CONNECTED_NOTE] : []),
    ]),
    ...(sections.some(({ kind }) => kind === 'orphan') ? ['', ORPHAN_NOTE, `Run ${PRUNE_ORPHANS} to delete the orphans.`] : []),
  ].join('\n');
}
