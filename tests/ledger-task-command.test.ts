import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { HELP } from '../mods/ledger/hooks/ledger.js';
import { REPO } from './helpers.js';

const read = (file: string) => readFileSync(path.join(REPO, file), 'utf8').replace(/\s+/g, ' ');

test('/ledger:task continues in this session when there is no current ledger', () => {
  const task = read('mods/ledger/commands/task.md');
  assert.match(task, /`\.claude\/ledger\.md` in the working directory/);
  const step8 = task.match(/ 8\. If there is no current ledger.*/)?.[0] ?? '';
  assert.match(step8, /there is no old task to clear/);
  assert.match(step8, /move this session into the new worktree with the EnterWorktree tool/i);
  assert.match(task, /continue with the operator's request in this session/);
});

test('/ledger:task without a current ledger reads the new ledger and follows the plan gate', () => {
  const step8 = read('mods/ledger/commands/task.md').match(/ 8\. If there is no current ledger.*/)?.[0] ?? '';
  assert.match(step8, /EnterWorktree.*Read `\.claude\/ledger\.md` in the new worktree/);
  assert.match(step8, /get the plan approved, then write the approved plan into the ledger/);
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
  assert.match(update, /If `\.claude\/ledger\.md` does not exist, create nothing\. Tell the operator to use `\/ledger:task <what the task is>`/);
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
  assert.match(gate, /split and the order .*parent ledger/);
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
  assert.match(bullet, /After each child task's review verdict or merge, update the parent ledger/);
  assert.match(planGate(), /two or more parts that ship separately/);
});

test('a finished task ends with one multi-select question for retire and the next task', () => {
  assert.match(checkpointBullet('**Resume.**'), /When every plan step is done, ask with the question widget whether to commit or open a PR\./);
  const bullet = checkpointBullet('**End of task.**');
  assert.match(bullet, /When the work is merged, or the operator says the task is finished, ask one `multiSelect` widget question\./);
  assert.match(bullet, /Its options are: retire this task; one option per other finished task; start the next task with `\/ledger:go <slug>`\./);
  assert.match(bullet, /With a parent, the next task is `\/ledger:go <parent>`\./);
  assert.match(bullet, /With no child task left, offer to retire the parent task\./);
  assert.match(bullet, /A ticked option is the operator's approval to run it\./);
});

test('the end-of-task retires leave the worktree only when needed and never retire an unmerged branch', () => {
  const bullet = checkpointBullet('**End of task.**');
  assert.match(bullet, /`ExitWorktree` with `keep`, if a retire removes this session's worktree\./);
  assert.match(bullet, /Do not retire a branch with no merged PR; say what is missing\./);
});

test('ticked options run in a fixed order: dry runs, leave the worktree, retires, then /ledger:go', () => {
  const bullet = checkpointBullet('**End of task.**');
  const order = ['1. Run `/ledger:retire <slug> --dry-run`', '`ExitWorktree` with `keep`', '3. Retire each ticked task, this task first.', '4. Start the next task.'].map(step => bullet.indexOf(step));
  assert.ok(order.every(at => at >= 0), `missing step: ${JSON.stringify(order)}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('the agent retires without --force after a dry run', () => {
  const archiving = read('rules/10-operating-model.md').match(/### Archiving a ledger.*?### /)?.[0] ?? '';
  assert.match(archiving, /Never pass `--force`/);
  assert.match(archiving, /Retire a parent task only after all its child tasks are retired/);
  const endOfTask = checkpointBullet('**End of task.**');
  assert.match(endOfTask, /Run `\/ledger:retire <slug> --dry-run` for each; clear the problems it names/);
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
  assert.match(split, /attach each child task in the order they ship/);
  assert.match(split, /Write the split and the order into the parent ledger/);
  assert.match(split, /`bin\/ledger parent <parent> add <child>`/);
  assert.match(split, /Never promote the parent task/);
  assert.match(split, /`\/ledger:go <parent>`/);
});

test('/ledger:task selects LLP numbers in a separate step before running the script', () => {
  const task = read('mods/ledger/commands/task.md');
  assert.match(task, / 4\. Before running the script, check the task repo for `llp\/`\..*Pick the LLPs.* 5\. Run the script/);
});

test('/ledger:task runs bin/ledger task, which takes no --refs, and writes picked LLPs on the design refs line', () => {
  const task = readFileSync(path.join(REPO, 'mods/ledger/commands/task.md'), 'utf8');
  const examples = task.split('\n').filter(line => line.includes('/bin/ledger" task <slug>'));
  assert.equal(examples.length, 1);
  assert.doesNotMatch(task, /--refs/);
  assert.match(task.replace(/\s+/g, ' '), /`- design refs:` line/);
});

test('/ledger:go makes a new task with bin/ledger task, then starts it with bin/ledger go', () => {
  const go = read('mods/ledger/commands/go.md');
  assert.match(go, /\/bin\/ledger" task <slug> --goal '<goal>'/);
  assert.match(go, /`bin\/ledger go <slug>`/);
  assert.doesNotMatch(go, /--promote|--refs/);
  assert.match(go, /`- design refs:` line/);
});

test('no ledger mod command names a removed script', () => {
  for (const file of ['go.md', 'task.md', 'update.md', 'close.md', 'next.md', 'park.md']) {
    assert.doesNotMatch(read(`mods/ledger/commands/${file}`), /cc-task-new|cc-ledger-parent|cc-ledgers|cc-worktree-retire|cc-ledger-dashboard/, file);
  }
});
