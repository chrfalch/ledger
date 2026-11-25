import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { FORMAT, isAllowed } from '../tools/ledger/clone.js';
import { fileStore } from '../tools/ledger/file-store.js';
import { parseLedger } from '../tools/ledger/format.js';
import { limitLockWaits } from '../tools/ledger/lock.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { prePushHook } from '../tools/ledger/secret-scan.js';
import { sqliteFile, sqliteStore } from '../tools/ledger/sqlite-store.js';
import type { LedgerStore } from '../tools/ledger/store.js';
import { createTask, currentTask, updateLedger } from '../tools/ledger/write.js';
import { REPO } from './helpers.js';
import { backlogTask, commandEnv, git, home, LEDGER_BIN, ledger, ledgerText, noSqlite, ok, repoKeyOf, repository, worktreeOf, worktreeTask, type Ran } from './ledger-core-fixtures.js';

/** A HOME with the ledger template and the repo ~/repos/app, whose origin is a local bare repo. */
function setup(t: TestContext) {
  const h = home(t);
  copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
  const app = repository(h, path.join(h, 'repos/app'));
  return { h, app, key: repoKeyOf(app), store: () => fileStore(ledgerPaths(h)) };
}

const json = (ran: Ran): Record<string, unknown> => JSON.parse(ok(ran));

const noLedgerFile = (worktree: string): void => assert.equal(existsSync(path.join(worktree, '.claude/ledger.md')), false, `${worktree} has a .claude/ledger.md`);

function hook(h: string, event: string, input: object): string {
  const ran = spawnSync(LEDGER_BIN, ['hook', event], { cwd: h, env: commandEnv(h), input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout;
}

const removalGate = (h: string, cwd: string, folder: string): string =>
  hook(h, 'pre-tool-use', { cwd, tool_name: 'Bash', tool_input: { command: `git worktree remove ${folder}` } });

test('ledger go moves a backlog task into an active record that names its new worktree, and the backlog ledger is gone', (t) => {
  const { h, app, key, store } = setup(t);
  backlogTask(h, app, { slug: 'idea' });

  const started = json(ledger(h, app, 'go', 'idea', '--json'));

  const worktree = worktreeOf(app, 'idea');
  const record = store().active.read(key, 'idea');
  assert.ok(record, 'no active record');
  assert.equal(parseLedger(record.text).location.worktree, worktree);
  assert.equal(started.ledger, record.location);
  assert.equal(started.worktree, worktree);
  assert.equal(store().backlog.has(key, 'idea'), false);
  noLedgerFile(worktree);
});

test('ledger go of a slug an active record already has fails, and leaves the backlog ledger and no worktree', (t) => {
  const { h, app, key, store } = setup(t);
  backlogTask(h, app, { slug: 'idea' });
  store().active.write(key, 'idea', ledgerText({ slug: 'idea', worktree: path.join(h, 'elsewhere/idea') }));

  const ran = ledger(h, app, 'go', 'idea');

  assert.equal(ran.status, 1, ran.stderr);
  assert.match(ran.stderr, /idea/);
  assert.ok(store().backlog.has(key, 'idea'));
  assert.equal(existsSync(worktreeOf(app, 'idea')), false);
});

test('ledger task new --stack writes an active record for the new worktree, and its decision line to the active record of this worktree', (t) => {
  const { h, app, key, store } = setup(t);
  worktreeTask(h, app, { slug: 'epic' });
  const epic = worktreeOf(app, 'epic');

  const created = json(ledger(h, epic, 'task', 'new', 'part', '--stack', '--json'));

  const part = store().active.read(key, 'part');
  assert.ok(part, 'no active record for part');
  assert.equal(parseLedger(part.text).location.worktree, worktreeOf(app, 'part'));
  assert.equal(created.ledger, part.location);
  assert.equal(created.noted, store().active.location(key, 'epic'));
  assert.match(store().active.read(key, 'epic')?.text ?? '', /New task part: separate work/);
  noLedgerFile(epic);
  noLedgerFile(worktreeOf(app, 'part'));
});

test('ledger task new --here writes an active record for this linked worktree, once', (t) => {
  const { h, app, key, store } = setup(t);
  const loose = path.join(app, '.claude/worktrees/loose');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'loose', loose);

  ok(ledger(h, loose, 'task', 'new', '--here'));

  assert.equal(parseLedger(store().active.read(key, 'loose')?.text ?? '').location.worktree, loose);
  noLedgerFile(loose);
  const again = ledger(h, loose, 'task', 'new', '--here');
  assert.equal(again.status, 1, again.stderr);
  assert.match(again.stderr, /already has/);
});

test('notes and park write the active record', (t) => {
  const { h, app, key, store } = setup(t);
  worktreeTask(h, app, { slug: 'epic' });
  const epic = worktreeOf(app, 'epic');

  ok(ledger(h, epic, 'notes', 'decide', 'Keep records', '--because', 'the store holds them', '--tag', 'observed'));
  ok(ledger(h, app, 'task', 'park', 'epic', '--reason', 'waiting for review'));

  const record = JSON.parse(readFileSync(store().active.location(key, 'epic'), 'utf8'));
  assert.ok(record.decisions.some(({ text }: { text: string }) => text === 'Keep records'));
  assert.deepEqual(record.status, { value: 'parked', date: record.status.date, detail: 'waiting for review' });
  const { tasks } = json(ledger(h, app, 'list', '--json')) as { tasks: { slug: string; status: string }[] };
  assert.equal(tasks.find(({ slug }) => slug === 'epic')?.status, 'parked');
  noLedgerFile(epic);
});

test('ledger show with no slug prints the active task of this worktree, and fails in one line naming ledger show <slug> elsewhere', (t) => {
  const { h, app, key, store } = setup(t);
  worktreeTask(h, app, { slug: 'epic' });

  assert.equal(ok(ledger(h, worktreeOf(app, 'epic'), 'show')), store().active.read(key, 'epic')?.text);

  const ran = ledger(h, app, 'show');
  assert.equal(ran.status, 1);
  assert.equal(ran.stdout, '');
  assert.equal(ran.stderr.trim().split('\n').length, 1, ran.stderr);
  assert.match(ran.stderr, /ledger show <slug>/);
});

test('ledger list --json gives an active task its worktree and no path, and a backlog task neither', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic' });
  backlogTask(h, app, { slug: 'idea' });

  const { tasks } = json(ledger(h, app, 'list', '--json')) as { tasks: Record<string, unknown>[] };

  const epic = tasks.find(({ slug }) => slug === 'epic');
  const idea = tasks.find(({ slug }) => slug === 'idea');
  assert.equal(epic?.worktree, worktreeOf(app, 'epic'));
  assert.equal(epic?.status, 'active');
  assert.equal('path' in (epic ?? {}), false);
  assert.ok(idea);
  assert.equal('worktree' in idea, false);
  assert.equal('path' in idea, false);
});

test('ledger task retire archives the text of the active record, then removes the record and the worktree', (t) => {
  const { h, app, key, store } = setup(t);
  worktreeTask(h, app, { slug: 'fix' });
  const { text } = store().active.read(key, 'fix') ?? assert.fail('no active record');

  ok(ledger(h, app, 'task', 'retire', 'fix', '--force'));

  assert.deepEqual(store().archive.list(key).map((copy) => copy.text), [text]);
  assert.equal(store().active.has(key, 'fix'), false);
  assert.equal(existsSync(worktreeOf(app, 'fix')), false);
});

test('ledger session lists the own active task in a linked worktree, and every active task of the repo in the main checkout', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'a' });
  worktreeTask(h, app, { slug: 'b' });
  const a = worktreeOf(app, 'a');

  const own = json(ledger(h, a, 'session', '--json')) as { own: boolean; ledgers: Record<string, unknown>[] };
  assert.equal(own.own, true);
  assert.deepEqual(own.ledgers.map(({ slug, worktree }) => [slug, worktree]), [['a', a]]);
  assert.equal('path' in own.ledgers[0], false);

  const main = json(ledger(h, app, 'session', '--json')) as { own: boolean; ledgers: { slug: string }[] };
  assert.equal(main.own, false);
  assert.deepEqual(main.ledgers.map(({ slug }) => slug).sort(), ['a', 'b']);
  assert.deepEqual(ok(ledger(h, app, 'session')).trim().split('\n').sort(), [a, worktreeOf(app, 'b')]);
});

test('the worktree-removal guard denies a worktree an active record names, and one that holds a .claude/ledger.md not yet moved into the store', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'task' });
  const task = worktreeOf(app, 'task');
  const loose = path.join(app, '.claude/worktrees/loose');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'loose', loose);
  mkdirSync(path.join(loose, '.claude'), { recursive: true });
  writeFileSync(path.join(loose, '.claude/ledger.md'), ledgerText({ slug: 'loose', worktree: loose }));

  assert.match(JSON.parse(removalGate(h, app, task)).hookSpecificOutput.permissionDecisionReason, new RegExp(`not archived: ${task}`));
  assert.match(JSON.parse(removalGate(h, app, loose)).hookSpecificOutput.permissionDecisionReason, new RegExp(`not yet moved into the ledger store: ${loose}`));
});

test('the task list finds active tasks from the store records and no plain-folder ledger under the scan roots', (t) => {
  const { h } = setup(t);
  const tool = repository(h, path.join(h, 'work/tool'));
  worktreeTask(h, tool, { slug: 'tool-task' });
  const plain = path.join(h, 'repos/notes');
  mkdirSync(path.join(plain, '.claude'), { recursive: true });
  writeFileSync(path.join(plain, '.claude/ledger.md'), ledgerText({ slug: 'notes' }));

  const { tasks } = json(ledger(h, h, 'list', '--json')) as { tasks: { slug: string; worktree?: string }[] };

  assert.deepEqual(tasks.map(({ slug, worktree }) => [slug, worktree]), [['tool-task', worktreeOf(tool, 'tool-task')]]);
});

test('worktrees auto-prune takes the worktree folder only, not the path of its old .claude/ledger.md', (t) => {
  const { h, app, key, store } = setup(t);
  worktreeTask(h, app, { slug: 'done' });
  const done = worktreeOf(app, 'done');
  assert.ok(store().active.update(key, 'done', (text) => text.replace('| 2 | implement | todo |', '| 2 | implement | done |')));

  const byFolder = json(ledger(h, app, 'worktrees', 'auto-prune', done, '--json'));
  assert.deepEqual([byFolder.outcome, byFolder.worktree, byFolder.finished], ['pruned', done, true]);
  assert.ok(existsSync(path.join(done, '.claude/build-folders-pruned')));

  const oldLedger = path.join(done, '.claude/ledger.md');
  const byLedgerPath = ledger(h, app, 'worktrees', 'auto-prune', oldLedger, '--json');
  assert.equal(byLedgerPath.status, 1, byLedgerPath.stdout);
  assert.equal(JSON.parse(byLedgerPath.stdout).error, `No active task has the worktree ${oldLedger}.`);
  assert.equal(json(ledger(h, done, 'worktrees', 'auto-prune', '--json')).outcome, 'unchanged');
});

/** A clone with git storage set up by hand, its marker naming `format`. */
function gitStorage(h: string, format: number): string {
  const clone = path.join(h, '.claude/ledger-data');
  git(h, h, 'init', '--quiet', clone);
  writeFileSync(path.join(clone, '.ledger-data'), `${JSON.stringify({ format })}\n`);
  writeFileSync(path.join(h, '.claude/ledger-settings.json'), JSON.stringify({ storage: 'git' }));
  return clone;
}

const formatOf = (clone: string): unknown => JSON.parse(readFileSync(path.join(clone, '.ledger-data'), 'utf8'));

test('git storage reads a clone of format 1 as it is, and its first write upgrades it to format 2 in a commit of its own', (t) => {
  assert.equal(FORMAT, 2);
  const { h, app } = setup(t);
  const clone = gitStorage(h, 1);

  ok(ledger(h, app, 'list'));
  assert.deepEqual(formatOf(clone), { format: 1 });
  assert.equal(spawnSync('git', ['-C', clone, 'rev-parse', '--verify', '--quiet', 'HEAD']).status, 1, 'a read made a commit');

  ok(ledger(h, app, 'task', 'new', 'idea', '--goal', 'An idea.'));
  assert.deepEqual(formatOf(clone), { format: 2 });
  const [first, ...later] = git(h, clone, 'rev-list', '--reverse', 'HEAD').split('\n');
  const commit = (sha: string): string => git(h, clone, 'show', '--name-only', '--format=%s', sha);
  assert.equal(commit(first), 'Upgrade git storage to format 2\n\n.ledger-data');
  assert.ok(later.some((sha) => commit(sha).includes('idea.json')), later.map(commit).join('\n---\n'));
});

test('git storage with a stray file in a clone of format 1: a read works, and a write fails as its commit would, leaving format 1', (t) => {
  const { h, app, key } = setup(t);
  const clone = gitStorage(h, 1);
  writeFileSync(path.join(clone, 'notes.txt'), 'private\n');

  ok(ledger(h, app, 'list'));
  const ran = ledger(h, app, 'task', 'new', 'idea', '--goal', 'An idea.');

  assert.equal(ran.status, 1, ran.stderr);
  assert.match(ran.stderr, /notes\.txt/);
  assert.deepEqual(formatOf(clone), { format: 1 });
  assert.equal(existsSync(path.join(clone, 'backlog', encodeURIComponent(key), 'idea.json')), false);
});

test('git storage refuses a clone of a format newer than 2', (t) => {
  const { h, app } = setup(t);
  gitStorage(h, 3);

  const ran = ledger(h, app, 'list');

  assert.equal(ran.status, 1, ran.stderr);
  assert.match(ran.stderr, /names a format this ledger does not know/);
});

/** The repo ~/repos/app, its second clone ~/issues/app-b, and the active task x in a worktree of the first. */
function twoClones(t: TestContext) {
  const world = setup(t);
  const second = path.join(world.h, 'issues/app-b');
  git(world.h, world.h, 'clone', '--quiet', path.join(world.h, 'remotes/app.git'), second);
  worktreeTask(world.h, world.app, { slug: 'x' });
  return { ...world, second, taken: worktreeOf(world.app, 'x') };
}

const refusedTaken = (ran: Ran, worktree: string): void => {
  assert.equal(ran.status, 1, ran.stderr);
  assert.match(ran.stderr, /\bx\b/);
  assert.ok(ran.stderr.includes(worktree), ran.stderr);
};

test('ledger go of a slug another clone has active fails, naming the task and its worktree', (t) => {
  const { h, second, taken } = twoClones(t);
  refusedTaken(ledger(h, second, 'go', 'x'), taken);
  assert.equal(existsSync(worktreeOf(second, 'x')), false);
});

test('ledger task new --stack and --here of a slug another clone has active fail, naming the task and its worktree', (t) => {
  const { h, second, taken, key, store } = twoClones(t);
  refusedTaken(ledger(h, second, 'task', 'new', 'x', '--stack'), taken);
  const loose = path.join(second, '.claude/worktrees/loose');
  git(h, second, 'worktree', 'add', '--quiet', '-b', 'loose', loose);
  refusedTaken(ledger(h, loose, 'task', 'new', '--here', 'x'), taken);
  assert.equal(parseLedger(store().active.read(key, 'x')?.text ?? '').location.worktree, taken);
});

test('ledger task retire from a second clone of the repo refuses an active task of the first, also with --dry-run or --force, and changes nothing', (t) => {
  const { h, second, taken, key, store } = twoClones(t);
  const before = store().active.read(key, 'x')?.text;

  for (const flags of [[], ['--dry-run'], ['--force']]) {
    const ran = ledger(h, second, 'task', 'retire', 'x', ...flags);
    refusedTaken(ran, taken);
    assert.match(ran.stderr, /The task x is active in another clone of this repo, in .*\. Retire it from there: cd .* task retire x/, flags.join(' '));
  }

  assert.equal(store().active.read(key, 'x')?.text, before);
  assert.ok(existsSync(taken));
  assert.deepEqual(store().archive.list(key), []);
});

/** An active record whose worktree is not on this machine, as one synced from another machine is. */
function elsewhere(t: TestContext) {
  const world = setup(t);
  const worktree = path.join(world.h, 'other-machine/app/.claude/worktrees/far');
  world.store().active.write(world.key, 'far', ledgerText({ slug: 'far', main: world.app, worktree }));
  return { ...world, worktree };
}

const oneLineRefusal = (ran: Ran, pattern: RegExp): void => {
  assert.equal(ran.status, 1, ran.stderr);
  assert.equal(ran.stderr.trim().split('\n').length, 1, ran.stderr);
  assert.match(ran.stderr, pattern);
};

test('an active record whose worktree is not on this machine is listed as active, marked so', (t) => {
  const { h, app, worktree } = elsewhere(t);

  const { tasks } = json(ledger(h, app, 'list', '--json')) as { tasks: Record<string, unknown>[] };

  const far = tasks.find(({ slug }) => slug === 'far');
  assert.deepEqual([far?.status, far?.worktree, far?.elsewhere, far?.host], ['active', worktree, true, 'unknown host']);
  assert.match(ok(ledger(h, app, 'list')), /active on unknown host/);
});

test('notes, park and go refuse an active task whose worktree is not on this machine, in one line', (t) => {
  const { h, app, key, store } = elsewhere(t);
  const before = store().active.read(key, 'far')?.text;

  oneLineRefusal(ledger(h, app, 'notes', 'note', 'From here.', '--task', 'far'), /not on this machine/);
  oneLineRefusal(ledger(h, app, 'task', 'park', 'far', '--reason', 'later'), /not on this machine/);
  oneLineRefusal(ledger(h, app, 'go', 'far'), /not on this machine/);

  assert.equal(store().active.read(key, 'far')?.text, before);
});

test('ledger task retire of an active task whose worktree is not on this machine needs --force, then archives and removes the record', (t) => {
  const { h, app, key, store } = elsewhere(t);
  const { text } = store().active.read(key, 'far') ?? assert.fail('no active record');

  const refused = ledger(h, app, 'task', 'retire', 'far');
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /may be live on another machine/);
  assert.match(refused.stderr, /--force/);
  assert.ok(store().active.has(key, 'far'));
  assert.deepEqual(store().archive.list(key), []);

  ok(ledger(h, app, 'task', 'retire', 'far', '--force'));
  assert.deepEqual(store().archive.list(key).map((copy) => copy.text), [text]);
  assert.equal(store().active.has(key, 'far'), false);
});

test('two active records naming one worktree are both listed, and only the lookup of that worktree fails, naming both', (t) => {
  const { h, app, key, store } = setup(t);
  worktreeTask(h, app, { slug: 'a' });
  store().active.write(key, 'b', ledgerText({ slug: 'b', main: app, worktree: worktreeOf(app, 'a') }));

  const { tasks } = json(ledger(h, app, 'list', '--json')) as { tasks: { slug: string }[] };
  assert.deepEqual(tasks.map(({ slug }) => slug).sort(), ['a', 'b']);

  const ran = ledger(h, worktreeOf(app, 'a'), 'show');
  assert.equal(ran.status, 1, ran.stderr);
  assert.match(ran.stderr, /\ba\b.*\bb\b|\bb\b.*\ba\b/);
});

test('the clone allowlist takes active records only as JSON', () => {
  assert.equal(isAllowed('active/app/task.json'), true);
  assert.equal(isAllowed('active/app/task.md'), false);
  assert.equal(isAllowed('backlog/app/task.md'), true);
});

test('the pre-push hook allowlist takes active records only as JSON', () => {
  const script = prePushHook();
  const start = script.indexOf('ledger_path=');
  const end = script.indexOf('\n}\n', script.indexOf('is_ledger() {')) + 3;
  const isLedger = (file: string): boolean => spawnSync('bash', ['-c', `${script.slice(start, end)}\nis_ledger "$1"`, 'is_ledger', file]).status === 0;
  assert.equal(isLedger('active/app/task.json'), true);
  assert.equal(isLedger('active/app/task.md'), false);
  assert.equal(isLedger('backlog/app/task.md'), true);
  assert.equal(isLedger('active/../task.json'), false);
});

test('store migrate --repo-ids files an active record kept under a folder name under the repo key', (t) => {
  const { h, app, key, store } = setup(t);
  store().active.write('app', 'live', ledgerText({ slug: 'live', main: app, worktree: worktreeOf(app, 'live') }));

  ok(ledger(h, h, 'store', 'migrate', '--repo-ids'));

  assert.equal(store().active.has('app', 'live'), false);
  assert.equal(parseLedger(store().active.read(key, 'live')?.text ?? '').slug, 'live');
});

test('sqlite: reopening a database whose records table was rebuilt for active records does not rebuild it again', { skip: noSqlite }, (t) => {
  const h = home(t);
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const old = new DatabaseSync(sqliteFile(h));
  old.exec(`CREATE TABLE records (
    place TEXT NOT NULL CHECK (place IN ('backlog', 'archive')), repo TEXT NOT NULL, name TEXT NOT NULL,
    record TEXT NOT NULL, mtime REAL NOT NULL, birthtime REAL NOT NULL, PRIMARY KEY (place, repo, name)
  ) STRICT`);
  old.close();
  const schemaVersion = (): number => {
    const db = new DatabaseSync(sqliteFile(h));
    try {
      return Number(db.prepare('PRAGMA schema_version').get()?.schema_version);
    } finally {
      db.close();
    }
  };

  sqliteStore({ home: h }).close?.();
  const rebuilt = schemaVersion();
  sqliteStore({ home: h }).close?.();

  assert.equal(schemaVersion(), rebuilt);
});

test('store migrate counts active ledgers as it counts backlog ledgers: no line per ledger in a dry run, and always in the removed line', { skip: noSqlite }, (t) => {
  const { h, app, key, store } = setup(t);
  backlogTask(h, app, { slug: 'idea' });
  store().active.write(key, 'live', ledgerText({ slug: 'live', worktree: worktreeOf(app, 'live') }));
  const run = (...args: string[]): string => ok(ledger(h, h, 'store', 'migrate', '--to', 'sqlite', ...args));

  const dry = run('--dry-run', '--remove-source');
  assert.doesNotMatch(dry, /^\s+active /m);
  assert.doesNotMatch(dry, /^\s+backlog /m);
  assert.match(dry, /would remove 1 backlog ledger, 1 active ledger\b/i);

  store().active.remove(key, 'live', store().active.read(key, 'live')?.text ?? '');
  assert.match(run('--remove-source'), /removed 1 backlog ledger, 0 active ledgers\b/i);
});

/** Every git command line the ledger commands of `h` run, one per line, from a git on their PATH that logs and passes on. */
function gitLog(h: string): { calls: () => string[]; clear: () => void } {
  const log = path.join(h, 'git-calls');
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path.join(h, 'stub-bin/git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  return { calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []), clear: () => writeFileSync(log, '') };
}

test('listing active tasks costs git no call per record, and at most one worktree listing per clone', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'one' });
  const { calls, clear } = gitLog(h);
  const measured = (run: () => unknown): string[] => (clear(), run(), calls());

  const withOne = measured(() => ok(ledger(h, app, 'list', '--json')));
  for (const slug of ['two', 'three']) worktreeTask(h, app, { slug });
  const withThree = measured(() => ok(ledger(h, app, 'list', '--json')));
  const prompt = (): string => hook(h, 'prompt-submit', { cwd: app, prompt: 'go three' });
  const promptWithThree = measured(prompt);

  assert.ok(withOne.length > 0 && promptWithThree.length > 0, 'the stub git logged no call, so the counts below would prove nothing');
  assert.equal(withThree.length, withOne.length, withThree.join('\n'));
  assert.ok(withThree.filter((call) => call.includes('worktree list')).length <= 1, withThree.join('\n'));
  assert.equal(promptWithThree.filter((call) => call.includes('worktree list') || call.includes('--git-common-dir')).length <= 1, true, promptWithThree.join('\n'));
});

test('ledger task new --here refuses a slug of the backlog, and of an active task filed under an old key of the repo', (t) => {
  const { h, app, key, store } = setup(t);
  backlogTask(h, app, { slug: 'idea' });
  store().aliases.add('app', key);
  store().active.write('app', 'old', ledgerText({ slug: 'old', main: app, worktree: worktreeOf(app, 'old') }));
  const loose = path.join(app, '.claude/worktrees/loose');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'loose', loose);

  const backlog = ledger(h, loose, 'task', 'new', '--here', 'idea');
  assert.equal(backlog.status, 1, backlog.stderr);
  assert.match(backlog.stderr, /backlog task idea/);
  const aliased = ledger(h, loose, 'task', 'new', '--here', 'old');
  assert.equal(aliased.status, 1, aliased.stderr);
  assert.ok(aliased.stderr.includes(worktreeOf(app, 'old')), aliased.stderr);
  assert.equal(store().active.has(key, 'idea') || store().active.has(key, 'old'), false);
});

test('ledger task new of a slug that is active in the repo fails, naming its worktree', (t) => {
  const { h, app, key, store } = setup(t);
  const worktree = path.join(h, 'other-machine/app/.claude/worktrees/busy');
  store().active.write(key, 'busy', ledgerText({ slug: 'busy', main: app, worktree }));

  const ran = ledger(h, app, 'task', 'new', 'busy', '--goal', 'Again.');

  assert.equal(ran.status, 1, ran.stderr);
  assert.ok(ran.stderr.includes(worktree), ran.stderr);
  assert.equal(store().backlog.has(key, 'busy'), false);
});

test('the worktree-removal guard denies removing a folder two active records name, naming both', (t) => {
  const { h, app, key, store } = setup(t);
  worktreeTask(h, app, { slug: 'a' });
  store().active.write(key, 'b', ledgerText({ slug: 'b', main: app, worktree: worktreeOf(app, 'a') }));

  const output = removalGate(h, app, worktreeOf(app, 'a'));

  assert.notEqual(output, '', 'the removal was allowed');
  const reason: string = JSON.parse(output).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /\/a\b/);
  assert.match(reason, /\/b\b/);
});

test('session-start in a main checkout names no undefined worktree for an active record that names none', (t) => {
  const { h, app, key, store } = setup(t);
  worktreeTask(h, app, { slug: 'a' });
  store().active.write(key, 'bare', '# Task ledger — bare\n\n## Goal\nA goal.\n\n## Next step\nA step.\n');

  const context: string = JSON.parse(hook(h, 'session-start', { cwd: app })).hookSpecificOutput.additionalContext;

  assert.match(context, /^- bare active$/m);
  assert.doesNotMatch(context, /undefined/);
});

test('an active record whose worktree folder exists but is no worktree of its clone is elsewhere, and retire --force retires it', (t) => {
  const { h, app, key, store } = setup(t);
  const folder = worktreeOf(app, 'stale');
  mkdirSync(folder, { recursive: true });
  store().active.write(key, 'stale', ledgerText({ slug: 'stale', main: app, worktree: folder }));

  const { tasks } = json(ledger(h, app, 'list', '--json')) as { tasks: Record<string, unknown>[] };
  assert.equal(tasks.find(({ slug }) => slug === 'stale')?.elsewhere, true);

  ok(ledger(h, app, 'task', 'retire', 'stale', '--force'));
  assert.equal(store().active.has(key, 'stale'), false);
  assert.ok(existsSync(folder), 'retire removed a folder that is no worktree');
});

test('an active record whose worktree path is a checkout of a repo with another key is elsewhere, and retire --force leaves that checkout', (t) => {
  const { h, app, key, store } = setup(t);
  const other = repository(h, path.join(h, 'repos/other'));
  const folder = worktreeOf(other, 'x');
  git(h, other, 'worktree', 'add', '--quiet', '-b', 'me/x', folder);
  store().active.write(key, 'x', ledgerText({ slug: 'x', main: app, worktree: folder }));

  const { tasks } = json(ledger(h, app, 'list', '--json')) as { tasks: Record<string, unknown>[] };
  assert.equal(tasks.find(({ slug }) => slug === 'x')?.elsewhere, true);

  ok(ledger(h, app, 'task', 'retire', 'x', '--force'));
  assert.equal(store().active.has(key, 'x'), false);
  assert.ok(existsSync(folder), 'retire removed the checkout of the other repo');
});

test('ledger task retire with no slug, in a folder two active records name, refuses, names both slugs, and removes nothing', (t) => {
  const { h, app, key, store } = setup(t);
  worktreeTask(h, app, { slug: 'a' });
  store().active.write(key, 'b', ledgerText({ slug: 'b', main: app, worktree: worktreeOf(app, 'a') }));

  for (const flags of [[], ['--force']]) {
    const ran = ledger(h, worktreeOf(app, 'a'), 'task', 'retire', ...flags);
    assert.equal(ran.status, 1, ran.stdout);
    assert.match(ran.stderr, /\ba\b.*\bb\b|\bb\b.*\ba\b/, flags.join(' '));
  }
  assert.ok(existsSync(worktreeOf(app, 'a')));
  assert.ok(store().active.has(key, 'a') && store().active.has(key, 'b'));
  assert.deepEqual(store().archive.list(key), []);
});

/** A worktree task whose .claude/evidence/ holds red.txt, and which git ignores, as excludeEvidence makes it. */
function taskWithEvidence(t: TestContext, slug: string) {
  const world = setup(t);
  worktreeTask(world.h, world.app, { slug });
  writeFileSync(path.join(world.app, '.git/info/exclude'), '.claude/\n');
  const evidence = path.join(worktreeOf(world.app, slug), '.claude/evidence');
  mkdirSync(evidence);
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  return { ...world, worktree: worktreeOf(world.app, slug), evidence };
}

test('ledger task retire --force finishes a retire that stopped after it archived the task and removed its worktree', (t) => {
  const { h, app, key, store, worktree, evidence } = taskWithEvidence(t, 'fix');
  const { text } = store().active.read(key, 'fix') ?? assert.fail('no active record');
  store().archive.write(key, '2026-11-01-fix', text, evidence);
  git(h, app, 'worktree', 'remove', '--force', worktree);

  ok(ledger(h, app, 'task', 'retire', 'fix', '--force'));

  assert.equal(store().active.has(key, 'fix'), false);
  assert.deepEqual(store().archive.list(key).map((copy) => copy.text), [text]);
});

test('a second ledger task retire finishes one whose worktree removal failed halfway, after it deleted the evidence', (t) => {
  const { h, app, key, store, worktree, evidence } = taskWithEvidence(t, 'fix');
  const { text } = store().active.read(key, 'fix') ?? assert.fail('no active record');
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const stub = path.join(h, 'stub-bin/git');
  writeFileSync(stub, `#!/bin/sh\ncase "$*" in *"worktree remove"*) rm -rf '${evidence}'; echo "fatal: refused by the test" >&2; exit 128 ;; esac\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const first = ledger(h, app, 'task', 'retire', 'fix');
  rmSync(stub);
  assert.equal(first.status, 1, first.stdout);
  assert.match(first.stderr, /Could not remove the worktree/);
  assert.ok(existsSync(worktree) && !existsSync(evidence), 'the stub did not leave a worktree without its evidence');

  const second = ledger(h, app, 'task', 'retire', 'fix');

  assert.equal(second.status, 0, second.stderr);
  assert.equal(store().active.has(key, 'fix'), false);
  assert.deepEqual(store().archive.list(key).map((copy) => copy.text), [text]);
  assert.equal(existsSync(worktree), false);
});

test('ledger task new --here refuses a worktree whose .claude/ledger.md is not moved into the store yet, and names ledger store migrate --active', (t) => {
  const { h, app, key, store } = setup(t);
  const loose = path.join(app, '.claude/worktrees/loose');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'loose', loose);
  mkdirSync(path.join(loose, '.claude'));
  writeFileSync(path.join(loose, '.claude/ledger.md'), ledgerText({ slug: 'old', worktree: loose }));

  const ran = ledger(h, loose, 'task', 'new', '--here');

  assert.equal(ran.status, 1, ran.stdout);
  assert.match(ran.stderr, /ledger store migrate --active/);
  assert.deepEqual(store().active.list(key), []);
  assert.ok(existsSync(path.join(loose, '.claude/ledger.md')));
});

test('git storage of format 1 whose upgrade commit failed upgrades in a commit of its own at the next write', (t) => {
  const { h, app } = setup(t);
  const clone = gitStorage(h, 1);
  git(h, clone, 'add', '.ledger-data');
  git(h, clone, 'commit', '--quiet', '-m', 'format 1');
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const stub = path.join(h, 'stub-bin/git');
  writeFileSync(stub, `#!/bin/sh\ncase "$*" in *"commit --quiet --no-verify -m Upgrade"*) exit 1 ;; esac\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const failed = ledger(h, app, 'task', 'new', 'first', '--goal', 'A first idea.');
  rmSync(stub);
  assert.equal(failed.status, 1, failed.stdout);

  ok(ledger(h, app, 'task', 'new', 'second', '--goal', 'A second idea.'));

  const commits = git(h, clone, 'rev-list', 'HEAD').split('\n').map((sha) => git(h, clone, 'show', '--name-only', '--format=%s', sha));
  assert.ok(commits.includes('Upgrade git storage to format 2\n\n.ledger-data'), commits.join('\n---\n'));
  assert.equal(git(h, clone, 'show', 'HEAD:.ledger-data'), JSON.stringify({ format: 2 }));
});

test('store migrate --to sqlite stops, and changes nothing, when an active slug is a backlog slug of the target, or two active records would name one worktree', { skip: noSqlite }, (t) => {
  for (const clash of ['backlog', 'worktree'] as const) {
    const { h, app, key, store } = setup(t);
    store().active.write(key, 'x', ledgerText({ slug: 'x', main: app, worktree: worktreeOf(app, 'x') }));
    const target = sqliteStore({ home: h });
    if (clash === 'backlog') target.backlog.write(key, 'x', ledgerText({ slug: 'x', main: app }));
    else target.active.write(key, 'y', ledgerText({ slug: 'y', main: app, worktree: worktreeOf(app, 'x') }));
    target.close?.();

    const ran = ledger(h, h, 'store', 'migrate', '--to', 'sqlite');

    assert.equal(ran.status, 1, `${clash}: ${ran.stdout}`);
    assert.match(ran.stderr, /stopped, and nothing changed/, clash);
    assert.ok(ran.stderr.includes(clash === 'backlog' ? 'x' : worktreeOf(app, 'x')), ran.stderr);
    assert.equal(existsSync(path.join(h, '.claude/ledger-settings.json')), false, `${clash}: the setting was switched`);
  }
});

test('ledger task retire --json of an active task whose worktree is not on this machine gives its place as active', (t) => {
  const { h, app } = elsewhere(t);

  const retired = json(ledger(h, app, 'task', 'retire', 'far', '--force', '--json'));

  assert.equal(retired.place, 'active');
});

/** A linked worktree of `app` on a branch of its own, with no task yet. */
function looseWorktree(h: string, app: string, name: string): string {
  const folder = worktreeOf(app, name);
  git(h, app, 'worktree', 'add', '--quiet', '-b', name, folder);
  return folder;
}

const recordsNaming = (store: LedgerStore, key: string, worktree: string): string[] =>
  store.active.list(key).flatMap(({ name, text }) => (parseLedger(text).location.worktree === worktree ? [name] : []));

test('of two ledger task new --here in one worktree, the one that checks while the other writes is refused: one record names the worktree', (t) => {
  const { h, app, key, store } = setup(t);
  const loose = looseWorktree(h, app, 'loose');
  const paths = ledgerPaths(h);
  const files = store();
  let second: unknown;
  // The second command runs whole between the check and the create of the first.
  const racing: LedgerStore = {
    ...files,
    active: {
      ...files.active,
      create: (repo, slug, text) => {
        limitLockWaits(Date.now() + 200);
        try {
          second = createTask({ paths, cwd: loose, store: files }, 'second', { here: true });
        } catch (error) {
          second = error;
        } finally {
          limitLockWaits(Infinity);
        }
        return files.active.create(repo, slug, text);
      },
    },
  };

  createTask({ paths, cwd: loose, store: racing }, 'first', { here: true });

  assert.ok(second instanceof Error, 'the second --here went through');
  assert.deepEqual(recordsNaming(store(), key, loose), ['first']);
});

test('a write to an active task whose record a pull replaced with one of another machine is refused, and the pulled record stays', (t) => {
  const { h, app, key, store } = setup(t);
  worktreeTask(h, app, { slug: 'fix' });
  const worktree = worktreeOf(app, 'fix');
  const context = { paths: ledgerPaths(h), cwd: worktree, store: store() };
  const task = currentTask(context.store, worktree) ?? assert.fail('no task in its worktree');
  store().active.write(key, 'fix', ledgerText({ slug: 'fix', worktree }).replace('- design refs: none\n', '- design refs: none\n- host: other-host\n'));
  const pulled = store().active.read(key, 'fix')?.text;

  assert.throws(() => updateLedger(context, task, (text) => text.replace('## Next step\n', '## Next step\nA note.\n')), /other-host/);
  assert.equal(store().active.read(key, 'fix')?.text, pulled);
});

test('ledger task new --here and --stack make no active record while "host" is no host label, and say how to fix it', (t) => {
  const { h, app, key, store } = setup(t);
  worktreeTask(h, app, { slug: 'epic' });
  const loose = looseWorktree(h, app, 'loose');
  writeFileSync(path.join(h, '.claude/ledger-settings.json'), JSON.stringify({ host: 'Not A Label' }));

  for (const [cwd, args] of [[loose, ['--here']], [worktreeOf(app, 'epic'), ['side', '--stack']]] as const) {
    const ran = ledger(h, cwd, 'task', 'new', ...args);
    assert.equal(ran.status, 1, ran.stdout);
    assert.match(ran.stderr, /"host"/);
  }
  assert.deepEqual(recordsNaming(store(), key, loose), []);
  assert.equal(store().active.has(key, 'side'), false);
  assert.equal(existsSync(worktreeOf(app, 'side')), false);
});

test('ledger task new --here and --stack make no active record from a template with no "- worktree:" bullet, and say so', (t) => {
  const { h, app, key, store } = setup(t);
  worktreeTask(h, app, { slug: 'epic' });
  const loose = looseWorktree(h, app, 'loose');
  const template = path.join(h, '.claude/ledger.template.md');
  writeFileSync(template, readFileSync(template, 'utf8').replace(/^- worktree:.*\n/m, ''));

  for (const [cwd, args] of [[loose, ['--here']], [worktreeOf(app, 'epic'), ['side', '--stack']]] as const) {
    const ran = ledger(h, cwd, 'task', 'new', ...args);
    assert.equal(ran.status, 1, ran.stdout);
    assert.match(ran.stderr, /worktree/);
  }
  assert.deepEqual(recordsNaming(store(), key, loose), []);
  assert.equal(store().active.has(key, 'side'), false);
  assert.equal(existsSync(worktreeOf(app, 'side')), false);
});

test('ledger task new --here and --stack make no active record from a template with no ## Location section, and say so', (t) => {
  const { h, app, key, store } = setup(t);
  worktreeTask(h, app, { slug: 'epic' });
  const loose = looseWorktree(h, app, 'loose');
  const template = path.join(h, '.claude/ledger.template.md');
  writeFileSync(template, readFileSync(template, 'utf8').replace(/^## Location\n(?:- .*\n)*\n/m, ''));

  for (const [cwd, args] of [[loose, ['--here']], [worktreeOf(app, 'epic'), ['side', '--stack']]] as const) {
    const ran = ledger(h, cwd, 'task', 'new', ...args);
    assert.equal(ran.status, 1, ran.stdout);
    assert.match(ran.stderr, /## Location/);
    assert.doesNotMatch(ran.stderr, /no host label/);
  }
  assert.deepEqual(recordsNaming(store(), key, loose), []);
  assert.equal(store().active.has(key, 'side'), false);
  assert.equal(existsSync(worktreeOf(app, 'side')), false);
});
