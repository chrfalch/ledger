import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { deleteInBackground } from '../tools/ledger/worktrees.js';
import { snapshot } from './helpers.js';
import { backlogTask, git, home, ledger, lineWith, ok, repository, worktreeTask, type Ran } from './ledger-core-fixtures.js';

/** A HOME with the repo ~/repos/app, whose build output and .claude/ folders git ignores. */
function setup(t: TestContext) {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  writeFileSync(path.join(app, '.git/info/exclude'), '.claude/\nbuild/\nnode_modules/\n.cache/\n');
  return { h, app };
}

const worktreeOf = (main: string, slug: string): string => path.join(main, '.claude/worktrees', slug);
const buildRoot = (main: string): string => path.join(realpathSync(main), '.claude/worktrees/.build');

/** A file of `megabytes` MB of real blocks, so du counts it; the prune floor is 0.05 GB. */
function bigFile(file: string, megabytes = 55): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(megabytes * 1_000_000, 1));
}

/** The table row of the worktree `name`: the line that starts with it. */
const row = (output: string, name: string): string =>
  output.split('\n').find((line) => line.startsWith(`${name} `)) ?? assert.fail(`no row for ${name} in:\n${output}`);

function smallFile(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'small');
}

function stubGh(h: string, script: string): void {
  const file = path.join(h, 'stub-bin/gh');
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
}

function failed(ran: Ran, pattern: RegExp): void {
  assert.equal(ran.status, 1, `exit 1 expected; stdout:\n${ran.stdout}\nstderr:\n${ran.stderr}`);
  assert.match(ran.stderr, pattern);
}

test('ledger worktrees --help names the table and each subcommand, and each subcommand has its own --help', (t) => {
  const { h } = setup(t);
  const stdout = ok(ledger(h, h, 'worktrees', '--help'));
  for (const command of ['prune', 'prune-orphans']) assert.match(stdout, new RegExp(`^\\s+${command}\\b`, 'm'));
  assert.doesNotMatch(stdout, /derived-data/);
  assert.match(ok(ledger(h, h, 'worktrees', 'prune', '--help')), /--all[\s\S]*--dry-run|--dry-run[\s\S]*--all/);
  assert.match(ok(ledger(h, h, 'worktrees', 'prune-orphans', '--help')), /--dry-run/);
  assert.match(ok(ledger(h, h, '--help')), /^\s+worktrees\b/m);
});

test('ledger worktrees shows each linked worktree with its last commit, dirty files, ledger role and PR; not the main checkout', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- part'] });
  backlogTask(h, app, { slug: 'part', parent: 'epic' });
  worktreeTask(h, app, { slug: 'child', parent: 'epic' });
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'me/bare', worktreeOf(app, 'bare'), 'main');
  writeFileSync(path.join(worktreeOf(app, 'epic'), 'scratch.txt'), 'x');
  stubGh(h, `case "$*" in *"--head me/epic "*) echo '[{"state":"OPEN","number":3}]' ;; *) echo '[]' ;; esac`);
  const stdout = ok(ledger(h, app, 'worktrees'));
  assert.match(stdout, /^Worktrees · 3 worktrees/m);
  const date = git(h, app, 'log', '-1', '--format=%cs');
  const epic = row(stdout, 'epic');
  for (const cell of [date, 'parent of 1', 'OPEN #3']) assert.ok(epic.includes(cell), `${cell} in: ${epic}`);
  assert.match(epic, /\s1\s/);
  assert.ok(row(stdout, 'child').includes('child of epic'));
  assert.match(row(stdout, 'bare'), /\bno\b.*\bnone$/);
  assert.doesNotMatch(stdout, /^app\s/m);
});

test('ledger worktrees shows ? for a PR gh cannot look up, and says why', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic' });
  const stdout = ok(ledger(h, app, 'worktrees'));
  assert.match(row(stdout, 'epic'), /\?$/);
  assert.match(stdout, /gh pr list/);
});

test("ledger worktrees prune --dry-run lists the ignored build folders and the worktree's folder in .claude/worktrees/.build above 0.05 GB, and changes nothing; prune deletes them", (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const worktree = worktreeOf(app, 'fix-login');
  bigFile(path.join(worktree, 'build/out.bin'));
  bigFile(path.join(worktree, 'node_modules/pkg/build/out.bin'));
  smallFile(path.join(worktree, '.cache/small.txt'));
  const xcode = path.join(buildRoot(app), 'fix-login');
  bigFile(path.join(xcode, 'Debug-sim/Build/app.o'));
  const otherXcode = [path.join(buildRoot(app), 'fix-login-2'), path.join(buildRoot(app), '.main')];
  for (const other of otherXcode) bigFile(path.join(other, 'Debug-sim/Build/app.o'));

  const before = snapshot(h);
  const plan = ok(ledger(h, app, 'worktrees', 'prune', 'fix-login', '--dry-run'));
  assert.deepEqual(snapshot(h), before);
  assert.match(plan, /dry run/i);
  assert.match(lineWith(plan, 'build'), /0\.1/);
  assert.match(lineWith(plan, '.claude/worktrees/.build/fix-login '), /0\.1/);
  for (const kept of ['node_modules', '.cache', '.build/fix-login-2', '.build/.main']) assert.ok(!plan.includes(kept) || /never|kept/.test(lineWith(plan, kept)), `${kept} is not planned`);

  const pruned = ok(ledger(h, app, 'worktrees', 'prune', 'fix-login'));
  assert.match(pruned, /freed/);
  assert.equal(existsSync(path.join(worktree, 'build')), false);
  assert.equal(existsSync(xcode), false);
  assert.ok(existsSync(path.join(worktree, 'node_modules/pkg/build/out.bin')));
  assert.ok(existsSync(path.join(worktree, '.cache/small.txt')));
  for (const other of otherXcode) assert.ok(existsSync(other), other);
});

/** The folders whose symbolic link would send a delete in the build root outside the main checkout. */
const LINKABLE = ['.claude', '.claude/worktrees', '.claude/worktrees/.build'];

/** Makes `<app>/<linked>` a symbolic link to an empty folder outside the repo, and returns that folder. */
function linkOut(h: string, app: string, linked: string): string {
  const target = path.join(h, 'elsewhere', linked);
  mkdirSync(target, { recursive: true });
  mkdirSync(path.dirname(path.join(app, linked)), { recursive: true });
  symlinkSync(target, path.join(app, linked));
  return target;
}

test('ledger worktrees prune exits 1 and deletes no build folder in .claude/worktrees/.build when it, or a folder above it, is a symbolic link', (t) => {
  for (const linked of LINKABLE) {
    const { h, app } = setup(t);
    linkOut(h, app, linked);
    worktreeTask(h, app, { slug: 'fix-login' });
    const object = path.join(app, '.claude/worktrees/.build/fix-login/Debug-sim/Build/app.o');
    bigFile(object);
    const ran = ledger(h, app, 'worktrees', 'prune', 'fix-login');
    assert.equal(ran.status, 1, `${linked}: ${ran.stdout}${ran.stderr}`);
    assert.match(ran.stdout, /is a symbolic link/, linked);
    assert.ok(existsSync(object), linked);
  }
});

test('ledger worktrees prune keeps the build folder of a worktree whose name another worktree shares regardless of case, or whose name is .main', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'me/other', path.join(h, 'elsewhere/Fix-Login'), 'main');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'me/dot', worktreeOf(app, '.main'), 'main');
  for (const name of ['fix-login', '.main']) {
    const object = path.join(buildRoot(app), name, 'Debug-sim/Build/app.o');
    bigFile(object);
    const stdout = ok(ledger(h, app, 'worktrees', 'prune', name));
    assert.ok(stdout.includes(`Skipped ${path.join(buildRoot(app), name)}: `), stdout);
    assert.ok(existsSync(object), name);
  }
});

test("ledger worktrees prune skips the worktree's build folder in .claude/worktrees/.build when that folder is a symbolic link, and leaves the link and its target as they were", (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const target = path.join(h, 'precious');
  smallFile(path.join(target, 'keep.txt'));
  const link = path.join(buildRoot(app), 'fix-login');
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(target, link);
  // A du that reports 60 MB for any folder, so the link passes the 0.05 GB floor and reaches the safety check.
  writeFileSync(path.join(h, 'stub-bin/du'), '#!/bin/sh\nprintf "58594\\t%s\\n" "$2"\n');
  chmodSync(path.join(h, 'stub-bin/du'), 0o755);
  const stdout = ok(ledger(h, app, 'worktrees', 'prune', 'fix-login'));
  assert.ok(stdout.includes(`Skipped ${link}: it is a symbolic link.`), stdout);
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.ok(existsSync(path.join(target, 'keep.txt')));
});

test('ledger worktrees prune never deletes an ignored build folder of the worktree that is a symbolic link, nor what it points to', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const target = path.join(h, 'precious');
  smallFile(path.join(target, 'keep.txt'));
  const link = path.join(worktreeOf(app, 'fix-login'), 'build');
  symlinkSync(target, link);
  writeFileSync(path.join(h, 'stub-bin/du'), '#!/bin/sh\nprintf "58594\\t%s\\n" "$2"\n');
  chmodSync(path.join(h, 'stub-bin/du'), 0o755);
  for (const args of [['fix-login'], ['--all']]) {
    ok(ledger(h, app, 'worktrees', 'prune', ...args));
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.ok(existsSync(path.join(target, 'keep.txt')));
  }
});

test('ledger worktrees prune exits 1 when a folder could not be deleted, and still prints the report', { skip: process.getuid?.() === 0 }, (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const locked = path.join(worktreeOf(app, 'fix-login'), 'build/locked');
  smallFile(path.join(locked, 'out.o'));
  writeFileSync(path.join(h, 'stub-bin/du'), '#!/bin/sh\nprintf "58594\\t%s\\n" "$2"\n');
  chmodSync(path.join(h, 'stub-bin/du'), 0o755);
  chmodSync(locked, 0o555);
  // Here, not in t.after: the HOME cleanup registered earlier runs first and could not delete the locked folder.
  try {
    for (const args of [['fix-login'], ['--all']]) {
      const ran = ledger(h, app, 'worktrees', 'prune', ...args);
      assert.equal(ran.status, 1, `prune ${args.join(' ')}: ${ran.stdout}${ran.stderr}`);
      assert.match(ran.stdout, /^Could not delete build: /m);
      assert.ok(existsSync(path.join(locked, 'out.o')));
    }
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('ledger worktrees prune --all --dry-run covers every linked worktree; a worktree with nothing to prune says so', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'one' });
  worktreeTask(h, app, { slug: 'two' });
  assert.match(ok(ledger(h, app, 'worktrees', 'prune', '--all', '--dry-run')), /Nothing to prune in any linked worktree\./);
  smallFile(path.join(worktreeOf(app, 'two'), 'build/x'));
  assert.match(ok(ledger(h, app, 'worktrees', 'prune', '--all')), /Nothing to prune in any linked worktree\./);
  assert.ok(existsSync(path.join(worktreeOf(app, 'two'), 'build/x')), 'below the floor, so kept');
});

test('ledger worktrees prune refuses an unknown name, a name with --all, and neither', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'one' });
  failed(ledger(h, app, 'worktrees', 'prune', 'nosuch'), /^No linked worktree named "nosuch"\. Worktrees: one/m);
  failed(ledger(h, app, 'worktrees', 'prune', 'one', '--all'), /either/i);
  failed(ledger(h, app, 'worktrees', 'prune'), /either/i);
});

/** The build folders of the main checkout, of the linked worktree fix-login, and of the removed worktree gone. */
function orphanWorld(t: TestContext) {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const root = buildRoot(app);
  for (const name of ['.main', 'fix-login', 'gone']) smallFile(path.join(root, name, 'Debug-sim/info.plist'));
  return { h, app, root };
}

test('ledger worktrees derived-data is gone', (t) => {
  const { h, app } = setup(t);
  const ran = ledger(h, app, 'worktrees', 'derived-data');
  assert.notEqual(ran.status, 0);
});

test('ledger worktrees prune-orphans --dry-run lists only the build folders no worktree matches and changes nothing; without it, it deletes them', (t) => {
  const { h, app, root } = orphanWorld(t);
  const before = snapshot(h);
  const plan = ok(ledger(h, app, 'worktrees', 'prune-orphans', '--dry-run'));
  assert.deepEqual(snapshot(h), before);
  assert.match(plan, /dry run/i);
  assert.match(plan, /^gone\s/m);
  for (const kept of ['.main', 'fix-login']) assert.doesNotMatch(plan, new RegExp(`^${kept.replace('.', '\\.')}\\s`, 'm'), `${kept} is no orphan`);
  const pruned = ok(ledger(h, app, 'worktrees', 'prune-orphans'));
  assert.match(pruned, /freed/);
  assert.equal(existsSync(path.join(root, 'gone')), false);
  for (const kept of ['.main', 'fix-login']) assert.ok(existsSync(path.join(root, kept)), kept);
});

test('ledger worktrees prune-orphans from a linked worktree prunes the build folders of its repo', (t) => {
  const { h, app, root } = orphanWorld(t);
  ok(ledger(h, worktreeOf(app, 'fix-login'), 'worktrees', 'prune-orphans'));
  assert.equal(existsSync(path.join(root, 'gone')), false);
  assert.ok(existsSync(path.join(root, 'fix-login')));
});

test('ledger worktrees prune-orphans keeps the build folder of a worktree git still lists while its folder is missing', (t) => {
  const { h, app, root } = orphanWorld(t);
  rmSync(worktreeOf(app, 'fix-login'), { recursive: true, force: true });
  ok(ledger(h, app, 'worktrees', 'prune-orphans'));
  assert.ok(existsSync(path.join(root, 'fix-login')));
});

test('ledger worktrees prune-orphans skips an orphan that is a symbolic link, and leaves the link and its target as they were', (t) => {
  const { h, app, root } = orphanWorld(t);
  const target = path.join(h, 'precious');
  smallFile(path.join(target, 'keep.txt'));
  const link = path.join(root, 'linked');
  symlinkSync(target, link);
  const stdout = ok(ledger(h, app, 'worktrees', 'prune-orphans'));
  assert.ok(stdout.includes(`Skipped ${link}: it is a symbolic link.`), stdout);
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.ok(existsSync(path.join(target, 'keep.txt')));
});

test('ledger worktrees prune-orphans exits 1 and deletes nothing when git cannot list the worktrees', (t) => {
  const { h, app, root } = orphanWorld(t);
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  // A git that fails only for `worktree list`, so the CLI still finds the repo.
  writeFileSync(path.join(h, 'stub-bin/git'), `#!/bin/sh\ncase "$*" in *"worktree list"*) echo "fatal: no list" >&2; exit 128 ;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(path.join(h, 'stub-bin/git'), 0o755);
  const before = snapshot(h);
  for (const args of [[], ['--dry-run']]) {
    const ran = ledger(h, app, 'worktrees', 'prune-orphans', ...args);
    assert.equal(ran.status, 1, `prune-orphans ${args.join(' ')}: ${ran.stdout}${ran.stderr}`);
    assert.ok(`${ran.stdout}${ran.stderr}`.includes('Could not list the worktrees of ~/repos/app, so nothing was pruned.'), ran.stdout + ran.stderr);
  }
  assert.deepEqual(snapshot(h), before);
  for (const name of ['.main', 'fix-login', 'gone']) assert.ok(existsSync(path.join(root, name)), name);
});

test('ledger worktrees prune-orphans stops and exits 1 when git cannot list the worktrees again before a delete', (t) => {
  const { h, app, root } = orphanWorld(t);
  smallFile(path.join(root, 'gone-2/Debug-sim/info.plist'));
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const [calls, limit] = [path.join(h, 'list-calls'), path.join(h, 'list-limit')];
  // A git that counts each `worktree list` and fails every one after the number in list-limit.
  writeFileSync(
    path.join(h, 'stub-bin/git'),
    `#!/bin/sh\ncase "$*" in *"worktree list"*) echo x >> ${JSON.stringify(calls)}; if [ "$(wc -l < ${JSON.stringify(calls)})" -gt "$(cat ${JSON.stringify(limit)} 2>/dev/null || echo 1000)" ]; then echo "fatal: no list" >&2; exit 128; fi ;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(path.join(h, 'stub-bin/git'), 0o755);
  // A dry run lists as often as a prune does before its first delete; one more list lets exactly one delete through.
  ok(ledger(h, app, 'worktrees', 'prune-orphans', '--dry-run'));
  const beforeTheDeletes = readFileSync(calls, 'utf8').trim().split('\n').length;
  rmSync(calls);
  writeFileSync(limit, String(beforeTheDeletes + 1));
  const ran = ledger(h, app, 'worktrees', 'prune-orphans');
  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /Could not list the worktrees/);
  assert.equal(['gone', 'gone-2'].filter((name) => existsSync(path.join(root, name))).length, 1);
});

test('ledger worktrees prune-orphans exits 1 and deletes nothing when .claude/worktrees/.build, or a folder above it, is a symbolic link', (t) => {
  for (const linked of LINKABLE) {
    const { h, app } = setup(t);
    const target = linkOut(h, app, linked);
    const orphan = path.join(app, '.claude/worktrees/.build/gone/Debug-sim/info.plist');
    smallFile(orphan);
    for (const args of [[], ['--dry-run']]) {
      const ran = ledger(h, app, 'worktrees', 'prune-orphans', ...args);
      assert.equal(ran.status, 1, `${linked} ${args.join(' ')}: ${ran.stdout}${ran.stderr}`);
      assert.match(ran.stdout + ran.stderr, /is a symbolic link, so nothing was pruned/, linked);
    }
    assert.ok(existsSync(orphan), linked);
    assert.ok(existsSync(target), linked);
  }
});

test('ledger worktrees prune-orphans keeps a build folder whose name differs from its worktree only in case', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const folder = path.join(buildRoot(app), 'Fix-Login');
  smallFile(path.join(folder, 'Debug-sim/info.plist'));
  assert.match(ok(ledger(h, app, 'worktrees', 'prune-orphans', '--dry-run')), /^Nothing to prune: no orphans in /);
  ok(ledger(h, app, 'worktrees', 'prune-orphans'));
  assert.ok(existsSync(path.join(folder, 'Debug-sim/info.plist')));
});

test('ledger worktrees prune-orphans with no build folders, or only those of live checkouts, has nothing to prune', (t) => {
  const { h, app } = setup(t);
  assert.match(ok(ledger(h, app, 'worktrees', 'prune-orphans')), /^Nothing to prune: no orphans in /);
  worktreeTask(h, app, { slug: 'fix-login' });
  smallFile(path.join(buildRoot(app), 'fix-login/Debug-sim/info.plist'));
  smallFile(path.join(buildRoot(app), '.main/Debug-sim/info.plist'));
  assert.match(ok(ledger(h, app, 'worktrees', 'prune-orphans', '--dry-run')), /^Nothing to prune: no orphans in /);
});

test('deleteInBackground warns, and does not crash, when the background rm cannot start', async (t) => {
  const { h } = setup(t);
  const trashParent = path.join(h, 'trash-parent');
  const folder = path.join(trashParent, 'fix-login');
  mkdirSync(folder, { recursive: true });
  const saved = process.env.PATH;
  process.env.PATH = path.join(h, 'no-programs-here');
  t.after(() => {
    process.env.PATH = saved;
  });
  const warnings: string[] = [];
  t.mock.method(console, 'error', (text: string) => warnings.push(text));
  deleteInBackground([folder], trashParent);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(existsSync(folder), false);
  assert.match(warnings.join('\n'), /^warning: .*rm/m);
});

test('ledger worktrees outside a git repository says so', (t) => {
  const { h } = setup(t);
  failed(ledger(h, h, 'worktrees'), /not inside a git repository/);
});
