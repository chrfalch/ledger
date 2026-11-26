import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { GITIGNORE, isAllowed } from '../tools/ledger/clone.js';
import { Failure } from '../tools/ledger/failure.js';
import { readTimedText } from '../tools/ledger/files.js';
import { gitStore } from '../tools/ledger/git-store.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { retireTask } from '../tools/ledger/retire.js';
import * as settings from '../tools/ledger/settings.js';
import type { LedgerStore } from '../tools/ledger/store.js';
import { REPO } from './helpers.js';
import { git, home, ledgerText, ok, readLedgerFile, shortLimits, writeLedgerFile, type Fields, type Ran } from './ledger-core-fixtures.js';
import {
  answerGh,
  APP,
  APP_KEY,
  APP_ORIGIN,
  failed,
  gitRan,
  GITHUB_TOKEN,
  hookContextHere,
  hookFile,
  ledgerOk,
  ledgerOkHere,
  lineOf,
  machine,
  plainClone,
  quietEnv,
  remote,
  remoteFiles,
  remoteHead,
  remoteText,
  run,
  runHere,
  today,
  URL,
  type Machine,
} from './ledger-git-fixtures.js';

/** The .gitignore that `ledger store sync init` wrote before active records existed. */
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

/** The pre-push hook ledger installed before active records existed: it lets only backlog and archive ledgers through. */
const HOOK_BEFORE_ACTIVE = readFileSync(path.join(REPO, 'tests/fixtures/ledger-pre-push-before-active.sh'), 'utf8');

type Listed = { slug: string; status: string; place?: string; host?: string };

const SLUG = 'fix-login';

/** The clone path of the active record of the task `slug` of the repo app. */
const recordOf = (slug = SLUG): string => `active/${APP}/${slug}.json`;

/** Where git storage kept the copy of a worktree ledger of the machine `host` before active records. */
const legacyCopyOf = (host: string, slug = SLUG): string => `active/${host}/${APP}/${slug}.md`;

const writeSettings = (m: Machine, fields: object): void => writeFileSync(path.join(m.h, '.claude/ledger-settings.json'), JSON.stringify(fields));

/** `ledger store sync init`, then git storage on a machine named `host`. */
async function setUpAs(m: Machine, host: string): Promise<void> {
  ok(await runHere(m, ['store', 'sync', 'init', URL]));
  writeSettings(m, { storage: 'git', host });
}

/** A backlog task that `ledger go` started: the file of its active record in the clone. */
async function startTask(m: Machine, slug = SLUG): Promise<string> {
  await ledgerOkHere(m, 'task', 'new', slug, '--goal', 'Users cannot log in.');
  await ledgerOkHere(m, 'go', slug);
  const record = path.join(m.clone, recordOf(slug));
  assert.ok(existsSync(record), `ledger go made no active record at ${record}`);
  return record;
}

/** Changes the ledger of the record `file` by hand, as Markdown, and keeps it a record. */
const editRecord = (file: string, change: (markdown: string) => string): void => writeLedgerFile(file, change(readLedgerFile(file)));

const headText = (m: Machine, file: string): string => gitRan(m.h, m.clone, 'show', `HEAD:${file}`).stdout;

const inHead = (m: Machine, file: string): boolean => gitRan(m.h, m.clone, 'cat-file', '-e', `HEAD:${file}`).status === 0;

const listed = async (m: Machine, ...args: string[]): Promise<Listed[]> => (JSON.parse(await ledgerOkHere(m, 'list', ...args, '--json')) as { tasks: Listed[] }).tasks;

const linesWith = (text: string, needle: string): string[] => text.split('\n').filter((line) => line.includes(needle));

/** The task's worktree of a machine. */
const worktreeOf = (m: Machine, slug = SLUG): string => path.join(m.app, '.claude/worktrees', slug);

/** Machine A, named host-a, with a started task it pushed; machine B, named host-b, synced after it. `shown` is the ledger as A prints it. */
async function twoMachines(t: TestContext) {
  const bare = remote(t);
  const a = machine(t, bare);
  await setUpAs(a, 'host-a');
  const record = await startTask(a);
  await ledgerOkHere(a, 'store', 'sync');
  const b = machine(t, bare);
  answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });
  await setUpAs(b, 'host-b');
  await ledgerOkHere(b, 'store', 'sync');
  return { bare, a, b, record, shown: await ledgerOkHere(a, 'show', SLUG) };
}

/** Edits the record of A's task by hand on A, then pushes it, and pulls it to B. */
async function changeOnA({ a, b, record }: Awaited<ReturnType<typeof twoMachines>>, change: (markdown: string) => string): Promise<void> {
  editRecord(record, change);
  await ledgerOkHere(a, 'store', 'sync');
  await ledgerOkHere(b, 'store', 'sync');
}

// ------------------------------------------------------------------------------------------------------------ host name

test('hostLabel is the host name up to its first dot, in lowercase, with each character outside a-z, 0-9 and - as -', () => {
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

test('ledger store sync and the pre-push hook of a manual git push both refuse a copy in a host folder that is no label', async (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  await setUpAs(a, 'host-a');
  await ledgerOkHere(a, 'store', 'sync');
  const before = remoteHead(bare);
  const file = 'active/Host_A/app/fix-login.md';
  mkdirSync(path.dirname(path.join(a.clone, file)), { recursive: true });
  writeFileSync(path.join(a.clone, file), ledgerText({ slug: SLUG, main: a.app }));
  git(a.h, a.clone, 'add', '-f', '--', file);
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'by hand');

  const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');
  const synced = await runHere(a, ['store', 'sync']);

  for (const [who, ran] of [['git push', pushed], ['ledger store sync', synced]] as const) {
    assert.notEqual(ran.status, 0, `${who} was not blocked`);
    assert.ok(`${ran.stdout}${ran.stderr}`.includes(file), `${who} does not name ${file}:\n${ran.stdout}${ran.stderr}`);
  }
  assert.equal(remoteHead(bare), before);
});

test('with a "host" that is no label, the session start still exits 0', async (t) => {
  const a = machine(t, remote(t));
  await setUpAs(a, 'host-a');
  await startTask(a);
  writeSettings(a, { storage: 'git', host: 'Work Laptop' });

  const started = await runHere(a, ['hook', 'session-start'], { cwd: a.app, input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: a.app }) });

  assert.equal(started.status, 0, started.stderr);
});

test('the active record of a task names the host of the machine that started it: "host", else the label of its host name', async (t) => {
  const a = machine(t, remote(t));
  ok(await runHere(a, ['store', 'sync', 'init', URL]));
  writeSettings(a, { storage: 'git' });
  const unset = await startTask(a);
  writeSettings(a, { storage: 'git', host: 'work-laptop' });
  const set = await startTask(a, 'second');

  assert.match(readLedgerFile(unset), new RegExp(`^- host: ${settings.hostLabel(os.hostname())}$`, 'm'));
  assert.match(readLedgerFile(set), /^- host: work-laptop$/m);
});

// ---------------------------------------------------------------------------------------------------- another machine

test('a started task is committed as its active record, and another machine lists it as on host-a', async (t) => {
  const { bare, b } = await twoMachines(t);

  assert.ok(remoteFiles(bare).includes(recordOf()), 'the record is not on the remote');
  assert.match(linesWith(await ledgerOkHere(b, 'list'), SLUG).join('\n'), /on host-a/);
  const entries = (await listed(b)).filter(({ slug }) => slug === SLUG);
  assert.equal(entries.length, 1, JSON.stringify(entries));
  assert.equal(entries[0].place, 'active');
  assert.equal(entries[0].host, 'host-a');
});

test('ledger show of a task on another machine says it is read-only and on which host, then prints the ledger unchanged', async (t) => {
  const { b, shown: text } = await twoMachines(t);

  const shown = await ledgerOkHere(b, 'show', SLUG);

  const firstLine = shown.split('\n')[0];
  assert.match(firstLine, /read-only/);
  assert.match(firstLine, /host-a/);
  assert.ok(shown.endsWith(text), `the ledger is not printed unchanged:\n${shown}`);
  assert.equal(shown.slice(0, shown.length - text.length).trim(), firstLine.trim(), 'more than one line before the ledger');
});

test('ledger go of a task on another machine exits non-zero, names the host, says it is read-only, and creates nothing', async (t) => {
  const { b } = await twoMachines(t);
  const head = git(b.h, b.clone, 'rev-parse', 'HEAD');

  const ran = await runHere(b, ['go', SLUG]);

  assert.notEqual(ran.status, 0, ran.stdout);
  assert.match(ran.stderr, /host-a/);
  assert.match(ran.stderr, /read-only/);
  assert.equal(existsSync(path.join(b.app, '.claude/worktrees', SLUG)), false, 'a worktree was made');
  assert.equal(git(b.h, b.app, 'branch', '--list', `*${SLUG}*`), '', 'a branch was made');
  assert.equal(git(b.h, b.clone, 'rev-parse', 'HEAD'), head);
  assert.equal(git(b.h, b.clone, 'status', '--porcelain'), '');
});

test('ledger go of a task on another machine refuses also when it has a child in the backlog here, and starts no child', async (t) => {
  const machines = await twoMachines(t);
  const { a, b } = machines;
  await ledgerOkHere(a, 'task', 'new', 'kid', '--goal', 'A child of the task on host A.');
  await ledgerOkHere(a, 'tree', 'add', SLUG, 'kid');
  await ledgerOkHere(a, 'store', 'sync');
  await ledgerOkHere(b, 'store', 'sync');

  const ran = await runHere(b, ['go', SLUG]);

  assert.notEqual(ran.status, 0, ran.stdout);
  assert.match(ran.stderr, /host-a/);
  assert.match(ran.stderr, /read-only/);
  assert.equal(existsSync(path.join(b.app, '.claude/worktrees', 'kid')), false, 'the child was started');
});

test('ledger task retire removes the record in the commit that archives the task, and the other machine then lists it as retired', async (t) => {
  const { a, b } = await twoMachines(t);
  assert.ok((await listed(b)).some(({ slug, host }) => slug === SLUG && host === 'host-a'), 'B does not list the task as on host-a before the retire');

  await ledgerOkHere(a, 'task', 'retire', SLUG, '--force');

  const archived = `archive/${APP}/${today()}-${SLUG}.json`;
  const archiving = git(a.h, a.clone, 'log', '--format=%H', '--diff-filter=A', '--', archived);
  assert.notEqual(archiving, '', `no commit adds ${archived}`);
  const changes = git(a.h, a.clone, 'show', '--no-renames', '--name-status', '--format=', archiving).split('\n');
  assert.ok(changes.includes(`A\t${archived}`), changes.join('\n'));
  assert.ok(changes.includes(`D\t${recordOf()}`), `the archive commit does not remove the record:\n${changes.join('\n')}`);
  assert.equal(inHead(a, recordOf()), false);

  await ledgerOkHere(a, 'store', 'sync');
  await ledgerOkHere(b, 'store', 'sync');

  assert.deepEqual((await listed(b)).filter(({ slug }) => slug === SLUG), []);
  const all = (await listed(b, '--archived')).filter(({ slug }) => slug === SLUG);
  assert.deepEqual(all.map(({ status }) => status), ['retired']);
  assert.ok(all.every(({ host }) => host === undefined));
});

test('an active task hides a backlog ledger with the same repo and slug', async (t) => {
  const { b } = await twoMachines(t);
  const twin = path.join(b.clone, 'backlog', APP, `${SLUG}.md`);
  mkdirSync(path.dirname(twin), { recursive: true });
  writeFileSync(twin, ledgerText({ slug: SLUG, main: b.app, goal: 'The backlog twin.' }));
  git(b.h, b.clone, 'add', '-f', '--', `backlog/${APP}/${SLUG}.md`);
  git(b.h, b.clone, 'commit', '--quiet', '-m', 'a backlog twin');

  const entries = (await listed(b)).filter(({ slug }) => slug === SLUG);

  assert.deepEqual(
    entries.map(({ place, host }) => ({ place, host })),
    [{ place: 'active', host: 'host-a' }],
  );
  assert.equal(linesWith(await ledgerOkHere(b, 'list'), SLUG).length, 1);
});

test('a clone of the same remote under another folder name sees the task of another machine as on host-a, by its repo key', async (t) => {
  const { b, shown: text } = await twoMachines(t);
  const elsewhere = path.join(b.h, 'repos', 'login-service');
  git(b.h, b.h, 'clone', '--quiet', APP_ORIGIN, elsewhere);

  const tasks = (JSON.parse(ok(await runHere(b, ['list', '--json'], { cwd: elsewhere }))) as { tasks: Listed[] }).tasks;
  const shown = ok(await runHere(b, ['show', SLUG], { cwd: elsewhere }));
  const went = await runHere(b, ['go', SLUG], { cwd: elsewhere });

  assert.deepEqual(
    tasks.filter(({ slug }) => slug === SLUG).map(({ place, host }) => ({ place, host })),
    [{ place: 'active', host: 'host-a' }],
  );
  assert.match(shown.split('\n')[0], /host-a.*read-only/);
  assert.ok(shown.endsWith(text), shown);
  assert.notEqual(went.status, 0, went.stdout);
  assert.match(went.stderr, /host-a/);
  assert.equal(existsSync(path.join(elsewhere, '.claude/worktrees', SLUG)), false, 'a worktree was made');
});

test('ledger show --repo <label> from a folder outside the repo finds a task of another machine filed only under the key with that label', async (t) => {
  const { b, shown: text } = await twoMachines(t);

  const shown = await runHere(b, ['show', SLUG, '--repo', 'app'], { cwd: b.h });

  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout.split('\n')[0], /host-a.*read-only/);
  assert.ok(shown.stdout.endsWith(text), shown.stdout);
});

test('ledger notes of a task on another machine refuses, names the host, says it is read-only, and changes nothing', async (t) => {
  const { b } = await twoMachines(t);
  const before = readFileSync(path.join(b.clone, recordOf()), 'utf8');

  for (const args of [
    ['notes', 'check', '--task', SLUG],
    ['notes', 'note', 'A note.', '--task', SLUG],
  ]) {
    const ran = await runHere(b, args);
    assert.equal(ran.status, 1, `${args.join(' ')}: ${ran.stdout}${ran.stderr}`);
    assert.equal(ran.stdout, '', args.join(' '));
    assert.match(ran.stderr, /host-a.*read-only/, args.join(' '));
  }
  assert.equal(readFileSync(path.join(b.clone, recordOf()), 'utf8'), before);
  assert.equal(git(b.h, b.clone, 'status', '--porcelain'), '');
});

test('ledger task claim of a task on another machine names the host and says it is read-only, not that it is retired', async (t) => {
  const { b } = await twoMachines(t);

  const claimed = failed(await runHere(b, ['task', 'claim', SLUG, '--session', 's1']));

  assert.match(claimed, /host-a/);
  assert.match(claimed, /read-only/);
  assert.doesNotMatch(claimed, /retired/);
});

test('ledger task park of a task on another machine refuses, names the host, says it is read-only, and changes nothing', async (t) => {
  const { b } = await twoMachines(t);
  const head = git(b.h, b.clone, 'rev-parse', 'HEAD');
  const before = readFileSync(path.join(b.clone, recordOf()), 'utf8');

  const parked = failed(await runHere(b, ['task', 'park', SLUG, '--reason', 'waits for review']));

  assert.match(parked, /host-a/);
  assert.match(parked, /read-only/);
  assert.equal(readFileSync(path.join(b.clone, recordOf()), 'utf8'), before);
  assert.equal(git(b.h, b.clone, 'rev-parse', 'HEAD'), head);
  assert.equal(git(b.h, b.clone, 'status', '--porcelain'), '');
});

/** Writes a backlog ledger as Markdown from before task records, which the store still reads, to the clone of `m`. */
function writeBacklogMarkdown(m: Machine, slug: string, fields: Omit<Fields, 'slug'>): void {
  const file = path.join(m.clone, 'backlog', APP, `${slug}.md`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, ledgerText({ slug, ...fields }));
}

test('ledger tree add of a child under a parent on another machine refuses before it changes the child', async (t) => {
  const { b } = await twoMachines(t);
  await ledgerOkHere(b, 'task', 'new', 'kid', '--goal', 'A child of the task on host A.');
  const kid = path.join(b.clone, 'backlog', APP, 'kid.json');
  const before = readFileSync(kid, 'utf8');

  const added = failed(await runHere(b, ['tree', 'add', SLUG, 'kid']));

  assert.match(added, /host-a/);
  assert.match(added, /read-only/);
  assert.equal(readFileSync(kid, 'utf8'), before, 'the child names a parent it is not a child of');
});

test('ledger tree remove of a child on another machine refuses before it changes the parent here', async (t) => {
  const machines = await twoMachines(t);
  const { b } = machines;
  await changeOnA(machines, (text) => text.replace('## Location\n', '## Location\n- parent: umbrella\n'));
  // Markdown from before task records, which the store still reads: a record cannot be appended to as text.
  const umbrella = path.join(b.clone, 'backlog', APP, 'umbrella.md');
  writeBacklogMarkdown(b, 'umbrella', { goal: 'The parent on host B.', children: [`- ${SLUG}`] });
  const before = readFileSync(umbrella, 'utf8');

  const removed = failed(await runHere(b, ['tree', 'remove', 'umbrella', SLUG]));

  assert.match(removed, /host-a/);
  assert.match(removed, /read-only/);
  assert.equal(readFileSync(umbrella, 'utf8'), before, 'the parent lost its child line');
});

test('ledger tree add numbers the local siblings without an order and leaves a sibling on another machine as it is', async (t) => {
  const machines = await twoMachines(t);
  const { b } = machines;
  await changeOnA(machines, (text) => text.replace('## Location\n', '## Location\n- parent: umbrella\n'));
  writeBacklogMarkdown(b, 'umbrella', { goal: 'The parent on host B.', children: ['- sib', `- ${SLUG}`] });
  writeBacklogMarkdown(b, 'sib', { goal: 'A sibling on host B.', parent: 'umbrella' });
  await ledgerOkHere(b, 'task', 'new', 'kid', '--goal', 'The new child on host B.');
  const record = path.join(b.clone, recordOf());
  const before = readFileSync(record, 'utf8');

  await ledgerOkHere(b, 'tree', 'add', 'umbrella', 'kid');

  assert.match(await ledgerOkHere(b, 'show', 'sib'), /^- order: 1$/m);
  assert.match(await ledgerOkHere(b, 'show', 'kid'), /^- order: 2$/m);
  assert.equal(readFileSync(record, 'utf8'), before, 'the record of the task on host A changed');
});

test('ledger task retire of a child whose parent is on another machine warns with the host, and leaves the parent as it is', async (t) => {
  const machines = await twoMachines(t);
  const { b } = machines;
  await changeOnA(machines, (text) => text.replace('## Next step\n', '## Children\n- kid\n\n## Next step\n'));
  writeBacklogMarkdown(b, 'kid', { goal: 'A child on host B.', parent: SLUG, report: ['- Done on host B.'] });
  const record = path.join(b.clone, recordOf());
  const before = readFileSync(record, 'utf8');
  assert.match(readLedgerFile(record), /^- kid$/m, 'the parent does not list the child');

  const retired = await runHere(b, ['task', 'retire', 'kid']);

  const said = ok(retired) + retired.stderr;
  assert.match(said, /host-a/);
  assert.equal(readFileSync(record, 'utf8'), before, 'the record of the parent changed');
});

// ----------------------------------------------------------------------------------------------------------- repo keys

const writeAliases = (m: Machine, aliases: Record<string, string>): void => writeFileSync(path.join(m.h, '.claude/ledger-aliases-git.json'), JSON.stringify(aliases));

/** twoMachines, with the record of host-a filed under the old key app, which machine B knows as an alias of APP_KEY. */
async function recordUnderOldKey(t: TestContext) {
  const machines = await twoMachines(t);
  const { a, b } = machines;
  const old = `active/app/${SLUG}.json`;
  mkdirSync(path.join(a.clone, 'active/app'), { recursive: true });
  git(a.h, a.clone, 'mv', '--', recordOf(), old);
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'A record under the folder name of the repo, from before repo keys.');
  await ledgerOkHere(a, 'store', 'sync');
  writeAliases(b, { app: APP_KEY });
  await ledgerOkHere(b, 'store', 'sync');
  assert.ok(existsSync(path.join(b.clone, old)), 'machine B has no record under the old key');
  return machines;
}

test('a task of another machine filed under an old repo key is shown, and refused by go, in the repo of the key it is an alias of', async (t) => {
  const { b, shown: text } = await recordUnderOldKey(t);

  const tasks = (await listed(b)).filter(({ slug }) => slug === SLUG);
  const shown = await ledgerOkHere(b, 'show', SLUG);
  const went = await runHere(b, ['go', SLUG]);

  assert.deepEqual(tasks.map(({ place, host }) => ({ place, host })), [{ place: 'active', host: 'host-a' }]);
  assert.match(shown.split('\n')[0], /host-a.*read-only/);
  assert.ok(shown.endsWith(text), shown);
  assert.notEqual(went.status, 0, went.stdout);
  assert.match(went.stderr, /host-a/);
});

test('ledger list --json gives a task of another machine filed under an old repo key the key it is an alias of as currentRepo', async (t) => {
  const { b } = await recordUnderOldKey(t);

  const tasks = (JSON.parse(await ledgerOkHere(b, 'list', '--json')) as { tasks: (Listed & { repo: string; currentRepo?: string })[] }).tasks;

  assert.deepEqual(
    tasks.filter(({ slug }) => slug === SLUG).map(({ repo, currentRepo }) => ({ repo, currentRepo })),
    [{ repo: 'app', currentRepo: APP_KEY }],
  );
});

// ------------------------------------------------------------------------------------------------------ store sync

test('ledger store sync restores an edited or added record of another machine instead of committing it, and warns once for each', async (t) => {
  const { bare, b } = await twoMachines(t);
  const theirs = path.join(b.clone, recordOf());
  const added = recordOf('made-on-b');
  const committed = headText(b, recordOf());
  editRecord(theirs, (text) => text.replace('## Next step\n', '## Next step\nEdited on host B.\n'));
  writeLedgerFile(path.join(b.clone, added), readLedgerFile(theirs).replace(`# Task ledger — ${SLUG}`, '# Task ledger — made-on-b'));

  const synced = await runHere(b, ['store', 'sync']);

  assert.equal(synced.status, 0, synced.stderr);
  const warnings = linesWith(synced.stderr, 'warning:');
  assert.equal(warnings.length, 2, synced.stderr);
  assert.ok(warnings.some((line) => line.includes(recordOf())), synced.stderr);
  assert.ok(warnings.some((line) => line.includes(added)), synced.stderr);
  assert.equal(readFileSync(theirs, 'utf8'), committed);
  assert.equal(existsSync(path.join(b.clone, added)), false);
  assert.equal(remoteText(bare, recordOf()), committed.trimEnd());
  assert.ok(!remoteFiles(bare).includes(added));
  assert.equal(git(b.h, b.clone, 'status', '--porcelain'), '');
});

test('ledger store sync puts back a record of another machine that was staged and then edited, and pushes none of it', async (t) => {
  const { bare, b } = await twoMachines(t);
  const added = recordOf('made-on-b');
  const file = path.join(b.clone, added);
  writeLedgerFile(file, readLedgerFile(path.join(b.clone, recordOf())).replace(`# Task ledger — ${SLUG}`, '# Task ledger — made-on-b'));
  git(b.h, b.clone, 'add', '-f', '--', added);
  editRecord(file, (text) => text.replace('## Next step\n', '## Next step\nEdited after it was staged.\n'));

  const synced = await runHere(b, ['store', 'sync']);

  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(existsSync(file), false);
  assert.ok(!remoteFiles(bare).includes(added));
  assert.equal(git(b.h, b.clone, 'status', '--porcelain'), '');
});

test('ledger store sync warns once for a record of another machine whose removal was staged while it stayed on disk', async (t) => {
  const { b } = await twoMachines(t);
  git(b.h, b.clone, 'rm', '--quiet', '--cached', '--', recordOf());

  const synced = await runHere(b, ['store', 'sync']);

  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(linesWith(synced.stderr, 'warning:').length, 1, synced.stderr);
  assert.ok(inHead(b, recordOf()));
  assert.equal(git(b.h, b.clone, 'status', '--porcelain'), '');
});

test('ledger store sync --quiet puts back a record of another machine without a warning', async (t) => {
  const { b } = await twoMachines(t);
  const committed = headText(b, recordOf());
  editRecord(path.join(b.clone, recordOf()), (text) => text.replace('## Next step\n', '## Next step\nEdited on host B.\n'));

  const synced = await runHere(b, ['store', 'sync', '--quiet']);

  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(synced.stderr, '');
  assert.equal(readFileSync(path.join(b.clone, recordOf()), 'utf8'), committed);
});

/** Puts a git first on PATH that runs `script` for a call whose arguments match the shell pattern `pattern`, and the real git for any other. */
function stubGit(m: Machine, pattern: string, script: string): void {
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path.join(m.h, 'stub-bin/git'), `#!/bin/sh\ncase "$*" in ${pattern}) ${script} ;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
}

const unstubGit = (m: Machine): void => rmSync(path.join(m.h, 'stub-bin/git'), { force: true });

test('ledger store sync commits nothing when git cannot look up HEAD while it puts back a record of another machine', async (t) => {
  const { bare, b } = await twoMachines(t);
  const committed = headText(b, recordOf());
  editRecord(path.join(b.clone, recordOf()), (text) => text.replace('## Next step\n', '## Next step\nEdited on host B.\n'));
  // A ledger of B's own to commit, so the commit takes whatever else the put back left staged.
  writeBacklogMarkdown(b, 'note-on-b', { main: b.app });
  stubGit(b, '*"rev-parse --verify --quiet HEAD"', 'echo "fatal: cannot read HEAD" >&2; exit 128');
  const [head, pushed] = [git(b.h, b.clone, 'rev-parse', 'HEAD'), remoteHead(bare)];

  const synced = await runHere(b, ['store', 'sync']);
  unstubGit(b);

  assert.notEqual(synced.status, 0, 'the sync went through without HEAD');
  assert.equal(git(b.h, b.clone, 'rev-parse', 'HEAD'), head, `the sync committed ${git(b.h, b.clone, 'diff', '--name-only', head, 'HEAD')}`);
  assert.equal(remoteHead(bare), pushed, 'the sync pushed');
  assert.equal(headText(b, recordOf()), committed, `the record of host-a changed in HEAD:\n${synced.stderr}`);
  assert.equal(git(b.h, b.clone, 'show', `:${recordOf()}`), committed.trimEnd(), 'the record of host-a changed in the index');
  assert.equal(remoteText(bare, recordOf()), committed.trimEnd(), 'the record of host-a changed on the remote');
});

test('ledger store sync puts back a record of another machine that an edit left without its host, or as no JSON, and pushes neither', async (t) => {
  const { bare, b } = await twoMachines(t);
  const file = path.join(b.clone, recordOf());
  const committed = headText(b, recordOf());
  const edits: [string, () => void][] = [
    ['no host', () => editRecord(file, (markdown) => markdown.replace(/^- host: host-a\n/m, ''))],
    ['no JSON', () => writeFileSync(file, 'not a record\n')],
  ];

  for (const [edit, change] of edits) {
    change();
    await ledgerOkHere(b, 'store', 'sync');
    assert.equal(headText(b, recordOf()), committed, `${edit}: the edit is committed`);
    assert.equal(remoteText(bare, recordOf()), committed.trimEnd(), `${edit}: the edit is pushed`);
    assert.equal(readFileSync(file, 'utf8'), committed, `${edit}: the edit is left on disk`);
  }
});

test('a forced retire of a task of another machine stays done when a sync runs between its removal of the record and its commit', async (t) => {
  const { b } = await twoMachines(t);
  const paths = ledgerPaths(b.h);
  const store = gitStore(paths, { backgroundSync: false });
  const syncedBetween: LedgerStore = {
    ...store,
    active: {
      ...store.active,
      remove: (repo, name, text) => {
        const removed = store.active.remove(repo, name, text);
        ledgerOk(b, 'store', 'sync');
        return removed;
      },
    },
  };

  retireTask({ paths, cwd: b.app, store: syncedBetween }, SLUG, { dryRun: false, force: true }, { line: () => {}, warn: () => {} });
  store.close?.();

  assert.equal(existsSync(path.join(b.clone, recordOf())), false, 'the record is back on disk');
  assert.equal(inHead(b, recordOf()), false, 'the record is back in HEAD');
  assert.equal(git(b.h, b.clone, 'ls-files', '--', `archive/${APP}/*.json`).split('\n').filter(Boolean).length, 1);
});

test('in a worktree folder of another machine on a shared disk, bare ledger show prints the read-only line and ledger session names no own task', async (t) => {
  const { a, b } = await twoMachines(t);
  const named = await ledgerOkHere(b, 'show', SLUG);
  assert.match(named, /host-a/);

  assert.equal(ok(await runHere(b, ['show'], { cwd: worktreeOf(a) })), named);
  const session = JSON.parse(ok(await runHere(b, ['session', worktreeOf(a), '--json']))) as { own: boolean; title?: string };
  assert.equal(session.own, false);
  assert.equal(session.title, undefined);
});

/** Notes in a file when git looks for unfinished work in the clone of `m` while nothing holds the clone lock. */
function noteLooksOutsideLock(m: Machine): string {
  const outside = path.join(m.h, 'looked-outside-the-lock');
  stubGit(m, '*"--diff-filter=U"*', `[ -e ${JSON.stringify(path.join(m.h, '.claude/ledger-data.lock'))} ] || touch ${JSON.stringify(outside)}`);
  return outside;
}

test('ledger store sync looks for unfinished work in the clone only while it holds the clone lock', async (t) => {
  const a = machine(t, remote(t));
  await setUpAs(a, 'host-a');
  await ledgerOkHere(a, 'store', 'sync');
  writeFileSync(path.join(a.clone, '.gitignore'), GITIGNORE_BEFORE_ACTIVE);
  const outside = noteLooksOutsideLock(a);

  await ledgerOkHere(a, 'store', 'sync');
  unstubGit(a);

  assert.equal(existsSync(outside), false, 'the sync looked for unfinished work without the clone lock, so it may write the .gitignore into it');
});

test('the session start looks for unfinished work in the clone only while it holds the clone lock', async (t) => {
  const a = machine(t, remote(t));
  await setUpAs(a, 'host-a');
  await ledgerOkHere(a, 'store', 'sync');
  writeFileSync(path.join(a.clone, '.gitignore'), GITIGNORE_BEFORE_ACTIVE);
  const outside = noteLooksOutsideLock(a);

  await hookContextHere(a, a.app);
  unstubGit(a);

  assert.equal(existsSync(outside), false, 'the session start looked for unfinished work without the clone lock, so it may write the .gitignore into it');
});

test('with a "host" that is no label, ledger store sync still commits and pushes a backlog ledger', async (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  await setUpAs(a, 'host-a');
  writeSettings(a, { storage: 'git', host: 'Work Laptop' });
  await ledgerOkHere(a, 'task', 'new', 'note', '--goal', 'Written while the host is wrong.');

  await ledgerOkHere(a, 'store', 'sync');

  assert.ok(remoteFiles(bare).includes(`backlog/${APP}/note.json`), 'the backlog ledger is not on the remote');
});

test('with a "host" that is no label, a store write commits its ledger and leaves the active records as HEAD has them', async (t) => {
  const a = machine(t, remote(t));
  await setUpAs(a, 'host-a');
  const record = await startTask(a);
  const committed = headText(a, recordOf());
  editRecord(record, (text) => text.replace('## Next step\n', '## Next step\nNot committed yet.\n'));
  writeSettings(a, { storage: 'git', host: 'Work Laptop' });

  await ledgerOkHere(a, 'task', 'new', 'note', '--goal', 'Written while the host is wrong.');

  assert.ok(inHead(a, `backlog/${APP}/note.json`), 'the backlog ledger is not committed');
  assert.equal(headText(a, recordOf()), committed);
  assert.equal(readFileSync(record, 'utf8'), committed);
  assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');
});

test('with a "host" that is no label, the session start in a worktree still prints its ledger', async (t) => {
  const a = machine(t, remote(t));
  await setUpAs(a, 'host-a');
  await startTask(a);
  writeSettings(a, { storage: 'git', host: 'Work Laptop' });

  const context = await hookContextHere(a, worktreeOf(a));

  assert.match(context, new RegExp(`^Task ${SLUG} in \\S*/${SLUG} — `, 'm'));
});

test('with a "host" that is no label, the session start still ends by its deadline when git stalls', async (t) => {
  const a = machine(t, remote(t));
  await setUpAs(a, 'host-a');
  await startTask(a);
  writeSettings(a, { storage: 'git', host: 'Work Laptop' });
  // The pull uses up its time, and so leaves the ledgers a fifth of the hook's limit; git in the repo then hangs.
  stubGit(a, '*" fetch "*|*"worktree list"*', 'exec sleep 10');
  const hookMs = 2000;

  const began = Date.now();
  const ran = run(a, ['hook', 'session-start'], { cwd: worktreeOf(a), env: { ...quietEnv(a), ...shortLimits({ hookMs }) }, input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: worktreeOf(a) }) });
  const took = Date.now() - began;
  unstubGit(a);

  assert.equal(ran.status, 0, ran.stderr);
  // The hook's limit, and some time for node to start.
  assert.ok(took < hookMs + 2_000, `the session start took ${took} ms`);
});

// --------------------------------------------------------------------------------------- clones from before records

async function cloneBeforeActive(t: TestContext): Promise<{ bare: string; a: Machine }> {
  const bare = remote(t);
  const a = machine(t, bare);
  await setUpAs(a, 'host-a');
  const other = plainClone(a);
  writeFileSync(path.join(other, '.gitignore'), GITIGNORE_BEFORE_ACTIVE);
  git(a.h, other, 'commit', '--quiet', '--allow-empty', '-am', 'the .gitignore before active records');
  git(a.h, other, 'push', '--quiet', '--no-verify', 'origin', 'HEAD:main');
  await ledgerOkHere(a, 'store', 'sync');
  writeFileSync(hookFile(a), HOOK_BEFORE_ACTIVE);
  chmodSync(hookFile(a), 0o755);
  return { bare, a };
}

test('ledger store sync leaves the .gitignore as it is while a merge is in progress in the clone', async (t) => {
  const { a } = await cloneBeforeActive(t);
  writeFileSync(path.join(a.clone, '.git/MERGE_HEAD'), git(a.h, a.clone, 'rev-parse', 'HEAD'));

  const synced = failed(await runHere(a, ['store', 'sync']));

  assert.match(synced, /A merge is in progress/);
  assert.equal(readFileSync(path.join(a.clone, '.gitignore'), 'utf8'), GITIGNORE_BEFORE_ACTIVE);
});

test('a clone made before active records is repaired by ledger store sync, which then pushes the record', async (t) => {
  const { bare, a } = await cloneBeforeActive(t);
  await startTask(a);

  await ledgerOkHere(a, 'store', 'sync');

  assert.ok(remoteFiles(bare).includes(recordOf()), 'the record is not on the remote');
  assert.equal(readFileSync(path.join(a.clone, '.gitignore'), 'utf8'), GITIGNORE);
  assert.equal(remoteText(bare, '.gitignore'), GITIGNORE.trimEnd());
});

test('a clone made before active records is repaired by the session start, so a manual git push of the record goes through its hook', async (t) => {
  const { bare, a } = await cloneBeforeActive(t);
  await startTask(a);

  await hookContextHere(a, a.app);
  const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');

  assert.equal(pushed.status, 0, pushed.stderr);
  assert.ok(remoteFiles(bare).includes(recordOf()), 'the record is not on the remote');
  assert.equal(readFileSync(path.join(a.clone, '.gitignore'), 'utf8'), GITIGNORE);
  assert.equal(remoteText(bare, '.gitignore'), GITIGNORE.trimEnd());
});

/** A clone of `m` that holds, as committed, the copy of a worktree ledger of `host` that git storage kept before active records. */
function withLegacyCopy(m: Machine, host: string): string {
  const copy = legacyCopyOf(host);
  mkdirSync(path.dirname(path.join(m.clone, copy)), { recursive: true });
  writeFileSync(path.join(m.clone, copy), ledgerText({ slug: SLUG, main: m.app, goal: 'A copy from before active records.' }));
  git(m.h, m.clone, 'add', '-f', '--', copy);
  git(m.h, m.clone, 'commit', '--quiet', '-m', 'a copy from before active records');
  return copy;
}

test('a copy of a worktree ledger from before active records is ignored by reads, and the first write removes it in its commit', async (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  await setUpAs(a, 'host-a');
  await ledgerOkHere(a, 'store', 'sync');
  const copy = withLegacyCopy(a, 'host-z');

  assert.deepEqual((await listed(a)).filter(({ slug }) => slug === SLUG), [], 'the copy is listed as a task');
  assert.notEqual((await runHere(a, ['show', SLUG])).status, 0, 'the copy is shown as a ledger');
  assert.ok(existsSync(path.join(a.clone, copy)), 'a read removed the copy');

  await ledgerOkHere(a, 'task', 'new', 'note', '--goal', 'The first write.');

  assert.equal(existsSync(path.join(a.clone, copy)), false, 'the write left the copy on disk');
  assert.equal(inHead(a, copy), false, 'the write left the copy in HEAD');
  assert.equal(inHead(a, `backlog/${APP}/note.json`), true);
  assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');
  await ledgerOkHere(a, 'store', 'sync');
  assert.ok(!remoteFiles(bare).includes(copy), 'the removal of the copy is not pushed');
});

test('the first write removes only the copies of worktree ledgers from before active records, and keeps every other file and folder in active/', async (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  await setUpAs(a, 'host-a');
  await startTask(a);
  await ledgerOkHere(a, 'store', 'sync');
  const copy = withLegacyCopy(a, 'host-z');
  const kept = [`active/host-z/${APP}/notes.txt`, `active/host-z/${APP}/old/draft.md`, `active/${APP}/backup/${SLUG}.json`].map((file) => path.join(a.clone, file));
  for (const file of kept) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'kept by hand\n');
  }

  await ledgerOkHere(a, 'task', 'new', 'note', '--goal', 'The first write.');

  assert.equal(existsSync(path.join(a.clone, copy)), false, 'the write left the copy on disk');
  for (const file of kept) assert.equal(existsSync(file) && readFileSync(file, 'utf8'), 'kept by hand\n', file);
  assert.deepEqual((await listed(a)).filter(({ slug }) => slug === SLUG).map(({ place }) => place), ['active']);
});

// --------------------------------------------------------------------------------------------------------- secret scan

test('a token in an active record blocks its push: file:line is named, the token is not printed, the commit stays local', async (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  await setUpAs(a, 'host-a');
  const record = await startTask(a);
  await ledgerOkHere(a, 'store', 'sync');
  await ledgerOkHere(a, 'notes', 'note', `Use ${GITHUB_TOKEN} to log in.`, '--task', SLUG);
  const hit = `${recordOf()}:${lineOf(readFileSync(record, 'utf8'), GITHUB_TOKEN)}`;
  const before = remoteHead(bare);

  const synced = failed(await runHere(a, ['store', 'sync']));
  const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');

  assert.ok(synced.includes(hit), synced);
  assert.notEqual(pushed.status, 0, 'git push was not blocked');
  assert.ok(pushed.stderr.includes(hit), pushed.stderr);
  assert.ok(!`${synced}${pushed.stderr}`.includes(GITHUB_TOKEN), 'the token is printed');
  assert.equal(remoteHead(bare), before);
  assert.ok(headText(a, recordOf()).includes(GITHUB_TOKEN), 'the note is not committed');
  assert.equal(JSON.parse(readFileSync(a.status, 'utf8')).problem, 'secret');
});

// ----------------------------------------------------------------------------------------------------------- reading

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

// --------------------------------------------------------------------------------------------------------- host rename

/** Machine A, named host-a, with a started task, then renamed host-a-renamed; `shown` is the ledger as A printed it before. */
async function renamedHost(t: TestContext, before: (a: Machine, record: string) => void = () => {}) {
  const a = machine(t, remote(t));
  await setUpAs(a, 'host-a');
  const record = await startTask(a);
  before(a, record);
  const shown = await ledgerOkHere(a, 'show', SLUG);
  writeSettings(a, { storage: 'git', host: 'host-a-renamed' });
  return { a, record, shown };
}

test('starting a task notes its host label in ~/.claude/ledger-hosts.json, outside the store', async (t) => {
  const { a } = await renamedHost(t);

  assert.deepEqual(JSON.parse(readFileSync(path.join(a.h, '.claude/ledger-hosts.json'), 'utf8')), ['host-a']);
  assert.equal(git(a.h, a.clone, 'ls-files', '--', '*ledger-hosts*'), '');
});

test('after "host" changes, this machine lists its task as active here, not as one on its old host', async (t) => {
  const { a } = await renamedHost(t);

  const entries = (await listed(a)).filter(({ slug }) => slug === SLUG);

  assert.deepEqual(entries.map(({ status, place, host }) => ({ status, place, host })), [{ status: 'active', place: 'active', host: undefined }]);
});

test('after "host" changes, ledger show prints the ledger of a task of this machine without the read-only line', async (t) => {
  const { a, shown } = await renamedHost(t);

  const ran = await runHere(a, ['show', SLUG]);

  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stderr, '');
  assert.equal(ran.stdout, shown);
});

test('after "host" changes, ledger show --repo from a folder outside the repo prints the ledger without the read-only line', async (t) => {
  const { a, shown } = await renamedHost(t);

  assert.equal(await ledgerOkHere(a, 'show', SLUG, '--repo', APP_KEY), shown);
  assert.equal(ok(await runHere(a, ['show', SLUG, '--repo', APP_KEY], { cwd: a.h })), shown);
});

test('after "host" changes, a task of this machine filed under an old repo key is listed as active here and shown without the read-only line', async (t) => {
  const { a, shown } = await renamedHost(t, (m) => {
    mkdirSync(path.join(m.clone, 'active/app'), { recursive: true });
    git(m.h, m.clone, 'mv', '--', recordOf(), `active/app/${SLUG}.json`);
    git(m.h, m.clone, 'commit', '--quiet', '-m', 'A record under the folder name of the repo, from before repo keys.');
    writeAliases(m, { app: APP_KEY });
  });

  const tasks = (await listed(a)).filter(({ slug }) => slug === SLUG);

  assert.deepEqual(tasks.map(({ place, host }) => ({ place, host })), [{ place: 'active', host: undefined }]);
  assert.equal(await ledgerOkHere(a, 'show', SLUG), shown);
});

test('after "host" changes, notes, park, go and retire of a task this machine started go through, and the first write names the new host', async (t) => {
  const { a, record } = await renamedHost(t);

  await ledgerOkHere(a, 'notes', 'note', 'Written after the rename.', '--task', SLUG);
  assert.match(readLedgerFile(record), /^- host: host-a-renamed$/m);
  assert.match(headText(a, recordOf()), /"host": "host-a-renamed"/);
  assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');
  assert.deepEqual(JSON.parse(readFileSync(path.join(a.h, '.claude/ledger-hosts.json'), 'utf8')), ['host-a', 'host-a-renamed']);

  await ledgerOkHere(a, 'task', 'park', SLUG, '--reason', 'waits for review');
  await ledgerOkHere(a, 'go', SLUG);
  await ledgerOkHere(a, 'task', 'retire', SLUG, '--force');
  assert.equal(inHead(a, recordOf()), false);
});

test('a plain ledger task retire finishes a retire whose worktree removal deleted the folder and then failed', async (t) => {
  const a = machine(t, remote(t));
  await setUpAs(a, 'host-a');
  await startTask(a);
  const worktree = worktreeOf(a);
  stubGit(a, '*"worktree remove"*', `rm -rf ${JSON.stringify(worktree)}; echo "fatal: refused by the test" >&2; exit 128`);
  let first: Ran;
  try {
    first = await runHere(a, ['task', 'retire', SLUG, '--force']);
  } finally {
    unstubGit(a);
  }
  assert.notEqual(first.status, 0, first.stdout);
  assert.equal(existsSync(worktree), false, 'the stub left the worktree folder');

  const second = await runHere(a, ['task', 'retire', SLUG]);

  assert.equal(second.status, 0, second.stderr);
  assert.equal(existsSync(path.join(a.clone, recordOf())), false, 'the record is left');
  assert.equal(inHead(a, recordOf()), false);
  const copies = git(a.h, a.clone, 'ls-files', '--', `archive/${APP}/*.json`).split('\n').filter(Boolean);
  assert.deepEqual(copies, [`archive/${APP}/${today()}-${SLUG}.json`]);
});

/** A started task whose forced retire archived it, then failed in a worktree removal that deleted the whole folder. */
async function retiredHalfway(t: TestContext, { unmerged = false } = {}) {
  const a = machine(t, remote(t));
  await setUpAs(a, 'host-a');
  const record = await startTask(a);
  const worktree = worktreeOf(a);
  if (unmerged) git(a.h, worktree, 'commit', '--quiet', '--allow-empty', '-m', 'work');
  const buildFolder = path.join(fs.realpathSync(a.app), '.claude/worktrees/.build', SLUG);
  mkdirSync(path.join(buildFolder, 'Debug-sim'), { recursive: true });
  stubGit(a, '*"worktree remove"*', `rm -rf ${JSON.stringify(worktree)}; echo "fatal: refused by the test" >&2; exit 128`);
  try {
    assert.notEqual((await runHere(a, ['task', 'retire', SLUG, '--force'])).status, 0, 'the first retire went through');
  } finally {
    unstubGit(a);
  }
  assert.equal(existsSync(worktree), false, 'the stub left the worktree folder');
  return { a, record, worktree, buildFolder };
}

const branchExists = (m: Machine, branch: string): boolean => gitRan(m.h, m.app, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).status === 0;

test('a plain rerun of a retire whose worktree folder is gone prunes the worktree, deletes the merged branch and the build folder', async (t) => {
  const { a, buildFolder } = await retiredHalfway(t);
  assert.ok(branchExists(a, SLUG), 'the first retire deleted the branch');

  const rerun = await runHere(a, ['task', 'retire', SLUG]);

  assert.equal(rerun.status, 0, rerun.stderr);
  assert.doesNotMatch(git(a.h, a.app, 'worktree', 'list', '--porcelain'), /prunable/);
  assert.equal(branchExists(a, SLUG), false, 'the merged branch is kept');
  assert.match(rerun.stdout, new RegExp(`^deleted  branch ${SLUG}$`, 'm'));
  assert.ok(rerun.stdout.includes(`deleted  ${buildFolder}`), rerun.stdout);
});

test('a plain rerun of a retire whose worktree folder is gone keeps an unmerged branch and names it', async (t) => {
  const { a } = await retiredHalfway(t, { unmerged: true });

  const rerun = await runHere(a, ['task', 'retire', SLUG]);

  assert.equal(rerun.status, 0, rerun.stderr);
  assert.doesNotMatch(git(a.h, a.app, 'worktree', 'list', '--porcelain'), /prunable/);
  assert.ok(branchExists(a, SLUG), 'the unmerged branch was deleted');
  assert.equal(linesWith(rerun.stdout, `kept     branch ${SLUG}, because it is not merged`).length, 1, rerun.stdout);
});

test('a plain rerun of a retire whose worktree folder is gone keeps the branch once another worktree has it checked out', async (t) => {
  const { a } = await retiredHalfway(t);
  git(a.h, a.app, 'worktree', 'prune');
  const reused = path.join(a.h, 'reused');
  git(a.h, a.app, 'worktree', 'add', '--quiet', reused, SLUG);

  const rerun = await runHere(a, ['task', 'retire', SLUG]);

  assert.equal(rerun.status, 0, rerun.stderr);
  assert.ok(branchExists(a, SLUG), 'the branch checked out in another worktree was deleted');
  assert.match(rerun.stdout, new RegExp(`^kept     branch ${SLUG}, because .*${reused}`, 'm'));
  assert.equal(existsSync(path.join(a.clone, recordOf())), false, 'the record is left');
});

test('a plain rerun finishes the branch and the build folder of a retire that stopped as it deleted the branch', async (t) => {
  const a = machine(t, remote(t));
  await setUpAs(a, 'host-a');
  await startTask(a);
  const buildFolder = path.join(fs.realpathSync(a.app), '.claude/worktrees/.build', SLUG);
  mkdirSync(path.join(buildFolder, 'Debug-sim'), { recursive: true });
  // The retire stops for good there, as when its process is killed.
  // exit: without it the stub outlives its parent and still runs the real git, racing the check below.
  stubGit(a, '*"update-ref -d"*', 'kill -9 $PPID; exit 137');
  try {
    assert.notEqual(run(a, ['task', 'retire', SLUG]).status, 0, 'the first retire went through');
  } finally {
    unstubGit(a);
  }
  assert.ok(branchExists(a, SLUG), 'the first retire deleted the branch');

  const rerun = await runHere(a, ['task', 'retire', SLUG]);

  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(branchExists(a, SLUG), false, 'the merged branch is kept');
  assert.ok(rerun.stdout.includes(`deleted  ${buildFolder}`), rerun.stdout);
  assert.equal(existsSync(path.join(a.clone, recordOf())), false, 'the record is left');
});

test('a plain retire of a task of this machine whose worktree folder is gone still needs --force when the archive holds no copy of it', async (t) => {
  const a = machine(t, remote(t));
  await setUpAs(a, 'host-a');
  await startTask(a);
  git(a.h, a.app, 'worktree', 'remove', '--force', worktreeOf(a));

  const refused = failed(await runHere(a, ['task', 'retire', SLUG]));

  assert.match(refused, /--force/);
  assert.ok(existsSync(path.join(a.clone, recordOf())), 'the record is gone');
});

test('a plain retire of a task of this machine whose worktree folder is gone still needs --force when its archive copy holds other text', async (t) => {
  const { a, record } = await retiredHalfway(t);
  editRecord(record, (markdown) => markdown.replace('## Next step\n', '## Next step\nA line written after the archive copy.\n'));
  assert.match(readLedgerFile(record), /A line written after the archive copy/);

  const refused = failed(await runHere(a, ['task', 'retire', SLUG]));

  assert.match(refused, /--force/);
  assert.ok(existsSync(record), 'the record is gone');
});

test('a plain rerun with --json of a retire whose worktree folder is gone gives its place as active', async (t) => {
  const { a } = await retiredHalfway(t);

  const retired = JSON.parse(await ledgerOkHere(a, 'task', 'retire', SLUG, '--json')) as { place: string };

  assert.equal(retired.place, 'active');
});
