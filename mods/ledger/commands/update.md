---
description: Write the latest results to this task's ledger
---

If `.claude/ledger.md` exists in the current working directory, this session
is in a task worktree. Update that ledger:

1. Use Edit. Never rewrite the whole file.
2. Write facts, not narrative:
   - the status of each plan step;
   - each subagent's structured report, not its transcript;
   - each decision, with its reason;
   - the exact next step.
3. Roll each finished step into one line. Keep the ledger under about 4k
   tokens.
4. If a review verdict just came in and work remains, a rejected verdict
   included, end the turn with the clear-point question. Ask it with
   AskUserQuestion. The question says the ledger is updated and what each
   option does. Its options, in this order:
   - "Save, clear and continue (Recommended)": run `/ledger:next` with the
     Skill tool. It saves, clears the session and continues from the next
     step.
   - "Not now": continue in this session.
   - "Close": tell the operator to type `/ledger:close`. Only the operator
     can run it.

   Otherwise, end your reply with one line saying the ledger is updated.
   After the last review verdict there is no clear point: accept the work
   and finish.

If `.claude/ledger.md` does not exist, create nothing. Tell the operator to use
`/ledger:task <what the task is>`. This command only saves an open task.
