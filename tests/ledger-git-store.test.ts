import assert from 'node:assert/strict';
import { spawn as spawnAsync, spawnSync } from 'node:child_process';
import fs, { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { clearStatus, cloneEnv, readStatus, recordProblem, SyncProblem } from '../tools/ledger/clone.js';
import { fileStore } from '../tools/ledger/file-store.js';
import { gitStore } from '../tools/ledger/git-store.js';
import { withLock } from '../tools/ledger/lock.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { parseRecord, readRecordJson, recordJson, renderRecord } from '../tools/ledger/record.js';
import { sqliteStore } from '../tools/ledger/sqlite-store.js';
import type { LedgerStore } from '../tools/ledger/store.js';
import { allowRemoteForTests, pullForSession } from '../tools/ledger/sync.js';
import { REPO } from './helpers.js';
import { commandEnv, git, home, LEDGER_BIN, ledgerText, noSqlite, ok, type Ran } from './ledger-core-fixtures.js';
import {
  answerGh,
  APP,
  APP_KEY,
  APP_PATTERN,
  backgroundPids,
  backgroundSyncDone,
  failed,
  gitRan,
  GITHUB_TOKEN,
  hookContext,
  hookFile,
  ledgerOk,
  lineOf,
  machine,
  machineEnv,
  PASSWORD,
  plainClone,
  pushFrom,
  quietEnv,
  remote,
  remoteFiles,
  remoteHead,
  remoteLedger,
  remoteText,
  run,
  runs,
  setUp,
  SSH_URL,
  today,
  token,
  until,
  URL,
  URL_WITH_USERINFO,
  useGitStorage,
  type Machine,
} from './ledger-git-fixtures.js';

const SAMPLES = [
  GITHUB_TOKEN,
  token(['gh', 'o_'].join(''), 'Z9y8X7', 36),
  token(['gh', 'u_'].join(''), 'Q1w2E3', 36),
  token(['gh', 's_'].join(''), 'R4t5Y6', 36),
  token(['gh', 'r_'].join(''), 'U7i8O9', 36),
  token(['github', '_pat_'].join(''), 'Ab1_Cd2_Ef3', 82),
  token(['AK', 'IA'].join(''), 'QWERTY2345', 16),
  `slack ${token(['xo', 'xb-'].join(''), '1234-abcd-', 30)}`,
  ['-----BEGIN RSA PRIVATE', 'KEY-----'].join(' '),
  ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
  `key=${token(['s', 'k-'].join(''), 'aB3dE5gH7j', 48)}`,
  `key: ${token(['s', 'k-ant-'].join(''), 'api03-Xy9_Zw8-Vu7', 95)}`,
  `"${token(['s', 'k-proj-'].join(''), 'Pq1-Rs2_Tu3', 60)}"`,
];

/** Text a scan must let through: prose and slugs that only look a little like a key. */
const NEAR_MISSES = [
  `${['gh', 'p_'].join('')}short`,
  'the task-disk-cache-eviction-on-low-memory-devices-and-more-words is a slug',
  `${['AK', 'IA'].join('')}123`,
  'ask-the-operator-about-the-plan-before-any-more-work-starts',
];

const ALLOWED = /^(\.ledger-data|\.gitignore|(backlog|archive)\/[^/]+\/[^/]+\.(md|json))$/;

/** The pre-push hook is the tool's own, in the clone's own hooks folder, which the clone's core.hooksPath names. */
function assertOwnHook(m: Machine): void {
  assert.match(readFileSync(hookFile(m), 'utf8'), /^#!\/usr\/bin\/env bash\n# Written by ledger/);
  assert.equal(lstatSync(hookFile(m)).mode & 0o777, 0o755);
  assert.equal(gitRan(m.h, m.clone, 'config', '--local', '--get-all', 'core.hooksPath').stdout, `${path.join(m.clone, '.git/hooks')}\n`);
}

/** Elapsed milliseconds of `work`. */
function timed<T>(work: () => T): [T, number] {
  const start = Date.now();
  const result = work();
  return [result, Date.now() - start];
}

/** A ledger command started without waiting for it, so a test can run another one while it works. */
function started(m: Machine, args: string[], env = quietEnv(m)): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawnAsync(LEDGER_BIN, args, { cwd: m.app, env });
    let [stdout, stderr] = ['', ''];
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** A hook of the bare remote, such as pre-receive, as a shell script. */
function remoteHook(bare: string, name: string, lines: string[]): void {
  const file = path.join(bare, 'hooks', name);
  writeFileSync(file, ['#!/bin/sh', ...lines, ''].join('\n'));
  chmodSync(file, 0o755);
}

// ---------------------------------------------------------------------------------------------------------------- init

test('sync init on a private, empty repository clones it, writes the marker and layout, pushes them, and leaves the storage setting alone', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);

  const stdout = ok(run(a, ['store', 'sync', 'init', URL]));

  assert.match(stdout, /github\.com\/me\/ledgers/);
  assert.deepEqual(readFileSync(path.join(a.h, 'gh-calls'), 'utf8').trim().split(' '), ['repo', 'view', 'github.com/me/ledgers', '--json', 'visibility,isEmpty']);
  assert.deepEqual(JSON.parse(readFileSync(path.join(a.clone, '.ledger-data'), 'utf8')), { format: 1 });
  assert.deepEqual(remoteFiles(bare).sort(), ['.gitignore', '.ledger-data']);
  assert.deepEqual(JSON.parse(remoteText(bare, '.ledger-data')), { format: 1 });
  assertOwnHook(a);
  assert.equal(git(a.h, a.clone, 'rev-parse', 'HEAD'), remoteHead(bare));
  for (const folder of ['backlog', 'archive']) assert.ok(lstatSync(path.join(a.clone, folder)).isDirectory(), `${folder}/ is made`);
  assert.equal(existsSync(path.join(a.h, '.claude/ledger-settings.json')), false);
});

test('sync init accepts the ssh form of a GitHub URL', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  ok(run(a, ['store', 'sync', 'init', SSH_URL]));
  assert.ok(remoteFiles(bare).includes('.ledger-data'));
  assert.match(readFileSync(path.join(a.h, 'gh-calls'), 'utf8'), /repo view github\.com\/me\/ledgers /);
});

test('sync init refuses a public repository: exit 1, no clone, nothing pushed', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  answerGh(a.h, { visibility: 'PUBLIC', isEmpty: true });

  const output = failed(run(a, ['store', 'sync', 'init', URL]));

  assert.match(output, /private/i);
  assert.match(output, /PUBLIC/);
  assert.equal(existsSync(a.clone), false);
  assert.equal(remoteHead(bare), '');
});

test('sync init exits 1 with the reason when gh fails, and when gh is not installed', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  answerGh(a.h, 'fail');
  assert.match(failed(run(a, ['store', 'sync', 'init', URL])), /gh/);
  assert.equal(existsSync(a.clone), false);

  const tools = path.join(a.h, 'tools-bin');
  mkdirSync(tools);
  symlinkSync(process.execPath, path.join(tools, 'node'));
  const noGh = { ...quietEnv(a), PATH: [tools, '/usr/bin', '/bin'].join(path.delimiter) };
  assert.equal(spawnSync('sh', ['-c', 'command -v gh'], { env: noGh }).status, 1, 'gh must not be on this PATH');
  const output = failed(run(a, ['store', 'sync', 'init', URL], { env: noGh }));
  assert.match(output, /gh/);
  assert.equal(existsSync(a.clone), false);
  assert.equal(remoteHead(bare), '');
});

test('sync init refuses a URL whose host is not github.com, as it cannot check that it is private', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  const output = failed(run(a, ['store', 'sync', 'init', bare]));
  assert.match(output, /github\.com/);
  assert.equal(existsSync(a.clone), false);
  assert.equal(existsSync(path.join(a.h, 'gh-calls')), false);
});

test('sync init refuses a repository with commits but no .ledger-data marker: exit 1, the clone is removed, the remote is unchanged', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  const other = path.join(a.h, 'other');
  git(a.h, a.h, 'clone', '--quiet', bare, other);
  writeFileSync(path.join(other, 'README.md'), '# something else\n');
  git(a.h, other, 'add', '-A');
  git(a.h, other, 'commit', '--quiet', '-m', 'unrelated');
  git(a.h, other, 'push', '--quiet', 'origin', 'HEAD:main');
  const before = remoteHead(bare);
  answerGh(a.h, { visibility: 'PRIVATE', isEmpty: false });

  const output = failed(run(a, ['store', 'sync', 'init', URL]));

  assert.match(output, /\.ledger-data/);
  assert.equal(existsSync(a.clone), false);
  assert.equal(remoteHead(bare), before);
  assert.deepEqual(remoteFiles(bare), ['README.md']);
});

test('sync init refuses a marker with an unknown format and removes its clone', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  const other = path.join(a.h, 'other');
  git(a.h, a.h, 'clone', '--quiet', bare, other);
  writeFileSync(path.join(other, '.ledger-data'), '{"format":2}\n');
  git(a.h, other, 'add', '-A');
  git(a.h, other, 'commit', '--quiet', '-m', 'newer');
  git(a.h, other, 'push', '--quiet', 'origin', 'HEAD:main');
  answerGh(a.h, { visibility: 'PRIVATE', isEmpty: false });

  assert.match(failed(run(a, ['store', 'sync', 'init', URL])), /format/);
  assert.equal(existsSync(a.clone), false);
});

test('sync init on a second machine accepts a repository with the marker and installs the pre-push hook', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  ok(run(a, ['store', 'sync', 'init', URL]));
  const before = remoteHead(bare);
  const b = machine(t, bare);
  answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });

  ok(run(b, ['store', 'sync', 'init', URL]));

  assert.equal(remoteHead(bare), before);
  assert.equal(git(b.h, b.clone, 'rev-parse', 'HEAD'), before);
  assertOwnHook(b);
});

test('sync init again on the same clone changes nothing; another URL or a folder that is no clone is refused', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  ok(run(a, ['store', 'sync', 'init', URL]));
  const head = git(a.h, a.clone, 'rev-parse', 'HEAD');

  const again = ok(run(a, ['store', 'sync', 'init', URL]));
  assert.match(again, /already/);
  assert.equal(git(a.h, a.clone, 'rev-parse', 'HEAD'), head);
  assert.equal(remoteHead(bare), head);

  assert.match(failed(run(a, ['store', 'sync', 'init', 'https://github.com/me/other.git'])), /ledger-data/);
  assert.equal(git(a.h, a.clone, 'config', 'remote.origin.url'), URL);

  const b = machine(t, bare);
  mkdirSync(b.clone);
  writeFileSync(path.join(b.clone, 'mine.txt'), 'keep\n');
  assert.match(failed(run(b, ['store', 'sync', 'init', URL])), /ledger-data/);
  assert.deepEqual(readdirSync(b.clone), ['mine.txt']);
});

test('sync init refuses a repository with a symbolic link, an executable file or a path outside the allowlist, before any of it is checked out', (t) => {
  const cases: [string, (other: string) => void][] = [
    ['backlog/app/link.md', (other) => symlinkSync('/etc/hosts', path.join(other, 'backlog/app/link.md'))],
    ['backlog/app/run.md', (other) => (writeFileSync(path.join(other, 'backlog/app/run.md'), '# run\n'), chmodSync(path.join(other, 'backlog/app/run.md'), 0o755))],
    ['.githooks/pre-push', (other) => (mkdirSync(path.join(other, '.githooks')), writeFileSync(path.join(other, '.githooks/pre-push'), '#!/bin/sh\n'))],
  ];
  for (const [file, add] of cases) {
    const bare = remote(t);
    const a = machine(t, bare);
    ok(run(a, ['store', 'sync', 'init', URL]));
    const other = plainClone(a);
    mkdirSync(path.join(other, 'backlog/app'), { recursive: true });
    add(other);
    git(a.h, other, 'add', '-f', '-A');
    pushFrom(a, other, `add ${file}`);
    const b = machine(t, bare);
    answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });

    assert.ok(failed(run(b, ['store', 'sync', 'init', URL])).includes(file), file);
    assert.equal(existsSync(b.clone), false, file);
  }
});

test('sync never prints the user name or password of a URL, also when it fails', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  const init = ok(run(a, ['store', 'sync', 'init', URL_WITH_USERINFO]));
  assert.match(init, /https:\/\/github\.com\/me\/ledgers\.git/);
  assert.doesNotMatch(init, new RegExp(PASSWORD));
  assert.doesNotMatch(init, /me:/);
  assert.match(readFileSync(path.join(a.h, 'gh-calls'), 'utf8'), /repo view github\.com\/me\/ledgers /);
  useGitStorage(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  renameSync(bare, `${bare}.away`);

  const output = failed(run(a, ['store', 'sync']));

  assert.doesNotMatch(output, new RegExp(PASSWORD));
  assert.doesNotMatch(output, /me:/);
  const answer = failed(run(a, ['store', 'sync', 'init', 'https://me:other-secret@github.com/me/other.git']));
  assert.doesNotMatch(answer, /other-secret/);
});

// ---------------------------------------------------------------------------------------------------- commands and sync

test('ledger commands under git storage need a set-up clone and say to run ledger store sync init; a hook still exits 0', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  useGitStorage(a);

  assert.match(failed(run(a, ['list'])), /ledger store sync init/);
  assert.match(failed(run(a, ['store', 'sync'])), /ledger store sync init/);
  assert.equal(hookContext(a), '');
});

test('task, park, parent add and retire under git storage each commit in the clone, and ledger store sync pushes them', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const commits = (): number => Number(git(a.h, a.clone, 'rev-list', '--count', 'HEAD'));
  const start = commits();

  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  assert.equal(commits(), start + 1);
  assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');
  assert.ok(!remoteFiles(bare).includes(`backlog/${APP}/fix-login.json`), 'no push without a sync');

  ledgerOk(a, 'task', 'park', 'fix-login', '--reason', 'waits for design');
  ledgerOk(a, 'task', 'new', 'epic', '--goal', 'All of it.');
  ledgerOk(a, 'tree', 'add', 'epic', 'fix-login');
  ledgerOk(a, 'task', 'new', 'idea', '--goal', 'An idea.');
  ledgerOk(a, 'task', 'retire', 'idea');
  assert.equal(commits(), start + 6);
  assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');

  ledgerOk(a, 'store', 'sync');

  assert.equal(remoteHead(bare), git(a.h, a.clone, 'rev-parse', 'HEAD'));
  const files = remoteFiles(bare);
  for (const file of [`backlog/${APP}/fix-login.json`, `backlog/${APP}/epic.json`, `archive/${APP}/${today()}-idea.json`]) assert.ok(files.includes(file), `${file} in ${files.join(', ')}`);
  assert.ok(!files.includes(`backlog/${APP}/idea.json`));
  assert.match(remoteLedger(bare, `backlog/${APP}/fix-login.json`), /Parked: .* — waits for design/);
  assert.match(remoteLedger(bare, `backlog/${APP}/fix-login.json`), /- parent: epic/);
  assert.match(remoteLedger(bare, `backlog/${APP}/epic.json`), /fix-login/);
  assert.equal(existsSync(a.status), false);
});

test('a retire under git storage that cannot delete the backlog ledger keeps its archive copy, says so, and a retry finishes', { skip: process.getuid?.() === 0 }, (t) => {
  const a = machine(t, remote(t));
  setUp(a);
  ledgerOk(a, 'task', 'new', 'idea', '--goal', 'An idea.');
  const backlog = path.join(a.clone, 'backlog', APP);
  const archived = path.join(a.clone, 'archive', APP, `${today()}-idea.json`);
  chmodSync(backlog, 0o555);
  // A retire that goes through removes the folder with its last ledger.
  t.after(() => existsSync(backlog) && chmodSync(backlog, 0o755));

  const retire = run(a, ['task', 'retire', 'idea']);
  chmodSync(backlog, 0o755);

  assert.match(failed(retire), /Could not delete the backlog ledger .* Its archive copy is written\./);
  assert.ok(existsSync(archived), 'the failed retire removed its archive copy');
  assert.ok(existsSync(path.join(backlog, 'idea.json')), 'the backlog ledger is gone');
  ledgerOk(a, 'task', 'retire', 'idea');
  assert.equal(existsSync(path.join(backlog, 'idea.json')), false, 'the retry left the backlog ledger');
  assert.ok(existsSync(archived), 'the retry left no archive copy');
});

test('a second machine sees the ledgers after ledger store sync, and again after its session-start hook pulls', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  ledgerOk(a, 'store', 'sync');
  const b = machine(t, bare);
  answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });
  setUp(b);

  assert.match(ledgerOk(b, 'show', 'fix-login', '--repo', 'app'), /Users cannot log in\./);

  ledgerOk(a, 'task', 'new', 'later', '--goal', 'Comes later.');
  ledgerOk(a, 'store', 'sync');
  assert.notEqual(run(b, ['show', 'later', '--repo', 'app']).status, 0, 'B has not pulled yet');
  hookContext(b);
  assert.match(ledgerOk(b, 'show', 'later', '--repo', 'app'), /Comes later\./);
});

test('without the test switch a command returns first, prints only its own output, and pushes in the background', async (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const quiet = run(a, ['task', 'new', 'quiet-twin', '--goal', 'Users cannot log in.']);
  remoteHook(bare, 'pre-receive', ['sleep 3']);

  const [ran, ms] = timed(() => run(a, ['task', 'new', 'fix-login', '--goal', 'Users cannot log in.'], { env: machineEnv(a) }));

  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stderr, '');
  assert.equal(ran.stdout, quiet.stdout.replaceAll('quiet-twin', 'fix-login'));
  assert.ok(ms < 2500, `the command waited ${ms} ms for the push`);
  assert.ok(!remoteFiles(bare).includes(`backlog/${APP}/fix-login.json`), 'the push was not done yet when the command returned');
  const head = git(a.h, a.clone, 'rev-parse', 'HEAD');
  await until(() => remoteHead(bare) === head && git(a.h, a.clone, 'rev-parse', 'refs/remotes/origin/main') === head && backgroundSyncDone(a), 'the background push');
  assert.ok(remoteFiles(bare).includes(`backlog/${APP}/fix-login.json`));
});

// ------------------------------------------------------------------------------------------------------------ allowlist

test('only allowlisted paths reach the remote: no evidence, registry, lock or temporary file', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'old', '--goal', 'Old work.');
  ledgerOk(a, 'go', 'old');
  const evidence = path.join(a.app, '.claude/worktrees/old/.claude/evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  ledgerOk(a, 'task', 'retire', 'old', '--force');
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  writeFileSync(path.join(a.clone, `backlog/${APP}/fix-login.json.lock`), '{}');
  writeFileSync(path.join(a.clone, `backlog/${APP}/fix-login.json.tmp-123`), 'half');
  writeFileSync(path.join(a.clone, 'notes.txt'), 'private\n');

  ledgerOk(a, 'store', 'sync');

  const name = `${today()}-old`;
  assert.equal(readFileSync(path.join(a.h, `.claude/ledger-evidence/${APP}`, name, 'red.txt'), 'utf8'), 'failing\n');
  assert.equal(existsSync(path.join(a.clone, `archive/${APP}`, name)), false, 'no evidence in the clone');
  assert.ok(existsSync(path.join(a.h, '.claude/ledgers-git.json')), 'the registry stays local');
  const files = remoteFiles(bare);
  assert.ok(files.includes(`archive/${APP}/${name}.json`));
  for (const file of files) assert.match(file, ALLOWED);
});

test('a file a nested .gitignore un-ignores is refused: the sync exits 1, names it, and pushes nothing', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  writeFileSync(path.join(a.clone, `backlog/${APP}/.gitignore`), '!*\n');
  writeFileSync(path.join(a.clone, `backlog/${APP}/evil.txt`), 'un-ignored\n');
  const before = remoteHead(bare);

  const output = failed(run(a, ['store', 'sync']));

  assert.match(output, new RegExp(String.raw`backlog\/${APP_PATTERN}\/evil\.txt`));
  assert.equal(remoteHead(bare), before);
  assert.equal(JSON.parse(readFileSync(a.status, 'utf8')).problem, 'allowlist');
  assert.ok(!remoteFiles(bare).includes(`backlog/${APP}/evil.txt`));
});

test('a non-allowlisted file committed or staged in the clone blocks the push and is named', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  writeFileSync(path.join(a.clone, 'notes.txt'), 'private\n');
  git(a.h, a.clone, 'add', '-f', 'notes.txt');
  const before = remoteHead(bare);

  assert.match(failed(run(a, ['store', 'sync'])), /notes\.txt/);
  assert.equal(remoteHead(bare), before);

  git(a.h, a.clone, 'commit', '--quiet', '-m', 'by hand');
  assert.match(failed(run(a, ['store', 'sync'])), /notes\.txt/);
  assert.equal(remoteHead(bare), before);
  assert.equal(JSON.parse(readFileSync(a.status, 'utf8')).problem, 'allowlist');
});

// ---------------------------------------------------------------------------------------------------------- secret scan

test('a token in a backlog ledger blocks the push: file:line is named, the token is not printed, the commit stays local', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const before = remoteHead(bare);
  ledgerOk(a, 'task', 'new', 'leak', '--goal', `Use ${GITHUB_TOKEN} to log in.`);
  const line = lineOf(readFileSync(path.join(a.clone, `backlog/${APP}/leak.json`), 'utf8'), GITHUB_TOKEN);

  const output = failed(run(a, ['store', 'sync']));

  assert.ok(output.includes(`backlog/${APP}/leak.json:${line}`), output);
  assert.ok(!output.includes(GITHUB_TOKEN), 'the token is printed');
  assert.equal(remoteHead(bare), before);
  git(a.h, a.clone, 'cat-file', '-e', `HEAD:backlog/${APP}/leak.json`);
  const status = readFileSync(a.status, 'utf8');
  assert.equal(JSON.parse(status).problem, 'secret');
  assert.ok(!status.includes(GITHUB_TOKEN));
});

test('ledger store sync and the pre-push hook of a manual git push find the same secrets, in binary text and file names too', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const before = remoteHead(bare);
  const lines = ['# samples', ...SAMPLES, ...NEAR_MISSES, `bin\0ary\0 ${GITHUB_TOKEN}`, ''];
  mkdirSync(path.join(a.clone, `backlog/${APP}`), { recursive: true });
  writeFileSync(path.join(a.clone, `backlog/${APP}/samples.md`), lines.join('\n'));
  const named = `backlog/${APP}/${GITHUB_TOKEN}.md`;
  writeFileSync(path.join(a.clone, named), 'nothing secret inside\n');
  git(a.h, a.clone, 'add', '-A');
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'samples');
  const expected = [...SAMPLES.map((_, index) => index + 2), lines.length - 1].map((line) => `backlog/${APP}/samples.md:${line}`);
  const missed = NEAR_MISSES.map((_, index) => `backlog/${APP}/samples.md:${SAMPLES.length + index + 2}`);

  const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');
  const synced = run(a, ['store', 'sync']);

  for (const [who, ran] of [['git push', pushed], ['ledger store sync', synced]] as const) {
    assert.notEqual(ran.status, 0, `${who} was not blocked`);
    const output = `${ran.stdout}${ran.stderr}`;
    for (const hit of expected) assert.ok(output.split(/\s/).includes(hit) || output.includes(`${hit}\n`), `${who} does not name ${hit}:\n${output}`);
    for (const miss of missed) assert.ok(!output.includes(`${miss}\n`) && !output.split(/\s/).includes(miss), `${who} names ${miss}:\n${output}`);
    assert.match(output, /<file name withheld>/, who);
    for (const sample of [GITHUB_TOKEN, ...SAMPLES.slice(1, 7)]) assert.ok(!output.includes(sample), `${who} printed a secret`);
  }
  assert.equal(remoteHead(bare), before);
});

test('a token added in a merge resolution is caught by ledger store sync and by the pre-push hook', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  ledgerOk(a, 'store', 'sync');
  const before = remoteHead(bare);
  const file = path.join(a.clone, `backlog/${APP}/fix-login.json`);
  const original = readFileSync(file, 'utf8');
  git(a.h, a.clone, 'checkout', '--quiet', '-b', 'side');
  writeFileSync(file, original.replace('Users cannot log in.', 'Users cannot log in on the side.'));
  git(a.h, a.clone, 'commit', '--quiet', '-am', 'side');
  git(a.h, a.clone, 'checkout', '--quiet', 'main');
  writeFileSync(file, original.replace('Users cannot log in.', 'Users cannot log in on main.'));
  git(a.h, a.clone, 'commit', '--quiet', '-am', 'main');
  assert.notEqual(gitRan(a.h, a.clone, 'merge', '--quiet', 'side').status, 0, 'the merge conflicts');
  const resolved = original.replace('Users cannot log in.', `Users cannot log in; use ${GITHUB_TOKEN}.`);
  writeFileSync(file, resolved);
  git(a.h, a.clone, 'commit', '--quiet', '-am', 'merge side');
  const hit = `backlog/${APP}/fix-login.json:${lineOf(resolved, GITHUB_TOKEN)}`;

  const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');
  assert.notEqual(pushed.status, 0);
  assert.ok(pushed.stderr.includes(hit), pushed.stderr);
  const synced = failed(run(a, ['store', 'sync']));
  assert.ok(synced.includes(hit), synced);
  assert.ok(!`${pushed.stderr}${synced}`.includes(GITHUB_TOKEN));
  assert.equal(remoteHead(bare), before);
});

test('ledger store sync and the pre-push hook read a record as its text: a key after an escaped line break, tab or control character is found', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const before = remoteHead(bare);
  const key = token(['s', 'k-'].join(''), 'aB3dE5gH7j', 48);
  const markdown = [
    '# Task ledger — leak',
    '',
    '## Goal',
    'Log in with the key below.',
    key,
    '',
    '## Decisions',
    `- Keep the key\t${key} out of the code`,
    '',
    '## Report',
    `A literal \\n${key} is no line break, so no key starts there.`,
    '',
    '## Next step',
    `Ask.\v${key}`,
    '',
  ].join('\n');
  const json = recordJson(parseRecord(markdown));
  const file = `backlog/${APP}/leak.json`;
  mkdirSync(path.join(a.clone, `backlog/${APP}`), { recursive: true });
  writeFileSync(path.join(a.clone, file), json);
  git(a.h, a.clone, 'add', '-A');
  git(a.h, a.clone, 'commit', '--quiet', '--no-verify', '-m', 'leak');
  const hits = ['"goal"', 'Keep the key', '"next"'].map((needle) => `${file}:${lineOf(json, needle)}`);
  const miss = `${file}:${lineOf(json, 'A literal')}`;

  const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');
  const synced = run(a, ['store', 'sync']);

  for (const [who, ran] of [['git push', pushed], ['ledger store sync', synced]] as const) {
    assert.notEqual(ran.status, 0, `${who} was not blocked`);
    const output = `${ran.stdout}${ran.stderr}`;
    const named = (where: string): boolean => output.split(/\s/).includes(where);
    for (const hit of hits) assert.ok(named(hit), `${who} does not name ${hit}:\n${output}`);
    assert.ok(!named(miss), `${who} names ${miss}:\n${output}`);
    assert.ok(!output.includes(key.slice(3)), `${who} printed the key`);
  }
  assert.equal(remoteHead(bare), before);
});

test('ledger store sync and the pre-push hook read a record whose path holds a space or a double quote as a record, and name it as git shows it', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const before = remoteHead(bare);
  const key = token(['s', 'k-'].join(''), 'aB3dE5gH7j', 48);
  const json = recordJson(parseRecord(['# Task ledger — leak', '', '## Goal', 'Log in with the key below.', key, ''].join('\n')));
  // git ends the +++ line of a path that holds a space with a tab, and quotes a path that holds a double quote.
  const files = [
    ['backlog/my app/leak.json', 'backlog/my app/leak.json'],
    ['backlog/say"hi/leak.json', '"backlog/say\\"hi/leak.json"'],
  ] as const;
  for (const [file] of files) {
    mkdirSync(path.join(a.clone, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(a.clone, file), json);
  }
  git(a.h, a.clone, 'add', '-A');
  git(a.h, a.clone, 'commit', '--quiet', '--no-verify', '-m', 'leak');
  const hits = files.map(([, shown]) => `${shown}:${lineOf(json, '"goal"')}`);

  const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');
  const synced = run(a, ['store', 'sync']);

  for (const [who, ran] of [['git push', pushed], ['ledger store sync', synced]] as const) {
    assert.notEqual(ran.status, 0, `${who} was not blocked`);
    const output = `${ran.stdout}${ran.stderr}`;
    const lines = output.split('\n').map((line) => line.trim());
    for (const hit of hits) assert.ok(lines.includes(hit), `${who} does not name ${hit}:\n${output}`);
    assert.ok(!output.includes(key.slice(3)), `${who} printed the key`);
  }
  assert.equal(remoteHead(bare), before);
});

test('the pre-push hook fails closed: when its scan cannot run, the push is blocked', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const before = remoteHead(bare);
  mkdirSync(path.join(a.clone, `backlog/${APP}`), { recursive: true });
  writeFileSync(path.join(a.clone, `backlog/${APP}/clean.md`), '# clean\n');
  git(a.h, a.clone, 'add', '-A');
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'clean');
  const tools = path.join(a.h, 'no-grep-bin');
  mkdirSync(tools);
  for (const command of ['git', 'tr', 'awk', 'cut', 'sort', 'env', 'bash', 'sh']) {
    const found = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).stdout.trim();
    symlinkSync(found, path.join(tools, command));
  }

  const pushed = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: a.clone, env: { ...commandEnv(a.h), PATH: tools }, encoding: 'utf8' });

  assert.notEqual(pushed.status, 0, pushed.stderr);
  assert.match(pushed.stderr, /blocked/);
  assert.equal(remoteHead(bare), before);
});

// ------------------------------------------------------------------------------------------------------------- conflict

test('when two machines change the same ledger, the second sync exits 1, names the file, keeps its commit, and the next session start says so', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  ledgerOk(a, 'store', 'sync');
  const b = machine(t, bare);
  answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });
  setUp(b);
  ledgerOk(a, 'task', 'park', 'fix-login', '--reason', 'parked on A');
  ledgerOk(a, 'store', 'sync');
  // A ledger names its repo by absolute path, so B works in a checkout at the same path, as on a machine with the same layout.
  ok(run(b, ['task', 'park', 'fix-login', '--reason', 'parked on B'], { cwd: a.app }));
  const local = git(b.h, b.clone, 'rev-parse', 'HEAD');

  const output = failed(run(b, ['store', 'sync']));

  assert.match(output, new RegExp(String.raw`backlog\/${APP_PATTERN}\/fix-login\.json`));
  assert.equal(git(b.h, b.clone, 'rev-parse', 'HEAD'), local);
  assert.match(readFileSync(path.join(b.clone, `backlog/${APP}/fix-login.json`), 'utf8'), /parked on B/);
  assert.equal(git(b.h, b.clone, 'status', '--porcelain'), '');
  for (const folder of ['rebase-merge', 'rebase-apply']) assert.equal(existsSync(path.join(b.clone, '.git', folder)), false, `${folder} is left`);
  assert.doesNotMatch(remoteText(bare, `backlog/${APP}/fix-login.json`), /parked on B/);
  assert.equal(JSON.parse(readFileSync(b.status, 'utf8')).problem, 'conflict');

  const context = hookContext(b);
  assert.match(context, /conflict/i);
  assert.match(context, /ledger store sync/);
});

// -------------------------------------------------------------------------------------------------------------- offline

test('offline, commands still work locally, a quiet sync prints nothing and records it, and the next good sync clears it', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  renameSync(bare, `${bare}.away`);

  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  git(a.h, a.clone, 'cat-file', '-e', `HEAD:backlog/${APP}/fix-login.json`);

  const quiet = run(a, ['store', 'sync', '--quiet']);
  assert.equal(quiet.stdout, '');
  assert.equal(quiet.stderr, '');
  assert.equal(JSON.parse(readFileSync(a.status, 'utf8')).problem, 'network');
  const manual = failed(run(a, ['store', 'sync']));
  assert.ok(manual.trim().split('\n').length <= 3, `a short reason:\n${manual}`);
  assert.match(hookContext(a), /ledger store sync/);

  renameSync(`${bare}.away`, bare);
  ledgerOk(a, 'store', 'sync');
  assert.equal(existsSync(a.status), false);
  assert.ok(remoteFiles(bare).includes(`backlog/${APP}/fix-login.json`));
  assert.doesNotMatch(hookContext(a), /ledger store sync/);
});

// -------------------------------------------------------------------------------------------------------------- migrate

/** A file-storage HOME with a backlog ledger and an archive copy with evidence. */
function withFileLedgers(m: Machine): string {
  ledgerOk(m, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  ledgerOk(m, 'task', 'new', 'old', '--goal', 'Old work.');
  ledgerOk(m, 'go', 'old');
  const evidence = path.join(m.app, '.claude/worktrees/old/.claude/evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  ledgerOk(m, 'task', 'retire', 'old', '--force');
  return `${today()}-old`;
}

test('migrate file → git → file moves the ledgers and evidence both ways; --from defaults to the setting', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  const name = withFileLedgers(a);
  ok(run(a, ['store', 'sync', 'init', URL]));
  const backlog = readFileSync(path.join(a.h, `.claude/ledger-backlog/${APP}/fix-login.json`), 'utf8');

  ledgerOk(a, 'store', 'migrate', '--to', 'git', '--remove-source');

  assert.equal(JSON.parse(readFileSync(path.join(a.h, '.claude/ledger-settings.json'), 'utf8')).storage, 'git');
  assert.equal(readFileSync(path.join(a.clone, `backlog/${APP}/fix-login.json`), 'utf8'), backlog);
  assert.equal(readFileSync(path.join(a.h, `.claude/ledger-evidence/${APP}`, name, 'red.txt'), 'utf8'), 'failing\n');
  assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');
  assert.ok(remoteFiles(bare).includes(`archive/${APP}/${name}.json`), 'migrate pushed');
  assert.ok(remoteFiles(bare).includes(`backlog/${APP}/fix-login.json`));
  assert.equal(existsSync(path.join(a.h, `.claude/ledger-backlog/${APP}/fix-login.json`)), false);
  assert.equal(ledgerOk(a, 'show', name, '--evidence'), 'red.txt\n');

  ledgerOk(a, 'store', 'migrate', '--to', 'file');

  assert.equal(JSON.parse(readFileSync(path.join(a.h, '.claude/ledger-settings.json'), 'utf8')).storage, 'file');
  assert.equal(readFileSync(path.join(a.h, `.claude/ledger-backlog/${APP}/fix-login.json`), 'utf8'), backlog);
  assert.equal(readFileSync(path.join(a.h, `.claude/ledger-archive/${APP}`, name, 'red.txt'), 'utf8'), 'failing\n');
  assert.ok(existsSync(path.join(a.clone, `backlog/${APP}/fix-login.json`)), 'the git storage keeps its copy');
});

test('migrate sqlite → git copies into the clone', { skip: noSqlite }, (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  writeFileSync(path.join(a.h, '.claude/ledger-settings.json'), JSON.stringify({ storage: 'sqlite' }));
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  ok(run(a, ['store', 'sync', 'init', URL]));

  ledgerOk(a, 'store', 'migrate', '--to', 'git');

  assert.match(readFileSync(path.join(a.clone, `backlog/${APP}/fix-login.json`), 'utf8'), /Users cannot log in\./);
  assert.ok(remoteFiles(bare).includes(`backlog/${APP}/fix-login.json`));
});

test('migrate --to git reports a failed push but still switches, as the copies are in the clone', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  ok(run(a, ['store', 'sync', 'init', URL]));
  renameSync(bare, `${bare}.away`);

  const stdout = ledgerOk(a, 'store', 'migrate', '--to', 'git');

  assert.match(stdout, /ledger store sync/);
  assert.equal(JSON.parse(readFileSync(path.join(a.h, '.claude/ledger-settings.json'), 'utf8')).storage, 'git');
  git(a.h, a.clone, 'cat-file', '-e', `HEAD:backlog/${APP}/fix-login.json`);
});

test('migrate refuses --from equal to --to, and --to git while the setting already is git without --from', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  assert.match(failed(run(a, ['store', 'migrate', '--from', 'file', '--to', 'file'])), /--from/);
  assert.match(failed(run(a, ['store', 'migrate', '--to', 'git'])), /--from/);
  ledgerOk(a, 'store', 'migrate', '--from', 'file', '--to', 'git', '--dry-run');
});

test('migrate --records --dry-run in git storage changes nothing: the changed hook stays, nothing is committed, no push starts', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  mkdirSync(path.join(a.clone, `backlog/${APP}`), { recursive: true });
  writeFileSync(path.join(a.clone, `backlog/${APP}/legacy.md`), '# Task ledger — legacy\n\n## Goal\nFrom before records.\n');
  git(a.h, a.clone, 'add', '-A');
  git(a.h, a.clone, 'commit', '--quiet', '--no-verify', '-m', 'a ledger from before records, not pushed');
  // Changed, so a store that opens to write would put the hook back.
  appendFileSync(hookFile(a), '# changed by hand\n');
  const hook = readFileSync(hookFile(a), 'utf8');
  const head = git(a.h, a.clone, 'rev-parse', 'HEAD');
  const pushed = remoteHead(bare);

  const out = ok(run(a, ['store', 'migrate', '--records', '--dry-run'], { env: machineEnv(a) }));

  assert.match(out, /^would convert backlog .+ legacy: /m);
  assert.equal(readFileSync(hookFile(a), 'utf8'), hook);
  assert.equal(git(a.h, a.clone, 'rev-parse', 'HEAD'), head);
  assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');
  assert.equal(existsSync(backgroundPids(a.h)), false, 'the dry run started a push');
  assert.equal(remoteHead(bare), pushed);
});

test('migrate --to git without a set-up clone says to run ledger store sync init and changes nothing', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  assert.match(failed(run(a, ['store', 'migrate', '--to', 'git'])), /ledger store sync init/);
  assert.equal(existsSync(path.join(a.h, '.claude/ledger-settings.json')), false);
});

// ----------------------------------------------------------------------------------------------------------------- help

test('ledger store --help lists sync, sync and migrate have their own help, and the old names fail', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  assert.match(ledgerOk(a, 'store', '--help'), /^\s+sync\b/m);
  for (const argv of [['sync'], ['sync', '--quiet'], ['sync', 'init', URL]]) {
    const ran = run(a, argv);
    assert.notEqual(ran.status, 0, `ledger ${argv.join(' ')}`);
    assert.match(ran.stderr, /unknown command/, `ledger ${argv.join(' ')}`);
  }
  const sync = ledgerOk(a, 'store', 'sync', '--help');
  assert.match(sync, /^Usage: ledger store sync\b/m);
  assert.match(sync, /--quiet/);
  assert.match(sync, /\binit\b/);
  assert.match(ledgerOk(a, 'store', 'sync', 'init', '--help'), /<url>/);
  assert.match(ledgerOk(a, 'store', 'migrate', '--help'), /--from <storage>/);
});

// ------------------------------------------------------------------------------------------------ remote code and hooks

test('ledger store sync puts back a pre-push hook that was changed, and replaces a core.hooksPath an older setup left', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const own = readFileSync(hookFile(a), 'utf8');
  writeFileSync(hookFile(a), '#!/bin/sh\nexit 0\n');
  git(a.h, a.clone, 'config', 'core.hooksPath', '.githooks');

  ledgerOk(a, 'store', 'sync');

  assert.equal(readFileSync(hookFile(a), 'utf8'), own);
  assertOwnHook(a);
});

const BAD_ENTRIES: [string, (other: string) => void][] = [
  ['backlog/app/link.md', (other) => symlinkSync('/etc/hosts', path.join(other, 'backlog/app/link.md'))],
  ['backlog/app/run.md', (other) => (writeFileSync(path.join(other, 'backlog/app/run.md'), '# run\n'), chmodSync(path.join(other, 'backlog/app/run.md'), 0o755))],
  ['notes.txt', (other) => writeFileSync(path.join(other, 'notes.txt'), 'not a ledger\n')],
];

for (const [file, add] of BAD_ENTRIES) {
  test(`a pull refuses an incoming ${file}: ledger store sync and the session start leave the clone as it was, and the problem is recorded`, (t) => {
    const bare = remote(t);
    const a = machine(t, bare);
    setUp(a);
    ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
    ledgerOk(a, 'store', 'sync');
    const other = plainClone(a);
    mkdirSync(path.join(other, 'backlog/app'), { recursive: true });
    add(other);
    git(a.h, other, 'add', '-f', '-A');
    pushFrom(a, other, `add ${file}`);
    const remoteNow = remoteHead(bare);
    ledgerOk(a, 'task', 'new', 'mine', '--goal', 'Made here.');
    const local = git(a.h, a.clone, 'rev-parse', 'HEAD');

    assert.ok(failed(run(a, ['store', 'sync'])).includes(file));
    // Removed, so the session start must find the problem itself rather than show the one ledger store sync recorded.
    rmSync(a.status);
    assert.match(hookContext(a), /ledger store sync/);

    assert.equal(git(a.h, a.clone, 'rev-parse', 'HEAD'), local);
    assert.equal(lstatSync(path.join(a.clone, file), { throwIfNoEntry: false }), undefined, `${file} is checked out`);
    assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');
    assert.equal(JSON.parse(readFileSync(a.status, 'utf8')).problem, 'incoming');
    assert.equal(remoteHead(bare), remoteNow);
  });
}

// ---------------------------------------------------------------------------------------------------- privacy and URLs

test('sync init accepts only a plain github.com URL: no query, fragment, port, path past the repository or other user', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  const secret = 'query-secret-not-for-print';
  for (const url of [
    `https://github.com/me/ledgers.git?access_token=${secret}`,
    `https://github.com/me/ledgers.git#${secret}`,
    'https://github.com:8443/me/ledgers.git',
    'https://github.com/me/ledgers.git/extra',
    'https://github.com/me/../you/ledgers.git',
    'https://a@b@github.com/me/ledgers.git',
    'ssh://root@github.com/me/ledgers.git',
    'ssh://git@github.com:2222/me/ledgers.git',
    'root@github.com:me/ledgers.git',
    'https://github.com.example.com/me/ledgers.git',
    'https://example.com/github.com/me/ledgers.git',
  ]) {
    const output = failed(run(a, ['store', 'sync', 'init', url]));
    assert.match(output, /github\.com/, url);
    assert.ok(!output.includes(secret), `${url} printed its query or fragment`);
  }
  assert.equal(existsSync(path.join(a.h, 'gh-calls')), false);
  assert.equal(existsSync(a.clone), false);
});

/** A second bare repository that a push must never reach. */
function elsewhere(m: Machine): string {
  const evil = path.join(m.h, 'elsewhere.git');
  git(m.h, m.h, 'init', '--quiet', '--bare', '-b', 'main', evil);
  return evil;
}

test('ledger store sync pushes to the URL it checked: a pushurl on origin is not used', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const evil = elsewhere(a);
  git(a.h, a.clone, 'config', 'remote.origin.pushurl', evil);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');

  ledgerOk(a, 'store', 'sync');

  assert.ok(remoteFiles(bare).includes(`backlog/${APP}/fix-login.json`));
  assert.equal(remoteHead(evil), '');
});

test('ledger store sync refuses when git config would send the push of the checked URL somewhere else', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const evil = elsewhere(a);
  const gitconfig = path.join(a.h, '.gitconfig');
  writeFileSync(gitconfig, `${readFileSync(gitconfig, 'utf8')}[url "${evil}"]\n\tpushInsteadOf = ${URL}\n`);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  const before = remoteHead(bare);

  assert.match(failed(run(a, ['store', 'sync'])), /insteadOf/);

  assert.equal(remoteHead(evil), '');
  assert.equal(remoteHead(bare), before);
  assert.equal(JSON.parse(readFileSync(a.status, 'utf8')).problem, 'private');
});

test('ledger store sync asks gh whether the repository is still private each time, a background sync at most once a day, and a public one gets nothing', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const calls = (): number => readFileSync(path.join(a.h, 'gh-calls'), 'utf8').trim().split('\n').length;
  ledgerOk(a, 'task', 'new', 'first', '--goal', 'First.');
  const atInit = calls();

  ledgerOk(a, 'store', 'sync');
  assert.equal(calls(), atInit + 1, 'a manual sync asks gh');
  ledgerOk(a, 'task', 'new', 'second', '--goal', 'Second.');
  ok(run(a, ['store', 'sync', '--quiet']));
  assert.equal(calls(), atInit + 1, 'a background sync on the same day does not ask again');
  assert.ok(remoteFiles(bare).includes(`backlog/${APP}/second.json`));

  answerGh(a.h, { visibility: 'PUBLIC', isEmpty: false });
  ledgerOk(a, 'task', 'new', 'third', '--goal', 'Third.');
  const before = remoteHead(bare);
  assert.match(failed(run(a, ['store', 'sync'])), /PUBLIC/);
  assert.equal(JSON.parse(readFileSync(a.status, 'utf8')).problem, 'private');
  const quiet = run(a, ['store', 'sync', '--quiet']);
  assert.equal(quiet.status, 1);
  assert.equal(calls(), atInit + 3, 'after a public answer, a background sync asks again');
  assert.equal(remoteHead(bare), before);
});

// ------------------------------------------------------------------------------------------------------------- paths

test('git storage refuses to write through a repo folder that is a symbolic link, in backlog/ and in archive/', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const outside = path.join(a.h, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, path.join(a.clone, `backlog/${APP}`));

  const ran = run(a, ['task', 'new', 'fix-login', '--goal', 'Users cannot log in.']);

  assert.equal(ran.status, 1, ran.stdout);
  assert.match(ran.stderr, new RegExp(String.raw`backlog\/${APP_PATTERN}.*symbolic link`));
  assert.deepEqual(readdirSync(outside), []);

  rmSync(path.join(a.clone, `backlog/${APP}`));
  ledgerOk(a, 'task', 'new', 'idea', '--goal', 'An idea.');
  const outsideArchive = path.join(a.h, 'outside-archive');
  mkdirSync(outsideArchive);
  symlinkSync(outsideArchive, path.join(a.clone, `archive/${APP}`));

  assert.equal(run(a, ['task', 'retire', 'idea']).status, 1);
  assert.deepEqual(readdirSync(outsideArchive), []);
  assert.ok(existsSync(path.join(a.clone, `backlog/${APP}/idea.json`)));
});

test('a staged path whose name ends in a line break is checked as it is, and refused', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const name = `backlog/${APP}/odd.md\n`;
  mkdirSync(path.join(a.clone, `backlog/${APP}`), { recursive: true });
  writeFileSync(path.join(a.clone, name), 'odd\n');
  git(a.h, a.clone, 'add', '-f', '--', name);
  const before = remoteHead(bare);

  failed(run(a, ['store', 'sync']));

  assert.equal(remoteHead(bare), before);
  assert.equal(JSON.parse(readFileSync(a.status, 'utf8')).problem, 'allowlist');
});

test('a path with a secret-like name is withheld in the output, the status file and the session context', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const name = `notes-${GITHUB_TOKEN}.txt`;
  writeFileSync(path.join(a.clone, name), 'notes\n');
  git(a.h, a.clone, 'add', '-f', '--', name);

  const output = failed(run(a, ['store', 'sync']));

  assert.match(output, /<file name withheld>/);
  for (const [where, text] of [['output', output], ['status file', readFileSync(a.status, 'utf8')], ['session context', hookContext(a)]]) {
    assert.ok(!text.includes(GITHUB_TOKEN), `the ${where} names the file`);
  }
});

// --------------------------------------------------------------------------------------------------------- scan range

test('ledger store sync and the pre-push hook scan from the remote branch, so a commit another remote-tracking ref holds is scanned too', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const before = remoteHead(bare);
  ledgerOk(a, 'task', 'new', 'leak', '--goal', `Use ${GITHUB_TOKEN} to log in.`);
  git(a.h, a.clone, 'update-ref', 'refs/remotes/origin/side', 'HEAD');

  const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');
  assert.notEqual(pushed.status, 0, 'the pre-push hook let it through');
  assert.match(pushed.stderr, new RegExp(String.raw`backlog\/${APP_PATTERN}\/leak\.json:\d+`));
  git(a.h, a.clone, 'update-ref', 'refs/remotes/origin/side', 'HEAD');
  assert.match(failed(run(a, ['store', 'sync'])), new RegExp(String.raw`backlog\/${APP_PATTERN}\/leak\.json:\d+`));
  assert.equal(remoteHead(bare), before);
});

test('a secret in a commit message blocks ledger store sync and the pre-push hook, which name the commit and not the secret', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const before = remoteHead(bare);
  mkdirSync(path.join(a.clone, `backlog/${APP}`), { recursive: true });
  writeFileSync(path.join(a.clone, `backlog/${APP}/clean.md`), '# clean\n');
  git(a.h, a.clone, 'add', '-A');
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'Clean ledger', '-m', `token ${GITHUB_TOKEN}`);
  const where = `message of commit ${git(a.h, a.clone, 'rev-parse', 'HEAD').slice(0, 12)}, line 3`;

  const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');
  const synced = run(a, ['store', 'sync']);

  for (const [who, ran] of [['git push', pushed], ['ledger store sync', synced]] as const) {
    assert.notEqual(ran.status, 0, `${who} was not blocked`);
    assert.ok(`${ran.stdout}${ran.stderr}`.includes(where), `${who} does not name ${where}:\n${ran.stderr}`);
    assert.ok(!`${ran.stdout}${ran.stderr}`.includes(GITHUB_TOKEN), `${who} printed the secret`);
  }
  assert.equal(remoteHead(bare), before);
});

// -------------------------------------------------------------------------------------------------------------- init

test('sync init counts a repository with only a branch other than the default as not empty, and refuses it', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  const other = plainClone(a);
  writeFileSync(path.join(other, 'README.md'), '# something else\n');
  git(a.h, other, 'add', '-A');
  git(a.h, other, 'commit', '--quiet', '-m', 'unrelated');
  git(a.h, other, 'push', '--quiet', 'origin', 'HEAD:refs/heads/other');
  answerGh(a.h, { visibility: 'PRIVATE', isEmpty: false });

  assert.match(failed(run(a, ['store', 'sync', 'init', URL])), /\.ledger-data/);

  assert.equal(remoteHead(bare), '', 'init pushed a main branch');
  assert.equal(existsSync(a.clone), false);
});

test('two sync inits at once: the second refuses at once and asks gh nothing, and the clone of the first stays', async (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  writeFileSync(path.join(a.h, 'gh-delay'), '2');
  const first = started(a, ['store', 'sync', 'init', URL]);
  await until(() => existsSync(path.join(a.h, 'gh-calls')), 'the first gh call');

  const [second, ms] = timed(() => run(a, ['store', 'sync', 'init', URL]));

  assert.equal(second.status, 1, second.stdout);
  assert.match(second.stderr, /another ledger store sync init/);
  assert.ok(ms < 1500, `the second init waited ${ms} ms`);
  assert.equal(readFileSync(path.join(a.h, 'gh-calls'), 'utf8').trim().split('\n').length, 1);
  const done = await first;
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(a.clone, '.ledger-data'), 'utf8')), { format: 1 });
  assert.equal(git(a.h, a.clone, 'rev-parse', 'HEAD'), remoteHead(bare));
});

// -------------------------------------------------------------------------------------------------------- clone state

test('a stash that left a conflict stops the commit of every command and of ledger store sync, and is recorded', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  const file = path.join(a.clone, `backlog/${APP}/fix-login.json`);
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, original.replace('Users cannot log in.', 'Stashed goal.'));
  git(a.h, a.clone, 'stash', '--quiet');
  writeFileSync(file, original.replace('Users cannot log in.', 'Committed goal.'));
  git(a.h, a.clone, 'commit', '--quiet', '-am', 'by hand');
  assert.notEqual(gitRan(a.h, a.clone, 'stash', 'pop').status, 0, 'the stash conflicts');
  assert.equal(existsSync(path.join(a.clone, '.git/MERGE_HEAD')), false);
  const head = git(a.h, a.clone, 'rev-parse', 'HEAD');

  const ran = run(a, ['task', 'new', 'second', '--goal', 'More.']);

  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stderr, /not committed/);
  assert.equal(git(a.h, a.clone, 'rev-parse', 'HEAD'), head);
  assert.notEqual(git(a.h, a.clone, 'ls-files', '-u'), '', 'the conflict was marked as resolved');
  assert.equal(JSON.parse(readFileSync(a.status, 'utf8')).problem, 'conflict');
  assert.match(failed(run(a, ['store', 'sync'])), new RegExp(String.raw`backlog\/${APP_PATTERN}\/fix-login\.json`));
  assert.equal(git(a.h, a.clone, 'rev-parse', 'HEAD'), head);
});

test('during a rebase a person has not finished, ledger store sync refuses, pushes nothing and leaves the rebase as it is', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  ledgerOk(a, 'store', 'sync');
  const b = machine(t, bare);
  answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });
  setUp(b);
  ledgerOk(a, 'task', 'park', 'fix-login', '--reason', 'parked on A');
  ledgerOk(a, 'store', 'sync');
  ok(run(b, ['task', 'park', 'fix-login', '--reason', 'parked on B'], { cwd: a.app }));
  git(b.h, b.clone, 'fetch', '--quiet', 'origin');
  assert.notEqual(gitRan(b.h, b.clone, 'rebase', 'origin/main').status, 0, 'the rebase stops');

  assert.match(failed(run(b, ['store', 'sync'])), /rebase/);

  assert.ok(existsSync(path.join(b.clone, '.git/rebase-merge')), 'the rebase was aborted');
  assert.doesNotMatch(remoteText(bare, `backlog/${APP}/fix-login.json`), /parked on B/);
});

// --------------------------------------------------------------------------------------------------------------- locks

test('the clone lock of a process that still runs is kept, also after a minute', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const lock = path.join(a.h, '.claude/ledger-data.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, since: new Date(Date.now() - 2 * 60_000).toISOString() }));

  const ran = run(a, ['task', 'new', 'fix-login', '--goal', 'Users cannot log in.']);

  assert.equal(ran.status, 1, ran.stdout);
  assert.ok(ran.stderr.includes(lock), ran.stderr);
  assert.equal(existsSync(path.join(a.clone, `backlog/${APP}/fix-login.json`)), false);
});

test('a background sync that gives up waiting for the clone lock prints nothing and records why', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  writeFileSync(path.join(a.h, '.claude/ledger-data.lock'), JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));

  const quiet = run(a, ['store', 'sync', '--quiet']);

  assert.equal(quiet.status, 1);
  assert.equal(`${quiet.stdout}${quiet.stderr}`, '');
  assert.match(JSON.parse(readFileSync(a.status, 'utf8')).message, /ledger-data\.lock/);
});

test('a background sync that starts while another runs exits at once, and the running one pushes the newer commit too', async (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'first', '--goal', 'First.');
  remoteHook(bare, 'pre-receive', ['touch receiving', 'sleep 2']);
  const first = started(a, ['store', 'sync', '--quiet']);
  await until(() => existsSync(path.join(bare, 'receiving')), 'the first push');
  ledgerOk(a, 'task', 'new', 'second', '--goal', 'Second.');

  const [second, ms] = timed(() => run(a, ['store', 'sync', '--quiet']));

  assert.equal(second.status, 0, second.stderr);
  assert.equal(`${second.stdout}${second.stderr}`, '');
  assert.ok(ms < 1500, `the second sync took ${ms} ms`);
  const done = await first;
  assert.equal(done.status, 0, done.stderr);
  for (const file of [`backlog/${APP}/first.json`, `backlog/${APP}/second.json`]) assert.ok(remoteFiles(bare).includes(file), file);
});

test('a sync that started earlier neither clears nor replaces the problem a later sync recorded', (t) => {
  const paths = ledgerPaths(home(t));
  recordProblem(paths, new SyncProblem('conflict', 'newer'), 200);
  clearStatus(paths, 100);
  assert.equal(readStatus(paths)?.message, 'newer');
  recordProblem(paths, new SyncProblem('network', 'older'), 150);
  assert.equal(readStatus(paths)?.message, 'newer');
  clearStatus(paths, 300);
  assert.equal(readStatus(paths), undefined);
});

// ------------------------------------------------------------------------------------------------------ session start

test('the session-start pull stops within its time limit and leaves no half rebase', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'first', '--goal', 'First.');
  ledgerOk(a, 'store', 'sync');
  const b = machine(t, bare);
  answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });
  setUp(b);
  ledgerOk(a, 'task', 'new', 'later', '--goal', 'Comes later.');
  ledgerOk(a, 'store', 'sync');
  ledgerOk(b, 'task', 'new', 'mine', '--goal', 'Made on B.');
  const local = git(b.h, b.clone, 'rev-parse', 'HEAD');
  // git rebase runs post-rewrite before it removes its state, so a rebase stopped here is half done.
  const slow = path.resolve(b.clone, git(b.h, b.clone, 'rev-parse', '--git-path', 'hooks/post-rewrite'));
  const rewriting = path.join(b.h, 'rewriting');
  mkdirSync(path.dirname(slow), { recursive: true });
  writeFileSync(slow, `#!/bin/sh\nexec >/dev/null 2>&1 </dev/null\ntouch '${rewriting}'\nsleep 30\n`);
  chmodSync(slow, 0o755);
  // A session start with nothing to rebase, so the difference is the time the pull spends on the rebase.
  const [, baseline] = timed(() => hookContext(a));

  const [, ms] = timed(() => hookContext(b));

  assert.ok(existsSync(rewriting), 'the session start did not rebase');
  assert.ok(ms < 15_000, `the session start took ${ms} ms`);
  assert.ok(ms - baseline < 4250, `the pull took ${ms - baseline} ms of the 5 s the whole session start has`);
  for (const folder of ['rebase-merge', 'rebase-apply']) assert.equal(existsSync(path.join(b.clone, '.git', folder)), false, `${folder} is left`);
  assert.equal(git(b.h, b.clone, 'rev-parse', 'HEAD'), local);
  assert.equal(git(b.h, b.clone, 'status', '--porcelain'), '');
});

// ----------------------------------------------------------------------------------------------- races and push retry

test('a ledger command that runs while a sync pushes is not held up, and the next sync pushes it', async (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'first', '--goal', 'First.');
  remoteHook(bare, 'pre-receive', ['touch receiving', 'sleep 2']);
  const syncing = started(a, ['store', 'sync']);
  await until(() => existsSync(path.join(bare, 'receiving')), 'the push');

  const [ran, ms] = timed(() => run(a, ['task', 'new', 'second', '--goal', 'Second.']));

  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(ms < 1500, `the command waited ${ms} ms`);
  const synced = await syncing;
  assert.equal(synced.status, 0, synced.stderr);
  ledgerOk(a, 'store', 'sync');
  for (const file of [`backlog/${APP}/first.json`, `backlog/${APP}/second.json`]) assert.ok(remoteFiles(bare).includes(file), file);
  assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');
});

test('when the remote moves between the fetch and the push, ledger store sync pulls again and pushes', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'first', '--goal', 'First.');
  ledgerOk(a, 'store', 'sync');
  const other = plainClone(a);
  writeFileSync(path.join(other, `backlog/${APP}/other.md`), '# other\n');
  git(a.h, other, 'add', '-f', `backlog/${APP}/other.md`);
  git(a.h, other, 'commit', '--quiet', '-m', 'other');
  remoteHook(bare, 'pre-receive', [
    'if [ ! -f moved ]; then',
    '  touch moved',
    `  env -u GIT_DIR -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES git -C '${other}' push --quiet --no-verify origin HEAD:main`,
    '  exit 1',
    'fi',
  ]);
  ledgerOk(a, 'task', 'new', 'mine', '--goal', 'Made here.');

  assert.match(ledgerOk(a, 'store', 'sync'), /Pushed/);

  for (const file of [`backlog/${APP}/other.md`, `backlog/${APP}/mine.json`]) assert.ok(remoteFiles(bare).includes(file), file);
  assert.equal(remoteHead(bare), git(a.h, a.clone, 'rev-parse', 'HEAD'));
});

// --------------------------------------------------------------------------------------------------- migrate and git

test('migrate file → git --remove-source keeps every registry entry, in the registry of git storage', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  ledgerOk(a, 'task', 'new', 'active', '--goal', 'Under way.');
  ledgerOk(a, 'go', 'active');
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  ok(run(a, ['store', 'sync', 'init', URL]));

  ledgerOk(a, 'store', 'migrate', '--to', 'git', '--remove-source');

  const entries = JSON.parse(readFileSync(path.join(a.h, '.claude/ledgers-git.json'), 'utf8')) as { slug: string; status: string }[];
  assert.ok(entries.some(({ slug, status }) => slug === 'active' && status === 'active'), JSON.stringify(entries));
  assert.ok(entries.some(({ slug }) => slug === 'fix-login'), JSON.stringify(entries));
});

test('migrate --to git --remove-source stops before it removes or switches anything when git storage cannot commit', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  ok(run(a, ['store', 'sync', 'init', URL]));
  writeFileSync(path.join(a.clone, 'notes.txt'), 'private\n');
  git(a.h, a.clone, 'add', '-f', 'notes.txt');

  assert.match(failed(run(a, ['store', 'migrate', '--to', 'git', '--remove-source'])), /notes\.txt/);

  assert.ok(existsSync(path.join(a.h, `.claude/ledger-backlog/${APP}/fix-login.json`)), 'the source was removed');
  assert.equal(existsSync(path.join(a.h, '.claude/ledger-settings.json')), false);
  assert.equal(existsSync(path.join(a.clone, `backlog/${APP}/fix-login.json`)), false, 'the copy stays in the clone');
});

// -------------------------------------------------------------------------------------------------------- names as paths

test('a ledger or repo named . or .. is outside the allowlist: a staged archive/app/...md stops the sync', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const before = remoteHead(bare);
  for (const file of ['archive/app/...md', 'backlog/app/..md']) {
    mkdirSync(path.dirname(path.join(a.clone, file)), { recursive: true });
    writeFileSync(path.join(a.clone, file), '# dots\n');
  }
  git(a.h, a.clone, 'add', '-f', '--', 'archive/app/...md', 'backlog/app/..md');

  const output = failed(run(a, ['store', 'sync']));

  assert.ok(output.includes('archive/app/...md'), output);
  assert.equal(remoteHead(bare), before);
  assert.equal(JSON.parse(readFileSync(a.status, 'utf8')).problem, 'allowlist');
});

test('migrate --remove-source removes no more than one copy and its evidence: a file named ...md in the archive is no ledger', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  const archive = path.join(a.h, '.claude/ledger-archive');
  mkdirSync(path.join(archive, 'app'), { recursive: true });
  writeFileSync(path.join(archive, 'app/...md'), '# dots\n');
  writeFileSync(path.join(archive, 'keep.txt'), 'not a ledger\n');
  ok(run(a, ['store', 'sync', 'init', URL]));

  run(a, ['store', 'migrate', '--to', 'git', '--remove-source']);

  assert.equal(readFileSync(path.join(archive, 'keep.txt'), 'utf8'), 'not a ledger\n');
  assert.ok(existsSync(path.join(archive, 'app/...md')));
  assert.equal(existsSync(path.join(a.clone, 'archive/app/...md')), false);
});

// ------------------------------------------------------------------------------------------------------ ignored ledgers

test('a .gitignore from the remote that ignores ledgers keeps none out of the commit or the push', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const other = plainClone(a);
  appendFileSync(path.join(other, '.gitignore'), '/backlog/*/*.md\n/backlog/*/*.json\n');
  pushFrom(a, other, 'ignore the ledgers');
  ledgerOk(a, 'store', 'sync');

  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');

  git(a.h, a.clone, 'cat-file', '-e', `HEAD:backlog/${APP}/fix-login.json`);
  ledgerOk(a, 'store', 'sync');
  assert.ok(remoteFiles(bare).includes(`backlog/${APP}/fix-login.json`));
});

test('migrate --to git --remove-source commits every copy before it removes anything, also one an exclude file ignores', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  ok(run(a, ['store', 'sync', 'init', URL]));
  writeFileSync(path.join(a.clone, '.git/info/exclude'), 'backlog/\n');
  const source = path.join(a.h, `.claude/ledger-backlog/${APP}/fix-login.json`);
  const commits = path.join(a.h, 'commits');
  // git runs post-commit also for a commit with --no-verify; it notes whether the source was still there.
  const hook = path.join(a.clone, '.git/hooks/post-commit');
  writeFileSync(hook, `#!/bin/sh\nif [ -f '${source}' ]; then echo source; else echo removed; fi >> '${commits}'\n`);
  chmodSync(hook, 0o755);

  ledgerOk(a, 'store', 'migrate', '--to', 'git', '--remove-source');

  assert.equal(readFileSync(commits, 'utf8').split('\n')[0], 'source', 'the first commit came after the source was removed');
  assert.equal(existsSync(source), false);
  git(a.h, a.clone, 'cat-file', '-e', `HEAD:backlog/${APP}/fix-login.json`);
  assert.ok(remoteFiles(bare).includes(`backlog/${APP}/fix-login.json`));
});

// ------------------------------------------------------------------------------------------------------ incoming commits

test('ledger store sync pushes against the commit it fetched, even when the remote-tracking branch moves while it rebases', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'first', '--goal', 'First.');
  ledgerOk(a, 'store', 'sync');
  const b = machine(t, bare);
  answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });
  setUp(b);
  ledgerOk(a, 'task', 'new', 'later', '--goal', 'Comes later.');
  ledgerOk(a, 'store', 'sync');
  ledgerOk(b, 'task', 'new', 'mine', '--goal', 'Made on B.');
  // Stands in for another process that fetches while this sync rebases.
  const hook = path.join(b.clone, '.git/hooks/post-rewrite');
  writeFileSync(hook, '#!/bin/sh\ngit update-ref refs/remotes/origin/main HEAD\n');
  chmodSync(hook, 0o755);

  ledgerOk(b, 'store', 'sync');

  assert.ok(remoteFiles(bare).includes(`backlog/${APP}/mine.json`));
  assert.equal(remoteHead(bare), git(b.h, b.clone, 'rev-parse', 'HEAD'));
});

test('a pull refuses incoming history that held a path ledger never checks out, also when a later commit removed it', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  ledgerOk(a, 'store', 'sync');
  const other = plainClone(a);
  writeFileSync(path.join(other, 'notes.txt'), 'not a ledger\n');
  git(a.h, other, 'add', '-f', 'notes.txt');
  git(a.h, other, 'commit', '--quiet', '-m', 'add notes');
  git(a.h, other, 'rm', '--quiet', 'notes.txt');
  pushFrom(a, other, 'remove notes');
  const remoteNow = remoteHead(bare);
  ledgerOk(a, 'task', 'new', 'mine', '--goal', 'Made here.');
  const local = git(a.h, a.clone, 'rev-parse', 'HEAD');

  assert.match(failed(run(a, ['store', 'sync'])), /notes\.txt/);

  assert.equal(git(a.h, a.clone, 'rev-parse', 'HEAD'), local);
  assert.equal(JSON.parse(readFileSync(a.status, 'utf8')).problem, 'incoming');
  assert.equal(remoteHead(bare), remoteNow);
  rmSync(a.status);
  hookContext(a);
  assert.equal(JSON.parse(readFileSync(a.status, 'utf8')).problem, 'incoming');
  assert.equal(git(a.h, a.clone, 'rev-parse', 'HEAD'), local);
});

test('sync init refuses a repository whose history held a symbolic link, though its last commit holds none', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const other = plainClone(a);
  mkdirSync(path.join(other, `backlog/${APP}`), { recursive: true });
  symlinkSync('/etc/hosts', path.join(other, `backlog/${APP}/link.md`));
  git(a.h, other, 'add', '-f', `backlog/${APP}/link.md`);
  git(a.h, other, 'commit', '--quiet', '-m', 'add a link');
  git(a.h, other, 'rm', '--quiet', `backlog/${APP}/link.md`);
  pushFrom(a, other, 'remove the link');
  const b = machine(t, bare);
  answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });

  assert.match(failed(run(b, ['store', 'sync', 'init', URL])), new RegExp(String.raw`backlog\/${APP_PATTERN}\/link\.md`));

  assert.equal(existsSync(b.clone), false);
});

// -------------------------------------------------------------------------------------------------------- test remote

test('no environment variable lets a URL rewrite send the checked URL to a local repository', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  const before = remoteHead(bare);
  const env = { ...commandEnv(a.h), LEDGER_TEST_REMOTE: a.bare, LEDGER_TEST_NO_BACKGROUND_SYNC: '1' };

  assert.match(failed(run(a, ['store', 'sync'], { env })), /insteadOf/);

  assert.equal(remoteHead(bare), before);
});

// --------------------------------------------------------------------------------------------------------- manual push

test('a manual git push in the clone runs the pre-push hook of ledger, also when the global git config sets core.hooksPath', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  const globalHooks = path.join(a.h, 'global-hooks');
  mkdirSync(globalHooks);
  appendFileSync(path.join(a.h, '.gitconfig'), `[core]\n\thooksPath = ${globalHooks}\n`);
  setUp(a);
  const before = remoteHead(bare);
  ledgerOk(a, 'task', 'new', 'leak', '--goal', `Use ${GITHUB_TOKEN} to log in.`);

  const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');

  assert.notEqual(pushed.status, 0, 'the push went through without the scan');
  assert.match(pushed.stderr, new RegExp(String.raw`backlog\/${APP_PATTERN}\/leak\.json:\d+`));
  assert.equal(remoteHead(bare), before);
  assertOwnHook(a);
});

// -------------------------------------------------------------------------------------------------------- scan options

test('a secret in a root commit is found by ledger store sync and the pre-push hook, also when git config hides root commits from git log', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  appendFileSync(path.join(a.h, '.gitconfig'), '[log]\n\tshowRoot = false\n');
  setUp(a);
  const before = remoteHead(bare);
  git(a.h, a.clone, 'checkout', '--quiet', '--orphan', 'side');
  git(a.h, a.clone, 'rm', '-r', '-f', '--quiet', '.');
  mkdirSync(path.join(a.clone, `backlog/${APP}`), { recursive: true });
  writeFileSync(path.join(a.clone, `backlog/${APP}/leak.md`), `Use ${GITHUB_TOKEN} to log in.\n`);
  git(a.h, a.clone, 'add', '-f', `backlog/${APP}/leak.md`);
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'root');
  git(a.h, a.clone, 'rm', '--quiet', `backlog/${APP}/leak.md`);
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'gone again');
  git(a.h, a.clone, 'checkout', '--quiet', 'main');
  git(a.h, a.clone, 'merge', '--quiet', '--allow-unrelated-histories', '--no-edit', 'side');

  const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');
  const synced = run(a, ['store', 'sync']);

  for (const [who, ran] of [['git push', pushed], ['ledger store sync', synced]] as const) {
    assert.notEqual(ran.status, 0, `${who} was not blocked`);
    assert.ok(`${ran.stdout}${ran.stderr}`.includes(`backlog/${APP}/leak.md:1`), `${who} does not name backlog/${APP}/leak.md:1`);
    assert.ok(!`${ran.stdout}${ran.stderr}`.includes(GITHUB_TOKEN), `${who} printed the secret`);
  }
  assert.equal(remoteHead(bare), before);
});

test('no tag is pushed: ledger store sync leaves tags out under push.followTags, and the pre-push hook blocks a push of one', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  appendFileSync(path.join(a.h, '.gitconfig'), '[push]\n\tfollowTags = true\n');
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  git(a.h, a.clone, 'tag', '-a', 'v1', '-m', `token ${GITHUB_TOKEN}`);
  const tags = (): string => gitRan(path.dirname(bare), bare, 'tag', '--list').stdout;

  ledgerOk(a, 'store', 'sync');
  assert.equal(tags(), '');

  const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'refs/tags/v1');
  assert.notEqual(pushed.status, 0, 'the tag was pushed');
  assert.match(pushed.stderr, /blocked/);
  assert.ok(!pushed.stderr.includes(GITHUB_TOKEN), 'the hook printed the secret');
  assert.equal(tags(), '');
});

// ------------------------------------------------------------------------------------------------------- modes and types

test('a symbolic link or an executable file at a ledger path is never committed or pushed', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  ledgerOk(a, 'store', 'sync');
  const before = remoteHead(bare);
  const link = path.join(a.clone, `backlog/${APP}/link.md`);
  symlinkSync('/etc/hosts', link);

  assert.match(failed(run(a, ['store', 'sync'])), new RegExp(String.raw`backlog\/${APP_PATTERN}\/link\.md`));
  assert.equal(JSON.parse(readFileSync(a.status, 'utf8')).problem, 'allowlist');
  assert.equal(remoteHead(bare), before);

  rmSync(link);
  const executable = path.join(a.clone, `backlog/${APP}/run.md`);
  writeFileSync(executable, '# run\n');
  chmodSync(executable, 0o755);
  git(a.h, a.clone, 'add', `backlog/${APP}/run.md`);
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'by hand');

  assert.match(failed(run(a, ['store', 'sync'])), new RegExp(String.raw`backlog\/${APP_PATTERN}\/run\.md`));
  assert.equal(JSON.parse(readFileSync(a.status, 'utf8')).problem, 'allowlist');
  assert.equal(remoteHead(bare), before);
});

// ------------------------------------------------------------------------------------------------------------ redaction

test('git error text is printed and recorded without secret-like words or credentials', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  remoteHook(bare, 'pre-receive', [`echo "refused backlog/${APP}/${GITHUB_TOKEN}.md from https://me:${PASSWORD}@example.com/x" >&2`, 'exit 1']);

  const output = failed(run(a, ['store', 'sync']));

  assert.match(output, /refused/);
  for (const [where, text] of [['output', output], ['status file', readFileSync(a.status, 'utf8')]]) {
    assert.ok(!text.includes(GITHUB_TOKEN), `the ${where} holds the secret-like word`);
    assert.ok(!text.includes(PASSWORD), `the ${where} holds the password`);
  }
});

test('migrate withholds a secret-like name when it names a name the target already has', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  const file = `backlog/${APP}/notes-${GITHUB_TOKEN}.md`;
  mkdirSync(path.join(a.h, `.claude/ledger-backlog/${APP}`), { recursive: true });
  writeFileSync(path.join(a.h, `.claude/ledger-${file}`), '# notes\n');
  ok(run(a, ['store', 'sync', 'init', URL]));
  mkdirSync(path.join(a.clone, `backlog/${APP}`), { recursive: true });
  writeFileSync(path.join(a.clone, file), '# notes\n');

  const output = failed(run(a, ['store', 'migrate', '--to', 'git']));

  assert.ok(!output.includes(GITHUB_TOKEN), 'migrate printed the secret-like name');
  assert.match(output, /already has 1 name/);
  assert.match(output, /<file name withheld>/);
});

// ------------------------------------------------------------------------------------------------- session-start budget

test('when the session-start pull cannot undo a rebase that stopped, it records that and says to run git rebase --abort', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'first', '--goal', 'First.');
  ledgerOk(a, 'store', 'sync');
  const b = machine(t, bare);
  answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });
  setUp(b);
  ledgerOk(a, 'task', 'new', 'later', '--goal', 'Comes later.');
  ledgerOk(a, 'store', 'sync');
  ledgerOk(b, 'task', 'new', 'mine', '--goal', 'Made on B.');
  // The lock stops the rebase after its first checkout, and then stops git rebase --abort too.
  const hook = path.join(b.clone, '.git/hooks/post-checkout');
  writeFileSync(hook, '#!/bin/sh\ntouch "$(git rev-parse --git-dir)/index.lock"\n');
  chmodSync(hook, 0o755);

  assert.match(hookContext(b), /ledger store sync/);

  const status = JSON.parse(readFileSync(b.status, 'utf8')) as { problem: string; message: string };
  assert.equal(status.problem, 'conflict');
  assert.match(status.message, /git rebase --abort/);
});

// ------------------------------------------------------------------------------------------------------- locks and status

/**
 * A process that takes the lock of `<target>-<round>` once per round, each round at the same moment as the others. It
 * prints how often it found another process inside the lock with it, or its lock moved or taken while it held it.
 */
const LOCK_CONTENDER = `
import { register } from 'tsx/esm/api';
register();
const { mkdirSync, readFileSync, rmdirSync } = await import('node:fs');
const { withLock } = await import(process.env.LOCK_MODULE);
const { sleep } = await import(process.env.WAIT_MODULE);
const [target, rounds, start, roundMs] = [process.env.TARGET, Number(process.env.ROUNDS), Number(process.env.START), Number(process.env.ROUND_MS)];
const holder = (lock) => {
  try {
    return JSON.parse(readFileSync(lock, 'utf8')).pid;
  } catch {
    return undefined;
  }
};
let wrong = 0;
for (let round = 0; round < rounds; round++) {
  while (Date.now() < start + round * roundMs) sleep(1);
  const name = target + '-' + round;
  withLock(name, () => {
    try {
      mkdirSync(name + '.inside');
    } catch {
      wrong++;
      return;
    }
    for (let ms = 0; ms < 20; ms++) {
      if (holder(name + '.lock') !== process.pid) wrong++;
      sleep(1);
    }
    rmdirSync(name + '.inside');
  }, { waitMs: 20000 });
}
process.stdout.write(String(wrong));
`;

test('a left-over lock is taken over by one process at a time: of four processes that find it at once, none holds it with another or loses it while it works', async (t) => {
  const target = path.join(home(t), 'target');
  const rounds = 25;
  const gone = spawnSync('true').pid;
  for (let round = 0; round < rounds; round++) writeFileSync(`${target}-${round}.lock`, JSON.stringify({ pid: gone, since: new Date().toISOString() }));
  const env = {
    ...process.env,
    LOCK_MODULE: pathToFileURL(path.join(REPO, 'tools/ledger/lock.ts')).href,
    WAIT_MODULE: pathToFileURL(path.join(REPO, 'tools/ledger/wait.ts')).href,
    TARGET: target,
    ROUNDS: String(rounds),
    START: String(Date.now() + 3000),
    ROUND_MS: '300',
    // Widens each moment between a read of the lock and the step that depends on it.
    LEDGER_TEST_DELAY_MS: '20',
  };
  const contender = (): Promise<Ran> =>
    new Promise((resolve, reject) => {
      const child = spawnAsync(process.execPath, ['--input-type=module', '-e', LOCK_CONTENDER], { cwd: REPO, env });
      let [stdout, stderr] = ['', ''];
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });

  const ran = await Promise.all(Array.from({ length: 4 }, contender));

  for (const { status, stderr } of ran) assert.equal(status, 0, stderr);
  assert.deepEqual(
    ran.map(({ stdout }) => Number(stdout)),
    [0, 0, 0, 0],
    'two processes held a lock at once',
  );
  for (let round = 0; round < rounds; round++) assert.equal(existsSync(`${target}-${round}.lock`), false, `the lock of round ${round} is left`);
});

test('a sync that started earlier does not record its problem over the success of a sync that started later', (t) => {
  const paths = ledgerPaths(home(t));
  clearStatus(paths, 300);
  recordProblem(paths, new SyncProblem('network', 'older'), 150);
  assert.equal(readStatus(paths), undefined);
});

test('a background sync whose sync fails syncs once more for a command that left a note meanwhile', async (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'first', '--goal', 'First.');
  remoteHook(bare, 'pre-receive', ['if [ ! -f refused ]; then', '  touch refused receiving', '  sleep 2', '  exit 1', 'fi']);
  const first = started(a, ['store', 'sync', '--quiet']);
  await until(() => existsSync(path.join(bare, 'receiving')), 'the first push');
  ledgerOk(a, 'task', 'new', 'second', '--goal', 'Second.');
  assert.equal(run(a, ['store', 'sync', '--quiet']).status, 0);

  const done = await first;

  assert.equal(done.status, 0, done.stderr);
  for (const file of [`backlog/${APP}/first.json`, `backlog/${APP}/second.json`]) assert.ok(remoteFiles(bare).includes(file), file);
  assert.equal(existsSync(a.status), false);
});

// ---------------------------------------------------------------------------------------------------------- init config

test('sync init reaches the URL as git config outside any repository sends it: a repository at ~/.claude does not rewrite it', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  // A shorter prefix than the one in ~/.claude, so that one would win wherever git reads it.
  writeFileSync(path.join(a.h, '.gitconfig'), `[url "${path.dirname(bare)}/"]\n\tinsteadOf = https://github.com/me/\n`);
  const evil = elsewhere(a);
  const seed = path.join(a.h, 'seed');
  git(a.h, a.h, 'clone', '--quiet', evil, seed);
  writeFileSync(path.join(seed, 'README.md'), '# something else\n');
  git(a.h, seed, 'add', '-A');
  git(a.h, seed, 'commit', '--quiet', '-m', 'unrelated');
  git(a.h, seed, 'push', '--quiet', 'origin', 'HEAD:main');
  const claude = path.join(a.h, '.claude');
  git(a.h, a.h, 'init', '--quiet', claude);
  git(a.h, claude, 'config', `url.${evil}.insteadOf`, URL);

  ok(run(a, ['store', 'sync', 'init', URL]));

  assert.equal(git(a.h, a.clone, 'rev-parse', 'HEAD'), remoteHead(bare));
  assert.equal(remoteText(bare, '.ledger-data').trim(), '{"format":1}');
});

// ------------------------------------------------------------------------------------------------- what reaches git

test('migrate --to git --remove-source keeps the source when git storage commits other text than the source it read', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  ok(run(a, ['store', 'sync', 'init', URL]));
  const source = path.join(a.h, `.claude/ledger-backlog/${APP}/fix-login.json`);
  const text = readFileSync(source, 'utf8');
  // Stands in for another command that changes the copy once the check is done: the commit then holds its text, on disk too.
  const hook = path.join(a.clone, '.git/hooks/post-commit');
  writeFileSync(
    hook,
    ['#!/bin/sh', '[ ! -f "$HOME/changed" ] || exit 0', 'touch "$HOME/changed"', `printf 'changed\\n' > backlog/${APP}/fix-login.json`, `git add backlog/${APP}/fix-login.json`, 'git commit --quiet --amend --no-edit --no-verify', ''].join('\n'),
  );
  chmodSync(hook, 0o755);

  const output = failed(run(a, ['store', 'migrate', '--to', 'git', '--remove-source']));

  assert.ok(existsSync(path.join(a.h, 'changed')), 'the hook did not run');
  assert.match(output, /ledger store migrate stopped/);
  assert.equal(readFileSync(source, 'utf8'), text);
  assert.equal(existsSync(path.join(a.h, '.claude/ledger-settings.json')), false);
});

for (const hide of ['a replace object', 'a graft'] as const) {
  test(`ledger store sync and the pre-push hook scan the commits git pushes, also when ${hide} hides one`, (t) => {
    const bare = remote(t);
    const a = machine(t, bare);
    setUp(a);
    const before = remoteHead(bare);
    ledgerOk(a, 'task', 'new', 'leak', '--goal', `Use ${GITHUB_TOKEN} to log in.`);
    const leak = git(a.h, a.clone, 'rev-parse', 'HEAD');
    // A later commit takes the token out again, so the last tree holds none; only the commit that added it does.
    writeFileSync(path.join(a.clone, `backlog/${APP}/leak.json`), '# leak\n');
    git(a.h, a.clone, 'commit', '--quiet', '-am', 'clean');
    if (hide === 'a replace object') {
      git(a.h, a.clone, 'replace', leak, git(a.h, a.clone, 'commit-tree', 'HEAD^{tree}', '-p', before, '-m', 'clean'));
    } else {
      writeFileSync(path.join(a.clone, '.git/info/grafts'), `${git(a.h, a.clone, 'rev-parse', 'HEAD')} ${before}\n`);
    }

    const synced = run(a, ['store', 'sync']);
    const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');

    for (const [who, ran] of [['ledger store sync', synced], ['git push', pushed]] as const) {
      assert.notEqual(ran.status, 0, `${who} was not blocked`);
      assert.match(`${ran.stdout}${ran.stderr}`, new RegExp(String.raw`backlog\/${APP_PATTERN}\/leak\.json:\d+`), who);
    }
    // ledger store sync's own scan, not the pre-push hook its push runs, must find it.
    assert.match(`${synced.stdout}${synced.stderr}`, /The commits not pushed yet add secret-like text/);
    assert.equal(remoteHead(bare), before);
  });
}

test('ledger store sync and the pre-push hook of a manual git push both refuse a path outside the allowlist, a backslash, a symbolic link and an executable file', (t) => {
  const cases: [string, (clone: string) => void][] = [
    ['notes.txt', (clone) => writeFileSync(path.join(clone, 'notes.txt'), 'private\n')],
    [`backlog/${APP}/a\\b.md`, (clone) => writeFileSync(path.join(clone, `backlog/${APP}/a\\b.md`), '# a\n')],
    [`backlog/${APP}/link.md`, (clone) => symlinkSync('/etc/hosts', path.join(clone, `backlog/${APP}/link.md`))],
    [`backlog/${APP}/run.md`, (clone) => (writeFileSync(path.join(clone, `backlog/${APP}/run.md`), '# run\n'), chmodSync(path.join(clone, `backlog/${APP}/run.md`), 0o755))],
  ];
  for (const [file, add] of cases) {
    const bare = remote(t);
    const a = machine(t, bare);
    setUp(a);
    const before = remoteHead(bare);
    mkdirSync(path.join(a.clone, `backlog/${APP}`), { recursive: true });
    add(a.clone);
    git(a.h, a.clone, '--literal-pathspecs', 'add', '-f', '--', file);
    git(a.h, a.clone, 'commit', '--quiet', '-m', 'by hand');

    const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');
    const synced = run(a, ['store', 'sync']);

    for (const [who, ran] of [['git push', pushed], ['ledger store sync', synced]] as const) {
      assert.notEqual(ran.status, 0, `${who} was not blocked for ${file}`);
      assert.ok(`${ran.stdout}${ran.stderr}`.includes(file), `${who} does not name ${file}:\n${ran.stdout}${ran.stderr}`);
    }
    assert.equal(remoteHead(bare), before, file);
  }
});

test('ledger store sync and the pre-push hook name the exact line of a secret, also when git config merges nearby hunks', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const file = path.join(a.clone, `backlog/${APP}/notes.md`);
  const lines = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`);
  ledgerOk(a, 'store', 'sync');
  const before = remoteHead(bare);
  lines[1] = `line 2 ${GITHUB_TOKEN}`;
  lines[5] = `line 6 ${GITHUB_TOKEN}`;
  writeFileSync(file, `${lines.join('\n')}\n`);
  git(a.h, a.clone, 'commit', '--quiet', '-am', 'two secrets');
  git(a.h, a.clone, 'config', 'diff.interHunkContext', '10');

  const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');
  const synced = run(a, ['store', 'sync']);

  for (const [who, ran] of [['git push', pushed], ['ledger store sync', synced]] as const) {
    const output = `${ran.stdout}${ran.stderr}`;
    assert.notEqual(ran.status, 0, who);
    for (const line of [2, 6]) assert.ok(output.includes(`backlog/${APP}/notes.md:${line}`), `${who} does not name line ${line}:\n${output}`);
    assert.ok(!output.includes(`backlog/${APP}/notes.md:3`), `${who} names line 3:\n${output}`);
  }
  assert.equal(remoteHead(bare), before);
});

test('ledger store sync and the session start fetch and move the remote-tracking branch only while they hold the clone lock', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const updates = path.join(a.h, 'remote-ref-updates');
  const hook = path.join(a.clone, '.git/hooks/reference-transaction');
  writeFileSync(
    hook,
    [
      '#!/bin/sh',
      '[ "$1" = committed ] || { cat >/dev/null; exit 0; }',
      'while read -r old new ref; do',
      '  case $ref in refs/remotes/origin/*)',
      `    if [ -e "$HOME/.claude/ledger-data.lock" ]; then echo locked; else echo unlocked; fi >> '${updates}' ;;`,
      '  esac',
      'done',
      '',
    ].join('\n'),
  );
  chmodSync(hook, 0o755);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  ledgerOk(a, 'store', 'sync');
  const other = plainClone(a);
  writeFileSync(path.join(other, `backlog/${APP}/other.md`), '# other\n');
  pushFrom(a, other, 'from elsewhere');

  hookContext(a);

  const seen = readFileSync(updates, 'utf8').trim().split('\n');
  assert.ok(seen.length >= 2, seen.join(', '));
  assert.deepEqual(
    seen.filter((update) => update !== 'locked'),
    [],
    `the remote-tracking branch moved without the clone lock: ${seen.join(', ')}`,
  );
});

test('gh error text is printed and recorded without secret-like words', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const b = machine(t, bare);
  for (const h of [a.h, b.h]) writeFileSync(path.join(h, 'stub-bin/gh'), `#!/bin/sh\necho "gh: the token ${GITHUB_TOKEN} is not valid" >&2\nexit 4\n`);

  const synced = failed(run(a, ['store', 'sync']));
  const init = failed(run(b, ['store', 'sync', 'init', URL]));

  for (const [where, text] of [['sync', synced], ['status file', readFileSync(a.status, 'utf8')], ['init', init]]) {
    assert.match(text, /not valid/, where);
    assert.ok(!text.includes(GITHUB_TOKEN), `the ${where} holds the secret-like word`);
  }
});

for (const held of ['lock', 'reclaim guard'] as const) {
  test(`the whole session start stays within its 5 s, when the pull uses its share, git then hangs in the session folder, and another process holds the registry's ${held}`, (t) => {
    const bare = remote(t);
    const a = machine(t, bare);
    setUp(a);
    ledgerOk(a, 'task', 'new', 'first', '--goal', 'First.');
    ledgerOk(a, 'store', 'sync');
    const b = machine(t, bare);
    answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });
    setUp(b);
    ledgerOk(a, 'task', 'new', 'later', '--goal', 'Comes later.');
    ledgerOk(a, 'store', 'sync');
    ledgerOk(b, 'task', 'new', 'mine', '--goal', 'Made on B.');
    ledgerOk(b, 'go', 'mine');
    // Without a registry the session start writes one, so it waits for the registry's lock, or to release it.
    const registry = path.join(b.h, '.claude/ledgers-git.json');
    rmSync(registry, { force: true });
    const planted = JSON.stringify({ pid: process.pid, since: new Date().toISOString() });
    writeFileSync(held === 'lock' ? `${registry}.lock` : `${registry}.lock.reclaim`, planted);
    const rewriting = path.join(b.h, 'rewriting');
    const slow = path.join(b.clone, '.git/hooks/post-rewrite');
    writeFileSync(slow, `#!/bin/sh\nexec >/dev/null 2>&1 </dev/null\ntouch '${rewriting}'\nsleep 30\n`);
    chmodSync(slow, 0o755);
    const stubs = path.join(b.h, 'hanging-git');
    mkdirSync(stubs);
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(path.join(stubs, 'git'), `#!/bin/sh\nfor arg in "$@"; do case "$arg" in '${b.app}'*) exec sleep 30 ;; esac; done\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    const env = { ...quietEnv(b), PATH: `${stubs}${path.delimiter}${quietEnv(b).PATH ?? ''}` };
    const [, startUp] = timed(() => run(b, ['--help'], { env }));

    const [ran, ms] = timed(() => run(b, ['hook', 'session-start'], { cwd: b.app, env, input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: b.app }) }));

    assert.equal(ran.status, 0, ran.stderr);
    assert.ok(existsSync(rewriting), 'the session start did not rebase');
    if (held === 'lock') {
      assert.equal(existsSync(registry), false, 'the session start wrote the registry: its lock was not in the way');
      assert.equal(readFileSync(`${registry}.lock`, 'utf8'), planted);
    } else {
      assert.ok(existsSync(`${registry}.lock`), 'the session start let go of the registry lock: the reclaim guard was not in the way');
    }
    // The 5 s start when the hook starts its work. The second on top is for the work after the last git call, which reads
    // files only, and for start-up times that differ between runs; without one deadline the hook takes about 9 s.
    assert.ok(ms - startUp < 6000, `the session start took ${ms - startUp} ms after start-up`);
  });
}

test('git in the clone ignores GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and GIT_CONFIG_* of the environment ledger runs in', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const appHead = git(a.h, a.app, 'rev-parse', 'HEAD');
  const env = {
    ...quietEnv(a),
    GIT_DIR: path.join(a.app, '.git'),
    GIT_WORK_TREE: a.app,
    GIT_INDEX_FILE: path.join(a.h, 'other-index'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'remote.origin.url',
    GIT_CONFIG_VALUE_0: elsewhere(a),
  };

  ok(run(a, ['task', 'new', 'fix-login', '--goal', 'Users cannot log in.'], { env }));
  ok(run(a, ['store', 'sync'], { env }));

  git(a.h, a.clone, 'cat-file', '-e', `HEAD:backlog/${APP}/fix-login.json`);
  assert.equal(git(a.h, a.app, 'rev-parse', 'HEAD'), appHead);
  assert.ok(remoteFiles(bare).includes(`backlog/${APP}/fix-login.json`));
});

test('sync init asks gh for the visibility and whether the repository is empty, and refuses when gh and git disagree on empty', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  answerGh(a.h, { visibility: 'PRIVATE', isEmpty: false });

  assert.match(failed(run(a, ['store', 'sync', 'init', URL])), /empty/);

  assert.match(readFileSync(path.join(a.h, 'gh-calls'), 'utf8'), /--json visibility,isEmpty/);
  assert.equal(existsSync(a.clone), false);
  assert.equal(remoteHead(bare), '');
});

for (const flag of ['--assume-unchanged', '--skip-worktree']) {
  test(`a ledger the clone's index marks ${flag.slice(2)} is not committed: the command warns and records it`, (t) => {
    const bare = remote(t);
    const a = machine(t, bare);
    setUp(a);
    ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
    git(a.h, a.clone, 'update-index', flag, `backlog/${APP}/fix-login.json`);

    const ran = run(a, ['task', 'park', 'fix-login', '--reason', 'waits for design']);

    assert.match(ran.stderr, /not committed/);
    assert.equal(JSON.parse(readFileSync(a.status, 'utf8')).problem, 'git');
    assert.doesNotMatch(git(a.h, a.clone, 'show', `HEAD:backlog/${APP}/fix-login.json`), /waits for design/);
  });
}

test('migrate git → sqlite --remove-source moves the ledgers, removes them from git storage and pushes that', { skip: noSqlite }, (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  ledgerOk(a, 'task', 'new', 'old', '--goal', 'Old work.');
  ledgerOk(a, 'task', 'retire', 'old');
  ledgerOk(a, 'store', 'sync');
  const archived = `archive/${APP}/${today()}-old.json`;
  assert.ok(remoteFiles(bare).includes(archived));

  ledgerOk(a, 'store', 'migrate', '--to', 'sqlite', '--remove-source');

  const store = sqliteStore({ home: a.h });
  t.after(() => store.close?.());
  assert.match(store.backlog.read(APP_KEY, 'fix-login')?.text ?? '', /Users cannot log in\./);
  assert.ok(store.archive.has(APP_KEY, `${today()}-old`));
  assert.deepEqual(JSON.parse(readFileSync(path.join(a.h, '.claude/ledger-settings.json'), 'utf8')), { storage: 'sqlite' });
  const files = remoteFiles(bare);
  for (const file of [`backlog/${APP}/fix-login.json`, archived]) assert.ok(!files.includes(file), `${file} is still pushed`);
  assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');
});

// ------------------------------------------------------------------------------------------------- clone and its lock

test('git in the clone ignores GIT_ALTERNATE_OBJECT_DIRECTORIES of the environment ledger runs in', () => {
  const before = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = '/elsewhere/objects';
  try {
    assert.equal(cloneEnv().GIT_ALTERNATE_OBJECT_DIRECTORIES, undefined);
  } finally {
    if (before === undefined) delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    else process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = before;
  }
});

const holderOf = (pid: number, ageMs: number): string => JSON.stringify({ pid, since: new Date(Date.now() - ageMs).toISOString() });

test('a reclaim guard older than its time limit is taken over, also while a process with its pid runs, so a left-over lock behind it is reclaimed', (t) => {
  const target = path.join(home(t), 'target');
  writeFileSync(`${target}.lock`, holderOf(spawnSync('true').pid ?? 0, 0));
  writeFileSync(`${target}.lock.reclaim`, holderOf(process.pid, 10 * 60_000));

  assert.equal(
    withLock(target, () => 'ran', { waitMs: 2000 }),
    'ran',
  );
  assert.equal(existsSync(`${target}.lock`), false);
  assert.equal(existsSync(`${target}.lock.reclaim`), false);
});

test('a lock wait that runs out names the lock and its reclaim guard', (t) => {
  const target = path.join(home(t), 'target');
  writeFileSync(`${target}.lock`, holderOf(process.pid, 0));

  assert.throws(
    () => withLock(target, () => 'ran', { waitMs: 50 }),
    (error: Error) => error.message.includes(`${target}.lock `) && error.message.includes(`${target}.lock.reclaim`),
  );
});

/** Runs `count` LOCK_CONTENDER processes on `target`, each round at the same moment, and gives each one's count of wrongs. */
async function contendFor(target: string, rounds: number, count: number): Promise<number[]> {
  const env = {
    ...process.env,
    LOCK_MODULE: pathToFileURL(path.join(REPO, 'tools/ledger/lock.ts')).href,
    WAIT_MODULE: pathToFileURL(path.join(REPO, 'tools/ledger/wait.ts')).href,
    TARGET: target,
    ROUNDS: String(rounds),
    START: String(Date.now() + 3000),
    ROUND_MS: '300',
    LEDGER_TEST_DELAY_MS: '20',
  };
  const contender = (): Promise<Ran> =>
    new Promise((resolve, reject) => {
      const child = spawnAsync(process.execPath, ['--input-type=module', '-e', LOCK_CONTENDER], { cwd: REPO, env });
      let [stdout, stderr] = ['', ''];
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  const ran = await Promise.all(Array.from({ length: count }, contender));
  for (const { status, stderr } of ran) assert.equal(status, 0, stderr);
  return ran.map(({ stdout }) => Number(stdout));
}

test('a left-over lock behind a left-over reclaim guard is taken over by one process at a time: of eight that find both at once, none holds the lock with another', async (t) => {
  const target = path.join(home(t), 'target');
  const rounds = 40;
  const gone = spawnSync('true').pid ?? 0;
  for (let round = 0; round < rounds; round++) {
    writeFileSync(`${target}-${round}.lock`, holderOf(gone, 0));
    writeFileSync(`${target}-${round}.lock.reclaim`, holderOf(gone, 0));
  }

  assert.deepEqual(await contendFor(target, rounds, 8), [0, 0, 0, 0, 0, 0, 0, 0], 'two processes held a lock at once');
  for (let round = 0; round < rounds; round++) {
    assert.equal(existsSync(`${target}-${round}.lock`), false, `the lock of round ${round} is left`);
    assert.equal(existsSync(`${target}-${round}.lock.reclaim`), false, `the guard of round ${round} is left`);
  }
});

test('a clone whose .git is a symbolic link is no git storage: a command exits 1 and says why', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const moved = path.join(a.h, 'moved.git');
  renameSync(path.join(a.clone, '.git'), moved);
  symlinkSync(moved, path.join(a.clone, '.git'));

  assert.match(failed(run(a, ['task', 'new', 'fix-login', '--goal', 'Users cannot log in.'])), /\.git is not a folder/);
  assert.equal(existsSync(path.join(a.clone, `backlog/${APP}/fix-login.json`)), false);
});

test('a clone whose git names another top folder is no git storage: a command exits 1 and says why', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const other = path.join(a.h, 'other-tree');
  mkdirSync(other);
  git(a.h, a.clone, 'config', 'core.worktree', other);

  assert.match(failed(run(a, ['task', 'new', 'fix-login', '--goal', 'Users cannot log in.'])), /top folder/);
  assert.equal(existsSync(path.join(a.clone, `backlog/${APP}/fix-login.json`)), false);
  assert.deepEqual(readdirSync(other), []);
});

test('a clone whose .git/hooks is a symbolic link is no git storage: ledger store sync exits 1 and writes no hook through it', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const outside = path.join(a.h, 'outside-hooks');
  renameSync(path.join(a.clone, '.git/hooks'), outside);
  rmSync(path.join(outside, 'pre-push'));
  symlinkSync(outside, path.join(a.clone, '.git/hooks'));

  assert.match(failed(run(a, ['store', 'sync'])), /hooks is a symbolic link/);
  assert.equal(existsSync(path.join(outside, 'pre-push')), false);
});

test('ledger store sync refuses to rebase a merge commit made in the clone, which a rebase would drop: exit 1, the merge stays, nothing is pushed', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'first', '--goal', 'First.');
  ledgerOk(a, 'store', 'sync');
  const b = machine(t, bare);
  answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });
  setUp(b);
  git(b.h, b.clone, 'checkout', '--quiet', '-b', 'side');
  writeFileSync(path.join(b.clone, `backlog/${APP}/side.md`), '# side\n');
  git(b.h, b.clone, 'add', '-A');
  git(b.h, b.clone, 'commit', '--quiet', '-m', 'side');
  git(b.h, b.clone, 'checkout', '--quiet', 'main');
  writeFileSync(path.join(b.clone, `backlog/${APP}/main.md`), '# main\n');
  git(b.h, b.clone, 'add', '-A');
  git(b.h, b.clone, 'commit', '--quiet', '-m', 'main');
  git(b.h, b.clone, 'merge', '--quiet', '--no-ff', '-m', 'merge side', 'side');
  const merge = git(b.h, b.clone, 'rev-parse', 'HEAD');
  ledgerOk(a, 'task', 'new', 'later', '--goal', 'Comes later.');
  ledgerOk(a, 'store', 'sync');
  const before = remoteHead(bare);

  assert.match(failed(run(b, ['store', 'sync'])), /merge commit/);

  assert.equal(git(b.h, b.clone, 'rev-parse', 'HEAD'), merge);
  assert.equal(remoteHead(bare), before);
});

/** The pull of the session start, in this process, so no other step of the session start, such as opening the store, repairs anything. */
function pullHere(m: Machine): void {
  const before = process.env.HOME;
  // The git config of HOME sends the GitHub URL of these tests to the bare repository.
  process.env.HOME = m.h;
  allowRemoteForTests(m.bare);
  try {
    pullForSession(ledgerPaths(m.h), Date.now() + 5000);
  } finally {
    process.env.HOME = before;
  }
}

for (const when of ['a ledger command', 'the session-start pull'] as const) {
  test(`${when} puts back a pre-push hook that was changed, and the core.hooksPath that names it`, (t) => {
    const bare = remote(t);
    const a = machine(t, bare);
    setUp(a);
    writeFileSync(hookFile(a), '#!/bin/sh\nexit 0\n');
    git(a.h, a.clone, 'config', 'core.hooksPath', path.join(a.h, 'elsewhere'));

    if (when === 'a ledger command') ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
    else pullHere(a);

    assertOwnHook(a);
  });
}

test('a path whose name holds a line break is outside the allowlist of ledger store sync and of the pre-push hook', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const before = remoteHead(bare);
  mkdirSync(path.join(a.clone, `backlog/${APP}`), { recursive: true });
  writeFileSync(path.join(a.clone, `backlog/${APP}/a\nb.md`), '# a\n');
  git(a.h, a.clone, 'add', '-A');
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'line break');

  const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');
  const synced = run(a, ['store', 'sync']);

  assert.notEqual(pushed.status, 0, 'git push was not blocked');
  assert.match(pushed.stderr, /ledger pre-push: the push is blocked/);
  const output = failed(synced);
  assert.match(output, /these paths are not ledgers/);
  assert.doesNotMatch(output, /ledger pre-push/);
  assert.equal(remoteHead(bare), before);
});

for (const where of ['origin', 'a URL rewrite'] as const) {
  test(`a refused remote URL is printed and recorded without secret-like words: ${where}`, (t) => {
    const bare = remote(t);
    const a = machine(t, bare);
    setUp(a);
    if (where === 'origin') git(a.h, a.clone, 'config', 'remote.origin.url', `https://example.com/${GITHUB_TOKEN}.git`);
    else git(a.h, a.clone, 'config', `url.https://example.com/${GITHUB_TOKEN}/.pushInsteadOf`, 'https://github.com/me/');

    const output = failed(run(a, ['store', 'sync']));

    assert.match(output, /nothing was pulled or pushed/);
    for (const [what, text] of [['output', output], ['status file', readFileSync(a.status, 'utf8')]]) assert.ok(!text.includes(GITHUB_TOKEN), `the ${what} holds the secret-like word`);
  });
}

test('ledger store sync and the session start write the privacy check and the hook setting only while they hold the clone lock', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const writes = path.join(a.h, 'config-writes');
  const stubs = path.join(a.h, 'logging-git');
  mkdirSync(stubs);
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(
    path.join(stubs, 'git'),
    [
      '#!/bin/sh',
      'case " $* " in',
      '  *" --get"*) ;;',
      `  *" config "*ledger.checkedPrivate*|*" config "*core.hooksPath*) if [ -e "$HOME/.claude/ledger-data.lock" ]; then echo locked; else echo unlocked; fi >> '${writes}' ;;`,
      'esac',
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const env = { ...quietEnv(a), PATH: `${stubs}${path.delimiter}${quietEnv(a).PATH ?? ''}` };
  git(a.h, a.clone, 'config', 'core.hooksPath', path.join(a.h, 'elsewhere'));

  ok(run(a, ['store', 'sync'], { env }));
  git(a.h, a.clone, 'config', 'core.hooksPath', path.join(a.h, 'elsewhere'));
  assert.equal(run(a, ['hook', 'session-start'], { env, input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: a.h }) }).status, 0);

  const seen = readFileSync(writes, 'utf8').trim().split('\n');
  assert.ok(seen.length >= 3, seen.join(', '));
  assert.deepEqual(
    seen.filter((write) => write !== 'locked'),
    [],
    `a config write ran without the clone lock: ${seen.join(', ')}`,
  );
});

test('after a push, ledger store sync never moves the remote-tracking branch back from a newer commit a fetch found meanwhile', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  remoteHook(bare, 'post-receive', [
    '[ ! -f "$HOME/moved" ] || exit 0',
    'touch "$HOME/moved"',
    'unset GIT_DIR GIT_QUARANTINE_PATH',
    `new=$(git -C '${bare}' -c user.name=test -c user.email=test@example.com commit-tree 'refs/heads/main^{tree}' -p refs/heads/main -m later)`,
    `git -C '${bare}' update-ref refs/heads/main "$new"`,
    `git -C '${a.clone}' fetch --quiet '${bare}' +refs/heads/main:refs/remotes/origin/main`,
  ]);

  ledgerOk(a, 'store', 'sync');

  assert.ok(existsSync(path.join(a.h, 'moved')), 'the remote hook did not run');
  assert.equal(git(a.h, a.clone, 'rev-parse', 'refs/remotes/origin/main'), remoteHead(bare));
});

test('a command that commits nothing still starts the push while the clone has commits the remote lacks', async (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  assert.ok(!remoteFiles(bare).includes(`backlog/${APP}/fix-login.json`));

  ok(run(a, ['list'], { env: machineEnv(a) }));

  await until(() => remoteFiles(bare).includes(`backlog/${APP}/fix-login.json`) && backgroundSyncDone(a), 'the background push', 10_000);
});

test('a command starts the push when git cannot count the commits the remote lacks', async (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  const stubs = path.join(a.h, 'failing-git');
  mkdirSync(stubs);
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  // Only the count a closing store makes fails; the sync it starts runs git as usual.
  writeFileSync(path.join(stubs, 'git'), `#!/bin/sh\ncase " $* " in *" rev-list --count --ignore-missing "*) exit 128 ;; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });

  ok(run(a, ['list'], { env: { ...machineEnv(a), PATH: `${stubs}${path.delimiter}${machineEnv(a).PATH ?? ''}` } }));

  await until(() => remoteFiles(bare).includes(`backlog/${APP}/fix-login.json`) && backgroundSyncDone(a), 'the background push', 10_000);
});

test('ledger store sync and sync init stop waiting for a gh that does not answer, exit 1 and say so, and push nothing', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  const b = machine(t, bare);
  answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });
  const before = remoteHead(bare);

  for (const [m, args] of [
    [a, ['store', 'sync']],
    [b, ['store', 'sync', 'init', URL]],
  ] as const) {
    writeFileSync(path.join(m.h, 'gh-delay'), '10');
    const [ran, ms] = timed(() => run(m, [...args], { env: { ...quietEnv(m), LEDGER_TEST_GH_TIMEOUT_MS: '500' } }));
    assert.match(failed(ran), /gh did not answer/, args.join(' '));
    assert.ok(ms < 5000, `${args.join(' ')} took ${ms} ms`);
  }
  assert.equal(remoteHead(bare), before);
  assert.equal(existsSync(b.clone), false);
});

test('sync init of a repository with the marker makes the backlog and archive folders, which git does not keep while empty', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const b = machine(t, bare);
  answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });

  ok(run(b, ['store', 'sync', 'init', URL]));

  for (const folder of ['backlog', 'archive']) assert.ok(lstatSync(path.join(b.clone, folder), { throwIfNoEntry: false })?.isDirectory(), `${folder} is no folder`);
});

test('a manual git push of a path whose whole name is a line break is blocked by the pre-push hook', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const before = remoteHead(bare);
  writeFileSync(path.join(a.clone, '\n'), '# a\n');
  git(a.h, a.clone, 'add', '-f', '--', '\n');
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'line break');

  const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');

  assert.notEqual(pushed.status, 0, 'git push was not blocked');
  assert.match(pushed.stderr, /these paths are not:/);
  assert.equal(remoteHead(bare), before);
});

test('sync init again on a set-up clone makes no backlog or archive folder', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  for (const folder of ['backlog', 'archive']) rmSync(path.join(a.clone, folder), { recursive: true, force: true });

  assert.match(ok(run(a, ['store', 'sync', 'init', URL])), /already set up/);

  for (const folder of ['backlog', 'archive']) assert.equal(existsSync(path.join(a.clone, folder)), false, `${folder} was made`);
});

test('sync init never prints a secret-like part of a URL, of the repository gh checks, of its answer or of an existing clone', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  const tokenUrl = `https://example.com/${GITHUB_TOKEN}.git`;
  const tokenRepoUrl = `https://github.com/me/${GITHUB_TOKEN}.git`;
  const outputs: [string, string][] = [];
  outputs.push(['a URL that is not GitHub', failed(run(a, ['store', 'sync', 'init', tokenUrl]))]);
  answerGh(a.h, { visibility: 'PUBLIC', isEmpty: true });
  outputs.push(['a GitHub repository name', failed(run(a, ['store', 'sync', 'init', tokenRepoUrl]))]);
  answerGh(a.h, { visibility: GITHUB_TOKEN, isEmpty: true });
  outputs.push(['the visibility gh names', failed(run(a, ['store', 'sync', 'init', URL]))]);
  answerGh(a.h, { visibility: 'PRIVATE', isEmpty: true });
  outputs.push(['a repository git cannot reach', failed(run(a, ['store', 'sync', 'init', tokenRepoUrl]))]);
  setUp(a);
  git(a.h, a.clone, 'config', 'remote.origin.url', tokenUrl);
  outputs.push(['the origin of the clone', failed(run(a, ['store', 'sync', 'init', URL]))]);

  for (const [what, output] of outputs) {
    assert.match(output, /ledger store sync init stopped/, what);
    assert.ok(!output.includes(GITHUB_TOKEN), `${what} is printed with the secret-like word:\n${output}`);
  }
});

for (const slow of ['opens', 'closes'] as const) {
  test(`the whole session start stays within its 5 s when git hangs while git storage ${slow}`, (t) => {
    const bare = remote(t);
    const a = machine(t, bare);
    setUp(a);
    ledgerOk(a, 'task', 'new', 'mine', '--goal', 'Made here.');
    ledgerOk(a, 'go', 'mine');
    // Opening reads core.hooksPath to check the pre-push hook; closing counts the commits not pushed yet.
    const hangs = slow === 'opens' ? '*" --get-all core.hooksPath "*' : '*" rev-list --count "*';
    const stubs = path.join(a.h, 'hanging-git');
    mkdirSync(stubs);
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(path.join(stubs, 'git'), `#!/bin/sh\ncase " $* " in ${hangs}) exec sleep 10 ;; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    const env = { ...quietEnv(a), PATH: `${stubs}${path.delimiter}${quietEnv(a).PATH ?? ''}` };
    const [, startUp] = timed(() => run(a, ['--help'], { env }));

    const [ran, ms] = timed(() => run(a, ['hook', 'session-start'], { cwd: a.app, env, input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: a.app }) }));

    assert.equal(ran.status, 0, ran.stderr);
    assert.ok(ms - startUp < 6000, `the session start took ${ms - startUp} ms after start-up`);
  });
}

test('a command starts the push while origin lacks a commit on the branch the clone pushes to, also when another branch of origin has it', async (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  git(a.h, a.clone, 'push', '--quiet', 'origin', 'HEAD:refs/heads/side');
  assert.ok(!remoteFiles(bare).includes(`backlog/${APP}/fix-login.json`));

  ok(run(a, ['list'], { env: machineEnv(a) }));

  await until(() => remoteFiles(bare).includes(`backlog/${APP}/fix-login.json`) && backgroundSyncDone(a), 'the background push', 10_000);
});

test('sync init stops before it writes the pre-push hook through a hooks folder that a git template made a symbolic link', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  const template = path.join(a.h, 'git-template');
  const outside = path.join(a.h, 'outside-hooks');
  mkdirSync(template);
  mkdirSync(outside);
  symlinkSync(outside, path.join(template, 'hooks'));
  appendFileSync(path.join(a.h, '.gitconfig'), `[init]\n\ttemplateDir = ${template}\n`);

  assert.match(failed(run(a, ['store', 'sync', 'init', URL])), /hooks is a symbolic link/);

  assert.deepEqual(readdirSync(outside), []);
  assert.equal(existsSync(a.clone), false);
  assert.equal(remoteHead(bare), '');
});

test('when gh says the repository is no longer private but the clone lock is busy, no later sync trusts the earlier check', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  const before = remoteHead(bare);
  answerGh(a.h, { visibility: 'PUBLIC', isEmpty: false });
  const lock = path.join(a.h, '.claude/ledger-data.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
  failed(run(a, ['store', 'sync']));
  rmSync(lock);

  // A background sync asks gh at most once a day.
  run(a, ['store', 'sync', '--quiet']);

  assert.equal(remoteHead(bare), before);
  assert.match(readFileSync(a.status, 'utf8'), /PUBLIC/);
});

test('a fetch never moves the remote-tracking branch back after the remote lost commits: ledger store sync and the session start refuse and say why', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'first', '--goal', 'First.');
  ledgerOk(a, 'store', 'sync');
  const older = remoteHead(bare);
  ledgerOk(a, 'task', 'new', 'second', '--goal', 'Second.');
  ledgerOk(a, 'store', 'sync');
  const fetched = remoteHead(bare);
  git(path.dirname(bare), bare, 'update-ref', 'refs/heads/main', older);

  const output = failed(run(a, ['store', 'sync']));
  // So the warning can only come from the session start's own pull.
  rmSync(a.status);
  const context = hookContext(a);

  assert.match(output, /lost commits/);
  assert.match(context, /^Ledger sync needs attention: \S+ lost commits that this clone fetched before/);
  assert.equal(git(a.h, a.clone, 'rev-parse', 'refs/remotes/origin/main'), fetched);
  assert.equal(remoteHead(bare), older);
});

for (const [what, prepare] of [
  ['the clone sets fetch.showForcedUpdates=false', (a: Machine) => (git(a.h, a.clone, 'config', 'fetch.showForcedUpdates', 'false'), quietEnv(a))],
  ['git speaks German', (a: Machine) => ({ ...quietEnv(a), LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8', LANGUAGE: 'de' })],
] as const) {
  test(`a remote that lost commits is refused by their ancestry, not by what git says: ${what}`, (t) => {
    const bare = remote(t);
    const a = machine(t, bare);
    setUp(a);
    ledgerOk(a, 'task', 'new', 'first', '--goal', 'First.');
    ledgerOk(a, 'store', 'sync');
    const older = remoteHead(bare);
    ledgerOk(a, 'task', 'new', 'second', '--goal', 'Second.');
    ledgerOk(a, 'store', 'sync');
    const fetched = remoteHead(bare);
    git(path.dirname(bare), bare, 'update-ref', 'refs/heads/main', older);
    const env = prepare(a);

    const output = failed(run(a, ['store', 'sync'], { env }));
    rmSync(a.status);
    const hook = run(a, ['hook', 'session-start'], { cwd: a.h, env, input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: a.h }) });
    failed(run(a, ['store', 'sync'], { env }));

    assert.equal(hook.status, 0, hook.stderr);
    const context = (JSON.parse(hook.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    assert.match(context, /^Ledger sync needs attention: \S+ lost commits that this clone fetched before/);
    assert.match(output, /lost commits/);
    assert.equal(git(a.h, a.clone, 'rev-parse', 'refs/remotes/origin/main'), fetched);
    assert.equal(remoteHead(bare), older);
  });
}

test('after the remote lost commits, git fetch --force origin in the clone and then ledger store sync push the commits made here again', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'first', '--goal', 'First.');
  ledgerOk(a, 'store', 'sync');
  const older = remoteHead(bare);
  ledgerOk(a, 'task', 'new', 'second', '--goal', 'Second.');
  ledgerOk(a, 'store', 'sync');
  const fetched = remoteHead(bare);
  git(path.dirname(bare), bare, 'update-ref', 'refs/heads/main', older);
  failed(run(a, ['store', 'sync']));

  git(a.h, a.clone, 'fetch', '--quiet', '--force', 'origin');
  ledgerOk(a, 'store', 'sync');

  assert.equal(remoteHead(bare), fetched);
});

test('when gh says the repository is no longer private but git cannot change the clone config, no later sync trusts the earlier check', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  const before = remoteHead(bare);
  answerGh(a.h, { visibility: 'PUBLIC', isEmpty: false });
  const configLock = path.join(a.clone, '.git/config.lock');
  writeFileSync(configLock, '');
  assert.match(failed(run(a, ['store', 'sync'])), /PUBLIC/);
  rmSync(configLock);

  // A background sync asks gh at most once a day.
  run(a, ['store', 'sync', '--quiet']);

  assert.equal(remoteHead(bare), before);
  assert.match(readFileSync(a.status, 'utf8'), /PUBLIC/);
});

test('the pre-push hook names a path with a line break and a path with a ? in its place as two paths', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const before = remoteHead(bare);
  for (const file of ['a\nb', 'a?b']) writeFileSync(path.join(a.clone, file), 'x\n');
  git(a.h, a.clone, '--literal-pathspecs', 'add', '-f', '--', 'a\nb', 'a?b');
  git(a.h, a.clone, 'commit', '--quiet', '-m', 'two names');

  const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');

  assert.notEqual(pushed.status, 0, 'git push was not blocked');
  const named = pushed.stderr.split('\n').filter((line) => line.startsWith('  '));
  assert.deepEqual(named, ['  "a\\nb"', '  a?b']);
  assert.equal(remoteHead(bare), before);
});

test("a reclaim that stalls past its guard's time limit, while another process takes the lock, does not delete that lock", (t) => {
  const target = path.join(home(t), 'target');
  const lock = `${target}.lock`;
  writeFileSync(lock, holderOf(spawnSync('true').pid ?? 0, 0));
  const newOwner = JSON.stringify({ pid: process.pid, since: new Date().toISOString(), nonce: 'new owner' });
  // What such a stall lets happen: the guard runs out, another process reclaims the lock, and a new owner takes it.
  let stalled = false;
  const stallBefore = (file: unknown): void => {
    if (stalled || file !== lock) return;
    stalled = true;
    writeFileSync(lock, newOwner);
  };
  const [realRm, realRename] = [fs.rmSync, fs.renameSync];
  t.mock.method(fs, 'rmSync', ((file: string, options?: fs.RmOptions) => (stallBefore(file), realRm(file, options))) as typeof fs.rmSync);
  t.mock.method(fs, 'renameSync', ((from: string, to: string) => (stallBefore(from), realRename(from, to))) as typeof fs.renameSync);
  syncBuiltinESMExports();
  try {
    assert.throws(() => withLock(target, () => {}, { waitMs: 200 }), /Gave up waiting/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }

  assert.ok(stalled, 'the reclaim neither deleted nor moved the lock');
  assert.equal(readFileSync(lock, 'utf8'), newOwner);
});

test('the test helper remoteFiles throws when the remote cannot be read, rather than report no files', (t) => {
  const notARepository = path.join(home(t), 'not-a-repository');
  mkdirSync(notARepository);
  assert.throws(() => remoteFiles(notARepository));
});

// ------------------------------------------------------------------------------------------- secret after a line break

const ANTHROPIC_KEY = token(['s', 'k-ant-'].join(''), 'api03-Xy9_Zw8-Vu7', 95);
const ANTHROPIC_KEY_BODY = ANTHROPIC_KEY.slice('sk-ant-'.length);

for (const [what, text] of [
  ['', 'x\n'],
  [', also when the file adds a secret', `${GITHUB_TOKEN}\n`],
] as const) {
  test(`the pre-push hook withholds a path whose secret-like part follows a line break, and never prints the secret${what}`, (t) => {
    const bare = remote(t);
    const a = machine(t, bare);
    setUp(a);
    const before = remoteHead(bare);
    const name = `x\n${ANTHROPIC_KEY}`;
    writeFileSync(path.join(a.clone, name), text);
    git(a.h, a.clone, '--literal-pathspecs', 'add', '-f', '--', name);
    git(a.h, a.clone, 'commit', '--quiet', '-m', 'odd name');

    const pushed = gitRan(a.h, a.clone, 'push', 'origin', 'HEAD:main');

    assert.notEqual(pushed.status, 0, 'git push was not blocked');
    assert.ok(!pushed.stderr.includes(ANTHROPIC_KEY_BODY), `the hook printed the secret:\n${pushed.stderr}`);
    assert.ok(!pushed.stderr.includes(GITHUB_TOKEN), `the hook printed the secret:\n${pushed.stderr}`);
    assert.match(pushed.stderr, /these paths are not:\n {2}<file name withheld>\n/);
    assert.equal(remoteHead(bare), before);
  });
}

// ------------------------------------------------------------------------------------------------ not private, sticky

test('after gh says the repository is not private, no sync trusts the earlier check, also when git cannot forget it and a later problem of another kind replaces the recorded one, until gh says PRIVATE again', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  const before = remoteHead(bare);
  const calls = (): number => readFileSync(path.join(a.h, 'gh-calls'), 'utf8').trim().split('\n').length;
  const checked = (): boolean => gitRan(a.h, a.clone, 'config', '--get', 'ledger.checkedPrivate').status === 0;
  answerGh(a.h, { visibility: 'PUBLIC', isEmpty: false });
  const configLock = path.join(a.clone, '.git/config.lock');
  writeFileSync(configLock, '');

  assert.match(failed(run(a, ['store', 'sync'])), /PUBLIC/);
  assert.ok(checked(), 'git forgot the earlier check, so this test forces nothing');
  failed(run(a, ['store', 'sync', '--quiet']));
  assert.equal(remoteHead(bare), before, 'a background sync pushed after the forget failed');

  recordProblem(ledgerPaths(a.h), new SyncProblem('git', 'Could not commit in ~/.claude/ledger-data.'));
  const asked = calls();
  failed(run(a, ['store', 'sync', '--quiet']));
  assert.equal(remoteHead(bare), before, 'a background sync pushed after another problem replaced the recorded one');
  assert.equal(calls(), asked + 1, 'the background sync did not ask gh again');

  rmSync(configLock);
  answerGh(a.h, { visibility: 'PRIVATE', isEmpty: false });
  ok(run(a, ['store', 'sync', '--quiet']));
  assert.ok(remoteFiles(bare).includes(`backlog/${APP}/fix-login.json`), 'a PRIVATE answer did not allow the push');
  assert.equal(existsSync(path.join(a.h, '.claude/ledger-data.not-private')), false);

  answerGh(a.h, 'fail');
  ledgerOk(a, 'task', 'new', 'second', '--goal', 'Second.');
  ok(run(a, ['store', 'sync', '--quiet']));
  assert.ok(remoteFiles(bare).includes(`backlog/${APP}/second.json`), 'after a PRIVATE answer, a background sync trusts it for a day again');
});

const ghCalls = (m: Machine): number => readFileSync(path.join(m.h, 'gh-calls'), 'utf8').trim().split('\n').length;

test('when gh says the repository is not private and neither the marker nor the clone config can be written, no later sync trusts the earlier check', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  const before = remoteHead(bare);
  const [claude, gh, lockAfterAnswer] = [path.join(a.h, '.claude'), path.join(a.h, 'stub-bin/gh'), path.join(a.h, 'lock-claude-after-answer')];
  renameSync(gh, `${gh}-answer`);
  writeFileSync(gh, `#!/bin/sh\n"$0-answer" "$@"\nanswered=$?\n[ ! -f '${lockAfterAnswer}' ] || { rm '${lockAfterAnswer}'; chmod 555 "$HOME/.claude"; }\nexit $answered\n`, { mode: 0o755 });
  writeFileSync(lockAfterAnswer, '');
  answerGh(a.h, { visibility: 'PUBLIC', isEmpty: false });
  const configLock = path.join(a.clone, '.git/config.lock');
  writeFileSync(configLock, '');

  let ran: Ran;
  try {
    ran = run(a, ['store', 'sync']);
  } finally {
    chmodSync(claude, 0o755);
  }
  rmSync(configLock);

  assert.equal(existsSync(lockAfterAnswer), false, 'gh was not asked, so this test forces nothing');
  assert.equal(gitRan(a.h, a.clone, 'config', '--get', 'ledger.checkedPrivate').status, 0, 'git forgot the earlier check, so this test forces nothing');
  assert.match(failed(ran), /PUBLIC/);
  // A background sync asks gh at most once a day.
  failed(run(a, ['store', 'sync', '--quiet']));
  assert.equal(remoteHead(bare), before);
});

test('a sync that cannot write the not-private marker stops before it asks gh, so no answer that the repository is not private goes unrecorded', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  const before = remoteHead(bare);
  mkdirSync(path.join(a.h, '.claude/ledger-data.not-private/occupied'), { recursive: true });
  const asked = ghCalls(a);

  const ran = run(a, ['store', 'sync']);

  assert.equal(ghCalls(a), asked, 'gh was asked though the marker cannot be written');
  assert.match(failed(ran), /could not write \S*ledger-data\.not-private/);
  assert.equal(remoteHead(bare), before);
});

test('a PRIVATE answer to a check that started before another check found the repository not private leaves the marker of that later check', async (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  const [marker, delay] = [path.join(a.h, '.claude/ledger-data.not-private'), path.join(a.h, 'gh-delay')];
  const asked = ghCalls(a);
  writeFileSync(delay, '4');
  const earlier = started(a, ['store', 'sync']);
  await until(() => ghCalls(a) > asked, 'the gh call of the earlier sync');
  rmSync(delay);
  answerGh(a.h, { visibility: 'PUBLIC', isEmpty: false });

  assert.match(failed(run(a, ['store', 'sync'])), /PUBLIC/);
  answerGh(a.h, { visibility: 'PRIVATE', isEmpty: false });
  ok(await earlier);

  assert.ok(existsSync(marker), 'the PRIVATE answer of the earlier check cleared the marker of the later one');
  const before = ghCalls(a);
  answerGh(a.h, 'fail');
  failed(run(a, ['store', 'sync', '--quiet']));
  assert.equal(ghCalls(a), before + 1, 'a background sync trusted the check of the earlier sync');
});

// ------------------------------------------------------------------------------------------------ background teardown

test('a background sync that still runs when its test ends, after the wait for it ran out, is stopped before the test removes HOME', async (t) => {
  let pids: number[] = [];
  let h = '';
  await t.test('a wait for the background push that runs out', async (st) => {
    const bare = remote(st);
    const a = machine(st, bare);
    h = a.h;
    setUp(a);
    remoteHook(bare, 'pre-receive', ['sleep 30']);
    ok(run(a, ['task', 'new', 'fix-login', '--goal', 'Users cannot log in.'], { env: machineEnv(a) }));
    pids = readFileSync(backgroundPids(a.h), 'utf8').split('\n').filter(Boolean).map(Number);

    await assert.rejects(until(() => remoteFiles(bare).includes(`backlog/${APP}/fix-login.json`), 'the background push', 500), /did not happen/);
  });

  assert.equal(pids.length, 1);
  assert.deepEqual(pids.filter(runs), [], 'a background sync outlived its test');
  assert.equal(existsSync(h), false);
});

// ------------------------------------------------------------------------------------------------------------ rewinds

test('after the remote lost commits on purpose, the refusal says how to accept that, and doing so pushes none of the lost commits back', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'first', '--goal', 'First.');
  ledgerOk(a, 'store', 'sync');
  const older = remoteHead(bare);
  ledgerOk(a, 'task', 'new', 'second', '--goal', 'Second.');
  ledgerOk(a, 'store', 'sync');
  git(path.dirname(bare), bare, 'update-ref', 'refs/heads/main', older);
  ledgerOk(a, 'task', 'new', 'third', '--goal', 'Third.');

  const output = failed(run(a, ['store', 'sync']));

  assert.match(output, /To push the lost commits back: run git fetch --force origin in \S+, then ledger store sync\./);
  assert.match(output, /git fetch --force origin, then git reset --hard origin\/main/);
  git(a.h, a.clone, 'fetch', '--quiet', '--force', 'origin');
  git(a.h, a.clone, 'reset', '--quiet', '--hard', 'origin/main');
  assert.match(ledgerOk(a, 'store', 'sync'), /Nothing to push/);
  assert.equal(remoteHead(bare), older);
  assert.deepEqual(remoteFiles(bare).filter((file) => file.startsWith('backlog/')), [`backlog/${APP}/first.json`]);
  assert.equal(existsSync(path.join(a.clone, `backlog/${APP}/third.json`)), false, 'the reset keeps a change that was not pushed');
});

test('when git cannot check whether the remote lost commits, ledger store sync says so and does not report lost commits', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'first', '--goal', 'First.');
  ledgerOk(a, 'store', 'sync');
  const older = remoteHead(bare);
  ledgerOk(a, 'task', 'new', 'second', '--goal', 'Second.');
  ledgerOk(a, 'store', 'sync');
  git(path.dirname(bare), bare, 'update-ref', 'refs/heads/main', older);
  const stubs = path.join(a.h, 'failing-git');
  mkdirSync(stubs);
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path.join(stubs, 'git'), `#!/bin/sh\ncase " $* " in *" merge-base --is-ancestor "*) echo "fatal: stub" >&2; exit 128 ;; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });

  const output = failed(run(a, ['store', 'sync'], { env: { ...quietEnv(a), PATH: `${stubs}${path.delimiter}${quietEnv(a).PATH ?? ''}` } }));

  assert.doesNotMatch(output, /lost commits that/);
  assert.match(output, /Could not check whether \S+ lost commits/);
  assert.equal(JSON.parse(readFileSync(a.status, 'utf8')).problem, 'git');
  assert.equal(remoteHead(bare), older);
});

test('a branch other than the one the clone pushes to, which the remote moved back, does not stop ledger store sync', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'first', '--goal', 'First.');
  ledgerOk(a, 'store', 'sync');
  const older = remoteHead(bare);
  ledgerOk(a, 'task', 'new', 'second', '--goal', 'Second.');
  ledgerOk(a, 'store', 'sync');
  git(path.dirname(bare), bare, 'update-ref', 'refs/heads/side', remoteHead(bare));
  ledgerOk(a, 'store', 'sync');
  assert.equal(git(a.h, a.clone, 'rev-parse', 'refs/remotes/origin/side'), remoteHead(bare), 'the clone did not fetch side');
  git(path.dirname(bare), bare, 'update-ref', 'refs/heads/side', older);
  ledgerOk(a, 'task', 'new', 'third', '--goal', 'Third.');

  ledgerOk(a, 'store', 'sync');

  assert.ok(remoteFiles(bare).includes(`backlog/${APP}/third.json`));
  assert.equal(git(a.h, a.clone, 'rev-parse', 'refs/remotes/origin/main'), remoteHead(bare));
});

test('when the remote lacks the branch the clone pushes to and another branch lost commits, ledger store sync says the branch is missing, and its advice pushes the branch again', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'first', '--goal', 'First.');
  ledgerOk(a, 'store', 'sync');
  const older = remoteHead(bare);
  ledgerOk(a, 'task', 'new', 'second', '--goal', 'Second.');
  ledgerOk(a, 'store', 'sync');
  git(path.dirname(bare), bare, 'update-ref', 'refs/heads/side', remoteHead(bare));
  ledgerOk(a, 'store', 'sync');
  git(path.dirname(bare), bare, 'update-ref', 'refs/heads/side', older);
  git(path.dirname(bare), bare, 'update-ref', '-d', 'refs/heads/main');

  const output = failed(run(a, ['store', 'sync']));

  assert.doesNotMatch(output, /Could not reach/);
  assert.match(output, /has no branch main, which this clone pushes to/);
  assert.match(output, /run git fetch --force origin in \S+, then ledger store sync/);
  assert.notEqual(JSON.parse(readFileSync(a.status, 'utf8')).problem, 'network');
  git(a.h, a.clone, 'fetch', '--quiet', '--force', 'origin');
  ledgerOk(a, 'store', 'sync');
  assert.equal(remoteHead(bare), git(a.h, a.clone, 'rev-parse', 'HEAD'));
});

// --- Repo keys (LLP 0001 D10) in git storage ---

const gitAliases = (m: Machine): string => path.join(m.h, '.claude/ledger-aliases-git.json');

const openGit = (m: Machine): LedgerStore => gitStore(ledgerPaths(m.h), { backgroundSync: false });

test('git storage keeps repo aliases in ~/.claude/ledger-aliases-git.json, apart from those of file storage, and pushes none', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const store = openGit(a);
  store.aliases.add('app', APP_KEY);
  store.close?.();

  const reopened = openGit(a);
  t.after(() => reopened.close?.());
  assert.deepEqual([...reopened.aliases.read()], [['app', APP_KEY]]);
  assert.deepEqual(JSON.parse(readFileSync(gitAliases(a), 'utf8')), { app: APP_KEY });
  assert.equal(fileStore(ledgerPaths(a.h)).aliases.read().size, 0);
  ledgerOk(a, 'store', 'sync');
  assert.deepEqual(remoteFiles(bare).filter((file) => file.includes('alias')), []);

  reopened.aliases.remove('app', APP_KEY);
  assert.equal(reopened.aliases.read().size, 0);
  writeFileSync(gitAliases(a), '[]\n');
  assert.match(reopened.aliases.problem() ?? '', /ledger-aliases-git\.json is not a JSON object of repo aliases/);
});

test('git storage files a task under its repo key, URI-encoded as one folder, and pushes it there', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);

  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  ledgerOk(a, 'store', 'sync');

  assert.ok(remoteFiles(bare).includes(`backlog/${APP}/fix-login.json`), remoteFiles(bare).join('\n'));
});

test('git storage refuses to write through the folder of a repo key that is a symbolic link', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const outside = path.join(a.h, 'outside');
  mkdirSync(outside);
  mkdirSync(path.join(a.clone, 'backlog'), { recursive: true });
  symlinkSync(outside, path.join(a.clone, 'backlog', APP));

  const ran = run(a, ['task', 'new', 'fix-login', '--goal', 'Users cannot log in.']);

  assert.equal(ran.status, 1, ran.stdout);
  assert.match(ran.stderr, /symbolic link/);
  assert.deepEqual(readdirSync(outside), []);
});

test('git storage lists evidence in ~/.claude/ledger-evidence that has no archive copy as orphan evidence', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const left = path.join(a.h, '.claude/ledger-evidence/app/2026-01-02-gone');
  mkdirSync(left, { recursive: true });
  writeFileSync(path.join(left, 'red.txt'), 'failing\n');

  const store = openGit(a);
  t.after(() => store.close?.());

  assert.deepEqual(store.archive.orphanEvidence(), [{ repo: 'app', name: '2026-01-02-gone' }]);
});

test('ledger store migrate --repo-ids with git storage moves clone ledgers and their evidence to the repo key, commits and pushes the move, and keeps the alias out of the clone', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  const evidence = path.join(a.h, 'evidence');
  mkdirSync(evidence);
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  const store = openGit(a);
  store.backlog.write('app', 'idea', ledgerText({ slug: 'idea', main: a.app }));
  store.archive.write('app', '2026-01-01-old', ledgerText({ slug: 'old', main: a.app }), evidence);
  store.close?.();
  ledgerOk(a, 'store', 'sync');
  assert.ok(remoteFiles(bare).includes('backlog/app/idea.json'));

  ledgerOk(a, 'store', 'migrate', '--repo-ids');
  ledgerOk(a, 'store', 'sync');

  const ledgers = remoteFiles(bare).filter((file) => /^(backlog|archive)\//.test(file));
  assert.deepEqual(ledgers, [`archive/${APP}/2026-01-01-old.json`, `backlog/${APP}/idea.json`]);
  assert.equal(git(a.h, a.clone, 'status', '--porcelain'), '');
  assert.equal(readFileSync(path.join(a.h, '.claude/ledger-evidence', APP, '2026-01-01-old/red.txt'), 'utf8'), 'failing\n');
  assert.equal(existsSync(path.join(a.h, '.claude/ledger-evidence/app')), false);
  assert.deepEqual(JSON.parse(readFileSync(gitAliases(a), 'utf8')), { app: APP_KEY });
});

test('migrate file → git copies the repo aliases into git storage, and a git storage alias that cannot be read stops it with nothing changed', (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  fileStore(ledgerPaths(a.h)).aliases.add('app', APP_KEY);
  ledgerOk(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  ok(run(a, ['store', 'sync', 'init', URL]));
  writeFileSync(gitAliases(a), '[]\n');

  assert.match(failed(run(a, ['store', 'migrate', '--to', 'git'])), /stopped, and nothing changed/);
  assert.equal(existsSync(path.join(a.clone, 'backlog', APP)), false);

  rmSync(gitAliases(a));
  ledgerOk(a, 'store', 'migrate', '--to', 'git');

  assert.deepEqual(JSON.parse(readFileSync(gitAliases(a), 'utf8')), { app: APP_KEY });
  assert.ok(remoteFiles(bare).includes(`backlog/${APP}/fix-login.json`));
  assert.deepEqual(remoteFiles(bare).filter((file) => file.includes('alias')), []);
});
