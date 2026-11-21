import { accessSync, constants, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { markRetired, putChildReport, withoutClaim } from './edit.js';
import { fail, Failure } from './failure.js';
import { folderEntries, isTaken, treeEntries } from './files.js';
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
  readWorktreeList,
  removeLinkedWorktree,
  worktrees,
} from './git.js';
import { ledgerBin, samePath, worktreeLedger } from './paths.js';
import { storedText } from './record.js';
import { loadTasks } from './registry.js';
import { repoKey } from './repo-key.js';
import { NameTaken, wasCreatedHere, type EvidenceState, type LedgerStore, type RemovedCopy } from './store.js';
import { findNamed, findTasks, inRepo, locateChild, namedChildren, onAnotherMachine, sameTask, type Task } from './tasks.js';
import { plural } from './views.js';
import { below, deleteInBackground, linkAboveBuildFolders, xcodeFolderOf } from './worktrees.js';
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
  /** An archive copy with the ledger's text, and how its evidence compares with the worktree's. */
  alreadyArchived?: { name: string; location: string; evidence: EvidenceState };
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
  | { kind: 'evidence'; name: string; copy: string; evidenceLocation: string; evidence: string }
  | EvidenceProblem;

const isForceable = ({ kind }: Blocker): boolean => kind === 'children' || kind === 'missing-child' || kind === 'dirty' || kind === 'unmerged';

export type RetireAction =
  | { kind: 'archive'; repo: string; name: string; location: string; evidenceLocation: string; text: string; evidence?: string }
  | { kind: 'already-archived'; repo: string; name: string; location: string }
  | { kind: 'remove-worktree'; main: string; folder: string; force: boolean }
  | { kind: 'remove-backlog'; repo: string; name: string; location: string }
  | { kind: 'mark-parent'; parent: Task; parentRef: Ref; child: Ref; childName: string }
  | { kind: 'copy-report'; parent: Task; parentRef: Ref; heading: string; report: readonly string[]; childName: string }
  | { kind: 'update-registry'; mains: string[] }
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
function parentActions({ task, ref, tasks }: RetireFacts, warnings: string[]): { actions: RetireAction[]; parentMain?: string } {
  const named = task.ledger.location.parent;
  if (named === undefined) return { actions: [] };
  const parentRef = { slug: named.slug, main: named.main ?? ref.main };
  const shown = linkFrom(ref.main, parentRef);
  const live = findNamed(tasks, parentRef).filter(({ place }) => place !== 'archive');
  if (live.length !== 1) {
    const found = live.length === 0 ? 'no live ledger' : `${live.length} ledgers (${live.map(({ file }) => file).join(', ')})`;
    warnings.push(`the parent ${shown} has ${found}, so no ## Children line is marked and the report is not copied.`);
    return { actions: [], parentMain: parentRef.main };
  }
  const [parent] = live;
  const childName = linkFrom(parentRef.main, ref);
  const actions: RetireAction[] = [];
  const line = parent.ledger.children.find((child) => sameTask(lineRef(child, parentRef.main), ref, task.place));
  if (line === undefined) warnings.push(`${childName} is not listed under ## Children of ${parentRef.slug} in ${parent.file}, so no line is marked retired.`);
  else if (line.mark?.kind !== 'retired') actions.push({ kind: 'mark-parent', parent, parentRef, child: ref, childName });
  const { report } = task.ledger;
  if (report.length === 0) warnings.push(`${task.file} has no report under ## Report, so none is copied to ${shown}.`);
  else actions.push({ kind: 'copy-report', parent, parentRef, heading: samePath(parentRef.main, ref.main) ? ref.slug : `${ref.slug}@${ref.main}`, report, childName });
  const siblingsActive = namedChildren(parent, tasks).some((child) => !sameTask(lineRef(child, parentRef.main), ref, task.place) && childStatus(tasks, child, parentRef) !== 'retired');
  if (line !== undefined && !siblingsActive) {
    const text = samePath(parentRef.main, ref.main)
      ? `Parent ${parentRef.slug} has no active children left. Retire it with /ledger:retire ${parentRef.slug}.`
      : `Parent ${parentRef.slug} @ ${parentRef.main} has no active children left. Retire it from a session in ${parentRef.main} with /ledger:retire ${parentRef.slug}.`;
    return { actions: [...actions, { kind: 'hint', text }], parentMain: parentRef.main };
  }
  return { actions, parentMain: parentRef.main };
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
    if (archived.evidence === 'differs') {
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
  actions.push(
    worktree === undefined
      ? { kind: 'remove-backlog', repo: task.repo, name: task.name, location: task.file }
      : { kind: 'remove-worktree', main: ref.main, folder: worktree.folder, force },
  );
  const parent = parentActions(facts, warnings);
  const hint = parent.actions.filter(({ kind }) => kind === 'hint');
  actions.push(...parent.actions.filter(({ kind }) => kind !== 'hint'));
  actions.push({ kind: 'update-registry', mains: [ref.main, ...(parent.parentMain === undefined ? [] : [parent.parentMain])] });
  const state = worktree?.state;
  if (state?.branch !== undefined) {
    actions.push(
      isMerged(state) && state.head !== undefined
        ? { kind: 'delete-branch', main: ref.main, branch: state.branch, head: state.head }
        : { kind: 'keep-branch', branch: state.branch, reason: keptReason(state) },
    );
  }
  if (worktree !== undefined && worktree.buildFolders.length > 0) actions.push({ kind: 'delete-build-folders', folders: worktree.buildFolders });
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
  const branch = currentBranch(folder);
  const head = commitOf(folder, 'HEAD');
  const defaultBranch = defaultBranchOf(main, warnings);
  const fetchError = fetchBranch(main, 'origin', defaultBranch);
  if (fetchError !== undefined) warnings.push(`git fetch origin ${defaultBranch} failed, so origin/${defaultBranch} may be out of date: ${fetchError}`);
  const ahead = commitsAhead(folder, `origin/${defaultBranch}`);
  if (ahead === undefined) warnings.push(`git could not count the commits ahead of origin/${defaultBranch}, so only a merged PR that ends at HEAD makes the branch merged.`);
  const changes = changedFiles(folder) ?? fail(`Could not read the state of ${folder}: git status failed.`);
  const prs = branch === undefined ? [] : mergedPrHeads(folder, branch);
  if ('error' in prs) warnings.push(`${prs.error}. Merged PRs are unknown, so only the commit count decides whether the branch is merged.`);
  const state: BranchState = {
    ...(branch === undefined ? {} : { branch }),
    ...(head === undefined ? {} : { head }),
    defaultBranch,
    ...(ahead === undefined ? {} : { ahead }),
    dirty: changes.length,
    ...('error' in prs ? {} : { mergedHeads: prs }),
  };
  if (branch === undefined || isMerged(state)) return state;
  const all = branchPrs(folder, branch);
  const open = 'error' in all ? undefined : all.find(({ state: prState }) => prState === 'OPEN');
  return open === undefined ? state : { ...state, openPr: open.number };
}

const NOTHING = 'Nothing was retired.';

/** The task: the ledger of the checkout that holds cwd, else the one titled `slug` in a worktree of this repo, else in its backlog. */
function findTarget(tasks: Task[], cwd: string, main: string, slug: string | undefined): Task {
  if (slug === undefined) {
    const root = checkoutRoot(cwd);
    const own = root === undefined ? undefined : tasks.find(({ place, file }) => place === 'worktree' && samePath(file, worktreeLedger(root)));
    return own ?? fail(`No task ledger in or above ${cwd}. Give a slug: ${ledgerCommand} task retire <slug>.`);
  }
  const named = findNamed(tasks, { slug, main });
  if (named.length === 1 && named[0].place === 'archive') fail(`${slug} is retired already: ${named[0].file}`);
  const live = named.filter(({ place }) => place !== 'archive');
  const inWorktrees = live.filter(({ place }) => place === 'worktree');
  const found = inWorktrees.length > 0 ? inWorktrees : live;
  if (found.length > 1) fail(`Several task ledgers are named "${slug}": ${found.map(({ file }) => file).join(', ')}. ${NOTHING} Give each task its own slug in its ledger's title.`);
  if (found.length === 0) {
    const known = tasks.filter((task) => task.place !== 'archive' && inRepo(task, main)).map((task) => task.slug);
    fail(`No task ledger is named "${slug}" in the repo at ${main}. ${NOTHING} Task ledgers: ${known.join(', ') || 'none'}.`);
  }
  if (found[0].place === 'remote') fail(`${onAnotherMachine(found[0])} ${NOTHING}`);
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
export function readRetire(context: Context, slug: string | undefined): RetireFacts {
  const { cwd, store } = context;
  const main = mainCheckout(cwd) ?? fail(`${cwd} is not inside a git repository. Run ${ledgerCommand} task retire in the repo of the task.`);
  const tasks = findTasks(store, [main]);
  const task = findTarget(tasks, cwd, main, slug);
  const warnings: string[] = [];
  let worktree: WorktreeFacts | undefined;
  let evidence: string | undefined;
  if (task.place === 'worktree') {
    const folder = path.dirname(path.dirname(task.file));
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
  return {
    task,
    ref: { slug: task.slug, main },
    text,
    ...(worktree === undefined ? {} : { worktree }),
    tasks,
    archiveRepo,
    archiveNameTaken: (name) => store.archive.nameTaken(archiveRepo, name),
    ...(identical === undefined ? {} : { alreadyArchived: { name: identical.name, location: identical.location, evidence: store.archive.evidenceState(archiveRepo, identical.name, evidence) } }),
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
    case 'remove-backlog':
      return `delete the backlog ledger ${action.location}`;
    case 'mark-parent':
      return `mark ${action.childName} retired under ## Children of ${action.parentRef.slug} in ${action.parent.file}`;
    case 'copy-report':
      return `copy the report to ## Child reports of ${action.parentRef.slug} in ${action.parent.file}`;
    case 'update-registry':
      return 'update the registry';
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
 * Stops the retire, before `removal` deletes the task, when the ledger or its evidence no longer matches the archive
 * copy: another session may have written to them since the copy was made, and that work would be lost. Returns the
 * text of the ledger, which the copy holds as a record.
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
    ...(archive.evidenceState(copy.repo, copy.name, evidence) === 'differs' ? [evidence === undefined ? 'the archived evidence' : `the evidence ${evidence}/`] : []),
  ];
  if (text === undefined || changed.length > 0) stopBefore(removal, changed, copy);
  return text;
}

function stopBefore(removal: string, changed: string[], copy: ArchiveCopy): never {
  return fail(`Stopped before removing ${removal}: ${changed.join(' and ')} changed after the archive copy ${copy.location} was written. Nothing was removed. Run ${ledgerCommand} task retire again.`);
}

/**
 * Carries out the plan in its order. A failure before the worktree or backlog ledger is removed stops the retire; after
 * that, the task is gone, so a rerun could not finish what a stop would skip, and each later step only warns. A worktree
 * that git removed only in part counts as gone: the retire goes on, then fails naming the folder left over. A store
 * that commits does so once for all of it, so no sync or mirror meanwhile pushes the archive copy while the active copy
 * is still there; a stop undoes the retire there before that commit, so the task stays active with no archive copy.
 * Another store keeps the archive copy of a stop, and a rerun goes on from it.
 */
export function executeRetire(context: Context, plan: RetirePlan, out: Output = consoleOutput): void {
  const carryOut = (): void => {
    const copy = removeCopy(context.store, plan);
    const undo: Undo = { archive: context.store.inOneCommit !== undefined, taskRemoved: false };
    try {
      carryOutRetire(context, plan, out, undo);
    } catch (error) {
      if (undo.taskRemoved) throw error;
      undoRetire(context, plan, undo, copy, error);
    }
  };
  if (context.store.inOneCommit === undefined) carryOut();
  else context.store.inOneCommit(carryOut);
}

/**
 * Removes this machine's copy of a worktree task first, while a failure still leaves everything as it was: the commit
 * must never hold the archive copy without this removal.
 */
function removeCopy({ active }: LedgerStore, plan: RetirePlan): RemovedCopy | undefined {
  if (active === undefined || !plan.actions.some((action) => action.kind === 'remove-worktree')) return undefined;
  try {
    return active.remove(plan.task.repo, plan.task.slug);
  } catch (error) {
    const fix = active.host === undefined ? 'Fix "host" first' : 'Fix the cause';
    return fail(`Could not remove the copy of ${plan.task.slug} from git storage: ${sentence(message(error))} Nothing was archived or removed. ${fix}, then run ${ledgerCommand} task retire again.`);
  }
}

/**
 * Whether a stopped retire removes the archive copy it wrote; `written` is that copy, once this retire created any of
 * it. Once `taskRemoved`, the worktree or backlog ledger is gone, and nothing is undone.
 */
type Undo = { archive: boolean; written?: ArchiveCopy; taskRemoved: boolean };

/**
 * After a retire failed with `cause` while the task is still there: removes the archive copy and its evidence, which
 * this retire wrote, where `undo` says so, and puts back the copy that it removed from git storage, all before the
 * store commits. Then fails with `cause` and how the undo went.
 */
function undoRetire({ store }: Context, plan: RetirePlan, undo: Undo, copy: RemovedCopy | undefined, cause: unknown): never {
  const problems: string[] = [];
  const archived = undo.written;
  if (undo.archive && archived !== undefined && store.archive.nameTaken(archived.repo, archived.name)) {
    try {
      store.archive.remove(archived.repo, archived.name);
    } catch (error) {
      problems.push(
        `Could not remove the archive copy ${archived.location} that it wrote either: ${sentence(message(error))} This retire does not commit it. Remove it and its evidence by hand, before a sync commits it and before ${ledgerCommand} task retire runs again.`,
      );
    }
  }
  try {
    copy?.putBack();
  } catch (error) {
    problems.push(
      `Could not put the copy of ${plan.task.slug} back in git storage either: ${sentence(message(error))} This retire commits neither the copy nor its removal. Run ledger store mirror before the next sync; it copies each worktree ledger again.`,
    );
  }
  if (problems.length > 0) fail([message(cause), ...problems].join('\n'));
  if (!undo.archive) throw cause;
  fail(`${message(cause)}\nNothing was archived.`);
}

function carryOutRetire(context: Context, plan: RetirePlan, out: Output, undo: Undo): void {
  const { store } = context;
  const [copy] = plan.actions.flatMap((action): ArchiveCopy[] =>
    action.kind === 'archive' || action.kind === 'already-archived' ? [{ repo: action.repo, name: action.name, location: action.location }] : [],
  );
  let parentMarked = true;
  let leftover: Leftover | undefined;
  const keepBranch = (branch: string, because: string): void => {
    out.line(`kept     branch ${branch}, because ${because}`);
    if (leftover === undefined) return;
    leftover.keptBranch = branch;
    // A --json retire that fails on the leftover drops every line; its warnings are what it still reports.
    out.warn(`kept the branch ${branch}, because ${because}.`);
  };
  for (const action of plan.actions) {
    try {
      switch (action.kind) {
        case 'archive': {
          const evidenceCopy = `${action.evidenceLocation}/`;
          const archived = { repo: action.repo, name: action.name, location: action.location };
          try {
            store.archive.write(action.repo, action.name, action.text, action.evidence);
            undo.written = archived;
            if (store.archive.read(action.repo, action.name)?.text !== storedText(action.text)) fail(`the archive copy does not match the ledger`);
          } catch (error) {
            // Only a copy this retire created is its own to remove: another command may have taken the name meanwhile.
            if (!(error instanceof NameTaken) && wasCreatedHere(store.archive.location(action.repo, action.name))) undo.written = archived;
            const copies = action.evidence === undefined ? `The ledger copy ${action.location} may exist` : `The ledger copy ${action.location} and the evidence copy ${evidenceCopy} may exist`;
            const left = undo.archive ? '' : ` ${copies} already.`;
            fail(`Could not archive ${plan.task.slug}: ${sentence(message(error))}${left} Fix the cause, then run ${ledgerCommand} task retire again.`);
          }
          out.line(`archived ${action.location}`);
          if (action.evidence !== undefined) out.line(`archived evidence ${evidenceCopy}`);
          break;
        }
        case 'already-archived':
          out.line(`already archived ${action.location}`);
          break;
        case 'remove-worktree': {
          stopIfChanged(context, plan, copy, `the worktree ${action.folder}`);
          const evidence = evidenceBefore(action.folder);
          const error = removeLinkedWorktree(action.main, action.folder, action.force);
          if (error === undefined) {
            undo.taskRemoved = true;
            out.line(`removed  ${action.folder}`);
            break;
          }
          if (deletedBeforeFailing(action.folder, evidence)) {
            undo.taskRemoved = true;
            const ledger = deleteLeftoverLedger(store, copy, action.folder, out);
            leftover = { main: action.main, folder: action.folder, error, ...(ledger === undefined ? {} : { ledger }) };
            break;
          }
          // A store that undoes the retire says whether the archive copy is gone once it tried.
          const again = `${ledgerCommand} task retire again once git can remove the worktree.`;
          fail(`Could not remove the worktree ${action.folder}: ${error}\n${undo.archive ? `Run ${again}` : `The ledger is archived; run ${again}`}`);
        }
        case 'remove-backlog': {
          const removal = `the backlog ledger ${action.location}`;
          const text = stopIfChanged(context, plan, copy, removal);
          let removed: boolean;
          try {
            removed = store.backlog.remove(action.repo, action.name, text);
          } catch (error) {
            const archive = undo.archive ? '' : ' Its archive copy is written.';
            fail(`Could not delete the backlog ledger ${action.location}: ${sentence(message(error))}${archive} Fix the cause, then run ${ledgerCommand} task retire again.`);
          }
          if (!removed) stopBefore(removal, [`the ledger ${plan.task.file}`], copy);
          undo.taskRemoved = true;
          out.line(`removed  ${action.location}`);
          break;
        }
        case 'mark-parent':
          try {
            const marked = updateLedger(context, action.parent, (text) => {
              const line = parseLedger(text).children.find((child) => sameTask(lineRef(child, action.parentRef.main), action.child, plan.task.place));
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
        case 'update-registry':
          try {
            loadTasks(context, action.mains);
          } catch (error) {
            out.warn(`the registry is not updated: ${message(error)}`);
          }
          break;
        case 'delete-branch': {
          // With a worktree left over, a list git cannot give must not pass for one where no worktree has the branch.
          const listed = leftover === undefined ? worktrees(action.main) : readWorktreeList(action.main);
          const user = listed?.find(({ branch }) => branch === action.branch);
          if (listed === undefined || user !== undefined) {
            const because = user === undefined ? 'the worktree list could not be read, and the worktree left over may still have it checked out' : `the worktree ${user.path} still has it checked out`;
            keepBranch(action.branch, because);
            break;
          }
          const result = deleteBranchAt(action.main, action.branch, action.head);
          if (result === 'deleted') out.line(`deleted  branch ${action.branch}`);
          else if (result === 'moved') keepBranch(action.branch, 'it moved after retire checked it');
          else keepBranch(action.branch, `git could not delete it: ${result.error}`);
          break;
        }
        case 'keep-branch':
          keepBranch(action.branch, action.reason);
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
    } catch (error) {
      if (leftover === undefined) throw error;
      const [step = action.kind] = [stepText(action) ?? []].flat();
      out.warn(`could not ${step}: ${message(error)}`);
    }
  }
  if (leftover !== undefined) throw new PartlyRemoved(leftoverError(leftover));
}

/** The failure of a retire that went on after git removed the worktree only in part: the task is retired, its worktree is not gone. */
export class PartlyRemoved extends Failure {}

/**
 * A worktree that git removed only in part before it failed with `error`; `ledger` is its ledger, when the retire could
 * not delete that; `keptBranch` the branch it kept, for any reason.
 */
type Leftover = { main: string; folder: string; error: string; ledger?: string; keptBranch?: string };

function leftoverError({ main, folder, error, ledger, keptBranch }: Leftover): string {
  const failed = `Could not remove the worktree ${folder}: ${error}`;
  const kept = ledger === undefined ? '' : `\nThe retire did not delete the worktree ledger ${ledger}; while it is there, the registry lists the task as active again.`;
  if (isGone(folder)) {
    const branch = keptBranch === undefined ? '' : ` The retire kept the branch ${keptBranch}; delete it after the prune.`;
    return `${failed}\nGit deleted the folder before it failed, and the retire went on. Run git -C ${shellWord(main)} worktree prune so git forgets the worktree.${branch}${kept}`;
  }
  return `${failed}\nThe retire went on, as git may have deleted the ledger or its evidence before it failed, but the worktree folder ${folder} remains. Remove it by hand.${kept}`;
}

const isGone = (file: string): boolean => {
  try {
    return !isTaken(file);
  } catch {
    return false;
  }
};

const evidenceOf = (worktree: string): string => path.join(worktree, '.claude', 'evidence');

/**
 * The evidence folder of the worktree and every file and link in it, before git removes any; none when it holds none.
 * A folder alone is no evidence: an empty one git deleted lost nothing. Stops the retire when the folder cannot be
 * read, as a removal that fails part way could then not be judged.
 */
function evidenceBefore(worktree: string): string[] {
  const evidence = evidenceOf(worktree);
  try {
    if (!isTaken(evidence)) return [];
    const files = treeEntries(evidence).flatMap((entry) => (entry.isDirectory() ? [] : [path.join(entry.parentPath, entry.name)]));
    return files.length === 0 ? [] : [evidence, ...files];
  } catch (error) {
    return fail(`Stopped before removing the worktree ${worktree}: could not read its evidence ${evidence}/: ${sentence(message(error))} Nothing was removed. Fix the cause, then run ${ledgerCommand} task retire again.`);
  }
}

/**
 * Whether git deleted the worktree ledger, or any of the `evidence` the worktree had, before it failed: the archive then
 * holds their only copy, so the task counts as removed. A check that fails counts so too, as an archive copy left over
 * can be removed by hand, while evidence an undo deleted is lost.
 */
function deletedBeforeFailing(worktree: string, evidence: string[]): boolean {
  try {
    return !isTaken(worktreeLedger(worktree)) || evidence.some((entry) => !isTaken(entry));
  } catch {
    return true;
  }
}

/**
 * Deletes the ledger of a worktree that git removed only in part, when it is byte for byte the archive copy: left there,
 * the registry would list the task as active again, and the next mirror would copy it back. Returns the ledger when it
 * stays.
 */
function deleteLeftoverLedger(store: LedgerStore, copy: ArchiveCopy, worktree: string, out: Output): string | undefined {
  const ledger = worktreeLedger(worktree);
  try {
    if (!isTaken(ledger)) return undefined;
    const archived = store.archive.readBytes(copy.repo, copy.name);
    if (archived === undefined || !readFileSync(ledger).equals(archived)) {
      out.warn(`kept the worktree ledger ${ledger}: it is not the same as the archive copy ${copy.location}.`);
      return ledger;
    }
    rmSync(ledger);
  } catch (error) {
    out.warn(`the worktree ledger ${ledger} may remain: ${message(error)}`);
    return ledger;
  }
  out.line(`deleted  ${ledger}`);
  return undefined;
}

/**
 * A retire or its dry run. `steps` are the plan's steps as the dry run prints them; `done` the lines the retire printed.
 * `archive` is where the ledger is archived; `parent` the task its Location names; `hint` the advice to retire that
 * parent, which a retire gives only once the parent's line is marked.
 */
export type RetireResult = {
  slug: string;
  main: string;
  place: 'worktree' | 'backlog';
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
  for (const warning of plan.warnings) recorded.warn(warning);
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
    place: worktree === undefined ? 'backlog' : 'worktree',
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
