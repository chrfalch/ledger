import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { REPO } from './helpers.js';
import { archivedTask, backlogTask, git, home, ledger, LEDGER_BIN, ledgerText, ok, repository, spawn, worktreeTask } from './ledger-core-fixtures.js';

const TEMPLATE = readFileSync(path.join(REPO, 'ledger.template.md'), 'utf8');

/** A HOME with ~/.claude/ledger.template.md and the repo ~/repos/app. */
function setup(t: TestContext) {
  const h = home(t);
  copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
  const app = repository(h, path.join(h, 'repos/app'));
  return { h, app };
}

const read = (file: string): string => readFileSync(file, 'utf8');
const backlogFile = (h: string, main: string, slug: string): string => path.join(h, '.claude/ledger-backlog', path.basename(main), `${slug}.md`);
const worktreeOf = (main: string, slug: string): string => path.join(main, '.claude/worktrees', slug);
const ledgerOf = (worktree: string): string => path.join(worktree, '.claude/ledger.md');
const short = (h: string, cwd: string, ref: string): string => git(h, cwd, 'rev-parse', '--short', ref);
type RegistryEntry = { path: string; status: string; slug: string; parent?: string };
const registry = (h: string): RegistryEntry[] => JSON.parse(read(path.join(h, '.claude/ledgers.json')));

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
    .replace(/^- design refs: .*\n/m, '');
}

/** `text` with one line inserted after the line `after`, which must occur once. */
function inserted(text: string, after: string, ...lines: string[]): string {
  assert.equal(text.split(`\n${after}\n`).length, 2, `"${after}" occurs once`);
  return text.replace(`\n${after}\n`, `\n${[after, ...lines].join('\n')}\n`);
}

test('ledger --help lists the writing commands, and each has its own --help', (t) => {
  const { h } = setup(t);
  const root = ok(ledger(h, h, '--help'));
  for (const command of ['task', 'go', 'park', 'unpark']) assert.match(root, new RegExp(`^\\s+${command}\\b`, 'm'), `--help lists ${command}`);
  const expected: Record<string, RegExp[]> = {
    task: [/\[slug\]/, /--goal/, /--stack/, /--here/, /--repo/],
    go: [/<slug>/, /--repo/, /- base:/],
    park: [/<slug>/, /--reason/],
    unpark: [/<slug>/],
    parent: [/<slug>/, /\badd\b/, /\bremove\b/, /\bstart\b/, /\bnext\b/, /--json/],
  };
  for (const [command, patterns] of Object.entries(expected)) {
    const stdout = ok(ledger(h, h, command, '--help'));
    assert.match(stdout, new RegExp(`^Usage: ledger ${command}\\b`, 'm'));
    for (const pattern of patterns) assert.match(stdout, pattern, `${command} --help`);
  }
});

test('ledger task refuses a slug the creation rule does not accept, and writes nothing', (t) => {
  const { h, app } = setup(t);
  for (const slug of ['Fix_Login', 'a.b', '-x']) {
    failed(ledger(h, app, 'task', '--goal', 'x', '--', slug), /slug/);
    assert.equal(existsSync(backlogFile(h, app, slug)), false);
  }
});

test('ledger task writes a backlog ledger from ~/.claude/ledger.template.md and prints the start line', (t) => {
  const { h, app } = setup(t);
  const stdout = ok(ledger(h, app, 'task', 'fix-login', '--goal', 'Users cannot log in. Done when they can.'));
  const file = backlogFile(h, app, 'fix-login');
  assert.equal(stdout, `ledger:  ${file}\nstatus:  backlog\nstart:   /ledger:go fix-login\n`);
  assert.equal(read(file), backlogText('fix-login', 'Users cannot log in. Done when they can.', app));
  assert.deepEqual(
    registry(h).filter(({ path: entry }) => entry === file).map(({ slug, status }) => [slug, status]),
    [['fix-login', 'backlog']],
  );
});

test('ledger task in a repo with llp/ writes "design refs: none"; without --goal the goal stays a placeholder', (t) => {
  const { h, app } = setup(t);
  mkdirSync(path.join(app, 'llp'));
  ok(ledger(h, app, 'task', 'plain'));
  const text = read(backlogFile(h, app, 'plain'));
  assert.match(text, /^- design refs: none$/m);
  assert.match(text, /^<one paragraph — what done looks like>$/m);
});

test('ledger task refuses a slug that already has a backlog ledger, a branch or a worktree folder', (t) => {
  const { h, app } = setup(t);
  ok(ledger(h, app, 'task', 'twice'));
  const before = read(backlogFile(h, app, 'twice'));
  failed(ledger(h, app, 'task', 'twice', '--goal', 'other'), /already/);
  assert.equal(read(backlogFile(h, app, 'twice')), before);
  git(h, app, 'branch', 'taken');
  failed(ledger(h, app, 'task', 'taken'), /branch/);
  mkdirSync(worktreeOf(app, 'folder'), { recursive: true });
  failed(ledger(h, app, 'task', 'folder'), /folder/);
});

test('ledger task fails when ~/.claude/ledger.template.md is missing', (t) => {
  const { h, app } = setup(t);
  rmSync(path.join(h, '.claude/ledger.template.md'));
  failed(ledger(h, app, 'task', 'no-template'), /ledger\.template\.md/);
  assert.equal(existsSync(backlogFile(h, app, 'no-template')), false);
});

test('ledger task from a worktree with a ledger adds one Decisions line naming the new task; nothing else changes', (t) => {
  const { h, app } = setup(t);
  const current = worktreeTask(h, app, { slug: 'epic' });
  const before = read(current);
  const stdout = ok(ledger(h, worktreeOf(app, 'epic'), 'task', 'side-quest', '--goal', 'Separate work.'));
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
  ok(ledger(h, worktreeOf(app, 'epic'), 'task', 'lib-part', '--repo', lib, '--goal', 'In lib.'));
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
  ok(ledger(h, app, 'task', 'lonely'));
  assert.equal(read(other), before);
});

test('ledger task --here adds a ledger to the current linked worktree, named after its branch, and prints no start line', (t) => {
  const { h, app } = setup(t);
  const worktree = worktreeOf(app, 'side');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'me/side', worktree, 'main');
  const stdout = ok(ledger(h, worktree, 'task', '--here', '--goal', 'Here it is.'));
  const file = ledgerOf(worktree);
  const base = short(h, worktree, 'HEAD');
  assert.equal(stdout, `worktree ${worktree}\nbranch   me/side\nbase     HEAD @ ${base}\nledger   ${file}\n`);
  assert.doesNotMatch(stdout, /start:/);
  const expected = TEMPLATE.replace('# Task ledger — <slug>', '# Task ledger — side')
    .replace('<one paragraph — what done looks like>', 'Here it is.')
    .replace('- worktree: <path>', `- worktree: ${worktree}`)
    .replace('- branch: <name>', '- branch: me/side')
    .replace('- base: <branch/commit>', `- base: HEAD @ ${base}`)
    .replace(/^- design refs: .*\n/m, '');
  assert.equal(read(file), expected);
  assert.deepEqual(registry(h).filter(({ path: entry }) => entry === file).map(({ status }) => status), ['active']);
});

test('ledger task --here <slug> takes the slug given', (t) => {
  const { h, app } = setup(t);
  const worktree = worktreeOf(app, 'side');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'me/side', worktree, 'main');
  ok(ledger(h, worktree, 'task', '--here', 'named'));
  assert.match(read(ledgerOf(worktree)), /^# Task ledger — named$/m);
});

test('ledger task --here refuses the main checkout, a worktree that has a ledger, --stack and --repo', (t) => {
  const { h, app } = setup(t);
  failed(ledger(h, app, 'task', '--here', 'x'), /main checkout/);
  worktreeTask(h, app, { slug: 'epic' });
  const epic = worktreeOf(app, 'epic');
  const before = read(ledgerOf(epic));
  failed(ledger(h, epic, 'task', '--here'), /already has a ledger/);
  assert.equal(read(ledgerOf(epic)), before);
  failed(ledger(h, epic, 'task', '--here', '--stack'), /--stack/);
  failed(ledger(h, epic, 'task', '--here', '--repo', app), /--repo/);
});

test('ledger task --stack makes the worktree and branch at once, on top of the current branch', (t) => {
  const { h, app } = setup(t);
  const current = worktreeTask(h, app, { slug: 'epic' });
  const epic = worktreeOf(app, 'epic');
  git(h, epic, 'commit', '--quiet', '--allow-empty', '-m', 'epic work');
  const stdout = ok(ledger(h, epic, 'task', 'sub', '--stack', '--goal', 'Builds on epic.'));
  const worktree = worktreeOf(app, 'sub');
  const base = short(h, epic, 'HEAD');
  assert.equal(
    stdout.split('\n').filter((line) => !line.startsWith('noted')).join('\n'),
    `worktree ${worktree}\nbranch   sub\nbase     me/epic @ ${base}\nledger   ${ledgerOf(worktree)}\nstart:   /ledger:go sub\n`,
  );
  assert.equal(git(h, worktree, 'rev-parse', 'HEAD'), git(h, epic, 'rev-parse', 'HEAD'));
  assert.equal(git(h, worktree, 'branch', '--show-current'), 'sub');
  const text = read(ledgerOf(worktree));
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
  failed(ledger(h, worktree, 'task', 'sub', '--stack'), /detached/);
  assert.equal(existsSync(worktreeOf(app, 'sub')), false);
});

test('ledger task --repo writes the backlog ledger of another repo', (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const stdout = ok(ledger(h, app, 'task', 'lib-part', '--repo', lib, '--goal', 'In lib.'));
  const file = backlogFile(h, lib, 'lib-part');
  assert.match(stdout, new RegExp(`^ledger: {2}${file}$`, 'm'));
  assert.equal(read(file), backlogText('lib-part', 'In lib.', lib));
});

test('ledger go moves a backlog ledger into a new worktree and branch from the default branch, and fills Location', (t) => {
  const { h, app } = setup(t);
  ok(ledger(h, app, 'task', 'fix-login', '--goal', 'Fix it.'));
  const backlog = backlogFile(h, app, 'fix-login');
  const before = read(backlog);
  git(h, app, 'checkout', '--quiet', '-b', 'elsewhere');
  git(h, app, 'commit', '--quiet', '--allow-empty', '-m', 'not on main');
  const stdout = ok(ledger(h, app, 'go', 'fix-login'));
  const worktree = worktreeOf(app, 'fix-login');
  const base = short(h, app, 'origin/main');
  assert.equal(stdout, `worktree ${worktree}\nbranch   fix-login\nbase     origin/main @ ${base}\nledger   ${ledgerOf(worktree)}\n`);
  assert.equal(existsSync(backlog), false);
  const expected = before
    .replace(`- main: ${app}\n`, '')
    .replace('- worktree: <path>', `- worktree: ${worktree}`)
    .replace('- branch: <name>', '- branch: fix-login')
    .replace('- base: <branch/commit>', `- base: origin/main @ ${base}`);
  assert.equal(read(ledgerOf(worktree)), expected);
  assert.equal(git(h, worktree, 'rev-parse', 'HEAD'), git(h, app, 'rev-parse', 'origin/main'));
  assert.equal(git(h, worktree, 'branch', '--show-current'), 'fix-login');
  assert.match(read(path.join(app, '.git/info/exclude')), /^\.claude\/evidence\/$/m);
  const entries = registry(h);
  assert.deepEqual(entries.filter(({ path: entry }) => entry === ledgerOf(worktree)).map(({ status }) => status), ['active']);
  assert.equal(entries.some(({ path: entry }) => entry === backlog), false);
});

test('ledger go --repo promotes a cross-repo child in its own repo', (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  worktreeTask(h, app, { slug: 'epic', children: [`- lib-part @ ${lib}`] });
  backlogTask(h, lib, { slug: 'lib-part', parent: `epic @ ${app}` });
  ok(ledger(h, app, 'go', 'lib-part', '--repo', lib));
  const worktree = worktreeOf(lib, 'lib-part');
  assert.equal(existsSync(backlogFile(h, lib, 'lib-part')), false);
  const text = read(ledgerOf(worktree));
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
  ok(ledger(h, twin, 'task', 'twin-task'));
  failed(ledger(h, app, 'go', 'twin-task'), new RegExp(twin), 3);
  const file = backlogFile(h, app, 'no-main');
  writeFileSync(file, ledgerText({ slug: 'no-main' }));
  failed(ledger(h, app, 'go', 'no-main'), /main/, 4);
  assert.equal(existsSync(worktreeOf(app, 'no-main')), false);
});

test('ledger go fails when the branch exists, and leaves the backlog ledger and no worktree', (t) => {
  const { h, app } = setup(t);
  ok(ledger(h, app, 'task', 'taken-later'));
  git(h, app, 'branch', 'taken-later');
  failed(ledger(h, app, 'go', 'taken-later'), /branch/);
  assert.equal(existsSync(backlogFile(h, app, 'taken-later')), true);
  assert.equal(existsSync(worktreeOf(app, 'taken-later')), false);
});

test('ledger go removes the new worktree and branch again when a later step fails, and keeps the backlog ledger', (t) => {
  const { h, app } = setup(t);
  ok(ledger(h, app, 'task', 'stuck', '--goal', 'Cannot move.'));
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
  const worktree = worktreeOf(app, 'Old.Task_2');
  assert.match(read(ledgerOf(worktree)), /^# Task ledger — Old\.Task_2$/m);
  assert.equal(existsSync(backlogFile(h, app, 'Old.Task_2')), false);
  failed(ledger(h, app, 'go', 'a b'), /"a b" is not a slug\. A slug has only letters, digits, dots, underscores and hyphens\./, 1);
});

test('ledger parent add takes a child as <slug>@<relative path> and writes its repo as the absolute main checkout', (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const parent = worktreeTask(h, app, { slug: 'epic' });
  const child = backlogTask(h, lib, { slug: 'part' });
  ok(ledger(h, path.join(app, '.claude'), 'parent', 'epic', 'add', 'part@../../lib'));
  assert.match(read(parent), new RegExp(`^- part @ ${lib}$`, 'm'));
  assert.match(read(child), new RegExp(`^- parent: epic @ ${app}$`, 'm'));
  ok(ledger(h, app, 'parent', 'epic', 'remove', 'part@../lib'));
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
  assert.match(read(ledgerOf(worktree)), new RegExp(`^- base: feature @ ${short(h, app, 'feature')}$`, 'm'));
});

test('ledger park puts one marker first under Next step; unpark restores the exact bytes', (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const before = read(file);
  const stdout = ok(ledger(h, app, 'park', 'epic', '--reason', 'waiting for review'));
  const marker = `Parked: ${today()} — waiting for review`;
  assert.match(stdout, new RegExp(`${marker}`));
  assert.equal(read(file), inserted(before, '## Next step', marker));
  const listed = JSON.parse(ok(ledger(h, app, 'list', '--json'))) as { slug: string; status: string }[];
  assert.equal(listed.find(({ slug }) => slug === 'epic')?.status, 'parked');
  ok(ledger(h, app, 'park', 'epic', '--reason', 'still waiting'));
  assert.equal(read(file), inserted(before, '## Next step', `Parked: ${today()} — still waiting`));
  ok(ledger(h, app, 'unpark', 'epic'));
  assert.equal(read(file), before);
});

test('park and unpark keep CRLF line endings; park works on a backlog task', (t) => {
  const { h, app } = setup(t);
  const file = backlogTask(h, app, { slug: 'idea' });
  const before = read(file).replace(/\n/g, '\r\n');
  writeFileSync(file, before);
  ok(ledger(h, app, 'park', 'idea', '--reason', 'no time'));
  const after = read(file);
  assert.equal(after, before.replace('\r\n## Next step\r\n', `\r\n## Next step\r\nParked: ${today()} — no time\r\n`));
  ok(ledger(h, app, 'unpark', 'idea'));
  assert.equal(read(file), before);
});

test('park requires a reason: without --reason, or with an empty one, it fails and changes nothing', (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const before = read(file);
  failed(ledger(h, app, 'park', 'epic'), /--reason/);
  failed(ledger(h, app, 'park', 'epic', '--reason', '  '), /reason/);
  assert.equal(read(file), before);
});

test('a later "Parked:" note under ## Next step is no marker: park and unpark leave it in place', (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic', next: 'Run the tests.\nParked: 2026-11-10 — an old note' });
  const before = read(file);
  ok(ledger(h, app, 'park', 'epic', '--reason', 'later'));
  assert.equal(read(file), inserted(before, '## Next step', `Parked: ${today()} — later`));
  ok(ledger(h, app, 'unpark', 'epic'));
  assert.equal(read(file), before);
});

test('park adds ## Next step when a ledger has none; unpark of a task that is not parked changes nothing', (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'epic' });
  const full = read(file);
  const before = full.slice(0, full.indexOf('## Next step'));
  writeFileSync(file, before);
  ok(ledger(h, app, 'park', 'epic', '--reason', 'later'));
  assert.equal(read(file), `${before.trimEnd()}\n\n## Next step\nParked: ${today()} — later\n\n`);
  writeFileSync(file, full);
  const stdout = ok(ledger(h, app, 'unpark', 'epic'));
  assert.match(stdout, /not parked/);
  assert.equal(read(file), full);
});

test('park and unpark of an unknown slug fail', (t) => {
  const { h, app } = setup(t);
  failed(ledger(h, app, 'park', 'ghost', '--reason', 'x'), /ghost/);
  failed(ledger(h, app, 'unpark', 'ghost'), /ghost/);
});

test('ledger parent add links a child in the same repo; remove restores both ledgers byte for byte', (t) => {
  const { h, app } = setup(t);
  const parent = worktreeTask(h, app, { slug: 'epic' });
  const child = backlogTask(h, app, { slug: 'idea' });
  const [parentBefore, childBefore] = [read(parent), read(child)];
  ok(ledger(h, app, 'parent', 'epic', 'add', 'idea'));
  assert.equal(read(child), inserted(childBefore, '- design refs: none', '- parent: epic'));
  assert.equal(read(parent), inserted(parentBefore, '- design refs: none', '', '## Children', '- idea'));
  const shown = JSON.parse(ok(ledger(h, app, 'parent', 'epic', '--json'))) as { children: { slug: string; status: string }[] };
  assert.deepEqual(shown.children.map(({ slug, status }) => [slug, status]), [['idea', 'backlog']]);
  assert.equal(registry(h).find(({ path: entry }) => entry === child)?.parent, 'epic');
  ok(ledger(h, app, 'parent', 'epic', 'remove', 'idea'));
  assert.equal(read(parent), parentBefore);
  assert.equal(read(child), childBefore);
});

test('parent add appends to ## Children and keeps a line with an unknown suffix verbatim', (t) => {
  const { h, app } = setup(t);
  const odd = '- old-d (LANDED 2026-11-03; retire pending)';
  const parent = worktreeTask(h, app, { slug: 'epic', children: [odd] });
  backlogTask(h, app, { slug: 'idea' });
  const before = read(parent);
  ok(ledger(h, app, 'parent', 'epic', 'add', 'idea'));
  assert.equal(read(parent), inserted(before, odd, '- idea'));
  ok(ledger(h, app, 'parent', 'epic', 'remove', 'idea'));
  assert.equal(read(parent), before);
});

test('parent add of a child in another repo writes both mains; remove drops them again', (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const parent = worktreeTask(h, app, { slug: 'epic' });
  const child = backlogTask(h, lib, { slug: 'lib-part' });
  const [parentBefore, childBefore] = [read(parent), read(child)];
  ok(ledger(h, app, 'parent', 'epic', 'add', `lib-part@${lib}`));
  assert.equal(read(child), inserted(childBefore, '- design refs: none', `- parent: epic @ ${app}`));
  assert.equal(read(parent), inserted(parentBefore, '- design refs: none', '', '## Children', `- lib-part @ ${lib}`));
  ok(ledger(h, lib, 'parent', `epic@${app}`, 'remove', 'lib-part'));
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
  failed(ledger(h, app, 'parent', 'epic', 'add', 'epic'), /own parent/);
  failed(ledger(h, app, 'parent', 'epic', 'add', 'taken'), /already has the parent other/);
  failed(ledger(h, app, 'parent', 'epic', 'add', 'top'), /cycle/);
  failed(ledger(h, app, 'parent', 'epic', 'add', 'old-a'), /retired/);
  failed(ledger(h, app, 'parent', 'epic', 'remove', 'loose'), /not a child/);
  failed(ledger(h, app, 'parent', 'epic', 'add'), /child/);
  failed(ledger(h, app, 'parent', 'epic', 'adopt', 'loose'), /adopt/);
  assert.deepEqual(files.map(read), before);
});

test('parent start marks a child started, keeps an unknown suffix verbatim, and leaves a marked line alone', (t) => {
  const { h, app } = setup(t);
  const odd = '- old-d (LANDED 2026-11-03; retire pending)';
  const parent = worktreeTask(h, app, { slug: 'epic', children: ['- a', odd, '- b (started 2026-11-01)'] });
  for (const slug of ['a', 'old-d', 'b']) backlogTask(h, app, { slug, parent: 'epic' });
  const before = read(parent);
  ok(ledger(h, app, 'parent', 'epic', 'start', 'a'));
  ok(ledger(h, app, 'parent', 'epic', 'start', 'old-d'));
  ok(ledger(h, app, 'parent', 'epic', 'start', 'b'));
  const expected = before
    .replace('\n- a\n', `\n- a (started ${today()})\n`)
    .replace(`\n${odd}\n`, `\n- old-d (started ${today()}) (LANDED 2026-11-03; retire pending)\n`);
  assert.equal(read(parent), expected);
  failed(ledger(h, app, 'parent', 'epic', 'start', 'unlisted'), /not listed/);
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
  assert.equal(ok(ledger(h, app, 'parent', 'epic', 'next')), 'epic nested deep\n');
  worktreeTask(h, app, { slug: 'cross', children: [`- lib-part @ ${lib}`] });
  backlogTask(h, lib, { slug: 'lib-part', parent: `cross @ ${app}` });
  assert.equal(ok(ledger(h, app, 'parent', 'cross', 'next')), `cross lib-part@${lib}\n`);
  worktreeTask(h, app, { slug: 'finished', children: ['- running'] });
  const none = ledger(h, app, 'parent', 'finished', 'next');
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, '');
});

test('parent next offers a backlog child even when its Children line says started: the disk decides', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- marked (started 2026-11-01)', '- later'] });
  backlogTask(h, app, { slug: 'marked', parent: 'epic' });
  backlogTask(h, app, { slug: 'later', parent: 'epic' });
  assert.equal(ok(ledger(h, app, 'parent', 'epic', 'next')), 'epic marked\n');
});

test('parent next passes over a backlog child whose own children are all started or retired', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- nested', '- leaf'] });
  backlogTask(h, app, { slug: 'nested', parent: 'epic', children: ['- running', '- done-one'] });
  worktreeTask(h, app, { slug: 'running', parent: 'nested' });
  archivedTask(h, app, '2026-10-19', { slug: 'done-one', parent: 'nested' });
  backlogTask(h, app, { slug: 'leaf', parent: 'epic' });
  assert.equal(ok(ledger(h, app, 'parent', 'epic', 'next')), 'epic leaf\n');
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
  const stdout = ok(ledger(h, here, 'task', 'lib-part', '--repo', lib, '--goal', 'In lib.'));
  assert.match(stdout, new RegExp(`^start: {3}ledger go lib-part --repo ${lib}$`, 'm'));
  assert.match(read(current), new RegExp(`ledger go lib-part --repo ${lib} starts it\\.`));
  ok(runStart(h, here, stdout));
  assert.equal(existsSync(ledgerOf(worktreeOf(lib, 'lib-part'))), true);
  assert.equal(existsSync(backlogFile(h, lib, 'lib-part')), false);
});

test('ledger task --repo from a main checkout prints a start command that promotes the task from there', (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  const stdout = ok(ledger(h, app, 'task', 'lib-part', '--repo', lib));
  assert.match(stdout, new RegExp(`^start: {3}ledger go lib-part --repo ${lib}$`, 'm'));
  ok(runStart(h, app, stdout));
  assert.equal(git(h, worktreeOf(lib, 'lib-part'), 'branch', '--show-current'), 'lib-part');
});

test('ledger task --repo naming this repo keeps the short start command, and it works', (t) => {
  const { h, app } = setup(t);
  const stdout = ok(ledger(h, app, 'task', 'same-repo', '--repo', app));
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
  const stdout = ok(ledger(h, here, 'task', 'lib-part', '--repo', lib));
  assert.ok(stdout.includes(`\nstart:   ledger go lib-part --repo ${quoted}\n`), stdout);
  assert.ok(read(current).includes(`ledger go lib-part --repo ${quoted} starts it.`));
  ok(runStart(h, here, stdout));
  assert.equal(existsSync(ledgerOf(worktreeOf(lib, 'lib-part'))), true);
});

test('parent next and parent start ignore a prose bullet under ## Children', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- Superseded by the new plan.', '- nested'] });
  backlogTask(h, app, { slug: 'nested', parent: 'epic', children: ['- RN-side work is tracked elsewhere.'] });
  assert.equal(ok(ledger(h, app, 'parent', 'epic', 'next')), 'epic nested\n');
  const file = ledgerOf(worktreeOf(app, 'epic'));
  const before = read(file);
  failed(ledger(h, app, 'parent', 'epic', 'start', 'Superseded'), /Superseded.*no task/);
  assert.equal(read(file), before);
});
