import assert from 'node:assert/strict';
import test from 'node:test';
import { Failure } from '../tools/ledger/failure.js';
import { parseLedger } from '../tools/ledger/format.js';
import { checkTransition, stateOf, type ActiveState } from '../tools/ledger/states.js';
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

test('a done task can become nothing else here; the refusal says to finalize it with /ledger:retire', () => {
  for (const to of STATES) assert.equal(refusal('done', to), `epic is done, so it cannot become ${to}. Finalize it with /ledger:retire epic.`);
});

test('stateOf reads the status line, a lost mark over it, and active for neither', () => {
  const located = (...bullets: string[]) => parseLedger(ledgerText({ slug: 'epic', worktree: '/repos/app/.claude/worktrees/epic' }).replace('- design refs: none', ['- design refs: none', ...bullets].join('\n'))).location;
  assert.equal(stateOf(located()), 'active');
  assert.equal(stateOf(located('- status: blocked 2026-11-20 — the API')), 'blocked');
  assert.equal(stateOf(located('- status: waiting 2026-11-20', '- lost: 2026-11-22 — folder /repos/app/.claude/worktrees/epic not found')), 'lost');
});
