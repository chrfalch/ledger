import { cpSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { fail } from './failure.js';
import { createFile, folderEntries, holdsAnything, isEntryName, isFolder, isReadableFile, isTaken, moveAside, putBack, readText, readTimedText, sameTree, treeEntries, writeAtomic } from './files.js';
import { withLock } from './lock.js';
import type { LedgerPaths } from './paths.js';
import { byCodeUnit, checkedAliases, isAsChecked, NameTaken, needsAlias, noteCreated, type Archive, type LedgerCollection, type LedgerStore, type StoredLedger } from './store.js';
import { pauseForTest } from './wait.js';

/**
 * The folder of a repo key: URI-encoded, so a key is one folder. A key without a slash is an old folder-name key, which
 * no D10 key is, and keeps its folder's name as it was, so the conversion finds every such folder; one that would not
 * stay one folder, such as .. or a name with a \, fails.
 */
function folderOf(repo: string): string {
  if (repo.includes('/')) return encodeURIComponent(repo);
  if (!isEntryName(repo) || repo.includes('\0')) fail(`"${repo}" is no repo key, so it names no folder of the store.`);
  return repo;
}

/** A folder that is exactly the encoding of a key with a slash names that key; any other is an old folder-name key. */
function repoOf(folder: string): string {
  try {
    const key = decodeURIComponent(folder);
    return key.includes('/') && encodeURIComponent(key) === folder ? key : folder;
  } catch {
    return folder;
  }
}

/** `name`, which a ledger or its evidence takes in a repo folder, unless it would name another entry or the folder itself. */
const entryName = (name: string): string =>
  isEntryName(name) ? name : fail(`"${name}" cannot name a ledger or its evidence. A name is not empty, not . or .., and holds no / or \\.`);

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** Runs `move` into the repo folder `folder`. A move that throws or moves nothing takes away the folder when it made it. */
function into(folder: string, move: () => boolean): boolean {
  const made = mkdirSync(folder, { recursive: true }) !== undefined;
  let moved = false;
  try {
    moved = move();
  } finally {
    if (made && !moved) {
      try {
        rmdirSync(folder);
      } catch {
        // Not empty: an archive copy moved and its evidence did not, which the next move of that copy finishes.
      }
    }
  }
  return moved;
}

/**
 * After a move, removes the repo folder it left when that is empty, so repos() no longer lists the repo, as with a
 * database. Not inside the move, whose lock file sits in that folder.
 */
function leaving(folder: string, moved: boolean): boolean {
  try {
    if (moved) rmdirSync(folder);
  } catch (error) {
    if (!['ENOTEMPTY', 'EEXIST', 'ENOENT', 'ENOTDIR'].includes(code(error) ?? '')) throw error;
  }
  return moved;
}

/**
 * Ledgers as files <root>/<repo folder>/<name>.md. A ledger is a readable regular file, never a symbolic link; a repo is a
 * folder, through a symbolic link or not. A file such as `...md`, whose name would be `..`, is no ledger.
 */
function collection(root: string): LedgerCollection {
  const repoLocation = (repo?: string): string => (repo === undefined ? root : path.join(root, folderOf(repo)));
  const location = (repo: string, name: string): string => path.join(repoLocation(repo), `${entryName(name)}.md`);
  const read = (repo: string, name: string): StoredLedger | undefined => {
    const file = location(repo, name);
    const found = readTimedText(file);
    return found && { repo, name, location: file, ...found };
  };
  return {
    location,
    repoLocation,
    repos: () =>
      folderEntries(root)
        .map(({ name }) => name)
        .filter((name) => isFolder(path.join(root, name)))
        .map(repoOf)
        .sort(byCodeUnit),
    list: (repo) =>
      folderEntries(repoLocation(repo))
        .map(({ name }) => name)
        .filter((name) => name.endsWith('.md') && isEntryName(name.slice(0, -'.md'.length)))
        .sort(byCodeUnit)
        .flatMap((name) => read(repo, name.slice(0, -'.md'.length)) ?? []),
    read,
    has: (repo, name) => isReadableFile(location(repo, name)),
    setModified: (repo, name, mtimeMs) => {
      const file = location(repo, name);
      const time = new Date(mtimeMs);
      withLock(file, () => utimesSync(file, time, time));
    },
  };
}

/**
 * Where a file store keeps its parts. The evidence of the archive copy `name` of `repo` is the folder
 * <evidence>/<repo folder>/<name>/.
 */
export type FileRoots = { backlog: string; archive: string; evidence: string; registry: string; aliases: string };

/** A move between repo folders is a rename on one disk; `rename` is for tests, to act out a folder on another disk. */
export type FileStoreOptions = { rename?: (from: string, to: string) => void };

/**
 * The ledger store as files under ~/.claude, in the layout the ledger plugin and the old scripts read: evidence sits next
 * to its archive copy.
 */
export function fileStore({ home }: LedgerPaths, options: FileStoreOptions = {}): LedgerStore {
  const claude = path.join(home, '.claude');
  const archive = path.join(claude, 'ledger-archive');
  const roots = { backlog: path.join(claude, 'ledger-backlog'), archive, evidence: archive, registry: path.join(claude, 'ledgers.json'), aliases: path.join(claude, 'ledger-aliases.json') };
  return fileStoreAt(roots, options);
}

/**
 * The ledger store as files under `roots`. A backlog write over a ledger that is a symbolic link replaces the link with
 * a file; the file it pointed to keeps its old text.
 */
export function fileStoreAt(roots: FileRoots, { rename = renameSync }: FileStoreOptions = {}): LedgerStore {
  const backlog = collection(roots.backlog);
  const archive = collection(roots.archive);
  const evidenceRoot = collection(roots.evidence);
  const { registry, aliases } = roots;
  const damaged = `${aliases} is not a JSON object of repo aliases`;
  /** The entries of the alias map, none without one; undefined for a map that cannot be read. */
  const aliasEntries = (): [string, unknown][] | undefined => {
    let text: string;
    try {
      text = readText(aliases);
    } catch (error) {
      return code(error) === 'ENOENT' || code(error) === 'ENOTDIR' ? [] : undefined;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? Object.entries(parsed) : undefined;
    } catch {
      return undefined;
    }
  };
  const readRegistry = (): string | undefined => {
    try {
      return readText(registry);
    } catch {
      return undefined;
    }
  };
  const evidenceOf = (repo: string, name: string): string => path.join(evidenceRoot.repoLocation(repo), entryName(name));
  /** The evidence folder to copy or remove; a symbolic link at it, its repo folder or the evidence root fails, as each leads outside it. */
  const evidenceToChange = (repo: string, name: string): string => {
    const folder = evidenceOf(repo, name);
    for (const part of [roots.evidence, path.dirname(folder), folder]) {
      if (lstatSync(part, { throwIfNoEntry: false })?.isSymbolicLink()) fail(`${part} is a symbolic link, so no evidence is copied or removed through it. Replace it with a folder.`);
    }
    return folder;
  };
  /**
   * What `archive.move` would move: the copy with any evidence, or only the evidence of a copy a move that stopped left
   * in `to`; nothing when anything else is in the way. Anything takes a name, also a link or a case variant of it.
   */
  const archiveMove = (repo: string, name: string, to: string): 'copy' | 'evidence' | undefined => {
    if (isTaken(evidenceOf(to, name))) return undefined;
    if (!isTaken(archive.location(to, name))) return 'copy';
    return !isTaken(archive.location(repo, name)) && isTaken(evidenceOf(repo, name)) ? 'evidence' : undefined;
  };
  const archiveCanMove = (repo: string, name: string, to: string): boolean => {
    const move = archiveMove(repo, name, to);
    return move === 'evidence' || (move === 'copy' && archive.has(repo, name));
  };
  const evidenceFiles = (repo: string, name: string): string[] => {
    const folder = evidenceOf(repo, name);
    // Not through a symbolic link, as with a ledger, so reading evidence never leaves the archive.
    if (!lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) return [];
    return treeEntries(folder)
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(folder, path.join(entry.parentPath, entry.name)))
      .sort(byCodeUnit);
  };
  const evidenceState: Archive['evidenceState'] = (repo, name, from) => {
    const archived = evidenceOf(repo, name);
    try {
      const folder = from !== undefined && holdsAnything(from) ? from : undefined;
      if (!holdsAnything(archived)) return folder === undefined ? 'none' : 'differs';
      return folder !== undefined && sameTree(archived, folder) ? 'same' : 'differs';
    } catch {
      // A folder that cannot be read may hold anything.
      return 'differs';
    }
  };
  /** Runs `work` on a backlog ledger and its text while holding its lock; throws when it does not exist. */
  const withExisting = <T>(repo: string, slug: string, work: (file: string, text: string) => T): T => {
    const file = backlog.location(repo, slug);
    const missing = (): never => fail(`${file} does not exist.`);
    if (!backlog.has(repo, slug)) missing();
    return withLock(file, () => work(file, (backlog.read(repo, slug) ?? missing()).text));
  };
  /** Fails when `root` is a symbolic link, as a new ledger made through it could land anywhere. */
  const checkRoot = (root: string): void => {
    if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) fail(`${root} is a symbolic link, so no ledger is created through it. Replace it with a folder.`);
  };
  return {
    backlog: {
      ...backlog,
      write: (repo, slug, text) => {
        const file = backlog.location(repo, slug);
        withLock(file, () => writeAtomic(file, text));
      },
      create: (repo, slug, text) => {
        checkRoot(roots.backlog);
        return createFile(backlog.location(repo, slug), text);
      },
      update: (repo, slug, change) =>
        withExisting(repo, slug, (file, current) => {
          pauseForTest();
          const text = change(current);
          if (text !== undefined) writeAtomic(file, text);
          return text !== undefined;
        }),
      // Under the lock, so an update that read the ledger before cannot write it back after.
      remove: (repo, slug, expected) =>
        withExisting(repo, slug, (file, current) => {
          if (current !== expected) return false;
          rmSync(file);
          return true;
        }),
      move: (repo, slug, to) =>
        leaving(
          backlog.repoLocation(repo),
          withExisting(repo, slug, (file) => {
            const target = backlog.location(to, slug);
            return !isTaken(target) && into(backlog.repoLocation(to), () => (rename(file, target), true));
          }),
        ),
      canMove: (repo, slug, to) => backlog.has(repo, slug) && !isTaken(backlog.location(to, slug)),
    },
    archive: {
      ...archive,
      write: (repo, name, text, evidenceFrom) => {
        const file = archive.location(repo, name);
        const evidence = evidenceOf(repo, name);
        const refuse = (taken: string): never => {
          throw new NameTaken(`${taken} already exists. An archive copy is never replaced.`);
        };
        checkRoot(roots.archive);
        if (evidenceFrom !== undefined && isTaken(evidence)) refuse(evidence);
        if (evidenceFrom !== undefined) evidenceToChange(repo, name);
        if (!createFile(file, text)) refuse(file);
        noteCreated(file);
        if (evidenceFrom === undefined) return;
        // Verbatim, so a relative link keeps its text; one that stays inside the folder then points into the copy.
        cpSync(evidenceFrom, evidence, { recursive: true, verbatimSymlinks: true });
        if (!sameTree(evidenceFrom, evidence)) fail(`The evidence copy ${evidence}/ differs from ${evidenceFrom}/.`);
      },
      evidenceState,
      nameTaken: (repo, name) => isTaken(archive.location(repo, name)) || isTaken(evidenceOf(repo, name)),
      evidenceLocation: evidenceOf,
      evidenceFiles,
      // Only a listed file, so a path such as ../<name>.md cannot read past the evidence folder.
      readEvidence: (repo, name, file) => (evidenceFiles(repo, name).includes(file) ? readFileSync(path.join(evidenceOf(repo, name), file)) : undefined),
      copyEvidence: (repo, name, to) => {
        const folder = evidenceToChange(repo, name);
        if (lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) cpSync(folder, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
      },
      remove: (repo, name, expected) => {
        const file = archive.location(repo, name);
        return withLock(file, () => {
          const evidence = evidenceToChange(repo, name);
          if (!isTaken(file)) fail(`${file} does not exist.`);
          if (expected !== undefined && !isAsChecked({ read: archive.read, evidenceState }, repo, name, expected)) return false;
          // Checked again once moved aside: an edit made after the check above is put back, one made later is a new file.
          const aside = moveAside(file) ?? fail(`${file} does not exist.`);
          if (expected !== undefined && readText(aside) !== expected.text) {
            putBack(aside, file);
            return false;
          }
          try {
            rmSync(evidence, { recursive: true, force: true });
          } catch (error) {
            putBack(aside, file);
            throw error;
          }
          rmSync(aside);
          return true;
        });
      },
      move: (repo, name, to) => {
        const [file, evidence] = [archive.location(repo, name), evidenceOf(repo, name)];
        const missing = (): never => fail(`${file} does not exist.`);
        if (!isTaken(file) && !isTaken(evidence)) missing();
        const moved = withLock(file, () => {
          const move = archiveMove(repo, name, to);
          if (move !== 'evidence' && !archive.has(repo, name)) missing();
          return (
            move !== undefined &&
            into(archive.repoLocation(to), () => {
              if (move === 'copy') rename(file, archive.location(to, name));
              // The evidence root may be another folder than the archive's, as in git storage.
              return !isTaken(evidence) || into(evidenceRoot.repoLocation(to), () => (rename(evidence, evidenceOf(to, name)), true));
            })
          );
        });
        leaving(evidenceRoot.repoLocation(repo), moved);
        return leaving(archive.repoLocation(repo), moved);
      },
      canMove: archiveCanMove,
      orphanEvidence: () =>
        evidenceRoot.repos().flatMap((repo) =>
          folderEntries(evidenceRoot.repoLocation(repo))
            .filter((entry) => entry.isDirectory() && isEntryName(entry.name) && !isTaken(archive.location(repo, entry.name)))
            .map(({ name }) => ({ repo, name })),
        ),
    },
    registry: {
      read: readRegistry,
      write: (text) => withLock(registry, () => writeAtomic(registry, text)),
      update: (change) =>
        withLock(registry, () => {
          const text = change(readRegistry());
          if (text !== undefined) writeAtomic(registry, text);
        }),
      remove: () => withLock(registry, () => rmSync(registry, { force: true })),
    },
    aliases: {
      read: () => checkedAliases(aliasEntries() ?? []).aliases,
      problem: () => {
        const entries = aliasEntries();
        return entries === undefined ? `${damaged}, so no alias applies. Fix or remove it.` : checkedAliases(entries).problem;
      },
      add: (old, key) =>
        withLock(aliases, () => {
          const current = aliasEntries() ?? fail(`${damaged}, so ${old} was not made an alias of ${key}. Fix or remove it.`);
          if (needsAlias(current, old, key, aliases)) writeAtomic(aliases, `${JSON.stringify(Object.fromEntries([...current, [old, key]]), null, 2)}\n`);
        }),
      remove: (old, key) =>
        withLock(aliases, () => {
          const current = aliasEntries() ?? fail(`${damaged}, so the alias ${old} of ${key} was not removed. Fix or remove it.`);
          const kept = current.filter(([name, target]) => name !== old || target !== key);
          if (kept.length < current.length) writeAtomic(aliases, `${JSON.stringify(Object.fromEntries(kept), null, 2)}\n`);
        }),
    },
  };
}
