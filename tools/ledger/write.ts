import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { claimLedger, refuseIfHeld } from './claims.js';
import {
  addChild,
  addDecision,
  addLocationBullet,
  clearStatus,
  fillLedger,
  markStarted,
  placeChildren,
  removeChildren,
  removeLine,
  setLocationBullet,
  setStatus,
  unpark,
  withChildMain,
  withDesignRefsBullet,
  withoutClaim,
} from './edit.js';
import { fail, Failure } from './failure.js';
import { exists, isFolder, readText, writeAtomic } from './files.js';
import { installPackages } from './install.js';
import { findSection, isNewSlug, isReadableSlug, isRepoKeyShape, parseDependencies, parseLedger, showDependencies, type Child, type ChildMark, type Claim, type Dependency, type Location, type Status, type StatusValue, type TaskRef } from './format.js';
import {
  addWorktree,
  branchExists,
  checkoutRoot,
  commitOf,
  commonDir,
  currentBranch,
  gitDir,
  isBranchName,
  mainCheckout,
  originHead,
  prState,
  removeWorktree,
  shortCommit,
} from './git.js';
import { withLock } from './lock.js';
import { samePath, taskWorktree, type LedgerPaths } from './paths.js';
import { withHint } from './migrate-repo-ids.js';
import { hasStage, isKind, KINDS, type Kind } from './kinds.js';
import { parseRecord, storedText } from './record.js';
import { remoteKey, repoKey } from './repo-key.js';
import { runClock, runConsole } from './run-io.js';
import { holdsUnmovedLedger } from './unmoved.js';
import { hostProblem, noteOwnHost } from './settings.js';
import { checkPrLink, checkTransition, stateOf } from './states.js';
import { keyAndAliases, type Change, type LedgerStore } from './store.js';
import { pauseForTest } from './wait.js';
import {
  activeTask,
  childrenOf,
  dependenciesOf,
  dependencyTask,
  findTasks,
  findNamed,
  inRepo,
  isDone,
  listedChildren,
  locateChild,
  namedChildren,
  notASlug,
  notOnThisMachine,
  orderedChildren,
  sameTask,
  taskRef,
  theTask,
  wasChildOf,
  type ChildStatus,
  type ListedChild,
  type Place,
  type Task,
} from './tasks.js';

type Ref = Required<TaskRef>;
export type Context = { paths: LedgerPaths; cwd: string; store: LedgerStore };

export function readLedger({ store }: Context, task: Task): string {
  return (store[task.place].read(task.repo, task.name) ?? fail(`The ledger ${task.file} is gone.`)).text;
}

/** Rewrites a live ledger with `change` of its text as it is now, which may differ from the text in `task`. True when it was written. */
export function updateLedger(context: Context, task: Task, change: Change<string>): boolean {
  if (task.place === 'archive') throw new Error(`An archive copy is never changed: ${task.file}`);
  if (task.elsewhere) fail(notOnThisMachine(task));
  return task.place === 'active' ? updateActive(context, task, change) : context.store.backlog.update(task.repo, task.name, change);
}

/** Adds the host label this machine stamps on records to its own, so they stay its own after "host" changes. */
function noteStamped({ store, paths }: Context): void {
  if (store.host !== undefined) noteOwnHost(paths.home, store.host);
}

/**
 * Rewrites the active record `name` of `repo` with `change`, as Active.update does. A record that names a label this
 * machine stamped before "host" changed names its host now, so other machines see whose task it is. A record that
 * names another machine is refused as the record lock reads it, as a pull may have put one there since it was looked up.
 */
export function updateActive(context: Context, { repo, name }: { repo: string; name: string }, change: Change<string>): boolean {
  const { host, ownHosts } = context.store;
  let restamped = false;
  const written = context.store.active.update(repo, name, (text) => {
    const refused = otherMachineRecord(context.store, name, text);
    if (refused !== undefined) fail(refused);
    const changed = change(text);
    if (changed === undefined || host === undefined) return changed;
    const named = parseLedger(changed).location.host;
    restamped = named !== undefined && named !== host && (ownHosts?.has(named) ?? false);
    return restamped ? (setLocationBullet(changed, 'host', host) ?? changed) : changed;
  });
  if (restamped) noteStamped(context);
  return written;
}

/** Why updateActive refuses the active record `name` with `text`: it names a host that is none of this machine's. */
export function otherMachineRecord({ host, ownHosts }: LedgerStore, name: string, text: string): string | undefined {
  const { host: owner, worktree } = parseLedger(text).location;
  const others = owner !== undefined && host !== undefined && owner !== host && !(ownHosts?.has(owner) ?? false);
  return others ? notOnThisMachine({ slug: name, worktree, host: owner }) : undefined;
}

/** Why a slug an active task has names no other task: a slug is one task in every clone of a repo, as in the backlog. */
export const takenText = (slug: string, worktree: string | undefined, location: string): string =>
  `The task ${slug} is active already, in the worktree ${worktree ?? 'its ledger names'}, so no other task can take its name: ${location}`;

/** The local date, as the old scripts wrote it. */
export const today = (): string => runClock().today();

const oneLine = (text: string): string => text.trim().split(/\s+/).join(' ');

/** `text` as one shell word: unchanged when no character needs quoting, else in single quotes. */
export const shellWord = (text: string): string => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`);

/**
 * The command that prints the question of `gate` for `task`, as `<slug>@<main>` when it is not a task of `repo`, the
 * session's, so it names that repo's task; the slug alone when the store knows no main checkout of its repo. A slug that
 * starts with `-` follows `--`, or the CLI would read it as an option.
 */
export function gateCommand(gate: string, task: Task, repo: string): string {
  const { slug, main } = task;
  const ref = task.repoKeys.includes(repo) || main === undefined ? slug : shellWord(`${slug}@${main}`);
  return `ledger task gate ${gate} ${slug.startsWith('-') ? `-- ${ref}` : ref}`;
}

const slugRule = (slug: string): string =>
  `"${slug}" cannot name a new task. A new slug starts with a lowercase letter or digit and has only lowercase letters, digits and hyphens.`;

function repoOf(cwd: string, folder = cwd): string {
  return mainCheckout(folder) ?? fail(`${folder} is not inside a git repository.`);
}

/** `<slug>` when the task is in the repo of `cwd`, else `<slug>@<main>`, the form every command takes. */
function nameFrom(cwd: string) {
  const here = mainCheckout(cwd);
  return ({ slug, main }: Ref): string => (here !== undefined && samePath(here, main) ? slug : `${slug}@${main}`);
}

/** How the ledger of a task in `fromMain` names `ref` in a line: `<slug>`, or `<slug> @ <main>` in another repo. */
const linkFrom = (fromMain: string, ref: Ref): string => (samePath(fromMain, ref.main) ? ref.slug : `${ref.slug} @ ${ref.main}`);

/** The active task this command runs in: the one of the linked worktree that holds `cwd`. A main checkout has none. */
export function currentTask(store: LedgerStore, cwd: string): Task | undefined {
  const root = checkoutRoot(cwd);
  const main = mainCheckout(cwd);
  if (root === undefined || main === undefined || samePath(root, main)) return undefined;
  return activeTask(store, root);
}

/** The ledger template; with `refs`, it holds a `- design refs:` bullet for fillLedger to fill. */
function readTemplate(paths: LedgerPaths, refs: string | undefined): string {
  const file = path.join(paths.home, '.claude', 'ledger.template.md');
  let text: string;
  try {
    text = readText(file);
  } catch {
    return fail(`No ledger template at ${paths.tilde(file)}. Run ledger deploy to install it.`);
  }
  if (refs === undefined) return text;
  return withDesignRefsBullet(text) ?? fail(`--design-refs needs a ## Location section for its - design refs: line, and the template ${paths.tilde(file)} has none. Add the section, or leave out --design-refs.`);
}

/** The design refs a task names; else a repo with an llp/ folder records `none`, and any other repo no line. */
const designRefs = (root: string, named?: string): string | null => named ?? (isFolder(path.join(root, 'llp')) ? 'none' : null);

function checkTarget(main: string, slug: string, branch: string): void {
  if (!isBranchName(main, branch)) fail(`${branch} is not a valid branch name.`);
  if (branchExists(main, branch)) fail(`The branch ${branch} already exists in ${main}.`);
  const folder = taskWorktree(main, slug);
  if (exists(folder)) fail(`The folder ${folder} already exists.`);
}

/** info/exclude is shared by every worktree of the repo and never committed. */
function excludeEvidence(main: string): void {
  const common = commonDir(main);
  if (common === undefined) return;
  const exclude = path.join(common, 'info', 'exclude');
  const current = exists(exclude) ? readText(exclude) : '';
  if (current.split('\n').includes('.claude/evidence/')) return;
  try {
    writeAtomic(exclude, `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}.claude/evidence/\n`);
  } catch {
    runConsole().error(`warning: .claude/evidence/ was not added to ${exclude}`);
  }
}

const short = (folder: string, commit: string): string => shortCommit(folder, commit) ?? commit.slice(0, 7);

type Started = { worktree: string; branch: string; base: string; ledger: string };

const startedLines = ({ worktree, branch, base, ledger }: Started): string[] => [`worktree ${worktree}`, `branch   ${branch}`, `base     ${base}`, `ledger   ${ledger}`];

/** A new task: a backlog ledger, or, with --stack or --here, a worktree. `noted` is the ledger that got a Decisions line. */
export type CreatedTask = { slug: string; main: string; status: 'backlog' | 'active'; ledger: string; worktree?: string; branch?: string; base?: string; noted?: string; start?: string };

export function createdText({ status, ledger, worktree, branch, base, noted, start }: CreatedTask): string {
  const lines = worktree === undefined || branch === undefined || base === undefined ? [`ledger:  ${ledger}`, `status:  ${status}`] : startedLines({ worktree, branch, base, ledger });
  if (noted !== undefined) lines.push(`${worktree === undefined ? 'noted:  ' : 'noted   '} ${noted}`);
  if (start !== undefined) lines.push(`start:   ${start}`);
  return lines.join('\n');
}

/** Fails when an active task of the repo at `main` has `slug`, under the repo's key or an old one, naming its worktree. */
function refuseActive(store: LedgerStore, main: string, slug: string, repos = keyAndAliases(store.aliases.read(), repoKey(main))): void {
  for (const repo of repos) {
    const found = store.active.read(repo, slug);
    if (found !== undefined) fail(takenText(slug, parseLedger(found.text).location.worktree, found.location));
  }
}

/** Fails when the backlog of the repo key `key` has `slug`, under that key or an old one. */
function refuseBacklog({ store, paths }: Context, key: string, slug: string): void {
  const filedUnder = keyAndAliases(store.aliases.read(), key).find((repo) => store.backlog.has(repo, slug));
  if (filedUnder !== undefined) fail(`A backlog task ${slug} already exists: ${paths.tilde(store.backlog.location(filedUnder, slug))}`);
}

/** `markdown`, a new active ledger, naming this machine's host, which tells other machines whose task it is. */
const onThisHost = ({ host }: LedgerStore, markdown: string): string => (host === undefined ? markdown : (setLocationBullet(markdown, 'host', host) ?? markdown));

/**
 * Writes the active record of a new task, filed under the key of the repo at `main`. It fails, writing nothing, when the
 * slug is taken, and when `text` names no host or no worktree: lookup finds a record by its worktree, and other machines
 * tell whose task it is by its host.
 */
function createActive({ store, paths }: Context, main: string, slug: string, text: string): string {
  const ledger = parseLedger(text);
  const { host, worktree } = ledger.location;
  if (findSection(ledger.sections, 'Location') === undefined) fail(`The ledger of ${slug} has no ## Location section to name its host and worktree, so ${slug} was not made. Add a ## Location section to the template for a new task, then try again.`);
  if (host === undefined) fail(`${hostProblem(paths.home) ?? 'This machine has no host label.'} An active record must name its host, so ${slug} was not made.`);
  if (worktree === undefined) fail(`The ledger of ${slug} has no "- worktree:" line under ## Location to name its worktree, so ${slug} was not made. Add "- worktree: <path>" there, or to the template for a new task, then try again.`);
  const repo = repoKey(main);
  refuseActive(store, main, slug);
  const location = store.active.location(repo, slug);
  if (!store.active.create(repo, slug, text)) {
    // Another command took the slug since the check.
    refuseActive(store, main, slug, [repo]);
    fail(`Another command wrote ${location} while ${slug} was being made. Nothing was made. Try again.`);
  }
  return location;
}

/**
 * A new branch at `base` in the worktree <main>/.claude/worktrees/<slug>, with the active record `ledgerText` makes from
 * the Location values. `moved` runs once the record is written; a throw there removes the record again. Any failure
 * removes the worktree and branch again.
 */
function startWorktree(context: Context, main: string, slug: string, branch: string, base: string, ledgerText: (started: Omit<Started, 'ledger'>) => string, moved = (): void => {}): Started {
  const { store } = context;
  const commit = commitOf(main, base) ?? fail(`${base} names no commit in ${main}.`);
  checkTarget(main, slug, branch);
  const worktree = taskWorktree(main, slug);
  const error = addWorktree(main, worktree, branch, commit);
  if (error !== undefined) fail(`Could not make the worktree ${worktree}: ${error}`);
  const location = { worktree, branch, base: `${base} @ ${short(main, commit)}` };
  let started: Started;
  try {
    const text = onThisHost(store, ledgerText(location));
    started = { ...location, ledger: createActive(context, main, slug, text) };
    try {
      moved();
    } catch (error) {
      store.active.remove(repoKey(main), slug, storedText(text));
      throw error;
    }
  } catch (error) {
    removeWorktree(main, worktree, branch);
    throw error;
  }
  noteStamped(context);
  excludeEvidence(main);
  return started;
}

export type TaskOptions = { goal?: string; designRefs?: string; kind?: string; stack?: boolean; here?: boolean; repo?: string };

export function createTask(context: Context, slug: string | undefined, { goal: rawGoal, designRefs: refs, kind = 'code', stack = false, here = false, repo }: TaskOptions): CreatedTask {
  const { paths, cwd, store } = context;
  if (here && stack) fail('--here adds a ledger to this worktree, so it takes no --stack.');
  if (here && repo !== undefined) fail('--here adds a ledger to this worktree, so it takes no --repo.');
  if (stack && repo !== undefined) fail('--stack builds on the current branch, so it takes no --repo.');
  if (slug !== undefined && !isNewSlug(slug)) fail(slugRule(slug));
  if (refs !== undefined && !/^\d+(?:,\d+)*$/.test(refs)) fail(`--design-refs takes LLP numbers, comma-separated, such as 3,12. "${refs}" is not.`);
  if (!isKind(kind)) fail(`--kind takes one of ${KINDS}. "${kind}" is not.`);
  const goal = rawGoal === undefined || oneLine(rawGoal) === '' ? undefined : oneLine(rawGoal);
  if (here) return hereTask(context, slug, goal, refs, kind);
  if (slug === undefined) return fail('ledger task new needs a slug, or --here for this worktree.');

  const main = repoOf(cwd, repo === undefined ? cwd : path.resolve(cwd, repo));
  const template = readTemplate(paths, refs);
  const key = repoKey(main);
  const backlog = store.backlog.location(key, slug);
  const taken = (): never => fail(`A backlog task ${slug} already exists: ${paths.tilde(backlog)}`);
  refuseBacklog(context, key, slug);
  refuseActive(store, main, slug);
  const current = currentTask(store, cwd);
  let created: CreatedTask;
  if (stack) {
    const base = currentBranch(cwd) ?? fail(`--stack needs a branch, but HEAD is detached in ${cwd}.`);
    const root = checkoutRoot(cwd) ?? cwd;
    const started = startWorktree(context, main, slug, slug, base, (filled) => fillLedger(template, { slug, goal, ...filled, designRefs: designRefs(root, refs), kind }));
    created = { slug, main, status: 'active', ...started };
  } else {
    checkTarget(main, slug, slug);
    pauseForTest();
    if (!store.backlog.create(key, slug, fillLedger(template, { slug, goal, main, designRefs: designRefs(main, refs), kind }))) taken();
    created = { slug, main, status: 'backlog', ledger: backlog };
  }
  const cwdMain = mainCheckout(cwd);
  const [named, start] = cwdMain !== undefined && samePath(cwdMain, main) ? [slug, `/ledger:go ${slug}`] : [`${slug} in ${main}`, `ledger go ${slug} --repo ${shellWord(main)}`];
  if (current !== undefined) {
    updateLedger(context, current, (text) => addDecision(text, `- New task ${named}: separate work, not part of this goal. ${start} starts it.`));
    created.noted = current.file;
  }
  return { ...created, start };
}

function hereTask(context: Context, given: string | undefined, goal: string | undefined, refs: string | undefined, kind: Kind): CreatedTask {
  const { paths, cwd, store } = context;
  const main = repoOf(cwd);
  const worktree = checkoutRoot(cwd) ?? fail(`${cwd} is not inside a git repository.`);
  if (samePath(worktree, main)) fail(`--here needs a linked worktree, and ${cwd} is in the main checkout. A ledger lives only in a linked worktree.`);
  const admin = gitDir(worktree) ?? fail(`git names no git folder for ${worktree}.`);
  // In the worktree's own git folder, so two commands that make a task for one worktree check and write one at a time.
  const { slug, ...started } = withLock(path.join(admin, 'ledger-task'), (): Started & { slug: string } => {
    const own = store.active.byWorktree(worktree);
    if (own !== undefined) fail(`This worktree already has a ledger: ${store.active.location(own.repo, own.slug)}`);
    if (holdsUnmovedLedger(store, worktree)) {
      fail(`This worktree already has a ledger in ${path.join(worktree, '.claude', 'ledger.md')}, not yet moved into the ledger store. Move it with ledger store migrate --active.`);
    }
    const branch = currentBranch(cwd);
    const slug = given ?? (branch?.split('/').at(-1) || path.basename(worktree));
    if (!isNewSlug(slug)) fail(`${slugRule(slug)} Name it: ledger task new --here <slug>`);
    refuseBacklog(context, repoKey(main), slug);
    const commit = commitOf(cwd, 'HEAD') ?? fail(`This worktree has no commit yet: ${worktree}`);
    const location = { worktree, branch: branch ?? 'detached HEAD', base: `HEAD @ ${short(cwd, commit)}` };
    return { slug, ...location, ledger: createActive(context, main, slug, onThisHost(store, fillLedger(readTemplate(paths, refs), { slug, goal, ...location, designRefs: designRefs(worktree, refs), kind }))) };
  });
  noteStamped(context);
  excludeEvidence(main);
  return { slug, main, status: 'active', ...started };
}

/**
 * Starts the backlog task `slug` of the repo at `main`, filed under `repo`: the repo's key, or an old key that is an alias
 * of it. Exit codes: 2 no backlog task, 3 a task of another repo, 4 a ledger that names no repo.
 */
function promote(context: Context, slug: string, main: string, repo: string): Started {
  const { store } = context;
  const backlog = store.backlog.read(repo, slug) ?? fail(withHint(store, `No backlog task ${slug} for the repo at ${main}.`), 2);
  const { text } = backlog;
  const { location } = parseLedger(text);
  // Filed under this repo's key, so it is a task of this repo, also when its main line names another clone of it.
  location.mainLine ?? fail(`The backlog ledger ${backlog.location} has no "- main:" line, so its repo is unknown.`, 4);
  const base = location.base?.ref ?? originHead(main) ?? currentBranch(main) ?? fail(`${main} has no origin/HEAD and a detached HEAD, so there is no branch to start from.`);
  const started = startWorktree(
    context,
    main,
    slug,
    location.branch ?? slug,
    base,
    ({ worktree, branch, base: from }) => fillLedger(text, { slug, worktree, branch, base: from }),
    () => {
      // A throw here makes startWorktree remove the new active record, worktree and branch, so the task stays one backlog ledger.
      if (!store.backlog.remove(backlog.repo, backlog.name, text)) {
        fail(`Another command changed the backlog ledger ${backlog.location} while ${slug} was being started. Nothing was started. Run ledger go ${slug} again.`);
      }
    },
  );
  return started;
}

/**
 * What `ledger go` did. `chain` runs from the named task down to the child it started instead, empty when it started the
 * named task itself. `parent` is the started task's parent and `children` its own child tasks. `marked` is the parent
 * that now marks the task started; `unparked` the parked status it removed. `installed` is the install command it ran.
 * `tookOverFrom` is the live claim of another session it took over; `unclaimed` says why the session given was not claimed.
 */
export type GoResult = {
  slug: string;
  main: string;
  ledger: string;
  worktree: string;
  branch?: string;
  base?: string;
  promoted: boolean;
  chain: Ref[];
  parent?: Ref;
  children: { slug: string; main: string; status: ChildStatus }[];
  unparked?: { date: string; reason: string };
  marked?: { parent: Ref; ledger: string };
  installed?: string;
  tookOverFrom?: Claim;
  unclaimed?: string;
  warnings: string[];
};

/**
 * Why no live ledger of this repo has the slug of `ref`, with the exit codes of promote: 3 for a task of another repo,
 * 1 for a retired task or a worktree folder in the way, else 2, as /ledger:go makes a new task only on 2.
 */
function refuseMissing(store: LedgerStore, tasks: Task[], { slug, main }: Ref): never {
  // A ledger that names this checkout but is filed under another key, an old folder name or the origin this path had, is
  // no task of another checkout: --repo would lead back here.
  const namesThis = (task: Task): boolean => task.main !== undefined && samePath(task.main, main);
  const elsewhere = tasks.find((task) => task.slug === slug && task.place !== 'archive' && !inRepo(task, main) && !namesThis(task));
  if (elsewhere !== undefined) {
    const owner = elsewhere.main ?? `named ${elsewhere.repo}`;
    const start = elsewhere.main === undefined ? '' : ` Run: ledger go ${slug} --repo ${shellWord(elsewhere.main)}`;
    fail(withHint(store, `No task ${slug} in the repo at ${main}: it is a task of the repo at ${owner}.${start}`), 3);
  }
  const archived = findNamed(tasks, { slug, main }).find(({ place }) => place === 'archive');
  if (archived !== undefined) fail(`${slug} is retired: only its archive copy is left, ${archived.file}.`);
  const folder = taskWorktree(main, slug);
  if (exists(folder)) fail(`The folder ${folder} exists, but no task ledger in it has the slug ${slug}.`);
  return fail(withHint(store, `No backlog task ${slug} for the repo at ${main}.`), 2);
}

/** The live ledger of `ref`: an active task beats a backlog ledger. */
const liveLedger = (tasks: Task[], ref: Ref): Task | undefined => {
  const live = findNamed(tasks, ref).filter(({ place }) => place !== 'archive');
  return live.find(({ place }) => place === 'active') ?? live[0];
};

/**
 * Starts a task, as /ledger:go does: a parent with a child still in the backlog starts that child instead, a backlog
 * task gets its worktree, a task with a worktree is only gone to. Then its parked status is removed and its parent marks
 * it started; a parent that cannot be marked is a warning, not a failure. A parent in the backlog with no child left
 * there fails, as there is nothing to start. The slug names a ledger that exists, so the reading rule applies. The task is
 * claimed for `session`; a task with a worktree that another session holds live is refused with Held, unless `takeOver`.
 * With no session known, or for a task of another repo than the one it runs in, nothing is claimed. Last, the worktree's
 * packages are installed when it needs it; a failed install exits INSTALL_FAILED and keeps the started task, claim
 * included, so the same start installs again.
 */
export function goTask(context: Context, slug: string, repo: string | undefined, { session, takeOver = false }: { session?: string; takeOver?: boolean } = {}): GoResult {
  const { cwd } = context;
  if (!isReadableSlug(slug)) fail(notASlug(slug));
  const named = { slug, main: repoOf(cwd, repo === undefined ? cwd : path.resolve(cwd, repo)) };
  const tasks = findTasks(context.store);
  const task = liveLedger(tasks, named);
  if (task?.elsewhere) fail(notOnThisMachine(task));
  let chain: Ref[] = [];
  if (task !== undefined && namedChildren(task, tasks).length > 0) {
    const blocked: Blocked[] = [];
    chain = firstToStart(tasks, { task, ref: named }, blocked) ?? [];
    if (chain.length === 0 && task.place === 'backlog') {
      fail(
        blocked.length > 0
          ? `No child task of ${slug} can start yet: ${waitingLines(cwd, blocked).join(' ')}`
          : `No child task of ${slug} is left in the backlog, so there is nothing to start. ledger tree show ${slug} shows its children.`,
      );
    }
  }
  const target = chain.at(-1) ?? named;
  if (!isReadableSlug(target.slug)) fail(notASlug(target.slug));
  const found = (chain.length === 0 ? task : liveLedger(tasks, target)) ?? refuseMissing(context.store, tasks, target);
  if (found.elsewhere) fail(notOnThisMachine(found));
  if (found.place === 'active' && (found.main === undefined || !samePath(found.main, target.main))) fail(takenText(target.slug, found.worktree, found.file));
  const place =
    found.place === 'active' && found.worktree !== undefined
      ? { ledger: found.file, worktree: found.worktree, ...(found.branch === undefined ? {} : { branch: found.branch }), promoted: false }
      : { ...promote(context, target.slug, target.main, found.repo), promoted: true };
  const cwdMain = mainCheckout(cwd);
  const inCwdRepo = cwdMain !== undefined && samePath(cwdMain, target.main);
  // A session stays in its own repo, and its touch and release reach only that repo, so a claim elsewhere would hold until it expires.
  const claimFor = inCwdRepo ? session : undefined;
  const record = place.promoted ? { repo: repoKey(target.main), name: target.slug } : found;
  const { tookOverFrom } = claimFor === undefined ? {} : claimLedger(context, { slug: target.slug, file: place.ledger, repo: record.repo, name: record.name }, claimFor, { takeOver });
  if (claimFor === undefined && found.place === 'active') refuseIfHeld(context, found, takeOver);
  const unclaimed = session !== undefined && !inCwdRepo ? `the task is in another repo, so a session in ${target.main} claims it with ledger go ${target.slug}` : undefined;

  const { active } = context.store;
  const { location } = parseLedger(active.read(record.repo, record.name)?.text ?? fail(`The ledger ${place.ledger} is gone.`));
  const parked = parkedOf(location);
  if (parked !== undefined) updateActive(context, record, unpark);
  const warnings: string[] = [];
  let marked: GoResult['marked'];
  const parent = location.parent && { slug: location.parent.slug, main: location.parent.main ?? target.main };
  if (parent !== undefined) {
    try {
      if (place.promoted) nameChildClone(context, parent, target);
      const change = changeParent(context, `${parent.slug}@${parent.main}`, 'start', `${target.slug}@${target.main}`);
      if (change.action === 'start' && change.marked) marked = { parent, ledger: change.ledger };
    } catch (error) {
      warnings.push(`${target.slug} is not marked started in ${parent.slug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const children = childrenOf(found, target.main, tasks).map(({ slug: child, main, status }) => ({ slug: child, main, status }));
  const again = inCwdRepo ? `ledger go ${target.slug}` : `ledger go ${target.slug} --repo ${shellWord(target.main)}`;
  const installed = installPackages(place.worktree, again);
  return {
    ...target,
    ...place,
    chain,
    ...(parent === undefined ? {} : { parent }),
    children,
    ...(parked === undefined ? {} : { unparked: parked }),
    ...(marked === undefined ? {} : { marked }),
    ...(installed === undefined ? {} : { installed }),
    ...(tookOverFrom === undefined ? {} : { tookOverFrom }),
    ...(unclaimed === undefined ? {} : { unclaimed }),
    warnings,
  };
}

export function goText(context: Context, { ledger, worktree, branch, base, chain, unparked, marked, installed, tookOverFrom, unclaimed }: GoResult): string {
  const name = nameFrom(context.cwd);
  return [
    ...(base === undefined ? [`worktree ${worktree}`, ...(branch === undefined ? [] : [`branch   ${branch}`]), `ledger   ${ledger}`] : startedLines({ worktree, branch: branch ?? '', base, ledger })),
    ...(chain.length === 0 ? [] : [`chain    ${chain.map(name).join(' ')}`]),
    ...(unparked === undefined ? [] : [`unparked ${unparked.date} — ${unparked.reason}`]),
    ...(marked === undefined ? [] : [`marked   ${marked.ledger}`]),
    ...(installed === undefined ? [] : [`packages ${installed}`]),
    ...(tookOverFrom === undefined ? [] : [`claim    took over from session ${tookOverFrom.session}`]),
    ...(unclaimed === undefined ? [] : [`claim    not claimed: ${unclaimed}`]),
  ].join('\n');
}

export function liveTask(context: Context, name: string): Linked & { tasks: Task[] } {
  const ref = taskRef(context.cwd, name);
  const tasks = findTasks(context.store);
  return { task: theTask(tasks, ref, { live: true }), ref, tasks };
}

/** A parked status as `ledger go`, `park`, `unpark` and `list --json` give it, a field the status line leaves out as empty. */
type ParkedMark = { date: string; reason: string };

export const parkedOf = ({ status }: Location): ParkedMark | undefined =>
  status?.value === 'parked' ? { date: status.date ?? '', reason: status.detail ?? '' } : undefined;

export type ParkResult = Ref & { ledger: string; parked: ParkedMark };

/** `parked` is the parked status removed; unparked is false when there was none. */
export type UnparkResult = Ref & { ledger: string; unparked: boolean; parked?: ParkedMark };

/**
 * Fails unless the state table lets `task` move to `to` from the state `location` gives it. Set again, a status is only
 * updated, as a second park replaces the reason.
 */
function checkMove(task: Task, location: Location, to: StatusValue): void {
  const from = stateOf(location);
  if (from !== to) checkTransition(task.slug, from, to);
}

function movedTo(task: Task, text: string, status: Status): string {
  checkMove(task, parseLedger(text).location, status.value);
  if (status.value === 'waiting') checkPrLink(task.slug, parseRecord(text));
  return setStatus(text, status) ?? fail(`${task.file} has no ## Location section.`);
}

/**
 * `text` without the status `value`, which makes the task active again.
 * The check cannot fail today: only parked, blocked and waiting are cleared, and the table lets each go back to active.
 */
function movedFrom(task: Task, text: string, value: StatusValue): string {
  checkTransition(task.slug, value, 'active');
  return clearStatus(text, value);
}

export function parkTask(context: Context, name: string, reason: string): ParkResult {
  if (oneLine(reason) === '') fail('A parked task needs a reason: ledger task park <slug> --reason <text>');
  const { task, ref } = liveTask(context, name);
  // Before the write too: updateLedger refuses a lost task as one of another machine, which hides why it cannot move.
  checkMove(task, task.ledger.location, 'parked');
  const parked = { date: today(), reason: oneLine(reason) };
  updateLedger(context, task, (text) => movedTo(task, withoutClaim(text), { value: 'parked', date: parked.date, detail: parked.reason }));
  return { ...ref, ledger: task.file, parked };
}

export const parkText = ({ slug, parked: { date, reason } }: ParkResult): string => `Parked ${slug}. Parked: ${date} — ${reason}`;

export function unparkTask(context: Context, name: string): UnparkResult {
  const { task, ref } = liveTask(context, name);
  const parked = parkedOf(task.ledger.location);
  if (parked === undefined) return { ...ref, ledger: task.file, unparked: false };
  updateLedger(context, task, (text) => movedFrom(task, text, 'parked'));
  return { ...ref, ledger: task.file, unparked: true, parked };
}

export const unparkText = ({ slug, parked }: UnparkResult): string =>
  parked === undefined ? `${slug} is not parked.` : `Unparked ${slug}. It was parked${parked.date ? ` on ${parked.date}` : ''}${parked.reason ? `: ${parked.reason}` : ''}.`;

/** A blocked status as `block` and `unblock` give it: what the task waits for is `on`, a field the line leaves out as empty. */
type BlockedMark = { date: string; on: string };

const blockedOf = ({ status }: Location): BlockedMark | undefined => (status?.value === 'blocked' ? { date: status.date ?? '', on: status.detail ?? '' } : undefined);

export type BlockResult = Ref & { ledger: string; blocked: BlockedMark };

/** `blocked` is the blocked status removed; unblocked is false when there was none. */
export type UnblockResult = Ref & { ledger: string; unblocked: boolean; blocked?: BlockedMark };

/** Unlike park, it keeps the claim: the session that holds a blocked task goes on with it once the block is gone. */
export function blockTask(context: Context, name: string, on: string): BlockResult {
  if (oneLine(on) === '') fail('A blocked task names what it waits for: ledger task block <slug> --on <text>');
  const { task, ref } = liveTask(context, name);
  checkMove(task, task.ledger.location, 'blocked');
  const blocked = { date: today(), on: oneLine(on) };
  updateLedger(context, task, (text) => movedTo(task, text, { value: 'blocked', date: blocked.date, detail: blocked.on }));
  return { ...ref, ledger: task.file, blocked };
}

export const blockText = ({ slug, blocked: { date, on } }: BlockResult): string => `Blocked ${slug}. Blocked: ${date} — ${on}`;

export function unblockTask(context: Context, name: string): UnblockResult {
  const { task, ref } = liveTask(context, name);
  const blocked = blockedOf(task.ledger.location);
  if (blocked === undefined) return { ...ref, ledger: task.file, unblocked: false };
  updateLedger(context, task, (text) => movedFrom(task, text, 'blocked'));
  return { ...ref, ledger: task.file, unblocked: true, blocked };
}

export const unblockText = ({ slug, blocked }: UnblockResult): string =>
  blocked === undefined ? `${slug} is not blocked.` : `Unblocked ${slug}. It was blocked${blocked.date ? ` on ${blocked.date}` : ''}${blocked.on ? `: ${blocked.on}` : ''}.`;

/** `notice` is the line for stderr: the hint to finalize a task marked done, or why a merged one was not marked. */
export type MergedCheck = { marked: boolean; notice?: string };

/**
 * Marks `task` done when it is waiting, names its PR, and gh says that PR is merged. gh is asked about no other task,
 * and not about one with no live git worktree of its repo on this machine (`elsewhere`), as one of another machine. A
 * write that fails is no failure: `ledger list` and `ledger show` go on with the task as read.
 */
export function markMergedDone(context: Context, task: Task): MergedCheck {
  const { pr } = task.ledger.location;
  if (task.status !== 'waiting' || pr === undefined || task.elsewhere) return { marked: false };
  if (prState(task.main ?? context.cwd, pr) !== 'merged') return { marked: false };
  try {
    const marked = markWaitingDone(context, task);
    return marked ? { marked, notice: `${task.slug}: PR merged; marked done. Finalize it with the question from \`ledger task gate finalize ${task.slug}\`.` } : { marked };
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    return { marked: false, notice: `warning: ${task.slug}: its PR is merged, but it was not marked done: ${oneLine(error.message)}` };
  }
}

/** Marks a waiting task done, as its PR is merged; false when the record, as its lock reads it, is not waiting any more. */
export function markWaitingDone(context: Context, task: Task): boolean {
  return updateLedger(context, task, (text) => (stateOf(parseLedger(text).location) === 'waiting' ? movedTo(task, text, { value: 'done', date: today() }) : undefined));
}

export type DoneResult = { slug: string; ledger: string; finalize: string };

/**
 * Marks a task done: one with no PR link, as the operator answered "Goal met", or one whose PR gh says is merged. The
 * task `name` gives, or else the task of the worktree the command runs in.
 */
export function doneTask(context: Context, name: string | undefined): DoneResult {
  const task = name === undefined ? (currentTask(context.store, context.cwd) ?? fail('No task in this folder. Give its slug: ledger task done <slug>')) : liveTask(context, name).task;
  const { slug } = task;
  if (task.place === 'backlog') fail(`${slug} is in the backlog: it has not started, so it cannot be done. Start it with ledger go ${slug}.`);
  // Before gh and the write: updateLedger refuses a lost task as one of another machine, which hides why it cannot move.
  checkTransition(slug, stateOf(task.ledger.location), 'done');
  const main = mainCheckout(context.cwd);
  const repo = main === undefined ? '' : repoKey(main);
  const { pr } = task.ledger.location;
  if (pr !== undefined && !task.elsewhere) {
    const state = prState(task.main ?? context.cwd, pr);
    if (state === 'unknown') fail(`${slug}: gh could not say whether its PR ${pr} is merged, so the task is not done. Try again once gh answers.`);
    if (state === 'not merged') fail(`${slug}: its PR ${pr} is not merged, so the task is not done. Merge it first, after the question from \`${gateCommand('merge', task, repo)}\`.`);
  }
  updateLedger(context, task, (text) =>
    parseLedger(text).location.pr === pr ? movedTo(task, text, { value: 'done', date: today() }) : fail(`${slug}: its PR link changed while it was being marked done. Run ledger task done again.`),
  );
  return { slug, ledger: task.file, finalize: gateCommand('finalize', task, repo) };
}

export const doneText = ({ slug, finalize }: DoneResult): string => `${slug} is done. Finalize it with the question from \`${finalize}\`.`;

/**
 * Makes a waiting task active again, as its PR needs fixes, at the build stage when its kind has one. Gives the stage
 * set, 'active' when none was, and undefined when the record, as its lock reads it, is not waiting any more.
 */
export function sendBackToBuild(context: Context, task: Task): 'build' | 'active' | undefined {
  let moved: 'build' | 'active' | undefined;
  updateLedger(context, task, (text) => {
    if (stateOf(parseLedger(text).location) !== 'waiting') return undefined;
    const active = movedFrom(task, text, 'waiting');
    moved = hasStage(parseRecord(text).kind, 'build') ? 'build' : 'active';
    return moved === 'build' ? (setLocationBullet(active, 'stage', 'build') ?? active) : active;
  });
  return moved;
}

const PR_FORM = 'https://github.com/<owner>/<repo>/pull/<number>';

/** `url` as the PR link to record: a GitHub PR address, without a trailing slash, query or fragment. */
function prLink(url: string): string {
  const link = /^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*)\/?(?:[?#].*)?$/.exec(url.trim())?.[1];
  return link ?? fail(`${url} is not the address of a GitHub PR. Give it as ${PR_FORM}.`);
}

export type PrResult = { slug: string; ledger: string; pr: string };

/**
 * Records the PR link of a task, the one `name` gives or else the task of the worktree the command runs in, and makes
 * the task waiting at its pr stage, when its kind has one. A waiting task keeps waiting with the new link.
 */
export function recordPr(context: Context, name: string | undefined, url: string): PrResult {
  const pr = prLink(url);
  const task = name === undefined ? (currentTask(context.store, context.cwd) ?? fail('No task in this folder. Pass --task <slug>.')) : liveTask(context, name).task;
  if (task.place === 'backlog') fail(`${task.slug} is in the backlog, so it cannot become waiting. Start it first: ledger go ${task.slug}`);
  // Before the write too: updateLedger refuses a lost task as one of another machine, which hides why it cannot move.
  checkMove(task, task.ledger.location, 'waiting');
  updateLedger(context, task, (text) => {
    const linked = setLocationBullet(text, 'pr', pr) ?? text;
    const staged = hasStage(parseRecord(linked).kind, 'pr') ? (setLocationBullet(linked, 'stage', 'pr') ?? linked) : linked;
    return movedTo(task, staged, { value: 'waiting', date: today() });
  });
  return { slug: task.slug, ledger: task.file, pr };
}

export const recordPrText = ({ slug, pr }: PrResult): string => `Recorded PR ${pr} on ${slug}; the task is waiting.`;

export type ParentAction = 'add' | 'remove' | 'start' | 'next' | 'ready';

/** A backlog child passed over because it waits for `dependencies`, which are not done. */
export type Blocked = { child: Ref; dependencies: Required<Dependency>[] };

/**
 * What `ledger tree <action> <parent>` did. A start that marks nothing says why: the line is `already-marked` with
 * `mark`, or the child is `retired`. A next names the chain from the parent down to the child to start, empty for none;
 * with none, `blocked` names each child that waits for a task not done. A ready names the chain to every child that can
 * start now and to every child already started, and each child that waits.
 */
export type ParentChange =
  | { action: 'add' | 'remove'; parent: Ref; child: Ref }
  | { action: 'start'; parent: Ref; child: Ref; ledger: string; marked: boolean; reason?: 'already-marked' | 'retired'; mark?: ChildMark['kind'] }
  | { action: 'next'; parent: Ref; chain: Ref[]; blocked?: Blocked[] }
  | { action: 'ready'; parent: Ref; ready: Ref[][]; running: Ref[][]; blocked: Blocked[] };

/** How messages name a dependency: `<slug>` in the repo of `cwd`, else `<slug>@<repo key>`. */
function dependencyName(cwd: string) {
  const main = mainCheckout(cwd);
  const here = main === undefined ? undefined : repoKey(main);
  return ({ slug, repo }: Required<Dependency>): string => (repo === here ? slug : `${slug}@${repo}`);
}

/** One `<child> waits for <task>, <task>.` line per blocked child. */
export function waitingLines(cwd: string, blocked: Blocked[]): string[] {
  const [name, dependency] = [nameFrom(cwd), dependencyName(cwd)];
  return blocked.map(({ child, dependencies }) => `${name(child)} waits for ${dependencies.map(dependency).join(', ')}.`);
}

/** One `<child> is running.` line per chain to a started child. */
export function runningLines(cwd: string, running: Ref[][]): string[] {
  const name = nameFrom(cwd);
  return running.map((chain) => `${name(chain[chain.length - 1])} is running.`);
}

/** The line to print, empty for none. */
export function parentChangeText({ cwd, paths }: Context, change: ParentChange): string {
  const name = nameFrom(cwd);
  switch (change.action) {
    case 'add':
      return `${name(change.child)} is a child of ${name(change.parent)}.`;
    case 'remove':
      return `${name(change.child)} is no longer a child of ${name(change.parent)}.`;
    case 'start':
      if (change.marked) return `Marked ${name(change.child)} started in ${paths.tilde(change.ledger)}.`;
      if (change.reason === 'retired') return `${name(change.child)} is retired, so it is not marked started.`;
      return `${name(change.child)} is already marked ${change.mark} in ${paths.tilde(change.ledger)}.`;
    case 'next':
      return change.chain.map(name).join(' ');
    case 'ready':
      return change.ready.map((chain) => chain.map(name).join(' ')).join('\n');
  }
}

/** `ledger tree <action> <parent> [<child>]`. */
export function changeParent(context: Context, parentName: string, action: ParentAction, childName: string | undefined): ParentChange {
  if (action === 'next' || action === 'ready') {
    if (childName !== undefined) fail(`ledger tree ${action} <parent> takes no child.`);
    const { task, ref, tasks } = liveTask(context, parentName);
    const walk: Walk = { blocked: [], running: [] };
    if (action === 'ready') {
      const ready = [...startable(tasks, { task, ref }, walk)];
      return { action, parent: ref, ready, running: walk.running, blocked: walk.blocked };
    }
    const chain = firstToStart(tasks, { task, ref }, walk.blocked) ?? [];
    return { action, parent: ref, chain, ...(chain.length === 0 && walk.blocked.length > 0 ? { blocked: walk.blocked } : {}) };
  }
  if (childName === undefined) return fail(`ledger tree ${action} <parent> needs a child: ledger tree ${action} ${parentName} <child>`);
  const parentRef = taskRef(context.cwd, parentName);
  const childRef = taskRef(context.cwd, childName);
  const tasks = findTasks(context.store);
  const parent = theTask(tasks, parentRef, { live: true });
  const change = { add: addChildTask, remove: removeChildTask, start: startChildTask }[action];
  const output = change(context, tasks, { task: parent, ref: parentRef }, childRef);
  return output;
}

type Linked = { task: Task; ref: Ref };
type ParentLine = NonNullable<Location['parent']>;

/** The lines under the parent's ## Children that name `child`: in the parent as it was read, or else in `text`. */
const linesOf = ({ task, ref }: Linked, child: Ref, text?: string): Child[] =>
  (text === undefined ? task.ledger : parseLedger(text)).children.filter((line) => sameTask({ slug: line.slug, main: line.main ?? ref.main }, child));

/**
 * Every clone of a repo shares a backlog parent, and a worktree child is in one of them only, so the child's line in
 * such a parent names that clone's main checkout.
 */
const namesClone = (parent: Task, place: Place): boolean => parent.place === 'backlog' && place === 'active';

/**
 * After `go` put the backlog child `child` in a worktree, its line in a backlog parent names the clone it is in. A line
 * that names a clone with a worktree task of that slug is that task's, so it stays. A line that names a folder that is
 * no main checkout any more names a clone that is gone, of a repo no one can tell, so it is taken for this child's.
 */
function nameChildClone(context: Context, parentRef: Ref, child: Ref): void {
  if (/\s/.test(child.main)) return;
  const tasks = findTasks(context.store);
  const parent = liveLedger(tasks, parentRef);
  if (parent === undefined || !namesClone(parent, 'active')) return;
  const hasWorktreeTask = (main: string): boolean => tasks.some((task) => task.place === 'active' && task.slug === child.slug && task.main !== undefined && samePath(task.main, main));
  const isGone = (main: string): boolean => {
    const checkout = mainCheckout(main);
    return checkout === undefined || !samePath(checkout, main);
  };
  const namesChild = ({ slug, main }: Child): boolean =>
    main === undefined ? sameTask({ slug, main: parentRef.main }, child) : slug === child.slug && (isGone(main) || (sameTask({ slug, main }, child) && !hasWorktreeTask(main)));
  updateLedger(context, parent, (text) => {
    const line = parseLedger(text).children.find(namesChild);
    return line && withChildMain(text, line, child.main);
  });
}

/** The ## Children line of `child`, a task of `place`. */
const childLine = (parent: Linked, child: Ref, place: Place): string =>
  namesClone(parent.task, place) ? `- ${child.slug} @ ${child.main}` : `- ${linkFrom(parent.ref.main, child)}`;

/** Whether the `- parent:` line of a child in `childMain` names `parent`. */
const namesParent = (bullet: ParentLine | undefined, childMain: string, parent: Linked): bullet is ParentLine =>
  bullet !== undefined && sameTask({ slug: bullet.slug, main: bullet.main ?? childMain }, parent.ref);

/** The parent a ledger's Location names, in the task's own repo unless the line names another. */
function parentOf(task: Task, main: string): Ref | undefined {
  const parent = task.ledger.location.parent;
  return parent && { slug: parent.slug, main: parent.main ?? main };
}

/** The parent of a task, its parent, and so on, up to a task with no live ledger or one seen before. */
function ancestors(tasks: Task[], { task, ref }: Linked): Ref[] {
  const seen: Ref[] = [];
  let next = parentOf(task, ref.main);
  while (next !== undefined) {
    const ancestor = next;
    const found = findNamed(tasks, ancestor).find(({ place }) => place !== 'archive');
    if (seen.some((known) => sameTask(known, ancestor))) break;
    seen.push(ancestor);
    next = found && parentOf(found, ancestor.main);
  }
  return seen;
}

function addChildTask(context: Context, tasks: Task[], parent: Linked, childRef: Ref): ParentChange {
  const name = nameFrom(context.cwd);
  if (sameTask(parent.ref, childRef)) fail(`${name(childRef)} cannot be its own parent.`);
  const child = theTask(tasks, childRef, { live: true });
  if (wasChildOf(tasks, childRef, parent.ref)) fail(`${name(childRef)} is a retired child of ${name(parent.ref)}. Give the new task another slug.`);
  const current = parentOf(child, childRef.main);
  if (current !== undefined && !sameTask(current, parent.ref)) {
    fail(`${name(childRef)} already has the parent ${name(current)}. First run: ledger tree remove ${name(current)} ${name(childRef)}`);
  }
  if (ancestors(tasks, parent).some((ancestor) => sameTask(ancestor, childRef))) {
    fail(`${name(childRef)} is already a parent of ${name(parent.ref)}, or of one of its parents. Making it a child of ${name(parent.ref)} would make a cycle.`);
  }
  const spaced = samePath(parent.ref.main, childRef.main) ? undefined : [parent.ref.main, childRef.main].find((main) => /\s/.test(main));
  if (spaced !== undefined) fail(`The repo at ${spaced} has whitespace in its path, so none of its tasks can be linked to a task in another repo.`);
  if (namesClone(parent.task, child.place) && /\s/.test(childRef.main)) {
    fail(`The repo at ${childRef.main} has whitespace in its path, so none of its worktree tasks can be a child of a backlog task.`);
  }
  refuseElsewhere(parent.task, child);

  // A child already listed keeps its place, and so does one linked before with an order: adding it again changes no
  // order. Any other goes after every sibling, so live siblings without an order are numbered first, in the order of
  // their lines; without that they would sort after it.
  const isListed = linesOf(parent, childRef).length > 0;
  const keepsPlace = isListed || (current !== undefined && child.ledger.location.order !== undefined);
  const numbered = keepsPlace ? undefined : numberSiblings(tasks, parent, child);
  const orders = new Map(numbered ?? []);
  const order = orders.get(child);
  for (const [sibling, place] of orders) {
    if (sibling !== child) updateLedger(context, sibling, (text) => setLocationBullet(text, 'order', String(place)));
  }
  // The child's line first: once it is written, running the same add again finishes the parent.
  updateLedger(context, child, (text) => {
    let changed: string | undefined = text;
    if (current === undefined) changed = addLocationBullet(changed, `- parent: ${linkFrom(childRef.main, parent.ref)}`);
    if (order !== undefined && changed !== undefined) changed = setLocationBullet(changed, 'order', String(order));
    if (changed === undefined) return fail(`${child.file} has no ## Location section.`);
    return changed === text ? undefined : changed;
  });
  updateLedger(context, parent.task, (text) => {
    const listed = linesOf(parent, childRef, text).length > 0 ? text : addChild(text, childLine(parent, childRef, child.place));
    const sorted = sortChildLines(listed, parent, tasks, orders);
    return sorted === text ? undefined : sorted;
  });
  return { action: 'add', parent: parent.ref, child: childRef };
}

/** A change of a parent and child writes both ledgers, so either one being elsewhere refuses it before the other is written. */
function refuseElsewhere(...tasks: Task[]): void {
  const far = tasks.find(({ elsewhere }) => elsewhere);
  if (far !== undefined) fail(notOnThisMachine(far));
}

/**
 * The orders to write so `child` comes after every other child of `parent`: each live sibling without an order, in the
 * order of its line, gets the next number after the highest order, and `child` the one after those. A sibling whose own
 * ledger names another parent is left out: its order places it among that parent's children. A sibling elsewhere
 * cannot be written here, so it stays without an order.
 */
function numberSiblings(tasks: Task[], parent: Linked, child: Task): [Task, number][] {
  const siblings = listedChildren(parent.task, parent.ref.main, tasks).flatMap((listed) =>
    listed.task === undefined || listed.task === child || namesAnotherParent(tasks, parent, listed) ? [] : [listed.task],
  );
  const highest = Math.max(0, ...siblings.flatMap((task) => task.ledger.location.order ?? []));
  const unordered = siblings.filter((task) => task.place !== 'archive' && !task.elsewhere && task.ledger.location.order === undefined);
  return [...unordered, child].map((task, index) => [task, highest + index + 1]);
}

/** Whether the listed child's ledger names a parent other than `parent`. A child with no ledger that counts for `parent` may have an archive copy, retired under another parent. */
const namesAnotherParent = (tasks: Task[], parent: Linked, { ref, task }: ListedChild): boolean =>
  (task === undefined ? findNamed(tasks, ref) : [task]).some((each) => {
    const named = parentOf(each, ref.main);
    return named !== undefined && !sameTask(named, parent.ref);
  });

/**
 * `text`, the ledger of `parent`, with the lines of its children by order. `orders` holds orders just written, which
 * `tasks` predates. A line that names no task keeps its place, and so does one of a task whose ledger names another
 * parent: its order places it among that parent's children.
 */
function sortChildLines(text: string, parent: Linked, tasks: Task[], orders: ReadonlyMap<Task, number>): string {
  const now = { ...parent.task, ledger: parseLedger(text) };
  const children = orderedChildren(now, parent.ref.main, tasks, (task) => orders.get(task) ?? task.ledger.location.order);
  return placeChildren(text, children.flatMap((listed) => (namesAnotherParent(tasks, parent, listed) ? [] : [listed.line])));
}

function removeChildTask(context: Context, tasks: Task[], parent: Linked, childRef: Ref): ParentChange {
  const name = nameFrom(context.cwd);
  const child = theTask(tasks, childRef, { live: true });
  if (!namesParent(child.ledger.location.parent, childRef.main, parent)) fail(`${name(childRef)} is not a child of ${name(parent.ref)}.`);
  refuseElsewhere(parent.task, child);
  // The parent first: until the child's line is gone, running the same remove again still finds the pair.
  updateLedger(context, parent.task, (text) => {
    const listed = linesOf(parent, childRef, text);
    return listed.length === 0 ? undefined : removeChildren(text, listed.map(({ line }) => line));
  });
  // The order only places a task among the children of its parent, so it goes with the parent line.
  updateLedger(context, child, (text) => {
    const bullet = parseLedger(text).location.parent;
    return namesParent(bullet, childRef.main, parent) ? setLocationBullet(removeLine(text, bullet.line), 'order', undefined) : undefined;
  });
  return { action: 'remove', parent: parent.ref, child: childRef };
}

/** The Children mark is only a hint, so a marked line and a retired child are both left as they are. */
function startChildTask(context: Context, tasks: Task[], parent: Linked, childRef: Ref): ParentChange {
  const name = nameFrom(context.cwd);
  const notListed = (): never => fail(`${name(childRef)} is not listed under ## Children of ${name(parent.ref)}. Add it with: ledger tree add ${name(parent.ref)} ${name(childRef)}`);
  const child = locateChild(tasks, childRef, parent.ref);
  const [line] = linesOf(parent, childRef);
  if (line === undefined) {
    if (child === undefined) fail(`${name(childRef)} is not listed under ## Children of ${name(parent.ref)}, and no task ledger has the slug ${childRef.slug}.`);
    notListed();
  }
  if (!namedChildren(parent.task, tasks).includes(line)) fail(`${name(childRef)} names no task: its line under ## Children of ${name(parent.ref)} is a note, not a child.`);
  const started = { action: 'start', parent: parent.ref, child: childRef, ledger: parent.task.file } as const;
  if (line.mark !== undefined) return { ...started, marked: false, reason: 'already-marked', mark: line.mark.kind };
  if (child?.status === 'retired') return { ...started, marked: false, reason: 'retired' };
  let mark: ChildMark['kind'] | undefined;
  updateLedger(context, parent.task, (text) => {
    const [now] = linesOf(parent, childRef, text);
    if (now === undefined) return notListed();
    mark = now.mark?.kind;
    return mark === undefined ? markStarted(text, now, today()) : undefined;
  });
  return mark === undefined ? { ...started, marked: true } : { ...started, marked: false, reason: 'already-marked', mark };
}

/** What a walk of the children passed over: each child that waits, and the chain to each child already started. */
type Walk = { blocked: Blocked[]; running: Ref[][] };

/**
 * The chain from the parent down to each child, by order, that is still in the backlog, by disk, and waits for no task
 * that is not done. A child with children of its own is not started itself: the walk goes on into its children. A task
 * already on the chain is a cycle and is skipped. Each child passed over is added to `walk`, up to the last chain taken.
 */
function* startable(tasks: Task[], parent: Linked, walk: Walk, chain: Ref[] = [parent.ref]): Generator<Ref[]> {
  for (const { ref: child, task: found } of orderedChildren(parent.task, parent.ref.main, tasks)) {
    if (chain.some((ref) => sameTask(ref, child))) continue;
    if (found?.place === 'active') walk.running.push([...chain, child]);
    if (found?.place !== 'backlog') continue;
    const waiting = dependenciesOf(found).filter((dependency) => !isDone(dependencyTask(tasks, dependency)));
    if (waiting.length > 0) walk.blocked.push({ child, dependencies: waiting });
    else if (namedChildren(found, tasks).length === 0) yield [...chain, child];
    else yield* startable(tasks, { task: found, ref: child }, walk, [...chain, child]);
  }
}

/** The first chain `startable` gives; each child passed over for what it waits for is added to `blocked`. */
function firstToStart(tasks: Task[], parent: Linked, blocked: Blocked[], chain: Ref[] = [parent.ref]): Ref[] | undefined {
  const [first] = startable(tasks, parent, { blocked, running: [] }, chain);
  return first;
}

/** The task `ledger tree next` would start under `parent`, with `skip` passed over; it starts nothing. */
export const nextToStart = (tasks: Task[], parent: Linked, skip?: Ref): Ref | undefined =>
  firstToStart(tasks, parent, [], skip === undefined ? [parent.ref] : [parent.ref, skip])?.at(-1);

/** What `ledger tree order` set: the children of `parent`, first to last. */
export type OrderResult = { action: 'order'; parent: Ref; children: Ref[] };

type LiveChild = ListedChild & { task: Task };
const isLive = (child: ListedChild): child is LiveChild => child.task !== undefined && child.task.place !== 'archive';

/**
 * `ledger tree order <parent> <child>...`: gives the children the orders 1 to n, as named, and sorts the parent's lines.
 * The names must be the children with a live ledger, each once; else it fails, naming each problem, and writes nothing.
 */
export function orderChildren(context: Context, parentName: string, childNames: string[]): OrderResult {
  const { cwd } = context;
  const parentRef = taskRef(cwd, parentName);
  const named = childNames.map((childName) => taskRef(cwd, childName));
  const tasks = findTasks(context.store);
  const parent = { task: theTask(tasks, parentRef, { live: true }), ref: parentRef };
  const current = listedChildren(parent.task, parentRef.main, tasks).filter(isLive);
  const name = nameFrom(cwd);
  const elsewhere = current.flatMap(({ ref, task }) => {
    const named = parentOf(task, ref.main);
    return named === undefined || sameTask(named, parentRef) ? [] : [`${name(ref)} (parent ${name(named)})`];
  });
  if (elsewhere.length > 0) {
    fail(`Lines under ## Children of ${name(parentRef)} name tasks whose own ledger names another parent: ${elsewhere.join(', ')}. Remove those lines first. Nothing was changed.`);
  }

  const picked: LiveChild[] = [];
  const strangers: Ref[] = [];
  const repeated: LiveChild[] = [];
  for (const ref of named) {
    const child = current.find((each) => sameTask(ref, each.ref));
    if (child === undefined) {
      if (!strangers.some((known) => known.slug === ref.slug && samePath(known.main, ref.main))) strangers.push(ref);
    }
    else if (!picked.includes(child)) picked.push(child);
    else if (!repeated.includes(child)) repeated.push(child);
  }
  const unnamed = current.filter((child) => !picked.includes(child));
  if (unnamed.length + strangers.length + repeated.length > 0) {
    const listed = (label: string, refs: Ref[]): string[] => (refs.length === 0 ? [] : [`${label}: ${refs.map(name).join(', ')}.`]);
    fail(
      [
        `Name each child task of ${name(parentRef)} once, first to last.`,
        ...listed('Not named', unnamed.map(({ ref }) => ref)),
        ...listed(`Not a live child task of ${name(parentRef)}; a retired child keeps no order`, strangers),
        ...listed('Named more than once', repeated.map(({ ref }) => ref)),
      ].join(' '),
    );
  }
  const readOnly = [parent.task, ...picked.map(({ task }) => task)].filter(({ elsewhere }) => elsewhere);
  if (readOnly.length > 0) fail(`${readOnly.map(notOnThisMachine).join(' ')} Nothing was changed.`);
  const unlocated = picked.filter(({ task }) => findSection(task.ledger.sections, 'Location') === undefined);
  if (unlocated.length > 0) {
    const named = unlocated.map(({ ref, task }) => `${name(ref)} (${task.file})`).join(', ');
    fail(`${named} ${unlocated.length === 1 ? 'has' : 'have'} no ## Location section to hold an order. Nothing was changed.`);
  }
  const orders = new Map(picked.map(({ task }, index) => [task, index + 1]));
  for (const [task, order] of orders) updateLedger(context, task, (text) => setLocationBullet(text, 'order', String(order)) ?? fail(`${task.file} has no ## Location section.`));
  updateLedger(context, parent.task, (text) => {
    const sorted = sortChildLines(text, parent, tasks, orders);
    return sorted === text ? undefined : sorted;
  });
  return { action: 'order', parent: parentRef, children: picked.map(({ ref }) => ref) };
}

export const orderText = ({ cwd }: Context, { parent, children }: OrderResult): string => {
  const name = nameFrom(cwd);
  return `The child tasks of ${name(parent)} are in this order now: ${children.map(name).join(', ')}.`;
};

/** What `ledger tree depends` set: the tasks `child` waits for, each with the key of its repo. */
export type DependsResult = { action: 'depends'; child: Ref; dependencies: Required<Dependency>[] };

/** A URL, or git's scp form `[user@]host:path`: a colon before any slash. */
const REMOTE_URL = /^[^/]*:/;

/**
 * A task as `tree depends` names it: `<slug>`, in the repo `key`; `<slug>@<path>`, in the repo that holds the path; or
 * `<slug>@<address>`, in the repo of that remote address, given as a repo key or as git takes a remote.
 */
function dependencyFrom(cwd: string, key: string, name: string): Required<Dependency> {
  const at = name.indexOf('@');
  const slug = at === -1 ? name : name.slice(0, at);
  if (!isReadableSlug(slug)) fail(notASlug(slug));
  if (at === -1) return { slug, repo: key };
  const where = name.slice(at + 1);
  if (where === '') fail(`${name} names no repo after the @. Name a folder or a repo address, such as ${slug}@github.com/owner/repo, or leave out the @ for a task in this repo.`);
  const found = repoAfterAt(cwd, where);
  if (found === undefined) {
    const folder = path.resolve(cwd, where);
    fail(exists(folder) ? `${folder} is not inside a git repository.` : `"${where}" in ${name} is neither a folder nor a repo address such as github.com/owner/repo.`);
  }
  if (found.main === undefined && !path.isAbsolute(found.repo) && repoAfterAt(cwd, found.repo)?.repo !== found.repo) {
    fail(`"${where}" in ${name} would be stored as ${found.repo}, which would not read back as the same repo.`);
  }
  return { slug, repo: found.repo };
}

/** The repo `where`, the text after the @ of a dependency, names from `cwd`; undefined for none. `main` is the main checkout a folder names. */
function repoAfterAt(cwd: string, where: string): { repo: string; main?: string } | undefined {
  const folder = path.resolve(cwd, where);
  if (exists(folder)) {
    const main = mainCheckout(folder);
    return main === undefined ? undefined : { repo: repoKey(main), main };
  }
  // A repo with no remote is keyed by its main checkout's path, which must stay usable after that checkout is gone.
  if (path.isAbsolute(where) && isRepoKeyShape(where)) return { repo: where };
  // Read in the shape of a key first, so a key this command stored, such as host:2222/r, names the same repo again.
  const unslashed = where.replace(/\/+$/, '');
  const address = isRepoKeyShape(unslashed) ? remoteKey(`https://${unslashed}`, cwd) : REMOTE_URL.test(where) ? remoteKey(where, cwd) : undefined;
  return address !== undefined && isRepoKeyShape(address) ? { repo: address } : undefined;
}

/** The tasks from `start` on, each one a dependency of the one before, up to one `isEnd` holds for; undefined for none. */
function dependencyPath(tasks: Task[], start: Required<Dependency>, isEnd: (dependency: Required<Dependency>) => boolean, seen = new Set<string>()): Required<Dependency>[] | undefined {
  if (isEnd(start)) return [start];
  const id = `${start.repo}\n${start.slug}`;
  if (seen.has(id)) return undefined;
  seen.add(id);
  const task = dependencyTask(tasks, start);
  for (const next of task === undefined ? [] : dependenciesOf(task)) {
    const rest = dependencyPath(tasks, next, isEnd, seen);
    if (rest !== undefined) return [start, ...rest];
  }
  return undefined;
}

/**
 * `ledger tree depends <child> [<task>...]`: replaces the tasks `child` waits for; none clears them. It refuses a task
 * that waits for itself, and any cycle through the dependencies of the ledgers it can read.
 */
export function setDependencies(context: Context, childName: string, names: string[]): DependsResult {
  const { cwd } = context;
  const childRef = taskRef(cwd, childName);
  const key = repoKey(childRef.main);
  const given = names.map((each) => dependencyFrom(cwd, key, each));
  const aliases = context.store.aliases.read();
  // By the key each names once its alias is resolved: an old key and the new one name one task.
  const idOf = ({ slug, repo }: Required<Dependency>): string => `${aliases.get(repo) ?? repo}\n${slug}`;
  const dependencies = given.filter((each, index) => given.findIndex((other) => idOf(other) === idOf(each)) === index).map(({ slug, repo }) => ({ slug, repo }));
  const tasks = findTasks(context.store);
  const child = theTask(tasks, childRef, { live: true });
  const name = dependencyName(cwd);
  const self = { slug: childRef.slug, repo: key };
  // By any key of its repo, as dependencyTask finds a task by an old key that is an alias now.
  const isSelf = ({ slug, repo }: Required<Dependency>): boolean => slug === self.slug && child.repoKeys.includes(repo);
  if (dependencies.some(isSelf)) fail(`${name(self)} cannot wait for itself.`);
  for (const dependency of dependencies) {
    const cycle = dependencyPath(tasks, dependency, isSelf);
    if (cycle !== undefined) fail(`${name(self)} cannot wait for ${name(dependency)}: that would make a cycle: ${[self, ...cycle].map(name).join(' → ')}.`);
  }
  const stored = dependencies.map(({ slug, repo }) => (repo === key ? { slug } : { slug, repo }));
  const unreadable = stored.find((dependency) => !isDeepStrictEqual(parseDependencies(showDependencies([dependency])), [dependency]));
  if (unreadable !== undefined) {
    fail(
      `The repo of ${unreadable.slug} has the key "${unreadable.repo}", which a ledger cannot hold as a dependency. A key is a host and path, such as github.com/owner/repo, or the path of a main checkout, with no empty folder, whitespace or comma. Nothing was changed.`,
    );
  }
  updateLedger(context, child, (text) => setLocationBullet(text, 'depends on', stored.length === 0 ? undefined : showDependencies(stored)) ?? fail(`${child.file} has no ## Location section.`));
  return { action: 'depends', child: childRef, dependencies };
}

export function dependsText({ cwd }: Context, { child, dependencies }: DependsResult): string {
  const waits = dependencies.length === 0 ? 'no task' : dependencies.map(dependencyName(cwd)).join(', ');
  return `${nameFrom(cwd)(child)} waits for ${waits}.`;
}
