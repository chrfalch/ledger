import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The bin/ledger of this checkout, which messages name so a reader can run it without `ledger` on PATH. */
export const ledgerBin = fileURLToPath(new URL('../../bin/ledger', import.meta.url));

/** The folders the ledger system uses under one HOME. Where the store keeps its ledgers is the store's own business. */
export function ledgerPaths(home: string) {
  return {
    home,
    /** The path as a person reads it, with HOME as ~. */
    tilde: (file: string): string => (file === home || file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file),
  };
}

export type LedgerPaths = ReturnType<typeof ledgerPaths>;

export const taskWorktree = (main: string, folder: string): string => path.join(main, '.claude', 'worktrees', folder);

/** `<YYYY-MM-DD>-<slug>`, an archive name; the slug part may carry a `-N` that told two copies of one day apart. */
export function parseArchiveName(name: string): { date: string; slug: string } | undefined {
  const [, date, slug] = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(name) ?? [];
  return date === undefined ? undefined : { date, slug };
}

/** The main checkout of a worktree at <main>/.claude/worktrees/<folder>; a relative path names none, as it would resolve against the cwd. */
export function mainOfTaskWorktree(worktree: string): string | undefined {
  if (!path.isAbsolute(worktree)) return undefined;
  const worktrees = path.dirname(worktree);
  const claude = path.dirname(worktrees);
  return path.basename(worktrees) === 'worktrees' && path.basename(claude) === '.claude' ? path.dirname(claude) : undefined;
}

/** The folder may be gone; then its resolved path stands in. */
export function realPath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** A ledger may name a folder through a symbolic link or with a trailing slash, and the folder may be gone. */
export const samePath = (a: string, b: string): boolean => a === b || realPath(a) === realPath(b);

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/** A path into a Claude Code session folder or its scratchpad, which macOS deletes, so no ledger may cite one. */
export const SESSION_CITATION = new RegExp(`/tmp/claude-[0-9]+/[^/\\s]+/${UUID}|<scratchpad>/\\S|scratchpad/[A-Za-z0-9_.-]`);

/** Why a ledger may not cite a session file, and where to put the file instead. */
export const CITATION_ADVICE =
  "A task ledger may not cite files in the Claude Code session folder or its scratchpad, because macOS deletes them. Move the file to .claude/evidence/ in the task's worktree and cite that path, for example .claude/evidence/xcodebuild-red.log.";
