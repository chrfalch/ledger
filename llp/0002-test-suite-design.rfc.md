# LLP 0002: Test suite design

**Type:** RFC
**Status:** Draft
**Systems:** tests, ledger CLI, ledger store
**Author:** Christian Falch / Claude
**Date:** 2026-11-25
**Related:** LLP 0000, LLP 0001

## Summary

The full test suite takes about 25 minutes, so it is too slow to run on every
change. Waiting on time limits is a minor cause. The main cause is the way the
tests run. Nearly every test launches the whole `ledger` program as a separate
process, often against real git repositories, and the test runner runs about
nine test files at once. Those processes crowd each other: one test takes
4.4 s on its own and 76 s in the full run.

This RFC proposes that most tests run the command inside the test process,
which needs four things:

- a store kept in memory;
- a fake clock;
- the command's output collected by the test;
- module state reset between tests.

Behaviour that only exists between real processes keeps real-process tests:

- the git store;
- locks between processes;
- killing a hung `git`;
- exit codes from the shell script `bin/ledger`.

Those tests form a full run that runs before every PR. One shared set of store
tests runs against all four stores, so the memory store cannot drift from the
real ones.

## Motivation

### Measurements

All runs were on 2026-11-25, on a 10-core machine, at commit `0c46ea4`
[observed]:

| Run | Wall time | Tests | Result |
|---|---|---|---|
| `npm test`, parallel, while another task also ran tests | 1504.7 s | 2559 | 2550 pass, 8 fail, 1 skipped |
| `tests/ledger-git-store.test.ts` alone | 364.9 s | 146 | all pass; 60 over 2 s; slowest 15.2 s |
| one git-store test, "sync init refuses a repository with a symbolic link…", alone | 4.4 s | 1 | pass |
| the same test inside the full run | 76.6 s | — | pass |
| one `ledger notes --help` start | 0.14 s | — | — |

- **Mostly waiting.** The durations the full run reports add up to
  11,114 s. CPU time was only about 2,008 s. So most of each test's time was
  spent waiting, not computing [observed].
- **What the waiting is.** It is mostly waiting for the disk and for new
  processes to start, among thousands of `node` and `git` processes
  [inferred].
- **Fixed limits.** In git-store, the waits on fixed time limits and on
  deliberate sleeps come to roughly 75 s of the 365 s [inferred from code].

### Why tests wait on time limits

Production code has fixed limits:

- session start gets 5 s in total;
- the pull-request check gets 3 s;
- a lock held by a live process is waited on for 5 s.

A test that proves "a hang is cut off" sits through the real limit. The limit
is a constant, and the code under test runs in a child process, so a test
cannot shorten it. The constants are `GIT_TIMEOUT_MS` in
`tools/ledger/hooks.ts`, `PR_CHECK_MS` in `tools/ledger/pr-check.ts`, and
`WAIT_MS` in `tools/ledger/lock.ts` [observed].

### Why tests launch the whole program

Most behaviour is checked through the command line. A test runs
`bin/ledger …` as a child process and reads what it prints. The git-store
tests also build, for each test, a temporary home folder, a clone, a bare
remote, and a `sync init` [observed].

That is the right tool for behaviour that only exists between processes. It
is a costly tool for behaviour that is one decision, such as refusing a
repository that holds a symbolic link. A process launch costs at least 0.14 s
on an idle machine, and far more under load.

## Design

### 1. Commands that run inside the test

`main(argv)` in `tools/ledger/cli.ts` already returns the exit code, and no
module under `tools/ledger/` calls `process.exit` [observed]. A failure is a
thrown `Failure` that carries its exit code. `main` catches it (`cli.ts:918`)
[observed]. So the entry point needs inputs and collected output, not a
rewrite.

`runLedger(argv, deps)` takes these inputs:

- `home`, `cwd` and `env`;
- `store`, which is optional and defaults to the configured store;
- `clock`;
- `stdin`.

It returns `{ code, stdout, stderr }`. `main` becomes `runLedger` with the
real process values.

The work, from the code survey [observed]:

- **Inputs.** `cli.ts:251-252` reads `HOME` and `process.cwd()`; these come
  from `deps` instead.
- **Output.** These writes go to the collected streams:
  - the 19 `console.*` calls and 4 `process.stdout.write` calls in `cli.ts`;
  - commander's own output, through `configureOutput`;
  - the `console.*` calls in `retire.ts`, `git-store.ts`, `settings.ts`,
    `write.ts`, `worktrees.ts` and `clone.ts`.
- **Environment reads deep in modules.** These come from `deps.env`:
  - `claims.ts` reads `LEDGER_NOW` and `CLAUDE_CODE_SESSION_ID`;
  - `git-store.ts` reads `LEDGER_TEST_NO_BACKGROUND_SYNC`;
  - `wait.ts` reads `LEDGER_TEST_DELAY_MS`;
  - child processes inherit `process.env`, so `git.ts` and `clone.ts` pass
    the environment on explicitly.
- **Module state.** `resetRunState()` in `cli.ts` clears all of it at the
  start of every run, the production run included, so each run starts as a
  fresh process does. The state is:
  - the limits set by `limitGitCalls`, `limitLockWaits` and
    `limitCloneGitCalls`;
  - the `unanswered` set in `git.ts`;
  - the `keys` cache in `repo-key.ts`;
  - `createdHere` in `store.ts`;
  - the `…ForTests` setters in `sync.ts` and `git-store.ts`.

  The hooks set those limits and never reset them [observed].

`bin/ledger` keeps its own tests for what only it does: the Node version check
and the exit code.

**As built** (step 1):

- **Passed as parameters.** `home`, `cwd`, `store`, `stdin` and the two
  output streams are parameters of `commandLine` in `cli.ts`.
  - `main` passes the process streams, so production output still streams
    with the same bytes and order.
  - `runLedger` passes streams that collect what is written to them.
- **Scoped to the run.** The environment and the console come from
  `tools/ledger/run-io.ts`. It uses AsyncLocalStorage, a Node feature that
  keeps one value per chain of async calls:
  - `runEnv()` is what ledger reads variables from, and what every child
    process it starts inherits.
  - `runConsole()` is where the deep modules print.

  Most code that reads these has no `Context`, git calls in particular, so
  passing them down would touch every caller.
- **The console inside `commandLine`.** In `commandLine`, a local
  `const console = runConsole()` hides the global console. That way the
  command bodies, which another branch is editing, did not change.
- **Runs must not overlap.** Only the environment and the console are kept
  apart per run. The limits and caches that `resetRunState()` clears are
  shared, so runs in one process must not overlap in time. node:test runs the
  tests of a file one at a time.
- **Known gaps:**
  - `ledger deploy` still hands the real terminal to the interactive
    `bin/deploy`.
  - `store repair` and `store migrate` open their own store from `home`, not
    the given one.
  - `tmpdir()` reads the process `TMPDIR`, not the run's environment.

### 2. A fake clock

The `Clock` has two members: `now()` and `today()`. Production passes the
system clock. Tests pass a clock they can move forward. The code survey found
three kinds of time use [observed].

| Kind | Count | Examples | With the fake clock |
|---|---|---|---|
| Decisions on a time value | about 12 | claim expiry (`claims.ts`); `today()` in notes, retire, repair and worktrees; stale-lock age (`lock.ts` `STALE_MS`, `GUARD_STALE_MS`); the daily check (`sync.ts` `DAY_MS`) | driven fully; no waiting |
| Waits on a real child process | about 14 | the `spawnSync` timeout in `git.ts` and `clone.ts`; the gh budgets in `pr-check.ts`; the session-start deadline in `hooks.ts` | the deadline arithmetic is tested with the fake clock; the kill of a hung process is not |
| Polling waits | 3 | the lock retry loop and release spin in `lock.ts`; `wait.ts` | the fake clock's `sleep` moves time on; locks between real processes stay in real-process tests |

The fake clock replaces `LEDGER_NOW`. Code that today reads `LEDGER_NOW` reads
`clock.now()`.

**Real hangs.** A few real-process tests keep proving that a hung `git` or
`gh` is killed. They use a shortened limit, which follows the existing
`LEDGER_TEST_GH_TIMEOUT_MS` pattern. A test-only preload
(`tests/fixtures/git-test-remote.mjs`) reads one `LEDGER_TEST_*` variable and
calls a `…ForTests` setter, so production code reads no such variable. The aim
is 5 to 10 such tests, not the roughly 60 that wait today.

**As built** (step 2):

- **The clock.** `tools/ledger/clock.ts` has `Clock` and `systemClock`. The
  clock is a third field of the run values in `run-io.ts`, read with
  `runClock()`. Outside a run it is the system clock. `runLedger` takes an
  optional `clock`; `main` passes the system clock.
- **What reads it.** Claim expiry in `claims.ts`, `today()` in `write.ts`, the
  stale-lock ages and the `since` stamp in `lock.ts`, and the daily check with
  its stamps in `sync.ts`. `LEDGER_NOW` is gone.
- **What still reads real time.** Deadlines, timeouts and polling loops: the
  lock retry and release loops, the session-start time left, and every
  `spawnSync` timeout. The fake clock's `sleep` from the table above is not
  built.
- **Claims tests.** A fake clock cannot reach a child process, so
  `ledger-core-claims` runs in the test process now, with `fakeClock()` from
  the fixtures, instead of waiting for step 4.
- **Short limits.** Four setters return the value they replace:
  `limitHookTimeForTests` (`hooks.ts`; the time kept after the pull scales
  with it), `limitPrCheckTimeForTests` (`pr-check.ts`; the update budget
  scales with it), `limitLockWaitForTests` (`lock.ts`) and
  `limitBusyWaitForTests` (`sqlite-store.ts`). The preload maps
  `LEDGER_TEST_HOOK_TIME_MS`, `LEDGER_TEST_PR_CHECK_TIME_MS`,
  `LEDGER_TEST_LOCK_WAIT_MS` and `LEDGER_TEST_BUSY_WAIT_MS` to them. Tests
  that spawn through `commandEnv` opt in with `shortLimits()`; in-process
  tests call a setter and restore it in `t.after`. `resetRunState()` does not
  reset them, because in a real process it runs after the preload.
- **Assertions.** A wall-time bound keeps its slack above the limit; only the
  limit shrinks. A test whose bound would then pass at the production limit
  uses a smaller limit (core-hooks uses 1 s). That limit is also each git
  call's timeout in those tests, so a slow git under load can fail them.

### 3. A memory store

`memoryStore({ home })` in `tests/memory-store.ts` implements `LedgerStore`
(`tools/ledger/store.ts:297`) with maps. It lives in `tests/`, as only tests
use it. There is one per HOME, so a store opened again on the same HOME reads
what the first one wrote. It joins the store contract suite `storeContract`
(`tests/ledger-core-store.test.ts:52`), which runs 40 tests against the file,
SQLite and git stores [observed]. It also joins the active-record loop in
`tests/ledger-active-store.test.ts`.

The memory store keeps no Markdown from before task records. So it leaves out
`markdownNames`, `markdownText`, `toRecord` and `hiddenMarkdown`, and the
suite runs it with `{ markdown: false }`. That skips the 13 tests that plant
such Markdown. The other 27 pass [confirmed].

What a memory store does not cover, so those tests stay on a real store
[observed]:

- **Archive evidence** is real folders. A memory store holds the files' bytes.
  It reads and writes the folders with the SQLite store's helpers. Tests of
  folder handling, such as symbolic links or taken names, stay on the file
  store.
- **Settings** are read from disk under `home`. In-process tests still get a
  temporary home with a settings file. This is cheap: no git, no process.
- **Paths in messages.** `location()` and `repoLocation()` return paths, so
  the memory store returns fixed made-up paths.
- **Git-store only:**
  - `commit`;
  - `commitPending`;
  - background sync;
  - the session-start pull;
  - everything in `sync.ts` and `clone.ts`.
- **Locks and folders.** File locks that sit outside the store;
  `sharesFolder`, which checks two keys that share a folder; and
  `movedHalfway` and `acrossDisks`, as a move in memory is no link.
- **Host labels.** The store has no `host`, so no record counts as another
  machine's by its host alone.

**Fixture seeding.** `backlogTask`, `archivedTask`, `activeFile` and
`writeLedgerFile` in `tests/ledger-core-fixtures.ts` take an optional
`{ store }` last. With a store they write through it and give the store's
location. `writeLedgerFile` then takes that location and rewrites the backlog
or active ledger there. `runInProcessWith` takes a `store` too, and the run
uses it in place of the one the settings name.

Without a store the fixtures still write legacy Markdown files and give their
paths. The tests call them about 260 times, and most callers read the files
back from disk [observed]. Those callers move to the store with their file in
step 4. The heaviest users are `core-write`, `core-json`, `core-retire`,
`core-cli` and `core-claims`. `core-hooks` does not use them: it seeds with
`writeFileSync` directly [observed].

### 4. A quick run and a full run

- `npm test` runs the quick files: in-process, memory store, fake clock.
- `npm run test:full` runs everything, including the real-process files.

These are the real-process files:

- the git-store files;
- the multi-process lock and concurrency files;
- the hung-process tests;
- the store contract suite against the file, SQLite and git stores;
- `bin/ledger` itself.

They are named `*.e2e.test.ts`. E2E means end to end: tests that run the
whole program.

The full run runs before every PR, as the workflow's verify step already
requires (LLP 0001). It does not run only when the git store's files change.
Git-store behaviour also depends on `lock.ts`, `sync.ts`, `clone.ts` and
`hooks.ts`, and a rule keyed to changed files would miss those.

### 5. The rule for new tests

A new test runs in-process, unless the behaviour exists only between real
processes. Those are the cases this RFC keeps in the full run:

- the git store;
- locks between processes;
- killing a hung process;
- `bin/ledger` itself.

Existing test files move one at a time.

### Not proposed

- **Running test files one at a time** (`--test-concurrency=1`). It avoids
  crowding, but a serial run takes tens of minutes.
- **Lowering production limits.** The limits protect session start from a
  hung network.
- **Building git fixtures once and copying them per test.** This could speed
  up the git-store files that remain. It is deferred until the full run is
  measured after the moves below.

## Plan

Each step is one PR and one task, under one parent task.

1. **In-process entry.**
   - Changes: `runLedger(argv, io)`, collected output, `resetRunState()`,
     and a `runInProcess` test helper.
   - Proof: move one small file, `ledger-gates`.
   - Also: record per-file times on an idle machine, which set the order of
     step 4.
2. **Clock.**
   - Changes: `Clock` threaded through the decision sites. It replaces
     `LEDGER_NOW`.
   - Real hangs: shortened limits through the preload, for the real-process
     hang tests.
3. **Memory store.**
   - Changes: `memoryStore()` in `tests/`, in the contract suite without its
     Markdown tests, and fixtures that take an optional store to seed
     through.
4. **Move test files.**
   - One file per PR, slowest first, by the step 1 times.
   - Candidates (from code reading, not yet measured): `core-write`,
     `core-cli`, `core-json`, `core-claims`, `core-sqlite`, `task-command`,
     then the in-process parts of `core-hooks`, `core-retire` and
     `repo-ids`.
   - Coordination: a file that another task is editing waits until that task
     merges.
5. **Quick and full runs.**
   - Changes: the `*.e2e.test.ts` names, `npm test` and `npm run test:full`.
   - Also: the verify step in LLP 0001 and the rules name `test:full`. Record
     the time before and after.

## Open questions

- **The 8 failures on main.** Four `ledger-core-hooks` session-start tests
  failed in the full run (lines 422, 756, 783, 2130). Did load push them past
  the 5 s limit? Resolved in step 2: each passes alone in 0.4 to 1.1 s, so
  load, not the limit.
- **The four `ledger-task-command` failures** expect rule text that has since
  changed (lines 179, 193, 219, 232). They are outside this RFC, but they keep
  the full run failing.
- **Isolation inside one file.** Is per-run `resetRunState()` enough, or
  should each in-process run load fresh modules? node:test runs each file in
  its own process, and the tests in a file one at a time, which limits the
  risk. Only the time-limit resets have a test. Clearing `unanswered`, the
  repo-key cache and `createdHere` has none yet.
- **A target for the quick run** on this machine: 1 minute? And for the full
  run?
