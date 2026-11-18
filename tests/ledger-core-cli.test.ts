import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  archivedTask,
  backlogTask,
  home,
  ledger,
  ledgerText,
  lineWith,
  ok,
  repository,
  touch,
  worktreeTask,
} from './ledger-core-fixtures.js';

/**
 * Two repos under ~/repos. The parent task epic in app lists nine children: two live worktrees (one parked), a backlog
 * task, four archived tasks with no "(retired)" mark (one with a hand-written suffix, one archived under its branch name),
 * a child that exists nowhere (in the <slug>@<path> form, else it would be prose), and a child in the repo lib.
 */
function world(t: TestContext) {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  const lib = repository(h, path.join(h, 'repos/lib'));
  const epic = worktreeTask(h, app, {
    slug: 'epic',
    goal: 'Rewrite the ledger core.',
    children: [
      '- live-child (started 2026-11-02)',
      '- parked-child',
      '- idea',
      '- old-a',
      '- old-b',
      '- old-c (started 2026-10-20; PR #26 merged 2026-10-21)',
      '- old-d',
      `- ghost @ ${app}`,
      `- lib-part @ ${lib}`,
    ],
  });
  const live = worktreeTask(h, app, { slug: 'live-child', parent: 'epic', report: ['PR #31 is open.'] });
  const parked = worktreeTask(h, app, { slug: 'parked-child', parent: 'epic', next: 'Parked: 2026-11-10 — waiting for design\nThen implement.' });
  const idea = backlogTask(h, app, { slug: 'idea', parent: 'epic' });
  archivedTask(h, app, '2026-10-19', { slug: 'old-a', parent: 'epic' });
  archivedTask(h, app, '2026-10-21', { slug: 'old-b', parent: 'epic' });
  archivedTask(h, app, '2026-10-21', { slug: 'old-c', parent: 'epic', report: ['Merged in PR #26.'] });
  archivedTask(h, app, '2026-10-21', { slug: 'old-d', parent: 'epic', report: ['Merged in PR #27.'] }, 'feature-old-d');
  const libPart = worktreeTask(h, lib, { slug: 'lib-part', parent: `epic @ ${app}` });
  archivedTask(h, lib, '2026-09-01', { slug: 'lib-old', goal: 'An old task in lib.' });
  touch(epic, '2026-11-15T10:00:00Z');
  touch(live, '2026-11-14T10:00:00Z');
  touch(parked, '2026-11-13T10:00:00Z');
  touch(idea, '2026-11-12T10:00:00Z');
  touch(libPart, '2026-11-11T10:00:00Z');
  return { h, app, lib, files: { epic, live, parked, idea, libPart } };
}

type ListedTask = { slug: string; repo: string; main: string; status: string; path: string; branch: string; parent?: { slug: string; main: string }; updated: string; goal: string; next: string };
type ShownChild = { slug: string; main: string; status: string; next: string; report: string[] };
type Shown = { slug: string; main: string; goal: string; children: ShownChild[] };
type RegistryEntry = { repo: string; slug: string; path: string; branch: string; parent?: string; parentMain?: string; status: string; main?: string; created: string; updated: string; archivePath?: string };

const registryFile = (h: string): string => path.join(h, '.claude/ledgers.json');
const readRegistry = (h: string): RegistryEntry[] => JSON.parse(readFileSync(registryFile(h), 'utf8'));
const listJson = (h: string, cwd: string): ListedTask[] => JSON.parse(ok(ledger(h, cwd, 'list', '--json'))).tasks;

test('ledger --help lists list, archive, parent and deploy', (t) => {
  const stdout = ok(ledger(home(t), path.sep, '--help'));
  assert.match(stdout, /^Usage: ledger /m);
  for (const command of ['list', 'archive', 'parent', 'deploy']) assert.match(stdout, new RegExp(`^\\s+${command}\\b`, 'm'), `--help lists ${command}`);
});

test('each command has --help with its arguments and options', (t) => {
  const h = home(t);
  const expected: Record<string, RegExp[]> = {
    list: [/--json/],
    archive: [/\[term\]/, /--all/],
    parent: [/<slug>/, /--json/],
  };
  for (const [command, patterns] of Object.entries(expected)) {
    const stdout = ok(ledger(h, h, command, '--help'));
    assert.match(stdout, new RegExp(`^Usage: ledger ${command}\\b`, 'm'));
    for (const pattern of patterns) assert.match(stdout, pattern, `${command} --help`);
  }
  assert.match(ok(ledger(h, h, 'help', 'archive')), /^Usage: ledger archive\b/m);
});

test('ledger deploy --help prints the help of bin/deploy', (t) => {
  const h = home(t);
  const stdout = ok(ledger(h, h, 'deploy', '--help'));
  assert.match(stdout, /^Deploy ledger\./);
  assert.doesNotMatch(stdout, /Usage: ledger deploy/);
});

test('an unknown command or option exits non-zero and names it', (t) => {
  const h = home(t);
  const command = ledger(h, h, 'nope');
  assert.notEqual(command.status, 0);
  assert.match(command.stderr, /nope/);
  const option = ledger(h, h, 'list', '--nope');
  assert.notEqual(option.status, 0);
  assert.match(option.stderr, /--nope/);
});

test('ledger list shows the live tasks of every repo with their status, and no retired task', (t) => {
  const { h, app } = world(t);
  const stdout = ok(ledger(h, app, 'list'));
  assert.match(lineWith(stdout, 'parked-child'), /\bapp\b.*\bparked\b/);
  assert.match(lineWith(stdout, 'live-child'), /\bactive\b.*\bepic\b/);
  assert.match(lineWith(stdout, 'lib-part'), /\blib\b.*\bactive\b/);
  assert.match(lineWith(stdout, ' idea'), /\bbacklog\b/);
  assert.match(lineWith(stdout, 'epic '), /\bactive\b/);
  assert.doesNotMatch(stdout, /old-[abcd]|lib-old/);
});

test('ledger list --json gives one object per live task, newest first', (t) => {
  const { h, app, lib, files } = world(t);
  const tasks = listJson(h, app);
  assert.deepEqual(tasks.map(({ slug }) => slug), ['epic', 'live-child', 'parked-child', 'idea', 'lib-part']);
  const bySlug = new Map(tasks.map((task) => [task.slug, task]));
  assert.deepEqual(
    tasks.map(({ slug, status }) => [slug, status]),
    [['epic', 'active'], ['live-child', 'active'], ['parked-child', 'parked'], ['idea', 'backlog'], ['lib-part', 'active']],
  );
  assert.equal(bySlug.get('live-child')?.path, files.live);
  assert.equal(bySlug.get('live-child')?.branch, 'me/live-child');
  assert.deepEqual(bySlug.get('live-child')?.parent, { slug: 'epic', main: app });
  assert.deepEqual(bySlug.get('lib-part')?.parent, { slug: 'epic', main: app });
  assert.equal(bySlug.get('lib-part')?.main, lib);
  assert.equal(bySlug.get('lib-part')?.repo, 'lib');
  assert.equal(bySlug.get('idea')?.main, app);
  assert.equal(bySlug.get('parked-child')?.next, 'Then implement.');
  assert.equal(bySlug.get('epic')?.goal, 'Rewrite the ledger core.');
});

test('ledger list puts each child task under its parent, marked ↳ and indented per level, a backlog parent too; active children first', (t) => {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  const plan = backlogTask(h, app, { slug: 'plan', children: ['- step-a', '- step-b'] });
  const stepA = backlogTask(h, app, { slug: 'step-a', parent: 'plan' });
  const stepB = worktreeTask(h, app, { slug: 'step-b', parent: 'plan', children: ['- deep'] });
  const deep = backlogTask(h, app, { slug: 'deep', parent: 'step-b' });
  const solo = worktreeTask(h, app, { slug: 'solo' });
  touch(deep, '2026-11-17T10:00:00Z');
  touch(stepA, '2026-11-16T10:00:00Z');
  touch(solo, '2026-11-15T10:00:00Z');
  touch(stepB, '2026-11-14T10:00:00Z');
  touch(plan, '2026-11-10T10:00:00Z');

  const rows = ok(ledger(h, app, 'list')).trimEnd().split('\n').slice(3);
  const names = rows.map((row) => /^app\s+(?:\s*↳ )?(\S+)/.exec(row)?.[1]);
  assert.deepEqual(names, ['solo', 'plan', 'step-b', 'deep', 'step-a'], rows.join('\n'));
  const arrow = (slug: string): number => lineWith(rows.join('\n'), `↳ ${slug}`).indexOf('↳');
  assert.equal(lineWith(rows.join('\n'), ' plan ').includes('↳'), false);
  assert.ok(arrow('deep') > arrow('step-b'), rows.join('\n'));
  assert.equal(arrow('step-a'), arrow('step-b'));
});

test('without ~/.claude/ledgers.json, list finds the repos under ~/repos from any folder and rebuilds the registry', (t) => {
  const { h, app, files } = world(t);
  assert.equal(existsSync(registryFile(h)), false);
  assert.deepEqual(listJson(h, h).map(({ slug }) => slug), ['epic', 'live-child', 'parked-child', 'idea', 'lib-part']);
  const entries = readRegistry(h);
  const live = entries.find(({ slug }) => slug === 'live-child');
  assert.deepEqual(Object.keys(live ?? {}).sort(), ['branch', 'created', 'main', 'parent', 'path', 'repo', 'slug', 'status', 'updated']);
  assert.equal(live?.path, files.live);
  assert.equal(live?.status, 'active');
  assert.equal(live?.main, app);
  assert.equal(live?.parent, 'epic');
  assert.equal(entries.find(({ slug }) => slug === 'parked-child')?.status, 'active', 'the registry keeps the old statuses; parked is computed on read');
  assert.equal(entries.find(({ slug }) => slug === 'idea')?.status, 'backlog');
  const oldD = entries.find(({ slug }) => slug === 'old-d');
  assert.equal(oldD?.status, 'archived');
  assert.equal(oldD?.archivePath, path.join(h, '.claude/ledger-archive/app/2026-10-21-feature-old-d.md'));
  const libPart = entries.find(({ slug }) => slug === 'lib-part');
  assert.equal(libPart?.parentMain, app);
  const updated = entries.map((entry) => entry.updated);
  assert.deepEqual(updated, [...updated].sort().reverse(), 'newest first');
});

test('a stale registry is rebuilt from disk: a gone ledger is dropped, a new one added, a known repo outside ~/repos kept', (t) => {
  const { h, app } = world(t);
  const elsewhere = repository(h, path.join(h, 'work/tool'));
  const toolTask = worktreeTask(h, elsewhere, { slug: 'tool-task' });
  const created = '2020-01-01T00:00:00.000Z';
  const stale: RegistryEntry[] = [
    { repo: 'tool', slug: 'tool-task', path: toolTask, branch: 'me/tool-task', status: 'active', main: elsewhere, created, updated: created },
    { repo: 'app', slug: 'gone', path: path.join(app, '.claude/worktrees/gone/.claude/ledger.md'), branch: 'me/gone', status: 'active', main: app, created, updated: created },
  ];
  writeFileSync(registryFile(h), `${JSON.stringify(stale, null, 2)}\n`);
  const slugs = listJson(h, h).map(({ slug }) => slug);
  assert.ok(slugs.includes('tool-task'), 'a repo the registry names is still read');
  assert.ok(slugs.includes('idea'), 'a backlog task missing from the registry is listed');
  assert.ok(!slugs.includes('gone'), 'disk wins');
  const entries = readRegistry(h);
  assert.equal(entries.find(({ slug }) => slug === 'gone'), undefined);
  assert.equal(entries.find(({ slug }) => slug === 'tool-task')?.created, created, 'a kept entry keeps its created time');
  assert.ok(entries.some(({ slug }) => slug === 'old-a'));
});

test('registry entries of a repo git cannot read are kept; a gone ledger in a readable repo is dropped', (t) => {
  const { h, app } = world(t);
  const plain = path.join(h, 'plain');
  const plainLedger = path.join(plain, '.claude/worktrees/kept/.claude/ledger.md');
  mkdirSync(path.dirname(plainLedger), { recursive: true });
  writeFileSync(plainLedger, '# Task ledger — kept\n');
  const created = '2020-01-01T00:00:00.000Z';
  const unreadable: RegistryEntry[] = [
    { repo: 'gone', slug: 'on-a-disk', path: path.join(h, 'gone/.claude/worktrees/on-a-disk/.claude/ledger.md'), branch: 'me/on-a-disk', status: 'active', main: path.join(h, 'gone'), created, updated: created },
    { repo: 'plain', slug: 'kept', path: plainLedger, branch: 'me/kept', status: 'active', main: plain, created, updated: created },
    { repo: 'no-main', slug: 'old', path: path.join(h, 'unmounted/.claude/worktrees/old/.claude/ledger.md'), branch: 'me/old', status: 'active', created, updated: created },
  ];
  const dropped: RegistryEntry = { repo: 'app', slug: 'gone', path: path.join(app, '.claude/worktrees/gone/.claude/ledger.md'), branch: 'me/gone', status: 'active', main: app, created, updated: created };
  writeFileSync(registryFile(h), `${JSON.stringify([...unreadable, dropped], null, 2)}\n`);
  ok(ledger(h, app, 'list'));
  const entries = readRegistry(h);
  for (const entry of unreadable) assert.deepEqual(entries.find(({ slug }) => slug === entry.slug), entry);
  assert.equal(entries.find(({ slug }) => slug === 'gone'), undefined);
  assert.ok(entries.some(({ slug }) => slug === 'epic'));
});

/** A ledger at <folder>/.claude/ledger.md in a folder that is not a git repository. */
function plainFolderTask(folder: string, slug: string, next?: string): string {
  const file = path.join(folder, '.claude/ledger.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, ledgerText({ slug, next }));
  return file;
}

test('a ledger in a folder that is not a git repository stays in the list, once in the registry', (t) => {
  const { h, app } = world(t);
  const folder = path.join(h, 'work/disk-watcher');
  const file = plainFolderTask(folder, 'disk-growth-scan');
  const created = '2020-01-01T00:00:00.000Z';
  const stored: RegistryEntry = { repo: 'disk-watcher', slug: 'disk-growth-scan', path: file, branch: '', status: 'active', created, updated: created };
  writeFileSync(registryFile(h), `${JSON.stringify([stored], null, 2)}\n`);
  const listed = listJson(h, app).find(({ slug }) => slug === 'disk-growth-scan');
  assert.deepEqual(listed && [listed.repo, listed.status, listed.path], ['disk-watcher', 'active', file]);
  assert.match(lineWith(ok(ledger(h, app, 'list')), 'disk-growth-scan'), /^disk-watcher\s+disk-growth-scan\s+active\b/);
  assert.equal(readRegistry(h).filter(({ path: entry }) => entry === file).length, 1);
});

test('without a registry, the scan finds a ledger in a folder under ~/repos that is not a git repository', (t) => {
  const { h } = world(t);
  const file = plainFolderTask(path.join(h, 'repos/disk-watcher'), 'disk-growth-scan', 'Parked: 2026-11-10 — waiting\nScan again.');
  const listed = listJson(h, h).find(({ slug }) => slug === 'disk-growth-scan');
  assert.deepEqual(listed && [listed.repo, listed.status, listed.path, listed.next], ['disk-watcher', 'parked', file, 'Scan again.']);
});

test('an unreadable registry is rebuilt from disk', (t) => {
  const { h, app } = world(t);
  writeFileSync(registryFile(h), '{ not json');
  assert.equal(listJson(h, app).length, 5);
  assert.ok(Array.isArray(readRegistry(h)));
  assert.ok(readRegistry(h).some(({ slug }) => slug === 'epic'));
});

test('an up-to-date registry is left as it is', (t) => {
  const { h, app } = world(t);
  ok(ledger(h, app, 'list'));
  const before = readFileSync(registryFile(h), 'utf8');
  const old = new Date('2020-01-01T00:00:00Z');
  touch(registryFile(h), old.toISOString());
  ok(ledger(h, app, 'list'));
  assert.equal(readFileSync(registryFile(h), 'utf8'), before);
  assert.equal(statSync(registryFile(h)).mtimeMs, old.getTime());
});

test("ledger archive lists this repo's archived ledgers newest first, named by their title slug", (t) => {
  const { h, app } = world(t);
  const stdout = ok(ledger(h, app, 'archive'));
  assert.match(stdout, /Archived ledgers.*\bapp\b.*4 ledgers/);
  const order = ['old-b', 'old-c', 'old-d', 'old-a'].map((slug) => stdout.indexOf(` ${slug} `));
  assert.ok(order.every((index) => index > 0), stdout);
  assert.equal(order.indexOf(Math.max(...order)), 3, 'old-a is oldest, so last');
  assert.match(lineWith(stdout, 'old-d'), /^2026-10-21\s+old-d\s+me\/feature-old-d/);
  assert.doesNotMatch(stdout, /lib-old/);
});

test('ledger archive <term> keeps the ledgers that contain it, in any case, and shows the matching line', (t) => {
  const { h, app } = world(t);
  const stdout = ok(ledger(h, app, 'archive', 'pr #27'));
  assert.match(stdout, /1 ledger that contains "pr #27"/);
  assert.match(lineWith(stdout, 'old-d'), /Merged in PR #27\./);
  assert.doesNotMatch(stdout, /old-[abc]/);
});

test('ledger archive --all lists every repo and names the repo of each ledger', (t) => {
  const { h } = world(t);
  const stdout = ok(ledger(h, h, 'archive', '--all'));
  assert.match(stdout, /every repo.*5 ledgers/);
  assert.match(lineWith(stdout, 'lib-old'), /^2026-09-01\s+lib\s+lib-old\b/);
  assert.match(lineWith(stdout, 'old-a'), /\bapp\s+old-a\b/);
});

test('ledger archive says so when nothing is archived or nothing matches', (t) => {
  const { h, app } = world(t);
  assert.equal(ok(ledger(h, app, 'archive', 'zzz')).trim(), 'No archived ledger in ~/.claude/ledger-archive/app/ contains "zzz".');
  const empty = repository(h, path.join(h, 'repos/empty'));
  assert.equal(ok(ledger(h, empty, 'archive')).trim(), 'No archived ledgers in ~/.claude/ledger-archive/empty/.');
});

test('ledger archive --all says so when nothing is archived in any repo', (t) => {
  const h = home(t);
  assert.equal(ok(ledger(h, h, 'archive', '--all')).trim(), 'No archived ledgers in ~/.claude/ledger-archive/.');
});

test('ledger archive outside a git repository fails and suggests --all', (t) => {
  const { h } = world(t);
  const ran = ledger(h, h, 'archive');
  assert.equal(ran.status, 1);
  assert.match(ran.stderr, /--all/);
  assert.equal(ran.stdout, '');
});

test('ledger parent --json takes each child status from disk: archive, then worktree, then backlog', (t) => {
  const { h, app, lib } = world(t);
  const shown: Shown = JSON.parse(ok(ledger(h, app, 'parent', 'epic', '--json')));
  assert.equal(shown.slug, 'epic');
  assert.equal(shown.main, app);
  assert.equal(shown.goal, 'Rewrite the ledger core.');
  const statuses = Object.fromEntries(shown.children.map(({ slug, status }) => [slug, status]));
  assert.deepEqual(statuses, {
    'live-child': 'active',
    'parked-child': 'parked',
    idea: 'backlog',
    'old-a': 'retired',
    'old-b': 'retired',
    'old-c': 'retired',
    'old-d': 'retired',
    ghost: 'missing',
    'lib-part': 'active',
  });
  assert.deepEqual(shown.children.slice(0, 2).map(({ slug }) => slug).sort(), ['lib-part', 'live-child'], 'active children first');
  const child = (slug: string): ShownChild => shown.children.find((entry) => entry.slug === slug) ?? assert.fail(`no child ${slug}`);
  assert.equal(child('lib-part').main, lib);
  assert.equal(child('ghost').main, app);
  assert.equal(child('live-child').next, 'Next step of live-child.');
  assert.deepEqual(child('live-child').report, ['PR #31 is open.']);
  assert.equal(child('parked-child').next, 'Then implement.');
  assert.deepEqual(child('old-d').report, ['Merged in PR #27.'], 'an archived child reports from its archive copy');
});

test('ledger parent shows the parent, its goal, and a row per child with status and next step', (t) => {
  const { h, app, lib } = world(t);
  const stdout = ok(ledger(h, app, 'parent', 'epic'));
  assert.match(stdout, /^Parent task epic · 9 children, 2 active$/m);
  assert.match(stdout, /^Rewrite the ledger core\.$/m);
  assert.match(lineWith(stdout, 'live-child'), /live-child\s+active\s+Next step of live-child\./);
  assert.match(lineWith(stdout, 'PR #31'), /^\s+PR #31 is open\.$/);
  assert.match(lineWith(stdout, `lib-part@${lib}`), /\bactive\b/);
  assert.match(lineWith(stdout, 'old-c'), /old-c\s+retired/);
  assert.match(lineWith(stdout, 'ghost'), /ghost\s+missing/);
});

test('a child with a live ledger and an archive copy has the live status in both parent and list: the live ledger wins', (t) => {
  const { h, app } = world(t);
  worktreeTask(h, app, { slug: 'old-a', parent: 'epic' });
  const shown: Shown = JSON.parse(ok(ledger(h, app, 'parent', 'epic', '--json')));
  assert.equal(shown.children.find(({ slug }) => slug === 'old-a')?.status, 'active');
  assert.equal(listJson(h, app).find(({ slug }) => slug === 'old-a')?.status, 'active');
});

test('a Children bullet is a child only when it names a known task or has the <slug>@<path> form', (t) => {
  const { h, app, lib } = world(t);
  archivedTask(h, app, '2026-10-02', { slug: 'old-free' });
  worktreeTask(h, app, {
    slug: 'prose',
    children: ['- Superseded by the new plan.', '- RN-side work is tracked in the RN repo.', '- nobody', '- old-free', '- live-child', `- elsewhere @ ${lib}`],
  });
  const shown: Shown = JSON.parse(ok(ledger(h, app, 'parent', 'prose', '--json')));
  assert.deepEqual(
    Object.fromEntries(shown.children.map(({ slug, status }) => [slug, status])),
    { 'old-free': 'retired', 'live-child': 'active', elsewhere: 'missing' },
  );
  const text = ok(ledger(h, app, 'parent', 'prose'));
  assert.match(text, /^Parent task prose · 3 children, 1 active$/m);
  assert.doesNotMatch(text, /Superseded|RN-side|nobody/);
});

test('an archive row keeps the branch line as written, a placeholder included, as the old reader showed it', (t) => {
  const { h, app } = world(t);
  archivedTask(h, app, '2026-10-01', { slug: 'unstarted', branch: '<name>', worktree: '<path>' });
  assert.match(lineWith(ok(ledger(h, app, 'archive')), 'unstarted'), /^2026-10-01\s+unstarted\s+<name>\s+Goal of unstarted\./);
});

test('an archive copy of a same-named repo elsewhere does not retire a child', (t) => {
  const { h, app } = world(t);
  archivedTask(h, path.join(h, 'other/app'), '2026-11-01', { slug: 'ghost', parent: 'epic' });
  const shown: Shown = JSON.parse(ok(ledger(h, app, 'parent', 'epic', '--json')));
  assert.equal(shown.children.find(({ slug }) => slug === 'ghost')?.status, 'missing');
});

test('a child with no ledger anywhere is missing, even when the parent marks it retired', (t) => {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  worktreeTask(h, app, { slug: 'epic', children: [`- lost @ ${app} (retired 2026-10-01)`] });
  const shown: Shown = JSON.parse(ok(ledger(h, app, 'parent', 'epic', '--json')));
  assert.deepEqual(shown.children.map(({ slug, status }) => [slug, status]), [['lost', 'missing']]);
  assert.match(lineWith(ok(ledger(h, app, 'parent', 'epic')), 'lost'), /^lost +missing\b/);
});

test('a worktree whose .claude/ledger.md is a symbolic link to a file is a task: list, parent and retire find it', (t) => {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  const file = worktreeTask(h, app, { slug: 'epic', children: ['- part'] });
  backlogTask(h, app, { slug: 'part', parent: 'epic' });
  const target = path.join(h, 'elsewhere/epic-ledger.md');
  mkdirSync(path.dirname(target), { recursive: true });
  renameSync(file, target);
  symlinkSync(target, file);
  assert.deepEqual(listJson(h, app).filter(({ slug }) => slug === 'epic').map(({ path: listed }) => listed), [file]);
  const shown: Shown = JSON.parse(ok(ledger(h, app, 'parent', 'epic', '--json')));
  assert.deepEqual(shown.children.map(({ slug, status }) => [slug, status]), [['part', 'backlog']]);
  assert.match(ok(ledger(h, app, 'retire', 'epic', '--dry-run')), /^Retire epic · dry run/m);
});

test('a reused slug: an archive copy of another parent does not retire a live child', (t) => {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  worktreeTask(h, app, { slug: 'epic', children: ['- fix-ci'] });
  backlogTask(h, app, { slug: 'fix-ci', parent: 'epic' });
  archivedTask(h, app, '2026-10-01', { slug: 'fix-ci', parent: 'other-epic' });
  const shown: Shown = JSON.parse(ok(ledger(h, app, 'parent', 'epic', '--json')));
  assert.deepEqual(shown.children.map(({ slug, status }) => [slug, status]), [['fix-ci', 'backlog']]);
});

test('an archive copy with no parent line counts only when no live ledger has the slug', (t) => {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  worktreeTask(h, app, { slug: 'epic', children: ['- old-x', '- both'] });
  archivedTask(h, app, '2026-10-01', { slug: 'old-x' });
  archivedTask(h, app, '2026-10-01', { slug: 'both' });
  worktreeTask(h, app, { slug: 'both' });
  const shown: Shown = JSON.parse(ok(ledger(h, app, 'parent', 'epic', '--json')));
  const statuses = Object.fromEntries(shown.children.map(({ slug, status }) => [slug, status]));
  assert.deepEqual(statuses, { 'old-x': 'retired', both: 'active' });
});

test('ledger parent <slug>@<path> shows a parent in another repo', (t) => {
  const { h, app, lib } = world(t);
  const shown: Shown = JSON.parse(ok(ledger(h, lib, 'parent', `epic@${app}`, '--json')));
  assert.equal(shown.main, app);
  assert.equal(shown.children.length, 9);
  const text = ok(ledger(h, lib, 'parent', `epic@${path.join(app, '.claude/worktrees/live-child')}`));
  assert.match(text, /^Parent task epic\b/m, 'any folder of the repo names it');
});

test('ledger parent of a slug that is not in this repo fails and names it', (t) => {
  const { h, lib } = world(t);
  const ran = ledger(h, lib, 'parent', 'epic');
  assert.equal(ran.status, 1);
  assert.match(ran.stderr, /epic/);
  assert.match(ran.stderr, new RegExp(lib.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('ledger parent of a task with no children says so', (t) => {
  const { h, app } = world(t);
  assert.equal(ok(ledger(h, app, 'parent', 'live-child')).trim(), 'live-child has no child tasks.');
});

test('ledger parent outside a git repository asks for <slug>@<path>', (t) => {
  const { h } = world(t);
  mkdirSync(path.join(h, 'plain'));
  const ran = ledger(h, path.join(h, 'plain'), 'parent', 'epic');
  assert.equal(ran.status, 1);
  assert.match(ran.stderr, /epic@<path>/);
});

test('ledger parent refuses a slug the reading rule does not accept', (t) => {
  const { h, app } = world(t);
  const ran = ledger(h, app, 'parent', 'a b');
  assert.equal(ran.status, 1);
  assert.match(ran.stderr, /slug/);
});
