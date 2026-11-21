import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { REPO } from './helpers.js';
import { commandEnv, git, home, LEDGER_BIN, ok, readLedgerFile, repository, storeFolder, worktreeTask, type Ran } from './ledger-core-fixtures.js';

/** A HOME with ~/.claude/ledger.template.md and the repo ~/repos/app. */
function setup(t: TestContext) {
  const h = home(t);
  copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
  const app = repository(h, path.join(h, 'repos/app'));
  return { h, app };
}

const worktreeOf = (main: string, slug: string): string => path.join(main, '.claude/worktrees', slug);
const ledgerOf = (worktree: string): string => path.join(worktree, '.claude/ledger.md');
const installLog = (h: string): string => path.join(h, 'installs.log');

/** Each install the stubs ran, as `<tool> <args> in <folder>`. */
const installs = (h: string): string[] => (existsSync(installLog(h)) ? readFileSync(installLog(h), 'utf8').trim().split('\n') : []);

/**
 * A stub for each package manager in <home>/stub-bin: it logs its arguments and folder, prints a line to stdout, and makes
 * node_modules, as a real install does. A tool in `failing` prints 15 numbered lines and exits 1 instead, after it made
 * a partial node_modules, as an install that fails partway does.
 */
function stubInstallers(h: string, failing: string[] = []): void {
  for (const tool of ['bun', 'pnpm', 'yarn', 'npm']) {
    const file = path.join(h, 'stub-bin', tool);
    const log = `printf '%s\\n' "${tool} $* in $PWD" >> "$HOME/installs.log"`;
    const body = failing.includes(tool)
      ? ['mkdir -p node_modules/partial', 'i=1', 'while [ $i -le 15 ]; do echo "line $i"; i=$((i+1)); done >&2', 'exit 1']
      : ['echo "noisy install output"', 'mkdir -p node_modules'];
    writeFileSync(file, ['#!/bin/sh', log, ...body, ''].join('\n'));
    chmodSync(file, 0o755);
  }
}

/** `ledger` with no session from the environment the tests run in, and `session` when given. */
function run(h: string, cwd: string, { session, env: extra = {} }: { session?: string; env?: NodeJS.ProcessEnv }, ...args: string[]): Ran {
  const env = { ...commandEnv(h), ...extra };
  if (session !== undefined) env.CLAUDE_CODE_SESSION_ID = session;
  const result = spawnSync(LEDGER_BIN, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Commits `files` to main and pushes them, so a worktree made from origin/main has them at its root. */
function commitFiles(h: string, app: string, ...files: string[]): void {
  for (const file of files) writeFileSync(path.join(app, file), '{}\n');
  git(h, app, 'add', ...files);
  git(h, app, 'commit', '--quiet', '-m', 'lockfiles');
  git(h, app, 'push', '--quiet', 'origin', 'main');
}

const goJson = (h: string, app: string, slug: string, session?: string) => JSON.parse(ok(run(h, app, { ...(session === undefined ? {} : { session }) }, 'go', slug, '--json')));

for (const [lockfile, command] of [
  ['bun.lock', 'bun install --frozen-lockfile'],
  ['bun.lockb', 'bun install --frozen-lockfile'],
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn install --frozen-lockfile'],
  ['package-lock.json', 'npm ci'],
  ['npm-shrinkwrap.json', 'npm ci'],
] as const) {
  test(`ledger go of a backlog task with ${lockfile} runs ${command} once, in the new worktree, and names it in the result`, (t) => {
    const { h, app } = setup(t);
    stubInstallers(h);
    commitFiles(h, app, lockfile);
    ok(run(h, app, {}, 'task', 'new', 'fix-login'));
    const started = goJson(h, app, 'fix-login');
    const worktree = worktreeOf(app, 'fix-login');
    assert.deepEqual(installs(h), [`${command} in ${worktree}`]);
    assert.equal(started.installed, command);
    assert.equal(existsSync(path.join(worktree, 'node_modules')), true);
  });
}

const LOCKFILES = ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json'];

test('the first lockfile in the order bun, pnpm, yarn, npm picks the package manager', (t) => {
  const { h, app } = setup(t);
  stubInstallers(h);
  commitFiles(h, app, 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb');
  for (const [slug, kept, expected] of [
    ['all', ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'], 'bun install --frozen-lockfile'],
    ['no-bun', ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'], 'pnpm install --frozen-lockfile'],
    ['no-pnpm', ['package-lock.json', 'yarn.lock'], 'yarn install --frozen-lockfile'],
  ] as const) {
    const worktree = path.dirname(path.dirname(worktreeTask(h, app, { slug })));
    for (const lockfile of LOCKFILES.filter((name) => !(kept as readonly string[]).includes(name))) rmSync(path.join(worktree, lockfile), { force: true });
    assert.equal(goJson(h, app, slug).installed, expected);
  }
});

test('ledger go runs no install without a lockfile, and none when node_modules exists; the result has no installed field', (t) => {
  const { h, app } = setup(t);
  stubInstallers(h);
  ok(run(h, app, {}, 'task', 'new', 'plain'));
  const plain = goJson(h, app, 'plain');
  assert.equal('installed' in plain, false);
  const file = worktreeTask(h, app, { slug: 'has-modules' });
  const worktree = path.dirname(path.dirname(file));
  writeFileSync(path.join(worktree, 'package-lock.json'), '{}\n');
  mkdirSync(path.join(worktree, 'node_modules'));
  const present = goJson(h, app, 'has-modules');
  assert.equal('installed' in present, false);
  assert.deepEqual(installs(h), []);
});

test('ledger go to a task that has a worktree installs when node_modules is missing, and not again once it exists', (t) => {
  const { h, app } = setup(t);
  stubInstallers(h);
  const file = worktreeTask(h, app, { slug: 'fix-login' });
  const worktree = path.dirname(path.dirname(file));
  writeFileSync(path.join(worktree, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  const first = run(h, app, {}, 'go', 'fix-login');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^packages pnpm install --frozen-lockfile$/m);
  assert.doesNotMatch(first.stdout + first.stderr, /noisy install output/, 'the install output is captured, not shown');
  ok(run(h, app, {}, 'go', 'fix-login'));
  assert.deepEqual(installs(h), [`pnpm install --frozen-lockfile in ${worktree}`]);
});

test('a failed install exits 5, names the command and its last 10 lines, keeps the worktree and ledger, and a later go installs again', (t) => {
  const { h, app } = setup(t);
  stubInstallers(h, ['npm']);
  commitFiles(h, app, 'package-lock.json');
  ok(run(h, app, {}, 'task', 'new', 'fix-login'));
  const backlog = path.join(storeFolder(h, 'ledger-backlog', app), 'fix-login.json');
  const failed = run(h, app, { session: 's1' }, 'go', 'fix-login');
  assert.equal(failed.status, 5, failed.stderr);
  assert.match(failed.stderr, /npm ci/);
  for (let line = 6; line <= 15; line += 1) assert.match(failed.stderr, new RegExp(`^line ${line}$`, 'm'));
  assert.doesNotMatch(failed.stderr, /^line 5$/m, 'only the last 10 lines');
  const worktree = worktreeOf(app, 'fix-login');
  assert.equal(existsSync(ledgerOf(worktree)), true, 'the worktree and its ledger stay');
  assert.equal(existsSync(backlog), false, 'the ledger is not moved back');
  assert.match(readLedgerFile(ledgerOf(worktree)), /^- claim: session s1 /m);

  const json = JSON.parse(run(h, app, { session: 's1' }, 'go', 'fix-login', '--json').stdout);
  assert.equal(json.ok, false);
  assert.match(json.error, /npm ci/);

  stubInstallers(h);
  const retried = goJson(h, app, 'fix-login', 's1');
  assert.equal(retried.installed, 'npm ci');
  assert.equal(installs(h).length, 3);
});

test('an install whose command is not on PATH is a failed install: exit 5, naming the command', (t) => {
  const { h, app } = setup(t);
  const bin = path.join(h, 'only-bin');
  mkdirSync(bin);
  for (const tool of ['node', 'git']) symlinkSync(onPath(tool) ?? assert.fail(`${tool} is not on PATH`), path.join(bin, tool));
  const searched = [path.join(h, 'stub-bin'), bin, '/usr/bin', '/bin'];
  if (searched.some((folder) => isExecutable(path.join(folder, 'bun')))) return t.skip('bun is installed in a system folder');
  const file = worktreeTask(h, app, { slug: 'fix-login' });
  writeFileSync(path.join(path.dirname(path.dirname(file)), 'bun.lock'), '{}\n');
  const ran = run(h, app, { env: { PATH: searched.join(path.delimiter) } }, 'go', 'fix-login');
  assert.equal(ran.status, 5, ran.stderr);
  assert.match(ran.stderr, /bun install --frozen-lockfile/);
});

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const onPath = (name: string): string | undefined =>
  (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((folder) => path.join(folder, name))
    .find(isExecutable);
