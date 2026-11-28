import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { runLedger, type LedgerIo, type LedgerRun } from '../tools/ledger/cli.js';
import { fileStore } from '../tools/ledger/file-store.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { REPO } from './helpers.js';
import { backlogTask, commandEnv, home, repository, worktreeOf, worktreeTask } from './ledger-core-fixtures.js';

const io = (h: string, cwd: string, more: Partial<LedgerIo> = {}): LedgerIo => ({ home: h, cwd, env: commandEnv(h), ...more });

/** Runs `argv` in this process, and checks that nothing of it reached this process's own stdout and stderr. */
async function runQuietly(t: TestContext, argv: string[], given: LedgerIo): Promise<LedgerRun> {
  const spies = [t.mock.method(process.stdout, 'write'), t.mock.method(process.stderr, 'write'), t.mock.method(console, 'log'), t.mock.method(console, 'error')];
  const counts = (): number[] => spies.map((spy) => spy.mock.callCount());
  try {
    const ran = await runLedger(argv, given);
    assert.deepEqual(counts(), [0, 0, 0, 0], 'process.stdout.write, process.stderr.write, console.log, console.error');
    return ran;
  } finally {
    for (const spy of spies) spy.mock.restore();
  }
}

/** Sets the variable `name` of this process for the rest of the test; undefined removes it. */
function setProcessEnv(t: TestContext, name: string, value: string | undefined): void {
  const saved = process.env[name];
  const set = (to: string | undefined): void => {
    if (to === undefined) delete process.env[name];
    else process.env[name] = to;
  };
  set(value);
  t.after(() => set(saved));
}

/** A HOME with the template, and the repo ~/repos/app. */
function setup(t: TestContext) {
  const h = home(t);
  copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
  const app = repository(h, path.join(h, 'repos/app'));
  return { h, app };
}

test('help goes to the run, not to this process', async (t) => {
  const { h, app } = setup(t);
  const ran = await runQuietly(t, ['notes', '--help'], io(h, app));
  assert.equal(ran.code, 0, ran.stderr);
  assert.match(ran.stdout, /^Usage: ledger notes /);
  assert.match(ran.stdout, /ledger notes plan add "write the tests"/);
  assert.equal(ran.stderr, '');
});

test('a refused command gives its exit code and message, as text and with --json', async (t) => {
  const { h, app } = setup(t);
  const message = `No task ledger has the slug missing in the repo at ${app}.`;

  const text = await runQuietly(t, ['task', 'unpark', 'missing'], io(h, app));
  assert.deepEqual(text, { code: 1, stdout: '', stderr: `${message}\n` });

  const json = await runQuietly(t, ['task', 'unpark', 'missing', '--json'], io(h, app));
  assert.equal(json.code, 1);
  assert.deepEqual(JSON.parse(json.stdout), { ok: false, error: message });
  assert.equal(json.stderr, '');
});

test("commander's own refusal of an unknown option goes to the run's stderr", async (t) => {
  const { h, app } = setup(t);
  const ran = await runQuietly(t, ['list', '--bogus'], io(h, app));
  assert.deepEqual(ran, { code: 1, stdout: '', stderr: "error: unknown option '--bogus'\n" });
});

test('the store is read under io.home, not under $HOME', async (t) => {
  const { h, app } = setup(t);
  backlogTask(h, app, { slug: 'under-io-home' });
  setProcessEnv(t, 'HOME', home(t));

  const ran = await runQuietly(t, ['list', '--json'], io(h, app));
  assert.equal(ran.code, 0, ran.stderr);
  const { tasks } = JSON.parse(ran.stdout) as { tasks: { slug: string }[] };
  assert.deepEqual(
    tasks.map(({ slug }) => slug),
    ['under-io-home'],
  );
});

test('the task of the worktree the command runs in is found from io.cwd, not process.cwd()', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'here' });

  const ran = await runQuietly(t, ['show', '--json'], io(h, worktreeOf(app, 'here')));
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal((JSON.parse(ran.stdout) as { name: string }).name, 'here');
});

test('a claim is made for the session CLAUDE_CODE_SESSION_ID names in io.env', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'claimed' });
  setProcessEnv(t, 'CLAUDE_CODE_SESSION_ID', undefined);

  const ran = await runQuietly(t, ['task', 'claim', '--json'], io(h, worktreeOf(app, 'claimed'), { env: { ...commandEnv(h), CLAUDE_CODE_SESSION_ID: 'session-in-io' } }));
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal((JSON.parse(ran.stdout) as { claim: { session: string } }).claim.session, 'session-in-io');
});

test('git runs with io.env: its PATH and the variables only io.env has', async (t) => {
  const { h, app } = setup(t);
  const stubs = path.join(h, 'git-stub');
  mkdirSync(stubs);
  writeFileSync(path.join(stubs, 'git'), `#!/bin/sh\necho "$*" >> "$GIT_CALLS"\nPATH='${process.env.PATH}' exec git "$@"\n`);
  chmodSync(path.join(stubs, 'git'), 0o755);
  const calls = path.join(h, 'git-calls');
  const env = commandEnv(h);

  const ran = await runQuietly(t, ['task', 'new', 'probe', '--json'], io(h, app, { env: { ...env, GIT_CALLS: calls, PATH: `${stubs}${path.delimiter}${env.PATH}` } }));
  assert.equal(ran.code, 0, ran.stderr);
  assert.match(readFileSync(calls, 'utf8'), new RegExp(`^-C ${app} `, 'm'));
});

test('the hook acts on io.stdin', async (t) => {
  const { h, app } = setup(t);
  worktreeTask(h, app, { slug: 'from-stdin' });
  const stdin = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: worktreeOf(app, 'from-stdin') });

  const ran = await runQuietly(t, ['hook', 'session-start'], io(h, h, { stdin }));
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(ran.stderr, '');
  const output = JSON.parse(ran.stdout) as { hookSpecificOutput: { sessionTitle?: string } };
  assert.equal(output.hookSpecificOutput.sessionTitle, '🔨 from-stdin');
});

test("a run starts free of the git and lock time limits an earlier run's hook set", async (t) => {
  const { h, app } = setup(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const stdin = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: app });
  const hook = await runQuietly(t, ['hook', 'session-start'], io(h, h, { stdin }));
  assert.equal(hook.code, 0, hook.stderr);

  // Past the end the hook set for every later git call and lock wait of this process.
  now += 60_000;
  const ran = await runQuietly(t, ['task', 'new', 'after-hook', '--json'], io(h, app));
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal((JSON.parse(ran.stdout) as { slug: string }).slug, 'after-hook');
});

test('a store given in io.store is the one read, and the run does not close it', async (t) => {
  const { h, app } = setup(t);
  const elsewhere = home(t);
  backlogTask(elsewhere, app, { slug: 'in-given-store' });
  const close = t.mock.fn();

  const ran = await runQuietly(t, ['list', '--json'], io(h, app, { store: { ...fileStore(ledgerPaths(elsewhere)), close } }));
  assert.equal(ran.code, 0, ran.stderr);
  const { tasks } = JSON.parse(ran.stdout) as { tasks: { slug: string }[] };
  assert.deepEqual(
    tasks.map(({ slug }) => slug),
    ['in-given-store'],
  );
  assert.equal(close.mock.callCount(), 0);
});
