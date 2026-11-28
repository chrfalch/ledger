import assert from 'node:assert/strict';
import { spawn as spawnAsync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Storage } from '../tools/ledger/settings.js';
import { today } from '../tools/ledger/write.js';
import { REPO } from './helpers.js';
import { FORMAT } from '../tools/ledger/clone.js';
import { archivedTask, backlogTask, commandEnv, git, home, LEDGER_BIN, noSqlite, readLedgerFile, recordFile, repoFixtures, runInProcessWith, worktreeOf, writeLedgerFile, type Fields, type Ran } from './ledger-core-fixtures.js';

const TODAY = today();

type Run = (cwd: string, ...args: string[]) => Promise<Ran>;
type Task = Omit<Fields, 'worktree' | 'branch' | 'base'>;
type Setup = { h: string; app: string; env: NodeJS.ProcessEnv; run: Run; spawned: Run; addTask: (fields: Task) => string };

/** The repo ~/repos/app; `realGit` as in repoFixtures, by default when git storage takes part. */
function setup(t: TestContext, storage: Storage = 'file', { realGit = storage === 'git' } = {}): Setup {
  const h = home(t);
  copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
  if (storage === 'git') {
    const clone = path.join(h, '.claude/ledger-data');
    spawnSync('git', ['init', '--quiet', clone]);
    writeFileSync(path.join(clone, '.ledger-data'), `${JSON.stringify({ format: FORMAT })}\n`);
  }
  if (storage !== 'file') writeFileSync(path.join(h, '.claude/ledger-settings.json'), JSON.stringify({ storage }));
  const repos = repoFixtures(t, h, { realGit });
  const app = repos.addRepo(path.join(h, 'repos', 'app'));
  if (realGit) writeFileSync(path.join(app, '.git/info/exclude'), '.claude/\n');
  const addTask = (fields: Task): string => repos.addTask(app, fields);
  const env = { ...commandEnv(h), LEDGER_TEST_NO_BACKGROUND_SYNC: '1' };
  const run: Run = (cwd, ...args) => runInProcessWith(h, cwd, { env: { LEDGER_TEST_NO_BACKGROUND_SYNC: '1' } }, ...args);
  const spawned: Run = async (cwd, ...args) => {
    const result = spawnSync(LEDGER_BIN, args, { cwd, env, encoding: 'utf8' });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  return { h, app, env, run, spawned, addTask };
}

function passed(ran: Ran): string {
  assert.equal(ran.status, 0, `stdout: ${ran.stdout}\nstderr: ${ran.stderr}`);
  return ran.stdout.trim();
}

function refused(ran: Ran): string {
  assert.equal(ran.status, 1, `stdout: ${ran.stdout}\nstderr: ${ran.stderr}`);
  return `${ran.stdout}${ran.stderr}`;
}

/** A worktree task `wt` of the fixture ledger: steps 1 and 2, one decision, and a goal. */
function withWorktree(t: TestContext, fields: { goal?: string } = {}, { realGit = false } = {}) {
  const s = setup(t, 'file', { realGit });
  const file = s.addTask({ slug: 'wt', main: s.app, ...fields });
  const worktree = worktreeOf(s.app, 'wt');
  const read = (): string => readLedgerFile(file);
  const notes = (...args: string[]): Promise<Ran> => s.run(worktree, 'notes', ...args);
  return { ...s, file, worktree, read, notes };
}

const linesOf = (markdown: string, heading: RegExp): string[] => {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => heading.test(line));
  assert.notEqual(start, -1, `no heading ${heading} in:\n${markdown}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end).filter((line) => line !== '');
};

test('plan add appends a todo step numbered after the highest, from a subfolder of the worktree, and prints its number', async (t) => {
  const { worktree, run, read } = withWorktree(t);
  mkdirSync(path.join(worktree, 'src'));
  assert.equal(passed(await run(path.join(worktree, 'src'), 'notes', 'plan', 'add', 'review', '--owner', 'reviewer')), 'Added step 3 to wt.');
  assert.equal(passed(await run(worktree, 'notes', 'plan', 'add', 'fix the review', '--owner', 'opus-implementer', '--note', 'after review')), 'Added step 4 to wt.');
  const rows = linesOf(read(), /^## Plan/);
  assert.equal(rows.at(-2), '| 3 | review | todo | reviewer | |');
  assert.equal(rows.at(-1), '| 4 | fix the review | todo | opus-implementer | after review |');
  const result = JSON.parse(passed(await run(worktree, 'notes', 'plan', 'add', 'review again', '--owner', 'reviewer', '--json')));
  assert.equal(result.ok, true);
  assert.deepEqual(result.step, { n: '5', step: 'review again', status: 'todo', owner: 'reviewer', note: '' });
});

test('plan add refuses a missing or empty owner, an empty step, and a step that would not read back, and writes nothing', async (t) => {
  const { notes, read } = withWorktree(t);
  const before = read();
  refused(await notes('plan', 'add', 'review'));
  refused(await notes('plan', 'add', 'review', '--owner', ''));
  refused(await notes('plan', 'add', '  ', '--owner', 'reviewer'));
  refused(await notes('plan', 'add', 'a | b', '--owner', 'reviewer'));
  assert.equal(read(), before);
});

test('plan approve sets the approval date to today, in place of an earlier one', async (t) => {
  const { notes, read } = withWorktree(t);
  assert.match(read(), /^## Plan \(approved 2026-11-01\)$/m);
  passed(await notes('plan', 'approve'));
  assert.match(read(), new RegExp(`^## Plan \\(approved ${TODAY}\\)$`, 'm'));
  assert.doesNotMatch(read(), /2026-11-01/);
});

test('plan summary sets the line under the plan heading, in place of an earlier one, and prints what it did', async (t) => {
  const { notes, read } = withWorktree(t);
  assert.equal(passed(await notes('plan', 'summary', 'Add the summary.')), 'Set the plan summary of wt.');
  assert.deepEqual(linesOf(read(), /^## Plan/).slice(0, 2), ['Summary: Add the summary.', '| # | step | status | owner | note |']);
  const result = JSON.parse(passed(await notes('plan', 'summary', '  Edit gates.ts and notes.ts. Then test.  ', '--json')));
  assert.equal(result.summary, 'Edit gates.ts and notes.ts. Then test.');
  assert.deepEqual(linesOf(read(), /^## Plan/).slice(0, 2), ['Summary: Edit gates.ts and notes.ts. Then test.', '| # | step | status | owner | note |']);
  assert.equal(read().match(/^Summary:/gm)?.length, 1);
});

test('plan summary refuses an empty text, more than one line and more than two sentences, and writes nothing', async (t) => {
  const { notes, read } = withWorktree(t);
  const before = read();
  assert.match(refused(await notes('plan', 'summary', '   ')), /empty/);
  assert.match(refused(await notes('plan', 'summary', 'One line.\nTwo lines.')), /one line/);
  assert.match(refused(await notes('plan', 'summary', 'One. Two! Three?')), /two sentences/);
  assert.equal(read(), before);
});

test('step sets the status of a step, replaces its note, or both, and prints the step', async (t) => {
  const { notes, read } = withWorktree(t);
  assert.equal(passed(await notes('step', '2', '--status', 'in review')), 'Updated step 2 of wt.');
  assert.equal(linesOf(read(), /^## Plan/).at(-1), '| 2 | implement | in review | opus-implementer | |');
  passed(await notes('step', '1', '--note', 'reviewed: tests seen failing'));
  assert.equal(linesOf(read(), /^## Plan/).at(-2), '| 1 | write the tests | done | opus-implementer | reviewed: tests seen failing |');
  const result = JSON.parse(passed(await notes('step', '2', '--status', 'done', '--note', 'merged', '--json')));
  assert.deepEqual(result.step, { n: '2', step: 'implement', status: 'done', owner: 'opus-implementer', note: 'merged' });
  assert.equal(linesOf(read(), /^## Plan/).at(-1), '| 2 | implement | done | opus-implementer | merged |');
  passed(await notes('step', '1', '--note', ''));
  assert.equal(linesOf(read(), /^## Plan/).at(-2), '| 1 | write the tests | done | opus-implementer | |');
});

test('step refuses no --status and no --note, an empty status, an unknown step, and a note that would not read back, and writes nothing', async (t) => {
  const { notes, read } = withWorktree(t);
  const before = read();
  assert.match(refused(await notes('step', '2')), /--status/);
  refused(await notes('step', '2', '--status', ' '));
  assert.match(refused(await notes('step', '9', '--status', 'done')), /wt has no step 9/);
  refused(await notes('step', 'two', '--status', 'done'));
  refused(await notes('step', '2', '--note', 'a | b'));
  assert.equal(read(), before);
});

test('decide appends a dated, tagged decision with its reason', async (t) => {
  const { notes, read } = withWorktree(t);
  assert.equal(passed(await notes('decide', 'Use SQLite', '--because', 'it locks rows', '--tag', 'confirmed')), 'Added decision 2 to wt.');
  assert.equal(linesOf(read(), /^## Decisions$/).at(-1), `- ${TODAY}: Use SQLite — because it locks rows [confirmed]`);
  const result = JSON.parse(passed(await notes('decide', 'Keep files', '--because', 'they are simple', '--tag', 'inferred', '--json')));
  assert.deepEqual(result.decision, { text: 'Keep files', reason: 'they are simple', tag: 'inferred', date: TODAY });
});

test('decide refuses a missing reason or tag, an unknown tag and empty text, and writes nothing', async (t) => {
  const { notes, read } = withWorktree(t);
  const before = read();
  refused(await notes('decide', 'Use SQLite', '--tag', 'observed'));
  refused(await notes('decide', 'Use SQLite', '--because', 'it locks rows'));
  refused(await notes('decide', 'Use SQLite', '--because', 'it locks rows', '--tag', 'guessed'));
  refused(await notes('decide', '', '--because', 'it locks rows', '--tag', 'observed'));
  refused(await notes('decide', 'Use SQLite', '--because', ' ', '--tag', 'observed'));
  assert.equal(read(), before);
});

test('constraint appends a constraint with its source, and its tag when given', async (t) => {
  const { notes, read } = withWorktree(t);
  assert.equal(passed(await notes('constraint', 'Node 22 or later', '--source', 'package.json')), 'Added constraint 1 to wt.');
  assert.equal(passed(await notes('constraint', 'No network in hooks', '--source', 'hooks.ts', '--tag', 'observed')), 'Added constraint 2 to wt.');
  assert.deepEqual(linesOf(read(), /^## Constraints discovered$/), ['- Node 22 or later — found in package.json', '- No network in hooks — found in hooks.ts [observed]']);
});

test('constraint refuses a missing source, an unknown tag and empty text, and writes nothing', async (t) => {
  const { notes, read } = withWorktree(t);
  const before = read();
  refused(await notes('constraint', 'Node 22'));
  refused(await notes('constraint', 'Node 22', '--source', 'package.json', '--tag', 'maybe'));
  refused(await notes('constraint', '', '--source', 'package.json'));
  assert.equal(read(), before);
});

test('question adds an open question, with the step it blocks, and prints its id', async (t) => {
  const { notes, read } = withWorktree(t);
  assert.equal(passed(await notes('question', 'Which API?')), 'Added question 1 to wt.');
  assert.equal(passed(await notes('question', 'Which port?', '--blocks', '2')), 'Added question 2 to wt.');
  assert.deepEqual(linesOf(read(), /^## Open questions$/), ['- Which API?', '- Which port? — blocks step 2']);
  assert.equal(JSON.parse(passed(await notes('question', 'Which host?', '--json'))).question.id, 3);
});

test('question --blocks takes only a positive whole number', async (t) => {
  const { notes, read } = withWorktree(t);
  const before = read();
  for (const blocks of ['0', '-1', 'two', '1.5', '']) refused(await notes('question', 'Which API?', '--blocks', blocks));
  assert.equal(read(), before);
});

test('question --resolve marks an open question resolved; an unknown or resolved id, text with --resolve, or neither is refused', async (t) => {
  const { notes, read } = withWorktree(t);
  passed(await notes('question', 'Which API?'));
  passed(await notes('question', 'Which port?'));
  assert.equal(passed(await notes('question', '--resolve', '2')), 'Resolved question 2 of wt.');
  assert.deepEqual(linesOf(read(), /^## Open questions$/), ['- Which API?', '- (resolved) Which port?']);
  const before = read();
  refused(await notes('question', '--resolve', '2'));
  refused(await notes('question', '--resolve', '3'));
  refused(await notes('question', '--resolve', 'x'));
  refused(await notes('question', 'Which host?', '--resolve', '1'));
  refused(await notes('question'));
  assert.equal(read(), before);
});

test('a write that leaves a problem warns on stderr and still exits 0', async (t) => {
  const { notes, read } = withWorktree(t);
  const ran = await notes('question', 'Which API?', '--blocks', '9');
  passed(ran);
  assert.match(ran.stderr, /^warning: .*step 9/m);
  assert.match(read(), /- Which API\? — blocks step 9/);
});

test('report --step stores the path of an existing file, relative to the worktree, and replaces an earlier report of that step', async (t) => {
  const { worktree, run, notes, read } = withWorktree(t);
  mkdirSync(path.join(worktree, '.claude/evidence'), { recursive: true });
  writeFileSync(path.join(worktree, '.claude/evidence/red.txt'), 'failing\n');
  writeFileSync(path.join(worktree, '.claude/evidence/green.txt'), 'passing\n');
  passed(await notes('report', '--step', '1', '--file', '.claude/evidence/red.txt'));
  passed(await run(path.join(worktree, '.claude'), 'notes', 'report', '--step', '2', '--file', 'evidence/red.txt'));
  passed(await notes('report', '--step', '1', '--file', path.join(worktree, '.claude/evidence/green.txt')));
  assert.deepEqual(linesOf(read(), /^## Subagent reports$/), ['- step 1: .claude/evidence/green.txt', '- step 2: .claude/evidence/red.txt']);
});

test('report --step stores a file outside the worktree as an absolute path', async (t) => {
  const { h, notes, read } = withWorktree(t);
  const outside = path.join(h, 'report.md');
  writeFileSync(outside, 'report\n');
  passed(await notes('report', '--step', '2', '--file', outside));
  assert.deepEqual(linesOf(read(), /^## Subagent reports$/), [`- step 2: ${outside}`]);
});

test('report refuses a step not in the plan, a missing file, and --step and --file without each other or with --parent', async (t) => {
  const { worktree, notes, read } = withWorktree(t);
  writeFileSync(path.join(worktree, 'red.txt'), 'failing\n');
  const before = read();
  refused(await notes('report', '--step', '9', '--file', 'red.txt'));
  refused(await notes('report', '--step', '1', '--file', 'missing.txt'));
  refused(await notes('report', '--step', '1'));
  refused(await notes('report', '--file', 'red.txt'));
  refused(await notes('report', '--parent', 'Done.', '--step', '1', '--file', 'red.txt'));
  refused(await notes('report', '--parent', 'Done.', '--step', '1'));
  refused(await notes('report', '--parent', ''));
  refused(await notes('report'));
  assert.equal(read(), before);
});

const SCRATCHPAD_ADVICE = /Move the file to \.claude\/evidence\/ in the task's worktree and cite that path/;

test('report --file refuses a file in a session scratchpad, by its path or by where a link to it lands, and writes nothing', async (t) => {
  const { h, worktree, notes, read } = withWorktree(t);
  const session = path.join(h, 'tmp/claude-501/proj/0b7c2a8e-6f1d-4c3b-9a2e-5d4f3e2a1b0c');
  mkdirSync(path.join(session, 'scratchpad'), { recursive: true });
  const scratch = path.join(session, 'scratchpad/x.txt');
  writeFileSync(scratch, 'the red run\n');
  mkdirSync(path.join(worktree, '.claude/evidence'), { recursive: true });
  writeFileSync(path.join(worktree, '.claude/evidence/x.txt'), 'the red run\n');
  const before = read();

  assert.match(refused(await notes('report', '--step', '1', '--file', scratch)), SCRATCHPAD_ADVICE);
  symlinkSync(path.join(session, 'scratchpad'), path.join(worktree, 'out'));
  assert.match(refused(await notes('report', '--step', '1', '--file', 'out/x.txt')), SCRATCHPAD_ADVICE);
  assert.equal(read(), before);

  passed(await notes('report', '--step', '1', '--file', '.claude/evidence/x.txt'));
  assert.deepEqual(linesOf(read(), /^## Subagent reports$/), ['- step 1: .claude/evidence/x.txt']);
});

test('every notes text that cites a session scratchpad is refused, and nothing is written', async (t) => {
  const { notes, read } = withWorktree(t);
  const before = read();
  const citing = [
    ['decide', 'see scratchpad/x.txt', '--because', 'it failed', '--tag', 'observed'],
    ['decide', 'Use SQLite', '--because', 'see /tmp/claude-501/proj/0b7c2a8e-6f1d-4c3b-9a2e-5d4f3e2a1b0c/red.log', '--tag', 'observed'],
    ['constraint', 'Node 22', '--source', '<scratchpad>/node.txt'],
    ['plan', 'add', 'read scratchpad/notes.md', '--owner', 'me'],
    ['step', '1', '--note', 'in scratchpad/red.txt'],
    ['question', 'Is scratchpad/x.txt right?'],
    ['report', '--parent', 'Done; see scratchpad/x.txt.'],
    ['note', 'see scratchpad/x.txt'],
    ['next', 'Read scratchpad/x.txt.'],
  ];
  for (const args of citing) {
    const refusal = refused(await notes(...args));
    assert.match(refusal, SCRATCHPAD_ADVICE, args.join(' '));
    assert.doesNotMatch(refusal, /two separate commands/, args.join(' '));
  }
  assert.equal(read(), before);

  passed(await notes('decide', 'Keep the red run', '--because', 'see .claude/evidence/x.txt', '--tag', 'observed'));
});

test('report --parent sets ## Report to the text, line by line, in place of an earlier one', async (t) => {
  const { notes, read } = withWorktree(t);
  passed(await notes('report', '--parent', 'First try.'));
  passed(await notes('report', '--parent', 'Merged.\nPR: https://example.com/pr/1'));
  assert.deepEqual(linesOf(read(), /^## Report$/), ['Merged.', 'PR: https://example.com/pr/1']);
  assert.deepEqual(linesOf(read(), /^## Subagent reports$/), ['<paste the structured report for each step; replace with one line once the step is reviewed>']);
});

test('note appends to the general notes; next replaces the next step', async (t) => {
  const { notes, read } = withWorktree(t);
  passed(await notes('note', 'The CI is slow on Mondays.'));
  passed(await notes('note', 'Ask about the cache.'));
  assert.deepEqual(linesOf(read(), /^## Notes$/), ['The CI is slow on Mondays.', 'Ask about the cache.']);
  passed(await notes('next', 'Implement step 2 with opus-implementer at high effort.'));
  assert.deepEqual(linesOf(read(), /^## Next step$/), ['Implement step 2 with opus-implementer at high effort.']);
  const before = read();
  refused(await notes('note', ''));
  refused(await notes('next', ' '));
  assert.equal(read(), before);
});

const bytesOf = (file: string): Buffer => readFileSync(existsSync(recordFile(file)) ? recordFile(file) : file);

test('remove decision and remove constraint drop the item by its place, print its text, and leave a ledger that checks ok', async (t) => {
  const { notes, read } = withWorktree(t);
  passed(await notes('decide', 'Use SQLite', '--because', 'it locks rows', '--tag', 'confirmed'));
  assert.equal(passed(await notes('remove', 'decision', '1')), 'Removed decision 1 of wt: Keep the old format.');
  assert.deepEqual(linesOf(read(), /^## Decisions$/), [`- ${TODAY}: Use SQLite — because it locks rows [confirmed]`]);
  assert.equal(passed(await notes('check')), 'ok');
  passed(await notes('constraint', 'Node 22 or later', '--source', 'package.json'));
  passed(await notes('constraint', 'No network in hooks', '--source', 'hooks.ts', '--tag', 'observed'));
  assert.equal(passed(await notes('remove', 'constraint', '2')), 'Removed constraint 2 of wt: No network in hooks.');
  assert.deepEqual(linesOf(read(), /^## Constraints discovered$/), ['- Node 22 or later — found in package.json']);
  assert.equal(passed(await notes('check')), 'ok');
});

test('remove question renumbers the questions after it', async (t) => {
  const { notes, read } = withWorktree(t);
  for (const text of ['Which API', 'Which port', 'Which host']) passed(await notes('question', text));
  assert.equal(passed(await notes('remove', 'question', '1')), 'Removed question 1 of wt: Which API.');
  assert.deepEqual(linesOf(read(), /^## Open questions$/), ['- Which port', '- Which host']);
  passed(await notes('question', '--resolve', '1'));
  assert.deepEqual(linesOf(read(), /^## Open questions$/), ['- (resolved) Which port', '- Which host']);
  assert.equal(passed(await notes('check')), 'ok');
});

test('remove step finds the step by its number, and the other steps keep theirs', async (t) => {
  const { notes, read } = withWorktree(t);
  assert.equal(passed(await notes('remove', 'step', '1')), 'Removed step 1 of wt: write the tests.');
  assert.deepEqual(linesOf(read(), /^## Plan/).slice(2), ['| 2 | implement | todo | opus-implementer | |']);
  assert.equal(passed(await notes('check')), 'ok');
  assert.equal(passed(await notes('plan', 'add', 'review', '--owner', 'reviewer')), 'Added step 3 to wt.');
  assert.equal(passed(await notes('remove', 'step', '2')), 'Removed step 2 of wt: implement.');
  assert.deepEqual(linesOf(read(), /^## Plan/).slice(2), ['| 3 | review | todo | reviewer | |']);
});

test('remove step of the highest number frees it for the next plan add, and removing every step leaves a ledger that checks ok', async (t) => {
  const { notes, read } = withWorktree(t);
  passed(await notes('remove', 'step', '2'));
  assert.equal(passed(await notes('plan', 'add', 'review', '--owner', 'reviewer')), 'Added step 2 to wt.');
  passed(await notes('remove', 'step', '2'));
  passed(await notes('remove', 'step', '1'));
  assert.doesNotMatch(read(), /^\| \d+ \|/m);
  assert.equal(passed(await notes('check')), 'ok');
});

test('remove step refuses a step with a report or an open question that blocks it, and a resolved question does not stop it', async (t) => {
  const { worktree, notes, read } = withWorktree(t);
  writeFileSync(path.join(worktree, 'red.txt'), 'failing\n');
  passed(await notes('report', '--step', '1', '--file', 'red.txt'));
  passed(await notes('question', 'Which port', '--blocks', '2'));
  const before = read();
  assert.match(refused(await notes('remove', 'step', '1')), /report/);
  assert.match(refused(await notes('remove', 'step', '2')), /question/);
  assert.equal(read(), before);
  passed(await notes('question', '--resolve', '1'));
  assert.equal(passed(await notes('remove', 'step', '2')), 'Removed step 2 of wt: implement.');
  assert.equal(passed(await notes('check')), 'ok');
});

test('remove note drops one line of the notes, and refuses a line that is a copied heading', async (t) => {
  const { file, notes, read } = withWorktree(t);
  passed(await notes('note', 'The CI is slow on Mondays'));
  passed(await notes('note', 'Ask about the cache'));
  writeLedgerFile(file, `${read().trimEnd()}\n\n## Scratch\nleft over\n`);
  assert.deepEqual(linesOf(read(), /^## Notes$/), ['The CI is slow on Mondays', 'Ask about the cache']);
  assert.equal(passed(await notes('remove', 'note', '1')), 'Removed note 1 of wt: The CI is slow on Mondays.');
  assert.deepEqual(linesOf(read(), /^## Notes$/), ['Ask about the cache']);
  assert.deepEqual(linesOf(read(), /^## Scratch$/), ['left over']);
  assert.equal(passed(await notes('check')), 'ok');
  const before = read();
  assert.match(refused(await notes('remove', 'note', '2')), /heading/);
  assert.equal(read(), before);
});

test('remove --dry-run prints what it would remove and changes nothing', async (t) => {
  const { file, notes } = withWorktree(t);
  const before = bytesOf(file);
  assert.equal(passed(await notes('remove', 'decision', '1', '--dry-run')), 'Would remove decision 1 of wt: Keep the old format.');
  assert.equal(passed(await notes('remove', 'step', '2', '--dry-run')), 'Would remove step 2 of wt: implement.');
  const result = JSON.parse(passed(await notes('remove', 'step', '1', '--dry-run', '--json')));
  assert.equal(result.dryRun, true);
  assert.deepEqual(bytesOf(file), before);
});

test('remove --json gives the kind, number, slug and the removed item', async (t) => {
  const { notes } = withWorktree(t);
  const result = JSON.parse(passed(await notes('remove', 'step', '1', '--json')));
  assert.equal(result.kind, 'step');
  assert.equal(result.n, 1);
  assert.equal(result.dryRun, false);
  assert.equal(result.slug, 'wt');
  assert.match(JSON.stringify(result), /"write the tests"/);
});

test('remove refuses an unknown kind, a number that is not a positive whole number, and an item that does not exist, and writes nothing', async (t) => {
  const { notes, read } = withWorktree(t);
  const before = read();
  refused(await notes('remove', 'goal', '1'));
  for (const n of ['0', '-1', 'two', '1.5', '']) refused(await notes('remove', 'decision', n));
  assert.match(refused(await notes('remove', 'decision', '9')), /decision 9/);
  assert.match(refused(await notes('remove', 'step', '9')), /step 9/);
  refused(await notes('remove', 'question', '1'));
  refused(await notes('remove', 'constraint', '1'));
  refused(await notes('remove', 'note', '1'));
  assert.equal(read(), before);
});

test('remove --help names each kind', async (t) => {
  const { notes } = withWorktree(t);
  const help = passed(await notes('remove', '--help'));
  assert.match(help, /^Usage: ledger notes remove /);
  for (const kind of ['step', 'decision', 'constraint', 'question', 'note']) assert.match(help, new RegExp(`\\b${kind}\\b`));
});

test('--task names the task from anywhere in its repo', async (t) => {
  const { app, run, file } = withWorktree(t);
  assert.equal(passed(await run(app, 'notes', 'note', 'From the main checkout.', '--task', 'wt')), 'Added a note to wt.');
  assert.match(readLedgerFile(file), /^From the main checkout\.$/m);
});

test('a folder with no task of its own needs --task', async (t) => {
  const { app, run } = withWorktree(t);
  const ran = await run(app, 'notes', 'note', 'Where does this go?');
  assert.equal(ran.status, 1);
  assert.equal(ran.stderr.trim(), 'No task in this folder. Pass --task <slug>.');
  assert.equal((await run(app, 'notes', 'check')).status, 1);
});

test('an archived task is refused', async (t) => {
  const { h, app, run } = setup(t);
  archivedTask(h, app, '2026-11-01', { slug: 'old', main: app });
  assert.match(refused(await run(app, 'notes', 'note', 'Too late.', '--task', 'old')), /old/);
  assert.match(refused(await run(app, 'notes', 'check', '--task', 'old')), /old/);
});

test('check prints ok for a sound ledger', async (t) => {
  const { notes } = withWorktree(t);
  assert.equal(passed(await notes('check')), 'ok');
  const result = JSON.parse(passed(await notes('check', '--json')));
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test('check lists an empty goal, a question that blocks a step not in the plan, and a report of a step not in the plan, and changes nothing', async (t) => {
  const { file, notes, read } = withWorktree(t, { goal: '' });
  writeLedgerFile(
    file,
    read()
      .replace('- <question> — blocks step <#>?', '- Which API? — blocks step 9')
      .replace('<paste the structured report for each step; replace with one line once the step is reviewed>', '- step 7: .claude/evidence/red.txt'),
  );
  const before = read();
  const ran = await notes('check');
  const problems = refused(ran).trim().split('\n');
  assert.equal(problems.length, 3, ran.stdout);
  assert.match(problems.join('\n'), /goal/i);
  assert.match(problems.join('\n'), /step 9/);
  assert.match(problems.join('\n'), /step 7/);
  const result = JSON.parse((await notes('check', '--json')).stdout);
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 3);
  assert.equal(read(), before);
});

test('check reports a ledger whose record would not read back the same, and every write to it is refused', async (t) => {
  // Only Markdown from before task records can be such a ledger: a backlog ledger kept as Markdown.
  const { h, app, run } = setup(t);
  const file = backlogTask(h, app, { slug: 'odd' });
  writeFileSync(file, ['# Task ledger — odd', '', '## Goal', 'Ship it.', '', '## Odd', '```', 'fenced', '```', '', '## Decisions', '- a', '```', ''].join('\n'));
  const before = readFileSync(file, 'utf8');
  assert.match(refused(await run(app, 'notes', 'check', '--task', 'odd')), /read back/);
  refused(await run(app, 'notes', 'note', 'Lost?', '--task', 'odd'));
  assert.equal(readFileSync(file, 'utf8'), before);
});

const STEP_REPORTS_PLACEHOLDER = '<paste the structured report for each step; replace with one line once the step is reviewed>';

/** The fixture ledger with steps 1 and 2 at `statuses` and `reports` under ## Subagent reports. */
function withReports(t: TestContext, statuses: [string, string], reports: string[]) {
  const s = withWorktree(t);
  writeLedgerFile(
    s.file,
    s
      .read()
      .replace('| 1 | write the tests | done |', `| 1 | write the tests | ${statuses[0]} |`)
      .replace('| 2 | implement | todo |', `| 2 | implement | ${statuses[1]} |`)
      .replace(STEP_REPORTS_PLACEHOLDER, reports.join('\n')),
  );
  return s;
}

const MULTI_LINE_REPORTS = ['- step 1: Ten tests written.', '  All ten fail as expected.', '', '  Evidence in red.txt.', '- step 2: Implemented.', '  Nine pass.'];

test('a write shortens the report of a reviewed or done step, in any case, to its first line, and keeps the report of a todo or green step', async (t) => {
  const cases: [[string, string], string[]][] = [
    [['reviewed', 'todo'], ['note', 'x']],
    [[' Done ', 'green'], ['next', 'Review step 2.']],
  ];
  for (const [statuses, write] of cases) {
    const { notes, read } = withReports(t, statuses, MULTI_LINE_REPORTS);
    passed(await notes(...write));
    assert.deepEqual(linesOf(read(), /^## Subagent reports$/), ['- step 1: Ten tests written.', '- step 2: Implemented.', '  Nine pass.'], statuses.join());
    assert.equal(passed(await notes('check')), 'ok');
  }
});

test('a shortened report whose first line is over 160 characters is cut to 160, ending in an ellipsis', async (t) => {
  const long = 'a'.repeat(300);
  const { notes, read } = withReports(t, ['reviewed', 'todo'], [`- step 1: ${long}`, '  more']);
  passed(await notes('note', 'x'));
  const [report] = linesOf(read(), /^## Subagent reports$/);
  const text = report.slice('- step 1: '.length);
  assert.equal(text.length, 160);
  assert.equal(text, `${'a'.repeat(159)}…`);
});

/** The fixture ledger made over 16,000 characters by its notes, decisions and constraints, largest first. */
function withLargeLedger(t: TestContext) {
  const s = withWorktree(t);
  const many = (count: number, line: (index: number) => string): string => Array.from({ length: count }, (_, index) => line(index)).join('\n');
  writeLedgerFile(
    s.file,
    s
      .read()
      .replace('- Keep the old format — because real ledgers use it [observed]', many(60, (i) => `- Decision ${i} ${'d'.repeat(60)} — because it helps [observed]`))
      .replace('- <constraint> — found in <file/report> [observed]', many(30, (i) => `- Constraint ${i} ${'c'.repeat(60)} — found in a.ts [observed]`))
      .concat('## Notes\n', many(100, (i) => `Note ${i} ${'n'.repeat(80)}`), '\n'),
  );
  return s;
}

/** The `## ` sections of `markdown` with their character counts, largest first. */
function sectionSizes(markdown: string): [string, number][] {
  const sections = markdown.split(/\n(?=## )/).filter((part) => part.startsWith('## '));
  return sections.map((part): [string, number] => [part.split('\n')[0].slice(3).replace(/ \(.*\)$/, ''), part.length]).sort((a, b) => b[1] - a[1]);
}

const SIZE_PROBLEM = /^The ledger is [\d,]+ characters, over the limit of 16,000\. Shorten the largest sections: Notes \([\d,]+\), Decisions \([\d,]+\), Constraints discovered \([\d,]+\)\.$/;

test('check fails on a ledger over 16,000 characters and names its three largest sections, and changes nothing', async (t) => {
  const { notes, read } = withLargeLedger(t);
  const before = read();
  const problems = refused(await notes('check')).trim().split('\n');
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], SIZE_PROBLEM);
  assert.equal(read(), before);
});

test('a write to a ledger over 16,000 characters succeeds and warns of its size, with the counts of the written ledger', async (t) => {
  const { notes, read } = withLargeLedger(t);
  const ran = await notes('note', 'One more.');
  passed(ran);
  const written = read();
  assert.match(written, /^One more\.$/m);
  const top = sectionSizes(written)
    .slice(0, 3)
    .map(([name, size]) => `${name} (${size.toLocaleString('en-US')})`)
    .join(', ');
  const expected = `The ledger is ${written.length.toLocaleString('en-US')} characters, over the limit of 16,000. Shorten the largest sections: ${top}.`;
  assert.match(expected, SIZE_PROBLEM);
  assert.equal(ran.stderr.trim(), `warning: ${expected}`);
});

test('writes to an active ledger at the same time all land, as each holds the lock of its record', async (t) => {
  const { worktree, env, read } = withWorktree(t, {}, { realGit: true });
  const runs = await Promise.all(
    Array.from(
      { length: 5 },
      (_, index) =>
        new Promise<Ran>((resolve, reject) => {
          const child = spawnAsync(LEDGER_BIN, ['notes', 'note', `note ${index}`], { cwd: worktree, env: { ...env, LEDGER_TEST_DELAY_MS: '300' } });
          let stdout = '';
          let stderr = '';
          child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
          child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
          child.on('error', reject);
          child.on('close', (status) => resolve({ status, stdout, stderr }));
        }),
    ),
  );
  for (const ran of runs) passed(ran);
  assert.deepEqual(linesOf(read(), /^## Notes$/).sort(), ['note 0', 'note 1', 'note 2', 'note 3', 'note 4']);
});

const STORES: { storage: Storage; skip: string | false }[] = [
  { storage: 'file', skip: false },
  { storage: 'sqlite', skip: noSqlite },
  { storage: 'git', skip: false },
];

for (const { storage, skip } of STORES) {
  test(`${storage} store: every write command changes a backlog task, and a refused write changes nothing`, { skip }, async (t) => {
    const { h, app, run: inProcess, spawned } = setup(t, storage);
    const run = storage === 'git' ? spawned : inProcess;
    passed(await run(app, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.'));
    const notes = (...args: string[]): Promise<Ran> => run(app, 'notes', ...args, '--task', 'fix-login');
    const show = async (): Promise<string> => passed(await run(app, 'show', 'fix-login'));
    const evidence = path.join(h, 'red.txt');
    writeFileSync(evidence, 'failing\n');

    assert.equal(passed(await notes('plan', 'add', 'write the tests', '--owner', 'opus-implementer')), 'Added step 1 to fix-login.');
    passed(await notes('plan', 'approve'));
    passed(await notes('step', '1', '--status', 'in progress', '--note', 'started'));
    passed(await notes('decide', 'Use tokens', '--because', 'sessions expire', '--tag', 'observed'));
    passed(await notes('constraint', 'No new dependencies', '--source', 'the operator'));
    passed(await notes('question', 'Which provider?', '--blocks', '1'));
    passed(await notes('question', 'Which port?'));
    passed(await notes('question', '--resolve', '2'));
    passed(await notes('report', '--step', '1', '--file', evidence));
    passed(await notes('report', '--parent', 'Login works again.'));
    passed(await notes('note', 'The provider has a sandbox.'));
    passed(await notes('next', 'Write the tests.'));
    assert.equal(passed(await notes('check')), 'ok');

    const shown = await show();
    assert.match(shown, new RegExp(`^## Plan \\(approved ${TODAY}\\)$`, 'm'));
    assert.deepEqual(linesOf(shown, /^## Plan/).slice(2), ['| 1 | write the tests | in progress | opus-implementer | started |']);
    assert.deepEqual(linesOf(shown, /^## Decisions$/), [`- ${TODAY}: Use tokens — because sessions expire [observed]`]);
    assert.deepEqual(linesOf(shown, /^## Constraints discovered$/), ['- No new dependencies — found in the operator']);
    assert.deepEqual(linesOf(shown, /^## Open questions$/), ['- Which provider? — blocks step 1', '- (resolved) Which port?']);
    assert.deepEqual(linesOf(shown, /^## Subagent reports$/), [`- step 1: ${evidence}`]);
    assert.deepEqual(linesOf(shown, /^## Report$/), ['Login works again.']);
    assert.deepEqual(linesOf(shown, /^## Next step$/), ['Write the tests.']);
    assert.deepEqual(linesOf(shown, /^## Notes$/), ['The provider has a sandbox.']);

    refused(await notes('question', '--resolve', '2'));
    refused(await notes('report', '--step', '2', '--file', evidence));
    refused(await notes('step', '2', '--status', 'done'));
    refused(await notes('plan', 'add', 'a | b', '--owner', 'reviewer'));
    assert.equal(await show(), shown);
    refused(await run(app, 'notes', 'note', 'No task here.'));

    if (storage === 'git') assert.equal(git(h, path.join(h, '.claude/ledger-data'), 'status', '--porcelain'), '');
  });
}

const CODE_STAGES = 'plan, red, build, verify, review, pr';

/** The worktree task `wt` with Location bullets, such as `- kind:` and `- stage:`, set as given. */
function withStage(t: TestContext, location: Record<string, string> = {}) {
  const task = withWorktree(t);
  const bullets = Object.entries(location).map(([key, value]) => `- ${key}: ${value}`);
  writeLedgerFile(task.file, task.read().replace('- design refs: none\n', ['- design refs: none', ...bullets, ''].join('\n')));
  const stage = (): string | undefined => task.read().match(/^- stage: (.*)$/m)?.[1];
  const stageNotes = (): string[] => linesOf(task.read(), /^## Notes$/).filter((line) => line.includes(' stage '));
  return { ...task, stage, stageNotes };
}

test('stage pass moves a task with no kind or stage from plan through the code stages to finished, with a note each', async (t) => {
  const { notes, stage, stageNotes } = withStage(t);
  assert.equal(stage(), undefined);
  assert.equal(passed(await notes('stage', 'plan', 'pass')), 'Stage plan of wt passed; next is red.');
  assert.equal(stage(), 'red');
  for (const name of ['red', 'build', 'verify', 'review']) passed(await notes('stage', name, 'pass'));
  assert.equal(stage(), 'pr');
  assert.equal(passed(await notes('stage', 'pr', 'pass')), 'Stage pr of wt passed; wt is finished.');
  assert.equal(stage(), 'finished');
  assert.deepEqual(
    stageNotes(),
    ['plan', 'red', 'build', 'verify', 'review', 'pr'].map((name) => `${TODAY} stage ${name} pass`),
  );
});

test('stage follows the stages of the docs and investigation kinds', async (t) => {
  const docs = withStage(t, { kind: 'docs', stage: 'plan' });
  passed(await docs.notes('stage', 'plan', 'pass'));
  assert.equal(docs.stage(), 'build');
  const investigation = withStage(t, { kind: 'investigation', stage: 'report' });
  passed(await investigation.notes('stage', 'report', 'pass'));
  assert.equal(investigation.stage(), 'review');
  passed(await investigation.notes('stage', 'review', 'pass'));
  assert.equal(investigation.stage(), 'finished');
});

test('stage fail keeps the stage, and with --back returns to an earlier one; each leaves a note', async (t) => {
  const { notes, stage, stageNotes } = withStage(t, { stage: 'review' });
  assert.equal(passed(await notes('stage', 'review', 'fail')), 'Stage review of wt failed; it stays at review.');
  assert.equal(stage(), 'review');
  assert.equal(
    passed(await notes('stage', 'review', 'fail', '--back', 'build')),
    'Stage review of wt failed; back to build. Review rejected 2 times: run the next round at higher effort and tell the operator.',
  );
  assert.equal(stage(), 'build');
  assert.deepEqual(stageNotes(), [`${TODAY} stage review fail`, `${TODAY} stage review fail, back to build`]);
});

test('stage --skip passes the current stage and keeps the reason in the note', async (t) => {
  const { notes, stage, stageNotes } = withStage(t, { stage: 'red' });
  assert.equal(passed(await notes('stage', 'red', '--skip', 'a copy change has no test')), 'Skipped stage red of wt; next is build.');
  assert.equal(stage(), 'build');
  assert.deepEqual(stageNotes(), [`${TODAY} stage red skipped: a copy change has no test`]);
});

test('stage pass --step sets the status of the plan step by the stage passed, and so does --skip', async (t) => {
  const { notes, read } = withStage(t, { stage: 'red' });
  const status = (n: string): string | undefined => linesOf(read(), /^## Plan/).find((row) => row.startsWith(`| ${n} |`))?.split('|')[3].trim();
  passed(await notes('stage', 'red', 'pass', '--step', '2'));
  assert.equal(status('2'), 'red');
  passed(await notes('stage', 'build', 'pass', '--step', '2'));
  assert.equal(status('2'), 'green');
  passed(await notes('stage', 'verify', '--skip', 'verified in build', '--step', '1'));
  assert.equal(status('1'), 'done');
  passed(await notes('stage', 'review', 'pass', '--step', '2'));
  assert.equal(status('2'), 'reviewed');
});

test('stage refuses a stage that is not the current one, and says how to skip or go back', async (t) => {
  const { notes, read } = withStage(t, { stage: 'build' });
  const before = read();
  const later = refused(await notes('stage', 'review', 'pass'));
  assert.match(later, /--skip/);
  assert.match(later, /build/);
  assert.match(later, new RegExp(CODE_STAGES));
  assert.match(refused(await notes('stage', 'verify', '--skip', 'no time')), /--skip at the current stage/);
  const earlier = refused(await notes('stage', 'red', 'fail'));
  assert.match(earlier, /fail --back/);
  assert.match(earlier, new RegExp(CODE_STAGES));
  assert.equal(read(), before);
});

test('stage refuses a name that is not a stage of the kind, an unknown kind, and a finished task', async (t) => {
  const code = withStage(t, { stage: 'build' });
  const before = code.read();
  const unknown = refused(await code.notes('stage', 'investigate', 'pass'));
  assert.match(unknown, /investigate/);
  assert.match(unknown, /build/);
  assert.match(unknown, new RegExp(CODE_STAGES));
  assert.equal(code.read(), before);

  const odd = withStage(t, { kind: 'poetry' });
  assert.match(refused(await odd.notes('stage', 'plan', 'pass')), /poetry.*code, docs, investigation|code, docs, investigation.*poetry/);

  const finished = withStage(t, { kind: 'docs', stage: 'finished' });
  const done = finished.read();
  const message = refused(await finished.notes('stage', 'pr', 'pass'));
  assert.match(message, /finished/);
  assert.match(message, /plan, build, review, pr/);
  assert.equal(finished.read(), done);
});

test('stage refuses a wrong outcome, both or neither of an outcome and --skip, --back where it does not belong, --step with fail, and an empty reason', async (t) => {
  const { notes, read } = withStage(t, { stage: 'review' });
  const before = read();
  const refusals = [
    ['stage', 'review', 'maybe'],
    ['stage', 'review', 'pass', '--skip', 'no reviewer'],
    ['stage', 'review'],
    ['stage', 'review', 'pass', '--back', 'build'],
    ['stage', 'review', '--skip', 'no reviewer', '--back', 'build'],
    ['stage', 'review', 'fail', '--step', '2'],
    ['stage', 'review', '--skip', ' '],
    ['stage', 'review', '--skip', 'two\nlines'],
    ['stage', 'review', 'fail', '--back', 'review'],
    ['stage', 'review', 'fail', '--back', 'pr'],
    ['stage', 'review', 'fail', '--back', 'investigate'],
    ['stage', 'review', 'pass', '--step', '9'],
  ];
  for (const args of refusals) {
    const message = refused(await notes(...args));
    assert.match(message, /review/, args.join(' '));
    assert.match(message, new RegExp(CODE_STAGES), args.join(' '));
  }
  assert.equal(read(), before);
});

test('check lists an unknown kind, and a stage that is not a stage of the kind', async (t) => {
  const odd = withStage(t, { kind: 'poetry' });
  assert.match(refused(await odd.notes('check')), /poetry/);
  const lost = withStage(t, { kind: 'docs', stage: 'red' });
  const problems = refused(await lost.notes('check'));
  assert.match(problems, /red/);
  assert.match(problems, /plan, build, review, pr/);
  assert.equal(passed(await withStage(t, { stage: 'finished' }).notes('check')), 'ok');
});

const reviewRounds = (markdown: string): string | undefined => linesOf(markdown, /^## Location$/).find((line) => line.startsWith('- review rounds:'));

/** Runs build and verify again after a task went back to build, then rejects its review, sending it back to build. */
async function rejectReview({ notes }: ReturnType<typeof withStage>): Promise<string> {
  passed(await notes('stage', 'build', 'pass'));
  passed(await notes('stage', 'verify', 'pass'));
  return passed(await notes('stage', 'review', 'fail', '--back', 'build'));
}

test('each rejected review adds one to the review rounds under ## Location, and ledger show prints them', async (t) => {
  const task = withStage(t, { stage: 'review' });
  assert.equal(reviewRounds(task.read()), undefined);
  passed(await task.notes('stage', 'review', 'fail', '--back', 'build'));
  assert.equal(reviewRounds(task.read()), '- review rounds: 1');
  await rejectReview(task);
  assert.equal(reviewRounds(task.read()), '- review rounds: 2');
  assert.match(passed(await task.run(task.worktree, 'show')), /^- review rounds: 2$/m);
});

test('the second rejected review asks for higher effort; the third blocks the task on "review rejected three times"; a fourth counts 4 and leaves it blocked', async (t) => {
  const task = withStage(t, { stage: 'review' });
  passed(await task.notes('stage', 'review', 'fail', '--back', 'build'));
  const second = await rejectReview(task);
  assert.ok(second.startsWith('Stage review of wt failed; back to build.'), second);
  assert.ok(second.includes('Review rejected 2 times: run the next round at higher effort and tell the operator.'), second);
  assert.doesNotMatch(second, /blocked/);
  assert.doesNotMatch(task.read(), /^- status: blocked/m);

  const third = await rejectReview(task);
  assert.ok(third.includes('Review rejected 3 times: wt is blocked; ask the operator what to do.'), third);
  assert.doesNotMatch(third, /higher effort/);
  assert.match(task.read(), new RegExp(`^- status: blocked ${TODAY} — review rejected three times$`, 'm'));
  assert.equal(reviewRounds(task.read()), '- review rounds: 3');

  const fourth = await rejectReview(task);
  assert.ok(fourth.includes('Review rejected 4 times: wt is blocked; ask the operator what to do.'), fourth);
  assert.match(task.read(), new RegExp(`^- status: blocked ${TODAY} — review rejected three times$`, 'm'));
  assert.equal(reviewRounds(task.read()), '- review rounds: 4');
});

test('a passed review keeps the count of rejected rounds', async (t) => {
  const task = withStage(t, { stage: 'review' });
  passed(await task.notes('stage', 'review', 'fail', '--back', 'build'));
  passed(await task.notes('stage', 'build', 'pass'));
  passed(await task.notes('stage', 'verify', 'pass'));
  passed(await task.notes('stage', 'review', 'pass'));
  assert.equal(task.stage(), 'pr');
  assert.equal(reviewRounds(task.read()), '- review rounds: 1');
});

test('a failed stage other than review leaves the review rounds alone', async (t) => {
  const task = withStage(t, { stage: 'verify' });
  passed(await task.notes('stage', 'verify', 'fail', '--back', 'build'));
  passed(await task.notes('stage', 'build', 'pass'));
  passed(await task.notes('stage', 'verify', 'fail'));
  assert.equal(reviewRounds(task.read()), undefined);
  passed(await task.notes('stage', 'verify', 'pass'));
  assert.equal(passed(await task.notes('stage', 'review', 'fail', '--back', 'build')), 'Stage review of wt failed; back to build.');
  assert.equal(reviewRounds(task.read()), '- review rounds: 1');
});

test('a third rejected review of a task that is blocked already keeps its own block reason', async (t) => {
  const task = withStage(t, { stage: 'review', 'review rounds': '2', status: 'blocked 2026-11-01 — waiting for the API key' });
  const third = passed(await task.notes('stage', 'review', 'fail', '--back', 'build'));
  assert.ok(third.includes('Review rejected 3 times: wt is blocked; ask the operator what to do.'), third);
  assert.match(task.read(), /^- status: blocked 2026-11-01 — waiting for the API key$/m);
  assert.equal(reviewRounds(task.read()), '- review rounds: 3');
});

test('a third rejected review of a parked or waiting task is refused, as it cannot become blocked; a lost task is refused as one not on this machine; neither changes anything', async (t) => {
  const cases: [string, (worktree: string) => string, RegExp][] = [
    ['parked', () => '- status: parked 2026-11-01 — later', /wt is parked, so it cannot become blocked\./],
    ['waiting', () => '- status: waiting 2026-11-01', /wt is waiting, so it cannot become blocked\./],
    ['lost', (worktree) => `- lost: 2026-11-01 — folder ${worktree} not found`, /not on this machine/],
  ];
  for (const [state, bullet, refusal] of cases) {
    const task = withStage(t, { stage: 'review', 'review rounds': '2' });
    writeLedgerFile(task.file, task.read().replace('- design refs: none\n', `- design refs: none\n${bullet(task.worktree)}\n`));
    const before = task.read();
    assert.match(refused(await task.run(task.app, 'notes', 'stage', 'review', 'fail', '--back', 'build', '--task', 'wt')), refusal, state);
    assert.equal(task.read(), before, state);
  }
});

test('a third rejected review of a backlog task, named with --task, does not block it and does not say it is blocked', async (t) => {
  const { h, app, run } = setup(t);
  const file = backlogTask(h, app, { slug: 'later' });
  writeLedgerFile(file, readLedgerFile(file).replace('- design refs: none\n', '- design refs: none\n- stage: review\n- review rounds: 2\n'));
  const third = passed(await run(app, 'notes', 'stage', 'review', 'fail', '--back', 'build', '--task', 'later'));
  assert.equal(third, 'Stage review of later failed; back to build. Review rejected 3 times: ask the operator what to do.');
  assert.doesNotMatch(readLedgerFile(file), /^- status:/m);
  assert.equal(reviewRounds(readLedgerFile(file)), '- review rounds: 3');
  const { tasks } = JSON.parse(passed(await run(app, 'list', '--json'))) as { tasks: { slug: string; status: string }[] };
  assert.equal(tasks.find(({ slug }) => slug === 'later')?.status, 'backlog');
});
