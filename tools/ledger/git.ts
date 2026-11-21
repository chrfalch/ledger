import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { redacted } from './clone.js';
import { mainOfTaskWorktree } from './paths.js';

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

/** Whether a git call in `folder` or a folder that holds it was stopped by the limit of limitGitCalls. */
export function gitTimedOut(folder: string): boolean {
  for (let current = path.resolve(folder); ; current = path.dirname(current)) {
    if (unanswered.has(current)) return true;
    if (current === path.dirname(current)) return false;
  }
}

function run(folder: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
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
  const result = spawnSync('git', ['-C', folder, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout });
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

export const commitOf = (folder: string, ref: string): string | undefined => line(folder, 'rev-parse', '--quiet', '--verify', `${ref}^{commit}`);

export const shortCommit = (folder: string, commit: string): string | undefined => line(folder, 'rev-parse', '--short', commit);

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

/** `git fetch <remote> <branch>`, which also moves <remote>/<branch>; git's error text when it fails. FETCH_HEAD is not written, so a fetch that brings nothing changes no file. */
export function fetchBranch(main: string, remote: string, branch: string): string | undefined {
  const result = run(main, ['fetch', '--quiet', '--no-write-fetch-head', remote, branch]);
  return result.ok ? undefined : result.stderr || 'git fetch failed';
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

/** Drops what git keeps of each worktree whose folder is gone; undefined when it did, else git's error text. */
export function pruneWorktrees(main: string): string | undefined {
  const result = run(main, ['worktree', 'prune']);
  return result.ok ? undefined : result.stderr || 'git worktree prune failed';
}

/**
 * Deletes the branch only while it still points at `commit`, without git's merge check, which a squash-merged branch
 * never passes. `moved` when it points elsewhere now; otherwise git's error text.
 */
export function deleteBranchAt(main: string, branch: string, commit: string): 'deleted' | 'moved' | { error: string } {
  const result = run(main, ['update-ref', '-d', `refs/heads/${branch}`, commit]);
  if (result.ok) {
    // update-ref leaves the branch's config section behind, which `git branch -D` would remove.
    run(main, ['config', '--remove-section', `branch.${branch}`]);
    return 'deleted';
  }
  return commitOf(main, `refs/heads/${branch}`) === commit ? { error: result.stderr || 'git update-ref failed' } : 'moved';
}

/** gh in `folder`; with `timeoutMs`, it is stopped then, and that is an error too. */
export function gh(folder: string, args: string[], { timeoutMs }: { timeoutMs?: number } = {}): { ok: boolean; stdout: string; error: string } {
  const result = spawnSync('gh', args, { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') return { ok: false, stdout: '', error: `gh did not answer in ${(timeoutMs ?? 0) / 1000} s` };
  if (result.error) return { ok: false, stdout: '', error: `gh did not run: ${result.error.message}` };
  // One line without a closing period, as callers put it inside their own sentence; gh may name a token.
  const stderr = redacted((result.stderr ?? '').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim());
  return { ok: result.status === 0, stdout: result.stdout ?? '', error: `gh ${args.slice(0, 2).join(' ')} failed (exit ${result.status ?? 'none'})${stderr ? `: ${stderr}` : ''}` };
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
