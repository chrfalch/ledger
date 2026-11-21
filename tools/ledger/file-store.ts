import { cpSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { fail } from './failure.js';
import { createFile, folderEntries, holdsAnything, isEntryName, isFolder, isReadableFile, isTaken, moveAside, putBack, readText, readTimedText, sameTree, treeEntries, writeAtomic, type TimedText } from './files.js';
import { withLock } from './lock.js';
import type { LedgerPaths } from './paths.js';
import { ownHosts, validHost } from './settings.js';
import { parseRecord, readStoredRecord, recordJson, recordToWrite, renderRecord, type StoredRecord } from './record.js';
import { byCodeUnit, checkedAliases, findWorktree, isAsChecked, NameTaken, needsAlias, noteCreated, readable, refuseHiddenMarkdown, resolvedWorktree, type Archive, type Backlog, type LedgerCollection, type LedgerStore, type StoredLedger } from './store.js';
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

const RECORD = '.json';
const MARKDOWN = '.md';

/** The name a ledger file `file` holds, when it is one: <name>.json for a task record, <name>.md from before records. */
function ledgerName(file: string, legacyMarkdown: boolean): string | undefined {
  const extension = file.endsWith(RECORD) ? RECORD : legacyMarkdown && file.endsWith(MARKDOWN) ? MARKDOWN : undefined;
  const name = extension && file.slice(0, -extension.length);
  return name && isEntryName(name) ? name : undefined;
}

const storedIn = (file: string, text: string): StoredRecord => (file.endsWith(RECORD) ? readStoredRecord(text, file) : { record: parseRecord(text) });

/** The text a ledger file gives the store: a record rendered to Markdown, as every store reads it. */
const renderedFile = (file: string, text: string): string => renderRecord(storedIn(file, text).record);

/** The created time the record at `file` keeps, for a write over it to keep too; undefined when it keeps none or cannot be read. */
export function keptCreated(file: string): string | undefined {
  try {
    return readStoredRecord(readText(file), file).created;
  } catch {
    // A record that cannot be read, such as one a git conflict left, is replaced all the same, as before.
    return undefined;
  }
}

/**
 * The Markdown at `file`, with what a record made in its place keeps of it: its birth time as `created`, as macOS cannot
 * set the birth time of the new file, and its mode, which the umask would set otherwise. Undefined when it is no
 * readable file.
 */
function markdownToReplace(file: string): (TimedText & { created: string; mode: number }) | undefined {
  const found = readTimedText(file);
  return found && { ...found, created: new Date(found.birthtimeMs).toISOString(), mode: lstatSync(file).mode };
}

/**
 * Runs `work` holding the lock of a ledger's record, then that of its Markdown. A writer from before records locks the
 * Markdown alone, so whatever converts or replaces the Markdown holds both, and never removes an edit it did not read.
 */
const withLedgerLocks = <T>({ record, markdown }: { record: string; markdown: string }, work: () => T): T => withLock(record, () => withLock(markdown, work));

/**
 * A collection of ledger files, and the two files a ledger may be: its record, and its Markdown from before records,
 * which the record hides while both are there.
 */
type FileCollection = LedgerCollection & { files: (repo: string, name: string) => { record: string; markdown: string }; hidesMarkdown: (repo: string, name: string) => boolean };

/**
 * Ledgers as files <root>/<repo folder>/<name>.json, each a task record. A <name>.md from before records is read as well,
 * while there is no <name>.json, and a write replaces it. A ledger is a readable regular file, never a symbolic link; a
 * repo is a folder, through a symbolic link or not. A file such as `...md`, whose name would be `..`, is no ledger.
 */
function collection(root: string, legacyMarkdown = true): FileCollection {
  const repoLocation = (repo?: string): string => (repo === undefined ? root : path.join(root, folderOf(repo)));
  const files = (repo: string, name: string) => {
    const base = path.join(repoLocation(repo), entryName(name));
    return { record: `${base}${RECORD}`, markdown: `${base}${MARKDOWN}` };
  };
  /** The file there is: the record, else the Markdown, else where the record would be. */
  const location = (repo: string, name: string): string => {
    const { record, markdown } = files(repo, name);
    return !legacyMarkdown || isTaken(record) || !isTaken(markdown) ? record : markdown;
  };
  const read = (repo: string, name: string): StoredLedger | undefined => {
    const file = location(repo, name);
    const found = readTimedText(file);
    if (found === undefined) return undefined;
    const { record, created } = storedIn(file, found.text);
    const birthtimeMs = created === undefined ? found.birthtimeMs : Date.parse(created);
    return { repo, name, location: file, mtimeMs: found.mtimeMs, birthtimeMs, text: renderRecord(record) };
  };
  const hidesMarkdown = (repo: string, name: string): boolean => {
    const { record, markdown } = files(repo, name);
    return legacyMarkdown && isTaken(record) && isTaken(markdown);
  };
  // As before records, by <name>.md: fix-login comes before fix.
  const names = (repo: string): string[] =>
    [...new Set(folderEntries(repoLocation(repo)).flatMap(({ name }) => ledgerName(name, legacyMarkdown) ?? []))].sort((a, b) => byCodeUnit(`${a}${MARKDOWN}`, `${b}${MARKDOWN}`));
  return {
    location,
    repoLocation,
    files,
    hidesMarkdown,
    repos: () =>
      folderEntries(root)
        .map(({ name }) => name)
        .filter((name) => isFolder(path.join(root, name)))
        .map(repoOf)
        .sort(byCodeUnit),
    list: (repo) => names(repo).flatMap((name) => readable(() => read(repo, name)) ?? []),
    read,
    has: (repo, name) => isReadableFile(location(repo, name)),
    setModified: (repo, name, mtimeMs) => {
      const time = new Date(mtimeMs);
      withLock(files(repo, name).record, () => utimesSync(location(repo, name), time, time));
    },
    ...(legacyMarkdown && {
      markdownNames: (repo) => names(repo).filter((name) => location(repo, name) === files(repo, name).markdown && isReadableFile(files(repo, name).markdown)),
      hiddenMarkdown: (repo) => names(repo).filter((name) => hidesMarkdown(repo, name)),
      markdownText: (repo, name) => {
        const { record, markdown } = files(repo, name);
        return isTaken(record) ? undefined : readTimedText(markdown)?.text;
      },
      toRecord: (repo, name) => {
        const { record, markdown } = files(repo, name);
        return withLedgerLocks({ record, markdown }, () => {
          const found = isTaken(record) ? undefined : markdownToReplace(markdown);
          if (found === undefined) return false;
          if (!createFile(record, recordJson(recordToWrite(found.text, markdown), found.created), found.mode)) return false;
          // In seconds, not a Date, which would cut the time to whole milliseconds.
          utimesSync(record, found.mtimeMs / 1000, found.mtimeMs / 1000);
          rmSync(markdown);
          return true;
        });
      },
    }),
  };
}

/**
 * Where a file store keeps its parts. The evidence of the archive copy `name` of `repo` is the folder
 * <evidence>/<repo folder>/<name>/.
 */
export type FileRoots = { backlog: string; active: string; archive: string; evidence: string; registry: string; aliases: string };

/** A move between repo folders is a rename on one disk; `rename` is for tests, to act out a folder on another disk. */
export type FileStoreOptions = { rename?: (from: string, to: string) => void };

/**
 * The ledger store as files under ~/.claude, in the layout the ledger plugin and the old scripts read: evidence sits next
 * to its archive copy.
 */
export function fileStore({ home }: LedgerPaths, options: FileStoreOptions = {}): LedgerStore {
  const claude = path.join(home, '.claude');
  const archive = path.join(claude, 'ledger-archive');
  const roots = { backlog: path.join(claude, 'ledger-backlog'), active: path.join(claude, 'ledger-active'), archive, evidence: archive, registry: path.join(claude, 'ledgers.json'), aliases: path.join(claude, 'ledger-aliases.json') };
  return { ...fileStoreAt(roots, options), host: validHost(home), ownHosts: ownHosts(home) };
}

/**
 * The ledger store as files under `roots`. A backlog write over a ledger that is a symbolic link replaces the link with
 * a file; the file it pointed to keeps its old text.
 */
export function fileStoreAt(roots: FileRoots, { rename = renameSync }: FileStoreOptions = {}): LedgerStore {
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
  /** Renames each file of the ledger `name` to `to`, the record and any Markdown it hides. */
  const moveFiles = (collection: FileCollection, repo: string, name: string, to: string, legacyMarkdown = true): void => {
    const [from, target] = [collection.files(repo, name), collection.files(to, name)];
    if (isTaken(from.record)) rename(from.record, target.record);
    if (legacyMarkdown && isTaken(from.markdown)) rename(from.markdown, target.markdown);
  };
  /** Fails when `root` is a symbolic link, as a new ledger made through it could land anywhere. */
  const checkRoot = (root: string): void => {
    if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) fail(`${root} is a symbolic link, so no ledger is created through it. Replace it with a folder.`);
  };
  function writable(root: string, legacyMarkdown: boolean): Backlog {
    const ledgers = collection(root, legacyMarkdown);
    const lock = <T>(repo: string, slug: string, work: () => T): T => {
      const files = ledgers.files(repo, slug);
      return legacyMarkdown ? withLedgerLocks(files, work) : withLock(files.record, work);
    };
    /**
     * Runs `work` with the current text under the ledger locks. Throws when the ledger does not exist.
     */
    const withExisting = <T>(repo: string, slug: string, work: (text: string) => T): T => {
      const missing = (): never => fail(`${ledgers.location(repo, slug)} does not exist.`);
      if (!ledgers.has(repo, slug)) missing();
      return lock(repo, slug, () => work((ledgers.read(repo, slug) ?? missing()).text));
    };
    /**
     * Writes the record of `text` in place of the ledger's record, keeping its created time, or in place of its Markdown
     * when that is what was read, keeping the Markdown's birth time and mode. Markdown a record hides stays, for
     * `ledger store migrate --records` to name. Call it under the ledger locks.
     */
    const putRecord = (repo: string, slug: string, text: string): void => {
      const { record, markdown } = ledgers.files(repo, slug);
      const replacesMarkdown = legacyMarkdown && !isTaken(record);
      const replaced = replacesMarkdown ? markdownToReplace(markdown) : undefined;
      const created = replacesMarkdown ? replaced?.created : keptCreated(record);
      writeAtomic(record, recordJson(recordToWrite(text, ledgers.location(repo, slug)), created), replaced?.mode);
      if (replacesMarkdown) rmSync(markdown, { force: true });
    };
    return {
      ...ledgers,
      write: (repo, slug, text) => lock(repo, slug, () => putRecord(repo, slug, text)),
      create: (repo, slug, text) => {
        checkRoot(root);
        const { record, markdown } = ledgers.files(repo, slug);
        return (!legacyMarkdown || !isTaken(markdown)) && createFile(record, recordJson(recordToWrite(text, record)));
      },
      update: (repo, slug, change) =>
        withExisting(repo, slug, (current) => {
          pauseForTest();
          const text = change(current);
          if (text !== undefined) putRecord(repo, slug, text);
          return text !== undefined;
        }),
      // Under the lock, so an update that read the ledger before cannot write it back after.
      remove: (repo, slug, expected) =>
        withExisting(repo, slug, (current) => {
          if (ledgers.hidesMarkdown(repo, slug)) refuseHiddenMarkdown(ledgers.location(repo, slug));
          if (current !== expected) return false;
          rmSync(ledgers.location(repo, slug));
          return true;
        }),
      move: (repo, slug, to) =>
        leaving(
          ledgers.repoLocation(repo),
          withExisting(repo, slug, () => !isTaken(ledgers.location(to, slug)) && into(ledgers.repoLocation(to), () => (moveFiles(ledgers, repo, slug, to, legacyMarkdown), true))),
        ),
      canMove: (repo, slug, to) => ledgers.has(repo, slug) && !isTaken(ledgers.location(to, slug)),
    };
  }
  const active = writable(roots.active, false);
  function* worktrees() {
    for (const repo of active.repos()) {
      for (const { name } of folderEntries(active.repoLocation(repo))) {
        const slug = ledgerName(name, false);
        if (!slug) continue;
        const file = active.location(repo, slug);
        const found = readTimedText(file);
        const worktree = found && readable(() => readStoredRecord(found.text, file).record.worktree);
        if (worktree !== undefined) yield { repo, slug, worktree };
      }
    }
  }
  return {
    backlog: writable(roots.backlog, true),
    active: { ...active, byWorktree: (folder) => findWorktree(folder, resolvedWorktree(folder), worktrees()) },
    archive: {
      ...archive,
      write: (repo, name, text, evidenceFrom) => {
        const { record: file, markdown } = archive.files(repo, name);
        const evidence = evidenceOf(repo, name);
        const refuse = (taken: string): never => {
          throw new NameTaken(`${taken} already exists. An archive copy is never replaced.`);
        };
        checkRoot(roots.archive);
        if (evidenceFrom !== undefined && isTaken(evidence)) refuse(evidence);
        if (isTaken(markdown)) refuse(markdown);
        if (evidenceFrom !== undefined) evidenceToChange(repo, name);
        if (!createFile(file, recordJson(recordToWrite(text, file)))) refuse(file);
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
        return withLock(archive.files(repo, name).record, () => {
          const file = archive.location(repo, name);
          const evidence = evidenceToChange(repo, name);
          if (!isTaken(file)) fail(`${file} does not exist.`);
          if (archive.hidesMarkdown(repo, name)) refuseHiddenMarkdown(file);
          if (expected !== undefined && !isAsChecked({ read: archive.read, evidenceState }, repo, name, expected)) return false;
          // Checked again once moved aside: an edit made after the check above is put back, one made later is a new file.
          const aside = moveAside(file) ?? fail(`${file} does not exist.`);
          const unchanged = (): boolean => {
            try {
              return renderedFile(file, readText(aside)) === expected?.text;
            } catch {
              return false;
            }
          };
          if (expected !== undefined && !unchanged()) {
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
        const moved = withLock(archive.files(repo, name).record, () => {
          const move = archiveMove(repo, name, to);
          if (move !== 'evidence' && !archive.has(repo, name)) missing();
          return (
            move !== undefined &&
            into(archive.repoLocation(to), () => {
              if (move === 'copy') moveFiles(archive, repo, name, to);
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
