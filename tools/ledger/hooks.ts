import { statSync, type Stats } from 'node:fs';
import path from 'node:path';
import { limitCloneGitCalls } from './clone.js';
import { folderEntries } from './files.js';
import { logHookFailure, markHookFailuresReported, unreportedHookFailures } from './hook-failures.js';
import { findSection, serializeLedger, type Child, type Ledger, type TaskRef } from './format.js';
import { checkoutRoot, gitTimedOut, inMainCheckout, limitGitCalls, mainCheckout } from './git.js';
import { limitLockWaits } from './lock.js';
import { repoName, samePath, worktreeLedger } from './paths.js';
import { loadTasks } from './registry.js';
import { pullForSession, syncNotice } from './sync.js';
import { archivedTasks, findNamed, findTasks, folderTask, locateChild, namedChildren, worktreeTasks, type Task } from './tasks.js';
import type { Context } from './write.js';

// @ref LLP 0000#hooks — the four events, their registration in settings.policy.json, and why a failed hook allows the call.

/** `ledgerBin` is the path deny reasons name, so a reader can run it without `ledger` on PATH. */
export type HookContext = Context & { ledgerBin: string };

export const HOOK_EVENTS = ['session-start', 'prompt-submit', 'pre-compact', 'pre-tool-use'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The fields of Claude Code's hook input that the hooks read; a missing or mistyped field is empty. */
export type HookInput = { cwd: string; prompt: string; sessionTitle: string; toolName: string; toolInput: Record<string, unknown> };

type HookOutput<Event extends string, Fields> = { hookSpecificOutput: { hookEventName: Event } & Fields };
export type SessionStartOutput = HookOutput<'SessionStart', { additionalContext: string; sessionTitle?: string }>;
export type PromptSubmitOutput = HookOutput<'UserPromptSubmit', { sessionTitle: string }>;
export type PreToolUseOutput = HookOutput<'PreToolUse', { permissionDecision: 'deny'; permissionDecisionReason: string }>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function parseHookInput(json: string): HookInput {
  const input: unknown = JSON.parse(json);
  if (!isRecord(input)) throw new Error('the hook input is not a JSON object');
  return {
    cwd: text(input.cwd),
    prompt: text(input.prompt),
    sessionTitle: text(input.session_title),
    toolName: text(input.tool_name),
    toolInput: isRecord(input.tool_input) ? input.tool_input : {},
  };
}

const folderOf = (input: HookInput, context: HookContext): string => input.cwd || context.cwd;

const GIT_TIMEOUT_MS = 5000;
/** What the session start keeps of its 5 s for the ledgers, after the pull of git storage. */
const AFTER_PULL_MS = 1000;

/**
 * What the hook prints on stdout for Claude Code's JSON `stdin`: hook JSON, plain text for pre-compact, or nothing.
 * Throws on input it cannot read and on any other error; the caller decides how a hook fails. Limits every later git
 * call of the process, so a repository that hangs cannot stall Claude Code.
 */
export function answerHook(event: HookEvent, stdin: string, context: HookContext): string {
  const deadline = Date.now() + GIT_TIMEOUT_MS;
  limitGitCalls(GIT_TIMEOUT_MS);
  const input = parseHookInput(stdin);
  const json = (output: object | undefined): string => (output === undefined ? '' : `${JSON.stringify(output)}\n`);
  switch (event) {
    case 'session-start':
      return json(sessionStart(input, context, deadline));
    case 'prompt-submit':
      return json(promptSubmit(input, context));
    case 'pre-compact':
      return preCompactText(sessionLedgers(folderOf(input, context)));
    case 'pre-tool-use':
      return json(preToolUse(input, context));
  }
}

/** The ledgers a session works on. `own` says the first is the ledger of the session's folder itself. */
export type SessionLedgers = { tasks: Task[]; own: boolean };

/**
 * The ledgers of a session in `cwd`. In a main checkout: those of its linked worktrees, wherever they live, never its
 * own, because a ledger lives only in a linked worktree. In a linked worktree: its own. Outside a git repository: the
 * folder's own, then those under .claude/worktrees/ and .worktrees/.
 */
export function sessionLedgers(cwd: string): SessionLedgers {
  const root = checkoutRoot(cwd);
  if (root === undefined) {
    const own = folderTask(cwd);
    const nested = ['.claude/worktrees', '.worktrees'].flatMap((folder) =>
      folderEntries(path.join(cwd, folder))
        .map(({ name }) => path.join(cwd, folder, name))
        .sort()
        .flatMap((sub) => folderTask(sub) ?? []),
    );
    return { tasks: [...(own === undefined ? [] : [own]), ...nested], own: own !== undefined };
  }
  const main = mainCheckout(cwd);
  if (main === undefined) return { tasks: [], own: false };
  const tasks = worktreeTasks(main);
  const ledgerOf = (folder: string) => (task: Task): boolean => samePath(task.file, worktreeLedger(folder));
  if (inMainCheckout(cwd)) return { tasks: tasks.filter((task) => !ledgerOf(main)(task)), own: false };
  const own = tasks.filter(ledgerOf(root));
  return { tasks: own, own: own.length > 0 };
}

/** The slug that titles the session: only when its one ledger is its folder's own. */
export const sessionTitle = ({ tasks, own }: SessionLedgers): string | undefined => (own && tasks.length === 1 ? tasks[0].ledger.slug : undefined);

const shown = ({ slug, main }: TaskRef): string => (main === undefined ? slug : `${slug} @ ${main}`);

/** A task in a repo whose git did not answer in time is unknown, not missing. */
function statusText(ref: Required<TaskRef> | undefined, find: (ref: Required<TaskRef>) => Task | undefined): string {
  if (ref === undefined) return 'missing';
  if (gitTimedOut(ref.main)) return 'unknown';
  const task = find(ref);
  if (task === undefined) return 'missing';
  return task.status === 'retired' && task.archived !== undefined ? `retired ${task.archived}` : task.status;
}

/** A worktree beats a backlog ledger, which beats the newest archive copy. */
function namedTask(tasks: Task[], ref: Required<TaskRef>): Task | undefined {
  const named = findNamed(tasks, ref);
  return named.find(({ place }) => place === 'worktree') ?? named[0];
}

/**
 * One line for the parent and one per child that names a task, in list order, each with its status from disk; a child
 * line marked retired shows that mark instead. A line without a main is in `task`'s repo.
 */
function relationLines(task: Task, tasks: Task[]): string[] {
  const { main, ledger } = task;
  const refIn = ({ slug, main: written }: TaskRef): Required<TaskRef> | undefined => {
    const repo = written ?? main;
    return repo === undefined ? undefined : { slug, main: repo };
  };
  const parent = ledger.location.parent;
  const parentLines = parent === undefined ? [] : [`Parent task: ${shown(parent)} (${statusText(refIn(parent), (ref) => namedTask(tasks, ref))}).`];
  const findChild = (ref: Required<TaskRef>): Task | undefined => (main === undefined ? namedTask(tasks, ref) : locateChild(tasks, ref, { slug: task.slug, main }));
  const childStatus = (child: Child): string => (child.mark?.kind === 'retired' ? `retired ${child.mark.date}` : statusText(refIn(child), findChild));
  const childLines = namedChildren(task, tasks).map((child) => `Child task: ${shown(child)} (${childStatus(child)}).`);
  return [...parentLines, ...childLines];
}

/** The lines under ## Goal and ## Next step, as written. */
function summary({ lines, sections }: Ledger): string {
  const count = lines.at(-1) === '' ? lines.length - 1 : lines.length;
  const body = (name: string): readonly string[] => {
    const section = findSection(sections, name);
    return section === undefined ? [] : lines.slice(section.start + 1, Math.min(section.end, count));
  };
  return [...body('Goal'), ...body('Next step')].map((line) => `${line}\n`).join('');
}

/** The SessionStart context for one or more ledgers. `tasks` are all known tasks, for the parent and child statuses. */
export function sessionStartText({ tasks: ledgers }: SessionLedgers, tasks: Task[]): string {
  const relations = (task: Task): string => relationLines(task, tasks).map((line) => `${line}\n`).join('');
  if (ledgers.length === 1) {
    const [task] = ledgers;
    return `A task ledger exists at ${task.file}. Contents follow. If it has open steps, continue from Next step without re-verifying finished steps.\n${relations(task)}\n${serializeLedger(task.ledger)}`;
  }
  const summaries = ledgers.map((task) => `\n=== ${task.file}\n${relations(task)}${summary(task.ledger)}`).join('');
  return `${ledgers.length} task ledgers exist. Summary of each follows. If asked what we are working on, answer from this. Before continuing one, ask which, then read its full ledger.\n${summaries}`;
}

/** The registry is a cache: a session start that cannot write it still shows its ledgers. */
function tasksOnDisk(context: HookContext, mains: string[]): Task[] {
  try {
    return loadTasks(context, mains);
  } catch {
    return findTasks(context.store, mains);
  }
}

/**
 * With git storage it pulls first, and a sync problem adds one line before the ledgers. The pull, and every git call and
 * lock wait after it, opening and closing the store too, end by `deadline`.
 */
function sessionLedgerContext(input: HookInput, context: HookContext, deadline: number): { text?: string; title?: string } {
  limitLockWaits(deadline);
  limitCloneGitCalls(deadline);
  // Opened first, as git in the session folder may use up the time that is left after the pull.
  void context.store;
  pullForSession(context.paths, deadline - AFTER_PULL_MS);
  limitGitCalls(GIT_TIMEOUT_MS, deadline);
  const notice = syncNotice(context.paths);
  const found = sessionLedgers(folderOf(input, context));
  if (found.tasks.length === 0) return { text: notice };
  const mains = found.tasks.flatMap(({ main, ledger: { location, children } }) => [main, location.parent?.main, ...children.map((child) => child.main)].filter((known) => known !== undefined));
  const ledgers = sessionStartText(found, tasksOnDisk(context, mains));
  return { text: notice === undefined ? ledgers : `${notice}\n${ledgers}`, title: sessionTitle(found) };
}

/**
 * Hook failures since the last report come first, above the sync notice and the ledgers, and count as reported once the
 * output is built. When the pull or the ledger part throws, the report still goes out alone and the new failure waits
 * for the next one.
 */
export function sessionStart(input: HookInput, context: HookContext, deadline = Date.now() + GIT_TIMEOUT_MS): SessionStartOutput | undefined {
  const failures = unreportedHookFailures(context.paths);
  let ledgers: { text?: string; title?: string };
  try {
    ledgers = sessionLedgerContext(input, context, deadline);
  } catch (error) {
    if (failures === undefined) throw error;
    logHookFailure(context.paths.home, 'ledger hook session-start', error instanceof Error ? error.message : String(error));
    ledgers = {};
  }
  const additionalContext = [failures?.text, ledgers.text].filter((part) => part !== undefined).join('\n\n');
  if (additionalContext === '') return undefined;
  if (failures !== undefined) markHookFailuresReported(context.paths.home, failures);
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
      ...(ledgers.title === undefined ? {} : { sessionTitle: ledgers.title }),
    },
  };
}

export function preCompactText({ tasks }: SessionLedgers): string {
  if (tasks.length === 0) return '';
  if (tasks.length === 1) return `Task ledger at ${tasks[0].file} is authoritative. Preserve its path and its Next step section verbatim.\n`;
  const newestFirst = [...tasks].sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
  return `${tasks.length} task ledgers exist (most recently modified first). Preserve the path of the ledger this session is working on, and its Next step section verbatim:\n${newestFirst.map(({ file }) => `${file}\n`).join('')}`;
}

const GO = /^\s*go[ \t]+(\S+)\s*$/;

/**
 * Titles the session for a prompt of exactly `go <slug>` that names an active ledger in a worktree of the repo, because
 * Claude Code ignores the SessionStart title after a clear. It replaces no title, a ledger slug or an archived slug.
 */
export function promptSubmit(input: HookInput, context: HookContext): PromptSubmitOutput | undefined {
  const target = GO.exec(input.prompt)?.[1];
  if (target === undefined) return undefined;
  const main = mainCheckout(folderOf(input, context));
  if (main === undefined) return undefined;
  const active = worktreeTasks(main).flatMap(({ ledger }) => ledger.slug ?? []);
  const title = input.sessionTitle;
  if (!active.includes(target) || title === target) return undefined;
  // A title that names no task came from /rename; the operator keeps it.
  if (title !== '' && !active.includes(title) && !archivedTasks(context.store, repoName(main)).some(({ slug }) => slug === title)) return undefined;
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: target } };
}

/** Each gate runs on its own, so one that throws cannot disable the other; with no deny, the first error is thrown. */
export function preToolUse(input: HookInput, context: HookContext): PreToolUseOutput | undefined {
  const errors: unknown[] = [];
  const check = (gate: (input: HookInput, context: HookContext) => string | undefined): string | undefined => {
    try {
      return gate(input, context);
    } catch (error) {
      errors.push(error);
      return undefined;
    }
  };
  const reason = check(worktreeRemovalReason) ?? check(ledgerWriteReason);
  if (reason === undefined && errors.length > 0) throw errors[0];
  return reason === undefined ? undefined : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

/** A path as a shell word names it: without quotes, with ~/ as HOME, relative to `cwd`. */
function pathOf(word: string, cwd: string, home: string): string {
  const unquoted = word.replace(/["']/g, '');
  return path.resolve(cwd, unquoted.startsWith('~/') ? path.join(home, unquoted.slice(2)) : unquoted);
}

/** As bash's [ -f ] and [ -d ]: a path that cannot be checked, such as one too long or not readable, is neither. */
function statOf(file: string): Stats | undefined {
  try {
    return statSync(file);
  } catch {
    return undefined;
  }
}

const isFile = (file: string): boolean => statOf(file)?.isFile() ?? false;

const GLOB = /[*?[]/;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Where the bracket expression whose body starts at `start` closes, and whether it holds a `[:class:]`, `[=x=]` or `[.x.]`. */
function bracketEnd(segment: string, start: number): { close: number; hasClass: boolean } | undefined {
  let hasClass = false;
  for (let index = segment[start] === ']' ? start + 1 : start; index < segment.length; index++) {
    const kind = segment[index + 1];
    const classEnd = segment[index] === '[' && (kind === ':' || kind === '=' || kind === '.') ? segment.indexOf(`${kind}]`, index + 2) : -1;
    if (classEnd !== -1) {
      hasClass = true;
      index = classEnd + 1;
    } else if (segment[index] === ']') return { close: index, hasClass };
  }
  return undefined;
}

/**
 * A pattern for one path segment, as bash matches it: `*`, `?` and `[...]` or `[!...]`; an unclosed `[` is itself.
 * Undefined for a bracket that is no valid class, such as a reversed range, which matches nothing. A bracket with a
 * POSIX class, equivalence class or collating symbol matches any one character: a superset of what bash matches, so the
 * gate denies rather than misses a ledger.
 */
function segmentPattern(segment: string): RegExp | undefined {
  let source = '';
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index];
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else if (char === '\\' && index + 1 < segment.length) source += escapeRegExp(segment[++index]);
    else if (char !== '[') source += escapeRegExp(char);
    else {
      let start = index + 1;
      const negated = segment[start] === '!' || segment[start] === '^';
      if (negated) start++;
      const bracket = bracketEnd(segment, start);
      if (bracket === undefined) {
        source += '\\[';
        continue;
      }
      source += bracket.hasClass ? '.' : `[${negated ? '^' : ''}${segment.slice(start, bracket.close).replace(/[\\\][^]/g, '\\$&')}]`;
      index = bracket.close;
    }
  }
  try {
    return new RegExp(`^${source}$`, 's');
  } catch {
    return undefined;
  }
}

/**
 * The paths a word names after bash's pathname expansion in `cwd`, as an unquoted word in a loop gets it: sorted, a
 * leading dot matched only by a leading dot, and the word itself when nothing matches.
 */
function expandGlob(word: string, cwd: string): string[] {
  if (!GLOB.test(word)) return [word];
  const join = (prefix: string, name: string): string => (prefix === '' ? name : prefix.endsWith('/') ? `${prefix}${name}` : `${prefix}/${name}`);
  const absolute = word.startsWith('/');
  let found = [absolute ? '/' : ''];
  for (const segment of word.split('/').slice(absolute ? 1 : 0)) {
    if (!GLOB.test(segment)) {
      found = found.map((prefix) => join(prefix, segment));
      continue;
    }
    const pattern = segmentPattern(segment);
    found = found.flatMap((prefix) =>
      folderEntries(path.resolve(cwd, prefix || '.'))
        .map(({ name }) => name)
        .filter((name) => pattern !== undefined && pattern.test(name) && (!name.startsWith('.') || segment.startsWith('.')))
        .sort()
        .map((name) => join(prefix, name)),
    );
  }
  const existing = found.filter((match) => statOf(path.resolve(cwd, match)) !== undefined);
  return existing.length > 0 ? existing : [word];
}

const RETIRE_COMMANDS = ['ledger task retire'];
const REMOVALS = ['worktree remove', 'rm -rf', 'rm -fr'];

/** Denies a Bash removal of a folder whose ledger no archive copy names as its worktree. */
function worktreeRemovalReason(input: HookInput, context: HookContext): string | undefined {
  if (input.toolName !== 'Bash') return undefined;
  const command = text(input.toolInput.command);
  if (RETIRE_COMMANDS.some((retire) => command.includes(retire)) || !REMOVALS.some((removal) => command.includes(removal))) return undefined;
  const cwd = folderOf(input, context);
  const holdingLedgers = command
    .split(/\s+/)
    .flatMap((word) => (word === '' ? [] : expandGlob(word, cwd)))
    .filter((word) => !word.startsWith('-'))
    .map((word) => pathOf(word, cwd, context.paths.home))
    .filter((folder) => isFile(worktreeLedger(folder)));
  if (holdingLedgers.length === 0) return undefined;
  const archived = archivedTasks(context.store).flatMap(({ ledger }) => ledger.location.worktree ?? []);
  const unarchived = holdingLedgers.filter((folder) => !archived.some((worktree) => samePath(worktree, folder)));
  if (unarchived.length === 0) return undefined;
  return [
    `This would remove a worktree whose task ledger is not archived:${unarchived.map((folder) => ` ${folder}`).join('')}`,
    '',
    'The ledger is the record of the task. The worktree is not.',
    'Retire it instead, which archives the ledger and then removes the worktree:',
    `  ${context.ledgerBin} task retire <slug>`,
    '',
    `Archived ledgers live in ${context.paths.tilde(context.store.archive.repoLocation('<repo>'))}/.`,
  ].join('\n');
}

const FILE_TOOLS = ['Write', 'Edit', 'MultiEdit'];
const WORKTREE_LEDGER = /\/\.claude\/ledger\.md$/;
// Backlog ledgers are files only with the file store; with SQLite storage no file tool can write one.
const BACKLOG_LEDGER = /\/\.claude\/ledger-backlog\/.*\/.*\.md$/;

const COMMAND_START = String.raw`(?:^|[;&|({])\s*(?:(?:sudo|xargs|env|command|exec|nohup|then|do|else|[A-Za-z_]\w*=\S*)\s+(?:-\S*\s+)*)*(?:\/\S*\/)?`;
const ARGUMENTS = '[^;&|)]*';
const REDIRECT_TARGET = />\s*[^\s;&|<>]+/g;
const TEE = new RegExp(`${COMMAND_START}tee\\s${ARGUMENTS}`, 'g');
const SED_IN_PLACE = new RegExp(`${COMMAND_START}sed\\s(?:${ARGUMENTS}\\s)?-(?:-in-place|[A-Za-z]*i)${ARGUMENTS}`, 'g');
const COPY = new RegExp(`${COMMAND_START}(?:cp|mv)\\s${ARGUMENTS}`, 'g');
const INPUT_REDIRECT = /[0-9]*<<?<?\s*\S*/g;
const ANY_REDIRECT = /[0-9]*(?:>[>|&]?|<<?<?)\s*\S*/g;
const LEDGER_WORD = /^["']?[^\s;&|<>"']*\.claude\/(?:ledger|ledger-backlog\/[^/\s]+\/[^/\s]+)\.md["']?$/;

const matches = (line: string, pattern: RegExp): string[] => [...line.matchAll(pattern)].map(([match]) => match);
const words = (part: string): string[] => part.split(/\s+/).filter((word) => word !== '');

/** A heuristic, line by line: a ledger a command writes is a redirect target, a tee or sed -i argument, or the last argument of cp or mv. */
function bashLedgerTargets(command: string): string[] {
  return command
    .split('\n')
    .flatMap((line) => [
      ...matches(line, REDIRECT_TARGET).map((match) => match.replace(/^>\s*/, '')),
      ...matches(line, TEE).flatMap((match) => words(match.replace(INPUT_REDIRECT, ''))),
      ...matches(line, SED_IN_PLACE).flatMap(words),
      ...matches(line, COPY).map((match) => words(match.replace(ANY_REDIRECT, '')).at(-1) ?? ''),
    ])
    .filter((word) => LEDGER_WORD.test(word));
}

function nearestFolder(file: string): string {
  let folder = path.dirname(file);
  while (!(statOf(folder)?.isDirectory() ?? false) && folder !== path.dirname(folder)) folder = path.dirname(folder);
  return folder;
}

/** Only the text being written: an Edit's old_string may still name an old path. For Bash, the whole command. */
function newText(toolInput: Record<string, unknown>): string {
  const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
  return [toolInput.content, toolInput.new_string, ...edits.map((edit) => (isRecord(edit) ? edit.new_string : undefined)), toolInput.command]
    .filter((part) => typeof part === 'string')
    .join('\n');
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const SESSION_CITATION = new RegExp(`/tmp/claude-[0-9]+/[^/\\s]+/${UUID}|<scratchpad>/\\S|scratchpad/[A-Za-z0-9_.-]`);

const CITATION_REASON =
  "A task ledger may not cite files in the Claude Code session folder or its scratchpad, because macOS deletes them. Move the file to .claude/evidence/ in the task's worktree and cite that path, for example .claude/evidence/xcodebuild-red.log. Copy the file and write the ledger in two separate commands.";

/**
 * Denies a write to .claude/ledger.md in a main checkout, and new ledger text, in a worktree or the backlog, that cites
 * a file in a Claude Code session folder, which macOS deletes.
 */
function ledgerWriteReason(input: HookInput, context: HookContext): string | undefined {
  const { toolName, toolInput } = input;
  const targets = toolName === 'Bash' ? bashLedgerTargets(text(toolInput.command)) : FILE_TOOLS.includes(toolName) ? [text(toolInput.file_path)] : [];
  const cwd = folderOf(input, context);
  const ledgers = targets.map((target) => pathOf(target, cwd, context.paths.home)).filter((file) => WORKTREE_LEDGER.test(file) || BACKLOG_LEDGER.test(file));
  if (ledgers.length === 0) return undefined;
  const inMain = ledgers.filter((file) => WORKTREE_LEDGER.test(file) && inMainCheckout(nearestFolder(file)));
  if (inMain.length > 0) {
    return [
      `This would write a task ledger in a repo's main checkout:${inMain.map((file) => ` ${file}`).join('')}`,
      '',
      "A ledger belongs in the task's worktree, never in the main checkout.",
      'Start the task first. This writes its ledger to the backlog, with no branch or worktree yet:',
      `  ${context.ledgerBin} task new <slug> --goal '<one paragraph>'`,
      'Then give it a branch and a worktree, and move its ledger in:',
      `  ${context.ledgerBin} go <slug>`,
      'Then work in the worktree that ledger go prints.',
      "This check does not follow cd: from the main checkout, use the absolute path to the worktree's .claude/ledger.md.",
    ].join('\n');
  }
  return SESSION_CITATION.test(newText(toolInput)) ? CITATION_REASON : undefined;
}
