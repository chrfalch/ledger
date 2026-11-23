import { statSync } from 'node:fs';
import path from 'node:path';
import { Failure } from './failure.js';
import { checkoutRoot, inMainCheckout } from './git.js';
import { samePath } from './paths.js';
import type { LedgerStore } from './store.js';

// @ref LLP 0000#the-task-list — why the old task list is read only by the one-time moves.

/** One entry of the task list older versions kept, such as ~/.claude/ledgers.json. */
export type OldTaskListEntry = {
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

const isEntry = (value: unknown): value is OldTaskListEntry =>
  typeof value === 'object' && value !== null && 'path' in value && typeof value.path === 'string' && 'status' in value && typeof value.status === 'string';

/** The entries of the old task list, or undefined when the text is not a JSON array. */
export function parseOldTaskList(text: string): OldTaskListEntry[] | undefined {
  try {
    const entries: unknown = JSON.parse(text);
    return Array.isArray(entries) ? entries.filter(isEntry) : undefined;
  } catch {
    return undefined;
  }
}

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
