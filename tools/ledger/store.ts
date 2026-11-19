// @ref LLP 0000#the-store — what each store keeps, and how the storage setting picks one.
import { Failure } from './failure.js';
import { holdsAnything } from './files.js';

/**
 * One ledger a store keeps. `location` names it for a person: messages and JSON print it as it is, but nothing outside
 * the store opens it, as a store need not keep its ledgers in files.
 */
export type StoredLedger = {
  repo: string;
  name: string;
  text: string;
  mtimeMs: number;
  birthtimeMs: number;
  location: string;
};

/** UTF-16 code-unit order, the order readdir gave the old scans; every store sorts evidence files by it. */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Ledgers kept per repo folder, which is named after the main checkout's folder. */
export interface LedgerCollection {
  /** Where the ledger `name` of `repo` is or would be, as `StoredLedger.location` gives it; for display only. */
  location(repo: string, name: string): string;
  /** Where the ledgers of `repo` are, or without a repo, where the ledgers of every repo are; for display only. */
  repoLocation(repo?: string): string;
  /** The repo folders, by name. */
  repos(): string[];
  /** The ledgers of one repo folder, in the order of their file names; none for an unknown repo. */
  list(repo: string): StoredLedger[];
  read(repo: string, name: string): StoredLedger | undefined;
  /** The same as `read(repo, name) !== undefined`, without reading the text. */
  has(repo: string, name: string): boolean;
  /** Sets the `mtimeMs` that `read` gives the ledger, so a copy keeps the time of its original. */
  setModified?(repo: string, name: string, mtimeMs: number): void;
}

/**
 * A change to a text that another command may change at the same time: it gets the text as it is now, and returns the
 * new text, or undefined to leave it as it is. A throw leaves it as it is too. It may read the store but not write to it.
 */
export type Change<T> = (text: T) => string | undefined;

/** Ledgers of tasks not started yet; the name is the slug. */
export interface Backlog extends LedgerCollection {
  write(repo: string, slug: string, text: string): void;
  /** Writes a new ledger, at once and whole. False, with nothing written, when `slug` is taken, also by a command running now. */
  create(repo: string, slug: string, text: string): boolean;
  /** Rewrites the ledger with `change`, which no other write can come between. True when it was written; throws when it does not exist. */
  update(repo: string, slug: string, change: Change<string>): boolean;
  /** Deletes the ledger while its text is still `expected`. False, with nothing deleted, when another command changed it; throws when it does not exist. */
  remove(repo: string, slug: string, expected: string): boolean;
}

export type EvidenceState = 'none' | 'same' | 'differs';

/** What `Archive.write` throws for a name that is taken, so a caller knows the copy there is not its own. */
export class NameTaken extends Failure {}

const createdHere = new Set<string>();

/** For each store's `Archive.write`: this process made the archive copy at `location`, with an exclusive create. */
export const noteCreated = (location: string): void => void createdHere.add(location);

/**
 * Whether this process made the archive copy at `location`. After a write that failed, only such a copy is the caller's
 * to remove: another command may have written the very same text.
 */
export const wasCreatedHere = (location: string): boolean => createdHere.has(location);

/** Copies of retired ledgers; the name is `<YYYY-MM-DD>-<slug>`. */
export interface Archive extends LedgerCollection {
  /**
   * `evidenceFrom` is a folder whose files are copied to sit with the copy, under the same name. A name that is taken,
   * or an evidence copy that is already there, throws NameTaken before anything is written: an archive copy is never replaced.
   * An evidence copy that does not match its folder afterwards throws too, and is left as it is.
   */
  write(repo: string, name: string, text: string, evidenceFrom?: string): void;
  /**
   * The evidence archived with `name` against the folder `from`: 'none' when neither holds any, 'same' when both hold
   * the same files, folders and symbolic links (links by their text), 'differs' otherwise. A missing or empty folder
   * holds none.
   */
  evidenceState(repo: string, name: string, from?: string): EvidenceState;
  /** Whether a copy or an evidence folder, even an empty one, already uses `name`; write refuses such a name. */
  nameTaken(repo: string, name: string): boolean;
  /** Where the evidence archived with `name` is or would be, apart from every ledger's location; for display only. */
  evidenceLocation(repo: string, name: string): string;
  /**
   * The files archived with `name` as paths relative to its evidence, sorted by `byCodeUnit`; none without evidence.
   * Folders and symbolic links are not listed.
   */
  evidenceFiles(repo: string, name: string): string[];
  /** The bytes of `file`, one of `evidenceFiles(repo, name)`; undefined for any other path. */
  readEvidence(repo: string, name: string, file: string): Buffer | undefined;
  /**
   * Writes the evidence archived with `name` to the folder `to`, which must not exist yet: its files, folders and symbolic
   * links, as `write` took them. Without evidence it writes nothing.
   */
  copyEvidence(repo: string, name: string, to: string): void;
  /**
   * Removes the evidence of the copy `name`, then the copy, and gives true; fails when there is no such copy. With
   * `expected`, only while the copy still holds its text and its evidence matches the folder `expected.evidence`, which
   * stands for none when it holds nothing; otherwise it removes nothing and gives false.
   */
  remove(repo: string, name: string, expected?: CheckedCopy): boolean;
}

/** An archive copy as it was checked: its text, and a folder that holds its evidence as it was then. */
export type CheckedCopy = { text: string; evidence: string };

/** Whether the copy `name` of `archive` is still as `checked` says. */
export const isAsChecked = (archive: Pick<Archive, 'read' | 'evidenceState'>, repo: string, name: string, { text, evidence }: CheckedCopy): boolean =>
  archive.read(repo, name)?.text === text && archive.evidenceState(repo, name, evidence) === (holdsAnything(evidence) ? 'same' : 'none');

/** The text of the registry, a cache that a rebuild from the ledgers can always replace. */
export interface Registry {
  read(): string | undefined;
  write(text: string): void;
  /** Rewrites the text with `change`, which gets undefined for no registry; no other write can come between. */
  update(change: Change<string | undefined>): void;
  /** After it, `read` gives undefined, so the next load rebuilds the registry. */
  remove(): void;
}

/** A ledger with the text a caller wrote to it. */
export type WrittenLedger = { place: 'backlog' | 'archive'; repo: string; name: string; text: string };

/** Where backlog ledgers, archive copies and the registry are kept. A worktree's .claude/ledger.md is not in it. */
export interface LedgerStore {
  backlog: Backlog;
  archive: Archive;
  registry: Registry;
  /**
   * Records what the store wrote where it must be recorded, as git storage commits it; throws when it cannot, and when
   * it recorded a ledger of `expected` with any other text.
   */
  commit?(expected?: WrittenLedger[]): void;
  /** Lets go of what the store holds open, such as a database; the store is not used after it. */
  close?(): void;
}
