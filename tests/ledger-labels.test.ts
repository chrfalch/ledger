import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';
import { FORMAT, GITIGNORE, isAllowed } from '../tools/ledger/clone.js';
import { addWorktree } from '../tools/ledger/git.js';
import { parseLedger } from '../tools/ledger/format.js';
import { Failure } from '../tools/ledger/failure.js';
import { earlier, fallbackColour, labelColourJson, PALETTE, type LabelRegistry } from '../tools/ledger/labels.js';
import { migrateStorage } from '../tools/ledger/migrate.js';
import { openStore } from '../tools/ledger/open-store.js';
import { ledgerPaths, type LedgerPaths } from '../tools/ledger/paths.js';
import { parseRecord, renderRecord, validateRecord, type TaskRecord } from '../tools/ledger/record.js';
import { prePushHook } from '../tools/ledger/secret-scan.js';
import type { Storage } from '../tools/ledger/settings.js';
import type { LedgerStore } from '../tools/ledger/store.js';
import { REPO } from './helpers.js';
import {
  archivedTask,
  backlogTask,
  fakeClock,
  git,
  home,
  ledgerText,
  noSqlite,
  ok,
  putActive,
  repoFixtures,
  repoKeyOf,
  runInProcessWith,
  worktreeOf,
  type InProcessOptions,
  type Ran,
} from './ledger-core-fixtures.js';
import { answerGh, APP_PATTERN, failed, ledgerOkHere, machine, remote, remoteFiles, remoteHead, remoteText, runHere, setUpHere } from './ledger-git-fixtures.js';

const STORAGES = ['file', 'sqlite', 'git'] as const;
const RESULT_MARKS = /[🟩🟥🟨]/u;

type Setup = { h: string; app: string; storage: Storage; run: (cwd: string, args: string[], options?: InProcessOptions) => Promise<Ran> };

/** A git storage clone in `h` with no remote, so a command that pushes only reports that the push failed. */
function makeClone(h: string): void {
  const clone = path.join(h, '.claude/ledger-data');
  git(h, h, 'init', '--quiet', clone);
  writeFileSync(path.join(clone, '.ledger-data'), `${JSON.stringify({ format: FORMAT })}\n`);
}

/** The repo ~/repos/app; real git when git storage takes part, whose clone git.ts does not run; see repoFixtures. */
function setup(t: TestContext, storage: Storage = 'file', { realGit = storage === 'git' } = {}): Setup {
  const h = home(t);
  copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
  if (storage !== 'file') writeFileSync(path.join(h, '.claude/ledger-settings.json'), JSON.stringify({ storage }));
  if (storage === 'git') makeClone(h);
  const app = repoFixtures(t, h, { realGit }).addRepo(path.join(h, 'repos/app'));
  if (realGit) writeFileSync(path.join(app, '.git/info/exclude'), '.claude/\n');
  const run = (cwd: string, args: string[], { env, ...options }: InProcessOptions = {}): Promise<Ran> =>
    runInProcessWith(h, cwd, { ...options, env: { LEDGER_TEST_NO_BACKGROUND_SYNC: '1', ...env } }, ...args);
  return { h, app, storage, run };
}

const registry = ({ h, storage }: Setup) => {
  const store = openStore(ledgerPaths(h), storage, { backgroundSync: false });
  try {
    return new Map(store.labels.read());
  } finally {
    store.close?.();
  }
};

function storedRecord({ h, app, storage }: Setup, slug: string): TaskRecord | undefined {
  const store = openStore(ledgerPaths(h), storage, { backgroundSync: false });
  try {
    const text = store.backlog.read(repoKeyOf(app), slug)?.text;
    return text === undefined ? undefined : parseRecord(text);
  } finally {
    store.close?.();
  }
}

const json = <T>(ran: Ran): T => JSON.parse(ok(ran)) as T;

/** `markdown` with a `- labels:` line under ## Location. */
const labelled = (markdown: string, labels: string[]): string => markdown.replace('- design refs: none\n', `- design refs: none\n- labels: ${labels.join(', ')}\n`);

type ListRow = { slug: string; labels: string[] };
type Listed = { tasks: ListRow[]; labelColours: Record<string, { square: string; hex: string }> };

for (const storage of STORAGES) {
  const skip = storage === 'sqlite' && noSqlite;

  test(`${storage} store: task new --label stores each label once, lowercased, and refuses an invalid one with nothing written`, { skip }, async (t) => {
    const s = setup(t, storage);
    ok(await s.run(s.app, ['task', 'new', 'lab', '--goal', 'Labelled.', '--label', 'SDK-59', '--label', ' sdk-59 ', '--label', 'infra']));
    assert.deepEqual(storedRecord(s, 'lab')?.labels, ['sdk-59', 'infra']);

    for (const bad of ['two words', '-dash-first', 'x'.repeat(41), 'emoji🟦', '']) {
      const ran = await s.run(s.app, ['task', 'new', 'bad', '--goal', 'Bad.', '--label', 'fine', '--label', bad]);
      assert.equal(ran.status, 1, `${JSON.stringify(bad)} was taken`);
      assert.match(ran.stderr, /label/i);
      assert.equal(storedRecord(s, 'bad'), undefined, `a task was written for ${JSON.stringify(bad)}`);
    }
    assert.equal(registry(s).has('fine'), false, 'a refused label was registered');
  });

  test(`${storage} store: notes label add and remove change the labels, with --json, and removing an absent label fails`, { skip }, async (t) => {
    const s = setup(t, storage);
    ok(await s.run(s.app, ['task', 'new', 'lab', '--goal', 'Labelled.', '--label', 'sdk-59']));

    const added = json<{ ok: boolean; labels: string[] }>(await s.run(s.app, ['notes', 'label', 'add', 'Infra', 'ui', 'sdk-59', '--task', 'lab', '--json']));
    assert.equal(added.ok, true);
    assert.deepEqual(added.labels, ['sdk-59', 'infra', 'ui']);
    assert.deepEqual(storedRecord(s, 'lab')?.labels, ['sdk-59', 'infra', 'ui']);

    const removed = json<{ labels: string[] }>(await s.run(s.app, ['notes', 'label', 'remove', 'infra', '--task', 'lab', '--json']));
    assert.deepEqual(removed.labels, ['sdk-59', 'ui']);

    const absent = await s.run(s.app, ['notes', 'label', 'remove', 'ui', 'nope', '--task', 'lab']);
    assert.equal(absent.status, 1);
    assert.match(absent.stderr, /nope/);
    assert.deepEqual(storedRecord(s, 'lab')?.labels, ['sdk-59', 'ui'], 'a refused remove changed the labels');

    ok(await s.run(s.app, ['notes', 'label', 'remove', 'sdk-59', 'ui', '--task', 'lab']));
    const record = storedRecord(s, 'lab');
    assert.equal(record?.labels, undefined);
    assert.equal(Object.hasOwn(record ?? {}, 'labels'), false);
  });

  test(`${storage} store: a label's first use registers the least used colour, reuse keeps it, and a list writes no registry`, { skip }, async (t) => {
    const s = setup(t, storage);
    const clock = fakeClock('2026-11-27T09:00:00.000Z');
    ok(await s.run(s.app, ['task', 'new', 'one', '--goal', 'One.', '--label', 'sdk-59'], { clock }));
    clock.advance(60_000);
    ok(await s.run(s.app, ['notes', 'label', 'add', 'infra', '--task', 'one'], { clock }));
    clock.advance(60_000);
    ok(await s.run(s.app, ['task', 'new', 'two', '--goal', 'Two.', '--label', 'sdk-59', '--label', 'ui'], { clock }));

    assert.deepEqual(Object.fromEntries(registry(s)), {
      'sdk-59': { colour: 0, firstUsed: '2026-11-27T09:00:00.000Z' },
      infra: { colour: 1, firstUsed: '2026-11-27T09:01:00.000Z' },
      ui: { colour: 2, firstUsed: '2026-11-27T09:02:00.000Z' },
    });

    // A label that came with a ledger, before its registry entry, has the colour its name gives, and stays unregistered.
    const store = openStore(ledgerPaths(s.h), storage, { backgroundSync: false });
    store.backlog.write(repoKeyOf(s.app), 'synced', labelled(ledgerText({ slug: 'synced', main: s.app }), ['from-elsewhere']));
    store.close?.();
    const before = Object.fromEntries(registry(s));
    const listed = json<Listed>(await s.run(s.app, ['list', '--json']));
    assert.equal(listed.labelColours['from-elsewhere'].square, PALETTE[fallbackColour('from-elsewhere')].square);
    const text = ok(await s.run(s.app, ['list']));
    assert.match(text, new RegExp(`${PALETTE[fallbackColour('from-elsewhere')].square} from-elsewhere`, 'u'));
    assert.deepEqual(Object.fromEntries(registry(s)), before, 'a list wrote the registry');

    if (storage === 'git') {
      const clone = path.join(s.h, '.claude/ledger-data');
      assert.deepEqual(git(s.h, clone, 'ls-files', 'labels').split('\n').sort(), ['labels/infra.json', 'labels/sdk-59.json', 'labels/ui.json']);
      assert.equal(git(s.h, clone, 'status', '--porcelain'), '', 'the registry is not committed');
    }
  });
}

test('labels take every palette colour once before any colour is used twice, the lowest index first', async (t) => {
  const s = setup(t);
  const names = Array.from({ length: PALETTE.length + 1 }, (_, index) => `l${index}`);
  ok(await s.run(s.app, ['task', 'new', 'many', '--goal', 'Many.', ...names.flatMap((name) => ['--label', name])]));
  const colours = names.map((name) => registry(s).get(name)?.colour);
  assert.deepEqual(colours, [...PALETTE.keys(), 0]);
});

test('the palette has ten colours, each with a code for 256 and true colour and a square that is no result mark', () => {
  assert.equal(PALETTE.length, 10);
  assert.equal(new Set(PALETTE.map(({ hex }) => hex)).size, 10);
  for (const { hex, ansi256, square } of PALETTE) {
    assert.match(hex, /^#[0-9a-f]{6}$/);
    assert.ok(Number.isInteger(ansi256) && ansi256 >= 16 && ansi256 <= 255);
    assert.ok(['🟦', '🟪', '🟧', '🟫', '⬜', '⬛'].includes(square), square);
  }
});

test('a fallback colour is a palette index that its name alone decides', () => {
  for (const name of ['sdk-59', 'infra', 'x']) {
    assert.equal(fallbackColour(name), fallbackColour(name));
    assert.ok(Number.isInteger(fallbackColour(name)) && fallbackColour(name) >= 0 && fallbackColour(name) < PALETTE.length);
  }
});

test('of two registry entries of one label, the earlier first use wins, and the lower colour on a tie', () => {
  const a = { colour: 3, firstUsed: '2026-11-27T09:00:00.000Z' };
  const b = { colour: 1, firstUsed: '2026-11-27T09:00:01.000Z' };
  assert.deepEqual(earlier(a, b), a);
  assert.deepEqual(earlier(b, a), a);
  const tie = { colour: 2, firstUsed: a.firstUsed };
  assert.deepEqual(earlier(a, tie), tie);
  assert.deepEqual(earlier(tie, a), tie);
});

test('a task record keeps labels as a "- labels:" line under Location, and refuses an empty, invalid or repeated list', () => {
  const markdown = labelled(ledgerText({ slug: 'lab', main: '/repos/app' }), ['sdk-59', 'infra']);
  const record = parseRecord(markdown);
  assert.deepEqual(record.labels, ['sdk-59', 'infra']);
  assert.match(renderRecord(record), /^## Location\n(?:- .*\n)*- labels: sdk-59, infra\n/m);
  assert.deepEqual(parseLedger(renderRecord(record)).location.labels, ['sdk-59', 'infra']);
  assert.deepEqual(validateRecord(record).labels, ['sdk-59', 'infra']);
  for (const labels of [[], ['Upper'], ['a', 'a'], ['two words']]) {
    assert.throws(() => validateRecord({ ...record, labels }), /labels/, JSON.stringify(labels));
  }
  const bad = parseRecord(labelled(ledgerText({ slug: 'lab' }), ['Not A Label']));
  assert.equal(bad.labels, undefined);
  assert.ok(bad.notes.some((line) => line.includes('Not A Label')), 'the line that is no labels line is lost');
});

test('outside a terminal a label is its square and name; in one, its colour; NO_COLOR forces the square', async (t) => {
  const s = setup(t);
  ok(await s.run(s.app, ['task', 'new', 'lab', '--goal', 'Labelled.', '--label', 'sdk-59', '--label', 'infra']));
  ok(await s.run(s.app, ['task', 'new', 'plain-task-with-a-long-name', '--goal', 'Plain.']));

  const plain = ok(await s.run(s.app, ['list']));
  assert.match(plain, /lab 🟦 sdk-59 🟪 infra/u);
  assert.doesNotMatch(plain, RESULT_MARKS);
  assert.doesNotMatch(plain, /\x1b\[/);

  const coloured = ok(await s.run(s.app, ['list'], { tty: true, env: { NO_COLOR: '', COLORTERM: '' } }));
  assert.match(coloured, /lab \x1b\[38;5;68msdk-59\x1b\[39m \x1b\[38;5;98minfra\x1b\[39m/);
  assert.doesNotMatch(coloured, /🟦/u);
  const truecolour = ok(await s.run(s.app, ['list'], { tty: true, env: { NO_COLOR: '', COLORTERM: 'truecolor' } }));
  assert.match(truecolour, /\x1b\[38;2;\d+;\d+;\d+msdk-59\x1b\[39m/);

  const noColour = ok(await s.run(s.app, ['list'], { tty: true, env: { NO_COLOR: '1' } }));
  assert.match(noColour, /lab 🟦 sdk-59 🟪 infra/u);

  for (const output of [plain, coloured]) {
    const lines = output.split('\n').filter((line) => /\bbacklog\b/.test(line) && !line.startsWith('Task ledgers'));
    const header = output.split('\n').find((line) => line.startsWith('repo'));
    assert.ok(header !== undefined && lines.length === 2, output);
    const column = (line: string, word: string): number => stringWidth(stripVTControlCharacters(line.slice(0, line.indexOf(word))));
    assert.deepEqual(
      lines.map((line) => column(line, 'backlog')),
      [column(header, 'status'), column(header, 'status')],
      `the status column is not aligned:\n${output}`,
    );
  }
});

test('--label keeps only the tasks that carry every label named: list, task archive, tree show and worktrees, as text and as JSON', async (t) => {
  const s = setup(t);
  const { h, app } = s;
  const write = (file: string, labels: string[]): void => writeFileSync(file, labelled(readFileSync(file, 'utf8'), labels));
  write(backlogTask(h, app, { slug: 'both' }), ['a', 'b']);
  write(backlogTask(h, app, { slug: 'only-a' }), ['a']);
  backlogTask(h, app, { slug: 'none', children: ['- both', '- only-a', '- none'] });
  write(archivedTask(h, app, '2026-11-01', { slug: 'old-both' }), ['b', 'a']);
  archivedTask(h, app, '2026-11-02', { slug: 'old-none' });
  for (const [slug, labels] of [['live-a', ['a']], ['live-none', []]] as const) {
    const worktree = worktreeOf(app, slug);
    assert.equal(addWorktree(app, worktree, `me/${slug}`, 'main'), undefined);
    mkdirSync(path.join(worktree, '.claude'));
    const text = ledgerText({ slug, worktree, branch: `me/${slug}` });
    putActive(h, app, slug, labels.length === 0 ? text : labelled(text, [...labels]));
  }

  const listed = json<Listed>(await s.run(app, ['list', '--label', 'a', '--label', 'B', '--json']));
  assert.deepEqual(listed.tasks.map(({ slug }) => slug), ['both']);
  assert.deepEqual(json<Listed>(await s.run(app, ['list', '--archived', '--label', 'a', '--json'])).tasks.map(({ slug }) => slug).sort(), ['both', 'live-a', 'old-both', 'only-a']);
  const text = ok(await s.run(app, ['list', '--label', 'a']));
  assert.match(text, /only-a/);
  assert.doesNotMatch(text, /\bnone\b|live-none/);

  const archive = json<{ ledgers: { slug: string; labels: string[] }[] }>(await s.run(app, ['task', 'archive', '--label', 'a', '--json']));
  assert.deepEqual(archive.ledgers.map(({ slug, labels }) => [slug, labels]), [['old-both', ['b', 'a']]]);
  assert.doesNotMatch(ok(await s.run(app, ['task', 'archive', '--label', 'b'])), /old-none/);

  const tree = json<{ slug: string; children: { slug: string; labels: string[] }[] }>(await s.run(app, ['tree', 'show', 'none', '--label', 'a', '--json']));
  assert.equal(tree.slug, 'none');
  assert.deepEqual(tree.children.map(({ slug, labels }) => [slug, labels]), [['both', ['a', 'b']], ['only-a', ['a']]]);
  const treeText = ok(await s.run(app, ['tree', 'show', 'none', '--label', 'b']));
  assert.match(treeText, /Parent task none/);
  assert.match(treeText, /both/);
  assert.doesNotMatch(treeText, /only-a/);

  const worktrees = json<{ worktrees: { name: string; ledger: { labels: string[] } | null }[] }>(await s.run(app, ['worktrees', '--label', 'a', '--json']));
  assert.deepEqual(worktrees.worktrees.map(({ name, ledger }) => [name, ledger?.labels]), [['live-a', ['a']]]);
  const worktreesText = ok(await s.run(app, ['worktrees', '--label', 'a']));
  assert.match(worktreesText, new RegExp(`live-a ${PALETTE[fallbackColour('a')].square} a\\b`, 'u'));
  assert.doesNotMatch(worktreesText, /live-none/);
});

test('list --json gives every row its labels, [] for none, and the colours of the labels it lists', async (t) => {
  const s = setup(t);
  ok(await s.run(s.app, ['task', 'new', 'lab', '--goal', 'Labelled.', '--label', 'sdk-59']));
  ok(await s.run(s.app, ['task', 'new', 'plain', '--goal', 'Plain.']));
  const listed = json<Listed>(await s.run(s.app, ['list', '--json']));
  assert.deepEqual(Object.fromEntries(listed.tasks.map(({ slug, labels }) => [slug, labels])), { lab: ['sdk-59'], plain: [] });
  assert.deepEqual(listed.labelColours, { 'sdk-59': { square: PALETTE[0].square, hex: PALETTE[0].hex } });
});

test('the session start shows the labels of the task, and of each open tree, as squares', async (t) => {
  const s = setup(t);
  const { h, app } = s;
  const worktree = worktreeOf(app, 'lab');
  assert.equal(addWorktree(app, worktree, 'me/lab', 'main'), undefined);
  mkdirSync(path.join(worktree, '.claude'));
  putActive(h, app, 'lab', ledgerText({ slug: 'lab', worktree, branch: 'me/lab' }));
  ok(await s.run(worktree, ['notes', 'label', 'add', 'sdk-59']));

  const context = async (cwd: string): Promise<string> => {
    const input = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd, session_id: 'this-session' });
    const ran = await s.run(h, ['hook', 'session-start'], { input, tty: true, env: { NO_COLOR: '' } });
    return (JSON.parse(ok(ran)) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  };
  assert.match(await context(worktree), /^Task lab 🟦 sdk-59 in /mu);
  assert.match(await context(app), /^- lab 🟦 sdk-59 active/mu);
});

test('git storage allowlists the label registry, in the .gitignore, the commit check and the pre-push hook', () => {
  assert.match(GITIGNORE, /^!\/labels\/$/m);
  assert.match(GITIGNORE, /^!\/labels\/\*\.json$/m);
  assert.equal(isAllowed('labels/sdk-59.json'), true);
  for (const file of ['labels/..json', 'labels/a/b.json', 'labels/sdk-59.md', 'labels.json']) assert.equal(isAllowed(file), false, file);

  const script = prePushHook();
  const start = script.indexOf('ledger_path=');
  const end = script.indexOf('\n}\n', script.indexOf('is_ledger() {')) + 3;
  const isLedger = (file: string): boolean => spawnSync('bash', ['-c', `${script.slice(start, end)}\nis_ledger "$1"`, 'is_ledger', file]).status === 0;
  assert.equal(isLedger('labels/sdk-59.json'), true);
  for (const file of ['labels/..json', 'labels/a/b.json', 'labels/sdk-59.md']) assert.equal(isLedger(file), false, file);
});

test('git storage: two machines that first used one label at once sync to the earlier entry, with no conflict left', async (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  await setUpHere(a);
  await ledgerOkHere(a, 'task', 'new', 'first', '--goal', 'First.');
  await ledgerOkHere(a, 'store', 'sync');
  const b = machine(t, bare);
  answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });
  await setUpHere(b);

  await ledgerOkHere(b, 'task', 'new', 'on-b', '--goal', 'On b.', '--label', 'shared');
  const fromB = JSON.parse(readFileSync(path.join(b.clone, 'labels/shared.json'), 'utf8')) as { colour: number; firstUsed: string };
  assert.equal(fromB.colour, 0);
  await ledgerOkHere(a, 'task', 'new', 'on-a', '--goal', 'On a.', '--label', 'alpha', '--label', 'shared');
  assert.equal((JSON.parse(readFileSync(path.join(a.clone, 'labels/shared.json'), 'utf8')) as { colour: number }).colour, 1);

  await ledgerOkHere(a, 'store', 'sync');
  const synced = await runHere(b, ['store', 'sync']);
  assert.equal(synced.status, 0, synced.stderr);
  await ledgerOkHere(a, 'store', 'sync');

  assert.ok(remoteFiles(bare).includes('labels/alpha.json'));
  assert.deepEqual(JSON.parse(remoteText(bare, 'labels/shared.json')), fromB);
  for (const m of [a, b]) {
    assert.equal(existsSync(m.status), false, `a sync problem was recorded on ${m.h}`);
    assert.equal(git(m.h, m.clone, 'status', '--porcelain'), '');
    assert.deepEqual(JSON.parse(readFileSync(path.join(m.clone, 'labels/shared.json'), 'utf8')), fromB);
    const listed = JSON.parse(ok(await runHere(m, ['list', '--json']))) as Listed;
    assert.equal(listed.labelColours.shared.square, PALETTE[0].square);
  }
});

test('git storage: a commit made here that held only a label entry the other machine first used earlier is dropped, and the sync completes', async (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  await setUpHere(a);
  await ledgerOkHere(a, 'task', 'new', 'first', '--goal', 'First.');
  await ledgerOkHere(a, 'store', 'sync');
  const b = machine(t, bare);
  answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });
  await setUpHere(b);

  await ledgerOkHere(a, 'task', 'new', 'on-a', '--goal', 'On a.', '--label', 'shared');
  await ledgerOkHere(a, 'store', 'sync');
  const fromA = remoteText(bare, 'labels/shared.json');
  mkdirSync(path.join(b.clone, 'labels'));
  writeFileSync(path.join(b.clone, 'labels/shared.json'), labelColourJson({ colour: 4, firstUsed: '2099-01-01T00:00:00.000Z' }));
  git(b.h, b.clone, 'add', 'labels/shared.json');
  git(b.h, b.clone, 'commit', '--quiet', '-m', 'Register the label shared');

  const synced = await runHere(b, ['store', 'sync']);

  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(git(b.h, b.clone, 'rev-parse', 'HEAD'), remoteHead(bare), 'the commit made here was kept');
  assert.equal(readFileSync(path.join(b.clone, 'labels/shared.json'), 'utf8').trim(), fromA);
  assert.equal(git(b.h, b.clone, 'status', '--porcelain'), '');
  for (const folder of ['rebase-merge', 'rebase-apply']) assert.equal(existsSync(path.join(b.clone, '.git', folder)), false, `${folder} is left`);
  assert.equal(existsSync(b.status), false, 'a sync problem was recorded');
});

test('git storage: a pull whose rebase stops on a label file and a ledger too is aborted, keeps the commit made here, and names both files', async (t) => {
  const bare = remote(t);
  const a = machine(t, bare);
  await setUpHere(a);
  await ledgerOkHere(a, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  await ledgerOkHere(a, 'store', 'sync');
  const b = machine(t, bare);
  answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });
  await setUpHere(b);

  await ledgerOkHere(a, 'notes', 'label', 'add', 'shared', '--task', 'fix-login');
  await ledgerOkHere(a, 'store', 'sync');
  // A ledger names its repo by absolute path, so B works in a checkout at the same path, as on a machine with the same layout.
  ok(await runHere(b, ['notes', 'label', 'add', 'shared', 'on-b', '--task', 'fix-login'], { cwd: a.app }));
  const local = git(b.h, b.clone, 'rev-parse', 'HEAD');
  const ownEntry = readFileSync(path.join(b.clone, 'labels/shared.json'), 'utf8');

  const output = failed(await runHere(b, ['store', 'sync']));

  assert.match(output, /labels\/shared\.json/);
  assert.match(output, new RegExp(String.raw`backlog\/${APP_PATTERN}\/fix-login\.json`));
  assert.equal(git(b.h, b.clone, 'rev-parse', 'HEAD'), local);
  assert.equal(readFileSync(path.join(b.clone, 'labels/shared.json'), 'utf8'), ownEntry);
  assert.equal(git(b.h, b.clone, 'status', '--porcelain'), '');
  for (const folder of ['rebase-merge', 'rebase-apply']) assert.equal(existsSync(path.join(b.clone, '.git', folder)), false, `${folder} is left`);
  assert.equal(JSON.parse(readFileSync(b.status, 'utf8')).problem, 'conflict');
});

for (const from of STORAGES) {
  for (const to of STORAGES.filter((storage) => storage !== from)) {
    test(`migrate ${from} → ${to} copies the label registry, each label with its colour and first use`, { skip: (from === 'sqlite' || to === 'sqlite') && noSqlite }, async (t) => {
      const s = setup(t, from, { realGit: from === 'git' || to === 'git' });
      const clock = fakeClock('2026-11-27T09:00:00.000Z');
      ok(await s.run(s.app, ['task', 'new', 'one', '--goal', 'One.', '--label', 'zeta', '--label', 'alpha'], { clock }));
      clock.advance(60_000);
      ok(await s.run(s.app, ['notes', 'label', 'add', 'mid', '--task', 'one'], { clock }));
      const before = Object.fromEntries(registry(s));
      assert.deepEqual(Object.keys(before).sort(), ['alpha', 'mid', 'zeta']);
      if (to === 'git') makeClone(s.h);

      ok(await s.run(s.app, ['store', 'migrate', '--to', to]));

      assert.deepEqual(Object.fromEntries(registry({ ...s, storage: to })), before);
      if (to === 'git') assert.equal(git(s.h, path.join(s.h, '.claude/ledger-data'), 'status', '--porcelain'), '', 'the registry is not committed');
    });
  }
}

test('migrate stops, keeps the setting, and names the label, when a label colour reads back different from the target', { skip: noSqlite }, async (t) => {
  const s = setup(t);
  ok(await s.run(s.app, ['task', 'new', 'one', '--goal', 'One.', '--label', 'sdk-59']));
  const open = (paths: LedgerPaths, storage: Storage): LedgerStore => {
    const store = openStore(paths, storage, { backgroundSync: false });
    if (storage === 'file') return store;
    const shifted = (): LabelRegistry => new Map([...store.labels.read()].map(([label, entry]) => [label, { ...entry, colour: entry.colour + 1 }]));
    return { ...store, labels: { ...store.labels, read: shifted } };
  };

  assert.throws(
    () => migrateStorage(ledgerPaths(s.h), 'sqlite', { removeSource: false, dryRun: false }, () => {}, open),
    (error) => error instanceof Failure && /read back different/.test(error.message) && /label sdk-59/.test(error.message),
  );
  assert.equal(existsSync(path.join(s.h, '.claude/ledger-settings.json')), false, 'the setting changed');
});
