import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrCheck } from '../tools/ledger/git.js';
import { prCheckLines, prOutcome } from '../tools/ledger/pr-check.js';
import type { Task } from '../tools/ledger/tasks.js';
import type { Context } from '../tools/ledger/write.js';

// D20: what the PR of a waiting task asks of it.

const run = (conclusion: string, state = ''): PrCheck => ({ conclusion, state });
const status = (state: string): PrCheck => ({ conclusion: '', state });
const outcome = (checks: PrCheck[], reviewDecision = '', state = 'OPEN') => prOutcome({ state, reviewDecision, checks });
const checksFailed = { kind: 'fix', checksFailed: true, changesRequested: false };

test('a merged or closed PR is that, whatever its checks and review say', () => {
  assert.deepEqual(outcome([run('FAILURE')], 'CHANGES_REQUESTED', 'MERGED'), { kind: 'merged' });
  assert.deepEqual(outcome([run('FAILURE')], 'CHANGES_REQUESTED', 'CLOSED'), { kind: 'closed' });
});

test('each failed conclusion of a check run, and a failed or errored commit status, fails the checks', () => {
  for (const check of ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].map((conclusion) => run(conclusion)).concat(status('FAILURE'), status('ERROR'))) {
    assert.deepEqual(outcome([run('SUCCESS'), check]), checksFailed, JSON.stringify(check));
  }
});

test('a review that asks for changes needs a fix, alone or with failed checks', () => {
  assert.deepEqual(outcome([run('SUCCESS')], 'CHANGES_REQUESTED'), { kind: 'fix', checksFailed: false, changesRequested: true });
  assert.deepEqual(outcome([status('ERROR')], 'CHANGES_REQUESTED'), { kind: 'fix', checksFailed: true, changesRequested: true });
});

test('a PR whose checks all passed, or that has none, is ready once approved or when no review is required', () => {
  for (const reviewDecision of ['APPROVED', '']) {
    assert.deepEqual(outcome([run('SUCCESS'), run('NEUTRAL'), run('SKIPPED'), status('SUCCESS')], reviewDecision), { kind: 'ready' }, reviewDecision);
    assert.deepEqual(outcome([], reviewDecision), { kind: 'ready' }, reviewDecision);
  }
});

test('a check still running, a stale or expected one, or a review still required leaves the PR pending', () => {
  for (const check of [run('', 'IN_PROGRESS'), run('', 'QUEUED'), run('STALE'), status('PENDING'), status('EXPECTED')]) {
    assert.deepEqual(outcome([run('SUCCESS'), check]), { kind: 'pending' }, JSON.stringify(check));
  }
  assert.deepEqual(outcome([run('SUCCESS')], 'REVIEW_REQUIRED'), { kind: 'pending' });
});

/** Throws on every read, as a store or record that cannot be read would. */
const unreadable = <T extends object>(): T =>
  new Proxy({} as T, {
    get: () => {
      throw new Error('it cannot be read.');
    },
  });

test('the PR check never throws: a failure before gh answers is one line', () => {
  for (const own of [false, true]) {
    const task = unreadable<Task>();
    assert.deepEqual(prCheckLines(unreadable<Context>(), { tasks: [task], own }, [task]), [{ text: 'Could not check the PRs of the waiting tasks (it cannot be read).' }], String(own));
  }
});
