---
description: Write the latest results to this task's ledger
---

If `ledger show` succeeds in the current working directory, this session is
in a task worktree, and that is its ledger. Update it:

1. Read the ledger with `ledger show` in this session's folder. Change it with
   `ledger notes`, one item per command; `ledger notes --help` lists the
   commands. Never edit the files of the ledger store.
2. Write facts, not narrative:
   - the status of each plan step: `ledger notes step <n> --status <status>`;
   - each subagent's structured report, not its transcript: save it under
     `.claude/evidence/` in the worktree, then
     `ledger notes report --step <n> --file <path>`;
   - each decision, with its reason:
     `ledger notes decide "<decision>" --because "<reason>" --tag <tag>`;
   - the exact next step: `ledger notes next "<one action>"`.
   Add plan steps, constraints, questions and notes with
   `ledger notes plan add`, `constraint`, `question` and `note`.
3. Roll each finished step into one line:
   `ledger notes step <n> --note "<one line>"`. Keep the ledger under about 4k
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

If `ledger show` fails, there is no ledger: create nothing. Tell the operator to use
`/ledger:task <what the task is>`. This command only saves an open task.
