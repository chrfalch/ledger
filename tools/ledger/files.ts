import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import path from 'node:path';

/**
 * Writes `text`, with `mode` when given, to a new temporary file next to `file`, hands it to `finish`, then removes what
 * is left of it. An entry at the temporary name throws: it is not followed, and not removed, because this call did not make it.
 */
function throughTemporary<T>(file: string, text: string, mode: number | undefined, finish: (temporary: string) => T): T {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  const descriptor = openSync(temporary, 'wx');
  try {
    try {
      writeFileSync(descriptor, text);
      if (mode !== undefined) fchmodSync(descriptor, mode);
    } finally {
      closeSync(descriptor);
    }
    return finish(temporary);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // A temporary file left behind matters less than the error or result above, which a throw here would replace.
    }
  }
}

/**
 * Writes through a temporary file and a rename, so a reader such as the ledger plugin never sees half a file and a
 * failed write leaves the old file whole. An existing file keeps its mode, which the umask would otherwise narrow.
 */
export function writeAtomic(file: string, text: string): void {
  const mode = statSync(file, { throwIfNoEntry: false })?.mode;
  throughTemporary(file, text, mode, (temporary) => renameSync(temporary, file));
}

/**
 * Writes a new file whole: a temporary file, then a hard link to the name, which fails on any entry that is there, a
 * dangling symbolic link included. False when the name is taken; nothing is replaced and no temporary file is left.
 */
export function createFile(file: string, text: string): boolean {
  return throughTemporary(file, text, undefined, (temporary) => {
    try {
      linkSync(temporary, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  });
}

export const readText = (file: string): string => readFileSync(file, 'utf8');

export const exists = (file: string): boolean => existsSync(file);

/** Whether any entry is at `file`, a dangling symbolic link included. */
export const isTaken = (file: string): boolean => lstatSync(file, { throwIfNoEntry: false }) !== undefined;

/** Anything at `folder` but an empty folder or nothing; a symbolic link is not followed. Throws when the folder cannot be read, which is not empty. */
export const holdsAnything = (folder: string): boolean =>
  isTaken(folder) && !(lstatSync(folder).isDirectory() && readdirSync(folder).length === 0);

/** Whether two entries are the same tree: files by content, symbolic links by their text, folders entry by entry. Anything unreadable differs. */
export function sameTree(a: string, b: string): boolean {
  try {
    const [left, right] = [lstatSync(a), lstatSync(b)];
    if (left.isSymbolicLink() || right.isSymbolicLink()) return left.isSymbolicLink() && right.isSymbolicLink() && readlinkSync(a) === readlinkSync(b);
    if (left.isDirectory() || right.isDirectory()) {
      if (!left.isDirectory() || !right.isDirectory()) return false;
      const [names, others] = [readdirSync(a).sort(), readdirSync(b).sort()];
      return names.length === others.length && names.every((name, index) => name === others[index] && sameTree(path.join(a, name), path.join(b, name)));
    }
    return left.isFile() && right.isFile() && left.size === right.size && readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

export const isFolder = (file: string): boolean => statSync(file, { throwIfNoEntry: false })?.isDirectory() ?? false;

type Links = { followLinks?: boolean };

/**
 * The stat of a regular file this process may read; undefined for anything else. A symbolic link counts only with
 * `followLinks`, so in the store a link can never pass for a ledger or an archive copy of the file it points to.
 */
function readableFile(file: string, { followLinks = false }: Links = {}): Stats | undefined {
  try {
    const stat = followLinks ? statSync(file) : lstatSync(file);
    if (!stat.isFile()) return undefined;
    accessSync(file, constants.R_OK);
    return stat;
  } catch {
    return undefined;
  }
}

export const isReadableFile = (file: string): boolean => readableFile(file) !== undefined;

/** The entries of `folder` and its subfolders. Unlike readdir's recursive option, a symbolic link to a folder is not followed. */
export function treeEntries(folder: string): Dirent[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? [entry, ...treeEntries(path.join(folder, entry.name))] : [entry]));
}

/** The entries of a folder; none when it cannot be read. */
export function folderEntries(folder: string): Dirent[] {
  try {
    return readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
}

export type TimedText = { text: string; mtimeMs: number; birthtimeMs: number };

/** The text and times of a file; undefined when it is not a readable file. A file system without birth times gives the mtime. */
export function readTimedText(file: string, links: Links = {}): TimedText | undefined {
  const stat = readableFile(file, links);
  if (stat === undefined) return undefined;
  try {
    return { text: readText(file), mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs };
  } catch {
    return undefined;
  }
}
