import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { FORMAT } from '../tools/ledger/clone.js';
import { fileStore } from '../tools/ledger/file-store.js';
import { limitLockWaits } from '../tools/ledger/lock.js';
import { migrateActive } from '../tools/ledger/migrate-active.js';
import { openStore } from '../tools/ledger/open-store.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { parseRecord, renderRecord } from '../tools/ledger/record.js';
import type { Storage } from '../tools/ledger/settings.js';
import type { LedgerStore } from '../tools/ledger/store.js';
import { REPO } from './helpers.js';
import { asCli, git, home, ledger, ledgerText, lineWith, noSqlite, ok, repoKeyOf, repository, THIS_HOST, touch, worktreeOf } from './ledger-core-fixtures.js';

const ODD = '## Odd\nan odd line\n';

/** A HOME with `storage` set up and the repo ~/repos/app, whose origin is a local bare repo. */
function setup(t: TestContext, storage: Storage) {
  const h = home(t);
  if (storage !== 'file') writeFileSync(path.join(h, '.claude/ledger-settings.json'), JSON.stringify({ storage }));
  if (storage === 'git') {
    const clone = path.join(h, '.claude/ledger-data');
    git(h, h, 'init', '--quiet', clone);
    writeFileSync(path.join(clone, '.ledger-data'), `${JSON.stringify({ format: FORMAT })}\n`);
  }
  const paths = ledgerPaths(h);
  openStore(paths, storage, { backgroundSync: false }).close?.();
  const app = repository(h, path.join(h, 'repos/app'));
  /** Runs `read` on the store as it is now, opened read-only. */
  const read = <T>(work: (store: LedgerStore) => T): T => {
    const store = openStore(paths, storage, { backgroundSync: false, readOnly: true });
    try {
      return work(store);
    } finally {
      store.close?.();
    }
  };
  return { h, app, key: repoKeyOf(app), read };
}

/** A linked worktree <app>/.claude/worktrees/<slug> that keeps its ledger as .claude/ledger.md, with one evidence file. */
function legacyWorktree(h: string, app: string, slug: string, markdown = `${ledgerText({ slug })}${ODD}`) {
  const folder = worktreeOf(app, slug);
  git(h, app, 'worktree', 'add', '--quiet', '-b', `me/${slug}`, folder, 'main');
  mkdirSync(path.join(folder, '.claude/evidence'), { recursive: true });
  const file = path.join(folder, '.claude/ledger.md');
  writeFileSync(file, markdown);
  const evidence = path.join(folder, '.claude/evidence/red.txt');
  writeFileSync(evidence, 'the red run\n');
  return { folder, file, markdown, evidence };
}

const migrate = (h: string, cwd: string, ...args: string[]) => ledger(h, cwd, 'store', 'migrate', '--active', ...args);

for (const storage of ['file', 'sqlite', 'git'] as const) {
  const skip = storage === 'sqlite' && noSqlite;

  test(`${storage} store: migrate --active moves a worktree's .claude/ledger.md into an active record for that worktree, keeps its evidence, and a second run moves nothing`, { skip }, (t) => {
    const { h, app, key, read } = setup(t, storage);
    const { folder, file, markdown, evidence } = legacyWorktree(h, app, 'task');
    touch(file, '2026-10-01T12:00:00Z');

    const out = ok(migrate(h, app));

    assert.equal(lineWith(out, file), `moved ${file} to active app task: 1 line to general notes`);
    assert.match(out, /^Moved 1 ledger\.$/m);
    assert.equal(existsSync(file), false);
    assert.equal(readFileSync(evidence, 'utf8'), 'the red run\n');
    const stored = read((store) => ({ found: store.active.byWorktree(folder), ledger: store.active.read(key, 'task') }));
    assert.deepEqual(stored.found, { repo: key, slug: 'task' });
    const record = parseRecord(stored.ledger?.text ?? '');
    assert.equal(record.worktree, folder);
    assert.equal(record.slug, 'task');
    assert.equal(stored.ledger?.text, renderRecord({ ...parseRecord(markdown), worktree: folder, host: THIS_HOST }));
    assert.match(stored.ledger?.text ?? '', /## Decisions\n- Keep the old format/);
    assert.match(stored.ledger?.text ?? '', /## Next step\nNext step of task\./);
    assert.equal(stored.ledger?.mtimeMs, Date.parse('2026-10-01T12:00:00Z'));

    const again = ok(migrate(h, app));
    assert.doesNotMatch(again, /moved /);
    assert.match(again, /^Moved 0 ledgers\.$/m);
    assert.equal(read((store) => store.active.read(key, 'task')?.text), stored.ledger?.text);
  });

  test(`${storage} store: migrate --active --dry-run names each ledger it would move and changes nothing`, { skip }, (t) => {
    const { h, app, key, read } = setup(t, storage);
    const { file, markdown } = legacyWorktree(h, app, 'task');
    const before = statSync(file).mtimeMs;

    const out = ok(migrate(h, app, '--dry-run'));

    assert.match(out, /dry run, nothing changed/);
    assert.equal(lineWith(out, file), `would move ${file} to active app task: 1 line to general notes`);
    assert.match(out, /^Would move 1 ledger\.$/m);
    assert.equal(readFileSync(file, 'utf8'), markdown);
    assert.equal(statSync(file).mtimeMs, before);
    assert.deepEqual(read((store) => store.active.list(key)), []);
  });

  test(`${storage} store: migrate --active leaves a ledger whose slug or worktree is taken, names why, and exits 1, also in a dry run`, { skip }, (t) => {
    const { h, app, key, read } = setup(t, storage);
    const sameSlug = legacyWorktree(h, app, 'same-slug');
    const sameWorktree = legacyWorktree(h, app, 'same-worktree');
    const inBacklog = legacyWorktree(h, app, 'in-backlog');
    const clean = legacyWorktree(h, app, 'clean');
    const store = openStore(ledgerPaths(h), storage, { backgroundSync: false });
    store.active.write(key, 'same-slug', ledgerText({ slug: 'same-slug', worktree: path.join(h, 'elsewhere') }));
    store.active.write(key, 'other', ledgerText({ slug: 'other', worktree: sameWorktree.folder }));
    store.backlog.write(key, 'in-backlog', ledgerText({ slug: 'in-backlog', main: app }));
    store.close?.();

    for (const args of [['--dry-run'], []]) {
      const ran = migrate(h, app, ...args);
      assert.equal(ran.status, 1, `${args.join(' ')}\n${ran.stdout}\n${ran.stderr}`);
      assert.match(lineWith(ran.stdout, sameSlug.file), /^left .*: the active task same-slug exists already/);
      assert.match(lineWith(ran.stdout, sameWorktree.file), /^left .*: the active task other names this worktree already/);
      assert.match(lineWith(ran.stdout, inBacklog.file), /^left .*: a backlog task in-backlog exists already/);
      assert.match(ran.stdout, /^Left 3 ledgers in \.claude\/ledger\.md; nothing of them changed\.$/m);
    }
    for (const left of [sameSlug, sameWorktree, inBacklog]) assert.equal(readFileSync(left.file, 'utf8'), left.markdown);
    assert.equal(existsSync(clean.file), false);
    assert.deepEqual(read((store) => store.active.byWorktree(clean.folder)), { repo: key, slug: 'clean' });
    assert.equal(read((store) => store.active.byWorktree(sameSlug.folder)), undefined);
  });

  test(`${storage} store: migrate --active turns the parked marker under Next step into the record's parked field`, { skip }, (t) => {
    const { h, app, key, read } = setup(t, storage);
    legacyWorktree(h, app, 'resting', ledgerText({ slug: 'resting', next: 'Parked: 2026-11-01 — waiting on review.\nResume at step 2.' }));

    ok(migrate(h, app));

    const record = parseRecord(read((store) => store.active.read(key, 'resting')?.text) ?? '');
    assert.deepEqual(record.parked, { date: '2026-11-01', reason: 'waiting on review.' });
    assert.equal(record.next, 'Resume at step 2.');
  });
}

test('migrate --active finds the worktrees of every main checkout the registry names, and a ledger a registry entry names, from outside any repo', (t) => {
  const { h, app, key, read } = setup(t, 'file');
  const listed = legacyWorktree(h, app, 'listed');
  const lib = repository(h, path.join(h, 'repos/lib'));
  const named = legacyWorktree(h, lib, 'named');
  const entry = (fields: Record<string, string>) => ({ repo: 'x', branch: '', status: 'active', created: '2026-10-01T00:00:00.000Z', updated: '2026-10-01T00:00:00.000Z', ...fields });
  writeFileSync(path.join(h, '.claude/ledgers.json'), JSON.stringify([entry({ slug: 'gone', path: '/nowhere/x.json', main: app }), entry({ slug: 'named', path: named.file })]));

  const out = ok(migrate(h, h));

  assert.match(lineWith(out, listed.file), /^moved /);
  assert.match(lineWith(out, named.file), /^moved .* to active lib named:/);
  assert.match(out, /^Moved 2 ledgers\.$/m);
  assert.deepEqual(read((store) => store.active.byWorktree(listed.folder)), { repo: key, slug: 'listed' });
  assert.deepEqual(read((store) => store.active.byWorktree(named.folder)), { repo: repoKeyOf(lib), slug: 'named' });
});

test('a registry rebuild from another repo keeps the entry of an unmoved .claude/ledger.md, so migrate --active from there moves it, and the next rebuild drops it', (t) => {
  const { h, app, key, read } = setup(t, 'file');
  const unmoved = legacyWorktree(h, app, 'unmoved');
  const lib = repository(h, path.join(h, 'repos/lib'));
  const registry = path.join(h, '.claude/ledgers.json');
  const entry = { repo: key, slug: 'unmoved', path: unmoved.file, branch: 'me/unmoved', status: 'active', main: app, created: '2026-10-01T00:00:00.000Z', updated: '2026-10-01T00:00:00.000Z' };
  writeFileSync(registry, JSON.stringify([entry]));
  const paths = (): string[] => (JSON.parse(readFileSync(registry, 'utf8')) as { path: string }[]).map(({ path }) => path);

  ok(ledger(h, lib, 'list'));
  assert.deepEqual(paths(), [unmoved.file]);

  assert.match(lineWith(ok(migrate(h, lib)), unmoved.file), /^moved .* to active app unmoved:/);
  assert.deepEqual(read((store) => store.active.byWorktree(unmoved.folder)), { repo: key, slug: 'unmoved' });

  ok(ledger(h, lib, 'list'));
  assert.equal(paths().includes(unmoved.file), false);
});

test("a registry rebuild drops the entry of a main checkout's own .claude/ledger.md, which migrate --active never moves", (t) => {
  const { h, app, key } = setup(t, 'file');
  const own = path.join(app, '.claude/ledger.md');
  mkdirSync(path.dirname(own), { recursive: true });
  writeFileSync(own, ledgerText({ slug: 'own' }));
  const registry = path.join(h, '.claude/ledgers.json');
  writeFileSync(registry, JSON.stringify([{ repo: key, slug: 'own', path: own, branch: 'main', status: 'active', main: app, created: '2026-10-01T00:00:00.000Z', updated: '2026-10-01T00:00:00.000Z' }]));

  ok(ledger(h, app, 'list'));

  assert.deepEqual(JSON.parse(readFileSync(registry, 'utf8')), []);
});

test('migrate --active leaves a ledger whose heading names no slug', (t) => {
  const { h, app } = setup(t, 'file');
  const { file } = legacyWorktree(h, app, 'nameless', '## Goal\nA goal.\n');

  const ran = migrate(h, app);

  assert.equal(ran.status, 1, ran.stderr);
  assert.match(lineWith(ran.stdout, file), /^left .*: its heading names no task slug/);
  assert.equal(existsSync(file), true);
});

test('migrate --active takes no --to, --from, --repo-ids, --records or --remove-source', (t) => {
  const h = home(t);
  for (const other of [['--to', 'sqlite'], ['--from', 'file'], ['--repo-ids'], ['--records'], ['--remove-source']]) {
    const ran = migrate(h, h, ...other);
    assert.notEqual(ran.status, 0, other.join(' '));
    assert.match(ran.stderr, /cannot be used with/);
  }
});

test('ledger store migrate --help shows the --active example', (t) => {
  assert.match(ok(ledger(home(t), REPO, 'store', 'migrate', '--help')), /ledger store migrate --active --dry-run +\S/);
});

/** Runs migrateActive in this process on the file store of `h`, changed by `change`; gives its lines and how many it left. */
function migrateWith(t: TestContext, h: string, cwd: string, change: (store: LedgerStore) => LedgerStore) {
  asCli(t, h);
  const lines: string[] = [];
  const left = migrateActive(change(fileStore(ledgerPaths(h))), { dryRun: false, cwd, home: h }, (text) => lines.push(text));
  return { left, out: lines.join('\n') };
}

test('migrate --active keeps a .claude/ledger.md that changed after its record was written, and says so', (t) => {
  const { h, app, key, read } = setup(t, 'file');
  const { file } = legacyWorktree(h, app, 'task');
  const edited = `${readFileSync(file, 'utf8')}- An edit made while the move ran.\n`;

  const { left, out } = migrateWith(t, h, app, (store) => ({
    ...store,
    active: {
      ...store.active,
      create: (repo, slug, text) => {
        const created = store.active.create(repo, slug, text);
        writeFileSync(file, edited);
        return created;
      },
    },
  }));

  assert.equal(left, 1, out);
  assert.match(lineWith(out, file), /^left /);
  assert.equal(readFileSync(file, 'utf8'), edited);
  assert.ok(read((store) => store.active.has(key, 'task')));
});

test('migrate --active keeps a .claude/ledger.md whose lock a writer holds after its record is committed, and says so', (t) => {
  const { h, app, key, read } = setup(t, 'file');
  const { file, markdown } = legacyWorktree(h, app, 'task');
  // As an older ledger holds it from its read to its write of the file.
  const heldByWriter = (): void => writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
  limitLockWaits(Date.now() + 2_000);
  t.after(() => limitLockWaits(Infinity));

  const { left, out } = migrateWith(t, h, app, (store) => ({
    ...store,
    commit: () => heldByWriter(),
  }));

  assert.equal(left, 1, out);
  assert.match(lineWith(out, file), /^left .*lock/);
  assert.equal(readFileSync(file, 'utf8'), markdown);
  assert.ok(read((store) => store.active.has(key, 'task')));
});

test('migrate --active keeps a .claude/ledger.md whose record the store could not commit, and says so', (t) => {
  const { h, app, key, read } = setup(t, 'file');
  const { file, markdown } = legacyWorktree(h, app, 'task');

  const { left, out } = migrateWith(t, h, app, (store) => ({
    ...store,
    commit: () => {
      throw new Error('the commit failed in the test');
    },
  }));

  assert.equal(left, 1, out);
  assert.match(lineWith(out, file), /^left .*the commit failed in the test/);
  assert.equal(readFileSync(file, 'utf8'), markdown);
  assert.ok(read((store) => store.active.has(key, 'task')));
});

for (const storage of ['file', 'git'] as const) {
  test(`${storage} store: a rerun of migrate --active after one that wrote the record but kept the file removes the file, and keeps the record`, (t) => {
    const { h, app, key, read } = setup(t, storage);
    const { folder, file, markdown } = legacyWorktree(h, app, 'task');
    const text = renderRecord({ ...parseRecord(markdown), worktree: folder, host: THIS_HOST });
    const store = openStore(ledgerPaths(h), storage, { backgroundSync: false });
    store.active.write(key, 'task', text);
    store.close?.();

    const out = ok(migrate(h, app));

    assert.match(lineWith(out, file), /^moved /);
    assert.equal(existsSync(file), false);
    assert.equal(read((s) => s.active.read(key, 'task')?.text), text);
  });
}

test('migrate --active --dry-run reports the second of two ledgers with one slug as left, as the real run leaves it', (t) => {
  const { h, app } = setup(t, 'file');
  const lib = repository(h, path.join(h, 'repos/lib'));
  git(h, app, 'remote', 'set-url', 'origin', path.join(h, 'remotes/shared.git'));
  git(h, lib, 'remote', 'set-url', 'origin', path.join(h, 'remotes/shared.git'));
  const first = legacyWorktree(h, app, 'fix');
  const second = legacyWorktree(h, lib, 'fix');
  const registry = (main: string) => ({ repo: 'x', slug: 'fix', branch: '', status: 'active', main, created: '2026-10-01T00:00:00.000Z', updated: '2026-10-01T00:00:00.000Z' });
  writeFileSync(path.join(h, '.claude/ledgers.json'), JSON.stringify([{ ...registry(app), path: first.file }, { ...registry(lib), path: second.file }]));

  const dry = migrate(h, h, '--dry-run');
  const real = migrate(h, h);

  for (const ran of [dry, real]) {
    assert.equal(ran.status, 1, ran.stdout);
    assert.match(ran.stdout, /^Left 1 ledger in \.claude\/ledger\.md/m);
  }
});

test('migrate --active leaves, and reports, a .claude/ledger.md a registry entry names in a folder that is no linked worktree', (t) => {
  const { h, app, key, read } = setup(t, 'file');
  const folder = worktreeOf(app, 'pruned');
  mkdirSync(path.join(folder, '.claude'), { recursive: true });
  const file = path.join(folder, '.claude/ledger.md');
  const markdown = ledgerText({ slug: 'pruned' });
  writeFileSync(file, markdown);
  writeFileSync(path.join(h, '.claude/ledgers.json'), JSON.stringify([{ repo: key, slug: 'pruned', path: file, branch: '', status: 'active', main: app, created: '2026-10-01T00:00:00.000Z', updated: '2026-10-01T00:00:00.000Z' }]));

  const ran = migrate(h, h);

  assert.equal(ran.status, 1, ran.stdout);
  assert.match(lineWith(ran.stdout, file), /^left .*no linked git worktree/);
  assert.equal(readFileSync(file, 'utf8'), markdown);
  assert.equal(read((store) => store.active.has(key, 'pruned')), false);
});
