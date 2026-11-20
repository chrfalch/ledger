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

/**
 * The ledger store as files in the clone ~/.claude/ledger-data, with the evidence in ~/.claude/ledger-evidence, the
 * registry in ~/.claude/ledgers-git.json and the repo aliases in ~/.claude/ledger-aliases-git.json, none of which is
 * pushed. Each write holds the clone lock, so a sync never rebases a file a command is changing. Opening it puts back a
 * pre-push hook that changed. `commit` commits what the store wrote; `close` does so too, once, and starts the push
 * while the clone has commits the remote lacks.
 */
export function gitStore(paths: LedgerPaths, { backgroundSync }: GitStoreOptions = { backgroundSync: true }): LedgerStore {
  const clone = setUpClone(paths);
  repairHook(clone);
  const { evidence, registry, aliases } = clonePaths(paths);
  const files = fileStoreAt({ backlog: path.join(clone, 'backlog'), archive: path.join(clone, 'archive'), evidence, registry, aliases });
  let wrote = false;
  let committed = false;
  /** The clone paths of the ledgers this store wrote since its last commit. */
  const written = new Set<string>();
  /** Fails when the collection folder or a repo folder in it is a symbolic link: a write through it could land anywhere. */
  const checkFolders = (collection: 'backlog' | 'archive', repos: string[]): void => {
    for (const folder of [path.join(clone, collection), ...repos.map((repo) => files[collection].repoLocation(repo))]) {
      if (lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink()) fail(`${folder} is a symbolic link, so git storage writes nothing through it. Replace it with a folder.`);
    }
  };
  /**
   * `write` of `collection` under the clone lock; a result that `changed` says left the clone as it was needs no commit.
   * It writes the ledger its first two arguments name in each repo `repos` gives, which a move gives two of.
   */
  const locked =
    <A extends [string, string, ...unknown[]], R>(
      collection: 'backlog' | 'archive',
      write: (...args: A) => R,
      changed: (result: R) => boolean = () => true,
      repos: (args: A) => string[] = ([repo]) => [repo],
    ) =>
    (...args: A): R =>
      withCloneLock(clone, () => {
        const touched = repos(args);
        checkFolders(collection, touched);
        const note = (): void => {
          wrote = true;
          for (const repo of touched) written.add(path.relative(clone, files[collection].location(repo, args[1])));
        };
        try {
          const result = write(...args);
          if (changed(result)) note();
          return result;
        } catch (error) {
          // A write that failed halfway may have changed a file all the same.
          note();
          throw error;
        }
      });
  const fromAndTo = ([repo, , to]: [string, string, string]): string[] => [repo, to];
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
      move: locked('backlog', files.backlog.move, (moved) => moved, fromAndTo),
    },
    archive: {
      ...files.archive,
      write: locked('archive', files.archive.write),
      remove: locked('archive', files.archive.remove, (removed) => removed),
      move: locked('archive', files.archive.move, (moved) => moved, fromAndTo),
    },
    registry: files.registry,
    aliases: files.aliases,
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
