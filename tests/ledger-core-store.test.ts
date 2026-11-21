import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FORMAT } from '../tools/ledger/clone.js';
import { park } from '../tools/ledger/edit.js';
import { Failure } from '../tools/ledger/failure.js';
import { fileStore } from '../tools/ledger/file-store.js';
import { parseLedger } from '../tools/ledger/format.js';
import { gitStore } from '../tools/ledger/git-store.js';
import { withLock, withLockIfFree } from '../tools/ledger/lock.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { loadTasks } from '../tools/ledger/registry.js';
import { parseRecord, recordJson, renderRecord } from '../tools/ledger/record.js';
import { loadSqlite, sqliteFile, sqliteStore } from '../tools/ledger/sqlite-store.js';
import type { LedgerStore } from '../tools/ledger/store.js';
import { createTask, goTask, parkTask, type Context } from '../tools/ledger/write.js';
import { REPO } from './helpers.js';
import { archivedTask, home, ledgerText, noSqlite, repoKeyOf, repository } from './ledger-core-fixtures.js';

const text = (slug: string): string => ledgerText({ slug, main: '/repos/app' });
/** Every byte value once, so no text decoding can pass the bytes through unchanged. */
const BYTES = Buffer.from(Array.from({ length: 256 }, (_, byte) => byte));
const STRAY = readFileSync(path.join(REPO, 'tests/fixtures/ledgers/stray.md'), 'utf8');
const rendered = (markdown: string): string => renderRecord(parseRecord(markdown));
/** An empty ## Children, then a second one whose line names a task: the first is the section, so that line is a note. */
const REPEATED_CHILDREN = '# Task ledger — repeated\n\n## Goal\nShip it.\n\n## Children\n\n## Children\n- deploy\n';
/** A decision opens a code fence that the fence of ## Odd would close once ## Odd renders among the notes after it. */
const UNSTABLE = ['# Task ledger — unstable', '', '## Odd', '```', 'fenced', '```', '', '## Decisions', '- a', '```', ''].join('\n');

/** Puts a ledger as it was kept before task records: a <name>.md file, or a row of the SQLite table ledgers. */
function plantMarkdown(h: string, store: LedgerStore, place: 'backlog' | 'archive', repo: string, name: string, markdown: string): void {
  if (existsSync(sqliteFile(h))) {
    const db = new (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync(sqliteFile(h));
    db.prepare('INSERT INTO ledgers VALUES (?, ?, ?, ?, ?, ?)').run(place, repo, name, Buffer.from(markdown), Date.now(), Date.now());
    db.close();
    return;
  }
  const folder = store[place].repoLocation(repo);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, `${name}.md`), markdown);
}

/** The behaviour every store shares, whatever keeps the ledgers. `open` opens the store of a HOME; `skip` says why it cannot run here. */
function storeContract(name: string, open: (home: string) => LedgerStore, skip: string | false = false): void {
  const makeStore = (t: TestContext): LedgerStore => open(home(t));

  /** A folder under `h` with a file, a binary file, a file and an empty folder in subfolders, and a relative link. */
  const evidenceFolder = (h: string): string => {
    const from = path.join(h, 'evidence');
    mkdirSync(path.join(from, 'logs/old'), { recursive: true });
    mkdirSync(path.join(from, 'empty'));
    writeFileSync(path.join(from, 'red.txt'), 'failing\n');
    writeFileSync(path.join(from, 'logs/build.log'), 'built\n');
    writeFileSync(path.join(from, 'logs/old/trace.bin'), BYTES);
    symlinkSync('red.txt', path.join(from, 'latest'));
    return from;
  };

  test(`${name}: a store opened again on the same HOME reads what the first one wrote`, { skip }, (t) => {
    const h = home(t);
    const first = open(h);
    first.backlog.write('app', 'fix-login', text('fix-login'));
    first.archive.write('app', '2026-11-01-old', text('old'), evidenceFolder(h));
    first.registry.write('[]\n');
    const second = open(h);
    assert.equal(second.backlog.read('app', 'fix-login')?.text, text('fix-login'));
    assert.equal(second.archive.read('app', '2026-11-01-old')?.text, text('old'));
    assert.deepEqual(second.archive.evidenceFiles('app', '2026-11-01-old'), ['logs/build.log', 'logs/old/trace.bin', 'red.txt']);
    assert.equal(second.registry.read(), '[]\n');
  });

  test(`${name}: archived evidence reads back: its files as sorted relative paths, without folders and links, and each file's bytes exactly`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    store.archive.write('app', '2026-11-01-fix-login', text('fix-login'), evidenceFolder(h));
    assert.deepEqual(store.archive.evidenceFiles('app', '2026-11-01-fix-login'), ['logs/build.log', 'logs/old/trace.bin', 'red.txt']);
    assert.deepEqual(store.archive.readEvidence('app', '2026-11-01-fix-login', 'red.txt'), Buffer.from('failing\n'));
    assert.deepEqual(store.archive.readEvidence('app', '2026-11-01-fix-login', 'logs/old/trace.bin'), BYTES);
  });

  test(`${name}: a symbolic link to a folder in the evidence is not followed: the files behind it are not evidence files`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    const from = evidenceFolder(h);
    symlinkSync('logs', path.join(from, 'logs-link'));
    store.archive.write('app', '2026-11-01-fix-login', text('fix-login'), from);
    assert.deepEqual(store.archive.evidenceFiles('app', '2026-11-01-fix-login'), ['logs/build.log', 'logs/old/trace.bin', 'red.txt']);
    assert.equal(store.archive.readEvidence('app', '2026-11-01-fix-login', 'logs-link/build.log'), undefined);
    assert.equal(store.archive.evidenceState('app', '2026-11-01-fix-login', from), 'same');
  });

  test(`${name}: evidence files with mixed-case and Unicode names are listed in UTF-16 code-unit order, not by UTF-8 bytes or locale`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    const from = path.join(h, 'evidence');
    mkdirSync(from);
    // By UTF-8 bytes ～ (EF BD 9E) comes before 😀 (F0 9F 98 80); by code unit 😀 (D83D DE00) comes before ～ (FF5E).
    for (const file of ['～.txt', 'apple.txt', '😀.txt', 'é.txt', 'Zebra.txt']) writeFileSync(path.join(from, file), file);
    store.archive.write('app', '2026-11-01-fix-login', text('fix-login'), from);
    assert.deepEqual(store.archive.evidenceFiles('app', '2026-11-01-fix-login'), ['Zebra.txt', 'apple.txt', 'é.txt', '😀.txt', '～.txt']);
  });

  test(`${name}: ledger text with a NUL byte reads back with the NUL bytes, in the backlog and the archive`, { skip }, (t) => {
    const store = makeStore(t);
    const withNul = 'before\0after\n\0';
    store.backlog.write('app', 'fix-login', withNul);
    store.archive.write('app', '2026-11-01-fix-login', withNul);
    assert.match(rendered(withNul), /^before\0after\n\0\n/m);
    assert.equal(store.backlog.read('app', 'fix-login')?.text, rendered(withNul));
    assert.equal(store.backlog.list('app')[0]?.text, rendered(withNul));
    assert.equal(store.archive.read('app', '2026-11-01-fix-login')?.text, rendered(withNul));
  });

  test(`${name}: no evidence reads back as none, and readEvidence gives nothing for a path that is not an evidence file`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    store.archive.write('app', '2026-11-01-plain', text('plain'));
    store.archive.write('app', '2026-11-01-fix-login', text('fix-login'), evidenceFolder(h));
    assert.deepEqual(store.archive.evidenceFiles('app', '2026-11-01-plain'), []);
    assert.deepEqual(store.archive.evidenceFiles('app', '2026-11-01-unknown'), []);
    assert.deepEqual(store.archive.evidenceFiles('lib', '2026-11-01-fix-login'), []);
    const outside = ['missing.txt', 'logs', 'empty', 'latest', '../2026-11-01-fix-login.md', '../2026-11-01-plain.md', '/etc/hosts'];
    for (const file of outside) assert.equal(store.archive.readEvidence('app', '2026-11-01-fix-login', file), undefined, file);
    assert.equal(store.archive.readEvidence('app', '2026-11-01-plain', 'red.txt'), undefined);
  });

  test(`${name}: evidenceState compares archived evidence with a folder: files by content, links by their text, folders, and types`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    const name = '2026-11-01-fix-login';
    const emptyFolder = path.join(h, 'nothing');
    mkdirSync(emptyFolder);
    assert.equal(store.archive.evidenceState('app', name), 'none');
    assert.equal(store.archive.evidenceState('app', name, path.join(h, 'missing')), 'none');
    assert.equal(store.archive.evidenceState('app', name, emptyFolder), 'none');
    const from = evidenceFolder(h);
    assert.equal(store.archive.evidenceState('app', name, from), 'differs', 'evidence on one side only');
    store.archive.write('app', name, 'archive', from);
    assert.equal(store.archive.evidenceState('app', name, from), 'same');
    assert.equal(store.archive.evidenceState('app', name), 'differs', 'evidence in the archive only');
    assert.equal(store.archive.evidenceState('app', name, emptyFolder), 'differs', 'an empty folder against archived evidence');

    const at = (file: string): string => path.join(from, file);
    const changes: [string, () => void, () => void][] = [
      ['content', () => writeFileSync(at('logs/build.log'), 'other\n'), () => writeFileSync(at('logs/build.log'), 'built\n')],
      ['binary content', () => writeFileSync(at('logs/old/trace.bin'), BYTES.subarray(1)), () => writeFileSync(at('logs/old/trace.bin'), BYTES)],
      ['an extra file', () => writeFileSync(at('extra.txt'), 'x'), () => rmSync(at('extra.txt'))],
      ['a missing file', () => rmSync(at('red.txt')), () => writeFileSync(at('red.txt'), 'failing\n')],
      ['an extra empty folder', () => mkdirSync(at('more')), () => rmSync(at('more'), { recursive: true })],
      ['a missing empty folder', () => rmSync(at('empty'), { recursive: true }), () => mkdirSync(at('empty'))],
      ['link text', () => (rmSync(at('latest')), symlinkSync('logs/build.log', at('latest'))), () => (rmSync(at('latest')), symlinkSync('red.txt', at('latest')))],
      ['a file in place of a link', () => (rmSync(at('latest')), writeFileSync(at('latest'), 'failing\n')), () => (rmSync(at('latest')), symlinkSync('red.txt', at('latest')))],
      ['a file in place of an empty folder', () => (rmSync(at('empty'), { recursive: true }), writeFileSync(at('empty'), '')), () => (rmSync(at('empty')), mkdirSync(at('empty')))],
    ];
    for (const [what, change, undo] of changes) {
      change();
      assert.equal(store.archive.evidenceState('app', name, from), 'differs', what);
      undo();
      assert.equal(store.archive.evidenceState('app', name, from), 'same', `${what} undone`);
    }
  });

  test(`${name}: nameTaken is false for a new name and true once a copy uses it, with or without evidence`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    assert.equal(store.archive.nameTaken('app', '2026-11-01-plain'), false);
    store.archive.write('app', '2026-11-01-plain', text('plain'));
    store.archive.write('app', '2026-11-01-fix-login', text('fix-login'), evidenceFolder(h));
    assert.equal(store.archive.nameTaken('app', '2026-11-01-plain'), true);
    assert.equal(store.archive.nameTaken('app', '2026-11-01-fix-login'), true);
    assert.equal(store.archive.nameTaken('lib', '2026-11-01-plain'), false);
  });

  test(`${name}: an archive write with evidence refuses a taken name and adds no evidence to the first copy`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    store.archive.write('app', '2026-11-01-fix-login', 'first');
    assert.throws(() => store.archive.write('app', '2026-11-01-fix-login', 'second', evidenceFolder(h)), /already exists/);
    assert.equal(store.archive.read('app', '2026-11-01-fix-login')?.text, rendered('first'));
    assert.deepEqual(store.archive.evidenceFiles('app', '2026-11-01-fix-login'), []);
    assert.equal(store.archive.evidenceState('app', '2026-11-01-fix-login'), 'none');
  });

  test(`${name}: a backlog ledger reads back as written, with its repo, name, times and location`, { skip }, (t) => {
    const store = makeStore(t);
    store.backlog.write('app', 'fix-login', text('fix-login'));
    const entry = store.backlog.read('app', 'fix-login');
    assert.ok(entry);
    assert.equal(entry.repo, 'app');
    assert.equal(entry.name, 'fix-login');
    assert.equal(entry.text, text('fix-login'));
    assert.equal(entry.location, store.backlog.location('app', 'fix-login'));
    assert.ok(entry.mtimeMs > 0);
    assert.ok(entry.birthtimeMs > 0);
  });

  test(`${name}: a child's order and dependencies, by slug, address and path, read back from the backlog and the archive`, { skip }, (t) => {
    const store = makeStore(t);
    const ordered = text('b').replace('- design refs: none\n', '- design refs: none\n- parent: epic\n- order: 2\n- depends on: a, api @ github.com/acme/api, lib-x @ /repos/lib\n');
    store.backlog.write('app', 'b', ordered);
    store.archive.write('app', '2026-11-01-b', ordered);
    for (const entry of [store.backlog.read('app', 'b'), store.archive.read('app', '2026-11-01-b')]) {
      assert.ok(entry);
      assert.equal(entry.text, ordered);
      const record = parseRecord(entry.text);
      assert.equal(record.order, 2);
      assert.deepEqual(record.dependencies, [{ slug: 'a' }, { slug: 'api', repo: 'github.com/acme/api' }, { slug: 'lib-x', repo: '/repos/lib' }]);
    }
  });

  test(`${name}: a second backlog write replaces the text`, { skip }, (t) => {
    const store = makeStore(t);
    store.backlog.write('app', 'fix-login', 'old');
    store.backlog.write('app', 'fix-login', 'new');
    assert.equal(store.backlog.read('app', 'fix-login')?.text, rendered('new'));
    assert.equal(store.backlog.list('app').length, 1);
  });

  test(`${name}: backlog list holds the ledgers of one repo, by name`, { skip }, (t) => {
    const store = makeStore(t);
    for (const slug of ['zeta', 'alpha', 'mid']) store.backlog.write('app', slug, text(slug));
    store.backlog.write('lib', 'other', text('other'));
    assert.deepEqual(
      store.backlog.list('app').map(({ repo, name, text: body }) => ({ repo, name, body })),
      ['alpha', 'mid', 'zeta'].map((slug) => ({ repo: 'app', name: slug, body: text(slug) })),
    );
    assert.deepEqual(store.backlog.repos(), ['app', 'lib']);
  });

  test(`${name}: a list is in the order of the file names, so fix-login.md comes before fix.md`, { skip }, (t) => {
    const store = makeStore(t);
    store.backlog.write('app', 'fix', text('fix'));
    store.backlog.write('app', 'fix-login', text('fix-login'));
    store.archive.write('app', '2026-11-01-fix', text('fix'));
    store.archive.write('app', '2026-11-01-fix-login', text('fix-login'));
    assert.deepEqual(store.backlog.list('app').map(({ name: slug }) => slug), ['fix-login', 'fix']);
    assert.deepEqual(store.archive.list('app').map(({ name: copy }) => copy), ['2026-11-01-fix-login', '2026-11-01-fix']);
  });

  test(`${name}: repos and lists with mixed-case and Unicode names are in UTF-16 code-unit order, not by UTF-8 bytes or locale`, { skip }, (t) => {
    const store = makeStore(t);
    // By UTF-8 bytes ～ (EF BD 9E) comes before 😀 (F0 9F 98 80); by code unit 😀 (D83D DE00) comes before ～ (FF5E).
    for (const each of ['～', 'apple', '😀', 'é', 'Zebra']) {
      store.backlog.write(each, each, text(each));
      store.backlog.write('app', each, text(each));
      store.archive.write(each, each, text(each));
      store.archive.write('app', each, text(each));
    }
    const repos = ['Zebra', 'app', 'apple', 'é', '😀', '～'];
    const names = ['Zebra', 'apple', 'é', '😀', '～'];
    assert.deepEqual(store.backlog.repos(), repos);
    assert.deepEqual(store.archive.repos(), repos);
    assert.deepEqual(store.backlog.list('app').map(({ name: slug }) => slug), names);
    assert.deepEqual(store.archive.list('app').map(({ name: copy }) => copy), names);
  });

  test(`${name}: removing a backlog ledger that is not there throws`, { skip }, (t) => {
    const store = makeStore(t);
    assert.throws(() => store.backlog.remove('app', 'nothing', ''));
  });

  test(`${name}: remove keeps a backlog ledger whose text is not the text the caller read`, { skip }, (t) => {
    const store = makeStore(t);
    store.backlog.write('app', 'fix-login', text('fix-login'));
    assert.equal(store.backlog.remove('app', 'fix-login', text('an older read')), false);
    assert.equal(store.backlog.read('app', 'fix-login')?.text, text('fix-login'));
  });

  test(`${name}: an archive write refuses a name that is taken and keeps the first copy`, { skip }, (t) => {
    const store = makeStore(t);
    store.archive.write('app', '2026-11-01-fix-login', 'first');
    assert.throws(() => store.archive.write('app', '2026-11-01-fix-login', 'second'), /already exists/);
    assert.equal(store.archive.read('app', '2026-11-01-fix-login')?.text, rendered('first'));
  });

  test(`${name}: an unknown repo or name is empty, not an error`, { skip }, (t) => {
    const store = makeStore(t);
    assert.deepEqual(store.backlog.repos(), []);
    assert.deepEqual(store.backlog.list('nowhere'), []);
    assert.equal(store.backlog.read('nowhere', 'x'), undefined);
    assert.equal(store.backlog.has('nowhere', 'x'), false);
    assert.deepEqual(store.archive.repos(), []);
    assert.deepEqual(store.archive.list('nowhere'), []);
    assert.equal(store.archive.read('nowhere', '2026-11-01-x'), undefined);
    assert.equal(store.archive.has('nowhere', '2026-11-01-x'), false);
  });

  test(`${name}: has follows write and remove`, { skip }, (t) => {
    const store = makeStore(t);
    store.backlog.write('app', 'fix-login', text('fix-login'));
    store.backlog.write('app', 'keep', text('keep'));
    assert.equal(store.backlog.has('app', 'fix-login'), true);
    assert.equal(store.backlog.remove('app', 'fix-login', text('fix-login')), true);
    assert.equal(store.backlog.has('app', 'fix-login'), false);
    assert.equal(store.backlog.read('app', 'fix-login'), undefined);
    assert.deepEqual(store.backlog.list('app').map(({ name: slug }) => slug), ['keep']);
  });

  test(`${name}: the archive keeps its own ledgers, apart from the backlog`, { skip }, (t) => {
    const store = makeStore(t);
    store.archive.write('app', '2026-11-02-fix-login', text('fix-login'));
    store.archive.write('app', '2026-11-01-fix-login', text('fix-login'));
    store.archive.write('lib', '2026-10-01-old', text('old'));
    const entry = store.archive.read('app', '2026-11-02-fix-login');
    assert.ok(entry);
    assert.equal(entry.text, text('fix-login'));
    assert.equal(entry.location, store.archive.location('app', '2026-11-02-fix-login'));
    assert.ok(entry.mtimeMs > 0);
    assert.equal(store.archive.has('app', '2026-11-02-fix-login'), true);
    assert.deepEqual(store.archive.list('app').map(({ name: copy }) => copy), ['2026-11-01-fix-login', '2026-11-02-fix-login']);
    assert.deepEqual(store.archive.repos(), ['app', 'lib']);
    assert.deepEqual(store.backlog.repos(), []);
    assert.equal(store.backlog.has('app', '2026-11-02-fix-login'), false);
  });

  test(`${name}: an evidence location is the same before and after the write, and apart from every ledger and other evidence`, { skip }, (t) => {
    const store = makeStore(t);
    const before = store.archive.evidenceLocation('app', '2026-11-02-fix-login');
    store.archive.write('app', '2026-11-02-fix-login', text('fix-login'));
    assert.equal(store.archive.evidenceLocation('app', '2026-11-02-fix-login'), before);
    const others = [
      store.archive.location('app', '2026-11-02-fix-login'),
      store.archive.evidenceLocation('app', '2026-11-03-fix-login'),
      store.archive.evidenceLocation('lib', '2026-11-02-fix-login'),
      store.backlog.location('app', '2026-11-02-fix-login'),
    ];
    for (const other of others) assert.notEqual(before, other);
  });

  test(`${name}: the registry is undefined until written, then reads back as written`, { skip }, (t) => {
    const store = makeStore(t);
    assert.equal(store.registry.read(), undefined);
    store.registry.write('[]\n');
    assert.equal(store.registry.read(), '[]\n');
    store.registry.write('[{"path":"x"}]\n');
    assert.equal(store.registry.read(), '[{"path":"x"}]\n');
  });

  test(`${name}: a ledger is kept as a task record, so read gives the record rendered, also for text out of the template layout`, { skip }, (t) => {
    const store = makeStore(t);
    store.backlog.write('app', 'stray', STRAY);
    store.archive.write('app', '2026-11-01-stray', STRAY);
    assert.equal(store.backlog.read('app', 'stray')?.text, rendered(STRAY));
    assert.equal(store.archive.read('app', '2026-11-01-stray')?.text, rendered(STRAY));
    assert.deepEqual(store.backlog.markdownNames?.('app'), []);
    assert.deepEqual(store.archive.markdownNames?.('app'), []);
  });

  test(`${name}: a claim reads back as written, in the backlog and in the archive`, { skip }, (t) => {
    const store = makeStore(t);
    const claimed = text('claimed').replace('- design refs: none\n', '- design refs: none\n- claim: session s-1 since 2026-11-20T10:00:00Z, active 2026-11-20T10:20:00Z\n');
    store.backlog.write('app', 'claimed', claimed);
    store.archive.write('app', '2026-11-01-claimed', claimed);
    for (const read of [store.backlog.read('app', 'claimed'), store.archive.read('app', '2026-11-01-claimed')]) {
      assert.deepEqual(parseRecord(read?.text ?? '').claim, { session: 's-1', since: '2026-11-20T10:00:00Z', active: '2026-11-20T10:20:00Z' });
    }
  });

  test(`${name}: a ledger kept as Markdown from before records reads as its record, rendered, and lists with the records`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    store.backlog.write('app', 'b-record', text('b-record'));
    plantMarkdown(h, store, 'backlog', 'app', 'a-markdown', STRAY);
    plantMarkdown(h, store, 'archive', 'app', '2026-11-01-old', STRAY);
    assert.deepEqual(store.backlog.repos(), ['app']);
    assert.deepEqual(store.archive.repos(), ['app']);
    assert.deepEqual(
      store.backlog.list('app').map(({ name, text }) => [name, text]),
      [
        ['a-markdown', rendered(STRAY)],
        ['b-record', text('b-record')],
      ],
    );
    assert.equal(store.backlog.read('app', 'a-markdown')?.text, rendered(STRAY));
    assert.equal(store.archive.read('app', '2026-11-01-old')?.text, rendered(STRAY));
    assert.ok(store.backlog.has('app', 'a-markdown'));
    assert.ok(store.archive.nameTaken('app', '2026-11-01-old'));
    assert.deepEqual(store.backlog.markdownNames?.('app'), ['a-markdown']);
    assert.deepEqual(store.archive.markdownNames?.('app'), ['2026-11-01-old']);
  });

  test(`${name}: write and update replace a Markdown ledger with a record; create and an archive write refuse its name`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    plantMarkdown(h, store, 'backlog', 'app', 'written', STRAY);
    plantMarkdown(h, store, 'backlog', 'app', 'updated', STRAY);
    plantMarkdown(h, store, 'archive', 'app', '2026-11-01-old', STRAY);
    assert.equal(store.backlog.create('app', 'written', text('written')), false);
    assert.throws(() => store.archive.write('app', '2026-11-01-old', text('old')), /already exists/);
    store.backlog.write('app', 'written', text('written'));
    let given: string | undefined;
    assert.ok(store.backlog.update('app', 'updated', (current) => ((given = current), text('updated'))));
    assert.equal(given, rendered(STRAY));
    assert.equal(store.backlog.read('app', 'written')?.text, text('written'));
    assert.equal(store.backlog.read('app', 'updated')?.text, text('updated'));
    assert.deepEqual(store.backlog.markdownNames?.('app'), []);
    assert.deepEqual(
      store.backlog.list('app').map(({ name }) => name),
      ['updated', 'written'],
    );
  });

  test(`${name}: remove of a Markdown ledger takes its rendered text as expected, and leaves nothing of it`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    plantMarkdown(h, store, 'backlog', 'app', 'gone', STRAY);
    plantMarkdown(h, store, 'archive', 'app', '2026-11-01-gone', STRAY);
    assert.equal(store.backlog.remove('app', 'gone', 'other text'), false);
    assert.ok(store.backlog.remove('app', 'gone', rendered(STRAY)));
    assert.ok(store.archive.remove('app', '2026-11-01-gone', { text: rendered(STRAY), evidence: path.join(h, 'no-evidence') }));
    assert.equal(store.backlog.has('app', 'gone'), false);
    assert.equal(store.archive.has('app', '2026-11-01-gone'), false);
    assert.deepEqual(store.backlog.list('app'), []);
    assert.deepEqual(store.archive.list('app'), []);
  });

  test(`${name}: toRecord rewrites a Markdown ledger as a record, its text and modified time as they were, and is false for a record`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    plantMarkdown(h, store, 'archive', 'app', '2026-11-01-old', STRAY);
    store.archive.setModified?.('app', '2026-11-01-old', Date.parse('2026-11-01T12:00:00Z'));
    const before = store.archive.read('app', '2026-11-01-old');
    assert.equal(store.archive.toRecord?.('app', '2026-11-01-old'), true);
    assert.equal(store.archive.toRecord?.('app', '2026-11-01-old'), false);
    assert.deepEqual(store.archive.markdownNames?.('app'), []);
    const after = store.archive.read('app', '2026-11-01-old');
    assert.equal(after?.text, before?.text);
    assert.equal(after?.mtimeMs, Date.parse('2026-11-01T12:00:00Z'));
  });

  test(`${name}: a record wins over a Markdown ledger of the same name`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    store.backlog.write('app', 'both', text('both'));
    plantMarkdown(h, store, 'backlog', 'app', 'both', STRAY);
    assert.equal(store.backlog.read('app', 'both')?.text, text('both'));
    assert.deepEqual(
      store.backlog.list('app').map(({ text: listed }) => listed),
      [text('both')],
    );
    assert.deepEqual(store.backlog.markdownNames?.('app'), []);
  });

  test(`${name}: a write over a record that hides a Markdown ledger of the same name keeps the Markdown, and hiddenMarkdown names it`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    store.backlog.write('app', 'both', text('both'));
    store.archive.write('app', '2026-11-01-both', text('both'));
    plantMarkdown(h, store, 'backlog', 'app', 'both', STRAY);
    plantMarkdown(h, store, 'archive', 'app', '2026-11-01-both', STRAY);
    store.backlog.write('app', 'both', text('again'));
    assert.ok(store.backlog.update('app', 'both', () => text('once-more')));
    assert.deepEqual(store.backlog.hiddenMarkdown?.('app'), ['both']);
    assert.deepEqual(store.archive.hiddenMarkdown?.('app'), ['2026-11-01-both']);
    assert.equal(store.backlog.read('app', 'both')?.text, text('once-more'));
  });

  test(`${name}: remove refuses a task whose record hides Markdown, names the conflict and ledger store migrate --records, and changes nothing`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    const from = evidenceFolder(h);
    store.backlog.write('app', 'both', text('both'));
    store.archive.write('app', '2026-11-01-both', text('both'), from);
    plantMarkdown(h, store, 'backlog', 'app', 'both', STRAY);
    plantMarkdown(h, store, 'archive', 'app', '2026-11-01-both', STRAY);
    const keptBothWays = (location: string) => (error: unknown) =>
      error instanceof Failure && error.message.includes(location) && error.message.includes('Markdown from before records') && error.message.includes('ledger store migrate --records');

    assert.throws(() => store.backlog.remove('app', 'both', text('both')), keptBothWays(store.backlog.location('app', 'both')));
    for (const expected of [undefined, { text: text('both'), evidence: from }]) {
      assert.throws(() => store.archive.remove('app', '2026-11-01-both', expected), keptBothWays(store.archive.location('app', '2026-11-01-both')));
    }
    assert.equal(store.backlog.read('app', 'both')?.text, text('both'));
    assert.equal(store.archive.read('app', '2026-11-01-both')?.text, text('both'));
    assert.equal(store.archive.evidenceState('app', '2026-11-01-both', from), 'same');
    assert.deepEqual(store.backlog.hiddenMarkdown?.('app'), ['both']);
    assert.deepEqual(store.archive.hiddenMarkdown?.('app'), ['2026-11-01-both']);
  });

  test(`${name}: a move takes the Markdown a record hides along, so neither repo shows it`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    store.backlog.write('app', 'both', text('both'));
    store.archive.write('app', '2026-11-01-both', text('both'));
    plantMarkdown(h, store, 'backlog', 'app', 'both', STRAY);
    plantMarkdown(h, store, 'archive', 'app', '2026-11-01-both', STRAY);
    assert.ok(store.backlog.move('app', 'both', 'lib'));
    assert.ok(store.archive.move('app', '2026-11-01-both', 'lib'));
    assert.deepEqual([store.backlog.list('app'), store.archive.list('app')], [[], []]);
    assert.equal(store.backlog.read('lib', 'both')?.text, text('both'));
    assert.equal(store.archive.read('lib', '2026-11-01-both')?.text, text('both'));
    assert.deepEqual(store.backlog.hiddenMarkdown?.('lib'), ['both']);
    assert.deepEqual(store.archive.hiddenMarkdown?.('lib'), ['2026-11-01-both']);
  });

  test(`${name}: a Markdown ledger moves to another repo and still reads there`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    plantMarkdown(h, store, 'backlog', 'app', 'moving', STRAY);
    plantMarkdown(h, store, 'archive', 'app', '2026-11-01-moving', STRAY);
    assert.ok(store.backlog.move('app', 'moving', 'lib'));
    assert.ok(store.archive.move('app', '2026-11-01-moving', 'lib'));
    assert.equal(store.backlog.read('lib', 'moving')?.text, rendered(STRAY));
    assert.equal(store.archive.read('lib', '2026-11-01-moving')?.text, rendered(STRAY));
    assert.equal(store.backlog.has('app', 'moving'), false);
  });

  test(`${name}: a ledger with a repeated section is the same record converted or written, its repeat a note, and it stays listed`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    plantMarkdown(h, store, 'backlog', 'app', 'converted', REPEATED_CHILDREN);
    assert.equal(store.backlog.toRecord?.('app', 'converted'), true);
    store.backlog.write('app', 'written', REPEATED_CHILDREN);
    for (const slug of ['converted', 'written']) {
      const stored = store.backlog.read('app', slug)?.text ?? '';
      assert.equal(stored, rendered(REPEATED_CHILDREN), slug);
      assert.deepEqual(parseLedger(stored).children, [], slug);
    }
    assert.deepEqual(
      store.backlog.list('app').map(({ name }) => name),
      ['converted', 'written'],
    );
    assert.deepEqual(store.backlog.markdownNames?.('app'), []);
  });

  test(`${name}: a write whose record would not read back the same fails, names the ledger, and changes nothing`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    store.backlog.write('app', 'kept', text('kept'));
    plantMarkdown(h, store, 'backlog', 'app', 'legacy', UNSTABLE);
    const before = store.backlog.list('app').map(({ name, text: stored }) => [name, stored]);
    const refused = (where: string) => (error: unknown) => error instanceof Failure && error.message.includes(where) && /would not read back the same/.test(error.message);

    assert.throws(() => store.backlog.write('app', 'kept', UNSTABLE), refused(store.backlog.location('app', 'kept')));
    assert.throws(() => store.backlog.update('app', 'kept', () => UNSTABLE), refused(store.backlog.location('app', 'kept')));
    assert.throws(() => store.backlog.toRecord?.('app', 'legacy'), refused(store.backlog.location('app', 'legacy')));
    assert.throws(() => store.backlog.write('app', 'legacy', UNSTABLE), refused(store.backlog.location('app', 'legacy')));
    assert.throws(() => store.backlog.create('app', 'new', UNSTABLE), refused(store.backlog.location('app', 'new')));
    assert.throws(() => store.archive.write('app', '2026-11-01-new', UNSTABLE, evidenceFolder(h)), refused(store.archive.location('app', '2026-11-01-new')));

    assert.deepEqual(
      store.backlog.list('app').map(({ name, text: stored }) => [name, stored]),
      before,
    );
    assert.deepEqual(store.backlog.markdownNames?.('app'), ['legacy']);
    assert.equal(store.archive.nameTaken('app', '2026-11-01-new'), false);
    assert.deepEqual(store.archive.orphanEvidence(), []);
  });

  test(`${name}: toRecord keeps the birth time of the Markdown it converts as the created time, also through a later write`, { skip }, async (t) => {
    const h = home(t);
    const store = open(h);
    plantMarkdown(h, store, 'backlog', 'app', 'old', STRAY);
    plantMarkdown(h, store, 'archive', 'app', '2026-11-01-old', STRAY);
    const created = (place: 'backlog' | 'archive', name: string): string | undefined => {
      const birth = store[place].read('app', name)?.birthtimeMs;
      return birth === undefined ? undefined : new Date(birth).toISOString();
    };
    const born = [created('backlog', 'old'), created('archive', '2026-11-01-old')];
    // A file made now has a later birth time, which only the record can correct.
    await delay(20);

    assert.ok(store.backlog.toRecord?.('app', 'old'));
    assert.ok(store.archive.toRecord?.('app', '2026-11-01-old'));
    assert.deepEqual([created('backlog', 'old'), created('archive', '2026-11-01-old')], born);
    store.backlog.write('app', 'old', text('old'));
    assert.ok(store.backlog.update('app', 'old', () => text('updated')));
    assert.equal(created('backlog', 'old'), born[0]);
    assert.equal(store.backlog.read('app', 'old')?.text, text('updated'));
  });

  test(`${name}: a write or an update over a Markdown ledger, such as a park, keeps the Markdown's birth time as the created time, as toRecord does`, { skip }, async (t) => {
    const h = home(t);
    const store = open(h);
    for (const slug of ['written', 'parked']) plantMarkdown(h, store, 'backlog', 'app', slug, STRAY);
    const created = (slug: string): string | undefined => {
      const birth = store.backlog.read('app', slug)?.birthtimeMs;
      return birth === undefined ? undefined : new Date(birth).toISOString();
    };
    const born = [created('written'), created('parked')];
    // A file made now has a later birth time, which only the record can correct.
    await delay(20);

    store.backlog.write('app', 'written', text('written'));
    assert.ok(store.backlog.update('app', 'parked', (current) => park(current, 'Parked: 2026-11-22 — on hold')));
    assert.deepEqual([created('written'), created('parked')], born);
    assert.deepEqual(store.backlog.markdownNames?.('app'), []);
  });
}

function fileHome(t: TestContext) {
  const h = home(t);
  const paths = ledgerPaths(h);
  return { h, paths, store: fileStore(paths) };
}

const openGitStore = (h: string): LedgerStore => {
  const clone = path.join(h, '.claude/ledger-data');
  spawnSync('git', ['init', '--quiet', clone]);
  writeFileSync(path.join(clone, '.ledger-data'), `${JSON.stringify({ format: FORMAT })}\n`);
  return gitStore(ledgerPaths(h), { backgroundSync: false });
};

storeContract('file store', (h) => fileStore(ledgerPaths(h)));
storeContract('sqlite store', (h) => sqliteStore({ home: h }), noSqlite);
storeContract('git store', openGitStore);

for (const [name, open] of [['file store', (h: string) => fileStore(ledgerPaths(h))], ['git store', openGitStore]] as const) {
  for (const linked of ['repo folder', 'evidence folder'] as const) {
    test(`${name}: copyEvidence and remove refuse evidence whose ${linked} is a symbolic link, and change nothing behind it`, (t) => {
      const h = home(t);
      const store = open(h);
      store.archive.write('app', '2026-11-01-old', text('old'));
      const evidence = store.archive.evidenceLocation('app', '2026-11-01-old');
      const outside = path.join(h, 'outside');
      const repoFolder = path.dirname(evidence);
      if (linked === 'repo folder') {
        // The file store keeps the copy in that folder too, so it moves along and the copy stays readable.
        if (existsSync(repoFolder)) renameSync(repoFolder, outside);
        mkdirSync(path.join(outside, '2026-11-01-old'), { recursive: true });
        mkdirSync(path.dirname(repoFolder), { recursive: true });
        symlinkSync(outside, repoFolder);
      } else {
        mkdirSync(path.join(outside, '2026-11-01-old'), { recursive: true });
        mkdirSync(repoFolder, { recursive: true });
        symlinkSync(path.join(outside, '2026-11-01-old'), evidence);
      }
      const kept = path.join(outside, '2026-11-01-old/red.txt');
      writeFileSync(kept, 'not evidence\n');
      const to = path.join(h, 'copy');

      assert.throws(() => store.archive.copyEvidence('app', '2026-11-01-old', to), /symbolic link/);
      assert.equal(existsSync(to), false);
      assert.throws(() => store.archive.remove('app', '2026-11-01-old'), /symbolic link/);
      assert.equal(readFileSync(kept, 'utf8'), 'not evidence\n');
      assert.ok(store.archive.has('app', '2026-11-01-old'), 'the copy was removed');
    });
  }
}

for (const [name, open] of [['file store', (h: string) => fileStore(ledgerPaths(h))], ['git store', openGitStore]] as const) {
  test(`${name}: an archive write refuses evidence whose repo folder is a symbolic link, and writes nothing`, (t) => {
    const h = home(t);
    const store = open(h);
    const evidence = store.archive.evidenceLocation('app', '2026-11-01-old');
    const outside = path.join(h, 'outside');
    mkdirSync(outside);
    mkdirSync(path.dirname(path.dirname(evidence)), { recursive: true });
    symlinkSync(outside, path.dirname(evidence));
    const from = path.join(h, 'from');
    mkdirSync(from);
    writeFileSync(path.join(from, 'red.txt'), 'failing\n');

    assert.throws(() => store.archive.write('app', '2026-11-01-old', text('old'), from), /symbolic link/);

    assert.deepEqual(readdirSync(outside), []);
    assert.equal(store.archive.has('app', '2026-11-01-old'), false);
  });

  for (const place of ['backlog', 'archive'] as const) {
    test(`${name}: a new ${place} ledger, without evidence, is refused when the ${place} root is a symbolic link, and nothing is written behind it`, (t) => {
      const h = home(t);
      const store = open(h);
      const root = store[place].repoLocation();
      const outside = path.join(h, 'outside');
      mkdirSync(outside);
      rmSync(root, { recursive: true, force: true });
      mkdirSync(path.dirname(root), { recursive: true });
      symlinkSync(outside, root);
      const create = place === 'backlog' ? () => store.backlog.create('app', 'new', text('new')) : () => store.archive.write('app', '2026-11-02-new', text('new'));

      assert.throws(create, /symbolic link/);

      assert.deepEqual(readdirSync(outside), []);
    });
  }

  test(`${name}: an archive write, copyEvidence and remove refuse an evidence root that is a symbolic link, and change nothing behind it`, (t) => {
    const h = home(t);
    const store = open(h);
    const from = path.join(h, 'from');
    mkdirSync(from);
    writeFileSync(path.join(from, 'red.txt'), 'failing\n');
    store.archive.write('app', '2026-11-01-old', text('old'), from);
    const root = path.dirname(path.dirname(store.archive.evidenceLocation('app', '2026-11-01-old')));
    const outside = path.join(h, 'outside');
    renameSync(root, outside);
    symlinkSync(outside, root);
    const to = path.join(h, 'copy');

    assert.throws(() => store.archive.write('app', '2026-11-02-new', text('new'), from), /symbolic link/);
    assert.throws(() => store.archive.copyEvidence('app', '2026-11-01-old', to), /symbolic link/);
    assert.throws(() => store.archive.remove('app', '2026-11-01-old'), /symbolic link/);

    assert.equal(existsSync(to), false);
    assert.equal(readFileSync(path.join(outside, 'app/2026-11-01-old/red.txt'), 'utf8'), 'failing\n');
    assert.deepEqual(
      readdirSync(path.join(outside, 'app')).filter((entry) => entry.startsWith('2026-11-02-new')),
      [],
    );
    assert.ok(store.archive.has('app', '2026-11-01-old'), 'the copy was removed');
  });

  test(`${name}: remove deletes the evidence before the copy, so a failed evidence delete leaves the copy to find`, { skip: process.getuid?.() === 0 }, (t) => {
    const h = home(t);
    const store = open(h);
    const from = path.join(h, 'from');
    mkdirSync(path.join(from, 'kept'), { recursive: true });
    writeFileSync(path.join(from, 'kept/red.txt'), 'failing\n');
    store.archive.write('app', '2026-11-01-old', text('old'), from);
    const kept = path.join(store.archive.evidenceLocation('app', '2026-11-01-old'), 'kept');
    chmodSync(kept, 0o500);
    try {
      assert.throws(() => store.archive.remove('app', '2026-11-01-old'));
    } finally {
      // Before the temporary home is removed.
      chmodSync(kept, 0o700);
    }

    assert.ok(store.archive.has('app', '2026-11-01-old'), 'the copy was removed before its evidence');
  });
}

/** Runs `edit` once, just before the first call of `method` on `file`, as another program that edits it at that moment would. */
function editBefore(t: TestContext, method: 'rmSync' | 'renameSync', file: string, edit: () => void): () => boolean {
  let edited = false;
  const real = fs[method] as (...args: unknown[]) => unknown;
  t.mock.method(fs, method, (...args: unknown[]) => {
    if (!edited && args[0] === file) {
      edited = true;
      edit();
    }
    return real(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return () => edited;
}

test('file store: an archive remove keeps an edit made to the copy while its evidence is removed', (t) => {
  const { h, store } = fileHome(t);
  const from = path.join(h, 'from');
  mkdirSync(from);
  writeFileSync(path.join(from, 'red.txt'), 'failing\n');
  store.archive.write('app', '2026-11-01-old', text('old'), from);
  const file = store.archive.location('app', '2026-11-01-old');
  const edited = `${text('old')}Edited meanwhile.\n`;
  const didEdit = editBefore(t, 'rmSync', store.archive.evidenceLocation('app', '2026-11-01-old'), () => writeFileSync(file, edited));

  store.archive.remove('app', '2026-11-01-old', { text: text('old'), evidence: from });

  assert.ok(didEdit(), 'the evidence was not removed');
  assert.equal(readFileSync(file, 'utf8'), edited);
});

test('file store: an archive remove that finds the copy changed as it deletes it puts the copy back, keeps the evidence and gives false', (t) => {
  const { h, store } = fileHome(t);
  const from = path.join(h, 'from');
  mkdirSync(from);
  writeFileSync(path.join(from, 'red.txt'), 'failing\n');
  store.archive.write('app', '2026-11-01-old', text('old'), from);
  const file = store.archive.location('app', '2026-11-01-old');
  const edited = recordJson(parseRecord(`${text('old')}Edited meanwhile.\n`));
  const didEdit = editBefore(t, 'renameSync', file, () => writeFileSync(file, edited));

  const removed = store.archive.remove('app', '2026-11-01-old', { text: text('old'), evidence: from });

  assert.ok(didEdit(), 'the copy was not moved aside before its delete');
  assert.equal(removed, false);
  assert.equal(readFileSync(file, 'utf8'), edited);
  assert.deepEqual(store.archive.evidenceFiles('app', '2026-11-01-old'), ['red.txt']);
  assert.deepEqual(
    readdirSync(path.dirname(file)).filter((entry) => entry.startsWith('2026-11-01-old.json')),
    ['2026-11-01-old.json'],
  );
});

for (const [name, open] of [['file store', (h: string) => fileStore(ledgerPaths(h))], ['git store', openGitStore]] as const) {
  const replacements = [
    ['toRecord of a backlog ledger', 'backlog', 'old', (store: LedgerStore) => store.backlog.toRecord?.('app', 'old')],
    ['toRecord of an archive copy', 'archive', '2026-11-01-old', (store: LedgerStore) => store.archive.toRecord?.('app', '2026-11-01-old')],
    ['a backlog write', 'backlog', 'old', (store: LedgerStore) => store.backlog.write('app', 'old', text('old'))],
    ['a backlog update', 'backlog', 'old', (store: LedgerStore) => store.backlog.update('app', 'old', () => text('old'))],
  ] as const;
  for (const [what, place, ledger, replace] of replacements) {
    test(`${name}: ${what} holds the lock of the Markdown it replaces, so an edit that a writer from before records makes meanwhile is kept`, (t) => {
      const h = home(t);
      const store = open(h);
      plantMarkdown(h, store, place, 'app', ledger, STRAY);
      const markdown = path.join(store[place].repoLocation('app'), `${ledger}.md`);
      const edited = `${STRAY}A line written meanwhile.\n`;
      // Such a writer locks <name>.md alone, and waits while another process holds that lock.
      let waited = false;
      editBefore(t, 'rmSync', markdown, () => {
        if (withLockIfFree(markdown, () => writeFileSync(markdown, edited)) === 'busy') waited = true;
      });

      replace(store);
      if (waited) withLock(markdown, () => writeFileSync(markdown, edited));

      assert.equal(existsSync(markdown) ? readFileSync(markdown, 'utf8') : 'removed', edited, 'the edit made meanwhile is kept');
      assert.deepEqual(store[place].hiddenMarkdown?.('app'), [ledger]);
    });
  }

  test(`${name}: a record made in place of Markdown keeps the Markdown's mode, whatever the umask`, (t) => {
    const umask = process.umask(0o022);
    t.after(() => process.umask(umask));
    const h = home(t);
    const store = open(h);
    const ledgers = [['backlog', 'converted'], ['archive', '2026-11-01-converted'], ['backlog', 'written']] as const;
    for (const [place, ledger] of ledgers) {
      plantMarkdown(h, store, place, 'app', ledger, STRAY);
      chmodSync(store[place].location('app', ledger), 0o600);
    }

    assert.ok(store.backlog.toRecord?.('app', 'converted'));
    assert.ok(store.archive.toRecord?.('app', '2026-11-01-converted'));
    store.backlog.write('app', 'written', text('written'));

    for (const [place, ledger] of ledgers) {
      const record = store[place].location('app', ledger);
      assert.ok(record.endsWith('.json'), record);
      assert.equal(mode(record), 0o600, record);
    }
  });
}

test('sqlite store: copyEvidence refuses a path through a link it wrote under a name that differs only in case, on a volume that ignores case', { skip: noSqlite }, (t) => {
  const h = home(t);
  writeFileSync(path.join(h, 'Case'), '');
  if (!existsSync(path.join(h, 'case'))) return t.skip('this volume tells case apart');
  const store = sqliteStore({ home: h });
  store.archive.write('app', '2026-11-01-old', text('old'));
  store.close?.();
  const { DatabaseSync } = loadSqlite() ?? assert.fail('no node:sqlite');
  const db = new DatabaseSync(path.join(h, '.claude/ledgers.db'));
  for (const [file, kind, data] of [
    ['Up', 'link', '..'],
    ['up/escaped.txt', 'file', 'out'],
  ]) {
    db.prepare('INSERT INTO evidence VALUES (?, ?, ?, ?, ?)').run('app', '2026-11-01-old', file, kind, Buffer.from(data));
  }
  db.close();
  const parent = path.join(h, 'parent');
  const to = path.join(parent, 'copy');
  mkdirSync(parent);

  const reopened = sqliteStore({ home: h });
  t.after(() => reopened.close?.());
  assert.throws(() => reopened.archive.copyEvidence('app', '2026-11-01-old', to), /evidence path/);

  assert.equal(existsSync(path.join(parent, 'escaped.txt')), false);
});

test('sqlite store: copyEvidence refuses an evidence path that leaves its folder: .., absolute, or through a link it wrote', { skip: noSqlite }, (t) => {
  const cases: [string, [path: string, kind: 'file' | 'folder' | 'link', data: string][]][] = [
    ['..', [['../escaped.txt', 'file', 'out']]],
    ['an absolute path', [['/escaped.txt', 'file', 'out']]],
    ['a link', [['up', 'link', '..'], ['up/escaped.txt', 'file', 'out']]],
  ];
  for (const [what, entries] of cases) {
    const h = home(t);
    const store = sqliteStore({ home: h });
    store.archive.write('app', '2026-11-01-old', text('old'));
    store.close?.();
    const { DatabaseSync } = loadSqlite() ?? assert.fail('no node:sqlite');
    const db = new DatabaseSync(path.join(h, '.claude/ledgers.db'));
    for (const [file, kind, data] of entries) db.prepare('INSERT INTO evidence VALUES (?, ?, ?, ?, ?)').run('app', '2026-11-01-old', file, kind, Buffer.from(data));
    db.close();
    const parent = path.join(h, 'parent');
    const to = path.join(parent, 'copy');
    mkdirSync(parent);

    const reopened = sqliteStore({ home: h });
    t.after(() => reopened.close?.());
    assert.throws(() => reopened.archive.copyEvidence('app', '2026-11-01-old', to), /evidence path/, what);

    assert.equal(existsSync(path.join(parent, 'escaped.txt')), false, what);
    assert.equal(existsSync(path.join(to, 'escaped.txt')), false, what);
  }
});

test('sqlite store: everything is in <home>/.claude/ledgers.db, with no other file under <home>/.claude but its journal files', { skip: noSqlite }, (t) => {
  const h = home(t);
  const claude = path.join(h, '.claude');
  const before = readdirSync(claude);
  const store = sqliteStore({ home: h });
  const evidence = path.join(h, 'evidence');
  mkdirSync(evidence);
  writeFileSync(path.join(evidence, 'red.txt'), 'failing');
  store.backlog.write('app', 'fix-login', text('fix-login'));
  store.archive.write('app', '2026-11-01-old', text('old'), evidence);
  store.registry.write('[]\n');
  const added = readdirSync(claude).filter((name) => !before.includes(name));
  assert.deepEqual(
    added.filter((name) => !/^ledgers\.db-(?:wal|shm|journal)$/.test(name)),
    ['ledgers.db'],
  );
});

const mode = (file: string): number => statSync(file).mode & 0o777;
const leftovers = (folder: string): string[] => readdirSync(folder).filter((name) => name.includes('.tmp-'));

test('file store: each ledger is a <name>.json task record where the old layout had <name>.md, and its location is that absolute path', (t) => {
  const { h, store } = fileHome(t);
  store.backlog.write('app', 'fix-login', text('fix-login'));
  store.archive.write('app', '2026-11-01-fix-login', text('old'));
  store.registry.write('[]\n');
  const backlog = path.join(h, '.claude/ledger-backlog/app/fix-login.json');
  const archive = path.join(h, '.claude/ledger-archive/app/2026-11-01-fix-login.json');
  assert.deepEqual(JSON.parse(readFileSync(backlog, 'utf8')), parseRecord(text('fix-login')));
  assert.deepEqual(JSON.parse(readFileSync(archive, 'utf8')), parseRecord(text('old')));
  assert.equal(existsSync(path.join(h, '.claude/ledger-backlog/app/fix-login.md')), false);
  assert.equal(readFileSync(path.join(h, '.claude/ledgers.json'), 'utf8'), '[]\n');
  assert.equal(store.backlog.read('app', 'fix-login')?.location, backlog);
  assert.equal(store.backlog.location('app', 'fix-login'), backlog);
  assert.equal(store.archive.read('app', '2026-11-01-fix-login')?.location, archive);
});

test('file store: a write replaces <name>.md with <name>.json, and the location names the file there is', (t) => {
  const { h, store } = fileHome(t);
  const folder = path.join(h, '.claude/ledger-backlog/app');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'fix-login.md'), STRAY);
  assert.equal(store.backlog.location('app', 'fix-login'), path.join(folder, 'fix-login.md'));
  assert.equal(store.backlog.read('app', 'fix-login')?.location, path.join(folder, 'fix-login.md'));
  store.backlog.write('app', 'fix-login', text('fix-login'));
  assert.deepEqual(readdirSync(folder), ['fix-login.json']);
  assert.equal(store.backlog.location('app', 'fix-login'), path.join(folder, 'fix-login.json'));
  assert.equal(store.backlog.location('app', 'new-task'), path.join(folder, 'new-task.json'));
});

test('file store: a <name>.json that is no task record fails a read and names the file, and a list leaves it out', (t) => {
  const { h, store } = fileHome(t);
  const folder = path.join(h, '.claude/ledger-backlog/app');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'broken.json'), '{"version": 1, "slug": 3}');
  writeFileSync(path.join(folder, 'garbled.json'), '<<<<<<< HEAD');
  assert.throws(() => store.backlog.read('app', 'broken'), (error: Error) => error.message.includes(path.join(folder, 'broken.json')) && /slug/.test(error.message));
  assert.throws(() => store.backlog.read('app', 'garbled'), (error: Error) => error.message.includes(path.join(folder, 'garbled.json')));
  store.backlog.write('app', 'fine', text('fine'));
  assert.deepEqual(
    store.backlog.list('app').map(({ name }) => name),
    ['fine'],
  );
});

/** Commits what is in the clone as a person would, so a ledger planted there is in HEAD before the store writes. */
const commitByHand = (clone: string): void => {
  for (const args of [['add', '-A', '-f', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--no-verify', '-m', 'planted']]) {
    assert.equal(spawnSync('git', args, { cwd: clone }).status, 0, args.join(' '));
  }
};

test('git store: a write over a committed <name>.md commits <name>.json and the removal of the .md, and commit checks the record', (t) => {
  const h = home(t);
  const clone = path.join(h, '.claude/ledger-data');
  const store = openGitStore(h);
  plantMarkdown(h, store, 'backlog', 'app', 'fix-login', STRAY);
  commitByHand(clone);
  assert.deepEqual(spawnSync('git', ['ls-files'], { cwd: clone, encoding: 'utf8' }).stdout.split('\n').filter(Boolean), ['.ledger-data', 'backlog/app/fix-login.md']);
  store.backlog.write('app', 'fix-login', text('fix-login'));
  store.commit?.([{ place: 'backlog', repo: 'app', name: 'fix-login', text: text('fix-login') }]);
  assert.deepEqual(spawnSync('git', ['ls-files'], { cwd: clone, encoding: 'utf8' }).stdout.split('\n').filter(Boolean), ['.ledger-data', 'backlog/app/fix-login.json']);
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: clone, encoding: 'utf8' }).stdout, '');
});

test('sqlite store: a record is a row of the table records, whose parent and state columns come from the record; a write deletes the ledgers row', { skip: noSqlite }, (t) => {
  const h = home(t);
  const store = sqliteStore({ home: h });
  t.after(() => store.close?.());
  plantMarkdown(h, store, 'backlog', 'app', 'child', STRAY);
  store.backlog.write('app', 'child', ledgerText({ slug: 'child', main: '/repos/app', parent: 'epic' }));
  const db = new (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync(sqliteFile(h), { readOnly: true });
  t.after(() => db.close());
  const rows = db.prepare('SELECT place, repo, name, record, parent, state FROM records').all();
  assert.deepEqual(
    rows.map(({ place, repo, name, parent, state }) => ({ place, repo, name, parent, state })),
    [{ place: 'backlog', repo: 'app', name: 'child', parent: 'epic', state: null }],
  );
  assert.deepEqual(JSON.parse(String(rows[0].record)), parseRecord(ledgerText({ slug: 'child', main: '/repos/app', parent: 'epic' })));
  assert.deepEqual(db.prepare('SELECT name FROM ledgers').all(), []);
});

test('git store: toRecord is committed like any other write', (t) => {
  const h = home(t);
  const clone = path.join(h, '.claude/ledger-data');
  const store = openGitStore(h);
  plantMarkdown(h, store, 'archive', 'app', '2026-11-01-old', STRAY);
  commitByHand(clone);
  assert.ok(store.archive.toRecord?.('app', '2026-11-01-old'));
  store.commit?.();
  assert.deepEqual(spawnSync('git', ['ls-files'], { cwd: clone, encoding: 'utf8' }).stdout.split('\n').filter(Boolean), ['.ledger-data', 'archive/app/2026-11-01-old.json']);
});

test('file store: a repo location is the repo folder, and without a repo the folder of all repos', (t) => {
  const { h, store } = fileHome(t);
  assert.equal(store.backlog.repoLocation('app'), path.join(h, '.claude/ledger-backlog/app'));
  assert.equal(store.archive.repoLocation('app'), path.join(h, '.claude/ledger-archive/app'));
  assert.equal(store.archive.repoLocation(), path.join(h, '.claude/ledger-archive'));
});

test('file store: an evidence location is the folder next to the archive copy, named as the copy without .md', (t) => {
  const { h, store } = fileHome(t);
  const evidence = path.join(h, 'evidence');
  mkdirSync(evidence);
  writeFileSync(path.join(evidence, 'red.txt'), 'failing');
  store.archive.write('app', '2026-11-01-fix-login', 'archive', evidence);
  const folder = path.join(h, '.claude/ledger-archive/app/2026-11-01-fix-login');
  assert.equal(store.archive.evidenceLocation('app', '2026-11-01-fix-login'), folder);
  assert.equal(readFileSync(path.join(folder, 'red.txt'), 'utf8'), 'failing');
});

test('file store: a repo or name that is empty, . or .., or holds a path separator, is refused, and a list leaves such a file out', (t) => {
  const { h, store } = fileHome(t);
  const archive = path.join(h, '.claude/ledger-archive');
  store.archive.write('app', '2026-11-01-fix-login', 'archive');
  for (const file of ['...md', '..md']) writeFileSync(path.join(archive, 'app', file), 'dots');
  writeFileSync(path.join(archive, 'keep.txt'), 'kept');

  assert.deepEqual(
    store.archive.list('app').map(({ name }) => name),
    ['2026-11-01-fix-login'],
  );
  for (const [repo, name] of [['app', '..'], ['app', '.'], ['app', ''], ['app', 'a/b'], ['app', 'a\\b'], ['..', 'x'], ['.', 'x'], ['a\\b', 'x']]) {
    assert.throws(() => store.archive.remove(repo, name), Failure, `archive remove ${repo} ${name}`);
    assert.throws(() => store.archive.evidenceLocation(repo, name), Failure, `evidence location ${repo} ${name}`);
    assert.throws(() => store.backlog.write(repo, name, 'text'), Failure, `backlog write ${repo} ${name}`);
  }
  assert.equal(readFileSync(path.join(archive, 'keep.txt'), 'utf8'), 'kept');
  assert.ok(store.archive.has('app', '2026-11-01-fix-login'));
  assert.equal(existsSync(path.join(h, '.claude/x.md')), false);
});

test('file store: a list skips what is not a .md file, such as an evidence folder next to an archive copy', (t) => {
  const { h, store } = fileHome(t);
  store.archive.write('app', '2026-11-01-fix-login', 'archive');
  const folder = path.join(h, '.claude/ledger-archive/app');
  mkdirSync(path.join(folder, '2026-11-01-fix-login'));
  writeFileSync(path.join(folder, 'notes.txt'), 'not a ledger');
  writeFileSync(path.join(h, '.claude/ledger-archive/stray.md'), 'not in a repo folder');
  assert.deepEqual(store.archive.list('app').map(({ name }) => name), ['2026-11-01-fix-login']);
  assert.deepEqual(store.archive.repos(), ['app']);
});

test('file store: a claim is kept in the task record as an object of its session, since and active times', (t) => {
  const { store } = fileHome(t);
  store.backlog.write('app', 'claimed', text('claimed').replace('- design refs: none\n', '- design refs: none\n- claim: session s-1 since 2026-11-20T10:00:00Z, active 2026-11-20T10:20:00Z\n'));
  const record = JSON.parse(readFileSync(store.backlog.location('app', 'claimed'), 'utf8'));
  assert.deepEqual(record.claim, { session: 's-1', since: '2026-11-20T10:00:00Z', active: '2026-11-20T10:20:00Z' });
});

test('file store: a folder named <name>.md is no ledger: has, read and list all leave it out', (t) => {
  const { h, store } = fileHome(t);
  mkdirSync(path.join(h, '.claude/ledger-backlog/app/x.md'), { recursive: true });
  mkdirSync(path.join(h, '.claude/ledger-archive/app/2026-11-01-x.md'), { recursive: true });
  assert.equal(store.backlog.has('app', 'x'), false);
  assert.equal(store.backlog.read('app', 'x'), undefined);
  assert.deepEqual(store.backlog.list('app'), []);
  assert.equal(store.archive.has('app', '2026-11-01-x'), false);
  assert.equal(store.archive.read('app', '2026-11-01-x'), undefined);
  assert.deepEqual(store.archive.list('app'), []);
});

test('file store: a symbolic link named <name>.md is no ledger, even to a readable file: has, read and list all leave it out', (t) => {
  const { h, store } = fileHome(t);
  const target = path.join(h, 'elsewhere/linked.md');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, 'linked');
  for (const folder of ['ledger-backlog', 'ledger-archive']) {
    mkdirSync(path.join(h, '.claude', folder, 'app'), { recursive: true });
    symlinkSync(target, path.join(h, '.claude', folder, 'app/2026-11-01-linked.md'));
  }
  for (const collection of [store.backlog, store.archive]) {
    assert.equal(collection.has('app', '2026-11-01-linked'), false);
    assert.equal(collection.read('app', '2026-11-01-linked'), undefined);
    assert.deepEqual(collection.list('app'), []);
  }
});

// Root reads a mode-000 file all the same.
for (const extension of ['json', 'md'] as const) {
  test(`file store: an unreadable <name>.${extension} is no ledger: has, read and list all leave it out`, { skip: process.getuid?.() === 0 }, (t) => {
    const { h, store } = fileHome(t);
    if (extension === 'json') {
      store.backlog.write('app', 'x', 'backlog');
      store.archive.write('app', '2026-11-01-x', 'archive');
    } else {
      plantMarkdown(h, store, 'backlog', 'app', 'x', 'backlog');
      plantMarkdown(h, store, 'archive', 'app', '2026-11-01-x', 'archive');
    }
    chmodSync(path.join(h, `.claude/ledger-backlog/app/x.${extension}`), 0o000);
    chmodSync(path.join(h, `.claude/ledger-archive/app/2026-11-01-x.${extension}`), 0o000);
    assert.equal(store.backlog.has('app', 'x'), false);
    assert.equal(store.backlog.read('app', 'x'), undefined);
    assert.deepEqual(store.backlog.list('app'), []);
    assert.equal(store.archive.has('app', '2026-11-01-x'), false);
    assert.equal(store.archive.read('app', '2026-11-01-x'), undefined);
    assert.deepEqual(store.archive.list('app'), []);
  });
}

test('file store: repos are sorted by their full name, so app comes before app-x', (t) => {
  const { h, store } = fileHome(t);
  for (const repo of ['lib', 'app-x', 'app']) mkdirSync(path.join(h, '.claude/ledger-backlog', repo), { recursive: true });
  assert.deepEqual(store.backlog.repos(), ['app', 'app-x', 'lib']);
});

test('file store: a symbolic link to a folder is a repo', (t) => {
  const { h, store } = fileHome(t);
  const target = path.join(h, 'elsewhere/app');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'linked.md'), 'linked');
  mkdirSync(path.join(h, '.claude/ledger-backlog'), { recursive: true });
  symlinkSync(target, path.join(h, '.claude/ledger-backlog/app'));
  assert.deepEqual(store.backlog.repos(), ['app']);
  assert.deepEqual(store.backlog.list('app').map(({ name }) => name), ['linked']);
});

test('file store: an archive write refuses a dangling symbolic link at the copy, and leaves the link as it was', (t) => {
  const { h, store } = fileHome(t);
  const folder = path.join(h, '.claude/ledger-archive/app');
  const copy = path.join(folder, '2026-11-01-fix-login.json');
  mkdirSync(folder, { recursive: true });
  symlinkSync(path.join(h, 'missing.md'), copy);
  assert.throws(() => store.archive.write('app', '2026-11-01-fix-login', 'archive'), /already exists/);
  assert.ok(lstatSync(copy).isSymbolicLink());
  assert.equal(readlinkSync(copy), path.join(h, 'missing.md'));
  assert.equal(existsSync(path.join(h, 'missing.md')), false);
  assert.deepEqual(leftovers(folder), []);
});

test('file store: an archive write does not follow a symbolic link at its temporary name, and writes no copy', (t) => {
  const { h, store } = fileHome(t);
  const folder = path.join(h, '.claude/ledger-archive/app');
  const copy = path.join(folder, '2026-11-01-fix-login.json');
  const victim = path.join(h, 'victim.txt');
  writeFileSync(victim, 'keep me');
  mkdirSync(folder, { recursive: true });
  symlinkSync(victim, `${copy}.tmp-${process.pid}`);
  assert.throws(() => store.archive.write('app', '2026-11-01-fix-login', 'archive'), (error: NodeJS.ErrnoException) => error.code === 'EEXIST');
  assert.equal(readFileSync(victim, 'utf8'), 'keep me');
  assert.equal(existsSync(copy), false);
  assert.ok(lstatSync(`${copy}.tmp-${process.pid}`).isSymbolicLink());
});

test('file store: a backlog write does not follow a symbolic link at its temporary name, and keeps the ledger as it was', (t) => {
  const { h, store } = fileHome(t);
  store.backlog.write('app', 'fix-login', 'old');
  const file = path.join(h, '.claude/ledger-backlog/app/fix-login.json');
  const temporary = `${file}.tmp-${process.pid}`;
  const victim = path.join(h, 'victim.txt');
  writeFileSync(victim, 'keep me');
  symlinkSync(victim, temporary);
  assert.throws(() => store.backlog.write('app', 'fix-login', 'new'), (error: NodeJS.ErrnoException) => error.code === 'EEXIST');
  assert.equal(readFileSync(victim, 'utf8'), 'keep me');
  assert.ok(!lstatSync(file).isSymbolicLink());
  assert.equal(readFileSync(file, 'utf8'), recordJson(parseRecord('old')));
  assert.ok(lstatSync(temporary).isSymbolicLink());
});

test('file store: an archive write refuses a dangling symbolic link at the evidence copy before it writes the ledger copy', (t) => {
  const { h, store } = fileHome(t);
  const evidence = path.join(h, 'evidence');
  mkdirSync(evidence);
  writeFileSync(path.join(evidence, 'red.txt'), 'failing');
  const folder = path.join(h, '.claude/ledger-archive/app');
  mkdirSync(folder, { recursive: true });
  symlinkSync(path.join(h, 'missing'), path.join(folder, '2026-11-01-fix-login'));
  assert.throws(() => store.archive.write('app', '2026-11-01-fix-login', 'archive', evidence), /already exists/);
  assert.equal(store.archive.has('app', '2026-11-01-fix-login'), false);
  assert.equal(existsSync(path.join(h, 'missing')), false);
});

test('file store: an archive write keeps the ledger copy when the evidence copy then fails', (t) => {
  const { h, store } = fileHome(t);
  assert.throws(() => store.archive.write('app', '2026-11-01-fix-login', 'archive', path.join(h, 'no-evidence')));
  assert.equal(store.archive.read('app', '2026-11-01-fix-login')?.text, rendered('archive'));
});

test('file store: writes go through a temporary file that is gone afterwards, and keep the mode of the file they replace', (t) => {
  const { h, store } = fileHome(t);
  store.backlog.write('app', 'fix-login', 'one');
  store.registry.write('one');
  store.archive.write('app', '2026-11-01-fix-login', 'one');
  const files = new Map([
    [path.join(h, '.claude/ledger-backlog/app/fix-login.json'), recordJson(parseRecord('two'))],
    [path.join(h, '.claude/ledgers.json'), 'two'],
  ]);
  for (const file of files.keys()) chmodSync(file, 0o600);
  store.backlog.write('app', 'fix-login', 'two');
  store.registry.write('two');
  for (const [file, written] of files) {
    assert.equal(readFileSync(file, 'utf8'), written);
    assert.equal(mode(file), 0o600, file);
    assert.deepEqual(leftovers(path.dirname(file)), []);
  }
  assert.deepEqual(leftovers(path.join(h, '.claude/ledger-archive/app')), []);
});

test('file store: an archive write with evidence refuses a taken name before it copies anything', (t) => {
  const { h, store } = fileHome(t);
  const evidence = path.join(h, 'evidence');
  mkdirSync(evidence);
  writeFileSync(path.join(evidence, 'red.txt'), 'failing');
  store.archive.write('app', '2026-11-01-fix-login', 'first');
  assert.throws(() => store.archive.write('app', '2026-11-01-fix-login', 'second', evidence), /already exists/);
  assert.equal(store.archive.read('app', '2026-11-01-fix-login')?.text, rendered('first'));
  assert.equal(existsSync(path.join(h, '.claude/ledger-archive/app/2026-11-01-fix-login')), false);
});

test('file store: an archive write refuses an evidence folder that is already there, and writes no ledger copy', (t) => {
  const { h, store } = fileHome(t);
  const evidence = path.join(h, 'evidence');
  mkdirSync(evidence);
  writeFileSync(path.join(evidence, 'red.txt'), 'failing');
  const target = path.join(h, '.claude/ledger-archive/app/2026-11-01-fix-login');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'old.txt'), 'old');
  assert.throws(() => store.archive.write('app', '2026-11-01-fix-login', 'archive', evidence), /already exists/);
  assert.equal(store.archive.has('app', '2026-11-01-fix-login'), false);
  assert.deepEqual(readdirSync(target), ['old.txt']);
  assert.deepEqual(readdirSync(path.dirname(target)), ['2026-11-01-fix-login']);
});

test('file store: an archive write with evidence copies the folder next to the copy and leaves the source as it was', (t) => {
  const { h, store } = fileHome(t);
  const evidence = path.join(h, 'repos/app/.claude/worktrees/fix-login/.claude/evidence');
  mkdirSync(path.join(evidence, 'logs'), { recursive: true });
  writeFileSync(path.join(evidence, 'red.txt'), 'failing');
  writeFileSync(path.join(evidence, 'logs/build.log'), 'built');
  store.archive.write('app', '2026-11-01-fix-login', 'archive', evidence);
  const copy = path.join(h, '.claude/ledger-archive/app/2026-11-01-fix-login');
  assert.equal(readFileSync(path.join(copy, 'red.txt'), 'utf8'), 'failing');
  assert.equal(readFileSync(path.join(copy, 'logs/build.log'), 'utf8'), 'built');
  assert.equal(readFileSync(path.join(evidence, 'red.txt'), 'utf8'), 'failing');
  assert.equal(readFileSync(path.join(evidence, 'logs/build.log'), 'utf8'), 'built');
  assert.equal(store.archive.read('app', '2026-11-01-fix-login')?.text, rendered('archive'));
});

test('file store: evidenceState compares the evidence archived with a copy to a folder: files by content, links by their text, and types', (t) => {
  const { h, store } = fileHome(t);
  const from = path.join(h, 'evidence');
  const name = '2026-11-01-fix-login';
  assert.equal(store.archive.evidenceState('app', name), 'none');
  assert.equal(store.archive.evidenceState('app', name, path.join(h, 'missing')), 'none');
  mkdirSync(path.join(from, 'logs'), { recursive: true });
  writeFileSync(path.join(from, 'red.txt'), 'failing');
  writeFileSync(path.join(from, 'logs/build.log'), 'built');
  symlinkSync('red.txt', path.join(from, 'latest'));
  assert.equal(store.archive.evidenceState('app', name, from), 'differs', 'evidence on one side only');
  store.archive.write('app', name, 'archive', from);
  assert.equal(store.archive.evidenceState('app', name, from), 'same');
  assert.equal(store.archive.evidenceState('app', name), 'differs', 'evidence in the archive only');

  const copy = path.join(h, '.claude/ledger-archive/app', name);
  const changes: [string, () => void, () => void][] = [
    ['content', () => writeFileSync(path.join(copy, 'logs/build.log'), 'other'), () => writeFileSync(path.join(copy, 'logs/build.log'), 'built')],
    ['an extra file', () => writeFileSync(path.join(copy, 'extra.txt'), 'x'), () => rmSync(path.join(copy, 'extra.txt'))],
    ['link text', () => (rmSync(path.join(copy, 'latest')), symlinkSync('logs/build.log', path.join(copy, 'latest'))), () => (rmSync(path.join(copy, 'latest')), symlinkSync('red.txt', path.join(copy, 'latest')))],
    ['a file in place of a link', () => (rmSync(path.join(copy, 'latest')), writeFileSync(path.join(copy, 'latest'), 'failing')), () => (rmSync(path.join(copy, 'latest')), symlinkSync('red.txt', path.join(copy, 'latest')))],
  ];
  for (const [what, change, undo] of changes) {
    change();
    assert.equal(store.archive.evidenceState('app', name, from), 'differs', what);
    undo();
    assert.equal(store.archive.evidenceState('app', name, from), 'same', `${what} undone`);
  }
});

test('file store: evidenceFiles throws when the evidence folder cannot be read, rather than report no evidence', { skip: process.getuid?.() === 0 }, (t) => {
  const h = home(t);
  const store = fileStore(ledgerPaths(h));
  const from = path.join(h, 'evidence');
  mkdirSync(from);
  writeFileSync(path.join(from, 'red.txt'), 'failing\n');
  store.archive.write('app', '2026-11-01-fix-login', 'archived\n', from);
  const folder = store.archive.evidenceLocation('app', '2026-11-01-fix-login');
  chmodSync(folder, 0o000);
  // Before the HOME cleanup, which cannot remove a folder it cannot read.
  try {
    assert.throws(() => store.archive.evidenceFiles('app', '2026-11-01-fix-login'), { code: 'EACCES' });
  } finally {
    chmodSync(folder, 0o755);
  }
});

test('file store: an evidence folder that is a symbolic link is not followed: it lists no files and reads none', (t) => {
  const { h, store } = fileHome(t);
  store.archive.write('app', '2026-11-01-fix-login', 'archive');
  const elsewhere = path.join(h, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(path.join(elsewhere, 'red.txt'), 'failing\n');
  symlinkSync(elsewhere, store.archive.evidenceLocation('app', '2026-11-01-fix-login'));
  assert.deepEqual(store.archive.evidenceFiles('app', '2026-11-01-fix-login'), []);
  assert.equal(store.archive.readEvidence('app', '2026-11-01-fix-login', 'red.txt'), undefined);
});

test('file store: an archive write without evidence makes no evidence folder', (t) => {
  const { h, store } = fileHome(t);
  store.archive.write('app', '2026-11-01-fix-login', 'archive');
  assert.equal(existsSync(path.join(h, '.claude/ledger-archive/app/2026-11-01-fix-login')), false);
  assert.deepEqual(readdirSync(path.join(h, '.claude/ledger-archive/app')), ['2026-11-01-fix-login.json']);
});

/** A store that passes every call on to `inner` and notes it as `<part>.<method> <repo> <name>`, without the text. */
function recording(inner: LedgerStore): { store: LedgerStore; calls: string[] } {
  const calls: string[] = [];
  const note = (...call: string[]): void => void calls.push(call.join(' '));
  const store: LedgerStore = {
    host: inner.host,
    ownHosts: inner.ownHosts,
    active: inner.active,
    backlog: {
      location: (repo, name) => inner.backlog.location(repo, name),
      repoLocation: (repo) => inner.backlog.repoLocation(repo),
      repos: () => (note('backlog.repos'), inner.backlog.repos()),
      list: (repo) => (note('backlog.list', repo), inner.backlog.list(repo)),
      read: (repo, name) => (note('backlog.read', repo, name), inner.backlog.read(repo, name)),
      has: (repo, name) => (note('backlog.has', repo, name), inner.backlog.has(repo, name)),
      write: (repo, name, body) => (note('backlog.write', repo, name), inner.backlog.write(repo, name, body)),
      create: (repo, name, body) => (note('backlog.create', repo, name), inner.backlog.create(repo, name, body)),
      update: (repo, name, change) => (note('backlog.update', repo, name), inner.backlog.update(repo, name, change)),
      remove: (repo, name, expected) => (note('backlog.remove', repo, name), inner.backlog.remove(repo, name, expected)),
      move: (repo, name, to) => (note('backlog.move', repo, name, to), inner.backlog.move(repo, name, to)),
      canMove: (repo, name, to) => (note('backlog.canMove', repo, name, to), inner.backlog.canMove(repo, name, to)),
    },
    archive: {
      location: (repo, name) => inner.archive.location(repo, name),
      repoLocation: (repo) => inner.archive.repoLocation(repo),
      repos: () => (note('archive.repos'), inner.archive.repos()),
      list: (repo) => (note('archive.list', repo), inner.archive.list(repo)),
      read: (repo, name) => (note('archive.read', repo, name), inner.archive.read(repo, name)),
      has: (repo, name) => (note('archive.has', repo, name), inner.archive.has(repo, name)),
      write: (repo, name, body, evidenceFrom) => (note('archive.write', repo, name), inner.archive.write(repo, name, body, evidenceFrom)),
      evidenceState: (repo, name, from) => (note('archive.evidenceState', repo, name), inner.archive.evidenceState(repo, name, from)),
      nameTaken: (repo, name) => (note('archive.nameTaken', repo, name), inner.archive.nameTaken(repo, name)),
      evidenceLocation: (repo, name) => (note('archive.evidenceLocation', repo, name), inner.archive.evidenceLocation(repo, name)),
      evidenceFiles: (repo, name) => (note('archive.evidenceFiles', repo, name), inner.archive.evidenceFiles(repo, name)),
      readEvidence: (repo, name, file) => (note('archive.readEvidence', repo, name, file), inner.archive.readEvidence(repo, name, file)),
      copyEvidence: (repo, name, to) => (note('archive.copyEvidence', repo, name), inner.archive.copyEvidence(repo, name, to)),
      remove: (repo, name) => (note('archive.remove', repo, name), inner.archive.remove(repo, name)),
      move: (repo, name, to) => (note('archive.move', repo, name, to), inner.archive.move(repo, name, to)),
      canMove: (repo, name, to) => (note('archive.canMove', repo, name, to), inner.archive.canMove(repo, name, to)),
      orphanEvidence: () => (note('archive.orphanEvidence'), inner.archive.orphanEvidence()),
    },
    registry: {
      read: () => (note('registry.read'), inner.registry.read()),
      write: (body) => (note('registry.write'), inner.registry.write(body)),
      update: (change) => (note('registry.update'), inner.registry.update(change)),
      remove: () => (note('registry.remove'), inner.registry.remove()),
    },
    aliases: {
      read: () => (note('aliases.read'), inner.aliases.read()),
      problem: () => (note('aliases.problem'), inner.aliases.problem()),
      add: (old, key) => (note('aliases.add', old, key), inner.aliases.add(old, key)),
      remove: (old, key) => (note('aliases.remove', old, key), inner.aliases.remove(old, key)),
    },
  };
  return { store, calls };
}

function includesAll(calls: string[], expected: string[]): void {
  for (const call of expected) assert.ok(calls.includes(call), `expected the call "${call}" in:\n${calls.join('\n')}`);
}

test('the core reads and writes backlog ledgers and the registry through the store it is given', (t) => {
  const h = home(t);
  copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
  const app = repository(h, path.join(h, 'repos/app'));
  archivedTask(h, app, '2026-10-01', { slug: 'old-task', main: app });
  const paths = ledgerPaths(h);
  const { store, calls } = recording(fileStore(paths));
  const context: Context = { paths, cwd: app, store };
  const key = repoKeyOf(app);

  createTask(context, 'fix-login', { goal: 'Users cannot log in.' });
  includesAll(calls, [`backlog.has ${key} fix-login`, `backlog.create ${key} fix-login`, 'registry.update']);
  assert.match(store.backlog.read(key, 'fix-login')?.text ?? '', /Users cannot log in\./);

  calls.length = 0;
  parkTask(context, 'fix-login', 'waits for the API');
  includesAll(calls, ['registry.read', `backlog.list ${key}`, `backlog.update ${key} fix-login`]);
  assert.match(store.backlog.read(key, 'fix-login')?.text ?? '', /Parked: .* — waits for the API/);

  createTask(context, 'add-cache', { goal: 'Pages load slowly.' });
  calls.length = 0;
  goTask(context, 'add-cache', undefined);
  includesAll(calls, [`backlog.read ${key} add-cache`, `backlog.remove ${key} add-cache`]);
  assert.equal(store.backlog.has(key, 'add-cache'), false);
  assert.ok(store.active.has(key, 'add-cache'));

  calls.length = 0;
  const tasks = loadTasks(context);
  includesAll(calls, ['registry.read', 'backlog.repos', `backlog.list ${key}`, 'archive.repos', `archive.list ${key}`]);
  assert.deepEqual(
    tasks.map(({ slug, place }) => `${slug} ${place}`),
    ['add-cache active', 'fix-login backlog', 'old-task archive'],
  );
});
