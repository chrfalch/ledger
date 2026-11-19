import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileStore } from '../tools/ledger/file-store.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { loadTasks } from '../tools/ledger/registry.js';
import { sqliteStore } from '../tools/ledger/sqlite-store.js';
import type { LedgerStore } from '../tools/ledger/store.js';
import { createTask, goTask, parkTask, type Context } from '../tools/ledger/write.js';
import { REPO } from './helpers.js';
import { archivedTask, home, ledgerText, noSqlite, repository } from './ledger-core-fixtures.js';

const text = (slug: string): string => ledgerText({ slug, main: '/repos/app' });
/** Every byte value once, so no text decoding can pass the bytes through unchanged. */
const BYTES = Buffer.from(Array.from({ length: 256 }, (_, byte) => byte));

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

  test(`${name}: ledger text with a NUL byte reads back exactly, in the backlog and the archive`, { skip }, (t) => {
    const store = makeStore(t);
    const withNul = 'before\0after\n\0';
    store.backlog.write('app', 'fix-login', withNul);
    store.archive.write('app', '2026-11-01-fix-login', withNul);
    assert.equal(store.backlog.read('app', 'fix-login')?.text, withNul);
    assert.equal(store.backlog.list('app')[0]?.text, withNul);
    assert.equal(store.archive.read('app', '2026-11-01-fix-login')?.text, withNul);
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
    assert.equal(store.archive.read('app', '2026-11-01-fix-login')?.text, 'first');
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

  test(`${name}: a second backlog write replaces the text`, { skip }, (t) => {
    const store = makeStore(t);
    store.backlog.write('app', 'fix-login', 'old');
    store.backlog.write('app', 'fix-login', 'new');
    assert.equal(store.backlog.read('app', 'fix-login')?.text, 'new');
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
    assert.equal(store.archive.read('app', '2026-11-01-fix-login')?.text, 'first');
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
}

function fileHome(t: TestContext) {
  const h = home(t);
  const paths = ledgerPaths(h);
  return { h, paths, store: fileStore(paths) };
}

storeContract('file store', (h) => fileStore(ledgerPaths(h)));
storeContract('sqlite store', (h) => sqliteStore({ home: h }), noSqlite);

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

test('file store: each ledger is the file the old layout names, and its location is that absolute path', (t) => {
  const { h, store } = fileHome(t);
  store.backlog.write('app', 'fix-login', 'backlog');
  store.archive.write('app', '2026-11-01-fix-login', 'archive');
  store.registry.write('[]\n');
  const backlog = path.join(h, '.claude/ledger-backlog/app/fix-login.md');
  const archive = path.join(h, '.claude/ledger-archive/app/2026-11-01-fix-login.md');
  assert.equal(readFileSync(backlog, 'utf8'), 'backlog');
  assert.equal(readFileSync(archive, 'utf8'), 'archive');
  assert.equal(readFileSync(path.join(h, '.claude/ledgers.json'), 'utf8'), '[]\n');
  assert.equal(store.backlog.read('app', 'fix-login')?.location, backlog);
  assert.equal(store.backlog.location('app', 'fix-login'), backlog);
  assert.equal(store.archive.read('app', '2026-11-01-fix-login')?.location, archive);
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
test('file store: an unreadable <name>.md is no ledger: has, read and list all leave it out', { skip: process.getuid?.() === 0 }, (t) => {
  const { h, store } = fileHome(t);
  store.backlog.write('app', 'x', 'backlog');
  store.archive.write('app', '2026-11-01-x', 'archive');
  chmodSync(path.join(h, '.claude/ledger-backlog/app/x.md'), 0o000);
  chmodSync(path.join(h, '.claude/ledger-archive/app/2026-11-01-x.md'), 0o000);
  assert.equal(store.backlog.has('app', 'x'), false);
  assert.equal(store.backlog.read('app', 'x'), undefined);
  assert.deepEqual(store.backlog.list('app'), []);
  assert.equal(store.archive.has('app', '2026-11-01-x'), false);
  assert.equal(store.archive.read('app', '2026-11-01-x'), undefined);
  assert.deepEqual(store.archive.list('app'), []);
});

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
  const copy = path.join(folder, '2026-11-01-fix-login.md');
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
  const copy = path.join(folder, '2026-11-01-fix-login.md');
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
  const file = path.join(h, '.claude/ledger-backlog/app/fix-login.md');
  const temporary = `${file}.tmp-${process.pid}`;
  const victim = path.join(h, 'victim.txt');
  writeFileSync(victim, 'keep me');
  symlinkSync(victim, temporary);
  assert.throws(() => store.backlog.write('app', 'fix-login', 'new'), (error: NodeJS.ErrnoException) => error.code === 'EEXIST');
  assert.equal(readFileSync(victim, 'utf8'), 'keep me');
  assert.ok(!lstatSync(file).isSymbolicLink());
  assert.equal(readFileSync(file, 'utf8'), 'old');
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
  assert.equal(store.archive.read('app', '2026-11-01-fix-login')?.text, 'archive');
});

test('file store: writes go through a temporary file that is gone afterwards, and keep the mode of the file they replace', (t) => {
  const { h, store } = fileHome(t);
  store.backlog.write('app', 'fix-login', 'one');
  store.registry.write('one');
  store.archive.write('app', '2026-11-01-fix-login', 'one');
  const files = [path.join(h, '.claude/ledger-backlog/app/fix-login.md'), path.join(h, '.claude/ledgers.json')];
  for (const file of files) chmodSync(file, 0o600);
  store.backlog.write('app', 'fix-login', 'two');
  store.registry.write('two');
  for (const file of files) {
    assert.equal(readFileSync(file, 'utf8'), 'two');
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
  assert.equal(store.archive.read('app', '2026-11-01-fix-login')?.text, 'first');
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
  assert.equal(store.archive.read('app', '2026-11-01-fix-login')?.text, 'archive');
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
  assert.deepEqual(readdirSync(path.join(h, '.claude/ledger-archive/app')), ['2026-11-01-fix-login.md']);
});

/** A store that passes every call on to `inner` and notes it as `<part>.<method> <repo> <name>`, without the text. */
function recording(inner: LedgerStore): { store: LedgerStore; calls: string[] } {
  const calls: string[] = [];
  const note = (...call: string[]): void => void calls.push(call.join(' '));
  const store: LedgerStore = {
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
    },
    registry: {
      read: () => (note('registry.read'), inner.registry.read()),
      write: (body) => (note('registry.write'), inner.registry.write(body)),
      update: (change) => (note('registry.update'), inner.registry.update(change)),
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

  createTask(context, 'fix-login', { goal: 'Users cannot log in.' });
  includesAll(calls, ['backlog.has app fix-login', 'backlog.create app fix-login', 'registry.update']);
  assert.match(store.backlog.read('app', 'fix-login')?.text ?? '', /Users cannot log in\./);

  calls.length = 0;
  parkTask(context, 'fix-login', 'waits for the API');
  includesAll(calls, ['registry.read', 'backlog.list app', 'backlog.update app fix-login']);
  assert.match(store.backlog.read('app', 'fix-login')?.text ?? '', /Parked: .* — waits for the API/);

  createTask(context, 'add-cache', { goal: 'Pages load slowly.' });
  calls.length = 0;
  goTask(context, 'add-cache', undefined);
  includesAll(calls, ['backlog.read app add-cache', 'backlog.remove app add-cache']);
  assert.equal(store.backlog.has('app', 'add-cache'), false);
  assert.ok(existsSync(path.join(app, '.claude/worktrees/add-cache/.claude/ledger.md')));

  calls.length = 0;
  const tasks = loadTasks(context, [app]);
  includesAll(calls, ['registry.read', 'backlog.repos', 'backlog.list app', 'archive.repos', 'archive.list app']);
  assert.deepEqual(
    tasks.map(({ slug, place }) => `${slug} ${place}`),
    ['add-cache worktree', 'fix-login backlog', 'old-task archive'],
  );
});
