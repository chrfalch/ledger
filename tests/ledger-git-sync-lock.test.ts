import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { commandEnv, git } from './ledger-core-fixtures.js';
import { APP, failed, ledgerOk, machine, remote, remoteFiles, remoteHead, run, setUp, type Machine } from './ledger-git-fixtures.js';

const MINUTE_MS = 60_000;

/** A machine whose first ledger is committed and pushed. */
function synced(t: TestContext): Machine {
  const m = machine(t, remote(t));
  setUp(m);
  ledgerOk(m, 'task', 'new', 'first', '--goal', 'First.');
  ledgerOk(m, 'store', 'sync');
  return m;
}

/** A lock file at `name` in the clone, as a git that stopped `ageMs` ago left it. */
function leaveLock(m: Machine, name: string, ageMs = 10 * MINUTE_MS): string {
  const lock = path.join(m.clone, name);
  mkdirSync(path.dirname(lock), { recursive: true });
  writeFileSync(lock, '');
  ageLock(lock, ageMs);
  return lock;
}

function ageLock(lock: string, ageMs: number): void {
  const at = new Date(Date.now() - ageMs);
  utimesSync(lock, at, at);
}

const branchLock = (m: Machine): string => `.git/refs/heads/${git(m.h, m.clone, 'symbolic-ref', '--short', 'HEAD')}.lock`;

/**
 * A ledger `later` written while `name` was a fresh lock, so its commit failed and it waits uncommitted for a sync, as
 * after a git stopped at a deadline; then the lock ages to `ageMs`.
 */
function writtenBehindLock(m: Machine, name: string, ageMs?: number): string {
  const lock = leaveLock(m, name, 0);
  const ran = run(m, ['task', 'new', 'later', '--goal', 'Comes later.']);
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stderr, /not committed/);
  if (ageMs !== undefined) ageLock(lock, ageMs);
  return lock;
}

const laterOnRemote = (m: Machine): boolean => remoteFiles(m.bare).includes(`backlog/${APP}/later.json`);

const removedLines = (output: string, name: string): string[] =>
  output.split('\n').filter((line) => new RegExp(`Removed ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} from ~/\\.claude/ledger-data, left by a git that stopped at .+; no git is running there\\.`).test(line));

/** A sync that kept the lock: exit 1, the lock still there, nothing new committed or pushed, and the wait-then-sync advice. */
function assertKept(m: Machine, lock: string, before: { head: string; pushed: string }): string {
  const output = failed(run(m, ['store', 'sync']));
  assert.ok(existsSync(lock), 'the lock was removed');
  assert.equal(git(m.h, m.clone, 'rev-parse', 'HEAD'), before.head, 'the sync committed');
  assert.equal(remoteHead(m.bare), before.pushed, 'the sync pushed');
  assert.match(output, /\.git\/index\.lock/);
  assert.match(output, /nothing was committed or pushed/);
  assert.match(output, /ledger store sync/);
  assert.doesNotMatch(output, /git failed|Unable to create/);
  return output;
}

const tips = (m: Machine): { head: string; pushed: string } => ({ head: git(m.h, m.clone, 'rev-parse', 'HEAD'), pushed: remoteHead(m.bare) });

/** `child` once it printed "ready"; it is killed when the test ends. */
async function ready(t: TestContext, child: ChildProcess): Promise<void> {
  t.after(() => {
    child.kill('SIGKILL');
  });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('ready')) resolve();
    });
    child.on('exit', () => reject(new Error('the process exited before it was ready')));
  });
}

// ----------------------------------------------------------------------------------------------------- stale lock cleared

test('ledger store sync removes a .git/index.lock left 10 minutes ago, says so once, then commits and pushes', (t) => {
  const m = synced(t);
  const lock = writtenBehindLock(m, '.git/index.lock', 10 * MINUTE_MS);

  const ran = run(m, ['store', 'sync']);

  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(removedLines(`${ran.stdout}${ran.stderr}`, '.git/index.lock').length, 1, `one removal line expected:\n${ran.stdout}${ran.stderr}`);
  assert.equal(existsSync(lock), false);
  assert.ok(laterOnRemote(m), 'the ledger written behind the lock is not on the remote');
  assert.equal(git(m.h, m.clone, 'rev-parse', 'HEAD'), remoteHead(m.bare));
});

test('a ledger write removes a .git/index.lock left 10 minutes ago and commits', (t) => {
  const m = synced(t);
  const lock = leaveLock(m, '.git/index.lock');
  const head = git(m.h, m.clone, 'rev-parse', 'HEAD');

  const ran = run(m, ['task', 'new', 'later', '--goal', 'Comes later.']);

  assert.equal(ran.status, 0, ran.stderr);
  assert.doesNotMatch(ran.stderr, /not committed/);
  assert.equal(existsSync(lock), false);
  assert.notEqual(git(m.h, m.clone, 'rev-parse', 'HEAD'), head, 'nothing was committed');
  assert.equal(git(m.h, m.clone, 'status', '--porcelain'), '');
});

test('ledger store sync removes a lock of the branch ref left 10 minutes ago, then commits and pushes', (t) => {
  const m = synced(t);
  const name = branchLock(m);
  const lock = writtenBehindLock(m, name, 10 * MINUTE_MS);

  const ran = run(m, ['store', 'sync']);

  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(removedLines(`${ran.stdout}${ran.stderr}`, name).length, 1, `one removal line expected:\n${ran.stdout}${ran.stderr}`);
  assert.equal(existsSync(lock), false);
  assert.ok(laterOnRemote(m), 'the ledger written behind the lock is not on the remote');
});

// --------------------------------------------------------------------------------------------------------- lock kept

test('ledger store sync keeps a fresh .git/index.lock, says how old it is and to wait, and commits nothing', (t) => {
  const m = synced(t);
  const lock = writtenBehindLock(m, '.git/index.lock');
  const before = tips(m);

  const output = assertKept(m, lock, before);

  assert.match(output, /is \d+ seconds? old/);
  assert.match(output, /[Ww]ait/);
  assert.doesNotMatch(output, /by hand|[Rr]emove it/);
  assert.equal(laterOnRemote(m), false);
});

test('ledger store sync keeps an old .git/index.lock that a running program holds open', async (t) => {
  const m = synced(t);
  const lock = leaveLock(m, '.git/index.lock');
  const holder = spawn(process.execPath, ['-e', `require('node:fs').openSync(${JSON.stringify(lock)}, 'r'); console.log('ready'); setInterval(() => {}, 1000);`], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await ready(t, holder);

  const output = assertKept(m, lock, tips(m));

  assert.match(output, /open in a running program/);
  assert.doesNotMatch(output, /by hand/);
});

test('ledger store sync keeps an old .git/index.lock while a git runs in the clone', async (t) => {
  const m = synced(t);
  const lock = leaveLock(m, '.git/index.lock');
  // hash-object waits for its stdin to close, so this git runs in the clone until the test kills it.
  const running = spawn('git', ['hash-object', '--stdin'], { cwd: m.clone, env: commandEnv(m.h), stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => {
    running.kill('SIGKILL');
  });
  await once(running, 'spawn');

  const output = assertKept(m, lock, tips(m));

  assert.match(output, /a git is running in ~\/\.claude\/ledger-data/);
  assert.match(output, /[Ww]ait for that git to finish/);
  assert.doesNotMatch(output, /by hand/);
});

test('ledger store sync keeps an old .git/index.lock when it cannot check for a running git, and says it may be removed by hand', (t) => {
  const m = synced(t);
  const lock = leaveLock(m, '.git/index.lock');
  const lsof = path.join(m.h, 'stub-bin/lsof');
  writeFileSync(lsof, '#!/bin/sh\necho "lsof: cannot read the process table" >&2\nexit 2\n');
  chmodSync(lsof, 0o755);

  const output = assertKept(m, lock, tips(m));

  assert.match(output, /could not check for a running git/);
  assert.match(output, /by hand/);
  assert.match(output, /An agent does not run these git steps: it asks the operator to run them in a terminal\./);
});

test('a sync and a ledger write with no git lock file in the clone never run lsof', (t) => {
  const m = synced(t);
  const lsof = path.join(m.h, 'stub-bin/lsof');
  const calls = path.join(m.h, 'lsof-calls');
  writeFileSync(lsof, `#!/bin/sh\necho "$*" >> "${calls}"\nexit 1\n`);
  chmodSync(lsof, 0o755);

  ledgerOk(m, 'task', 'new', 'later', '--goal', 'Comes later.');
  ledgerOk(m, 'store', 'sync');

  assert.ok(laterOnRemote(m));
  assert.equal(existsSync(calls), false, 'lsof ran');
});
