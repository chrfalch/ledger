import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs, { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { GITIGNORE, isAllowed } from '../tools/ledger/clone.js';
import { Failure } from '../tools/ledger/failure.js';
import { readTimedText } from '../tools/ledger/files.js';
import { gitStore } from '../tools/ledger/git-store.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { parseRecord, recordJson } from '../tools/ledger/record.js';
import { executeRetire, planRetire, readRetire, type Output } from '../tools/ledger/retire.js';
import * as settings from '../tools/ledger/settings.js';
import type { LedgerStore } from '../tools/ledger/store.js';
import { allowRemoteForTests, syncLedgers } from '../tools/ledger/sync.js';
import type { Context } from '../tools/ledger/write.js';
import { REPO } from './helpers.js';
import { asCli, git, home, LEDGER_BIN, ledgerText, noSqlite, ok, worktreeTask, type Ran } from './ledger-core-fixtures.js';
import {
  answerGh,
  APP,
  APP_KEY,
  APP_ORIGIN,
  backgroundPids,
  failed,
  gitRan,
  GITHUB_TOKEN,
  hookContext,
  hookFile,
  ledgerOk,
  lineOf,
  machine,
  machineEnv,
  plainClone,
  quietEnv,
  remote,
  remoteFiles,
  remoteHead,
  remoteText,
  run,
  runs,
  today,
  until,
  URL,
  type Machine,
} from './ledger-git-fixtures.js';

/** The .gitignore that `ledger store sync init` wrote before active copies existed. */
const GITIGNORE_BEFORE_ACTIVE = [
  '# Written by ledger store sync init. Only the ledgers and these setup files are pushed.',
  '*',
  '!/.ledger-data',
  '!/.gitignore',
  '!/backlog/',
  '!/backlog/*/',
  '!/backlog/*/*.md',
  '!/archive/',
  '!/archive/*/',
  '!/archive/*/*.md',
  '',
].join('\n');

/** The pre-push hook ledger installed before active copies existed: it lets only backlog and archive ledgers through. */
const HOOK_BEFORE_ACTIVE = readFileSync(path.join(REPO, 'tests/fixtures/ledger-pre-push-before-active.sh'), 'utf8');

type Listed = { slug: string; status: string; place?: string; host?: string };

const SLUG = 'fix-login';

// Root reads and writes past every permission bit.
const asRoot = process.getuid?.() === 0;

/** Where a machine named `host` keeps the active copy of the task `slug` of the repo `app`, in the folder of its repo key. */
const copyOf = (host: string, slug = SLUG): string => `active/${host}/${APP}/${slug}.md`;

const writeSettings = (m: Machine, fields: object): void => writeFileSync(path.join(m.h, '.claude/ledger-settings.json'), JSON.stringify(fields));

/** `ledger store sync init`, then git storage on a machine named `host`. */
function setUpAs(m: Machine, host: string): void {
  ok(run(m, ['store', 'sync', 'init', URL]));
  writeSettings(m, { storage: 'git', host });
}

/** A backlog task that `ledger go` started: its worktree ledger. */
function startTask(m: Machine, slug = SLUG): string {
  ledgerOk(m, 'task', 'new', slug, '--goal', 'Users cannot log in.');
  ledgerOk(m, 'go', slug);
  const ledger = path.join(m.app, '.claude/worktrees', slug, '.claude/ledger.md');
  assert.ok(existsSync(ledger), `ledger go made no worktree ledger at ${ledger}`);
  return ledger;
}

const commits = (m: Machine): number => Number(git(m.h, m.clone, 'rev-list', '--count', 'HEAD'));

const inHead = (m: Machine, file: string): boolean => gitRan(m.h, m.clone, 'cat-file', '-e', `HEAD:${file}`).status === 0;

const headText = (m: Machine, file: string): string => gitRan(m.h, m.clone, 'show', `HEAD:${file}`).stdout;

const listed = (m: Machine, ...args: string[]): Listed[] => (JSON.parse(ledgerOk(m, 'list', ...args, '--json')) as { tasks: Listed[] }).tasks;

const linesWith = (text: string, needle: string): string[] => text.split('\n').filter((line) => line.includes(needle));

/** Machine A, named host-a, with a started task whose copy it mirrored and pushed; machine B, named host-b, synced after it. */
function twoMachines(t: TestContext) {
  const bare = remote(t);
  const a = machine(t, bare);
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  ledgerOk(a, 'store', 'sync');
  const b = machine(t, bare);
  answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });
  setUpAs(b, 'host-b');
  ledgerOk(b, 'store', 'sync');
  return { bare, a, b, ledger };
}

// ------------------------------------------------------------------------------------------------------------ host name

test('hostLabel is the host name up to its first dot, in lowercase, with each character outside a-z, 0-9 and - as -', () => {
  assert.equal(typeof settings.hostLabel, 'function', 'settings.ts exports no hostLabel');
  const cases: [string, string][] = [
    ['Christians-MacBook-Pro.local', 'christians-macbook-pro'],
    ['My Mac_2', 'my-mac-2'],
    ['build-01.ci.example.com', 'build-01'],
    ['plain', 'plain'],
  ];
  for (const [raw, label] of cases) assert.equal(settings.hostLabel(raw), label, raw);
});

test('hostLabel trims the hyphens at either end', () => {
  assert.equal(settings.hostLabel('_Mac_.local'), 'mac');
  assert.equal(settings.hostLabel('___'), '');
});

test('a host name that gives no label fails and says to set "host" in the settings file', (t) => {
  const h = home(t);
  t.mock.method(os, 'hostname', () => '___');

  assert.throws(
    () => settings.readHost(h),
    (error: unknown) => error instanceof Failure && /"host"/.test(error.message) && error.message.includes('~/.claude/ledger-settings.json'),
  );
});

test('a "host" setting that is no label fails and says to set "host" in the settings file', (t) => {
  const h = home(t);
  for (const host of ['Work Laptop', 'work_laptop', '', 7]) {
    writeFileSync(path.join(h, '.claude/ledger-settings.json'), JSON.stringify({ storage: 'git', host }));
    assert.throws(
      () => settings.readHost(h),
      (error: unknown) => error instanceof Failure && /"host"/.test(error.message) && error.message.includes('~/.claude/ledger-settings.json'),
      JSON.stringify(host),
    );
  }
});

test('the allowlist takes a host folder only as lowercase letters, digits and hyphens', () => {
  assert.ok(isAllowed('active/work-laptop-2/app/fix-login.md'));
  for (const host of ['Work-Laptop', 'work_laptop', 'work laptop', 'work.laptop']) assert.equal(isAllowed(`active/${host}/app/fix-login.md`), false, host);
});

test('ledger store sync and the pre-push hook of a manual git push both refuse a copy in a host folder that is no label', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUpAs(a, 'host-a');
  ledgerOk(a, 'store', 'sync');
  const before = remoteHead(bare);
  const file = 'active/Host_A/app/fix-login.md';
  mkdirSync(path.dirname(path.join(a.clone, file)), { recursive: true });
  writeFileSync(path.join(a.clone, file), ledgerText({ slug: SLUG, main: a.app }));
  git(a.h, a.clone, 'add', '-f', '--', file);
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'by hand');

  const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');
  const synced = run(a, ['store', 'sync']);

  for (const [who, ran] of [['git push', pushed], ['ledger store sync', synced]] as const) {
    assert.notEqual(ran.status, 0, `${who} was not blocked`);
    assert.ok(`${ran.stdout}${ran.stderr}`.includes(file), `${who} does not name ${file}:\n${ran.stdout}${ran.stderr}`);
  }
  assert.equal(remoteHead(bare), before);
});

test('with a "host" that is no label, the session start still exits 0 and ledger store mirror --quiet prints nothing', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  writeSettings(a, { storage: 'git', host: 'Work Laptop' });

  const started = run(a, ['hook', 'session-start'], { cwd: a.app, input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: a.app }) });
  const mirrored = run(a, ['store', 'mirror', '--quiet']);

  assert.equal(started.status, 0, started.stderr);
  assert.equal(mirrored.stdout, '');
  assert.equal(mirrored.stderr, '');
});

test('without "host" in the settings, a machine keeps its copies under the label of its host name', (t) => {
  const a = machine(t, remote(t));
  ok(run(a, ['store', 'sync', 'init', URL]));
  writeSettings(a, { storage: 'git' });
  startTask(a);

  ledgerOk(a, 'store', 'mirror');

  const copy = copyOf(settings.hostLabel(os.hostname()));
  assert.ok(inHead(a, copy), `no ${copy} in the clone`);
});

// --------------------------------------------------------------------------------------------------------------- mirror

test('ledger store mirror commits a copy of each worktree ledger of this machine, and another machine lists it as on host-a', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  const before = commits(a);

  ok(run(a, ['store', 'mirror'], { cwd: a.h }));

  assert.equal(commits(a), before + 1);
  assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');
  assert.deepEqual(git(a.h, a.clone, 'show', '--name-only', '--format=', 'HEAD').split('\n'), [copyOf('host-a')]);
  assert.equal(headText(a, copyOf('host-a')), readFileSync(ledger, 'utf8'));

  ledgerOk(a, 'store', 'sync');
  assert.ok(remoteFiles(bare).includes(copyOf('host-a')), 'the copy is not on the remote');
  const b = machine(t, bare);
  answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });
  setUpAs(b, 'host-b');
  ledgerOk(b, 'store', 'sync');

  assert.match(linesWith(ledgerOk(b, 'list'), SLUG).join('\n'), /on host-a/);
  const entries = listed(b).filter(({ slug }) => slug === SLUG);
  assert.equal(entries.length, 1, JSON.stringify(entries));
  assert.equal(entries[0].place, 'remote');
  assert.equal(entries[0].host, 'host-a');
});

test('ledger show of a task on another machine says it is read-only and on which host, then prints the copy unchanged', (t) => {
  const { b, ledger } = twoMachines(t);
  const text = readFileSync(ledger, 'utf8');

  const shown = ledgerOk(b, 'show', SLUG);

  const firstLine = shown.split('\n')[0];
  assert.match(firstLine, /read-only/);
  assert.match(firstLine, /host-a/);
  assert.ok(shown.endsWith(text), `the copy is not printed unchanged:\n${shown}`);
  assert.equal(shown.slice(0, shown.length - text.length).trim(), firstLine.trim(), 'more than one line before the copy');
});

test('ledger go of a task on another machine exits non-zero, names the host, says it is read-only, and creates nothing', (t) => {
  const { b } = twoMachines(t);
  const head = git(b.h, b.clone, 'rev-parse', 'HEAD');

  const ran = run(b, ['go', SLUG]);

  assert.notEqual(ran.status, 0, ran.stdout);
  assert.match(ran.stderr, /host-a/);
  assert.match(ran.stderr, /read-only/);
  assert.equal(existsSync(path.join(b.app, '.claude/worktrees', SLUG)), false, 'a worktree was made');
  assert.equal(git(b.h, b.app, 'branch', '--list', `*${SLUG}*`), '', 'a branch was made');
  assert.equal(git(b.h, b.clone, 'rev-parse', 'HEAD'), head);
  assert.equal(git(b.h, b.clone, 'status', '--porcelain'), '');
});

test('ledger store mirror updates a copy whose worktree ledger changed, and commits nothing when nothing changed', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  appendFileSync(ledger, '- Decided on host A after the first copy.\n');
  const before = commits(a);

  ledgerOk(a, 'store', 'mirror');

  assert.equal(commits(a), before + 1);
  assert.equal(headText(a, copyOf('host-a')), readFileSync(ledger, 'utf8'));

  ledgerOk(a, 'store', 'mirror');

  assert.equal(commits(a), before + 1, 'a mirror with nothing changed made a commit');
  assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');
});

test('offline, ledger store mirror --quiet prints nothing and exits 0 with the copy committed, and the next sync pushes it', async (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUpAs(a, 'host-a');
  startTask(a);
  renameSync(bare, `${bare}.away`);

  const quiet = run(a, ['store', 'mirror', '--quiet'], { env: machineEnv(a) });

  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, '');
  assert.equal(quiet.stderr, '');
  assert.ok(inHead(a, copyOf('host-a')), 'the copy is not committed');
  // The mirror notes the pid before it exits, so the push it started is waited for, not raced.
  const pids = readFileSync(backgroundPids(a.h), 'utf8').split('\n').filter(Boolean).map(Number);
  assert.equal(pids.length, 1, 'the mirror started no background push');
  await until(() => !pids.some(runs), 'the end of the background sync');

  renameSync(`${bare}.away`, bare);
  ledgerOk(a, 'store', 'sync');
  assert.ok(remoteFiles(bare).includes(copyOf('host-a')), 'the copy is not on the remote');
});

test('ledger store mirror keeps the copy of a task whose repo it cannot read', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  renameSync(a.app, `${a.app}.away`);

  ok(run(a, ['store', 'mirror'], { cwd: a.h }));

  assert.ok(inHead(a, copyOf('host-a')), 'the copy of a repo that is away was removed');
});

test('ledger store mirror keeps the copy of a task when git cannot list the worktrees of its repo', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path.join(a.h, 'stub-bin/git'), `#!/bin/sh\ncase "$*" in *"worktree list"*) echo "fatal: no list" >&2; exit 128 ;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });

  ok(run(a, ['store', 'mirror']));

  assert.ok(inHead(a, copyOf('host-a')), 'the copy was removed though git could not list the worktrees');
});

test('ledger store mirror keeps the copy of a worktree ledger it cannot read', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  chmodSync(ledger, 0o000);

  ok(run(a, ['store', 'mirror']));

  assert.ok(inHead(a, copyOf('host-a')), 'the copy of an unreadable worktree ledger was removed');
});

test('ledger store mirror neither copies a worktree ledger that is a symbolic link nor removes its copy', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const copied = headText(a, copyOf('host-a'));
  const elsewhere = path.join(a.h, 'elsewhere.md');
  writeFileSync(elsewhere, ledgerText({ slug: SLUG, main: a.app, goal: 'Text from outside the worktree.' }));
  rmSync(ledger);
  symlinkSync(elsewhere, ledger);

  ok(run(a, ['store', 'mirror']));

  assert.equal(headText(a, copyOf('host-a')), copied, 'the copy took the text the link points to, or was removed');
});

test('ledger store mirror --quiet stops git after 5 s, as the session start does, and keeps the copy', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path.join(a.h, 'stub-bin/git'), `#!/bin/sh\ncase "$*" in *"worktree list"*) exec sleep 10 ;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
  const startUp = Date.now();
  ok(run(a, ['--help']));
  const startUpMs = Date.now() - startUp;

  const started = Date.now();
  const ran = run(a, ['store', 'mirror', '--quiet']);
  const ms = Date.now() - started;

  assert.equal(ran.stderr, '');
  assert.ok(ms - startUpMs < 6000, `the mirror took ${ms - startUpMs} ms after start-up`);
  rmSync(path.join(a.h, 'stub-bin/git'));
  assert.ok(inHead(a, copyOf('host-a')), 'the copy was removed though git did not answer');
});

test('ledger store mirror --quiet prints nothing when its commit fails', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  writeFileSync(path.join(a.clone, 'notes.txt'), 'not a ledger\n');
  git(a.h, a.clone, 'add', '-f', '--', 'notes.txt');

  const quiet = run(a, ['store', 'mirror', '--quiet']);

  assert.equal(quiet.stdout, '');
  assert.equal(quiet.stderr, '');
  assert.equal(inHead(a, copyOf('host-a')), false);
});

test('a mirror that writes nothing commits a copy whose commit failed before', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  writeFileSync(path.join(a.clone, 'notes.txt'), 'not a ledger\n');
  git(a.h, a.clone, 'add', '-f', '--', 'notes.txt');
  run(a, ['store', 'mirror', '--quiet']);
  assert.equal(inHead(a, copyOf('host-a')), false, 'the commit went through with a stray path staged');
  git(a.h, a.clone, 'rm', '--quiet', '--cached', '--', 'notes.txt');
  rmSync(path.join(a.clone, 'notes.txt'));

  ok(run(a, ['store', 'mirror']));

  assert.equal(headText(a, copyOf('host-a')), readFileSync(ledger, 'utf8'));
  assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');
});

/** `ledger <args>` on `m`, as a process the test can run alongside another. */
function started(m: Machine, args: string[], env: NodeJS.ProcessEnv): Promise<Ran> {
  const child = spawn(LEDGER_BIN, args, { cwd: m.app, env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('a mirror holds the clone lock from its read of the worktree ledgers to its commit, so a retire meanwhile still removes the copy', async (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  appendFileSync(ledger, '- Written after the first copy.\n');
  const pause = path.join(a.h, 'mirror-pause');

  const mirroring = started(a, ['store', 'mirror'], { ...quietEnv(a), LEDGER_TEST_MIRROR_PAUSE: pause });
  await until(() => existsSync(`${pause}.reached`), 'the mirror reading the worktree ledgers');
  const lock = path.join(a.h, '.claude/ledger-data.lock');
  const holder = existsSync(lock) ? (JSON.parse(readFileSync(lock, 'utf8')) as { pid: number }).pid : undefined;
  const retiring = started(a, ['task', 'retire', SLUG, '--force'], quietEnv(a));
  writeFileSync(`${pause}.go`, '');
  const [mirrored, retired] = await Promise.all([mirroring, retiring]);

  assert.equal(holder, Number(readFileSync(`${pause}.reached`, 'utf8')), 'the mirror does not hold the clone lock while it reconciles');
  assert.equal(mirrored.status, 0, mirrored.stderr);
  assert.equal(retired.status, 0, retired.stderr);
  assert.equal(inHead(a, copyOf('host-a')), false, 'the retired task has its copy back');
  assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');
});

test('ledger store sync restores an edited or added copy of another machine instead of committing it, and warns once for each', (t) => {
  const { bare, b } = twoMachines(t);
  const theirs = path.join(b.clone, copyOf('host-a'));
  const added = copyOf('host-a', 'made-on-b');
  const committed = headText(b, copyOf('host-a'));
  appendFileSync(theirs, '- Edited on host B.\n');
  writeFileSync(path.join(b.clone, added), ledgerText({ slug: 'made-on-b', main: b.app }));

  const synced = run(b, ['store', 'sync']);

  assert.equal(synced.status, 0, synced.stderr);
  const warnings = linesWith(synced.stderr, 'warning:');
  assert.equal(warnings.length, 2, synced.stderr);
  assert.ok(warnings.some((line) => line.includes(copyOf('host-a'))), synced.stderr);
  assert.ok(warnings.some((line) => line.includes(added)), synced.stderr);
  assert.equal(readFileSync(theirs, 'utf8'), committed);
  assert.equal(existsSync(path.join(b.clone, added)), false);
  assert.equal(remoteText(bare, copyOf('host-a')), committed.trimEnd());
  assert.ok(!remoteFiles(bare).includes(added));
  assert.equal(git(b.h, b.clone, 'status', '--porcelain'), '');
});

test('ledger go of a task on another machine refuses also when it has a child in the backlog here, and starts no child', (t) => {
  const { a, b, ledger } = twoMachines(t);
  appendFileSync(ledger, '\n## Children\n- kid\n');
  ledgerOk(a, 'store', 'mirror');
  ledgerOk(a, 'store', 'sync');
  ledgerOk(b, 'store', 'sync');
  ledgerOk(b, 'task', 'new', 'kid', '--goal', 'A child of the task on host A.');

  const ran = run(b, ['go', SLUG]);

  assert.notEqual(ran.status, 0, ran.stdout);
  assert.match(ran.stderr, /host-a/);
  assert.match(ran.stderr, /read-only/);
  assert.equal(existsSync(path.join(b.app, '.claude/worktrees', 'kid')), false, 'the child was started');
});

test('ledger store sync leaves the .gitignore as it is while a merge is in progress in the clone', (t) => {
  const { a } = cloneBeforeActive(t);
  writeFileSync(path.join(a.clone, '.git/MERGE_HEAD'), git(a.h, a.clone, 'rev-parse', 'HEAD'));

  const synced = failed(run(a, ['store', 'sync']));

  assert.match(synced, /A merge is in progress/);
  assert.equal(readFileSync(path.join(a.clone, '.gitignore'), 'utf8'), GITIGNORE_BEFORE_ACTIVE);
});

test('ledger task retire removes the copy in the commit that archives the task, and the other machine then lists it as retired', (t) => {
  const { a, b } = twoMachines(t);
  assert.ok(listed(b).some(({ slug, place }) => slug === SLUG && place === 'remote'), 'B does not list the task as remote before the retire');

  ledgerOk(a, 'task', 'retire', SLUG, '--force');

  const archived = `archive/${APP}/${today()}-${SLUG}.json`;
  const archiving = git(a.h, a.clone, 'log', '--format=%H', '--diff-filter=A', '--', archived);
  assert.notEqual(archiving, '', `no commit adds ${archived}`);
  const changes = git(a.h, a.clone, 'show', '--no-renames', '--name-status', '--format=', archiving).split('\n');
  assert.ok(changes.includes(`A\t${archived}`), changes.join('\n'));
  assert.ok(changes.includes(`D\t${copyOf('host-a')}`), `the archive commit does not remove the copy:\n${changes.join('\n')}`);
  assert.equal(inHead(a, copyOf('host-a')), false);

  ledgerOk(a, 'store', 'sync');
  ledgerOk(b, 'store', 'sync');

  assert.deepEqual(listed(b).filter(({ slug }) => slug === SLUG), []);
  const all = listed(b, '--archived').filter(({ slug }) => slug === SLUG);
  assert.deepEqual(all.map(({ status }) => status), ['retired']);
  assert.ok(all.every(({ place }) => place !== 'remote'));
});

test("a machine ignores the copies in its own host folder: its worktree task is listed once, and a copy with no worktree not at all", (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const ghost = path.join(a.clone, copyOf('host-a', 'ghost'));
  writeFileSync(ghost, ledgerText({ slug: 'ghost', main: a.app }));
  git(a.h, a.clone, 'add', '-f', '--', copyOf('host-a', 'ghost'));
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'a copy whose worktree is gone');

  const entries = listed(a);

  assert.deepEqual(
    entries.filter(({ slug }) => slug === SLUG || slug === 'ghost').map(({ slug, status }) => ({ slug, status })),
    [{ slug: SLUG, status: 'active' }],
  );
  assert.ok(entries.every(({ place }) => place !== 'remote'));
  assert.doesNotMatch(ledgerOk(a, 'list'), /on host-a/);

  ledgerOk(a, 'store', 'mirror');

  assert.equal(inHead(a, copyOf('host-a', 'ghost')), false, 'mirror kept the copy of a task with no worktree');
  assert.ok(inHead(a, copyOf('host-a')));
});

test('an active copy hides a backlog ledger with the same repo and slug', (t) => {
  const { b } = twoMachines(t);
  const twin = path.join(b.clone, 'backlog', APP, `${SLUG}.md`);
  mkdirSync(path.dirname(twin), { recursive: true });
  writeFileSync(twin, ledgerText({ slug: SLUG, main: b.app, goal: 'The backlog twin.' }));
  git(b.h, b.clone, 'add', '-f', '--', `backlog/${APP}/${SLUG}.md`);
  git(b.h, b.clone, 'commit', '--quiet', '-m', 'a backlog twin');

  const entries = listed(b).filter(({ slug }) => slug === SLUG);

  assert.deepEqual(
    entries.map(({ place, host }) => ({ place, host })),
    [{ place: 'remote', host: 'host-a' }],
  );
  assert.equal(linesWith(ledgerOk(b, 'list'), SLUG).length, 1);
});

test('the session-start hook mirrors after its pull', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  appendFileSync(ledger, '- Written just before the session started.\n');

  hookContext(a, a.app);

  assert.ok(inHead(a, copyOf('host-a')), 'the session start committed no copy');
  assert.equal(headText(a, copyOf('host-a')), readFileSync(ledger, 'utf8'));
  assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');
});

// ---------------------------------------------------------------------------------------------------- allowlist, scan

/** A clone set up before active copies: the remote holds the old .gitignore, and the clone the old pre-push hook. */
function cloneBeforeActive(t: TestContext): { bare: string; a: Machine } {
  const bare = remote(t);
  const a = machine(t, bare);
  setUpAs(a, 'host-a');
  const other = plainClone(a);
  writeFileSync(path.join(other, '.gitignore'), GITIGNORE_BEFORE_ACTIVE);
  git(a.h, other, 'commit', '--quiet', '--allow-empty', '-am', 'the .gitignore before active copies');
  git(a.h, other, 'push', '--quiet', '--no-verify', 'origin', 'HEAD:main');
  ledgerOk(a, 'store', 'sync');
  writeFileSync(hookFile(a), HOOK_BEFORE_ACTIVE);
  chmodSync(hookFile(a), 0o755);
  return { bare, a };
}

test('a clone made before active copies is repaired by ledger store sync, which then pushes the copy', (t) => {
  const { bare, a } = cloneBeforeActive(t);
  startTask(a);
  ledgerOk(a, 'store', 'mirror');

  ledgerOk(a, 'store', 'sync');

  assert.ok(remoteFiles(bare).includes(copyOf('host-a')), 'the copy is not on the remote');
  assert.equal(readFileSync(path.join(a.clone, '.gitignore'), 'utf8'), GITIGNORE);
  assert.equal(remoteText(bare, '.gitignore'), GITIGNORE.trimEnd());
});

test('a clone made before active copies is repaired by the session start, so a manual git push of the copy goes through its hook', (t) => {
  const { bare, a } = cloneBeforeActive(t);
  startTask(a);

  hookContext(a, a.app);
  const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');

  assert.equal(pushed.status, 0, pushed.stderr);
  assert.ok(remoteFiles(bare).includes(copyOf('host-a')), 'the copy is not on the remote');
  assert.equal(readFileSync(path.join(a.clone, '.gitignore'), 'utf8'), GITIGNORE);
  assert.equal(remoteText(bare, '.gitignore'), GITIGNORE.trimEnd());
});

test('a token in a worktree ledger blocks the push of its copy: file:line is named, the token is not printed, the commit stays local', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'sync');
  appendFileSync(ledger, `- Use ${GITHUB_TOKEN} to log in.\n`);
  const hit = `${copyOf('host-a')}:${lineOf(readFileSync(ledger, 'utf8'), GITHUB_TOKEN)}`;
  ledgerOk(a, 'store', 'mirror');
  const before = remoteHead(bare);

  const synced = failed(run(a, ['store', 'sync']));
  const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');

  assert.ok(synced.includes(hit), synced);
  assert.notEqual(pushed.status, 0, 'git push was not blocked');
  assert.ok(pushed.stderr.includes(hit), pushed.stderr);
  assert.ok(!`${synced}${pushed.stderr}`.includes(GITHUB_TOKEN), 'the token is printed');
  assert.equal(remoteHead(bare), before);
  assert.ok(inHead(a, copyOf('host-a')));
  assert.equal(JSON.parse(readFileSync(a.status, 'utf8')).problem, 'secret');
});

// ------------------------------------------------------------------------------------------------- review findings

/** Puts a git first on PATH that runs `script` for a call whose arguments match the shell pattern `pattern`, and the real git for any other. */
function stubGit(m: Machine, pattern: string, script: string): void {
  stubGitCalls(m, [[pattern, script]]);
}

/** stubGit for several patterns: each call runs the script of the first pattern its arguments match. */
function stubGitCalls(m: Machine, cases: [pattern: string, script: string][]): void {
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const arms = cases.map(([pattern, script]) => `${pattern}) ${script} ;;`).join(' ');
  writeFileSync(path.join(m.h, 'stub-bin/git'), `#!/bin/sh\ncase "$*" in ${arms} esac\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
}

const unstubGit = (m: Machine): void => rmSync(path.join(m.h, 'stub-bin/git'), { force: true });

const worktreeOf = (ledger: string): string => path.dirname(path.dirname(ledger));

test('a sync while a retire runs waits for it, so the commit that archives the task also removes its copy', async (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  ledgerOk(a, 'store', 'sync');
  const [paused, go] = [path.join(a.h, 'retire-paused'), path.join(a.h, 'retire-go')];
  stubGit(a, '*"worktree remove"*', `touch ${JSON.stringify(paused)}; while [ ! -f ${JSON.stringify(go)} ]; do sleep 0.1; done`);

  const retiring = started(a, ['task', 'retire', SLUG, '--force'], quietEnv(a));
  await until(() => existsSync(paused), 'the retire reaching git worktree remove');
  let syncEnded = false;
  const syncing = started(a, ['store', 'sync'], quietEnv(a)).finally(() => (syncEnded = true));
  for (let waited = 0; !syncEnded && waited < 2500; waited += 100) await delay(100);
  const endedBeforeRetire = syncEnded;
  writeFileSync(go, '');
  const [retired, synced] = await Promise.all([retiring, syncing]);
  unstubGit(a);

  assert.equal(endedBeforeRetire, false, 'the sync ended while the retire still held the clone lock');
  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(retired.status, 0, retired.stderr);
  const archived = `archive/${APP}/${today()}-${SLUG}.json`;
  const archiving = git(a.h, a.clone, 'log', '--format=%H', '--diff-filter=A', '--', archived);
  const changes = git(a.h, a.clone, 'show', '--no-renames', '--name-status', '--format=', archiving).split('\n');
  assert.ok(changes.includes(`D\t${copyOf('host-a')}`), `the commit that archives the task does not remove its copy:\n${changes.join('\n')}`);
});

test('ledger store mirror writes no copy while a merge is in progress in the clone, and says so', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const copied = headText(a, copyOf('host-a'));
  appendFileSync(ledger, '- Written while a merge is in progress in the clone.\n');
  writeFileSync(path.join(a.clone, '.git/MERGE_HEAD'), git(a.h, a.clone, 'rev-parse', 'HEAD'));

  const mirrored = failed(run(a, ['store', 'mirror']));

  assert.match(mirrored, /A merge is in progress/);
  assert.equal(readFileSync(path.join(a.clone, copyOf('host-a')), 'utf8'), copied, 'the mirror wrote into the unfinished merge');
});

test('a mirror that fails on one copy commits none of the copies it wrote', { skip: asRoot }, (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const copied = headText(a, copyOf('host-a'));
  // A copy whose worktree is gone, in a folder the mirror cannot remove it from.
  const ghost = 'active/host-a/gone/ghost.md';
  mkdirSync(path.dirname(path.join(a.clone, ghost)), { recursive: true });
  writeFileSync(path.join(a.clone, ghost), ledgerText({ slug: 'ghost', main: a.app }));
  git(a.h, a.clone, 'add', '-f', '--', ghost);
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'a copy whose worktree is gone');
  appendFileSync(ledger, '- Written before a mirror that fails.\n');
  const locked = path.dirname(path.join(a.clone, ghost));
  chmodSync(locked, 0o555);
  let mirrored: Ran;
  try {
    mirrored = run(a, ['store', 'mirror']);
  } finally {
    chmodSync(locked, 0o755);
  }

  assert.notEqual(mirrored.status, 0, 'the mirror did not fail');
  assert.equal(headText(a, copyOf('host-a')), copied, 'the copy the failed mirror wrote is committed');
  assert.equal(readFileSync(path.join(a.clone, copyOf('host-a')), 'utf8'), copied, 'the copy the failed mirror wrote is left for the next commit');
});

test('ledger store mirror copies the ledgers of git worktrees only, not that of a folder outside git', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  const folder = path.join(a.h, 'repos', 'notes');
  mkdirSync(path.join(folder, '.claude'), { recursive: true });
  writeFileSync(path.join(folder, '.claude/ledger.md'), ledgerText({ slug: 'notes-task' }));
  // Without a registry, a rebuild scans the repos folder and finds the folder task.
  rmSync(path.join(a.h, '.claude/ledgers-git.json'), { force: true });

  ledgerOk(a, 'store', 'mirror');

  assert.deepEqual(git(a.h, a.clone, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'active/').split('\n'), [copyOf('host-a')]);
});

test('with a "host" that is no label, the session start in a worktree still prints its ledger', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  writeSettings(a, { storage: 'git', host: 'Work Laptop' });

  const context = hookContext(a, worktreeOf(ledger));

  assert.match(context, new RegExp(`A task ledger exists at \\S*/${SLUG}/\\.claude/ledger\\.md`));
});

test('a copy that is slow at the session start leaves the ledgers their time: the status of the parent is still read', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  ledgerOk(a, 'task', 'new', 'umbrella', '--goal', 'The parent of fix-login.');
  const ledger = startTask(a);
  ledgerOk(a, 'tree', 'add', 'umbrella', SLUG);
  stubGit(a, '*" commit --quiet --no-verify "*', 'exec sleep 10');

  const context = hookContext(a, worktreeOf(ledger));
  unstubGit(a);

  assert.match(context, /Parent task: umbrella \(backlog\)\./);
});

test('after "host" changes, this machine lists its worktree task once, not also as a copy on its old host', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  writeSettings(a, { storage: 'git', host: 'host-a-renamed' });

  const entries = listed(a).filter(({ slug }) => slug === SLUG);

  assert.deepEqual(
    entries.map(({ place, host }) => ({ place, host })),
    [{ place: 'worktree', host: undefined }],
  );
});

test('ledger store mirror keeps the copy of a task the registry lists active, when its worktree moved and its ledger cannot be read', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const moved = `${worktreeOf(ledger)}-moved`;
  git(a.h, a.app, 'worktree', 'move', worktreeOf(ledger), moved);
  chmodSync(path.join(moved, '.claude/ledger.md'), 0o000);

  ok(run(a, ['store', 'mirror']));

  assert.ok(inHead(a, copyOf('host-a')), 'the copy of a task the registry listed active was removed');
});

test('ledger store mirror copies no worktree ledger whose .claude folder is a symbolic link out of the worktree', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const copied = headText(a, copyOf('host-a'));
  const outside = path.join(a.h, 'outside-claude');
  renameSync(path.dirname(ledger), outside);
  symlinkSync(outside, path.dirname(ledger));
  appendFileSync(path.join(outside, 'ledger.md'), '- Text from outside the worktree.\n');

  ok(run(a, ['store', 'mirror']));

  assert.equal(headText(a, copyOf('host-a')), copied, 'the copy took the text of a .claude folder outside the worktree');
});

test('readTimedText reads no file through a symbolic link that replaced the file after it was checked', (t) => {
  const h = home(t);
  const [ledger, secret] = [path.join(h, 'ledger.md'), path.join(h, 'secret.md')];
  writeFileSync(ledger, 'the ledger\n');
  writeFileSync(secret, 'secret text\n');
  // readTimedText checks the file it opened with fstatSync, so the swap comes right after that check.
  const fstat = fs.fstatSync;
  let swapped = false;
  t.mock.method(fs, 'fstatSync', ((descriptor: number, options?: fs.StatOptions) => {
    const stat = fstat(descriptor, options);
    if (!swapped) {
      swapped = true;
      rmSync(ledger);
      symlinkSync(secret, ledger);
    }
    return stat;
  }) as typeof fs.fstatSync);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const read = readTimedText(ledger);

  assert.ok(swapped, 'the read never reached the point where the test swaps the file for a link');
  assert.equal(read?.text, 'the ledger\n');
});

test('ledger store sync puts back a copy of another machine that was staged and then edited, and pushes none of it', (t) => {
  const { bare, b } = twoMachines(t);
  const added = copyOf('host-a', 'made-on-b');
  writeFileSync(path.join(b.clone, added), ledgerText({ slug: 'made-on-b', main: b.app }));
  git(b.h, b.clone, 'add', '-f', '--', added);
  appendFileSync(path.join(b.clone, added), '- Edited after it was staged.\n');

  const synced = run(b, ['store', 'sync']);

  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(existsSync(path.join(b.clone, added)), false);
  assert.ok(!remoteFiles(bare).includes(added));
  assert.equal(git(b.h, b.clone, 'status', '--porcelain'), '');
});

test('ledger store sync commits nothing when git cannot look up HEAD while it puts back a copy of another machine', (t) => {
  const { bare, b } = twoMachines(t);
  const committed = headText(b, copyOf('host-a'));
  appendFileSync(path.join(b.clone, copyOf('host-a')), '- Edited on host B.\n');
  // A ledger of B's own to commit, so the commit takes whatever else the put back left staged.
  mkdirSync(path.join(b.clone, 'backlog', APP), { recursive: true });
  writeFileSync(path.join(b.clone, 'backlog', APP, 'note-on-b.md'), ledgerText({ slug: 'note-on-b', main: b.app }));
  stubGit(b, '*"rev-parse --verify --quiet HEAD"', 'echo "fatal: cannot read HEAD" >&2; exit 128');
  const [head, pushed] = [git(b.h, b.clone, 'rev-parse', 'HEAD'), remoteHead(bare)];

  const synced = run(b, ['store', 'sync']);
  unstubGit(b);

  assert.notEqual(synced.status, 0, 'the sync went through without HEAD');
  assert.equal(git(b.h, b.clone, 'rev-parse', 'HEAD'), head, `the sync committed ${git(b.h, b.clone, 'diff', '--name-only', head, 'HEAD')}`);
  assert.equal(remoteHead(bare), pushed, 'the sync pushed');
  assert.equal(headText(b, copyOf('host-a')), committed, `the copy of host-a changed in HEAD:\n${synced.stderr}`);
  assert.equal(git(b.h, b.clone, 'show', `:${copyOf('host-a')}`), committed.trimEnd(), 'the copy of host-a changed in the index');
  assert.equal(remoteText(bare, copyOf('host-a')), committed.trimEnd(), 'the copy of host-a changed on the remote');
});

test('ledger store mirror --quiet exits 1 and prints nothing when its commit fails', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  writeFileSync(path.join(a.clone, 'notes.txt'), 'not a ledger\n');
  git(a.h, a.clone, 'add', '-f', '--', 'notes.txt');

  const quiet = run(a, ['store', 'mirror', '--quiet']);

  assert.equal(quiet.status, 1);
  assert.equal(quiet.stdout, '');
  assert.equal(quiet.stderr, '');
});

test('ledger tree add of a child under a parent on another machine refuses before it changes the child', (t) => {
  const { b } = twoMachines(t);
  ledgerOk(b, 'task', 'new', 'kid', '--goal', 'A child of the task on host A.');
  const kid = path.join(b.clone, 'backlog', APP, 'kid.json');
  const before = readFileSync(kid, 'utf8');

  const added = failed(run(b, ['tree', 'add', SLUG, 'kid']));

  assert.match(added, /host-a/);
  assert.match(added, /read-only/);
  assert.equal(readFileSync(kid, 'utf8'), before, 'the child names a parent it is not a child of');
});

test('ledger tree remove of a child on another machine refuses before it changes the parent here', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  writeFileSync(ledger, readFileSync(ledger, 'utf8').replace('## Location\n', '## Location\n- parent: umbrella\n'));
  ledgerOk(a, 'store', 'mirror');
  ledgerOk(a, 'store', 'sync');
  const b = machine(t, bare);
  answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });
  setUpAs(b, 'host-b');
  ledgerOk(b, 'store', 'sync');
  // Markdown from before task records, which the store still reads: a record cannot be appended to as text.
  const umbrella = path.join(b.clone, 'backlog', APP, 'umbrella.md');
  mkdirSync(path.dirname(umbrella), { recursive: true });
  writeFileSync(umbrella, ledgerText({ slug: 'umbrella', goal: 'The parent on host B.', children: [`- ${SLUG}`] }));
  const before = readFileSync(umbrella, 'utf8');

  const removed = failed(run(b, ['tree', 'remove', 'umbrella', SLUG]));

  assert.match(removed, /host-a/);
  assert.match(removed, /read-only/);
  assert.equal(readFileSync(umbrella, 'utf8'), before, 'the parent lost its child line');
});

test('ledger store mirror keeps the copy of a moved worktree whose ledger cannot be read, however often it runs', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const moved = `${worktreeOf(ledger)}-moved`;
  git(a.h, a.app, 'worktree', 'move', worktreeOf(ledger), moved);
  chmodSync(path.join(moved, '.claude/ledger.md'), 0o000);

  for (const pass of [1, 2, 3]) {
    ok(run(a, ['store', 'mirror']));
    assert.ok(inHead(a, copyOf('host-a')), `mirror ${pass} removed the copy of a worktree that still exists`);
  }
});

test('ledger task park of a task on another machine refuses, names the host, says it is read-only, and changes nothing', (t) => {
  const { b } = twoMachines(t);
  const head = git(b.h, b.clone, 'rev-parse', 'HEAD');
  const copy = readFileSync(path.join(b.clone, copyOf('host-a')), 'utf8');

  const parked = failed(run(b, ['task', 'park', SLUG, '--reason', 'waits for review']));

  assert.match(parked, /host-a/);
  assert.match(parked, /read-only/);
  assert.equal(readFileSync(path.join(b.clone, copyOf('host-a')), 'utf8'), copy);
  assert.equal(git(b.h, b.clone, 'rev-parse', 'HEAD'), head);
  assert.equal(git(b.h, b.clone, 'status', '--porcelain'), '');
});

test('ledger task retire that cannot remove the copy fails, says so, and commits no archive copy', { skip: asRoot }, (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const head = git(a.h, a.clone, 'rev-parse', 'HEAD');
  const folder = path.dirname(path.join(a.clone, copyOf('host-a')));
  chmodSync(folder, 0o555);
  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force']);
  } finally {
    chmodSync(folder, 0o755);
  }

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.match(retired.stderr, /copy/);
  assert.equal(git(a.h, a.clone, 'rev-parse', 'HEAD'), head, 'the retire made a commit');
  assert.equal(existsSync(path.join(a.clone, `archive/${APP}/${today()}-${SLUG}.json`)), false, 'an archive copy is left for a later commit');
  assert.ok(existsSync(ledger), 'the worktree ledger was removed');
});

test('a mirror that fails while git cannot put back its copies still puts them back, so a later commit takes none of them', { skip: asRoot }, (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const copied = headText(a, copyOf('host-a'));
  const ghost = 'active/host-a/gone/ghost.md';
  mkdirSync(path.dirname(path.join(a.clone, ghost)), { recursive: true });
  writeFileSync(path.join(a.clone, ghost), ledgerText({ slug: 'ghost', main: a.app }));
  git(a.h, a.clone, 'add', '-f', '--', ghost);
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'a copy whose worktree is gone');
  appendFileSync(ledger, '- Written before a mirror that fails.\n');
  const locked = path.dirname(path.join(a.clone, ghost));
  // Another git in the clone holds its index, so git checkout cannot run.
  const indexLock = path.join(a.clone, '.git/index.lock');
  writeFileSync(indexLock, '');
  chmodSync(locked, 0o555);
  let mirrored: Ran;
  try {
    mirrored = run(a, ['store', 'mirror']);
  } finally {
    chmodSync(locked, 0o755);
    rmSync(indexLock);
  }
  ledgerOk(a, 'store', 'sync');

  assert.notEqual(mirrored.status, 0, 'the mirror did not fail');
  assert.equal(headText(a, copyOf('host-a')), copied, 'a later commit took a copy of the failed mirror');
});

test('a mirror that runs out of time at the session start leaves git to the ledgers: a session in a worktree subfolder gets its ledger', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  const subfolder = path.join(worktreeOf(ledger), 'src');
  mkdirSync(subfolder);
  const hung = path.join(a.h, 'worktree-list-hung');
  stubGit(a, '*"worktree list"*', `[ -f ${JSON.stringify(hung)} ] || { touch ${JSON.stringify(hung)}; exec sleep 10; }`);

  const context = hookContext(a, subfolder);
  unstubGit(a);

  assert.ok(existsSync(hung), 'no git worktree list ran out of time');
  assert.match(context, new RegExp(`A task ledger exists at \\S*/${SLUG}/\\.claude/ledger\\.md`));
});

test('with a "host" that is no label, ledger store sync still commits and pushes a backlog ledger', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUpAs(a, 'host-a');
  writeSettings(a, { storage: 'git', host: 'Work Laptop' });
  ledgerOk(a, 'task', 'new', 'note', '--goal', 'Written while the host is wrong.');

  ledgerOk(a, 'store', 'sync');

  assert.ok(remoteFiles(bare).includes(`backlog/${APP}/note.json`), 'the backlog ledger is not on the remote');
});

test('with a "host" that is no label, the session start still pulls, and warns once, naming the host', (t) => {
  const { a, b } = twoMachines(t);
  writeSettings(b, { storage: 'git', host: 'Work Laptop' });
  ledgerOk(a, 'task', 'new', 'note', '--goal', 'Pushed from host A.');
  ledgerOk(a, 'store', 'sync');

  const context = hookContext(b, b.app);

  assert.ok(existsSync(path.join(b.clone, `backlog/${APP}/note.json`)), 'the session start pulled nothing');
  assert.equal(linesWith(context, 'Work Laptop').length, 1, context);
});

test('with a "host" that is no label, a store write commits its ledger and leaves active/ as HEAD has it', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const committed = headText(a, copyOf('host-a'));
  appendFileSync(path.join(a.clone, copyOf('host-a')), '- A copy not committed yet.\n');
  writeSettings(a, { storage: 'git', host: 'Work Laptop' });

  ledgerOk(a, 'task', 'new', 'note', '--goal', 'Written while the host is wrong.');

  assert.ok(inHead(a, `backlog/${APP}/note.json`), 'the backlog ledger is not committed');
  assert.equal(headText(a, copyOf('host-a')), committed);
  assert.equal(readFileSync(path.join(a.clone, copyOf('host-a')), 'utf8'), committed);
  assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');
});

test('ledger store mirror --quiet exits 1 when git cannot list the changed copies, and still commits a copy whose commit failed before', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  writeFileSync(path.join(a.clone, 'notes.txt'), 'not a ledger\n');
  git(a.h, a.clone, 'add', '-f', '--', 'notes.txt');
  run(a, ['store', 'mirror', '--quiet']);
  assert.equal(inHead(a, copyOf('host-a')), false, 'the commit went through with a stray path staged');
  git(a.h, a.clone, 'rm', '--quiet', '--cached', '--', 'notes.txt');
  rmSync(path.join(a.clone, 'notes.txt'));
  stubGit(a, '*"--ignored -- active/"*', 'echo "fatal: no status" >&2; exit 128');

  const quiet = run(a, ['store', 'mirror', '--quiet']);
  unstubGit(a);

  assert.equal(quiet.status, 1);
  assert.equal(quiet.stdout, '');
  assert.equal(quiet.stderr, '');
  assert.equal(headText(a, copyOf('host-a')), readFileSync(ledger, 'utf8'), 'the copy whose commit failed before is not committed');
});

/** Makes git note, in the file it returns, each look for unfinished work in the clone of `m` while no process holds the clone lock. */
function noteLooksOutsideLock(m: Machine): string {
  const outside = path.join(m.h, 'looked-outside-the-lock');
  stubGit(m, '*"--diff-filter=U"*', `[ -e ${JSON.stringify(path.join(m.h, '.claude/ledger-data.lock'))} ] || touch ${JSON.stringify(outside)}`);
  return outside;
}

test('ledger store sync looks for unfinished work in the clone only while it holds the clone lock', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  ledgerOk(a, 'store', 'sync');
  writeFileSync(path.join(a.clone, '.gitignore'), GITIGNORE_BEFORE_ACTIVE);
  const outside = noteLooksOutsideLock(a);

  ledgerOk(a, 'store', 'sync');
  unstubGit(a);

  assert.equal(existsSync(outside), false, 'the sync looked for unfinished work without the clone lock, so it may write the .gitignore into it');
});

test('the session start looks for unfinished work in the clone only while it holds the clone lock', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  ledgerOk(a, 'store', 'sync');
  writeFileSync(path.join(a.clone, '.gitignore'), GITIGNORE_BEFORE_ACTIVE);
  const outside = noteLooksOutsideLock(a);

  hookContext(a, a.app);
  unstubGit(a);

  assert.equal(existsSync(outside), false, 'the session start looked for unfinished work without the clone lock, so it may write the .gitignore into it');
});

test('ledger store mirror removes the copy of a task made with task new --here once git removed its worktree', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const worktree = path.join(a.h, 'elsewhere', 'feature-folder');
  git(a.h, a.app, 'worktree', 'add', '--quiet', '-b', 'feature-branch', worktree);
  ok(run(a, ['task', 'new', '--here', 'feature-task', '--goal', 'Made in a worktree outside .claude/worktrees.'], { cwd: worktree }));
  ledgerOk(a, 'store', 'mirror');
  assert.ok(inHead(a, copyOf('host-a', 'feature-task')), 'the mirror made no copy of the task');
  git(a.h, a.app, 'worktree', 'remove', '--force', worktree);

  ledgerOk(a, 'store', 'mirror');
  ledgerOk(a, 'store', 'mirror');

  assert.equal(inHead(a, copyOf('host-a', 'feature-task')), false, 'the copy outlived its worktree');
});

test('after "host" changes, ledger show does not print the copy on the old host of a worktree task here', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  appendFileSync(ledger, '- Written after the copy.\n');
  writeSettings(a, { storage: 'git', host: 'host-a-renamed' });

  const shown = run(a, ['show', SLUG]);

  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stderr, '');
  assert.equal(shown.stdout, readFileSync(ledger, 'utf8'), 'show did not print the worktree ledger as edited after the copy');
});

test('ledger store sync warns once for a copy of another machine whose removal was staged while it stayed on disk', (t) => {
  const { b } = twoMachines(t);
  git(b.h, b.clone, 'rm', '--quiet', '--cached', '--', copyOf('host-a'));

  const synced = run(b, ['store', 'sync']);

  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(linesWith(synced.stderr, 'warning:').length, 1, synced.stderr);
  assert.ok(inHead(b, copyOf('host-a')));
  assert.equal(git(b.h, b.clone, 'status', '--porcelain'), '');
});

test('ledger store sync --quiet puts back a copy of another machine without a warning', (t) => {
  const { b } = twoMachines(t);
  const committed = headText(b, copyOf('host-a'));
  appendFileSync(path.join(b.clone, copyOf('host-a')), '- Edited on host B.\n');

  const synced = run(b, ['store', 'sync', '--quiet']);

  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(synced.stderr, '');
  assert.equal(readFileSync(path.join(b.clone, copyOf('host-a')), 'utf8'), committed);
});

test('with a "host" that is no label, ledger task retire of a worktree task fails, names the host problem, says to fix "host" first, and commits nothing', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const head = git(a.h, a.clone, 'rev-parse', 'HEAD');
  writeSettings(a, { storage: 'git', host: 'Work Laptop' });

  const retired = run(a, ['task', 'retire', SLUG, '--force']);

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.match(retired.stderr, /"host" in \S+ is "Work Laptop"/);
  assert.match(retired.stderr, /Fix "host" first/);
  assert.equal(git(a.h, a.clone, 'rev-parse', 'HEAD'), head, 'the retire made a commit');
  assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');
  assert.ok(existsSync(ledger), 'the worktree ledger was removed');
});

/** Runs `retire` while `folder` of the clone of `m` is read-only. */
function retireWithReadOnly(m: Machine, folder: string, mode = 0o555): Ran {
  chmodSync(folder, mode);
  try {
    return run(m, ['task', 'retire', SLUG, '--force']);
  } finally {
    chmodSync(folder, 0o755);
  }
}

test('ledger task retire whose archive write fails puts the copy back, so neither HEAD nor the clone loses it or gains an archive copy', { skip: asRoot }, (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const copied = headText(a, copyOf('host-a'));
  const archived = `archive/${APP}/${today()}-${SLUG}.json`;

  const retired = retireWithReadOnly(a, path.join(a.clone, 'archive'));

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.match(retired.stderr, /Could not archive/);
  assert.equal(headText(a, copyOf('host-a')), copied, 'HEAD lost the copy');
  assert.equal(readFileSync(path.join(a.clone, copyOf('host-a')), 'utf8'), copied, 'the clone lost the copy');
  assert.equal(inHead(a, archived), false, 'HEAD holds an archive copy');
  assert.equal(existsSync(path.join(a.clone, archived)), false, 'the clone holds an archive copy');
  assert.ok(existsSync(ledger), 'the worktree ledger was removed');
});

test('ledger task retire of a copy it cannot read fails with "Could not remove the copy" and archives nothing', { skip: asRoot }, (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const head = git(a.h, a.clone, 'rev-parse', 'HEAD');
  const copy = path.join(a.clone, copyOf('host-a'));
  chmodSync(copy, 0o000);
  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force']);
  } finally {
    chmodSync(copy, 0o644);
  }

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.match(retired.stderr, /Could not remove the copy of fix-login/);
  assert.equal(git(a.h, a.clone, 'rev-parse', 'HEAD'), head, 'the retire made a commit');
  assert.equal(existsSync(path.join(a.clone, `archive/${APP}/${today()}-${SLUG}.json`)), false, 'the retire archived the task');
  assert.ok(existsSync(copy), 'the copy was removed');
  assert.ok(existsSync(ledger), 'the worktree ledger was removed');
});

test('a copy that a failed mirror could not put back is committed by no sync, only by the next mirror that goes through', { skip: asRoot }, async (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const copied = headText(a, copyOf('host-a'));
  const ghost = 'active/host-a/gone/ghost.md';
  mkdirSync(path.dirname(path.join(a.clone, ghost)), { recursive: true });
  writeFileSync(path.join(a.clone, ghost), ledgerText({ slug: 'ghost', main: a.app }));
  git(a.h, a.clone, 'add', '-f', '--', ghost);
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'a copy whose worktree is gone');
  appendFileSync(ledger, '- Written before a mirror that fails.\n');
  const [ghostFolder, copyFolder] = [path.dirname(path.join(a.clone, ghost)), path.dirname(path.join(a.clone, copyOf('host-a')))];
  const [paused, go] = [path.join(a.h, 'mirror-paused'), path.join(a.h, 'mirror-go')];
  // Once the mirror wrote the copy, git waits, so the test can make its folder read-only before the put back.
  const written = `grep -q 'Written before a mirror that fails' ${JSON.stringify(path.join(a.clone, copyOf('host-a')))} 2>/dev/null`;
  stubGit(a, '*', `[ -f ${JSON.stringify(go)} ] || ! ${written} || { touch ${JSON.stringify(paused)}; while [ ! -f ${JSON.stringify(go)} ]; do sleep 0.1; done; }`);
  chmodSync(ghostFolder, 0o555);
  let mirrored: Ran;
  try {
    const mirroring = started(a, ['store', 'mirror'], quietEnv(a));
    await until(() => existsSync(paused), 'the mirror writing the copy');
    chmodSync(copyFolder, 0o555);
    writeFileSync(go, '');
    mirrored = await mirroring;
  } finally {
    chmodSync(ghostFolder, 0o755);
    chmodSync(copyFolder, 0o755);
    unstubGit(a);
  }
  assert.notEqual(mirrored.status, 0, 'the mirror did not fail');
  assert.match(mirrored.stderr, /Could not put back the copies/);

  ledgerOk(a, 'store', 'sync');

  assert.equal(headText(a, copyOf('host-a')), copied, 'the sync committed the copy of the failed mirror');

  ledgerOk(a, 'store', 'mirror');

  assert.equal(headText(a, copyOf('host-a')), readFileSync(ledger, 'utf8'), 'the mirror that went through did not commit the copy');
  assert.equal(inHead(a, ghost), false, 'the mirror that went through kept the copy whose worktree is gone');
});

test('after "host" changes, ledger show --repo from a folder outside the repo does not print the copy on the old host', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  appendFileSync(ledger, '- Written after the copy.\n');
  writeSettings(a, { storage: 'git', host: 'host-a-renamed' });

  assertShowOutsideHidesOldHostCopy(a);
});

/**
 * Asserts that ledger show --repo, from a folder outside the repo, does not print the copy that `a` left on its old host
 * while its worktree task is there. Outside a clone, show reads no worktree ledger, so it finds none to print. As a
 * control, the same show prints the copy once the registry names no worktree of the task.
 */
function assertShowOutsideHidesOldHostCopy(a: Machine): void {
  const show = (): Ran => run(a, ['show', SLUG, '--repo', APP_KEY], { cwd: a.h });

  const outside = show();
  writeFileSync(path.join(a.h, '.claude/ledgers-git.json'), '[]');
  const control = show();

  assert.equal(outside.status, 1, outside.stdout);
  assert.equal(outside.stdout, '');
  assert.match(outside.stderr, /^No ledger named fix-login is in the backlog or the archive of the repo app\.\n$/);
  assert.equal(control.status, 0, control.stderr);
  assert.match(control.stdout.split('\n')[0], /host-a.*read-only/);
  assert.ok(control.stdout.endsWith(headText(a, copyOf('host-a'))), control.stdout);
}

test('with a "host" that is no label, the session start still ends by its deadline when git stalls', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  writeSettings(a, { storage: 'git', host: 'Work Laptop' });
  // The pull uses up its time, and so leaves the ledgers 1.5 s; git in the repo then hangs.
  stubGit(a, '*" fetch "*|*"worktree list"*', 'exec sleep 10');

  const began = Date.now();
  const ran = run(a, ['hook', 'session-start'], { cwd: worktreeOf(ledger), input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: worktreeOf(ledger) }) });
  const took = Date.now() - began;
  unstubGit(a);

  assert.equal(ran.status, 0, ran.stderr);
  // 5 s for the hook, and some time for node to start.
  assert.ok(took < 7_000, `the session start took ${took} ms`);
});

const heldBackFile = (m: Machine): string => path.join(m.clone, '.git/ledger-held-back.json');

/** Leaves the copy `file` of `m` as a mirror that failed and could not put it back does: changed, and held back. */
function holdCopy(m: Machine, file: string): void {
  appendFileSync(path.join(m.clone, file), '- Written by a mirror that failed.\n');
  writeFileSync(heldBackFile(m), `${JSON.stringify([file])}\n`);
}

/** A committed copy of `m` whose worktree is gone, in a folder made read-only, so a mirror fails when it removes it; gives what makes the folder writable again. */
function ghostInReadOnlyFolder(m: Machine): () => void {
  const ghost = 'active/host-a/gone/ghost.md';
  const folder = path.dirname(path.join(m.clone, ghost));
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(m.clone, ghost), ledgerText({ slug: 'ghost', main: m.app }));
  git(m.h, m.clone, 'add', '-f', '--', ghost);
  git(m.h, m.clone, 'commit', '--quiet', '-m', 'a copy whose worktree is gone');
  chmodSync(folder, 0o555);
  return () => chmodSync(folder, 0o755);
}

const archivedName = `archive/${APP}/${today()}-${SLUG}.json`;

test('ledger store sync pulls past a held copy that HEAD tracks, and commits none of it', (t) => {
  const { a, b } = twoMachines(t);
  const committed = headText(a, copyOf('host-a'));
  holdCopy(a, copyOf('host-a'));
  ledgerOk(b, 'task', 'new', 'note', '--goal', 'Pushed from host B.');
  ledgerOk(b, 'store', 'sync');

  const synced = run(a, ['store', 'sync']);

  assert.equal(synced.status, 0, synced.stderr);
  assert.ok(inHead(a, `backlog/${APP}/note.json`), 'the sync pulled nothing');
  assert.equal(headText(a, copyOf('host-a')), committed, 'the sync committed the held copy');
  // remoteText trims the text git prints.
  assert.equal(remoteText(a.bare, copyOf('host-a')), committed.trimEnd(), 'the sync pushed the held copy');
});

test('ledger store sync that cannot put back a held copy before its pull names the copy and says to run ledger store mirror', (t) => {
  const { a, b } = twoMachines(t);
  holdCopy(a, copyOf('host-a'));
  ledgerOk(b, 'task', 'new', 'note', '--goal', 'Pushed from host B.');
  ledgerOk(b, 'store', 'sync');
  stubGit(a, '*"checkout --quiet HEAD"*', 'echo "fatal: no checkout" >&2; exit 128');

  const synced = run(a, ['store', 'sync']);
  unstubGit(a);

  assert.notEqual(synced.status, 0, synced.stdout);
  assert.ok(synced.stderr.includes(copyOf('host-a')), synced.stderr);
  assert.match(synced.stderr, /ledger store mirror/);
});

test('ledger task retire of a held copy removes it in the commit that archives the task', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  holdCopy(a, copyOf('host-a'));

  ledgerOk(a, 'task', 'retire', SLUG, '--force');

  const archiving = git(a.h, a.clone, 'log', '--format=%H', '--diff-filter=A', '--', archivedName);
  assert.notEqual(archiving, '', 'no commit archives the task');
  const changes = git(a.h, a.clone, 'show', '--no-renames', '--name-status', '--format=', archiving).split('\n');
  assert.ok(changes.includes(`D\t${copyOf('host-a')}`), `the commit that archives the task does not remove its copy:\n${changes.join('\n')}`);
  assert.equal(inHead(a, copyOf('host-a')), false);
});

test('a mirror that fails leaves a copy it cannot read as it is, and no commit removes it', { skip: asRoot }, (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const copy = path.join(a.clone, copyOf('host-a'));
  const writable = ghostInReadOnlyFolder(a);
  chmodSync(copy, 0o000);
  let mirrored: Ran;
  try {
    mirrored = run(a, ['store', 'mirror']);
  } finally {
    writable();
    if (existsSync(copy)) chmodSync(copy, 0o644);
  }
  ledgerOk(a, 'store', 'sync');

  assert.notEqual(mirrored.status, 0, 'the mirror did not fail');
  assert.ok(existsSync(copy), 'the mirror removed the copy it could not read');
  assert.ok(inHead(a, copyOf('host-a')), 'a commit removed the copy');
});

/** Checks that a retire of `m` that failed left HEAD and the clone with the copy `copied` and without an archive copy. */
function assertRetireUndone(m: Machine, ledger: string, copied: string): void {
  assert.equal(headText(m, copyOf('host-a')), copied, 'HEAD lost the copy');
  assert.equal(readFileSync(path.join(m.clone, copyOf('host-a')), 'utf8'), copied, 'the clone lost the copy');
  assert.equal(inHead(m, archivedName), false, 'HEAD holds an archive copy');
  assert.equal(existsSync(path.join(m.clone, archivedName)), false, 'the clone holds an archive copy');
  assert.ok(existsSync(ledger), 'the worktree ledger was removed');
}

test('ledger task retire whose evidence copy fails after the archive write archives nothing and keeps the copy', { skip: asRoot }, (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  mkdirSync(path.join(worktreeOf(ledger), '.claude/evidence'));
  writeFileSync(path.join(worktreeOf(ledger), '.claude/evidence/red.txt'), 'failing\n');
  ledgerOk(a, 'store', 'mirror');
  const copied = headText(a, copyOf('host-a'));
  const evidence = path.join(a.h, '.claude/ledger-evidence', APP);
  mkdirSync(evidence, { recursive: true });

  const retired = retireWithReadOnly(a, evidence);

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.match(retired.stderr, /Could not archive/);
  assertRetireUndone(a, ledger, copied);
});

test('ledger task retire that git cannot remove the worktree of archives nothing and keeps the copy', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const copied = headText(a, copyOf('host-a'));
  stubGit(a, '*"worktree remove"*', 'echo "fatal: refused by the test" >&2; exit 128');

  const retired = run(a, ['task', 'retire', SLUG, '--force']);
  unstubGit(a);

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.match(retired.stderr, /Could not remove the worktree/);
  assertRetireUndone(a, ledger, copied);
});

test('a retire that cannot put the copy back holds its removal out of every commit, and names both failures', { skip: asRoot }, (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const copyFolder = path.dirname(path.join(a.clone, copyOf('host-a')));
  stubGit(a, '*"worktree remove"*', `chmod 555 ${JSON.stringify(copyFolder)}; echo "fatal: refused by the test" >&2; exit 128`);

  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force']);
  } finally {
    unstubGit(a);
    chmodSync(copyFolder, 0o755);
  }
  ledgerOk(a, 'store', 'sync');

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.match(retired.stderr, /Could not remove the worktree/);
  assert.match(retired.stderr, /Could not put the copy of fix-login back/);
  assert.ok(inHead(a, copyOf('host-a')), 'a commit removed the copy');
});

test('a mirror releases only the held copies it wrote or removed: a held copy whose worktree ledger it cannot read stays uncommitted', { skip: asRoot }, (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  const other = startTask(a, 'other');
  ledgerOk(a, 'store', 'mirror');
  const committed = headText(a, copyOf('host-a'));
  holdCopy(a, copyOf('host-a'));
  appendFileSync(other, '- Written after the copy.\n');
  chmodSync(ledger, 0o000);

  let mirrored: Ran;
  try {
    mirrored = run(a, ['store', 'mirror']);
  } finally {
    chmodSync(ledger, 0o644);
  }

  assert.equal(mirrored.status, 0, mirrored.stderr);
  assert.equal(headText(a, copyOf('host-a', 'other')), readFileSync(other, 'utf8'), 'the mirror did not commit the copy it wrote');
  assert.equal(headText(a, copyOf('host-a')), committed, 'the mirror committed a held copy it did not write');
});

test('a held copy staged by hand is committed by no store write and no sync', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const committed = headText(a, copyOf('host-a'));
  holdCopy(a, copyOf('host-a'));
  git(a.h, a.clone, 'add', '-f', '--', copyOf('host-a'));

  ledgerOk(a, 'task', 'new', 'note', '--goal', 'Written while a held copy is staged.');
  ledgerOk(a, 'store', 'sync');

  assert.ok(inHead(a, `backlog/${APP}/note.json`), 'the backlog ledger is not committed');
  assert.equal(headText(a, copyOf('host-a')), committed, 'a commit took the staged held copy');
});

test('with a held-back list it cannot read, ledger store sync commits no copy of this machine and warns once; the next mirror rewrites the list', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const committed = headText(a, copyOf('host-a'));
  appendFileSync(path.join(a.clone, copyOf('host-a')), '- Not from any worktree ledger.\n');
  writeFileSync(heldBackFile(a), 'not json');

  const synced = run(a, ['store', 'sync']);

  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(headText(a, copyOf('host-a')), committed, 'the sync committed a copy while the list was unreadable');
  assert.equal(linesWith(synced.stderr, 'ledger-held-back.json').length, 1, synced.stderr);

  ledgerOk(a, 'store', 'mirror');

  assert.equal(headText(a, copyOf('host-a')), readFileSync(ledger, 'utf8'), 'the mirror that went through did not commit the copy');
  if (existsSync(heldBackFile(a))) assert.ok(Array.isArray(JSON.parse(readFileSync(heldBackFile(a), 'utf8'))), 'the mirror left the list unreadable');
});

test('after "host" changes, ledger show --repo from a folder outside the repo does not print the copy on the old host, also when the registry entry of the task has no "main"', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  appendFileSync(ledger, '- Written after the copy.\n');
  writeSettings(a, { storage: 'git', host: 'host-a-renamed' });
  const registry = path.join(a.h, '.claude/ledgers-git.json');
  const entries = JSON.parse(readFileSync(registry, 'utf8')) as Record<string, unknown>[];
  assert.ok(entries.some((entry) => entry.slug === SLUG && entry.main !== undefined), 'the registry has no entry with "main" to remove');
  writeFileSync(registry, JSON.stringify(entries.map(({ main: _main, ...entry }) => entry)));

  assertShowOutsideHidesOldHostCopy(a);
});

test('a reconcile that fails after one whose listing of the changed copies failed still leaves close to commit the copy left out', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  appendFileSync(path.join(a.clone, copyOf('host-a')), '- Left out by a commit that failed.\n');
  const leftOut = readFileSync(path.join(a.clone, copyOf('host-a')), 'utf8');
  asCli(t, a.h);
  const store = gitStore(ledgerPaths(a.h), { backgroundSync: false, quiet: true });
  const active = store.active ?? assert.fail('git storage keeps no copies');

  stubGit(a, '*"--ignored -- active/"*', 'echo "fatal: no status" >&2; exit 128');
  assert.throws(() => active.reconcile(() => undefined));
  unstubGit(a);
  assert.throws(() =>
    active.reconcile(() => {
      throw new Error('the second reconcile fails');
    }),
  );
  store.close?.();

  assert.equal(headText(a, copyOf('host-a')), leftOut, 'close did not commit the copy the first reconcile left out');
  assert.ok(existsSync(ledger));
});

test('ledger task retire that git cannot remove the worktree of, and that cannot remove its archive copy, names that copy and commits none of it', { skip: asRoot }, (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const copied = headText(a, copyOf('host-a'));
  const archiveFolder = path.dirname(path.join(a.clone, archivedName));
  stubGit(a, '*"worktree remove"*', `chmod 555 ${JSON.stringify(archiveFolder)}; echo "fatal: refused by the test" >&2; exit 128`);

  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force']);
  } finally {
    unstubGit(a);
    if (existsSync(archiveFolder)) chmodSync(archiveFolder, 0o755);
  }

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.match(retired.stderr, /Could not remove the worktree/);
  assert.doesNotMatch(retired.stderr, /Nothing was archived/);
  assert.ok(retired.stderr.includes(archivedName), retired.stderr);
  assert.equal(inHead(a, archivedName), false, 'HEAD holds an archive copy');
  assert.equal(headText(a, copyOf('host-a')), copied, 'HEAD lost the copy');
});

/** Plans the retire of the started task of `m` in this process, through `store`; gives what carries it out. */
function plannedRetire(m: Machine, store: LedgerStore, out: Output = { line: () => {}, warn: () => {} }): () => void {
  const context: Context = { paths: ledgerPaths(m.h), cwd: m.app, store };
  const plan = planRetire(readRetire(context, SLUG), { force: true });
  assert.equal(plan.blocked, false);
  return () => executeRetire(context, plan, out);
}

const withArchiveWrite = (store: LedgerStore, write: LedgerStore['archive']['write']): LedgerStore => ({ ...store, archive: { ...store.archive, write } });

test('a retire whose archive write fails leaves the archive copy and evidence that another retire wrote under the same name', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  asCli(t, a.h);
  const real = gitStore(ledgerPaths(a.h), { backgroundSync: false, quiet: true });
  const theirs = { text: 'Archived by another retire.\n', evidence: 'Evidence of another retire.\n' };
  let taken: { file: string; evidence: string } | undefined;
  const store = withArchiveWrite(real, (repo, name) => {
    taken = { file: real.archive.location(repo, name), evidence: path.join(real.archive.evidenceLocation(repo, name), 'red.txt') };
    for (const file of Object.values(taken)) mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(taken.file, theirs.text);
    writeFileSync(taken.evidence, theirs.evidence);
    throw new Error('no space left on device');
  });

  assert.throws(plannedRetire(a, store), /Could not archive/);
  store.close?.();

  const { file, evidence } = taken ?? assert.fail('the retire wrote no archive copy');
  assert.equal(readFileSync(file, 'utf8'), theirs.text, 'the retire removed the archive copy of another retire');
  assert.equal(readFileSync(evidence, 'utf8'), theirs.evidence, 'the retire removed the evidence of another retire');
});

test('a retire that goes through after one that could not put the copy back removes the copy in the commit that archives the task', { skip: asRoot }, (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const copyFolder = path.dirname(path.join(a.clone, copyOf('host-a')));
  stubGit(a, '*"worktree remove"*', `chmod 555 ${JSON.stringify(copyFolder)}; echo "fatal: refused by the test" >&2; exit 128`);
  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force']);
  } finally {
    unstubGit(a);
    chmodSync(copyFolder, 0o755);
  }
  assert.match(retired.stderr, /Could not put the copy of fix-login back/);

  ledgerOk(a, 'task', 'retire', SLUG, '--force');

  const archiving = git(a.h, a.clone, 'log', '--format=%H', '--diff-filter=A', '--', archivedName);
  assert.notEqual(archiving, '', 'HEAD holds no archive copy');
  const changes = git(a.h, a.clone, 'show', '--no-renames', '--name-status', '--format=', archiving).split('\n');
  assert.ok(changes.includes(`D\t${copyOf('host-a')}`), `the commit that archives the task does not remove its copy:\n${changes.join('\n')}`);
  assert.ok(inHead(a, archivedName), 'HEAD lost the archive copy');
  assert.equal(inHead(a, copyOf('host-a')), false, 'HEAD still holds the copy');
});

test('a retire whose worktree ledger moves after the archive write puts the copy back and commits no archive copy', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const copied = headText(a, copyOf('host-a'));
  asCli(t, a.h);
  const real = gitStore(ledgerPaths(a.h), { backgroundSync: false, quiet: true });
  const store = withArchiveWrite(real, (...args) => {
    real.archive.write(...args);
    renameSync(ledger, `${ledger}.moved`);
  });

  assert.throws(plannedRetire(a, store), /Stopped before removing the worktree/);
  store.close?.();

  assert.equal(headText(a, copyOf('host-a')), copied, 'HEAD lost the copy');
  assert.equal(inHead(a, archivedName), false, 'HEAD holds an archive copy');
});

test('a copy that can neither be put back nor recorded as held back is committed by no close in the same process, and the error says to mirror before the next sync', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  asCli(t, a.h);
  const store = gitStore(ledgerPaths(a.h), { backgroundSync: false, quiet: true });
  const active = store.active ?? assert.fail('git storage keeps no copies');
  const removed = active.remove(APP_KEY, SLUG) ?? assert.fail('there was no copy to remove');
  // writeAtomic writes through <file>.tmp-<pid>: a folder there fails both writes, as a full disk would, also as root.
  const blocked = [path.join(a.clone, copyOf('host-a')), heldBackFile(a)].map((file) => `${file}.tmp-${process.pid}`);
  for (const folder of blocked) mkdirSync(folder);
  try {
    assert.throws(() => removed.putBack(), /ledger store mirror before the next sync/);
  } finally {
    for (const folder of blocked) rmSync(folder, { recursive: true });
  }

  store.close?.();

  assert.ok(inHead(a, copyOf('host-a')), 'close committed the removal of the copy');
});

test('with a held-back list that names no copy, ledger store sync commits no copy of this machine', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const committed = headText(a, copyOf('host-a'));
  appendFileSync(path.join(a.clone, copyOf('host-a')), '- Not from any worktree ledger.\n');

  for (const list of [['bad-path'], [`backlog/${APP}/note.json`]]) {
    writeFileSync(heldBackFile(a), `${JSON.stringify(list)}\n`);
    const synced = run(a, ['store', 'sync']);

    assert.equal(synced.status, 0, synced.stderr);
    assert.equal(headText(a, copyOf('host-a')), committed, `the sync committed a copy while the list was ${JSON.stringify(list)}`);
  }
});

test('a mirror that goes through rewrites a held-back list it cannot read as one it can, so it commits its copies again', { skip: asRoot }, (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  // A changed copy the mirror keeps, as the repo its ledger names is not on this machine, so the rewritten list is not empty.
  const kept = 'active/host-a/elsewhere/kept.md';
  mkdirSync(path.dirname(path.join(a.clone, kept)), { recursive: true });
  writeFileSync(path.join(a.clone, kept), ledgerText({ slug: 'kept', main: path.join(a.h, 'repos/elsewhere') }));
  git(a.h, a.clone, 'add', '-f', '--', kept);
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'a copy of a repo that is not here');
  appendFileSync(path.join(a.clone, kept), '- Changed by hand.\n');
  writeFileSync(heldBackFile(a), '[]\n');
  chmodSync(heldBackFile(a), 0o000);
  appendFileSync(ledger, '- Written while the list cannot be read.\n');

  ledgerOk(a, 'store', 'mirror');

  assert.doesNotThrow(() => readFileSync(heldBackFile(a), 'utf8'), 'the mirror left the list unreadable');
  assert.equal(fs.statSync(heldBackFile(a)).mode & 0o777, 0o600, 'the mirror did not write the list for its owner only');
  assert.equal(headText(a, copyOf('host-a')), readFileSync(ledger, 'utf8'), 'the mirror did not commit the copy it wrote');
});

test('a retire whose failed worktree removal deleted the ledger and evidence keeps their archive copies and commits them with the removal of the copy', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  const worktree = worktreeOf(ledger);
  const evidence = path.join(worktree, '.claude/evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  ledgerOk(a, 'store', 'mirror');
  stubGit(a, '*"worktree remove"*', `rm -rf ${JSON.stringify(ledger)} ${JSON.stringify(evidence)}; echo "fatal: refused by the test" >&2; exit 128`);

  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force']);
  } finally {
    unstubGit(a);
  }

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.ok(retired.stderr.includes(`${worktree} remains`), retired.stderr);
  assert.ok(existsSync(path.join(a.clone, archivedName)), 'the archive copy is gone');
  assert.equal(readFileSync(path.join(a.h, '.claude/ledger-evidence', APP, `${today()}-${SLUG}`, 'red.txt'), 'utf8'), 'failing\n', 'the archived evidence is gone');
  assert.ok(inHead(a, archivedName), 'HEAD holds no archive copy');
  assert.equal(inHead(a, copyOf('host-a')), false, 'HEAD still holds the copy');
});

test('a retire that cannot remove the archive copy it wrote starts no background sync, so neither HEAD nor the remote takes that copy', { skip: asRoot }, async (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  ledgerOk(a, 'store', 'sync');
  ledgerOk(a, 'task', 'new', 'note', '--goal', 'Committed, not pushed.');
  assert.notEqual(git(a.h, a.clone, 'rev-parse', 'HEAD'), remoteHead(bare), 'the clone has no unpushed commit');
  const archiveFolder = path.dirname(path.join(a.clone, archivedName));
  stubGit(a, '*"worktree remove"*', `chmod 555 ${JSON.stringify(archiveFolder)}; echo "fatal: refused by the test" >&2; exit 128`);

  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force'], { env: machineEnv(a) });
  } finally {
    unstubGit(a);
    if (existsSync(archiveFolder)) chmodSync(archiveFolder, 0o755);
  }
  const pids = existsSync(backgroundPids(a.h)) ? readFileSync(backgroundPids(a.h), 'utf8').split('\n').filter(Boolean).map(Number) : [];
  await until(() => !pids.some(runs), 'the background sync to exit');

  assert.deepEqual(pids, [], 'the retire started a background sync');
  assert.ok(retired.stderr.includes(archivedName), retired.stderr);
  assert.equal(inHead(a, archivedName), false, 'HEAD holds an archive copy');
  assert.ok(inHead(a, copyOf('host-a')), 'HEAD lost the copy');
  assert.equal(remoteFiles(bare).includes(archivedName), false, 'the remote holds an archive copy');
  assert.ok(remoteFiles(bare).includes(copyOf('host-a')), 'the remote lost the copy');
});

/** Fails each writeAtomic of the copy of `m` and of its held-back list, as a full disk would, also as root: a folder at the temporary file. Gives what lets them write again. */
function blockCopyAndHeldList(m: Machine): () => void {
  const blocked = [path.join(m.clone, copyOf('host-a')), heldBackFile(m)].map((file) => `${file}.tmp-${process.pid}`);
  for (const folder of blocked) mkdirSync(folder);
  return () => {
    for (const folder of blocked) rmSync(folder, { recursive: true, force: true });
  };
}

const writeNote = (m: Machine, store: LedgerStore): void => store.backlog.write(APP_KEY, 'note', ledgerText({ slug: 'note', main: m.app }));

test('after a copy could neither be put back nor recorded as held back, a second store of the same process commits a backlog write without the removal of the copy', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  asCli(t, a.h);
  const first = gitStore(ledgerPaths(a.h), { backgroundSync: false, quiet: true });
  const removed = first.active?.remove(APP_KEY, SLUG) ?? assert.fail('there was no copy to remove');
  const unblock = blockCopyAndHeldList(a);
  try {
    assert.throws(() => removed.putBack(), /ledger store mirror before the next sync/);
  } finally {
    unblock();
  }

  const second = gitStore(ledgerPaths(a.h), { backgroundSync: false, quiet: true });
  writeNote(a, second);
  second.close?.();

  assert.ok(inHead(a, `backlog/${APP}/note.json`), 'the second store did not commit its backlog ledger');
  assert.ok(inHead(a, copyOf('host-a')), 'the second store committed the removal of the copy');
});

test('a mirror that can neither put back a copy nor record it as held back keeps it out of the next commit of the same process', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const committed = headText(a, copyOf('host-a'));
  asCli(t, a.h);
  const store = gitStore(ledgerPaths(a.h), { backgroundSync: false, quiet: true });
  const active = store.active ?? assert.fail('git storage keeps no copies');
  let unblock = (): void => {};
  let failure: unknown;
  try {
    active.reconcile(() => {
      active.write(APP_KEY, SLUG, `${committed}- Written by a mirror that fails.\n`);
      unblock = blockCopyAndHeldList(a);
      throw new Error('the mirror fails');
    });
  } catch (error) {
    failure = error;
  } finally {
    unblock();
  }

  writeNote(a, store);
  store.close?.();

  assert.ok(inHead(a, `backlog/${APP}/note.json`), 'the store did not commit its backlog ledger');
  assert.equal(headText(a, copyOf('host-a')), committed, 'a commit took the copy the mirror could not put back');
  assert.match(failure instanceof Error ? failure.message : String(failure), /ledger store mirror before the next sync/);
});

test('a held-back list with a control character in an entry holds every copy of this machine, and ledger store sync warns once', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const committed = headText(a, copyOf('host-a'));
  appendFileSync(path.join(a.clone, copyOf('host-a')), '- Not from any worktree ledger.\n');

  for (const control of ['\u0000', '\u001f', '\u007f']) {
    const list = [`active/host-a/app/a${control}b.md`];
    writeFileSync(heldBackFile(a), `${JSON.stringify(list)}\n`);
    const synced = run(a, ['store', 'sync']);

    assert.equal(synced.status, 0, synced.stderr);
    assert.equal(headText(a, copyOf('host-a')), committed, `the sync committed a copy while the list was ${JSON.stringify(list)}`);
    assert.equal(linesWith(synced.stderr, 'ledger-held-back.json').length, 1, synced.stderr);
  }
});

/** A started task of `m` with evidence, mirrored: its worktree ledger, and the evidence folder that holds red.txt. */
function startTaskWithEvidence(m: Machine): { ledger: string; evidence: string } {
  const ledger = startTask(m);
  const evidence = path.join(worktreeOf(ledger), '.claude/evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  ledgerOk(m, 'store', 'mirror');
  return { ledger, evidence };
}

function assertArchivedWithEvidence(m: Machine): void {
  assert.ok(existsSync(path.join(m.clone, archivedName)), 'the archive copy is gone');
  assert.equal(readFileSync(path.join(m.h, '.claude/ledger-evidence', APP, `${today()}-${SLUG}`, 'red.txt'), 'utf8'), 'failing\n', 'the archived evidence is gone');
  assert.ok(inHead(m, archivedName), 'HEAD holds no archive copy');
  assert.equal(inHead(m, copyOf('host-a')), false, 'HEAD still holds the copy');
}

test('a retire whose failed worktree removal deleted only the evidence keeps the archive copy and the archived evidence, and commits the archive copy with the removal of the copy', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const { evidence } = startTaskWithEvidence(a);
  stubGit(a, '*"worktree remove"*', `rm -rf ${JSON.stringify(evidence)}; echo "fatal: refused by the test" >&2; exit 128`);

  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force']);
  } finally {
    unstubGit(a);
  }

  assert.notEqual(retired.status, 0, retired.stdout);
  assertArchivedWithEvidence(a);
});

test('a retire whose failed worktree removal deleted the ledger keeps the archive copy and the archived evidence when the check for the ledger fails', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const { ledger } = startTaskWithEvidence(a);
  stubGit(a, '*"worktree remove"*', `rm -f ${JSON.stringify(ledger)}; echo "fatal: refused by the test" >&2; exit 128`);
  asCli(t, a.h);
  const store = gitStore(ledgerPaths(a.h), { backgroundSync: false, quiet: true });
  const retire = plannedRetire(a, store);
  const lstat = fs.lstatSync;
  const inWorktree = [path.join('worktrees', SLUG, '.claude/ledger.md'), path.join('worktrees', SLUG, '.claude/evidence')];
  let refused = 0;
  // Fails each check for the ledger or evidence of the worktree once they are gone, as EACCES or EIO would.
  t.mock.method(fs, 'lstatSync', ((file: fs.PathLike, ...rest: unknown[]) => {
    if (inWorktree.some((end) => String(file).endsWith(end)) && !fs.existsSync(file)) {
      refused++;
      throw Object.assign(new Error(`EACCES: permission denied, lstat '${String(file)}'`), { code: 'EACCES' });
    }
    return (lstat as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.lstatSync);
  syncBuiltinESMExports();
  const restore = (): void => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  };
  t.after(restore);

  try {
    assert.throws(retire, /Could not remove the worktree/);
  } finally {
    restore();
    unstubGit(a);
  }
  store.close?.();

  assert.notEqual(refused, 0, 'the retire never checked the ledger after git failed');
  assertArchivedWithEvidence(a);
});

test('a retire whose failed worktree removal deleted the ledger still marks the parent, copies the report and updates the registry, then exits non-zero and names the folder', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const epic = worktreeTask(a.h, a.app, { slug: 'epic', children: [`- ${SLUG}`] });
  const ledger = worktreeTask(a.h, a.app, { slug: SLUG, parent: 'epic', report: ['PR #12 merged.'] });
  ledgerOk(a, 'store', 'mirror');
  stubGit(a, '*"worktree remove"*', `rm -f ${JSON.stringify(ledger)}; echo "fatal: refused by the test" >&2; exit 128`);
  const build = buildFolderOf(a);

  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force']);
  } finally {
    unstubGit(a);
  }

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.ok(retired.stderr.includes(worktreeOf(ledger)), retired.stderr);
  const parent = readFileSync(epic, 'utf8');
  assert.match(parent, new RegExp(`^- ${SLUG} \\(retired ${today()}\\)$`, 'm'));
  assert.match(parent, new RegExp(`### ${SLUG}\\nPR #12 merged\\.\\n`));
  const registry = JSON.parse(readFileSync(path.join(a.h, '.claude/ledgers-git.json'), 'utf8')) as { slug: string; status: string }[];
  assert.equal(registry.find(({ slug }) => slug === SLUG)?.status, 'archived', JSON.stringify(registry));
  assert.equal(gitRan(a.h, a.app, 'rev-parse', '--verify', '--quiet', `refs/heads/me/${SLUG}`).status, 0, 'the retire deleted the branch the leftover worktree still uses');
  const kept = linesWith(retired.stdout, `kept     branch me/${SLUG}`);
  assert.equal(kept.length, 1, retired.stdout);
  assert.ok(kept[0].includes(path.join('.claude/worktrees', SLUG)), kept[0]);
  assert.ok(retired.stdout.includes(`deleted  ${build}`), retired.stdout);
  assert.equal(existsSync(build), false, 'the build folder is still there');
});

/** The Xcode build folder of the worktree of the started task of `m`, made now. */
function buildFolderOf(m: Machine): string {
  const build = path.join(realpathSync(m.app), '.claude/worktrees/.build', SLUG);
  mkdirSync(build, { recursive: true });
  return build;
}

test('a retire whose failed worktree removal deleted one evidence file keeps the archive copy and the archived evidence', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const { evidence } = startTaskWithEvidence(a);
  stubGit(a, '*"worktree remove"*', `rm -f ${JSON.stringify(path.join(evidence, 'red.txt'))}; echo "fatal: refused by the test" >&2; exit 128`);

  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force']);
  } finally {
    unstubGit(a);
  }

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.ok(existsSync(evidence), 'the stub deleted the evidence folder');
  assertArchivedWithEvidence(a);
});

test('a retire whose failed worktree removal deleted only the evidence deletes the worktree ledger, so no mirror copies it back and the task is listed as retired only', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const { ledger, evidence } = startTaskWithEvidence(a);
  stubGit(a, '*"worktree remove"*', `rm -rf ${JSON.stringify(evidence)}; echo "fatal: refused by the test" >&2; exit 128`);

  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force']);
  } finally {
    unstubGit(a);
  }

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.ok(existsSync(worktreeOf(ledger)), 'the stub deleted the worktree folder');
  assert.equal(existsSync(ledger), false, 'the worktree ledger is still there');
  ledgerOk(a, 'store', 'mirror');
  assert.equal(git(a.h, a.clone, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'active/'), '');
  assert.deepEqual(listed(a).filter(({ slug }) => slug === SLUG), []);
  assert.deepEqual(listed(a, '--archived').filter(({ slug }) => slug === SLUG).map(({ status }) => status), ['retired']);
});

test('a retire whose failed worktree removal left a worktree ledger that is not the archive copy keeps it, warns, and names it in the error', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const { ledger, evidence } = startTaskWithEvidence(a);
  stubGit(a, '*"worktree remove"*', `rm -rf ${JSON.stringify(evidence)}; echo "Written after the archive copy." >> ${JSON.stringify(ledger)}; echo "fatal: refused by the test" >&2; exit 128`);

  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force']);
  } finally {
    unstubGit(a);
  }

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.match(readFileSync(ledger, 'utf8'), /Written after the archive copy\./);
  assert.equal(linesWith(retired.stderr, `warning: kept the worktree ledger ${ledger}`).length, 1, retired.stderr);
  const error = retired.stderr.slice(retired.stderr.indexOf('Could not remove the worktree'));
  assert.ok(error.includes(ledger), retired.stderr);
  assertArchivedWithEvidence(a);
});

test('a retire whose failed worktree removal deleted the whole folder says so and names git worktree prune', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const { ledger } = startTaskWithEvidence(a);
  const worktree = worktreeOf(ledger);
  stubGit(a, '*"worktree remove"*', `rm -rf ${JSON.stringify(worktree)}; echo "fatal: refused by the test" >&2; exit 128`);

  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force']);
  } finally {
    unstubGit(a);
  }

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.ok(retired.stderr.includes(worktree), retired.stderr);
  assert.doesNotMatch(retired.stderr, /remains|by hand/);
  assert.match(retired.stderr, /git -C \S+ worktree prune/);
  assertArchivedWithEvidence(a);
  assert.equal(gitRan(a.h, a.app, 'rev-parse', '--verify', '--quiet', `refs/heads/${SLUG}`).status, 0, 'the retire deleted the branch git still lists for the worktree');
  const error = retired.stderr.slice(retired.stderr.indexOf('Could not remove the worktree'));
  assert.match(error, new RegExp(`kept the branch ${SLUG}\\b[^\\n]*after the prune`), retired.stderr);
});

/** Runs `work` while fs.`name` throws EACCES for each call that `refuses`, as the module exports that retire imports see it. */
function refusing<K extends 'lstatSync' | 'readdirSync'>(t: TestContext, name: K, refuses: (file: string, options: unknown) => boolean, work: () => void): void {
  const real = fs[name] as (...args: unknown[]) => unknown;
  t.mock.method(fs, name, ((file: fs.PathLike, ...rest: unknown[]) => {
    if (refuses(String(file), rest[0])) throw Object.assign(new Error(`EACCES: permission denied, ${name.replace('Sync', '')} '${String(file)}'`), { code: 'EACCES' });
    return real(file, ...rest);
  }) as (typeof fs)[K]);
  syncBuiltinESMExports();
  try {
    work();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
}

test('a retire whose build-folder step fails after a failed worktree removal warns, and its error still names the leftover worktree folder', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const { ledger, evidence } = startTaskWithEvidence(a);
  const build = buildFolderOf(a);
  stubGit(a, '*"worktree remove"*', `rm -rf ${JSON.stringify(evidence)}; echo "fatal: refused by the test" >&2; exit 128`);
  asCli(t, a.h);
  const store = gitStore(ledgerPaths(a.h), { backgroundSync: false, quiet: true });
  const warnings: string[] = [];
  const retire = plannedRetire(a, store, { line: () => {}, warn: (text) => warnings.push(text) });

  try {
    refusing(t, 'lstatSync', (file) => file === path.dirname(build), () => assert.throws(retire, (error: Error) => error.message.includes(`Could not remove the worktree ${worktreeOf(ledger)}`)));
  } finally {
    unstubGit(a);
    store.close?.();
  }

  assert.equal(warnings.filter((warning) => warning.includes(build) && warning.includes('EACCES')).length, 1, warnings.join('\n'));
  assertArchivedWithEvidence(a);
});

test('a retire with --json whose build-folder step fails after a failed worktree removal gives the warning in its JSON error', { skip: asRoot }, (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const { ledger, evidence } = startTaskWithEvidence(a);
  const build = buildFolderOf(a);
  stubGit(a, '*"worktree remove"*', `rm -rf ${JSON.stringify(evidence)}; echo "fatal: refused by the test" >&2; exit 128`);
  chmodSync(path.dirname(build), 0o555);

  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force', '--json']);
  } finally {
    unstubGit(a);
    chmodSync(path.dirname(build), 0o755);
  }

  assert.notEqual(retired.status, 0, retired.stdout);
  const answer = JSON.parse(retired.stdout) as { ok: boolean; error: string; warnings?: string[] };
  assert.equal(answer.ok, false);
  assert.ok(answer.error.includes(`Could not remove the worktree ${worktreeOf(ledger)}`), answer.error);
  assert.equal((answer.warnings ?? []).filter((warning) => warning.includes(build) && warning.includes('EACCES')).length, 1, retired.stdout);
});

test('a retire whose failed worktree removal left the worktree keeps its branch when git cannot list the worktrees, and says why', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const { evidence } = startTaskWithEvidence(a);
  const removing = path.join(a.h, 'worktree-removal-failed');
  stubGitCalls(a, [
    ['*"worktree remove"*', `rm -rf ${JSON.stringify(evidence)}; touch ${JSON.stringify(removing)}; echo "fatal: refused by the test" >&2; exit 128`],
    ['*"worktree list"*', `[ -f ${JSON.stringify(removing)} ] && { echo "fatal: list refused by the test" >&2; exit 128; }`],
  ]);

  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force']);
  } finally {
    unstubGit(a);
  }

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.equal(gitRan(a.h, a.app, 'rev-parse', '--verify', '--quiet', `refs/heads/${SLUG}`).status, 0, 'the retire deleted the branch the leftover worktree may still use');
  const kept = linesWith(retired.stdout, `kept     branch ${SLUG}`);
  assert.equal(kept.length, 1, retired.stdout);
  assert.match(kept[0], /worktree list could not be read/);
});

test('a retire with --json whose failed worktree removal left the worktree, and that cannot list the worktrees, names the kept branch and why in its JSON warnings', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const { evidence } = startTaskWithEvidence(a);
  const removing = path.join(a.h, 'worktree-removal-failed');
  stubGitCalls(a, [
    ['*"worktree remove"*', `rm -rf ${JSON.stringify(evidence)}; touch ${JSON.stringify(removing)}; echo "fatal: refused by the test" >&2; exit 128`],
    ['*"worktree list"*', `[ -f ${JSON.stringify(removing)} ] && { echo "fatal: list refused by the test" >&2; exit 128; }`],
  ]);

  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force', '--json']);
  } finally {
    unstubGit(a);
  }

  assert.notEqual(retired.status, 0, retired.stdout);
  const answer = JSON.parse(retired.stdout) as { ok: boolean; error: string; warnings?: string[] };
  assert.equal(answer.ok, false);
  const kept = (answer.warnings ?? []).filter((warning) => warning.includes(`branch ${SLUG}`));
  assert.equal(kept.length, 1, retired.stdout);
  assert.match(kept[0], /worktree list could not be read/);
});

test('a forced retire of an unmerged branch whose failed worktree removal deleted the whole folder names the kept branch and says to delete it after the prune', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const { ledger } = startTaskWithEvidence(a);
  const worktree = worktreeOf(ledger);
  git(a.h, worktree, 'commit', '--quiet', '--allow-empty', '-m', 'work');
  stubGit(a, '*"worktree remove"*', `rm -rf ${JSON.stringify(worktree)}; echo "fatal: refused by the test" >&2; exit 128`);

  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force']);
  } finally {
    unstubGit(a);
  }

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.equal(linesWith(retired.stdout, `kept     branch ${SLUG}, because it is not merged`).length, 1, retired.stdout);
  const error = retired.stderr.slice(retired.stderr.indexOf('Could not remove the worktree'));
  assert.match(error, /git -C \S+ worktree prune/);
  assert.match(error, new RegExp(`kept the branch ${SLUG}\\b[^\\n]*after the prune`), retired.stderr);
});

test('a retire whose failed worktree removal left a worktree ledger whose stored text differs from the archive copy keeps it and warns', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const { ledger, evidence } = startTaskWithEvidence(a);
  const text = readFileSync(ledger, 'utf8');
  const otherRecord = path.join(a.h, 'other-archive-copy.json');
  writeFileSync(otherRecord, recordJson(parseRecord(`${text}\n- Written into the archive copy only.\n`)));
  stubGit(a, '*"worktree remove"*', `rm -rf ${JSON.stringify(evidence)}; cp ${JSON.stringify(otherRecord)} ${JSON.stringify(path.join(a.clone, archivedName))}; echo "fatal: refused by the test" >&2; exit 128`);

  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force']);
  } finally {
    unstubGit(a);
  }

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.equal(readFileSync(ledger, 'utf8'), text);
  assert.equal(linesWith(retired.stderr, `warning: kept the worktree ledger ${ledger}`).length, 1, retired.stderr);
});

test('a retire whose failed worktree removal left a worktree ledger whose bytes differ from the archive copy, but whose stored text is the same, deletes it', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const { ledger, evidence } = startTaskWithEvidence(a);
  appendFileSync(ledger, Buffer.concat([Buffer.from('- Invalid byte: '), Buffer.from([0xff]), Buffer.from('\n')]));
  ledgerOk(a, 'store', 'mirror');
  stubGit(a, '*"worktree remove"*', `rm -rf ${JSON.stringify(evidence)}; echo "fatal: refused by the test" >&2; exit 128`);

  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force']);
  } finally {
    unstubGit(a);
  }

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.equal(existsSync(ledger), false, 'the worktree ledger is still there');
  assert.equal(linesWith(retired.stdout, `deleted  ${ledger}`).length, 1, retired.stdout);
  assert.equal(linesWith(retired.stderr, 'warning: kept the worktree ledger').length, 0, retired.stderr);
});

test('a retire that deletes a leftover worktree ledger waits for a write that holds its lock, then keeps the ledger that write changed', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const { ledger, evidence } = startTaskWithEvidence(a);
  const text = readFileSync(ledger, 'utf8');
  const [lock, line] = [`${ledger}.lock`, '- Written under the lock of the ledger.'];
  // The write runs in a process of its own, which holds the lock as ledger commands do: a file that names its pid.
  const writer = `( sleep 1; echo ${JSON.stringify(line)} >> ${JSON.stringify(ledger)}; rm -f ${JSON.stringify(lock)} ) </dev/null >/dev/null 2>&1 & printf '{"pid":%d,"since":"%s"}' $! "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${JSON.stringify(lock)}`;
  stubGit(a, '*"worktree remove"*', `rm -rf ${JSON.stringify(evidence)}; ${writer}; echo "fatal: refused by the test" >&2; exit 128`);

  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force']);
  } finally {
    unstubGit(a);
  }

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.equal(existsSync(lock), false, 'the write still holds the lock');
  assert.ok(existsSync(ledger), 'the retire deleted the worktree ledger the write held');
  assert.equal(readFileSync(ledger, 'utf8'), `${text}${line}\n`, 'the retire deleted the ledger before the write appended to it');
  assert.equal(linesWith(retired.stderr, `warning: kept the worktree ledger ${ledger}`).length, 1, retired.stderr);
});

test('a retire whose failed worktree removal deleted only an empty folder of the evidence is undone, and leaves the task as it was', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const { ledger, evidence } = startTaskWithEvidence(a);
  const empty = path.join(evidence, 'empty');
  mkdirSync(empty);
  const text = readFileSync(ledger, 'utf8');
  stubGit(a, '*"worktree remove"*', `rmdir ${JSON.stringify(empty)}; echo "fatal: refused by the test" >&2; exit 128`);

  let retired: Ran;
  try {
    retired = run(a, ['task', 'retire', SLUG, '--force']);
  } finally {
    unstubGit(a);
  }

  assert.notEqual(retired.status, 0, retired.stdout);
  assert.equal(existsSync(empty), false, 'the stub did not delete the empty folder');
  assert.match(retired.stderr, /Nothing was archived\./);
  assert.equal(readFileSync(ledger, 'utf8'), text);
  assert.equal(readFileSync(path.join(evidence, 'red.txt'), 'utf8'), 'failing\n');
  assert.equal(existsSync(path.join(a.clone, archivedName)), false, 'the archive copy is still there');
  assert.ok(existsSync(path.join(a.clone, copyOf('host-a'))), 'the copy is gone');
  assert.equal(inHead(a, archivedName), false, 'HEAD holds an archive copy');
  assert.ok(inHead(a, copyOf('host-a')), 'HEAD lost the copy');
});

test('a retire that cannot read the evidence before it removes the worktree stops, names the evidence and the cause, and leaves the task as it was', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const { ledger, evidence } = startTaskWithEvidence(a);
  const text = readFileSync(ledger, 'utf8');
  asCli(t, a.h);
  const store = gitStore(ledgerPaths(a.h), { backgroundSync: false, quiet: true });
  const retire = plannedRetire(a, store);

  try {
    // With file types: the read that lists the evidence, not the archive copy's comparison of it.
    refusing(t, 'readdirSync', (file, options) => file === evidence && (options as { withFileTypes?: boolean } | undefined)?.withFileTypes === true, () =>
      assert.throws(retire, (error: Error) => error.message.startsWith(`Stopped before removing the worktree ${worktreeOf(ledger)}`) && error.message.includes(evidence) && error.message.includes('EACCES') && /Nothing was archived/.test(error.message)),
    );
  } finally {
    store.close?.();
  }

  assert.equal(readFileSync(ledger, 'utf8'), text);
  assert.equal(readFileSync(path.join(evidence, 'red.txt'), 'utf8'), 'failing\n');
  assert.equal(existsSync(path.join(a.clone, archivedName)), false, 'the archive copy is still there');
  assert.equal(inHead(a, archivedName), false, 'HEAD holds an archive copy');
  assert.ok(inHead(a, copyOf('host-a')), 'HEAD lost the copy');
});

test('a retire retried in the same process after one that could not remove its archive copy commits the archive copy with the removal of the copy', { skip: asRoot }, (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  asCli(t, a.h);
  const archive = path.join(a.clone, archivedName);
  stubGit(a, '*"worktree remove"*', `chmod 555 ${JSON.stringify(path.dirname(archive))}; echo "fatal: refused by the test" >&2; exit 128`);
  const first = gitStore(ledgerPaths(a.h), { backgroundSync: false, quiet: true });
  try {
    assert.throws(plannedRetire(a, first), /Could not remove the archive copy/);
  } finally {
    unstubGit(a);
    if (existsSync(path.dirname(archive))) chmodSync(path.dirname(archive), 0o755);
  }
  first.close?.();
  rmSync(archive);

  const second = gitStore(ledgerPaths(a.h), { backgroundSync: false, quiet: true });
  plannedRetire(a, second)();
  second.close?.();

  const removals = git(a.h, a.clone, 'log', '--format=%H', '--diff-filter=D', '--', copyOf('host-a')).split('\n').filter(Boolean);
  assert.notEqual(removals.length, 0, 'no commit removes the copy');
  for (const commit of removals) {
    const changes = git(a.h, a.clone, 'show', '--no-renames', '--name-status', '--format=', commit).split('\n');
    assert.ok(changes.includes(`A\t${archivedName}`), `a commit removes the copy without the archive copy:\n${changes.join('\n')}`);
  }
  assert.ok(inHead(a, archivedName), 'HEAD holds no archive copy');
});

/** `ledger store sync` of `m` in this process, so it shares the holds of the stores the test opened. */
function syncHere(t: TestContext, m: Machine): void {
  const before = process.env.HOME;
  // The stub gh reads its answer from HOME.
  process.env.HOME = m.h;
  t.after(() => {
    process.env.HOME = before;
  });
  allowRemoteForTests(m.bare);
  syncLedgers(ledgerPaths(m.h), () => {}, { quiet: true });
}

test('ledger store sync in the same process after a mirror that could neither put back a copy nor record it as held back commits none of that copy', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const committed = headText(a, copyOf('host-a'));
  asCli(t, a.h);
  const store = gitStore(ledgerPaths(a.h), { backgroundSync: false, quiet: true });
  const active = store.active ?? assert.fail('git storage keeps no copies');
  let unblock = (): void => {};
  try {
    assert.throws(
      () =>
        active.reconcile(() => {
          active.write(APP_KEY, SLUG, `${committed}- Written by a mirror that fails.\n`);
          unblock = blockCopyAndHeldList(a);
          throw new Error('the mirror fails');
        }),
      /ledger store mirror before the next sync/,
    );
  } finally {
    unblock();
  }

  syncHere(t, a);

  assert.equal(headText(a, copyOf('host-a')), committed, 'the sync committed the copy the mirror could not put back');
});

// ------------------------------------------------------------------------------------------------------- repo keys

test('a clone of the same remote under another folder name sees the task of another machine as on host-a, by its repo key', (t) => {
  const { b, ledger } = twoMachines(t);
  const elsewhere = path.join(b.h, 'repos', 'login-service');
  git(b.h, b.h, 'clone', '--quiet', APP_ORIGIN, elsewhere);

  const tasks = (JSON.parse(ok(run(b, ['list', '--json'], { cwd: elsewhere }))) as { tasks: Listed[] }).tasks;
  const shown = ok(run(b, ['show', SLUG], { cwd: elsewhere }));
  const went = run(b, ['go', SLUG], { cwd: elsewhere });

  assert.deepEqual(
    tasks.filter(({ slug }) => slug === SLUG).map(({ place, host }) => ({ place, host })),
    [{ place: 'remote', host: 'host-a' }],
  );
  assert.match(shown.split('\n')[0], /host-a.*read-only/);
  assert.ok(shown.endsWith(readFileSync(ledger, 'utf8')), shown);
  assert.notEqual(went.status, 0, went.stdout);
  assert.match(went.stderr, /host-a/);
  assert.equal(existsSync(path.join(elsewhere, '.claude/worktrees', SLUG)), false, 'a worktree was made');
});

test('a copy is the worktree ledger byte for byte, as Markdown in the folder of the repo key, and another machine prints it so', (t) => {
  const { a, b, ledger } = twoMachines(t);
  appendFileSync(ledger, '\n\n- A line that ends in spaces, then blank lines a task record drops.   \n\n\n');
  const text = readFileSync(ledger, 'utf8');

  ledgerOk(a, 'store', 'mirror');
  ledgerOk(a, 'store', 'sync');
  ledgerOk(b, 'store', 'sync');

  assert.deepEqual(git(a.h, a.clone, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'active/').split('\n'), [`active/host-a/${APP}/${SLUG}.md`]);
  assert.equal(headText(b, copyOf('host-a')), text);
  assert.ok(ledgerOk(b, 'show', SLUG).endsWith(text), 'the copy is not printed byte for byte');
});

test('the allowlist takes a backlog or archive ledger as Markdown or a task record, and an active copy as Markdown only', () => {
  for (const file of ['backlog/app/fix-login.md', 'backlog/app/fix-login.json', 'archive/app/2026-11-01-fix-login.json', 'active/host-a/app/fix-login.md']) {
    assert.ok(isAllowed(file), file);
  }
  assert.equal(isAllowed('active/host-a/app/fix-login.json'), false);
  assert.ok(!GITIGNORE.split('\n').some((line) => line.startsWith('!/active/') && line.endsWith('.json')), GITIGNORE);
});

test('ledger store mirror removes a copy of this machine under a folder name that matches no task, also while its worktree is there', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  const old = `active/host-a/app/${SLUG}.md`;
  mkdirSync(path.dirname(path.join(a.clone, old)), { recursive: true });
  writeFileSync(path.join(a.clone, old), readFileSync(ledger, 'utf8'));
  git(a.h, a.clone, 'add', '-f', '--', old);
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'A copy under the folder name of the repo, from before repo keys.');

  ledgerOk(a, 'store', 'mirror');

  assert.deepEqual(git(a.h, a.clone, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'active/').split('\n'), [copyOf('host-a')]);
  assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');
});

test('ledger store mirror removes the copy of a task whose worktree ledger now has another slug, while its worktree is there', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  const text = readFileSync(ledger, 'utf8');
  const renamed = text.replace(`# Task ledger — ${SLUG}`, '# Task ledger — fix-signup');
  assert.notEqual(renamed, text, 'the ledger has no title to rename');
  writeFileSync(ledger, renamed);

  ledgerOk(a, 'store', 'mirror');

  assert.deepEqual(git(a.h, a.clone, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'active/').split('\n'), [copyOf('host-a', 'fix-signup')]);
  assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');
});

/** Where a machine kept its copies before repo keys: in the folder of the repo's folder name, which is an alias now. */
const oldCopyOf = (host: string): string => `active/${host}/app/${SLUG}.md`;

const writeAliases = (m: Machine, aliases: Record<string, string>): void => writeFileSync(path.join(m.h, '.claude/ledger-aliases-git.json'), JSON.stringify(aliases));

/** twoMachines, with the copy of host-a filed under the old key app, which machine B knows as an alias of APP_KEY. */
function copyUnderOldKey(t: TestContext) {
  const machines = twoMachines(t);
  const { a, b } = machines;
  mkdirSync(path.join(a.clone, path.dirname(oldCopyOf('host-a'))), { recursive: true });
  git(a.h, a.clone, 'mv', '--', copyOf('host-a'), oldCopyOf('host-a'));
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'A copy under the folder name of the repo, from before repo keys.');
  ledgerOk(a, 'store', 'sync');
  writeAliases(b, { app: APP_KEY });
  ledgerOk(b, 'store', 'sync');
  assert.ok(existsSync(path.join(b.clone, oldCopyOf('host-a'))), 'machine B has no copy under the old key');
  return machines;
}

test('a copy of another machine filed under an old repo key is shown, and refused by go, in the repo of the key it is an alias of', (t) => {
  const { b, ledger } = copyUnderOldKey(t);

  const tasks = listed(b).filter(({ slug }) => slug === SLUG);
  const shown = ledgerOk(b, 'show', SLUG);
  const went = run(b, ['go', SLUG]);

  assert.deepEqual(tasks.map(({ place, host }) => ({ place, host })), [{ place: 'remote', host: 'host-a' }]);
  assert.match(shown.split('\n')[0], /host-a.*read-only/);
  assert.ok(shown.endsWith(readFileSync(ledger, 'utf8')), shown);
  assert.notEqual(went.status, 0, went.stdout);
  assert.match(went.stderr, /host-a/);
});

test('ledger list --json gives a copy filed under an old repo key the key it is an alias of as currentRepo', (t) => {
  const { b } = copyUnderOldKey(t);

  const tasks = (JSON.parse(ledgerOk(b, 'list', '--json')) as { tasks: (Listed & { repo: string; currentRepo?: string })[] }).tasks;

  assert.deepEqual(
    tasks.filter(({ slug }) => slug === SLUG).map(({ repo, currentRepo }) => ({ repo, currentRepo })),
    [{ repo: 'app', currentRepo: APP_KEY }],
  );
});

test('after "host" changes, a worktree task here hides its copy on the old host that is filed under an old repo key', (t) => {
  const a = machine(t, remote(t));
  setUpAs(a, 'host-a');
  const ledger = startTask(a);
  ledgerOk(a, 'store', 'mirror');
  mkdirSync(path.join(a.clone, path.dirname(oldCopyOf('host-a'))), { recursive: true });
  git(a.h, a.clone, 'mv', '--', copyOf('host-a'), oldCopyOf('host-a'));
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'A copy under the folder name of the repo, from before repo keys.');
  writeAliases(a, { app: APP_KEY });
  appendFileSync(ledger, '- Written after the copy.\n');
  writeSettings(a, { storage: 'git', host: 'host-a-renamed' });

  const tasks = listed(a).filter(({ slug }) => slug === SLUG);
  const shown = run(a, ['show', SLUG]);

  assert.deepEqual(tasks.map(({ place }) => place), ['worktree']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout, readFileSync(ledger, 'utf8'));
});

test('ledger show --repo <label> from a folder outside the repo finds a copy of another machine filed only under the key with that label', (t) => {
  const { b, ledger } = twoMachines(t);

  const shown = run(b, ['show', SLUG, '--repo', 'app'], { cwd: b.h });

  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout.split('\n')[0], /host-a.*read-only/);
  assert.ok(shown.stdout.endsWith(readFileSync(ledger, 'utf8')), shown.stdout);
});

test('ledger notes of a task on another machine refuses, names the host, says it is read-only, and changes nothing', (t) => {
  const { b } = twoMachines(t);
  const before = readFileSync(path.join(b.clone, copyOf('host-a')), 'utf8');

  for (const args of [
    ['notes', 'check', '--task', SLUG],
    ['notes', 'note', 'A note.', '--task', SLUG],
  ]) {
    const ran = run(b, args);
    assert.equal(ran.status, 1, `${args.join(' ')}: ${ran.stdout}${ran.stderr}`);
    assert.equal(ran.stdout, '', args.join(' '));
    assert.match(ran.stderr, /host-a.*read-only/, args.join(' '));
  }
  assert.equal(readFileSync(path.join(b.clone, copyOf('host-a')), 'utf8'), before);
  assert.equal(git(b.h, b.clone, 'status', '--porcelain'), '');
});

// -------------------------------------------------------------------------------------------------- other storages

for (const storage of ['file', 'sqlite'] as const) {
  test(`with ${storage} storage, ledger store mirror does nothing and prints nothing`, { skip: storage === 'sqlite' && noSqlite }, (t) => {
    const a = machine(t, remote(t));
    writeSettings(a, { storage, host: 'host-a' });
    startTask(a);

    for (const args of [['store', 'mirror'], ['store', 'mirror', '--quiet']]) {
      const ran = run(a, args);
      assert.equal(ran.status, 0, `${args.join(' ')}: ${ran.stderr}`);
      assert.equal(ran.stdout, '', args.join(' '));
      assert.equal(ran.stderr, '', args.join(' '));
    }
    assert.equal(existsSync(a.clone), false, 'a clone was made');
  });
}
