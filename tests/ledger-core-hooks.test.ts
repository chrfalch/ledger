import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before, type TestContext } from 'node:test';
import type { Clock } from '../tools/ledger/clock.js';
import { limitCloneGitCalls } from '../tools/ledger/clone.js';
import { fileStore } from '../tools/ledger/file-store.js';
import { parseLedger } from '../tools/ledger/format.js';
import { mainCheckout, resetGitLimits } from '../tools/ledger/git.js';
import { parseHookInput, preToolUse } from '../tools/ledger/hooks.js';
import { limitLockWaits } from '../tools/ledger/lock.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { parseRecord, recordJson } from '../tools/ledger/record.js';
import { repoKey } from '../tools/ledger/repo-key.js';
import { REPO } from './helpers.js';
import { fakeClock, git, home, LEDGER_BIN, ledgerText, readLedgerFile, runInProcessWith, shortLimits, touch } from './ledger-core-fixtures.js';

type Ran = { status: number | null; stdout: string; stderr: string };

/** The time limit of a hook in the tests of a git that hangs; ledger in use gives a hook 5 s. */
const HOOK_MS = 1000;

function environment(h: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: h,
    GIT_CONFIG_GLOBAL: path.join(h, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: path.dirname(h),
    ...extra,
  };
}

/** `ledger hook <event>` with `input` on stdin, run inside this process from HOME so that only the input's cwd names a repo. */
async function runHook(h: string, event: string, input: string, extra?: NodeJS.ProcessEnv, clock?: Clock): Promise<Ran> {
  try {
    return await runInProcessWith(h, h, { env: environment(h, extra), input, clock }, 'hook', event);
  } finally {
    // A hook run leaves its deadlines set until the next run starts; a test that calls ledger code directly must not inherit them.
    resetGitLimits();
    limitCloneGitCalls(Infinity);
    limitLockWaits(Infinity);
  }
}

/** `runHook` in a `bin/ledger` process of its own, for the tests of a hang: they time a real process, and lower its limits with `shortLimits`. */
function spawnHook(h: string, event: string, input: string, extra: NodeJS.ProcessEnv, timeout: number): Ran {
  const result = spawnSync(LEDGER_BIN, ['hook', event], { cwd: h, env: environment(h, extra), input, encoding: 'utf8', timeout });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function hook(h: string, event: string, input: object): Promise<string> {
  const ran = await runHook(h, event, JSON.stringify(input));
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stderr, '');
  return ran.stdout;
}

function checkout(h: string, name: string): string {
  const main = path.join(h, name);
  mkdirSync(main, { recursive: true });
  git(h, main, 'init', '--quiet');
  git(h, main, 'commit', '--quiet', '--allow-empty', '-m', 'initial');
  return main;
}

function worktree(h: string, main: string, location: string): string {
  git(h, main, 'worktree', 'add', '--quiet', '-b', path.basename(location), location);
  return location;
}

/**
 * `text` as the active ledger of the task whose worktree is `folder`, filed under the repo that holds the folder, or under
 * the folder outside a git repository; its slug is the heading's, else the folder's name. Gives the record's file.
 */
function ledgerIn(h: string, folder: string, text = `# Task ledger — ${path.basename(folder)}\n\n## Goal\nA goal.\n\n## Next step\nA step.\n`): string {
  mkdirSync(folder, { recursive: true });
  const main = mainCheckout(folder);
  const repo = main === undefined ? folder : repoKey(main);
  const slug = parseLedger(text).slug ?? path.basename(folder);
  const { active } = fileStore(ledgerPaths(h));
  const file = active.location(repo, slug);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, recordJson({ ...parseRecord(text), worktree: folder }));
  return file;
}

function familyLedger(slug: string, location: string[], rest = '## Next step\nA step.\n'): string {
  return [`# Task ledger — ${slug}`, '', '## Goal', 'A goal.', '', '## Location', ...location, '', rest].join('\n');
}

/** The store folder of the repo at <h>/<name>, which has no remote, so its key is that path. */
const repoFolder = (h: string, name: string): string => encodeURIComponent(path.join(h, name));

function backlogLedger(h: string, name: string, slug: string, owner: string, location: string[] = []): string {
  const ledger = path.join(h, '.claude/ledger-backlog', repoFolder(h, name), `${slug}.md`);
  mkdirSync(path.dirname(ledger), { recursive: true });
  writeFileSync(ledger, familyLedger(slug, [`- main: ${owner}`, '- worktree: <path>', ...location]));
  return ledger;
}

function archiveCopy(h: string, repo: string, name: string, text: string): string {
  const copy = path.join(h, '.claude/ledger-archive', repoFolder(h, repo), `${name}.md`);
  mkdirSync(path.dirname(copy), { recursive: true });
  writeFileSync(copy, text);
  return copy;
}

const slugOf = (ledger: string): string => path.basename(ledger, '.json');

/** The first line of the session-start report on the task of an active ledger file. */
const reportHead = (ledger: string, state = 'active, stage plan (code)'): string =>
  `Task ${slugOf(ledger)} in ${(JSON.parse(readFileSync(ledger, 'utf8')) as { worktree: string }).worktree} — ${state}. Details: \`ledger show\`. Write with \`ledger notes\`, never by editing a file.`;

/** The session-start report on a task with no parent and nothing for the operator. */
const soloReport = (ledger: string, next = 'A step.'): string => [reportHead(ledger), 'Needs you: nothing.', `Where: **${slugOf(ledger)}** (no parent)`, `Next: ${next}`].join('\n');

/** The session-start report on a child task with nothing for the operator: `lines` from its Where line on. */
const childReport = (ledger: string, ...lines: string[]): string => [reportHead(ledger), 'Needs you: nothing.', ...lines].join('\n');

/** The open trees of the repo, as session-start lists them outside any task. */
const treesText = (...lines: string[]): string =>
  [
    'Open task trees in this repo:',
    ...lines,
    'Ask the operator in one question widget: continue one of these trees (name it), make a new task, or quick work (a small change with no task).',
  ].join('\n');

/** What session-start says outside any task in a repo with no open tree. */
const noTreesText = 'No open task trees in this repo.\nAsk the operator in one question widget: make a new task, or quick work (a small change with no task).';

type SessionStartOutput = { hookSpecificOutput: { hookEventName: string; additionalContext: string; sessionTitle?: string } };

async function sessionStart(h: string, cwd: string): Promise<SessionStartOutput['hookSpecificOutput']> {
  const output = JSON.parse(await hook(h, 'session-start', { hook_event_name: 'SessionStart', source: 'startup', cwd })) as SessionStartOutput;
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  return output.hookSpecificOutput;
}

const preCompact = (h: string, cwd: string): Promise<string> => hook(h, 'pre-compact', { hook_event_name: 'PreCompact', trigger: 'auto', cwd });

// SessionStart and PreCompact

test('a main checkout\'s own ledger is never read back or named on compaction', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  worktree(h, main, path.join(h, 'sibling'));
  ledgerIn(h, main);

  assert.equal((await sessionStart(h, main)).additionalContext, noTreesText);
  assert.equal(await preCompact(h, main), '');
});

test('session-start from a main checkout lists the tasks of worktrees inside and outside it as open trees, but not its own', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(h, main);
  ledgerIn(h, worktree(h, main, path.join(main, '.claude/worktrees/inside')));
  ledgerIn(h, worktree(h, main, path.join(h, 'sibling')));

  assert.equal((await sessionStart(h, main)).additionalContext, treesText('- inside active', '- sibling active'));
});

test('session-start from a subdirectory of a main checkout ignores a ledger file in that subdirectory', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  mkdirSync(path.join(main, 'sub/.claude'), { recursive: true });
  writeFileSync(path.join(main, 'sub/.claude/ledger.md'), '# Task ledger — sub\n');
  ledgerIn(h, worktree(h, main, path.join(h, 'sibling')));

  const output = await sessionStart(h, path.join(main, 'sub'));

  assert.equal(output.additionalContext, treesText('- sibling active'));
  assert.equal('sessionTitle' in output, false);
});

test('session-start in a linked worktree reports only on its own task and titles the session with the slug', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(h, main);
  ledgerIn(h, worktree(h, main, path.join(h, 'other')));
  const sibling = worktree(h, main, path.join(h, 'sibling'));
  const ledger = ledgerIn(h, sibling, '# Task ledger — window-title  \n\n## Goal\nA goal.\n');

  const output = await sessionStart(h, sibling);

  assert.equal(output.sessionTitle, '🔨 window-title');
  assert.equal(output.additionalContext, soloReport(ledger, 'none written'));
});

test('session-start accepts a hyphen instead of an em dash in the ledger heading', async (t) => {
  const h = home(t);
  const sibling = worktree(h, checkout(h, 'main'), path.join(h, 'sibling'));
  ledgerIn(h, sibling, '# Task ledger - hyphenated\n');

  assert.equal((await sessionStart(h, sibling)).sessionTitle, '🔨 hyphenated');
});

test('session-start omits the title when the ledger has no heading', async (t) => {
  const h = home(t);
  const sibling = worktree(h, checkout(h, 'main'), path.join(h, 'sibling'));
  const ledger = ledgerIn(h, sibling, '## Goal\nA goal.\n');

  const output = await sessionStart(h, sibling);

  assert.equal('sessionTitle' in output, false);
  assert.equal(output.additionalContext, soloReport(ledger, 'none written'));
});

test('session-start omits the title when the heading has an empty slug or one that is no slug', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const empty = worktree(h, main, path.join(h, 'empty'));
  ledgerIn(h, empty, '# Task ledger —   \n');
  const odd = worktree(h, main, path.join(h, 'odd'));
  ledgerIn(h, odd, '# Task ledger — "quoted" \\ slug\n');

  assert.equal('sessionTitle' in await sessionStart(h, empty), false);
  assert.equal('sessionTitle' in await sessionStart(h, odd), false);
});

test('session-start in a main checkout lists several worktree tasks as open trees without a title', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(h, worktree(h, main, path.join(h, 'first')));
  ledgerIn(h, worktree(h, main, path.join(h, 'second')));

  const output = await sessionStart(h, main);

  assert.equal('sessionTitle' in output, false);
  assert.equal(output.additionalContext, treesText('- first active', '- second active'));
});

test('session-start in a main checkout with one worktree task lists it without a title', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(h, worktree(h, main, path.join(h, 'sibling')));

  const output = await sessionStart(h, main);

  assert.equal('sessionTitle' in output, false);
  assert.equal(output.additionalContext, treesText('- sibling active'));
});

test('session-start outside a git repository shows no ledger, not even a .claude/ledger.md there', async (t) => {
  const h = home(t);
  const plain = path.join(h, 'plain');
  mkdirSync(path.join(plain, '.claude'), { recursive: true });
  writeFileSync(path.join(plain, '.claude/ledger.md'), '# Task ledger — plain\n');

  assert.equal(await hook(h, 'session-start', { cwd: plain }), '');
});

/** A linked worktree of `main` that still holds its ledger as .claude/ledger.md, with no active record. */
function unmovedLedger(h: string, main: string, name: string): string {
  const folder = worktree(h, main, path.join(h, name));
  mkdirSync(path.join(folder, '.claude'));
  writeFileSync(path.join(folder, '.claude/ledger.md'), ledgerText({ slug: name, worktree: folder }));
  return folder;
}

const UNMOVED_HINT = /^(\d+) ledgers? still kept in \.claude\/ledger\.md; run `ledger store migrate --active`\.$/m;

test('session-start counts the linked worktrees of the session\'s repo that still keep their ledger in .claude/ledger.md', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const first = unmovedLedger(h, main, 'first');
  unmovedLedger(h, main, 'second');
  const moved = worktree(h, main, path.join(h, 'moved'));
  ledgerIn(h, moved);
  mkdirSync(path.join(moved, '.claude'), { recursive: true });
  writeFileSync(path.join(moved, '.claude/ledger.md'), ledgerText({ slug: 'moved', worktree: moved }));
  unmovedLedger(h, checkout(h, 'other'), 'elsewhere');

  assert.equal(UNMOVED_HINT.exec((await sessionStart(h, main)).additionalContext)?.[1], '2');
  assert.equal(UNMOVED_HINT.exec((await sessionStart(h, moved)).additionalContext)?.[1], '2');
  assert.equal(UNMOVED_HINT.exec(JSON.parse(await hook(h, 'session-start', { cwd: first })).hookSpecificOutput.additionalContext)?.[1], '2');
});

test('session-start gives no hint when no linked worktree of the repo keeps a .claude/ledger.md without a record', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  mkdirSync(path.join(main, '.claude'));
  writeFileSync(path.join(main, '.claude/ledger.md'), ledgerText({ slug: 'main' }));
  const moved = worktree(h, main, path.join(h, 'moved'));
  ledgerIn(h, moved);
  mkdirSync(path.join(moved, '.claude'), { recursive: true });
  writeFileSync(path.join(moved, '.claude/ledger.md'), ledgerText({ slug: 'moved', worktree: moved }));

  assert.doesNotMatch((await sessionStart(h, moved)).additionalContext, /still kept in/);
  assert.equal(await hook(h, 'session-start', { cwd: h }), '');
});

test('session-start whose git worktree listing does not answer gives no hint and still exits 0', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  unmovedLedger(h, main, 'first');
  const stubs = path.join(h, 'hanging-git');
  mkdirSync(stubs);
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path.join(stubs, 'git'), `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = list ] && exec sleep 30; done\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const started = Date.now();

  const ran = spawnHook(h, 'session-start', JSON.stringify({ cwd: main }), { PATH: `${stubs}${path.delimiter}${process.env.PATH ?? ''}`, ...shortLimits({ hookMs: HOOK_MS }) }, 20_000);

  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(Date.now() - started < HOOK_MS + 4_000);
  assert.doesNotMatch(ran.stdout, /still kept in/);
});

test('session-start in a child task shows the path to its parent, and that the parent finalizes after the last child', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const child = worktree(h, main, path.join(h, 'child'));
  const ledger = ledgerIn(h, child, familyLedger('child', ['- parent: epic']));
  ledgerIn(h, worktree(h, main, path.join(h, 'epic')), familyLedger('epic', [], '## Children\n- child\n\n## Next step\nParked: 2026-10-01 — waiting.\nA step.\n'));

  assert.equal((await sessionStart(h, child)).additionalContext, childReport(ledger, 'Where: epic › **child**', 'Next: A step.', 'Then: last child: the parent finalizes next'));
});

test('session-start in a child task whose parent has no ledger still names the parent, with CRLF line ends', async (t) => {
  const h = home(t);
  const child = worktree(h, checkout(h, 'main'), path.join(h, 'child'));
  const ledger = ledgerIn(h, child, familyLedger('child', ['- parent: epic']).replace(/\n/g, '\r\n'));

  assert.equal((await sessionStart(h, child)).additionalContext, childReport(ledger, 'Where: epic › **child**', 'Next: A step.'));
});

test('session-start in a child task lists its open siblings in order with their status from disk, and skips a retired one and a bullet that names no known task', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const children = '## Children\n- child-a\n- child-b\n- old (retired 2026-10-01)\n- lost\n\n## Next step\nA step.\n';
  ledgerIn(h, worktree(h, main, path.join(h, 'epic')), familyLedger('epic', [], children));
  const childA = worktree(h, main, path.join(h, 'child-a'));
  const ledger = ledgerIn(h, childA, familyLedger('child-a', ['- parent: epic']));
  ledgerIn(h, worktree(h, main, path.join(h, 'child-b')), familyLedger('child-b', ['- parent: epic'], '## Next step\n\nParked: 2026-10-02 - later.\n'));
  archiveCopy(h, 'main', '2026-10-01-old', familyLedger('old', [`- main: ${main}`, `- worktree: ${path.join(main, '.claude/worktrees/old')}`, '- parent: epic']));

  assert.equal(
    (await sessionStart(h, childA)).additionalContext,
    childReport(ledger, 'Where: epic › **child-a**', 'Siblings: child-b parked', 'Next: A step.', 'Then: child-b (parked) must be retired, then the parent finalizes next'),
  );
});

test('session-start lists a sibling marked retired as open while its ledger is live, as finalize counts it', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(h, worktree(h, main, path.join(h, 'epic')), familyLedger('epic', [], '## Children\n- reused (retired 2026-10-01)\n- current\n\n## Next step\nA step.\n'));
  ledgerIn(h, worktree(h, main, path.join(h, 'reused')), familyLedger('reused', ['- parent: epic']));
  const current = worktree(h, main, path.join(h, 'current'));
  const ledger = ledgerIn(h, current, familyLedger('current', ['- parent: epic']));

  assert.equal(
    (await sessionStart(h, current)).additionalContext,
    childReport(ledger, 'Where: epic › **current**', 'Siblings: reused active', 'Next: A step.', 'Then: last open child: reused (active) must be retired, then the parent finalizes next'),
  );
});

test('session-start lists a sibling marked started, with or without a note, with its status', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const children = '## Children\n- child-a (started 2026-10-20)\n- child-b (started 2026-10-20; PR #31 is open)\n- lost (started 2026-10-21)\n- current\n\n## Next step\nA step.\n';
  ledgerIn(h, worktree(h, main, path.join(h, 'epic')), familyLedger('epic', [], children));
  ledgerIn(h, worktree(h, main, path.join(h, 'child-a')), familyLedger('child-a', ['- parent: epic']));
  ledgerIn(h, worktree(h, main, path.join(h, 'child-b')), familyLedger('child-b', ['- parent: epic']));
  const current = worktree(h, main, path.join(h, 'current'));
  ledgerIn(h, current, familyLedger('current', ['- parent: epic']));

  assert.ok((await sessionStart(h, current)).additionalContext.split('\n').includes('Siblings: child-a active, child-b active'));
});

test('session-start in a main checkout lists a tree once, by its root task, with its open children', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(h, worktree(h, main, path.join(h, 'epic')), familyLedger('epic', [], '## Children\n- child-a\n- child-b\n\n## Next step\nA step.\n'));
  ledgerIn(h, worktree(h, main, path.join(h, 'child-a')), familyLedger('child-a', ['- parent: epic']));
  ledgerIn(h, worktree(h, main, path.join(h, 'child-b')), familyLedger('child-b', ['- parent: epic'], '## Next step\nParked: 2026-10-02 — later.\nA step.\n'));

  assert.equal((await sessionStart(h, main)).additionalContext, treesText('- epic active — 2 open children'));
});

test('session-start finds a parent in another repository there, not a local ledger of its slug', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const child = worktree(h, main, path.join(h, 'child'));
  const other = checkout(h, 'app');
  const ledger = ledgerIn(h, child, familyLedger('child', [`- parent: epic @ ${other}`]));
  ledgerIn(h, worktree(h, main, path.join(h, 'epic')), familyLedger('epic', [], '## Children\n- child\n\n## Next step\nA step.\n'));
  ledgerIn(h, worktree(h, other, path.join(other, '.claude/worktrees/epic')), familyLedger('epic', ['- status: blocked 2026-10-02 — waiting on the app team']));

  // The local epic lists the child and would add a Then line; only the epic of the other repository is blocked.
  assert.equal(
    (await sessionStart(h, child)).additionalContext,
    [reportHead(ledger), 'Needs you:', '- Blocked: epic — waiting on the app team', 'Where: epic › **child**', 'Next: A step.'].join('\n'),
  );
});

test('session-start names a parent in a repository that is gone', async (t) => {
  const h = home(t);
  const child = worktree(h, checkout(h, 'main'), path.join(h, 'child'));
  const other = path.join(h, 'elsewhere/app');
  const ledger = ledgerIn(h, child, familyLedger('child', [`- parent: epic @ ${other}`]));

  assert.equal((await sessionStart(h, child)).additionalContext, childReport(ledger, 'Where: epic › **child**', 'Next: A step.'));
});

test('session-start runs no git in another repository that tasks name, so one whose git does not answer costs nothing', (t) => {
  const h = home(t);
  const child = worktree(h, checkout(h, 'main'), path.join(h, 'child'));
  const slow = path.join(h, 'slow/app');
  const parts = ['part-a', 'part-b', 'part-c', 'part-d'];
  const ledger = ledgerIn(h, child, familyLedger('child', [`- parent: epic @ ${slow}`], `## Children\n${parts.map((part) => `- ${part} @ ${slow}\n`).join('')}\n## Next step\nA step.\n`));

  const { ran, took, hung } = sessionStartWithHangingGit(h, child, slow);

  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(took < HOOK_MS + 4_000, `took ${took} ms`);
  assert.equal(hung.length, 0, `git hung for: ${hung.join(' | ')}`);
  assert.equal((JSON.parse(ran.stdout) as SessionStartOutput).hookSpecificOutput.additionalContext, childReport(ledger, 'Where: epic › **child**', 'Next: A step.'));
});

test('session-start runs no git in another repository, also when tasks name its worktrees', (t) => {
  const h = home(t);
  const child = worktree(h, checkout(h, 'main'), path.join(h, 'child'));
  const slow = path.join(h, 'slow/app');
  const worktreeOf = (name: string): string => path.join(slow, '.claude/worktrees', name);
  const children = `## Children\n- part-a @ ${slow}\n- part-b @ ${worktreeOf('part-b')}\n\n## Next step\nA step.\n`;
  const ledger = ledgerIn(h, child, familyLedger('child', [`- parent: epic @ ${worktreeOf('epic')}`], children));

  const { ran, took, hung } = sessionStartWithHangingGit(h, child, slow);

  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(took < HOOK_MS + 4_000, `took ${took} ms`);
  assert.equal(hung.length, 0, `git hung for: ${hung.join(' | ')}`);
  assert.equal((JSON.parse(ran.stdout) as SessionStartOutput).hookSpecificOutput.additionalContext, childReport(ledger, 'Where: epic › **child**', 'Next: A step.'));
});

test('session-start finds a parent in another repository from the store alone, with no git call there', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const slow = checkout(h, 'slow/app');
  const child = worktree(h, main, path.join(h, 'child'));
  const ledger = ledgerIn(h, child, familyLedger('child', [`- parent: epic @ ${slow}`]));
  const epic = familyLedger('epic', ['- status: blocked 2026-10-02 — waiting on the app team'], `## Children\n- child @ ${main}\n\n## Next step\nA step.\n`);
  ledgerIn(h, worktree(h, slow, path.join(slow, '.claude/worktrees/epic')), epic);

  const { ran, took, hung } = sessionStartWithHangingGit(h, child, slow);

  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(took < HOOK_MS + 4_000, `took ${took} ms`);
  assert.equal(hung.length, 0, `git hung for: ${hung.join(' | ')}`);
  assert.equal(
    (JSON.parse(ran.stdout) as SessionStartOutput).hookSpecificOutput.additionalContext,
    [reportHead(ledger), 'Needs you:', '- Blocked: epic — waiting on the app team', 'Where: epic › **child**', 'Next: A step.', 'Then: last child: the parent finalizes next'].join('\n'),
  );
});

test('session-start checks the PRs of a tree whose root is in another repository, with no git call there', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const slow = checkout(h, 'slow/app');
  const own = waitingTask(h, main, 'own', 1, `- parent: epic @ ${slow}`);
  waitingTask(h, main, 'sib', 2, `- parent: epic @ ${slow}`);
  ledgerIn(h, worktree(h, slow, path.join(slow, '.claude/worktrees/epic')), familyLedger('epic', [], `## Children\n- own @ ${main}\n- sib @ ${main}\n\n## Next step\nA step.\n`));
  const readyPr = { json: open([checkRun('SUCCESS')], 'APPROVED') };
  const { env } = stubPrs(h, { [prUrl(1)]: readyPr, [prUrl(2)]: readyPr });

  const { ran, hung } = sessionStartWithHangingGit(h, own.folder, slow, env.PATH);

  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(hung.length, 0, `git hung for: ${hung.join(' | ')}`);
  const context = (JSON.parse(ran.stdout) as SessionStartOutput).hookSpecificOutput.additionalContext;
  assert.deepEqual(needsYou(context), [readyItem('own'), readyItem('sib')], context);
});

test('session-start reads the other tasks from the store alone: no git call in their folders or in their other repository', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const app = checkout(h, 'app');
  const task = (repo: string, name: string, text?: string): string => {
    const folder = worktree(h, repo, path.join(h, name));
    ledgerIn(h, folder, text);
    return folder;
  };
  const epic = task(main, 'epic', familyLedger('epic', [], '## Children\n- child\n- sibling\n\n## Next step\nA step.\n'));
  const child = task(main, 'child', familyLedger('child', ['- parent: epic']));
  const others = [epic, task(main, 'sibling', familyLedger('sibling', ['- parent: epic'])), task(main, 'solo-a'), task(main, 'solo-b')];
  const foreign = [app, task(app, 'app-a'), task(app, 'app-b'), task(app, 'app-c')];

  for (const cwd of [child, main]) {
    const calls = await sessionStartGitCalls(h, cwd);
    const stray = calls.filter((call) => [...others, ...foreign].some((folder) => call.startsWith(`-C ${folder} `)));
    assert.deepEqual(stray, [], `${cwd}:\n${calls.join('\n')}`);
  }
});

/** The arguments of each git call of one session-start in `cwd`. */
async function sessionStartGitCalls(h: string, cwd: string): Promise<string[]> {
  const stubs = path.join(h, 'logging-git');
  const calls = path.join(h, 'logging-git-calls');
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  mkdirSync(stubs, { recursive: true });
  writeFileSync(path.join(stubs, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  writeFileSync(calls, '');
  const ran = await runHook(h, 'session-start', JSON.stringify({ cwd }), { PATH: `${stubs}${path.delimiter}${process.env.PATH ?? ''}` });
  assert.equal(ran.status, 0, ran.stderr);
  return readFileSync(calls, 'utf8').split('\n').filter(Boolean);
}

/**
 * session-start with a git that hangs for any folder in `slow`; the test gives up after 20 s, so a hook without a limit
 * fails, not hangs. `hung` is the arguments of each git call that hung.
 */
function sessionStartWithHangingGit(h: string, cwd: string, slow: string, searchPath = process.env.PATH ?? ''): { ran: Ran; took: number; hung: string[] } {
  const stubs = path.join(h, 'hanging-git');
  const calls = path.join(h, 'hanging-git-calls');
  mkdirSync(stubs);
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path.join(stubs, 'git'), `#!/bin/sh\nfor arg in "$@"; do case "$arg" in '${slow}'*) printf '%s\\n' "$*" >> '${calls}'; exec sleep 30 ;; esac; done\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const started = Date.now();
  const ran = spawnHook(h, 'session-start', JSON.stringify({ cwd }), { PATH: `${stubs}${path.delimiter}${searchPath}`, ...shortLimits({ hookMs: HOOK_MS }) }, 20_000);
  const took = Date.now() - started;
  return { ran, took, hung: existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [] };
}

test('session-start lists siblings in another repository with their status there', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const lib = checkout(h, 'lib');
  const children = `## Children\n- child-a\n- child-a @ ${lib}\n- begun @ ${lib} (started 2026-10-20)\n- old @ ${lib} (retired 2026-10-01)\n- gone @ ${lib}\n\n## Next step\nA step.\n`;
  ledgerIn(h, worktree(h, main, path.join(h, 'epic')), familyLedger('epic', [], children).replace(/\n/g, '\r\n'));
  const childA = worktree(h, main, path.join(h, 'child-a'));
  const ledger = ledgerIn(h, childA, familyLedger('child-a', ['- parent: epic']));
  backlogLedger(h, 'main', 'begun', main);
  backlogLedger(h, 'lib', 'child-a', lib);
  ledgerIn(h, worktree(h, lib, path.join(h, 'lib-begun')), familyLedger('begun', [`- parent: epic @ ${main}`]));
  archiveCopy(h, 'lib', '2026-10-01-old', familyLedger('old', [`- main: ${lib}`, `- worktree: ${path.join(lib, '.claude/worktrees/old')}`, `- parent: epic @ ${main}`]));

  assert.equal(
    (await sessionStart(h, childA)).additionalContext,
    childReport(ledger, 'Where: epic › **child-a**', 'Siblings: child-a backlog, begun active', 'Next: A step.', 'Then: child-a (backlog)'),
  );
});

test('session-start finds a parent in this repository\'s backlog', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const child = worktree(h, main, path.join(h, 'child'));
  const ledger = ledgerIn(h, child, familyLedger('child', ['- parent: epic']));
  backlogLedger(h, 'main', 'epic', main, ['- parent: root']);
  backlogLedger(h, 'main', 'root', main);

  assert.equal((await sessionStart(h, child)).additionalContext, childReport(ledger, 'Where: root › epic › **child**', 'Next: A step.'));
});

test('session-start counts a backlog child as open, but not one of another repository with the same folder name', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(h, worktree(h, main, path.join(h, 'epic')), familyLedger('epic', [], '## Children\n- idea\n- foreign\n\n## Next step\nA step.\n'));
  backlogLedger(h, 'main', 'idea', main, ['- parent: epic']);
  backlogLedger(h, 'elsewhere/main', 'foreign', path.join(h, 'elsewhere/main'), ['- parent: epic']);

  assert.equal((await sessionStart(h, main)).additionalContext, treesText('- epic active — 1 open child'));
});

test('session-start reads only the Location parent bullet', async (t) => {
  const h = home(t);
  const sibling = worktree(h, checkout(h, 'main'), path.join(h, 'sibling'));
  const ledger = ledgerIn(h, sibling, familyLedger('sibling', ['- parent: <slug>'], '## Children (old)\n- child-a\n\n## Notes\n- parent: epic\n'));

  assert.equal((await sessionStart(h, sibling)).additionalContext, soloReport(ledger, 'none written'));
});

test('session-start lists a backlog task as an open tree once, from its ledger and not from the old task list', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const backlog = path.join(h, '.claude/ledger-backlog', repoFolder(h, 'main'), 'idea.md');
  mkdirSync(path.dirname(backlog), { recursive: true });
  writeFileSync(backlog, `# Task ledger — idea\n\n## Goal\nA backlog goal.\n\n## Location\n- main: ${main}\n`);
  const entry = { repo: main, slug: 'idea', path: backlog, branch: '', status: 'backlog', main, created: '2026-10-01T00:00:00.000Z', updated: '2026-10-01T00:00:00.000Z' };
  writeFileSync(path.join(h, '.claude/ledgers.json'), JSON.stringify([entry]));

  assert.equal((await sessionStart(h, main)).additionalContext, treesText('- idea backlog'));

  ledgerIn(h, worktree(h, main, path.join(h, 'sibling')));
  assert.equal((await sessionStart(h, main)).additionalContext, treesText('- sibling active', '- idea backlog'));
});

test('session-start keeps quotes, backslashes, tabs and non-ASCII text intact', async (t) => {
  const h = home(t);
  const sibling = worktree(h, checkout(h, 'main'), path.join(h, 'sibling'));
  const next = 'Say "hi" \\n then \\ and \ttab — ✓ æøå';
  const ledger = ledgerIn(h, sibling, `# Task ledger — quoted\n\n## Goal\nA goal.\n\n## Next step\n${next}\n`);

  const output = await sessionStart(h, sibling);

  assert.equal(output.sessionTitle, '🔨 quoted');
  assert.equal(output.additionalContext, soloReport(ledger, next));
});

test('pre-compact names the one task by slug and worktree, kept in the store, and writes no task list', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const sibling = worktree(h, main, path.join(h, 'sibling'));
  const ledger = ledgerIn(h, sibling);

  const text = await preCompact(h, main);

  assert.equal(text, `Task ledger sibling (worktree ${sibling}) is kept in the ledger store and is authoritative. Preserve its slug, worktree path and its Next step section verbatim.\n`);
  assert.ok(!text.includes(ledger) && !text.includes('.claude/ledger.md'), text);
  assert.throws(() => readFileSync(path.join(h, '.claude/ledgers.json')), { code: 'ENOENT' });
});

test('pre-compact names several tasks by slug and worktree, most recently updated first, and no ledger path', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const [older, newer, middle] = ['a-older', 'b-newer', 'c-middle'].map((name) => worktree(h, main, path.join(h, name)));
  touch(ledgerIn(h, older), '2026-10-01T00:00:00Z');
  touch(ledgerIn(h, newer), '2026-10-03T00:00:00Z');
  touch(ledgerIn(h, middle), '2026-10-02T00:00:00Z');

  const text = await preCompact(h, main);

  assert.equal(
    text,
    `3 task ledgers exist (most recently updated first), kept in the ledger store. Preserve the slug and worktree of the one this session is working on, and its Next step section verbatim:\nb-newer — ${newer}\nc-middle — ${middle}\na-older — ${older}\n`,
  );
  assert.ok(!text.includes(path.join(h, '.claude')) && !text.includes('.claude/ledger.md'), text);
});

// D20: the session start checks the PR of each waiting task.

const prUrl = (n: number): string => `https://github.com/acme/app/pull/${n}`;

/** `meet`: the answer waits until that many calls wait together, which only calls run at once reach. */
type PrAnswer = { json: object | string; meet?: number } | { exit: number } | { hang: true };

/**
 * A gh first on PATH that answers `gh pr view <url> --json state,reviewDecision,statusCheckRollup` for each url, logs
 * every call to the file `calls`, and fails for anything else. A hanging answer execs sleep, so a kill ends it.
 */
function stubPrs(h: string, answers: Record<string, PrAnswer>): { env: NodeJS.ProcessEnv; calls: string } {
  const stubs = path.join(h, 'pr-stubs');
  const calls = path.join(h, 'gh-calls');
  const meeting = path.join(h, 'gh-meeting');
  mkdirSync(stubs, { recursive: true });
  mkdirSync(meeting, { recursive: true });
  writeFileSync(calls, '');
  const quoted = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;
  const cases = Object.entries(answers).map(([url, answer]) => {
    const body =
      'hang' in answer
        ? 'exec sleep 30'
        : 'exit' in answer
          ? `echo 'HTTP 404: Not Found' >&2; exit ${answer.exit}`
          : `${answer.meet === undefined ? '' : `: > ${quoted(meeting)}/$$; while [ "$(ls ${quoted(meeting)} | wc -l | tr -d ' ')" -lt ${answer.meet} ]; do sleep 0.1; done; `}printf '%s\\n' ${quoted(typeof answer.json === 'string' ? answer.json : JSON.stringify(answer.json))}`;
    return `  ${quoted(`pr view ${url} --json state,reviewDecision,statusCheckRollup`)}) ${body} ;;`;
  });
  writeFileSync(path.join(stubs, 'gh'), ['#!/bin/sh', `echo "$*" >> ${quoted(calls)}`, 'case "$*" in', ...cases, '  *) echo "unexpected gh call" >&2; exit 9 ;;', 'esac', ''].join('\n'), { mode: 0o755 });
  return { env: { PATH: `${stubs}${path.delimiter}${process.env.PATH ?? ''}` }, calls };
}

const checkRun = (conclusion: string, status = 'COMPLETED') => ({ __typename: 'CheckRun', name: 'ci', status, conclusion });
const statusContext = (state: string) => ({ __typename: 'StatusContext', context: 'ci', state });
const open = (statusCheckRollup: object[], reviewDecision: string | null = '') => ({ state: 'OPEN', reviewDecision, statusCheckRollup });

/** A linked worktree `name` of `main` whose active ledger is waiting on PR `pr`, with more Location lines. */
function waitingTask(h: string, main: string, name: string, pr: number | undefined, ...location: string[]): { folder: string; ledger: string } {
  const folder = worktree(h, main, path.join(h, name));
  const ledger = ledgerIn(h, folder, familyLedger(name, ['- status: waiting 2026-11-20', ...(pr === undefined ? [] : [`- pr: ${prUrl(pr)}`]), ...location]));
  return { folder, ledger };
}

const startupInput = (cwd: string): string => JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd });

const startedWith = async (h: string, cwd: string, env: NodeJS.ProcessEnv, clock?: Clock): Promise<string> => startedContext(await runHook(h, 'session-start', startupInput(cwd), env, clock));

/** The report of a session-start that ran as `ran`, which exited 0 and printed nothing on stderr. */
function startedContext(ran: Ran): string {
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stderr, '');
  return (JSON.parse(ran.stdout) as SessionStartOutput).hookSpecificOutput.additionalContext;
}

/** The items of the report's one Needs you section, in any order; undefined when it says nothing needs the operator or is not there. */
function needsYou(context: string): string[] | undefined {
  const lines = context.split('\n');
  const sections = lines.flatMap((line, index) => (line.startsWith('Needs you') ? [index] : []));
  assert.ok(sections.length <= 1, context);
  const [at] = sections;
  if (at === undefined || lines[at] === 'Needs you: nothing.') return undefined;
  const end = lines.findIndex((line, index) => index > at && !line.startsWith('- '));
  return lines.slice(at + 1, end === -1 ? undefined : end).sort();
}

const readyItem = (slug: string): string => `- ${slug}: PR checks and review passed; ready to merge. Ask the question from \`ledger task gate merge ${slug}\`.`;

const storedLocation = (ledger: string) => parseLedger(readLedgerFile(ledger)).location;
const storedStage = (ledger: string): string | undefined => (JSON.parse(readFileSync(ledger, 'utf8')) as { stage?: string }).stage;

test('session-start in a main checkout checks the PR of every waiting task of the repo and says what needs the operator first', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const answers: Record<string, PrAnswer> = {};
  const task = (name: string, n: number, answer: PrAnswer, ...location: string[]) => {
    answers[prUrl(n)] = answer;
    return waitingTask(h, main, name, n, ...location).ledger;
  };
  const merged = task('merged', 1, { json: { state: 'MERGED', reviewDecision: 'APPROVED', statusCheckRollup: [checkRun('SUCCESS')] } });
  const failing = task('failing', 2, { json: open([checkRun('SUCCESS'), checkRun('FAILURE')]) }, '- stage: pr');
  const changes = task('changes', 3, { json: open([checkRun('SUCCESS')], 'CHANGES_REQUESTED') }, '- stage: pr');
  const both = task('both', 4, { json: open([statusContext('ERROR')], 'CHANGES_REQUESTED') }, '- stage: pr');
  const ready = task('ready', 5, { json: open([checkRun('SUCCESS'), statusContext('SUCCESS')], null) });
  const closed = task('closed', 6, { json: { state: 'CLOSED', reviewDecision: '', statusCheckRollup: [] } });
  const pending = task('pending', 7, { json: open([checkRun('SUCCESS'), checkRun('', 'IN_PROGRESS')]) });
  task('broken', 8, { exit: 1 });
  task('garbage', 9, { json: 'not json' });
  task('no-state', 10, { json: { reviewDecision: '' } });
  const { env, calls } = stubPrs(h, answers);
  const unlinked = waitingTask(h, main, 'unlinked', undefined).ledger;
  ledgerIn(h, worktree(h, main, path.join(h, 'plain')), familyLedger('plain', [`- pr: ${prUrl(30)}`]));
  rmSync(waitingTask(h, main, 'far', 31).folder, { recursive: true });
  const [pendingBefore, closedBefore, readyBefore, unlinkedBefore] = [pending, closed, ready, unlinked].map(readLedgerFile);

  const clock = fakeClock('2026-11-26T12:00:00');

  const context = await startedWith(h, main, env, clock);

  assert.deepEqual(needsYou(context), [
    '- both: PR checks failed and review asked for changes; the task is back at build.',
    '- broken: could not check the PR (gh pr view failed (exit 1): HTTP 404: Not Found).',
    '- changes: PR review asked for changes; the task is back at build.',
    '- closed: PR closed without merging.',
    '- failing: PR checks failed; the task is back at build.',
    '- garbage: could not check the PR (gh pr view printed no PR state).',
    '- merged: PR merged; the task is done. Finalize it with the question from `ledger task gate finalize merged`.',
    '- no-state: could not check the PR (gh pr view printed no PR state).',
    readyItem('ready'),
  ]);
  assert.match(context, /^Needs you:\n(- .*\n){9}Open task trees in this repo:\n/);
  assert.deepEqual(storedLocation(merged).status, { value: 'done', date: clock.today() });
  for (const ledger of [failing, changes, both]) {
    assert.equal(storedLocation(ledger).status, undefined, ledger);
    assert.equal(storedStage(ledger), 'build', ledger);
  }
  assert.deepEqual([pending, closed, ready, unlinked].map(readLedgerFile), [pendingBefore, closedBefore, readyBefore, unlinkedBefore]);
  const asked = readFileSync(calls, 'utf8').trim().split('\n').sort();
  assert.equal(asked.length, Object.keys(answers).length, asked.join('\n'));
  assert.ok(!asked.some((call) => call.includes(prUrl(30)) || call.includes(prUrl(31))), asked.join('\n'));
});

test('session-start in a task checks the waiting tasks of its tree only: its root, every descendant and itself', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const backlog = (slug: string, location: string[], children: string[]): void => {
    const ledger = path.join(h, '.claude/ledger-backlog', repoFolder(h, 'app'), `${slug}.md`);
    mkdirSync(path.dirname(ledger), { recursive: true });
    writeFileSync(ledger, familyLedger(slug, [`- main: ${main}`, '- worktree: <path>', ...location], `## Children\n${children.map((child) => `- ${child}\n`).join('')}\n## Next step\nA step.\n`));
  };
  backlog('epic', [], ['a', 'b']);
  backlog('b', ['- parent: epic'], ['g']);
  const readyPr = { json: open([checkRun('SUCCESS')], 'APPROVED') };
  const a = waitingTask(h, main, 'a', 1, '- parent: epic');
  waitingTask(h, main, 'g', 2, '- parent: b');
  waitingTask(h, main, 'c', 3);
  const { env, calls } = stubPrs(h, { [prUrl(1)]: readyPr, [prUrl(2)]: readyPr, [prUrl(3)]: readyPr });

  const context = await startedWith(h, a.folder, env);

  assert.deepEqual(needsYou(context), [readyItem('a'), readyItem('g')]);
  assert.ok(!readFileSync(calls, 'utf8').includes(prUrl(3)));
  assert.ok(context.startsWith(`${reportHead(a.ledger, 'waiting, stage plan (code)')}\nNeeds you:\n`), context);
});

test('session-start asks gh about every PR at once, and counts a call not done in 3 s as an error', (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const together = { json: open([checkRun('SUCCESS')], 'APPROVED'), meet: 2 };
  for (const [name, n] of [['one', 1], ['two', 2], ['hangs', 3]] as const) waitingTask(h, main, name, n);
  const { env } = stubPrs(h, { [prUrl(1)]: together, [prUrl(2)]: together, [prUrl(3)]: { hang: true } });
  const started = Date.now();

  const context = startedContext(spawnHook(h, 'session-start', startupInput(main), { ...env, ...shortLimits({ prCheckMs: 1500 }) }, 30_000));

  assert.ok(Date.now() - started < 1500 + 22_000, `took ${Date.now() - started} ms; the hung gh sleeps 30 s`);
  assert.deepEqual(needsYou(context), [
    '- hangs: could not check the PR (gh did not answer in 1.5 s).',
    readyItem('one'),
    readyItem('two'),
  ]);
});

test('session-start adds no Needs you block when no PR needs the operator, and leaves the rest of its text as it was', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const { folder, ledger } = waitingTask(h, main, 'quiet', 1);
  const { env, calls } = stubPrs(h, { [prUrl(1)]: { json: open([checkRun('', 'QUEUED')]) } });

  const context = await startedWith(h, folder, env);

  assert.equal(needsYou(context), undefined);
  assert.equal(context, [reportHead(ledger, 'waiting, stage plan (code)'), 'Needs you: nothing.', 'Where: **quiet** (no parent)', 'Next: A step.'].join('\n'));
  assert.equal(readFileSync(calls, 'utf8'), `pr view ${prUrl(1)} --json state,reviewDecision,statusCheckRollup\n`);
});

test('session-start in a task lists what the PR check found in the report\'s one Needs you section, within 20 lines', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const kids = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'];
  const epic = path.join(h, '.claude/ledger-backlog', repoFolder(h, 'app'), 'epic.md');
  mkdirSync(path.dirname(epic), { recursive: true });
  writeFileSync(epic, familyLedger('epic', [`- main: ${main}`, '- worktree: <path>'], `## Children\n${['own', ...kids].map((kid) => `- ${kid}\n`).join('')}\n## Next step\nA step.\n`));
  const readyPr = { json: open([checkRun('SUCCESS')], 'APPROVED') };
  const own = waitingTask(h, main, 'own', 1, '- parent: epic');
  kids.forEach((kid, index) => waitingTask(h, main, kid, index + 2, '- parent: epic'));
  const { env } = stubPrs(h, Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [prUrl(n), readyPr])));

  const lines = (await startedWith(h, own.folder, env)).split('\n');

  assert.ok(lines.length <= 20, lines.join('\n'));
  assert.deepEqual(lines.slice(0, 3), [reportHead(own.ledger, 'waiting, stage plan (code)'), 'Needs you:', readyItem('own')]);
  assert.equal(lines.filter((line) => line.startsWith('Needs you')).length, 1, lines.join('\n'));
  assert.equal(lines[7], '- +2 more');
  assert.equal(lines[8], 'Where: epic › **own**');
});

test('session-start in a main checkout lists what the PR check found above the open trees, in one Needs you section within 20 lines', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const names = Array.from({ length: 16 }, (_, index) => `wait-${String(index).padStart(2, '0')}`);
  names.forEach((name, index) => waitingTask(h, main, name, index + 1));
  const readyPr = { json: open([checkRun('SUCCESS')], 'APPROVED') };
  const { env } = stubPrs(h, Object.fromEntries(names.map((_, index) => [prUrl(index + 1), readyPr])));

  const lines = (await startedWith(h, main, env)).split('\n');

  assert.equal(lines.length, 20, lines.join('\n'));
  assert.equal(lines[0], 'Needs you:');
  assert.equal(lines.filter((line) => line.startsWith('Needs you')).length, 1, lines.join('\n'));
  assert.deepEqual(lines.slice(15, 18), ['- +2 more', 'Open task trees in this repo:', '- wait-00 waiting']);
  assert.match(lines[18], /^- \+15 more — `ledger list`$/);
  assert.match(lines[19], /^Ask the operator in one question widget: /);
});

test('session-start never asks gh about a waiting task of another machine, in a main checkout and in a task of its tree', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const here = waitingTask(h, main, 'here', 1, '- parent: away');
  waitingTask(h, main, 'away', 2, '- host: other-mac');
  const { env, calls } = stubPrs(h, { [prUrl(1)]: { json: open([checkRun('SUCCESS')], 'APPROVED') } });

  for (const cwd of [main, here.folder]) {
    writeFileSync(calls, '');
    assert.deepEqual(needsYou(await startedWith(h, cwd, env)), [readyItem('here')], cwd);
    assert.equal(readFileSync(calls, 'utf8'), `pr view ${prUrl(1)} --json state,reviewDecision,statusCheckRollup\n`, cwd);
  }
});

const mergedPr = { json: { state: 'MERGED', reviewDecision: 'APPROVED', statusCheckRollup: [] } };

test('session-start in a task reports from the store after the PR check: a just-merged task is done, and named once', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const own = waitingTask(h, main, 'own', 1);
  const { env } = stubPrs(h, { [prUrl(1)]: mergedPr });

  const lines = (await startedWith(h, own.folder, env)).split('\n');

  assert.match(lines[0], /^Task own in \S+ — done, /);
  assert.deepEqual(lines.slice(1), [
    'Needs you:',
    '- own: PR merged; the task is done. Finalize it with the question from `ledger task gate finalize own`.',
    'Where: **own** (no parent)',
    'Next: A step.',
  ]);
});

test('session-start in a task whose PR another session marked done meanwhile still asks to finalize it', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const own = waitingTask(h, main, 'own', 1);
  const done = path.join(h, 'done.json');
  writeFileSync(done, recordJson({ ...parseRecord(familyLedger('own', ['- status: done 2026-11-21', `- pr: ${prUrl(1)}`])), worktree: own.folder }));
  const stubs = path.join(h, 'racing-gh');
  mkdirSync(stubs);
  writeFileSync(path.join(stubs, 'gh'), `#!/bin/sh\ncp '${done}' '${own.ledger}'\nprintf '%s\\n' '${JSON.stringify(mergedPr.json)}'\n`, { mode: 0o755 });

  const lines = (await startedWith(h, own.folder, { PATH: `${stubs}${path.delimiter}${process.env.PATH ?? ''}` })).split('\n');

  assert.match(lines[0], /^Task own in \S+ — done, /);
  assert.deepEqual(lines.slice(1, 3), ['Needs you:', '- PR merged: own — finalize with the question from `ledger task gate finalize own`']);
});

test('session-start in a main checkout lists a just-merged task as done in its tree, not as waiting', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  waitingTask(h, main, 'merged', 1);
  const { env } = stubPrs(h, { [prUrl(1)]: mergedPr });

  const lines = (await startedWith(h, main, env)).split('\n');

  assert.ok(lines.includes('- merged done'), lines.join('\n'));
});

test('session-start in a task names a just-merged task of another repo for finalize by its slug and main checkout', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const api = checkout(h, 'api');
  const own = waitingTask(h, main, 'own', 1, `- parent: epic @ ${api}`);
  ledgerIn(h, worktree(h, api, path.join(api, '.claude/worktrees/epic')), familyLedger('epic', [], `## Children\n- own @ ${main}\n- sib\n\n## Next step\nA step.\n`));
  ledgerIn(h, worktree(h, api, path.join(api, '.claude/worktrees/sib')), familyLedger('sib', ['- status: waiting 2026-11-20', `- pr: ${prUrl(2)}`, '- parent: epic']));
  const { env } = stubPrs(h, { [prUrl(1)]: { json: open([checkRun('', 'QUEUED')]) }, [prUrl(2)]: mergedPr });

  const context = await startedWith(h, own.folder, env);

  assert.deepEqual(needsYou(context), [`- sib: PR merged; the task is done. Finalize it with the question from \`ledger task gate finalize sib@${api}\`.`], context);
});

test('session-start in a task names a ready PR of another repo for the merge gate by its slug and main checkout', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const api = checkout(h, 'api');
  const own = waitingTask(h, main, 'own', 1, `- parent: epic @ ${api}`);
  ledgerIn(h, worktree(h, api, path.join(api, '.claude/worktrees/epic')), familyLedger('epic', [], `## Children\n- own @ ${main}\n- sib\n\n## Next step\nA step.\n`));
  ledgerIn(h, worktree(h, api, path.join(api, '.claude/worktrees/sib')), familyLedger('sib', ['- status: waiting 2026-11-20', `- pr: ${prUrl(2)}`, '- parent: epic']));
  const { env } = stubPrs(h, { [prUrl(1)]: { json: open([checkRun('', 'QUEUED')]) }, [prUrl(2)]: { json: open([checkRun('SUCCESS')], 'APPROVED') } });

  const context = await startedWith(h, own.folder, env);

  assert.deepEqual(needsYou(context), [`- sib: PR checks and review passed; ready to merge. Ask the question from \`ledger task gate merge sib@${api}\`.`], context);
});

test('session-start never asks gh about a waiting task whose worktree folder is now a plain folder with no .git', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const { folder } = waitingTask(h, main, 'stale', 1);
  rmSync(folder, { recursive: true });
  mkdirSync(folder);
  const { env, calls } = stubPrs(h, { [prUrl(1)]: mergedPr });

  await startedWith(h, main, env);

  assert.equal(readFileSync(calls, 'utf8'), '');
});

test('session-start in a task lists what the PR check found before the open questions, so five questions never hide it', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const questions = Array.from({ length: 5 }, (_, index) => `- Question number ${index + 1}?`);
  const folder = worktree(h, main, path.join(h, 'own'));
  ledgerIn(h, folder, familyLedger('own', ['- status: waiting 2026-11-20', `- pr: ${prUrl(1)}`], `## Open questions\n${questions.join('\n')}\n\n## Next step\nA step.\n`));
  const { env } = stubPrs(h, { [prUrl(1)]: { json: open([checkRun('FAILURE')]) } });

  const lines = (await startedWith(h, folder, env)).split('\n');

  assert.deepEqual(lines.slice(1, 4), ['Needs you:', '- own: PR checks failed; the task is back at build.', '- Question 1: Question number 1?']);
  assert.equal(lines[7], '- +1 more');
});

test('session-start runs no gh when no task is waiting, in a main checkout and in a task', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const plain = worktree(h, main, path.join(h, 'plain'));
  ledgerIn(h, plain, familyLedger('plain', [`- pr: ${prUrl(1)}`]));
  const { env, calls } = stubPrs(h, {});

  for (const cwd of [main, plain]) {
    assert.equal(needsYou(await startedWith(h, cwd, env)), undefined, cwd);
    assert.equal(readFileSync(calls, 'utf8'), '', cwd);
  }
});

test('session-start says it could not check a PR when gh is not installed', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  waitingTask(h, main, 'lone', 1);
  const bin = path.join(h, 'no-gh');
  mkdirSync(bin);
  for (const tool of ['git', 'node']) symlinkSync(spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim(), path.join(bin, tool));

  const context = await startedWith(h, main, { PATH: bin });

  assert.deepEqual(needsYou(context), ['- lone: could not check the PR (gh did not run: spawn gh ENOENT).']);
});

test('session-start says it could not update a task whose PR is merged when the write fails, and leaves the task as it was', async (t) => {
  const h = home(t);
  const main = checkout(h, 'app');
  const { ledger } = waitingTask(h, main, 'stuck', 1);
  const { env } = stubPrs(h, { [prUrl(1)]: { json: { state: 'MERGED', reviewDecision: '', statusCheckRollup: [] } } });
  const before = readLedgerFile(ledger);
  chmodSync(path.dirname(ledger), 0o555);

  const context = await (async () => {
    try {
      return await startedWith(h, main, env);
    } finally {
      chmodSync(path.dirname(ledger), 0o755);
    }
  })();

  const lines = needsYou(context) ?? [];
  assert.equal(lines.length, 1, context);
  assert.match(lines[0], /^- stuck: could not update the task \(.+\)\.$/);
  assert.equal(readLedgerFile(ledger), before);
});

// UserPromptSubmit

type PromptSubmitInput = { prompt: string; cwd?: string; session_id?: string; session_title?: string };

const promptSubmit = (h: string, input: PromptSubmitInput): Promise<string> => hook(h, 'prompt-submit', { hook_event_name: 'UserPromptSubmit', ...input });

async function promptSubmitTitle(h: string, input: PromptSubmitInput): Promise<string> {
  const output = JSON.parse(await promptSubmit(h, input)) as { hookSpecificOutput: { hookEventName: string; sessionTitle: string } };
  assert.deepEqual(Object.keys(output.hookSpecificOutput).sort(), ['hookEventName', 'sessionTitle']);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  return output.hookSpecificOutput.sessionTitle;
}

const archive = (h: string, repo: string, slug: string): string => archiveCopy(h, repo, `2026-10-01-${slug}`, `# Task ledger — ${slug}\n`);

test('prompt-submit titles an untitled session in the main checkout with the slug from go', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(h, worktree(h, main, path.join(h, 'alpha')));

  assert.equal(await promptSubmitTitle(h, { prompt: 'go alpha', cwd: main }), '🔨 alpha');
});

test('prompt-submit replaces the title of another worktree\'s task', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const alpha = worktree(h, main, path.join(h, 'alpha'));
  ledgerIn(h, alpha);
  ledgerIn(h, worktree(h, main, path.join(main, '.claude/worktrees/beta')));

  assert.equal(await promptSubmitTitle(h, { prompt: '  go beta\n', cwd: alpha, session_title: 'alpha' }), '🔨 beta');
});

test('prompt-submit replaces a title that names an archived task', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(h, worktree(h, main, path.join(h, 'alpha')));
  archive(h, 'main', 'finished-task');

  assert.equal(await promptSubmitTitle(h, { prompt: 'go alpha', cwd: main, session_title: 'finished-task' }), '🔨 alpha');
});

test('prompt-submit replaces a title that names an archived task of another repository', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(h, worktree(h, main, path.join(h, 'alpha')));
  archive(h, 'other', 'finished-task');

  assert.equal(await promptSubmitTitle(h, { prompt: 'go alpha', cwd: main, session_title: 'finished-task' }), '🔨 alpha');
});

test('prompt-submit keeps a title the operator chose while the session stays on the task it claims', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(h, worktree(h, main, path.join(h, 'alpha')), familyLedger('alpha', ['- claim: session s1 since 2026-11-20T10:00:00Z, active 2026-11-20T10:00:00Z']));

  assert.equal(await promptSubmit(h, { prompt: 'go alpha', cwd: main, session_id: 's1', session_title: 'my custom name' }), '');
  assert.equal(await promptSubmitTitle(h, { prompt: 'go alpha', cwd: main, session_id: 's2', session_title: 'my custom name' }), '🔨 alpha');
});

test('prompt-submit keeps a title the operator chose when the session claims the task among other claims', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const claim = ['- claim: session s1 since 2026-11-20T10:00:00Z, active 2026-11-20T10:00:00Z'];
  ledgerIn(h, worktree(h, main, path.join(h, 'alpha')), familyLedger('alpha', claim));
  ledgerIn(h, worktree(h, main, path.join(h, 'beta')), familyLedger('beta', claim));

  assert.equal(await promptSubmit(h, { prompt: 'go beta', cwd: main, session_id: 's1', session_title: 'my custom name' }), '');
});

test('prompt-submit prints nothing when the title already names the task', async (t) => {
  const h = home(t);
  const alpha = worktree(h, checkout(h, 'main'), path.join(h, 'alpha'));
  ledgerIn(h, alpha);

  assert.equal(await promptSubmit(h, { prompt: 'go alpha', cwd: alpha, session_title: '🔨 alpha' }), '');
});

test('D43: prompt-submit titles go <slug> with the task\'s state icon, and replaces a title of the same slug with another icon', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const alpha = worktree(h, main, path.join(h, 'alpha'));
  ledgerIn(h, alpha, familyLedger('alpha', ['- stage: review']));

  assert.equal(await promptSubmitTitle(h, { prompt: 'go alpha', cwd: main }), '🔍 alpha');
  assert.equal(await promptSubmitTitle(h, { prompt: 'go alpha', cwd: main, session_title: 'alpha' }), '🔍 alpha');
  assert.equal(await promptSubmitTitle(h, { prompt: 'go alpha', cwd: main, session_title: '🔨 alpha' }), '🔍 alpha');
  assert.equal(await promptSubmit(h, { prompt: 'go alpha', cwd: main, session_title: '🔍 alpha' }), '');
});

test('prompt-submit prints nothing for a slug with no active ledger', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(h, worktree(h, main, path.join(h, 'alpha')));
  archive(h, 'main', 'finished-task');

  assert.equal(await promptSubmit(h, { prompt: 'go unknown', cwd: main }), '');
  assert.equal(await promptSubmit(h, { prompt: 'go finished-task', cwd: main }), '');
});

test('prompt-submit prints nothing unless the prompt is exactly go and one slug', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(h, worktree(h, main, path.join(h, 'alpha')));

  for (const prompt of ['go', 'go ', 'go alpha beta', 'please go alpha', 'go alpha\nand more', 'Go alpha', 'goalpha', 'go\nalpha']) {
    assert.equal(await promptSubmit(h, { prompt, cwd: main }), '', JSON.stringify(prompt));
  }
});

test('prompt-submit prints nothing outside a git repository', async (t) => {
  const h = home(t);
  const plain = path.join(h, 'plain');
  ledgerIn(h, plain, '# Task ledger — alpha\n');
  ledgerIn(h, path.join(plain, '.claude/worktrees/alpha'), '# Task ledger — alpha\n');

  assert.equal(await promptSubmit(h, { prompt: 'go alpha', cwd: plain }), '');
});

test('prompt-submit skips a worktree whose folder is gone', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(h, worktree(h, main, path.join(h, 'alpha')));
  rmSync(worktree(h, main, path.join(h, 'gone')), { recursive: true, force: true });

  assert.equal(await promptSubmitTitle(h, { prompt: 'go alpha', cwd: main }), '🔨 alpha');
});

// D43: the session name follows the task at every task change.

test('D43: prompt-submit after a clear replaces the slug of the previous task, from the main checkout and from the new worktree', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(h, worktree(h, main, path.join(main, '.claude/worktrees/alpha')));
  const beta = worktree(h, main, path.join(main, '.claude/worktrees/beta'));
  ledgerIn(h, beta);

  assert.equal(await promptSubmitTitle(h, { prompt: 'go beta', cwd: main, session_title: 'alpha' }), '🔨 beta');
  assert.equal(await promptSubmitTitle(h, { prompt: 'go beta', cwd: beta, session_title: 'alpha' }), '🔨 beta');
});

test('D43: prompt-submit replaces the slug of a previous task in another repository', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(h, worktree(h, main, path.join(main, '.claude/worktrees/beta')));
  const other = checkout(h, 'other');
  ledgerIn(h, worktree(h, other, path.join(other, '.claude/worktrees/alpha')));

  assert.equal(await promptSubmitTitle(h, { prompt: 'go beta', cwd: main, session_title: 'alpha' }), '🔨 beta');
});

test('D43: prompt-submit replaces the slug of a previous task that is in the backlog', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(h, worktree(h, main, path.join(main, '.claude/worktrees/beta')));
  backlogLedger(h, 'main', 'umbrella', main);

  assert.equal(await promptSubmitTitle(h, { prompt: 'go beta', cwd: main, session_title: 'umbrella' }), '🔨 beta');
});

test('D43: session-start after a clear titles the session with the slug of the worktree it is in', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const beta = worktree(h, main, path.join(main, '.claude/worktrees/beta'));
  ledgerIn(h, beta);

  const output = JSON.parse(await hook(h, 'session-start', { hook_event_name: 'SessionStart', source: 'clear', cwd: beta })) as SessionStartOutput;

  assert.equal(output.hookSpecificOutput.sessionTitle, '🔨 beta');
});

// PreToolUse: the ledger gate

const BIN = LEDGER_BIN;

/** One main checkout with a linked worktree inside it, shared by the gate tests that only read. */
const gateWorld = { h: '', main: '', worktree: '', plain: '' };

before(() => {
  const h = realpathSync(mkdtempSync(path.join(tmpdir(), 'ledger-hooks-gate-')));
  mkdirSync(path.join(h, '.claude'));
  const main = checkout(h, 'main');
  const linked = path.join(main, '.claude/worktrees/task');
  git(h, main, 'worktree', 'add', '--quiet', '-b', 'task', linked);
  const plain = path.join(h, 'plain');
  mkdirSync(plain);
  Object.assign(gateWorld, { h, main, worktree: linked, plain });
});

after(() => rmSync(gateWorld.h, { recursive: true, force: true }));

type ToolInput =
  | { file_path: string; content?: string; old_string?: string; new_string?: string; edits?: { old_string: string; new_string: string }[] }
  | { command: string };

const toolUse = (cwd: string, toolName: string, toolInput: ToolInput) => ({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, cwd });

const gate = (cwd: string, toolName: string, toolInput: ToolInput, h = gateWorld.h): Promise<string> => hook(h, 'pre-tool-use', toolUse(cwd, toolName, toolInput));

function assertDenied(stdout: string): string {
  assert.notEqual(stdout, '', 'expected a deny decision, got silence');
  const output = (JSON.parse(stdout) as { hookSpecificOutput: Record<string, string> }).hookSpecificOutput;
  assert.deepEqual(Object.keys(output).sort(), ['hookEventName', 'permissionDecision', 'permissionDecisionReason']);
  assert.equal(output.hookEventName, 'PreToolUse');
  assert.equal(output.permissionDecision, 'deny');
  return output.permissionDecisionReason;
}

function assertAllowed(stdout: string): void {
  assert.equal(stdout, '', `expected silence, got ${stdout}`);
}

const STORE_REASON = `Task ledgers are kept in the ledger store, not in .claude/ledger.md. Read this task's ledger with \`${BIN} show\`. Write one item with \`${BIN} notes <command>\`; \`${BIN} notes --help\` lists them.`;
const UNMOVED_REASON = `${STORE_REASON}\nThis ledger has not been moved yet: run \`${BIN} store migrate --active\`.`;
const HAND_EDIT_REASON = `The ledger store is changed only by the ledger tool, not by hand. Read a task with \`${BIN} show [<slug>]\`. Write one item with \`${BIN} notes <command>\`; \`${BIN} notes --help\` lists them. To move or sync the store, see \`${BIN} store --help\`.`;

const CITATION_REASON =
  `A task ledger may not cite files in the Claude Code session folder or its scratchpad, because macOS deletes them. Move the file to .claude/evidence/ in the task's worktree and cite that path, for example .claude/evidence/xcodebuild-red.log. Read a task with \`${BIN} show [<slug>]\`. Write one item with \`${BIN} notes <command>\`; \`${BIN} notes --help\` lists them.`;

for (const tool of ['Write', 'Edit', 'MultiEdit']) {
  test(`${tool} of .claude/ledger.md in a main checkout is denied, naming ledger show and ledger notes`, async () => {
    assert.equal(assertDenied(await gate(gateWorld.main, tool, { file_path: path.join(gateWorld.main, '.claude/ledger.md') })), STORE_REASON);
  });

  test(`${tool} of .claude/ledger.md in a linked worktree is denied, naming ledger show and ledger notes`, async () => {
    assert.equal(assertDenied(await gate(gateWorld.main, tool, { file_path: path.join(gateWorld.worktree, '.claude/ledger.md') })), STORE_REASON);
  });
}

test('a relative file_path is resolved against the hook cwd', async () => {
  assert.equal(assertDenied(await gate(gateWorld.main, 'Write', { file_path: '.claude/ledger.md' })), STORE_REASON);
  assert.equal(assertDenied(await gate(gateWorld.worktree, 'Write', { file_path: '.claude/ledger.md' })), STORE_REASON);
  assertAllowed(await gate(gateWorld.worktree, 'Write', { file_path: 'ledger.md' }));
});

test('other files in a main checkout are allowed', async () => {
  for (const file of ['.claude/settings.json', 'docs/ledger.md', '.claude/ledger.md.bak', 'ledger.md']) {
    assertAllowed(await gate(gateWorld.main, 'Write', { file_path: path.join(gateWorld.main, file) }));
  }
});

test('reading .claude/ledger.md is allowed, in a main checkout and in a linked worktree', async () => {
  for (const folder of [gateWorld.main, gateWorld.worktree]) {
    assertAllowed(await gate(folder, 'Read', { file_path: path.join(folder, '.claude/ledger.md') }));
    assertAllowed(await gate(folder, 'Bash', { command: 'cat .claude/ledger.md' }));
  }
});

test('.claude/ledger.md outside any git repository is denied too', async () => {
  const { plain } = gateWorld;
  assert.equal(assertDenied(await gate(plain, 'Write', { file_path: path.join(plain, '.claude/ledger.md') })), STORE_REASON);
  assert.equal(assertDenied(await gate(plain, 'Bash', { command: 'echo x > .claude/ledger.md' })), STORE_REASON);
});

test('a Bash write to ledger.md after a cd into .claude in the same command is denied', async () => {
  for (const command of ['cd .claude && echo x > ledger.md', 'cd .claude; tee -a ledger.md < /dev/null', `cd ${gateWorld.worktree}/.claude && cp /dev/null ledger.md`]) {
    assert.equal(assertDenied(await gate(gateWorld.main, 'Bash', { command })), STORE_REASON, command);
  }
  assertAllowed(await gate(gateWorld.main, 'Bash', { command: 'cd docs && echo x > ledger.md' }));
});

test('a write to .claude/ledger.md through a symbolic link to the file or to its folder is denied', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  mkdirSync(path.join(main, '.claude'), { recursive: true });
  writeFileSync(path.join(main, '.claude/ledger.md'), ledgerText({ slug: 'main' }));
  symlinkSync('.claude/ledger.md', path.join(main, 'notes.md'));
  symlinkSync('.claude', path.join(main, 'meta'));

  for (const file of [path.join(main, 'notes.md'), path.join(main, 'meta/ledger.md')]) {
    assert.equal(assertDenied(await gate(main, 'Write', { file_path: file }, h)), STORE_REASON, file);
    assert.equal(assertDenied(await gate(main, 'Bash', { command: `echo x > ${file}` }, h)), STORE_REASON, file);
  }
});

test('a .claude/ledger.md that exists without an active record adds the line naming ledger store migrate --active', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const unmoved = worktree(h, main, path.join(h, 'unmoved'));
  const moved = worktree(h, main, path.join(h, 'moved'));
  ledgerIn(h, moved);
  const absent = worktree(h, main, path.join(h, 'absent'));
  for (const folder of [unmoved, moved]) {
    mkdirSync(path.join(folder, '.claude'), { recursive: true });
    writeFileSync(path.join(folder, '.claude/ledger.md'), ledgerText({ slug: path.basename(folder), worktree: folder }));
  }

  for (const tool of ['Write', 'Edit', 'MultiEdit']) {
    assert.equal(assertDenied(await gate(unmoved, tool, { file_path: path.join(unmoved, '.claude/ledger.md') }, h)), UNMOVED_REASON);
    assert.equal(assertDenied(await gate(moved, tool, { file_path: path.join(moved, '.claude/ledger.md') }, h)), STORE_REASON);
    assert.equal(assertDenied(await gate(absent, tool, { file_path: path.join(absent, '.claude/ledger.md') }, h)), STORE_REASON);
  }
  assert.equal(assertDenied(await gate(unmoved, 'Bash', { command: "sed -i '' 's/a/b/' .claude/ledger.md" }, h)), UNMOVED_REASON);
  assert.equal(assertDenied(await gate(moved, 'Bash', { command: 'echo x >> .claude/ledger.md' }, h)), STORE_REASON);
  assertAllowed(await gate(unmoved, 'Read', { file_path: path.join(unmoved, '.claude/ledger.md') }, h));
});

test('a .claude/ledger.md that migrate --active would not move gets no migrate line', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const linked = worktree(h, main, path.join(h, 'linked'));
  const sub = path.join(linked, 'sub');
  const plain = path.join(h, 'plain');
  for (const folder of [main, sub, plain]) {
    mkdirSync(path.join(folder, '.claude'), { recursive: true });
    writeFileSync(path.join(folder, '.claude/ledger.md'), ledgerText({ slug: path.basename(folder), worktree: folder }));
  }

  for (const folder of [main, sub, plain]) {
    assert.equal(assertDenied(await gate(folder, 'Write', { file_path: path.join(folder, '.claude/ledger.md') }, h)), STORE_REASON);
  }
});

const bashWrites = [
  'echo x > .claude/ledger.md',
  'echo x >> .claude/ledger.md',
  'echo x>.claude/ledger.md',
  'cat > .claude/ledger.md <<EOF\n# Task ledger\nEOF',
  "printf '%s' x > \".claude/ledger.md\"",
  'echo x | tee .claude/ledger.md',
  'echo x | tee -a .claude/ledger.md > /dev/null',
  'cp /tmp/x .claude/ledger.md',
  'mv -f /tmp/x .claude/ledger.md && git status',
  "sed -i '' 's/a/b/' .claude/ledger.md",
  "sed -i.bak -e 's/a/b/' .claude/ledger.md",
  'git status; echo x >> ./.claude/ledger.md',
  'cp x .claude/ledger.md 2>/dev/null',
  'cp x .claude/ledger.md 2> /dev/null',
  'cp x .claude/ledger.md > /dev/null',
  'cp x .claude/ledger.md 2>&1',
  '  cp x .claude/ledger.md',
  '\tcp x .claude/ledger.md',
  'sudo tee .claude/ledger.md < x',
  'sudo cp x .claude/ledger.md',
  'ls | xargs -I{} cp {} .claude/ledger.md',
  'env FOO=1 cp x .claude/ledger.md',
  'FOO=1 cp x .claude/ledger.md',
  'command cp x .claude/ledger.md',
  '/bin/cp x .claude/ledger.md',
  '{ cp x .claude/ledger.md; }',
  'if true; then cp x .claude/ledger.md; fi',
  '(mv a .claude/ledger.md)',
  'echo $(cp x .claude/ledger.md)',
  'cp x .claude/ledger.md < /dev/null',
  'cp x .claude/ledger.md <<< hi',
  'mv a .claude/ledger.md < /dev/null',
  'tee .claude/ledger.md < /tmp/x',
  'echo "$(cp x .claude/ledger.md)"',
  'echo "`cp x .claude/ledger.md`"',
  'echo `cp x .claude/ledger.md`',
  "cat > .claude/ledger.md <<'EOF'\nit's done\nEOF",
  '(echo x > .claude/ledger.md)',
  'cp /tmp/ledger.md .claude/',
  'cp x .claude/ledger.md # keep a copy',
  'ln -sf /tmp/note .claude/ledger.md',
];

for (const command of bashWrites) {
  test(`Bash ${JSON.stringify(command)} in a main checkout is denied`, async () => {
    assert.equal(assertDenied(await gate(gateWorld.main, 'Bash', { command })), STORE_REASON);
  });

  test(`Bash ${JSON.stringify(command)} in a linked worktree is denied`, async () => {
    assert.equal(assertDenied(await gate(gateWorld.worktree, 'Bash', { command })), STORE_REASON);
  });
}

test('Bash write to an absolute ledger path is denied from anywhere', async () => {
  const { main, worktree: linked, plain } = gateWorld;
  for (const folder of [main, linked]) {
    assertDenied(await gate(plain, 'Bash', { command: `echo x >> ${path.join(folder, '.claude/ledger.md')}` }));
    assertDenied(await gate(plain, 'Bash', { command: `cp /tmp/x '${path.join(folder, '.claude/ledger.md')}'` }));
  }
});

test('a Bash write after cd into a worktree is denied', async () => {
  assert.equal(assertDenied(await gate(gateWorld.main, 'Bash', { command: 'cd .claude/worktrees/task && echo x > .claude/ledger.md' })), STORE_REASON);
});

test('a Bash write to ledger.md from inside .claude/ is denied, as is its absolute path', async () => {
  for (const folder of [gateWorld.main, gateWorld.worktree]) {
    const claude = path.join(folder, '.claude');
    mkdirSync(claude, { recursive: true });
    for (const command of ['echo x > ledger.md', 'cp /tmp/x ./ledger.md', 'echo x | tee ledger.md', "sed -i '' 's/a/b/' ledger.md"]) {
      assert.equal(assertDenied(await gate(claude, 'Bash', { command })), STORE_REASON, `${command} in ${claude}`);
    }
    assertAllowed(await gate(folder, 'Bash', { command: 'echo x > ledger.md' }));
  }
});

test('Bash write through ~ to .claude/ledger.md is denied', async () => {
  const { h, main, plain } = gateWorld;
  assertDenied(await gate(plain, 'Bash', { command: `echo x > ~/${path.relative(h, path.join(main, '.claude/ledger.md'))}` }));
});

const bashReads = [
  'cat .claude/ledger.md',
  'grep -n Goal .claude/ledger.md',
  'cp .claude/ledger.md /tmp/ledger-copy.md',
  'cat .claude/ledger.md > /tmp/ledger-copy.md',
  'sed -n 1,20p .claude/ledger.md',
  'echo x > docs/ledger.md',
  'echo x > .claude/settings.json',
  'grep tee .claude/ledger.md',
  'grep -n cp .claude/ledger.md',
  'rg -i mv .claude/ledger.md',
  'tee /tmp/y < .claude/ledger.md',
  'tee -a /tmp/log < .claude/ledger.md',
  'echo "see x > .claude/ledger.md"',
  "git commit -m 'stop writing; cp x .claude/ledger.md'",
  'git commit -m "stop writing\ncp x .claude/ledger.md"',
  "echo '$(cp x .claude/ledger.md)'",
  "echo '`cp x .claude/ledger.md`'",
  'cp .claude/ledger.md /tmp/',
  'cp .claude/ledger.md /tmp/copy.md # not .claude/ledger.md',
  'ln -s .claude/ledger.md /tmp/ledger-link.md',
];

for (const command of bashReads) {
  test(`Bash ${JSON.stringify(command)} in a main checkout is allowed`, async () => {
    assertAllowed(await gate(gateWorld.main, 'Bash', { command }));
  });

  test(`Bash ${JSON.stringify(command)} in a linked worktree is allowed`, async () => {
    assertAllowed(await gate(gateWorld.worktree, 'Bash', { command }));
  });
}

test('a write to .claude/ledger.md is denied when git fails, as the gate asks git nothing', async () => {
  const { h, main } = gateWorld;
  const ran = await runHook(h, 'pre-tool-use', JSON.stringify(toolUse(main, 'Bash', { command: 'echo x > .claude/ledger.md' })), { GIT_DIR: path.join(h, 'missing') });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(assertDenied(ran.stdout), STORE_REASON);
});

const SESSION = '/private/tmp/claude-501/-Users-me-repos-app/3757e52e-56c2-4bea-866f-8e427c324a1e';
const citations = [
  `${SESSION}/scratchpad/xcodebuild-red.log`,
  '/tmp/claude-501/-Users-me-repos-app/3757e52e-56c2-4bea-866f-8e427c324a1e/tasks/b1.output',
  '/tmp/claude-501/-Users-me-repos-app/3757E52E-56C2-4BEA-866F-8E427C324A1E/tasks/b1.output',
  '<scratchpad>/handover.md',
  'scratchpad/review-1.txt',
];
const prose = [
  'Files in the session scratchpad are deleted by macOS.',
  'Evidence used to live under /tmp/claude-501 and is lost.',
  '- red: .claude/evidence/xcodebuild-red.log',
  'The scratchpad/ folder is not cited.',
];

/** The tool input that writes `text` into `file` with each file tool. */
function writing(tool: string, file: string, text: string): ToolInput {
  switch (tool) {
    case 'Write':
      return { file_path: file, content: `# Task ledger — task\n\n${text}\n` };
    case 'Edit':
      return { file_path: file, old_string: '- <decision>', new_string: text };
    default:
      return { file_path: file, edits: [{ old_string: 'a', new_string: 'fine' }, { old_string: 'b', new_string: text }] };
  }
}

/** The backlog ledger the citation tests write. The store gate denies any write to it; one that cites a session file gets the citation reason instead. */
const backlogLedgerFile = (): string => path.join(gateWorld.h, '.claude/ledger-backlog/main/idea.md');

for (const tool of ['Write', 'Edit', 'MultiEdit']) {
  for (const citation of citations) {
    test(`${tool} of a backlog ledger that cites ${citation} is denied`, async () => {
      assert.equal(assertDenied(await gate(gateWorld.plain, tool, writing(tool, backlogLedgerFile(), `- red: ${citation}`))), CITATION_REASON);
    });
  }

  for (const text of prose) {
    test(`${tool} of a backlog ledger with ${JSON.stringify(text)} cites nothing, so it gets the store reason`, async () => {
      assert.equal(assertDenied(await gate(gateWorld.plain, tool, writing(tool, backlogLedgerFile(), text))), HAND_EDIT_REASON);
    });
  }

  test(`${tool} of a file that is not a ledger may cite the scratchpad`, async () => {
    const { worktree: linked } = gateWorld;
    assertAllowed(await gate(linked, tool, writing(tool, path.join(linked, 'docs/notes.md'), `- red: ${citations[0]}`)));
  });
}

test('an Edit whose old text cites the scratchpad and new text does not cites nothing, so it gets the store reason', async () => {
  const edit = { file_path: backlogLedgerFile(), old_string: `- red: ${citations[0]}`, new_string: '- red: .claude/evidence/red.log' };
  assert.equal(assertDenied(await gate(gateWorld.plain, 'Edit', edit)), HAND_EDIT_REASON);
});

test('a write to .claude/ledger.md that also cites the scratchpad gets the ledger store reason', async () => {
  const target = path.join(gateWorld.worktree, '.claude/ledger.md');
  assert.equal(assertDenied(await gate(gateWorld.worktree, 'Write', writing('Write', target, `- red: ${citations[0]}`))), STORE_REASON);
});

const bashCitingWrites = [
  `cat > ~/.claude/ledger-backlog/main/idea.md <<EOF\n# Task ledger — task\n- red: ${citations[0]}\nEOF`,
  "echo '- handover: <scratchpad>/handover.md' >> ~/.claude/ledger-backlog/main/idea.md",
  "printf '%s\\n' '- review: scratchpad/review-1.txt' | tee -a ~/.claude/ledger-backlog/main/idea.md",
  `cat >> ~/.claude/ledger-backlog/main/idea.md <<EOF\n- red: ${citations[1]}\nEOF`,
];

for (const command of bashCitingWrites) {
  test(`Bash ${JSON.stringify(command)} in a linked worktree is denied`, async () => {
    assert.equal(assertDenied(await gate(gateWorld.worktree, 'Bash', { command })), CITATION_REASON);
  });
}

const bashAllowedNearCitations = [
  `cp ${citations[0]} .claude/evidence/xcodebuild-red.log`,
  `cat ${citations[0]} > .claude/evidence/red.log`,
];

for (const command of bashAllowedNearCitations) {
  test(`Bash ${JSON.stringify(command)} in a linked worktree is allowed`, async () => {
    assertAllowed(await gate(gateWorld.worktree, 'Bash', { command }));
  });
}

test('a Bash write of a backlog ledger that cites no session file gets the store reason', async () => {
  const command = "echo '- the scratchpad is gone; see .claude/evidence/red.log' >> ~/.claude/ledger-backlog/main/idea.md";
  assert.equal(assertDenied(await gate(gateWorld.worktree, 'Bash', { command })), HAND_EDIT_REASON);
});

// PreToolUse: the store gate

/** A path in each part of the store, relative to HOME: the file store, SQLite and git storage, and the files beside them. */
const storeFiles = [
  '.claude/ledger-backlog/main/idea.md',
  '.claude/ledger-active/main/task.md',
  '.claude/ledger-archive/main/task.md',
  '.claude/ledger-evidence/main/task/red.log',
  '.claude/ledger-data/ledgers/main/task.md',
  '.claude/ledger-data/.git/config',
  '.claude/ledgers.json',
  '.claude/ledger-aliases.json',
  '.claude/ledgers.db',
  '.claude/ledgers.db-wal',
  '.claude/ledgers.db-shm',
  '.claude/ledgers.db-journal',
  '.claude/ledger-data.status.json',
  '.claude/ledger-data.not-private',
  '.claude/ledgers-git.json',
  '.claude/ledger-aliases-git.json',
  '.claude/ledger-data.sync-order.json',
  '.claude/ledger-data.init',
  '.claude/ledger-data.init.lock',
  '.claude/ledger-data.sync',
  '.claude/ledger-data.sync.lock',
  '.claude/ledger-data.sync-pending',
];

for (const file of storeFiles) {
  test(`a file tool or Bash write of ~/${file} is denied, naming the ledger commands`, async () => {
    const { h, plain } = gateWorld;
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      assert.equal(assertDenied(await gate(plain, tool, writing(tool, path.join(h, file), '- a note'))), HAND_EDIT_REASON, tool);
    }
    assert.equal(assertDenied(await gate(plain, 'Bash', { command: `echo x > ~/${file}` })), HAND_EDIT_REASON);
  });
}

test('a store path through ~, $HOME, ${HOME}, quotes, an absolute path or a relative one is denied', async () => {
  const { h, plain } = gateWorld;
  for (const target of ['~/.claude/ledgers.json', '$HOME/.claude/ledgers.json', '${HOME}/.claude/ledgers.json', '"$HOME/.claude/ledgers.json"', `'${h}/.claude/ledgers.json'`, path.join(h, '.claude/ledgers.json')]) {
    assert.equal(assertDenied(await gate(plain, 'Bash', { command: `echo x > ${target}` })), HAND_EDIT_REASON, target);
  }
  assert.equal(assertDenied(await gate(plain, 'Write', { file_path: '../.claude/ledgers.json' })), HAND_EDIT_REASON);
});

test("a file tool's path is literal, not shell text: a quote in it is part of the name", async () => {
  const { plain } = gateWorld;
  assertAllowed(await gate(plain, 'Write', { file_path: "~/.claude/ledger's.json", content: 'x' }));
  assert.equal(assertDenied(await gate(plain, 'Write', { file_path: '~/.claude/ledgers.json', content: 'x' })), HAND_EDIT_REASON);
});

const bashStoreWrites = [
  'echo x >> ~/.claude/ledger-active/main/task.md',
  'echo x | tee ~/.claude/ledger-backlog/main/idea.md',
  "sed -i '' 's/a/b/' ~/.claude/ledger-archive/main/task.md",
  'cp /tmp/x ~/.claude/ledger-aliases.json',
  'mv /tmp/x ~/.claude/ledger-evidence/main/task/red.log',
  'rm ~/.claude/ledgers.json',
  'rm -rf ~/.claude/ledger-data',
  'rm /tmp/unrelated ~/.claude/ledger-data.status.json',
  'rmdir ~/.claude/ledger-active/main',
  'touch ~/.claude/ledger-data.not-private',
  'truncate -s 0 ~/.claude/ledgers.db',
  'ln -sf /tmp/x ~/.claude/ledger-aliases.json',
  'mkdir -p /tmp/elsewhere ~/.claude/ledger-backlog/main',
  'git status; rm -f ~/.claude/ledger-active/main/task.md',
  'sudo rm ~/.claude/ledgers.db-wal',
  'cd ~/.claude && rm ledgers.json',
  'cd $HOME/.claude/ledger-active && rm -rf main',
  'cd ${HOME}/.claude; touch ledger-aliases.json',
  'sqlite3 ~/.claude/ledgers.db "DELETE FROM ledgers"',
  'sqlite3 -batch ~/.claude/ledgers.db < /tmp/fix.sql',
  'cd ~/.claude && sqlite3 ledgers.db .dump',
  'sqlite3 -cmd ".timeout 5" ~/.claude/ledgers.db "select 1"',
  'ledger show > ~/.claude/ledgers.json',
  `${BIN} show >> ~/.claude/ledger-active/main/task.md`,
  'mv ~/.claude/ledgers.json /tmp/x',
  'mv -f ~/.claude/ledger-active/main/task.md /tmp/a /tmp/elsewhere',
  'rm -rf ~/.claude',
  'rm -rf ~',
  'rm -rf $HOME',
  'rm -rf "${HOME}"',
  'rmdir ~/.claude',
  'cd ~ && rm -rf .claude',
  'mv ~/.claude /tmp/claude-old',
  'rm -rf ~/.claude/ledger-*',
  'rm ~/.claude/*',
  'rm -rf ~/.c*',
  'rm ~/.claude/ledgers.*',
  'rm -rf ~/.claude/ledger-data/*',
  'mv ~/.claude/ledger-a* /tmp',
  'cp /tmp/x ~/.claude/ledger-active/*/task.md',
  'echo x | tee ~/.claude/ledger-[ab]*/main/x.md',
  'echo x > ~/.claude/ledgers.db-?al',
  'echo "x" > "$HOME/.claude/ledgers.json"',
  "echo 'a;b' > ~/.claude/ledgers.json",
  'cp "/tmp/a b" "$HOME/.claude/ledgers.json"',
  'ledger notes decision "a > b" > ~/.claude/ledgers.json',
];

for (const command of bashStoreWrites) {
  test(`Bash ${JSON.stringify(command)} is denied, naming the ledger commands`, async () => {
    assert.equal(assertDenied(await gate(gateWorld.plain, 'Bash', { command })), HAND_EDIT_REASON);
  });
}

const CLONE_GIT_REASON = `${HAND_EDIT_REASON}\nA sync conflict in the clone is resolved by the operator in a terminal, not by an agent: ask the operator.`;

const bashCloneGitWrites = [
  'git -C ~/.claude/ledger-data commit -am fix',
  'git -C ~/.claude -C ledger-data rebase origin/main',
  'git --git-dir=$HOME/.claude/ledger-data/.git reset --hard',
  'git --work-tree ~/.claude/ledger-data checkout .',
  'git -c user.name=x -C ~/.claude/ledger-data/ledgers add .',
  'cd ~/.claude/ledger-data && git push --force',
  'git -C ~/.claude/ledger-data stash',
  'git -C ~/.claude/ledger-data stash pop',
  'git -C ~/.claude/ledger-data commit -m "fix; resolve > conflict"',
  'git -C ~/.claude/ledger-data branch -d side',
  'git -C ~/.claude/ledger-data branch -D side',
  'git -C ~/.claude/ledger-data branch -m main old',
  'git -C ~/.claude/ledger-data branch -M main',
  'git -C ~/.claude/ledger-data branch -c main copy',
  'git -C ~/.claude/ledger-data branch rescue',
  'git -C ~/.claude/ledger-data branch -v rescue',
  'git -C ~/.claude/ledger-data branch --set-upstream-to=origin/main',
  'git -C ~/.claude/ledger-data remote add other /tmp/other.git',
  'git -C ~/.claude/ledger-data remote remove origin',
  'git -C ~/.claude/ledger-data remote rename origin old',
  'git -C ~/.claude/ledger-data remote set-url origin /tmp/other.git',
  'git -C ~/.claude/ledger-data remote prune origin',
  'git -C ~/.claude/ledger-data remote set-head origin -a',
  'git -C ~/.claude/ledger-data remote -v add other /tmp/other.git',
];

for (const command of bashCloneGitWrites) {
  test(`Bash ${JSON.stringify(command)} is denied, saying the operator resolves a sync conflict`, async () => {
    assert.equal(assertDenied(await gate(gateWorld.plain, 'Bash', { command })), CLONE_GIT_REASON);
  });
}

const bashStoreReads = [
  'ledger show',
  'ledger notes decision "keep the store in git"',
  'bin/ledger store sync',
  `${BIN} notes next "run the suite"`,
  'cat ~/.claude/ledgers.json',
  'ls -la ~/.claude/ledger-active/',
  'grep -rn Goal ~/.claude/ledger-backlog',
  'cd ~/.claude/ledger-data && cat ledgers/main/task.md',
  'sqlite3 -readonly ~/.claude/ledgers.db "SELECT count(*) FROM ledgers"',
  'sqlite3 ~/other.db VACUUM',
  'git -C ~/.claude/ledger-data branch --show-current',
  'git -C ~/.claude/ledger-data branch',
  'git -C ~/.claude/ledger-data branch -a -vv',
  'git -C ~/.claude/ledger-data branch -r -v',
  'git -C ~/.claude/ledger-data branch --list',
  'git -C ~/.claude/ledger-data branch --contains HEAD',
  'git -C ~/.claude/ledger-data branch --merged origin/main --no-merged=main',
  'git -C ~/.claude/ledger-data remote',
  'git -C ~/.claude/ledger-data remote -v',
  'git -C ~/.claude/ledger-data remote show origin',
  'git -C ~/.claude/ledger-data remote get-url origin',
  'git -C ~/.claude/ledger-data fetch',
  'git -C ~/.claude/ledger-data rev-list --count HEAD',
  'git -C ~/.claude/ledger-data reflog',
  'git -C ~/.claude/ledger-data stash list',
  'ledger notes decide "backlog -> ~/.claude/ledger-active"',
  "ledger notes decision 'x; rm ~/.claude/ledgers.json'",
  'echo "a | tee ~/.claude/ledgers.json"',
  'git commit -m "move > ~/.claude/ledgers.json"',
  'git -C ~/.claude/ledger-data log --oneline',
  'git -C ~/.claude/ledger-data status',
  'git --git-dir=$HOME/.claude/ledger-data/.git show HEAD',
  'git -C ~/.claude/ledger-data rev-parse HEAD',
  'git -C ~/.claude/ledger-data ls-files',
  'git -C ~/.claude/ledger-data cat-file -p HEAD',
  'git -C ~/.claude/ledger-data blame ledgers/main/task.md',
  'cd ~/.claude/ledger-data && git diff HEAD~1',
  'git -C /tmp/other commit -m x',
  'echo x > ~/.claude/ledger-hook-failures.log',
  'cp /tmp/x ~/.claude/ledgers.json.bak',
  'mkdir -p ~/.claude/ledger-data-backup',
  'touch ~/.claude/settings.json',
  'mv /tmp/a /tmp/b',
  'mv /tmp/x ~/.claude',
  'echo x > ~/.claude/other.txt',
  'touch ~/.claude',
  'mkdir -p ~/.claude',
  'cp /tmp/x ~/.claude',
  'rm -rf ~/.claude/plugins',
  'rm ~/.claude/*.log',
  'rm -rf ~/.claude/plugin*',
  'echo x > ~/.claude/*.txt',
  'rm -rf ~/*',
];

for (const command of bashStoreReads) {
  test(`Bash ${JSON.stringify(command)} is allowed`, async () => {
    assertAllowed(await gate(gateWorld.plain, 'Bash', { command }));
  });
}

test('git check-ref-format and git shortlog only read, so they are allowed in the clone', async () => {
  for (const command of ['git -C ~/.claude/ledger-data check-ref-format refs/heads/main', 'git -C ~/.claude/ledger-data shortlog -sn HEAD']) {
    assertAllowed(await gate(gateWorld.plain, 'Bash', { command }));
  }
});

test('sqlite3 from ~/.claude reads only its database operand as a path: SQL and option values are not files', async () => {
  const claude = path.join(gateWorld.h, '.claude');
  for (const command of ['sqlite3 /tmp/o.db "select * from t"', 'sqlite3 /tmp/o.db select \\* from ledgers.json', 'sqlite3 -cmd ".read ledgers.db" /tmp/o.db']) {
    assertAllowed(await gate(claude, 'Bash', { command }));
  }
  for (const command of ['sqlite3 ledgers.db "select 1"', 'sqlite3 -separator , ledgers.db']) {
    assert.equal(assertDenied(await gate(claude, 'Bash', { command })), HAND_EDIT_REASON, command);
  }
});

test('writes to an unguarded ~/.claude file and to a worktree\'s .claude/evidence are allowed', async () => {
  const { h, worktree: linked } = gateWorld;
  for (const file of [path.join(h, '.claude/ledger-hook-failures.log'), path.join(h, '.claude/ledgers-notes.md'), path.join(linked, '.claude/evidence/red.log')]) {
    assertAllowed(await gate(linked, 'Write', { file_path: file, content: 'x' }));
  }
  for (const command of ['mkdir -p .claude/evidence', 'cp /tmp/x .claude/evidence/red.log', 'echo x > .claude/evidence/red.log', 'rm .claude/evidence/red.log']) {
    assertAllowed(await gate(linked, 'Bash', { command }));
  }
});

test('a write to the store through a symbolic link to a store folder or file, or under a ~/.claude that is a link, is denied', async (t) => {
  const h = home(t);
  const claude = path.join(h, 'dotfiles/claude');
  mkdirSync(path.dirname(claude));
  renameSync(path.join(h, '.claude'), claude);
  mkdirSync(path.join(claude, 'ledger-active/main'), { recursive: true });
  mkdirSync(path.join(claude, 'ledger-data'));
  writeFileSync(path.join(claude, 'ledger-active/main/task.md'), ledgerText({ slug: 'task' }));
  symlinkSync(claude, path.join(h, '.claude'));
  symlinkSync(path.join(h, '.claude/ledger-active'), path.join(h, 'active-link'));
  symlinkSync(path.join(h, '.claude/ledger-active/main/task.md'), path.join(h, 'task-link.md'));
  symlinkSync(path.join(h, '.claude/ledger-data'), path.join(h, 'data-link'));

  for (const file of [path.join(h, 'active-link/main/task.md'), path.join(h, 'active-link/main/new.md'), path.join(h, 'task-link.md'), path.join(claude, 'ledgers.json')]) {
    assert.equal(assertDenied(await gate(h, 'Write', { file_path: file, content: 'x' }, h)), HAND_EDIT_REASON, file);
    assert.equal(assertDenied(await gate(h, 'Bash', { command: `echo x >> ${file}` }, h)), HAND_EDIT_REASON, file);
  }
  assert.equal(assertDenied(await gate(h, 'Bash', { command: 'git -C ~/data-link commit -m x' }, h)), CLONE_GIT_REASON);
  assertAllowed(await gate(h, 'Bash', { command: 'git -C ~/data-link log' }, h));
});

test('a git command run from inside the clone is denied unless it only reads', async (t) => {
  const h = home(t);
  const clone = path.join(h, '.claude/ledger-data/ledgers');
  mkdirSync(clone, { recursive: true });

  for (const command of ['git commit -am fix', 'git reset --hard HEAD~1', 'git -C .. push']) {
    assert.equal(assertDenied(await gate(clone, 'Bash', { command }, h)), CLONE_GIT_REASON, command);
  }
  for (const command of ['git log', 'git status --short', 'git show HEAD:ledgers.json']) {
    assertAllowed(await gate(clone, 'Bash', { command }, h));
  }
});

test('git archive in the clone is allowed unless its -o or --output names a file in the store', async () => {
  const { plain } = gateWorld;
  for (const command of ['git -C ~/.claude/ledger-data archive HEAD > /dev/null', 'git -C ~/.claude/ledger-data archive -o /tmp/store.tar HEAD', 'git -C ~/.claude/ledger-data archive --output=/tmp/store.tar HEAD']) {
    assertAllowed(await gate(plain, 'Bash', { command }));
  }
  for (const command of ['git -C ~/.claude/ledger-data archive -o store.tar HEAD', 'git -C ~/.claude/ledger-data archive --output ~/.claude/ledgers.json HEAD', 'git -C /tmp archive --output=$HOME/.claude/ledger-active/x.tar HEAD']) {
    assert.equal(assertDenied(await gate(plain, 'Bash', { command })), HAND_EDIT_REASON, command);
  }
});

test('git branch in the clone with a list filter such as --points-at only lists, so it is allowed', async () => {
  const { plain } = gateWorld;
  for (const command of ['git -C ~/.claude/ledger-data branch --points-at HEAD', 'git -C ~/.claude/ledger-data branch --no-contains HEAD', 'git -C ~/.claude/ledger-data branch --sort -committerdate --format "%(refname)"', 'git -C ~/.claude/ledger-data branch -a --points-at=HEAD']) {
    assertAllowed(await gate(plain, 'Bash', { command }));
  }
  for (const command of ['git -C ~/.claude/ledger-data branch --points-at HEAD -d side', 'git -C ~/.claude/ledger-data branch --sort refname rescue']) {
    assert.equal(assertDenied(await gate(plain, 'Bash', { command })), CLONE_GIT_REASON, command);
  }
});

test('git branch in the clone with a list filter reads the words after it as patterns, so it only lists', async () => {
  const { plain } = gateWorld;
  for (const command of ["git -C ~/.claude/ledger-data branch --points-at HEAD '*'", "git -C ~/.claude/ledger-data branch --merged=main 'side*' main", "git -C ~/.claude/ledger-data branch --contains HEAD 'x*'"]) {
    assertAllowed(await gate(plain, 'Bash', { command }));
  }
  for (const command of ['git -C ~/.claude/ledger-data branch --sort refname rescue', 'git -C ~/.claude/ledger-data branch --format x rescue', 'git -C ~/.claude/ledger-data branch --points-at HEAD -m side']) {
    assert.equal(assertDenied(await gate(plain, 'Bash', { command })), CLONE_GIT_REASON, command);
  }
});

test('git branch --list in the clone reads the words after -- as patterns, so it only lists', async () => {
  const { plain } = gateWorld;
  for (const command of ["git -C ~/.claude/ledger-data branch --list -- 'main*'", "git -C ~/.claude/ledger-data branch -l -- -d 'main*'", "git -C ~/.claude/ledger-data branch --points-at HEAD -- '*'"]) {
    assertAllowed(await gate(plain, 'Bash', { command }));
  }
  for (const command of ['git -C ~/.claude/ledger-data branch -- rescue', 'git -C ~/.claude/ledger-data branch -d -- side', 'git -C ~/.claude/ledger-data branch -m -- side other', 'git -C ~/.claude/ledger-data branch -c -- side other', 'git -C ~/.claude/ledger-data branch -u origin/main -- side']) {
    assert.equal(assertDenied(await gate(plain, 'Bash', { command })), CLONE_GIT_REASON, command);
  }
});

test('git branch in the clone lists with -i, with -l in a bundle such as -vl, and with nothing after --', async () => {
  const { plain } = gateWorld;
  for (const command of ["git -C ~/.claude/ledger-data branch --list --ignore-case -- 'MASTER*'", "git -C ~/.claude/ledger-data branch -il 'M*'", "git -C ~/.claude/ledger-data branch -vl -- '*'", 'git -C ~/.claude/ledger-data branch --']) {
    assertAllowed(await gate(plain, 'Bash', { command }));
  }
  for (const command of ['git -C ~/.claude/ledger-data branch -i side', 'git -C ~/.claude/ledger-data branch -v -- side', 'git -C ~/.claude/ledger-data branch -dl side', 'git -C ~/.claude/ledger-data branch -m -- side', 'git -C ~/.claude/ledger-data branch -c side other', 'git -C ~/.claude/ledger-data branch -u origin/main --']) {
    assert.equal(assertDenied(await gate(plain, 'Bash', { command })), CLONE_GIT_REASON, command);
  }
});

test('git branch --list in the clone takes the display flags --column, --abbrev, --color and --omit-empty, with or without their no- forms', async () => {
  const { h } = gateWorld;
  for (const flag of ['--no-column', '--no-abbrev', '--abbrev=8', '--omit-empty', '--column', '--abbrev', '--no-color', '--color', '--color=always']) {
    const command = `git -C ~/.claude/ledger-data branch --list ${flag}`;
    assertAllowed(await gate(h, 'Bash', { command }));
  }
  for (const command of ['git -C ~/.claude/ledger-data branch --abbrev=8 side', 'git -C ~/.claude/ledger-data branch --no-column side', 'git -C ~/.claude/ledger-data branch --omit-empty side']) {
    assert.equal(assertDenied(await gate(h, 'Bash', { command })), CLONE_GIT_REASON, command);
  }
});

test('git fetch in the clone with --dry-run writes nothing, so it is allowed even when it prunes', async () => {
  const { plain } = gateWorld;
  for (const command of ['git -C ~/.claude/ledger-data fetch --prune --dry-run', 'git -C ~/.claude/ledger-data fetch --dry-run --force origin +main:main']) {
    assertAllowed(await gate(plain, 'Bash', { command }));
  }
  for (const command of ['git -C ~/.claude/ledger-data fetch --prune', 'git -C ~/.claude/ledger-data fetch -n --prune']) {
    assert.equal(assertDenied(await gate(plain, 'Bash', { command })), CLONE_GIT_REASON, command);
  }
});

const bashStoreWritesInDepth = [
  'echo "a\nb" > ~/.claude/ledgers.json',
  'cat > ~/.claude/ledgers.json <<EOF\n{}\nEOF',
  "cat <<'EOF' > /tmp/notes\ndon't\nEOF\necho x > ~/.claude/ledgers.json",
  'cat <<A <<B > /tmp/notes\none\nA\ntwo\nB\nrm ~/.claude/ledgers.json',
  'echo "$(rm ~/.claude/ledgers.json)"',
  'echo "`rm ~/.claude/ledgers.json`"',
  'echo x >| ~/.claude/ledgers.json',
  '(echo x > ~/.claude/ledgers.json)',
  'echo $(echo x >~/.claude/ledgers.json)',
  'cp /tmp/ledgers.json ~/.claude/',
  'cp /tmp/ledgers.json ~/.claude',
  'cp -t ~/.claude /tmp/ledgers.json',
  'cp --target-directory=$HOME/.claude /tmp/a /tmp/ledgers.json',
  'mv /tmp/a "/tmp/ledgers.json" ~/.claude/',
  'ln -s /tmp/ledgers.json ~/.claude/',
  'cp /tmp/x ~/.claude/ledgers.json # keep a copy',
  'cd -- ~/.claude && rm ledgers.json',
  'echo x > "${HOME}"/.claude/ledgers.json',
  'rm -rf "$HOME"/.claude/ledger-*',
  'sqlite3 -separator -readonly ~/.claude/ledgers.db "DELETE FROM ledgers"',
  'touch -r /tmp/x ~/.claude/ledgers.json',
];

for (const command of bashStoreWritesInDepth) {
  test(`Bash ${JSON.stringify(command)} is denied, naming the ledger commands`, async () => {
    assert.equal(assertDenied(await gate(gateWorld.plain, 'Bash', { command })), HAND_EDIT_REASON);
  });
}

const bashStoreReadsInDepth = [
  'git commit -m "fix the store\nrm -rf ~/.claude/ledger-active\nand more"',
  "gh pr create --title x --body \"$(cat <<'EOF'\n## Summary\nIt's done: echo x > ~/.claude/ledgers.json\nEOF\n)\"",
  'cat <<-EOF > /tmp/notes\n\trm -rf ~/.claude/ledger-data\n\tEOF',
  'cat <<"EOF"\n> ~/.claude/ledgers.json\nEOF',
  "echo '$(rm ~/.claude/ledgers.json)'",
  'cp /tmp/notes.json ~/.claude/',
  'cp ~/.claude/ledgers.json /tmp/backup.json # not ~/.claude/ledgers.json',
  'cp /tmp/x /tmp/y  # see > ~/.claude/ledgers.json',
  "echo x > '$HOME/.claude/ledgers.json'",
  "git -C '$HOME/.claude/ledger-data' commit -m x",
  "rm -rf ~/.claude/'ledger-*'",
  'rm ~/.claude/"*"',
  'echo x > "$HOME/.claude/ledgers.*"',
  'sqlite3 ~/.claude/ledgers.db -readonly "select 1"',
  'touch -r ~/.claude/ledgers.json /tmp/x',
  'touch --reference=~/.claude/ledgers.json /tmp/x',
  'git -C ~/.claude/ledger-data reflog show',
  'git -C ~/.claude/ledger-data reflog -n 5',
  'git -C ~/.claude/ledger-data reflog HEAD',
  'git -C ~/.claude/ledger-data reflog main@{1}',
  'git -C ~/.claude/ledger-data reflog --date=iso',
  'git -C ~/.claude/ledger-data branch -avv',
  'git -C ~/.claude/ledger-data branch --all',
  'git -C ~/.claude/ledger-data branch --remotes --verbose',
  'git -C ~/.claude/ledger-data branch -l',
  "git -C ~/.claude/ledger-data branch --format='%(refname:short)' --sort=-committerdate",
  'git -C ~/.claude/ledger-data branch --color=always --no-color --column --column=never',
  "git -C ~/.claude/ledger-data branch --list 'fix-*' main",
];

for (const command of bashStoreReadsInDepth) {
  test(`Bash ${JSON.stringify(command)} is allowed`, async () => {
    assertAllowed(await gate(gateWorld.plain, 'Bash', { command }));
  });
}

const bashCloneGitWritesInDepth = [
  'git -C "${HOME}/.claude/ledger-data" commit -m x',
  'git -C "$HOME"/.claude/ledger-data reset --hard',
  'git --git-dir="${HOME}/.claude/ledger-data/.git" reset --hard',
  'git -C ~/.claude/ledger-data reflog expire --all',
  'git -C ~/.claude/ledger-data reflog delete HEAD@{1}',
  'git -C ~/.claude/ledger-data reflog drop',
];

for (const command of bashCloneGitWritesInDepth) {
  test(`Bash ${JSON.stringify(command)} is denied, saying the operator resolves a sync conflict`, async () => {
    assert.equal(assertDenied(await gate(gateWorld.plain, 'Bash', { command })), CLONE_GIT_REASON);
  });
}

test('a backtick substitution is one word of the command around it, so the words after it still count', async () => {
  for (const folder of [gateWorld.main, gateWorld.worktree]) {
    assert.equal(assertDenied(await gate(folder, 'Bash', { command: 'cp `printf %s notes.md` .claude/ledger.md' })), STORE_REASON, folder);
  }
});

test('a target that starts with a command substitution and ends in .claude/ledger.md is denied', async () => {
  for (const folder of [gateWorld.main, gateWorld.worktree]) {
    for (const command of ['echo x > $(pwd)/.claude/ledger.md', 'cp notes.md `pwd`/.claude/ledger.md', 'mv notes.md "$(pwd)/.claude/ledger.md"']) {
      assert.equal(assertDenied(await gate(folder, 'Bash', { command })), STORE_REASON, `${command} in ${folder}`);
    }
  }
});

test('an unquoted here-document body runs its command substitutions; a quoted one is data', async () => {
  const { plain } = gateWorld;
  const runs = [
    'cat <<EOF\n$(rm -rf ~/.claude/ledger-active)\nEOF',
    'cat <<-EOF\n\tnote `rm ~/.claude/ledgers.json` here\n\tEOF',
    "cat <<EOF > /tmp/notes\nit's $(rm ~/.claude/ledgers.json) (done\nEOF",
    'cd ~/.claude && cat <<EOF\n$(rm ledgers.json)\nEOF',
    'cat <<A <<B\n$(date)\nA\n$(rm ~/.claude/ledgers.json)\nB',
    'cat <<EOF\n$(date)\nEOF\nrm ~/.claude/ledgers.json',
  ];
  for (const command of runs) assert.equal(assertDenied(await gate(plain, 'Bash', { command })), HAND_EDIT_REASON, command);
  const data = [
    "cat <<'EOF'\n$(rm -rf ~/.claude/ledger-active)\nEOF",
    'cat <<"EOF"\n`rm ~/.claude/ledgers.json`\nEOF',
    'cat <<\\EOF\n$(rm ~/.claude/ledgers.json)\nEOF',
    'cat <<EOF\n\\$(rm ~/.claude/ledgers.json)\nEOF',
    "cat <<A <<'B'\n$(date)\nA\n$(rm ~/.claude/ledgers.json)\nB",
    "cat <<EOF\nit's (done\nEOF\necho ok > /tmp/notes",
  ];
  for (const command of data) assertAllowed(await gate(plain, 'Bash', { command }));
});

test('a brace expansion in a target word is expanded before the word is checked', async () => {
  const { h, plain } = gateWorld;
  for (const command of ['rm -f ~/.claude/ledgers.db{,-wal,-shm}', 'rm ~/.claude/{ledgers,ledger-aliases}.json', 'mv ~/.claude/ledgers.json{,.bak}', 'touch ~/.claude/ledger-{data,x}.status.json']) {
    assert.equal(assertDenied(await gate(plain, 'Bash', { command })), HAND_EDIT_REASON, command);
  }
  assert.equal(assertDenied(await gate(path.join(h, '.claude'), 'Bash', { command: 'rm -rf ledger-{active,backlog}' })), HAND_EDIT_REASON);
  for (const command of ['cp ~/.claude/ledgers.json{,.bak}', 'rm -f /tmp/{a,b}', 'rm -f "$HOME/.claude/ledgers.{db,json}"', "rm -f ~/.claude/'{ledgers,x}'.json", 'ls | xargs -I{} cp {} /tmp/']) {
    assertAllowed(await gate(plain, 'Bash', { command }));
  }
});

test('an option value is not a path: mkdir -m, truncate -s and -r, and touch -d and -t write only their operands', async (t) => {
  const h = home(t);
  const clone = path.join(h, '.claude/ledger-data');
  mkdirSync(clone, { recursive: true });
  const elsewhere = ['mkdir -m 700 /tmp/report-cache', 'mkdir -p --mode 700 /tmp/report-cache', 'truncate -s 0 /tmp/notes', 'touch -d "2 days ago" /tmp/notes', 'touch -t 202601010000 /tmp/notes'];
  for (const command of elsewhere) assertAllowed(await gate(clone, 'Bash', { command }, h));
  assertAllowed(await gate(h, 'Bash', { command: 'cd ~/.claude/ledger-data && mkdir -m 700 /tmp/report-cache' }, h));
  assertAllowed(await gate(h, 'Bash', { command: 'truncate -r ~/.claude/ledgers.db /tmp/notes' }, h));
  for (const command of ['mkdir -m 700 ~/.claude/ledger-backlog/main', 'truncate -s 0 ~/.claude/ledgers.db', 'touch -d now ~/.claude/ledgers.json', 'truncate -r /tmp/notes ~/.claude/ledgers.db']) {
    assert.equal(assertDenied(await gate(h, 'Bash', { command }, h)), HAND_EDIT_REASON, command);
  }
});

test('a bundle of short options that ends in -r, -d or -t takes the next word as its value, so touch -cr only reads that file', async (t) => {
  const h = home(t);
  mkdirSync(path.join(h, '.claude/ledger-data'), { recursive: true });
  const main = checkout(h, 'main');
  for (const command of ['touch -cr ~/.claude/ledger-data .', 'touch -mr ~/.claude/ledgers.json /tmp/notes', 'touch -cd "2 days ago" /tmp/notes', 'touch -ct 202601010000 /tmp/notes', 'truncate -cr ~/.claude/ledgers.db /tmp/notes']) {
    assertAllowed(await gate(main, 'Bash', { command }, h));
  }
  for (const command of ['touch -cr /tmp/x ~/.claude/ledgers.json', 'touch -rc ~/.claude/ledgers.json', 'touch -cd now ~/.claude/ledgers.json', 'touch -crx ~/.claude/ledgers.json']) {
    assert.equal(assertDenied(await gate(main, 'Bash', { command }, h)), HAND_EDIT_REASON, command);
  }
});

test('a $(...) in double quotes closes at its matching ), and is one word of the command around it', async () => {
  const { plain } = gateWorld;
  assert.equal(assertDenied(await gate(plain, 'Bash', { command: 'cp "$(pwd)/notes.json" ~/.claude/ledgers.json' })), HAND_EDIT_REASON);
  assertAllowed(await gate(plain, 'Bash', { command: 'cp "$(ls ~/.claude/ledgers.json)" /tmp/backup.json' }));
});

test('a word that starts with a command substitution names no known path, so it is not a write in the folder the command runs in', async (t) => {
  const h = home(t);
  const clone = path.join(h, '.claude/ledger-data');
  mkdirSync(clone, { recursive: true });
  for (const command of ['echo x > "$(mktemp)"', 'cp notes.md $(mktemp -d)', 'echo x > `mktemp`']) assertAllowed(await gate(clone, 'Bash', { command }, h));
});

test('rm, an mv source and touch of a .claude/ledger.md are denied, as for a store path', async () => {
  for (const command of ['rm .claude/ledger.md', 'rm -f .claude/ledger.md', 'mv .claude/ledger.md /tmp/x', 'touch .claude/ledger.md']) {
    for (const folder of [gateWorld.main, gateWorld.worktree]) {
      assert.equal(assertDenied(await gate(folder, 'Bash', { command })), STORE_REASON, `${command} in ${folder}`);
    }
  }
});

test('a cd at the top of a command carries over to later lines and later commands, but not out of a subshell', async () => {
  const { h, plain } = gateWorld;
  for (const command of ['cd ~/.claude\nprintf x > ledgers.json', 'cd ~/.claude && ls\n\nrm ledgers.json', '{ cd ~/.claude; }\nprintf x > ledgers.json', '(cd ~/.claude && printf x > ledgers.json)']) {
    assert.equal(assertDenied(await gate(plain, 'Bash', { command })), HAND_EDIT_REASON, command);
  }
  assertAllowed(await gate(path.join(h, '.claude'), 'Bash', { command: 'cd /tmp\nprintf x > ledgers.json' }));
  for (const command of ['(cd ~/.claude)\nprintf x > ledgers.json', '(cd ~/.claude && ls); printf x > ledgers.json', 'echo "$(cd ~/.claude && pwd)"\nprintf x > ledgers.json', 'ls `cd ~/.claude`; rm ledgers.json']) {
    assertAllowed(await gate(plain, 'Bash', { command }));
  }
});

test('a backslash-newline joins two lines into one command', async () => {
  for (const command of ['printf x > \\\n~/.claude/ledgers.json', 'rm -f \\\n  ~/.claude/ledgers.json', 'cp /tmp/x \\\n  "$HOME/.claude/ledgers.json"']) {
    assert.equal(assertDenied(await gate(gateWorld.plain, 'Bash', { command })), HAND_EDIT_REASON, command);
  }
});

test('a cd inside a subshell that spans lines counts on its later lines', async () => {
  for (const command of ['(cd ~/.claude\nprintf x > ledgers.json)', '(\n  cd ~/.claude\n  printf x > ledgers.json\n)']) {
    assert.equal(assertDenied(await gate(gateWorld.plain, 'Bash', { command })), HAND_EDIT_REASON, command);
  }
});

test('an arithmetic << is a shift, not a here-document, so the lines after it still count', async () => {
  for (const folder of [gateWorld.main, gateWorld.worktree]) {
    assert.equal(assertDenied(await gate(folder, 'Bash', { command: 'n=$((1 << 2))\nprintf x > .claude/ledger.md' })), STORE_REASON, folder);
  }
  const shifts = [
    'echo "$((x << 1))"\nrm ~/.claude/ledgers.json',
    'n=$(( (1 << 2) + 1 ))\nrm ~/.claude/ledgers.json',
    '(( n <<= 1 ))\nrm ~/.claude/ledgers.json',
    'for ((i = 0; i << 1; i++)); do :; done\nrm ~/.claude/ledgers.json',
    'n=$((1<<2)); cat <<EOF\n$(rm ~/.claude/ledgers.json)\nEOF',
    'n=$(( $(rm ~/.claude/ledgers.json) + 1 ))',
    'echo $((cd ~/.claude && rm ledgers.json) )',
  ];
  for (const command of shifts) assert.equal(assertDenied(await gate(gateWorld.plain, 'Bash', { command })), HAND_EDIT_REASON, command);
});

test('a > or ; inside an arithmetic expansion is an operator, not a redirect or a command end', async (t) => {
  const h = home(t);
  const clone = path.join(h, '.claude/ledger-data');
  mkdirSync(clone, { recursive: true });
  for (const command of ['echo $(( 3 > 2 ))', 'echo "$((n >= 1 ? 1 : 0))"', '(( n > 2 )) && echo big']) assertAllowed(await gate(clone, 'Bash', { command }, h));
});

test('every word after -- is an operand, also one that starts with -', async () => {
  const legacy = [
    'echo x | tee -- -old/.claude/ledger.md',
    'rm -- -old/.claude/ledger.md',
    'mv -- -old/.claude/ledger.md /tmp/x',
    'touch -- -old/.claude/ledger.md',
    'truncate -s 0 -- -old/.claude/ledger.md',
    "sed -i -- 's/a/b/' -old/.claude/ledger.md",
    'cp -- /tmp/x -old/.claude/ledger.md',
    'ln -s -- /tmp/x -old/.claude/ledger.md',
  ];
  for (const command of legacy) {
    for (const folder of [gateWorld.main, gateWorld.worktree]) {
      assert.equal(assertDenied(await gate(folder, 'Bash', { command })), STORE_REASON, `${command} in ${folder}`);
    }
  }
  const { h } = gateWorld;
  for (const command of ['sqlite3 -- ~/.claude/ledgers.db "select 1"', 'mkdir -p -- -x/../.claude/ledger-backlog/main', 'git clone -- /tmp/x.git -x/../.claude/ledger-data']) {
    assert.equal(assertDenied(await gate(h, 'Bash', { command })), HAND_EDIT_REASON, command);
  }
});

test('the operands after -- are read as before: a sed script and an option value are no files', async (t) => {
  const h = home(t);
  const clone = path.join(h, '.claude/ledger-data');
  mkdirSync(clone, { recursive: true });
  for (const command of ['sed -i -- s/x/y/ /tmp/notes', 'cp -- /tmp/a /tmp/b', 'touch -d now -- /tmp/notes', 'echo x | tee -- /tmp/notes', 'sqlite3 -- /tmp/o.db "select 1"']) {
    assertAllowed(await gate(clone, 'Bash', { command }, h));
  }
});

const bashCloneGitReads = [
  'git -C ~/.claude/ledger-data config --local user.name',
  'git -C ~/.claude/ledger-data config --global user.name',
  'git -C ~/.claude/ledger-data config --worktree --get user.name',
  'git -C ~/.claude/ledger-data config --system --list',
  'git -C ~/.claude/ledger-data config get user.name',
  'git -C ~/.claude/ledger-data config get --all remote.origin.url',
  'git -C ~/.claude/ledger-data config list',
  'git -C ~/.claude/ledger-data config list --local',
  'git -C ~/.claude/ledger-data merge-base HEAD origin/main',
  'git -C ~/.claude/ledger-data merge-base --is-ancestor HEAD origin/main',
  'git -C ~/.claude/ledger-data merge-base --fork-point origin/main',
  'git -C ~/.claude/ledger-data tag',
  'git -C ~/.claude/ledger-data tag -n',
  'git -C ~/.claude/ledger-data tag -n5',
  'git -C ~/.claude/ledger-data tag --contains HEAD',
  'git -C ~/.claude/ledger-data tag --no-contains=HEAD --merged',
  'git -C ~/.claude/ledger-data tag --no-merged origin/main --points-at HEAD',
  "git -C ~/.claude/ledger-data tag --sort=-creatordate --format='%(refname:short)' --column",
  "git -C ~/.claude/ledger-data tag -l 'v*'",
  "git -C ~/.claude/ledger-data tag --list 'v*' -n",
  'git -C ~/.claude/ledger-data tag -n v1',
  "git -C ~/.claude/ledger-data tag -n5 v1 'v2*'",
  'git -C ~/.claude/ledger-data tag -i',
  'git -C ~/.claude/ledger-data tag --ignore-case --sort=refname',
  'git -C ~/.claude/ledger-data tag -i -n v1',
  'git -C ~/.claude/ledger-data for-each-ref refs/heads',
  "git -C ~/.claude/ledger-data for-each-ref --format='%(refname)' refs/tags",
  'git -C ~/.claude/ledger-data clean -n',
  'git -C ~/.claude/ledger-data clean -nd',
  'git -C ~/.claude/ledger-data clean -ndx',
  'git -C ~/.claude/ledger-data clean -dn',
  'git -C ~/.claude/ledger-data clean --dry-run -d',
  "git -C ~/.claude/ledger-data clean -e '*.tmp' -n",
  'git -C ~/.claude/ledger-data check-ignore -v -- notes.md',
  'git -C ~/.claude/ledger-data add --dry-run .',
  'git -C ~/.claude/ledger-data add -n notes.md',
  'git -C ~/.claude/ledger-data add -An',
  'git -C ~/.claude/ledger-data clean -n -- generated/',
  'git -C ~/.claude/ledger-data apply --check /tmp/review.patch',
  'git -C ~/.claude/ledger-data apply --stat /tmp/review.patch',
  'git -C ~/.claude/ledger-data apply --numstat /tmp/review.patch',
  'git -C ~/.claude/ledger-data apply --summary /tmp/review.patch',
  'git -C ~/.claude/ledger-data apply --check --index /tmp/review.patch',
  'git -C ~/.claude/ledger-data apply --check --cached /tmp/review.patch',
  'git -C ~/.claude/ledger-data apply --stat --index /tmp/review.patch',
  'git -C ~/.claude/ledger-data apply --numstat --cached /tmp/review.patch',
  'git -C ~/.claude/ledger-data apply --stat -- --apply',
  'git -C ~/.claude/ledger-data diff --name-only HEAD -- --output=notes.md',
  'git -C ~/.claude/ledger-data diff-tree --no-commit-id --name-only -r HEAD',
  'git -C ~/.claude/ledger-data count-objects -v',
  'git -C ~/.claude/ledger-data diff-index --cached HEAD',
  'git -C ~/.claude/ledger-data cherry-pick -h',
  'git -C ~/.claude/ledger-data reset --help',
  'cd ~/.claude/ledger-data && git config --global user.name Example',
  'git -C ~/.claude/ledger-data config --system core.editor vim',
  'git -C ~/.claude/ledger-data config --global --unset user.name',
];

for (const command of bashCloneGitReads) {
  test(`Bash ${JSON.stringify(command)} only reads the clone, so it is allowed`, async () => {
    assertAllowed(await gate(gateWorld.plain, 'Bash', { command }));
  });
}

const bashCloneGitChanges = [
  'git -C ~/.claude/ledger-data config --local user.name x',
  'git -C ~/.claude/ledger-data config --local --unset user.name',
  'git -C ~/.claude/ledger-data config set user.name x',
  'git -C ~/.claude/ledger-data config unset user.name',
  'git -C ~/.claude/ledger-data tag v1',
  'git -C ~/.claude/ledger-data tag -a v1 -m x',
  'git -C ~/.claude/ledger-data tag -d v1',
  'git -C ~/.claude/ledger-data tag -f v1 HEAD',
  'git -C ~/.claude/ledger-data tag --sort=v:refname v2',
  'git -C ~/.claude/ledger-data tag -i v1',
  'git -C ~/.claude/ledger-data tag -n -d v1',
  'git -C ~/.claude/ledger-data config user.name x',
  'git -C ~/.claude/ledger-data config --worktree user.name x',
  'git -C ~/.claude/ledger-data config --file .git/config user.name x',
  'git -C ~/.claude/ledger-data clean -fd',
  'git -C ~/.claude/ledger-data clean -f -enode_modules',
  'git -C ~/.claude/ledger-data clean -fx -e -n',
  'git -C ~/.claude/ledger-data clean -f --exclude -n',
  'git -C ~/.claude/ledger-data clean -fe -n',
  'git -C ~/.claude/ledger-data add .',
  'git -C ~/.claude/ledger-data add -A',
  'git -C ~/.claude/ledger-data add -- -n',
  'git -C ~/.claude/ledger-data clean -fd -- generated/ -n',
  'git -C ~/.claude/ledger-data clean -f -- --dry-run',
  'git -C ~/.claude/ledger-data apply /tmp/review.patch',
  'git -C ~/.claude/ledger-data apply --index /tmp/review.patch',
  'git -C ~/.claude/ledger-data apply --stat --apply /tmp/review.patch',
  'git -C ~/.claude/ledger-data apply --check --apply /tmp/review.patch',
];

for (const command of bashCloneGitChanges) {
  test(`Bash ${JSON.stringify(command)} changes the clone, so it is denied`, async () => {
    assert.equal(assertDenied(await gate(gateWorld.plain, 'Bash', { command })), CLONE_GIT_REASON);
  });
}

test('BSD sed -i takes a backup suffix that starts with . or is empty as a word of its own, so the script follows it', async () => {
  const { plain } = gateWorld;
  for (const command of ['cd ~/.claude/ledger-data && sed -i .bak s/a/b/ /tmp/notes', "cd ~/.claude/ledger-data && sed -i '' s/a/b/ /tmp/notes", 'cd ~/.claude/ledger-data && sed -i .orig -e s/a/b/ /tmp/notes']) {
    assertAllowed(await gate(plain, 'Bash', { command }));
  }
  assert.equal(assertDenied(await gate(plain, 'Bash', { command: 'sed -i .bak s/a/b/ ~/.claude/ledgers.json' })), HAND_EDIT_REASON);
  for (const command of ['sed -i .bak s/a/b/ .claude/ledger.md', 'sed -e s/a/b/ -i .claude/ledger.md']) {
    assert.equal(assertDenied(await gate(gateWorld.worktree, 'Bash', { command })), STORE_REASON, command);
  }
});

test('a bare -i after the script, or after -e or -f, takes no backup suffix, so the dot word after it is a file', async () => {
  const { plain } = gateWorld;
  for (const command of ["cd ~/.claude/ledger-data && sed -e 's/old/new/' -i .gitignore", "cd ~/.claude/ledger-data && sed 's/old/new/' -i .gitignore", 'cd ~/.claude/ledger-data && sed -f /tmp/fix.sed -i .gitignore']) {
    assert.equal(assertDenied(await gate(plain, 'Bash', { command })), HAND_EDIT_REASON, command);
  }
});

test('a here-string or here-document before the command word does not hide the command', async () => {
  const { plain } = gateWorld;
  for (const command of ["<<< '{}' tee ~/.claude/ledgers.json", '<<EOF tee ~/.claude/ledgers.json\n{}\nEOF', '<<-EOF tee ~/.claude/ledgers.json\n\t{}\n\tEOF', "<<'EOF' tee ~/.claude/ledgers.json\n{}\nEOF"]) {
    assert.equal(assertDenied(await gate(plain, 'Bash', { command })), HAND_EDIT_REASON, command);
  }
  assertAllowed(await gate(plain, 'Bash', { command: "<<< '{}' tee /tmp/notes" }));
});

test('inside [[ ]] a $( ) in single quotes is literal text, but one in double quotes still runs', async (t) => {
  const h = home(t);
  const clone = path.join(h, '.claude/ledger-data');
  mkdirSync(clone, { recursive: true });
  assertAllowed(await gate(h, 'Bash', { command: `cd ~/.claude/ledger-data && [[ "$line" == '$(touch notes)' ]]` }, h));
  for (const command of ['cd ~/.claude/ledger-data && [[ "$(touch notes)" == x ]]', `[[ "'$(rm ~/.claude/ledgers.json)'" == x ]]`, `[[ '$x' == y && -n $(rm ~/.claude/ledgers.json) ]]`]) {
    assert.equal(assertDenied(await gate(h, 'Bash', { command }, h)), HAND_EDIT_REASON, command);
  }
});

test('a cd in a list that & sends to the background leaves the folder of later commands as it was', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const legacy = worktree(h, main, path.join(h, 'legacy'));
  const inClaude = path.join(legacy, '.claude');
  mkdirSync(inClaude, { recursive: true });
  writeFileSync(path.join(inClaude, 'ledger.md'), ledgerText({ slug: 'legacy', worktree: legacy }));
  for (const command of ['cd .. && npm test &\necho done >> ledger.md', 'cd .. & echo done >> ledger.md', '{ cd ..; npm test; } & echo done >> ledger.md']) {
    assert.equal(assertDenied(await gate(inClaude, 'Bash', { command }, h)), UNMOVED_REASON, command);
  }
  for (const command of ['cd .. && npm test\necho done >> ledger.md', 'cd .. && npm test 2>&1; echo done >> ledger.md', 'cd .. &>/dev/null; echo done >> ledger.md', 'npm test & cd .. && echo done >> ledger.md']) {
    assertAllowed(await gate(inClaude, 'Bash', { command }, h));
  }
});

test('in a worktree that holds a .claude/ledger.md, a glob that ends in / matches only folders, so it does not reach the ledger', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const legacy = worktree(h, main, path.join(h, 'legacy'));
  mkdirSync(path.join(legacy, '.claude/evidence'), { recursive: true });
  writeFileSync(path.join(legacy, '.claude/ledger.md'), ledgerText({ slug: 'legacy', worktree: legacy }));
  assertAllowed(await gate(legacy, 'Bash', { command: 'rm -rf .claude/*/' }, h));
  for (const command of ['rm -rf .claude/*', 'rm -rf .cl*/']) assert.equal(assertDenied(await gate(legacy, 'Bash', { command }, h)), UNMOVED_REASON, command);
});

test('a cd that a ; or a newline ends before a later & runs in the foreground, so it still leads later commands', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const legacy = worktree(h, main, path.join(h, 'legacy'));
  const inClaude = path.join(legacy, '.claude');
  mkdirSync(inClaude, { recursive: true });
  writeFileSync(path.join(inClaude, 'ledger.md'), ledgerText({ slug: 'legacy', worktree: legacy }));
  for (const command of ['cd .claude; true & echo done >> ledger.md', 'cd .claude\ntrue & echo done >> ledger.md', 'cd .claude; sleep 1 & rm ledger.md', 'cd .claude && pwd; true & echo done >> ledger.md']) {
    assert.equal(assertDenied(await gate(legacy, 'Bash', { command }, h)), UNMOVED_REASON, command);
  }
  assert.equal(assertDenied(await gate(gateWorld.plain, 'Bash', { command: 'cd ~/.claude; sleep 1 & rm ledgers.json' })), HAND_EDIT_REASON);
});

test('a cd .. out of .claude that a ; or a newline ends before a later & leads a later write to a file beside .claude, not to the ledger', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const legacy = worktree(h, main, path.join(h, 'legacy'));
  const inClaude = path.join(legacy, '.claude');
  mkdirSync(inClaude, { recursive: true });
  writeFileSync(path.join(inClaude, 'ledger.md'), ledgerText({ slug: 'legacy', worktree: legacy }));
  for (const command of ['cd ..; true & echo done >> ledger.md', 'cd ..\ntrue & echo done >> ledger.md', '{ cd ..; npm test; }; true & echo done >> ledger.md']) {
    assertAllowed(await gate(inClaude, 'Bash', { command }, h));
  }
});

test('a line that ends in &&, || or | goes on with the same list, so an & on the next line sends the cd on the first to the background', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const legacy = worktree(h, main, path.join(h, 'legacy'));
  const inClaude = path.join(legacy, '.claude');
  mkdirSync(inClaude, { recursive: true });
  writeFileSync(path.join(inClaude, 'ledger.md'), ledgerText({ slug: 'legacy', worktree: legacy }));
  for (const command of ['cd .. &&\n true &\n echo done >> ledger.md', 'cd .. ||\n true &\n echo done >> ledger.md', 'cd .. |\n true &\n echo done >> ledger.md', 'cd .. && # up\n true & echo done >> ledger.md']) {
    assert.equal(assertDenied(await gate(inClaude, 'Bash', { command }, h)), UNMOVED_REASON, command);
  }
  for (const command of ['cd .. &&\n true\n echo done >> ledger.md', 'cd .. &&\n true;\n true & echo done >> ledger.md']) assertAllowed(await gate(inClaude, 'Bash', { command }, h));
});

test('a { ... } group that spans lines and runs in the background or a pipeline leaves the folder of later lines as it was', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const legacy = worktree(h, main, path.join(h, 'legacy'));
  const inClaude = path.join(legacy, '.claude');
  mkdirSync(inClaude, { recursive: true });
  writeFileSync(path.join(inClaude, 'ledger.md'), ledgerText({ slug: 'legacy', worktree: legacy }));
  for (const command of ['{ cd ..;\n  true; } &\necho done >> ledger.md', '{\n  cd ..\n} &\necho done >> ledger.md', '{ cd ..;\n  true; } && true &\necho done >> ledger.md', '{ cd ..;\n  true; } | cat\necho done >> ledger.md']) {
    assert.equal(assertDenied(await gate(inClaude, 'Bash', { command }, h)), UNMOVED_REASON, command);
  }
  for (const command of ['{ cd ..;\n  true; }\necho done >> ledger.md', '{\n  cd ..\n}\necho done >> ledger.md', '{ cd ..;\n  true; }; true &\necho done >> ledger.md']) {
    assertAllowed(await gate(inClaude, 'Bash', { command }, h));
  }
});

test('a cd in a pipeline runs in a subshell, so it does not lead later commands', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const legacy = worktree(h, main, path.join(h, 'legacy'));
  const inClaude = path.join(legacy, '.claude');
  mkdirSync(inClaude, { recursive: true });
  writeFileSync(path.join(inClaude, 'ledger.md'), ledgerText({ slug: 'legacy', worktree: legacy }));
  for (const command of ['cd .. |\n  cat\necho done >> ledger.md', 'cd .. | cat; echo done >> ledger.md', 'cd .. |& cat; echo done >> ledger.md', 'true | cd ..; echo done >> ledger.md', '{ cd ..; true; } | cat; echo done >> ledger.md', 'cd .. | tee ledger.md']) {
    assert.equal(assertDenied(await gate(inClaude, 'Bash', { command }, h)), UNMOVED_REASON, command);
  }
  for (const command of ['cd .. && cat x | cat; echo done >> ledger.md', 'cd .. || true | cat; echo done >> ledger.md', 'cd ..; true | cat; echo done >> ledger.md']) {
    assertAllowed(await gate(inClaude, 'Bash', { command }, h));
  }
  for (const command of ['cd .claude |\n  cat\necho done >> ledger.md', 'cd .claude | cat; echo done >> ledger.md']) assertAllowed(await gate(legacy, 'Bash', { command }, h));
  assert.equal(assertDenied(await gate(legacy, 'Bash', { command: 'cd .claude && cat x | tee ledger.md' }, h)), UNMOVED_REASON);
});

test('if ... fi, a loop ... done and case ... esac are groups: piped or in the background they run in a subshell, else a cd in them leads later commands', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const legacy = worktree(h, main, path.join(h, 'legacy'));
  const inClaude = path.join(legacy, '.claude');
  mkdirSync(inClaude, { recursive: true });
  writeFileSync(path.join(inClaude, 'ledger.md'), ledgerText({ slug: 'legacy', worktree: legacy }));
  const subshells = [
    'if true; then cd ..; fi | cat\necho x >> ledger.md',
    'if true; then\n  cd ..\nfi | cat\necho x >> ledger.md',
    'if true; then cd ..; fi &\necho x >> ledger.md',
    'while true; do cd ..; break; done | cat\necho x >> ledger.md',
    'for d in a; do cd ..; done | cat\necho x >> ledger.md',
    'until false; do\n  cd ..\n  break\ndone &\necho x >> ledger.md',
    'if true; then cd ..; fi | cat; echo x >> ledger.md',
    'case x in\n  x)\n    cd ..\n    ;;\nesac | cat\necho x >> ledger.md',
    '{ if true; then cd ..; fi; } | cat\necho x >> ledger.md',
  ];
  for (const command of subshells) assert.equal(assertDenied(await gate(inClaude, 'Bash', { command }, h)), UNMOVED_REASON, command);
  const carried = [
    'if true; then cd ..; fi\necho x >> ledger.md',
    'if true; then\n  cd ..\nfi\necho x >> ledger.md',
    'while true; do cd ..; break; done; echo x >> ledger.md',
    'for d in a; do\n  cd ..\ndone\necho x >> ledger.md',
    'if true; then cd ..; fi; true | cat; echo x >> ledger.md',
    'if true; then cd ..; fi; true & echo x >> ledger.md',
    'case x in\n  x)\n    cd ..\n    ;;\nesac\necho x >> ledger.md',
    'cd ..; case x in x) true;; esac & echo x >> ledger.md',
    'cd ..; case x in (x|y) true;; *) true;; esac\necho x >> ledger.md',
    'cd ..; echo done | cat; echo x >> ledger.md',
  ];
  for (const command of carried) assertAllowed(await gate(inClaude, 'Bash', { command }, h));
});

test('a keyword word that is an argument, as in echo then fi, neither opens nor closes a group', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const legacy = worktree(h, main, path.join(h, 'legacy'));
  const inClaude = path.join(legacy, '.claude');
  mkdirSync(inClaude, { recursive: true });
  writeFileSync(path.join(inClaude, 'ledger.md'), ledgerText({ slug: 'legacy', worktree: legacy }));
  const subshells = [
    '{ echo do done\ncd ..\n} | cat\necho x >> ledger.md',
    '{ echo then fi\ncd ..\n} | cat\necho x >> ledger.md',
    '{\n  echo then fi\n  cd ..\n} &\necho x >> ledger.md',
    'if true; then\n  echo then fi\n  cd ..\nfi | cat\necho x >> ledger.md',
    'if true; then\n  echo do done\n  cd ..\nfi | cat\necho x >> ledger.md',
    'for d in a; do\n  echo do done\n  cd ..\ndone | cat\necho x >> ledger.md',
    'while read x; do\n  echo then fi\n  cd ..\ndone < /dev/null &\necho x >> ledger.md',
    'case a in\n a)\n  echo then esac\n  cd ..\n  ;;\nesac | cat\necho x >> ledger.md',
  ];
  for (const command of subshells) assert.equal(assertDenied(await gate(inClaude, 'Bash', { command }, h)), UNMOVED_REASON, command);
  assertAllowed(await gate(legacy, 'Bash', { command: '{ echo then fi\ncd .claude\n} | cat\necho x >> ledger.md' }, h));
  for (const command of ['echo then fi', 'git commit -m "if done"', 'grep -r for .', 'type if fi done', 'git log --grep done']) assertAllowed(await gate(inClaude, 'Bash', { command }, h));
});

test('a } that is an argument, as in { echo }, does not close the group', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const legacy = worktree(h, main, path.join(h, 'legacy'));
  const inClaude = path.join(legacy, '.claude');
  mkdirSync(inClaude, { recursive: true });
  writeFileSync(path.join(inClaude, 'ledger.md'), ledgerText({ slug: 'legacy', worktree: legacy }));
  assert.equal(assertDenied(await gate(inClaude, 'Bash', { command: '{ echo }\ncd ..\n} | cat\necho x >> ledger.md' }, h)), UNMOVED_REASON);
  for (const command of ['{ cd ..; (true) } | cat\necho x >> ledger.md', '{ cd ..; if true; then true; fi } | cat\necho x >> ledger.md', '{ cd ..; { true; } } | cat\necho x >> ledger.md']) {
    assert.equal(assertDenied(await gate(inClaude, 'Bash', { command }, h)), UNMOVED_REASON, command);
  }
});

test('a } right after a ) closes the group, as in { cd ..; (true)} | cat', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const legacy = worktree(h, main, path.join(h, 'legacy'));
  const inClaude = path.join(legacy, '.claude');
  mkdirSync(inClaude, { recursive: true });
  writeFileSync(path.join(inClaude, 'ledger.md'), ledgerText({ slug: 'legacy', worktree: legacy }));
  assert.equal(assertDenied(await gate(inClaude, 'Bash', { command: '{ cd ..; (true)} | cat\necho x >> ledger.md' }, h)), UNMOVED_REASON);
  assertAllowed(await gate(inClaude, 'Bash', { command: '{ cd ..; (true)}\necho x >> ledger.md' }, h));
});

test('a } right before a redirect closes the group, as in }</dev/null | cat', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const legacy = worktree(h, main, path.join(h, 'legacy'));
  const inClaude = path.join(legacy, '.claude');
  mkdirSync(inClaude, { recursive: true });
  writeFileSync(path.join(inClaude, 'ledger.md'), ledgerText({ slug: 'legacy', worktree: legacy }));
  for (const close of ['}</dev/null', '}>/dev/null', '}>>/tmp/log', '}&>/dev/null']) {
    const command = `{ cd ..\n${close} | cat\necho x >> ledger.md`;
    assert.equal(assertDenied(await gate(inClaude, 'Bash', { command }, h)), UNMOVED_REASON, command);
  }
  assert.equal(assertDenied(await gate(inClaude, 'Bash', { command: '{ cd ..\n}<<EOF | cat\nx\nEOF\necho x >> ledger.md' }, h)), UNMOVED_REASON);
  assertAllowed(await gate(inClaude, 'Bash', { command: '{ cd ..\n}</dev/null\necho x >> ledger.md' }, h));
});

test('the ) that closes a process substitution does not close a group, so <(true)} leaves the { open', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const legacy = worktree(h, main, path.join(h, 'legacy'));
  const inClaude = path.join(legacy, '.claude');
  mkdirSync(inClaude, { recursive: true });
  writeFileSync(path.join(inClaude, 'ledger.md'), ledgerText({ slug: 'legacy', worktree: legacy }));
  for (const first of ['{ cd ..; echo <(true)}', '{ cd ..; echo >(true)}', '{ cd ..; cat <(true)}>/dev/null', '{ cd ..; echo <(true) }']) {
    const command = `${first}\n} | cat\necho x >> ledger.md`;
    assert.equal(assertDenied(await gate(inClaude, 'Bash', { command }, h)), UNMOVED_REASON, command);
  }
});

test('a redirect on the } or fi that closes a group is made where the group started, before its cd', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const legacy = worktree(h, main, path.join(h, 'legacy'));
  const inClaude = path.join(legacy, '.claude');
  mkdirSync(inClaude, { recursive: true });
  writeFileSync(path.join(inClaude, 'ledger.md'), ledgerText({ slug: 'legacy', worktree: legacy }));
  for (const command of ['{ cd ..\n}>ledger.md | cat', '{ cd ..\n}>ledger.md', '{ cd ..; }>ledger.md', 'if true; then cd ..\nfi > ledger.md']) {
    assert.equal(assertDenied(await gate(inClaude, 'Bash', { command }, h)), UNMOVED_REASON, command);
  }
});

test('a redirect on the } that closes a group ignores the cd inside it, so { cd .claude; }>ledger.md misses the store', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const legacy = worktree(h, main, path.join(h, 'legacy'));
  mkdirSync(path.join(legacy, '.claude'), { recursive: true });
  writeFileSync(path.join(legacy, '.claude', 'ledger.md'), ledgerText({ slug: 'legacy', worktree: legacy }));
  for (const command of ['{ cd .claude\n}>ledger.md | cat', '{ cd .claude; }>ledger.md']) {
    assertAllowed(await gate(legacy, 'Bash', { command }, h));
  }
});

/** A worktree whose .claude holds an unmoved ledger.md, and that .claude folder. */
function legacyWorktree(t: TestContext): { h: string; legacy: string; inClaude: string } {
  const h = home(t);
  const legacy = worktree(h, checkout(h, 'main'), path.join(h, 'legacy'));
  const inClaude = path.join(legacy, '.claude');
  mkdirSync(inClaude, { recursive: true });
  writeFileSync(path.join(inClaude, 'ledger.md'), ledgerText({ slug: 'legacy', worktree: legacy }));
  return { h, legacy, inClaude };
}

test('a piped group that spans lines leaves the folder as it was from its }, so a later command in the pipeline is not led by its cd', async (t) => {
  const { h, inClaude } = legacyWorktree(t);
  for (const command of ['{ cd ..\n} | tee ledger.md', '{ cd ..\n}>/dev/null | tee ledger.md', '{ cd ..\n} 2>&1 | tee ledger.md']) {
    assert.equal(assertDenied(await gate(inClaude, 'Bash', { command }, h)), UNMOVED_REASON, command);
  }
});

test('a group that spans lines and runs in the background does not lead the command right after its &, but leads one after && before the &', async (t) => {
  const { h, legacy, inClaude } = legacyWorktree(t);
  assert.equal(assertDenied(await gate(inClaude, 'Bash', { command: '{ cd ..\n} & tee ledger.md' }, h)), UNMOVED_REASON);
  assertAllowed(await gate(legacy, 'Bash', { command: '{ cd .claude\n} & tee ledger.md' }, h));
  assert.equal(assertDenied(await gate(legacy, 'Bash', { command: '{ cd .claude\n} && echo x >> ledger.md &' }, h)), UNMOVED_REASON);
  assertAllowed(await gate(inClaude, 'Bash', { command: '{ cd ..\n} && echo x >> ledger.md &' }, h));
});

test('a group that a pipe on an earlier line leads into runs in a subshell, so its cd does not lead a command after its close', async (t) => {
  const { h, inClaude } = legacyWorktree(t);
  for (const command of ['true | {\ncd ..\n}\necho x >> ledger.md', 'true | { cd ..\n}\necho x >> ledger.md', 'true | while read x; do\ncd ..\ndone\necho x >> ledger.md']) {
    assert.equal(assertDenied(await gate(inClaude, 'Bash', { command }, h)), UNMOVED_REASON, command);
  }
});

test('an & after a group that spans lines sends the cd before the group in its and-or list to the background too', async (t) => {
  const { h, inClaude } = legacyWorktree(t);
  for (const command of ['cd .. && {\npwd\n} & wait\necho x >> ledger.md', 'cd .. && if true; then\npwd\nfi & wait\necho x >> ledger.md']) {
    assert.equal(assertDenied(await gate(inClaude, 'Bash', { command }, h)), UNMOVED_REASON, command);
  }
});

test('an & after groups that span lines sends the cd before them in its and-or list to the background too', async (t) => {
  const { h, legacy } = legacyWorktree(t);
  for (const command of ['cd .claude && (\npwd\n) & wait\necho x >> ledger.md', 'cd .claude && {\npwd\n} && {\npwd\n} & wait\necho x >> ledger.md']) {
    assertAllowed(await gate(legacy, 'Bash', { command }, h));
  }
});

test('an & after a pipe out of a group that spans lines sends the cd before the group in its and-or list to the background too', async (t) => {
  const { h, legacy, inClaude } = legacyWorktree(t);
  assert.equal(assertDenied(await gate(inClaude, 'Bash', { command: 'cd .. && {\npwd\n} | cat &\necho x >> ledger.md' }, h)), UNMOVED_REASON);
  assertAllowed(await gate(legacy, 'Bash', { command: 'cd .claude && {\npwd\n} | cat &\necho x >> ledger.md' }, h));
});

test('a cd .claude in a group that a pipe on an earlier line leads into does not lead a write after its close into .claude', async (t) => {
  const { h, legacy } = legacyWorktree(t);
  for (const command of ['true | {\ncd .claude\n}\necho x >> ledger.md', 'true | { cd .claude\n}\necho x >> ledger.md', 'true | while read x; do\ncd .claude\ndone\necho x >> ledger.md']) {
    assertAllowed(await gate(legacy, 'Bash', { command }, h));
  }
});

test('a cd .claude before a group that spans lines, in the and-or list an & sends to the background, does not lead a later write into .claude', async (t) => {
  const { h, legacy } = legacyWorktree(t);
  for (const command of ['cd .claude && {\npwd\n} & wait\necho x >> ledger.md', 'cd .claude && if true; then\npwd\nfi & wait\necho x >> ledger.md']) {
    assertAllowed(await gate(legacy, 'Bash', { command }, h));
  }
});

test('a cd .claude in a piped group that spans lines does not lead a tee later in the pipeline into .claude', async (t) => {
  const { h, legacy } = legacyWorktree(t);
  assertAllowed(await gate(legacy, 'Bash', { command: '{ cd .claude\n} | tee ledger.md' }, h));
});

test('a process substitution that spans lines stays one word, so the ) that closes it on a later line closes no group', async (t) => {
  const { h, legacy, inClaude } = legacyWorktree(t);
  assertAllowed(await gate(legacy, 'Bash', { command: '{ cd .claude; echo <(\ntrue) }\n} | cat\necho x >> ledger.md' }, h));
  assert.equal(assertDenied(await gate(inClaude, 'Bash', { command: '{ cd ..; echo <(\ntrue) }\n} | cat\necho x >> ledger.md' }, h)), UNMOVED_REASON);
});

test('a redirect attached to the fi, done or esac that closes a group is made where the group started', async (t) => {
  const { h, legacy, inClaude } = legacyWorktree(t);
  for (const command of ['if true; then cd .claude\nfi>ledger.md | cat', 'for x in a; do cd .claude\ndone>ledger.md | cat', 'case x in\nx)\ncd .claude\n;;\nesac>ledger.md | cat']) {
    assertAllowed(await gate(legacy, 'Bash', { command }, h));
  }
  for (const command of ['if true; then cd ..\nfi>ledger.md | cat', 'for x in a; do cd ..\ndone>ledger.md | cat', 'case x in\nx)\ncd ..\n;;\nesac>ledger.md | cat']) {
    assert.equal(assertDenied(await gate(inClaude, 'Bash', { command }, h)), UNMOVED_REASON, command);
  }
});

test('every redirect word on the } that closes a group, a command substitution in it and one after a >(...) too, is made where the group started', async (t) => {
  const { h, legacy, inClaude } = legacyWorktree(t);
  for (const command of ['{ cd .claude\n}>$(echo log > ledger.md; echo output)', '{ cd .claude\n} > >(cat) >ledger.md']) {
    assertAllowed(await gate(legacy, 'Bash', { command }, h));
  }
  for (const command of ['{ cd ..\n}>$(echo log > ledger.md; echo output)', '{ cd ..\n} > >(cat) >ledger.md']) {
    assert.equal(assertDenied(await gate(inClaude, 'Bash', { command }, h)), UNMOVED_REASON, command);
  }
});

test('a quoted ]] inside [[ ]] is pattern text, so the conditional goes on past it', async () => {
  const { worktree: linked } = gateWorld;
  for (const command of [`[[ "$line" == *' ]] '* ]] && echo done >> .claude/ledger.md`, `[[ "$line" == *" ]] "* ]] && echo done >> .claude/ledger.md`, `[[ $x == *\\ ]] ]] && echo done >> .claude/ledger.md`]) {
    assert.equal(assertDenied(await gate(linked, 'Bash', { command })), STORE_REASON, command);
  }
  assertAllowed(await gate(linked, 'Bash', { command: `[[ "$line" == *' ]] '* ]] && echo done >> /tmp/notes` }));
});

test("in $'...' a backslash escapes the next character, so an escaped ' does not end the quote", async () => {
  const { worktree: linked } = gateWorld;
  for (const command of [`echo $'a\\'b' && echo x >> .claude/ledger.md`, `echo $'a\\\\' && echo x >> .claude/ledger.md`, `[[ $x == $'a\\'b' ]] && echo x >> .claude/ledger.md`, `[[ $x == $'a\\' ]] ' ]] && echo x >> .claude/ledger.md`, `echo "$'" && echo x >> .claude/ledger.md`]) {
    assert.equal(assertDenied(await gate(linked, 'Bash', { command })), STORE_REASON, command);
  }
  assertAllowed(await gate(linked, 'Bash', { command: `echo $'a\\'; echo x >> .claude/ledger.md'` }));
});

test("an unescaped $$ is one word, so a ' after it opens a plain quote, not $'...'", async () => {
  const { worktree: linked } = gateWorld;
  for (const command of [`echo $$'\\' ; echo x >> .claude/ledger.md #'`, `[[ $$'\\' == ' ]] ' ]] && echo x >> .claude/ledger.md`]) {
    assert.equal(assertDenied(await gate(linked, 'Bash', { command })), STORE_REASON, command);
  }
  assertAllowed(await gate(linked, 'Bash', { command: `echo $$'\\' '> .claude/ledger.md'` }));
});

test('in a .claude folder with a ledger, a glob segment followed by another segment matches only folders, so a write through it misses the ledger', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const legacy = worktree(h, main, path.join(h, 'legacy'));
  mkdirSync(path.join(legacy, '.claude/sub'), { recursive: true });
  writeFileSync(path.join(legacy, '.claude/ledger.md'), ledgerText({ slug: 'legacy', worktree: legacy }));
  for (const command of ['cp x .claude/*/', 'cp x .claude/*/x', 'touch .claude/l*/x', 'rm -rf .claude/*/x']) assertAllowed(await gate(legacy, 'Bash', { command }, h));
  for (const command of ['rm -rf .claude/*', 'rm -rf .claude/l*', 'cp x .claude/l*']) assert.equal(assertDenied(await gate(legacy, 'Bash', { command }, h)), UNMOVED_REASON, command);
});

test('an empty word after a bare -i is the BSD backup suffix even after the script, as no file has an empty name', async () => {
  const { plain } = gateWorld;
  for (const command of ["cd ~/.claude/ledger-data && sed -e 's/old/new/' -i '' /tmp/notes", 'cd ~/.claude/ledger-data && sed s/a/b/ -i "" /tmp/notes']) assertAllowed(await gate(plain, 'Bash', { command }));
  for (const command of ["cd ~/.claude/ledger-data && sed -e 's/old/new/' -i '' notes.md", "cd ~/.claude/ledger-data && sed -e 's/old/new/' -i .gitignore"]) {
    assert.equal(assertDenied(await gate(plain, 'Bash', { command })), HAND_EDIT_REASON, command);
  }
});

test('a > or < inside [[ ]] compares strings and redirects nothing, but a command substitution in it still runs', async (t) => {
  const h = home(t);
  const clone = path.join(h, '.claude/ledger-data');
  mkdirSync(clone, { recursive: true });
  for (const command of ['cd ~/.claude/ledger-data && [[ b > a ]]', '[[ b > a ]] && echo ok', 'if [[ a < b ]]; then echo ok; fi']) assertAllowed(await gate(clone, 'Bash', { command }, h));
  for (const command of ['[[ -n "$(rm ~/.claude/ledgers.json)" ]]', '[[ b > a ]] && rm ~/.claude/ledgers.json', 'if [[ a < b ]]; then rm ~/.claude/ledgers.json; fi']) {
    assert.equal(assertDenied(await gate(h, 'Bash', { command }, h)), HAND_EDIT_REASON, command);
  }
});

test('a cd inside a subshell that spans lines ends at the line that closes it', async () => {
  const { h, plain } = gateWorld;
  for (const command of ['(cd /tmp\npwd)\nrm .claude/ledgers.json', '(\n  cd /tmp\n  pwd\n)\nrm .claude/ledgers.json', '(cd /tmp\n(cd /var; pwd)\npwd)\nrm .claude/ledgers.json', '(cd /tmp\npwd); rm .claude/ledgers.json']) {
    assert.equal(assertDenied(await gate(h, 'Bash', { command })), HAND_EDIT_REASON, command);
  }
  for (const command of ['(cd ~/.claude\npwd)\nprintf x > ledgers.json', '(cd ~/.claude\n(pwd)\nls)\nrm ledgers.json']) assertAllowed(await gate(plain, 'Bash', { command }));
});

test('in a worktree that holds a .claude/ledger.md, a glob that matches it and a removal of a folder above it are denied', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const legacy = worktree(h, main, path.join(h, 'legacy'));
  const clean = worktree(h, main, path.join(h, 'clean'));
  for (const folder of [legacy, clean]) mkdirSync(path.join(folder, '.claude/evidence'), { recursive: true });
  writeFileSync(path.join(legacy, '.claude/ledger.md'), ledgerText({ slug: 'legacy', worktree: legacy }));

  const removals = ['rm -f .claude/ledger.*', 'rm -r .claude', 'rm -rf .cl*', 'rmdir .claude', `rm -r ${legacy}`, 'mv .claude /tmp/claude-old'];
  for (const command of removals) assert.equal(assertDenied(await gate(legacy, 'Bash', { command }, h)), UNMOVED_REASON, command);
  assert.equal(assertDenied(await gate(h, 'Bash', { command: 'rm -r legacy/.claude' }, h)), UNMOVED_REASON);
  for (const command of ['rm -f .claude/notes.*', 'rm -r .claude/evidence', 'rm -f .claude/ledger.m?.bak']) assertAllowed(await gate(legacy, 'Bash', { command }, h));
  for (const command of removals.slice(0, 4)) assertAllowed(await gate(clean, 'Bash', { command }, h));
});

test('a redirect before the command word does not hide the command', async () => {
  const { plain } = gateWorld;
  for (const command of ['2>/dev/null rm -f ~/.claude/ledgers.json', '>/tmp/log rm ~/.claude/ledgers.json', '2>&1 rm ~/.claude/ledgers.json', '</dev/null cp /tmp/x ~/.claude/ledgers.json', '2> /dev/null cd ~/.claude && rm ledgers.json', 'ls; 2>/dev/null rm ~/.claude/ledgers.json']) {
    assert.equal(assertDenied(await gate(plain, 'Bash', { command })), HAND_EDIT_REASON, command);
  }
  assert.equal(assertDenied(await gate(gateWorld.worktree, 'Bash', { command: '2>/dev/null rm .claude/ledger.md' })), STORE_REASON);
  assertAllowed(await gate(plain, 'Bash', { command: '2>/dev/null rm -f /tmp/x' }));
});

test('the -P, -L, -e and -@ options of cd come before its folder', async () => {
  const { h, plain } = gateWorld;
  for (const command of ['cd -P && rm .claude/ledgers.json', 'cd -L ~ && rm .claude/ledgers.json', 'cd -P ~/.claude && rm ledgers.json', 'cd -Pe -- ~/.claude; rm ledgers.json', 'cd -@ ~/.claude && rm ledgers.json']) {
    assert.equal(assertDenied(await gate(plain, 'Bash', { command })), HAND_EDIT_REASON, command);
  }
  assertAllowed(await gate(path.join(h, '.claude'), 'Bash', { command: 'cd -P /tmp && rm ledgers.json' }));
});

test('a file tool path is literal: a * or ? in it is part of the name, not a glob', async () => {
  const { h, plain } = gateWorld;
  for (const file of ['.claude/ledger-*', '.claude/ledgers.jso?', '.claude/ledger-acti?e/main/task.md', '.claude/ledgers.db-[ws]al', '.claude/*/main/task.md']) {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) assertAllowed(await gate(plain, tool, writing(tool, path.join(h, file), '- a note')));
  }
});

test('truncate of a .claude/ledger.md is denied, as touch is', async () => {
  for (const command of ['truncate -s 0 .claude/ledger.md', 'truncate --size=0 .claude/ledger.md']) {
    for (const folder of [gateWorld.main, gateWorld.worktree]) {
      assert.equal(assertDenied(await gate(folder, 'Bash', { command })), STORE_REASON, `${command} in ${folder}`);
    }
  }
});

test('>& before a word that is no file descriptor redirects to that word, as &> and &>> do', async () => {
  for (const command of ['printf x >& ~/.claude/ledgers.json', 'printf x >&~/.claude/ledgers.json', 'printf x &> ~/.claude/ledgers.json', 'printf x &>> ~/.claude/ledgers.json']) {
    assert.equal(assertDenied(await gate(gateWorld.plain, 'Bash', { command })), HAND_EDIT_REASON, command);
  }
});

test('>& before a file descriptor or - duplicates or closes it, so it writes no file', async (t) => {
  const h = home(t);
  const clone = path.join(h, '.claude/ledger-data');
  mkdirSync(clone, { recursive: true });
  for (const command of ['echo x >&2', 'ls 2>&1 | head', 'echo x 1>& 2', 'exec 3>&-', 'echo x >&2; ls']) assertAllowed(await gate(clone, 'Bash', { command }, h));
});

test('a bare cd, or cd --, leads to HOME', async () => {
  const { h, plain } = gateWorld;
  for (const command of ['cd && rm .claude/ledgers.json', 'cd\nrm .claude/ledgers.json', 'cd; printf x > .claude/ledgers.json', 'cd ~ && rm .claude/ledgers.json', '(cd && rm .claude/ledgers.json)', 'cd -- && rm .claude/ledgers.json']) {
    assert.equal(assertDenied(await gate(plain, 'Bash', { command })), HAND_EDIT_REASON, command);
  }
  const claude = path.join(h, '.claude');
  for (const command of ['cd && rm ledgers.json', 'cd; printf x > ledgers.json']) assertAllowed(await gate(claude, 'Bash', { command }));
  assert.equal(assertDenied(await gate(claude, 'Bash', { command: 'cdx && rm ledgers.json' })), HAND_EDIT_REASON);
});

test('a shell keyword before a command does not hide it', async () => {
  const commands = [
    'if rm ~/.claude/ledgers.json; then echo ok; fi',
    'if true; then :; elif rm ~/.claude/ledgers.json; then :; fi',
    'while rm ~/.claude/ledgers.json; do sleep 1; done',
    'until rm ~/.claude/ledgers.json; do sleep 1; done',
    '! rm ~/.claude/ledgers.json',
    'time rm ~/.claude/ledgers.json',
    'time -p touch ~/.claude/ledgers.json',
  ];
  for (const command of commands) assert.equal(assertDenied(await gate(gateWorld.plain, 'Bash', { command })), HAND_EDIT_REASON, command);
});

test('git fetch in the clone is denied when it prunes, forces or names a refspec that writes a ref', async () => {
  const { plain } = gateWorld;
  for (const args of ['--prune', '-p', '--force', '-f', '-fp', '--prune-tags', 'origin --prune','origin main:main', 'origin +main', 'origin +refs/heads/*:refs/remotes/origin/*', 'origin refs/heads/main:refs/heads/side']) {
    const command = `git -C ~/.claude/ledger-data fetch ${args}`;
    assert.equal(assertDenied(await gate(plain, 'Bash', { command })), CLONE_GIT_REASON, command);
  }
  for (const args of ['', ' origin', ' --quiet origin', ' origin main']) {
    assertAllowed(await gate(plain, 'Bash', { command: `git -C ~/.claude/ledger-data fetch${args}` }));
  }
});

test('the read-only git commands are allowed in the clone, and config and tag only when they read', async () => {
  const { plain } = gateWorld;
  const reads = [
    'grep -n Goal',
    'ls-files',
    'ls-tree -r HEAD',
    'cat-file -p HEAD',
    'show-ref',
    'describe --always',
    'ls-remote origin',
    'stash show -p',
    'worktree list',
    'config --get remote.origin.url',
    'config --get-all core.hooksPath',
    'config --get-regexp ^remote',
    'config --list',
    'config -l',
    'config --local --list',
    'config remote.origin.url',
    'tag',
    'tag -l',
    'tag --list',
    "tag -l 'v*'",
  ];
  for (const args of reads) assertAllowed(await gate(plain, 'Bash', { command: `git -C ~/.claude/ledger-data ${args}` }));
  const writes = [
    'config core.hooksPath /tmp/hooks',
    'config --unset core.hooksPath',
    'config --add user.name x',
    'config --unset-all remote.origin.fetch',
    'config --edit',
    'tag v1',
    'tag -d v1',
    'tag -a v1 -m x',
    'tag -f v1 HEAD~1',
    'worktree add /tmp/side',
    'worktree remove /tmp/side',
    'stash drop',
  ];
  for (const args of writes) {
    const command = `git -C ~/.claude/ledger-data ${args}`;
    assert.equal(assertDenied(await gate(plain, 'Bash', { command })), CLONE_GIT_REASON, command);
  }
});

test('git --output on log, show or diff is judged by the file it writes, in any repository', async () => {
  const { main, plain } = gateWorld;
  for (const command of [
    'git -C ~/.claude/ledger-data diff --output=/tmp/review.patch',
    'git -C ~/.claude/ledger-data log --output=/tmp/log',
    'git -C ~/.claude/ledger-data show --output /tmp/show HEAD',
    'git -C ~/.claude/ledger-data diff --output=/tmp/diff',
  ]) {
    assertAllowed(await gate(plain, 'Bash', { command }));
  }
  for (const command of [
    'git log --output="$HOME/.claude/ledgers.json"',
    'git diff --output ~/.claude/ledger-active/main/task.md',
    'git -C ~/.claude show --output=ledgers.json HEAD',
    'git -C ~/.claude diff-tree --output=ledgers.json -r HEAD',
  ]) {
    assert.equal(assertDenied(await gate(main, 'Bash', { command })), HAND_EDIT_REASON, command);
  }
});

test('git clone into a store path is denied, as is reflog write in the clone', async () => {
  const { plain } = gateWorld;
  for (const command of ['git clone /tmp/data.git ~/.claude/ledger-data', 'git clone --depth 1 -b main /tmp/data.git "$HOME/.claude/ledger-data"', 'cd ~/.claude && git clone /tmp/data.git ledger-data']) {
    assert.equal(assertDenied(await gate(plain, 'Bash', { command })), HAND_EDIT_REASON, command);
  }
  for (const command of ['git clone ~/.claude/ledger-data /tmp/copy', 'git clone -b main ~/.claude/ledger-data', 'git -C ~/.claude/ledger-data clone . /tmp/copy']) {
    assertAllowed(await gate(plain, 'Bash', { command }));
  }
  assert.equal(assertDenied(await gate(plain, 'Bash', { command: 'git -C ~/.claude/ledger-data reflog write HEAD 0000 x' })), CLONE_GIT_REASON);
});

test('tee options are not files, and sed -i writes only its file operands, not a script or a suffix', async (t) => {
  const h = home(t);
  const clone = path.join(h, '.claude/ledger-data');
  mkdirSync(clone, { recursive: true });
  for (const command of ['echo x | tee -a /tmp/notes.log', 'echo x | tee -i -a /tmp/notes.log > /dev/null', "sed -i '' 's/a/b/' /tmp/notes", 'sed -i -e s/a/b/ /tmp/notes']) {
    assertAllowed(await gate(clone, 'Bash', { command }, h));
  }
  const { plain } = gateWorld;
  for (const command of ['sed -i.bak -f ~/.claude/ledger-data/fix.sed /tmp/notes', 'sed -i -e s/a/b/ -f ~/.claude/ledger-data/fix.sed /tmp/notes', 'sed -i --expression=s/a/b/ --file ~/.claude/ledgers.json /tmp/notes', 'sed -ne s/a/b/p -i /tmp/notes']) {
    assertAllowed(await gate(plain, 'Bash', { command }));
  }
  for (const command of ['sed -i.bak -f /tmp/fix.sed ~/.claude/ledgers.json', "sed -i '' -e s/a/b/ /tmp/notes ~/.claude/ledgers.json", 'sed --in-place s/a/b/ ~/.claude/ledgers.json', 'sed -E -i s/a/b/ ~/.claude/ledgers.json']) {
    assert.equal(assertDenied(await gate(plain, 'Bash', { command })), HAND_EDIT_REASON, command);
  }
});

test('ln with one operand links its name into the folder it runs in', async () => {
  const { h, plain } = gateWorld;
  for (const command of ['ln -s ~/.claude/ledgers.json', 'ln ~/.claude/ledger-active/main/task.md']) assertAllowed(await gate(plain, 'Bash', { command }));
  for (const command of ['ln -sf /tmp/ledgers.json', 'ln -s "/tmp/ledger-aliases.json"']) {
    assert.equal(assertDenied(await gate(path.join(h, '.claude'), 'Bash', { command })), HAND_EDIT_REASON, command);
  }
});

test('cd - leaves the folder a write is resolved against as it was', async () => {
  assert.equal(assertDenied(await gate(path.join(gateWorld.h, '.claude'), 'Bash', { command: 'cd - && rm ledgers.json' })), HAND_EDIT_REASON);
});

test('the hooks source writes its private-use mask characters as escapes', () => {
  const source = readFileSync(path.join(REPO, 'tools/ledger/hooks.ts'), 'utf8');
  assert.equal(/[\uE000-\uF8FF]/.test(source), false, 'a raw private-use character is in tools/ledger/hooks.ts');
});

// PreToolUse: the worktree gate

/** A main checkout with the worktree <main>/.claude/worktrees/task, which holds a ledger. */
function removal(t: TestContext) {
  const h = home(t);
  const main = checkout(h, 'main');
  const task = worktree(h, main, path.join(main, '.claude/worktrees/task'));
  ledgerIn(h, task, ledgerText({ slug: 'task', main, worktree: task }));
  return { h, main, task };
}

const removalReason = (main: string, ...folders: string[]): string =>
  [
    `This would remove a worktree whose task ledger is not archived:${folders.map((folder) => ` ${folder}`).join('')}`,
    '',
    'The ledger is the record of the task. The worktree is not.',
    'Retire it instead, which archives the ledger and then removes the worktree:',
    `  ${BIN} task retire <slug>`,
    '',
    `Archived ledgers of ${path.basename(main)} live in ~/.claude/ledger-archive/${encodeURIComponent(main)}/.`,
  ].join('\n');

test('removing a worktree whose ledger is not archived is denied, naming ledger retire', async (t) => {
  const { h, main, task } = removal(t);

  assert.equal(assertDenied(await gate(main, 'Bash', { command: 'git worktree remove .claude/worktrees/task' }, h)), removalReason(main, task));
});

test('each way of naming the worktree in a removal is denied', async (t) => {
  const { h, main, task } = removal(t);
  const commands = [
    `git worktree remove --force ${task}`,
    `rm -rf ${task}/`,
    `rm -fr '${task}'`,
    `rm -rf "${task}"`,
    `rm -rf ~/${path.relative(h, task)}`,
    'cd /tmp && rm -rf .claude/worktrees/task',
  ];
  for (const command of commands) assert.equal(assertDenied(await gate(main, 'Bash', { command }, h)), removalReason(main, task), command);
});

test('removing a worktree whose ledger is archived is allowed', async (t) => {
  const { h, main, task } = removal(t);
  archiveCopy(h, 'main', '2026-11-01-task', ledgerText({ slug: 'task', main, worktree: task }));

  assertAllowed(await gate(main, 'Bash', { command: `git worktree remove ${task}` }, h));
  assertAllowed(await gate(main, 'Bash', { command: `rm -rf ${task}` }, h));
});

test('an archive copy of another worktree whose path starts with the same text does not count', async (t) => {
  const { h, main, task } = removal(t);
  archiveCopy(h, 'main', '2026-11-01-task-old', ledgerText({ slug: 'task-old', main, worktree: `${task}-old` }));

  assert.equal(assertDenied(await gate(main, 'Bash', { command: `rm -rf ${task}` }, h)), removalReason(main, task));
});

test('a removal by the retire commands is allowed', async (t) => {
  const { h, main, task } = removal(t);

  assertAllowed(await gate(main, 'Bash', { command: `${BIN} task retire task && git worktree remove ${task}` }, h));
  assertAllowed(await gate(main, 'Bash', { command: `ledger task retire task --force; rm -rf ${task}` }, h));
});

test('a removal named only in quotes, a here-document body or a comment is data, not a removal', async (t) => {
  const { h, main, task } = removal(t);

  for (const command of [`ledger notes decide 'example: rm -rf ${task} here'`, `git commit -m "do not rm -rf ${task}"`, `cat <<EOF > /tmp/notes\nrm -rf ${task}\nEOF`, `echo done # rm -rf ${task}`]) {
    assertAllowed(await gate(main, 'Bash', { command }, h));
  }
  for (const command of [`rm -rf ${task}`, `echo "$(rm -rf ${task})"`, `rm -rf \\\n  ${task}`]) {
    assert.equal(assertDenied(await gate(main, 'Bash', { command }, h)), removalReason(main, task), command);
  }
});

test('a removal in a command substitution of an unquoted here-document body is denied; in a quoted one it is data', async (t) => {
  const { h, main, task } = removal(t);

  assert.equal(assertDenied(await gate(main, 'Bash', { command: `cat <<EOF\n$(git worktree remove ${task} && echo removed)\nEOF` }, h)), removalReason(main, task));
  assertAllowed(await gate(main, 'Bash', { command: `cat <<'EOF'\n$(git worktree remove ${task} && echo removed)\nEOF` }, h));
});

test('a removal that names the deleted cc-worktree-retire script is denied', async (t) => {
  const { h, main, task } = removal(t);

  assert.equal(assertDenied(await gate(main, 'Bash', { command: `bin/cc-worktree-retire ${task}; rm -rf ${task}` }, h)), removalReason(main, task));
});

test('a removal that names the worktree by a glob is denied, as bash expands the glob', async (t) => {
  const { h, main, task } = removal(t);

  for (const glob of ['.claude/worktrees/*', '.claude/worktrees/ta?k', '.claude/worktrees/[st]ask', '.claude/worktrees/[!x]ask', '.claude/*/task', `${main}/.claude/worktrees/*`, '.claude/worktrees/*/']) {
    assert.equal(assertDenied(await gate(main, 'Bash', { command: `rm -rf ${glob}` }, h)), removalReason(main, task), glob);
  }
});

test('a glob with a POSIX class, equivalence class or collating symbol in a bracket is denied, as bash expands it', async (t) => {
  const { h, main, task } = removal(t);

  for (const glob of ['[[:alnum:]]ask', '[[:alpha:]]ask', 't[[:lower:]]sk', '[![:digit:]]ask', '[=t=]ask', '[.t.]ask', '[[:alpha:]]*']) {
    assert.equal(assertDenied(await gate(main, 'Bash', { command: `rm -rf .claude/worktrees/${glob}` }, h)), removalReason(main, task), glob);
  }
});

test('a glob with a POSIX class over folders without a ledger is allowed', async (t) => {
  const { h, main } = removal(t);
  mkdirSync(path.join(main, 'build/cache'), { recursive: true });

  assertAllowed(await gate(main, 'Bash', { command: 'rm -rf build/[[:alpha:]]*' }, h));
});

test('a bracket in a glob matches one character of its class, so a POSIX class that no store file has there misses the store', async () => {
  for (const command of ['touch ~/.claude/ledger[[:digit:]].json', 'touch ~/.claude/ledger[[:upper:]].json', 'touch ~/.claude/ledger[![:alpha:]].json']) {
    assertAllowed(await gate(gateWorld.plain, 'Bash', { command }));
  }
  for (const command of ['touch ~/.claude/ledger[[:lower:]].json', 'touch ~/.claude/ledger[![:digit:]].json', 'touch ~/.claude/ledger[[:digit:][:alpha:]].json', 'touch ~/.claude/ledger[=s=].json']) {
    assertDenied(await gate(gateWorld.plain, 'Bash', { command }));
  }
});

test('an escaped dash in a bracket class is a literal dash, not a range', async () => {
  assertAllowed(await gate(gateWorld.plain, 'Bash', { command: 'touch ~/.claude/ledger[a\\-z].json' }));
  assertDenied(await gate(gateWorld.plain, 'Bash', { command: 'touch ~/.claude/ledger[a\\-s].json' }));
});

test('a file command asked for its help or version writes nothing', async () => {
  for (const command of ['cp --help ~/.claude/ledgers.json', 'mv --version ~/.claude/ledgers.json', 'rm --help ~/.claude/ledger-data', 'touch --help ~/.claude/ledgers.json', 'tee --version ~/.claude/ledgers.json']) {
    assertAllowed(await gate(gateWorld.plain, 'Bash', { command }));
  }
});

test('a --help or --version after an operand is a file name, as BSD tools stop reading options at the first operand', async () => {
  assert.equal(assertDenied(await gate(gateWorld.main, 'Bash', { command: 'tee .claude/ledger.md --help < /dev/null' })), STORE_REASON);
  for (const command of ['rm ~/.claude/ledgers.json --help', 'touch ~/.claude/ledgers.json --help', 'rm -rf ~/.claude/ledger-data --version', 'mkdir ~/.claude/ledger-active/x --help']) {
    assert.equal(assertDenied(await gate(gateWorld.plain, 'Bash', { command })), HAND_EDIT_REASON, command);
  }
});

test('a { that is an argument opens no group, so the & after the group backgrounds the cd before it', async () => {
  const command = 'cd .. && {\n  echo {\n} & wait\nprintf x >> ledger.md';
  assert.equal(assertDenied(await gate(path.join(gateWorld.main, '.claude'), 'Bash', { command })), STORE_REASON);
});

test('a --version inside a process substitution is not an option of the tee that reads it', async () => {
  assert.equal(assertDenied(await gate(gateWorld.main, 'Bash', { command: 'tee .claude/ledger.md < <(git --version)' })), STORE_REASON);
});

test('a here-document delimiter is read after quote removal, so the body ends at its unquoted line', async () => {
  assert.equal(assertDenied(await gate(gateWorld.main, 'Bash', { command: "cat <<'E'OF\nbody\nEOF\nprintf x >> .claude/ledger.md" })), STORE_REASON);
});

test('command -v cd only describes cd, so it changes no folder', async () => {
  assert.equal(assertDenied(await gate(path.join(gateWorld.main, '.claude'), 'Bash', { command: 'command -v cd\nprintf x >> ledger.md' })), STORE_REASON);
});

test('a redirect between git arguments is no argument, so -h stays the only one', async (t) => {
  const h = home(t);
  const clone = path.join(h, '.claude/ledger-data');
  mkdirSync(clone, { recursive: true });
  assertAllowed(await gate(clone, 'Bash', { command: 'git reset 2>&1 -h' }, h));
});

test('git version only reads, so it is allowed in the clone', async (t) => {
  const h = home(t);
  const clone = path.join(h, '.claude/ledger-data');
  mkdirSync(clone, { recursive: true });
  assertAllowed(await gate(clone, 'Bash', { command: 'git version' }, h));
});

test('command -v or -V describes the cd it names after a --, more options or a redirect, so it changes no folder', async () => {
  for (const command of ['command -v -- cd\nprintf x >> ledger.md', 'command -v -- cd; printf x >> ledger.md', 'command -V -- cd\nprintf x >> ledger.md', 'command -v >/dev/null cd\nprintf x >> ledger.md']) {
    assert.equal(assertDenied(await gate(path.join(gateWorld.main, '.claude'), 'Bash', { command })), STORE_REASON, command);
  }
});

test("a here-document delimiter in $'...' or with an escape inside double quotes ends the body at its unquoted line", async () => {
  for (const command of ["cat <<$'EOF'\nbody\nEOF\nprintf x >> .claude/ledger.md", 'cat <<"END\\$"\nbody\nEND$\nprintf x >> .claude/ledger.md']) {
    assert.equal(assertDenied(await gate(gateWorld.main, 'Bash', { command })), STORE_REASON, command);
  }
});

test('time and coproc before a { open a group, so the & or pipe after it runs the cd inside in a subshell', async () => {
  const commands = [
    'time {\n  cd ..\n} & wait\nprintf x >> ledger.md',
    'time {\n  cd ..\n} | cat\nprintf x >> ledger.md',
    'time -p {\n  cd ..\n} & wait\nprintf x >> ledger.md',
    'time { cd ..\n} & wait\nprintf x >> ledger.md',
    'cd .. && time {\n  :\n} & wait\nprintf x >> ledger.md',
    'coproc {\n  cd ..\n}\nprintf x >> ledger.md',
  ];
  for (const command of commands) {
    assert.equal(assertDenied(await gate(path.join(gateWorld.main, '.claude'), 'Bash', { command })), STORE_REASON, command);
  }
});

test('a { after the ) of a process substitution is an argument, while one after f() opens a group', async () => {
  const dotclaude = path.join(gateWorld.main, '.claude');
  assert.equal(assertDenied(await gate(dotclaude, 'Bash', { command: 'cd .. && {\n  echo <(true) {\n} & wait\nprintf x >> ledger.md' })), STORE_REASON);
  assert.equal(assertDenied(await gate(dotclaude, 'Bash', { command: 'f() {\n  cd ..\n} & wait\nprintf x >> ledger.md' })), STORE_REASON);
});

test('an &>, &>> or <& redirect between git arguments is no argument, so -h stays the only one', async (t) => {
  const h = home(t);
  const clone = path.join(h, '.claude/ledger-data');
  mkdirSync(clone, { recursive: true });
  for (const command of ['git reset &>/dev/null -h', 'git reset &>>/dev/null -h', 'git reset 0<& 0 -h']) {
    assertAllowed(await gate(clone, 'Bash', { command }, h));
  }
});

test('git help only reads, so it is allowed on the clone', async (t) => {
  const h = home(t);
  mkdirSync(path.join(h, '.claude/ledger-data'), { recursive: true });
  assertAllowed(await gate(h, 'Bash', { command: 'git -C ~/.claude/ledger-data help reset' }, h));
});

test('command -v or -V does not run the command it names', async () => {
  assertAllowed(await gate(gateWorld.h, 'Bash', { command: 'command -v touch ~/.claude/ledgers.json' }));
});

test('a --help or --version before the first operand, after options only, writes nothing; after a -- it is an operand', async () => {
  assertAllowed(await gate(gateWorld.h, 'Bash', { command: 'rm -f --help ~/.claude/ledgers.json' }));
  assert.equal(assertDenied(await gate(gateWorld.h, 'Bash', { command: 'rm -- --help ~/.claude/ledgers.json' })), HAND_EDIT_REASON);
});

test('cp of a store file with a --help after it reads the store and writes a file named --help', async () => {
  assertAllowed(await gate(gateWorld.h, 'Bash', { command: 'cp ~/.claude/ledgers.json --help' }));
});

test('the words of a process substitution are not file arguments of the command that reads it', async () => {
  assertAllowed(await gate(gateWorld.main, 'Bash', { command: 'tee < <(cat ~/.claude/ledgers.json) /dev/null' }));
});

test("a here-document delimiter in $'...' is read with its escapes decoded", async () => {
  assert.equal(assertDenied(await gate(gateWorld.main, 'Bash', { command: "cat <<$'END\\x31'\nbody\nEND1\nprintf x >> .claude/ledger.md" })), STORE_REASON);
});

test('a cd to a path that is no folder fails and changes no folder', async () => {
  assert.equal(assertDenied(await gate(path.join(gateWorld.main, '.claude'), 'Bash', { command: 'cd /dev/null\nprintf x >> ledger.md' })), STORE_REASON);
});

test('a --help or --version that is the value of an option is no info option, so the command still writes', async () => {
  for (const command of ['cp -S --help /etc/hosts .claude/ledger.md', 'mv -S --help /etc/hosts .claude/ledger.md', 'cp --suffix --help /etc/hosts .claude/ledger.md']) {
    assert.equal(assertDenied(await gate(gateWorld.main, 'Bash', { command })), STORE_REASON, command);
  }
});

test('a --help or --version after an option and its value, before the first operand, writes nothing', async () => {
  for (const command of ['cp -t .claude --help ledger.md', 'cp -t .claude --version ledger.md', 'mv -t .claude --help ledger.md', 'ln -t .claude --help ledger.md']) {
    assertAllowed(await gate(gateWorld.main, 'Bash', { command }));
  }
});

test('git symbolic-ref with no new value only reads, while setting or deleting one is denied', async (t) => {
  const h = home(t);
  const clone = path.join(h, '.claude/ledger-data');
  mkdirSync(clone, { recursive: true });
  assertAllowed(await gate(clone, 'Bash', { command: 'git symbolic-ref --short HEAD' }, h));
  for (const command of ['git symbolic-ref HEAD refs/heads/x', 'git symbolic-ref -d HEAD']) {
    assertDenied(await gate(clone, 'Bash', { command }, h));
  }
});

test('the folder after mv -t is where mv moves to, not a source it removes, while each operand is a source', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  mkdirSync(path.join(main, '.claude'), { recursive: true });
  writeFileSync(path.join(main, '.claude/ledger.md'), ledgerText({ slug: 'main' }));
  for (const command of ['mv -t .claude notes.txt', 'mv --target-directory .claude notes.txt', 'mv --target-directory=.claude notes.txt', 'mv -ft .claude notes.txt']) {
    assertAllowed(await gate(main, 'Bash', { command }, h));
  }
  for (const command of ['mv -t /tmp .claude/ledger.md', 'mv -t /tmp notes.txt .claude']) {
    assert.equal(assertDenied(await gate(main, 'Bash', { command }, h)), STORE_REASON, command);
  }
  for (const command of ['mv -St x ~/.claude', 'mv -S -t x ~/.claude', 'mv --suffix -t x ~/.claude']) {
    assertAllowed(await gate(h, 'Bash', { command }, h));
  }
});

test('a { after an argument is an argument too, so the word after it is none of its commands', async () => {
  assertAllowed(await gate(gateWorld.h, 'Bash', { command: 'echo { touch ~/.claude/ledgers.json' }));
});

test('a check that throws does not disable the other: a failed archive read still lets a .claude/ledger.md write be denied', (t) => {
  const { h, main, task } = removal(t);
  const paths = ledgerPaths(h);
  const store = fileStore(paths);
  const brokenArchive = {
    ...store.archive,
    repos: (): string[] => {
      throw new Error('the archive cannot be read');
    },
  };
  const context = { paths, cwd: main, store: { ...store, archive: brokenArchive }, ledgerBin: BIN };
  const target = path.join(main, '.claude/ledger.md');
  const input = parseHookInput(JSON.stringify(toolUse(main, 'Bash', { command: `rm -rf ${task} && echo x > ${target}` })));

  assert.equal(preToolUse(input, context)?.hookSpecificOutput.permissionDecisionReason, STORE_REASON);
  assert.throws(() => preToolUse(parseHookInput(JSON.stringify(toolUse(main, 'Bash', { command: `rm -rf ${task}` }))), context), /the archive cannot be read/);
});

test('a glob with a reversed range matches nothing, and the rest of the command is still checked', async (t) => {
  const { h, main, task } = removal(t);

  assert.equal(assertDenied(await gate(main, 'Bash', { command: `rm -rf .claude/worktrees/[z-a]ask ${task}` }, h)), removalReason(main, task));
});

test('a glob that matches nothing, or only folders without a ledger, is allowed', async (t) => {
  const { h, main } = removal(t);
  mkdirSync(path.join(main, 'build/cache'), { recursive: true });

  for (const command of ['rm -rf build/*', 'rm -rf nothing-here/*', 'rm -rf .claude/worktrees/x?z', 'rm -rf *']) {
    assertAllowed(await gate(main, 'Bash', { command }, h));
  }
});

const unmovedReason = (...folders: string[]): string =>
  [
    `This would remove a worktree whose task ledger is not yet moved into the ledger store:${folders.map((folder) => ` ${folder}`).join('')}`,
    '',
    'Its .claude/ledger.md is the record of the task. Move it into the store, then retire the task, which archives the ledger and then removes the worktree:',
    `  ${BIN} store migrate --active`,
    `  ${BIN} task retire <slug>`,
  ].join('\n');

test('removing a worktree whose ledger is still an unmoved .claude/ledger.md is denied, naming migrate --active, until the moved ledger is archived', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const task = worktree(h, main, path.join(main, '.claude/worktrees/task'));
  mkdirSync(path.join(task, '.claude'));
  writeFileSync(path.join(task, '.claude/ledger.md'), ledgerText({ slug: 'task', main, worktree: task }));

  for (const command of [`git worktree remove ${task}`, `rm -rf ${task}`]) assert.equal(assertDenied(await gate(main, 'Bash', { command }, h)), unmovedReason(task), command);

  ledgerIn(h, task, ledgerText({ slug: 'task', main, worktree: task }));
  assert.equal(assertDenied(await gate(main, 'Bash', { command: `git worktree remove ${task}` }, h)), removalReason(main, task));
  archiveCopy(h, 'main', '2026-11-01-task', ledgerText({ slug: 'task', main, worktree: task }));
  assertAllowed(await gate(main, 'Bash', { command: `git worktree remove ${task}` }, h));
});

test('removing a worktree whose ledger is still an unmoved .claude/ledger.md is denied even with an archive copy naming it', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const task = worktree(h, main, path.join(main, '.claude/worktrees/task'));
  mkdirSync(path.join(task, '.claude'));
  writeFileSync(path.join(task, '.claude/ledger.md'), ledgerText({ slug: 'task', main, worktree: task }));
  archiveCopy(h, 'main', '2026-11-01-task', ledgerText({ slug: 'task', main, worktree: task }));

  assert.equal(assertDenied(await gate(main, 'Bash', { command: `rm -rf ${task}` }, h)), unmovedReason(task));
});

test('removing a folder without a ledger, or a command that removes nothing, is allowed', async (t) => {
  const { h, main, task } = removal(t);
  const bare = worktree(h, main, path.join(main, '.claude/worktrees/bare'));

  for (const command of [`git worktree remove ${bare}`, 'rm -rf build', `ls ${task}`, `rm -r ${task}`, `git worktree list`]) {
    assertAllowed(await gate(main, 'Bash', { command }, h));
  }
});

// Failures: a hook never blocks Claude Code

const EVENTS = ['session-start', 'prompt-submit', 'pre-compact', 'pre-tool-use'];

function assertFailedOpen(ran: Ran, event: string): void {
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, '');
  assert.match(ran.stderr, new RegExp(`^ledger hook ${event}: [^\\n]+\\n$`));
}

for (const event of EVENTS) {
  test(`${event} with input that is not a JSON object prints nothing, says why on one stderr line and exits 0`, async (t) => {
    const h = home(t);
    for (const input of ['{not json', '', '[]', 'null']) assertFailedOpen(await runHook(h, event, input), event);
  });
}

test('an internal error in a hook injects nothing', async (t) => {
  const h = home(t);
  // git refuses an argument with a NUL byte, so the first git call throws inside the hook.
  const cwd = `${h}/broken\u0000folder`;
  const inputs: Record<string, object> = {
    'session-start': { cwd },
    'pre-compact': { cwd },
    'prompt-submit': { prompt: 'go alpha', cwd },
  };
  for (const [event, input] of Object.entries(inputs)) assertFailedOpen(await runHook(h, event, JSON.stringify(input)), event);
});

// Failures are logged and reported at the next session start

const failureLog = (h: string): string => path.join(h, '.claude/ledger-hook-failures.log');
const failureLine = (time: string, hook = 'ledger hook pre-tool-use'): string => `${time}\t${hook}\tsomething broke\n`;
const failureReport = (count: string, since: string): string => `⚠ ${count} since ${since}, not yet reported. Log: ~/.claude/ledger-hook-failures.log`;

async function sessionStartIn(h: string, cwd: string): Promise<SessionStartOutput['hookSpecificOutput'] | undefined> {
  const stdout = await hook(h, 'session-start', { cwd });
  return stdout === '' ? undefined : (JSON.parse(stdout) as SessionStartOutput).hookSpecificOutput;
}

test('a failing ledger hook appends one line to ~/.claude/ledger-hook-failures.log, creating ~/.claude', async (t) => {
  const h = home(t);
  rmSync(path.join(h, '.claude'), { recursive: true, force: true });

  assertFailedOpen(await runHook(h, 'pre-tool-use', '{not json'), 'pre-tool-use');
  assertFailedOpen(await runHook(h, 'pre-compact', '[]'), 'pre-compact');

  const lines = readFileSync(failureLog(h), 'utf8').split('\n');
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\tledger hook pre-tool-use\t\S[^\t]*$/);
  assert.match(lines[1], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\tledger hook pre-compact\tthe hook input is not a JSON object$/);
  assert.equal(lines[2], '');
});

test('a failing ledger hook that cannot write its log still prints nothing and exits 0', async (t) => {
  const h = home(t);
  rmSync(path.join(h, '.claude'), { recursive: true, force: true });
  writeFileSync(path.join(h, '.claude'), 'a file, so no log can be written under it');

  for (const event of EVENTS) assertFailedOpen(await runHook(h, event, '{not json'), event);
});

test('session-start reports the unreported hook failures above the ledger, once', async (t) => {
  const h = home(t);
  const sibling = worktree(h, checkout(h, 'main'), path.join(h, 'sibling'));
  const ledger = ledgerIn(h, sibling);
  writeFileSync(failureLog(h), failureLine('2026-11-01T10:00:00Z') + failureLine('2026-11-02T11:00:00Z', 'usage-pace.sh'));

  const first = await sessionStartIn(h, sibling);
  assert.equal(first?.additionalContext, `${failureReport('2 hook failures', '2026-11-01T10:00:00Z')}\n\n${soloReport(ledger)}`);
  assert.equal(first?.sessionTitle, '🔨 sibling');
  assert.equal((await sessionStartIn(h, sibling))?.additionalContext, soloReport(ledger));

  writeFileSync(failureLog(h), failureLine('2026-11-03T12:00:00Z'), { flag: 'a' });
  assert.equal((await sessionStartIn(h, sibling))?.additionalContext, `${failureReport('1 hook failure', '2026-11-03T12:00:00Z')}\n\n${soloReport(ledger)}`);
});

test('session-start with no ledger reports the hook failures alone, then prints nothing', async (t) => {
  const h = home(t);
  const outside = h;
  writeFileSync(failureLog(h), failureLine('2026-11-01T10:00:00Z'));

  assert.deepEqual(await sessionStartIn(h, outside), { hookEventName: 'SessionStart', additionalContext: failureReport('1 hook failure', '2026-11-01T10:00:00Z') });
  assert.equal(await hook(h, 'session-start', { cwd: outside }), '');
});

test('session-start reports a crash of an earlier ledger hook', async (t) => {
  const h = home(t);
  const outside = h;
  assertFailedOpen(await runHook(h, 'session-start', '{not json'), 'session-start');

  assert.match((await sessionStartIn(h, outside))?.additionalContext ?? '', /^⚠ 1 hook failure since \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ, not yet reported\. Log: ~\/\.claude\/ledger-hook-failures\.log$/);
});

test('session-start whose ledger part throws still reports the earlier failures alone, and logs its own for the next report', async (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  writeFileSync(failureLog(h), failureLine('2026-11-01T10:00:00Z'));

  // git refuses an argument with a NUL byte, so the ledger part throws.
  assert.deepEqual(await sessionStartIn(h, `${h}/broken\u0000folder`), { hookEventName: 'SessionStart', additionalContext: failureReport('1 hook failure', '2026-11-01T10:00:00Z') });

  assert.match((await sessionStartIn(h, main))?.additionalContext ?? '', /^⚠ 1 hook failure since \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ, not yet reported\./);
  const lines = readFileSync(failureLog(h), 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\tledger hook session-start\t\S/);
});

test('session-start whose ledger part throws with no unreported failures fails open as before', async (t) => {
  const h = home(t);
  assertFailedOpen(await runHook(h, 'session-start', JSON.stringify({ cwd: `${h}/broken\u0000folder` })), 'session-start');
  const lines = readFileSync(failureLog(h), 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\tledger hook session-start\t\S/);
});

test('session-start reports the whole log again when it is shorter than the part already reported', async (t) => {
  const h = home(t);
  const outside = h;
  writeFileSync(failureLog(h), failureLine('2026-11-01T10:00:00Z') + failureLine('2026-11-02T10:00:00Z'));
  await sessionStartIn(h, outside);

  writeFileSync(failureLog(h), failureLine('2026-11-05T10:00:00Z'));
  assert.equal((await sessionStartIn(h, outside))?.additionalContext, failureReport('1 hook failure', '2026-11-05T10:00:00Z'));
});

test('session-start that cannot record what it reported still reports and exits 0', async (t) => {
  const h = home(t);
  const outside = h;
  writeFileSync(failureLog(h), failureLine('2026-11-01T10:00:00Z'));
  mkdirSync(path.join(h, '.claude/ledger-hook-failures.reported'));

  assert.equal((await sessionStartIn(h, outside))?.additionalContext, failureReport('1 hook failure', '2026-11-01T10:00:00Z'));
  assert.equal((await sessionStartIn(h, outside))?.additionalContext, failureReport('1 hook failure', '2026-11-01T10:00:00Z'));
});

test('session-start that cannot read the log prints what it prints with no failures', async (t) => {
  const h = home(t);
  const outside = h;
  mkdirSync(failureLog(h));

  assert.equal(await hook(h, 'session-start', { cwd: outside }), '');
});

test('a path the gates cannot check counts as no ledger on disk, and the rest of the command is still checked', async (t) => {
  const { h, main, task } = removal(t);
  const tooLong = 'a'.repeat(300);

  for (const word of [tooLong, '/broken\u0000folder']) {
    assert.equal(assertDenied(await gate(main, 'Bash', { command: `rm -rf ${task} && echo ${word}` }, h)), removalReason(main, task));
  }
  assert.equal(assertDenied(await gate(main, 'Bash', { command: `echo x > ${tooLong}/.claude/ledger.md; echo y > .claude/ledger.md` }, h)), STORE_REASON);
  assert.equal(assertDenied(await gate(`${h}/broken\u0000folder`, 'Write', { file_path: '.claude/ledger.md' }, h)), STORE_REASON);
});

test('a folder the gate may not read counts as no ledger, and the rest of the command is still checked', { skip: process.getuid?.() === 0 && 'root reads every folder' }, async (t) => {
  const { h, main, task } = removal(t);
  const locked = path.join(main, 'locked');
  mkdirSync(path.join(locked, 'inside'), { recursive: true });
  chmodSync(locked, 0o000);
  try {
    assert.equal(assertDenied(await gate(main, 'Bash', { command: `rm -rf locked/inside ${task}` }, h)), removalReason(main, task));
  } finally {
    chmodSync(locked, 0o755);
  }
});

/** A copy of bin/ledger in a repo with no node_modules. Its fake npm writes the file `npmRan` and exits 3. */
function uninstalledLedger(h: string): { bin: string; npmRan: string; env: NodeJS.ProcessEnv } {
  const repo = path.join(h, 'repo');
  const stubs = path.join(h, 'npm-stub');
  mkdirSync(path.join(repo, 'bin'), { recursive: true });
  mkdirSync(stubs);
  for (const file of ['package.json', 'bin/package.json', 'bin/ledger']) writeFileSync(path.join(repo, file), readFileSync(path.join(REPO, file)), { mode: 0o755 });
  const npmRan = path.join(h, 'npm-ran');
  writeFileSync(path.join(stubs, 'npm'), `#!/bin/sh\necho ran > '${npmRan}'\nexit 3\n`, { mode: 0o755 });
  return { bin: path.join(repo, 'bin/ledger'), npmRan, env: environment(h, { PATH: `${stubs}${path.delimiter}${process.env.PATH ?? ''}` }) };
}

test('ledger hook with no installed dependencies runs no npm ci: it prints nothing, says why on one stderr line and exits 0', (t) => {
  const h = home(t);
  const { bin, npmRan, env } = uninstalledLedger(h);
  for (const event of EVENTS) {
    const result = spawnSync(bin, ['hook', event], { cwd: h, env, input: JSON.stringify({ cwd: h }), encoding: 'utf8' });
    assertFailedOpen({ status: result.status, stdout: result.stdout, stderr: result.stderr }, event);
    assert.match(result.stderr, /npm ci/, event);
  }
  assert.equal(existsSync(npmRan), false, 'npm ran in hook mode');
});

test('ledger statusline with no installed dependencies runs no npm ci: it prints nothing and exits 0', (t) => {
  const h = home(t);
  const { bin, npmRan, env } = uninstalledLedger(h);
  const result = spawnSync(bin, ['statusline', h], { cwd: h, env, encoding: 'utf8' });
  assert.deepEqual({ status: result.status, stdout: result.stdout, stderr: result.stderr }, { status: 0, stdout: '', stderr: '' });
  assert.equal(existsSync(npmRan), false, 'npm ran for the status line');
});

test('ledger outside hook mode still runs npm ci when the dependencies are missing, and exits with its code', (t) => {
  const h = home(t);
  const { bin, npmRan, env } = uninstalledLedger(h);
  const result = spawnSync(bin, ['list'], { cwd: h, env, encoding: 'utf8' });
  assert.equal(result.status, 3, result.stderr);
  assert.equal(existsSync(npmRan), true, 'npm did not run');
});
