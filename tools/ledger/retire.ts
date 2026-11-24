import { accessSync, constants, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { markRetired, putChildReport, withoutClaim } from './edit.js';
import { fail } from './failure.js';
import { folderEntries, holdsAnything, isTaken, treeEntries } from './files.js';
import { isReadableSlug, parseLedger, type Child } from './format.js';
import {
  branchPrs,
  changedFiles,
  checkoutRoot,
  commitOf,
  commitsAhead,
  currentBranch,
  deleteBranchAt,
  fetchBranch,
  ghDefaultBranch,
  mainCheckout,
  mergedPrHeads,
  originHead,
  pruneWorktrees,
  removeLinkedWorktree,
} from './git.js';
import { ledgerBin, realPath, samePath } from './paths.js';
import { storedText } from './record.js';
import { repoKey } from './repo-key.js';
import type { Archive } from './store.js';
import { findNamed, findTasks, inRepo, locateChild, namedChildren, sameTask, type Task } from './tasks.js';
import { plural } from './views.js';
import { below, deleteInBackground, linkAboveBuildFolders, removedWorktreeXcodeFolder, xcodeFolderOf } from './worktrees.js';
import { readLedger, shellWord, today, updateLedger, type Context } from './write.js';

/** bin/ledger as one shell word, so the commands that messages name can be pasted as they are. */
const ledgerCommand = shellWord(ledgerBin);

type Ref = { slug: string; main: string };

/**
 * What git and gh tell about a worktree. `ahead` is undefined when git could not count, `mergedHeads` when gh could not
 * tell. `openPr` is the number of the branch's open PR, asked for only when the branch is not merged.
 */
export type BranchState = { branch?: string; head?: string; defaultBranch: string; ahead?: number; dirty: number; mergedHeads?: string[]; openPr?: number };

/**
 * Why the evidence cannot be archived whole. A link whose text leaves the folder dangles in the archive, where the folder
 * has another name and the worktree is gone; anything but a folder at the evidence path is never archived.
 */
export type EvidenceProblem =
  | { kind: 'evidence-link'; link: string; target: string; evidence: string; isFolder: boolean }
  | { kind: 'evidence-link-text'; link: string; target: string; evidence: string; inside: string }
  | { kind: 'evidence-link-loop'; link: string; evidence: string; holder: string }
  | { kind: 'evidence-not-folder'; evidence: string }
  | { kind: 'evidence-special'; entry: string; evidence: string }
  | { kind: 'evidence-unreadable'; entry: string; error: string };

/** `evidence` is set when the folder holds anything. */
export type WorktreeFacts = { folder: string; state: BranchState; evidence?: string; evidenceProblem?: EvidenceProblem; buildFolders: string[] };

/** The worktree `folder` of the repo at `main`, which git removed while it still lists it, with the state of its branch. */
export type RemovedWorktree = { main: string; folder: string; state: BranchState; buildFolders: string[] };

/** Everything planRetire decides on, read from disk, git and gh. `worktree` is undefined for a backlog task. */
export type RetireFacts = {
  task: Task;
  ref: Ref;
  text: string;
  worktree?: WorktreeFacts;
  tasks: Task[];
  /** The repo key the copy is archived under: the repo's key now, also for a backlog ledger still filed under an alias. */
  archiveRepo: string;
  /** Whether a copy or an evidence folder already uses the archive name. */
  archiveNameTaken: (name: string) => boolean;
  /**
   * A retire that stopped after git removed the worktree folder: the record names a host of this machine, the folder is
   * gone, and the archive holds the ledger. A rerun then finishes without --force; any other missing worktree needs it.
   */
  removedWorktree?: RemovedWorktree;
  /** An archive copy with the ledger's text, and whether removing the worktree would lose evidence it does not hold. */
  alreadyArchived?: { name: string; location: string; losesEvidence: boolean };
  archiveLocation: (name: string) => string;
  archiveEvidenceLocation: (name: string) => string;
  today: string;
  warnings: string[];
};

/** Each one stops the retire unless --force is given, but the evidence ones: --force never passes them, as evidence would be lost. */
export type Blocker =
  | { kind: 'children'; names: string[] }
  | { kind: 'missing-child'; name: string }
  | { kind: 'dirty'; count: number }
  | { kind: 'unmerged' }
  | { kind: 'elsewhere'; worktree?: string; lost?: string }
  | { kind: 'evidence'; name: string; copy: string; evidenceLocation: string; evidence: string }
  | EvidenceProblem;

const isForceable = ({ kind }: Blocker): boolean => kind === 'children' || kind === 'missing-child' || kind === 'dirty' || kind === 'unmerged' || kind === 'elsewhere';

export type RetireAction =
  | { kind: 'archive'; repo: string; name: string; location: string; evidenceLocation: string; text: string; evidence?: string }
  | { kind: 'already-archived'; repo: string; name: string; location: string }
  | { kind: 'remove-worktree'; main: string; folder: string; force: boolean }
  | { kind: 'prune-worktrees'; main: string; folder: string }
  | { kind: 'remove-active'; repo: string; name: string; location: string }
  | { kind: 'remove-backlog'; repo: string; name: string; location: string }
  | { kind: 'mark-parent'; parent: Task; parentRef: Ref; child: Ref; childName: string }
  | { kind: 'copy-report'; parent: Task; parentRef: Ref; heading: string; report: readonly string[]; childName: string }
  | { kind: 'delete-branch'; main: string; branch: string; head: string }
  | { kind: 'keep-branch'; branch: string; reason: string }
  | { kind: 'delete-build-folders'; folders: string[] }
  | { kind: 'hint'; text: string };

export type RetirePlan = {
  task: Task;
  worktree?: WorktreeFacts;
  blockers: Blocker[];
  /** A blocker stops the retire: any one without --force, and an evidence blocker even with it. */
  blocked: boolean;
  warnings: string[];
  actions: RetireAction[];
};

/** A child line names a task in the parent's repo unless it names another. */
const lineRef = (line: Child, parentMain: string): Ref => ({ slug: line.slug, main: line.main ?? parentMain });

/** By disk alone: a child with no ledger anywhere is missing, whatever its line's mark says. */
function childStatus(tasks: Task[], line: Child, parent: Ref): 'retired' | 'missing' | 'live' {
  const found = locateChild(tasks, lineRef(line, parent.main), parent);
  return found === undefined ? 'missing' : found.status === 'retired' ? 'retired' : 'live';
}

/** How the ledger of a task in `fromMain` names `ref`: `<slug>`, or `<slug> @ <main>` in another repo. */
const linkFrom = (fromMain: string, ref: Ref): string => (samePath(fromMain, ref.main) ? ref.slug : `${ref.slug} @ ${ref.main}`);

export const isMerged = ({ ahead, head, mergedHeads = [] }: BranchState): boolean => ahead === 0 || (head !== undefined && mergedHeads.includes(head));

function keptReason({ head, mergedHeads = [] }: BranchState): string {
  if (head === undefined) return 'it has no commits yet';
  return mergedHeads.length > 0 ? 'its merged PR ends at another commit' : 'it is not merged';
}

function archiveName(facts: RetireFacts): string {
  const { task } = facts;
  const base = `${facts.today}-${isReadableSlug(task.slug) ? task.slug : task.name}`;
  let name = base;
  for (let n = 2; facts.archiveNameTaken(name); n++) name = `${base}-${n}`;
  return name;
}

/** The parent's ## Children line, report copy and hint; warnings for what cannot be done. */
function parentActions({ task, ref, tasks }: RetireFacts, warnings: string[]): RetireAction[] {
  const named = task.ledger.location.parent;
  if (named === undefined) return [];
  const parentRef = { slug: named.slug, main: named.main ?? ref.main };
  const shown = linkFrom(ref.main, parentRef);
  const live = findNamed(tasks, parentRef).filter(({ place }) => place !== 'archive');
  if (live.length !== 1) {
    const found = live.length === 0 ? 'no live ledger' : `${live.length} ledgers (${live.map(({ file }) => file).join(', ')})`;
    warnings.push(`the parent ${shown} has ${found}, so no ## Children line is marked and the report is not copied.`);
    return [];
  }
  const [parent] = live;
  if (parent.elsewhere) {
    warnings.push(`the parent ${shown} is active on ${parent.host ?? 'another machine'}, and this machine has only a read-only copy of its ledger, so no ## Children line is marked and the report is not copied. Do both there.`);
    return [];
  }
  const childName = linkFrom(parentRef.main, ref);
  const actions: RetireAction[] = [];
  const line = parent.ledger.children.find((child) => sameTask(lineRef(child, parentRef.main), ref));
  if (line === undefined) warnings.push(`${childName} is not listed under ## Children of ${parentRef.slug} in ${parent.file}, so no line is marked retired.`);
  else if (line.mark?.kind !== 'retired') actions.push({ kind: 'mark-parent', parent, parentRef, child: ref, childName });
  const { report } = task.ledger;
  if (report.length === 0) warnings.push(`${task.file} has no report under ## Report, so none is copied to ${shown}.`);
  else actions.push({ kind: 'copy-report', parent, parentRef, heading: samePath(parentRef.main, ref.main) ? ref.slug : `${ref.slug}@${ref.main}`, report, childName });
  const siblingsActive = namedChildren(parent, tasks).some((child) => !sameTask(lineRef(child, parentRef.main), ref) && childStatus(tasks, child, parentRef) !== 'retired');
  if (line !== undefined && !siblingsActive) {
    const text = samePath(parentRef.main, ref.main)
      ? `Parent ${parentRef.slug} has no active children left. Finalize it with the question from \`ledger task gate finalize ${parentRef.slug}\`.`
      : `Parent ${parentRef.slug} @ ${parentRef.main} has no active children left. Finalize it from a session in ${parentRef.main} with the question from \`ledger task gate finalize ${parentRef.slug}\`.`;
    return [...actions, { kind: 'hint', text }];
  }
  return actions;
}

/** What retiring would check and do, in order, from facts alone; it reads and writes nothing. */
export function planRetire(facts: RetireFacts, { force }: { force: boolean }): RetirePlan {
  const { task, ref, text, worktree, tasks } = facts;
  const warnings = [...facts.warnings];
  const blockers: Blocker[] = [];
  const named = (status: ReturnType<typeof childStatus>): string[] =>
    namedChildren(task, tasks)
      .filter((line) => childStatus(tasks, line, ref) === status)
      .map((line) => linkFrom(ref.main, lineRef(line, ref.main)));
  const active = named('live');
  if (active.length > 0) blockers.push({ kind: 'children', names: active });
  for (const name of named('missing')) blockers.push({ kind: 'missing-child', name });
  if (task.elsewhere && facts.removedWorktree === undefined) {
    const { lost } = task.ledger.location;
    blockers.push({ kind: 'elsewhere', ...(task.worktree === undefined ? {} : { worktree: task.worktree }), ...(lost === undefined ? {} : { lost: lost.date }) });
  }
  if (worktree !== undefined) {
    if (worktree.state.dirty > 0) blockers.push({ kind: 'dirty', count: worktree.state.dirty });
    if (!isMerged(worktree.state)) blockers.push({ kind: 'unmerged' });
    if (worktree.evidenceProblem !== undefined) blockers.push(worktree.evidenceProblem);
  }

  const actions: RetireAction[] = [];
  const archived = facts.alreadyArchived;
  if (archived !== undefined) {
    // A rerun after a failed worktree removal lands here. It goes on only when no evidence would be lost.
    actions.push({ kind: 'already-archived', repo: facts.archiveRepo, name: archived.name, location: archived.location });
    if (archived.losesEvidence) {
      const evidence = worktree === undefined ? 'the backlog task, which has none' : `${path.join(worktree.folder, '.claude', 'evidence')}/`;
      blockers.push({ kind: 'evidence', name: archived.name, copy: archived.location, evidenceLocation: facts.archiveEvidenceLocation(archived.name), evidence });
    }
  } else {
    const name = archiveName(facts);
    actions.push({
      kind: 'archive',
      repo: facts.archiveRepo,
      name,
      location: facts.archiveLocation(name),
      evidenceLocation: facts.archiveEvidenceLocation(name),
      text,
      ...(worktree?.evidence === undefined ? {} : { evidence: worktree.evidence }),
    });
  }
  const removal = { repo: task.repo, name: task.name, location: task.file };
  const removed = facts.removedWorktree;
  actions.push(
    ...(removed !== undefined
      ? [{ kind: 'prune-worktrees', main: removed.main, folder: removed.folder } as const]
      : worktree === undefined
      ? task.place === 'backlog'
        ? [{ kind: 'remove-backlog', ...removal } as const]
        : []
      : // The worktree first: one git cannot remove keeps the task, for a rerun to find by its active ledger.
        [{ kind: 'remove-worktree', main: ref.main, folder: worktree.folder, force } as const]),
  );
  const parent = parentActions(facts, warnings);
  const hint = parent.filter(({ kind }) => kind === 'hint');
  actions.push(...parent.filter(({ kind }) => kind !== 'hint'));
  const state = worktree?.state ?? removed?.state;
  if (state?.branch !== undefined) {
    actions.push(
      isMerged(state) && state.head !== undefined
        ? { kind: 'delete-branch', main: removed?.main ?? ref.main, branch: state.branch, head: state.head }
        : { kind: 'keep-branch', branch: state.branch, reason: keptReason(state) },
    );
  }
  const buildFolders = worktree?.buildFolders ?? removed?.buildFolders ?? [];
  if (buildFolders.length > 0) actions.push({ kind: 'delete-build-folders', folders: buildFolders });
  // Last, so a retire that stops before it leaves the task for a plain rerun to find and finish.
  if (task.place === 'active') actions.push({ kind: 'remove-active', ...removal });
  actions.push(...hint);

  const blocked = blockers.some((blocker) => !isForceable(blocker) || !force);
  return { task, ...(worktree === undefined ? {} : { worktree }), blockers, blocked, warnings, actions };
}

/** The local origin/HEAD first, then what gh says; main, with a warning, when neither knows. */
function defaultBranchOf(main: string, warnings: string[]): string {
  const local = originHead(main)?.replace(/^origin\//, '');
  if (local) return local;
  const remote = ghDefaultBranch(main);
  if (typeof remote === 'string') return remote;
  warnings.push(`the default branch is unknown: origin/HEAD is not set and ${remote.error}. Retire guesses main.`);
  return 'main';
}

function stateFacts(folder: string, main: string, warnings: string[]): BranchState {
  const changes = changedFiles(folder) ?? fail(`Could not read the state of ${folder}: git status failed.`);
  return branchState(folder, main, currentBranch(folder), commitOf(folder, 'HEAD'), changes.length, warnings);
}

/** The state of `branch`, checked out at `head`, read in `folder`, a checkout of the repo at `main`, with `dirty` uncommitted changes. */
function branchState(folder: string, main: string, branch: string | undefined, head: string | undefined, dirty: number, warnings: string[]): BranchState {
  const defaultBranch = defaultBranchOf(main, warnings);
  const fetchError = fetchBranch(main, 'origin', defaultBranch);
  if (fetchError !== undefined) warnings.push(`git fetch origin ${defaultBranch} failed, so origin/${defaultBranch} may be out of date: ${fetchError}`);
  const ahead = head === undefined ? undefined : commitsAhead(folder, `origin/${defaultBranch}`, head);
  if (ahead === undefined) warnings.push(`git could not count the commits ahead of origin/${defaultBranch}, so only a merged PR that ends at HEAD makes the branch merged.`);
  const prs = branch === undefined ? [] : mergedPrHeads(folder, branch);
  if ('error' in prs) warnings.push(`${prs.error}. Merged PRs are unknown, so only the commit count decides whether the branch is merged.`);
  const state: BranchState = {
    ...(branch === undefined ? {} : { branch }),
    ...(head === undefined ? {} : { head }),
    defaultBranch,
    ...(ahead === undefined ? {} : { ahead }),
    dirty,
    ...('error' in prs ? {} : { mergedHeads: prs }),
  };
  if (branch === undefined || isMerged(state)) return state;
  const all = branchPrs(folder, branch);
  const open = 'error' in all ? undefined : all.find(({ state: prState }) => prState === 'OPEN');
  return open === undefined ? state : { ...state, openPr: open.number };
}

const NOTHING = 'Nothing was retired.';

/** The task: the active task of the checkout that holds cwd, else the one titled `slug` in a worktree of this repo, else in its backlog. */
function findTarget(tasks: Task[], cwd: string, main: string, slug: string | undefined): Task {
  if (slug === undefined) {
    const root = checkoutRoot(cwd);
    // A lost task's old path may hold another task's worktree now.
    const own = root === undefined ? [] : tasks.filter(({ worktree, status }) => status !== 'lost' && worktree !== undefined && samePath(worktree, root));
    if (own.length > 1) fail(`${own.length} active tasks name the worktree ${root}: ${own.map(({ slug }) => slug).join(', ')}. ${NOTHING} Give the slug of the one to retire: ${ledgerCommand} task retire <slug>.`);
    return own[0] ?? fail(`No task ledger in or above ${cwd}. Give a slug: ${ledgerCommand} task retire <slug>.`);
  }
  const named = findNamed(tasks, { slug, main });
  if (named.length === 1 && named[0].place === 'archive') fail(`${slug} is retired already: ${named[0].file}`);
  const live = named.filter(({ place }) => place !== 'archive');
  const inWorktrees = live.filter(({ place }) => place === 'active');
  const found = inWorktrees.length > 0 ? inWorktrees : live;
  if (found.length > 1) fail(`Several task ledgers are named "${slug}": ${found.map(({ file }) => file).join(', ')}. ${NOTHING} Give each task its own slug in its ledger's title.`);
  if (found.length === 0) {
    const known = tasks.filter((task) => task.place !== 'archive' && inRepo(task, main)).map((task) => task.slug);
    fail(`No task ledger is named "${slug}" in the repo at ${main}. ${NOTHING} Task ledgers: ${known.join(', ') || 'none'}.`);
  }
  return found[0];
}

/**
 * Whether the text of a link `depth` folders below the evidence folder leaves it at any step. `../evidence/b` lands inside
 * today, but not in the archive, where the folder has another name; an absolute text never does.
 */
function textLeaves(target: string, depth: number): boolean {
  if (path.isAbsolute(target)) return true;
  let level = depth;
  for (const segment of target.split('/')) {
    if (segment === '..') level--;
    else if (segment !== '' && segment !== '.') level++;
    if (level < 0) return true;
  }
  return false;
}

/** Where a link really lands; for a dangling one, its text resolved from the real folder it sits in. */
function landing(link: string, realFolder: string, target: string): string {
  try {
    return realpathSync(link);
  } catch {
    return path.resolve(realFolder, target);
  }
}

/**
 * The first reason, in name order, the evidence folder cannot be archived whole: it is a symbolic link or not a folder,
 * a link in it lands on a folder that holds the link or leaves it by where it lands or by its text, an entry in it is
 * not a file, folder or link (a FIFO or socket cannot be copied), or a file in it cannot be read or a folder read or
 * searched. A missing folder has none.
 */
function evidenceProblem(evidence: string): EvidenceProblem | undefined {
  const unreadable = (entry: string, error: unknown): EvidenceProblem => ({ kind: 'evidence-unreadable', entry, error: (error as NodeJS.ErrnoException).code ?? message(error) });
  let root: string;
  try {
    const stat = lstatSync(evidence, { throwIfNoEntry: false });
    if (stat === undefined) return undefined;
    if (stat.isSymbolicLink()) return { kind: 'evidence-link', link: evidence, target: readlinkSync(evidence), evidence, isFolder: true };
    if (!stat.isDirectory()) return { kind: 'evidence-not-folder', evidence };
    root = realpathSync(evidence);
  } catch (error) {
    return unreadable(evidence, error);
  }
  const walk = (folder: string, realFolder: string, depth: number): EvidenceProblem | undefined => {
    try {
      for (const name of readdirSync(folder).sort()) {
        const entry = path.join(folder, name);
        const stat = lstatSync(entry);
        if (stat.isSymbolicLink()) {
          const target = readlinkSync(entry);
          const lands = landing(entry, realFolder, target);
          const inside = lands === root || below(root, lands) !== undefined;
          const holdsLink = lands === realFolder || below(lands, realFolder) !== undefined;
          if (!inside) return { kind: 'evidence-link', link: entry, target, evidence, isFolder: false };
          if (holdsLink) return { kind: 'evidence-link-loop', link: entry, evidence, holder: path.relative(root, lands) };
          if (textLeaves(target, depth)) return { kind: 'evidence-link-text', link: entry, target, evidence, inside: path.relative(realFolder, lands) };
        } else if (stat.isDirectory()) {
          const found = walk(entry, path.join(realFolder, name), depth + 1);
          if (found !== undefined) return found;
        } else if (!stat.isFile()) {
          return { kind: 'evidence-special', entry, evidence };
        } else {
          try {
            accessSync(entry, constants.R_OK);
          } catch (error) {
            return unreadable(entry, error);
          }
        }
      }
    } catch (error) {
      return unreadable(folder, error);
    }
    return undefined;
  };
  return walk(evidence, root, 0);
}

/** The ledger as it is archived: a retired task has no claim, whichever session held it. */

/** Reads what planRetire needs. It writes nothing; the fetch of the default branch only moves origin/<default>. */
/**
 * The worktree of `task` when a retire stopped after git removed its folder: the record names a host of this machine
 * and a worktree folder that is gone. Call it only once the archive holds the ledger. The branch is the record's, as
 * the main checkout of the task, else `main`, holds it.
 */
function removedWorktreeOf({ store }: Context, task: Task, main: string, warnings: string[]): RemovedWorktree | undefined {
  const { host, worktree: folder, branch } = task.ledger.location;
  if (!task.elsewhere || host === undefined || !(store.ownHosts?.has(host) ?? false) || folder === undefined || isTaken(folder)) return undefined;
  const repo = task.main ?? main;
  const xcode = removedWorktreeXcodeFolder(repo, folder);
  if (xcode?.keptBecause !== undefined) warnings.push(`the build folder ${xcode.path} is kept: ${xcode.keptBecause}.`);
  const head = branch === undefined ? undefined : commitOf(repo, `refs/heads/${branch}`);
  return {
    main: repo,
    folder,
    state: branchState(repo, repo, head === undefined ? undefined : branch, head, 0, warnings),
    buildFolders: xcode === undefined || xcode.keptBecause !== undefined ? [] : [xcode.path],
  };
}

export function readRetire(context: Context, slug: string | undefined): RetireFacts {
  const { cwd, store } = context;
  const main = mainCheckout(cwd) ?? fail(`${cwd} is not inside a git repository. Run ${ledgerCommand} task retire in the repo of the task.`);
  const tasks = findTasks(store);
  const task = findTarget(tasks, cwd, main, slug);
  if (task.place === 'active' && !task.elsewhere && (task.main === undefined || !samePath(task.main, main))) {
    const where = task.worktree ?? 'the worktree its ledger names';
    fail(`The task ${task.slug} is active in another clone of this repo, in ${where}. Retire it from there: cd ${where} && ${ledgerCommand} task retire ${task.slug}`);
  }
  const warnings: string[] = [];
  let worktree: WorktreeFacts | undefined;
  let evidence: string | undefined;
  if (task.worktree !== undefined && !task.elsewhere) {
    const folder = task.worktree;
    if (samePath(folder, main)) fail(`${folder} is the main checkout, not a linked worktree. ledger task retire removes only linked worktrees.`);
    evidence = path.join(folder, '.claude', 'evidence');
    const problem = evidenceProblem(evidence);
    const xcode = xcodeFolderOf(folder);
    if (xcode?.keptBecause !== undefined) warnings.push(`the build folder ${xcode.path} is kept: ${xcode.keptBecause}.`);
    worktree = {
      folder,
      state: stateFacts(folder, main, warnings),
      ...(folderEntries(evidence).length > 0 ? { evidence } : {}),
      ...(problem === undefined ? {} : { evidenceProblem: problem }),
      buildFolders: xcode === undefined || xcode.keptBecause !== undefined ? [] : [xcode.path],
    };
  }
  const text = withoutClaim(readLedger(context, task));
  const archiveRepo = repoKey(main);
  const identical = store.archive.list(archiveRepo).find((copy) => copy.text === storedText(text));
  const removedWorktree = identical === undefined ? undefined : removedWorktreeOf(context, task, main, warnings);
  return {
    task,
    ref: { slug: task.slug, main },
    text,
    ...(worktree === undefined ? {} : { worktree }),
    tasks,
    archiveRepo,
    archiveNameTaken: (name) => store.archive.nameTaken(archiveRepo, name),
    ...(removedWorktree === undefined ? {} : { removedWorktree }),
    ...(identical === undefined ? {} : { alreadyArchived: { name: identical.name, location: identical.location, losesEvidence: losesEvidence(store.archive, archiveRepo, identical.name, evidence) } }),
    archiveLocation: (name) => store.archive.location(archiveRepo, name),
    archiveEvidenceLocation: (name) => store.archive.evidenceLocation(archiveRepo, name),
    today: today(),
    warnings,
  };
}

function reasonOf(blocker: Blocker): string {
  switch (blocker.kind) {
    case 'children':
      return `it has active children: ${blocker.names.join(', ')}`;
    case 'missing-child':
      return `child ${blocker.name} has no ledger anywhere`;
    case 'dirty':
      return `it has ${plural(blocker.count, 'uncommitted change')}`;
    case 'unmerged':
      return 'its branch is not merged';
    case 'elsewhere':
      return blocker.lost === undefined
        ? `its worktree${blocker.worktree === undefined ? '' : ` ${blocker.worktree}`} is not on this machine, so the task may be live on another machine`
        : `it is marked lost since ${blocker.lost}, as its worktree is gone`;
    case 'evidence':
      return `${blocker.copy} is archived already, but its evidence differs from ${blocker.evidence}`;
    case 'evidence-link':
      return blocker.isFolder
        ? `${blocker.link} is a symbolic link to ${blocker.target}, outside ${blocker.evidence}/`
        : `the symbolic link ${path.relative(blocker.evidence, blocker.link)} in ${blocker.evidence}/ points to ${blocker.target}, outside the evidence folder`;
    case 'evidence-link-text':
      return `the symbolic link ${path.relative(blocker.evidence, blocker.link)} in ${blocker.evidence}/ has the text ${blocker.target}, which steps outside the evidence folder`;
    case 'evidence-link-loop': {
      const folder = blocker.holder === '' ? 'the evidence folder itself' : `the folder ${blocker.holder}, which holds it`;
      return `the symbolic link ${path.relative(blocker.evidence, blocker.link)} in ${blocker.evidence}/ points to ${folder}, so it makes a loop`;
    }
    case 'evidence-not-folder':
      return `${blocker.evidence} is not a folder, and evidence must be a folder`;
    case 'evidence-special':
      return `${path.relative(blocker.evidence, blocker.entry)} in ${blocker.evidence}/ is not a file, a folder or a symbolic link`;
    case 'evidence-unreadable':
      return `${blocker.entry} cannot be read (${blocker.error}), so the evidence cannot be archived`;
  }
}

/** What to do about a blocker that --force does not pass. */
function remedy(blocker: Blocker): string {
  switch (blocker.kind) {
    case 'evidence':
      return `See what is archived in ${blocker.evidenceLocation}/ with \`${ledgerCommand} show ${shellWord(blocker.name)} --evidence\`, then make the two match and run ${ledgerCommand} task retire again.`;
    case 'evidence-link':
      return `Replace it with the ${blocker.isFolder ? 'folder' : 'file'} it points to, then run ${ledgerCommand} task retire again.`;
    case 'evidence-link-text':
      return `The link would break in the archive. Change its text to ${blocker.inside}, then run ${ledgerCommand} task retire again.`;
    case 'evidence-link-loop':
      return `Remove the link, then run ${ledgerCommand} task retire again.`;
    case 'evidence-not-folder':
      return `Move it into a folder at that path, then run ${ledgerCommand} task retire again.`;
    case 'evidence-special':
      return `Move it out of the evidence folder, then run ${ledgerCommand} task retire again.`;
    case 'evidence-unreadable':
      return `Make it readable, then run ${ledgerCommand} task retire again.`;
    default:
      return '';
  }
}

/** The lines that say why the plan stops, old wording kept: the children first, as the old script checked them first. */
function refusal({ task, blockers }: RetirePlan, force: boolean): string {
  const lines: string[] = [];
  for (const blocker of blockers) {
    if (blocker.kind === 'children' && !force) lines.push(`${task.slug} has active children: ${blocker.names.join(', ')}. Retire them first, or pass --force.`);
    if (blocker.kind === 'missing-child' && !force) lines.push(`Not retired: ${reasonOf(blocker)}. Remove its line under ## Children, or pass --force.`);
  }
  for (const blocker of blockers) {
    if (blocker.kind === 'elsewhere' && !force) lines.push(`Not retired: ${reasonOf(blocker)}. Add --force to archive its ledger and remove it from the store; no worktree is removed.`);
  }
  const state = force ? [] : blockers.filter(({ kind }) => kind === 'dirty' || kind === 'unmerged');
  if (state.length > 0) lines.push(`Not retired: ${state.map(reasonOf).join(' and ')}. Add --force to retire it anyway. Uncommitted changes are lost with the worktree.`);
  for (const blocker of blockers) {
    if (!isForceable(blocker)) lines.push(`Not retired: ${reasonOf(blocker)}. ${remedy(blocker)}`);
  }
  return lines.join('\n');
}

function stepText(action: RetireAction): string | string[] | undefined {
  switch (action.kind) {
    case 'archive':
      return [`archive the ledger to ${action.location}`, ...(action.evidence === undefined ? [] : [`archive ${action.evidence}/ to ${action.evidenceLocation}/`])];
    case 'already-archived':
      return `leave the archive as it is: the ledger is archived already at ${action.location}`;
    case 'remove-worktree':
      return `remove the worktree ${action.folder}${action.force ? ' with --force' : ''}`;
    case 'prune-worktrees':
      return `prune what git keeps of the removed worktree ${action.folder}`;
    case 'remove-active':
      return `delete the active ledger ${action.location}`;
    case 'remove-backlog':
      return `delete the backlog ledger ${action.location}`;
    case 'mark-parent':
      return `mark ${action.childName} retired under ## Children of ${action.parentRef.slug} in ${action.parent.file}`;
    case 'copy-report':
      return `copy the report to ## Child reports of ${action.parentRef.slug} in ${action.parent.file}`;
    case 'delete-branch':
      return `delete the branch ${action.branch}, because it is merged`;
    case 'keep-branch':
      return `keep the branch ${action.branch}, because ${action.reason}`;
    case 'delete-build-folders':
      return `delete ${plural(action.folders.length, 'build folder')}: ${action.folders.join(', ')}`;
    case 'hint':
      return undefined;
  }
}

/** Whether gh knows of a merged PR of the branch, and whether one ends at its HEAD. */
export type MergedPr = 'unknown' | 'none' | 'at-head' | 'elsewhere';

function mergedPr({ head, mergedHeads }: BranchState): MergedPr {
  if (mergedHeads === undefined) return 'unknown';
  if (mergedHeads.length === 0) return 'none';
  return head !== undefined && mergedHeads.includes(head) ? 'at-head' : 'elsewhere';
}

const MERGED_PR_TEXT: Record<MergedPr, string> = {
  unknown: 'merged PRs unknown',
  none: 'no merged PR',
  'at-head': 'a merged PR ends at HEAD',
  elsewhere: 'a merged PR ends at another commit',
};

function branchLine({ branch, ahead, defaultBranch, mergedPr: pr }: NonNullable<RetireResult['worktree']>): string {
  const base = `origin/${defaultBranch}`;
  const commits = ahead === undefined ? `commits ahead of ${base} unknown` : ahead === 0 ? `no commits ahead of ${base}` : `${plural(ahead, 'commit')} ahead of ${base}`;
  return [branch ?? 'detached HEAD', commits, MERGED_PR_TEXT[pr]].join(' · ');
}

export function planView({ slug, ledger, worktree, blockers, steps }: RetireResult): string {
  const reasons = (forceable: boolean): string[] => blockers.filter((blocker) => blocker.forceable === forceable).map(({ reason }) => reason);
  const [forceable, never] = [reasons(true), reasons(false)];
  return [
    `Retire ${slug} · dry run, nothing changed`,
    ...(worktree === undefined
      ? [`backlog   ${ledger}`]
      : [`worktree  ${worktree.folder}`, `branch    ${branchLine(worktree)}`, `changes   ${worktree.dirty === 0 ? 'none' : plural(worktree.dirty, 'uncommitted change')}`]),
    '',
    'Steps:',
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    ...(forceable.length > 0 ? ['', `Retiring it needs --force: ${forceable.join(' and ')}.`] : []),
    ...(never.length > 0 ? ['', `It cannot be retired, not even with --force: ${never.join(' and ')}.`] : []),
  ].join('\n');
}

export type Output = { line: (text: string) => void; warn: (text: string) => void };

const consoleOutput: Output = { line: (text) => console.log(text), warn: (text) => console.error(`warning: ${text}`) };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `text` as one sentence that ends in a period, so the next one can follow it. */
const sentence = (text: string): string => `${text.replace(/[.\s]+$/, '')}.`;

type ArchiveCopy = { repo: string; name: string; location: string };

/**
 * Whether deleting the folder `evidence` would lose evidence that the archive copy `name` does not hold: a file it
 * lacks or holds with other bytes, or a symbolic link, unless the two match whole. Evidence the copy holds and the
 * folder lacks is lost by nothing, as when a worktree removal that failed halfway deleted it.
 */
function losesEvidence(archive: Archive, repo: string, name: string, evidence: string | undefined): boolean {
  try {
    if (evidence === undefined || !holdsAnything(evidence) || archive.evidenceState(repo, name, evidence) !== 'differs') return false;
    const archived = new Set(archive.evidenceFiles(repo, name));
    return treeEntries(evidence).some((entry) => {
      if (entry.isDirectory()) return false;
      const file = path.relative(evidence, path.join(entry.parentPath, entry.name));
      return !entry.isFile() || !archived.has(file) || archive.readEvidence(repo, name, file)?.equals(readFileSync(path.join(evidence, file))) !== true;
    });
  } catch {
    // A folder that cannot be read may hold anything.
    return true;
  }
}

/**
 * Stops the retire, before `removal` deletes the task, when the ledger no longer matches the archive copy, or its
 * evidence holds what the copy lacks: another session may have written to them since the copy was made, and that work
 * would be lost. Returns the text of the ledger, which the copy holds as a record.
 */
function stopIfChanged(context: Context, plan: RetirePlan, copy: ArchiveCopy, removal: string): string {
  const { archive } = context.store;
  const evidence = plan.worktree === undefined ? undefined : path.join(plan.worktree.folder, '.claude', 'evidence');
  let text: string | undefined;
  try {
    text = readLedger(context, plan.task);
  } catch {
    text = undefined;
  }
  const changed = [
    ...(text === undefined || storedText(withoutClaim(text)) !== archive.read(copy.repo, copy.name)?.text ? [`the ledger ${plan.task.file}`] : []),
    ...(losesEvidence(archive, copy.repo, copy.name, evidence) ? [`the evidence ${evidence}/`] : []),
  ];
  if (text === undefined || changed.length > 0) stopBefore(removal, changed, copy);
  return text;
}

function stopBefore(removal: string, changed: string[], copy: ArchiveCopy): never {
  return fail(`Stopped before removing ${removal}: ${changed.join(' and ')} changed after the archive copy ${copy.location} was written. Nothing was removed. Run ${ledgerCommand} task retire again.`);
}

/**
 * Carries out the plan in its order. A failure before the worktree or backlog ledger is removed stops the retire; after
 * that each step only warns, but for the removal of the active record. That comes last, so a retire that stops on the
 * way leaves the task for a rerun to find and finish.
 */
export function executeRetire(context: Context, plan: RetirePlan, out: Output = consoleOutput): void {
  const { store } = context;
  const [copy] = plan.actions.flatMap((action): ArchiveCopy[] =>
    action.kind === 'archive' || action.kind === 'already-archived' ? [{ repo: action.repo, name: action.name, location: action.location }] : [],
  );
  let parentMarked = true;
  /** The ledger's text as it was checked before its worktree was removed, with the evidence that is gone now. */
  let checked: string | undefined;
  for (const action of plan.actions) {
    switch (action.kind) {
      case 'archive': {
        const evidenceCopy = `${action.evidenceLocation}/`;
        try {
          store.archive.write(action.repo, action.name, action.text, action.evidence);
          if (store.archive.read(action.repo, action.name)?.text !== storedText(action.text)) fail(`the archive copy does not match the ledger`);
        } catch (error) {
          const copies = action.evidence === undefined ? `The ledger copy ${action.location} may exist` : `The ledger copy ${action.location} and the evidence copy ${evidenceCopy} may exist`;
          fail(`Could not archive ${plan.task.slug}: ${sentence(message(error))} ${copies} already. Fix the cause, then run ${ledgerCommand} task retire again.`);
        }
        out.line(`archived ${action.location}`);
        if (action.evidence !== undefined) out.line(`archived evidence ${evidenceCopy}`);
        break;
      }
      case 'already-archived':
        out.line(`already archived ${action.location}`);
        break;
      case 'remove-worktree': {
        checked = stopIfChanged(context, plan, copy, `the worktree ${action.folder}`);
        const error = removeLinkedWorktree(action.main, action.folder, action.force);
        if (error !== undefined) fail(`Could not remove the worktree ${action.folder}: ${error}\nThe ledger is archived; run ${ledgerCommand} task retire again once git can remove the worktree.`);
        out.line(`removed  ${action.folder}`);
        break;
      }
      case 'prune-worktrees': {
        const error = pruneWorktrees(action.main);
        if (error !== undefined) fail(`Could not prune the removed worktree ${action.folder}: ${error}\nThe ledger is archived; run ${ledgerCommand} task retire again once git -C ${shellWord(action.main)} worktree prune goes through.`);
        out.line(`pruned   ${action.folder}`);
        break;
      }
      case 'remove-active': {
        // The worktree is gone by now. A rerun finishes without --force only when the record names a host of this machine.
        const left = `The worktree is removed and the ledger archived, but the active ledger ${action.location} is left`;
        const remedy = `Retire it with ${ledgerCommand} task retire ${shellWord(plan.task.slug)} --force.`;
        let removed: boolean;
        try {
          removed = store.active.remove(action.repo, action.name, checked ?? stopIfChanged(context, plan, copy, `the active ledger ${action.location}`));
        } catch (error) {
          fail(`${left}: ${sentence(message(error))} ${remedy}`);
        }
        if (!removed) fail(`${left}: it changed after the archive copy ${copy.location} was written. ${remedy}`);
        out.line(`removed  ${action.location}`);
        break;
      }
      case 'remove-backlog': {
        const removal = `the backlog ledger ${action.location}`;
        const text = stopIfChanged(context, plan, copy, removal);
        let removed: boolean;
        try {
          removed = store.backlog.remove(action.repo, action.name, text);
        } catch (error) {
          fail(`Could not delete the backlog ledger ${action.location}: ${sentence(message(error))} Its archive copy is written. Fix the cause, then run ${ledgerCommand} task retire again.`);
        }
        if (!removed) stopBefore(removal, [`the ledger ${plan.task.file}`], copy);
        out.line(`removed  ${action.location}`);
        break;
      }
      case 'mark-parent':
        try {
          const marked = updateLedger(context, action.parent, (text) => {
            const line = parseLedger(text).children.find((child) => sameTask(lineRef(child, action.parentRef.main), action.child));
            return line === undefined || line.mark?.kind === 'retired' ? undefined : markRetired(text, line, today());
          });
          if (marked) out.line(`retired ${action.childName} in ${action.parent.file}`);
        } catch (error) {
          parentMarked = false;
          out.warn(`could not update ${action.parent.file} (${message(error)}); under ## Children, end the line - ${action.childName} with (retired ${today()}) by hand.`);
        }
        break;
      case 'copy-report':
        try {
          updateLedger(context, action.parent, (text) => putChildReport(text, action.heading, action.report));
          out.line(`copied the report of ${action.childName} to ${action.parent.file}`);
        } catch (error) {
          out.warn(`could not copy the report of ${action.childName} to ${action.parent.file}: ${message(error)}`);
        }
        break;
      case 'delete-branch': {
        const result = deleteBranchAt(action.main, action.branch, action.head);
        if (result === 'deleted') out.line(`deleted  branch ${action.branch}`);
        else if (result === 'moved') out.line(`kept     branch ${action.branch}, because it moved after retire checked it`);
        else if ('checkedOut' in result) out.line(`kept     branch ${action.branch}, because it is checked out in ${result.checkedOut}`);
        else out.line(`kept     branch ${action.branch}, because git could not delete it: ${result.error}`);
        break;
      }
      case 'keep-branch':
        out.line(`kept     branch ${action.branch}, because ${action.reason}`);
        break;
      case 'delete-build-folders': {
        const link = linkAboveBuildFolders(path.dirname(action.folders[0]));
        if (link !== undefined) {
          out.warn(`kept the build folders ${action.folders.join(', ')}: ${link} is a symbolic link.`);
          break;
        }
        try {
          deleteInBackground(action.folders, path.dirname(action.folders[0]));
          for (const folder of action.folders) out.line(`deleted  ${folder}`);
        } catch (error) {
          out.warn(`could not delete the build folders ${action.folders.join(', ')}: ${message(error)}`);
        }
        break;
      }
      case 'hint':
        if (parentMarked) out.line(action.text);
        break;
    }
  }
}

/**
 * A retire or its dry run. `steps` are the plan's steps as the dry run prints them; `done` the lines the retire printed.
 * `archive` is where the ledger is archived; `parent` the task its Location names; `hint` the advice to retire that
 * parent, which a retire gives only once the parent's line is marked.
 */
export type RetireResult = {
  slug: string;
  main: string;
  place: 'active' | 'backlog';
  ledger: string;
  dryRun: boolean;
  blocked: boolean;
  needsForce: boolean;
  blockers: { kind: Blocker['kind']; reason: string; forceable: boolean }[];
  steps: string[];
  warnings: string[];
  done: string[];
  archive?: string;
  worktree?: { folder: string; branch?: string; defaultBranch: string; ahead?: number; dirty: number; mergedPr: MergedPr; merged: boolean; openPr?: number };
  parent?: Ref;
  hint?: string;
};

/** The warning for the installed ledger links that land inside `folder`, which a deploy from that worktree made; undefined for none. */
function installedLinksWarning({ paths }: Context, { main, folder }: { main: string; folder: string }): string | undefined {
  const inside = `${realPath(folder)}${path.sep}`;
  const links = [path.join(paths.home, '.claude/bin/ledger'), path.join(paths.home, '.local/bin/ledger')].filter((link) => {
    try {
      return realpathSync(link).startsWith(inside);
    } catch {
      return false;
    }
  });
  if (links.length === 0) return undefined;
  const named = `${links.map(paths.tilde).join(' and ')} ${links.length === 1 ? 'points' : 'point'}`;
  return `${named} into ${folder}, which retire removes, so the installed ledger command breaks. Run deploy from the main checkout to relink it: cd ${shellWord(main)} && bin/deploy`;
}

/**
 * `ledger task retire [<slug>] [--dry-run] [--force]`. Exit 0 when retired or planned; exit 1, with nothing changed, when a
 * blocker stops it or the task cannot be found; exit 1 after the archive copy when the worktree cannot be removed.
 * Lines and warnings go to `out` as they happen, and are also in the result.
 */
export function retireTask(context: Context, slug: string | undefined, { dryRun, force }: { dryRun: boolean; force: boolean }, out: Output = consoleOutput): RetireResult {
  const facts = readRetire(context, slug);
  const plan = planRetire(facts, { force });
  const done: string[] = [];
  const warnings: string[] = [];
  const recorded: Output = {
    line: (text) => (done.push(text), out.line(text)),
    warn: (text) => (warnings.push(text), out.warn(text)),
  };
  const relink = plan.actions.flatMap((action) => (action.kind === 'remove-worktree' ? (installedLinksWarning(context, action) ?? []) : []));
  for (const warning of [...plan.warnings, ...relink]) recorded.warn(warning);
  if (!dryRun) {
    if (plan.blocked) fail(refusal(plan, force));
    executeRetire(context, plan, recorded);
  }
  const { task, worktree } = plan;
  const archive = plan.actions.flatMap((action) => (action.kind === 'archive' || action.kind === 'already-archived' ? [action.location] : [])).at(0);
  const hint = plan.actions.flatMap((action) => (action.kind === 'hint' && (dryRun || done.includes(action.text)) ? [action.text] : []))[0];
  const parent = task.ledger.location.parent;
  return {
    slug: task.slug,
    main: facts.ref.main,
    place: task.place === 'backlog' ? 'backlog' : 'active',
    ledger: task.file,
    dryRun,
    blocked: plan.blocked,
    needsForce: plan.blockers.some(isForceable),
    blockers: plan.blockers.map((blocker) => ({ kind: blocker.kind, reason: reasonOf(blocker), forceable: isForceable(blocker) })),
    steps: plan.actions.flatMap((action) => stepText(action) ?? []),
    warnings,
    done,
    ...(archive === undefined ? {} : { archive }),
    ...(worktree === undefined
      ? {}
      : {
          worktree: {
            folder: worktree.folder,
            ...(worktree.state.branch === undefined ? {} : { branch: worktree.state.branch }),
            defaultBranch: worktree.state.defaultBranch,
            ...(worktree.state.ahead === undefined ? {} : { ahead: worktree.state.ahead }),
            dirty: worktree.state.dirty,
            mergedPr: mergedPr(worktree.state),
            merged: isMerged(worktree.state),
            ...(worktree.state.openPr === undefined ? {} : { openPr: worktree.state.openPr }),
          },
        }),
    ...(parent === undefined ? {} : { parent: { slug: parent.slug, main: parent.main ?? facts.ref.main } }),
    ...(hint === undefined ? {} : { hint }),
  };
}

/** What `ledger task retire` prints on stdout once it is done; the lines of a retire went out as it ran. */
export const retireText = (result: RetireResult): string => (result.dryRun ? planView(result) : '');
