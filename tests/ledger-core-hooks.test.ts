import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before, type TestContext } from 'node:test';
import { fileStore } from '../tools/ledger/file-store.js';
import { parseHookInput, preToolUse } from '../tools/ledger/hooks.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { REPO } from './helpers.js';
import { git, home, LEDGER_BIN, ledgerText, touch } from './ledger-core-fixtures.js';

type Ran = { status: number | null; stdout: string; stderr: string };

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

/** `ledger hook <event>` with `input` on stdin, run from HOME so that only the input's cwd names a repo. */
function runHook(h: string, event: string, input: string, extra?: NodeJS.ProcessEnv, timeout?: number): Ran {
  const result = spawnSync(LEDGER_BIN, ['hook', event], { cwd: h, env: environment(h, extra), input, encoding: 'utf8', timeout });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function hook(h: string, event: string, input: object): string {
  const ran = runHook(h, event, JSON.stringify(input));
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

/** The linked worktrees' ledgers in the order git lists the worktrees. */
function linkedLedgers(h: string, main: string): string[] {
  return git(h, main, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .slice(1)
    .map((line) => path.join(line.slice('worktree '.length), '.claude/ledger.md'));
}

function ledgerIn(folder: string, text = `# Task ledger — ${path.basename(folder)}\n\n## Goal\nA goal.\n\n## Next step\nA step.\n`): string {
  mkdirSync(path.join(folder, '.claude'), { recursive: true });
  const ledger = path.join(folder, '.claude/ledger.md');
  writeFileSync(ledger, text);
  return ledger;
}

function familyLedger(slug: string, location: string[], rest = '## Next step\nA step.\n'): string {
  return [`# Task ledger — ${slug}`, '', '## Goal', 'A goal.', '', '## Location', ...location, '', rest].join('\n');
}

function backlogLedger(h: string, folder: string, slug: string, owner: string, location: string[] = []): string {
  const ledger = path.join(h, '.claude/ledger-backlog', folder, `${slug}.md`);
  mkdirSync(path.dirname(ledger), { recursive: true });
  writeFileSync(ledger, familyLedger(slug, [`- main: ${owner}`, '- worktree: <path>', ...location]));
  return ledger;
}

function archiveCopy(h: string, folder: string, name: string, text: string): string {
  const copy = path.join(h, '.claude/ledger-archive', folder, `${name}.md`);
  mkdirSync(path.dirname(copy), { recursive: true });
  writeFileSync(copy, text);
  return copy;
}

const fullLedgerText = (ledger: string): string =>
  `A task ledger exists at ${ledger}. Contents follow. If it has open steps, continue from Next step without re-verifying finished steps.\n\n${readFileSync(ledger, 'utf8')}`;

function relationText(ledger: string, ...lines: string[]): string {
  const [first, ...contents] = fullLedgerText(ledger).split('\n');
  return [first, ...lines, ...contents].join('\n');
}

type SessionStartOutput = { hookSpecificOutput: { hookEventName: string; additionalContext: string; sessionTitle?: string } };

function sessionStart(h: string, cwd: string): SessionStartOutput['hookSpecificOutput'] {
  const output = JSON.parse(hook(h, 'session-start', { hook_event_name: 'SessionStart', source: 'startup', cwd })) as SessionStartOutput;
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  return output.hookSpecificOutput;
}

const preCompact = (h: string, cwd: string): string => hook(h, 'pre-compact', { hook_event_name: 'PreCompact', trigger: 'auto', cwd });

// SessionStart and PreCompact

test('a main checkout\'s own ledger is never read back or named on compaction', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  worktree(h, main, path.join(h, 'sibling'));
  ledgerIn(main);

  assert.equal(hook(h, 'session-start', { cwd: main }), '');
  assert.equal(preCompact(h, main), '');
});

test('session-start from a main checkout summarises worktree ledgers inside and outside it, but not its own', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const own = ledgerIn(main);
  const inside = ledgerIn(worktree(h, main, path.join(main, '.claude/worktrees/inside')));
  const sibling = ledgerIn(worktree(h, main, path.join(h, 'sibling')));

  const context = sessionStart(h, main).additionalContext;

  assert.ok(!context.includes(own), `main checkout ledger shown:\n${context}`);
  assert.ok(context.includes(`=== ${inside}\n`), `worktree ledger missing:\n${context}`);
  assert.ok(context.includes(`=== ${sibling}\n`), `sibling ledger missing:\n${context}`);
});

test('session-start from a subdirectory of a main checkout ignores a ledger in that subdirectory', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(path.join(main, 'sub'));
  const sibling = ledgerIn(worktree(h, main, path.join(h, 'sibling')));

  const output = sessionStart(h, path.join(main, 'sub'));

  assert.equal(output.additionalContext, fullLedgerText(sibling));
  assert.equal('sessionTitle' in output, false);
});

test('session-start in a linked worktree shows only its own ledger and titles the session with the slug', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(main);
  ledgerIn(worktree(h, main, path.join(h, 'other')));
  const sibling = worktree(h, main, path.join(h, 'sibling'));
  const ledger = ledgerIn(sibling, '# Task ledger — window-title  \n\n## Goal\nA goal.\n');

  const output = sessionStart(h, sibling);

  assert.equal(output.sessionTitle, 'window-title');
  assert.equal(output.additionalContext, fullLedgerText(ledger));
});

test('session-start accepts a hyphen instead of an em dash in the ledger heading', (t) => {
  const h = home(t);
  const sibling = worktree(h, checkout(h, 'main'), path.join(h, 'sibling'));
  ledgerIn(sibling, '# Task ledger - hyphenated\n');

  assert.equal(sessionStart(h, sibling).sessionTitle, 'hyphenated');
});

test('session-start omits the title when the ledger has no heading', (t) => {
  const h = home(t);
  const sibling = worktree(h, checkout(h, 'main'), path.join(h, 'sibling'));
  const ledger = ledgerIn(sibling, '## Goal\nA goal.\n');

  const output = sessionStart(h, sibling);

  assert.equal('sessionTitle' in output, false);
  assert.equal(output.additionalContext, fullLedgerText(ledger));
});

test('session-start omits the title when the heading has an empty slug or one that is no slug', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const empty = worktree(h, main, path.join(h, 'empty'));
  ledgerIn(empty, '# Task ledger —   \n');
  const odd = worktree(h, main, path.join(h, 'odd'));
  ledgerIn(odd, '# Task ledger — "quoted" \\ slug\n');

  assert.equal('sessionTitle' in sessionStart(h, empty), false);
  assert.equal('sessionTitle' in sessionStart(h, odd), false);
});

test('session-start in a main checkout summarises several worktree ledgers without a title', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(worktree(h, main, path.join(h, 'first')));
  ledgerIn(worktree(h, main, path.join(h, 'second')));

  const output = sessionStart(h, main);

  assert.equal('sessionTitle' in output, false);
  assert.equal(
    output.additionalContext,
    '2 task ledgers exist. Summary of each follows. If asked what we are working on, answer from this. Before continuing one, ask which, then read its full ledger.\n' +
      linkedLedgers(h, main)
        .map((ledger) => `\n=== ${ledger}\nA goal.\n\nA step.\n`)
        .join(''),
  );
});

test('session-start in a main checkout with one worktree ledger shows it in full without a title', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const ledger = ledgerIn(worktree(h, main, path.join(h, 'sibling')));

  const output = sessionStart(h, main);

  assert.equal('sessionTitle' in output, false);
  assert.equal(output.additionalContext, fullLedgerText(ledger));
});

test('session-start outside a git repository shows the ledger in the working directory and titles the session', (t) => {
  const h = home(t);
  const plain = path.join(h, 'plain');
  const ledger = ledgerIn(plain);

  const output = sessionStart(h, plain);

  assert.equal(output.sessionTitle, 'plain');
  assert.equal(output.additionalContext, fullLedgerText(ledger));
});

test('session-start outside a git repository finds a ledger under .claude/worktrees, without a title', (t) => {
  const h = home(t);
  const plain = path.join(h, 'plain');
  const ledger = ledgerIn(path.join(plain, '.claude/worktrees/x'));

  const output = sessionStart(h, plain);

  assert.equal('sessionTitle' in output, false);
  assert.equal(output.additionalContext, fullLedgerText(ledger));
});

test('session-start in a child task names its parent and the parent status', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const child = worktree(h, main, path.join(h, 'child'));
  const ledger = ledgerIn(child, familyLedger('child', ['- parent: epic']));
  ledgerIn(worktree(h, main, path.join(h, 'epic')), familyLedger('epic', [], '## Children\n- child\n\n## Next step\nParked: 2026-10-01 — waiting.\nA step.\n'));

  assert.equal(sessionStart(h, child).additionalContext, relationText(ledger, 'Parent task: epic (parked).'));
});

test('session-start in a child task whose parent has no ledger names the parent as missing, with CRLF line ends', (t) => {
  const h = home(t);
  const child = worktree(h, checkout(h, 'main'), path.join(h, 'child'));
  const ledger = ledgerIn(child, familyLedger('child', ['- parent: epic']).replace(/\n/g, '\r\n'));

  assert.equal(sessionStart(h, child).additionalContext, relationText(ledger, 'Parent task: epic (missing).'));
});

test('session-start in a parent task names each child in list order with its status from disk, and skips a bullet that names no known task', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const epic = worktree(h, main, path.join(h, 'epic'));
  const children = '## Children\n- child-a\n- child-b\n- old (retired 2026-10-01)\n- lost\n\n## Next step\nA step.\n';
  const ledger = ledgerIn(epic, familyLedger('epic', [], children));
  ledgerIn(worktree(h, main, path.join(h, 'child-a')), familyLedger('child-a', ['- parent: epic']));
  ledgerIn(worktree(h, main, path.join(h, 'child-b')), familyLedger('child-b', ['- parent: epic'], '## Next step\n\nParked: 2026-10-02 - later.\n'));
  archiveCopy(h, 'main', '2026-10-01-old', familyLedger('old', [`- main: ${main}`, `- worktree: ${path.join(main, '.claude/worktrees/old')}`, '- parent: epic']));

  assert.equal(
    sessionStart(h, epic).additionalContext,
    relationText(ledger, 'Child task: child-a (active).', 'Child task: child-b (parked).', 'Child task: old (retired 2026-10-01).'),
  );
});

test('session-start shows a child marked retired with its date, not the status of a live task with the same slug', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const epic = worktree(h, main, path.join(h, 'epic'));
  const ledger = ledgerIn(epic, familyLedger('epic', [], '## Children\n- reused (retired 2026-10-01)\n\n## Next step\nA step.\n'));
  ledgerIn(worktree(h, main, path.join(h, 'reused')), familyLedger('reused', ['- parent: epic']));

  assert.equal(sessionStart(h, epic).additionalContext, relationText(ledger, 'Child task: reused (retired 2026-10-01).'));
});

test('session-start in a parent task names a child marked started, with or without a note, with its status', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const epic = worktree(h, main, path.join(h, 'epic'));
  const children = '## Children\n- child-a (started 2026-10-20)\n- child-b (started 2026-10-20; PR #31 is open)\n- lost (started 2026-10-21)\n\n## Next step\nA step.\n';
  const ledger = ledgerIn(epic, familyLedger('epic', [], children));
  ledgerIn(worktree(h, main, path.join(h, 'child-a')), familyLedger('child-a', ['- parent: epic']));
  ledgerIn(worktree(h, main, path.join(h, 'child-b')), familyLedger('child-b', ['- parent: epic']));

  assert.equal(sessionStart(h, epic).additionalContext, relationText(ledger, 'Child task: child-a (active).', 'Child task: child-b (active).'));
});

test('session-start in a main checkout names the parent or children under each ledger summary', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const epic = ledgerIn(worktree(h, main, path.join(h, 'epic')), familyLedger('epic', [], '## Children\n- child-a\n- child-b\n\n## Next step\nA step.\n'));
  const childA = ledgerIn(worktree(h, main, path.join(h, 'child-a')), familyLedger('child-a', ['- parent: epic']));
  const childB = ledgerIn(worktree(h, main, path.join(h, 'child-b')), familyLedger('child-b', ['- parent: epic'], '## Next step\nParked: 2026-10-02 — later.\n'));
  const relations: Record<string, string[]> = {
    [epic]: ['Child task: child-a (active).', 'Child task: child-b (parked).'],
    [childA]: ['Parent task: epic (active).'],
    [childB]: ['Parent task: epic (active).'],
  };
  const ledgers = linkedLedgers(h, main);

  const context = sessionStart(h, main).additionalContext;

  assert.equal(ledgers.length, 3);
  assert.deepEqual(
    context.split('\n=== ').slice(1),
    ledgers.map((ledger) => {
      const next = ledger === childB ? 'Parked: 2026-10-02 — later.' : 'A step.';
      return [ledger, ...(relations[ledger] ?? []), 'A goal.', '', next, ''].join('\n');
    }),
  );
});

test('session-start names a parent in another repository with that repository and its status there, not that of a local ledger of its slug', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const child = worktree(h, main, path.join(h, 'child'));
  const other = checkout(h, 'app');
  const ledger = ledgerIn(child, familyLedger('child', [`- parent: epic @ ${other}`]));
  ledgerIn(worktree(h, main, path.join(h, 'epic')), familyLedger('epic', [], '## Children\n- child\n\n## Next step\nA step.\n'));
  ledgerIn(worktree(h, other, path.join(h, 'app-epic')), familyLedger('epic', [], '## Next step\nParked: 2026-10-02 — later.\n'));

  assert.equal(sessionStart(h, child).additionalContext, relationText(ledger, `Parent task: epic @ ${other} (parked).`));
});

test('session-start names a parent in a repository that is gone as missing', (t) => {
  const h = home(t);
  const child = worktree(h, checkout(h, 'main'), path.join(h, 'child'));
  const other = path.join(h, 'elsewhere/app');
  const ledger = ledgerIn(child, familyLedger('child', [`- parent: epic @ ${other}`]));

  assert.equal(sessionStart(h, child).additionalContext, relationText(ledger, `Parent task: epic @ ${other} (missing).`));
});

test('session-start names tasks in a repository whose git does not answer as unknown, waiting for that repository once', (t) => {
  const h = home(t);
  const child = worktree(h, checkout(h, 'main'), path.join(h, 'child'));
  const slow = path.join(h, 'slow/app');
  const parts = ['part-a', 'part-b', 'part-c', 'part-d'];
  const ledger = ledgerIn(child, familyLedger('child', [`- parent: epic @ ${slow}`], `## Children\n${parts.map((part) => `- ${part} @ ${slow}\n`).join('')}\n## Next step\nA step.\n`));

  const { ran, took } = sessionStartWithHangingGit(h, child, slow);

  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(took < 9_000, `took ${took} ms`);
  assert.equal(
    (JSON.parse(ran.stdout) as SessionStartOutput).hookSpecificOutput.additionalContext,
    relationText(ledger, `Parent task: epic @ ${slow} (unknown).`, ...parts.map((part) => `Child task: ${part} @ ${slow} (unknown).`)),
  );
});

test('session-start waits once for a hanging repository, also when tasks name its worktrees', (t) => {
  const h = home(t);
  const child = worktree(h, checkout(h, 'main'), path.join(h, 'child'));
  const slow = path.join(h, 'slow/app');
  const worktreeOf = (name: string): string => path.join(slow, '.claude/worktrees', name);
  const children = `## Children\n- part-a @ ${slow}\n- part-b @ ${worktreeOf('part-b')}\n\n## Next step\nA step.\n`;
  const ledger = ledgerIn(child, familyLedger('child', [`- parent: epic @ ${worktreeOf('epic')}`], children));

  const { ran, took } = sessionStartWithHangingGit(h, child, slow);

  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(took < 9_000, `took ${took} ms`);
  assert.equal(
    (JSON.parse(ran.stdout) as SessionStartOutput).hookSpecificOutput.additionalContext,
    relationText(ledger, `Parent task: epic @ ${worktreeOf('epic')} (unknown).`, `Child task: part-a @ ${slow} (unknown).`, `Child task: part-b @ ${worktreeOf('part-b')} (unknown).`),
  );
});

/** session-start with a git that hangs for any folder in `slow`; the test gives up after 20 s, so a hook without a limit fails, not hangs. */
function sessionStartWithHangingGit(h: string, cwd: string, slow: string): { ran: Ran; took: number } {
  const stubs = path.join(h, 'hanging-git');
  mkdirSync(stubs);
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path.join(stubs, 'git'), `#!/bin/sh\nfor arg in "$@"; do case "$arg" in '${slow}'*) exec sleep 30 ;; esac; done\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const started = Date.now();
  const ran = runHook(h, 'session-start', JSON.stringify({ cwd }), { PATH: `${stubs}${path.delimiter}${process.env.PATH ?? ''}` }, 20_000);
  return { ran, took: Date.now() - started };
}

test('session-start in a parent task names each child in another repository with that repository and its status there', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const epic = worktree(h, main, path.join(h, 'epic'));
  const lib = checkout(h, 'lib');
  const children = `## Children\n- child-a\n- child-a @ ${lib}\n- begun @ ${lib} (started 2026-10-20)\n- old @ ${lib} (retired 2026-10-01)\n- gone @ ${lib}\n\n## Next step\nA step.\n`;
  const ledger = ledgerIn(epic, familyLedger('epic', [], children).replace(/\n/g, '\r\n'));
  ledgerIn(worktree(h, main, path.join(h, 'child-a')), familyLedger('child-a', ['- parent: epic']));
  backlogLedger(h, 'main', 'begun', main);
  backlogLedger(h, 'lib', 'child-a', lib);
  ledgerIn(worktree(h, lib, path.join(h, 'lib-begun')), familyLedger('begun', [`- parent: epic @ ${main}`]));
  archiveCopy(h, 'lib', '2026-10-01-old', familyLedger('old', [`- main: ${lib}`, `- worktree: ${path.join(lib, '.claude/worktrees/old')}`, `- parent: epic @ ${main}`]));

  assert.equal(
    sessionStart(h, epic).additionalContext,
    relationText(
      ledger,
      'Child task: child-a (active).',
      `Child task: child-a @ ${lib} (backlog).`,
      `Child task: begun @ ${lib} (active).`,
      `Child task: old @ ${lib} (retired 2026-10-01).`,
      `Child task: gone @ ${lib} (missing).`,
    ),
  );
});

test('session-start names a parent in this repository\'s backlog as backlog', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const child = worktree(h, main, path.join(h, 'child'));
  const ledger = ledgerIn(child, familyLedger('child', ['- parent: epic']));
  backlogLedger(h, 'main', 'epic', main);

  assert.equal(sessionStart(h, child).additionalContext, relationText(ledger, 'Parent task: epic (backlog).'));
});

test('session-start names a backlog child as backlog, but not one of another repository with the same folder name', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const epic = worktree(h, main, path.join(h, 'epic'));
  const ledger = ledgerIn(epic, familyLedger('epic', [], '## Children\n- idea\n- foreign\n\n## Next step\nA step.\n'));
  backlogLedger(h, 'main', 'idea', main, ['- parent: epic']);
  backlogLedger(h, 'main', 'foreign', path.join(h, 'elsewhere/main'), ['- parent: epic']);

  assert.equal(sessionStart(h, epic).additionalContext, relationText(ledger, 'Child task: idea (backlog).', 'Child task: foreign (missing).'));
});

test('session-start reads only the Location parent bullet, and a Children bullet that names no known task adds no line', (t) => {
  const h = home(t);
  const sibling = worktree(h, checkout(h, 'main'), path.join(h, 'sibling'));
  const ledger = ledgerIn(sibling, familyLedger('sibling', ['- parent: <slug>'], '## Children (old)\n- child-a\n\n## Notes\n- parent: epic\n'));

  assert.equal(sessionStart(h, sibling).additionalContext, fullLedgerText(ledger));
});

test('session-start prints nothing when there is no ledger', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  worktree(h, main, path.join(h, 'sibling'));

  assert.equal(hook(h, 'session-start', { cwd: main }), '');
});

test('session-start leaves out backlog tasks, both their ledger files and their registry entries', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const backlog = path.join(h, '.claude/ledger-backlog/main/idea.md');
  mkdirSync(path.dirname(backlog), { recursive: true });
  writeFileSync(backlog, `# Task ledger — idea\n\n## Goal\nA backlog goal.\n\n## Location\n- main: ${main}\n`);
  const entry = { repo: 'main', slug: 'idea', path: backlog, branch: '', status: 'backlog', main, created: '2026-10-01T00:00:00.000Z', updated: '2026-10-01T00:00:00.000Z' };
  writeFileSync(path.join(h, '.claude/ledgers.json'), JSON.stringify([entry]));

  assert.equal(hook(h, 'session-start', { cwd: main }), '');

  const sibling = ledgerIn(worktree(h, main, path.join(h, 'sibling')));
  const context = sessionStart(h, main).additionalContext;
  assert.ok(context.includes(sibling), `worktree ledger missing:\n${context}`);
  assert.ok(!context.includes(backlog) && !context.includes('A backlog goal.'), `backlog task shown:\n${context}`);
});

test('session-start keeps quotes, backslashes, tabs and non-ASCII text intact', (t) => {
  const h = home(t);
  const sibling = worktree(h, checkout(h, 'main'), path.join(h, 'sibling'));
  const ledger = ledgerIn(sibling, '# Task ledger — quoted\n\n## Goal\nSay "hi" \\n then \\ and \ttab — ✓ æøå\n');

  const output = sessionStart(h, sibling);

  assert.equal(output.sessionTitle, 'quoted');
  assert.equal(output.additionalContext, fullLedgerText(ledger));
});

const registeredPaths = (h: string): string[] =>
  (JSON.parse(readFileSync(path.join(h, '.claude/ledgers.json'), 'utf8')) as { path: string }[]).map((entry) => entry.path).sort();

test('session-start registers its one ledger in ~/.claude/ledgers.json', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const ledger = ledgerIn(worktree(h, main, path.join(h, 'sibling')));

  sessionStart(h, main);

  assert.deepEqual(registeredPaths(h), [ledger]);
});

test('session-start registers each of several ledgers', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const first = ledgerIn(worktree(h, main, path.join(h, 'first')));
  const second = ledgerIn(worktree(h, main, path.join(h, 'second')));

  sessionStart(h, main);

  assert.deepEqual(registeredPaths(h), [first, second].sort());
});

test('session-start prints the same JSON and exits 0 when the registry cannot be written', (t) => {
  const h = home(t);
  const sibling = worktree(h, checkout(h, 'main'), path.join(h, 'sibling'));
  const ledger = ledgerIn(sibling);
  const expected = hook(h, 'session-start', { cwd: sibling });
  rmSync(path.join(h, '.claude'), { recursive: true, force: true });
  writeFileSync(path.join(h, '.claude'), 'a file, so ~/.claude/ledgers.json cannot exist');

  assert.equal(hook(h, 'session-start', { cwd: sibling }), expected);
  assert.equal(sessionStart(h, sibling).additionalContext, fullLedgerText(ledger));
});

test('pre-compact names the one ledger and leaves the registry alone', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const ledger = ledgerIn(worktree(h, main, path.join(h, 'sibling')));

  assert.equal(preCompact(h, main), `Task ledger at ${ledger} is authoritative. Preserve its path and its Next step section verbatim.\n`);
  assert.throws(() => readFileSync(path.join(h, '.claude/ledgers.json')), { code: 'ENOENT' });
});

test('pre-compact names several ledgers, most recently modified first', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const older = ledgerIn(worktree(h, main, path.join(h, 'a-older')));
  const newer = ledgerIn(worktree(h, main, path.join(h, 'b-newer')));
  const middle = ledgerIn(worktree(h, main, path.join(h, 'c-middle')));
  touch(older, '2026-10-01T00:00:00Z');
  touch(newer, '2026-10-03T00:00:00Z');
  touch(middle, '2026-10-02T00:00:00Z');

  assert.equal(
    preCompact(h, main),
    `3 task ledgers exist (most recently modified first). Preserve the path of the ledger this session is working on, and its Next step section verbatim:\n${newer}\n${middle}\n${older}\n`,
  );
});

// UserPromptSubmit

type PromptSubmitInput = { prompt: string; cwd?: string; session_title?: string };

const promptSubmit = (h: string, input: PromptSubmitInput): string => hook(h, 'prompt-submit', { hook_event_name: 'UserPromptSubmit', ...input });

function promptSubmitTitle(h: string, input: PromptSubmitInput): string {
  const output = JSON.parse(promptSubmit(h, input)) as { hookSpecificOutput: { hookEventName: string; sessionTitle: string } };
  assert.deepEqual(Object.keys(output.hookSpecificOutput).sort(), ['hookEventName', 'sessionTitle']);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  return output.hookSpecificOutput.sessionTitle;
}

const archive = (h: string, repo: string, slug: string): string => archiveCopy(h, repo, `2026-10-01-${slug}`, `# Task ledger — ${slug}\n`);

test('prompt-submit titles an untitled session in the main checkout with the slug from go', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(worktree(h, main, path.join(h, 'alpha')));

  assert.equal(promptSubmitTitle(h, { prompt: 'go alpha', cwd: main }), 'alpha');
});

test('prompt-submit replaces the title of another worktree\'s task', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  const alpha = worktree(h, main, path.join(h, 'alpha'));
  ledgerIn(alpha);
  ledgerIn(worktree(h, main, path.join(main, '.claude/worktrees/beta')));

  assert.equal(promptSubmitTitle(h, { prompt: '  go beta\n', cwd: alpha, session_title: 'alpha' }), 'beta');
});

test('prompt-submit replaces a title that names an archived task', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(worktree(h, main, path.join(h, 'alpha')));
  archive(h, 'main', 'finished-task');

  assert.equal(promptSubmitTitle(h, { prompt: 'go alpha', cwd: main, session_title: 'finished-task' }), 'alpha');
});

test('prompt-submit ignores the archive of another repository', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(worktree(h, main, path.join(h, 'alpha')));
  archive(h, 'other', 'finished-task');

  assert.equal(promptSubmit(h, { prompt: 'go alpha', cwd: main, session_title: 'finished-task' }), '');
});

test('prompt-submit keeps a title the operator chose', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(worktree(h, main, path.join(h, 'alpha')));

  assert.equal(promptSubmit(h, { prompt: 'go alpha', cwd: main, session_title: 'my custom name' }), '');
});

test('prompt-submit prints nothing when the title already names the task', (t) => {
  const h = home(t);
  const alpha = worktree(h, checkout(h, 'main'), path.join(h, 'alpha'));
  ledgerIn(alpha);

  assert.equal(promptSubmit(h, { prompt: 'go alpha', cwd: alpha, session_title: 'alpha' }), '');
});

test('prompt-submit prints nothing for a slug with no active ledger', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(worktree(h, main, path.join(h, 'alpha')));
  archive(h, 'main', 'finished-task');

  assert.equal(promptSubmit(h, { prompt: 'go unknown', cwd: main }), '');
  assert.equal(promptSubmit(h, { prompt: 'go finished-task', cwd: main }), '');
});

test('prompt-submit prints nothing unless the prompt is exactly go and one slug', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(worktree(h, main, path.join(h, 'alpha')));

  for (const prompt of ['go', 'go ', 'go alpha beta', 'please go alpha', 'go alpha\nand more', 'Go alpha', 'goalpha', 'go\nalpha']) {
    assert.equal(promptSubmit(h, { prompt, cwd: main }), '', JSON.stringify(prompt));
  }
});

test('prompt-submit prints nothing outside a git repository', (t) => {
  const h = home(t);
  const plain = path.join(h, 'plain');
  ledgerIn(plain, '# Task ledger — alpha\n');
  ledgerIn(path.join(plain, '.claude/worktrees/alpha'), '# Task ledger — alpha\n');

  assert.equal(promptSubmit(h, { prompt: 'go alpha', cwd: plain }), '');
});

test('prompt-submit skips a worktree whose folder is gone', (t) => {
  const h = home(t);
  const main = checkout(h, 'main');
  ledgerIn(worktree(h, main, path.join(h, 'alpha')));
  rmSync(worktree(h, main, path.join(h, 'gone')), { recursive: true, force: true });

  assert.equal(promptSubmitTitle(h, { prompt: 'go alpha', cwd: main }), 'alpha');
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

const gate = (cwd: string, toolName: string, toolInput: ToolInput, h = gateWorld.h): string => hook(h, 'pre-tool-use', toolUse(cwd, toolName, toolInput));

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

const mainCheckoutReason = (...targets: string[]): string =>
  [
    `This would write a task ledger in a repo's main checkout:${targets.map((target) => ` ${target}`).join('')}`,
    '',
    "A ledger belongs in the task's worktree, never in the main checkout.",
    'Start the task first. This writes its ledger to the backlog, with no branch or worktree yet:',
    `  ${BIN} task <slug> --goal '<one paragraph>'`,
    'Then give it a branch and a worktree, and move its ledger in:',
    `  ${BIN} go <slug>`,
    'Then work in the worktree that ledger go prints.',
    "This check does not follow cd: from the main checkout, use the absolute path to the worktree's .claude/ledger.md.",
  ].join('\n');

const CITATION_REASON =
  "A task ledger may not cite files in the Claude Code session folder or its scratchpad, because macOS deletes them. Move the file to .claude/evidence/ in the task's worktree and cite that path, for example .claude/evidence/xcodebuild-red.log. Copy the file and write the ledger in two separate commands.";

for (const tool of ['Write', 'Edit', 'MultiEdit']) {
  test(`${tool} of the ledger in a main checkout is denied, naming the ledger command`, () => {
    const target = path.join(gateWorld.main, '.claude/ledger.md');
    assert.equal(assertDenied(gate(gateWorld.main, tool, { file_path: target })), mainCheckoutReason(target));
  });

  test(`${tool} of the ledger in a linked worktree is allowed`, () => {
    assertAllowed(gate(gateWorld.main, tool, { file_path: path.join(gateWorld.worktree, '.claude/ledger.md') }));
  });
}

test('a relative file_path is resolved against the hook cwd', () => {
  assertDenied(gate(gateWorld.main, 'Write', { file_path: '.claude/ledger.md' }));
  assertAllowed(gate(gateWorld.worktree, 'Write', { file_path: '.claude/ledger.md' }));
});

test('other files in a main checkout are allowed', () => {
  for (const file of ['.claude/settings.json', 'docs/ledger.md', '.claude/ledger.md.bak', 'ledger.md']) {
    assertAllowed(gate(gateWorld.main, 'Write', { file_path: path.join(gateWorld.main, file) }));
  }
});

test('a tool that writes nothing is allowed, even on the ledger in a main checkout', () => {
  assertAllowed(gate(gateWorld.main, 'Read', { file_path: path.join(gateWorld.main, '.claude/ledger.md') }));
});

test('the ledger outside any git repository is allowed', () => {
  const { plain } = gateWorld;
  assertAllowed(gate(plain, 'Write', { file_path: path.join(plain, '.claude/ledger.md') }));
  assertAllowed(gate(plain, 'Bash', { command: 'echo x > .claude/ledger.md' }));
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
];

for (const command of bashWrites) {
  test(`Bash ${JSON.stringify(command)} in a main checkout is denied`, () => {
    assertDenied(gate(gateWorld.main, 'Bash', { command }));
  });

  test(`Bash ${JSON.stringify(command)} in a linked worktree is allowed`, () => {
    assertAllowed(gate(gateWorld.worktree, 'Bash', { command }));
  });
}

test('Bash write to an absolute ledger path in a main checkout is denied from anywhere', () => {
  const { main, plain } = gateWorld;
  assertDenied(gate(plain, 'Bash', { command: `echo x >> ${path.join(main, '.claude/ledger.md')}` }));
  assertDenied(gate(plain, 'Bash', { command: `cp /tmp/x '${path.join(main, '.claude/ledger.md')}'` }));
});

test('a Bash write after cd into a worktree is denied with a hint to use the absolute path', () => {
  const reason = assertDenied(gate(gateWorld.main, 'Bash', { command: 'cd .claude/worktrees/task && echo x > .claude/ledger.md' }));
  assert.equal(reason, mainCheckoutReason(path.join(gateWorld.main, '.claude/ledger.md')));
});

test('Bash write through ~ to a ledger in a main checkout is denied', () => {
  const { h, main, plain } = gateWorld;
  assertDenied(gate(plain, 'Bash', { command: `echo x > ~/${path.relative(h, path.join(main, '.claude/ledger.md'))}` }));
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
];

for (const command of bashReads) {
  test(`Bash ${JSON.stringify(command)} in a main checkout is allowed`, () => {
    assertAllowed(gate(gateWorld.main, 'Bash', { command }));
  });
}

test('a git failure is allowed', () => {
  const { h, main } = gateWorld;
  const ran = runHook(h, 'pre-tool-use', JSON.stringify(toolUse(main, 'Bash', { command: 'echo x > .claude/ledger.md' })), { GIT_DIR: path.join(h, 'missing') });
  assert.equal(ran.status, 0, ran.stderr);
  assertAllowed(ran.stdout);
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

for (const tool of ['Write', 'Edit', 'MultiEdit']) {
  for (const citation of citations) {
    test(`${tool} of a worktree ledger that cites ${citation} is denied`, () => {
      const { worktree: linked } = gateWorld;
      assert.equal(assertDenied(gate(linked, tool, writing(tool, path.join(linked, '.claude/ledger.md'), `- red: ${citation}`))), CITATION_REASON);
    });
  }

  for (const text of prose) {
    test(`${tool} of a worktree ledger with ${JSON.stringify(text)} is allowed`, () => {
      const { worktree: linked } = gateWorld;
      assertAllowed(gate(linked, tool, writing(tool, path.join(linked, '.claude/ledger.md'), text)));
    });
  }

  test(`${tool} of a backlog ledger that cites the scratchpad is denied`, () => {
    const { h, plain } = gateWorld;
    const backlog = path.join(h, '.claude/ledger-backlog/main/idea.md');
    assertDenied(gate(plain, tool, writing(tool, backlog, `- notes: ${citations[0]}`)));
    assertAllowed(gate(plain, tool, writing(tool, backlog, '- red: .claude/evidence/red.log')));
  });

  test(`${tool} of a file that is not a ledger may cite the scratchpad`, () => {
    const { worktree: linked } = gateWorld;
    assertAllowed(gate(linked, tool, writing(tool, path.join(linked, 'docs/notes.md'), `- red: ${citations[0]}`)));
  });
}

test('an Edit whose old text cites the scratchpad and new text does not is allowed', () => {
  const { worktree: linked } = gateWorld;
  const edit = { file_path: path.join(linked, '.claude/ledger.md'), old_string: `- red: ${citations[0]}`, new_string: '- red: .claude/evidence/red.log' };
  assertAllowed(gate(linked, 'Edit', edit));
});

test('a ledger write in a main checkout that also cites the scratchpad keeps the main-checkout reason', () => {
  const target = path.join(gateWorld.main, '.claude/ledger.md');
  assert.equal(assertDenied(gate(gateWorld.main, 'Write', writing('Write', target, `- red: ${citations[0]}`))), mainCheckoutReason(target));
});

const bashCitingWrites = [
  `cat > .claude/ledger.md <<EOF\n# Task ledger — task\n- red: ${citations[0]}\nEOF`,
  "echo '- handover: <scratchpad>/handover.md' >> .claude/ledger.md",
  "printf '%s\\n' '- review: scratchpad/review-1.txt' | tee -a .claude/ledger.md",
  `cat >> ~/.claude/ledger-backlog/main/idea.md <<EOF\n- red: ${citations[1]}\nEOF`,
];

for (const command of bashCitingWrites) {
  test(`Bash ${JSON.stringify(command)} in a linked worktree is denied`, () => {
    assert.equal(assertDenied(gate(gateWorld.worktree, 'Bash', { command })), CITATION_REASON);
  });
}

const bashAllowedNearCitations = [
  `cp ${citations[0]} .claude/evidence/xcodebuild-red.log`,
  `cat ${citations[0]} > .claude/evidence/red.log`,
  "echo '- the scratchpad is gone; see .claude/evidence/red.log' >> .claude/ledger.md",
];

for (const command of bashAllowedNearCitations) {
  test(`Bash ${JSON.stringify(command)} in a linked worktree is allowed`, () => {
    assertAllowed(gate(gateWorld.worktree, 'Bash', { command }));
  });
}

// PreToolUse: the worktree gate

/** A main checkout with the worktree <main>/.claude/worktrees/task, which holds a ledger. */
function removal(t: TestContext) {
  const h = home(t);
  const main = checkout(h, 'main');
  const task = worktree(h, main, path.join(main, '.claude/worktrees/task'));
  ledgerIn(task, ledgerText({ slug: 'task', main, worktree: task }));
  return { h, main, task };
}

const removalReason = (...folders: string[]): string =>
  [
    `This would remove a worktree whose task ledger is not archived:${folders.map((folder) => ` ${folder}`).join('')}`,
    '',
    'The ledger is the record of the task. The worktree is not.',
    'Retire it instead, which archives the ledger and then removes the worktree:',
    `  ${BIN} retire <slug>`,
    '',
    'Archived ledgers live in ~/.claude/ledger-archive/<repo>/.',
  ].join('\n');

test('removing a worktree whose ledger is not archived is denied, naming ledger retire', (t) => {
  const { h, main, task } = removal(t);

  assert.equal(assertDenied(gate(main, 'Bash', { command: 'git worktree remove .claude/worktrees/task' }, h)), removalReason(task));
});

test('each way of naming the worktree in a removal is denied', (t) => {
  const { h, main, task } = removal(t);
  const commands = [
    `git worktree remove --force ${task}`,
    `rm -rf ${task}/`,
    `rm -fr '${task}'`,
    `rm -rf "${task}"`,
    `rm -rf ~/${path.relative(h, task)}`,
    'cd /tmp && rm -rf .claude/worktrees/task',
  ];
  for (const command of commands) assert.equal(assertDenied(gate(main, 'Bash', { command }, h)), removalReason(task), command);
});

test('removing a worktree whose ledger is archived is allowed', (t) => {
  const { h, main, task } = removal(t);
  archiveCopy(h, 'main', '2026-11-01-task', ledgerText({ slug: 'task', main, worktree: task }));

  assertAllowed(gate(main, 'Bash', { command: `git worktree remove ${task}` }, h));
  assertAllowed(gate(main, 'Bash', { command: `rm -rf ${task}` }, h));
});

test('an archive copy of another worktree whose path starts with the same text does not count', (t) => {
  const { h, main, task } = removal(t);
  archiveCopy(h, 'main', '2026-11-01-task-old', ledgerText({ slug: 'task-old', main, worktree: `${task}-old` }));

  assert.equal(assertDenied(gate(main, 'Bash', { command: `rm -rf ${task}` }, h)), removalReason(task));
});

test('a removal by the retire commands is allowed', (t) => {
  const { h, main, task } = removal(t);

  assertAllowed(gate(main, 'Bash', { command: `${BIN} retire task && git worktree remove ${task}` }, h));
  assertAllowed(gate(main, 'Bash', { command: `ledger retire task --force; rm -rf ${task}` }, h));
});

test('a removal that names the deleted cc-worktree-retire script is denied', (t) => {
  const { h, main, task } = removal(t);

  assert.equal(assertDenied(gate(main, 'Bash', { command: `bin/cc-worktree-retire ${task}; rm -rf ${task}` }, h)), removalReason(task));
});

test('a removal that names the worktree by a glob is denied, as bash expands the glob', (t) => {
  const { h, main, task } = removal(t);

  for (const glob of ['.claude/worktrees/*', '.claude/worktrees/ta?k', '.claude/worktrees/[st]ask', '.claude/worktrees/[!x]ask', '.claude/*/task', `${main}/.claude/worktrees/*`, '.claude/worktrees/*/']) {
    assert.equal(assertDenied(gate(main, 'Bash', { command: `rm -rf ${glob}` }, h)), removalReason(task), glob);
  }
});

test('a glob with a POSIX class, equivalence class or collating symbol in a bracket is denied, as bash expands it', (t) => {
  const { h, main, task } = removal(t);

  for (const glob of ['[[:alnum:]]ask', '[[:alpha:]]ask', 't[[:lower:]]sk', '[![:digit:]]ask', '[=t=]ask', '[.t.]ask', '[[:alpha:]]*']) {
    assert.equal(assertDenied(gate(main, 'Bash', { command: `rm -rf .claude/worktrees/${glob}` }, h)), removalReason(task), glob);
  }
});

test('a glob with a POSIX class over folders without a ledger is allowed', (t) => {
  const { h, main } = removal(t);
  mkdirSync(path.join(main, 'build/cache'), { recursive: true });

  assertAllowed(gate(main, 'Bash', { command: 'rm -rf build/[[:alpha:]]*' }, h));
});

test('a check that throws does not disable the other: a failed archive read still lets a main-checkout ledger write be denied', (t) => {
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

  assert.equal(preToolUse(input, context)?.hookSpecificOutput.permissionDecisionReason, mainCheckoutReason(target));
  assert.throws(() => preToolUse(parseHookInput(JSON.stringify(toolUse(main, 'Bash', { command: `rm -rf ${task}` }))), context), /the archive cannot be read/);
});

test('a glob with a reversed range matches nothing, and the rest of the command is still checked', (t) => {
  const { h, main, task } = removal(t);

  assert.equal(assertDenied(gate(main, 'Bash', { command: `rm -rf .claude/worktrees/[z-a]ask ${task}` }, h)), removalReason(task));
});

test('a glob that matches nothing, or only folders without a ledger, is allowed', (t) => {
  const { h, main } = removal(t);
  mkdirSync(path.join(main, 'build/cache'), { recursive: true });

  for (const command of ['rm -rf build/*', 'rm -rf nothing-here/*', 'rm -rf .claude/worktrees/x?z', 'rm -rf *']) {
    assertAllowed(gate(main, 'Bash', { command }, h));
  }
});

test('removing a folder without a ledger, or a command that removes nothing, is allowed', (t) => {
  const { h, main, task } = removal(t);
  const bare = worktree(h, main, path.join(main, '.claude/worktrees/bare'));

  for (const command of [`git worktree remove ${bare}`, 'rm -rf build', `ls ${task}`, `rm -r ${task}`, `git worktree list`]) {
    assertAllowed(gate(main, 'Bash', { command }, h));
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
  test(`${event} with input that is not a JSON object prints nothing, says why on one stderr line and exits 0`, (t) => {
    const h = home(t);
    for (const input of ['{not json', '', '[]', 'null']) assertFailedOpen(runHook(h, event, input), event);
  });
}

test('an internal error in a hook injects nothing', (t) => {
  const h = home(t);
  // git refuses an argument with a NUL byte, so the first git call throws inside the hook.
  const cwd = `${h}/broken\u0000folder`;
  const inputs: Record<string, object> = {
    'session-start': { cwd },
    'pre-compact': { cwd },
    'prompt-submit': { prompt: 'go alpha', cwd },
  };
  for (const [event, input] of Object.entries(inputs)) assertFailedOpen(runHook(h, event, JSON.stringify(input)), event);
});

test('a path the gates cannot check counts as no ledger, and the rest of the command is still checked', (t) => {
  const { h, main, task } = removal(t);
  const tooLong = 'a'.repeat(300);

  for (const word of [tooLong, '/broken\u0000folder']) {
    assert.equal(assertDenied(gate(main, 'Bash', { command: `rm -rf ${task} && echo ${word}` }, h)), removalReason(task));
  }
  assert.equal(
    assertDenied(gate(main, 'Bash', { command: `echo x > ${tooLong}/.claude/ledger.md; echo y > .claude/ledger.md` }, h)),
    mainCheckoutReason(path.join(main, tooLong, '.claude/ledger.md'), path.join(main, '.claude/ledger.md')),
  );
  assertAllowed(gate(`${h}/broken\u0000folder`, 'Write', { file_path: '.claude/ledger.md' }, h));
});

test('a folder the gate may not read counts as no ledger, and the rest of the command is still checked', { skip: process.getuid?.() === 0 && 'root reads every folder' }, (t) => {
  const { h, main, task } = removal(t);
  const locked = path.join(main, 'locked');
  mkdirSync(path.join(locked, 'inside'), { recursive: true });
  chmodSync(locked, 0o000);
  try {
    assert.equal(assertDenied(gate(main, 'Bash', { command: `rm -rf locked/inside ${task}` }, h)), removalReason(task));
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

test('ledger outside hook mode still runs npm ci when the dependencies are missing, and exits with its code', (t) => {
  const h = home(t);
  const { bin, npmRan, env } = uninstalledLedger(h);
  const result = spawnSync(bin, ['list'], { cwd: h, env, encoding: 'utf8' });
  assert.equal(result.status, 3, result.stderr);
  assert.equal(existsSync(npmRan), true, 'npm did not run');
});
