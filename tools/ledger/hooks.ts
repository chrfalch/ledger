import { statSync, type Stats } from 'node:fs';
import path from 'node:path';
import { claimClock, otherClaim, type ClaimClock } from './claims.js';
import { limitCloneGitCalls } from './clone.js';
import { Failure } from './failure.js';
import { folderEntries } from './files.js';
import { logHookFailure, markHookFailuresReported, unreportedHookFailures } from './hook-failures.js';
import { findSection, parseLedger, serializeLedger, type Child, type Claim, type Ledger, type TaskRef } from './format.js';
import { checkoutRoot, gitTimedOut, inMainCheckout, limitGitCalls, mainCheckout, worktrees } from './git.js';
import { limitLockWaits } from './lock.js';
import { conversionHint } from './migrate-repo-ids.js';
import { CITATION_ADVICE, realPath, samePath, SESSION_CITATION } from './paths.js';
import { repoKey, repoLabel } from './repo-key.js';
import { holdsUnmovedLedger, keepsUnmovedLedger, loadTasks } from './registry.js';
import { pullForSession, syncNotice } from './sync.js';
import { keyAndAliases, type LedgerStore } from './store.js';
import { activeTask, activeTasks, archivedTasks, findNamed, findTasks, locateChild, namedChildren, type Task } from './tasks.js';
import { plural } from './views.js';
import type { Context } from './write.js';

// @ref LLP 0000#hooks — the four events, their registration in settings.policy.json, and why a failed hook allows the call.

/** `ledgerBin` is the path deny reasons name, so a reader can run it without `ledger` on PATH. */
export type HookContext = Context & { ledgerBin: string };

export const HOOK_EVENTS = ['session-start', 'prompt-submit', 'pre-compact', 'pre-tool-use'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The fields of Claude Code's hook input that the hooks read; a missing or mistyped field is empty. */
export type HookInput = { cwd: string; sessionId: string; prompt: string; sessionTitle: string; toolName: string; toolInput: Record<string, unknown> };

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
    sessionId: text(input.session_id),
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
      return preCompactText(sessionLedgers(context.store, folderOf(input, context)));
    case 'pre-tool-use':
      return json(preToolUse(input, context));
  }
}

/** The ledgers a session works on. `own` says the first is the ledger of the session's folder itself. */
export type SessionLedgers = { tasks: Task[]; own: boolean };

/**
 * The ledgers of a session in `cwd`. In a main checkout: the active tasks of its linked worktrees, wherever they live,
 * never one of its own, as an active task lives only in a linked worktree. In a linked worktree: its own active task.
 * Outside a git repository: none.
 */
export function sessionLedgers(store: LedgerStore, cwd: string): SessionLedgers {
  const root = checkoutRoot(cwd);
  const main = mainCheckout(cwd);
  if (root === undefined || main === undefined) return { tasks: [], own: false };
  if (inMainCheckout(cwd)) return { tasks: activeTasks(store, repoKey(main)).filter(({ worktree }) => worktree === undefined || !samePath(worktree, main)), own: false };
  const task = activeTask(store, root);
  // Two machines can see one disk, so a record of another machine can name this folder; it is never the session's own.
  return { tasks: task === undefined ? [] : [task], own: task !== undefined && !task.elsewhere };
}

/** The slug that titles the session: only when its one ledger is its folder's own. */
export const sessionTitle = ({ tasks, own }: SessionLedgers): string | undefined => (own && tasks.length === 1 ? tasks[0].ledger.slug : undefined);

const shown = ({ slug, main }: TaskRef): string => (main === undefined ? slug : `${slug} @ ${main}`);

/** A task in a repo whose git did not answer in time is unknown, not missing; asking git for its checkout finds that out, once. */
function statusText(ref: Required<TaskRef> | undefined, find: (ref: Required<TaskRef>) => Task | undefined): string {
  if (ref === undefined) return 'missing';
  if (mainCheckout(ref.main) === undefined && gitTimedOut(ref.main)) return 'unknown';
  const task = find(ref);
  if (task === undefined) return 'missing';
  return task.status === 'retired' && task.archived !== undefined ? `retired ${task.archived}` : task.status;
}

/** An active task beats a backlog ledger, which beats the newest archive copy. */
function namedTask(tasks: Task[], ref: Required<TaskRef>): Task | undefined {
  const named = findNamed(tasks, ref);
  return named.find(({ place }) => place === 'active') ?? named[0];
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

/**
 * The SessionStart context for one or more ledgers. `tasks` are all known tasks, for the parent and child statuses.
 * `heldElsewhere` gives the live claim of another session on a ledger.
 */
export function sessionStartText({ tasks: ledgers }: SessionLedgers, tasks: Task[], heldElsewhere: (task: Task) => Claim | undefined): string {
  const lead = (task: Task): string => {
    const held = heldElsewhere(task);
    const heldLine = held === undefined ? [] : [`Held by another session: ${held.session} since ${held.since}, active ${held.active}.`];
    return [...relationLines(task, tasks), ...heldLine].map((line) => `${line}\n`).join('');
  };
  const inWorktree = ({ worktree }: Task, words: string): string => (worktree === undefined ? '' : ` ${words} ${worktree}`);
  if (ledgers.length === 1) {
    const [task] = ledgers;
    return `A task ledger exists for ${task.slug}${inWorktree(task, 'in the worktree')}. It is kept in the ledger store; its contents follow. If it has open steps, continue from Next step without re-verifying finished steps. Write to it with \`ledger notes\`, never by editing a file.\n${lead(task)}\n${serializeLedger(task.ledger)}`;
  }
  const summaries = ledgers.map((task) => `\n=== ${task.slug}${inWorktree(task, 'in')}\n${lead(task)}${summary(task.ledger)}`).join('');
  return `${ledgers.length} task ledgers exist. Summary of each follows. If asked what we are working on, answer from this. Before continuing one, ask which, then read its full ledger. Each is kept in the ledger store: read it with \`ledger show <slug>\`, and write to it with \`ledger notes\`, never by editing a file.\n${summaries}`;
}

/** A hint for the linked worktrees of the repo of `cwd` whose ledger is still a .claude/ledger.md. A git call that times out lists no worktree. */
function unmovedHint(store: LedgerStore, cwd: string): string | undefined {
  const main = mainCheckout(cwd);
  if (main === undefined) return undefined;
  const count = worktrees(main)
    .slice(1)
    .filter((linked) => keepsUnmovedLedger(store, linked.path)).length;
  return count === 0 ? undefined : `${plural(count, 'ledger')} still kept in .claude/ledger.md; run \`ledger store migrate --active\`.`;
}

/** The registry is a cache: a session start that cannot write it still shows its ledgers. */
function tasksOnDisk(context: HookContext): Task[] {
  try {
    return loadTasks(context);
  } catch {
    return findTasks(context.store);
  }
}

/**
 * With git storage it pulls first, and a sync problem adds one line before the ledgers. The pull, and every git call and
 * lock wait after it, opening and closing the store too, end by `deadline`.
 */
function sessionLedgerContext(input: HookInput, context: HookContext, deadline: number): { hint?: string; text?: string; title?: string } {
  limitLockWaits(deadline);
  limitCloneGitCalls(deadline);
  // Opened first, as git in the session folder may use up the time that is left after the pull.
  void context.store;
  pullForSession(context.paths, deadline - AFTER_PULL_MS);
  limitGitCalls(GIT_TIMEOUT_MS, deadline);
  // After the pull, which may bring ledgers under folder names, and before the ledgers, whose registry rebuild re-keys the entries the hint counts.
  const conversion = conversionHint(context.store);
  const notice = syncNotice(context.paths);
  const cwd = folderOf(input, context);
  const found = sessionLedgers(context.store, cwd);
  let clock: ClaimClock | undefined;
  const heldElsewhere = ({ ledger: { location } }: Task): Claim | undefined =>
    location.claim && otherClaim(location.claim, input.sessionId || undefined, (clock ??= claimClock(context.paths.home)));
  const ledgers = found.tasks.length === 0 ? undefined : sessionStartText(found, tasksOnDisk(context), heldElsewhere);
  // Last, so a worktree listing that hangs costs the hint and not the ledgers.
  const hint = [conversion, unmovedHint(context.store, cwd)].filter((part) => part !== undefined).join('\n') || undefined;
  if (ledgers === undefined) return { hint, text: notice };
  return { hint, text: notice === undefined ? ledgers : `${notice}\n${ledgers}`, title: sessionTitle(found) };
}

/**
 * Hook failures since the last report come first, above the sync notice and the ledgers, and count as reported once the
 * output is built. When the pull or the ledger part throws, the report still goes out alone and the new failure waits
 * for the next one.
 */
export function sessionStart(input: HookInput, context: HookContext, deadline = Date.now() + GIT_TIMEOUT_MS): SessionStartOutput | undefined {
  const failures = unreportedHookFailures(context.paths);
  let ledgers: { hint?: string; text?: string; title?: string };
  try {
    ledgers = sessionLedgerContext(input, context, deadline);
  } catch (error) {
    if (failures === undefined) throw error;
    logHookFailure(context.paths.home, 'ledger hook session-start', error instanceof Error ? error.message : String(error));
    ledgers = {};
  }
  const additionalContext = [failures?.text, ledgers.hint, ledgers.text].filter((part) => part !== undefined).join('\n\n');
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

/** `mtimeMs` of an active task is when its record was last written. */
export function preCompactText({ tasks }: SessionLedgers): string {
  if (tasks.length === 0) return '';
  if (tasks.length === 1) {
    const [{ slug, worktree }] = tasks;
    return `Task ledger ${slug}${worktree === undefined ? '' : ` (worktree ${worktree})`} is kept in the ledger store and is authoritative. Preserve its slug, worktree path and its Next step section verbatim.\n`;
  }
  const newestFirst = [...tasks].sort((a, b) => b.mtimeMs - a.mtimeMs || a.slug.localeCompare(b.slug));
  const lines = newestFirst.map(({ slug, worktree }) => `${worktree === undefined ? slug : `${slug} — ${worktree}`}\n`).join('');
  return `${tasks.length} task ledgers exist (most recently updated first), kept in the ledger store. Preserve the slug and worktree of the one this session is working on, and its Next step section verbatim:\n${lines}`;
}

const GO = /^\s*go[ \t]+(\S+)\s*$/;

/**
 * Titles the session for a prompt of exactly `go <slug>` that names an active ledger in a worktree of the repo, because
 * Claude Code ignores the SessionStart title after a clear. Any title gives way, one the operator typed too, unless this
 * session already claims that task. The worktree's own task does not count: after a clear into it, the old title remains.
 */
export function promptSubmit(input: HookInput, context: HookContext): PromptSubmitOutput | undefined {
  const target = GO.exec(input.prompt)?.[1];
  if (target === undefined) return undefined;
  const main = mainCheckout(folderOf(input, context));
  if (main === undefined) return undefined;
  const { store } = context;
  // From the records alone: the hook runs at every prompt, so it asks git nothing per task.
  const active = keyAndAliases(store.aliases.read(), repoKey(main)).flatMap((repo) => store.active.list(repo).map(({ text }) => parseLedger(text)));
  if (!active.some(({ slug }) => slug === target) || input.sessionTitle === target) return undefined;
  const claimed = input.sessionId === '' ? undefined : active.find(({ location }) => location.claim?.session === input.sessionId)?.slug;
  if (claimed === target) return undefined;
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

function archiveHint(cwd: string, { paths, store }: HookContext): string {
  const main = mainCheckout(cwd);
  if (main === undefined) return `Archived ledgers live in ${paths.tilde(store.archive.repoLocation())}/.`;
  const key = repoKey(main);
  return `Archived ledgers of ${repoLabel(key)} live in ${paths.tilde(store.archive.repoLocation(key))}/.`;
}

/**
 * Denies a Bash removal of a linked worktree whose ledger is still a .claude/ledger.md, and of a folder whose ledger no
 * archive copy names as its worktree.
 */
function worktreeRemovalReason(input: HookInput, context: HookContext): string | undefined {
  if (input.toolName !== 'Bash') return undefined;
  const command = text(input.toolInput.command);
  if (RETIRE_COMMANDS.some((retire) => command.includes(retire)) || !REMOVALS.some((removal) => command.includes(removal))) return undefined;
  const cwd = folderOf(input, context);
  const named = command
    .split(/\s+/)
    .flatMap((word) => (word === '' ? [] : expandGlob(word, cwd)))
    .filter((word) => !word.startsWith('-'))
    .map((word) => pathOf(word, cwd, context.paths.home));
  const shared: string[] = [];
  const holdingLedgers = named.filter((folder) => {
    try {
      return context.store.active.byWorktree(folder) !== undefined;
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      shared.push(error.message);
      return false;
    }
  });
  if (shared.length > 0) {
    return [
      `This would remove a worktree that more than one active task names. ${shared.join(' ')}`,
      '',
      'Retire each of those tasks, or fix the record that names the wrong worktree, before the worktree is removed:',
      `  ${context.ledgerBin} task retire <slug>`,
    ].join('\n');
  }
  const unmoved = named.filter((folder) => holdsUnmovedLedger(context.store, folder));
  if (unmoved.length > 0) {
    return [
      `This would remove a worktree whose task ledger is not yet moved into the ledger store:${unmoved.map((folder) => ` ${folder}`).join('')}`,
      '',
      'Its .claude/ledger.md is the record of the task. Move it into the store, then retire the task, which archives the ledger and then removes the worktree:',
      `  ${context.ledgerBin} store migrate --active`,
      `  ${context.ledgerBin} task retire <slug>`,
    ].join('\n');
  }
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
    archiveHint(cwd, context),
  ].join('\n');
}

const FILE_TOOLS = ['Write', 'Edit', 'MultiEdit'];
const CITATION_REASON = `${CITATION_ADVICE} Copy the file and write the ledger in two separate commands.`;
const LEGACY_LEDGER_FILE = /\/\.claude\/ledger\.md$/;
// Backlog ledgers are files only with the file store; with SQLite storage no file tool can write one.
const BACKLOG_LEDGER = /\/\.claude\/ledger-backlog\/.*\/.*\.md$/;

const COMMAND_START = String.raw`(?:^|[;&|({])\s*(?:(?:sudo|xargs|env|command|exec|nohup|then|do|else|[A-Za-z_]\w*=\S*)\s+(?:-\S*\s+)*)*(?:\/\S*\/)?`;
const ARGUMENTS = '[^;&|)]*';
const REDIRECT_TARGET = />\s*[^\s;&|<>]+/g;
const TEE = new RegExp(`${COMMAND_START}tee\\s${ARGUMENTS}`, 'g');
const SED_IN_PLACE = new RegExp(`${COMMAND_START}sed\\s(?:${ARGUMENTS}\\s)?-(?:-in-place|[A-Za-z]*i)${ARGUMENTS}`, 'g');
const COPY = new RegExp(`${COMMAND_START}(?:cp|mv)\\s${ARGUMENTS}`, 'g');
const CD = new RegExp(`${COMMAND_START}cd\\s+([^\\s;&|)]+)`, 'g');
const INPUT_REDIRECT = /[0-9]*<<?<?\s*\S*/g;
const ANY_REDIRECT = /[0-9]*(?:>[>|&]?|<<?<?)\s*\S*/g;

/** Each match of `pattern` in `line`, as `read` gives its words, with where in the line it starts. */
const matches = (line: string, pattern: RegExp, read: (match: string) => string[]): { word: string; at: number }[] =>
  [...line.matchAll(pattern)].flatMap(({ 0: match, index }) => read(match).map((word) => ({ word, at: index })));
const words = (part: string): string[] => part.split(/\s+/).filter((word) => word !== '');

/**
 * A heuristic, line by line: a file a command writes is a redirect target, a tee or sed -i argument, or the last argument
 * of cp or mv. Each is resolved against `cwd` as each cd before it on its line changed it.
 */
function bashWriteTargets(command: string, cwd: string, home: string): string[] {
  return command.split('\n').flatMap((line) => {
    const cds = [...line.matchAll(CD)].map(({ 1: folder, index }) => ({ folder, at: index }));
    const folderAt = (at: number): string => cds.filter((cd) => cd.at < at).reduce((folder, cd) => pathOf(cd.folder, folder, home), cwd);
    return [
      ...matches(line, REDIRECT_TARGET, (match) => [match.replace(/^>\s*/, '')]),
      ...matches(line, TEE, (match) => words(match.replace(INPUT_REDIRECT, ''))),
      ...matches(line, SED_IN_PLACE, words),
      ...matches(line, COPY, (match) => words(match.replace(ANY_REDIRECT, '')).slice(-1)),
    ]
      .filter(({ word }) => word !== '')
      .map(({ word, at }) => pathOf(word, folderAt(at), home));
  });
}

/** `file` as written, with the symbolic links to it resolved, and with those of its folder resolved. */
const pathsOf = (file: string): string[] => [file, realPath(file), path.join(realPath(path.dirname(file)), path.basename(file))];

/** Only the text being written: an Edit's old_string may still name an old path. For Bash, the whole command. */
function newText(toolInput: Record<string, unknown>): string {
  const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
  return [toolInput.content, toolInput.new_string, ...edits.map((edit) => (isRecord(edit) ? edit.new_string : undefined)), toolInput.command]
    .filter((part) => typeof part === 'string')
    .join('\n');
}

/**
 * Denies a write to a .claude/ledger.md anywhere, as an active task's ledger lives in the store, and new backlog ledger
 * text that cites a file in a Claude Code session folder, which macOS deletes.
 */
function ledgerWriteReason(input: HookInput, context: HookContext): string | undefined {
  const { toolName, toolInput } = input;
  const cwd = folderOf(input, context);
  const { home } = context.paths;
  const files = toolName === 'Bash' ? bashWriteTargets(text(toolInput.command), cwd, home) : FILE_TOOLS.includes(toolName) ? [pathOf(text(toolInput.file_path), cwd, home)] : [];
  const legacy = files.flatMap(pathsOf).filter((file) => LEGACY_LEDGER_FILE.test(file));
  if (legacy.length > 0) {
    const bin = context.ledgerBin;
    const unmoved = legacy.some((file) => {
      try {
        return holdsUnmovedLedger(context.store, path.dirname(path.dirname(file)));
      } catch {
        // A store that cannot be read costs only this line: the write is denied all the same.
        return false;
      }
    });
    return [
      `Task ledgers are kept in the ledger store, not in .claude/ledger.md. Read this task's ledger with \`${bin} show\`. Write one item with \`${bin} notes <command>\`; \`${bin} notes --help\` lists them.`,
      ...(unmoved ? [`This ledger has not been moved yet: run \`${bin} store migrate --active\`.`] : []),
    ].join('\n');
  }
  return files.some((file) => BACKLOG_LEDGER.test(file)) && SESSION_CITATION.test(newText(toolInput)) ? CITATION_REASON : undefined;
}
