# Task ledger — wf-task-records

Read this first in every fresh session. Update it at every pipeline boundary.
Facts, not narrative. Keep under ~4k tokens.

## Goal
Backlog and archived ledgers become structured task records in every store.

The store keeps its string API as an adapter.

## Location
- main: /repos/ledger
- worktree: /repos/ledger/.claude/worktrees/wf-task-records
- branch: wf-task-records
- base: origin/main @ 5c5a860
- design refs: 0,1
- parent: wf-records @ /repos/ledger
- title: Task records
- kind: feature
- state: active
- stage: implement
- order: 2
- depends on: wf-command-groups, wf-repo-identity @ /repos/ledger
- claim: session 42
- pr: https://github.com/chrfalch/ledger/pull/109
- repo: github.com/chrfalch/ledger

## Children
- records-file @ /repos/ledger (retired 2026-11-20)
- records-sqlite (started 2026-11-21; by hand)
- records-git

## Plan (approved 2026-11-20)
| # | step | status | owner | note |
|---|------|--------|-------|------|
| 1 | write the failing tests | done | opus-implementer | red run saved |
| 2 | implement the record type | green | opus-implementer | |
| 1-10 | rounds of review | todo | reviewer | ranges stay as written |

## Decisions
- Keep the string API — because callers stay unchanged [inferred]
- 2026-11-20: Store one JSON file per task — because git diffs stay small [observed]
- Render placeholders for empty sections
- Tags stay apart [confirmed]

## Constraints discovered
- node:sqlite cuts TEXT at a NUL byte — found in sqlite-store.ts:11 [observed]
- No any in TypeScript [observed]

## Subagent reports
- step 1: red run saved to .claude/evidence/red-records.txt
- reviewer approved round 2 [confirmed]

## Open questions
- Should records keep the date? — blocks step 2
- Is SQLite JSON1 always there?
- (resolved) Does the git store need a new allowlist? — blocks step 3

## Report
Records land in all three stores.
  PR https://github.com/chrfalch/ledger/pull/109

## Next step
Parked: 2026-11-21 — waiting for review
Run the reviewer at medium effort.

## Notes
The operator prefers small PRs.
