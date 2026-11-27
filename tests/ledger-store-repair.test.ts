import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { clonePaths } from '../tools/ledger/clone.js';
import { setLocationBullet, setLostMark, setStatus } from '../tools/ledger/edit.js';
import { fileStore } from '../tools/ledger/file-store.js';
import { Failure } from '../tools/ledger/failure.js';
import { parseLedger } from '../tools/ledger/format.js';
import { limitLockWaits, withLock } from '../tools/ledger/lock.js';
import { namedMain, places } from '../tools/ledger/migrate-repo-ids.js';
import { openStore } from '../tools/ledger/open-store.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { parseRecord, renderRecord } from '../tools/ledger/record.js';
import { forgetRepoKeys } from '../tools/ledger/repo-key.js';
import { repairStore, type RepairContext, type RepairOptions } from '../tools/ledger/repair.js';
import { sqliteFile } from '../tools/ledger/sqlite-store.js';
import type { LedgerStore } from '../tools/ledger/store.js';
import { REPO } from './helpers.js';
import { archivedTask, asCli, git, home, ledgerText, noSqlite, ok, repoKeyOf, repository, runInProcess, type Ran } from './ledger-core-fixtures.js';
import { APP_KEY, machine, remote, runHere, setUpHere, today } from './ledger-git-fixtures.js';

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

type Run = (cwd: string, ...args: string[]) => Promise<Ran>;

/** Starts `slug` with ledger task new and ledger go; gives its worktree and branch. */
async function start(repair: Run, app: string, slug: string): Promise<{ worktree: string; branch: string }> {
  ok(await repair(app, 'task', 'new', slug, '--goal', `Goal of ${slug}.`));
  ok(await repair(app, 'go', slug));
  const worktree = path.join(app, '.claude/worktrees', slug);
  return { worktree, branch: git(path.dirname(app), worktree, 'branch', '--show-current') };
}

type Listed = { slug: string; status: string; worktree?: string; elsewhere?: boolean; lost?: { date: string } };

const listed = async (repair: Run, cwd: string): Promise<Listed[]> => (JSON.parse(ok(await repair(cwd, 'list', '--json'))) as { tasks: Listed[] }).tasks;

const taskIn = async (repair: Run, cwd: string, slug: string): Promise<Listed> => (await listed(repair, cwd)).find((task) => task.slug === slug) ?? assert.fail(`ledger list has no ${slug}`);

const shown = async (repair: Run, cwd: string, slug: string): Promise<string> => ok(await repair(cwd, 'show', slug));

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

const forStorage = (h: string): Run => (cwd, ...args) => runInProcess(h, cwd, ...args);

test('store repair without a task reports no problems when every recorded folder is there', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  await start(repair, app, 'fix-login');
  const stdout = ok(await repair(app, 'store', 'repair'));
  assert.match(stdout, /No problems found\./);
});

test('store repair reports an active task whose folder is gone, with its repo, folder and branch, and the commands that fix it', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = await start(repair, app, 'fix-login');
  const parked = await start(repair, app, 'on-hold');
  ok(await repair(parked.worktree, 'task', 'park', 'on-hold', '--reason', 'waiting'));
  rmSync(worktree, { recursive: true, force: true });
  rmSync(parked.worktree, { recursive: true, force: true });

  const ran = await repair(app, 'store', 'repair');
  assert.equal(ran.status, 1, ran.stderr);
  const line = ran.stdout.split('\n').find((each) => each.includes('fix-login') && each.includes(worktree)) ?? assert.fail(`no line names fix-login and its folder:\n${ran.stdout}`);
  assert.ok(line.includes('app'), line);
  assert.ok(line.includes(branch), line);
  assert.ok(!ran.stdout.includes('on-hold'), `a parked task is not reported:\n${ran.stdout}`);
  assert.match(ran.stdout, /ledger store repair fix-login\S* --to <folder>/);
  assert.match(ran.stdout, /ledger store repair fix-login\S* --lost/);
  assert.doesNotMatch(ran.stdout, /No problems found/);
});

test('store repair reports a repo key whose main checkout has another key now, and the --remote command for it', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  await start(repair, app, 'fix-login');
  ok(await repair(app, 'task', 'new', 'idea', '--goal', 'Later.'));
  const renamed = path.join(h, 'remotes', 'app-renamed.git');
  git(h, h, 'init', '--quiet', '--bare', '-b', 'main', renamed);
  git(h, app, 'remote', 'set-url', 'origin', renamed);
  const newKey = repoKeyOf(app);
  assert.notEqual(newKey, key);

  const ran = await repair(app, 'store', 'repair');
  assert.equal(ran.status, 1, ran.stderr);
  assert.ok(ran.stdout.includes(`${key} → ${newKey}`), ran.stdout);
  assert.ok(ran.stdout.includes(`ledger store repair --remote ${key}`), ran.stdout);
  assert.ok(!ran.stdout.includes('fix-login'), `its folder is there, so the task is not missing:\n${ran.stdout}`);
});

test('store repair --search lists the linked worktrees of the task repo on its branch in the named folders, 6 levels deep, and changes nothing', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = await start(repair, app, 'fix-login');
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

  const ran = await repair(app, 'store', 'repair', '--search', moved);
  assert.equal(ran.status, 1, ran.stderr);
  const candidates = ran.stdout.split('\n').filter((line) => line.includes(moved)).map((line) => line.trim());
  assert.ok(candidates.some((line) => line.includes(found)), ran.stdout);
  assert.ok(candidates.some((line) => line.includes(deepest)), `a checkout 6 levels down is searched:\n${ran.stdout}`);
  for (const skipped of ['seven', 'node_modules', '.build', 'other', 'link', 'a-clone', 'stranger']) assert.ok(!ran.stdout.includes(path.sep + skipped), `${skipped} is not a candidate:\n${ran.stdout}`);
  assert.equal(fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text, before);
  assert.ok(!worktreeList(h, app).includes(found), 'a search runs no git worktree repair');
});

for (const storage of ['file', 'sqlite'] as const) {
  test(`${storage} store: store repair --search passes by a checkout two active records name, and still reports every other task`, { skip: storage === 'sqlite' && noSqlite }, async (t) => {
    const { h, app, key } = setup(t, storage);
    const repair = forStorage(h);
    const moved = path.join(h, 'moved');
    mkdirSync(moved);
    const fixLogin = await start(repair, app, 'fix-login');
    const claimed = path.join(moved, 'claimed');
    renameSync(fixLogin.worktree, claimed);
    const store = openStore(ledgerPaths(h), storage);
    for (const slug of ['holder-a', 'holder-b']) {
      await start(repair, app, slug);
      store.active.update(key, slug, (text) => setLocationBullet(text, 'worktree', claimed) ?? text);
    }
    const otherTask = await start(repair, app, 'other-task');
    const unowned = path.join(moved, 'unowned');
    renameSync(otherTask.worktree, unowned);

    const ran = await repair(app, 'store', 'repair', '--search', moved);
    assert.equal(ran.status, 1, ran.stderr);
    assert.ok(!ran.stdout.includes(`found ${claimed}`), ran.stdout);
    assert.ok(ran.stdout.includes(`found ${unowned}`), ran.stdout);
    assert.ok(ran.stdout.includes(`--to ${unowned}`), ran.stdout);
  });
}

test('store repair --search fails on a folder that does not exist', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const gone = path.join(h, 'no-such-folder');
  fails(await repair(app, 'store', 'repair', '--search', gone), gone);
});

test('store repair <slug> --to points the task at the folder it moved to, and repairs the git worktree link', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree } = await start(repair, app, 'fix-login');
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(worktree, moved);

  const stdout = ok(await repair(app, 'store', 'repair', 'fix-login', '--to', moved));
  assert.ok(stdout.includes(moved) && stdout.includes(worktree), stdout);
  assert.equal((await taskIn(repair, app, 'fix-login')).worktree, moved);
  assert.ok(worktreeList(h, app).includes(`worktree ${moved}`), worktreeList(h, app));
  assert.match(ok(await repair(app, 'store', 'repair')), /No problems found\./);
  const session = JSON.parse(ok(await repair(moved, 'session', '--json'))) as { ledgers: { slug: string }[] };
  assert.deepEqual(
    session.ledgers.map(({ slug }) => slug),
    ['fix-login'],
  );
});

test('store repair <slug>@<path> --to names the task of the repo at <path> from outside it', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree } = await start(repair, app, 'fix-login');
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(worktree, moved);
  ok(await repair(h, 'store', 'repair', `fix-login@${app}`, '--to', moved));
  assert.equal((await taskIn(repair, app, 'fix-login')).worktree, moved);
});

test('store repair <slug> --to records the new main checkout when the repo moved', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  await start(repair, app, 'fix-login');
  const app2 = path.join(h, 'repos', 'app2');
  renameSync(app, app2);
  const worktree = path.join(app2, '.claude/worktrees/fix-login');
  git(h, app2, 'worktree', 'repair', worktree);
  const stdout = ok(await repair(app2, 'store', 'repair', 'fix-login', '--to', worktree));
  assert.ok(stdout.includes(app2), stdout);
  assert.match(await shown(repair, app2, 'fix-login'), new RegExp(`^- main: ${app2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.equal((await taskIn(repair, app2, 'fix-login')).worktree, worktree);
});

test('store repair <slug> --to --dry-run prints the change and writes nothing', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree } = await start(repair, app, 'fix-login');
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(worktree, moved);
  const before = fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text;

  const stdout = ok(await repair(app, 'store', 'repair', 'fix-login', '--to', moved, '--dry-run'));
  assert.match(stdout, /[Ww]ould/);
  assert.ok(stdout.includes(moved), stdout);
  assert.equal(fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text, before);
  assert.ok(!worktreeList(h, app).includes(moved), 'a dry run runs no git worktree repair');
});

test('store repair <slug> --to refuses, writing nothing, a task that is not active, a missing folder, no checkout, a taken folder and another branch', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree } = await start(repair, app, 'fix-login');
  const other = await start(repair, app, 'other-task');
  ok(await repair(app, 'task', 'new', 'idea', '--goal', 'Later.'));
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(worktree, moved);
  const plain = path.join(h, 'plain');
  mkdirSync(plain);
  const elsewhere = path.join(h, 'elsewhere');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'unrelated', elsewhere, 'main');
  const before = fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text;
  const list = worktreeList(h, app);

  fails(await repair(app, 'store', 'repair', 'idea', '--to', moved), /idea.*not an active task|no active task.*idea/i);
  fails(await repair(app, 'store', 'repair', 'fix-login', '--to', path.join(h, 'nowhere')), /does not exist/);
  fails(await repair(app, 'store', 'repair', 'fix-login', '--to', plain), /not a git checkout/);
  fails(await repair(app, 'store', 'repair', 'fix-login', '--to', other.worktree), /other-task/);
  fails(await repair(app, 'store', 'repair', 'fix-login', '--to', elsewhere), /branch/);
  assert.equal(fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text, before);
  assert.equal(worktreeList(h, app), list);
});

test('store repair <slug> --to refuses, with one line, a main checkout and a checkout of another repo on the task branch', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = await start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  const clone = cloneOn(h, app, path.join(h, 'app-clone'), branch);
  const lib = repository(h, path.join(h, 'repos', 'lib'));
  const stranger = worktreeAt(h, lib, path.join(h, 'lib-worktree'), 'main');
  git(h, stranger, 'checkout', '--quiet', '-b', branch);
  const before = fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text;

  const main = fails(await repair(app, 'store', 'repair', 'fix-login', '--to', clone), /main checkout/);
  const other = fails(await repair(app, 'store', 'repair', 'fix-login', '--to', stranger), new RegExp(repoKeyOf(lib).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const message of [main, other]) assert.equal(message.trim().split('\n').length, 1, message);
  assert.equal(fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text, before);
});

test('store repair <slug> --to takes a checkout whose repo key is an alias of the task key', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = await start(repair, app, 'fix-login');
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

  fails(await repair(app, 'store', 'repair', 'fix-login', '--to', moved), oldKey);
  assert.match((await repair(app, 'store', 'repair', '--search', path.dirname(moved))).stdout, /no checkout on/);
  fileStore(ledgerPaths(h)).aliases.add(oldKey, key);
  assert.match((await repair(app, 'store', 'repair', '--search', path.dirname(moved))).stdout, new RegExp(`found ${moved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  ok(await repair(app, 'store', 'repair', 'fix-login', '--to', moved));
  assert.equal((await taskIn(repair, app, 'fix-login')).worktree, moved);
});

test('store repair <slug> --lost marks the task lost: ledger list shows it, the report and session start pass it by', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree } = await start(repair, app, 'fix-login');
  await start(repair, app, 'still-here');
  rmSync(worktree, { recursive: true, force: true });

  ok(await repair(app, 'store', 'repair', 'fix-login', '--lost'));
  assert.ok((await shown(repair, app, 'fix-login')).includes(`lost: ${today()} — folder ${worktree} not found`), await shown(repair, app, 'fix-login'));
  const task = await taskIn(repair, app, 'fix-login');
  assert.equal(task.status, 'lost');
  assert.deepEqual(task.lost, { date: today() });
  const list = ok(await repair(app, 'list'));
  assert.match(list, /1 lost/);
  assert.match(list.split('\n').find((line) => line.includes('fix-login')) ?? '', /\blost\b(?!\*)/);
  assert.match(ok(await repair(app, 'store', 'repair')), /No problems found\./);

  git(h, app, 'worktree', 'prune');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'again', worktree, 'main');
  const own = JSON.parse(ok(await repair(worktree, 'session', '--json'))) as { ledgers: { slug: string }[] };
  assert.deepEqual(own.ledgers, [], 'a lost task is no folder’s task');
  const main = JSON.parse(ok(await repair(app, 'session', '--json'))) as { ledgers: { slug: string }[] };
  assert.deepEqual(
    main.ledgers.map(({ slug }) => slug),
    ['still-here'],
  );
});

test('store repair <slug> --lost refuses a task whose folder is there, and --dry-run writes nothing', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree } = await start(repair, app, 'fix-login');
  const before = fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text;
  fails(await repair(app, 'store', 'repair', 'fix-login', '--lost'), worktree);
  rmSync(worktree, { recursive: true, force: true });
  const stdout = ok(await repair(app, 'store', 'repair', 'fix-login', '--lost', '--dry-run'));
  assert.match(stdout, /[Ww]ould/);
  assert.equal(fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text, before);
  assert.equal((await taskIn(repair, app, 'fix-login')).status, 'active');
});

/** A repo whose origin was renamed after it had an active task, a backlog task and an archive copy. */
async function renamedRemote(t: TestContext) {
  const world = setup(t);
  const { h, app } = world;
  const repair = forStorage(h);
  await start(repair, app, 'fix-login');
  ok(await repair(app, 'task', 'new', 'idea', '--goal', 'Later.'));
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

test('store repair --remote files every task of the old key under the current key and keeps the old key as an alias', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  ok(await repair(app, 'store', 'repair', '--remote', key));
  assert.deepEqual(filed(h, newKey), { active: ['fix-login'], backlog: ['idea'], archive: ['2026-01-02-done-one'] });
  assert.deepEqual(filed(h, key), { active: [], backlog: [], archive: [] });
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get(key), newKey);
  assert.match(ok(await repair(app, 'store', 'repair')), /No problems found\./);
});

test('store repair --remote --dry-run prints the moves and writes nothing', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  const stdout = ok(await repair(app, 'store', 'repair', '--remote', key, '--dry-run'));
  assert.match(stdout, /would/);
  assert.ok(stdout.includes('idea') && stdout.includes('fix-login') && stdout.includes('done-one'), stdout);
  assert.deepEqual(filed(h, key), { active: ['fix-login'], backlog: ['idea'], archive: ['2026-01-02-done-one'] });
  assert.deepEqual(filed(h, newKey), { active: [], backlog: [], archive: [] });
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get(key), undefined);
});

test('store repair --remote leaves a task whose slug the current key has, lists it, and exits 1', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  ok(await repair(app, 'task', 'new', 'idea', '--goal', 'Again.'));
  const ran = await repair(app, 'store', 'repair', '--remote', key);
  assert.equal(ran.status, 1, ran.stderr);
  assert.match(ran.stdout, /idea/);
  assert.deepEqual(filed(h, key), { active: [], backlog: ['idea'], archive: [] });
  assert.deepEqual(filed(h, newKey), { active: ['fix-login'], backlog: ['idea'], archive: ['2026-01-02-done-one'] });
  assert.match(readFileSync(fileStore(ledgerPaths(h)).backlog.read(key, 'idea')?.location ?? assert.fail('the old idea is gone'), 'utf8'), /Later\./);
});

test('store repair --remote re-points each alias of the old key to the current key; --dry-run only shows it', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  fileStore(ledgerPaths(h)).aliases.add('app-folder', key);
  const dry = ok(await repair(app, 'store', 'repair', '--remote', key, '--dry-run'));
  assert.match(dry, /app-folder/);
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get('app-folder'), key);
  const stdout = ok(await repair(app, 'store', 'repair', '--remote', key));
  assert.match(stdout, /app-folder/);
  const aliases = fileStore(ledgerPaths(h)).aliases.read();
  assert.equal(aliases.get('app-folder'), newKey);
  assert.equal(aliases.get(key), newKey);
});

test('store repair --remote re-points no alias while a conflict keeps tasks under the old key', async (t) => {
  const { h, app, key, repair } = await renamedRemote(t);
  fileStore(ledgerPaths(h)).aliases.add('app-folder', key);
  ok(await repair(app, 'task', 'new', 'idea', '--goal', 'Again.'));
  assert.equal((await repair(app, 'store', 'repair', '--remote', key)).status, 1);
  const aliases = fileStore(ledgerPaths(h)).aliases.read();
  assert.equal(aliases.get('app-folder'), key);
  assert.equal(aliases.get(key), undefined);
});

test('store repair --remote fails for a key that has no task', async (t) => {
  const { h, app } = setup(t);
  fails(await runInProcess(h, app, 'store', 'repair', '--remote', 'github.com/nobody/nothing'), 'github.com/nobody/nothing');
});

test('store repair refuses each bad combination of options with one line', async (t) => {
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
    const ran = await runInProcess(h, app, 'store', 'repair', ...args);
    assert.notEqual(ran.status, 0, `${args.join(' ')} passed:\n${ran.stdout}`);
    assert.equal(ran.stderr.trim().split('\n').length, 1, `${args.join(' ')}:\n${ran.stderr}`);
    assert.match(ran.stderr, error, args.join(' '));
  }
});

test('sqlite store: store repair reports a missing folder, --to points the task at its new folder, and --lost marks one lost', { skip: noSqlite }, async (t) => {
  const { h, app } = setup(t, 'sqlite');
  const repair = forStorage(h);
  const moving = await start(repair, app, 'fix-login');
  const losing = await start(repair, app, 'gone-for-good');
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(moving.worktree, moved);
  rmSync(losing.worktree, { recursive: true, force: true });

  const report = await repair(app, 'store', 'repair');
  assert.equal(report.status, 1, report.stderr);
  assert.ok(report.stdout.includes(moving.worktree) && report.stdout.includes(losing.worktree), report.stdout);
  ok(await repair(app, 'store', 'repair', 'fix-login', '--to', moved));
  ok(await repair(app, 'store', 'repair', 'gone-for-good', '--lost'));
  assert.equal((await taskIn(repair, app, 'fix-login')).worktree, moved);
  assert.equal((await taskIn(repair, app, 'gone-for-good')).status, 'lost');
  assert.match(ok(await repair(app, 'store', 'repair')), /No problems found\./);
  assert.equal(existsSync(path.join(h, '.claude/ledger-active')), false, 'the SQLite store made ~/.claude/ledger-active');
});

test('git store: store repair --to and --lost write the record and commit it', async (t) => {
  const m = machine(t, remote(t));
  await setUpHere(m);
  const repair: Run = (cwd, ...args) => runHere(m, args, { cwd });
  const moving = await start(repair, m.app, 'fix-login');
  const losing = await start(repair, m.app, 'gone-for-good');
  const moved = path.join(m.h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(moving.worktree, moved);
  rmSync(losing.worktree, { recursive: true, force: true });

  ok(await repair(m.app, 'store', 'repair', 'fix-login', '--to', moved));
  ok(await repair(m.app, 'store', 'repair', 'gone-for-good', '--lost'));
  assert.equal((await taskIn(repair, m.app, 'fix-login')).worktree, moved);
  assert.equal((await taskIn(repair, m.app, 'gone-for-good')).status, 'lost');
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

test('git store: aliases.replace removes and adds aliases in one write, and changes nothing when it refuses an alias', async (t) => {
  const m = machine(t, remote(t));
  await setUpHere(m);
  replacesAliases(openStore(ledgerPaths(m.h), 'git', { backgroundSync: false }));
});

test('store repair --remote back to the key a repo was renamed from leaves one alias, not a cycle', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  ok(await repair(app, 'store', 'repair', '--remote', key));
  git(h, app, 'remote', 'set-url', 'origin', path.join(h, 'remotes', 'app.git'));
  assert.equal(repoKeyOf(app), key);

  ok(await repair(app, 'store', 'repair', '--remote', newKey));
  assert.deepEqual(Object.fromEntries(fileStore(ledgerPaths(h)).aliases.read()), { [newKey]: key });
  assert.deepEqual(filed(h, key), { active: ['fix-login'], backlog: ['idea'], archive: ['2026-01-02-done-one'] });
  assert.match(ok(await repair(app, 'store', 'repair')), /No problems found\./);
});

for (const storage of ['file', 'sqlite'] as const) {
  test(`${storage} store: a lost task does not hold its old folder, so ledger task new --here starts a task in a new worktree there`, { skip: storage === 'sqlite' && noSqlite }, async (t) => {
    const { h, app } = setup(t, storage);
    const repair = forStorage(h);
    const { worktree } = await start(repair, app, 'fix-login');
    rmSync(worktree, { recursive: true, force: true });
    ok(await repair(app, 'store', 'repair', 'fix-login', '--lost'));
    git(h, app, 'worktree', 'prune');
    git(h, app, 'worktree', 'add', '--quiet', '-b', 'again', worktree, 'main');

    ok(await repair(worktree, 'task', 'new', '--here', 'second-try', '--goal', 'Again.'));
    assert.equal((await taskIn(repair, app, 'second-try')).worktree, worktree);
    assert.equal((await taskIn(repair, app, 'fix-login')).status, 'lost');
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
async function refilesRenamed(repair: Run, app: string, key: string, newKey: string, filedUnder: (key: string) => ReturnType<typeof filedIn>): Promise<void> {
  const report = await repair(app, 'store', 'repair');
  assert.equal(report.status, 1, report.stderr);
  assert.ok(report.stdout.includes(`${key} → ${newKey}`), report.stdout);
  assert.ok(report.stdout.includes(`ledger store repair --remote ${key}`), report.stdout);
  ok(await repair(app, 'store', 'repair', '--remote', key));
  assert.deepEqual(filedUnder(newKey), { active: ['fix-login'], backlog: ['idea'], archive: [] });
  assert.deepEqual(filedUnder(key), { active: [], backlog: [], archive: [] });
  assert.match(ok(await repair(app, 'store', 'repair')), /No problems found\./);
}

test('sqlite store: store repair reports a renamed remote, and --remote files its tasks under the new key with an alias', { skip: noSqlite }, async (t) => {
  const { h, app, key } = setup(t, 'sqlite');
  const repair = forStorage(h);
  await start(repair, app, 'fix-login');
  ok(await repair(app, 'task', 'new', 'idea', '--goal', 'Later.'));
  const newKey = renameOrigin(h, app);
  const store = () => openStore(ledgerPaths(h), 'sqlite');
  await refilesRenamed(repair, app, key, newKey, (repo) => filedIn(store(), repo));
  const opened = store();
  assert.equal(opened.aliases.read().get(key), newKey);
  opened.close?.();
});

test('git store: store repair reports a renamed remote, and --remote files its tasks under the new key and commits them', async (t) => {
  const m = machine(t, remote(t));
  await setUpHere(m);
  const repair: Run = (cwd, ...args) => runHere(m, args, { cwd });
  await start(repair, m.app, 'fix-login');
  ok(await repair(m.app, 'task', 'new', 'idea', '--goal', 'Later.'));
  const newKey = renameOrigin(m.h, m.app);
  const store = () => openStore(ledgerPaths(m.h), 'git', { backgroundSync: false, readOnly: true });
  await refilesRenamed(repair, m.app, APP_KEY, newKey, (repo) => filedIn(store(), repo));
  assert.equal(store().aliases.read().get(APP_KEY), newKey);
  assert.equal(git(m.h, m.clone, 'status', '--porcelain'), '', 'the clone has changes no commit holds');
  assert.ok(git(m.h, m.clone, 'ls-files').includes(`${encodeURIComponent(newKey)}/fix-login.json`), 'no committed record of fix-login under the new key');
});

test('store repair quotes the paths in the commands it prints, so they run in a shell', async (t) => {
  const h = home(t);
  copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
  const app = repository(h, path.join(h, 'my repos', 'app'));
  writeFileSync(path.join(app, '.git/info/exclude'), '.claude/\n');
  const key = repoKeyOf(app);
  const repair = forStorage(h);
  const { worktree, branch } = await start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  git(h, app, 'worktree', 'prune');
  const moved = worktreeAt(h, app, path.join(h, 'moved here', 'fix-login'), branch);

  const found = await repair(app, 'store', 'repair', '--search', path.dirname(moved));
  assert.ok(found.stdout.includes(`ledger store repair 'fix-login@${app}' --to '${moved}'`), found.stdout);
  assert.ok(found.stdout.includes(`ledger store repair 'fix-login@${app}' --lost`), found.stdout);
  const dry = ok(await repair(app, 'store', 'repair', 'fix-login', '--to', moved, '--dry-run'));
  assert.ok(dry.includes(`git -C '${app}' worktree repair '${moved}'`), dry);
  const newKey = renameOrigin(h, app);
  assert.notEqual(newKey, key);
  const renamed = await repair(app, 'store', 'repair');
  assert.ok(renamed.stdout.includes(`cd '${app}' && ledger store repair --remote ${key}`), renamed.stdout);
});

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('ledger task retire of a lost task removes no worktree, also with --force, though another task lives at its old path now', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree } = await start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  ok(await repair(app, 'store', 'repair', 'fix-login', '--lost'));
  git(h, app, 'worktree', 'prune');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'again', worktree, 'main');
  ok(await repair(worktree, 'task', 'new', '--here', 'second-try', '--goal', 'Again.'));
  const work = path.join(worktree, 'work.txt');
  writeFileSync(work, 'uncommitted work of second-try');

  await repair(app, 'task', 'retire', 'fix-login');
  assert.ok(existsSync(work), 'a retire without --force removed the worktree of second-try');
  await repair(app, 'task', 'retire', 'fix-login', '--force');
  assert.ok(existsSync(work), 'a retire with --force removed the worktree of second-try');
  assert.equal((await taskIn(repair, app, 'second-try')).worktree, worktree);
  assert.ok(filed(h, key).archive.some((name) => name.endsWith('-fix-login')), `fix-login is not archived: ${JSON.stringify(filed(h, key))}`);
  assert.ok(!filed(h, key).active.includes('fix-login'), 'fix-login is still active');
});

test('store repair --remote leaves a task whose main checkout is gone or has a third key, as it is, lists it, writes no alias, and exits 1', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  await start(repair, app, 'fix-login');
  ok(await repair(app, 'task', 'new', 'idea', '--goal', 'Later.'));
  const gone = cloneOn(h, app, path.join(h, 'repos', 'app-gone'), 'side');
  ok(await repair(gone, 'task', 'new', 'orphan', '--goal', 'Kept.'));
  const third = cloneOn(h, app, path.join(h, 'repos', 'app-third'), 'side');
  ok(await repair(third, 'task', 'new', 'stranger', '--goal', 'Kept.'));
  const texts = () => ['orphan', 'stranger'].map((slug) => fileStore(ledgerPaths(h)).backlog.read(key, slug)?.text);
  const before = texts();
  const newKey = renameOrigin(h, app);
  rmSync(gone, { recursive: true, force: true });
  const thirdUrl = path.join(h, 'remotes', 'third.git');
  git(h, h, 'init', '--quiet', '--bare', '-b', 'main', thirdUrl);
  git(h, third, 'remote', 'set-url', 'origin', thirdUrl);

  const ran = await repair(app, 'store', 'repair', '--remote', key);
  assert.equal(ran.status, 1, ran.stderr);
  assert.match(ran.stdout, /orphan/);
  assert.match(ran.stdout, /stranger/);
  assert.deepEqual(filed(h, key), { active: [], backlog: ['orphan', 'stranger'], archive: [] });
  assert.deepEqual(filed(h, newKey), { active: ['fix-login'], backlog: ['idea'], archive: [] });
  assert.deepEqual(texts(), before, 'a record left under the old key changed');
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get(key), undefined);
});

test('git store: store repair --remote exits 1 and says to run ledger store sync when the store commit fails, keeps the alias, and so does a rerun while the commit still fails', async (t) => {
  const m = machine(t, remote(t));
  await setUpHere(m);
  const repair: Run = (cwd, ...args) => runHere(m, args, { cwd });
  await start(repair, m.app, 'fix-login');
  const newKey = renameOrigin(m.h, m.app);
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

  const ran = await repair(m.app, 'store', 'repair', '--remote', APP_KEY);
  assert.equal(ran.status, 1, ran.stdout);
  assert.match(ran.stderr, /store commit failed/i);
  assert.ok(ran.stderr.includes(APP_KEY), ran.stderr);
  assert.match(ran.stderr, /Fix the problem below, then run ledger store sync\./);
  assert.doesNotMatch(ran.stdout, /^Moved /m);
  assert.deepEqual(aliases(), { [APP_KEY]: newKey });
  const again = await repair(m.app, 'store', 'repair', '--remote', APP_KEY);
  assert.equal(again.status, 1, `${again.stdout}${again.stderr}`);
  assert.ok(again.stdout.includes(`Nothing is left under ${APP_KEY} to move.`), again.stdout);
  assert.match(again.stderr, /Fix the problem below, then run ledger store sync\./);
});

test('store repair --remote leaves a task whose slug any place of the current key has, active too', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  await start(repair, app, 'idea');
  const ran = await repair(app, 'store', 'repair', '--remote', key);
  assert.equal(ran.status, 1, ran.stderr);
  assert.match(ran.stdout, /left backlog idea/);
  assert.deepEqual(filed(h, key), { active: [], backlog: ['idea'], archive: [] });
  assert.deepEqual(filed(h, newKey), { active: ['fix-login', 'idea'], backlog: [], archive: ['2026-01-02-done-one'] });
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get(key), undefined);
});

test('sqlite store: the report and --search find no problems before the database exists, and they, each --dry-run and each refusal make no database', { skip: noSqlite }, async (t) => {
  const { h, app } = setup(t, 'sqlite');
  for (const args of [[], ['--search', h]]) {
    assert.match(ok(await runInProcess(h, app, 'store', 'repair', ...args)), /No problems found\./);
  }
  fails(await runInProcess(h, app, 'store', 'repair', '--search', path.join(h, 'nowhere')), path.join(h, 'nowhere'));
  const refused = [['fix-login', '--to', h], ['fix-login', '--lost'], ['--remote', 'github.com/me/old']];
  for (const args of [[], ['--search', h], ['fix-login', '--to', h, '--dry-run'], ['fix-login', '--lost', '--dry-run'], ['--remote', 'github.com/me/old', '--dry-run'], ...refused]) {
    await runInProcess(h, app, 'store', 'repair', ...args);
    assert.equal(existsSync(sqliteFile(h)), false, `store repair ${args.join(' ')} made ${sqliteFile(h)}`);
  }
  for (const args of refused) assert.notEqual((await runInProcess(h, app, 'store', 'repair', ...args)).status, 0, `store repair ${args.join(' ')} did not refuse`);
});

test('git store: the report, --search, each --dry-run and each refusal put back no pre-push hook and commit nothing', async (t) => {
  const m = machine(t, remote(t));
  await setUpHere(m);
  const repair: Run = (cwd, ...args) => runHere(m, args, { cwd });
  const { worktree } = await start(repair, m.app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  const hook = path.join(m.clone, '.git', 'hooks', 'pre-push');
  rmSync(hook);
  const head = git(m.h, m.clone, 'rev-parse', 'HEAD');
  for (const args of [[], ['--search', m.h], ['fix-login', '--to', m.h, '--dry-run'], ['fix-login', '--lost', '--dry-run'], ['--remote', 'github.com/me/old', '--dry-run'], ['fix-login', '--to', m.h], ['--remote', 'github.com/me/old']]) {
    await repair(m.app, 'store', 'repair', ...args);
    assert.equal(existsSync(hook), false, `store repair ${args.join(' ')} put back the pre-push hook`);
    assert.equal(git(m.h, m.clone, 'rev-parse', 'HEAD'), head, `store repair ${args.join(' ')} committed`);
  }
});

test('store repair, after --to took a checkout through an alias, reports no rename and counts the task as this machine’s', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = await start(repair, app, 'fix-login');
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
  ok(await repair(app, 'store', 'repair', 'fix-login', '--to', moved));

  assert.match(ok(await repair(app, 'store', 'repair')), /No problems found\./);
  assert.equal((await taskIn(repair, app, 'fix-login')).elsewhere, undefined);
});

test('store repair reports a renamed remote for a clone whose key changed, while another clone still has the old key', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  ok(await repair(app, 'task', 'new', 'idea', '--goal', 'Later.'));
  const other = cloneOn(h, app, path.join(h, 'repos', 'app-b'), 'side');
  ok(await repair(other, 'task', 'new', 'other-idea', '--goal', 'Later.'));
  const newKey = renameOrigin(h, app);

  const ran = await repair(app, 'store', 'repair');
  assert.equal(ran.status, 1, ran.stderr);
  assert.ok(ran.stdout.includes(`${key} → ${newKey}`), ran.stdout);
});

test('store repair, run from a main checkout that moved, prints fix commands that run', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  await start(repair, app, 'fix-login');
  const app2 = path.join(h, 'repos', 'app2');
  renameSync(app, app2);

  const ran = await repair(app2, 'store', 'repair');
  assert.equal(ran.status, 1, ran.stderr);
  assert.ok(!ran.stdout.includes(`fix-login@${app} `), ran.stdout);
  const lost = new RegExp(`ledger store repair (fix-login@${escaped(app2)}) --lost`).exec(ran.stdout) ?? assert.fail(`no --lost command names ${app2}:\n${ran.stdout}`);
  ok(await repair(h, 'store', 'repair', lost[1], '--lost'));
  assert.equal((await taskIn(repair, app2, 'fix-login')).status, 'lost');
});

test('store repair <slug> --to refuses a parked task', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree } = await start(repair, app, 'fix-login');
  ok(await repair(worktree, 'task', 'park', 'fix-login', '--reason', 'waiting'));
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(worktree, moved);
  const before = fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text;
  fails(await repair(app, 'store', 'repair', 'fix-login', '--to', moved), /parked/);
  assert.equal(fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text, before);
});

test('store repair <slug> --lost refuses a task marked lost whose folder is back', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree } = await start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  ok(await repair(app, 'store', 'repair', 'fix-login', '--lost'));
  mkdirSync(worktree, { recursive: true });
  fails(await repair(app, 'store', 'repair', 'fix-login', '--lost'), worktree);
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

test('store repair --remote leaves a ledger whose title has the slug of a live task of the current key, though its name differs', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  await start(repair, app, 'fix');
  const store = fileStore(ledgerPaths(h));
  const idea = store.backlog.read(key, 'idea')?.text ?? assert.fail('no backlog idea');
  store.backlog.write(key, 'legacy', idea.replace(/^# Task ledger — idea$/m, '# Task ledger — fix'));

  const ran = await repair(app, 'store', 'repair', '--remote', key);
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
async function reusedPath(t: TestContext) {
  const world = setup(t);
  const { h, app } = world;
  const repair = forStorage(h);
  const { worktree } = await start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  ok(await repair(app, 'store', 'repair', 'fix-login', '--lost'));
  git(h, app, 'worktree', 'prune');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'again', worktree, 'main');
  ok(await repair(worktree, 'task', 'new', '--here', 'second-try', '--goal', 'Again.'));
  return { ...world, repair, worktree };
}

test('ledger task retire without a slug, in the worktree that took a lost task’s old path, picks the task of that worktree', async (t) => {
  const { repair, worktree } = await reusedPath(t);
  const ran = await repair(worktree, 'task', 'retire');
  assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
  assert.doesNotMatch(ran.stderr, /active tasks name the worktree/);
  assert.ok(`${ran.stdout}${ran.stderr}`.includes('second-try'), `${ran.stdout}${ran.stderr}`);
});

test('ledger task retire of a lost task says it is lost, not that it may be live on another machine', async (t) => {
  const { app, repair } = await reusedPath(t);
  const ran = await repair(app, 'task', 'retire', 'fix-login');
  const output = `${ran.stdout}${ran.stderr}`;
  assert.match(output, /lost/);
  assert.doesNotMatch(output, /another machine/);
});

test('a clone that still has the old key of an alias sees the task --to pointed at a worktree of it, in its main session and by name', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = await start(repair, app, 'fix-login');
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
  ok(await repair(app, 'store', 'repair', 'fix-login', '--to', moved));

  assert.ok(ok(await repair(oldClone, 'session')).split('\n').includes(moved), 'the main session of the old-key clone lacks fix-login');
  const retire = await repair(oldClone, 'task', 'retire', 'fix-login', '--dry-run', '--json');
  assert.equal(retire.status, 0, `${retire.stdout}${retire.stderr}`);
  assert.equal((JSON.parse(retire.stdout) as { ok: boolean }).ok, true, retire.stdout);
  assert.ok(retire.stdout.includes(moved), retire.stdout);
});

test('store repair --search, run outside the repo after its main checkout moved, prints a --to command for the one checkout it found, and that command runs', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree } = await start(repair, app, 'fix-login');
  const app2 = path.join(h, 'repos', 'app2');
  renameSync(app, app2);
  const moved = path.join(app2, path.relative(app, worktree));
  git(h, app2, 'worktree', 'repair', moved);

  const ran = await repair(h, 'store', 'repair', '--search', app2);
  assert.equal(ran.status, 1, ran.stderr);
  const to = new RegExp(`ledger store repair (fix-login@${escaped(app2)}) --to (${escaped(moved)})$`, 'm').exec(ran.stdout) ?? assert.fail(`no --to command names ${app2} and ${moved}:\n${ran.stdout}`);
  ok(await repair(h, 'store', 'repair', to[1], '--to', to[2]));
  assert.equal((await taskIn(repair, app2, 'fix-login')).worktree, moved);
});

test('store repair <slug> --lost refuses a parked task, and --to refuses a parked task that is marked lost', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree } = await start(repair, app, 'fix-login');
  ok(await repair(worktree, 'task', 'park', 'fix-login', '--reason', 'waiting'));
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(worktree, moved);
  const store = fileStore(ledgerPaths(h));
  const text = () => store.active.read(key, 'fix-login')?.text;
  const parked = text();
  fails(await repair(app, 'store', 'repair', 'fix-login', '--lost'), /parked/);
  assert.equal(text(), parked);

  store.active.update(key, 'fix-login', (each) => setLocationBullet(each, 'lost', `2026-01-02 — folder ${worktree} not found`));
  assert.equal((await taskIn(repair, app, 'fix-login')).status, 'lost');
  const marked = text();
  fails(await repair(app, 'store', 'repair', 'fix-login', '--to', moved), /parked/);
  assert.equal(text(), marked);
});

test('store repair <slug> --lost refuses a blocked, waiting or done task, names its state, and writes nothing', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree } = await start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  const store = fileStore(ledgerPaths(h));
  const text = () => store.active.read(key, 'fix-login')?.text;
  for (const [status, message] of [
    [{ value: 'blocked', date: '2026-11-20', detail: 'the API' }, /fix-login is blocked, so it cannot become lost\. A blocked task can become active\./],
    [{ value: 'waiting', date: '2026-11-20' }, /fix-login is waiting, so it cannot become lost\. A waiting task can become active or done\./],
    [{ value: 'done', date: '2026-11-20' }, /fix-login is done, so it cannot become lost\. Finalize it with the question from `ledger task gate finalize fix-login`\./],
  ] as const) {
    store.active.update(key, 'fix-login', (each) => setStatus(each, status));
    const before = text();
    fails(await repair(app, 'store', 'repair', 'fix-login', '--lost'), message);
    assert.equal(text(), before);
  }
});

test('store repair reports a blocked, waiting or done task whose folder is gone with --to only, as --lost refuses it; a parked one not at all', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const store = fileStore(ledgerPaths(h));
  const gone = async (slug: string): Promise<void> => rmSync((await start(repair, app, slug)).worktree, { recursive: true, force: true });
  await gone('fix-login');
  for (const [slug, status] of [
    ['held', { value: 'blocked', date: '2026-11-20', detail: 'the API' }],
    ['review', { value: 'waiting', date: '2026-11-20' }],
    ['shipped', { value: 'done', date: '2026-11-20' }],
    ['resting', { value: 'parked', date: '2026-11-20', detail: 'later' }],
  ] as const) {
    await gone(slug);
    store.active.update(key, slug, (each) => setStatus(each, status));
  }

  const ran = await repair(app, 'store', 'repair');
  assert.equal(ran.status, 1, ran.stderr);
  assert.match(ran.stdout, /ledger store repair fix-login\S* --to <folder>/);
  assert.match(ran.stdout, /ledger store repair fix-login\S* --lost/);
  for (const slug of ['held', 'review', 'shipped']) {
    assert.match(ran.stdout, new RegExp(`ledger store repair ${slug}\\S* --to <folder>`));
    assert.doesNotMatch(ran.stdout, new RegExp(`ledger store repair ${slug}\\S* --lost`));
  }
  assert.ok(!ran.stdout.includes('resting'), `a parked task is not reported:\n${ran.stdout}`);
});

test('store repair <slug> --to of a lost task with a status line removes the lost mark and keeps the status line', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree } = await start(repair, app, 'fix-login');
  ok(await repair(worktree, 'task', 'block', 'fix-login', '--on', 'the API'));
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(worktree, moved);
  const store = fileStore(ledgerPaths(h));
  store.active.update(key, 'fix-login', (each) => setLocationBullet(each, 'lost', `2026-01-02 — folder ${worktree} not found`));
  assert.equal((await taskIn(repair, app, 'fix-login')).status, 'lost');

  ok(await repair(app, 'store', 'repair', 'fix-login', '--to', moved));
  const text = store.active.read(key, 'fix-login')?.text ?? assert.fail('the record is gone');
  assert.equal(parseLedger(text).location.lost, undefined);
  assert.match(text, new RegExp(`^- status: blocked ${today()} — the API$`, 'm'));
  assert.equal((await taskIn(repair, app, 'fix-login')).status, 'blocked');
});

test('store repair <slug> --to refuses to make a lost code task waiting without a PR link; with a link, or as a docs task, it repairs', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const store = fileStore(ledgerPaths(h));
  const lostWaiting = async (slug: string, ...bullets: [string, string][]): Promise<string> => {
    const { worktree } = await start(repair, app, slug);
    const moved = path.join(h, 'moved', slug);
    mkdirSync(path.dirname(moved), { recursive: true });
    renameSync(worktree, moved);
    store.active.update(key, slug, (text) =>
      [['lost', `2026-01-02 — folder ${worktree} not found`], ...bullets].reduce((each, [name, value]) => setLocationBullet(each, name, value) ?? each, setStatus(text, { value: 'waiting', date: '2026-01-01' }) ?? text),
    );
    return moved;
  };

  const bare = await lostWaiting('bare');
  const before = store.active.read(key, 'bare')?.text;
  fails(await repair(app, 'store', 'repair', 'bare', '--to', bare), 'bare is a code task without a PR link, so it cannot become waiting. Record the link first: ledger task pr <url>');
  assert.equal(store.active.read(key, 'bare')?.text, before);

  const linked = await lostWaiting('linked', ['pr', 'https://github.com/acme/app/pull/7']);
  ok(await repair(app, 'store', 'repair', 'linked', '--to', linked));
  assert.equal((await taskIn(repair, app, 'linked')).status, 'waiting');

  const docs = await lostWaiting('docs', ['kind', 'docs']);
  ok(await repair(app, 'store', 'repair', 'docs', '--to', docs));
  assert.equal((await taskIn(repair, app, 'docs')).status, 'waiting');
});

test('store repair --remote moves a ledger that names no main checkout when the old key is an alias of this repo already', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  const store = fileStore(ledgerPaths(h));
  store.backlog.write(key, 'no-main', ledgerText({ slug: 'no-main' }));
  store.aliases.add(key, newKey);

  ok(await repair(app, 'store', 'repair', '--remote', key));
  assert.deepEqual(filed(h, key), { active: [], backlog: [], archive: [] });
  assert.ok(filed(h, newKey).backlog.includes('no-main'), JSON.stringify(filed(h, newKey)));
});

test('store repair --remote, run in the main checkout, leaves a ledger whose main line is . and says its main is relative', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  const store = fileStore(ledgerPaths(h));
  store.backlog.write(key, 'dot', ledgerText({ slug: 'dot', main: '.' }));

  const ran = await repair(app, 'store', 'repair', '--remote', key);
  assert.equal(ran.status, 1, `${ran.stdout}${ran.stderr}`);
  assert.ok(ran.stdout.includes('left backlog dot: its saved main checkout "." is a relative path, so its repo folder cannot be recovered'), ran.stdout);
  assert.ok(filed(h, key).backlog.includes('dot'));
  assert.ok(!filed(h, newKey).backlog.includes('dot'));
});

for (const storage of ['file', 'sqlite'] as const) {
  test(`${storage} store: store repair --to and --lost keep a - lost: note that is no lost mark, and change only the mark`, { skip: storage === 'sqlite' && noSqlite }, async (t) => {
    const { h, app, key } = setup(t, storage);
    const repair = forStorage(h);
    const { worktree, branch } = await start(repair, app, 'fix-login');
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

    ok(await repair(app, 'store', 'repair', 'fix-login', '--to', moved));
    assert.ok((await shown(repair, app, 'fix-login')).includes(note), await shown(repair, app, 'fix-login'));
    assert.equal((await taskIn(repair, app, 'fix-login')).status, 'active');

    rmSync(moved, { recursive: true, force: true });
    ok(await repair(app, 'store', 'repair', 'fix-login', '--lost'));
    const lost = await shown(repair, app, 'fix-login');
    assert.ok(lost.includes(note), lost);
    assert.ok(lost.includes(`- lost: ${today()} — folder ${moved} not found`), lost);
    assert.equal((await taskIn(repair, app, 'fix-login')).status, 'lost');

    git(h, app, 'worktree', 'prune');
    worktreeAt(h, app, moved, branch);
    ok(await repair(app, 'store', 'repair', 'fix-login', '--to', moved));
    const back = await shown(repair, app, 'fix-login');
    assert.ok(back.includes(note), back);
    assert.doesNotMatch(back, /not found/);
    assert.equal((await taskIn(repair, app, 'fix-login')).status, 'active');
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
  test(`${storage} store: store repair --to and --lost keep a - lost: note that names the worktree but lacks the space after the colon`, { skip: storage === 'sqlite' && noSqlite }, async (t) => {
    const { h, app, key } = setup(t, storage);
    const repair = forStorage(h);
    const { worktree } = await start(repair, app, 'fix-login');
    const note = `- lost:2026-01-02 — folder ${worktree} not found`;
    const store = openStore(ledgerPaths(h), storage);
    try {
      store.active.update(key, 'fix-login', (text) => text.replace(/^(- branch: .*)$/m, `$1\n${note}`));
    } finally {
      store.close?.();
    }
    assert.ok((await shown(repair, app, 'fix-login')).includes(note), await shown(repair, app, 'fix-login'));
    assert.equal((await taskIn(repair, app, 'fix-login')).status, 'active');
    const moved = path.join(h, 'moved', 'fix-login');
    mkdirSync(path.dirname(moved), { recursive: true });
    renameSync(worktree, moved);

    ok(await repair(app, 'store', 'repair', 'fix-login', '--to', moved));
    assert.ok((await shown(repair, app, 'fix-login')).includes(note), await shown(repair, app, 'fix-login'));
    rmSync(moved, { recursive: true, force: true });
    ok(await repair(app, 'store', 'repair', 'fix-login', '--lost'));
    const lost = await shown(repair, app, 'fix-login');
    assert.ok(lost.includes(note), lost);
    assert.ok(lost.includes(`- lost: ${today()} — folder ${moved} not found`), lost);
  });
}

test('store repair --remote refuses, moving nothing, when an alias of the old key files a task whose slug the current key has', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  await start(repair, app, 'fix');
  const store = fileStore(ledgerPaths(h));
  store.backlog.write('app-folder', 'fix', ledgerText({ slug: 'fix', main: app }));
  store.aliases.add('app-folder', key);
  const before = { old: filed(h, key), now: filed(h, newKey), alias: filed(h, 'app-folder') };
  const fixes = async () => (await listed(repair, app)).filter(({ slug }) => slug === 'fix').map(({ status }) => status).sort();
  assert.deepEqual(await fixes(), ['active', 'backlog']);

  for (const args of [['--dry-run'], []]) {
    const ran = await repair(app, 'store', 'repair', '--remote', key, ...args);
    assert.equal(ran.status, 1, `${ran.stdout}${ran.stderr}`);
    assert.match(ran.stderr, /app-folder/);
    assert.match(ran.stderr, /\bfix\b/);
    assert.match(ran.stderr, /nothing was moved/);
  }
  assert.deepEqual({ old: filed(h, key), now: filed(h, newKey), alias: filed(h, 'app-folder') }, before);
  assert.deepEqual(Object.fromEntries(fileStore(ledgerPaths(h)).aliases.read()), { 'app-folder': key });
  assert.deepEqual(await fixes(), ['active', 'backlog']);
});

/** The moved-main world of the --search tests: app renamed to app2, with fix-login's worktree repaired in it. */
async function movedMain(t: TestContext) {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = await start(repair, app, 'fix-login');
  const app2 = path.join(h, 'repos', 'app2');
  renameSync(app, app2);
  const moved = path.join(app2, path.relative(app, worktree));
  git(h, app2, 'worktree', 'repair', moved);
  return { h, app2, moved, branch, repair };
}

/** The `ledger store repair …` line of `stdout` that ends with `flag`, run as it is printed, from `cwd`. */
async function runPrinted(repair: Run, cwd: string, stdout: string, flag: RegExp): Promise<string> {
  const line = stdout.split('\n').map((each) => each.trim()).find((each) => each.startsWith('ledger store repair ') && flag.test(each)) ?? assert.fail(`no command matches ${flag}:\n${stdout}`);
  return ok(await repair(cwd, ...line.split(' ').slice(1)));
}

test('store repair --search with a folder and a folder inside it finds a checkout once, and prints a --to command that runs from outside the repo', async (t) => {
  const { h, app2, moved, repair } = await movedMain(t);
  const ran = await repair(h, 'store', 'repair', '--search', h, app2);
  assert.equal(ran.status, 1, ran.stderr);
  assert.equal(ran.stdout.split('\n').filter((line) => line.trim() === `found ${moved}`).length, 1, ran.stdout);
  assert.ok(ran.stdout.includes(`ledger store repair fix-login@${app2} --to ${moved}`), ran.stdout);
  await runPrinted(repair, h, ran.stdout, / --to \//);
  assert.equal((await taskIn(repair, app2, 'fix-login')).worktree, moved);
});

test('store repair --search that finds two checkouts prints a task reference that runs from outside the repo, though no --to folder', async (t) => {
  const { h, app2, branch, repair } = await movedMain(t);
  const other = worktreeAt(h, app2, path.join(h, 'elsewhere', 'fix-login'), branch);
  const ran = await repair(h, 'store', 'repair', '--search', h);
  assert.equal(ran.status, 1, ran.stderr);
  assert.ok(ran.stdout.includes(`found ${other}`), ran.stdout);
  assert.ok(ran.stdout.includes(`ledger store repair fix-login@${app2} --to <folder>`), ran.stdout);
  assert.ok(ran.stdout.includes(`ledger store repair fix-login@${app2} --lost`), ran.stdout);
  await runPrinted(repair, h, ran.stdout, / --lost$/);
  assert.equal((await taskIn(repair, app2, 'fix-login')).status, 'lost');
});

test('store repair <slug> --to records the main checkout of a record that names none, so the next rename can be found', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree } = await start(repair, app, 'fix-login');
  const store = fileStore(ledgerPaths(h));
  store.active.update(key, 'fix-login', (text) => setLocationBullet(text, 'main', undefined));
  assert.equal(parseLedger(store.active.read(key, 'fix-login')?.text ?? '').location.main, undefined);
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(worktree, moved);

  ok(await repair(app, 'store', 'repair', 'fix-login', '--to', moved));
  const text = store.active.read(key, 'fix-login')?.text ?? assert.fail('fix-login is gone');
  assert.match(text, new RegExp(`^- main: ${escaped(app)}$`, 'm'));
  assert.equal(namedMain(text), app);
});

test('git store: store repair <slug> --to and --lost of another machine’s task refuse, also as a dry run, and put back no hook and write nothing', async (t) => {
  const m = machine(t, remote(t));
  await setUpHere(m);
  const repair: Run = (cwd, ...args) => runHere(m, args, { cwd });
  const { worktree } = await start(repair, m.app, 'fix-login');
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
    const ran = await repair(m.app, 'store', 'repair', 'fix-login', ...args);
    assert.equal(ran.status, 1, `store repair ${args.join(' ')}:\n${ran.stdout}${ran.stderr}`);
    assert.match(ran.stderr, /other-machine/);
    assert.doesNotMatch(ran.stdout, /[Ww]ould|Pointed|Marked/);
    assert.equal(existsSync(hook), false, `store repair ${args.join(' ')} put back the pre-push hook`);
    assert.equal(git(m.h, m.clone, 'rev-parse', 'HEAD'), head, `store repair ${args.join(' ')} committed`);
    assert.equal(record(), before);
  }
});

test('git store: store repair --remote that moves nothing, as an archive copy of that name is under the current key, puts back no hook and commits nothing', async (t) => {
  const m = machine(t, remote(t));
  await setUpHere(m);
  const repair: Run = (cwd, ...args) => runHere(m, args, { cwd });
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

  const ran = await repair(m.app, 'store', 'repair', '--remote', APP_KEY);
  assert.equal(ran.status, 1, `${ran.stdout}${ran.stderr}`);
  assert.match(ran.stdout, /left archive 2026-01-02-done-one/);
  assert.equal(existsSync(hook), false, 'store repair --remote put back the pre-push hook');
  assert.equal(git(m.h, m.clone, 'rev-parse', 'HEAD'), head, 'store repair --remote committed');
  assert.equal(git(m.h, m.clone, 'status', '--porcelain'), '');
});

test('store repair --search given one folder in two spellings of its case finds its checkout once, and prints a --to command for it', async (t) => {
  const { h, app2, moved, repair } = await movedMain(t);
  const shouted = path.join(path.dirname(app2), path.basename(app2).toUpperCase());
  if (!existsSync(shouted)) return t.skip('this volume tells upper from lower case');
  const ran = await repair(h, 'store', 'repair', '--search', app2, shouted);
  assert.equal(ran.status, 1, ran.stderr);
  assert.deepEqual(ran.stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('found ')), [`found ${moved}`], ran.stdout);
  assert.ok(ran.stdout.includes(`ledger store repair fix-login@${app2} --to ${moved}`), ran.stdout);
});

test('store repair --search prints no --to command for a folder that another task names as its own', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = await start(repair, app, 'fix-login');
  const other = await start(repair, app, 'other-task');
  rmSync(worktree, { recursive: true, force: true });
  git(h, app, 'worktree', 'prune');
  git(h, other.worktree, 'checkout', '--quiet', branch);

  const ran = await repair(app, 'store', 'repair', '--search', app);
  assert.equal(ran.status, 1, ran.stderr);
  assert.ok(!ran.stdout.includes(`found ${other.worktree}`), ran.stdout);
  assert.match(ran.stdout, /ledger store repair fix-login\S* --to <folder>/);
});

test('store repair --search that finds the task repo only on another branch prints a --lost command that names the task by that checkout, and it runs', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree } = await start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  const app2 = path.join(h, 'repos', 'app2');
  renameSync(app, app2);

  const ran = await repair(h, 'store', 'repair', '--search', app2);
  assert.equal(ran.status, 1, ran.stderr);
  assert.ok(ran.stdout.includes(`ledger store repair fix-login@${app2} --lost`), ran.stdout);
  await runPrinted(repair, h, ran.stdout, / --lost$/);
  assert.equal((await taskIn(repair, app2, 'fix-login')).status, 'lost');
});

test('store repair --remote refuses, moving nothing, when the key of this repo is an alias of a third key already, so no chain of aliases is made', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  const third = 'github.com/someone/third';
  fileStore(ledgerPaths(h)).aliases.add(newKey, third);
  const before = { old: filed(h, key), now: filed(h, newKey) };

  for (const args of [['--dry-run'], []]) {
    const ran = await repair(app, 'store', 'repair', '--remote', key, ...args);
    assert.equal(ran.status, 1, `${ran.stdout}${ran.stderr}`);
    assert.ok(ran.stderr.includes(third), ran.stderr);
    assert.match(ran.stderr, /nothing was moved/);
    assert.equal(ran.stdout, '', 'a refusal prints no plan');
  }
  assert.deepEqual({ old: filed(h, key), now: filed(h, newKey) }, before);
  assert.deepEqual(Object.fromEntries(fileStore(ledgerPaths(h)).aliases.read()), { [newKey]: third });
});

/** Runs ledger store repair in this process on `store`, as the CLI does, so a test can make one store call fail. */
function repairWith(store: LedgerStore, h: string, cwd: string, options: Partial<RepairOptions>, { slug, writable = () => store }: { slug?: string; writable?: () => LedgerStore } = {}): Ran {
  // A ledger run in this process keyed the repo before the test changed its origin, and a CLI run starts with no such cache.
  forgetRepoKeys();
  const lines: string[] = [];
  const context: RepairContext = { paths: ledgerPaths(h), cwd, store, writable };
  try {
    const left = repairStore(context, slug, { lost: false, dryRun: false, ...options }, (text) => lines.push(text));
    return { status: left > 0 ? 1 : 0, stdout: lines.join('\n'), stderr: '' };
  } catch (error) {
    return { status: error instanceof Failure ? error.exitCode : 1, stdout: lines.join('\n'), stderr: error instanceof Error ? error.message : String(error) };
  } finally {
    store.close?.();
  }
}

const failingAliasWrite = (store: LedgerStore): LedgerStore => ({
  ...store,
  aliases: {
    ...store.aliases,
    replace: () => {
      throw Object.assign(new Error('EIO: the alias write failed'), { code: 'EIO' });
    },
  },
});

/** HOME, the repo app, its key and how to run ledger there, for each storage. */
async function worldOf(t: TestContext, storage: Storage | 'git'): Promise<{ h: string; app: string; key: string; repair: Run }> {
  if (storage !== 'git') {
    const world = setup(t, storage);
    return { ...world, repair: forStorage(world.h) };
  }
  const m = machine(t, remote(t));
  await setUpHere(m);
  return { h: m.h, app: m.app, key: APP_KEY, repair: (cwd, ...args) => runHere(m, args, { cwd }) };
}

for (const storage of ['file', 'sqlite', 'git'] as const) {
  test(`${storage} store: store repair --remote run again after the alias write failed moves what is left and records the alias`, { skip: storage === 'sqlite' && noSqlite }, async (t) => {
    const { h, app, key, repair } = await worldOf(t, storage);
    await start(repair, app, 'fix-login');
    ok(await repair(app, 'task', 'new', 'idea', '--goal', 'Later.'));
    const newKey = renameOrigin(h, app);
    asCli(t, h);
    const store = () => openStore(ledgerPaths(h), storage, { backgroundSync: false });

    const first = repairWith(failingAliasWrite(store()), h, app, { remote: key });
    assert.notEqual(first.status, 0, first.stdout);
    assert.match(first.stderr, /alias write failed/);

    const again = await repair(app, 'store', 'repair', '--remote', key);
    assert.equal(again.status, 0, `${again.stdout}${again.stderr}`);
    assert.deepEqual(filedIn(store(), newKey), { active: ['fix-login'], backlog: ['idea'], archive: [] });
    assert.deepEqual(filedIn(store(), key), { active: [], backlog: [], archive: [] });
    const opened = store();
    try {
      assert.equal(opened.aliases.read().get(key), newKey);
    } finally {
      opened.close?.();
    }
  });

  test(`${storage} store: store repair --remote of the encoding of this repo's key, one repo folder in a file store, refuses and removes no task`, { skip: storage === 'sqlite' && noSqlite }, async (t) => {
    const { h, app, key, repair } = await worldOf(t, storage);
    await start(repair, app, 'fix-login');
    ok(await repair(app, 'task', 'new', 'idea', '--goal', 'Later.'));
    asCli(t, h);
    const store = () => openStore(ledgerPaths(h), storage, { backgroundSync: false });
    const encoded = encodeURIComponent(key);

    for (const dryRun of [['--dry-run'], []]) {
      const ran = await repair(app, 'store', 'repair', '--remote', encoded, ...dryRun);
      assert.equal(ran.status, 1, `${ran.stdout}${ran.stderr}`);
      // A database keeps each key apart, so it finds no task under the encoding.
      assert.ok(ran.stderr.includes(storage === 'sqlite' ? `No task is filed under ${encoded}` : `${encoded} and ${key}, the key of this repo, are the same repository folder in the store`), ran.stderr);
    }
    assert.deepEqual(filedIn(store(), key), { active: ['fix-login'], backlog: ['idea'], archive: [] });
    const opened = store();
    try {
      assert.equal(opened.aliases.read().get(encoded), undefined);
    } finally {
      opened.close?.();
    }
  });
}

test('store repair --remote of a key that never had a task or an alias still refuses with its message', async (t) => {
  const { h, app } = setup(t);
  await start(forStorage(h), app, 'fix-login');
  fails(await runInProcess(h, app, 'store', 'repair', '--remote', 'github.com/nobody/nothing'), 'No task is filed under github.com/nobody/nothing, so nothing was moved.');
});

test('store repair --remote run again after the evidence of an archive copy failed to move moves that evidence and records the alias', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  asCli(t, h);
  const name = '2026-01-02-done-one';
  const evidence = fileStore(ledgerPaths(h)).archive.evidenceLocation(key, name);
  mkdirSync(evidence);
  writeFileSync(path.join(evidence, 'red.txt'), 'the failing run\n');
  const failing = fileStore(ledgerPaths(h), {
    rename: (from, to) => {
      if (from === evidence) throw Object.assign(new Error('EIO: the evidence move failed'), { code: 'EIO' });
      renameSync(from, to);
    },
  });

  const first = repairWith(failing, h, app, { remote: key });
  assert.equal(first.status, 1, `${first.stdout}${first.stderr}`);
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get(key), undefined, 'an alias was recorded while evidence is left under the old key');

  const again = ok(await repair(app, 'store', 'repair', '--remote', key));
  assert.match(again, new RegExp(`^moved the evidence of archive ${name}$`, 'm'));
  assert.match(again, /^recorded .* as an alias/m);
  const store = fileStore(ledgerPaths(h));
  assert.deepEqual(store.archive.evidenceFiles(newKey, name), ['red.txt']);
  assert.equal(existsSync(evidence), false);
  assert.equal(store.aliases.read().get(key), newKey);
});

test('store repair --remote leaves a record under the old key that cannot be read, names it, records no alias and exits 1', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  const broken = path.join(fileStore(ledgerPaths(h)).backlog.repoLocation(key), 'broken.json');
  writeFileSync(broken, '{ "no": "record"');

  const ran = await repair(app, 'store', 'repair', '--remote', key);
  assert.equal(ran.status, 1, `${ran.stdout}${ran.stderr}`);
  assert.match(`${ran.stdout}${ran.stderr}`, /broken/);
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get(key), undefined);
  assert.equal(readFileSync(broken, 'utf8'), '{ "no": "record"');
  assert.deepEqual(filed(h, newKey), { active: ['fix-login'], backlog: ['idea'], archive: ['2026-01-02-done-one'] });
});

test('tree next counts a dependency on a task of another repo by its old key as done once --remote filed that repo under its new key and the task retired', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const lib = repository(h, path.join(h, 'repos', 'lib'));
  writeFileSync(path.join(lib, '.git/info/exclude'), '.claude/\n');
  const libKey = repoKeyOf(lib);
  await start(repair, app, 'epic');
  ok(await repair(app, 'task', 'new', 'part', '--goal', 'Part of epic.'));
  ok(await repair(app, 'tree', 'add', 'epic', 'part'));
  ok(await repair(lib, 'task', 'new', 'build', '--goal', 'Build it.'));
  ok(await repair(app, 'tree', 'depends', 'part', `build@${lib}`));
  assert.match(await shown(repair, app, 'part'), new RegExp(`depends on: build @ ${libKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const renamed = path.join(h, 'remotes', 'lib-renamed.git');
  git(h, h, 'init', '--quiet', '--bare', '-b', 'main', renamed);
  git(h, lib, 'remote', 'set-url', 'origin', renamed);
  ok(await repair(lib, 'store', 'repair', '--remote', libKey));
  const store = fileStore(ledgerPaths(h));
  const newKey = repoKeyOf(lib);
  const build = store.backlog.read(newKey, 'build') ?? assert.fail('build was not filed under the new key');
  assert.ok(store.backlog.remove(newKey, 'build', build.text));
  archivedTask(h, lib, '2026-01-03', { slug: 'build' });

  assert.equal(ok(await repair(app, 'tree', 'next', 'epic')), 'epic part\n');
});

test('store repair --search refuses a folder named by a symbolic link, and finds nothing in a named node_modules or .claude/worktrees/.build folder', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = await start(repair, app, 'fix-login');
  const moved = path.join(h, 'moved');
  mkdirSync(moved);
  renameSync(worktree, path.join(moved, 'fix-login'));
  const link = path.join(h, 'link');
  symlinkSync(moved, link);
  const modules = path.dirname(worktreeAt(h, app, path.join(h, 'pkgs', 'node_modules', 'pkg'), branch));
  const builds = path.dirname(worktreeAt(h, app, path.join(h, 'repos', 'lib', '.claude', 'worktrees', '.build', 'x'), branch));

  fails(await repair(h, 'store', 'repair', '--search', link), new RegExp(`${link}.*symbolic link`));
  for (const root of [modules, builds]) {
    const ran = await repair(h, 'store', 'repair', '--search', root);
    assert.equal(ran.status, 1, ran.stderr);
    assert.doesNotMatch(ran.stdout, /found /, `${root} was searched:\n${ran.stdout}`);
  }
});

test('store repair --search finds nothing in a named folder inside a node_modules or .claude/worktrees/.build folder of any case, at any depth', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = await start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  git(h, app, 'worktree', 'prune');
  const modules = worktreeAt(h, app, path.join(h, 'pkgs', 'Node_Modules', 'pkg', 'fix-login'), branch);
  const builds = worktreeAt(h, app, path.join(h, 'repos', 'lib', '.Claude', 'Worktrees', '.Build', 'x', 'deeper', 'fix-login'), branch);

  for (const root of [modules, path.dirname(modules), builds, path.dirname(path.dirname(builds))]) {
    const ran = await repair(h, 'store', 'repair', '--search', root);
    assert.equal(ran.status, 1, ran.stderr);
    assert.doesNotMatch(ran.stdout, /found /, `${root} was searched:\n${ran.stdout}`);
  }
});

test('store repair --remote passes over evidence under the old key whose archive copy is under neither key, and records the alias', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  const evidence = fileStore(ledgerPaths(h)).archive.evidenceLocation(key, '2025-12-01-gone');
  mkdirSync(evidence);
  writeFileSync(path.join(evidence, 'red.txt'), 'no copy anywhere\n');

  ok(await repair(app, 'store', 'repair', '--remote', key));
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get(key), newKey);
  assert.ok(existsSync(path.join(evidence, 'red.txt')), 'the evidence moved or went away');
});

test('store repair --remote run again after a run that recorded the alias and stopped before every move moves what is left', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  const store = fileStore(ledgerPaths(h));
  store.aliases.add(key, newKey);
  assert.ok(store.backlog.move(key, 'idea', newKey));

  ok(await repair(app, 'store', 'repair', '--remote', key));
  assert.deepEqual(filed(h, key), { active: [], backlog: [], archive: [] });
  assert.deepEqual(filed(h, newKey), { active: ['fix-login'], backlog: ['idea'], archive: ['2026-01-02-done-one'] });
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get(key), newKey);
});

/** A file store of HOME `h` whose link of the ledger file `file` fails, so the move of that ledger fails. */
const failingLinkOf = (h: string, file: string): LedgerStore =>
  fileStore(ledgerPaths(h), {
    link: (from, to) => {
      if (path.basename(from) === file) throw Object.assign(new Error(`EIO: the move of ${file} failed`), { code: 'EIO' });
      linkSync(from, to);
    },
  });

test('store repair --remote keeps the alias it recorded when a move and the store commit both fail, and says to run ledger store sync', async (t) => {
  const { h, app, key, newKey } = await renamedRemote(t);
  asCli(t, h);
  const store: LedgerStore = {
    ...failingLinkOf(h, 'idea.json'),
    commit: () => {
      throw new Error('the commit failed');
    },
  };

  const ran = repairWith(store, h, app, { remote: key });
  assert.notEqual(ran.status, 0, ran.stdout);
  assert.match(ran.stderr, /the commit failed/);
  assert.ok(ran.stderr.includes(`${key} is recorded as an alias of`), ran.stderr);
  assert.match(ran.stderr, /then run ledger store sync\./);
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get(key), newKey);
});

test('store repair --remote run again after the alias was recorded says it keeps that alias when a move fails', async (t) => {
  const { h, app, key, newKey } = await renamedRemote(t);
  asCli(t, h);
  fileStore(ledgerPaths(h)).aliases.add(key, newKey);

  const ran = repairWith(failingLinkOf(h, 'idea.json'), h, app, { remote: key });
  assert.equal(ran.status, 1, `${ran.stdout}${ran.stderr}`);
  assert.doesNotMatch(ran.stdout, /kept no alias/);
  assert.ok(ran.stdout.includes(`kept the alias ${key} of`), ran.stdout);
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get(key), newKey);
});

test('store repair --search refuses a folder whose path goes through a symbolic link', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree } = await start(repair, app, 'fix-login');
  const moved = path.join(h, 'moved');
  mkdirSync(path.join(moved, 'sub'), { recursive: true });
  renameSync(worktree, path.join(moved, 'sub', 'fix-login'));
  const link = path.join(h, 'link');
  symlinkSync(moved, link);

  fails(await repair(h, 'store', 'repair', '--search', path.join(link, 'sub')), new RegExp(`${path.join(link, 'sub')}.*symbolic link.*${path.join(moved, 'sub')}`));
});

test('sqlite store: store repair --remote leaves a record under the old key that cannot be read, names it, records no alias and exits 1', { skip: noSqlite }, async (t) => {
  const { h, app, key } = setup(t, 'sqlite');
  const repair = forStorage(h);
  await start(repair, app, 'fix-login');
  const newKey = renameOrigin(h, app);
  const db = new (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync(sqliteFile(h));
  try {
    db.prepare('INSERT INTO records (place, repo, name, record, mtime, birthtime) VALUES (?, ?, ?, ?, ?, ?)').run('backlog', key, 'broken', '{"no":"record"}', Date.now(), Date.now());
  } finally {
    db.close();
  }

  const ran = await repair(app, 'store', 'repair', '--remote', key);
  assert.equal(ran.status, 1, `${ran.stdout}${ran.stderr}`);
  assert.match(ran.stdout, /left backlog broken: .*cannot be read/);
  const store = openStore(ledgerPaths(h), 'sqlite');
  try {
    assert.equal(store.aliases.read().get(key), undefined);
    assert.deepEqual(store.active.list(newKey).map(({ name }) => name), ['fix-login']);
  } finally {
    store.close?.();
  }
});

/** Runs `work` while every lock wait of this process ends at `until`, as when another process holds the lock throughout. */
function withLockWaitsEndingAt<T>(until: number, work: () => T): T {
  limitLockWaits(until);
  try {
    return work();
  } finally {
    limitLockWaits(Infinity);
  }
}

const repairLock = (h: string): string => path.join(h, '.claude', 'ledger-repair');

test('store repair --remote holds the repair lock from its first read, so a second run cannot take back the alias the first records', async (t) => {
  const { h, app, key, newKey } = await renamedRemote(t);
  asCli(t, h);
  const store = fileStore(ledgerPaths(h));
  let second: Ran | undefined;
  const first = repairWith(store, h, app, { remote: key }, {
    writable: () => {
      // The second run starts once the first has read the store and planned its moves.
      second ??= withLockWaitsEndingAt(Date.now() + 200, () => repairWith(fileStore(ledgerPaths(h)), h, app, { remote: key }));
      return store;
    },
  });

  assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
  assert.ok(second?.stderr.includes(`${repairLock(h)}.lock`), second?.stderr ?? 'no second run started');
  assert.deepEqual(filed(h, newKey), { active: ['fix-login'], backlog: ['idea'], archive: ['2026-01-02-done-one'] });
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get(key), newKey);
});

test('store repair <slug> --lost waits for the repair lock, and marks nothing while another repair holds it', async (t) => {
  const { h, app, key } = setup(t);
  asCli(t, h);
  const { worktree } = await start(forStorage(h), app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });

  const ran = withLock(repairLock(h), () => withLockWaitsEndingAt(Date.now() + 200, () => repairWith(fileStore(ledgerPaths(h)), h, app, { lost: true }, { slug: 'fix-login' })));
  assert.ok(ran.stderr.includes(`${repairLock(h)}.lock`), `${ran.stdout}${ran.stderr}`);
  assert.equal(parseLedger(fileStore(ledgerPaths(h)).active.read(key, 'fix-login')?.text ?? '').location.lost, undefined);
});

test('store repair --remote keeps waiting for a repair lock older than a minute while the process that holds it still runs', async (t) => {
  const { h, app, key, newKey } = await renamedRemote(t);
  asCli(t, h);
  const lock = `${repairLock(h)}.lock`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid, since: new Date(Date.now() - 2 * 60_000).toISOString() }));

  const ran = withLockWaitsEndingAt(Date.now() + 200, () => repairWith(fileStore(ledgerPaths(h)), h, app, { remote: key }));
  assert.ok(ran.stderr.includes(lock), `${ran.stdout}${ran.stderr}`);
  assert.deepEqual(filed(h, newKey), { active: [], backlog: [], archive: [] });
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get(key), undefined);
});

test('store repair --remote run again after a run that recorded the alias and stopped between an archive copy and its evidence moves that evidence', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  const store = fileStore(ledgerPaths(h));
  const name = '2026-01-02-done-one';
  const evidence = store.archive.evidenceLocation(key, name);
  mkdirSync(evidence);
  writeFileSync(path.join(evidence, 'red.txt'), 'the failing run\n');
  store.aliases.add(key, newKey);
  assert.ok(store.active.move(key, 'fix-login', newKey));
  assert.ok(store.backlog.move(key, 'idea', newKey));
  mkdirSync(store.archive.repoLocation(newKey), { recursive: true });
  const copy = store.archive.location(key, name);
  renameSync(copy, path.join(store.archive.repoLocation(newKey), path.basename(copy)));

  const again = ok(await repair(app, 'store', 'repair', '--remote', key));
  assert.match(again, new RegExp(`^moved the evidence of archive ${name}$`, 'm'));
  assert.deepEqual(store.archive.evidenceFiles(newKey, name), ['red.txt']);
  assert.equal(existsSync(evidence), false);
  assert.equal(store.aliases.read().get(key), newKey);
});

test('store repair --search refuses a folder named through a symbolic link and .., by the folder the path leads to', async (t) => {
  const { h } = setup(t);
  const inner = path.join(h, 'real', 'inner');
  mkdirSync(inner, { recursive: true });
  const link = path.join(h, 'link');
  symlinkSync(inner, link);

  fails(await runInProcess(h, h, 'store', 'repair', '--search', `${link}${path.sep}..`), `Name the folder it leads to: ${path.join(h, 'real')}`);
});

test('store repair --search finds nothing in a .git folder it is given by name', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = await start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  const dotGit = path.dirname(worktreeAt(h, app, path.join(h, 'x', '.git', 'fix-login'), branch));

  const ran = await repair(h, 'store', 'repair', '--search', dotGit);
  assert.equal(ran.status, 1, ran.stderr);
  assert.ok(ran.stdout.includes(`no checkout on ${branch} in ${dotGit}`), ran.stdout);
});

test('sqlite store: store repair --remote of a key with no task says so before the database exists', { skip: noSqlite }, async (t) => {
  const { h, app, key } = setup(t, 'sqlite');
  for (const dryRun of [[], ['--dry-run']]) {
    fails(await runInProcess(h, app, 'store', 'repair', '--remote', 'github.com/nobody/nothing', ...dryRun), 'No task is filed under github.com/nobody/nothing, so nothing was moved.');
  }
  fails(await runInProcess(h, app, 'store', 'repair', '--remote', key), `${key} is the key of this repo now.`);
  assert.equal(existsSync(sqliteFile(h)), false);
});

test('git store: store repair --remote run again after a run that recorded the alias and stopped between an archive copy and its evidence moves that evidence', async (t) => {
  const { h, app, key, repair } = await worldOf(t, 'git');
  await start(repair, app, 'fix-login');
  const newKey = renameOrigin(h, app);
  asCli(t, h);
  const name = '2026-01-02-done-one';
  const from = path.join(h, 'evidence');
  mkdirSync(from);
  writeFileSync(path.join(from, 'red.txt'), 'the failing run\n');
  const store = openStore(ledgerPaths(h), 'git', { backgroundSync: false });
  try {
    store.archive.write(key, name, ledgerText({ slug: 'done-one', main: app }), from);
    store.aliases.add(key, newKey);
    assert.ok(store.active.move(key, 'fix-login', newKey));
    const copy = store.archive.location(key, name);
    mkdirSync(store.archive.repoLocation(newKey), { recursive: true });
    renameSync(copy, path.join(store.archive.repoLocation(newKey), path.basename(copy)));
    store.commit?.();
  } finally {
    store.close?.();
  }

  ok(await repair(app, 'store', 'repair', '--remote', key));
  const after = openStore(ledgerPaths(h), 'git', { backgroundSync: false });
  try {
    assert.deepEqual(after.archive.evidenceFiles(newKey, name), ['red.txt']);
    assert.deepEqual(after.archive.evidenceFiles(key, name), []);
    assert.equal(after.aliases.read().get(key), newKey);
  } finally {
    after.close?.();
  }
});

test('store repair --remote keeps the alias when a repo folder it emptied cannot be removed, and a rerun finishes', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  const store = fileStore(ledgerPaths(h));
  const roots = places.map((place) => {
    mkdirSync(store[place].repoLocation(newKey), { recursive: true });
    return path.dirname(store[place].repoLocation(key));
  });
  for (const root of roots) chmodSync(root, 0o555);
  try {
    ok(await repair(app, 'store', 'repair', '--remote', key));
    assert.equal(store.aliases.read().get(key), newKey);
    assert.deepEqual(filed(h, newKey), { active: ['fix-login'], backlog: ['idea'], archive: ['2026-01-02-done-one'] });
    assert.ok(ok(await repair(app, 'store', 'repair', '--remote', key)).includes(`Nothing is left under ${key} to move.`));
  } finally {
    // Here, not in t.after, which would run after HOME is removed.
    for (const root of roots) chmodSync(root, 0o755);
  }
});

test('store repair --remote moves an archive copy whose name ends in .md with its evidence, and records the alias', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  const from = path.join(h, 'evidence');
  mkdirSync(from);
  writeFileSync(path.join(from, 'red.txt'), 'the failing run\n');
  const name = '2026-01-03-notes.md';
  fileStore(ledgerPaths(h)).archive.write(key, name, ledgerText({ slug: 'notes', main: app }), from);

  ok(await repair(app, 'store', 'repair', '--remote', key));
  const store = fileStore(ledgerPaths(h));
  assert.equal(store.aliases.read().get(key), newKey);
  assert.deepEqual(store.archive.evidenceFiles(newKey, name), ['red.txt']);
  assert.ok(filed(h, newKey).archive.includes(name), JSON.stringify(filed(h, newKey)));
});

test('git store: store repair --remote run again after a run that stopped between its moves and their commit commits the moves', async (t) => {
  const { h, app, key, repair } = await worldOf(t, 'git');
  await start(repair, app, 'fix-login');
  ok(await repair(app, 'task', 'new', 'idea', '--goal', 'Later.'));
  const newKey = renameOrigin(h, app);
  asCli(t, h);
  // Neither commit nor close, as a run killed after its last move.
  const stopped = openStore(ledgerPaths(h), 'git', { backgroundSync: false });
  stopped.aliases.add(key, newKey);
  assert.ok(stopped.active.move(key, 'fix-login', newKey));
  assert.ok(stopped.backlog.move(key, 'idea', newKey));

  const again = await repair(app, 'store', 'repair', '--remote', key);
  assert.equal(again.status, 0, `${again.stdout}${again.stderr}`);
  const { clone } = clonePaths(ledgerPaths(h));
  const committed = git(h, clone, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
  for (const file of [`active/${encodeURIComponent(newKey)}/fix-login.json`, `backlog/${encodeURIComponent(newKey)}/idea.json`]) assert.ok(committed.includes(file), `${file} is not committed:\n${committed.join('\n')}`);
  assert.equal(git(h, clone, 'status', '--porcelain', '--', 'active', 'backlog'), '');
});

test('store repair --search finds nothing in a node_modules or .claude/worktrees/.build folder named in another case, on a disk that ignores case', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = await start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  worktreeAt(h, app, path.join(h, 'pkgs', 'node_modules', 'pkg'), branch);
  worktreeAt(h, app, path.join(h, 'repos', 'lib', '.claude', 'worktrees', '.build', 'x'), branch);
  const roots = [path.join(h, 'pkgs', 'NODE_MODULES'), path.join(h, 'repos', 'lib', '.claude', 'worktrees', '.BUILD')];
  if (!existsSync(roots[0])) return t.skip('this disk tells case apart');

  for (const root of roots) {
    const ran = await repair(h, 'store', 'repair', '--search', root);
    assert.equal(ran.status, 1, ran.stderr);
    assert.doesNotMatch(ran.stdout, /found /, `${root} was searched:\n${ran.stdout}`);
  }
});

test('tree depends refuses a dependency on the task itself, or a cycle, named by the old key of a renamed remote', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  ok(await repair(app, 'task', 'new', 'build', '--goal', 'Build it.'));
  ok(await repair(app, 'task', 'new', 'ship', '--goal', 'Ship it.'));
  renameOrigin(h, app);
  ok(await repair(app, 'store', 'repair', '--remote', key));
  // A remote that is a local path keys the repo by that path; once it is gone, the key names no folder.
  rmSync(key, { recursive: true, force: true });

  fails(await repair(app, 'tree', 'depends', 'build', `build@${key}`), 'cannot wait for itself');
  ok(await repair(app, 'tree', 'depends', 'ship', `build@${key}`));
  fails(await repair(app, 'tree', 'depends', 'build', 'ship'), 'would make a cycle');
});

test('store repair --remote run again after a run killed between linking each ledger under the new key and removing it from the old one finishes the moves', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  const store = fileStore(ledgerPaths(h));
  store.aliases.add(key, newKey);
  for (const [place, name] of [['backlog', 'idea'], ['active', 'fix-login'], ['archive', '2026-01-02-done-one']] as const) {
    mkdirSync(store[place].repoLocation(newKey), { recursive: true });
    const file = store[place].location(key, name);
    linkSync(file, path.join(store[place].repoLocation(newKey), path.basename(file)));
  }

  assert.match(ok(await repair(app, 'store', 'repair', '--remote', key, '--dry-run')), /^would move backlog idea$/m);
  ok(await repair(app, 'store', 'repair', '--remote', key));
  assert.deepEqual(filed(h, key), { active: [], backlog: [], archive: [] });
  assert.deepEqual(filed(h, newKey), { active: ['fix-login'], backlog: ['idea'], archive: ['2026-01-02-done-one'] });
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get(key), newKey);
});

test('store repair --remote run again after a run killed between the two links, or the two removals, of a record and the Markdown it hides finishes the moves', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  const store = fileStore(ledgerPaths(h));
  assert.ok(store.backlog.create(key, 'plan', ledgerText({ slug: 'plan', main: app })));
  const [from, to] = [store.backlog.repoLocation(key), store.backlog.repoLocation(newKey)];
  for (const name of ['idea', 'plan']) writeFileSync(path.join(from, `${name}.md`), ledgerText({ slug: name, main: app }));
  store.aliases.add(key, newKey);
  mkdirSync(to, { recursive: true });
  linkSync(path.join(from, 'plan.json'), path.join(to, 'plan.json'));
  for (const file of ['idea.json', 'idea.md']) linkSync(path.join(from, file), path.join(to, file));
  rmSync(path.join(from, 'idea.json'));

  ok(await repair(app, 'store', 'repair', '--remote', key));
  assert.deepEqual(existsSync(from) ? readdirSync(from) : [], []);
  assert.deepEqual(readdirSync(to).sort(), ['idea.json', 'idea.md', 'plan.json', 'plan.md']);
});

test('store repair --remote run again after a run killed between removing a record and the Markdown it hid removes that Markdown, though it names a checkout that is gone', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  const store = fileStore(ledgerPaths(h));
  const [from, to] = [store.backlog.repoLocation(key), store.backlog.repoLocation(newKey)];
  writeFileSync(path.join(from, 'idea.md'), ledgerText({ slug: 'idea', main: path.join(h, 'repos', 'gone') }));
  store.aliases.add(key, newKey);
  mkdirSync(to, { recursive: true });
  for (const file of ['idea.json', 'idea.md']) linkSync(path.join(from, file), path.join(to, file));
  rmSync(path.join(from, 'idea.json'));

  const again = await repair(app, 'store', 'repair', '--remote', key);
  assert.equal(again.status, 0, `${again.stdout}${again.stderr}`);
  assert.deepEqual(existsSync(from) ? readdirSync(from) : [], []);
  assert.deepEqual(readdirSync(to).sort(), ['idea.json', 'idea.md']);
  assert.deepEqual(filed(h, newKey), { active: ['fix-login'], backlog: ['idea'], archive: ['2026-01-02-done-one'] });
});

test('store repair --remote leaves old Markdown that names a checkout that is gone when the record of its name under the new key is no move of it', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  const store = fileStore(ledgerPaths(h));
  const gone = path.join(h, 'repos', 'gone');
  writeFileSync(path.join(store.backlog.repoLocation(key), 'plan.md'), ledgerText({ slug: 'plan', main: gone }));
  assert.ok(store.backlog.create(newKey, 'plan', ledgerText({ slug: 'plan', main: app })));

  const ran = await repair(app, 'store', 'repair', '--remote', key);
  assert.equal(ran.status, 1, `${ran.stdout}${ran.stderr}`);
  assert.ok(ran.stdout.includes(`left backlog plan: its main checkout ${gone} is not one any more`), ran.stdout);
  assert.ok(existsSync(path.join(store.backlog.repoLocation(key), 'plan.md')));
});

test('store repair --remote run again with nothing left to move opens no store to write when the store has no commit to finish', async (t) => {
  const { h, app, key, repair } = await renamedRemote(t);
  asCli(t, h);
  ok(await repair(app, 'store', 'repair', '--remote', key));

  const ran = repairWith(fileStore(ledgerPaths(h)), h, app, { remote: key }, { writable: () => assert.fail('the store was opened to write') });
  assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
  assert.ok(ran.stdout.includes(`Nothing is left under ${key} to move.`), ran.stdout);
});

test('git store: store repair --remote run again after a run that moved another machine’s record and stopped before its commit commits that move', async (t) => {
  const { h, app, key, repair } = await worldOf(t, 'git');
  await start(repair, app, 'fix-login');
  const store = openStore(ledgerPaths(h), 'git', { backgroundSync: false });
  try {
    store.active.update(key, 'fix-login', (text) => setLocationBullet(text, 'host', 'other-machine') ?? text);
  } finally {
    store.close?.();
  }
  const newKey = renameOrigin(h, app);
  const { clone } = clonePaths(ledgerPaths(h));
  const [from, to] = [key, newKey].map((each) => `active/${encodeURIComponent(each)}/fix-login.json`);
  // As a run killed after the move and before its commit leaves the clone.
  openStore(ledgerPaths(h), 'git', { backgroundSync: false }).aliases.add(key, newKey);
  mkdirSync(path.dirname(path.join(clone, to)), { recursive: true });
  renameSync(path.join(clone, from), path.join(clone, to));

  const again = await repair(app, 'store', 'repair', '--remote', key);
  assert.equal(again.status, 0, `${again.stdout}${again.stderr}`);
  const committed = git(h, clone, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
  assert.ok(committed.includes(to) && !committed.includes(from), committed.join('\n'));
  assert.ok(existsSync(path.join(clone, to)), 'the moved record is gone');
  assert.equal(existsSync(path.join(clone, from)), false, 'the record is back under the old key');
});

test('git store: store repair --remote run again after a run whose removal git could not commit, as the old record is marked assume-unchanged, exits 1 and names it', async (t) => {
  const { h, app, key, repair } = await worldOf(t, 'git');
  await start(repair, app, 'fix-login');
  ok(await repair(app, 'task', 'new', 'idea', '--goal', 'Later.'));
  const newKey = renameOrigin(h, app);
  const { clone } = clonePaths(ledgerPaths(h));
  const from = `backlog/${encodeURIComponent(key)}/idea.json`;
  git(h, clone, 'update-index', '--assume-unchanged', from);
  const stopped = openStore(ledgerPaths(h), 'git', { backgroundSync: false });
  stopped.aliases.add(key, newKey);
  assert.ok(stopped.backlog.move(key, 'idea', newKey));

  for (let run = 0; run < 2; run++) {
    const again = await repair(app, 'store', 'repair', '--remote', key);
    assert.equal(again.status, 1, `run ${run}: ${again.stdout}${again.stderr}`);
    assert.ok(again.stderr.includes(from), again.stderr);
  }
});

test('store repair <slug> --to records the main checkout of its folder, though another --to pointed the task into another clone after this one read the record', async (t) => {
  const { h, app, key } = setup(t);
  asCli(t, h);
  const { worktree, branch } = await start(forStorage(h), app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  const folder = worktreeAt(h, app, path.join(h, 'moved', 'fix-login'), branch);
  const real = fileStore(ledgerPaths(h));
  real.active.update(key, 'fix-login', (text) => setLocationBullet(text, 'main', app) ?? text);
  const intoOtherClone = (text: string): string => {
    const withMain = setLocationBullet(text, 'main', path.join(h, 'clones', 'app')) ?? text;
    return setLocationBullet(withMain, 'worktree', path.join(h, 'clones', 'fix-login')) ?? withMain;
  };
  const racing: LedgerStore = {
    ...real,
    active: {
      ...real.active,
      update: (...args: Parameters<LedgerStore['active']['update']>) => {
        real.active.update(key, 'fix-login', intoOtherClone);
        return real.active.update(...args);
      },
    },
  };

  const ran = repairWith(real, h, app, { to: folder }, { slug: 'fix-login', writable: () => racing });
  assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
  const { location } = parseLedger(real.active.read(key, 'fix-login')?.text ?? '');
  assert.deepEqual({ worktree: location.worktree, main: location.main }, { worktree: folder, main: app });
});

test('store repair --search finds nothing in a node_modules or .claude/worktrees/.build folder whose name on disk is in mixed case', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  const { worktree, branch } = await start(repair, app, 'fix-login');
  rmSync(worktree, { recursive: true, force: true });
  const [pkgs, lib] = [path.join(h, 'pkgs'), path.join(h, 'repos', 'lib')];
  const modules = path.dirname(worktreeAt(h, app, path.join(pkgs, 'Node_Modules', 'pkg'), branch));
  const builds = path.dirname(worktreeAt(h, app, path.join(lib, '.Claude', 'Worktrees', '.Build', 'x'), branch));

  for (const root of [pkgs, lib, modules, builds]) {
    const ran = await repair(h, 'store', 'repair', '--search', root);
    assert.equal(ran.status, 1, ran.stderr);
    assert.doesNotMatch(ran.stdout, /found /, `${root} was searched:\n${ran.stdout}`);
  }
});

test('store repair --remote --dry-run leaves a ledger whose hidden Markdown is a symbolic link, as the move does, also one that leads nowhere', async (t) => {
  const { h, app, key, repair } = await renamedRemote(t);
  const store = fileStore(ledgerPaths(h));
  assert.ok(store.backlog.create(key, 'plan', ledgerText({ slug: 'plan', main: app })));
  const folder = store.backlog.repoLocation(key);
  const elsewhere = path.join(h, 'elsewhere.md');
  writeFileSync(elsewhere, ledgerText({ slug: 'idea', main: app }));
  symlinkSync(elsewhere, path.join(folder, 'idea.md'));
  symlinkSync(path.join(h, 'nowhere.md'), path.join(folder, 'plan.md'));

  for (const args of [['--dry-run'], []]) {
    const ran = await repair(app, 'store', 'repair', '--remote', key, ...args);
    assert.equal(ran.status, 1, `${args.join(' ')}: ${ran.stdout}${ran.stderr}`);
    for (const name of ['idea', 'plan']) assert.match(ran.stdout, new RegExp(`^left backlog ${name}: .*${name}\\.md is a symbolic link`, 'm'), `${args.join(' ')}: ${ran.stdout}${ran.stderr}`);
  }
});

test('store repair --remote stops, moving nothing and recording no alias, when a repo folder of the old key cannot be read', async (t) => {
  const { h, app, key, newKey, repair } = await renamedRemote(t);
  const folder = fileStore(ledgerPaths(h)).active.repoLocation(key);
  chmodSync(folder, 0o000);
  try {
    const ran = await repair(app, 'store', 'repair', '--remote', key);
    assert.notEqual(ran.status, 0, ran.stdout);
    assert.ok(ran.stderr.includes(folder), ran.stderr);
  } finally {
    chmodSync(folder, 0o755);
  }
  assert.equal(fileStore(ledgerPaths(h)).aliases.read().get(key), undefined);
  assert.deepEqual(filed(h, newKey), { active: [], backlog: [], archive: [] });
});

test('a repo folder of the store that cannot be read is passed over by ledger list and ledger show, so it stops no command of another repo', async (t) => {
  const { h, app } = setup(t);
  const repair = forStorage(h);
  await start(repair, app, 'fix-login');
  const other = fileStore(ledgerPaths(h)).active.repoLocation('github.com/someone/other');
  mkdirSync(other, { recursive: true });
  chmodSync(other, 0o000);
  try {
    assert.deepEqual((await listed(repair, app)).map(({ slug }) => slug), ['fix-login']);
    assert.match(await shown(repair, app, 'fix-login'), /fix-login/);
  } finally {
    chmodSync(other, 0o755);
  }
});

test('tree depends keeps one dependency on a task named by both the old and the new key of a renamed remote', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  ok(await repair(app, 'task', 'new', 'build', '--goal', 'Build it.'));
  ok(await repair(app, 'task', 'new', 'ship', '--goal', 'Ship it.'));
  renameOrigin(h, app);
  ok(await repair(app, 'store', 'repair', '--remote', key));
  rmSync(key, { recursive: true, force: true });

  ok(await repair(app, 'tree', 'depends', 'ship', `build@${key}`, 'build'));
  const line = (await shown(repair, app, 'ship')).match(/depends on: (.*)/)?.[1] ?? assert.fail('ship depends on nothing');
  assert.equal(line.split(', ').length, 1, line);
});

async function pendingForeignMove(t: TestContext, leaveBacklog = false) {
  const { h, app, key, repair } = await worldOf(t, 'git');
  await start(repair, app, 'fix-login');
  if (leaveBacklog) ok(await repair(app, 'task', 'new', 'idea', '--goal', 'Later.'));
  const store = openStore(ledgerPaths(h), 'git', { backgroundSync: false });
  assert.ok(store.active.update(key, 'fix-login', (text) => setLocationBullet(text, 'host', 'other-machine') ?? text));
  store.close?.();
  const newKey = renameOrigin(h, app);
  store.aliases.add(key, newKey);
  const { clone } = clonePaths(ledgerPaths(h));
  const [from, to] = [key, newKey].map((repo) => `active/${encodeURIComponent(repo)}/fix-login.json`);
  mkdirSync(path.dirname(path.join(clone, to)), { recursive: true });
  renameSync(path.join(clone, from), path.join(clone, to));
  return { h, app, key, repair, clone, from, to };
}

test('repair with work left commits the pending foreign move', async (t) => {
  const { h, app, key, repair, clone, from, to } = await pendingForeignMove(t, true);
  ok(await repair(app, 'store', 'repair', '--remote', key));
  const head = git(h, clone, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
  assert.ok(head.includes(to) && !head.includes(from), 'repair restored the foreign record under the old key');
});

test('sync commits the pending foreign move', async (t) => {
  const { h, app, repair, clone, from, to } = await pendingForeignMove(t);
  ok(await repair(app, 'store', 'sync'));
  const head = git(h, clone, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
  assert.ok(head.includes(to) && !head.includes(from), 'sync restored the foreign record under the old key');
  assert.ok(existsSync(path.join(clone, to)) && !existsSync(path.join(clone, from)));
});

test('a different blob cannot claim a foreign deletion', async (t) => {
  const { h, app, key, repair, clone, from, to } = await pendingForeignMove(t);
  const file = path.join(clone, to);
  writeFileSync(file, readFileSync(file, 'utf8').replace('other-machine', 'unrelated-machine'));
  ok(await repair(app, 'store', 'repair', '--remote', key));
  const head = git(h, clone, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
  assert.ok(head.includes(from), 'repair committed the foreign deletion');
  assert.ok(!head.includes(to), 'repair committed an unrelated foreign record as a move');
});

test('repair reports the unreadable old evidence folder', async (t) => {
  const { h, app, key, repair } = await worldOf(t, 'git');
  const newKey = renameOrigin(h, app);
  const store = openStore(ledgerPaths(h), 'git', { backgroundSync: false });
  const name = '2026-01-02-done-one';
  store.archive.write(newKey, name, ledgerText({ slug: 'done-one', main: app }));
  store.close?.();
  store.aliases.add(key, newKey);
  const evidence = store.archive.evidenceLocation(key, name);
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, 'red.txt'), 'the failing run\n');
  const folder = path.dirname(evidence);
  chmodSync(folder, 0o000);
  try {
    const ran = await repair(app, 'store', 'repair', '--remote', key);
    assert.notEqual(ran.status, 0, 'repair reported success with unreadable evidence');
    assert.ok(`${ran.stdout}${ran.stderr}`.includes(folder), 'repair omitted the unreadable folder');
  } finally {
    chmodSync(folder, 0o755);
  }
});

test('repair finishes a linked record after its checkout vanishes', async (t) => {
  const { h, app, key } = setup(t);
  const store = fileStore(ledgerPaths(h));
  store.backlog.write(key, 'idea', ledgerText({ slug: 'idea', main: path.join(h, 'gone') }));
  const newKey = renameOrigin(h, app);
  store.aliases.add(key, newKey);
  mkdirSync(store.backlog.repoLocation(newKey), { recursive: true });
  linkSync(store.backlog.location(key, 'idea'), store.backlog.location(newKey, 'idea'));
  const ran = await forStorage(h)(app, 'store', 'repair', '--remote', key);
  assert.equal(ran.status, 0, 'repair refused the linked record whose checkout vanished');
  assert.equal(store.backlog.has(key, 'idea'), false);
  assert.ok(store.backlog.has(newKey, 'idea'));
});

test('a case-mismatched destination cannot claim a foreign deletion', async (t) => {
  const { h, app, repair, clone, from, to } = await pendingForeignMove(t);
  const upper = path.join(path.dirname(to), 'FIX-LOGIN.json');
  if (!existsSync(path.join(clone, upper))) return t.skip('the test temp volume is case-sensitive');
  renameSync(path.join(clone, to), path.join(clone, upper));
  assert.ok(readdirSync(path.join(clone, path.dirname(to))).includes('FIX-LOGIN.json'));
  ok(await repair(app, 'store', 'sync'));
  const head = git(h, clone, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
  assert.ok(head.includes(from), 'sync committed the old-key deletion alone');
});

test('a matching old blob cannot replace a foreign record already in HEAD', async (t) => {
  const { h, app, repair, clone, from, to } = await pendingForeignMove(t);
  const file = path.join(clone, to);
  const old = readFileSync(file, 'utf8');
  const other = old.replace('other-machine', 'third-machine');
  assert.notEqual(old, other);
  writeFileSync(file, other);
  git(h, clone, 'add', '--', to);
  git(h, clone, 'commit', '--quiet', '-m', 'Another host owns the destination');
  writeFileSync(file, old);
  ok(await repair(app, 'store', 'sync'));
  assert.equal(git(h, clone, 'show', `HEAD:${to}`), other.trim(), 'sync overwrote the destination record in HEAD');
  assert.equal(git(h, clone, 'show', `HEAD:${from}`), old.trim());
});

test('repair refuses a half-moved backlog task whose slug is active at the destination', async (t) => {
  const { h, app, key } = setup(t);
  const store = fileStore(ledgerPaths(h));
  store.backlog.write(key, 'idea', ledgerText({ slug: 'idea', main: app }));
  const newKey = renameOrigin(h, app);
  store.aliases.add(key, newKey);
  mkdirSync(store.backlog.repoLocation(newKey), { recursive: true });
  linkSync(store.backlog.location(key, 'idea'), store.backlog.location(newKey, 'idea'));
  store.active.write(newKey, 'idea', ledgerText({ slug: 'idea', main: app }));
  const ran = await forStorage(h)(app, 'store', 'repair', '--remote', key);
  assert.equal(ran.status, 1, 'repair accepted the half-moved task despite the live slug collision');
  assert.match(ran.stdout, /left backlog idea: .* already has idea/);
  assert.ok(store.backlog.has(key, 'idea'));
});

test('repair reports an unlistable evidence root containing movable evidence', async (t) => {
  const { h, app, key, repair } = await worldOf(t, 'git');
  const newKey = renameOrigin(h, app);
  const store = openStore(ledgerPaths(h), 'git', { backgroundSync: false });
  const name = '2026-01-02-done-one';
  store.archive.write(newKey, name, ledgerText({ slug: 'done-one', main: app }));
  store.close?.();
  store.aliases.add(key, newKey);
  const evidence = store.archive.evidenceLocation(key, name);
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, 'red.txt'), 'the failing run\n');
  const root = path.dirname(path.dirname(evidence));
  chmodSync(root, 0o111);
  try {
    const ran = await repair(app, 'store', 'repair', '--remote', key);
    assert.notEqual(ran.status, 0, 'repair reported success with an unlistable evidence root');
    assert.ok(ran.stderr.includes(root), 'repair omitted the unlistable evidence root');
  } finally {
    chmodSync(root, 0o755);
  }
});

test('a case-different old record on disk is no pending move', async (t) => {
  const { h, app, repair, clone, from, to } = await pendingForeignMove(t);
  const upper = path.join(path.dirname(from), 'FIX-LOGIN.json');
  writeFileSync(path.join(clone, upper), readFileSync(path.join(clone, to)));
  if (!existsSync(path.join(clone, from))) return t.skip('the test temp volume is case-sensitive');
  ok(await repair(app, 'store', 'sync'));
  const head = git(h, clone, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
  assert.ok(head.includes(from), 'sync committed the old-key deletion while the record is on disk in another spelling');
  assert.ok(!head.includes(to), 'sync committed a foreign record as a move while its source is on disk in another spelling');
});

test('a case-variant destination in HEAD cannot claim a foreign deletion', async (t) => {
  const { h, app, repair, clone, from, to } = await pendingForeignMove(t);
  const upper = path.join(path.dirname(to), 'FIX-LOGIN.json');
  const target = path.join(clone, to);
  if (!existsSync(path.join(clone, upper))) return t.skip('the test temp volume is case-sensitive');
  const old = readFileSync(target, 'utf8');
  const other = old.replace('other-machine', 'third-machine');
  assert.notEqual(old, other);
  renameSync(target, path.join(clone, upper));
  writeFileSync(path.join(clone, upper), other);
  git(h, clone, 'add', '--', upper);
  git(h, clone, 'commit', '--quiet', '-m', 'Track the other host under its own spelling');
  const blob = git(h, clone, 'rev-parse', `HEAD:${upper}`);
  renameSync(path.join(clone, upper), target);
  writeFileSync(target, old);
  assert.ok(readdirSync(path.dirname(target)).includes(path.basename(to)));

  ok(await repair(app, 'task', 'new', 'idea', '--goal', 'Later.'));
  assert.equal(git(h, clone, 'rev-parse', `HEAD:${upper}`), blob, 'the ordinary commit overwrote the destination');
  assert.ok(git(h, clone, 'ls-tree', '--name-only', 'HEAD', '--', from).includes(from), 'the ordinary commit took the old-key deletion alone');
});

test('repair commits the foreign source deletion after its index flag is cleared', async (t) => {
  const { h, app, key, repair, clone, from, to } = await pendingForeignMove(t);
  git(h, clone, 'update-index', '--assume-unchanged', from);
  ok(await repair(app, 'store', 'sync'));
  const paths = (): string[] => git(h, clone, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
  assert.ok(paths().includes(from) && paths().includes(to), 'sync must leave both paths in HEAD while the deletion is hidden');
  git(h, clone, 'update-index', '--no-assume-unchanged', from);

  ok(await repair(app, 'store', 'repair', '--remote', key));
  const head = paths();
  assert.ok(head.includes(to) && !head.includes(from), 'repair left the old-key record in HEAD after the deletion became visible');
});

test('repair checks the record slug when only hidden Markdown remains at the old key', async (t) => {
  const { h, app, key } = setup(t);
  const store = fileStore(ledgerPaths(h));
  const newKey = renameOrigin(h, app);
  store.aliases.add(key, newKey);
  store.backlog.write(key, 'ship', ledgerText({ slug: 'ship', main: app }));
  const [from, to] = [key, newKey].map((repo) => store.backlog.repoLocation(repo));
  writeFileSync(path.join(from, 'ship.md'), ledgerText({ slug: 'draft', main: app }));
  mkdirSync(to, { recursive: true });
  for (const file of ['ship.json', 'ship.md']) linkSync(path.join(from, file), path.join(to, file));
  rmSync(path.join(from, 'ship.json'));
  store.active.write(newKey, 'ship', ledgerText({ slug: 'ship', main: app }));

  const ran = await forStorage(h)(app, 'store', 'repair', '--remote', key);
  assert.equal(ran.status, 1, 'repair accepted the conflicting destination record slug');
  assert.match(ran.stdout, /left backlog ship: .* already has ship/);
  assert.ok(existsSync(path.join(from, 'ship.md')));
});

test('repair reports an unreadable case-variant evidence repo folder', async (t) => {
  const { h, app, key, repair } = await worldOf(t, 'git');
  const newKey = renameOrigin(h, app);
  const store = openStore(ledgerPaths(h), 'git', { backgroundSync: false });
  const name = '2026-01-02-done-one';
  store.archive.write(newKey, name, ledgerText({ slug: 'done-one', main: app }));
  store.close?.();
  store.aliases.add(key, newKey);
  const evidence = store.archive.evidenceLocation(key, name);
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, 'red.txt'), 'the failing run\n');
  const folder = path.dirname(evidence);
  const upper = path.join(path.dirname(folder), path.basename(folder).toUpperCase());
  assert.notEqual(upper, folder);
  if (!existsSync(upper)) return t.skip('the test temp volume is case-sensitive');
  renameSync(folder, upper);
  chmodSync(upper, 0o000);
  try {
    const ran = await repair(app, 'store', 'repair', '--remote', key);
    assert.notEqual(ran.status, 0, 'repair reported success with unreadable case-variant evidence');
    assert.ok(ran.stderr.toLowerCase().includes(folder.toLowerCase()), ran.stderr);
    assert.doesNotMatch(ran.stdout, /Nothing is left/);
  } finally {
    chmodSync(upper, 0o755);
  }
});

test('repair checks the record slug when hidden Markdown under the old key is linked in another case under the new key', async (t) => {
  const { h, app, key } = setup(t);
  const store = fileStore(ledgerPaths(h));
  const newKey = renameOrigin(h, app);
  store.aliases.add(key, newKey);
  store.backlog.write(key, 'ship', ledgerText({ slug: 'ship', main: app }));
  const [from, to] = [key, newKey].map((repo) => store.backlog.repoLocation(repo));
  writeFileSync(path.join(from, 'ship.md'), ledgerText({ slug: 'draft', main: app }));
  mkdirSync(to, { recursive: true });
  if (!existsSync(path.join(from, 'SHIP.md'))) return t.skip('the test temp volume is case-sensitive');
  for (const file of ['ship.json', 'ship.md']) linkSync(path.join(from, file), path.join(to, file.replace('ship', 'SHIP')));
  rmSync(path.join(from, 'ship.json'));
  store.active.write(newKey, 'ship', ledgerText({ slug: 'ship', main: app }));

  for (const dryRun of [['--dry-run'], []]) {
    const ran = await forStorage(h)(app, 'store', 'repair', '--remote', key, ...dryRun);
    assert.notEqual(ran.status, 0, `repair ${dryRun.join(' ')} accepted the destination record slug listed in another case`);
    assert.match(ran.stdout, /left backlog ship: .* already has ship/);
    assert.doesNotMatch(ran.stdout, /would move backlog ship|moved backlog ship/);
  }
  assert.ok(existsSync(path.join(from, 'ship.md')));
});

test('repair refuses two half-moved ledgers of one slug, one backlog and one active', async (t) => {
  const { h, app, key } = setup(t);
  const store = fileStore(ledgerPaths(h));
  const newKey = renameOrigin(h, app);
  store.aliases.add(key, newKey);
  for (const place of ['backlog', 'active'] as const) {
    store[place].write(key, 'ship', ledgerText({ slug: 'ship', main: app }));
    mkdirSync(store[place].repoLocation(newKey), { recursive: true });
    linkSync(store[place].location(key, 'ship'), store[place].location(newKey, 'ship'));
  }

  const ran = await forStorage(h)(app, 'store', 'repair', '--remote', key);
  assert.notEqual(ran.status, 0, 'repair accepted two half-moved ledgers of one slug');
  for (const place of ['backlog', 'active'] as const) {
    assert.match(ran.stdout, new RegExp(`left ${place} ship: .* already has ship`));
    assert.ok(store[place].has(key, 'ship'), `the ${place} ledger was moved`);
  }
});

test('store repair <slug> --to keeps a main line under ~ that names the main checkout, in a dry run too', async (t) => {
  const { h, app, key } = setup(t);
  const repair = forStorage(h);
  const { worktree } = await start(repair, app, 'fix-login');
  const store = fileStore(ledgerPaths(h));
  store.active.update(key, 'fix-login', (text) => setLocationBullet(text, 'main', '~/repos/app') ?? text);
  const moved = path.join(h, 'moved', 'fix-login');
  mkdirSync(path.dirname(moved), { recursive: true });
  renameSync(worktree, moved);

  assert.ok(!ok(await repair(app, 'store', 'repair', 'fix-login', '--to', moved, '--dry-run')).includes('main checkout'));
  assert.ok(!ok(await repair(app, 'store', 'repair', 'fix-login', '--to', moved)).includes('main checkout'));
  assert.match(store.active.read(key, 'fix-login')?.text ?? '', /^- main: ~\/repos\/app$/m);
});
