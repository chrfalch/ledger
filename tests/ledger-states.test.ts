import assert from 'node:assert/strict';
import test from 'node:test';
import { Failure } from '../tools/ledger/failure.js';
import { parseLedger } from '../tools/ledger/format.js';
import { checkPrLink, checkTransition, stateOf, type ActiveState } from '../tools/ledger/states.js';
import { ledgerText } from './ledger-core-fixtures.js';

// LLP 0001 section 5.1, the states inside active; done leaves only by retire, which is no move between these.
const NEXT: Record<ActiveState, ActiveState[]> = {
  active: ['parked', 'blocked', 'waiting', 'done', 'lost'],
  parked: ['active'],
  blocked: ['active'],
  waiting: ['active', 'done'],
  lost: ['active'],
  done: [],
};
const STATES = Object.keys(NEXT) as ActiveState[];

const refusal = (from: ActiveState, to: ActiveState): string => {
  try {
    checkTransition('epic', from, to);
  } catch (error) {
    assert.ok(error instanceof Failure, String(error));
    return error.message;
  }
  return assert.fail(`${from} → ${to} should be refused`);
};

test('checkTransition allows exactly the moves of the state table', () => {
  for (const from of STATES) for (const to of NEXT[from]) assert.doesNotThrow(() => checkTransition('epic', from, to), `${from} → ${to}`);
  for (const from of STATES) for (const to of STATES.filter((each) => !NEXT[from].includes(each))) refusal(from, to);
});

test('a refused move names the task, its state, the refused state and the states it can move to', () => {
  assert.equal(refusal('blocked', 'parked'), 'epic is blocked, so it cannot become parked. A blocked task can become active.');
  assert.equal(refusal('waiting', 'lost'), 'epic is waiting, so it cannot become lost. A waiting task can become active or done.');
  assert.equal(refusal('parked', 'parked'), 'epic is parked, so it cannot become parked. A parked task can become active.');
});

test('a done task can become nothing else here; the refusal says to finalize it with the finalize question', () => {
  for (const to of STATES) assert.equal(refusal('done', to), `epic is done, so it cannot become ${to}. Finalize it with the question from \`ledger task gate finalize epic\`.`);
});

test('stateOf reads the status line, a lost mark over it, and active for neither', () => {
  const located = (...bullets: string[]) => parseLedger(ledgerText({ slug: 'epic', worktree: '/repos/app/.claude/worktrees/epic' }).replace('- design refs: none', ['- design refs: none', ...bullets].join('\n'))).location;
  assert.equal(stateOf(located()), 'active');
  assert.equal(stateOf(located('- status: blocked 2026-11-20 — the API')), 'blocked');
  assert.equal(stateOf(located('- status: waiting 2026-11-20', '- lost: 2026-11-22 — folder /repos/app/.claude/worktrees/epic not found')), 'lost');
});

test('checkPrLink refuses a code task without a PR link, names ledger task pr, and lets any other task pass', () => {
  const message = 'epic is a code task without a PR link, so it cannot become waiting. Record the link first: ledger task pr <url>';
  for (const record of [{}, { kind: 'code' }]) {
    assert.throws(() => checkPrLink('epic', record), (error) => error instanceof Failure && error.message === message, JSON.stringify(record));
  }
  for (const record of [{ pr: 'https://github.com/acme/app/pull/1' }, { kind: 'code', pr: 'https://github.com/acme/app/pull/1' }, { kind: 'docs' }, { kind: 'investigation' }]) {
    assert.doesNotThrow(() => checkPrLink('epic', record), JSON.stringify(record));
  }
});
