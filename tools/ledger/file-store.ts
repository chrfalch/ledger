import { cpSync, lstatSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { fail } from './failure.js';
import { createFile, folderEntries, holdsAnything, isFolder, isReadableFile, isTaken, moveAside, putBack, readText, readTimedText, sameTree, treeEntries, writeAtomic } from './files.js';
import { withLock } from './lock.js';
import type { LedgerPaths } from './paths.js';
import { byCodeUnit, isAsChecked, NameTaken, noteCreated, type Archive, type LedgerCollection, type LedgerStore, type StoredLedger } from './store.js';
import { pauseForTest } from './wait.js';

/** A repo or a ledger name that, as one part of a path, stays in its folder: not empty, . or .., and without a separator. */
const isOnePart = (name: string): boolean => name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);

/** `name` as one part of a path; any other name fails, so no path made from it can leave its folder. */
function onePart(name: string): string {
  if (!isOnePart(name)) fail(`"${name}" is no repo or ledger name: a name is not empty, . or .., and holds no / or \\.`);
  return name;
}

/**
 * Ledgers as files <root>/<repo>/<name>.md. A ledger is a readable regular file, never a symbolic link; a repo is a
 * folder, through a symbolic link or not.
 */
function collection(root: string): LedgerCollection {
  const repoLocation = (repo?: string): string => (repo === undefined ? root : path.join(root, onePart(repo)));
  const location = (repo: string, name: string): string => path.join(root, onePart(repo), `${onePart(name)}.md`);
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
        .filter((name) => isOnePart(name) && isFolder(repoLocation(name)))
        .sort(byCodeUnit),
    list: (repo) =>
      folderEntries(repoLocation(repo))
        .map(({ name }) => name)
        .filter((name) => name.endsWith('.md') && isOnePart(name.slice(0, -'.md'.length)))
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

/** Where a file store keeps its parts. The evidence of the archive copy `name` of `repo` is the folder <evidence>/<repo>/<name>/. */
export type FileRoots = { backlog: string; archive: string; evidence: string; registry: string };

/**
 * The ledger store as files under ~/.claude, in the layout the ledger plugin and the old scripts read: evidence sits next
 * to its archive copy.
 */
export function fileStore({ home }: LedgerPaths): LedgerStore {
  const claude = path.join(home, '.claude');
  const archive = path.join(claude, 'ledger-archive');
  return fileStoreAt({ backlog: path.join(claude, 'ledger-backlog'), archive, evidence: archive, registry: path.join(claude, 'ledgers.json') });
}

/**
 * The ledger store as files under `roots`. A backlog write over a ledger that is a symbolic link replaces the link with
 * a file; the file it pointed to keeps its old text.
 */
export function fileStoreAt(roots: FileRoots): LedgerStore {
  const backlog = collection(roots.backlog);
  const archive = collection(roots.archive);
  const { registry } = roots;
  const readRegistry = (): string | undefined => {
    try {
      return readText(registry);
    } catch {
      return undefined;
    }
  };
  const evidenceOf = (repo: string, name: string): string => path.join(roots.evidence, onePart(repo), onePart(name));
  /** The evidence folder to copy or remove; a symbolic link at it, its repo folder or the evidence root fails, as each leads outside it. */
  const evidenceToChange = (repo: string, name: string): string => {
    const folder = evidenceOf(repo, name);
    for (const part of [roots.evidence, path.dirname(folder), folder]) {
      if (lstatSync(part, { throwIfNoEntry: false })?.isSymbolicLink()) fail(`${part} is a symbolic link, so no evidence is copied or removed through it. Replace it with a folder.`);
    }
    return folder;
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
  };
}
