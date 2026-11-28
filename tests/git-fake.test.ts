import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { systemClock } from '../tools/ledger/clock.js';
import {
  addWorktree,
  branchExists,
  changedFiles,
  checkedOutBranch,
  checkoutRoot,
  commitOf,
  commitsAhead,
  commitSubject,
  commonDir,
  currentBranch,
  deleteBranchAt,
  fastForward,
  fetchBranch,
  gitDir,
  gitTimedOut,
  hasFile,
  ignoredPaths,
  inMainCheckout,
  isBranchName,
  lastCommitDate,
  mainCheckout,
  originHead,
  pruneWorktrees,
  remoteUrls,
  removeLinkedWorktree,
  removeWorktree,
  repairWorktree,
  replaceGitForTests,
  resetGitLimits,
  shortCommit,
  withGitLimits,
  worktrees,
  type GitRunner,
  type Worktree,
} from '../tools/ledger/git.js';
import { inRun, type RunIo } from '../tools/ledger/run-io.js';
import { fakeGit, type FakeCommit, type FakeGit, type FakeGitState, type FakeWorktree } from './fixtures/fake-git.js';
import { asCli, git, home, ok, repository, runInProcess, worktreeOf, worktreeTask } from './ledger-core-fixtures.js';

/** Branch names on which every git release agrees; `valid` is what `git check-ref-format --branch` says. */
const BRANCH_NAMES: [name: string, valid: boolean][] = [
  ['main', true],
  ['me/task', true],
  ['feature-1', true],
  ['v1.2', true],
  ['a..b', false],
  ['has space', false],
  ['-dash', false],
  ['x.lock', false],
  ['dir/', false],
  ['/dir', false],
  ['a//b', false],
  ['end.', false],
  ['.hidden', false],
  ['me/.hidden', false],
  ['a~1', false],
  ['a^b', false],
  ['a:b', false],
  ['what?', false],
  ['st*r', false],
  ['br[x', false],
  ['back\\slash', false],
];

const naming =
  (...parts: string[]) =>
  (error: unknown): boolean =>
    error instanceof Error && parts.every((part) => error.message.includes(part));

// --- The fake in place of git ---

const FIRST = 'a'.repeat(40);
const SECOND = 'b'.repeat(40);
const SIDE = 'c'.repeat(40);

type Declared = { root: string; main: string; worktree: string; elsewhere: string; state: FakeGitState };

/**
 * A repo at <root>/app on main at FIRST, whose origin has main at SECOND, and the worktree of the task `task` on
 * me/task at SECOND, with a change, an untracked file and an ignored folder. <root>/elsewhere is in no repository.
 * Nothing is on disk.
 */
function declaredRepo(root: string): Declared {
  const main = path.join(root, 'app');
  const worktree = worktreeOf(main, 'task');
  const elsewhere = path.join(root, 'elsewhere');
  const state: FakeGitState = {
    repos: {
      [main]: {
        branch: 'main',
        originHead: 'origin/main',
        remotes: { origin: { url: path.join(root, 'remotes/app.git'), branches: { main: SECOND } } },
        refs: { 'refs/heads/main': FIRST, 'refs/heads/me/task': SECOND, 'refs/heads/side': SIDE, 'refs/remotes/origin/main': FIRST },
        commits: {
          [FIRST]: { subject: 'first', date: '2026-11-01' },
          [SECOND]: { subject: 'second', date: '2026-11-02', parent: FIRST, files: ['notes/ledger.txt'] },
          [SIDE]: { subject: 'side', date: '2026-11-03', parent: FIRST },
        },
        worktrees: [{ path: worktree, branch: 'me/task', status: [' M notes/ledger.txt', '?? draft.txt', '!! build/'] }],
      },
    },
    outside: [elsewhere],
  };
  return { root, main, worktree, elsewhere, state };
}

/** Run values whose PATH holds only a `git` that notes each start and fails, so no git process starts unseen. */
function tripwire(root: string): { io: RunIo; started: () => string } {
  const bin = path.join(root, 'tripwire-bin');
  const log = path.join(root, 'git-started.log');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "git $*" >> '${log}'\nexit 97\n`);
  chmodSync(path.join(bin, 'git'), 0o755);
  return { io: { env: { ...process.env, PATH: bin }, console, clock: systemClock }, started: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}

type Faked = Declared & { fake: FakeGit; within: <T>(calls: () => T) => T };

/**
 * The fake of `declaredRepo`, after `change`, in place of git until the test ends. `within` runs `calls` under the
 * tripwire and fails when a git process started, which the fake's own log of calls could not show.
 */
function faked(t: TestContext, change: (state: FakeGitState, declared: Declared) => void = () => {}): Faked {
  const declared = declaredRepo(home(t));
  change(declared.state, declared);
  const fake = fakeGit(declared.state);
  const previous = replaceGitForTests(fake.runner);
  t.after(() => replaceGitForTests(previous));
  const trip = tripwire(declared.root);
  const within = <T>(calls: () => T): T => {
    const answer = inRun(trip.io, calls);
    assert.equal(trip.started(), '', 'a git process started');
    return answer;
  };
  return { ...declared, fake, within };
}

test('the fake answers each read as the declared state says, and no git process starts', (t) => {
  const { root, main, worktree, elsewhere, within } = faked(t);
  const common = path.join(main, '.git');
  const answers: [() => unknown, unknown][] = [
    [() => commonDir(main), common],
    [() => commonDir(path.join(worktree, '.claude')), common],
    [() => commonDir(elsewhere), undefined],
    [() => gitDir(main), common],
    [() => gitDir(worktree), path.join(common, 'worktrees/task')],
    [() => mainCheckout(worktree), main],
    [() => mainCheckout(elsewhere), undefined],
    [() => inMainCheckout(main), true],
    [() => inMainCheckout(path.join(main, 'docs')), true],
    [() => inMainCheckout(worktree), false],
    [() => inMainCheckout(elsewhere), false],
    [() => checkoutRoot(path.join(worktree, 'notes')), worktree],
    [() => checkoutRoot(elsewhere), undefined],
    [() => currentBranch(main), 'main'],
    [() => currentBranch(worktree), 'me/task'],
    [() => checkedOutBranch(worktree), { branch: 'me/task' }],
    [() => 'error' in checkedOutBranch(elsewhere), true],
    [() => commitOf(main, 'HEAD'), FIRST],
    [() => commitOf(worktree, 'HEAD'), SECOND],
    [() => commitOf(main, 'me/task'), SECOND],
    [() => commitOf(main, 'origin/main'), FIRST],
    [() => commitOf(main, 'refs/heads/side'), SIDE],
    [() => commitOf(main, SECOND.slice(0, 7)), SECOND],
    [() => commitOf(main, 'gone'), undefined],
    [() => shortCommit(main, 'HEAD'), FIRST.slice(0, 7)],
    [() => shortCommit(main, 'gone'), undefined],
    [() => commitSubject(main, 'me/task'), 'second'],
    [() => lastCommitDate(worktree), '2026-11-02'],
    [() => hasFile(main, 'me/task', 'notes/ledger.txt'), true],
    [() => hasFile(main, FIRST, 'notes/ledger.txt'), false],
    [() => remoteUrls(worktree), new Map([['origin', path.join(root, 'remotes/app.git')]])],
    [() => remoteUrls(elsewhere), undefined],
    [() => originHead(worktree), 'origin/main'],
    [() => branchExists(main, 'me/task'), true],
    [() => branchExists(main, 'gone'), false],
    [() => worktrees(worktree), [{ path: main, branch: 'main' }, { path: worktree, branch: 'me/task' }]],
    [() => worktrees(elsewhere), []],
    [() => commitsAhead(worktree, 'main'), 1],
    [() => commitsAhead(main, 'me/task'), 0],
    [() => commitsAhead(main, 'origin/main', 'me/task'), 1],
    [() => commitsAhead(main, 'gone'), undefined],
    [() => changedFiles(worktree), [' M notes/ledger.txt', '?? draft.txt']],
    [() => changedFiles(main), []],
    [() => changedFiles(elsewhere), undefined],
    [() => ignoredPaths(worktree), ['build/']],
  ];
  for (const [call, answer] of answers) assert.deepEqual(within(call), answer, String(call));
});

test('the fake notes each command with the folder it ran in', (t) => {
  const { main, fake, within } = faked(t);
  within(() => currentBranch(main));
  assert.deepEqual(fake.calls, [[main, 'branch', '--show-current']]);
});

test('a branch name is valid under the fake by the rules of git check-ref-format', (t) => {
  const { main, within } = faked(t);
  for (const [name, valid] of BRANCH_NAMES) assert.equal(within(() => isBranchName(main, name)), valid, name);
});

test('worktree add and remove change the worktrees, the branches and the folder', (t) => {
  const { main, worktree, within } = faked(t);
  const next = worktreeOf(main, 'next');
  assert.equal(within(() => addWorktree(main, next, 'me/next', SECOND)), undefined);
  assert.ok(existsSync(next), 'git makes the folder of a new worktree');
  assert.deepEqual(
    within(() => worktrees(main)).find((entry) => entry.path === next),
    { path: next, branch: 'me/next' },
  );
  assert.equal(within(() => commitOf(next, 'HEAD')), SECOND);
  assert.equal(typeof within(() => addWorktree(main, worktreeOf(main, 'again'), 'me/next', FIRST)), 'string', 'a branch that exists is refused');
  assert.equal(within(() => removeLinkedWorktree(main, next, false)), undefined);
  assert.ok(!existsSync(next), 'git removes the folder of a removed worktree');
  assert.deepEqual(within(() => worktrees(main)).map((entry) => entry.path), [main, worktree]);
  assert.ok(within(() => branchExists(main, 'me/next')), 'removing a worktree keeps its branch');
});

test('undoing a worktree add removes the worktree, its folder and its branch', (t) => {
  const { main, worktree, within } = faked(t);
  const undo = worktreeOf(main, 'undo');
  assert.equal(within(() => addWorktree(main, undo, 'me/undo', FIRST)), undefined);
  within(() => removeWorktree(main, undo, 'me/undo'));
  assert.ok(!existsSync(undo));
  assert.deepEqual(within(() => worktrees(main)).map((entry) => entry.path), [main, worktree]);
  assert.equal(within(() => branchExists(main, 'me/undo')), false);
});

test('a worktree with changes is removed only with force', (t) => {
  const { main, worktree, within } = faked(t);
  assert.equal(typeof within(() => removeLinkedWorktree(main, worktree, false)), 'string');
  assert.deepEqual(within(() => worktrees(main)).map((entry) => entry.path), [main, worktree]);
  assert.equal(within(() => removeLinkedWorktree(main, worktree, true)), undefined);
  assert.deepEqual(within(() => worktrees(main)), [{ path: main, branch: 'main' }]);
});

test('prune drops each worktree whose folder is gone, and repair answers only for a worktree', (t) => {
  const { main, worktree, elsewhere, within } = faked(t, (state, { main }) => {
    state.repos[main].worktrees?.push({ path: worktreeOf(main, 'gone'), branch: 'side' });
  });
  mkdirSync(worktree, { recursive: true });
  assert.equal(within(() => repairWorktree(main, worktree)), undefined);
  assert.equal(typeof within(() => repairWorktree(main, elsewhere)), 'string');
  assert.equal(within(() => pruneWorktrees(main)), undefined);
  assert.deepEqual(within(() => worktrees(main)).map((entry) => entry.path), [main, worktree]);
});

test('a branch is deleted only while it points at the commit and no worktree has it', (t) => {
  const { main, worktree, within } = faked(t);
  assert.deepEqual(within(() => deleteBranchAt(main, 'me/task', SECOND)), { checkedOut: worktree });
  assert.equal(within(() => deleteBranchAt(main, 'side', FIRST)), 'moved');
  assert.ok(within(() => branchExists(main, 'side')));
  assert.equal(within(() => deleteBranchAt(main, 'side', SIDE)), 'deleted');
  assert.equal(within(() => branchExists(main, 'side')), false);
  assert.equal(within(() => commitOf(main, 'side')), undefined);
});

test('fetch and fast-forward move the refs as git would', (t) => {
  const { main, worktree, within } = faked(t);
  assert.equal(within(() => fastForward(main, 'origin/main')), undefined, 'already up to date');
  assert.equal(within(() => fetchBranch(main, 'origin', 'main')), undefined);
  assert.equal(within(() => commitOf(main, 'origin/main')), SECOND);
  assert.equal(typeof within(() => fetchBranch(main, 'origin', 'gone')), 'string', 'origin has no such branch');
  assert.equal(typeof within(() => fetchBranch(main, 'upstream', 'main')), 'string', 'the repo has no such remote');
  assert.equal(within(() => fastForward(main, 'origin/main')), undefined);
  assert.equal(within(() => commitOf(main, 'main')), SECOND);
  assert.equal(within(() => commitsAhead(worktree, 'main')), 0);
  assert.equal(typeof within(() => fastForward(main, 'side')), 'string', 'side is not ahead of main');
  assert.equal(within(() => commitOf(main, 'HEAD')), SECOND);
});

test('a command or folder the fake does not know throws an error that names both', (t) => {
  const { root, main, fake } = faked(t);
  const undeclared = path.join(root, 'undeclared');
  assert.throws(() => currentBranch(undeclared), naming(undeclared, 'branch --show-current'));
  assert.throws(() => fake.runner(main, ['stash', 'list'], process.env), naming(main, 'stash list'));
});

test('replaceGitForTests gives back the runner it replaced, and undefined brings real git back', (t) => {
  const root = home(t);
  const trip = tripwire(root);
  const first: GitRunner = () => ({ ok: true, stdout: 'first\n', stderr: '' });
  const second: GitRunner = () => ({ ok: true, stdout: 'second\n', stderr: '' });
  const before = replaceGitForTests(first);
  t.after(() => replaceGitForTests(before));
  assert.equal(before, undefined, 'no test left a runner in place');
  assert.equal(replaceGitForTests(second), first);
  assert.equal(commonDir(root), 'second');
  assert.equal(replaceGitForTests(undefined), second);
  assert.equal(inRun(trip.io, () => commonDir(root)), undefined);
  assert.match(trip.started(), /rev-parse/, 'real git runs again');
});

test('the runner gets the environment of the run, with what the call adds to it', (t) => {
  const root = home(t);
  const trip = tripwire(root);
  const seen: NodeJS.ProcessEnv[] = [];
  const previous = replaceGitForTests((_folder, _args, env) => {
    seen.push(env);
    return { ok: true, stdout: '', stderr: '' };
  });
  t.after(() => replaceGitForTests(previous));
  inRun(trip.io, () => fetchBranch(root, 'origin', 'main', { prompt: false }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].PATH, trip.io.env.PATH);
  assert.equal(seen[0].GIT_TERMINAL_PROMPT, '0');
});

test('with the fake in place, a call after the deadline still stops before it runs', (t) => {
  const { main, worktree, fake } = faked(t);
  t.after(resetGitLimits);
  withGitLimits(60_000, Date.now() - 1, () => {
    assert.equal(commonDir(main), undefined);
    assert.ok(gitTimedOut(worktree), 'a task worktree counts as not answering with its main checkout');
    assert.equal(currentBranch(worktree), undefined);
  });
  assert.deepEqual(fake.calls, []);
  assert.equal(currentBranch(worktree), 'me/task', 'the limits end with withGitLimits');
});

test('a ledger run in the test process leaves the fake in place', async (t) => {
  const { root, main, fake } = faked(t, (state, { root }) => {
    state.outside?.push(root);
  });
  ok(await runInProcess(root, root, 'help', 'task'));
  assert.equal(currentBranch(main), 'main');
  assert.deepEqual(fake.calls.at(-1), [main, 'branch', '--show-current']);
});

// --- The fake against real git ---

type Real = { h: string; main: string; worktree: string; origin: string; elsewhere: string; first: string };

/** A main checkout with one commit, pushed to origin, and the linked worktree of the task `task`; git runs as the CLI runs it. */
function realRepo(t: TestContext): Real {
  const h = home(t);
  asCli(t, h);
  const main = repository(h, path.join(h, 'app'));
  worktreeTask(h, main, { slug: 'task' });
  const elsewhere = path.join(h, 'elsewhere');
  mkdirSync(elsewhere);
  return { h, main, worktree: worktreeOf(main, 'task'), origin: path.join(h, 'remotes/app.git'), elsewhere, first: git(h, main, 'rev-parse', 'HEAD') };
}

type Changes = { refs?: Record<string, string>; commits?: Record<string, FakeCommit>; worktrees?: FakeWorktree[]; originBranches?: Record<string, string> };

/** `real` as a test declares it to the fake, with what the test changed on disk since realRepo. */
function declaredAs({ h, main, worktree, origin, elsewhere, first }: Real, changes: Changes = {}): FakeGitState {
  return {
    repos: {
      [main]: {
        branch: 'main',
        originHead: 'origin/main',
        remotes: { origin: { url: origin, branches: { main: first, ...changes.originBranches } } },
        refs: { 'refs/heads/main': first, 'refs/heads/me/task': first, 'refs/remotes/origin/main': first, ...changes.refs },
        commits: { [first]: { subject: 'first', date: git(h, main, 'log', '-1', '--format=%cs') }, ...changes.commits },
        worktrees: changes.worktrees ?? [{ path: worktree, branch: 'me/task' }],
      },
    },
    outside: [elsewhere],
  };
}

type Call = () => unknown;

/** Expects `call` to answer under the fake as under real git. Real git goes first, so the fake finds a worktree folder where git left it. */
function same(fake: FakeGit, call: Call, label = String(call)): void {
  const real = call();
  const previous = replaceGitForTests(fake.runner);
  try {
    assert.deepEqual(call(), real, label);
  } finally {
    replaceGitForTests(previous);
  }
}

/** Whether a call that gives git's error text failed, as the text itself differs between git releases. */
const outcome = (error: string | undefined): string => (error === undefined ? 'done' : 'failed');

/** Git lists the main checkout first; the order of the linked worktrees is not part of its answer. */
const mainFirst = ([main, ...linked]: Worktree[]): Worktree[] => [main, ...linked.sort((a, b) => a.path.localeCompare(b.path))];

test('each read answers under the fake as under real git', (t) => {
  const real = realRepo(t);
  const { main, worktree, elsewhere, first } = real;
  const fake = fakeGit(declaredAs(real));
  const calls: Call[] = [
    () => commonDir(main),
    () => commonDir(worktree),
    () => commonDir(path.join(worktree, '.claude')),
    () => commonDir(elsewhere),
    () => gitDir(main),
    () => gitDir(worktree),
    () => gitDir(elsewhere),
    () => mainCheckout(worktree),
    () => mainCheckout(elsewhere),
    () => inMainCheckout(main),
    () => inMainCheckout(path.join(main, '.claude')),
    () => inMainCheckout(worktree),
    () => inMainCheckout(elsewhere),
    () => checkoutRoot(main),
    () => checkoutRoot(path.join(worktree, '.claude')),
    () => checkoutRoot(elsewhere),
    () => currentBranch(main),
    () => currentBranch(worktree),
    () => currentBranch(elsewhere),
    () => checkedOutBranch(worktree),
    () => 'error' in checkedOutBranch(elsewhere),
    () => commitOf(main, 'HEAD'),
    () => commitOf(worktree, 'HEAD'),
    () => commitOf(main, 'me/task'),
    () => commitOf(main, 'origin/main'),
    () => commitOf(main, 'refs/heads/main'),
    () => commitOf(main, first),
    () => commitOf(main, first.slice(0, 7)),
    () => commitOf(main, 'gone'),
    () => commitOf(elsewhere, 'HEAD'),
    () => shortCommit(main, 'HEAD'),
    () => shortCommit(main, first),
    () => shortCommit(main, 'gone'),
    () => commitSubject(main, 'HEAD'),
    () => commitSubject(worktree, first),
    () => lastCommitDate(main),
    () => lastCommitDate(elsewhere),
    () => hasFile(main, 'HEAD', 'notes/ledger.txt'),
    () => remoteUrls(main),
    () => remoteUrls(worktree),
    () => remoteUrls(elsewhere),
    () => originHead(main),
    () => originHead(worktree),
    () => branchExists(main, 'me/task'),
    () => branchExists(main, 'gone'),
    () => worktrees(main),
    () => worktrees(worktree),
    () => worktrees(elsewhere),
    () => commitsAhead(worktree, 'main'),
    () => commitsAhead(main, 'origin/main'),
    () => commitsAhead(main, 'gone'),
    () => changedFiles(worktree),
    () => changedFiles(elsewhere),
    () => ignoredPaths(worktree),
  ];
  for (const call of calls) same(fake, call);
});

test('a branch name is valid under the fake exactly when real git says so', (t) => {
  const real = realRepo(t);
  const fake = fakeGit(declaredAs(real));
  for (const [name] of BRANCH_NAMES) same(fake, () => isBranchName(real.main, name), name);
});

test('status lines, and removing a worktree that has changes, answer under the fake as under real git', (t) => {
  const real = realRepo(t);
  const { main, worktree } = real;
  writeFileSync(path.join(worktree, 'notes.txt'), 'draft\n');
  mkdirSync(path.join(worktree, 'build'));
  writeFileSync(path.join(worktree, 'build/out.txt'), 'built\n');
  mkdirSync(path.join(main, '.git/info'), { recursive: true });
  appendFileSync(path.join(main, '.git/info/exclude'), 'build/\n');
  const fake = fakeGit(declaredAs(real, { worktrees: [{ path: worktree, branch: 'me/task', status: ['?? notes.txt', '!! build/'] }] }));
  const calls: Call[] = [
    () => changedFiles(worktree),
    () => ignoredPaths(worktree),
    () => outcome(removeLinkedWorktree(main, worktree, false)),
    () => worktrees(main),
    () => outcome(removeLinkedWorktree(main, worktree, true)),
    () => worktrees(main),
  ];
  for (const call of calls) same(fake, call);
});

test('commits, fetch, fast-forward and branch deletion answer under the fake as under real git', (t) => {
  const real = realRepo(t);
  const { h, main, worktree, origin, first } = real;
  mkdirSync(path.join(worktree, 'notes'));
  writeFileSync(path.join(worktree, 'notes/ledger.txt'), 'notes\n');
  git(h, worktree, 'add', 'notes/ledger.txt');
  git(h, worktree, 'commit', '--quiet', '-m', 'second');
  const second = git(h, worktree, 'rev-parse', 'HEAD');
  // To the address rather than the remote's name, so that main's origin/main stays at the first commit until a fetch.
  git(h, worktree, 'push', '--quiet', origin, 'me/task:main');
  git(h, main, 'branch', 'moved', first);
  const fake = fakeGit(
    declaredAs(real, {
      refs: { 'refs/heads/me/task': second, 'refs/heads/moved': first },
      commits: { [second]: { subject: 'second', date: git(h, worktree, 'log', '-1', '--format=%cs'), parent: first, files: ['notes/ledger.txt'] } },
      originBranches: { main: second },
    }),
  );
  const calls: Call[] = [
    () => hasFile(main, second, 'notes/ledger.txt'),
    () => hasFile(main, 'me/task', 'notes/ledger.txt'),
    () => hasFile(main, first, 'notes/ledger.txt'),
    () => commitSubject(main, 'me/task'),
    () => lastCommitDate(worktree),
    () => shortCommit(worktree, 'HEAD'),
    () => commitsAhead(worktree, 'main'),
    () => commitsAhead(main, 'me/task'),
    () => outcome(fetchBranch(main, 'origin', 'main')),
    () => commitOf(main, 'origin/main'),
    () => commitsAhead(main, 'main', 'origin/main'),
    () => outcome(fetchBranch(main, 'origin', 'gone')),
    () => outcome(fastForward(main, 'origin/main')),
    () => commitOf(main, 'HEAD'),
    () => outcome(fastForward(worktree, first)),
    () => commitOf(worktree, 'HEAD'),
    () => deleteBranchAt(main, 'moved', second),
    () => deleteBranchAt(main, 'moved', first),
    () => branchExists(main, 'moved'),
    () => deleteBranchAt(main, 'me/task', second),
  ];
  for (const call of calls) same(fake, call);
});

test('worktree add, remove, repair and prune answer under the fake as under real git', (t) => {
  const real = realRepo(t);
  const { main, worktree, elsewhere, first } = real;
  const fake = fakeGit(declaredAs(real));
  const next = worktreeOf(main, 'next');
  const undo = worktreeOf(main, 'undo');
  const calls: Call[] = [
    () => outcome(addWorktree(main, next, 'me/next', first)),
    () => mainFirst(worktrees(main)),
    () => currentBranch(next),
    () => outcome(addWorktree(main, worktreeOf(main, 'again'), 'me/next', first)),
    () => outcome(removeLinkedWorktree(main, next, false)),
    () => worktrees(main),
    () => branchExists(main, 'me/next'),
    () => deleteBranchAt(main, 'me/next', first),
    () => outcome(addWorktree(main, undo, 'me/undo', first)),
    () => removeWorktree(main, undo, 'me/undo'),
    () => worktrees(main),
    () => branchExists(main, 'me/undo'),
    () => outcome(repairWorktree(main, worktree)),
    () => outcome(repairWorktree(main, elsewhere)),
  ];
  for (const call of calls) same(fake, call);
  rmSync(worktree, { recursive: true, force: true });
  same(fake, () => outcome(pruneWorktrees(main)));
  same(fake, () => worktrees(main));
});

test('a detached HEAD answers under the fake as under real git', (t) => {
  const real = realRepo(t);
  const { h, main, worktree, first } = real;
  git(h, worktree, 'checkout', '--quiet', '--detach');
  const fake = fakeGit(declaredAs(real, { worktrees: [{ path: worktree, head: first }] }));
  const calls: Call[] = [
    () => currentBranch(worktree),
    () => checkedOutBranch(worktree),
    () => commitOf(worktree, 'HEAD'),
    () => worktrees(main),
    () => deleteBranchAt(main, 'me/task', first),
    () => branchExists(main, 'me/task'),
  ];
  for (const call of calls) same(fake, call);
});
