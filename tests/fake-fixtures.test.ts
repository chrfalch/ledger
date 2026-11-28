import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { systemClock } from '../tools/ledger/clock.js';
import { currentBranch, replaceGitForTests, shortCommit, worktrees } from '../tools/ledger/git.js';
import { repoKey } from '../tools/ledger/repo-key.js';
import { inRun, type RunIo } from '../tools/ledger/run-io.js';
import {
  fakeClock,
  fakeRepository,
  fakeWorktreeTask,
  git,
  home,
  readLedgerFile,
  repoKeyOf,
  repository,
  runInProcessWith,
  useFakeGit,
  worktreeOf,
  worktreeTask,
  type Ran,
} from './ledger-core-fixtures.js';

const T0 = '2026-11-20T10:00:00Z';
const SLUG = 'fix-login';

/** A PATH entry whose only `git` notes each start and fails, so no git process starts unseen. */
function tripwire(h: string): { bin: string; io: RunIo; started: () => string } {
  const bin = path.join(h, 'tripwire-bin');
  const log = path.join(h, 'git-started.log');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "git $*" >> '${log}'\nexit 97\n`);
  chmodSync(path.join(bin, 'git'), 0o755);
  return { bin, io: { env: { ...process.env, PATH: bin }, console, clock: systemClock }, started: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}

type Repo = { h: string; app: string; worktree: string; file: string; env: NodeJS.ProcessEnv };

/** ~/repos/app with the active task fix-login, made by real git; so before fakedRepo, whose fake answers for git until the test ends. */
function realRepo(t: TestContext): Repo {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  return { h, app, worktree: worktreeOf(app, SLUG), file: worktreeTask(h, app, { slug: SLUG }), env: {} };
}

/**
 * The same repo and task declared to the fake, made under the tripwire. `within` runs `calls` under it too; `started`
 * gives each git process that started, and `calls` how many commands the fake answered.
 */
function fakedRepo(t: TestContext): Repo & { within: <T>(calls: () => T) => T; started: () => string; calls: () => number } {
  const h = home(t);
  const fake = useFakeGit(t);
  const trip = tripwire(h);
  const { app, file } = inRun(trip.io, () => {
    const app = fakeRepository(fake, h, path.join(h, 'repos/app'));
    return { app, file: fakeWorktreeTask(fake, h, app, { slug: SLUG }) };
  });
  const env = { PATH: `${path.join(h, 'stub-bin')}${path.delimiter}${trip.bin}` };
  const within = <T>(calls: () => T): T => inRun(trip.io, calls);
  return { h, app, worktree: worktreeOf(app, SLUG), file, env, within, started: trip.started, calls: () => fake.calls.length };
}

/** The commands the moved test files run, from the folder each runs in, at T0. */
const COMMANDS: [where: 'app' | 'worktree', args: string[]][] = [
  ['app', ['task', 'claim', SLUG, '--session', 's1']],
  ['worktree', ['show']],
  ['app', ['list', '--json']],
  ['worktree', ['task', 'done']],
];

async function runAll(repo: Repo): Promise<Ran[]> {
  const ran: Ran[] = [];
  for (const [where, args] of COMMANDS) ran.push(await runInProcessWith(repo.h, repo[where], { clock: fakeClock(T0), env: repo.env }, ...args));
  return ran;
}

/**
 * `text` with placeholders for the HOME, the short commit of main and the time the record file was written, which `list`
 * reads from the disk rather than the clock, so two repos that differ only there read the same.
 */
const normalized = (text: string, h: string, short: string): string =>
  text.replaceAll(h, '<home>').replaceAll(short, '<short>').replace(/"updated": "[^"]*"/g, '"updated": "<time>"');

const shown = (ran: Ran, h: string, short: string): Ran => ({ status: ran.status, stdout: normalized(ran.stdout, h, short), stderr: normalized(ran.stderr, h, short) });

test('the ledger answers in a fake repository and worktree task as in the ones real git makes', async (t) => {
  const real = realRepo(t);
  const realShort = git(real.h, real.app, 'rev-parse', '--short', 'main');
  const realRuns = await runAll(real);
  const faked = fakedRepo(t);
  const fakeShort = faked.within(() => shortCommit(faked.app, 'main')) ?? assert.fail('the fake has no main');
  const fakeRuns = await runAll(faked);
  for (const [index, [where, args]] of COMMANDS.entries()) {
    const label = `ledger ${args.join(' ')} in the ${where}`;
    assert.equal(realRuns[index].status, 0, `${label}: ${realRuns[index].stderr}`);
    assert.deepEqual(shown(fakeRuns[index], faked.h, fakeShort), shown(realRuns[index], real.h, realShort), label);
  }
  assert.equal(normalized(readLedgerFile(faked.file), faked.h, fakeShort), normalized(readLedgerFile(real.file), real.h, realShort));
  assert.equal(faked.started(), '', 'a git process started');
  assert.ok(faked.calls() > 0, 'the fake answered no git call');
});

test('the ledger sees the fake worktree on me/<slug>, and its record bases it on main at the short commit git.ts reads', (t) => {
  const { app, worktree, file, within, started } = fakedRepo(t);
  const short = within(() => shortCommit(app, 'main'));
  assert.match(short ?? '', /^[0-9a-f]{7}$/);
  assert.deepEqual(within(() => worktrees(app)), [{ path: app, branch: 'main' }, { path: worktree, branch: `me/${SLUG}` }]);
  assert.equal(within(() => currentBranch(worktree)), `me/${SLUG}`);
  assert.ok(existsSync(path.join(worktree, '.claude')), 'the worktree has a .claude folder');
  const text = readLedgerFile(file);
  assert.match(text, new RegExp(`^- worktree: ${worktree}$`, 'm'));
  assert.match(text, new RegExp(`^- branch: me/${SLUG}$`, 'm'));
  assert.match(text, new RegExp(`^- base: origin/main @ ${short}$`, 'm'));
  assert.equal(started(), '', 'a git process started');
});

test('repoKeyOf of a fake repository is the key the ledger files it under, and starts no git process', (t) => {
  const { h, app, within, started } = fakedRepo(t);
  const key = within(() => repoKeyOf(app));
  assert.equal(key, path.join(h, 'remotes/app'));
  assert.equal(key, within(() => repoKey(app)));
  assert.equal(started(), '', 'a git process started');
});

test('repoKeyOf with real git: the origin path without .git, else the main path for a repo without origin or a folder that is gone', (t) => {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  assert.equal(repoKeyOf(app), path.join(h, 'remotes/app'));
  const lone = path.join(h, 'repos/lone');
  mkdirSync(lone, { recursive: true });
  git(h, lone, 'init', '--quiet', '-b', 'main');
  assert.equal(repoKeyOf(lone), lone);
  const gone = path.join(h, 'repos/gone');
  assert.equal(repoKeyOf(gone), gone);
});

test('useFakeGit called twice in one test gives one fake, and git is back as it was once the test ends', async (t) => {
  const before = replaceGitForTests(undefined);
  replaceGitForTests(before);
  await t.test('twice', (inner) => {
    const fake = useFakeGit(inner);
    assert.equal(useFakeGit(inner), fake);
  });
  assert.equal(replaceGitForTests(before), before, 'a fake is left in place of git');
});

test('a fake repository leaves the home outside any repository, where git finds no checkout', (t) => {
  const { h, within, started } = fakedRepo(t);
  assert.equal(within(() => currentBranch(h)), undefined);
  assert.equal(started(), '', 'a git process started');
});

test('fakeWorktreeTask fails with a clear message in a fake repository without a main branch', (t) => {
  const h = home(t);
  const fake = useFakeGit(t);
  const app = fakeRepository(fake, h, path.join(h, 'repos/app'));
  delete fake.state.repos[app].refs?.['refs/heads/main'];
  assert.throws(() => fakeWorktreeTask(fake, h, app, { slug: SLUG }), { message: `the fake repository at ${app} has no refs/heads/main to branch the worktree from` });
});
