import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRules } from './build-rules.js';
import { isMain } from './cli.js';

// bin/deploy passes the path it was called through; import.meta.url is the realpath, and
// link targets and the CLAUDE.md retirement check must use the caller's path.
const REPO = process.env.DEPLOY_REPO || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ALL_AGENTS = ['researcher', 'runner', 'ui-runner', 'opus-implementer', 'fable-implementer', 'sol-implementer', 'astra-implementer', 'astra-reviewer', 'codex-runner', 'reviewer'];
export const CODEX_AGENTS = ['sol-implementer', 'astra-implementer', 'astra-reviewer', 'codex-runner'];
export const MODELS = 'gpt-6-luna,haiku-5.5,gpt-6.2-sol,sonnet-5.5,opus-5.5,gpt-6.2-astra,fable-5.2';
const HOOKS = ['commit-msg', 'prepare-commit-msg', 'pre-commit', 'pre-merge-commit', 'pre-push', 'pre-rebase', 'post-checkout', 'post-merge', 'post-commit', 'post-rewrite'];

interface DeployOptions {
  dry?: boolean;
  force?: boolean;
  revert?: boolean;
  noArgent?: boolean;
  noStacks?: boolean;
  noGithooks?: boolean;
  noCodex?: boolean;
  noMods?: boolean;
  codex?: boolean;
  agents?: string;
  models?: string;
  migrate?: boolean;
  /** Set by the wizard, which asks about the other moves itself: after the move of each .claude/ledger.md, name none. */
  asksAboutMoves?: boolean;
}

export class DeployError extends Error {
  constructor(message: string, readonly status = 1) { super(message); }
}

const NOT_WITH_MIGRATE: [keyof DeployOptions, string][] = [
  ['revert', '--revert'],
  ['force', '--force'],
  ['noArgent', '--no-argent'],
  ['noStacks', '--no-stacks'],
  ['noGithooks', '--no-githooks'],
  ['noCodex', '--no-codex'],
  ['noMods', '--no-mods'],
  ['codex', '--codex'],
  ['agents', '--agents'],
  ['models', '--models'],
];

export function parseDeployArguments(argv: string[]): { options: DeployOptions; help: boolean } {
  const opts: DeployOptions = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case '--dry-run': opts.dry = true; break;
      case '--force': opts.force = true; break;
      case '--revert': opts.revert = true; break;
      case '--no-argent': opts.noArgent = true; break;
      case '--no-stacks': opts.noStacks = true; break;
      case '--no-githooks': opts.noGithooks = true; break;
      case '--no-codex': opts.noCodex = true; break;
      case '--no-mods': opts.noMods = true; break;
      case '--codex': opts.codex = true; break;
      case '--migrate': opts.migrate = true; break;
      case '--agents':
      case '--models': {
        const value = argv[++index];
        if (!value || value.startsWith('-')) throw new DeployError(`${arg} needs a comma-separated list`);
        opts[arg === '--agents' ? 'agents' : 'models'] = value;
        break;
      }
      case '-h':
      case '--help': return { options: opts, help: true };
      default:
        if (arg.startsWith('--agents=')) opts.agents = arg.slice('--agents='.length);
        else if (arg.startsWith('--models=')) opts.models = arg.slice('--models='.length);
        else throw new DeployError(`unknown flag: ${arg}   (try --help)`);
    }
  }
  const conflict = opts.migrate ? NOT_WITH_MIGRATE.find(([key]) => opts[key] !== undefined) : undefined;
  if (conflict) throw new DeployError(`--migrate only moves stored task data and deploys no files, so it cannot go with ${conflict[1]}`);
  return { options: opts, help: false };
}

function command(program: string, args: string[], allowFailure = false): string {
  const result = spawnSync(program, args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new DeployError(result.error?.message ?? '', result.status ?? 1);
  }
  return (result.stdout ?? '').replace(/\n+$/, '');
}

const MARKETPLACE = 'ledger';
const MODS = ['ledger'];
const modId = (name: string): string => `${name}@${MARKETPLACE}`;
const MOD_COMMANDS = MODS.map((name) => `/${name}`).join(', ');

function runClaude(args: string[]): string {
  const result = spawnSync('claude', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.error || result.status !== 0) {
    throw new DeployError(`deploy: claude ${args.join(' ')} failed${result.error ? `: ${result.error.message}` : ''}`);
  }
  return result.stdout;
}

function claudeList<T>(args: string[]): T[] {
  const listArgs = [...args, 'list', '--json'];
  const stdout = runClaude(listArgs);
  let list: unknown;
  try {
    list = JSON.parse(stdout);
  } catch {
    list = undefined;
  }
  if (!Array.isArray(list)) {
    throw new DeployError(`deploy: claude ${listArgs.join(' ')} printed something that is not a JSON list:\n${stdout.slice(0, 200)}`);
  }
  return list as T[];
}

function samePath(first: string, second: string): boolean {
  const real = (file: string): string => existsSync(file) ? realpathSync(file) : path.resolve(file);
  return real(first) === real(second);
}

const PAST = { add: 'added', install: 'installed' } as const;

function filesUnder(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else files.set(path.relative(root, entryPath), readFileSync(entryPath));
    }
  };
  visit(root);
  return files;
}

function sameTree(first: string, second: string): boolean {
  if (!existsSync(first) || !existsSync(second)) return false;
  const [a, b] = [filesUnder(first), filesUnder(second)];
  return a.size === b.size && [...a].every(([file, bytes]) => b.get(file)?.equals(bytes));
}

function savedConfigArgs(mod: string): string[] {
  const stdout = runClaude(['plugin', 'configure', mod, '--json']);
  let config: { configured?: unknown; inputs?: Record<string, unknown> };
  try {
    config = JSON.parse(stdout);
  } catch {
    throw new DeployError(`deploy: claude plugin configure ${mod} --json printed something that is not JSON:\n${stdout.slice(0, 200)}`);
  }
  const configured = Array.isArray(config.configured) ? config.configured.filter((key): key is string => typeof key === 'string') : [];
  return configured.flatMap((key) => ['--config', `${key}=${String(config.inputs?.[key] ?? '')}`]);
}

// Installed from this repo as a folder marketplace. Claude Code runs a cached copy of each mod, so deploy
// reinstalls a mod whose copy differs from mods/<name>. --revert leaves both in place: they live in Claude
// Code's own plugin state, which deploy does not own.
function deployMods(opts: DeployOptions): void {
  if (opts.noMods) {
    console.log('mods     skipped (--no-mods)');
    return;
  }
  if (!command('sh', ['-c', 'command -v claude'], true)) {
    console.log('mods     skipped (no claude CLI on PATH)');
    return;
  }
  const change = (verb: keyof typeof PAST, args: string[], what: string): void => {
    if (opts.dry) {
      console.log(`mods     would ${verb} ${what}`);
      return;
    }
    runClaude([...args, '--scope', 'user']);
    console.log(`mods     ${PAST[verb]} ${what}`);
  };
  const marketplaces = claudeList<{ name: string; path?: string; installLocation?: string }>(['plugin', 'marketplace']);
  const located = (name: string) => {
    const found = marketplaces.find((entry) => entry.name === name);
    const location = found?.path ?? found?.installLocation;
    return found && { location, fromRepo: Boolean(location && samePath(location, REPO)) };
  };
  const marketplace = located(MARKETPLACE);
  if (marketplace && !marketplace.fromRepo) {
    console.log(`mods     marketplace ${MARKETPLACE} points at ${marketplace.location ?? 'an unknown source'}, not this repo; to fix: claude plugin marketplace remove ${MARKETPLACE}, then run deploy again`);
    console.log(`mods     skipped install of ${MODS.map((name) => modId(name)).join(', ')} until the marketplace points at this repo`);
    return;
  }
  let plugins: { id: string; scope?: string; installPath?: string }[] | undefined;
  const listPlugins = () => (plugins ??= claudeList(['plugin']));
  // Deploy installs at user scope only; an install at another scope is the operator's own.
  const installedByDeploy = (mod: string) => listPlugins().find(({ id, scope }) => id === mod && scope === 'user');
  if (marketplace) console.log(`mods     marketplace ${MARKETPLACE} already added`);
  else change('add', ['plugin', 'marketplace', 'add', REPO], `marketplace ${MARKETPLACE} (this repo)`);
  for (const name of MODS) {
    const mod = modId(name);
    const installed = installedByDeploy(mod);
    if (!installed) change('install', ['plugin', 'install', mod], `${mod} (/${name})`);
    else if (installed.installPath && sameTree(installed.installPath, path.join(REPO, 'mods', name))) console.log(`mods     ${mod} already installed`);
    else if (opts.dry) console.log(`mods     would reinstall ${mod} (installed copy differs from mods/${name})`);
    else reinstall(mod, name);
  }
}

// An uninstall drops the mod's saved config, so the install passes it back.
function reinstall(mod: string, name: string): void {
  const configArgs = savedConfigArgs(mod);
  runClaude(['plugin', 'uninstall', mod, '--scope', 'user', '--keep-data']);
  try {
    runClaude(['plugin', 'install', mod, '--scope', 'user', ...configArgs]);
  } catch (error) {
    if (!(error instanceof DeployError)) throw error;
    throw new DeployError(`${error.message}\ndeploy: ${mod} is now uninstalled; run deploy again to install it`, error.status);
  }
  console.log(`mods     reinstalled ${mod} (installed copy differed from mods/${name})`);
}

// Run as a command, never imported: deploy runs on Node 20.12, and the ledger's SQLite storage needs 22.13.
const LEDGER = path.join(REPO, 'bin/ledger');

// A copy of MOVE_KINDS and Move in tools/ledger/pending.ts, which deploy must not import (see LEDGER); keep them in step.
const MOVE_KINDS = ['repo-ids', 'active', 'records'] as const;
type MoveKind = (typeof MOVE_KINDS)[number];

/**
 * One item of `ledger store migrate --pending --json`: `auto` is false for a task the move leaves, for `reason`;
 * `accepted` when that task needs no person. A ledger from before `accepted` sends none.
 */
export interface PendingMove {
  kind: MoveKind;
  from: string;
  to: string;
  auto: boolean;
  reason?: string;
  accepted?: true;
}

export const MIGRATE_HINT = 'Run bin/deploy --migrate to move them.';

/** Runs bin/ledger from HOME, not this repo: the repo's own worktrees are found through the task records, as every other repo's are. */
export function runLedger(home: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(LEDGER, args, { cwd: home, encoding: 'utf8' });
}

export const printedLines = (ran: SpawnSyncReturns<string>): string[] => `${ran.stdout ?? ''}${ran.stderr ?? ''}`.split('\n').filter((line) => line.trim() !== '');

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isMove = (value: unknown): value is PendingMove =>
  isRecord(value)
  && MOVE_KINDS.some((kind) => kind === value.kind)
  && typeof value.from === 'string'
  && typeof value.to === 'string'
  && typeof value.auto === 'boolean';

/** What `ledger store migrate --pending` finds still to move, or why it could not check. */
export function pendingMoves(home: string): { moves: PendingMove[] } | { error: string } {
  const ran = runLedger(home, ['store', 'migrate', '--pending', '--json']);
  if (ran.error) return { error: ran.error.message };
  let parsed: unknown;
  try {
    parsed = JSON.parse(ran.stdout);
  } catch {
    parsed = undefined;
  }
  const moves = isRecord(parsed) ? parsed.moves : undefined;
  if (ran.status === 0 && Array.isArray(moves) && moves.every(isMove)) return { moves };
  const error = isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : `${ran.stderr}${ran.stdout}`.trim();
  return { error: error || `ledger store migrate --pending exited ${ran.status ?? 'on a signal'}` };
}

/** The moves still to do, or undefined, reported, when the check fails. */
function checkMoves(home: string, what = 'moves'): PendingMove[] | undefined {
  const found = pendingMoves(home);
  if (!('error' in found)) return found.moves;
  console.log(`moves    could not check for ${what}: ${found.error}`);
  return undefined;
}

export const moveText = ({ from, to, auto, reason }: PendingMove): string => (auto ? `${from} → ${to}` : `${from} stays: ${reason ?? 'the move leaves it'}`);

const printMoves = (moves: PendingMove[]): void => {
  for (const move of moves) console.log(`moves    ${move.kind.padEnd(8)} ${moveText(move)}`);
};

const needsPerson = ({ auto, accepted }: PendingMove): boolean => !auto && !accepted;

/** An accepted move's task: its `from` without the place it starts with, `archive` or `evidence`, which means nothing to a reader. */
const acceptedName = ({ from }: PendingMove): string => from.slice(from.indexOf(' ') + 1);

// Prints the texts of pendingText in tools/ledger/pending.ts, which deploy cannot import (see LEDGER); keep them in step.
function printLeftovers(moves: PendingMove[]): void {
  const stuck = moves.filter(needsPerson);
  if (stuck.length > 0) {
    console.log(`moves    ${stuck.length === 1 ? '1 task needs a person to move it:' : `${stuck.length} tasks need a person to move them:`}`);
    printMoves(stuck);
  }
  const accepted = moves.filter((move) => move.accepted);
  if (accepted.length === 0) return;
  console.log(
    `moves    ${accepted.length === 1
      ? '1 finished task stays under its old repo folder name, as that folder is gone or unknown. Nothing to do: it stays readable in the archive.'
      : `${accepted.length} finished tasks stay under their old repo folder name, as that folder is gone or unknown. Nothing to do: they stay readable in the archive.`}`,
  );
  for (const move of accepted) console.log(`moves    ${acceptedName(move)}: ${move.reason}`);
}

const canMove = (moves: PendingMove[], kind?: MoveKind): boolean => moves.some((move) => move.auto && (kind === undefined || move.kind === kind));

/** The lines of `ledger store migrate --repo-ids` on what it left, each of which runMoves prints itself from its last check. */
const LEFT_BY_REPO_IDS = /^(left |(kept|would keep) \d+ finished tasks? )/;

function runMove(home: string, kind: MoveKind): SpawnSyncReturns<string> {
  const moved = runLedger(home, ['store', 'migrate', `--${kind}`]);
  for (const line of printedLines(moved)) {
    if (kind !== 'repo-ids' || !LEFT_BY_REPO_IDS.test(line)) console.log(`ledgers  ${line}`);
  }
  return moved;
}

/**
 * Runs each kind of move, in order, when a check made just before it lists a task it can take: a list shown earlier may
 * be out of date, and a move may make a task of a later kind movable. A move exits 1 for any task it leaves, also one the
 * check named already, so the run fails only when a move could not run or exited above 1, or a task a last check names
 * can still move. Prints each task that stays, with why, the accepted ones only with `showAccepted`, and gives 1 for a
 * failed run.
 */
export function runMoves(home: string, { showAccepted = true } = {}): number {
  let broken = false;
  for (const kind of MOVE_KINDS) {
    const moves = checkMoves(home);
    if (moves === undefined) return 1;
    if (!canMove(moves, kind)) continue;
    const moved = runMove(home, kind);
    const rerun = `ledger store migrate --${kind}`;
    if (moved.error) console.log(`ledgers  could not run ${rerun}: ${moved.error.message}`);
    else if (moved.status === null || moved.status > 1) console.log(`ledgers  ${rerun} exited ${moved.status ?? 'on a signal'}`);
    broken ||= moved.error !== undefined || moved.status === null || moved.status > 1;
  }
  const moves = checkMoves(home);
  if (moves === undefined) return 1;
  printLeftovers(showAccepted ? moves : moves.filter(({ accepted }) => !accepted));
  if (canMove(moves)) {
    console.log('moves    still to do after the run:');
    printMoves(moves.filter(({ auto }) => auto));
  }
  return broken || canMove(moves) ? 1 : 0;
}

function migrate(home: string, dry: boolean): number {
  const moves = checkMoves(home);
  if (moves === undefined) return 1;
  if (moves.length === 0) {
    console.log('Nothing to move.');
    return 0;
  }
  if (!dry && canMove(moves)) return runMoves(home);
  printMoves(moves.filter(({ auto }) => auto));
  printLeftovers(moves);
  if (!dry && moves.some(needsPerson)) console.log('Nothing deploy can move: each task above stays for the reason it names.');
  return 0;
}

/**
 * After a deploy: moves each .claude/ledger.md into the ledger store, as the ledger now installed reads only the store,
 * then, unless `named` is false, names the other moves still to do. A ledger it leaves, a run that fails, or a check that
 * fails is reported and does not fail the deploy: the rest is installed.
 */
function moveAfterDeploy(home: string, named: boolean): void {
  const rerun = 'ledger store migrate --active';
  const moved = runMove(home, 'active');
  if (moved.error) console.log(`ledgers  could not run ${rerun}: ${moved.error.message}. Run it by hand.`);
  else if (moved.status !== 0) console.log(`ledgers  ${rerun} exited ${moved.status ?? 'on a signal'}; the deploy is done. Fix what it names above, then run ${rerun} again.`);
  if (!named) return;
  const other = checkMoves(home, 'other moves')?.filter(({ auto }) => auto) ?? [];
  if (other.length === 0) return;
  printMoves(other);
  console.log(`moves    ${MIGRATE_HINT}`);
}

function listMovesStillToDo(home: string): void {
  const moves = checkMoves(home)?.filter(({ accepted }) => !accepted) ?? [];
  if (moves.length === 0) return;
  console.log('moves    still to do:');
  printMoves(moves);
}

const isFile = (filename: string): boolean => existsSync(filename) && statSync(filename).isFile();

function manifestLines(filename: string): string[] {
  if (!isFile(filename)) return [];
  return readFileSync(filename, 'utf8').split('\n').slice(0, -1).filter(Boolean);
}

function markdownFiles(directory: string): string[] {
  const names = readdirSync(directory).filter((name) => !name.startsWith('.') && name.endsWith('.md')).sort();
  return (names.length ? names : ['*.md']).map((name) => path.join(directory, name));
}

function readReply(): string {
  let fd: number;
  try {
    fd = openSync('/dev/tty', 'r');
  } catch (error) {
    console.error(`deploy: /dev/tty: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
  try {
    const bytes: number[] = [];
    const byte = Buffer.alloc(1);
    while (readSync(fd, byte, 0, 1, null) > 0 && byte[0] !== 10) {
      if (byte[0] !== 0) bytes.push(byte[0]);
    }
    return Buffer.from(bytes).toString('utf8').replace(/^[ \t]+|[ \t]+$/g, '');
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

export function deploy(opts: DeployOptions): number {
  const home = homedir();
  if (opts.migrate) return migrate(home, Boolean(opts.dry));
  const claude = path.join(home, '.claude');
  const rules = path.join(claude, 'rules');
  const hooks = path.join(claude, 'hooks');
  const manifest = path.join(claude, '.ledger-manifest');
  const backup = path.join(claude, 'backups', `deploy-${command('date', ['+%Y-%m-%d-%H%M%S'])}`);
  const githooks = path.join(home, '.config/git/hooks');
  // path.join drops the slash a HOME like /x/ ends in, so match on HOME without it.
  const homePrefix = home.replace(/\/+$/, '');
  const short = (filename: string): string => filename.startsWith(homePrefix) ? `~${filename.slice(homePrefix.length)}` : filename;
  const note = (text: string): void => console.log(`${opts.dry ? 'would ' : ''}${text}`);
  const oldWrote = manifestLines(manifest);
  let agents: string[];
  if (opts.agents) {
    const firstLine = opts.agents.split('\n')[0];
    agents = firstLine === '' ? [] : firstLine.replace(/,$/, '').split(',');
    for (const agent of agents) {
      if (!ALL_AGENTS.includes(agent)) throw new DeployError(`unknown agent: ${agent}\nknown agents: ${ALL_AGENTS.join(' ')}`);
    }
  } else {
    agents = ALL_AGENTS.filter((agent) => !(opts.noCodex && CODEX_AGENTS.includes(agent)) && !(opts.noArgent && agent === 'ui-runner'));
  }
  if (opts.dry) console.log('DRY RUN -- nothing below is written.\n');

  if (opts.revert) {
    let found = 0;
    for (const filename of oldWrote) {
      if (!lstatSync(filename, { throwIfNoEntry: false })) continue;
      found++;
      if (!opts.dry) command('rm', ['-f', filename]);
      console.log(`${opts.dry ? 'remove  ' : 'removed '} ${short(filename)}`);
    }
    if (!opts.dry && isFile(manifest)) command('rm', ['-f', manifest]);
    if (!found) console.log('nothing from this repo is in place');
    if (command('git', ['config', '--global', 'core.hooksPath'], true) === githooks) {
      console.log(`hooks    core.hooksPath still points at ${short(githooks)}`);
      console.log('         revert does not unset it; it is global git config, not a file');
      console.log('         to undo it fully: git config --global --unset core.hooksPath');
    }
    console.log(`mods     revert leaves the mods installed (${MOD_COMMANDS}); they are Claude Code plugin state, not files`);
    console.log('         to remove them:');
    for (const name of MODS) console.log(`           claude plugin uninstall ${name}`);
    console.log(`           claude plugin marketplace remove ${MARKETPLACE}`);
    const backups = path.join(claude, 'backups');
    const newest = existsSync(backups) ? readdirSync(backups).filter((name) => name.startsWith('deploy-')).sort().at(-1) : undefined;
    if (!newest) console.log('no backup to restore');
    else {
      const source = path.join(backups, newest);
      console.log(`backup   ${short(source)}`);
      const files = command('find', [source, '-type', 'f'], true);
      for (const file of files ? files.split('\n') : []) {
        const target = path.join(home, path.relative(source, file));
        if (!opts.dry) {
          mkdirSync(path.dirname(target), { recursive: true });
          command('cp', ['-p', file, target]);
        }
        console.log(`${opts.dry ? 'restore ' : 'restored'} ${short(target)}`);
      }
      console.log('\nRestored each file as it was at that deploy. Later local edits to those');
      console.log(`files are gone. Older backups are still in ${short(backups)}.`);
    }
    if (opts.dry) console.log('\nDRY RUN -- nothing was written.');
    return 0;
  }

  const wrote: string[] = [];
  const realRepo = realpathSync(REPO);
  const link = (src: string, dst: string): void => {
    const label = short(dst);
    const symlink = lstatSync(dst, { throwIfNoEntry: false })?.isSymbolicLink();
    const target = symlink ? readlinkSync(dst) : undefined;
    if (target === src) {
      wrote.push(dst);
      return;
    }
    const resolvedTarget = target === undefined ? undefined : path.resolve(path.dirname(dst), target);
    const foreignLink = resolvedTarget !== undefined
      && !(existsSync(resolvedTarget)
        ? realpathSync(resolvedTarget).startsWith(`${realRepo}/`)
        : resolvedTarget.startsWith(`${REPO}/`) || resolvedTarget.startsWith(`${realRepo}/`))
      && !oldWrote.includes(dst);
    const ownedRule = dst.startsWith(`${rules}/`) && oldWrote.includes(dst);
    if (opts.dry) {
      if (foreignLink) console.log(`REPLACE  ${label}   (a file of your own: deploy would ask, then back it up)`);
      else if (symlink) console.log(`relink   ${label}   (now points at ${target})`);
      else if (existsSync(dst) && ownedRule) console.log(`relink   ${label}   (replaces a copy an earlier deploy generated)`);
      else if (existsSync(dst)) console.log(`REPLACE  ${label}   (a file of your own: deploy would ask, then back it up)`);
      else console.log(`link     ${label}`);
      wrote.push(dst);
      return;
    }
    if (foreignLink || (existsSync(dst) && !symlink)) {
      if (ownedRule) command('rm', ['-f', dst]);
      else {
        if (!opts.force) {
          const kind = foreignLink ? ' (a symlink outside this repo)' : ', not a symlink';
          if (!process.stdin.isTTY) {
            throw new DeployError(`\n${label} is a file of your own${kind}.\nDeploy would back it up and replace it with a symlink into this repo.\nRun bin/deploy --dry-run to see every change, then --force to proceed.`);
          }
          process.stdout.write(`${label} is a file of your own${kind}. Back it up and replace it with a symlink? [y/N] `);
          if (!['y', 'Y', 'yes', 'YES'].includes(readReply())) {
            console.log(`skipped  ${label}`);
            return;
          }
        }
        const saved = path.join(backup, path.relative(home, dst));
        mkdirSync(path.dirname(saved), { recursive: true });
        command('cp', ['-pP', dst, saved]);
      }
    }
    mkdirSync(path.dirname(dst), { recursive: true });
    command('ln', ['-sfn', src, dst]);
    wrote.push(dst);
    console.log(`linked   ${label}`);
  };

  const old = path.join(claude, 'CLAUDE.md');
  if (lstatSync(old, { throwIfNoEntry: false })?.isSymbolicLink() && readlinkSync(old).startsWith(`${REPO}/`)) {
    note(`retire   ${short(old)}   (the contract now ships as rules)`);
    if (!opts.dry) command('rm', [old]);
  }
  const filtered = opts.agents || opts.models || opts.noCodex || opts.noArgent || opts.noStacks;
  if (!filtered) {
    for (const file of markdownFiles(path.join(REPO, 'rules'))) link(file, path.join(rules, path.basename(file)));
  } else {
    // A separate output directory prevents older, wider selections from being redeployed.
    const out = mkdtempSync(path.join(tmpdir(), 'ledger-rules-'));
    try {
      const features = [...agents, opts.models || MODELS];
      if (!opts.noCodex) features.push('codex');
      if (!opts.noArgent) features.push('argent');
      if (!opts.noStacks) features.push('gh-stack');
      const status = buildRules({ src: path.join(REPO, 'rules'), out, features: features.join(',') });
      if (status !== 0) return status;
      if (!opts.dry) mkdirSync(rules, { recursive: true });
      for (const file of markdownFiles(out)) {
        const dst = path.join(rules, path.basename(file));
        wrote.push(dst);
        if (!opts.dry) {
          // Generated files must replace symlinks without writing through into the repo.
          command('rm', ['-f', dst]);
          command('cp', [file, dst]);
        }
        console.log(`${opts.dry ? 'generate' : 'generated'} ${short(dst)}`);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    console.log('rules    generated, not linked: edits in the repo need another deploy');
  }
  link(path.join(REPO, 'ledger.template.md'), path.join(claude, 'ledger.template.md'));
  link(path.join(REPO, 'bin/ledger'), path.join(home, '.local/bin/ledger'));
  // The settings hooks run it by this path, so they need neither ~/.local/bin nor PATH.
  link(path.join(REPO, 'bin/ledger'), path.join(claude, 'bin/ledger'));
  const onPath = (process.env.PATH ?? '').split(':').some((entry) => entry.replace(/\/+$/, '') === path.join(home, '.local/bin'));
  if (!onPath) {
    console.log('path     ~/.local/bin is not on PATH; add to your shell profile: export PATH="$HOME/.local/bin:$PATH"');
  }
  for (const hook of readdirSync(path.join(REPO, 'hooks')).filter((f) => f.endsWith('.sh')).sort()) link(path.join(REPO, 'hooks', hook), path.join(claude, 'hooks', hook));
  link(path.join(REPO, 'notes/model-routing-rationale.md'), path.join(claude, 'notes/model-routing-rationale.md'));
  for (const agent of agents) link(path.join(REPO, 'agents', `${agent}.md`), path.join(claude, 'agents', `${agent}.md`));

  if (!opts.noGithooks) {
    link(path.join(REPO, 'githooks/_chain'), path.join(githooks, '_chain'));
    for (const hook of HOOKS) link(path.join(githooks, '_chain'), path.join(githooks, hook));
    const current = command('git', ['config', '--global', 'core.hooksPath'], true);
    if (!current) {
      note(`set      core.hooksPath -> ${short(githooks)}`);
      if (!opts.dry) command('git', ['config', '--global', 'core.hooksPath', githooks]);
    } else if (current !== githooks) {
      console.log(`hooks    core.hooksPath is ${current} -- left alone, so the guard is not active`);
      console.log(`         to use it: git config --global core.hooksPath ${short(githooks)}`);
    }
  }
  const skipped = ALL_AGENTS.filter((agent) => !agents.includes(agent));
  if (skipped.length) console.log(`agents   not deployed: ${skipped.join(' ')}`);
  for (const filename of oldWrote) {
    if (wrote.includes(filename)) continue;
    const rule = filename.startsWith(`${rules}/`);
    // Deploy writes hooks only as links into the repo; a file or a link of your own in their place is left alone.
    const hookLink = filename.startsWith(`${hooks}/`)
      && lstatSync(filename, { throwIfNoEntry: false })?.isSymbolicLink()
      && readlinkSync(filename).startsWith(path.join(REPO, 'hooks/'));
    if (!rule && !hookLink) continue;
    if (!opts.dry) command('rm', ['-f', filename]);
    console.log(opts.dry ? `remove   ${short(filename)}   (${rule ? 'no longer selected' : 'no longer in the repo'})` : `removed  ${short(filename)}`);
  }
  if (!opts.dry) {
    writeFileSync(manifest, `${wrote.join('\n')}\n`);
  }
  // Policy parse failures must retain the standalone CLI's diagnostics and stack.
  const policyArgs = ['--backup-dir', backup];
  if (opts.dry) policyArgs.push('--dry-run');
  if (opts.noCodex) policyArgs.push('--no-codex');
  if (opts.codex) policyArgs.push('--codex');
  const policy = spawnSync(process.execPath, ['--import', 'tsx', path.join(REPO, 'tools/apply-policy.ts'), ...policyArgs], { cwd: REPO, stdio: 'inherit' });
  if (policy.error) throw policy.error;
  const status = policy.status ?? 1;
  if (status !== 0) return status;
  deployMods(opts);
  if (opts.dry) listMovesStillToDo(home);
  else moveAfterDeploy(home, !opts.asksAboutMoves);
  if (opts.dry) console.log('\nDRY RUN -- nothing was written.');
  else if (existsSync(backup) && statSync(backup).isDirectory()) console.log(`backup   ${short(backup)}`);
  return 0;
}

export function shouldRunWizard(argv: string[], stdinTTY: boolean | undefined, stdoutTTY: boolean | undefined): boolean {
  return argv.length === 0 && Boolean(stdinTTY) && Boolean(stdoutTTY);
}

const HELP = `Deploy ledger.

Deploy links the ledger command into ~/.local/bin.

  bin/deploy                  link the owned files; apply policy; Codex if present
  bin/deploy --dry-run        print every change and write nothing
  bin/deploy --no-codex       skip Codex, and the four agents that drive it
  bin/deploy --codex          require Codex; fail if ~/.codex/config.toml is missing
  bin/deploy --no-argent      skip ui-runner and the UI automation rule
  bin/deploy --no-stacks      skip the stacked-PR rule (needs the gh stack extension)
  bin/deploy --no-githooks    skip the git hook guard; leave core.hooksPath alone
  bin/deploy --no-mods        skip the Claude Code mods (${MOD_COMMANDS})
  bin/deploy --agents a,b,c   deploy only these agents
  bin/deploy --models a,b     keep only these models in the routing rules
  bin/deploy --force          replace a file of your own without asking
  bin/deploy --revert         undo the last deploy
  bin/deploy --migrate        move stored task data to its newest format; deploy no files
  bin/deploy --migrate --dry-run
                              list what --migrate would move, and move nothing

Run --dry-run first against a config you care about.

After the files, deploy moves each .claude/ledger.md into the ledger store, then
names any other stored task data still in an older format. --migrate moves it,
and does not offer to pull new commits first. Each move is a ledger store
migrate command, which checks again as it runs. A task a move cannot take
safely is left as it is and named with the reason, after the wizard's Deploy too.

The contract ships as rule files in ~/.claude/rules/, which Claude Code loads
for every project. Your own ~/.claude/CLAUDE.md is never touched.

NOTE for Cowork users: a Cowork session on the desktop skips a symlinked
~/.claude/rules/ file that points outside the session's working directory, so
these rules do not load there. Claude Code in the terminal is unaffected.

Deploy also installs a chaining git hook dispatcher in ~/.config/git/hooks and
points core.hooksPath at it. Each hook strips AI attribution trailers from the
commit message, then hands over to the repository's own hook of the same name,
so nothing a project keeps in .git/hooks stops working. If core.hooksPath is
already set to something else, deploy leaves it alone and says so. --revert
removes the files but does not unset core.hooksPath.

Deploy does NOT own ~/.claude/settings.json or ~/.codex/config.toml. Those hold
local state the apps write: project trust levels, plugins, marketplaces, MCP
servers, your model choice. It merges a few policy keys and leaves the rest.
`;

/** Runs the command line: the wizard in a terminal when there are no arguments, deploy otherwise. Sets process.exitCode. */
export function main(argv: string[]): void {
  const fail = (error: unknown): void => {
    if (error instanceof Error && error.message) console.error(error.message);
    process.exitCode = error instanceof DeployError ? error.status : 1;
  };
  if (shouldRunWizard(argv, process.stdin.isTTY, process.stdout.isTTY)) {
    // Not awaited: wizard.ts imports this module, so a top-level await here deadlocks.
    // Loaded on demand so scripted runs never load the prompt library.
    import('./wizard.js').then(({ runWizard }) => runWizard()).then((status) => { process.exitCode = status; }, fail);
  } else {
    try {
      const { options, help } = parseDeployArguments(argv);
      if (help) process.stdout.write(HELP);
      else process.exitCode = deploy(options);
    } catch (error) {
      fail(error);
    }
  }
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
