import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { snapshot } from './helpers.js';
import { archivedTask, backlogTask, git, home, ledger, ledgerText, lineWith, ok, repository, worktreeTask, type Ran } from './ledger-core-fixtures.js';
import { Failure } from '../tools/ledger/failure.js';
import { fileStore } from '../tools/ledger/file-store.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { executeRetire, planRetire, readRetire } from '../tools/ledger/retire.js';
import type { Context } from '../tools/ledger/write.js';

/** A HOME with the repo ~/repos/app, whose untracked .claude/ folders git ignores, as a real repo's .gitignore does. */
function setup(t: TestContext) {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  writeFileSync(path.join(app, '.git/info/exclude'), '.claude/\n');
  return { h, app };
}

const read = (file: string): string => readFileSync(file, 'utf8');
const worktreeOf = (main: string, slug: string): string => path.join(main, '.claude/worktrees', slug);
const archiveFolder = (h: string, main: string): string => path.join(h, '.claude/ledger-archive', path.basename(main));
const archiveList = (h: string, main: string): string[] => (existsSync(archiveFolder(h, main)) ? readdirSync(archiveFolder(h, main)).sort() : []);
const derivedData = (h: string): string => path.join(h, 'Library/Developer/Xcode/DerivedData');
type RegistryEntry = { slug: string; status: string; archivePath?: string };
const registry = (h: string): RegistryEntry[] => JSON.parse(read(path.join(h, '.claude/ledgers.json')));

function today(): string {
  const date = new Date();
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(2, '0')).join('-');
}

/** Replaces the `gh` on PATH with a shell script. */
function stubGh(h: string, script: string): void {
  const file = path.join(h, 'stub-bin/gh');
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
}

const mergedPr = (h: string, head: string): void => stubGh(h, `echo '[{"number":7,"headRefOid":"${head}"}]'`);
const noPr = (h: string): void => stubGh(h, "echo '[]'");

function failed(ran: Ran, pattern: RegExp): void {
  assert.equal(ran.status, 1, `exit 1 expected; stdout:\n${ran.stdout}\nstderr:\n${ran.stderr}`);
  assert.match(ran.stderr, pattern);
}

/** A commit on the worktree's branch, so it is one commit ahead of origin/main. */
function commitIn(h: string, worktree: string, name = 'work.txt'): string {
  writeFileSync(path.join(worktree, name), 'work\n');
  git(h, worktree, 'add', name);
  git(h, worktree, 'commit', '--quiet', '-m', `add ${name}`);
  return git(h, worktree, 'rev-parse', 'HEAD');
}

test('ledger retire --help names the slug, --dry-run and --force', (t) => {
  const { h } = setup(t);
  const stdout = ok(ledger(h, h, 'retire', '--help'));
  assert.match(stdout, /^Usage: ledger retire \[options\] \[slug\]/m);
  for (const pattern of [/--dry-run/, /--force/]) assert.match(stdout, pattern);
  assert.match(ok(ledger(h, h, '--help')), /^\s+retire\b/m);
});

test('ledger retire with no slug retires the task of the worktree it runs in: archive copy, worktree gone, branch deleted, registry archived', (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'fix-login' });
  const text = read(file);
  const worktree = worktreeOf(app, 'fix-login');
  const stdout = ok(ledger(h, worktree, 'retire'));
  const copy = path.join(archiveFolder(h, app), `${today()}-fix-login.md`);
  assert.equal(read(copy), text);
  assert.match(stdout, new RegExp(`archived ${copy.replaceAll('/', '\\/')}`));
  assert.equal(existsSync(worktree), false);
  assert.match(stdout, /deleted +branch me\/fix-login/);
  assert.equal(git(h, app, 'branch', '--list', 'me/fix-login'), '');
  const entry = registry(h).find(({ slug }) => slug === 'fix-login');
  assert.equal(entry?.status, 'archived');
  assert.equal(entry?.archivePath, copy);
});

test('ledger retire names the archive copy after the ledger title, not the branch or folder', (t) => {
  const { h, app } = setup(t);
  const worktree = worktreeOf(app, 'wip');
  git(h, app, 'worktree', 'add', '--quiet', '-b', 'me/wip', worktree, 'main');
  mkdirSync(path.join(worktree, '.claude'));
  writeFileSync(path.join(worktree, '.claude/ledger.md'), ledgerText({ slug: 'login-fix', worktree, branch: 'me/wip' }));
  ok(ledger(h, app, 'retire', 'login-fix'));
  assert.deepEqual(archiveList(h, app), [`${today()}-login-fix.md`]);
});

test('ledger retire adds -2 when the day already has a different copy of that name', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  mkdirSync(archiveFolder(h, app), { recursive: true });
  writeFileSync(path.join(archiveFolder(h, app), `${today()}-fix-login.md`), 'an older task with the same slug\n');
  ok(ledger(h, app, 'retire', 'fix-login'));
  assert.deepEqual(archiveList(h, app), [`${today()}-fix-login-2.md`, `${today()}-fix-login.md`]);
});

test('ledger retire finds an identical copy already in the archive and archives once', (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'fix-login' });
  mkdirSync(archiveFolder(h, app), { recursive: true });
  const earlier = path.join(archiveFolder(h, app), '2026-01-02-fix-login.md');
  copyFileSync(file, earlier);
  const stdout = ok(ledger(h, app, 'retire', 'fix-login'));
  assert.match(stdout, new RegExp(`already archived ${earlier.replaceAll('/', '\\/')}`));
  assert.deepEqual(archiveList(h, app), ['2026-01-02-fix-login.md']);
  assert.equal(existsSync(worktreeOf(app, 'fix-login')), false);
});

test('ledger retire copies .claude/evidence next to the archive copy, under the same name', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const evidence = path.join(worktreeOf(app, 'fix-login'), '.claude/evidence');
  mkdirSync(path.join(evidence, 'logs'), { recursive: true });
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  writeFileSync(path.join(evidence, 'logs/build.log'), 'built\n');
  const stdout = ok(ledger(h, app, 'retire', 'fix-login'));
  const copied = path.join(archiveFolder(h, app), `${today()}-fix-login`);
  assert.equal(read(path.join(copied, 'red.txt')), 'failing\n');
  assert.equal(read(path.join(copied, 'logs/build.log')), 'built\n');
  assert.match(stdout, /archived evidence /);
});

/** A worktree with evidence whose first retire archives it and then fails, because git refuses to remove a locked worktree. */
function retiredOnceLocked(t: TestContext) {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const worktree = worktreeOf(app, 'fix-login');
  const evidence = path.join(worktree, '.claude/evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  git(h, app, 'worktree', 'lock', worktree);
  failed(ledger(h, app, 'retire', 'fix-login'), /^Could not remove the worktree/m);
  assert.ok(existsSync(worktree));
  git(h, app, 'worktree', 'unlock', worktree);
  return { h, app, worktree, evidence };
}

const differs = /^Not retired: .*\.md is archived already, but its evidence differs from .*\/\.claude\/evidence\/\. Move .*\.md and .*\/ away, then run retire again\.$/m;

test('ledger retire runs again after git could not remove the worktree: the same evidence is archived already, so it goes on with one archive copy', (t) => {
  const { h, app, worktree } = retiredOnceLocked(t);
  const ran = ledger(h, app, 'retire', 'fix-login');
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /^already archived /m);
  assert.doesNotMatch(ran.stderr, /evidence/);
  assert.equal(existsSync(worktree), false);
  assert.deepEqual(archiveList(h, app), [`${today()}-fix-login`, `${today()}-fix-login.md`]);
  assert.equal(read(path.join(archiveFolder(h, app), `${today()}-fix-login/red.txt`)), 'failing\n');
});

test('ledger retire refuses, even with --force, a rerun whose worktree got more evidence after the archive copy', (t) => {
  const { h, app, worktree, evidence } = retiredOnceLocked(t);
  writeFileSync(path.join(evidence, 'later.txt'), 'added after the first run\n');
  for (const flags of [[], ['--force']]) {
    failed(ledger(h, app, 'retire', 'fix-login', ...flags), differs);
    assert.ok(existsSync(path.join(evidence, 'later.txt')));
    assert.ok(existsSync(worktree));
    assert.deepEqual(archiveList(h, app), [`${today()}-fix-login`, `${today()}-fix-login.md`]);
  }
});

test('ledger retire refuses, even with --force, an identical archive copy that has no evidence while the worktree has some, and changes nothing', (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'fix-login' });
  mkdirSync(archiveFolder(h, app), { recursive: true });
  copyFileSync(file, path.join(archiveFolder(h, app), '2026-01-02-fix-login.md'));
  const evidence = path.join(worktreeOf(app, 'fix-login'), '.claude/evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  for (const flags of [[], ['--force']]) {
    failed(ledger(h, app, 'retire', 'fix-login', ...flags), differs);
    assert.ok(existsSync(file));
    assert.deepEqual(archiveList(h, app), ['2026-01-02-fix-login.md']);
  }
});

test('ledger retire stops with a message, and no stack trace, when the archive copy cannot be written; it retires once the cause is fixed', { skip: process.getuid?.() === 0 }, (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const worktree = worktreeOf(app, 'fix-login');
  const evidence = path.join(worktree, '.claude/evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  const archive = archiveFolder(h, app);
  mkdirSync(archive, { recursive: true });
  chmodSync(archive, 0o555);
  try {
    const first = ledger(h, app, 'retire', 'fix-login');
    failed(first, /^Could not archive fix-login: .*Fix the cause, then run ledger retire again\.$/m);
    assert.doesNotMatch(first.stderr, /^\s+at /m);
    assert.ok(first.stderr.includes(path.join(archive, `${today()}-fix-login.md`)), first.stderr);
    assert.ok(existsSync(worktree));
  } finally {
    chmodSync(archive, 0o755);
  }
  ok(ledger(h, app, 'retire', 'fix-login'));
  assert.equal(read(path.join(archive, `${today()}-fix-login/red.txt`)), 'failing\n');
});

test('ledger retire refuses, even with --force, an evidence file it cannot read, and the dry run names it', { skip: process.getuid?.() === 0 }, (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const evidence = path.join(worktreeOf(app, 'fix-login'), '.claude/evidence');
  mkdirSync(path.join(evidence, 'logs'), { recursive: true });
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  const secret = path.join(evidence, 'logs/secret.txt');
  writeFileSync(secret, 'secret\n');
  chmodSync(secret, 0o000);
  t.after(() => existsSync(secret) && chmodSync(secret, 0o644));
  const plan = ok(ledger(h, app, 'retire', 'fix-login', '--dry-run'));
  assert.match(plan, /^It cannot be retired, not even with --force: .*\/\.claude\/evidence\/logs\/secret\.txt cannot be read \(EACCES\)/m);
  refusedEvenForced(h, app, /^Not retired: .*\/\.claude\/evidence\/logs\/secret\.txt cannot be read \(EACCES\), so the evidence cannot be archived\. Make it readable, then run retire again\.$/m);
});

test('ledger retire archives a relative symbolic link in the evidence as the same relative link', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const evidence = path.join(worktreeOf(app, 'fix-login'), '.claude/evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  symlinkSync('red.txt', path.join(evidence, 'latest'));
  ok(ledger(h, app, 'retire', 'fix-login'));
  const copied = path.join(archiveFolder(h, app), `${today()}-fix-login`);
  assert.equal(readlinkSync(path.join(copied, 'latest')), 'red.txt');
  assert.equal(read(path.join(copied, 'latest')), 'failing\n');
});

/** Retire refuses, even with --force, and leaves the worktree and the archive as they were. */
function refusedEvenForced(h: string, app: string, pattern: RegExp): void {
  for (const flags of [[], ['--force']]) {
    failed(ledger(h, app, 'retire', 'fix-login', ...flags), pattern);
    assert.ok(existsSync(path.join(worktreeOf(app, 'fix-login'), '.claude/ledger.md')));
    assert.deepEqual(archiveList(h, app), []);
  }
}

const outsideLink = (link: string): RegExp =>
  new RegExp(`^Not retired: ${link.replaceAll('/', '\\/')} is a symbolic link to .*, outside .*\\/\\.claude\\/evidence\\/\\. Replace it with the (file|folder) it points to, then run retire again\\.$`, 'm');

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const textStepsOut = (link: string, target: string, inside: string): RegExp =>
  new RegExp(
    `^Not retired: the symbolic link ${escaped(link)} in .*\\/\\.claude\\/evidence\\/ has the text ${escaped(target)}, which steps outside the evidence folder\\. ` +
      `The link would break in the archive\\. Change its text to ${escaped(inside)}, then run retire again\\.$`,
    'm',
  );

const linksToEvidence = (link: string): RegExp =>
  new RegExp(`^Not retired: the symbolic link ${escaped(link)} in .*\\/\\.claude\\/evidence\\/ points to the evidence folder itself, so it makes a loop\\. Remove the link, then run retire again\\.$`, 'm');

const linksToHolder = (link: string, holder: string): RegExp =>
  new RegExp(`^Not retired: the symbolic link ${escaped(link)} in .*\\/\\.claude\\/evidence\\/ points to the folder ${escaped(holder)}, which holds it, so it makes a loop\\. Remove the link, then run retire again\\.$`, 'm');

const pointsOutside = (link: string, target: string): RegExp =>
  new RegExp(
    `^Not retired: the symbolic link ${escaped(link)} in .*\\/\\.claude\\/evidence\\/ points to ${escaped(target)}, outside the evidence folder\\. Replace it with the file it points to, then run retire again\\.$`,
    'm',
  );

test('ledger retire refuses, even with --force, a .claude/evidence that is itself a symbolic link', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const worktree = worktreeOf(app, 'fix-login');
  mkdirSync(path.join(worktree, '.claude/logs'));
  writeFileSync(path.join(worktree, '.claude/logs/red.txt'), 'failing\n');
  symlinkSync('logs', path.join(worktree, '.claude/evidence'));
  refusedEvenForced(h, app, outsideLink(path.join(worktree, '.claude/evidence')));
});

test('ledger retire refuses, even with --force, evidence with a link that leaves the folder, dangling or not; it names the first one', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const worktree = worktreeOf(app, 'fix-login');
  const evidence = path.join(worktree, '.claude/evidence');
  mkdirSync(path.join(evidence, 'logs'), { recursive: true });
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  writeFileSync(path.join(worktree, '.claude/outside.txt'), 'outside\n');
  symlinkSync('../red.txt', path.join(evidence, 'logs/inside'));
  symlinkSync('../../outside.txt', path.join(evidence, 'logs/out'));
  refusedEvenForced(h, app, pointsOutside('logs/out', '../../outside.txt'));
  rmSync(path.join(evidence, 'logs/out'));
  symlinkSync('../../nowhere/gone.txt', path.join(evidence, 'logs/gone'));
  refusedEvenForced(h, app, pointsOutside('logs/gone', '../../nowhere/gone.txt'));
});

test('ledger retire refuses, even with --force, evidence it cannot read: the folder itself or a folder inside it', { skip: process.getuid?.() === 0 }, (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const evidence = path.join(worktreeOf(app, 'fix-login'), '.claude/evidence');
  mkdirSync(path.join(evidence, 'logs'), { recursive: true });
  writeFileSync(path.join(evidence, 'logs/build.log'), 'built\n');
  const unreadable = /^Not retired: .*\/\.claude\/evidence(\/logs)? cannot be read .*Make it readable, then run retire again\.$/m;
  for (const folder of [evidence, path.join(evidence, 'logs')]) {
    chmodSync(folder, 0o000);
    try {
      refusedEvenForced(h, app, unreadable);
    } finally {
      chmodSync(folder, 0o755);
    }
  }
});

test('ledger retire refuses, even with --force, a link whose text leaves the evidence folder, though it lands inside it now: absolute, or out and back in', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const evidence = path.join(worktreeOf(app, 'fix-login'), '.claude/evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, 'b'), 'failing\n');
  symlinkSync('../evidence/b', path.join(evidence, 'a'));
  refusedEvenForced(h, app, textStepsOut('a', '../evidence/b', 'b'));
  rmSync(path.join(evidence, 'a'));
  symlinkSync(path.join(evidence, 'b'), path.join(evidence, 'c'));
  refusedEvenForced(h, app, textStepsOut('c', path.join(evidence, 'b'), 'b'));
});

test('ledger retire refuses, even with --force, a link in a subfolder whose text steps above the evidence folder and back in', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const evidence = path.join(worktreeOf(app, 'fix-login'), '.claude/evidence');
  mkdirSync(path.join(evidence, 'logs'), { recursive: true });
  writeFileSync(path.join(evidence, 'b'), 'failing\n');
  symlinkSync('../../evidence/b', path.join(evidence, 'logs/a'));
  refusedEvenForced(h, app, textStepsOut('logs/a', '../../evidence/b', '../b'));
});

test('ledger retire archives a link in a subfolder whose text steps up only inside the evidence folder, as the same link', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const evidence = path.join(worktreeOf(app, 'fix-login'), '.claude/evidence');
  mkdirSync(path.join(evidence, 'logs'), { recursive: true });
  writeFileSync(path.join(evidence, 'logs/b'), 'failing\n');
  symlinkSync('../logs/b', path.join(evidence, 'logs/a'));
  ok(ledger(h, app, 'retire', 'fix-login'));
  const copied = path.join(archiveFolder(h, app), `${today()}-fix-login`);
  assert.equal(readlinkSync(path.join(copied, 'logs/a')), '../logs/b');
  assert.equal(read(path.join(copied, 'logs/a')), 'failing\n');
});

test('ledger retire refuses, even with --force, a link to the evidence folder itself', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const evidence = path.join(worktreeOf(app, 'fix-login'), '.claude/evidence');
  mkdirSync(path.join(evidence, 'logs'), { recursive: true });
  symlinkSync('..', path.join(evidence, 'logs/up'));
  refusedEvenForced(h, app, linksToEvidence('logs/up'));
  rmSync(path.join(evidence, 'logs/up'));
  symlinkSync('.', path.join(evidence, 'here'));
  refusedEvenForced(h, app, linksToEvidence('here'));
});

test('ledger retire refuses, even with --force, a link to any folder that holds it, by its text or by where it lands', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const evidence = path.join(worktreeOf(app, 'fix-login'), '.claude/evidence');
  mkdirSync(path.join(evidence, 'logs/x'), { recursive: true });
  writeFileSync(path.join(evidence, 'logs/build.log'), 'built\n');
  const cases: [link: string, target: string][] = [
    ['logs/a', '../../evidence/logs'],
    ['logs/x/a', '..'],
    ['logs/up', '.'],
  ];
  for (const [link, target] of cases) {
    symlinkSync(target, path.join(evidence, link));
    refusedEvenForced(h, app, linksToHolder(link, 'logs'));
    rmSync(path.join(evidence, link));
  }
});

test('ledger retire refuses, even with --force, evidence that holds a FIFO, before it copies or removes anything', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const worktree = worktreeOf(app, 'fix-login');
  const evidence = path.join(worktree, '.claude/evidence');
  mkdirSync(path.join(evidence, 'logs'), { recursive: true });
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  execFileSync('mkfifo', [path.join(evidence, 'logs/pipe')]);
  const ledgerBefore = read(path.join(worktree, '.claude/ledger.md'));
  refusedEvenForced(h, app, new RegExp(`^Not retired: logs\\/pipe in .*\\/\\.claude\\/evidence\\/ is not a file, a folder or a symbolic link\\. Move it out of the evidence folder, then run retire again\\.$`, 'm'));
  assert.equal(read(path.join(worktree, '.claude/ledger.md')), ledgerBefore);
  assert.ok(lstatSync(path.join(evidence, 'logs/pipe')).isFIFO());
  assert.equal(read(path.join(evidence, 'red.txt')), 'failing\n');
});

test('ledger retire refuses, even with --force, a .claude/evidence that is not a folder', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  writeFileSync(path.join(worktreeOf(app, 'fix-login'), '.claude/evidence'), 'a file, not a folder\n');
  refusedEvenForced(h, app, /^Not retired: .*\/\.claude\/evidence is not a folder, and evidence must be a folder\..*then run retire again\.$/m);
});

test('ledger retire refuses, even with --force, evidence in a folder it can list but not search', { skip: process.getuid?.() === 0 }, (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const evidence = path.join(worktreeOf(app, 'fix-login'), '.claude/evidence');
  mkdirSync(path.join(evidence, 'logs'), { recursive: true });
  writeFileSync(path.join(evidence, 'logs/build.log'), 'built\n');
  for (const folder of [evidence, path.join(evidence, 'logs')]) {
    chmodSync(folder, 0o444);
    try {
      refusedEvenForced(h, app, /^Not retired: .*\/\.claude\/evidence(\/logs)? cannot be read .*Make it readable, then run retire again\.$/m);
    } finally {
      chmodSync(folder, 0o755);
    }
  }
});

test('ledger retire never attaches a leftover evidence folder to a new copy: a taken folder name takes the next -N', (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'fix-login' });
  const leftover = path.join(archiveFolder(h, app), `${today()}-fix-login`);
  mkdirSync(leftover, { recursive: true });
  writeFileSync(path.join(leftover, 'old.txt'), 'from an earlier run\n');
  const text = read(file);
  ok(ledger(h, app, 'retire', 'fix-login'));
  assert.deepEqual(archiveList(h, app), [`${today()}-fix-login`, `${today()}-fix-login-2.md`]);
  assert.equal(read(path.join(archiveFolder(h, app), `${today()}-fix-login-2.md`)), text);
  assert.deepEqual(readdirSync(leftover), ['old.txt']);
});

test('ledger retire refuses uncommitted changes without --force, and --force retires anyway', (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'fix-login' });
  writeFileSync(path.join(worktreeOf(app, 'fix-login'), 'scratch.txt'), 'not committed\n');
  failed(ledger(h, app, 'retire', 'fix-login'), /^Not retired: it has 1 uncommitted change\. Add --force to retire it anyway\. Uncommitted changes are lost with the worktree\.$/m);
  assert.ok(existsSync(file));
  assert.deepEqual(archiveList(h, app), []);
  ok(ledger(h, app, 'retire', 'fix-login', '--force'));
  assert.equal(existsSync(worktreeOf(app, 'fix-login')), false);
  assert.deepEqual(archiveList(h, app), [`${today()}-fix-login.md`]);
});

test('ledger retire refuses an unmerged branch without --force; --force retires and keeps the branch', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const head = commitIn(h, worktreeOf(app, 'fix-login'));
  noPr(h);
  failed(ledger(h, app, 'retire', 'fix-login'), /^Not retired: its branch is not merged\. Add --force/m);
  assert.ok(existsSync(worktreeOf(app, 'fix-login')));
  const stdout = ok(ledger(h, app, 'retire', 'fix-login', '--force'));
  assert.match(stdout, /kept +branch me\/fix-login, because it is not merged/);
  assert.equal(git(h, app, 'rev-parse', 'me/fix-login'), head);
});

test('ledger retire lists every reason together when a worktree is both dirty and unmerged', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  commitIn(h, worktreeOf(app, 'fix-login'));
  writeFileSync(path.join(worktreeOf(app, 'fix-login'), 'a.txt'), 'x');
  writeFileSync(path.join(worktreeOf(app, 'fix-login'), 'b.txt'), 'x');
  noPr(h);
  failed(ledger(h, app, 'retire', 'fix-login'), /^Not retired: it has 2 uncommitted changes and its branch is not merged\. Add --force/m);
});

test('ledger retire counts a merged PR that ends at HEAD as merged: no --force, and the branch is deleted', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const head = commitIn(h, worktreeOf(app, 'fix-login'));
  mergedPr(h, head);
  const stdout = ok(ledger(h, app, 'retire', 'fix-login'));
  assert.match(stdout, /deleted +branch me\/fix-login/);
  assert.equal(git(h, app, 'branch', '--list', 'me/fix-login'), '');
});

test('ledger retire does not count a merged PR that ends at another commit: it needs --force and keeps the branch', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const merged = commitIn(h, worktreeOf(app, 'fix-login'), 'one.txt');
  const head = commitIn(h, worktreeOf(app, 'fix-login'), 'two.txt');
  mergedPr(h, merged);
  failed(ledger(h, app, 'retire', 'fix-login'), /^Not retired: its branch is not merged\./m);
  const stdout = ok(ledger(h, app, 'retire', 'fix-login', '--force'));
  assert.match(stdout, /kept +branch me\/fix-login, because/);
  assert.equal(git(h, app, 'rev-parse', 'me/fix-login'), head);
});

test('ledger retire fetches the default branch first, so work merged on origin since the last fetch counts', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const worktree = worktreeOf(app, 'fix-login');
  commitIn(h, worktree);
  noPr(h);
  // Pushed by URL, so this checkout's origin/main stays where it was until a fetch.
  git(h, worktree, 'push', '--quiet', path.join(h, 'remotes/app.git'), 'HEAD:main');
  const stdout = ok(ledger(h, app, 'retire', 'fix-login'));
  assert.match(stdout, /deleted +branch me\/fix-login/);
});

test('ledger retire warns when the fetch fails and still decides on origin/main as it was', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  git(h, app, 'remote', 'set-url', 'origin', path.join(h, 'remotes/missing.git'));
  const ran = ledger(h, app, 'retire', 'fix-login');
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stderr, /^warning: .*fetch.*origin main/m);
  assert.equal(existsSync(worktreeOf(app, 'fix-login')), false);
});

test('ledger retire warns when gh cannot tell about PRs, and decides on the commit count alone', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const ran = ledger(h, app, 'retire', 'fix-login');
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stderr, /^warning: .*gh pr list/m);
});

test('ledger retire --dry-run prints the plan and changes nothing, blockers included', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login', parent: 'epic' });
  worktreeTask(h, app, { slug: 'epic', children: ['- fix-login'] });
  const evidence = path.join(worktreeOf(app, 'fix-login'), '.claude/evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  writeFileSync(path.join(worktreeOf(app, 'fix-login'), 'scratch.txt'), 'x');
  const before = snapshot(h);
  const stdout = ok(ledger(h, app, 'retire', 'fix-login', '--dry-run'));
  assert.deepEqual(snapshot(h), before);
  assert.match(stdout, /dry run/i);
  assert.match(lineWith(stdout, `${today()}-fix-login.md`), /archive/);
  assert.match(stdout, /evidence/);
  assert.match(stdout, /epic/);
  assert.match(stdout, /--force/);
  assert.match(stdout, /1 uncommitted change/);
});

test('ledger retire --dry-run of a parent lists its active children', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- part'] });
  backlogTask(h, app, { slug: 'part', parent: 'epic' });
  const before = snapshot(h);
  const stdout = ok(ledger(h, app, 'retire', 'epic', '--dry-run'));
  assert.deepEqual(snapshot(h), before);
  assert.match(stdout, /active children: part/);
});

test('ledger retire of a backlog task archives and deletes its ledger, and never asks git or gh about a branch', (t) => {
  const { h, app } = setup(t);
  const file = backlogTask(h, app, { slug: 'later' });
  const text = read(file);
  stubGh(h, `touch ${JSON.stringify(path.join(h, 'gh-was-called'))}; exit 1`);
  const stdout = ok(ledger(h, app, 'retire', 'later'));
  assert.equal(existsSync(file), false);
  assert.equal(read(path.join(archiveFolder(h, app), `${today()}-later.md`)), text);
  assert.match(stdout, /removed +.*later\.md/);
  assert.equal(existsSync(path.join(h, 'gh-was-called')), false);
  assert.equal(registry(h).find(({ slug }) => slug === 'later')?.status, 'archived');
});

test('ledger retire refuses a parent with active children, names them, and --force retires it', (t) => {
  const { h, app } = setup(t);
  const epic = worktreeTask(h, app, { slug: 'epic', children: ['- a', '- b (started 2026-11-01)', '- done (retired 2026-11-02)'] });
  backlogTask(h, app, { slug: 'a', parent: 'epic' });
  worktreeTask(h, app, { slug: 'b', parent: 'epic' });
  archivedTask(h, app, '2026-11-02', { slug: 'done', parent: 'epic' });
  failed(ledger(h, app, 'retire', 'epic'), /^epic has active children: a, b\. Retire them first, or pass --force\.$/m);
  assert.ok(existsSync(epic));
  assert.deepEqual(archiveList(h, app), ['2026-11-02-done.md']);
  ok(ledger(h, app, 'retire', 'epic', '--force'));
  assert.equal(existsSync(worktreeOf(app, 'epic')), false);
});

test('ledger retire reads child status from disk: children archived with no (retired) mark do not block', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: ['- a', '- b (started 2026-11-01)'] });
  archivedTask(h, app, '2026-11-03', { slug: 'a', parent: 'epic' });
  archivedTask(h, app, '2026-11-04', { slug: 'b', parent: 'epic' });
  ok(ledger(h, app, 'retire', 'epic'));
  assert.equal(existsSync(worktreeOf(app, 'epic')), false);
});

test('ledger retire of a backlog parent with an active child is refused too', (t) => {
  const { h, app } = setup(t);
  const file = backlogTask(h, app, { slug: 'epic', children: ['- part'] });
  worktreeTask(h, app, { slug: 'part', parent: 'epic' });
  failed(ledger(h, app, 'retire', 'epic'), /^epic has active children: part\. Retire them first, or pass --force\.$/m);
  assert.ok(existsSync(file));
});

test('ledger retire marks the child retired in its parent, copies its report, and says when the parent has no active child left', (t) => {
  const { h, app } = setup(t);
  const epic = worktreeTask(h, app, { slug: 'epic', children: ['- part (started 2026-11-01)', '- other'] });
  worktreeTask(h, app, { slug: 'part', parent: 'epic', report: ['PR #12 merged.', '# not a heading'] });
  archivedTask(h, app, '2026-11-02', { slug: 'other', parent: 'epic' });
  const stdout = ok(ledger(h, app, 'retire', 'part'));
  const text = read(epic);
  assert.match(text, new RegExp(`^- part \\(retired ${today()}\\)$`, 'm'));
  assert.match(text, /^- other$/m);
  assert.match(text, /## Child reports\n\n### part\nPR #12 merged\.\n\\# not a heading\n/);
  assert.match(stdout, /^Parent epic has no active children left\. Retire it with \/ledger:retire epic\.$/m);
});

test('ledger retire keeps a hand-written suffix when it marks the parent line, and gives no hint while a sibling is active', (t) => {
  const { h, app } = setup(t);
  const epic = worktreeTask(h, app, { slug: 'epic', children: ['- part (started 2026-11-01; PR #12)', '- sibling'] });
  worktreeTask(h, app, { slug: 'part', parent: 'epic' });
  backlogTask(h, app, { slug: 'sibling', parent: 'epic' });
  const stdout = ok(ledger(h, app, 'retire', 'part'));
  assert.match(read(epic), new RegExp(`^- part \\(retired ${today()}; PR #12\\)$`, 'm'));
  assert.doesNotMatch(stdout, /no active children left/);
});

test('ledger retire marks a child retired in a parent in another repo, and copies its report there', (t) => {
  const { h, app } = setup(t);
  const lib = repository(h, path.join(h, 'repos/lib'));
  writeFileSync(path.join(lib, '.git/info/exclude'), '.claude/\n');
  const epic = worktreeTask(h, lib, { slug: 'epic', children: [`- part @ ${app}`] });
  worktreeTask(h, app, { slug: 'part', parent: `epic @ ${lib}`, report: ['Done in app.'] });
  const stdout = ok(ledger(h, app, 'retire', 'part'));
  const text = read(epic);
  assert.match(text, new RegExp(`^- part @ ${app.replaceAll('/', '\\/')} \\(retired ${today()}\\)$`, 'm'));
  assert.match(text, new RegExp(`### part@${app.replaceAll('/', '\\/')}\\nDone in app\\.`));
  assert.match(stdout, new RegExp(`^Parent epic @ ${lib.replaceAll('/', '\\/')} has no active children left\\.`, 'm'));
});

test('ledger retire only warns when the parent named in the ledger is not found', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'part', parent: 'nowhere' });
  const ran = ledger(h, app, 'retire', 'part');
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stderr, /^warning: .*nowhere/m);
  assert.equal(existsSync(worktreeOf(app, 'part')), false);
});

test('ledger retire resolves no slug in the main checkout, an unknown slug and a shared slug to messages', (t) => {
  const { h, app } = setup(t);
  failed(ledger(h, app, 'retire'), /^No task ledger in or above .*Give a slug/m);
  failed(ledger(h, app, 'retire', 'nothing'), /^No task ledger is named "nothing"/m);
  for (const folder of ['one', 'two']) {
    const worktree = worktreeOf(app, folder);
    git(h, app, 'worktree', 'add', '--quiet', '-b', `me/${folder}`, worktree, 'main');
    mkdirSync(path.join(worktree, '.claude'));
    writeFileSync(path.join(worktree, '.claude/ledger.md'), ledgerText({ slug: 'same', worktree, branch: `me/${folder}` }));
  }
  failed(ledger(h, app, 'retire', 'same'), /^Several task ledgers are named "same"/m);
  assert.deepEqual(archiveList(h, app), []);
});

test('ledger retire refuses the main checkout', (t) => {
  const { h, app } = setup(t);
  mkdirSync(path.join(app, '.claude'), { recursive: true });
  writeFileSync(path.join(app, '.claude/ledger.md'), ledgerText({ slug: 'in-main' }));
  failed(ledger(h, app, 'retire', 'in-main', '--force'), /is the main checkout, not a linked worktree/);
  assert.ok(existsSync(path.join(app, '.claude/ledger.md')));
  assert.deepEqual(archiveList(h, app), []);
});

test('buildFolderPrefix is cc-<folder>-<first 6 hex of sha1 of the real top folder>- under ~/Library/Developer/Xcode/DerivedData', async (t) => {
  // Imported here, so the other tests of this file run while the module is missing.
  const { buildFolderPrefix } = await import('../tools/ledger/worktrees.js');
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const worktree = realpathSync(worktreeOf(app, 'fix-login'));
  const hash = createHash('sha1').update(worktree).digest('hex').slice(0, 6);
  const expected = path.join(derivedData(h), `cc-fix-login-${hash}-`);
  assert.equal(buildFolderPrefix(ledgerPaths(h), path.join(worktree, '.claude')), expected);
});

test("ledger retire moves the worktree's own build folders to a trash folder and deletes them without waiting", (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const worktree = realpathSync(worktreeOf(app, 'fix-login'));
  const hash = createHash('sha1').update(worktree).digest('hex').slice(0, 6);
  const own = path.join(derivedData(h), `cc-fix-login-${hash}-Debug-sim`);
  const other = path.join(derivedData(h), 'cc-fix-login-000000-Debug-sim');
  for (const folder of [own, other]) {
    mkdirSync(path.join(folder, 'Build'), { recursive: true });
    writeFileSync(path.join(folder, 'Build/app.o'), 'object');
  }
  // An rm that takes 8 s on anything in DerivedData, so a delete in the foreground would hold retire up.
  writeFileSync(path.join(h, 'stub-bin/rm'), '#!/bin/sh\ncase "$*" in *Library/Developer/Xcode/DerivedData/*) sleep 8 ;; esac\nexec /bin/rm "$@"\n');
  chmodSync(path.join(h, 'stub-bin/rm'), 0o755);
  const started = Date.now();
  const stdout = ok(ledger(h, app, 'retire', 'fix-login'));
  assert.ok(Date.now() - started < 6000, 'retire does not wait for the delete');
  assert.match(stdout, new RegExp(`deleted +${own.replaceAll('/', '\\/')}`));
  assert.equal(existsSync(own), false);
  assert.ok(existsSync(other));
  assert.ok(readdirSync(derivedData(h)).some((name) => name.startsWith('.cc-trash-')), 'the folder waits in a trash folder');
});

test('ledger retire never takes an archive <name>.md that is a symbolic link to the live ledger for a copy: it writes a real one', (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'fix-login' });
  const later = backlogTask(h, app, { slug: 'later' });
  const texts = [read(file), read(later)];
  mkdirSync(archiveFolder(h, app), { recursive: true });
  symlinkSync(file, path.join(archiveFolder(h, app), '2026-01-02-fix-login.md'));
  symlinkSync(later, path.join(archiveFolder(h, app), '2026-01-02-later.md'));
  for (const [slug, text] of [['fix-login', texts[0]], ['later', texts[1]]]) {
    const stdout = ok(ledger(h, app, 'retire', slug));
    assert.doesNotMatch(stdout, /already archived/);
    const copy = path.join(archiveFolder(h, app), `${today()}-${slug}.md`);
    assert.ok(lstatSync(copy).isFile(), `${copy} is a file`);
    assert.equal(read(copy), text);
  }
});

/** Runs git and gh in this process as the CLI runs them under the HOME `h`, with its stub gh first on PATH. */
function asCli(t: TestContext, h: string): void {
  const saved = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  process.env.PATH = `${path.join(h, 'stub-bin')}${path.delimiter}${saved.PATH ?? ''}`;
  process.env.GIT_CONFIG_GLOBAL = path.join(h, '.gitconfig');
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

/** A forced retire of `slug`, planned in this process; carrying it out runs `meanwhile` right after the archive copy is written. */
function retireWithChange(t: TestContext, h: string, app: string, slug: string, meanwhile: () => void): () => void {
  asCli(t, h);
  const paths = ledgerPaths(h);
  const real = fileStore(paths);
  const store = {
    ...real,
    archive: {
      ...real.archive,
      write: (...args: Parameters<typeof real.archive.write>) => {
        real.archive.write(...args);
        meanwhile();
      },
    },
  };
  const context: Context = { paths, cwd: app, store };
  const plan = planRetire(readRetire(context, slug), { force: true });
  assert.equal(plan.blocked, false);
  return () => executeRetire(context, plan, { line: () => {}, warn: () => {} });
}

function stopsWith(run: () => void, pattern: RegExp): void {
  assert.throws(run, (error) => {
    assert.ok(error instanceof Failure);
    assert.equal(error.exitCode, 1);
    assert.match(error.message, pattern);
    assert.match(error.message, /Nothing was removed\. Run ledger retire again\.$/);
    return true;
  });
}

test('ledger retire stops, even with --force, and keeps the worktree when the ledger changes after the archive copy is written', (t) => {
  const { h, app } = setup(t);
  const file = worktreeTask(h, app, { slug: 'fix-login' });
  const run = retireWithChange(t, h, app, 'fix-login', () => writeFileSync(file, `${read(file)}- a late decision\n`));
  stopsWith(run, /^Stopped before removing the worktree .*\/fix-login: the ledger .*\/\.claude\/ledger\.md changed after the archive copy .*\/[0-9-]+-fix-login\.md was written\./);
  assert.ok(existsSync(worktreeOf(app, 'fix-login')));
  assert.match(read(file), /a late decision/);
});

test('ledger retire stops, even with --force, and keeps the worktree when the evidence changes after the archive copy is written', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const evidence = path.join(worktreeOf(app, 'fix-login'), '.claude/evidence');
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  const run = retireWithChange(t, h, app, 'fix-login', () => writeFileSync(path.join(evidence, 'late.txt'), 'late\n'));
  stopsWith(run, /^Stopped before removing the worktree .*: the evidence .*\/\.claude\/evidence\/ changed after the archive copy .* was written\./);
  assert.ok(existsSync(path.join(evidence, 'late.txt')));
});

test('ledger retire stops and keeps the backlog ledger when it changes after the archive copy is written', (t) => {
  const { h, app } = setup(t);
  const file = backlogTask(h, app, { slug: 'later' });
  const run = retireWithChange(t, h, app, 'later', () => writeFileSync(file, `${read(file)}- a late note\n`));
  stopsWith(run, /^Stopped before removing the backlog ledger .*\/later\.md: the ledger .*\/later\.md changed after the archive copy .*-later\.md was written\./);
  assert.match(read(file), /a late note/);
});

test('ledger retire refuses a parent whose child has no ledger anywhere, even when its line says retired; --force retires it', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'epic', children: [`- lost @ ${app} (retired 2026-10-01)`] });
  failed(ledger(h, app, 'retire', 'epic'), /^Not retired: child lost has no ledger anywhere\. Remove its line under ## Children, or pass --force\.$/m);
  assert.ok(existsSync(worktreeOf(app, 'epic')));
  assert.match(ok(ledger(h, app, 'retire', 'epic', '--dry-run')), /^Retiring it needs --force: child lost has no ledger anywhere\.$/m);
  ok(ledger(h, app, 'retire', 'epic', '--force'));
  assert.equal(existsSync(worktreeOf(app, 'epic')), false);
});

test('ledger retire asks gh for the default branch when origin/HEAD is not set', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  git(h, app, 'push', '--quiet', 'origin', 'main:trunk');
  git(h, app, 'remote', 'set-head', 'origin', '-d');
  stubGh(h, `case "$1 $2" in "repo view") echo '{"defaultBranchRef":{"name":"trunk"}}' ;; *) echo '[]' ;; esac`);
  const ran = ledger(h, app, 'retire', 'fix-login', '--dry-run');
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /^branch +me\/fix-login · no commits ahead of origin\/trunk · /m);
  assert.doesNotMatch(ran.stderr, /default branch/);
});

test('ledger retire guesses main, with a warning that names the guess, when neither origin/HEAD nor gh names the default branch', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  git(h, app, 'remote', 'set-head', 'origin', '-d');
  const ran = ledger(h, app, 'retire', 'fix-login', '--dry-run');
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stderr, /^warning: .*default branch.*gh repo view failed.*guess(es)? main\b/m);
  assert.match(ran.stdout, /^branch +me\/fix-login · no commits ahead of origin\/main · /m);
});

test('ledger retire asks gh for merged PRs by head branch and merged state, with a limit far above the default 30', (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'fix-login' });
  const calls = path.join(h, 'gh-calls');
  stubGh(h, `echo "$@" >> ${JSON.stringify(calls)}\necho '[]'`);
  ok(ledger(h, app, 'retire', 'fix-login'));
  const lines = read(calls).trim().split('\n');
  const prList = lines.find((line) => line.startsWith('pr list ')) ?? assert.fail(lines.join('\n'));
  assert.match(prList, /--head me\/fix-login\b/);
  assert.match(prList, /--state merged\b/);
  const limit = /--limit (\d+)/.exec(prList)?.[1];
  assert.ok(limit !== undefined && Number(limit) >= 1000, prList);
  assert.equal(lines.some((line) => line.startsWith('repo view')), false, 'origin/HEAD is set, so gh is not asked for the default branch');
});
