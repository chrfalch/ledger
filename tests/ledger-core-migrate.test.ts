import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Failure } from '../tools/ledger/failure.js';
import { fileStore } from '../tools/ledger/file-store.js';
import { parseRecord, recordJson, storedText } from '../tools/ledger/record.js';
import { migrateStorage } from '../tools/ledger/migrate.js';
import { ledgerPaths, type LedgerPaths } from '../tools/ledger/paths.js';
import { sqliteFile, sqliteStore } from '../tools/ledger/sqlite-store.js';
import type { Archive, Backlog, LedgerCollection, LedgerStore, Registry } from '../tools/ledger/store.js';
import { REPO } from './helpers.js';
import { cannotHideSqlite, home, LEDGER_BIN, ledger, ledgerIn, noSqlite, ok, repoKeyOf, repository, withoutSqlite, type Ran } from './ledger-core-fixtures.js';

type Storage = 'file' | 'sqlite';

const otherThan = (storage: Storage): Storage => (storage === 'file' ? 'sqlite' : 'file');
const settingsFile = (h: string): string => path.join(h, '.claude/ledger-settings.json');
const readSettings = (h: string): unknown => JSON.parse(readFileSync(settingsFile(h), 'utf8'));

/** Every byte value once, so no text decoding can pass the bytes through unchanged. */
const BYTES = Buffer.from(Array.from({ length: 256 }, (_, byte) => byte));

function today(): string {
  const date = new Date();
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(2, '0')).join('-');
}

const openStore = (paths: LedgerPaths | { home: string }, storage: Storage): LedgerStore =>
  storage === 'sqlite' ? sqliteStore(paths) : fileStore(ledgerPaths(paths.home));

/** Runs `use` on the store of `storage` in `h`, and closes it again so no database stays open between commands. */
function withStore<T>(h: string, storage: Storage, use: (store: LedgerStore) => T): T {
  const store = openStore({ home: h }, storage);
  try {
    return use(store);
  } finally {
    store.close?.();
  }
}

/** The store key of the repo ~/repos/<name>. */
const keyOf = (h: string, name: string): string => repoKeyOf(path.join(h, 'repos', name));

/** Everything a store holds, with evidence bytes as base64 so deepEqual compares them. */
function contents(store: LedgerStore) {
  const ledgers = (collection: LedgerCollection) => collection.repos().flatMap((repo) => collection.list(repo).map(({ name, text }) => ({ repo, name, text })));
  return {
    backlog: ledgers(store.backlog),
    archive: ledgers(store.archive).map((copy) => ({
      ...copy,
      evidence: store.archive.evidenceFiles(copy.repo, copy.name).map((file) => [file, store.archive.readEvidence(copy.repo, copy.name, file)?.toString('base64')]),
    })),
    registry: store.registry.read(),
  };
}

/** The files and the link `ledger retire` archives as evidence of the task old. */
function writeEvidence(folder: string): void {
  mkdirSync(path.join(folder, 'logs'), { recursive: true });
  writeFileSync(path.join(folder, 'red.txt'), 'failing\n');
  writeFileSync(path.join(folder, 'logs/trace.bin'), BYTES);
  symlinkSync('red.txt', path.join(folder, 'latest'));
}

/**
 * A HOME whose `from` storage holds the backlog ledgers app/fix-login and lib/idea, the archive copy app/<today>-old
 * with evidence, and a registry. The settings file names `from` and keeps one more key, which migrate must not drop.
 */
function populated(t: TestContext, from: Storage) {
  const h = home(t);
  copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
  writeFileSync(settingsFile(h), JSON.stringify({ storage: from, editor: 'vim' }));
  const [app, lib] = ['app', 'lib'].map((name) => {
    const main = repository(h, path.join(h, 'repos', name));
    writeFileSync(path.join(main, '.git/info/exclude'), '.claude/\n');
    return main;
  });
  ok(ledger(h, app, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.'));
  ok(ledger(h, lib, 'task', 'new', 'idea', '--goal', 'An idea.'));
  ok(ledger(h, app, 'task', 'new', 'old', '--goal', 'Old work.'));
  ok(ledger(h, app, 'go', 'old'));
  writeEvidence(path.join(app, '.claude/worktrees/old/.claude/evidence'));
  ok(ledger(h, app, 'task', 'retire', 'old'));
  ok(ledger(h, lib, 'list'));
  const source = withStore(h, from, contents);
  assert.equal(source.backlog.length, 2, 'the fixture made two backlog ledgers');
  assert.equal(source.archive.length, 1, 'the fixture made one archive copy');
  assert.ok(source.registry !== undefined, 'the fixture made a registry');
  return { h, app, lib, from, to: otherThan(from), source, archived: `${today()}-old` };
}

type Listed = { slug: string; repo: string; status: string; updated: string };

/** What `ledger list --archived` shows of each task, apart from where the store keeps it. */
function listed(h: string, cwd: string): Listed[] {
  const { tasks } = JSON.parse(ok(ledger(h, cwd, 'list', '--archived', '--json'))) as { tasks: Listed[] };
  return tasks.map(({ slug, repo, status, updated }) => ({ slug, repo, status, updated })).sort((a, b) => a.slug.localeCompare(b.slug));
}

type Entry = { slug: string; path: string; status: string; created: string; archivePath?: string };
const entries = (text: string | undefined): Entry[] => (text === undefined ? [] : (JSON.parse(text) as Entry[]));

function failed(ran: Ran): string {
  assert.equal(ran.status, 1, `exit 1 expected; stdout:\n${ran.stdout}\nstderr:\n${ran.stderr}`);
  return ran.stderr;
}

/** Whether the storage holds anything at all on disk; the file store and the database each have their own paths. */
function storageExists(h: string, storage: Storage): boolean {
  const claude = path.join(h, '.claude');
  const kept = storage === 'sqlite' ? ['ledgers.db'] : ['ledger-backlog', 'ledger-archive', 'ledgers.json'];
  return kept.some((name) => existsSync(path.join(claude, name)));
}

for (const from of ['file', 'sqlite'] as const) {
  const to = otherThan(from);
  const skip = noSqlite;

  test(`migrate ${from} → ${to} copies every backlog ledger, archive copy with its evidence bytes, and registry entry, and switches the setting`, { skip }, (t) => {
    const { h, app, source, archived } = populated(t, from);
    const before = listed(h, app);
    const stdout = ok(ledger(h, app, 'store', 'migrate', '--to', to));
    assert.deepEqual(readSettings(h), { storage: to, editor: 'vim' });
    const target = withStore(h, to, contents);
    assert.deepEqual(target.backlog, source.backlog);
    assert.deepEqual(target.archive, source.archive);
    assert.deepEqual(
      target.archive[0].evidence.map(([file]) => file),
      ['logs/trace.bin', 'red.txt'],
    );
    assert.deepEqual(withStore(h, to, (store) => store.archive.readEvidence(keyOf(h, 'app'), archived, 'logs/trace.bin')), BYTES);
    assert.match(stdout, /2 backlog ledgers/);
    assert.match(stdout, /1 archive copy/);
    assert.match(stdout, /2 evidence files/);
    // ledger list and ledger show now read the target storage, and the updated column keeps each ledger's time.
    assert.deepEqual(listed(h, app), before);
    assert.equal(ok(ledger(h, app, 'show', 'fix-login')), source.backlog.find(({ name }) => name === 'fix-login')?.text);
    const shown = spawnSync(LEDGER_BIN, ['show', 'old', '--evidence', 'logs/trace.bin'], { cwd: app, env: { ...process.env, HOME: h, GIT_CONFIG_GLOBAL: path.join(h, '.gitconfig') } });
    assert.equal(shown.status, 0, shown.stderr.toString());
    assert.deepEqual(shown.stdout, BYTES);
  });

  test(`migrate ${from} → ${to} keeps the symbolic link and the folders of the evidence`, { skip }, (t) => {
    const { h, app, archived } = populated(t, from);
    ok(ledger(h, app, 'store', 'migrate', '--to', to));
    const reference = path.join(h, 'reference');
    writeEvidence(reference);
    assert.equal(withStore(h, to, (store) => store.archive.evidenceState(keyOf(h, 'app'), archived, reference)), 'same');
    if (to === 'file') {
      const link = path.join(h, '.claude/ledger-archive', encodeURIComponent(keyOf(h, 'app')), archived, 'latest');
      assert.ok(lstatSync(link).isSymbolicLink());
      assert.equal(readlinkSync(link), 'red.txt');
    }
  });

  test(`migrate ${from} → ${to} copies the registry with each entry's created time, and points backlog and archive entries at the target`, { skip }, (t) => {
    const { h, app, source, archived } = populated(t, from);
    ok(ledger(h, app, 'store', 'migrate', '--to', to));
    const [copied, locations] = withStore(h, to, (store) => [
      entries(store.registry.read()),
      { 'fix-login': store.backlog.location(keyOf(h, 'app'), 'fix-login'), idea: store.backlog.location(keyOf(h, 'lib'), 'idea'), old: store.archive.location(keyOf(h, 'app'), archived) },
    ] as const);
    const bySlug = (list: Entry[]) => Object.fromEntries(list.map((entry) => [entry.slug, entry]));
    const [was, now] = [bySlug(entries(source.registry)), bySlug(copied)];
    assert.deepEqual(Object.keys(now).sort(), Object.keys(was).sort());
    for (const slug of Object.keys(was)) assert.equal(now[slug].created, was[slug].created, `created of ${slug}`);
    assert.equal(now['fix-login'].path, locations['fix-login']);
    assert.equal(now.idea.path, locations.idea);
    assert.equal(now.old.archivePath, locations.old);
  });

  test(`migrate ${from} → ${to} without --remove-source leaves the source as it was`, { skip }, (t) => {
    const { h, app, source } = populated(t, from);
    ok(ledger(h, app, 'store', 'migrate', '--to', to));
    assert.deepEqual(withStore(h, from, contents), source);
  });

  test(`migrate ${from} → ${to} --remove-source removes every copied ledger, archive copy and the registry from the source`, { skip }, (t) => {
    const { h, app, source, archived } = populated(t, from);
    const stdout = ok(ledger(h, app, 'store', 'migrate', '--to', to, '--remove-source'));
    assert.deepEqual(withStore(h, from, contents), { backlog: [], archive: [], registry: undefined });
    assert.deepEqual(
      withStore(h, from, (store) => [store.archive.nameTaken(keyOf(h, 'app'), archived), store.archive.evidenceFiles(keyOf(h, 'app'), archived)]),
      [false, []],
      'an evidence folder is left without its copy',
    );
    const target = withStore(h, to, contents);
    assert.deepEqual(target.backlog, source.backlog);
    assert.deepEqual(target.archive, source.archive);
    assert.match(stdout, /removed/);
    assert.match(ok(ledger(h, app, 'show', 'fix-login')), /Users cannot log in\./);
  });

  test(`migrate ${from} → ${to} exits 1 and changes nothing when the target already holds a backlog ledger or archive name to copy, even an identical one`, { skip }, (t) => {
    const { h, app, source, archived } = populated(t, from);
    const fixLogin = source.backlog.find(({ name }) => name === 'fix-login')?.text ?? assert.fail('no fix-login');
    withStore(h, to, (store) => {
      store.backlog.write(keyOf(h, 'app'), 'fix-login', fixLogin);
      store.archive.write(keyOf(h, 'app'), archived, 'another copy\n');
    });
    const target = withStore(h, to, contents);
    const settings = readFileSync(settingsFile(h), 'utf8');
    const stderr = failed(ledger(h, app, 'store', 'migrate', '--to', to));
    assert.match(stderr, /app\/fix-login/);
    assert.ok(stderr.includes(`app/${archived}`), stderr);
    assert.doesNotMatch(stderr, /lib\/idea/);
    assert.match(stderr, /identical/i);
    assert.equal(readFileSync(settingsFile(h), 'utf8'), settings);
    assert.deepEqual(withStore(h, from, contents), source);
    assert.deepEqual(withStore(h, to, contents), target);
  });

  test(`migrate ${from} → ${to} --dry-run prints the plan and changes nothing`, { skip }, (t) => {
    const { h, app, source } = populated(t, from);
    const settings = readFileSync(settingsFile(h), 'utf8');
    const stdout = ok(ledger(h, app, 'store', 'migrate', '--to', to, '--dry-run', '--remove-source'));
    assert.match(stdout, /dry run/i);
    assert.match(stdout, /2 backlog ledgers/);
    assert.match(stdout, /1 archive copy/);
    assert.match(stdout, /2 evidence files/);
    assert.equal(readFileSync(settingsFile(h), 'utf8'), settings);
    assert.equal(storageExists(h, to), false, `the dry run made the ${to} storage`);
    assert.deepEqual(withStore(h, from, contents), source);
  });

  test(`migrate ${from} → ${to} when the setting already names ${to} copies the ledgers and says the setting is unchanged`, { skip }, (t) => {
    const { h, app, source } = populated(t, from);
    writeFileSync(settingsFile(h), JSON.stringify({ storage: to, editor: 'vim' }));
    const stdout = ok(ledger(h, app, 'store', 'migrate', '--to', to));
    assert.match(stdout, /already/);
    assert.deepEqual(readSettings(h), { storage: to, editor: 'vim' });
    assert.deepEqual(withStore(h, to, contents).backlog, source.backlog);
  });
}

test('migrate merges the registry: an entry the target has stays as the target has it, and the others are added', { skip: noSqlite }, (t) => {
  const h = home(t);
  writeFileSync(settingsFile(h), JSON.stringify({ storage: 'file' }));
  const entry = (slug: string, created: string) => ({ repo: 'app', slug, path: `/repos/app/.claude/worktrees/${slug}/.claude/ledger.md`, branch: slug, status: 'active', created, updated: created });
  withStore(h, 'file', (store) => store.registry.write(JSON.stringify([entry('both', '2026-01-01T00:00:00.000Z'), entry('only-source', '2026-01-02T00:00:00.000Z')])));
  withStore(h, 'sqlite', (store) => store.registry.write(JSON.stringify([entry('both', '2025-12-31T00:00:00.000Z')])));
  const stdout = ok(ledger(h, h, 'store', 'migrate', '--to', 'sqlite'));
  assert.match(stdout, /1 added/);
  assert.match(stdout, /1 kept/);
  const merged = entries(withStore(h, 'sqlite', (store) => store.registry.read()));
  assert.deepEqual(merged.map(({ slug, created }) => [slug, created]).sort(), [
    ['both', '2025-12-31T00:00:00.000Z'],
    ['only-source', '2026-01-02T00:00:00.000Z'],
  ]);
});

test('migrate with a --to that is neither file nor sqlite exits 1 and names both', (t) => {
  const h = home(t);
  const stderr = failed(ledger(h, h, 'store', 'migrate', '--to', 'mysql'));
  assert.match(stderr, /file/);
  assert.match(stderr, /sqlite/);
});

test('migrate without --to exits 1', (t) => {
  const h = home(t);
  failed(ledger(h, h, 'store', 'migrate'));
});

type Change = { backlog?: Partial<Backlog>; archive?: Partial<Archive>; registry?: Partial<Registry> };

/** `store` with the methods of `change` in place of its own, so one call can throw or read back wrong. */
const changed = (store: LedgerStore, change: Change): LedgerStore => ({
  ...store,
  backlog: { ...store.backlog, ...change.backlog },
  archive: { ...store.archive, ...change.archive },
  registry: { ...store.registry, ...change.registry },
});

/** Runs migrate in this process, with `change` laid over the store of `to`, and gives the lines it printed. */
function migrateWith(h: string, to: Storage, change: Change, options: { removeSource?: boolean } = {}): string[] {
  const lines: string[] = [];
  const open = (paths: LedgerPaths, storage: Storage): LedgerStore => (storage === to ? changed(openStore(paths, storage), change) : openStore(paths, storage));
  migrateStorage(ledgerPaths(h), to, { removeSource: options.removeSource ?? false, dryRun: false }, (line) => lines.push(line), open);
  return lines;
}

function failure(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof Failure, `a Failure expected, not ${String(error)}`);
    assert.equal(error.exitCode, 1);
    return error.message;
  }
  return assert.fail('migrate did not fail');
}

const disk = (): never => {
  throw new Error('disk full');
};

/** Puts Markdown from before records beside the record `name` of `place`, which the record then hides. */
function hideMarkdown(h: string, storage: Storage, place: 'backlog' | 'archive', repo: string, name: string): void {
  const markdown = '# Task ledger — hidden\n\n## Goal\nAn older copy.\n';
  if (storage === 'sqlite') {
    const db = new (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync(sqliteFile(h));
    db.prepare('INSERT INTO ledgers VALUES (?, ?, ?, ?, ?, ?)').run(place, repo, name, Buffer.from(markdown), Date.now(), Date.now());
    db.close();
  } else writeFileSync(withStore(h, storage, (store) => store[place].location(repo, name)).replace(/\.json$/, '.md'), markdown);
}

const moduleUrl = (file: string): string => JSON.stringify(pathToFileURL(path.join(REPO, 'tools/ledger', file)).href);

/** Writes an archive copy to the `storage` of `h` from a process of its own, as another ledger command does. */
function writeArchiveElsewhere(h: string, storage: Storage, repo: string, name: string, text: string): void {
  const code = [
    "import { register } from 'tsx/esm/api';",
    'register();',
    `const { openStore } = await import(${moduleUrl('open-store.ts')});`,
    `const { ledgerPaths } = await import(${moduleUrl('paths.ts')});`,
    'const store = openStore(ledgerPaths(process.env.HOME), process.env.STORAGE);',
    'store.archive.write(process.env.REPO_NAME, process.env.LEDGER_NAME, process.env.LEDGER_TEXT);',
    'store.close?.();',
  ].join('\n');
  const env = { ...process.env, HOME: h, STORAGE: storage, REPO_NAME: repo, LEDGER_NAME: name, LEDGER_TEXT: text };
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: REPO, env, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
}

for (const from of ['file', 'sqlite'] as const) {
  const to = otherThan(from);
  const skip = noSqlite;

  const rollbacks: [string, (target: () => LedgerStore) => Change][] = [
    ['an archive copy reads back different', (target) => ({ archive: { read: (repo, name) => { const copy = target().archive.read(repo, name); return copy && { ...copy, text: `${copy.text}changed\n` }; } } })],
    ['an archive write throws after it wrote', (target) => ({ archive: { write: (...args) => (target().archive.write(...args), disk()) } })],
    ['a backlog create throws', () => ({ backlog: { create: disk } })],
    ['the registry update throws after it wrote', (target) => ({ registry: { update: (change) => (target().registry.update(change), disk()) } })],
  ];
  for (const [what, change] of rollbacks) {
    test(`migrate ${from} → ${to} exits 1 when ${what}, removes every copy it made, and leaves the setting and the source as they were`, { skip }, (t) => {
      const { h, source } = populated(t, from);
      const earlier = JSON.stringify([{ repo: 'zz', slug: 'earlier', path: '/elsewhere/ledger.md', branch: 'earlier', status: 'active', created: '2025-01-01T00:00:00.000Z', updated: '2025-01-01T00:00:00.000Z' }]);
      withStore(h, to, (store) => store.registry.write(earlier));
      const settings = readFileSync(settingsFile(h), 'utf8');
      let target: LedgerStore | undefined;
      const inner = () => (target ??= openStore({ home: h }, to));
      try {
        const message = failure(() => migrateWith(h, to, change(inner), { removeSource: true }));
        assert.match(message, /ledger store migrate stopped/);
        assert.match(message, /nothing was removed/);
      } finally {
        target?.close?.();
      }
      assert.equal(readFileSync(settingsFile(h), 'utf8'), settings);
      assert.deepEqual(withStore(h, from, contents), source);
      assert.deepEqual(withStore(h, to, contents), { backlog: [], archive: [], registry: earlier });
    });
  }

  test(`migrate ${from} → ${to} keeps an archive copy another command wrote under the same name during the copy`, { skip }, (t) => {
    const { h, archived } = populated(t, from);
    const theirs = storedText('Another command wrote this copy.\n');
    let target: LedgerStore | undefined;
    const inner = () => (target ??= openStore({ home: h }, to));
    try {
      const write: Archive['write'] = (repo, name, text, evidenceFrom) => {
        inner().archive.write(repo, name, theirs);
        inner().archive.write(repo, name, text, evidenceFrom);
      };
      assert.match(failure(() => migrateWith(h, to, { archive: { write } })), /already exists/);
    } finally {
      target?.close?.();
    }
    assert.equal(withStore(h, to, (store) => store.archive.read(keyOf(h, 'app'), archived)?.text), theirs);
  });

  test(`migrate ${from} → ${to} keeps an archive copy another command wrote with the same text when its own write then fails before it writes`, { skip }, (t) => {
    const { h, archived } = populated(t, from);
    const write: Archive['write'] = (repo, name, text) => {
      writeArchiveElsewhere(h, to, repo, name, text);
      disk();
    };
    assert.match(failure(() => migrateWith(h, to, { archive: { write } })), /disk full/);
    const text = withStore(h, from, (store) => store.archive.read(keyOf(h, 'app'), archived)?.text);
    assert.ok(text !== undefined);
    assert.equal(withStore(h, to, (store) => store.archive.read(keyOf(h, 'app'), archived)?.text), text);
  });

  test(`migrate ${from} → ${to} with no registry in the target removes the registry it wrote when the check fails`, { skip }, (t) => {
    const { h, source } = populated(t, from);
    failure(() => migrateWith(h, to, { backlog: { read: () => undefined } }));
    assert.deepEqual(withStore(h, from, contents), source);
    assert.deepEqual(withStore(h, to, contents), { backlog: [], archive: [], registry: undefined });
  });

  test(`migrate ${from} → ${to} --remove-source finishes when another command removed a source archive copy after the copy, and says so`, { skip }, (t) => {
    const { h } = populated(t, from);
    const gone = withStore(h, from, (store) => store.archive.repos().flatMap((repo) => store.archive.list(repo)));
    assert.ok(gone.length > 0);
    const lines = migrateWith(
      h,
      to,
      {
        backlog: {
          create: (repo, name, text) => {
            const created = withStore(h, to, (store) => store.backlog.create(repo, name, text));
            withStore(h, from, (store) => gone.forEach((copy) => store.archive.nameTaken(copy.repo, copy.name) && store.archive.remove(copy.repo, copy.name)));
            return created;
          },
        },
      },
      { removeSource: true },
    );
    for (const copy of gone) assert.ok(lines.some((line) => line.includes(`archive ${copy.repo}/${copy.name}`) && line.includes('already gone')), lines.join('\n'));
    assert.match(readFileSync(settingsFile(h), 'utf8'), new RegExp(`"storage": "${to}"`));
  });

  test(`migrate ${from} → ${to} --remove-source keeps a backlog ledger that changed after the copy, and its registry entry, and says so`, { skip }, (t) => {
    const { h, source } = populated(t, from);
    const changedText = storedText('Written by another session after the copy.\n');
    const lines = migrateWith(
      h,
      to,
      {
        backlog: {
          create: (repo, name, text) => {
            const created = withStore(h, to, (store) => store.backlog.create(repo, name, text));
            if (name === 'fix-login') withStore(h, from, (store) => store.backlog.write(repo, name, changedText));
            return created;
          },
        },
      },
      { removeSource: true },
    );
    assert.ok(lines.some((line) => line.includes(`kept backlog ${keyOf(h, 'app')}/fix-login`)), lines.join('\n'));
    const left = withStore(h, from, contents);
    assert.deepEqual(left.backlog, [{ repo: keyOf(h, 'app'), name: 'fix-login', text: changedText }]);
    assert.deepEqual(left.archive, []);
    assert.deepEqual(entries(left.registry).map(({ slug }) => slug), ['fix-login']);
    assert.deepEqual(withStore(h, to, contents).backlog, source.backlog);
    const removedEntries = entries(source.registry).length - 1;
    assert.ok(lines.at(-1)?.includes(`removed 1 backlog ledger, 1 archive copy and ${removedEntries} registry entries.`), lines.join('\n'));
  });

  test(`migrate ${from} → ${to} exits 1 when a backlog name is taken in the target after the check, keeps that ledger, and removes its own copies`, { skip }, (t) => {
    const { h, source } = populated(t, from);
    const theirs = storedText('Started by another session after the check.\n');
    let raced = false;
    const settings = readFileSync(settingsFile(h), 'utf8');
    // The check for taken archive names runs after the one for backlog names, so this write comes between that check and the copy.
    const takeName = () => {
      if (!raced) withStore(h, to, (store) => store.backlog.write(keyOf(h, 'app'), 'fix-login', theirs));
      raced = true;
      return false;
    };
    const message = failure(() => migrateWith(h, to, { archive: { nameTaken: takeName } }));
    assert.match(message, /ledger store migrate stopped/);
    assert.ok(message.includes(`backlog ${keyOf(h, 'app')}/fix-login`), message);
    assert.equal(readFileSync(settingsFile(h), 'utf8'), settings);
    assert.deepEqual(withStore(h, from, contents), source);
    assert.deepEqual(withStore(h, to, contents), { backlog: [{ repo: keyOf(h, 'app'), name: 'fix-login', text: theirs }], archive: [], registry: undefined });
  });

  test(`migrate ${from} → ${to} keeps a registry entry another command adds to the target while it copies`, { skip }, (t) => {
    const { h } = populated(t, from);
    let raced = false;
    const lines = migrateWith(h, to, {
      backlog: {
        setModified: (repo, name, mtimeMs) => {
          if (!raced) withStore(h, to, (store) => store.registry.update((now) => JSON.stringify([...entries(now), entry('concurrent')])));
          raced = true;
          withStore(h, to, (store) => store.backlog.setModified?.(repo, name, mtimeMs));
        },
      },
    });
    assert.ok(lines.at(-1)?.startsWith('Copied'), lines.join('\n'));
    assert.ok(
      entries(withStore(h, to, (store) => store.registry.read())).some(({ slug }) => slug === 'concurrent'),
      'the entry another command added is kept',
    );
  });

  test(`migrate ${from} → ${to} rolls back but keeps a backlog copy another command changed after the copy, and says so`, { skip }, (t) => {
    const { h, source } = populated(t, from);
    const changedText = storedText('Written in the target by another session after the copy.\n');
    const message = failure(() =>
      migrateWith(h, to, {
        archive: {
          write: () => {
            withStore(h, to, (store) => store.backlog.write(keyOf(h, 'app'), 'fix-login', changedText));
            disk();
          },
        },
      }),
    );
    assert.ok(message.includes(`backlog ${keyOf(h, 'app')}/fix-login`), message);
    assert.doesNotMatch(message, /Every copy it made in the .* was removed again\./);
    assert.deepEqual(withStore(h, from, contents), source);
    assert.deepEqual(withStore(h, to, contents), { backlog: [{ repo: keyOf(h, 'app'), name: 'fix-login', text: changedText }], archive: [], registry: undefined });
  });

  test(`migrate ${from} → ${to} --remove-source keeps a backlog ledger and an archive copy whose record hides Markdown, says so, and removes the rest`, { skip }, (t) => {
    const { h, archived } = populated(t, from);
    const app = keyOf(h, 'app');
    hideMarkdown(h, from, 'backlog', app, 'fix-login');
    hideMarkdown(h, from, 'archive', app, archived);

    const lines = migrateWith(h, to, {}, { removeSource: true });

    for (const kept of [`kept backlog ${app}/fix-login in the source`, `kept archive ${app}/${archived} in the source`]) {
      assert.ok(lines.some((line) => line.startsWith(kept) && line.includes('its record hides Markdown')), lines.join('\n'));
    }
    const left = withStore(h, from, (store) => ({ backlog: store.backlog.hiddenMarkdown?.(app), archive: store.archive.hiddenMarkdown?.(app), lib: store.backlog.list(keyOf(h, 'lib')) }));
    assert.deepEqual(left, { backlog: ['fix-login'], archive: [archived], lib: [] });
    assert.ok(lines.at(-1)?.includes('removed 1 backlog ledger, 0 archive copies'), lines.join('\n'));
  });

  test(`migrate ${from} → ${to} rolls back but keeps a copy whose record hides Markdown in the target, and says so`, { skip }, (t) => {
    const { h, source } = populated(t, from);
    const app = keyOf(h, 'app');
    const message = failure(() =>
      migrateWith(h, to, {
        archive: {
          write: () => {
            hideMarkdown(h, to, 'backlog', app, 'fix-login');
            disk();
          },
        },
      }),
    );
    assert.ok(message.includes(`backlog ${app}/fix-login`) && message.includes('hides Markdown'), message);
    assert.doesNotMatch(message, /Removing the copies it made failed too/);
    assert.deepEqual(withStore(h, from, contents), source);
    assert.deepEqual(
      withStore(h, to, (store) => [store.backlog.hiddenMarkdown?.(app), store.backlog.list(keyOf(h, 'lib'))]),
      [['fix-login'], []],
    );
  });
}

test('migrate --to sqlite --dry-run without node:sqlite exits 1, says migrate needs node:sqlite, and makes no database', { skip: cannotHideSqlite }, (t) => {
  const { h, app } = populated(t, 'file');
  const stderr = failed(ledgerIn(withoutSqlite(h), app, 'store', 'migrate', '--to', 'sqlite', '--dry-run'));
  assert.match(stderr, /ledger store migrate needs a Node version with node:sqlite: 22\.13 or later, and 23\.4 or later on Node 23\./);
  assert.equal(existsSync(sqliteFile(h)), false);
});

test('migrate --to file from SQLite storage without node:sqlite exits 1 and says migrate needs node:sqlite, not to set storage to file', { skip: cannotHideSqlite || noSqlite }, (t) => {
  const { h, app, source } = populated(t, 'sqlite');
  const stderr = failed(ledgerIn(withoutSqlite(h), app, 'store', 'migrate', '--to', 'file'));
  assert.match(stderr, /ledger store migrate needs a Node version with node:sqlite: 22\.13 or later, and 23\.4 or later on Node 23\./);
  assert.doesNotMatch(stderr, /set "storage"/);
  assert.deepEqual(withStore(h, 'sqlite', contents), source);
});

const entry = (slug: string, fields: Partial<Entry> & { updated?: string } = {}) => ({
  repo: 'app',
  slug,
  path: `/repos/app/.claude/worktrees/${slug}/.claude/ledger.md`,
  branch: slug,
  status: 'active',
  created: '2026-01-01T00:00:00.000Z',
  updated: '2026-01-01T00:00:00.000Z',
  ...fields,
});

test('migrate skips an archived registry entry with no archive path, counts it, and --remove-source leaves it in the source', { skip: noSqlite }, (t) => {
  const h = home(t);
  writeFileSync(settingsFile(h), JSON.stringify({ storage: 'file' }));
  withStore(h, 'file', (store) => store.registry.write(JSON.stringify([entry('active'), entry('lost', { status: 'archived' })])));
  const stdout = ok(ledger(h, h, 'store', 'migrate', '--to', 'sqlite', '--remove-source'));
  assert.match(stdout, /1 skipped/);
  assert.deepEqual(entries(withStore(h, 'sqlite', (store) => store.registry.read())).map(({ slug }) => slug), ['active']);
  assert.deepEqual(entries(withStore(h, 'file', (store) => store.registry.read())).map(({ slug }) => slug), ['lost']);
});

test('migrate merges a registry entry with no updated time', { skip: noSqlite }, (t) => {
  const h = home(t);
  writeFileSync(settingsFile(h), JSON.stringify({ storage: 'file' }));
  const undated = (slug: string) => {
    const { updated: _, ...rest } = entry(slug);
    return rest;
  };
  // Undated on both sides, so the sort compares an undated entry as either argument, whatever order it picks.
  withStore(h, 'file', (store) => store.registry.write(JSON.stringify([undated('undated'), entry('dated')])));
  withStore(h, 'sqlite', (store) => store.registry.write(JSON.stringify([undated('there')])));
  ok(ledger(h, h, 'store', 'migrate', '--to', 'sqlite'));
  assert.deepEqual(entries(withStore(h, 'sqlite', (store) => store.registry.read())).map(({ slug }) => slug).sort(), ['dated', 'there', 'undated']);
});

test('migrate copies an archive copy whose evidence folder is empty with that empty folder', { skip: noSqlite }, (t) => {
  const [h, other] = [home(t), home(t)];
  writeFileSync(settingsFile(h), JSON.stringify({ storage: 'file' }));
  const empty = path.join(h, 'empty');
  mkdirSync(empty);
  withStore(h, 'file', (store) => store.archive.write('app', '2026-01-01-old', 'Old work.\n', empty));
  const evidence = (at: string) => path.join(at, '.claude/ledger-archive/app/2026-01-01-old');
  assert.ok(statSync(evidence(h)).isDirectory(), 'the fixture made an empty evidence folder');
  // A second file store stands in for the SQLite one, which cannot hold an empty folder; only between file stores does the folder show.
  const open = (paths: LedgerPaths, storage: Storage): LedgerStore => fileStore(storage === 'sqlite' ? ledgerPaths(other) : paths);
  migrateStorage(ledgerPaths(h), 'sqlite', { removeSource: false, dryRun: false }, () => {}, open);
  assert.ok(existsSync(evidence(other)) && statSync(evidence(other)).isDirectory(), 'the copy has no evidence folder');
});

test('ledger store migrate names the storage it copies from on its first line, also when --from is not given', { skip: noSqlite }, (t) => {
  const h = home(t);
  const firstLine = (): string => ok(ledger(h, h, 'store', 'migrate', '--to', 'sqlite', '--dry-run')).split('\n')[0];
  writeFileSync(settingsFile(h), JSON.stringify({ storage: 'file' }));
  assert.equal(firstLine(), 'Migrate from file storage to SQLite storage · dry run, nothing changed');
  writeFileSync(settingsFile(h), JSON.stringify({ storage: 'sqlite' }));
  assert.equal(firstLine(), 'Migrate from file storage to SQLite storage · dry run, nothing changed');
});

test('migrate --remove-source withholds a secret-like ledger name in each line it prints about that ledger', { skip: noSqlite }, (t) => {
  const { h } = populated(t, 'file');
  // Built at run time, so no secret-like text sits in this file for a scanner to find.
  const changedName = `${['s', 'k-'].join('')}${'a1b2c3d4'.repeat(5)}`;
  const goneName = `${['s', 'k-'].join('')}${'e5f6g7h8'.repeat(5)}`;
  for (const name of [changedName, goneName]) writeFileSync(path.join(h, '.claude/ledger-backlog', encodeURIComponent(keyOf(h, 'app')), `${name}.md`), '# a secret-like name\n');
  const lines = migrateWith(
    h,
    'sqlite',
    {
      backlog: {
        create: (repo, name, text) => {
          const created = withStore(h, 'sqlite', (store) => store.backlog.create(repo, name, text));
          withStore(h, 'file', (store) => {
            if (name === changedName) store.backlog.write(repo, name, 'Changed after the copy.\n');
            if (name === goneName) store.backlog.remove(repo, name, text);
          });
          return created;
        },
      },
    },
    { removeSource: true },
  );
  for (const start of ['kept backlog <file name withheld>', 'backlog <file name withheld> is already gone']) assert.ok(lines.some((line) => line.startsWith(start)), lines.join('\n'));
  for (const name of [changedName, goneName]) assert.ok(!lines.some((line) => line.includes(name)), lines.join('\n'));
});

for (const what of ['text', 'evidence'] as const) {
  test(`migrate --remove-source keeps an archive copy whose ${what} changed after the check, and names it`, { skip: noSqlite }, (t) => {
    const { h, archived } = populated(t, 'file');
    const lines: string[] = [];
    // Another command changes the source copy once migrate has checked it, just before the remove.
    const changeFirst = (store: LedgerStore): LedgerStore =>
      changed(store, {
        archive: {
          remove: (...args: Parameters<Archive['remove']>) => {
            const [repo, name] = args;
            if (what === 'text') writeFileSync(store.archive.location(repo, name), recordJson(parseRecord('Changed after the check.\n')));
            else writeFileSync(path.join(store.archive.evidenceLocation(repo, name), 'late.txt'), 'late\n');
            return store.archive.remove(...args);
          },
        },
      });
    const open = (paths: LedgerPaths, storage: Storage): LedgerStore => (storage === 'file' ? changeFirst(openStore(paths, storage)) : openStore(paths, storage));

    migrateStorage(ledgerPaths(h), 'sqlite', { removeSource: true, dryRun: false }, (line) => lines.push(line), open);

    assert.ok(
      lines.some((line) => line.includes(`kept archive ${keyOf(h, 'app')}/${archived}`)),
      lines.join('\n'),
    );
    const kept = withStore(h, 'file', (store) => ({ has: store.archive.has(keyOf(h, 'app'), archived), evidence: store.archive.evidenceFiles(keyOf(h, 'app'), archived) }));
    assert.ok(kept.has, 'the changed copy was removed');
    assert.ok(kept.evidence.includes('red.txt'), 'the evidence of the changed copy was removed');
  });
}
