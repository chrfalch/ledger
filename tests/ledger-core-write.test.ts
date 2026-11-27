import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fillLedger } from '../tools/ledger/edit.js';
import { Failure } from '../tools/ledger/failure.js';
import { fileStore } from '../tools/ledger/file-store.js';
import { parseLedger } from '../tools/ledger/format.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { findTasks, sameTask, storedRepoOf, type RepoOf } from '../tools/ledger/tasks.js';
import { nextToStart } from '../tools/ledger/write.js';
import { REPO } from './helpers.js';
import { activeFile, archivedTask, backlogTask, git, home, ledger, LEDGER_BIN, ledgerText, ok, putActive, readLedgerFile, repoKeyOf, repository, runInProcess, spawn, storeFolder, THIS_HOST, worktreeOf, worktreeTask, writeLedgerFile } from './ledger-core-fixtures.js';

const TEMPLATE = readFileSync(path.join(REPO, 'ledger.template.md'), 'utf8');

/** A HOME with ~/.claude/ledger.template.md and the repo ~/repos/app. */
function setup(t: TestContext) {
  const h = home(t);
  copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
  const app = repository(h, path.join(h, 'repos/app'));
  return { h, app };
}

const read = readLedgerFile;
const backlogFile = (h: string, main: string, slug: string): string => path.join(storeFolder(h, 'ledger-backlog', main), `${slug}.json`);
const short = (h: string, cwd: string, ref: string): string => git(h, cwd, 'rev-parse', '--short', ref);

function today(): string {
  const date = new Date();
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(2, '0')).join('-');
}

function failed(ran: { status: number | null; stderr: string }, pattern: RegExp, status?: number): void {
  if (status === undefined) assert.notEqual(ran.status, 0, 'the command should fail');
  else assert.equal(ran.status, status, ran.stderr);
  assert.match(ran.stderr, pattern);
}

/** The template as `ledger task` fills it for a backlog task in a repo without llp/. */
function backlogText(slug: string, goal: string, main: string): string {
  return TEMPLATE.replace('# Task ledger — <slug>', `# Task ledger — ${slug}`)
    .replace('<one paragraph — what done looks like>', goal)
    .replace('## Location\n', `## Location\n- main: ${main}\n`)
    .replace(/^- design refs: .*\n/m, '- kind: code\n');
}

/** `text` with one line inserted after the line `after`, which must occur once. */
function inserted(text: string, after: string, ...lines: string[]): string {
  assert.equal(text.split(`\n${after}\n`).length, 2, `"${after}" occurs once`);
  return text.replace(`\n${after}\n`, `\n${[after, ...lines].join('\n')}\n`);
}

test('ledger --help lists the writing commands, and each has its own --help', (t) => {
  const { h } = setup(t);
  const root = ok(ledger(h, h, '--help'));
  for (const command of ['task', 'go', 'tree']) assert.match(root, new RegExp(`^\\s+${command}\\b`, 'm'), `--help lists ${command}`);
  const expected: Record<string, RegExp[]> = {
    'task new': [/\[slug\]/, /--goal/, /--stack/, /--here/, /--repo/],
    'task go': [/<slug>/, /--repo/, /- base:/],
    'task park': [/<slug>/, /--reason/],
    'task unpark': [/<slug>/],
    'task block': [/<slug>/, /--on/],
    'task unblock': [/<slug>/],
    'task pr': [/<url>/, /--task/, /--json/],
    tree: [/<slug>/, /\badd\b/, /\bremove\b/, /\bstart\b/, /\bnext\b/, /\border\b/, /\bdepends\b/, /--json/],
    'tree order': [/<slug>/, /<child\.\.\.>/, /--json/],
    'tree depends': [/<child>/, /\[task\.\.\.\]/, /github\.com\/\w+\/\w+/, /--json/],
  };
  for (const [command, patterns] of Object.entries(expected)) {
    const stdout = ok(ledger(h, h, ...command.split(' '), '--help'));
    assert.match(stdout, new RegExp(`^Usage: ledger ${command}\\b`, 'm'));
    for (const pattern of patterns) assert.match(stdout, pattern, `${command} --help`);
  }
});

test('ledger task refuses a slug the creation rule does not accept, and writes nothing', async (t) => {
  const { h, app } = setup(t);
  for (const slug of ['Fix_Login', 'a.b', '-x']) {
    failed(await runInProcess(h, app, 'task', 'new', '--goal', 'x', '--', slug), /slug/);
    assert.equal(existsSync(backlogFile(h, app, slug)), false);
  }
});

test('ledger task writes a backlog ledger from ~/.claude/ledger.template.md and prints the start line', async (t) => {
  const { h, app } = setup(t);
  const stdout = ok(await runInProcess(h, app, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in. Done when they can.'));
  const file = backlogFile(h, app, 'fix-login');
  assert.equal(stdout, `ledger:  ${file}\nstatus:  backlog\nstart:   /ledger:go fix-login\n`);
  assert.equal(read(file), backlogText('fix-login', 'Users cannot log in. Done when they can.', app));
});

test('a ledger is filled only with an absolute main checkout, as a relative one would name the folder of whoever reads it', () => {
  for (const main of ['.', './app', 'repos/app', '~/repos/app']) {
    assert.throws(() => fillLedger(TEMPLATE, { slug: 'fix-login', main }), (error: unknown) => error instanceof Failure && error.message.includes(`"${main}"`), main);
  }
  assert.match(fillLedger(TEMPLATE, { slug: 'fix-login', main: '/repos/app' }), /^- main: \/repos\/app$/m);
});

test('ledger task in a repo with llp/ writes "design refs: none"; without --goal the goal stays a placeholder', async (t) => {
  const { h, app } = setup(t);
  mkdirSync(path.join(app, 'llp'));
  ok(await runInProcess(h, app, 'task', 'new', 'plain'));
  const text = read(backlogFile(h, app, 'plain'));
  assert.match(text, /^- design refs: none$/m);
  assert.match(text, /^<one paragraph — what done looks like>$/m);
});

test('ledger task refuses a slug that already has a backlog ledger, a branch or a worktree folder', async (t) => {
  const { h, app } = setup(t);
  ok(await runInProcess(h, app, 'task', 'new', 'twice'));
  const before = read(backlogFile(h, app, 'twice'));
  failed(await runInProcess(h, app, 'task', 'new', 'twice', '--goal', 'other'), /already/);
  assert.equal(read(backlogFile(h, app, 'twice')), before);
  git(h, app, 'branch', 'taken');
  failed(await runInProcess(h, app, 'task', 'new', 'taken'), /branch/);
  mkdirSync(worktreeOf(app, 'folder'), { recursive: true });
  failed(await runInProcess(h, app, 'task', 'new', 'folder'), /folder/);
});

test('ledger task fails when ~/.claude/ledger.template.md is missing', async (t) => {
  const { h, app } = setup(t);
  rmSync(path.join(h, '.claude/ledger.template.md'));
  failed(await runInProcess(h, app, 'task', 'new', 'no-template'), /ledger\.template\.md/);
  assert.equal(existsSync(backlogFile(h, app, 'no-template')), false);
});

test('ledger task from a worktree with a ledger adds one Decisions line naming the new task; nothing else changes', async (t) => {
  const { h, app } = setup(t);
  const current = worktreeTask(h, app, { slug: 'epic' });
  const before = read(current);
  const stdout = ok(await runInProcess(h, worktreeOf(app, 'epic'), 'task', 'new', 'side-quest', '--goal', 'Separate work.'));
  assert.match(stdout, /^start: {3}\/ledger:go side-quest$/m);
  const beforeLines = before.split('\n');
  const afterLines = read(current).split('\n');
  const at = beforeLines.indexOf('- Keep the old format — because real ledgers use it [observed]') + 1;
  assert.equal(afterLines.length, beforeLines.length + 1);
  assert.deepEqual([...afterLines.slice(0, at), ...afterLines.slice(at + 1)], beforeLines);
  assert.match(afterLines[at], /^- .*\bside-quest\b.*\/ledger:go side-quest/);
  assert.equal(existsSync(backlogFile(h, app, 'side-quest')), true);
});

test('ledger task from the main checkout leaves every other ledger alone', async (t) => {
  const { h, app } = setup(t);
  const other = worktreeTask(h, app, { slug: 'epic' });
  const before = read(other);
  ok(await runInProcess(h, app, 'task', 'new', 'lonely'));
  assert.equal(read(other), before);
});

test('ledger task --here adds a ledger to the current linked worktree, named after its branch or the slug given, and prints no start line', async (t) => {
  const { h, app } = setup(t);
  const worktree = worktreeOf(app, 'side');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'me/side', worktree, 'main');
  const stdout = ok(await runInProcess(h, worktree, 'task', 'new', '--here', '--goal', 'Here it is.'));
  const file = activeFile(h, app, 'side');
  const base = short(h, worktree, 'HEAD');
  assert.equal(stdout, `worktree ${worktree}\nbranch   me/side\nbase     HEAD @ ${base}\nledger   ${file}\n`);
  assert.doesNotMatch(stdout, /start:/);
  const expected = TEMPLATE.replace('# Task ledger — <slug>', '# Task ledger — side')
    .replace('<one paragraph — what done looks like>', 'Here it is.')
    .replace('- worktree: <path>', `- worktree: ${worktree}\n- host: ${THIS_HOST}`)
    .replace('- branch: <name>', '- branch: me/side')
    .replace('- base: <branch/commit>', `- base: HEAD @ ${base}`)
    .replace(/^- design refs: .*\n/m, '- kind: code\n');
  assert.equal(read(file), expected);

  const other = worktreeOf(app, 'other');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'me/other', other, 'main');
  ok(await runInProcess(h, other, 'task', 'new', '--here', 'named'));
  assert.match(read(activeFile(h, app, 'named')), /^# Task ledger — named$/m);
});

test('ledger task --here refuses the main checkout, a worktree that has a ledger, --stack and --repo', async (t) => {
  const { h, app } = setup(t);
  failed(await runInProcess(h, app, 'task', 'new', '--here', 'x'), /main checkout/);
  worktreeTask(h, app, { slug: 'epic' });
  const epic = worktreeOf(app, 'epic');
  const before = read(activeFile(h, app, 'epic'));
  failed(await runInProcess(h, epic, 'task', 'new', '--here'), /already has a ledger/);
  assert.equal(read(activeFile(h, app, 'epic')), before);
  failed(await runInProcess(h, epic, 'task', 'new', '--here', '--stack'), /--stack/);
  failed(await runInProcess(h, epic, 'task', 'new', '--here', '--repo', app), /--repo/);
});

test('ledger task --stack makes the worktree and branch at once, on top of the current branch', (t) => {
  const { h, app } = setup(t);
  const current = worktreeTask(h, app, { slug: 'epic' });
  const epic = worktreeOf(app, 'epic');
  git(h, epic, 'commit', '--quiet', '--allow-empty', '-m', 'epic work');
  const stdout = ok(ledger(h, epic, 'task', 'new', 'sub', '--stack', '--goal', 'Builds on epic.'));
  const worktree = worktreeOf(app, 'sub');
  const base = short(h, epic, 'HEAD');
  assert.equal(
    stdout.split('\n').filter((line) => !line.startsWith('noted')).join('\n'),
    `worktree ${worktree}\nbranch   sub\nbase     me/epic @ ${base}\nledger   ${activeFile(h, app, 'sub')}\nstart:   /ledger:go sub\n`,
  );
  assert.equal(git(h, worktree, 'rev-parse', 'HEAD'), git(h, epic, 'rev-parse', 'HEAD'));
  assert.equal(git(h, worktree, 'branch', '--show-current'), 'sub');
  const text = read(activeFile(h, app, 'sub'));
  assert.match(text, /^# Task ledger — sub$/m);
  assert.match(text, new RegExp(`^- worktree: ${worktree}$`, 'm'));
  assert.match(text, /^- branch: sub$/m);
  assert.match(text, new RegExp(`^- base: me/epic @ ${base}$`, 'm'));
  assert.doesNotMatch(text, /^- main:/m);
  assert.equal(existsSync(backlogFile(h, app, 'sub')), false);
  assert.match(read(current), /^- .*\bsub\b.*\/ledger:go sub/m);
  assert.match(read(path.join(app, '.git/info/exclude')), /^\.claude\/evidence\/$/m);
});

test('ledger task --stack on a detached HEAD fails and makes nothing', async (t) => {
  const { h, app } = setup(t);
  const worktree = worktreeOf(app, 'loose');
  git(h, app, 'worktree', 'add', '--quiet', '--detach', worktree, 'main');
  failed(await runInProcess(h, worktree, 'task', 'new', 'sub', '--stack'), /detached/);
  assert.equal(existsSync(worktreeOf(app, 'sub')), false);
});

test('ledger task --repo writes the backlog ledger of another repo', async (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const stdout = ok(await runInProcess(h, app, 'task', 'new', 'lib-part', '--repo', lib, '--goal', 'In lib.'));
  const file = backlogFile(h, lib, 'lib-part');
  assert.match(stdout, new RegExp(`^ledger: {2}${file}$`, 'm'));
  assert.equal(read(file), backlogText('lib-part', 'In lib.', lib));
});

test('ledger go moves a backlog ledger into a new worktree and branch from the default branch, and fills Location', (t) => {
  const { h, app } = setup(t);
  ok(ledger(h, app, 'task', 'new', 'fix-login', '--goal', 'Fix it.'));
  const backlog = backlogFile(h, app, 'fix-login');
  const before = read(backlog);
  git(h, app, 'checkout', '--quiet', '-b', 'elsewhere');
  git(h, app, 'commit', '--quiet', '--allow-empty', '-m', 'not on main');
  const stdout = ok(ledger(h, app, 'go', 'fix-login'));
  const worktree = worktreeOf(app, 'fix-login');
  const base = short(h, app, 'origin/main');
  assert.equal(stdout, `worktree ${worktree}\nbranch   fix-login\nbase     origin/main @ ${base}\nledger   ${activeFile(h, app, 'fix-login')}\n`);
  assert.equal(existsSync(backlog), false);
  const expected = before
    .replace(`- main: ${app}\n`, '')
    .replace('- worktree: <path>', `- worktree: ${worktree}\n- host: ${THIS_HOST}`)
    .replace('- branch: <name>', '- branch: fix-login')
    .replace('- base: <branch/commit>', `- base: origin/main @ ${base}`);
  assert.equal(read(activeFile(h, app, 'fix-login')), expected);
  assert.equal(git(h, worktree, 'rev-parse', 'HEAD'), git(h, app, 'rev-parse', 'origin/main'));
  assert.equal(git(h, worktree, 'branch', '--show-current'), 'fix-login');
  assert.match(read(path.join(app, '.git/info/exclude')), /^\.claude\/evidence\/$/m);
});

test('ledger go --repo promotes a cross-repo child in its own repo', async (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  worktreeTask(h, app, { slug: 'epic', children: [`- lib-part @ ${lib}`] });
  backlogTask(h, lib, { slug: 'lib-part', parent: `epic @ ${app}` });
  ok(await runInProcess(h, app, 'go', 'lib-part', '--repo', lib));
  const worktree = worktreeOf(lib, 'lib-part');
  assert.equal(existsSync(backlogFile(h, lib, 'lib-part')), false);
  const text = read(activeFile(h, lib, 'lib-part'));
  assert.match(text, new RegExp(`^- parent: epic @ ${app}$`, 'm'));
  assert.match(text, new RegExp(`^- worktree: ${worktree}$`, 'm'));
  assert.equal(git(h, worktree, 'branch', '--show-current'), 'lib-part');
  assert.equal(existsSync(worktreeOf(app, 'lib-part')), false);
});

test('ledger go refuses a missing backlog task (2), one of a same-named repo (3) and one with no main line (4)', async (t) => {
  const { h, app } = setup(t);
  failed(await runInProcess(h, app, 'go', 'nothing'), /nothing/, 2);
  // Not repository(): it names the bare origin after the folder, which ~/repos/app already uses.
  const twin = path.join(h, 'issues/app');
  mkdirSync(twin, { recursive: true });
  git(h, twin, 'init', '--quiet', '-b', 'main');
  ok(await runInProcess(h, twin, 'task', 'new', 'twin-task'));
  failed(await runInProcess(h, app, 'go', 'twin-task'), new RegExp(twin), 3);
  const file = path.join(storeFolder(h, 'ledger-backlog', app), 'no-main.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, ledgerText({ slug: 'no-main' }));
  failed(await runInProcess(h, app, 'go', 'no-main'), /main/, 4);
  assert.equal(existsSync(worktreeOf(app, 'no-main')), false);
});

test('ledger go starts a backlog task filed under the repo whose main line is ., as it is a task of this repo', async (t) => {
  const { h, app } = setup(t);
  const file = path.join(storeFolder(h, 'ledger-backlog', app), 'dot-main.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, ledgerText({ slug: 'dot-main', main: '.' }));
  ok(await runInProcess(h, app, 'go', 'dot-main'));
  assert.equal(existsSync(worktreeOf(app, 'dot-main')), true);
});

test('ledger go fails when the branch exists, and leaves the backlog ledger and no worktree', async (t) => {
  const { h, app } = setup(t);
  ok(await runInProcess(h, app, 'task', 'new', 'taken-later'));
  git(h, app, 'branch', 'taken-later');
  failed(await runInProcess(h, app, 'go', 'taken-later'), /branch/);
  assert.equal(existsSync(backlogFile(h, app, 'taken-later')), true);
  assert.equal(existsSync(worktreeOf(app, 'taken-later')), false);
});

test('ledger go removes the new worktree and branch again when a later step fails, and keeps the backlog ledger', (t) => {
  const { h, app } = setup(t);
  ok(ledger(h, app, 'task', 'new', 'stuck', '--goal', 'Cannot move.'));
  const backlog = backlogFile(h, app, 'stuck');
  const before = read(backlog);
  const folder = path.dirname(backlog);
  chmodSync(folder, 0o555);
  let ran;
  try {
    ran = ledger(h, app, 'go', 'stuck');
  } finally {
    chmodSync(folder, 0o755);
  }
  assert.notEqual(ran.status, 0, 'go should fail when the backlog ledger cannot be removed');
  assert.match(ran.stderr, new RegExp(`EACCES|${backlog}`), 'the failure names the backlog ledger it could not remove');
  assert.equal(existsSync(worktreeOf(app, 'stuck')), false);
  assert.equal(git(h, app, 'branch', '--list', 'stuck'), '');
  assert.equal(git(h, app, 'worktree', 'list', '--porcelain').includes('stuck'), false);
  assert.equal(read(backlog), before);
});

test('ledger go starts an existing backlog task whose slug only the reading rule accepts, and refuses a slug that rule does not', async (t) => {
  const { h, app } = setup(t);
  backlogTask(h, app, { slug: 'Old.Task_2' });
  ok(await runInProcess(h, app, 'go', 'Old.Task_2'));
  assert.match(read(activeFile(h, app, 'Old.Task_2')), /^# Task ledger — Old\.Task_2$/m);
  assert.equal(existsSync(backlogFile(h, app, 'Old.Task_2')), false);
  failed(await runInProcess(h, app, 'go', 'a b'), /"a b" is not a slug\. A slug has only letters, digits, dots, underscores and hyphens\./, 1);
});

test('ledger parent add takes a child as <slug>@<relative path> and writes its repo as the absolute main checkout', async (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const parent = worktreeTask(h, app, { slug: 'epic' });
  const child = backlogTask(h, lib, { slug: 'part' });
  ok(await runInProcess(h, path.join(app, '.claude'), 'tree', 'add', 'epic', 'part@../../lib'));
  assert.match(read(parent), new RegExp(`^- part @ ${lib}$`, 'm'));
  assert.match(read(child), new RegExp(`^- parent: epic @ ${app}$`, 'm'));
  ok(await runInProcess(h, app, 'tree', 'remove', 'epic', 'part@../lib'));
  assert.doesNotMatch(read(parent), /^- part\b/m);
});

test('ledger go starts from the base a backlog ledger names', async (t) => {
  const { h, app } = setup(t);
  git(h, app, 'branch', 'feature');
  const feature = worktreeOf(app, 'feature-work');
  git(h, app, 'worktree', 'add', '--quiet', feature, 'feature');
  git(h, feature, 'commit', '--quiet', '--allow-empty', '-m', 'on feature');
  backlogTask(h, app, { slug: 'on-feature', base: 'feature' });
  ok(await runInProcess(h, app, 'go', 'on-feature'));
  const worktree = worktreeOf(app, 'on-feature');
  assert.equal(git(h, worktree, 'rev-parse', 'HEAD'), git(h, app, 'rev-parse', 'feature'));
  assert.match(read(activeFile(h, app, 'on-feature')), new RegExp(`^- base: feature @ ${short(h, app, 'feature')}$`, 'm'));
});

/** `text` with `status` as its status line, which a record renders right after the worktree line. */
const withStatus = (text: string, status: string): string => text.replace(/^(- worktree: .*)$/m, `$1\n- status: ${status}`);

test('ledger park writes one status line under ## Location; park again replaces it; unpark restores the exact bytes', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const before = read(file);
  const stdout = ok(await runInProcess(h, app, 'task', 'park', 'epic', '--reason', 'waiting for review'));
  assert.equal(stdout, `Parked epic. Parked: ${today()} — waiting for review\n`);
  assert.equal(read(file), withStatus(before, `parked ${today()} — waiting for review`));
  const listed = (JSON.parse(ok(await runInProcess(h, app, 'list', '--json'))) as { tasks: { slug: string; status: string }[] }).tasks;
  assert.equal(listed.find(({ slug }) => slug === 'epic')?.status, 'parked');
  ok(await runInProcess(h, app, 'task', 'park', 'epic', '--reason', 'still waiting'));
  assert.equal(read(file), withStatus(before, `parked ${today()} — still waiting`));
  ok(await runInProcess(h, app, 'task', 'unpark', 'epic'));
  assert.equal(read(file), before);
});

test('park and unpark work on a backlog task kept as Markdown with CRLF line endings; the record it becomes reads with LF', async (t) => {
  const { h, app } = setup(t);
  const file = backlogTask(h, app, { slug: 'idea' });
  const before = read(file);
  writeFileSync(file, before.replace(/\n/g, '\r\n'));
  ok(await runInProcess(h, app, 'task', 'park', 'idea', '--reason', 'no time'));
  assert.equal(read(file), withStatus(before, `parked ${today()} — no time`));
  ok(await runInProcess(h, app, 'task', 'unpark', 'idea'));
  assert.equal(read(file), before);
});

test('a legacy Parked: marker is rewritten as the status line by the next write, and unpark removes it', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic', next: 'Parked: 2026-11-10 — waiting for review\nRun the tests.' });
  const unparked = ledgerText({ slug: 'epic', next: 'Run the tests.' });
  assert.equal(parseLedger(read(file)).location.status?.value, 'parked');
  ok(await runInProcess(h, app, 'notes', 'decide', 'Keep it', '--because', 'it works', '--tag', 'observed', '--task', 'epic'));
  assert.match(read(file), /^- status: parked 2026-11-10 — waiting for review$/m);
  assert.doesNotMatch(read(file), /^Parked:/m);
  const stdout = ok(await runInProcess(h, app, 'task', 'unpark', 'epic'));
  assert.equal(stdout, 'Unparked epic. It was parked on 2026-11-10: waiting for review.\n');
  assert.doesNotMatch(read(file), /- status:|Parked:/);
  assert.equal(parseLedger(read(file)).next, parseLedger(unparked).next);
});

test('park requires a reason: without --reason, or with an empty one, it fails and changes nothing', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const before = read(file);
  failed(await runInProcess(h, app, 'task', 'park', 'epic'), /--reason/);
  failed(await runInProcess(h, app, 'task', 'park', 'epic', '--reason', '  '), /reason/);
  assert.equal(read(file), before);
});

test('a later "Parked:" note under ## Next step is no marker: park and unpark leave it in place', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic', next: 'Run the tests.\nParked: 2026-11-10 — an old note' });
  const before = read(file);
  ok(await runInProcess(h, app, 'task', 'park', 'epic', '--reason', 'later'));
  assert.equal(read(file), withStatus(before, `parked ${today()} — later`));
  ok(await runInProcess(h, app, 'task', 'unpark', 'epic'));
  assert.equal(read(file), before);
});

test('park of a ledger without ## Next step writes the status line; unpark of a task that is not parked, with no status or another one, changes nothing', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const full = read(file);
  writeLedgerFile(file, full.slice(0, full.indexOf('## Next step')));
  ok(await runInProcess(h, app, 'task', 'park', 'epic', '--reason', 'later'));
  assert.match(read(file), new RegExp(`^- status: parked ${today()} — later$`, 'm'));
  assert.doesNotMatch(read(file), /^Parked:/m);
  writeLedgerFile(file, full);
  const stdout = ok(await runInProcess(h, app, 'task', 'unpark', 'epic'));
  assert.match(stdout, /not parked/);
  assert.equal(read(file), full);
  writeLedgerFile(file, withStatus(full, 'blocked 2026-11-20 — the API'));
  const blocked = read(file);
  assert.match(ok(await runInProcess(h, app, 'task', 'unpark', 'epic')), /not parked/);
  assert.equal(read(file), blocked);
});

test('park, unpark, block and unblock of an unknown slug fail', async (t) => {
  const { h, app } = setup(t);
  failed(await runInProcess(h, app, 'task', 'park', 'ghost', '--reason', 'x'), /ghost/);
  failed(await runInProcess(h, app, 'task', 'unpark', 'ghost'), /ghost/);
  failed(await runInProcess(h, app, 'task', 'block', 'ghost', '--on', 'x'), /ghost/);
  failed(await runInProcess(h, app, 'task', 'unblock', 'ghost'), /ghost/);
});

test('block writes the blocked status line and keeps the claim; block again replaces it; unblock restores the exact bytes', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  ok(await runInProcess(h, app, 'task', 'claim', 'epic', '--session', 'session-1'));
  const before = read(file);
  const stdout = ok(await runInProcess(h, app, 'task', 'block', 'epic', '--on', 'the API team'));
  assert.equal(stdout, `Blocked epic. Blocked: ${today()} — the API team\n`);
  assert.equal(read(file), withStatus(before, `blocked ${today()} — the API team`));
  const listed = (JSON.parse(ok(await runInProcess(h, app, 'list', '--json'))) as { tasks: { slug: string; status: string }[] }).tasks;
  assert.equal(listed.find(({ slug }) => slug === 'epic')?.status, 'blocked');
  ok(await runInProcess(h, app, 'task', 'block', 'epic', '--on', 'an operator answer'));
  assert.equal(read(file), withStatus(before, `blocked ${today()} — an operator answer`));
  assert.equal(ok(await runInProcess(h, app, 'task', 'unblock', 'epic')), `Unblocked epic. It was blocked on ${today()}: an operator answer.\n`);
  assert.equal(read(file), before);
});

test('block requires what the task waits for: without --on, or with an empty one, it fails and changes nothing', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const before = read(file);
  failed(await runInProcess(h, app, 'task', 'block', 'epic'), /--on/);
  failed(await runInProcess(h, app, 'task', 'block', 'epic', '--on', '  '), /ledger task block <slug> --on <text>/);
  assert.equal(read(file), before);
});

test('unblock of a task that is not blocked says so, exits 0 and changes nothing, a parked one included', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  assert.equal(ok(await runInProcess(h, app, 'task', 'unblock', 'epic')), 'epic is not blocked.\n');
  writeLedgerFile(file, withStatus(read(file), 'parked 2026-11-20 — later'));
  const parked = read(file);
  assert.equal(ok(await runInProcess(h, app, 'task', 'unblock', 'epic')), 'epic is not blocked.\n');
  assert.equal(read(file), parked);
});

const PR = 'https://github.com/acme/app/pull/42';

test('task pr records the PR link, sets stage pr and makes the task waiting, for the task of the worktree by default', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const stdout = ok(await runInProcess(h, worktreeOf(app, 'epic'), 'task', 'pr', PR));
  assert.equal(stdout, `Recorded PR ${PR} on epic; the task is waiting.\n`);
  const text = read(file);
  assert.match(text, new RegExp(`^- pr: ${PR}$`, 'm'));
  assert.match(text, /^- stage: pr$/m);
  assert.match(text, new RegExp(`^- status: waiting ${today()}$`, 'm'));
  const listed = (JSON.parse(ok(await runInProcess(h, app, 'list', '--json'))) as { tasks: { slug: string; status: string }[] }).tasks;
  assert.equal(listed.find(({ slug }) => slug === 'epic')?.status, 'waiting');
});

test('task pr --task names the task, and --json prints the result', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic' });
  const shown = JSON.parse(ok(await runInProcess(h, app, 'task', 'pr', PR, '--task', 'epic', '--json'))) as { slug: string; pr: string };
  assert.equal(shown.slug, 'epic');
  assert.equal(shown.pr, PR);
});

test('task pr stores the link without a trailing slash, query or fragment', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  for (const given of [`${PR}/`, `${PR}?w=1`, `${PR}#issuecomment-1`, `${PR}/#top`]) {
    ok(await runInProcess(h, app, 'task', 'pr', given, '--task', 'epic'));
    assert.match(read(file), new RegExp(`^- pr: ${PR}$`, 'm'), given);
  }
});

test('task pr on a waiting task replaces the link, and the task stays waiting', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  ok(await runInProcess(h, app, 'task', 'pr', PR, '--task', 'epic'));
  const other = 'https://github.com/acme/app/pull/43';
  ok(await runInProcess(h, app, 'task', 'pr', other, '--task', 'epic'));
  const text = read(file);
  assert.match(text, new RegExp(`^- pr: ${other}$`, 'm'));
  assert.equal(text.match(/^- pr:/gm)?.length, 1);
  assert.match(text, new RegExp(`^- status: waiting ${today()}$`, 'm'));
});

test('task pr refuses anything but a GitHub PR link, names the accepted form, and changes nothing', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const before = read(file);
  for (const url of [
    '42',
    'http://github.com/acme/app/pull/42',
    'https://gitlab.com/acme/app/pull/42',
    'https://github.com/acme/app/issues/42',
    'https://github.com/acme/app/pull/0',
    'https://github.com/acme/app/pull/abc',
    'https://github.com/acme/app/pull/42/files',
    'https://github.com/acme/pull/42',
  ]) {
    failed(await runInProcess(h, app, 'task', 'pr', url, '--task', 'epic'), /https:\/\/github\.com\/<owner>\/<repo>\/pull\/<number>/);
    assert.equal(read(file), before, url);
  }
});

test('park, block and task pr refuse a task in a state they cannot leave for theirs, with the move check message, and change nothing', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const plain = read(file);
  const parked = withStatus(plain, 'parked 2026-11-20 — later');
  const blocked = withStatus(plain, 'blocked 2026-11-20 — the API');
  const waiting = withStatus(plain, 'waiting 2026-11-20');
  const done = withStatus(plain, 'done 2026-11-20');
  const lost = inserted(plain, '- design refs: none', `- lost: 2026-11-22 — folder ${worktreeOf(app, 'epic')} not found`);
  const park = ['task', 'park', 'epic', '--reason', 'later'];
  const block = ['task', 'block', 'epic', '--on', 'the API'];
  const pr = ['task', 'pr', PR, '--task', 'epic'];
  const refusals: [string[], string, RegExp][] = [
    [park, blocked, /epic is blocked, so it cannot become parked\. A blocked task can become active\./],
    [park, waiting, /epic is waiting, so it cannot become parked\. A waiting task can become active or done\./],
    [park, done, /epic is done, so it cannot become parked\. Finalize it with the question from `ledger task gate finalize epic`\./],
    [park, lost, /epic is lost, so it cannot become parked\. A lost task can become active\./],
    [block, parked, /epic is parked, so it cannot become blocked\. A parked task can become active\./],
    [block, waiting, /epic is waiting, so it cannot become blocked/],
    [block, done, /Finalize it with the question from `ledger task gate finalize epic`\./],
    [pr, parked, /epic is parked, so it cannot become waiting\. A parked task can become active\./],
    [pr, blocked, /epic is blocked, so it cannot become waiting\. A blocked task can become active\./],
    [pr, done, /epic is done, so it cannot become waiting\. Finalize it with the question from `ledger task gate finalize epic`\./],
    [pr, lost, /epic is lost, so it cannot become waiting\. A lost task can become active\./],
  ];
  for (const [args, text, message] of refusals) {
    writeLedgerFile(file, text);
    const before = read(file);
    failed(await runInProcess(h, app, ...args), message);
    assert.equal(read(file), before, `${args[1]} ${message}`);
  }
});

test('task pr refuses a backlog task, a task of another machine and a retired task, and changes nothing', async (t) => {
  const { h, app } = setup(t);
  const idea = backlogTask(h, app, { slug: 'idea' });
  const far = putActive(h, app, 'far', ledgerText({ slug: 'far', worktree: path.join(h, 'elsewhere/far') }));
  archivedTask(h, app, '2026-11-01', { slug: 'gone' });
  const before = [read(idea), read(far)];
  failed(await runInProcess(h, app, 'task', 'pr', PR, '--task', 'idea'), /idea is in the backlog/);
  failed(await runInProcess(h, app, 'task', 'pr', PR, '--task', 'far'), /\bfar\b.*not on this machine/);
  failed(await runInProcess(h, app, 'task', 'pr', PR, '--task', 'gone'), /gone is retired/);
  assert.deepEqual([read(idea), read(far)], before);
});

test('task pr sets stage pr only for a kind that has it: a docs task moves there, an investigation keeps its stage', async (t) => {
  const { h, app } = setup(t);
  const docs = worktreeTask(h, app, { slug: 'docs' });
  const study = worktreeTask(h, app, { slug: 'study' });
  writeLedgerFile(docs, inserted(read(docs), '- design refs: none', '- kind: docs', '- stage: review'));
  writeLedgerFile(study, inserted(read(study), '- design refs: none', '- kind: investigation', '- stage: report'));
  ok(await runInProcess(h, app, 'task', 'pr', PR, '--task', 'docs'));
  ok(await runInProcess(h, app, 'task', 'pr', PR, '--task', 'study'));
  assert.match(read(docs), /^- stage: pr$/m);
  assert.match(read(study), /^- stage: report$/m);
  assert.match(read(study), new RegExp(`^- status: waiting ${today()}$`, 'm'));
});

test('task pr outside a task worktree without --task says to pass it', async (t) => {
  const { h, app } = setup(t);
  failed(await runInProcess(h, app, 'task', 'pr', PR), /--task <slug>/);
});

test('ledger go to a blocked task leaves its status line as it is', async (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  ok(await runInProcess(h, app, 'task', 'block', 'epic', '--on', 'the API'));
  ok(await runInProcess(h, app, 'go', 'epic'));
  assert.deepEqual(parseLedger(read(file)).location.status, { value: 'blocked', date: today(), detail: 'the API' });
});

test('ledger parent add links a child in the same repo; remove restores both ledgers byte for byte', async (t) => {
  const { h, app } = setup(t);
  const parent = worktreeTask(h, app, { slug: 'epic' });
  const child = backlogTask(h, app, { slug: 'idea' });
  const [parentBefore, childBefore] = [read(parent), read(child)];
  ok(await runInProcess(h, app, 'tree', 'add', 'epic', 'idea'));
  assert.equal(read(child), inserted(childBefore, '- design refs: none', '- parent: epic', '- order: 1'));
  assert.equal(read(parent), inserted(parentBefore, '- design refs: none', '', '## Children', '- idea'));
  const shown = JSON.parse(ok(await runInProcess(h, app, 'tree', 'show', 'epic', '--json'))) as { children: { slug: string; status: string }[] };
  assert.deepEqual(shown.children.map(({ slug, status }) => [slug, status]), [['idea', 'backlog']]);
  ok(await runInProcess(h, app, 'tree', 'remove', 'epic', 'idea'));
  assert.equal(read(parent), parentBefore);
  assert.equal(read(child), childBefore);
});

test('parent add appends to ## Children and keeps a line with an unknown suffix verbatim', async (t) => {
  const { h, app } = setup(t);
  const odd = '- old-d (LANDED 2026-11-03; retire pending)';
  const parent = worktreeTask(h, app, { slug: 'epic', children: [odd] });
  backlogTask(h, app, { slug: 'idea' });
  const before = read(parent);
  ok(await runInProcess(h, app, 'tree', 'add', 'epic', 'idea'));
  assert.equal(read(parent), inserted(before, odd, '- idea'));
  ok(await runInProcess(h, app, 'tree', 'remove', 'epic', 'idea'));
  assert.equal(read(parent), before);
});

test('parent add of a child in another repo writes both mains; remove drops them again', async (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const parent = worktreeTask(h, app, { slug: 'epic' });
  const child = backlogTask(h, lib, { slug: 'lib-part' });
  const [parentBefore, childBefore] = [read(parent), read(child)];
  ok(await runInProcess(h, app, 'tree', 'add', 'epic', `lib-part@${lib}`));
  assert.equal(read(child), inserted(childBefore, '- design refs: none', `- parent: epic @ ${app}`, '- order: 1'));
  assert.equal(read(parent), inserted(parentBefore, '- design refs: none', '', '## Children', `- lib-part @ ${lib}`));
  ok(await runInProcess(h, lib, 'tree', 'remove', `epic@${app}`, 'lib-part'));
  assert.equal(read(parent), parentBefore);
  assert.equal(read(child), childBefore);
});

test('parent add refuses self, a child with another parent, a cycle and a retired child; remove refuses an unlinked pair', async (t) => {
  const { h, app } = setup(t);
  const epic = worktreeTask(h, app, { slug: 'epic', parent: 'top', children: ['- old-a'] });
  const top = backlogTask(h, app, { slug: 'top', children: ['- epic'] });
  const taken = backlogTask(h, app, { slug: 'taken', parent: 'other' });
  archivedTask(h, app, '2026-10-19', { slug: 'old-a', parent: 'epic' });
  const reused = backlogTask(h, app, { slug: 'old-a' });
  const loose = backlogTask(h, app, { slug: 'loose' });
  const files = [epic, top, taken, reused, loose];
  const before = files.map(read);
  failed(await runInProcess(h, app, 'tree', 'add', 'epic', 'epic'), /own parent/);
  failed(await runInProcess(h, app, 'tree', 'add', 'epic', 'taken'), /already has the parent other/);
  failed(await runInProcess(h, app, 'tree', 'add', 'epic', 'top'), /cycle/);
  failed(await runInProcess(h, app, 'tree', 'add', 'epic', 'old-a'), /retired/);
  failed(await runInProcess(h, app, 'tree', 'remove', 'epic', 'loose'), /not a child/);
  failed(await runInProcess(h, app, 'tree', 'add', 'epic'), /child/);
  failed(await runInProcess(h, app, 'tree', 'adopt', 'epic', 'loose'), /adopt/);
  assert.deepEqual(files.map(read), before);
});

test('parent start marks a child started, keeps an unknown suffix verbatim, and leaves a marked line alone', async (t) => {
  const { h, app } = setup(t);
  const odd = '- old-d (LANDED 2026-11-03; retire pending)';
  const parent = worktreeTask(h, app, { slug: 'epic', children: ['- a', odd, '- b (started 2026-11-01)'] });
  for (const slug of ['a', 'old-d', 'b']) backlogTask(h, app, { slug, parent: 'epic' });
  const before = read(parent);
  ok(await runInProcess(h, app, 'tree', 'start', 'epic', 'a'));
  ok(await runInProcess(h, app, 'tree', 'start', 'epic', 'old-d'));
  ok(await runInProcess(h, app, 'tree', 'start', 'epic', 'b'));
  const expected = before
    .replace('\n- a\n', `\n- a (started ${today()})\n`)
    .replace(`\n${odd}\n`, `\n- old-d (started ${today()}) (LANDED 2026-11-03; retire pending)\n`);
  assert.equal(read(parent), expected);
  failed(await runInProcess(h, app, 'tree', 'start', 'epic', 'unlisted'), /not listed/);
  assert.equal(read(parent), expected);
});

test('parent next prints the chain from the parent to its first child still in the backlog', async (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  worktreeTask(h, app, { slug: 'epic', children: ['- done-one', '- running', '- nested', '- leaf'] });
  archivedTask(h, app, '2026-10-19', { slug: 'done-one', parent: 'epic' });
  worktreeTask(h, app, { slug: 'running', parent: 'epic' });
  backlogTask(h, app, { slug: 'nested', parent: 'epic', children: ['- deep'] });
  backlogTask(h, app, { slug: 'deep', parent: 'nested' });
  backlogTask(h, app, { slug: 'leaf', parent: 'epic' });
  assert.equal(ok(await runInProcess(h, app, 'tree', 'next', 'epic')), 'epic nested deep\n');
  worktreeTask(h, app, { slug: 'cross', children: [`- lib-part @ ${lib}`] });
  backlogTask(h, lib, { slug: 'lib-part', parent: `cross @ ${app}` });
  assert.equal(ok(await runInProcess(h, app, 'tree', 'next', 'cross')), `cross lib-part@${lib}\n`);
  worktreeTask(h, app, { slug: 'finished', children: ['- running'] });
  const none = await runInProcess(h, app, 'tree', 'next', 'finished');
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, '');
});

test('parent next offers a backlog child even when its Children line says started: the disk decides', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- marked (started 2026-11-01)', '- later'] });
  backlogTask(h, app, { slug: 'marked', parent: 'epic' });
  backlogTask(h, app, { slug: 'later', parent: 'epic' });
  assert.equal(ok(await runInProcess(h, app, 'tree', 'next', 'epic')), 'epic marked\n');
});

test('parent next passes over a backlog child whose own children are all started or retired', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- nested', '- leaf'] });
  backlogTask(h, app, { slug: 'nested', parent: 'epic', children: ['- running', '- done-one'] });
  worktreeTask(h, app, { slug: 'running', parent: 'nested' });
  archivedTask(h, app, '2026-10-19', { slug: 'done-one', parent: 'nested' });
  backlogTask(h, app, { slug: 'leaf', parent: 'epic' });
  assert.equal(ok(await runInProcess(h, app, 'tree', 'next', 'epic')), 'epic leaf\n');
});

/** Adds `bullets` at the end of the ## Location of a fixture ledger, where the record renders them after `- parent:`. */
const located = (file: string, ...bullets: string[]): void => writeLedgerFile(file, read(file).replace('\n\n## Plan', `\n${bullets.join('\n')}\n\n## Plan`));
const childrenIn = (text: string): string[] => /\n## Children\n([\s\S]*?)\n\n/.exec(text)?.[1].split('\n') ?? [];

/** An archive copy of `slug` filed under the repo key `key`, such as a remote address no clone here has. */
function archivedUnder(h: string, key: string, slug: string): string {
  const file = path.join(h, '.claude/ledger-archive', encodeURIComponent(key), `2026-10-01-${slug}.md`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, ledgerText({ slug }));
  return file;
}

test('tree add gives the new child the order after the highest of its siblings, and the parent lists it in that order', async (t) => {
  const { h, app } = setup(t);
  const parent = worktreeTask(h, app, { slug: 'epic', children: ['- a', '- b', '- An old note about the plan.'] });
  located(backlogTask(h, app, { slug: 'a', parent: 'epic' }), '- order: 3');
  const b = backlogTask(h, app, { slug: 'b', parent: 'epic' });
  const c = backlogTask(h, app, { slug: 'c' });
  ok(await runInProcess(h, app, 'tree', 'add', 'epic', 'c'));
  assert.match(read(b), /^- order: 4$/m, 'a sibling without an order is numbered after the ordered ones');
  assert.match(read(c), /^- order: 5$/m);
  assert.deepEqual(childrenIn(read(parent)), ['- a', '- b', '- c']);
  assert.match(read(parent), /\n## Children\n- a\n- b\n- c\n\n- An old note about the plan\.\n/, 'a line that names no task comes after the child lines');
});

test('tree add to a parent whose children have no order numbers them first, in line order, so the new child comes last', async (t) => {
  const { h, app } = setup(t);
  const parent = worktreeTask(h, app, { slug: 'epic', children: ['- a', '- b'] });
  const a = backlogTask(h, app, { slug: 'a', parent: 'epic' });
  const b = worktreeTask(h, app, { slug: 'b', parent: 'epic' });
  const c = backlogTask(h, app, { slug: 'c' });
  ok(await runInProcess(h, app, 'tree', 'add', 'epic', 'c'));
  for (const [file, order] of [[a, 1], [b, 2], [c, 3]] as const) assert.match(read(file), new RegExp(`^- order: ${order}$`, 'm'), file);
  assert.deepEqual(childrenIn(read(parent)), ['- a', '- b', '- c']);
  assert.equal(ok(await runInProcess(h, app, 'tree', 'next', 'epic')), 'epic a\n');
});

test('tree add leaves alone a sibling listed under the parent whose own ledger names another parent', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'p', children: ['- a', '- b'] });
  const q = worktreeTask(h, app, { slug: 'q', children: ['- x', '- a'] });
  const a = backlogTask(h, app, { slug: 'a', parent: 'q' });
  const b = backlogTask(h, app, { slug: 'b', parent: 'p' });
  const x = backlogTask(h, app, { slug: 'x', parent: 'q' });
  const c = backlogTask(h, app, { slug: 'c' });
  const untouched = [q, a, x];
  const before = untouched.map(read);
  ok(await runInProcess(h, app, 'tree', 'add', 'p', 'c'));
  assert.deepEqual(untouched.map(read), before);
  assert.match(read(b), /^- order: 1$/m);
  assert.match(read(c), /^- order: 2$/m);
  assert.equal(ok(await runInProcess(h, app, 'tree', 'next', 'q')), 'q x\n');
});

test('tree add keeps the line of a child whose own ledger names another parent where it is, and sorts the rest around it', async (t) => {
  const { h, app } = setup(t);
  const p = worktreeTask(h, app, { slug: 'p', children: ['- a', '- b'] });
  worktreeTask(h, app, { slug: 'q', children: ['- a'] });
  const a = backlogTask(h, app, { slug: 'a', parent: 'q' });
  backlogTask(h, app, { slug: 'b', parent: 'p' });
  backlogTask(h, app, { slug: 'x' });
  const before = read(a);
  ok(await runInProcess(h, app, 'tree', 'add', 'p', 'x'));
  assert.deepEqual(childrenIn(read(p)), ['- a', '- b', '- x']);
  assert.equal(read(a), before);
});

test('tree add keeps the line of a retired child whose archive copy names another parent where it is, and changes nothing of it', async (t) => {
  const { h, app } = setup(t);
  const p = worktreeTask(h, app, { slug: 'p', children: ['- a', '- b'] });
  worktreeTask(h, app, { slug: 'q' });
  const a = archivedTask(h, app, '2026-10-19', { slug: 'a', parent: 'q' });
  backlogTask(h, app, { slug: 'b', parent: 'p' });
  backlogTask(h, app, { slug: 'x' });
  const before = read(a);
  ok(await runInProcess(h, app, 'tree', 'add', 'p', 'x'));
  assert.deepEqual(childrenIn(read(p)), ['- a', '- b', '- x']);
  assert.equal(read(a), before);
});

test('tree add keeps a line of another parent at its index and sorts the own children around it by order', async (t) => {
  const { h, app } = setup(t);
  const p = worktreeTask(h, app, { slug: 'p', children: ['- c', '- f', '- b'] });
  worktreeTask(h, app, { slug: 'q', children: ['- f'] });
  located(backlogTask(h, app, { slug: 'c', parent: 'p' }), '- order: 2');
  backlogTask(h, app, { slug: 'f', parent: 'q' });
  located(backlogTask(h, app, { slug: 'b', parent: 'p' }), '- order: 1');
  backlogTask(h, app, { slug: 'x' });
  ok(await runInProcess(h, app, 'tree', 'add', 'p', 'x'));
  assert.deepEqual(childrenIn(read(p)), ['- b', '- f', '- c', '- x']);
});

test('tree add of a child already listed under the parent changes no order, of the child or of its siblings', async (t) => {
  const { h, app } = setup(t);
  const p = worktreeTask(h, app, { slug: 'p', children: ['- a', '- b'] });
  const files = [p, ...['a', 'b'].map((slug) => backlogTask(h, app, { slug, parent: 'p' }))];
  const before = files.map(read);
  ok(await runInProcess(h, app, 'tree', 'add', 'p', 'a'));
  assert.deepEqual(files.map(read), before);
  assert.equal(ok(await runInProcess(h, app, 'tree', 'next', 'p')), 'p a\n');
});

test('tree order numbers each current child 1 to n as named, one in another repo too, and sorts the parent lines and tree show', async (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const parent = worktreeTask(h, app, { slug: 'epic', children: ['- a', '- Prose that names no task.', '- b', `- c @ ${lib}`, '- old (retired 2026-10-19)'] });
  const a = backlogTask(h, app, { slug: 'a', parent: 'epic' });
  const b = worktreeTask(h, app, { slug: 'b', parent: 'epic' });
  const c = backlogTask(h, lib, { slug: 'c', parent: `epic @ ${app}` });
  archivedTask(h, app, '2026-10-19', { slug: 'old', parent: 'epic' });
  assert.equal(ok(await runInProcess(h, app, 'tree', 'order', 'epic', `c@${lib}`, 'a', 'b')), `The child tasks of epic are in this order now: c@${lib}, a, b.\n`);
  for (const [file, order] of [[c, 1], [a, 2], [b, 3]] as const) assert.match(read(file), new RegExp(`^- order: ${order}$`, 'm'), file);
  assert.deepEqual(childrenIn(read(parent)), [`- c @ ${lib}`, '- a', '- b', '- old (retired 2026-10-19)']);
  assert.match(read(parent), /- old \(retired 2026-10-19\)\n\n- Prose that names no task\.\n/, 'a line that names no task comes after the child lines');
  const shown = JSON.parse(ok(await runInProcess(h, app, 'tree', 'show', 'epic', '--json'))) as { children: { slug: string }[] };
  assert.deepEqual(shown.children.map(({ slug }) => slug), ['c', 'a', 'b', 'old'], 'a child without an order comes last');
});

test('tree order on a backlog parent keeps prose under its one ## Children section, after the sorted child lines', async (t) => {
  const { h, app } = setup(t);
  const parent = backlogTask(h, app, { slug: 'epic', children: ['- a', '', 'Ship a before b.', '- b'] });
  for (const slug of ['a', 'b']) backlogTask(h, app, { slug, parent: 'epic' });
  ok(await runInProcess(h, app, 'tree', 'order', 'epic', 'b', 'a'));
  const text = read(parent);
  assert.equal(text.match(/^## Children$/gm)?.length, 1, text);
  assert.equal(text.match(/Ship a before b\./g)?.length, 1, text);
  assert.match(text, /\n## Children\n- b\n- a\n\nShip a before b\.\n\n## Plan/);
});

test('tree order on a backlog parent treats a bullet that reads as a sentence as prose, as tree show does', async (t) => {
  const { h, app } = setup(t);
  const parent = backlogTask(h, app, { slug: 'epic', children: ['First paragraph.', '- a', '- Keep this note.', '- b'] });
  for (const slug of ['a', 'b']) backlogTask(h, app, { slug, parent: 'epic' });
  ok(await runInProcess(h, app, 'tree', 'order', 'epic', 'b', 'a'));
  assert.match(read(parent), /\n## Children\n- b\n- a\n\nFirst paragraph\.\n- Keep this note\.\n\n## Plan/);
  ok(await runInProcess(h, app, 'tree', 'order', 'epic', 'a', 'b'));
  assert.match(read(parent), /\n## Children\n- a\n- b\n\nFirst paragraph\.\n- Keep this note\.\n\n## Plan/);
  const shown = JSON.parse(ok(await runInProcess(h, app, 'tree', 'show', 'epic', '--json'))) as { children: { slug: string }[] };
  assert.deepEqual(shown.children.map(({ slug }) => slug), ['a', 'b']);
});

test('tree add on a backlog parent keeps the prose under its ## Children, after the child lines', async (t) => {
  const { h, app } = setup(t);
  const parent = backlogTask(h, app, { slug: 'epic', children: ['Ship a before b.', '', '- a'] });
  backlogTask(h, app, { slug: 'a', parent: 'epic' });
  backlogTask(h, app, { slug: 'b' });
  ok(await runInProcess(h, app, 'tree', 'add', 'epic', 'b'));
  const text = read(parent);
  assert.equal(text.match(/Ship a before b\./g)?.length, 1, text);
  assert.match(text, /\n## Children\n- a\n- b\n\nShip a before b\.\n\n## Plan/);
});

test('tree order refuses a child whose own ledger names another parent, names it, and writes nothing', async (t) => {
  const { h, app } = setup(t);
  const p = worktreeTask(h, app, { slug: 'p', children: ['- a', '- b'] });
  const q = worktreeTask(h, app, { slug: 'q', children: ['- x', '- a'] });
  const a = backlogTask(h, app, { slug: 'a', parent: 'q' });
  located(a, '- order: 2');
  const b = backlogTask(h, app, { slug: 'b', parent: 'p' });
  const x = backlogTask(h, app, { slug: 'x', parent: 'q' });
  located(x, '- order: 1');
  const files = [p, q, a, b, x];
  const before = files.map(read);
  failed(await runInProcess(h, app, 'tree', 'order', 'p', 'a', 'b'), /\ba \(parent q\)/);
  assert.deepEqual(files.map(read), before);
  assert.equal(ok(await runInProcess(h, app, 'tree', 'next', 'q')), 'q x\n');
});

test('tree order refuses a list that leaves out, adds or repeats a child, names each, and writes nothing', async (t) => {
  const { h, app } = setup(t);
  const parent = worktreeTask(h, app, { slug: 'epic', children: ['- a', '- b', '- c'] });
  const files = [parent, ...['a', 'b', 'c'].map((slug) => backlogTask(h, app, { slug, parent: 'epic' })), backlogTask(h, app, { slug: 'loose' })];
  const before = files.map(read);
  const ran = await runInProcess(h, app, 'tree', 'order', 'epic', 'a', 'loose', 'a', 'loose');
  failed(ran, /Not named: b, c\./);
  assert.match(ran.stderr, /Not a live child task of epic; a retired child keeps no order: loose\./);
  assert.match(ran.stderr, /Named more than once: a\./);
  assert.deepEqual(files.map(read), before);
});

test('tree order refuses a child that is active on another machine, names it, and writes nothing', async (t) => {
  const { h, app } = setup(t);
  const parent = worktreeTask(h, app, { slug: 'epic', children: ['- a', '- far'] });
  const a = backlogTask(h, app, { slug: 'a', parent: 'epic' });
  const far = putActive(h, app, 'far', ledgerText({ slug: 'far', parent: 'epic', worktree: path.join(h, 'elsewhere/far') }));
  const files = [parent, a, far];
  const before = files.map(read);
  failed(await runInProcess(h, app, 'tree', 'order', 'epic', 'a', 'far'), /\bfar\b.*not on this machine/);
  assert.deepEqual(files.map(read), before);
});

test('tree depends sets the tasks a child waits for, by slug, path or address, and with none clears them', async (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const b = backlogTask(h, app, { slug: 'b', parent: 'epic' });
  const stdout = ok(await runInProcess(h, app, 'tree', 'depends', 'b', 'a', `z@${app}`, 'api@github.com/Acme/API.git', `lib-x@${lib}`));
  assert.equal(stdout, `b waits for a, z, api@github.com/acme/api, lib-x@${repoKeyOf(lib)}.\n`);
  assert.match(read(b), new RegExp(`^- depends on: a, z, api @ github\\.com/acme/api, lib-x @ ${repoKeyOf(lib)}$`, 'm'));
  assert.equal(ok(await runInProcess(h, app, 'tree', 'depends', 'b')), 'b waits for no task.\n');
  assert.doesNotMatch(read(b), /depends on/);
  const w = worktreeTask(h, app, { slug: 'w' });
  ok(await runInProcess(h, app, 'tree', 'depends', 'w', 'a'));
  assert.match(read(w), /^- depends on: a$/m);
});

test('tree depends takes a remote address as a URL or in the scp form, and stores the key remoteKey gives it', async (t) => {
  const { h, app } = setup(t);
  const b = backlogTask(h, app, { slug: 'b' });
  const stdout = ok(await runInProcess(h, app, 'tree', 'depends', 'b', 'api@https://github.com/Acme/API.git', 'web@https://github.com/acme/web', 'cli@git@github.com:Acme/CLI.git', 'ops@ssh://git@host.example:2222/o/ops.git'));
  assert.equal(stdout, 'b waits for api@github.com/acme/api, web@github.com/acme/web, cli@github.com/acme/cli, ops@host.example:2222/o/ops.\n');
  assert.match(read(b), /^- depends on: api @ github\.com\/acme\/api, web @ github\.com\/acme\/web, cli @ github\.com\/acme\/cli, ops @ host\.example:2222\/o\/ops$/m);
});

test('tree depends refuses a slug that is no slug, an address that gives no repo key and an @ with no repo after it, and writes nothing', async (t) => {
  const { h, app } = setup(t);
  const b = backlogTask(h, app, { slug: 'b' });
  const before = read(b);
  failed(await runInProcess(h, app, 'tree', 'depends', 'b', '.@github.com/o/r'), /"\." is not a slug/);
  failed(await runInProcess(h, app, 'tree', 'depends', 'b', 'x@https://github.com/o//r'), /github\.com\/o\/\/r.*neither a folder nor a repo address/);
  failed(await runInProcess(h, app, 'tree', 'depends', 'b', 'x@https://github.com/../r'), /neither a folder nor a repo address/);
  failed(await runInProcess(h, app, 'tree', 'depends', 'b', 'api@'), /api@ names no repo after the @/);
  assert.equal(read(b), before);
});

test('tree depends takes a repo key as it stores one, and stores that key unchanged', async (t) => {
  const { h, app } = setup(t);
  const b = backlogTask(h, app, { slug: 'b' });
  ok(await runInProcess(h, app, 'tree', 'depends', 'b', 'ops@ssh://git@host.example:2222/o/ops.git', 'api@https://host/o/r', 'one@https://host/r'));
  const stored = /^- depends on: (.*)$/m.exec(read(b))?.[1] ?? assert.fail(read(b));
  assert.equal(stored, 'ops @ host.example:2222/o/ops, api @ host/o/r, one @ host/r');
  const keys = stored.split(', ').map((item) => item.replace(' @ ', '@'));
  assert.equal(ok(await runInProcess(h, app, 'tree', 'depends', 'b', ...keys)), 'b waits for ops@host.example:2222/o/ops, api@host/o/r, one@host/r.\n');
  assert.equal(/^- depends on: (.*)$/m.exec(read(b))?.[1], stored);
});

test('tree depends takes back each key it stored, with a port, an IPv6 host or a + in a folder, unchanged, and a key with a trailing slash without it', async (t) => {
  const { h, app } = setup(t);
  const b = backlogTask(h, app, { slug: 'b' });
  const keys = ['[2001:db8::1]:2222/o/r', 'git.example/team/r+v', 'host:2222/r'];
  for (const key of keys) {
    assert.equal(ok(await runInProcess(h, app, 'tree', 'depends', 'b', `api@${key}`)), `b waits for api@${key}.\n`);
    assert.equal(/^- depends on: (.*)$/m.exec(read(b))?.[1], `api @ ${key}`);
    assert.deepEqual(parseLedger(read(b)).location.dependencies, [{ slug: 'api', repo: key }], key);
  }
  assert.equal(ok(await runInProcess(h, app, 'tree', 'depends', 'b', 'api@github.com/acme/api/', 'web@host:2222/r//')), 'b waits for api@github.com/acme/api, web@host:2222/r.\n');
  assert.equal(/^- depends on: (.*)$/m.exec(read(b))?.[1], 'api @ github.com/acme/api, web @ host:2222/r');
});

test('tree depends takes a stored path key whose checkout is gone, and stores it unchanged', async (t) => {
  const { h, app } = setup(t);
  const b = backlogTask(h, app, { slug: 'b' });
  const gone = path.join(h, 'gone', 'lib');
  assert.equal(ok(await runInProcess(h, app, 'tree', 'depends', 'b', `api@${gone}`)), `b waits for api@${gone}.\n`);
  assert.equal(/^- depends on: (.*)$/m.exec(read(b))?.[1], `api @ ${gone}`);
});

test('tree depends refuses a URL whose key would not read back as the same repo, names both, and writes nothing', async (t) => {
  const { h, app } = setup(t);
  const b = backlogTask(h, app, { slug: 'b' });
  const before = read(b);
  failed(await runInProcess(h, app, 'tree', 'depends', 'b', 'api@https://git.example/team/r+v.git.git'), /https:\/\/git\.example\/team\/r\+v\.git\.git.*git\.example\/team\/r\+v\.git\b.*would not read back as the same repo/s);
  assert.equal(read(b), before);
  assert.equal(ok(await runInProcess(h, app, 'tree', 'depends', 'b', 'api@https://github.com/o/r.git')), 'b waits for api@github.com/o/r.\n');
  assert.equal(/^- depends on: (.*)$/m.exec(read(b))?.[1], 'api @ github.com/o/r');
});

test('tree depends refuses an address whose key is a folder here, which would read back as another repo, and writes nothing', async (t) => {
  const { h, app } = setup(t);
  mkdirSync(path.join(app, 'tools/ledger'), { recursive: true });
  const b = backlogTask(h, app, { slug: 'b' });
  const before = read(b);
  failed(await runInProcess(h, app, 'tree', 'depends', 'b', 'api@https://tools/ledger.git'), /https:\/\/tools\/ledger\.git.*stored as tools\/ledger\b.*would not read back as the same repo/s);
  failed(await runInProcess(h, app, 'tree', 'depends', 'b', 'api@tools/ledger.git'), /tools\/ledger\.git.*stored as tools\/ledger\b.*would not read back as the same repo/s);
  assert.equal(read(b), before);
});

test('tree depends refuses a checkout whose remote gives a key the ledger could not read back, and writes nothing', async (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  git(h, lib, 'remote', 'set-url', 'origin', 'https://host.example/x//bad');
  worktreeTask(h, app, { slug: 'p', children: ['- b'] });
  const b = backlogTask(h, app, { slug: 'b', parent: 'p' });
  const before = read(b);
  failed(await runInProcess(h, app, 'tree', 'depends', 'b', `api@${lib}`), /host\.example\/x\/\/bad/);
  assert.equal(read(b), before);
  assert.equal(ok(await runInProcess(h, app, 'tree', 'next', 'p')), 'p b\n');
});

test('tree depends refuses a task that waits for itself, a cycle, also through another repo, and a name that is no folder or address', async (t) => {
  const { h, app } = setup(t);
  const files = ['a', 'b', 'c'].map((slug) => backlogTask(h, app, { slug }));
  ok(await runInProcess(h, app, 'tree', 'depends', 'a', 'b'));
  ok(await runInProcess(h, app, 'tree', 'depends', 'b', 'c'));
  const api = path.join(h, '.claude/ledger-backlog', encodeURIComponent('github.com/acme/api'), 'api.md');
  mkdirSync(path.dirname(api), { recursive: true });
  writeFileSync(api, ledgerText({ slug: 'api' }).replace('\n\n## Plan', `\n- depends on: a @ ${repoKeyOf(app)}\n\n## Plan`));
  const before = [...files, api].map(read);
  failed(await runInProcess(h, app, 'tree', 'depends', 'a', 'a'), /a cannot wait for itself/);
  failed(await runInProcess(h, app, 'tree', 'depends', 'a', `a@${app}`), /a cannot wait for itself/);
  failed(await runInProcess(h, app, 'tree', 'depends', 'c', 'a'), /cycle: c → a → b → c/);
  failed(await runInProcess(h, app, 'tree', 'depends', 'c', 'api@github.com/acme/api'), /cycle: c → api@github\.com\/acme\/api → a → b → c/);
  failed(await runInProcess(h, app, 'tree', 'depends', 'a', 'x@no-such-folder'), /no-such-folder.*neither a folder nor a repo address/);
  assert.deepEqual([...files, api].map(read), before);
});

test('tree next picks the first child by order whose dependencies are done: retired, by address too, or in state done', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- a', '- b', '- c'] });
  located(backlogTask(h, app, { slug: 'a', parent: 'epic' }), '- order: 3');
  located(backlogTask(h, app, { slug: 'b', parent: 'epic' }), '- order: 2', '- depends on: a');
  located(backlogTask(h, app, { slug: 'c', parent: 'epic' }), '- order: 1', '- depends on: old, shipped, api @ github.com/acme/api');
  archivedTask(h, app, '2026-10-19', { slug: 'old' });
  located(worktreeTask(h, app, { slug: 'shipped' }), '- state: done');
  const api = archivedUnder(h, 'github.com/acme/api', 'api');
  assert.equal(ok(await runInProcess(h, app, 'tree', 'next', 'epic')), 'epic c\n');
  rmSync(api);
  assert.equal(ok(await runInProcess(h, app, 'tree', 'next', 'epic')), 'epic a\n', 'an unknown dependency is not done, so c and b wait');
});

test('tree next counts a dependency done by its status line, and by no other status', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- a'] });
  located(backlogTask(h, app, { slug: 'a', parent: 'epic' }), '- depends on: shipped');
  const shipped = worktreeTask(h, app, { slug: 'shipped' });
  for (const status of ['waiting 2026-11-20', 'blocked', 'parked 2026-11-20 — later']) {
    located(shipped, `- status: ${status}`);
    assert.equal(ok(await runInProcess(h, app, 'tree', 'next', 'epic')), '', status);
    writeLedgerFile(shipped, read(shipped).replace(/^- status: .*\n/m, ''));
  }
  located(shipped, '- status: done 2026-11-22');
  assert.equal(ok(await runInProcess(h, app, 'tree', 'next', 'epic')), 'epic a\n');
});

test('tree next finds a done dependency in a repo without remote that only the dependency names, in a worktree or the archive', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- b'] });
  const b = backlogTask(h, app, { slug: 'b', parent: 'epic' });
  assert.equal(ok(await runInProcess(h, app, 'tree', 'next', 'epic')), 'epic b\n', 'before lib exists');
  const lib = repository(h, path.join(h, 'elsewhere/lib'));
  git(h, lib, 'remote', 'remove', 'origin');
  located(worktreeTask(h, lib, { slug: 'shipped' }), '- state: done');
  archivedTask(h, lib, '2026-10-19', { slug: 'old' });
  located(b, `- depends on: shipped @ ${lib}, old @ ${lib}`);
  assert.equal(ok(await runInProcess(h, app, 'tree', 'next', 'epic')), 'epic b\n');
});

test('nextToStart with a store-only repoOf finds a child by the store alone, and two refs of one slug in repos it does not know are not one task', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- a'] });
  backlogTask(h, app, { slug: 'a', parent: 'epic' });
  const tasks = findTasks(fileStore(ledgerPaths(h)));
  const epic = tasks.find(({ slug }) => slug === 'epic') ?? assert.fail('no epic');
  const parent = { task: epic, ref: { slug: 'epic', main: app } };
  const unknown: RepoOf = () => undefined;

  assert.deepEqual(nextToStart(tasks, parent, undefined, storedRepoOf(tasks)), { slug: 'a', main: app });
  assert.equal(nextToStart(tasks, parent, undefined, unknown), undefined, 'the store knows no repo, so it finds no child');
  assert.equal(sameTask({ slug: 'a', main: '/nowhere/one' }, { slug: 'a', main: '/nowhere/two' }, unknown), false);
  assert.equal(sameTask({ slug: 'a', main: '/nowhere/one' }, { slug: 'a', main: '/nowhere/one' }, unknown), true);
});

test('tree next with every child waiting prints nothing and says on stderr what each child waits for', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'stuck', children: ['- x', '- y'] });
  located(backlogTask(h, app, { slug: 'x', parent: 'stuck' }), '- depends on: y');
  located(backlogTask(h, app, { slug: 'y', parent: 'stuck' }), '- depends on: nowhere, api @ github.com/acme/other');
  const ran = await runInProcess(h, app, 'tree', 'next', 'stuck');
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, '');
  assert.match(ran.stderr, /^No child task of stuck can start yet:$/m);
  assert.match(ran.stderr, /^ +x waits for y\.$/m);
  assert.match(ran.stderr, /^ +y waits for nowhere, api@github\.com\/acme\/other\.$/m);
});

test('tree ready prints the chain to every child that can start now, by order, through a nested parent to its leaves', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- a', '- nested', '- b'] });
  backlogTask(h, app, { slug: 'a', parent: 'epic' });
  backlogTask(h, app, { slug: 'nested', parent: 'epic', children: ['- deep', '- deeper'] });
  backlogTask(h, app, { slug: 'deep', parent: 'nested' });
  backlogTask(h, app, { slug: 'deeper', parent: 'nested' });
  backlogTask(h, app, { slug: 'b', parent: 'epic' });
  const ran = await runInProcess(h, app, 'tree', 'ready', 'epic');
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, 'epic a\nepic nested deep\nepic nested deeper\nepic b\n');
  assert.equal(ran.stderr, '');
});

test('tree ready leaves out a child until the task it waits for is retired, and says on stderr which child is running', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- busy', '- ui', '- docs'] });
  worktreeTask(h, app, { slug: 'busy', parent: 'epic' });
  located(backlogTask(h, app, { slug: 'ui', parent: 'epic' }), '- depends on: api');
  backlogTask(h, app, { slug: 'docs', parent: 'epic' });
  const api = backlogTask(h, app, { slug: 'api' });
  const waiting = await runInProcess(h, app, 'tree', 'ready', 'epic');
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.equal(waiting.stdout, 'epic docs\n');
  assert.equal(waiting.stderr, 'busy is running.\n');
  rmSync(api);
  archivedTask(h, app, '2026-11-20', { slug: 'api' });
  assert.equal(ok(await runInProcess(h, app, 'tree', 'ready', 'epic')), 'epic ui\nepic docs\n');
});

test('tree ready with no child that can start prints nothing and says on stderr what runs and what each child waits for', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'stuck', children: ['- busy', '- x'] });
  worktreeTask(h, app, { slug: 'busy', parent: 'stuck' });
  located(backlogTask(h, app, { slug: 'x', parent: 'stuck' }), '- depends on: busy');
  const ran = await runInProcess(h, app, 'tree', 'ready', 'stuck');
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, '');
  assert.equal(ran.stderr, 'busy is running.\nNo child task of stuck can start yet:\n  x waits for busy.\n');
});

test('go on a parent starts its first ready child by order; a backlog parent whose children all wait fails and names what they wait for', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- a', '- b'] });
  located(backlogTask(h, app, { slug: 'a', parent: 'epic' }), '- order: 2');
  located(backlogTask(h, app, { slug: 'b', parent: 'epic' }), '- order: 1', '- depends on: a');
  ok(await runInProcess(h, app, 'go', 'epic'));
  assert.equal(existsSync(activeFile(h, app, 'a')), true);
  assert.equal(existsSync(worktreeOf(app, 'b')), false);

  backlogTask(h, app, { slug: 'plan', children: ['- p'] });
  const p = backlogTask(h, app, { slug: 'p', parent: 'plan' });
  located(p, '- depends on: nope');
  failed(await runInProcess(h, app, 'go', 'plan'), /p waits for nope/);
  assert.equal(existsSync(p), true);
});

/** The command a `start:` line prints, run by a shell: `/ledger:go <slug>` is `ledger go <slug>`. */
function runStart(h: string, cwd: string, stdout: string) {
  const start = /^start: +(.*)$/m.exec(stdout)?.[1] ?? assert.fail(`no start line in:\n${stdout}`);
  const command = start.replace(/^\/ledger:go /, 'ledger go ');
  assert.match(command, /^ledger /, start);
  return spawn(h, cwd, 'sh', ['-c', `'${LEDGER_BIN}'${command.slice('ledger'.length)}`]);
}

test('ledger task --repo prints the start command the Decisions line names, from a worktree or the main checkout, and it promotes the task from there; naming this repo keeps the short one', (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const here = worktreeOf(app, 'epic');
  const current = worktreeTask(h, app, { slug: 'epic' });
  const before = read(current);
  const stdout = ok(ledger(h, here, 'task', 'new', 'lib-part', '--repo', lib, '--goal', 'In lib.'));
  assert.match(stdout, new RegExp(`^start: {3}ledger go lib-part --repo ${lib}$`, 'm'));
  const decision = '- Keep the old format — because real ledgers use it [observed]';
  assert.equal(
    read(current),
    inserted(before, decision, `- New task lib-part in ${lib}: separate work, not part of this goal. ledger go lib-part --repo ${lib} starts it.`),
  );
  ok(runStart(h, here, stdout));
  assert.equal(existsSync(activeFile(h, lib, 'lib-part')), true);
  assert.equal(existsSync(backlogFile(h, lib, 'lib-part')), false);

  const fromMain = ok(ledger(h, app, 'task', 'new', 'lib-main', '--repo', lib));
  assert.match(fromMain, new RegExp(`^start: {3}ledger go lib-main --repo ${lib}$`, 'm'));
  ok(runStart(h, app, fromMain));
  assert.equal(git(h, worktreeOf(lib, 'lib-main'), 'branch', '--show-current'), 'lib-main');

  const sameRepo = ok(ledger(h, app, 'task', 'new', 'same-repo', '--repo', app));
  assert.match(sameRepo, /^start: {3}\/ledger:go same-repo$/m);
  ok(runStart(h, app, sameRepo));
  assert.equal(existsSync(worktreeOf(app, 'same-repo')), true);
});

test('ledger task --repo shell-quotes a repo path with a space or a quote, and the printed command still works', (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, "repos/my o'lib"));
  const quoted = `'${lib.replaceAll("'", "'\\''")}'`;
  const here = worktreeOf(app, 'epic');
  const current = worktreeTask(h, app, { slug: 'epic' });
  const stdout = ok(ledger(h, here, 'task', 'new', 'lib-part', '--repo', lib));
  assert.ok(stdout.includes(`\nstart:   ledger go lib-part --repo ${quoted}\n`), stdout);
  assert.ok(read(current).includes(`ledger go lib-part --repo ${quoted} starts it.`));
  ok(runStart(h, here, stdout));
  assert.equal(existsSync(activeFile(h, lib, 'lib-part')), true);
});

test('parent next and parent start ignore a prose bullet under ## Children', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- Superseded by the new plan.', '- nested'] });
  backlogTask(h, app, { slug: 'nested', parent: 'epic', children: ['- RN-side work is tracked elsewhere.'] });
  assert.equal(ok(await runInProcess(h, app, 'tree', 'next', 'epic')), 'epic nested\n');
  const file = activeFile(h, app, 'epic');
  const before = read(file);
  failed(await runInProcess(h, app, 'tree', 'start', 'epic', 'Superseded'), /Superseded.*no task/);
  assert.equal(read(file), before);
});
