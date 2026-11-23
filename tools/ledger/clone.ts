import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, realpathSync, rmdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fail, Failure } from './failure.js';
import { folderEntries, isReadableFile, isTaken, readText, writeAtomic } from './files.js';
import { withLock, type LockOptions } from './lock.js';
import type { LedgerPaths } from './paths.js';
import { readRecordJson } from './record.js';
import { isSecretLike, prePushHook, RAW_CHANGES_LOG, WITHHELD } from './secret-scan.js';
import { HOST_LABEL } from './settings.js';

/** The clone of git storage and what stays next to it on this machine: evidence, the sync status, the old task list and the repo aliases are never pushed. */
export function clonePaths({ home }: LedgerPaths) {
  const claude = path.join(home, '.claude');
  return {
    clone: path.join(claude, 'ledger-data'),
    evidence: path.join(claude, 'ledger-evidence'),
    status: path.join(claude, 'ledger-data.status.json'),
    /**
     * Written before each check asks gh and again when gh says the repository is not private; removed only when gh says
     * it is PRIVATE to the check that wrote it last.
     */
    notPrivate: path.join(claude, 'ledger-data.not-private'),
    /** The number the last sync took, and that of the newest sync that recorded how it ended; see takeSyncNumber. */
    order: path.join(claude, 'ledger-data.sync-order.json'),
    /** The task list older versions of git storage kept, read only by the one-time moves. */
    registry: path.join(claude, 'ledgers-git.json'),
    // Not the ledger-aliases.json of file storage, for the same reason: a migrate that stops removes the aliases it added.
    aliases: path.join(claude, 'ledger-aliases-git.json'),
    /** The lock target of `ledger store sync init`, so only one runs at a time. */
    init: path.join(claude, 'ledger-data.init'),
    /** The lock target of `ledger store sync --quiet`, so only one runs at a time. */
    background: path.join(claude, 'ledger-data.sync'),
    /** Left by a background sync that found another one running, so that one syncs once more. */
    pending: path.join(claude, 'ledger-data.sync-pending'),
  };
}

export const MARKER = '.ledger-data';
export const FORMAT = 2;
/** The format from before active records; the first write to such a clone upgrades it, so an older ledger refuses it. */
const FORMAT_BEFORE_ACTIVE = 1;
/** Whether this ledger reads a clone of `format`. */
export const isKnownFormat = (format: unknown): boolean => format === FORMAT || format === FORMAT_BEFORE_ACTIVE;
/** The text of the marker file of a clone of this format. */
export const markerText = (): string => `${JSON.stringify({ format: FORMAT })}\n`;
/** What `ledger store sync init` writes or expects, and must never find as a symbolic link. */
export const GENERATED = [MARKER, '.gitignore', 'backlog', 'active', 'archive'];

/** Git ignores everything but the allowlist, so `git status` shows no lock or temporary file. */
export const GITIGNORE = [
  '# Written by ledger store sync init. Only the ledgers and these setup files are pushed.',
  '*',
  `!/${MARKER}`,
  '!/.gitignore',
  '!/backlog/',
  '!/backlog/*/',
  '!/backlog/*/*.md',
  '!/backlog/*/*.json',
  '!/active/',
  '!/active/*/',
  '!/active/*/*.json',
  '!/archive/',
  '!/archive/*/',
  '!/archive/*/*.md',
  '!/archive/*/*.json',
  '',
].join('\n');

// A repo folder and a ledger name are never . or .., which would make a path that leaves its folder, and hold no / or \,
// as in the file store, and no line break, which would split a name where git or the hook prints one per line. The
// pre-push hook checks the same rule in bash.
const ALLOWED = /^(\.ledger-data|\.gitignore|(backlog|active|archive)\/(?!\.\.?\/)[^/\\\n]+\/(?!\.\.?\.(md|json)$)[^/\\\n]+\.(md|json))$/;

/**
 * A copy of a worktree ledger as git storage kept it before active records, active/<host>/<repo>/<slug>.md. Reads skip
 * it and the first write removes it, so such a path is allowed only for a clone that still holds one.
 */
export const LEGACY_COPY = new RegExp(String.raw`^active\/${HOST_LABEL}\/(?!\.\.?\/)[^/\\\n]+\/(?!\.\.?\.md$)[^/\\\n]+\.md$`);

/** Whether a path of the clone may be committed and pushed. It is checked on its own, as a nested .gitignore can un-ignore any file. */
export const isAllowed = (file: string): boolean => (ALLOWED.test(file) && (!file.startsWith('active/') || file.endsWith('.json'))) || LEGACY_COPY.test(file);

export const unique = (files: string[]): string[] => [...new Set(files)].sort();

/** Paths as a message or the status file may name them: a secret-like name is withheld. */
export const shownPaths = (files: string[]): string => unique(files.map((file) => (isSecretLike(file) ? WITHHELD : file))).join(', ');

/** `text` with the credentials of each URL taken out: its user name and password, and its query and fragment. */
export const withoutCredentials = (text: string): string =>
  text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1').replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, '$1');

/**
 * Text from git or the file system as it may be printed or recorded: without credentials, and with each secret-like
 * word, such as a path, withheld; a line still secret-like after that, as a key block is, is withheld whole.
 */
export function redacted(text: string): string {
  return withoutCredentials(text)
    .split('\n')
    .map((line) => {
      const words = line
        .split(/(\s+)/)
        .map((word) => (isSecretLike(word) ? WITHHELD : word))
        .join('');
      return isSecretLike(words) ? WITHHELD : words;
    })
    .join('\n');
}

export type Problem = 'allowlist' | 'conflict' | 'secret' | 'network' | 'push' | 'git' | 'incoming' | 'private' | 'timeout';

/** A sync that stopped for a reason a person must act on. The first line of the message says what, in one sentence. */
export class SyncProblem extends Failure {
  constructor(
    readonly problem: Problem,
    message: string,
  ) {
    super(message);
  }
}

const NETWORK_TIMEOUT_MS = 120_000;

/** `status` is the exit code of git, null when it did not start or was stopped. */
export type GitRun = { ok: boolean; status: number | null; stdout: string; stderr: string; timedOut: boolean };

/** `deadline` is a time from Date.now(): git is stopped then, and not started after it. */
type GitOptions = { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; deadline?: number };

/** Variables that would point git at another repository, index, object store, ref namespace or config than the clone's. */
const POINTS_ELSEWHERE = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE'];

/** This process's environment without what would point git elsewhere than the clone, for git in it and a ledger it starts. */
export const cloneEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !POINTS_ELSEWHERE.includes(name) && !name.startsWith('GIT_CONFIG'))),
  // The git text ledger prints and records stays in English, as the rest of its output is.
  LC_ALL: 'C',
});

let lastDeadline = Infinity;

/** Ends every later git call in the clone by `until`, a time from Date.now(): for hooks, which open and close git storage too. */
export function limitCloneGitCalls(until: number): void {
  lastDeadline = until;
}

/**
 * git in `clone`; it never prompts, and its error text is redacted. It reads objects as they are, without replace refs
 * or grafts, which could show a scan or a check other commits than those pushed; the graft file it names cannot exist.
 */
export function cloneGit(clone: string, args: string[], { input, env, timeoutMs, deadline: own }: GitOptions = {}): GitRun {
  const deadline = Math.min(own ?? Infinity, lastDeadline);
  const timeout = deadline === Infinity ? timeoutMs : Math.min(timeoutMs ?? Infinity, deadline - Date.now());
  if (timeout !== undefined && timeout <= 0) return { ok: false, status: null, stdout: '', stderr: 'git did not start: the time for it was up', timedOut: true };
  const result = spawnSync('git', ['-C', clone, ...args], {
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: { ...cloneEnv(), GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null/none', ...env },
    timeout,
    maxBuffer: 512 * 1024 * 1024,
  });
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  const stderr = redacted(result.error ? `git did not finish: ${result.error.message}` : (result.stderr ?? '').trim());
  return { ok: result.status === 0, status: result.status, stdout: result.stdout ?? '', stderr, timedOut };
}

/** git that talks to the remote: stopped after two minutes, or at `deadline` when that comes first. */
export const remoteGit = (clone: string, args: string[], { deadline, env }: Pick<GitOptions, 'deadline' | 'env'> = {}): GitRun =>
  cloneGit(clone, args, { timeoutMs: NETWORK_TIMEOUT_MS, deadline, env });

/** NUL-separated paths, as `-z` prints them, each exactly as git gave it. */
export const nulSeparated = (text: string): string[] => text.split('\0').filter(Boolean);

/**
 * Runs `work` while this process holds the clone lock, ~/.claude/ledger-data.lock: every write to the clone and every git
 * call that changes it, a fetch too. A sync holds it for every step but the push, which changes nothing in the clone. A
 * process that still runs keeps it, however long it takes.
 */
export const withCloneLock = <T>(clone: string, work: () => T, { waitMs }: Pick<LockOptions, 'waitMs'> = {}): T => withLock(clone, work, { waitMs, keepWhileRunning: true });

/** The format of the clone's marker; 'none' when it has none, 'unreadable' when it is no JSON object with a number. */
export function markerFormat(clone: string): number | 'none' | 'unreadable' {
  const file = path.join(clone, MARKER);
  if (lstatSync(file, { throwIfNoEntry: false }) === undefined) return 'none';
  if (!isReadableFile(file)) return 'unreadable';
  try {
    const { format } = JSON.parse(readText(file)) as { format?: unknown };
    return typeof format === 'number' ? format : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/** The format of the marker as HEAD holds it; undefined without a HEAD or a marker in it, or for one that names none. */
function committedFormat(clone: string): unknown {
  const shown = cloneGit(clone, ['show', `HEAD:${MARKER}`]);
  try {
    return shown.ok ? (JSON.parse(shown.stdout) as { format?: unknown }).format : undefined;
  } catch {
    return undefined;
  }
}

/** The generated paths of the clone that are symbolic links. */
export const linkedGenerated = (clone: string): string[] => GENERATED.filter((name) => lstatSync(path.join(clone, name), { throwIfNoEntry: false })?.isSymbolicLink());

/**
 * What keeps `clone` from being git storage, or undefined when it is set up. Its .git is a folder of its own, not a
 * link or a file that points elsewhere, and git names the clone as its top folder, so no core.worktree sends a commit
 * to other files; the hooks folder is no link either, as the pre-push hook is written there. One git call, by `deadline`.
 */
export function cloneProblem(clone: string, deadline?: number): string | undefined {
  const dotGit = lstatSync(path.join(clone, '.git'), { throwIfNoEntry: false });
  if (dotGit === undefined) return 'it is not a git clone';
  if (!dotGit.isDirectory()) return 'its .git is not a folder';
  if (lstatSync(hooksFolder(clone), { throwIfNoEntry: false })?.isSymbolicLink()) return 'its .git/hooks is a symbolic link';
  const format = markerFormat(clone);
  if (format === 'none') return `it has no ${MARKER} file`;
  if (!isKnownFormat(format)) return `its ${MARKER} file names a format this ledger does not know`;
  const linked = linkedGenerated(clone);
  if (linked.length > 0) return `${linked.join(', ')} is a symbolic link`;
  const top = cloneGit(clone, ['rev-parse', '--show-toplevel'], { deadline }).stdout.trim();
  return top !== '' && nativeRealPath(top) === nativeRealPath(clone) ? undefined : `git names ${top || 'no folder'} as its top folder, not the clone`;
}

/** The real path as the volume spells it, so two spellings of one folder on a volume that ignores case are equal. */
const nativeRealPath = (file: string): string | undefined => {
  try {
    return realpathSync.native(file);
  } catch {
    return undefined;
  }
};

/** The clone, when it is set up; otherwise this fails and says to run `ledger store sync init`. */
export function setUpClone(paths: LedgerPaths): string {
  const { clone } = clonePaths(paths);
  const problem = cloneProblem(clone);
  if (problem !== undefined) fail(`Git storage is not set up in ${paths.tilde(clone)}: ${problem}. Run ledger store sync init <url> with the URL of a private GitHub repository.`);
  return clone;
}

/** The clone's own hooks folder, which its core.hooksPath names. */
const hooksFolder = (clone: string): string => path.join(clone, '.git', 'hooks');

const hasHooksPath = (clone: string, deadline?: number): boolean =>
  cloneGit(clone, ['config', '--local', '--get-all', 'core.hooksPath'], { deadline }).stdout === `${hooksFolder(clone)}\n`;

const hasHook = (hook: string): boolean => isReadableFile(hook) && readText(hook) === prePushHook() && (lstatSync(hook).mode & 0o777) === 0o755;

/**
 * Sets the clone's core.hooksPath to its own hooks folder, in place of any other value, and writes the tool's pre-push
 * hook there where it differs. So a manual git push in the clone is scanned too, also when the global git config names
 * another hooks folder, whose hooks then do not run in the clone; and git never runs a hook that came with its files.
 * Call it under the clone lock.
 */
export function installHook(clone: string, deadline?: number): void {
  if (!hasHooksPath(clone, deadline)) must(cloneGit(clone, ['config', '--local', '--replace-all', 'core.hooksPath', hooksFolder(clone)], { deadline }));
  const hook = path.join(hooksFolder(clone), 'pre-push');
  if (!isReadableFile(hook) || readText(hook) !== prePushHook()) writeAtomic(hook, prePushHook());
  chmodSync(hook, 0o755);
}

/** Puts the pre-push hook and the core.hooksPath that names it back, under the clone lock, when either changed. */
export function repairHook(clone: string): void {
  if (!hasHooksPath(clone) || !hasHook(path.join(hooksFolder(clone), 'pre-push'))) withCloneLock(clone, () => installHook(clone));
}

const hasGitignore = (clone: string): boolean => {
  const file = path.join(clone, '.gitignore');
  return isReadableFile(file) && readText(file) === GITIGNORE;
};

/**
 * Writes the .gitignore again where it differs, as one from before active records does, so a manual git status in the
 * clone shows the records too; the next commit pushes it. Call it under the clone lock.
 */
export function installGitignore(clone: string): void {
  if (!hasGitignore(clone)) writeAtomic(path.join(clone, '.gitignore'), GITIGNORE);
}

/** Commits and rebases need a name and an email; a machine without them commits as ledger. */
function identity(clone: string, deadline?: number): NodeJS.ProcessEnv {
  const has = (key: string): boolean => must(cloneGit(clone, ['config', '--default', '', '--get', key], { deadline })).trim() !== '';
  return {
    ...(has('user.name') ? {} : { GIT_AUTHOR_NAME: 'ledger', GIT_COMMITTER_NAME: 'ledger' }),
    ...(has('user.email') ? {} : { GIT_AUTHOR_EMAIL: 'ledger@localhost', GIT_COMMITTER_EMAIL: 'ledger@localhost' }),
  };
}

/** git that writes commits: with an identity, and unsigned, as a signing prompt would hang a background push. */
export const committingGit = (clone: string, args: string[], deadline?: number): GitRun =>
  cloneGit(clone, ['-c', 'commit.gpgSign=false', ...args], { env: identity(clone, deadline), deadline });

export const outsideAllowlist = (files: string[]): string => `Only ledgers are pushed, and these paths are not ledgers: ${shownPaths(files)}.`;

export const notPlain = (files: string[]): string => `Ledgers are pushed only as plain files, and these are symbolic links, executable files or submodules: ${shownPaths(files)}.`;

/** Whether `file` is a plain file that is not executable, as git commits it with mode 100644; a removed file is too. */
function isPlainOrGone(file: string): boolean {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  return stat === undefined || (stat.isFile() && (stat.mode & 0o111) === 0);
}

/** Git's marks of work a person started in the clone and has not finished. */
const UNFINISHED: [mark: string, work: string][] = [
  ['rebase-merge', 'A rebase'],
  ['rebase-apply', 'A rebase'],
  ['MERGE_HEAD', 'A merge'],
  ['CHERRY_PICK_HEAD', 'A cherry-pick'],
  ['REVERT_HEAD', 'A revert'],
];

export const conflictedFiles = (clone: string, deadline?: number): string[] => nulSeparated(must(cloneGit(clone, ['diff', '--name-only', '-z', '--diff-filter=U'], { deadline })));

/** Stops when a person left work in the clone halfway, such as a conflict after git stash pop: `git add` would mark it resolved. */
export function checkFinished(clone: string, deadline?: number): void {
  const unfinished = UNFINISHED.find(([mark]) => isTaken(path.join(clone, '.git', mark)));
  if (unfinished !== undefined) {
    throw new SyncProblem('conflict', `${unfinished[1]} is in progress in ${clone}, so nothing was committed or pushed.\nFinish it or abort it there, then run ledger store sync.`);
  }
  const conflicted = conflictedFiles(clone, deadline);
  if (conflicted.length > 0) {
    throw new SyncProblem('conflict', `${shownPaths(conflicted)} in ${clone} has a conflict nobody resolved, so nothing was committed or pushed.\nResolve it there, then run ledger store sync.`);
  }
}

export type CommitOptions = {
  message?: string;
  deadline?: number;
  /**
   * This machine's host label. A changed active record that HEAD has naming another host is that machine's to change,
   * so it is put back as HEAD has it, never committed; without a host label, so is one that names any host.
   */
  host?: string;
  /** The labels this machine stamped before "host" changed: a record that names one is this machine's too. */
  ownHosts?: ReadonlySet<string>;
  /** Clone paths this command wrote itself, such as the removal of a record a forced retire made: committed whatever host they name. */
  own?: ReadonlySet<string>;
  /** Says that a record of another machine was put back; on stderr by default. */
  warn?: (text: string) => void;
};

/**
 * Commits the changes of the clone's working tree; true when it made a commit. Unfinished work, or any changed path
 * outside the allowlist, staged or not, stops it with nothing committed. Call it under the clone lock.
 */
export function commitChanges(clone: string, { message = 'Update ledgers', deadline, host, ownHosts = new Set(), own = new Set(), warn = (text) => console.error(`warning: ${text}`) }: CommitOptions = {}): boolean {
  let changed = checkedChanges(clone, deadline);
  // unique: a staged removal of a file that is still on disk is two entries.
  const theirs = unique(changed).flatMap((file) => {
    const owner = own.has(file) ? undefined : otherOwner(clone, file, { host, ownHosts, deadline });
    return owner === undefined ? [] : [{ file, owner }];
  });
  if (theirs.length > 0) {
    restoreFromHead(clone, theirs.map(({ file }) => file), deadline);
    for (const { file, owner } of theirs) warn(`put back ${shownPaths([file])} as git storage holds it: it is the record of a task on ${owner}, and only ${owner} changes it.`);
    changed = checkedChanges(clone, deadline);
  }
  if (changed.length === 0) return false;
  must(cloneGit(clone, ['add', '-A', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: changed.join('\0'), env: { GIT_LITERAL_PATHSPECS: '1' }, deadline }));
  if (nulSeparated(must(cloneGit(clone, ['diff', '--cached', '--name-only', '-z'], { deadline }))).length === 0) return false;
  must(committingGit(clone, ['commit', '--quiet', '--no-verify', '-m', message], deadline));
  return true;
}

/** The paths a commit would take, once no rebase or merge is unfinished; throws, as a commit does, for a path no commit may take. */
function checkedChanges(clone: string, deadline?: number): string[] {
  checkFinished(clone, deadline);
  // Porcelain v1 with -z: "XY <path>", and no second path as renames are off. An ignored path is "!! <path>": the
  // allowlist decides whether it is a ledger to commit, so no .gitignore from the remote or exclude file can hide one.
  const entries = nulSeparated(must(cloneGit(clone, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all', '--ignored'], { deadline })));
  const changed = entries.flatMap((entry) => (entry.startsWith('!! ') && !isAllowed(entry.slice(3)) ? [] : [entry.slice(3)]));
  const stray = changed.filter((file) => !isAllowed(file));
  if (stray.length > 0) {
    throw new SyncProblem('allowlist', `${outsideAllowlist(stray)}\nRemove them from ${clone}, or unstage them there with git restore --staged <path>, then run ledger store sync again.`);
  }
  const unplain = changed.filter((file) => !isPlainOrGone(path.join(clone, file)));
  if (unplain.length > 0) {
    throw new SyncProblem('allowlist', `${notPlain(unplain)}\nMake each a plain file in ${clone}, or remove it, then run ledger store sync again.`);
  }
  return changed;
}

/**
 * The host whose active record is at `file`, a clone path: the one the record names as HEAD has it, so no edit on disk
 * makes a record of another machine this one's; as it is on disk only for a record HEAD lacks. Undefined for none, for
 * a record that is no JSON, or for no active record.
 */
function recordOwner(clone: string, file: string, deadline?: number): string | undefined {
  if (!/^active\/[^/]+\/[^/]+\.json$/.test(file)) return undefined;
  const onDisk = path.join(clone, file);
  const committed = cloneGit(clone, ['show', `HEAD:${file}`], { deadline });
  const text = committed.ok ? committed.stdout : isReadableFile(onDisk) ? readText(onDisk) : undefined;
  try {
    return text === undefined ? undefined : readRecordJson(text, file).host;
  } catch {
    return undefined;
  }
}

/** The host of the active record at `file`, a clone path, when that is another machine, so a commit puts a change of it back unless the change is its own. */
export function otherOwner(clone: string, file: string, { host, ownHosts = new Set(), deadline }: Pick<CommitOptions, 'host' | 'ownHosts' | 'deadline'>): string | undefined {
  const owner = recordOwner(clone, file, deadline);
  return owner === undefined || owner === host || (host !== undefined && ownHosts.has(owner)) ? undefined : owner;
}

/** Whether the clone's branch has a commit. A lookup that fails for any other reason throws, so it is never taken for none. */
function hasHead(clone: string, deadline?: number): boolean {
  const run = cloneGit(clone, ['rev-parse', '--verify', '--quiet', 'HEAD'], { deadline });
  // --verify --quiet exits 1, and says nothing, only for a ref that does not exist.
  if (!run.ok && (run.status !== 1 || run.stderr !== '')) must(run);
  return run.ok;
}

/** Puts each of `files`, changed paths of the clone, back as HEAD has it, in the index and on disk; a path HEAD lacks is removed. */
export function restoreFromHead(clone: string, files: string[], deadline?: number): void {
  const literal = { env: { GIT_LITERAL_PATHSPECS: '1' }, deadline };
  const inHead = hasHead(clone, deadline) ? nulSeparated(must(cloneGit(clone, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...files], literal))) : [];
  if (inHead.length > 0) must(cloneGit(clone, ['checkout', '--quiet', 'HEAD', '--', ...inHead], literal));
  const added = files.filter((file) => !inHead.includes(file));
  if (added.length === 0) return;
  // --force: a path staged and then edited again differs from both HEAD and the index, and git rm refuses it otherwise.
  must(cloneGit(clone, ['rm', '--quiet', '--cached', '--force', '--ignore-unmatch', '--', ...added], literal));
  for (const file of added) rmSync(path.join(clone, file), { force: true });
}

/**
 * Removes each copy of a worktree ledger that git storage kept before active records, so the next commit removes it
 * too, and then each folder that held one and is empty; true when it removed any. Any other file stays, as it may be
 * one that is in no commit. Call it under the clone lock.
 */
export function removeLegacyCopies(clone: string): boolean {
  let removed = false;
  const subfolders = (folder: string): string[] => folderEntries(folder).flatMap((entry) => (entry.isDirectory() ? [entry.name] : []));
  const active = path.join(clone, 'active');
  for (const host of subfolders(active)) {
    let emptied = false;
    for (const repo of subfolders(path.join(active, host))) {
      const folder = path.join(active, host, repo);
      const copies = folderEntries(folder).filter((entry) => entry.isFile() && LEGACY_COPY.test(`active/${host}/${repo}/${entry.name}`));
      for (const copy of copies) rmSync(path.join(folder, copy.name));
      removed ||= copies.length > 0;
      if (copies.length === 0 || folderEntries(folder).length > 0) continue;
      rmdirSync(folder);
      emptied = true;
    }
    if (emptied && folderEntries(path.join(active, host)).length === 0) rmdirSync(path.join(active, host));
  }
  return removed;
}

/**
 * Writes the marker of this format in a clone of the format before active records, and commits it alone; true when it
 * did. It first checks the clone as a commit does, so a clone no commit can be made in fails here and is left as it was.
 * A clone whose marker names this format while HEAD still names the one before is upgraded too: an upgrade whose commit
 * failed left it so. Call it under the clone lock.
 */
export function upgradeFormat(clone: string): boolean {
  const format = markerFormat(clone);
  if (format !== FORMAT_BEFORE_ACTIVE && (format !== FORMAT || committedFormat(clone) !== FORMAT_BEFORE_ACTIVE)) return false;
  checkedChanges(clone);
  writeAtomic(path.join(clone, MARKER), markerText());
  must(cloneGit(clone, ['add', '-f', '--', MARKER]));
  must(committingGit(clone, ['commit', '--quiet', '--no-verify', '-m', `Upgrade git storage to format ${FORMAT}`, '--', MARKER]));
  return true;
}

/** The object name git gives a file that holds `text`, in the hash `format` of the clone. */
const blobName = (format: string, text: string): string => {
  const body = Buffer.from(text);
  return createHash(format).update(`blob ${body.length}\0`).update(body).digest('hex');
};

/**
 * Throws unless each of `files` and of the keys of `texts`, clone paths, is in HEAD as it is on disk, or in neither,
 * and each key of `texts` is in HEAD with its text. A ledger that an ignore rule or a flag of the index kept out of the
 * commit, or that another command changed before the commit, is not in git storage as written, so nothing may count on it.
 */
export function checkCommitted(clone: string, files: string[], texts: ReadonlyMap<string, string> = new Map()): void {
  const checked = unique([...files, ...texts.keys()]);
  if (checked.length === 0) return;
  const hasHead = refExists(clone, 'HEAD');
  const literal = { env: { GIT_LITERAL_PATHSPECS: '1' } };
  const againstHead = (args: string[]): string[] => (hasHead ? nulSeparated(must(cloneGit(clone, [...args, 'HEAD', '--', ...checked], literal))) : []);
  // "<mode> <type> <object>\t<path>"
  const inHead = new Map(againstHead(['ls-tree', '-r', '-z']).map((entry) => [entry.slice(entry.indexOf('\t') + 1), entry.slice(0, entry.indexOf('\t')).split(' ')[2]]));
  const differ = againstHead(['diff', '--name-only', '-z']);
  // "<tag> <path>": a lowercase tag marks assume-unchanged and S skip-worktree, either of which hides a change from git.
  const hidden = nulSeparated(must(cloneGit(clone, ['ls-files', '-v', '-z', '--', ...checked], literal)))
    .filter((entry) => entry[0] === 'S' || entry[0] !== entry[0].toUpperCase())
    .map((entry) => entry.slice(2));
  const format = texts.size === 0 ? '' : must(cloneGit(clone, ['rev-parse', '--show-object-format'])).trim();
  const missing = checked.filter((file) => {
    const text = texts.get(file);
    const onDisk = inHead.has(file) === isTaken(path.join(clone, file)) && !differ.includes(file) && !hidden.includes(file);
    return !onDisk || (text !== undefined && inHead.get(file) !== blobName(format, text));
  });
  if (missing.length > 0) {
    throw new SyncProblem('git', `${shownPaths(missing)} in ${clone} is not committed as it was written, so git storage does not hold it yet.\nCheck git status --ignored there, then run ledger store sync.`);
  }
}

/** The stdout of a git call that must work; its error text otherwise. */
export function must(run: GitRun): string {
  if (run.timedOut) throw new SyncProblem('timeout', `git ran out of time in the clone: ${run.stderr}`);
  if (!run.ok) throw new SyncProblem('git', `git failed in the clone: ${run.stderr || 'no error text'}`);
  return run.stdout;
}

/**
 * The paths of the tree of `rev` that ledger never checks out: a path outside the allowlist, and anything but a plain
 * file, such as a symbolic link, an executable file or a submodule.
 */
export function unsafeEntries(clone: string, rev: string, deadline?: number): string[] {
  // "<mode> <type> <object>\t<path>"
  return nulSeparated(must(cloneGit(clone, ['ls-tree', '-r', '-z', '--full-tree', rev], { deadline })))
    .map((entry) => ({ mode: entry.slice(0, entry.indexOf(' ')), file: entry.slice(entry.indexOf('\t') + 1) }))
    .filter(({ mode, file }) => mode !== '100644' || !isAllowed(file))
    .map(({ file }) => file);
}

/**
 * The paths that a commit of `revs` changes outside the allowlist, or makes anything but a plain file: a symbolic link,
 * an executable file or a submodule. Each commit counts, the first of a history too, and a merge as against its first
 * parent; so from a tree that holds only ledgers, no commit of `revs` reaches a tree that holds anything else.
 */
export function unsafeChanges(clone: string, revs: string[], deadline?: number): string[] {
  const parts = nulSeparated(must(cloneGit(clone, [...RAW_CHANGES_LOG, ...revs], { deadline })));
  const unsafe: string[] = [];
  for (let index = 0; index + 1 < parts.length; index++) {
    const header = parts[index].replace(/^\n+/, '');
    if (!header.startsWith(':')) continue;
    const [, mode, , , status] = header.slice(1).split(' ');
    const file = parts[++index];
    if (!isAllowed(file) || (status !== 'D' && mode !== '100644')) unsafe.push(file);
  }
  return unique(unsafe);
}

/** Why `files`, which unsafeEntries or unsafeChanges found, are not pushed, in a sentence or two. */
export const notLedgers = (files: string[]): string => {
  const outside = files.filter((file) => !isAllowed(file));
  const unplain = files.filter(isAllowed);
  return [...(outside.length > 0 ? [outsideAllowlist(outside)] : []), ...(unplain.length > 0 ? [notPlain(unplain)] : [])].join(' ');
};

export const countOf = (clone: string, revs: string[]): number => Number(must(cloneGit(clone, ['rev-list', '--count', ...revs])).trim());

/** The branch the clone has checked out; a detached HEAD stops a sync. */
export function branchOf(clone: string, deadline?: number): string {
  const branch = cloneGit(clone, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { deadline }).stdout.trim();
  if (branch === '') throw new SyncProblem('push', `${clone} has no branch checked out. Check one out, then run ledger store sync again.`);
  return branch;
}

export const isAncestor = (clone: string, ancestor: string, of: string, deadline?: number): boolean => cloneGit(clone, ['merge-base', '--is-ancestor', ancestor, of], { deadline }).ok;

/** Whether `ancestor` is an ancestor of `of`, or, when git could not tell, as for a commit it lacks or no time left, its failed call. */
export function ancestry(clone: string, ancestor: string, of: string, deadline?: number): boolean | GitRun {
  const run = cloneGit(clone, ['merge-base', '--is-ancestor', ancestor, of], { deadline });
  if (run.ok) return true;
  return run.status === 1 ? false : run;
}

export const refExists = (clone: string, ref: string, deadline?: number): boolean => cloneGit(clone, ['rev-parse', '--verify', '--quiet', ref], { deadline }).ok;

export type SyncStatus = { problem: Problem; message: string; at: string };

/** The last problem a sync met, kept outside the clone so it is never pushed; undefined when the last sync went well. */
export function readStatus(paths: LedgerPaths): SyncStatus | undefined {
  try {
    const status = JSON.parse(readText(clonePaths(paths).status)) as Partial<SyncStatus>;
    if (typeof status.problem !== 'string' || typeof status.message !== 'string') return undefined;
    return { problem: status.problem, message: status.message, at: String(status.at ?? '') };
  } catch {
    return undefined;
  }
}

/** The number the last sync took, and the number of the sync that last recorded how it ended. */
type SyncOrder = { started: number; settled: number };

function readOrder(paths: LedgerPaths): SyncOrder {
  try {
    const { started, settled } = JSON.parse(readText(clonePaths(paths).order)) as Partial<SyncOrder>;
    return { started: Number(started) || 0, settled: Number(settled) || 0 };
  } catch {
    return { started: 0, settled: 0 };
  }
}

const writeOrder = (paths: LedgerPaths, order: SyncOrder): void => writeAtomic(clonePaths(paths).order, `${JSON.stringify(order)}\n`);

/**
 * The number of a sync that starts now: one more than any sync took before. A count, not a time, so of two syncs that
 * start in the same millisecond, how the earlier one ends never replaces how the later one did.
 */
export const takeSyncNumber = (paths: LedgerPaths, { waitMs }: Pick<LockOptions, 'waitMs'> = {}): number =>
  withLock(
    clonePaths(paths).status,
    () => {
      const order = readOrder(paths);
      const number = Math.max(order.started, order.settled) + 1;
      writeOrder(paths, { ...order, started: number });
      return number;
    },
    { waitMs },
  );

/** Writes or removes the status under its lock, unless a sync with a number after `number` recorded how it ended. */
function updateStatus(paths: LedgerPaths, number: number, next: SyncStatus | undefined, { waitMs }: Pick<LockOptions, 'waitMs'> = {}): void {
  const { status } = clonePaths(paths);
  withLock(
    status,
    () => {
      const order = readOrder(paths);
      if (order.settled > number) return;
      if (next === undefined) rmSync(status, { force: true });
      else writeAtomic(status, `${JSON.stringify(next, null, 2)}\n`);
      writeOrder(paths, { started: Math.max(order.started, number), settled: number });
    },
    { waitMs },
  );
}

/**
 * Records the problem of the sync numbered `number`, or without a number, of one that starts now. Best effort: a status
 * file that cannot be written must not hide the problem itself.
 */
export function recordProblem(paths: LedgerPaths, { problem, message }: SyncProblem, number?: number, { waitMs }: Pick<LockOptions, 'waitMs'> = {}): void {
  try {
    updateStatus(paths, number ?? takeSyncNumber(paths, { waitMs }), { problem, message, at: new Date().toISOString() }, { waitMs });
  } catch {
    // The caller reports the problem anyway.
  }
}

/** Removes the recorded problem after the sync numbered `number` went well, unless a later sync recorded how it ended. */
export const clearStatus = (paths: LedgerPaths, number: number): void => updateStatus(paths, number, undefined);
