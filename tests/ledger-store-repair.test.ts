import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setLocationBullet, setLostMark } from '../tools/ledger/edit.js';
import { fileStore } from '../tools/ledger/file-store.js';
import { parseLedger } from '../tools/ledger/format.js';
import { namedMain } from '../tools/ledger/migrate-repo-ids.js';
import { openStore } from '../tools/ledger/open-store.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { parseRecord, renderRecord } from '../tools/ledger/record.js';
import { sqliteFile } from '../tools/ledger/sqlite-store.js';
import type { LedgerStore } from '../tools/ledger/store.js';
import { REPO } from './helpers.js';
import { archivedTask, git, home, ledger, ledgerText, noSqlite, ok, repoKeyOf, repository, type Ran } from './ledger-core-fixtures.js';
import { APP_KEY, machine, remote, run, setUp, today } from './ledger-git-fixtures.js';

type Storage = 'file' | 'sqlite';

/** A HOME with the ledger template and the repo ~/repos/app, whose untracked .claude/ folder git ignores. */
function setup(t: TestContext, storage: Storage = 'file') {
  const h = home(t);
  copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
  if (storage === 'sqlite') writeFileSync(path.join(h, '.claude/ledger-settings.json'), JSON.stringify({ storage: 'sqlite' }));
  const app = repository(h, path.join(h, 'repos', 'app'));
  writeFileSync(path.join(app, '.git/info/exclude'), '.claude/\n');
  return { h, app, key: repoKeyOf(app) };
}

type Run = (cwd: string, ...args: string[]) => Ran;

/** Starts `slug` with ledger task new and ledger go; gives its worktree and branch. */
function start(repair: Run, app: string, slug: string): { worktree: string; branch: string } {
  ok(repair(app, 'task', 'new', slug, '--goal', `Goal of ${slug}.`));
  ok(repair(app, 'go', slug));
  const worktree = path.join(app, '.claude/worktrees', slug);
  return { worktree, branch: git(path.dirname(app), worktree, 'branch', '--show-current') };
}

type Listed = { slug: string; status: string; worktree?: string; elsewhere?: boolean; lost?: { date: string } };

const listed = (repair: Run, cwd: string): Listed[] => (JSON.parse(ok(repair(cwd, 'list', '--json'))) as { tasks: Listed[] }).tasks;

const taskIn = (repair: Run, cwd: string, slug: string): Listed => listed(repair, cwd).find((task) => task.slug === slug) ?? assert.fail(`ledger list has no ${slug}`);

const shown = (repair: Run, cwd: string, slug: string): string => ok(repair(cwd, 'show', slug));

function fails(ran: Ran, text: string | RegExp): string {
  assert.notEqual(ran.status, 0, `a failure expected; stdout:\n${ran.stdout}`);
  if (typeof text === 'string') assert.ok(ran.stderr.includes(text), `stderr lacks "${text}":\n${ran.stderr}`);
  else assert.match(ran.stderr, text);
  return ran.stderr;
}

const worktreeList = (h: string, app: string): string => git(h, app, 'worktree', 'list', '--porcelain');

/** A new git repository at `folder`, of no remote, whose current branch is `branch`: a checkout of another repo. */
function checkoutAt(h: string, folder: string, branch: string): string {
  mkdirSync(folder, { recursive: true });
  git(h, folder, 'init', '--quiet', '-b', branch);
  return folder;
}

/** A linked worktree of the repo at `main` at `folder` on `branch`, even while another worktree has it checked out. */
function worktreeAt(h: string, main: string, folder: string, branch: string): string {
  mkdirSync(path.dirname(folder), { recursive: true });
  git(h, main, 'worktree', 'add', '--quiet', '-f', folder, branch);
  return folder;
}

/** A second main checkout of the repo at `main`, cloned from its origin, with `branch` checked out. */
function cloneOn(h: string, main: string, folder: string, branch: string): string {
  git(h, h, 'clone', '--quiet', git(h, main, 'remote', 'get-url', 'origin'), folder);
  git(h, folder, 'checkout', '--quiet', '-b', branch);
  return folder;
}

const forStorage = (h: string): Run => (cwd, ...args) => ledger(h, cwd, ...args);

test('store repair without a task reports no problems when every recorded folder is there', (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  start(repair, app, 'fix-login');
  const stdout = ok(repair(app, 'store', 'repair'));
  assert.match(stdout, /No problems found\./);
});

test('store repair reports an active task whose folder is gone, with its repo, folder and branch, and the commands that fix it', (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = start(repair, app, 'fix-login');
  const parked = start(repair, app, 'on-hold');
  ok(repair(parked.worktree, 'task', 'park', 'on-hold', '--reason', 'waiting'));
  rmSync(worktree, { recursive: true, force: true });
  rmSync(parked.worktree, { recursive: true, force: true });

  const ran = repair(app, 'store', 'repair');
  assert.equal(ran.status, 1, ran.stderr);
  const line = ran.stdout.split('\n').find((each) => each.includes('fix-login') && each.includes(worktree)) ?? assert.fail(`no line names fix-login and its folder:\n${ran.stdout}`);
  assert.ok(line.includes('app'), line);
  assert.ok(line.includes(branch), line);
  assert.ok(!ran.stdout.includes('on-hold'), `a parked task is not reported:\n${ran.stdout}`);
  assert.match(ran.stdout, /ledger store repair fix-login\S* --to <folder>/);
  assert.match(ran.stdout, /ledger store repair fix-login\S* --lost/);
  assert.doesNotMatch(ran.stdout, /No problems found/);
});

test('store repair reports a repo key whose main checkout has another key now, and the --remote command for it', (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  start(repair, app, 'fix-login');
  ok(repair(app, 'task', 'new', 'idea', '--goal', 'Later.'));
  const renamed = path.join(h, 'remotes', 'app-renamed.git');
  git(h, h, 'init', '--quiet', '--bare', '-b', 'main', renamed);
  git(h, app, 'remote', 'set-url', 'origin', renamed);
  const newKey = repoKeyOf(app);
  assert.notEqual(newKey, key);

  const ran = repair(app, 'store', 'repair');
  assert.equal(ran.status, 1, ran.stderr);
  assert.ok(ran.stdout.includes(`${key} → ${newKey}`), ran.stdout);
  assert.ok(ran.stdout.includes(`ledger store repair --remote ${key}`), ran.stdout);
  assert.ok(!ran.stdout.includes('fix-login'), `its folder is there, so the task is not missing:\n${ran.stdout}`);
});

test('store repair --search lists the linked worktrees of the task repo on its branch in the named folders, 6 levels deep, and changes nothing', (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = start(repair, app, 'fix-login');
  const moved = path.join(h, 'moved');
  const found = path.join(moved, 'a', 'b', 'fix-login');
  mkdirSync(path.dirname(found), { recursive: true });
  renameSync(worktree, found);
  const deepest = worktreeAt(h, app, path.join(moved, '1', '2', '3', '4', '5', 'six'), branch);
  worktreeAt(h, app, path.join(moved, '1', '2', '3', '4', '5', '6', 'seven'), branch);
  worktreeAt(h, app, path.join(moved, 'node_modules', 'pkg'), branch);
  worktreeAt(h, app, path.join(moved, 'r', '.claude', 'worktrees', '.build', 'x'), branch);
  worktreeAt(h, app, path.join(moved, 'other'), 'main');
  cloneOn(h, app, path.join(moved, 'a-clone'), branch);
  checkoutAt(h, path.join(moved, 'stranger'), branch);
  symlinkSync(path.join(moved, 'a'), path.join(moved, 'link'));
  const before = fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text;

  const ran = repair(app, 'store', 'repair', '--search', moved);
  assert.equal(ran.status, 1, ran.stderr);
  const candidates = ran.stdout.split('\n').filter((line) => line.includes(moved)).map((line) => line.trim());
  assert.ok(candidates.some((line) => line.includes(found)), ran.stdout);
  assert.ok(candidates.some((line) => line.includes(deepest)), `a checkout 6 levels down is searched:\n${ran.stdout}`);
  for (const skipped of ['seven', 'node_modules', '.build', 'other', 'link', 'a-clone', 'stranger']) assert.ok(!ran.stdout.includes(path.sep + skipped), `${skipped} is not a candidate:\n${ran.stdout}`);
  assert.equal(fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text, before);
  assert.ok(!worktreeList(h, app).includes(found), 'a search runs no git worktree repair');
});

for (const storage of ['file', 'sqlite'] as const) {
  test(`${storage} store: store repair --search passes by a checkout two active records name, and still reports every other task`, { skip: storage === 'sqlite' && noSqlite }, (t) => {
    const { h, app, key } = setup(t, storage);
    const repair = forStorage(h);
    const moved = path.join(h, 'moved');
    mkdirSync(moved);
    const fixLogin = start(repair, app, 'fix-login');
    const claimed = path.join(moved, 'claimed');
    renameSync(fixLogin.worktree, claimed);
    const store = openStore(ledgerPaths(h), storage);
    for (const slug of ['holder-a', 'holder-b']) {
      start(repair, app, slug);
      store.active.update(key, slug, (text) => setLocationBullet(text, 'worktree', claimed) ?? text);
    }
    const otherTask = start(repair, app, 'other-task');
    const unowned = path.join(moved, 'unowned');
    renameSync(otherTask.worktree, unowned);

    const ran = repair(app, 'store', 'repair', '--search', moved);
    assert.equal(ran.status, 1, ran.stderr);
    assert.ok(!ran.stdout.includes(`found ${claimed}`), ran.stdout);
    assert.ok(ran.stdout.includes(`found ${unowned}`), ran.stdout);
    assert.ok(ran.stdout.includes(`--to ${unowned}`), ran.stdout);
  });
}

test('store repair --search fails on a folder that does not exist', (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const gone = path.join(h, 'no-such-folder');
  fails(repair(app, 'store', 'repair', '--search', gone), gone);
});

test('store repair <slug> --to points the task at the folder it moved to, and repairs the git worktree link', (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree } = start(repair, app, 'fix-login');
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(worktree, moved);

  const stdout = ok(repair(app, 'store', 'repair', 'fix-login', '--to', moved));
  assert.ok(stdout.includes(moved) && stdout.includes(worktree), stdout);
  assert.equal(taskIn(repair, app, 'fix-login').worktree, moved);
  assert.ok(worktreeList(h, app).includes(`worktree ${moved}`), worktreeList(h, app));
  assert.match(ok(repair(app, 'store', 'repair')), /No problems found\./);
  const session = JSON.parse(ok(repair(moved, 'session', '--json'))) as { ledgers: { slug: string }[] };
  assert.deepEqual(
    session.ledgers.map(({ slug }) => slug),
    ['fix-login'],
  );
});

test('store repair <slug>@<path> --to names the task of the repo at <path> from outside it', (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree } = start(repair, app, 'fix-login');
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(worktree, moved);
  ok(repair(h, 'store', 'repair', `fix-login@${app}`, '--to', moved));
  assert.equal(taskIn(repair, app, 'fix-login').worktree, moved);
});

test('store repair <slug> --to records the new main checkout when the repo moved', (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  start(repair, app, 'fix-login');
  const app2 = path.join(h, 'repos', 'app2');
  renameSync(app, app2);
  const worktree = path.join(app2, '.claude/worktrees/fix-login');
  git(h, app2, 'worktree', 'repair', worktree);
  const stdout = ok(repair(app2, 'store', 'repair', 'fix-login', '--to', worktree));
  assert.ok(stdout.includes(app2), stdout);
  assert.match(shown(repair, app2, 'fix-login'), new RegExp(`^- main: ${app2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.equal(taskIn(repair, app2, 'fix-login').worktree, worktree);
});

test('store repair <slug> --to --dry-run prints the change and writes nothing', (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree } = start(repair, app, 'fix-login');
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(worktree, moved);
  const before = fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text;

  const stdout = ok(repair(app, 'store', 'repair', 'fix-login', '--to', moved, '--dry-run'));
  assert.match(stdout, /[Ww]ould/);
  assert.ok(stdout.includes(moved), stdout);
  assert.equal(fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text, before);
  assert.ok(!worktreeList(h, app).includes(moved), 'a dry run runs no git worktree repair');
});

test('store repair <slug> --to refuses, writing nothing, a task that is not active, a missing folder, no checkout, a taken folder and another branch', (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree } = start(repair, app, 'fix-login');
  const other = start(repair, app, 'other-task');
  ok(repair(app, 'task', 'new', 'idea', '--goal', 'Later.'));
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(worktree, moved);
  const plain = path.join(h, 'plain');
  mkdirSync(plain);
  const elsewhere = path.join(h, 'elsewhere');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'unrelated', elsewhere, 'main');
  const before = fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text;
  const list = worktreeList(h, app);

  fails(repair(app, 'store', 'repair', 'idea', '--to', moved), /idea.*not an active task|no active task.*idea/i);
  fails(repair(app, 'store', 'repair', 'fix-login', '--to', path.join(h, 'nowhere')), /does not exist/);
  fails(repair(app, 'store', 'repair', 'fix-login', '--to', plain), /not a git checkout/);
  fails(repair(app, 'store', 'repair', 'fix-login', '--to', other.worktree), /other-task/);
  fails(repair(app, 'store', 'repair', 'fix-login', '--to', elsewhere), /branch/);
  assert.equal(fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text, before);
  assert.equal(worktreeList(h, app), list);
});

test('store repair <slug> --to refuses, with one line, a main checkout and a checkout of another repo on the task branch', (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  const clone = cloneOn(h, app, path.join(h, 'app-clone'), branch);
  const lib = repository(h, path.join(h, 'repos', 'lib'));
  const stranger = worktreeAt(h, lib, path.join(h, 'lib-worktree'), 'main');
  git(h, stranger, 'checkout', '--quiet', '-b', branch);
  const before = fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text;

  const main = fails(repair(app, 'store', 'repair', 'fix-login', '--to', clone), /main checkout/);
  const other = fails(repair(app, 'store', 'repair', 'fix-login', '--to', stranger), new RegExp(repoKeyOf(lib).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const message of [main, other]) assert.equal(message.trim().split('\n').length, 1, message);
  assert.equal(fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text, before);
});

test('store repair <slug> --to takes a checkout whose repo key is an alias of the task key', (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  const oldClone = path.join(h, 'repos', 'app-old');
  git(h, h, 'clone', '--quiet', git(h, app, 'remote', 'get-url', 'origin'), oldClone);
  const oldUrl = path.join(h, 'remotes', 'app-old-name.git');
  git(h, h, 'init', '--quiet', '--bare', '-b', 'main', oldUrl);
  git(h, oldClone, 'remote', 'set-url', 'origin', oldUrl);
  const oldKey = repoKeyOf(oldClone);
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  git(h, oldClone, 'worktree', 'add', '--quiet', '-b', branch, moved, 'HEAD');

  fails(repair(app, 'store', 'repair', 'fix-login', '--to', moved), oldKey);
  assert.match(repair(app, 'store', 'repair', '--search', path.dirname(moved)).stdout, /no checkout on/);
  fileStore(ledgerPaths(h)).aliases.add(oldKey, key);
  assert.match(repair(app, 'store', 'repair', '--search', path.dirname(moved)).stdout, new RegExp(`found ${moved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  ok(repair(app, 'store', 'repair', 'fix-login', '--to', moved));
  assert.equal(taskIn(repair, app, 'fix-login').worktree, moved);
});

test('store repair <slug> --lost marks the task lost: ledger list shows it, the report and session start pass it by', (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree } = start(repair, app, 'fix-login');
  start(repair, app, 'still-here');
  rmSync(worktree, { recursive: true, force: true });

  ok(repair(app, 'store', 'repair', 'fix-login', '--lost'));
  assert.ok(shown(repair, app, 'fix-login').includes(`lost: ${today()} — folder ${worktree} not found`), shown(repair, app, 'fix-login'));
  const task = taskIn(repair, app, 'fix-login');
  assert.equal(task.status, 'lost');
  assert.deepEqual(task.lost, { date: today() });
  const list = ok(repair(app, 'list'));
  assert.match(list, /1 lost/);
  assert.match(list.split('\n').find((line) => line.includes('fix-login')) ?? '', /\blost\b(?!\*)/);
  assert.match(ok(repair(app, 'store', 'repair')), /No problems found\./);

  git(h, app, 'worktree', 'prune');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'again', worktree, 'main');
  const own = JSON.parse(ok(repair(worktree, 'session', '--json'))) as { ledgers: { slug: string }[] };
  assert.deepEqual(own.ledgers, [], 'a lost task is no folder’s task');
  const main = JSON.parse(ok(repair(app, 'session', '--json'))) as { ledgers: { slug: string }[] };
  assert.deepEqual(
    main.ledgers.map(({ slug }) => slug),
    ['still-here'],
  );
});

test('store repair <slug> --lost refuses a task whose folder is there, and --dry-run writes nothing', (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree } = start(repair, app, 'fix-login');
  const before = fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text;
  fails(repair(app, 'store', 'repair', 'fix-login', '--lost'), worktree);
  rmSync(worktree, { recursive: true, force: true });
  const stdout = ok(repair(app, 'store', 'repair', 'fix-login', '--lost', '--dry-run'));
  assert.match(stdout, /[Ww]ould/);
  assert.equal(fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text, before);
  assert.equal(taskIn(repair, app, 'fix-login').status, 'active');
});

/** A repo whose origin was renamed after it had an active task, a backlog task and an archive copy. */
function renamedRemote(t: TestContext) {
  const world = setup(t);
  const { h, app } = world;
  const repair = forStorage(h);
  start(repair, app, 'fix-login');
  ok(repair(app, 'task', 'new', 'idea', '--goal', 'Later.'));
  archivedTask(h, app, '2026-01-02', { slug: 'done-one' });
  const renamed = path.join(h, 'remotes', 'app-renamed.git');
  git(h, h, 'init', '--quiet', '--bare', '-b', 'main', renamed);
  git(h, app, 'remote', 'set-url', 'origin', renamed);
  return { ...world, repair, newKey: repoKeyOf(app) };
}

const filed = (h: string, key: string) => {
  const store = fileStore(ledgerPaths(h));
  return { active: store.active.list(key).map(({ name }) => name), backlog: store.backlog.list(key).map(({ name }) => name), archive: store.archive.list(key).map(({ name }) => name) };
};

test('store repair --remote files every task of the old key under the current key and keeps the old key as an alias', (t) => {
  const { h, app, key, newKey, repair } = renamedRemote(t);
  ok(repair(app, 'store', 'repair', '--remote', key));
  assert.deepEqual(filed(h, newKey), { active: ['fix-login'], backlog: ['idea'], archive: ['2026-01-02-done-one'] });
  assert.deepEqual(filed(h, key), { active: [], backlog: [], archive: [] });
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get(key), newKey);
  assert.match(ok(repair(app, 'store', 'repair')), /No problems found\./);
});

test('store repair --remote --dry-run prints the moves and writes nothing', (t) => {
  const { h, app, key, newKey, repair } = renamedRemote(t);
  const stdout = ok(repair(app, 'store', 'repair', '--remote', key, '--dry-run'));
  assert.match(stdout, /would/);
  assert.ok(stdout.includes('idea') && stdout.includes('fix-login') && stdout.includes('done-one'), stdout);
  assert.deepEqual(filed(h, key), { active: ['fix-login'], backlog: ['idea'], archive: ['2026-01-02-done-one'] });
  assert.deepEqual(filed(h, newKey), { active: [], backlog: [], archive: [] });
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get(key), undefined);
});

test('store repair --remote leaves a task whose slug the current key has, lists it, and exits 1', (t) => {
  const { h, app, key, newKey, repair } = renamedRemote(t);
  ok(repair(app, 'task', 'new', 'idea', '--goal', 'Again.'));
  const ran = repair(app, 'store', 'repair', '--remote', key);
  assert.equal(ran.status, 1, ran.stderr);
  assert.match(ran.stdout, /idea/);
  assert.deepEqual(filed(h, key), { active: [], backlog: ['idea'], archive: [] });
  assert.deepEqual(filed(h, newKey), { active: ['fix-login'], backlog: ['idea'], archive: ['2026-01-02-done-one'] });
  assert.match(readFileSync(fileStore(ledgerPaths(h)).backlog.read(key, 'idea')?.location ?? assert.fail('the old idea is gone'), 'utf8'), /Later\./);
});

test('store repair --remote re-points each alias of the old key to the current key; --dry-run only shows it', (t) => {
  const { h, app, key, newKey, repair } = renamedRemote(t);
  fileStore(ledgerPaths(h)).aliases.add('app-folder', key);
  const dry = ok(repair(app, 'store', 'repair', '--remote', key, '--dry-run'));
  assert.match(dry, /app-folder/);
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get('app-folder'), key);
  const stdout = ok(repair(app, 'store', 'repair', '--remote', key));
  assert.match(stdout, /app-folder/);
  const aliases = fileStore(ledgerPaths(h)).aliases.read();
  assert.equal(aliases.get('app-folder'), newKey);
  assert.equal(aliases.get(key), newKey);
});

test('store repair --remote re-points no alias while a conflict keeps tasks under the old key', (t) => {
  const { h, app, key, repair } = renamedRemote(t);
  fileStore(ledgerPaths(h)).aliases.add('app-folder', key);
  ok(repair(app, 'task', 'new', 'idea', '--goal', 'Again.'));
  assert.equal(repair(app, 'store', 'repair', '--remote', key).status, 1);
  const aliases = fileStore(ledgerPaths(h)).aliases.read();
  assert.equal(aliases.get('app-folder'), key);
  assert.equal(aliases.get(key), undefined);
});

test('store repair --remote fails for a key that has no task', (t) => {
  const { h, app } = setup(t);
  fails(ledger(h, app, 'store', 'repair', '--remote', 'github.com/nobody/nothing'), 'github.com/nobody/nothing');
});

test('store repair refuses each bad combination of options with one line', (t) => {
  const { h, app } = setup(t);
  const bad: [string[], RegExp][] = [
    [['fix-login', '--to', h, '--lost'], /option '--lost' cannot be used with option '--to <folder>'/],
    [['fix-login', '--to', h, '--remote', 'x/y'], /option '--remote <old-key>' cannot be used with option '--to <folder>'/],
    [['--lost', '--remote', 'x/y'], /option '--remote <old-key>' cannot be used with option '--lost'/],
    [['--to', h], /--to repairs one task: ledger store repair <slug> --to <folder>/],
    [['--lost'], /--lost repairs one task: ledger store repair <slug> --lost/],
    [['fix-login', '--remote', 'x/y'], /--remote moves every task of a repo key, so it takes no task: drop fix-login\./],
    [['fix-login', '--search', h], /--search looks for the folder of every task whose folder is gone, so it takes no task: drop fix-login\./],
    [['--search', h, '--to', h], /option '--to <folder>' cannot be used with option '--search <folder\.\.\.>'/],
    [['--search', h, '--lost'], /option '--lost' cannot be used with option '--search <folder\.\.\.>'/],
    [['--search', h, '--remote', 'x/y'], /option '--remote <old-key>' cannot be used with option '--search <folder\.\.\.>'/],
    [['--search', h, '--dry-run'], /--dry-run goes with --to, --lost or --remote; the report alone changes nothing\./],
    [['fix-login'], /Say how to repair fix-login: --to <folder> points it at the folder it moved to, --lost marks it lost\./],
    [['--dry-run'], /--dry-run goes with --to, --lost or --remote; the report alone changes nothing\./],
  ];
  for (const [args, error] of bad) {
    const ran = ledger(h, app, 'store', 'repair', ...args);
    assert.notEqual(ran.status, 0, `${args.join(' ')} passed:\n${ran.stdout}`);
    assert.equal(ran.stderr.trim().split('\n').length, 1, `${args.join(' ')}:\n${ran.stderr}`);
    assert.match(ran.stderr, error, args.join(' '));
  }
});

test('sqlite store: store repair reports a missing folder, --to points the task at its new folder, and --lost marks one lost', { skip: noSqlite }, (t) => {
  const { h, app } = setup(t, 'sqlite');
  const repair = forStorage(h);
  const moving = start(repair, app, 'fix-login');
  const losing = start(repair, app, 'gone-for-good');
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(moving.worktree, moved);
  rmSync(losing.worktree, { recursive: true, force: true });

  const report = repair(app, 'store', 'repair');
  assert.equal(report.status, 1, report.stderr);
  assert.ok(report.stdout.includes(moving.worktree) && report.stdout.includes(losing.worktree), report.stdout);
  ok(repair(app, 'store', 'repair', 'fix-login', '--to', moved));
  ok(repair(app, 'store', 'repair', 'gone-for-good', '--lost'));
  assert.equal(taskIn(repair, app, 'fix-login').worktree, moved);
  assert.equal(taskIn(repair, app, 'gone-for-good').status, 'lost');
  assert.match(ok(repair(app, 'store', 'repair')), /No problems found\./);
  assert.equal(existsSync(path.join(h, '.claude/ledger-active')), false, 'the SQLite store made ~/.claude/ledger-active');
});

test('git store: store repair --to and --lost write the record and commit it', (t) => {
  const m = machine(t, remote(t));
  setUp(m);
  const repair: Run = (cwd, ...args) => run(m, args, { cwd });
  const moving = start(repair, m.app, 'fix-login');
  const losing = start(repair, m.app, 'gone-for-good');
  const moved = path.join(m.h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(moving.worktree, moved);
  rmSync(losing.worktree, { recursive: true, force: true });

  ok(repair(m.app, 'store', 'repair', 'fix-login', '--to', moved));
  ok(repair(m.app, 'store', 'repair', 'gone-for-good', '--lost'));
  assert.equal(taskIn(repair, m.app, 'fix-login').worktree, moved);
  assert.equal(taskIn(repair, m.app, 'gone-for-good').status, 'lost');
  assert.equal(git(m.h, m.clone, 'status', '--porcelain'), '', 'the clone has changes no commit holds');
  const record = git(m.h, m.clone, 'ls-files').split('\n').find((file) => file.includes(encodeURIComponent(APP_KEY)) && file.endsWith('/gone-for-good.json')) ?? assert.fail('no committed record of gone-for-good');
  assert.match(git(m.h, m.clone, 'show', `HEAD:${record}`), /"lost"/);
});

const OLD_KEY = 'github.com/me/app-old';
const NEW_KEY = 'github.com/me/app';

function replacesAliases(store: LedgerStore): void {
  try {
    store.aliases.add('app-folder', OLD_KEY);
    store.aliases.add('lib', OLD_KEY);
    store.aliases.replace([['app-folder', OLD_KEY]], [['app-folder', NEW_KEY], [OLD_KEY, NEW_KEY]]);
    const replaced = { lib: OLD_KEY, 'app-folder': NEW_KEY, [OLD_KEY]: NEW_KEY };
    assert.deepEqual(Object.fromEntries(store.aliases.read()), replaced);
    assert.throws(() => store.aliases.replace([['app-folder', NEW_KEY]], [['lib', 'github.com/me/other']]), /lib/);
    assert.deepEqual(Object.fromEntries(store.aliases.read()), replaced, 'a refused replace removed an alias');
  } finally {
    store.close?.();
  }
}

for (const storage of ['file', 'sqlite'] as const) {
  test(`${storage} store: aliases.replace removes and adds aliases in one write, and changes nothing when it refuses an alias`, { skip: storage === 'sqlite' && noSqlite }, (t) => {
    const { h } = setup(t, storage);
    replacesAliases(openStore(ledgerPaths(h), storage));
  });
}

test('git store: aliases.replace removes and adds aliases in one write, and changes nothing when it refuses an alias', (t) => {
  const m = machine(t, remote(t));
  setUp(m);
  replacesAliases(openStore(ledgerPaths(m.h), 'git', { backgroundSync: false }));
});

test('store repair --remote back to the key a repo was renamed from leaves one alias, not a cycle', (t) => {
  const { h, app, key, newKey, repair } = renamedRemote(t);
  ok(repair(app, 'store', 'repair', '--remote', key));
  git(h, app, 'remote', 'set-url', 'origin', path.join(h, 'remotes', 'app.git'));
  assert.equal(repoKeyOf(app), key);

  ok(repair(app, 'store', 'repair', '--remote', newKey));
  assert.deepEqual(Object.fromEntries(fileStore(ledgerPaths(h)).aliases.read()), { [newKey]: key });
  assert.deepEqual(filed(h, key), { active: ['fix-login'], backlog: ['idea'], archive: ['2026-01-02-done-one'] });
  assert.match(ok(repair(app, 'store', 'repair')), /No problems found\./);
});

for (const storage of ['file', 'sqlite'] as const) {
  test(`${storage} store: a lost task does not hold its old folder, so ledger task new --here starts a task in a new worktree there`, { skip: storage === 'sqlite' && noSqlite }, (t) => {
    const { h, app } = setup(t, storage);
    const repair = forStorage(h);
    const { worktree } = start(repair, app, 'fix-login');
    rmSync(worktree, { recursive: true, force: true });
    ok(repair(app, 'store', 'repair', 'fix-login', '--lost'));
    git(h, app, 'worktree', 'prune');
    git(h, app, 'worktree', 'add', '--quiet', '-b', 'again', worktree, 'main');

    ok(repair(worktree, 'task', 'new', '--here', 'second-try', '--goal', 'Again.'));
    assert.equal(taskIn(repair, app, 'second-try').worktree, worktree);
    assert.equal(taskIn(repair, app, 'fix-login').status, 'lost');
  });
}

/** The ledgers of each place filed under `key` in `store`, which it closes. */
function filedIn(store: LedgerStore, key: string) {
  try {
    return { active: store.active.list(key).map(({ name }) => name), backlog: store.backlog.list(key).map(({ name }) => name), archive: store.archive.list(key).map(({ name }) => name) };
  } finally {
    store.close?.();
  }
}

function renameOrigin(h: string, app: string): string {
  const renamed = path.join(h, 'remotes', 'app-renamed.git');
  git(h, h, 'init', '--quiet', '--bare', '-b', 'main', renamed);
  git(h, app, 'remote', 'set-url', 'origin', renamed);
  return repoKeyOf(app);
}

/** The report names `key` as renamed to `newKey`; --remote then files the active and backlog task of `key` under `newKey`. */
function refilesRenamed(repair: Run, app: string, key: string, newKey: string, filedUnder: (key: string) => ReturnType<typeof filedIn>): void {
  const report = repair(app, 'store', 'repair');
  assert.equal(report.status, 1, report.stderr);
  assert.ok(report.stdout.includes(`${key} → ${newKey}`), report.stdout);
  assert.ok(report.stdout.includes(`ledger store repair --remote ${key}`), report.stdout);
  ok(repair(app, 'store', 'repair', '--remote', key));
  assert.deepEqual(filedUnder(newKey), { active: ['fix-login'], backlog: ['idea'], archive: [] });
  assert.deepEqual(filedUnder(key), { active: [], backlog: [], archive: [] });
  assert.match(ok(repair(app, 'store', 'repair')), /No problems found\./);
}

test('sqlite store: store repair reports a renamed remote, and --remote files its tasks under the new key with an alias', { skip: noSqlite }, (t) => {
  const { h, app, key } = setup(t, 'sqlite');
  const repair = forStorage(h);
  start(repair, app, 'fix-login');
  ok(repair(app, 'task', 'new', 'idea', '--goal', 'Later.'));
  const newKey = renameOrigin(h, app);
  const store = () => openStore(ledgerPaths(h), 'sqlite');
  refilesRenamed(repair, app, key, newKey, (repo) => filedIn(store(), repo));
  const opened = store();
  assert.equal(opened.aliases.read().get(key), newKey);
  opened.close?.();
});

test('git store: store repair reports a renamed remote, and --remote files its tasks under the new key and commits them', (t) => {
  const m = machine(t, remote(t));
  setUp(m);
  const repair: Run = (cwd, ...args) => run(m, args, { cwd });
  start(repair, m.app, 'fix-login');
  ok(repair(m.app, 'task', 'new', 'idea', '--goal', 'Later.'));
  const newKey = renameOrigin(m.h, m.app);
  const store = () => openStore(ledgerPaths(m.h), 'git', { backgroundSync: false, readOnly: true });
  refilesRenamed(repair, m.app, APP_KEY, newKey, (repo) => filedIn(store(), repo));
  assert.equal(store().aliases.read().get(APP_KEY), newKey);
  assert.equal(git(m.h, m.clone, 'status', '--porcelain'), '', 'the clone has changes no commit holds');
  assert.ok(git(m.h, m.clone, 'ls-files').includes(`${encodeURIComponent(newKey)}/fix-login.json`), 'no committed record of fix-login under the new key');
});

test('store repair quotes the paths in the commands it prints, so they run in a shell', (t) => {
  const h = home(t);
  copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
  const app = repository(h, path.join(h, 'my repos', 'app'));
  writeFileSync(path.join(app, '.git/info/exclude'), '.claude/\n');
  const key = repoKeyOf(app);
  const repair = forStorage(h);
  const { worktree, branch } = start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  git(h, app, 'worktree', 'prune');
  const moved = worktreeAt(h, app, path.join(h, 'moved here', 'fix-login'), branch);

  const found = repair(app, 'store', 'repair', '--search', path.dirname(moved));
  assert.ok(found.stdout.includes(`ledger store repair 'fix-login@${app}' --to '${moved}'`), found.stdout);
  assert.ok(found.stdout.includes(`ledger store repair 'fix-login@${app}' --lost`), found.stdout);
  const dry = ok(repair(app, 'store', 'repair', 'fix-login', '--to', moved, '--dry-run'));
  assert.ok(dry.includes(`git -C '${app}' worktree repair '${moved}'`), dry);
  const newKey = renameOrigin(h, app);
  assert.notEqual(newKey, key);
  const renamed = repair(app, 'store', 'repair');
  assert.ok(renamed.stdout.includes(`cd '${app}' && ledger store repair --remote ${key}`), renamed.stdout);
});

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('ledger task retire of a lost task removes no worktree, also with --force, though another task lives at its old path now', (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree } = start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  ok(repair(app, 'store', 'repair', 'fix-login', '--lost'));
  git(h, app, 'worktree', 'prune');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'again', worktree, 'main');
  ok(repair(worktree, 'task', 'new', '--here', 'second-try', '--goal', 'Again.'));
  const work = path.join(worktree, 'work.txt');
  writeFileSync(work, 'uncommitted work of second-try');

  repair(app, 'task', 'retire', 'fix-login');
  assert.ok(existsSync(work), 'a retire without --force removed the worktree of second-try');
  repair(app, 'task', 'retire', 'fix-login', '--force');
  assert.ok(existsSync(work), 'a retire with --force removed the worktree of second-try');
  assert.equal(taskIn(repair, app, 'second-try').worktree, worktree);
  assert.ok(filed(h, key).archive.some((name) => name.endsWith('-fix-login')), `fix-login is not archived: ${JSON.stringify(filed(h, key))}`);
  assert.ok(!filed(h, key).active.includes('fix-login'), 'fix-login is still active');
});

test('store repair --remote leaves a task whose main checkout is gone or has a third key, as it is, lists it, writes no alias, and exits 1', (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  start(repair, app, 'fix-login');
  ok(repair(app, 'task', 'new', 'idea', '--goal', 'Later.'));
  const gone = cloneOn(h, app, path.join(h, 'repos', 'app-gone'), 'side');
  ok(repair(gone, 'task', 'new', 'orphan', '--goal', 'Kept.'));
  const third = cloneOn(h, app, path.join(h, 'repos', 'app-third'), 'side');
  ok(repair(third, 'task', 'new', 'stranger', '--goal', 'Kept.'));
  const texts = () => ['orphan', 'stranger'].map((slug) => fileStore(ledgerPaths(h)).backlog.read(key, slug)?.text);
  const before = texts();
  const newKey = renameOrigin(h, app);
  rmSync(gone, { recursive: true, force: true });
  const thirdUrl = path.join(h, 'remotes', 'third.git');
  git(h, h, 'init', '--quiet', '--bare', '-b', 'main', thirdUrl);
  git(h, third, 'remote', 'set-url', 'origin', thirdUrl);

  const ran = repair(app, 'store', 'repair', '--remote', key);
  assert.equal(ran.status, 1, ran.stderr);
  assert.match(ran.stdout, /orphan/);
  assert.match(ran.stdout, /stranger/);
  assert.deepEqual(filed(h, key), { active: [], backlog: ['orphan', 'stranger'], archive: [] });
  assert.deepEqual(filed(h, newKey), { active: ['fix-login'], backlog: ['idea'], archive: [] });
  assert.deepEqual(texts(), before, 'a record left under the old key changed');
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get(key), undefined);
});

test('git store: store repair --remote exits 1, says so on stderr and records no alias when the store commit fails, and a retry does not exit 0', (t) => {
  const m = machine(t, remote(t));
  setUp(m);
  const repair: Run = (cwd, ...args) => run(m, args, { cwd });
  start(repair, m.app, 'fix-login');
  renameOrigin(m.h, m.app);
  writeFileSync(path.join(m.clone, 'stray.txt'), 'no ledger');
  git(m.h, m.clone, 'add', '--force', 'stray.txt');
  const aliases = () => {
    const store = openStore(ledgerPaths(m.h), 'git', { backgroundSync: false, readOnly: true });
    try {
      return Object.fromEntries(store.aliases.read());
    } finally {
      store.close?.();
    }
  };

  const ran = repair(m.app, 'store', 'repair', '--remote', APP_KEY);
  assert.equal(ran.status, 1, ran.stdout);
  assert.match(ran.stderr, /store commit failed/i);
  assert.ok(ran.stderr.includes(APP_KEY), ran.stderr);
  assert.doesNotMatch(ran.stdout, /^Moved /m);
  assert.doesNotMatch(ran.stdout, /recorded .* as an alias/);
  assert.deepEqual(aliases(), {});
  assert.notEqual(repair(m.app, 'store', 'repair', '--remote', APP_KEY).status, 0, 'a retry after a failed commit exited 0');
});

test('store repair --remote leaves a task whose slug any place of the current key has, active too', (t) => {
  const { h, app, key, newKey, repair } = renamedRemote(t);
  start(repair, app, 'idea');
  const ran = repair(app, 'store', 'repair', '--remote', key);
  assert.equal(ran.status, 1, ran.stderr);
  assert.match(ran.stdout, /left backlog idea/);
  assert.deepEqual(filed(h, key), { active: [], backlog: ['idea'], archive: [] });
  assert.deepEqual(filed(h, newKey), { active: ['fix-login', 'idea'], backlog: [], archive: ['2026-01-02-done-one'] });
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get(key), undefined);
});

test('sqlite store: the report and --search find no problems before the database exists, and they, each --dry-run and each refusal make no database', { skip: noSqlite }, (t) => {
  const { h, app } = setup(t, 'sqlite');
  for (const args of [[], ['--search', h]]) {
    assert.match(ok(ledger(h, app, 'store', 'repair', ...args)), /No problems found\./);
  }
  fails(ledger(h, app, 'store', 'repair', '--search', path.join(h, 'nowhere')), path.join(h, 'nowhere'));
  const refused = [['fix-login', '--to', h], ['fix-login', '--lost'], ['--remote', 'github.com/me/old']];
  for (const args of [[], ['--search', h], ['fix-login', '--to', h, '--dry-run'], ['fix-login', '--lost', '--dry-run'], ['--remote', 'github.com/me/old', '--dry-run'], ...refused]) {
    ledger(h, app, 'store', 'repair', ...args);
    assert.equal(existsSync(sqliteFile(h)), false, `store repair ${args.join(' ')} made ${sqliteFile(h)}`);
  }
  for (const args of refused) assert.notEqual(ledger(h, app, 'store', 'repair', ...args).status, 0, `store repair ${args.join(' ')} did not refuse`);
});

test('git store: the report, --search, each --dry-run and each refusal put back no pre-push hook and commit nothing', (t) => {
  const m = machine(t, remote(t));
  setUp(m);
  const repair: Run = (cwd, ...args) => run(m, args, { cwd });
  const { worktree } = start(repair, m.app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  const hook = path.join(m.clone, '.git', 'hooks', 'pre-push');
  rmSync(hook);
  const head = git(m.h, m.clone, 'rev-parse', 'HEAD');
  for (const args of [[], ['--search', m.h], ['fix-login', '--to', m.h, '--dry-run'], ['fix-login', '--lost', '--dry-run'], ['--remote', 'github.com/me/old', '--dry-run'], ['fix-login', '--to', m.h], ['--remote', 'github.com/me/old']]) {
    repair(m.app, 'store', 'repair', ...args);
    assert.equal(existsSync(hook), false, `store repair ${args.join(' ')} put back the pre-push hook`);
    assert.equal(git(m.h, m.clone, 'rev-parse', 'HEAD'), head, `store repair ${args.join(' ')} committed`);
  }
});

test('store repair, after --to took a checkout through an alias, reports no rename and counts the task as this machine’s', (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  const oldClone = path.join(h, 'repos', 'app-old');
  git(h, h, 'clone', '--quiet', git(h, app, 'remote', 'get-url', 'origin'), oldClone);
  const oldUrl = path.join(h, 'remotes', 'app-old-name.git');
  git(h, h, 'init', '--quiet', '--bare', '-b', 'main', oldUrl);
  git(h, oldClone, 'remote', 'set-url', 'origin', oldUrl);
  const oldKey = repoKeyOf(oldClone);
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  git(h, oldClone, 'worktree', 'add', '--quiet', '-b', branch, moved, 'HEAD');
  fileStore(ledgerPaths(h)).aliases.add(oldKey, key);
  ok(repair(app, 'store', 'repair', 'fix-login', '--to', moved));

  assert.match(ok(repair(app, 'store', 'repair')), /No problems found\./);
  assert.equal(taskIn(repair, app, 'fix-login').elsewhere, undefined);
});

test('store repair reports a renamed remote for a clone whose key changed, while another clone still has the old key', (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  ok(repair(app, 'task', 'new', 'idea', '--goal', 'Later.'));
  const other = cloneOn(h, app, path.join(h, 'repos', 'app-b'), 'side');
  ok(repair(other, 'task', 'new', 'other-idea', '--goal', 'Later.'));
  const newKey = renameOrigin(h, app);

  const ran = repair(app, 'store', 'repair');
  assert.equal(ran.status, 1, ran.stderr);
  assert.ok(ran.stdout.includes(`${key} → ${newKey}`), ran.stdout);
});

test('store repair, run from a main checkout that moved, prints fix commands that run', (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  start(repair, app, 'fix-login');
  const app2 = path.join(h, 'repos', 'app2');
  renameSync(app, app2);

  const ran = repair(app2, 'store', 'repair');
  assert.equal(ran.status, 1, ran.stderr);
  assert.ok(!ran.stdout.includes(`fix-login@${app} `), ran.stdout);
  const lost = new RegExp(`ledger store repair (fix-login@${escaped(app2)}) --lost`).exec(ran.stdout) ?? assert.fail(`no --lost command names ${app2}:\n${ran.stdout}`);
  ok(repair(h, 'store', 'repair', lost[1], '--lost'));
  assert.equal(taskIn(repair, app2, 'fix-login').status, 'lost');
});

test('store repair <slug> --to refuses a parked task', (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree } = start(repair, app, 'fix-login');
  ok(repair(worktree, 'task', 'park', 'fix-login', '--reason', 'waiting'));
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(worktree, moved);
  const before = fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text;
  fails(repair(app, 'store', 'repair', 'fix-login', '--to', moved), /parked/);
  assert.equal(fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text, before);
});

test('store repair <slug> --lost refuses a task marked lost whose folder is back', (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree } = start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  ok(repair(app, 'store', 'repair', 'fix-login', '--lost'));
  mkdirSync(worktree, { recursive: true });
  fails(repair(app, 'store', 'repair', 'fix-login', '--lost'), worktree);
});

test('a - lost: Location line in any other shape than the lost mark stays a note through a record round trip', () => {
  const note = '- lost: 2026-01-02 — customer incident INC-38';
  const markdown = ledgerText({ slug: 'fix-login', worktree: '/repos/app/.claude/worktrees/fix-login', branch: 'me/fix-login' }).replace('- design refs: none', `- design refs: none\n${note}`);
  assert.equal(parseLedger(markdown).location.lost, undefined);
  const rendered = renderRecord(parseRecord(markdown));
  assert.ok(rendered.includes(note), rendered);
  assert.equal(parseLedger(rendered).location.lost, undefined);
  assert.equal(renderRecord(parseRecord(rendered)), rendered);

  const mark = '- lost: 2026-01-02 — folder /repos/app/.claude/worktrees/fix-login not found';
  assert.deepEqual(parseLedger(markdown.replace(note, mark)).location.lost, { date: '2026-01-02' });
});

test('store repair --remote leaves a ledger whose title has the slug of a live task of the current key, though its name differs', (t) => {
  const { h, app, key, newKey, repair } = renamedRemote(t);
  start(repair, app, 'fix');
  const store = fileStore(ledgerPaths(h));
  const idea = store.backlog.read(key, 'idea')?.text ?? assert.fail('no backlog idea');
  store.backlog.write(key, 'legacy', idea.replace(/^# Task ledger — idea$/m, '# Task ledger — fix'));

  const ran = repair(app, 'store', 'repair', '--remote', key);
  assert.equal(ran.status, 1, ran.stderr);
  assert.match(ran.stdout, /left backlog legacy/);
  assert.ok(filed(h, key).backlog.includes('legacy'), JSON.stringify(filed(h, key)));
  assert.ok(!filed(h, newKey).backlog.includes('legacy'), JSON.stringify(filed(h, newKey)));
  assert.equal(store.aliases.read().get(key), undefined);
});

test('a - lost: line is the lost mark only in the shape written for the recorded worktree, wherever it stands in Location', () => {
  const worktree = '/repos/app/.claude/worktrees/fix-login';
  const markdown = ledgerText({ slug: 'fix-login', worktree, branch: 'me/fix-login' });
  for (const note of ['- lost: 2026-01-02', '- lost: 2026-01-02 — folder /repos/app/.claude/worktrees/other not found']) {
    const text = markdown.replace('- design refs: none', `- design refs: none\n${note}`);
    assert.equal(parseLedger(text).location.lost, undefined, note);
    const rendered = renderRecord(parseRecord(text));
    assert.ok(rendered.includes(note), rendered);
    assert.equal(parseLedger(rendered).location.lost, undefined, note);
  }

  const mark = `- lost: 2026-01-02 — folder ${worktree} not found`;
  const markFirst = markdown.replace(`- worktree: ${worktree}`, `${mark}\n- worktree: ${worktree}`);
  assert.deepEqual(parseLedger(markFirst).location.lost, { date: '2026-01-02' });
  assert.deepEqual(parseRecord(markFirst).lost, { date: '2026-01-02' });
  const noWorktree = ledgerText({ slug: 'fix-login' }).replace('- design refs: none', '- design refs: none\n- lost: 2026-01-02');
  assert.deepEqual(parseLedger(noWorktree).location.lost, { date: '2026-01-02' });
  assert.deepEqual(parseRecord(noWorktree).lost, { date: '2026-01-02' });
});

/** A lost fix-login, and second-try in a new worktree at fix-login's old path. */
function reusedPath(t: TestContext) {
  const world = setup(t);
  const { h, app } = world;
  const repair = forStorage(h);
  const { worktree } = start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  ok(repair(app, 'store', 'repair', 'fix-login', '--lost'));
  git(h, app, 'worktree', 'prune');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'again', worktree, 'main');
  ok(repair(worktree, 'task', 'new', '--here', 'second-try', '--goal', 'Again.'));
  return { ...world, repair, worktree };
}

test('ledger task retire without a slug, in the worktree that took a lost task’s old path, picks the task of that worktree', (t) => {
  const { repair, worktree } = reusedPath(t);
  const ran = repair(worktree, 'task', 'retire');
  assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
  assert.doesNotMatch(ran.stderr, /active tasks name the worktree/);
  assert.ok(`${ran.stdout}${ran.stderr}`.includes('second-try'), `${ran.stdout}${ran.stderr}`);
});

test('ledger task retire of a lost task says it is lost, not that it may be live on another machine', (t) => {
  const { app, repair } = reusedPath(t);
  const ran = repair(app, 'task', 'retire', 'fix-login');
  const output = `${ran.stdout}${ran.stderr}`;
  assert.match(output, /lost/);
  assert.doesNotMatch(output, /another machine/);
});

test('a clone that still has the old key of an alias sees the task --to pointed at a worktree of it, in its main session and by name', (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  const oldClone = path.join(h, 'repos', 'app-old');
  git(h, h, 'clone', '--quiet', git(h, app, 'remote', 'get-url', 'origin'), oldClone);
  const oldUrl = path.join(h, 'remotes', 'app-old-name.git');
  git(h, h, 'init', '--quiet', '--bare', '-b', 'main', oldUrl);
  git(h, oldClone, 'remote', 'set-url', 'origin', oldUrl);
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  git(h, oldClone, 'worktree', 'add', '--quiet', '-b', branch, moved, 'HEAD');
  fileStore(ledgerPaths(h)).aliases.add(repoKeyOf(oldClone), key);
  ok(repair(app, 'store', 'repair', 'fix-login', '--to', moved));

  assert.ok(ok(repair(oldClone, 'session')).split('\n').includes(moved), 'the main session of the old-key clone lacks fix-login');
  const retire = repair(oldClone, 'task', 'retire', 'fix-login', '--dry-run', '--json');
  assert.equal(retire.status, 0, `${retire.stdout}${retire.stderr}`);
  assert.equal((JSON.parse(retire.stdout) as { ok: boolean }).ok, true, retire.stdout);
  assert.ok(retire.stdout.includes(moved), retire.stdout);
});

test('store repair --search, run outside the repo after its main checkout moved, prints a --to command for the one checkout it found, and that command runs', (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree } = start(repair, app, 'fix-login');
  const app2 = path.join(h, 'repos', 'app2');
  renameSync(app, app2);
  const moved = path.join(app2, path.relative(app, worktree));
  git(h, app2, 'worktree', 'repair', moved);

  const ran = repair(h, 'store', 'repair', '--search', app2);
  assert.equal(ran.status, 1, ran.stderr);
  const to = new RegExp(`ledger store repair (fix-login@${escaped(app2)}) --to (${escaped(moved)})$`, 'm').exec(ran.stdout) ?? assert.fail(`no --to command names ${app2} and ${moved}:\n${ran.stdout}`);
  ok(repair(h, 'store', 'repair', to[1], '--to', to[2]));
  assert.equal(taskIn(repair, app2, 'fix-login').worktree, moved);
});

test('store repair <slug> --lost refuses a parked task, and --to refuses a parked task that is marked lost', (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree } = start(repair, app, 'fix-login');
  ok(repair(worktree, 'task', 'park', 'fix-login', '--reason', 'waiting'));
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(worktree, moved);
  const store = fileStore(ledgerPaths(h));
  const text = () => store.active.read(key, 'fix-login')?.text;
  const parked = text();
  fails(repair(app, 'store', 'repair', 'fix-login', '--lost'), /parked/);
  assert.equal(text(), parked);

  store.active.update(key, 'fix-login', (each) => setLocationBullet(each, 'lost', `2026-01-02 — folder ${worktree} not found`));
  assert.equal(taskIn(repair, app, 'fix-login').status, 'lost');
  const marked = text();
  fails(repair(app, 'store', 'repair', 'fix-login', '--to', moved), /parked/);
  assert.equal(text(), marked);
});

test('store repair --remote moves a ledger that names no main checkout when the old key is an alias of this repo already', (t) => {
  const { h, app, key, newKey, repair } = renamedRemote(t);
  const store = fileStore(ledgerPaths(h));
  store.backlog.write(key, 'no-main', ledgerText({ slug: 'no-main' }));
  store.aliases.add(key, newKey);

  ok(repair(app, 'store', 'repair', '--remote', key));
  assert.deepEqual(filed(h, key), { active: [], backlog: [], archive: [] });
  assert.ok(filed(h, newKey).backlog.includes('no-main'), JSON.stringify(filed(h, newKey)));
});

for (const storage of ['file', 'sqlite'] as const) {
  test(`${storage} store: store repair --to and --lost keep a - lost: note that is no lost mark, and change only the mark`, { skip: storage === 'sqlite' && noSqlite }, (t) => {
    const { h, app, key } = setup(t, storage);
    const repair = forStorage(h);
    const { worktree, branch } = start(repair, app, 'fix-login');
    const note = '- lost: 2026-01-02 — customer incident INC-38';
    const store = openStore(ledgerPaths(h), storage);
    try {
      store.active.update(key, 'fix-login', (text) => setLocationBullet(text, 'lost', note.slice('- lost: '.length)));
    } finally {
      store.close?.();
    }
    const moved = path.join(h, 'moved', 'fix-login');
    mkdirSync(path.dirname(moved), { recursive: true });
    renameSync(worktree, moved);

    ok(repair(app, 'store', 'repair', 'fix-login', '--to', moved));
    assert.ok(shown(repair, app, 'fix-login').includes(note), shown(repair, app, 'fix-login'));
    assert.equal(taskIn(repair, app, 'fix-login').status, 'active');

    rmSync(moved, { recursive: true, force: true });
    ok(repair(app, 'store', 'repair', 'fix-login', '--lost'));
    const lost = shown(repair, app, 'fix-login');
    assert.ok(lost.includes(note), lost);
    assert.ok(lost.includes(`- lost: ${today()} — folder ${moved} not found`), lost);
    assert.equal(taskIn(repair, app, 'fix-login').status, 'lost');

    git(h, app, 'worktree', 'prune');
    worktreeAt(h, app, moved, branch);
    ok(repair(app, 'store', 'repair', 'fix-login', '--to', moved));
    const back = shown(repair, app, 'fix-login');
    assert.ok(back.includes(note), back);
    assert.doesNotMatch(back, /not found/);
    assert.equal(taskIn(repair, app, 'fix-login').status, 'active');
  });
}

test('setLostMark adds, keeps and drops only the lost mark, never a - lost: note in Location', () => {
  const worktree = '/repos/app/.claude/worktrees/fix-login';
  const note = '- lost: 2026-01-02 — customer incident INC-38';
  const markdown = ledgerText({ slug: 'fix-login', worktree, branch: 'me/fix-login' }).replace('- design refs: none', `- design refs: none\n${note}`);
  const mark = `- lost: 2026-03-04 — folder ${worktree} not found`;

  const marked = setLostMark(markdown, { date: '2026-03-04' }) ?? assert.fail('no ## Location');
  assert.ok(marked.includes(note), marked);
  assert.ok(marked.includes(mark), marked);
  assert.deepEqual(parseLedger(marked).location.lost, { date: '2026-03-04' });

  const cleared = setLostMark(marked, undefined) ?? assert.fail('no ## Location');
  assert.ok(cleared.includes(note), cleared);
  assert.ok(!cleared.includes(mark), cleared);
  assert.equal(setLostMark(markdown, undefined), markdown, 'a ledger with no lost mark changed');
});

test('a - lost: line not in the exact shape the lost mark is written in is a note to setLostMark and to record conversion', () => {
  const note = '- lost:2026-01-02 — folder /gone not found';
  const markdown = ledgerText({ slug: 'fix-login', worktree: '/gone', branch: 'me/fix-login' }).replace('- design refs: none', `- design refs: none\n${note}`);
  assert.equal(parseLedger(markdown).location.lost, undefined);
  assert.equal(setLostMark(markdown, undefined), markdown, 'dropping the lost mark changed a note');
  const marked = setLostMark(markdown, { date: '2026-03-04' }) ?? assert.fail('no ## Location');
  assert.ok(marked.includes(note), marked);
  assert.ok(marked.includes('- lost: 2026-03-04 — folder /gone not found'), marked);
  assert.ok((setLostMark(marked, undefined) ?? '').includes(note));

  assert.equal(parseRecord(markdown).lost, undefined);
  const rendered = renderRecord(parseRecord(markdown));
  assert.ok(rendered.includes(note), rendered);
  assert.equal(parseLedger(rendered).location.lost, undefined);
});

for (const storage of ['file', 'sqlite'] as const) {
  test(`${storage} store: store repair --to and --lost keep a - lost: note that names the worktree but lacks the space after the colon`, { skip: storage === 'sqlite' && noSqlite }, (t) => {
    const { h, app, key } = setup(t, storage);
    const repair = forStorage(h);
    const { worktree } = start(repair, app, 'fix-login');
    const note = `- lost:2026-01-02 — folder ${worktree} not found`;
    const store = openStore(ledgerPaths(h), storage);
    try {
      store.active.update(key, 'fix-login', (text) => text.replace(/^(- branch: .*)$/m, `$1\n${note}`));
    } finally {
      store.close?.();
    }
    assert.ok(shown(repair, app, 'fix-login').includes(note), shown(repair, app, 'fix-login'));
    assert.equal(taskIn(repair, app, 'fix-login').status, 'active');
    const moved = path.join(h, 'moved', 'fix-login');
    mkdirSync(path.dirname(moved), { recursive: true });
    renameSync(worktree, moved);

    ok(repair(app, 'store', 'repair', 'fix-login', '--to', moved));
    assert.ok(shown(repair, app, 'fix-login').includes(note), shown(repair, app, 'fix-login'));
    rmSync(moved, { recursive: true, force: true });
    ok(repair(app, 'store', 'repair', 'fix-login', '--lost'));
    const lost = shown(repair, app, 'fix-login');
    assert.ok(lost.includes(note), lost);
    assert.ok(lost.includes(`- lost: ${today()} — folder ${moved} not found`), lost);
  });
}

test('store repair --remote refuses, moving nothing, when an alias of the old key files a task whose slug the current key has', (t) => {
  const { h, app, key, newKey, repair } = renamedRemote(t);
  start(repair, app, 'fix');
  const store = fileStore(ledgerPaths(h));
  store.backlog.write('app-folder', 'fix', ledgerText({ slug: 'fix', main: app }));
  store.aliases.add('app-folder', key);
  const before = { old: filed(h, key), now: filed(h, newKey), alias: filed(h, 'app-folder') };
  const fixes = () => listed(repair, app).filter(({ slug }) => slug === 'fix').map(({ status }) => status).sort();
  assert.deepEqual(fixes(), ['active', 'backlog']);

  for (const args of [['--dry-run'], []]) {
    const ran = repair(app, 'store', 'repair', '--remote', key, ...args);
    assert.equal(ran.status, 1, `${ran.stdout}${ran.stderr}`);
    assert.match(ran.stderr, /app-folder/);
    assert.match(ran.stderr, /\bfix\b/);
    assert.match(ran.stderr, /nothing was moved/);
  }
  assert.deepEqual({ old: filed(h, key), now: filed(h, newKey), alias: filed(h, 'app-folder') }, before);
  assert.deepEqual(Object.fromEntries(fileStore(ledgerPaths(h)).aliases.read()), { 'app-folder': key });
  assert.deepEqual(fixes(), ['active', 'backlog']);
});

/** The moved-main world of the --search tests: app renamed to app2, with fix-login's worktree repaired in it. */
function movedMain(t: TestContext) {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = start(repair, app, 'fix-login');
  const app2 = path.join(h, 'repos', 'app2');
  renameSync(app, app2);
  const moved = path.join(app2, path.relative(app, worktree));
  git(h, app2, 'worktree', 'repair', moved);
  return { h, app2, moved, branch, repair };
}

/** The `ledger store repair …` line of `stdout` that ends with `flag`, run as it is printed, from `cwd`. */
function runPrinted(repair: Run, cwd: string, stdout: string, flag: RegExp): string {
  const line = stdout.split('\n').map((each) => each.trim()).find((each) => each.startsWith('ledger store repair ') && flag.test(each)) ?? assert.fail(`no command matches ${flag}:\n${stdout}`);
  return ok(repair(cwd, ...line.split(' ').slice(1)));
}

test('store repair --search with a folder and a folder inside it finds a checkout once, and prints a --to command that runs from outside the repo', (t) => {
  const { h, app2, moved, repair } = movedMain(t);
  const ran = repair(h, 'store', 'repair', '--search', h, app2);
  assert.equal(ran.status, 1, ran.stderr);
  assert.equal(ran.stdout.split('\n').filter((line) => line.trim() === `found ${moved}`).length, 1, ran.stdout);
  assert.ok(ran.stdout.includes(`ledger store repair fix-login@${app2} --to ${moved}`), ran.stdout);
  runPrinted(repair, h, ran.stdout, / --to \//);
  assert.equal(taskIn(repair, app2, 'fix-login').worktree, moved);
});

test('store repair --search that finds two checkouts prints a task reference that runs from outside the repo, though no --to folder', (t) => {
  const { h, app2, branch, repair } = movedMain(t);
  const other = worktreeAt(h, app2, path.join(h, 'elsewhere', 'fix-login'), branch);
  const ran = repair(h, 'store', 'repair', '--search', h);
  assert.equal(ran.status, 1, ran.stderr);
  assert.ok(ran.stdout.includes(`found ${other}`), ran.stdout);
  assert.ok(ran.stdout.includes(`ledger store repair fix-login@${app2} --to <folder>`), ran.stdout);
  assert.ok(ran.stdout.includes(`ledger store repair fix-login@${app2} --lost`), ran.stdout);
  runPrinted(repair, h, ran.stdout, / --lost$/);
  assert.equal(taskIn(repair, app2, 'fix-login').status, 'lost');
});

test('store repair <slug> --to records the main checkout of a record that names none, so the next rename can be found', (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree } = start(repair, app, 'fix-login');
  const store = fileStore(ledgerPaths(h));
  store.active.update(key, 'fix-login', (text) => setLocationBullet(text, 'main', undefined));
  assert.equal(parseLedger(store.active.read(key, 'fix-login')?.text ?? '').location.main, undefined);
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(worktree, moved);

  ok(repair(app, 'store', 'repair', 'fix-login', '--to', moved));
  const text = store.active.read(key, 'fix-login')?.text ?? assert.fail('fix-login is gone');
  assert.match(text, new RegExp(`^- main: ${escaped(app)}$`, 'm'));
  assert.equal(namedMain(text), app);
});

test('git store: store repair <slug> --to and --lost of another machine’s task refuse, also as a dry run, and put back no hook and write nothing', (t) => {
  const m = machine(t, remote(t));
  setUp(m);
  const repair: Run = (cwd, ...args) => run(m, args, { cwd });
  const { worktree } = start(repair, m.app, 'fix-login');
  const store = openStore(ledgerPaths(m.h), 'git', { backgroundSync: false });
  try {
    store.active.update(APP_KEY, 'fix-login', (text) => setLocationBullet(text, 'host', 'other-machine'));
  } finally {
    store.close?.();
  }
  const moved = path.join(m.h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(worktree, moved);
  const hook = path.join(m.clone, '.git', 'hooks', 'pre-push');
  rmSync(hook);
  const head = git(m.h, m.clone, 'rev-parse', 'HEAD');
  const record = () => {
    const reading = openStore(ledgerPaths(m.h), 'git', { backgroundSync: false, readOnly: true });
    try {
      return reading.active.read(APP_KEY, 'fix-login')?.text;
    } finally {
      reading.close?.();
    }
  };
  const before = record();

  for (const args of [['--to', moved, '--dry-run'], ['--to', moved], ['--lost', '--dry-run'], ['--lost']]) {
    const ran = repair(m.app, 'store', 'repair', 'fix-login', ...args);
    assert.equal(ran.status, 1, `store repair ${args.join(' ')}:\n${ran.stdout}${ran.stderr}`);
    assert.match(ran.stderr, /other-machine/);
    assert.doesNotMatch(ran.stdout, /[Ww]ould|Pointed|Marked/);
    assert.equal(existsSync(hook), false, `store repair ${args.join(' ')} put back the pre-push hook`);
    assert.equal(git(m.h, m.clone, 'rev-parse', 'HEAD'), head, `store repair ${args.join(' ')} committed`);
    assert.equal(record(), before);
  }
});

test('git store: store repair --remote that moves nothing, as an archive copy of that name is under the current key, puts back no hook and commits nothing', (t) => {
  const m = machine(t, remote(t));
  setUp(m);
  const repair: Run = (cwd, ...args) => run(m, args, { cwd });
  const newKey = renameOrigin(m.h, m.app);
  const store = openStore(ledgerPaths(m.h), 'git', { backgroundSync: false });
  try {
    for (const key of [APP_KEY, newKey]) store.archive.write(key, '2026-01-02-done-one', ledgerText({ slug: 'done-one', main: m.app }));
  } finally {
    store.close?.();
  }
  const hook = path.join(m.clone, '.git', 'hooks', 'pre-push');
  rmSync(hook);
  const head = git(m.h, m.clone, 'rev-parse', 'HEAD');

  const ran = repair(m.app, 'store', 'repair', '--remote', APP_KEY);
  assert.equal(ran.status, 1, `${ran.stdout}${ran.stderr}`);
  assert.match(ran.stdout, /left archive 2026-01-02-done-one/);
  assert.equal(existsSync(hook), false, 'store repair --remote put back the pre-push hook');
  assert.equal(git(m.h, m.clone, 'rev-parse', 'HEAD'), head, 'store repair --remote committed');
  assert.equal(git(m.h, m.clone, 'status', '--porcelain'), '');
});

test('store repair --search given one folder in two spellings of its case finds its checkout once, and prints a --to command for it', (t) => {
  const { h, app2, moved, repair } = movedMain(t);
  const shouted = path.join(path.dirname(app2), path.basename(app2).toUpperCase());
  if (!existsSync(shouted)) return t.skip('this volume tells upper from lower case');
  const ran = repair(h, 'store', 'repair', '--search', app2, shouted);
  assert.equal(ran.status, 1, ran.stderr);
  assert.deepEqual(ran.stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('found ')), [`found ${moved}`], ran.stdout);
  assert.ok(ran.stdout.includes(`ledger store repair fix-login@${app2} --to ${moved}`), ran.stdout);
});

test('store repair --search prints no --to command for a folder that another task names as its own', (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = start(repair, app, 'fix-login');
  const other = start(repair, app, 'other-task');
  rmSync(worktree, { recursive: true, force: true });
  git(h, app, 'worktree', 'prune');
  git(h, other.worktree, 'checkout', '--quiet', branch);

  const ran = repair(app, 'store', 'repair', '--search', app);
  assert.equal(ran.status, 1, ran.stderr);
  assert.ok(!ran.stdout.includes(`found ${other.worktree}`), ran.stdout);
  assert.match(ran.stdout, /ledger store repair fix-login\S* --to <folder>/);
});

test('store repair --search that finds the task repo only on another branch prints a --lost command that names the task by that checkout, and it runs', (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree } = start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  const app2 = path.join(h, 'repos', 'app2');
  renameSync(app, app2);

  const ran = repair(h, 'store', 'repair', '--search', app2);
  assert.equal(ran.status, 1, ran.stderr);
  assert.ok(ran.stdout.includes(`ledger store repair fix-login@${app2} --lost`), ran.stdout);
  runPrinted(repair, h, ran.stdout, / --lost$/);
  assert.equal(taskIn(repair, app2, 'fix-login').status, 'lost');
});

test('store repair --remote refuses, moving nothing, when the key of this repo is an alias of a third key already, so no chain of aliases is made', (t) => {
  const { h, app, key, newKey, repair } = renamedRemote(t);
  const third = 'github.com/someone/third';
  fileStore(ledgerPaths(h)).aliases.add(newKey, third);
  const before = { old: filed(h, key), now: filed(h, newKey) };

  for (const args of [['--dry-run'], []]) {
    const ran = repair(app, 'store', 'repair', '--remote', key, ...args);
    assert.equal(ran.status, 1, `${ran.stdout}${ran.stderr}`);
    assert.ok(ran.stderr.includes(third), ran.stderr);
    assert.match(ran.stderr, /nothing was moved/);
    assert.equal(ran.stdout, '', 'a refusal prints no plan');
  }
  assert.deepEqual({ old: filed(h, key), now: filed(h, newKey) }, before);
  assert.deepEqual(Object.fromEntries(fileStore(ledgerPaths(h)).aliases.read()), { [newKey]: third });
});
