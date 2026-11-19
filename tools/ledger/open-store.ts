import { fileStore } from './file-store.js';
import { gitStore } from './git-store.js';
import type { LedgerPaths } from './paths.js';
import type { Storage } from './settings.js';
import { sqliteStore } from './sqlite-store.js';
import type { LedgerStore } from './store.js';

/** The store of `storage`. Git storage pushes after each command in the background unless `backgroundSync` is false. */
export function openStore(paths: LedgerPaths, storage: Storage, { backgroundSync = true }: { backgroundSync?: boolean } = {}): LedgerStore {
  switch (storage) {
    case 'file':
      return fileStore(paths);
    case 'sqlite':
      return sqliteStore(paths);
    case 'git':
      return gitStore(paths, { backgroundSync });
  }
}
