# Task ledger — literal-lines

Read this first in every fresh session. Update it at every pipeline boundary.
Facts, not narrative. Keep under ~4k tokens.

## Goal
<!-- keep this note -->
Keep every line that only looks like a placeholder.

## Location
- worktree: <path>
- branch: literal-lines
- base: <branch/commit>
- design refs: <LLP numbers, comma-separated, or none>
- pr: <https://github.com/org/repo/pull/12>

## Plan (approved <date>)
| # | step | status | owner | note |
|---|------|--------|-------|------|
| 1 | parse | done | opus-implementer | first line of the note |
  a wrapped second line of the note
| 2 | render | todo | opus-implementer | |

## Decisions
- Keep literal lines — because they are content [observed]
  wrapped onto a second line
  - a sub point under it
- <draft> stays as written — because only template strings are placeholders

## Constraints discovered
- Autolinks look like placeholders — found in review
  - and HTML comments do too

## Subagent reports
- step 1: parsed
  details on a second line

## Open questions
- Is a wrapped question kept?
  It is, as one question. — blocks step 2

## Report
<https://github.com/org/repo/pull/12>
Merged.

## Next step
<exactly one action, with the agent and effort to use>
