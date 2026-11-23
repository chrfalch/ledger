import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileStore } from '../tools/ledger/file-store.js';
import { migrateActive } from '../tools/ledger/migrate-active.js';
import { migrateRecords } from '../tools/ledger/migrate-records.js';
import { migrateRepoIds, shown } from '../tools/ledger/migrate-repo-ids.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import type { Move } from '../tools/ledger/pending.js';
import { repoLabel } from '../tools/ledger/repo-key.js';
import { sqliteFile } from '../tools/ledger/sqlite-store.js';
import { snapshot } from './helpers.js';
import { asCli, git, home, ledger, ledgerText, noSqlite, ok, repoKeyOf, repository, worktreeOf } from './ledger-core-fixtures.js';

const pending = (h: string, ...args: string[]) => ledger(h, h, 'store', 'migrate', '--pending', ...args);

const movesOf = (stdout: string): Move[] => {
  const parsed: { moves: Move[] } = JSON.parse(stdout);
  assert.deepEqual(Object.keys(parsed), ['moves']);
  return parsed.moves;
};

/**
 * A HOME with one task of each move still to do: a backlog ledger filed under the folder name app, the .claude/ledger.md
 * of a linked worktree the old task list names, and a backlog ledger under the repo's address kept as Markdown.
 */
function world(t: TestContext, worktreeMarkdown = ledgerText({ slug: 'task' })) {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  const key = repoKeyOf(app);
  const store = fileStore(ledgerPaths(h));
  store.backlog.write('app', 'fix-login', ledgerText({ slug: 'fix-login', main: app }));
  mkdirSync(store.backlog.repoLocation(key), { recursive: true });
  writeFileSync(path.join(store.backlog.repoLocation(key), 'stray.md'), ledgerText({ slug: 'stray', main: app }));
  const folder = worktreeOf(app, 'task');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'me/task', folder, 'main');
  mkdirSync(path.join(folder, '.claude'));
  const file = path.join(folder, '.claude/ledger.md');
  writeFileSync(file, worktreeMarkdown);
  const entry = { repo: key, slug: 'task', path: file, branch: 'me/task', status: 'active', main: app, created: '2026-10-01T00:00:00.000Z', updated: '2026-10-01T00:00:00.000Z' };
  writeFileSync(path.join(h, '.claude/ledgers.json'), JSON.stringify([entry]));
  return { h, app, key, file, store };
}

test('migrate --pending --json lists every move still to do, in the order the moves run, and changes nothing', (t) => {
  const { h, key, file } = world(t);
  const before = snapshot(h);

  const moves = movesOf(ok(pending(h, '--json')));

  assert.deepEqual(moves, [
    { kind: 'repo-ids', from: 'backlog app/fix-login', to: shown(key), auto: true },
    { kind: 'active', from: file, to: `active ${repoLabel(key)} task`, auto: true },
    { kind: 'records', from: `Markdown backlog ${repoLabel(key)} stray`, to: 'task record', auto: true },
  ]);
  assert.deepEqual(snapshot(h), before);
});

test('migrate --pending prints one line per move, grouped by kind', (t) => {
  const { h, key, file } = world(t);

  const lines = ok(pending(h)).trimEnd().split('\n');

  assert.deepEqual(lines, [
    'Repo keys from folder names to repo addresses (--repo-ids):',
    `  backlog app/fix-login → ${shown(key)}`,
    'Ledgers in .claude/ledger.md into active records (--active):',
    `  ${file} → active ${repoLabel(key)} task`,
    'Markdown ledgers into task records (--records):',
    `  Markdown backlog ${repoLabel(key)} stray → task record`,
  ]);
});

test('migrate --pending marks a move that would leave its task with the reason, and still exits 0', (t) => {
  const { h, file } = world(t, '## Goal\nA ledger whose heading names no slug.\n');

  const ran = pending(h, '--json');
  const left = movesOf(ok(ran)).find(({ kind }) => kind === 'active');

  assert.equal(left?.from, file);
  assert.equal(left?.auto, false);
  assert.match(left?.reason ?? '', /its heading names no task slug/);
  assert.match(ok(pending(h)), new RegExp(`^  ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} stays: its heading names no task slug`, 'm'));
});

test('migrate --pending lists the tasks that need a person apart, then the finished tasks that stay under a folder name that is gone, and exits 0', (t) => {
  const { h, key, file, store } = world(t);
  const gone = path.join(h, 'repos/gone');
  store.backlog.write('app', 'later', ledgerText({ slug: 'later', main: gone }));
  store.archive.write('app', '2026-01-01-done', ledgerText({ slug: 'done', main: gone }));

  const repoIds = movesOf(ok(pending(h, '--json'))).filter(({ kind }) => kind === 'repo-ids');
  const lines = ok(pending(h)).trimEnd().split('\n');

  assert.deepEqual(repoIds, [
    { kind: 'repo-ids', from: 'backlog app/fix-login', to: shown(key), auto: true },
    { kind: 'repo-ids', from: 'backlog app/later', to: 'repo address', auto: false, reason: `its repo folder ${gone} is gone` },
    { kind: 'repo-ids', from: 'archive app/2026-01-01-done', to: 'repo address', auto: false, reason: `its repo folder ${gone} is gone`, accepted: true },
  ]);
  assert.deepEqual(lines, [
    'Repo keys from folder names to repo addresses (--repo-ids):',
    `  backlog app/fix-login → ${shown(key)}`,
    'Ledgers in .claude/ledger.md into active records (--active):',
    `  ${file} → active ${repoLabel(key)} task`,
    'Markdown ledgers into task records (--records):',
    `  Markdown backlog ${repoLabel(key)} stray → task record`,
    '1 task needs a person to move it:',
    `  backlog app/later stays: its repo folder ${gone} is gone`,
    '1 finished task stays under its old repo folder name, as that folder is gone or unknown. Nothing to do: it stays readable in the archive.',
    `  app/2026-01-01-done: its repo folder ${gone} is gone`,
  ]);
});

test('migrate --pending with only finished tasks under a folder name that is gone names them, and nothing to move', (t) => {
  const h = home(t);
  mkdirSync(path.join(h, 'repos'));
  const store = fileStore(ledgerPaths(h));
  store.archive.write('app', '2026-01-01-done', ledgerText({ slug: 'done', main: path.join(h, 'repos/gone') }));
  store.archive.write('app', '2026-01-02-also', ledgerText({ slug: 'also', main: path.join(h, 'repos/gone') }));

  assert.deepEqual(ok(pending(h)).trimEnd().split('\n'), [
    '2 finished tasks stay under their old repo folder name, as that folder is gone or unknown. Nothing to do: they stay readable in the archive.',
    `  app/2026-01-01-done: its repo folder ${path.join(h, 'repos/gone')} is gone`,
    `  app/2026-01-02-also: its repo folder ${path.join(h, 'repos/gone')} is gone`,
  ]);
});

test('migrate --pending with nothing to move says so and exits 0', (t) => {
  const h = home(t);
  assert.equal(ok(pending(h)).trim(), 'Nothing to move.');
  assert.deepEqual(movesOf(ok(pending(h, '--json'))), []);
});

test('sqlite store: migrate --pending without a database finds nothing to move and makes no database', { skip: noSqlite }, (t) => {
  const h = home(t);
  writeFileSync(path.join(h, '.claude/ledger-settings.json'), JSON.stringify({ storage: 'sqlite' }));
  assert.deepEqual(movesOf(ok(pending(h, '--json'))), []);
  assert.equal(existsSync(sqliteFile(h)), false);
});

test('migrate --pending takes none of the other migrate flags', (t) => {
  const h = home(t);
  for (const other of [['--to', 'sqlite'], ['--from', 'file'], ['--repo-ids'], ['--records'], ['--active'], ['--remove-source'], ['--dry-run']]) {
    const ran = pending(h, ...other);
    assert.notEqual(ran.status, 0, other.join(' '));
    assert.match(ran.stderr, /cannot be used with/, other.join(' '));
  }
});

test('each migration reports the same moves to its callback in a dry run as in the real run', (t) => {
  const { h, store } = world(t);
  asCli(t, h);
  const quiet = (): void => {};
  const run = (dryRun: boolean): Move[] => {
    const moves: Move[] = [];
    const add = (move: Move): void => void moves.push(move);
    migrateRepoIds(store, { dryRun }, quiet, add);
    migrateActive(store, { dryRun, cwd: h, home: h }, quiet, add);
    migrateRecords(store, { dryRun }, quiet, add);
    return moves;
  };

  const planned = run(true);
  const done = run(false);

  assert.deepEqual(planned.map(({ kind }) => kind), ['repo-ids', 'active', 'records']);
  assert.deepEqual(done, planned);
  assert.deepEqual(run(true), []);
});

test('migrate --pending lists no --repo-ids move for an old task list entry with no ledger of its own to move', (t) => {
  const { h, app, key, file } = world(t);
  const entry = { repo: 'app', slug: 'task', path: file, branch: 'me/task', status: 'active', main: app, created: '2026-10-01T00:00:00.000Z', updated: '2026-10-01T00:00:00.000Z' };
  writeFileSync(path.join(h, '.claude/ledgers.json'), JSON.stringify([entry]));

  const repoIds = movesOf(ok(pending(h, '--json'))).filter(({ kind }) => kind === 'repo-ids');

  assert.deepEqual(repoIds, [{ kind: 'repo-ids', from: 'backlog app/fix-login', to: shown(key), auto: true }]);
});

test('file store: a move onto another disk is no automatic move, in the dry run as in the run, for the reason the run gives', (t) => {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  const key = repoKeyOf(app);
  fileStore(ledgerPaths(h)).backlog.write('app', 'x', ledgerText({ slug: 'x', main: app }));
  const target = fileStore(ledgerPaths(h)).backlog.repoLocation(key);
  mkdirSync(target, { recursive: true });
  const otherDisk = fileStore(ledgerPaths(h), {
    rename: () => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    },
    device: (file) => (file === target || file.startsWith(`${target}/`) ? 2 : 1),
  });
  const run = (dryRun: boolean): Move[] => {
    const moves: Move[] = [];
    migrateRepoIds(otherDisk, { dryRun }, () => {}, (move) => void moves.push(move));
    return moves.filter(({ from }) => from === 'backlog app/x');
  };

  const planned = run(true);

  assert.deepEqual(planned, [
    { kind: 'repo-ids', from: 'backlog app/x', to: 'repo address', auto: false, reason: `on another disk, move by hand to ${otherDisk.backlog.location(key, 'x')}` },
  ]);
  assert.deepEqual(run(false), planned);
});
