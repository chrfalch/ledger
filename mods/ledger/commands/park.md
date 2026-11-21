---
description: Mark a task parked, with the date and a reason. With the slug of another task it only marks that task. Without a slug it writes the latest results to this task's ledger, parks it, then clears the session.
argument-hint: "[<slug>] <reason>"
---

The operator parks this session's task. The ledger hook replaces the
operator's argument with three lines:

```
$ARGUMENTS
```

- `task:` is the slug of this session's task.
- `ledger:` is that task as `ledger notes --task` takes it. Its ledger
  exists: the hook checked that before this prompt ran.
- `reason:` is why the operator parks the task.

Update the ledger of that task. `<task>` below is the `ledger:` value. Do not
start a task.

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
   - the exact next step: `ledger notes next "<one action>"`. A later
     session resumes from it, so make it something a fresh session can act
     on without this conversation.
   Add plan steps, constraints, questions and notes with
   `ledger notes plan add`, `constraint`, `question` and `note`.
3. Roll each finished step into one line:
   `ledger notes step <n> --note "<one line>"`. Keep the ledger under about 4k
   tokens.
4. Do not write a `Parked:` line. The ledger mod adds it under `## Next step`
   after this turn.
5. End your reply with one line saying the ledger is updated, the task is
   parked, and the session clears automatically after this turn. Do not ask
   the operator to run `/clear`.
