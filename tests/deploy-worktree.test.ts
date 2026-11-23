import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { DeployError, parseDeployArguments } from '../tools/deploy.js';
import { freshHome, REPO, snapshot } from './helpers.js';

/** Links each top-level entry of this repo into `folder`, so bin/deploy run from there deploys from `folder`. */
function linkRepoInto(folder: string): void {
  for (const name of readdirSync(REPO)) {
    if (name !== '.git' && name !== '.claude') symlinkSync(path.join(REPO, name), path.join(folder, name));
  }
}

const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};

/**
 * A main checkout and a linked worktree of it, each holding this repo's files by links. The guard reads git in the
 * folder bin/deploy is called through, so these tests hold whether this repo is itself a main checkout or a worktree.
 */
function checkouts(t: TestContext): { main: string; worktree: string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ledger-checkouts-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'main');
  const worktree = path.join(root, 'task');
  mkdirSync(main);
  git(main, 'init', '--quiet', '-b', 'main');
  git(main, 'commit', '--quiet', '--allow-empty', '-m', 'first');
  git(main, 'worktree', 'add', '--quiet', '--detach', worktree);
  linkRepoInto(main);
  linkRepoInto(worktree);
  return { main, worktree };
}

function deploy(home: string, checkout: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(path.join(checkout, 'bin/deploy'), args, {
    cwd: home,
    env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), DEPLOY_FROM_WORKTREE: undefined, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  return result;
}

const refusal = ({ main, worktree }: { main: string; worktree: string }): string =>
  `deploy: ${worktree} is a linked worktree, and retiring its task deletes it along with every link deploy would make. Run deploy from the main checkout: cd ${main} && bin/deploy\n`;

const warning = ({ main, worktree }: { main: string; worktree: string }): string =>
  `deploy: deploying from the linked worktree ${worktree}; retiring its task deletes it and breaks every link made here. To restore them: cd ${main} && bin/deploy\n`;

for (const args of [[], ['--dry-run'], ['--revert'], ['--revert', '--dry-run'], ['--no-codex', '--force']]) {
  test(`bin/deploy ${args.join(' ') || 'with no arguments'} from a linked worktree refuses in one line, names the main checkout, and writes nothing`, (t) => {
    const fixture = checkouts(t);
    const home = freshHome(t);
    const before = snapshot(home);
    const result = deploy(home, fixture.worktree, args);
    assert.deepEqual({ status: result.status, stdout: result.stdout, stderr: result.stderr }, { status: 1, stdout: '', stderr: refusal(fixture) });
    assert.deepEqual(snapshot(home), before);
  });
}

test('deploy with no arguments in a terminal refuses from a linked worktree before the wizard loads', (t) => {
  const fixture = checkouts(t);
  const home = freshHome(t);
  const deployModule = JSON.stringify(path.join(REPO, 'tools/deploy.ts'));
  const script = [
    "for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, 'isTTY', { value: true });",
    `const { main } = await import(${deployModule});`,
    'main([]);',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: REPO,
    env: { ...process.env, HOME: home, DEPLOY_REPO: fixture.worktree, DEPLOY_FROM_WORKTREE: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.deepEqual({ status: result.status, stderr: result.stderr }, { status: 1, stderr: refusal(fixture) });
});

test('bin/deploy --from-worktree deploys from a linked worktree and warns, in one line, how to restore the links', (t) => {
  const fixture = checkouts(t);
  const home = freshHome(t);
  const result = deploy(home, fixture.worktree, ['--from-worktree']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, warning(fixture));
  assert.ok(existsSync(path.join(home, '.claude/.ledger-manifest')));
  assert.equal(realpathSync(path.join(home, '.local/bin/ledger')), realpathSync(path.join(REPO, 'bin/ledger')));
});

test('DEPLOY_FROM_WORKTREE=1 deploys from a linked worktree without a warning', (t) => {
  const fixture = checkouts(t);
  const home = freshHome(t);
  const result = deploy(home, fixture.worktree, [], { DEPLOY_FROM_WORKTREE: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(existsSync(path.join(home, '.claude/.ledger-manifest')));
});

test('bin/deploy --help from a linked worktree prints the help, which explains the guard and --from-worktree', (t) => {
  const fixture = checkouts(t);
  const result = deploy(freshHome(t), fixture.worktree, ['--help']);
  assert.deepEqual({ status: result.status, stderr: result.stderr }, { status: 0, stderr: '' });
  assert.match(result.stdout, /^Deploy ledger\./);
  assert.match(result.stdout, /^ {2}bin\/deploy --from-worktree +\S/m);
  assert.match(result.stdout, /linked worktree/);
});

for (const args of [['--migrate'], ['--migrate', '--dry-run']]) {
  test(`bin/deploy ${args.join(' ')} runs from a linked worktree: it moves stored data and links nothing`, (t) => {
    const fixture = checkouts(t);
    const home = freshHome(t);
    const result = deploy(home, fixture.worktree, args);
    assert.deepEqual({ status: result.status, stderr: result.stderr }, { status: 0, stderr: '' });
    assert.equal(result.stdout, 'Nothing to move.\n');
  });
}

for (const args of [[], ['--from-worktree']]) {
  test(`bin/deploy ${args.join(' ') || 'with no arguments'} from a main checkout deploys with neither refusal nor warning`, (t) => {
    const fixture = checkouts(t);
    const home = freshHome(t);
    const result = deploy(home, fixture.main, args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(existsSync(path.join(home, '.claude/.ledger-manifest')));
  });
}

test('bin/deploy from a folder git does not know deploys without refusing', (t) => {
  const folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'ledger-plain-')));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  linkRepoInto(folder);
  const home = freshHome(t);
  const result = deploy(home, folder, ['--dry-run'], { GIT_CEILING_DIRECTORIES: path.dirname(folder) });
  assert.deepEqual({ status: result.status, stderr: result.stderr }, { status: 0, stderr: '' });
});

test('--from-worktree parses to fromWorktree, and --migrate refuses it', () => {
  assert.deepEqual(parseDeployArguments(['--from-worktree']), { options: { fromWorktree: true }, help: false });
  for (const args of [['--migrate', '--from-worktree'], ['--from-worktree', '--migrate']]) {
    assert.throws(
      () => parseDeployArguments(args),
      (error: unknown) => error instanceof DeployError && error.message.includes('--migrate') && error.message.includes('--from-worktree'),
      args.join(' '),
    );
  }
});
