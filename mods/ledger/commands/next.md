---
description: Write the latest results to this task's ledger, clear the session, and continue from the next step
---

Update the ledger of the task of the current working directory. It exists:
the command checked that before this prompt ran. Do not start a task.

The block below is what the ledger hook passed for this run:

```
$ARGUMENTS
```

The block is not an example. It is the hook's instruction for this session.
An empty block means the hook passed no instruction. A block with a
`continue: typed` line means the new session cannot start by itself. The
line under it says how to queue the new session. Step 4 says when to follow
it.

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
   - the exact next step: `ledger notes next "<one action>"`. The new
     session starts from it, so make it something a fresh session can act
     on without this conversation.
   Add plan steps, constraints, questions and notes with
   `ledger notes plan add`, `constraint`, `question` and `note`.
3. Roll each finished step into one line:
   `ledger notes step <n> --note "<one line>"`. Keep the ledger under about 4k
   tokens.
4. If the argument block holds a `continue: typed` line, follow its
   instruction: queue the new session. Call `mcp__t3-code__t3_thread_list`
   and take its `currentThreadId`. As the last tool call of this turn, call
   `mcp__t3-code__t3_thread_send` with that `threadId`, `message` exactly
   `go <slug>` with this task's slug, `mode` `queue` and `freshContext`
   `true`. Then end your reply with one line. It says the ledger is updated
   and the task continues from the next step in a fresh session of this
   thread by itself, so the operator types nothing. If either tool is
   missing, or either call fails, the line instead says the ledger is
   updated, the session clears after this turn, and the operator then types
   `go <slug>`, with this task's slug, to continue from the next step.

   Otherwise, end your reply with one line saying the ledger is updated, the
   session clears automatically after this turn, and the new session then
   continues from the next step by itself, so the operator types nothing. Do
   not show `go <slug>` or any other command for the operator to type.

   In both cases, do not ask the operator to run `/clear`.
