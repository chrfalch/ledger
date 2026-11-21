import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FORMAT } from '../tools/ledger/clone.js';
import { Failure } from '../tools/ledger/failure.js';
import { fileStore } from '../tools/ledger/file-store.js';
import { gitStore } from '../tools/ledger/git-store.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { parseRecord, recordJson, storedText } from '../tools/ledger/record.js';
import { loadSqlite, sqliteFile, sqliteStore } from '../tools/ledger/sqlite-store.js';
import { git, home, ledger, ledgerText, noSqlite, ok } from './ledger-core-fixtures.js';

function openGit(h: string) {
  const clone = path.join(h, '.claude/ledger-data');
  git(h, h, 'init', '--quiet', clone);
  writeFileSync(path.join(clone, '.ledger-data'), `${JSON.stringify({ format: FORMAT })}\n`);
  return gitStore(ledgerPaths(h), { backgroundSync: false });
}

const stores = {
  file: (h: string) => fileStore(ledgerPaths(h)),
  sqlite: (h: string) => sqliteStore({ home: h }),
  git: openGit,
};

for (const [kind, open] of Object.entries(stores)) {
  const skip = kind === 'sqlite' && noSqlite;

  test(`${kind} active record lifecycle`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    const { active } = store;
    const repo = 'org/app';
    const slug = 'task';
    const source = ledgerText({ slug, worktree: h });
    assert.ok(active.create(repo, slug, source));
    assert.equal(active.create(repo, slug, 'collision'), false);
    assert.deepEqual(active.repos(), [repo]);
    assert.equal(active.read(repo, slug)?.text, storedText(source));
    assert.deepEqual(active.list(repo), [active.read(repo, slug)]);
    if (kind !== 'sqlite') {
      const root = kind === 'file' ? 'ledger-active' : 'ledger-data/active';
      const file = path.join(h, '.claude', root, 'org%2Fapp/task.json');
      assert.equal(active.location(repo, slug), file);
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).worktree, h);
    }
    assert.equal(store.backlog.has(repo, slug), false);
    assert.ok(active.update(repo, slug, (text) => text.replace('Goal of task.', 'Updated.')));
    const updated = active.read(repo, slug)!.text;
    assert.match(updated, /Updated\./);
    assert.ok(active.canMove(repo, slug, 'other'));
    active.write('other', slug, source);
    assert.equal(active.canMove(repo, slug, 'other'), false);
    assert.equal(active.move(repo, slug, 'other'), false);
    assert.ok(active.remove('other', slug, storedText(source)));
    assert.ok(active.move(repo, slug, 'other'));
    assert.equal(active.read(repo, slug), undefined);
    assert.equal(active.remove('other', slug, storedText(source)), false);
    assert.ok(active.remove('other', slug, updated));
    assert.deepEqual(active.list('other'), []);
    store.close?.();
  });

  test(`${kind} active worktree lookup`, { skip }, (t) => {
    const h = home(t);
    const store = open(h);
    const { active } = store;
    const link = path.join(h, 'alias');
    symlinkSync(h, link);
    const missing = path.join(h, 'absent');
    const put = (repo: string, slug: string, worktree: string) => active.write(repo, slug, ledgerText({ slug, worktree }));
    put('app', 'first', link);
    assert.deepEqual(active.byWorktree(h), { repo: 'app', slug: 'first' });
    assert.deepEqual(active.byWorktree(link), { repo: 'app', slug: 'first' });
    assert.equal(active.byWorktree(missing), undefined);
    put('lib', 'remote', missing);
    assert.deepEqual(active.byWorktree(missing), { repo: 'lib', slug: 'remote' });
    assert.equal(active.byWorktree(missing + '/'), undefined);
    put('lib', 'second', h);
    assert.throws(() => active.byWorktree(h), (e) => e instanceof Failure && ['app', 'first', 'lib', 'second'].every((s) => e.message.includes(s)));
    store.close?.();
  });
}

test('file active ignores legacy Markdown throughout a record lifecycle', (t) => {
  const { active } = stores.file(home(t));
  const dir = active.repoLocation('app');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'task.md');
  writeFileSync(file, 'legacy');
  assert.deepEqual(active.list('app'), []);
  assert.equal(active.has('app', 'task'), false);
  assert.deepEqual(active.markdownNames?.('app') ?? [], []);
  assert.equal(active.markdownText?.('app', 'task'), undefined);
  assert.equal(active.toRecord?.('app', 'task') ?? false, false);
  active.write('app', 'task', 'current');
  assert.deepEqual(active.hiddenMarkdown?.('app') ?? [], []);
  assert.ok(active.move('app', 'task', 'lib'));
  assert.ok(active.create('app', 'task', 'new'));
  assert.ok(active.remove('app', 'task', storedText('new')));
  assert.equal(readFileSync(file, 'utf8'), 'legacy');
});

test('git commits and verifies active record text', (t) => {
  const h = home(t);
  const store = openGit(h);
  const clone = path.join(h, '.claude/ledger-data');
  const name = 'live';
  const repo = 'app';
  const text = ledgerText({ slug: name, worktree: h });
  store.active.write(repo, name, text);
  store.commit?.([{ place: 'active', repo, name, text }]);
  assert.equal(JSON.parse(git(h, clone, 'show', 'HEAD:active/app/live.json')).worktree, h);
  assert.throws(() => store.commit?.([{ place: 'active', repo, name, text: 'different' }]), /not committed as it was written/);
  store.close?.();
});

test('sqlite upgrades the old records CHECK and indexes active worktrees', { skip: noSqlite }, (t) => {
  const h = home(t);
  const { DatabaseSync } = loadSqlite()!;
  const db = new DatabaseSync(sqliteFile(h));
  db.exec(`CREATE TABLE records (
    place TEXT NOT NULL CHECK (place IN ('backlog', 'archive')), repo TEXT NOT NULL, name TEXT NOT NULL,
    record TEXT NOT NULL, mtime REAL NOT NULL, birthtime REAL NOT NULL,
    parent TEXT GENERATED ALWAYS AS (json_extract(record, '$.parent.slug')) VIRTUAL,
    state TEXT GENERATED ALWAYS AS (json_extract(record, '$.state')) VIRTUAL, PRIMARY KEY (place, repo, name)
  ) STRICT`);
  const text = ledgerText({ slug: 'before', worktree: h });
  db.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?, ?)').run('backlog', 'app', 'before', recordJson(parseRecord(text)), 1234, 1000);
  db.close();
  const store = stores.sqlite(h);
  const old = store.backlog.read('app', 'before')!;
  assert.deepEqual([old.text, old.mtimeMs, old.birthtimeMs], [storedText(text), 1234, 1000]);
  store.active.write('app', 'now', text);
  store.close?.();
  const checked = new DatabaseSync(sqliteFile(h));
  try {
    assert.equal(checked.prepare("SELECT worktree FROM records WHERE place = 'active'").get()?.worktree, h);
    const plan = checked.prepare("EXPLAIN QUERY PLAN SELECT name FROM records WHERE place = 'active' AND worktree = ?").all(h);
    assert.match(plan.map((row) => row.detail).join('\n'), /place=\? AND worktree=\?/);
    assert.throws(() => checked.prepare("INSERT INTO ledgers VALUES ('active', 'app', 'old', x'00', 1, 1)").run(), /CHECK constraint/);
  } finally {
    checked.close();
  }
});

test('storage switch previews, checks conflicts and round-trips active records', { skip: noSqlite }, (t) => {
  const h = home(t);
  const text = ledgerText({ slug: 'live', worktree: h });
  const { active } = stores.file(h);
  active.write('app', 'live', text);
  const run = (to: string, ...args: string[]) => ledger(h, h, 'store', 'migrate', '--to', to, ...args);
  const dry = ok(run('sqlite', '--dry-run'));
  assert.match(dry, /1 active ledger\b/);
  assert.equal(existsSync(sqliteFile(h)), false);
  const sqlite = stores.sqlite(h);
  sqlite.active.write('app', 'live', text);
  const conflict = run('sqlite', '--remove-source');
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /active app\/live/);
  assert.ok(sqlite.active.remove('app', 'live', storedText(text)));
  assert.match(ok(run('sqlite', '--remove-source')), /copied 1 active ledger\b/i);
  assert.equal(sqlite.active.read('app', 'live')?.text, storedText(text));
  assert.equal(active.has('app', 'live'), false);
  assert.match(ok(run('file', '--remove-source')), /copied 1 active ledger\b/i);
  assert.equal(active.read('app', 'live')?.text, storedText(text));
  assert.equal(sqlite.active.has('app', 'live'), false);
  sqlite.close?.();
});
