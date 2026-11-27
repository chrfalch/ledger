import { statSync, type Stats } from 'node:fs';
import path from 'node:path';
import { openTreesReport, sessionReport } from './awareness.js';
import { claimClock, otherClaim, type ClaimClock } from './claims.js';
import { clonePaths, limitCloneGitCalls } from './clone.js';
import { Failure } from './failure.js';
import { fileStoreRoots } from './file-store.js';
import { folderEntries } from './files.js';
import { logHookFailure, markHookFailuresReported, unreportedHookFailures } from './hook-failures.js';
import { parseLedger, type Claim } from './format.js';
import { checkoutRoot, gitTimedOut, inMainCheckout, limitGitCalls, mainCheckout, worktrees } from './git.js';
import { limitLockWaits, lockFile, reclaimGuard } from './lock.js';
import { conversionHint } from './migrate-repo-ids.js';
import { CITATION_ADVICE, realPath, samePath, SESSION_CITATION, type LedgerPaths } from './paths.js';
import { prCheckLines, type CheckedLine } from './pr-check.js';
import { repoKey, repoLabel } from './repo-key.js';
import { logRootAction, markRootActionsReported, rootLogFiles, rootMarker, rootState, unreportedRootActions } from './root.js';
import { runClock } from './run-io.js';
import { holdsUnmovedLedger, keepsUnmovedLedger } from './unmoved.js';
import { sqliteFile } from './sqlite-store.js';
import { pullForSession, syncNotice } from './sync.js';
import { keyAndAliases, type LedgerStore } from './store.js';
import { activeTask, activeTasks, archivedTasks, inRepo, storedTasks, type Task } from './tasks.js';
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

let gitTimeoutMs = GIT_TIMEOUT_MS;
let afterPullMs = AFTER_PULL_MS;

/**
 * For tests only: the time limit of a hook, of which the session start keeps the same share for the ledgers after the
 * pull. A module the tests preload calls it. Gives the limit it replaces.
 */
export function limitHookTimeForTests(ms: number): number {
  const replaced = gitTimeoutMs;
  gitTimeoutMs = ms;
  afterPullMs = (ms * AFTER_PULL_MS) / GIT_TIMEOUT_MS;
  return replaced;
}

/**
 * What the hook prints on stdout for Claude Code's JSON `stdin`: hook JSON, plain text for pre-compact, or nothing.
 * Throws on input it cannot read and on any other error; the caller decides how a hook fails. Limits every later git
 * call of the process, so a repository that hangs cannot stall Claude Code.
 */
export function answerHook(event: HookEvent, stdin: string, context: HookContext): string {
  const deadline = Date.now() + gitTimeoutMs;
  limitGitCalls(gitTimeoutMs);
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
 * never one of its own, as an active task lives only in a linked worktree, and none that is lost. In a linked worktree:
 * its own active task. Outside a git repository: none. With `stored`, which gives storedTasks for a main checkout, a main
 * checkout's tasks come from that list, so that git is not asked about each of them.
 */
export function sessionLedgers(store: LedgerStore, cwd: string, stored?: (main: string) => Task[]): SessionLedgers {
  const root = checkoutRoot(cwd);
  const main = mainCheckout(cwd);
  if (root === undefined || main === undefined) return { tasks: [], own: false };
  if (inMainCheckout(cwd)) {
    const active = stored?.(main).filter((task) => task.place === 'active' && inRepo(task, main)) ?? activeTasks(store, repoKey(main));
    const tasks = active.filter(({ worktree, status }) => status !== 'lost' && (worktree === undefined || !samePath(worktree, main)));
    return { tasks, own: false };
  }
  const task = activeTask(store, root);
  // Two machines can see one disk, so a record of another machine can name this folder; it is never the session's own.
  // A record of this machine still is when git did not list the worktree in time, as a main checkout that hangs would
  // otherwise leave the session without its task.
  const own = task !== undefined && (!task.elsewhere || (task.host === undefined && gitTimedOut(root)));
  return { tasks: task === undefined ? [] : [task], own };
}

/** The slug that titles the session: only when its one ledger is its folder's own. */
export const sessionTitle = ({ tasks, own }: SessionLedgers): string | undefined => (own && tasks.length === 1 ? tasks[0].ledger.slug : undefined);

/** A hint for the linked worktrees of the repo of `cwd` whose ledger is still a .claude/ledger.md. A git call that times out lists no worktree. */
function unmovedHint(store: LedgerStore, cwd: string): string | undefined {
  const main = mainCheckout(cwd);
  if (main === undefined) return undefined;
  const count = worktrees(main)
    .slice(1)
    .filter((linked) => keepsUnmovedLedger(store, linked.path)).length;
  return count === 0 ? undefined : `${plural(count, 'ledger')} still kept in .claude/ledger.md; run \`ledger store migrate --active\`.`;
}

/**
 * The report on the task the folder owns (D26), else the open trees of the repo at `main` (D27); undefined outside a
 * repo. A main checkout owns no task, so it gets the trees. `checked` is what the PR check found, for its Needs you section.
 */
function awarenessText(input: HookInput, context: HookContext, found: SessionLedgers, main: string | undefined, tasks: Task[], checked: CheckedLine[]): string | undefined {
  if (found.own) {
    let clock: ClaimClock | undefined;
    const heldElsewhere = ({ ledger: { location } }: Task): Claim | undefined =>
      location.claim && otherClaim(location.claim, input.sessionId || undefined, (clock ??= claimClock(context.paths.home)));
    return sessionReport(found, tasks, heldElsewhere, checked);
  }
  return main === undefined ? undefined : openTreesReport(tasks, main, checked);
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
  pullForSession(context.paths, deadline - afterPullMs);
  limitGitCalls(gitTimeoutMs, deadline);
  // After the pull, which may bring ledgers under folder names.
  const conversion = conversionHint(context.store);
  const notice = syncNotice(context.paths);
  const cwd = folderOf(input, context);
  // The session's own task first, as git in the main checkout may hang; a main checkout's tasks are the stored ones.
  let stored: Task[] | undefined;
  const found = sessionLedgers(context.store, cwd, (checkout) => (stored = storedTasks(context.store, checkout)));
  const main = mainCheckout(cwd);
  const tasks = stored ?? storedTasks(context.store, main);
  // Last, so a worktree listing that hangs costs the hint and not the ledgers.
  const hint = [conversion, unmovedHint(context.store, cwd)].filter((part) => part !== undefined).join('\n') || undefined;
  // After the ledgers, so gh's own time limit never eats into git's.
  const checked = prCheckLines(context, found, found.tasks.length === 0 ? [] : tasks);
  const now = found.tasks.length > 0 && tasks.some(({ status }) => status === 'waiting') ? afterPrCheck(context.store, found, main) : { found, tasks };
  const ledgers = awarenessText(input, context, now.found, main, now.tasks, checked);
  if (ledgers === undefined) return { hint, text: notice };
  return { hint, text: notice === undefined ? ledgers : `${notice}\n${ledgers}`, title: sessionTitle(now.found) };
}

/**
 * `found` and the tasks of the store as they are after the PR check, which may have changed a waiting task or seen that
 * another session did. The session's own tasks keep what git found; only what their records say is read again.
 */
function afterPrCheck(store: LedgerStore, found: SessionLedgers, main: string | undefined): { found: SessionLedgers; tasks: Task[] } {
  const tasks = storedTasks(store, main);
  const byFile = new Map(tasks.map((task) => [task.file, task]));
  const own = found.tasks.map((task) => {
    const stored = byFile.get(task.file);
    return stored === undefined ? task : { ...task, slug: stored.slug, status: stored.status, ledger: stored.ledger, mtimeMs: stored.mtimeMs };
  });
  return { found: { ...found, tasks: own }, tasks };
}

/**
 * Hook failures since the last report come first, then the calls allowed only because ledger root was on, above the sync
 * notice and the ledgers; both count as reported once the output is built. When the pull or the ledger part throws, those
 * reports still go out alone and the new failure waits for the next one.
 */
export function sessionStart(input: HookInput, context: HookContext, deadline = Date.now() + gitTimeoutMs): SessionStartOutput | undefined {
  const failures = unreportedHookFailures(context.paths);
  const allowed = unreportedRootActions(context.paths.home);
  let ledgers: { hint?: string; text?: string; title?: string };
  try {
    ledgers = sessionLedgerContext(input, context, deadline);
  } catch (error) {
    if (failures === undefined && allowed === undefined) throw error;
    logHookFailure(context.paths.home, 'ledger hook session-start', error instanceof Error ? error.message : String(error));
    ledgers = {};
  }
  const additionalContext = [failures?.text, allowed?.text, ledgers.hint, ledgers.text].filter((part) => part !== undefined).join('\n\n');
  if (additionalContext === '') return undefined;
  if (failures !== undefined) markHookFailuresReported(context.paths.home, failures);
  if (allowed !== undefined) markRootActionsReported(context.paths.home, allowed);
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
  if (input.sessionId !== '' && active.some(({ slug, location }) => slug === target && location.claim?.session === input.sessionId)) return undefined;
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: target } };
}

/**
 * Each gate runs on its own, so one that throws cannot disable the other; with no deny, the first error is thrown. The
 * root switch check alone fails closed: had it missed an agent's switch, root would lift the other gates' denies.
 */
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
  const deny = (reason: string): PreToolUseOutput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  let switchReason: string | undefined;
  try {
    switchReason = rootSwitchReason(input, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logHookFailure(context.paths.home, 'ledger hook pre-tool-use', message);
    return deny(`The ledger root check failed, so this call is denied: ${message}`);
  }
  if (switchReason !== undefined) return deny(switchReason);
  const reason = check(worktreeRemovalReason) ?? check(ledgerWriteReason) ?? check(storeWriteReason);
  if (reason === undefined && errors.length > 0) throw errors[0];
  if (reason === undefined) return undefined;
  const now = runClock().now();
  if (!rootState(context.paths.home, now).on) return deny(reason);
  logRootAction(context.paths.home, { tool: input.toolName, cwd: folderOf(input, context), reason, ...actionSubject(input, context) }, now);
  return undefined;
}

const actionSubject = (input: HookInput, context: HookContext): { command: string } | { file: string } =>
  input.toolName === 'Bash' ? { command: text(input.toolInput.command) } : { file: toolFile(input, context) };

/** `word` without its quotes, with each quoted *, ? and [ escaped, as bash matches them literally. */
const unquote = (word: string): string => word.replace(/'([^']*)'|"([^"]*)"|["']/g, (_: string, single?: string, double?: string) => (single ?? double ?? '').replace(/[*?[]/g, '\\$&'));
/** A leading ~, or $HOME or ${HOME} unquoted or in double quotes: bash expands nothing in single quotes. */
const HOME_PREFIX = /^(?:~(?=\/|$)|("?)\$(?:HOME|\{HOME\})(?=[/"]|$))/;

/** A path as a shell word names it: without quotes, with a leading HOME prefix as HOME, relative to `cwd`. */
function pathOf(word: string, cwd: string, home: string): string {
  return path.resolve(cwd, unquote(word.replace(HOME_PREFIX, (_: string, quote?: string) => `${quote ?? ''}${home}`)));
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

/** The members of each POSIX class as a regular expression class body, as in the C locale: the store's names are ASCII. */
const POSIX_CLASSES = new Map([
  ['alnum', '0-9A-Za-z'],
  ['alpha', 'A-Za-z'],
  ['ascii', '\\x00-\\x7f'],
  ['blank', ' \\t'],
  ['cntrl', '\\x00-\\x1f\\x7f'],
  ['digit', '0-9'],
  ['graph', '!-~'],
  ['lower', 'a-z'],
  ['print', ' -~'],
  ['punct', '!-/:-@\\[-`{-~'],
  ['space', '\\t-\\r '],
  ['upper', 'A-Z'],
  ['word', '\\w'],
  ['xdigit', '0-9A-Fa-f'],
]);
const classMember = (char: string): string => (/[\\\][^]/.test(char) ? `\\${char}` : char);

/**
 * Where the bracket expression whose body starts at `start` closes, and its body as a regular expression class body: a
 * `[:class:]` as its members, a `[=x=]` or `[.x.]` of one character as that character, and a character after a `\` as
 * itself, so `\-` is no range. The body is undefined for an unknown class or a longer collating symbol.
 */
function bracketAt(segment: string, start: number): { close: number; body: string | undefined } | undefined {
  let body: string | undefined = '';
  for (let index = start; index < segment.length; index++) {
    const kind = segment[index + 1];
    const classEnd = segment[index] === '[' && (kind === ':' || kind === '=' || kind === '.') ? segment.indexOf(`${kind}]`, index + 2) : -1;
    if (classEnd !== -1) {
      const name = segment.slice(index + 2, classEnd);
      const members = kind === ':' ? POSIX_CLASSES.get(name) : name.length === 1 ? classMember(name) : undefined;
      body = body === undefined || members === undefined ? undefined : body + members;
      index = classEnd + 1;
    } else if (segment[index] === ']' && index > start) return { close: index, body };
    else if (segment[index] === '\\' && index + 1 < segment.length) {
      const escaped = segment[++index];
      if (body !== undefined) body += escaped === '-' ? '\\-' : classMember(escaped);
    } else if (body !== undefined) body += classMember(segment[index]);
  }
  return undefined;
}

/**
 * A pattern for one path segment, as bash matches it: `*`, `?` and `[...]` or `[!...]`; an unclosed `[` is itself.
 * Undefined for a bracket that is no valid class, such as a reversed range, which matches nothing. A bracket whose class
 * or collating symbol is not known matches any one character: a superset of what bash matches, so the gate denies
 * rather than misses a ledger.
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
      const bracket = bracketAt(segment, start);
      if (bracket === undefined) {
        source += '\\[';
        continue;
      }
      source += bracket.body === undefined ? '.' : `[${negated ? '^' : ''}${bracket.body}]`;
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
  const command = allLines(parseScript(text(input.toolInput.command))).join('\n');
  if (RETIRE_COMMANDS.some((retire) => command.includes(retire)) || !REMOVALS.some((removal) => command.includes(removal))) return undefined;
  const cwd = folderOf(input, context);
  const named = words(command)
    .flatMap((word) => expandGlob(unmask(word), cwd))
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
const ledgerCommands = (bin: string): string => `Read a task with \`${bin} show [<slug>]\`. Write one item with \`${bin} notes <command>\`; \`${bin} notes --help\` lists them.`;
const LEGACY_LEDGER_FILE = /\/\.claude\/ledger\.md$/;
// Backlog ledgers are files only with the file store; with SQLite storage no file tool can write one.
const BACKLOG_LEDGER = /\/\.claude\/ledger-backlog\/.*\/.*\.md$/;

/** A redirect, here-string or here-document operator with its word, which may stand before the command word. */
const LEADING_REDIRECT = String.raw`\d*(?:&>>?|>[>|&]?|<<<|<<-?|<&?)\s*[^\s;&|<>()]+`;
/**
 * Text before a word that bash reads as the start of a command: the start of a line or a `;`, `&`, `|`, `(` or `{`, then
 * any keywords that themselves stand there, `time -p` and `coproc NAME` too. A keyword word after an argument, as in
 * `echo then fi`, is an argument too.
 */
const BEFORE_COMMAND = String.raw`(?:^|[\n;&|({])\s*(?:(?:if|elif|while|until|for|then|else|do|!|time(?:\s+-p)?|coproc(?:\s+[A-Za-z_]\w*)?)(?:\s+|$))*`;
// The & of an &> starts no command, or `ls &>log rm x` would read rm as one. A { starts one only where it opens a group,
// as in `f() {` or `function f {`: in `echo {` it is an argument.
const COMMAND_START = String.raw`(?:^|[;|(]|&(?!>)|(?<=(?:${BEFORE_COMMAND}|\)\s*|\bfunction\s+[^\s;&|()]+\s+))\{)\s*(?:(?:sudo|xargs|env|command|exec|nohup|time|if|elif|then|else|do|while|until|!|[A-Za-z_]\w*=\S*|${LEADING_REDIRECT})\s+(?:-\S*\s+)*)*(?:\/\S*\/)?`;
/**
 * A command's arguments as read here. The & of a `>&`, `<&` or `&>` redirects and ends no command, so `git reset 2>&1 -h`
 * keeps its -h. A `<(` or `>(` ends them: the words of a process substitution are not the arguments of the command around it.
 */
const ARGUMENTS = '(?:[^;&|)<>]|[<>](?!\\()|(?<=[<>])&|&(?=>))*';
/** The options, `--` and redirects between `command` and the words its -v or -V only describes, not runs. */
const DESCRIBE_WORD = String.raw`(?:-\w+|--|${LEADING_REDIRECT})`;
const DESCRIBED = String.raw`(?<!\bcommand(?:\s+${DESCRIBE_WORD})*\s+-\w*[vV]\w*(?:\s+${DESCRIBE_WORD})*\s+)`;
/** A run of one of the commands `names`, with what follows the name up to the end of the command as its first group. */
const invocation = (names: string, rest = ARGUMENTS): RegExp => new RegExp(`${COMMAND_START}${DESCRIBED}(?:${names})\\s(${rest})`, 'g');
/** The `&` of a `>&` that sends both outputs to its word: one with no file descriptor before it, nor a descriptor or `-` after it. */
const BOTH_OUTPUTS = String.raw`(?<!(?:^|[\s;&|(])\d+>)&(?!\s*(?:\d+|-)(?![^\s;&|<>)]))`;
const REDIRECT_TARGET = new RegExp(String.raw`>(?:\||${BOTH_OUTPUTS})?\s*([^\s;&|<>)]+)`, 'g');
const TEE = invocation('tee');
const SED_IN_PLACE = invocation('sed', `(?:${ARGUMENTS}\\s)?-(?:-in-place|[A-Za-z]*i)${ARGUMENTS}`);
const COPY = invocation('cp|mv');
const MOVE = invocation('mv');
const REMOVE = invocation('rm|rmdir');
const TOUCH = invocation('touch');
const TRUNCATE = invocation('truncate');
const MKDIR = invocation('mkdir');
const LINK = invocation('ln');
const SQLITE = invocation('sqlite3');
const GIT = invocation('git');
const WORD_END = String.raw`(?![^\s;&|)])`;
/** A cd, its -P, -L, -e and -@ options and a `--` skipped, with its folder word, if any, as the first group. */
const CD = new RegExp(String.raw`${COMMAND_START}${DESCRIBED}cd(?:\s+-[PLe@]+${WORD_END})*(?:\s+--${WORD_END})?(?:\s+([^\s;&|)]+))?${WORD_END}`, 'g');
const ANY_REDIRECT = /[0-9]*(?:&>>?|>[>|&]?|<&|<<?<?)\s*\S*/g;

const words = (part: string): string[] => part.split(/\s+/).filter((word) => word !== '');
const optionsEnd = (args: string[]): number => (args.includes('--') ? args.indexOf('--') : args.length);
/** Whether the word after `arg` is a value: `arg` is one of `valueOptions`, or a bundle of short options, as in `-cr`, that the first of them to take a value ends. */
const valueFollows = (arg: string | undefined, valueOptions: string[]): boolean =>
  arg !== undefined && (valueOptions.includes(arg) || (/^-[^-]/.test(arg) && [...arg.slice(1)].findIndex((letter) => valueOptions.includes(`-${letter}`)) === arg.length - 2));
/** The operands among `args`: each word that is no option nor the value after one of `valueOptions`, and every word after `--`. */
function operandsOf(args: string[], valueOptions: string[] = []): string[] {
  const end = optionsEnd(args);
  return [...args.slice(0, end).filter((arg, index) => !arg.startsWith('-') && !valueFollows(args[index - 1], valueOptions)), ...args.slice(end + 1)];
}
const operands = (part: string): string[] => operandsOf(words(part.replace(ANY_REDIRECT, '')));

const QUOTED_SPECIALS = ' \t\n;&|<>(){}`';
const MASK_BASE = 0xe000;
const mask = (char: string): string => {
  const at = QUOTED_SPECIALS.indexOf(char);
  return at < 0 ? char : String.fromCharCode(MASK_BASE + at);
};
const unmask = (word: string): string => word.replace(/[\uE000-\uE0FF]/g, (char) => QUOTED_SPECIALS[char.charCodeAt(0) - MASK_BASE] ?? char);

/** A here-document operator, `<<` or `<<-` but not `<<<`, with its delimiter word, any part of which may be quoted or escaped. */
const HEREDOC = /<<(-?)[ \t]*((?:'[^'\n]*'|"[^"\n]*"|\\.|[^\s;&|<>()'"`\\])+)/y;
const ANSI_C_ESCAPES: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
/** The text of `$'...'` quoting: \x, \u and \U take hex digits, a backslash and up to three octal digits a code, \cX a control character. */
const ansiC = (text: string): string =>
  text.replace(/\\(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3})|c(.)|(.))/g, (escape: string, hex?: string, short?: string, long?: string, octal?: string, control?: string, other = '') => {
    const code = parseInt(hex ?? short ?? long ?? '', 16);
    if (!Number.isNaN(code)) return code <= 0x10ffff ? String.fromCodePoint(code) : escape;
    if (octal !== undefined) return String.fromCharCode(parseInt(octal, 8) & 0xff);
    if (control !== undefined) return String.fromCharCode(control.toUpperCase().charCodeAt(0) & 0x1f);
    return ANSI_C_ESCAPES[other] ?? (`'"?\\`.includes(other) ? other : `\\${other}`);
  });
/**
 * The delimiter a here-document's body ends at: its word after quote removal, as in `'E'OF` or `$'EOF'`, which end at
 * `EOF`. In double quotes a backslash is removed only before $, `, " or \. An escape in `$'...'` that makes a newline
 * stays as written: no line ends such a body, so it would hide the rest of the command from the checks.
 */
const delimiterOf = (word: string): string =>
  word.replace(/\$'([^']*)'|'([^']*)'|\$?"([^"]*)"|\\(.)/g, (_: string, ansi?: string, single?: string, double?: string, escaped?: string) => {
    if (ansi === undefined) return single ?? double?.replace(/\\([$`"\\])/g, '$1') ?? escaped ?? '';
    const decoded = ansiC(ansi);
    return decoded.includes('\n') ? ansi : decoded;
  });
/** With a `quoted` delimiter the body is data; otherwise bash runs its command substitutions. */
type Heredoc = { delimiter: string; tabs: boolean; quoted: boolean };

/** Where the body of a here-document, which starts at `start`, ends: after the line of its delimiter. */
function heredocEnd(command: string, start: number, { delimiter, tabs }: Heredoc): number {
  let at = start;
  while (at < command.length) {
    const newline = command.indexOf('\n', at);
    const end = newline === -1 ? command.length : newline;
    const line = command.slice(at, end);
    at = end + 1;
    if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) break;
  }
  return at;
}

/** Where a command substitution stands in the words around it; what it runs is the next of its script's `substitutions`. */
const SUBSTITUTION = '\uE100';
const SUBSTITUTIONS = new RegExp(SUBSTITUTION, 'g');
/** A command as the detectors read it: its lines, and the scripts of its command substitutions in the order they start. */
type Script = { lines: string[]; substitutions: Script[] };
type Frame = { out: string; substitutions: Script[] };
const scriptOf = ({ out, substitutions }: Frame): Script => ({ lines: out.split('\n'), substitutions });
const allLines = ({ lines, substitutions }: Script): string[] => [...lines, ...substitutions.flatMap(allLines)];
const HEREDOC_BODY = '<<';
const ARITHMETIC = '((';
const CONDITIONAL = '[[';
/** ANSI-C quoting, in which a backslash escapes the next character, a ' too. */
const ANSI_C = "$'";
/** The shell's process ID: one token, so a ' right after it opens a plain quote, not ANSI-C quoting. */
const PID = '$$';
const COMMAND_POSITION = new RegExp(`${BEFORE_COMMAND}$`);

/** Where the `]]` of a `[[` whose body starts at `start` stands: the first that is a word of its own outside quotes. */
function conditionalEnd(command: string, start: number): number | undefined {
  let quote: string | undefined;
  for (let index = start; index < command.length; index++) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = undefined;
    } else if (char === '\\') {
      index++;
    } else if (quote !== undefined) {
      if (char === quote.at(-1)) quote = undefined;
    } else if (command.startsWith(PID, index)) {
      index++;
    } else if (command.startsWith(ANSI_C, index)) {
      quote = ANSI_C;
      index++;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char) && command.startsWith(']]', index + 1) && /^[\s;&|)]?$/.test(command[index + 3] ?? '')) {
      return index + 1;
    }
  }
  return undefined;
}

/**
 * Where the `))` of an arithmetic `((` whose first `(` is at `start` stands. Undefined when that `(` closes alone: then
 * `$((cd x) )` is a command substitution that runs a subshell.
 */
function arithmeticEnd(command: string, start: number): number | undefined {
  let depth = 0;
  for (let index = start + 2; index < command.length; index++) {
    if (command[index] === '(') depth++;
    else if (command[index] !== ')') continue;
    else if (depth > 0) depth--;
    else return command[index + 1] === ')' ? index : undefined;
  }
  return undefined;
}

/** The command substitutions bash runs in the bodies of `heredocs`, which start at `start`, and where the last body ends. */
function heredocBodies(command: string, start: number, heredocs: Heredoc[]): { end: number; substitutions: Script[] } {
  let end = start;
  const substitutions: Script[] = [];
  for (const heredoc of heredocs) {
    const bodyStart = end;
    end = heredocEnd(command, bodyStart, heredoc);
    if (!heredoc.quoted) substitutions.push(...parseScript(command.slice(bodyStart, end), true).substitutions);
  }
  return { end, substitutions };
}

/**
 * `command` as the detectors read it. Each blank and shell operator that is quoted or escaped is replaced by a
 * private-use character, so a quoted string is one word that starts, redirects and ends nothing; `unmask` undoes it. A
 * `$(...)` or backtick substitution, in double quotes too, is a script of its own, and one word in the command around
 * it. An arithmetic `$((...))` or `((...))`, and a conditional `[[ ... ]]`, is masked as quoted text is, so its `<<`
 * starts no here-document and its `>` redirects nothing, but its command substitutions still run, in a conditional only outside single quotes. A backslash-newline joins two lines. Comments and here-document bodies are dropped, but for the command
 * substitutions of a body whose delimiter is unquoted: they stand on a line of their own after the operator's line. A
 * `body` is read as bash reads one, as if in double quotes that no `"` closes.
 */
function parseScript(command: string, body = false): Script {
  const open: string[] = body ? [HEREDOC_BODY] : [];
  const heredocs: Heredoc[] = [];
  const outer: Frame[] = [];
  let frame: Frame = { out: '', substitutions: [] };
  const openSubstitution = (kind: string): void => {
    open.push(kind);
    outer.push(frame);
    frame = { out: '', substitutions: [] };
  };
  const closeSubstitution = (): void => {
    const around = outer.pop();
    if (around === undefined) return;
    open.pop();
    around.substitutions.push(scriptOf(frame));
    around.out += SUBSTITUTION;
    frame = around;
  };
  const expressionEnds: number[] = [];
  const commandPosition = (inner: string | undefined): boolean => ![HEREDOC_BODY, '"', ARITHMETIC, CONDITIONAL].includes(inner ?? '') && COMMAND_POSITION.test(frame.out);
  const arithmeticAt = (index: number, inner: string | undefined): number | undefined => {
    if (command.startsWith('$((', index)) return arithmeticEnd(command, index + 1);
    return command.startsWith('((', index) && commandPosition(inner) ? arithmeticEnd(command, index) : undefined;
  };
  const conditionalAt = (index: number, inner: string | undefined): number | undefined =>
    command.startsWith('[[', index) && /\s/.test(command[index + 2] ?? '') && commandPosition(inner) ? conditionalEnd(command, index + 2) : undefined;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const inner = open.at(-1);
    const literal = inner === "'" || inner === ANSI_C;
    const arithmetic = literal ? undefined : arithmeticAt(index, inner);
    const conditional = literal || arithmetic !== undefined ? undefined : conditionalAt(index, inner);
    const masked = inner === ARITHMETIC || inner === CONDITIONAL;
    if (inner === ANSI_C && char === '\\' && index + 1 < command.length) {
      frame.out += char + mask(command[++index]);
    } else if (literal) {
      if (char === "'") open.pop();
      frame.out += char === "'" ? char : mask(char);
    } else if (char === '\\' && command[index + 1] === '\n') {
      index++;
    } else if (char === '\\' && index + 1 < command.length) {
      frame.out += char + mask(command[++index]);
    } else if (masked && index === expressionEnds.at(-1)) {
      open.pop();
      expressionEnds.pop();
      frame.out += mask(char) + mask(command[++index]);
    } else if (arithmetic !== undefined) {
      open.push(ARITHMETIC);
      expressionEnds.push(arithmetic);
      frame.out += (char === '$' ? char : '') + mask('(').repeat(2);
      index += char === '$' ? 2 : 1;
    } else if (conditional !== undefined) {
      open.push(CONDITIONAL);
      expressionEnds.push(conditional);
      frame.out += CONDITIONAL;
      index++;
    } else if (command.startsWith(PID, index)) {
      frame.out += PID;
      index++;
    } else if (command.startsWith('$(', index)) {
      openSubstitution('$(');
      index++;
    } else if (command.startsWith(ANSI_C, index) && !['"', HEREDOC_BODY, ARITHMETIC].includes(inner ?? '')) {
      open.push(ANSI_C);
      frame.out += ANSI_C;
      index++;
    } else if (char === '`') {
      if (inner === '`') closeSubstitution();
      else openSubstitution(char);
    } else if (masked) {
      if (inner === CONDITIONAL && (char === "'" || char === '"')) open.push(char);
      frame.out += mask(char);
    } else if (inner === '"' || inner === HEREDOC_BODY) {
      if (char === '"' && inner === '"') open.pop();
      frame.out += char === '"' ? char : mask(char);
    } else if (char === '#' && /^[\s;&|()]?$/.test(frame.out.slice(-1))) {
      const newline = command.indexOf('\n', index);
      index = (newline === -1 ? command.length : newline) - 1;
    } else if (char === '\n' && heredocs.length > 0) {
      const { end, substitutions } = heredocBodies(command, index + 1, heredocs.splice(0));
      frame.out += char;
      if (substitutions.length > 0) {
        frame.substitutions.push(...substitutions);
        frame.out += `${SUBSTITUTION.repeat(substitutions.length)}\n`;
      }
      index = end - 1;
    } else if (char === ')' && inner === '$(') {
      closeSubstitution();
    } else {
      if (char === "'" || char === '"' || char === '(') open.push(char);
      else if (char === ')' && inner === '(') open.pop();
      else if (char === '<' && command[index - 1] !== '<') {
        HEREDOC.lastIndex = index;
        const found = HEREDOC.exec(command);
        if (found !== null) heredocs.push({ delimiter: delimiterOf(found[2]), tabs: found[1] === '-', quoted: /['"\\]/.test(found[2]) });
      }
      frame.out += char;
    }
  }
  while (outer.length > 0) closeSubstitution();
  return scriptOf(frame);
}

/** How many values each sqlite3 option that takes any is followed by. */
const SQLITE_OPTION_VALUES: Record<string, number> = { A: 1, alg: 1, cmd: 1, escape: 1, heap: 1, hexkey: 1, init: 1, key: 1, lookaside: 2, maxsize: 1, mmap: 1, newline: 1, nonce: 1, nullvalue: 1, pagecache: 2, screenwidth: 1, separator: 1, textkey: 1, vfs: 1 };

/** The database a sqlite3 command opens, its first operand, unless an option opens it read-only. */
function sqliteDatabase(part: string): string[] {
  const args = words(part.replace(ANY_REDIRECT, ''));
  const end = optionsEnd(args);
  let database: string | undefined;
  for (let index = 0; index < end; index++) {
    const option = /^--?(\w+)$/.exec(args[index]);
    if (option === null) database ??= args[index];
    else if (option[1] === 'readonly') return [];
    else index += SQLITE_OPTION_VALUES[option[1]] ?? 0;
  }
  database ??= args[end + 1];
  return database === undefined ? [] : [database];
}

const HELP = ['-h', '--help'];
const READ_ONLY_GIT = ['status', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'blame', 'rev-list', 'grep', 'show-ref', 'describe', 'ls-remote', 'merge-base', 'for-each-ref', 'check-ignore', 'check-ref-format', 'shortlog', 'count-objects', 'log', 'show', 'diff', 'diff-index', 'diff-tree', 'archive', 'clone', 'version', 'help'];
const BRANCH_LISTING = /^(?:-[arvil]+|--(?:show-current|all|remotes|verbose|list|ignore-case|omit-empty|no-color|color(?:=.*)?|no-column|column(?:=.*)?|no-abbrev|abbrev(?:=.*)?|format=.*|sort=.*))$/;
/** `--list`, or `-l` alone or in a bundle of listing flags such as `-vl`. */
const BRANCH_LIST_MODE = /^(?:--list|-[arvi]*l[arvil]*)$/;
/** Filters that put git branch in list mode, so the words after them are patterns. */
const LISTING_FILTERS = ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at'];
const BRANCH_FILTERS = [...LISTING_FILTERS, '--sort', '--format'];
const REFLOG_WRITES = ['expire', 'delete', 'drop', 'write'];
const FETCH_REWRITES = /^(?:--prune|--force|-[^-]*[fp])/;
const CONFIG_READS = ['--get', '--get-all', '--get-regexp', '--list', '-l'];
const CONFIG_SCOPES = ['--local', '--global', '--system', '--worktree'];
/** Scopes whose config file lies outside the repository git runs in. */
const CONFIG_OUTSIDE_SCOPES = ['--global', '--system'];
const TAG_LISTING = /^(?:-n\d*|-i|--ignore-case|--column(?:=.*)?|--(?:sort|format)=.*)$/;
/** -n makes git tag list, so every word that is no option is a pattern. */
const TAG_LINES = /^-n\d*$/;
/** A -n or --dry-run, also in a cluster of short options, but not after an -e there: the rest of that cluster is its value. */
const CLEAN_DRY_RUN = /^(?:--dry-run|-[^-e]*n.*)$/;
/** An --exclude or a cluster that ends in its -e: the next word is the pattern. */
const CLEAN_EXCLUDE = /^(?:--exclude|-[^-e]*e)$/;
/** No short option of git add takes a value, so an n anywhere in a cluster is its -n. */
const ADD_DRY_RUN = /^(?:--dry-run|-[^-]*n.*)$/;
const TAG_FILTERS = ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at'];
/** git apply only reports with one of these, whether or not --index or --cached names what it checks, unless --apply makes it apply as well. */
const APPLY_REPORTS = ['--check', '--stat', '--numstat', '--summary'];

/**
 * Whether git `subcommand` with `args` leaves the repository it runs in as it was: any subcommand with -h or --help alone;
 * log, show, diff, diff-index, diff-tree, archive and clone, whose files `gitWrites` judges; fetch as a dry run, or unless it prunes, forces or names a refspec that sets a ref; reflog unless it changes
 * entries; config when it reads, names one key alone after its scope, or writes a global or system file; clean and add
 * only as a dry run, named before any `--`; apply only when it reports; and branch, remote, stash, tag and worktree only
 * in their listing forms.
 */
function readsOnly(subcommand: string, args: string[]): boolean {
  if (args.length === 1 && HELP.includes(args[0])) return true;
  switch (subcommand) {
    case 'fetch': {
      if (args.slice(0, optionsEnd(args)).includes('--dry-run')) return true;
      const [, ...refspecs] = args.filter((arg) => !arg.startsWith('-'));
      return !args.some((arg) => FETCH_REWRITES.test(arg)) && !refspecs.some((refspec) => refspec.startsWith('+') || refspec.includes(':'));
    }
    case 'config': {
      if (args.some((arg) => CONFIG_OUTSIDE_SCOPES.includes(arg))) return true;
      const unscoped = args.filter((arg) => !CONFIG_SCOPES.includes(arg));
      return unscoped[0] === 'get' || unscoped[0] === 'list' || unscoped.some((arg) => CONFIG_READS.includes(arg)) || (unscoped.length === 1 && !unscoped[0].startsWith('-'));
    }
    case 'tag': {
      if (args.includes('-l') || args.includes('--list')) return true;
      const patterns = args.some((arg) => TAG_LINES.test(arg));
      for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (TAG_FILTERS.includes(arg)) index++;
        else if (!TAG_LISTING.test(arg) && !TAG_FILTERS.some((filter) => arg.startsWith(`${filter}=`)) && (arg.startsWith('-') || !patterns)) return false;
      }
      return true;
    }
    case 'clean':
      for (let index = 0; index < args.length && args[index] !== '--'; index++) {
        if (CLEAN_DRY_RUN.test(args[index])) return true;
        if (CLEAN_EXCLUDE.test(args[index])) index++;
      }
      return false;
    case 'apply': {
      const options = args.slice(0, optionsEnd(args));
      return options.some((arg) => APPLY_REPORTS.includes(arg)) && !options.includes('--apply');
    }
    case 'add':
      return args.slice(0, optionsEnd(args)).some((arg) => ADD_DRY_RUN.test(arg));
    case 'worktree':
      return args[0] === 'list';
    case 'reflog':
      return !REFLOG_WRITES.includes(args[0]);
    case 'branch': {
      const patterns = args.slice(0, optionsEnd(args)).some((arg) => BRANCH_LIST_MODE.test(arg) || LISTING_FILTERS.some((filter) => arg === filter || arg.startsWith(`${filter}=`)));
      for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--') return patterns || index === args.length - 1;
        if (BRANCH_FILTERS.includes(arg)) index++;
        else if (!BRANCH_LISTING.test(arg) && !BRANCH_FILTERS.some((filter) => arg.startsWith(`${filter}=`)) && (arg.startsWith('-') || !patterns)) return false;
      }
      return true;
    }
    case 'remote': {
      const [action] = args.filter((arg) => arg !== '-v');
      return action === undefined || action === 'show' || action === 'get-url';
    }
    case 'stash':
      return args[0] === 'list' || args[0] === 'show';
    case 'symbolic-ref':
      return !args.slice(0, optionsEnd(args)).some((arg) => arg === '--delete' || /^-[^-]*d/.test(arg)) && operandsOf(args, ['-m']).length <= 1;
    default:
      return READ_ONLY_GIT.includes(subcommand);
  }
}
const under = (folder: string, word: string): string => (unquote(word).startsWith('/') || HOME_PREFIX.test(word) ? word : `${folder}/${word}`);

/** A git command: the folder its -C options lead to, its --git-dir and --work-tree, and its subcommand with the words after it. */
type GitCommand = { folder: string; named: string[]; subcommand: string; args: string[] };

function gitCommand(part: string): GitCommand | undefined {
  const args = words(part.replace(ANY_REDIRECT, '')).map(unmask);
  const plain = args.map(unquote);
  let folder = '.';
  const named: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const location = /^--(?:git-dir|work-tree)(?:=(.*))?$/.exec(args[index]);
    if (plain[index] === '-C') folder = under(folder, args[++index] ?? '.');
    else if (location !== null) named.push(under(folder, location[1] ?? args[++index] ?? '.'));
    else if (plain[index] === '-c') index++;
    else if (!plain[index].startsWith('-')) return { folder, named, subcommand: plain[index], args: args.slice(index + 1) };
  }
  return undefined;
}

/** The folders a git command acts on, unless its subcommand only reads. */
function gitTargets(part: string): string[] {
  const git = gitCommand(part);
  return git === undefined || readsOnly(git.subcommand, git.args.map(unquote)) ? [] : [git.folder, ...git.named];
}

/** The git clone options whose value is the next word. */
const CLONE_VALUES = ['-b', '--branch', '-o', '--origin', '-c', '--config', '-u', '--upload-pack', '-j', '--jobs', '--depth', '--reference', '--reference-if-able', '--separate-git-dir', '--template', '--shallow-since', '--shallow-exclude', '--server-option', '--filter', '--bundle-uri'];

/** The files a git command writes outside the repository it acts on: the --output of log, show, diff, diff-index, diff-tree or archive, or archive's -o, named before any --, and the folder clone fills. */
function gitWrites(part: string): string[] {
  const git = gitCommand(part);
  if (git === undefined) return [];
  const { folder, subcommand, args } = git;
  if (subcommand === 'clone') {
    const [, destination] = operandsOf(args, CLONE_VALUES);
    return destination === undefined ? [] : [under(folder, destination)];
  }
  if (!['log', 'show', 'diff', 'diff-index', 'diff-tree', 'archive'].includes(subcommand)) return [];
  const outputs = subcommand === 'archive' ? ['-o', '--output'] : ['--output'];
  const options = args.slice(0, optionsEnd(args));
  return options
    .flatMap((arg, index) => (outputs.includes(arg) ? [options[index + 1] ?? '']: arg.startsWith('--output=') ? [arg.slice('--output='.length)] : []))
    .filter((file) => file !== '')
    .map((file) => under(folder, file));
}

/**
 * What cp, mv or ln writes: its last operand, or the name of each source in the folder it copies into; `lone` names what
 * a lone operand writes. A --help or --version after an operand is an operand, as BSD tools read it.
 */
function copiedFiles(part: string, isFolder: (word: string) => boolean, lone = (name: string): string => name): string[] {
  const args = words(part.replace(ANY_REDIRECT, ''));
  const end = optionsEnd(args);
  let folder: string | undefined;
  const names: string[] = [];
  for (let index = 0; index < end; index++) {
    const arg = args[index];
    if (arg === '-t' || arg === '--target-directory') folder = args[++index];
    else if (arg.startsWith('--target-directory=')) folder = arg.slice('--target-directory='.length);
    else if (!arg.startsWith('-') || (names.length > 0 && INFO_OPTIONS.includes(unquote(arg)))) names.push(arg);
  }
  names.push(...args.slice(end + 1));
  if (folder === undefined) {
    const last = names.pop();
    if (last === undefined) return [];
    if (names.length === 0) return [lone(last)];
    if (!(last.endsWith('/') || isFolder(last))) return [last];
    folder = last;
  }
  return names.map((name) => `${folder}/${path.basename(unquote(name))}`);
}

/** What mv removes: every operand when -t names the folder it moves into, else all operands but the last. */
function movedSources(part: string): string[] {
  const args = words(part.replace(ANY_REDIRECT, ''));
  const sources = operandsOf(args, COPY_VALUE_OPTIONS);
  const namesTarget = (arg: string): boolean =>
    arg === '-t' || arg === '--target-directory' || arg.startsWith('--target-directory=') || /^-[^-S]*t/.test(arg);
  const intoFolder = args.slice(0, optionsEnd(args)).some((arg, index) => !valueFollows(args[index - 1], COPY_VALUE_OPTIONS) && namesTarget(arg));
  return intoFolder ? sources : sources.slice(0, -1);
}

/** A reader of a command's operands, without the word after each of the `valueOptions`, which is that option's value. */
const operandsBut =
  (valueOptions: string[]) =>
  (part: string): string[] =>
    operandsOf(words(part.replace(ANY_REDIRECT, '')), valueOptions);
/** What touch writes: its operands, not the time of -d or -t nor the file of -r, whose times it reads. */
const touchedFiles = operandsBut(['-r', '--reference', '-d', '--date', '-t']);
/** What truncate writes: its operands, not the size of -s nor the file of -r, whose size it reads. */
const truncatedFiles = operandsBut(['-s', '--size', '-r', '--reference']);
/** What mkdir makes: its operands, not the mode of -m. */
const madeFolders = operandsBut(['-m', '--mode']);

/**
 * Whether the word after a bare -i is BSD sed's backup suffix: empty, or starting with a dot. One with a / is a file all
 * the same, as GNU sed reads it, so `sed -e s/a/b/ -i .claude/ledger.md` still counts.
 */
const isBackupSuffix = (word: string | undefined): boolean => word !== undefined && /^(?:\.[^/]*)?$/.test(unquote(word));

/**
 * What sed -i writes: its file operands, not the value of -e, -f or -l, the suffix after a bare -i before any script or an
 * empty one after it, as no file has an empty name, or the script operand.
 */
function sedFiles(part: string): string[] {
  const args = words(part.replace(ANY_REDIRECT, ''));
  const end = optionsEnd(args);
  const files: string[] = [];
  let scripted = false;
  for (let index = 0; index < end; index++) {
    const arg = args[index];
    const long = /^--(expression|file|line-length)(=)?/.exec(arg);
    const short = /^-[^-efil]*([efil])(.*)$/.exec(arg);
    if (long !== null) {
      if (long[2] === undefined) index++;
      scripted ||= long[1] !== 'line-length';
    } else if (short?.[1] === 'i') {
      const next = args[index + 1];
      if (short[2] === '' && next !== undefined && (unquote(next) === '' || (!scripted && files.length === 0 && isBackupSuffix(next)))) index++;
    } else if (short !== null) {
      if (short[2] === '') index++;
      scripted ||= short[1] !== 'l';
    } else if (!arg.startsWith('-')) files.push(arg);
  }
  files.push(...args.slice(end + 1));
  return scripted ? files : files.slice(1);
}

/** A file a command writes; one it removes takes everything inside it along; git names the folder it runs in. */
type Effect = 'writes' | 'removes' | 'git';
/**
 * A command pattern, how to read the words it writes from its first group, and what it does to what they name. A reader
 * asks `isFolder` whether a word names an existing folder.
 */
type Writer = [pattern: RegExp, read: (part: string, isFolder: (word: string) => boolean) => string[], effect?: Effect];
/**
 * `tailOnly` when the word starts with a command substitution, so only the end of the path is known; `literal` for a file
 * tool's path, in which a * or ? is part of a name; `foldersOnly` when the word ends in /, so its glob matches only folders.
 */
type Target = { file: string; effect: Effect; tailOnly?: boolean; literal?: boolean; foldersOnly?: boolean };

const INFO_OPTIONS = ['--help', '--version'];
/**
 * A reader that finds no file in a command with a --help or --version before its first operand or `--`, which then
 * prints or rejects it and writes nothing. A later one is a file name to the BSD tools of macOS, which stop reading
 * options at the first operand. The value after one of `valueOptions` is neither, as the --help in `cp -S --help a b`.
 */
const unlessInfo =
  (read: Writer[1], valueOptions: string[] = []): Writer[1] =>
  (part, isFolder) => {
    const args = words(part.replace(ANY_REDIRECT, '')).map(unquote);
    const firstNotOption = args.find((arg, index) => !valueFollows(args[index - 1], valueOptions) && (INFO_OPTIONS.includes(arg) || arg === '--' || !/^-./.test(arg)));
    return INFO_OPTIONS.includes(firstNotOption ?? '') ? [] : read(part, isFolder);
  };
const COPY_VALUE_OPTIONS = ['-t', '-S', '--suffix', '--target-directory'];

/**
 * What a command writes or removes: a redirect target, a tee or sed -i file, what cp or mv writes, what rm or rmdir
 * removes, the sources mv removes, what touch or truncate writes, and what ln links.
 */
const LEDGER_WRITERS: Writer[] = [
  [REDIRECT_TARGET, (target) => [target]],
  [TEE, unlessInfo(operands)],
  [SED_IN_PLACE, sedFiles],
  [COPY, unlessInfo(copiedFiles, COPY_VALUE_OPTIONS)],
  [REMOVE, unlessInfo(operands), 'removes'],
  [MOVE, unlessInfo(movedSources, COPY_VALUE_OPTIONS), 'removes'],
  [TOUCH, unlessInfo(touchedFiles, ['-d', '-r', '-t'])],
  [TRUNCATE, unlessInfo(truncatedFiles, ['-s', '-r'])],
  [LINK, unlessInfo((part, isFolder) => copiedFiles(part, isFolder, (name) => path.basename(unquote(name))), COPY_VALUE_OPTIONS)],
];

/** Also the folders mkdir makes, a database sqlite3 may write, the folders of a git command that may write, and the files git writes. */
const STORE_WRITERS: Writer[] = [
  ...LEDGER_WRITERS,
  [MKDIR, unlessInfo(madeFolders, ['-m'])],
  [SQLITE, sqliteDatabase],
  [GIT, gitTargets, 'git'],
  [GIT, gitWrites],
];

/** A `{a,b,...}` without braces inside it, and not the `${...}` of a parameter; a quoted brace is masked. */
const BRACES = /(?<!\$)\{([^{}]*,[^{}]*)\}/;

/** The words bash's brace expansion makes of `word`: a nested brace expands to a superset of what bash makes. */
function expandBraces(word: string): string[] {
  const found = BRACES.exec(word);
  if (found === null) return [word];
  const [before, after] = [word.slice(0, found.index), word.slice(found.index + found[0].length)];
  return found[1].split(',').flatMap((choice) => expandBraces(`${before}${choice}${after}`));
}

const braceExpanded = (part: string): string => words(part).flatMap(expandBraces).join(' ');

/** An `&` that ends a list and runs it in the background: no `&&`, `&>`, `>&`, `<&`, `|&` nor a case's `;&`. */
const isBackground = (line: string, index: number): boolean => line[index] === '&' && !'&|<>;'.includes(line[index - 1] ?? ' ') && !'&>'.includes(line[index + 1] ?? ' ');

type At = (line: string, index: number) => boolean;
/** Text before the ( or ) of a case pattern on the line of its case's `in` or of the ;;, ;& or ;;& before it; elsewhere the pattern's ) is taken for a subshell's. */
const CASE_CLAUSE = String.raw`(?:(?:^|[\s;&|(])case\s+[^\s;&|()]+\s+in\s|;;&?|;&)\s*`;
const CASE_PATTERN_OPEN = new RegExp(`${CASE_CLAUSE}$`);
const CASE_PATTERN_CLOSE = new RegExp(String.raw`${CASE_CLAUSE}\(?[^\s;&|()][^;&()]*$`);
const opensSubshell: At = (line, index) => line[index] === '(' && !CASE_PATTERN_OPEN.test(line.slice(0, index));
const closesSubshell: At = (line, index) => line[index] === ')' && !CASE_PATTERN_CLOSE.test(line.slice(0, index));
/**
 * A { of its own where a command starts or after a ), as in `f() {`: elsewhere, as in `echo {` or `echo <(true) {`, it is
 * an argument.
 */
const opensBraceGroup: At = (line, index) => {
  if (line[index] !== '{' || !/\s/.test(line[index + 1] ?? ' ')) return false;
  const before = line.slice(0, index).trimEnd();
  return COMMAND_POSITION.test(line.slice(0, index)) || (before.endsWith(')') && !closesProcessSubstitution(line, before.length - 1));
};
/** A } of its own where a command starts or after the end of a group, as in `{ (true) }`: elsewhere, as in `{ echo }`, it is an argument. */
const closesBraceGroup: At = (line, index) => line[index] === '}' && /[\s;&)]/.test(line[index - 1] ?? ' ') && /^[\s;&|)<>]?$/.test(line[index + 1] ?? '') && (COMMAND_POSITION.test(line.slice(0, index)) || followsGroup(line, index));
const followsGroup: At = (line, index) => {
  const before = line.slice(0, index).trimEnd();
  const end = /(?:[)}]|fi|done|esac)$/.exec(before);
  return end !== null && closesGroup(line, end.index) && !closesProcessSubstitution(line, end.index);
};
/** The ) of a `<(...)` or `>(...)`: it ends a word, not a command, so a } after it is an argument. */
const closesProcessSubstitution: At = (line, index) => {
  if (!closesSubshell(line, index)) return false;
  const opens: number[] = [];
  for (let at = 0; at < index; at++) {
    if (opensSubshell(line, at)) opens.push(at);
    else if (closesSubshell(line, at)) opens.pop();
  }
  const open = opens.at(-1);
  return open !== undefined && '<>'.includes(line[open - 1] ?? ' ');
};
/**
 * One of `keywords` where bash reads it as a keyword: a word of its own where a command starts, or after a case pattern's
 * ) or a subshell's. `wordEnd` matches the character after a keyword that ends its word.
 */
const keywordAt =
  (keywords: string[], wordEnd = /^[\s;&|()]?$/): At =>
  (line, index) =>
    keywords.some((keyword) => line.startsWith(keyword, index) && wordEnd.test(line[index + keyword.length] ?? '')) && (COMMAND_POSITION.test(line.slice(0, index)) || /\)\s*$/.test(line.slice(0, index)));
const opensKeywordGroup = keywordAt(['if', 'while', 'until', 'for', 'select', 'case']);
/** A closing keyword may carry a redirect, as in `fi>log`. */
const closesKeywordGroup = keywordAt(['fi', 'done', 'esac'], /^[\s;&|()<>]?$/);
/** A coproc runs the command after it in a subshell, as a pipe into it does. */
const startsCoprocess = keywordAt(['coproc']);
/** A shell group, which bash runs in the shell around it unless a pipe or an & runs it in a subshell: { ... }, if ... fi, a loop ... done or case ... esac. */
const opensShellGroup: At = (line, index) => opensBraceGroup(line, index) || opensKeywordGroup(line, index);
const closesShellGroup: At = (line, index) => closesBraceGroup(line, index) || closesKeywordGroup(line, index);
const opensGroup: At = (line, index) => opensSubshell(line, index) || opensShellGroup(line, index);
const closesGroup: At = (line, index) => closesSubshell(line, index) || closesShellGroup(line, index);
/** A `|` or `|&` that pipes one command into the next: no `||`, nor the `>|` of a redirect. */
const isPipe: At = (line, index) => line[index] === '|' && !'|>'.includes(line[index - 1] ?? ' ') && line[index + 1] !== '|';
const endsPipeline: At = (line, index) => line[index] === ';' || isBackground(line, index) || line.startsWith('&&', index) || line.startsWith('||', index);

/**
 * For the top of `line` and each group still open at `end`, innermost last, whether a pipe or a coproc leads into the
 * pipeline that reaches `end` there. A group that an earlier line opened is taken as not piped into.
 */
function pipedLevels(line: string, end: number): boolean[] {
  const levels = [false];
  for (let index = 0; index < end; index++) {
    if (opensGroup(line, index)) levels.push(false);
    else if (closesGroup(line, index)) {
      if (levels.length > 1) levels.pop();
      else levels[0] = false;
    } else if (isPipe(line, index) || startsCoprocess(line, index)) levels[levels.length - 1] = true;
    else if (endsPipeline(line, index)) levels[levels.length - 1] = false;
  }
  return levels;
}

/**
 * Where a cd at `at` in `line` stops counting: at once when a pipe leads into its pipeline; at the ) that closes its
 * ( ... ) group; or at a pipe or an & after it that runs its pipeline or and-or list, which a shell group around it
 * extends, in a subshell. A ;, && or || ends that pipeline and a ; that list, so a later pipe or & leaves the cd in the
 * foreground; one at the top of the line counts to its end.
 */
function cdEnd(line: string, at: number): number {
  const piped = pipedLevels(line, at);
  if (piped.at(-1)) return at;
  let depth = 0;
  let inList = true;
  let inPipeline = true;
  for (let index = at; index < line.length; index++) {
    if (opensGroup(line, index)) depth++;
    else if (closesGroup(line, index)) {
      if (depth > 0) depth--;
      else if (closesSubshell(line, index)) return index;
      else {
        piped.pop();
        if (piped.at(-1)) return index;
        inList = inPipeline = true;
      }
    } else if (depth > 0) continue;
    else if (inPipeline && isPipe(line, index)) return index;
    else if (line[index] === ';') inList = inPipeline = false;
    else if (inList && isBackground(line, index)) return index;
    else if (endsPipeline(line, index)) inPipeline = false;
  }
  return Infinity;
}

/** Where the and-or list that reaches `end` in `line` starts: after the last ; or & before it in its group, or where its group or the line starts. */
function listStart(line: string, end: number): number {
  const starts = [0];
  for (let index = 0; index < end; index++) {
    if (opensGroup(line, index)) starts.push(index + 1);
    else if (closesGroup(line, index)) {
      if (starts.length > 1) starts.pop();
    } else if (line[index] === ';' || isBackground(line, index)) starts[starts.length - 1] = index + 1;
  }
  return starts.at(-1) ?? 0;
}

/** A group that a line leaves open: the folder before it and before its and-or list, and whether it runs in a subshell, as a ( ... ) group or one a pipe leads into does. */
type OpenGroup = { folder: string; listFolder: string; subshell: boolean };
type Restore = { at: number; folder: string };

/**
 * Where a group that `line` closes at `at` leaves the shell, and the folder the shell has there: at that close, the
 * folder from before the group, when it runs in a subshell or a pipe after it runs it alone in one; and at an & after it,
 * the folder from before its and-or list, as the & runs that whole list in the background, commands before and after
 * the group too.
 */
function detachedAt(line: string, at: number, { folder, listFolder, subshell }: OpenGroup): Restore[] {
  const end = cdEnd(line, at + 1);
  const background = listEnd(line, at + 1);
  return [...(subshell || line[end] === '|' ? [{ at, folder }] : []), ...(isBackground(line, background) ? [{ at: background, folder: listFolder }] : [])];
}

/** Where the and-or list that reaches `from` in `line` ends: at a ; or & in its group, where its group closes, or where the line ends. */
function listEnd(line: string, from: number): number {
  let depth = 0;
  for (let index = from; index < line.length; index++) {
    if (opensGroup(line, index)) depth++;
    else if (closesGroup(line, index)) {
      if (depth === 0) return index;
      depth--;
    } else if (depth === 0 && (line[index] === ';' || isBackground(line, index))) return index;
  }
  return line.length;
}

/** Whether `text` leaves a `<(` or `>(` open: its lines are one word up to the ) that closes it. */
const leavesProcessSubstitutionOpen = (text: string): boolean => groupEdges(text, opensSubshell, closesSubshell).opens.some((open) => '<>'.includes(text[open - 1] ?? ' '));

/** Each line that ends in &&, || or a pipe joined with the next, as bash reads them: one list; and each line inside a process substitution joined with its next. */
function joinContinuations(lines: string[]): string[] {
  const joined: string[] = [];
  let pending = '';
  for (const line of lines) {
    pending += line;
    if (/(?:&&|\|[|&]?)\s*$/.test(pending)) pending += ' ';
    else if (leavesProcessSubstitutionOpen(pending)) pending += '\n';
    else {
      joined.push(pending);
      pending = '';
    }
  }
  return pending === '' ? joined : [...joined, pending];
}

/**
 * The start of each group of one kind that `line` opens and leaves open, the end of each it closes that an earlier line
 * opened, in order, and the start and end of each it both opens and closes.
 */
function groupEdges(line: string, opensAt: At, closesAt: At): { opens: number[]; closes: number[]; within: { open: number; close: number }[] } {
  const opens: number[] = [];
  const closes: number[] = [];
  const within: { open: number; close: number }[] = [];
  for (let index = 0; index < line.length; index++) {
    if (opensAt(line, index)) opens.push(index);
    else if (closesAt(line, index)) {
      const open = opens.pop();
      if (open === undefined) closes.push(index);
      else within.push({ open, close: index });
    }
  }
  return { opens, closes, within };
}

/** Where the command ends whose group closes at `at`: the redirects in between, a `>(...)` among them, belong to that group. */
function commandEnd(line: string, at: number): number {
  let depth = 0;
  for (let index = at + 1; index < line.length; index++) {
    if (opensSubshell(line, index)) depth++;
    else if (depth > 0) {
      if (closesSubshell(line, index)) depth--;
    } else if (isPipe(line, index) || endsPipeline(line, index) || closesGroup(line, index)) return index;
  }
  return line.length;
}

/**
 * Where a cd to `word` from `folder` leads. One to a path that is no folder fails and stays in `folder`. One to a missing
 * path, which the command may make before it, leads there on its own line only: for a `laterLine` the hook cannot tell.
 */
function cdInto(word: string, folder: string, home: string, laterLine: boolean): string {
  const target = pathOf(word, folder, home);
  const stats = statOf(target);
  return (stats === undefined ? laterLine : !stats.isDirectory()) ? folder : target;
}

/**
 * A heuristic, line by line, a line that ends in &&, || or | read with the next: what `writers` read, each resolved
 * against the folder the cds before it lead to. A cd counts up to the end of its ( ... ) group, on a later line too, of
 * its command substitution, of a pipeline it is in, a shell group spanning lines that a pipe leads into too, or of a
 * list that & sends to the background, also one that groups spanning lines extend; one at the top of a line
 * carries over to later lines. A redirect on the close of a shell group, with the command substitutions in its word, is
 * made where the group started, as bash makes it before the group runs. Braces in a word are expanded before a writer
 * reads it.
 */
function bashWriteTargets({ lines, substitutions }: Script, cwd: string, home: string, writers: Writer[]): Target[] {
  let folder = cwd;
  const openSubshells: OpenGroup[] = [];
  const openShellGroups: OpenGroup[] = [];
  let next = 0;
  const reopened = <Open>(closes: number[], opened: Open[]): { at: number; open: Open }[] =>
    closes.flatMap((at) => {
      const open = opened.pop();
      return open === undefined ? [] : [{ at, open }];
    });
  return joinContinuations(lines).flatMap((line) => {
    const subshells = groupEdges(line, opensSubshell, closesSubshell);
    const shellGroups = groupEdges(line, opensShellGroup, closesShellGroup);
    const shellGroupsClosed = reopened(shellGroups.closes, openShellGroups);
    const groupsClosed = [...reopened(subshells.closes, openSubshells), ...shellGroupsClosed].sort((a, b) => a.at - b.at);
    const closed = groupsClosed.flatMap(({ at, open }) => detachedAt(line, at, open)).sort((a, b) => a.at - b.at);
    const start = folder;
    const cds = [...line.matchAll(CD)].flatMap(({ 0: match, 1: word = '~', index }) => {
      const at = index + match.length;
      return word === '-' ? [] : [{ word: unmask(word), at, end: cdEnd(line, at) }];
    });
    // At, not only before: a command's match starts at the & before it, where a group sent to the background leaves the shell.
    const folderAt = (at: number, laterLine = false): string =>
      cds.filter((cd) => cd.at <= at && at < cd.end).reduce((into, cd) => cdInto(cd.word, into, home, laterLine), closed.filter((group) => group.at <= at).at(-1)?.folder ?? start);
    folder = folderAt(line.length, true);
    // A list that an earlier line's group spans goes on after that group closes here, so it started where that group's list did.
    const listFolderAt = (open: number): string => {
      const start = listStart(line, open);
      return groupsClosed.filter(({ at }) => start <= at && at < open).at(-1)?.open.listFolder ?? folderAt(start);
    };
    openSubshells.push(...subshells.opens.map((open) => ({ folder: folderAt(open), listFolder: listFolderAt(open), subshell: true })));
    openShellGroups.push(...shellGroups.opens.map((open) => ({ folder: folderAt(open), listFolder: listFolderAt(open), subshell: pipedLevels(line, open).at(-1) === true })));
    const groupRedirects = [...shellGroupsClosed.map(({ at, open }) => ({ at, folder: open.folder })), ...shellGroups.within.map(({ open, close }) => ({ at: close, folder: folderAt(open) }))].map((group) => ({ ...group, end: commandEnd(line, group.at) }));
    const targetFolderAt = (at: number): string => groupRedirects.find((group) => group.at < at && at < group.end)?.folder ?? folderAt(at);
    const written = writers.flatMap(([pattern, read, effect = 'writes']) =>
      [...line.matchAll(pattern)].flatMap(({ 1: part = '', index }) => {
        const resolve = (word: string): string => pathOf(unmask(word), targetFolderAt(index), home);
        return read(braceExpanded(part), (word) => statOf(resolve(word))?.isDirectory() ?? false)
          .filter((word) => word !== '')
          .map((word) => ({ file: resolve(word), effect, tailOnly: unquote(word).startsWith(SUBSTITUTION), foldersOnly: unquote(word).endsWith('/') }));
      }),
    );
    const substituted = [...line.matchAll(SUBSTITUTIONS)].flatMap(({ index }) => {
      const script = substitutions[next++];
      return script === undefined ? [] : bashWriteTargets(script, targetFolderAt(index), home, writers);
    });
    return [...written, ...substituted];
  });
}

/** The files a file tool or a Bash command writes, as `writers` find them in a command. */
function writtenFiles(input: HookInput, context: HookContext, writers: Writer[]): Target[] {
  const { toolName, toolInput } = input;
  if (toolName === 'Bash') return bashWriteTargets(parseScript(text(toolInput.command)), folderOf(input, context), context.paths.home, writers);
  return FILE_TOOLS.includes(toolName) ? [{ file: toolFile(input, context), effect: 'writes', literal: true }] : [];
}

const toolFile = (input: HookInput, context: HookContext): string =>
  path.resolve(folderOf(input, context), text(input.toolInput.file_path).replace(/^~(?=\/|$)/, () => context.paths.home));

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
 * The .claude/ledger.md files a write to `target` lands on: its own path, named anywhere, or one that exists that a glob
 * in it matches or, for a removal, that lies in the folder it names. A deeper ledger, such as one in a worktree inside
 * that folder, is not looked for.
 */
function legacyLedgers(target: Target): string[] {
  if (LEGACY_LEDGER_FILE.test(target.file)) return [target.file];
  if (target.literal || target.tailOnly) return [];
  const parts = segments(target.file);
  const firstGlob = parts.findIndex((part) => GLOB.test(part));
  const folder = `/${parts.slice(0, firstGlob === -1 ? parts.length : firstGlob).join('/')}`;
  const nearest = [path.join(folder, '.claude/ledger.md'), ...(path.basename(folder) === '.claude' ? [path.join(folder, 'ledger.md')] : [])];
  const matchedAsFolder = (file: string): boolean => parts.length > segments(file).length || (target.foldersOnly === true && parts.length === segments(file).length);
  return nearest.filter((file) => statOf(file) !== undefined && !matchedAsFolder(file) && reaches(target, file));
}

/**
 * Denies a write to or removal of a .claude/ledger.md anywhere, as an active task's ledger lives in the store, and new
 * backlog ledger text that cites a file in a Claude Code session folder, which macOS deletes.
 */
function ledgerWriteReason(input: HookInput, context: HookContext): string | undefined {
  const targets = writtenFiles(input, context, LEDGER_WRITERS);
  const legacy = targets.flatMap((target) => pathsOf(target.file).flatMap((file) => legacyLedgers({ ...target, file })));
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
  const cites = targets.some(({ file, effect }) => effect === 'writes' && BACKLOG_LEDGER.test(file)) && SESSION_CITATION.test(newText(input.toolInput));
  return cites ? `${CITATION_ADVICE} ${ledgerCommands(context.ledgerBin)}` : undefined;
}

/** Each file and folder of the ledger store, under each storage, with the files beside git storage's clone. */
function storePaths(paths: LedgerPaths): string[] {
  const { backlog, active, archive, registry, aliases } = fileStoreRoots(paths);
  const database = sqliteFile(paths.home);
  return [backlog, active, archive, registry, aliases, ...Object.values(clonePaths(paths)), ...['', '-wal', '-shm', '-journal'].map((suffix) => `${database}${suffix}`)];
}

/** As bash matches a path segment: a glob by its pattern, with a leading dot matched only by a leading dot. */
const segmentMatches = (segment: string, name: string): boolean =>
  GLOB.test(segment) ? (!name.startsWith('.') || segment.startsWith('.')) && (segmentPattern(segment)?.test(name) ?? false) : segment === name;
const segments = (file: string): string[] => file.split('/').filter((part) => part !== '');

/** Whether a write to `file`, which may hold globs unless it is literal, could land in `root`; a removal also reaches it from a folder above. */
function reaches({ file, effect, literal }: Target, root: string): boolean {
  const fileParts = segments(file);
  const rootParts = segments(root);
  if (fileParts.length < rootParts.length && effect !== 'removes') return false;
  const matches = literal ? (segment: string, name: string): boolean => segment === name : segmentMatches;
  return rootParts.slice(0, fileParts.length).every((name, index) => matches(fileParts[index], name));
}

/**
 * Denies a write to the ledger store by a file tool or a Bash command: only the ledger tool keeps it consistent. A git
 * command in the clone is most likely an agent resolving a sync conflict, which is the operator's to do.
 */
function storeWriteReason(input: HookInput, context: HookContext): string | undefined {
  const targets = writtenFiles(input, context, STORE_WRITERS)
    .filter(({ tailOnly }) => !tailOnly)
    .flatMap(({ file, effect, literal }) => pathsOf(file).map((variant) => ({ file: variant, effect, literal })));
  if (targets.length === 0) return undefined;
  const roots = storePaths(context.paths)
    .flatMap(pathsOf)
    .flatMap((root) => [root, lockFile(root), reclaimGuard(lockFile(root))]);
  const reached = targets.filter((target) => roots.some((root) => reaches(target, root)));
  if (reached.length === 0) return undefined;
  const bin = context.ledgerBin;
  return [
    `The ledger store is changed only by the ledger tool, not by hand. ${ledgerCommands(bin)} To move or sync the store, see \`${bin} store --help\`.`,
    ...(reached.some(({ effect }) => effect === 'git') ? ['A sync conflict in the clone is resolved by the operator in a terminal, not by an agent: ask the operator.'] : []),
  ].join('\n');
}

/** A run of `ledger` by any path to it, such as ~/.claude/bin/ledger, with its arguments as the first group. */
const LEDGER = invocation(String.raw`["']?(?:[^\s;&|()<>]*\/)?ledger["']?`);
/** A run of node, tsx, npx and the like, with its options, the script it runs and that script's arguments as the first group. */
const SCRIPT_RUNNER = invocation('node|tsx|npx|bun|bunx|deno');
/** The ledger tool as a script: its bin, or the entry point under tools/ledger. */
const LEDGER_SCRIPT = /(?:^|\/)(?:ledger|cli\.[cm]?[jt]s)$/;
const SHELL_NAMES = '(?:ba|z|da|k)?sh';
const INTERPRETER_NAMES = 'python[\\d.]*|node|perl|ruby';
const SHELL = invocation(SHELL_NAMES);
const EVAL = invocation('eval');
const INTERPRETER = invocation(INTERPRETER_NAMES);
const INLINE_CODE = /^(?:-[A-Za-z]*[ceE]|-p|--eval|--print)$/;
const READS_STDIN = invocation(`${INTERPRETER_NAMES}|${SHELL_NAMES}`);
const PIPED_INTO = new RegExp(String.raw`\|&?\s*(?:\S*\/)?(?:${INTERPRETER_NAMES}|${SHELL_NAMES})${WORD_END}`);
const NAMES_ROOT_ON = /\bledger\b[\s\S]*\broot\b[\s\S]*\bon\b/;
const INSTALL = invocation('install');
const RSYNC = invocation('rsync');
const DD = invocation('dd');
/** Also what install and rsync copy, and the file of dd's of=. */
const ROOT_WRITERS: Writer[] = [
  ...LEDGER_WRITERS,
  [INSTALL, unlessInfo(copiedFiles)],
  [RSYNC, unlessInfo(copiedFiles)],
  [DD, (part) => words(part).flatMap((word) => (word.startsWith('of=') ? [word.slice('of='.length)] : []))],
];
const MAX_NESTING = 10;

const ROOT_SWITCH_REASON = 'Only the operator can switch the ledger root override on, by typing /ledger:root. Ask the operator to type it.';
const ROOT_LOG_REASON = 'The ledger root log and its report offset are written only by the ledger hooks, so that the operator sees every call root let through. Leave them as they are.';
const ROOT_NESTING_REASON = 'This command nests shells or eval too deeply for the ledger root check to read, so it is denied. Run the inner command directly.';

/** The files the root check guards; an agent may remove the marker, which switches root off, but not the log. */
const rootFiles = (home: string): { file: string; reason: string; removable: boolean }[] => [
  { file: rootMarker(home), reason: ROOT_SWITCH_REASON, removable: true },
  ...rootLogFiles(home).map((file) => ({ file, reason: ROOT_LOG_REASON, removable: false })),
];

const switchesRootOn = (args: string): boolean => {
  const [group, command] = operandsOf(words(args.replace(ANY_REDIRECT, '')).map((word) => unquote(unmask(word))), ['--minutes']);
  return group === 'root' && command === 'on';
};

function runsRootOn(line: string): boolean {
  const byScript = ({ 1: args = '' }: RegExpMatchArray): boolean => {
    const runnerWords = words(args);
    const script = runnerWords.findIndex((word) => LEDGER_SCRIPT.test(unquote(unmask(word))));
    return script !== -1 && switchesRootOn(runnerWords.slice(script + 1).join(' '));
  };
  return [...line.matchAll(LEDGER)].some(({ 1: args = '' }) => switchesRootOn(args)) || [...line.matchAll(SCRIPT_RUNNER)].some(byScript);
}

/** A word as the shell passes it on: its quotes removed, and the escapes in and outside double quotes undone. */
const shellText = (word: string): string =>
  unmask(word).replace(/'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/gs, (_: string, single?: string, double?: string, escaped?: string) => single ?? double?.replace(/\\([\\"$`])/g, '$1') ?? escaped ?? '');

/** The scripts a line hands on as text: the operand after a shell's -c, and the words of eval. */
function handedScripts(line: string): string[] {
  const shellScripts = [...line.matchAll(SHELL)].flatMap(({ 1: args = '' }) => {
    const shellWords = words(args.replace(ANY_REDIRECT, ''));
    let runsOperand = false;
    for (let index = 0; index < shellWords.length; index++) {
      const word = shellWords[index];
      if (word === '-o' || word === '+o') index++;
      else if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word)) runsOperand = true;
      else if (word !== '--' && !/^[-+]/.test(word)) return runsOperand ? [shellText(word)] : [];
    }
    return [];
  });
  const evalScripts = [...line.matchAll(EVAL)].map(({ 1: args = '' }) => words(args.replace(ANY_REDIRECT, '')).map(shellText).join(' '));
  return [...shellScripts, ...evalScripts];
}

/** Whether a line runs a program the hook cannot read as shell: inline interpreter code, or one on standard input. */
function runsUnreadProgram(line: string): boolean {
  const inlineCode = [...line.matchAll(INTERPRETER)].some(({ 1: args = '' }) => words(args).some((word) => INLINE_CODE.test(word)));
  const hereDocument = [...line.matchAll(READS_STDIN)].some(({ 1: args = '' }) => args.includes('<<'));
  return inlineCode || hereDocument || PIPED_INTO.test(line);
}

/**
 * Which root file `targets` write, or remove where that is not allowed. A `handed` script is matched by file name too: the
 * folder it runs in, after a cd before the shell or eval, is not followed.
 */
function rootFileReason(targets: Target[], home: string, handed: boolean): string | undefined {
  const variants = targets.filter(({ tailOnly }) => !tailOnly).flatMap((target) => pathsOf(target.file).map((file) => ({ ...target, file })));
  const named = ({ file, literal }: Target, name: string): boolean => (literal ? path.basename(file) === name : segmentMatches(path.basename(file), name));
  return rootFiles(home).find(({ file, removable }) =>
    variants.some((target) => (target.effect === 'writes' || !removable) && (pathsOf(file).some((variant) => reaches(target, variant)) || (handed && named(target, path.basename(file))))),
  )?.reason;
}

/**
 * The root check of a Bash command, and of each script it hands to a shell or eval, read the same way. A program it
 * cannot read is denied when the command names a root file or `ledger root on` anywhere: a conservative deny.
 */
function scriptRootReason(command: string, cwd: string, home: string, depth: number): string | undefined {
  const script = parseScript(command);
  const lines = allLines(script);
  if (lines.some(runsRootOn)) return ROOT_SWITCH_REASON;
  const written = rootFileReason(bashWriteTargets(script, cwd, home, ROOT_WRITERS), home, depth > 0);
  if (written !== undefined) return written;
  if (lines.some(runsUnreadProgram)) {
    const named = rootFiles(home).find(({ file }) => command.includes(path.basename(file)))?.reason ?? (NAMES_ROOT_ON.test(command) ? ROOT_SWITCH_REASON : undefined);
    if (named !== undefined) return named;
  }
  for (const handed of lines.flatMap(handedScripts)) {
    const reason = depth === MAX_NESTING ? ROOT_NESTING_REASON : scriptRootReason(handed, cwd, home, depth + 1);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/**
 * Denies an agent's `ledger root on`, any write of the root marker, and any write or removal of the root log or its report
 * offset, whether root is on or not: otherwise an agent could lift the other gates itself, or hide what root let through.
 * Switching it off, asking its status and removing the marker stay allowed.
 */
function rootSwitchReason(input: HookInput, context: HookContext): string | undefined {
  const { home } = context.paths;
  if (input.toolName === 'Bash') return scriptRootReason(text(input.toolInput.command), folderOf(input, context), home, 0);
  return rootFileReason(writtenFiles(input, context, ROOT_WRITERS), home, false);
}
