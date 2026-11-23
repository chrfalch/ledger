import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { format } from 'node:util';
import { cancel, type CANCEL_SYMBOL, confirm, intro, isCancel, log, multiselect, note, outro, select } from '@clack/prompts';
import pc from 'picocolors';
import { ALL_AGENTS, CODEX_AGENTS, deploy, DeployError, MIGRATE_HINT, MODELS, moveText, parseDeployArguments, pendingMoves, printedLines, runLedger, runMoves, type PendingMove } from './deploy.js';

const COMPONENTS = [
  { value: 'codex', label: 'Codex', flag: '--no-codex' },
  { value: 'argent', label: 'Argent UI automation', flag: '--no-argent' },
  { value: 'stacks', label: 'Stacked-PR rule', flag: '--no-stacks' },
  { value: 'githooks', label: 'Git hook guard', flag: '--no-githooks' },
  { value: 'mods', label: 'Ledger mod (/ledger)', flag: '--no-mods' },
] as const;
const ALL_MODELS = MODELS.split(',');

type Component = (typeof COMPONENTS)[number]['value'];
export type Components = Record<Component, boolean>;

type Answers =
  | { action: 'revert'; dryRun?: boolean }
  | { action: 'migrate'; dryRun?: boolean }
  | { action: 'deploy'; components: Components; agents: string[]; models: string[]; force?: boolean; dryRun?: boolean };

interface Environment {
  codex: boolean;
  argent: boolean;
  stacks: boolean;
  claude: boolean;
  hooksPath: string;
}

class Cancelled extends Error {}

function impliedAgents(components: Components): string[] {
  return ALL_AGENTS.filter((agent) => (components.codex || !CODEX_AGENTS.includes(agent)) && (components.argent || agent !== 'ui-runner'));
}

function inOrder(source: string[], selected: string[]): string[] {
  return source.filter((item) => selected.includes(item));
}

export function answersToArgs(answers: Answers): string[] {
  const args: string[] = [];
  if (answers.action === 'revert') args.push('--revert');
  else if (answers.action === 'migrate') args.push('--migrate');
  else {
    for (const { value, flag } of COMPONENTS) if (!answers.components[value]) args.push(flag);
    const agents = inOrder(ALL_AGENTS, answers.agents);
    if (agents.join(',') !== impliedAgents(answers.components).join(',')) args.push('--agents', agents.join(','));
    const models = inOrder(ALL_MODELS, answers.models);
    if (models.length !== ALL_MODELS.length) args.push('--models', models.join(','));
    if (answers.force) args.push('--force');
  }
  if (answers.dryRun) args.push('--dry-run');
  return args;
}

function output(program: string, args: string[]): string | undefined {
  const result = spawnSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function detectEnvironment(): Environment {
  return {
    codex: existsSync(path.join(homedir(), '.codex/config.toml')),
    argent: output('sh', ['-c', 'command -v argent']) !== undefined,
    stacks: output('gh', ['extension', 'list'])?.includes('stack') ?? false,
    claude: output('sh', ['-c', 'command -v claude']) !== undefined,
    hooksPath: output('git', ['config', '--global', 'core.hooksPath']) ?? '',
  };
}

async function ask<T>(prompt: Promise<T | typeof CANCEL_SYMBOL>): Promise<T> {
  const answer = await prompt;
  if (isCancel(answer)) throw new Cancelled();
  return answer;
}

function colour(line: string): string {
  const word = line.split(' ')[0];
  if (word === 'link') return pc.green(line);
  if (word === 'relink') return pc.yellow(line);
  if (word === 'REPLACE' || word === 'remove' || word === 'removed') return pc.red(line);
  return line.startsWith('DRY RUN') ? pc.dim(line) : line;
}

// Errors are reported here so runWizard can still close the prompt frame.
function runDeploy(args: string[], asksAboutMoves = false): number {
  try {
    return deploy({ ...parseDeployArguments(args).options, asksAboutMoves });
  } catch (error) {
    if (error instanceof Error && error.message) log.error(error.message);
    return error instanceof DeployError ? error.status : 1;
  }
}

// Lines are coloured as they arrive, not after the run: apply-policy is a child process
// that writes straight to stdout, and buffering ours would print the two out of order.
function preview(args: string[]): { status: number; lines: string[] } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...data: unknown[]) => {
    for (const line of format(...data).split('\n')) {
      lines.push(line);
      original(colour(line));
    }
  };
  try {
    return { status: runDeploy(args), lines };
  } finally {
    console.log = original;
  }
}

function sameAs(args: string[]): void {
  log.info(`same as: ${['bin/deploy', ...args].join(' ')}`);
}

// git expands a leading ~ in core.hooksPath, so ~/x and $HOME/x/ name the same directory.
// A relative core.hooksPath names a different directory in each repository, so it has no
// single location to compare.
function resolveHome(file: string): string | undefined {
  const expanded = file.replace(/^~(?=\/|$)/, homedir());
  return path.isAbsolute(expanded) ? path.resolve(expanded) : undefined;
}

export function detectedComponents(env: Environment): Components {
  const guardDir = path.resolve(homedir(), '.config/git/hooks');
  return {
    codex: env.codex,
    argent: env.argent,
    stacks: env.stacks,
    githooks: !env.hooksPath || resolveHome(env.hooksPath) === guardDir,
    mods: env.claude,
  };
}

async function askDeployAnswers(env: Environment): Promise<Answers> {
  const found = detectedComponents(env);
  const missing: Record<Component, string> = {
    codex: 'no ~/.codex/config.toml',
    argent: 'argent is not on PATH',
    stacks: 'gh stack extension not installed',
    githooks: `core.hooksPath is ${env.hooksPath}`,
    mods: 'no claude CLI on PATH',
  };
  const selected = await ask(multiselect<Component>({
    message: 'Which components should deploy install?',
    options: COMPONENTS.map(({ value, label }) => ({ value, label, hint: found[value] ? undefined : missing[value] })),
    initialValues: COMPONENTS.map(({ value }) => value).filter((value) => found[value]),
    required: false,
  }));
  const components: Components = { codex: false, argent: false, stacks: false, githooks: false, mods: false };
  for (const value of selected) components[value] = true;
  const agents = await ask(multiselect<string>({
    message: 'Which agents?',
    options: ALL_AGENTS.map((value) => ({ value })),
    initialValues: impliedAgents(components),
    required: true,
  }));
  const models = await ask(multiselect<string>({
    message: 'Which models should the routing rules keep?',
    options: ALL_MODELS.map((value) => ({ value })),
    initialValues: ALL_MODELS,
    required: true,
  }));
  return { action: 'deploy', components, agents, models };
}

async function confirmApply(answers: Answers, lines: string[]): Promise<Answers> {
  if (!lines.some((line) => line.startsWith('REPLACE'))) {
    if (!(await ask(confirm({ message: 'Apply these changes?' })))) throw new Cancelled();
    return answers;
  }
  const choice = await ask(select<'force' | 'ask' | 'cancel'>({
    message: 'Some files in the way are your own. What should deploy do with them?',
    options: [
      { value: 'force', label: 'Back up and replace all' },
      { value: 'ask', label: 'Ask for each file' },
      { value: 'cancel', label: 'Cancel' },
    ],
  }));
  if (choice === 'cancel') throw new Cancelled();
  return choice === 'force' && answers.action === 'deploy' ? { ...answers, force: true } : answers;
}

function describe(env: Environment): string {
  return [
    `~/.codex/config.toml  ${env.codex ? 'found' : 'not found'}`,
    `argent                ${env.argent ? 'on PATH' : 'not on PATH'}`,
    `gh stack              ${env.stacks ? 'installed' : 'not installed'}`,
    `claude                ${env.claude ? 'on PATH' : 'not on PATH'}`,
    `core.hooksPath        ${env.hooksPath || 'not set'}`,
  ].join('\n');
}

const STORES: { value: string; label: string; hint?: string; name: string }[] = [
  { value: 'file', label: 'Files', name: 'files' },
  { value: 'sqlite', label: 'SQLite', name: 'SQLite' },
  { value: 'git', label: 'Git storage', hint: 'a private GitHub repository', name: 'git storage' },
];

const storeName = (value: string): string => STORES.find((store) => store.value === value)?.name ?? value;

/** "storage" in ~/.claude/ledger-settings.json, files without the file or the key, as the ledger reads it. */
function currentStore(home: string): string {
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(path.join(home, '.claude/ledger-settings.json'), 'utf8'));
  } catch {
    return 'file';
  }
  const storage = typeof settings === 'object' && settings !== null && 'storage' in settings ? settings.storage : undefined;
  return typeof storage === 'string' ? storage : 'file';
}

const canRun = (moves: PendingMove[]): boolean => moves.some(({ auto }) => auto);

function showMoves(moves: PendingMove[]): void {
  note(moves.map(moveText).join('\n'), canRun(moves) ? 'Stored task data to move' : 'Left for you to move');
}

function checkMoves(home: string): PendingMove[] | undefined {
  const found = pendingMoves(home);
  if (!('error' in found)) return found.moves;
  log.warn(`Could not check for stored task data to move: ${found.error}`);
  return undefined;
}

/** After a deploy, which moved the .claude/ledger.md files already. Gives the status of the moves, 0 when none ran. */
async function offerMoves(): Promise<number> {
  const home = homedir();
  // A finished task whose repo folder is gone needs nothing, so a deploy does not name it again each time.
  const moves = checkMoves(home)?.filter(({ accepted }) => !accepted);
  if (moves === undefined || moves.length === 0) return 0;
  showMoves(moves);
  if (!canRun(moves)) return 0;
  // A cancel here is a no: the deploy is applied already.
  if ((await confirm({ message: 'Run these moves now?', initialValue: true })) !== true) {
    log.info(MIGRATE_HINT);
    return 0;
  }
  return runMoves(home, { showAccepted: false });
}

async function migrateWizard(): Promise<number> {
  const home = homedir();
  const moves = checkMoves(home);
  if (moves?.length === 0) log.info('Nothing to move.');
  else if (moves !== undefined) showMoves(moves);
  const choice = await ask(select<'run' | 'switch' | 'cancel'>({
    message: 'What do you want to do?',
    options: [
      ...(moves !== undefined && canRun(moves) ? [{ value: 'run' as const, label: 'Run the pending moves' }] : []),
      { value: 'switch', label: 'Switch the store type' },
      { value: 'cancel', label: 'Cancel' },
    ],
  }));
  if (choice === 'cancel') throw new Cancelled();
  if (choice === 'switch') return switchStore(home);
  sameAs(answersToArgs({ action: 'migrate' }));
  const status = runMoves(home);
  outro(status === 0 ? 'Done.' : 'A move failed; see above.');
  return status;
}

async function switchStore(home: string): Promise<number> {
  const current = currentStore(home);
  const target = await ask(select<string>({
    message: `The ledgers are kept in ${storeName(current)}. Which store should they move to?`,
    options: STORES.filter(({ value }) => value !== current).map(({ value, label, hint }) => ({ value, label, hint })),
  }));
  const command = ['store', 'migrate', '--to', target];
  log.step('Preview');
  // The dry run opens git storage for writing, which puts back a pre-push hook that differs (LLP 0000, data and storage).
  if (target === 'git' || current === 'git') log.info('The preview puts back the pre-push hook of the git storage clone if it was changed. It moves no ledger.');
  const preview = runLedger(home, [...command, '--dry-run']);
  const notMoved = 'The ledgers were not moved.';
  if (preview.error || preview.status !== 0) {
    log.error(preview.error?.message ?? printedLines(preview).join('\n'));
    cancel(`The preview failed. ${notMoved}`);
    return preview.status || 1;
  }
  note(printedLines(preview).join('\n'), `From ${storeName(current)} to ${storeName(target)}`);
  const confirmed = await confirm({ message: `Move the ledgers to ${storeName(target)}?` });
  if (confirmed !== true) {
    cancel(notMoved);
    return 1;
  }
  log.info(`same as: ledger ${command.join(' ')}`);
  const moved = runLedger(home, command);
  for (const line of printedLines(moved)) console.log(line);
  const status = moved.error ? 1 : (moved.status ?? 1);
  outro(status === 0 ? 'Done.' : `ledger store migrate exited with status ${status}.`);
  return status;
}

export async function runWizard(): Promise<number> {
  try {
    intro('ledger');
    const action = await ask(select<'deploy' | 'migrate' | 'revert'>({
      message: 'What do you want to do?',
      options: [
        { value: 'deploy', label: 'Deploy' },
        { value: 'migrate', label: 'Migrate', hint: 'move stored task data, or switch the store type' },
        { value: 'revert', label: 'Revert the last deploy' },
      ],
    }));
    if (action === 'migrate') return await migrateWizard();
    const env = detectEnvironment();
    note(describe(env), 'Found on this machine');
    const answers: Answers = action === 'revert' ? { action } : await askDeployAnswers(env);

    log.step('Preview');
    const args = answersToArgs(answers);
    const { status, lines } = preview(answersToArgs({ ...answers, dryRun: true }));
    if (status !== 0) {
      cancel('The preview failed. Nothing was written.');
      return status;
    }
    sameAs(args);

    const final = answersToArgs(await confirmApply(answers, lines));
    if (final.join(' ') !== args.join(' ')) sameAs(final);
    const applied = runDeploy(final, answers.action === 'deploy');
    if (applied !== 0) {
      outro(`Deploy exited with status ${applied}.`);
      return applied;
    }
    const moved = answers.action === 'deploy' ? await offerMoves() : 0;
    // As in a deploy without the wizard, a move that fails does not fail the deploy.
    outro(moved === 0 ? 'Done.' : 'Deployed. A move failed; see above.');
    return 0;
  } catch (error) {
    // runDeploy catches its own errors, so anything that lands here came before the apply.
    cancel('Nothing was written.');
    if (error instanceof Cancelled) return 1;
    throw error;
  }
}
