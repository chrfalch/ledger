import { Argument, Command, CommanderError, Option } from 'commander';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimResultText, claimTask, Held, knownSession, releaseAll, releaseTask, requiredSession, touchAll, touchTask, type AllResult } from './claims.js';
import { fail, Failure } from './failure.js';
import { exists } from './files.js';
import { planProgress } from './format.js';
import { GATE_NAMES, gateQuestion } from './gates.js';
import { mainCheckout } from './git.js';
import { logHookFailure, oneLine } from './hook-failures.js';
import { answerHook, HOOK_EVENTS, sessionLedgers, sessionTitle, type HookContext, type HookEvent } from './hooks.js';
import { KINDS, STAGES } from './kinds.js';
import { ledgerBin, ledgerPaths, realPath } from './paths.js';
import { repoKey, repoLabel } from './repo-key.js';
import { migrateStorage } from './migrate.js';
import { migrateActive } from './migrate-active.js';
import { migrateRecords } from './migrate-records.js';
import { migrateRepoIds } from './migrate-repo-ids.js';
import { repairStore, SEARCH_DEPTH, type RepairContext } from './repair.js';
import {
  addConstraint,
  addConstraintText,
  addDecision,
  addDecisionText,
  addNote,
  addNoteText,
  addQuestion,
  addQuestionText,
  addStep,
  addStepText,
  approvePlan,
  approvePlanText,
  checkTask,
  count,
  LEDGER_SIZE_LIMIT,
  positive,
  recordStage,
  recordStageText,
  reportStep,
  reportStepText,
  reportToParent,
  reportToParentText,
  resolveQuestion,
  resolveQuestionText,
  setNext,
  setNextText,
  setStep,
  setStepText,
  TAGS,
  type Tag,
} from './notes.js';
import { openStore, openToRead } from './open-store.js';
import { loadTasks } from './registry.js';
import { retireTask, retireText } from './retire.js';
import { readStorage, STORAGES, type Storage } from './settings.js';
import { ownLedger, shownLedger } from './show.js';
import { sqliteFile } from './sqlite-store.js';
import type { LedgerStore } from './store.js';
import { initSync, syncInBackground, syncLedgers } from './sync.js';
import {
  autoPrune,
  listWorktrees,
  pruneOrphans,
  prunedFields,
  pruneReport,
  pruneWorktrees,
  worktreesView,
  type PruneReport,
} from './worktrees.js';
import { archivedTasks, childrenOf, taskRef, theTask, type Task } from './tasks.js';
import { archiveView, listView, parentView, writtenBranch, type ArchiveRow } from './views.js';
import {
  changeParent,
  createdText,
  createTask,
  currentTask,
  dependsText,
  goTask,
  goText,
  orderChildren,
  orderText,
  parentChangeText,
  parkTask,
  parkText,
  setDependencies,
  unparkTask,
  unparkText,
  waitingLines,
  type Context,
  type ParentAction,
  type TaskOptions,
} from './write.js';

const newestFirst = (a: Task, b: Task): number => b.mtimeMs - a.mtimeMs;

function listed(task: Task) {
  const { ledger } = task;
  const parent = ledger.location.parent;
  const parentMain = parent?.main ?? task.main;
  return {
    slug: task.slug,
    repo: task.repo,
    ...(task.currentRepo === undefined ? {} : { currentRepo: task.currentRepo }),
    ...(task.main === undefined ? {} : { main: task.main }),
    status: task.status,
    place: task.place,
    ...(task.worktree === undefined ? {} : { worktree: task.worktree }),
    ...(task.elsewhere ? { elsewhere: true } : {}),
    ...(task.host === undefined ? {} : { host: task.host }),
    branch: task.branch ?? '',
    ...(parent === undefined ? {} : { parent: { slug: parent.slug, ...(parentMain === undefined ? {} : { main: parentMain }) } }),
    updated: new Date(task.mtimeMs).toISOString(),
    goal: ledger.goal,
    next: ledger.next,
    ...planProgress(ledger),
    ...(ledger.parked === undefined ? {} : { parked: { date: ledger.parked.date, reason: ledger.parked.reason } }),
    ...(ledger.location.lost === undefined ? {} : { lost: ledger.location.lost }),
    ...(task.archived === undefined ? {} : { archived: task.archived }),
  };
}

/**
 * `value` with every `main` field at any depth as its real path. A ledger may name its repo through a symbolic link or
 * with a trailing slash, and the ledger plugin, which cannot resolve a path, compares mains as strings.
 */
function realMains<T>(value: T): T {
  if (Array.isArray(value)) return value.map(realMains) as T;
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, key === 'main' && typeof field === 'string' ? realPath(field) : realMains(field)])) as T;
}

/** The tasks of every known repo, newest first; retired ones only with `archived`. */
function list(context: Context, archived: boolean): Task[] {
  return loadTasks(context)
    .filter((task) => archived || task.place !== 'archive')
    .sort(newestFirst);
}

function firstMatch(task: Task, term: string): string | undefined {
  const needle = term.toLowerCase();
  return task.ledger.lines.find((line) => line.toLowerCase().includes(needle))?.trim();
}

/** `repo` is undefined for the archive of every repo. */
type ArchiveList = { repo?: string; term: string; folder: string; rows: ArchiveRow[] };

function archive({ cwd, store }: Context, term: string, everyRepo: boolean): ArchiveList {
  const main = everyRepo ? undefined : (mainCheckout(cwd) ?? fail(`Could not tell which repo ${cwd} is in. It is not inside a git repository. Add --all to list the archive of every repo.`));
  const repo = main === undefined ? undefined : repoKey(main);
  const rows: ArchiveRow[] = archivedTasks(store, repo).flatMap((task) => {
    if (!term) return [{ task }];
    const match = firstMatch(task, term);
    return match === undefined ? [] : [{ task, match }];
  });
  const date = ({ task }: ArchiveRow): string => task.archived ?? '';
  rows.sort((a, b) => date(b).localeCompare(date(a)) || b.task.mtimeMs - a.task.mtimeMs || a.task.slug.localeCompare(b.task.slug));
  return { ...(repo === undefined ? {} : { repo }), term, folder: store.archive.repoLocation(repo), rows };
}

const archiveFields = ({ repo, term, folder, rows }: ArchiveList) => ({
  repo: repo ?? null,
  term,
  folder,
  ledgers: rows.map(({ task, match }) => ({
    date: task.archived ?? '',
    repo: task.repo,
    slug: task.slug,
    path: task.file,
    branch: writtenBranch(task),
    goal: task.ledger.goal,
    ...(match === undefined ? {} : { match }),
  })),
});

function parent(context: Context, name: string) {
  const ref = taskRef(context.cwd, name);
  const { main } = ref;
  const tasks = loadTasks(context);
  const task = theTask(tasks, ref);
  return { task, main, children: childrenOf(task, main, tasks) };
}

/**
 * The ledgers a session in `folder` works on, as `ledger hook session-start` finds them; none when the folder is gone.
 * `main` is the main checkout of the repo that holds the folder.
 */
function session(store: LedgerStore, folder: string) {
  if (!exists(folder)) return { folder, removed: true, own: false, ledgers: [] };
  const found = sessionLedgers(store, folder);
  const title = sessionTitle(found);
  const main = mainCheckout(folder);
  return {
    folder,
    removed: false,
    ...(main === undefined ? {} : { main, repo: repoKey(main) }),
    own: found.own,
    ...(title === undefined ? {} : { title }),
    ledgers: found.tasks.map((task) => ({
      ...listed(task),
      children: task.ledger.children.map(({ slug, main, mark }) => ({
        slug,
        ...((main ?? task.main) === undefined ? {} : { main: main ?? task.main }),
        ...(mark === undefined ? {} : { mark }),
      })),
    })),
  };
}

function deploy(args: string[]): number {
  const script = fileURLToPath(new URL('../../bin/deploy', import.meta.url));
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  if (result.error) {
    console.error(`ledger deploy: ${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    console.error(`ledger deploy: bin/deploy terminated by ${result.signal}`);
    return 1;
  }
  return result.status ?? 1;
}

const JSON_HELP = 'print one JSON object: {"ok":true,...} or {"ok":false,"error":"..."}';
const sessionOption = (): Option => new Option('--session <id>', 'the Claude Code session; by default $CLAUDE_CODE_SESSION_ID');
const ACTIVE_SLUG = 'the active task in this repo, or <slug>@<path> for the repo at <path>; by default the task of the worktree you are in';

type ClaimsOptions = { session?: string; all?: boolean };

function sessionForAll(slug: string | undefined, session: string | undefined): string {
  if (slug !== undefined) fail(`--all acts on every active task of this repo, so it takes no slug: drop ${slug} or --all.`, 2);
  return requiredSession(session);
}

/** Runs the `ledger` command line `argv`, without the node and script paths, and returns its exit code. */
export async function main(argv: string[]): Promise<number> {
  const paths = ledgerPaths(process.env.HOME || homedir());
  const cwd = process.cwd();
  let store: LedgerStore | undefined;
  const context: Context = {
    paths,
    cwd,
    // Opened on first use, so help and deploy work with a broken settings file, and its error reaches the handler below.
    get store() {
      return (store ??= openStore(paths, readStorage(paths.home)));
    },
  };
  // From argv rather than the parsed options, so a command line commander refuses still gets a JSON answer.
  const json = argv.includes('--json');
  let exitCode = 0;
  const print = (text: string): void => {
    if (text !== '') console.log(text);
  };
  const printJson = (fields: object, error?: string): void => console.log(JSON.stringify(error === undefined ? { ok: true, ...fields } : { ok: false, error, ...fields }, null, 2));
  /** The result as JSON with --json, else as the text `view` makes of it. */
  const show = <T extends object>(result: T, view: (result: T) => string): void => (json ? printJson(result) : print(view(result)));
  const warn = (warnings: string[]): void => {
    if (!json) for (const warning of warnings) console.error(`warning: ${warning}`);
  };
  /** A folder skipped by a safety rule is no failure; one that could not be deleted is. */
  const printPruned = ({ text, failed }: PruneReport): void => {
    console.log(text);
    if (failed) exitCode = 1;
  };
  /** The tasks a `--all` touch or release changed, which stay changed when another task failed; then the failures, with exit 1. */
  const printAll = (key: 'touched' | 'released', { changed, failures }: AllResult): void => {
    const error = failures.length === 0 ? undefined : failures.join('\n');
    if (json) printJson({ [key]: changed }, error);
    else {
      print(changed.map((slug) => `${key} ${slug}`).join('\n'));
      if (error !== undefined) console.error(error);
    }
    if (error !== undefined) exitCode = 1;
  };

  // Shared by `ledger task <name>` and its short form `ledger <name>`, so the two cannot drift apart.
  const goCommand = (command: Command): Command =>
    command
      .description(
        "Start a task: a backlog task gets its worktree, and a branch from the ledger's \"- base:\" or the default branch; a parent starts its first backlog child. Claims the task for this session in this repo only; a live claim of another session exits 3 unless --take-over. Installs missing packages; a failed install exits 5 and keeps the worktree.",
      )
      .argument('<slug>', 'the task')
      .option('--repo <path>', 'start the task of the repo that holds <path>')
      .addOption(sessionOption())
      .option('--take-over', "take the claim over from the session that holds it live, and go on")
      .option('--json', JSON_HELP)
      .action((slug: string, { repo, session, takeOver = false }: { repo?: string; session?: string; takeOver?: boolean }) => {
        const started = goTask(context, slug, repo, { session: knownSession(session), takeOver });
        warn(started.warnings);
        if (json) printJson(realMains(started));
        else print(goText(context, started));
      });
  const listCommand = (command: Command): Command =>
    command
      .description('List the live tasks of every known repo: active, parked and backlog. Retired tasks are in ledger task archive.')
      .option('--archived', 'list the retired tasks too')
      .option('--json', JSON_HELP)
      .action(({ archived = false }: { archived?: boolean }) => {
        const tasks = list(context, archived);
        if (json) printJson({ tasks: realMains(tasks.map(listed)) });
        else console.log(listView(tasks));
      });
  const showCommand = (command: Command): Command =>
    command
      .description("Print a task's ledger from this repo: its active ledger, whichever clone holds its worktree, else its backlog ledger, else its newest archive copy.")
      .argument('[slug]', 'the task, or a full archive name <date>-<slug>[-N] for that one copy; by default the task of the worktree you are in')
      .option('--repo <repo>', 'read the ledgers of another repo: its key, such as github.com/me/app, an alias, or its short label, such as me/app')
      .addOption(new Option('--evidence [file]', "list the archive copy's evidence files, one path per line, or print the bytes of one").conflicts('json'))
      .option('--json', 'print one JSON object: {"ok":true,"repo":...,"name":...,"location":...,"text":...}')
      .action((slug: string | undefined, { repo, evidence }: { repo?: string; evidence?: string | true }) => {
        // Every failure goes to stderr as plain text, also with --json, whose stdout is only ever the ledger.
        try {
          if (slug === undefined && (repo !== undefined || evidence !== undefined)) fail('--repo and --evidence name a task of their own: ledger show <slug>');
          const found = slug === undefined ? ownLedger(context) : shownLedger(context, slug, { repo, archived: evidence !== undefined });
          if (evidence === true) process.stdout.write(context.store.archive.evidenceFiles(found.repo, found.name).map((file) => `${file}\n`).join(''));
          else if (evidence !== undefined) {
            const bytes = context.store.archive.readEvidence(found.repo, found.name, evidence) ?? fail(`${evidence} is not an evidence file of ${slug}, archived as ${found.name} in the repo ${repoLabel(found.repo)}.`);
            process.stdout.write(bytes);
          } else if (json) printJson({ repo: found.repo, name: found.name, location: found.location, ...(found.host === undefined ? {} : { host: found.host }), text: found.text });
          else {
            if (found.host !== undefined) console.log(`${found.name} is in a worktree on ${found.host}. This is a read-only copy of its ledger:`);
            process.stdout.write(found.text);
          }
        } catch (error) {
          if (!(error instanceof Failure)) throw error;
          console.error(error.message);
          exitCode = error.exitCode;
        }
      });

  const program = new Command('ledger').description('Read and change the task ledgers on this machine.').enablePositionalOptions().exitOverride();
  const taskGroup = program.command('task').description('Make, start, claim, park, retire and read tasks.');
  taskGroup
    .command('new')
    .description('Write a backlog ledger for a new task, from ~/.claude/ledger.template.md. /ledger:go <slug> starts it.')
    .argument('[slug]', 'the new task: lowercase letters, digits and hyphens; with --here, the branch name by default')
    .option('--goal <text>', 'one paragraph: the problem, then what done looks like')
    .option('--design-refs <n,n>', 'the LLP numbers for the "- design refs:" line, comma-separated')
    .option('--kind <kind>', `the kind of task for the "- kind:" line, which sets its stages: ${KINDS}; code by default`)
    .option('--stack', 'make the worktree and branch at once, on top of the current branch')
    .option('--here', 'add a ledger to this linked worktree instead; prints no start line')
    .option('--repo <path>', 'write the task for the repo that holds <path>')
    .option('--json', JSON_HELP)
    .action((slug: string | undefined, options: TaskOptions) => show(createTask(context, slug, options), createdText));
  goCommand(taskGroup.command('go'));
  taskGroup
    .command('claim')
    .description(
      'Mark an active task as worked on by this session: a "- claim:" line under ## Location. A claim with no activity for "claimExpiryMinutes" in ~/.claude/ledger-settings.json, 120 by default, has expired. Exits 3, with nothing changed, while another session holds a live claim.',
    )
    .argument('[slug]', ACTIVE_SLUG)
    .addOption(sessionOption())
    .option('--take-over', 'take the claim over from the session that holds it')
    .option('--from <id>', 'take the claim over from session <id> only, live or expired, as a session does from the one it continues after a /clear')
    .option('--json', JSON_HELP)
    .action((slug: string | undefined, { session, takeOver = false, from }: { session?: string; takeOver?: boolean; from?: string }) =>
      show(claimTask(context, slug, requiredSession(session), { takeOver, from }), claimResultText),
    );
  taskGroup
    .command('touch')
    .description("Mark this session's live claim on a task active now, once it was last marked 15 minutes ago or more. Any other claim, or none, stays as it is.")
    .argument('[slug]', ACTIVE_SLUG)
    .addOption(sessionOption())
    .option('--all', 'mark every live claim of this session on an active task of this repo; prints one touched <slug> line each')
    .option('--json', JSON_HELP)
    .action((slug: string | undefined, { session, all = false }: ClaimsOptions) => {
      if (all) return printAll('touched', touchAll(context, sessionForAll(slug, session)));
      show(touchTask(context, slug, requiredSession(session)), (result) => (result.touched ? `touched ${result.slug}` : ''));
    });
  taskGroup
    .command('release')
    .description("Remove this session's claim on a task, live or expired. Any other claim, or none, stays as it is.")
    .argument('[slug]', ACTIVE_SLUG)
    .addOption(sessionOption())
    .option('--all', 'remove every claim of this session, live or expired, from the active tasks of this repo; prints one released <slug> line each')
    .option('--json', JSON_HELP)
    .action((slug: string | undefined, { session, all = false }: ClaimsOptions) => {
      if (all) return printAll('released', releaseAll(context, sessionForAll(slug, session)));
      show(releaseTask(context, slug, requiredSession(session)), (result) => (result.released ? `released ${result.slug}` : 'not held by this session'));
    });
  taskGroup
    .command('park')
    .description('Mark a task parked: a "Parked: <date> — <reason>" line first under ## Next step. Its claim is removed.')
    .argument('<slug>', 'the task in this repo, or <slug>@<path> for the repo at <path>')
    .requiredOption('--reason <text>', 'why the task waits')
    .option('--json', JSON_HELP)
    .action((slug: string, { reason }: { reason: string }) => show(parkTask(context, slug, reason), parkText));
  taskGroup
    .command('unpark')
    .description('Remove the parked mark from a task.')
    .argument('<slug>', 'the task in this repo, or <slug>@<path> for the repo at <path>')
    .option('--json', JSON_HELP)
    .action((slug: string) => show(unparkTask(context, slug), unparkText));
  taskGroup
    .command('retire')
    .description(
      "Archive a task's ledger and evidence, remove its worktree or backlog ledger, mark it retired in its parent, and delete its merged branch and its Xcode build folders. Exits 1, with nothing changed, when a check stops it.",
    )
    .argument('[slug]', "the task in this repo; by default the task of the worktree you are in")
    .option('--dry-run', 'print what would be checked and done; it fetches the default branch from origin, and changes nothing else')
    .option('--force', 'retire it anyway with uncommitted changes, an unmerged branch or active children')
    .option('--json', JSON_HELP)
    .action((slug: string | undefined, { dryRun = false, force = false }: { dryRun?: boolean; force?: boolean }) => {
      const silent = { line: () => {}, warn: () => {} };
      show(json ? retireTask(context, slug, { dryRun, force }, silent) : retireTask(context, slug, { dryRun, force }), retireText);
    });
  showCommand(taskGroup.command('show'));
  listCommand(taskGroup.command('list'));
  taskGroup
    .command('archive')
    .description("List this repo's archived ledgers, newest first.")
    .argument('[term]', 'keep only the ledgers that contain this text, in any case')
    .option('--all', 'list the archive of every repo')
    .option('--json', JSON_HELP)
    .action((term: string | undefined, { all = false }: { all?: boolean }) => {
      const found = archive(context, term ?? '', all);
      if (json) printJson(archiveFields(found));
      else console.log(archiveView(found.rows, found.repo, found.term, `${paths.tilde(found.folder)}/`));
    });
  taskGroup
    .command('gate')
    .description('Print the question to ask the operator at a gate, as one AskUserQuestion question in JSON: the recommended action first, Close last.')
    .argument('<name>', `the gate: ${GATE_NAMES.join(', ')}`)
    .argument('[slug]', 'the task the question names; by default the task of the worktree you are in')
    .action((name: string, slug: string | undefined) => {
      print(JSON.stringify(gateQuestion(name, slug ?? currentTask(context.store, cwd)?.slug), null, 2));
    });

  const notesGroup = program
    .command('notes')
    .description("Write a task's ledger one item at a time. Each command checks the item and the whole ledger, and writes nothing when either is wrong; after a write, it warns of what ledger notes check finds.")
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  ledger notes plan add "write the tests" --owner opus-implementer',
        '  ledger notes step 1 --status done --note "reviewed"',
        '  ledger notes decide "Keep files" --because "they are simple" --tag observed',
        '  ledger notes question "Which port?" --blocks 2',
        '  ledger notes report --step 2 --file .claude/evidence/red.txt',
        '  ledger notes stage review fail --back build',
        '  ledger notes next "Review step 2 with reviewer" --task fix-login',
      ].join('\n'),
    );
  /** A notes command with the options every one takes. */
  const notesCommand = (parent: Command, name: string, description: string): Command =>
    parent
      .command(name)
      .description(description)
      .option('--task <slug>', 'the task in this repo, or <slug>@<path> for the repo at <path>; by default the task of the worktree you are in')
      .option('--json', JSON_HELP);
  const tagOption = (what: string): Option => new Option('--tag <tag>', `how the ${what} is known`).choices(TAGS);
  /** Prints a write: its warnings, on stderr or in the JSON, then the result. */
  const written = <T extends { warnings: string[] }>(result: T, view: (result: T) => string): void => {
    warn(result.warnings);
    show(result, view);
  };
  type TaskOption = { task?: string };

  const planGroup = notesGroup.command('plan').description('Add a step to the plan, or approve the plan.');
  notesCommand(planGroup, 'add', 'Add a step to the end of the plan, numbered after the highest step, with status todo.')
    .argument('<step>', 'what the step does')
    .requiredOption('--owner <agent>', 'the agent that does the step')
    .option('--note <text>', 'one line for the note column')
    .action((step: string, { owner, note, task }: TaskOption & { owner: string; note?: string }) => written(addStep(context, task, step, owner, note), addStepText));
  notesCommand(planGroup, 'approve', 'Mark the plan approved today, in place of any earlier date.').action(({ task }: TaskOption) => written(approvePlan(context, task), approvePlanText));
  notesCommand(notesGroup, 'step', 'Set the status of a plan step, or replace its note, or both.')
    .argument('<n>', 'the number of the step')
    .option('--status <status>', 'the new status, such as done')
    .option('--note <text>', 'one line for the note column, in place of the one there; "" clears it')
    .action((n: string, { status, note, task }: TaskOption & { status?: string; note?: string }) => written(setStep(context, task, positive(n, 'The step'), { status, note }), setStepText));
  notesCommand(notesGroup, 'decide', 'Add a decision, dated today, with its reason and how it is known.')
    .argument('<text>', 'the decision')
    .requiredOption('--because <reason>', 'why it was decided')
    .addOption(tagOption('decision').makeOptionMandatory())
    .action((text: string, { because, tag, task }: TaskOption & { because: string; tag: Tag }) => written(addDecision(context, task, text, because, tag), addDecisionText));
  notesCommand(notesGroup, 'constraint', 'Add a constraint that was found, with where it was found.')
    .argument('<text>', 'the constraint')
    .requiredOption('--source <where>', 'the file, report or person it comes from')
    .addOption(tagOption('constraint'))
    .action((text: string, { source, tag, task }: TaskOption & { source: string; tag?: Tag }) => written(addConstraint(context, task, text, source, tag), addConstraintText));
  notesCommand(notesGroup, 'question', 'Add an open question and print its number, or with --resolve mark one resolved. A question is numbered by its place in the list.')
    .argument('[text]', 'the question')
    .option('--blocks <n>', 'the plan step that waits for the answer')
    .option('--resolve <id>', 'the number of the question to mark resolved')
    .action((text: string | undefined, { blocks, resolve, task }: TaskOption & { blocks?: string; resolve?: string }) => {
      if (resolve === undefined) return written(addQuestion(context, task, text ?? '', blocks === undefined ? undefined : positive(blocks, '--blocks')), addQuestionText);
      if (text !== undefined || blocks !== undefined) fail('--resolve takes no question text and no --blocks.');
      written(resolveQuestion(context, task, positive(resolve, '--resolve')), resolveQuestionText);
    });
  notesCommand(notesGroup, 'report', "Record the report of a plan step as the path of its file, in place of an earlier one; or set the task's report to its parent.")
    .option('--step <n>', 'the plan step the report is for; needs --file')
    .option('--file <path>', 'the report file; the ledger keeps its path, relative to the worktree when inside it')
    .option('--parent <text>', 'the report to the parent task, which replaces the whole ## Report')
    .action(({ step, file, parent, task }: TaskOption & { step?: string; file?: string; parent?: string }) => {
      if (parent !== undefined) {
        if (step !== undefined || file !== undefined) fail('--parent takes no --step and no --file.');
        return written(reportToParent(context, task, parent), reportToParentText);
      }
      if (step === undefined || file === undefined) fail('ledger notes report needs --step <n> with --file <path>, or --parent <text>.');
      written(reportStep(context, task, positive(step, '--step'), file), reportStepText);
    });
  notesCommand(notesGroup, 'note', 'Add a general note.')
    .argument('<text>', 'the note')
    .action((text: string, { task }: TaskOption) => written(addNote(context, task, text), addNoteText));
  notesCommand(notesGroup, 'next', 'Set the next step, in place of the one there.')
    .argument('<text>', 'exactly one action, with the agent and effort to use')
    .action((text: string, { task }: TaskOption) => written(setNext(context, task, text), setNextText));
  const kindStages = Object.entries(STAGES)
    .map(([kind, stages]) => `${kind}: ${stages.join(', ')}`)
    .join('; ');
  notesCommand(
    notesGroup,
    'stage',
    `Record the outcome of the stage the task is at, and add a dated line to the notes. A task goes through the stages of its kind in order (${kindStages}); a task with no kind is code. Pass moves it to the next stage, or to finished after the last. Fail keeps it at the stage, or with --back returns it to an earlier one. A later stage is reached only by passing or skipping each one before it.`,
  )
    .argument('<stage>', 'the stage the task is at')
    .argument('[outcome]', 'pass or fail')
    .option('--back <stage>', 'with fail, the earlier stage to go back to')
    .option('--skip <reason>', 'in place of an outcome: pass the stage without doing its work, and why')
    .option('--step <n>', 'with pass or --skip, the plan step to mark: red after red, green after build, reviewed after review, done after any other stage')
    .action((stage: string, outcome: string | undefined, { back, skip, step, task }: TaskOption & { back?: string; skip?: string; step?: string }) =>
      written(recordStage(context, task, stage, { outcome, back, skip, step: step === undefined ? undefined : positive(step, '--step') }), recordStageText),
    );
  notesCommand(
    notesGroup,
    'check',
    `Check the ledger and change nothing: the record reads back the same from its Markdown, the goal is not empty, each open question and step report names a step of the plan, the kind and stage are known, and the ledger is at most ${count(LEDGER_SIZE_LIMIT)} characters. Prints ok, or each problem on a line and exits 1.`,
  ).action(({ task }: TaskOption) => {
    const checked = checkTask(context, task);
    const { problems } = checked;
    if (problems.length > 0) exitCode = 1;
    if (json) printJson(checked, problems.length > 0 ? problems.join('\n') : undefined);
    else print(problems.length > 0 ? problems.join('\n') : 'ok');
  });

  const parentSlug = 'the parent task in this repo, or <slug>@<path> for the repo at <path>';
  const childSlug = 'the child task, as <slug> or <slug>@<path>';
  const changeChildren = (slug: string, action: ParentAction, child?: string): void => {
    const change = changeParent(context, slug, action, child);
    if (!json && change.action === 'next' && change.chain.length === 0) {
      const { parent: from, blocked = [] } = change;
      console.error(
        blocked.length === 0 ? `No child task of ${from.slug} is left in the backlog.` : [`No child task of ${from.slug} can start yet:`, ...waitingLines(cwd, blocked).map((line) => `  ${line}`)].join('\n'),
      );
    }
    show(change, (done) => parentChangeText(context, done));
  };
  const treeGroup = program
    .command('tree')
    .description('Show a parent task and the status of each child task, or change its children.')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  ledger tree show epic                 show epic and its children',
        '  ledger tree show epic --json          the same, as one JSON object',
        '  ledger tree add epic fix-login        make fix-login a child of epic',
        '  ledger tree add epic part@../lib      make part, in the repo at ../lib, a child of epic',
        '  ledger tree remove epic part@../lib',
        '  ledger tree start epic fix-login      mark fix-login (started <date>) under ## Children',
        '  ledger tree order epic api fix-login  start api first, then fix-login',
        '  ledger tree depends fix-login api     fix-login starts only once api is retired',
        '  ledger tree depends fix-login         fix-login waits for no task',
        '  ledger tree next epic                 print the chain from epic to the child task that starts next',
        '',
        'A child task added with add goes after the others. The child that starts next is the first, in that order,',
        'that is still in the backlog and waits for no task that is not retired yet.',
      ].join('\n'),
    );
  treeGroup
    .command('show')
    .description('Show a parent task and the status of each child task.')
    .argument('<slug>', parentSlug)
    .option('--json', JSON_HELP)
    .action((slug: string) => {
      const { task, main: repo, children } = parent(context, slug);
      if (json) printJson({ slug: task.slug, main: repo, goal: task.ledger.goal, children });
      else console.log(parentView(task, repo, children));
    });
  const childChanges = [
    ['add', 'Make <child> a child task of <slug>, in the ledgers of both.'],
    ['remove', 'Remove <child> from the children of <slug>, in the ledgers of both.'],
    ['start', 'Mark <child> "(started <date>)" on its line under ## Children of <slug>.'],
  ] as const;
  for (const [action, description] of childChanges) {
    treeGroup
      .command(action)
      .description(description)
      .argument('<slug>', parentSlug)
      .argument('<child>', childSlug)
      .option('--json', JSON_HELP)
      .action((slug: string, child: string) => changeChildren(slug, action, child));
  }
  treeGroup
    .command('order')
    .description('Set the order the child tasks of <slug> start in: name each of them once, first to last.')
    .argument('<slug>', parentSlug)
    .argument('<child...>', 'each child task, as <slug> or <slug>@<path>; a retired child is left out')
    .option('--json', JSON_HELP)
    .action((slug: string, children: string[]) => show(orderChildren(context, slug, children), (done) => orderText(context, done)));
  treeGroup
    .command('depends')
    .description('Set the tasks <child> waits for: it starts only once each of them is retired. Name none to clear the list.')
    .argument('<child>', 'the task that waits, as <slug> or <slug>@<path>')
    .argument('[task...]', 'a task in the repo of <child>, <slug>@<path> for the repo at <path>, or <slug>@<address> for a repo by its address, such as api@github.com/acme/api')
    .option('--json', JSON_HELP)
    .action((child: string, tasks: string[]) => show(setDependencies(context, child, tasks), (done) => dependsText(context, done)));
  treeGroup
    .command('next')
    .description(
      'Print the chain from <slug> to the child task that starts next, such as "epic part": the first, by order, still in the backlog and waiting for no task that is not retired. Nothing when none is left; when every such child waits, stderr says what each waits for.',
    )
    .argument('<slug>', parentSlug)
    .option('--json', JSON_HELP)
    .action((slug: string) => changeChildren(slug, 'next'));

  const storeGroup = program.command('store').description('Change where the ledgers are kept, in files, in SQLite or in a private git repository, and sync that repository.');
  storeGroup
    .command('migrate')
    .description(
      'Move the backlog ledgers, the archive with its evidence, and the registry from one storage to the storage --to names. It copies everything, reads every copy back, and then sets "storage" in ~/.claude/ledger-settings.json. Exits 1, with nothing changed, when the target already has a name to copy. A move into or out of git storage commits and pushes; a failed push is reported, and ledger store sync pushes later. With --repo-ids instead, it files the ledgers kept under the folder name of a repo under its address, once. With --records instead, it rewrites each backlog and archive ledger still kept as Markdown as a task record, once; a line that fits no field of the record goes to its general notes. With --active instead, it moves the .claude/ledger.md of each linked worktree into an active record for that worktree, once, and deletes the file; .claude/evidence/ stays. Exits 1, with that ledger left as it is, when its slug or worktree is taken.',
    )
    .addOption(new Option('--to <storage>', 'the storage to move the ledgers to').choices(STORAGES))
    .addOption(new Option('--from <storage>', 'the storage to move the ledgers from; by default the one "storage" names, and when that is --to, the other of file and sqlite').choices(STORAGES))
    .addOption(
      new Option('--repo-ids', "file each ledger kept under a repo's folder name under the repo's address, or its path without a remote, and keep the folder name as an alias").conflicts(['to', 'from']),
    )
    .addOption(new Option('--records', 'rewrite each backlog and archive ledger kept as Markdown as a task record').conflicts(['to', 'from', 'repoIds']))
    .addOption(new Option('--active', 'move the .claude/ledger.md of each linked worktree into an active record').conflicts(['to', 'from', 'repoIds', 'records']))
    .addOption(new Option('--remove-source', 'remove what was copied from the other storage, after the check').conflicts(['repoIds', 'records', 'active']))
    .option('--dry-run', 'print what would be copied, moved, switched and removed, and change nothing')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  ledger store migrate --to sqlite --dry-run      show what moving to SQLite would copy',
        '  ledger store migrate --to sqlite                copy to SQLite and use it; the files stay',
        '  ledger store migrate --to file --remove-source  copy back to files, then empty the database',
        '  ledger store migrate --to git                   copy into the clone ledger store sync init made, commit and push',
        '  ledger store migrate --from git --to file       copy from git storage back to files',
        '  ledger store migrate --repo-ids --dry-run       show which ledgers would move to their repo address',
        '  ledger store migrate --records --dry-run        show which ledgers would become task records, and their lines left to notes',
        '  ledger store migrate --active --dry-run         show which .claude/ledger.md files would move into active records',
      ].join('\n'),
    )
    .action(
      ({
        to,
        from,
        repoIds = false,
        records = false,
        active = false,
        removeSource = false,
        dryRun = false,
      }: {
        to?: Storage;
        from?: Storage;
        repoIds?: boolean;
        records?: boolean;
        active?: boolean;
        removeSource?: boolean;
        dryRun?: boolean;
      }) => {
        if (repoIds || records || active) {
          // A dry run reads the store as it is: on SQLite it makes no database and adds no table; on git it repairs no hook
          // and commits and pushes nothing.
          const storage = readStorage(paths.home);
          const dryStore = dryRun && (storage !== 'sqlite' || exists(sqliteFile(paths.home))) ? openStore(paths, storage, { readOnly: true }) : undefined;
          const store = dryRun ? dryStore : context.store;
          try {
            const conflicts = active ? migrateActive(store, { dryRun, cwd, home: paths.home }, print) : (records ? migrateRecords : migrateRepoIds)(store, { dryRun }, print);
            if (conflicts > 0) exitCode = 1;
          } finally {
            dryStore?.close?.();
          }
          return;
        }
        migrateStorage(
          paths,
          to ?? fail('ledger store migrate needs --to <storage>, --repo-ids to file the ledgers under repo addresses, --records to make them task records, or --active to move .claude/ledger.md files into the store.'),
          { from, removeSource, dryRun },
          print,
        );
      },
    );
  storeGroup
    .command('repair')
    .description(
      'Find the active tasks whose recorded folder is gone, and the repo keys whose remote was renamed, and print the command that fixes each; it searches the disk only with --search, and only in the folders named. With a task, point it at the folder it moved to, or mark it lost. With --remote, file every task of an old repo key under the key of this repo. Exits 1 when it finds a problem, or leaves one.',
    )
    .argument('[slug]', 'the task to repair, or <slug>@<path> for the repo at <path>')
    .addOption(new Option('--search <folder...>', `look in these folders, ${SEARCH_DEPTH} levels down, for a checkout on the branch of each task whose folder is gone`))
    .addOption(new Option('--to <folder>', "point <slug> at <folder>, a checkout on its branch, and run git worktree repair there").conflicts('search'))
    .addOption(new Option('--lost', 'mark <slug> lost: its folder is gone for good').conflicts(['to', 'search']))
    .addOption(new Option('--remote <old-key>', 'file every task of the repo key <old-key> under the key of this repo, and keep <old-key> as its alias').conflicts(['to', 'lost', 'search']))
    .option('--dry-run', 'print what --to, --lost or --remote would change, and change nothing')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  ledger store repair                                   list the problems and the command for each',
        '  ledger store repair --search ~/repos ~/issues         also look there for each folder that is gone',
        '  ledger store repair fix-login --to ../wt/fix-login    point fix-login at the folder it moved to',
        '  ledger store repair fix-login@../lib --lost           mark the task fix-login of the repo at ../lib lost',
        '  ledger store repair --remote github.com/me/old --dry-run',
        '                                                        show which tasks of the old key would move to this repo',
      ].join('\n'),
    )
    .action((slug: string | undefined, options: { to?: string; lost?: boolean; remote?: string; search?: string[]; dryRun?: boolean }) => {
      const repair = { ...options, lost: options.lost ?? false, dryRun: options.dryRun ?? false };
      // Every check reads a read-only store, so the report, a dry run and a refusal make no SQLite database, repair no
      // git hook, and commit nothing.
      let reading: LedgerStore | undefined;
      const repairContext: RepairContext = {
        paths,
        cwd,
        get store() {
          reading ??= openToRead(paths, readStorage(paths.home));
          return reading;
        },
        writable: () => context.store,
      };
      try {
        if (repairStore(repairContext, slug, repair, print) > 0) exitCode = 1;
      } finally {
        reading?.close?.();
      }
    });
  const sync = storeGroup
    .command('sync')
    .description(
      'Push the ledgers of git storage to their private GitHub repository, and pull those of your other machines: it commits, pulls with a rebase, checks that only ledgers and no secret-like text go out, and pushes. Exits 1, with nothing pushed, when a check or the pull stops it.',
    )
    .option('--quiet', 'print nothing, and only record a problem in ~/.claude/ledger-data.status.json; for the push after each command')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  ledger store sync init https://github.com/<you>/ledgers.git   set up git storage from an empty private repository',
        '  ledger store sync                                              commit, pull and push now',
      ].join('\n'),
    )
    .action(({ quiet = false }: { quiet?: boolean }) => {
      if (!quiet) return syncLedgers(paths, print);
      try {
        syncInBackground(paths);
      } catch {
        exitCode = 1;
      }
    });
  sync
    .command('init')
    .description(
      'Set up git storage: check with gh that the GitHub repository is private, and clone it to ~/.claude/ledger-data. An empty repository gets a .ledger-data marker and a .gitignore, pushed at once; a repository another machine set up is used as it is; the clone gets a pre-push hook of its own that blocks secret-like text; any other repository is refused. The storage setting stays as it is: ledger store migrate --to git switches it.',
    )
    .argument('<url>', 'the private repository, as https://github.com/<owner>/<repo>.git or git@github.com:<owner>/<repo>.git')
    .action((url: string) => initSync(paths, url, print));

  const worktrees = program
    .command('worktrees')
    .description("Show each linked worktree of this repo with its size, last commit, uncommitted files, ledger and PR, largest first; or prune its build folders.");
  worktrees
    .command('table', { isDefault: true, hidden: true })
    .option('--json', JSON_HELP)
    .action(() => show(listWorktrees(context), worktreesView));
  worktrees
    .command('prune')
    .description(
      'Delete the git-ignored build folders (.build, .expo-prebuild, .cache, build, .DerivedData) of a linked worktree and its Xcode build folder in .claude/worktrees/.build of the main checkout, those of 0.05 GB or more. Nothing else in .claude, and nothing in node_modules or Pods, is deleted.',
    )
    .argument('[name]', 'the linked worktree, by its folder name')
    .option('--all', 'prune every linked worktree')
    .option('--dry-run', 'only list the folders')
    .option('--json', JSON_HELP)
    .action((name: string | undefined, { all = false, dryRun = false }: { all?: boolean; dryRun?: boolean }) => {
      const run = pruneWorktrees(context, name, { all, dryRun });
      if (!json) return printPruned(pruneReport(run));
      const fields = run.worktrees.map(prunedFields);
      const problems = fields.flatMap(({ error, failures }) => [...(error === undefined ? [] : [error]), ...failures]);
      if (problems.length > 0) exitCode = 1;
      printJson({ all, dryRun, worktrees: fields }, problems.length > 0 ? problems.join('\n') : undefined);
    });
  worktrees
    .command('prune-orphans')
    .description('Delete the Xcode build folders in .claude/worktrees/.build whose worktree git no longer lists. The main checkout keeps its folder, .main.')
    .option('--dry-run', 'only list the folders')
    .action(({ dryRun = false }: { dryRun?: boolean }) => printPruned(pruneOrphans(context, dryRun)));
  worktrees
    .command('auto-prune', { hidden: true })
    .description(
      `Prune the build folders of a finished task's linked worktree once, in the background, and mark it with .claude/build-folders-pruned; a task whose plan is reopened loses the mark. Prints a line only when it did something; a folder with no ledger of its own is outcome no-ledger.`,
    )
    .argument('[worktree]', 'the linked worktree of the task; by default the one you are in')
    .option('--json', JSON_HELP)
    .action((worktree: string | undefined) => {
      // Claude Code runs this at every turn end, also in a session that has no ledger; that is no failure.
      const folder = worktree === undefined ? currentTask(context.store, cwd)?.worktree : path.resolve(cwd, worktree);
      if (folder === undefined) return show({ outcome: 'no-ledger', folder: cwd, finished: false }, () => '');
      show(autoPrune(context, folder), (result) => result.message ?? '');
    });

  goCommand(program.command('go'));
  listCommand(program.command('list'));
  showCommand(program.command('show'));
  program
    .command('session', { hidden: true })
    .description('Print the tasks a Claude Code session in a folder works on, as the session-start hook finds them: the worktree of each, one per line.')
    .argument('[folder]', 'the session folder; by default the one you are in')
    .option('--json', JSON_HELP)
    .action((folder: string | undefined) =>
      show(realMains(session(context.store, folder === undefined ? cwd : path.resolve(cwd, folder))), ({ ledgers }) => ledgers.flatMap(({ worktree }) => worktree ?? []).join('\n')),
    );
  program
    .command('hook', { hidden: true })
    .description('Answer a Claude Code hook: read its JSON input on stdin and print the hook output. For settings.json, not for a person.')
    .addArgument(new Argument('<event>', 'the hook event').choices(HOOK_EVENTS))
    .action((event: HookEvent) => {
      // Not { ...context }, which would open the store before the hook's time limit starts.
      const hookContext: HookContext = {
        paths,
        cwd,
        ledgerBin,
        get store() {
          return context.store;
        },
      };
      try {
        process.stdout.write(answerHook(event, readFileSync(0, 'utf8'), hookContext));
      } catch (error) {
        // Exit 0 with no output: Claude Code then allows the tool call and injects nothing. Exit 2 would block the tool call.
        const message = oneLine(error instanceof Error ? error.message : String(error));
        console.error(`ledger hook ${event}: ${message}`);
        logHookFailure(paths.home, `ledger hook ${event}`, message);
      }
    });
  program
    .command('deploy')
    .description('Run bin/deploy from this repo; options pass through.')
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      exitCode = deploy(argv.slice(argv.indexOf('deploy') + 1));
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (json && error.exitCode !== 0) printJson({}, error.message);
      return error.exitCode;
    }
    if (error instanceof Failure) {
      if (json) printJson(error instanceof Held ? { held: error.held } : {}, error.message);
      else console.error(error.message);
      return error.exitCode;
    }
    if (!json) throw error;
    printJson({}, error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    store?.close?.();
  }
  return exitCode;
}
