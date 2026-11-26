// @ref LLP 0000#deploy — when ledger deploy --latest stops, how it fast-forwards the main checkout, and what it reports.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModsChanges } from '../deploy-mods-lines.js';
import {
  changedFiles,
  checkedOutBranch,
  commitOf,
  commitsAhead,
  commitSubject,
  fastForward,
  fetchBranch,
  gitTimedOut,
  hasFile,
  mainCheckout,
  originHead,
  shortCommit,
  withGitLimits,
} from './git.js';
import { oneLine } from './hook-failures.js';
import { inRun, runClock, runConsole, runEnv } from './run-io.js';

export type DeployReport = {
  commit: string;
  subject: string;
  from: string;
  to: string;
  reinstalled: string[];
  installed: string[];
  warnings: string[];
  needsReload: boolean;
};

export type DeployRun = { code: number; stdout: string; stderr: string };

type Stopped = { error: string };

/** Stopped after the fast-forward: the main checkout moved, and bin/deploy, if it ran, may have changed mods. */
type FailedDeploy = DeployReport & { error: string };

type TimeLimit = { ms: number; deadline: number };

// For the whole run, under the 10-minute Bash limit of the agent that runs /ledger:deploy, so the agent gets this
// report rather than a kill.
const TIME_LIMIT_MS = 9 * 60_000;

// After SIGTERM at the time limit, bin/deploy and what it started get a tenth of the limit, at most 5 seconds, to end
// before SIGKILL: so the run ends soon after its limit, also when a process ignores SIGTERM.
const STOP_GRACE_MS = 5000;

// What `git rev-parse --local-env-vars` lists: the variables that tie git to one repository. Inherited, as in a git
// hook, they would point git and bin/deploy at the caller's repository rather than at the main checkout.
const REPO_VARIABLES = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
]);

/**
 * Fast-forwards the main checkout of the repo that holds `repo` to the default branch of origin, then runs its
 * bin/deploy with no terminal, all within `timeLimitMs`. Returns what to print rather than printing it.
 */
export async function deployLatest({ repo, json = false, timeLimitMs = TIME_LIMIT_MS }: { repo: string; json?: boolean; timeLimitMs?: number }): Promise<DeployRun> {
  const env = Object.fromEntries(Object.entries(runEnv()).filter(([name]) => !REPO_VARIABLES.has(name)));
  const limit = { ms: timeLimitMs, deadline: Date.now() + timeLimitMs };
  const outcome = await inRun({ env, console: runConsole(), clock: runClock() }, () => deployed(repo, limit));
  if (!('error' in outcome)) return { code: 0, stdout: json ? jsonText({ ok: true, ...outcome }) : reportText(outcome), stderr: '' };
  if (json) return { code: 1, stdout: jsonText({ ok: false, ...outcome }), stderr: '' };
  return { code: 1, stdout: '', stderr: 'commit' in outcome ? failureText(outcome) : `${outcome.error}\n` };
}

const jsonText = (value: object): string => `${JSON.stringify(value, null, 2)}\n`;

const MODS_LINES = 'tools/deploy-mods-lines.ts';

const NO_CHANGES: ModsChanges = { reinstalled: [], installed: [], warnings: [] };

async function deployed(repo: string, limit: TimeLimit): Promise<DeployReport | Stopped | FailedDeploy> {
  const moved = withGitLimits(limit.ms, limit.deadline, () => fastForwardMain(repo, limit));
  if ('error' in moved) return moved;
  const afterMove = (stop: Stopped): FailedDeploy => ({ ...stop, ...moved.commits, ...modsReport(NO_CHANGES) });
  const read = await modsLinesReader(moved.main);
  if (typeof read !== 'function') return afterMove(read);
  const left = limit.deadline - Date.now();
  if (left <= 0) return afterMove(stopped(`git fetch and git merge used up the ${durationText(limit.ms)} that ledger deploy --latest has, so bin/deploy did not start`));
  const run = await runDeploy(moved.main, left, limit);
  const report = { ...moved.commits, ...modsReport(read(run.stdout)) };
  return run.error === undefined ? report : { error: run.error, ...report };
}

const durationText = (ms: number): string => (ms % 60_000 === 0 ? `${ms / 60_000} minutes` : `${ms / 1000} seconds`);

const outOfTime = (limit: TimeLimit): string => `ran out of time; ledger deploy --latest has ${durationText(limit.ms)} in all`;

const stopped = (reason: string): Stopped => ({ error: `Nothing deployed: ${reason.replace(/[.\s]+$/, '')}.` });

type Moved = { main: string; commits: Pick<DeployReport, 'commit' | 'subject' | 'from' | 'to'> };

function fastForwardMain(repo: string, limit: TimeLimit): Moved | Stopped {
  const main = mainCheckout(repo);
  if (main === undefined) return stopped(`${repo} is not in a git repository`);
  // A git call cut off by the time limit fails as any other does; the stop then names the step that ran out of time.
  const stop = (step: string, reason: string): Stopped => stopped(gitTimedOut(main) ? `${step} ${outOfTime(limit)}` : reason);
  const upstream = originHead(main);
  if (upstream === undefined) return stop('git symbolic-ref', `${main} does not know the default branch of origin; git remote set-head origin --auto sets it`);
  const branch = upstream.slice('origin/'.length);
  // Asked before the fetch and again after it, since the checkout can change in the minutes a fetch can take.
  const unready = (): Stopped | undefined => {
    const changed = changedFiles(main);
    if (changed === undefined) return stop('git status', `git status failed in ${main}`);
    if (changed.some((entry) => !entry.startsWith('?? '))) return stopped(`the main checkout ${main} has uncommitted changes to tracked files`);
    const head = checkedOutBranch(main);
    if ('error' in head) return stop('git branch', `git branch --show-current failed in ${main}: ${oneLine(head.error)}`);
    if (head.branch === branch) return undefined;
    return stopped(`the main checkout ${main} is on ${head.branch === undefined ? 'a detached HEAD' : `the branch ${head.branch}`}, not on the default branch ${branch}`);
  };
  const before = unready();
  if (before !== undefined) return before;
  const fetchError = fetchBranch(main, 'origin', branch, { prompt: false });
  if (fetchError !== undefined) return stop(`git fetch origin ${branch}`, `git fetch origin ${branch} failed: ${oneLine(fetchError)}`);
  const after = unready();
  if (after !== undefined) return after;
  const ahead = commitsAhead(main, upstream);
  if (ahead === undefined) return stop('git rev-list', `git could not compare ${branch} with ${upstream} in ${main}`);
  if (ahead > 0) return stopped(`${branch} in ${main} has ${ahead} ${ahead === 1 ? 'commit' : 'commits'} that ${upstream} does not have`);
  // All read before the merge, which moves HEAD to exactly `target`: once the checkout has moved, no git call is left to fail.
  const target = commitOf(main, upstream);
  const from = shortCommit(main, 'HEAD');
  const to = target && shortCommit(main, target);
  if (target === undefined || from === undefined || to === undefined) return stop('git rev-parse', `git could not read the commits of HEAD and ${upstream} in ${main}`);
  if (!hasFile(main, target, MODS_LINES)) return stop('git cat-file', `${upstream} has no ${MODS_LINES}, so ledger could not read what its bin/deploy prints`);
  const subject = commitSubject(main, target) ?? '';
  const mergeError = fastForward(main, target);
  if (mergeError !== undefined) return stop(`git merge --ff-only ${upstream} in ${main}`, `git merge --ff-only ${upstream} in ${main} failed: ${oneLine(mergeError)}`);
  return { main, commits: { commit: to, subject, from, to } };
}

type ReadModsLines = (stdout: string) => ModsChanges;

let parserLoads = 0;

/**
 * readModsLines of the main checkout's tools/deploy-mods-lines.ts as the fast-forward left it, not of this process's copy:
 * the tools/deploy.ts of a new commit may print a new wording, which only the parser of that commit reads. Each load is
 * a new module, as one imported before keeps the version it read then.
 */
async function modsLinesReader(main: string): Promise<ReadModsLines | Stopped> {
  const file = path.join(main, MODS_LINES);
  try {
    const { readModsLines }: { readModsLines?: unknown } = await import(`${pathToFileURL(file).href}?load=${++parserLoads}`);
    if (typeof readModsLines !== 'function') throw new Error('it has no readModsLines');
    return readModsLines as ReadModsLines;
  } catch (error) {
    return stopped(`ledger could not load ${file}: ${oneLine(error instanceof Error ? error.message : String(error))}`);
  }
}

function modsReport({ reinstalled, installed, warnings }: ModsChanges): Pick<DeployReport, 'reinstalled' | 'installed' | 'warnings' | 'needsReload'> {
  return { reinstalled, installed, warnings, needsReload: reinstalled.length + installed.length > 0 };
}

async function runDeploy(main: string, timeoutMs: number, limit: TimeLimit): Promise<{ stdout: string; error?: string }> {
  // With no terminal on stdin and no DEPLOY_PULL_CHECK, bin/deploy neither fetches nor asks to pull: the fast-forward did that.
  const env = { ...runEnv() };
  delete env.DEPLOY_PULL_CHECK;
  const run = await runInOwnGroup([path.join(main, 'bin/deploy')], { cwd: main, env, timeoutMs, graceMs: Math.min(STOP_GRACE_MS, limit.ms / 10) });
  const failed = (how: string): { stdout: string; error: string } => {
    const printed = run.stderr.trim();
    return { stdout: run.stdout, error: `The deploy failed: bin/deploy ${how}.${printed === '' ? '' : `\n${printed}`}` };
  };
  if (run.timedOut) return failed(outOfTime(limit));
  if (run.spawnError !== undefined) return failed(`did not run: ${run.spawnError}`);
  if (run.signal !== null) return failed(`was stopped by ${run.signal}`);
  if (run.code !== 0) return failed(`exited with code ${run.code}`);
  return { stdout: run.stdout };
}

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

type GroupRun = { stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; spawnError?: string };

/**
 * Node running `args` in a process group of its own. After `timeoutMs` the whole group gets SIGTERM, and SIGKILL
 * `graceMs` later; a signal this process gets, SIGINT, SIGTERM or SIGHUP, goes to the whole group too. So the processes
 * the script waits for, such as claude plugin install, stop with it rather than outlive a signal to the script alone.
 */
function runInOwnGroup(args: string[], { cwd, env, timeoutMs, graceMs }: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; graceMs: number }): Promise<GroupRun> {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (text: string) => {
    stdout += text;
  });
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    stderr += text;
  });
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      // Every process of the group has ended.
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    signalGroup('SIGTERM');
    // As spawnSync does at its timeout, so that a process outside the group that holds the pipes cannot keep this waiting.
    child.stdout.destroy();
    child.stderr.destroy();
    // Not cancelled when the script ends: a process it started may ignore SIGTERM and outlive it.
    setTimeout(() => signalGroup('SIGKILL'), graceMs);
  }, timeoutMs);
  for (const signal of FORWARDED_SIGNALS) process.once(signal, signalGroup);
  return new Promise((resolve) => {
    const ended = (end: Pick<GroupRun, 'code' | 'signal' | 'spawnError'>): void => {
      clearTimeout(timer);
      for (const signal of FORWARDED_SIGNALS) process.off(signal, signalGroup);
      resolve({ stdout, stderr, timedOut, ...end });
    };
    child.on('error', (error) => ended({ code: null, signal: null, spawnError: error.message }));
    child.on('close', (code, signal) => ended({ code, signal }));
  });
}

const moveText = ({ from, to }: DeployReport): string => (from === to ? 'already up to date' : `moved from ${from} to ${to}`);

function modsText({ reinstalled, installed, warnings, needsReload }: DeployReport): string[] {
  return [
    ...(reinstalled.length > 0 ? [`Reinstalled: ${reinstalled.join(', ')}.`] : []),
    ...(installed.length > 0 ? [`Installed: ${installed.join(', ')}.`] : []),
    ...(needsReload ? ['Open Claude Code sessions need /reload-plugins.'] : []),
    ...warnings.map((warning) => `Warning: ${warning}`),
  ];
}

const linesText = (lines: string[]): string => `${lines.join('\n')}\n`;

const reportText = (report: DeployReport): string => linesText([`Deployed ${report.commit} "${report.subject}" (${moveText(report)}).`, ...modsText(report)]);

const failureText = (failed: FailedDeploy): string =>
  linesText([failed.error, `The main checkout is at ${failed.commit} "${failed.subject}" (${moveText(failed)}).`, ...modsText(failed)]);
