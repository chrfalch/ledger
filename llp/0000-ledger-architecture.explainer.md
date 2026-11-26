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
exposes the command as `/ledger:` commands. At session start, hooks show a
short report on the current task: what needs the operator, where the task sits
in its tree, and its next step. `ledger show` prints the whole ledger. Hooks
also block unsafe writes. Rules tell the agent when to use all of
this.

[LLP 0001](0001-ledger-workflow.plan.md) is the plan for what comes next. This
document describes only what exists.

## Overview

The system has five parts:

1. The `ledger` command, in `tools/ledger/` and started by `bin/ledger`.
2. The store, which keeps active and backlog ledgers, archive copies and repo
   aliases.
3. The plugin, in `mods/ledger/`, which gives Claude Code the `/ledger:`
   commands.
4. The hooks, which Claude Code runs through `ledger hook <event>`.
5. The rules and agents, in `rules/` and `agents/`, which tell the agent what
   to do.

A task has one ledger at a time. Where the ledger is tells the task's status,
and inside active, its status line tells the detail:

| Where the ledger is | Status |
|---|---|
| Backlog, in the store | `backlog` |
| Active, in the store, naming its worktree | `active`, or the value of its status line: `parked`, `blocked`, `waiting` or `done` |
| Active, in the store, with a lost mark | `lost` |
| Archive, in the store | `retired` |

`toTask` in `tools/ledger/tasks.ts` sets the status this way. The tool writes
the status line under `## Location` as
`- status: <value>[ <date>][ — <detail>]`, such as
`- status: parked 2026-11-23 — waiting on design`. A line in any other form is
a note. An older ledger may still have a `Parked: <date> — <reason>` line
first under `## Next step`, or a `- state:` line with one of those values. It
reads as that status, and the next write saves it as the status line. When a
waiting task names its PR in `- pr:`, `ledger show` and `ledger list` ask gh
about that PR, and mark the task done once it is merged
(`markMergedDone` in `tools/ledger/write.ts`). They skip a task that has no live
git worktree of its repo on this machine, such as one of another machine, one
whose folder is gone, or one whose folder git does not list as a worktree. A write of the done mark that fails is a warning on stderr,
and the command goes on with the task as read.

A lost mark wins over the status line.
`ledger store repair <slug> --lost` writes the mark, a
Location line `- lost: <date> — folder <path> not found`, or `- lost: <date>`
for a task that records no worktree. A `- lost:` line counts as the mark only
in the exact form written for the recorded worktree. Any other `- lost:` line
is a note and is kept as it is.

## Components

### The ledger command

`tools/ledger/cli.ts` defines the commands with `commander`. `bin/ledger` runs
it. `bin/ledger` checks for Node 20.12 or later and exits 1 on an older
version, for `ledger hook` too. It runs `npm ci` when the dependencies are
missing. For `ledger hook` it installs nothing: it reports the missing
dependencies on stderr and exits 0, so the tool call goes ahead. For `ledger
statusline` it installs nothing either: it prints nothing and exits 0, as the
status line refreshes often and must not reach the network. The commands
are grouped by what they change (D30 in LLP 0001).
`ledger --help` lists the groups, and `ledger <group> --help` the commands of
each:

- `task`: makes, starts, claims, parks, retires and reads tasks.
  - `new`: writes a backlog ledger from `~/.claude/ledger.template.md`.
    With `--stack`, it makes the worktree and branch at once, on top of the
    current branch, and the task is active. With `--here`, it adds an active
    ledger to the linked worktree it runs in (`hereTask` in
    `tools/ledger/write.ts`). It refuses a main checkout. With `--here` and no
    slug given, the slug is the last part of the branch name, else the
    folder name. Without `--here`, it needs a slug.
  - `go`: starts a task. It makes the worktree and branch of a backlog task
    and moves its ledger from the backlog to the active ledgers, naming that
    worktree. For a parent task, it starts the first child task, in order,
    that is still in the backlog and whose dependencies are all retired or
    done (`firstToStart` in `tools/ledger/write.ts`).
  - `claim`, `touch`, `release`: take, refresh and remove this session's
    claim on a task (see Claims under [The plugin](#the-plugin)).
  - `park`, `unpark`: write the status line `parked <date> — <reason>`, or
    remove it when the task is parked.
  - `retire`: archives the ledger (see [Retire and archive](#retire-and-archive)).
  - `abandon`: archives a task that is no longer needed, with nothing merged
    (see [Retire and archive](#retire-and-archive)).
  - `show`, `list`, `archive`: print a task's ledger, list the live tasks, or
    list the archived ledgers.
    `list` covers the live tasks of every known repo. `show` prints the
    active ledger, else the backlog ledger, else the newest archive copy, and
    can also give an archive copy's evidence files. `archive` lists this
    repo's archive, newest first, and can keep only the ledgers that contain
    a term.
  - `gate`: prints the question for a gate, such as plan approval, as JSON
    the question widget takes. `tools/ledger/gates.ts` defines each gate;
    `tools/ledger/finalize.ts` works out the finalize gate's actions from the
    task tree.
- `notes`: writes one item of a task's ledger (see
  [The notes commands](#the-notes-commands)).
- `tree`: `show` prints a parent task with the status of each child task.
  `add`, `remove`, `start`, `order` and `depends` change its children, their
  order and what each waits for. `next` prints the child task that starts
  next.
  A child task may live in another repo. The commands name it as
  `<slug>@<path>`, such as `part@../lib`, and `depends` also takes
  `<slug>@<address>`, such as `api@github.com/acme/api`. A dependency keeps
  the address it was written with. `dependencyTask` in `tools/ledger/tasks.ts`
  finds the task under any key of its repo, so a dependency written before
  `ledger store repair --remote` filed that repo under its new key, and the
  old key became an alias, still names the task. When `ledger go`
  starts a backlog child of a backlog parent, it writes the main checkout of
  the clone the child started in on the child's line in the parent
  (`nameChildClone` in `tools/ledger/write.ts`).
- `store`: `migrate` moves the ledgers between file, SQLite and git storage.
  `sync` pushes and pulls the ledgers of git storage, and `sync init` makes
  its clone.
- `worktrees`: shows the linked worktrees. `prune` and `prune-orphans` delete
  their build folders.
- `go`, `list`, `show`: short forms of the `task` commands of the same names.
- `deploy`: runs `bin/deploy`, which installs the files and offers the
  one-time moves that `ledger store migrate --pending` lists.

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

Each fail of the review stage adds one to the record's `reviewRounds`, written
as `- review rounds: <n>` under `## Location`; a record with none has no line.
A pass never resets it. The second rejection adds a sentence to the output:
run the next round at higher effort and tell the operator. From the third on,
the task is blocked on "review rejected three times", or stays blocked, and the
output says to ask the operator. A backlog task is not blocked, as only an
active task can be, and the output does not say it is. The stage still moves
as `--back` says.

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
- `oldTaskList`: the text of the task list older versions kept. Only the
  one-time moves read it, and nothing writes it.
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
  old task list and the repo aliases stay on this machine.

`readStorage` in `tools/ledger/settings.ts` picks the store. It reads
`"storage"` from `~/.claude/ledger-settings.json`. With no file and no key, the
store is `file`. `openStore` in `tools/ledger/open-store.ts` opens the store
that the setting names.

`ledger store sync init <url>` makes the clone, once on each machine. It
accepts only a private GitHub repository. `ledger store sync`
(`tools/ledger/sync.ts`) commits, pulls, checks that only ledgers and no
secret-like text go out, and pushes. The pull rebases the commits made here
onto the fetched commit (`rebaseOnto`). With no commit made here, it moves the
branch forward with `git merge --ff-only` instead, and starts no rebase. Before
it commits, a sync clears a rebase that an earlier git left in the clone, when
that loses nothing (`clearLeftoverRebase` in `tools/ledger/clone.ts`; see
[Known gaps](#known-gaps)). A pre-push hook in the clone runs
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
ledger to its repo key on the same disk, by a store move that links the file at
the target and then removes it from the source (see
[Data and storage](#data-and-storage)), and records the
folder name as an alias only for tasks it moved. A ledger whose main checkout it
cannot find, that lies on another disk, or whose target name is taken stays
where it is. In git storage the moves are committed and pushed like any other
write; each machine records its aliases itself.

What stays is of two kinds. Most of it needs a person, who moves it by hand. A
finished task whose repo is gone or unknown needs nobody, and is accepted as it
is: an archive copy whose main folder is not there, or
whose ledger names no main that any record knows, and evidence of whose name no
ledger is in the store, under a folder name that no alias names and whose other
tasks get no repo in the same run. It stays readable in the archive under its
old folder name. A main folder that is there but no git repo, or that git did
not answer for, is not accepted, as the lookup may have failed; nor is one
under `/Volumes/<disk>`, `/mnt/<disk>` or `/media/<user>/<disk>` whose disk is
not there, as that disk may only be unmounted, nor one that cannot be read. A
main folder whose whole home is missing, as on another machine, is accepted. A main folder that is not there needs no git to tell, so
the dry run spawns none for it.

The move reports an accepted item with `accepted: true` and does not count it
as left: `ledger store migrate --repo-ids` exits 0 when only accepted items
remain, and prints one line that counts them, not one line each; `--pending`
names each with its reason. The session-start hint (`conversionHint`) counts
only the others, and names an alias that a task contradicts when it runs the dry run described next. It learns which
items are accepted from the move's own dry run, so the rule has one copy, and
runs that dry run only when an archive copy or evidence is under a folder name,
as nothing else can be accepted. A backlog or active ledger is never accepted,
nor is a finished task that stays for any other reason, such as a taken name,
another disk or an ambiguous folder name.

The main checkout of a ledger is its `- main:` line. People and agents often
write a path as code, so one pair of backticks around the path of a `- main:` or
`- worktree:` line is removed first: `` `/repos/app` `` reads as /repos/app.
People add notes to a `- main:` line, so a value that ends in `)` loses all
from its first ` (`, unless the whole value is a folder on disk, as a folder named `engine (legacy)` can be. Other notes,
such as one after a dash, are not recognised and make the value a path that is
not there. A value that is then no absolute path, such as `.`, names no main,
and the worktree and the records decide instead, as for a ledger with no
`- main:` line; `ledger go` still starts a backlog task filed under the repo's
key that has such a line, and refuses only one with no `- main:` line at all.
A worktree path that is not absolute, such as `.claude/worktrees/<slug>`, names
no main either: it would resolve against the folder the command runs in. Such a
ledger follows the folder-name rules, as one with no main.

`migrateActive` in `tools/ledger/migrate-active.ts` runs once for ledgers from
before active records. It moves the `.claude/ledger.md` of each linked worktree
into an active record that names the worktree, and deletes the file;
`.claude/evidence/` stays. A ledger whose slug or worktree is taken stays as it
is, for a person to merge. Until it runs, `session-start` says how many are
left.

Each of `migrateRepoIds`, `migrateActive` and `migrateRecords` takes a callback
that it calls once per item, with the item's source, its target, and whether
the move takes it or leaves it, with the reason. `pendingMoves` in
`tools/ledger/pending.ts` runs the three as dry runs, in that order, and
collects the items. `ledger store migrate --pending` prints them, or with
`--json` prints them as JSON. The list comes from the moves' own dry runs, so
it follows their rules with no second copy of them. A dry run of `--repo-ids`
asks the file store whether a move's link would cross onto another disk
(`acrossDisks`), so such a ledger is listed as one to move by hand, as the run
reports it. The list is still a preview: each move checks again when it runs,
so it can leave a task the list showed as movable, for example one whose name
another command took in between.

`bin/deploy` reads that JSON to offer the moves. A list it showed earlier is
only for display: `runMoves` in `tools/deploy.ts` checks again before each kind
of move, runs the kind only when that check lists an item it can move, and
checks once more at the end. It never runs an item the move
would leave; that item waits for a person, or for nobody when it is accepted.
Such an item is not a failure: `bin/deploy --migrate` prints it with its reason
and still exits 0. Of the `--repo-ids` run it ran, it passes on the moves and
the final count, not the lines on what that run left, as the last check prints
each of those once. It exits 1
only when a check fails, a move cannot start, is stopped by a signal or exits
above 1, or the last check still lists a move it could have made.

`bin/deploy --migrate`, its dry run and `ledger store migrate --pending` print
the items in three groups: the moves they can make, then the tasks that need a
person under a line that counts them, then the accepted items under one line
that says there is nothing to do, each with its plain reason. A plain
`bin/deploy`, its dry run, and the wizard after a deploy, also when it runs
the moves, show nothing for accepted items, so a second machine with finished tasks of repos it never had
is not told about them on every deploy.

`repairStore` in `tools/ledger/repair.ts` runs `ledger store repair`. It takes
flags only and never prompts:

- With no task, it reports two kinds of problem in every repo of the store. The
  first is an active task of this machine, neither parked nor lost, whose
  recorded folder is gone. The second is a repo key whose tasks name a main
  checkout that has another key now, as after a renamed remote. It prints the
  command that fixes each, and exits 1 when it finds one.
- `--search <folder...>` adds, for each missing task, the linked worktrees of
  its repo on its branch. It looks only in the named folders, 6 levels down,
  and follows no symbolic link. It refuses a named folder whose path, part by
  part as named, goes through a symbolic link, and names the folder the path
  leads to, as searching nothing there would read as "no checkout". It checks
  the parts before it drops any `..`: `/tmp/..` leads to `/private` on macOS,
  not to `/`. It skips a `.git` or `node_modules` folder and a
  `.claude/worktrees/.build` folder, also one it is given by name and any
  folder it is given inside one, such as `/r/node_modules/pkg`, so such a
  name finds nothing. It compares these names in any case, and reads a given
  name as the folder is named on disk, so `Node_Modules` and
  `.Claude/Worktrees/.Build` are skipped too. It is the only command that
  searches the disk for a task's folder.
- `<slug> --to <folder>` points the task at a new folder and runs
  `git worktree repair` there. It accepts an active or a lost task, and it
  removes a lost mark. It refuses a parked task, even one that is also marked
  lost. It refuses a main checkout, a folder on another branch, a folder another
  record names, and a checkout whose repo key differs from the task's after
  aliases are resolved.
- `<slug> --lost` marks the task lost. It refuses a parked task, and it
  refuses while the folder exists.
- The checks of `--to` and `--lost` read the store first, so a refusal opens
  nothing to write. Each write checks again in its update, under the record's
  lock: `--lost` that the record names no folder that is there, and `--to`
  that no other record names the folder. `--to` also records the main
  checkout of the folder by the record as it reads it there, so a `--to` that
  pointed the task into another clone of its repo in between cannot leave its
  main checkout behind. A record's lock covers one record,
  so each write of `ledger store repair` also holds
  `~/.claude/ledger-repair.lock`: `--to` and `--lost` while they write,
  `--remote` from before it lists the old key's ledgers to its last write, as
  it plans its moves by what it lists. Of two `--to` runs that point two tasks at one folder, the
  second sees the first's record and refuses. Of two `--remote` runs, the
  second waits up to five seconds for the lock. When the first is done by
  then, the second finds nothing left to move; otherwise it stops with
  "Gave up waiting for the lock", moves nothing and exits 1. Without the lock
  it would find each move gone and take back the alias the first recorded.
  The lock is kept, however old, while the process that holds it runs, as a
  `--remote` run may take longer than a minute. A dry run takes no lock. Other commands that set a task's folder take no such lock.
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
  alias of a third key, so no alias chain forms. It refuses before it writes
  anything, also as a dry run, and exits 1 when the old key and this repo's
  key are the same repository folder in the store (`sharesFolder`), as a key
  and its URI encoding are in a file or git store, or two keys that differ
  only in case on a disk that ignores case: the tasks are filed under the
  new key already, and a move between them would remove them. A SQLite store
  keeps each key apart, so it has no such check. It also moves evidence left
  under the old key whose archive copy is under the new key already, as after
  an evidence rename that failed or a run that stopped between the two; it
  does so on a rerun that finds old → new recorded already, too. Evidence under the old key whose archive
  copy is under neither key stays where it is, and keeps no alias from being
  recorded. Repair reads the old key's record and evidence folders before
  moving anything. A missing folder counts as empty. If it cannot read a
  folder, it names the folder and exits 1. This includes an evidence folder
  spelled differently on a disk that ignores case. Other commands can still list
  ledgers in other repos. An unreadable record stays under the old key. The
  run names it and exits 1. A folder in a repo folder, such as the evidence of an
  archive copy whose name ends in `.md`, is no record. When the plan moves every
  task, it records old → new as an alias, re-points each alias of the old key
  to the new one, and removes a new → old alias, so a rename back leaves no
  cycle. It writes these before the moves, in one `aliases.replace`. A run
  that stops after the moves therefore leaves old → new, and a rerun finds
  the key by it and finishes. A repo folder a move emptied but cannot remove,
  as under a read-only folder, stays and fails no move. When a move fails, it
  takes the aliases it recorded back in one more `aliases.replace`; an alias
  recorded before the run stays, and the run says it kept it. A run that is
  killed before that, or whose take-back fails, leaves the aliases while
  ledgers stay under the old key; a rerun moves them. A file store move stopped
  between its links and its removals (see [Data and storage](#data-and-storage))
  leaves the task under both keys, as two links of one file; a rerun finishes
  the move, also one that stopped between the record and the Markdown it
  hides. A rerun skips the checkout check whenever the record or its
  Markdown is already linked under both keys. The first run checked the
  checkout before linking, and the checkout may have vanished since. A
  conflicting ledger under the new key still blocks the move. If the old
  key holds only hidden Markdown, repair checks both its slug and the slug
  of the record under the new key. On git storage,
  repair commits the moves. A failed commit exits 1 and keeps the aliases, which are
  never committed, also when a move failed too; the message says to fix the
  problem and then run `ledger store sync`. A rerun that finds old → new
  recorded already also commits the moves a run left uncommitted
  (`commitPending`), as the run that recorded it may have been killed between
  its moves and their commit. Repair, ordinary commands and sync recognise
  the same pending move before deciding which host owns a change. HEAD must
  hold the old path. A different spelling of the new path in HEAD rules out
  the move. The old path must be absent on disk in any spelling,
  and the recorded alias must point to the new key. The new path must exist
  on disk with its exact spelling and hash to the old HEAD blob. If HEAD
  already holds that blob at the exact new path, only the old deletion
  remains to commit. A different blob at the new path rules out the move. For a
  matching move, the commit takes whichever paths git reports as changed,
  even for another host's record. So a pair is committed together only when
  git status shows the source removal. A source removal hidden by an index
  flag stays in HEAD, and repair then fails and names it.
  A different blob gets the usual ownership check.
  Repair uses the same checks to find moves for `commitPending`. It then
  checks HEAD holds each of these paths as the disk does, so a removal git
  left out, as of a file marked `assume-unchanged`, exits 1 with the sync
  message, on every rerun until it is fixed. Only git storage has
  `commitPending`, so on a file or SQLite store a rerun opens nothing to
  write. A rerun with nothing left under
  the old key prints "Nothing is left under <old-key> to move." and exits 0,
  or exits 1 with the sync message when that commit fails. A key that has no task and no alias,
  also before a SQLite store's database exists, gives "No task is filed under
  <old-key>, so nothing was moved." and exits 1.
- `--dry-run` with `--to`, `--lost` or `--remote` prints what would change and
  changes nothing. It runs the same checks, so it refuses, and exits 1,
  wherever the command itself would refuse.
- Every check reads a read-only store. The store opens for writing only once
  the checks pass, so the report, a dry run and a refusal make no SQLite
  database and repair no git hook. Before a SQLite store's database exists,
  the report prints "No problems found." and exits 0.

### The task list

The task list is a query over the task records, as D29 in LLP 0001 says.
`findTasks` in `tools/ledger/tasks.ts` reads every active, backlog and archived
task from the store each time. Nothing caches the result, so no write has to
keep a list in line with the records.

Older versions kept a cache of it, the registry: `~/.claude/ledgers.json`, the
`registry` table of `~/.claude/ledgers.db`, or `~/.claude/ledgers-git.json`.
Nothing writes it now. The one-time moves read it, through `oldTaskList` and
`parseOldTaskList` in `tools/ledger/unmoved.ts`. Before
`ledger store migrate --active` runs, a repo's active tasks exist only in its
worktrees' `.claude/ledger.md`, and deploy runs the moves from HOME. So the old
list is what names those repos there. `--active` also looks in the repo of every
task the store holds.

### The plugin

`mods/ledger/` is a Claude Code plugin. It has two parts:

- `mods/ledger/commands/*.md`: one prompt per `/ledger:` command, such as
  `go.md`, `retire.md` and `update.md`.
- `mods/ledger/hooks/`: TypeScript that the plugin engine loads through
  `hooks.json`. `register.ts` registers the `/ledger` command and handlers for
  session start, command runs, `Skill` and T3 `t3_thread_send` tool calls and
  turn end.

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
In T3 Code, the agent first queues the new session itself. As its last tool
call, it sends `go <slug>` to its own thread with `t3_thread_send`, in mode
`queue` and with `freshContext`. T3 starts that message in a fresh session
once the turn ends. A `tool.call` handler in `register.ts` marks the armed
clear `queued` when that call goes through and matches the armed slug. The
plugin does not detect T3 any other way: the tool call is the signal. At the
end of a queued turn, the plugin releases the claims and writes the
`handover` (see Claims), then shows the retire hint. That this finishes
before T3 starts the queued run is not yet checked in T3 [inferred]. It
neither clears nor sends `go <slug>`. When the tool is missing or
the call fails, the agent falls back to asking the operator.

For `/ledger:go`, `startGo` in `register.ts` runs
`ledger go <slug> --session <id>` before the prompt expands. It arms the clear
only when that succeeds, or when the slug names a task that does not exist
yet. A task that started in another repo returns before the clear is armed.
`go.md` runs `ledger go` itself only for a task that does not exist yet,
after `ledger task new`.

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
ledger with `ledger show`, as no session-start report covers a worktree
entered in the middle of a session. Then
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
no held question. A T3 queued run (see Clearing the session) gets no clear,
so the turn end does the same release and writes the same `handover` itself.
The queued run then sends its `go <slug>`. That the release comes first is
not yet checked in T3 [inferred].

Only the operator may type `/ledger:close`, `/ledger:park` and
`/ledger:fleet` (`TYPED_ONLY` in `register.ts`). The plugin refuses them when the agent starts them through the
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

- `session-start`: gives a short report on the task the session's folder
  owns, read from the store, not the whole ledger (D26 in LLP 0001,
  `sessionReport` in `tools/ledger/awareness.ts`). A main checkout, or a
  folder that owns no task, gets the open trees of its repo instead (D27,
  `openTreesReport`), and with no open tree it still asks: a new task or quick
  work. Both read every task from the store alone (`storedTasks` in
  `tools/ledger/tasks.ts`), with no git call per task, and find a parent or
  child in another repo by the main checkout its record names
  (`storedRepoOf`), never by git there. With git storage it
  pulls first, and a sync problem adds one line above the report. It then asks
  gh about the PR of each waiting task (`tools/ledger/pr-check.ts`). Each PR
  that needs the operator is a line in the report's one *Needs you:* section,
  which in the open-trees report comes above the trees. The time
  is set in three parts. The pull, every git call and every lock wait share one
  five-second deadline. A git call still running at the deadline is stopped,
  so the pull starts a rebase only for commits made here, and the next sync
  clears a rebase that was stopped while it wrote its state (`pullForSession`
  in `tools/ledger/sync.ts`). Then gh gets 3 seconds for all PRs at once. The writes
  that gh's answers ask for then get 2 seconds of their own, from when gh is
  done, as the five seconds may be up by then.
- `prompt-submit`: titles the session when the prompt is exactly
  `go <slug>`.
- `pre-compact`: tells the compaction to keep the task's slug, worktree path
  and next step.
- `pre-tool-use`: denies four kinds of tool calls. The first removes a
  worktree folder whose ledger is not archived. The second writes a
  `.claude/ledger.md` anywhere, as no ledger lives in a worktree; its message
  names `ledger show` and `ledger notes`. The third writes to a backlog
  ledger still in Markdown, from before task records, whose new text cites a
  file in a session folder. It does not check today's JSON records;
  `ledger notes` refuses such a citation itself. The fourth writes the ledger
  store by hand (D38 in LLP 0001):
  a file tool or a shell command that writes a path of the file store, the
  SQLite database or the git clone, or a git command in the clone that does
  more than read. Removing or moving a folder above the store counts too, and
  so does a glob that could match a store path. `ledger` itself is allowed,
  unless its output is redirected into the store. Its message names
  `ledger show`, `ledger notes` and `ledger store`. For a git command in the
  clone it adds that the operator resolves a sync conflict in a terminal, so
  the agent asks them.

When a hook fails, `tools/ledger/cli.ts` prints the error to stderr and exits
0. Claude Code then allows the tool call. A hook never blocks work by accident.
The failure is also appended as one line to `~/.claude/ledger-hook-failures.log`
(`tools/ledger/hook-failures.ts`). The shell hooks run through `hooks/logged.sh`,
which logs any exit other than 0 or 2 the same way and exits 0. The next
`session-start` puts the number of failures not yet reported, and the time of
the first, above the report.

`settings.policy.json` registers the four events. Each entry runs
`"$HOME"/.claude/bin/ledger hook <event>`. Deploy merges these keys into
`~/.claude/settings.json`.

`settings.policy.json` also registers the shell scripts of `hooks/`. Each
runs through `hooks/logged.sh`, except the status line:

- `statusline.sh` is the status line. It prints the folder, the git branch,
  the model and the five-hour and seven-day usage percentages. It writes those
  rate limits to `~/.claude/state/usage-snapshot.json`. After the branch it
  shows what `ledger statusline <folder>` prints: the task and stage, read
  from the store alone, with no pull and no gh (D28).
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

- A task's worktree is `<main>/.claude/worktrees/<folder>`. `taskWorktree` in
  `tools/ledger/paths.ts` builds this path. `mainOfTaskWorktree` there finds
  the main checkout from it.
- Its evidence is `<worktree>/.claude/evidence/`, as `tools/ledger/retire.ts`
  names it.
- The file store, and the git store in its clone, name each repo folder by its
  repo key, such as `github.com%2Fchrfalch%2Fledger`. `folderOf` in
  `tools/ledger/file-store.ts` URI-encodes the key. A folder from before the
  repo key, named after the main checkout's folder, keeps that name until the
  conversion moves its ledgers.

### Retire and archive

`retireTask` in `tools/ledger/retire.ts` retires a task. It checks first. It
exits 1 with nothing changed when a check stops it. Checks include uncommitted
changes, an unmerged branch and active child tasks. `--force` skips these
checks. It never skips an evidence check, such as an archive copy whose
evidence differs or a link in `.claude/evidence/`, as evidence would be lost.
`--dry-run` prints the plan. It changes nothing but the remote-tracking branch
of the default branch, which it fetches.

Then it does these steps:

1. Copies the ledger and the worktree's `.claude/evidence/` to the archive.
2. Removes the worktree, or the backlog ledger.
3. Marks the task retired in its parent's ledger and copies the child's
   report there.
4. Deletes the merged branch and the worktree's Xcode build folders.
5. Removes the active record. It comes after every other change to the task, so a retire that stops early
   leaves the task for a plain rerun to find and finish.

The task list is a query over the task records, so removing the active
record, or the backlog ledger, also takes the task off the list. No step
updates the list itself.

An archive copy is never replaced. `Archive.write` throws when the name is
taken.

`abandonTask` runs the same retire for `ledger task abandon --reason <text>`,
with three differences. First, an unmerged branch does not stop it; a
detached HEAD with unmerged commits still needs `--force`, as no branch keeps
those commits. Second, the unmerged branch is kept. Third, its first step
adds the note `<date> abandoned: <reason>` to the live ledger, as the last
line of the ledger's own `## Notes`; the rest is a retire of that noted
ledger, so the archive copy has the note. Only that section counts: an
`abandoned:` line in a child report copied into the ledger is no abandon
note, and the note never goes under a child report. A dry run, or a check
that stops the abandon, writes no note. A lost task, or one on another
machine, gets the note in its record in the store too, once `--force` lets it
through. A ledger whose own `## Notes` hold an abandon note already, of any
date and reason, gets no second one, so a rerun after a failure finds the
copy it wrote as a retire rerun does. When a retire archived the ledger
already, without the note, as when it stopped after its archive step, the
abandon adds no note and leaves that copy as it is: it finishes as a retire
run again does, and warns that the reason is not saved. The reason must be
one line, with no line break before or after it either; an empty one is
refused before anything is read. The `--json` output of both commands has a
`verb` field, `retire` or `abandon`, and the dry run of an abandon is titled
`Abandon`.

### Rules and agents

`rules/*.md` are the orchestrator contract. `agents/*.md` are the subagents.
`bin/deploy` links both into `~/.claude/`. With flags such as `--no-codex`,
`tools/build-rules.ts` filters the rules by their `needs:` markers, and deploy
writes the result instead of links.

After the files, deploy handles the one-time moves of stored task data. Every
deploy, from the wizard or not, runs `ledger store migrate --active` without
asking, because the ledger it just installed reads active ledgers only from the
store. A plain `bin/deploy` then lists the other pending moves and names
`bin/deploy --migrate`, which runs them and deploys no files. The wizard
(`tools/wizard.ts`) has a Migrate entry beside Deploy and Revert. After Deploy
it lists the other pending moves and asks whether to run them; with none
pending it asks nothing. Migrate runs them, or switches the store type with
`ledger store migrate --to`: it shows the dry run first and never removes the
old copy. Deploy runs `bin/ledger` as a separate process and never imports the
ledger code. Deploy supports Node 20.12, and the SQLite store needs Node 22.13.

`rules/10-operating-model.md` holds the ledger workflow: when a task needs a
ledger, when to update it, the clear point and the end of a task. The rules
name the `ledger` command and the `/ledger:` commands. The code does not read
the rules. The agent follows them.

At a gate, the agent asks the operator with the question widget. For the gates
that `ledger task gate <name>` knows, `plan`, `pr`, `merge`, `goal`, `abandon` and `finalize` today, the question comes
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

`bin/deploy` checks for Node 20.12 or later and runs `tools/deploy.ts`.
After the Node check and before `tools/deploy.ts`, it fetches the remote of
the branch's upstream. It does this in a terminal or with
`DEPLOY_PULL_CHECK=1`, and not with `--migrate` or `--help`. When that fetch
fails, it deploys without the check. When the upstream has new commits, it
asks to pull them with `git pull --ff-only`. It stops with nothing deployed
when that pull fails. With `--dry-run` it only says how many commits are new.
When
`node_modules/.package-lock.json` is missing, it runs `npm ci` first. In a
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

**Linked worktrees.** Every link points into the checkout deploy runs from.
Retiring a task deletes its worktree, so a deploy from a linked worktree would
leave every link dangling. `tools/deploy.ts` therefore refuses there, in one
line that names the main checkout: the folder that holds the git common folder.
It refuses before the wizard and for every flag but `--help` and `--migrate`,
which link nothing. `--from-worktree` deploys anyway and warns that retiring
the task breaks the links. `DEPLOY_FROM_WORKTREE=1` does the same without the
warning; it is for the tests, which may run in a worktree. When the
worktree that `ledger task retire` removes holds the target of
`~/.claude/bin/ledger` or `~/.local/bin/ledger`, retire warns, in its dry run
too, and names the deploy to run from the main checkout. It still retires.

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
- `runLedger` in `tools/ledger/cli.ts` runs a command line inside the test
  process.
  - Inputs: the home folder, working folder, environment, store and stdin.
  - Output: collected and returned, together with the exit code.
  - Each run first clears the time limits and caches an earlier run left.

  LLP 0002 sets out the design.

## Data and storage

| Data | File store | SQLite store | Git store |
|---|---|---|---|
| Backlog ledger | `~/.claude/ledger-backlog/<repo key>/<slug>.json` | `~/.claude/ledgers.db`, table `records` | `~/.claude/ledger-data/backlog/<repo key>/<slug>.json`, committed |
| Archive copy | `~/.claude/ledger-archive/<repo key>/<YYYY-MM-DD>-<slug>.json` | `~/.claude/ledgers.db`, table `records` | `~/.claude/ledger-data/archive/<repo key>/<YYYY-MM-DD>-<slug>.json`, committed |
| Archive evidence | `~/.claude/ledger-archive/<repo key>/<YYYY-MM-DD>-<slug>/` | `~/.claude/ledgers.db`, as bytes | `~/.claude/ledger-evidence/<repo key>/<YYYY-MM-DD>-<slug>/`, never committed |
| Old task list, read-only | `~/.claude/ledgers.json` | `~/.claude/ledgers.db`, table `registry`, only in a database an older version made | `~/.claude/ledgers-git.json`, never committed |
| Repo aliases | `~/.claude/ledger-aliases.json` | `~/.claude/ledgers.db` | `~/.claude/ledger-aliases-git.json`, never committed |
| Active ledger | `~/.claude/ledger-active/<repo key>/<slug>.json` | `~/.claude/ledgers.db`, table `records` | `~/.claude/ledger-data/active/<repo key>/<slug>.json`, committed |
| Store setting | `~/.claude/ledger-settings.json` | the same file | the same file |

The git store also keeps a clone lock, `~/.claude/ledger-data.lock`, and the
last sync problem, `~/.claude/ledger-data.status.json`, outside the clone.
Every git call that changes the clone holds the clone lock, so no two of them
run at once. The clearing of a rebase left in the clone holds it too, and needs
no lock of its own.

The file store writes backlog and active ledgers atomically. It holds a
lock file, `<target>.lock`, during each such write. `ledger store repair`
`--to`, `--lost` and `--remote` also hold `~/.claude/ledger-repair.lock`, with
any storage (see [The store](#the-store)). `withLock` in `tools/ledger/lock.ts` waits
up to five seconds for a lock. It takes over a lock whose process is gone or
that is older than one minute, except the clone lock and the repair lock,
which it keeps while their process runs.

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

A file store move takes the record and Markdown locks under both repo keys
in path order. Writes, creates, removals and archive copies use the same
locks. A writer waits up to five seconds and can reclaim a lock older than
60 seconds even if its holder still runs.

The move records each source inode before linking the file at the target.
A hard link fails with `EEXIST` if another entry already has that name.
Once all links exist, the move sets each source aside and compares its inode
with the one linked. It removes the files only after every source matches.
If a writer reclaimed the lock and replaced a source, the move puts the
sources back and refuses the move. A target record is taken back only while
the old key holds a record. Leftover Markdown alone does not authorize
removing a moved record. A target Markdown file is taken back while the old
key holds a regular file at its name or a record. A folder or a symbolic link
at the old key counts for neither. A record there is
newer, because a write puts a record in place of Markdown. Otherwise the link
is kept, because another mover finished and it may be the only copy. A source
removed by an unrelated command therefore brings the task back under the new
key. A takeover writer keeps its replacement except in the limits below.
A stop after linking but before removal
leaves the ledger under both keys. The next move finishes it. A stop while a
file is set aside can leave a `<file>.removing-<id>` link beside it. It
normally duplicates the file. If a writer reclaimed the lock and replaced
the file just before it was set aside, the link can hold that write.
Nothing reads the link, so the write would need to be put back by hand.

These limits require another process to take a lock from a live mover after
60 seconds. Automatic recovery would need a sweep, which is out of scope.

- The mover sets a writer's update aside. A second writer creates a file
  at the empty source name. Put-back fails because that name is taken.
  The first update is lost. The target holds the bytes from before it, or
  is absent when the move returns: the second writer's file at the source
  makes rollback take the target back.
- A writer reads the source before the mover sets it aside and publishes
  its update at the old key afterward. Both report success. The new key
  holds the older bytes.
- Another mover finishes and removes the source. Rollback sets the only
  target aside and then crashes. The record survives only in
  `<file>.removing-<id>`. Nothing reads it there. Put it back by hand.

Three more limits each need a hand-made store layout that no ledger command
produces.

- Case-equivalence is judged by JavaScript lower-casing. It can differ from
  the volume's Unicode folding, for example for `ſ`.
- A symbolic link used as a store folder inside the git clone is not
  detected by the pending-move check.
- A destination staged under one case spelling and present on disk under
  another is judged from HEAD only.

A file at the target that is a link of the one at the source (the same
device and inode) counts as linked, and when every file left at the source
is linked so, the move only removes them. A link onto another disk fails with
`EXDEV` at once, with nothing changed, and the move is left to do by hand.
A move between two keys whose repo folders are one folder, the same device
and inode, gives false before it takes a lock, and `canMove` gives false for
it: each file at the target is the one at the source, which would pass for a
link of it, so the move would remove the ledger, and the two spellings of one
lock file would make it wait on itself.
When a name at the target is taken, it takes back the links it made by the
rule above, and the move gives false. To take a link back, it moves it aside and checks the inode
before unlinking it. It tries to put a replacement back. A
ledger kept as Markdown also counts as taken when a record of its name is at the target, which would
hide it. A file of the ledger that is a symbolic link fails the move, with
nothing changed, as a link to it could lead elsewhere from the target;
`canMove` fails for it too, so a dry run says the same. An
evidence folder still moves by rename, which can replace only an empty folder.
A source repo folder the move leaves empty is removed when it can be; one that
stays fails nothing.

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
   `ledger task block` and `ledger task unblock` mark a task that cannot
   go on, and name what it waits for. Each refuses a move the state table
   of [LLP 0001 section 5.1](0001-ledger-workflow.plan.md#51-states) does
   not allow (`tools/ledger/states.ts`).
   `ledger task pr <url>` records the PR link and marks the task waiting. A
   code task cannot become waiting without that link. Each session start
   asks GitHub about the PR of each waiting task (`tools/ledger/pr-check.ts`).
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

A git stopped at the session-start deadline can leave a rebase half written:
`.git/rebase-merge` empty, or with only some of its files. `git rebase --abort`
fails on such a rebase, so a sync that asked for it stopped every later sync
too. A sync now clears a rebase with `git rebase --quit`, which leaves HEAD,
the index and the files as they are, but only when that loses nothing. All of
these must hold:

- HEAD is on the branch, and the rebase names that branch, if it names one.
- No commit was rebased (`done`) or stopped at (`stopped-sha`).
- The rebase started from the branch's tip (`orig-head`), if it names one.
- No file has a conflict.

Ledger changes not committed yet do not stop it, and neither do commits not
pushed yet: a pull rebases only when there are such commits, and `--quit`
leaves the branch on them. The sync then commits, pulls and pushes them. Any
other rebase stays, and the sync says what a person would lose and what to
run. It names `git rebase --continue` only for a rebase that got partway: HEAD
detached, a commit rebased or stopped at. A `.git/rebase-apply`, which `git am`
or a rebase that applies patches leaves, always stays, and the sync asks the
operator to finish or stop it. So `rebaseOnto` runs `git rebase --merge`, even
when the clone sets `rebase.backend` to `apply`: a rebase the sync itself leaves
behind is then always one in `.git/rebase-merge`, which it can clear. A fast-forward stopped at the deadline can still leave
`.git/index.lock`, which stops the next sync until a person removes it.
