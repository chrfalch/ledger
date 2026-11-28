import { fail } from '../tools/ledger/failure.js';
import { holdsAnything } from '../tools/ledger/files.js';
import { newLabelColours, type LabelColour } from '../tools/ledger/labels.js';
import { recordToWrite, renderRecord, type TaskRecord } from '../tools/ledger/record.js';
import { runClock } from '../tools/ledger/run-io.js';
import { evidenceIn, sameEvidence, writeEvidence, type EvidenceEntry } from '../tools/ledger/sqlite-store.js';
import {
  byCodeUnit,
  checkedAliases,
  findWorktree,
  isAsChecked,
  NameTaken,
  needsAlias,
  noteCreated,
  resolvedWorktree,
  type Archive,
  type Backlog,
  type LedgerCollection,
  type LedgerStore,
  type StoredLedger,
} from '../tools/ledger/store.js';

type Place = 'backlog' | 'active' | 'archive';
/** A ledger as the memory store keeps it; only an archive copy has evidence. */
type Kept = { repo: string; name: string; record: TaskRecord; mtimeMs: number; birthtimeMs: number; evidence: EvidenceEntry[] };
type Memory = { ledgers: Record<Place, Map<string, Kept>>; aliases: Map<string, string>; labels: Map<string, LabelColour> };

const memories = new Map<string, Memory>();

const keyOf = (repo: string, name: string): string => JSON.stringify([repo, name]);
// As the file store orders <name>.md, where fix-login.md comes before fix.md.
const byFileName = (a: { name: string }, b: { name: string }): number => byCodeUnit(`${a.name}.md`, `${b.name}.md`);

function memoryOf(home: string): Memory {
  let memory = memories.get(home);
  if (memory === undefined) {
    memory = { ledgers: { backlog: new Map(), active: new Map(), archive: new Map() }, aliases: new Map(), labels: new Map() };
    memories.set(home, memory);
  }
  return memory;
}

/**
 * A store that keeps its ledgers in this process's memory, for tests. There is one per HOME, so a store opened again on
 * the same HOME reads what the first one wrote. It keeps no Markdown from before task records and none of the parts
 * only git storage has. A location, such as memory:<home>/backlog/<repo>/<name>, names no file. Evidence is read from
 * a real folder and written back to one, as the SQLite store does.
 */
export function memoryStore({ home }: { home: string }): LedgerStore {
  const memory = memoryOf(home);
  const at = (place: string, repo?: string, name?: string): string =>
    [`memory:${home}`, place, ...(repo === undefined ? [] : [encodeURIComponent(repo)]), ...(name === undefined ? [] : [name])].join('/');

  const kept = (place: Place, repo: string, name: string): Kept | undefined => memory.ledgers[place].get(keyOf(repo, name));
  const existing = (place: Place, repo: string, name: string): Kept => kept(place, repo, name) ?? fail(`${at(place, repo, name)} does not exist.`);
  const stored = (place: Place, { repo, name, record, mtimeMs, birthtimeMs }: Kept): StoredLedger => ({
    repo,
    name,
    text: renderRecord(record),
    mtimeMs,
    birthtimeMs,
    location: at(place, repo, name),
  });

  /** Keeps `text` as the record of `name`, which keeps the created time of the ledger it replaces. */
  function put(place: Place, repo: string, name: string, text: string, evidence: EvidenceEntry[] = []): void {
    const record = recordToWrite(text, at(place, repo, name));
    const now = runClock().now().getTime();
    memory.ledgers[place].set(keyOf(repo, name), { repo, name, record, mtimeMs: now, birthtimeMs: kept(place, repo, name)?.birthtimeMs ?? now, evidence });
  }

  const canMove = (place: Place, repo: string, name: string, to: string): boolean => kept(place, repo, name) !== undefined && kept(place, to, name) === undefined;

  function move(place: Place, repo: string, name: string, to: string): boolean {
    const ledger = existing(place, repo, name);
    if (kept(place, to, name) !== undefined) return false;
    memory.ledgers[place].delete(keyOf(repo, name));
    memory.ledgers[place].set(keyOf(to, name), { ...ledger, repo: to });
    return true;
  }

  function collection(place: Place): LedgerCollection {
    const ledgers = memory.ledgers[place];
    return {
      location: (repo, name) => at(place, repo, name),
      repoLocation: (repo) => (repo === undefined ? at(place) : at(place, repo)),
      repos: () => [...new Set([...ledgers.values()].map(({ repo }) => repo))].sort(byCodeUnit),
      list: (repo) =>
        [...ledgers.values()]
          .filter((ledger) => ledger.repo === repo)
          .sort(byFileName)
          .map((ledger) => stored(place, ledger)),
      // A record is checked before it is kept, so every one reads.
      unreadable: () => [],
      read: (repo, name) => {
        const ledger = kept(place, repo, name);
        return ledger && stored(place, ledger);
      },
      has: (repo, name) => kept(place, repo, name) !== undefined,
      setModified: (repo, name, mtimeMs) => {
        existing(place, repo, name).mtimeMs = mtimeMs;
      },
    };
  }

  function writable(place: 'backlog' | 'active'): Backlog {
    const ledgers = collection(place);
    const currentText = (repo: string, slug: string): string => stored(place, existing(place, repo, slug)).text;
    return {
      ...ledgers,
      write: (repo, slug, text) => put(place, repo, slug, text),
      create: (repo, slug, text) => {
        if (ledgers.has(repo, slug)) return false;
        put(place, repo, slug, text);
        return true;
      },
      update: (repo, slug, change) => {
        const text = change(currentText(repo, slug));
        if (text !== undefined) put(place, repo, slug, text);
        return text !== undefined;
      },
      remove: (repo, slug, expected) => currentText(repo, slug) === expected && memory.ledgers[place].delete(keyOf(repo, slug)),
      move: (repo, slug, to) => move(place, repo, slug, to),
      canMove: (repo, slug, to) => canMove(place, repo, slug, to),
    };
  }

  const archive = collection('archive');
  const evidenceLocation = (repo: string, name: string): string => at('evidence', repo, name);
  const archived = (repo: string, name: string): EvidenceEntry[] => kept('archive', repo, name)?.evidence ?? [];
  const evidenceState: Archive['evidenceState'] = (repo, name, from) => {
    try {
      const evidence = archived(repo, name);
      const folder = from !== undefined && holdsAnything(from) ? evidenceIn(from) : undefined;
      if (evidence.length === 0) return folder === undefined ? 'none' : 'differs';
      return folder !== undefined && sameEvidence(evidence, folder) ? 'same' : 'differs';
    } catch {
      // A folder that cannot be read may hold anything.
      return 'differs';
    }
  };

  const aliasesWhere = at('aliases');

  return {
    backlog: writable('backlog'),
    active: {
      ...writable('active'),
      byWorktree: (folder) =>
        findWorktree(
          folder,
          resolvedWorktree(folder),
          [...memory.ledgers.active.values()].flatMap(({ repo, name: slug, record: { worktree, lost } }) => (worktree !== undefined && lost === undefined ? [{ repo, slug, worktree }] : [])),
        ),
    },
    archive: {
      ...archive,
      write: (repo, name, text, evidenceFrom) => {
        const evidence = evidenceFrom === undefined ? [] : evidenceIn(evidenceFrom);
        if (archive.has(repo, name)) throw new NameTaken(`${archive.location(repo, name)} already exists. An archive copy is never replaced.`);
        put('archive', repo, name, text, evidence);
        noteCreated(archive.location(repo, name));
        if (evidenceFrom !== undefined && !sameEvidence(evidence, evidenceIn(evidenceFrom))) {
          fail(`The evidence copy ${evidenceLocation(repo, name)}/ differs from ${evidenceFrom}/.`);
        }
      },
      evidenceState,
      nameTaken: (repo, name) => archive.has(repo, name),
      evidenceLocation,
      evidenceFiles: (repo, name) =>
        archived(repo, name)
          .flatMap((entry) => (entry.kind === 'file' ? [entry.path] : []))
          .sort(byCodeUnit),
      readEvidence: (repo, name, file) => {
        const entry = archived(repo, name).find((each) => each.kind === 'file' && each.path === file);
        return entry && Buffer.from(entry.data);
      },
      copyEvidence: (repo, name, to) => writeEvidence(archived(repo, name), to, evidenceLocation(repo, name)),
      remove: (repo, name, expected) => {
        existing('archive', repo, name);
        if (expected !== undefined && !isAsChecked({ read: archive.read, evidenceState }, repo, name, expected)) return false;
        return memory.ledgers.archive.delete(keyOf(repo, name));
      },
      move: (repo, name, to) => move('archive', repo, name, to),
      canMove: (repo, name, to) => canMove('archive', repo, name, to),
      // Evidence is kept with its copy, so none is ever left without one.
      orphanEvidence: () => [],
    },
    oldTaskList: () => undefined,
    aliases: {
      read: () => checkedAliases(memory.aliases).aliases,
      problem: () => checkedAliases(memory.aliases).problem,
      add: (old, key) => {
        if (needsAlias(memory.aliases, old, key, aliasesWhere)) memory.aliases.set(old, key);
      },
      remove: (old, key) => {
        if (memory.aliases.get(old) === key) memory.aliases.delete(old);
      },
      replace: (removed, added) => {
        const aliases = new Map(memory.aliases);
        for (const [old, key] of removed) if (aliases.get(old) === key) aliases.delete(old);
        for (const [old, key] of added) if (needsAlias(aliases, old, key, aliasesWhere)) aliases.set(old, key);
        memory.aliases = aliases;
      },
    },
    labels: {
      read: () => new Map(memory.labels),
      register: (labels, firstUsed) => {
        for (const [label, colour] of newLabelColours(memory.labels, labels, firstUsed)) memory.labels.set(label, colour);
      },
      copy: (entries) => {
        for (const [label, colour] of entries) if (!memory.labels.has(label)) memory.labels.set(label, colour);
      },
    },
  };
}
