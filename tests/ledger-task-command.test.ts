import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { HELP } from '../mods/ledger/hooks/ledger.js';
import { REPO } from './helpers.js';
import { activeFile, git, hasLedgerFile, home, ledger, ok, readLedgerFile, repository, storeFolder, worktreeTask, type Ran } from './ledger-core-fixtures.js';

const read = (file: string) => readFileSync(path.join(REPO, file), 'utf8').replace(/\s+/g, ' ');

test('/ledger:task continues in this session when there is no current ledger', () => {
  const task = read('mods/ledger/commands/task.md');
  assert.match(task, /`ledger show` succeeds in the working directory/);
  const step8 = task.match(/ 8\. If there is no current ledger.*/)?.[0] ?? '';
  assert.match(step8, /there is no old task to clear/);
  assert.match(step8, /move this session into the new worktree with the EnterWorktree tool/i);
  assert.match(task, /continue with the operator's request in this session/);
});

test('/ledger:task without a current ledger reads the new ledger and follows the plan gate', () => {
  const step8 = read('mods/ledger/commands/task.md').match(/ 8\. If there is no current ledger.*/)?.[0] ?? '';
  assert.match(step8, /EnterWorktree.*Read its ledger with `ledger show` in the new worktree/);
  assert.match(step8, /When the task changes more than one file or involves a design choice, get the plan approved with the widget question that `ledger task gate plan` prints\. Then write the plan into the ledger with `ledger notes plan add`/);
});

test('/ledger:task without a current ledger starts the backlog task with ledger go, then enters the worktree it printed', () => {
  const step8 = read('mods/ledger/commands/task.md').match(/ 8\. If there is no current ledger.*/)?.[0] ?? '';
  assert.match(step8, /without `--stack`, .*`bin\/ledger go <slug>`.*EnterWorktree/i);
  assert.doesNotMatch(step8, /Before that/);
  assert.match(step8, /Set `path` to the path on the `worktree` line that `ledger go` printed/);
});

test('/ledger:task with a current ledger leaves the task in the backlog', () => {
  const step7 = read('mods/ledger/commands/task.md').match(/ 7\. If there is a current ledger.*? 8\. /)?.[0] ?? '';
  assert.match(step7, /under its Decisions/);
  assert.doesNotMatch(step7, /ledger go/);
});

test('/ledger:task describes both cases in its frontmatter', () => {
  const description = read('mods/ledger/commands/task.md').match(/description: (.*?) argument-hint:/)?.[1] ?? '';
  assert.match(description, /backlog ledger/);
  assert.match(description, /With no current ledger, it starts the task at once and continues in this session/);
});

test('/ledger:help says /ledger:task starts the task at once without a current ledger', () => {
  const line = HELP.split('\n').find(l => l.startsWith('- `/ledger:task`')) ?? '';
  assert.match(line, /backlog/);
  assert.match(line, /With no current ledger, it starts the task at once and continues in this session/);
});

/** The rule 10 Checkpoint gate bullet that starts with `start`, up to the next bullet or heading. */
function checkpointBullet(start: string): string {
  const gate = read('rules/10-operating-model.md').match(/### Checkpoint gate.*?### /)?.[0] ?? '';
  const from = gate.indexOf(`- ${start}`);
  if (from === -1) return '';
  const rest = gate.slice(from + 2);
  const end = rest.search(/ - |### /);
  return rest.slice(0, end === -1 ? undefined : end);
}

test('no document says promotion branches from the current main branch', () => {
  for (const file of ['README.md', 'DECISIONS.md', 'docs/usage.md', 'docs/installation.md', 'rules/10-operating-model.md', 'mods/ledger/commands/go.md', 'mods/ledger/commands/task.md']) {
    assert.doesNotMatch(read(file), /current main/, file);
  }
});

test('/ledger:help and the /ledger:all description both mention backlog tasks', () => {
  const line = HELP.split('\n').find(l => l.startsWith('- `/ledger:all`')) ?? '';
  const description = read('mods/ledger/commands/all.md').match(/description: (.*?) (argument-hint:|---)/)?.[1] ?? '';
  assert.match(line, /active, backlog and archived/);
  assert.match(description, /active, backlog and archived/);
});

test('each document names the stored --base first when it describes where promotion branches from', () => {
  for (const file of ['README.md', 'docs/usage.md', 'docs/installation.md']) {
    assert.match(read(file), /`--base`.*?Without one, .*?`origin\/HEAD`.*?Without `origin\/HEAD`/, file);
  }
});

test('the README /ledger:all row describes the one table ledger list prints', () => {
  const row = read('README.md').match(/\| `\/ledger:all` \|[^|]*\|/)?.[0] ?? '';
  assert.match(row, /one table .*status: active, parked, backlog or retired\. The title line counts the live tasks: active, parked and backlog\./);
  assert.doesNotMatch(row, /section/);
});

test('/ledger:task still hands over the start: line when a current ledger exists', () => {
  const task = read('mods/ledger/commands/task.md');
  assert.match(task, /under its Decisions/);
  assert.match(task, /Reply with the `start:` line/);
});

test('the new-work rule makes work outside the ledger goal a new task', () => {
  const bullet = checkpointBullet('Work outside the ledger');
  assert.match(bullet, /Work outside the ledger's goal is a new task \(`\/ledger:task <what the task is>`\)/);
  assert.match(bullet, /If unclear, ask in one line/);
});

test('/ledger:help says /ledger:task continues in this session without a current ledger', () => {
  const line = HELP.split('\n').find(l => l.startsWith('- `/ledger:task`')) ?? '';
  assert.match(line, /continues in this session/);
});

test('the usage guide covers the case with no open task', () => {
  const usage = read('docs/usage.md');
  assert.match(usage, /EnterWorktree/);
  assert.match(usage, /without `\/ledger:go`/);
});

test('the usage guide presents the start: line only for the case with another task open', () => {
  const usage = read('docs/usage.md');
  assert.doesNotMatch(usage, /plan approval, typing the `start:` line that a new task prints, and/);
  assert.match(usage, /`start:` line that a new task prints when another task is open/);
});

test('the README says /ledger:task continues in this session when no task is open', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /with the goal filled in\. The reply tells you to type `\/clear`, then `go <name>`/);
  assert.match(readme, /When no task is open, the session moves into the new worktree and continues there/);
});

test('the README no longer says /ledger:update starts a task', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /the same way `\/ledger:task` does/);
  assert.match(readme, /With no ledger in the working directory, the agent creates nothing and tells you to use `\/ledger:task`/);
});

test('/ledger:update with no ledger creates nothing and points to /ledger:task', () => {
  const update = read('mods/ledger/commands/update.md');
  assert.doesNotMatch(update, /cc-task-new/);
  assert.doesNotMatch(update, /`start:` line/);
  assert.doesNotMatch(update, /start a task/i);
  assert.match(update, /If `ledger show` fails, there is no ledger: create nothing\. Tell the operator to use `\/ledger:task <what the task is>`/);
});

test('/ledger:help no longer says /ledger:update starts a task', () => {
  const line = HELP.split('\n').find(l => l.startsWith('- `/ledger:update`')) ?? '';
  assert.match(line, /Write the latest results/);
  assert.doesNotMatch(line, /start a task/);
});

test('the installation guide no longer says /ledger:update starts a task', () => {
  assert.doesNotMatch(read('docs/installation.md'), /When there is no ledger, it starts a task/);
});

const planGate = () => read('rules/10-operating-model.md').match(/### Plan gate.*?### /)?.[0] ?? '';

test('the Plan gate requires a parent task for two or more separately shipped parts, before child work', () => {
  const gate = planGate();
  assert.match(gate, /two or more parts that ship separately/);
  assert.match(gate, /make the parent task and each child task/);
  assert.match(gate, /attach each child task to the parent task/);
  assert.match(gate, /split and the order in the parent task's goal: the `--goal` text of `ledger task new`/);
  assert.match(gate, /before any child work starts/);
});

test('the Plan gate makes the current task the first child task', () => {
  const gate = planGate();
  assert.match(gate, /current task already has a worktree, it becomes the first child task/);
  assert.match(gate, /new parent task with `\/ledger:task <what the task is>`/);
  assert.match(gate, /parent task stays in the backlog, with no worktree/);
});

test('the parent task rule states both directions', () => {
  const bullet = checkpointBullet('**Hard rule:**');
  assert.match(bullet, /a parent task only for work that ships as two or more separate PRs or merges/);
  assert.match(bullet, /Retiring a child updates the parent ledger\. Write its `## Report` first\./);
  assert.match(planGate(), /two or more parts that ship separately/);
});

test('the Plan gate asks for approval only for a task with more than one file or a design choice', () => {
  const gate = planGate();
  assert.match(gate, /Get the plan approved only for a task that touches more than one file or includes a design choice\./);
  assert.match(gate, /Other tasks go from the plan straight to red tests\./);
  assert.match(gate, /Ask with `ledger task gate plan`\./);
  assert.doesNotMatch(gate, /approval before multi-file or architectural work/);
});

// The finalize question's options come from `ledger task gate finalize`; tests/ledger-gates.test.ts covers them.
test('a finished task ends with one multi-select question for retire and the next task', () => {
  assert.match(checkpointBullet('**Resume.**'), /When every plan step is done, ask with `ledger task gate pr`\./);
  const bullet = checkpointBullet('**End of task.**');
  assert.match(bullet, /When the work is merged, or the operator calls it finished, ask the question `ledger task gate finalize` prints\. It is multi-select\./);
  assert.match(bullet, /Start the next task, if ticked\./);
  assert.match(bullet, /On "Finalize <parent>", ask `ledger task gate finalize <parent>` and repeat these steps for the parent\./);
  assert.match(bullet, /A ticked option is the operator's approval to run it\./);
});

const askingTheOperator = () => read('rules/20-writing.md').match(/### Asking the operator.*?## /)?.[0] ?? '';

test('the writing rule takes the widget of each gate ledger task gate knows from it', () => {
  const section = askingTheOperator();
  assert.match(section, /At a gate that `ledger task gate` knows \(`plan`, `pr`, `abandon` and `finalize` today\), show the question it prints as JSON\. Do not write its options yourself\./);
  assert.match(section, /Write any other gate yourself, with at most three actions, plus Close\./);
});

test('the writing rule gives an approval question the action, "Not yet" and Close', () => {
  const section = askingTheOperator();
  assert.match(section, /Give it three options: the action, labelled with what it does; "Not yet", which stops and waits; and Close, which saves where the task stands and stops\./);
  assert.doesNotMatch(section, /Give it two options/);
});

test('the writing rule states the multi-select Close rule', () => {
  assert.match(askingTheOperator(), /In a multi-select widget, Close ticked with other options runs those options, then stops\. Close ticked alone runs nothing and stops\./);
});

test('the writing rule asks in plain text during a walkthrough of a document', () => {
  assert.match(askingTheOperator(), /During an operator walkthrough of a document, ask in plain text, one point at a time\. The widget returns at the next gate\./);
});

test('the writing rule starts an open-answer question with ❓ and keeps the walkthrough exception', () => {
  const marks = read('rules/20-writing.md').match(/## Result status marks.*?## /)?.[0] ?? '';
  assert.match(marks, /Start any other question you ask the user with ❓\. Such a question has an open answer, such as a name or a value/);
  assert.match(marks, /except during a walkthrough/);
});

test('the end-of-task retires leave the worktree only when needed and never retire an unmerged branch', () => {
  const bullet = checkpointBullet('**End of task.**');
  assert.match(bullet, /`ExitWorktree` with `keep`, if a retire removes this session's worktree\./);
  // The dry run names an unmerged branch as a problem; tests/ledger-core-retire.test.ts covers the refusal.
  assert.match(bullet, /Stop on any problem it names, and say what is missing\./);
});

test('ticked options run in a fixed order: dry runs, leave the worktree, retires, then /ledger:go', () => {
  const bullet = checkpointBullet('**End of task.**');
  const order = ['1. Run `/ledger:retire <slug> --dry-run`', '`ExitWorktree` with `keep`', '3. Retire each ticked task, this task first.', '4. Start the next task, if ticked.'].map(step => bullet.indexOf(step));
  assert.ok(order.every(at => at >= 0), `missing step: ${JSON.stringify(order)}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('the agent retires without --force after a dry run', () => {
  const archiving = read('rules/10-operating-model.md').match(/### Archiving a ledger.*?### /)?.[0] ?? '';
  assert.match(archiving, /Never pass `--force`/);
  assert.match(archiving, /Retire a parent task only after all its child tasks are retired/);
  const endOfTask = checkpointBullet('**End of task.**');
  assert.match(endOfTask, /Run `\/ledger:retire <slug> --dry-run` for each ticked retire\. Stop on any problem it names/);
  assert.doesNotMatch(endOfTask, /Retire this task, then/);
  assert.match(endOfTask, /Ask before you discard any change/);
  assert.match(endOfTask, /A ticked option is the operator's approval to run it/);
});

test('no rule says only the operator runs a retire', () => {
  for (const file of ['rules/10-operating-model.md', 'rules/90-builds.md']) {
    assert.doesNotMatch(read(file), /retire[^.]*\. The operator types it\./, file);
    assert.doesNotMatch(read(file), /\/ledger:retire <slug>`\. Ask the operator to type it/, file);
  }
});

test('starting or resuming a task shows the operator its task tree', () => {
  assert.match(checkpointBullet('**Resume.**'), /If the task has a parent or children, show its tree with `\/ledger:parent <parent>`\./);
});

test('resuming continues from the ledger for go, go <slug> and a backlog task', () => {
  const bullet = checkpointBullet('**Resume.**');
  assert.match(bullet, /On "go" or `go <slug>`, continue from the ledger's Next step\./);
  assert.match(bullet, /With several ledgers, "go" first asks which task\./);
  assert.match(bullet, /`go <slug>` never asks: it enters the ledger's Location with `EnterWorktree`, unless already there\./);
  assert.match(bullet, /Do not re-read files or rerun tests to re-establish state\./);
  assert.match(bullet, /A backlog task has no worktree: run `\/ledger:go <slug>` yourself\./);
});

test('/ledger:help says /ledger:next names the next child task of a finished child task', () => {
  const line = HELP.split('\n').find(l => l.startsWith('- `/ledger:next`')) ?? '';
  assert.match(line, /When every step is done, it first says how to retire the task\./);
  assert.match(line, /For a child task, it also names the next child task of its parent/);
});

test('/ledger:task makes the parent task first for a request with separately shipped parts', () => {
  const split = read('mods/ledger/commands/task.md').match(/two or more parts that ship separately.*? 1\. Pick/)?.[0] ?? '';
  assert.match(split, /parent task's backlog ledger first, then the ledger of each child task/);
  assert.match(split, /The parent task's goal from step 2 also states the split and the order/);
  assert.match(split, /attach each child task in that order/);
  assert.doesNotMatch(split, /into the parent ledger|Edit/);
  assert.match(split, /`bin\/ledger tree add <parent> <child>`/);
  assert.match(split, /`bin\/ledger tree order <parent> <child>\.\.\.`/);
  assert.match(split, /`bin\/ledger tree depends <child> <task>\.\.\.`/);
  assert.match(split, /Never promote the parent task/);
  assert.match(split, /`\/ledger:go <parent>`/);
});

test('/ledger:task selects LLP numbers in a separate step before running the script', () => {
  const task = read('mods/ledger/commands/task.md');
  assert.match(task, / 4\. Before running the script, check the task repo for `llp\/`\..*Pick the LLPs.* 5\. Run the script/);
});

test('/ledger:task runs bin/ledger task, which takes no --refs, and writes picked LLPs on the design refs line', () => {
  const task = readFileSync(path.join(REPO, 'mods/ledger/commands/task.md'), 'utf8');
  const examples = task.split('\n').filter(line => line.includes('/bin/ledger" task new <slug>'));
  assert.equal(examples.length, 1);
  assert.doesNotMatch(task, /--refs/);
  assert.match(task.replace(/\s+/g, ' '), /`- design refs:` line/);
});

test('/ledger:task passes picked LLPs to bin/ledger task with --design-refs, and does not edit the backlog ledger', () => {
  const task = read('mods/ledger/commands/task.md');
  assert.match(task, /`--design-refs[ `]/);
  assert.doesNotMatch(task, /design refs:` line [^.]*\. Use Edit\./);
});

test('/ledger:go makes a new task with bin/ledger task, then starts it with bin/ledger go', () => {
  const go = read('mods/ledger/commands/go.md');
  assert.match(go, /\/bin\/ledger" task new <slug> --kind <kind> --goal '<goal>'/);
  assert.match(go, /`bin\/ledger go <slug>`/);
  assert.doesNotMatch(go, /--promote|--refs/);
  assert.match(go, /`- design refs:` line/);
});

test('/ledger:go passes picked LLPs to bin/ledger task with --design-refs, and its new-task steps edit no ledger', () => {
  const go = read('mods/ledger/commands/go.md');
  const newTaskSteps = go.slice(go.indexOf('If there is a `new:` line'), go.indexOf('If `ledger:` is `none`'));
  assert.match(newTaskSteps, /`--design-refs[ `]/);
  assert.doesNotMatch(newTaskSteps, /Use Edit/);
});

test('/ledger:task and /ledger:go always pass --kind to ledger task new', () => {
  const go = read('mods/ledger/commands/go.md');
  const newTaskSteps = go.slice(go.indexOf('If there is a `new:` line'), go.indexOf('If `ledger:` is `none`'));
  for (const text of [read('mods/ledger/commands/task.md'), newTaskSteps]) {
    assert.match(text, /`--kind[ `]/);
    for (const kind of ['docs', 'investigation', 'code']) assert.match(text, new RegExp(`\`${kind}\``));
  }
});

test('no ledger mod command names a removed script', () => {
  for (const file of ['go.md', 'task.md', 'update.md', 'close.md', 'next.md', 'park.md']) {
    assert.doesNotMatch(read(`mods/ledger/commands/${file}`), /cc-task-new|cc-ledger-parent|cc-ledgers|cc-worktree-retire|cc-ledger-dashboard/, file);
  }
});

function kindSetup(t: TestContext) {
  const h = home(t);
  copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
  const app = repository(h, path.join(h, 'repos/app'));
  writeFileSync(path.join(app, '.git/info/exclude'), '.claude/\n');
  const backlogFile = (slug: string): string => path.join(storeFolder(h, 'ledger-backlog', app), `${slug}.json`);
  const worktreeOf = (slug: string): string => path.join(app, '.claude/worktrees', slug);
  const ledgerOf = (slug: string): string => activeFile(h, app, slug);
  return { h, app, backlogFile, worktreeOf, ledgerOf };
}

const locationOf = (text: string): string[] => (/^## Location\n((?:- .*\n)*)/m.exec(text)?.[1] ?? '').split('\n').filter((line) => line !== '');
const kindsIn = (text: string): string[] => locationOf(text).filter((line) => line.startsWith('- kind:'));

test('ledger task new --kind docs writes - kind: docs as the last ## Location bullet of a backlog task', (t) => {
  const { h, app, backlogFile } = kindSetup(t);
  ok(ledger(h, app, 'task', 'new', 'docs-task', '--kind', 'docs'));
  const location = locationOf(readLedgerFile(backlogFile('docs-task')));
  assert.deepEqual(location.filter((line) => line.startsWith('- kind:')), ['- kind: docs']);
  assert.equal(location.at(-1), '- kind: docs');
});

test('ledger task new adds the kind as the last ## Location bullet when the template has no - kind: line', (t) => {
  const { h, app, backlogFile } = kindSetup(t);
  ok(ledger(h, app, 'task', 'new', 'docs-task', '--kind', 'docs'));
  assert.equal(locationOf(readLedgerFile(backlogFile('docs-task'))).at(-1), '- kind: docs');
});

test('ledger task new replaces the kind of a template that has a - kind: line', (t) => {
  const { h, app, backlogFile } = kindSetup(t);
  const template = path.join(h, '.claude/ledger.template.md');
  writeFileSync(template, readFileSync(template, 'utf8').replace(/^(- design refs:.*\n)/m, '$1- kind: investigation\n'));
  ok(ledger(h, app, 'task', 'new', 'docs-task', '--kind', 'docs'));
  ok(ledger(h, app, 'task', 'new', 'plain'));
  assert.deepEqual(kindsIn(readLedgerFile(backlogFile('docs-task'))), ['- kind: docs']);
  assert.deepEqual(kindsIn(readLedgerFile(backlogFile('plain'))), ['- kind: code']);
});

test('ledger task new without --kind writes - kind: code', (t) => {
  const { h, app, backlogFile } = kindSetup(t);
  ok(ledger(h, app, 'task', 'new', 'plain'));
  assert.deepEqual(kindsIn(readLedgerFile(backlogFile('plain'))), ['- kind: code']);
});

test('ledger task new --stack and --here write the kind given', (t) => {
  const { h, app, worktreeOf, ledgerOf } = kindSetup(t);
  worktreeTask(h, app, { slug: 'epic' });
  ok(ledger(h, worktreeOf('epic'), 'task', 'new', 'sub', '--stack', '--kind', 'investigation'));
  assert.deepEqual(kindsIn(readLedgerFile(ledgerOf('sub'))), ['- kind: investigation']);
  const side = worktreeOf('side');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'me/side', side, 'main');
  ok(ledger(h, side, 'task', 'new', '--here', '--kind', 'docs'));
  assert.deepEqual(kindsIn(readLedgerFile(ledgerOf('side'))), ['- kind: docs']);
});

test('ledger task new with an unknown --kind fails, names the kinds, and makes no ledger, worktree or branch', (t) => {
  const { h, app, backlogFile, worktreeOf, ledgerOf } = kindSetup(t);
  const refused = (ran: Ran): void => {
    assert.notEqual(ran.status, 0, ran.stdout);
    for (const kind of ['code', 'docs', 'investigation']) assert.match(ran.stderr, new RegExp(`\\b${kind}\\b`));
  };
  refused(ledger(h, app, 'task', 'new', 'odd', '--kind', 'nonsense'));
  assert.equal(hasLedgerFile(backlogFile('odd')), false);
  worktreeTask(h, app, { slug: 'epic' });
  refused(ledger(h, worktreeOf('epic'), 'task', 'new', 'sub', '--stack', '--kind', 'nonsense'));
  assert.equal(existsSync(worktreeOf('sub')), false);
  assert.equal(git(h, app, 'branch', '--list', 'sub'), '');
  const side = worktreeOf('side');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'me/side', side, 'main');
  refused(ledger(h, side, 'task', 'new', '--here', '--kind', 'nonsense'));
  assert.equal(hasLedgerFile(ledgerOf('side')), false);
});

test('ledger go keeps the kind of a backlog task in its worktree ledger', (t) => {
  const { h, app, worktreeOf, ledgerOf } = kindSetup(t);
  ok(ledger(h, app, 'task', 'new', 'docs-task', '--kind', 'docs'));
  ok(ledger(h, app, 'go', 'docs-task'));
  assert.deepEqual(kindsIn(readLedgerFile(ledgerOf('docs-task'))), ['- kind: docs']);
});

test('a task made with --kind docs goes from plan straight to build', (t) => {
  const { h, app, worktreeOf } = kindSetup(t);
  ok(ledger(h, app, 'task', 'new', 'docs-task', '--kind', 'docs'));
  ok(ledger(h, app, 'go', 'docs-task'));
  const worktree = worktreeOf('docs-task');
  ok(ledger(h, worktree, 'notes', 'stage', 'plan', 'pass'));
  ok(ledger(h, worktree, 'notes', 'stage', 'build', 'pass'));
});
