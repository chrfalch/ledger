import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ancestry,
  branchOf,
  checkFinished,
  clearStatus,
  clonePaths,
  cloneGit,
  cloneProblem,
  commitChanges,
  committingGit,
  countOf,
  FORMAT,
  GITIGNORE,
  type GitRun,
  installHook,
  isAncestor,
  MARKER,
  markerFormat,
  must,
  notLedgers,
  nulSeparated,
  readStatus,
  recordProblem,
  redacted,
  refExists,
  remoteGit,
  repairHook,
  setUpClone,
  shownPaths,
  SyncProblem,
  takeSyncNumber,
  unique,
  unsafeChanges,
  unsafeEntries,
  withCloneLock,
} from './clone.js';
import { fail, Failure } from './failure.js';
import { isFolder, isTaken, writeAtomic } from './files.js';
import { gh } from './git.js';
import { withLockIfFree } from './lock.js';
import { realPath, type LedgerPaths } from './paths.js';
import { ADDED_LINES_LOG, CHANGED_PATHS_LOG, MESSAGES_LOG, messageLocations, secretLocations } from './secret-scan.js';
import { readStorage } from './settings.js';
import { plural } from './views.js';

type Line = (text: string) => void;

const OWNER = '[A-Za-z0-9][A-Za-z0-9-]{0,38}';
const NAME = '[A-Za-z0-9_.-]+';
const GITHUB_URL = new RegExp(`^(?:https://(?:[A-Za-z0-9._~-]+(?::[^@/?#\\s:]+)?@)?github\\.com/|ssh://git@github\\.com/|git@github\\.com:)(${OWNER})/(${NAME})$`);

/**
 * github.com/<owner>/<repo> of a plain github.com URL: https, with a user name and password at most, or ssh as the user
 * git. Undefined for any other URL, also for one with a port, a query, a fragment or a path past the repository.
 */
export function githubRepo(url: string): string | undefined {
  const [, owner, name] = GITHUB_URL.exec(url) ?? [];
  const repo = name?.replace(/\.git$/, '');
  return owner === undefined || repo === undefined || /^\.*$/.test(repo) ? undefined : `github.com/${owner}/${repo}`;
}

const STOPPED = 'ledger store sync init stopped, and changed nothing';

type RepoView = { visibility?: unknown; isEmpty?: unknown };

let ghWaitMs = 30_000;

/** For tests only: how long the privacy check waits for gh. A module the tests preload calls it. */
export function limitGhWaitForTests(ms: number): void {
  ghWaitMs = ms;
}

/** The `fields` gh gives for `repo`, or why gh gave none, as the end of a sentence, redacted. */
function viewRepo(paths: LedgerPaths, repo: string, fields: string): { view: RepoView } | { reason: string } {
  const answer = gh(paths.home, ['repo', 'view', repo, '--json', fields], { timeoutMs: ghWaitMs });
  if (!answer.ok) return { reason: redacted(`it asks gh whether ${repo} is private, and ${answer.error}. Install gh and run gh auth login, then try again.`) };
  try {
    const view: unknown = JSON.parse(answer.stdout);
    return { view: typeof view === 'object' && view !== null ? view : {} };
  } catch {
    // Not JSON: the same as an answer without the fields.
    return { view: {} };
  }
}

/** Why `visibility` is not that of a private repository, as the end of a sentence, redacted; undefined when it is. */
function notPrivateBecause(repo: string, { visibility }: RepoView): string | undefined {
  if (visibility === 'PRIVATE') return undefined;
  const is = typeof visibility === 'string' ? visibility : 'of a visibility gh did not name';
  return redacted(`${repo} is ${is}, not PRIVATE. Ledgers hold notes about your work, so git storage pushes only to a private repository.`);
}

/** Why gh does not confirm that `repo` is private, as the end of a sentence; undefined when it does. */
function notPrivate(paths: LedgerPaths, repo: string): string | undefined {
  const answer = viewRepo(paths, repo, 'visibility');
  return 'reason' in answer ? answer.reason : notPrivateBecause(repo, answer.view);
}

/** Kept in the clone's own git config: when gh last said which repository is private. */
const CHECKED = 'ledger.checkedPrivate';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Asks gh whether `repo` is still private; with `daily`, only when no check said so in the last day, or a later check
 * said it is not.
 */
function checkPrivate(paths: LedgerPaths, clone: string, repo: string, daily: boolean): void {
  const { notPrivate: marker } = clonePaths(paths);
  const [at, checked] = cloneGit(clone, ['config', '--get', CHECKED]).stdout.trim().split(' ');
  // The marker also covers an earlier check that git could not remove from the clone config.
  if (daily && checked === repo && Date.now() - Number(at) < DAY_MS && !isTaken(marker)) return;
  // Written before gh is asked, so an answer that it is not private is never lost to a write that fails after it.
  let asking: string;
  try {
    asking = mark(marker, repo);
  } catch (error) {
    throw new SyncProblem(
      'private',
      redacted(`Nothing was pulled or pushed: ledger could not write ${paths.tilde(marker)}, which keeps later syncs from pushing should gh say ${repo} is not private, so it did not ask gh: ${(error as Error).message}`),
    );
  }
  const reason = notPrivate(paths, repo);
  if (reason === undefined) {
    return withCloneLock(clone, () => {
      must(cloneGit(clone, ['config', CHECKED, `${Date.now()} ${repo}`]));
      // Another text is from a check that started later, whose answer this older one must not undo.
      if (isTaken(marker) && readFileSync(marker, 'utf8') === asking) rmSync(marker, { force: true });
    });
  }
  try {
    mark(marker, repo);
  } catch {
    // Harmless: the marker written before gh was asked still blocks the cache.
  }
  const forget = (): GitRun => cloneGit(clone, ['config', '--unset-all', CHECKED]);
  let forgot: GitRun;
  try {
    forgot = withCloneLock(clone, forget);
  } catch {
    // Without the lock all the same: a background sync would otherwise trust the earlier check for up to a day.
    forgot = forget();
  }
  const kept = cloneGit(clone, ['config', '--get-all', CHECKED]).ok ? `\nGit could not remove the earlier check that it is private from the git config of ${paths.tilde(clone)}: ${forgot.stderr}` : '';
  throw new SyncProblem('private', `Nothing was pulled or pushed: ${reason}${kept}`);
}

/** Writes the not-private marker with a text no other check writes, and gives that text. */
function mark(marker: string, repo: string): string {
  const text = `${JSON.stringify({ repo, at: new Date().toISOString(), check: randomUUID() })}\n`;
  writeAtomic(marker, text);
  return text;
}

type Remote = { url: string; shown: string; repo: string };

let testRemote: string | undefined;

/**
 * For tests only: the one local bare repository that a URL rewrite may send the checked URL to. A module the tests
 * preload calls it; no argument or environment variable of ledger reaches it.
 */
export function allowRemoteForTests(bare: string): void {
  testRemote = bare;
}

/**
 * The URLs git fetches `url` from and pushes it to, as it rewrites them: by the longest url.<base>.insteadOf prefix, and
 * for a push by the longest pushInsteadOf prefix first.
 */
function rewrites(clone: string, url: string, deadline?: number): string[] {
  // "url.<base>.insteadof\n<prefix>", NUL-separated; exit 1 when there is none.
  const entries = nulSeparated(cloneGit(clone, ['config', '-z', '--get-regexp', '^url\\..*\\.(push)?insteadof$'], { deadline }).stdout).map((entry) => {
    const [key, prefix = ''] = entry.split(/\n(.*)/s);
    const push = key.endsWith('.pushinsteadof');
    return { push, base: key.slice('url.'.length, key.length - (push ? '.pushinsteadof' : '.insteadof').length), prefix };
  });
  const rewrite = (push: boolean): string | undefined => {
    // A stable sort, so of two prefixes as long, the first in the config wins, as in git.
    const [longest] = entries.filter((entry) => entry.push === push && url.startsWith(entry.prefix)).sort((a, b) => b.prefix.length - a.prefix.length);
    return longest && `${longest.base}${url.slice(longest.prefix.length)}`;
  };
  const fetched = rewrite(false) ?? url;
  return [fetched, rewrite(true) ?? fetched];
}

/**
 * The URL of origin, which every sync fetches from and pushes to by itself, so a pushurl is never used. Git may still
 * rewrite it with url.<base>.insteadOf or pushInsteadOf; a rewrite to anything but the same GitHub repository stops
 * the sync.
 */
function checkedRemote(clone: string, deadline?: number): Remote {
  const url = cloneGit(clone, ['config', '--get', 'remote.origin.url'], { deadline }).stdout.trim();
  const shown = redacted(url);
  const repo = githubRepo(url);
  if (repo === undefined) {
    throw new SyncProblem('private', `The origin of ${clone} is ${shown || 'not set'}, not a plain github.com URL, so nothing was pulled or pushed. Only for GitHub can gh check that the repository is private.`);
  }
  for (const resolved of rewrites(clone, url, deadline)) {
    const same = resolved === url || githubRepo(resolved)?.toLowerCase() === repo.toLowerCase() || (testRemote !== undefined && resolved === testRemote);
    if (!same) {
      throw new SyncProblem(
        'private',
        `Your git config rewrites ${shown} to ${redacted(resolved)} with url.<base>.insteadOf or pushInsteadOf, so nothing was pulled or pushed: git storage talks only to the repository gh checked. Remove that rewrite, then run ledger store sync.`,
      );
    }
  }
  return { url, shown, repo };
}

/**
 * `ledger store sync init <url>`: checks with gh that the GitHub repository is private, and clones it to ~/.claude/ledger-data.
 * An empty repository, one with no refs at all, gets the marker and the .gitignore, pushed at once; a repository with
 * the marker and nothing ledger would not write is used as it is; any other repository is refused, and its clone
 * removed. Only one init runs at a time. The storage setting stays as it is.
 */
export function initSync(paths: LedgerPaths, url: string, line: Line): void {
  const repo =
    githubRepo(url) ??
    fail(
      `${STOPPED}: ${redacted(url)} is not a plain github.com URL, such as https://github.com/<owner>/<repo>.git or git@github.com:<owner>/<repo>.git. Only for GitHub can gh check that the repository is private.`,
    );
  const { clone, init } = clonePaths(paths);
  mkdirSync(path.dirname(clone), { recursive: true });
  const ran = withLockIfFree(init, () => initLocked(paths, url, repo, line), { keepWhileRunning: true });
  if (ran === 'busy') fail(`${STOPPED}: another ledger store sync init is running. Let it finish, and run ledger store sync init again if it fails.`);
}

function initLocked(paths: LedgerPaths, url: string, repo: string, line: Line): void {
  const answer = viewRepo(paths, repo, 'visibility,isEmpty');
  const reason = 'reason' in answer ? answer.reason : notPrivateBecause(repo, answer.view);
  if (reason !== undefined) fail(`${STOPPED}: ${reason}`);
  const { isEmpty } = 'view' in answer ? answer.view : {};
  if (typeof isEmpty !== 'boolean') fail(`${STOPPED}: gh did not say whether ${redacted(repo)} is empty. Update gh, then try again.`);
  const { clone } = clonePaths(paths);
  if (isTaken(clone)) return checkExisting(paths, url, line);
  const [shown, where] = [redacted(url), paths.tilde(clone)];
  const listed = remoteGitOutsideRepositories(['ls-remote', url]);
  if (!listed.ok) fail(`${STOPPED}: git ls-remote of ${shown} failed: ${listed.stderr}`);
  // Nothing is checked out before its tree is checked.
  const cloned = remoteGitOutsideRepositories(['clone', '--quiet', '--no-checkout', '--', url, clone]);
  if (!cloned.ok) {
    rmSync(clone, { recursive: true, force: true });
    fail(`${STOPPED}: git clone of ${shown} failed: ${cloned.stderr}`);
  }
  let empty: boolean;
  try {
    checkedRemote(clone);
    empty = listed.stdout.trim() === '' && cloneGit(clone, ['for-each-ref', '--count=1']).stdout.trim() === '';
    if (empty !== isEmpty) {
      const [says, finds] = isEmpty ? ['empty', 'commits'] : ['not empty', 'no commits'];
      fail(`${STOPPED}: gh says ${redacted(repo)} is ${says}, but git finds ${finds} at ${shown}. Check that the URL names the repository you mean, then try again.`);
    }
    if (empty) writeLayout(clone);
    else checkOut(clone, shown);
    // git clone copies a template that the git config names, and with it a .git/hooks that may be a symbolic link.
    const problem = cloneProblem(clone);
    if (problem !== undefined) fail(`${STOPPED}: ${where} is a clone of ${shown}, but ${problem}.`);
    withCloneLock(clone, () => {
      installHook(clone);
      must(cloneGit(clone, ['config', CHECKED, `${Date.now()} ${repo}`]));
      if (empty) commitChanges(clone, { message: 'Set up git storage for ledgers' });
    });
  } catch (error) {
    rmSync(clone, { recursive: true, force: true });
    throw error;
  }
  if (!empty) return line(`Set up git storage in ${where} from ${shown}.`);
  try {
    syncLedgers(paths, () => {}, { daily: true });
  } catch (error) {
    fail(`Set up git storage in ${where}, but its first push to ${shown} failed: ${(error as Error).message}\nRun ledger store sync to push it.`);
  }
  cloneGit(clone, ['branch', '--quiet', '--set-upstream-to=origin/main']);
  line(`Set up git storage in ${where} and pushed its layout to ${shown}.`);
  line('ledger store migrate --to git copies your ledgers into it and switches to git storage.');
}

/**
 * git that talks to the remote from an empty folder outside every repository, so that only the global and system git
 * config apply, as in the clone that checkedRemote checks; the config of a repository such as ~/.claude cannot rewrite
 * the URL.
 */
function remoteGitOutsideRepositories(args: string[]): GitRun {
  const folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'ledger-sync-init-')));
  try {
    return remoteGit(folder, args, { env: { GIT_CEILING_DIRECTORIES: path.dirname(folder) } });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** An empty repository on branch main, with what ledger store sync init writes; a path that is there already throws. */
function writeLayout(clone: string): void {
  must(cloneGit(clone, ['symbolic-ref', 'HEAD', 'refs/heads/main']));
  for (const folder of ['backlog', 'archive']) mkdirSync(path.join(clone, folder));
  writeFileSync(path.join(clone, MARKER), `${JSON.stringify({ format: FORMAT })}\n`, { flag: 'wx' });
  writeFileSync(path.join(clone, '.gitignore'), GITIGNORE, { flag: 'wx' });
}

/**
 * Checks out the default branch of a repository that is not empty, once it holds only ledgers and the marker, and makes
 * the backlog and archive folders, which git does not keep while they hold no ledger.
 */
function checkOut(clone: string, shown: string): void {
  const noMarker = `${STOPPED} on the remote: ${shown} has commits but no ${MARKER} file at the root of its default branch, so it holds no ledgers. Use an empty private repository, or one that ledger store sync init set up.`;
  if (!refExists(clone, `HEAD:${MARKER}`)) fail(noMarker);
  const unsafe = unique([...unsafeEntries(clone, 'HEAD'), ...unsafeChanges(clone, ['HEAD'])]);
  if (unsafe.length > 0) fail(`${STOPPED}: the history of ${shown} holds ${shownPaths(unsafe)}. Ledger checks out only ledgers and its marker, as plain files: no symbolic link, executable file or other path.`);
  must(cloneGit(clone, ['reset', '--quiet', '--hard', 'HEAD']));
  if (markerFormat(clone) !== FORMAT) fail(`${STOPPED} on the remote: the ${MARKER} file of ${shown} names a format this ledger does not know. Update ledger, then try again.`);
  for (const folder of ['backlog', 'archive']) mkdirSync(path.join(clone, folder), { recursive: true });
}

/** A second init on the clone of the same URL only writes the pre-push hook again; anything else at the clone's place is refused. */
function checkExisting(paths: LedgerPaths, url: string, line: Line): void {
  const { clone } = clonePaths(paths);
  const [where, shown] = [paths.tilde(clone), redacted(url)];
  const isClone = isFolder(path.join(clone, '.git')) && cloneGit(clone, ['rev-parse', '--show-toplevel']).stdout.trim() === realPath(clone);
  const configured = isClone ? cloneGit(clone, ['config', '--get', 'remote.origin.url']).stdout.trim() : '';
  if (configured !== url) {
    const what = configured === '' ? 'is not a clone of it' : `is a clone of ${redacted(configured)}`;
    fail(`${STOPPED}: ${where} already exists and ${what}, not of ${shown}. Move ${where} away, or run ledger store sync init with the URL it was set up with.`);
  }
  const problem = cloneProblem(clone);
  if (problem !== undefined) fail(`${STOPPED}: ${where} is a clone of ${shown}, but ${problem}.`);
  repairHook(clone);
  line(`Git storage in ${where} is already set up for ${shown}; nothing changed.`);
}

export type SyncOptions = {
  /** Ask gh whether the repository is private only when no check said so in the last day, as a background sync does. */
  daily?: boolean;
};

/**
 * `ledger store sync`: checks that origin is the private GitHub repository it was, commits the ledgers, pulls with a rebase,
 * checks the commits to push, and pushes them. A problem is recorded in ~/.claude/ledger-data.status.json and thrown; a
 * sync that gets through removes that file, unless a sync that started later wrote it.
 */
export function syncLedgers(paths: LedgerPaths, line: Line, { daily = false }: SyncOptions = {}): void {
  const clone = setUpClone(paths);
  const number = takeSyncNumber(paths);
  try {
    const remote = checkedRemote(clone);
    checkPrivate(paths, clone, remote.repo, daily);
    repairHook(clone);
    syncClone({ clone, where: paths.tilde(clone), remote, line });
    clearStatus(paths, number);
  } catch (error) {
    if (error instanceof Failure) recordProblem(paths, error instanceof SyncProblem ? error : new SyncProblem('git', error.message), number);
    throw error;
  }
}

/**
 * `ledger store sync --quiet`, which a command that wrote starts in the background. One runs at a time: one that starts
 * while another runs leaves a note and exits at once, and the running one syncs once more for it, also after a sync
 * that failed. It throws when its last sync failed.
 */
export function syncInBackground(paths: LedgerPaths): void {
  setUpClone(paths);
  const { background, pending } = clonePaths(paths);
  writeFileSync(pending, '');
  let failure: { error: unknown } | undefined;
  while (isTaken(pending)) {
    const ran = withLockIfFree(
      background,
      () => {
        rmSync(pending, { force: true });
        try {
          syncLedgers(paths, () => {}, { daily: true });
          failure = undefined;
        } catch (error) {
          failure = { error };
        }
      },
      { keepWhileRunning: true },
    );
    if (ran === 'busy') break;
  }
  if (failure !== undefined) throw failure.error;
}

type Sync = { clone: string; where: string; remote: Remote; line: Line };

/** Two syncs that start together push the same commits; one more try covers a remote that moved in between. */
const PUSH_TRIES = 3;

function syncClone(sync: Sync): void {
  const { clone, remote, line } = sync;
  checkFinished(clone);
  const branch = branchOf(clone);
  const upstream = `refs/remotes/origin/${branch}`;
  // Before the fetch, so the ledgers are committed here even when the remote cannot be reached.
  withCloneLock(clone, () => commitChanges(clone));
  for (let tries = 1; ; tries++) {
    // The fetch moves refs of the clone, so it holds the lock, and no other fetch moves them before the commit it found
    // is read. Only the push, which changes nothing here, runs outside it.
    const { base, head, count } = withCloneLock(clone, () => {
      const base = fetch(sync, upstream);
      commitChanges(clone);
      rebaseOnto(sync, { upstream, incoming: base });
      return { base, ...checkedOutgoing(sync, base, branch) };
    });
    if (count === 0) return line(`Nothing to push: ${remote.shown} has every ledger commit.`);
    const pushed = remoteGit(clone, ['push', '--quiet', '--no-follow-tags', remote.url, `${head}:refs/heads/${branch}`]);
    if (pushed.ok) {
      withCloneLock(clone, () => moveForward(clone, upstream, head));
      return line(`Pushed ${plural(count, 'commit')} to ${remote.shown}.`);
    }
    const now = withCloneLock(clone, () => fetch(sync, upstream));
    if (now !== '' && isAncestor(clone, head, now)) return line(`Nothing to push: ${remote.shown} has every ledger commit.`);
    if (now === base || tries === PUSH_TRIES) {
      throw new SyncProblem('push', `git push to ${remote.shown} failed, so the ledger commits stay in ${sync.where}, not pushed.\n${pushed.stderr}`);
    }
  }
}

/**
 * Moves `ref` to `commit` when that is a step forward: a fetch while the push ran may have moved it past `commit`
 * already. Call it under the clone lock.
 */
function moveForward(clone: string, ref: string, commit: string): void {
  const now = cloneGit(clone, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).stdout.trim();
  if (now === '' || isAncestor(clone, now, commit)) cloneGit(clone, ['update-ref', ref, commit, now]);
}

/**
 * Fetches every branch of the checked URL into refs/remotes/origin/, and gives the commit `upstream` then names, or ''
 * when the remote has no such branch. Every later step uses that commit, never the ref, which a person may move. A
 * branch the remote moved back, as a force-push that removed commits does, fails that fetch; then the branch of
 * `upstream` is fetched alone and moved only forward, and when the remote moved that one back, it stops with the ref
 * left as it was. Call it under the clone lock.
 */
function fetch({ clone, where, remote }: Sync, upstream: string, deadline?: number): string {
  const tip = (ref: string): string => cloneGit(clone, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { deadline }).stdout.trim();
  // Whatever fetch.showForcedUpdates says: without that check, git moves a branch back with no error.
  const fetched = remoteGit(clone, ['fetch', '--quiet', '--prune', '--no-tags', '--show-forced-updates', remote.url, 'refs/heads/*:refs/remotes/origin/*'], { deadline });
  if (fetched.ok) return tip(upstream);
  const unreachable = (): SyncProblem =>
    new SyncProblem(
      fetched.timedOut ? 'timeout' : 'network',
      `Could not reach ${remote.shown}, so nothing was pulled or pushed; the ledger commits stay in ${where}.\n${fetched.stderr.split('\n')[0] || 'no error text'}`,
    );
  if (fetched.timedOut) throw unreachable();
  // Into FETCH_HEAD only, so no ref moves before the ancestry is checked: by the commits, not by the text of git, which
  // the locale changes.
  const name = upstream.replace(/^refs\/remotes\/origin\//, '');
  const branch = `refs/heads/${name}`;
  if (!remoteGit(clone, ['fetch', '--quiet', '--no-tags', remote.url, branch], { deadline }).ok) {
    // Exit 2 is git's own answer that the remote has no such ref, whatever the locale.
    if (remoteGit(clone, ['ls-remote', '--exit-code', remote.url, branch], { deadline }).status === 2) {
      throw new SyncProblem(
        'incoming',
        [
          `${remote.shown} has no branch ${name}, which this clone pushes to, and the fetch of its other branches failed, so nothing was pulled or pushed; the ledger commits stay in ${where}.`,
          `If another branch there lost commits, as after a force-push: run git fetch --force origin in ${where}, then ledger store sync, which pushes ${name} again.`,
          fetched.stderr.split('\n')[0],
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    throw unreachable();
  }
  const [known, head] = [tip(upstream), tip('FETCH_HEAD')];
  if (head === '') throw unreachable();
  const kept = known === '' || ancestry(clone, known, head, deadline);
  if (typeof kept === 'object') {
    throw new SyncProblem(
      kept.timedOut ? 'timeout' : 'git',
      `Could not check whether ${remote.shown} lost commits this clone fetched before, so nothing was pulled or pushed.\n${kept.stderr || 'no error text'}`,
    );
  }
  if (!kept) {
    const tracking = upstream.replace(/^refs\/remotes\//, '');
    throw new SyncProblem(
      'incoming',
      [
        `${remote.shown} lost commits that this clone fetched before, as after a force-push, so nothing was pulled or pushed.`,
        `To push the lost commits back: run git fetch --force origin in ${where}, then ledger store sync.`,
        `If they were removed on purpose, for example to take a secret out of the history: run git fetch --force origin, then git reset --hard ${tracking} in ${where}. That drops every commit and change there that ${remote.shown} lacks, also ledger changes not pushed yet.`,
      ].join('\n'),
    );
  }
  must(cloneGit(clone, ['update-ref', upstream, head, known], { deadline }));
  return head;
}

/** Of the time a pull has, what it keeps for git rebase --abort, so a rebase that runs out of time is still undone. */
const ABORT_MS = 500;

/**
 * Rebases the commits made here onto `incoming`, the commit the fetch found, once every commit it brings holds only
 * ledgers as plain files. A rebase that stops or runs out of time is aborted, so the clone is left as it was, with
 * every commit made here; an abort that fails is a problem a person must fix. When the remote has nothing new, there
 * is nothing to rebase, and a merge stays a merge; otherwise a merge made here stops it, as a rebase would drop it.
 */
function rebaseOnto({ clone, where, remote }: Sync, { upstream, incoming }: { upstream: string; incoming: string }, deadline?: number): void {
  if (incoming === '' || isAncestor(clone, incoming, 'HEAD', deadline)) return;
  if (must(cloneGit(clone, ['rev-list', '--merges', '--count', 'HEAD', '--not', incoming], { deadline })).trim() !== '0') {
    throw new SyncProblem(
      'conflict',
      `The commits not pushed yet in ${where} hold a merge commit, which the pull from ${remote.shown} would drop with its rebase, so nothing was pulled or pushed.\nRewrite them without a merge there, for example with git rebase ${upstream.replace(/^refs\/remotes\//, '')}, then run ledger store sync.`,
    );
  }
  const unsafe = unique([...unsafeEntries(clone, incoming, deadline), ...unsafeChanges(clone, [incoming, '--not', 'HEAD'], deadline)]);
  if (unsafe.length > 0) {
    throw new SyncProblem(
      'incoming',
      `The commits to pull from ${remote.shown} hold ${shownPaths(unsafe)}, which ledger never checks out, so nothing was pulled or pushed.\nOnly ledgers and the marker, as plain files, belong there: remove the rest from the repository, then run ledger store sync.`,
    );
  }
  const rebased = committingGit(clone, ['rebase', '--quiet', '--no-autostash', incoming], deadline === undefined ? undefined : deadline - ABORT_MS);
  if (rebased.ok) return;
  const conflicted = rebased.timedOut ? [] : nulSeparated(cloneGit(clone, ['diff', '--name-only', '-z', '--diff-filter=U'], { deadline }).stdout);
  const aborted = cloneGit(clone, ['rebase', '--abort'], { deadline });
  if (['rebase-merge', 'rebase-apply'].some((mark) => isTaken(path.join(clone, '.git', mark)))) {
    throw new SyncProblem(
      'conflict',
      `The pull from ${remote.shown} stopped halfway, and git rebase --abort failed too, so a rebase is left in ${where}; nothing was pushed.\nRun git rebase --abort there, then ledger store sync.\n${aborted.stderr}`,
    );
  }
  if (rebased.timedOut) throw new SyncProblem('timeout', `The pull from ${remote.shown} ran out of time, so it was undone; the next sync pulls again.`);
  if (conflicted.length === 0) throw new SyncProblem('conflict', `The pull from ${remote.shown} failed, so nothing was pushed.\n${rebased.stderr}`);
  throw new SyncProblem(
    'conflict',
    [
      `The pull from ${remote.shown} has a conflict with the ledger commits made here, in ${shownPaths(conflicted)}, so nothing was pushed.`,
      `The commits made here stay in ${where}. To merge by hand: cd ${where}; git rebase ${upstream.replace(/^refs\/remotes\//, '')}; fix each file; git add it; git rebase --continue. Then run ledger store sync.`,
    ].join('\n'),
  );
}

/**
 * The commits to push to `branch`: those HEAD has and `base`, what the fetch found on that branch, does not. They must
 * change only allowlisted paths, each to a plain file, and add no secret-like text, in a file, a file name or a message.
 */
function checkedOutgoing({ clone, where }: Sync, base: string, branch: string): { head: string; count: number } {
  const head = must(cloneGit(clone, ['rev-parse', 'HEAD'])).trim();
  const range = base === '' ? [head] : [head, '--not', base];
  const count = countOf(clone, range);
  if (count === 0) return { head, count };
  const unsafe = unsafeChanges(clone, range);
  const rewrite = `Rewrite the commits not pushed yet in ${where}, for example with git reset --soft origin/${branch} and a new commit, then run ledger store sync.`;
  if (unsafe.length > 0) throw new SyncProblem('allowlist', `${notLedgers(unsafe)} They are in commits not pushed yet, so nothing was pushed.\n${rewrite}`);
  const changed = nulSeparated(must(cloneGit(clone, [...CHANGED_PATHS_LOG, ...range])));
  const hits = [...secretLocations(must(cloneGit(clone, [...ADDED_LINES_LOG, ...range])), changed), ...messageLocations(must(cloneGit(clone, [...MESSAGES_LOG, ...range])))];
  if (hits.length > 0) {
    throw new SyncProblem(
      'secret',
      ['The commits not pushed yet add secret-like text, so nothing was pushed. It is here:', ...hits.sort().map((hit) => `  ${hit}`), `Remove the text from each ledger or message. ${rewrite}`].join('\n'),
    );
  }
  return { head, count };
}

/**
 * For the session-start hook: fetches and rebases by `deadline`, every git step included, the abort of a rebase that
 * ran out of time too, and prints nothing. A problem a person must fix, such as a conflict, is recorded; an unreachable
 * remote or a pull that ran out of time is not, as the next sync tries again. Never throws.
 */
export function pullForSession(paths: LedgerPaths, deadline: number): void {
  const left = (): number => Math.max(0, deadline - Date.now());
  let number: number | undefined;
  try {
    if (readStorage(paths.home) !== 'git') return;
    const { clone } = clonePaths(paths);
    if (cloneProblem(clone, deadline) !== undefined) return;
    number = takeSyncNumber(paths, { waitMs: left() });
    const sync: Sync = { clone, where: paths.tilde(clone), remote: checkedRemote(clone, deadline), line: () => {} };
    checkFinished(clone, deadline);
    const upstream = `refs/remotes/origin/${branchOf(clone, deadline)}`;
    withCloneLock(
      clone,
      () => {
        installHook(clone, deadline);
        const incoming = fetch(sync, upstream, deadline);
        commitChanges(clone, { deadline });
        rebaseOnto(sync, { upstream, incoming }, deadline);
      },
      { waitMs: left() },
    );
  } catch (error) {
    if (number !== undefined && error instanceof SyncProblem && error.problem !== 'network' && error.problem !== 'timeout') recordProblem(paths, error, number, { waitMs: left() });
  }
}

/** The line a session start shows when the last sync of git storage stopped; undefined when there is nothing to say. */
export function syncNotice(paths: LedgerPaths): string | undefined {
  try {
    if (readStorage(paths.home) !== 'git') return undefined;
  } catch {
    return undefined;
  }
  const status = readStatus(paths);
  if (status === undefined) return undefined;
  const summary = status.message.split('\n')[0].replace(/:$/, '.');
  return `Ledger sync needs attention: ${summary} Run \`ledger store sync\` in a terminal to see the details and push the ledgers.`;
}
