// @ref LLP 0000#the-store — what each store keeps, and how the storage setting picks one.
import { fail, Failure } from './failure.js';
import { holdsAnything } from './files.js';
import { isRepoKey } from './repo-key.js';

/**
 * One ledger a store keeps. `location` names it for a person: messages and JSON print it as it is, but nothing outside
 * the store opens it, as a store need not keep its ledgers in files. A store keeps each ledger as a task record:
 * `text` is the record rendered to Markdown, and a write parses the Markdown it is given, so `text` is `storedText` of
 * what was written.
 */
export type StoredLedger = {
  repo: string;
  name: string;
  text: string;
  mtimeMs: number;
  birthtimeMs: number;
  location: string;
};

/**
 * What `read` gives, or undefined for a task record that is no valid record, such as one a git conflict left: a list
 * leaves it out, as it leaves out a file it cannot read, so one broken ledger does not stop every command. Reading it by
 * name still fails and names it.
 */
export function readable(read: () => StoredLedger | undefined): StoredLedger | undefined {
  try {
    return read();
  } catch (error) {
    if (error instanceof Failure) return undefined;
    throw error;
  }
}

/** UTF-16 code-unit order, the order readdir gave the old scans; every store sorts evidence files by it. */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Ledgers kept per repo, by its key: the repo's remote address, or the path of its main checkout (LLP 0001 D10). */
export interface LedgerCollection {
  /** Where the ledger `name` of `repo` is or would be, as `StoredLedger.location` gives it; for display only. */
  location(repo: string, name: string): string;
  /** Where the ledgers of `repo` are, or without a repo, where the ledgers of every repo are; for display only. */
  repoLocation(repo?: string): string;
  /** The keys of the repos that have ledgers. */
  repos(): string[];
  /** The ledgers of one repo, in the order of their file names; none for an unknown repo. */
  list(repo: string): StoredLedger[];
  read(repo: string, name: string): StoredLedger | undefined;
  /** The same as `read(repo, name) !== undefined`, without reading the text. */
  has(repo: string, name: string): boolean;
  /** Sets the `mtimeMs` that `read` gives the ledger, so a copy keeps the time of its original. */
  setModified?(repo: string, name: string, mtimeMs: number): void;
  /** The names of `repo` still kept as Markdown from before task records, in the order of `list`. */
  markdownNames?(repo: string): string[];
  /** The Markdown the ledger `name` is still kept as, which `toRecord` converts; undefined when it is not kept as Markdown. */
  markdownText?(repo: string, name: string): string | undefined;
  /** Rewrites the Markdown ledger `name` as a task record, its text and times as they are; false when it is not kept as Markdown. */
  toRecord?(repo: string, name: string): boolean;
  /**
   * The names of `repo` kept both as a record and as Markdown from before records, as when an older machine wrote one: the
   * record is read, and the Markdown is hidden. No write removes such Markdown, and `remove` refuses such a name, as the
   * Markdown would be read again without its record; a person merges the two.
   */
  hiddenMarkdown?(repo: string): string[];
}

/** What `remove` throws, removing nothing, while a ledger's record hides Markdown from before records. */
export class HiddenMarkdown extends Failure {}

/** Throws HiddenMarkdown for the ledger at `location`. */
export function refuseHiddenMarkdown(location: string): never {
  throw new HiddenMarkdown(
    `${location} has both a task record and Markdown from before records, so it was left as it is: without the record, the Markdown would be read again. Merge the two by hand, then remove the Markdown; ledger store migrate --records names each task kept both ways.`,
  );
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
  /**
   * Deletes the ledger while its text is still `expected`. False, with nothing deleted, when another command changed it;
   * throws when it does not exist, and while its record hides Markdown (`hiddenMarkdown`).
   */
  remove(repo: string, slug: string, expected: string): boolean;
  /**
   * Moves the ledger to the repo `to`, text and times as they are, by a rename on one disk. False, with nothing moved, when
   * anything has `slug` in `to` already, also a name that differs only in case on a disk that ignores case. Throws when
   * the ledger does not exist, and when the rename fails, such as with EXDEV to another disk; then nothing moved.
   */
  move(repo: string, slug: string, to: string): boolean;
  /** Whether `move` would move the ledger now, by the checks it makes, without moving anything. */
  canMove(repo: string, slug: string, to: string): boolean;
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
   * Removes the evidence of the copy `name`, then the copy, and gives true; fails when there is no such copy, and while
   * its record hides Markdown (`hiddenMarkdown`). With `expected`, only while the copy still holds its text and its
   * evidence matches the folder `expected.evidence`, which stands for none when it holds nothing; otherwise it removes
   * nothing and gives false.
   */
  remove(repo: string, name: string, expected?: CheckedCopy): boolean;
  /**
   * Moves the copy and then its evidence to the repo `to`, as they are, as `Backlog.move` moves a ledger. False, with
   * nothing moved, when anything has `name` in `to`, except one case: `to` has the copy, the source has only its evidence,
   * and `to` has none. A move that stopped between the two left that, so then only the evidence moves.
   */
  move(repo: string, name: string, to: string): boolean;
  /** Whether `move` would move the copy now, by the checks it makes, without moving anything. */
  canMove(repo: string, name: string, to: string): boolean;
  /** Evidence kept under a name that has no archive copy, in any repo, such as what a move or a hand left behind. */
  orphanEvidence(): { repo: string; name: string }[];
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

/** Old repo keys, such as the folder names keys were before D10, each with the key that replaced it. Unlike the registry, no rebuild can recreate it. */
export interface Aliases {
  /** Only the aliases whose old key is a repo key and whose target is an address or a path, so a target is never joined into a path that climbs out. */
  read(): ReadonlyMap<string, string>;
  /** A sentence for the operator about aliases `read` ignores, or a map that cannot be read; undefined when there is none. */
  problem(): string | undefined;
  /**
   * Makes `old` an alias of `key`. Throws, and leaves the map as it is, when `old` is an alias of another key already, and
   * for a map that cannot be read or that holds an alias `read` ignores.
   */
  add(old: string, key: string): void;
  /** Removes `old` while it is an alias of `key`, so a storage switch that stops can take back what it added. */
  remove(old: string, key: string): void;
}

/** `key` and the old keys that are aliases of it: every key a backlog or archive ledger of the repo `key` can be filed under. */
export const keyAndAliases = (aliases: ReadonlyMap<string, string>, key: string): string[] => [
  key,
  ...[...aliases].flatMap(([old, target]) => (target === key ? [old] : [])),
];

/** What an alias can point to: a repo key with a slash, as every D10 key has. A folder name is only ever an old key. */
const isAliasTarget = (key: unknown): key is string => typeof key === 'string' && isRepoKey(key) && key.includes('/');

/** The aliases among `entries` that `Aliases.read` gives, and the `Aliases.problem` sentence for the others. */
export function checkedAliases(entries: Iterable<readonly [string, unknown]>): { aliases: Map<string, string>; problem?: string } {
  const aliases = new Map<string, string>();
  const ignored: string[] = [];
  for (const [old, key] of entries) {
    if (isAliasTarget(key) && isRepoKey(old)) aliases.set(old, key);
    else ignored.push(`Ignored the repo alias ${old} → ${JSON.stringify(key)}, as that is no repo key.`);
  }
  return ignored.length === 0 ? { aliases } : { aliases, problem: ignored.join(' ') };
}

/**
 * Whether the alias map `entries`, kept in `where`, needs `old` → `key` added: false when it has it. Throws, so nothing is
 * written, as `Aliases.add` does.
 */
export function needsAlias(entries: Iterable<readonly [string, unknown]>, old: string, key: string, where: string): boolean {
  if (!isAliasTarget(key) || !isRepoKey(old)) {
    fail(`${old} cannot be an alias of "${key}": both must be repo keys, not empty, with no \\ and no . or .. between slashes, and "${key}" must be an address or a path, so it holds a slash.`);
  }
  const { aliases, problem } = checkedAliases(entries);
  if (problem !== undefined) fail(`${problem} So ${old} was not made an alias of ${key}. Fix or remove that alias in ${where}.`);
  const current = aliases.get(old);
  if (current !== undefined && current !== key) fail(`${old} is an alias of ${current} already, so it was not made an alias of ${key}.`);
  return current === undefined;
}

/** A copy that ActiveCopies.remove removed. */
export type RemovedCopy = {
  /**
   * Writes the copy back as it was, left out of every commit again if it was before. One it cannot write back is left
   * out of every commit, so none removes it, and this fails.
   */
  putBack(): void;
};

/**
 * Copies of the worktree ledgers of each machine, so that the other machines can read them. A machine writes only the
 * copies in its own host folder; the name is the slug.
 */
export interface ActiveCopies {
  /**
   * The host folder of this machine; undefined when the "host" setting is no host label. Then only the copies of this
   * machine are out of reach: `write`, `remove` and `reconcile` fail and say why.
   */
  readonly host: string | undefined;
  /** The host folders, by name. */
  hosts(): string[];
  copiesOf(host: string): LedgerCollection;
  /**
   * Writes this machine's copy of a worktree ledger; false when the copy holds `text` already. A copy that is there but
   * cannot be read fails, with nothing written.
   */
  write(repo: string, slug: string, text: string): boolean;
  /**
   * Removes this machine's copy, so that the next commit removes it too; undefined when there is none. A copy that is
   * there but cannot be read fails, with nothing removed. One already gone whose removal no commit took, as it was held
   * back, counts as removed now.
   */
  remove(repo: string, slug: string): RemovedCopy | undefined;
  /**
   * Runs `work` with this machine's host folder, then commits every change of this machine's copies, also one an earlier
   * commit left out; all of it as one step, so no other command writes or commits the store in between. Unfinished work
   * in the store, such as a merge, fails it before `work` runs. When `work` throws, the copies it changed are put back as
   * they were before it, so none of its changes is committed; one it cannot put back is left out of every commit until a
   * reconcile that goes through writes it, finds it as written or removes it. A commit that fails is left to `close`; so
   * is the commit when git cannot list the changed copies, which fails it.
   */
  reconcile<T>(work: (host: string) => T): T;
}

/**
 * Where backlog ledgers, archive copies and the registry are kept. A worktree's .claude/ledger.md is not in it; git
 * storage keeps a copy of it in `active`.
 */
export interface LedgerStore {
  backlog: Backlog;
  archive: Archive;
  registry: Registry;
  aliases: Aliases;
  active?: ActiveCopies;
  /**
   * Records what the store wrote where it must be recorded, as git storage commits it; throws when it cannot, and when
   * it recorded a ledger of `expected` with any other text.
   */
  commit?(expected?: WrittenLedger[]): void;
  /**
   * Runs `work`, then records what it wrote, as one step: no other command writes or records the store in between, so
   * none sees half of it. A store without such a step, as one that records each write at once, has no `inOneCommit`. A
   * commit that fails is left to `close`.
   */
  inOneCommit?<T>(work: () => T): T;
  /** Lets go of what the store holds open, such as a database; the store is not used after it. */
  close?(): void;
}
