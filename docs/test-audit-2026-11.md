# Test suite audit, November 2026

Written 2026-11-27 at commit `df2f972`. Nothing was run. Every bucket is decided from reading the code, and every time is an estimate (see "How times were estimated").

## 1. Summary

- We sorted 2,542 tests in 63 files. A test inside a loop counts once for each pass, where the classifier counted that way.
- **Real program, keep as is:** 430 tests (17%). They need a real process, real git, real bash, two machines or several processes at once.
- **Make fast:** 1,728 tests (68%) check logic that can run inside the test process in milliseconds. 808 of them already do; 920 would move.
- **Merge:** 237 tests repeat another test and can join it, mostly as table tests.
- **Wording:** 85 tests check the exact wording of rule, command or agent text, not behaviour.
- **Delete:** 62 tests are fully covered by another kept test.
- **Unsure:** 161 tests carry an "unsure" mark. They stay in their bucket until you decide.
- **Expected result:** about 2,180 tests remain, and only about 430 of them start real processes. The summed test time drops from about 8,900 s to about 3,300 s, which is 63% less. The full run would take roughly 8–10 minutes on a quiet machine instead of 25. A quick run without the real-program tests would take about a minute.
- **Biggest wins:** most of the cost is not the checks. It is test setup that builds real git repositories and starts the `ledger` program for tests that never look at git:
  - retire, notes, write and migrate save about 1,630 s together;
  - the deploy tests save about 650 s if `deploy()` runs inside the test;
  - the repo key and repair tests save about 680 s;
  - in the git-store tests, about 800 s of fixture setup could become a copy of one prebuilt repository.
- **Found on the way:**
  - The 236 tests in `mods/ledger/hooks/` do not run in `npm test` at all.
  - Three tests are probably failing today.

## 2. Proposed sorting rules (for approval)

These refine the brief's buckets with what the classification found.

1. **Real program (keep-e2e).** Keep a test as a real-process test only when the behaviour exists only between real processes:
   - the git store: clone, push, pull, rebase, pre-push hook, two machines;
   - locks held by another process, and several processes writing at once;
   - killing a hung `git` or `gh`, and process groups;
   - `bin/ledger`, `bin/deploy` and `bin/cc-dd-path` as shell scripts: exit codes, PATH and the shell wrapper;
   - code written in bash: `usage-pace.sh`, the status line and the derived-data gate.
   Keep one smoke test per command path, not one per variant.
2. **Git used only as setup moves.** Some tests create a real repository only so that a path, branch or repo key exists, and the code under test never asks git. Those tests run inside the test process on the memory store. There are two ways to give them a repo key and main checkout without git. Rule 8 asks you to choose one.
3. **Store variants.** The shared store tests run on all four stores (memory, file, SQLite and git). A git-store run of a read-only test can go, because those reads go straight to the file store. Keep the git variant only when it writes or syncs.
4. **One test per decision.** When several tests check the same decision with different inputs (refusal messages, flag clashes, URL forms, review rounds), they become one table test.
5. **Wording tests.** A check that a rule names a command, a gate or an agent becomes a structural check: the section exists and names it. A check that compares whole sentences is dropped. The rule text is reviewed in the PR, not by a test.
6. **Help text.** `--help` tests check that each command and option is named, inside the test process. They do not compare prose.
7. **Self-tests of test helpers.** Keep one small test per helper that a lot of tests depend on (`memoryStore`, `fakeClock`). Drop the others (`packageFolders` in retire).
8. **Seams needed (your decision).** About 300 of the moves depend on new ways to pass in a fake:
   - the repo key and main checkout, about 200 tests, mainly repair, repo-ids, claims and migrate;
   - the gh PR state, about 15 tests;
   - the git runner in `retire.ts`;
   - the child processes of `deploy()` and its `REPO` path, about 70 deploy tests;
   - a prompt seam in `tools/wizard.ts`, 9 tests.
   Without a seam, a test still moves inside the test process, but keeps its real-git setup at about 1–1.5 s each.
9. **Unsure stays.** A test marked unsure keeps its current form until it is decided. A test is merged or deleted only when the test that covers it is kept.

### How times were estimated

Each child process counts as 1.0 s, each git command or repository as 0.2 s, and each two-machine remote setup as about 2 s, all under full-suite load. An in-process call counts as 0.01 s. Known sleeps and waits are added. Summed over all files, this gives about 8,900 s. The measured sum on 2026-11-25 was 11,114 s, over 1,505 s of wall time (LLP 0002), so the model is in the right range but low. "Saved" is per file, summed over its tests; it is not wall time.

## 3. Per file

Sorted by estimated time saved. "Tests" is the number of rows the classifier wrote. Files with loops may count each pass.

| File | Tests | keep-e2e | to-unit (already unit) | merge | wording | delete | unsure | Est. now | Est. after | Saved |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `tests/ledger-core-retire.test.ts` | 114 | 12 | 71 (11) | 28 | 2 | 1 | 5 | 540 s | 71 s | 469 s |
| `tests/deploy.test.ts` | 61 | 6 | 42 (0) | 6 | 0 | 7 | 1 | 470 s | 47 s | 423 s |
| `tests/ledger-notes.test.ts` | 67 | 2 | 57 (0) | 6 | 1 | 1 | 1 | 430 s | 30 s | 400 s |
| `tests/ledger-core-write.test.ts` | 97 | 5 | 81 (2) | 10 | 1 | 0 | 1 | 415 s | 27 s | 388 s |
| `tests/ledger-core-migrate.test.ts` | 25 | 2 | 21 (2) | 1 | 0 | 1 | 2 | 400 s | 20 s | 380 s |
| `tests/ledger-store-repair.test.ts` | 136 | 39 | 88 (8) | 9 | 0 | 0 | 65 | 560 s | 190 s | 370 s |
| `tests/ledger-other-machines.test.ts` | 60 | 30 | 22 (5) | 8 | 0 | 0 | 5 | 690 s | 345 s | 345 s |
| `tests/ledger-core-sqlite.test.ts` | 42 | 7 | 28 (1) | 7 | 0 | 0 | 2 | 370 s | 42 s | 328 s |
| `tests/ledger-core-repo-ids.test.ts` | 123 | 0 | 116 (6) | 7 | 0 | 0 | 2 | 315 s | 1.5 s | 314 s |
| `tests/ledger-core-hooks.test.ts` | 250 | 18 | 203 (119) | 26 | 0 | 3 | 9 | 330 s | 71 s | 259 s |
| `tests/deploy-mods.test.ts` | 30 | 1 | 21 (1) | 7 | 0 | 1 | 1 | 230 s | 8 s | 222 s |
| `tests/ledger-git-store.test.ts` | 136 | 100 | 23 (7) | 9 | 1 | 3 | 8 | 1340 s | 1140 s | 200 s |
| `tests/ledger-core-cli.test.ts` | 39 | 3 | 32 (1) | 3 | 0 | 1 | 1 | 186 s | 19 s | 167 s |
| `tests/ledger-active-core.test.ts` | 46 | 7 | 35 (5) | 4 | 0 | 0 | 2 | 146 s | 22 s | 124 s |
| `tests/ledger-awareness.test.ts` | 59 | 2 | 56 (5) | 1 | 0 | 0 | 0 | 125 s | 21 s | 104 s |
| `tests/ledger-core-json.test.ts` | 37 | 2 | 32 (0) | 3 | 0 | 0 | 2 | 106 s | 5 s | 101 s |
| `tests/ledger-git-sync-rebase.test.ts` | 15 | 14 | 0 (0) | 1 | 0 | 0 | 4 | 550 s | 455 s | 95 s |
| `tests/ledger-core-worktrees.test.ts` | 23 | 3 | 17 (1) | 1 | 1 | 1 | 2 | 107 s | 17 s | 90 s |
| `tests/ledger-core-claims.test.ts` | 42 | 0 | 39 (32) | 3 | 0 | 0 | 7 | 105 s | 18 s | 87 s |
| `tests/ledger-active-migrate.test.ts` | 23 | 1 | 16 (3) | 1 | 1 | 4 | 2 | 90 s | 6.5 s | 84 s |
| `tests/wizard-pty.test.ts` | 19 | 10 | 9 (0) | 0 | 0 | 0 | 9 | 145 s | 75 s | 70 s |
| `tests/ledger-gates.test.ts` | 40 | 0 | 36 (13) | 3 | 0 | 1 | 0 | 64 s | 0.4 s | 64 s |
| `tests/ledger-core-repo-key.test.ts` | 37 | 1 | 28 (15) | 8 | 0 | 0 | 0 | 65 s | 2 s | 63 s |
| `tests/ledger-core-install.test.ts` | 11 | 1 | 5 (0) | 5 | 0 | 0 | 0 | 63 s | 8 s | 55 s |
| `tests/ledger-deploy-latest.test.ts` | 47 | 36 | 4 (0) | 6 | 1 | 0 | 1 | 245 s | 192 s | 53 s |
| `tests/deploy-worktree.test.ts` | 15 | 3 | 5 (1) | 6 | 1 | 0 | 3 | 60 s | 7 s | 53 s |
| `tests/ledger-task-list.test.ts` | 6 | 0 | 4 (0) | 2 | 0 | 0 | 3 | 33 s | 0.04 s | 33 s |
| `tests/ledger-pending-moves.test.ts` | 11 | 0 | 10 (0) | 0 | 0 | 1 | 0 | 31 s | 0.1 s | 31 s |
| `tests/ledger-core-store.test.ts` | 223 | 21 | 159 (157) | 13 | 0 | 30 | 2 | 40 s | 14 s | 26 s |
| `tests/ledger-task-command.test.ts` | 54 | 0 | 7 (0) | 9 | 37 | 1 | 3 | 28 s | 2 s | 26 s |
| `tests/ledger-task-done.test.ts` | 12 | 0 | 11 (0) | 1 | 0 | 0 | 0 | 25 s | 0.1 s | 25 s |
| `tests/ledger-core-concurrency.test.ts` | 19 | 11 | 7 (3) | 1 | 0 | 0 | 3 | 142 s | 118 s | 24 s |
| `tests/deploy-runtime.test.ts` | 23 | 19 | 1 (0) | 3 | 0 | 0 | 0 | 104 s | 82 s | 22 s |
| `tests/ledger-core-migrate-records.test.ts` | 8 | 0 | 6 (0) | 1 | 1 | 0 | 0 | 22 s | 0.1 s | 22 s |
| `tests/derived-data-gate.test.ts` | 25 | 11 | 0 (0) | 14 | 0 | 0 | 0 | 69 s | 50 s | 19 s |
| `tests/build-rules.test.ts` | 18 | 2 | 15 (0) | 1 | 0 | 0 | 4 | 22 s | 5 s | 17 s |
| `tests/ledger-git-sync-lock.test.ts` | 8 | 7 | 0 (0) | 1 | 0 | 0 | 2 | 105 s | 92 s | 13 s |
| `tests/statusline.test.ts` | 17 | 12 | 0 (0) | 0 | 0 | 5 | 5 | 27 s | 15 s | 12 s |
| `tests/apply-policy.test.ts` | 22 | 1 | 19 (11) | 2 | 0 | 0 | 1 | 13 s | 3 s | 10 s |
| `tests/ledger-run.test.ts` | 10 | 1 | 9 (9) | 0 | 0 | 0 | 0 | 18 s | 8 s | 10 s |
| `tests/ledger-active-store.test.ts` | 12 | 2 | 9 (8) | 0 | 0 | 1 | 1 | 7 s | 2.5 s | 5 s |
| `tests/ledger-clock.test.ts` | 7 | 1 | 6 (5) | 0 | 0 | 0 | 1 | 10.5 s | 7 s | 4 s |
| `tests/ledger-memory-store-fixtures.test.ts` | 5 | 0 | 5 (4) | 0 | 0 | 0 | 1 | 1.3 s | 0.05 s | 1 s |
| `tests/rules-gates.test.ts` | 55 | 0 | 22 (22) | 7 | 26 | 0 | 0 | 1 s | 0.5 s | 1 s |
| `tests/codex-wrappers.test.ts` | 10 | 0 | 0 (0) | 0 | 10 | 0 | 0 | 0.1 s | 0 s | 0 s |
| `tests/ledger-git-sync-order.test.ts` | 3 | 0 | 2 (2) | 1 | 0 | 0 | 0 | 0.03 s | 0.02 s | 0 s |
| `tests/ledger-stored-repo-of.test.ts` | 1 | 0 | 1 (1) | 0 | 0 | 0 | 0 | 0.01 s | 0.01 s | 0 s |
| `mods/ledger/hooks/switch.test.ts` | 111 | 0 | 108 (108) | 3 | 0 | 0 | 0 | 1.1 s | 1.1 s | 0 s |
| `mods/ledger/hooks/claims.test.ts` | 60 | 0 | 59 (59) | 1 | 0 | 0 | 0 | 0.6 s | 0.6 s | 0 s |
| `mods/ledger/hooks/clear-point.test.ts` | 16 | 0 | 16 (16) | 0 | 0 | 0 | 0 | 0.2 s | 0.2 s | 0 s |
| `mods/ledger/hooks/commands.test.ts` | 43 | 0 | 42 (42) | 0 | 1 | 0 | 0 | 0.4 s | 0.4 s | 0 s |
| `mods/ledger/hooks/session-name.test.ts` | 6 | 0 | 6 (6) | 0 | 0 | 0 | 0 | 0.1 s | 0.1 s | 0 s |
| `tests/ledger-core-record.test.ts` | 40 | 0 | 39 (39) | 1 | 0 | 0 | 0 | 0.7 s | 0.7 s | 0 s |
| `tests/ledger-core-format.test.ts` | 30 | 0 | 28 (28) | 2 | 0 | 0 | 0 | 0.3 s | 0.3 s | 0 s |
| `tests/retired-ledger-scripts.test.ts` | 2 | 0 | 2 (2) | 0 | 0 | 0 | 0 | 0.7 s | 0.7 s | 0 s |
| `tests/hook-failure-log.test.ts` | 8 | 6 | 2 (2) | 0 | 0 | 0 | 0 | 4 s | 4 s | 0 s |
| `tests/helpers.test.ts` | 4 | 0 | 4 (4) | 0 | 0 | 0 | 0 | 0.05 s | 0.05 s | 0 s |
| `tests/ledger-help.test.ts` | 2 | 0 | 1 (1) | 0 | 1 | 0 | 0 | 0.02 s | 0.02 s | 0 s |
| `tests/llp-refs.test.ts` | 17 | 0 | 14 (14) | 3 | 0 | 0 | 0 | 0.7 s | 0.7 s | 0 s |
| `tests/usage-pace.test.ts` | 31 | 31 | 0 (0) | 0 | 0 | 0 | 0 | 55 s | 55 s | 0 s |
| `tests/wizard.test.ts` | 18 | 0 | 16 (16) | 2 | 0 | 0 | 0 | 0.5 s | 0.5 s | 0 s |
| `tests/ledger-pr-check.test.ts` | 6 | 0 | 6 (6) | 0 | 0 | 0 | 0 | 0.05 s | 0.05 s | 0 s |
| `tests/ledger-states.test.ts` | 5 | 0 | 5 (5) | 0 | 0 | 0 | 0 | 0.05 s | 0.05 s | 0 s |
| **Total** | **2542** | **430** | **1728 (808)** | **237** | **85** | **62** | **161** | **8910 s** | **3304 s** | **5606 s** |

## 4. Test names per bucket

Each list shows the function or module a test moves to, and the covering test for every merge and delete. "(unsure)" marks a test still to decide.

<details><summary><code>tests/ledger-core-hooks.test.ts</code> — 250 tests</summary>

**keep-e2e** (18)

- a main checkout\'s own ledger is never read back or named on compaction (L147) — real git main-vs-linked detection (`inMainCheckout`); also asserts noTreesText
- session-start from a main checkout lists the tasks of worktrees inside and outside it as open trees, but not its own (L157) — real git: worktree nested inside main vs sibling
- session-start in a linked worktree reports only on its own task and titles the session with the slug (L180) — real linked worktree → own task + title
- session-start counts the linked worktrees of the session\'s repo that still keep their ledger in .claude/ledger.md (L279) — real `git worktree list` for the unmoved hint
- session-start whose git worktree listing does not answer gives no hint and still exits 0 (L309) — hung git killed under spawned bin/ledger (spawnHook)
- session-start runs no git in another repository that tasks name, so one whose git does not answer costs nothing (L422) — hung git in other repo under spawnHook; proves no git call there
- (unsure) session-start finds a parent in another repository from the store alone, with no git call there (L453) — hung git under spawnHook; unsure: a logging git stub in-process (as 491) would prove "no git call" without a hang
- (unsure) session-start checks the PRs of a tree whose root is in another repository, with no git call there (L473) — gh stub + hung git under spawnHook; unsure: same as 453
- session-start reads the other tasks from the store alone: no git call in their folders or in their other repository (L491) — logs real git calls (stub wrapping git) across 2 repos, 8 worktrees
- session-start in a main checkout checks the PR of every waiting task of the repo and says what needs the operator first (L724) — end-to-end PR check: 10 gh child processes + store writes; prOutcome mapping already unit in tests/ledger-pr-check.test.ts
- session-start asks gh about every PR at once, and counts a call not done in 3 s as an error (L798) — concurrent gh calls + hung gh killed (spawnHook, prCheckMs 1.5 s)
- session-start says it could not check a PR when gh is not installed (L996) — real ENOENT spawn of gh with a PATH lacking gh
- a .claude/ledger.md that exists without an active record adds the line naming ledger store migrate --active (L1294) — `holdsUnmovedLedger` needs a real linked worktree (rev-parse) for UNMOVED_REASON
- removing a worktree whose ledger is not archived is denied, naming ledger retire (L2875) — removal gate end to end with real mainCheckout → archive hint path in reason
- removing a worktree whose ledger is still an unmoved .claude/ledger.md is denied, naming migrate --active, until the moved ledger is archived (L3177) — removal gate unmoved path needs real linked worktree (`holdsUnmovedLedger`)
- ledger hook with no installed dependencies runs no npm ci: it prints nothing, says why on one stderr line and exits 0 (L3391) — `bin/ledger` itself without node_modules (spawned)
- ledger statusline with no installed dependencies runs no npm ci: it prints nothing and exits 0 (L3402) — `bin/ledger` itself without node_modules (spawned)
- ledger outside hook mode still runs npm ci when the dependencies are missing, and exits with its code (L3410) — `bin/ledger` itself without node_modules (spawned)

**to-unit** (203)

- session-start accepts a hyphen instead of an em dash in the ledger heading (L194) — `parseLedger` slug (tools/ledger/format.ts) + `sessionTitle` (hooks.ts)
- session-start omits the title when the ledger has no heading (L202) — `sessionTitle`/`parseLedger`; table with heading variants
- session-start outside a git repository shows no ledger, not even a .claude/ledger.md there (L248) — in-process, no repo; `sessionLedgers` outside git returns none
- session-start in a child task shows the path to its parent, and that the parent finalizes after the last child (L326) — to-unit: `sessionReport` (tools/ledger/awareness.ts) on Task fixtures, or in-process sessionStart + memoryStore; git is only setup; may overlap tests/ledger-awareness.test.ts D2…
- session-start in a child task lists its open siblings in order with their status from disk, and skips a retired one and a bullet that names no known task (L344) — to-unit: `sessionReport` (tools/ledger/awareness.ts) on Task fixtures, or in-process sessionStart + memoryStore; git is only setup
- session-start lists a sibling marked started, with or without a note, with its status (L374) — to-unit: `sessionReport` (tools/ledger/awareness.ts) on Task fixtures, or in-process sessionStart + memoryStore; git is only setup (`namedChildren` started note)
- session-start in a main checkout lists a tree once, by its root task, with its open children (L387) — to-unit: `openTreesReport` (tools/ledger/awareness.ts) on Task fixtures; git is only setup
- session-start finds a parent in another repository there, not a local ledger of its slug (L397) — to-unit: `sessionReport` (tools/ledger/awareness.ts) on Task fixtures, or in-process sessionStart + memoryStore; git is only setup (cross-repo parent, `locateChild`)
- session-start names a parent in a repository that is gone (L413) — to-unit: `sessionReport` (tools/ledger/awareness.ts) on Task fixtures, or in-process sessionStart + memoryStore; git is only setup
- session-start lists siblings in another repository with their status there (L541) — to-unit: `sessionReport` (tools/ledger/awareness.ts) on Task fixtures, or in-process sessionStart + memoryStore; git is only setup (siblings in another repo)
- session-start finds a parent in this repository\'s backlog (L560) — to-unit: `sessionReport` (tools/ledger/awareness.ts) on Task fixtures, or in-process sessionStart + memoryStore; git is only setup (backlog parent chain)
- session-start counts a backlog child as open, but not one of another repository with the same folder name (L571) — to-unit: `openTreesReport` (tools/ledger/awareness.ts) on Task fixtures; git is only setup (`listedChildren` repo match)
- session-start reads only the Location parent bullet (L581) — `parseLedger` Location parent bullet (format.ts)
- session-start lists a backlog task as an open tree once, from its ledger and not from the old task list (L597) — to-unit: `openTreesReport` (tools/ledger/awareness.ts) on Task fixtures; git is only setup; old ledgers.json ignored (`parseOldTaskList`, unmoved.ts)
- session-start keeps quotes, backslashes, tabs and non-ASCII text intact (L612) — `parseRecord`/`recordJson` round-trip + `sessionReport`
- pre-compact names the one task by slug and worktree, kept in the store, and writes no task list (L624) — `preCompactText` (hooks.ts); assert no ledgers.json side effect in-process
- pre-compact names several tasks by slug and worktree, most recently updated first, and no ledger path (L637) — `preCompactText` ordering by mtimeMs
- (unsure) session-start in a task checks the waiting tasks of its tree only: its root, every descendant and itself (L775) — tree selection in `waitingPrs` (pr-check.ts, not exported); needs a gh seam in `prViews` (tools/ledger/pr-check.ts); none today — unsure: until then stays as is
- (unsure) session-start adds no Needs you block when no PR needs the operator, and leaves the rest of its text as it was (L816) — `sessionReport` with checked=[] + `prOutcome` pending; needs a gh seam in `prViews` (tools/ledger/pr-check.ts); none today — unsure: until then stays as is
- session-start in a task lists what the PR check found in the report\'s one Needs you section, within 20 lines (L829) — `sessionReport(found, tasks, held, checked)` 20-line cap — pass CheckedLine[] directly
- session-start in a main checkout lists what the PR check found above the open trees, in one Needs you section within 20 lines (L850) — `openTreesReport(tasks, main, checked)` 20-line cap — pass CheckedLine[] directly
- (unsure) session-start never asks gh about a waiting task of another machine, in a main checkout and in a task of its tree (L868) — host filter in `waitingPrs`; needs a gh seam in `prViews` (tools/ledger/pr-check.ts); none today — unsure: until then stays as is
- (unsure) session-start in a task reports from the store after the PR check: a just-merged task is done, and named once (L884) — `afterPrCheck` (hooks.ts) re-read after merge; needs a gh seam in `prViews` (tools/ledger/pr-check.ts); none today — unsure: until then stays as is
- (unsure) session-start in a task whose PR another session marked done meanwhile still asks to finalize it (L901) — race: record changed during gh call; needs a gh seam in `prViews` (tools/ledger/pr-check.ts); none today — unsure: until then stays as is
- session-start in a task names a just-merged task of another repo for finalize by its slug and main checkout (L928) — `outcomeLine`/`finalizeAdvice` (awareness.ts) slug@main; may overlap tests/ledger-awareness.test.ts D26 "a done task in another repo is named for finalize…"
- (unsure) session-start never asks gh about a waiting task whose worktree folder is now a plain folder with no .git (L956) — lost-status (no .git) skipped by `waitingPrs`; unsure: lost detection itself is a git check
- session-start in a task lists what the PR check found before the open questions, so five questions never hide it (L969) — `sessionReport` ordering of checked lines before questions; similar to tests/ledger-awareness.test.ts D26 "a merged PR on record comes before the open questions"
- session-start runs no gh when no task is waiting, in a main checkout and in a task (L983) — `prCheckLines` returns [] with no waiting task (no gh spawned)
- session-start says it could not update a task whose PR is merged when the write fails, and leaves the task as it was (L1009) — `outcomeLine` catch → "could not update" with a store whose write throws
- prompt-submit titles an untitled session in the main checkout with the slug from go (L1046) — `promptSubmit` (tools/ledger/hooks.ts) in-process + memoryStore; git only for `mainCheckout` (one shared repo, as gateWorld)
- prompt-submit replaces the title of another worktree\'s task (L1054) — `promptSubmit` (tools/ledger/hooks.ts) in-process + memoryStore; git only for `mainCheckout` (one shared repo, as gateWorld); table of "title gives way" cases
- prompt-submit keeps a title the operator chose while the session stays on the task it claims (L1082) — `promptSubmit` (tools/ledger/hooks.ts) in-process + memoryStore; git only for `mainCheckout` (one shared repo, as gateWorld) (claim check)
- prompt-submit prints nothing when the title already names the task (L1101) — `promptSubmit` (tools/ledger/hooks.ts) in-process + memoryStore; git only for `mainCheckout` (one shared repo, as gateWorld)
- prompt-submit prints nothing for a slug with no active ledger (L1109) — `promptSubmit` (tools/ledger/hooks.ts) in-process + memoryStore; git only for `mainCheckout` (one shared repo, as gateWorld)
- prompt-submit prints nothing unless the prompt is exactly go and one slug (L1119) — `GO` regex in promptSubmit (hooks.ts); pure
- prompt-submit prints nothing outside a git repository (L1129) — `promptSubmit` (tools/ledger/hooks.ts) in-process + memoryStore; git only for `mainCheckout` (one shared repo, as gateWorld) (no repo)
- ${tool} of .claude/ledger.md in a main checkout is denied, naming ledger show and ledger notes (L1239) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a relative file_path is resolved against the hook cwd (L1248) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- other files in a main checkout are allowed (L1254) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- reading .claude/ledger.md is allowed, in a main checkout and in a linked worktree (L1260) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- .claude/ledger.md outside any git repository is denied too (L1267) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a Bash write to ledger.md after a cd into .claude in the same command is denied (L1273) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a write to .claude/ledger.md through a symbolic link to the file or to its folder is denied (L1280) — git repo is only setup (gate asks git nothing); mkdir suffices; in-process `preToolUse`
- Bash ${JSON.stringify(command)} in a main checkout is denied (L1377) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- Bash write to an absolute ledger path is denied from anywhere (L1386) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a Bash write after cd into a worktree is denied (L1394) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a Bash write to ledger.md from inside .claude/ is denied, as is its absolute path (L1398) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- Bash write through ~ to .claude/ledger.md is denied (L1409) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- Bash ${JSON.stringify(command)} in a main checkout is allowed (L1438) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a write to .claude/ledger.md is denied when git fails, as the gate asks git nothing (L1447) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- ${tool} of a backlog ledger that cites ${citation} is denied (L1486) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- ${tool} of a backlog ledger with ${JSON.stringify(text)} cites nothing, so it gets the store reason (L1492) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- ${tool} of a file that is not a ledger may cite the scratchpad (L1497) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- an Edit whose old text cites the scratchpad and new text does not cites nothing, so it gets the store reason (L1503) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a write to .claude/ledger.md that also cites the scratchpad gets the ledger store reason (L1508) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- Bash ${JSON.stringify(command)} in a linked worktree is denied (L1521) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- Bash ${JSON.stringify(command)} in a linked worktree is allowed (L1532) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a Bash write of a backlog ledger that cites no session file gets the store reason (L1537) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a file tool or Bash write of ~/${file} is denied, naming the ledger commands (L1571) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a store path through ~, $HOME, ${HOME}, quotes, an absolute path or a relative one is denied (L1580) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a file tool's path is literal, not shell text: a quote in it is part of the name (L1588) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- Bash ${JSON.stringify(command)} is denied, naming the ledger commands (L1644) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- Bash ${JSON.stringify(command)} is denied, saying the operator resolves a sync conflict (L1679) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- Bash ${JSON.stringify(command)} is allowed (L1741) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- git check-ref-format and git shortlog only read, so they are allowed in the clone (L1746) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- sqlite3 from ~/.claude reads only its database operand as a path: SQL and option values are not files (L1752) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- writes to an unguarded ~/.claude file and to a worktree\'s .claude/evidence are allowed (L1762) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a write to the store through a symbolic link to a store folder or file, or under a ~/.claude that is a link, is denied (L1772) — already unit (in-process, home + mkdir only)
- a git command run from inside the clone is denied unless it only reads (L1793) — already unit (in-process, home + mkdir only)
- git archive in the clone is allowed unless its -o or --output names a file in the store (L1806) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- git branch in the clone with a list filter such as --points-at only lists, so it is allowed (L1816) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- git branch in the clone with a list filter reads the words after it as patterns, so it only lists (L1826) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- git branch --list in the clone reads the words after -- as patterns, so it only lists (L1836) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- git branch in the clone lists with -i, with -l in a bundle such as -vl, and with nothing after -- (L1846) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- git branch --list in the clone takes the display flags --column, --abbrev, --color and --omit-empty, with or without their no- forms (L1856) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- git fetch in the clone with --dry-run writes nothing, so it is allowed even when it prunes (L1867) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a backtick substitution is one word of the command around it, so the words after it still count (L1959) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a target that starts with a command substitution and ends in .claude/ledger.md is denied (L1965) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- an unquoted here-document body runs its command substitutions; a quoted one is data (L1973) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a brace expansion in a target word is expanded before the word is checked (L1995) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- an option value is not a path: mkdir -m, truncate -s and -r, and touch -d and -t write only their operands (L2006) — already unit (in-process, home + mkdir only)
- a bundle of short options that ends in -r, -d or -t takes the next word as its value, so touch -cr only reads that file (L2019) — git repo is only setup (gate asks git nothing); mkdir suffices; in-process `preToolUse`
- a $(...) in double quotes closes at its matching ), and is one word of the command around it (L2031) — already unit (in-process, home + mkdir only)
- a word that starts with a command substitution names no known path, so it is not a write in the folder the command runs in (L2037) — already unit (in-process, home + mkdir only)
- rm, an mv source and touch of a .claude/ledger.md are denied, as for a store path (L2044) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a cd at the top of a command carries over to later lines and later commands, but not out of a subshell (L2052) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a backslash-newline joins two lines into one command (L2063) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a cd inside a subshell that spans lines counts on its later lines (L2069) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- an arithmetic << is a shift, not a here-document, so the lines after it still count (L2075) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a > or ; inside an arithmetic expansion is an operator, not a redirect or a command end (L2091) — already unit (in-process, home + mkdir only)
- every word after -- is an operand, also one that starts with - (L2098) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- the operands after -- are read as before: a sed script and an option value are no files (L2120) — already unit (in-process, home + mkdir only)
- Bash ${JSON.stringify(command)} only reads the clone, so it is allowed (L2189) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- Bash ${JSON.stringify(command)} changes the clone, so it is denied (L2226) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- BSD sed -i takes a backup suffix that starts with . or is empty as a word of its own, so the script follows it (L2231) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a bare -i after the script, or after -e or -f, takes no backup suffix, so the dot word after it is a file (L2242) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a here-string or here-document before the command word does not hide the command (L2249) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- inside [[ ]] a $( ) in single quotes is literal text, but one in double quotes still runs (L2257) — already unit (in-process, home + mkdir only)
- a cd in a list that & sends to the background leaves the folder of later commands as it was (L2267) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- in a worktree that holds a .claude/ledger.md, a glob that ends in / matches only folders, so it does not reach the ledger (L2282) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a cd that a ; or a newline ends before a later & runs in the foreground, so it still leads later commands (L2292) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a cd .. out of .claude that a ; or a newline ends before a later & leads a later write to a file beside .claude, not to the ledger (L2305) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a line that ends in &&, // or / goes on with the same list, so an & on the next line sends the cd on the first to the background (L2317) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a { ... } group that spans lines and runs in the background or a pipeline leaves the folder of later lines as it was (L2330) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a cd in a pipeline runs in a subshell, so it does not lead later commands (L2345) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- if ... fi, a loop ... done and case ... esac are groups: piped or in the background they run in a subshell, else a cd in them leads later commands (L2362) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a keyword word that is an argument, as in echo then fi, neither opens nor closes a group (L2396) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a } that is an argument, as in { echo }, does not close the group (L2418) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a } right after a ) closes the group, as in { cd ..; (true)} / cat (L2431) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a } right before a redirect closes the group, as in }</dev/null / cat (L2442) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- the ) that closes a process substitution does not close a group, so <(true)} leaves the { open (L2457) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a redirect on the } or fi that closes a group is made where the group started, before its cd (L2470) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a redirect on the } that closes a group ignores the cd inside it, so { cd .claude; }>ledger.md misses the store (L2482) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a piped group that spans lines leaves the folder as it was from its }, so a later command in the pipeline is not led by its cd (L2503) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a group that spans lines and runs in the background does not lead the command right after its &, but leads one after && before the & (L2510) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a group that a pipe on an earlier line leads into runs in a subshell, so its cd does not lead a command after its close (L2518) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- an & after a group that spans lines sends the cd before the group in its and-or list to the background too (L2525) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- an & after groups that span lines sends the cd before them in its and-or list to the background too (L2532) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- an & after a pipe out of a group that spans lines sends the cd before the group in its and-or list to the background too (L2539) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a cd .claude in a group that a pipe on an earlier line leads into does not lead a write after its close into .claude (L2545) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a cd .claude before a group that spans lines, in the and-or list an & sends to the background, does not lead a later write into .claude (L2552) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a cd .claude in a piped group that spans lines does not lead a tee later in the pipeline into .claude (L2559) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a process substitution that spans lines stays one word, so the ) that closes it on a later line closes no group (L2564) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a redirect attached to the fi, done or esac that closes a group is made where the group started (L2570) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- every redirect word on the } that closes a group, a command substitution in it and one after a >(...) too, is made where the group started (L2580) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a quoted ]] inside [[ ]] is pattern text, so the conditional goes on past it (L2590) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- in $'...' a backslash escapes the next character, so an escaped ' does not end the quote (L2598) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- an unescaped $$ is one word, so a ' after it opens a plain quote, not $'...' (L2606) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- in a .claude folder with a ledger, a glob segment followed by another segment matches only folders, so a write through it misses the ledger (L2614) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- an empty word after a bare -i is the BSD backup suffix even after the script, as no file has an empty name (L2624) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a > or < inside [[ ]] compares strings and redirects nothing, but a command substitution in it still runs (L2632) — already unit (in-process, home + mkdir only)
- a cd inside a subshell that spans lines ends at the line that closes it (L2642) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- in a worktree that holds a .claude/ledger.md, a glob that matches it and a removal of a folder above it are denied (L2650) — in-process `preToolUse` (hooks.ts bash parser); git worktree only makes UNMOVED_REASON appear — a plain folder (STORE_REASON) tests the same cd/group logic
- a redirect before the command word does not hide the command (L2665) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- the -P, -L, -e and -@ options of cd come before its folder (L2674) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a file tool path is literal: a * or ? in it is part of the name, not a glob (L2682) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- truncate of a .claude/ledger.md is denied, as touch is (L2689) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- >& before a word that is no file descriptor redirects to that word, as &> and &>> do (L2697) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- >& before a file descriptor or - duplicates or closes it, so it writes no file (L2703) — already unit (in-process, home + mkdir only)
- a bare cd, or cd --, leads to HOME (L2710) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a shell keyword before a command does not hide it (L2720) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- git fetch in the clone is denied when it prunes, forces or names a refspec that writes a ref (L2733) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- the read-only git commands are allowed in the clone, and config and tag only when they read (L2744) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- git --output on log, show or diff is judged by the file it writes, in any repository (L2789) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- git clone into a store path is denied, as is reflog write in the clone (L2809) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- tee options are not files, and sed -i writes only its file operands, not a script or a suffix (L2820) — already unit (in-process, home + mkdir only)
- ln with one operand links its name into the folder it runs in (L2836) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- cd - leaves the folder a write is resolved against as it was (L2844) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- the hooks source writes its private-use mask characters as escapes (L2848) — already unit (reads tools/ledger/hooks.ts source; lint-like)
- each way of naming the worktree in a removal is denied (L2881) — in-process `preToolUse` worktree gate + memoryStore; git only for `archiveHint` mainCheckout (kept by 2875)
- removing a worktree whose ledger is archived is allowed (L2894) — in-process `preToolUse` worktree gate + memoryStore; git only for `archiveHint` mainCheckout (kept by 2875)
- an archive copy of another worktree whose path starts with the same text does not count (L2902) — in-process `preToolUse` worktree gate + memoryStore; git only for `archiveHint` mainCheckout (kept by 2875)
- a removal by the retire commands is allowed (L2909) — in-process `preToolUse` worktree gate + memoryStore; git only for `archiveHint` mainCheckout (kept by 2875)
- a removal named only in quotes, a here-document body or a comment is data, not a removal (L2916) — in-process `preToolUse` worktree gate + memoryStore; git only for `archiveHint` mainCheckout (kept by 2875)
- a removal in a command substitution of an unquoted here-document body is denied; in a quoted one it is data (L2927) — in-process `preToolUse` worktree gate + memoryStore; git only for `archiveHint` mainCheckout (kept by 2875)
- a removal that names the worktree by a glob is denied, as bash expands the glob (L2940) — in-process `preToolUse` worktree gate + memoryStore; git only for `archiveHint` mainCheckout (kept by 2875)
- a glob with a POSIX class, equivalence class or collating symbol in a bracket is denied, as bash expands it (L2948) — in-process `preToolUse` worktree gate + memoryStore; git only for `archiveHint` mainCheckout (kept by 2875)
- a glob with a POSIX class over folders without a ledger is allowed (L2956) — in-process `preToolUse` worktree gate + memoryStore; git only for `archiveHint` mainCheckout (kept by 2875)
- a bracket in a glob matches one character of its class, so a POSIX class that no store file has there misses the store (L2963) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- an escaped dash in a bracket class is a literal dash, not a range (L2972) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a file command asked for its help or version writes nothing (L2977) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a --help or --version after an operand is a file name, as BSD tools stop reading options at the first operand (L2983) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a { that is an argument opens no group, so the & after the group backgrounds the cd before it (L2990) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a --version inside a process substitution is not an option of the tee that reads it (L2995) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a here-document delimiter is read after quote removal, so the body ends at its unquoted line (L2999) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- command -v cd only describes cd, so it changes no folder (L3003) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a redirect between git arguments is no argument, so -h stays the only one (L3007) — already unit (in-process, home + mkdir only)
- git version only reads, so it is allowed in the clone (L3014) — already unit (in-process, home + mkdir only)
- command -v or -V describes the cd it names after a --, more options or a redirect, so it changes no folder (L3021) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a here-document delimiter in $'...' or with an escape inside double quotes ends the body at its unquoted line (L3027) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- time and coproc before a { open a group, so the & or pipe after it runs the cd inside in a subshell (L3033) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a { after the ) of a process substitution is an argument, while one after f() opens a group (L3047) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- an &>, &>> or <& redirect between git arguments is no argument, so -h stays the only one (L3053) — already unit (in-process, home + mkdir only)
- git help only reads, so it is allowed on the clone (L3062) — already unit (in-process, home + mkdir only)
- command -v or -V does not run the command it names (L3068) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a --help or --version before the first operand, after options only, writes nothing; after a -- it is an operand (L3072) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- cp of a store file with a --help after it reads the store and writes a file named --help (L3077) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- the words of a process substitution are not file arguments of the command that reads it (L3081) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a here-document delimiter in $'...' is read with its escapes decoded (L3085) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a cd to a path that is no folder fails and changes no folder (L3089) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a --help or --version that is the value of an option is no info option, so the command still writes (L3093) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a --help or --version after an option and its value, before the first operand, writes nothing (L3099) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- git symbolic-ref with no new value only reads, while setting or deleting one is denied (L3105) — already unit (in-process, home + mkdir only)
- the folder after mv -t is where mv moves to, not a source it removes, while each operand is a source (L3115) — git repo is only setup (gate asks git nothing); mkdir suffices; in-process `preToolUse`
- a { after an argument is an argument too, so the word after it is none of its commands (L3131) — already unit (in-process `preToolUse` on shared gateWorld, no git per call)
- a check that throws does not disable the other: a failed archive read still lets a .claude/ledger.md write be denied (L3135) — already a direct `preToolUse` call; git only via removal() setup
- a glob with a reversed range matches nothing, and the rest of the command is still checked (L3153) — in-process `preToolUse` worktree gate + memoryStore; git only for `archiveHint` mainCheckout (kept by 2875)
- a glob that matches nothing, or only folders without a ledger, is allowed (L3159) — in-process `preToolUse` worktree gate + memoryStore; git only for `archiveHint` mainCheckout (kept by 2875)
- removing a folder without a ledger, or a command that removes nothing, is allowed (L3203) — in-process `preToolUse` worktree gate + memoryStore; git only for `archiveHint` mainCheckout (kept by 2875)
- ${event} with input that is not a JSON object prints nothing, says why on one stderr line and exits 0 (L3223) — already unit (in-process, invalid JSON per event)
- an internal error in a hook injects nothing (L3229) — already unit (in-process; NUL cwd fails git spawn immediately)
- a failing ledger hook appends one line to ~/.claude/ledger-hook-failures.log, creating ~/.claude (L3252) — already unit (in-process, no repo; `unreportedHookFailures`/`logHookFailure`)
- a failing ledger hook that cannot write its log still prints nothing and exits 0 (L3266) — already unit (in-process, no repo; `unreportedHookFailures`/`logHookFailure`)
- session-start reports the unreported hook failures above the ledger, once (L3274) — git only for linked worktree; `sessionStart` failure prefix; may overlap tests/ledger-awareness.test.ts D26 "hook failures still come first"
- session-start with no ledger reports the hook failures alone, then prints nothing (L3289) — already unit (in-process, no repo; `unreportedHookFailures`/`logHookFailure`)
- session-start reports a crash of an earlier ledger hook (L3298) — already unit (in-process, no repo; `unreportedHookFailures`/`logHookFailure`)
- session-start whose ledger part throws still reports the earlier failures alone, and logs its own for the next report (L3306) — in-process; git checkout only setup (main → no tree text needed)
- session-start whose ledger part throws with no unreported failures fails open as before (L3320) — already unit (in-process, no repo; `unreportedHookFailures`/`logHookFailure`)
- session-start reports the whole log again when it is shorter than the part already reported (L3328) — already unit (in-process, no repo; `unreportedHookFailures`/`logHookFailure`)
- session-start that cannot record what it reported still reports and exits 0 (L3338) — already unit (in-process, no repo; `unreportedHookFailures`/`logHookFailure`)
- session-start that cannot read the log prints what it prints with no failures (L3348) — already unit (in-process, no repo; `unreportedHookFailures`/`logHookFailure`)
- a path the gates cannot check counts as no ledger on disk, and the rest of the command is still checked (L3356) — in-process `preToolUse` worktree gate + memoryStore; git only for `archiveHint` mainCheckout (kept by 2875)
- a folder the gate may not read counts as no ledger, and the rest of the command is still checked (L3367) — in-process `preToolUse` worktree gate + memoryStore; git only for `archiveHint` mainCheckout (kept by 2875)

**merge** (26)

- session-start from a subdirectory of a main checkout ignores a ledger file in that subdirectory (L167) — into tests/ledger-core-hooks.test.ts "session-start from a main checkout lists the tasks of worktrees inside and outside it…" (add subdir cwd)
- session-start omits the title when the heading has an empty slug or one that is no slug (L213) — into tests/ledger-core-hooks.test.ts "session-start omits the title when the ledger has no heading" (table of headings)
- session-start in a main checkout lists several worktree tasks as open trees without a title (L225) — into tests/ledger-core-hooks.test.ts "session-start from a main checkout lists the tasks of worktrees inside and outside it…" (add no-title assert)
- session-start in a main checkout with one worktree task lists it without a title (L237) — into same 157 test (one-task case)
- session-start gives no hint when no linked worktree of the repo keeps a .claude/ledger.md without a record (L295) — into tests/ledger-core-hooks.test.ts "session-start counts the linked worktrees … still keep their ledger in .claude/ledger.md" (negative cases)
- session-start in a child task whose parent has no ledger still names the parent, with CRLF line ends (L336) — into tests/ledger-awareness.test.ts "D26: a parent with no ledger is still on the path, with no Siblings or Then line" (add CRLF case)
- session-start lists a sibling marked retired as open while its ledger is live, as finalize counts it (L360) — into tests/ledger-awareness.test.ts "D26: a sibling marked retired under Children whose ledger is still live counts as open, as finalize counts it"
- session-start runs no git in another repository, also when tasks name its worktrees (L437) — into tests/ledger-core-hooks.test.ts "session-start runs no git in another repository that tasks name…" (add worktree-path children)
- session-start in a main checkout lists a just-merged task as done in its tree, not as waiting (L917) — into tests/ledger-core-hooks.test.ts "session-start in a task reports from the store after the PR check: a just-merged task is done, and named once" (main-checkout variant)
- session-start in a task names a ready PR of another repo for the merge gate by its slug and main checkout (L942) — into tests/ledger-core-hooks.test.ts "session-start in a task names a just-merged task of another repo for finalize…" (table: merged/ready → gate command)
- prompt-submit replaces a title that names an archived task (L1064) — into tests/ledger-core-hooks.test.ts "prompt-submit replaces the title of another worktree's task" (table: archived / other repo / previous task / backlog title)
- prompt-submit replaces a title that names an archived task of another repository (L1073) — into tests/ledger-core-hooks.test.ts "prompt-submit replaces the title of another worktree's task" (table: archived / other repo / previous task / backlog title)
- prompt-submit keeps a title the operator chose when the session claims the task among other claims (L1091) — into tests/ledger-core-hooks.test.ts "prompt-submit keeps a title the operator chose while the session stays on the task it claims"
- D43: prompt-submit after a clear replaces the slug of the previous task, from the main checkout and from the new worktree (L1149) — into tests/ledger-core-hooks.test.ts "prompt-submit replaces the title of another worktree's task" (table: archived / other repo / previous task / backlog title)
- D43: prompt-submit replaces the slug of a previous task in another repository (L1160) — into tests/ledger-core-hooks.test.ts "prompt-submit replaces the title of another worktree's task" (table: archived / other repo / previous task / backlog title)
- D43: prompt-submit replaces the slug of a previous task that is in the backlog (L1170) — into tests/ledger-core-hooks.test.ts "prompt-submit replaces the title of another worktree's task" (table: archived / other repo / previous task / backlog title)
- D43: session-start after a clear titles the session with the slug of the worktree it is in (L1179) — into tests/ledger-core-hooks.test.ts "session-start in a linked worktree reports only on its own task and titles the session with the slug" (source: clear)
- ${tool} of .claude/ledger.md in a linked worktree is denied, naming ledger show and ledger notes (L1243) — into the sibling "…in a main checkout…" loop test at line 1239 (ledger gate asks git nothing; one table over both folders)
- a .claude/ledger.md that migrate --active would not move gets no migrate line (L1316) — into tests/ledger-core-hooks.test.ts "a .claude/ledger.md that exists without an active record adds the line naming ledger store migrate --active" (negative folders)
- Bash ${JSON.stringify(command)} in a linked worktree is denied (L1381) — into the sibling "…in a main checkout…" loop test at line 1377 (ledger gate asks git nothing; one table over both folders)
- Bash ${JSON.stringify(command)} in a linked worktree is allowed (L1442) — into the sibling "…in a main checkout…" loop test at line 1438 (ledger gate asks git nothing; one table over both folders)
- Bash ${JSON.stringify(command)} is denied, naming the ledger commands (L1902) — into tests/ledger-core-hooks.test.ts loop "Bash … is denied, naming the ledger commands" (bashStoreWrites, line 1644): concat tables
- Bash ${JSON.stringify(command)} is allowed (L1939) — into tests/ledger-core-hooks.test.ts loop "Bash … is allowed" (bashStoreReads, line 1741): concat tables
- Bash ${JSON.stringify(command)} is denied, saying the operator resolves a sync conflict (L1954) — into tests/ledger-core-hooks.test.ts loop "Bash … is denied, saying the operator resolves a sync conflict" (line 1679): concat tables
- a removal that names the deleted cc-worktree-retire script is denied (L2934) — into tests/ledger-core-hooks.test.ts "a removal by the retire commands is allowed" (negative case: deleted script name does not exempt)
- removing a worktree whose ledger is still an unmoved .claude/ledger.md is denied even with an archive copy naming it (L3192) — into tests/ledger-core-hooks.test.ts "removing a worktree whose ledger is still an unmoved .claude/ledger.md is denied, naming migrate --active…"

**delete** (3)

- session-start says to read the task with ledger show and write it with ledger notes, and names no .claude/ledger.md (L257) — covered by tests/ledger-core-hooks.test.ts "session-start in a linked worktree reports only on its own task…" (exact soloReport includes the Details line, no .claude/ledger.md)
- session-start with no ledger in the repo still asks: a new task or quick work (L589) — covered by tests/ledger-core-hooks.test.ts "a main checkout's own ledger is never read back or named on compaction" (asserts noTreesText exactly); also tests/ledger-awareness.test.ts D27 "a main checkout with no open tree still asks"
- (unsure) prompt-submit skips a worktree whose folder is gone (L1138) — covered by tests/ledger-core-hooks.test.ts "prompt-submit titles an untitled session in the main checkout with the slug from go" (promptSubmit reads records only, never the worktree folders); unsure: legacy of a git-listing version

</details>

<details><summary><code>tests/ledger-git-store.test.ts</code> — 136 tests</summary>

**keep-e2e** (100)

- L134 sync init on a private, empty repository clones it, writes the marker and layout, pushes them, and leaves the storage setting alone — init flow against a real remote; base test for init
- (unsure) L159 sync init refuses a public repository: exit 1, no clone, nothing pushed — gh stub process + no clone/push; unsure: could skip remote() — initSync refuses before git
- L172 sync init exits 1 with the reason when gh fails, and when gh is not installed — gh stub fail / gh missing on PATH (real process lookup)
- L199 sync init refuses a repository with commits but no .ledger-data marker: exit 1, the clone is removed, the remote is unchanged — remote with foreign commits; clone removed
- L234 sync init on a second machine accepts a repository with the marker and installs the pre-push hook — second machine init + hook install
- L249 sync init again on the same clone changes nothing; another URL or a folder that is no clone is refused — init idempotence, other URL, non-clone folder
- L270 sync init refuses a repository with a symbolic link, an executable file or a path outside the allowlist, before any of it is checked out — incoming unsafe tree before checkout (loop ×3 remotes, ×2 machines each — costly; one remote with 3 branches would do)
- L325 task, park, parent add and retire under git storage each commit in the clone, and ledger store sync pushes them — each command commits; sync pushes (also covers repo-key folder on remote)
- L357 a retire under git storage that cannot delete the backlog ledger keeps its archive copy, says so, and a retry finishes — retire failure under git storage (chmod in clone); real commit
- L378 a second machine sees the ledgers after ledger store sync, and again after its session-start hook pulls — core two-machine sync + session-start pull
- L397 without the test switch a command returns first, prints only its own output, and pushes in the background — needs bin/ledger spawn + detached background push
- L420 only allowlisted paths reach the remote: no evidence, lock or temporary file — allowlist end to end (evidence, lock, tmp never pushed)
- L445 a file a nested .gitignore un-ignores is refused: the sync exits 1, names it, and pushes nothing — git nested .gitignore behaviour
- L462 a non-allowlisted file committed or staged in the clone blocks the push and is named — staged and committed non-allowlisted file block push
- L482 a token in a backlog ledger blocks the push: file:line is named, the token is not printed, the commit stays local — base secret test: file:line, not printed, commit local, status=secret
- L501 ledger store sync and the pre-push hook of a manual git push find the same secrets, in binary text and file names too — sync/pre-push-hook parity over SAMPLES/NEAR_MISSES (bash hook needs real git push)
- L530 a token added in a merge resolution is caught by ledger store sync and by the pre-push hook — merge-resolution diff (git --diff-merges)
- (unsure) L560 ledger store sync and the pre-push hook read a record as its text: a key after an escaped line break, tab or control character is found — hook parity for record text decoding; unsure: sync half could be unit on `secretLocations`
- L606 ledger store sync and the pre-push hook read a record whose path holds a space or a double quote as a record, and name it as git shows it — git path quoting (space, double quote)
- L639 the pre-push hook fails closed: when its scan cannot run, the push is blocked — bash hook fails closed with stripped PATH
- L664 when two machines change the same ledger, the second sync exits 1, names the file, keeps its commit, and the next session start says so — two-machine conflict
- L695 a pull whose rebase fails without a conflict exits 1, pushes nothing and tells an agent to ask the operator — rebase refused by hook, two machines
- L725 offline, commands still work locally, a quiet sync prints nothing and records it, and the next good sync clears it — offline (moved remote), status recorded/cleared
- L763 migrate file → git → file moves the ledgers and evidence both ways; --from defaults to the setting — migrate file↔git round trip, pushed
- L802 migrate --to git reports a failed push but still switches, as the copies are in the clone — migrate with failing push still switches
- L825 migrate --records --dry-run in git storage changes nothing: the changed hook stays, nothing is committed, no push starts — dry run leaves hook/commits/push untouched
- L899 a pull refuses an incoming ${file}: ledger store sync and the session start leave the clone as it was, and the problem is recorded — pull refuses incoming bad entry (loop ×3)
- L961 ledger store sync pushes to the URL it checked: a pushurl on origin is not used — git pushurl ignored
- L975 ledger store sync refuses when git config would send the push of the checked URL somewhere else — git pushInsteadOf detected
- L992 ledger store sync asks gh whether the repository is still private each time, a background sync at most once a day, and a public one gets nothing — gh privacy check cadence (gh stub + git config checkedPrivate)
- L1061 a path with a secret-like name is withheld in the output, the status file and the session context — withheld name in output, status file and session context
- L1079 ledger store sync and the pre-push hook scan from the remote branch, so a commit another remote-tracking ref holds is scanned too — scan range from remote branch, hook + sync
- L1095 a secret in a commit message blocks ledger store sync and the pre-push hook, which name the commit and not the secret — secret in commit message, hook + sync
- L1119 sync init counts a repository with only a branch other than the default as not empty, and refuses it — remote with only another branch
- L1135 two sync inits at once: the second refuses at once and asks gh nothing, and the clone of the first stays — two concurrent init processes
- L1157 a stash that left a conflict stops the commit of every command and of ledger store sync, and is recorded — stash conflict state in git
- L1185 during a rebase a person has not finished, ledger store sync refuses, pushes nothing and leaves the rebase as it is — real stopped rebase by a person
- L1238 a background sync that starts while another runs exits at once, and the running one pushes the newer commit too — two sync processes, held pre-receive
- L1273 the session-start pull stops within its time limit and leaves no half rebase — hung post-rewrite hook, time limit
- L1307 a ledger command that runs while a sync pushes is not held up, and the next sync pushes it — command during a held push (processes)
- L1329 when the remote moves between the fetch and the push, ledger store sync pulls again and pushes — remote moves between fetch and push
- L1356 migrate --to git --remove-source stops before it removes or switches anything when git storage cannot commit — migrate stops when git storage cannot commit
- L1409 a .gitignore from the remote that ignores ledgers keeps none out of the commit or the push — remote .gitignore ignoring ledgers
- L1425 migrate --to git --remove-source commits every copy before it removes anything, also one an exclude file ignores — commit-before-remove order with post-commit hook
- L1448 ledger store sync pushes against the commit it fetched, even when the remote-tracking branch moves while it rebases — remote-tracking ref moved during rebase
- L1471 a pull refuses incoming history that held a path ledger never checks out, also when a later commit removed it — incoming history path check
- L1498 sync init refuses a repository whose history held a symbolic link, though its last commit holds none — init refuses symlink in history
- L1519 no environment variable lets a URL rewrite send the checked URL to a local repository — bin/ledger env LEDGER_TEST_REMOTE not honoured (spawn)
- L1534 a manual git push in the clone runs the pre-push hook of ledger, also when the global git config sets core.hooksPath — global core.hooksPath vs own hook
- L1554 a secret in a root commit is found by ledger store sync and the pre-push hook, also when git config hides root commits from git log — root commit with log.showRoot=false
- L1582 no tag is pushed: ledger store sync leaves tags out under push.followTags, and the pre-push hook blocks a push of one — tags under push.followTags, hook blocks tag
- L1631 git error text is printed and recorded without secret-like words or credentials — redaction of git stderr (integration for redaction)
- L1666 when the session-start pull cannot undo a rebase that stopped, it records that the rebase got partway, without saying to run git rebase --abort — session-start pull cannot abort rebase
- L1752 a left-over lock is taken over by one process at a time: of four processes that find it at once, none holds it with another or loses it while it works — 4 contending processes on a leftover lock (LOCK_CONTENDER duplicates `contendFor` harness)
- L1797 a background sync whose sync fails syncs once more for a command that left a note meanwhile — background sync retry after a refused push
- L1819 sync init reaches the URL as git config outside any repository sends it: a repository at ~/.claude does not rewrite it — git config outside repo (insteadOf at ~/.claude)
- L1843 migrate --to git --remove-source keeps the source when git storage commits other text than the source it read — migrate keeps source when committed text differs
- L1867 ledger store sync and the pre-push hook scan the commits git pushes, also when ${hide} hides one — replace object / graft (loop ×2)
- L1896 ledger store sync and the pre-push hook of a manual git push both refuse a path outside the allowlist, a backslash, a symbolic link and an executable file — sync + hook refuse 4 kinds (loop makes 4 remotes+machines; one machine with reset between cases would do)
- L1924 ledger store sync and the pre-push hook name the exact line of a secret, also when git config merges nearby hunks — diff.interHunkContext exact line
- L1952 ledger store sync and the session start fetch and move the remote-tracking branch only while they hold the clone lock — ref updates only under clone lock (reference-transaction hook)
- L1989 gh error text is printed and recorded without secret-like words — gh stderr redaction in sync and init
- L2005 the whole session start in a linked worktree stays within its 5 s, when the pull uses its share and git then hangs in the main checkout — session-start 5 s budget, hung git in main checkout
- L2041 a waiting task whose PR gh says is merged after the session start used up its git time is still marked done and committed — PR merged after git time used up
- L2076 git in the clone ignores GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and GIT_CONFIG_* of the environment ledger runs in — GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* ignored by real git
- L2099 sync init asks gh for the visibility and whether the repository is empty, and refuses when gh and git disagree on empty — gh/git disagree on empty
- L2112 a ledger the clone's index marks ${flag.slice(2)} is not committed: the command warns and records it — assume-unchanged / skip-worktree index flags (loop ×2)
- L2127 migrate git → sqlite --remove-source moves the ledgers, removes them from git storage and pushes that — migrate git → sqlite with push
- L2215 a left-over lock behind a left-over reclaim guard is taken over by one process at a time: of eight that find both at once, none holds the lock with another — 8 contending processes (lock + guard)
- L2269 ledger store sync refuses to rebase a merge commit made in the clone, which a rebase would drop: exit 1, the merge stays, nothing is pushed — merge commit not rebased
- L2314 ${when} puts back a pre-push hook that was changed, and the core.hooksPath that names it — hook/core.hooksPath repair by command and by pull (loop ×2; absorbs 878)
- L2328 a path whose name holds a line break is outside the allowlist of ledger store sync and of the pre-push hook — line-break path, sync + hook
- L2350 a refused remote URL is printed and recorded without secret-like words: ${where} — refused remote URL redacted (loop ×2)
- L2364 ledger store sync and the session start write the privacy check and the hook setting only while they hold the clone lock — config writes only under clone lock (git stub)
- L2401 after a push, ledger store sync never moves the remote-tracking branch back from a newer commit a fetch found meanwhile — post-receive fetch race
- L2421 a command that commits nothing still starts the push while the clone has commits the remote lacks — background push from a read-only command (spawn)
- L2433 a command starts the push when git cannot count the commits the remote lacks — push when rev-list --count fails (spawn + git stub)
- L2449 ledger store sync and sync init stop waiting for a gh that does not answer, exit 1 and say so, and push nothing — gh that hangs (timeout)
- L2510 sync init never prints a secret-like part of a URL, of the repository gh checks, of its answer or of an existing clone — init redaction across 5 sources (gh answer, existing clone)
- L2534 the whole session start stays within its 5 s when git hangs while git storage ${slow} — session-start budget when git hangs on open/close (loop ×2)
- L2556 a command starts the push while origin lacks a commit on the branch the clone pushes to, also when another branch of origin has it — origin lacks commit on pushed branch
- L2569 sync init stops before it writes the pre-push hook through a hooks folder that a git template made a symbolic link — git template hooks symlink
- L2586 when gh says the repository is no longer private but the clone lock is busy, no later sync trusts the earlier check — not-private sticky while lock busy
- L2605 a fetch never moves the remote-tracking branch back after the remote lost commits: ledger store sync and the session start refuse and say why — remote lost commits: sync + session start
- L2632 a remote that lost commits is refused by their ancestry, not by what git says: ${what} — ancestry not git text (loop ×2)
- L2659 after the remote lost commits, git fetch --force origin in the clone and then ledger store sync push the commits made here again — fetch --force then sync pushes back
- (unsure) L2678 when gh says the repository is no longer private but git cannot change the clone config, no later sync trusts the earlier check — not-private sticky when config can't change; unsure: largely overlaps "after gh says the repository is not private, no sync trusts…" (2778)
- L2697 the pre-push hook names a path with a line break and a path with a ? in its place as two paths — hook path naming (absorbs 2483)
- L2756 the pre-push hook withholds a path whose secret-like part follows a line break, and never prints the secret${what} — hook withholds secret after line break (loop ×2)
- L2778 after gh says the repository is not private, no sync trusts the earlier check, also when git cannot forget it and a later problem of another kind replaces the recorded one, until gh says PRIVATE again — not-private sticky across problems
- L2815 when gh says the repository is not private and neither the marker nor the clone config can be written, no later sync trusts the earlier check — marker + config both unwritable
- L2845 a sync that cannot write the not-private marker stops before it asks gh, so no answer that the repository is not private goes unrecorded — marker unwritable stops before gh
- L2861 a PRIVATE answer to a check that started before another check found the repository not private leaves the marker of that later check — two overlapping privacy checks (processes)
- L2888 a background sync that still runs when its test ends, after the wait for it ran out, is stopped before the test removes HOME — background sync killed at test teardown
- L2910 after the remote lost commits on purpose, the refusal says how to accept that, and doing so pushes none of the lost commits back — lost commits on purpose: advice + accept
- L2934 when git cannot check whether the remote lost commits, ledger store sync says so and does not report lost commits — merge-base failure (git stub)
- L2957 a branch other than the one the clone pushes to, which the remote moved back, does not stop ledger store sync — other branch moved back
- L2978 when the remote lacks the branch the clone pushes to and another branch lost commits, ledger store sync says the branch is missing, and its advice pushes the branch again — missing pushed branch + advice
- L3072 ledger store migrate --repo-ids with git storage moves clone ledgers and their evidence to the repo key, commits and pushes the move, and keeps the alias out of the clone — migrate --repo-ids commits and pushes the move
- L3097 migrate file → git copies the repo aliases into git storage, and a git storage alias that cannot be read stops it with nothing changed — migrate aliases into git storage, none pushed

**to-unit** (23)

- L151 sync init accepts the ssh form of a GitHub URL — `githubRepo` in tools/ledger/sync.ts (ssh form → github.com/me/ledgers); push path covered by 134
- L293 sync never prints the user name or password of a URL, also when it fails — `withoutCredentials`/`redacted` in tools/ledger/clone.ts + `githubRepo`; sync-failure redaction integration covered by "git error text is printed and recorded without secret-lik…
- L315 ledger commands under git storage need a set-up clone and say to run ledger store sync init; a hook still exits 0 — in-process: runInProcessWith with HOME holding storage=git and no clone; no remote/machine needed
- (unsure) L816 migrate refuses --from equal to --to, and --to git while the setting already is git without --from — in-process: runInProcessWith (argument/setting validation of `store migrate`); unsure: the `--dry-run` line may open the git store
- L849 migrate --to git without a set-up clone says to run ledger store sync init and changes nothing — in-process: runInProcessWith, HOME without clone; no remote needed
- L929 sync init accepts only a plain github.com URL: no query, fragment, port, path past the repository or other user — `githubRepo` in tools/ledger/sync.ts as a table (+ the 190 row); no gh/clone follows from undefined
- L1020 git storage refuses to write through a repo folder that is a symbolic link, in backlog/ and in archive/ — gitStore write refusal on a symlinked repo folder; git only as setup (local `git init` clone, no remote)
- L1210 the clone lock of a process that still runs is kept, also after a minute — `withLock` in tools/ledger/lock.ts (live pid, 2-min-old lock kept, wait runs out naming the lock); no machine needed
- L1224 a background sync that gives up waiting for the clone lock prints nothing and records why — `syncLedgers(paths, line, {quiet:true})` in tools/ledger/sync.ts with a held clone lock; git only as setup
- L1260 a sync that started earlier neither clears nor replaces the problem a later sync recorded — already unit (`recordProblem`/`clearStatus`); could join the table in ledger-git-sync-order.test.ts
- L1373 a ledger or repo named . or .. is outside the allowlist: a staged archive/app/...md stops the sync — `isAllowed` in tools/ledger/clone.ts ('archive/app/...md', 'backlog/app/..md' → false); push blocking covered by "a non-allowlisted file committed or staged…"
- (unsure) L1391 migrate --remove-source removes no more than one copy and its evidence: a file named ...md in the archive is no ledger — migrate source enumeration (tools/ledger/migrate.ts) in-process; unsure: git target only as setup
- (unsure) L1647 migrate withholds a secret-like name when it names a name the target already has — migrate conflict message withholds name (`shownPaths` in clone.ts); in-process migrate; unsure: target needs the existing name
- L2152 git in the clone ignores GIT_ALTERNATE_OBJECT_DIRECTORIES of the environment ledger runs in — already unit (`cloneEnv`)
- L2165 a reclaim guard older than its time limit is taken over, also while a process with its pid runs, so a left-over lock behind it is reclaimed — already unit (`withLock` reclaim guard)
- L2178 a lock wait that runs out names the lock and its reclaim guard — already unit (`withLock` wait message)
- L2231 a clone whose .git is a symbolic link is no git storage: a command exits 1 and says why — `cloneProblem` in tools/ledger/clone.ts (.git is a symlink); a local clone folder suffices
- L2243 a clone whose git names another top folder is no git storage: a command exits 1 and says why — `cloneProblem` (core.worktree elsewhere); local `git init` only, no remote
- (unsure) L2256 a clone whose .git/hooks is a symbolic link is no git storage: ledger store sync exits 1 and writes no hook through it — `cloneProblem`/`installHook` (hooks symlink); local `git init` only; unsure: the check sits on the sync path
- L2714 a reclaim that stalls past its guard's time limit, while another process takes the lock, does not delete that lock — already unit (`withLock` with mocked fs)
- L2741 the test helper remoteFiles throws when the remote cannot be read, rather than report no files — already unit (tests the `remoteFiles` fixture)
- L3009 git storage keeps repo aliases in ~/.claude/ledger-aliases-git.json, apart from those of file storage, and pushes none — `gitStore(...).aliases` file logic; git only as setup; "pushes none" covered by "migrate file → git copies the repo aliases…"
- L3058 git storage lists evidence in ~/.claude/ledger-evidence that has no archive copy as orphan evidence — `gitStore(...).archive.orphanEvidence()`; already calls the store directly, git only as setup

**merge** (9)

- L190 sync init refuses a URL whose host is not github.com, as it cannot check that it is private — into tests/ledger-git-store.test.ts "sync init accepts only a plain github.com URL…" (as a `githubRepo` table row)
- L219 sync init refuses a marker with an unknown format and removes its clone — into tests/ledger-git-store.test.ts "sync init refuses a repository with commits but no .ledger-data marker…" (table: no marker / unknown format)
- (unsure) L789 migrate sqlite → git copies into the clone — into tests/ledger-git-store.test.ts "migrate file → git → file moves the ledgers…" (table over source storage); unsure: sqlite source read may be covered by sqlite migrate tests
- L878 ledger store sync puts back a pre-push hook that was changed, and replaces a core.hooksPath an older setup left — into tests/ledger-git-store.test.ts "${when} puts back a pre-push hook that was changed…" (add `ledger store sync` as a third `when`)
- L1045 a staged path whose name ends in a line break is checked as it is, and refused — into tests/ledger-git-store.test.ts "a path whose name holds a line break is outside the allowlist…" (table: staged / committed)
- L1603 a symbolic link or an executable file at a ledger path is never committed or pushed — into tests/ledger-git-store.test.ts "ledger store sync and the pre-push hook of a manual git push both refuse a path outside the allowlist, a backslash…" (add uncommitted-symlink case)
- L2471 sync init of a repository with the marker makes the backlog and archive folders, which git does not keep while empty — into tests/ledger-git-store.test.ts "sync init on a second machine accepts a repository with the marker…" (add backlog/archive folder asserts)
- L2483 a manual git push of a path whose whole name is a line break is blocked by the pre-push hook — into tests/ledger-git-store.test.ts "the pre-push hook names a path with a line break and a path with a ? …" (add the bare "\n" path)
- L2499 sync init again on a set-up clone makes no backlog or archive folder — into tests/ledger-git-store.test.ts "sync init again on the same clone changes nothing…" (remove folders first, assert none made)

**wording** (1)

- L859 ledger store --help lists sync, sync and migrate have their own help, and the old names fail — help text; structural: assert `sync`/`migrate` subcommands named and old top-level `sync` gives unknown command — in-process, no machine()

**delete** (3)

- L1790 a sync that started earlier does not record its problem over the success of a sync that started later — covered by tests/ledger-git-sync-order.test.ts "two syncs that start in the same millisecond…: the problem of the earlier one does not replace the success of the later one" (same assertion, plus same-ms)
- L3031 git storage files a task under its repo key, URI-encoded as one folder, and pushes it there — covered by tests/ledger-git-store.test.ts "task, park, parent add and retire under git storage each commit…" (asserts backlog/${APP}/fix-login.json on the remote)
- L3042 git storage refuses to write through the folder of a repo key that is a symbolic link — covered by tests/ledger-git-store.test.ts "git storage refuses to write through a repo folder that is a symbolic link, in backlog/ and in archive/"

</details>

<details><summary><code>tests/ledger-git-sync-lock.test.ts</code> — 8 tests</summary>

**keep-e2e** (7)

- L87 ledger store sync removes a .git/index.lock left 10 minutes ago, says so once, then commits and pushes — stale .git/index.lock removed by sync, then commit+push (real git lock, lsof); spawns via run() — runHere would save ~1 s/command
- L100 a ledger write removes a .git/index.lock left 10 minutes ago and commits — stale lock removed by a write (different path from sync)
- (unsure) L129 ledger store sync keeps a fresh .git/index.lock, says how old it is and to wait, and commits nothing — fresh lock kept + age/wait advice; unsure: could be unit on `clearStaleGitLocks` in tools/ledger/clone.ts with a local `git init`, no remote
- L142 ledger store sync keeps an old .git/index.lock that a running program holds open — lock held open by a running process (lsof)
- L156 ledger store sync keeps an old .git/index.lock while a git runs in the clone — git running in the clone (process detection)
- (unsure) L173 ledger store sync keeps an old .git/index.lock when it cannot check for a running git, and says it may be removed by hand — lsof failing stub; unsure: same as 129 (unit on `clearStaleGitLocks` + stub lsof)
- L187 a sync and a ledger write with no git lock file in the clone never run lsof — lsof never run without a lock file (stub process)

**merge** (1)

- L114 ledger store sync removes a lock of the branch ref left 10 minutes ago, then commits and pushes — into tests/ledger-git-sync-lock.test.ts "ledger store sync removes a .git/index.lock left 10 minutes ago…" (table: index.lock / branch-ref lock; same `clearStaleGitLocks` path)

</details>

<details><summary><code>tests/ledger-git-sync-order.test.ts</code> — 3 tests</summary>

**to-unit** (2)

- L7 two syncs that start in the same millisecond still have an order: the problem of the earlier one does not replace the success of the later one — already unit (`takeSyncNumber`/`recordProblem`/`clearStatus` in tools/ledger/clone.ts)
- L21 two syncs that start in the same millisecond still have an order: the problem of the later one replaces the success of the earlier one — already unit

**merge** (1)

- L34 the problem of a sync replaces the success of one that started before it — into tests/ledger-git-sync-order.test.ts "two syncs that start in the same millisecond still have an order: the problem of the later one replaces the success of the earlier one" (identical steps without the Date.now mock; make a table over same-ms / not)

</details>

<details><summary><code>tests/ledger-git-sync-rebase.test.ts</code> — 15 tests</summary>

**keep-e2e** (14)

- L99 ledger store sync clears a leftover rebase with ${what} when nothing is unpushed, and pulls — leftover rebase cleared by sync (loop ×5 shapes); each instance builds 2 machines via spawn (behindOrigin ≈ 19 s)
- L126 ledger store sync clears a leftover rebase with ${what} while a ledger commit is not pushed, then pushes the commit — leftover cleared while a commit is unpushed (loop ×2)
- (unsure) L148 ledger store sync keeps a leftover rebase that started from another commit than the branch tip, without saying to continue it — refused: orig-head moved; unsure: decision could be unit on `clearLeftoverRebase` in tools/ledger/clone.ts on one local repo, no second machine
- (unsure) L158 ledger store sync keeps a leftover rebase of another branch than the one checked out, without saying to continue it — refused: other branch; unsure: as 148
- L165 ledger store sync keeps what git am left in .git/rebase-apply, and asks the operator without a git error — refused: rebase-apply left by git am
- L176 ledger store sync keeps a rebase that got partway, with HEAD detached, and names the branch — refused: partway, detached HEAD (real cherry-pick)
- (unsure) L190 ledger store sync keeps a leftover rebase that stopped at a commit — refused: stopped-sha; unsure: as 148
- (unsure) L197 ledger store sync keeps a leftover rebase that rebased a commit, with HEAD on the branch — refused: done file, HEAD on branch; unsure: as 148
- L208 ledger store sync keeps a leftover rebase with a conflict in the index, without saying to continue it — refused: conflict in the index (update-index)
- L226 ledger store sync clears a leftover rebase while a ledger has uncommitted changes, then commits and pushes them — cleared with uncommitted changes, then commit+push
- L256 ledger store sync fast-forwards when nothing is unpushed, without starting a rebase — sync fast-forwards without rebase
- L267 the session-start pull fast-forwards when nothing is unpushed, without starting a rebase — session-start pull fast-forwards (separate `pullForSession` path)
- L277 the pre-rebase hook of the clone runs when ledger store sync rebases a commit not pushed yet — guard: pre-rebase hook does run when rebasing (keeps 256/267 meaningful)
- L290 ledger store sync rebases with the merge backend when the clone sets rebase.backend to apply — rebase.backend=apply overridden to merge backend

**merge** (1)

- L109 the session-start pull clears a leftover rebase with ${what} when nothing is unpushed, and pulls — into tests/ledger-git-sync-rebase.test.ts loop "ledger store sync clears a leftover rebase with ${what}…" — run the session-start pull for one shape, not 5; same `clearLeftoverRebase` decides both

</details>

<details><summary><code>tests/ledger-other-machines.test.ts</code> — 60 tests</summary>

**keep-e2e** (30)

- L216 a started task is committed as its active record, and another machine lists it as on host-a — record committed, pushed, listed on B as host-a (core two-machine path)
- L270 ledger task retire removes the record in the commit that archives the task, and the other machine then lists it as retired — archive commit removes the record (git show), B then lists retired
- (unsure) L310 a clone of the same remote under another folder name sees the task of another machine as on host-a, by its repo key — repo key from a second clone of the app origin; unsure: real git only as setup, could be in-process with repository()
- L496 ledger store sync restores an edited or added record of another machine instead of committing it, and warns once for each — sync restores another machine's record (`commitChanges`/`restoreFromHead` on real git)
- L518 ledger store sync puts back a record of another machine that was staged and then edited, and pushes none of it — staged-then-edited record put back
- L534 ledger store sync warns once for a record of another machine whose removal was staged while it stayed on disk — staged removal of record put back
- L566 ledger store sync commits nothing when git cannot look up HEAD while it puts back a record of another machine — git stub fails HEAD lookup during put-back
- L586 ledger store sync puts back a record of another machine that an edit left without its host, or as no JSON, and pushes neither — put back record without host / not JSON
- L604 a forced retire of a task of another machine stays done when a sync runs between its removal of the record and its commit — sync between record removal and commit (real git race)
- (unsure) L628 in a worktree folder of another machine on a shared disk, bare ledger show prints the read-only line and ledger session names no own task — cwd in another machine's worktree on shared disk; unsure: lookup-by-cwd could be in-process on the file store
- L646 ledger store sync looks for unfinished work in the clone only while it holds the clone lock — unfinished-work check only under clone lock (git stub)
- L659 the session start looks for unfinished work in the clone only while it holds the clone lock — same for the session start path
- L672 with a "host" that is no label, ledger store sync still commits and pushes a backlog ledger — bad host: sync still commits+pushes backlog
- L684 with a "host" that is no label, a store write commits its ledger and leaves the active records as HEAD has them — bad host: write commits, leaves active records as HEAD has them
- L700 with a "host" that is no label, the session start in a worktree still prints its ledger — bad host: session start in worktree prints its ledger (absorbs 191)
- L711 with a "host" that is no label, the session start still ends by its deadline when git stalls — bad host: session start deadline with stalled git (spawn, 2 s limit)
- L746 ledger store sync leaves the .gitignore as it is while a merge is in progress in the clone — merge in progress: .gitignore untouched
- L756 a clone made before active records is repaired by ledger store sync, which then pushes the record — pre-active clone repaired by sync, record pushed
- L767 a clone made before active records is repaired by the session start, so a manual git push of the record goes through its hook — pre-active clone repaired by session start; manual push through hook
- L790 a copy of a worktree ledger from before active records is ignored by reads, and the first write removes it in its commit — legacy copy ignored by reads, removed by first write commit
- L811 the first write removes only the copies of worktree ledgers from before active records, and keeps every other file and folder in active/ — first write removes only legacy copies
- L945 after "host" changes, notes, park, go and retire of a task this machine started go through, and the first write names the new host — writes after host change commit the new host (git show HEAD)
- L960 a plain ledger task retire finishes a retire whose worktree removal deleted the folder and then failed — worktree removal failed after deleting the folder (real git worktree); note: no remote needed, file store + worktreeTask suffices
- L1005 a plain rerun of a retire whose worktree folder is gone prunes the worktree, deletes the merged branch and the build folder — rerun prunes worktree, deletes merged branch + build folder (real git); no remote needed
- L1018 a plain rerun of a retire whose worktree folder is gone keeps an unmerged branch and names it — rerun keeps unmerged branch (real git); no remote needed
- L1029 a plain rerun of a retire whose worktree folder is gone keeps the branch once another worktree has it checked out — rerun keeps branch checked out elsewhere (real git worktree)
- L1043 a plain rerun finishes the branch and the build folder of a retire that stopped as it deleted the branch — retire killed mid branch delete (spawn + kill -9)
- (unsure) L1067 a plain retire of a task of this machine whose worktree folder is gone still needs --force when the archive holds no copy of it — retire without archive copy needs --force; unsure: storage-agnostic, could use file store
- (unsure) L1079 a plain retire of a task of this machine whose worktree folder is gone still needs --force when its archive copy holds other text — archive copy differs needs --force; unsure: as 1067
- (unsure) L1090 a plain rerun with --json of a retire whose worktree folder is gone gives its place as active — rerun --json place active; unsure: could fold into 1005

**to-unit** (22)

- L127 hostLabel is the host name up to its first dot, in lowercase, with each character outside a-z, 0-9 and - as - — already unit (`hostLabel` in tools/ledger/settings.ts)
- L142 a host name that gives no label fails and says to set "host" in the settings file — already unit (`readHost`)
- L152 a "host" setting that is no label fails and says to set "host" in the settings file — already unit (`readHost`)
- L164 the allowlist takes a host folder only as lowercase letters, digits and hyphens — already unit (`isAllowed`)
- L202 the active record of a task names the host of the machine that started it: "host", else the label of its host name — in-process: runInProcessWith on the file store (it has `host`/`ownHosts`); go needs only a local repo (worktreeTask/repository), no remote
- L227 ledger show of a task on another machine says it is read-only and on which host, then prints the ledger unchanged — in-process: runInProcessWith on the file store with an active record `host: host-a` (as ledger-core-write.test.ts `putActive`); read-only line from tools/ledger/cli.ts
- L239 ledger go of a task on another machine exits non-zero, names the host, says it is read-only, and creates nothing — in-process as 227: go refuses (tools/ledger/tasks.ts), no worktree/branch made
- L254 ledger go of a task on another machine refuses also when it has a child in the backlog here, and starts no child — in-process as 227, plus a backlog child
- L293 an active task hides a backlog ledger with the same repo and slug — in-process as 227: list hides a backlog twin
- L330 ledger show --repo <label> from a folder outside the repo finds a task of another machine filed only under the key with that label — in-process as 227: show --repo label from outside the repo
- L340 ledger notes of a task on another machine refuses, names the host, says it is read-only, and changes nothing — in-process as 227: notes check/note refuse; make it the table for 357 and 367
- L388 ledger tree add of a child under a parent on another machine refuses before it changes the child — in-process as 227: tree add refuses before changing the child
- L401 ledger tree remove of a child on another machine refuses before it changes the parent here — in-process as 227 on the file store (reads pre-record Markdown; memoryStore does not)
- L417 ledger tree add numbers the local siblings without an order and leaves a sibling on another machine as it is — in-process as 401: tree add order numbering skips the other machine's sibling
- L434 ledger task retire of a child whose parent is on another machine warns with the host, and leaves the parent as it is — in-process as 401: `retireTask` warns with host (tools/ledger/retire.ts:229)
- L469 a task of another machine filed under an old repo key is shown, and refused by go, in the repo of the key it is an alias of — in-process as 227 with an alias file (old repo key)
- L483 ledger list --json gives a task of another machine filed under an old repo key the key it is an alias of as currentRepo — in-process as 469: list --json currentRepo
- L857 readTimedText reads no file through a symbolic link that replaced the file after it was checked — already unit (`readTimedText` in tools/ledger/files.ts)
- L899 starting a task notes its host label in ~/.claude/ledger-hosts.json, outside the store — in-process on the file store: ledger-hosts.json written on start (`ownHosts` in settings.ts); "not in clone" follows from the allowlist
- L906 after "host" changes, this machine lists its task as active here, not as one on its old host — in-process on the file store after a host change
- L914 after "host" changes, ledger show prints the ledger of a task of this machine without the read-only line — in-process on the file store: show without read-only line; absorbs 924
- L931 after "host" changes, a task of this machine filed under an old repo key is listed as active here and shown without the read-only line — in-process on the file store with an alias file

**merge** (8)

- L137 hostLabel trims the hyphens at either end — into tests/ledger-other-machines.test.ts "hostLabel is the host name up to its first dot…" (add rows to its table)
- L169 ledger store sync and the pre-push hook of a manual git push both refuse a copy in a host folder that is no label — into tests/ledger-git-store.test.ts "ledger store sync and the pre-push hook of a manual git push both refuse a path outside the allowlist, a backslash…" (add `active/Host_A/…` case)
- L191 with a "host" that is no label, the session start still exits 0 — into tests/ledger-other-machines.test.ts "with a \"host\" that is no label, the session start in a worktree still prints its ledger" (table over cwd: main checkout / worktree)
- L357 ledger task claim of a task on another machine names the host and says it is read-only, not that it is retired — into tests/ledger-other-machines.test.ts "ledger notes of a task on another machine refuses…" (table of write commands)
- L367 ledger task park of a task on another machine refuses, names the host, says it is read-only, and changes nothing — into tests/ledger-other-machines.test.ts "ledger notes of a task on another machine refuses…" (table of write commands)
- L546 ledger store sync --quiet puts back a record of another machine without a warning — into tests/ledger-other-machines.test.ts "ledger store sync restores an edited or added record of another machine…" (table: --quiet → no warning)
- L833 a token in an active record blocks its push: file:line is named, the token is not printed, the commit stays local — into tests/ledger-git-store.test.ts "a token in a backlog ledger blocks the push: file:line is named…" (table: backlog ledger / active record; add the hook push)
- L924 after "host" changes, ledger show --repo from a folder outside the repo prints the ledger without the read-only line — into tests/ledger-other-machines.test.ts "after \"host\" changes, ledger show prints the ledger of a task of this machine without the read-only line" (add --repo and cwd variants)

</details>

<details><summary><code>tests/ledger-store-repair.test.ts</code> — 136 tests</summary>

**keep-e2e** (39)

- store repair reports a repo key whose main checkout has another key now, and the --remote command for it — repo key from a real git remote set-url (keyNow/renamedKeys); the one e2e for rename detection
- store repair --search lists the linked worktrees of the task repo on its branch in the named folders, 6 levels deep, ... — --search over real worktrees/clone/stranger checkout: checkoutsIn + isWorktreeOf use git
- store repair <slug> --to points the task at the folder it moved to, and repairs the git worktree link — --to runs git worktree repair on the moved worktree
- (unsure) store repair <slug> --to records the new main checkout when the repo moved — --to after the main checkout moved: mainCheckout via git of moved repo, unsure: could be to-unit with key seam
- store repair <slug> --to refuses, writing nothing, a task that is not active, a missing folder, no checkout, a taken ... — mixed: not-active/missing/taken refusals are unit (activeNamed/refuseTaken); no-checkout/other-branch refusals need git. Split candidate
- store repair <slug> --to refuses, with one line, a main checkout and a checkout of another repo on the task branch — refuses main checkout and checkout of another repo: git checkout identity
- git store: store repair --to and --lost write the record and commit it — git store: --to/--lost write and commit (machine)
- git store: aliases.replace removes and adds aliases in one write, and changes nothing when it refuses an alias — git store aliases.replace commit (machine)
- file store: a lost task does not hold its old folder, so ledger task new --here starts a task in a new worktree there — task new --here in a re-added real git worktree at the lost task's path
- git store: store repair reports a renamed remote, and --remote files its tasks under the new key and commits them — git store: --remote commits moves (machine)
- ledger task retire of a lost task removes no worktree, also with --force, though another task lives at its old path now — task retire (with --force) must not remove another task's real git worktree
- git store: store repair --remote exits 1 and says to run ledger store sync when the store commit fails, keeps the ali... — git store commit failure path, ledger store sync hint (machine)
- git store: the report, --search, each --dry-run and each refusal put back no pre-push hook and commit nothing — git store: pre-push hook and no commit after report/dry-runs/refusals (machine)
- store repair reports a renamed remote for a clone whose key changed, while another clone still has the old key — two clones with different remote URLs: key per clone from git
- (unsure) store repair, run from a main checkout that moved, prints fix commands that run — main checkout moved; printed commands rerun: git worktree paths, unsure: could be unit with key seam
- (unsure) ledger task retire without a slug, in the worktree that took a lost task’s old path, picks the task of that worktree — task retire without slug from inside the reused git worktree; picks task by cwd and removes a real worktree, unsure
- a clone that still has the old key of an alias sees the task --to pointed at a worktree of it, in its main session an... — second clone still on the old key sees the --to task: key per clone from git
- store repair --search, run outside the repo after its main checkout moved, prints a --to command for the one checkout... — --search from outside the repo after main moved; runs the printed --to: git checkout detection
- git store: store repair <slug> --to and --lost of another machine’s task refuse, also as a dry run, and put back no h... — git store: other machine's task refusals, hook, nothing written (machine)
- git store: store repair --remote that moves nothing, as an archive copy of that name is under the current key, puts b... — git store: --remote no-op puts back no hook, commits nothing (machine)
- store repair --search that finds the task repo only on another branch prints a --lost command that names the task by ... — --search finds repo only on another branch: branch from git; prints/runs --lost ref
- git store: store repair --remote run again after the alias write failed moves what is left and records the alias — git store: rerun after alias write failure commits (machine)
- (unsure) git store: store repair --remote of the encoding of this repo's key, one repo folder in a file store, refuses and rem... — git store variant, unsure: same fileStoreAt layout; could be delete covered by file variant
- git store: store repair --remote run again after a run that recorded the alias and stopped between an archive copy an... — git store: rerun commits evidence move
- git store: store repair --remote run again after a run that stopped between its moves and their commit commits the moves — git store: rerun commits moves left uncommitted
- git store: store repair --remote run again after a run that moved another machine’s record and stopped before its com... — git store: foreign move committed on rerun
- git store: store repair --remote run again after a run whose removal git could not commit, as the old record is marke... — git store: assume-unchanged index flag blocks commit
- (unsure) store repair <slug> --to records the main checkout of its folder, though another --to pointed the task into another c... — race: another --to points the task into another clone; clone identity via git, unsure
- repair with work left commits the pending foreign move — git store: pending foreign move committed by repair
- sync commits the pending foreign move — git store: store sync commits pending foreign move
- a different blob cannot claim a foreign deletion — git: blob identity decides foreign deletion
- (unsure) repair reports the unreadable old evidence folder — git store: unreadable old evidence folder reported, unsure: evidence lives outside the clone, may be unit on fileStore
- a case-mismatched destination cannot claim a foreign deletion — git: case-mismatched destination vs foreign deletion
- a matching old blob cannot replace a foreign record already in HEAD — git: old blob vs foreign record in HEAD
- (unsure) repair reports an unlistable evidence root containing movable evidence — git store: unlistable evidence root, unsure: evidence outside clone
- a case-different old record on disk is no pending move — git: case-different old record not a pending move
- a case-variant destination in HEAD cannot claim a foreign deletion — git: case-variant destination in HEAD
- repair commits the foreign source deletion after its index flag is cleared — git: index flag cleared, then deletion committed
- (unsure) repair reports an unreadable case-variant evidence repo folder — git store: unreadable case-variant evidence repo folder, unsure: evidence outside clone

**to-unit** (88)

- (unsure) store repair without a task reports no problems when every recorded folder is there — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; missingTasks ; git only gives the repo key (repository/renameOrigin): n…
- store repair reports an active task whose folder is gone, with its repo, folder and branch, and the commands that fix it — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; missingTasks report lines (status/parked filter); start/go makes a real…
- (unsure) file store: store repair --search passes by a checkout two active records name, and still reports every other task — refuseTaken/otherHolder: checkout named by two records, unsure: needs a found checkout (git)
- store repair --search fails on a folder that does not exist — searchRoots refuses a missing folder; no git needed
- (unsure) store repair <slug>@<path> --to names the task of the repo at <path> from outside it — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; slug@path ref resolution, unsure: path→key goes through git
- (unsure) store repair <slug> --to --dry-run prints the change and writes nothing — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; pointTo dryRun writes nothing, unsure: --to target must be a git checkout
- (unsure) store repair <slug> --to takes a checkout whose repo key is an alias of the task key — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; isWorktreeOf with alias map, unsure: checkout key comes from git
- (unsure) store repair <slug> --lost marks the task lost: ledger list shows it, the report and session start pass it by — in-process list/show/session on memoryStore; markLost + session skip; git worktree add only to recreate folder, unsure: session --json may need a worktree
- store repair <slug> --lost refuses a task whose folder is there, and --dry-run writes nothing — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; markLost refusal + dryRun
- (unsure) store repair --remote files every task of the old key under the current key and keeps the old key as an alias — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; refileRemote moves + alias ; git only gives the repo key (repository/re…
- (unsure) store repair --remote --dry-run prints the moves and writes nothing — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; refileRemote dryRun ; git only gives the repo key (repository/renameOri…
- (unsure) store repair --remote leaves a task whose slug the current key has, lists it, and exits 1 — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; refileRemote slug conflict, exit 1 ; git only gives the repo key (repos…
- (unsure) store repair --remote re-points each alias of the old key to the current key; --dry-run only shows it — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; alias re-point ; git only gives the repo key (repository/renameOrigin):…
- (unsure) store repair --remote re-points no alias while a conflict keeps tasks under the old key — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; no alias re-point on conflict ; git only gives the repo key (repository…
- store repair --remote fails for a key that has no task — keyToFileUnder/nothingFiledUnder; no repo needed
- store repair refuses each bad combination of options with one line — repairStore option checks (lines 450-454) throw before any store read; drop setup()
- (unsure) sqlite store: store repair reports a missing folder, --to points the task at its new folder, and --lost marks one lost — in-process on sqliteStore; sqlite counterpart of 94/319, unsure: --to part needs a git checkout
- file store: aliases.replace removes and adds aliases in one write, and changes nothing when it refuses an alias — direct store call (replacesAliases); drop setup() git repo; in-process
- sqlite store: aliases.replace removes and adds aliases in one write, and changes nothing when it refuses an alias — direct store call (replacesAliases); drop setup() git repo; in-process
- (unsure) store repair --remote back to the key a repo was renamed from leaves one alias, not a cycle — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; alias cycle avoidance ; git only gives the repo key (repository/renameO…
- (unsure) sqlite store: store repair reports a renamed remote, and --remote files its tasks under the new key with an alias — in-process sqliteStore; sqlite counterpart of 114+379 ; git only gives the repo key (repository/renameOrigin): needs a repo-key seam or one shared template repo, unsure: keyNow/…
- (unsure) store repair quotes the paths in the commands it prints, so they run in a shell — quoting in refOf/printed commands: string assertions; worktreeAt/renameOrigin only feed paths and keys, unsure: --search part needs a git checkout
- (unsure) store repair --remote leaves a task whose main checkout is gone or has a third key, as it is, lists it, writes no ali... — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; refileRemote leaves gone/third-key main ; git only gives the repo key (…
- (unsure) store repair --remote leaves a task whose slug any place of the current key has, active too — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; refileRemote conflict incl. active ; git only gives the repo key (repos…
- sqlite store: the report and --search find no problems before the database exists, and they, each --dry-run and each ... — in-process sqlite, no database yet: repairStore with store undefined
- (unsure) store repair, after --to took a checkout through an alias, reports no rename and counts the task as this machine’s — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; renamedKeys with alias + host counting, unsure: depends on a --to throu…
- store repair <slug> --to refuses a parked task — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; pointTo refuses parked
- store repair <slug> --lost refuses a task marked lost whose folder is back — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; markLost refuses lost task whose folder is back
- a - lost: Location line in any other shape than the lost mark stays a note through a record round trip — already unit: record round trip of a "- lost:" note (parseRecord/renderRecord)
- (unsure) store repair --remote leaves a ledger whose title has the slug of a live task of the current key, though its name dif... — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; refileRemote title-slug clash ; git only gives the repo key (repository…
- a - lost: line is the lost mark only in the shape written for the recorded worktree, wherever it stands in Location — already unit: setLostMark/parseLedger lost-mark shapes
- ledger task retire of a lost task says it is lost, not that it may be live on another machine — in-process: task retire message for a lost task on memoryStore
- store repair <slug> --lost refuses a parked task, and --to refuses a parked task that is marked lost — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; parked/lost refusals of --lost and --to
- store repair <slug> --lost refuses a blocked, waiting or done task, names its state, and writes nothing — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; --lost refuses blocked/waiting/done (table)
- store repair reports a blocked, waiting or done task whose folder is gone with --to only, as --lost refuses it; a par... — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; report shows --to only for blocked/waiting/done, skips parked
- store repair <slug> --to of a lost task with a status line removes the lost mark and keeps the status line — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; --to of a lost task drops the mark, keeps status
- store repair <slug> --to refuses to make a lost code task waiting without a PR link; with a link, or as a docs task, ... — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; --to to waiting needs PR link (code vs docs task)
- (unsure) store repair --remote moves a ledger that names no main checkout when the old key is an alias of this repo already — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; refileRemote ledger with no main, alias already set ; git only gives th…
- (unsure) store repair --remote, run in the main checkout, leaves a ledger whose main line is . and says its main is relative — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; relative main "." left. unsure: test is sync but awaits nothing from as…
- file store: store repair --to and --lost keep a - lost: note that is no lost mark, and change only the mark — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; setLostMark keeps a "- lost:" note
- setLostMark adds, keeps and drops only the lost mark, never a - lost: note in Location — already unit: setLostMark (tools/ledger/edit.ts)
- a - lost: line not in the exact shape the lost mark is written in is a note to setLostMark and to record conversion — already unit: setLostMark + record conversion
- file store: store repair --to and --lost keep a - lost: note that names the worktree but lacks the space after the colon — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; setLostMark keeps a "- lost:" note
- (unsure) store repair --remote refuses, moving nothing, when an alias of the old key files a task whose slug the current key has — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; refileRemote refuses alias-filed slug clash ; git only gives the repo k…
- (unsure) store repair --search with a folder and a folder inside it finds a checkout once, and prints a --to command that runs... — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; search dedupe of nested roots + ref text, unsure: needs one found check…
- (unsure) store repair --search that finds two checkouts prints a task reference that runs from outside the repo, though no --t... — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; refOf with two found checkouts, unsure: checkout detection uses git
- (unsure) store repair <slug> --to records the main checkout of a record that names none, so the next rename can be found — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; pointTo records main when record has none, unsure: main derived from gi…
- (unsure) store repair --search given one folder in two spellings of its case finds its checkout once, and prints a --to comman... — canonicalPath/searchRoots case folding; unsure: needs a found checkout
- store repair --search prints no --to command for a folder that another task names as its own — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; isUnclaimed/otherHolder suppresses --to
- (unsure) store repair --remote refuses, moving nothing, when the key of this repo is an alias of a third key already, so no ch... — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; refuses alias chain ; git only gives the repo key (repository/renameOri…
- (unsure) file store: store repair --remote run again after the alias write failed moves what is left and records the alias — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; failingAliasWrite stub, rerun ; git only gives the repo key (repository…
- (unsure) file store: store repair --remote of the encoding of this repo's key, one repo folder in a file store, refuses and re... — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; key-encoding refusal ; git only gives the repo key (repository/renameOr…
- store repair --remote of a key that never had a task or an alias still refuses with its message — keyToFileUnder message; no repo needed
- (unsure) store repair --remote run again after the evidence of an archive copy failed to move moves that evidence and records ... — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; rerun after evidence move failure ; git only gives the repo key (reposi…
- (unsure) store repair --remote leaves a record under the old key that cannot be read, names it, records no alias and exits 1 — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; unreadable record under old key ; git only gives the repo key (reposito…
- (unsure) tree next counts a dependency on a task of another repo by its old key as done once --remote filed that repo under it... — in-process tree next on memoryStore with alias map ; git only gives the repo key (repository/renameOrigin): needs a repo-key seam or one shared template repo, unsure: keyNow/mai…
- store repair --search refuses a folder named by a symbolic link, and finds nothing in a named node_modules or .claude... — isSkipped/isWithinSkipped + canonicalPath symlink refusal (repair.ts:67-108); worktrees only as setup
- store repair --search finds nothing in a named folder inside a node_modules or .claude/worktrees/.build folder of any... — isSkipped/isWithinSkipped table (all name cases and depths); fold 1867 and 2046 in here
- (unsure) store repair --remote passes over evidence under the old key whose archive copy is under neither key, and records the... — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; orphan evidence passed over ; git only gives the repo key (repository/r…
- (unsure) store repair --remote run again after a run that recorded the alias and stopped before every move moves what is left — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; rerun after partial moves ; git only gives the repo key (repository/ren…
- (unsure) store repair --remote keeps the alias it recorded when a move and the store commit both fail, and says to run ledger ... — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; alias kept when move and commit both fail (failing store stub) ; git on…
- (unsure) store repair --remote run again after the alias was recorded says it keeps that alias when a move fails — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; rerun keeps alias on move failure ; git only gives the repo key (reposi…
- (unsure) sqlite store: store repair --remote leaves a record under the old key that cannot be read, names it, records no alias... — in-process sqliteStore; sqlite counterpart of 1501 ; git only gives the repo key (repository/renameOrigin): needs a repo-key seam or one shared template repo, unsure: keyNow/mai…
- store repair --remote holds the repair lock from its first read, so a second run cannot take back the alias the first... — already in-process (repairWith); repair lock held from first read; 0.2 s lock wait -> fake clock
- store repair <slug> --lost waits for the repair lock, and marks nothing while another repair holds it — already in-process; lock wait 0.2 s -> fake clock
- store repair --remote keeps waiting for a repair lock older than a minute while the process that holds it still runs — already in-process; stale-lock pid check uses own pid; 0.2 s wait -> fake clock
- (unsure) store repair --remote run again after a run that recorded the alias and stopped between an archive copy and its evide... — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; rerun between archive copy and evidence ; git only gives the repo key (…
- store repair --search refuses a folder named through a symbolic link and .., by the folder the path leads to — canonicalPath symlink + .. refusal; no git needed
- store repair --search finds nothing in a .git folder it is given by name — isSkipped(.git); worktree only as setup
- sqlite store: store repair --remote of a key with no task says so before the database exists — in-process sqlite, no db: keyToFileUnder message
- (unsure) store repair --remote keeps the alias when a repo folder it emptied cannot be removed, and a rerun finishes — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; chmod repo folder, rerun finishes ; git only gives the repo key (reposi…
- (unsure) store repair --remote moves an archive copy whose name ends in .md with its evidence, and records the alias — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; .md archive copy + evidence moved ; git only gives the repo key (reposi…
- (unsure) tree depends refuses a dependency on the task itself, or a cycle, named by the old key of a renamed remote — in-process tree depends cycle check with alias map ; git only gives the repo key (repository/renameOrigin): needs a repo-key seam or one shared template repo, unsure: keyNow/mai…
- (unsure) store repair --remote run again after a run killed between linking each ledger under the new key and removing it from... — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; rerun after kill between link and remove (hard links planted) ; git onl…
- (unsure) store repair --remote run again after a run killed between the two links, or the two removals, of a record and the Ma... — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; rerun with record + hidden Markdown links ; git only gives the repo key…
- (unsure) store repair --remote run again after a run killed between removing a record and the Markdown it hid removes that Mar... — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; leftover hidden Markdown removed ; git only gives the repo key (reposit…
- (unsure) store repair --remote leaves old Markdown that names a checkout that is gone when the record of its name under the ne... — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; leaves unrelated old Markdown ; git only gives the repo key (repository…
- (unsure) store repair --remote run again with nothing left to move opens no store to write when the store has no commit to finish — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; no writable store opened when nothing left ; git only gives the repo ke…
- (unsure) store repair --remote --dry-run leaves a ledger whose hidden Markdown is a symbolic link, as the move does, also one ... — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; symlinked hidden Markdown in dry run and move ; git only gives the repo…
- (unsure) store repair --remote stops, moving nothing and recording no alias, when a repo folder of the old key cannot be read — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; unreadable old repo folder stops ; git only gives the repo key (reposit…
- a repo folder of the store that cannot be read is passed over by ledger list and ledger show, so it stops no command ... — in-process list/show on fileStore with a chmod 000 repo folder; git only for setup
- (unsure) tree depends keeps one dependency on a task named by both the old and the new key of a renamed remote — in-process tree depends dedupe old/new key ; git only gives the repo key (repository/renameOrigin): needs a repo-key seam or one shared template repo, unsure: keyNow/mainCheckou…
- (unsure) repair finishes a linked record after its checkout vanishes — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; linked record finished after checkout gone (file store) ; git only give…
- (unsure) repair refuses a half-moved backlog task whose slug is active at the destination — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; half-moved backlog vs active slug refusal ; git only gives the repo key…
- (unsure) repair checks the record slug when only hidden Markdown remains at the old key — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; slug check when only hidden Markdown left ; git only gives the repo key…
- (unsure) repair checks the record slug when hidden Markdown under the old key is linked in another case under the new key — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; case-variant hard links slug check ; git only gives the repo key (repos…
- (unsure) repair refuses two half-moved ledgers of one slug, one backlog and one active — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; refuses two half-moved ledgers of one slug ; git only gives the repo ke…
- (unsure) store repair <slug> --to keeps a main line under ~ that names the main checkout, in a dry run too — in-process: repairWith (repairStore, tools/ledger/repair.ts) + memoryStore/fileStore with seeded records; --to keeps "~" main line. unsure: sync test destructures async start() …

**merge** (9)

- (unsure) sqlite store: store repair --search passes by a checkout two active records name, and still reports every other task — merge into file variant (store table in unit), unsure: sqlite byWorktree SQL differs; covered by ledger-active-store "sqlite active worktree lookup"
- (unsure) sqlite store: a lost task does not hold its old folder, so ledger task new --here starts a task in a new worktree there — merge into file variant, unsure: sqlite worktree lookup path; covered by ledger-active-store "sqlite active worktree lookup"
- sqlite store: store repair --to and --lost keep a - lost: note that is no lost mark, and change only the mark — merge into file variant as a store table in unit
- sqlite store: store repair --to and --lost keep a - lost: note that names the worktree but lacks the space after the ... — merge into file variant as a store table in unit
- sqlite store: store repair --remote run again after the alias write failed moves what is left and records the alias — merge into file variant (store table)
- sqlite store: store repair --remote of the encoding of this repo's key, one repo folder in a file store, refuses and ... — merge into file variant (store table)
- store repair --search refuses a folder whose path goes through a symbolic link — merge into ledger-store-repair.test.ts > "store repair --search refuses a folder named through a symbolic link and .., by the folder the path leads to" as one canonicalPath table
- store repair --search finds nothing in a node_modules or .claude/worktrees/.build folder named in another case, on a ... — merge into ledger-store-repair.test.ts > "store repair --search finds nothing in a named folder inside a node_modules or .claude/worktrees/.build folder of any case, at any depth" (isSkipped table)
- store repair --search finds nothing in a node_modules or .claude/worktrees/.build folder whose name on disk is in mix... — merge into ledger-store-repair.test.ts > "store repair --search finds nothing in a named folder inside a node_modules or .claude/worktrees/.build folder of any case, at any depth"

</details>

<details><summary><code>tests/ledger-core-store.test.ts</code> — 223 tests</summary>

**keep-e2e** (21)

- git store: a store opened again on the same HOME reads what the first one wrote — git store contract: reopen runs setUpClone on an existing clone; in-process, cost is clone setup (git init + setUpClone); share one clone fixture
- git store: a second backlog write replaces the text — git store contract: locked write wrapper; in-process, cost is clone setup (git init + setUpClone); share one clone fixture
- git store: removing a backlog ledger that is not there throws — git store contract: locked remove; in-process, cost is clone setup (git init + setUpClone); share one clone fixture
- git store: remove keeps a backlog ledger whose text is not the text the caller read — git store contract: locked remove with expected text; in-process, cost is clone setup (git init + setUpClone); share one clone fixture
- git store: has follows write and remove — git store contract: locked write/remove; in-process, cost is clone setup (git init + setUpClone); share one clone fixture
- git store: write and update replace a Markdown ledger with a record; create and an archive write refuse its name — git store contract: write/update over Markdown: ledgerFiles json+md; in-process, cost is clone setup (git init + setUpClone); share one clone fixture
- git store: remove of a Markdown ledger takes its rendered text as expected, and leaves nothing of it — git store contract: locked remove of Markdown; in-process, cost is clone setup (git init + setUpClone); share one clone fixture
- git store: toRecord rewrites a Markdown ledger as a record, its text and modified time as they were, and is false for... — git store contract: toRecord wrapper; in-process, cost is clone setup (git init + setUpClone); share one clone fixture
- git store: a record wins over a Markdown ledger of the same name — git store contract: record over Markdown in clone; in-process, cost is clone setup (git init + setUpClone); share one clone fixture
- git store: a write over a record that hides a Markdown ledger of the same name keeps the Markdown, and hiddenMarkdown... — git store contract: hiddenMarkdown after locked write; in-process, cost is clone setup (git init + setUpClone); share one clone fixture
- git store: remove refuses a task whose record hides Markdown, names the conflict and ledger store migrate --records, ... — git store contract: remove refusal in wrapper; in-process, cost is clone setup (git init + setUpClone); share one clone fixture
- git store: a move takes the Markdown a record hides along, so neither repo shows it — git store contract: move wrapper fromAndTo; in-process, cost is clone setup (git init + setUpClone); share one clone fixture
- git store: a Markdown ledger moves to another repo and still reads there — git store contract: move wrapper of Markdown; in-process, cost is clone setup (git init + setUpClone); share one clone fixture
- git store: a write whose record would not read back the same fails, names the ledger, and changes nothing — git store contract: failed write still notes written files; in-process, cost is clone setup (git init + setUpClone); share one clone fixture
- git store: toRecord keeps the birth time of the Markdown it converts as the created time, also through a later write — git store contract: keptCreated birth time (git-specific); in-process, cost is clone setup (git init + setUpClone); share one clone fixture
- git store: a write or an update over a Markdown ledger, such as a park, keeps the Markdown's birth time as the create... — git store contract: keptCreated through write/update; in-process, cost is clone setup (git init + setUpClone); share one clone fixture
- git store: an archive write refuses evidence whose repo folder is a symbolic link, and writes nothing — git checkFolders symlink refusal (git-store.ts:80-84); in-process, clone setup cost
- git store: a new backlog ledger, without evidence, is refused when the backlog root is a symbolic link, and nothing i... — git checkFolders on collection root
- git store: a new archive ledger, without evidence, is refused when the archive root is a symbolic link, and nothing i... — git checkFolders on collection root
- git store: a write over a committed <name>.md commits <name>.json and the removal of the .md, and commit checks the r... — git store commit of .json and .md removal, checkCommitted
- git store: toRecord is committed like any other write — git store commits toRecord

**to-unit** (159)

- file store: a store opened again on the same HOME reads what the first one wrote — already unit (storeContract on file store)
- file store: archived evidence reads back: its files as sorted relative paths, without folders and links, and each fil... — already unit (storeContract on file store)
- file store: a symbolic link to a folder in the evidence is not followed: the files behind it are not evidence files — already unit (storeContract on file store)
- file store: evidence files with mixed-case and Unicode names are listed in UTF-16 code-unit order, not by UTF-8 bytes... — already unit (storeContract on file store)
- file store: ledger text with a NUL byte reads back with the NUL bytes, in the backlog and the archive — already unit (storeContract on file store)
- file store: no evidence reads back as none, and readEvidence gives nothing for a path that is not an evidence file — already unit (storeContract on file store)
- file store: evidenceState compares archived evidence with a folder: files by content, links by their text, folders, a... — already unit (storeContract on file store)
- file store: nameTaken is false for a new name and true once a copy uses it, with or without evidence — already unit (storeContract on file store)
- file store: an archive write with evidence refuses a taken name and adds no evidence to the first copy — already unit (storeContract on file store)
- file store: a backlog ledger reads back as written, with its repo, name, times and location — already unit (storeContract on file store)
- file store: a child's order and dependencies, by slug, address and path, read back from the backlog and the archive — already unit (storeContract on file store)
- file store: a second backlog write replaces the text — already unit (storeContract on file store)
- file store: backlog list holds the ledgers of one repo, by name — already unit (storeContract on file store)
- file store: a list is in the order of the file names, so fix-login.md comes before fix.md — already unit (storeContract on file store)
- file store: repos and lists with mixed-case and Unicode names are in UTF-16 code-unit order, not by UTF-8 bytes or lo... — already unit (storeContract on file store)
- file store: removing a backlog ledger that is not there throws — already unit (storeContract on file store)
- file store: remove keeps a backlog ledger whose text is not the text the caller read — already unit (storeContract on file store)
- file store: an unknown repo or name is empty, not an error — already unit (storeContract on file store)
- file store: has follows write and remove — already unit (storeContract on file store)
- file store: the archive keeps its own ledgers, apart from the backlog — already unit (storeContract on file store)
- file store: an evidence location is the same before and after the write, and apart from every ledger and other evidence — already unit (storeContract on file store)
- file store: a new store has no old task list, and no write makes one — already unit (storeContract on file store)
- file store: a ledger is kept as a task record, so read gives the record rendered, also for text out of the template l... — already unit (storeContract on file store)
- file store: a claim reads back as written, in the backlog and in the archive — already unit (storeContract on file store)
- file store: a ledger kept as Markdown from before records reads as its record, rendered, and lists with the records — already unit (storeContract on file store)
- file store: write and update replace a Markdown ledger with a record; create and an archive write refuse its name — already unit (storeContract on file store)
- file store: remove of a Markdown ledger takes its rendered text as expected, and leaves nothing of it — already unit (storeContract on file store)
- file store: toRecord rewrites a Markdown ledger as a record, its text and modified time as they were, and is false fo... — already unit (storeContract on file store)
- file store: a record wins over a Markdown ledger of the same name — already unit (storeContract on file store)
- file store: a write over a record that hides a Markdown ledger of the same name keeps the Markdown, and hiddenMarkdow... — already unit (storeContract on file store)
- file store: remove refuses a task whose record hides Markdown, names the conflict and ledger store migrate --records,... — already unit (storeContract on file store)
- file store: a move takes the Markdown a record hides along, so neither repo shows it — already unit (storeContract on file store)
- file store: a Markdown ledger moves to another repo and still reads there — already unit (storeContract on file store)
- file store: a ledger with a repeated section is the same record converted or written, its repeat a note, and it stays... — already unit (storeContract on file store)
- file store: a write whose record would not read back the same fails, names the ledger, and changes nothing — already unit (storeContract on file store)
- file store: toRecord keeps the birth time of the Markdown it converts as the created time, also through a later write — already unit (storeContract on file store)
- file store: a write or an update over a Markdown ledger, such as a park, keeps the Markdown's birth time as the creat... — already unit (storeContract on file store)
- sqlite store: a store opened again on the same HOME reads what the first one wrote — already unit (storeContract on sqlite store)
- sqlite store: archived evidence reads back: its files as sorted relative paths, without folders and links, and each f... — already unit (storeContract on sqlite store)
- sqlite store: a symbolic link to a folder in the evidence is not followed: the files behind it are not evidence files — already unit (storeContract on sqlite store)
- sqlite store: evidence files with mixed-case and Unicode names are listed in UTF-16 code-unit order, not by UTF-8 byt... — already unit (storeContract on sqlite store)
- sqlite store: ledger text with a NUL byte reads back with the NUL bytes, in the backlog and the archive — already unit (storeContract on sqlite store)
- sqlite store: no evidence reads back as none, and readEvidence gives nothing for a path that is not an evidence file — already unit (storeContract on sqlite store)
- sqlite store: evidenceState compares archived evidence with a folder: files by content, links by their text, folders,... — already unit (storeContract on sqlite store)
- sqlite store: nameTaken is false for a new name and true once a copy uses it, with or without evidence — already unit (storeContract on sqlite store)
- sqlite store: an archive write with evidence refuses a taken name and adds no evidence to the first copy — already unit (storeContract on sqlite store)
- sqlite store: a backlog ledger reads back as written, with its repo, name, times and location — already unit (storeContract on sqlite store)
- sqlite store: a child's order and dependencies, by slug, address and path, read back from the backlog and the archive — already unit (storeContract on sqlite store)
- sqlite store: a second backlog write replaces the text — already unit (storeContract on sqlite store)
- sqlite store: backlog list holds the ledgers of one repo, by name — already unit (storeContract on sqlite store)
- sqlite store: a list is in the order of the file names, so fix-login.md comes before fix.md — already unit (storeContract on sqlite store)
- sqlite store: repos and lists with mixed-case and Unicode names are in UTF-16 code-unit order, not by UTF-8 bytes or ... — already unit (storeContract on sqlite store)
- sqlite store: removing a backlog ledger that is not there throws — already unit (storeContract on sqlite store)
- sqlite store: remove keeps a backlog ledger whose text is not the text the caller read — already unit (storeContract on sqlite store)
- sqlite store: an unknown repo or name is empty, not an error — already unit (storeContract on sqlite store)
- sqlite store: has follows write and remove — already unit (storeContract on sqlite store)
- sqlite store: the archive keeps its own ledgers, apart from the backlog — already unit (storeContract on sqlite store)
- sqlite store: an evidence location is the same before and after the write, and apart from every ledger and other evid... — already unit (storeContract on sqlite store)
- sqlite store: a new store has no old task list, and no write makes one — already unit (storeContract on sqlite store)
- sqlite store: a ledger is kept as a task record, so read gives the record rendered, also for text out of the template... — already unit (storeContract on sqlite store)
- sqlite store: a claim reads back as written, in the backlog and in the archive — already unit (storeContract on sqlite store)
- sqlite store: a ledger kept as Markdown from before records reads as its record, rendered, and lists with the records — already unit (storeContract on sqlite store)
- sqlite store: write and update replace a Markdown ledger with a record; create and an archive write refuse its name — already unit (storeContract on sqlite store)
- sqlite store: remove of a Markdown ledger takes its rendered text as expected, and leaves nothing of it — already unit (storeContract on sqlite store)
- sqlite store: toRecord rewrites a Markdown ledger as a record, its text and modified time as they were, and is false ... — already unit (storeContract on sqlite store)
- sqlite store: a record wins over a Markdown ledger of the same name — already unit (storeContract on sqlite store)
- sqlite store: a write over a record that hides a Markdown ledger of the same name keeps the Markdown, and hiddenMarkd... — already unit (storeContract on sqlite store)
- sqlite store: remove refuses a task whose record hides Markdown, names the conflict and ledger store migrate --record... — already unit (storeContract on sqlite store)
- sqlite store: a move takes the Markdown a record hides along, so neither repo shows it — already unit (storeContract on sqlite store)
- sqlite store: a Markdown ledger moves to another repo and still reads there — already unit (storeContract on sqlite store)
- sqlite store: a ledger with a repeated section is the same record converted or written, its repeat a note, and it sta... — already unit (storeContract on sqlite store)
- sqlite store: a write whose record would not read back the same fails, names the ledger, and changes nothing — already unit (storeContract on sqlite store)
- sqlite store: toRecord keeps the birth time of the Markdown it converts as the created time, also through a later write — already unit (storeContract on sqlite store)
- sqlite store: a write or an update over a Markdown ledger, such as a park, keeps the Markdown's birth time as the cre... — already unit (storeContract on sqlite store)
- memory store: a store opened again on the same HOME reads what the first one wrote — already unit (storeContract on memory store)
- memory store: archived evidence reads back: its files as sorted relative paths, without folders and links, and each f... — already unit (storeContract on memory store)
- memory store: a symbolic link to a folder in the evidence is not followed: the files behind it are not evidence files — already unit (storeContract on memory store)
- memory store: evidence files with mixed-case and Unicode names are listed in UTF-16 code-unit order, not by UTF-8 byt... — already unit (storeContract on memory store)
- memory store: ledger text with a NUL byte reads back with the NUL bytes, in the backlog and the archive — already unit (storeContract on memory store)
- memory store: no evidence reads back as none, and readEvidence gives nothing for a path that is not an evidence file — already unit (storeContract on memory store)
- memory store: evidenceState compares archived evidence with a folder: files by content, links by their text, folders,... — already unit (storeContract on memory store)
- memory store: nameTaken is false for a new name and true once a copy uses it, with or without evidence — already unit (storeContract on memory store)
- memory store: an archive write with evidence refuses a taken name and adds no evidence to the first copy — already unit (storeContract on memory store)
- memory store: a backlog ledger reads back as written, with its repo, name, times and location — already unit (storeContract on memory store)
- memory store: a child's order and dependencies, by slug, address and path, read back from the backlog and the archive — already unit (storeContract on memory store)
- memory store: a second backlog write replaces the text — already unit (storeContract on memory store)
- memory store: backlog list holds the ledgers of one repo, by name — already unit (storeContract on memory store)
- memory store: a list is in the order of the file names, so fix-login.md comes before fix.md — already unit (storeContract on memory store)
- memory store: repos and lists with mixed-case and Unicode names are in UTF-16 code-unit order, not by UTF-8 bytes or ... — already unit (storeContract on memory store)
- memory store: removing a backlog ledger that is not there throws — already unit (storeContract on memory store)
- memory store: remove keeps a backlog ledger whose text is not the text the caller read — already unit (storeContract on memory store)
- memory store: an unknown repo or name is empty, not an error — already unit (storeContract on memory store)
- memory store: has follows write and remove — already unit (storeContract on memory store)
- memory store: the archive keeps its own ledgers, apart from the backlog — already unit (storeContract on memory store)
- memory store: an evidence location is the same before and after the write, and apart from every ledger and other evid... — already unit (storeContract on memory store)
- memory store: a new store has no old task list, and no write makes one — already unit (storeContract on memory store)
- memory store: a ledger is kept as a task record, so read gives the record rendered, also for text out of the template... — already unit (storeContract on memory store)
- memory store: a claim reads back as written, in the backlog and in the archive — already unit (storeContract on memory store)
- memory store: a ledger kept as Markdown from before records reads as its record, rendered, and lists with the records — already unit; registered but skipped (memory keeps no Markdown)
- memory store: write and update replace a Markdown ledger with a record; create and an archive write refuse its name — already unit; registered but skipped (memory keeps no Markdown)
- memory store: remove of a Markdown ledger takes its rendered text as expected, and leaves nothing of it — already unit; registered but skipped (memory keeps no Markdown)
- memory store: toRecord rewrites a Markdown ledger as a record, its text and modified time as they were, and is false ... — already unit; registered but skipped (memory keeps no Markdown)
- memory store: a record wins over a Markdown ledger of the same name — already unit; registered but skipped (memory keeps no Markdown)
- memory store: a write over a record that hides a Markdown ledger of the same name keeps the Markdown, and hiddenMarkd... — already unit; registered but skipped (memory keeps no Markdown)
- memory store: remove refuses a task whose record hides Markdown, names the conflict and ledger store migrate --record... — already unit; registered but skipped (memory keeps no Markdown)
- memory store: a move takes the Markdown a record hides along, so neither repo shows it — already unit; registered but skipped (memory keeps no Markdown)
- memory store: a Markdown ledger moves to another repo and still reads there — already unit; registered but skipped (memory keeps no Markdown)
- memory store: a ledger with a repeated section is written as its record, its repeat a note — already unit (storeContract on memory store)
- memory store: a write, update, create or archive write whose record would not read back the same fails, names the led... — already unit (storeContract on memory store)
- memory store: a ledger with a repeated section is the same record converted or written, its repeat a note, and it sta... — already unit; registered but skipped (memory keeps no Markdown)
- memory store: a write whose record would not read back the same fails, names the ledger, and changes nothing — already unit; registered but skipped (memory keeps no Markdown)
- memory store: toRecord keeps the birth time of the Markdown it converts as the created time, also through a later write — already unit; registered but skipped (memory keeps no Markdown)
- memory store: a write or an update over a Markdown ledger, such as a park, keeps the Markdown's birth time as the cre... — already unit; registered but skipped (memory keeps no Markdown)
- file and git store: the old task list reads back from ~/.claude/ledgers.json and ~/.claude/ledgers-git.json — already unit; git half opens openGitStore (git init) only
- sqlite store: the old task list reads back from the registry table of a database older versions made — already unit
- file store: copyEvidence and remove refuse evidence whose repo folder is a symbolic link, and change nothing behind it — already unit
- file store: copyEvidence and remove refuse evidence whose evidence folder is a symbolic link, and change nothing behi... — already unit
- file store: an archive write refuses evidence whose repo folder is a symbolic link, and writes nothing — already unit
- file store: a new backlog ledger, without evidence, is refused when the backlog root is a symbolic link, and nothing ... — already unit
- file store: a new archive ledger, without evidence, is refused when the archive root is a symbolic link, and nothing ... — already unit
- file store: an archive write, copyEvidence and remove refuse an evidence root that is a symbolic link, and change not... — already unit
- file store: remove deletes the evidence before the copy, so a failed evidence delete leaves the copy to find — already unit
- file store: an archive remove keeps an edit made to the copy while its evidence is removed — already unit (fs mock)
- file store: an archive remove that finds the copy changed as it deletes it puts the copy back, keeps the evidence and... — already unit (fs mock)
- file store: toRecord of a backlog ledger holds the lock of the Markdown it replaces, so an edit that a writer from be... — already unit
- file store: toRecord of an archive copy holds the lock of the Markdown it replaces, so an edit that a writer from bef... — already unit
- file store: a backlog write holds the lock of the Markdown it replaces, so an edit that a writer from before records ... — already unit
- file store: a backlog update holds the lock of the Markdown it replaces, so an edit that a writer from before records... — already unit
- file store: a record made in place of Markdown keeps the Markdown's mode, whatever the umask — already unit
- sqlite store: copyEvidence refuses a path through a link it wrote under a name that differs only in case, on a volume... — already unit
- sqlite store: copyEvidence refuses an evidence path that leaves its folder: .., absolute, or through a link it wrote — already unit
- sqlite store: everything is in <home>/.claude/ledgers.db, with no other file under <home>/.claude but its journal files — already unit
- file store: each ledger is a <name>.json task record where the old layout had <name>.md, and its location is that abs... — already unit
- file store: a write replaces <name>.md with <name>.json, and the location names the file there is — already unit
- file store: a <name>.json that is no task record fails a read and names the file, and a list leaves it out — already unit
- sqlite store: a record is a row of the table records, whose parent and state columns come from the record; a write de... — already unit
- file store: a repo location is the repo folder, and without a repo the folder of all repos — already unit
- file store: an evidence location is the folder next to the archive copy, named as the copy without .md — already unit
- file store: a repo or name that is empty, . or .., or holds a path separator, is refused, and a list leaves such a fi... — already unit
- file store: a list skips what is not a .md file, such as an evidence folder next to an archive copy — already unit
- file store: a claim is kept in the task record as an object of its session, since and active times — already unit
- file store: a folder named <name>.md is no ledger: has, read and list all leave it out — already unit
- file store: a symbolic link named <name>.md is no ledger, even to a readable file: has, read and list all leave it out — already unit
- file store: an unreadable <name>.json is no ledger: has, read and list all leave it out — already unit
- file store: an unreadable <name>.md is no ledger: has, read and list all leave it out — already unit
- file store: repos are sorted by their full name, so app comes before app-x — already unit
- file store: a symbolic link to a folder is a repo — already unit
- file store: an archive write refuses a dangling symbolic link at the copy, and leaves the link as it was — already unit
- file store: an archive write does not follow a symbolic link at its temporary name, and writes no copy — already unit
- file store: a backlog write does not follow a symbolic link at its temporary name, and keeps the ledger as it was — already unit
- file store: an archive write refuses a dangling symbolic link at the evidence copy before it writes the ledger copy — already unit
- file store: an archive write keeps the ledger copy when the evidence copy then fails — already unit
- file store: writes go through a temporary file that is gone afterwards, and keep the mode of the file they replace — already unit
- file store: an archive write refuses an evidence folder that is already there, and writes no ledger copy — already unit
- file store: evidenceFiles throws when the evidence folder cannot be read, rather than report no evidence — already unit
- file store: an evidence folder that is a symbolic link is not followed: it lists no files and reads none — already unit
- file store: an archive write without evidence makes no evidence folder — already unit
- the core reads and writes backlog ledgers through the store it is given, and never reads the old task list — in-process createTask/parkTask/goTask on recording(fileStore); repository()+archivedTask git only for setup -> use a path with no repo (mainOf pattern)
- tree order checks every child for a ## Location section before it gives any child an order — in-process orderChildren; repository() git only for setup -> drop

**merge** (13)

- file store: an archive write refuses a name that is taken and keeps the first copy — merge into ledger-core-store.test.ts > "file store: an archive write with evidence refuses a taken name and adds no evidence to the first copy" (with/without evidence table)
- file store: a ledger with a repeated section is written as its record, its repeat a note — merge into "file store: a ledger with a repeated section is the same record converted or written..." (545), a superset
- file store: a write, update, create or archive write whose record would not read back the same fails, names the ledge... — merge into "file store: a write whose record would not read back the same fails..." (563), a superset; memory store keeps its 525
- sqlite store: an archive write refuses a name that is taken and keeps the first copy — merge into ledger-core-store.test.ts > "sqlite store: an archive write with evidence refuses a taken name and adds no evidence to the first copy" (with/without evidence table)
- sqlite store: a ledger with a repeated section is written as its record, its repeat a note — merge into "sqlite store: a ledger with a repeated section is the same record converted or written..." (545), a superset
- sqlite store: a write, update, create or archive write whose record would not read back the same fails, names the led... — merge into "sqlite store: a write whose record would not read back the same fails..." (563), a superset; memory store keeps its 525
- git store: an archive write refuses a name that is taken and keeps the first copy — merge into ledger-core-store.test.ts > "git store: an archive write with evidence refuses a taken name and adds no evidence to the first copy" (with/without evidence table)
- git store: a ledger with a repeated section is written as its record, its repeat a note — merge into "git store: a ledger with a repeated section is the same record converted or written..." (545), a superset
- git store: a write, update, create or archive write whose record would not read back the same fails, names the ledger... — merge into "git store: a write whose record would not read back the same fails..." (563), a superset; memory store keeps its 525
- memory store: an archive write refuses a name that is taken and keeps the first copy — merge into ledger-core-store.test.ts > "memory store: an archive write with evidence refuses a taken name and adds no evidence to the first copy" (with/without evidence table)
- file store: an archive write with evidence refuses a taken name before it copies anything — merge into "file store: an archive write with evidence refuses a taken name and adds no evidence to the first copy" (contract); add its no-folder-on-disk assert there
- (unsure) file store: an archive write with evidence copies the folder next to the copy and leaves the source as it was — merge into "file store: archived evidence reads back: its files as sorted relative paths..." (contract); add the source-unchanged assert. unsure: overlap partial
- (unsure) file store: evidenceState compares the evidence archived with a copy to a folder: files by content, links by their te... — merge into "file store: evidenceState compares archived evidence with a folder..." (contract), unsure: check no case is lost

**delete** (30)

- git store: archived evidence reads back: its files as sorted relative paths, without folders and links, and each file... — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: archived evidence reads back: its files as sorted relative p..." (same contract, kept)
- git store: a symbolic link to a folder in the evidence is not followed: the files behind it are not evidence files — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: a symbolic link to a folder in the evidence is not followed:..." (same contract, kept)
- git store: evidence files with mixed-case and Unicode names are listed in UTF-16 code-unit order, not by UTF-8 bytes ... — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: evidence files with mixed-case and Unicode names are listed ..." (same contract, kept)
- git store: ledger text with a NUL byte reads back with the NUL bytes, in the backlog and the archive — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: ledger text with a NUL byte reads back with the NUL bytes, i..." (same contract, kept)
- git store: no evidence reads back as none, and readEvidence gives nothing for a path that is not an evidence file — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: no evidence reads back as none, and readEvidence gives nothi..." (same contract, kept)
- git store: evidenceState compares archived evidence with a folder: files by content, links by their text, folders, an... — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: evidenceState compares archived evidence with a folder: file..." (same contract, kept)
- git store: nameTaken is false for a new name and true once a copy uses it, with or without evidence — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: nameTaken is false for a new name and true once a copy uses ..." (same contract, kept)
- git store: an archive write with evidence refuses a taken name and adds no evidence to the first copy — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: an archive write with evidence refuses a taken name and adds..." (same contract, kept)
- git store: a backlog ledger reads back as written, with its repo, name, times and location — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: a backlog ledger reads back as written, with its repo, name,..." (same contract, kept)
- git store: a child's order and dependencies, by slug, address and path, read back from the backlog and the archive — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: a child's order and dependencies, by slug, address and path,..." (same contract, kept)
- git store: backlog list holds the ledgers of one repo, by name — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: backlog list holds the ledgers of one repo, by name..." (same contract, kept)
- git store: a list is in the order of the file names, so fix-login.md comes before fix.md — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: a list is in the order of the file names, so fix-login.md co..." (same contract, kept)
- git store: repos and lists with mixed-case and Unicode names are in UTF-16 code-unit order, not by UTF-8 bytes or locale — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: repos and lists with mixed-case and Unicode names are in UTF..." (same contract, kept)
- git store: an unknown repo or name is empty, not an error — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: an unknown repo or name is empty, not an error..." (same contract, kept)
- git store: the archive keeps its own ledgers, apart from the backlog — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: the archive keeps its own ledgers, apart from the backlog..." (same contract, kept)
- git store: an evidence location is the same before and after the write, and apart from every ledger and other evidence — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: an evidence location is the same before and after the write,..." (same contract, kept)
- git store: a new store has no old task list, and no write makes one — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: a new store has no old task list, and no write makes one..." (same contract, kept)
- git store: a ledger is kept as a task record, so read gives the record rendered, also for text out of the template la... — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: a ledger is kept as a task record, so read gives the record ..." (same contract, kept)
- git store: a claim reads back as written, in the backlog and in the archive — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: a claim reads back as written, in the backlog and in the arc..." (same contract, kept)
- git store: a ledger kept as Markdown from before records reads as its record, rendered, and lists with the records — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: a ledger kept as Markdown from before records reads as its r..." (same contract, kept)
- git store: a ledger with a repeated section is the same record converted or written, its repeat a note, and it stays ... — reads pass straight to fileStoreAt (git-store.ts:59,161-166); covered by "file store: a ledger with a repeated section is the same record converte..." (same contract, kept)
- git store: copyEvidence and remove refuse evidence whose repo folder is a symbolic link, and change nothing behind it — evidence lives outside the clone and goes through fileStoreAt; covered by the file store variant (kept)
- git store: copyEvidence and remove refuse evidence whose evidence folder is a symbolic link, and change nothing behin... — evidence lives outside the clone and goes through fileStoreAt; covered by the file store variant (kept)
- git store: an archive write, copyEvidence and remove refuse an evidence root that is a symbolic link, and change noth... — evidence root outside clone, fileStoreAt logic; covered by the file store variant
- git store: remove deletes the evidence before the copy, so a failed evidence delete leaves the copy to find — fileStoreAt remove order; covered by the file store variant
- git store: toRecord of a backlog ledger holds the lock of the Markdown it replaces, so an edit that a writer from bef... — Markdown lock is fileStoreAt logic; covered by the file store variant
- git store: toRecord of an archive copy holds the lock of the Markdown it replaces, so an edit that a writer from befo... — Markdown lock is fileStoreAt logic; covered by the file store variant
- git store: a backlog write holds the lock of the Markdown it replaces, so an edit that a writer from before records m... — Markdown lock is fileStoreAt logic; covered by the file store variant
- git store: a backlog update holds the lock of the Markdown it replaces, so an edit that a writer from before records ... — Markdown lock is fileStoreAt logic; covered by the file store variant
- git store: a record made in place of Markdown keeps the Markdown's mode, whatever the umask — mode kept by fileStoreAt; covered by the file store variant

</details>

<details><summary><code>tests/ledger-active-store.test.ts</code> — 12 tests</summary>

**keep-e2e** (2)

- git active record lifecycle — git store active wrapper (isRepoFolder, ledger-data/active location); clone setup
- git commits and verifies active record text — git commit + checkCommitted of active record

**to-unit** (9)

- file active record lifecycle — already unit
- file active worktree lookup — already unit
- sqlite active record lifecycle — already unit
- sqlite active worktree lookup — already unit
- memory active record lifecycle — already unit
- memory active worktree lookup — already unit
- file active ignores legacy Markdown throughout a record lifecycle — already unit
- sqlite upgrades the old records CHECK and indexes active worktrees — already unit
- (unsure) storage switch previews, checks conflicts and round-trips active records — in-process: runInProcess("store","migrate",...) instead of 4x ledger() spawns; unsure: migrate exit code/stderr in-process equal to CLI

**delete** (1)

- git active worktree lookup — byWorktree passes to fileStoreAt (git-store.ts:160); covered by "file active worktree lookup"

</details>

<details><summary><code>tests/ledger-memory-store-fixtures.test.ts</code> — 5 tests</summary>

**to-unit** (5)

- backlogTask with a store writes the ledger through it, gives its location, and writes no file — already unit
- archivedTask with a store archives the copy through it, modified at noon UTC on its date, under its slug or a given name — already unit
- activeFile with a store gives the location of the active record there, and writeLedgerFile rewrites a ledger by that location — already unit
- backlogTask and archivedTask without a store still write legacy Markdown files and give their paths — already unit
- (unsure) a command run in process with a store reads the tasks seeded through it — in-process runInProcessWith + memoryStore; repository() (6 git cmds) only for setup -> use mainOf(h) like the other tests, unsure: list/show may need a repo

</details>

<details><summary><code>tests/ledger-core-repo-ids.test.ts</code> — 123 tests</summary>

**to-unit** (116)

- L88 a rerun records the alias of a ledger an earlier run moved… — `migrateRepoIds` (tools/ledger/migrate-repo-ids.ts) or IP; git-setup
- L97 a folder whose move fails gets no alias, and the run exits 1 — IP convert; chmod target; git-setup
- L110 notes left under a folder name… are not accepted — `migrateRepoIds` dry run via `plannedMoves`; git-setup
- L122 file store: backlog move onto a hard link… finishes the move — `fileStore().backlog.move` (tools/ledger/file-store.ts); no-git
- L133 file store: move between two keys kept in one repo folder… — `fileStore` move/canMove/sharesFolder; no-git
- L159 file store: archive move onto evidence the target has… refused — `fileStore().archive.move`; no-git
- L170 file store: archive move onto a hard link of the copy… — `fileStore().archive.move`; no-git
- L182 ${storage} store: move of a copy already in target, evidence left in source ×2 — file/sqlite `archive.move`; no-git
- L199 file store: archive move of a name the source lacks makes no folder — `fileStore().archive.move`; no-git
- L207 file store: move onto a name differing only in case is refused… — `fileStore().backlog.move`; no-git
- L218 file store: archive move that fails leaves copy and evidence — `fileStore().archive.move`; no-git
- L230 file store: archive move onto a different copy of same name refused — `fileStore().archive.move`; no-git
- L241 sqlite store: evidence target already has is a conflict, run goes on — sqliteStore move + IP convert; git-setup
- L257 a dry run plans a second ledger for a taken name as a conflict… — IP convert --dry-run + run; git-setup
- L272 sqlite store: a dry run without a database makes none — IP convert --dry-run
- L279 sqlite store: dry run on a database from before the alias table adds no table — IP convert --dry-run on old schema; git-setup
- L301 archive copy naming no main left ambiguous when folder fits a gone checkout — IP convert; git-setup
- L313 archive copy whose main is a path in backticks moves to that checkout's key — IP convert; git-setup; table home for rows 117-118 (main-line spellings)
- L324 active entry of a folder in no git repo… no alias, old list unchanged — IP convert
- L337 active entry whose ledger is there makes no alias… — IP convert; git-setup (worktree add)
- L346 old task list entries whose ledgers are gone… not reported, exits 0 — IP convert; git-setup
- L377 file store: a folder name with %2f is a literal folder-name key — already unit (`fileStore().backlog.repos`)
- L389 an alias whose target is no repo key is ignored… session-start says so — file aliases + IP `show` + IP `hook session-start` with input
- L404 show --repo <old folder name> reads what stayed and what moved — `shownLedger` (tools/ledger/show.ts) or IP; git-setup for key
- L415 a backlog task made in one clone starts with ledger go in another clone — IP task new + go; git-setup (clone; go adds a worktree)
- L429 store migrate --to sqlite copies the aliases — `migrateStorage` (tools/ledger/migrate.ts) direct
- L440 ledger go of a legacy backlog task naming no main ends with the hint — IP go; git-setup
- L450 file store: ...md and .md are no ledgers; .., ., empty, a/b reach no path — `fileStore` name checks; no-git
- L466 a conversion leaves an archive file named ...md where it is — IP convert; git-setup
- L477 sqlite store: an evidence path that climbs out is never written — `sqliteStore().archive.copyEvidence`; no-git
- L492 file store: backlog move onto ${kind} is refused ×2 — `fileStore().backlog.move`; no-git
- L507 file store: archive move onto a copy with the same bytes refused — `fileStore().archive.move`; no-git
- L517 file store: archive move onto evidence with the same files refused — `fileStore().archive.move`; no-git
- L530 ${storage} store: a target holding the same text is a conflict, dry run as run ×2 — IP convert ×2; git-setup
- L540 sqlite store: dry run plans evidence the target has as a conflict — IP convert ×2; git-setup
- L555 file store: a move to another disk leaves everything, no target folder — `fileStore(paths,{link,rename})` EXDEV; no-git
- L570 a conversion reports a ledger on another disk as move-by-hand — `migrateRepoIds` direct (already IP); git-setup
- L581 file store: a move that fails leaves no target folder — `fileStore` EIO injection; no-git
- L601 file store: a move refuses when a lock-less program makes the name first — `fileStore` rename/link injection; no-git
- L629 file store: a move stopped right after linking leaves ledger under both — `fileStore` link injection; no-git
- L650 file store: move failing at hidden Markdown takes its link back… — `fileStore` link injection; no-git
- L671 file store: move of a Markdown ledger refuses when a record is made first — `fileStore` injection; no-git
- L709 file store: a move holds the locks under both repos… — `fileStore` + `withLockIfFree`/`limitLockWaits` (tools/ledger/lock.ts), same process; no-git
- L742 file store: move refuses a record hiding a symlinked Markdown — `fileStore` move; no-git
- L759 file store: an evidence folder named *.md/*.json is no ledger — `fileStore().archive.list/unreadable`; no-git
- L774 a rerun files an archive copy naming no main under a saved alias — IP convert; git-setup
- L785 ${storage} store: an alias is never pointed at another key ×2 — `aliases.add`; no-git
- L794 a conversion keeps an alias naming another key, reports conflict, exits 1 — IP convert; git-setup
- L814 a backlog task named from two clones cannot be its own parent — IP task new + tree add; git-setup (clone)
- L829 a slug active in one clone names no other task in another clone — IP task new/list/tree add; git-setup (worktrees)
- L841 a path now a clone of another origin has none of the old key's tasks — IP go + retire; git-setup
- L854 ledger task archive lists copies under an alias of the repo — IP task archive --json; git-setup
- L862 ledger go starts a backlog task kept under an alias — IP go; git-setup (go adds a worktree)
- L871 ledger task retire of an aliased backlog task archives under the key — IP retire; git-setup
- L894 sqlite store: an alias row with a non-key target refuses alias writes — `sqliteStore().aliases.add`; no-git
- L911 session-start gives no hint when only the old task list uses folder names — IP hook session-start (or `conversionHint`)
- L942 ${storage} store: orphan evidence is kept: no hint, conversion exits 0 ×2 — `conversionHint` + `plannedMoves` + IP convert/session-start; no-git (no repo used)
- L956 ${storage} store: orphan evidence under an alias needs a person… ×2 — `conversionHint` + IP convert; git-setup (key)
- L974 the hint counts backlog+active with gone folder, not archive — `conversionHint` + IP convert; no-git
- L991 archive copy whose main is no git repo needs a person — `conversionHint` + IP convert; git runs on a plain folder (needed)
- L1003 archive copy on an unmounted/unreadable disk needs a person — `migrateRepoIds` dry run (already IP); no-git
- (unsure) L1029 session-start runs no git for an archive copy whose folder is gone — IP session-start with stub git on PATH; unsure: does tools/ledger/git.ts take PATH from runLedger's env or process.env? If process.env, keep-e2e
- L1041 orphan evidence beside a moving task needs a person, run and --pending — `plannedMoves` + IP convert; git-setup
- L1052 the hint names an alias conflict though the only ledger is kept — `conversionHint` + IP convert; git-setup (worktree)
- L1062 the hint reads no task list when nothing can be kept — `conversionHint` with watched store; no-git
- L1074 archive main line . or path with a note: kept or moved — `plannedMoves` + IP convert; git-setup
- L1095 migrate --to sqlite stops when the db has the alias with another key — `migrateStorage` direct
- L1137 archive copy naming no main that no record places is kept, no alias — IP convert; git-setup
- L1163 archive copy whose folder fits two checkouts stays, no alias — IP convert; git-setup
- L1171 …fits two checkouts is not moved by an alias saved before — IP convert; git-setup
- L1180 ${storage} store: a ${place} ledger whose own main is gone… ×4 — IP convert ×2; git-setup
- L1200 a folder name whose only ledger conflicts gets no alias — IP convert ×2; git-setup
- L1212 a dry run with ${what} refuses as the run does ×2 — IP convert ×2; git-setup; table home for rows 22, 56
- L1236 conversion moves evidence a stopped run left, folder is an alias — IP convert; git-setup
- L1245 evidence beside a copy moved before the alias is left by hand — IP convert; git-setup
- L1255 an alias whose target is a folder name is ignored — already unit (`fileStore().aliases`)
- L1266 tree add from another clone lists one task once; remove from either — IP tree add/remove; git-setup (clone, worktrees)
- L1282 sqlite store: evidence file under an evidence link never written through — `sqliteStore().archive.copyEvidence`; no-git
- L1299 ledger go refuses ., .. and a dot slug — IP go ×3 (or slug check fn); no-git likely (fails before repo use; unverified)
- L1310 ledger show finds a ledger under an alias, by --repo key and from checkout — IP show ×2; git-setup
- L1318 ledger task new refuses a slug an aliased backlog ledger has — IP task new; git-setup
- L1338 store migrate --to ${to} --dry-run adds no table to an old db ×2 — `migrateStorage` dry run direct
- L1352 store migrate --to sqlite that fails removes aliases it added — already unit (`migrateStorage` direct)
- L1374 a stale old task list entry is not taken for a ledger with its own entry — IP convert; git-setup
- L1385 evidence under one folder not attached to a copy moved from another — IP convert ×3; git-setup
- L1408 a folder with one conflicting and one moving ledger still becomes an alias — IP convert; git-setup
- L1421 sqlite store: evidence link under a restored link never written through — `sqliteStore().archive.copyEvidence`; no-git
- L1438 an active child named from either clone has one line under a backlog parent — IP task new/tree add/remove; git-setup
- L1454 ledger go <parent> refuses a dot-slug child, makes no worktree — IP go; git-setup
- L1466 show --repo with an alias finds its repo though two keys share the label — `shownLedger` or IP; git-setup (key)
- L1477 migrate --to sqlite --dry-run stops, like the run, when db refuses alias writes — `migrateStorage` direct, dry+run; table home for rows 70, 101
- L1492 migrate --to sqlite stops, also dry run, when the alias file is unreadable — `migrateStorage` direct (chmod 000)
- L1510 sqlite store: an evidence link name with a backslash is restored beside a link — `sqliteStore().archive.copyEvidence`; no-git
- L1528 ledger go of a backlog child names its clone in the child line — IP task new/tree add/go; git-setup
- L1540 tree add refuses a worktree child in a clone path with whitespace — IP task new/tree add; git-setup
- L1556 ledger show prefers an aliased backlog ledger to an archive copy — IP show; git-setup
- L1564 ledger show picks the newest archive copy across key and aliases — IP show; git-setup
- L1589 sqlite store: a rerun records the alias of a ledger named fix.md — IP convert; git-setup
- L1599 a rerun leaves evidence of a non-alias folder beside a copy, exits 1 — IP convert ×2; git-setup
- L1636 stray evidence whose copy is ambiguous, as ${what}… ×2 — IP convert; git-setup
- L1650 ledger go of a backlog child in one clone rewrites the other-clone line — IP task new/tree add/go; git-setup
- L1664 ledger go in one clone of a slug active in another clone fails… — IP go; git-setup; table home for row 109
- L1681 ledger show prints the worktree ledger, not an older archive copy — IP show; git-setup (worktree)
- L1688 ledger show prints the worktree ledger, not an aliased backlog ledger — IP show; git-setup
- L1715 show --repo with the short label of the clone it runs in — IP show; git-setup
- L1721 the error of show --repo of another repo names what it searched — IP show; git-setup; table home for repo-key row 26
- L1737 archive copy with relative worktree path stays, run from another repo — IP migrate --pending/--repo-ids; git-setup
- L1748 …relative worktree path moves to the alias saved for its folder — IP convert; git-setup
- (unsure) L1756 evidence of a relative-worktree copy gets no hint naming the cwd repo — IP --pending/session-start/convert; git-setup; unsure: asserts exact session-start prose — replace with doesNotMatch(key)
- L1772 a ledger whose main line is . stays and says its main is relative — IP convert; git-setup
- L1782 an old-list entry naming main . or a relative path is not filed there — IP convert; git-setup
- L1810 rollback preserves a replaced target record — `fileStore` link injection; no-git
- L1830 a writer reclaiming the source lock keeps its update — `fileStore` + same-process lock; no-git
- L1846 rollback preserves a record another mover finished moving — `fileStore` injection; no-git
- L1861 rollback takes back moved Markdown a writer turned into a record — `fileStore` injection; no-git
- L1880 rollback keeps the target Markdown when a directory replaces the source — already unit

**merge** (7)

- L364 file store: a damaged alias map makes an alias write fail… — into row 76 (L1212 "a dry run with ${what} refuses as the run does") damaged-map row; add its aliases.add-throws + file-unchanged asserts
- L882 file store: alias map with a non-key target refuses writes, moves nothing — into row 76 (L1212) non-key-target row; add aliases.add-throws + file-unchanged asserts
- L1112 migrate --to sqlite stops before copying when db refuses alias writes — into row 94 (L1477 "--dry-run stops, like the run, when the database refuses alias writes"); add its nothing-copied assert
- L1574 migrate --to sqlite stops when db refuses alias writes, files hold none — into row 94 (L1477) as a table row (file alias present / absent)
- L1698 ledger go… whose active task was in a removed clone fails… — into row 106 (L1664) as table row (other clone present / removed)
- L1794 a ledger whose main line has one stray backtick is filed under that key — into row 18 (L313) table of main-line spellings
- L1802 a ledger whose main line is under ~ is filed under that key — into row 18 (L313) table of main-line spellings

</details>

<details><summary><code>tests/ledger-core-repo-key.test.ts</code> — 37 tests</summary>

**keep-e2e** (1)

- L113 a partial clone's key is its origin's, though git lists the filter after — depends on real `git` remote listing format; the one real-git repoKey test

**to-unit** (28)

- L46 the remote ${url} is the repo github.com/chrfalch/ledger ×9 — already unit (`remoteKey`)
- L86 the remote ${url} gives no key… ×13 — already unit (`remoteKey`)
- L99 the remote ${url} is the repo ${key} ×15 — already unit (`remoteKey`)
- L106 a repo's key is its origin's address, even with other remotes — `repoKey` (tools/ledger/repo-key.ts) with `remoteUrls` stubbed; table home for rows 3, 7-10
- L150 task new in a linked worktree files under the repo's key — IP task new; git-setup (worktree → main)
- L170 the repo ${key} is shown as ${label} ×5 — already unit (`repoLabel`)
- L175 ledger list shows the short label in repo column and parent cell; full key in JSON — IP list + list --json; git-setup (cwd repo)
- L192 ledger task archive --all shows the short label — IP + memoryStore
- L201 file store keeps a repo in one URI-encoded folder; repos() gives the key back — already unit (`fileStore`)
- L215 file store reads an old folder-name key folder — already unit
- L231 ${storage} store: backlog ledger moves to another key with text and times ×2 — already unit
- L248 ${storage} store: archive copy moves with its evidence ×2 — already unit
- L268 ${storage} store: aliases none at first; added alias reads back ×2 — already unit
- L284 an archive copy naming no main, under an alias, is in that repo — `archivedTasks`/`inRepo` (tools/ledger/tasks.ts) already direct; git-setup for repoKey
- L309 show --repo takes the full key — already unit (`shownLedger`)
- L315 show --repo takes an alias — already unit
- L320 show --repo takes the short label when one repo has it — already unit
- L325 show --repo with a shared label fails and names both keys — already unit
- L333 show --repo refuses .. — already unit
- L406 ${storage} store: migrate --repo-ids --dry-run prints planned moves, changes nothing ×2 — IP (or `migrateRepoIds` dry run); git-setup
- L422 ${storage} store: migrate --repo-ids moves each resolvable ledger, evidence, alias ×2 — IP; git-setup; table home for row 29
- L452 ${storage} store: after migrate, show --repo <old folder> finds moved ledger ×2 — IP convert + show ×2; git-setup
- L466 migrate --repo-ids exits 0, also dry run, when all or none convert — IP ×5; git-setup
- L499 session-start says once how to convert when folder names remain — IP `hook session-start` with input; git-setup (worktree)
- L506 session-start gives the hint also with no ledger — IP session-start; git-setup
- L511 session-start gives no hint when no folder names remain — IP session-start ×2; git-setup
- L517 go and show that find no task add the hint — IP go + show; git-setup; table home for row 36
- L533 store migrate takes --to or --repo-ids, not both and not neither — IP (argument parsing); table home for every migrate flag-conflict test (migrate-records L163, active-migrate "takes no --to…", core-migrate "without --to")

**merge** (8)

- L91 a repo whose origin gives no key has its main checkout's path as key — into row 5 as a table of remotes → key (`repoKey` with stubbed `remoteUrls`)
- L122 no origin, one remote → that remote's key — into row 5
- L129 no origin, two remotes → main path — into row 5
- L136 no remotes → main path — into row 5
- L143 origin a local bare repo → its path without .git — into row 5 (remoteKey side already in row 4 `/srv/git/app.git`)
- L340 the error of ledger show names the repo by its short label — into ledger-core-repo-ids.test.ts L1721 "the error of ledger show --repo of another repo names what it searched" (same message; table: from cwd / --repo)
- L442 ${storage} store: a second migrate --repo-ids changes nothing ×2 — into row 28 (append rerun + snapshot equality, as migrate-records does)
- L527 go and show that find no task give no hint without folder names — into row 35 as table row (legacy on/off)

</details>

<details><summary><code>tests/ledger-stored-repo-of.test.ts</code> — 1 tests</summary>

**to-unit** (1)

- storedRepoOf prefers the main a ledger names over a parent child line's — already unit (`storedRepoOf`, tools/ledger/tasks.ts)

</details>

<details><summary><code>tests/ledger-core-migrate.test.ts</code> — 25 tests</summary>

**keep-e2e** (2)

- L471 migrate --to sqlite --dry-run without node:sqlite exits 1… — needs a real process with node:sqlite hidden (`ledgerIn(withoutSqlite)`); seed directly instead of `populated()`
- L478 migrate --to file from SQLite without node:sqlite exits 1… — same; seed directly

**to-unit** (21)

- (unsure) L117 migrate ${from} → ${to} copies every ledger and evidence bytes, switches setting ×2 — IP migrate/list/show; unsure: `show --evidence` asserts raw binary stdout (spawnSync Buffer) — IP `Ran.stdout` is a string; keep one e2e if IP cannot carry bytes
- L141 migrate keeps the symbolic link and folders of the evidence ×2 — `migrateStorage` direct (tools/ledger/migrate.ts)
- L160 migrate --remove-source removes every copied ledger from the source ×2 — IP migrate + show
- L176 migrate exits 1, changes nothing, when target holds a name (even identical) ×2 — IP / `migrateStorage` Failure
- L195 migrate --dry-run prints the plan and changes nothing ×2 — IP
- L208 migrate when setting already names target copies and says unchanged ×2 — IP
- L218 migrate with a --to that is neither file nor sqlite exits 1 — IP (argument parsing)
- L300 migrate exits 1 when ${what}, removes copies, keeps setting/source ×6 — `migrateStorage` direct (already IP); swap `populated()` for store seeding
- L318 migrate keeps an archive copy another command wrote under the same name ×2 — `migrateStorage` direct; seeding
- (unsure) L335 migrate keeps a same-text copy another command wrote when its own write fails ×2 — `migrateStorage` direct; unsure: `writeArchiveElsewhere` spawns a second node process to write — a second store connection in-process is likely equivalent, unverified for sqlite
- L347 --remove-source finishes when a source copy was removed meanwhile ×2 — `migrateStorage` direct; seeding
- L369 --remove-source keeps a backlog ledger changed after the copy ×2 — `migrateStorage` direct; seeding
- L394 exits 1 when a backlog name is taken in target after the check ×2 — `migrateStorage` direct; seeding
- L413 rolls back but keeps a backlog copy changed after the copy ×2 — `migrateStorage` direct; seeding
- L432 --remove-source keeps records hiding Markdown, says so ×2 — `migrateStorage` direct; seeding
- L448 rolls back but keeps a copy whose record hides Markdown in target ×2 — `migrateStorage` direct; seeding
- L486 --remove-source neither copies nor removes the old task list — IP
- L497 migrate copies an empty evidence folder as an empty folder — already unit (`migrateStorage` direct)
- L511 store migrate names the storage it copies from on its first line — IP ×2
- L520 --remove-source withholds a secret-like ledger name — `migrateStorage` direct; seeding
- L548 --remove-source keeps an archive copy whose ${what} changed after the check ×2 — `migrateStorage` direct; seeding

**merge** (1)

- L154 migrate without --remove-source leaves the source as it was ×2 — into row 1 (add `withStore(from) == source` assert)

**delete** (1)

- L225 migrate without --to exits 1 — covered by ledger-core-repo-key.test.ts L533 "store migrate takes --to or --repo-ids, not both and not neither" (kept, to-unit)

</details>

<details><summary><code>tests/ledger-core-migrate-records.test.ts</code> — 8 tests</summary>

**to-unit** (6)

- L73 ${storage} store: migrate --records --dry-run names each Markdown ledger… ×2 — IP on temp-HOME file/sqlite store (no git used)
- L85 ${storage} store: migrate --records rewrites each Markdown ledger as a record… ×2 — IP ×2
- L103 ${storage} store: a task kept as record and Markdown is a conflict, exits 1 ×2 — IP ×2
- L116 ${storage} store: --dry-run fails as the conversion does on an unstable record ×2 — IP ×2
- L134 ${storage} store: ledger show prints a Markdown backlog ledger as its record ×2 — IP show
- L140 sqlite store: --records --dry-run on a pre-records db adds no table — IP

**merge** (1)

- L152 migrate --records takes no --to, --from, --repo-ids or --remove-source — into ledger-core-repo-key.test.ts L533 as rows of one flag-conflict table

**wording** (1)

- L163 ledger store migrate --help shows the --records example — structural: one test that `store migrate --help` names each mode (--to, --repo-ids, --records, --active); merge with active-migrate help test

</details>

<details><summary><code>tests/ledger-active-migrate.test.ts</code> — 23 tests</summary>

**keep-e2e** (1)

- L60 git store: (same) — the one active-migrate run on the real git store (LLP keeps git store real)

**to-unit** (16)

- L60 file store: migrate --active moves .claude/ledger.md into an active record… — IP or `migrateActive` direct (tools/ledger/migrate-active.ts); git-setup
- L60 sqlite store: (same) — IP; git-setup
- L87 file+sqlite store: migrate --active --dry-run names each ledger, changes nothing ×2 — IP; git-setup
- L101 file+sqlite store: leaves a ledger whose slug or worktree is taken, exits 1 ×2 — IP ×2; git-setup
- L127 file+sqlite store: turns the parked marker into the record's status ×2 — IP (or `parseRecord` on the converted text); git-setup
- L139 finds worktrees of every main the old task list names, from outside any repo — IP; git-setup
- L172 ${storage} store: --dry-run from HOME finds repos only the old list / a stored task names ×2 — IP; git-setup
- L189 a task list read leaves the old list as it was; migrate from another repo still moves — IP list + migrate; git-setup
- L202 never moves a main checkout's own .claude/ledger.md — IP; git-setup
- L214 leaves a ledger whose heading names no slug — IP; git-setup
- L248 keeps a .claude/ledger.md that changed after its record was written — already in-process (`migrateActive` direct); git-setup
- L270 keeps a ledger whose lock a writer holds after the record is committed — already in-process; same-process lock; waits ~2 s on `limitLockWaits(now+2000)` — a shorter limit cuts it
- L290 keeps a ledger whose record the store could not commit — already in-process; git-setup
- L308 file store: a rerun after one that wrote the record but kept the file removes the file — IP; git-setup
- L324 --dry-run reports the second of two same-slug ledgers as left, as the run does — IP ×2; git-setup
- L344 leaves a ledger an old entry names in a folder that is no linked worktree — IP; git-setup

**merge** (1)

- L224 migrate --active takes no --to, --from, --repo-ids, --records or --remove-source — into ledger-core-repo-key.test.ts L533 flag-conflict table

**wording** (1)

- L233 ledger store migrate --help shows the --active example — structural: merge into the one "migrate --help names each mode" test (see migrate-records row 8)

**delete** (4)

- L87 git store: --dry-run… — covered by row 4 (dry run is store-agnostic)
- (unsure) L101 git store: (same) — covered by row 6; unsure: conflict check reads git-store active index — covered only if row 3 exercises it
- L127 git store: (same) — covered by row 8 (parse is store-agnostic)
- (unsure) L308 git store: (same) — covered by row 20 + row 3; unsure: git store `write` then rerun path may differ (commit)

</details>

<details><summary><code>tests/ledger-core-retire.test.ts</code> — 114 tests</summary>

**keep-e2e** (12)

- no slug retires worktree task: archive copy, worktree gone, branch deleted — canonical real `git worktree remove` + `branch -d` path
- runs again after git could not remove the worktree — real git lock/remove failure + rerun; also carries #101
- names its own bin/ledger, quoted, when its path has a space — real bin/ledger from a copied checkout (ledgerBin resolution)
- refuses uncommitted changes without --force; --force retires — real dirty count + forced `git worktree remove`; #75 merges in
- refuses unmerged branch; --force retires and keeps branch — real ahead count + branch kept
- (unsure) merged PR ending at HEAD counts as merged; branch deleted — unsure: decision is `isMerged` (R:200, to-unit), but only test that deletes a branch git sees as unmerged
- fetches the default branch first — real git fetch; #36 merges in
- --dry-run prints plan and changes nothing, blockers included — the one whole-HOME snapshot dry run of a worktree task (git side effects); plan text itself to-unit `planView`
- deletes the whole cc-dd-path build folder, no other — contract with real bash `bin/cc-dd-path`
- moves own build folder to trash, deletes without waiting — detached background rm; stub rm sleeps 8 s (not awaited)
- (unsure) asks gh for default branch when origin/HEAD unset — `defaultBranchOf` (R:342) reads real origin/HEAD; #66, #86 merge in. unsure: no git seam, else to-unit
- (unsure) abandon of detached HEAD with unmerged commits needs --force — unsure: only test of detached HEAD read from git; blocker logic itself to-unit planRetire

**to-unit** (71)

- names the archive copy after the ledger title — `archiveName` via `planRetire(facts)` (R:207)
- adds -2 when the day already has a different copy — `archiveFacts` archiveNameTaken (R:594); table with #29
- finds an identical copy already in the archive, archives once — `archiveFacts` alreadyArchived; removal covered by #2
- copies .claude/evidence next to the archive copy — in-proc archive.write with evidence
- refuses, even with --force, rerun whose worktree got more evidence — `losesEvidence` (R:771) / planRetire blocker; seed archive+evidence directly instead of retiredOnceLocked; table with #9, #10, #102
- a folder is within itself and its ancestors… — already unit (tests the test helper `isWithin`)
- (unsure) package folders of a checkout stop at its main checkout — tests test helper `packageFolders`; needs `git init` only, not repository(). unsure: whether helper self-tests are wanted
- (unsure) package folders of a worktree outside main are its own — same as #12. unsure: same
- stops with message, no stack trace, when archive copy cannot be written; retires once fixed — in-proc with store whose archive.write throws (like #99); stderr check works in-proc
- refuses an evidence file it cannot read; dry run names it — `evidenceProblem` (R:432, not exported) on tmp dir + planView
- archives a relative symlink in evidence as the same link — file-store evidence copy (`treeEntries`, tools/ledger/files.ts) on tmp dir
- refuses .claude/evidence that is itself a symlink — `evidenceProblem` table
- refuses link that leaves the folder, dangling or not — `evidenceProblem` table
- refuses evidence it cannot read: folder or subfolder — `evidenceProblem` table (mode 000); #28 merges in
- refuses link whose text leaves though it lands inside — `textLeaves` (R:406) table; #22, #23 merge in
- refuses link to the evidence folder itself — `evidenceProblem` loop table; #25 merges in
- refuses evidence holding a FIFO, before copying/removing — `evidenceProblem` + planRetire blocked
- refuses .claude/evidence that is not a folder — `evidenceProblem` table
- lists every reason together when dirty and unmerged — `refusal` (R:663) via planRetire(facts)
- merged PR ending at another commit needs --force — `isMerged` / `mergedPr` (R:720) facts
- warns when gh cannot tell about PRs — in-proc; `branchState` warning (R:357)
- warns (dry run too) when installed ledger links into worktree — `installedLinksWarning` (R:979), fs only; #39 merges in
- --dry-run of a parent lists active children — `planView` + `parentActions` (R:216), in-proc
- backlog task archives+deletes ledger, never asks git or gh — in-proc memoryStore
- stops when backlog ledger cannot be deleted — in-proc, backlog.remove throws
- refuses parent with active children; --force retires — `childStatus` (R:192) / planRetire; #46, #76 merge in
- child status from disk: archived without mark does not block — `childStatus` in-proc
- marks child retired in parent, copies report, finalize hint — `markRetired`/`putChildReport` (tools/ledger/edit.ts) + parentActions in-proc; #89 merges in
- keeps hand-written suffix; no hint while sibling active — `markRetired` pure
- marks child retired in a parent in another repo — in-proc, two repo keys
- only warns when parent not found — in-proc
- resolves no slug in main, unknown slug, shared slug to messages — `findTarget` (R:380) table; #72, #81 merge in
- refuses the main checkout — `findTarget`/readRetire
- ownXcodeFolders is <main>/.claude/worktrees/.build/<name> — `ownXcodeFolders` (W:76), already in-process; git setup only
- deletes no build folder, warns, when .build or above is a symlink — `linkAboveBuildFolders` (W:40); 3 full setups today
- keeps build folder of case-shared worktree name, warns — `xcodeFolderOf` (W:51), in-proc
- never takes archive <name>.md symlinked to live ledger — file-store archive / `archiveFacts`, tmp dir
- stops, keeps worktree, when ledger changes after archive copy — already in-process `executeRetire`; swap fileStore for memoryStore
- stops, keeps worktree, when evidence changes after copy — already in-process `stopIfChanged` (R:791)
- stops, keeps backlog ledger when it changes after copy — already in-process; #62 merges in
- leaves active ledger when it changes after worktree removed — already in-process; real worktree removal is setup
- refuses parent whose child has no ledger anywhere — `childStatus` 'missing' via planRetire
- asks gh for merged PRs by head, state, limit ≥1000 — in-proc with recording gh stub
- --dry-run --json names open PR; none once merged — in-proc with gh stub
- abandon refuses missing, empty or multi-line --reason — in-proc CLI validation table; #105, #106 merge in
- abandon of unmerged branch without --force, keeps branch — planRetire verb abandon (no unmerged blocker); branch kept covered by #31
- abandon writes "<date> abandoned: <reason>" to notes — `withAbandonNote` (R:134)
- abandon of a backlog task archives with reason — in-proc memoryStore
- abandon --dry-run prints plan; unmerged no blocker, kept — planRetire + `planView` (R:739); #78 merges in
- abandon refusals say "Not abandoned:" and abandon anyway — `refusal` (R:663) pure; #107 merges in
- abandon names rerun with slug and quoted reason — `commandLine` (R:107) pure
- abandon --force of task on another machine — planRetire host blocker, in-proc (no git needed); #83 merges in
- abandon --dry-run: needs --force and cannot even with — `planView` pure
- abandon outside a repository names command to run — in-proc, no repo needed
- abandon rerun after failure adds no second note — `ownNotes` (R:125) + alreadyArchived; seed directly instead of git lock
- abandon --dry-run lists the note as first step; refused adds none — planRetire steps / `stepText` (R:684)
- abandon adds no note when ledger changes after read (backlog) — already in-process; repository() setup only
- abandon … when an active ledger changes after read — already in-process
- abandon … when another session claims after plan — in-process; replace spawned `task claim` with in-proc
- abandon of parent that gains a child link after read — in-process; rerun spawn → in-proc; #97 merges in
- abandon archives the ledger it read though goal changed and back — in-process revision check; git lock only to stop removal
- abandon adds note before archive: failed archive write — already in-process
- abandon finishes a retire that removed the worktree — in-proc; `removedWorktreeOf` (R:486); #101 merges in
- abandon note goes to parent's notes though child report has abandoned: — `ownNotes`/`withAbandonNote` pure on text; #104 merges in
- retire --repo archives backlog task with no checkout, no git/gh — in-proc memoryStore (`readRetireIn`, R:556)
- retire --repo takes repo key; records in parent of other repo — in-proc
- retire --repo --dry-run prints plan, changes nothing — in-proc
- retire --repo refuses active task, points to repair --lost — in-proc
- retire --repo names unknown repo / slug — in-proc
- retire --repo refuses parent whose live child names no main — in-proc
- retire --repo marks parent of child that names no main — in-proc

**merge** (28)

- refuses identical archive copy without evidence while worktree has some — into #8 (same "evidence differs" blocker)
- quotes the archive name as one shell word in show command — into #8 (row with spaced name; `remedy`/`shellWord`)
- refuses subfolder link whose text steps above and back in — into #21
- archives subfolder link that steps up only inside — into #21 (accepted row); copy covered by #17
- refuses link to any folder that holds it — into #24 (loop-link table)
- refuses evidence in folder it can list but not search — into #20 (mode 444 row)
- never attaches leftover evidence folder: takes next -N — into #4 (name-taken table: .md vs folder)
- warns when the fetch fails, decides on old origin/main — into #35 (fetch ok / fetch fails)
- no warning when links point elsewhere or nowhere — into #38
- backlog parent with active child refused too — into #44
- keeps backlog ledger when it changes between check and removal — into #61 (moment table)
- guesses main with warning when neither names default — into #65
- abandon with no slug abandons task of its worktree — into #51 (findTarget by cwd)
- abandon refuses uncommitted changes; --force abandons — into #30 (verb row)
- abandon refuses parent with active children; --force — into #44
- abandon --dry-run names uncommitted changes as blocker — into #77
- abandon names abandon in its slug hints — into #51
- abandon --force of a lost task — into #82
- abandon says abandon guesses main — into #65 (verb row)
- abandon of a child marks it retired in parent — into #47
- abandon adds note to live ## Notes before archiving — into #99 (note before archive)
- … gains child link and another abandon note — into #96
- abandon after retire that could not remove worktree — into #100 (reason-not-saved) + real path in #7
- abandon after retire refuses when evidence differs — into #8 (verb row)
- abandon note goes to parent's own ## Notes — into #103
- abandon refuses reason with line break before/after — into #70
- abandon with empty reason names own bin/ledger — into #70
- abandon says "Not abandoned:" when active children stop it — into #79

**wording** (2)

- retire --help names the slug, --dry-run and --force — structural: in-proc help lists `retire` + options; fold #69 in
- task --help lists abandon; its help names options — structural; merge with #1 into one help check

**delete** (1)

- abandon deletes a branch that is merged — covered by #2 (same delete-branch step)

</details>

<details><summary><code>tests/ledger-core-worktrees.test.ts</code> — 23 tests</summary>

**keep-e2e** (3)

- worktrees shows each linked worktree: last commit, dirty, role, PR — real git worktree list/log/status feed `listWorktrees` (W:185)
- prune --dry-run lists ignored build folders >0.05 GB; prune deletes — real du + git ignored-file listing; writes 220 MB
- prune-orphans --dry-run lists orphans only; then deletes — real git worktree list + delete

**to-unit** (17)

- shows ? for a PR gh cannot look up, says why — `worktreesView` (W:212) prError, pure
- prune exits 1, deletes nothing, when .build or above is a symlink — `linkAboveBuildFolders` (W:40) + `pruneReport`; 3 setups × 55 MB today; #19 merges in
- prune keeps build folder of case-shared name or .main — `xcodeFolderOf` keptBecause, in-proc
- prune skips worktree's .build folder that is a symlink — `pruneWorktrees` (W:333) safety check, in-proc, du stub
- prune never deletes an ignored build folder that is a symlink — same module as #7, other path; in-proc
- prune exits 1 when a folder could not be deleted, prints report — `pruneReport` (W:354) failed flag
- prune --all --dry-run covers every worktree; nothing to prune — `pruneReport` below-floor
- prune refuses unknown name, name with --all, neither — in-proc CLI validation
- prune-orphans from a linked worktree prunes its repo — `pruneOrphans` (W:471) in-proc; main-from-worktree resolution
- prune-orphans keeps folder of worktree git lists while missing — `pruneOrphans` in-proc (porcelain listing)
- prune-orphans skips orphan that is a symlink — `pruneOrphans` in-proc
- (unsure) prune-orphans exits 1, deletes nothing, when git cannot list — in-proc with stub git on PATH. unsure: that in-process git runs pick up `env` PATH from runInProcessWith
- (unsure) prune-orphans stops when git cannot list again before a delete — in-proc with counting stub git (same unsure as #17)
- prune-orphans keeps folder differing from worktree only in case — `pruneOrphans` in-proc
- prune-orphans with no/only live build folders: nothing to prune — `pruneOrphans` in-proc
- deleteInBackground warns when background rm cannot start — already unit (direct call); drop needless repository() setup and fixed 300 ms wait
- worktrees outside a git repository says so — in-proc

**merge** (1)

- prune-orphans exits 1 when .build or above is a symlink — into #5 (table: prune / prune-orphans × 3 links)

**wording** (1)

- worktrees --help names table and subcommands — structural: subcommands named, no derived-data; in-proc

**delete** (1)

- worktrees derived-data is gone — dead-feature guard; covered by #1 (`doesNotMatch derived-data`, kept as structural)

</details>

<details><summary><code>tests/ledger-task-done.test.ts</code> — 12 tests</summary>

**to-unit** (11)

- marks the active task of the worktree done when no PR — in-proc memoryStore; drop git setup
- takes a slug, or <slug>@<path> from outside the repo — in-proc
- --json prints task, ledger and finalize command — in-proc
- refuses parked, blocked, lost or done task — move check, table; #8 merges in
- marks done a task whose PR gh says merged (waiting/active) — in-proc, gh stub
- refuses a task whose PR is not merged — in-proc, gh stub
- refuses a task with a PR when gh cannot say — in-proc, gh stub
- refuses a backlog task — in-proc
- outside a task, with no slug, says to name one — in-proc; no repo needed
- refuses when PR link changes while gh is asked — in-proc; gh stub edits record (keep stub, or a gh seam)
- does not ask gh about a task of another machine — in-proc

**merge** (1)

- does not ask gh about a task with a PR that cannot become done — into #4 (add PR bullet + gh-calls assert to table)

</details>

<details><summary><code>tests/ledger-task-list.test.ts</code> — 6 tests</summary>

**to-unit** (4)

- file store: list, a write and session start cache no task list — in-proc (`list`, `task new`, `notes note`, `hook session-start` via runInProcessWith); 4 spawns now
- sqlite store: … cache no task list — in-proc; keeps sqlite `registry` rows = 0 check
- (unsure) git store: … cache no task list — in-proc on local clone (no remote). unsure: LLP keeps git store real-process; behaviour here is store-agnostic
- file store: list --json gives design refs as ledger names them — list JSON row builder; in-proc memoryStore

**merge** (2)

- (unsure) sqlite store: list --json design refs — into #4. unsure: assumes shared store-contract tests cover text round-trip
- (unsure) git store: list --json design refs — into #4. unsure: same as #5

</details>

<details><summary><code>tests/ledger-pending-moves.test.ts</code> — 11 tests</summary>

**to-unit** (10)

- --pending --json lists every move in order, changes nothing — in-proc `store migrate --pending`
- --pending marks a move that would leave with the reason — in-proc
- --pending lists needs-a-person, then finished tasks under gone folder — in-proc
- --pending with only finished tasks under gone folder — in-proc (no git today)
- --pending with nothing to move — in-proc
- sqlite: --pending without a database makes none — in-proc
- --pending takes none of the other migrate flags — in-proc CLI option conflicts; 7 spawns now (~7 s)
- each migration reports same moves in dry run as real run — direct calls `migrateRepoIds`/`migrateActive`/`migrateRecords`; only git setup is slow
- --pending lists no --repo-ids move for entry without own ledger — in-proc
- file store: move onto another disk is no automatic move — direct `migrateRepoIds` with fileStore seams; only repository() is slow

**delete** (1)

- --pending prints one line per move, grouped by kind — covered by #4 (its first 6 expected lines are exactly #2's)

</details>

<details><summary><code>tests/ledger-core-write.test.ts</code> — 97 tests</summary>

**keep-e2e** (5)

- L202 task --stack makes the worktree and branch at once, on top of the current branch — real git worktree+branch on current HEAD; could still drop bin spawn via runInProcess
- L244 go moves a backlog ledger into a new worktree and branch from the default branch — the one real `go` worktree-creation test (startWorktree/promote)
- (unsure) L316 go removes the new worktree and branch again when a later step fails — rollback of real git worktree/branch; unsure: could be in-process with a store whose backlog remove throws instead of chmod
- L1224 task --repo prints the start command and it promotes the task from here — runs the printed command through real `sh`; absorbs L143, L1237, L1246 as table rows
- L1254 task --repo shell-quotes a path with a space or quote — real `sh` parses the quoting (shellWord); one spawn chain

**to-unit** (81)

- L77 task refuses a slug the creation rule does not accept — slug creation rule; in-process `task new` (createTask, tools/ledger/write.ts)
- L85 task writes a backlog ledger from the template and prints the start line — in-process; createTask + createdText
- L93 a ledger is filled only with an absolute main checkout — already unit (fillLedger, tools/ledger/edit.ts)
- L100 task in a repo with llp/ writes "design refs: none"; goal placeholder — in-process; readTemplate/createTask
- L109 task refuses a slug that has a backlog ledger, a branch or a worktree folder — in-process (checkTarget/refuseBacklog); git branch only as setup
- L121 task fails when the template is missing — in-process; readTemplate
- L128 task from a worktree with a ledger adds one Decisions line — in-process; createTask noted line
- L156 task from the main checkout leaves every other ledger alone — in-process
- L164 task --here adds a ledger to the current linked worktree — in-process (hereTask); worktree made by git as setup
- L190 task --here refuses main checkout, worktree with ledger, --stack, --repo — in-process; hereTask refusals
- L227 task --stack on a detached HEAD fails and makes nothing — in-process; detached check, git as setup
- L235 task --repo writes the backlog ledger of another repo — in-process
- L267 go --repo promotes a cross-repo child in its own repo — in-process (goTask cross-repo resolution); worktree creation covered by L244
- L282 go refuses missing (2), same-named repo (3), no main line (4) — in-process (runLedger returns code); refuseMissing
- L298 go starts a backlog task whose main line is . — in-process
- L307 go fails when the branch exists — in-process; checkTarget
- L337 go starts an old-rule slug, refuses a non-slug — in-process; slug reading rule
- L346 parent add takes child as <slug>@<relative path> — in-process; changeParent path resolution
- L358 go starts from the base a backlog ledger names — in-process (base selection in goTask); real repo as setup
- L374 park writes one status line; park again replaces; unpark restores bytes — in-process + fakeClock; parkTask/unparkTask
- L389 park/unpark on a CRLF Markdown backlog task — in-process with fileStore (legacy Markdown read)
- L400 legacy Parked: marker rewritten by next write; unpark removes it — in-process; format.ts legacy marker
- L423 park requires a reason — in-process; parkTask
- L432 a later "Parked:" note under Next step is no marker — in-process; format.ts
- L442 park without ## Next step; unpark of not-parked changes nothing — in-process
- L456 park and unpark of an unknown slug fail — in-process; liveTask
- L462 park refuses blocked, waiting, done, lost; names states — checkTransition (tools/ledger/states.ts) table + in-process per command
- L481 block writes blocked line, keeps claim; unblock restores bytes — in-process + fakeClock; blockTask/unblockTask
- L497 block requires --on — in-process
- L506 unblock of not-blocked task says so, exits 0 — in-process
- L540 task pr records link, stage pr, waiting — in-process + fakeClock; recordPr
- L553 task pr --task, --json — in-process
- L561 task pr stores link without slash, query, fragment — pure: prLink (tools/ledger/write.ts; export it)
- L570 task pr on a waiting task replaces the link — in-process
- L582 task pr refuses anything but a GitHub PR link — pure: prLink table
- L620 task pr refuses backlog, other machine, retired — in-process
- L632 task pr sets stage pr only for a kind that has it — checkPrLink/STAGES (states.ts, kinds.ts) + in-process
- L645 task pr outside a task worktree without --task — in-process
- L650 go to a blocked task leaves its status line — in-process
- L658 parent add same repo; remove restores both byte for byte — in-process; changeParent
- L673 parent add keeps a line with an unknown suffix — in-process
- L685 parent add of a child in another repo writes both mains — in-process (two repos for repo keys)
- L699 parent add refuses self, other parent, cycle, retired; remove unlinked — in-process; addChildTask/ancestors
- L719 parent start marks a child started, keeps unknown suffix — in-process + fakeClock; startChildTask
- L736 parent next prints the chain to first backlog child — nextToStart (write.ts) / in-process
- L755 parent next offers a backlog child marked started — nextToStart
- L763 parent next passes over a child whose children are all started/retired — nextToStart
- L785 tree add gives the order after the highest sibling — numberSiblings/sortChildLines, in-process
- L798 tree add numbers unordered children first — numberSiblings
- L810 tree add leaves alone a sibling with another parent — in-process
- L827 tree add keeps the line of a child of another parent in place — sortChildLines
- L840 tree add keeps a retired child of another parent in place — sortChildLines
- L853 tree add keeps another parent's line at its index — sortChildLines
- L865 tree add of an already listed child changes no order — in-process
- L875 tree order numbers each child 1..n, sorts lines and tree show — orderChildren, in-process
- L891 tree order on a backlog parent keeps prose once — orderChildren / format.ts
- L902 tree order treats a sentence bullet as prose — format.ts child-line parse
- L914 tree add on a backlog parent keeps prose after child lines — sortChildLines
- L925 tree order refuses a child of another parent — orderChildren
- L941 tree order refuses left out / added / repeated — orderChildren
- L953 tree order refuses a child active on another machine — refuseElsewhere
- L964 tree depends sets deps by slug, path, address; none clears — setDependencies + dependsText, in-process
- L978 tree depends takes URL or scp form — pure: remoteKey (tools/ledger/repo-key.ts) / dependencyFrom
- L986 tree depends refuses non-slug and keyless address — dependencyFrom
- L996 tree depends takes a stored repo key unchanged — dependencyFrom/isRepoKey round-trip
- L1007 tree depends takes back keys with port, IPv6, + — pure round-trip table
- L1025 tree depends takes a stored path key whose checkout is gone — dependencyFrom/repoAfterAt
- L1033 tree depends refuses a URL that would not read back — dependencyFrom
- L1043 tree depends refuses an address that is a folder here — dependencyFrom (fs setup only)
- L1061 tree depends refuses a checkout whose remote gives a bad key — repoKey of a checkout; git remote as setup
- L1073 tree depends refuses self, cycle, cross-repo cycle, non-folder — dependencyPath
- L1090 tree next picks first child whose deps are done — firstToStart/nextToStart
- L1104 tree next counts a dependency done only by status done — firstToStart
- L1118 tree next finds a done dep in a repo without remote — in-process; repoKey of path repo (git as setup)
- L1131 nextToStart with a store-only repoOf — near-unit already (direct call); drop git fixture, seed memoryStore
- L1146 tree next with every child waiting prints nothing, stderr reasons — waitingLines + in-process
- L1159 tree ready prints every startable chain — startable (write.ts)
- L1173 tree ready leaves out a child until its dep is retired — startable + runningLines
- L1189 tree ready with none prints nothing, stderr reasons — waitingLines/runningLines
- L1200 go on a parent starts its first ready child — in-process (goTask chain); worktree creation covered by L244
- L1267 parent next and parent start ignore a prose bullet — nextToStart/startChildTask

**merge** (10)

- L143 task --repo from a worktree names the task in the other repo with a start command — into L1224 'ledger task --repo prints the start command the Decisions line names…' (same Decisions line; add exact-line assert)
- L182 task --here <slug> takes the slug given — into L164 (table: no slug / given slug)
- L414 unpark leaves a status that is not parked — into L442 (table: no status / blocked status)
- L516 block refuses parked, waiting, done — into L462 (table: command × state over checkMove/checkTransition)
- L532 block and unblock of an unknown slug fail — into L456 (table over park/unpark/block/unblock)
- L601 task pr refuses parked, blocked, done, lost — into L462 (same move-check table)
- L1018 tree depends takes a key with trailing slash — into L1007 (one more row of the round-trip table)
- L1053 tree depends refuses an @ with no repo — into L986 (refusal table)
- L1237 task --repo from a main checkout prints a start command that works there — into L1224 (table: from worktree / from main)
- L1246 task --repo naming this repo keeps the short start command — into L1224 (table row: same repo)

**wording** (1)

- L54 ledger --help lists the writing commands, and each has its own --help — structural: command named + option names; merge into tests/ledger-core-cli.test.ts 'each command has --help with its arguments and options' (same table shape); 11 spawns today

</details>

<details><summary><code>tests/ledger-notes.test.ts</code> — 67 tests</summary>

**keep-e2e** (2)

- (unsure) L586 writes at the same time all land, each holds the record lock — 5 real processes + LEDGER_TEST_DELAY_MS; unsure: may duplicate tests/ledger-core-concurrency.test.ts '…ledger parent add runs at once on one parent list every child' (same lock,…
- L614 ${storage} store: every write command changes a backlog task (×3: file, sqlite, git) — keep only the git instance (real git store); file and sqlite instances → to-unit in-process with fileStore/sqliteStore passed as `store`

**to-unit** (57)

- L64 plan add appends a todo step, from a subfolder, prints its number — addStep (tools/ledger/notes.ts), in-process (cwd subfolder resolution)
- L81 plan add refuses missing/empty owner, empty step, non-round-trip — addStep
- L91 plan approve sets the approval date to today — approvePlan + fakeClock
- L99 plan summary sets the line under the plan heading — setPlanSummary
- L109 plan summary refuses empty, multi-line, >2 sentences — setPlanSummary
- L118 step sets status, note, or both — setStep
- L135 step refuses no option, empty status, unknown step, bad note — setStep
- L146 decide appends a dated, tagged decision — addDecision + fakeClock
- L154 decide refuses missing reason/tag, unknown tag, empty text — addDecision / cli option parse in-process
- L165 constraint appends with source and tag — addConstraint
- L172 constraint refuses missing source, unknown tag, empty — addConstraint
- L181 question adds an open question, prints its id — addQuestion
- L189 question --blocks takes only a positive whole number — pure: positive (notes.ts)
- L196 question --resolve; refusals — resolveQuestion
- L211 a write that leaves a problem warns and exits 0 — in-process
- L219 report --step stores a relative path, replaces earlier — reportStep (fs setup)
- L230 report --step stores an outside file as absolute — reportStep
- L238 report refusals — reportStep/reportToParent, in-process
- L255 report --file refuses a scratchpad file, by path or symlink — reportStep scratchpad check (fs symlink setup)
- L274 every notes text citing a scratchpad is refused — in-process (9 spawns today)
- L298 report --parent sets ## Report — reportToParent
- L306 note appends; next replaces — addNote/setNext
- L321 remove decision drops by place, check ok — removeItem + checkTask
- L338 remove question renumbers — removeItem
- L348 remove step keeps other numbers — removeItem
- L358 remove highest step frees it; remove all checks ok — removeItem/addStep
- L368 remove step refuses step with report or open question — removeItem
- L382 remove note drops one line, refuses a copied heading — removeItem
- L397 remove --dry-run changes nothing — removeItem dryRun
- L407 remove --json shape — removeItem result, in-process
- L417 remove refuses unknown kind, bad number, missing item — removeItem/positive
- L437 --task names the task from anywhere in its repo — in-process
- L443 a folder with no task needs --task — in-process; currentTask
- L451 an archived task is refused — in-process
- L458 check prints ok for a sound ledger (+--json) — checkTask
- L466 check lists empty goal, bad blocks, bad report step — checkTask
- L487 check reports a record that would not read back; writes refused — in-process with fileStore (legacy Markdown)
- L516 a write shortens a reviewed step's report, keeps todo — report shortening on write (notes write path / format.ts)
- L529 a shortened report over 160 chars is cut with ellipsis — pure shortening function
- L562 check fails on a ledger over 16,000 chars, names 3 largest — checkTask / LEDGER_SIZE_LIMIT
- L571 a write to a large ledger succeeds and warns — in-process
- L670 stage pass moves a task through the code stages — recordStage (notes.ts) + fakeClock
- L685 stage follows docs and investigation kinds — recordStage/STAGES
- L696 stage fail keeps stage; --back returns; notes — recordStage + recordStageText
- L708 stage --skip passes and keeps the reason — recordStage
- L715 stage pass --step sets the plan step status — recordStage
- L728 stage refuses a stage that is not current — recordStage
- L742 stage refuses unknown stage, unknown kind, finished — recordStage/isKind
- L762 stage refuses wrong outcome / flag combos — recordStage + cli parse, in-process (12 spawns today)
- L787 check lists unknown kind, stage not of kind — checkTask/hasStage
- L806 each rejected review adds one to review rounds; show prints them — recordStage + show, in-process
- L831 the third rejected review blocks the task — recordStage + fakeClock
- L842 a passed review keeps the count — recordStage
- L852 a failed stage other than review leaves rounds alone — recordStage
- L874 third rejection of an already-blocked task keeps its reason — recordStage
- L882 third rejection of parked/waiting/lost task is refused — recordStage + checkTransition
- L897 third rejection of a backlog task does not block it — recordStage, in-process

**merge** (6)

- L74 plan add --json gives the new step — into L64 (add a --json call)
- L129 step --note "" clears the note — into L118
- L329 remove constraint drops by place — into L321 (table over kinds)
- L523 a write shortens a done step's report, keeps green — into L516 (table over statuses)
- L821 the second rejected review asks for higher effort — into L831 (table over rounds 2, 3, 4)
- L863 a fourth rejected review counts 4 — into L831 (rounds table)

**wording** (1)

- L430 remove --help names each kind — structural: assert each of REMOVABLE (notes.ts) appears in help; in-process

**delete** (1)

- L816 the first rejected review prints what it printed before — covered by L852 'a failed stage other than review leaves the review rounds alone' (asserts the same exact first-rejection text)

</details>

<details><summary><code>tests/ledger-core-sqlite.test.ts</code> — 42 tests</summary>

**keep-e2e** (7)

- L104 ${storage} store: retire archives ledger and evidence, both read back — real go+retire (worktree removal) through each store; the one end-to-end retire here
- (unsure) L304 ${storage} store: show --evidence <file> prints the file's bytes exactly — unsure: needs binary stdout of a real process; in-process Ran.stdout is a string — keep unless runLedger exposes bytes; seed evidence directly to drop go+retire
- L438 sqlite probe of the fixtures ignores NODE_OPTIONS — fixture self-test; spawns a real node (noSqliteOn)
- L452 sqlite probe names the probed Node's version, $ in path — real sh + node wrapper
- L475 storage sqlite without node:sqlite exits 1 with the Node version message — needs a Node with node:sqlite hidden (loader hook)
- L483 without node:sqlite the file store still works — lazy-load proof needs a process without node:sqlite
- (unsure) L509 sqlite experimental warning stays off stderr, others print — real stderr warning printing; absorbs L521, L528 (one spawn, all warnings); unsure: the wrapper in sqlite-store.ts could be tested in-process by listening to process 'warning'

**to-unit** (28)

- L88 ${storage} store: task writes the backlog ledger to the store — in-process with each store
- L95 ${storage} store: go moves the backlog ledger to active — in-process with each store; worktree creation covered by ledger-core-write L244
- L116 ${storage} store: task archive lists the retired task — in-process; seed archive via store.archive.write
- L124 ${storage} store: list shows backlog, --archived shows retired — in-process; seed archive
- L139 ${storage} store: SessionStart hook counts children by store status — in-process `hook session-start` (as tests/ledger-awareness.test.ts does)
- L173 ${storage} store: retire marks child retired in backlog parent, copies report — in-process (retire.ts); worktree removal covered by L104
- L180 ${storage} store: retire warns an empty report is not copied — in-process (retire.ts)
- L189 ${storage} store: show prints the backlog ledger before an archive copy — in-process (show.ts)
- L209 ${storage} store: show of a full archive name prints that copy — show.ts name resolution
- L223 ${storage} store: show without --repo does not print another repo's backlog — in-process
- L232 ${storage} store: show counts -N copies, newest by date then N — show.ts selection (pure sort could be unit)
- L245 ${storage} store: show --evidence of a backlog-only slug exits 1 — in-process
- L255 ${storage} store: show --evidence of a copy without evidence prints nothing — in-process
- L261 ${storage} store: show --evidence <missing file> exits 1 — in-process
- L274 ${storage} store: show outside a repo without --repo exits 1 — in-process
- L292 ${storage} store: show --repo reads another repo, from any folder — in-process
- L299 ${storage} store: show --evidence lists evidence files — in-process; seed archive with evidence (as L261) instead of retire
- L313 ${storage} store: show --json prints repo, name, location, text — in-process
- L327 ${storage} store: show refuses a slug or --repo with .., /, \ — isRepoKey / slug check (repo-key.ts), in-process (8 spawns today)
- L347 ${storage} store: task --design-refs writes the numbers — readTemplate/fillLedger, in-process
- L358 ${storage} store: --design-refs adds the line when template has none — readTemplate/fillLedger
- L367 ${storage} store: --design-refs with no ## Location exits 1 — readTemplate
- L375 ${storage} store: --design-refs refuses a non-number list — pure refs validation (createTask)
- L383 ${storage} store: show of a slug in neither backlog nor archive exits 1 — in-process
- L396 with no ledger-settings.json the ledgers stay in files — readStorage (tools/ledger/settings.ts) + in-process
- L416 an unknown storage value exits 1, names allowed values — readStorage
- L425 invalid JSON settings exits 1 and names the file — readStorage
- L448 sqlite probe throws when its child cannot start — already unit (spawn fails instantly)

**merge** (7)

- L199 ${storage} store: show prints newest archive copy, no other slug — into L232 (same newest-copy selection; add other-repo row)
- L282 ${storage} store: show --json of a missing slug exits 1, plain message — into L383 (table: with and without --json)
- L338 ${storage} store: show of a full archive name beats a backlog slug — into L209 (table row)
- L407 a settings file with ${what} keeps the ledgers in files (×2) — into L396 (table: no file / storage file / no key)
- L432 invalid JSON settings names both allowed values — into L425 (same input, add the assert)
- L521 a warning with the SQLite text but type Warning still prints — into L509 (one more emitted warning)
- L528 an ExperimentalWarning with more text still prints — into L509

</details>

<details><summary><code>mods/ledger/hooks/switch.test.ts</code> — 111 tests</summary>

**to-unit** (108)

- L22: /ledger:close passes the task to close.md, and the turn end clears without a go — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L33: /ledger:close names a task whose repo is not the session repo as <slug>@<main>, as ledger notes --task takes it — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L41: /ledger:close in a removed session folder tells close.md there is no ledger, and still clears — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L53: /ledger:next in a removed session folder says so and arms nothing — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L65: /ledger:close in a folder with no ledger of its own says so and arms nothing — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L65: /ledger:next in a folder with no ledger of its own says so and arms nothing — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L76: /ledger:next clears at the turn end, then continues the same task with go <slug> — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L92: /ledger:next of a finished child task shows the prune, how to finalize it, and the next child of its parent — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L115: a turn that ends without an answer clears nothing, and the arm is gone after it — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L125: a subagent turn end neither clears nor runs bin/ledger — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L138: /ledger:go <slug> reads the session ledger, starts the task with one ledger go call, then clears and sends go <slug> — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L151: /ledger:go gives ledger go the longest timeout, as its package install can take minutes — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L159: a ledger go whose package install failed (exit 5) says the worktree and ledger are kept and how to retry, and does not clear — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L176: /ledger:go of the own task of the session arms no previous task: the same slug and repo is the same task — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L185: /ledger:go <parent> passes on the child it picked, the promotion, the unpark, the mark and each warning — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L219: /ledger:go <parent> whose child is in another repo says where it was started, and stays in this session — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L247: /ledger:go <new slug> asks go.md to make the task, and clears once a ledger has that slug — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L267: /ledger:go <new slug> does not clear when go.md made no task — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L281: /ledger:go answers a refusal of ledger go with its error, and arms nothing — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L292: /ledger:go of a missing task whose name cannot be a new slug is refused, not created — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L301: /ledger:go with no slug or with a description answers usage and runs nothing — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L312: a turn switches once: /ledger:go after /ledger:next is refused before ledger go runs — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L324: a second /ledger:go in the same turn is refused — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L336: /ledger:go through the Skill tool starts the task and hands go.md the same lines — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L347: /ledger:go through the Skill tool from a subagent is refused before anything runs — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L357: /ledger:go through the Skill tool with the task: and ledger: lines as its argument is refused — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L366: a No at the permission prompt disarms /ledger:go and says what was already done — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L399: /ledger:next through the Skill tool runs after the operator picks "Save, clear and continue (Recommended)", and the turn end clears and sends go <slug> — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L399: /ledger:next through the Skill tool runs after the operator picks "Save, clear and continue", and the turn end clears and sends go <slug> — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L399: /ledger:next through the Skill tool runs after the operator picks "Retire this task, Save, clear and continue", and the turn end clears and sends go <slug> — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L414: the pick approves one /ledger:next: a second Skill call is refused — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L426: "Not yet" approves no /ledger:next, and takes back an earlier pick — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L444: a question box that answered itself while the operator was away approves no /ledger:next — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L455: a pick in a subagent question box approves no /ledger:next of the main session — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L466: answers the model wrote into the question box call approve no /ledger:next — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L477: answers the model wrote into the question box call take back an earlier pick — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L493: a write of the pick that fails once still hands back the answer, asks once, and leaves no earlier pick — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L493: a write of the pick that fails every time still hands back the answer, asks once, and leaves no earlier pick — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L511: /ledger:next through the Skill tool from a subagent is refused even after the pick — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L523: a subagent ledger:next leaves the pick to the main session, whose ledger:next then runs — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L536: the pick ends with the main turn: /ledger:next in the next turn is refused — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L548: a subagent turn end keeps the pick: /ledger:next of the main session still runs — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L560: a /ledger:go that overlaps a /ledger:next still checking the pick is refused before ledger go runs — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L588: two /ledger:next calls through the Skill tool that overlap start only the first — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L606: /ledger:close through the Skill tool stays refused after the pick — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L606: /ledger:park through the Skill tool stays refused after the pick — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L606: /ledger:fleet through the Skill tool stays refused after the pick — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L618: /ledger:next through the Skill tool after /ledger:go in the same turn is refused, and the go stays armed — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L632: /ledger:next through the Skill tool in a folder with no ledger of its own says so and arms nothing — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L644: /ledger:next through the Skill tool in a removed session folder says so and arms nothing — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L656: a No at the permission prompt disarms /ledger:next: the turn end does not clear — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L669: a deny of the /ledger:next Skill call disarms it: the turn end does not clear — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L684: /ledger:park <reason> parks this task after the model turn, then clears without a go — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L709: /ledger:park <slug of a task on another machine> <reason> answers that it is read-only here, and parks nothing here — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L732: /ledger:park <slug> <reason> finds a task on another machine by the repo key of the session, not by the folder name of its main checkout — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L749: /ledger:park <slug> <reason> finds a task on another machine filed under an old repo key by the key it is an alias of — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L769: /ledger:park <slug> <reason> takes a task on another machine in a repo whose key is only the folder name of this main checkout as part of the reason — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L785: /ledger:park <slug> <reason> finds a task of this machine in another clone of the repo by the repo key, though its main differs — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L802: /ledger:park <slug> <reason> takes a task whose main is this main checkout but whose repo key is another as part of the reason — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L811: /ledger:park <own slug> <reason> parks this task, with the reason after the slug — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L820: /ledger:park <other slug> <reason> parks that task at once and arms no clear — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L838: a park that fails at the turn end says so and does not clear — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L849: /ledger:park with no reason answers its usage and runs nothing — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L860: an answered turn names the session after its task once per slug, and runs auto-prune once per turn — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L870: an answered turn shows the line auto-prune gives when it pruned a finished task — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L882: a turn that clears neither renames nor runs auto-prune a second time — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L892: an answered turn in a folder with no ledger of its own renames nothing and prunes nothing — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L901: no switch runs a program other than bin/ledger — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L912: /ledger:park <other slug> with no reason answers its usage: it parks neither task and clears nothing — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L925: /ledger:park <one word> that is no task slug parks this task with that word as the reason — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L933: /ledger:park <slug of a task in another repo> <reason> parks this task, with the whole text as the reason — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L944: a /clear that fails at the turn end says so in the log, and sends no go — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L956: a prompt submit that fails after the clear says what to type — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L970: two /ledger:go calls that overlap start only the first: the second is refused before ledger go runs — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L980: a deny of the Skill call after ledger go disarms /ledger:go and answers with the deny — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L991: a deny of the Skill call after a promotion says what was already done — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1000: a typed /ledger:go whose markdown throws after the arm disarms it: the turn end does not clear — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1022: /ledger:go with the task: and ledger: lines it wrote itself passes them to go.md untouched — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1033: /ledger:go through the Skill tool with a leading slash on its name starts the task — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1044: /ledger:go <slug>@<path> starts the task in that repo with --repo, and the session stays here — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1062: /ledger:go of a task that ledger go refuses as one of another repo makes no new task — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1075: /ledger:go <new slug> does not clear when only another repo has a task with that slug — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1093: /ledger:go <new slug> does not clear when only another machine has a task with that slug in this repo — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1111: /ledger:go <new slug> does not clear when ledger list fails at the turn end, and says why — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1127: /ledger:go passes on the parent of the task it starts and the status of each of its children — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1169: /ledger:go from a finished task shows how to finalize it, and looks up no next child: go already picked it — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1185: a finished task whose branch is merged gets the line to finalize it — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1194: a finished, merged task whose retire is blocked says what blocks it, not that retire will work — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1211: a finished task whose PR is still open says so, and to finalize it once the PR merges — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1224: a finished child task whose parent has no child left says so — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1239: a finished child task whose next-child lookup fails shows no child line, and still continues — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1254: a finished child task of a parent in another repo names the parent as /ledger:go takes it — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1274: a /rename that fails is tried again at the next turn end — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1289: /ledger:go in a session with no person at the prompt tells go.md to queue go <slug> in T3, and the turn end with nothing queued clears and tells the operator to type it — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1312: /ledger:next with no person at the prompt tells next.md to queue go <slug> in T3, and the turn end with nothing queued clears and tells the operator to type it — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1337: /ledger:go and /ledger:next in an interactive session still send go <slug> after the clear — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1351: a start with no person at the prompt counts only for its own session: a later session sends go <slug> again — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1371: /ledger:next with no person at the prompt, after the model queued go <slug> in a fresh T3 run, releases the claims at the turn end and neither clears nor sends go <slug> — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1389: /ledger:go with no person at the prompt, after the model queued go <slug> in a fresh T3 run, hands the task over and does not clear — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1416: a T3 send with another slug is no queued go: /ledger:next with no person at the prompt still clears at the turn end — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1416: a T3 send with no fresh context is no queued go: /ledger:next with no person at the prompt still clears at the turn end — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1416: a T3 send with mode auto is no queued go: /ledger:next with no person at the prompt still clears at the turn end — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1416: a T3 send with a subagent is no queued go: /ledger:next with no person at the prompt still clears at the turn end — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1430: a queued go T3 refused leaves the arm as it was, so /ledger:next with no person at the prompt still clears — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1444: a T3 send with no arm passes through and arms nothing — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1454: a turn cut short after the model queued go <slug> in a fresh T3 run still releases the claims, as the queued run starts anyway — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1467: a queued go that T3 answers with an error leaves the arm as it was, so /ledger:next with no person at the prompt still clears — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L1480: a T3 send in an interactive session is no queued go: /ledger:next still clears and sends go <slug> — already unit (fake engine, claude-code/testing world(); no spawn, no git)

**merge** (3)

- L1011: a /ledger:go Skill call that throws after the arm disarms it: the turn end does not clear — into switch.test.ts L1000 (typed /ledger:go markdown throws): table over markdown/skill break; no time win
- L1301: /ledger:go through the Skill tool with no person at the prompt hands go.md the same continue line — into switch.test.ts L1289 (/ledger:go no person at the prompt): table over typed/Skill; no time win
- L1324: /ledger:next through the Skill tool with no person at the prompt hands next.md the continue line — into switch.test.ts L1312 (/ledger:next no person at the prompt): table over typed/Skill; no time win

</details>

<details><summary><code>mods/ledger/hooks/claims.test.ts</code> — 60 tests</summary>

**to-unit** (59)

- L29: a go <slug> prompt claims the task for this session and passes the prompt on unchanged — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L39: a go <slug> prompt for a task another session holds asks, with three options, before any work — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L59: the held line quotes the bin/ledger path, so a path with spaces or quotes runs as one word — already unit: pure heldMessage in mods/ledger/hooks/ledger.ts
- L66: the held line quotes the task too, so a slug@path with a quote runs as one word — already unit: pure heldMessage in mods/ledger/hooks/ledger.ts
- L72: a go <slug> prompt with more than one space before the slug claims the task — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L81: a held answer whose claim is malformed is a plain claim failure — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L95: a held go <slug> prompt leaves the clear-point offer for the next plain prompt — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L108: a go <slug> prompt that claims the task still carries the clear-point offer — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L118: a claim that fails for another reason passes the prompt on with a line that says why — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L130: the prompt "go" makes no claim — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L130: the prompt "go epic now" makes no claim — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L130: the prompt "let us go epic" makes no claim — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L130: the prompt "Go epic" makes no claim — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L130: the prompt "goepic" makes no claim — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L130: the prompt "go --take-over" makes no claim — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L130: the prompt "go -x" makes no claim — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L140: a slash command whose text reads go <slug> makes no claim — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L150: /ledger:go passes the session id to ledger go — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L158: /ledger:go of a task another session holds hands go.md a held: line and arms no clear — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L169: /ledger:go through the Skill tool of a held task hands go.md the held: line and arms no clear — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L181: a ledger go refusal with exit 3 but no held claim is a failed start, not a held task — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L190: /ledger:go <slug> --take-over forwards --take-over to ledger go and switches as usual — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L233: /ledger:go <slug> --take-over through the Skill tool forwards --take-over after the operator picks "Take over" for that held task — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L233: /ledger:go <slug> --take-over through the Skill tool forwards --take-over after the operator picks "Take over (Recommended)" for that held task — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L247: a held /ledger:go names the task a "Take over" pick approves, as a held go <slug> prompt does — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L259: /ledger:go <slug> --take-over through the Skill tool is refused until the operator picks "Take over" — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L270: a "Take over" pick with no held task approves nothing — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L281: a "Take over" pick for the held task approves no take-over of another task — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L294: the answer "Pick another task, Take over" is no "Take over" pick — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L294: the answer "Take over, Stop" is no "Take over" pick — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L294: the answer "Take over now" is no "Take over" pick — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L294: the answer "Not Take over" is no "Take over" pick — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L307: "Take over" in a box with more than one question is no pick, as it may answer another question — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L319: a take-over forgets the held task, so a later "Take over" pick approves nothing — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L334: a go <slug> prompt that claims its task forgets an earlier held task, so a later "Take over" pick approves nothing — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L347: a "Take over" pick lets the model take over once — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L360: "Stop" lets the model take over nothing, and takes back an earlier "Take over" — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L374: a "Take over" the model wrote into the question box call approves no take-over, and takes back an earlier pick — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L387: a "Take over" pick in a subagent question box approves nothing, and takes back an earlier pick — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L399: a "Take over" pick answers the question of its own turn only — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L411: a "Take over" pick ends with the turn even when the clear-point pick cannot be reset — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L424: a take-over reset that fails at the turn end still resets the clear-point pick, and the armed clear still runs — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L438: /ledger:go through the Skill tool without --take-over needs no pick — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L447: a finished turn marks every claim of this session active, at most once per 15 minutes — already unit: mock.clock fake timer
- L461: a touch that exits nonzero is tried again at the next turn end, and says nothing — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L484: a new session marks its own claims active at its first turn end — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L495: a session in the main checkout marks its claims active too: it may have claimed a task from there — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L504: a subagent turn end marks no claim active — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L513: the touch runs before an armed clear, which then releases every claim of the session and clears — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L524: a session in task epic that finds kid held and stops touches and releases only through the session-wide calls — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L539: a take-over the model ran through Bash is released at the end of the session with no state the plugin kept — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L547: an armed /ledger:close releases every claim of the session before it clears — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L562: an armed /ledger:go from its task releases every claim of the session before it clears — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L562: an armed /ledger:go from the main checkout releases every claim of the session before it clears — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L575: after an armed /ledger:go clears with its release failed, the new session takes the live claim over from the old one with no held question, once — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L598: a go <slug> prompt for another task than the armed one claims without --from, and ends the hand-over — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L616: an armed /ledger:park releases every claim of the session after the park and before the clear — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L630: a failed release says nothing and still clears — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L639: the end of a session releases every claim of that session, by the id the event gives — already unit (fake engine, claude-code/testing world(); no spawn, no git)

**merge** (1)

- L473: a touch that bin/ledger could not run is tried again at the next turn end — into claims.test.ts L461 (touch exits nonzero, retried): table over nonzero exit / could not run; no time win

</details>

<details><summary><code>mods/ledger/hooks/clear-point.test.ts</code> — 16 tests</summary>

**to-unit** (16)

- L14: the reminder asks for the clear-point question, its first option recommended — already unit: pure clearPointReminder in mods/ledger/hooks/ledger.ts; asserts option labels via CLEAR_POINT_OPTION constant, i.e. already structural
- L21: by default, the next prompt after a turn that reaches 150,000 tokens carries the reminder once — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L35: a turn end that finds the task finished marks no offer: after the last verdict there is no clear point — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L46: the clearPointTokens option sets the size of the first offer — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L59: a turn end that marked no new offer adds nothing to the prompt after it — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L71: a slash command prompt does not carry the offer; the plain prompt after it does — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L86: the next offer waits for another clearPointTokens of growth past the last one — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L98: no offer while an agent runs; the first turn end with none running marks it — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L113: a subagent turn end marks no offer — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L123: a session with no ledger of its own gets no offer — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L133: no offer before the first response gives a context size — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L144: clearPointTokens 0 turns the offer off — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L144: clearPointTokens -1 turns the offer off — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L155: a new session starts again at clearPointTokens, and drops an offer the old one had not delivered — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L170: a failed usage read leaves the turn end and the next prompt as they were — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L183: a failed offer write at the prompt passes the prompt on without the reminder — already unit (fake engine, claude-code/testing world(); no spawn, no git)

</details>

<details><summary><code>mods/ledger/hooks/commands.test.ts</code> — 43 tests</summary>

**to-unit** (42)

- L11: /ledger:all shows `ledger list --archived` verbatim, from one call — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L21: /ledger:all --scan says the flag was dropped, then shows the list — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L31: /ledger:archive passes the search term as one argument and --all as a flag — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L40: /ledger:archive with no term lists the archive of this repo — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L48: /ledger:parent <slug> shows `ledger tree show <slug>`, and a change runs `ledger tree <action> <slug> <child>` — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L59: /ledger:parent passes an action with no child, and options, on to ledger tree — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L68: /ledger:parent with no slug answers its usage and runs nothing — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L77: /ledger:parent with options but no slug answers its usage and runs nothing — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L86: /ledger:worktrees shows the table from `ledger worktrees` — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L96: /ledger:worktrees prune app passes its words to `ledger worktrees` — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L96: /ledger:worktrees prune --all --dry-run passes its words to `ledger worktrees` — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L96: /ledger:worktrees prune-orphans --dry-run passes its words to `ledger worktrees` — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L105: /ledger:worktrees prune waits as long as the engine allows, as a big worktree takes time — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L113: a prune that fails shows its report and the error, not only one of them — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L124: a command that bin/ledger refuses shows its error — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L132: a bin/ledger that does not run says so — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L140: /ledger:retire passes slug, --dry-run and --force on, and waits as long as the engine allows — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L152: /ledger:retire of a blocked task shows why — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L160: /ledger:help answers the command list and runs nothing — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L173: /ledger shows the goal, current step and next step of each ledger the session works on — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L188: /ledger <name> shows only the ledgers whose slug holds the name — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L197: /ledger says so when no ledger matches — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L205: /ledger says the session ledgers could not be read when bin/ledger refuses — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L220: /ledger:all through the Skill tool answers with the text the typed command shows — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L220: /ledger:archive through the Skill tool answers with the text the typed command shows — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L220: /ledger:parent through the Skill tool answers with the text the typed command shows — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L220: /ledger:worktrees through the Skill tool answers with the text the typed command shows — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L220: /ledger:retire through the Skill tool answers with the text the typed command shows — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L231: /ledger:help through the Skill tool answers with the list of commands — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L251: /ledger:close through the Skill tool is refused: only the operator types it — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L251: /ledger:next through the Skill tool is refused: only the operator types it — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L251: /ledger:park waits for review through the Skill tool is refused: only the operator types it — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L251: /ledger:parent epic add part through the Skill tool is refused: only the operator types it — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L251: /ledger:parent epic remove part through the Skill tool is refused: only the operator types it — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L251: /ledger:retire epic --force through the Skill tool is refused: only the operator types it — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L251: /ledger:worktrees prune app through the Skill tool is refused: only the operator types it — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L251: /ledger:worktrees prune --all through the Skill tool is refused: only the operator types it — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L251: /ledger:worktrees prune-orphans through the Skill tool is refused: only the operator types it — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L263: /ledger:worktrees prune --dry-run through the Skill tool runs, as it deletes nothing — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L272: /ledger:dashboard is gone: the mod answers no such command — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L282: no command runs a program other than bin/ledger — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L304: every call runs in the session folder, or the nearest folder above it when that is gone — already unit (fake engine, claude-code/testing world(); no spawn, no git)

**wording** (1)

- L169: /ledger:help lists no dashboard — asserts HELP text lacks 'dashboard'; drop: pure prose guard (L272 covers the command being gone, not the help text) — or fold into a structural HELP-lists-registered-commands check

</details>

<details><summary><code>mods/ledger/hooks/session-name.test.ts</code> — 6 tests</summary>

**to-unit** (6)

- L22: D43: after /ledger:go clears and sends go <slug>, the turn that entered the new worktree names the session after it — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L39: D43: a session that enters another task\ — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L49: D43: a session in the main checkout that claimed a task with go <slug> is named after it at the turn end — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L58: D43: a session that claimed a task, then worked in another task\ — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L71: D43: a new session in a task\ — already unit (fake engine, claude-code/testing world(); no spawn, no git)
- L81: D43: a new session that claims a task with go <slug> is named after it at the turn end, though its claim leaves the prompt hook no title to give — already unit (fake engine, claude-code/testing world(); no spawn, no git)

</details>

<details><summary><code>tests/ledger-core-claims.test.ts</code> — 42 tests</summary>

**to-unit** (39)

- L41: claim with no claim writes one for this session, since and active now, and prints claimed <slug> — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L50: claim with no slug claims the task of the worktree it runs in, and takes the session from CLAUDE_CODE_SESSION_ID — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L56: --session wins over CLAUDE_CODE_SESSION_ID; with neither, every claim command exits 2 with one line and writes nothing — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L69: claim by the session that holds it keeps since and sets active to now — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L76: claim of a task another session holds live exits 3, names the holder, and writes nothing; --json gives the holder as "held" — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L88: a claim expires 120 minutes after its last activity: another session then claims the task with no warning, since now — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L95: --take-over replaces a live claim of another session with this one, since now, and names the session it took over from — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L104: claimExpiryMinutes in ~/.claude/ledger-settings.json sets the expiry; any value but a positive whole number fails and names the key and the file — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L121: a backlog or retired task cannot be claimed: exit 2, and the message says the task is not active — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L134: touch sets active to now only when this session holds the claim and its active is 15 minutes old or more — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L144: touch never claims: a task held by another session, an expired claim and no claim stay as they are, and it prints nothing — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L155: release removes the claim of this session; for a claim of another session or none it prints not held by this session and changes nothing — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L167: release removes this session\ — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L188: touch --all marks every claim of this session in the repo active, and leaves the claims of other sessions — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L206: touch --all keeps the 15-minute rule and does not revive an expired claim — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L218: release --all removes every claim of this session in the repo, and leaves the claims of other sessions — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L229: release --all removes expired claims of this session too, and prints one released <slug> line each — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L237: release --all for a session that holds no claim releases nothing and prints nothing — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L243: --all with a slug is a usage error: exit 2, and no claim changes — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L253: --all needs a session too: with none it exits 2 and changes nothing — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- (unsure) L281: touch --all goes on past a task it cannot write, then exits 1 naming it; --json lists the tasks it did change — in-process; broken lock = mkdir <record>.lock (tools/ledger/lock.ts, limitLockWaitForTests 500 ms). unsure: memoryStore must model an untakeable per-record lock
- (unsure) L281: release --all goes on past a task it cannot write, then exits 1 naming it; --json lists the tasks it did change — in-process; broken lock = mkdir <record>.lock (tools/ledger/lock.ts, limitLockWaitForTests 500 ms). unsure: memoryStore must model an untakeable per-record lock
- (unsure) L295: release --all without --json prints the tasks it released, and the failure on stderr — in-process; broken lock = mkdir <record>.lock (tools/ledger/lock.ts, limitLockWaitForTests 500 ms). unsure: memoryStore must model an untakeable per-record lock
- L303: park removes the claim, whichever session holds it — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- (unsure) L311: retire removes the claim, whichever session holds it: the archive copy has none — in-process. unsure: retire removes the worktree with git; claim-removal assert itself is git-free
- L321: go to a task another session holds live exits 3 with the holder, and changes nothing; --json adds "held" — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L337: go --take-over replaces the claim of the other session with its own and goes on as go does — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- (unsure) L356: go with a session claims nothing for a task of another repo than the one it runs in, and says so — in-process; second repository() for another repo key. unsure: repo key comes from git remote (remoteUrls in tools/ledger/git.ts via tools/ledger/repo-key.ts); needs a repo-key s…
- (unsure) L370: go of a task of another repo still refuses while a session holds it live — in-process; second repository() for another repo key. unsure: repo key comes from git remote (remoteUrls in tools/ledger/git.ts via tools/ledger/repo-key.ts); needs a repo-key s…
- L378: go --take-over with no session known removes the other claim and claims nothing — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L385: go claims a task with a worktree for its session: its own claim keeps since, and an expired claim of another session is replaced — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L395: go with no session known claims nothing — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- (unsure) L401: go of a backlog task claims its new worktree ledger for the session, and claims nothing with no session known — in-process. unsure: go of a backlog task runs real git worktree add (tools/ledger/git.ts); claim part is git-free but command is not
- L411: claim --from hands a claim of that session over to this one, live or expired, and prints claimed <slug> — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L422: claim --from refuses a live claim of a third session with exit 3, and writes nothing — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L431: claim --from with no claim claims the task as claim does — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L437: the hook input gives the session id — already unit: pure parseHookInput in tools/ledger/hooks.ts
- L448: session start adds one line for a ledger held live by another session; its own claim and an expired one add none — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records
- L457: the report names a sibling held live by another session — in-process already (runInProcessWith + fakeClock, tools/ledger/claims.ts); only git is setup (repository()/worktreeTask() ~1.8 s) → runInProcessWith + memoryStore records

**merge** (3)

- L199: touch --all prints one touched <slug> line per claim it marked, and nothing when it marked none — into ledger-core-claims L188 (touch --all marks every claim): add the printed touched lines to that test
- L213: touch --all for a session that holds no claim touches nothing — into ledger-core-claims L237 (release --all, no claim): table over touch/release
- L346: go --take-over says whose claim it took over, in its output and as "tookOverFrom" in --json — into ledger-core-claims L337 (go --take-over replaces the claim): add output/tookOverFrom asserts

</details>

<details><summary><code>tests/ledger-awareness.test.ts</code> — 59 tests</summary>

**keep-e2e** (2)

- D28: ledger statusline on git storage reads the clone and never pulls, syncs or runs gh, so a remote that hangs costs nothing — git store + hanging network git (machine/remote, stub git sleep 30)
- D28: ledger statusline on git storage gives up on a clone whose git hangs, and prints nothing — killing a hung git in the clone

**to-unit** (56)

- D26: the session start in a task folder gives the report in its fixed order, not the whole ledger — in-process already (hook session-start); sessionReport in tools/ledger/awareness.ts via runInProcessWith+memoryStore; drop real git (checkout/linked)
- D26: the report is the same after a startup, a resume, a clear and a compaction — same as 1
- D26: a task with no parent and nothing for the operator says so, with no Siblings or Then line — same as 1
- D26: a blocked current task and a blocked ancestor are named, and a task held by another session too — same as 1
- D26: a task done without a PR is named as done, not as a merged PR — same as 1
- D26: a parent held by another session is named too — same as 1
- D26: the last open child names a sibling not yet retired as to retire before the parent finalizes; … — same as 1
- D26: Then names the next open child by order, not by the line order under Children — same as 1
- D26: Siblings shows at most 8, then how many more — same as 1
- D26: the walk up the parents stops at a task it has passed already — same as 1
- D26: a parent with no ledger is still on the path, with no Siblings or Then line — same as 1
- D26: on a large tree the report stays at 20 lines, capping … — same as 1
- D26: a question of several lines shows only its first line, so the report stays within 20 lines — same as 1
- D26: a blocked detail of several lines shows only its first line — already unit (sessionReport direct); `checkout()` git setup avoidable
- D26: a task anywhere in the tree held by another session is named, not only a sibling or a parent — same as 1
- D26: a folder that owns several ledgers lists each with its Next step and asks which to continue, within 20 lines — already unit (sessionReport direct)
- D26: hook failures still come first, outside the report — same as 1
- D26: a lost sibling is not in Siblings, and the last open child names the backlog sibling that starts next, as finalize does — same as 1 (+ finalizeLabels in-process)
- D26: Then skips a lost sibling and names the next open child — same as 1
- D26: a done task gets finalize advice even when its parent does not list it — same as 1
- D26: a done task in another repo is named for finalize by its slug and the main checkout of its repo — same as 1
- D26: a merged PR on record comes before the open questions, so five questions do not hide it — same as 1
- D26: a done child of the current task gets finalize advice even when the parent does not list the current task — same as 1
- D26: Then names every lost sibling, before or after the current task, as to retire before the parent finalizes — same as 1
- D26: a sibling marked retired under Children whose ledger is still live counts as open, as finalize counts it — same as 1
- D26: a done grandchild under a backlog child whose record names its main as a relative path gets finalize advice — same as 1
- D26: a backlog parent whose record names its main as a relative path still shows the siblings and the Then line, … — same as 1
- D26: the last open child does not name a backlog sibling that waits for a task not done; … — same as 1
- D26: the last open child names the first startable child of a backlog sibling that has children, … — same as 1
- D26: Then passes over a sibling after the current task that waits for a task not done, … — same as 1
- D26: Then names the first startable child of a backlog sibling after the current task, as finalize does — same as 1
- D26: when no sibling after the current task can start, Then names the siblings to retire … — same as 1
- D26: a current task with a child left gets that child to start next, never the parent to finalize, … — same as 1
- D26: a current task whose children have all started gets no Then line, … — same as 1
- D26: a sibling line with no ledger counts as not retired, so the parent does not finalize next, … — same as 1
- D26: a parent that has only an archive copy gets no Then line, … — same as 1
- D26: under a parent that has only an archive copy, a current task with a child left gets that child to start, … — same as 1
- D26: a sibling line marked started whose task has no ledger anywhere counts as missing, not as prose, … — same as 1
- D26: a sibling line marked retired whose archive copy is gone does not block the parent, in the report or the gate — same as 1
- D26: Then reads the children of the current task at the session checkout, … not at the checkout its parent line names — same as 1; two checkouts share a repo key via remote URL — memoryStore + repo-key seam, or keep git for key only
- D26: a child whose archive copy names the current task at the other checkout is still left at the session checkout, … — same as 41
- D26: a done task the tree finds at a checkout of another repo gets finalize advice for that checkout, … — same as 1
- D26: finalize advice for a slug that starts with a hyphen runs, as the CLI does not read the slug as an option — spawns bin/ledger only to check `--` parsing; runInProcessWith(... 'task','gate','finalize','--','-legacy') covers it (commander runs in-process)
- D26: finalize advice for a task of another repo with no known main checkout says … never a placeholder — already unit (finalizeAdvice in awareness.ts)
- D27: a main checkout lists the open trees of its repo and asks what to do — same as 1 (session-start in main checkout)
- D27: a root whose record names its main as a relative path counts its children at the main checkout, … — same as 1
- D27: a live task whose parent is in another repo or has no ledger heads a tree here, so it is not hidden — same as 1
- D27: a linked worktree with no ledger of its own lists the open trees too — same as 1
- D27: a lost root is not offered, unless an open task is below it — same as 1
- D27: at most 12 trees, then how many more and where to see them — same as 1
- D27: a main checkout with no open tree still asks: a new task or quick work — same as 1
- D27: a live task is not hidden when its root has no record, or when its parent does not list it — same as 1
- D27: a lost child is not counted as open, and a lost root with only lost children is not offered — same as 1
- D28: ledger statusline prints the task and stage of the folder, and its state when it is not plain active — 4 bin/ledger spawns; in-process runInProcessWith 'statusline' (cli.ts:1002); bin/ledger's own statusline branch only fires without node_modules
- D28: ledger statusline prints nothing for a main checkout, a folder outside git, a missing folder or a broken settings file — same as 55
- D28: the status line text counts several ledgers of one folder — already unit (statusLineText)

**merge** (1)

- D26: Then names a done sibling and a lost one as to retire before the parent finalizes — into #24 (same file) as a table over sibling states

</details>

<details><summary><code>tests/ledger-active-core.test.ts</code> — 46 tests</summary>

**keep-e2e** (7)

- ledger task retire archives the text of the active record, then removes the record and the worktree — real `git worktree remove`; can run in-process (git stays real)
- git storage reads a clone of format 1 as it is, and its first write upgrades it to format 2 in a commit of its own — git store; can run in-process
- git storage with a stray file in a clone of format 1: a read works, and a write fails as its commit would, leaving format 1 — git store
- (unsure) git storage refuses a clone of a format newer than 2 — git store; unsure: refusal may be a pure marker read (clone.ts) → could be unit
- the pre-push hook allowlist takes active records only as JSON — real bash runs the generated hook script (prePushHook, secret-scan.ts); cheap (~0.2 s)
- a second ledger task retire finishes one whose worktree removal failed halfway, after it deleted the evidence — real git worktree removal + failing stub git
- git storage of format 1 whose upgrade commit failed upgrades in a commit of its own at the next write — git store commits

**to-unit** (35)

- ledger go moves a backlog task into an active record that names its new worktree, and the backlog ledger is gone — in-process runInProcess; goTask (write.ts) store transition; go's own `git worktree add` stays real
- ledger go of a slug an active record already has fails, and leaves the backlog ledger and no worktree — in-process + memoryStore
- ledger task new --stack writes an active record for the new worktree, and its decision line to the active record of this worktree — in-process; createTask --stack
- ledger task new --here writes an active record for this linked worktree, once — in-process; createTask --here
- notes and park write the active record — in-process + memoryStore
- ledger show with no slug prints the active task of this worktree, and fails in one line naming ledger show <slug> elsewhere — in-process
- the worktree-removal guard denies a worktree an active record names, and one that holds a .claude/ledger.md not yet moved … — hook pre-tool-use via runInProcessWith({input}) instead of spawn
- the task list finds active tasks from the store records and no plain-folder ledger under the scan roots — findTasks (tasks.ts) / in-process list
- worktrees auto-prune takes the worktree folder only, not the path of its old .claude/ledger.md — in-process
- ledger go of a slug another clone has active fails, naming the task and its worktree — in-process; second clone only provides same repo key (git as setup)
- ledger task new --stack and --here of a slug another clone has active fail, naming the task and its worktree — in-process
- ledger task retire from a second clone of the repo refuses an active task of the first, also with --dry-run or --force, … — in-process
- an active record whose worktree is not on this machine is listed as active, marked so — in-process + memoryStore
- notes, park and go refuse an active task whose worktree is not on this machine, in one line — in-process + memoryStore
- ledger task retire of an active task whose worktree is not on this machine needs --force, then archives and removes the record — in-process + memoryStore
- two active records naming one worktree are both listed, and only the lookup of that worktree fails, naming both — in-process
- the clone allowlist takes active records only as JSON — already unit (isAllowed, clone.ts)
- store migrate --repo-ids files an active record kept under a folder name under the repo key — in-process
- sqlite: reopening a database whose records table was rebuilt for active records does not rebuild it again — already unit (sqliteStore)
- store migrate counts active ledgers as it counts backlog ledgers: no line per ledger in a dry run, … — in-process
- (unsure) listing active tasks costs git no call per record, and at most one worktree listing per clone — in-process with asCli (stub-bin git logger on PATH works in-process); unsure: prompt-submit hook git count in-process must match CLI
- ledger task new --here refuses a slug of the backlog, and of an active task filed under an old key of the repo — in-process
- ledger task new of a slug that is active in the repo fails, naming its worktree — in-process + memoryStore
- the worktree-removal guard denies removing a folder two active records name, naming both — hook pre-tool-use in-process
- session-start in a main checkout names no undefined worktree for an active record that names none — hook session-start in-process
- an active record whose worktree folder exists but is no worktree of its clone is elsewhere, and retire --force retires it — in-process; git worktree list stays real
- an active record whose worktree path is a checkout of a repo with another key is elsewhere, and retire --force leaves that checkout — in-process
- ledger task retire with no slug, in a folder two active records name, refuses, names both slugs, and removes nothing — in-process
- ledger task retire --force finishes a retire that stopped after it archived the task and removed its worktree — in-process (worktree already removed in setup)
- ledger task new --here refuses a worktree whose .claude/ledger.md is not moved into the store yet, … — in-process
- store migrate --to sqlite stops, and changes nothing, when an active slug is a backlog slug of the target, or … — in-process (repairs/migrate on file+sqlite in tmp home)
- of two ledger task new --here in one worktree, the one that checks while the other writes is refused: … — already unit (createTask direct); git worktree setup
- a write to an active task whose record a pull replaced with one of another machine is refused, and the pulled record stays — already unit (updateLedger direct)
- ledger task new --here and --stack make no active record while "host" is no host label, and say how to fix it — in-process
- ledger task new --here and --stack make no active record from a template with no "- worktree:" bullet, and say so — in-process; make it table over broken templates

**merge** (4)

- ledger list --json gives an active task its worktree and no path, and a backlog task neither — into tests/ledger-core-cli.test.ts "ledger list --json gives one object per live task, newest first" (add idea has no worktree/path)
- ledger session lists the own active task in a linked worktree, and every active task of the repo in the main checkout — into tests/ledger-core-json.test.ts "session --json gives the ledger of a linked worktree as its own, …" (+ plain `session` lines)
- ledger task retire --json of an active task whose worktree is not on this machine gives its place as active — into #21 (same file): add `--json` to its --force retire
- ledger task new --here and --stack make no active record from a template with no ## Location section, and say so — into #45 (same file) as table row

</details>

<details><summary><code>tests/ledger-core-cli.test.ts</code> — 39 tests</summary>

**keep-e2e** (3)

- ledger deploy --help prints the help of bin/deploy — bin/ledger → bin/deploy delegation (real process)
- an unknown command or option exits non-zero and names it — the one exit-code-of-bin/ledger check for bad argv
- ledger task new, show, list, park, unpark, go, retire and archive take a task from the backlog to the archive — the one full lifecycle through bin/ledger incl. real go worktree (14 spawns ~16 s; could trim)

**to-unit** (32)

- each command has --help with its arguments and options — in-process runInProcess '--help' (structural: usage line + options named)
- ledger list shows the live tasks of every repo with their status, and no retired task — in-process + memoryStore (list text)
- ledger list --json gives one object per live task, newest first — in-process; absorbs active-core "ledger list --json gives an active task its worktree and no path, …"
- ledger list puts each child task under its parent, marked ↳ and indented per level, … — in-process
- list finds the repos of the stored ledgers from any folder, and writes no ~/.claude/ledgers.json — in-process
- a stale old task list changes nothing the list shows, and stays as it was: … — in-process
- an unreadable old task list does not stop the list, and stays as it was — in-process
- ledger archive lists this repo's archived ledgers newest first, named by their title slug — in-process
- ledger archive <term> keeps the ledgers that contain it, in any case, and shows the matching line — in-process
- ledger archive --all lists every repo and names the repo of each ledger — in-process
- ledger archive says so when nothing is archived or nothing matches — in-process
- ledger archive --all says so when nothing is archived in any repo — in-process
- ledger parent --json takes each child status from disk: archive, then worktree, then backlog — in-process; tree show (tasks.ts child status)
- ledger parent shows the parent, its goal, and a row per child with status and next step — in-process
- a child with a live ledger and an archive copy has the live status in both parent and list: the live ledger wins — in-process
- a Children bullet is a child only when it names a known task or has the <slug>@<path> form — in-process
- an archive row keeps the branch line as written, a placeholder included, as the old reader showed it — in-process
- an archive copy of a same-named repo elsewhere does not retire a child — in-process
- a child with no ledger anywhere is missing, even when the parent marks it retired — in-process
- a reused slug: an archive copy of another parent does not retire a live child — in-process
- an archive copy with no parent line counts only when no live ledger has the slug — in-process
- ledger parent <slug>@<path> shows a parent in another repo — in-process
- ledger parent of a slug that is not in this repo fails and names it — in-process
- ledger parent of a task with no children says so — in-process
- ledger parent outside a git repository asks for <slug>@<path> — in-process
- ledger parent refuses a slug the reading rule does not accept — in-process (isReadableSlug already unit in format test)
- ledger --help lists the groups, the short forms and deploy, and hides the commands only Claude Code runs — in-process; structural (command named/hidden) — make one table for 30-32
- the short forms go, list and show take the arguments and options of their ledger task form — in-process (6 spawns now)
- ledger go and ledger task retire refuse a backlog task whose record hides Markdown: … — in-process (file store on tmp disk)
- ledger tree show, add, start, next and remove read and change the children of a parent task — in-process (7 spawns now); overlaps json "parent --json shows the parent; add, remove, start and next …" but checks text output
- ledger store migrate --dry-run changes nothing — in-process
- the old command names exit non-zero as unknown commands and change nothing — in-process (8 spawns now)

**merge** (3)

- ledger archive outside a git repository fails and suggests --all — into tests/ledger-core-json.test.ts "archive --json lists the archived ledgers …; outside a repo it fails" (add text-mode assertion)
- ledger task --help lists new, go, claim, touch, release, park, unpark, retire, show, list and archive — into #30 (same file)
- ledger worktrees --help hides auto-prune, which only a hook runs — into #30 (same file)

**delete** (1)

- (unsure) ledger worktrees auto-prune in a folder without its own ledger prints nothing and exits 0 — covered by tests/ledger-core-json.test.ts "auto-prune with no ledger argument in a folder without its own ledger is outcome no-ledger, exit 0, silent" (asserts plain run is {0,'',''}); unsure: if the hook relies on bin/ledger silence, keep one e2e

</details>

<details><summary><code>tests/ledger-core-concurrency.test.ts</code> — 19 tests</summary>

**keep-e2e** (11)

- file store: of 8 ledger task runs at once with one slug, exactly one makes the task and the others fail without writing — locks between processes (8 × 3 rounds)
- file store: 8 ledger task runs at once with distinct slugs leave every ledger in the backlog and in the task list — locks between processes
- file store: ledger parent add runs at once on one parent list every child — locks between processes; the 9 setup `ledger task new` spawns could be in-process (−9 s)
- file store: ledger go starts nothing, keeps the backlog ledger, and says to run it again, when the ledger changes while the worktree is made — already in-process (goTask with racing store); real git worktree/branch rollback; setup spawn → in-process
- file store: of two store repair --to runs at once that point two tasks at one folder, exactly one succeeds — locks between processes; goneTask setup = 12 spawns → in-process (−12 s)
- sqlite store: of 8 ledger task runs at once with one slug, … — as 1
- sqlite store: 8 ledger task runs at once with distinct slugs … — as 2
- sqlite store: ledger parent add runs at once on one parent list every child — as 3
- sqlite store: ledger go starts nothing, … when the ledger changes while the worktree is made — as 4
- sqlite store: of two store repair --to runs at once … exactly one succeeds — as 5
- sqlite store: a command that waits too long for the database exits 1, says another command holds it, and writes nothing — DB lock between processes (kept as the one process-level busy test)

**to-unit** (7)

- (unsure) file store: store repair --lost refuses when a --to gives the task a folder that is there after --lost read the record — already in-process (repairStore direct, racing store); goneTask setup spawns → in-process; unsure: repair checks the folder's branch with git, so git worktree setup stays
- sqlite store: store repair --lost refuses when a --to gives the task a folder … — as 6
- file store: a lock left by a process that is gone is taken over, and the change is written — withLock (lock.ts) dead-pid takeover, or in-process park; 2 spawns now
- (unsure) file store: a command that waits too long for a lock held by a live process exits 1, names the lock and its process, and writes nothing — in-process with limitLockWaitForTests/fakeClock; unsure: holder pid = test pid in-process — lock must not treat it as re-entrant
- (unsure) sqlite store: every write that waits too long for the database says another command holds it, and writes nothing — spawns 3 tsx children (~2 s each); call store methods in-process with limitBusyWaitForTests while a second DatabaseSync holds BEGIN IMMEDIATE; unsure: same-process busy wait beh…
- sqlite store: a write that fails, and whose rollback fails too, reports why the write failed — already unit (sqliteStore); `repository()` setup not needed
- LEDGER_TEST_DELAY_MS pauses for at most a finite, non-negative value, capped at 10 s; any other value pauses not at all — already unit (pauseForTest, wait.ts)

**merge** (1)

- file store: a lock older than its time limit is taken over, even when its process still runs — into tests/ledger-clock.test.ts "a lock whose process still runs counts as left over once the clock passes a minute since it was taken"

</details>

<details><summary><code>tests/ledger-clock.test.ts</code> — 7 tests</summary>

**keep-e2e** (1)

- (unsure) a background sync asks gh again only once the clock passes a day since gh last said the repository is private — machine/remote git store sync (~7 s); unsure: the gh-privacy cache expiry in sync.ts could be unit-tested directly

**to-unit** (6)

- a claim stays live until the clock passes its expiry, and expires after it, with no waiting — in-process + fakeClock already; drop repository/worktreeTask → memoryStore
- a date a command writes is the clock's today, not the real one — same as 1
- a lock names the time of the clock as since — already unit (withLock)
- a lock whose process still runs counts as left over once the clock passes a minute since it was taken — already unit (withLockIfFree); absorbs concurrency #14
- a reclaim guard whose process still runs counts as left over once the clock passes ten seconds since it was taken — already unit
- with no limit set for a test, a hook has 5 s, the PR check 3 s, and a wait for a lock or the database 5 s — already unit

</details>

<details><summary><code>tests/ledger-core-json.test.ts</code> — 37 tests</summary>

**keep-e2e** (2)

- auto-prune puts its trash in the worktree git dir, so no trash folder shows inside the worktree — depends on real `git rev-parse --absolute-git-dir` of a linked worktree
- auto-prune deletes all the build folders of a worktree with one background rm — detached background rm process + polling waits (≥0.2 s)

**to-unit** (32)

- every command with --json prints one {"ok":false,"error"} object for an unknown option, and exits non-zero — in-process; no repo needed
- list --json gives the tasks with plan progress and parked state; --archived adds the retired ones — memoryStore
- list gives the status of an active task from its status line, a legacy - state: done too; a lost mark wins over it — memoryStore
- (unsure) list and show mark a waiting task done when gh says its PR is merged, and say to finalize it — markMergedDone (write.ts); unsure: gh is a stub shell script on PATH — needs a prState seam to be pure
- (unsure) a merged PR whose done mark cannot be written fails neither list nor show: one warning line, and the task stays waiting — in-process + fakeClock/limitLockWaitForTests; unsure: each of 5 runs likely waits the default 5 s lock wait (~25 s total) — biggest single cost in file
- a waiting task whose PR is open, or for which gh fails, stays waiting and gets no hint — as 5
- gh is asked about no task that is not waiting with a PR: … — as 5
- archive --json lists the archived ledgers with date, branch, goal and the matching line; outside a repo it fails — memoryStore; absorbs cli "ledger archive outside a git repository fails and suggests --all"
- parent --json shows the parent; add, remove, start and next each report what they did; errors are JSON — memoryStore
- tree order and tree depends --json report what they set; tree next --json names what blocks each child; … — memoryStore
- tree ready --json names the chain to each child that can start, to each started child, … — memoryStore
- go --json promotes a backlog task and reports its worktree, branch, base and ledger — in-process; go's git worktree add stays real (covered e2e by cli lifecycle)
- go --json of a parent starts its first backlog child, marks it started and reports the chain — as 14
- go --json of a task that already has a worktree goes there without promoting; an unknown slug fails with exit 2 — memoryStore
- go --json names the parent of the task it started and the status of each of its children — memoryStore
- go --json refuses a slug of another repo, of a retired task, or of a worktree folder with no such ledger, … — memoryStore
- go --json of a backlog parent with no child left in the backlog fails and starts nothing — memoryStore
- go --json of a parent whose next child is in another repo promotes the child there and names that worktree — as 14
- task --json reports a backlog task and its start command, a stacked task with its worktree, and --here — as 14
- park and unpark --json report the marker; an unknown task fails — memoryStore
- block and unblock --json report the blocked status; a refused move and an unknown task fail — memoryStore
- retire --dry-run --json gives the plan and its blockers; retire --json lists what it did — in-process; dirty check uses git status (setup-level)
- worktrees --json gives each linked worktree with its ledger; prune --json gives the folders per worktree — in-process; git worktree list stays real; 55 MB file write
- auto-prune --json prunes a finished task once, marks it, and drops the mark when the task reopens — in-process
- auto-prune with no ledger argument in a folder without its own ledger is outcome no-ledger, exit 0, silent — in-process; absorbs cli "ledger worktrees auto-prune in a folder without its own ledger prints nothing and exits 0"
- auto-prune --json leaves a finished ledger that is not in a linked worktree alone — in-process
- session --json gives the ledger of a linked worktree as its own, those of the main checkout, and none for a removed folder — in-process; absorbs active-core "ledger session lists the own active task …"
- session --json names the main checkout of the repo that holds the folder, and none outside a repo — in-process
- session, list and go --json give each main checkout as its real path, also when … a symbolic link — in-process
- auto-prune deletes the worktree's own build folder beside the worktrees, and leaves the main checkout's — in-process
- auto-prune deletes no build folder, and says so, when .claude/worktrees/.build is a symbolic link — in-process
- auto-prune keeps the build folder of a worktree whose name another worktree shares regardless of case, and says so — in-process; second git worktree is setup for worktree list

**merge** (3)

- list counts only the statuses inside active that some task has — into #3 (same file): add a one-task count row
- with --json, list and show give the task as done in the JSON, and print the hint on stderr — into #5 (same file) as table over list/list --json/show/show --json
- session --json names the repo key of the repo that holds the folder, and none outside a repo — into #31 (same file): assert .main and .repo together

</details>

<details><summary><code>tests/ledger-core-record.test.ts</code> — 40 tests</summary>

**to-unit** (39)

- the fixtures hold the fully filled ledger, the one with literal lines and the one with stray lines — already unit
- a line that only looks like a placeholder is kept: an HTML comment, an autolink, a <draft> decision — already unit
- a wrapped line and a nested bullet stay with the item above them, and render back in place — already unit
- a fully filled ledger maps each section and Location bullet to its field — already unit
- a ledger already in the template layout renders back byte for byte: a filled one and a task fixture — already unit
- the template renders back without its design refs placeholder: … — already unit
- a plan summary is the line under the plan heading, and renders back byte for byte — already unit
- a plan without a summary line reads back with no summary — already unit
- a record with a plan summary passes the shape check, and one whose summary is no string fails it — already unit
- the template parses to an empty record: placeholders, example rows and the preamble are dropped — already unit
- lines that fit no item go to the notes, each group after its section heading, general notes first — already unit
- general notes render under ## Notes, after ## Next step — already unit
- a record round-trips through Markdown: every field set, and a record with no optional field — already unit
- validateRecord rejects a wrong shape and names where — already unit
- a claim bullet in any other form than session <id> since <time>, active <time> is no claim: … — already unit
- validateRecord rejects a record its Markdown cannot carry, so every valid record round-trips — already unit
- ledger editors applied to rendered Markdown change only their field of the record — already unit
- a second child report replaces the first in the notes, as it replaces it in Markdown — already unit
- a report keeps one blank line between its paragraphs, as the goal and the next step do — already unit
- a next step that reads like a parked marker stays the next step, and is not read as parked — already unit
- a legacy Parked: marker reads as status parked, and the record renders it as the status line, without the marker — already unit
- a legacy - state: bullet with a status value reads as that status and renders as the status line; … — already unit
- the status line wins over a legacy - state: bullet, which stays as a note, and over a Parked: marker, … — already unit
- a stored record with the legacy parked or state field reads as status; the status field wins over both — already unit
- validateRecord rejects a status the line cannot carry: … — already unit
- a status detail is one line of text without spaces at either end: … — already unit
- a Windows line ending reads as the same record — already unit
- a plan row of other than five cells is no step: it stays as written in the note of the step above it — already unit
- a plan table of fewer columns keeps every line as written, its separator too — already unit
- a plan row whose cells hold an escaped bar is a step of five cells, … — already unit
- a dependency names its repo by key, an address or a path, and is left out for the task's own repo; it round-trips — already unit
- validateRecord takes a dependency as a slug and a repo key only, and only one its Markdown can carry — already unit
- validateRecord refuses a dependency whose slug is no slug or whose repo is no repo key, and the Markdown does not read one — already unit
- validateRecord refuses a repo key whose host is no hostname with an optional numeric port — already unit
- a bullet under ## Children that reads as a sentence is prose to the record and to the ledger parser alike — already unit
- prose between the lines under ## Children stays in that one section, after the child lines, and round-trips — already unit
- every valid record round-trips whole: the time a task was created is kept by the store beside the record, not in it — already unit
- the review rounds read from and render as a "- review rounds: <n>" bullet under ## Location, and round-trip — already unit
- validateRecord takes the review rounds only as a whole number from 1 — already unit

**merge** (1)

- the summary placeholder reads as no summary — into #20 (same file)

</details>

<details><summary><code>tests/ledger-core-format.test.ts</code> — 30 tests</summary>

**to-unit** (28)

- parse then serialize returns the same bytes: template, filled, CRLF, no final newline, empty — already unit
- the template has a Report section with only a hint, directly before Next step — already unit (structural check of ledger.template.md)
- the template has no slug, and every placeholder reads as not set — already unit
- the title gives the slug, with an em dash or a hyphen — already unit
- sections are the ## headings with their line ranges — already unit
- Location fields: worktree, branch, base with its commit, parent in another repo — already unit
- a parent in the same repo has no main; a backlog ledger has a main line — already unit
- a main line that is no folder drops all from its first " (" when it ends in ")", … — already unit
- one pair of backticks around a main or worktree path is dropped, and a note after it too — already unit
- a main line that is a folder whose name ends in parentheses keeps them; a missing one drops the note — already unit (tmp dirs, chmod)
- a main line that is no absolute path, such as . or repos/app, names no main — already unit
- a main line with one backtick at its start or end, as a code span cut short, is read without it — already unit
- a main line under ~ is read against the home it is parsed with, and names no main without one — already unit
- a relative main line is kept as such, so a reader can say why it names no main — already unit
- a parent line outside ## Location is not the parent — already unit
- Children: marks, cross-repo children in both forms, and hand-written suffixes kept verbatim — already unit
- Children lines with CRLF endings parse the same — already unit
- a legacy Parked: marker, the first text under ## Next step …, reads as status parked; the next step skips it — already unit
- the next step skips only the parked marker: a later "Parked:" line is the next step when it comes first — already unit
- a - status: line under ## Location is the status: a value, then a date and a detail after an em dash, each optional — already unit
- a legacy - state: bullet with a status value reads as that status; any other state value is no status — already unit
- the status line wins over the legacy forms: a - state: bullet, and a Parked: marker, which stays the next step — already unit
- a ## line inside a ``` code fence is not a heading, and the bytes still round-trip — already unit
- an unclosed fence ends at the next ## heading, so the headings after it still count — already unit
- a fence closes only on a bare fence of the same character, at least as long, indented less than four spaces — already unit
- a Next step heading with a suffix still counts — already unit
- goal and report: placeholders and the template hint are no text — already unit
- slug rules: reading is wider than creating — already unit

**merge** (2)

- a title the reading rule does not accept gives no slug: spaces, a slash or an @ — into #4 (same file) as table
- a main line with one backtick at its end, then a note, is read without the backtick — into #13 (same file) as table rows

</details>

<details><summary><code>tests/deploy.test.ts</code> — 61 tests</summary>

**keep-e2e** (6)

- plain deploy links the ledger terminal command — the one full bin/deploy smoke; absorbs #15, #27
- ledger ownership: own file survives revert when the prompt is declined — real pty via script(1), /dev/tty prompt (readReply)
- --dry-run leaves the temporary home unchanged — the only whole-process no-write check, apply-policy, mods and ledger children included
- the drift hook reports a deployed hook link whose hook left the repo — runs bash hooks/deploy-drift.sh; the setup deploy could be in-process
- deploy moves each .claude/ledger.md into the ledger store once, and prints what moved — deploy → bin/ledger store migrate --active on a real linked worktree
- --migrate runs each pending move, prints what moved, and deploys no files — the --migrate path through real bin/ledger, all move kinds

**to-unit** (42)

- --dry-run names the ledger terminal link without creating it — in-process deploy({dry})
- deploy reports a missing terminal command directory on PATH — in-process deploy() with PATH env; 6 bin/deploy runs today (~39 s), the biggest single row
- ledger ownership: nonterminal deploy refuses a foreign symlink — in-process deploy(), DeployError branch
- --dry-run after a filtered deploy does not report selected rules as removed — in-process deploy() x2 (manifest/oldWrote logic)
- ledger ownership: first deploy accepts a symlink through a repo alias — in-process deploy()
- ledger ownership: dry-run reports REPLACE for a foreign symlink — in-process deploy({dry})
- ledger ownership: force backs up a foreign symlink before replacing it — in-process deploy({force})
- ledger ownership: previous manifest permits silent symlink replacement — in-process deploy()
- (unsure) a filtered --dry-run leaves the temporary home unchanged — in-process deploy({dry}) per flag; unsure: with stubbed spawns it cannot see a write made by apply-policy or claude in a dry run (#12 covers the unfiltered case)
- a filtered --dry-run that fails removes its temporary rules directory — in-process deploy() with TMPDIR set; fails in buildRules
- filtered deploy generates only the requested rules and models — buildRules (tools/build-rules.ts) on rules/ + in-process deploy()
- full deploy after a filtered deploy restores dropped rules — in-process deploy() x3
- --revert removes deployed rules, agents, and manifest — in-process deploy({revert}); absorbs #4
- deploy preserves a teammate's own CLAUDE.md — in-process deploy()
- deploy retires an old CLAUDE.md symlink into the repository — in-process deploy(); absorbs deploy-runtime #5 (REPO via an alias)
- --agents deploys only the named agents — in-process deploy({agents})
- --agents rejects an unknown agent name — deploy() throws DeployError 'unknown agent' (line 448); absorbs #23 as a table
- nonterminal deploy refuses to replace an owned file — in-process deploy()
- --force replaces an owned file and backs it up after refusal — in-process deploy({force})
- --no-codex omits Codex agents and prose — buildRules features without codex + agent selection in deploy()
- filtered deploy over linked rules does not modify repository sources — in-process deploy() then a filtered deploy(); hash rules/
- narrow deployment leaves no rule references to undeployed agent lanes — buildRules on rules/ with the narrow feature set
- deploy links bin/ledger into ~/.claude/bin and wires the ledger hooks to it, not to the bash scripts — in-process deploy() links + applyJson (tools/apply-policy.ts) with the repo policy
- deploy removes a manifest hook link into the repo whose hook is gone, and keeps a file or a link of your own — in-process deploy() (oldWrote loop)
- --dry-run names a manifest hook link whose hook is gone, and removes nothing — in-process deploy({dry})
- a deploy whose move of the ledgers leaves one says so, names the command to run again, and still exits 0 — moveAfterDeploy with runLedger → runInProcessWith(memoryStore)
- --migrate --dry-run prints the pending moves and changes nothing — migrate(home, true) with in-process ledger
- --migrate exits 0 when every task it can move moved, names each task that stays and why, and never runs a move with nothing it can do — runMoves with in-process ledger (git worktree is setup only)
- --migrate names the finished tasks that stay under a gone folder name as nothing to do, and exits 0 — migrate()/printLeftovers, in-process ledger
- --migrate --dry-run names the finished tasks that stay under a gone folder name as nothing to do, and exits 0 — same as #42
- --migrate names the tasks that need a person apart from the finished tasks that stay, and exits 0 — migrate()/printLeftovers
- --migrate that moves a task names each task that stays once, under one line for the finished ones, and exits 0 — runMoves, in-process ledger
- --migrate words its leftovers as ledger store migrate --pending does — runInProcess(['store','migrate','--pending']) vs migrate() output
- plain deploy prints nothing for finished tasks that stay under a gone folder name — moveAfterDeploy (showAccepted)
- plain deploy --dry-run prints nothing for finished tasks that stay under a gone folder name — listMovesStillToDo
- --migrate exits 0 when a move exits 1 and leaves nothing it could move — runMoves with a stubbed runLedger (today a node+tsx child over a sh stub)
- --migrate exits 1 when a move exits above 1, and says so — same
- --migrate exits 1 when a move it ran is still to do after the run — same
- --migrate checks again before each kind, and runs no move the fresh check no longer lists — same
- plain deploy moves the .claude/ledger.md files, then names the other pending moves and how to run them — moveAfterDeploy, in-process ledger
- plain deploy with no other pending moves gives no --migrate hint — moveAfterDeploy
- deploy --dry-run lists the moves still to do — listMovesStillToDo; absorbs #36

**merge** (6)

- --revert removes the ledger terminal link — into #18 '--revert removes deployed rules, agents, and manifest' (add the ~/.local/bin/ledger assert)
- plain deploy links every rule without creating CLAUDE.md — into #1 'plain deploy links the ledger terminal command'
- --models rejects an unknown model name — into #22 '--agents rejects an unknown agent name' (buildRules 'unknown feature'); also runs 2 setup deploys it does not need
- plain deploy links every agent, the Codex agents included — into #1
- deploy installs usage hooks and preserves the prompt ledger hook — into #31 (add the statusLine and hook-link asserts)
- deploy --dry-run moves no .claude/ledger.md — into #61 'deploy --dry-run lists the moves still to do' (add existsSync(file))

**delete** (7)

- --migrate with nothing pending says so and exits 0 — covered by deploy-worktree.test.ts 'bin/deploy --migrate runs from a linked worktree: it moves stored data and links nothing' (keep-e2e, asserts 'Nothing to move.')
- --migrate refuses --revert — covered by wizard.test.ts '--migrate refuses every flag that shapes a deploy of files, and names it' (already unit); exit-1 mapping in main() is covered by the deploy-worktree.test.ts refusal keep-e2e
- --migrate refuses --force — same
- --migrate refuses --no-codex — same
- --migrate refuses --codex — same
- --migrate refuses --agents — same
- --migrate refuses --models — same

</details>

<details><summary><code>tests/ledger-deploy-latest.test.ts</code> — 47 tests</summary>

**keep-e2e** (36)

- deploy --latest fast-forwards a main checkout that is behind and deploys the new commit — real fetch + ff; absorbs #2
- deploy --latest deploys a main checkout that is already up to date and says so — 
- deploy --latest stops on an unstaged change to a tracked file and deploys nothing — absorbs #7, #30
- deploy --latest stops on a staged change to a tracked file and deploys nothing — 
- deploy --latest deploys past untracked files — 
- deploy --latest reads a git status of more than 1 MiB — maxBuffer of the real git child
- deploy --latest stops when local main has diverged from its upstream — 
- deploy --latest stops when local main is ahead of its upstream — 
- deploy --latest stops when the main checkout is on a branch other than the default one — 
- deploy --latest stops when the main checkout has a detached HEAD — 
- deploy --latest stops, and says how to set it, when the main checkout has no origin/HEAD — 
- deploy --latest stops when the main checkout switches to another branch during the fetch — stand-in ssh races the fetch
- deploy --latest stops when the main checkout gets a change to a tracked file during the fetch — 
- deploy --latest fetches the default branch also when the fetch refspecs of origin leave it out — 
- deploy --latest stops when the fetch fails — 
- deploy --latest reads more than 1 MiB of what bin/deploy printed — buffer of the bin/deploy child
- deploy --latest reads what bin/deploy printed with the tools/deploy-mods-lines.ts that the fast-forward brought — loads the parser from the pulled commit
- deploy --latest deploys nothing, and leaves the main checkout where it was, when the new commit has no tools/deploy-mods-lines.ts — 
- deploy --latest that cannot load the tools/deploy-mods-lines.ts of the new commit stops after the fast-forward, and says so — 
- deploy --latest fails with the error bin/deploy printed when it exits non-zero — 
- deploy --latest that fails after the fast-forward still reports the move and what bin/deploy did — 
- deploy --latest fetches with git terminal prompts turned off — 
- deploy --latest stops and names the fetch when the fetch runs out of time — 2 s real wait
- deploy --latest gives bin/deploy only the time the fetch left, and reports the move when it runs out — 3 s real wait
- deploy --latest stops bin/deploy and every process it started when the time runs out — process group kill, 4 s wait
- deploy --latest kills what ignores SIGTERM at the time limit once a short grace is over — 4.4 s wait
- deploy --latest does not start bin/deploy when the fast-forward used up the time, and says so — real post-merge hook + mocked Date.now
- deploy --latest names the check after the fetch when the time runs out in it — 
- deploy --latest stops, rather than report HEAD as a commit, when git cannot read the commits — stand-in git on PATH
- deploy --latest gives the git failure, not a detached HEAD, when git cannot name the branch of the main checkout — 
- deploy --latest started in a linked worktree fast-forwards and deploys the main checkout — 
- deploy --latest deploys the main checkout also with the GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE of a worktree, as in a git hook — 
- (unsure) deploy --latest leaves the git limits of the process as it found them — unsure: it checks module state in tools/ledger/git.ts; it might need only a cheaper fixture
- ledger deploy --latest --json deploys the latest main of the checkout that holds bin/ledger, with stdin closed — bin/ledger CLI; ledgerCopy copies the whole repo (expensive)
- ledger deploy without --latest passes its arguments to bin/deploy and pulls nothing — 
- ledger deploy --latest passes a signal it gets on to bin/deploy and every process bin/deploy started — signal forwarding

**to-unit** (4)

- deploy --latest names the move from the old commit to the new one in plain words — reportText/moveText in tools/ledger/deploy-latest.ts (pure)
- deploy --latest reports a reinstalled mod and that Claude Code needs a reload — readModsLines (tools/deploy-mods-lines.ts) + modsReport (deploy-latest.ts, needs export); table absorbs #20-22
- deploy --latest that fails after the fast-forward prints the move and the mods after the failure — failureText/modsText (pure)
- ledger deploy --latest refuses any option but --json, and deploys nothing — in-process runInProcess(['deploy','--latest','--force']) (exit 2 before any git); drops the ledgerCopy fixture

**merge** (6)

- deploy --latest runs bin/deploy without --force, without a terminal on stdin, and without the pull check — into #1 (assert the StubRun argv, stdinTty and pullCheck there)
- deploy --latest gives its reason to stop in one plain line on stderr — into #5 (add the non-JSON run)
- deploy --latest reports a newly installed mod and that Claude Code needs a reload — into #19
- deploy --latest warns when the marketplace points elsewhere, and asks for no reload — into #19
- deploy --latest warns when no claude CLI was found to install the mods — into #19
- deploy --latest that stops before the deploy reports only the error — into #5 (assert the report keys there)

**wording** (1)

- /ledger:deploy reads the report by the names of its fields, all of them and no others — structural: keep the check that the field names in mods/ledger/commands/deploy.md match the DeployReport keys, but build the report by hand instead of from a git fixture

</details>

<details><summary><code>tests/deploy-mods.test.ts</code> — 30 tests</summary>

**keep-e2e** (1)

- deploy adds this repo as a marketplace, then installs the ledger mod and nothing else — the one check that a real deploy calls the `claude` CLI with this argv; absorbs #27

**to-unit** (21)

- the repo ships a marketplace that lists only the ledger mod — already unit (reads .claude-plugin/marketplace.json)
- a second deploy finds the marketplace and the mod and changes neither — deployMods with a fake claude runner
- --dry-run names the ledger mod and neither adds nor installs — deployMods({dry})
- --no-mods runs no claude command and says the step was skipped — deployMods({noMods})
- without claude on PATH deploy skips the mods step and succeeds — deployMods with "no claude" in the seam; absorbs #30
- a failing add fails deploy with a message on stderr — deployMods, the runner fails add
- a failing install fails deploy with a message on stderr — same, install
- --revert runs no claude command and prints how to remove the mods — deploy({revert}) mods text
- deploy reports the ledger mod as already installed — deployMods
- deploy installs the ledger mod when the marketplace is already registered — deployMods; absorbs #15
- --dry-run makes no changes when the ledger mod is already installed — deployMods({dry})
- deploy installs the ledger mod at user scope when it is installed only at another scope — deployMods
- a marketplace named ledger at another path is reported with the fix and left alone — deployMods; absorbs #29
- output from claude plugin marketplace list --json that is not JSON fails deploy with a message naming the command — claudeList parse error; absorbs #20
- output from claude plugin list --json that is not JSON fails deploy with a message naming the command — same; absorbs #21
- (unsure) a marketplace added from the real path of a repo deploy reaches through a symlink counts as this repo — deployMods realpath compare; unsure: REPO is a load-time const (DEPLOY_REPO), so this needs REPO as a parameter
- deploy reinstalls the ledger mod when its installed copy differs from mods/ledger — deployMods copy compare; absorbs #28
- deploy reinstalls the ledger mod when its installed copy is missing — deployMods
- a reinstall carries each saved config value to the new install — deployMods (configure → --config)
- --dry-run with a stale installed copy names the reinstall and makes no change — deployMods({dry})
- a failing install after the uninstall tells the operator to run deploy again — deployMods

**merge** (7)

- a marketplace already added from this repo is reported and not added again — into #12 (same setup; add the 'already added' line assert)
- JSON from claude plugin marketplace list --json that is not a list fails deploy with a message naming the command — into #17 (table: not JSON / not a list)
- JSON from claude plugin list --json that is not a list fails deploy with a message naming the command — into #18
- what deploy prints about an install reads back as the same change — into #3 (assert readModsLines(stdout))
- what deploy prints about a reinstall reads back as the same change — into #22
- what deploy prints about a marketplace at another path reads back as the same change — into #16
- what deploy prints about no claude CLI reads back as the same change — into #7

**delete** (1)

- parseDeployArguments maps --no-mods to noMods — covered by wizard.test.ts 'turning off the mods component maps to --no-mods, which deploy accepts' (same assertEqual)

</details>

<details><summary><code>tests/deploy-runtime.test.ts</code> — 23 tests</summary>

**keep-e2e** (19)

- filtered deploy resolves tsx outside the repository without invoking Python — PATH and tsx resolution of the real process
- bin/deploy behaves the same through a symlinked path: --help — argv[1] handling
- bin/deploy behaves the same through a symlinked path: --dry-run — 
- bin/deploy links into the repository by the path it was called through — 
- build-rules runs its CLI through a symlinked path — isMain through a symlink
- bin/deploy rejects Node 18.19.0 with one error — absorbs #9
- bin/deploy accepts Node 20.12 and runs deploy with the forwarded arguments — 
- bin/deploy skips npm ci when node_modules holds a finished install — 
- bin/deploy runs npm ci when node_modules lacks .package-lock.json — 
- bin/deploy runs npm ci when node_modules lacks it and npm ci fails — 
- bin/deploy pulls new upstream commits on an empty answer — real origin and pull
- bin/deploy offers no pull in a linked worktree, which deploy refuses — 
- bin/deploy continues without pulling when declined — 
- bin/deploy waits for an answer typed after the prompt — EAGAIN on a non-blocking fd 0
- bin/deploy does not prompt when upstream has no new commits — 
- bin/deploy reports new upstream commits without pulling in dry run — 
- bin/deploy skips upstream check with non-TTY stdin unless enabled — 
- bin/deploy aborts without deploying when fast-forward pull fails — 
- bin/deploy --migrate neither checks upstream nor asks to pull — absorbs #23

**to-unit** (1)

- bin/deploy --dry-run prints the same paths when HOME ends in a slash — in-process deploy({dry}) with HOME='x/' (homePrefix/short)

**merge** (3)

- bin/deploy retires a CLAUDE.md symlink that points into the repository by its symlinked path — into deploy.test.ts 'deploy retires an old CLAUDE.md symlink into the repository' (table: direct and alias REPO); #4 keeps the called-through path e2e
- bin/deploy rejects Node 20.11.0 with one error — into #8 (one test, both versions)
- bin/deploy --migrate --dry-run neither checks upstream nor asks to pull — into #22 (same `args.includes('--migrate')` branch in bin/deploy)

</details>

<details><summary><code>tests/deploy-worktree.test.ts</code> — 15 tests</summary>

**keep-e2e** (3)

- bin/deploy with no arguments from a linked worktree refuses in one line, names the main checkout, and writes nothing — guard on a real linked worktree, exit 1; absorbs #2-5
- (unsure) deploy with no arguments in a terminal refuses from a linked worktree before the wizard loads — unsure: could be in-process main([]) with a faked TTY, but REPO is a load-time const from DEPLOY_REPO
- bin/deploy --migrate runs from a linked worktree: it moves stored data and links nothing — also covers deploy.test.ts #40; absorbs #11

**to-unit** (5)

- (unsure) bin/deploy --from-worktree deploys from a linked worktree and warns, in one line, how to restore the links — checkNotLinkedWorktree (tools/deploy.ts), git as setup; today a full deploy (~9 s); unsure: needs REPO as a parameter
- (unsure) DEPLOY_FROM_WORKTREE=1 deploys from a linked worktree without a warning — same; unsure: same REPO const
- bin/deploy with no arguments from a main checkout deploys with neither refusal nor warning — mainCheckoutOfWorktree → undefined; full deploy today; absorbs #13
- bin/deploy from a folder git does not know deploys without refusing — mainCheckoutOfWorktree with GIT_CEILING_DIRECTORIES
- --from-worktree parses to fromWorktree, and --migrate refuses it — already unit (parseDeployArguments)

**merge** (6)

- bin/deploy --dry-run from a linked worktree refuses … — into #1 (the refusal comes before any argument-specific code in main())
- bin/deploy --revert from a linked worktree refuses … — into #1
- bin/deploy --revert --dry-run from a linked worktree refuses … — into #1
- bin/deploy --no-codex --force from a linked worktree refuses … — into #1
- bin/deploy --migrate --dry-run runs from a linked worktree: it moves stored data and links nothing — into #10
- bin/deploy --from-worktree from a main checkout deploys with neither refusal nor warning — into #12

**wording** (1)

- bin/deploy --help from a linked worktree prints the help, which explains the guard and --from-worktree — structural: assert that HELP names --from-worktree; the "help is not refused" part → to-unit main(['--help'])

</details>

<details><summary><code>tests/derived-data-gate.test.ts</code> — 25 tests</summary>

**keep-e2e** (11)

- cc-dd-path in a main checkout prints and creates <main>/.claude/worktrees/.build/.main/<configuration> — absorbs #3
- cc-dd-path in a linked worktree names the folder after the worktree, beside the worktrees of the main checkout — 
- cc-dd-path run only in a linked worktree hides the build folders from git through the shared info/exclude, and adds the line only once — real git status
- cc-dd-path creates info/exclude when it is missing, and keeps the last line of one without a final newline — 
- cc-dd-path without a configuration prints its usage and exits 1 — 
- cc-dd-path refuses a configuration that is not one plain folder name, and creates nothing — 
- a linked worktree build folder is allowed in that worktree, and the main checkout folder is denied there — 
- only a configuration folder inside the own build folder is allowed — becomes the allow/deny table; absorbs #8-10
- a build folder that is not one plain configuration folder in the own build folder is denied — absorbs #19
- every -derivedDataPath in the command is checked, in each spelling of the flag and its value — absorbs #20
- the app build folder is allowed when -workspace names the app — becomes the -workspace/-project/cd/~ table; absorbs #16-18, #21-25

**merge** (14)

- cc-dd-path gives each repository its own folder — into #1 (the app folder is already built in the same fixture)
- the session build folder is allowed — into #12 'only a configuration folder inside the own build folder is allowed' (allow/deny table)
- a build folder elsewhere is denied, and the reason names the folder to use — into #12
- a build folder in Xcode DerivedData is denied — into #12
- the app build folder is allowed when -project names the app — into #15
- the app build folder is allowed after a leading cd into the app — into #15
- the session build folder is denied when -workspace names the app — into #15
- a build folder in a shell variable is denied with the reason — into #13 (it already has `$CONFIG` cases; add the reason assert)
- a command without -derivedDataPath is allowed — into #14
- a build folder elsewhere is denied when -workspace names a shell variable — into #15
- a build folder elsewhere is denied when -workspace names a missing folder — into #15
- the app build folder is allowed when -workspace starts with ~ — into #15
- the app build folder is allowed after a leading cd into a path that starts with ~ — into #15
- the app build folder is allowed when a quoted -workspace path has a space — into #15 (needs a third repo 'my app')

</details>

<details><summary><code>tests/ledger-core-install.test.ts</code> — 11 tests</summary>

**keep-e2e** (1)

- a failed install exits 5, names the command and its last 10 lines, keeps the worktree and ledger, and a later go installs again — exit 5 of bin/ledger, the kept state and the retry

**to-unit** (5)

- ledger go of a backlog task with bun.lock runs bun install --frozen-lockfile once, in the new worktree, and names it in the result — installPackages table over the 6 lockfiles with the stub PATH; the `installed` field via in-process runInProcess go; absorbs #2-6
- the first lockfile in the order bun, pnpm, yarn, npm picks the package manager — installCommand order (INSTALLERS); today 3 worktrees + 3 go children
- ledger go runs no install without a lockfile, and none when node_modules exists; the result has no installed field — installPackages → undefined
- ledger go to a task that has a worktree installs when node_modules is missing, and not again once it exists — in-process runInProcess(['go']) twice (git worktree as setup); asserts the 'packages …' line and the captured output
- an install whose command is not on PATH is a failed install: exit 5, naming the command — installPackages with PATH lacking bun (ENOENT → whyFailed)

**merge** (5)

- … with bun.lockb runs bun install --frozen-lockfile … — into #1
- … with pnpm-lock.yaml runs pnpm install --frozen-lockfile … — into #1
- … with yarn.lock runs yarn install --frozen-lockfile … — into #1
- … with package-lock.json runs npm ci … — into #1
- … with npm-shrinkwrap.json runs npm ci … — into #1

</details>

<details><summary><code>tests/retired-ledger-scripts.test.ts</code> — 2 tests</summary>

**to-unit** (2)

- the retired ledger scripts, hooks and their tests are gone — already unit (existsSync)
- no file outside the history and the settings cleanup names a retired ledger script or hook — already unit (one git ls-files + a file scan)

</details>

<details><summary><code>tests/hook-failure-log.test.ts</code> — 8 tests</summary>

**keep-e2e** (6)

- logged.sh passes stdin, arguments, stdout and exit 0 through and logs nothing — bash wrapper
- logged.sh passes exit 2 and its stderr through unchanged and logs nothing — 
- logged.sh logs any other exit with the last non-empty stderr line and exits 0 with nothing on stderr — 
- logged.sh logs exit <code> for a failure with no stderr, and appends — 
- logged.sh logs a missing script and a script killed by a signal, and exits 0 with nothing on stderr — signal
- logged.sh creates ~/.claude for the log, and exits 0 when the log cannot be written — 

**to-unit** (2)

- logged.sh is executable — already unit (stat)
- logHookFailure writes one tab-separated line with the message on one line, cut to 500 characters — already unit (tools/ledger/hook-failures.ts)

</details>

<details><summary><code>tests/rules-gates.test.ts</code> — 55 tests</summary>

**to-unit** (22)

- a full render names every agent, so the gate checks below can see them — already unit (buildRules on real rules)
- rules rendered for features codex,codex-runner,gpt-6.2-sol name only deployed agents — already unit
- rules rendered for --no-codex name only deployed agents — already unit
- rules rendered for --agents researcher name only deployed agents — already unit
- rules rendered for --agents runner … — already unit
- rules rendered for --agents ui-runner … — already unit
- rules rendered for --agents opus-implementer … — already unit
- rules rendered for --agents fable-implementer … — already unit
- rules rendered for --agents sol-implementer … — already unit
- rules rendered for --agents astra-implementer … — already unit
- rules rendered for --agents astra-reviewer … — already unit
- rules rendered for --agents codex-runner … — already unit
- rules rendered for --agents reviewer … — already unit
- rules rendered for --agents researcher omit the wrapper-only Codex rule without codex-runner — already unit
- rules rendered for --agents sol-implementer omit the wrapper-only Codex rule … — already unit
- rules rendered for --agents codex-runner keep the wrapper-only Codex rule — already unit
- rule 40 keeps the rows of deployed agents whose lines HEAD did not gate on a model — already unit (model gating of rows)
- with all agents and models opus-5.5,sonnet-5.5, no rule names an agent that rule 40 has no row for — already unit
- with all agents and models opus-5.5,gpt-6.2-sol,haiku-5.5, … — already unit
- rule 10 sends reviews to reviewer, and astra-reviewer after it, only where both are deployed — already unit (gating)
- the ui-runner row of rule 40 needs argent — already unit (gating)
- the wrapper-rule check rejects a rule that continues on an indented line — already unit (tests the test helper)

**merge** (7)

- rule 10 asks the clear point with the question widget, not as a typed sentence — into #21 (one clear-point table test)
- rule 10 offers the clear point after each review verdict with work left, rejected ones included — into #21
- rule 10 offers the clear point when a size reminder arrives — into #21
- rule 10 has the agent run /ledger:next on "Save, clear and continue" — into #21
- rule 10 has the operator type /ledger:close on "Close" — into #21
- rule 10 accepts and finishes after the last review verdict, with no clear point — into #21
- rule 10 tells the operator how to clear when /ledger:next cannot — into #21

**wording** (26)

- the ledger sections of rule 10 state policy in 300 to 650 words and point to ledger --help — structural: word budget + names `ledger --help`
- rule 10 names the three clear-point options in order — structural: labels exist in order
- each sentence of the ledger sections of rule 10 is under 20 words — structural: style lint, keep
- /ledger:update ends a cycle with work left on the clear-point widget question — structural: update.md names AskUserQuestion + label
- rule 10 states each ledger rule in exact words — drop: pure prose (keep only `## Compact Instructions` heading check)
- the Plan gate of rule 10 reads the design refs … LLP (D47) — drop: pure prose
- rule 10 writes every /ledger:go, /ledger:parent, /ledger:task and /ledger:retire with its argument — structural: keep (no bare command)
- rule 30 points to ledger tree --help for making a parent task — structural: command named
- rule 10 says what a pipeline boundary is where it asks for a ledger update — drop: pure prose
- rule 10 keeps durable facts out of the ledger — drop: pure prose
- rule 10 sends one subagent per child task in another repo — drop: pure prose
- rule 10 says retire updates the parent ledger, so the child report is written first — drop: pure prose; merge target of ledger-task-command #23
- no rule names the retired ledger scripts or the dashboard — structural: keep; merge target of ledger-task-command #46 (extend to commands/*.md)
- no rule maps a gate to its agent with "That context is" — drop: stale-phrase negative
- the rules hold exactly one pipeline line, in rule 40, with its stages and agents in order — structural: one `Pipeline:` line; drop exact text
- the full rule 40 render holds every agent row of the former fleet reference rule — structural: covered by #1/#31 (row per agent); drop fixture-row equality
- the Fable bullet of rule 40 forbids untrusted input and security- or biology-adjacent work — structural: keep (safety constraint)
- the Codex wrapper rule in the rule 60 source is one line of short sentences — structural: keep (needs-block gating depends on one line)
- docs/fleet.md links to rules 10 and 40 instead of copying the agent table — structural: keep
- rule 10 ends a task with the question ledger task gate finalize prints, and repeats it up the tree — structural: names `ledger task gate finalize`; merge target of ledger-task-command #25/#34
- rule 20 names every gate ledger task gate knows — structural: compare listed gates to `ALL_GATE_NAMES` (tools/ledger/gates.ts); merge target of ledger-task-command #27
- rule 10 merges a PR only on "Merge now", and ends a task with no PR only on "Goal met" (D4, D15) — structural: names gate merge/goal + `ledger task done`; merge target of ledger-task-command #26
- the Failure gate of rule 10 sends a rejected review back with ledger notes stage … (D22) — structural: names `ledger notes stage review fail --back build`
- the Failure gate … tells the operator what failed in a subagent … (D23) — drop: pure prose
- the Failure gate … sends a merge conflict back to build … (D24) — drop: pure prose
- the Failure gate … names ledger task gate abandon, then ledger task abandon (D25) — structural: keep (order of commands)

</details>

<details><summary><code>tests/ledger-task-command.test.ts</code> — 54 tests</summary>

**to-unit** (7)

- ledger task new --kind docs writes - kind: docs as the last ## Location bullet of a backlog task — in-process: runInProcessWith + memoryStore (`task new`)
- ledger task new replaces the kind of a template that has a - kind: line — in-process: runInProcessWith + memoryStore
- ledger task new without --kind writes - kind: code — in-process: runInProcessWith + memoryStore
- (unsure) ledger task new --stack and --here write the kind given — in-process runInProcess; real git worktree stays as setup. unsure: --stack makes a worktree via git
- (unsure) ledger task new with an unknown --kind fails, names the kinds, and makes no ledger, worktree or branch — in-process runInProcess (code 1 + stderr). unsure: asserts no branch via real git
- ledger go keeps the kind of a backlog task in its worktree ledger — in-process runInProcess (go uses git worktree as setup)
- a task made with --kind docs goes from plan straight to build — in-process runInProcess (`notes stage`)

**merge** (9)

- /ledger:task still hands over the start: line when a current ledger exists — into #4 (same step 7)
- /ledger:help says /ledger:task continues in this session without a current ledger — into #6 (same HELP line)
- the parent task rule states both directions — into rules-gates.test.ts "rule 10 says retire updates the parent ledger, so the child report is written first"
- a task becomes done on "Merge now" or "Goal met", through ledger task done, before End of task — into rules-gates.test.ts "rule 10 merges a PR only on \"Merge now\"… (D4, D15)" (same sentences)
- the writing rule takes the widget of each gate ledger task gate knows from it — into rules-gates.test.ts "rule 20 names every gate ledger task gate knows"
- the agent retires without --force after a dry run — into rules-gates.test.ts "rule 10 ends a task with the question ledger task gate finalize prints…" (+ "states each ledger rule" for --force)
- /ledger:go passes picked LLPs to bin/ledger task with --design-refs, and its new-task steps edit no ledger — into #43
- no ledger mod command names a removed script — into rules-gates.test.ts "no rule names the retired ledger scripts or the dashboard" (one table over rules/ + mods/ledger/commands/)
- ledger task new adds the kind as the last ## Location bullet when the template has no - kind: line — into #47 (same command, same assertion)

**wording** (37)

- /ledger:task continues in this session when there is no current ledger — structural: fold #1-3 into one: task.md step 8 names EnterWorktree, `ledger go`, `ledger task gate plan`
- /ledger:task without a current ledger reads the new ledger and follows the plan gate — structural (see #1)
- /ledger:task without a current ledger starts the backlog task with ledger go, then enters the worktree it printed — structural (see #1)
- /ledger:task with a current ledger leaves the task in the backlog — structural: step 7 does not name `ledger go`
- /ledger:task describes both cases in its frontmatter — drop: pure prose
- /ledger:help says /ledger:task starts the task at once without a current ledger — drop: HELP prose
- no document says promotion branches from the current main branch — drop: stale-phrase negative
- /ledger:help and the /ledger:all description both mention backlog tasks — drop: pure prose
- each document names the stored --base first when it describes where promotion branches from — drop: docs prose
- the README /ledger:all row describes the one table ledger list prints — drop: README prose
- the new-work rule makes work outside the ledger goal a new task — drop: pure prose
- the usage guide covers the case with no open task — drop: docs prose
- the usage guide presents the start: line only for the case with another task open — drop: docs prose
- the README says /ledger:task continues in this session when no task is open — drop: README prose
- the README no longer says /ledger:update starts a task — drop: README prose
- /ledger:update with no ledger creates nothing and points to /ledger:task — structural: update.md names `/ledger:task`
- /ledger:help no longer says /ledger:update starts a task — drop: HELP prose
- the installation guide no longer says /ledger:update starts a task — drop: stale-phrase negative
- the Plan gate requires a parent task for two or more separately shipped parts, before child work — drop: pure prose
- the Plan gate makes the current task the first child task — drop: pure prose
- the Plan gate asks for approval only for a task with more than one file or a design choice — structural: Plan gate names `ledger task gate plan` + `ledger notes plan summary`
- the writing rule gives an approval question the action, "Not yet" and Close — drop: pure prose (gate labels tested in ledger-gates)
- the writing rule states the multi-select Close rule — drop: pure prose (Close text tested in ledger-gates)
- the writing rule asks in plain text during a walkthrough of a document — drop: pure prose
- the writing rule starts an open-answer question with ❓ and keeps the walkthrough exception — drop: pure prose
- the end-of-task retires leave the worktree only when needed and never retire an unmerged branch — drop: pure prose
- ticked options run in a fixed order: dry runs, leave the worktree, retires, then /ledger:go — structural: keep (step order)
- no rule says only the operator runs a retire — drop: stale-phrase negative
- starting or resuming a task shows the operator its task tree — drop: pure prose
- resuming continues from the ledger for go, go <slug> and a backlog task — drop: pure prose
- /ledger:help says /ledger:next names the next child task of a finished child task — drop: HELP prose
- /ledger:task makes the parent task first for a request with separately shipped parts — structural: task.md names `bin/ledger tree add/order/depends`
- /ledger:task selects LLP numbers in a separate step before running the script — drop: pure prose
- /ledger:task runs bin/ledger task, which takes no --refs, and writes picked LLPs on the design refs line — structural: one `task new` example, no removed `--refs`
- /ledger:task passes picked LLPs to bin/ledger task with --design-refs, and does not edit the backlog ledger — structural: names `--design-refs`
- /ledger:go makes a new task with bin/ledger task, then starts it with bin/ledger go — structural: go.md names both commands, no `--promote`
- /ledger:task and /ledger:go always pass --kind to ledger task new — structural: names `--kind` + kinds (could derive kinds from source)

**delete** (1)

- (unsure) a finished task ends with one multi-select question for retire and the next task — stale: asserts "When the work is merged, or the operator calls it finished", but rules/10-operating-model.md:147 now reads "When a task becomes done" → likely failing now; covered by #26 and rules-gates "rule 10 ends a task with the question ledger task gate finalize prints…". unsure: not run

</details>

<details><summary><code>tests/ledger-gates.test.ts</code> — 40 tests</summary>

**to-unit** (36)

- the pr gate offers Commit, push and open the PR, Not yet and Close — already unit (`gateQuestion`)
- without a slug, each gate question still names its subject and stands alone — already unit
- the builder appends Close last, after the actions in their order — already unit (`buildGate`)
- only the first action carries "(Recommended)" — already unit
- the single-select Close saves where the task stands and stops, and runs nothing else — already unit
- the multi-select Close says ticked options run first, and alone it only stops — already unit
- a gate with more than three actions, or none, is refused — already unit
- an action with an empty label or description is refused — already unit
- no Close description mentions the ledger — already unit
- each build returns fresh options: changing one result leaves the next build alone — already unit
- a header longer than 12 characters is refused — already unit
- ledger task gate plan asks to approve the plan by its summary and step count, … — in-process: runInProcessWith + memoryStore (`task gate plan`)
- the plan gate counts one step as "1 step" — in-process (same)
- ledger task gate plan refuses a plan with no summary, and names the command that sets one — in-process (code 1/stderr)
- ledger task gate plan refuses a plan with no steps — in-process
- ledger task gate takes the slug of the worktree it runs in — in-process (cwd → task)
- ledger task gate in an untitled worktree ledger takes the folder slug — in-process
- ledger task gate outside a task asks about this task — in-process
- ledger task gate plan outside a task, with no slug, says to name one — in-process
- the finalize gate of a child with a sibling in the backlog offers to retire it, then to start the sibling — in-process: runInProcessWith + memoryStore (`task gate finalize`)
- the finalize gate of the last child offers to retire it, then to finalize the parent — in-process
- the finalize gate groups the other done tasks of the repo into one action that names each — in-process
- the finalize gate leaves out a done task whose worktree is on another machine … — in-process
- the finalize gate leaves out the other done tasks when there are none, … — in-process
- the finalize gate of a task with no parent says it is the top of its tree … — in-process
- the finalize gate says the session leaves the worktree first only when it runs inside the worktree it retires — in-process (cwd)
- the finalize gate of a backlog task says retiring it archives the ledger, with no worktree to remove — in-process
- the finalize gate of a parent with a child not retired offers no retire, and starts its next child — in-process
- ledger task gate finalize with nothing to offer exits 1 with a plain message — in-process
- ledger task gate finalize outside a task, with no slug, says to name one — in-process
- ledger task gate names the finalize gate in its help and when a name is unknown — in-process (help + unknown name)
- the abandon gate asks to abandon the task, offers Abandon task, Not yet and Close, … — already unit
- ledger task gate abandon prints the abandon question for the task of the worktree it runs in — in-process
- ledger task gate merge asks to merge the PR that passed, with Merge now, Not yet and Close (D4) — pure `gateQuestion('merge')` (no store needed)
- ledger task gate goal asks whether the goal of a task with no PR is met, … (D15) — pure `gateQuestion('goal')`
- the gates come in the order of the lifecycle: plan, pr, merge, goal, abandon — already unit

**merge** (3)

- every gate header fits the widget: 12 characters at most — into #3 (same GATE_NAMES loop)
- a description with a carriage return is refused — into #10
- ledger task gate with an unknown name exits 1 and lists the gates — into #35 (same `gate ship` run)

**delete** (1)

- the registry has the plan and pr gates — covered by #40 "the gates come in the order of the lifecycle…"

</details>

<details><summary><code>tests/build-rules.test.ts</code> — 18 tests</summary>

**keep-e2e** (2)

- (unsure) build-rules rejects unknown CLI options and missing option values with exit 2 — only coverage of `parseArguments` (tools/cli.ts), which calls process.exit(2); no other test imports it. unsure: to-unit if parseArguments took argv and threw
- (unsure) build-rules supports argparse option abbreviations and help — same parser; unsure: same as #15

**to-unit** (15)

- (unsure) build-rules vocabulary is sorted and bypasses feature validation and output creation — `main()` in tools/build-rules.ts. unsure: main is not exported and reads process.argv
- build-rules gates whole files, retains frontmatter, and reports sorted skipped names — `buildRules` (mock console.log, as rules-gates does)
- build-rules filters nested blocks and normalizes blank runs and final whitespace — `buildRules`
- build-rules suppresses a satisfied inner block when its parent is absent — `buildRules`
- build-rules requires codex for every codex-only model — `buildRules`
- build-rules replaces output symlinks without changing their sources — `buildRules`
- build-rules replaces dangling symlinks and keeps unrelated or skipped output files — `buildRules`
- build-rules normalizes universal newlines and retains indented markers literally — `buildRules`
- build-rules writes a newline for empty content and ignores nested directories — `buildRules`
- build-rules rejects unknown features before creating output — `buildRules` returns 1 (mock console.error)
- build-rules rejects unmatched closing marker — `buildRules`
- build-rules rejects unclosed opening marker — `buildRules`
- build-rules skips malformed blocks inside a gated-out file — `buildRules`
- build-rules creates an empty output directory for a missing source — `buildRules`
- (unsure) build-rules requires --out — `main()`. unsure: needs main exported

**merge** (1)

- build-rules help names the TypeScript program — into #16 (same `--help` run)

</details>

<details><summary><code>tests/apply-policy.test.ts</code> — 22 tests</summary>

**keep-e2e** (1)

- policy CLI preserves dry-run and required or skipped Codex reports — only CLI test: flag handling, report text, exit 1 for missing codex config

**to-unit** (19)

- (unsure) policy merge preserves foreign hooks and local keys while applying owned keys — `applyJson` (tools/apply-policy.ts). unsure: stdout report line comes from the CLI; assert the returned changed list instead
- a group that mixes an owned command with a prompt hook is yours and survives unchanged — `applyJson(POLICY, target, backup)`
- an owned command under your own matcher survives unchanged — `applyJson`
- foreign entries keep their order and owned entries follow them — `applyJson`
- settings from the bash ledger hooks end with each ledger hook once, as ledger hook, and no duplicate gate — `applyJson`
- removing the bash ledger hooks keeps your own hooks, also in an entry that held one of them — `applyJson`
- settings from before logged.sh end with each hook script once, run through logged.sh — `applyJson`
- absent settings are created from policy with all keys changed and none kept — `applyJson` on a missing target
- JSON output preserves merged values and backup metadata — already unit
- JSON dry run reports changes without writing or backing up — already unit
- policy allow rules follow your own, once each, and your other permissions stay — already unit
- applying allow rules a second time changes nothing and keeps your own rules — already unit
- policy allow rules are exactly the everyday ledger commands — already unit (deliberate exact list)
- TOML editing is line based, normalizes newlines, and preserves local tables — already unit
- TOML current policy does not create a backup — already unit
- TOML preserves large local integers and inserts compact arrays with distinct numeric types — already unit
- policy rejects invalid UTF-8 in policy or live files without changing or backing up targets — already unit
- invalid TOML refuses both a real apply and dry run without mutations — already unit
- applyToml writes string, integer and array values from a custom policy — already unit

**merge** (2)

- applying policy a second time reports no changes — into #15 (table: LIVE settings + OWN_PERMISSIONS, via applyJson)
- absent settings get the policy allow rules — into #9

</details>

<details><summary><code>tests/codex-wrappers.test.ts</code> — 10 tests</summary>

**wording** (10)

- Codex wrapper sol-implementer waits on a done-file with Monitor — structural: keep (frontmatter tools include Monitor; names done-file)
- Codex wrapper sol-implementer creates the done-file only when Codex ends — structural: keep only `timeout_ms: 1800000`, no deadline > 600000, `touch` after the codex command; drop the rest of the phrase regexes
- Codex wrapper astra-implementer waits on a done-file with Monitor — structural (as #1)
- Codex wrapper astra-implementer creates the done-file only when Codex ends — structural (as #2)
- Codex wrapper astra-reviewer waits on a done-file with Monitor — structural (as #1)
- Codex wrapper astra-reviewer creates the done-file only when Codex ends — structural (as #2)
- Codex wrapper codex-runner waits on a done-file with Monitor — structural (as #1)
- Codex wrapper codex-runner creates the done-file only when Codex ends — structural (as #2)
- the routing rule sends Codex work to a wrapper, not to codex exec — structural: keep (negative check)
- the orchestrator never runs the Codex CLI itself — drop: pure prose (rules-gates "Codex wrapper rule in the rule 60 source…" checks the rule exists)

</details>

<details><summary><code>tests/helpers.test.ts</code> — 4 tests</summary>

**to-unit** (4)

- snapshot tells an empty file from an empty directory — already unit (`snapshot` in tests/helpers.ts)
- snapshot tells apart files whose bytes are not valid UTF-8 — already unit
- snapshot tells a symlink from a file that holds its target path — already unit
- snapshot is equal for equal trees — already unit

</details>

<details><summary><code>tests/ledger-help.test.ts</code> — 2 tests</summary>

**to-unit** (1)

- /ledger:help lists the base /ledger and every markdown command of the ledger mod — already unit (structural: `HELP` vs commands/*.md)

**wording** (1)

- /ledger:deploy deploys the latest main and tells the operator what to reload, … — structural: deploy.md exists and names `ledger deploy --latest --json`

</details>

<details><summary><code>tests/llp-refs.test.ts</code> — 17 tests</summary>

**to-unit** (14)

- llp-refs accepts a valid corpus with references, anchors and links — already unit (`checkLlp`, tools/llp-refs.ts)
- llp-refs rejects an unknown or missing type and a Type line that disagrees with the file name — already unit
- llp-refs rejects a number used by two documents — already unit
- llp-refs rejects missing header lines, a bad date and a wrong or missing heading — already unit
- llp-refs rejects a Related line that names a missing document — already unit
- llp-refs rejects references to missing documents and anchors in every scanned file type — already unit
- llp-refs rejects relative links in LLP documents that point to missing files — already unit
- llp-refs reports nothing for a repo without an llp folder — already unit
- llp-refs still reports a dangling @ref in a repo without an llp folder — already unit
- llp-refs finds no problems in this repo — already unit (repo lint; slowest here, scans repo)
- llp-refs warns when a changed file references LLP 0000 but LLP 0000 is unchanged — already unit (`llp0000Warnings`)
- llp-refs skips a changed path that no longer exists — already unit
- llp-refs skips a changed path that is a directory — already unit
- llp-refs does not join a reference across lines — already unit

**merge** (3)

- llp-refs does not warn when LLP 0000 changes too — into #11 (table over changed-file lists, same fixture)
- llp-refs does not warn for a changed file without an LLP 0000 reference — into #11
- llp-refs warns for an LLP 0000 reference with an anchor — into #11

</details>

<details><summary><code>tests/statusline.test.ts</code> — 17 tests</summary>

**keep-e2e** (12)

- /bin/bash > status line preserves output and snapshots only populated limits: undefined — bash script
- /bin/bash > … populated limits: {} — bash
- /bin/bash > … populated limits: {"five_hour":null,"seven_day":null} — bash
- /bin/bash > … populated limits: {five_hour 85.2, seven_day 65.8} — bash
- /bin/bash > status line preserves branch, cwd fallback and a single window — bash + real git branch
- /bin/bash > D28: status line shows the task and stage that ledger statusline prints for the raw cwd, after the branch — bash calls ledger
- /bin/bash > D28: status line is unchanged when ledger statusline prints nothing — bash
- /bin/bash > D28: status line is unchanged when ledger statusline fails — bash
- /bin/bash > D28: status line runs no npm ci when ledger has no installed dependencies, and shows no task — real bin/ledger shim behaviour
- /bin/bash > snapshot failure does not affect status line output — bash
- /bin/bash > missing limits preserve the previous snapshot — bash
- /bin/bash > snapshot write leaves no temporary files and preserves rate-limits.json bytes — bash

**delete** (5)

- (unsure) /bin/bash > byte equality with the old inline status line: under HOME — covered by #1-#4 (exact bytes asserted). unsure: legacy-parity intent
- (unsure) /bin/bash > byte equality …: outside HOME — covered by #5/#7 (cwd outside HOME, exact output). unsure: as #12
- (unsure) /bin/bash > byte equality …: with rate_limits — covered by #4. unsure: as #12
- (unsure) /bin/bash > byte equality …: without rate_limits — covered by #1. unsure: as #12
- (unsure) /bin/bash > byte equality …: git branch — covered by #5/#6. unsure: as #12

</details>

<details><summary><code>tests/usage-pace.test.ts</code> — 31 tests</summary>

**keep-e2e** (31)

- /bin/bash > silent when missing — bash
- /bin/bash > silent when on pace — bash
- /bin/bash > silent when weekly threshold is strict — bash
- /bin/bash > silent when stale — bash
- /bin/bash > silent when reset passed — bash
- /bin/bash > silent when five hour stale — bash
- /bin/bash > silent when invalid capture time — bash
- /bin/bash > weekly threshold is strict at an even pace of 20 percent — bash
- /bin/bash > Codex weekly at an even pace of 20 percent permits routing — bash
- /bin/bash > weekly ahead routes with unknown Codex and valid prompt JSON — bash
- /bin/bash > five hour ahead routes and includes both valid Claude windows — bash
- /bin/bash > stale five hour is omitted while weekly data remains actionable — bash
- /bin/bash > Codex weekly ahead — bash
- /bin/bash > Codex weekly at pace — bash
- /bin/bash > Codex short high — bash
- /bin/bash > Codex short threshold — bash
- /bin/bash > Codex long window — bash
- /bin/bash > Codex uses newest mtime and last non-null rate limits — bash
- /bin/bash > Codex newest file with pinned BSD stat — bash + real stat
- /bin/bash > Codex newest file with pinned GNU stat — bash + gstat (skips without it)
- /bin/bash > Codex secondary window can be high when primary is empty — bash
- /bin/bash > Codex unknown when expired — bash
- /bin/bash > Codex unknown when unpopulated — bash
- /bin/bash > Codex unknown when old file — bash
- /bin/bash > malformed snapshot never blocks prompt — bash
- /bin/bash > even pace is clamped at zero before the window starts — bash
- /bin/bash > no agent files means no output even when ahead (json=false) — bash
- /bin/bash > json mode prints computed fields without agent files — bash
- /bin/bash > astra implementer alone enables routing — bash
- /bin/bash > Codex unknown without a rate limits line: [] — bash
- /bin/bash > Codex unknown without a rate limits line: [{"payload":{"other":true}}] — bash

</details>

<details><summary><code>tests/wizard.test.ts</code> — 18 tests</summary>

**to-unit** (16)

- wizard runs only with no arguments and a terminal on both stdin and stdout — already unit (`shouldRunWizard`)
- default deploy answers map to no flags — already unit (`answersToArgs`)
- each component turned off maps to its --no flag — already unit
- turning off the mods component maps to --no-mods, which deploy accepts — already unit
- --agents appears only when the selection differs from the set the flags imply — already unit
- --agents and --models keep the order of the source lists — already unit
- force and the preview add --force and --dry-run — already unit
- revert maps to --revert, plus --dry-run for the preview — already unit
- every component combination parses and never requires Codex — already unit
- environment detection reports nothing found instead of throwing — already unit (`detectEnvironment`)
- the git hook guard counts as detected when core.hooksPath names its directory in any spelling — already unit (`detectedComponents`)
- a relative core.hooksPath never counts as the guard, even from the home directory — already unit
- detected components pass the other findings through — already unit
- --migrate parses alone and with --dry-run — already unit (`parseDeployArguments`)
- --migrate refuses every flag that shapes a deploy of files, and names it — already unit
- --agents and --models refuse a flag in place of their value — already unit

**merge** (2)

- --models lists selected Codex models in canonical order — into #6
- migrate maps to --migrate, plus --dry-run for a preview — into #9 (table over revert/migrate)

</details>

<details><summary><code>tests/wizard-pty.test.ts</code> — 19 tests</summary>

**keep-e2e** (10)

- asking for each file reads the answer, and n skips the file — PTY prompt
- asking for each file reads the answer, and y backs the file up and links it — PTY prompt
- replacing all files backs them up and links them without asking — PTY
- Ctrl-C exits 1 and leaves HOME as it was — terminal signal
- cancelling after the preview exits 1 and leaves HOME as it was — PTY
- cancelling at the choice for files of your own exits 1 and leaves HOME as it was — PTY
- a deploy that fails after the preview reports the error and its status — real deploy child exit status relay
- a preview that throws is reported, and the wizard says nothing was written — PTY
- after a deploy, the wizard lists the other pending moves and yes runs them — the one PTY test of the after-deploy move confirm
- Migrate lists the pending moves and runs them, without deploying files — the one PTY test of the Migrate screen

**to-unit** (9)

- (unsure) after a deploy, the wizard moves the .claude/ledger.md files without asking, and asks nothing when no other move is pending — wizard after-deploy move step (tools/wizard.ts ~L215-250) in-process with mocked prompts. unsure: no seam
- (unsure) after a deploy, no leaves the other pending moves as they are and names deploy --migrate — as #9. unsure: no seam
- (unsure) Migrate with nothing to move offers only the store switch, and a store switch whose preview fails changes nothing — Migrate screen in-process. unsure: no seam
- (unsure) Migrate whose check fails shows only the warning, and still offers the store switch and Cancel — tools/wizard.ts:229 warn path. unsure: no seam
- (unsure) a store switch shows what the move would copy, and no leaves the store as it is — store-switch step in-process. unsure: no seam; skipped without sqlite
- (unsure) a store switch that is confirmed moves the ledgers and sets the storage — as #15. unsure: is the switch itself covered by a store-migrate test? not checked
- (unsure) after a deploy, the wizard shows the tasks that stay, with why, and asks nothing when none can move — `canRun`/note at tools/wizard.ts:223; content covered by ledger-pending-moves "migrate --pending lists the tasks that need a person apart…". unsure: no seam
- (unsure) after a deploy, the wizard shows no moves when only finished tasks of a gone repo stay under its folder name — covered in content by ledger-pending-moves "…only finished tasks under a folder name that is gone…". unsure: no seam
- (unsure) after a deploy, yes runs the other moves and names no finished task of a gone repo — as #17. unsure: no seam

</details>

<details><summary><code>tests/ledger-run.test.ts</code> — 10 tests</summary>

**keep-e2e** (1)

- git runs with io.env: its PATH and the variables only io.env has — real git child process through a PATH stub

**to-unit** (9)

- help goes to the run, not to this process — already in-process; needs no repo
- a refused command gives its exit code and message, as text and with --json — already in-process; memoryStore possible
- commander's own refusal of an unknown option goes to the run's stderr — already in-process; needs no repo
- the store is read under io.home, not under $HOME — already in-process (file store under io.home)
- the task of the worktree the command runs in is found from io.cwd, not process.cwd() — already in-process; git worktree setup
- a claim is made for the session CLAUDE_CODE_SESSION_ID names in io.env — already in-process
- the hook acts on io.stdin — already in-process
- a run starts free of the git and lock time limits an earlier run's hook set — already in-process (mocked Date.now)
- a store given in io.store is the one read, and the run does not close it — already in-process; store injection

</details>

<details><summary><code>tests/ledger-pr-check.test.ts</code> — 6 tests</summary>

**to-unit** (6)

- a merged or closed PR is that, whatever its checks and review say — already unit (`prOutcome`, tools/ledger/pr-check.ts)
- each failed conclusion of a check run, and a failed or errored commit status, fails the checks — already unit
- a review that asks for changes needs a fix, alone or with failed checks — already unit
- a PR whose checks all passed, or that has none, is ready once approved or when no review is required — already unit
- a check still running, a stale or expected one, or a review still required leaves the PR pending — already unit
- the PR check never throws: a failure before gh answers is one line — already unit (`prCheckLines`)

</details>

<details><summary><code>tests/ledger-states.test.ts</code> — 5 tests</summary>

**to-unit** (5)

- checkTransition allows exactly the moves of the state table — already unit (`checkTransition`, tools/ledger/states.ts)
- a refused move names the task, its state, the refused state and the states it can move to — already unit
- a done task can become nothing else here; the refusal says to finalize it with the finalize question — already unit
- stateOf reads the status line, a lost mark over it, and active for neither — already unit (`stateOf`)
- checkPrLink refuses a code task without a PR link, names ledger task pr, and lets any other task pass — already unit (`checkPrLink`)

</details>


## 5. Open questions and unsure items

### Decisions for the operator

1. **Do you approve the sorting rules in section 2?**
2. **How should moved tests get a repo key without git?** There are two options:
   - (a) A test passes the key and main checkout in. This is fastest, and it needs a seam in `keyNow`/`mainCheckout`/`remoteUrls` (`tools/ledger/repo-key.ts`, `tools/ledger/git.ts`).
   - (b) One template repository is built once per file and copied for each test. This needs no code change, and each test still costs about 0.2 s.
   This decides 65 unsure repair tests and most of the repo-ids, claims and migrate moves.
3. **Should `mods/ledger/hooks/*.test.ts` run in CI or in a test script?** These 236 tests run only through `claude plugin test`, and only when someone runs it by hand. `npm test` skips them, and there is no `.github` folder. They are fast and already unit tests.
4. **Should a seam be added to `deploy()`?** It would let its child processes (apply-policy, `claude`, `ledger`, `command()`) and the `REPO` path be passed in. That moves about 70 deploy tests and saves about 650 s. Without it, most deploy rows stay real-process.
5. **Should `usage-pace.sh` be ported to TypeScript?** All 31 of its tests must run bash today, about 55 s. It is not assessed.
6. **Should `memoryStore` gain `host`/`ownHosts`?** With it, the read-only "another machine's task" refusals in `ledger-other-machines` could use the memory store instead of the file store.
7. **Is one git-store test per migrate kind enough?** In `ledger-active-migrate`, the dry-run, taken, parked and rerun git variants would go, and the moves test would stay.
8. **Do you still need the five status-line tests that compare the script byte for byte with the old inline command?** They are marked delete, because the exact-output tests cover them.

### Probably failing today (from reading, not run)

The worktree has no `node_modules`, so these were not run.

- 🟡 likely failing: `tests/ledger-task-command.test.ts` "a finished task ends with one multi-select question…" (line 185). It expects "When the work is merged, or the operator calls it finished…". `rules/10-operating-model.md` now says "When a task becomes done…". Marked delete, because the gate structure tests cover it.
- 🟡 likely failing: `tests/ledger-store-repair.test.ts` line 1075 "store repair --remote, run in the main checkout, leaves a ledger whose main line is . …". It destructures the result of the async `renamedRemote(t)` without `await`, so `repair` is undefined.
- 🟡 likely failing: `tests/ledger-store-repair.test.ts` line 2397 "store repair <slug> --to keeps a main line under ~ …". It destructures the async `start(...)` without `await`.

### Unsure items by area

- **Hooks** (`ledger-core-hooks`, 9):
  - 7 PR-check session-start tests need a gh seam in `prViews` (`pr-check.ts`).
  - The hung-git tests at L453 and L473 may work with a logging git stub.
  - L1138 is deleted because `promptSubmit` no longer lists worktrees. It may guard an old regression.
- **Repair** (`ledger-store-repair`, 65): all depend on decision 2.
  - L254 mixes refusals that need no git with ones that need a real checkout, and should be split.
  - L2164, L2241 and L2328 may not need git at all.
- **Claims** (`ledger-core-claims`, 7):
  - `go`/`retire` really add and remove a worktree (L401, L311).
  - The repo key comes from the remote URL (L356, L370).
  - The broken-lock tests (L281, L295) need `memoryStore` to model a lock that cannot be taken.
- **Git store and sync** (19):
  - L1391, L1647 and L2256 were moved on the assumption that git is only setup there. That was not confirmed.
  - The `secretLocations`/`clearStaleGitLocks`/`clearLeftoverRebase` tests could each become a one-repo unit test.
  - L2678 overlaps L2778.
  - L789 is the only sqlite → git migrate test.
- **Deploy** (6):
  - The filtered dry-run test (#13) cannot see writes from stubbed children, so #12 stays as the whole-process check.
  - The symlinked-repo marketplace test and the linked-worktree deploy tests need `REPO` as a parameter.
- **Wizard over a terminal** (`wizard-pty`, 9): they move only with a prompt seam in `runWizard`.
- **Build rules** (4): `parseArguments` in `tools/cli.ts` calls `process.exit(2)`, so its two tests stay real-process.
- **Concurrency** (`ledger-core-concurrency`, 3): it is not confirmed that two SQLite connections, or a lock held by the test's own pid, behave like two processes inside one process.
- **Raw bytes**: `show --evidence` (core-migrate L117, sqlite L304) compares binary stdout. The in-process `Ran.stdout` is a string, so these stay real-process unless `runLedger` can return bytes.
- **PATH stubs inside the test process**: repo-ids L1029 and worktrees #17 and #18 assume the in-process run passes its `env.PATH` to git. This was not checked. If it does not, they stay real-process.
- **Cross-file merges**: hooks L336 and L360 merge into tests in `ledger-awareness`. Those target tests are kept (to-unit).

### Not done

- Overlap between files was checked only where a classifier saw it. A second pass across files, for example hooks against awareness and notes against concurrency, may find more merges.
- The counts are not normalised. Some classifiers counted each loop pass as a test; others counted each `test()` call.
