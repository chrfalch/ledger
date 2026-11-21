import { statSync } from 'node:fs';
import path from 'node:path';
import { fail, Failure } from './failure.js';
import { checkoutRoot, inMainCheckout } from './git.js';
import { samePath } from './paths.js';
import type { LedgerStore } from './store.js';
import { pauseForTest } from './wait.js';
import { findTasks, type Task } from './tasks.js';

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
  const { parent } = task.ledger.location;
  const archived = task.place === 'archive';
  return {
    repo: task.repo,
    slug: task.slug,
    path: archived ? '' : task.file,
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

type Context = { store: LedgerStore };

const LEGACY_LEDGER = path.join('.claude', 'ledger.md');

/** As bash's [ -f ]: a path that cannot be checked, such as one too long or not readable, is no file. */
function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Whether `folder` still keeps its ledger as a .claude/ledger.md that no active record has replaced. */
export function keepsUnmovedLedger(store: LedgerStore, folder: string): boolean {
  if (!isFile(path.join(folder, LEGACY_LEDGER))) return false;
  try {
    return store.active.byWorktree(folder) === undefined;
  } catch (error) {
    // Two records name the folder: it has moved, and the worktree-removal gate names the clash.
    if (error instanceof Failure) return false;
    throw error;
  }
}

/** Whether `folder` is a linked worktree whose ledger is still a .claude/ledger.md: one that migrate --active moves. */
export function holdsUnmovedLedger(store: LedgerStore, folder: string): boolean {
  if (!keepsUnmovedLedger(store, folder)) return false;
  const root = checkoutRoot(folder);
  return root !== undefined && samePath(root, folder) && !inMainCheckout(folder);
}

/** Whether `entry` names the .claude/ledger.md of a worktree that `ledger store migrate --active` has yet to move. */
const isUnmoved = (store: LedgerStore, { path: file }: RegistryEntry): boolean =>
  file.endsWith(`${path.sep}${LEGACY_LEDGER}`) && holdsUnmovedLedger(store, path.dirname(path.dirname(file)));

/** A try fails only when another command wrote the registry in between, so running out of tries takes 20 such writes. */
const REBUILD_TRIES = 20;

/** The tasks on disk, and the registry text that lists them, read with `current` as the registry. */
function rebuild({ store }: Context, current: string | undefined): { tasks: Task[]; text: string } {
  const stored = current === undefined ? undefined : parseRegistry(current);
  const tasks = findTasks(store);
  const unmoved = (stored ?? []).filter((entry) => isUnmoved(store, entry));
  const entries = [...tasks.map((task) => toEntry(task, stored?.find(sameLedger(task)))), ...unmoved].sort((a, b) => b.updated.localeCompare(a.updated));
  return { tasks, text: `${JSON.stringify(entries, null, 2)}\n` };
}

/**
 * Every task in the store, with the registry brought in line with it: an entry whose ledger the store no longer holds,
 * such as a task retired on another machine, is dropped. An entry of a .claude/ledger.md not yet moved into the store
 * is kept, though it is no task, so that `ledger store migrate --active` still finds it from any repo.
 */
export function loadTasks(context: Context): Task[] {
  let read = context.store.registry.read();
  for (let tries = 1; ; tries++) {
    const found = rebuild(context, read);
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
