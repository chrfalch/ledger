import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { finalizeAdvice, statusLineText, sessionReport, taskTitle } from '../tools/ledger/awareness.js';
import { fileStore } from '../tools/ledger/file-store.js';
import type { GateQuestion } from '../tools/ledger/gates.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { activeTasks, findTasks } from '../tools/ledger/tasks.js';
import { commandEnv, fakeClock, git, home, LEDGER_BIN, putActive, runInProcessWith, storeFolder, worktreeOf } from './ledger-core-fixtures.js';
import { backgroundPids, ledgerOk, machine, machineEnv, remote, setUp, type Machine } from './ledger-git-fixtures.js';

// @ref LLP 0001#9-awareness — D26 the report in a task folder, D27 the open trees outside one, D28 the store-only status line.

const NOW = '2026-11-24T10:05:00Z';
const CLAIMED = 'session other-session since 2026-11-24T10:00:00Z, active 2026-11-24T10:00:00Z';
const ASK_TREES = 'Ask the operator in one question widget: continue one of these trees (name it), make a new task, or quick work (a small change with no task).';
const ASK_NEW = 'Ask the operator in one question widget: make a new task, or quick work (a small change with no task).';
const tail = (task: string, worktree: string, state: string): string =>
  `Task ${task} in ${worktree} — ${state}. Details: \`ledger show\`. Write with \`ledger notes\`, never by editing a file.`;

type Spec = { location?: string[]; children?: string[]; questions?: string[]; next?: string };

function ledgerMd(slug: string, { location = [], children, questions, next = `Next step of ${slug}.` }: Spec = {}): string {
  return [
    `# Task ledger — ${slug}`,
    '',
    '## Goal',
    `Goal of ${slug}.`,
    '',
    '## Location',
    ...location,
    '',
    ...(questions === undefined ? [] : ['## Open questions', ...questions, '']),
    ...(children === undefined ? [] : ['## Children', ...children, '']),
    '## Next step',
    next,
    '',
  ].join('\n');
}

function checkout(h: string, name: string): string {
  const main = path.join(h, name);
  mkdirSync(main, { recursive: true });
  git(h, main, 'init', '--quiet', '-b', 'main');
  git(h, main, 'commit', '--quiet', '--allow-empty', '-m', 'initial');
  return main;
}

/**
 * A linked worktree of `main`. One git call in it first: on some machines the first git call in a new folder stalls
 * for seconds, which would use up the session start's 5 s.
 */
function linked(h: string, main: string, slug: string): string {
  const folder = worktreeOf(main, slug);
  git(h, main, 'worktree', 'add', '--quiet', '-b', slug, folder);
  git(h, folder, 'rev-parse', '--show-toplevel');
  return folder;
}

/** An active task with a real linked worktree; gives the worktree. */
function started(h: string, main: string, slug: string, spec: Spec = {}): string {
  const folder = linked(h, main, slug);
  putActive(h, main, slug, ledgerMd(slug, { ...spec, location: [`- main: ${main}`, `- worktree: ${folder}`, ...(spec.location ?? [])] }));
  return folder;
}

/** An active record whose worktree folder is not there: cheap, and its state still counts. */
function recorded(h: string, main: string, slug: string, spec: Spec = {}): void {
  putActive(h, main, slug, ledgerMd(slug, { ...spec, location: [`- main: ${main}`, `- worktree: ${worktreeOf(main, slug)}`, ...(spec.location ?? [])] }));
}

function backlog(h: string, main: string, slug: string, spec: Spec = {}): void {
  const file = path.join(storeFolder(h, 'ledger-backlog', main), `${slug}.md`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, ledgerMd(slug, { ...spec, location: [`- main: ${main}`, ...(spec.location ?? [])] }));
}

function retired(h: string, main: string, slug: string, spec: Spec = {}): void {
  const file = path.join(storeFolder(h, 'ledger-archive', main), `2026-11-01-${slug}.md`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, ledgerMd(slug, { ...spec, location: [`- main: ${main}`, `- worktree: ${worktreeOf(main, slug)}`, ...(spec.location ?? [])] }));
}

type Hooked = { context: string; title?: string };

// As in ledger-core-hooks.test.ts: without these, git reads the system config and walks above HOME, which can use up
// the hook's 5 s budget on a loaded machine.
const hookEnv = (h: string): NodeJS.ProcessEnv => ({ ...commandEnv(h), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: path.dirname(h) });

async function sessionStart(h: string, cwd: string, source = 'startup'): Promise<Hooked> {
  const input = JSON.stringify({ hook_event_name: 'SessionStart', source, cwd, session_id: 'this-session' });
  const ran = await runInProcessWith(h, h, { clock: fakeClock(NOW), env: hookEnv(h), input }, 'hook', 'session-start');
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stderr, '');
  if (ran.stdout === '') return { context: '' };
  const { additionalContext, sessionTitle } = (JSON.parse(ran.stdout) as { hookSpecificOutput: { additionalContext: string; sessionTitle?: string } }).hookSpecificOutput;
  return { context: additionalContext, ...(sessionTitle === undefined ? {} : { title: sessionTitle }) };
}

/** What `ledger task gate finalize [<slug>]` offers in `folder`, by label; the report's Then line must agree with it. */
async function finalizeLabels(h: string, folder: string, slug?: string): Promise<string[]> {
  const ran = await runInProcessWith(h, folder, { env: hookEnv(h) }, 'task', 'gate', 'finalize', ...(slug === undefined ? [] : [slug]));
  assert.equal(ran.status, 0, ran.stderr);
  return (JSON.parse(ran.stdout) as GateQuestion).options.map(({ label }) => label);
}

function statusline(h: string, folder: string, env: NodeJS.ProcessEnv = hookEnv(h)): string {
  const ran = spawnSync(LEDGER_BIN, ['statusline', folder], { cwd: h, env, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stderr, '');
  return ran.stdout;
}

/** epic (backlog) › feature (active) › part-a … part-e, with part-b the session's task. */
function family(h: string): { main: string; folder: string } {
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- feature'] });
  started(h, main, 'feature', { location: ['- parent: epic'], children: ['- part-a', '- part-b', '- part-c', '- part-d', '- part-e (retired 2026-11-01)'] });
  recorded(h, main, 'part-a', { location: ['- parent: feature', '- status: done 2026-11-20', '- pr: https://github.com/acme/app/pull/4'] });
  const folder = started(h, main, 'part-b', {
    location: ['- kind: docs', '- stage: build', '- parent: feature'],
    questions: ['- Which API version? — blocks step 2', '- (resolved) Old one?', '- Who reviews?'],
    next: 'Write the docs page.\nThen the second line.',
  });
  recorded(h, main, 'part-c', { location: ['- parent: feature', `- claim: ${CLAIMED}`] });
  recorded(h, main, 'part-d', { location: ['- parent: feature', '- status: blocked 2026-11-20 — waiting on keys'] });
  retired(h, main, 'part-e', { location: ['- parent: feature'] });
  return { main, folder };
}

// A. The report in a task folder (D26)

test('D26: the session start in a task folder gives the report in its fixed order, not the whole ledger', async (t) => {
  const h = home(t);
  const { folder } = family(h);

  const { context, title } = await sessionStart(h, folder);

  assert.equal(title, '🟡 part-b');
  assert.equal(
    context,
    [
      tail('part-b', folder, 'active, stage build (docs)'),
      'Needs you:',
      '- PR merged: part-a — finalize with the question from `ledger task gate finalize part-a`',
      '- Question 1: Which API version? (blocks step 2)',
      '- Question 3: Who reviews?',
      '- Blocked: part-d — waiting on keys',
      '- Held by another session: part-c (other-session since 2026-11-24T10:00:00Z)',
      'Where: epic › feature › **part-b**',
      'Siblings: part-a done, part-c active, part-d blocked',
      'Next: Write the docs page.',
      'Then: part-a (done), part-c (active) and part-d (blocked) must be retired, then the parent finalizes next',
    ].join('\n'),
  );
});

test('D26: the report is the same after a startup, a resume, a clear and a compaction', async (t) => {
  const h = home(t);
  const { folder } = family(h);

  const contexts: string[] = [];
  for (const source of ['startup', 'resume', 'clear', 'compact']) contexts.push((await sessionStart(h, folder, source)).context);
  const [startup, ...others] = contexts;

  assert.match(startup, /^Task part-b /);
  for (const context of others) assert.equal(context, startup);
});

test('D26: a task with no parent and nothing for the operator says so, with no Siblings or Then line', async (t) => {
  const h = home(t);
  const folder = started(h, checkout(h, 'app'), 'solo');

  assert.equal((await sessionStart(h, folder)).context, [tail('solo', folder, 'active, stage plan (code)'), 'Needs you: nothing.', 'Where: **solo** (no parent)', 'Next: Next step of solo.'].join('\n'));
});

test('D26: a blocked current task and a blocked ancestor are named, and a task held by another session too', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  recorded(h, main, 'epic', { children: ['- part'], location: ['- status: blocked 2026-11-20 — waiting on legal'] });
  const folder = started(h, main, 'part', { location: ['- parent: epic', '- status: blocked 2026-11-21', `- claim: ${CLAIMED}`] });

  assert.equal(
    (await sessionStart(h, folder)).context,
    [
      tail('part', folder, 'blocked, stage plan (code)'),
      'Needs you:',
      '- Blocked: part',
      '- Blocked: epic — waiting on legal',
      '- Held by another session: part (other-session since 2026-11-24T10:00:00Z)',
      'Where: epic › **part**',
      'Next: Next step of part.',
      'Then: last child: the parent finalizes next',
    ].join('\n'),
  );
});

test('D26: a task done without a PR is named as done, not as a merged PR', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- part', '- shipped', '- finished'] });
  const folder = started(h, main, 'part', { location: ['- parent: epic'] });
  recorded(h, main, 'shipped', { location: ['- parent: epic', '- status: done 2026-11-20', '- pr: https://github.com/acme/app/pull/4'] });
  recorded(h, main, 'finished', { location: ['- parent: epic', '- status: done 2026-11-21'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.deepEqual(lines.slice(1, 4), ['Needs you:', '- PR merged: shipped — finalize with the question from `ledger task gate finalize shipped`', '- Done: finished — finalize with the question from `ledger task gate finalize finished`']);
});

test('D26: a parent held by another session is named too', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  recorded(h, main, 'epic', { children: ['- part'], location: [`- claim: ${CLAIMED}`] });
  const folder = started(h, main, 'part', { location: ['- parent: epic'] });

  assert.match((await sessionStart(h, folder)).context, /^- Held by another session: epic \(other-session since 2026-11-24T10:00:00Z\)$/m);
});

test('D26: the last open child names a sibling not yet retired as to retire before the parent finalizes; a retired child after it does not count', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- first', '- last', '- gone'] });
  recorded(h, main, 'first', { location: ['- parent: epic', '- status: waiting 2026-11-20 — PR #4'] });
  const folder = started(h, main, 'last', { location: ['- parent: epic'] });
  retired(h, main, 'gone', { location: ['- parent: epic'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.deepEqual(lines.slice(-4), ['Where: epic › **last**', 'Siblings: first waiting', 'Next: Next step of last.', 'Then: last open child: first (waiting) must be retired, then the parent finalizes next']);
});

test('D26: Then names the next open child by order, not by the line order under Children', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- later', '- now', '- soon'] });
  backlog(h, main, 'later', { location: ['- parent: epic', '- order: 3'] });
  const folder = started(h, main, 'now', { location: ['- parent: epic', '- order: 1'] });
  backlog(h, main, 'soon', { location: ['- parent: epic', '- order: 2'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.deepEqual(lines.slice(-2), ['Next: Next step of now.', 'Then: soon (backlog)']);
  assert.ok(lines.includes('Siblings: soon backlog, later backlog'), lines.join('\n'));
});

test('D26: Siblings shows at most 8, then how many more', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const names = Array.from({ length: 12 }, (_, index) => `kid-${String(index).padStart(2, '0')}`);
  backlog(h, main, 'epic', { children: names.map((name) => `- ${name}`) });
  for (const name of names.slice(1)) backlog(h, main, name, { location: ['- parent: epic'] });
  const folder = started(h, main, names[0], { location: ['- parent: epic'] });

  const siblings = (await sessionStart(h, folder)).context.split('\n').find((line) => line.startsWith('Siblings: '));

  assert.equal(siblings, `Siblings: ${names.slice(1, 9).map((name) => `${name} backlog`).join(', ')}, +3 more`);
});

test('D26: the walk up the parents stops at a task it has passed already', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  recorded(h, main, 'a', { location: ['- parent: b'], children: ['- c'] });
  recorded(h, main, 'b', { location: ['- parent: a'], children: ['- a'] });
  const folder = started(h, main, 'c', { location: ['- parent: a'] });

  assert.ok((await sessionStart(h, folder)).context.split('\n').includes('Where: b › a › **c**'));
});

test('D26: a parent with no ledger is still on the path, with no Siblings or Then line', async (t) => {
  const h = home(t);
  const folder = started(h, checkout(h, 'app'), 'part', { location: ['- parent: epic'] });

  assert.deepEqual((await sessionStart(h, folder)).context.split('\n').slice(2), ['Where: epic › **part**', 'Next: Next step of part.']);
});

test('D26: on a large tree the report stays at 20 lines, capping the items for the operator, the siblings and the siblings to retire', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const names = Array.from({ length: 41 }, (_, index) => `kid-${String(index).padStart(2, '0')}`);
  backlog(h, main, 'epic', { children: names.map((name) => `- ${name}`) });
  const states = (index: number): string[] => (index <= 3 ? ['- status: blocked 2026-11-20 — on hold'] : index <= 6 ? ['- status: done 2026-11-20'] : index <= 8 ? [`- claim: ${CLAIMED}`] : []);
  names.slice(1).forEach((name, index) => recorded(h, main, name, { location: ['- parent: epic', ...states(index + 1)] }));
  const questions = Array.from({ length: 10 }, (_, index) => `- Question number ${index + 1}?`);
  const folder = started(h, main, names[0], { location: ['- parent: epic'], questions });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.ok(lines.length <= 20, `${lines.length} lines:\n${lines.join('\n')}`);
  assert.deepEqual(lines.slice(1, 8), [
    'Needs you:',
    ...names.slice(4, 7).map((name) => `- Done: ${name} — finalize with the question from \`ledger task gate finalize ${name}\``),
    '- Question 1: Question number 1?',
    '- Question 2: Question number 2?',
    '- +13 more',
  ]);
  assert.match(lines.find((line) => line.startsWith('Siblings: ')) ?? '', /, \+32 more$/);
  const firstEight = ['kid-01 (blocked)', 'kid-02 (blocked)', 'kid-03 (blocked)', 'kid-04 (done)', 'kid-05 (done)', 'kid-06 (done)', 'kid-07 (active)', 'kid-08 (active)'];
  assert.equal(lines.at(-1), `Then: ${firstEight.join(', ')} and 32 more must be retired, then the parent finalizes next`);
});

test('D26: a question of several lines shows only its first line, so the report stays within 20 lines', async (t) => {
  const h = home(t);
  const more = Array.from({ length: 20 }, (_, index) => `  Detail line ${index + 1}.`);
  const folder = started(h, checkout(h, 'app'), 'solo', { questions: ['- Which API version?', ...more, '- Who reviews?'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.ok(lines.length <= 20, `${lines.length} lines:\n${lines.join('\n')}`);
  assert.deepEqual(lines.slice(1, 4), ['Needs you:', '- Question 1: Which API version?', '- Question 2: Who reviews?']);
});

test('D26: a blocked detail of several lines shows only its first line', (t) => {
  const h = home(t);
  recorded(h, checkout(h, 'app'), 'solo', { location: ['- status: blocked 2026-11-20 — waiting on keys'] });
  const [task] = activeTasks(fileStore(ledgerPaths(h)));
  const status = { value: 'blocked' as const, detail: 'waiting on keys\nfrom the vendor\nby Friday' };
  const multiline = { ...task, ledger: { ...task.ledger, location: { ...task.ledger.location, status } } };

  const lines = sessionReport({ tasks: [multiline], own: true }, [multiline], () => undefined).split('\n');

  assert.deepEqual(lines.slice(1, 3), ['Needs you:', '- Blocked: solo — waiting on keys']);
  assert.equal(lines[3], 'Where: **solo** (no parent)');
});

test('D26: a task anywhere in the tree held by another session is named, not only a sibling or a parent', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- part', '- other'] });
  const folder = started(h, main, 'part', { location: ['- parent: epic'] });
  backlog(h, main, 'other', { location: ['- parent: epic'], children: ['- deep'] });
  recorded(h, main, 'deep', { location: ['- parent: other', `- claim: ${CLAIMED}`] });

  assert.match((await sessionStart(h, folder)).context, /^- Held by another session: deep \(other-session since 2026-11-24T10:00:00Z\)$/m);
});

test('D26: a folder that owns several ledgers lists each with its Next step and asks which to continue, within 20 lines', (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const slugs = Array.from({ length: 12 }, (_, index) => `task-${String(index).padStart(2, '0')}`);
  for (const slug of slugs) recorded(h, main, slug, slug === 'task-01' ? { location: ['- status: parked 2026-11-20', '- stage: red'] } : {});
  const store = fileStore(ledgerPaths(h));
  const all = findTasks(store);
  const mine = activeTasks(store).sort((a, b) => a.slug.localeCompare(b.slug));

  const two = sessionReport({ tasks: mine.slice(0, 2), own: true }, all, () => undefined).split('\n');
  const twelve = sessionReport({ tasks: mine, own: true }, all, () => undefined).split('\n');

  assert.deepEqual(two, [
    tail('task-00', worktreeOf(main, 'task-00'), 'active, stage plan (code)'),
    'Next: Next step of task-00.',
    tail('task-01', worktreeOf(main, 'task-01'), 'parked, stage red (code)'),
    'Next: Next step of task-01.',
    'Ask the operator which task to continue.',
  ]);
  assert.equal(twelve.length, 20);
  assert.deepEqual(twelve.slice(-2), ['+3 more', 'Ask the operator which task to continue.']);
});

test('D26: hook failures still come first, outside the report', async (t) => {
  const h = home(t);
  const folder = started(h, checkout(h, 'app'), 'solo');
  writeFileSync(path.join(h, '.claude/ledger-hook-failures.log'), '2026-11-19T08:00:00Z\tledger hook pre-tool-use\tit broke\n');

  const [failures, report] = (await sessionStart(h, folder)).context.split('\n\n');

  assert.match(failures, /^⚠ 1 hook failure since 2026-11-19T08:00:00Z/);
  assert.match(report, /^Task solo in /);
});

test('D26: a lost sibling is not in Siblings, and the last open child names the backlog sibling that starts next, as finalize does', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const lost = (slug: string): string => `- lost: 2026-11-22 — folder ${worktreeOf(main, slug)} not found`;
  backlog(h, main, 'epic', { children: ['- first', '- part', '- gone'] });
  backlog(h, main, 'first', { location: ['- parent: epic'] });
  const folder = started(h, main, 'part', { location: ['- parent: epic'] });
  recorded(h, main, 'gone', { location: ['- parent: epic', lost('gone')] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.deepEqual(lines.slice(-4), [
    'Where: epic › **part**',
    'Siblings: first backlog',
    'Next: Next step of part.',
    'Then: first (backlog)',
  ]);
});

test('D26: Then skips a lost sibling and names the next open child', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- part', '- gone', '- after'] });
  const folder = started(h, main, 'part', { location: ['- parent: epic'] });
  recorded(h, main, 'gone', { location: ['- parent: epic', `- lost: 2026-11-22 — folder ${worktreeOf(main, 'gone')} not found`] });
  backlog(h, main, 'after', { location: ['- parent: epic'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.deepEqual(lines.slice(-3), ['Siblings: after backlog', 'Next: Next step of part.', 'Then: after (backlog)']);
});

test('D26: a done task gets finalize advice even when its parent does not list it', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- other'] });
  backlog(h, main, 'other', { location: ['- parent: epic'] });
  const folder = started(h, main, 'part', { location: ['- parent: epic', '- status: done 2026-11-20'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.deepEqual(lines.slice(1, 3), ['Needs you:', '- Done: part — finalize with the question from `ledger task gate finalize part`']);
});

test('D26: a done task in another repo is named for finalize by its slug and the main checkout of its repo', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const api = checkout(h, 'api');
  recorded(h, api, 'epic', { children: [`- part @ ${main}`, '- shipped'] });
  const folder = started(h, main, 'part', { location: [`- parent: epic @ ${api}`] });
  recorded(h, api, 'shipped', { location: ['- parent: epic', '- status: done 2026-11-20'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.deepEqual(lines.slice(1, 3), ['Needs you:', `- Done: shipped — finalize with the question from \`ledger task gate finalize shipped@${api}\``]);
});

test('D26: a merged PR on record comes before the open questions, so five questions do not hide it', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const folder = started(h, main, 'part', {
    location: ['- status: done 2026-11-20', '- pr: https://github.com/acme/app/pull/4'],
    questions: ['- One?', '- Two?', '- Three?', '- Four?', '- Five?'],
  });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.deepEqual(lines.slice(1, 4), ['Needs you:', '- PR merged: part — finalize with the question from `ledger task gate finalize part`', '- Question 1: One?']);
});

test('D26: a done child of the current task gets finalize advice even when the parent does not list the current task', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- other'] });
  backlog(h, main, 'other', { location: ['- parent: epic'] });
  const folder = started(h, main, 'part', { location: ['- parent: epic'], children: ['- sub'] });
  recorded(h, main, 'sub', { location: ['- parent: part', '- status: done 2026-11-20'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.deepEqual(lines.slice(1, 3), ['Needs you:', '- Done: sub — finalize with the question from `ledger task gate finalize sub`']);
});

test('D26: Then names every lost sibling, before or after the current task, as to retire before the parent finalizes', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const lost = (slug: string): string => `- lost: 2026-11-22 — folder ${worktreeOf(main, slug)} not found`;
  backlog(h, main, 'epic', { children: ['- early', '- part', '- late'] });
  recorded(h, main, 'early', { location: ['- parent: epic', lost('early')] });
  const folder = started(h, main, 'part', { location: ['- parent: epic'] });
  recorded(h, main, 'late', { location: ['- parent: epic', lost('late')] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.equal(lines.at(-1), 'Then: last open child: early (lost) and late (lost) must be retired, then the parent finalizes next');
});

test('D26: Then names a done sibling and a lost one as to retire before the parent finalizes', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- shipped', '- part', '- gone'] });
  recorded(h, main, 'shipped', { location: ['- parent: epic', '- status: done 2026-11-20'] });
  const folder = started(h, main, 'part', { location: ['- parent: epic'] });
  recorded(h, main, 'gone', { location: ['- parent: epic', `- lost: 2026-11-22 — folder ${worktreeOf(main, 'gone')} not found`] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.equal(lines.at(-1), 'Then: last open child: shipped (done) and gone (lost) must be retired, then the parent finalizes next');
});

test('D26: a sibling marked retired under Children whose ledger is still live counts as open, as finalize counts it', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- stale (retired 2026-11-20)', '- part'] });
  recorded(h, main, 'stale', { location: ['- parent: epic', `- lost: 2026-11-22 — folder ${worktreeOf(main, 'stale')} not found`] });
  const folder = started(h, main, 'part', { location: ['- parent: epic'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.equal(lines.at(-1), 'Then: last open child: stale (lost) must be retired, then the parent finalizes next');
});

test('D26: a done grandchild under a backlog child whose record names its main as a relative path gets finalize advice', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- part', '- later'] });
  const folder = started(h, main, 'part', { location: ['- parent: epic'] });
  const later = path.join(storeFolder(h, 'ledger-backlog', main), 'later.md');
  writeFileSync(later, ledgerMd('later', { location: ['- main: .', '- parent: epic'], children: ['- grand'] }));
  recorded(h, main, 'grand', { location: ['- parent: later', '- status: done 2026-11-20'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.deepEqual(lines.slice(1, 3), ['Needs you:', '- Done: grand — finalize with the question from `ledger task gate finalize grand`']);
});

test('D26: a backlog parent whose record names its main as a relative path still shows the siblings and the Then line, as finalize does', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const epic = path.join(storeFolder(h, 'ledger-backlog', main), 'epic.md');
  mkdirSync(path.dirname(epic), { recursive: true });
  writeFileSync(epic, ledgerMd('epic', { location: ['- main: .'], children: ['- part', '- later'] }));
  const folder = started(h, main, 'part', { location: ['- parent: epic'] });
  backlog(h, main, 'later', { location: ['- parent: epic'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.deepEqual(lines.slice(-4), ['Where: epic › **part**', 'Siblings: later backlog', 'Next: Next step of part.', 'Then: later (backlog)']);
});

test('D26: the last open child does not name a backlog sibling that waits for a task not done; it names it as to retire, as finalize does', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- later', '- part'] });
  backlog(h, main, 'later', { location: ['- parent: epic', '- depends on: nowhere'] });
  const folder = started(h, main, 'part', { location: ['- parent: epic'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.equal(lines.at(-1), 'Then: last open child: later (backlog) must be retired, then the parent finalizes next');
});

test('D26: the last open child names the first startable child of a backlog sibling that has children, as tree next starts it', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- nested', '- part'] });
  backlog(h, main, 'nested', { location: ['- parent: epic'], children: ['- deep'] });
  backlog(h, main, 'deep', { location: ['- parent: nested'] });
  const folder = started(h, main, 'part', { location: ['- parent: epic'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.equal(lines.at(-1), 'Then: deep (backlog)');
});

test('D26: Then passes over a sibling after the current task that waits for a task not done, and names the next that can start, as finalize does', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- current', '- wait', '- ready'] });
  const folder = started(h, main, 'current', { location: ['- parent: epic'] });
  backlog(h, main, 'wait', { location: ['- parent: epic', '- depends on: nowhere'] });
  backlog(h, main, 'ready', { location: ['- parent: epic'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.deepEqual(lines.slice(-3), ['Siblings: wait backlog, ready backlog', 'Next: Next step of current.', 'Then: ready (backlog)']);
  assert.deepEqual(await finalizeLabels(h, folder), ['Retire current (Recommended)', 'Start ready', 'Close']);
});

test('D26: Then names the first startable child of a backlog sibling after the current task, as finalize does', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- current', '- nested'] });
  const folder = started(h, main, 'current', { location: ['- parent: epic'] });
  backlog(h, main, 'nested', { location: ['- parent: epic'], children: ['- deep'] });
  backlog(h, main, 'deep', { location: ['- parent: nested'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.equal(lines.at(-1), 'Then: deep (backlog)');
  assert.deepEqual(await finalizeLabels(h, folder), ['Retire current (Recommended)', 'Start deep', 'Close']);
});

test('D26: when no sibling after the current task can start, Then names the siblings to retire before the parent finalizes, not calling the task the last open child', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- current', '- wait'] });
  const folder = started(h, main, 'current', { location: ['- parent: epic'] });
  backlog(h, main, 'wait', { location: ['- parent: epic', '- depends on: nowhere'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.equal(lines.at(-1), 'Then: wait (backlog) must be retired, then the parent finalizes next');
  assert.deepEqual(await finalizeLabels(h, folder), ['Retire current (Recommended)', 'Close']);
});

test('D26: a current task with a child left gets that child to start next, never the parent to finalize, as finalize does', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- current'] });
  const folder = started(h, main, 'current', { location: ['- parent: epic'], children: ['- leaf'] });
  backlog(h, main, 'leaf', { location: ['- parent: current'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.equal(lines.at(-1), 'Then: leaf (backlog)');
  assert.deepEqual(await finalizeLabels(h, folder), ['Start leaf (Recommended)', 'Close']);
});

test('D26: a current task whose children have all started gets no Then line, as finalize has nothing to start or retire', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- current'] });
  const folder = started(h, main, 'current', { location: ['- parent: epic'], children: ['- leaf'] });
  recorded(h, main, 'leaf', { location: ['- parent: current'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.equal(lines.at(-1), 'Next: Next step of current.');
  const gate = await runInProcessWith(h, folder, { env: hookEnv(h) }, 'task', 'gate', 'finalize');
  assert.match(gate.stderr, /^current has nothing left to finalize\./m);
});

test('D26: a sibling line with no ledger counts as not retired, so the parent does not finalize next, as finalize counts it', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- current', `- gone @ ${main}`] });
  const folder = started(h, main, 'current', { location: ['- parent: epic'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.deepEqual(lines.slice(-3), ['Where: epic › **current**', 'Next: Next step of current.', 'Then: last open child: gone (missing) must be retired, then the parent finalizes next']);
  assert.deepEqual(await finalizeLabels(h, folder), ['Retire current (Recommended)', 'Close']);
});

test('D26: a parent that has only an archive copy gets no Then line, as finalize then has no parent to finalize', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  retired(h, main, 'epic', { children: ['- current'] });
  const folder = started(h, main, 'current', { location: ['- parent: epic'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.deepEqual(lines.slice(-2), ['Where: epic › **current**', 'Next: Next step of current.']);
  assert.deepEqual(await finalizeLabels(h, folder), ['Retire current (Recommended)', 'Close']);
});

test('D26: under a parent that has only an archive copy, a current task with a child left gets that child to start, as finalize offers it', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  retired(h, main, 'epic', { children: ['- current'] });
  const folder = started(h, main, 'current', { location: ['- parent: epic'], children: ['- leaf'] });
  backlog(h, main, 'leaf', { location: ['- parent: current'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.equal(lines.at(-1), 'Then: leaf (backlog)');
  assert.deepEqual(await finalizeLabels(h, folder), ['Start leaf (Recommended)', 'Close']);
  assert.equal((await sessionStart(h, main)).context, ['Open task trees in this repo:', '- epic retired — 1 open child', ASK_TREES].join('\n'));
});

test('D26: a sibling line marked started whose task has no ledger anywhere counts as missing, not as prose, as finalize counts it', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- current', '- gone (started 2026-11-01)'] });
  const folder = started(h, main, 'current', { location: ['- parent: epic'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.deepEqual(
    { then: lines.at(-1), gate: await finalizeLabels(h, folder) },
    { then: 'Then: last open child: gone (missing) must be retired, then the parent finalizes next', gate: ['Retire current (Recommended)', 'Close'] },
  );
});

test('D26: a sibling line marked retired whose archive copy is gone does not block the parent, in the report or the gate', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- current', '- gone (retired 2026-11-01)'] });
  const folder = started(h, main, 'current', { location: ['- parent: epic'] });

  const lines = (await sessionStart(h, folder)).context.split('\n');
  const gate = await finalizeLabels(h, folder);

  assert.deepEqual(
    { then: lines.at(-1), finalizesEpic: gate.some((label) => label.includes('epic')) },
    { then: 'Then: last child: the parent finalizes next', finalizesEpic: true },
  );
});

/** Two checkouts of one repo, as they share one origin and so one repo key. The store knows the second by a backlog task there. */
function twoCheckouts(h: string): { a: string; b: string } {
  const origin = path.join(h, 'remotes', 'app.git');
  const [a, b] = ['app', 'app-b'].map((name) => {
    const main = checkout(h, name);
    git(h, main, 'remote', 'add', 'origin', origin);
    return main;
  });
  backlog(h, b, 'later');
  return { a, b };
}

test('D26: Then reads the children of the current task at the session checkout, as finalize does, not at the checkout its parent line names', async (t) => {
  const h = home(t);
  const { a, b } = twoCheckouts(h);
  backlog(h, a, 'epic', { children: [`- current @ ${b}`] });
  const folder = started(h, a, 'current', { location: ['- parent: epic'], children: ['- old'] });
  retired(h, a, 'old', { location: [`- parent: current @ ${a}`] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.equal(lines.at(-1), 'Then: last child: the parent finalizes next');
  assert.deepEqual(await finalizeLabels(h, folder), ['Retire current (Recommended)', 'Finalize epic', 'Close']);
});

test('D26: a child whose archive copy names the current task at the other checkout is still left at the session checkout, so there is no Then line, as finalize offers nothing', async (t) => {
  const h = home(t);
  const { a, b } = twoCheckouts(h);
  backlog(h, a, 'epic', { children: [`- current @ ${b}`] });
  const folder = started(h, a, 'current', { location: ['- parent: epic'], children: ['- old'] });
  retired(h, a, 'old', { location: [`- parent: current @ ${b}`] });

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.equal(lines.at(-1), 'Next: Next step of current.');
  const gate = await runInProcessWith(h, folder, { env: hookEnv(h) }, 'task', 'gate', 'finalize');
  assert.match(gate.stderr, /^current has nothing left to finalize\./m);
});

test('D26: a done task the tree finds at a checkout of another repo gets finalize advice for that checkout, not for the stale main its record names', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const api = checkout(h, 'api');
  backlog(h, api, 'later');
  backlog(h, main, 'epic', { children: ['- current', `- shipped @ ${api}`] });
  const folder = started(h, main, 'current', { location: ['- parent: epic'] });
  backlog(h, main, 'shipped', { children: ['- orphan'] });
  backlog(h, main, 'orphan', { location: ['- parent: shipped'] });
  putActive(h, api, 'shipped', ledgerMd('shipped', { location: [`- main: ${main}`, `- parent: epic @ ${main}`, '- status: done 2026-11-20'] }));

  const lines = (await sessionStart(h, folder)).context.split('\n');

  assert.deepEqual(lines.slice(1, 3), ['Needs you:', `- Done: shipped — finalize with the question from \`ledger task gate finalize shipped@${api}\``]);
  assert.deepEqual(await finalizeLabels(h, folder, `shipped@${api}`), ['Retire shipped (Recommended)', 'Close']);
});

test('D26: finalize advice for a slug that starts with a hyphen runs, as the CLI does not read the slug as an option', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- part', '- -legacy'] });
  const folder = started(h, main, 'part', { location: ['- parent: epic'] });
  recorded(h, main, '-legacy', { location: ['- parent: epic', '- status: done 2026-11-20'] });

  const advice = /^- Done: -legacy — finalize with the question from `ledger (.+)`$/m.exec((await sessionStart(h, folder)).context);

  assert.ok(advice, 'no finalize advice for -legacy');
  assert.equal(advice[1], 'task gate finalize -- -legacy');
  const ran = spawnSync(LEDGER_BIN, advice[1].split(' '), { cwd: folder, env: hookEnv(h), encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /"Retire -legacy/);
});

test('D26: finalize advice for a task of another repo with no known main checkout says to run it from a checkout of that repo, never a placeholder', (t) => {
  const h = home(t);
  recorded(h, checkout(h, 'api'), 'shipped', { location: ['- status: done 2026-11-20'] });
  const [{ main: _main, ...shipped }] = activeTasks(fileStore(ledgerPaths(h)));

  assert.equal(finalizeAdvice(shipped, 'github.com/acme/app'), 'from a checkout of its repo, with the question from `ledger task gate finalize shipped`');
  assert.equal(finalizeAdvice({ ...shipped, slug: '-legacy' }, 'github.com/acme/app'), 'from a checkout of its repo, with the question from `ledger task gate finalize -- -legacy`');
});

// B. Outside any task (D27)

test('D27: a main checkout lists the open trees of its repo and asks what to do', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'epic', { children: ['- part', '- idea', '- old (retired 2026-11-01)'] });
  started(h, main, 'part', { location: ['- parent: epic'] });
  backlog(h, main, 'idea', { location: ['- parent: epic'] });
  retired(h, main, 'old', { location: ['- parent: epic'] });
  started(h, main, 'solo', { location: ['- status: parked 2026-11-20'] });
  backlog(h, main, 'single', { children: ['- part'] });
  retired(h, main, 'finished');
  backlog(h, checkout(h, 'other'), 'foreign');

  assert.equal(
    (await sessionStart(h, main)).context,
    ['Open task trees in this repo:', '- solo parked', '- epic backlog — 2 open children', '- single backlog — 1 open child', ASK_TREES].join('\n'),
  );
});

test('D27: a root whose record names its main as a relative path counts its children at the main checkout, and they head no tree of their own', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const epic = path.join(storeFolder(h, 'ledger-backlog', main), 'epic.md');
  mkdirSync(path.dirname(epic), { recursive: true });
  writeFileSync(epic, ledgerMd('epic', { location: ['- main: .'], children: ['- part'] }));
  backlog(h, main, 'part', { location: ['- parent: epic'] });

  assert.equal((await sessionStart(h, main)).context, ['Open task trees in this repo:', '- epic backlog — 1 open child', ASK_TREES].join('\n'));
});

test('D27: a live task whose parent is in another repo or has no ledger heads a tree here, so it is not hidden', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const other = checkout(h, 'other');
  backlog(h, other, 'epic', { children: ['- part'] });
  started(h, main, 'part', { location: [`- parent: epic @ ${other}`] });
  backlog(h, main, 'orphan', { location: ['- parent: gone'] });
  retired(h, main, 'old-orphan', { location: ['- parent: gone'] });

  assert.equal((await sessionStart(h, main)).context, ['Open task trees in this repo:', '- part active', '- orphan backlog', ASK_TREES].join('\n'));
});

test('D27: a linked worktree with no ledger of its own lists the open trees too', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  backlog(h, main, 'idea');
  const folder = linked(h, main, 'loose');

  const { context, title } = await sessionStart(h, folder);

  assert.equal(title, undefined);
  assert.equal(context, ['Open task trees in this repo:', '- idea backlog', ASK_TREES].join('\n'));
});

test('D27: a lost root is not offered, unless an open task is below it', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const lost = (slug: string): string => `- lost: 2026-11-22 — folder ${worktreeOf(main, slug)} not found`;
  recorded(h, main, 'gone', { location: [lost('gone')] });
  recorded(h, main, 'base', { location: [lost('base')], children: ['- part'] });
  backlog(h, main, 'part', { location: ['- parent: base'] });
  backlog(h, main, 'idea');

  assert.equal((await sessionStart(h, main)).context, ['Open task trees in this repo:', '- base lost — 1 open child', '- idea backlog', ASK_TREES].join('\n'));
});

test('D27: at most 12 trees, then how many more and where to see them', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  for (let index = 0; index < 15; index += 1) backlog(h, main, `idea-${String(index).padStart(2, '0')}`);

  const lines = (await sessionStart(h, main)).context.split('\n');

  assert.equal(lines.length, 15);
  assert.equal(lines[12], '- idea-11 backlog');
  assert.equal(lines[13], '- +3 more — `ledger list`');
  assert.equal(lines[14], ASK_TREES);
});

test('D27: a main checkout with no open tree still asks: a new task or quick work', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  retired(h, main, 'finished');

  assert.equal((await sessionStart(h, main)).context, ['No open task trees in this repo.', ASK_NEW].join('\n'));
});

test('D27: a live task is not hidden when its root has no record, or when its parent does not list it', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const lost = (slug: string): string => `- lost: 2026-11-22 — folder ${worktreeOf(main, slug)} not found`;
  retired(h, main, 'middle', { location: ['- parent: gone'], children: ['- leaf'] });
  backlog(h, main, 'leaf', { location: ['- parent: middle'] });
  recorded(h, main, 'base', { location: [lost('base')] });
  backlog(h, main, 'stray', { location: ['- parent: base'] });
  backlog(h, main, 'epic');
  backlog(h, main, 'kid', { location: ['- parent: epic'] });

  assert.equal(
    (await sessionStart(h, main)).context,
    ['Open task trees in this repo:', '- epic backlog', '- kid backlog', '- stray backlog', '- middle retired — 1 open child', ASK_TREES].join('\n'),
  );
});

test('D27: a lost child is not counted as open, and a lost root with only lost children is not offered', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const lost = (slug: string): string => `- lost: 2026-11-22 — folder ${worktreeOf(main, slug)} not found`;
  backlog(h, main, 'epic', { children: ['- part', '- gone'] });
  backlog(h, main, 'part', { location: ['- parent: epic'] });
  recorded(h, main, 'gone', { location: ['- parent: epic', lost('gone')] });
  recorded(h, main, 'old', { location: [lost('old')], children: ['- older'] });
  recorded(h, main, 'older', { location: ['- parent: old', lost('older')] });

  assert.equal((await sessionStart(h, main)).context, ['Open task trees in this repo:', '- epic backlog — 1 open child', ASK_TREES].join('\n'));
});

// C. The status line (D28)

test('D28: ledger statusline prints the task and stage of the folder, and its state when it is not plain active', (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const plain = started(h, main, 'plain');
  const docs = started(h, main, 'docs', { location: ['- kind: docs', '- stage: review', '- status: blocked 2026-11-20 — waiting'] });
  const waiting = started(h, main, 'waits', { location: ['- stage: pr', '- status: waiting 2026-11-20'] });

  mkdirSync(path.join(plain, 'src'));

  assert.equal(statusline(h, plain), 'plain · plan\n');
  assert.equal(statusline(h, path.join(plain, 'src')), 'plain · plan\n');
  assert.equal(statusline(h, docs), 'docs · review · blocked\n');
  assert.equal(statusline(h, waiting), 'waits · pr · waiting\n');
});

test('D28: ledger statusline prints nothing for a main checkout, a folder outside git, a missing folder or a broken settings file', (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const folder = started(h, main, 'plain');

  assert.equal(statusline(h, main), '');
  assert.equal(statusline(h, h), '');
  assert.equal(statusline(h, path.join(h, 'gone')), '');
  writeFileSync(path.join(h, '.claude/ledger-settings.json'), '{ not json');
  assert.equal(statusline(h, folder), '');
});

test('D28: the status line text counts several ledgers of one folder', (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  recorded(h, main, 'one');
  recorded(h, main, 'two');
  const tasks = activeTasks(fileStore(ledgerPaths(h)));

  assert.equal(statusLineText({ tasks, own: true }), '2 tasks');
  assert.equal(statusLineText({ tasks: tasks.slice(0, 1), own: true }), `${tasks[0].slug} · plan`);
  assert.equal(statusLineText({ tasks, own: false }), '');
});

// D. The session title (D43)

test('D43: a task title is its state icon and slug, the first state that applies giving the icon', (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const status = (value: string): string => `- status: ${value} 2026-11-20`;
  const asked = ['- Which API version?'];
  const cases: [slug: string, spec: Spec, title: string][] = [
    ['finished', { location: [status('done')] }, '✅ finished'],
    ['stuck', { location: [status('blocked')] }, '⛔ stuck'],
    ['resting', { location: [status('parked')] }, '💤 resting'],
    ['asking', { questions: asked }, '🟡 asking'],
    ['pending', { location: [status('waiting')] }, '⏳ pending'],
    ['checked', { location: ['- stage: review'] }, '🔍 checked'],
    ['plain', {}, '🔨 plain'],
    ['building', { location: ['- stage: implement'] }, '🔨 building'],
    ['answered', { questions: ['- (resolved) Old one?'] }, '🔨 answered'],
    ['done-asking', { location: [status('done')], questions: asked }, '✅ done-asking'],
    ['parked-asking', { location: [status('parked')], questions: asked }, '💤 parked-asking'],
    ['waiting-asking', { location: [status('waiting')], questions: asked }, '🟡 waiting-asking'],
    ['waiting-review', { location: ['- stage: review', status('waiting')] }, '⏳ waiting-review'],
  ];
  for (const [slug, spec] of cases) recorded(h, main, slug, spec);
  const tasks = activeTasks(fileStore(ledgerPaths(h)));

  for (const [slug, , title] of cases) assert.equal(taskTitle(tasks.find((task) => task.slug === slug)!), title, slug);
});

/**
 * A machine on git storage with the task fix-login started; its git runs the shell `cases` first, its gh notes every call
 * in $HOME/gh-calls, and no background sync has run yet. Gives the task's folder.
 */
function gitStorageTask(t: TestContext, cases: string): { m: Machine; folder: string } {
  const bare = remote(t);
  const m = machine(t, bare);
  setUp(m);
  ledgerOk(m, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.');
  ledgerOk(m, 'go', 'fix-login');
  for (const file of ['gh-calls', 'background-sync-pids']) rmSync(path.join(m.h, file), { force: true });
  writeFileSync(path.join(m.h, 'stub-bin/gh'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/gh-calls"\nexit 4\n');
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path.join(m.h, 'stub-bin/git'), `#!/bin/sh\n${cases}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
  return { m, folder: path.join(m.app, '.claude/worktrees/fix-login') };
}

test('D28: ledger statusline on git storage reads the clone and never pulls, syncs or runs gh, so a remote that hangs costs nothing', (t) => {
  const { m, folder } = gitStorageTask(t, 'case "$*" in *fetch*|*pull*|*push*|*ls-remote*) touch "$HOME/network-git"; exec sleep 30 ;; esac');

  const began = Date.now();
  const ran = spawnSync(LEDGER_BIN, ['statusline', folder], { cwd: m.h, env: machineEnv(m), encoding: 'utf8', timeout: 20_000 });
  const took = Date.now() - began;

  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, 'fix-login · plan\n');
  assert.ok(took < 5_000, `the status line took ${took} ms`);
  assert.equal(existsSync(path.join(m.h, 'network-git')), false, 'the status line ran a network git command');
  assert.equal(existsSync(path.join(m.h, 'gh-calls')), false, 'the status line ran gh');
  assert.equal(existsSync(backgroundPids(m.h)), false, 'the status line started a store sync');
});

test('D28: ledger statusline on git storage gives up on a clone whose git hangs, and prints nothing', (t) => {
  const { m, folder } = gitStorageTask(t, 'case "$*" in *ledger-data*) touch "$HOME/clone-git"; exec sleep 30 ;; esac');

  const began = Date.now();
  const ran = spawnSync(LEDGER_BIN, ['statusline', folder], { cwd: m.h, env: machineEnv(m), encoding: 'utf8', timeout: 20_000 });
  const took = Date.now() - began;

  assert.equal(existsSync(path.join(m.h, 'clone-git')), true, 'no git call in the clone hung');
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, '');
  assert.ok(took < 5_000, `the status line took ${took} ms`);
});
