import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { REPO } from './helpers.js';
import { fileStore } from '../tools/ledger/file-store.js';
import { limitLockWaitForTests } from '../tools/ledger/lock.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { activeFile, archivedTask, backlogTask, git, home, ledgerText, lineWith, ok, readLedgerFile, recordFile, repoKeyOf, repository, runInProcess, storeFolder, worktreeOf, worktreeTask, writeLedgerFile, type Fields, type Ran } from './ledger-core-fixtures.js';

/** A HOME with the template and ~/repos/app, whose build/ and .claude/ folders git ignores. */
function setup(t: TestContext) {
  const h = home(t);
  copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
  const app = repository(h, path.join(h, 'repos/app'));
  writeFileSync(path.join(app, '.git/info/exclude'), '.claude/\nbuild/\n');
  return { h, app };
}

type Json = Record<string, unknown> & { ok: boolean };

/** Stdout is exactly one JSON object; `ok` says whether the command succeeded, and the exit code agrees. */
function parsed(ran: Ran): Json {
  const value: unknown = JSON.parse(ran.stdout);
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), `one JSON object expected, got:\n${ran.stdout}`);
  const object = value as Json;
  assert.equal(typeof object.ok, 'boolean');
  assert.equal(object.ok, ran.status === 0, `ok and the exit code disagree; stderr:\n${ran.stderr}`);
  return object;
}

function done(ran: Ran): Json {
  const object = parsed(ran);
  assert.equal(object.ok, true, `${String(object.error)}\n${ran.stderr}`);
  return object;
}

function refused(ran: Ran, pattern: RegExp, status = 1): void {
  const object = parsed(ran);
  assert.equal(ran.status, status, ran.stdout);
  assert.deepEqual(Object.keys(object).sort(), ['error', 'ok']);
  assert.match(String(object.error), pattern);
}

const json = (h: string, cwd: string, ...args: string[]): Promise<Ran> => runInProcess(h, cwd, ...args, '--json');
const read = readLedgerFile;
const today = (): string => {
  const date = new Date();
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(2, '0')).join('-');
};

/** `fields` as a ledger whose every plan step is done. */
const finishedText = (fields: Fields): string => ledgerText(fields).replace('| 2 | implement | todo |', '| 2 | implement | done |');

function bigFile(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(55_000_000, 1));
}

test('every command with --json prints one {"ok":false,"error"} object for an unknown option, and exits non-zero', async (t) => {
  const { h, app } = setup(t);
  for (const command of [['list'], ['task', 'archive'], ['tree', 'show', 'x'], ['tree', 'order', 'x', 'y'], ['tree', 'depends', 'x'], ['go', 'x'], ['task', 'new', 'x'], ['task', 'park', 'x', '--reason', 'r'], ['task', 'unpark', 'x'], ['task', 'block', 'x', '--on', 'o'], ['task', 'unblock', 'x'], ['task', 'claim', 'x'], ['task', 'retire'], ['worktrees'], ['worktrees', 'prune'], ['worktrees', 'auto-prune'], ['session']]) {
    const ran = await runInProcess(h, app, ...command, '--json', '--bogus');
    assert.notEqual(ran.status, 0, command.join(' '));
    refused(ran, /--bogus/, ran.status ?? 1);
  }
});

test('list --json gives the tasks with plan progress and parked state; --archived adds the retired ones', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', next: 'Parked: 2026-11-10 — waiting for review\nThen merge.' });
  const finished = worktreeTask(h, app, { slug: 'shipped' });
  writeLedgerFile(finished, finishedText({ slug: 'shipped', worktree: worktreeOf(app, 'shipped'), branch: 'me/shipped' }));
  archivedTask(h, app, '2026-10-01', { slug: 'old' });

  const tasks = done(await json(h, app, 'list')).tasks as Record<string, unknown>[];
  const bySlug = new Map(tasks.map((task) => [task.slug, task]));
  assert.deepEqual([...bySlug.keys()].sort(), ['epic', 'shipped']);
  assert.equal(bySlug.get('epic')?.main, app);
  assert.equal(bySlug.get('shipped')?.main, app);
  assert.deepEqual(bySlug.get('epic')?.current, { number: '2', step: 'implement', status: 'todo' });
  assert.equal(bySlug.get('epic')?.finished, false);
  assert.deepEqual(bySlug.get('epic')?.parked, { date: '2026-11-10', reason: 'waiting for review' });
  assert.equal(bySlug.get('epic')?.status, 'parked');
  assert.equal(bySlug.get('shipped')?.current, null);
  assert.equal(bySlug.get('shipped')?.finished, true);

  const all = done(await json(h, app, 'list', '--archived')).tasks as Record<string, unknown>[];
  const old = all.find(({ slug }) => slug === 'old');
  assert.equal(old?.status, 'retired');
  assert.equal(old?.archived, '2026-10-01');
  assert.equal(old?.worktree, undefined);
  assert.equal(old?.path, undefined);
});

/** An active task `slug` whose Location also holds `bullets`; gives its file. */
function locatedTask(h: string, app: string, slug: string, ...bullets: string[]): string {
  const file = worktreeTask(h, app, { slug });
  writeLedgerFile(file, read(file).replace('- design refs: none', ['- design refs: none', ...bullets].join('\n')));
  return file;
}

test('list gives the status of an active task from its status line, a legacy - state: done too; a lost mark wins over it', async (t) => {
  const { h, app } = setup(t);
  locatedTask(h, app, 'held', '- status: blocked 2026-11-20 — the API team');
  locatedTask(h, app, 'review', '- status: waiting 2026-11-21');
  locatedTask(h, app, 'shipped', '- status: done 2026-11-22');
  locatedTask(h, app, 'legacy', '- state: done');
  locatedTask(h, app, 'resting', '- status: parked 2026-11-19 — no time');
  locatedTask(h, app, 'plain', '- state: active');
  const gone = locatedTask(h, app, 'gone', '- status: waiting');
  writeLedgerFile(gone, read(gone).replace('- design refs: none', `- design refs: none\n- lost: 2026-11-22 — folder ${worktreeOf(app, 'gone')} not found`));

  const bySlug = new Map((done(await json(h, app, 'list')).tasks as Record<string, unknown>[]).map((task) => [task.slug, task]));
  const statuses = Object.fromEntries([...bySlug].map(([slug, task]) => [slug, task.status]));
  assert.deepEqual(statuses, { held: 'blocked', review: 'waiting', shipped: 'done', legacy: 'done', resting: 'parked', plain: 'active', gone: 'lost' });
  assert.deepEqual(bySlug.get('resting')?.parked, { date: '2026-11-19', reason: 'no time' });
  assert.equal(bySlug.get('held')?.parked, undefined);

  const listed = ok(await runInProcess(h, app, 'list'));
  assert.match(listed, /7 tasks: 1 active, 1 parked, 1 blocked, 1 waiting, 2 done, 1 lost, 0 backlog/);
  assert.match(lineWith(listed, 'held'), /\bblocked\b/);
  assert.match(lineWith(listed, 'review'), /\bwaiting\b/);
});

test('list counts only the statuses inside active that some task has', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'plain' });
  assert.match(ok(await runInProcess(h, app, 'list')), /1 task: 1 active, 0 parked, 0 backlog/);
});

/** Replaces the `gh` on PATH with a shell script that first notes its arguments in `calls`. */
function stubGh(h: string, calls: string, script: string): void {
  const file = path.join(h, 'stub-bin/gh');
  writeFileSync(file, `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\n${script}\n`);
  chmodSync(file, 0o755);
}

const prState = (state: string): string => `case "$*" in "pr view 42 --json state") echo '{"state":"${state}"}' ;; *) exit 1 ;; esac`;
const mergedHint = (slug: string): string => `${slug}: PR merged; marked done. Finalize it with the question from \`ledger task gate finalize ${slug}\`.\n`;

test('list and show mark a waiting task done when gh says its PR is merged, and say to finalize it', async (t) => {
  const { h, app } = setup(t);
  const calls = path.join(h, 'gh-calls');
  stubGh(h, calls, prState('MERGED'));
  const listedFile = locatedTask(h, app, 'review', '- status: waiting 2026-11-20', '- pr: 42');
  const shownFile = locatedTask(h, app, 'other', '- status: waiting 2026-11-20', '- pr: 42');

  const listed = await runInProcess(h, app, 'list');
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stderr.split(/(?<=\n)/).sort(), [mergedHint('other'), mergedHint('review')]);
  assert.match(lineWith(listed.stdout, 'review'), /\bdone\b/);
  assert.match(read(listedFile), new RegExp(`^- status: done ${today()}$`, 'm'));
  assert.match(read(shownFile), new RegExp(`^- status: done ${today()}$`, 'm'));

  const again = await runInProcess(h, app, 'list');
  assert.equal(again.stderr, '', 'a task marked done is not checked again');

  locatedTask(h, app, 'third', '- status: waiting', '- pr: 42');
  const shown = await runInProcess(h, app, 'show', 'third');
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stderr, mergedHint('third'));
  assert.match(shown.stdout, new RegExp(`^- status: done ${today()}$`, 'm'));
});

test('with --json, list and show give the task as done in the JSON, and print the hint on stderr', async (t) => {
  const { h, app } = setup(t);
  stubGh(h, path.join(h, 'gh-calls'), prState('MERGED'));
  locatedTask(h, app, 'review', '- status: waiting 2026-11-20', '- pr: 42');
  const listed = await json(h, app, 'list');
  assert.equal(listed.stderr, mergedHint('review'));
  assert.equal((done(listed).tasks as Record<string, unknown>[])[0].status, 'done');

  locatedTask(h, app, 'other', '- status: waiting 2026-11-20', '- pr: 42');
  const shown = await runInProcess(h, app, 'show', 'other', '--json');
  assert.equal(shown.stderr, mergedHint('other'));
  assert.match(String(done(shown).text), new RegExp(`^- status: done ${today()}$`, 'm'));
});

test('a merged PR whose done mark cannot be written fails neither list nor show: one warning line, and the task stays waiting', async (t) => {
  const lockWaitMs = limitLockWaitForTests(200);
  t.after(() => limitLockWaitForTests(lockWaitMs));
  const { h, app } = setup(t);
  stubGh(h, path.join(h, 'gh-calls'), prState('MERGED'));
  const file = locatedTask(h, app, 'review', '- status: waiting 2026-11-20', '- pr: 42');
  const before = read(file);
  // A lock that a live process holds makes the write give up, as a lock of another ledger command would.
  writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
  for (const command of [['list'], ['list', '--json'], ['show', 'review'], ['show', 'review', '--json']]) {
    const ran = await runInProcess(h, app, ...command);
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stderr, /^warning: review: its PR is merged, but it was not marked done: Gave up waiting for the lock [^\n]*\n$/, command.join(' '));
    assert.equal(read(file), before, command.join(' '));
  }
  assert.equal((done(await json(h, app, 'list')).tasks as Record<string, unknown>[])[0].status, 'waiting');
});

test('a waiting task whose PR is open, or for which gh fails, stays waiting and gets no hint', async (t) => {
  const { h, app } = setup(t);
  const calls = path.join(h, 'gh-calls');
  const file = locatedTask(h, app, 'review', '- status: waiting 2026-11-20', '- pr: 42');
  const before = read(file);
  for (const script of [prState('OPEN'), prState('CLOSED'), 'echo "gh: not logged in" >&2; exit 4', 'echo not json', `echo '{"state":"MERGED"}'; exit 1`]) {
    stubGh(h, calls, script);
    for (const command of [['list'], ['show', 'review']]) {
      const ran = await runInProcess(h, app, ...command);
      assert.equal(ran.status, 0, ran.stderr);
      assert.equal(ran.stderr, '', `${script}: ${command.join(' ')}`);
      assert.equal(read(file), before, script);
    }
  }
  assert.match(read(calls), /^pr view 42 --json state$/m);
});

test('gh is asked about no task that is not waiting with a PR: active, blocked, parked or done with one, waiting without one, a waiting backlog task', async (t) => {
  const { h, app } = setup(t);
  const calls = path.join(h, 'gh-calls');
  stubGh(h, calls, prState('MERGED'));
  locatedTask(h, app, 'plain', '- pr: 42');
  locatedTask(h, app, 'held', '- status: blocked', '- pr: 42');
  locatedTask(h, app, 'resting', '- status: parked 2026-11-19 — no time', '- pr: 42');
  locatedTask(h, app, 'shipped', '- status: done', '- pr: 42');
  locatedTask(h, app, 'nopr', '- status: waiting');
  const idea = backlogTask(h, app, { slug: 'idea' });
  writeFileSync(idea, readFileSync(idea, 'utf8').replace('- design refs: none', '- design refs: none\n- status: waiting\n- pr: 42'));
  for (const command of [['list'], ['list', '--json'], ['show', 'held'], ['show', 'nopr'], ['show', 'idea']]) {
    const ran = await runInProcess(h, app, ...command);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stderr, '', command.join(' '));
  }
  assert.equal(existsSync(calls), false, existsSync(calls) ? readFileSync(calls, 'utf8') : '');
});

test('archive --json lists the archived ledgers with date, branch, goal and the matching line; outside a repo it fails', async (t) => {
  const { h, app } = setup(t);
  archivedTask(h, app, '2026-10-01', { slug: 'old-a', report: ['Merged in PR #27.'] });
  archivedTask(h, app, '2026-10-05', { slug: 'old-b' });

  const all = done(await json(h, app, 'task', 'archive'));
  const [repo, folder] = [repoKeyOf(app), storeFolder(h, 'ledger-archive', app)];
  assert.equal(all.repo, repo);
  assert.equal(all.folder, folder);
  assert.deepEqual(all.ledgers, [
    { date: '2026-10-05', repo, slug: 'old-b', path: path.join(folder, '2026-10-05-old-b.md'), branch: 'me/old-b', labels: [], goal: 'Goal of old-b.' },
    { date: '2026-10-01', repo, slug: 'old-a', path: path.join(folder, '2026-10-01-old-a.md'), branch: 'me/old-a', labels: [], goal: 'Goal of old-a.' },
  ]);
  const matched = done(await json(h, app, 'task', 'archive', 'pr #27'));
  assert.equal(matched.term, 'pr #27');
  assert.deepEqual((matched.ledgers as { slug: string; match: string }[]).map(({ slug, match }) => [slug, match]), [['old-a', 'Merged in PR #27.']]);
  assert.equal(done(await json(h, h, 'task', 'archive', '--all')).repo, null);
  refused(await json(h, h, 'task', 'archive'), /--all/);
});

test('parent --json shows the parent; add, remove, start and next each report what they did; errors are JSON', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', goal: 'The epic.', children: ['- first'] });
  backlogTask(h, app, { slug: 'first', parent: 'epic' });
  backlogTask(h, app, { slug: 'second' });
  const epicLedger = activeFile(h, app, 'epic');

  const shown = done(await json(h, app, 'tree', 'show', 'epic'));
  assert.deepEqual([shown.slug, shown.main, shown.goal], ['epic', app, 'The epic.']);
  assert.deepEqual(shown.children, [{ slug: 'first', main: app, status: 'backlog', labels: [], next: 'Next step of first.', report: [] }]);

  const added = done(await json(h, app, 'tree', 'add', 'epic', 'second'));
  assert.deepEqual(added, { ok: true, action: 'add', parent: { slug: 'epic', main: app }, child: { slug: 'second', main: app } });
  const removed = done(await json(h, app, 'tree', 'remove', 'epic', 'second'));
  assert.deepEqual(removed, { ok: true, action: 'remove', parent: { slug: 'epic', main: app }, child: { slug: 'second', main: app } });

  const next = done(await json(h, app, 'tree', 'next', 'epic'));
  assert.deepEqual(next, { ok: true, action: 'next', parent: { slug: 'epic', main: app }, chain: [{ slug: 'epic', main: app }, { slug: 'first', main: app }] });

  const started = done(await json(h, app, 'tree', 'start', 'epic', 'first'));
  assert.deepEqual(started, { ok: true, action: 'start', parent: { slug: 'epic', main: app }, child: { slug: 'first', main: app }, ledger: epicLedger, marked: true });
  assert.match(read(epicLedger), new RegExp(`^- first \\(started ${today()}\\)$`, 'm'));
  const again = done(await json(h, app, 'tree', 'start', 'epic', 'first'));
  assert.equal(again.marked, false);
  assert.equal(again.reason, 'already-marked');

  const firstFile = path.join(storeFolder(h, 'ledger-backlog', app), 'first.md');
  for (const file of [firstFile, recordFile(firstFile)]) rmSync(file, { force: true });
  assert.deepEqual(done(await json(h, app, 'tree', 'next', 'epic')).chain, []);
  refused(await json(h, app, 'tree', 'add', 'epic'), /missing required argument 'child'/);
  refused(await json(h, app, 'tree', 'show', 'ghost'), /ghost/);
});

test('tree order and tree depends --json report what they set; tree next --json names what blocks each child; refusals are JSON', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- first', '- second'] });
  backlogTask(h, app, { slug: 'first', parent: 'epic' });
  backlogTask(h, app, { slug: 'second', parent: 'epic' });
  const [key, epic, first, second] = [repoKeyOf(app), { slug: 'epic', main: app }, { slug: 'first', main: app }, { slug: 'second', main: app }];

  assert.deepEqual(done(await json(h, app, 'tree', 'order', 'epic', 'second', 'first')), { ok: true, action: 'order', parent: epic, children: [second, first] });
  const api = { slug: 'api', repo: 'github.com/acme/api' };
  assert.deepEqual(done(await json(h, app, 'tree', 'depends', 'second', 'first', 'api@github.com/acme/api')), {
    ok: true,
    action: 'depends',
    child: second,
    dependencies: [{ slug: 'first', repo: key }, api],
  });
  done(await json(h, app, 'tree', 'depends', 'first', 'later'));
  assert.deepEqual(done(await json(h, app, 'tree', 'next', 'epic')), {
    ok: true,
    action: 'next',
    parent: epic,
    chain: [],
    blocked: [
      { child: second, dependencies: [{ slug: 'first', repo: key }, api] },
      { child: first, dependencies: [{ slug: 'later', repo: key }] },
    ],
  });
  assert.deepEqual(done(await json(h, app, 'tree', 'depends', 'first')), { ok: true, action: 'depends', child: first, dependencies: [] });
  refused(await json(h, app, 'tree', 'order', 'epic', 'first'), /second/);
  refused(await json(h, app, 'tree', 'depends', 'first', 'first'), /itself/);
});

test('tree ready --json names the chain to each child that can start, to each started child, and what each waiting child waits for', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- first', '- nested', '- waits'] });
  backlogTask(h, app, { slug: 'first', parent: 'epic' });
  backlogTask(h, app, { slug: 'nested', parent: 'epic', children: ['- running', '- deep'] });
  worktreeTask(h, app, { slug: 'running', parent: 'nested' });
  backlogTask(h, app, { slug: 'deep', parent: 'nested' });
  backlogTask(h, app, { slug: 'waits', parent: 'epic' });
  done(await json(h, app, 'tree', 'depends', 'waits', 'later'));
  const ref = (slug: string) => ({ slug, main: app });
  const [epic, nested] = [ref('epic'), ref('nested')];
  assert.deepEqual(done(await json(h, app, 'tree', 'ready', 'epic')), {
    ok: true,
    action: 'ready',
    parent: epic,
    ready: [
      [epic, ref('first')],
      [epic, nested, ref('deep')],
    ],
    running: [[epic, nested, ref('running')]],
    blocked: [{ child: ref('waits'), dependencies: [{ slug: 'later', repo: repoKeyOf(app) }] }],
  });
});

test('go --json promotes a backlog task and reports its worktree, branch, base and ledger', async (t) => {
  const { h, app } = setup(t);
  backlogTask(h, app, { slug: 'fix-login' });
  const worktree = worktreeOf(app, 'fix-login');
  const started = done(await json(h, app, 'go', 'fix-login'));
  assert.equal(started.slug, 'fix-login');
  assert.equal(started.main, app);
  assert.equal(started.worktree, worktree);
  assert.equal(started.branch, 'fix-login');
  assert.match(String(started.base), /^origin\/main @ [0-9a-f]{7,}$/);
  assert.equal(started.ledger, activeFile(h, app, 'fix-login'));
  assert.equal(started.promoted, true);
  assert.deepEqual(started.chain, []);
  assert.deepEqual(started.warnings, []);
  assert.equal(started.marked, undefined);
});

test('go --json of a parent starts its first backlog child, marks it started and reports the chain', async (t) => {
  const { h, app } = setup(t);
  backlogTask(h, app, { slug: 'epic', children: ['- part-a', '- part-b'] });
  backlogTask(h, app, { slug: 'part-a', parent: 'epic', next: 'Parked: 2026-11-10 — not yet\nStart it.' });
  backlogTask(h, app, { slug: 'part-b', parent: 'epic' });

  const started = done(await json(h, app, 'go', 'epic'));
  assert.equal(started.slug, 'part-a');
  assert.deepEqual(started.chain, [{ slug: 'epic', main: app }, { slug: 'part-a', main: app }]);
  assert.equal(started.worktree, worktreeOf(app, 'part-a'));
  assert.deepEqual(started.unparked, { date: '2026-11-10', reason: 'not yet' });
  const epicBacklog = path.join(storeFolder(h, 'ledger-backlog', app), 'epic.md');
  assert.deepEqual(started.marked, { parent: { slug: 'epic', main: app }, ledger: recordFile(epicBacklog) });
  assert.equal(lineWith(read(epicBacklog), '- part-a @'), `- part-a @ ${app} (started ${today()})`);
  assert.doesNotMatch(read(activeFile(h, app, 'part-a')), /^Parked:/m);
});

test('go --json of a task that already has a worktree goes there without promoting; an unknown slug fails with exit 2', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'busy' });
  const gone = done(await json(h, app, 'go', 'busy'));
  assert.equal(gone.promoted, false);
  assert.equal(gone.worktree, worktreeOf(app, 'busy'));
  assert.equal(gone.branch, 'me/busy');
  assert.equal(gone.ledger, activeFile(h, app, 'busy'));
  refused(await json(h, app, 'go', 'nothing'), /nothing/, 2);
});

test('go --json names the parent of the task it started and the status of each of its children', async (t) => {
  const { h, app } = setup(t);
  backlogTask(h, app, { slug: 'umbrella', children: ['- epic'] });
  worktreeTask(h, app, { slug: 'epic', parent: 'umbrella', children: ['- busy', '- old'] });
  worktreeTask(h, app, { slug: 'busy', parent: 'epic' });
  archivedTask(h, app, '2026-10-01', { slug: 'old', parent: 'epic' });

  const epic = done(await json(h, app, 'go', 'epic'));
  assert.deepEqual(epic.chain, []);
  assert.deepEqual(epic.parent, { slug: 'umbrella', main: app });
  assert.deepEqual(epic.children, [
    { slug: 'busy', main: app, status: 'active' },
    { slug: 'old', main: app, status: 'retired' },
  ]);

  const busy = done(await json(h, app, 'go', 'busy'));
  assert.deepEqual(busy.parent, { slug: 'epic', main: app });
  assert.deepEqual(busy.children, []);
});

const pattern = (text: string): RegExp => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

test('go --json refuses a slug of another repo, of a retired task, or of a worktree folder with no such ledger, with exit 3 or 1, and makes nothing', async (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  backlogTask(h, lib, { slug: 'lib-task' });
  archivedTask(h, app, '2026-10-01', { slug: 'shipped' });
  const loose = worktreeOf(app, 'loose');
  mkdirSync(loose, { recursive: true });

  refused(await json(h, app, 'go', 'lib-task'), pattern(`it is a task of the repo at ${lib}`), 3);
  refused(await json(h, app, 'go', 'shipped'), /^shipped is retired: only its archive copy is left/);
  refused(await json(h, app, 'go', 'loose'), pattern(`The folder ${loose} exists, but no task ledger in it has the slug loose.`));
  refused(await json(h, app, 'go', 'nothing'), /nothing/, 2);
  assert.equal(existsSync(worktreeOf(app, 'lib-task')), false);
  assert.equal(existsSync(worktreeOf(app, 'shipped')), false);
});

test('go --json of a backlog parent with no child left in the backlog fails and starts nothing', async (t) => {
  const { h, app } = setup(t);
  const epic = backlogTask(h, app, { slug: 'epic', children: ['- part'] });
  worktreeTask(h, app, { slug: 'part', parent: 'epic' });
  refused(await json(h, app, 'go', 'epic'), /^No child task of epic is left in the backlog, so there is nothing to start\./);
  assert.equal(existsSync(epic), true);
  assert.equal(existsSync(worktreeOf(app, 'epic')), false);
});

test('go --json of a parent whose next child is in another repo promotes the child there and names that worktree', async (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const epic = worktreeTask(h, app, { slug: 'epic', children: [`- lib-part @ ${lib}`] });
  backlogTask(h, lib, { slug: 'lib-part', parent: `epic @ ${app}` });

  const started = done(await json(h, app, 'go', 'epic'));
  const worktree = worktreeOf(lib, 'lib-part');
  assert.equal(started.slug, 'lib-part');
  assert.equal(started.main, lib);
  assert.equal(started.worktree, worktree);
  assert.equal(started.ledger, activeFile(h, lib, 'lib-part'));
  assert.equal(started.promoted, true);
  assert.deepEqual(started.chain, [{ slug: 'epic', main: app }, { slug: 'lib-part', main: lib }]);
  assert.deepEqual(started.marked, { parent: { slug: 'epic', main: app }, ledger: epic });
  assert.equal(existsSync(activeFile(h, lib, 'lib-part')), true);
  assert.equal(existsSync(worktreeOf(app, 'lib-part')), false);
});

test('task --json reports a backlog task and its start command, a stacked task with its worktree, and --here', async (t) => {
  const { h, app } = setup(t);
  const backlog = done(await json(h, app, 'task', 'new', 'fix-login', '--goal', 'Fix it.'));
  assert.deepEqual(backlog, {
    ok: true,
    slug: 'fix-login',
    main: app,
    status: 'backlog',
    ledger: path.join(storeFolder(h, 'ledger-backlog', app), 'fix-login.json'),
    start: '/ledger:go fix-login',
  });

  worktreeTask(h, app, { slug: 'epic' });
  const epic = worktreeOf(app, 'epic');
  const stacked = done(await json(h, epic, 'task', 'new', 'sub', '--stack'));
  assert.equal(stacked.status, 'active');
  assert.equal(stacked.worktree, worktreeOf(app, 'sub'));
  assert.equal(stacked.branch, 'sub');
  assert.match(String(stacked.base), /^me\/epic @ /);
  assert.equal(stacked.ledger, activeFile(h, app, 'sub'));
  assert.equal(stacked.noted, activeFile(h, app, 'epic'));

  rmSync(activeFile(h, app, 'epic'));
  const here = done(await json(h, epic, 'task', 'new', '--here', 'epic-again'));
  assert.equal(here.slug, 'epic-again');
  assert.equal(here.worktree, epic);
  assert.equal(here.start, undefined);
  refused(await json(h, app, 'task', 'new', 'Bad_Slug'), /slug/);
});

test('park and unpark --json report the marker; an unknown task fails', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const parked = done(await json(h, app, 'task', 'park', 'epic', '--reason', 'waiting'));
  assert.deepEqual(parked, { ok: true, slug: 'epic', main: app, ledger: file, parked: { date: today(), reason: 'waiting' } });
  const unparked = done(await json(h, app, 'task', 'unpark', 'epic'));
  assert.deepEqual(unparked, { ok: true, slug: 'epic', main: app, ledger: file, unparked: true, parked: { date: today(), reason: 'waiting' } });
  assert.deepEqual(done(await json(h, app, 'task', 'unpark', 'epic')), { ok: true, slug: 'epic', main: app, ledger: file, unparked: false });
  refused(await json(h, app, 'task', 'park', 'ghost', '--reason', 'x'), /ghost/);
  refused(await json(h, app, 'task', 'unpark', 'ghost'), /ghost/);
});

test('block and unblock --json report the blocked status; a refused move and an unknown task fail', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const blocked = done(await json(h, app, 'task', 'block', 'epic', '--on', 'the API'));
  assert.deepEqual(blocked, { ok: true, slug: 'epic', main: app, ledger: file, blocked: { date: today(), on: 'the API' } });
  refused(await json(h, app, 'task', 'park', 'epic', '--reason', 'later'), /epic is blocked, so it cannot become parked/);
  const unblocked = done(await json(h, app, 'task', 'unblock', 'epic'));
  assert.deepEqual(unblocked, { ok: true, slug: 'epic', main: app, ledger: file, unblocked: true, blocked: { date: today(), on: 'the API' } });
  assert.deepEqual(done(await json(h, app, 'task', 'unblock', 'epic')), { ok: true, slug: 'epic', main: app, ledger: file, unblocked: false });
  refused(await json(h, app, 'task', 'block', 'epic', '--on', ' '), /--on <text>/);
  refused(await json(h, app, 'task', 'block', 'ghost', '--on', 'x'), /ghost/);
  refused(await json(h, app, 'task', 'unblock', 'ghost'), /ghost/);
});

test('retire --dry-run --json gives the plan and its blockers; retire --json lists what it did', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- idea'] });
  const worktree = worktreeOf(app, 'epic');
  writeFileSync(path.join(worktree, 'dirty.txt'), 'x');
  backlogTask(h, app, { slug: 'idea', parent: 'epic', report: ['Nothing to report.'] });

  const plan = done(await json(h, app, 'task', 'retire', 'epic', '--dry-run'));
  assert.equal(plan.dryRun, true);
  assert.equal(plan.place, 'active');
  assert.equal(plan.blocked, true);
  assert.equal(plan.needsForce, true);
  assert.deepEqual(
    (plan.blockers as { kind: string; forceable: boolean }[]).map(({ kind, forceable }) => [kind, forceable]),
    [['children', true], ['dirty', true]],
  );
  assert.ok((plan.steps as string[]).some((step) => step.startsWith(`remove the worktree ${worktree}`)));
  assert.equal((plan.worktree as { folder: string; dirty: number }).dirty, 1);
  assert.equal(existsSync(worktree), true);

  const retired = done(await json(h, app, 'task', 'retire', 'idea'));
  const archive = path.join(storeFolder(h, 'ledger-archive', app), `${today()}-idea.json`);
  assert.equal(retired.dryRun, false);
  assert.equal(retired.archive, archive);
  assert.deepEqual(retired.parent, { slug: 'epic', main: app });
  assert.ok((retired.done as string[]).includes(`archived ${archive}`), String(retired.done));
  assert.equal(existsSync(archive), true);
  assert.match(String(retired.hint), /Parent epic has no active children left/);
  refused(await json(h, app, 'task', 'retire', 'ghost'), /ghost/);
  refused(await json(h, app, 'task', 'retire', 'epic'), /uncommitted change/);
});

test('worktrees --json gives each linked worktree with its ledger; prune --json gives the folders per worktree', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- part'] });
  worktreeTask(h, app, { slug: 'part', parent: 'epic' });
  const epic = worktreeOf(app, 'epic');
  bigFile(path.join(epic, 'build/out.bin'));

  const table = done(await json(h, app, 'worktrees'));
  assert.equal(table.main, app);
  assert.match(String(table.prError), /gh/);
  const rows = new Map((table.worktrees as { name: string }[]).map((row) => [row.name, row as Record<string, unknown>]));
  assert.deepEqual(rows.get('epic')?.ledger, { slug: 'epic', path: activeFile(h, app, 'epic'), labels: [], activeChildren: 1 });
  assert.deepEqual(rows.get('part')?.ledger, { slug: 'part', path: activeFile(h, app, 'part'), labels: [], parent: 'epic' });
  assert.equal(rows.get('epic')?.branch, 'me/epic');
  assert.equal(rows.get('epic')?.dirty, 0);
  assert.ok(Number(rows.get('epic')?.sizeGb) >= 0.05);

  const planned = done(await json(h, app, 'worktrees', 'prune', 'epic', '--dry-run'));
  assert.equal(planned.dryRun, true);
  const [only] = planned.worktrees as { name: string; folders: { path: string; label: string; sizeGb: number }[] }[];
  assert.equal(only.name, 'epic');
  assert.deepEqual(only.folders.map(({ path: folder, label }) => [folder, label]), [[path.join(epic, 'build'), 'build']]);
  const every = done(await json(h, app, 'worktrees', 'prune', '--all'));
  assert.equal(every.dryRun, false);
  assert.deepEqual((every.worktrees as { name: string; folders: unknown[] }[]).map(({ name, folders }) => [name, folders.length]).sort(), [['epic', 1], ['part', 0]]);
  assert.equal(existsSync(path.join(epic, 'build')), false);
  refused(await json(h, app, 'worktrees', 'prune'), /either a worktree name or --all/);
});

test('auto-prune --json prunes a finished task once, marks it, and drops the mark when the task reopens', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const worktree = worktreeOf(app, 'epic');
  const marker = path.join(worktree, '.claude/build-folders-pruned');
  bigFile(path.join(worktree, 'build/out.bin'));

  const open = done(await json(h, worktree, 'worktrees', 'auto-prune'));
  assert.deepEqual([open.outcome, open.finished, open.ledger, open.worktree, open.marker], ['unchanged', false, file, worktree, marker]);
  assert.equal(existsSync(path.join(worktree, 'build')), true);

  const opened = read(file);
  writeLedgerFile(file, finishedText({ slug: 'epic', worktree, branch: 'me/epic' }));
  const pruned = done(await json(h, app, 'worktrees', 'auto-prune', worktreeOf(app, 'epic')));
  assert.equal(pruned.outcome, 'pruned');
  assert.equal(pruned.finished, true);
  assert.deepEqual((pruned.folders as { path: string }[]).map(({ path: folder }) => folder), [path.join(worktree, 'build')]);
  assert.match(String(pruned.message), /^Pruned the build folders of epic, because its task is finished/);
  assert.equal(existsSync(path.join(worktree, 'build')), false);
  assert.equal(existsSync(marker), true);
  assert.equal(done(await json(h, worktree, 'worktrees', 'auto-prune')).outcome, 'unchanged');

  writeLedgerFile(file, opened);
  assert.equal(done(await json(h, worktree, 'worktrees', 'auto-prune')).outcome, 'unmarked');
  assert.equal(existsSync(marker), false);
  refused(await json(h, app, 'worktrees', 'auto-prune', path.join(app, 'nope.md')), /nope\.md/);
});

test('auto-prune puts its trash in the worktree git dir, so no trash folder shows inside the worktree', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const worktree = worktreeOf(app, 'epic');
  bigFile(path.join(worktree, 'build/out.bin'));
  // An rm that does nothing keeps the trash, so the test can see where it went.
  writeFileSync(path.join(h, 'stub-bin/rm'), '#!/bin/sh\nexit 0\n');
  chmodSync(path.join(h, 'stub-bin/rm'), 0o755);
  writeLedgerFile(file, finishedText({ slug: 'epic', worktree, branch: 'me/epic' }));

  assert.equal(done(await json(h, worktree, 'worktrees', 'auto-prune')).outcome, 'pruned');
  const trashIn = (folder: string): string[] => readdirSync(folder).filter((name) => name.startsWith('.cc-trash-'));
  assert.deepEqual(trashIn(worktree), []);
  const gitDir = git(h, worktree, 'rev-parse', '--absolute-git-dir');
  const [trash] = trashIn(gitDir);
  assert.ok(trash !== undefined, `no trash folder in ${gitDir}`);
  assert.equal(existsSync(path.join(gitDir, trash, 'build/out.bin')), true);
});

test('auto-prune with no ledger argument in a folder without its own ledger is outcome no-ledger, exit 0, silent', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic' });
  const bare = path.join(h, 'bare');
  mkdirSync(bare);
  for (const folder of [app, bare]) {
    const ran = await json(h, folder, 'worktrees', 'auto-prune');
    assert.equal(ran.stderr, '');
    assert.deepEqual(done(ran), { ok: true, outcome: 'no-ledger', folder, finished: false });
    assert.deepEqual(await runInProcess(h, folder, 'worktrees', 'auto-prune'), { status: 0, stdout: '', stderr: '' });
  }
});

test('auto-prune --json leaves a finished ledger that is not in a linked worktree alone', async (t) => {
  const { h, app } = setup(t);
  const folder = path.join(h, 'plain');
  mkdirSync(folder);
  fileStore(ledgerPaths(h)).active.write(repoKeyOf(app), 'plain', finishedText({ slug: 'plain', worktree: folder }));
  const result = done(await json(h, app, 'worktrees', 'auto-prune', folder));
  assert.equal(result.outcome, 'not-linked');
  assert.equal(existsSync(path.join(folder, '.claude/build-folders-pruned')), false);
});

test('session --json gives the ledger of a linked worktree as its own, those of the main checkout, and none for a removed folder', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', parent: 'umbrella', children: ['- part (started 2026-11-02)'] });
  worktreeTask(h, app, { slug: 'other' });
  const worktree = worktreeOf(app, 'epic');

  const own = done(await json(h, path.join(worktree, '.claude'), 'session'));
  assert.equal(own.own, true);
  assert.equal(own.title, '🔨 epic');
  assert.equal(own.removed, false);
  const [task] = own.ledgers as Record<string, unknown>[];
  assert.equal(task.worktree, worktree);
  assert.equal(task.path, undefined);
  assert.equal(task.goal, 'Goal of epic.');
  assert.equal(task.next, 'Next step of epic.');
  assert.deepEqual(task.current, { number: '2', step: 'implement', status: 'todo' });
  assert.deepEqual(task.parent, { slug: 'umbrella', main: app });
  assert.deepEqual(task.children, [{ slug: 'part', main: app, mark: { kind: 'started', date: '2026-11-02' } }]);
  assert.equal(task.title, '🔨 epic');

  const main = done(await json(h, app, 'session'));
  assert.equal(main.own, false);
  assert.equal(main.title, undefined);
  assert.deepEqual((main.ledgers as { title: string }[]).map(({ title }) => title).sort(), ['🔨 epic', '🔨 other']);

  const gone = path.join(h, 'gone');
  assert.deepEqual(done(await json(h, app, 'session', gone)), { ok: true, folder: gone, removed: true, own: false, ledgers: [] });
});

test('session --json names the main checkout of the repo that holds the folder, and none outside a repo', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic' });
  assert.equal(done(await json(h, app, 'session', worktreeOf(app, 'epic'))).main, app);
  assert.equal(done(await json(h, app, 'session')).main, app);
  assert.equal(done(await json(h, app, 'session', h)).main, undefined);
});

test('session --json names the repo key of the repo that holds the folder, and none outside a repo', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic' });
  assert.equal(done(await json(h, app, 'session', worktreeOf(app, 'epic'))).repo, repoKeyOf(app));
  assert.equal(done(await json(h, app, 'session', h)).repo, undefined);
});

test('session, list and go --json give each main checkout as its real path, also when a ledger or --repo names it through a symbolic link', async (t) => {
  const { h, app } = setup(t);
  const link = path.join(h, 'links/app');
  mkdirSync(path.dirname(link));
  symlinkSync(app, link);
  backlogTask(h, `${link}/`, { slug: 'fix-login', parent: 'epic' });
  backlogTask(h, link, { slug: 'epic', children: ['- fix-login'] });

  assert.equal(done(await json(h, link, 'session')).main, app);
  const listed = done(await json(h, link, 'list')).tasks as { slug: string; main?: string; parent?: { main?: string } }[];
  assert.deepEqual(
    listed.map(({ slug, main, parent }) => [slug, main, parent?.main]).sort(),
    [
      ['epic', app, undefined],
      ['fix-login', app, app],
    ],
  );
  const started = done(await json(h, link, 'go', 'epic', '--repo', `${link}/`));
  assert.equal(started.main, app);
  assert.deepEqual(started.chain, [
    { slug: 'epic', main: app },
    { slug: 'fix-login', main: app },
  ]);
  assert.deepEqual(started.parent, { slug: 'epic', main: app });
  assert.deepEqual((started.marked as { parent: unknown }).parent, { slug: 'epic', main: app });
});

test("auto-prune deletes the worktree's own build folder beside the worktrees, and leaves the main checkout's", async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const worktree = worktreeOf(app, 'epic');
  const buildRoot = path.join(app, '.claude/worktrees/.build');
  for (const name of ['epic', '.main']) bigFile(path.join(buildRoot, name, 'Debug-sim/Build/app.o'));
  writeLedgerFile(file, finishedText({ slug: 'epic', worktree, branch: 'me/epic' }));

  const pruned = done(await json(h, app, 'worktrees', 'auto-prune', worktreeOf(app, 'epic')));
  assert.equal(pruned.outcome, 'pruned');
  assert.deepEqual((pruned.folders as { path: string }[]).map(({ path: folder }) => folder), [path.join(buildRoot, 'epic')]);
  assert.equal(existsSync(path.join(buildRoot, 'epic')), false);
  assert.ok(existsSync(path.join(buildRoot, '.main/Debug-sim/Build/app.o')));
});

test('auto-prune deletes no build folder, and says so, when .claude/worktrees/.build is a symbolic link', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const target = path.join(h, 'elsewhere');
  bigFile(path.join(target, 'epic/Debug-sim/Build/app.o'));
  symlinkSync(target, path.join(app, '.claude/worktrees/.build'));
  writeLedgerFile(file, finishedText({ slug: 'epic', worktree: worktreeOf(app, 'epic'), branch: 'me/epic' }));

  const pruned = done(await json(h, app, 'worktrees', 'auto-prune', worktreeOf(app, 'epic')));
  assert.ok(existsSync(path.join(target, 'epic/Debug-sim/Build/app.o')));
  assert.match(String(pruned.message), /not deleted/);
  assert.ok((pruned.failures as string[]).some((line) => line.includes('is a symbolic link')), JSON.stringify(pruned));
});

test('auto-prune keeps the build folder of a worktree whose name another worktree shares regardless of case, and says so', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'me/other', path.join(h, 'elsewhere/EPIC'), 'main');
  const object = path.join(app, '.claude/worktrees/.build/epic/Debug-sim/Build/app.o');
  bigFile(object);
  writeLedgerFile(file, finishedText({ slug: 'epic', worktree: worktreeOf(app, 'epic'), branch: 'me/epic' }));

  const pruned = done(await json(h, app, 'worktrees', 'auto-prune', worktreeOf(app, 'epic')));
  assert.ok(existsSync(object));
  assert.match(String(pruned.message), /not deleted/);
  assert.ok((pruned.failures as string[]).some((line) => line.includes('EPIC')), JSON.stringify(pruned));
});

test('auto-prune deletes all the build folders of a worktree with one background rm', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const worktree = worktreeOf(app, 'epic');
  writeFileSync(path.join(app, '.git/info/exclude'), '.claude/\nbuild/\n.build/\n');
  bigFile(path.join(worktree, 'build/out.bin'));
  bigFile(path.join(worktree, '.build/out.bin'));
  writeLedgerFile(file, finishedText({ slug: 'epic', worktree, branch: 'me/epic' }));
  const calls = path.join(h, 'rm-calls');
  const rm = path.join(h, 'stub-bin/rm');
  writeFileSync(rm, `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\nexec /bin/rm "$@"\n`);
  chmodSync(rm, 0o755);

  assert.equal(done(await json(h, app, 'worktrees', 'auto-prune', worktree)).outcome, 'pruned');
  for (let waited = 0; !existsSync(calls) && waited < 5000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const lines = read(calls).trim().split('\n');
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.equal(lines[0].split(' ').filter((word) => word.includes('.cc-trash-')).length >= 1, true, lines[0]);
});
