import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { redacted } from './clone.js';
import { fail } from './failure.js';
import { exists, holdsAnything } from './files.js';
import { openStore } from './open-store.js';
import type { LedgerPaths } from './paths.js';
import { parseRegistry, type RegistryEntry } from './registry.js';
import { readStorage, shownSettingsFile, writeStorage, type Storage } from './settings.js';
import { loadSqlite, sqliteFile, sqliteStore } from './sqlite-store.js';
import { HiddenMarkdown, NameTaken, wasCreatedHere, type Change, type LedgerCollection, type LedgerStore, type StoredLedger, type WrittenLedger } from './store.js';
import { syncLedgers } from './sync.js';
import { joined, plural } from './views.js';

/** `from` is the storage to copy from; by default the one the setting names. */
export type MigrateOptions = { removeSource: boolean; dryRun: boolean; from?: Storage };

// A method's parameters are bivariant, so a test may pass an opener for only the storages it migrates between. With
// `readOnly`, a database stays as it is, its schema too.
type OpenStore = { open(paths: LedgerPaths, storage: Storage, readOnly?: boolean): LedgerStore }['open'];

const STORAGE_NAME: Record<Storage, string> = { file: 'file storage', sqlite: 'SQLite storage', git: 'git storage' };

// Migrate pushes once, in the foreground, after the stores are closed, so it can say whether the push got through.
const openForMigrate: OpenStore = (paths, storage, readOnly = false) =>
  storage === 'sqlite' ? sqliteStore(paths, { readOnly }) : openStore(paths, storage, { backgroundSync: false });

/**
 * The storage the setting names. When that is `to`, as after a hand-edited setting, file and SQLite storage each
 * default to the other, as they did before there was a third storage.
 */
function defaultSource(setting: Storage, to: Storage): Storage {
  if (setting !== to) return setting;
  if (to === 'git') fail('ledger store migrate: the setting already names git storage. Name the storage to copy from with --from file or --from sqlite.');
  return to === 'file' ? 'sqlite' : 'file';
}

/** The store, or undefined for a database that is not there yet, so reading it does not make one. */
const openIfThere = (paths: LedgerPaths, storage: Storage, open: OpenStore, readOnly: boolean): LedgerStore | undefined =>
  storage === 'sqlite' && !exists(sqliteFile(paths.home)) ? undefined : open(paths, storage, readOnly);

const everyLedger = (collection: LedgerCollection | undefined): StoredLedger[] => collection?.repos().flatMap((repo) => collection.list(repo)) ?? [];

const shortName = ({ repo, name }: StoredLedger): string => `${repo}/${name}`;

/** The ledger an entry stands for, as loadTasks matches entries to ledgers; undefined for an archived entry that names none. */
const entryKey = (entry: RegistryEntry): string | undefined => (entry.status === 'archived' ? entry.archivePath : entry.path);

/** `entry` with the store location it names moved to where the copy is, so the next load keeps its created time. */
function relocated(entry: RegistryEntry, moved: Map<string, string>): RegistryEntry {
  if (entry.status !== 'archived') return { ...entry, path: moved.get(entry.path) ?? entry.path };
  return entry.archivePath === undefined ? entry : { ...entry, archivePath: moved.get(entry.archivePath) ?? entry.archivePath };
}

const parsed = (text: string | undefined): RegistryEntry[] => (text === undefined ? [] : (parseRegistry(text) ?? []));

const registryText = (entries: RegistryEntry[]): string => `${JSON.stringify(entries, null, 2)}\n`;

// parseRegistry checks only path and status, so `updated` may be missing.
const updatedOf = ({ updated }: RegistryEntry): string => (typeof updated === 'string' ? updated : '');

const newestFirst = (a: RegistryEntry, b: RegistryEntry): number => updatedOf(b).localeCompare(updatedOf(a));

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * `ledger store migrate --to <storage> [--from <storage>] [--remove-source] [--dry-run]`: copies the backlog ledgers, the
 * archive copies with their evidence, and the registry from one storage to another, reads every copy back, and only then
 * switches the setting and, with `removeSource`, removes what was copied. Exits 1 with nothing changed when the target
 * has a name to copy, and when a copy fails or reads back different: then it removes every copy it made first. Prints
 * one line per step to `line`. When git storage changed, it then pushes, and a failed push is reported, not a failure.
 * `open` is for tests.
 */
export function migrateStorage(paths: LedgerPaths, to: Storage, options: MigrateOptions, print: (text: string) => void, open: OpenStore = openForMigrate): void {
  // Lines name ledgers, and a ledger name can look like a secret.
  const line = (text: string): void => print(redacted(text));
  const setting = readStorage(paths.home);
  const from = options.from ?? defaultSource(setting, to);
  if (from === to) fail(`ledger store migrate: --from and --to both name ${STORAGE_NAME[to]}. Name two different storages.`);
  // A dry run must refuse where the real run would.
  if ((from === 'sqlite' || to === 'sqlite') && loadSqlite() === undefined) fail('ledger store migrate needs a Node version with node:sqlite: 22.13 or later, and 23.4 or later on Node 23.');
  const opened: LedgerStore[] = [];
  const keep = (store: LedgerStore | undefined): LedgerStore | undefined => (store && opened.push(store), store);
  const evidenceRoot = mkdtempSync(path.join(tmpdir(), 'ledger-migrate-'));
  try {
    const source = keep(openIfThere(paths, from, open, options.dryRun));
    const target = keep(options.dryRun ? openIfThere(paths, to, open, true) : open(paths, to));
    migrate({ ...options, paths, from, to, setting, source, target, evidenceRoot, line });
  } finally {
    for (const store of opened) store.close?.();
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
  if (!options.dryRun && (to === 'git' || (from === 'git' && options.removeSource))) pushAfterMigrate(paths, line);
}

/** The data is safe in the clone once migrate committed it, so a push that fails is only reported. */
function pushAfterMigrate(paths: LedgerPaths, line: (text: string) => void): void {
  try {
    syncLedgers(paths, line);
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    line(`The ledgers are committed in git storage but not pushed: ${reason} Run ledger store sync to push them.`);
  }
}

type Migration = MigrateOptions & {
  paths: LedgerPaths;
  from: Storage;
  to: Storage;
  setting: Storage;
  /** Undefined for a database that is not there: it holds nothing, and a dry run does not make it. */
  source: LedgerStore | undefined;
  target: LedgerStore | undefined;
  /** Where the evidence of each archive copy is written on its way between the stores. */
  evidenceRoot: string;
  line: (text: string) => void;
};

function migrate({ paths, from, to, setting, source, target, evidenceRoot, line, removeSource, dryRun }: Migration): void {
  const backlog = everyLedger(source?.backlog);
  const archive = everyLedger(source?.archive);
  const evidenceCount = archive.reduce((count, { repo, name }) => count + (source?.archive.evidenceFiles(repo, name).length ?? 0), 0);
  const unread = source?.aliases.problem();
  if (unread !== undefined) fail(`ledger store migrate stopped, and nothing changed: not every alias of the ${STORAGE_NAME[from]} can be read. ${unread}`);

  if (target !== undefined) {
    const conflict = (place: string, collection: LedgerCollection) => (ledger: StoredLedger) =>
      redacted(`  ${place} ${shortName(ledger)}  ${paths.tilde(collection.location(ledger.repo, ledger.name))}`);
    const conflicts = [
      ...backlog.filter(({ repo, name }) => target.backlog.has(repo, name)).map(conflict('backlog', target.backlog)),
      ...archive.filter(({ repo, name }) => target.archive.nameTaken(repo, name)).map(conflict('archive', target.archive)),
    ];
    if (conflicts.length > 0) {
      const summary = `ledger store migrate stopped, and nothing changed: the ${STORAGE_NAME[to]} already has ${plural(conflicts.length, 'name')} to copy. A ledger with identical text counts too.`;
      fail([summary, ...conflicts].join('\n'));
    }
    const kept = target.aliases.read();
    const otherKeys = [...(source?.aliases.read() ?? [])].flatMap(([old, key]) => {
      const theirs = kept.get(old);
      return theirs === undefined || theirs === key ? [] : [`${old} is an alias of ${theirs}, not of ${key}`];
    });
    if (otherKeys.length > 0) fail(`ledger store migrate stopped, and nothing changed: in the ${STORAGE_NAME[to]}, ${joined(otherKeys)}. An alias is never changed.`);
    const refused = target.aliases.problem();
    if (refused !== undefined) fail(`ledger store migrate stopped, and nothing changed: the ${STORAGE_NAME[to]} takes no alias. ${refused} Fix or remove that alias first.`);
  }

  const moved = new Map(
    target === undefined
      ? []
      : [
          ...backlog.map((ledger) => [ledger.location, target.backlog.location(ledger.repo, ledger.name)] as const),
          ...archive.map((ledger) => [ledger.location, target.archive.location(ledger.repo, ledger.name)] as const),
        ],
  );
  const sourceRegistry = source?.registry.read();
  const sourceAll = parsed(sourceRegistry);
  // Such entries would all share one key, so they could neither be merged nor checked.
  const sourceEntries = sourceAll.filter((entry) => entryKey(entry) !== undefined).map((entry) => relocated(entry, moved));
  const skipped = sourceAll.length - sourceEntries.length;
  const missingFrom = (entries: RegistryEntry[]): RegistryEntry[] => {
    const taken = new Set(entries.map(entryKey));
    return sourceEntries.filter((entry) => !taken.has(entryKey(entry)));
  };
  const added = missingFrom(parsed(target?.registry.read()));
  // Merged with the registry as it is at the write, so an entry another command added since this read stays.
  const mergeRegistry: Change<string | undefined> = (current) => {
    const entries = parsed(current);
    const adding = missingFrom(entries);
    return adding.length > 0 ? registryText([...entries, ...adding].sort(newestFirst)) : undefined;
  };

  const act = (done: string, planned: string): string => (dryRun ? `would ${planned}` : done);
  const writing = !dryRun && source !== undefined && target !== undefined;
  line(`Migrate from ${STORAGE_NAME[from]} to ${STORAGE_NAME[to]}${dryRun ? ' · dry run, nothing changed' : ''}`);

  if (writing) {
    const stopped = (reason: string, undone: string): string =>
      `ledger store migrate stopped: ${reason} ${undone} The setting stays "${setting}", and nothing was removed from the ${STORAGE_NAME[from]}.`;
    const kept = target.aliases.read();
    const aliases = [...source.aliases.read()].filter(([old]) => !kept.has(old));
    copyChecked(source, target, { backlog, archive, aliases, evidenceRoot, entries: sourceEntries, mergeRegistry, targetName: STORAGE_NAME[to] }, stopped);
  }
  line(`${act('copied', 'copy')} ${plural(backlog.length, 'backlog ledger')}`);
  line(`${act('copied', 'copy')} ${plural(archive.length, 'archive copy', 'archive copies')} with ${plural(evidenceCount, 'evidence file')}`);
  const merge = [`${added.length} added`, `${sourceEntries.length - added.length} kept as the ${STORAGE_NAME[to]} has them`];
  if (skipped > 0) merge.push(`${skipped} skipped as archived with no archive path`);
  line(`${act('merged', 'merge')} ${plural(sourceEntries.length, 'registry entry', 'registry entries')}: ${merge.join(', ')}`);
  line(`${act('checked', 'check')} that every copy reads back the same, evidence bytes included`);

  const settings = shownSettingsFile(paths.home);
  if (setting === to) line(`setting "storage" is already "${to}" in ${settings}`);
  else {
    if (!dryRun) writeStorage(paths.home, to);
    line(`${act('switched', 'switch')} "storage" from "${setting}" to "${to}" in ${settings}`);
  }

  let removed = 'nothing';
  if (!removeSource) line(`kept the ${STORAGE_NAME[from]} as it was; --remove-source removes what was copied`);
  else {
    const hadRegistry = sourceRegistry !== undefined;
    removed = removedText(
      writing
        ? remove(source, { backlog, archive, evidenceRoot, entries: hadRegistry ? sourceAll : undefined }, line)
        : { backlog: backlog.length, archive: archive.length, registry: hadRegistry ? sourceEntries.length : undefined },
    );
    line(`${act('removed', 'remove')} ${removed} from the ${STORAGE_NAME[from]}`);
  }

  const copied = joined([
    plural(backlog.length, 'backlog ledger'),
    plural(archive.length, 'archive copy', 'archive copies'),
    plural(evidenceCount, 'evidence file'),
    plural(added.length, 'registry entry', 'registry entries'),
  ]);
  line(`${dryRun ? 'Would copy' : 'Copied'} ${copied}; ${dryRun ? 'would remove' : 'removed'} ${removed}.`);
}

type Copied = { backlog: StoredLedger[]; archive: StoredLedger[] };

/** What a copy wrote to the target, so a copy that stops can take it back: aliases, by old key and key, too. */
type Written = Copied & { aliases: [string, string][] };

type Planned = Written & { evidenceRoot: string };

const evidenceFolder = (evidenceRoot: string, index: number): string => path.join(evidenceRoot, String(index));

/** The registry text before and after this run's write; neither is set when it wrote none. */
type RegistryWrite = { before?: string; after?: string };

/**
 * Copies `planned` and merges its registry entries into `target` with `mergeRegistry`, reads it all back, and commits
 * it where the target commits. When any of that throws or reads back different, it removes each ledger and alias it
 * wrote, puts back the registry the target had, and fails.
 */
function copyChecked(
  source: LedgerStore,
  target: LedgerStore,
  planned: Planned & { entries: RegistryEntry[]; mergeRegistry: Change<string | undefined>; targetName: string },
  stopped: (reason: string, undone: string) => string,
): void {
  const written: Written = { backlog: [], archive: [], aliases: [] };
  const registry: RegistryWrite = {};
  let differs: string[];
  try {
    copy(source, target, planned, written);
    target.registry.update((current) => {
      const merged = planned.mergeRegistry(current);
      if (merged !== undefined) Object.assign(registry, { before: current, after: merged });
      return merged;
    });
    differs = check(source, target, planned);
    // Before the setting switches or --remove-source removes anything, so a commit git storage refuses changes neither.
    // It must hold the text read from the source, not only some text: another command may change a copy after the check.
    const expected = (place: WrittenLedger['place']) => ({ repo, name, text }: StoredLedger): WrittenLedger => ({ place, repo, name, text });
    if (differs.length === 0) target.commit?.([...planned.backlog.map(expected('backlog')), ...planned.archive.map(expected('archive'))]);
  } catch (error) {
    return fail(redacted(stopped(`copying to the ${planned.targetName} failed: ${messageOf(error)}.`, undo(target, written, registry, planned.targetName))));
  }
  if (differs.length > 0) {
    const reason = `${plural(differs.length, 'copy', 'copies')} in the ${planned.targetName} read back different.`;
    fail(redacted([stopped(reason, undo(target, written, registry, planned.targetName)), ...differs.map((what) => `  ${what}`)].join('\n')));
  }
}

/**
 * A ledger is noted in `written` once its write succeeded, so a name another command took since the check is never
 * removed. An archive write that fails is noted only when this process made the copy, as it may have written half.
 */
function copy(source: LedgerStore, target: LedgerStore, { backlog, archive, aliases, evidenceRoot }: Planned, written: Written): void {
  // Before the ledgers, so a copy is never in the target without the alias that finds it under an old key.
  for (const [old, key] of aliases) {
    target.aliases.add(old, key);
    written.aliases.push([old, key]);
  }
  for (const ledger of backlog) {
    const { repo, name, text, mtimeMs } = ledger;
    if (!target.backlog.create(repo, name, text)) fail(`another command wrote backlog ${shortName(ledger)} after the check for names already taken`);
    written.backlog.push(ledger);
    target.backlog.setModified?.(repo, name, mtimeMs);
  }
  archive.forEach((ledger, index) => {
    const { repo, name, text, mtimeMs } = ledger;
    const folder = evidenceFolder(evidenceRoot, index);
    source.archive.copyEvidence(repo, name, folder);
    const wasFree = !target.archive.nameTaken(repo, name);
    try {
      target.archive.write(repo, name, text, exists(folder) ? folder : undefined);
    } catch (error) {
      if (!(error instanceof NameTaken) && wasFree && wasCreatedHere(target.archive.location(repo, name))) written.archive.push(ledger);
      throw error;
    }
    written.archive.push(ledger);
    target.archive.setModified?.(repo, name, mtimeMs);
  });
}

type Removal = 'removed' | 'changed' | 'hidden';

/** What `remove` did: 'changed' when it removed nothing as the ledger changed, 'hidden' when it refused one whose record hides Markdown. */
function removal(remove: () => boolean): Removal {
  try {
    return remove() ? 'removed' : 'changed';
  } catch (error) {
    if (error instanceof HiddenMarkdown) return 'hidden';
    throw error;
  }
}

const KEPT_BECAUSE: Record<Exclude<Removal, 'removed'>, string> = { changed: 'it changed after the copy', hidden: 'its record hides Markdown from before records' };

/**
 * Removes from `target` each ledger and alias in `written`, and puts back the registry it had while it is still what this
 * run wrote. A backlog ledger another command changed since the copy stays, and so does a copy whose record hides
 * Markdown. Says what it did, as a sentence.
 */
function undo(target: LedgerStore, written: Written, registry: RegistryWrite, targetName: string): string {
  try {
    const outcomes = [
      ...written.backlog.filter(({ repo, name }) => target.backlog.has(repo, name)).map((ledger) => [`backlog ${shortName(ledger)}`, removal(() => target.backlog.remove(ledger.repo, ledger.name, ledger.text))] as const),
      ...written.archive.filter(({ repo, name }) => target.archive.has(repo, name)).map((ledger) => [`archive ${shortName(ledger)}`, removal(() => target.archive.remove(ledger.repo, ledger.name))] as const),
    ];
    const kept = (outcome: Removal): string[] => outcomes.flatMap(([what, done]) => (done === outcome ? [what] : []));
    const [changed, hidden] = [kept('changed'), kept('hidden')];
    for (const [old, key] of written.aliases) target.aliases.remove(old, key);
    const { before, after } = registry;
    if (after !== undefined) {
      // Update cannot remove, so a registry the target did not have is removed after a separate read.
      if (before !== undefined) target.registry.update((current) => (current === after ? before : undefined));
      else if (target.registry.read() === after) target.registry.remove();
    }
    const except = [
      ...(changed.length > 0 ? [`${joined(changed)}, which another command changed after the copy`] : []),
      ...hidden.map((what) => `${what}, whose record hides Markdown from before records`),
    ];
    if (except.length > 0) return `The copies it made in the ${targetName} were removed again, except ${except.join(', and ')}.`;
    return `Every copy it made in the ${targetName} was removed again.`;
  } catch (error) {
    return `Removing the copies it made failed too, so some stay in the ${targetName}: ${messageOf(error)}.`;
  }
}

/** What reads back from `target` unlike the source: a ledger's text, an evidence tree or file, or a registry entry. */
function check(source: LedgerStore, target: LedgerStore, { backlog, archive, evidenceRoot, entries }: Planned & { entries: RegistryEntry[] }): string[] {
  const differs: string[] = [];
  for (const ledger of backlog) if (target.backlog.read(ledger.repo, ledger.name)?.text !== ledger.text) differs.push(`backlog ${shortName(ledger)}`);
  archive.forEach((ledger, index) => {
    const { repo, name } = ledger;
    const folder = evidenceFolder(evidenceRoot, index);
    const expected = holdsAnything(folder) ? 'same' : 'none';
    const files = source.archive.evidenceFiles(repo, name);
    const sameFiles =
      files.join('\n') === target.archive.evidenceFiles(repo, name).join('\n') &&
      files.every((file) => {
        const [copied, original] = [target.archive.readEvidence(repo, name, file), source.archive.readEvidence(repo, name, file)];
        return copied !== undefined && original !== undefined && copied.equals(original);
      });
    if (target.archive.read(repo, name)?.text !== ledger.text) differs.push(`archive ${shortName(ledger)}`);
    else {
      const states = [source, target].map((store) => store.archive.evidenceState(repo, name, folder));
      if (states.some((state) => state !== expected) || !sameFiles) differs.push(`evidence of ${shortName(ledger)}`);
    }
  });
  const kept = new Set(parsed(target.registry.read()).map(entryKey));
  for (const entry of entries) if (!kept.has(entryKey(entry))) differs.push(`registry entry ${entry.repo}/${entry.slug}`);
  return differs;
}

/** `registry` is undefined when the source had none. */
type Removed = { backlog: number; archive: number; registry: number | undefined };

/**
 * Removes from `source` what was copied and checked. A backlog ledger or archive copy that changed since the copy stays,
 * evidence included, and so does its registry entry, with each entry that was not copied.
 */
function remove(
  source: LedgerStore,
  { backlog, archive, evidenceRoot, entries }: Copied & { evidenceRoot: string; entries: RegistryEntry[] | undefined },
  line: (text: string) => void,
): Removed {
  const kept = new Set<string>();
  for (const ledger of backlog) {
    // Another session may have written to it since the copy; that text is in no copy, so it stays.
    if (!source.backlog.has(ledger.repo, ledger.name)) {
      line(`backlog ${shortName(ledger)} is already gone from the source`);
      kept.add(ledger.location);
      continue;
    }
    const done = removal(() => source.backlog.remove(ledger.repo, ledger.name, ledger.text));
    if (done !== 'removed') {
      line(`kept backlog ${shortName(ledger)} in the source: ${KEPT_BECAUSE[done]}`);
      kept.add(ledger.location);
    }
  }
  const backlogRemoved = backlog.length - kept.size;
  let archiveRemoved = 0;
  archive.forEach((copy, index) => {
    if (!source.archive.nameTaken(copy.repo, copy.name)) return line(`archive ${shortName(copy)} is already gone from the source`);
    // Checked against what was copied, as another command may have changed the copy or its evidence since.
    const done = removal(() => source.archive.remove(copy.repo, copy.name, { text: copy.text, evidence: evidenceFolder(evidenceRoot, index) }));
    if (done === 'removed') archiveRemoved++;
    else {
      line(`kept archive ${shortName(copy)} in the source: ${KEPT_BECAUSE[done]}`);
      kept.add(copy.location);
    }
  });
  const removed = { backlog: backlogRemoved, archive: archiveRemoved };
  if (entries === undefined) return { ...removed, registry: undefined };
  const copied = new Set(entries.flatMap((entry) => entryKey(entry) ?? []).filter((key) => !kept.has(key)));
  let before = 0;
  let stays: RegistryEntry[] = [];
  // Filtered as the registry is at the write, so an entry another command added since the copy stays.
  source.registry.update((current) => {
    const now = parsed(current);
    before = now.length;
    stays = now.filter((entry) => {
      const key = entryKey(entry);
      return key === undefined || !copied.has(key);
    });
    return stays.length > 0 ? registryText(stays) : undefined;
  });
  // Update cannot remove; an empty registry goes, so the next load rebuilds it.
  if (stays.length === 0) source.registry.remove();
  return { ...removed, registry: before - stays.length };
}

const removedText = ({ backlog, archive, registry }: Removed): string =>
  joined([
    plural(backlog, 'backlog ledger'),
    plural(archive, 'archive copy', 'archive copies'),
    ...(registry === undefined ? [] : [plural(registry, 'registry entry', 'registry entries')]),
  ]);
