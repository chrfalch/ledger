import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { redacted } from './clone.js';
import { mainOfTaskWorktree } from './paths.js';
import { runEnv } from './run-io.js';

let timeoutMs: number | undefined;
let deadline = Infinity;
const unanswered = new Set<string>();

/**
 * Stops each later git call of this process after `ms`. A folder whose call was stopped counts as no repository from
 * then on and is not asked again, nor is any folder inside it, nor, for a task worktree, its main checkout and the
 * other worktrees there. So a hanging repo costs one wait. For hooks, which must not stall Claude Code. With `until`, a
 * time from Date.now(), a call also stops then, and none starts after it.
 */
export function limitGitCalls(ms: number, until = Infinity): void {
  timeoutMs = ms;
  deadline = until;
}

/** Lifts the limits of limitGitCalls, and forgets which folders did not answer. */
export function resetGitLimits(): void {
  timeoutMs = undefined;
  deadline = Infinity;
  unanswered.clear();
}

/** Runs `calls` under limitGitCalls(ms, until), then puts back the limits and the folders that did not answer as they were. */
export function withGitLimits<T>(ms: number, until: number, calls: () => T): T {
  const before = { timeoutMs, deadline, unanswered: [...unanswered] };
  limitGitCalls(ms, until);
  try {
    return calls();
  } finally {
    timeoutMs = before.timeoutMs;
    deadline = before.deadline;
    unanswered.clear();
    for (const folder of before.unanswered) unanswered.add(folder);
  }
}

/** Whether a git call in `folder` or a folder that holds it was stopped by the limit of limitGitCalls. */
export function gitTimedOut(folder: string): boolean {
  for (let current = path.resolve(folder); ; current = path.dirname(current)) {
    if (unanswered.has(current)) return true;
    if (current === path.dirname(current)) return false;
  }
}

// spawnSync stops a child at 1 MiB of output by default, which git status passes in a checkout with a few thousand untracked files.
const MAX_OUTPUT = 256 * 1024 * 1024;

function run(folder: string, args: string[], env = runEnv()): { ok: boolean; stdout: string; stderr: string } {
  const unanswering = { ok: false, stdout: '', stderr: `git did not answer in ${folder}` };
  const markUnanswered = (): void => {
    const stopped = path.resolve(folder);
    unanswered.add(mainOfTaskWorktree(stopped) ?? stopped);
  };
  if (gitTimedOut(folder)) return unanswering;
  const timeout = timeoutMs === undefined ? undefined : Math.min(timeoutMs, deadline - Date.now());
  if (timeout !== undefined && timeout <= 0) {
    markUnanswered();
    return unanswering;
  }
  const result = spawnSync('git', ['-C', folder, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, env, maxBuffer: MAX_OUTPUT });
  if (result.error !== undefined && 'code' in result.error && result.error.code === 'ETIMEDOUT') markUnanswered();
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: (result.stderr ?? '').trim() };
}

function git(folder: string, ...args: string[]): string | undefined {
  const result = run(folder, args);
  return result.ok ? result.stdout : undefined;
}

const line = (folder: string, ...args: string[]): string | undefined => git(folder, ...args)?.trim() || undefined;

/** The git folder every worktree of the repo shares. */
export const commonDir = (folder: string): string | undefined => line(folder, 'rev-parse', '--path-format=absolute', '--git-common-dir');

/** The git folder of the checkout that holds `folder`: for a linked worktree, its own folder under the common dir. */
export const gitDir = (folder: string): string | undefined => line(folder, 'rev-parse', '--absolute-git-dir');

/** The main checkout of the repo that holds `folder`, or undefined outside a git repository. */
export function mainCheckout(folder: string): string | undefined {
  const common = commonDir(folder);
  return common ? path.dirname(common) : undefined;
}

/** Whether `folder` is in a repo's main checkout, whose git folder is the one every worktree shares; false outside a git repository. */
export function inMainCheckout(folder: string): boolean {
  const own = line(folder, 'rev-parse', '--path-format=absolute', '--git-dir');
  return own !== undefined && own === commonDir(folder);
}

/** The top folder of the checkout, main or linked, that holds `folder`. */
export const checkoutRoot = (folder: string): string | undefined => line(folder, 'rev-parse', '--show-toplevel');

/** Undefined on a detached HEAD. */
export const currentBranch = (folder: string): string | undefined => line(folder, 'branch', '--show-current');

/** As currentBranch, but with git's error text when git fails, which currentBranch cannot tell from a detached HEAD. */
export function checkedOutBranch(folder: string): { branch?: string } | { error: string } {
  const result = run(folder, ['branch', '--show-current']);
  if (!result.ok) return { error: result.stderr || 'git branch --show-current failed' };
  const branch = result.stdout.trim();
  return branch === '' ? {} : { branch };
}

/** Whether `commit` has `file`, a path from the top of the repo. */
export const hasFile = (folder: string, commit: string, file: string): boolean => run(folder, ['cat-file', '-e', `${commit}:${file}`]).ok;

export const commitOf = (folder: string, ref: string): string | undefined => line(folder, 'rev-parse', '--quiet', '--verify', `${ref}^{commit}`);

export const shortCommit = (folder: string, commit: string): string | undefined => line(folder, 'rev-parse', '--short', commit);

export const commitSubject = (folder: string, commit: string): string | undefined => line(folder, 'log', '-1', '--format=%s', commit);

/** The fetch address of each remote by name; undefined when git cannot list them. */
export function remoteUrls(folder: string): Map<string, string> | undefined {
  const listed = git(folder, 'remote', '-v');
  if (listed === undefined) return undefined;
  const fetched = listed.split('\n').flatMap((entry) => {
    // A partial clone's line ends with its filter, as in "(fetch) [blob:none]".
    const [, name, url] = /^(\S+)\t(.*) \(fetch\)(?: \[[^\]]*\])?$/.exec(entry) ?? [];
    return name === undefined ? [] : [[name, url] as const];
  });
  return new Map(fetched);
}

/** The remote default branch, such as origin/main. */
export const originHead = (main: string): string | undefined => line(main, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');

export const branchExists = (main: string, branch: string): boolean => run(main, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok;

export const isBranchName = (main: string, branch: string): boolean => run(main, ['check-ref-format', '--branch', branch]).ok;

/** A new branch at `commit`, checked out in a new worktree; git's error text when that fails. */
export function addWorktree(main: string, folder: string, branch: string, commit: string): string | undefined {
  const result = run(main, ['worktree', 'add', '--quiet', '-b', branch, folder, commit]);
  return result.ok ? undefined : result.stderr || 'git worktree add failed';
}

/** Undoes addWorktree; best effort, because it only runs after another failure. */
export function removeWorktree(main: string, folder: string, branch: string): void {
  run(main, ['worktree', 'remove', '--force', folder]);
  run(main, ['branch', '--quiet', '-D', branch]);
}

export type Worktree = { path: string; branch?: string };

/** Every checkout of the repo at `main`, the main checkout first. Empty when `main` is not a repo. */
export function worktrees(main: string): Worktree[] {
  const listed = git(main, 'worktree', 'list', '--porcelain');
  if (listed === undefined) return [];
  return listed
    .split('\n\n')
    .map((block) => block.split('\n'))
    .flatMap((lines) => {
      const folder = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
      const ref = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length);
      if (folder === undefined) return [];
      return [{ path: folder, ...(ref === undefined ? {} : { branch: ref.replace(/^refs\/heads\//, '') }) }];
    });
}

/**
 * Fetches <branch> of <remote> into <remote>/<branch>, whichever branches the fetch refspecs of the remote name; git's
 * error text when it fails. FETCH_HEAD is not written, so a fetch that brings nothing changes no file. With `prompt`
 * false, git fails rather than ask for credentials on the terminal.
 */
export function fetchBranch(main: string, remote: string, branch: string, { prompt = true }: { prompt?: boolean } = {}): string | undefined {
  const env = prompt ? runEnv() : { ...runEnv(), GIT_TERMINAL_PROMPT: '0' };
  const result = run(main, ['fetch', '--quiet', '--no-write-fetch-head', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], env);
  return result.ok ? undefined : result.stderr || 'git fetch failed';
}

/** `git merge --ff-only <ref>` in the checkout of `folder`; git's error text when it fails. */
export function fastForward(folder: string, ref: string): string | undefined {
  const result = run(folder, ['merge', '--quiet', '--ff-only', ref]);
  return result.ok ? undefined : result.stderr || 'git merge --ff-only failed';
}

/** The commits `head` has that `base` has not; undefined when git cannot count them. */
export function commitsAhead(folder: string, base: string, head = 'HEAD'): number | undefined {
  const count = line(folder, 'rev-list', '--count', `${base}..${head}`);
  return count !== undefined && /^\d+$/.test(count) ? Number(count) : undefined;
}

const porcelain = (folder: string, ...flags: string[]): string[] | undefined => git(folder, 'status', '--porcelain', ...flags)?.split('\n').filter((entry) => entry !== '');

/** One `git status --porcelain` line per changed or untracked file. */
export const changedFiles = (folder: string): string[] | undefined => porcelain(folder);

/** The ignored files and folders of a checkout, relative to its top; a folder ends in /. Paths git had to quote are left out. */
export const ignoredPaths = (folder: string): string[] | undefined =>
  porcelain(folder, '--ignored')
    ?.filter((entry) => entry.startsWith('!! ') && !entry.startsWith('!! "'))
    .map((entry) => entry.slice('!! '.length));

/** YYYY-MM-DD of the last commit. */
export const lastCommitDate = (folder: string): string | undefined => line(folder, 'log', '-1', '--format=%cs');

/** `git worktree remove`; git's error text when it fails. */
export function removeLinkedWorktree(main: string, folder: string, force: boolean): string | undefined {
  const result = run(main, ['worktree', 'remove', ...(force ? ['--force'] : []), folder]);
  return result.ok ? undefined : result.stderr || 'git worktree remove failed';
}

/** undefined when git repaired its link to the worktree `folder`, else git's error text. */
export function repairWorktree(main: string, folder: string): string | undefined {
  const result = run(main, ['worktree', 'repair', folder]);
  return result.ok ? undefined : result.stderr || 'git worktree repair failed';
}

/** Drops what git keeps of each worktree whose folder is gone; undefined when it did, else git's error text. */
export function pruneWorktrees(main: string): string | undefined {
  const result = run(main, ['worktree', 'prune']);
  return result.ok ? undefined : result.stderr || 'git worktree prune failed';
}

/**
 * Deletes the branch only while it still points at `commit`, without git's merge check, which a squash-merged branch
 * never passes. `moved` when it points elsewhere now, `checkedOut` the worktree that has it checked out, which git's
 * update-ref would not protect; otherwise git's error text.
 */
export function deleteBranchAt(main: string, branch: string, commit: string): 'deleted' | 'moved' | { checkedOut: string } | { error: string } {
  const holder = worktrees(main).find((worktree) => worktree.branch === branch);
  if (holder !== undefined) return { checkedOut: holder.path };
  const result = run(main, ['update-ref', '-d', `refs/heads/${branch}`, commit]);
  if (result.ok) {
    // update-ref leaves the branch's config section behind, which `git branch -D` would remove.
    run(main, ['config', '--remove-section', `branch.${branch}`]);
    return 'deleted';
  }
  return commitOf(main, `refs/heads/${branch}`) === commit ? { error: result.stderr || 'git update-ref failed' } : 'moved';
}

type GhResult = { ok: boolean; stdout: string; error: string };

/** How one gh process ended; `spawnError` says why it did not run. */
type GhRun = { status: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string };

const ghTimedOut = (timeoutMs: number): GhResult => ({ ok: false, stdout: '', error: `gh did not answer in ${timeoutMs / 1000} s` });

function ghResult(args: string[], { status, stdout, stderr, timedOut, spawnError }: GhRun, timeoutMs = 0): GhResult {
  if (timedOut) return ghTimedOut(timeoutMs);
  if (spawnError !== undefined) return { ok: false, stdout: '', error: `gh did not run: ${spawnError}` };
  // One line without a closing period, as callers put it inside their own sentence; gh may name a token.
  const shown = redacted(stderr.replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim());
  return { ok: status === 0, stdout, error: `gh ${args.slice(0, 2).join(' ')} failed (exit ${status ?? 'none'})${shown ? `: ${shown}` : ''}` };
}

/** gh in `folder`; with `timeoutMs`, it is stopped then, and that is an error too. */
export function gh(folder: string, args: string[], { timeoutMs }: { timeoutMs?: number } = {}): GhResult {
  const result = spawnSync('gh', args, { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, env: runEnv() });
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  return ghResult(args, { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', timedOut, spawnError: timedOut ? undefined : result.error?.message }, timeoutMs);
}

// The hooks are synchronous, so the gh calls run at once in a child Node process, which prints how each one ended.
const GH_AT_ONCE = `
const { execFile } = require('node:child_process');
const { calls, timeoutMs } = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const run = ({ folder, args }) => new Promise((resolve) => {
  execFile('gh', args, { cwd: folder, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => resolve({
    status: error ? (typeof error.code === 'number' ? error.code : null) : 0,
    stdout,
    stderr,
    timedOut: Boolean(error && error.killed),
    spawnError: error && typeof error.code === 'string' ? error.message : undefined,
  }));
});
Promise.all(calls.map(run)).then((runs) => process.stdout.write(JSON.stringify(runs)));
`;

/** How long the child process may take beyond `timeoutMs` to start and report before it counts as hung. */
const GH_AT_ONCE_SLACK_MS = 2000;

/** Runs every gh call at once; one not done in `timeoutMs` is an error, as with gh(). */
function ghAtOnce(calls: { folder: string; args: string[] }[], timeoutMs: number): GhResult[] {
  if (calls.length === 0) return [];
  const result = spawnSync(process.execPath, ['-e', GH_AT_ONCE], { input: JSON.stringify({ calls, timeoutMs }), encoding: 'utf8', timeout: timeoutMs + GH_AT_ONCE_SLACK_MS, env: runEnv() });
  let runs: unknown;
  try {
    runs = JSON.parse(result.stdout ?? '');
  } catch {
    // No report: the child process hung or failed, which the answer below says for every call.
  }
  if (Array.isArray(runs) && runs.length === calls.length) return (runs as GhRun[]).map((run, index) => ghResult(calls[index].args, run, timeoutMs));
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  return calls.map(() => (timedOut ? ghTimedOut(timeoutMs) : { ok: false, stdout: '', error: `gh did not run: ${result.error?.message ?? (result.stderr || 'no report').trim()}` }));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The default branch of the GitHub repo of `folder`, such as main, as gh names it. */
export function ghDefaultBranch(folder: string): string | { error: string } {
  const result = gh(folder, ['repo', 'view', '--json', 'defaultBranchRef']);
  if (!result.ok) return { error: result.error };
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const ref = isRecord(parsed) ? parsed.defaultBranchRef : undefined;
    const name = isRecord(ref) ? ref.name : undefined;
    if (typeof name === 'string' && name !== '') return name;
  } catch {
    // Not JSON: the same answer as JSON without a branch name.
  }
  return { error: 'gh repo view printed no default branch' };
}

/** The PRs gh lists from the branch `branch`, as records; an error when gh fails or prints no JSON list. */
function listPrs(folder: string, branch: string, state: string, fields: string, limit?: number): Record<string, unknown>[] | { error: string } {
  const result = gh(folder, ['pr', 'list', '--head', branch, '--state', state, '--json', fields, ...(limit === undefined ? [] : ['--limit', String(limit)])]);
  if (!result.ok) return { error: result.error };
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (Array.isArray(parsed)) return parsed.filter(isRecord);
  } catch {
    // Not JSON: the same answer as JSON that is not a list.
  }
  return { error: 'gh pr list printed something that is not a JSON list' };
}

/** `ledger list` and `ledger show` ask it, so a gh that hangs must not hang them. */
const PR_STATE_TIMEOUT_MS = 10_000;

/** Whether gh says the PR `pr`, a number or URL, is merged; unknown when gh does not run, fails or prints no state. */
export function prState(folder: string, pr: string): 'merged' | 'not merged' | 'unknown' {
  const result = gh(folder, ['pr', 'view', pr, '--json', 'state'], { timeoutMs: PR_STATE_TIMEOUT_MS });
  if (!result.ok) return 'unknown';
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const state = isRecord(parsed) ? parsed.state : undefined;
    if (typeof state === 'string') return state === 'MERGED' ? 'merged' : 'not merged';
  } catch {
    // Not JSON: the same answer as JSON without a state.
  }
  return 'unknown';
}

/** A check of a PR: a check run has a conclusion once it is done, a commit status has a state; empty when it has none. */
export type PrCheck = { conclusion: string; state: string };

/** What gh says of a PR: its state, as MERGED, its review decision, empty for none, and its checks. */
export type PrView = { state: string; reviewDecision: string; checks: PrCheck[] };

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

function prView(stdout: string): PrView | { error: string } {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (isRecord(parsed) && typeof parsed.state === 'string') {
      const rollup = Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup.filter(isRecord) : [];
      return { state: parsed.state, reviewDecision: textOf(parsed.reviewDecision), checks: rollup.map(({ conclusion, state }) => ({ conclusion: textOf(conclusion), state: textOf(state) })) };
    }
  } catch {
    // Not JSON: the same answer as JSON without a state.
  }
  return { error: 'gh pr view printed no PR state' };
}

/** What gh says of each PR, a number or URL asked in its folder; all are asked at once, and each gets `timeoutMs`. */
export function prViews(queries: { folder: string; pr: string }[], timeoutMs: number): (PrView | { error: string })[] {
  const calls = queries.map(({ folder, pr }) => ({ folder, args: ['pr', 'view', pr, '--json', 'state,reviewDecision,statusCheckRollup'] }));
  return ghAtOnce(calls, timeoutMs).map((result) => (result.ok ? prView(result.stdout) : { error: result.error }));
}

/** gh lists 30 PRs unless told otherwise; a branch reused for years can have more merged ones than that. */
const MERGED_PR_LIMIT = 1000;

/** The head commit of each merged PR from the branch. */
export function mergedPrHeads(folder: string, branch: string): string[] | { error: string } {
  const prs = listPrs(folder, branch, 'merged', 'number,headRefOid', MERGED_PR_LIMIT);
  return 'error' in prs ? prs : prs.flatMap(({ headRefOid }) => (typeof headRefOid === 'string' ? [headRefOid] : []));
}

export type PullRequest = { state: string; number: number };

/** Every PR from the branch, open, closed or merged, newest first as gh lists them. */
export function branchPrs(folder: string, branch: string): PullRequest[] | { error: string } {
  const prs = listPrs(folder, branch, 'all', 'state,number');
  return 'error' in prs ? prs : prs.flatMap(({ state, number }) => (typeof state === 'string' && typeof number === 'number' ? [{ state, number }] : []));
}
