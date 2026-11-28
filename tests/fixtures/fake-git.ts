import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GitRunner } from '../../tools/ledger/git.js';

/** One checkout: its branch, or its commit on a detached HEAD, and its `git status --porcelain --ignored` lines in git's order. */
export type FakeCheckout = { branch?: string; head?: string; status?: string[] };

export type FakeWorktree = FakeCheckout & { path: string };

/** `files` are all the files the commit has, as paths from the top of the repo. */
export type FakeCommit = { subject: string; date: string; parent?: string; files?: string[] };

export type FakeRemote = { url: string; branches: Record<string, string> };

/** A repository with the fields of its main checkout. Refs have full names, such as refs/heads/main, and each names a declared commit. */
export type FakeRepo = FakeCheckout & {
  originHead?: string;
  remotes?: Record<string, FakeRemote>;
  refs?: Record<string, string>;
  commits?: Record<string, FakeCommit>;
  worktrees?: FakeWorktree[];
};

/** Repositories keyed by main checkout, and folders that are in no repository. */
export type FakeGitState = { repos: Record<string, FakeRepo>; outside?: string[] };

/** `calls` holds each command as its folder followed by its arguments; `state` is a copy of the declared state, which commands change. */
export type FakeGit = { runner: GitRunner; calls: string[][]; state: FakeGitState };

type Answer = ReturnType<GitRunner>;

/** The checkout at `root` of the repo at `main` that holds the folder a command runs in. */
type Here = { main: string; repo: FakeRepo; root: string; checkout: FakeCheckout };

type Command = { usage: string; answer: (here: Here, ...values: string[]) => Answer; outside?: (...values: string[]) => Answer };

const done = (stdout = ''): Answer => ({ ok: true, stdout, stderr: '' });
const failed = (stderr = ''): Answer => ({ ok: false, stdout: '', stderr });
const lines = (entries: string[]): string => entries.map((entry) => `${entry}\n`).join('');
const notARepo = (): Answer => failed('fatal: not a git repository (or any of the parent directories): .git');

function gap(reason: string): never {
  throw new Error(reason);
}

const checkouts = (main: string, repo: FakeRepo): [root: string, checkout: FakeCheckout][] => [[main, repo], ...(repo.worktrees ?? []).map((worktree): [string, FakeCheckout] => [worktree.path, worktree])];

/** The deepest declared checkout or outside folder that holds `folder`, as git finds the checkout from the folder up. */
function placeOf(state: FakeGitState, folder: string): Here | 'outside' | undefined {
  const target = path.resolve(folder);
  const candidates: [string, Here | 'outside'][] = [
    ...Object.entries(state.repos).flatMap(([main, repo]) => checkouts(main, repo).map(([root, checkout]): [string, Here] => [root, { main, repo, root, checkout }])),
    ...(state.outside ?? []).map((outside): [string, 'outside'] => [outside, 'outside']),
  ];
  return candidates.filter(([at]) => target === at || target.startsWith(at + path.sep)).sort(([a], [b]) => b.length - a.length)[0]?.[1];
}

const refsOf = (repo: FakeRepo): Record<string, string> => (repo.refs ??= {});

const headOf = ({ repo, checkout }: Here): string | undefined => (checkout.branch === undefined ? checkout.head : repo.refs?.[`refs/heads/${checkout.branch}`]);

function commitAt({ repo }: Here, sha: string): FakeCommit {
  return repo.commits?.[sha] ?? gap(`the state declares no commit ${sha}`);
}

/** The commit `name` names, in the order gitrevisions(7) looks a name up. */
function resolve(here: Here, name: string): string | undefined {
  if (name === 'HEAD') return headOf(here);
  const refs = here.repo.refs ?? {};
  const ref = [name, `refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`, `refs/remotes/${name}`].find((candidate) => refs[candidate] !== undefined);
  const sha = ref === undefined ? abbreviated(here, name) : refs[ref];
  if (sha !== undefined) commitAt(here, sha);
  return sha;
}

function abbreviated({ repo }: Here, name: string): string | undefined {
  if (!/^[0-9a-f]{4,40}$/.test(name)) return undefined;
  const matches = Object.keys(repo.commits ?? {}).filter((sha) => sha.startsWith(name));
  return matches.length === 1 ? matches[0] : undefined;
}

/** `sha` and every commit before it. */
function history(here: Here, sha: string): string[] {
  const shas: string[] = [];
  for (let at: string | undefined = sha; at !== undefined; at = commitAt(here, at).parent) shas.push(at);
  return shas;
}

function onCommit(here: Here, name: string, answer: (sha: string, commit: FakeCommit) => Answer): Answer {
  const sha = resolve(here, name);
  return sha === undefined ? failed(`fatal: ambiguous argument '${name}': unknown revision or path not in the working tree.`) : answer(sha, commitAt(here, sha));
}

const linkedAt = (here: Here, folder: string): FakeWorktree | undefined => here.repo.worktrees?.find((worktree) => worktree.path === path.resolve(here.root, folder));

const holderOf = (here: Here, branch: string): string | undefined => checkouts(here.main, here.repo).find(([, checkout]) => checkout.branch === branch)?.[0];

/** The rules of git check-ref-format for `refs/heads/<name>`: no control character, space or any of ~^:?*[\, no .., @{ or //, no end in / or ., and no part that starts with . or ends with .lock. */
const INVALID_REF = /[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|\/$|\.$|(^|\/)\.|\.lock(\/|$)/;

const isBranchName = (name: string): boolean => !name.startsWith('-') && name !== 'HEAD' && !INVALID_REF.test(`refs/heads/${name}`);

const checkBranchName = (name: string): Answer => (isBranchName(name) ? done(`${name}\n`) : failed(`fatal: '${name}' is not a valid branch name`));

const gitFolderOf = (main: string, worktree: string): string => path.join(main, '.git/worktrees', path.basename(worktree));

function addWorktree(here: Here, branch: string, folder: string, start: string): Answer {
  const at = path.resolve(here.root, folder);
  if (!isBranchName(branch)) return checkBranchName(branch);
  if (refsOf(here.repo)[`refs/heads/${branch}`] !== undefined) return failed(`fatal: a branch named '${branch}' already exists`);
  if (checkouts(here.main, here.repo).some(([root]) => root === at)) return failed(`fatal: '${at}' already exists`);
  const sha = resolve(here, start);
  if (sha === undefined) return failed(`fatal: invalid reference: ${start}`);
  refsOf(here.repo)[`refs/heads/${branch}`] = sha;
  (here.repo.worktrees ??= []).push({ path: at, branch });
  const gitFolder = gitFolderOf(here.main, at);
  mkdirSync(gitFolder, { recursive: true });
  mkdirSync(at, { recursive: true });
  writeFileSync(path.join(at, '.git'), `gitdir: ${gitFolder}\n`);
  return done();
}

function removeWorktree(here: Here, folder: string, force: boolean): Answer {
  if (path.resolve(here.root, folder) === here.main) return failed(`fatal: '${folder}' is a main working tree`);
  const worktree = linkedAt(here, folder);
  if (worktree === undefined) return failed(`fatal: '${folder}' is not a working tree`);
  // As git, ignored files do not keep a worktree, untracked ones do.
  if (!force && (worktree.status ?? []).some((entry) => !entry.startsWith('!! '))) return failed(`fatal: '${folder}' contains modified or untracked files, use --force to delete it`);
  here.repo.worktrees = here.repo.worktrees?.filter((other) => other !== worktree);
  rmSync(worktree.path, { recursive: true, force: true });
  rmSync(gitFolderOf(here.main, worktree.path), { recursive: true, force: true });
  return done();
}

function deleteBranch(here: Here, branch: string): Answer {
  const holder = holderOf(here, branch);
  if (holder !== undefined) return failed(`error: cannot delete branch '${branch}' used by worktree at '${holder}'`);
  const refs = refsOf(here.repo);
  if (refs[`refs/heads/${branch}`] === undefined) return failed(`error: branch '${branch}' not found`);
  delete refs[`refs/heads/${branch}`];
  return done();
}

function listWorktrees(here: Here): Answer {
  const blocks = checkouts(here.main, here.repo).map(([root, checkout]) => {
    const head = headOf({ ...here, root, checkout }) ?? gap(`the state declares no commit for the checkout ${root}`);
    return lines([`worktree ${root}`, `HEAD ${head}`, checkout.branch === undefined ? 'detached' : `branch refs/heads/${checkout.branch}`]);
  });
  return done(blocks.join('\n'));
}

function fetch(here: Here, remote: string, refspec: string): Answer {
  const from = here.repo.remotes?.[remote];
  if (from === undefined) return failed(`fatal: '${remote}' does not appear to be a git repository`);
  const [, branch, into] = /^\+refs\/heads\/(.+):(refs\/remotes\/.+)$/.exec(refspec) ?? gap(`the fake fetches only +refs/heads/<branch>:refs/remotes/<remote>/<branch>`);
  const sha = from.branches[branch];
  if (sha === undefined) return failed(`fatal: couldn't find remote ref refs/heads/${branch}`);
  refsOf(here.repo)[into] = sha;
  return done();
}

function fastForward(here: Here, ref: string): Answer {
  const target = resolve(here, ref);
  if (target === undefined) return failed(`merge: ${ref} - not something we can merge`);
  const head = headOf(here);
  if (head !== undefined && history(here, head).includes(target)) return done();
  if (head !== undefined && !history(here, target).includes(head)) return failed('fatal: Not possible to fast-forward, aborting.');
  if (here.checkout.branch === undefined) here.checkout.head = target;
  else refsOf(here.repo)[`refs/heads/${here.checkout.branch}`] = target;
  return done();
}

function countAhead(here: Here, range: string): Answer {
  const [base, head] = range.split('..');
  if (head === undefined) gap('the fake counts only a range <base>..<head>');
  return onCommit(here, base, (from) => onCommit(here, head, (to) => {
    const before = new Set(history(here, from));
    return done(`${history(here, to).filter((sha) => !before.has(sha)).length}\n`);
  }));
}

const status = ({ checkout }: Here, ignored: boolean): Answer => done(lines((checkout.status ?? []).filter((entry) => ignored || !entry.startsWith('!! '))));

function repairWorktree(here: Here, folder: string): Answer {
  const at = path.resolve(here.root, folder);
  if (!checkouts(here.main, here.repo).some(([root]) => root === at)) return failed(`error: ${at}: .git is not a file`);
  return existsSync(at) ? done() : failed(`error: ${at}: not a valid directory`);
}

function pruneWorktrees(here: Here): Answer {
  here.repo.worktrees = here.repo.worktrees?.filter((worktree) => existsSync(worktree.path));
  return done();
}

function deleteRef(here: Here, ref: string, expected: string): Answer {
  const refs = refsOf(here.repo);
  const current = refs[ref];
  if (current === undefined) return failed(`error: unable to resolve reference '${ref}'`);
  if (current !== resolve(here, expected)) return failed(`error: cannot lock ref '${ref}': is at ${current} but expected ${expected}`);
  delete refs[ref];
  return done();
}

const COMMANDS: Command[] = [
  { usage: 'rev-parse --path-format=absolute --git-common-dir', answer: ({ main }) => done(`${path.join(main, '.git')}\n`) },
  ...['rev-parse --absolute-git-dir', 'rev-parse --path-format=absolute --git-dir'].map((usage) => ({
    usage,
    answer: ({ main, root }: Here) => done(`${root === main ? path.join(main, '.git') : gitFolderOf(main, root)}\n`),
  })),
  { usage: 'rev-parse --show-toplevel', answer: ({ root }) => done(`${root}\n`) },
  { usage: 'branch --show-current', answer: ({ checkout }) => done(checkout.branch === undefined ? '' : `${checkout.branch}\n`) },
  {
    usage: 'cat-file -e *',
    answer: (here, object) => {
      const [, name, file] = /^([^:]*):(.*)$/.exec(object) ?? gap('the fake tells only whether <commit>:<file> exists');
      const sha = resolve(here, name);
      return sha !== undefined && commitAt(here, sha).files?.includes(file) ? done() : failed(`fatal: path '${file}' does not exist in '${name}'`);
    },
  },
  {
    usage: 'rev-parse --quiet --verify *',
    answer: (here, name) => {
      const sha = resolve(here, name.replace(/\^\{commit\}$/, ''));
      return sha === undefined ? failed() : done(`${sha}\n`);
    },
  },
  { usage: 'rev-parse --short *', answer: (here, name) => onCommit(here, name, (sha) => done(`${sha.slice(0, 7)}\n`)) },
  { usage: 'log -1 --format=%s *', answer: (here, name) => onCommit(here, name, (_, commit) => done(`${commit.subject}\n`)) },
  { usage: 'log -1 --format=%cs', answer: (here) => onCommit(here, 'HEAD', (_, commit) => done(`${commit.date}\n`)) },
  { usage: 'remote -v', answer: ({ repo }) => done(lines(Object.entries(repo.remotes ?? {}).flatMap(([name, { url }]) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`]))) },
  { usage: 'symbolic-ref --quiet --short refs/remotes/origin/HEAD', answer: ({ repo }) => (repo.originHead === undefined ? failed() : done(`${repo.originHead}\n`)) },
  { usage: 'show-ref --verify --quiet *', answer: ({ repo }, ref) => (repo.refs?.[ref] === undefined ? failed() : done()) },
  { usage: 'check-ref-format --branch *', answer: (_, name) => checkBranchName(name), outside: checkBranchName },
  { usage: 'worktree add --quiet -b * * *', answer: addWorktree },
  { usage: 'worktree remove *', answer: (here, folder) => removeWorktree(here, folder, false) },
  { usage: 'worktree remove --force *', answer: (here, folder) => removeWorktree(here, folder, true) },
  { usage: 'branch --quiet -D *', answer: deleteBranch },
  { usage: 'worktree list --porcelain', answer: listWorktrees },
  { usage: 'fetch --quiet --no-write-fetch-head * *', answer: fetch },
  { usage: 'merge --quiet --ff-only *', answer: fastForward },
  { usage: 'rev-list --count *', answer: countAhead },
  { usage: 'status --porcelain', answer: (here) => status(here, false) },
  { usage: 'status --porcelain --ignored', answer: (here) => status(here, true) },
  { usage: 'worktree repair *', answer: repairWorktree },
  { usage: 'worktree prune', answer: pruneWorktrees },
  { usage: 'update-ref -d * *', answer: deleteRef },
  // The fake keeps no config, and git makes no branch section for a branch that tracks nothing.
  { usage: 'config --remove-section *', answer: (_, section) => failed(`fatal: no such section: ${section}`) },
];

/** The command `args` runs, and the arguments in the places its usage marks with *. */
function commandOf(args: string[]): [Command, string[]] | undefined {
  for (const command of COMMANDS) {
    const words = command.usage.split(' ');
    if (words.length === args.length && words.every((word, index) => word === '*' || word === args[index])) {
      return [command, args.filter((_, index) => words[index] === '*')];
    }
  }
  return undefined;
}

/**
 * A git that answers from `state` and starts no process. A command or folder the state does not cover throws an error
 * that names both, so a gap fails the test that hit it rather than passing on a made-up answer. Worktree commands make
 * and remove the worktree's folder, as git does; only prune and repair look at the disk.
 */
export function fakeGit(declared: FakeGitState): FakeGit {
  const state = structuredClone(declared);
  const calls: string[][] = [];
  const runner: GitRunner = (folder, args) => {
    calls.push([folder, ...args]);
    try {
      const [command, values] = commandOf(args) ?? gap('the fake has no such command');
      const place = placeOf(state, folder) ?? gap('the state declares no such folder');
      return place === 'outside' ? (command.outside ?? notARepo)(...values) : command.answer(place, ...values);
    } catch (error) {
      throw new Error(`fake git cannot answer \`git ${args.join(' ')}\` in ${folder}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return { runner, calls, state };
}
