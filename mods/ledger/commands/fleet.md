---
description: Work through the child tasks of a parent task in T3. Each child task that can start runs in its own T3 thread, up to a limit at a time. Questions in those threads that have a recommended option are answered with it and logged in the parent ledger; the others come to the operator. Runs only when the operator types it, and again after each child task is retired.
argument-hint: <parent>
---

The parent task: `$ARGUMENTS`. With no argument, ask
`❓ Which parent task should /ledger:fleet run?` and stop.

This command needs the T3 tools `t3_thread_launch`, `t3_thread_wait`,
`t3_thread_read` and `t3_pending_request`. Load them with ToolSearch. When
one is missing, say in one line that `/ledger:fleet` runs only in T3, and
stop.

The limit is `fleetParallel` in `~/.claude/ledger-settings.json`: a whole
number of at least 1. When the file or the key is missing, or the value is
anything else, the limit is 2; say so once when the value is invalid.

Run every `ledger` command in this file one at a time, never in parallel:
they write the shared task list.

## 1. Find the threads

The parent ledger records each thread this command started, as a note
`fleet started <child> in thread <thread id>`. Read them with
`ledger show <parent>` and make a list: child slug, its repo's main
checkout, thread id. Leave out each child whose `mark.kind` in
`ledger tree show <parent> --json` is `retired`. A later run of this command
picks the same threads up this way.

## 2. Start what can start

Run `ledger tree ready <parent> --json`. Each chain in `ready` runs from the
parent down to one child task that can start now; its last entry is the
child, with `slug` and `main`. Each chain in `running` names a child task
already started. `blocked` names each child task that waits for another.

While the number of chains in `running` plus the children started in this
step is below the limit, take the next chain in `ready`, in order:

1. Read the goal of the new child task with `ledger show <slug>`, run in its
   `main`, and the goal of each child task in the list the same way. When
   the new one names the same files or the same part of the code as one in
   the list, do not start it. Tell the operator both slugs and what they
   share, once per run of this command, and go to the next chain.
2. Run `ledger go <slug> --repo <main> --json`. When it exits non-zero,
   start nothing for this child: tell the operator the slug and the error,
   and go to the next chain. Never pass `--take-over`.
3. Read `worktree` from its output. Run
   `ledger task release <slug>@<main> --session $CLAUDE_CODE_SESSION_ID`, so
   the new thread can claim the task itself.
4. Call `t3_thread_launch` with `title` the slug, `message` `go <slug>`, and
   `workspaceStrategy` `{type: "existing_worktree", worktreePath: <worktree>}`.
5. Add the thread to the list, and record it on one line:
   `ledger notes note --task <parent> "fleet started <slug> in thread <thread id>"`

A running child task with no thread in the list was started by hand. Do not
watch it; name it once in the first report.

## 3. Wait in rounds

`t3_thread_wait` returns when a run ends, not when a thread asks a question.
So wait in rounds. A thread set aside for a permission prompt may still be
working, so each round treats it as in steps 1 to 3 below: answer what it
asks, and take it back when it asks or its newest item moves. For each
other thread in the list that is not set aside:

1. Call `t3_thread_wait` with `timeoutMs` 60000.
2. Call `t3_pending_request` with `action: "list"` and the thread id. For
   each request id, call it with `action: "read"`, then answer it as
   section 4 says.
3. Call `t3_thread_read` with `limit` 1, and note the position of its newest
   item.
4. When the run has ended and no question is pending: if this child's
   `mark.kind` in `ledger tree show <parent> --json` is `retired`, drop the
   thread from the list, run section 2 again, as a child task that waited
   for it may start now, and go on with the rounds. Otherwise the thread waits for a
   person, such as a review or a merge: set it aside and tell the operator,
   in two lines, what it waits for.
5. When the run has not ended, no question is pending, and the newest item
   has not moved for three rounds in a row, the thread may wait on a
   permission prompt, which `t3_pending_request` cannot answer, or still be
   in a long command. Set it aside and tell the operator the thread's link.

Go to section 5 when every thread in the list is set aside, and either none
is set aside for a permission prompt or ten rounds in a row changed nothing.

## 4. Answer or ask

A request holds one or more questions. `read` gives each question its
`id`, its options and whether it is multi-select.

- Answer by yourself only when each question has a recommended option: one
  whose label ends with "(Recommended)". A single-select question takes
  that one label. A multi-select question takes every recommended label,
  joined with ", ". Call `t3_pending_request` with `action: "respond"` and
  `answers` mapping each question's `id` to its value.
- Otherwise, ask the operator with AskUserQuestion. Put the child slug and
  a one-line summary of what that thread is doing in the question text, and
  offer the same options. Answer the thread with the operator's pick, or
  with the operator's own text when they typed one.
- Never type your own text as an answer. Never answer a question the
  thread did not ask.
- Log each answer on one line, with the question cut to its first sentence,
  ending ` (operator)` when the operator chose:
  `ledger notes note --task <parent> "fleet answered <child>: <question> -> <value>"`

## 5. Report and stop

After each round in which something changed, and before you stop, write the
operator one short report: for each child task, one line with its status
and thread link. Mark a finished child with 🟢, a child that waits for the
operator with 🟡, and a child whose thread failed with 🔴. A child still
working gets the word `running` and no mark.

Stop when no thread is left to watch, or every thread waits for a person.
When children are still waiting, say which, and what for: a set-aside
thread, a task in `blocked`, or a child held back because it overlaps
another. End with
one line: after a child task is retired, type `/ledger:fleet <parent>` to
start what can start next.
