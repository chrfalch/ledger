import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Ran } from './ledger-core-fixtures.js';
import { git } from './ledger-core-fixtures.js';
import { answerGh, failed, hookContext, ledgerOk, machine, remote, remoteFiles, remoteHead, remoteText, run, setUp, type Machine } from './ledger-git-fixtures.js';

/**
 * Machine B cloned the remote, then A pushed the ledger `later`. B fetched it, as a pull that was stopped after its
 * fetch had, but its branch still points at its old tip.
 */
type Behind = { a: Machine; b: Machine; branch: string; origin: string; tip: string };

function behindOrigin(t: TestContext): Behind {
  const bare = remote(t);
  const a = machine(t, bare);
  setUp(a);
  ledgerOk(a, 'task', 'new', 'first', '--goal', 'First.');
  ledgerOk(a, 'store', 'sync');
  const b = machine(t, bare);
  answerGh(b.h, { visibility: 'PRIVATE', isEmpty: false });
  setUp(b);
  ledgerOk(a, 'task', 'new', 'later', '--goal', 'Comes later.');
  ledgerOk(a, 'store', 'sync');
  git(b.h, b.clone, 'fetch', '--quiet', bare, '+refs/heads/*:refs/remotes/origin/*');
  const branch = git(b.h, b.clone, 'symbolic-ref', '--short', 'HEAD');
  const origin = remoteHead(bare);
  assert.equal(git(b.h, b.clone, 'rev-parse', `origin/${branch}`), origin);
  return { a, b, branch, origin, tip: git(b.h, b.clone, 'rev-parse', 'HEAD') };
}

const rebaseMerge = (m: Machine): string => path.join(m.clone, '.git/rebase-merge');

/** What a rebase that git stopped while it wrote its state leaves: `.git/rebase-merge` holding `files`. */
function leaveRebase(m: Machine, files: Record<string, string>): void {
  mkdirSync(rebaseMerge(m));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(rebaseMerge(m), name), text);
}

function trackedLedger(m: Machine, slug: string): string {
  const ledger = git(m.h, m.clone, 'ls-files', '--', 'backlog', 'active')
    .split('\n')
    .find((file) => file.endsWith(`/${slug}.json`)) ?? '';
  assert.match(ledger, /^backlog\//, `${slug} is not a backlog ledger`);
  return ledger;
}

const unpushedCount = (s: Behind): number => Number(git(s.b.h, s.b.clone, 'rev-list', '--count', 'HEAD', '--not', s.origin));

const started = (s: Behind, origHead = s.tip): Record<string, string> => ({
  'head-name': `refs/heads/${s.branch}\n`,
  onto: `${s.origin}\n`,
  'orig-head': `${origHead}\n`,
});

const LEFTOVERS: [what: string, files: (s: Behind) => Record<string, string>][] = [
  ['an empty rebase-merge', () => ({})],
  ['only onto', (s) => ({ onto: `${s.origin}\n` })],
  ['only head-name', (s) => ({ 'head-name': `refs/heads/${s.branch}\n` })],
  ['head-name, onto and orig-head but no todo', (s) => started(s)],
  [
    'every file, with a todo of nothing to apply',
    (s) => ({ ...started(s), 'git-rebase-todo': 'noop\n', 'git-rebase-todo.backup': 'noop\n', interactive: '', quiet: '', msgnum: '0', end: '0' }),
  ],
];

function assertPulled(s: Behind): void {
  assert.equal(existsSync(rebaseMerge(s.b)), false, 'the leftover rebase is still there');
  assert.equal(git(s.b.h, s.b.clone, 'symbolic-ref', '--short', 'HEAD'), s.branch);
  assert.equal(git(s.b.h, s.b.clone, 'rev-parse', 'HEAD'), s.origin);
  assert.equal(git(s.b.h, s.b.clone, 'status', '--porcelain'), '');
  assert.match(ledgerOk(s.b, 'show', 'later', '--repo', 'app'), /Comes later\./);
}

const ASKS_THE_OPERATOR = /An agent does not run these git steps: it asks the operator to run them in a terminal\./;

/**
 * A sync that must not throw the leftover in `state` away: it stops, keeps it, pushes nothing, asks the operator, and
 * does not say to abort it. Only a rebase that got partway has something git rebase --continue would finish.
 */
function assertRefused(s: Behind, ran: Ran, { partway, state = rebaseMerge(s.b) }: { partway: boolean; state?: string }): string {
  const output = failed(ran);
  assert.ok(existsSync(state), 'the leftover rebase was removed');
  assert.equal(remoteHead(s.b.bare), s.origin, 'the sync pushed');
  assert.match(output, ASKS_THE_OPERATOR);
  assert.doesNotMatch(output, /git failed/);
  // git rebase --abort fails on such a leftover, so telling the operator to run it leads nowhere.
  assert.doesNotMatch(output, /git rebase --abort|abort it there/);
  if (partway) assert.match(output, /git rebase --continue/);
  else assert.doesNotMatch(output, /--continue/);
  return output;
}

// ----------------------------------------------------------------------------------------------------- leftover cleared

for (const [what, files] of LEFTOVERS) {
  test(`ledger store sync clears a leftover rebase with ${what} when nothing is unpushed, and pulls`, (t) => {
    const s = behindOrigin(t);
    assert.equal(unpushedCount(s), 0);
    leaveRebase(s.b, files(s));

    ledgerOk(s.b, 'store', 'sync');

    assertPulled(s);
  });

  test(`the session-start pull clears a leftover rebase with ${what} when nothing is unpushed, and pulls`, (t) => {
    const s = behindOrigin(t);
    leaveRebase(s.b, files(s));

    hookContext(s.b);

    assertPulled(s);
  });
}

// A rebase starts only for commits made here, so a rebase that git was stopped in always has a commit not pushed yet.
const UNPUSHED_LEFTOVERS: [what: string, files: (s: Behind, mine: string) => Record<string, string>][] = [
  ['an empty rebase-merge', () => ({})],
  ['orig-head at the branch tip', (s, mine) => started(s, mine)],
];

for (const [what, files] of UNPUSHED_LEFTOVERS) {
  test(`ledger store sync clears a leftover rebase with ${what} while a ledger commit is not pushed, then pushes the commit`, (t) => {
    const s = behindOrigin(t);
    ledgerOk(s.b, 'task', 'new', 'mine', '--goal', 'Made on B.');
    assert.equal(unpushedCount(s), 1);
    const mine = git(s.b.h, s.b.clone, 'rev-parse', 'HEAD');
    leaveRebase(s.b, files(s, mine));

    ledgerOk(s.b, 'store', 'sync');

    assert.equal(existsSync(rebaseMerge(s.b)), false, 'the leftover rebase is still there');
    assert.equal(git(s.b.h, s.b.clone, 'symbolic-ref', '--short', 'HEAD'), s.branch);
    assert.equal(git(s.b.h, s.b.clone, 'status', '--porcelain'), '');
    assert.equal(git(s.b.h, s.b.clone, 'rev-parse', 'HEAD'), remoteHead(s.b.bare));
    assert.equal(git(s.b.h, s.b.clone, 'rev-parse', `${remoteHead(s.b.bare)}^`), s.origin);
    assert.ok(remoteFiles(s.b.bare).some((name) => name.endsWith('/mine.json')), 'the commit made on B is not on the remote');
    assert.match(ledgerOk(s.b, 'show', 'mine', '--repo', 'app'), /Made on B\./);
    assert.match(ledgerOk(s.b, 'show', 'later', '--repo', 'app'), /Comes later\./);
  });
}

// ----------------------------------------------------------------------------------------------------- leftover refused

test('ledger store sync keeps a leftover rebase that started from another commit than the branch tip, without saying to continue it', (t) => {
  const s = behindOrigin(t);
  ledgerOk(s.b, 'task', 'new', 'mine', '--goal', 'Made on B.');
  leaveRebase(s.b, started(s));

  const output = assertRefused(s, run(s.b, ['store', 'sync']), { partway: false });

  assert.match(output, /moved since the rebase started/);
});

test('ledger store sync keeps a leftover rebase of another branch than the one checked out, without saying to continue it', (t) => {
  const s = behindOrigin(t);
  leaveRebase(s.b, { 'head-name': 'refs/heads/other\n' });

  assertRefused(s, run(s.b, ['store', 'sync']), { partway: false });
});

test('ledger store sync keeps what git am left in .git/rebase-apply, and asks the operator without a git error', (t) => {
  const s = behindOrigin(t);
  const state = path.join(s.b.clone, '.git/rebase-apply');
  mkdirSync(state);
  writeFileSync(path.join(state, 'applying'), '');

  const output = assertRefused(s, run(s.b, ['store', 'sync']), { partway: false, state });

  assert.match(output, /git am/);
});

test('ledger store sync keeps a rebase that got partway, with HEAD detached, and names the branch', (t) => {
  const s = behindOrigin(t);
  ledgerOk(s.b, 'task', 'new', 'mine', '--goal', 'Made on B.');
  const mine = git(s.b.h, s.b.clone, 'rev-parse', 'HEAD');
  git(s.b.h, s.b.clone, 'checkout', '--quiet', '--detach', s.origin);
  git(s.b.h, s.b.clone, 'cherry-pick', mine);
  leaveRebase(s.b, { ...started(s, mine), done: `pick ${mine} Update ledgers\n`, 'git-rebase-todo': '', msgnum: '1', end: '1' });

  const output = assertRefused(s, run(s.b, ['store', 'sync']), { partway: true });

  assert.match(output, /partway/);
  assert.match(output, new RegExp(String.raw`\b${s.branch}\b`));
});

test('ledger store sync keeps a leftover rebase that stopped at a commit', (t) => {
  const s = behindOrigin(t);
  leaveRebase(s.b, { ...started(s), 'stopped-sha': `${s.tip}\n` });

  assertRefused(s, run(s.b, ['store', 'sync']), { partway: true });
});

test('ledger store sync keeps a leftover rebase that rebased a commit, with HEAD on the branch', (t) => {
  const s = behindOrigin(t);
  ledgerOk(s.b, 'task', 'new', 'mine', '--goal', 'Made on B.');
  const mine = git(s.b.h, s.b.clone, 'rev-parse', 'HEAD');
  leaveRebase(s.b, { ...started(s, mine), done: `pick ${mine} Update ledgers\n` });

  const output = assertRefused(s, run(s.b, ['store', 'sync']), { partway: true });

  assert.match(output, /partway/);
});

test('ledger store sync keeps a leftover rebase with a conflict in the index, without saying to continue it', (t) => {
  const s = behindOrigin(t);
  const ledger = trackedLedger(s.b, 'first');
  const blob = git(s.b.h, s.b.clone, 'rev-parse', `HEAD:${ledger}`);
  const index = spawnSync('git', ['-C', s.b.clone, 'update-index', '--index-info'], {
    encoding: 'utf8',
    input: [`0 ${'0'.repeat(40)}\t${ledger}`, ...[1, 2, 3].map((stage) => `100644 ${blob} ${stage}\t${ledger}`)].join('\n') + '\n',
  });
  assert.equal(index.status, 0, index.stderr);
  assert.match(git(s.b.h, s.b.clone, 'diff', '--name-only', '--diff-filter=U'), new RegExp(ledger));
  leaveRebase(s.b, started(s));

  const output = assertRefused(s, run(s.b, ['store', 'sync']), { partway: false });

  assert.match(output, /conflict/);
});

// A stuck clone keeps taking the writes of ledger commands, and git rebase --quit leaves the working tree as it is.
test('ledger store sync clears a leftover rebase while a ledger has uncommitted changes, then commits and pushes them', (t) => {
  const s = behindOrigin(t);
  const ledger = trackedLedger(s.b, 'first');
  const file = path.join(s.b.clone, ledger);
  writeFileSync(file, readFileSync(file, 'utf8').replace('First.', 'Changed on B.'));
  assert.equal(unpushedCount(s), 0);
  leaveRebase(s.b, {});

  ledgerOk(s.b, 'store', 'sync');

  assert.equal(existsSync(rebaseMerge(s.b)), false, 'the leftover rebase is still there');
  assert.equal(git(s.b.h, s.b.clone, 'symbolic-ref', '--short', 'HEAD'), s.branch);
  assert.equal(git(s.b.h, s.b.clone, 'status', '--porcelain'), '');
  assert.equal(git(s.b.h, s.b.clone, 'rev-parse', 'HEAD'), remoteHead(s.b.bare));
  assert.match(remoteText(s.b.bare, ledger), /Changed on B\./);
  assert.ok(remoteFiles(s.b.bare).some((name) => name.endsWith('/later.json')), 'the ledger A pushed is gone from the remote');
  assert.match(ledgerOk(s.b, 'show', 'later', '--repo', 'app'), /Comes later\./);
});

// --------------------------------------------------------------------------------------------------------- fast-forward

/** A pre-rebase hook in the folder core.hooksPath of the clone names, which notes in `marker` that it ran. */
function preRebaseHook(m: Machine, exit: 0 | 1): string {
  const marker = path.join(m.h, 'pre-rebase-ran');
  const hook = path.join(m.clone, '.git/hooks/pre-rebase');
  writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\nexit ${exit}\n`);
  chmodSync(hook, 0o755);
  return marker;
}

test('ledger store sync fast-forwards when nothing is unpushed, without starting a rebase', (t) => {
  const s = behindOrigin(t);
  assert.equal(unpushedCount(s), 0);
  const marker = preRebaseHook(s.b, 1);

  ledgerOk(s.b, 'store', 'sync');

  assert.equal(existsSync(marker), false, 'a rebase was started');
  assertPulled(s);
});

test('the session-start pull fast-forwards when nothing is unpushed, without starting a rebase', (t) => {
  const s = behindOrigin(t);
  const marker = preRebaseHook(s.b, 1);

  hookContext(s.b);

  assert.equal(existsSync(marker), false, 'a rebase was started');
  assertPulled(s);
});

test('the pre-rebase hook of the clone runs when ledger store sync rebases a commit not pushed yet', (t) => {
  const s = behindOrigin(t);
  ledgerOk(s.b, 'task', 'new', 'mine', '--goal', 'Made on B.');
  assert.equal(unpushedCount(s), 1);
  const marker = preRebaseHook(s.b, 0);

  ledgerOk(s.b, 'store', 'sync');

  assert.ok(existsSync(marker), 'the hook did not run, so the tests that it does not run prove nothing');
  assert.equal(git(s.b.h, s.b.clone, 'rev-parse', `${remoteHead(s.b.bare)}^`), s.origin);
});

// The apply backend does not run post-commit, so a post-commit hook that sees .git/rebase-merge proves the merge backend.
test('ledger store sync rebases with the merge backend when the clone sets rebase.backend to apply', (t) => {
  const s = behindOrigin(t);
  ledgerOk(s.b, 'task', 'new', 'mine', '--goal', 'Made on B.');
  git(s.b.h, s.b.clone, 'config', 'rebase.backend', 'apply');
  const marker = path.join(s.b.h, 'merge-backend-ran');
  const hook = path.join(s.b.clone, '.git/hooks/post-commit');
  writeFileSync(hook, `#!/bin/sh\n[ -d "$(git rev-parse --git-dir)/rebase-merge" ] && touch "${marker}"\nexit 0\n`);
  chmodSync(hook, 0o755);

  ledgerOk(s.b, 'store', 'sync');

  assert.ok(existsSync(marker), 'the rebase did not use the merge backend');
  assert.equal(existsSync(path.join(s.b.clone, '.git/rebase-apply')), false);
  assert.equal(git(s.b.h, s.b.clone, 'rev-parse', `${remoteHead(s.b.bare)}^`), s.origin);
  assert.ok(remoteFiles(s.b.bare).some((name) => name.endsWith('/mine.json')), 'the commit made on B is not on the remote');
});
