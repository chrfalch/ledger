import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { addChild, addDecision, markRetired, park, putChildReport, unpark } from '../tools/ledger/edit.js';
import { parseLedger, planProgress, plainLine, type Ledger } from '../tools/ledger/format.js';
import { parseRecord, readRecordJson, renderRecord, validateRecord, type TaskRecord } from '../tools/ledger/record.js';
import { REPO } from './helpers.js';
import { ledgerText } from './ledger-core-fixtures.js';

const FIXTURES = path.join(REPO, 'tests/fixtures');
const TEMPLATE = readFileSync(path.join(REPO, 'ledger.template.md'), 'utf8');
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, 'ledgers', name), 'utf8');

/** Every .md under tests/fixtures that is a ledger, by its path relative to tests/fixtures. */
const ledgerFixtures = (): [string, string][] =>
  readdirSync(FIXTURES, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.md'))
    .map((file): [string, string] => [file, readFileSync(path.join(FIXTURES, file), 'utf8')])
    .filter(([, text]) => /^# Task ledger/m.test(text));

const inputs = (): [string, string][] => [['ledger.template.md', TEMPLATE], ...ledgerFixtures()];

/** The lines of ledger.template.md that hold a placeholder, and its preamble: the only text the converter may drop. */
const TEMPLATE_ONLY = new Set(
  TEMPLATE.split('\n')
    .filter((line) => line.includes('<') || line.startsWith('Read this first') || line.startsWith('Facts, not narrative'))
    .map((line) => line.trim()),
);

/** A line as the no-text-loss check compares it: runs of whitespace as one space, none next to a table bar or a comma. */
const normalised = (line: string): string => line.replace(/\s+/g, ' ').replace(/ ?([|,]) ?/g, '$1').trim();

const droppable = (line: string): boolean => line.trim() === '' || TEMPLATE_ONLY.has(line.trim());

/** `## Plan (approved …)` is the section Plan. */
const sectionName = (heading: string): string => heading.replace(/ \(.*\)$/, '');

/** The lines of `text`, heading included, by the name of the section they are under; '' for the lines above the first heading. */
function sectionsOf(text: string): { name: string; lines: string[] }[] {
  const ledger = parseLedger(text);
  const plain = ledger.lines.map(plainLine);
  const top = { name: '', lines: plain.slice(0, ledger.sections[0]?.start ?? plain.length) };
  return [top, ...ledger.sections.map(({ heading, start, end }) => ({ name: sectionName(heading), lines: plain.slice(start, end) }))];
}

/**
 * The lines of `markdown` that the rendered record does not hold in their section, or holds out of their order there.
 * The rendered section and its copies among the notes count as one run of lines, in document order; lines above the
 * first heading may land in ## Notes. The title, headings, and Location bullets, which render in a fixed order, only need
 * to be there.
 */
function lostOrMoved(markdown: string): string[] {
  const rendered = sectionsOf(renderRecord(parseRecord(markdown)));
  const runs = new Map<string, string[]>();
  const runOf = (name: string): string[] => {
    const targets = name === '' ? ['', 'Notes'] : [name];
    if (!runs.has(name)) runs.set(name, rendered.filter((section) => targets.includes(section.name)).flatMap(({ lines }) => lines.map(normalised)));
    return runs.get(name) ?? [];
  };
  const next = new Map<string, number>();
  const problems: string[] = [];
  for (const { name, lines } of sectionsOf(markdown)) {
    const run = runOf(name);
    for (const line of lines.filter((each) => !droppable(each))) {
      const wanted = normalised(line);
      const ordered = name !== 'Location' && !/^#{1,2} /.test(line);
      const at = run.indexOf(wanted, ordered ? (next.get(name) ?? 0) : 0);
      if (at === -1) problems.push(`${name || 'top'}: ${line}`);
      else if (ordered) next.set(name, at + 1);
    }
  }
  return problems;
}

/** What the plugin reads from a ledger, without line numbers, which a rendering moves. */
function readByPlugin(text: string) {
  const ledger: Ledger = parseLedger(text);
  const { parent, ...location } = ledger.location;
  const withoutLine = <T extends { line: number }>({ line: _line, ...rest }: T) => rest;
  return {
    slug: ledger.slug,
    location: { ...location, ...(parent === undefined ? {} : { parent: withoutLine(parent) }) },
    children: ledger.children.map(withoutLine),
    parked: ledger.parked && withoutLine(ledger.parked),
    goal: ledger.goal,
    next: ledger.next,
    report: ledger.report,
    plan: planProgress(ledger),
  };
}

for (const [name, markdown] of inputs()) {
  test(`record of ${name}: it is valid, and rendering then parsing gives the same record`, () => {
    const record = parseRecord(markdown);
    assert.deepEqual(validateRecord(JSON.parse(JSON.stringify(record))), record);
    assert.deepEqual(parseRecord(renderRecord(record)), record);
  });

  test(`record of ${name}: every line but the template's placeholders is in the rendered Markdown, in its section and in order`, () => {
    assert.deepEqual(lostOrMoved(markdown), []);
  });

  test(`record of ${name}: the plugin reads the rendered Markdown as it reads the original`, () => {
    assert.deepEqual(readByPlugin(renderRecord(parseRecord(markdown))), readByPlugin(markdown));
  });
}

test('the fixtures hold the fully filled ledger, the one with literal lines and the one with stray lines', () => {
  assert.deepEqual(
    ledgerFixtures()
      .map(([name]) => name)
      .sort(),
    ['ledgers/full.md', 'ledgers/literal.md', 'ledgers/stray.md'],
  );
});

test('a line that only looks like a placeholder is kept: an HTML comment, an autolink, a <draft> decision', () => {
  const record = parseRecord(fixture('literal.md'));
  assert.equal(record.goal, '<!-- keep this note -->\nKeep every line that only looks like a placeholder.');
  assert.equal(record.pr, '<https://github.com/org/repo/pull/12>');
  assert.deepEqual(record.report, ['<https://github.com/org/repo/pull/12>', 'Merged.']);
  assert.deepEqual(record.decisions[1], { text: '<draft> stays as written', reason: 'only template strings are placeholders' });
  assert.equal(record.worktree, undefined);
  assert.equal(record.designRefs, undefined);
  assert.equal(record.plan.approved, undefined);
});

test('a wrapped line and a nested bullet stay with the item above them, and render back in place', () => {
  const markdown = fixture('literal.md');
  const record = parseRecord(markdown);
  assert.equal(record.plan.steps[0].note, 'first line of the note\n  a wrapped second line of the note');
  assert.deepEqual(record.decisions[0], { text: 'Keep literal lines', reason: 'they are content [observed]\n  wrapped onto a second line\n  - a sub point under it' });
  assert.deepEqual(record.constraints, [{ text: 'Autolinks look like placeholders', source: 'review\n  - and HTML comments do too' }]);
  assert.deepEqual(record.stepReports, [{ step: '1', text: 'parsed\n  details on a second line' }]);
  assert.deepEqual(record.questions, [{ id: 1, text: 'Is a wrapped question kept?\n  It is, as one question.', blocks: 2 }]);
  assert.deepEqual(record.notes, []);
  for (const block of ['| 1 | parse | done | opus-implementer | first line of the note |\n  a wrapped second line of the note\n| 2 |', '\n  wrapped onto a second line\n  - a sub point under it\n- <draft>']) {
    assert.ok(renderRecord(record).includes(block), block);
  }
});

const FULL: TaskRecord = {
  version: 1,
  slug: 'wf-task-records',
  title: 'Task records',
  kind: 'feature',
  state: 'active',
  stage: 'implement',
  parent: { slug: 'wf-records', main: '/repos/ledger' },
  order: 2,
  dependencies: [{ slug: 'wf-command-groups' }, { slug: 'wf-repo-identity', main: '/repos/ledger' }],
  claim: { session: '42', since: '2026-11-20T10:00:00Z', active: '2026-11-20T11:30:00Z' },
  pr: 'https://github.com/chrfalch/ledger/pull/109',
  repo: 'github.com/chrfalch/ledger',
  worktree: '/repos/ledger/.claude/worktrees/wf-task-records',
  branch: 'wf-task-records',
  base: { ref: 'origin/main', commit: '5c5a860' },
  main: '/repos/ledger',
  designRefs: ['0', '1'],
  parked: { date: '2026-11-21', reason: 'waiting for review' },
  goal: 'Backlog and archived ledgers become structured task records in every store.\n\nThe store keeps its string API as an adapter.',
  plan: {
    approved: '2026-11-20',
    steps: [
      { n: '1', step: 'write the failing tests', status: 'done', owner: 'opus-implementer', note: 'red run saved' },
      { n: '2', step: 'implement the record type', status: 'green', owner: 'opus-implementer', note: '' },
      { n: '1-10', step: 'rounds of review', status: 'todo', owner: 'reviewer', note: 'ranges stay as written' },
    ],
  },
  decisions: [
    { text: 'Keep the string API', reason: 'callers stay unchanged', tag: 'inferred' },
    { date: '2026-11-20', text: 'Store one JSON file per task', reason: 'git diffs stay small', tag: 'observed' },
    { text: 'Render placeholders for empty sections' },
    { text: 'Tags stay apart', tag: 'confirmed' },
  ],
  constraints: [
    { text: 'node:sqlite cuts TEXT at a NUL byte', source: 'sqlite-store.ts:11', tag: 'observed' },
    { text: 'No any in TypeScript', tag: 'observed' },
  ],
  questions: [
    { id: 1, text: 'Should records keep the date?', blocks: 2 },
    { id: 2, text: 'Is SQLite JSON1 always there?' },
    { id: 3, text: 'Does the git store need a new allowlist?', blocks: 3, resolved: true },
  ],
  stepReports: [{ step: '1', text: 'red run saved to .claude/evidence/red-records.txt' }, { text: 'reviewer approved round 2 [confirmed]' }],
  report: ['Records land in all three stores.', '  PR https://github.com/chrfalch/ledger/pull/109'],
  children: [
    { slug: 'records-file', main: '/repos/ledger', suffix: '(retired 2026-11-20)', mark: { kind: 'retired', date: '2026-11-20' } },
    { slug: 'records-sqlite', suffix: '(started 2026-11-21; by hand)', mark: { kind: 'started', date: '2026-11-21' } },
    { slug: 'records-git', suffix: '' },
  ],
  notes: ['The operator prefers small PRs.'],
  next: 'Run the reviewer at medium effort.',
};

test('a fully filled ledger maps each section and Location bullet to its field', () => {
  assert.deepEqual(parseRecord(fixture('full.md')), FULL);
});

test('a ledger already in the template layout renders back byte for byte: a filled one and a task fixture', () => {
  for (const markdown of [fixture('full.md'), ledgerText({ slug: 'fix-login', main: '/repos/app' })]) {
    assert.equal(renderRecord(parseRecord(markdown)), markdown);
  }
});

test('the template renders back without its design refs placeholder: unset design refs is no line, as in a repo without llp/', () => {
  assert.equal(renderRecord(parseRecord(TEMPLATE)), TEMPLATE.replace(/^- design refs: .*\n/m, ''));
});

test('the template parses to an empty record: placeholders, example rows and the preamble are dropped', () => {
  assert.deepEqual(parseRecord(TEMPLATE), {
    version: 1,
    slug: '',
    goal: '',
    plan: { steps: [] },
    decisions: [],
    constraints: [],
    questions: [],
    stepReports: [],
    report: [],
    children: [],
    notes: [],
    next: '',
  });
});

test('lines that fit no item go to the notes, each group after its section heading, general notes first', () => {
  const record = parseRecord(fixture('stray.md'));
  assert.deepEqual(record.notes, [
    'Front matter that sits above the title.',
    'A general note.',
    '',
    'Another one, after a blank line.',
    '## Location',
    '- owner: someone',
    'just a sentence in Location',
    '## Plan (draft)',
    '## Subagent reports',
    '### Step 1',
    'Status: green',
    '',
    'Tests: 12 pass.',
    '## Child reports',
    '### part-one',
    'Part one is done.',
    '## Risks',
    '- The parser may drop a line.',
    '## Decisions',
    '- A second Decisions section is not the first.',
  ]);
  assert.equal(record.worktree, '/a/second/worktree');
  assert.deepEqual(record.plan.steps, [{ n: '1', step: 'only step', status: 'todo', owner: 'me', note: '\n| 2 | too | many | cells | here | extra |\nA line under the table.' }]);
  assert.deepEqual(record.decisions, [{ text: 'Use records', reason: 'they are typed [observed]\n  a continuation line of that decision' }]);
  assert.equal(record.parked, undefined);
  assert.equal(record.next, 'Parked: 2026-11-21 — a later marker is a note');
});

test('general notes render under ## Notes, after ## Next step', () => {
  const rendered = renderRecord({ ...parseRecord(TEMPLATE), slug: 'x', notes: ['one', '## Risks', 'two'] });
  assert.match(rendered, /## Next step\n<exactly one action, with the agent and effort to use>\n\n## Notes\none\n\n## Risks\ntwo\n$/);
});

test('a record round-trips through Markdown: every field set, and a record with no optional field', () => {
  assert.deepEqual(parseRecord(renderRecord(FULL)), FULL);
  const bare = parseRecord(TEMPLATE);
  assert.deepEqual(parseRecord(renderRecord(bare)), bare);
  const none: TaskRecord = { ...bare, slug: 'no-llp', designRefs: 'none' };
  assert.deepEqual(parseRecord(renderRecord(none)), none);
});

test('validateRecord rejects a wrong shape and names where', () => {
  const valid = JSON.parse(JSON.stringify(FULL)) as Record<string, unknown>;
  const rejects = (value: unknown, where: RegExp): void => assert.throws(() => validateRecord(value), where);
  rejects('text', /not an object/);
  rejects({ ...valid, version: 2 }, /version/);
  rejects({ ...valid, goal: undefined }, /goal/);
  rejects({ ...valid, plan: { steps: [{ ...FULL.plan.steps[0], status: 3 }] } }, /plan\.steps\[0\]\.status/);
  rejects({ ...valid, decisions: [{ reason: 'no text' }] }, /decisions\[0\]\.text/);
  rejects({ ...valid, colour: 'red' }, /colour/);
  rejects({ ...valid, designRefs: 'all' }, /designRefs/);
  rejects({ ...valid, questions: [{ id: '1', text: 'q' }] }, /questions\[0\]\.id/);
  rejects({ ...valid, claim: 'session 42' }, /claim is not an object/);
  rejects({ ...valid, claim: { session: '42', since: '2026-11-20T10:00:00.000Z', active: '2026-11-20T11:30:00Z' } }, /claim\.since is not a time such as 2026-11-20T10:00:00Z/);
  rejects({ ...valid, claim: { session: '42', since: '2026-11-20T10:00:00Z', active: '2026-13-20T11:30:00Z' } }, /claim\.active/);
  rejects({ ...valid, claim: { session: '42', since: '2026-11-20T10:00:00Z' } }, /claim\.active is missing/);
  rejects({ ...valid, claim: { session: 'two words', since: '2026-11-20T10:00:00Z', active: '2026-11-20T11:30:00Z' } }, /claim/);
});

test('a claim bullet in any other form than session <id> since <time>, active <time> is no claim: it stays in the notes, under ## Location', () => {
  for (const value of ['session 42', 'session 42 since 2026-11-20T10:00:00Z', 'session 42 since 2026-11-20T10:00:00.000Z, active 2026-11-20T11:30:00Z', 'session 42 since yesterday, active today']) {
    const record = parseRecord(fixture('full.md').replace(/^- claim: .*$/m, `- claim: ${value}`));
    assert.equal(record.claim, undefined, value);
    assert.deepEqual(record.notes.slice(1), ['## Location', `- claim: ${value}`], value);
  }
});

test('validateRecord rejects a record its Markdown cannot carry, so every valid record round-trips', () => {
  const valid = JSON.parse(JSON.stringify(FULL)) as TaskRecord;
  assert.throws(() => validateRecord({ ...valid, decisions: [{ text: 'a — because b' }] }), /decisions/);
  assert.throws(() => validateRecord({ ...valid, goal: 'one\n## Heading' }), /goal/);
  assert.throws(() => validateRecord({ ...valid, questions: [{ id: 7, text: 'q' }] }), /questions/);
  assert.throws(() => validateRecord({ ...valid, children: [{ slug: 'a', suffix: '', mark: { kind: 'retired', date: '2026-01-01' } }] }), /children/);
});

test('ledger editors applied to rendered Markdown change only their field of the record', () => {
  const record = parseRecord(fixture('full.md'));
  const markdown = renderRecord(record);
  const after = (edited: string): TaskRecord => parseRecord(edited);

  assert.deepEqual(after(park(markdown, 'Parked: 2026-11-22 — on hold')), { ...record, parked: { date: '2026-11-22', reason: 'on hold' } });
  assert.deepEqual(after(unpark(markdown)), (({ parked: _parked, ...rest }) => rest)(record));
  assert.deepEqual(after(addChild(markdown, '- records-docs')), { ...record, children: [...record.children, { slug: 'records-docs', suffix: '' }] });
  const sqliteChild = parseLedger(markdown).children[1];
  assert.deepEqual(after(markRetired(markdown, sqliteChild, '2026-11-22')).children[1], {
    slug: 'records-sqlite',
    suffix: '(retired 2026-11-22; by hand)',
    mark: { kind: 'retired', date: '2026-11-22' },
  });
  assert.deepEqual(after(putChildReport(markdown, 'records-file', ['Done.'])), { ...record, notes: [...record.notes, '## Child reports', '### records-file', 'Done.'] });
  assert.deepEqual(after(addDecision(markdown, '- Ship it — because it is green [confirmed]')), {
    ...record,
    decisions: [...record.decisions, { text: 'Ship it', reason: 'it is green', tag: 'confirmed' }],
  });
});

test('a second child report replaces the first in the notes, as it replaces it in Markdown', () => {
  const once = putChildReport(renderRecord(parseRecord(fixture('full.md'))), 'records-file', ['First.']);
  const twice = putChildReport(renderRecord(parseRecord(once)), 'records-file', ['Second.']);
  assert.deepEqual(parseRecord(twice).notes.slice(-3), ['## Child reports', '### records-file', 'Second.']);
});

test('a report keeps one blank line between its paragraphs, as the goal and the next step do', () => {
  const markdown = TEMPLATE.replace(/^## Report\n.*$/m, '## Report\n\nMerged in #109.\n\n\nThe parent must know:\nthe store API is unchanged.\n');
  const record = parseRecord(markdown);
  assert.deepEqual(record.report, ['Merged in #109.', '', 'The parent must know:', 'the store API is unchanged.']);
  assert.match(renderRecord(record), /\n## Report\nMerged in #109\.\n\nThe parent must know:\nthe store API is unchanged\.\n\n## Next step\n/);
  assert.deepEqual(validateRecord(JSON.parse(JSON.stringify(record))), record);
});

test('a next step that reads like a parked marker stays the next step, and is not read as parked', () => {
  const record: TaskRecord = { ...parseRecord(TEMPLATE), slug: 'x', next: 'Parked: 2026-01-01 — in the text' };
  const rendered = renderRecord(record);
  assert.equal(parseLedger(rendered).parked, undefined);
  assert.deepEqual(parseRecord(rendered), record);
});

test('a Windows line ending reads as the same record', () => {
  const markdown = fixture('full.md');
  assert.deepEqual(parseRecord(markdown.replace(/\n/g, '\r\n')), parseRecord(markdown));
});

const REPEATED_SECTIONS: [string, string, string[]][] = [
  ['an empty ## Children, then one with a child line', '# Task ledger — dup\n\n## Children\n\n## Children\n- deploy\n', ['## Children', '- deploy']],
  ['an empty ## Notes, then one with a line', '# Task ledger — dup\n\n## Notes\n\n## Notes\nlater\n', ['## Notes', 'later']],
  ['an empty ## Notes, an unknown section, then ## Notes again', '# Task ledger — dup\n\n## Notes\n\n## Foo\nx\n\n## Notes\ny\n', ['## Foo', 'x', '## Notes', 'y']],
];

for (const [what, markdown, notes] of REPEATED_SECTIONS) {
  test(`a repeated section, ${what}: the first is the section, the repeat a note under its heading, and the record round-trips`, () => {
    const record = parseRecord(markdown);
    assert.deepEqual([record.children, record.notes], [[], notes]);
    assert.deepEqual(parseRecord(renderRecord(record)), record);
    assert.deepEqual(validateRecord(JSON.parse(JSON.stringify(record))), record);
    assert.deepEqual(readByPlugin(renderRecord(record)), readByPlugin(markdown));
    assert.deepEqual(lostOrMoved(markdown), []);
  });
}

const WITHOUT_PLAN_ROWS: [string, string][] = [
  ['no ## Plan section', '# Task ledger — bare\n\n## Goal\nShip it.\n\n## Next step\nStart.\n'],
  ['a plan table without rows', '# Task ledger — bare\n\n## Plan (approved 2026-11-20)\n| # | step | status | owner | note |\n|---|------|--------|-------|------|\n\n## Next step\nStart.\n'],
  ['a plan of prose only', '# Task ledger — bare\n\n## Plan\nNo plan yet.\n'],
];

for (const [what, markdown] of WITHOUT_PLAN_ROWS) {
  test(`a ledger with ${what} gains no plan step from the round trip, so the plugin reads the same progress`, () => {
    const rendered = renderRecord(parseRecord(markdown));
    assert.equal(planProgress(parseLedger(rendered)).current, null);
    assert.deepEqual(readByPlugin(rendered), readByPlugin(markdown));
    assert.deepEqual(parseRecord(rendered), parseRecord(markdown));
  });
}

const EXAMPLE_ROW = '| 1 | <step> | todo / red / green / reviewed / done | <agent> | <one line> |';

test('a plan row of other than five cells is no step: it stays as written in the note of the step above it', () => {
  const markdown = TEMPLATE.replace(EXAMPLE_ROW, '| 1 | write tests | done | me | red run |\n| 2 | review |');
  const record = parseRecord(markdown);
  assert.deepEqual(record.plan.steps, [{ n: '1', step: 'write tests', status: 'done', owner: 'me', note: 'red run\n| 2 | review |' }]);
  assert.match(renderRecord(record), /^\| 2 \| review \|$/m);
  assert.deepEqual(readByPlugin(renderRecord(record)), readByPlugin(markdown));
  assert.deepEqual(lostOrMoved(markdown), []);
});

test('a plan table of fewer columns keeps every line as written, its separator too', () => {
  const markdown = '# Task ledger — short\n\n## Plan\n| # | step |\n|---|---|\n| 1 | write tests |\n';
  assert.deepEqual(lostOrMoved(markdown), []);
  assert.deepEqual(parseRecord(renderRecord(parseRecord(markdown))), parseRecord(markdown));
});

test('a plan row whose cells hold an escaped bar is a step of five cells, and a bar after an escaped backslash still ends a cell', () => {
  const rows = ['| 1 | keep a \\| in a cell | done | me | and \\| here |', '| 2 | end on a backslash \\\\| todo | me | n |'];
  const markdown = TEMPLATE.replace(EXAMPLE_ROW, rows.join('\n'));
  const record = parseRecord(markdown);
  assert.deepEqual(record.plan.steps, [
    { n: '1', step: 'keep a \\| in a cell', status: 'done', owner: 'me', note: 'and \\| here' },
    { n: '2', step: 'end on a backslash \\\\', status: 'todo', owner: 'me', note: 'n' },
  ]);
  assert.deepEqual(record.notes, []);
  assert.ok(renderRecord(record).includes(`${rows[0]}\n`));
  assert.deepEqual(parseRecord(renderRecord(record)), record);
  assert.deepEqual(validateRecord(JSON.parse(JSON.stringify(record))), record);
  assert.deepEqual(readByPlugin(renderRecord(record)), readByPlugin(markdown));
  assert.deepEqual(lostOrMoved(markdown), []);
});

test('every valid record round-trips whole: the time a task was created is kept by the store beside the record, not in it', () => {
  const stored = { ...(JSON.parse(JSON.stringify(FULL)) as Record<string, unknown>), created: '2026-11-01T12:00:00.000Z' };
  assert.throws(() => validateRecord(stored), /created/);
  assert.deepEqual(readRecordJson(JSON.stringify(stored), 'fix.json'), FULL);
  assert.throws(
    () => readRecordJson(JSON.stringify({ ...stored, created: 'yesterday' }), 'fix.json'),
    (error: Error) => error.message.startsWith('fix.json: ') && /created/.test(error.message),
  );
});
