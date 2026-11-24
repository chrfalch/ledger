import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Failure } from '../tools/ledger/failure.js';
import { limitLockWaits, withLockIfFree } from '../tools/ledger/lock.js';
import { fileStore } from '../tools/ledger/file-store.js';
import { conversionHint, migrateRepoIds } from '../tools/ledger/migrate-repo-ids.js';
import { migrateStorage } from '../tools/ledger/migrate.js';
import { ledgerPaths, type LedgerPaths } from '../tools/ledger/paths.js';
import type { Move } from '../tools/ledger/pending.js';
import { recordJson, recordToWrite, storedText } from '../tools/ledger/record.js';
import { repoLabel } from '../tools/ledger/repo-key.js';
import { sqliteFile, sqliteStore } from '../tools/ledger/sqlite-store.js';
import type { LedgerStore } from '../tools/ledger/store.js';
import { REPO } from './helpers.js';
import { commandEnv, git, home, LEDGER_BIN, ledger, ledgerText, lineWith, noSqlite, ok, readLedgerFile, repoKeyOf, repository, worktreeOf, worktreeTask, type Ran } from './ledger-core-fixtures.js';

type Storage = 'file' | 'sqlite';

const openStore = (h: string, storage: Storage): LedgerStore => (storage === 'sqlite' ? sqliteStore({ home: h }) : fileStore(ledgerPaths(h)));

const useSqlite = (h: string): void => writeFileSync(path.join(h, '.claude/ledger-settings.json'), JSON.stringify({ storage: 'sqlite' }));

const failedWith = (ran: Ran): string => {
  assert.equal(ran.status, 1, `exit 1 expected:\n${ran.stdout}\n${ran.stderr}`);
  return `${ran.stdout}${ran.stderr}`;
};

const convert = (h: string, ...args: string[]): Ran => ledger(h, h, 'store', 'migrate', '--repo-ids', ...args);

const OTHER = 'github.com/me/app';

const sqliteDb = (h: string) => new (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync(sqliteFile(h));

/** Writes `entries` where older versions of `storage` kept their task list, which a conversion only reads; gives the text. */
function writeOldTaskList(h: string, entries: object[], storage: Storage = 'file'): string {
  const text = `${JSON.stringify(entries, null, 2)}\n`;
  if (storage === 'file') writeFileSync(path.join(h, '.claude/ledgers.json'), text);
  else {
    const db = sqliteDb(h);
    db.exec('CREATE TABLE IF NOT EXISTS registry (id INTEGER PRIMARY KEY CHECK (id = 1), text TEXT NOT NULL) STRICT');
    db.prepare('INSERT INTO registry VALUES (1, ?)').run(text);
    db.close();
  }
  return text;
}

const failure = (needle: string) => (error: unknown): boolean => error instanceof Failure && error.message.includes(needle);

/** A HOME with the repo ~/repos/app, whose origin is a local bare repo, the folder ~/old that held a repo, and the store of `storage`. */
function appWorld(t: TestContext, storage: Storage = 'file') {
  const h = home(t);
  if (storage === 'sqlite') useSqlite(h);
  const app = repository(h, path.join(h, 'repos/app'));
  mkdirSync(path.join(h, 'old'));
  const store = openStore(h, storage);
  t.after(() => store.close?.());
  return { h, app, key: repoKeyOf(app), store };
}

const created = '2025-12-01T00:00:00.000Z';

/** A linked worktree of `main` with a .claude/ledger.md, as an active task was kept before the store held it, for an old task list entry from then. */
function legacyWorktreeLedger(h: string, main: string, slug: string): string {
  const worktree = path.join(main, '.claude/worktrees', slug);
  git(h, main, 'worktree', 'add', '--quiet', '-b', `me/${slug}`, worktree, 'main');
  const file = path.join(worktree, '.claude/ledger.md');
  mkdirSync(path.dirname(file));
  writeFileSync(file, ledgerText({ slug, worktree, branch: `me/${slug}` }));
  return file;
}
const backlogEntry = (store: LedgerStore, repo: string, slug: string, main?: string) => ({
  repo,
  slug,
  path: store.backlog.location(repo, slug),
  branch: slug,
  status: 'backlog',
  ...(main === undefined ? {} : { main }),
  created,
  updated: created,
});

// --- 1. A run that stops partway can be finished ---

test('a rerun records the alias of a ledger an earlier run moved before it stopped, and leaves the old task list as it was', (t) => {
  const { h, app, key, store } = appWorld(t);
  store.backlog.write(key, 'fix-login', ledgerText({ slug: 'fix-login', main: app }));
  const oldList = writeOldTaskList(h, [backlogEntry(store, 'app', 'fix-login', app)]);
  ok(convert(h));
  assert.deepEqual([...store.aliases.read()], [['app', key]]);
  assert.equal(store.oldTaskList(), oldList);
});

test('a folder whose move fails gets no alias, and the run exits 1', (t) => {
  const { h, app, key, store } = appWorld(t);
  store.archive.write('app', '2026-01-01-old', ledgerText({ slug: 'old', main: app }));
  const target = store.archive.repoLocation(key);
  mkdirSync(target, { recursive: true });
  chmodSync(target, 0o555);
  const out = failedWith(convert(h));
  chmodSync(target, 0o755);
  assert.match(lineWith(out, '2026-01-01-old'), /^left .*the move failed/);
  assert.deepEqual([...store.aliases.read()], []);
  assert.equal(store.archive.has('app', '2026-01-01-old'), true);
});

test('notes left under a folder name whose ledger an earlier run moved before it stopped are not accepted', (t) => {
  const { h, app, key, store } = appWorld(t);
  store.backlog.write(key, 'fix-login', ledgerText({ slug: 'fix-login', main: app }));
  writeOldTaskList(h, [backlogEntry(store, 'app', 'fix-login', app)]);
  orphanNotes(h, store, 'file');
  const notes = plannedMoves(store).find(({ from }) => from === 'evidence app/2026-01-01-old');
  assert.equal(notes?.accepted, undefined);
  assert.match(notes?.reason ?? '', /of the repo /);
});

// --- 2. File-store moves rename on one disk, onto nothing ---

test('file store: a backlog move onto a hard link of the ledger, as a move stopped after its link leaves it, finishes the move', (t) => {
  const { store } = appWorld(t);
  store.backlog.write('app', 'x', 'same\n');
  mkdirSync(store.backlog.repoLocation('github.com/me/app'), { recursive: true });
  linkSync(store.backlog.location('app', 'x'), store.backlog.location('github.com/me/app', 'x'));
  assert.equal(store.backlog.canMove('app', 'x', 'github.com/me/app'), true);
  assert.equal(store.backlog.move('app', 'x', 'github.com/me/app'), true);
  assert.equal(store.backlog.has('app', 'x'), false);
  assert.equal(store.backlog.read('github.com/me/app', 'x')?.text, storedText('same\n'));
});

test('file store: a move between two keys kept in one repo folder, such as a key and its encoding, moves and removes nothing', (t) => {
  const { store } = appWorld(t);
  store.backlog.write(OTHER, 'x', 'mine\n');
  store.active.write(OTHER, 'x', 'mine\n');
  store.archive.write(OTHER, '2026-01-01-old', 'old\n');
  const variants = [encodeURIComponent(OTHER), ...(existsSync(store.backlog.repoLocation(OTHER.toUpperCase())) ? [OTHER.toUpperCase()] : [])];
  for (const variant of variants) {
    assert.equal(store.sharesFolder?.(variant, OTHER), true, variant);
    for (const place of ['backlog', 'active', 'archive'] as const) {
      const name = place === 'archive' ? '2026-01-01-old' : 'x';
      assert.equal(store[place].canMove(variant, name, OTHER), false, `${place} from ${variant}: a dry run would move it`);
      assert.equal(store[place].move(variant, name, OTHER), false, `${place} from ${variant}`);
      assert.equal(store[place].read(OTHER, name)?.text, storedText(place === 'archive' ? 'old\n' : 'mine\n'), `${place} from ${variant}: the ledger is gone`);
    }
  }
  assert.equal(store.sharesFolder?.('app', OTHER), false);
});

/** An archive copy app/2026-01-01-old with the evidence file red.txt. */
function archivedWithEvidence(h: string, store: LedgerStore): void {
  const evidence = path.join(h, 'evidence');
  mkdirSync(evidence);
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  store.archive.write('app', '2026-01-01-old', 'old\n', evidence);
}

test('file store: an archive move onto evidence the target has, with the copy still in the source, is refused, and both stay', (t) => {
  const { h, store } = appWorld(t);
  archivedWithEvidence(h, store);
  mkdirSync(store.archive.repoLocation(OTHER), { recursive: true });
  renameSync(store.archive.evidenceLocation('app', '2026-01-01-old'), store.archive.evidenceLocation(OTHER, '2026-01-01-old'));
  assert.equal(store.archive.canMove('app', '2026-01-01-old', OTHER), false);
  assert.equal(store.archive.move('app', '2026-01-01-old', OTHER), false);
  assert.equal(store.archive.read('app', '2026-01-01-old')?.text, storedText('old\n'));
  assert.deepEqual(store.archive.evidenceFiles(OTHER, '2026-01-01-old'), ['red.txt']);
});

test('file store: an archive move onto a hard link of the copy, as a move stopped after its link leaves it, finishes the move with the evidence', (t) => {
  const { h, store } = appWorld(t);
  archivedWithEvidence(h, store);
  mkdirSync(store.archive.repoLocation(OTHER), { recursive: true });
  linkSync(store.archive.location('app', '2026-01-01-old'), store.archive.location(OTHER, '2026-01-01-old'));
  assert.equal(store.archive.move('app', '2026-01-01-old', OTHER), true);
  assert.equal(store.archive.has('app', '2026-01-01-old'), false);
  assert.deepEqual(store.archive.evidenceFiles('app', '2026-01-01-old'), []);
  assert.deepEqual(store.archive.evidenceFiles(OTHER, '2026-01-01-old'), ['red.txt']);
});

for (const storage of ['file', 'sqlite'] as const) {
  test(`${storage} store: a move of a copy that is already in the target, with its evidence left in the source, moves the evidence`, { skip: storage === 'sqlite' && noSqlite }, (t) => {
    const { h, store } = appWorld(t, storage);
    archivedWithEvidence(h, store);
    store.archive.write(OTHER, '2026-01-01-old', 'old\n');
    if (storage === 'file') rmSync(store.archive.location('app', '2026-01-01-old'));
    else {
      const db = sqliteDb(h);
      db.exec(`DELETE FROM records WHERE place = 'archive' AND repo = 'app'`);
      db.close();
    }
    assert.equal(store.archive.canMove('app', '2026-01-01-old', OTHER), true);
    assert.equal(store.archive.move('app', '2026-01-01-old', OTHER), true);
    assert.deepEqual(store.archive.evidenceFiles(OTHER, '2026-01-01-old'), ['red.txt']);
    assert.equal(store.archive.nameTaken('app', '2026-01-01-old'), false);
  });
}

test('file store: an archive move of a name the source does not have makes no target folder', (t) => {
  const { store } = appWorld(t);
  store.archive.write('app', '2026-01-01-other', 'other\n');
  assert.equal(store.archive.canMove('app', '2026-01-01-old', OTHER), false);
  assert.throws(() => store.archive.move('app', '2026-01-01-old', OTHER), failure('does not exist'));
  assert.equal(existsSync(store.archive.repoLocation(OTHER)), false);
});

test('file store: a move onto a name that differs only in case is refused where the disk ignores case', (t) => {
  const { store } = appWorld(t);
  store.backlog.write('app', 'fix', 'mine\n');
  store.backlog.write(OTHER, 'Fix', 'theirs\n');
  if (!existsSync(store.backlog.location(OTHER, 'fix'))) return t.skip('this disk tells case apart');
  assert.equal(store.backlog.canMove('app', 'fix', OTHER), false);
  assert.equal(store.backlog.move('app', 'fix', OTHER), false);
  assert.equal(store.backlog.read('app', 'fix')?.text, storedText('mine\n'));
  assert.equal(readLedgerFile(store.backlog.location(OTHER, 'Fix')), storedText('theirs\n'));
});

test('file store: an archive move that fails leaves the copy and its evidence where they were', (t) => {
  const { h, store } = appWorld(t);
  archivedWithEvidence(h, store);
  const target = store.archive.repoLocation('github.com/me/app');
  mkdirSync(target, { recursive: true });
  chmodSync(target, 0o555);
  assert.throws(() => store.archive.move('app', '2026-01-01-old', 'github.com/me/app'));
  chmodSync(target, 0o755);
  assert.equal(store.archive.read('app', '2026-01-01-old')?.text, storedText('old\n'));
  assert.deepEqual(store.archive.evidenceFiles('app', '2026-01-01-old'), ['red.txt']);
});

test('file store: an archive move onto a different copy of the same name is refused, and moves nothing', (t) => {
  const { h, store } = appWorld(t);
  archivedWithEvidence(h, store);
  store.archive.write('github.com/me/app', '2026-01-01-old', 'another\n');
  assert.equal(store.archive.move('app', '2026-01-01-old', 'github.com/me/app'), false);
  assert.deepEqual(store.archive.evidenceFiles('app', '2026-01-01-old'), ['red.txt']);
  assert.equal(store.archive.read('github.com/me/app', '2026-01-01-old')?.text, storedText('another\n'));
});

// --- 4. SQLite evidence that is already in the target ---

test('sqlite store: evidence the target already has for the name is a conflict, reported, and the run goes on', { skip: noSqlite }, (t) => {
  const { h, app, key, store } = appWorld(t, 'sqlite');
  store.archive.write('app', '2026-01-01-old', ledgerText({ slug: 'old', main: app }));
  store.backlog.write('app', 'fix-login', ledgerText({ slug: 'fix-login', main: app }));
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(sqliteFile(h));
  db.prepare(`INSERT INTO evidence VALUES (?, '2026-01-01-old', 'red.txt', 'file', ?)`).run(key, Buffer.from('stray\n'));
  db.close();
  assert.equal(store.archive.move('app', '2026-01-01-old', key), false);
  const out = failedWith(convert(h));
  assert.match(lineWith(out, '2026-01-01-old'), /already has/);
  assert.equal(store.backlog.has(key, 'fix-login'), true);
});

// --- 5. A dry run reserves what it plans ---

test('a dry run plans a second ledger for a name another old folder already takes in the target as a conflict, as the run does', (t) => {
  const { h, app } = appWorld(t);
  const store = fileStore(ledgerPaths(h));
  store.backlog.write('app', 'x', ledgerText({ slug: 'x', main: app }));
  store.backlog.write('app-old', 'x', ledgerText({ slug: 'x', main: app, goal: 'Older.' }));
  const planned = failedWith(convert(h, '--dry-run'));
  const done = failedWith(convert(h));
  for (const out of [planned, done]) {
    assert.match(lineWith(out, 'backlog app/x'), /move/);
    assert.match(lineWith(out, 'backlog app-old/x'), /already has x/);
  }
});

// --- 6. A dry run on SQLite changes no database ---

test('sqlite store: a dry run without a database makes none', { skip: noSqlite }, (t) => {
  const h = home(t);
  useSqlite(h);
  ok(convert(h, '--dry-run'));
  assert.equal(existsSync(sqliteFile(h)), false);
});

test('sqlite store: a dry run on a database from before the alias table adds no table', { skip: noSqlite }, (t) => {
  const h = home(t);
  useSqlite(h);
  const app = repository(h, path.join(h, 'repos/app'));
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(sqliteFile(h));
  db.exec(`
    CREATE TABLE ledgers (place TEXT NOT NULL, repo TEXT NOT NULL, name TEXT NOT NULL, text BLOB NOT NULL, created_ms REAL NOT NULL, modified_ms REAL NOT NULL, PRIMARY KEY (place, repo, name)) STRICT;
    CREATE TABLE evidence (repo TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY (repo, name, path)) STRICT;
    CREATE TABLE registry (id INTEGER PRIMARY KEY CHECK (id = 1), text TEXT NOT NULL) STRICT;
  `);
  db.prepare(`INSERT INTO ledgers VALUES ('backlog', 'app', 'fix-login', ?, 0, 0)`).run(Buffer.from(ledgerText({ slug: 'fix-login', main: app })));
  db.close();
  assert.match(lineWith(ok(convert(h, '--dry-run')), 'fix-login'), /would move/);
  const check = new DatabaseSync(sqliteFile(h));
  const tables = check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all();
  check.close();
  assert.deepEqual(tables.map(({ name }) => name), ['evidence', 'ledgers', 'registry']);
});

// --- 7. An ownerless ledger whose folder name fits more than one checkout ---

test('an archive copy that names no main is left as ambiguous when its folder name fits a checkout that is gone too', (t) => {
  const { h, app, store } = appWorld(t);
  store.archive.write('app', '2026-01-01-bare', ledgerText({ slug: 'bare' }));
  writeOldTaskList(h, [
    { ...backlogEntry(store, 'app', 'one', app), status: 'active', path: path.join(app, '.claude/worktrees/one/.claude/ledger.md') },
    { ...backlogEntry(store, 'app', 'two', path.join(h, 'issues/app')), status: 'active', path: path.join(h, 'issues/app/.claude/worktrees/two/.claude/ledger.md') },
  ]);
  const out = failedWith(convert(h));
  assert.match(lineWith(out, '2026-01-01-bare'), /^left .*ambiguous|^left .*2 checkouts/);
  assert.equal(store.archive.has('app', '2026-01-01-bare'), true);
});

// --- 8. Old task list entries with no ledger in the store ---

test('an active entry of a folder in no git repo, with no main, makes no alias as nothing moved, and the old task list stays as it was', (t) => {
  const h = home(t);
  const folder = path.join(h, 'work/disk-watcher');
  mkdirSync(path.join(folder, '.claude'), { recursive: true });
  const file = path.join(folder, '.claude/ledger.md');
  writeFileSync(file, ledgerText({ slug: 'scan' }));
  const store = fileStore(ledgerPaths(h));
  const oldList = writeOldTaskList(h, [{ repo: 'disk-watcher', slug: 'scan', path: file, branch: '', status: 'active', created, updated: created }]);
  ok(convert(h));
  assert.equal(store.oldTaskList(), oldList);
  assert.deepEqual([...store.aliases.read()], []);
});

test('an active entry whose ledger is there makes no alias as nothing moved, and the old task list stays as it was', (t) => {
  const { h, app, store } = appWorld(t);
  const live = legacyWorktreeLedger(h, app, 'live');
  const oldList = writeOldTaskList(h, [{ ...backlogEntry(store, 'app', 'live', app), status: 'active', path: live }]);
  ok(convert(h));
  assert.deepEqual([...store.aliases.read()], []);
  assert.equal(store.oldTaskList(), oldList);
});

test('old task list entries whose ledgers are gone, missing or named by no archive copy are neither reported nor changed, and the run exits 0', (t) => {
  const { h, app, key, store } = appWorld(t);
  store.aliases.add('app', key);
  const gone = path.join(h, 'repos/gone');
  const oldList = writeOldTaskList(h, [
    { ...backlogEntry(store, 'app', 'live', app), status: 'active', path: path.join(app, '.claude/worktrees/live/.claude/ledger.md') },
    { repo: 'gone', slug: 'far', path: path.join(gone, '.claude/worktrees/far/.claude/ledger.md'), branch: 'far', status: 'active', main: gone, created, updated: created },
    backlogEntry(store, 'app', 'ghost', app),
    { ...backlogEntry(store, 'app', 'old', app), status: 'archived' },
  ]);
  const out = ok(convert(h));
  assert.doesNotMatch(out, /^left /m);
  assert.equal(store.oldTaskList(), oldList);
  assert.deepEqual([...store.aliases.read()], [['app', key]]);
});

// --- 9. A damaged alias map ---

test('file store: a damaged alias map makes an alias write fail and stays as it was', (t) => {
  const { h, app, store } = appWorld(t);
  const file = path.join(h, '.claude/ledger-aliases.json');
  writeFileSync(file, '{ not json');
  assert.throws(() => store.aliases.add('app', 'github.com/me/app'), (error: unknown) => error instanceof Failure && error.message.includes(file));
  store.backlog.write('app', 'fix-login', ledgerText({ slug: 'fix-login', main: app }));
  assert.match(failedWith(convert(h)), /ledger-aliases\.json/);
  assert.equal(readFileSync(file, 'utf8'), '{ not json');
  assert.equal(store.backlog.has('app', 'fix-login'), true, 'nothing moved before its alias was written');
});

// --- 12. Folder names that only look encoded ---

test('file store: a folder name that is no exact encoding of a key, such as one with %2f, is a literal folder-name key', (t) => {
  const h = home(t);
  const folder = path.join(h, '.claude/ledger-backlog/host%2fteam%2fapp');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'idea.md'), 'idea\n');
  const store = fileStore(ledgerPaths(h));
  assert.deepEqual(store.backlog.repos(), ['host%2fteam%2fapp']);
  assert.equal(store.backlog.read('host%2fteam%2fapp', 'idea')?.text, storedText('idea\n'));
});

// --- 13. An alias whose target is no key ---

test('an alias whose target is no repo key is ignored, never read as a folder, and session-start says so', (t) => {
  const h = home(t);
  writeFileSync(path.join(h, '.claude/ledger-aliases.json'), JSON.stringify({ app: '..', lib: 'github.com/me/lib' }));
  const store = fileStore(ledgerPaths(h));
  assert.deepEqual([...store.aliases.read()], [['lib', 'github.com/me/lib']]);
  mkdirSync(path.join(h, '.claude/ledger-backlog'), { recursive: true });
  writeFileSync(path.join(h, '.claude/ledger-backlog/idea.md'), 'outside every repo folder\n');
  assert.equal(ledger(h, h, 'show', 'idea', '--repo', 'app').status, 1);
  assert.throws(() => store.backlog.read('..', 'idea'));
  const ran = spawnSync(LEDGER_BIN, ['hook', 'session-start'], { cwd: h, env: commandEnv(h), input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: h }), encoding: 'utf8' });
  assert.match(ran.stdout, /alias app/);
});

// --- 14. show --repo with a conflict left under the old key ---

test('ledger show --repo <old folder name> reads both what stayed under it and what moved to the key it is an alias of', (t) => {
  const { h, key, store } = appWorld(t);
  store.backlog.write('app', 'dup', 'left under app\n');
  store.backlog.write(key, 'fix-login', 'moved\n');
  store.aliases.add('app', key);
  assert.equal(ok(ledger(h, h, 'show', 'dup', '--repo', 'app')), storedText('left under app\n'));
  assert.equal(ok(ledger(h, h, 'show', 'fix-login', '--repo', 'app')), storedText('moved\n'));
});

// --- 15. Two clones of one origin share their tasks ---

test('a backlog task made in one clone of an origin starts with ledger go in another clone of it', (t) => {
  const h = home(t);
  writeFileSync(path.join(h, '.claude/ledger.template.md'), readFileSync(path.join(REPO, 'ledger.template.md'), 'utf8'));
  const first = repository(h, path.join(h, 'repos/app'));
  const second = path.join(h, 'issues/app-b');
  git(h, h, 'clone', '--quiet', path.join(h, 'remotes/app.git'), second);
  ok(ledger(h, first, 'task', 'new', 'shared', '--goal', 'Shared work.'));
  const started = JSON.parse(ok(ledger(h, second, 'go', 'shared', '--json'))) as { worktree: string };
  assert.equal(started.worktree, path.join(second, '.claude/worktrees/shared'));
  assert.ok(fileStore(ledgerPaths(h)).active.has(repoKeyOf(first), 'shared'));
});

// --- 16. A storage switch takes the aliases along ---

test('store migrate --to sqlite copies the aliases', { skip: noSqlite }, (t) => {
  const h = home(t);
  fileStore(ledgerPaths(h)).aliases.add('app', 'github.com/me/app');
  ok(ledger(h, h, 'store', 'migrate', '--to', 'sqlite'));
  const store = sqliteStore({ home: h });
  t.after(() => store.close?.());
  assert.deepEqual([...store.aliases.read()], [['app', 'github.com/me/app']]);
});

// --- 17. A legacy backlog task that names no main ---

test('ledger go of a legacy backlog task that names no main ends its other-repo error with the conversion hint', (t) => {
  const { h, app, store } = appWorld(t);
  store.backlog.write('app', 'idea', ledgerText({ slug: 'idea' }));
  const ran = ledger(h, app, 'go', 'idea');
  assert.equal(ran.status, 3, ran.stderr);
  assert.ok(ran.stderr.trim().endsWith('run `ledger store migrate --repo-ids`.'), ran.stderr);
});

// --- 18. Names that would climb out of the store ---

test('file store: the files ...md and .md are no ledgers, and the names .., ., empty and a/b reach no path', (t) => {
  const { store } = appWorld(t);
  store.archive.write('lost', '2026-01-03-x', 'kept\n');
  const folder = store.archive.repoLocation('app');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, '...md'), 'dots\n');
  writeFileSync(path.join(folder, '.md'), 'empty\n');
  assert.deepEqual(store.archive.list('app'), []);
  for (const name of ['..', '.', '', 'a/b']) {
    assert.throws(() => store.archive.remove('app', name), Failure, name);
    assert.throws(() => store.archive.evidenceLocation('app', name), Failure, name);
    assert.throws(() => store.backlog.write('app', name, 'x\n'), Failure, name);
  }
  assert.equal(store.archive.read('lost', '2026-01-03-x')?.text, storedText('kept\n'));
});

test('a conversion leaves an archive file named ...md where it is, and the rest of the archive stays', (t) => {
  const { h, app, store } = appWorld(t);
  store.archive.write('lost', '2026-01-03-x', ledgerText({ slug: 'x' }));
  const folder = store.archive.repoLocation('app');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, '...md'), ledgerText({ slug: 'dots', main: app }));
  ok(convert(h));
  assert.equal(existsSync(path.join(folder, '...md')), true);
  assert.equal(store.archive.has('lost', '2026-01-03-x'), true);
});

test('sqlite store: an evidence path that climbs out of its folder is never written', { skip: noSqlite }, (t) => {
  const { h, store } = appWorld(t, 'sqlite');
  store.archive.write('app', '2026-01-01-old', 'old\n');
  const db = sqliteDb(h);
  db.prepare(`INSERT INTO evidence VALUES ('app', '2026-01-01-old', '../escape.txt', 'file', ?)`).run(Buffer.from('out\n'));
  db.close();
  const to = path.join(h, 'restore/evidence');
  mkdirSync(path.dirname(to), { recursive: true });
  assert.throws(() => store.archive.copyEvidence('app', '2026-01-01-old', to), Failure);
  assert.equal(existsSync(path.join(h, 'restore/escape.txt')), false);
});

// --- 19. Only a hard link is a move that stopped partway ---

for (const kind of ['another file with the same bytes', 'a symbolic link to the ledger'] as const) {
  test(`file store: a backlog move onto ${kind} is refused, and both stay`, (t) => {
    const { store } = appWorld(t);
    store.backlog.write('app', 'x', 'same\n');
    const bytes = readFileSync(store.backlog.location('app', 'x'), 'utf8');
    const target = store.backlog.location(OTHER, 'x');
    mkdirSync(path.dirname(target), { recursive: true });
    if (kind === 'another file with the same bytes') writeFileSync(target, bytes);
    else symlinkSync(store.backlog.location('app', 'x'), target);
    assert.equal(store.backlog.move('app', 'x', OTHER), false);
    assert.equal(store.backlog.read('app', 'x')?.text, storedText('same\n'));
    assert.equal(lstatSync(target).isSymbolicLink(), kind === 'a symbolic link to the ledger');
    assert.equal(readFileSync(target, 'utf8'), bytes);
  });
}

test('file store: an archive move onto another copy with the same bytes is refused, and the evidence stays', (t) => {
  const { h, store } = appWorld(t);
  archivedWithEvidence(h, store);
  store.archive.write(OTHER, '2026-01-01-old', 'old\n');
  assert.equal(store.archive.move('app', '2026-01-01-old', OTHER), false);
  assert.equal(store.archive.has('app', '2026-01-01-old'), true);
  assert.deepEqual(store.archive.evidenceFiles('app', '2026-01-01-old'), ['red.txt']);
  assert.deepEqual(store.archive.evidenceFiles(OTHER, '2026-01-01-old'), []);
});

test('file store: an archive move onto evidence with the same files is refused, and both evidence folders stay', (t) => {
  const { h, store } = appWorld(t);
  archivedWithEvidence(h, store);
  cpSync(store.archive.evidenceLocation('app', '2026-01-01-old'), store.archive.evidenceLocation(OTHER, '2026-01-01-old'), { recursive: true });
  assert.equal(store.archive.move('app', '2026-01-01-old', OTHER), false);
  assert.equal(store.archive.has('app', '2026-01-01-old'), true);
  assert.deepEqual(store.archive.evidenceFiles('app', '2026-01-01-old'), ['red.txt']);
  assert.deepEqual(store.archive.evidenceFiles(OTHER, '2026-01-01-old'), ['red.txt']);
});

// --- 20. A dry run refuses what the run refuses, in both stores ---

for (const storage of ['file', 'sqlite'] as const) {
  test(`${storage} store: a target that holds the same text is a conflict, in the dry run as in the run`, { skip: storage === 'sqlite' && noSqlite }, (t) => {
    const { h, app, key, store } = appWorld(t, storage);
    const text = ledgerText({ slug: 'x', main: app });
    store.backlog.write('app', 'x', text);
    store.backlog.write(key, 'x', text);
    for (const out of [failedWith(convert(h, '--dry-run')), failedWith(convert(h))]) assert.match(lineWith(out, 'backlog app/x'), /already has x/);
    assert.equal(store.backlog.has('app', 'x'), true);
  });
}

test('sqlite store: a dry run plans evidence the target already has for the name as a conflict, as the run does', { skip: noSqlite }, (t) => {
  const { h, app, key, store } = appWorld(t, 'sqlite');
  store.archive.write('app', '2026-01-01-old', ledgerText({ slug: 'old', main: app }));
  const db = sqliteDb(h);
  db.prepare(`INSERT INTO evidence VALUES (?, '2026-01-01-old', 'red.txt', 'file', ?)`).run(key, Buffer.from('stray\n'));
  db.close();
  for (const out of [failedWith(convert(h, '--dry-run')), failedWith(convert(h))]) assert.match(lineWith(out, 'archive app/2026-01-01-old'), /already has/);
});

// --- 21. Moves across disks are left for a hand ---

const failed = (code: string) => (): never => {
  throw Object.assign(new Error(`${code}: the call failed`), { code });
};

test('file store: a move to another disk leaves the ledger, its evidence and no target folder or temporary copy', (t) => {
  const { h, store } = appWorld(t);
  store.backlog.write('app', 'x', 'x\n');
  archivedWithEvidence(h, store);
  const otherDisk = fileStore(ledgerPaths(h), { link: failed('EXDEV'), rename: failed('EXDEV') });
  assert.throws(() => otherDisk.backlog.move('app', 'x', OTHER), /EXDEV/);
  assert.throws(() => otherDisk.archive.move('app', '2026-01-01-old', OTHER), /EXDEV/);
  assert.equal(store.backlog.read('app', 'x')?.text, storedText('x\n'));
  assert.equal(store.archive.read('app', '2026-01-01-old')?.text, storedText('old\n'));
  assert.deepEqual(store.archive.evidenceFiles('app', '2026-01-01-old'), ['red.txt']);
  assert.equal(existsSync(store.backlog.repoLocation(OTHER)), false);
  assert.equal(existsSync(store.archive.repoLocation(OTHER)), false);
  assert.deepEqual(readdirSync(store.archive.repoLocation('app')).sort(), ['2026-01-01-old', '2026-01-01-old.json']);
});

test('a conversion reports a ledger on another disk as one to move by hand, records no alias, and leaves something', (t) => {
  const { h, app, store } = appWorld(t);
  store.backlog.write('app', 'x', ledgerText({ slug: 'x', main: app }));
  const lines: string[] = [];
  const left = migrateRepoIds(fileStore(ledgerPaths(h), { link: failed('EXDEV'), rename: failed('EXDEV') }), { dryRun: false }, (line) => lines.push(line));
  assert.equal(left, 1);
  assert.match(lineWith(lines.join('\n'), 'backlog app/x'), /^left .*on another disk, move by hand/);
  assert.equal(store.backlog.has('app', 'x'), true);
  assert.deepEqual([...store.aliases.read()], []);
});

test('file store: a move that fails leaves no target folder behind', (t) => {
  const { h, store } = appWorld(t);
  store.backlog.write('app', 'x', 'x\n');
  archivedWithEvidence(h, store);
  const failing = fileStore(ledgerPaths(h), { link: failed('EIO'), rename: failed('EIO') });
  assert.throws(() => failing.backlog.move('app', 'x', OTHER), /EIO/);
  assert.throws(() => failing.archive.move('app', '2026-01-01-old', OTHER), /EIO/);
  assert.equal(existsSync(store.backlog.repoLocation(OTHER)), false);
  assert.equal(existsSync(store.archive.repoLocation(OTHER)), false);
  assert.equal(store.backlog.has('app', 'x'), true);
  assert.deepEqual(store.archive.evidenceFiles('app', '2026-01-01-old'), ['red.txt']);
});

/** Makes the record `name` of `place` at OTHER as a program that takes no ledger lock would, such as a person by hand. */
function madeWithoutLock(store: LedgerStore, place: 'backlog' | 'active' | 'archive', name: string, text: string): void {
  const file = path.join(store[place].repoLocation(OTHER), `${name}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, recordJson(recordToWrite(text, file)), { flag: 'wx' });
}

test('file store: a move refuses, replacing nothing, when a program that takes no lock makes a ledger of that name in the target just before the move', (t) => {
  const { h, store } = appWorld(t);
  store.backlog.write('app', 'x', 'mine\n');
  store.active.write('app', 'x', 'mine\n');
  archivedWithEvidence(h, store);
  const theirs = 'theirs\n';
  let makeFirst: (() => void) | undefined;
  const afterFirst = (move: (from: string, to: string) => void) => (from: string, to: string) => {
    makeFirst?.();
    makeFirst = undefined;
    move(from, to);
  };
  const racing = fileStore(ledgerPaths(h), { rename: afterFirst(renameSync), link: afterFirst(linkSync) });
  const raced = [
    { place: 'backlog', make: () => madeWithoutLock(store, 'backlog', 'x', theirs) },
    { place: 'active', make: () => madeWithoutLock(store, 'active', 'x', theirs) },
    { place: 'archive', make: () => madeWithoutLock(store, 'archive', '2026-01-01-old', theirs) },
  ] as const;
  for (const { place, make } of raced) {
    const name = place === 'archive' ? '2026-01-01-old' : 'x';
    makeFirst = make;
    assert.equal(racing[place].move('app', name, OTHER), false, `${place}: the move replaced a ledger made just before it`);
    assert.equal(store[place].read(OTHER, name)?.text, storedText(theirs), `${place}: the ledger made first is not intact`);
    assert.equal(store[place].read('app', name)?.text, storedText(place === 'archive' ? 'old\n' : 'mine\n'), `${place}: the moved ledger is gone`);
  }
  assert.deepEqual(store.archive.evidenceFiles('app', '2026-01-01-old'), ['red.txt']);
});

test('file store: a move stopped right after it linked a ledger at the target leaves the ledger under both repos and nothing else at the target', (t) => {
  const { h, store } = appWorld(t);
  store.backlog.write('app', 'x', 'mine\n');
  store.active.write('app', 'x', 'mine\n');
  archivedWithEvidence(h, store);
  const stopped = fileStore(ledgerPaths(h), {
    link: (from, to) => {
      linkSync(from, to);
      throw new Error('the process was killed');
    },
  });
  for (const place of ['backlog', 'active', 'archive'] as const) {
    const name = place === 'archive' ? '2026-01-01-old' : 'x';
    const text = storedText(place === 'archive' ? 'old\n' : 'mine\n');
    assert.throws(() => stopped[place].move('app', name, OTHER), /killed/);
    assert.equal(store[place].read('app', name)?.text, text, `${place}: the ledger is gone from the old repo`);
    assert.equal(store[place].read(OTHER, name)?.text, text, `${place}: the ledger is not at the target`);
    assert.deepEqual(readdirSync(store[place].repoLocation(OTHER)), [`${name}.json`], place);
  }
});

test('file store: a move that fails at the Markdown a record hides takes its link back and leaves the source record as another command wrote it meanwhile', (t) => {
  const { h, store } = appWorld(t);
  store.backlog.write('app', 'x', 'mine\n');
  const { record, markdown } = { record: store.backlog.location('app', 'x'), markdown: path.join(store.backlog.repoLocation('app'), 'x.md') };
  writeFileSync(markdown, 'hidden\n');
  const failing = fileStore(ledgerPaths(h), {
    link: (from, to) => {
      if (from === markdown) {
        writeFileSync(`${record}.theirs`, readFileSync(record, 'utf8').replace('mine', 'theirs'));
        renameSync(`${record}.theirs`, record);
        throw Object.assign(new Error('EIO: the link failed'), { code: 'EIO' });
      }
      linkSync(from, to);
    },
  });
  assert.throws(() => failing.backlog.move('app', 'x', OTHER), /EIO/);
  assert.equal(store.backlog.read('app', 'x')?.text, storedText('theirs\n'));
  assert.equal(readFileSync(markdown, 'utf8'), 'hidden\n');
  assert.equal(existsSync(store.backlog.repoLocation(OTHER)), false);
});

test('file store: a move of a ledger kept as Markdown refuses when a program that takes no lock makes a record of that name at the target just before the move', (t) => {
  const { h, store } = appWorld(t);
  const markdownOf = (place: 'backlog' | 'archive', name: string) => {
    mkdirSync(store[place].repoLocation('app'), { recursive: true });
    const file = path.join(store[place].repoLocation('app'), `${name}.md`);
    writeFileSync(file, 'mine\n');
    return file;
  };
  const raced = [
    { place: 'backlog', name: 'x', make: () => madeWithoutLock(store, 'backlog', 'x', 'theirs\n') },
    { place: 'archive', name: '2026-01-01-old', make: () => madeWithoutLock(store, 'archive', '2026-01-01-old', 'theirs\n') },
  ] as const;
  for (const { place, name, make } of raced) {
    const source = markdownOf(place, name);
    let makeFirst: (() => void) | undefined = make;
    const afterFirst = (move: (from: string, to: string) => void) => (from: string, to: string) => {
      makeFirst?.();
      makeFirst = undefined;
      move(from, to);
    };
    const racing = fileStore(ledgerPaths(h), { rename: afterFirst(renameSync), link: afterFirst(linkSync) });
    assert.equal(racing[place].move('app', name, OTHER), false, `${place}: the record made first hides the moved Markdown`);
    assert.equal(readFileSync(source, 'utf8'), 'mine\n', `${place}: the Markdown left its repo`);
    assert.equal(store[place].read(OTHER, name)?.text, storedText('theirs\n'), place);
    assert.deepEqual(readdirSync(store[place].repoLocation(OTHER)), [`${name}.json`], place);
  }
});

/** Runs `work` while every lock wait of this process ends at once, as when the process holding the lock runs on. */
function withoutLockWaits<T>(work: () => T): T {
  limitLockWaits(Date.now());
  try {
    return work();
  } finally {
    limitLockWaits(Infinity);
  }
}

test('file store: a move holds the locks of the ledger under both repos, so a create or archive copy of that name at the target waits for it', (t) => {
  const { h, store } = appWorld(t);
  store.backlog.write('app', 'x', 'mine\n');
  store.active.write('app', 'x', 'mine\n');
  archivedWithEvidence(h, store);
  const lockedFiles = (place: 'backlog' | 'active' | 'archive', repo: string, name: string): string[] => {
    const base = path.join(store[place].repoLocation(repo), name);
    return place === 'active' ? [`${base}.json`] : [`${base}.json`, `${base}.md`];
  };
  let during: (() => void) | undefined;
  const moving = fileStore(ledgerPaths(h), {
    link: (from, to) => {
      during?.();
      during = undefined;
      linkSync(from, to);
    },
  });
  for (const place of ['backlog', 'active', 'archive'] as const) {
    const name = place === 'archive' ? '2026-01-01-old' : 'x';
    during = () => {
      for (const file of [...lockedFiles(place, 'app', name), ...lockedFiles(place, OTHER, name)]) {
        assert.equal(withLockIfFree(file, () => undefined), 'busy', `${place}: ${file} is not locked while the move runs`);
      }
      withoutLockWaits(() =>
        assert.throws(() => (place === 'archive' ? store.archive.write(OTHER, name, 'theirs\n') : store[place].create(OTHER, name, 'theirs\n')), /Gave up waiting for the lock/, place),
      );
    };
    assert.equal(moving[place].move('app', name, OTHER), true, place);
    assert.equal(during, undefined, `${place}: the move linked nothing`);
    assert.equal(store[place].read(OTHER, name)?.text, storedText(place === 'archive' ? 'old\n' : 'mine\n'), place);
  }
});

test('file store: a move refuses a ledger whose record hides Markdown that is a symbolic link, and moves nothing', (t) => {
  const { h, store } = appWorld(t);
  const elsewhere = path.join(h, 'elsewhere.md');
  writeFileSync(elsewhere, 'hidden\n');
  store.backlog.write('app', 'x', 'mine\n');
  store.archive.write('app', '2026-01-01-old', 'mine\n');
  for (const [place, name] of [['backlog', 'x'], ['archive', '2026-01-01-old']] as const) {
    const markdown = path.join(store[place].repoLocation('app'), `${name}.md`);
    symlinkSync(elsewhere, markdown);
    assert.throws(() => store[place].move('app', name, OTHER), new RegExp(`${markdown}.*symbolic link`), place);
    assert.ok(lstatSync(markdown).isSymbolicLink(), `${place}: the link left its repo`);
    assert.equal(store[place].read('app', name)?.text, storedText('mine\n'), place);
    assert.equal(existsSync(store[place].repoLocation(OTHER)), false, `${place}: the move left a target folder`);
  }
  assert.equal(readFileSync(elsewhere, 'utf8'), 'hidden\n');
});

test('file store: an evidence folder whose name ends in .md or .json is no ledger', (t) => {
  const { h, store } = appWorld(t);
  const evidence = path.join(h, 'evidence');
  mkdirSync(evidence);
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  for (const name of ['2026-01-01-notes.md', '2026-01-02-data.json']) store.archive.write('app', name, 'old\n', evidence);
  assert.deepEqual(store.archive.unreadable('app'), []);
  assert.deepEqual(
    store.archive.list('app').map(({ name }) => name),
    ['2026-01-01-notes.md', '2026-01-02-data.json'],
  );
});

// --- 22. A rerun places a ledger by the alias an earlier run saved ---

test('a rerun files an archive copy that names no main under the alias an earlier run saved', (t) => {
  const { h, key, store } = appWorld(t);
  store.aliases.add('app', key);
  store.archive.write('app', '2026-01-02-bare', ledgerText({ slug: 'bare' }));
  assert.match(lineWith(ok(convert(h)), '2026-01-02-bare'), /^moved/);
  assert.equal(store.archive.has(key, '2026-01-02-bare'), true);
});

// --- 23. Aliases are never changed ---

for (const storage of ['file', 'sqlite'] as const) {
  test(`${storage} store: an alias is never pointed at another key`, { skip: storage === 'sqlite' && noSqlite }, (t) => {
    const { store } = appWorld(t, storage);
    store.aliases.add('app', OTHER);
    store.aliases.add('app', OTHER);
    assert.throws(() => store.aliases.add('app', 'github.com/me/other'), failure(OTHER));
    assert.deepEqual([...store.aliases.read()], [['app', OTHER]]);
  });
}

test('a conversion keeps an alias that names another key, reports the conflict, and exits 1', (t) => {
  const { h, app, store } = appWorld(t);
  store.aliases.add('app', 'github.com/me/other');
  store.backlog.write('app', 'x', ledgerText({ slug: 'x', main: app }));
  assert.match(lineWith(failedWith(convert(h)), 'alias'), /github\.com\/me\/other/);
  assert.deepEqual([...store.aliases.read()], [['app', 'github.com/me/other']]);
});

// --- 24. Which tasks a clone has ---

/** Two clones of one origin, ~/repos/app and ~/issues/app-b, and the ledger template. */
function twoClones(t: TestContext) {
  const h = home(t);
  writeFileSync(path.join(h, '.claude/ledger.template.md'), readFileSync(path.join(REPO, 'ledger.template.md'), 'utf8'));
  const first = repository(h, path.join(h, 'repos/app'));
  const second = path.join(h, 'issues/app-b');
  git(h, h, 'clone', '--quiet', path.join(h, 'remotes/app.git'), second);
  return { h, first, second };
}

test('a backlog task named from two clones of its repo cannot be its own parent', (t) => {
  const { h, first, second } = twoClones(t);
  ok(ledger(h, first, 'task', 'new', 'shared', '--goal', 'Shared work.'));
  const ran = ledger(h, first, 'tree', 'add', 'shared', `shared@${second}`);
  assert.equal(ran.status, 1, ran.stdout);
  assert.match(ran.stderr, /cannot be its own parent/);
});

/** Fails, naming the task `slug` and the worktree it is active in. */
function refusedAsTaken(ran: Ran, slug: string, worktree: string): void {
  assert.equal(ran.status, 1, ran.stdout);
  assert.match(ran.stderr, new RegExp(`\\b${slug}\\b`));
  assert.ok(ran.stderr.includes(worktree), ran.stderr);
}

test('a slug that is active in one clone of a repo names no other task in another clone of it', (t) => {
  const { h, first, second } = twoClones(t);
  worktreeTask(h, first, { slug: 'epic' });
  const mine = worktreeTask(h, first, { slug: 'x' });
  const loose = path.join(second, '.claude/worktrees/loose');
  git(h, second, 'worktree', 'add', '--quiet', '-b', 'loose', loose);
  refusedAsTaken(ledger(h, loose, 'task', 'new', '--here', 'x'), 'x', worktreeOf(first, 'x'));
  ok(ledger(h, second, 'list'));
  ok(ledger(h, first, 'tree', 'add', 'epic', 'x'));
  assert.match(readLedgerFile(mine), /^- parent: epic$/m);
});

test('a path that is now a clone of another origin has none of the tasks filed under the old key that name it', (t) => {
  const { h, app, store } = appWorld(t);
  store.archive.write('github.com/me/old', '2026-01-01-done', ledgerText({ slug: 'done', main: app }));
  store.backlog.write('github.com/me/old', 'idea', ledgerText({ slug: 'idea', main: app }));
  const done = ledger(h, app, 'go', 'done');
  assert.equal(done.status, 2, done.stderr);
  const idea = ledger(h, app, 'task', 'retire', 'idea');
  assert.equal(idea.status, 1, idea.stderr);
  assert.equal(store.backlog.has('github.com/me/old', 'idea'), true);
});

// --- 25. Archive lists, ledger go and retire follow aliases ---

test('ledger task archive lists the copies kept under an alias of the repo', (t) => {
  const { h, app, key, store } = appWorld(t);
  store.aliases.add('app', key);
  store.archive.write('app', '2026-01-01-old', ledgerText({ slug: 'old', main: app }));
  const listed = JSON.parse(ok(ledger(h, app, 'task', 'archive', '--json'))) as { ledgers: { slug: string }[] };
  assert.deepEqual(listed.ledgers.map(({ slug }) => slug), ['old']);
});

test('ledger go starts a backlog task kept under an alias of the repo', (t) => {
  const { h, app, key, store } = appWorld(t);
  store.aliases.add('app', key);
  store.backlog.write('app', 'idea', ledgerText({ slug: 'idea', main: app }));
  const started = JSON.parse(ok(ledger(h, app, 'go', 'idea', '--json'))) as { worktree: string };
  assert.equal(started.worktree, path.join(app, '.claude/worktrees/idea'));
  assert.equal(store.backlog.has('app', 'idea'), false);
});

test('ledger task retire of a backlog task kept under an alias archives it under the repo key', (t) => {
  const { h, app, key, store } = appWorld(t);
  store.aliases.add('app', key);
  store.backlog.write('app', 'later', ledgerText({ slug: 'later', main: app }));
  ok(ledger(h, app, 'task', 'retire', 'later'));
  assert.deepEqual(store.archive.repos(), [key]);
  assert.equal(store.backlog.has('app', 'later'), false);
});

// --- 26. An alias that is no repo key stops alias writes ---

test('file store: an alias map with a target that is no repo key refuses alias writes, and a conversion moves nothing', (t) => {
  const { h, app, store } = appWorld(t);
  const file = path.join(h, '.claude/ledger-aliases.json');
  const text = JSON.stringify({ lib: '..' });
  writeFileSync(file, text);
  assert.throws(() => store.aliases.add('app', OTHER), failure(file));
  store.backlog.write('app', 'fix-login', ledgerText({ slug: 'fix-login', main: app }));
  failedWith(convert(h));
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.equal(store.backlog.has('app', 'fix-login'), true);
});

test('sqlite store: an alias row with a target that is no repo key refuses alias writes', { skip: noSqlite }, (t) => {
  const { h, store } = appWorld(t, 'sqlite');
  const db = sqliteDb(h);
  db.exec(`INSERT INTO aliases VALUES ('lib', '..')`);
  db.close();
  assert.throws(() => store.aliases.add('app', OTHER), failure('lib'));
  assert.deepEqual([...store.aliases.read()], []);
});

// --- 27. Old task list entries and evidence still under folder names ---

const sessionStart = (h: string, cwd = h): string => {
  const ran = spawnSync(LEDGER_BIN, ['hook', 'session-start'], { cwd, env: commandEnv(h), input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd }), encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout === '' ? '' : (JSON.parse(ran.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
};

test('session-start gives no conversion hint when only the old task list uses folder names', (t) => {
  const h = home(t);
  const gone = path.join(h, 'repos/gone');
  writeOldTaskList(h, [{ repo: 'gone', slug: 'live', path: path.join(gone, '.claude/worktrees/live/.claude/ledger.md'), branch: 'live', status: 'active', main: gone, created, updated: created }]);
  assert.equal(sessionStart(h), '');
});

/** What a dry run of the conversion reports, by its callback. */
function plannedMoves(store: LedgerStore): Move[] {
  const moves: Move[] = [];
  migrateRepoIds(store, { dryRun: true }, () => {}, (move) => void moves.push(move));
  return moves;
}

const kept = (count: number): RegExp =>
  new RegExp(`^(?:would keep|kept) ${count === 1 ? '1 finished task under its' : `${count} finished tasks under their`} old repo folder name, as that folder is gone or unknown; ledger store migrate --pending names ${count === 1 ? 'it' : 'them'}\\.$`, 'm');

/** Notes of a finished task under the folder name app, with no archive copy of their name anywhere. */
function orphanNotes(h: string, store: LedgerStore, storage: Storage): void {
  if (storage === 'file') {
    const folder = store.archive.evidenceLocation('app', '2026-01-01-old');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'red.txt'), 'failing\n');
  } else {
    const db = sqliteDb(h);
    db.prepare(`INSERT INTO evidence VALUES ('app', '2026-01-01-old', 'red.txt', 'file', ?)`).run(Buffer.from('failing\n'));
    db.close();
  }
}

for (const storage of ['file', 'sqlite'] as const) {
  test(`${storage} store: evidence under a folder name whose ledger is nowhere in the store is kept: no hint, and a conversion counts it kept and exits 0`, { skip: storage === 'sqlite' && noSqlite }, (t) => {
    const { h, store } = appWorld(t, storage);
    orphanNotes(h, store, storage);
    assert.equal(conversionHint(store), undefined);
    assert.equal(sessionStart(h), '');
    assert.deepEqual(plannedMoves(store), [
      { kind: 'repo-ids', from: 'evidence app/2026-01-01-old', to: 'repo address', auto: false, reason: 'notes of a finished task whose ledger is not in the store', accepted: true },
    ]);
    const out = ok(convert(h));
    assert.doesNotMatch(out, /2026-01-01-old/);
    assert.match(out, kept(1));
    assert.match(out, /^Moved 0 ledgers; left 0 as they are\.$/m);
  });

  test(`${storage} store: evidence with no ledger under a folder name that is an alias of a repo needs a person: the hint counts it, and a conversion exits 1`, { skip: storage === 'sqlite' && noSqlite }, (t) => {
    const { h, key, store } = appWorld(t, storage);
    store.aliases.add('app', key);
    orphanNotes(h, store, storage);
    assert.equal(conversionHint(store), '1 evidence folder still uses folder names (app); run `ledger store migrate --repo-ids`.');
    assert.deepEqual(plannedMoves(store), [
      {
        kind: 'repo-ids',
        from: 'evidence app/2026-01-01-old',
        to: 'repo address',
        auto: false,
        reason: `notes of a finished task whose ledger is not in the store, of the repo ${repoLabel(key)} (${key}); move them by hand to ${store.archive.evidenceLocation(key, '2026-01-01-old')}`,
      },
    ]);
    assert.match(lineWith(failedWith(convert(h)), '2026-01-01-old'), /^left evidence app\/2026-01-01-old: /);
  });
}

test('the hint counts a backlog and an active ledger whose repo folder is gone, and not an archive copy whose repo folder is gone', (t) => {
  const { h, store } = appWorld(t);
  const gone = path.join(h, 'old/app');
  store.backlog.write('app', 'later', ledgerText({ slug: 'later', main: gone }));
  store.active.write('app', 'busy', ledgerText({ slug: 'busy', main: gone }));
  store.archive.write('app', '2026-01-01-done', ledgerText({ slug: 'done', main: gone }));
  assert.equal(conversionHint(store), '2 ledgers still use folder names (app); run `ledger store migrate --repo-ids`.');
  assert.deepEqual(plannedMoves(store), [
    { kind: 'repo-ids', from: 'backlog app/later', to: 'repo address', auto: false, reason: `its repo folder ${gone} is gone` },
    { kind: 'repo-ids', from: 'active app/busy', to: 'repo address', auto: false, reason: `its repo folder ${gone} is gone` },
    { kind: 'repo-ids', from: 'archive app/2026-01-01-done', to: 'repo address', auto: false, reason: `its repo folder ${gone} is gone`, accepted: true },
  ]);
  const out = failedWith(convert(h));
  assert.match(out, kept(1));
  assert.match(out, /^Moved 0 ledgers; left 2 as they are\.$/m);
});

test('an archive copy whose main is a folder that is no git repo needs a person: the hint counts it, and a conversion exits 1', (t) => {
  const { h, store } = appWorld(t);
  const plain = path.join(h, 'work/plain');
  mkdirSync(plain, { recursive: true });
  store.archive.write('plain', '2026-01-01-done', ledgerText({ slug: 'done', main: plain }));
  assert.equal(conversionHint(store), '1 ledger still uses folder names (plain); run `ledger store migrate --repo-ids`.');
  assert.deepEqual(plannedMoves(store), [
    { kind: 'repo-ids', from: 'archive plain/2026-01-01-done', to: 'repo address', auto: false, reason: `its repo folder ${plain} is no longer a git repo, or git did not answer` },
  ]);
  failedWith(convert(h));
});

test('an archive copy whose main is on a disk that is not mounted, or cannot be read, needs a person', (t) => {
  const { h, store } = appWorld(t);
  const unmounted = `/Volumes/ledger-test-not-mounted-${process.pid}/app`;
  store.archive.write('disk', '2026-01-01-done', ledgerText({ slug: 'done', main: unmounted }));
  const doubled = `/Volumes//ledger-test-not-mounted-${process.pid}/app`;
  store.archive.write('slash', '2026-01-04-done', ledgerText({ slug: 'done', main: doubled }));
  const otherHome = path.join(h, 'Users/someone/repos/app/app');
  store.archive.write('far', '2026-01-03-done', ledgerText({ slug: 'done', main: otherHome }));
  const locked = path.join(h, 'locked');
  const hidden = path.join(locked, 'app');
  mkdirSync(hidden, { recursive: true });
  store.archive.write('hidden', '2026-01-02-done', ledgerText({ slug: 'done', main: hidden }));
  chmodSync(locked, 0o000);
  let reasons: unknown[][];
  try {
    reasons = plannedMoves(store).map(({ from, reason, accepted }) => [from, reason, accepted]);
  } finally {
    chmodSync(locked, 0o755);
  }
  const of = (from: string): unknown[] | undefined => reasons.find((each) => each[0] === from);
  assert.deepEqual(of('archive disk/2026-01-01-done'), ['archive disk/2026-01-01-done', `its repo folder ${unmounted} is on a disk that is not mounted`, undefined]);
  assert.equal(of('archive slash/2026-01-04-done')?.[2], undefined);
  assert.deepEqual(of('archive far/2026-01-03-done'), ['archive far/2026-01-03-done', `its repo folder ${otherHome} is gone`, true]);
  if (process.getuid?.() !== 0) assert.deepEqual(of('archive hidden/2026-01-02-done'), ['archive hidden/2026-01-02-done', `its repo folder ${hidden} cannot be read (EACCES)`, undefined]);
});

test('session-start runs no git for an archive copy whose repo folder is gone', (t) => {
  const { h, store } = appWorld(t);
  const gone = path.join(h, 'old/app');
  store.archive.write('app', '2026-01-01-done', ledgerText({ slug: 'done', main: gone }));
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const calls = path.join(h, 'git-calls.log');
  writeFileSync(path.join(h, 'stub-bin/git'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
  assert.equal(sessionStart(h), '');
  assert.ok(existsSync(calls), 'the stub saw no git call at all');
  assert.doesNotMatch(readFileSync(calls, 'utf8'), new RegExp(gone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('evidence with no ledger under a folder name whose other task moves to a repo in the same run needs a person, in the run as in a later --pending', (t) => {
  const { h, app, key, store } = appWorld(t);
  orphanNotes(h, store, 'file');
  store.backlog.write('app', 'next', ledgerText({ slug: 'next', main: app }));
  const reason = `notes of a finished task whose ledger is not in the store, of the repo ${repoLabel(key)} (${key}); move them by hand to ${store.archive.evidenceLocation(key, '2026-01-01-old')}`;
  const planned = plannedMoves(store).find(({ from }) => from === 'evidence app/2026-01-01-old');
  assert.deepEqual(planned, { kind: 'repo-ids', from: 'evidence app/2026-01-01-old', to: 'repo address', auto: false, reason });
  assert.equal(lineWith(failedWith(convert(h)), '2026-01-01-old'), `left evidence app/2026-01-01-old: ${reason}`);
  assert.deepEqual(plannedMoves(store), [planned]);
});

test('the hint names an alias conflict the conversion finds, though the only ledger under the folder name is kept', (t) => {
  const { h, app, store } = appWorld(t);
  store.aliases.add('app', OTHER);
  store.archive.write('app', '2026-01-01-done', ledgerText({ slug: 'done', main: path.join(h, 'old/app') }));
  const live = legacyWorktreeLedger(h, app, 'live');
  writeOldTaskList(h, [{ ...backlogEntry(store, 'app', 'live', app), status: 'active', path: live }]);
  assert.equal(conversionHint(store), 'The folder name app is an alias of one repo while a task of it is in another; run `ledger store migrate --repo-ids` to see it.');
  failedWith(convert(h));
});

test('the hint reads no task list when nothing under a folder name is an archive copy or evidence, as nothing else can be kept', (t) => {
  const { h, app, store } = appWorld(t);
  store.backlog.write('app', 'later', ledgerText({ slug: 'later', main: app }));
  let reads = 0;
  const watched: LedgerStore = { ...store, oldTaskList: () => (reads++, store.oldTaskList()) };
  assert.equal(conversionHint(watched), '1 ledger still uses folder names (app); run `ledger store migrate --repo-ids`.');
  assert.equal(reads, 0);
  store.archive.write('app', '2026-01-01-done', ledgerText({ slug: 'done', main: path.join(h, 'old/app') }));
  assert.equal(conversionHint(watched), '1 ledger still uses folder names (app); run `ledger store migrate --repo-ids`.');
  assert.equal(reads, 1);
});

test('an archive copy whose main line is . or a path with a note is read by the path: kept when unknown or gone, moved when it is a repo', (t) => {
  const { h, app, key, store } = appWorld(t);
  const gone = path.join(h, 'repos/netinfo');
  store.archive.write('app', '2026-01-01-here', ledgerText({ slug: 'here', main: `${app} (lib fork clone; moved here, operator option 1)` }));
  store.archive.write('jev', '2026-01-02-dot', ledgerText({ slug: 'dot', main: '.' }));
  store.archive.write('netinfo', '2026-01-03-noted', ledgerText({ slug: 'noted', main: `${gone} (lib fork clone; moved here, operator option 1)` }));
  const accepted = plannedMoves(store).filter((move) => move.accepted);
  assert.deepEqual(accepted.map(({ from, reason }) => [from, reason]), [
    ['archive jev/2026-01-02-dot', 'its ledger does not say which repo folder it came from'],
    ['archive netinfo/2026-01-03-noted', `its repo folder ${gone} is gone`],
  ]);
  const out = ok(convert(h));
  assert.match(lineWith(out, '2026-01-01-here'), /^moved archive app\/2026-01-01-here to /);
  assert.equal(store.archive.has(key, '2026-01-01-here'), true);
  assert.match(out, kept(2));
  assert.equal(store.archive.has('jev', '2026-01-02-dot'), true);
  assert.equal(store.archive.has('netinfo', '2026-01-03-noted'), true);
});

// --- 28. A storage switch keeps every alias as it is ---

test('store migrate --to sqlite stops, with nothing copied, when the database has the alias with another key', { skip: noSqlite }, (t) => {
  const h = home(t);
  const files = fileStore(ledgerPaths(h));
  files.aliases.add('app', OTHER);
  files.backlog.write(OTHER, 'x', 'x\n');
  const before = sqliteStore({ home: h });
  before.aliases.add('app', 'github.com/me/other');
  before.close?.();
  const out = failedWith(ledger(h, h, 'store', 'migrate', '--to', 'sqlite'));
  assert.match(lineWith(out, 'alias'), /github\.com\/me\/other/);
  const after = sqliteStore({ home: h });
  t.after(() => after.close?.());
  assert.equal(after.backlog.has(OTHER, 'x'), false);
  assert.deepEqual([...after.aliases.read()], [['app', 'github.com/me/other']]);
  assert.equal(existsSync(path.join(h, '.claude/ledger-settings.json')), false);
});

test('store migrate --to sqlite stops before it copies a ledger when the database refuses alias writes', { skip: noSqlite }, (t) => {
  const h = home(t);
  const files = fileStore(ledgerPaths(h));
  files.aliases.add('app', OTHER);
  files.backlog.write(OTHER, 'x', 'x\n');
  sqliteStore({ home: h }).close?.();
  const db = sqliteDb(h);
  db.exec(`INSERT INTO aliases VALUES ('lib', '..')`);
  db.close();
  failedWith(ledger(h, h, 'store', 'migrate', '--to', 'sqlite'));
  const after = sqliteStore({ home: h });
  t.after(() => after.close?.());
  assert.equal(after.backlog.has(OTHER, 'x'), false);
});

// --- 29. A ledger whose repo is not known keeps its folder name from becoming an alias ---

/** A git repo at `main` with one commit and no remote, so its path is its key. */
function localRepo(h: string, main: string): string {
  mkdirSync(main, { recursive: true });
  git(h, main, 'init', '--quiet', '-b', 'main');
  git(h, main, 'commit', '--quiet', '--allow-empty', '-m', 'first');
  return main;
}

test('an archive copy that names no main and that no record places is kept, and its folder name gets no alias', (t) => {
  const h = home(t);
  const renamed = repository(h, path.join(h, 'repos/app-renamed'));
  const store = fileStore(ledgerPaths(h));
  store.backlog.write('app', 'x', ledgerText({ slug: 'x', main: renamed }));
  store.archive.write('app', '2026-01-01-bare', ledgerText({ slug: 'bare' }));
  const out = ok(convert(h));
  assert.match(lineWith(out, 'backlog app/x'), /^moved/);
  assert.doesNotMatch(out, /2026-01-01-bare/);
  assert.match(out, kept(1));
  assert.match(lineWith(out, 'alias'), /^kept no alias for app/);
  assert.equal(store.archive.has('app', '2026-01-01-bare'), true);
  assert.deepEqual([...store.aliases.read()], []);
});

/** The repo app with a ledger x and an archive copy bare that names no main, and a ledger of a second checkout named app, under another folder name. */
function ambiguousWorld(t: TestContext) {
  const world = appWorld(t);
  const { h, app, store } = world;
  const other = localRepo(h, path.join(h, 'issues/app'));
  store.backlog.write('app', 'x', ledgerText({ slug: 'x', main: app }));
  store.archive.write('app', '2026-01-01-bare', ledgerText({ slug: 'bare' }));
  store.backlog.write('app-2', 'there', ledgerText({ slug: 'there', main: other }));
  return world;
}

test('an archive copy that names no main, whose folder name fits two checkouts, stays, and its folder name gets no alias', (t) => {
  const { h, store } = ambiguousWorld(t);
  const out = failedWith(convert(h));
  assert.match(lineWith(out, '2026-01-01-bare'), /^left .*ambiguous/);
  assert.equal(store.archive.has('app', '2026-01-01-bare'), true);
  assert.equal(store.aliases.read().get('app'), undefined);
});

test('an archive copy whose folder name fits two checkouts is not moved by an alias saved before', (t) => {
  const { h, key, store } = ambiguousWorld(t);
  store.aliases.add('app', key);
  assert.match(lineWith(failedWith(convert(h)), '2026-01-01-bare'), /^left .*ambiguous/);
  assert.equal(store.archive.has('app', '2026-01-01-bare'), true);
});

for (const storage of ['file', 'sqlite'] as const) {
  for (const [place, name, keep] of [['backlog', 'foo', false], ['archive', '2026-01-01-foo', true]] as const) {
    test(`${storage} store: a ${place} ledger whose own main is gone ${keep ? 'is kept and the run exits 0' : 'stays and the run exits 1'}, and its folder name gets no alias, in the dry run as in the run`, { skip: storage === 'sqlite' && noSqlite }, (t) => {
      const { h, app, key, store } = appWorld(t, storage);
      const gone = path.join(h, 'old/app');
      store.backlog.write('app', 'bar', ledgerText({ slug: 'bar', main: app }));
      store[place].write('app', name, ledgerText({ slug: 'foo', main: gone }));
      const finish = keep ? ok : failedWith;
      for (const out of [finish(convert(h, '--dry-run')), finish(convert(h))]) {
        if (keep) assert.match(out, kept(1));
        else assert.equal(lineWith(out, `${place} app/${name}`), `left ${place} app/${name}: its repo folder ${gone} is gone`);
        assert.match(lineWith(out, 'alias'), /^kept no alias for app/);
      }
      assert.equal(store.backlog.has(key, 'bar'), true);
      assert.equal(store[place].has('app', name), true);
      assert.deepEqual([...store.aliases.read()], []);
    });
  }
}

// --- 30. An alias only for what moved, planned as the run does it ---

test('a folder name whose only ledger conflicts in the target gets no alias', (t) => {
  const { h, app, key, store } = appWorld(t);
  store.backlog.write('app', 'x', ledgerText({ slug: 'x', main: app }));
  store.backlog.write(key, 'x', ledgerText({ slug: 'x', main: app, goal: 'Newer.' }));
  for (const out of [failedWith(convert(h, '--dry-run')), failedWith(convert(h))]) assert.doesNotMatch(out, /alias/);
  assert.deepEqual([...store.aliases.read()], []);
});

for (const [what, text] of [
  ['a damaged alias map', '{ not json'],
  ['an alias map with a target that is no repo key', JSON.stringify({ lib: '..' })],
] as const) {
  test(`a dry run with ${what} refuses as the run does, and plans no move`, (t) => {
    const { h, app, store } = appWorld(t);
    writeFileSync(path.join(h, '.claude/ledger-aliases.json'), text);
    store.backlog.write('app', 'x', ledgerText({ slug: 'x', main: app }));
    const [planned, done] = [failedWith(convert(h, '--dry-run')), failedWith(convert(h))];
    for (const out of [planned, done]) assert.doesNotMatch(out, /^(would move|moved) /m);
    assert.equal(planned.split('\n').slice(1).join('\n'), done.split('\n').slice(1).join('\n'));
    assert.equal(store.backlog.has('app', 'x'), true);
  });
}

/** The archive copy `2026-01-01-old` of the repo `app`, moved to its key by hand, its evidence left under `app`. */
function copyMovedWithoutEvidence(t: TestContext) {
  const world = appWorld(t);
  const { h, app, key, store } = world;
  const evidence = path.join(h, 'evidence');
  mkdirSync(evidence);
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  store.archive.write('app', '2026-01-01-old', ledgerText({ slug: 'old', main: app }), evidence);
  mkdirSync(store.archive.repoLocation(key), { recursive: true });
  renameSync(store.archive.location('app', '2026-01-01-old'), store.archive.location(key, '2026-01-01-old'));
  return world;
}

test('a conversion moves evidence a stopped run left beside the copy it moved, when its folder name is an alias of the key', (t) => {
  const { h, key, store } = copyMovedWithoutEvidence(t);
  store.aliases.add('app', key);
  const out = ok(convert(h));
  assert.match(lineWith(out, '2026-01-01-old'), /^moved evidence/);
  assert.deepEqual(store.archive.evidenceFiles(key, '2026-01-01-old'), ['red.txt']);
  assert.equal(store.archive.nameTaken('app', '2026-01-01-old'), false);
});

test('evidence beside a copy moved before its folder name became an alias of the key is left to move by hand, and gets no alias', (t) => {
  const { h, key, store } = copyMovedWithoutEvidence(t);
  assert.match(lineWith(failedWith(convert(h)), 'evidence app/2026-01-01-old'), /^left .*move it by hand/);
  assert.deepEqual(store.archive.evidenceFiles(key, '2026-01-01-old'), []);
  assert.equal(store.archive.nameTaken('app', '2026-01-01-old'), true);
  assert.deepEqual([...store.aliases.read()], []);
});

// --- 31. An alias target is a repo key, never a folder name ---

test('an alias whose target is a folder name is ignored, and no alias is made to one', (t) => {
  const h = home(t);
  writeFileSync(path.join(h, '.claude/ledger-aliases.json'), JSON.stringify({ app: 'lib' }));
  const store = fileStore(ledgerPaths(h));
  assert.deepEqual([...store.aliases.read()], []);
  assert.match(store.aliases.problem() ?? '', /app/);
  assert.throws(() => fileStore(ledgerPaths(home(t))).aliases.add('app', 'lib'), Failure);
});

// --- 32. Tree edits keep two clones' worktree tasks apart ---

test('tree add of an active task named from another clone of the repo lists the one task once, and remove from either clone removes it', (t) => {
  const { h, first, second } = twoClones(t);
  const epic = worktreeTask(h, first, { slug: 'epic' });
  const x = worktreeTask(h, first, { slug: 'x' });
  const childLines = (): string[] => readLedgerFile(epic).split('\n').filter((line) => /^- x\b/.test(line));
  ok(ledger(h, second, 'tree', 'add', `epic@${first}`, 'x'));
  ok(ledger(h, first, 'tree', 'add', 'epic', 'x'));
  assert.deepEqual(childLines(), [`- x @ ${second}`]);
  assert.match(readLedgerFile(x), /- parent: epic @ /);
  ok(ledger(h, first, 'tree', 'remove', 'epic', 'x'));
  assert.deepEqual(childLines(), []);
  assert.doesNotMatch(readLedgerFile(x), /- parent:/);
});

// --- 33. SQLite evidence is never written through a link it holds ---

test('sqlite store: an evidence file under an evidence link is never written through the link', { skip: noSqlite }, (t) => {
  const { h, store } = appWorld(t, 'sqlite');
  store.archive.write('app', '2026-01-01-old', 'old\n');
  const outside = path.join(h, 'outside');
  mkdirSync(outside);
  const db = sqliteDb(h);
  db.prepare(`INSERT INTO evidence VALUES ('app', '2026-01-01-old', 'sub', 'link', ?)`).run(Buffer.from(outside));
  db.prepare(`INSERT INTO evidence VALUES ('app', '2026-01-01-old', 'sub/x.txt', 'file', ?)`).run(Buffer.from('x\n'));
  db.close();
  const to = path.join(h, 'restore/evidence');
  mkdirSync(path.dirname(to), { recursive: true });
  assert.throws(() => store.archive.copyEvidence('app', '2026-01-01-old', to));
  assert.deepEqual(readdirSync(outside), []);
});

// --- 34. Slugs that name no folder of their own ---

test('ledger go refuses ., .. and a slug that starts with a dot', (t) => {
  const { h, app } = appWorld(t);
  for (const slug of ['.', '..', '.hidden']) {
    const ran = ledger(h, app, 'go', slug);
    assert.equal(ran.status, 1, ran.stderr);
    assert.match(ran.stderr, /is not a slug/);
  }
});

// --- 35. Aliases in show and task new ---

test('ledger show finds a ledger left under an alias of the repo, by --repo with the key and from the checkout', (t) => {
  const { h, app, key, store } = appWorld(t);
  store.aliases.add('app', key);
  store.backlog.write('app', 'left', 'left under app\n');
  assert.equal(ok(ledger(h, h, 'show', 'left', '--repo', key)), storedText('left under app\n'));
  assert.equal(ok(ledger(h, app, 'show', 'left')), storedText('left under app\n'));
});

test('ledger task new refuses a slug a backlog ledger has under an alias of the repo', (t) => {
  const { h, app, key, store } = appWorld(t);
  writeFileSync(path.join(h, '.claude/ledger.template.md'), readFileSync(path.join(REPO, 'ledger.template.md'), 'utf8'));
  store.aliases.add('app', key);
  store.backlog.write('app', 'idea', ledgerText({ slug: 'idea', main: app }));
  const ran = ledger(h, app, 'task', 'new', 'idea', '--goal', 'Again.');
  assert.equal(ran.status, 1, ran.stdout);
  assert.match(ran.stderr, /already exists/);
  assert.equal(store.backlog.has(key, 'idea'), false);
});

// --- 36. A storage switch that changes nothing, or is undone ---

const OLD_SCHEMA = `
  CREATE TABLE ledgers (place TEXT NOT NULL, repo TEXT NOT NULL, name TEXT NOT NULL, text BLOB NOT NULL, created_ms REAL NOT NULL, modified_ms REAL NOT NULL, PRIMARY KEY (place, repo, name)) STRICT;
  CREATE TABLE evidence (repo TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY (repo, name, path)) STRICT;
  CREATE TABLE registry (id INTEGER PRIMARY KEY CHECK (id = 1), text TEXT NOT NULL) STRICT;
`;

for (const to of ['sqlite', 'file'] as const) {
  test(`store migrate --to ${to} --dry-run adds no table to a database from before the alias table`, { skip: noSqlite }, (t) => {
    const h = home(t);
    if (to === 'file') useSqlite(h);
    const db = sqliteDb(h);
    db.exec(OLD_SCHEMA);
    db.close();
    ok(ledger(h, h, 'store', 'migrate', '--to', to, '--dry-run'));
    const check = sqliteDb(h);
    const tables = check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all();
    check.close();
    assert.deepEqual(tables.map(({ name }) => name), ['evidence', 'ledgers', 'registry']);
  });
}

test('store migrate --to sqlite that fails removes the aliases it added, and keeps those the database had', { skip: noSqlite }, (t) => {
  const h = home(t);
  const files = fileStore(ledgerPaths(h));
  files.aliases.add('app', OTHER);
  files.aliases.add('lib', 'github.com/me/lib');
  files.backlog.write(OTHER, 'x', 'x\n');
  const before = sqliteStore({ home: h });
  before.aliases.add('lib', 'github.com/me/lib');
  before.close?.();
  const open = (paths: LedgerPaths, storage: 'file' | 'sqlite'): LedgerStore => {
    if (storage === 'file') return fileStore(paths);
    const store = sqliteStore(paths);
    return { ...store, backlog: { ...store.backlog, create: failed('ENOSPC') } };
  };
  assert.throws(() => migrateStorage(ledgerPaths(h), 'sqlite', { removeSource: false, dryRun: false }, () => {}, open), Failure);
  const after = sqliteStore({ home: h });
  t.after(() => after.close?.());
  assert.deepEqual([...after.aliases.read()], [['lib', 'github.com/me/lib']]);
});

// --- 38. An old task list entry counts as a ledger an earlier run moved only when it is surely that ledger's ---

test('a stale old task list entry is not taken for a ledger of its name that has an entry of its own, so no alias is made', (t) => {
  const { h, app, key, store } = appWorld(t);
  store.backlog.write(key, 'x', ledgerText({ slug: 'x', main: app, goal: 'Unrelated.' }));
  const own = { ...backlogEntry(store, key, 'x', app), created: '2026-02-01T00:00:00.000Z' };
  writeOldTaskList(h, [backlogEntry(store, 'app', 'x', app), own]);
  ok(convert(h));
  assert.deepEqual([...store.aliases.read()], []);
});

// --- 39. Leftover evidence is planned before anything moves ---

test('evidence left under one folder name is not attached to a copy this run moves from another, in a dry run and in the run alike', (t) => {
  const h = home(t);
  const b = repository(h, path.join(h, 'repos/b'));
  const store = fileStore(ledgerPaths(h));
  store.archive.write('a', '2026-01-01-old', ledgerText({ slug: 'old', main: b }));
  const stray = store.archive.evidenceLocation('b', '2026-01-01-old');
  mkdirSync(stray, { recursive: true });
  writeFileSync(path.join(stray, 'red.txt'), 'failing\n');
  const planned = failedWith(convert(h, '--dry-run'));
  const done = failedWith(convert(h));
  for (const out of [planned, done]) assert.equal(lineWith(out, 'evidence b/2026-01-01-old'), 'left evidence b/2026-01-01-old: notes of a finished task, while a ledger of its name is under a; move them by hand beside it if they are its notes');
  assert.equal(store.archive.has(repoKeyOf(b), '2026-01-01-old'), true);
  assert.deepEqual(store.archive.evidenceFiles(repoKeyOf(b), '2026-01-01-old'), []);
  assert.equal(existsSync(path.join(stray, 'red.txt')), true);
  const rerun = failedWith(convert(h));
  assert.match(lineWith(rerun, 'evidence b/2026-01-01-old'), /^left evidence b\/2026-01-01-old/);
  assert.deepEqual(store.archive.evidenceFiles(repoKeyOf(b), '2026-01-01-old'), []);
  assert.equal(existsSync(path.join(stray, 'red.txt')), true);
  assert.deepEqual([...store.aliases.read()], [['a', repoKeyOf(b)]]);
});

// --- 40. A same-key conflict beside a move ---

test('a folder name with one ledger the key already has and one that moves still becomes an alias, and the run exits 1', (t) => {
  const { h, app, key, store } = appWorld(t);
  store.backlog.write('app', 'x', ledgerText({ slug: 'x', main: app }));
  store.backlog.write('app', 'y', ledgerText({ slug: 'y', main: app }));
  store.backlog.write(key, 'x', ledgerText({ slug: 'x', main: app, goal: 'Already here.' }));
  const out = failedWith(convert(h));
  assert.match(lineWith(out, 'backlog app/x'), /already has x/);
  assert.match(lineWith(out, 'backlog app/y'), /^moved/);
  assert.deepEqual([...store.aliases.read()], [['app', key]]);
});

// --- 41. SQLite evidence is never written through a link restored before it ---

test('sqlite store: an evidence link under an evidence link restored before it is never written through it', { skip: noSqlite }, (t) => {
  const { h, store } = appWorld(t, 'sqlite');
  store.archive.write('app', '2026-01-01-old', 'old\n');
  const outside = path.join(h, 'outside');
  mkdirSync(outside);
  const db = sqliteDb(h);
  db.prepare(`INSERT INTO evidence VALUES ('app', '2026-01-01-old', 'sub', 'link', ?)`).run(Buffer.from(outside));
  db.prepare(`INSERT INTO evidence VALUES ('app', '2026-01-01-old', 'sub/inner', 'link', ?)`).run(Buffer.from('anywhere'));
  db.close();
  const to = path.join(h, 'restore/evidence');
  mkdirSync(path.dirname(to), { recursive: true });
  assert.throws(() => store.archive.copyEvidence('app', '2026-01-01-old', to), failure('sub/inner'));
  assert.deepEqual(readdirSync(outside), []);
});

// --- 42. A shared backlog parent keeps each clone's worktree child apart ---

test('an active child named from either clone of the repo has one line under a backlog parent, which names the clone of its worktree', (t) => {
  const { h, first, second } = twoClones(t);
  ok(ledger(h, first, 'task', 'new', 'epic', '--goal', 'Shared work.'));
  const mine = worktreeTask(h, first, { slug: 'x' });
  const store = fileStore(ledgerPaths(h));
  const childLines = (): string[] => (store.backlog.read(repoKeyOf(first), 'epic')?.text ?? '').split('\n').filter((line) => /^- x\b/.test(line));
  ok(ledger(h, first, 'tree', 'add', 'epic', 'x'));
  ok(ledger(h, second, 'tree', 'add', 'epic', 'x'));
  assert.deepEqual(childLines(), [`- x @ ${first}`]);
  assert.match(readLedgerFile(mine), /- parent: epic\n/);
  ok(ledger(h, second, 'tree', 'remove', 'epic', 'x'));
  assert.deepEqual(childLines(), []);
});

// --- 43. ledger go checks the slug of the child it starts ---

test('ledger go <parent> refuses a child whose slug starts with a dot, and makes no worktree for it', (t) => {
  const { h, app, key, store } = appWorld(t);
  store.backlog.write(key, 'epic', ledgerText({ slug: 'epic', main: app, children: ['- .hidden'] }));
  store.backlog.write(key, '.hidden', ledgerText({ slug: '.hidden', main: app, parent: 'epic' }));
  const ran = ledger(h, app, 'go', 'epic');
  assert.equal(ran.status, 1, ran.stdout);
  assert.match(ran.stderr, /"\.hidden" is not a slug/);
  assert.equal(existsSync(path.join(app, '.claude/worktrees/.hidden')), false);
});

// --- 44. ledger show --repo: an exact key or alias beats a label ---

test('ledger show --repo with an alias finds its repo, though two keys have that label', (t) => {
  const { h, key, store } = appWorld(t);
  assert.equal(repoLabel(key), 'app');
  store.aliases.add('app', key);
  store.backlog.write(key, 'left', 'left under the key\n');
  store.backlog.write(path.join(h, 'elsewhere/app'), 'other', 'other\n');
  assert.equal(ok(ledger(h, h, 'show', 'left', '--repo', 'app')), storedText('left under the key\n'));
});

// --- 45. A storage switch dry run refuses what the run refuses ---

test('store migrate --to sqlite --dry-run stops, like the run, when the database refuses alias writes', { skip: noSqlite }, (t) => {
  const h = home(t);
  const files = fileStore(ledgerPaths(h));
  files.aliases.add('app', OTHER);
  files.backlog.write(OTHER, 'x', 'x\n');
  sqliteStore({ home: h }).close?.();
  const db = sqliteDb(h);
  db.exec(`INSERT INTO aliases VALUES ('lib', '..')`);
  db.close();
  for (const args of [['--dry-run'], []]) {
    const out = failedWith(ledger(h, h, 'store', 'migrate', '--to', 'sqlite', ...args));
    assert.match(lineWith(out, 'stopped'), /lib/);
  }
});

test('store migrate --to sqlite stops, also as a dry run, when the alias file it copies from cannot be read', { skip: noSqlite || process.platform === 'win32' || process.getuid?.() === 0 }, (t) => {
  const h = home(t);
  const files = fileStore(ledgerPaths(h));
  files.aliases.add('app', OTHER);
  files.backlog.write(OTHER, 'x', 'x\n');
  const aliasFile = path.join(h, '.claude/ledger-aliases.json');
  chmodSync(aliasFile, 0o000);
  for (const args of [['--dry-run'], []]) {
    const out = failedWith(ledger(h, h, 'store', 'migrate', '--to', 'sqlite', ...args));
    assert.match(lineWith(out, 'stopped'), /alias/);
  }
  const after = sqliteStore({ home: h });
  t.after(() => after.close?.());
  assert.equal(after.backlog.has(OTHER, 'x'), false);
});

// --- 46. SQLite evidence checks the folders it writes into, by the platform's own path rules ---

test('sqlite store: an evidence link whose name holds a backslash is restored beside a link, not refused as under it', { skip: noSqlite || process.platform === 'win32' }, (t) => {
  const { h, store } = appWorld(t, 'sqlite');
  store.archive.write('app', '2026-01-01-old', 'old\n');
  const outside = path.join(h, 'outside');
  mkdirSync(outside);
  const db = sqliteDb(h);
  db.prepare(`INSERT INTO evidence VALUES ('app', '2026-01-01-old', 'sub', 'link', ?)`).run(Buffer.from(outside));
  db.prepare(`INSERT INTO evidence VALUES ('app', '2026-01-01-old', 'sub\\inner', 'link', ?)`).run(Buffer.from('anywhere'));
  db.close();
  const to = path.join(h, 'restore/evidence');
  mkdirSync(path.dirname(to), { recursive: true });
  store.archive.copyEvidence('app', '2026-01-01-old', to);
  assert.equal(lstatSync(path.join(to, 'sub\\inner')).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(outside), []);
});

// --- 47. A backlog parent names the clone of each worktree child ---

test('ledger go of a backlog child of a backlog parent names its clone in the child line', (t) => {
  const { h, first } = twoClones(t);
  ok(ledger(h, first, 'task', 'new', 'epic', '--goal', 'Shared work.'));
  ok(ledger(h, first, 'task', 'new', 'x', '--goal', 'One part.'));
  ok(ledger(h, first, 'tree', 'add', 'epic', 'x'));
  const childLines = (): string[] => (fileStore(ledgerPaths(h)).backlog.read(repoKeyOf(first), 'epic')?.text ?? '').split('\n').filter((line) => /^- x\b/.test(line));
  assert.deepEqual(childLines(), ['- x']);
  ok(ledger(h, first, 'go', 'x'));
  assert.equal(childLines().length, 1);
  assert.ok(childLines()[0].startsWith(`- x @ ${first} (started `), childLines()[0]);
});

test('tree add refuses a worktree child of a backlog parent in a clone whose path has whitespace, and writes neither ledger', (t) => {
  const h = home(t);
  writeFileSync(path.join(h, '.claude/ledger.template.md'), readFileSync(path.join(REPO, 'ledger.template.md'), 'utf8'));
  const spaced = repository(h, path.join(h, 'repos/my app'));
  ok(ledger(h, spaced, 'task', 'new', 'epic', '--goal', 'Shared work.'));
  const child = worktreeTask(h, spaced, { slug: 'x' });
  const before = readFileSync(child, 'utf8');
  const ran = ledger(h, spaced, 'tree', 'add', 'epic', 'x');
  assert.equal(ran.status, 1, ran.stdout);
  assert.match(ran.stderr, /whitespace/);
  assert.equal(readFileSync(child, 'utf8'), before);
  assert.doesNotMatch(fileStore(ledgerPaths(h)).backlog.read(repoKeyOf(spaced), 'epic')?.text ?? '', /^- x\b/m);
});

// --- 48. ledger show searches the repo key and its aliases together ---

test('ledger show prefers a backlog ledger under an alias to an archive copy under the key', (t) => {
  const { h, app, key, store } = appWorld(t);
  store.aliases.add('app', key);
  store.backlog.write('app', 'x', 'in the backlog\n');
  store.archive.write(key, '2026-01-01-x', 'archived\n');
  assert.equal(ok(ledger(h, app, 'show', 'x')), storedText('in the backlog\n'));
});

test('ledger show picks the newest archive copy across the key and its aliases', (t) => {
  const { h, app, key, store } = appWorld(t);
  store.aliases.add('app', key);
  store.archive.write(key, '2026-01-01-x', 'older\n');
  store.archive.write('app', '2026-02-01-x', 'newer\n');
  assert.equal(ok(ledger(h, app, 'show', 'x')), storedText('newer\n'));
});

// --- 49. A storage switch checks the target's aliases even when it adds none ---

test('store migrate --to sqlite stops when the database refuses alias writes, though the files hold no alias', { skip: noSqlite }, (t) => {
  const h = home(t);
  fileStore(ledgerPaths(h)).backlog.write(OTHER, 'x', 'x\n');
  sqliteStore({ home: h }).close?.();
  const db = sqliteDb(h);
  db.exec(`INSERT INTO aliases VALUES ('lib', '..')`);
  db.close();
  for (const args of [['--dry-run'], []]) {
    const out = failedWith(ledger(h, h, 'store', 'migrate', '--to', 'sqlite', ...args));
    assert.match(lineWith(out, 'stopped'), /lib/);
  }
});

// --- 50. A SQLite ledger name may end in .md ---

test('sqlite store: a rerun records the alias of a ledger named fix.md that an earlier run moved', { skip: noSqlite }, (t) => {
  const { h, app, key, store } = appWorld(t, 'sqlite');
  store.backlog.write(key, 'fix.md', ledgerText({ slug: 'fix.md', main: app }));
  writeOldTaskList(h, [backlogEntry(store, 'app', 'fix.md', app)], 'sqlite');
  ok(convert(h));
  assert.deepEqual([...store.aliases.read()], [['app', key]]);
});

// --- 52. Stray evidence joins a moved copy only from an alias of its key ---

test('a rerun leaves evidence of a folder name that is no alias beside a copy moved from another folder name, and exits 1', (t) => {
  const h = home(t);
  const b = repository(h, path.join(h, 'repos/b'));
  const c = repository(h, path.join(h, 'repos/c'));
  const store = fileStore(ledgerPaths(h));
  store.archive.write('a', '2026-01-01-old', ledgerText({ slug: 'old', main: b }));
  store.backlog.write('a', 'other', ledgerText({ slug: 'other', main: c }));
  const stray = store.archive.evidenceLocation('b', '2026-01-01-old');
  mkdirSync(stray, { recursive: true });
  writeFileSync(path.join(stray, 'red.txt'), 'failing\n');
  failedWith(convert(h));
  assert.deepEqual([...store.aliases.read()], []);
  assert.match(lineWith(failedWith(convert(h)), 'evidence b/2026-01-01-old'), /^left .*move it by hand/);
  assert.deepEqual(store.archive.evidenceFiles(repoKeyOf(b), '2026-01-01-old'), []);
  assert.equal(existsSync(path.join(stray, 'red.txt')), true);
  assert.deepEqual([...store.aliases.read()], []);
});

for (const [what, arrange] of [
  [
    'its key is an alias of another folder name too',
    (h: string, store: LedgerStore): void => {
      const b = repository(h, path.join(h, 'repos/b'));
      store.aliases.add('a', repoKeyOf(b));
      store.aliases.add('b', repoKeyOf(b));
      store.archive.write(repoKeyOf(b), '2026-01-01-old', ledgerText({ slug: 'old', main: b }));
    },
  ],
  [
    'two keys hold a copy of its name from that folder name',
    (h: string, store: LedgerStore): void => {
      for (const main of [localRepo(h, path.join(h, 'repos/b')), localRepo(h, path.join(h, 'issues/b'))]) {
        store.archive.write(repoKeyOf(main), '2026-01-01-old', ledgerText({ slug: 'old', main }));
      }
    },
  ],
] as const) {
  test(`stray evidence whose copy is ambiguous, as ${what}, is reported as ambiguous and stays`, (t) => {
    const h = home(t);
    const store = fileStore(ledgerPaths(h));
    arrange(h, store);
    const stray = store.archive.evidenceLocation('b', '2026-01-01-old');
    mkdirSync(stray, { recursive: true });
    writeFileSync(path.join(stray, 'red.txt'), 'failing\n');
    assert.match(lineWith(failedWith(convert(h)), 'evidence b/2026-01-01-old'), /^left evidence b\/2026-01-01-old: ambiguous/);
    assert.equal(existsSync(path.join(stray, 'red.txt')), true);
  });
}

// --- 53. ledger go names the clone it starts a child in ---

test('ledger go of a backlog child in one clone rewrites its line that names another clone to name this one', (t) => {
  const { h, first, second } = twoClones(t);
  ok(ledger(h, first, 'task', 'new', 'epic', '--goal', 'Shared work.'));
  ok(ledger(h, first, 'task', 'new', 'x', '--goal', 'One part.'));
  ok(ledger(h, first, 'tree', 'add', 'epic', 'x'));
  const store = fileStore(ledgerPaths(h));
  const childLines = (): string[] => (store.backlog.read(repoKeyOf(first), 'epic')?.text ?? '').split('\n').filter((line) => /^- x\b/.test(line));
  store.backlog.update(repoKeyOf(first), 'epic', (text) => text.replace(/^- x$/m, `- x @ ${first}`));
  assert.deepEqual(childLines(), [`- x @ ${first}`]);
  ok(ledger(h, second, 'go', 'x'));
  assert.equal(childLines().length, 1);
  assert.ok(childLines()[0].startsWith(`- x @ ${second} (started `), childLines()[0]);
});

test('ledger go in one clone of a slug active in another clone fails, naming that worktree, and keeps the line of the active task', (t) => {
  const { h, first, second } = twoClones(t);
  ok(ledger(h, first, 'task', 'new', 'epic', '--goal', 'Shared work.'));
  worktreeTask(h, first, { slug: 'x' });
  ok(ledger(h, first, 'tree', 'add', 'epic', 'x'));
  const store = fileStore(ledgerPaths(h));
  store.backlog.write(repoKeyOf(first), 'x', ledgerText({ slug: 'x', main: second, parent: 'epic' }));
  refusedAsTaken(ledger(h, second, 'go', 'x'), 'x', worktreeOf(first, 'x'));
  assert.equal(existsSync(worktreeOf(second, 'x')), false);
  assert.deepEqual(
    (store.backlog.read(repoKeyOf(first), 'epic')?.text ?? '').split('\n').filter((line) => /^- x\b/.test(line)),
    [`- x @ ${first}`],
  );
});

// --- 54. ledger show prefers a live ledger to an archive copy ---

test('ledger show prints the worktree ledger of a task, not an older archive copy of its slug', (t) => {
  const { h, app, key, store } = appWorld(t);
  const live = worktreeTask(h, app, { slug: 'x' });
  store.archive.write(key, '2026-01-01-x', 'archived\n');
  assert.equal(ok(ledger(h, app, 'show', 'x')), readLedgerFile(live));
});

test('ledger show prints the worktree ledger of a task, not a backlog ledger of its slug under an alias of the repo', (t) => {
  const { h, app, key, store } = appWorld(t);
  store.aliases.add('app', key);
  store.backlog.write('app', 'x', 'in the backlog\n');
  const live = worktreeTask(h, app, { slug: 'x' });
  assert.equal(ok(ledger(h, app, 'show', 'x')), readLedgerFile(live));
});

// --- 55. A clone that is gone has no worktree task to keep its child line ---

test('ledger go in one clone of a slug whose active task was in a removed clone fails, naming that worktree, and keeps its line', (t) => {
  const { h, first, second } = twoClones(t);
  const key = repoKeyOf(first);
  ok(ledger(h, first, 'task', 'new', 'epic', '--goal', 'Shared work.'));
  worktreeTask(h, first, { slug: 'x' });
  ok(ledger(h, first, 'tree', 'add', 'epic', 'x'));
  const store = fileStore(ledgerPaths(h));
  const childLines = (): string[] => (store.backlog.read(key, 'epic')?.text ?? '').split('\n').filter((line) => /^- x\b/.test(line));
  assert.deepEqual(childLines(), [`- x @ ${first}`]);
  rmSync(first, { recursive: true, force: true });
  store.backlog.write(key, 'x', ledgerText({ slug: 'x', main: second, parent: 'epic' }));
  refusedAsTaken(ledger(h, second, 'go', 'x'), 'x', worktreeOf(first, 'x'));
  assert.deepEqual(childLines(), [`- x @ ${first}`]);
});

// --- 56. ledger show --repo takes the short label of the clone it runs in ---

test('ledger show --repo with the short label of the clone it runs in finds its worktree ledger, though the store has nothing of the repo', (t) => {
  const { h, app, key } = appWorld(t);
  const live = worktreeTask(h, app, { slug: 'x' });
  assert.equal(ok(ledger(h, app, 'show', 'x', '--repo', repoLabel(key))), readLedgerFile(live));
});

test('the error of ledger show --repo of another repo names what it searched: the active tasks, the backlog and the archive', (t) => {
  const { h, app } = appWorld(t);
  const ran = ledger(h, app, 'show', 'nothing', '--repo', OTHER);
  assert.equal(ran.status, 1);
  assert.equal(ran.stderr.trim(), 'No ledger named nothing is in the active tasks, the backlog or the archive of the repo me/app.');
});

// --- 29. A worktree path recorded relative to its repo names no repo ---

/** An archive copy under the folder name expo whose ledger names only `.claude/worktrees/spm`, as early ledgers did. */
function relativeWorktreeCopy(store: LedgerStore): void {
  store.archive.write('expo', '2026-01-02-spm', ledgerText({ slug: 'spm', worktree: '.claude/worktrees/spm', branch: 'me/spm' }));
}

const pendingFrom = (h: string, cwd: string): Move[] => (JSON.parse(ok(ledger(h, cwd, 'store', 'migrate', '--pending', '--json'))) as { moves: Move[] }).moves;

test('an archive copy whose worktree path is relative stays under its folder name, run from the main checkout of another repo', (t) => {
  const { h, app, store } = appWorld(t);
  relativeWorktreeCopy(store);
  assert.deepEqual(pendingFrom(h, app), [
    { kind: 'repo-ids', from: 'archive expo/2026-01-02-spm', to: 'repo address', auto: false, reason: 'its ledger does not say which repo folder it came from', accepted: true },
  ]);
  assert.match(ok(ledger(h, app, 'store', 'migrate', '--repo-ids', '--dry-run')), kept(1));
  assert.match(ok(ledger(h, app, 'store', 'migrate', '--repo-ids')), kept(1));
  assert.equal(store.archive.has('expo', '2026-01-02-spm'), true);
});

test('an archive copy whose worktree path is relative moves to the alias saved for its folder name, run from the main checkout of another repo', (t) => {
  const { h, app, store } = appWorld(t);
  store.aliases.add('expo', 'github.com/me/expo');
  relativeWorktreeCopy(store);
  assert.match(lineWith(ok(ledger(h, app, 'store', 'migrate', '--repo-ids')), '2026-01-02-spm'), /^moved archive expo\/2026-01-02-spm to /);
  assert.equal(store.archive.has('github.com/me/expo', '2026-01-02-spm'), true);
});

test('evidence under the folder name of an archive copy whose worktree path is relative gets no hint naming the repo it is run from', (t) => {
  const { h, app, key, store } = appWorld(t);
  relativeWorktreeCopy(store);
  const folder = store.archive.evidenceLocation('expo', '2026-01-01-old');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'red.txt'), 'failing\n');
  const evidence = pendingFrom(h, app).find(({ from }) => from === 'evidence expo/2026-01-01-old');
  assert.deepEqual(evidence, { kind: 'repo-ids', from: 'evidence expo/2026-01-01-old', to: 'repo address', auto: false, reason: 'notes of a finished task whose ledger is not in the store', accepted: true });
  assert.equal(sessionStart(h, app), '');
  assert.doesNotMatch(ok(ledger(h, app, 'store', 'migrate', '--repo-ids')), new RegExp(key.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('rollback preserves a replaced target record', (t) => {
  const { h, store } = appWorld(t);
  store.backlog.write('app', 'x', 'mine\n');
  writeFileSync(path.join(store.backlog.repoLocation('app'), 'x.md'), 'hidden\n');
  const moving = fileStore(ledgerPaths(h), {
    link: (from, to) => {
      if (from.endsWith('.md')) throw Object.assign(new Error('Markdown link failed'), { code: 'EIO' });
      linkSync(from, to);
      writeFileSync(`${to}.writer`, recordJson(recordToWrite('writer\n', to)));
      renameSync(`${to}.writer`, to);
    },
  });

  try {
    assert.throws(() => moving.backlog.move('app', 'x', OTHER), /Markdown link failed/, 'the move must report the failed link');
  } finally {
    assert.equal(store.backlog.read(OTHER, 'x')?.text, storedText('writer\n'), 'rollback removed the writer’s target record');
  }
});

test('a writer reclaiming the source lock keeps its update', (t) => {
  const { h, store } = appWorld(t);
  store.active.write('app', 'x', 'mine\n');
  const moving = fileStore(ledgerPaths(h), {
    link: (from, to) => {
      linkSync(from, to);
      writeFileSync(`${from}.lock`, JSON.stringify({ pid: process.pid, since: new Date(Date.now() - 120_000).toISOString() }));
      assert.ok(store.active.update('app', 'x', () => 'writer\n'));
    },
  });

  const moved = moving.active.move('app', 'x', OTHER);
  assert.equal(store.active.read(moved ? OTHER : 'app', 'x')?.text, storedText('writer\n'), 'the move lost the writer’s update');
  assert.equal(store.active.has(moved ? 'app' : OTHER, 'x'), false);
});

test('rollback preserves a record another mover finished moving', (t) => {
  const { h, store } = appWorld(t);
  store.backlog.write('app', 'x', 'mine\n');
  writeFileSync(path.join(store.backlog.repoLocation('app'), 'x.md'), 'hidden\n');
  const moving = fileStore(ledgerPaths(h), {
    link: (from, to) => {
      if (from.endsWith('.md')) throw Object.assign(new Error('Markdown link failed'), { code: 'EIO' });
      linkSync(from, to);
      rmSync(from);
    },
  });
  assert.throws(() => moving.backlog.move('app', 'x', OTHER), /Markdown link failed/);
  assert.equal(store.backlog.read(OTHER, 'x')?.text, storedText('mine\n'), 'rollback removed the completed move’s only record');
});

test('rollback takes back moved Markdown a writer turned into a record at the source', (t) => {
  const { h, store } = appWorld(t);
  const source = store.backlog.repoLocation('app');
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, 'x.md'), 'mine\n');
  const moving = fileStore(ledgerPaths(h), {
    link: (from, to) => {
      linkSync(from, to);
      const record = from.replace(/\.md$/, '.json');
      writeFileSync(record, recordJson(recordToWrite('writer\n', record)));
      rmSync(from);
    },
  });

  assert.equal(moving.backlog.move('app', 'x', OTHER), false);
  assert.equal(existsSync(path.join(store.backlog.repoLocation(OTHER), 'x.md')), false, 'rollback kept the stale Markdown under the new key');
  assert.equal(store.backlog.read('app', 'x')?.text, storedText('writer\n'), 'the writer’s record left the old key');
});

test('rollback keeps the target Markdown when a directory replaces the source', (t) => {
  const h = home(t);
  const { backlog } = fileStore(ledgerPaths(h), {
    link: (from, to) => {
      linkSync(from, to);
      rmSync(from);
      mkdirSync(from);
    },
  });
  const source = backlog.repoLocation('old');
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, 'x.md'), 'mine\n');

  assert.equal(backlog.move('old', 'x', 'new'), false);
  assert.ok(existsSync(path.join(backlog.repoLocation('new'), 'x.md')), 'rollback removed new/x.md');
});
