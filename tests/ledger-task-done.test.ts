import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { FakeGit } from './fixtures/fake-git.js';
import { backlogTask, fakeRepository, fakeWorktreeTask, home, readLedgerFile, runInProcess, recordFile, useFakeGit, worktreeOf, writeLedgerFile, type Ran } from './ledger-core-fixtures.js';

// LLP 0001 D4 and D15: a task becomes done on "Goal met" when it has no PR, and only once its PR is merged when it has one.

const PR = 'https://github.com/acme/app/pull/42';

function setup(t: TestContext) {
  const h = home(t);
  const fake = useFakeGit(t);
  const app = fakeRepository(fake, h, path.join(h, 'repos/app'));
  return { h, app, fake, calls: path.join(h, 'gh-calls') };
}

function located(fake: FakeGit, h: string, app: string, slug: string, ...bullets: string[]): string {
  const file = fakeWorktreeTask(fake, h, app, { slug });
  writeLedgerFile(file, readLedgerFile(file).replace('- design refs: none', ['- design refs: none', ...bullets].join('\n')));
  return file;
}

function stubGh(h: string, calls: string, script: string): void {
  const file = path.join(h, 'stub-bin/gh');
  writeFileSync(file, `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\n${script}\n`);
  chmodSync(file, 0o755);
}

const prState = (state: string): string => `case "$*" in "pr view ${PR} --json state") echo '{"state":"${state}"}' ;; *) exit 1 ;; esac`;

function today(): string {
  const date = new Date();
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(2, '0')).join('-');
}

const doneLine = (): RegExp => new RegExp(`^- status: done ${today()}$`, 'm');
const doneText = (slug: string, finalize = slug): string => `${slug} is done. Finalize it with the question from \`ledger task gate finalize ${finalize}\`.\n`;

function refused(ran: Ran, message: RegExp): void {
  assert.equal(ran.status, 1, ran.stdout);
  assert.equal(ran.stdout, '');
  assert.match(ran.stderr, message);
}

test('task done marks the active task of the worktree done when it has no PR, and says to finalize it', async (t) => {
  const { h, app, fake } = setup(t);
  const file = located(fake, h, app, 'epic');
  const ran = await runInProcess(h, worktreeOf(app, 'epic'), 'task', 'done');
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, doneText('epic'));
  assert.match(readLedgerFile(file), doneLine());
});

test('task done takes a slug, or <slug>@<path> from outside the repo, which the finalize command then names', async (t) => {
  const { h, app, fake } = setup(t);
  located(fake, h, app, 'epic');
  located(fake, h, app, 'other');
  const named = await runInProcess(h, app, 'task', 'done', 'epic');
  assert.equal(named.stdout, doneText('epic'), named.stderr);
  const elsewhere = await runInProcess(h, h, 'task', 'done', `other@${app}`);
  assert.equal(elsewhere.stdout, doneText('other', `other@${app}`), elsewhere.stderr);
});

test('task done --json prints the task, its ledger and the finalize command', async (t) => {
  const { h, app, fake } = setup(t);
  const file = located(fake, h, app, 'epic');
  const ran = await runInProcess(h, app, 'task', 'done', 'epic', '--json');
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout), { ok: true, slug: 'epic', ledger: file, finalize: 'ledger task gate finalize epic' });
});

test('task done refuses a parked, blocked, lost or done task with the move check message, and changes nothing', async (t) => {
  const { h, app, fake } = setup(t);
  const lost = `- lost: 2026-11-22 — folder ${worktreeOf(app, 'epic')} not found`;
  const file = located(fake, h, app, 'epic');
  const plain = readLedgerFile(file);
  const withBullet = (bullet: string): string => plain.replace('- design refs: none', `- design refs: none\n${bullet}`);
  for (const [bullet, message] of [
    ['- status: parked 2026-11-20 — later', /^epic is parked, so it cannot become done\. A parked task can become active\.$/m],
    ['- status: blocked 2026-11-20 — the API', /^epic is blocked, so it cannot become done\. A blocked task can become active\.$/m],
    [lost, /^epic is lost, so it cannot become done\. A lost task can become active\.$/m],
    ['- status: done 2026-11-20', /^epic is done, so it cannot become done\. Finalize it with the question from `ledger task gate finalize epic`\.$/m],
  ] as const) {
    writeLedgerFile(file, withBullet(bullet));
    const before = readLedgerFile(file);
    refused(await runInProcess(h, app, 'task', 'done', 'epic'), message);
    assert.equal(readLedgerFile(file), before, bullet);
  }
});

test('task done marks a task done whose PR gh says is merged, waiting or active', async (t) => {
  const { h, app, calls, fake } = setup(t);
  stubGh(h, calls, prState('MERGED'));
  const waiting = located(fake, h, app, 'waiting', '- status: waiting 2026-11-20', `- pr: ${PR}`);
  const active = located(fake, h, app, 'active', `- pr: ${PR}`);
  for (const [slug, file] of [['waiting', waiting], ['active', active]]) {
    const ran = await runInProcess(h, app, 'task', 'done', slug);
    assert.equal(ran.stdout, doneText(slug), ran.stderr);
    assert.match(readLedgerFile(file), doneLine());
  }
  assert.match(readFileSync(calls, 'utf8'), new RegExp(`^pr view ${PR} --json state$`, 'm'));
});

test('task done refuses a task whose PR is not merged, and says to merge it after the merge question', async (t) => {
  const { h, app, calls, fake } = setup(t);
  const file = located(fake, h, app, 'epic', '- status: waiting 2026-11-20', `- pr: ${PR}`);
  const before = readLedgerFile(file);
  for (const state of ['OPEN', 'CLOSED']) {
    stubGh(h, calls, prState(state));
    refused(
      await runInProcess(h, app, 'task', 'done', 'epic'),
      new RegExp(`^epic: its PR ${PR} is not merged, so the task is not done\\. Merge it first, after the question from \`ledger task gate merge epic\`\\.$`, 'm'),
    );
    assert.equal(readLedgerFile(file), before, state);
  }
});

test('task done refuses a task with a PR when gh cannot say whether it is merged, and changes nothing', async (t) => {
  const { h, app, calls, fake } = setup(t);
  const file = located(fake, h, app, 'epic', '- status: waiting 2026-11-20', `- pr: ${PR}`);
  const before = readLedgerFile(file);
  for (const script of ['echo "gh: not logged in" >&2; exit 4', 'echo not json']) {
    stubGh(h, calls, script);
    refused(await runInProcess(h, app, 'task', 'done', 'epic'), new RegExp(`^epic: gh could not say whether its PR ${PR} is merged, so the task is not done\\.`, 'm'));
    assert.equal(readLedgerFile(file), before, script);
  }
});

test('task done does not ask gh about a task with a PR that cannot become done', async (t) => {
  const { h, app, calls, fake } = setup(t);
  stubGh(h, calls, prState('MERGED'));
  const file = located(fake, h, app, 'epic', '- status: parked 2026-11-20 — later', `- pr: ${PR}`);
  const before = readLedgerFile(file);
  refused(await runInProcess(h, app, 'task', 'done', 'epic'), /^epic is parked, so it cannot become done\./m);
  assert.equal(readLedgerFile(file), before);
  assert.equal(existsSync(calls), false, 'gh was asked');
});

test('task done refuses a backlog task, which has not started, and changes nothing', async (t) => {
  const { h, app } = setup(t);
  const file = backlogTask(h, app, { slug: 'idea' });
  const before = readLedgerFile(file);
  refused(await runInProcess(h, app, 'task', 'done', 'idea'), /^idea is in the backlog: it has not started, so it cannot be done\. Start it with ledger go idea\.$/m);
  assert.equal(readLedgerFile(file), before);
});

test('task done outside a task, with no slug, says to name one', async (t) => {
  const { h } = setup(t);
  refused(await runInProcess(h, h, 'task', 'done'), /ledger task done <slug>/);
});

test('task done refuses when the PR link changes while gh is asked, and changes nothing else', async (t) => {
  const { h, app, calls, fake } = setup(t);
  const file = located(fake, h, app, 'epic', '- status: waiting 2026-11-20', `- pr: ${PR}`);
  stubGh(h, calls, `perl -pi -e 's{pull/42}{pull/43}g' ${JSON.stringify(recordFile(file))}; echo '{"state":"MERGED"}'`);
  const before = readLedgerFile(file);
  refused(await runInProcess(h, app, 'task', 'done', 'epic'), /^epic: its PR link changed while it was being marked done\. Run ledger task done again\.$/m);
  assert.doesNotMatch(readLedgerFile(file), /^- status: done/m);
  assert.equal(readLedgerFile(file), before.replace(PR, PR.replace('/42', '/43')));
});

test('task done does not ask gh about a task of another machine, and refuses it', async (t) => {
  const { h, app, calls, fake } = setup(t);
  stubGh(h, calls, prState('MERGED'));
  const file = located(fake, h, app, 'epic', '- status: waiting 2026-11-20', `- pr: ${PR}`, '- host: other-host');
  const before = readLedgerFile(file);
  refused(await runInProcess(h, app, 'task', 'done', 'epic'), /other-host/);
  assert.equal(readLedgerFile(file), before);
  assert.equal(existsSync(calls), false, 'gh was asked');
});
