import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildGate, GATE_NAMES, gateQuestion, type GateDefinition, type GateQuestion } from '../tools/ledger/gates.js';
import { home, ledger, ok, repository, worktreeTask } from './ledger-core-fixtures.js';

const pick: GateDefinition = {
  name: 'pick',
  header: 'Pick',
  question: (task) => `What should run next for ${task}?`,
  multiSelect: false,
  actions: [
    { label: 'First', description: 'Run the first thing.' },
    { label: 'Second', description: 'Run the second thing.' },
  ],
};

const labels = ({ options }: GateQuestion): string[] => options.map(({ label }) => label);

function assertQuestionShape(question: GateQuestion): void {
  assert.deepEqual(Object.keys(question).sort(), ['header', 'multiSelect', 'options', 'question']);
  assert.equal(typeof question.question, 'string');
  assert.equal(typeof question.multiSelect, 'boolean');
  assert.ok(question.header.length > 0 && question.header.length <= 12, `header "${question.header}" has 1 to 12 characters`);
  assert.ok(question.options.length >= 2 && question.options.length <= 4, `${question.options.length} options`);
  for (const option of question.options) {
    assert.deepEqual(Object.keys(option).sort(), ['description', 'label']);
    assert.notEqual(option.label.trim(), '');
    assert.notEqual(option.description.trim(), '');
    assert.doesNotMatch(option.description, /\n/, `"${option.label}" has a one-line description`);
  }
}

test('the registry has the plan and pr gates', () => {
  assert.ok(GATE_NAMES.includes('plan'));
  assert.ok(GATE_NAMES.includes('pr'));
});

test('the plan gate offers Approve plan, Change plan and Close', () => {
  const question = gateQuestion('plan', 'fix-login');
  assertQuestionShape(question);
  assert.equal(question.multiSelect, false);
  assert.deepEqual(labels(question), ['Approve plan (Recommended)', 'Change plan', 'Close']);
  assert.match(question.question, /fix-login/);
});

test('the pr gate offers Commit, push and open the PR, Not yet and Close', () => {
  const question = gateQuestion('pr', 'fix-login');
  assertQuestionShape(question);
  assert.equal(question.multiSelect, false);
  assert.deepEqual(labels(question), ['Commit, push and open the PR (Recommended)', 'Not yet', 'Close']);
  assert.match(question.question, /fix-login/);
});

test('without a slug, each gate question still names its subject and stands alone', () => {
  for (const name of GATE_NAMES) {
    const { question } = gateQuestion(name);
    assert.doesNotMatch(question, /undefined/, name);
    assert.match(question, /this task/, name);
  }
  assert.match(gateQuestion('plan').question, /plan/);
  assert.match(gateQuestion('pr').question, /pull request/);
});

test('every gate header fits the widget: 12 characters at most', () => {
  for (const name of GATE_NAMES) assert.ok(gateQuestion(name).header.length <= 12, name);
});

test('the builder appends Close last, after the actions in their order', () => {
  const question = buildGate(pick, 'fix-login');
  assert.deepEqual(labels(question), ['First (Recommended)', 'Second', 'Close']);
  assert.equal(question.question, 'What should run next for fix-login?');
  assert.equal(buildGate(pick).question, 'What should run next for this task?');
});

test('only the first action carries "(Recommended)"', () => {
  for (const question of [buildGate(pick), ...GATE_NAMES.map((name) => gateQuestion(name))]) {
    const [first, ...rest] = labels(question);
    assert.match(first, / \(Recommended\)$/);
    for (const label of rest) assert.doesNotMatch(label, /Recommended/);
  }
});

test('the single-select Close saves where the task stands and stops, and runs nothing else', () => {
  const close = buildGate(pick).options.at(-1);
  assert.equal(close?.label, 'Close');
  assert.match(close?.description ?? '', /save where the task stands and stop/i);
  assert.match(close?.description ?? '', /nothing else runs/i);
});

test('the multi-select Close says ticked options run first, and alone it only stops', () => {
  const question = buildGate({ ...pick, multiSelect: true, actions: [...pick.actions, { label: 'Third', description: 'Run the third thing.' }] });
  assertQuestionShape(question);
  assert.equal(question.multiSelect, true);
  assert.deepEqual(labels(question), ['First (Recommended)', 'Second', 'Third', 'Close']);
  const close = question.options.at(-1)?.description ?? '';
  assert.match(close, /save where the task stands and stop/i);
  assert.match(close, /other ticked options run first/i);
  assert.match(close, /ticked alone, nothing else runs/i);
});

test('a gate with more than three actions, or none, is refused', () => {
  const action = { label: 'More', description: 'Run one more thing.' };
  assert.throws(() => buildGate({ ...pick, actions: [action, action, action, action] }), /at most three actions/);
  assert.throws(() => buildGate({ ...pick, actions: [] }), /at least one action/);
});

test('an action with an empty label or description is refused', () => {
  assert.throws(() => buildGate({ ...pick, actions: [{ label: '', description: 'Run it.' }] }), /label/);
  assert.throws(() => buildGate({ ...pick, actions: [{ label: 'Run', description: '  ' }] }), /description/);
  assert.throws(() => buildGate({ ...pick, actions: [{ label: 'Run', description: 'One line.\nTwo lines.' }] }), /one line/);
});

test('no Close description mentions the ledger', () => {
  for (const question of [buildGate(pick), buildGate({ ...pick, multiSelect: true })]) {
    assert.doesNotMatch(question.options.at(-1)?.description ?? '', /ledger/i);
  }
});

test('a description with a carriage return is refused', () => {
  assert.throws(() => buildGate({ ...pick, actions: [{ label: 'Run', description: 'One line.\rTwo lines.' }] }), /one line/);
});

test('each build returns fresh options: changing one result leaves the next build alone', () => {
  for (const multiSelect of [false, true]) {
    const gate: GateDefinition = { ...pick, multiSelect, actions: pick.actions.map((action) => ({ ...action })) };
    const first = buildGate(gate);
    const expected = structuredClone(first);
    for (const option of first.options) option.description = 'Changed.';
    first.options.push({ label: 'Extra', description: 'Added.' });
    assert.deepEqual(buildGate(gate), expected, `multiSelect ${multiSelect}`);
  }
});

test('a header longer than 12 characters is refused', () => {
  assert.throws(() => buildGate({ ...pick, header: 'Thirteen char' }), /12 characters/);
});

test('ledger task gate plan prints one AskUserQuestion question as JSON', (t) => {
  const h = home(t);
  const question = JSON.parse(ok(ledger(h, h, 'task', 'gate', 'plan', 'fix-login'))) as GateQuestion;
  assertQuestionShape(question);
  assert.deepEqual(question, gateQuestion('plan', 'fix-login'));
});

test('ledger task gate takes the slug of the worktree it runs in', (t) => {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  const file = worktreeTask(h, app, { slug: 'fix-login' });
  const question = JSON.parse(ok(ledger(h, path.dirname(path.dirname(file)), 'task', 'gate', 'pr'))) as GateQuestion;
  assert.deepEqual(question, gateQuestion('pr', 'fix-login'));
});

test('ledger task gate in an untitled worktree ledger takes the folder slug', (t) => {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  const file = worktreeTask(h, app, { slug: 'fix-login' });
  writeFileSync(file, readFileSync(file, 'utf8').replace('# Task ledger — fix-login', '# Task ledger — <slug>'));
  const question = JSON.parse(ok(ledger(h, path.dirname(path.dirname(file)), 'task', 'gate', 'pr'))) as GateQuestion;
  assert.deepEqual(question, gateQuestion('pr', 'fix-login'));
});

test('ledger task gate outside a task asks about this task', (t) => {
  const h = home(t);
  const question = JSON.parse(ok(ledger(h, h, 'task', 'gate', 'plan'))) as GateQuestion;
  assert.deepEqual(question, gateQuestion('plan'));
});

test('ledger task gate with an unknown name exits 1 and lists the gates', (t) => {
  const h = home(t);
  const ran = ledger(h, h, 'task', 'gate', 'merge');
  assert.equal(ran.status, 1);
  assert.equal(ran.stdout, '');
  assert.match(ran.stderr, /"merge"/);
  assert.match(ran.stderr, /plan, pr/);
});
