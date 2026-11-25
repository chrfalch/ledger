import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { buildGate, GATE_NAMES, gateQuestion, type GateDefinition, type GateQuestion } from '../tools/ledger/gates.js';
import { archivedTask, backlogTask, home, ledger, ledgerText, ok, putActive, readLedgerFile, repository, worktreeOf, worktreeTask, writeLedgerFile } from './ledger-core-fixtures.js';

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
  worktreeTask(h, app, { slug: 'fix-login' });
  const question = JSON.parse(ok(ledger(h, worktreeOf(app, 'fix-login'), 'task', 'gate', 'pr'))) as GateQuestion;
  assert.deepEqual(question, gateQuestion('pr', 'fix-login'));
});

test('ledger task gate in an untitled worktree ledger takes the folder slug', (t) => {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  const file = worktreeTask(h, app, { slug: 'fix-login' });
  writeLedgerFile(file, readLedgerFile(file).replace('# Task ledger — fix-login', '# Task ledger — <slug>'));
  const question = JSON.parse(ok(ledger(h, worktreeOf(app, 'fix-login'), 'task', 'gate', 'pr'))) as GateQuestion;
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

/** The finalize question `ledger task gate finalize [slug]` prints, run in `cwd`. */
function finalize(h: string, cwd: string, ...slug: string[]): GateQuestion {
  const question = JSON.parse(ok(ledger(h, cwd, 'task', 'gate', 'finalize', ...slug))) as GateQuestion;
  assertQuestionShape(question);
  assert.equal(question.header, 'Finalize');
  assert.equal(question.multiSelect, true);
  return question;
}

const description = (question: GateQuestion, label: string): string =>
  question.options.find((option) => option.label.replace(/ \(Recommended\)$/, '') === label)?.description ?? assert.fail(`no "${label}" option in ${labels(question).join(', ')}`);

/** Marks the task of the ledger `file` done, as the merged-PR check writes it. */
function markDone(file: string): void {
  writeLedgerFile(file, readLedgerFile(file).replace('- design refs: none', '- design refs: none\n- status: done 2026-11-20'));
}

function tree(t: TestContext) {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  return { h, app };
}

test('the finalize gate of a child with a sibling in the backlog offers to retire it, then to start the sibling', (t) => {
  const { h, app } = tree(t);
  backlogTask(h, app, { slug: 'epic', children: ['- part (started 2026-11-01)', '- next-part'] });
  worktreeTask(h, app, { slug: 'part', parent: 'epic' });
  backlogTask(h, app, { slug: 'next-part', parent: 'epic' });
  const question = finalize(h, app, 'part');
  assert.deepEqual(labels(question), ['Retire part (Recommended)', 'Start next-part', 'Close']);
  assert.equal(question.question, 'part is finished. What should happen next?');
  assert.match(description(question, 'Retire part'), /archive.*ledger.*worktree and branch.*dry run finds no problem/i);
  assert.match(description(question, 'Start next-part'), /`\/ledger:go next-part`.*after.*ticked retire/i);
});

test('the finalize gate of the last child offers to retire it, then to finalize the parent', (t) => {
  const { h, app } = tree(t);
  backlogTask(h, app, { slug: 'epic', children: ['- part (started 2026-11-01)', '- old-part (retired 2026-11-02)'] });
  worktreeTask(h, app, { slug: 'part', parent: 'epic' });
  archivedTask(h, app, '2026-11-02', { slug: 'old-part', parent: 'epic' });
  const question = finalize(h, app, 'part');
  assert.deepEqual(labels(question), ['Retire part (Recommended)', 'Finalize epic', 'Close']);
  assert.match(description(question, 'Finalize epic'), /epic has no child left.*asked again for epic/i);
});

test('the finalize gate groups the other done tasks of the repo into one action that names each', (t) => {
  const { h, app } = tree(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  markDone(worktreeTask(h, app, { slug: 'fix-logout' }));
  markDone(worktreeTask(h, app, { slug: 'fix-signup' }));
  worktreeTask(h, app, { slug: 'busy' });
  const question = finalize(h, app, 'fix-login');
  assert.deepEqual(labels(question), ['Retire fix-login (Recommended)', 'Retire the other done tasks', 'Close']);
  assert.equal(description(question, 'Retire the other done tasks'), 'Retire fix-logout and fix-signup, each after a dry run finds no problem.');
  assert.doesNotMatch(JSON.stringify(question), /busy/);
});

test('the finalize gate leaves out a done task whose worktree is on another machine, as it cannot be retired here', (t) => {
  const { h, app } = tree(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  markDone(worktreeTask(h, app, { slug: 'fix-signup' }));
  const remote = ledgerText({ slug: 'fix-logout', main: app, worktree: worktreeOf(app, 'fix-logout'), branch: 'me/fix-logout' });
  putActive(h, app, 'fix-logout', remote.replace('- design refs: none', '- design refs: none\n- host: other-mac\n- status: done 2026-11-20'));
  const question = finalize(h, app, 'fix-login');
  assert.equal(description(question, 'Retire the other done tasks'), 'Retire fix-signup after a dry run finds no problem.');
  assert.doesNotMatch(JSON.stringify(question), /fix-logout/);
});

test('the finalize gate leaves out the other done tasks when there are none, and never offers this task or its parent as one', (t) => {
  const { h, app } = tree(t);
  markDone(worktreeTask(h, app, { slug: 'epic', children: ['- part (started 2026-11-01)'] }));
  markDone(worktreeTask(h, app, { slug: 'part', parent: 'epic' }));
  worktreeTask(h, app, { slug: 'busy' });
  assert.deepEqual(labels(finalize(h, app, 'part')), ['Retire part (Recommended)', 'Finalize epic', 'Close']);
});

test('the finalize gate of a task with no parent says it is the top of its tree, and offers nothing up the tree', (t) => {
  const { h, app } = tree(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const question = finalize(h, app, 'fix-login');
  assert.deepEqual(labels(question), ['Retire fix-login (Recommended)', 'Close']);
  assert.match(question.question, /^fix-login is finished\. .*top of its tree.*retiring it finishes the tree\. What should happen next\?$/i);
});

test('the finalize gate says the session leaves the worktree first only when it runs inside the worktree it retires', (t) => {
  const { h, app } = tree(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const inside = finalize(h, worktreeOf(app, 'fix-login'));
  assert.match(inside.question, /^fix-login is finished\./);
  assert.match(description(inside, 'Retire fix-login'), /session leaves the worktree first/i);
  assert.doesNotMatch(description(finalize(h, app, 'fix-login'), 'Retire fix-login'), /leaves the worktree/i);
});

test('the finalize gate of a backlog task says retiring it archives the ledger, with no worktree to remove', (t) => {
  const { h, app } = tree(t);
  backlogTask(h, app, { slug: 'idea' });
  const retire = description(finalize(h, app, 'idea'), 'Retire idea');
  assert.match(retire, /archive.*ledger/i);
  assert.doesNotMatch(retire, /worktree|branch/i);
});

test('the finalize gate of a parent with a child not retired offers no retire, and starts its next child', (t) => {
  const { h, app } = tree(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- part (started 2026-11-01)', '- later'] });
  worktreeTask(h, app, { slug: 'part', parent: 'epic' });
  backlogTask(h, app, { slug: 'later', parent: 'epic' });
  assert.deepEqual(labels(finalize(h, app, 'epic')), ['Start later (Recommended)', 'Close']);
});

test('ledger task gate finalize with nothing to offer exits 1 with a plain message', (t) => {
  const { h, app } = tree(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- part (started 2026-11-01)'] });
  worktreeTask(h, app, { slug: 'part', parent: 'epic' });
  const ran = ledger(h, app, 'task', 'gate', 'finalize', 'epic');
  assert.equal(ran.status, 1);
  assert.equal(ran.stdout, '');
  assert.match(ran.stderr, /^epic has nothing left to finalize\./m);
});

test('ledger task gate finalize outside a task, with no slug, says to name one', (t) => {
  const { h } = tree(t);
  const ran = ledger(h, h, 'task', 'gate', 'finalize');
  assert.equal(ran.status, 1);
  assert.match(ran.stderr, /ledger task gate finalize <slug>/);
});

test('ledger task gate names the finalize gate in its help and when a name is unknown', (t) => {
  const h = home(t);
  assert.match(ok(ledger(h, h, 'task', 'gate', '--help')), /plan, pr, abandon, finalize/);
  assert.match(ledger(h, h, 'task', 'gate', 'merge').stderr, /plan, pr, abandon, finalize/);
});

test('the abandon gate asks to abandon the task, offers Abandon task, Not yet and Close, and closes as the plan gate does', () => {
  assert.ok(GATE_NAMES.includes('abandon'));
  const question = gateQuestion('abandon', 'fix-login');
  assertQuestionShape(question);
  assert.equal(question.question, 'Abandon fix-login? Its ledger is archived and nothing is merged.');
  assert.equal(question.header, 'Abandon');
  assert.equal(question.multiSelect, false);
  assert.deepEqual(labels(question), ['Abandon task (Recommended)', 'Not yet', 'Close']);
  assert.equal(question.options.at(-1)?.description, gateQuestion('plan').options.at(-1)?.description);
  assert.equal(gateQuestion('abandon').question, 'Abandon this task? Its ledger is archived and nothing is merged.');
});

test('ledger task gate abandon prints the abandon question for the task of the worktree it runs in', (t) => {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  worktreeTask(h, app, { slug: 'fix-login' });
  const question = JSON.parse(ok(ledger(h, worktreeOf(app, 'fix-login'), 'task', 'gate', 'abandon'))) as GateQuestion;
  assert.deepEqual(question, gateQuestion('abandon', 'fix-login'));
  assert.deepEqual(JSON.parse(ok(ledger(h, h, 'task', 'gate', 'abandon', 'fix-login'))), question);
});
