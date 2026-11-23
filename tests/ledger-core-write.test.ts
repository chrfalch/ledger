import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { parseLedger } from '../tools/ledger/format.js';
import { REPO } from './helpers.js';
import { activeFile, archivedTask, backlogTask, git, home, ledger, LEDGER_BIN, ledgerText, ok, putActive, readLedgerFile, repoKeyOf, repository, spawn, storeFolder, THIS_HOST, worktreeOf, worktreeTask, writeLedgerFile } from './ledger-core-fixtures.js';

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

test('ledger task refuses a slug the creation rule does not accept, and writes nothing', (t) => {
  const { h, app } = setup(t);
  for (const slug of ['Fix_Login', 'a.b', '-x']) {
    failed(ledger(h, app, 'task', 'new', '--goal', 'x', '--', slug), /slug/);
    assert.equal(existsSync(backlogFile(h, app, slug)), false);
  }
});

test('ledger task writes a backlog ledger from ~/.claude/ledger.template.md and prints the start line', (t) => {
  const { h, app } = setup(t);
  const stdout = ok(ledger(h, app, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in. Done when they can.'));
  const file = backlogFile(h, app, 'fix-login');
  assert.equal(stdout, `ledger:  ${file}\nstatus:  backlog\nstart:   /ledger:go fix-login\n`);
  assert.equal(read(file), backlogText('fix-login', 'Users cannot log in. Done when they can.', app));
});

test('ledger task in a repo with llp/ writes "design refs: none"; without --goal the goal stays a placeholder', (t) => {
  const { h, app } = setup(t);
  mkdirSync(path.join(app, 'llp'));
  ok(ledger(h, app, 'task', 'new', 'plain'));
  const text = read(backlogFile(h, app, 'plain'));
  assert.match(text, /^- design refs: none$/m);
  assert.match(text, /^<one paragraph — what done looks like>$/m);
});

test('ledger task refuses a slug that already has a backlog ledger, a branch or a worktree folder', (t) => {
  const { h, app } = setup(t);
  ok(ledger(h, app, 'task', 'new', 'twice'));
  const before = read(backlogFile(h, app, 'twice'));
  failed(ledger(h, app, 'task', 'new', 'twice', '--goal', 'other'), /already/);
  assert.equal(read(backlogFile(h, app, 'twice')), before);
  git(h, app, 'branch', 'taken');
  failed(ledger(h, app, 'task', 'new', 'taken'), /branch/);
  mkdirSync(worktreeOf(app, 'folder'), { recursive: true });
  failed(ledger(h, app, 'task', 'new', 'folder'), /folder/);
});

test('ledger task fails when ~/.claude/ledger.template.md is missing', (t) => {
  const { h, app } = setup(t);
  rmSync(path.join(h, '.claude/ledger.template.md'));
  failed(ledger(h, app, 'task', 'new', 'no-template'), /ledger\.template\.md/);
  assert.equal(existsSync(backlogFile(h, app, 'no-template')), false);
});

test('ledger task from a worktree with a ledger adds one Decisions line naming the new task; nothing else changes', (t) => {
  const { h, app } = setup(t);
  const current = worktreeTask(h, app, { slug: 'epic' });
  const before = read(current);
  const stdout = ok(ledger(h, worktreeOf(app, 'epic'), 'task', 'new', 'side-quest', '--goal', 'Separate work.'));
  assert.match(stdout, /^start: {3}\/ledger:go side-quest$/m);
  const beforeLines = before.split('\n');
  const afterLines = read(current).split('\n');
  const at = beforeLines.indexOf('- Keep the old format — because real ledgers use it [observed]') + 1;
  assert.equal(afterLines.length, beforeLines.length + 1);
  assert.deepEqual([...afterLines.slice(0, at), ...afterLines.slice(at + 1)], beforeLines);
  assert.match(afterLines[at], /^- .*\bside-quest\b.*\/ledger:go side-quest/);
  assert.equal(existsSync(backlogFile(h, app, 'side-quest')), true);
});

test('ledger task --repo from a worktree with a ledger names the task in the other repo with a start command that works here', (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const current = worktreeTask(h, app, { slug: 'epic' });
  const before = read(current);
  ok(ledger(h, worktreeOf(app, 'epic'), 'task', 'new', 'lib-part', '--repo', lib, '--goal', 'In lib.'));
  const decision = '- Keep the old format — because real ledgers use it [observed]';
  assert.equal(
    read(current),
    inserted(before, decision, `- New task lib-part in ${lib}: separate work, not part of this goal. ledger go lib-part --repo ${lib} starts it.`),
  );
});

test('ledger task from the main checkout leaves every other ledger alone', (t) => {
  const { h, app } = setup(t);
  const other = worktreeTask(h, app, { slug: 'epic' });
  const before = read(other);
  ok(ledger(h, app, 'task', 'new', 'lonely'));
  assert.equal(read(other), before);
});

test('ledger task --here adds a ledger to the current linked worktree, named after its branch, and prints no start line', (t) => {
  const { h, app } = setup(t);
  const worktree = worktreeOf(app, 'side');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'me/side', worktree, 'main');
  const stdout = ok(ledger(h, worktree, 'task', 'new', '--here', '--goal', 'Here it is.'));
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
});

test('ledger task --here <slug> takes the slug given', (t) => {
  const { h, app } = setup(t);
  const worktree = worktreeOf(app, 'side');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'me/side', worktree, 'main');
  ok(ledger(h, worktree, 'task', 'new', '--here', 'named'));
  assert.match(read(activeFile(h, app, 'named')), /^# Task ledger — named$/m);
});

test('ledger task --here refuses the main checkout, a worktree that has a ledger, --stack and --repo', (t) => {
  const { h, app } = setup(t);
  failed(ledger(h, app, 'task', 'new', '--here', 'x'), /main checkout/);
  worktreeTask(h, app, { slug: 'epic' });
  const epic = worktreeOf(app, 'epic');
  const before = read(activeFile(h, app, 'epic'));
  failed(ledger(h, epic, 'task', 'new', '--here'), /already has a ledger/);
  assert.equal(read(activeFile(h, app, 'epic')), before);
  failed(ledger(h, epic, 'task', 'new', '--here', '--stack'), /--stack/);
  failed(ledger(h, epic, 'task', 'new', '--here', '--repo', app), /--repo/);
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

test('ledger task --stack on a detached HEAD fails and makes nothing', (t) => {
  const { h, app } = setup(t);
  const worktree = worktreeOf(app, 'loose');
  git(h, app, 'worktree', 'add', '--quiet', '--detach', worktree, 'main');
  failed(ledger(h, worktree, 'task', 'new', 'sub', '--stack'), /detached/);
  assert.equal(existsSync(worktreeOf(app, 'sub')), false);
});

test('ledger task --repo writes the backlog ledger of another repo', (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const stdout = ok(ledger(h, app, 'task', 'new', 'lib-part', '--repo', lib, '--goal', 'In lib.'));
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

test('ledger go --repo promotes a cross-repo child in its own repo', (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  worktreeTask(h, app, { slug: 'epic', children: [`- lib-part @ ${lib}`] });
  backlogTask(h, lib, { slug: 'lib-part', parent: `epic @ ${app}` });
  ok(ledger(h, app, 'go', 'lib-part', '--repo', lib));
  const worktree = worktreeOf(lib, 'lib-part');
  assert.equal(existsSync(backlogFile(h, lib, 'lib-part')), false);
  const text = read(activeFile(h, lib, 'lib-part'));
  assert.match(text, new RegExp(`^- parent: epic @ ${app}$`, 'm'));
  assert.match(text, new RegExp(`^- worktree: ${worktree}$`, 'm'));
  assert.equal(git(h, worktree, 'branch', '--show-current'), 'lib-part');
  assert.equal(existsSync(worktreeOf(app, 'lib-part')), false);
});

test('ledger go refuses a missing backlog task (2), one of a same-named repo (3) and one with no main line (4)', (t) => {
  const { h, app } = setup(t);
  failed(ledger(h, app, 'go', 'nothing'), /nothing/, 2);
  // Not repository(): it names the bare origin after the folder, which ~/repos/app already uses.
  const twin = path.join(h, 'issues/app');
  mkdirSync(twin, { recursive: true });
  git(h, twin, 'init', '--quiet', '-b', 'main');
  ok(ledger(h, twin, 'task', 'new', 'twin-task'));
  failed(ledger(h, app, 'go', 'twin-task'), new RegExp(twin), 3);
  const file = path.join(storeFolder(h, 'ledger-backlog', app), 'no-main.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, ledgerText({ slug: 'no-main' }));
  failed(ledger(h, app, 'go', 'no-main'), /main/, 4);
  assert.equal(existsSync(worktreeOf(app, 'no-main')), false);
});

test('ledger go starts a backlog task filed under the repo whose main line is ., as it is a task of this repo', (t) => {
  const { h, app } = setup(t);
  const file = path.join(storeFolder(h, 'ledger-backlog', app), 'dot-main.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, ledgerText({ slug: 'dot-main', main: '.' }));
  ok(ledger(h, app, 'go', 'dot-main'));
  assert.equal(existsSync(worktreeOf(app, 'dot-main')), true);
});

test('ledger go fails when the branch exists, and leaves the backlog ledger and no worktree', (t) => {
  const { h, app } = setup(t);
  ok(ledger(h, app, 'task', 'new', 'taken-later'));
  git(h, app, 'branch', 'taken-later');
  failed(ledger(h, app, 'go', 'taken-later'), /branch/);
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

test('ledger go starts an existing backlog task whose slug only the reading rule accepts, and refuses a slug that rule does not', (t) => {
  const { h, app } = setup(t);
  backlogTask(h, app, { slug: 'Old.Task_2' });
  ok(ledger(h, app, 'go', 'Old.Task_2'));
  assert.match(read(activeFile(h, app, 'Old.Task_2')), /^# Task ledger — Old\.Task_2$/m);
  assert.equal(existsSync(backlogFile(h, app, 'Old.Task_2')), false);
  failed(ledger(h, app, 'go', 'a b'), /"a b" is not a slug\. A slug has only letters, digits, dots, underscores and hyphens\./, 1);
});

test('ledger parent add takes a child as <slug>@<relative path> and writes its repo as the absolute main checkout', (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const parent = worktreeTask(h, app, { slug: 'epic' });
  const child = backlogTask(h, lib, { slug: 'part' });
  ok(ledger(h, path.join(app, '.claude'), 'tree', 'add', 'epic', 'part@../../lib'));
  assert.match(read(parent), new RegExp(`^- part @ ${lib}$`, 'm'));
  assert.match(read(child), new RegExp(`^- parent: epic @ ${app}$`, 'm'));
  ok(ledger(h, app, 'tree', 'remove', 'epic', 'part@../lib'));
  assert.doesNotMatch(read(parent), /^- part\b/m);
});

test('ledger go starts from the base a backlog ledger names', (t) => {
  const { h, app } = setup(t);
  git(h, app, 'branch', 'feature');
  const feature = worktreeOf(app, 'feature-work');
  git(h, app, 'worktree', 'add', '--quiet', feature, 'feature');
  git(h, feature, 'commit', '--quiet', '--allow-empty', '-m', 'on feature');
  backlogTask(h, app, { slug: 'on-feature', base: 'feature' });
  ok(ledger(h, app, 'go', 'on-feature'));
  const worktree = worktreeOf(app, 'on-feature');
  assert.equal(git(h, worktree, 'rev-parse', 'HEAD'), git(h, app, 'rev-parse', 'feature'));
  assert.match(read(activeFile(h, app, 'on-feature')), new RegExp(`^- base: feature @ ${short(h, app, 'feature')}$`, 'm'));
});

test('ledger park puts one marker first under Next step; unpark restores the exact bytes', (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const before = read(file);
  const stdout = ok(ledger(h, app, 'task', 'park', 'epic', '--reason', 'waiting for review'));
  const marker = `Parked: ${today()} — waiting for review`;
  assert.match(stdout, new RegExp(`${marker}`));
  assert.equal(read(file), inserted(before, '## Next step', marker));
  const listed = (JSON.parse(ok(ledger(h, app, 'list', '--json'))) as { tasks: { slug: string; status: string }[] }).tasks;
  assert.equal(listed.find(({ slug }) => slug === 'epic')?.status, 'parked');
  ok(ledger(h, app, 'task', 'park', 'epic', '--reason', 'still waiting'));
  assert.equal(read(file), inserted(before, '## Next step', `Parked: ${today()} — still waiting`));
  ok(ledger(h, app, 'task', 'unpark', 'epic'));
  assert.equal(read(file), before);
});

test('park and unpark work on a backlog task kept as Markdown with CRLF line endings; the record it becomes reads with LF', (t) => {
  const { h, app } = setup(t);
  const file = backlogTask(h, app, { slug: 'idea' });
  const before = read(file);
  writeFileSync(file, before.replace(/\n/g, '\r\n'));
  ok(ledger(h, app, 'task', 'park', 'idea', '--reason', 'no time'));
  assert.equal(read(file), before.replace('\n## Next step\n', `\n## Next step\nParked: ${today()} — no time\n`));
  ok(ledger(h, app, 'task', 'unpark', 'idea'));
  assert.equal(read(file), before);
});

test('park requires a reason: without --reason, or with an empty one, it fails and changes nothing', (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const before = read(file);
  failed(ledger(h, app, 'task', 'park', 'epic'), /--reason/);
  failed(ledger(h, app, 'task', 'park', 'epic', '--reason', '  '), /reason/);
  assert.equal(read(file), before);
});

test('a later "Parked:" note under ## Next step is no marker: park and unpark leave it in place', (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic', next: 'Run the tests.\nParked: 2026-11-10 — an old note' });
  const before = read(file);
  ok(ledger(h, app, 'task', 'park', 'epic', '--reason', 'later'));
  assert.equal(read(file), inserted(before, '## Next step', `Parked: ${today()} — later`));
  ok(ledger(h, app, 'task', 'unpark', 'epic'));
  assert.equal(read(file), before);
});

test('park adds ## Next step when a ledger has none; unpark of a task that is not parked changes nothing', (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const full = read(file);
  const before = full.slice(0, full.indexOf('## Next step'));
  writeLedgerFile(file, before);
  ok(ledger(h, app, 'task', 'park', 'epic', '--reason', 'later'));
  // A task record always has a ## Next step, so the one it is read with holds the marker first.
  assert.match(read(file), new RegExp(`\n## Next step\nParked: ${today()} — later\n`));
  writeLedgerFile(file, full);
  const stdout = ok(ledger(h, app, 'task', 'unpark', 'epic'));
  assert.match(stdout, /not parked/);
  assert.equal(read(file), full);
});

test('park and unpark of an unknown slug fail', (t) => {
  const { h, app } = setup(t);
  failed(ledger(h, app, 'task', 'park', 'ghost', '--reason', 'x'), /ghost/);
  failed(ledger(h, app, 'task', 'unpark', 'ghost'), /ghost/);
});

test('ledger parent add links a child in the same repo; remove restores both ledgers byte for byte', (t) => {
  const { h, app } = setup(t);
  const parent = worktreeTask(h, app, { slug: 'epic' });
  const child = backlogTask(h, app, { slug: 'idea' });
  const [parentBefore, childBefore] = [read(parent), read(child)];
  ok(ledger(h, app, 'tree', 'add', 'epic', 'idea'));
  assert.equal(read(child), inserted(childBefore, '- design refs: none', '- parent: epic', '- order: 1'));
  assert.equal(read(parent), inserted(parentBefore, '- design refs: none', '', '## Children', '- idea'));
  const shown = JSON.parse(ok(ledger(h, app, 'tree', 'show', 'epic', '--json'))) as { children: { slug: string; status: string }[] };
  assert.deepEqual(shown.children.map(({ slug, status }) => [slug, status]), [['idea', 'backlog']]);
  ok(ledger(h, app, 'tree', 'remove', 'epic', 'idea'));
  assert.equal(read(parent), parentBefore);
  assert.equal(read(child), childBefore);
});

test('parent add appends to ## Children and keeps a line with an unknown suffix verbatim', (t) => {
  const { h, app } = setup(t);
  const odd = '- old-d (LANDED 2026-11-03; retire pending)';
  const parent = worktreeTask(h, app, { slug: 'epic', children: [odd] });
  backlogTask(h, app, { slug: 'idea' });
  const before = read(parent);
  ok(ledger(h, app, 'tree', 'add', 'epic', 'idea'));
  assert.equal(read(parent), inserted(before, odd, '- idea'));
  ok(ledger(h, app, 'tree', 'remove', 'epic', 'idea'));
  assert.equal(read(parent), before);
});

test('parent add of a child in another repo writes both mains; remove drops them again', (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const parent = worktreeTask(h, app, { slug: 'epic' });
  const child = backlogTask(h, lib, { slug: 'lib-part' });
  const [parentBefore, childBefore] = [read(parent), read(child)];
  ok(ledger(h, app, 'tree', 'add', 'epic', `lib-part@${lib}`));
  assert.equal(read(child), inserted(childBefore, '- design refs: none', `- parent: epic @ ${app}`, '- order: 1'));
  assert.equal(read(parent), inserted(parentBefore, '- design refs: none', '', '## Children', `- lib-part @ ${lib}`));
  ok(ledger(h, lib, 'tree', 'remove', `epic@${app}`, 'lib-part'));
  assert.equal(read(parent), parentBefore);
  assert.equal(read(child), childBefore);
});

test('parent add refuses self, a child with another parent, a cycle and a retired child; remove refuses an unlinked pair', (t) => {
  const { h, app } = setup(t);
  const epic = worktreeTask(h, app, { slug: 'epic', parent: 'top', children: ['- old-a'] });
  const top = backlogTask(h, app, { slug: 'top', children: ['- epic'] });
  const taken = backlogTask(h, app, { slug: 'taken', parent: 'other' });
  archivedTask(h, app, '2026-10-19', { slug: 'old-a', parent: 'epic' });
  const reused = backlogTask(h, app, { slug: 'old-a' });
  const loose = backlogTask(h, app, { slug: 'loose' });
  const files = [epic, top, taken, reused, loose];
  const before = files.map(read);
  failed(ledger(h, app, 'tree', 'add', 'epic', 'epic'), /own parent/);
  failed(ledger(h, app, 'tree', 'add', 'epic', 'taken'), /already has the parent other/);
  failed(ledger(h, app, 'tree', 'add', 'epic', 'top'), /cycle/);
  failed(ledger(h, app, 'tree', 'add', 'epic', 'old-a'), /retired/);
  failed(ledger(h, app, 'tree', 'remove', 'epic', 'loose'), /not a child/);
  failed(ledger(h, app, 'tree', 'add', 'epic'), /child/);
  failed(ledger(h, app, 'tree', 'adopt', 'epic', 'loose'), /adopt/);
  assert.deepEqual(files.map(read), before);
});

test('parent start marks a child started, keeps an unknown suffix verbatim, and leaves a marked line alone', (t) => {
  const { h, app } = setup(t);
  const odd = '- old-d (LANDED 2026-11-03; retire pending)';
  const parent = worktreeTask(h, app, { slug: 'epic', children: ['- a', odd, '- b (started 2026-11-01)'] });
  for (const slug of ['a', 'old-d', 'b']) backlogTask(h, app, { slug, parent: 'epic' });
  const before = read(parent);
  ok(ledger(h, app, 'tree', 'start', 'epic', 'a'));
  ok(ledger(h, app, 'tree', 'start', 'epic', 'old-d'));
  ok(ledger(h, app, 'tree', 'start', 'epic', 'b'));
  const expected = before
    .replace('\n- a\n', `\n- a (started ${today()})\n`)
    .replace(`\n${odd}\n`, `\n- old-d (started ${today()}) (LANDED 2026-11-03; retire pending)\n`);
  assert.equal(read(parent), expected);
  failed(ledger(h, app, 'tree', 'start', 'epic', 'unlisted'), /not listed/);
  assert.equal(read(parent), expected);
});

test('parent next prints the chain from the parent to its first child still in the backlog', (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  worktreeTask(h, app, { slug: 'epic', children: ['- done-one', '- running', '- nested', '- leaf'] });
  archivedTask(h, app, '2026-10-19', { slug: 'done-one', parent: 'epic' });
  worktreeTask(h, app, { slug: 'running', parent: 'epic' });
  backlogTask(h, app, { slug: 'nested', parent: 'epic', children: ['- deep'] });
  backlogTask(h, app, { slug: 'deep', parent: 'nested' });
  backlogTask(h, app, { slug: 'leaf', parent: 'epic' });
  assert.equal(ok(ledger(h, app, 'tree', 'next', 'epic')), 'epic nested deep\n');
  worktreeTask(h, app, { slug: 'cross', children: [`- lib-part @ ${lib}`] });
  backlogTask(h, lib, { slug: 'lib-part', parent: `cross @ ${app}` });
  assert.equal(ok(ledger(h, app, 'tree', 'next', 'cross')), `cross lib-part@${lib}\n`);
  worktreeTask(h, app, { slug: 'finished', children: ['- running'] });
  const none = ledger(h, app, 'tree', 'next', 'finished');
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, '');
});

test('parent next offers a backlog child even when its Children line says started: the disk decides', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- marked (started 2026-11-01)', '- later'] });
  backlogTask(h, app, { slug: 'marked', parent: 'epic' });
  backlogTask(h, app, { slug: 'later', parent: 'epic' });
  assert.equal(ok(ledger(h, app, 'tree', 'next', 'epic')), 'epic marked\n');
});

test('parent next passes over a backlog child whose own children are all started or retired', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- nested', '- leaf'] });
  backlogTask(h, app, { slug: 'nested', parent: 'epic', children: ['- running', '- done-one'] });
  worktreeTask(h, app, { slug: 'running', parent: 'nested' });
  archivedTask(h, app, '2026-10-19', { slug: 'done-one', parent: 'nested' });
  backlogTask(h, app, { slug: 'leaf', parent: 'epic' });
  assert.equal(ok(ledger(h, app, 'tree', 'next', 'epic')), 'epic leaf\n');
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

test('tree add gives the new child the order after the highest of its siblings, and the parent lists it in that order', (t) => {
  const { h, app } = setup(t);
  const parent = worktreeTask(h, app, { slug: 'epic', children: ['- a', '- b', '- An old note about the plan.'] });
  located(backlogTask(h, app, { slug: 'a', parent: 'epic' }), '- order: 3');
  const b = backlogTask(h, app, { slug: 'b', parent: 'epic' });
  const c = backlogTask(h, app, { slug: 'c' });
  ok(ledger(h, app, 'tree', 'add', 'epic', 'c'));
  assert.match(read(b), /^- order: 4$/m, 'a sibling without an order is numbered after the ordered ones');
  assert.match(read(c), /^- order: 5$/m);
  assert.deepEqual(childrenIn(read(parent)), ['- a', '- b', '- c']);
  assert.match(read(parent), /\n## Children\n- a\n- b\n- c\n\n- An old note about the plan\.\n/, 'a line that names no task comes after the child lines');
});

test('tree add to a parent whose children have no order numbers them first, in line order, so the new child comes last', (t) => {
  const { h, app } = setup(t);
  const parent = worktreeTask(h, app, { slug: 'epic', children: ['- a', '- b'] });
  const a = backlogTask(h, app, { slug: 'a', parent: 'epic' });
  const b = worktreeTask(h, app, { slug: 'b', parent: 'epic' });
  const c = backlogTask(h, app, { slug: 'c' });
  ok(ledger(h, app, 'tree', 'add', 'epic', 'c'));
  for (const [file, order] of [[a, 1], [b, 2], [c, 3]] as const) assert.match(read(file), new RegExp(`^- order: ${order}$`, 'm'), file);
  assert.deepEqual(childrenIn(read(parent)), ['- a', '- b', '- c']);
  assert.equal(ok(ledger(h, app, 'tree', 'next', 'epic')), 'epic a\n');
});

test('tree add leaves alone a sibling listed under the parent whose own ledger names another parent', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'p', children: ['- a', '- b'] });
  const q = worktreeTask(h, app, { slug: 'q', children: ['- x', '- a'] });
  const a = backlogTask(h, app, { slug: 'a', parent: 'q' });
  const b = backlogTask(h, app, { slug: 'b', parent: 'p' });
  const x = backlogTask(h, app, { slug: 'x', parent: 'q' });
  const c = backlogTask(h, app, { slug: 'c' });
  const untouched = [q, a, x];
  const before = untouched.map(read);
  ok(ledger(h, app, 'tree', 'add', 'p', 'c'));
  assert.deepEqual(untouched.map(read), before);
  assert.match(read(b), /^- order: 1$/m);
  assert.match(read(c), /^- order: 2$/m);
  assert.equal(ok(ledger(h, app, 'tree', 'next', 'q')), 'q x\n');
});

test('tree add keeps the line of a child whose own ledger names another parent where it is, and sorts the rest around it', (t) => {
  const { h, app } = setup(t);
  const p = worktreeTask(h, app, { slug: 'p', children: ['- a', '- b'] });
  worktreeTask(h, app, { slug: 'q', children: ['- a'] });
  const a = backlogTask(h, app, { slug: 'a', parent: 'q' });
  backlogTask(h, app, { slug: 'b', parent: 'p' });
  backlogTask(h, app, { slug: 'x' });
  const before = read(a);
  ok(ledger(h, app, 'tree', 'add', 'p', 'x'));
  assert.deepEqual(childrenIn(read(p)), ['- a', '- b', '- x']);
  assert.equal(read(a), before);
});

test('tree add keeps the line of a retired child whose archive copy names another parent where it is, and changes nothing of it', (t) => {
  const { h, app } = setup(t);
  const p = worktreeTask(h, app, { slug: 'p', children: ['- a', '- b'] });
  worktreeTask(h, app, { slug: 'q' });
  const a = archivedTask(h, app, '2026-10-19', { slug: 'a', parent: 'q' });
  backlogTask(h, app, { slug: 'b', parent: 'p' });
  backlogTask(h, app, { slug: 'x' });
  const before = read(a);
  ok(ledger(h, app, 'tree', 'add', 'p', 'x'));
  assert.deepEqual(childrenIn(read(p)), ['- a', '- b', '- x']);
  assert.equal(read(a), before);
});

test('tree add keeps a line of another parent at its index and sorts the own children around it by order', (t) => {
  const { h, app } = setup(t);
  const p = worktreeTask(h, app, { slug: 'p', children: ['- c', '- f', '- b'] });
  worktreeTask(h, app, { slug: 'q', children: ['- f'] });
  located(backlogTask(h, app, { slug: 'c', parent: 'p' }), '- order: 2');
  backlogTask(h, app, { slug: 'f', parent: 'q' });
  located(backlogTask(h, app, { slug: 'b', parent: 'p' }), '- order: 1');
  backlogTask(h, app, { slug: 'x' });
  ok(ledger(h, app, 'tree', 'add', 'p', 'x'));
  assert.deepEqual(childrenIn(read(p)), ['- b', '- f', '- c', '- x']);
});

test('tree add of a child already listed under the parent changes no order, of the child or of its siblings', (t) => {
  const { h, app } = setup(t);
  const p = worktreeTask(h, app, { slug: 'p', children: ['- a', '- b'] });
  const files = [p, ...['a', 'b'].map((slug) => backlogTask(h, app, { slug, parent: 'p' }))];
  const before = files.map(read);
  ok(ledger(h, app, 'tree', 'add', 'p', 'a'));
  assert.deepEqual(files.map(read), before);
  assert.equal(ok(ledger(h, app, 'tree', 'next', 'p')), 'p a\n');
});

test('tree order numbers each current child 1 to n as named, one in another repo too, and sorts the parent lines and tree show', (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const parent = worktreeTask(h, app, { slug: 'epic', children: ['- a', '- Prose that names no task.', '- b', `- c @ ${lib}`, '- old (retired 2026-10-19)'] });
  const a = backlogTask(h, app, { slug: 'a', parent: 'epic' });
  const b = worktreeTask(h, app, { slug: 'b', parent: 'epic' });
  const c = backlogTask(h, lib, { slug: 'c', parent: `epic @ ${app}` });
  archivedTask(h, app, '2026-10-19', { slug: 'old', parent: 'epic' });
  assert.equal(ok(ledger(h, app, 'tree', 'order', 'epic', `c@${lib}`, 'a', 'b')), `The child tasks of epic are in this order now: c@${lib}, a, b.\n`);
  for (const [file, order] of [[c, 1], [a, 2], [b, 3]] as const) assert.match(read(file), new RegExp(`^- order: ${order}$`, 'm'), file);
  assert.deepEqual(childrenIn(read(parent)), [`- c @ ${lib}`, '- a', '- b', '- old (retired 2026-10-19)']);
  assert.match(read(parent), /- old \(retired 2026-10-19\)\n\n- Prose that names no task\.\n/, 'a line that names no task comes after the child lines');
  const shown = JSON.parse(ok(ledger(h, app, 'tree', 'show', 'epic', '--json'))) as { children: { slug: string }[] };
  assert.deepEqual(shown.children.map(({ slug }) => slug), ['c', 'a', 'b', 'old'], 'a child without an order comes last');
});

test('tree order on a backlog parent keeps prose under its one ## Children section, after the sorted child lines', (t) => {
  const { h, app } = setup(t);
  const parent = backlogTask(h, app, { slug: 'epic', children: ['- a', '', 'Ship a before b.', '- b'] });
  for (const slug of ['a', 'b']) backlogTask(h, app, { slug, parent: 'epic' });
  ok(ledger(h, app, 'tree', 'order', 'epic', 'b', 'a'));
  const text = read(parent);
  assert.equal(text.match(/^## Children$/gm)?.length, 1, text);
  assert.equal(text.match(/Ship a before b\./g)?.length, 1, text);
  assert.match(text, /\n## Children\n- b\n- a\n\nShip a before b\.\n\n## Plan/);
});

test('tree order on a backlog parent treats a bullet that reads as a sentence as prose, as tree show does', (t) => {
  const { h, app } = setup(t);
  const parent = backlogTask(h, app, { slug: 'epic', children: ['First paragraph.', '- a', '- Keep this note.', '- b'] });
  for (const slug of ['a', 'b']) backlogTask(h, app, { slug, parent: 'epic' });
  ok(ledger(h, app, 'tree', 'order', 'epic', 'b', 'a'));
  assert.match(read(parent), /\n## Children\n- b\n- a\n\nFirst paragraph\.\n- Keep this note\.\n\n## Plan/);
  ok(ledger(h, app, 'tree', 'order', 'epic', 'a', 'b'));
  assert.match(read(parent), /\n## Children\n- a\n- b\n\nFirst paragraph\.\n- Keep this note\.\n\n## Plan/);
  const shown = JSON.parse(ok(ledger(h, app, 'tree', 'show', 'epic', '--json'))) as { children: { slug: string }[] };
  assert.deepEqual(shown.children.map(({ slug }) => slug), ['a', 'b']);
});

test('tree add on a backlog parent keeps the prose under its ## Children, after the child lines', (t) => {
  const { h, app } = setup(t);
  const parent = backlogTask(h, app, { slug: 'epic', children: ['Ship a before b.', '', '- a'] });
  backlogTask(h, app, { slug: 'a', parent: 'epic' });
  backlogTask(h, app, { slug: 'b' });
  ok(ledger(h, app, 'tree', 'add', 'epic', 'b'));
  const text = read(parent);
  assert.equal(text.match(/Ship a before b\./g)?.length, 1, text);
  assert.match(text, /\n## Children\n- a\n- b\n\nShip a before b\.\n\n## Plan/);
});

test('tree order refuses a child whose own ledger names another parent, names it, and writes nothing', (t) => {
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
  failed(ledger(h, app, 'tree', 'order', 'p', 'a', 'b'), /\ba \(parent q\)/);
  assert.deepEqual(files.map(read), before);
  assert.equal(ok(ledger(h, app, 'tree', 'next', 'q')), 'q x\n');
});

test('tree order refuses a list that leaves out, adds or repeats a child, names each, and writes nothing', (t) => {
  const { h, app } = setup(t);
  const parent = worktreeTask(h, app, { slug: 'epic', children: ['- a', '- b', '- c'] });
  const files = [parent, ...['a', 'b', 'c'].map((slug) => backlogTask(h, app, { slug, parent: 'epic' })), backlogTask(h, app, { slug: 'loose' })];
  const before = files.map(read);
  const ran = ledger(h, app, 'tree', 'order', 'epic', 'a', 'loose', 'a', 'loose');
  failed(ran, /Not named: b, c\./);
  assert.match(ran.stderr, /Not a live child task of epic; a retired child keeps no order: loose\./);
  assert.match(ran.stderr, /Named more than once: a\./);
  assert.deepEqual(files.map(read), before);
});

test('tree order refuses a child that is active on another machine, names it, and writes nothing', (t) => {
  const { h, app } = setup(t);
  const parent = worktreeTask(h, app, { slug: 'epic', children: ['- a', '- far'] });
  const a = backlogTask(h, app, { slug: 'a', parent: 'epic' });
  const far = putActive(h, app, 'far', ledgerText({ slug: 'far', parent: 'epic', worktree: path.join(h, 'elsewhere/far') }));
  const files = [parent, a, far];
  const before = files.map(read);
  failed(ledger(h, app, 'tree', 'order', 'epic', 'a', 'far'), /\bfar\b.*not on this machine/);
  assert.deepEqual(files.map(read), before);
});

test('tree depends sets the tasks a child waits for, by slug, path or address, and with none clears them', (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const b = backlogTask(h, app, { slug: 'b', parent: 'epic' });
  const stdout = ok(ledger(h, app, 'tree', 'depends', 'b', 'a', `z@${app}`, 'api@github.com/Acme/API.git', `lib-x@${lib}`));
  assert.equal(stdout, `b waits for a, z, api@github.com/acme/api, lib-x@${repoKeyOf(lib)}.\n`);
  assert.match(read(b), new RegExp(`^- depends on: a, z, api @ github\\.com/acme/api, lib-x @ ${repoKeyOf(lib)}$`, 'm'));
  assert.equal(ok(ledger(h, app, 'tree', 'depends', 'b')), 'b waits for no task.\n');
  assert.doesNotMatch(read(b), /depends on/);
  const w = worktreeTask(h, app, { slug: 'w' });
  ok(ledger(h, app, 'tree', 'depends', 'w', 'a'));
  assert.match(read(w), /^- depends on: a$/m);
});

test('tree depends takes a remote address as a URL or in the scp form, and stores the key remoteKey gives it', (t) => {
  const { h, app } = setup(t);
  const b = backlogTask(h, app, { slug: 'b' });
  const stdout = ok(ledger(h, app, 'tree', 'depends', 'b', 'api@https://github.com/Acme/API.git', 'web@https://github.com/acme/web', 'cli@git@github.com:Acme/CLI.git', 'ops@ssh://git@host.example:2222/o/ops.git'));
  assert.equal(stdout, 'b waits for api@github.com/acme/api, web@github.com/acme/web, cli@github.com/acme/cli, ops@host.example:2222/o/ops.\n');
  assert.match(read(b), /^- depends on: api @ github\.com\/acme\/api, web @ github\.com\/acme\/web, cli @ github\.com\/acme\/cli, ops @ host\.example:2222\/o\/ops$/m);
});

test('tree depends refuses a slug that is no slug and an address that gives no repo key, and writes nothing', (t) => {
  const { h, app } = setup(t);
  const b = backlogTask(h, app, { slug: 'b' });
  const before = read(b);
  failed(ledger(h, app, 'tree', 'depends', 'b', '.@github.com/o/r'), /"\." is not a slug/);
  failed(ledger(h, app, 'tree', 'depends', 'b', 'x@https://github.com/o//r'), /github\.com\/o\/\/r.*neither a folder nor a repo address/);
  failed(ledger(h, app, 'tree', 'depends', 'b', 'x@https://github.com/../r'), /neither a folder nor a repo address/);
  assert.equal(read(b), before);
});

test('tree depends takes a repo key as it stores one, and stores that key unchanged', (t) => {
  const { h, app } = setup(t);
  const b = backlogTask(h, app, { slug: 'b' });
  ok(ledger(h, app, 'tree', 'depends', 'b', 'ops@ssh://git@host.example:2222/o/ops.git', 'api@https://host/o/r', 'one@https://host/r'));
  const stored = /^- depends on: (.*)$/m.exec(read(b))?.[1] ?? assert.fail(read(b));
  assert.equal(stored, 'ops @ host.example:2222/o/ops, api @ host/o/r, one @ host/r');
  const keys = stored.split(', ').map((item) => item.replace(' @ ', '@'));
  assert.equal(ok(ledger(h, app, 'tree', 'depends', 'b', ...keys)), 'b waits for ops@host.example:2222/o/ops, api@host/o/r, one@host/r.\n');
  assert.equal(/^- depends on: (.*)$/m.exec(read(b))?.[1], stored);
});

test('tree depends takes back each key it stored, with a port, an IPv6 host or a + in a folder, unchanged', (t) => {
  const { h, app } = setup(t);
  const b = backlogTask(h, app, { slug: 'b' });
  const keys = ['[2001:db8::1]:2222/o/r', 'git.example/team/r+v', 'host:2222/r'];
  for (const key of keys) {
    assert.equal(ok(ledger(h, app, 'tree', 'depends', 'b', `api@${key}`)), `b waits for api@${key}.\n`);
    assert.equal(/^- depends on: (.*)$/m.exec(read(b))?.[1], `api @ ${key}`);
    assert.deepEqual(parseLedger(read(b)).location.dependencies, [{ slug: 'api', repo: key }], key);
  }
});

test('tree depends takes a repo key with a trailing slash, and stores it without', (t) => {
  const { h, app } = setup(t);
  const b = backlogTask(h, app, { slug: 'b' });
  assert.equal(ok(ledger(h, app, 'tree', 'depends', 'b', 'api@github.com/acme/api/', 'web@host:2222/r//')), 'b waits for api@github.com/acme/api, web@host:2222/r.\n');
  assert.equal(/^- depends on: (.*)$/m.exec(read(b))?.[1], 'api @ github.com/acme/api, web @ host:2222/r');
});

test('tree depends takes a stored path key whose checkout is gone, and stores it unchanged', (t) => {
  const { h, app } = setup(t);
  const b = backlogTask(h, app, { slug: 'b' });
  const gone = path.join(h, 'gone', 'lib');
  assert.equal(ok(ledger(h, app, 'tree', 'depends', 'b', `api@${gone}`)), `b waits for api@${gone}.\n`);
  assert.equal(/^- depends on: (.*)$/m.exec(read(b))?.[1], `api @ ${gone}`);
});

test('tree depends refuses a URL whose key would not read back as the same repo, names both, and writes nothing', (t) => {
  const { h, app } = setup(t);
  const b = backlogTask(h, app, { slug: 'b' });
  const before = read(b);
  failed(ledger(h, app, 'tree', 'depends', 'b', 'api@https://git.example/team/r+v.git.git'), /https:\/\/git\.example\/team\/r\+v\.git\.git.*git\.example\/team\/r\+v\.git\b.*would not read back as the same repo/s);
  assert.equal(read(b), before);
  assert.equal(ok(ledger(h, app, 'tree', 'depends', 'b', 'api@https://github.com/o/r.git')), 'b waits for api@github.com/o/r.\n');
  assert.equal(/^- depends on: (.*)$/m.exec(read(b))?.[1], 'api @ github.com/o/r');
});

test('tree depends refuses an address whose key is a folder here, which would read back as another repo, and writes nothing', (t) => {
  const { h, app } = setup(t);
  mkdirSync(path.join(app, 'tools/ledger'), { recursive: true });
  const b = backlogTask(h, app, { slug: 'b' });
  const before = read(b);
  failed(ledger(h, app, 'tree', 'depends', 'b', 'api@https://tools/ledger.git'), /https:\/\/tools\/ledger\.git.*stored as tools\/ledger\b.*would not read back as the same repo/s);
  failed(ledger(h, app, 'tree', 'depends', 'b', 'api@tools/ledger.git'), /tools\/ledger\.git.*stored as tools\/ledger\b.*would not read back as the same repo/s);
  assert.equal(read(b), before);
});

test('tree depends refuses an @ with no repo after it, and writes nothing', (t) => {
  const { h, app } = setup(t);
  const b = backlogTask(h, app, { slug: 'b' });
  const before = read(b);
  failed(ledger(h, app, 'tree', 'depends', 'b', 'api@'), /api@ names no repo after the @/);
  assert.equal(read(b), before);
});

test('tree depends refuses a checkout whose remote gives a key the ledger could not read back, and writes nothing', (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  git(h, lib, 'remote', 'set-url', 'origin', 'https://host.example/x//bad');
  worktreeTask(h, app, { slug: 'p', children: ['- b'] });
  const b = backlogTask(h, app, { slug: 'b', parent: 'p' });
  const before = read(b);
  failed(ledger(h, app, 'tree', 'depends', 'b', `api@${lib}`), /host\.example\/x\/\/bad/);
  assert.equal(read(b), before);
  assert.equal(ok(ledger(h, app, 'tree', 'next', 'p')), 'p b\n');
});

test('tree depends refuses a task that waits for itself, a cycle, also through another repo, and a name that is no folder or address', (t) => {
  const { h, app } = setup(t);
  const files = ['a', 'b', 'c'].map((slug) => backlogTask(h, app, { slug }));
  ok(ledger(h, app, 'tree', 'depends', 'a', 'b'));
  ok(ledger(h, app, 'tree', 'depends', 'b', 'c'));
  const api = path.join(h, '.claude/ledger-backlog', encodeURIComponent('github.com/acme/api'), 'api.md');
  mkdirSync(path.dirname(api), { recursive: true });
  writeFileSync(api, ledgerText({ slug: 'api' }).replace('\n\n## Plan', `\n- depends on: a @ ${repoKeyOf(app)}\n\n## Plan`));
  const before = [...files, api].map(read);
  failed(ledger(h, app, 'tree', 'depends', 'a', 'a'), /a cannot wait for itself/);
  failed(ledger(h, app, 'tree', 'depends', 'a', `a@${app}`), /a cannot wait for itself/);
  failed(ledger(h, app, 'tree', 'depends', 'c', 'a'), /cycle: c → a → b → c/);
  failed(ledger(h, app, 'tree', 'depends', 'c', 'api@github.com/acme/api'), /cycle: c → api@github\.com\/acme\/api → a → b → c/);
  failed(ledger(h, app, 'tree', 'depends', 'a', 'x@no-such-folder'), /no-such-folder.*neither a folder nor a repo address/);
  assert.deepEqual([...files, api].map(read), before);
});

test('tree next picks the first child by order whose dependencies are done: retired, by address too, or in state done', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- a', '- b', '- c'] });
  located(backlogTask(h, app, { slug: 'a', parent: 'epic' }), '- order: 3');
  located(backlogTask(h, app, { slug: 'b', parent: 'epic' }), '- order: 2', '- depends on: a');
  located(backlogTask(h, app, { slug: 'c', parent: 'epic' }), '- order: 1', '- depends on: old, shipped, api @ github.com/acme/api');
  archivedTask(h, app, '2026-10-19', { slug: 'old' });
  located(worktreeTask(h, app, { slug: 'shipped' }), '- state: done');
  const api = archivedUnder(h, 'github.com/acme/api', 'api');
  assert.equal(ok(ledger(h, app, 'tree', 'next', 'epic')), 'epic c\n');
  rmSync(api);
  assert.equal(ok(ledger(h, app, 'tree', 'next', 'epic')), 'epic a\n', 'an unknown dependency is not done, so c and b wait');
});

test('tree next finds a done dependency in a repo without remote that only the dependency names, in a worktree or the archive', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- b'] });
  const b = backlogTask(h, app, { slug: 'b', parent: 'epic' });
  assert.equal(ok(ledger(h, app, 'tree', 'next', 'epic')), 'epic b\n', 'before lib exists');
  const lib = repository(h, path.join(h, 'elsewhere/lib'));
  git(h, lib, 'remote', 'remove', 'origin');
  located(worktreeTask(h, lib, { slug: 'shipped' }), '- state: done');
  archivedTask(h, lib, '2026-10-19', { slug: 'old' });
  located(b, `- depends on: shipped @ ${lib}, old @ ${lib}`);
  assert.equal(ok(ledger(h, app, 'tree', 'next', 'epic')), 'epic b\n');
});

test('tree next with every child waiting prints nothing and says on stderr what each child waits for', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'stuck', children: ['- x', '- y'] });
  located(backlogTask(h, app, { slug: 'x', parent: 'stuck' }), '- depends on: y');
  located(backlogTask(h, app, { slug: 'y', parent: 'stuck' }), '- depends on: nowhere, api @ github.com/acme/other');
  const ran = ledger(h, app, 'tree', 'next', 'stuck');
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, '');
  assert.match(ran.stderr, /^No child task of stuck can start yet:$/m);
  assert.match(ran.stderr, /^ +x waits for y\.$/m);
  assert.match(ran.stderr, /^ +y waits for nowhere, api@github\.com\/acme\/other\.$/m);
});

test('go on a parent starts its first ready child by order; a backlog parent whose children all wait fails and names what they wait for', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- a', '- b'] });
  located(backlogTask(h, app, { slug: 'a', parent: 'epic' }), '- order: 2');
  located(backlogTask(h, app, { slug: 'b', parent: 'epic' }), '- order: 1', '- depends on: a');
  ok(ledger(h, app, 'go', 'epic'));
  assert.equal(existsSync(activeFile(h, app, 'a')), true);
  assert.equal(existsSync(worktreeOf(app, 'b')), false);

  backlogTask(h, app, { slug: 'plan', children: ['- p'] });
  const p = backlogTask(h, app, { slug: 'p', parent: 'plan' });
  located(p, '- depends on: nope');
  failed(ledger(h, app, 'go', 'plan'), /p waits for nope/);
  assert.equal(existsSync(p), true);
});

/** The command a `start:` line prints, run by a shell: `/ledger:go <slug>` is `ledger go <slug>`. */
function runStart(h: string, cwd: string, stdout: string) {
  const start = /^start: +(.*)$/m.exec(stdout)?.[1] ?? assert.fail(`no start line in:\n${stdout}`);
  const command = start.replace(/^\/ledger:go /, 'ledger go ');
  assert.match(command, /^ledger /, start);
  return spawn(h, cwd, 'sh', ['-c', `'${LEDGER_BIN}'${command.slice('ledger'.length)}`]);
}

test('ledger task --repo prints the start command the Decisions line names, and it promotes the task from here', (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const here = worktreeOf(app, 'epic');
  const current = worktreeTask(h, app, { slug: 'epic' });
  const stdout = ok(ledger(h, here, 'task', 'new', 'lib-part', '--repo', lib, '--goal', 'In lib.'));
  assert.match(stdout, new RegExp(`^start: {3}ledger go lib-part --repo ${lib}$`, 'm'));
  assert.match(read(current), new RegExp(`ledger go lib-part --repo ${lib} starts it\\.`));
  ok(runStart(h, here, stdout));
  assert.equal(existsSync(activeFile(h, lib, 'lib-part')), true);
  assert.equal(existsSync(backlogFile(h, lib, 'lib-part')), false);
});

test('ledger task --repo from a main checkout prints a start command that promotes the task from there', (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const stdout = ok(ledger(h, app, 'task', 'new', 'lib-part', '--repo', lib));
  assert.match(stdout, new RegExp(`^start: {3}ledger go lib-part --repo ${lib}$`, 'm'));
  ok(runStart(h, app, stdout));
  assert.equal(git(h, worktreeOf(lib, 'lib-part'), 'branch', '--show-current'), 'lib-part');
});

test('ledger task --repo naming this repo keeps the short start command, and it works', (t) => {
  const { h, app } = setup(t);
  const stdout = ok(ledger(h, app, 'task', 'new', 'same-repo', '--repo', app));
  assert.match(stdout, /^start: {3}\/ledger:go same-repo$/m);
  ok(runStart(h, app, stdout));
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

test('parent next and parent start ignore a prose bullet under ## Children', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- Superseded by the new plan.', '- nested'] });
  backlogTask(h, app, { slug: 'nested', parent: 'epic', children: ['- RN-side work is tracked elsewhere.'] });
  assert.equal(ok(ledger(h, app, 'tree', 'next', 'epic')), 'epic nested\n');
  const file = activeFile(h, app, 'epic');
  const before = read(file);
  failed(ledger(h, app, 'tree', 'start', 'epic', 'Superseded'), /Superseded.*no task/);
  assert.equal(read(file), before);
});
