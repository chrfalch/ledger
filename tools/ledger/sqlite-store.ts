import { lstatSync, mkdirSync, readFileSync, readlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { fail } from './failure.js';
import { holdsAnything, treeEntries } from './files.js';
import { shownSettingsFile } from './settings.js';
import { byCodeUnit, type LedgerCollection, type LedgerStore, type StoredLedger } from './store.js';
import { pauseForTest } from './wait.js';

// The text of a ledger is UTF-8 in a BLOB: node:sqlite on Node 22 cuts a TEXT value short at a NUL byte.
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
`;

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
 * node:sqlite loads only here, through require, so the file store runs on a Node without it. Not
 * process.getBuiltinModule, which a module resolve hook cannot stop, so a test can stand in for an older Node.
 */
function openDatabase(file: string, home: string): DatabaseSync {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = withoutSqliteWarning(() => createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'));
  } catch {
    return fail(
      `SQLite storage needs Node 22.13 or later, and 23.4 or later on Node 23. This is Node ${process.versions.node}. Run a newer Node, or set "storage" to "file" in ${shownSettingsFile(home)}.`,
    );
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  // Hooks and commands of several sessions may write at once; each waits for the others' short transactions.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec(SCHEMA);
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
 * The ledger store as one SQLite database, <home>/.claude/ledgers.db: backlog ledgers, archive copies with the bytes of
 * their evidence, and the registry. A location is the database file and a place in it, such as
 * ~/.claude/ledgers.db:archive/app/2026-11-01-fix-login, and names no file of its own.
 */
export function sqliteStore({ home }: { home: string }): LedgerStore {
  const file = path.join(home, '.claude', 'ledgers.db');
  const db = openDatabase(file, home);
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

  function collection(place: Place): LedgerCollection {
    const location = (repo: string, name: string): string => `${file}:${place}/${repo}/${name}`;
    type Row = { repo: string; name: string; text: Uint8Array; created_ms: number; modified_ms: number };
    const stored = ({ repo, name, text, created_ms, modified_ms }: Row): StoredLedger => ({
      repo,
      name,
      text: Buffer.from(text).toString('utf8'),
      mtimeMs: modified_ms,
      birthtimeMs: created_ms,
      location: location(repo, name),
    });
    return {
      location,
      repoLocation: (repo) => (repo === undefined ? `${file}:${place}` : `${file}:${place}/${repo}`),
      repos: () =>
        all<{ repo: string }>('SELECT DISTINCT repo FROM ledgers WHERE place = ?', place)
          .map(({ repo }) => repo)
          .sort(byCodeUnit),
      // As the file store orders <name>.md, where fix-login.md comes before fix.md.
      list: (repo) =>
        all<Row>('SELECT * FROM ledgers WHERE place = ? AND repo = ?', place, repo)
          .sort((a, b) => byCodeUnit(`${a.name}.md`, `${b.name}.md`))
          .map(stored),
      read: (repo, name) => {
        const row = one<Row>('SELECT * FROM ledgers WHERE place = ? AND repo = ? AND name = ?', place, repo, name);
        return row && stored(row);
      },
      has: (repo, name) => one('SELECT 1 FROM ledgers WHERE place = ? AND repo = ? AND name = ?', place, repo, name) !== undefined,
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

  const existing = (repo: string, slug: string): string => (backlog.read(repo, slug) ?? fail(`${backlog.location(repo, slug)} does not exist.`)).text;
  const readRegistry = (): string | undefined => one<{ text: string }>('SELECT text FROM registry WHERE id = 1')?.text;
  const writeRegistry = (text: string): void => void run('INSERT INTO registry VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET text = excluded.text', text);

  return {
    backlog: {
      ...backlog,
      write: (repo, slug, text) => {
        const now = Date.now();
        transaction(() =>
          run(
            `INSERT INTO ledgers VALUES ('backlog', ?, ?, ?, ?, ?)
             ON CONFLICT (place, repo, name) DO UPDATE SET text = excluded.text, modified_ms = excluded.modified_ms`,
            repo,
            slug,
            Buffer.from(text),
            now,
            now,
          ),
        );
      },
      create: (repo, slug, text) => {
        const now = Date.now();
        return transaction(() => run(`INSERT INTO ledgers VALUES ('backlog', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, repo, slug, Buffer.from(text), now, now) === 1);
      },
      update: (repo, slug, change) =>
        transaction(() => {
          const current = existing(repo, slug);
          pauseForTest();
          const text = change(current);
          if (text !== undefined) run(`UPDATE ledgers SET text = ?, modified_ms = ? WHERE place = 'backlog' AND repo = ? AND name = ?`, Buffer.from(text), Date.now(), repo, slug);
          return text !== undefined;
        }),
      remove: (repo, slug, expected) =>
        transaction(() => existing(repo, slug) === expected && run(`DELETE FROM ledgers WHERE place = 'backlog' AND repo = ? AND name = ?`, repo, slug) === 1),
    },
    archive: {
      ...archive,
      write: (repo, name, text, evidenceFrom) => {
        const evidence = evidenceFrom === undefined ? [] : evidenceIn(evidenceFrom);
        const now = Date.now();
        transaction(() => {
          if (archive.has(repo, name)) fail(`${archive.location(repo, name)} already exists. An archive copy is never replaced.`);
          run(`INSERT INTO ledgers VALUES ('archive', ?, ?, ?, ?, ?)`, repo, name, Buffer.from(text), now, now);
          for (const entry of evidence) run('INSERT INTO evidence VALUES (?, ?, ?, ?, ?)', repo, name, entry.path, entry.kind, entry.data);
        });
        // The folder may have changed while it was read; then the worktree that holds it must stay.
        if (evidenceFrom !== undefined && !sameEvidence(archived(repo, name), evidenceIn(evidenceFrom))) {
          fail(`The evidence copy ${evidenceLocation(repo, name)}/ differs from ${evidenceFrom}/.`);
        }
      },
      evidenceState: (repo, name, from) => {
        try {
          const kept = archived(repo, name);
          const folder = from !== undefined && holdsAnything(from) ? evidenceIn(from) : undefined;
          if (kept.length === 0) return folder === undefined ? 'none' : 'differs';
          return folder !== undefined && sameEvidence(kept, folder) ? 'same' : 'differs';
        } catch {
          // A folder that cannot be read may hold anything.
          return 'differs';
        }
      },
      // Evidence is written with its copy in one transaction, so a name without a copy has no evidence.
      nameTaken: (repo, name) => archive.has(repo, name),
      evidenceLocation,
      evidenceFiles,
      readEvidence: (repo, name, relative) => {
        const row = one<{ data: Uint8Array }>(`SELECT data FROM evidence WHERE repo = ? AND name = ? AND path = ? AND kind = 'file'`, repo, name, relative);
        return row && Buffer.from(row.data);
      },
    },
    registry: {
      read: readRegistry,
      write: (text) => transaction(() => writeRegistry(text)),
      update: (change) =>
        transaction(() => {
          const text = change(readRegistry());
          if (text !== undefined) writeRegistry(text);
        }),
    },
    close: () => db.close(),
  };
}
