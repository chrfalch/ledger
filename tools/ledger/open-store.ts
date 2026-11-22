import { fileStore } from './file-store.js';
import { exists } from './files.js';
import { gitStore } from './git-store.js';
import type { LedgerPaths } from './paths.js';
import type { Storage } from './settings.js';
import { sqliteFile, sqliteStore } from './sqlite-store.js';
import type { LedgerStore } from './store.js';

/**
 * The store of `storage`. Git storage pushes after each command in the background unless `backgroundSync` is false.
 * `readOnly` is for a dry run, which only reads: SQLite storage opens a database that must be there as it is, and git
 * storage puts back no pre-push hook and commits and pushes nothing.
 */
export function openStore(paths: LedgerPaths, storage: Storage, { backgroundSync = true, readOnly = false }: { backgroundSync?: boolean; readOnly?: boolean } = {}): LedgerStore {
  switch (storage) {
    case 'file':
      return fileStore(paths);
    case 'sqlite':
      return sqliteStore(paths, { readOnly });
    case 'git':
      return gitStore(paths, { backgroundSync, readOnly });
  }
}

/** The store of `storage` opened `readOnly`; undefined while it holds nothing yet, as SQLite storage before its database exists. */
export const openToRead = (paths: LedgerPaths, storage: Storage): LedgerStore | undefined =>
  storage === 'sqlite' && !exists(sqliteFile(paths.home)) ? undefined : openStore(paths, storage, { readOnly: true });
