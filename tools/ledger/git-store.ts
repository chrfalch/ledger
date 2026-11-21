import { spawn } from 'node:child_process';
import { lstatSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  changedFiles,
  checkCommitted,
  checkFinished,
  cloneEnv,
  cloneGit,
  clonePaths,
  commitChanges,
  heldBack,
  heldInProcessFor,
  holdBack,
  inHead,
  isHeld,
  recordProblem,
  releaseHeldBack,
  repairHook,
  setUpClone,
  shownPaths,
  SyncProblem,
  withCloneLock,
} from './clone.js';
import { fail } from './failure.js';
import { fileStoreAt, keptCreated, markdownCollection } from './file-store.js';
import { folderEntries, isFolder, isTaken, readTimedText, writeAtomic } from './files.js';
import { ledgerBin, type LedgerPaths } from './paths.js';
import { parseRecord, recordJson } from './record.js';
import { readHost, validHost } from './settings.js';
import { byCodeUnit, type Archive, type LedgerCollection, type LedgerStore, type RemovedCopy, type WrittenLedger } from './store.js';

export type GitStoreOptions = {
  /** Start `ledger store sync --quiet` after a command that wrote, so the push never makes the command wait. */
  backgroundSync: boolean;
  /** For a dry run, which only reads: opening leaves the pre-push hook as it is, and closing commits and pushes nothing. */
  readOnly?: boolean;
  /** Print no warning, as for `ledger store mirror --quiet`. */
  quiet?: boolean;
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

/** Where a write of git storage lands: the clone folders that must be no symbolic link, and the clone paths it changes. */
type Place = { folders: (repos: string[]) => string[]; files: (repo: string, name: string) => string[] };

/**
 * The ledger store as files in the clone ~/.claude/ledger-data, the active copies as active/<host>/<repo>/<slug>.md
 * there, with the evidence in ~/.claude/ledger-evidence, the registry in ~/.claude/ledgers-git.json and the repo aliases
 * in ~/.claude/ledger-aliases-git.json, none of which is pushed. Each write holds the clone lock, so a sync never
 * rebases a file a command is changing. Opening it puts back a pre-push hook that changed. `commit` commits what the
 * store wrote; `close` does so too, once, and starts the push while the clone has commits the remote lacks.
 */
export function gitStore(paths: LedgerPaths, { backgroundSync, readOnly = false, quiet = false }: GitStoreOptions = { backgroundSync: true }): LedgerStore {
  const clone = setUpClone(paths);
  if (!readOnly) repairHook(clone);
  const { evidence, registry, aliases } = clonePaths(paths);
  const files = fileStoreAt({ backlog: path.join(clone, 'backlog'), archive: path.join(clone, 'archive'), evidence, registry, aliases });
  /** The clone paths of the record of a ledger and of the Markdown it replaces, both of which a write changes. */
  const ledgerFiles = (collection: 'backlog' | 'archive', repo: string, name: string): string[] => {
    const record = path.relative(clone, files[collection].location(repo, name)).replace(/\.(md|json)$/, '');
    return [`${record}.json`, `${record}.md`];
  };
  let wrote = false;
  let committed = false;
  /** The clone paths of the ledgers this store wrote since its last commit. */
  const written = new Set<string>();
  const heldHere = heldInProcessFor(clone);
  let host: string | undefined;
  // Read on first use, so a "host" setting that is no label fails only what reaches this machine's copies.
  const ownHost = (): string => (host ??= readHost(paths.home));
  const validOwnHost = (): string | undefined => (host ??= validHost(paths.home));
  const activeRoot = path.join(clone, 'active');
  const copiesOf = (host: string): LedgerCollection => markdownCollection(path.join(activeRoot, host));
  const warn = (text: string): void => {
    if (!quiet) console.error(`warning: ${text}`);
  };
  const ledgerPlace = (collection: 'backlog' | 'archive'): Place => ({
    folders: (repos) => [path.join(clone, collection), ...repos.map((repo) => files[collection].repoLocation(repo))],
    files: (repo, name) => ledgerFiles(collection, repo, name),
  });
  const copyPlace = (own: LedgerCollection): Place => ({
    folders: (repos) => [activeRoot, own.repoLocation(), ...repos.map((repo) => own.repoLocation(repo))],
    files: (repo, name) => [path.relative(clone, own.location(repo, name))],
  });
  /**
   * `write` to `place` under the clone lock; a result that `changed` says left the clone as it was needs no commit. It
   * writes the ledger its first two arguments name in each repo `repos` gives, which a move gives two of. A folder of
   * `place` that is a symbolic link fails it: a write through it could land anywhere.
   */
  const locked =
    <A extends [string, string, ...unknown[]], R>(
      place: Place,
      write: (...args: A) => R,
      changed: (result: R) => boolean = () => true,
      repos: (args: A) => string[] = ([repo]) => [repo],
    ) =>
    (...args: A): R =>
      withCloneLock(clone, () => {
        const touched = repos(args);
        for (const folder of place.folders(touched)) {
          if (lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink()) fail(`${folder} is a symbolic link, so git storage writes nothing through it. Replace it with a folder.`);
        }
        const note = (): void => {
          wrote = true;
          for (const repo of touched) for (const file of place.files(repo, args[1])) written.add(file);
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
    const made = withCloneLock(clone, () => {
      const made = commitChanges(clone, { host: validOwnHost(), warn, held: heldHere });
      checkCommitted(clone, [...written], texts);
      return made;
    });
    if (made) committed = true;
    wrote = false;
    written.clear();
  };
  /**
   * While a reconcile runs: each copy file it changes, with its text before, undefined for one it adds; and the clone
   * paths of the copies it wrote, found as written or removed.
   */
  let reconciling: { previous: Map<string, string | undefined>; settled: Set<string> } | undefined;
  /** The text of this machine's copy; undefined for none. One that is there but cannot be read fails, so it is never taken for none. */
  const readCopy = (own: LedgerCollection, repo: string, slug: string): string | undefined => {
    const file = own.location(repo, slug);
    if (!isTaken(file)) return undefined;
    return readTimedText(file)?.text ?? fail(`${file} cannot be read as a plain file, so git storage leaves it as it is.`);
  };
  /**
   * Holds back the copies `files`, clone paths, so no commit takes them, nor checks that one did. When the held-back
   * list cannot be written, only the commits of this process leave them out, and this fails, after `cause` when given.
   */
  const hold = (files: string[], cause?: string): void => {
    for (const file of files) written.delete(file);
    try {
      holdBack(clone, files);
    } catch (error) {
      for (const file of files) heldHere.add(file);
      const unrecorded = `Could not record that git storage holds back ${shownPaths(files)}: ${(error as Error).message}. Only this command leaves them out of its commits, so run ledger store mirror before the next sync.`;
      fail(cause === undefined ? unrecorded : `${cause}\n${unrecorded}`);
    }
  };
  const release = (files: string[]): void => {
    releaseHeldBack(clone, files);
    for (const file of files) heldHere.delete(file);
  };
  /** RemovedCopy.putBack of the copy `file`, which held `text`; `wasHeld` when it was held back before. */
  const putBackRemoved = (file: string, text: string | undefined, wasHeld: boolean): void =>
    withCloneLock(clone, () => {
      const relative = path.relative(clone, file);
      try {
        if (text !== undefined) writeAtomic(file, text);
      } catch (error) {
        hold([relative], (error as Error).message);
        throw error;
      }
      if (wasHeld) hold([relative]);
    });
  /** Puts each copy of `texts` back as it was; the clone paths of those it could not. Without git, which a lock of its own may stop. */
  const putBack = (texts: Map<string, string | undefined>): string[] =>
    [...texts].flatMap(([file, text]) => {
      try {
        if (text === undefined) rmSync(file, { force: true });
        else if (readTimedText(file)?.text !== text) writeAtomic(file, text);
        return [];
      } catch {
        return [path.relative(clone, file)];
      }
    });
  /**
   * `change` of this machine's copy, under the clone lock; its host folder is read only when the change runs. A result
   * that `changed` says left the copy as it was needs no commit.
   */
  const ownCopy =
    <A extends [string, string, ...unknown[]], R>(change: (own: LedgerCollection, ...args: A) => R, changed: (result: R) => boolean) =>
    (...args: A): R => {
      const own = copiesOf(ownHost());
      const recorded = (...given: A): R => {
        const file = own.location(given[0], given[1]);
        const run = reconciling;
        if (run !== undefined && !run.previous.has(file)) run.previous.set(file, readCopy(own, given[0], given[1]));
        const result = change(own, ...given);
        run?.settled.add(path.relative(clone, file));
        return result;
      };
      return locked(copyPlace(own), recorded, changed)(...args);
    };
  const backlogPlace = ledgerPlace('backlog');
  const archivePlace = ledgerPlace('archive');
  return {
    backlog: {
      ...files.backlog,
      write: locked(backlogPlace, files.backlog.write),
      create: locked(backlogPlace, files.backlog.create, (created) => created),
      update: locked(backlogPlace, files.backlog.update, (updated) => updated),
      remove: locked(backlogPlace, files.backlog.remove, (removed) => removed),
      move: locked(backlogPlace, files.backlog.move, (moved) => moved, fromAndTo),
      toRecord: locked(backlogPlace, toRecordOf(files.backlog), (converted) => converted),
    },
    archive: {
      ...files.archive,
      write: (...args: Parameters<Archive['write']>): void => {
        locked(archivePlace, files.archive.write)(...args);
        // A hold that an earlier failed retire left on this path is spent: the copy is this write's, to commit with the removal of the active copy.
        heldHere.delete(path.relative(clone, files.archive.location(args[0], args[1])));
      },
      remove: (...args: Parameters<Archive['remove']>): boolean => {
        try {
          return locked(archivePlace, files.archive.remove, (removed) => removed)(...args);
        } catch (error) {
          // What is left of the copy, such as one a failed retire could not take back, is not this store's to commit.
          const file = path.relative(clone, files.archive.location(args[0], args[1]));
          heldHere.add(file);
          written.delete(file);
          throw error;
        }
      },
      move: locked(archivePlace, files.archive.move, (moved) => moved, fromAndTo),
      toRecord: locked(archivePlace, toRecordOf(files.archive), (converted) => converted),
    },
    registry: files.registry,
    aliases: files.aliases,
    active: {
      get host() {
        return validOwnHost();
      },
      hosts: () =>
        folderEntries(activeRoot)
          .map(({ name }) => name)
          .filter((name) => isFolder(path.join(activeRoot, name)))
          .sort(byCodeUnit),
      copiesOf,
      write: ownCopy(
        (own, repo: string, slug: string, text: string) => {
          if (readCopy(own, repo, slug) === text) return false;
          writeAtomic(own.location(repo, slug), text);
          return true;
        },
        (written) => written,
      ),
      remove: ownCopy(
        (own, repo: string, slug: string): RemovedCopy | undefined => {
          const text = readCopy(own, repo, slug);
          const file = own.location(repo, slug);
          const relative = path.relative(clone, file);
          const wasHeld = heldHere.has(relative) || isHeld(heldBack(clone), relative);
          // A held removal, as a retire that could not put the copy back leaves, is still to commit.
          if (text === undefined && !(wasHeld && inHead(clone, relative))) return undefined;
          if (text !== undefined) rmSync(file);
          // A reconcile settles its copies once it went through; anyone else, a retire, decided this removal at once.
          if (wasHeld && reconciling === undefined) {
            try {
              release([relative]);
            } catch (error) {
              if (text !== undefined) writeAtomic(file, text);
              throw error;
            }
          }
          return { putBack: () => putBackRemoved(file, text, wasHeld) };
        },
        (removed) => removed !== undefined,
      ),
      reconcile: <T>(work: (host: string) => T): T =>
        withCloneLock(clone, () => {
          const own = ownHost();
          // Before any write: a copy written into a merge would be committed as its resolution.
          checkFinished(clone);
          const [pending, wroteBefore] = [new Set(written), wrote];
          const run = { previous: new Map<string, string | undefined>(), settled: new Set<string>() };
          reconciling = run;
          let result: T;
          try {
            result = work(own);
          } catch (error) {
            const stuck = putBack(run.previous);
            for (const file of [...written]) if (!pending.has(file) && file.startsWith(`active/${own}/`)) written.delete(file);
            // What was to commit before, such as a copy whose listing failed in an earlier reconcile, still is.
            wrote = wroteBefore || written.size > 0;
            if (stuck.length === 0) throw error;
            const notPutBack = `${(error as Error).message}\nCould not put back the copies ${shownPaths(stuck)} as they were, so git storage commits none of them until a mirror goes through. Fix the cause, then run ledger store mirror, which copies each worktree ledger again.`;
            hold(stuck, notPutBack);
            return fail(notPutBack);
          } finally {
            reconciling = undefined;
          }
          let changed: string[];
          try {
            changed = changedFiles(clone, `active/${own}/`);
          } catch (error) {
            // A copy an earlier commit left out is found only by this listing; close() commits whatever is changed.
            wrote = true;
            throw error;
          }
          release([...run.settled]);
          const held = heldBack(clone);
          for (const file of changed.filter((file) => !isHeld(held, file) && !heldHere.has(file))) {
            wrote = true;
            written.add(file);
          }
          try {
            commit();
          } catch {
            // The copies are written; close() commits them again, and records and reports what fails.
          }
          return result;
        }),
    },
    inOneCommit: <T>(work: () => T): T =>
      withCloneLock(clone, () => {
        const result = work();
        try {
          commit();
        } catch {
          // What work wrote stays written; close() commits it again, and records and reports what fails.
        }
        return result;
      }),
    commit,
    close: () => {
      if (readOnly) return;
      try {
        commit();
      } catch (error) {
        // The ledgers are written; only the commit is missing, and the next command or sync commits it.
        const problem = error instanceof SyncProblem ? error : new SyncProblem('git', `Could not commit in ${paths.tilde(clone)}: ${(error as Error).message}`);
        recordProblem(paths, problem);
        warn(`the change is written but not committed. ${problem.message.split('\n')[0]}`);
        return;
      }
      // A sync in a process of its own cannot see the holds of this one, so it would commit what they keep out.
      if (backgroundSync && heldHere.size === 0 && (committed || hasUnpushed(clone))) startBackgroundSync(paths);
    },
  };
}
