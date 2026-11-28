import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { aliasMoves, checkCommitted, cloneEnv, cloneGit, clonePaths, commitChanges, hiddenMoveRemovals, LABELS, otherOwner, recordProblem, removeLegacyCopies, repairHook, setUpClone, shownPaths, SyncProblem, uncommittedMoves, upgradeFormat, withCloneLock } from './clone.js';
import { fail, Failure } from './failure.js';
import { fileStoreAt, keptCreated } from './file-store.js';
import { folderEntries } from './files.js';
import { ledgerBin, type LedgerPaths } from './paths.js';
import { ownHosts, validHost } from './settings.js';
import { parseRecord, recordJson } from './record.js';
import { runConsole, runEnv } from './run-io.js';
import type { Backlog, LedgerCollection, LedgerStore, WrittenLedger } from './store.js';

export type GitStoreOptions = {
  /** Start `ledger store sync --quiet` after a command that wrote, so the push never makes the command wait. */
  backgroundSync: boolean;
  /** For a dry run, which only reads: opening leaves the pre-push hook as it is, and closing commits and pushes nothing. */
  readOnly?: boolean;
};

let backgroundSyncStarted: ((pid: number) => void) | undefined;

/** For tests only: told the pid of each background sync this process starts, so a test can stop it. A module the tests preload calls it. */
export function onBackgroundSyncForTests(started: (pid: number) => void): void {
  backgroundSyncStarted = started;
}

/** Pushes in a process of its own that outlives this command. LEDGER_TEST_NO_BACKGROUND_SYNC lets a test sync when it chooses. */
function startBackgroundSync(paths: LedgerPaths): void {
  if (runEnv().LEDGER_TEST_NO_BACKGROUND_SYNC) return;
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
 * old task list in ~/.claude/ledgers-git.json and the repo aliases in ~/.claude/ledger-aliases-git.json, none of which is
 * pushed. Each write holds the clone lock, so a sync never rebases a file a command is changing. Opening it puts back a
 * pre-push hook that changed. `commit` commits what the store wrote; `close` does so too, once, and starts the push
 * while the clone has commits the remote lacks.
 */
export function gitStore(paths: LedgerPaths, { backgroundSync, readOnly = false }: GitStoreOptions = { backgroundSync: true }): LedgerStore {
  const clone = setUpClone(paths);
  if (!readOnly) repairHook(clone);
  const { evidence, registry, aliases } = clonePaths(paths);
  const files = fileStoreAt({ backlog: path.join(clone, 'backlog'), active: path.join(clone, 'active'), archive: path.join(clone, 'archive'), evidence, registry, aliases, labels: path.join(clone, LABELS) });
  /** The clone paths of the record of a ledger and of the Markdown it replaces, both of which a write changes. */
  const ledgerFiles = (collection: WrittenLedger['place'], repo: string, name: string): string[] => {
    const record = path.relative(clone, files[collection].location(repo, name)).replace(/\.(md|json)$/, '');
    return collection === 'active' ? [`${record}.json`] : [`${record}.json`, `${record}.md`];
  };
  let wrote = false;
  let committed = false;
  /** The clone paths of the ledgers this store wrote since its last commit. */
  const written = new Set<string>();
  const host = validHost(paths.home);
  const hosts = ownHosts(paths.home);
  /** Commits what this store wrote, and checks HEAD holds it as written, each of `texts` with its text. Call it under the clone lock. */
  const commitWritten = (texts: ReadonlyMap<string, string> = new Map(), pending?: ReadonlySet<string>): void => {
    const made = commitChanges(clone, { host, ownHosts: hosts, own: written, pending });
    checkCommitted(clone, [...written], texts);
    if (made) committed = true;
    wrote = false;
    written.clear();
  };
  /** Fails when the collection folder or a repo folder in it is a symbolic link: a write through it could land anywhere. */
  const checkFolders = (collection: WrittenLedger['place'], repos: string[]): void => {
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
      collection: WrittenLedger['place'],
      write: (...args: A) => R,
      changed: (result: R) => boolean = () => true,
      repos: (args: A) => string[] = ([repo]) => [repo],
    ) =>
    (...args: A): R =>
      withCloneLock(clone, () => {
        const touched = repos(args);
        checkFolders(collection, touched);
        // Before the first write, so no active record is committed to a clone an older ledger would still read.
        if (upgradeFormat(clone)) committed = true;
        if (removeLegacyCopies(clone)) wrote = true;
        const note = (): void => {
          wrote = true;
          for (const repo of touched) for (const file of ledgerFiles(collection, repo, args[1])) written.add(file);
        };
        try {
          const result = write(...args);
          if (!changed(result)) return result;
          note();
          // A sync puts a change of another machine's record back as HEAD has it, so one between this write and its
          // commit would undo it. Committed now, under this lock, it is in HEAD before any sync can look. A commit
          // that fails leaves it to the next one, which says why.
          if (collection === 'active' && touched.some((repo) => otherOwner(clone, ledgerFiles(collection, repo, args[1])[0], { host, ownHosts: hosts }) !== undefined)) {
            try {
              commitWritten();
            } catch (error) {
              if (!(error instanceof Failure)) throw error;
            }
          }
          return result;
        } catch (error) {
          // A write that failed halfway may have changed a file all the same.
          note();
          throw error;
        }
      });
  const fromAndTo = ([repo, , to]: [string, string, string]): string[] => [repo, to];
  const toRecordOf =
    (collection: LedgerCollection) =>
    (repo: string, name: string): boolean =>
      collection.toRecord?.(repo, name) ?? false;
  /** The clone path of the record of a ledger written as `text`, and what the store keeps there, its created time too. */
  const keptRecord = ({ place, repo, name, text }: WrittenLedger): [string, string] => {
    const file = ledgerFiles(place, repo, name)[0];
    return [file, recordJson(parseRecord(text), keptCreated(path.join(clone, file)))];
  };
  const commit = (expected: WrittenLedger[] = []): void => {
    if (!wrote && expected.length === 0) return;
    const texts = new Map(expected.map(keptRecord));
    withCloneLock(clone, () => commitWritten(texts));
  };
  const writable = (place: 'backlog' | 'active'): Backlog => ({
    ...files[place],
    write: locked(place, files[place].write),
    create: locked(place, files[place].create, (created) => created),
    update: locked(place, files[place].update, (updated) => updated),
    remove: locked(place, files[place].remove, (removed) => removed),
    move: locked(place, files[place].move, (moved) => moved, fromAndTo),
  });
  // A folder that holds folders and no record is a host folder of the copies of worktree ledgers from before active
  // records, not a repo; a repo folder may hold a folder someone put there.
  const isRepoFolder = (repo: string): boolean => {
    const entries = folderEntries(files.active.repoLocation(repo));
    return entries.some((entry) => entry.isFile() && entry.name.endsWith('.json')) || !entries.some((entry) => entry.isDirectory());
  };
  const writeLabels = (write: () => void): void =>
    withCloneLock(clone, () => {
      const folder = path.join(clone, LABELS);
      if (lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink()) fail(`${folder} is a symbolic link, so git storage writes no label colour through it. Replace it with a folder.`);
      write();
      wrote = true;
    });
  return {
    host,
    ownHosts: hosts,
    backlog: { ...writable('backlog'), toRecord: locked('backlog', toRecordOf(files.backlog), (converted) => converted) },
    active: { ...writable('active'), repos: () => files.active.repos().filter(isRepoFolder), byWorktree: files.active.byWorktree },
    archive: {
      ...files.archive,
      write: locked('archive', files.archive.write),
      remove: locked('archive', files.archive.remove, (removed) => removed),
      move: locked('archive', files.archive.move, (moved) => moved, fromAndTo),
      toRecord: locked('archive', toRecordOf(files.archive), (converted) => converted),
    },
    oldTaskList: files.oldTaskList,
    aliases: files.aliases,
    labels: {
      read: files.labels.read,
      register: (labels, firstUsed) => writeLabels(() => files.labels.register(labels, firstUsed)),
      copy: (entries) => writeLabels(() => files.labels.copy(entries)),
    },
    sharesFolder: files.sharesFolder,
    commit,
    commitPending: (from, to) =>
      withCloneLock(clone, () => {
        // A run that stopped can leave the move committed under `to` and its removal under `from` hidden, so nothing is left to commit.
        const moves = aliasMoves(clone);
        const repairing = moves.filter(({ old, key }) => old === from && key === to);
        const hidden = hiddenMoveRemovals(clone, repairing);
        if (hidden.length > 0) throw new SyncProblem('git', `An index flag hides the removal of ${shownPaths(hidden)} in ${clone}.`);
        for (const file of uncommittedMoves(repairing)) written.add(file);
        commitWritten(undefined, uncommittedMoves(moves));
      }),
    close: () => {
      if (readOnly) return;
      try {
        commit();
      } catch (error) {
        // The ledgers are written; only the commit is missing, and the next command or sync commits it.
        const problem = error instanceof SyncProblem ? error : new SyncProblem('git', `Could not commit in ${paths.tilde(clone)}: ${(error as Error).message}`);
        recordProblem(paths, problem);
        runConsole().error(`warning: the change is written but not committed. ${problem.message.split('\n')[0]}`);
        return;
      }
      if (backgroundSync && (committed || hasUnpushed(clone))) startBackgroundSync(paths);
    },
  };
}
