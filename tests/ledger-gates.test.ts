import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { ALL_GATE_NAMES, buildGate, GATE_NAMES, gateQuestion, type GateDefinition, type GateQuestion } from '../tools/ledger/gates.js';
import type { LedgerStore } from '../tools/ledger/store.js';
import { archivedTask, backlogTask, git, home, ledgerText, ok, repoKeyOf, repository, runInProcessWith, worktreeOf, type Fields, type Ran } from './ledger-core-fixtures.js';
import { memoryStore } from './memory-store.js';

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
  assert.ok(ALL_GATE_NAMES.includes('plan'));
  assert.ok(GATE_NAMES.includes('pr'));
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
    assert.ok(gateQuestion(name).header.length <= 12, name);
  }
  assert.match(gateQuestion('pr').question, /pull request/);
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
  assert.throws(() => buildGate({ ...pick, actions: [{ label: 'Run', description: 'One line.\rTwo lines.' }] }), /one line/);
});

test('no Close description mentions the ledger', () => {
  for (const question of [buildGate(pick), buildGate({ ...pick, multiSelect: true })]) {
    assert.doesNotMatch(question.options.at(-1)?.description ?? '', /ledger/i);
  }
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

/** A HOME with a repo at repos/app whose ledgers are in a memory store. */
type Tree = { h: string; app: string; store: LedgerStore };

function tree(t: TestContext): Tree {
  const h = home(t);
  return { h, app: repository(h, path.join(h, 'repos/app')), store: memoryStore({ home: h }) };
}

const gate = ({ h, store }: Tree, cwd: string, ...args: string[]): Promise<Ran> => runInProcessWith(h, cwd, { store }, 'task', 'gate', ...args);

/** A linked worktree at <app>/.claude/worktrees/<slug> on branch me/<slug>, with its active record in the store; gives the record's location. */
function worktreeTask({ h, app, store }: Tree, fields: Omit<Fields, 'worktree' | 'branch' | 'base'>, edit = (text: string): string => text): string {
  const worktree = worktreeOf(app, fields.slug);
  git(h, app, 'worktree', 'add', '--quiet', '-b', `me/${fields.slug}`, worktree, 'main');
  const short = git(h, app, 'rev-parse', '--short', 'main');
  mkdirSync(path.join(worktree, '.claude'));
  return putActive({ h, app, store }, fields.slug, edit(ledgerText({ ...fields, worktree, branch: `me/${fields.slug}`, base: `origin/main @ ${short}` })));
}

function putActive({ app, store }: Tree, slug: string, markdown: string): string {
  const repo = repoKeyOf(app);
  assert.ok(store.active.create(repo, slug, markdown), `the active ledger ${slug} is taken`);
  return store.active.location(repo, slug);
}

/** A worktree task `fix-login` whose plan has `summary` and the steps whose numbers are in `steps`. */
function planned(t: TestContext, summary: string | undefined, steps = ['1', '2']) {
  const task = tree(t);
  worktreeTask(task, { slug: 'fix-login' }, (text) => {
    const kept = text
      .split('\n')
      .filter((line) => !/^\| \d+ \|/.test(line) || steps.some((n) => line.startsWith(`| ${n} |`)))
      .join('\n');
    return summary === undefined ? kept : kept.replace('## Plan (approved 2026-11-01)\n', `## Plan (approved 2026-11-01)\nSummary: ${summary}\n\n`);
  });
  return { ...task, worktree: worktreeOf(task.app, 'fix-login') };
}

test('ledger task gate plan asks to approve the plan by its summary and step count, with Approve plan, Change plan and Close', async (t) => {
  const task = planned(t, 'Edit gates.ts and notes.ts. Then test.');
  const question = JSON.parse(ok(await gate(task, task.worktree, 'plan'))) as GateQuestion;
  assertQuestionShape(question);
  assert.equal(question.question, 'Approve the plan for fix-login? Edit gates.ts and notes.ts. Then test. (2 steps)');
  assert.equal(question.header, 'Plan');
  assert.equal(question.multiSelect, false);
  assert.deepEqual(labels(question), ['Approve plan (Recommended)', 'Change plan', 'Close']);
  assert.equal(question.options.at(-1)?.description, gateQuestion('pr').options.at(-1)?.description);
  assert.deepEqual(JSON.parse(ok(await gate(task, task.app, 'plan', 'fix-login'))), question);
});

test('the plan gate counts one step as "1 step"', async (t) => {
  const task = planned(t, 'Ship it.', ['1']);
  const { question } = JSON.parse(ok(await gate(task, task.worktree, 'plan'))) as GateQuestion;
  assert.equal(question, 'Approve the plan for fix-login? Ship it. (1 step)');
});

test('ledger task gate plan refuses a plan with no summary, and names the command that sets one', async (t) => {
  const task = planned(t, undefined);
  const ran = await gate(task, task.worktree, 'plan');
  assert.equal(ran.status, 1);
  assert.equal(ran.stdout, '');
  assert.match(ran.stderr, /fix-login/);
  assert.match(ran.stderr, /ledger notes plan summary "<text>"/);
});

test('ledger task gate plan refuses a plan with no steps', async (t) => {
  const task = planned(t, 'Ship it.', []);
  const ran = await gate(task, task.worktree, 'plan');
  assert.equal(ran.status, 1);
  assert.equal(ran.stdout, '');
  assert.match(ran.stderr, /no steps/);
});

test('ledger task gate takes the slug of the worktree it runs in', async (t) => {
  const task = tree(t);
  worktreeTask(task, { slug: 'fix-login' });
  const question = JSON.parse(ok(await gate(task, worktreeOf(task.app, 'fix-login'), 'pr'))) as GateQuestion;
  assert.deepEqual(question, gateQuestion('pr', 'fix-login'));
});

test('ledger task gate in an untitled worktree ledger takes the folder slug', async (t) => {
  const task = tree(t);
  worktreeTask(task, { slug: 'fix-login' }, (text) => text.replace('# Task ledger — fix-login', '# Task ledger — <slug>'));
  const question = JSON.parse(ok(await gate(task, worktreeOf(task.app, 'fix-login'), 'pr'))) as GateQuestion;
  assert.deepEqual(question, gateQuestion('pr', 'fix-login'));
});

/** A HOME with no repo, whose ledgers are in a memory store. */
function bare(t: TestContext): Tree {
  const h = home(t);
  return { h, app: path.join(h, 'repos/app'), store: memoryStore({ home: h }) };
}

test('ledger task gate outside a task asks about this task', async (t) => {
  const task = bare(t);
  const question = JSON.parse(ok(await gate(task, task.h, 'pr'))) as GateQuestion;
  assert.deepEqual(question, gateQuestion('pr'));
});

test('ledger task gate plan outside a task, with no slug, says to name one', async (t) => {
  const task = bare(t);
  const ran = await gate(task, task.h, 'plan');
  assert.equal(ran.status, 1);
  assert.equal(ran.stdout, '');
  assert.match(ran.stderr, /ledger task gate plan <slug>/);
});

/** The finalize question `ledger task gate finalize [slug]` prints, run in `cwd`. */
async function finalize(task: Tree, cwd: string, ...slug: string[]): Promise<GateQuestion> {
  const question = JSON.parse(ok(await gate(task, cwd, 'finalize', ...slug))) as GateQuestion;
  assertQuestionShape(question);
  assert.equal(question.header, 'Finalize');
  assert.equal(question.multiSelect, true);
  return question;
}

const description = (question: GateQuestion, label: string): string =>
  question.options.find((option) => option.label.replace(/ \(Recommended\)$/, '') === label)?.description ?? assert.fail(`no "${label}" option in ${labels(question).join(', ')}`);

const done = (text: string): string => text.replace('- design refs: none', '- design refs: none\n- status: done 2026-11-20');

test('the finalize gate of a child with a sibling in the backlog offers to retire it, then to start the sibling', async (t) => {
  const task = tree(t);
  const { h, app, store } = task;
  backlogTask(h, app, { slug: 'epic', children: ['- part (started 2026-11-01)', '- next-part'] }, { store });
  worktreeTask(task, { slug: 'part', parent: 'epic' });
  backlogTask(h, app, { slug: 'next-part', parent: 'epic' }, { store });
  const question = await finalize(task, app, 'part');
  assert.deepEqual(labels(question), ['Retire part (Recommended)', 'Start next-part', 'Close']);
  assert.equal(question.question, 'part is finished. What should happen next?');
  assert.match(description(question, 'Retire part'), /archive.*ledger.*worktree and branch.*dry run finds no problem/i);
  assert.match(description(question, 'Start next-part'), /`\/ledger:go next-part`.*after.*ticked retire/i);
});

test('the finalize gate of the last child offers to retire it, then to finalize the parent', async (t) => {
  const task = tree(t);
  const { h, app, store } = task;
  backlogTask(h, app, { slug: 'epic', children: ['- part (started 2026-11-01)', '- old-part (retired 2026-11-02)'] }, { store });
  worktreeTask(task, { slug: 'part', parent: 'epic' });
  archivedTask(h, app, '2026-11-02', { slug: 'old-part', parent: 'epic' }, 'old-part', { store });
  const question = await finalize(task, app, 'part');
  assert.deepEqual(labels(question), ['Retire part (Recommended)', 'Finalize epic', 'Close']);
  assert.match(description(question, 'Finalize epic'), /epic has no child left.*asked again for epic/i);
});

test('the finalize gate groups the other done tasks of the repo into one action that names each', async (t) => {
  const task = tree(t);
  worktreeTask(task, { slug: 'fix-login' });
  worktreeTask(task, { slug: 'fix-logout' }, done);
  worktreeTask(task, { slug: 'fix-signup' }, done);
  worktreeTask(task, { slug: 'busy' });
  const question = await finalize(task, task.app, 'fix-login');
  assert.deepEqual(labels(question), ['Retire fix-login (Recommended)', 'Retire the other done tasks', 'Close']);
  assert.equal(description(question, 'Retire the other done tasks'), 'Retire fix-logout and fix-signup, each after a dry run finds no problem.');
  assert.doesNotMatch(JSON.stringify(question), /busy/);
});

test('the finalize gate leaves out a done task whose worktree is on another machine, as it cannot be retired here', async (t) => {
  const task = tree(t);
  const { app } = task;
  worktreeTask(task, { slug: 'fix-login' });
  worktreeTask(task, { slug: 'fix-signup' }, done);
  const remote = ledgerText({ slug: 'fix-logout', main: app, worktree: worktreeOf(app, 'fix-logout'), branch: 'me/fix-logout' });
  putActive(task, 'fix-logout', remote.replace('- design refs: none', '- design refs: none\n- host: other-mac\n- status: done 2026-11-20'));
  const question = await finalize(task, app, 'fix-login');
  assert.equal(description(question, 'Retire the other done tasks'), 'Retire fix-signup after a dry run finds no problem.');
  assert.doesNotMatch(JSON.stringify(question), /fix-logout/);
});

test('the finalize gate leaves out the other done tasks when there are none, and never offers this task or its parent as one', async (t) => {
  const task = tree(t);
  worktreeTask(task, { slug: 'epic', children: ['- part (started 2026-11-01)'] }, done);
  worktreeTask(task, { slug: 'part', parent: 'epic' }, done);
  worktreeTask(task, { slug: 'busy' });
  assert.deepEqual(labels(await finalize(task, task.app, 'part')), ['Retire part (Recommended)', 'Finalize epic', 'Close']);
});

test('the finalize gate of a task with no parent says it is the top of its tree, and offers nothing up the tree', async (t) => {
  const task = tree(t);
  worktreeTask(task, { slug: 'fix-login' });
  const question = await finalize(task, task.app, 'fix-login');
  assert.deepEqual(labels(question), ['Retire fix-login (Recommended)', 'Close']);
  assert.match(question.question, /^fix-login is finished\. .*top of its tree.*retiring it finishes the tree\. What should happen next\?$/i);
});

test('the finalize gate says the session leaves the worktree first only when it runs inside the worktree it retires', async (t) => {
  const task = tree(t);
  worktreeTask(task, { slug: 'fix-login' });
  const inside = await finalize(task, worktreeOf(task.app, 'fix-login'));
  assert.match(inside.question, /^fix-login is finished\./);
  assert.match(description(inside, 'Retire fix-login'), /session leaves the worktree first/i);
  assert.doesNotMatch(description(await finalize(task, task.app, 'fix-login'), 'Retire fix-login'), /leaves the worktree/i);
});

test('the finalize gate of a backlog task says retiring it archives the ledger, with no worktree to remove', async (t) => {
  const task = tree(t);
  backlogTask(task.h, task.app, { slug: 'idea' }, { store: task.store });
  const retire = description(await finalize(task, task.app, 'idea'), 'Retire idea');
  assert.match(retire, /archive.*ledger/i);
  assert.doesNotMatch(retire, /worktree|branch/i);
});

test('the finalize gate of a parent with a child not retired offers no retire, and starts its next child', async (t) => {
  const task = tree(t);
  worktreeTask(task, { slug: 'epic', children: ['- part (started 2026-11-01)', '- later'] });
  worktreeTask(task, { slug: 'part', parent: 'epic' });
  backlogTask(task.h, task.app, { slug: 'later', parent: 'epic' }, { store: task.store });
  assert.deepEqual(labels(await finalize(task, task.app, 'epic')), ['Start later (Recommended)', 'Close']);
});

test('ledger task gate finalize with nothing to offer exits 1 with a plain message', async (t) => {
  const task = tree(t);
  worktreeTask(task, { slug: 'epic', children: ['- part (started 2026-11-01)'] });
  worktreeTask(task, { slug: 'part', parent: 'epic' });
  const ran = await gate(task, task.app, 'finalize', 'epic');
  assert.equal(ran.status, 1);
  assert.equal(ran.stdout, '');
  assert.match(ran.stderr, /^epic has nothing left to finalize\./m);
});

test('ledger task gate finalize outside a task, with no slug, says to name one', async (t) => {
  const task = bare(t);
  const ran = await gate(task, task.h, 'finalize');
  assert.equal(ran.status, 1);
  assert.match(ran.stderr, /ledger task gate finalize <slug>/);
});

test('ledger task gate names the finalize gate in its help, and an unknown name exits 1 and lists the gates', async (t) => {
  const task = bare(t);
  assert.match(ok(await gate(task, task.h, '--help')), /plan, pr, merge, goal, abandon, finalize/);
  const ran = await gate(task, task.h, 'ship');
  assert.equal(ran.status, 1);
  assert.equal(ran.stdout, '');
  assert.match(ran.stderr, /"ship"/);
  assert.match(ran.stderr, /plan, pr, merge, goal, abandon, finalize/);
});

test('the abandon gate asks to abandon the task, offers Abandon task, Not yet and Close, and closes as the pr gate does', () => {
  assert.ok(GATE_NAMES.includes('abandon'));
  const question = gateQuestion('abandon', 'fix-login');
  assertQuestionShape(question);
  assert.equal(question.question, 'Abandon fix-login? Its ledger is archived and nothing is merged.');
  assert.equal(question.header, 'Abandon');
  assert.equal(question.multiSelect, false);
  assert.deepEqual(labels(question), ['Abandon task (Recommended)', 'Not yet', 'Close']);
  assert.equal(question.options.at(-1)?.description, gateQuestion('pr').options.at(-1)?.description);
  assert.equal(gateQuestion('abandon').question, 'Abandon this task? Its ledger is archived and nothing is merged.');
});

test('ledger task gate abandon prints the abandon question for the task of the worktree it runs in', async (t) => {
  const task = tree(t);
  worktreeTask(task, { slug: 'fix-login' });
  const question = JSON.parse(ok(await gate(task, worktreeOf(task.app, 'fix-login'), 'abandon'))) as GateQuestion;
  assert.deepEqual(question, gateQuestion('abandon', 'fix-login'));
  assert.deepEqual(JSON.parse(ok(await gate(task, task.h, 'abandon', 'fix-login'))), question);
});

const SINGLE_SELECT_CLOSE = { label: 'Close', description: 'Save where the task stands and stop. Nothing else runs.' };

test('ledger task gate merge asks to merge the PR that passed, with Merge now, Not yet and Close (D4)', () => {
  assert.deepEqual(gateQuestion('merge', 'fix-login'), {
    question: 'The PR of fix-login passed its checks and review. Merge it now?',
    header: 'Merge',
    multiSelect: false,
    options: [
      { label: 'Merge now (Recommended)', description: 'Merge the pull request. The task becomes done and the finalize question follows.' },
      { label: 'Not yet', description: 'Nothing is merged. The PR stays open and the task stays waiting.' },
      SINGLE_SELECT_CLOSE,
    ],
  });
  assert.equal(gateQuestion('merge').question, 'The PR of this task passed its checks and review. Merge it now?');
});

test('ledger task gate goal asks whether the goal of a task with no PR is met, with Goal met, Not yet and Close (D15)', () => {
  assert.deepEqual(gateQuestion('goal', 'fix-login'), {
    question: 'Every stage of fix-login has passed. Is its goal met?',
    header: 'Goal',
    multiSelect: false,
    options: [
      { label: 'Goal met (Recommended)', description: 'Mark the task done. The finalize question follows.' },
      { label: 'Not yet', description: 'The task stays active. Say what is left to do.' },
      SINGLE_SELECT_CLOSE,
    ],
  });
  assert.equal(gateQuestion('goal').question, 'Every stage of this task has passed. Is its goal met?');
});

test('the gates come in the order of the lifecycle: plan, pr, merge, goal, abandon', () => {
  assert.deepEqual(GATE_NAMES, ['plan', 'pr', 'merge', 'goal', 'abandon']);
});
