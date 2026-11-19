import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { checkCommitted, cloneEnv, cloneGit, clonePaths, commitChanges, recordProblem, repairHook, setUpClone, SyncProblem, withCloneLock } from './clone.js';
import { fail } from './failure.js';
import { fileStoreAt } from './file-store.js';
import { ledgerBin, type LedgerPaths } from './paths.js';
import type { LedgerStore, WrittenLedger } from './store.js';

export type GitStoreOptions = {
  /** Start `ledger store sync --quiet` after a command that wrote, so the push never makes the command wait. */
  backgroundSync: boolean;
};

let backgroundSyncStarted: ((pid: number) => void) | undefined;

/** For tests only: told the pid of each background sync this process starts, so a test can stop it. A module the tests preload calls it. */
export function onBackgroundSyncForTests(started: (pid: number) => void): void {
  backgroundSyncStarted = started;
}

/** Pushes in a process of its own that outlives this command. LEDGER_TEST_NO_BACKGROUND_SYNC lets a test sync when it chooses. */
function startBackgroundSync(paths: LedgerPaths): void {
  if (process.env.LEDGER_TEST_NO_BACKGROUND_SYNC) return;
  const child = spawn(process.execPath, [ledgerBin, 'store', 'sync', '--quiet'], { cwd: paths.home, detached: true, stdio: 'ignore', env: { ...cloneEnv(), HOME: paths.home } });
  child.on('error', () => {});
  child.unref();
  if (child.pid !== undefined) backgroundSyncStarted?.(child.pid);
}

/**
 * Whether HEAD has commits that origin's branch of its name lacks, as after a push that failed: what a sync pushes there.
 * Another branch of origin that has them does not count, as the ledgers of other machines are on that one branch. A
 * count that fails counts as unpushed, so a push is never left out.
 */
function hasUnpushed(clone: string): boolean {
  const branch = cloneGit(clone, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim();
  const counted = cloneGit(clone, ['rev-list', '--count', '--ignore-missing', 'HEAD', '--not', `refs/remotes/origin/${branch}`]);
  return !counted.ok || Number(counted.stdout.trim()) > 0;
}

/** Fails when the collection folder or the repo folder in it is a symbolic link: a write through it could land anywhere. */
function checkFolders(clone: string, collection: 'backlog' | 'archive', repo: string): void {
  for (const folder of [path.join(clone, collection), path.join(clone, collection, repo)]) {
    if (lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink()) fail(`${folder} is a symbolic link, so git storage writes nothing through it. Replace it with a folder.`);
  }
}

/**
 * The ledger store as files in the clone ~/.claude/ledger-data, with the evidence in ~/.claude/ledger-evidence and the
 * registry in ~/.claude/ledgers-git.json, neither of which is pushed. Each write holds the clone lock, so a sync never
 * rebases a file a command is changing. Opening it puts back a pre-push hook that changed. `commit` commits what the
 * store wrote; `close` does so too, once, and starts the push while the clone has commits the remote lacks.
 */
export function gitStore(paths: LedgerPaths, { backgroundSync }: GitStoreOptions = { backgroundSync: true }): LedgerStore {
  const clone = setUpClone(paths);
  repairHook(clone);
  const { evidence, registry } = clonePaths(paths);
  const files = fileStoreAt({ backlog: path.join(clone, 'backlog'), archive: path.join(clone, 'archive'), evidence, registry });
  let wrote = false;
  let committed = false;
  /** The clone paths of the ledgers this store wrote since its last commit. */
  const written = new Set<string>();
  /** `write` of `collection` under the clone lock; a result that `changed` says left the clone as it was needs no commit. */
  const locked =
    <A extends [string, string, ...unknown[]], R>(collection: 'backlog' | 'archive', write: (...args: A) => R, changed: (result: R) => boolean = () => true) =>
    (...args: A): R =>
      withCloneLock(clone, () => {
        checkFolders(clone, collection, args[0]);
        const file = path.relative(clone, files[collection].location(args[0], args[1]));
        try {
          const result = write(...args);
          if (changed(result)) {
            wrote = true;
            written.add(file);
          }
          return result;
        } catch (error) {
          // A write that failed halfway may have changed a file all the same.
          wrote = true;
          written.add(file);
          throw error;
        }
      });
  const commit = (expected: WrittenLedger[] = []): void => {
    if (!wrote && expected.length === 0) return;
    const texts = new Map(expected.map(({ place, repo, name, text }) => [path.relative(clone, files[place].location(repo, name)), text]));
    const made = withCloneLock(clone, () => {
      const made = commitChanges(clone);
      checkCommitted(clone, [...written], texts);
      return made;
    });
    if (made) committed = true;
    wrote = false;
    written.clear();
  };
  return {
    backlog: {
      ...files.backlog,
      write: locked('backlog', files.backlog.write),
      create: locked('backlog', files.backlog.create, (created) => created),
      update: locked('backlog', files.backlog.update, (updated) => updated),
      remove: locked('backlog', files.backlog.remove, (removed) => removed),
    },
    archive: { ...files.archive, write: locked('archive', files.archive.write), remove: locked('archive', files.archive.remove, (removed) => removed) },
    registry: files.registry,
    commit,
    close: () => {
      try {
        commit();
      } catch (error) {
        // The ledgers are written; only the commit is missing, and the next command or sync commits it.
        const problem = error instanceof SyncProblem ? error : new SyncProblem('git', `Could not commit in ${paths.tilde(clone)}: ${(error as Error).message}`);
        recordProblem(paths, problem);
        console.error(`warning: the change is written but not committed. ${problem.message.split('\n')[0]}`);
        return;
      }
      if (backgroundSync && (committed || hasUnpushed(clone))) startBackgroundSync(paths);
    },
  };
}
