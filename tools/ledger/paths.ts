import { realpathSync } from 'node:fs';
import path from 'node:path';

/** The folders the ledger system uses under one HOME. Where the store keeps its ledgers is the store's own business. */
export function ledgerPaths(home: string) {
  return {
    home,
    /** Where a rebuild looks for repos when the registry cannot name them. */
    scanRoots: [path.join(home, 'repos'), path.join(home, 'issues')],
    /** Where Xcode keeps its build folders; bin/cc-dd-path puts a worktree's there too. */
    derivedData: path.join(home, 'Library', 'Developer', 'Xcode', 'DerivedData'),
    /** The path as a person reads it, with HOME as ~. */
    tilde: (file: string): string => (file === home || file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file),
  };
}

export type LedgerPaths = ReturnType<typeof ledgerPaths>;

/** Backlog and archive folders are named after the main checkout's folder, so same-named repos share them. */
export const repoName = (main: string): string => path.basename(main);

export const worktreeLedger = (worktree: string): string => path.join(worktree, '.claude', 'ledger.md');

export const taskWorktree = (main: string, folder: string): string => path.join(main, '.claude', 'worktrees', folder);

/** `<YYYY-MM-DD>-<slug>`, an archive name; the slug part may carry a `-N` that told two copies of one day apart. */
export function parseArchiveName(name: string): { date: string; slug: string } | undefined {
  const [, date, slug] = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(name) ?? [];
  return date === undefined ? undefined : { date, slug };
}

/** The main checkout of a worktree at <main>/.claude/worktrees/<folder>. */
export function mainOfTaskWorktree(worktree: string): string | undefined {
  const worktrees = path.dirname(worktree);
  const claude = path.dirname(worktrees);
  return path.basename(worktrees) === 'worktrees' && path.basename(claude) === '.claude' ? path.dirname(claude) : undefined;
}

/** A ledger may name a folder through a symbolic link or with a trailing slash, and the folder may be gone. */
export function samePath(a: string, b: string): boolean {
  const real = (file: string): string => {
    try {
      return realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  };
  return a === b || real(a) === real(b);
}
