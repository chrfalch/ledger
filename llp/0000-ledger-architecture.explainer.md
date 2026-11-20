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
are not in a worktree, as files, in one SQLite database, or in a private git
repository that several machines share. A Claude Code plugin
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
- `task gate`: prints the question for a gate, such as plan approval, as JSON
  the question widget takes. `tools/ledger/gates.ts` defines each gate.
- `store migrate`: moves the ledgers between file, SQLite and git storage.
- `store sync`: pushes and pulls the ledgers of git storage.
- `worktrees`: shows the linked worktrees and prunes their build folders.
- `session`: prints the ledgers a session in a folder works on.
- `hook`: answers a Claude Code hook (see [Hooks](#hooks)).
- `deploy`: runs `bin/deploy`.

Most commands take `--json`. The plugin reads that output.

### The store

`tools/ledger/store.ts` defines the store as interfaces. A `LedgerStore` has
four parts:

- `backlog`: ledgers of tasks not started yet, named by slug.
- `archive`: copies of retired ledgers, named `<YYYY-MM-DD>-<slug>`, with the
  files of their evidence.
- `registry`: the text of the task list.
- `aliases`: old repo keys, each with the key that replaced it.

Each ledger is filed under its repo's key. `repoKey` in
`tools/ledger/repo-key.ts` gives it: the address of the remote `origin`, else
of the only remote, such as `github.com/chrfalch/ledger`; else the absolute path
of the main checkout. `repoLabel` gives the short form people see, such as
`chrfalch/ledger`.

A worktree's `.claude/ledger.md` is not in the store. Hooks read it from disk.

Three stores implement the interfaces:

- `fileStore` in `tools/ledger/file-store.ts` keeps files under `~/.claude`.
- `sqliteStore` in `tools/ledger/sqlite-store.ts` keeps everything in
  `~/.claude/ledgers.db`. It loads `node:sqlite` only when it is used, so the
  file store also runs on a Node without it.
- `gitStore` in `tools/ledger/git-store.ts` keeps the backlog and the archive
  ledgers in `~/.claude/ledger-data`, a clone of a private GitHub repository.
  It is the file store with other folders. After a command writes, it commits
  once and starts `ledger store sync --quiet` in the background, so a command
  never waits for the network. Only the ledgers, a `.ledger-data` marker and a
  `.gitignore` are committed. Evidence, the registry and the repo aliases stay
  on this machine.

`readStorage` in `tools/ledger/settings.ts` picks the store. It reads
`"storage"` from `~/.claude/ledger-settings.json`. With no file and no key, the
store is `file`. `openStore` in `tools/ledger/open-store.ts` opens the store
that the setting names.

`ledger store sync init <url>` makes the clone, once on each machine. It
accepts only a private GitHub repository. `ledger store sync`
(`tools/ledger/sync.ts`) commits, pulls with a rebase, checks that only ledgers
and no secret-like text go out, and pushes. A pre-push hook in the clone runs
the same secret scan (`tools/ledger/secret-scan.ts`).

`migrateStorage` in `tools/ledger/migrate.ts` copies everything from one store
to another, between any two of the three. It reads every copy back before it
switches the setting. When a copy fails, it removes the copies it made, and
nothing changes. A move into git storage commits, then pushes; a failed push is
reported, and the setting still switches.

`migrateRepoIds` in `tools/ledger/migrate-repo-ids.ts` runs once for stores
that filed ledgers under the main checkout's folder name. It moves each such
ledger to its repo key with a plain rename on the same disk, and records the
folder name as an alias only for tasks it moved. A ledger whose main checkout it
cannot find, that lies on another disk, or whose target name is taken stays
where it is, and a person moves it by hand. In git storage the moves are
committed and pushed like any other write; each machine records its aliases
itself.

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

Only the operator may type `/ledger:close` and `/ledger:park` (`TYPED_ONLY` in
`register.ts`). The plugin refuses them when the agent starts them through the
`Skill` tool. The agent may start `/ledger:next` once, right after the operator
picks "Save, clear and continue" (`CLEAR_POINT_OPTION` in `ledger.ts`) in the
clear-point question. Otherwise the plugin refuses it too.

The agent asks the clear-point question after each review verdict with work
left. It also asks when the session context passes the plugin setting
`clearPointTokens`, by default 150,000 tokens; 0 turns it off. At the end of
such a turn, `markClearPoint` in `register.ts` notes the size, unless the
task is finished. The next prompt that is not a slash command then carries
`clearPointReminder` from `ledger.ts`. The reminder comes again
only after the context grows by another `clearPointTokens`.

The agent may start `/ledger:go`; Claude Code
then asks the operator for permission. A subagent may not start `/ledger:go`,
because its turn end does not clear the session.

### Hooks

`ledger hook <event>` answers four Claude Code events. `answerHook` in
`tools/ledger/hooks.ts` handles them:

- `session-start`: injects the ledgers of the session's folder, with the
  status of their parent and child tasks. With git storage it pulls first, and
  a sync problem adds one line above the ledgers. The whole hook has one
  five-second deadline.
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
The failure is also appended as one line to `~/.claude/ledger-hook-failures.log`
(`tools/ledger/hook-failures.ts`). The shell hooks run through `hooks/logged.sh`,
which logs any exit other than 0 or 2 the same way and exits 0. The next
`session-start` puts the number of failures not yet reported, and the time of
the first, above the ledgers.

`settings.policy.json` registers the four events. Each entry runs
`"$HOME"/.claude/bin/ledger hook <event>`. Deploy merges these keys into
`~/.claude/settings.json`.

### Worktree layout

`tools/ledger/paths.ts` sets the layout:

- A task's worktree is `<main>/.claude/worktrees/<folder>`.
- Its ledger is `<worktree>/.claude/ledger.md`.
- Its evidence is `<worktree>/.claude/evidence/`.
- The file store, and the git store in its clone, name each repo folder by its
  repo key, URI-encoded, such as `github.com%2Fchrfalch%2Fledger`. A folder from
  before the repo key, named after the main checkout's folder, keeps that name
  until the conversion moves its ledgers.

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

At a gate, the agent asks the operator with the question widget. For the gates
that `ledger task gate <name>` knows, `plan` and `pr` today, the question comes
from that command, not from the rule text. The agent writes any other gate
itself, by the same rules: one to three actions, the recommended one first, and
Close last.
`rules/20-writing.md` says how to ask everything else.

## Data and storage

| Data | File store | SQLite store | Git store |
|---|---|---|---|
| Backlog ledger | `~/.claude/ledger-backlog/<repo key>/<slug>.md` | `~/.claude/ledgers.db` | `~/.claude/ledger-data/backlog/<repo key>/<slug>.md`, committed |
| Archive copy | `~/.claude/ledger-archive/<repo key>/<YYYY-MM-DD>-<slug>.md` | `~/.claude/ledgers.db` | `~/.claude/ledger-data/archive/<repo key>/<YYYY-MM-DD>-<slug>.md`, committed |
| Archive evidence | `~/.claude/ledger-archive/<repo key>/<YYYY-MM-DD>-<slug>/` | `~/.claude/ledgers.db`, as bytes | `~/.claude/ledger-evidence/<repo key>/<YYYY-MM-DD>-<slug>/`, never committed |
| Registry | `~/.claude/ledgers.json` | `~/.claude/ledgers.db` | `~/.claude/ledgers-git.json`, never committed |
| Repo aliases | `~/.claude/ledger-aliases.json` | `~/.claude/ledgers.db` | `~/.claude/ledger-aliases-git.json`, never committed |
| Active ledger | `<worktree>/.claude/ledger.md` | the same file | the same file |
| Store setting | `~/.claude/ledger-settings.json` | the same file | the same file |

The git store also keeps a clone lock, `~/.claude/ledger-data.lock`, and the
last sync problem, `~/.claude/ledger-data.status.json`, outside the clone.

The file store writes backlog ledgers and the registry atomically. It holds a
lock file, `<target>.lock`, during each such write. `withLock` in `tools/ledger/lock.ts` waits
up to five seconds for a lock. It takes over a lock whose process is gone or
that is older than one minute.

A ledger is Markdown. `tools/ledger/format.ts` parses and writes it.

## Task life today

1. `ledger task new` writes a backlog ledger from the template.
2. `ledger go <slug>` makes the worktree and branch, and moves the ledger
   into the worktree. The branch starts at the ledger's `- base:` line, or at
   the default branch.
3. The agent edits `.claude/ledger.md` by hand during the work. The rules say
   when.
4. `ledger task park` and `ledger task unpark` mark a task that waits.
5. `ledger task retire` archives the ledger and removes the worktree.

A parent task stays in the backlog. Its ledger lists its child tasks.
`ledger tree` adds and removes child tasks and shows their status.

## Known gaps

The code does not track a task's stage, child order, claims or PR state. The
agent writes the ledger by hand, and only rules guard most steps. [LLP 0001
section 15](0001-ledger-workflow.plan.md#15-from-today-to-this-spec) lists each
gap and the planned work.
