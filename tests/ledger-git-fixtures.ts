import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { limitCloneGitCalls } from '../tools/ledger/clone.js';
import { onBackgroundSyncForTests } from '../tools/ledger/git-store.js';
import { resetGitLimits } from '../tools/ledger/git.js';
import { limitHookTimeForTests } from '../tools/ledger/hooks.js';
import { limitLockWaitForTests, limitLockWaits } from '../tools/ledger/lock.js';
import { limitPrCheckTimeForTests } from '../tools/ledger/pr-check.js';
import { readRecordJson, renderRecord } from '../tools/ledger/record.js';
import { forgetRepoKeys } from '../tools/ledger/repo-key.js';
import { runEnv } from '../tools/ledger/run-io.js';
import { limitBusyWaitForTests } from '../tools/ledger/sqlite-store.js';
import { forgetCreatedCopies } from '../tools/ledger/store.js';
import { allowRemoteForTests } from '../tools/ledger/sync.js';
import { processFolder, replay, type Replay } from './git-fixture-copies.js';
import { REPO } from './helpers.js';
import { commandEnv, git, home, LEDGER_BIN, ok, PRELOAD_OPTIONS, runInProcessWith, type Ran } from './ledger-core-fixtures.js';

export const URL = 'https://github.com/me/ledgers.git';
export const SSH_URL = 'git@github.com:me/ledgers.git';
export const PASSWORD = 'hunter2-not-for-print';
export const URL_WITH_USERINFO = `https://me:${PASSWORD}@github.com/me/ledgers.git`;

/**
 * The origin that the repo app of every machine is cloned from: one repo on all machines, with one key (LLP 0001 D10),
 * so the folder of its ledgers in the clone is the same on each, and in every test that uses it.
 */
export const APP_ORIGIN = (() => {
  const folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'ledger-app-origin-')));
  after(() => rmSync(folder, { recursive: true, force: true }));
  const [origin, seed] = [path.join(folder, 'app.git'), path.join(folder, 'seed')];
  git(folder, folder, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(folder, folder, 'init', '--quiet', '-b', 'main', seed);
  git(folder, seed, 'commit', '--quiet', '--allow-empty', '-m', 'first');
  git(folder, seed, 'push', '--quiet', origin, 'main');
  return origin;
})();
export const APP_KEY = APP_ORIGIN.replace(/\.git$/, '');
/** The folder of app's ledgers in the clone, in ~/.claude/ledger-evidence and in file storage. */
export const APP = encodeURIComponent(APP_KEY);
export const APP_PATTERN = APP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Built at run time, so no secret-like text sits in this file for a scanner to find. */
export const token = (prefix: string, body: string, length: number): string => `${prefix}${body.repeat(Math.ceil(length / body.length)).slice(0, length)}`;
export const GITHUB_TOKEN = token(['gh', 'p_'].join(''), 'A1b2C3d4E5', 36);

export type Machine = { h: string; clone: string; app: string; status: string; bare: string };

/** A bare repository that stands in for the private GitHub repository. */
export function remote(t: TestContext): string {
  const bare = path.join(home(t), 'ledgers.git');
  cpSync(EMPTY_BARE(), bare, { recursive: true });
  return bare;
}

/** Built on first use. A copy equals one built anew, as neither git init nor this clone writes the path of its own folder into it. */
const once = <T>(build: () => T): (() => T) => {
  let built: { value: T } | undefined;
  return () => (built ??= { value: build() }).value;
};

const EMPTY_BARE = once(() => {
  const folder = path.join(processFolder(), 'remote');
  mkdirSync(folder);
  const bare = path.join(folder, 'ledgers.git');
  git(folder, folder, 'init', '--quiet', '--bare', '-b', 'main', bare);
  return bare;
});

const APP_CLONE = once(() => {
  const folder = path.join(processFolder(), 'app-clone');
  mkdirSync(folder);
  const app = path.join(folder, 'app');
  git(folder, folder, 'clone', '--quiet', APP_ORIGIN, app);
  return app;
});

type GhAnswer = { visibility: string; isEmpty: boolean } | 'fail';

/**
 * The stub gh prints the answer the test set in $HOME/gh-answer.json, and notes each call in $HOME/gh-calls. A call
 * made while $HOME/gh-hold exists answers only once $HOME/gh-release exists.
 */
export function answerGh(h: string, answer: GhAnswer): void {
  const file = path.join(h, 'gh-answer.json');
  if (answer === 'fail') rmSync(file, { force: true });
  else writeFileSync(file, JSON.stringify(answer));
}

/**
 * A machine: a fake HOME whose git sends every GitHub URL of these tests to `bare`, with no git identity and no
 * default branch set, a stub gh that answers PRIVATE, and a repo `app`. Storage is not set.
 */
export function machine(t: TestContext, bare: string): Machine {
  let h = '';
  // Registered before home() registers the removal of HOME, as hooks run in the order they were registered.
  t.after(() => stopBackgroundSyncs(h));
  h = home(t);
  const urls = [URL, SSH_URL, URL_WITH_USERINFO].map((url) => `\tinsteadOf = ${url}\n`).join('');
  writeFileSync(path.join(h, '.gitconfig'), `[url "${bare}"]\n${urls}`);
  const gh = path.join(h, 'stub-bin/gh');
  writeFileSync(
    gh,
    [
      '#!/bin/sh',
      '[ "$1 $2" = "repo view" ] || { echo "gh: not logged in" >&2; exit 4; }',
      // Decided before the call is noted, so a test that sees the call can take gh-hold away for later calls only.
      'held=; [ ! -f "$HOME/gh-hold" ] || held=1',
      'printf "%s\\n" "$*" >> "$HOME/gh-calls"',
      `[ -z "$held" ] || { ${holdUntil('$HOME/gh-release')}; }`,
      '[ ! -f "$HOME/gh-delay" ] || sleep "$(cat "$HOME/gh-delay")"',
      '[ -f "$HOME/gh-answer.json" ] || { echo "gh: not logged in" >&2; exit 4; }',
      'cat "$HOME/gh-answer.json"',
      '',
    ].join('\n'),
  );
  chmodSync(gh, 0o755);
  answerGh(h, { visibility: 'PRIVATE', isEmpty: true });
  copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
  const app = path.join(h, 'repos', 'app');
  mkdirSync(path.dirname(app));
  cpSync(APP_CLONE(), app, { recursive: true });
  writeFileSync(path.join(app, '.git/info/exclude'), '.claude/\n');
  return { h, app, bare, clone: path.join(h, '.claude/ledger-data'), status: path.join(h, '.claude/ledger-data.status.json') };
}

/**
 * A shell command that waits until `file` exists, so a hook or stub holds while the test checks what happens meanwhile.
 * It gives up after 15 s, so a test that fails before it creates `file` does not hang.
 */
export const holdUntil = (file: string): string => `i=0; while [ ! -e "${file}" ] && [ "$i" -lt 150 ]; do sleep 0.1; i=$((i + 1)); done`;

/** Where the preloaded module notes the pid of each background sync a ledger command of HOME `h` starts. */
export const backgroundPids = (h: string): string => path.join(h, 'background-sync-pids');

/**
 * The environment of a ledger command on `m`: its git may send the GitHub URLs of these tests to the bare repository,
 * and each background sync it starts is noted, so the test can stop it.
 */
export const machineEnv = (m: Machine): NodeJS.ProcessEnv => ({
  ...commandEnv(m.h),
  LEDGER_TEST_REMOTE: m.bare,
  LEDGER_TEST_BACKGROUND_PIDS: backgroundPids(m.h),
  NODE_OPTIONS: PRELOAD_OPTIONS,
});

export const runs = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Kills each background sync of HOME `h` that still runs, with git and the hooks it started, and waits until each has exited. */
async function stopBackgroundSyncs(h: string): Promise<void> {
  const file = backgroundPids(h);
  if (h === '' || !existsSync(file)) return;
  const pids = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number);
  for (const pid of pids.filter(runs)) {
    try {
      // A detached child leads a process group of its own.
      process.kill(-pid, 'SIGKILL');
    } catch {
      // It exited meanwhile.
    }
  }
  for (let waited = 0; pids.some(runs); waited += 50) {
    if (waited > 10_000) throw new Error(`background syncs ${pids.filter(runs).join(', ')} did not exit`);
    await delay(50);
  }
}

export const quietEnv = (m: Machine): NodeJS.ProcessEnv => ({ ...machineEnv(m), LEDGER_TEST_NO_BACKGROUND_SYNC: '1' });

export type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv; input?: string };

export function run(m: Machine, args: string[], options: RunOptions = {}): Ran {
  const result = spawnSync(LEDGER_BIN, args, { cwd: options.cwd ?? m.app, env: options.env ?? quietEnv(m), input: options.input, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export const ledgerOk = (m: Machine, ...args: string[]): string => ok(run(m, args));

/** The setters the preloaded module calls with these variables of a spawned command; each gives the limit it replaces. */
const LIMITS = {
  LEDGER_TEST_HOOK_TIME_MS: limitHookTimeForTests,
  LEDGER_TEST_PR_CHECK_TIME_MS: limitPrCheckTimeForTests,
  LEDGER_TEST_LOCK_WAIT_MS: limitLockWaitForTests,
  LEDGER_TEST_BUSY_WAIT_MS: limitBusyWaitForTests,
};

const noteBackgroundSync = (pid: number): void => {
  const file = runEnv().LEDGER_TEST_BACKGROUND_PIDS;
  if (file) appendFileSync(file, `${pid}\n`);
};

/**
 * `run` inside this process, with what the preloaded module gives a spawned command: the bare repository of `m` as the
 * test remote, the limits the environment lowers, and a note of each background sync. Its runs must not overlap.
 */
export async function runHere(m: Machine, args: string[], { cwd = m.app, env = quietEnv(m), input }: RunOptions = {}): Promise<Ran> {
  allowRemoteForTests(m.bare);
  onBackgroundSyncForTests(noteBackgroundSync);
  const restores: (() => void)[] = Object.entries(LIMITS).flatMap(([variable, limit]) => {
    if (!env[variable]) return [];
    const replaced = limit(Number(env[variable]));
    return [() => limit(replaced)];
  });
  try {
    return await runInProcessWith(m.h, cwd, { env, input }, ...args);
  } finally {
    for (const restore of restores) restore();
    // A hook run leaves its deadlines set until the next run starts; a test that calls ledger code directly must not inherit them.
    resetGitLimits();
    limitCloneGitCalls(Infinity);
    limitLockWaits(Infinity);
  }
}

/** Leaves the modules as a ledger run does at its start, and as `runHere` does at its end. */
function resetRunState(): void {
  forgetRepoKeys();
  forgetCreatedCopies();
  resetGitLimits();
  limitCloneGitCalls(Infinity);
  limitLockWaits(Infinity);
}

/** `ledgerOk` inside this process. */
export const ledgerOkHere = async (m: Machine, ...args: string[]): Promise<string> => ok(await runHere(m, args));

export function failed(ran: Ran): string {
  assert.equal(ran.status, 1, `exit 1 expected; stdout:\n${ran.stdout}\nstderr:\n${ran.stderr}`);
  return `${ran.stdout}${ran.stderr}`;
}

/** git without the asserting wrapper, for a command that may fail. */
export function gitRan(h: string, cwd: string, ...args: string[]): Ran {
  const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, env: commandEnv(h), encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The commit of the remote's main branch; '' while it has none. Any other failure throws, so no check passes on a remote it could not read. */
export function remoteHead(bare: string): string {
  const ran = gitRan(path.dirname(bare), bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/main');
  // --verify --quiet exits 1, silently, for a ref that does not exist.
  if (ran.status !== 0 && (ran.status !== 1 || ran.stderr !== '')) throw new Error(`git rev-parse failed in ${bare} (exit ${ran.status}): ${ran.stderr}`);
  return ran.stdout.trim();
}

/** The files of the remote's main branch; none while it has no main branch. */
export const remoteFiles = (bare: string): string[] => (remoteHead(bare) === '' ? [] : git(path.dirname(bare), bare, 'ls-tree', '-r', '--name-only', 'refs/heads/main').split('\n').filter(Boolean));

export const remoteText = (bare: string, file: string): string => git(path.dirname(bare), bare, 'show', `refs/heads/main:${file}`);

/** A task record on the remote, rendered to Markdown as the store reads it. */
export const remoteLedger = (bare: string, file: string): string => renderRecord(readRecordJson(remoteText(bare, file), file));

export const useGitStorage = (m: Machine): void => writeFileSync(path.join(m.h, '.claude/ledger-settings.json'), JSON.stringify({ storage: 'git' }));

/**
 * Writes what `store sync init` wrote when it last ran on a machine with the same files, if it did. A copy still needs
 * what init does at its own time: the time of its privacy check, and the stat data of the clone's files in its index.
 */
function copiedInit(m: Machine, name: string): Replay {
  const replayed = replay(name, [m.h, path.dirname(m.bare)]);
  if (replayed.copied) {
    const config = path.join(m.clone, '.git/config');
    writeFileSync(config, readFileSync(config, 'utf8').replace(/^(\tcheckedPrivate = )\d+/m, `$1${Date.now()}`));
    git(m.h, m.clone, 'update-index', '-q', '--refresh');
  }
  return replayed;
}

/** `ledger store sync init` on a machine, then git storage. */
export function setUp(m: Machine, url = URL): void {
  const replayed = copiedInit(m, `spawned init ${url}`);
  if (!replayed.copied) {
    ok(run(m, ['store', 'sync', 'init', url]));
    replayed.record();
  }
  useGitStorage(m);
}

/** `setUp` inside this process. */
export async function setUpHere(m: Machine, url = URL): Promise<void> {
  const replayed = copiedInit(m, `init here ${url}`);
  if (replayed.copied) {
    allowRemoteForTests(m.bare);
    onBackgroundSyncForTests(noteBackgroundSync);
    resetRunState();
  } else {
    ok(await runHere(m, ['store', 'sync', 'init', url]));
    replayed.record();
  }
  useGitStorage(m);
}

export function today(): string {
  const date = new Date();
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(2, '0')).join('-');
}

const sessionContext = (ran: Ran): string => {
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout === '' ? '' : (JSON.parse(ran.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
};

const sessionStart = (cwd: string, env: NodeJS.ProcessEnv): RunOptions => ({ cwd, env, input: JSON.stringify({ hook_event_name: 'SessionStart', cwd }) });

export const hookContext = (m: Machine, cwd = m.h, env = quietEnv(m)): string => sessionContext(run(m, ['hook', 'session-start'], sessionStart(cwd, env)));

/** `hookContext` inside this process. */
export const hookContextHere = async (m: Machine, cwd = m.h, env = quietEnv(m)): Promise<string> => sessionContext(await runHere(m, ['hook', 'session-start'], sessionStart(cwd, env)));

export const lineOf = (text: string, needle: string): number => text.split('\n').findIndex((line) => line.includes(needle)) + 1;

export const hookFile = (m: Machine): string => path.join(m.clone, '.git/hooks/pre-push');

/** A clone of `bare` outside ledger, for commits ledger would never make. */
export function plainClone(m: Machine, name = 'other'): string {
  const other = path.join(m.h, name);
  git(m.h, m.h, 'clone', '--quiet', m.bare, other);
  return other;
}

/** Commits everything in `other` and pushes it to main without any pre-push hook. */
export function pushFrom(m: Machine, other: string, message: string): void {
  git(m.h, other, 'add', '-A');
  git(m.h, other, 'commit', '--quiet', '-m', message);
  git(m.h, other, 'push', '--quiet', '--no-verify', 'origin', 'HEAD:main');
}

export async function until(done: () => boolean, what: string, ms = 20_000): Promise<void> {
  for (let waited = 0; !done(); waited += 100) {
    assert.ok(waited < ms, `${what} did not happen in ${ms} ms`);
    await delay(100);
  }
}

/**
 * Whether no background sync of `m` holds its lock or the guard its release takes. A sync pushes under that lock, so
 * once its push is seen, this says it writes nothing more into the HOME the test removes.
 */
export const backgroundSyncDone = (m: Machine): boolean => ['ledger-data.sync.lock', 'ledger-data.sync.lock.reclaim'].every((file) => !existsSync(path.join(m.h, '.claude', file)));

