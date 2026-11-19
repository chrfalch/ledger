import path from 'node:path';
import { fail } from './failure.js';
import { mainCheckout } from './git.js';
import { mainOfTaskWorktree, worktreeLedger, type LedgerPaths } from './paths.js';
import type { LedgerStore } from './store.js';
import { pauseForTest } from './wait.js';
import { findTasks, folderTask, scanLedgerFolders, type Task } from './tasks.js';

// @ref LLP 0000#the-registry — why the registry is a cache that a rebuild can always replace.

/** One entry of ~/.claude/ledgers.json, in the shape the ledger plugin also reads. Parked is not stored: it is computed on read. */
export type RegistryEntry = {
  repo: string;
  slug: string;
  path: string;
  branch: string;
  parent?: string;
  parentMain?: string;
  status: 'active' | 'backlog' | 'archived';
  main?: string;
  created: string;
  updated: string;
  archivePath?: string;
};

const isEntry = (value: unknown): value is RegistryEntry =>
  typeof value === 'object' && value !== null && 'path' in value && typeof value.path === 'string' && 'status' in value && typeof value.status === 'string';

/** The stored entries, or undefined when the text is not a JSON array. */
export function parseRegistry(text: string): RegistryEntry[] | undefined {
  try {
    const entries: unknown = JSON.parse(text);
    return Array.isArray(entries) ? entries.filter(isEntry) : undefined;
  } catch {
    return undefined;
  }
}

const sameLedger = (task: Task) => (entry: RegistryEntry): boolean =>
  task.place === 'archive' ? entry.archivePath === task.file : entry.status !== 'archived' && entry.path === task.file;

function toEntry(task: Task, previous: RegistryEntry | undefined): RegistryEntry {
  const { parent, worktree } = task.ledger.location;
  const archived = task.place === 'archive';
  return {
    repo: task.repo,
    slug: task.slug,
    path: archived ? (worktree === undefined ? '' : worktreeLedger(worktree)) : task.file,
    branch: task.branch ?? '',
    ...(parent === undefined ? {} : { parent: parent.slug }),
    ...(parent?.main === undefined ? {} : { parentMain: parent.main }),
    status: archived ? 'archived' : task.place === 'backlog' ? 'backlog' : 'active',
    ...(task.main === undefined ? {} : { main: task.main }),
    created: previous?.created ?? new Date(task.birthtimeMs).toISOString(),
    updated: new Date(task.mtimeMs).toISOString(),
    ...(archived ? { archivePath: task.file } : {}),
  };
}

/** The repo of an entry: its stored main, else for an active entry the folder its worktree sits in. */
function entryMain(entry: RegistryEntry): string | undefined {
  if (entry.main !== undefined || entry.status !== 'active') return entry.main;
  const worktree = path.dirname(path.dirname(entry.path));
  return mainOfTaskWorktree(worktree) ?? worktree;
}

type Context = { store: LedgerStore; paths: LedgerPaths };

/** A try fails only when another command wrote the registry in between, so running out of tries takes 20 such writes. */
const REBUILD_TRIES = 20;

/** The tasks on disk, and the registry text that lists them, read with `current` as the registry. */
function rebuild({ store, paths }: Context, extraMains: string[], current: string | undefined): { tasks: Task[]; text: string } {
  const stored = current === undefined ? undefined : parseRegistry(current);
  const storedMains = (stored ?? []).flatMap((entry) => entryMain(entry) ?? []);
  const scanned = stored === undefined ? scanLedgerFolders(paths.scanRoots) : [];
  const mains = [...extraMains, ...(stored === undefined ? scanned : storedMains)];
  const ledgerFolders = stored === undefined ? scanned : stored.flatMap((entry) => (entry.status === 'active' ? [path.dirname(path.dirname(entry.path))] : []));
  const plainFolders = ledgerFolders.filter((folder) => mainOfTaskWorktree(folder) === undefined && mainCheckout(folder) === undefined);
  const tasks = [...findTasks(store, mains), ...plainFolders.flatMap((folder) => folderTask(folder) ?? [])];
  const unreadable = (stored ?? []).filter((entry) => {
    const main = entryMain(entry);
    return entry.status === 'active' && main !== undefined && mainCheckout(main) === undefined && !tasks.some(({ file }) => file === entry.path);
  });
  const entries = [...tasks.map((task) => toEntry(task, stored?.find(sameLedger(task)))), ...unreadable].sort((a, b) => b.updated.localeCompare(a.updated));
  return { tasks, text: `${JSON.stringify(entries, null, 2)}\n` };
}

/**
 * Every task on disk, with the registry brought in line with it. The registry only tells which repos to look in; when it
 * is missing or unreadable, the repos under the scan roots stand in. `extraMains` are repos the caller knows about.
 * Disk wins only where git can read it: the active entries of a repo that is gone or on a disk that is not connected
 * are kept as stored. A ledger at <folder>/.claude/ledger.md in no git repository is read from disk all the same.
 */
export function loadTasks(context: Context, extraMains: string[]): Task[] {
  let read = context.store.registry.read();
  for (let tries = 1; ; tries++) {
    const found = rebuild(context, extraMains, read);
    if (found.text === read) return found.tasks;
    pauseForTest();
    // A rebuild runs git and may take seconds, so it never runs while the registry is held: other commands would wait
    // for each other's rebuilds. A command that wrote since the read may have added a task this rebuild missed, so the
    // write happens only while the registry is still the text that was read; otherwise the rebuild starts over.
    let current: string | undefined;
    context.store.registry.update((now) => {
      current = now;
      return now === read ? found.text : undefined;
    });
    if (current === read || current === found.text) return found.tasks;
    if (tries === REBUILD_TRIES) fail(`Other ledger commands changed the task registry ${tries} times while this one read it, so it gave up. Try again.`);
    read = current;
  }
}
