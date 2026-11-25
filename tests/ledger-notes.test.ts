import assert from 'node:assert/strict';
import { spawn as spawnAsync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Storage } from '../tools/ledger/settings.js';
import { today } from '../tools/ledger/write.js';
import { REPO } from './helpers.js';
import { FORMAT } from '../tools/ledger/clone.js';
import { archivedTask, backlogTask, commandEnv, git, home, LEDGER_BIN, noSqlite, readLedgerFile, repository, worktreeOf, worktreeTask, writeLedgerFile, type Ran } from './ledger-core-fixtures.js';

const TODAY = today();

type Setup = { h: string; app: string; env: NodeJS.ProcessEnv; run: (cwd: string, ...args: string[]) => Ran };

function setup(t: TestContext, storage: Storage = 'file'): Setup {
  const h = home(t);
  copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
  if (storage === 'git') {
    const clone = path.join(h, '.claude/ledger-data');
    spawnSync('git', ['init', '--quiet', clone]);
    writeFileSync(path.join(clone, '.ledger-data'), `${JSON.stringify({ format: FORMAT })}\n`);
  }
  if (storage !== 'file') writeFileSync(path.join(h, '.claude/ledger-settings.json'), JSON.stringify({ storage }));
  const app = repository(h, path.join(h, 'repos', 'app'));
  writeFileSync(path.join(app, '.git/info/exclude'), '.claude/\n');
  const env = { ...commandEnv(h), LEDGER_TEST_NO_BACKGROUND_SYNC: '1' };
  const run = (cwd: string, ...args: string[]): Ran => {
    const result = spawnSync(LEDGER_BIN, args, { cwd, env, encoding: 'utf8' });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  return { h, app, env, run };
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
function withWorktree(t: TestContext, fields: { goal?: string } = {}) {
  const s = setup(t);
  const file = worktreeTask(s.h, s.app, { slug: 'wt', main: s.app, ...fields });
  const worktree = worktreeOf(s.app, 'wt');
  const read = (): string => readLedgerFile(file);
  const notes = (...args: string[]): Ran => s.run(worktree, 'notes', ...args);
  return { ...s, file, worktree, read, notes };
}

const linesOf = (markdown: string, heading: RegExp): string[] => {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => heading.test(line));
  assert.notEqual(start, -1, `no heading ${heading} in:\n${markdown}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end).filter((line) => line !== '');
};

test('plan add appends a todo step numbered after the highest, from a subfolder of the worktree, and prints its number', (t) => {
  const { worktree, run, read } = withWorktree(t);
  mkdirSync(path.join(worktree, 'src'));
  assert.equal(passed(run(path.join(worktree, 'src'), 'notes', 'plan', 'add', 'review', '--owner', 'reviewer')), 'Added step 3 to wt.');
  assert.equal(passed(run(worktree, 'notes', 'plan', 'add', 'fix the review', '--owner', 'opus-implementer', '--note', 'after review')), 'Added step 4 to wt.');
  const rows = linesOf(read(), /^## Plan/);
  assert.equal(rows.at(-2), '| 3 | review | todo | reviewer | |');
  assert.equal(rows.at(-1), '| 4 | fix the review | todo | opus-implementer | after review |');
});

test('plan add --json gives the new step', (t) => {
  const { notes } = withWorktree(t);
  const result = JSON.parse(passed(notes('plan', 'add', 'review', '--owner', 'reviewer', '--json')));
  assert.equal(result.ok, true);
  assert.deepEqual(result.step, { n: '3', step: 'review', status: 'todo', owner: 'reviewer', note: '' });
});

test('plan add refuses a missing or empty owner, an empty step, and a step that would not read back, and writes nothing', (t) => {
  const { notes, read } = withWorktree(t);
  const before = read();
  refused(notes('plan', 'add', 'review'));
  refused(notes('plan', 'add', 'review', '--owner', ''));
  refused(notes('plan', 'add', '  ', '--owner', 'reviewer'));
  refused(notes('plan', 'add', 'a | b', '--owner', 'reviewer'));
  assert.equal(read(), before);
});

test('plan approve sets the approval date to today, in place of an earlier one', (t) => {
  const { notes, read } = withWorktree(t);
  assert.match(read(), /^## Plan \(approved 2026-11-01\)$/m);
  passed(notes('plan', 'approve'));
  assert.match(read(), new RegExp(`^## Plan \\(approved ${TODAY}\\)$`, 'm'));
  assert.doesNotMatch(read(), /2026-11-01/);
});

test('step sets the status of a step, replaces its note, or both, and prints the step', (t) => {
  const { notes, read } = withWorktree(t);
  assert.equal(passed(notes('step', '2', '--status', 'in review')), 'Updated step 2 of wt.');
  assert.equal(linesOf(read(), /^## Plan/).at(-1), '| 2 | implement | in review | opus-implementer | |');
  passed(notes('step', '1', '--note', 'reviewed: tests seen failing'));
  assert.equal(linesOf(read(), /^## Plan/).at(-2), '| 1 | write the tests | done | opus-implementer | reviewed: tests seen failing |');
  const result = JSON.parse(passed(notes('step', '2', '--status', 'done', '--note', 'merged', '--json')));
  assert.deepEqual(result.step, { n: '2', step: 'implement', status: 'done', owner: 'opus-implementer', note: 'merged' });
  assert.equal(linesOf(read(), /^## Plan/).at(-1), '| 2 | implement | done | opus-implementer | merged |');
});

test('step --note "" clears the note and keeps the status', (t) => {
  const { notes, read } = withWorktree(t);
  passed(notes('step', '1', '--note', ''));
  assert.equal(linesOf(read(), /^## Plan/).at(-2), '| 1 | write the tests | done | opus-implementer | |');
});

test('step refuses no --status and no --note, an empty status, an unknown step, and a note that would not read back, and writes nothing', (t) => {
  const { notes, read } = withWorktree(t);
  const before = read();
  assert.match(refused(notes('step', '2')), /--status/);
  refused(notes('step', '2', '--status', ' '));
  assert.match(refused(notes('step', '9', '--status', 'done')), /wt has no step 9/);
  refused(notes('step', 'two', '--status', 'done'));
  refused(notes('step', '2', '--note', 'a | b'));
  assert.equal(read(), before);
});

test('decide appends a dated, tagged decision with its reason', (t) => {
  const { notes, read } = withWorktree(t);
  assert.equal(passed(notes('decide', 'Use SQLite', '--because', 'it locks rows', '--tag', 'confirmed')), 'Added decision 2 to wt.');
  assert.equal(linesOf(read(), /^## Decisions$/).at(-1), `- ${TODAY}: Use SQLite — because it locks rows [confirmed]`);
  const result = JSON.parse(passed(notes('decide', 'Keep files', '--because', 'they are simple', '--tag', 'inferred', '--json')));
  assert.deepEqual(result.decision, { text: 'Keep files', reason: 'they are simple', tag: 'inferred', date: TODAY });
});

test('decide refuses a missing reason or tag, an unknown tag and empty text, and writes nothing', (t) => {
  const { notes, read } = withWorktree(t);
  const before = read();
  refused(notes('decide', 'Use SQLite', '--tag', 'observed'));
  refused(notes('decide', 'Use SQLite', '--because', 'it locks rows'));
  refused(notes('decide', 'Use SQLite', '--because', 'it locks rows', '--tag', 'guessed'));
  refused(notes('decide', '', '--because', 'it locks rows', '--tag', 'observed'));
  refused(notes('decide', 'Use SQLite', '--because', ' ', '--tag', 'observed'));
  assert.equal(read(), before);
});

test('constraint appends a constraint with its source, and its tag when given', (t) => {
  const { notes, read } = withWorktree(t);
  assert.equal(passed(notes('constraint', 'Node 22 or later', '--source', 'package.json')), 'Added constraint 1 to wt.');
  assert.equal(passed(notes('constraint', 'No network in hooks', '--source', 'hooks.ts', '--tag', 'observed')), 'Added constraint 2 to wt.');
  assert.deepEqual(linesOf(read(), /^## Constraints discovered$/), ['- Node 22 or later — found in package.json', '- No network in hooks — found in hooks.ts [observed]']);
});

test('constraint refuses a missing source, an unknown tag and empty text, and writes nothing', (t) => {
  const { notes, read } = withWorktree(t);
  const before = read();
  refused(notes('constraint', 'Node 22'));
  refused(notes('constraint', 'Node 22', '--source', 'package.json', '--tag', 'maybe'));
  refused(notes('constraint', '', '--source', 'package.json'));
  assert.equal(read(), before);
});

test('question adds an open question, with the step it blocks, and prints its id', (t) => {
  const { notes, read } = withWorktree(t);
  assert.equal(passed(notes('question', 'Which API?')), 'Added question 1 to wt.');
  assert.equal(passed(notes('question', 'Which port?', '--blocks', '2')), 'Added question 2 to wt.');
  assert.deepEqual(linesOf(read(), /^## Open questions$/), ['- Which API?', '- Which port? — blocks step 2']);
  assert.equal(JSON.parse(passed(notes('question', 'Which host?', '--json'))).question.id, 3);
});

test('question --blocks takes only a positive whole number', (t) => {
  const { notes, read } = withWorktree(t);
  const before = read();
  for (const blocks of ['0', '-1', 'two', '1.5', '']) refused(notes('question', 'Which API?', '--blocks', blocks));
  assert.equal(read(), before);
});

test('question --resolve marks an open question resolved; an unknown or resolved id, text with --resolve, or neither is refused', (t) => {
  const { notes, read } = withWorktree(t);
  passed(notes('question', 'Which API?'));
  passed(notes('question', 'Which port?'));
  assert.equal(passed(notes('question', '--resolve', '2')), 'Resolved question 2 of wt.');
  assert.deepEqual(linesOf(read(), /^## Open questions$/), ['- Which API?', '- (resolved) Which port?']);
  const before = read();
  refused(notes('question', '--resolve', '2'));
  refused(notes('question', '--resolve', '3'));
  refused(notes('question', '--resolve', 'x'));
  refused(notes('question', 'Which host?', '--resolve', '1'));
  refused(notes('question'));
  assert.equal(read(), before);
});

test('a write that leaves a problem warns on stderr and still exits 0', (t) => {
  const { notes, read } = withWorktree(t);
  const ran = notes('question', 'Which API?', '--blocks', '9');
  passed(ran);
  assert.match(ran.stderr, /^warning: .*step 9/m);
  assert.match(read(), /- Which API\? — blocks step 9/);
});

test('report --step stores the path of an existing file, relative to the worktree, and replaces an earlier report of that step', (t) => {
  const { worktree, run, notes, read } = withWorktree(t);
  mkdirSync(path.join(worktree, '.claude/evidence'), { recursive: true });
  writeFileSync(path.join(worktree, '.claude/evidence/red.txt'), 'failing\n');
  writeFileSync(path.join(worktree, '.claude/evidence/green.txt'), 'passing\n');
  passed(notes('report', '--step', '1', '--file', '.claude/evidence/red.txt'));
  passed(run(path.join(worktree, '.claude'), 'notes', 'report', '--step', '2', '--file', 'evidence/red.txt'));
  passed(notes('report', '--step', '1', '--file', path.join(worktree, '.claude/evidence/green.txt')));
  assert.deepEqual(linesOf(read(), /^## Subagent reports$/), ['- step 1: .claude/evidence/green.txt', '- step 2: .claude/evidence/red.txt']);
});

test('report --step stores a file outside the worktree as an absolute path', (t) => {
  const { h, notes, read } = withWorktree(t);
  const outside = path.join(h, 'report.md');
  writeFileSync(outside, 'report\n');
  passed(notes('report', '--step', '2', '--file', outside));
  assert.deepEqual(linesOf(read(), /^## Subagent reports$/), [`- step 2: ${outside}`]);
});

test('report refuses a step not in the plan, a missing file, and --step and --file without each other or with --parent', (t) => {
  const { worktree, notes, read } = withWorktree(t);
  writeFileSync(path.join(worktree, 'red.txt'), 'failing\n');
  const before = read();
  refused(notes('report', '--step', '9', '--file', 'red.txt'));
  refused(notes('report', '--step', '1', '--file', 'missing.txt'));
  refused(notes('report', '--step', '1'));
  refused(notes('report', '--file', 'red.txt'));
  refused(notes('report', '--parent', 'Done.', '--step', '1', '--file', 'red.txt'));
  refused(notes('report', '--parent', 'Done.', '--step', '1'));
  refused(notes('report', '--parent', ''));
  refused(notes('report'));
  assert.equal(read(), before);
});

const SCRATCHPAD_ADVICE = /Move the file to \.claude\/evidence\/ in the task's worktree and cite that path/;

test('report --file refuses a file in a session scratchpad, by its path or by where a link to it lands, and writes nothing', (t) => {
  const { h, worktree, notes, read } = withWorktree(t);
  const session = path.join(h, 'tmp/claude-501/proj/0b7c2a8e-6f1d-4c3b-9a2e-5d4f3e2a1b0c');
  mkdirSync(path.join(session, 'scratchpad'), { recursive: true });
  const scratch = path.join(session, 'scratchpad/x.txt');
  writeFileSync(scratch, 'the red run\n');
  mkdirSync(path.join(worktree, '.claude/evidence'), { recursive: true });
  writeFileSync(path.join(worktree, '.claude/evidence/x.txt'), 'the red run\n');
  const before = read();

  assert.match(refused(notes('report', '--step', '1', '--file', scratch)), SCRATCHPAD_ADVICE);
  symlinkSync(path.join(session, 'scratchpad'), path.join(worktree, 'out'));
  assert.match(refused(notes('report', '--step', '1', '--file', 'out/x.txt')), SCRATCHPAD_ADVICE);
  assert.equal(read(), before);

  passed(notes('report', '--step', '1', '--file', '.claude/evidence/x.txt'));
  assert.deepEqual(linesOf(read(), /^## Subagent reports$/), ['- step 1: .claude/evidence/x.txt']);
});

test('every notes text that cites a session scratchpad is refused, and nothing is written', (t) => {
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
    const refusal = refused(notes(...args));
    assert.match(refusal, SCRATCHPAD_ADVICE, args.join(' '));
    assert.doesNotMatch(refusal, /two separate commands/, args.join(' '));
  }
  assert.equal(read(), before);

  passed(notes('decide', 'Keep the red run', '--because', 'see .claude/evidence/x.txt', '--tag', 'observed'));
});

test('report --parent sets ## Report to the text, line by line, in place of an earlier one', (t) => {
  const { notes, read } = withWorktree(t);
  passed(notes('report', '--parent', 'First try.'));
  passed(notes('report', '--parent', 'Merged.\nPR: https://example.com/pr/1'));
  assert.deepEqual(linesOf(read(), /^## Report$/), ['Merged.', 'PR: https://example.com/pr/1']);
  assert.deepEqual(linesOf(read(), /^## Subagent reports$/), ['<paste the structured report for each step; replace with one line once the step is reviewed>']);
});

test('note appends to the general notes; next replaces the next step', (t) => {
  const { notes, read } = withWorktree(t);
  passed(notes('note', 'The CI is slow on Mondays.'));
  passed(notes('note', 'Ask about the cache.'));
  assert.deepEqual(linesOf(read(), /^## Notes$/), ['The CI is slow on Mondays.', 'Ask about the cache.']);
  passed(notes('next', 'Implement step 2 with opus-implementer at high effort.'));
  assert.deepEqual(linesOf(read(), /^## Next step$/), ['Implement step 2 with opus-implementer at high effort.']);
  const before = read();
  refused(notes('note', ''));
  refused(notes('next', ' '));
  assert.equal(read(), before);
});

test('--task names the task from anywhere in its repo', (t) => {
  const { app, run, file } = withWorktree(t);
  assert.equal(passed(run(app, 'notes', 'note', 'From the main checkout.', '--task', 'wt')), 'Added a note to wt.');
  assert.match(readLedgerFile(file), /^From the main checkout\.$/m);
});

test('a folder with no task of its own needs --task', (t) => {
  const { app, run } = withWorktree(t);
  const ran = run(app, 'notes', 'note', 'Where does this go?');
  assert.equal(ran.status, 1);
  assert.equal(ran.stderr.trim(), 'No task in this folder. Pass --task <slug>.');
  assert.equal(run(app, 'notes', 'check').status, 1);
});

test('an archived task is refused', (t) => {
  const { h, app, run } = setup(t);
  archivedTask(h, app, '2026-11-01', { slug: 'old', main: app });
  assert.match(refused(run(app, 'notes', 'note', 'Too late.', '--task', 'old')), /old/);
  assert.match(refused(run(app, 'notes', 'check', '--task', 'old')), /old/);
});

test('check prints ok for a sound ledger', (t) => {
  const { notes } = withWorktree(t);
  assert.equal(passed(notes('check')), 'ok');
  const result = JSON.parse(passed(notes('check', '--json')));
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test('check lists an empty goal, a question that blocks a step not in the plan, and a report of a step not in the plan, and changes nothing', (t) => {
  const { file, notes, read } = withWorktree(t, { goal: '' });
  writeLedgerFile(
    file,
    read()
      .replace('- <question> — blocks step <#>?', '- Which API? — blocks step 9')
      .replace('<paste the structured report for each step; replace with one line once the step is reviewed>', '- step 7: .claude/evidence/red.txt'),
  );
  const before = read();
  const ran = notes('check');
  const problems = refused(ran).trim().split('\n');
  assert.equal(problems.length, 3, ran.stdout);
  assert.match(problems.join('\n'), /goal/i);
  assert.match(problems.join('\n'), /step 9/);
  assert.match(problems.join('\n'), /step 7/);
  const result = JSON.parse(notes('check', '--json').stdout);
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 3);
  assert.equal(read(), before);
});

test('check reports a ledger whose record would not read back the same, and every write to it is refused', (t) => {
  // Only Markdown from before task records can be such a ledger: a backlog ledger kept as Markdown.
  const { h, app, run } = setup(t);
  const file = backlogTask(h, app, { slug: 'odd' });
  writeFileSync(file, ['# Task ledger — odd', '', '## Goal', 'Ship it.', '', '## Odd', '```', 'fenced', '```', '', '## Decisions', '- a', '```', ''].join('\n'));
  const before = readFileSync(file, 'utf8');
  assert.match(refused(run(app, 'notes', 'check', '--task', 'odd')), /read back/);
  refused(run(app, 'notes', 'note', 'Lost?', '--task', 'odd'));
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

test('a write shortens the report of a reviewed step to its first line, and keeps the report of a todo step', (t) => {
  const { notes, read } = withReports(t, ['reviewed', 'todo'], MULTI_LINE_REPORTS);
  passed(notes('note', 'x'));
  assert.deepEqual(linesOf(read(), /^## Subagent reports$/), ['- step 1: Ten tests written.', '- step 2: Implemented.', '  Nine pass.']);
  assert.equal(passed(notes('check')), 'ok');
});

test('a write shortens the report of a done step, in any case, and keeps the report of a green step', (t) => {
  const { notes, read } = withReports(t, [' Done ', 'green'], MULTI_LINE_REPORTS);
  passed(notes('next', 'Review step 2.'));
  assert.deepEqual(linesOf(read(), /^## Subagent reports$/), ['- step 1: Ten tests written.', '- step 2: Implemented.', '  Nine pass.']);
});

test('a shortened report whose first line is over 160 characters is cut to 160, ending in an ellipsis', (t) => {
  const long = 'a'.repeat(300);
  const { notes, read } = withReports(t, ['reviewed', 'todo'], [`- step 1: ${long}`, '  more']);
  passed(notes('note', 'x'));
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

test('check fails on a ledger over 16,000 characters and names its three largest sections, and changes nothing', (t) => {
  const { notes, read } = withLargeLedger(t);
  const before = read();
  const problems = refused(notes('check')).trim().split('\n');
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], SIZE_PROBLEM);
  assert.equal(read(), before);
});

test('a write to a ledger over 16,000 characters succeeds and warns of its size, with the counts of the written ledger', (t) => {
  const { notes, read } = withLargeLedger(t);
  const ran = notes('note', 'One more.');
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
  const { worktree, env, read } = withWorktree(t);
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
  test(`${storage} store: every write command changes a backlog task, and a refused write changes nothing`, { skip }, (t) => {
    const { h, app, run } = setup(t, storage);
    passed(run(app, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.'));
    const notes = (...args: string[]): Ran => run(app, 'notes', ...args, '--task', 'fix-login');
    const show = (): string => passed(run(app, 'show', 'fix-login'));
    const evidence = path.join(h, 'red.txt');
    writeFileSync(evidence, 'failing\n');

    assert.equal(passed(notes('plan', 'add', 'write the tests', '--owner', 'opus-implementer')), 'Added step 1 to fix-login.');
    passed(notes('plan', 'approve'));
    passed(notes('step', '1', '--status', 'in progress', '--note', 'started'));
    passed(notes('decide', 'Use tokens', '--because', 'sessions expire', '--tag', 'observed'));
    passed(notes('constraint', 'No new dependencies', '--source', 'the operator'));
    passed(notes('question', 'Which provider?', '--blocks', '1'));
    passed(notes('question', 'Which port?'));
    passed(notes('question', '--resolve', '2'));
    passed(notes('report', '--step', '1', '--file', evidence));
    passed(notes('report', '--parent', 'Login works again.'));
    passed(notes('note', 'The provider has a sandbox.'));
    passed(notes('next', 'Write the tests.'));
    assert.equal(passed(notes('check')), 'ok');

    const shown = show();
    assert.match(shown, new RegExp(`^## Plan \\(approved ${TODAY}\\)$`, 'm'));
    assert.deepEqual(linesOf(shown, /^## Plan/).slice(2), ['| 1 | write the tests | in progress | opus-implementer | started |']);
    assert.deepEqual(linesOf(shown, /^## Decisions$/), [`- ${TODAY}: Use tokens — because sessions expire [observed]`]);
    assert.deepEqual(linesOf(shown, /^## Constraints discovered$/), ['- No new dependencies — found in the operator']);
    assert.deepEqual(linesOf(shown, /^## Open questions$/), ['- Which provider? — blocks step 1', '- (resolved) Which port?']);
    assert.deepEqual(linesOf(shown, /^## Subagent reports$/), [`- step 1: ${evidence}`]);
    assert.deepEqual(linesOf(shown, /^## Report$/), ['Login works again.']);
    assert.deepEqual(linesOf(shown, /^## Next step$/), ['Write the tests.']);
    assert.deepEqual(linesOf(shown, /^## Notes$/), ['The provider has a sandbox.']);

    refused(notes('question', '--resolve', '2'));
    refused(notes('report', '--step', '2', '--file', evidence));
    refused(notes('step', '2', '--status', 'done'));
    refused(notes('plan', 'add', 'a | b', '--owner', 'reviewer'));
    assert.equal(show(), shown);
    refused(run(app, 'notes', 'note', 'No task here.'));

    if (storage === 'git') assert.equal(git(h, path.join(h, '.claude/ledger-data'), 'status', '--porcelain'), '');
  });
}

const CODE_STAGES = 'plan, red, build, verify, review, pr';

/** The worktree task `wt` with `- kind:` and `- stage:` bullets set as given. */
function withStage(t: TestContext, location: { kind?: string; stage?: string } = {}) {
  const task = withWorktree(t);
  const bullets = Object.entries(location).map(([key, value]) => `- ${key}: ${value}`);
  writeLedgerFile(task.file, task.read().replace('- design refs: none\n', ['- design refs: none', ...bullets, ''].join('\n')));
  const stage = (): string | undefined => task.read().match(/^- stage: (.*)$/m)?.[1];
  const stageNotes = (): string[] => linesOf(task.read(), /^## Notes$/).filter((line) => line.includes(' stage '));
  return { ...task, stage, stageNotes };
}

test('stage pass moves a task with no kind or stage from plan through the code stages to finished, with a note each', (t) => {
  const { notes, stage, stageNotes } = withStage(t);
  assert.equal(stage(), undefined);
  assert.equal(passed(notes('stage', 'plan', 'pass')), 'Stage plan of wt passed; next is red.');
  assert.equal(stage(), 'red');
  for (const name of ['red', 'build', 'verify', 'review']) passed(notes('stage', name, 'pass'));
  assert.equal(stage(), 'pr');
  assert.equal(passed(notes('stage', 'pr', 'pass')), 'Stage pr of wt passed; wt is finished.');
  assert.equal(stage(), 'finished');
  assert.deepEqual(
    stageNotes(),
    ['plan', 'red', 'build', 'verify', 'review', 'pr'].map((name) => `${TODAY} stage ${name} pass`),
  );
});

test('stage follows the stages of the docs and investigation kinds', (t) => {
  const docs = withStage(t, { kind: 'docs', stage: 'plan' });
  passed(docs.notes('stage', 'plan', 'pass'));
  assert.equal(docs.stage(), 'build');
  const investigation = withStage(t, { kind: 'investigation', stage: 'report' });
  passed(investigation.notes('stage', 'report', 'pass'));
  assert.equal(investigation.stage(), 'review');
  passed(investigation.notes('stage', 'review', 'pass'));
  assert.equal(investigation.stage(), 'finished');
});

test('stage fail keeps the stage, and with --back returns to an earlier one; each leaves a note', (t) => {
  const { notes, stage, stageNotes } = withStage(t, { stage: 'review' });
  assert.equal(passed(notes('stage', 'review', 'fail')), 'Stage review of wt failed; it stays at review.');
  assert.equal(stage(), 'review');
  assert.equal(
    passed(notes('stage', 'review', 'fail', '--back', 'build')),
    'Stage review of wt failed; back to build. Review rejected 2 times: run the next round at higher effort and tell the operator.',
  );
  assert.equal(stage(), 'build');
  assert.deepEqual(stageNotes(), [`${TODAY} stage review fail`, `${TODAY} stage review fail, back to build`]);
});

test('stage --skip passes the current stage and keeps the reason in the note', (t) => {
  const { notes, stage, stageNotes } = withStage(t, { stage: 'red' });
  assert.equal(passed(notes('stage', 'red', '--skip', 'a copy change has no test')), 'Skipped stage red of wt; next is build.');
  assert.equal(stage(), 'build');
  assert.deepEqual(stageNotes(), [`${TODAY} stage red skipped: a copy change has no test`]);
});

test('stage pass --step sets the status of the plan step by the stage passed, and so does --skip', (t) => {
  const { notes, read } = withStage(t, { stage: 'red' });
  const status = (n: string): string | undefined => linesOf(read(), /^## Plan/).find((row) => row.startsWith(`| ${n} |`))?.split('|')[3].trim();
  passed(notes('stage', 'red', 'pass', '--step', '2'));
  assert.equal(status('2'), 'red');
  passed(notes('stage', 'build', 'pass', '--step', '2'));
  assert.equal(status('2'), 'green');
  passed(notes('stage', 'verify', '--skip', 'verified in build', '--step', '1'));
  assert.equal(status('1'), 'done');
  passed(notes('stage', 'review', 'pass', '--step', '2'));
  assert.equal(status('2'), 'reviewed');
});

test('stage refuses a stage that is not the current one, and says how to skip or go back', (t) => {
  const { notes, read } = withStage(t, { stage: 'build' });
  const before = read();
  const later = refused(notes('stage', 'review', 'pass'));
  assert.match(later, /--skip/);
  assert.match(later, /build/);
  assert.match(later, new RegExp(CODE_STAGES));
  assert.match(refused(notes('stage', 'verify', '--skip', 'no time')), /--skip at the current stage/);
  const earlier = refused(notes('stage', 'red', 'fail'));
  assert.match(earlier, /fail --back/);
  assert.match(earlier, new RegExp(CODE_STAGES));
  assert.equal(read(), before);
});

test('stage refuses a name that is not a stage of the kind, an unknown kind, and a finished task', (t) => {
  const code = withStage(t, { stage: 'build' });
  const before = code.read();
  const unknown = refused(code.notes('stage', 'investigate', 'pass'));
  assert.match(unknown, /investigate/);
  assert.match(unknown, /build/);
  assert.match(unknown, new RegExp(CODE_STAGES));
  assert.equal(code.read(), before);

  const odd = withStage(t, { kind: 'poetry' });
  assert.match(refused(odd.notes('stage', 'plan', 'pass')), /poetry.*code, docs, investigation|code, docs, investigation.*poetry/);

  const finished = withStage(t, { kind: 'docs', stage: 'finished' });
  const done = finished.read();
  const message = refused(finished.notes('stage', 'pr', 'pass'));
  assert.match(message, /finished/);
  assert.match(message, /plan, build, review, pr/);
  assert.equal(finished.read(), done);
});

test('stage refuses a wrong outcome, both or neither of an outcome and --skip, --back where it does not belong, --step with fail, and an empty reason', (t) => {
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
    const message = refused(notes(...args));
    assert.match(message, /review/, args.join(' '));
    assert.match(message, new RegExp(CODE_STAGES), args.join(' '));
  }
  assert.equal(read(), before);
});

test('check lists an unknown kind, and a stage that is not a stage of the kind', (t) => {
  const odd = withStage(t, { kind: 'poetry' });
  assert.match(refused(odd.notes('check')), /poetry/);
  const lost = withStage(t, { kind: 'docs', stage: 'red' });
  const problems = refused(lost.notes('check'));
  assert.match(problems, /red/);
  assert.match(problems, /plan, build, review, pr/);
  assert.equal(passed(withStage(t, { stage: 'finished' }).notes('check')), 'ok');
});

const reviewRounds = (markdown: string): string | undefined => linesOf(markdown, /^## Location$/).find((line) => line.startsWith('- review rounds:'));

/** Runs build and verify again after a task went back to build, then rejects its review, sending it back to build. */
function rejectReview({ notes }: ReturnType<typeof withStage>): string {
  passed(notes('stage', 'build', 'pass'));
  passed(notes('stage', 'verify', 'pass'));
  return passed(notes('stage', 'review', 'fail', '--back', 'build'));
}

test('each rejected review adds one to the review rounds under ## Location, and ledger show prints them', (t) => {
  const task = withStage(t, { stage: 'review' });
  assert.equal(reviewRounds(task.read()), undefined);
  passed(task.notes('stage', 'review', 'fail', '--back', 'build'));
  assert.equal(reviewRounds(task.read()), '- review rounds: 1');
  rejectReview(task);
  assert.equal(reviewRounds(task.read()), '- review rounds: 2');
  assert.match(passed(task.run(task.worktree, 'show')), /^- review rounds: 2$/m);
});

test('the first rejected review prints what it printed before review rounds were counted', (t) => {
  const task = withStage(t, { stage: 'review' });
  assert.equal(passed(task.notes('stage', 'review', 'fail', '--back', 'build')), 'Stage review of wt failed; back to build.');
});

test('the second rejected review asks for the next round at higher effort and for the operator to be told', (t) => {
  const task = withStage(t, { stage: 'review' });
  passed(task.notes('stage', 'review', 'fail', '--back', 'build'));
  const second = rejectReview(task);
  assert.ok(second.startsWith('Stage review of wt failed; back to build.'), second);
  assert.ok(second.includes('Review rejected 2 times: run the next round at higher effort and tell the operator.'), second);
  assert.doesNotMatch(second, /blocked/);
  assert.doesNotMatch(task.read(), /^- status: blocked/m);
});

test('the third rejected review blocks the task on "review rejected three times" and says to ask the operator', (t) => {
  const task = withStage(t, { stage: 'review' });
  passed(task.notes('stage', 'review', 'fail', '--back', 'build'));
  rejectReview(task);
  const third = rejectReview(task);
  assert.ok(third.includes('Review rejected 3 times: wt is blocked; ask the operator what to do.'), third);
  assert.doesNotMatch(third, /higher effort/);
  assert.match(task.read(), new RegExp(`^- status: blocked ${TODAY} — review rejected three times$`, 'm'));
  assert.equal(reviewRounds(task.read()), '- review rounds: 3');
});

test('a passed review keeps the count of rejected rounds', (t) => {
  const task = withStage(t, { stage: 'review' });
  passed(task.notes('stage', 'review', 'fail', '--back', 'build'));
  passed(task.notes('stage', 'build', 'pass'));
  passed(task.notes('stage', 'verify', 'pass'));
  passed(task.notes('stage', 'review', 'pass'));
  assert.equal(task.stage(), 'pr');
  assert.equal(reviewRounds(task.read()), '- review rounds: 1');
});

test('a failed stage other than review leaves the review rounds alone', (t) => {
  const task = withStage(t, { stage: 'verify' });
  passed(task.notes('stage', 'verify', 'fail', '--back', 'build'));
  passed(task.notes('stage', 'build', 'pass'));
  passed(task.notes('stage', 'verify', 'fail'));
  assert.equal(reviewRounds(task.read()), undefined);
  passed(task.notes('stage', 'verify', 'pass'));
  assert.equal(passed(task.notes('stage', 'review', 'fail', '--back', 'build')), 'Stage review of wt failed; back to build.');
  assert.equal(reviewRounds(task.read()), '- review rounds: 1');
});
