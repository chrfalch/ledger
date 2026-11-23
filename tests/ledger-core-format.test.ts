import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { isNewSlug, isReadableSlug, parseLedger, serializeLedger } from '../tools/ledger/format.js';
import { ledgerText } from './ledger-core-fixtures.js';
import { REPO } from './helpers.js';

const TEMPLATE = readFileSync(path.join(REPO, 'ledger.template.md'), 'utf8');

const FILLED = ledgerText({
  slug: 'epic',
  goal: 'Ship the new core.',
  worktree: '/repos/app/.claude/worktrees/epic',
  branch: 'me/epic',
  base: 'origin/main @ f1830b5',
  parent: 'restart @ /repos/other',
  children: [
    '- live-child (started 2026-11-02)',
    '- old-a',
    '- old-b (retired 2026-10-21)',
    '- old-c (started 2026-10-20; PR #26 merged 2026-10-21)',
    '- old-d (LANDED 2026-11-03; retire pending)',
    '- lib-part @ /repos/lib',
    '- lib-two@/repos/lib (started 2026-11-05)',
  ],
  report: ['Merged in PR #12.', 'Nothing else.'],
  next: 'Parked: 2026-11-10 — waiting for review',
});

test('parse then serialize returns the same bytes: template, filled, CRLF, no final newline, empty', () => {
  for (const text of [TEMPLATE, FILLED, FILLED.replace(/\n/g, '\r\n'), FILLED.trimEnd(), '', '\n\n', 'no title at all\n']) {
    assert.equal(serializeLedger(parseLedger(text)), text);
  }
});

test('the template has a Report section with only a hint, directly before Next step', () => {
  assert.match(TEMPLATE, /\n## Report\n<[^\n]*>\n\n## Next step\n/);
});

test('the template has no slug, and every placeholder reads as not set', () => {
  const ledger = parseLedger(TEMPLATE);
  assert.equal(ledger.slug, undefined);
  assert.deepEqual(ledger.location, {});
  assert.deepEqual(ledger.children, []);
  assert.equal(ledger.parked, undefined);
  assert.equal(ledger.goal, '');
  assert.equal(ledger.next, '');
  assert.deepEqual(ledger.report, []);
});

test('the title gives the slug, with an em dash or a hyphen', () => {
  assert.equal(parseLedger('# Task ledger — epic  \n').slug, 'epic');
  assert.equal(parseLedger('# Task ledger - epic\n').slug, 'epic');
  assert.equal(parseLedger('# Notes\n').slug, undefined);
});

test('a title the reading rule does not accept gives no slug: spaces, a slash or an @', () => {
  for (const title of ['My Task', 'a/b', 'a@b']) assert.equal(parseLedger(`# Task ledger — ${title}\n`).slug, undefined, title);
  assert.equal(parseLedger('# Task ledger — Old.Task_2\n').slug, 'Old.Task_2');
});

test('sections are the ## headings with their line ranges', () => {
  const ledger = parseLedger(FILLED);
  const names = ledger.sections.map(({ heading }) => heading);
  assert.deepEqual(names, ['Goal', 'Location', 'Plan (approved 2026-11-01)', 'Decisions', 'Constraints discovered', 'Subagent reports', 'Open questions', 'Children', 'Report', 'Next step']);
  const goal = ledger.sections[0];
  assert.equal(ledger.lines[goal.start], '## Goal');
  assert.equal(ledger.lines[goal.start + 1], 'Ship the new core.');
});

test('Location fields: worktree, branch, base with its commit, parent in another repo', () => {
  const { location } = parseLedger(FILLED);
  assert.equal(location.worktree, '/repos/app/.claude/worktrees/epic');
  assert.equal(location.branch, 'me/epic');
  assert.deepEqual(location.base, { ref: 'origin/main', commit: 'f1830b5' });
  assert.equal(location.parent?.slug, 'restart');
  assert.equal(location.parent?.main, '/repos/other');
  assert.equal(parseLedger(FILLED).lines[location.parent?.line ?? -1], '- parent: restart @ /repos/other');
});

test('a parent in the same repo has no main; a backlog ledger has a main line', () => {
  const { location } = parseLedger(ledgerText({ slug: 'idea', main: '/repos/app', parent: 'epic' }));
  assert.equal(location.main, '/repos/app');
  assert.equal(location.parent?.slug, 'epic');
  assert.equal(location.parent?.main, undefined);
});

test('a main line that is no folder drops all from its first " (" when it ends in ")", and keeps parentheses that do not end it', () => {
  const main = (value: string): string | undefined => parseLedger(ledgerText({ slug: 'idea', main: value })).location.main;
  assert.equal(main('/repos/netinfo/netinfo (lib fork clone; moved here 2026-10-27, operator option 1)'), '/repos/netinfo/netinfo');
  assert.equal(main('/repos/r (fork (legacy))'), '/repos/r');
  assert.equal(main('/repos/old (2025)/app'), '/repos/old (2025)/app');
  assert.equal(main('/repos/old (2025)/app (renamed)'), '/repos/old');
});

test('a main line that is a folder whose name ends in parentheses keeps them; a missing one drops the note', (t: TestContext) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ledger-main-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const engine = path.join(root, 'engine (legacy)');
  mkdirSync(engine);
  const main = (value: string): string | undefined => parseLedger(ledgerText({ slug: 'idea', main: value })).location.main;
  assert.equal(main(engine), engine);
  assert.equal(main(path.join(root, 'x (note; moved here 2026-10-27)')), path.join(root, 'x'));
  const locked = path.join(root, 'locked');
  mkdirSync(locked);
  const hidden = path.join(locked, 'engine (legacy)');
  chmodSync(locked, 0o000);
  try {
    if (process.getuid?.() !== 0) assert.equal(main(hidden), hidden, 'a folder that cannot be read may be there');
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('a main line that is no absolute path, such as . or repos/app, names no main', () => {
  for (const value of ['.', 'repos/app', '. (the repo itself)']) {
    assert.equal(parseLedger(ledgerText({ slug: 'idea', main: value })).location.main, undefined, value);
  }
});

test('a parent line outside ## Location is not the parent', () => {
  const text = '# Task ledger — x\n\n## Location\n- parent: <slug>\n\n## Notes\n- parent: epic\n';
  assert.equal(parseLedger(text).location.parent, undefined);
});

test('Children: marks, cross-repo children in both forms, and hand-written suffixes kept verbatim', () => {
  const ledger = parseLedger(FILLED);
  const shown = ledger.children.map(({ slug, main, mark, suffix }) => ({ slug, main, mark, suffix }));
  assert.deepEqual(shown, [
    { slug: 'live-child', main: undefined, mark: { kind: 'started', date: '2026-11-02' }, suffix: '(started 2026-11-02)' },
    { slug: 'old-a', main: undefined, mark: undefined, suffix: '' },
    { slug: 'old-b', main: undefined, mark: { kind: 'retired', date: '2026-10-21' }, suffix: '(retired 2026-10-21)' },
    { slug: 'old-c', main: undefined, mark: { kind: 'started', date: '2026-10-20' }, suffix: '(started 2026-10-20; PR #26 merged 2026-10-21)' },
    { slug: 'old-d', main: undefined, mark: undefined, suffix: '(LANDED 2026-11-03; retire pending)' },
    { slug: 'lib-part', main: '/repos/lib', mark: undefined, suffix: '' },
    { slug: 'lib-two', main: '/repos/lib', mark: { kind: 'started', date: '2026-11-05' }, suffix: '(started 2026-11-05)' },
  ]);
  for (const child of ledger.children) assert.match(ledger.lines[child.line], new RegExp(`^- ${child.slug}\\b`));
});

test('Children lines with CRLF endings parse the same', () => {
  const crlf = parseLedger(FILLED.replace(/\n/g, '\r\n'));
  assert.deepEqual(
    crlf.children.map(({ slug, suffix }) => [slug, suffix]),
    parseLedger(FILLED).children.map(({ slug, suffix }) => [slug, suffix]),
  );
  assert.equal(crlf.location.branch, 'me/epic');
});

test('Parked: the first text under ## Next step, with an em dash or a hyphen; the next step skips it', () => {
  const ledger = parseLedger(FILLED);
  assert.deepEqual(ledger.parked && { date: ledger.parked.date, reason: ledger.parked.reason }, { date: '2026-11-10', reason: 'waiting for review' });
  assert.equal(ledger.next, '');
  const hyphen = parseLedger(ledgerText({ slug: 'x', next: 'Parked: 2026-11-10 - later\nRun the tests.' }));
  assert.equal(hyphen.parked?.reason, 'later');
  assert.equal(hyphen.next, 'Run the tests.');
  assert.equal(parseLedger(ledgerText({ slug: 'x', next: 'Run the tests.\nParked: 2026-11-10 — late' })).parked, undefined);
});

test('the next step skips only the parked marker: a later "Parked:" line is the next step when it comes first', () => {
  const twice = parseLedger(ledgerText({ slug: 'x', next: 'Parked: 2026-11-12 — now\nParked: 2026-11-01 — an old note\nRun the tests.' }));
  assert.equal(twice.parked?.reason, 'now');
  assert.equal(twice.next, 'Parked: 2026-11-01 — an old note');
  const unparked = parseLedger(ledgerText({ slug: 'x', next: '<what comes next>\nParked: 2026-11-01 — an old note\nRun the tests.' }));
  assert.equal(unparked.parked, undefined);
  assert.equal(unparked.next, 'Parked: 2026-11-01 — an old note');
});

test('a ## line inside a ``` code fence is not a heading, and the bytes still round-trip', () => {
  const text = [
    '# Task ledger — x',
    '',
    '## Decisions',
    '- The parser ignores fenced headings, as in this sample:',
    '```md',
    '## Next step',
    'Fake next step.',
    '## Children',
    '- fake-child',
    '```',
    '',
    '## Next step',
    'Real next step.',
    '',
  ].join('\n');
  const ledger = parseLedger(text);
  assert.deepEqual(ledger.sections.map(({ heading }) => heading), ['Decisions', 'Next step']);
  assert.equal(ledger.next, 'Real next step.');
  assert.deepEqual(ledger.children, []);
  assert.equal(serializeLedger(ledger), text);
});

test('an unclosed fence ends at the next ## heading, so the headings after it still count', () => {
  const text = [
    '# Task ledger — x',
    '',
    '## Decisions',
    '- A stray fence:',
    '```',
    'never closed',
    '',
    '## Children',
    '- real-child',
    '',
    '## Next step',
    'Real next step.',
    '',
  ].join('\n');
  const ledger = parseLedger(text);
  assert.deepEqual(ledger.sections.map(({ heading }) => heading), ['Decisions', 'Children', 'Next step']);
  assert.deepEqual(ledger.children.map(({ slug }) => slug), ['real-child']);
  assert.equal(ledger.next, 'Real next step.');
  assert.equal(serializeLedger(ledger), text);
});

test('a fence closes only on a bare fence of the same character, at least as long, indented less than four spaces', () => {
  const text = [
    '# Task ledger — x',
    '',
    '## Decisions',
    '````md',
    '```',
    '## Fake one',
    '````',
    '~~~',
    '```',
    '## Fake two',
    '~~~',
    '  ```',
    '```js',
    '    ```',
    '## Fake three',
    '   ```',
    '```inline``` is code in a line, not a fence',
    '',
    '## Children',
    '- inline-child',
    '```',
    'a closed fence',
    '```',
    '',
    '## Next step',
    'Real next step.',
    '',
  ].join('\n');
  const ledger = parseLedger(text);
  assert.deepEqual(ledger.sections.map(({ heading }) => heading), ['Decisions', 'Children', 'Next step']);
  assert.deepEqual(ledger.children.map(({ slug }) => slug), ['inline-child']);
  assert.equal(ledger.next, 'Real next step.');
});

test('a Next step heading with a suffix still counts', () => {
  assert.equal(parseLedger('# Task ledger — x\n\n## Next step (after review)\nMerge it.\n').next, 'Merge it.');
});

test('goal and report: placeholders and the template hint are no text', () => {
  const ledger = parseLedger(FILLED);
  assert.equal(ledger.goal, 'Ship the new core.');
  assert.deepEqual(ledger.report, ['Merged in PR #12.', 'Nothing else.']);
});

test('slug rules: reading is wider than creating', () => {
  for (const slug of ['epic', 'Old.Task_2', 'a-b']) assert.equal(isReadableSlug(slug), true, slug);
  for (const slug of ['', 'a b', 'a/b', 'a@b']) assert.equal(isReadableSlug(slug), false, slug);
  for (const slug of ['epic', 'a-b', '9lives']) assert.equal(isNewSlug(slug), true, slug);
  for (const slug of ['Old', 'a_b', 'a.b', '-a', '']) assert.equal(isNewSlug(slug), false, slug);
});
