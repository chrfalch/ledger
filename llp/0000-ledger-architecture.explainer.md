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
command, `ledger`, reads and writes all ledgers. A store keeps every ledger,
as files, in one SQLite database, or in a private git repository that several
machines share. A Claude Code plugin
exposes the command as `/ledger:` commands. Hooks show the current ledger at
session start and block unsafe writes. Rules tell the agent when to use all of
this.

[LLP 0001](0001-ledger-workflow.plan.md) is the plan for what comes next. This
document describes only what exists.

## Overview

The system has five parts:

1. The `ledger` command, in `tools/ledger/` and started by `bin/ledger`.
2. The store, which keeps active and backlog ledgers, archive copies and the
   registry.
3. The plugin, in `mods/ledger/`, which gives Claude Code the `/ledger:`
   commands.
4. The hooks, which Claude Code runs through `ledger hook <event>`.
5. The rules and agents, in `rules/` and `agents/`, which tell the agent what
   to do.

A task has one ledger at a time. Where the ledger is tells the task's status:

| Where the ledger is | Status |
|---|---|
| Backlog, in the store | `backlog` |
| Active, in the store, naming its worktree | `active`, or `parked` with a parked mark |
| Active, in the store, with a lost mark | `lost` |
| Archive, in the store | `retired` |

`toTask` in `tools/ledger/tasks.ts` sets the status this way. A lost mark wins
over a parked mark. `ledger store repair <slug> --lost` writes the mark, a
Location line `- lost: <date> — folder <path> not found`, or `- lost: <date>`
for a task that records no worktree. A `- lost:` line counts as the mark only
in the exact form written for the recorded worktree. Any other `- lost:` line
is a note and is kept as it is.

## Components

### The ledger command

`tools/ledger/cli.ts` defines the commands with `commander`. `bin/ledger` runs
it. The commands are grouped by what they change (D30 in LLP 0001).
`ledger --help` lists the groups, and `ledger <group> --help` the commands of
each:

- `task`: makes, starts, claims, parks, retires and reads tasks.
  - `new`: writes a backlog ledger from `~/.claude/ledger.template.md`.
    With `--stack`, it makes the worktree and branch at once, on top of the
    current branch, and the task is active. With `--here`, it adds an active
    ledger to the linked worktree it runs in (`hereTask` in
    `tools/ledger/write.ts`). It refuses a main checkout. With no slug given,
    the slug is the last part of the branch name, else the folder name.
  - `go`: starts a task. It makes the worktree and branch of a backlog task
    and moves its ledger from the backlog to the active ledgers, naming that
    worktree. For a parent task, it starts the first child task, in order,
    that is still in the backlog and whose dependencies are all retired or
    done (`firstToStart` in `tools/ledger/write.ts`).
  - `claim`, `touch`, `release`: take, refresh and remove this session's
    claim on a task (see Claims under [The plugin](#the-plugin)).
  - `park`, `unpark`: add or remove the parked mark under `## Next step`.
  - `retire`: archives the ledger (see [Retire and archive](#retire-and-archive)).
  - `show`, `list`, `archive`: print a task's ledger, list the live tasks, or
    list the archived ledgers.
    `list` covers the live tasks of every known repo. `show` prints the
    active ledger, else the backlog ledger, else the newest archive copy, and
    can also give an archive copy's evidence files. `archive` lists this
    repo's archive, newest first, and can keep only the ledgers that contain
    a term.
  - `gate`: prints the question for a gate, such as plan approval, as JSON
    the question widget takes. `tools/ledger/gates.ts` defines each gate.
- `notes`: writes one item of a task's ledger (see
  [The notes commands](#the-notes-commands)).
- `tree`: `show` prints a parent task with the status of each child task.
  `add`, `remove`, `start`, `order` and `depends` change its children, their
  order and what each waits for. `next` prints the child task that starts
  next.
  A child task may live in another repo. The commands name it as
  `<slug>@<path>`, such as `part@../lib`, and `depends` also takes
  `<slug>@<address>`, such as `api@github.com/acme/api`. When `ledger go`
  starts a backlog child of a backlog parent, it writes the main checkout of
  the clone the child started in on the child's line in the parent
  (`nameChildClone` in `tools/ledger/write.ts`).
- `store`: `migrate` moves the ledgers between file, SQLite and git storage.
  `sync` pushes and pulls the ledgers of git storage, and `sync init` makes
  its clone.
- `worktrees`: shows the linked worktrees. `prune` and `prune-orphans` delete
  their build folders.
- `go`, `list`, `show`: short forms of the `task` commands of the same names.
- `deploy`: runs `bin/deploy`.

Two commands are for Claude Code and stay out of the help. `session` prints
the ledgers a session in a folder works on. `hook` answers a Claude Code hook
(see [Hooks](#hooks)).

Most commands take `--json`. The plugin reads that output.

### The notes commands

`tools/ledger/notes.ts` implements `ledger notes`. Each write command adds or
changes one item of the task record (D29 in LLP 0001):

| Command | Changes |
|---|---|
| `plan add "<step>" --owner <agent> [--note <text>]` | adds a `todo` step, numbered after the highest |
| `plan approve` | sets the plan's approval date to today |
| `step <n> [--status <status>] [--note <text>]` | sets the status or the note of a step, or both; `--note ""` clears the note |
| `decide "<text>" --because <reason> --tag <tag>` | adds a decision dated today |
| `constraint "<text>" --source <where> [--tag <tag>]` | adds a constraint |
| `question "<text>" [--blocks <n>]`, `question --resolve <id>` | adds an open question, or marks one resolved |
| `report --step <n> --file <path>`, `report --parent "<text>"` | sets the report of a step, or `## Report` |
| `note "<text>"` | adds a line to the general notes |
| `next "<text>"` | sets the next step |
| `stage <stage> pass [--step <n>]`, `stage <stage> fail [--back <earlier>]`, `stage <stage> --skip "<reason>"` | records the outcome of the current stage, moves the stage, and adds a dated note |

A tag is `observed`, `confirmed` or `inferred`. A step report keeps only the
path of its file: relative to the worktree when the file is inside it, else
absolute.

`ledger notes stage` keeps the stages in order. `STAGES` in `kinds.ts` lists
the stages of each kind: code, docs and investigation. `ledger task new
--kind <kind>` sets the kind, code by default, and writes it as `- kind:`. A
task with no `kind` is code. The record's `stage` is the stage the task is at,
and no `stage` means the first. The command's first argument must be that
stage. Pass and `--skip` move to the next
stage, or to `finished` after the last. Fail stays, or with `--back` returns
to an earlier stage. A later stage is refused, as is an earlier one, and the
message says to use `--skip` or `fail --back`. `--step <n>` also sets the
status of plan step n: `red` after red, `green` after build, `reviewed` after
review, `done` after any other stage.

Each command acts on the task `--task` names, or else on the task of the
worktree the command runs in. An archived task is refused. A write changes the
record in the store, through `store.backlog.update` or `store.active.update`,
which hold the record's lock. It parses the ledger with `parseRecord`, changes the record, checks
it with `validateRecord` and writes `renderRecord` of it. When the new item or
the record is wrong, the command exits 1 and writes nothing.

Every write also shortens the report of each step whose status is `reviewed`
or `done` to one line (D31 in LLP 0001). That line is the report's first
non-empty line, trimmed and cut to 160 characters. The reports of other steps stay as they are.

`ledger notes check` reads the ledger and changes nothing. It reports a
record that does not read back the same from its Markdown, an empty goal, an
open question that blocks a step not in the plan, a step report for a step
not in the plan, an unknown kind, and a stage that is not a stage of the kind
or `finished`. It also reports a ledger over `LEDGER_SIZE_LIMIT`, 16,000
characters of `renderRecord`, and names its three largest sections. Every
write runs the same rules on the record it wrote and prints what they find as
warnings, with exit 0.

A question's id is its place in the list, from 1, and is not stored. A
question that is removed or moved by hand changes the ids of the questions
after it, so `--resolve` with an id read earlier can mark the wrong question.

### The store

`tools/ledger/store.ts` defines the store as interfaces. A `LedgerStore` has
five parts:

- `backlog`: ledgers of tasks not started yet, named by slug.
- `active`: ledgers of started tasks, named by slug. Each names its worktree,
  and `byWorktree` finds the task of a worktree folder. It skips a lost task,
  so a new folder at a lost task's old path is free.
- `archive`: copies of retired ledgers, named `<YYYY-MM-DD>-<slug>`, with the
  files of their evidence.
- `registry`: the text of the task list.
- `aliases`: old repo keys, each with the key that replaced it. `replace`
  removes some aliases and adds others in one write, so a stop between the
  two cannot lose an alias.

Each ledger is filed under its repo's key. `repoKey` in
`tools/ledger/repo-key.ts` gives it: the address of the remote `origin`, else
of the only remote, such as `github.com/chrfalch/ledger`; else the absolute path
of the main checkout. `repoLabel` gives the short form people see, such as
`chrfalch/ledger`.

Hooks, commands and the plugin read an active ledger from the store too. The
worktree keeps only its `.claude/evidence/`. An active record names the machine
that started it in `- host:`: `"host"` in `~/.claude/ledger-settings.json`, else
the host name (`readHost` in `tools/ledger/settings.ts`). `activeOf` in
`tools/ledger/tasks.ts` makes a task `elsewhere`, with that host, when its
record names another host, and when git lists no worktree of it here. An
elsewhere task is read-only: `ledger go`, park, claim, retire's parent step,
`ledger notes` and `ledger tree add` and `remove` refuse it or leave it alone,
and name its host. A changed record of another host is put back, never
committed (`commitChanges` in `tools/ledger/clone.ts`). The owner of a record
is read from its committed copy in HEAD, so an edit on disk cannot make another
machine's record this one's. Only a record HEAD lacks is read from disk
(`recordOwner` in `tools/ledger/clone.ts`).

"Another host" means a label that is not among `ownHosts`. Each label a machine
stamps on a record goes into `~/.claude/ledger-hosts.json`, a list that stays
on that machine and is never synced (`noteOwnHost` in
`tools/ledger/settings.ts`). Each store gives that list, with the current label,
as `ownHosts`. So after `"host"` changes, the records a machine stamped earlier
are still its own. `updateActive` in `tools/ledger/write.ts` stamps the current
label on such a record at its next write.

Three stores implement the interfaces:

- `fileStore` in `tools/ledger/file-store.ts` keeps files under `~/.claude`.
- `sqliteStore` in `tools/ledger/sqlite-store.ts` keeps everything in
  `~/.claude/ledgers.db`. It loads `node:sqlite` only when it is used, so the
  file store also runs on a Node without it.
- `gitStore` in `tools/ledger/git-store.ts` keeps the active, backlog and
  archive ledgers in `~/.claude/ledger-data`, a clone of a private GitHub repository.
  It is the file store with other folders. After a command writes, it commits
  once and starts `ledger store sync --quiet` in the background, so a command
  never waits for the network. Only the ledgers, a
  `.ledger-data` marker and a `.gitignore` are committed. Evidence, the
  registry and the repo aliases stay on this machine.

`readStorage` in `tools/ledger/settings.ts` picks the store. It reads
`"storage"` from `~/.claude/ledger-settings.json`. With no file and no key, the
store is `file`. `openStore` in `tools/ledger/open-store.ts` opens the store
that the setting names.

`ledger store sync init <url>` makes the clone, once on each machine. It
accepts only a private GitHub repository. `ledger store sync`
(`tools/ledger/sync.ts`) commits, pulls with a rebase, checks that only ledgers
and no secret-like text go out, and pushes. A pre-push hook in the clone runs
the same secret scan (`tools/ledger/secret-scan.ts`). Both read a line of a task
record also with its JSON escapes undone, so a secret after an escaped line
break starts a line, as it does in Markdown.

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

`migrateActive` in `tools/ledger/migrate-active.ts` runs once for ledgers from
before active records. It moves the `.claude/ledger.md` of each linked worktree
into an active record that names the worktree, and deletes the file;
`.claude/evidence/` stays. A ledger whose slug or worktree is taken stays as it
is, for a person to merge. Until it runs, `session-start` says how many are
left.

`repairStore` in `tools/ledger/repair.ts` runs `ledger store repair`. It takes
flags only and never prompts:

- With no task, it reports two kinds of problem in every repo of the store. The
  first is an active task of this machine, neither parked nor lost, whose
  recorded folder is gone. The second is a repo key whose tasks name a main
  checkout that has another key now, as after a renamed remote. It prints the
  command that fixes each, and exits 1 when it finds one.
- `--search <folder...>` adds, for each missing task, the linked worktrees of
  its repo on its branch. It looks only in the named folders, 6 levels down,
  and follows no symbolic link. It is the only command that searches the disk
  for a task's folder.
- `<slug> --to <folder>` points the task at a new folder and runs
  `git worktree repair` there. It refuses a parked task, also one marked lost.
  It refuses a main checkout, a folder on another branch, a folder another
  record names, and a checkout whose repo key differs from the task's after
  aliases are resolved.
- `<slug> --lost` marks the task lost. It refuses a parked task, and it
  refuses while the folder exists.
- `--to` and `--lost` both refuse a task whose record names a host that is
  none of this machine's.
- `--remote <old-key>` moves the active, backlog and archive tasks of the old
  key to this repo's key, as `migrateRepoIds` does. A task stays under the old
  key when its main checkout is gone or is a checkout of another repo, or when
  it names no main checkout and no old → new alias exists yet. An active or
  backlog task also stays when the new key already has a live task with its
  slug, the slug of its title. An archive task stays when the new key already
  has an archive copy of that name, as an archive copy is never replaced. It
  refuses, moving nothing, when an alias of the old key files a live task
  whose slug the new key has: once re-pointed, the alias would hide one of the
  two. It also refuses, moving nothing, when this repo's key is itself an
  alias of a third key, so no alias chain forms. Otherwise, on git storage, it
  commits the moves; a failed commit exits 1 and writes no alias. When every task moved, it
  records old → new as an alias and re-points each alias of the old key to the
  new one. It also removes a new → old alias, so a rename back leaves no
  cycle. All alias changes go through one `aliases.replace`. While a readable task is
  left, it writes no alias.
- `--dry-run` with `--to`, `--lost` or `--remote` prints what would change and
  changes nothing. It runs the same checks, so it refuses, and exits 1,
  wherever the command itself would refuse.
- Every check reads a read-only store. The store opens for writing only once
  the checks pass, so the report, a dry run and a refusal make no SQLite
  database and repair no git hook. Before a SQLite store's database exists,
  the report prints "No problems found." and exits 0.

### The registry

`tools/ledger/registry.ts` keeps the registry, a JSON list of every task. The
plugin reads the same shape. The registry is a cache: `loadTasks` can always
rebuild it from the ledgers.

`loadTasks` reads every task from the store, so the registry does not tell it
where to look. It drops an entry whose ledger the store no longer holds, such
as a task retired on another machine.

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
the other task. After `/ledger:close`, nothing starts. In a session with no
person at the prompt, such as one an Agent SDK host like T3 Code drives, the
plugin clears but does not send `go <slug>`: such a host cuts that turn off
at once. The agent's last line asks the operator to type `go <slug>` instead.

`/ledger:park <reason>` arms a clear too. At the end of its turn, the plugin
runs `ledger task park <slug> --reason <reason>` for the session's task, then
clears, and nothing starts. When the park fails, the plugin says so and does
not clear. When the first word is the slug of another live task of the repo,
the plugin parks that task at once and does not clear.

**After a clear.** The plugin looks at the task the session worked on after
`/ledger:next`, and after a `/ledger:go` that leaves it for another task. It
runs `ledger worktrees auto-prune` on that task's worktree, which deletes its
build folders once its plan is finished. For a finished task, it then shows a
retire hint. The hint uses `ledger task retire --dry-run` to say whether the
branch is merged, whether a check still blocks the retire, and whether its PR
is still open. After `/ledger:next`, the plugin also names the parent's next
child, from `ledger tree next` (`showRetireHint` in `register.ts`).

**A task in another repo.** When `/ledger:go` names a task of another repo,
`ledger go` starts it in that repo, and the plugin does not clear. Its message
gives the worktree, and says to send a subagent there by its absolute path, or
to open a session there and type `go <slug>` (`startedElsewhereMessage` in
`ledger.ts`).

**Starting a task in the session.** `/ledger:task` with no current ledger, or
in a main checkout, starts the new task in the same session, with no clear
(`mods/ledger/commands/task.md`). Without `--stack`, it runs
`ledger go <slug>`; with `--stack`, the worktree exists already. It then moves
the session into the new worktree with the `EnterWorktree` tool and reads the
ledger with `ledger show`, as the session-start hook does not inject it. Then
it goes on with the operator's request. With a current ledger, the new task
stays in the backlog: `ledger task new` adds a line under the current task's
Decisions that names it, and the reply is the command that starts it.
`tests/ledger-task-command.test.ts` pins both cases.

**Commands answered as text.** The plugin answers `/ledger:all` with
`ledger list --archived`, `/ledger:archive` with `ledger task archive`, and
`/ledger:parent`, `/ledger:worktrees` and `/ledger:retire` with their own
commands. `/ledger:help` answers with its help text. The output is the answer,
with no model turn. When the agent starts one through the `Skill` tool, it
gets the same text (`answerOf` in `register.ts`).

**Claims.** A claim marks the one session that works on a task
(`tools/ledger/claims.ts`, [LLP 0001
section 5.4](0001-ledger-workflow.plan.md#54-claims)). `ledger go --session`
claims the task when it is in the repo the command runs in; a task of another
repo is not claimed, as the session stays in its own repo. A `go <slug>`
prompt claims with `ledger task claim`. Each turn end marks the session's
claims active, and a clear releases them. A release can fail, so before an
armed `/ledger:go` clears, `register.ts` writes the state key `handover`: the
task's slug and the session `from` that claimed it. The new session's first
`go <slug>` prompt reads and empties it, and for that slug runs
`ledger task claim --from <from>`, which takes that session's claim over with
no held question.

Only the operator may type `/ledger:close` and `/ledger:park` (`TYPED_ONLY` in
`register.ts`). The plugin refuses them when the agent starts them through the
`Skill` tool. `isTypedOnly` in `register.ts` refuses three more commands from
the agent: `/ledger:retire` with `--force`, `/ledger:worktrees prune` or
`prune-orphans` without `--dry-run`, and `/ledger:parent` with an action other
than `next`, such as `add` or `remove`. The refusal names the command for the
operator to type.
The agent may start `/ledger:next` once, right after the operator
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

- `session-start`: injects the ledgers of the session's folder, read from the
  store, with the status of their parent and child tasks. With git storage it pulls first, and
  a sync problem adds one line above the ledgers. The whole hook has one
  five-second deadline. In a main checkout it skips lost tasks.
- `prompt-submit`: titles the session when the prompt is exactly
  `go <slug>`.
- `pre-compact`: tells the compaction to keep the task's slug, worktree path
  and next step.
- `pre-tool-use`: denies two kinds of tool calls. The first removes a worktree
  folder whose ledger is not archived. The second writes a `.claude/ledger.md`
  anywhere, as no ledger lives in a worktree, or writes ledger text that cites
  a file in a session folder. Its message names `ledger show` and
  `ledger notes`.

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

`settings.policy.json` also registers the shell scripts of `hooks/`. Each
runs through `hooks/logged.sh`, except the status line:

- `statusline.sh` is the status line. It prints the folder, the git branch,
  the model and the five-hour and seven-day usage percentages. It writes those
  rate limits to `~/.claude/state/usage-snapshot.json`. It reads no ledger.
- `usage-pace.sh` runs on each prompt, and only when the Sol or Astra
  implementer agent is deployed. It reads that snapshot and adds a routing
  hint to the prompt when Claude usage runs ahead of an even pace. When Codex
  usage is high too, the hint says to ask the operator instead.
- `deploy-drift.sh` runs at session start. It warns when a rule, agent or hook
  of the repo is not linked into `~/.claude`, or links elsewhere, and when a
  key of `settings.policy.json` differs in `~/.claude/settings.json`. The
  warning says to run `bin/deploy`. It writes nothing.
- `denied-read-retry.sh` runs when a permission is denied. It lets the agent
  retry a denied `Read`, `Grep`, `Glob` or `NotebookRead`. It also lets it
  retry a Bash command whose every part is a read-only command from a fixed
  list, with no redirect and no command substitution. Any other denial stands.
- `derived-data-gate.sh` runs before each Bash call and denies an Xcode build
  folder other than the one LLP 0001 D44 names.

### Worktree layout

`tools/ledger/paths.ts` sets the layout:

- A task's worktree is `<main>/.claude/worktrees/<folder>`.
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
4. Deletes the merged branch and the worktree's Xcode build folders.
5. Removes the active record. It comes after every other change to the task, so a retire that stops early
   leaves the task for a plain rerun to find and finish.
6. Updates the task list.

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

`rules/40-model-routing.md` ranks each model by cost, intelligence and taste.
It gives each agent of `agents/` an engine, an effort range, what it answers
and what it never does. `rules/10-operating-model.md` sends every subagent
result to a fresh `reviewer`. On critical work, `astra-reviewer` reviews after
it, blind: its Codex prompt holds the spec, the criteria and the diff, but not
the first verdict (`agents/astra-reviewer.md`).

`sol-implementer`, `astra-implementer`, `astra-reviewer` and `codex-runner`
are thin Claude agents, on `claude-haiku-5-5` at low effort, that run Codex.
Each writes a self-contained prompt and starts `codex exec`, or
`codex review`, in the background. The command writes the output and the exit
code of Codex to files, then makes a done-file. The agent waits for the
done-file with `Monitor` and relays the result.
`rules/60-subagent-mechanics.md` sends every Codex run through such an agent.
`tests/codex-wrappers.test.ts` pins the wait steps of all four.

`rules/80-ui-automation.md` sends all device UI automation through the argent
MCP server to `ui-runner`, so no view hierarchy reaches the orchestrator.
`ui-runner` runs the flow and reports the steps, a verdict (pass, fail,
blocked or inconclusive), what it saw for each criterion, the failures, and
the paths of saved screenshots and hierarchies.

`rules/30-stacked-prs.md` applies where the `gh stack` extension is
installed. Implementers and reviewers never run `gh stack`; the orchestrator
does. It links each PR to its parent, syncs after a parent branch moves,
rebases a child onto its parent and merges bottom-up. Each stacked PR is a
child task with its own ledger, under one parent task.

### Deploy

`bin/deploy` checks for Node 20.12 or later and runs `tools/deploy.ts`. In a
terminal with no arguments, an interactive wizard (`runWizard` in
`tools/wizard.ts`) picks the components and flags, previews a dry run, and
runs deploy.

A deploy does these steps:

1. Links the rules, agents, `hooks/*.sh`, the ledger template and
   `notes/model-routing-rationale.md` into `~/.claude`. With a filter flag, it
   copies generated rules instead (see [Rules and agents](#rules-and-agents)).
   It asks before it replaces a file of the operator's own, and backs that
   file up in `~/.claude/backups/deploy-<time>/`. With no terminal, it
   refuses unless `--force`.
2. Links `bin/ledger` to `~/.local/bin/ledger` and `~/.claude/bin/ledger`. The
   settings hooks run the second path, so they need no `PATH`.
3. Sets up the git hook chain (see below).
4. Removes a rule no longer selected and a hook link no longer in the repo.
5. Writes every path it placed to `~/.claude/.ledger-manifest`.
6. Runs `tools/apply-policy.ts`. It merges the keys of `settings.policy.json`
   into `~/.claude/settings.json` and keeps the operator's other settings,
   hooks and allowed commands. When `~/.codex/config.toml` exists, it sets the
   keys of `codex/policy.toml` there in the same way.
7. Adds this repo as the plugin marketplace `ledger` and installs the plugin
   at user scope. It reinstalls the plugin when the installed copy differs
   from `mods/ledger/`, and passes back its saved settings. It installs
   nothing while the marketplace points at another folder.
8. Runs `ledger store migrate --active`.

`--dry-run` prints every change and writes nothing. `--revert` removes each
path in the manifest and restores the files of the newest backup. It leaves
the plugin and `core.hooksPath` in place, and prints the commands that remove
them.

**Git hook chain.** Unless `--no-githooks`, deploy links `githooks/_chain`
into `~/.config/git/hooks/`, once under its own name and once for each git
hook name. When `core.hooksPath` is not set, it sets it globally to that
folder. When it names another folder, deploy leaves it and says so. For
`commit-msg`, `_chain` removes AI attribution trailers: a `Co-Authored-By:`
line that names Claude or anthropic.com, a line with
`Generated with [Claude Code]` and a `Claude-Session:` line. Then it runs the
repo's own hook of the same name, from the git common folder, so the hooks of
a worktree are the main repository's.

### Checks

- `npm run llp` checks the names and header fields of the LLP documents, and
  that each `@ref LLP` comment in the source names an LLP and one of its
  headings (`tools/llp-refs.ts`).
- `npm test` runs `tests/*.test.ts`. The plugin's own tests, in
  `mods/ledger/hooks/`, run with `claude plugin test`.

## Data and storage

| Data | File store | SQLite store | Git store |
|---|---|---|---|
| Backlog ledger | `~/.claude/ledger-backlog/<repo key>/<slug>.json` | `~/.claude/ledgers.db`, table `records` | `~/.claude/ledger-data/backlog/<repo key>/<slug>.json`, committed |
| Archive copy | `~/.claude/ledger-archive/<repo key>/<YYYY-MM-DD>-<slug>.json` | `~/.claude/ledgers.db`, table `records` | `~/.claude/ledger-data/archive/<repo key>/<YYYY-MM-DD>-<slug>.json`, committed |
| Archive evidence | `~/.claude/ledger-archive/<repo key>/<YYYY-MM-DD>-<slug>/` | `~/.claude/ledgers.db`, as bytes | `~/.claude/ledger-evidence/<repo key>/<YYYY-MM-DD>-<slug>/`, never committed |
| Registry | `~/.claude/ledgers.json` | `~/.claude/ledgers.db` | `~/.claude/ledgers-git.json`, never committed |
| Repo aliases | `~/.claude/ledger-aliases.json` | `~/.claude/ledgers.db` | `~/.claude/ledger-aliases-git.json`, never committed |
| Active ledger | `~/.claude/ledger-active/<repo key>/<slug>.json` | `~/.claude/ledgers.db`, table `records` | `~/.claude/ledger-data/active/<repo key>/<slug>.json`, committed |
| Store setting | `~/.claude/ledger-settings.json` | the same file | the same file |

The git store also keeps a clone lock, `~/.claude/ledger-data.lock`, and the
last sync problem, `~/.claude/ledger-data.status.json`, outside the clone.

The file store writes backlog and active ledgers and the registry atomically. It holds a
lock file, `<target>.lock`, during each such write. `withLock` in `tools/ledger/lock.ts` waits
up to five seconds for a lock. It takes over a lock whose process is gone or
that is older than one minute.

Every ledger in the store is a task record: JSON with one field or list
per part of the ledger (LLP 0001 D29). `tools/ledger/record.ts` defines it.
`parseRecord` reads Markdown into a record, and `renderRecord` writes the
record back as Markdown in the template's layout. A wrapped or indented line
stays with the item above it. The tag of a decision or constraint, such as
`[observed]`, is read only at the end of the item, so a tag on the first line
of a wrapped item stays in the item's text. A line that fits no field goes to
the record's general notes, under a copy of its heading. The conversion drops
only these:

- the template's placeholder lines and preamble, and the plan table's header
  and separator rows of five cells;
- blank lines, except one blank line between paragraphs of the goal, the next
  step, the report, the notes or a section's lines that go to the notes, and
  every blank line inside a wrapped item;
- spacing at a line's end and around the parts of an item, such as a bullet's
  dash, a table cell or a Location value;
- Windows line endings.

The stores keep their text interface: a read renders the record, and a write
parses the Markdown it is given. So `text` reads back as
`renderRecord(parseRecord(text))`, not always as the bytes written. A write
whose record would not read back the same fails and changes nothing
(`recordToWrite`). When the file or git store puts a record in place of
Markdown, in a conversion or a write, the new file keeps the Markdown's mode,
and the store keeps the Markdown's birth time as `created` beside the record,
as a new file's birth time cannot be set. The Markdown does not show
`created`, so it is no field of the record: each later write carries it over.

A store still reads a ledger kept as Markdown from before records: a
`<name>.md` file, or a row of the SQLite table `ledgers`. A write replaces
that Markdown with a record. It holds the lock of `<name>.md` as well as that
of `<name>.json`, as a writer from before records locks only the Markdown.
When a task has both, as after an older machine wrote one, the record is read
and the Markdown is hidden; no write removes it. Removing such a task fails,
as the Markdown would be read again without the record; a move takes both
along. `ledger store migrate --records` converts all Markdown at once, and
names each task kept both ways as a conflict for a person to merge. Its dry
run checks each ledger as the conversion does, so it fails where the
conversion would.

Known limits of task records:

- A number above 2^53 in a record field, such as `- order:` or the step a
  question blocks, is rounded.
- The template's example plan row is dropped even next to real rows, so the
  plugin's plan progress, which counts it, can change.
- A numbered plan row of other than five cells is no step of the record; it
  stays as text, in the note of the step above it or in the general notes.
- `ledger store migrate --to` copies the text, so the copy has no `created`
  and its birth time is that of the copy.
- `ledger store migrate --to git --dry-run` puts back a pre-push hook that
  differs, as it opens git storage for writing (`openForMigrate` in
  `tools/ledger/migrate.ts`).

## Task life today

1. `ledger task new` writes a backlog ledger from the template.
2. `ledger go <slug>` makes the worktree and branch, and moves the ledger
   from the backlog to the active ledgers. The branch starts at the ledger's `- base:` line, or at
   the default branch. It claims the task for the session, when the task is in
   the repo the command runs in, and installs the
   packages of a worktree with a lockfile and no `node_modules`
   (`tools/ledger/install.ts`); a failed install exits 5 and keeps the
   worktree.
3. The agent writes the ledger with `ledger notes` during the work, one item
   per command. The rules say when.
4. `ledger task park` and `ledger task unpark` mark a task that waits.
5. `ledger task retire` archives the ledger and removes the worktree.

A parent task stays in the backlog. Its ledger lists its child tasks.
`ledger tree` adds and removes child tasks and shows their status.

## Known gaps

`ledger notes stage` tracks a task's stage, claims track the session that
works on a task, and `ledger tree order` keeps a parent's child order. The
code does not track PR state. `ledger notes step` sets a step's status as free
text, and only rules guard most steps. [LLP 0001
section 15](0001-ledger-workflow.plan.md#15-from-today-to-this-spec) lists each
gap and the planned work.
