import { Argument, Command, CommanderError, Option } from 'commander';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, Failure } from './failure.js';
import { exists } from './files.js';
import { planProgress } from './format.js';
import { GATE_NAMES, gateQuestion } from './gates.js';
import { mainCheckout } from './git.js';
import { logHookFailure, oneLine } from './hook-failures.js';
import { answerHook, HOOK_EVENTS, sessionLedgers, sessionTitle, type HookContext, type HookEvent } from './hooks.js';
import { ledgerBin, ledgerPaths, realPath } from './paths.js';
import { repoKey, repoLabel } from './repo-key.js';
import { migrateStorage } from './migrate.js';
import { migrateRepoIds } from './migrate-repo-ids.js';
import { openStore } from './open-store.js';
import { loadTasks } from './registry.js';
import { retireTask, retireText } from './retire.js';
import { readStorage, STORAGES, type Storage } from './settings.js';
import { shownLedger } from './show.js';
import { sqliteFile, sqliteStore } from './sqlite-store.js';
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
  goTask,
  goText,
  parentChangeText,
  parkTask,
  parkText,
  unparkTask,
  unparkText,
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
    ...(task.main === undefined ? {} : { main: task.main }),
    status: task.status,
    path: task.file,
    branch: task.branch ?? '',
    ...(parent === undefined ? {} : { parent: { slug: parent.slug, ...(parentMain === undefined ? {} : { main: parentMain }) } }),
    updated: new Date(task.mtimeMs).toISOString(),
    goal: ledger.goal,
    next: ledger.next,
    ...planProgress(ledger),
    ...(ledger.parked === undefined ? {} : { parked: { date: ledger.parked.date, reason: ledger.parked.reason } }),
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
  const here = mainCheckout(context.cwd);
  return loadTasks(context, here === undefined ? [] : [here])
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
  const tasks = loadTasks(context, [main]);
  const task = theTask(tasks, ref);
  return { task, main, children: childrenOf(task, main, tasks) };
}

/**
 * The ledgers a session in `folder` works on, as `ledger hook session-start` finds them; none when the folder is gone.
 * `main` is the main checkout of the repo that holds the folder.
 */
function session(folder: string) {
  if (!exists(folder)) return { folder, removed: true, own: false, ledgers: [] };
  const found = sessionLedgers(folder);
  const title = sessionTitle(found);
  const main = mainCheckout(folder);
  return {
    folder,
    removed: false,
    ...(main === undefined ? {} : { main }),
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

/** The ledger of the linked worktree that holds `cwd`, if it has one. */
function ownLedger(cwd: string): string | undefined {
  const { tasks, own } = sessionLedgers(cwd);
  return own && tasks.length === 1 ? tasks[0].file : undefined;
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

  // Shared by `ledger task <name>` and its short form `ledger <name>`, so the two cannot drift apart.
  const goCommand = (command: Command): Command =>
    command
      .description(
        "Start a task: a parent starts its first child still in the backlog; a backlog task gets its worktree and branch, and its ledger moves there; a task with a worktree is only gone to. Then its parked mark is removed and its parent marks it started. The branch starts at the ledger's \"- base:\" when it names one, else at the default branch.",
      )
      .argument('<slug>', 'the task')
      .option('--repo <path>', 'start the task of the repo that holds <path>')
      .option('--json', JSON_HELP)
      .action((slug: string, { repo }: { repo?: string }) => {
        const started = goTask(context, slug, repo);
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
      .description("Print a task's ledger: its worktree ledger in this clone, else its backlog ledger in this repo, else its newest archive copy.")
      .argument('<slug>', 'the task, or a full archive name <date>-<slug>[-N] for that one copy')
      .option('--repo <repo>', 'read the ledgers of another repo: its key, such as github.com/me/app, an alias, or its short label, such as me/app')
      .addOption(new Option('--evidence [file]', "list the archive copy's evidence files, one path per line, or print the bytes of one").conflicts('json'))
      .option('--json', 'print one JSON object: {"ok":true,"repo":...,"name":...,"location":...,"text":...}')
      .action((slug: string, { repo, evidence }: { repo?: string; evidence?: string | true }) => {
        // Every failure goes to stderr as plain text, also with --json, whose stdout is only ever the ledger.
        try {
          const found = shownLedger(context, slug, { repo, archived: evidence !== undefined });
          if (evidence === true) process.stdout.write(context.store.archive.evidenceFiles(found.repo, found.name).map((file) => `${file}\n`).join(''));
          else if (evidence !== undefined) {
            const bytes = context.store.archive.readEvidence(found.repo, found.name, evidence) ?? fail(`${evidence} is not an evidence file of ${slug}, archived as ${found.name} in the repo ${repoLabel(found.repo)}.`);
            process.stdout.write(bytes);
          } else if (json) printJson({ repo: found.repo, name: found.name, location: found.location, text: found.text });
          else process.stdout.write(found.text);
        } catch (error) {
          if (!(error instanceof Failure)) throw error;
          console.error(error.message);
          exitCode = error.exitCode;
        }
      });

  const program = new Command('ledger').description('Read and change the task ledgers on this machine.').enablePositionalOptions().exitOverride();
  const taskGroup = program.command('task').description('Make, start, park, retire and read tasks.');
  taskGroup
    .command('new')
    .description('Write a backlog ledger for a new task, from ~/.claude/ledger.template.md. /ledger:go <slug> starts it.')
    .argument('[slug]', 'the new task: lowercase letters, digits and hyphens; with --here, the branch name by default')
    .option('--goal <text>', 'one paragraph: the problem, then what done looks like')
    .option('--design-refs <n,n>', 'the LLP numbers for the "- design refs:" line, comma-separated')
    .option('--stack', 'make the worktree and branch at once, on top of the current branch')
    .option('--here', 'add a ledger to this linked worktree instead; prints no start line')
    .option('--repo <path>', 'write the task for the repo that holds <path>')
    .option('--json', JSON_HELP)
    .action((slug: string | undefined, options: TaskOptions) => show(createTask(context, slug, options), createdText));
  goCommand(taskGroup.command('go'));
  taskGroup
    .command('park')
    .description('Mark a task parked: a "Parked: <date> — <reason>" line first under ## Next step.')
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
      const { tasks, own } = sessionLedgers(cwd);
      const here = own && tasks.length === 1 ? tasks[0].slug : undefined;
      print(JSON.stringify(gateQuestion(name, slug ?? here), null, 2));
    });

  const parentSlug = 'the parent task in this repo, or <slug>@<path> for the repo at <path>';
  const childSlug = 'the child task, as <slug> or <slug>@<path>';
  const changeChildren = (slug: string, action: ParentAction, child?: string): void => {
    const change = changeParent(context, slug, action, child);
    if (!json && change.action === 'next' && change.chain.length === 0) console.error(`No child task of ${change.parent.slug} is left in the backlog.`);
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
        '  ledger tree next epic                 print the chain from epic to its first child still in the backlog',
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
    .command('next')
    .description('Print the chain from <slug> to its first child task still in the backlog, such as "epic part"; nothing when none is left.')
    .argument('<slug>', parentSlug)
    .option('--json', JSON_HELP)
    .action((slug: string) => changeChildren(slug, 'next'));

  const storeGroup = program.command('store').description('Change where the ledgers are kept, in files, in SQLite or in a private git repository, and sync that repository.');
  storeGroup
    .command('migrate')
    .description(
      'Move the backlog ledgers, the archive with its evidence, and the registry from one storage to the storage --to names. It copies everything, reads every copy back, and then sets "storage" in ~/.claude/ledger-settings.json. Exits 1, with nothing changed, when the target already has a name to copy. A move into or out of git storage commits and pushes; a failed push is reported, and ledger store sync pushes later. With --repo-ids instead, it files the ledgers kept under the folder name of a repo under its address, once.',
    )
    .addOption(new Option('--to <storage>', 'the storage to move the ledgers to').choices(STORAGES))
    .addOption(new Option('--from <storage>', 'the storage to move the ledgers from; by default the one "storage" names, and when that is --to, the other of file and sqlite').choices(STORAGES))
    .addOption(
      new Option('--repo-ids', "file each ledger kept under a repo's folder name under the repo's address, or its path without a remote, and keep the folder name as an alias").conflicts(['to', 'from']),
    )
    .addOption(new Option('--remove-source', 'remove what was copied from the other storage, after the check').conflicts('repoIds'))
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
      ].join('\n'),
    )
    .action(
      ({ to, from, repoIds = false, removeSource = false, dryRun = false }: { to?: Storage; from?: Storage; repoIds?: boolean; removeSource?: boolean; dryRun?: boolean }) => {
        if (repoIds) {
          // A dry run on SQLite reads the database as it is: it makes none, and adds no table.
          const sqliteDryRun = dryRun && readStorage(paths.home) === 'sqlite';
          const dryStore = sqliteDryRun && exists(sqliteFile(paths.home)) ? sqliteStore(paths, { readOnly: true }) : undefined;
          try {
            if (migrateRepoIds(sqliteDryRun ? dryStore : context.store, { dryRun }, print) > 0) exitCode = 1;
          } finally {
            dryStore?.close?.();
          }
          return;
        }
        migrateStorage(paths, to ?? fail('ledger store migrate needs --to <storage>, or --repo-ids to file the ledgers under repo addresses.'), { from, removeSource, dryRun }, print);
      },
    );
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
    .argument('[ledger]', 'the task ledger; by default the one of the linked worktree you are in')
    .option('--json', JSON_HELP)
    .action((ledger: string | undefined) => {
      // Claude Code runs this at every turn end, also in a session that has no ledger; that is no failure.
      const file = ledger === undefined ? ownLedger(cwd) : path.resolve(cwd, ledger);
      if (file === undefined) return show({ outcome: 'no-ledger', folder: cwd, finished: false }, () => '');
      show(autoPrune(context, file), (result) => result.message ?? '');
    });

  goCommand(program.command('go'));
  listCommand(program.command('list'));
  showCommand(program.command('show'));
  program
    .command('session', { hidden: true })
    .description('Print the ledgers a Claude Code session in a folder works on, as the session-start hook finds them: one path per line.')
    .argument('[folder]', 'the session folder; by default the one you are in')
    .option('--json', JSON_HELP)
    .action((folder: string | undefined) => show(realMains(session(folder === undefined ? cwd : path.resolve(cwd, folder))), ({ ledgers }) => ledgers.map(({ path: file }) => file).join('\n')));
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
      if (json) printJson({}, error.message);
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
