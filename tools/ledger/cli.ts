import { Command, CommanderError } from 'commander';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fail, Failure } from './failure.js';
import { mainCheckout } from './git.js';
import { fileStore } from './file-store.js';
import { ledgerPaths, repoName } from './paths.js';
import { loadTasks } from './registry.js';
import { retireTask } from './retire.js';
import { derivedDataView, pruneOrphans, pruneWorktrees, worktreesTable, type PruneReport } from './worktrees.js';
import { archivedTasks, childrenOf, taskRef, theTask, type Task } from './tasks.js';
import { archiveView, listView, parentView, type ArchiveRow } from './views.js';
import { changeParent, createTask, goTask, parkTask, unparkTask, type Context, type TaskOptions } from './write.js';

const newestFirst = (a: Task, b: Task): number => b.mtimeMs - a.mtimeMs;

function listed(task: Task) {
  const parent = task.ledger.location.parent;
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
    goal: task.ledger.goal,
    next: task.ledger.next,
  };
}

function list(context: Context, json: boolean): string {
  const here = mainCheckout(context.cwd);
  const tasks = loadTasks(context, here === undefined ? [] : [here])
    .filter((task) => task.place !== 'archive')
    .sort(newestFirst);
  return json ? JSON.stringify(tasks.map(listed), null, 2) : listView(tasks);
}

function firstMatch(task: Task, term: string): string | undefined {
  const needle = term.toLowerCase();
  return task.ledger.lines.find((line) => line.toLowerCase().includes(needle))?.trim();
}

function archive({ paths, cwd, store }: Context, term: string, everyRepo: boolean): string {
  const main = everyRepo ? undefined : (mainCheckout(cwd) ?? fail(`Could not tell which repo ${cwd} is in. It is not inside a git repository. Add --all to list the archive of every repo.`));
  const repo = main === undefined ? undefined : repoName(main);
  const rows: ArchiveRow[] = archivedTasks(store, repo).flatMap((task) => {
    if (!term) return [{ task }];
    const match = firstMatch(task, term);
    return match === undefined ? [] : [{ task, match }];
  });
  const date = ({ task }: ArchiveRow): string => task.archived ?? '';
  rows.sort((a, b) => date(b).localeCompare(date(a)) || b.task.mtimeMs - a.task.mtimeMs || a.task.slug.localeCompare(b.task.slug));
  const folder = `${paths.tilde(store.archive.repoLocation(repo))}/`;
  return archiveView(rows, repo, term, folder);
}

function parent(context: Context, name: string, json: boolean): string {
  const ref = taskRef(context.cwd, name);
  const { main } = ref;
  const tasks = loadTasks(context, [main]);
  const task = theTask(tasks, ref);
  const children = childrenOf(task, main, tasks);
  if (!json) return parentView(task, main, children);
  return JSON.stringify({ slug: task.slug, main, goal: task.ledger.goal, children }, null, 2);
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

/** Runs the `ledger` command line `argv`, without the node and script paths, and returns its exit code. */
export async function main(argv: string[]): Promise<number> {
  const paths = ledgerPaths(process.env.HOME || homedir());
  const cwd = process.cwd();
  const context: Context = { paths, cwd, store: fileStore(paths) };
  let exitCode = 0;
  const print = (text: string): void => {
    if (text !== '') console.log(text);
  };
  /** A folder skipped by a safety rule is no failure; one that could not be deleted is. */
  const printPruned = ({ text, failed }: PruneReport): void => {
    console.log(text);
    if (failed) exitCode = 1;
  };

  const program = new Command('ledger').description('Read and change the task ledgers on this machine.').enablePositionalOptions().exitOverride();
  program
    .command('list')
    .description('List the live tasks of every known repo: active, parked and backlog. Retired tasks are in ledger archive.')
    .option('--json', 'print the tasks as JSON')
    .action(({ json = false }: { json?: boolean }) => console.log(list(context, json)));
  program
    .command('archive')
    .description("List this repo's archived ledgers, newest first.")
    .argument('[term]', 'keep only the ledgers that contain this text, in any case')
    .option('--all', 'list the archive of every repo')
    .action((term: string | undefined, { all = false }: { all?: boolean }) => console.log(archive(context, term ?? '', all)));
  program
    .command('parent')
    .description('Show a parent task and the status of each child task, or change its children.')
    .argument('<slug>', 'the parent task in this repo, or <slug>@<path> for the repo at <path>')
    .argument('[action]', 'add or remove links a child or drops it; start marks a child started; next prints the first child still in the backlog')
    .argument('[child]', 'the child task for add, remove and start, as <slug> or <slug>@<path>')
    .option('--json', 'print the parent and its children as JSON, when no action is given')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  ledger parent epic                 show epic and its children',
        '  ledger parent epic add fix-login   make fix-login a child of epic',
        '  ledger parent epic add part@../lib make part, in the repo at ../lib, a child of epic',
        '  ledger parent epic remove part@../lib',
        '  ledger parent epic start fix-login mark fix-login (started <date>) under ## Children',
        '  ledger parent epic next            print the chain from epic to its first child still in the backlog',
      ].join('\n'),
    )
    .action((slug: string, action: string | undefined, child: string | undefined, { json = false }: { json?: boolean }) => {
      if (action === undefined) return console.log(parent(context, slug, json));
      if (json) fail('--json only goes with showing a parent: ledger parent <slug> --json');
      print(changeParent(context, slug, action, child));
    });
  program
    .command('task')
    .description('Write a backlog ledger for a new task, from ~/.claude/ledger.template.md. /ledger:go <slug> starts it.')
    .argument('[slug]', 'the new task: lowercase letters, digits and hyphens; with --here, the branch name by default')
    .option('--goal <text>', 'one paragraph: the problem, then what done looks like')
    .option('--stack', 'make the worktree and branch at once, on top of the current branch')
    .option('--here', 'add a ledger to this linked worktree instead; prints no start line')
    .option('--repo <path>', 'write the task for the repo that holds <path>')
    .action((slug: string | undefined, options: TaskOptions) => print(createTask(context, slug, options)));
  program
    .command('go')
    .description(
      "Start a backlog task: make its worktree and branch, and move its ledger there. The branch starts at the ledger's \"- base:\" when it names one, else at the default branch.",
    )
    .argument('<slug>', 'the backlog task')
    .option('--repo <path>', 'start the task of the repo that holds <path>')
    .action((slug: string, { repo }: { repo?: string }) => print(goTask(context, slug, repo)));
  program
    .command('park')
    .description('Mark a task parked: a "Parked: <date> — <reason>" line first under ## Next step.')
    .argument('<slug>', 'the task in this repo, or <slug>@<path> for the repo at <path>')
    .requiredOption('--reason <text>', 'why the task waits')
    .action((slug: string, { reason }: { reason: string }) => print(parkTask(context, slug, reason)));
  program
    .command('unpark')
    .description('Remove the parked mark from a task.')
    .argument('<slug>', 'the task in this repo, or <slug>@<path> for the repo at <path>')
    .action((slug: string) => print(unparkTask(context, slug)));
  program
    .command('retire')
    .description(
      "Archive a task's ledger and evidence, remove its worktree or backlog ledger, mark it retired in its parent, and delete its merged branch and its Xcode build folders. Exits 1, with nothing changed, when a check stops it.",
    )
    .argument('[slug]', "the task in this repo; by default the task of the worktree you are in")
    .option('--dry-run', 'print what would be checked and done; it fetches the default branch from origin, and changes nothing else')
    .option('--force', 'retire it anyway with uncommitted changes, an unmerged branch or active children')
    .action((slug: string | undefined, { dryRun = false, force = false }: { dryRun?: boolean; force?: boolean }) => print(retireTask(context, slug, { dryRun, force })));
  const worktrees = program
    .command('worktrees')
    .description("Show each linked worktree of this repo with its size, last commit, uncommitted files, ledger and PR, largest first; or prune its build folders.");
  worktrees.command('table', { isDefault: true, hidden: true }).action(() => console.log(worktreesTable(context)));
  worktrees
    .command('prune')
    .description(
      'Delete the git-ignored build folders (.build, .expo-prebuild, .cache, build, .DerivedData) and own Xcode build folders of a linked worktree, those of 0.05 GB or more. Nothing in .claude, node_modules or Pods is deleted.',
    )
    .argument('[name]', 'the linked worktree, by its folder name')
    .option('--all', 'prune every linked worktree')
    .option('--dry-run', 'only list the folders')
    .action((name: string | undefined, { all = false, dryRun = false }: { all?: boolean; dryRun?: boolean }) => printPruned(pruneWorktrees(context, name, { all, dryRun })));
  worktrees
    .command('derived-data')
    .description("Group the folders in ~/Library/Developer/Xcode/DerivedData by the project they were built from: this repo's main checkout, a linked worktree, elsewhere, or gone.")
    .action(() => console.log(derivedDataView(context)));
  worktrees
    .command('prune-orphans')
    .description('Delete the DerivedData folders whose project is gone from a connected disk.')
    .option('--dry-run', 'only list the folders')
    .action(({ dryRun = false }: { dryRun?: boolean }) => printPruned(pruneOrphans(context, dryRun)));
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
    if (error instanceof CommanderError) return error.exitCode;
    if (error instanceof Failure) {
      console.error(error.message);
      return error.exitCode;
    }
    throw error;
  }
  return exitCode;
}
