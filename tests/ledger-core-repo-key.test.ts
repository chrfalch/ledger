import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Failure } from '../tools/ledger/failure.js';
import { fileStore } from '../tools/ledger/file-store.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { storedText } from '../tools/ledger/record.js';
import { remoteKey, repoKey, repoLabel } from '../tools/ledger/repo-key.js';
import { shownLedger } from '../tools/ledger/show.js';
import { sqliteStore } from '../tools/ledger/sqlite-store.js';
import type { LedgerStore } from '../tools/ledger/store.js';
import { archivedTasks, inRepo } from '../tools/ledger/tasks.js';
import { REPO } from './helpers.js';
import { asCli, commandEnv, git, home, LEDGER_BIN, ledger, ledgerText, lineWith, noSqlite, ok, repository, worktreeOf, worktreeTask, type Ran } from './ledger-core-fixtures.js';

type Storage = 'file' | 'sqlite';

const openStore = (h: string, storage: Storage): LedgerStore => (storage === 'sqlite' ? sqliteStore({ home: h }) : fileStore(ledgerPaths(h)));

/** A main checkout with one commit and the remotes `remotes`, by name and address; nothing is pushed. */
function repoWithRemotes(h: string, main: string, remotes: Record<string, string>): string {
  mkdirSync(main, { recursive: true });
  git(h, main, 'init', '--quiet', '-b', 'main');
  git(h, main, 'commit', '--quiet', '--allow-empty', '-m', 'first');
  for (const [name, url] of Object.entries(remotes)) git(h, main, 'remote', 'add', name, url);
  return main;
}

// --- The key of a remote address ---

const SAME_REPO = [
  'git@github.com:chrfalch/ledger.git',
  'https://github.com/chrfalch/ledger',
  'ssh://git@GitHub.com/chrfalch/ledger.git',
  'https://user:secret@github.com/chrfalch/ledger.git/',
  'git://github.com/chrfalch/ledger.git',
  'http://github.com/chrfalch/ledger/',
  'ssh://git@github.com:22/chrfalch/ledger.git',
  'GitHub.COM:chrfalch/ledger.git',
  'https://GitHub.com/ChrFalch/Ledger.GIT',
];

for (const url of SAME_REPO) {
  test(`the remote ${url} is the repo github.com/chrfalch/ledger`, () => {
    assert.equal(remoteKey(url, '/home/me/repos/ledger'), 'github.com/chrfalch/ledger');
  });
}

const KEYS: [url: string, key: string][] = [
  ['git@GitLab.example.com:Team/Sub/App.git', 'gitlab.example.com/team/sub/app'],
  ['[::1]:team/app.git', '[::1]/team/app'],
  ['git@[::1]:team/app.git', '[::1]/team/app'],
  ['ssh://git@[::1]:2222/team/app.git', '[::1]:2222/team/app'],
  ['ssh://git@[::1]:22/team/app.git', '[::1]/team/app'],
  ['ssh://git@host.example:2222/team/app.git', 'host.example:2222/team/app'],
  ['https://host.example:8443/team/app.git', 'host.example:8443/team/app'],
  ['https://host.example:443/team/app.git', 'host.example/team/app'],
  ['host.example:/srv/git/app.git', 'host.example/srv/git/app'],
  ['/srv/git/app.git', '/srv/git/app'],
  ['/srv/git/app/', '/srv/git/app'],
  ['/Srv/Git/App.git', '/Srv/Git/App'],
  ['file:///srv/git/app.git', '/srv/git/app'],
  ['../remotes/app.git', '/home/me/repos/remotes/app'],
  ['./app.git', '/home/me/repos/app/app'],
];

const NO_KEY = [
  'https://host.example/',
  'https://host.example',
  '/',
  'file://otherhost/srv/app.git',
  'https://host.example/../app',
  'https:///team/app',
  'https://:443/team/app',
  'ssh://git@/team/app.git',
  'https://host.example:https/team/app',
  'ssh://git@[::1]:ssh/team/app.git',
  'https://[]/team/app',
  'git@:team/app',
  ':team/app',
];

for (const url of NO_KEY) {
  test(`the remote ${url} gives no key, so the main checkout's path stands in`, () => {
    assert.equal(remoteKey(url, '/home/me/repos/app'), undefined);
  });
}

test("a repo whose origin gives no key has its main checkout's path as its key", (t) => {
  const h = home(t);
  asCli(t, h);
  const main = repoWithRemotes(h, path.join(h, 'repos/odd'), { origin: 'file://otherhost/srv/odd.git' });
  assert.equal(repoKey(main), main);
});

for (const [url, key] of KEYS) {
  test(`the remote ${url} is the repo ${key}`, () => {
    assert.equal(remoteKey(url, '/home/me/repos/app'), key);
  });
}

// --- The key of a repo ---

test("a repo's key is its origin's address, even with other remotes", (t) => {
  const h = home(t);
  asCli(t, h);
  const main = repoWithRemotes(h, path.join(h, 'repos/ledger'), { upstream: 'https://github.com/someone/ledger.git', origin: 'git@github.com:chrfalch/ledger.git' });
  assert.equal(repoKey(main), 'github.com/chrfalch/ledger');
});

test("a partial clone's key is its origin's address, though git lists the filter after the fetch address", (t) => {
  const h = home(t);
  asCli(t, h);
  const main = repoWithRemotes(h, path.join(h, 'repos/ledger'), { fork: 'https://github.com/someone/ledger.git', origin: 'git@github.com:chrfalch/ledger.git' });
  git(h, main, 'config', 'remote.origin.promisor', 'true');
  git(h, main, 'config', 'remote.origin.partialclonefilter', 'blob:none');
  assert.equal(repoKey(main), 'github.com/chrfalch/ledger');
});

test("a repo without origin and with one remote has that remote's address as its key", (t) => {
  const h = home(t);
  asCli(t, h);
  const main = repoWithRemotes(h, path.join(h, 'repos/fork'), { mine: 'https://gitlab.com/me/fork.git' });
  assert.equal(repoKey(main), 'gitlab.com/me/fork');
});

test('a repo without origin and with two remotes has its main checkout path as its key', (t) => {
  const h = home(t);
  asCli(t, h);
  const main = repoWithRemotes(h, path.join(h, 'repos/two'), { a: 'https://gitlab.com/me/a.git', b: 'https://gitlab.com/me/b.git' });
  assert.equal(repoKey(main), main);
});

test('a repo without remotes has its main checkout path as its key', (t) => {
  const h = home(t);
  asCli(t, h);
  const main = repoWithRemotes(h, path.join(h, 'repos/local'), {});
  assert.equal(repoKey(main), main);
});

test("a repo whose origin is a local bare repo has that repo's path, without .git, as its key", (t) => {
  const h = home(t);
  asCli(t, h);
  const main = repository(h, path.join(h, 'repos/app'));
  assert.equal(repoKey(main), path.join(h, 'remotes/app'));
});

test('ledger task new in a linked worktree files the backlog ledger under the key of the repo, not of the worktree folder', (t) => {
  const h = home(t);
  copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
  const main = repoWithRemotes(h, path.join(h, 'repos/app'), { origin: 'git@github.com:me/app.git' });
  const worktree = (worktreeTask(h, main, { slug: 'epic' }), worktreeOf(main, 'epic'));
  ok(ledger(h, worktree, 'task', 'new', 'idea', '--goal', 'An idea.'));
  assert.ok(existsSync(path.join(h, '.claude/ledger-backlog/github.com%2Fme%2Fapp/idea.json')));
});

// --- The short label people see ---

const LABELS: [key: string, label: string][] = [
  ['github.com/chrfalch/ledger', 'chrfalch/ledger'],
  ['gitlab.example.com/team/sub/app', 'team/sub/app'],
  ['host.example:8443/team/app', 'team/app'],
  ['/Users/me/repos/app', 'app'],
  ['app', 'app'],
];

for (const [key, label] of LABELS) {
  test(`the repo ${key} is shown as ${label}`, () => {
    assert.equal(repoLabel(key), label);
  });
}

test('ledger list shows the short label in the repo column and the parent cell, and the full key in its JSON', (t) => {
  const h = home(t);
  const app = repoWithRemotes(h, path.join(h, 'repos/app'), { origin: 'git@github.com:me/app.git' });
  const lib = repoWithRemotes(h, path.join(h, 'repos/lib'), { origin: 'https://gitlab.com/team/lib.git' });
  const store = fileStore(ledgerPaths(h));
  store.backlog.write('github.com/me/app', 'epic', ledgerText({ slug: 'epic', main: app }));
  store.backlog.write('gitlab.com/team/lib', 'part', ledgerText({ slug: 'part', main: lib, parent: `epic @ ${app}` }));
  const text = ok(ledger(h, app, 'list'));
  assert.match(lineWith(text, 'epic  '), /^me\/app\s+epic\s+backlog/);
  assert.match(lineWith(text, ' part '), /^team\/lib\s+↳ part\s+backlog\s+epic \(me\/app\)/);
  const { tasks } = JSON.parse(ok(ledger(h, app, 'list', '--json'))) as { tasks: { slug: string; repo: string }[] };
  assert.deepEqual(tasks.map(({ slug, repo }) => [slug, repo]).sort(), [
    ['epic', 'github.com/me/app'],
    ['part', 'gitlab.com/team/lib'],
  ]);
});

test('ledger task archive --all shows the short label in its repo column', (t) => {
  const h = home(t);
  const store = fileStore(ledgerPaths(h));
  store.archive.write('github.com/me/app', '2026-11-01-old', ledgerText({ slug: 'old' }));
  assert.match(lineWith(ok(ledger(h, h, 'task', 'archive', '--all')), 'old'), /^2026-11-01\s+me\/app\s+old/);
});

// --- The file store's folders ---

test('the file store keeps a repo in one folder named by the URI-encoded key, and repos() gives the key back', (t) => {
  const h = home(t);
  const store = fileStore(ledgerPaths(h));
  store.backlog.write('github.com/chrfalch/ledger', 'fix-login', ledgerText({ slug: 'fix-login' }));
  store.backlog.write('/Users/me/repos/app', 'idea', ledgerText({ slug: 'idea' }));
  store.archive.write('github.com/chrfalch/ledger', '2026-11-01-old', ledgerText({ slug: 'old' }));
  assert.deepEqual(readdirSync(path.join(h, '.claude/ledger-backlog')).sort(), ['%2FUsers%2Fme%2Frepos%2Fapp', 'github.com%2Fchrfalch%2Fledger']);
  assert.deepEqual(readdirSync(path.join(h, '.claude/ledger-archive')), ['github.com%2Fchrfalch%2Fledger']);
  assert.deepEqual(store.backlog.repos(), ['/Users/me/repos/app', 'github.com/chrfalch/ledger']);
  assert.deepEqual(store.archive.repos(), ['github.com/chrfalch/ledger']);
  assert.equal(store.backlog.list('github.com/chrfalch/ledger')[0]?.name, 'fix-login');
  assert.equal(store.backlog.location('github.com/chrfalch/ledger', 'x'), path.join(h, '.claude/ledger-backlog/github.com%2Fchrfalch%2Fledger/x.json'));
});

test('the file store still reads a folder named after an old folder-name key, also one with characters an encoding would change', (t) => {
  const h = home(t);
  for (const folder of ['app', 'kode-ø', 'my app']) {
    mkdirSync(path.join(h, '.claude/ledger-backlog', folder), { recursive: true });
    writeFileSync(path.join(h, '.claude/ledger-backlog', folder, 'idea.md'), ledgerText({ slug: 'idea' }));
  }
  const store = fileStore(ledgerPaths(h));
  assert.deepEqual(store.backlog.repos(), ['app', 'kode-ø', 'my app']);
  for (const repo of store.backlog.repos()) assert.equal(store.backlog.read(repo, 'idea')?.name, 'idea', repo);
});

// --- Moving a ledger to another repo key, and aliases, in each store ---

for (const storage of ['file', 'sqlite'] as const) {
  const skip = storage === 'sqlite' && noSqlite;

  test(`${storage} store: a backlog ledger moves to another repo key with its text and times, and not onto a name taken there`, { skip }, (t) => {
    const h = home(t);
    const store = openStore(h, storage);
    t.after(() => store.close?.());
    store.backlog.write('app', 'fix-login', 'old text');
    store.backlog.setModified?.('app', 'fix-login', Date.parse('2026-01-01T00:00:00Z'));
    const before = store.backlog.read('app', 'fix-login') ?? assert.fail('not written');
    assert.equal(store.backlog.move('app', 'fix-login', 'github.com/me/app'), true);
    assert.equal(store.backlog.has('app', 'fix-login'), false);
    const after = store.backlog.read('github.com/me/app', 'fix-login') ?? assert.fail('not moved');
    assert.deepEqual([after.text, after.mtimeMs], [before.text, before.mtimeMs]);
    store.backlog.write('app', 'fix-login', 'other text');
    assert.equal(store.backlog.move('app', 'fix-login', 'github.com/me/app'), false);
    assert.equal(store.backlog.read('app', 'fix-login')?.text, storedText('other text'));
    assert.equal(store.backlog.read('github.com/me/app', 'fix-login')?.text, storedText('old text'));
  });

  test(`${storage} store: an archive copy moves to another repo key with its evidence, and not onto a name taken there`, { skip }, (t) => {
    const h = home(t);
    const store = openStore(h, storage);
    t.after(() => store.close?.());
    const evidence = path.join(h, 'evidence');
    mkdirSync(path.join(evidence, 'logs'), { recursive: true });
    writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
    writeFileSync(path.join(evidence, 'logs/build.log'), 'built\n');
    store.archive.write('app', '2026-11-01-old', 'old text', evidence);
    assert.equal(store.archive.move('app', '2026-11-01-old', 'github.com/me/app'), true);
    assert.equal(store.archive.has('app', '2026-11-01-old'), false);
    assert.deepEqual(store.archive.evidenceFiles('app', '2026-11-01-old'), []);
    assert.equal(store.archive.read('github.com/me/app', '2026-11-01-old')?.text, storedText('old text'));
    assert.deepEqual(store.archive.evidenceFiles('github.com/me/app', '2026-11-01-old'), ['logs/build.log', 'red.txt']);
    assert.equal(store.archive.evidenceState('github.com/me/app', '2026-11-01-old', evidence), 'same');
    store.archive.write('app', '2026-11-01-old', 'other text');
    assert.equal(store.archive.move('app', '2026-11-01-old', 'github.com/me/app'), false);
    assert.equal(store.archive.read('app', '2026-11-01-old')?.text, storedText('other text'));
  });

  test(`${storage} store: aliases are none at first, and an added alias reads back after the store is opened again`, { skip }, (t) => {
    const h = home(t);
    const first = openStore(h, storage);
    assert.deepEqual([...first.aliases.read()], []);
    first.aliases.add('app', 'github.com/me/app');
    first.aliases.add('lib', '/Users/me/lib');
    first.close?.();
    const second = openStore(h, storage);
    t.after(() => second.close?.());
    assert.deepEqual([...second.aliases.read()].sort(), [
      ['app', 'github.com/me/app'],
      ['lib', '/Users/me/lib'],
    ]);
  });
}

test('an archive copy that names no main, under an alias of the repo, is in that repo', (t) => {
  const h = home(t);
  asCli(t, h);
  const app = repository(h, path.join(h, 'repos/app'));
  const store = fileStore(ledgerPaths(h));
  store.archive.write('app', '2026-11-01-old', ledgerText({ slug: 'old' }));
  const [copy] = archivedTasks(store);
  assert.equal(inRepo(copy, app), false);
  store.aliases.add('app', path.join(h, 'remotes/app'));
  assert.equal(inRepo(archivedTasks(store)[0], app), true);
});

// --- ledger show --repo ---

function showWorld(t: TestContext) {
  const h = home(t);
  const store = fileStore(ledgerPaths(h));
  store.backlog.write('github.com/me/app', 'idea', 'idea in github\n');
  store.backlog.write('gitlab.com/me/app', 'idea', 'idea in gitlab\n');
  store.backlog.write('/Users/me/repos/tool', 'idea', 'idea in tool\n');
  store.aliases.add('old-app', 'github.com/me/app');
  const show = (repo: string) => shownLedger({ paths: ledgerPaths(h), cwd: h, store }, 'idea', { repo }).text;
  return { show };
}

test('ledger show --repo takes the full key of a repo', (t) => {
  const { show } = showWorld(t);
  assert.equal(show('gitlab.com/me/app'), storedText('idea in gitlab\n'));
  assert.equal(show('/Users/me/repos/tool'), storedText('idea in tool\n'));
});

test('ledger show --repo takes an alias of a repo', (t) => {
  const { show } = showWorld(t);
  assert.equal(show('old-app'), storedText('idea in github\n'));
});

test('ledger show --repo takes the short label of a repo when one repo has it', (t) => {
  const { show } = showWorld(t);
  assert.equal(show('tool'), storedText('idea in tool\n'));
});

test('ledger show --repo with a short label two repos share fails and names both keys', (t) => {
  const { show } = showWorld(t);
  assert.throws(
    () => show('me/app'),
    (error: unknown) => error instanceof Failure && error.message.includes('github.com/me/app') && error.message.includes('gitlab.com/me/app'),
  );
});

test('ledger show --repo refuses a repo that climbs out with ..', (t) => {
  const { show } = showWorld(t);
  for (const repo of ['..', '../ledger-archive', 'github.com/../x']) {
    assert.throws(() => show(repo), (error: unknown) => error instanceof Failure && error.message.includes('..'), repo);
  }
});

test('the error of ledger show names the repo by its short label', (t) => {
  const h = home(t);
  const app = repoWithRemotes(h, path.join(h, 'repos/app'), { origin: 'git@github.com:me/app.git' });
  const ran = ledger(h, app, 'show', 'nothing');
  assert.equal(ran.status, 1);
  assert.equal(ran.stderr.trim(), 'No ledger named nothing is in the active tasks, the backlog or the archive of the repo me/app.');
});

// --- ledger store migrate --repo-ids ---

/** The output of a conversion that left a ledger unconverted, which exits 1 with every step on stdout. */
function leftSome(ran: Ran): string {
  assert.equal(ran.status, 1, ran.stderr);
  return ran.stdout;
}

/** Every ledger, evidence file and alias of the store, to see that a run changed nothing. */
function snapshot(h: string, storage: Storage): string {
  const store = openStore(h, storage);
  try {
    const ledgers = (['backlog', 'archive'] as const).flatMap((place) =>
      store[place].repos().flatMap((repo) =>
        store[place].list(repo).map(({ name, text, mtimeMs }) => [place, repo, name, text, mtimeMs, place === 'archive' ? store.archive.evidenceFiles(repo, name) : []]),
      ),
    );
    const files = storage === 'file' ? treeOf(path.join(h, '.claude')) : [];
    return JSON.stringify({ ledgers, aliases: [...store.aliases.read()], files });
  } finally {
    store.close?.();
  }
}

const treeOf = (folder: string): string[] =>
  readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .sort()
    .map((file) => `${file} ${statSync(path.join(folder, file)).mtimeMs}`);

/**
 * A HOME whose store files ledgers under old folder-name keys: the repo app (origin a local bare repo) with a backlog
 * task, an archive copy with evidence whose worktree names the repo, an archive copy that names no repo, and a backlog
 * task whose slug the new key already has; a backlog task of a repo that is gone; an archive copy of a repo no record
 * names.
 */
function legacyWorld(t: TestContext, storage: Storage) {
  const h = home(t);
  if (storage === 'sqlite') writeFileSync(path.join(h, '.claude/ledger-settings.json'), JSON.stringify({ storage: 'sqlite' }));
  const app = repository(h, path.join(h, 'repos/app'));
  const key = path.join(h, 'remotes/app');
  const store = openStore(h, storage);
  const evidence = path.join(h, 'evidence');
  mkdirSync(evidence);
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  store.backlog.write('app', 'fix-login', ledgerText({ slug: 'fix-login', main: app }));
  store.archive.write('app', '2026-01-01-old', ledgerText({ slug: 'old', worktree: path.join(app, '.claude/worktrees/old') }), evidence);
  store.archive.write('app', '2026-01-02-bare', ledgerText({ slug: 'bare' }));
  store.backlog.write('app', 'dup', ledgerText({ slug: 'dup', main: app, goal: 'The old dup.' }));
  store.backlog.write(key, 'dup', ledgerText({ slug: 'dup', main: app, goal: 'The new dup.' }));
  store.backlog.write('gone', 'idea', ledgerText({ slug: 'idea', main: path.join(h, 'repos/gone') }));
  store.archive.write('lost', '2026-01-03-x', ledgerText({ slug: 'x' }));
  store.close?.();
  return { h, app, key };
}

for (const storage of ['file', 'sqlite'] as const) {
  const skip = storage === 'sqlite' && noSqlite;

  test(`${storage} store: store migrate --repo-ids --dry-run prints the planned moves and changes nothing`, { skip }, (t) => {
    const { h, app } = legacyWorld(t, storage);
    const before = snapshot(h, storage);
    const out = leftSome(ledger(h, app, 'store', 'migrate', '--repo-ids', '--dry-run'));
    assert.equal(snapshot(h, storage), before);
    assert.match(out, /dry run, nothing changed/);
    assert.match(lineWith(out, 'fix-login'), /would move/);
    assert.match(lineWith(out, '2026-01-01-old'), /would move/);
    assert.match(lineWith(out, '2026-01-02-bare'), /would move/);
    assert.match(lineWith(out, 'dup'), /already/);
    assert.match(lineWith(out, 'idea'), /left/);
    assert.match(lineWith(out, '2026-01-03-x'), /left/);
    assert.match(lineWith(out, 'alias'), /would record/);
  });

  test(`${storage} store: store migrate --repo-ids moves each ledger it can resolve to the repo's new key, with evidence and an alias`, { skip }, (t) => {
    const { h, app, key } = legacyWorld(t, storage);
    const out = leftSome(ledger(h, app, 'store', 'migrate', '--repo-ids'));
    const store = openStore(h, storage);
    t.after(() => store.close?.());
    assert.deepEqual(store.backlog.list(key).map(({ name }) => name), ['dup', 'fix-login']);
    assert.match(store.backlog.read(key, 'dup')?.text ?? '', /The new dup\./);
    assert.deepEqual(store.archive.list(key).map(({ name }) => name), ['2026-01-01-old', '2026-01-02-bare']);
    assert.deepEqual(store.archive.evidenceFiles(key, '2026-01-01-old'), ['red.txt']);
    assert.deepEqual(store.backlog.list('app').map(({ name }) => name), ['dup'], 'the conflict stays where it was');
    assert.deepEqual(store.archive.list('app'), []);
    assert.deepEqual(store.backlog.list('gone').map(({ name }) => name), ['idea']);
    assert.deepEqual(store.archive.list('lost').map(({ name }) => name), ['2026-01-03-x']);
    assert.deepEqual([...store.aliases.read()], [['app', key]]);
    assert.match(lineWith(out, 'dup'), /already/);
    assert.match(lineWith(out, 'idea'), /left/);
    assert.match(lineWith(out, '2026-01-03-x'), /left/);
  });

  test(`${storage} store: a second store migrate --repo-ids changes nothing`, { skip }, (t) => {
    const { h, app } = legacyWorld(t, storage);
    leftSome(ledger(h, app, 'store', 'migrate', '--repo-ids'));
    const before = snapshot(h, storage);
    leftSome(ledger(h, app, 'store', 'migrate', '--repo-ids'));
    assert.equal(snapshot(h, storage), before);
  });
}

for (const storage of ['file', 'sqlite'] as const) {
  test(`${storage} store: after store migrate --repo-ids, ledger show --repo <old folder name> finds a ledger that moved`, { skip: storage === 'sqlite' && noSqlite }, (t) => {
    const h = home(t);
    if (storage === 'sqlite') writeFileSync(path.join(h, '.claude/ledger-settings.json'), JSON.stringify({ storage: 'sqlite' }));
    const app = repository(h, path.join(h, 'repos/app'));
    const store = openStore(h, storage);
    store.backlog.write('app', 'fix-login', ledgerText({ slug: 'fix-login', main: app }));
    store.archive.write('app', '2026-01-01-old', ledgerText({ slug: 'old', main: app }));
    store.close?.();
    ok(ledger(h, h, 'store', 'migrate', '--repo-ids'));
    assert.match(ok(ledger(h, h, 'show', 'fix-login', '--repo', 'app')), /^# Task ledger — fix-login/);
    assert.match(ok(ledger(h, h, 'show', 'old', '--repo', 'app')), /^# Task ledger — old/);
  });
}

test('store migrate --repo-ids exits 0, also as a dry run, when it converts every ledger or finds none to convert', (t) => {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  for (const args of [['--dry-run'], []]) ok(ledger(h, h, 'store', 'migrate', '--repo-ids', ...args));
  fileStore(ledgerPaths(h)).backlog.write('app', 'fix-login', ledgerText({ slug: 'fix-login', main: app }));
  ok(ledger(h, h, 'store', 'migrate', '--repo-ids', '--dry-run'));
  ok(ledger(h, h, 'store', 'migrate', '--repo-ids'));
  ok(ledger(h, h, 'store', 'migrate', '--repo-ids'));
});

// --- The hint to convert ---

const HINT = '2 ledgers still use folder names (app, gone); run `ledger store migrate --repo-ids`.';

/** A HOME with the repo ~/repos/app, whose task epic has a worktree, and backlog ledgers under the folder names app and gone. */
function hintWorld(t: TestContext, legacy = true) {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  const epic = (worktreeTask(h, app, { slug: 'epic' }), worktreeOf(app, 'epic'));
  const store = fileStore(ledgerPaths(h));
  if (legacy) {
    store.backlog.write('app', 'idea', ledgerText({ slug: 'idea', main: app }));
    store.backlog.write('gone', 'other', ledgerText({ slug: 'other', main: path.join(h, 'repos/gone') }));
  }
  return { h, app, epic };
}

const sessionStartText = (h: string, cwd: string): string => {
  const ran = spawnSync(LEDGER_BIN, ['hook', 'session-start'], { cwd, env: commandEnv(h), input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd }), encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout === '' ? '' : (JSON.parse(ran.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
};

test('session-start says once how to convert when ledgers still use folder names', (t) => {
  const { h, epic } = hintWorld(t);
  const text = sessionStartText(h, epic);
  assert.equal(text.split('\n').filter((line) => line === HINT).length, 1, text);
  assert.match(text, /Task ledger — epic/);
});

test('session-start gives the hint also in a session that has no ledger', (t) => {
  const { h } = hintWorld(t);
  assert.equal(sessionStartText(h, h), HINT);
});

test('session-start gives no hint when no ledger uses a folder name', (t) => {
  const { h, epic } = hintWorld(t, false);
  assert.doesNotMatch(sessionStartText(h, epic), /migrate --repo-ids/);
  assert.equal(sessionStartText(h, h), '');
});

test('ledger go and ledger show that find no task add the hint when ledgers still use folder names', (t) => {
  const { h, app } = hintWorld(t);
  const go = ledger(h, app, 'go', 'idea');
  assert.equal(go.status, 2, go.stderr);
  assert.ok(go.stderr.trim().endsWith(HINT), go.stderr);
  const show = ledger(h, app, 'show', 'nothing');
  assert.equal(show.status, 1);
  assert.equal(show.stderr.trim(), `No ledger named nothing is in the active tasks, the backlog or the archive of the repo app. ${HINT}`);
});

test('ledger go and ledger show that find no task give no hint when no ledger uses a folder name', (t) => {
  const { h, app } = hintWorld(t, false);
  assert.doesNotMatch(ledger(h, app, 'go', 'idea').stderr, /migrate --repo-ids/);
  assert.equal(ledger(h, app, 'show', 'nothing').stderr.trim(), 'No ledger named nothing is in the active tasks, the backlog or the archive of the repo app.');
});

test('store migrate takes --to or --repo-ids, not both and not neither', (t) => {
  const h = home(t);
  const both = ledger(h, h, 'store', 'migrate', '--to', 'sqlite', '--repo-ids');
  assert.equal(both.status, 1);
  assert.match(both.stderr, /--repo-ids/);
  const neither = ledger(h, h, 'store', 'migrate');
  assert.equal(neither.status, 1);
  assert.match(neither.stderr, /--to/);
  assert.match(neither.stderr, /--repo-ids/);
  assert.equal(existsSync(path.join(h, '.claude/ledger-settings.json')), false);
});
