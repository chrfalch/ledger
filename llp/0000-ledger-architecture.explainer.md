# LLP 0000: Ledger architecture

**Type:** Explainer
**Status:** Active
**Systems:** ledger CLI, ledger store, ledger plugin, hooks, rules, subagents
**Author:** Christian Falch / Claude
**Date:** 2026-11-19
**Related:** LLP 0001

## Summary

This document describes the ledger system as the code builds it today. A
ledger is the notes of one task: its goal, plan, decisions and next step. One
command, `ledger`, reads and writes all ledgers. A store keeps the ledgers that
are not in a worktree, as files or in one SQLite database. A Claude Code plugin
exposes the command as `/ledger:` commands. Hooks show the current ledger at
session start and block unsafe writes. Rules tell the agent when to use all of
this.

[LLP 0001](0001-ledger-workflow.plan.md) is the plan for what comes next. This
document describes only what exists.

## Overview

The system has five parts:

1. The `ledger` command, in `tools/ledger/` and started by `bin/ledger`.
2. The store, which keeps backlog ledgers, archive copies and the registry.
3. The plugin, in `mods/ledger/`, which gives Claude Code the `/ledger:`
   commands.
4. The hooks, which Claude Code runs through `ledger hook <event>`.
5. The rules and agents, in `rules/` and `agents/`, which tell the agent what
   to do.

A task has one ledger at a time. Where the ledger is tells the task's status:

| Where the ledger is | Status |
|---|---|
| Backlog, in the store | `backlog` |
| `<worktree>/.claude/ledger.md` | `active`, or `parked` with a parked mark |
| Archive, in the store | `retired` |

`toTask` in `tools/ledger/tasks.ts` sets the status this way.

## Components

### The ledger command

`tools/ledger/cli.ts` defines the commands with `commander`. `bin/ledger` runs
it. The commands are:

- `list`, `archive`, `show`, `parent`: read tasks.
- `task`: writes a backlog ledger from `~/.claude/ledger.template.md`.
- `go`: starts a task. It makes the worktree and branch of a backlog task and
  moves the ledger there. For a parent task, it starts the first child task
  that is still in the backlog.
- `park`, `unpark`: add or remove the parked mark under `## Next step`.
- `retire`: archives the ledger (see [Retire and archive](#retire-and-archive)).
- `migrate`: moves the ledgers between file and SQLite storage.
- `worktrees`: shows the linked worktrees and prunes their build folders.
- `session`: prints the ledgers a session in a folder works on.
- `hook`: answers a Claude Code hook (see [Hooks](#hooks)).
- `deploy`: runs `bin/deploy`.

Most commands take `--json`. The plugin reads that output.

### The store

`tools/ledger/store.ts` defines the store as interfaces. A `LedgerStore` has
three parts:

- `backlog`: ledgers of tasks not started yet, named by slug.
- `archive`: copies of retired ledgers, named `<YYYY-MM-DD>-<slug>`, with the
  files of their evidence.
- `registry`: the text of the task list.

A worktree's `.claude/ledger.md` is not in the store. Hooks read it from disk.

Two stores implement the interfaces:

- `fileStore` in `tools/ledger/file-store.ts` keeps files under `~/.claude`.
- `sqliteStore` in `tools/ledger/sqlite-store.ts` keeps everything in
  `~/.claude/ledgers.db`. It loads `node:sqlite` only when it is used, so the
  file store also runs on a Node without it.

`readStorage` in `tools/ledger/settings.ts` picks the store. It reads
`"storage"` from `~/.claude/ledger-settings.json`. With no file and no key, the
store is `file`. `cli.ts` opens the store that the setting names.

`migrateStorage` in `tools/ledger/migrate.ts` copies everything from one store
to the other. It reads every copy back before it switches the setting. When a
copy fails, it removes the copies it made, and nothing changes.

### The registry

`tools/ledger/registry.ts` keeps the registry, a JSON list of every task. The
plugin reads the same shape. The registry is a cache: `loadTasks` can always
rebuild it from the ledgers.

The registry tells `loadTasks` which repos to look in. When the registry is
missing or unreadable, `loadTasks` scans `~/repos` and `~/issues` for
`.claude/ledger.md` files instead. The scan roots are in
`tools/ledger/paths.ts`.

A rebuild runs git and can take seconds. So `loadTasks` does not hold the
registry while it rebuilds. It writes the result only when the registry is
still the text it read. Otherwise it starts again, up to 20 times.

### The plugin

`mods/ledger/` is a Claude Code plugin. It has two parts:

- `mods/ledger/commands/*.md`: one prompt per `/ledger:` command, such as
  `go.md`, `retire.md` and `update.md`.
- `mods/ledger/hooks/`: TypeScript that the plugin engine loads through
  `hooks.json`. `register.ts` registers the `/ledger` command and handlers for
  session start, command runs, `Skill` tool calls and turn end.

The plugin does not keep task state. `mods/ledger/hooks/cli.ts` runs
`bin/ledger` from this checkout and reads its `--json` output.

**Clearing the session.** `/ledger:next`, `/ledger:close` and `/ledger:go` end
a session. When one of them runs, `register.ts` arms a clear in the plugin's
state. The agent then writes the ledger in its turn. At the end of that turn,
the plugin clears the session. After `/ledger:next`, the new session continues
from the ledger's next step with no typing. After `/ledger:go`, it continues in
the other task. After `/ledger:close`, nothing starts.

Only the operator may type `/ledger:next`, `/ledger:close` and `/ledger:park`
(`TYPED_ONLY` in `register.ts`). The plugin refuses them when the agent starts
them through the `Skill` tool. The agent may start `/ledger:go`; Claude Code
then asks the operator for permission. A subagent may not start `/ledger:go`,
because its turn end does not clear the session.

### Hooks

`ledger hook <event>` answers four Claude Code events. `answerHook` in
`tools/ledger/hooks.ts` handles them:

- `session-start`: injects the ledgers of the session's folder, with the
  status of their parent and child tasks.
- `prompt-submit`: titles the session when the prompt is exactly
  `go <slug>`.
- `pre-compact`: tells the compaction to keep the ledger path and its next
  step.
- `pre-tool-use`: denies two kinds of tool calls. The first removes a worktree
  folder whose ledger is not archived. The second writes `.claude/ledger.md` in
  a main checkout, or writes ledger text that cites a file in a session
  folder.

When a hook fails, `tools/ledger/cli.ts` prints the error to stderr and exits
0. Claude Code then allows the tool call. A hook never blocks work by accident.

`settings.policy.json` registers the four events. Each entry runs
`"$HOME"/.claude/bin/ledger hook <event>`. Deploy merges these keys into
`~/.claude/settings.json`.

### Worktree layout

`tools/ledger/paths.ts` sets the layout:

- A task's worktree is `<main>/.claude/worktrees/<folder>`.
- Its ledger is `<worktree>/.claude/ledger.md`.
- Its evidence is `<worktree>/.claude/evidence/`.
- Backlog and archive folders are named after the main checkout's folder. Two
  repos with the same folder name share them.

`mainOfTaskWorktree` finds the main checkout from a worktree path.

### Retire and archive

`retireTask` in `tools/ledger/retire.ts` retires a task. It checks first. It
exits 1 with nothing changed when a check stops it. Checks include uncommitted
changes, an unmerged branch and active child tasks. `--force` skips these
checks. `--dry-run` prints the plan and changes nothing.

Then it does these steps:

1. Copies the ledger and the worktree's `.claude/evidence/` to the archive.
2. Removes the worktree, or the backlog ledger.
3. Marks the task retired in its parent's ledger and copies the child's
   report there.
4. Updates the task list.
5. Deletes the merged branch and the worktree's Xcode build folders.

An archive copy is never replaced. `Archive.write` throws when the name is
taken.

### Rules and agents

`rules/*.md` are the orchestrator contract. `agents/*.md` are the subagents.
`bin/deploy` links both into `~/.claude/`. With flags such as `--no-codex`,
`tools/build-rules.ts` filters the rules by their `needs:` markers, and deploy
writes the result instead of links.

`rules/10-operating-model.md` holds the ledger workflow: when a task needs a
ledger, when to update it, the clear point and the end of a task. The rules
name the `ledger` command and the `/ledger:` commands. The code does not read
the rules. The agent follows them.

## Data and storage

| Data | File store | SQLite store |
|---|---|---|
| Backlog ledger | `~/.claude/ledger-backlog/<repo>/<slug>.md` | `~/.claude/ledgers.db` |
| Archive copy | `~/.claude/ledger-archive/<repo>/<YYYY-MM-DD>-<slug>.md` | `~/.claude/ledgers.db` |
| Archive evidence | `~/.claude/ledger-archive/<repo>/<YYYY-MM-DD>-<slug>/` | `~/.claude/ledgers.db`, as bytes |
| Registry | `~/.claude/ledgers.json` | `~/.claude/ledgers.db` |
| Active ledger | `<worktree>/.claude/ledger.md` | the same file |
| Store setting | `~/.claude/ledger-settings.json` | the same file |

The file store writes backlog ledgers and the registry atomically. It holds a
lock file, `<target>.lock`, during each such write. `withLock` in `tools/ledger/lock.ts` waits
up to five seconds for a lock. It takes over a lock whose process is gone or
that is older than one minute.

A ledger is Markdown. `tools/ledger/format.ts` parses and writes it.

## Task life today

1. `ledger task` writes a backlog ledger from the template.
2. `ledger go <slug>` makes the worktree and branch, and moves the ledger
   into the worktree. The branch starts at the ledger's `- base:` line, or at
   the default branch.
3. The agent edits `.claude/ledger.md` by hand during the work. The rules say
   when.
4. `ledger park` and `ledger unpark` mark a task that waits.
5. `ledger retire` archives the ledger and removes the worktree.

A parent task stays in the backlog. Its ledger lists its child tasks.
`ledger parent` adds and removes child tasks and shows their status.

## Known gaps

The code does not track a task's stage, child order, claims or PR state. The
agent writes the ledger by hand, and only rules guard most steps. [LLP 0001
section 15](0001-ledger-workflow.plan.md#15-from-today-to-this-spec) lists each
gap and the planned work.
