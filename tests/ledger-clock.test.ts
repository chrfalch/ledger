import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Clock } from '../tools/ledger/clock.js';
import { limitHookTimeForTests } from '../tools/ledger/hooks.js';
import { limitLockWaitForTests, lockFile, reclaimGuard, withLock, withLockIfFree } from '../tools/ledger/lock.js';
import { limitPrCheckTimeForTests } from '../tools/ledger/pr-check.js';
import { inRun } from '../tools/ledger/run-io.js';
import { limitBusyWaitForTests } from '../tools/ledger/sqlite-store.js';
import { allowRemoteForTests } from '../tools/ledger/sync.js';
import { fakeClock, fakeRepository, fakeWorktreeTask, home, ok, readLedgerFile, runInProcessWith, useFakeGit } from './ledger-core-fixtures.js';
import { machine, remote, URL, useGitStorage } from './ledger-git-fixtures.js';

const MINUTE = 60_000;
const LATER = '2030-06-15T12:00:00Z';

/** ~/repos/app with the active task fix-login; gives the HOME, the repo and the task's record. */
function appWithTask(t: TestContext) {
  const h = home(t);
  const fake = useFakeGit(t);
  const app = fakeRepository(fake, h, path.join(h, 'repos/app'));
  return { h, app, file: fakeWorktreeTask(fake, h, app, { slug: 'fix-login' }) };
}

const atClock = <T>(clock: Clock, work: () => T): T => inRun({ env: process.env, console, clock }, work);

const holderText = (since: string): string => JSON.stringify({ pid: process.pid, since, nonce: 'test' });

test('a claim stays live until the clock passes its expiry, and expires after it, with no waiting', async (t) => {
  const { h, app } = appWithTask(t);
  const clock = fakeClock(LATER);
  const claim = (session: string): Promise<number | null> => runInProcessWith(h, app, { clock }, 'task', 'claim', 'fix-login', '--session', session).then((ran) => ran.status);
  assert.equal(await claim('s1'), 0);
  clock.advance(119 * MINUTE);
  assert.equal(await claim('s2'), 3, 'one minute before the claim of s1 expires');
  clock.advance(2 * MINUTE);
  assert.equal(await claim('s2'), 0, 'one minute after the claim of s1 expired');
});

test('a date a command writes is the clock\'s today, not the real one', async (t) => {
  const { h, app, file } = appWithTask(t);
  const clock = fakeClock(LATER);
  assert.equal(ok(await runInProcessWith(h, app, { clock }, 'notes', 'plan', 'approve', '--task', 'fix-login')), `Approved the plan of fix-login on ${clock.today()}.\n`);
  assert.match(readLedgerFile(file), new RegExp(`^## Plan \\(approved ${clock.today()}\\)$`, 'm'));
});

test('a lock names the time of the clock as since', (t) => {
  const target = path.join(home(t), 'record.json');
  const clock = fakeClock(LATER);
  const since = atClock(clock, () => withLock(target, () => (JSON.parse(readFileSync(lockFile(target), 'utf8')) as { since: string }).since));
  assert.equal(since, clock.now().toISOString());
});

test('a lock whose process still runs counts as left over once the clock passes a minute since it was taken', (t) => {
  const target = path.join(home(t), 'record.json');
  const taken = new Date().toISOString();
  writeFileSync(lockFile(target), holderText(taken));
  const clock = fakeClock(taken);
  const attempt = (): { value: string } | 'busy' => atClock(clock, () => withLockIfFree(target, () => 'ran'));
  assert.equal(attempt(), 'busy');
  clock.advance(MINUTE + 1_000);
  assert.deepEqual(attempt(), { value: 'ran' });
});

test('a reclaim guard whose process still runs counts as left over once the clock passes ten seconds since it was taken', (t) => {
  const target = path.join(home(t), 'record.json');
  const taken = new Date().toISOString();
  writeFileSync(lockFile(target), holderText(new Date(Date.parse(taken) - 2 * MINUTE).toISOString()));
  writeFileSync(reclaimGuard(lockFile(target)), holderText(taken));
  const clock = fakeClock(taken);
  assert.equal(
    atClock(clock, () => withLockIfFree(target, () => 'ran')),
    'busy',
    'a fresh guard keeps the left-over lock from being taken',
  );
  clock.advance(11_000);
  assert.equal(atClock(clock, () => withLock(target, () => 'ran', { waitMs: 1_000 })), 'ran');
});

test('a background sync asks gh again only once the clock passes a day since gh last said the repository is private', async (t) => {
  const m = machine(t, remote(t));
  allowRemoteForTests(m.bare);
  const clock = fakeClock(LATER);
  const ledger = async (...args: string[]): Promise<string> => ok(await runInProcessWith(m.h, m.app, { clock, env: { LEDGER_TEST_NO_BACKGROUND_SYNC: '1' } }, ...args));
  const calls = (): number => readFileSync(path.join(m.h, 'gh-calls'), 'utf8').trim().split('\n').length;
  await ledger('store', 'sync', 'init', URL);
  useGitStorage(m);
  const asked = calls();
  clock.advance(24 * 60 * MINUTE - MINUTE);
  await ledger('store', 'sync', '--quiet');
  assert.equal(calls(), asked, 'a minute before a day has passed');
  clock.advance(2 * MINUTE);
  await ledger('store', 'sync', '--quiet');
  assert.equal(calls(), asked + 1, 'a minute after a day has passed');
});

test('with no limit set for a test, a hook has 5 s, the PR check 3 s, and a wait for a lock or the database 5 s', () => {
  for (const [limit, production] of [
    [limitHookTimeForTests, 5000],
    [limitPrCheckTimeForTests, 3000],
    [limitLockWaitForTests, 5000],
    [limitBusyWaitForTests, 5000],
  ] as const) {
    const current = limit(1);
    limit(current);
    assert.equal(current, production, limit.name);
  }
});
