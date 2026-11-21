import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Failure } from '../tools/ledger/failure.js';
import { fileStore } from '../tools/ledger/file-store.js';
import { conversionHint, migrateRepoIds } from '../tools/ledger/migrate-repo-ids.js';
import { migrateStorage } from '../tools/ledger/migrate.js';
import { ledgerPaths, type LedgerPaths } from '../tools/ledger/paths.js';
import { storedText } from '../tools/ledger/record.js';
import { repoLabel } from '../tools/ledger/repo-key.js';
import { sqliteFile, sqliteStore } from '../tools/ledger/sqlite-store.js';
import type { LedgerStore } from '../tools/ledger/store.js';
import { REPO } from './helpers.js';
import { commandEnv, git, home, LEDGER_BIN, ledger, ledgerText, lineWith, noSqlite, ok, readLedgerFile, repoKeyOf, repository, worktreeOf, worktreeTask, type Ran } from './ledger-core-fixtures.js';

type Storage = 'file' | 'sqlite';

const openStore = (h: string, storage: Storage): LedgerStore => (storage === 'sqlite' ? sqliteStore({ home: h }) : fileStore(ledgerPaths(h)));

const useSqlite = (h: string): void => writeFileSync(path.join(h, '.claude/ledger-settings.json'), JSON.stringify({ storage: 'sqlite' }));

const registryEntries = (store: LedgerStore): { repo: string; slug: string; path: string; created: string }[] => JSON.parse(store.registry.read() ?? '[]');

const writeRegistry = (store: LedgerStore, entries: object[]): void => store.registry.write(`${JSON.stringify(entries, null, 2)}\n`);

const failedWith = (ran: Ran): string => {
  assert.equal(ran.status, 1, `exit 1 expected:\n${ran.stdout}\n${ran.stderr}`);
  return `${ran.stdout}${ran.stderr}`;
};

const convert = (h: string, ...args: string[]): Ran => ledger(h, h, 'store', 'migrate', '--repo-ids', ...args);

const OTHER = 'github.com/me/app';

const sqliteDb = (h: string) => new (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync(sqliteFile(h));

const failure = (needle: string) => (error: unknown): boolean => error instanceof Failure && error.message.includes(needle);

/** A HOME with the repo ~/repos/app, whose origin is a local bare repo, and the store of `storage`. */
function appWorld(t: TestContext, storage: Storage = 'file') {
  const h = home(t);
  if (storage === 'sqlite') useSqlite(h);
  const app = repository(h, path.join(h, 'repos/app'));
  const store = openStore(h, storage);
  t.after(() => store.close?.());
  return { h, app, key: repoKeyOf(app), store };
}

const created = '2025-12-01T00:00:00.000Z';

/** A linked worktree of `main` with a .claude/ledger.md, as an active task was kept before the store held it, for a registry entry from then. */
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

test('a rerun records the alias and moves the registry entry of a ledger an earlier run moved before it stopped', (t) => {
  const { h, app, key, store } = appWorld(t);
  store.backlog.write(key, 'fix-login', ledgerText({ slug: 'fix-login', main: app }));
  writeRegistry(store, [backlogEntry(store, 'app', 'fix-login', app)]);
  ok(convert(h));
  assert.deepEqual([...store.aliases.read()], [['app', key]]);
  const [entry] = registryEntries(store);
  assert.deepEqual([entry.repo, entry.path, entry.created], [key, store.backlog.location(key, 'fix-login'), created]);
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

// --- 2. File-store moves rename on one disk, onto nothing ---

test('file store: a backlog move onto a hard link of the ledger is refused, and both stay', (t) => {
  const { store } = appWorld(t);
  store.backlog.write('app', 'x', 'same\n');
  mkdirSync(store.backlog.repoLocation('github.com/me/app'), { recursive: true });
  linkSync(store.backlog.location('app', 'x'), store.backlog.location('github.com/me/app', 'x'));
  assert.equal(store.backlog.canMove('app', 'x', 'github.com/me/app'), false);
  assert.equal(store.backlog.move('app', 'x', 'github.com/me/app'), false);
  assert.equal(store.backlog.read('app', 'x')?.text, storedText('same\n'));
  assert.equal(store.backlog.read('github.com/me/app', 'x')?.text, storedText('same\n'));
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

test('file store: an archive move onto a hard link of the copy is refused, and neither the copy nor its evidence moves', (t) => {
  const { h, store } = appWorld(t);
  archivedWithEvidence(h, store);
  mkdirSync(store.archive.repoLocation(OTHER), { recursive: true });
  linkSync(store.archive.location('app', '2026-01-01-old'), store.archive.location(OTHER, '2026-01-01-old'));
  assert.equal(store.archive.move('app', '2026-01-01-old', OTHER), false);
  assert.equal(store.archive.has('app', '2026-01-01-old'), true);
  assert.deepEqual(store.archive.evidenceFiles('app', '2026-01-01-old'), ['red.txt']);
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
  writeRegistry(store, [
    { ...backlogEntry(store, 'app', 'one', app), status: 'active', path: path.join(app, '.claude/worktrees/one/.claude/ledger.md') },
    { ...backlogEntry(store, 'app', 'two', path.join(h, 'issues/app')), status: 'active', path: path.join(h, 'issues/app/.claude/worktrees/two/.claude/ledger.md') },
  ]);
  const out = failedWith(convert(h));
  assert.match(lineWith(out, '2026-01-01-bare'), /^left .*ambiguous|^left .*2 checkouts/);
  assert.equal(store.archive.has('app', '2026-01-01-bare'), true);
});

// --- 8. Registry entries with no ledger in the store ---

test('an active entry of a folder in no git repo, with no main, gets that folder as its key, and no alias as nothing moved', (t) => {
  const h = home(t);
  const folder = path.join(h, 'work/disk-watcher');
  mkdirSync(path.join(folder, '.claude'), { recursive: true });
  const file = path.join(folder, '.claude/ledger.md');
  writeFileSync(file, ledgerText({ slug: 'scan' }));
  const store = fileStore(ledgerPaths(h));
  writeRegistry(store, [{ repo: 'disk-watcher', slug: 'scan', path: file, branch: '', status: 'active', created, updated: created }]);
  ok(convert(h));
  assert.equal(registryEntries(store)[0].repo, folder);
  assert.deepEqual([...store.aliases.read()], []);
});

test('an active entry whose ledger is there gets the new key, and no alias as nothing moved', (t) => {
  const { h, app, key, store } = appWorld(t);
  const live = legacyWorktreeLedger(h, app, 'live');
  writeRegistry(store, [{ ...backlogEntry(store, 'app', 'live', app), status: 'active', path: live }]);
  ok(convert(h));
  assert.deepEqual([...store.aliases.read()], []);
  assert.equal(registryEntries(store)[0].repo, key);
});

test('an active entry whose ledger is missing is reported and keeps its key, and the run exits 1', (t) => {
  const { h, app, store } = appWorld(t);
  writeRegistry(store, [{ ...backlogEntry(store, 'app', 'live', app), status: 'active', path: path.join(app, '.claude/worktrees/live/.claude/ledger.md') }]);
  assert.match(lineWith(failedWith(convert(h)), 'live'), /^left registry entry app\/live/);
  assert.deepEqual([...store.aliases.read()], []);
  assert.equal(registryEntries(store)[0].repo, 'app');
});

test('an active entry whose main checkout is gone is reported, and the run exits 1', (t) => {
  const h = home(t);
  const store = fileStore(ledgerPaths(h));
  const gone = path.join(h, 'repos/gone');
  writeRegistry(store, [{ repo: 'gone', slug: 'live', path: path.join(gone, '.claude/worktrees/live/.claude/ledger.md'), branch: 'live', status: 'active', main: gone, created, updated: created }]);
  assert.match(lineWith(failedWith(convert(h)), 'live'), /^left registry entry gone\/live/);
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
  failedWith(convert(h));
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
  const otherDisk = fileStore(ledgerPaths(h), { rename: failed('EXDEV') });
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
  const left = migrateRepoIds(fileStore(ledgerPaths(h), { rename: failed('EXDEV') }), { dryRun: false }, (line) => lines.push(line));
  assert.equal(left, 1);
  assert.match(lineWith(lines.join('\n'), 'backlog app/x'), /^left .*on another disk, move by hand/);
  assert.equal(store.backlog.has('app', 'x'), true);
  assert.deepEqual([...store.aliases.read()], []);
});

test('file store: a move that fails leaves no target folder behind', (t) => {
  const { h, store } = appWorld(t);
  store.backlog.write('app', 'x', 'x\n');
  archivedWithEvidence(h, store);
  const failing = fileStore(ledgerPaths(h), { rename: failed('EIO') });
  assert.throws(() => failing.backlog.move('app', 'x', OTHER), /EIO/);
  assert.throws(() => failing.archive.move('app', '2026-01-01-old', OTHER), /EIO/);
  assert.equal(existsSync(store.backlog.repoLocation(OTHER)), false);
  assert.equal(existsSync(store.archive.repoLocation(OTHER)), false);
  assert.equal(store.backlog.has('app', 'x'), true);
  assert.deepEqual(store.archive.evidenceFiles('app', '2026-01-01-old'), ['red.txt']);
});

// --- 22. A rerun places a ledger by the alias an earlier run saved ---

test('a rerun files an archive copy that names no main under the alias an earlier run saved', (t) => {
  const { h, key, store } = appWorld(t);
  store.aliases.add('app', key);
  store.archive.write('app', '2026-01-02-bare', ledgerText({ slug: 'bare' }));
  assert.match(lineWith(ok(convert(h)), '2026-01-02-bare'), /^moved/);
  assert.equal(store.archive.has(key, '2026-01-02-bare'), true);
});

// --- 23. Aliases are never changed, and registry entries are re-keyed only with their ledger ---

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

test('a registry entry whose ledger is gone is reported and keeps its key, and the run exits 1', (t) => {
  const { h, app, key, store } = appWorld(t);
  store.aliases.add('app', key);
  writeRegistry(store, [backlogEntry(store, 'app', 'ghost', app)]);
  assert.match(lineWith(failedWith(convert(h)), 'ghost'), /^left registry entry app\/ghost: its ledger is gone/);
  assert.equal(registryEntries(store)[0].repo, 'app');
});

test('an archived registry entry that names no archive copy is reported, and the run exits 1', (t) => {
  const { h, app, store } = appWorld(t);
  writeRegistry(store, [{ ...backlogEntry(store, 'app', 'old', app), status: 'archived' }]);
  assert.match(lineWith(failedWith(convert(h)), 'app/old'), /^left registry entry app\/old/);
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

// --- 27. Registry entries and evidence still under folder names ---

const sessionStart = (h: string): string => {
  const ran = spawnSync(LEDGER_BIN, ['hook', 'session-start'], { cwd: h, env: commandEnv(h), input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: h }), encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout === '' ? '' : (JSON.parse(ran.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
};

test('session-start gives the conversion hint when only registry entries use folder names', (t) => {
  const h = home(t);
  const store = fileStore(ledgerPaths(h));
  const gone = path.join(h, 'repos/gone');
  writeRegistry(store, [{ repo: 'gone', slug: 'live', path: path.join(gone, '.claude/worktrees/live/.claude/ledger.md'), branch: 'live', status: 'active', main: gone, created, updated: created }]);
  assert.equal(sessionStart(h), '1 registry entry still uses folder names (gone); run `ledger store migrate --repo-ids`.');
});

for (const storage of ['file', 'sqlite'] as const) {
  test(`${storage} store: evidence under a folder name with no archive copy is left over: the hint counts it, and a conversion reports it`, { skip: storage === 'sqlite' && noSqlite }, (t) => {
    const { h, store } = appWorld(t, storage);
    if (storage === 'file') {
      const folder = store.archive.evidenceLocation('app', '2026-01-01-old');
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, 'red.txt'), 'failing\n');
    } else {
      const db = sqliteDb(h);
      db.prepare(`INSERT INTO evidence VALUES ('app', '2026-01-01-old', 'red.txt', 'file', ?)`).run(Buffer.from('failing\n'));
      db.close();
    }
    assert.equal(conversionHint(store), '1 evidence folder still uses folder names (app); run `ledger store migrate --repo-ids`.');
    assert.match(lineWith(failedWith(convert(h)), '2026-01-01-old'), /^left evidence app\/2026-01-01-old/);
  });
}

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

test('a ledger that names no main and that no record places stays, and its folder name gets no alias', (t) => {
  const h = home(t);
  const renamed = repository(h, path.join(h, 'repos/app-renamed'));
  const store = fileStore(ledgerPaths(h));
  store.backlog.write('app', 'x', ledgerText({ slug: 'x', main: renamed }));
  store.archive.write('app', '2026-01-01-bare', ledgerText({ slug: 'bare' }));
  const out = failedWith(convert(h));
  assert.match(lineWith(out, 'backlog app/x'), /^moved/);
  assert.match(lineWith(out, '2026-01-01-bare'), /^left/);
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
  for (const [place, name] of [['backlog', 'foo'], ['archive', '2026-01-01-foo']] as const) {
    test(`${storage} store: a ${place} ledger whose own main is gone stays, and its folder name gets no alias, in the dry run as in the run`, { skip: storage === 'sqlite' && noSqlite }, (t) => {
      const { h, app, key, store } = appWorld(t, storage);
      store.backlog.write('app', 'bar', ledgerText({ slug: 'bar', main: app }));
      store[place].write('app', name, ledgerText({ slug: 'foo', main: path.join(h, 'old/app') }));
      for (const out of [failedWith(convert(h, '--dry-run')), failedWith(convert(h))]) {
        assert.match(lineWith(out, `${place} app/${name}`), /^left .*is not one any more/);
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

// --- 37. Session start counts what uses folder names before it rebuilds the registry ---

test('session-start in a task counts its registry entry under a folder name, which its registry rebuild re-keys', (t) => {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  const ledgerFile = worktreeTask(h, app, { slug: 'epic' });
  const epic = path.dirname(path.dirname(ledgerFile));
  writeRegistry(fileStore(ledgerPaths(h)), [{ repo: 'app', slug: 'epic', path: ledgerFile, branch: 'me/epic', status: 'active', main: app, created, updated: created }]);
  const ran = spawnSync(LEDGER_BIN, ['hook', 'session-start'], { cwd: epic, env: commandEnv(h), input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: epic }), encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /1 registry entry still uses folder names \(app\)/);
});

// --- 38. A registry entry is re-keyed only onto its own ledger ---

test('a stale registry entry is not re-keyed onto a ledger of its name that has an entry of its own, and no alias is made', (t) => {
  const { h, app, key, store } = appWorld(t);
  store.backlog.write(key, 'x', ledgerText({ slug: 'x', main: app, goal: 'Unrelated.' }));
  const own = { ...backlogEntry(store, key, 'x', app), created: '2026-02-01T00:00:00.000Z' };
  writeRegistry(store, [backlogEntry(store, 'app', 'x', app), own]);
  const out = failedWith(convert(h));
  assert.match(lineWith(out, 'registry entry app/x'), /^left /);
  assert.deepEqual([...store.aliases.read()], []);
  assert.deepEqual(
    registryEntries(store).map(({ repo, path: at, created: since }) => [repo, at, since]),
    [
      ['app', store.backlog.location('app', 'x'), created],
      [key, own.path, own.created],
    ],
  );
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
  for (const out of [planned, done]) assert.match(lineWith(out, 'evidence b/2026-01-01-old'), /^left evidence b\/2026-01-01-old: no archive copy has its name/);
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

test('sqlite store: a rerun resumes the registry entry of a ledger named fix.md that an earlier run moved', { skip: noSqlite }, (t) => {
  const { h, app, key, store } = appWorld(t, 'sqlite');
  store.backlog.write(key, 'fix.md', ledgerText({ slug: 'fix.md', main: app }));
  writeRegistry(store, [backlogEntry(store, 'app', 'fix.md', app)]);
  ok(convert(h));
  assert.deepEqual(
    registryEntries(store).map(({ repo, path: at }) => [repo, at]),
    [[key, store.backlog.location(key, 'fix.md')]],
  );
});

test('sqlite store: the registry entry of a ledger named fix.md that stays under its folder name is not reported as gone', { skip: noSqlite }, (t) => {
  const { h, app, key, store } = appWorld(t, 'sqlite');
  store.backlog.write('app', 'fix.md', ledgerText({ slug: 'fix.md', main: app }));
  store.backlog.write(key, 'fix.md', ledgerText({ slug: 'fix.md', main: app, goal: 'Already here.' }));
  writeRegistry(store, [backlogEntry(store, 'app', 'fix.md', app)]);
  const out = failedWith(convert(h));
  assert.match(lineWith(out, 'backlog app/fix.md'), /already has fix\.md/);
  assert.equal(out.includes('registry entry app/fix.md'), false, out);
  assert.equal(registryEntries(store)[0].repo, 'app');
});

// --- 51. A registry entry resumes or re-keys only onto what is surely its own ---

test('a stale registry entry is not resumed onto a ledger of its name under the alias key that names no main', (t) => {
  const { h, app, key, store } = appWorld(t);
  store.aliases.add('app', key);
  store.backlog.write(key, 'x', ledgerText({ slug: 'x', goal: 'Unrelated.' }));
  writeRegistry(store, [backlogEntry(store, 'app', 'x', app)]);
  const out = failedWith(convert(h));
  assert.match(lineWith(out, 'registry entry app/x'), /^left /);
  assert.equal(registryEntries(store)[0].repo, 'app');
});

test('an active entry whose path is in a checkout of another folder name is reported and keeps its key', (t) => {
  const { h, app, store } = appWorld(t);
  const live = legacyWorktreeLedger(h, app, 'live');
  writeRegistry(store, [{ ...backlogEntry(store, 'lib', 'live', app), status: 'active', path: live }]);
  assert.match(lineWith(failedWith(convert(h)), 'registry entry lib/live'), /^left /);
  assert.equal(registryEntries(store)[0].repo, 'lib');
});

test('an active entry whose main is a checkout of another repo than the one that holds its ledger is reported and keeps its key', (t) => {
  const { h, app, store } = appWorld(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const live = legacyWorktreeLedger(h, app, 'live');
  writeRegistry(store, [{ ...backlogEntry(store, 'app', 'live', lib), status: 'active', path: live }]);
  assert.match(lineWith(failedWith(convert(h)), 'registry entry app/live'), new RegExp(`^left .*${app}.*${lib}`));
  assert.equal(registryEntries(store)[0].repo, 'app');
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

// --- 57. An active entry with no main takes the main checkout git names ---

test('an active entry with no main, of a linked worktree outside .claude/worktrees, gets the key of the checkout it belongs to', (t) => {
  const { h, app, key, store } = appWorld(t);
  const folder = path.join(h, 'elsewhere/live');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'me/live', folder, 'main');
  const file = path.join(folder, '.claude/ledger.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, ledgerText({ slug: 'live' }));
  writeRegistry(store, [{ repo: 'app', slug: 'live', path: file, branch: 'me/live', status: 'active', created, updated: created }]);
  ok(convert(h));
  assert.equal(registryEntries(store)[0].repo, key);
});
