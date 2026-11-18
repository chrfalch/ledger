import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
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
const derivedData = (h: string): string => path.join(h, 'Library/Developer/Xcode/DerivedData');
const ownXcodeFolder = (h: string, worktree: string, config: string): string => {
  const real = realpathSync(worktree);
  return path.join(derivedData(h), `cc-${path.basename(real)}-${createHash('sha1').update(real).digest('hex').slice(0, 6)}-${config}`);
};

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

function plist(folder: string, workspace: string): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    path.join(folder, 'info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict><key>WorkspacePath</key><string>' + workspace + '</string></dict></plist>',
      '',
    ].join('\n'),
  );
}

test('ledger worktrees --help names the table and each subcommand, and each subcommand has its own --help', (t) => {
  const { h } = setup(t);
  const stdout = ok(ledger(h, h, 'worktrees', '--help'));
  for (const command of ['prune', 'derived-data', 'prune-orphans']) assert.match(stdout, new RegExp(`^\\s+${command}\\b`, 'm'));
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

test('ledger worktrees prune --dry-run lists the ignored build folders and own Xcode folders above 0.05 GB, and changes nothing; prune deletes them', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const worktree = worktreeOf(app, 'fix-login');
  bigFile(path.join(worktree, 'build/out.bin'));
  bigFile(path.join(worktree, 'node_modules/pkg/build/out.bin'));
  smallFile(path.join(worktree, '.cache/small.txt'));
  const xcode = ownXcodeFolder(h, worktree, 'Debug-sim');
  bigFile(path.join(xcode, 'Build/app.o'));
  const otherXcode = path.join(derivedData(h), 'cc-fix-login-000000-Debug-sim');
  bigFile(path.join(otherXcode, 'Build/app.o'), 1);

  const before = snapshot(h);
  const plan = ok(ledger(h, app, 'worktrees', 'prune', 'fix-login', '--dry-run'));
  assert.deepEqual(snapshot(h), before);
  assert.match(plan, /dry run/i);
  assert.match(lineWith(plan, 'build'), /0\.1/);
  assert.ok(plan.includes(path.basename(xcode)));
  for (const kept of ['node_modules', '.cache', 'cc-fix-login-000000']) assert.ok(!plan.includes(kept) || /never|kept/.test(lineWith(plan, kept)), `${kept} is not planned`);

  const pruned = ok(ledger(h, app, 'worktrees', 'prune', 'fix-login'));
  assert.match(pruned, /freed/);
  assert.equal(existsSync(path.join(worktree, 'build')), false);
  assert.equal(existsSync(xcode), false);
  assert.ok(existsSync(path.join(worktree, 'node_modules/pkg/build/out.bin')));
  assert.ok(existsSync(path.join(worktree, '.cache/small.txt')));
  assert.ok(existsSync(otherXcode));
});

test('ledger worktrees prune skips an own Xcode folder that is a symbolic link, and leaves the link and its target as they were', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const target = path.join(h, 'precious');
  smallFile(path.join(target, 'keep.txt'));
  const link = ownXcodeFolder(h, worktreeOf(app, 'fix-login'), 'Debug-link');
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

/** DerivedData folders of every group: main checkout, linked worktree, other location, orphan, no source, shared cache. */
function derivedDataWorld(t: TestContext) {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const worktree = worktreeOf(app, 'fix-login');
  mkdirSync(path.join(app, 'App.xcworkspace'));
  mkdirSync(path.join(worktree, 'App.xcworkspace'));
  mkdirSync(path.join(h, 'other/Other.xcodeproj'), { recursive: true });
  const dd = derivedData(h);
  plist(path.join(dd, 'App-main'), path.join(app, 'App.xcworkspace'));
  plist(path.join(dd, 'App-wt'), path.join(worktree, 'App.xcworkspace'));
  plist(path.join(dd, 'Other-x'), path.join(h, 'other/Other.xcodeproj'));
  plist(path.join(dd, 'Gone-y'), path.join(h, 'gone/Gone.xcodeproj'));
  mkdirSync(path.join(dd, 'NoPlist-z'));
  mkdirSync(path.join(dd, 'ModuleCache.noindex'));
  return { h, app, dd };
}

test('ledger worktrees derived-data groups the DerivedData folders by the project they were built from', (t) => {
  const { h, app } = derivedDataWorld(t);
  const stdout = ok(ledger(h, app, 'worktrees', 'derived-data'));
  const groups: [string, string][] = [
    ['Main checkout', 'App-main'],
    ['Linked worktree fix-login', 'App-wt'],
    ['Other location', 'Other-x'],
    ['Orphan', 'Gone-y'],
    ['No source recorded', 'NoPlist-z'],
    ['Shared caches', 'ModuleCache.noindex'],
  ];
  let last = -1;
  for (const [label, folder] of groups) {
    const at = stdout.indexOf(label);
    assert.ok(at > last, `${label} comes after the group before it:\n${stdout}`);
    const next = groups.map(([other]) => stdout.indexOf(other)).filter((index) => index > at).sort((a, b) => a - b)[0] ?? stdout.length;
    const folderAt = stdout.indexOf(folder, at);
    assert.ok(folderAt > at && folderAt < next, `${folder} is under ${label}:\n${stdout}`);
    last = at;
  }
  assert.match(stdout, /prune-orphans/);
});

test('ledger worktrees prune-orphans --dry-run lists only the orphans and changes nothing; without it, it deletes them', (t) => {
  const { h, app, dd } = derivedDataWorld(t);
  const before = snapshot(h);
  const plan = ok(ledger(h, app, 'worktrees', 'prune-orphans', '--dry-run'));
  assert.deepEqual(snapshot(h), before);
  assert.ok(plan.includes('Gone-y'));
  for (const kept of ['App-main', 'App-wt', 'Other-x', 'NoPlist-z', 'ModuleCache.noindex']) assert.ok(!plan.includes(kept), `${kept} is no orphan`);
  ok(ledger(h, app, 'worktrees', 'prune-orphans'));
  assert.equal(existsSync(path.join(dd, 'Gone-y')), false);
  for (const kept of ['App-main', 'App-wt', 'Other-x', 'NoPlist-z', 'ModuleCache.noindex']) assert.ok(existsSync(path.join(dd, kept)), kept);
});

test('ledger worktrees prune-orphans keeps, with a warning, a folder whose project cannot be checked; only a missing project makes an orphan', { skip: process.getuid?.() === 0 }, (t) => {
  const { h, app, dd } = derivedDataWorld(t);
  const locked = path.join(h, 'locked');
  mkdirSync(path.join(locked, 'Locked.xcodeproj'), { recursive: true });
  plist(path.join(dd, 'Locked-q'), path.join(locked, 'Locked.xcodeproj'));
  chmodSync(locked, 0o000);
  let ran: Ran;
  try {
    const plan = ledger(h, app, 'worktrees', 'prune-orphans', '--dry-run');
    assert.equal(plan.status, 0, plan.stderr);
    assert.ok(!plan.stdout.includes('Locked-q'), plan.stdout);
    ran = ledger(h, app, 'worktrees', 'prune-orphans');
  } finally {
    chmodSync(locked, 0o755);
  }
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stderr, /^warning: .*Locked\.xcodeproj.*EACCES.*Locked-q/m);
  assert.ok(existsSync(path.join(dd, 'Locked-q')));
  assert.equal(existsSync(path.join(dd, 'Gone-y')), false);
});

test('deleteInBackground warns, and does not crash, when the background rm cannot start', async (t) => {
  const { h } = setup(t);
  const trashParent = path.join(h, 'trash-parent');
  const folder = path.join(trashParent, 'cc-app-000000-Debug-sim');
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
