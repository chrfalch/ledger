import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { storedText } from '../tools/ledger/record.js';
import { repoKey } from '../tools/ledger/repo-key.js';
import { activeFile, archivedTask, backlogTask, fakeOutside, fakeRepository, home, ledgerText, ok, runInProcessWith, storeFolder, useFakeGit, worktreeOf, writeLedgerFile } from './ledger-core-fixtures.js';
import { memoryStore } from './memory-store.js';

/** The folders of the file store under `h` that hold anything a fixture wrote. */
const fileStoreFolders = (h: string): string[] => ['ledger-backlog', 'ledger-active', 'ledger-archive'].filter((folder) => existsSync(path.join(h, '.claude', folder)));

/** A main checkout path with no repo, so its repo key is the path itself and no git runs. */
const mainOf = (t: TestContext, h: string): string => path.join(fakeOutside(useFakeGit(t), h), 'repos/app');

test('backlogTask with a store writes the ledger through it, gives its location, and writes no file', (t) => {
  const h = home(t);
  const main = mainOf(t, h);
  const store = memoryStore({ home: h });
  const location = backlogTask(h, main, { slug: 'fix-login' }, { store });
  const stored = store.backlog.read(main, 'fix-login');
  assert.equal(stored?.location, location);
  assert.equal(stored?.text, storedText(ledgerText({ slug: 'fix-login', main, branch: 'fix-login' })));
  assert.deepEqual(fileStoreFolders(h), []);
});

test('archivedTask with a store archives the copy through it, modified at noon UTC on its date, under its slug or a given name', (t) => {
  const h = home(t);
  const main = mainOf(t, h);
  const store = memoryStore({ home: h });
  const location = archivedTask(h, main, '2026-10-01', { slug: 'old' }, undefined, { store });
  archivedTask(h, main, '2026-10-02', { slug: 'old' }, 'feature-old', { store });
  const copy = store.archive.read(main, '2026-10-01-old');
  assert.equal(copy?.location, location);
  assert.equal(copy?.mtimeMs, Date.parse('2026-10-01T12:00:00Z'));
  assert.equal(copy?.text, storedText(ledgerText({ slug: 'old', worktree: worktreeOf(main, 'old'), branch: 'me/old', base: 'origin/main @ 1234567' })));
  assert.deepEqual(
    store.archive.list(main).map(({ name, mtimeMs }) => [name, new Date(mtimeMs).toISOString()]),
    [
      ['2026-10-01-old', '2026-10-01T12:00:00.000Z'],
      ['2026-10-02-feature-old', '2026-10-02T12:00:00.000Z'],
    ],
  );
  assert.deepEqual(fileStoreFolders(h), []);
});

test('activeFile with a store gives the location of the active record there, and writeLedgerFile rewrites a ledger by that location', (t) => {
  const h = home(t);
  const main = mainOf(t, h);
  const store = memoryStore({ home: h });
  const key = repoKey(main);
  store.active.write(key, 'live', ledgerText({ slug: 'live', worktree: h }));
  const file = activeFile(h, main, 'live', { store });
  assert.equal(file, store.active.location(key, 'live'));

  writeLedgerFile(file, ledgerText({ slug: 'live', worktree: h, next: 'Ship it.' }), { store });
  assert.equal(store.active.read(key, 'live')?.text, storedText(ledgerText({ slug: 'live', worktree: h, next: 'Ship it.' })));
  const backlog = backlogTask(h, main, { slug: 'later' }, { store });
  writeLedgerFile(backlog, ledgerText({ slug: 'later', goal: 'Changed.' }), { store });
  assert.match(store.backlog.read(main, 'later')?.text ?? '', /Changed\./);

  const archived = archivedTask(h, main, '2026-10-01', { slug: 'old' }, undefined, { store });
  assert.throws(() => writeLedgerFile(archived, 'any', { store }), /no backlog or active ledger/);
  assert.deepEqual(fileStoreFolders(h), []);
});

test('backlogTask and archivedTask without a store still write legacy Markdown files and give their paths', (t) => {
  const h = home(t);
  const main = mainOf(t, h);
  const backlog = backlogTask(h, main, { slug: 'fix-login' });
  assert.equal(backlog, path.join(storeFolder(h, 'ledger-backlog', main), 'fix-login.md'));
  assert.equal(readFileSync(backlog, 'utf8'), ledgerText({ slug: 'fix-login', main, branch: 'fix-login' }));
  const archived = archivedTask(h, main, '2026-10-01', { slug: 'old' });
  assert.equal(archived, path.join(storeFolder(h, 'ledger-archive', main), '2026-10-01-old.md'));
});

test('a command run in process with a store reads the tasks seeded through it', async (t) => {
  const h = home(t);
  const app = fakeRepository(useFakeGit(t), h, path.join(h, 'repos/app'));
  const store = memoryStore({ home: h });
  backlogTask(h, app, { slug: 'later', goal: 'Seeded in memory.' }, { store });
  archivedTask(h, app, '2026-10-01', { slug: 'old', goal: 'Archived in memory.' }, undefined, { store });

  assert.match(ok(await runInProcessWith(h, app, { store }, 'list')), /\b1 backlog\b/);
  assert.match(ok(await runInProcessWith(h, app, { store }, 'show', 'later')), /Seeded in memory\./);
  assert.match(ok(await runInProcessWith(h, app, { store }, 'show', 'old')), /Archived in memory\./);
  assert.deepEqual(fileStoreFolders(h), []);
});
