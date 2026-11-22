import stringWidth from 'string-width';
import { plainLine } from './format.js';
import { repoKey, repoLabel } from './repo-key.js';
import { inRepo, type ChildView, type Task } from './tasks.js';

const TEXT_WIDTH = 80;

const pad = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - stringWidth(text)));

/** One line per row, header first, each column as wide as its widest cell. */
export function table(header: string[], rows: string[][]): string[] {
  const lines = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...lines.map((row) => stringWidth(row[column] ?? ''))));
  return lines.map((row) => widths.map((width, column) => pad(row[column] ?? '', width)).join('  ').trimEnd());
}

function truncate(text: string, width = TEXT_WIDTH): string {
  if (stringWidth(text) <= width) return text;
  let kept = '';
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    if (stringWidth(`${kept}${segment}…`) > width) break;
    kept += segment;
  }
  return `${kept}…`;
}

export const heading = (...parts: string[]): string => parts.join(' · ');

export const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** `a`, `a and b`, `a, b and c`. */
export const joined = (parts: string[]): string => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);

const localDate = (ms: number): string => {
  const date = new Date(ms);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(2, '0')).join('-');
};

/** A parent in another repo is named with that repo's label. */
function parentCell(task: Task): string {
  const parent = task.ledger.location.parent;
  if (parent === undefined) return '';
  return parent.main === undefined ? parent.slug : `${parent.slug} (${repoLabel(repoKey(parent.main))})`;
}

/** The listed task that `task` names as its parent: a live one before an archive copy. */
function listedParent(task: Task, tasks: Task[]): Task | undefined {
  const parent = task.ledger.location.parent;
  if (parent === undefined) return undefined;
  const main = parent.main ?? task.main;
  const named = tasks.filter((other) => other !== task && other.slug === parent.slug && (main === undefined ? other.repo === task.repo : inRepo(other, main)));
  return named.find(({ place }) => place !== 'archive') ?? named[0];
}

/**
 * `tasks` with each child task right after its parent, active children first, and `depth` levels below the top. A task
 * whose parent is not listed stays at the top, in the order of `tasks`; so does a task in a cycle.
 */
function familyOrder(tasks: Task[]): { task: Task; depth: number }[] {
  const parents = new Map(tasks.map((task) => [task, listedParent(task, tasks)]));
  const isActive = (task: Task): number => Number(task.status === 'active');
  const rows: { task: Task; depth: number }[] = [];
  const placed = new Set<Task>();
  const place = (task: Task, depth: number): void => {
    if (placed.has(task)) return;
    placed.add(task);
    rows.push({ task, depth });
    const children = tasks.filter((child) => parents.get(child) === task).sort((a, b) => isActive(b) - isActive(a));
    for (const child of children) place(child, depth + 1);
  };
  for (const task of tasks) if (parents.get(task) === undefined) place(task, 0);
  for (const task of tasks) place(task, 0);
  return rows;
}

const nestedName = (slug: string, depth: number): string => (depth === 0 ? slug : `${'  '.repeat(depth - 1)}↳ ${slug}`);

export function listView(tasks: Task[]): string {
  if (tasks.length === 0) return 'No live tasks. Retired tasks are listed by: ledger task archive';
  const count = (status: string): number => tasks.filter((task) => task.status === status).length;
  const counts = [`${count('active')} active`, `${count('parked')} parked`, ...(count('lost') > 0 ? [`${count('lost')} lost`] : []), `${count('backlog')} backlog`];
  // A task of another machine names that machine; one of this machine whose worktree is gone gets the footnote, unless it is marked lost.
  const isGone = ({ elsewhere, host, status }: Task): boolean => elsewhere === true && host === undefined && status !== 'lost';
  const status = (task: Task): string => (task.host !== undefined ? `${task.status} on ${task.host}` : isGone(task) ? `${task.status}*` : task.status);
  const rows = familyOrder(tasks).map(({ task, depth }) => [repoLabel(task.repo), nestedName(task.slug, depth), status(task), parentCell(task), localDate(task.mtimeMs), truncate(task.ledger.next)]);
  const note = tasks.some(isGone) ? ['', '* its worktree is not on this machine'] : [];
  return [heading('Task ledgers', `${plural(tasks.length, 'task')}: ${counts.join(', ')}`), '', ...table(['repo', 'task', 'status', 'parent', 'updated', 'next'], rows), ...note].join('\n');
}

export type ArchiveRow = { task: Task; match?: string };

/** The first `- branch:` line as written, a placeholder included, as the old archive reader showed it. */
export const writtenBranch = (task: Task): string =>
  task.ledger.lines.map((line) => /^- branch:[ \t]*(.*)$/.exec(plainLine(line))?.[1].trim()).find((branch) => branch !== undefined) ?? '';

/** `repo` is undefined for the archive of every repo, which adds a repo column. */
export function archiveView(rows: ArchiveRow[], repo: string | undefined, term: string, folder: string): string {
  if (rows.length === 0) return term ? `No archived ledger in ${folder} contains "${term}".` : `No archived ledgers in ${folder}.`;
  const contains = term ? ` that contain${rows.length === 1 ? 's' : ''} "${term}"` : '';
  const count = `${plural(rows.length, 'ledger')}${contains}${rows.length === 1 ? '' : ', newest first'}`;
  const header = ['date', ...(repo === undefined ? ['repo'] : []), 'task', 'branch', 'goal', ...(term ? ['match'] : [])];
  const cells = rows.map(({ task, match }) => [
    task.archived ?? '',
    ...(repo === undefined ? [repoLabel(task.repo)] : []),
    task.slug,
    writtenBranch(task),
    truncate(task.ledger.goal),
    ...(term ? [truncate(match ?? '')] : []),
  ]);
  return [heading('Archived ledgers', repo === undefined ? 'every repo' : repoLabel(repo), count), '', ...table(header, cells)].join('\n');
}

/** A child in another repo is named `<slug>@<main>`, the form `ledger tree` takes. */
const childName = (child: ChildView, parentMain: string): string => (child.main === parentMain ? child.slug : `${child.slug}@${child.main}`);

export function parentView(parent: Task, parentMain: string, children: ChildView[]): string {
  if (children.length === 0) return `${parent.slug} has no child tasks.`;
  const active = children.filter(({ status }) => status === 'active').length;
  const rows = children.flatMap((child) => [
    [childName(child, parentMain), child.status, truncate(child.next)],
    ...child.report.map((line) => ['', '', line.trimEnd()]),
  ]);
  return [
    heading(`Parent task ${parent.slug}`, `${plural(children.length, 'child', 'children')}, ${active} active`),
    ...(parent.ledger.goal ? [parent.ledger.goal] : []),
    '',
    ...table(['task', 'status', 'next'], rows),
  ].join('\n');
}
