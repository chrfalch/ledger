import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileStore } from '../tools/ledger/file-store.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { parseRecord, renderRecord } from '../tools/ledger/record.js';
import { sqliteFile, sqliteStore } from '../tools/ledger/sqlite-store.js';
import type { LedgerStore } from '../tools/ledger/store.js';
import { REPO } from './helpers.js';
import { home, ledger, ledgerText, lineWith, noSqlite, ok } from './ledger-core-fixtures.js';

type Storage = 'file' | 'sqlite';

const KEY = 'github.com/me/app';
const STRAY = readFileSync(path.join(REPO, 'tests/fixtures/ledgers/stray.md'), 'utf8');
const ARCHIVED = ledgerText({ slug: 'done', main: '/repos/app' });
const ARCHIVED_AT = Date.parse('2026-11-01T12:00:00Z');
const rendered = (markdown: string): string => renderRecord(parseRecord(markdown));
/** The lines of stray.md that go to general notes, without the section headings copied above them. */
const STRAY_NOTES = 12;
/** A decision opens a code fence that the fence of ## Odd would close once ## Odd renders among the notes after it. */
const UNSTABLE = ['# Task ledger — unstable', '', '## Odd', '```', 'fenced', '```', '', '## Decisions', '- a', '```', ''].join('\n');

const openStore = (h: string, storage: Storage): LedgerStore => (storage === 'sqlite' ? sqliteStore({ home: h }) : fileStore(ledgerPaths(h)));

/** A HOME whose store holds the backlog ledger stray and the archive copy 2026-11-01-done as Markdown, and the record kept. */
function legacyWorld(t: TestContext, storage: Storage) {
  const h = home(t);
  if (storage === 'sqlite') writeFileSync(path.join(h, '.claude/ledger-settings.json'), JSON.stringify({ storage: 'sqlite' }));
  const store = openStore(h, storage);
  store.backlog.write(KEY, 'kept', ledgerText({ slug: 'kept', main: '/repos/app' }));
  if (storage === 'sqlite') {
    const db = new (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync(sqliteFile(h));
    const insert = db.prepare('INSERT INTO ledgers VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('backlog', KEY, 'stray', Buffer.from(STRAY), Date.now(), Date.now());
    insert.run('archive', KEY, '2026-11-01-done', Buffer.from(ARCHIVED), ARCHIVED_AT, ARCHIVED_AT);
    db.close();
  } else {
    for (const [place, name, text] of [
      ['backlog', 'stray', STRAY],
      ['archive', '2026-11-01-done', ARCHIVED],
    ] as const) {
      mkdirSync(store[place].repoLocation(KEY), { recursive: true });
      writeFileSync(path.join(store[place].repoLocation(KEY), `${name}.md`), text);
    }
    store.archive.setModified?.(KEY, '2026-11-01-done', ARCHIVED_AT);
  }
  store.close?.();
  return { h, store: (): LedgerStore => openStore(h, storage) };
}

/** What a reader of the store sees: each ledger's place, name, text and modified time, and which are still Markdown. */
function seen(store: LedgerStore) {
  const ledgers = (['backlog', 'archive'] as const).flatMap((place) => store[place].list(KEY).map(({ name, text, mtimeMs }) => ({ place, name, text, mtimeMs })));
  const markdown = (['backlog', 'archive'] as const).flatMap((place) => (store[place].markdownNames?.(KEY) ?? []).map((name) => `${place} ${name}`));
  store.close?.();
  return { ledgers, markdown };
}

const migrate = (h: string, ...args: string[]) => ledger(h, h, 'store', 'migrate', '--records', ...args);

/** Puts a Markdown ledger from before records under the backlog name `name`, beside any record of that name. */
function plantMarkdown(h: string, storage: Storage, name: string, text: string): void {
  if (storage === 'sqlite') {
    const db = new (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync(sqliteFile(h));
    db.prepare('INSERT INTO ledgers VALUES (?, ?, ?, ?, ?, ?)').run('backlog', KEY, name, Buffer.from(text), Date.now(), Date.now());
    db.close();
  } else writeFileSync(path.join(fileStore(ledgerPaths(h)).backlog.repoLocation(KEY), `${name}.md`), text);
}

for (const storage of ['file', 'sqlite'] as const) {
  const skip = storage === 'sqlite' ? noSqlite : false;

  test(`${storage} store: migrate --records --dry-run names each Markdown ledger, its place and its lines that go to general notes, and changes nothing`, { skip }, (t) => {
    const { h, store } = legacyWorld(t, storage);
    const before = seen(store());
    const out = ok(migrate(h, '--dry-run'));
    assert.match(lineWith(out, 'stray'), new RegExp(`^would convert backlog me/app stray: ${STRAY_NOTES} lines to general notes$`));
    assert.match(lineWith(out, '2026-11-01-done'), /^would convert archive me\/app 2026-11-01-done: 0 lines to general notes$/);
    assert.doesNotMatch(out, /kept/);
    assert.match(out, /Would convert 2 ledgers\.$/m);
    assert.deepEqual(seen(store()), before);
    assert.deepEqual(before.markdown, ['backlog stray', 'archive 2026-11-01-done']);
  });

  test(`${storage} store: migrate --records rewrites each Markdown ledger as a record, with the same text and modified time, and a second run converts nothing`, { skip }, (t) => {
    const { h, store } = legacyWorld(t, storage);
    const before = seen(store());
    const out = ok(migrate(h));
    assert.match(lineWith(out, 'stray'), new RegExp(`^converted backlog me/app stray: ${STRAY_NOTES} lines to general notes$`));
    assert.match(lineWith(out, '2026-11-01-done'), /^converted archive me\/app 2026-11-01-done: 0 lines to general notes$/);
    assert.match(out, /Converted 2 ledgers\.$/m);
    const after = seen(store());
    assert.deepEqual(after.markdown, []);
    assert.deepEqual(after.ledgers, before.ledgers);
    assert.equal(after.ledgers.find(({ name }) => name === '2026-11-01-done')?.mtimeMs, ARCHIVED_AT);
    assert.equal(after.ledgers.find(({ name }) => name === 'stray')?.text, rendered(STRAY));

    const again = ok(migrate(h));
    assert.doesNotMatch(again, /converted (backlog|archive)/);
    assert.match(again, /Converted 0 ledgers\.$/m);
    assert.deepEqual(seen(store()), after);
  });

  test(`${storage} store: migrate --records names a task kept both as a record and as Markdown as a conflict, exits 1, also in a dry run, and keeps both`, { skip }, (t) => {
    const { h, store } = legacyWorld(t, storage);
    plantMarkdown(h, storage, 'kept', STRAY);
    for (const args of [['--dry-run'], []]) {
      const ran = migrate(h, ...args);
      assert.equal(ran.status, 1, `${args.join(' ')}\n${ran.stdout}\n${ran.stderr}`);
      assert.match(lineWith(ran.stdout, 'kept'), /^left backlog me\/app kept: .*both a record and Markdown/);
      assert.deepEqual(store().backlog.hiddenMarkdown?.(KEY), ['kept']);
    }
    assert.deepEqual(seen(store()).markdown, []);
    assert.equal(store().backlog.read(KEY, 'kept')?.text, ledgerText({ slug: 'kept', main: '/repos/app' }));
  });

  test(`${storage} store: migrate --records --dry-run fails as the conversion does on a ledger whose record would not read back the same, and changes nothing`, { skip }, (t) => {
    const { h, store } = legacyWorld(t, storage);
    plantMarkdown(h, storage, 'unstable', UNSTABLE);
    const opened = store();
    const where = opened.backlog.location(KEY, 'unstable');
    opened.close?.();
    const before = seen(store());

    const dry = migrate(h, '--dry-run');
    assert.equal(dry.status, 1, `${dry.stdout}\n${dry.stderr}`);
    assert.ok(dry.stderr.includes(where) && /would not read back the same/.test(dry.stderr), dry.stderr);
    assert.deepEqual(seen(store()), before);

    const real = migrate(h);
    assert.equal(real.status, 1, `${real.stdout}\n${real.stderr}`);
    assert.equal(real.stderr, dry.stderr);
  });

  test(`${storage} store: ledger show prints a Markdown backlog ledger as its record renders it`, { skip }, (t) => {
    const { h } = legacyWorld(t, storage);
    assert.equal(ok(ledger(h, h, 'show', 'stray', '--repo', KEY)), rendered(STRAY));
  });
}

test('sqlite store: migrate --records --dry-run on a database from before records adds no table', { skip: noSqlite }, (t) => {
  const h = home(t);
  writeFileSync(path.join(h, '.claude/ledger-settings.json'), JSON.stringify({ storage: 'sqlite' }));
  const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const old = new sqlite.DatabaseSync(sqliteFile(h));
  old.exec(`CREATE TABLE ledgers (place TEXT NOT NULL, repo TEXT NOT NULL, name TEXT NOT NULL, text BLOB NOT NULL, created_ms REAL NOT NULL, modified_ms REAL NOT NULL, PRIMARY KEY (place, repo, name)) STRICT`);
  old.prepare('INSERT INTO ledgers VALUES (?, ?, ?, ?, ?, ?)').run('backlog', KEY, 'stray', Buffer.from(STRAY), 1, 1);
  old.close();
  assert.match(lineWith(ok(migrate(h, '--dry-run')), 'stray'), /^would convert backlog me\/app stray/);
  const db = new sqlite.DatabaseSync(sqliteFile(h), { readOnly: true });
  t.after(() => db.close());
  assert.deepEqual(
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(({ name }) => name),
    ['ledgers'],
  );
});

test('migrate --records takes no --to, --from, --repo-ids or --remove-source', (t) => {
  const h = home(t);
  for (const other of [['--to', 'sqlite'], ['--from', 'file'], ['--repo-ids'], ['--remove-source']]) {
    const ran = migrate(h, ...other);
    assert.notEqual(ran.status, 0, other.join(' '));
    assert.match(ran.stderr, /cannot be used with/);
  }
});

test('ledger store migrate --help shows the --records example', (t) => {
  assert.match(ok(ledger(home(t), REPO, 'store', 'migrate', '--help')), /ledger store migrate --records --dry-run +\S/);
});
