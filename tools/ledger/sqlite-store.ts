import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { fail } from './failure.js';
import { holdsAnything, treeEntries } from './files.js';
import { shownSettingsFile } from './settings.js';
import { parseRecord, readRecordJson, recordJson, recordToWrite, renderRecord, type TaskRecord } from './record.js';
import { byCodeUnit, checkedAliases, isAsChecked, NameTaken, needsAlias, noteCreated, readable, refuseHiddenMarkdown, type Archive, type LedgerCollection, type LedgerStore, type StoredLedger } from './store.js';
import { pauseForTest } from './wait.js';

// The text of a ledger from before records is UTF-8 in a BLOB: node:sqlite on Node 22 cuts a TEXT value short at a NUL
// byte. A record is TEXT, as JSON writes a NUL byte as \u0000.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ledgers (
    place TEXT NOT NULL CHECK (place IN ('backlog', 'archive')),
    repo TEXT NOT NULL,
    name TEXT NOT NULL,
    text BLOB NOT NULL,
    created_ms REAL NOT NULL,
    modified_ms REAL NOT NULL,
    PRIMARY KEY (place, repo, name)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS records (
    place TEXT NOT NULL CHECK (place IN ('backlog', 'archive')),
    repo TEXT NOT NULL,
    name TEXT NOT NULL,
    record TEXT NOT NULL,
    mtime REAL NOT NULL,
    birthtime REAL NOT NULL,
    parent TEXT GENERATED ALWAYS AS (json_extract(record, '$.parent.slug')) VIRTUAL,
    state TEXT GENERATED ALWAYS AS (json_extract(record, '$.state')) VIRTUAL,
    PRIMARY KEY (place, repo, name)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS evidence (
    repo TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'folder', 'link')),
    data BLOB NOT NULL,
    PRIMARY KEY (repo, name, path)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS registry (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    text TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS aliases (
    old TEXT PRIMARY KEY,
    repo TEXT NOT NULL
  ) STRICT;
`;

/** The database of the SQLite store. */
export const sqliteFile = (home: string): string => path.join(home, '.claude', 'ledgers.db');

const BUSY_TIMEOUT_MS = 5_000;
const SQLITE_BUSY = 5;

const SQLITE_WARNING = 'SQLite is an experimental feature and might change at any time';

type Place = 'backlog' | 'archive';
/** One entry of an evidence folder: a file with its bytes, a folder, or a symbolic link with its text as bytes. */
type EvidenceEntry = { path: string; kind: 'file' | 'folder' | 'link'; data: Uint8Array };

/** The type of a warning, from any of the forms process.emitWarning takes. */
const warningType = (warning: string | Error, options: unknown): string | undefined =>
  typeof warning !== 'string' ? warning.name : typeof options === 'string' ? options : (options as { type?: string } | undefined)?.type;

/**
 * Runs `load` without the warning that SQLite is experimental, which Node 22.13 to 24 prints to stderr when node:sqlite
 * loads; it would land in the stderr of every hook. Every other warning passes through.
 */
function withoutSqliteWarning<T>(load: () => T): T {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning: string | Error, ...rest: unknown[]): void => {
    const message = typeof warning === 'string' ? warning : warning.message;
    const isSqliteWarning = warningType(warning, rest[0]) === 'ExperimentalWarning' && message === SQLITE_WARNING;
    if (!isSqliteWarning) Reflect.apply(emitWarning, process, [warning, ...rest]);
  };
  try {
    return load();
  } finally {
    process.emitWarning = emitWarning;
  }
}

/**
 * node:sqlite, or undefined on a Node without it. It loads only here, through require, so the file store runs on a Node
 * without it. Not process.getBuiltinModule, which a module resolve hook cannot stop, so a test can stand in for an older Node.
 */
export function loadSqlite(): typeof import('node:sqlite') | undefined {
  try {
    return withoutSqliteWarning(() => createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'));
  } catch {
    return undefined;
  }
}

/** With `readOnly`, the database must be there, and its schema stays as it is, so a dry run changes nothing. */
function openDatabase(file: string, home: string, readOnly: boolean): DatabaseSync {
  const sqlite =
    loadSqlite() ??
    fail(
      `SQLite storage needs Node 22.13 or later, and 23.4 or later on Node 23. This is Node ${process.versions.node}. Run a newer Node, or set "storage" to "file" in ${shownSettingsFile(home)}.`,
    );
  if (!readOnly) mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file, { readOnly });
  // Hooks and commands of several sessions may write at once; each waits for the others' short transactions.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  if (!readOnly) db.exec(SCHEMA);
  return db;
}

/** The entries of `folder` by relative path. Throws for anything at `folder` but a folder, and for any other kind of entry. */
function evidenceIn(folder: string): EvidenceEntry[] {
  if (!lstatSync(folder).isDirectory()) fail(`${folder} is not a folder.`);
  return treeEntries(folder).map((entry): EvidenceEntry => {
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(folder, file);
    if (entry.isSymbolicLink()) return { path: relative, kind: 'link', data: readlinkSync(file, { encoding: 'buffer' }) };
    if (entry.isDirectory()) return { path: relative, kind: 'folder', data: new Uint8Array() };
    if (entry.isFile()) return { path: relative, kind: 'file', data: readFileSync(file) };
    return fail(`${file} is not a file, folder or symbolic link, so it cannot be archived.`);
  });
}

function sameEvidence(a: EvidenceEntry[], b: EvidenceEntry[]): boolean {
  const byPath = new Map(b.map((entry) => [entry.path, entry]));
  return (
    a.length === b.length &&
    a.every(({ path: file, kind, data }) => {
      const other = byPath.get(file);
      return other?.kind === kind && Buffer.compare(data, other.data) === 0;
    })
  );
}

/**
 * The folder `relative` in `root`, a real path, with each missing part made. Each part that is there must be a folder
 * whose real path, as the volume spells it, is the one asked for; a symbolic link is not, nor, on a volume that ignores
 * case, a name that differs only in case. Otherwise `outside` fails.
 */
function realFolderIn(root: string, relative: string, outside: () => never): string {
  let folder = root;
  for (const part of relative.split('/').filter((part) => part !== '.')) {
    folder = path.join(folder, part);
    if (lstatSync(folder, { throwIfNoEntry: false }) === undefined) mkdirSync(folder);
    else if (realpathSync.native(folder) !== folder) outside();
  }
  return folder;
}

/**
 * The ledger store as one SQLite database, <home>/.claude/ledgers.db: backlog ledgers, archive copies with the bytes of
 * their evidence, and the registry. A location is the database file and a place in it, such as
 * ~/.claude/ledgers.db:archive/app/2026-11-01-fix-login, and names no file of its own.
 */
export function sqliteStore({ home }: { home: string }, { readOnly = false } = {}): LedgerStore {
  const file = sqliteFile(home);
  const db = openDatabase(file, home, readOnly);
  const all = <T>(sql: string, ...params: SQLInputValue[]): T[] => db.prepare(sql).all(...params) as T[];
  const one = <T>(sql: string, ...params: SQLInputValue[]): T | undefined => db.prepare(sql).get(...params) as T | undefined;
  const run = (sql: string, ...params: SQLInputValue[]): number => Number(db.prepare(sql).run(...params).changes);

  const failIfBusy = (error: unknown): void => {
    if ((error as { errcode?: number }).errcode === SQLITE_BUSY) {
      fail(`Another ledger command has been writing ${file} for more than ${BUSY_TIMEOUT_MS / 1000} seconds, so this one gave up. Try again.`);
    }
  };

  /** Runs `work` as one write transaction: other commands' writes wait for it, and a throw undoes it. Every write goes through it. */
  function transaction<T>(work: () => T): T {
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      failIfBusy(error);
      throw error;
    }
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The error that made the transaction fail says what went wrong; a failed rollback must not hide it.
      }
      failIfBusy(error);
      throw error;
    }
  }

  // A record, else a row of ledgers from before records. A database opened read-only from before records has only ledgers.
  const recordsTable = one(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'records'`) !== undefined;
  const STORED = !recordsTable
    ? '(SELECT place, repo, name, NULL AS record, text, created_ms, modified_ms FROM ledgers)'
    : `(SELECT place, repo, name, record, NULL AS text, birthtime AS created_ms, mtime AS modified_ms FROM records
        UNION ALL
        SELECT place, repo, name, NULL, text, created_ms, modified_ms FROM ledgers l
        WHERE NOT EXISTS (SELECT 1 FROM records r WHERE r.place = l.place AND r.repo = l.repo AND r.name = l.name))`;

  // As the file store orders <name>.md, where fix-login.md comes before fix.md.
  const byFileName = (a: { name: string }, b: { name: string }): number => byCodeUnit(`${a.name}.md`, `${b.name}.md`);

  function collection(place: Place): LedgerCollection {
    const location = (repo: string, name: string): string => `${file}:${place}/${repo}/${name}`;
    type Row = { repo: string; name: string; record: string | null; text: Uint8Array | null; created_ms: number; modified_ms: number };
    const markdownOf = (text: Uint8Array | null): string => Buffer.from(text ?? new Uint8Array()).toString('utf8');
    /** The row of ledgers that `name` is still kept as, which no record hides. */
    const markdownRow = (repo: string, name: string): Row | undefined => one<Row>(`SELECT * FROM ${STORED} WHERE place = ? AND repo = ? AND name = ? AND record IS NULL`, place, repo, name);
    const stored = ({ repo, name, record, text, created_ms, modified_ms }: Row): StoredLedger => ({
      repo,
      name,
      text: renderRecord(record === null ? parseRecord(markdownOf(text)) : readRecordJson(record, location(repo, name))),
      mtimeMs: modified_ms,
      birthtimeMs: created_ms,
      location: location(repo, name),
    });
    return {
      location,
      repoLocation: (repo) => (repo === undefined ? `${file}:${place}` : `${file}:${place}/${repo}`),
      repos: () =>
        all<{ repo: string }>(`SELECT DISTINCT repo FROM ${STORED} WHERE place = ?`, place)
          .map(({ repo }) => repo)
          .sort(byCodeUnit),
      list: (repo) =>
        all<Row>(`SELECT * FROM ${STORED} WHERE place = ? AND repo = ?`, place, repo)
          .sort(byFileName)
          .flatMap((row) => readable(() => stored(row)) ?? []),
      read: (repo, name) => {
        const row = one<Row>(`SELECT * FROM ${STORED} WHERE place = ? AND repo = ? AND name = ?`, place, repo, name);
        return row && stored(row);
      },
      has: (repo, name) => hasLedger(place, repo, name),
      setModified: (repo, name, mtimeMs) =>
        transaction(() => {
          const changed =
            run('UPDATE records SET mtime = ? WHERE place = ? AND repo = ? AND name = ?', mtimeMs, place, repo, name) ||
            run('UPDATE ledgers SET modified_ms = ? WHERE place = ? AND repo = ? AND name = ?', mtimeMs, place, repo, name);
          if (changed === 0) fail(`${location(repo, name)} does not exist.`);
        }),
      hiddenMarkdown: (repo) =>
        (!recordsTable ? [] : all<{ name: string }>('SELECT l.name FROM ledgers l JOIN records r USING (place, repo, name) WHERE l.place = ? AND l.repo = ?', place, repo))
          .sort(byFileName)
          .map(({ name }) => name),
      markdownNames: (repo) =>
        all<{ name: string }>(`SELECT name FROM ${STORED} WHERE place = ? AND repo = ? AND record IS NULL`, place, repo)
          .sort(byFileName)
          .map(({ name }) => name),
      markdownText: (repo, name) => {
        const row = markdownRow(repo, name);
        return row && markdownOf(row.text);
      },
      toRecord: (repo, name) =>
        transaction(() => {
          const row = markdownRow(repo, name);
          if (row === undefined) return false;
          putRecord(place, repo, name, recordToWrite(markdownOf(row.text), location(repo, name)), row.modified_ms);
          return true;
        }),
    };
  }

  const backlog = collection('backlog');
  const archive = collection('archive');
  const evidenceLocation = (repo: string, name: string): string => `${file}:evidence/${repo}/${name}`;
  const archived = (repo: string, name: string): EvidenceEntry[] => all<EvidenceEntry>('SELECT path, kind, data FROM evidence WHERE repo = ? AND name = ?', repo, name);
  const evidenceFiles = (repo: string, name: string): string[] =>
    all<{ path: string }>(`SELECT path FROM evidence WHERE repo = ? AND name = ? AND kind = 'file'`, repo, name)
      .map(({ path: relative }) => relative)
      // Not ORDER BY: SQLite compares UTF-8 bytes, which order some names apart from the file store's code units.
      .sort(byCodeUnit);
  const evidenceState: Archive['evidenceState'] = (repo, name, from) => {
    try {
      const kept = archived(repo, name);
      const folder = from !== undefined && holdsAnything(from) ? evidenceIn(from) : undefined;
      if (kept.length === 0) return folder === undefined ? 'none' : 'differs';
      return folder !== undefined && sameEvidence(kept, folder) ? 'same' : 'differs';
    } catch {
      // A folder that cannot be read may hold anything.
      return 'differs';
    }
  };

  function hasLedger(place: Place, repo: string, name: string): boolean {
    return one(`SELECT 1 FROM ${STORED} WHERE place = ? AND repo = ? AND name = ?`, place, repo, name) !== undefined;
  }

  const hasRecord = (place: Place, repo: string, name: string): boolean => one('SELECT 1 FROM records WHERE place = ? AND repo = ? AND name = ?', place, repo, name) !== undefined;
  const hidesMarkdown = (place: Place, repo: string, name: string): boolean =>
    one('SELECT 1 FROM ledgers l JOIN records r USING (place, repo, name) WHERE l.place = ? AND l.repo = ? AND l.name = ?', place, repo, name) !== undefined;

  /**
   * Keeps `record` as the record of `name`, in place of its record, or of its row of ledgers when that is what was read; a
   * row of ledgers gives the record its created time. A row a record hides stays, for `ledger store migrate --records`
   * to name. Call it in a transaction.
   */
  function putRecord(place: Place, repo: string, name: string, record: TaskRecord, modifiedMs = Date.now()): void {
    const replacesRow = !hasRecord(place, repo, name);
    const created = one<{ created_ms: number }>('SELECT created_ms FROM ledgers WHERE place = ? AND repo = ? AND name = ?', place, repo, name)?.created_ms ?? modifiedMs;
    run(
      `INSERT INTO records (place, repo, name, record, mtime, birthtime) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (place, repo, name) DO UPDATE SET record = excluded.record, mtime = excluded.mtime`,
      place,
      repo,
      name,
      recordJson(record),
      modifiedMs,
      created,
    );
    if (replacesRow) run('DELETE FROM ledgers WHERE place = ? AND repo = ? AND name = ?', place, repo, name);
  }

  /** Deletes what `read` reads of `name`: its record, else its row of ledgers; true when there was one. Call it in a transaction. */
  const deleteLedger = (place: Place, repo: string, name: string): boolean =>
    run('DELETE FROM records WHERE place = ? AND repo = ? AND name = ?', place, repo, name) > 0 || run('DELETE FROM ledgers WHERE place = ? AND repo = ? AND name = ?', place, repo, name) > 0;
  const hasEvidence = (place: Place, repo: string, name: string): boolean => place === 'archive' && one('SELECT 1 FROM evidence WHERE repo = ? AND name = ?', repo, name) !== undefined;

  /**
   * What a move of `name` of `place` to `to` would move, by the rules of the file store: the ledger with any evidence, or
   * only the evidence of an archive copy `to` has already; nothing when `to` has anything else of that name.
   */
  const plannedMove = (place: Place, repo: string, name: string, to: string): 'ledger' | 'evidence' | undefined => {
    if (hasEvidence(place, to, name)) return undefined;
    if (!hasLedger(place, to, name)) return hasLedger(place, repo, name) ? 'ledger' : undefined;
    return !hasLedger(place, repo, name) && hasEvidence(place, repo, name) ? 'evidence' : undefined;
  };

  const move = (place: Place, repo: string, name: string, to: string): boolean =>
    transaction(() => {
      const planned = plannedMove(place, repo, name, to);
      if (planned !== 'evidence' && !hasLedger(place, repo, name)) fail(`${(place === 'backlog' ? backlog : archive).location(repo, name)} does not exist.`);
      if (planned === undefined) return false;
      if (planned === 'ledger') for (const table of ['records', 'ledgers']) run(`UPDATE ${table} SET repo = ? WHERE place = ? AND repo = ? AND name = ?`, to, place, repo, name);
      if (place === 'archive') run('UPDATE evidence SET repo = ? WHERE repo = ? AND name = ?', to, repo, name);
      return true;
    });

  // A database opened read-only from before the table has none.
  const storedAliases = (): [string, string][] =>
    one(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'aliases'`) === undefined
      ? []
      : all<{ old: string; repo: string }>('SELECT old, repo FROM aliases').map(({ old, repo }) => [old, repo]);

  const existing = (repo: string, slug: string): string => (backlog.read(repo, slug) ?? fail(`${backlog.location(repo, slug)} does not exist.`)).text;
  const putBacklog = (repo: string, slug: string, text: string): void => putRecord('backlog', repo, slug, recordToWrite(text, backlog.location(repo, slug)));
  const readRegistry = (): string | undefined => one<{ text: string }>('SELECT text FROM registry WHERE id = 1')?.text;
  const writeRegistry = (text: string): void => void run('INSERT INTO registry VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET text = excluded.text', text);

  return {
    backlog: {
      ...backlog,
      write: (repo, slug, text) => transaction(() => putBacklog(repo, slug, text)),
      create: (repo, slug, text) =>
        transaction(() => {
          if (hasLedger('backlog', repo, slug)) return false;
          putBacklog(repo, slug, text);
          return true;
        }),
      update: (repo, slug, change) =>
        transaction(() => {
          const current = existing(repo, slug);
          pauseForTest();
          const text = change(current);
          if (text !== undefined) putBacklog(repo, slug, text);
          return text !== undefined;
        }),
      remove: (repo, slug, expected) =>
        transaction(() => {
          const current = existing(repo, slug);
          if (hidesMarkdown('backlog', repo, slug)) refuseHiddenMarkdown(backlog.location(repo, slug));
          return current === expected && deleteLedger('backlog', repo, slug);
        }),
      move: (repo, slug, to) => move('backlog', repo, slug, to),
      canMove: (repo, slug, to) => plannedMove('backlog', repo, slug, to) !== undefined,
    },
    archive: {
      ...archive,
      write: (repo, name, text, evidenceFrom) => {
        const evidence = evidenceFrom === undefined ? [] : evidenceIn(evidenceFrom);
        transaction(() => {
          if (archive.has(repo, name)) throw new NameTaken(`${archive.location(repo, name)} already exists. An archive copy is never replaced.`);
          putRecord('archive', repo, name, recordToWrite(text, archive.location(repo, name)));
          for (const entry of evidence) run('INSERT INTO evidence VALUES (?, ?, ?, ?, ?)', repo, name, entry.path, entry.kind, entry.data);
        });
        noteCreated(archive.location(repo, name));
        // The folder may have changed while it was read; then the worktree that holds it must stay.
        if (evidenceFrom !== undefined && !sameEvidence(archived(repo, name), evidenceIn(evidenceFrom))) {
          fail(`The evidence copy ${evidenceLocation(repo, name)}/ differs from ${evidenceFrom}/.`);
        }
      },
      readBytes: (repo, name) => {
        const row = one<{ text: Uint8Array }>(`SELECT text FROM ledgers WHERE place = 'archive' AND repo = ? AND name = ?`, repo, name);
        return row && Buffer.from(row.text);
      },
      evidenceState,
      // Evidence is written with its copy in one transaction, so a name without a copy has no evidence.
      nameTaken: (repo, name) => archive.has(repo, name),
      evidenceLocation,
      evidenceFiles,
      readEvidence: (repo, name, relative) => {
        const row = one<{ data: Uint8Array }>(`SELECT data FROM evidence WHERE repo = ? AND name = ? AND path = ? AND kind = 'file'`, repo, name, relative);
        return row && Buffer.from(row.data);
      },
      copyEvidence: (repo, name, to) => {
        const entries = archived(repo, name);
        const links = new Set(entries.flatMap((entry) => (entry.kind === 'link' ? [entry.path] : [])));
        for (const { path: relative } of entries) {
          const parts = relative.split('/');
          const throughLink = parts.slice(0, -1).some((_, index) => links.has(parts.slice(0, index + 1).join('/')));
          if (path.isAbsolute(relative) || parts.some((part) => ['', '.', '..'].includes(part)) || throughLink) {
            fail(`The evidence path ${relative} of ${evidenceLocation(repo, name)} leads outside its folder, so no evidence was copied.`);
          }
        }
        if (entries.length === 0) return;
        mkdirSync(to, { recursive: true });
        const root = realpathSync.native(to);
        for (const entry of entries) {
          const throughLink = (): never => fail(`The evidence path ${entry.path} of ${evidenceLocation(repo, name)} leads outside its folder through a link, so the copy in ${to} stopped there.`);
          const folder = realFolderIn(root, entry.kind === 'folder' ? entry.path : path.posix.dirname(entry.path), throughLink);
          const target = path.join(folder, path.posix.basename(entry.path));
          if (entry.kind === 'file') writeFileSync(target, entry.data, { flag: 'wx' });
          if (entry.kind === 'link') symlinkSync(Buffer.from(entry.data), target);
        }
      },
      remove: (repo, name, expected) =>
        transaction(() => {
          if (!archive.has(repo, name)) fail(`${archive.location(repo, name)} does not exist.`);
          if (hidesMarkdown('archive', repo, name)) refuseHiddenMarkdown(archive.location(repo, name));
          if (expected !== undefined && !isAsChecked({ read: archive.read, evidenceState }, repo, name, expected)) return false;
          run('DELETE FROM evidence WHERE repo = ? AND name = ?', repo, name);
          deleteLedger('archive', repo, name);
          return true;
        }),
      move: (repo, name, to) => move('archive', repo, name, to),
      canMove: (repo, name, to) => plannedMove('archive', repo, name, to) !== undefined,
      orphanEvidence: () =>
        all<{ repo: string; name: string }>(
          `SELECT DISTINCT repo, name FROM evidence e
           WHERE NOT EXISTS (SELECT 1 FROM ${STORED} l WHERE l.place = 'archive' AND l.repo = e.repo AND l.name = e.name)`,
        ).sort((a, b) => byCodeUnit(a.repo, b.repo) || byCodeUnit(a.name, b.name)),
    },
    registry: {
      read: readRegistry,
      write: (text) => transaction(() => writeRegistry(text)),
      update: (change) =>
        transaction(() => {
          const text = change(readRegistry());
          if (text !== undefined) writeRegistry(text);
        }),
      remove: () => transaction(() => void run('DELETE FROM registry')),
    },
    aliases: {
      read: () => checkedAliases(storedAliases()).aliases,
      problem: () => checkedAliases(storedAliases()).problem,
      add: (old, repo) =>
        transaction(() => {
          if (needsAlias(storedAliases(), old, repo, file)) run('INSERT INTO aliases VALUES (?, ?)', old, repo);
        }),
      remove: (old, repo) => transaction(() => void run('DELETE FROM aliases WHERE old = ? AND repo = ?', old, repo)),
    },
    close: () => db.close(),
  };
}
