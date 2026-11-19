import { cpSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fail } from './failure.js';
import { createFile, folderEntries, holdsAnything, isFolder, isReadableFile, isTaken, readText, readTimedText, sameTree, treeEntries, writeAtomic } from './files.js';
import type { LedgerPaths } from './paths.js';
import { byCodeUnit, type LedgerCollection, type LedgerStore, type StoredLedger } from './store.js';

/**
 * Ledgers as files <root>/<repo>/<name>.md. A ledger is a readable regular file, never a symbolic link; a repo is a
 * folder, through a symbolic link or not.
 */
function collection(root: string): LedgerCollection {
  const repoLocation = (repo?: string): string => (repo === undefined ? root : path.join(root, repo));
  const location = (repo: string, name: string): string => path.join(root, repo, `${name}.md`);
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
        .filter((name) => isFolder(repoLocation(name)))
        .sort(byCodeUnit),
    list: (repo) =>
      folderEntries(repoLocation(repo))
        .map(({ name }) => name)
        .filter((name) => name.endsWith('.md'))
        .sort(byCodeUnit)
        .flatMap((name) => read(repo, name.slice(0, -'.md'.length)) ?? []),
    read,
    has: (repo, name) => isReadableFile(location(repo, name)),
  };
}

/**
 * The ledger store as files under ~/.claude, in the layout the ledger plugin and the old scripts read. A backlog write
 * over a ledger that is a symbolic link replaces the link with a file; the file it pointed to keeps its old text.
 */
export function fileStore({ home }: LedgerPaths): LedgerStore {
  const claude = path.join(home, '.claude');
  const backlog = collection(path.join(claude, 'ledger-backlog'));
  const archive = collection(path.join(claude, 'ledger-archive'));
  const registry = path.join(claude, 'ledgers.json');
  const evidenceOf = (repo: string, name: string): string => path.join(archive.repoLocation(repo), name);
  const evidenceFiles = (repo: string, name: string): string[] => {
    const folder = evidenceOf(repo, name);
    // Not through a symbolic link, as with a ledger, so reading evidence never leaves the archive.
    if (!lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) return [];
    return treeEntries(folder)
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(folder, path.join(entry.parentPath, entry.name)))
      .sort(byCodeUnit);
  };
  return {
    backlog: {
      ...backlog,
      write: (repo, slug, text) => writeAtomic(backlog.location(repo, slug), text),
      remove: (repo, slug) => rmSync(backlog.location(repo, slug)),
    },
    archive: {
      ...archive,
      write: (repo, name, text, evidenceFrom) => {
        const file = archive.location(repo, name);
        const evidence = evidenceOf(repo, name);
        const refuse = (taken: string): never => fail(`${taken} already exists. An archive copy is never replaced.`);
        if (evidenceFrom !== undefined && isTaken(evidence)) refuse(evidence);
        if (!createFile(file, text)) refuse(file);
        if (evidenceFrom === undefined) return;
        // Verbatim, so a relative link keeps its text; one that stays inside the folder then points into the copy.
        cpSync(evidenceFrom, evidence, { recursive: true, verbatimSymlinks: true });
        if (!sameTree(evidenceFrom, evidence)) fail(`The evidence copy ${evidence}/ differs from ${evidenceFrom}/.`);
      },
      evidenceState: (repo, name, from) => {
        const archived = evidenceOf(repo, name);
        try {
          const folder = from !== undefined && holdsAnything(from) ? from : undefined;
          if (!holdsAnything(archived)) return folder === undefined ? 'none' : 'differs';
          return folder !== undefined && sameTree(archived, folder) ? 'same' : 'differs';
        } catch {
          // A folder that cannot be read may hold anything.
          return 'differs';
        }
      },
      nameTaken: (repo, name) => isTaken(archive.location(repo, name)) || isTaken(evidenceOf(repo, name)),
      evidenceLocation: evidenceOf,
      evidenceFiles,
      // Only a listed file, so a path such as ../<name>.md cannot read past the evidence folder.
      readEvidence: (repo, name, file) => (evidenceFiles(repo, name).includes(file) ? readFileSync(path.join(evidenceOf(repo, name), file)) : undefined),
    },
    registry: {
      read: () => {
        try {
          return readText(registry);
        } catch {
          return undefined;
        }
      },
      write: (text) => writeAtomic(registry, text),
    },
  };
}
