---
description: Write the latest results to this task's ledger, then clear the session
---

The ledger hook replaces the operator's argument with one line:

```
$ARGUMENTS
```

If the line is `ledger: none`, this session's folder no longer exists, so
there is no ledger to update. Write nothing and create nothing. Reply with one
line: there was no ledger to update, and the session clears automatically
after this turn. Stop there.

Otherwise the line is `ledger: <task>`, the task as `ledger notes --task`
takes it. Update that task's ledger. `<task>` below is that value. It
exists: the command checked that before this prompt ran. Do not start a
task.

1. Read the ledger with `ledger show` in this session's folder. Change it with
   `ledger notes <command> --task <task>`, one item per command;
   `ledger notes --help` lists the commands. Never edit the files of the
   ledger store. The examples below leave out
   `--task <task>`; add it to each.
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
4. End your reply with one line saying the ledger is updated and the session
   clears automatically after this turn. Do not ask the operator to run
   `/clear`.
