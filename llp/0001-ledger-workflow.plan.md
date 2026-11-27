# LLP 0001: Ledger workflow

**Type:** Plan
**Status:** Draft
**Systems:** ledger CLI, ledger plugin, hooks, rules, subagents
**Author:** Christian Falch / Claude
**Date:** 2026-11-19
**Revised:** 2026-11-24
**Related:** LLP 0000

Some decisions are built. Section 14 lists the decisions; none is open.
Section 15 says, for each part, what is built and what is left.

## 1. Goal

The operator and the agent work through tasks with no missed steps. One CLI
tool, `ledger`, owns all task state. A Claude Code plugin exposes the same tool
as `/ledger:` commands, hooks and skills. Rules explain the workflow. Hooks
enforce the parts that must never be skipped.

The agent:

- always knows which task it works on, where that task sits in its tree, and
  what comes next;
- runs every task through plan, tests, code, verification and review, with
  subagents, before it offers a pull request (PR);
- at the end of a task, offers to retire it and to start the next one, or says
  that the tree is done;
- writes task state only through the tool;
- asks every question with fixed answers in the question widget, and always
  offers a way to stop;
- saves the ledger and clears the session often, so each session stays small.

## 2. Terms

- **Task**: one unit of work with a goal and a ledger. It ships as one PR, or
  as no PR (an investigation, a parent).
- **Ledger**: the task's notes: goal, plan, decisions, constraints, reports,
  open questions, report to the parent, next step. They are part of the task
  record; the Markdown a person or agent reads is a view of it (D29).
- **Task record**: one structured record per task in the store. It holds the
  task's fields and the lists of its ledger (D29).
- **Parent task**: a task whose work is split into child tasks. It has no
  worktree and no PR of its own.
- **Tree**: a root task and all tasks below it. A tree can span repos.
- **State**: where a task is in its life (section 5.1). The tool stores it.
- **Stage**: where an active task is in the build loop (section 5.2). The tool
  stores it.
- **Gate**: a point where the agent stops for the operator's answer.
- **Close**: save the ledger, clear the session and stop. Nothing else changes.
- **Store**: where the tool keeps every ledger, evidence file and the task
  list. Its type (file, SQLite, git) is a setting (section 4).
- **Repo address**: how the store identifies a repo: its remote address, or the
  path of its main checkout when it has no remote (D10).
- **Quick work**: work the operator declares does not need a task (D2).
- **Clear point**: a point where the ledger is saved, the session is cleared,
  and work goes on in a new session (D13).
- **Claim**: the mark that one session works on a task (D5).

## 3. Principles

1. **The tool is the source of truth.** State, stage, plan, decisions and the
   next step are read and written with `ledger`. The agent never infers them
   from conversation.
2. **Hooks enforce; rules explain.** A rule is advice. Anything that must
   never be skipped has a hook that blocks the wrong action and says the right
   command. A hook that fails lets the action through, and the failure is
   logged and reported at the next session start (D11).
3. **The tool proposes; the agent asks.** At each gate the tool prints the
   valid next actions. The agent shows them in the widget. The operator never
   types a command that the agent already knows. The widget is for questions
   with fixed answers. In an open discussion the agent asks in plain text.
4. **Stop is always one choice away.** Every widget at a gate has a Close
   option.
5. **Small context.** The ledger stays under about 4k tokens. Subagent output
   goes into the ledger as a short report, not a transcript. Frequent clear
   points keep each session small
   ([Sessions and clear points](#sessions-and-clear-points)).
6. **The command first; the plugin adds no logic.** Everything the plugin does
   is a `ledger` command that a person can run in a terminal, with the same
   result. The plugin adds widgets, hooks and slash commands around those
   commands, and keeps no task logic or data of its own.

## 4. Storage

All tasks of all repos live in one store on the machine. The store holds:
every ledger (backlog, active and archived), evidence files, and the task list
with parent links, order, state and stage.

**Decision D8 (2026-11-19, revised):** the store holds every task record,
active ones included. No copy of the ledger is kept in the worktree:
`.claude/ledger.md` no longer exists. Hooks, the agent and people read a task
through the tool (`ledger show`; with no slug it finds the task from the
current folder, by the worktree path the store records, D9). Every store type
(file, SQLite, git) keeps active tasks the same way, so the full tree is in one
place and, with the git store, on every machine. The store is always local
(SQLite is a file; the git store keeps a local clone), so reads work offline.
This depends on section 10: the two ship together, or D8 ships after it.

The worktree's `.claude/evidence/` folder stays: agents write evidence files
there during the work, and retire copies it into the archive, as today.

**Decision D29 (2026-11-19):** each task is one structured record. Its fields:
title, kind, state, stage, parent, order, dependencies, claim, PR, repo
address, worktree path and design refs (the LLP numbers the task touches,
D46). Its lists: plan steps, decisions (text, reason, tag,
date), constraints, open questions, step reports, the report to the parent,
general notes, the goal and the next step. Each write command (section 10)
writes one typed item and checks it on write. The task list is a query over
the records, not a separate cache. The Markdown a person or agent reads is a
view the tool renders from the record. How each store type keeps a record is
a technical choice (for example tables in SQLite; one file per task with a
header block of fields for the file and git stores). Existing Markdown ledgers
are converted once with today's parser; text that fits no list goes into
general notes.

**Decision D9 (2026-11-19):** the store records each task's repo and worktree
path. The task list is a view of the store; the tool no longer scans folders
such as `~/repos` and `~/issues` to rebuild it. `ledger store repair` finds tasks
whose recorded folder is gone or moved, and prints the command that fixes each.
`--to <folder>` points the task to a new folder, and `--lost` marks it lost.
A lost task keeps its active record, and its old folder is free for another
task. Only this command searches the disk, with `--search`, in folders the
operator names.

**Decision D10 (2026-11-19):** the store identifies a repo by its remote
address, such as `github.com/chrfalch/ledger`, not by its folder name. The
address is that of `origin`, else of the only remote. Normalize it: drop the
scheme, the user, a `.git` suffix and a trailing slash, and lowercase the whole
address, host and path, because GitHub paths and the default APFS volume ignore
case. It keeps a port that is
not the scheme's default, such as `host:2222/team/app`, so two servers on one
host stay apart. A repo with no such remote, or one whose address names no
host or repo path or has a port that is no number, falls back to the absolute
path of its main checkout. Two checkouts of one repo
share its backlog and archive. A task in a worktree belongs to the checkout that
holds the worktree; each task records its own worktree path (D9). People see a
short label: the address without its host, such as `chrfalch/ledger`, or the
last folder of a path. The store keeps an alias map from old keys to current
ones. `ledger store migrate --repo-ids` converts existing tasks once: it moves
each task filed under a folder name to its repo address, only on the same disk,
by a link at the target and then a removal at the source, which never replaces
a task, and records the folder name as an alias once a task moved there. It
moves nothing it is not sure of. A task whose main checkout is gone or not
known for sure, a task whose name the address already has, and a task on
another disk stay where they are. The command lists each such conflict and
exits 1, and a person fixes it by hand. `ledger store repair` detects a renamed
remote (D9). `ledger store repair --remote <old-key>` moves its tasks the same
way and keeps the old address as an alias. Neither command resolves a saved
main checkout against the folder it runs in: a relative one, such as `.`,
names no checkout, and the task stays with a reason that says so. A saved main
under `~` is read against the home the command runs with.

**Decision D1 (2026-11-19):** the store is a technical setting, outside this
spec. The tool supports Markdown files and SQLite, and GitHub support is in
progress. Every rule in this spec must work the same with each store.

## 5. Task model

### 5.1 States

| State | Meaning | Next states |
|---|---|---|
| backlog | Defined, not started. No worktree. | active, retired |
| active | Work in progress in a worktree. | parked, lost, blocked, waiting, done |
| parked | Stopped on purpose, with a date and a reason. | active |
| lost | Its worktree folder is gone, marked by `ledger store repair` (D9). | active (pointed to a new folder), retired (today `ledger task retire` still needs `--force` for a lost task) |
| blocked | Cannot continue: waits for an operator answer or another task. Names what it waits for. | active |
| waiting | PR open; waits for checks, review or merge. | active (fixes needed), done |
| done | PR merged, or no PR and the goal is met. | retired |
| retired | Ledger archived, worktree and branch removed. | — |

A parent task's state follows its children: active while any child is not
retired; done when all children are retired.

**A backlog task of a repo that is gone.** `ledger task retire <slug> --repo
<repo>` retires a backlog task of the repo `--repo` names, by its key, an alias
or its label, from any folder. It needs no checkout of that repo and runs no git
or gh. It archives the ledger under the repo's key and marks it retired in its
parent, both found by repo key. It refuses an active task; one whose worktree
is gone is marked lost first (D9).

**How the state is stored (D7).** The location of the ledger still decides the
three basic states: backlog (in the store's backlog), active (in a worktree)
and retired (in the archive). A `- status:` line in the ledger holds the detail
inside active: active, parked, blocked, waiting or done. Only the tool writes
it. The status line is not kept in the task list alone, because the tool can
rebuild the task list from the ledgers.

When a task names its PR, the tool checks the line against GitHub. A waiting
task whose PR is merged becomes done, and the tool offers to finalize it.

**A task with no PR (D15).** The agent never marks it done alone. When the
last stage passes, it asks: *Goal met / Not yet / Close*. Goal met makes the
task done.

### 5.2 Stages of an active task

| Stage | Work | Who | Gate at the end |
|---|---|---|---|
| plan | Investigate, write the plan and the acceptance criteria | orchestrator, `researcher` | **Plan approval** |
| red | Write tests for the criteria and see them fail | implementer | — |
| build | Make the tests pass | implementer (lane per routing rule) | — |
| verify | Full test suite and type check; confirm a non-zero test count | `runner` | — |
| review | Review against the spec and criteria | `reviewer` (+ `astra-reviewer` on critical work) | — |
| pr | Offer the PR | orchestrator | **PR approval** |

**Task kinds (D14).** A task has a kind, set when it is made
(`ledger task new --kind <kind>`, default `code`). The kind says which stages
apply, so no stage is skipped by hand:

| Kind | Stages | PR |
|---|---|---|
| code | plan, red, build, verify, review, pr | yes |
| docs | plan, build, review, pr | yes |
| investigation | plan, investigate, report, review | optional |

A code task that cannot have a test for one change still records why:
`ledger notes stage red --skip "<reason>"`.

### 5.3 Child order

A parent lists its children in order. A child may name the siblings it depends
on. The next child is the first one in order whose dependencies are done.
Stacked PRs use the same dependency field.

A dependency may name a task in another repo, by repo address and slug (D10,
D16). The tool reads its state from the store like any other task. A
dependency written before that repo's remote was renamed keeps the old
address. Once `ledger store repair --remote` records the old address as an
alias of the new one, the dependency names the same task. So `ledger tree
depends` counts a task named by an old address of its own repo as itself,
refuses a cycle through such a dependency, and keeps one dependency where an
old address and the new one name the same task.

Children with no dependency between them may run at the same time. `ledger
tree ready <parent>` lists every backlog child whose dependencies are retired
or done, in order, and each child already running. It only reads. It works
outside T3; `/ledger:fleet` uses it to choose what to start (D50).

### 5.4 Claims

A task is claimed by one session when the session starts work on it: at the
`go <slug>` prompt that starts each session in a task. Another session that
tries to start the same task gets a warning and a question with three
options:

- **Take over** ends the other session's claim, and this session continues
  the task.
- **Pick another task** lists the repo's tasks and asks which one to continue.
- **Stop** changes nothing.

The model may take over only the held task, right after the operator picks
"Take over" for it. The claim ends at close, park, retire and session end.

The claim is a line under `## Location` in the task's ledger:
`- claim: session <id> since <iso>, active <iso>`. The claim is taken once,
at `go <slug>`. After that, each finished turn counts as activity and
refreshes the `active` time, at most every 15 minutes. Claiming the task
again as its owner also refreshes it. Activity and release act on every claim
the session holds in the repo, however it took each one.

**Expiry (D17).** A claim whose session shows no activity for a set time ends
by itself. The time is the setting `claimExpiryMinutes` in
`~/.claude/ledger-settings.json`, with a default of two hours. A later session
then takes the task with no warning. This covers a session that crashed or was
closed without `/ledger:close`.

## 6. When a task is required

A task is required before the agent edits files, unless the operator says the
work is quick.

**Decision D2 (2026-11-19):** the operator declares quick work in plain words,
for example "this is a quick one" or "no task required for this". Then the
agent may edit files with no task. Nothing is blocked.

When quick work grows, the agent reminds the operator and offers to make a task
for it, with a goal written from the conversation. Signs of growth: a plan is
needed, more than two files change, or the work runs past a few exchanges.

Without such a statement, the agent offers to make a task before its first
edit.

## 7. The lifecycle

Each step names the command the tool provides and the widget the agent shows.
Every widget also has **Close**.

1. **Create.** `ledger task new <slug> --goal … [--parent <slug>] [--after <slug>]`.
   A split plan makes the parent first, then each child, in order. In a repo
   with an `llp/` folder, the agent reads the document titles, picks the LLPs
   the task touches and passes their numbers with `--design-refs`; with none,
   the record says none (D46).
2. **Start.** `ledger go <slug>`. A backlog task gets its worktree and branch.
   A parent starts its next child (section 5.3). The start also (D18):
   - installs the repo's packages in the worktree, so the first test run
     does not fail. A worktree with a lockfile at its root and no
     `node_modules` runs the first match of `bun install --frozen-lockfile`
     (`bun.lock`, `bun.lockb`), `pnpm install --frozen-lockfile`, `yarn
     install --frozen-lockfile` or `npm ci` (`package-lock.json`,
     `npm-shrinkwrap.json`). A failed install exits 5 and keeps the worktree,
     the ledger and the claim, so the same `ledger go` installs again;
   - claims the task for this session (D5), and with `--take-over` takes the
     claim from the session that holds it. A task in another repository is
     not claimed, because this session's release covers only its own repo. After the clear, the new session's
     `go <slug>` claims it with `--from <old session>`, which takes over the
     claim of that session only;
   - records the task's repo and worktree path in the store (D9).
   
   The session moves into the worktree.
3. **Plan.** The agent reads the task's design refs first. A lasting design
   decision the task makes goes into an LLP document (an existing one or a new
   one) in the same PR, and the reviewer checks that it did (D47).
   The agent writes the plan with `ledger notes plan`. For a task with more
   than one file or a design choice, widget: *Approve plan / Change plan /
   Close* (D3).
4. **Red, build, verify, review.** Delegated to subagents. After each, the
   agent records the outcome with `ledger notes stage <stage> <outcome>` and the
   report with `ledger notes report --step`.
5. **Clear point.** After each review verdict with work left, and when the
   session grows large, the agent offers a clear point (see
   [Sessions and clear points](#sessions-and-clear-points)).
6. **PR.** Widget: *Commit, push and open the PR / Not yet / Close*. The agent
   records the PR link with `ledger task pr <url>` (D19). The task moves to waiting.
7. **Waiting.** At each session start, the tool checks the PR of every waiting
   task in the tree and reports what changed (D20). In a main checkout, it
   checks every waiting task of the repo. It asks gh about all PRs at once and
   waits at most 3 seconds. Each outcome below that has a line goes under
   *Needs you:* in the session-start report (section 9):
   - PR merged, here or elsewhere: the task becomes done and step 8 runs;
   - checks failed or review asked for changes: the task goes back to active
     at stage build;
   - checks and review passed: the PR is ready to merge; widget *Merge now /
     Not yet / Close* (D4);
   - PR closed without merging: a line, and nothing changes;
   - gh failed or did not answer in time: a line, and nothing changes;
   - checks still running or review still required: no line. A check whose
     conclusion is STALE, or a commit status that is EXPECTED, counts as
     still running.
   
   A child whose PR is stacked on its parent's branch is rebased onto the
   default branch after the parent merges. Stacked PRs merge bottom-up.
8. **Finalize.** Triggered when the task becomes done. The tool lists the
   valid actions: retire this task, retire other done tasks, start the next
   child, or, when every child is done, finalize the parent. Widget
   (multi-select): those actions + *Close*. `ledger task gate finalize`
   prints it, with the other done tasks as one action, so the widget keeps to
   three actions plus *Close* (D49). Other done tasks whose worktree is on
   another machine are left out, as they cannot be retired here. Before each
   ticked retire, the agent runs a retire dry run, as the operating-model rule
   says, and stops on any problem. When the session is inside the worktree it
   retires, the session leaves the worktree first (D21).
9. **Up the tree.** When the last child of a parent retires, the parent
   becomes done and step 8 runs for the parent. At the root, the agent says
   that the tree is done.

### Sessions and clear points

One task runs over many sessions. A session ends at a clear point: the ledger
is saved, the session is cleared, and work goes on in a new session. The
reason is cost: everything a session has read is paid for again on every
turn, so small sessions are cheap sessions. A ledger that is saved often is
also a ledger that is never far behind.

**Three ways to end a session.** Each one saves the ledger first.

| Command | After the clear |
|---|---|
| `/ledger:next` | The new session continues the same task from its next step. |
| `/ledger:go <slug>` | The new session continues in another task. |
| `/ledger:close` | Nothing. Work stops. |

**When the agent offers a clear point (D13):**

- after each review verdict while work remains, a rejected review included;
- when the session grows past a set size. The size is a setting with a
  default. The offer comes at the end of a turn, never while a subagent runs.

**The offer (D13).** One widget, with one choice for save, clear and continue:

- *Save, clear and continue* (recommended): the agent saves the ledger
  through the tool, then starts `/ledger:next`. The session clears and the new
  session starts from the next step by itself, with no typing.
- *Not now*: the work goes on. The size offer comes again after more growth.
- *Close*: save and stop.

**What the next step must be.** Something a new session can do with no memory
of the old one: the action, the agent and effort, and the files or reports to
read. The new session also gets the tree, state and stage (section 9).

**Change needed in the plugin.** Today only the operator may type
`/ledger:next`, `/ledger:close` and `/ledger:park`, because they clear the
session; the plugin refuses them from the agent. D13 needs the agent to start
`/ledger:next` after the operator chose *Save, clear and continue*. How the
plugin confirms that choice is a technical decision for that task.

**Measuring size.** How the tool learns the session's size is a technical
decision for that task.

## 8. When a step fails

| Failure | Next |
|---|---|
| Plan not approved | Stay at plan; revise. |
| Tests do not fail at red | Stop: the test does not test the criteria. Fix the test. |
| A test seems wrong at build | The implementer does not change it. It becomes an open question; the task goes to blocked. |
| Verify fails | Back to build with the runner's verdict. |
| Review rejects | Back to build with the findings. Clear point first. After two rejected rounds, the next round runs at higher effort and the agent tells the operator. After a third rejection, the task goes to blocked and the agent asks the operator what to do (D22). `ledger notes stage review fail` counts the rounds and blocks the task; from the third on, a task that is blocked already keeps its block reason, and one that is parked, waiting or lost is refused, as it cannot move to blocked. |
| A subagent fails, times out or returns an empty report | The agent tells the operator what failed and asks what to do. It does not retry on its own (D23). |
| PR checks fail or review asks for changes | waiting → active, stage build. |
| Merge conflict when the branch is updated | Back to build. The agent resolves the conflict; verify and review run again (D24). |
| The task is no longer needed | Abandon: the operator confirms in a widget; the ledger is archived with the reason "abandoned"; nothing is merged. `--force` stays for emergencies (D25). The widget comes from `ledger task gate abandon`; `ledger task abandon --reason` archives. |
| Work outside the goal appears | `ledger task new` makes a new backlog task. The current task goes on. |

## 9. Awareness

At session start, after a clear and after a compaction, a hook gives the agent
a report in this fixed order (D26):

1. **What needs the operator:** blocks and open questions; waiting PRs that merged, failed checks
   or got review comments (D20); tasks in this tree that another session
   holds (D5); hook failures since the last report (D11).
2. **Where the agent is:** the tree as a short path, root › parent ›
   **current task**, with each sibling's state; the current state and stage.
3. **What comes next:** the next step, then one line on what follows this
   task: the next sibling, or "last child: the parent finalizes next".

The report stays under about 20 lines, because it is read again on every turn.
Details come from `ledger show`.

**A session outside any task (D27).** In a main checkout, the agent lists the
open trees of the repo and asks: continue one of them, make a new task, or
quick work (section 6).

**The status line** shows the current task and stage. It reads only the store,
never GitHub or the network, because it refreshes often (D28).

**The session name** is always `<icon> <slug>` for the task the session works
on, where the icon shows the task's state. The first state that applies gives
the icon: ✅ done, ⛔ blocked, 💤 parked, 🟡 an open question for the operator,
⏳ waiting, 🔍 at the review stage, 🔨 working on anything else. The name
changes each time the session creates, enters or switches to a task, and each
time that task's state changes, so the session list shows which task each
session holds and which ones need the operator (D43). How the tool sets the
name is a technical choice; the operator never renames by hand.

A plain "go" lists the claimable tasks. With one, the agent continues. With
more, it asks in a widget.

## 10. Writing the ledger

The agent changes a task only through `ledger` commands. **Decision D30
(2026-11-19):** the commands are grouped by what they change.

| Group | Command | Changes |
|---|---|---|
| `ledger task` | `new <slug> --goal … [--kind <kind>] [--parent <slug>] [--after <slug>]` | Makes a task (D14) |
| | `go <slug>` | Starts a task (section 7, step 2) |
| | `park <slug> --reason …` / `unpark <slug>` | Parked state |
| | `block <slug> --on …` / `unblock <slug>` | Blocked state (D7) |
| | `retire [<slug>] [--dry-run]` | Archives a done task (D21) |
| | `abandon [<slug>] --reason …` | Archives a task with no merge (D25) |
| | `show [<slug>]` / `list` | Reads a task, or the live tasks |
| | `pr <url>` | Records the PR link (D19) |
| | `done [<slug>]` | Done state: a task with no PR on *Goal met*, or one whose PR is merged (D4, D15) |
| `ledger notes` | `plan` | Plan steps and owners |
| | `stage <stage> <outcome>` | Stage and step status |
| | `decide "<text>" --because "<reason>" --tag <tag>` | Decisions |
| | `constraint "<text>" --source "<where>"` | Constraints |
| | `question "<text>" [--blocks <n>]` / `question --resolve <id>` | Open questions |
| | `report --step <n> --file <path>` / `report --parent "<text>"` | Step reports; the report to the parent |
| | `note "<text>"` | General notes (D29) |
| | `next "<text>"` | Next step |
| | `check` | Structure and size check |
| `ledger tree` | `show [<slug>]`, `add`, `remove`, `start`, `order`, `depends`, `next` | Parents, children, order, dependencies (D16) |
| `ledger store` | `migrate`, `repair`, `check`, `sync` | The store (D1, D9) |
| `ledger worktrees` | as today | Worktree and build folders |

`ledger go`, `ledger list` and `ledger show` stay as short forms of the `task`
commands. `hook` and `session` are for Claude Code and stay out of the normal
help. The old `ledger task <slug>` is now `ledger task new <slug>`, and the old
`ledger parent` is now `ledger tree`. Every caller (plugin prompts, rules,
tests, hook settings) changed at once; no old names are kept.

There is no ledger file to edit (D8). A PreToolUse hook catches an agent that
tries to write `.claude/ledger.md` from habit and names the command to use.
The same hook blocks any hand write to the ledger store, by a file tool or a
shell command, and names `ledger show`, `ledger notes` and `ledger store`.
`ledger notes check` runs after each write. Retire refuses a child task with no
report to its parent.

**Decision D31 (2026-11-19):** the ledger stays small by itself. When a step
passes review, the tool shortens its step report to one line. When the ledger
is still over the size limit, `ledger notes check` fails and names what to
shorten.

**Decision D32 (2026-11-19):** deploy adds the `ledger` commands to Claude
Code's allowed commands, so the agent can write the ledger often with no
permission prompt for each write. Commands that only the operator may run
(today `TYPED_ONLY` in the plugin, changed by D13) keep their own check.

**Decision D11 (2026-11-19, revised):** a hook that fails still lets the action
through, because a crashed hook cannot tell which file an action targets. A
failing hook writes one line to a log file. The next session start reports how
many hook failures happened, and since when. (The drift check of the first
version is gone: with no worktree copy, nothing can drift.)

## 11. Questions to the operator

- The tool prints the valid actions for the current gate as JSON. The agent
  turns them into a widget. The first option is the recommendation.
- Each widget at a gate includes Close.
- At most four questions per widget and four options per question. More
  choices are split across widgets.
- A subagent cannot show a widget. It returns the options as text, and the
  orchestrator asks.
- A question with an open answer (a name, a value) is asked as text and
  starts with ❓ (D37).
- A gate gives at most three actions; Close is the fourth option (D33).
- In a multi-select widget, Close ticked with other actions runs those
  actions, then closes. Close ticked alone runs nothing and closes (D34).
- The widget can hide the text above it. Each action in the tool's JSON has a
  label and a one-line description in plain words of what it changes. Each
  question makes sense alone. The recommended label ends with
  "(Recommended)" (D35).
- Every plan starts with a plain summary of at most two sentences, stored
  in the ledger. The plan gate's question carries that summary and the step
  count, and the gate refuses a plan with no summary or no steps. The full
  plan is sent with send_to_user, or shown in full, before the widget (D52).
- During an operator walkthrough of a document, questions are plain text, one
  point at a time. The widget returns at the next gate (D36).
- `/ledger:fleet <parent>` runs a parent's children in T3 threads. A question
  in a child thread that has a recommended option is answered with that
  option, plan and PR approval included, and the answer is logged in the
  parent ledger. When any question in a request has no recommended option,
  the whole request comes to the operator with a short summary. A permission prompt cannot be answered this way and stays with the
  operator (D50).

## 12. Enforcement

| Requirement | Hook | Tool | Rule |
|---|---|---|---|
| A task exists unless quick work is declared | — | `ledger task new` | offer a task before the first edit; remind when quick work grows (D2) |
| Ledger written only through the tool (D38) | blocks Edit/Write and shell commands that change the store; `ledger` itself is allowed; a failed hook lets the action through and logs it (D11) | write commands | names the commands |
| Stages in order | — | `ledger notes stage` refuses to skip a stage without `--skip` | explains the loop |
| Plan and PR approval (D33, D35, D52) | — | gate actions as JSON: at most three plus Close, each with label and description; the plan question refused without a summary and steps | widget wording; walkthrough exception (D36) |
| PR link before waiting (D39) | — | refuses to set a code task to waiting until `ledger task pr` recorded the link | — |
| Report to parent before retire | — | `ledger task retire` refuses | — |
| Tree awareness (D26–D28) | session start, compaction, prompt submit | `ledger session --tree` | — |
| Close always offered | — | every gate action list includes close | widget wording |

## 13. Proof that it works

- Unit and end-to-end tests for every command and hook.
- Scripted agent runs (`claude plugin eval`) that take a sample task through
  the full lifecycle: create, plan, red, build, verify, review, PR, finalize,
  retire, next child, tree done. Each run checks the commands called, the
  widgets shown and that no ledger file was edited by hand.
- Two more scripted runs cover failure: a review fails and the agent returns
  to build (section 8); the operator picks Close mid-run and a new session
  continues with `go` from the right step (D40).
- The scripted runs also check that each widget has at most three actions
  plus Close (D33), that waiting is refused before a PR link exists (D39),
  and that a shell write to the store is blocked (D38) (D41).
- A test run counts only when it ran more than zero tests. Scripted agent
  runs are not part of `npm test`; they run on demand and before each
  release, and they check the commands called, not the agent's wording (D42).

## 14. Decisions

Decided 2026-11-19:

- **D1** Store: a technical setting, outside this spec (section 4).
- **D2** Quick work: the operator declares it; the agent reminds when it grows;
  nothing is blocked (section 6).
- **D3** Plan approval only for tasks that touch more than one file or include
  a design choice. Other tasks go from plan straight to red.
- **D4** The agent merges only when asked: after checks and review pass, it
  asks "Merge now?" and merges on yes. Then step 8 runs.

- **D5** Claims: a second session is warned, sees who holds the task and
  since when, and is asked to take it over or pick another task (section 5.4).
- **D7** State storage: the ledger's location gives backlog, active and
  retired; a tool-written `- status:` line gives the detail inside active;
  GitHub is a check for waiting and done (section 5.1).
- **D8** (revised) The store holds every task record, active ones included;
  no ledger copy in the worktree; `.claude/evidence/` stays (section 4).
- **D9** No folder scan: the store records each task's repo and worktree
  path; `ledger store repair` handles moved or missing folders (section 4).
  Result (2026-11-22): `--to` and `--lost` check again under the record's
  lock. Every write of `ledger store repair`, `--to`, `--lost` and
  `--remote`, also takes the lock `~/.claude/ledger-repair.lock`, as a
  record's lock covers one record: without it two `--to` runs could give two
  tasks one folder, and a second `--remote` run could take back the alias the
  first recorded. `--remote` holds it from before it lists the old key's
  ledgers, as it plans its moves by what it lists. No run takes the lock over
  while the process that holds it runs, however long. `--search` refuses a folder
  whose path, part by part as named and before any `..` is dropped, goes
  through a symbolic link. It skips a named `.git`, `node_modules` or
  `.claude/worktrees/.build` folder, and a named folder inside one, by the rules of a folder found in the
  search, and by the name the folder has on disk, so another case of it is
  skipped too on a disk that ignores case.
  Result (2026-11-25): a backlog task whose repo folder is gone is retired
  with `ledger task retire <slug> --repo <repo>`, from the store alone
  (section 5.1). A saved main checkout that is a relative path names no folder
  to repair (D10).
- **D10** Repos are identified by remote address, with the main checkout's
  path as fallback; `ledger store migrate --repo-ids` converts existing tasks
  once and keeps each folder name in an alias map; renamed remotes come with
  `ledger store repair` (section 4).
  Result (2026-11-22): the normalization is built. `remoteKey` drops the
  scheme, the user, a `.git` suffix and a trailing slash, lowercases a network
  address, and keeps a port that is not the scheme's default. A remote that is
  a local path or a `file://` address gives its absolute path, with its case
  kept.
  Result (2026-11-22): `ledger store repair --remote` writes the old → new
  alias before it moves anything, as the record of what the run is for, and
  takes it back when a move leaves anything under the old key. A failed git
  commit keeps it, as an alias is never committed and the next sync commits
  the moves. Without it, a run that
  moved every task and then failed to write the alias left nothing under the
  old key and no alias, and a rerun could not tell that key from one that
  never had a task. A rerun that finds the alias recorded already still moves
  evidence left under the old key whose archive copy is under the new key, so
  a run stopped after the alias write finishes on rerun. A dependency on a
  task finds it under any key of its repo, aliases included.
  Result (2026-11-23): a file store move links each file at the target, then
  removes it from the source, in place of a rename. A link never replaces an
  entry, so a ledger another command made at the target after the check
  stays; the move then removes its own links and gives false. A move that
  stops between the two steps leaves the ledger under both keys, never under
  neither. A move onto another disk fails at the link, with nothing changed,
  and is left to do by hand.
  Result (2026-11-23): the move takes the record locks under both keys in
  path order. Creates, writes and archive copies take the same locks.
  A symbolic link among the ledger files fails the move. A source folder
  the move emptied but cannot remove no longer fails the move, so the alias stays and a rerun finishes. A
  failed git commit keeps the alias also when a move failed. A rerun that
  finds the alias recorded commits whatever a killed run left uncommitted, or
  exits 1 with the sync message.
  Result (2026-11-23): a rerun finishes a move killed between its link and its
  removal. A file at the target that is a link of the source file, the same
  device and inode, counts as linked, so the move only removes the source.
  Markdown left under the old key by a run killed between removing a record
  and the Markdown it hid, a link of the Markdown the moved record hides, is
  removed without a look at the checkout it names, which may be gone. An old
  key that is the same repository folder as the new key in a file or git
  store, as a key and its URI encoding are, makes `--remote` refuse before it
  writes anything, and a move between such keys gives false, as it would
  remove the ledger it moves.
  After the commit, repair checks HEAD holds each moved path as the disk
  does. A removal git left out exits 1 on every rerun. A dry run fails for a
  symbolic link, as the move does. A repo folder of the old key that cannot be read fails the run, where it read
  as empty; every other command still passes such a folder over. The
  search skips `node_modules`, `.git` and `.claude/worktrees/.build` in any
  case, and any folder named inside one. `--to` records the main checkout by the record it reads under the
  lock.
  Result (2026-11-23): repair names an unreadable old-key evidence folder
  and exits 1. A record or Markdown linked under both keys finishes moving
  even if its checkout has gone. Before removing a source or taking back a
  target link, the move sets it aside and checks its inode. A writer that
  takes over a lock after 60 seconds keeps its replacement, except in the
  limits LLP 0000 records. Repair, ordinary commands and sync recognise a
  pending git move by the old → new alias, an old path in HEAD that is gone on
  disk, and a new file with the exact spelling of the new path and the same
  blob. HEAD may hold the new path only with that same blob and that spelling;
  the old path's removal is then still committed as the move's last half.
  2026-11-23: rollback, case-variant HEAD paths, a committed move's late
  removal, the half-moved slug check and case-variant evidence folders were
  fixed; three crash-and-takeover windows are recorded as accepted limits.
  The half-moved slug check now compares each ledger against every other
  ledger. It leaves out only the ledger's own half-moved copy, found by the
  file its name resolves to. Three layouts are recorded as limits in LLP 0000:
  JavaScript lower-casing as the case test, a symbolic link used as a store
  folder inside the clone, and a destination staged in one case spelling and
  on disk in another.
  Result (2026-11-25): a saved main checkout is read as a person may have
  damaged it. A lone backtick at either end is dropped, and `~` is the home the
  command runs with. A relative one, such as `.`, is never resolved against the
  folder the command runs in: `migrate --repo-ids` and `repair --remote` leave
  the task with the reason "its saved main checkout "." is a relative path, so
  its repo folder cannot be recovered", in the old task list too, unless an
  alias or another ledger of its folder name places it. A finished task left
  so counts as accepted, as one whose folder is gone does. A new ledger refuses
  a main checkout that is not an absolute path.
- **D11** (revised) Hooks still let actions through when they fail; a hook
  failure log reports them at session start (section 10).
- **D12** LLP 0000 stays current: a PR that changes how the system works
  updates it (CONTRIBUTING; the reviewer checks it), and `npm run llp` warns,
  without failing, when a PR changes a file with an `@ref LLP 0000` comment but
  not LLP 0000.
- **D13** Clear points: offered after each review verdict with work left and
  when the session grows past a set size; one widget choice saves, clears and
  continues with `/ledger:next`; the agent may start `/ledger:next` after that
  choice (section 7, Sessions and clear points).
- **D14** Task kinds: code, docs and investigation; the kind sets the stages
  (section 5.2).
- **D15** A task with no PR becomes done only when the operator answers *Goal
  met* (section 5.1).
- **D16** A dependency may name a task in another repo by repo address and
  slug (section 5.3).
- **D17** A claim expires after a set time with no activity, default two hours
  (section 5.4).
- **D18** Start installs packages, claims the task and records its repo and
  worktree (section 7, step 2).
- **D19** The PR link is recorded with `ledger task pr <url>` (step 6).
- **D20** Waiting tasks are checked against GitHub at each session start
  (step 7).
- **D21** Finalize runs a retire dry run first, and leaves the worktree before
  retiring it (step 8).
- **D22** Review limits: higher effort after two rejected rounds; blocked and
  the operator is asked after the third (section 8).
- **D23** A failed subagent is reported to the operator, who decides what to
  do; no automatic retry (section 8).
- **D24** A merge conflict sends the task back to build; verify and review run
  again (section 8).
- **D25** Abandon: a confirmed retire without merge, archived with the reason
  "abandoned" (section 8).
- **D26** The session-start report has a fixed order (needs the operator,
  where, next) and stays under about 20 lines (section 9).
- **D27** A session outside any task lists the repo's open trees and asks:
  continue, new task or quick work (section 9).
- **D28** The status line reads only the store (section 9).
- **D29** One structured task record per task; the task list is a query over
  records; Markdown is a rendered view; existing ledgers are converted once
  (section 4).
- **D30** Commands are grouped: `task`, `notes`, `tree`, `store`,
  `worktrees`; `go`, `list` and `show` keep short forms; every caller changes
  at once (section 10).
- **D31** Step reports shrink to one line when the step passes review; `ledger
  notes check` fails over the size limit (section 10).
- **D32** Deploy allows the `ledger` commands, so writes need no permission
  prompt (section 10).
- **D33** A gate gives at most three actions, plus Close (section 11).
- **D34** Close in a multi-select widget: with other actions, run them and
  close; alone, close only (section 11).
- **D35** Gate actions carry a label and a plain-words description; each
  question stands alone; the recommendation ends with "(Recommended)"
  (section 11).
- **D36** Operator walkthroughs use plain-text questions, no widget
  (section 11).
- **D37** Open-answer questions start with ❓ (section 11).
- **D38** The write hook guards the store, not worktree files, and checks
  shell commands as well as Edit/Write; `ledger` is allowed (section 12).
- **D39** A code task cannot become waiting without a recorded PR link
  (section 12).
- **D40** Scripted runs include a failed review and a Close-then-resume run
  (section 13).
- **D41** Scripted runs check D33, D38 and D39 (section 13).
- **D42** A zero-test run is not a pass; scripted agent runs are on demand
  and before release, not in `npm test`, and check commands, not wording
  (section 13).
- **D43** The session name is always `<icon> <slug>` for the current task, the
  icon showing its state (section 9), set on every task change and every state
  change.
- **D6** (decided 2026-11-19) Worktrees live in one folder next to the main
  checkout, `<repo>.worktrees/<slug>`, not inside it; the tool finds the main
  checkout through git, not the folder path. Reason: a test runner that
  ignores `.claude` collects zero tests in a nested worktree and reports
  success (D42 makes that a failure but does not remove the cause).
  Condition: Claude Code switches between worktrees only under
  `.claude/worktrees/`, so the first step of this work is a test that
  `/ledger:go` moves a session from one sibling worktree to another through
  the main checkout. If that test fails, worktrees stay in
  `.claude/worktrees/` and D42 is the safeguard. Own task.
  Result (2026-11-19, Claude Code 2.1.328): the test failed, so worktrees
  stay in `.claude/worktrees/`. The switch itself works through the main
  checkout, but every `EnterWorktree` outside `.claude/worktrees/` asks for a
  "permission-root relocation" confirmation, and no settings allow rule
  removes it. Headless sessions cannot answer it, and an interactive session
  would ask on every task switch.
- **D44** (decided 2026-11-19, revised the same day after D6 failed) Xcode
  build folders move out of Xcode's DerivedData to
  `<main checkout>/.claude/worktrees/.build/<name>/<configuration>`, where
  `<name>` is the worktree folder's name and `.main` stands for the main
  checkout. Reason: DerivedData folders are named by a path hash, so a
  removed worktree's folders are hard to match and pile up. A folder named
  after its worktree is easy to match. The folder sits next to the
  worktrees, not inside one, because the React Native bundler (Metro), Jest,
  editor file watchers and Spotlight ignore `.gitignore` and would walk a
  build folder inside a worktree. `bin/cc-dd-path` hides the folder from git
  through the repo's shared `info/exclude`. `bin/cc-dd-path`, the build rule
  and the build-path hook change with it, and retire deletes the task's
  folder. Old `cc-*` folders in Xcode's DerivedData are deleted once, by
  hand, after the change merges.
  Result (2026-11-21): DerivedData on the operator's machine holds no `cc-*`
  folders. Other machines were not checked.
- **D45** With D44, `ledger worktrees derived-data` is removed with its docs
  and tests. `ledger worktrees prune-orphans` keeps its name but deletes the
  `.build/<name>` folders that no linked worktree matches, instead of
  DerivedData folders.
- **D46** In a repo with `llp/`, the task record keeps the LLP numbers the task
  touches (design refs), picked when the task is made; none when no LLP
  matches (section 4, step 1). Keeps today's `--design-refs` behaviour.
- **D47** The plan stage reads the design refs; a lasting design decision goes
  into an LLP in the same PR; the reviewer checks it (step 3). Replaces the
  LLP line in the operating-model rule.
- **D48** Deploy runs the one-time moves of stored task data, so the operator
  does not have to remember them. The `bin/deploy` wizard has a Migrate entry
  beside Deploy and Revert. Every deploy runs the `--active` move without
  asking, because the installed ledger reads active ledgers only from the
  store. After that the wizard asks whether to run the other pending moves,
  and asks nothing when none are left; it shows the tasks that need a person,
  with the reason, either way. A plain `bin/deploy` names the other moves.
  `bin/deploy --migrate` runs them without asking and deploys no files; with
  `--dry-run` it only lists them. It skips the check for new upstream commits,
  so it never asks to pull. The list comes from
  `ledger store migrate --pending`: the existing `--repo-ids`, `--active` and
  `--records` moves report each item through a callback during a dry run.
  Reason: one implementation, so the list follows the moves' own rules. The
  list is a preview: each move checks again when it runs, and can leave a task
  the list showed as movable, so deploy checks again before each kind it
  runs. Deploy runs `bin/ledger` as a separate process, because deploy supports
  Node 20.12 and the SQLite store needs Node 22.13. An item a move would leave,
  such as one whose name is taken, is never run automatically; it waits for a
  person, and is not a failure: `--migrate` exits 1 only when a check fails, a
  move cannot start or breaks, or a move it could have made is still left.
  A store switch from the wizard previews the `--to` dry run and keeps the
  source; a preview that opens git storage may put back the clone's pre-push
  hook (LLP 0000).
- **D49** The finalize question offers the other done tasks of the repo as
  one action that names each, not one action per task. Reason: the widget
  then keeps to three actions plus Close (D33). Retire does not yet refuse a
  task that is not done. Reason: no tool sets a task waiting until
  `ledger task pr` exists, so most finished tasks are not marked done yet
  (section 7, step 8).

Decided 2026-11-24:

- **D50** `/ledger:fleet <parent>` starts each child that `ledger tree ready`
  lists in its own T3 thread, up to `fleetParallel` in
  `~/.claude/ledger-settings.json` at a time (default 2). It holds back a
  child that may touch the same files as a running one, and tells the
  operator. It answers child questions as section 11
  says. Only the operator starts it: it is in the hook's typed-only list, as
  `/ledger:close` and `/ledger:park` are, so an agent cannot run it through
  the Skill tool, and nothing changes until a person types it. It runs in the
  main session, because only the main session can show the operator a widget.
  It stops when every thread it watches waits for a person (review, merge, a
  permission prompt), and the operator types it again after a retire. Each
  thread it starts is a note `fleet started <child> in thread <id>` in the
  parent ledger, so a later run picks the threads up. Reason: a watch loop
  that never ends would hold the session while children wait for a merge.

Decided 2026-11-26:

- **D52** A plan has a summary of at most two sentences: one `Summary:`
  line under the plan heading, set with `ledger notes plan summary`, which
  refuses an empty text, a line break or a third sentence. `ledger task gate
  plan` asks `Approve the plan for <slug>? <summary> (<n> steps)`, with the
  step count taken from the plan rows, and refuses without a task, a summary
  or a step. Reason: the widget hides the plan written above it, so the
  operator approved a plan they could not see (section 11). D51 is left to
  the control-room design.

## 15. From today to this spec

| Area | Today | Work |
|---|---|---|
| States | backlog, active, parked, blocked, waiting, done, lost, retired; the moves of section 5.1 inside active are one table (`checkTransition` in `tools/ledger/states.ts`), which `ledger task park`, `unpark`, `block` and `unblock`, `ledger store repair --to` and `--lost`, the done mark of a merged PR (`markMergedDone` in `tools/ledger/write.ts`) and `ledger task done` (`doneTask` in `tools/ledger/write.ts`) check before they write; `ledger task block <slug> --on <text>` writes the blocked status line and keeps the claim, and `ledger task unblock` removes it; `ledger store repair` names only `--to` for a blocked, waiting or done task whose folder is gone, as `--lost` refuses it, and `--to` of a lost task removes the lost mark and keeps its status line | set waiting with `ledger task pr` (PR waiting row) |
| Stages | free text in the plan table | `ledger notes stage`, ordered and checked |
| Child order (D16) | `ledger tree order` and `ledger tree depends` set the order and dependency fields; a dependency may name a task in another repo as `<slug>@<address>`; `ledger tree next` and `ledger go <parent>` pick the first child in order whose dependencies are retired or done (`firstToStart` in `tools/ledger/write.ts`) | none |
| Fleet (D50) | `ledger tree ready <parent> [--json]` lists every ready backlog child in order and each running child (`changeParent` and `startable` in `tools/ledger/write.ts`); `/ledger:fleet` in `mods/ledger/commands/fleet.md` starts, watches and answers T3 threads; `ledger:fleet` is in `TYPED_ONLY` in `mods/ledger/hooks/register.ts` | none |
| Ledger writes (D38) | `ledger notes` writes each item; the PreToolUse hook denies Edit, Write and MultiEdit of a store path and shell commands that write one: a redirect, tee, sed -i, cp, mv, rm, rmdir, touch, truncate, mkdir, ln, sqlite3 without -readonly on the database, git commands in the clone other than reads, and a git clone, a log, show, diff, diff-tree, diff-index or archive --output, or an archive -o into the store; a `--help` or `--version` before the first operand of cp, mv, rm, rmdir, touch, truncate, mkdir, ln or tee, with only options before it, counts as no write, and one after an operand as a file name, as the BSD tools of macOS read it; rm, rmdir and an mv source also count when they name a folder above the store, and a glob counts when it could match a store path; `ledger` itself is allowed unless it redirects into the store (`storeWriteReason` in `tools/ledger/hooks.ts`). The operator resolves a sync conflict in a terminal; the hook's reason and the sync's conflict messages tell an agent to ask them. The hook catches habit, not an adversary, so it misses interpreters, bash -c, eval, dd, rsync, install, chmod, find -delete, xargs from stdin, GIT_DIR=, variables other than HOME, pushd, where `cd -` leads, a command after a `case` pattern's `)`, symlinks through missing folders, git init with an explicit destination, git clone with no destination run inside the clone, `git config --file` on the clone's config, a target that starts with a command substitution (one that ends in `.claude/ledger.md` is still denied), cp -R of a folder's contents (`<src>/.`) over the store's parent, sqlite3 `file:` URIs with `mode=rw`, a `#` inside `$(...)`, which it reads as a comment as bash does, cp with a process substitution `<(...)` as a source, the arguments after a process substitution (`tee < <(printf x) .claude/ledger.md`), `git clone --separate-git-dir` into the store, and sqlite3 dot-commands that name another file (`.backup`, `.save`, `.output`); it counts a `cd` behind `&&` or `||` as run (`false && cd /tmp`), and of the cds in the branches of an `if` it counts the last in the text (`if true; then cd .claude; else cd /tmp; fi`), and it counts a cd inside a function definition as run even when the function is never called (`f() { cd ..; }`); it expands each brace group of a word without a cap on the words that makes, as habit commands hold few; it reads a shortened git apply long option (`--cach`, `--ind`, `--app`) as no option and does not count the file that `git apply --stat --build-fake-ancestor=<file>` writes; it does not unquote a quoted redirect target such as `>> $'ledger.md'`; it does not read `git archive -o<file>`, with the file attached to `-o`, as an output, counts every `-o` of a git archive, so one that names a store path denies even when a later `-o` wins, and counts an `-o` after `--` as an output; it does not check git `--output` targets outside the store root, such as the legacy .claude/ledger.md (`git diff --output=.claude/ledger.md HEAD`); it reads an option value of `--` as the end of options, so it does not see a `--dry-run` after it (`git fetch --server-option -- --dry-run`), and it reads a `--list` or `-l` after `git branch --format` or `--sort` as list mode, though git takes it as that option's value and creates the branch named after it (`git branch --format --list <name>`, `git branch --sort -l <name>`); it denies `git branch -a <name>` and `git branch -r <name>` in the clone, though git rejects both and creates nothing; it resolves a redirect on a `cd` command in the folder the cd leads to, though bash makes it in the folder it starts in (`cd .claude >ledger.md`); it matches a bracket class in a glob as the C locale does, and an unknown class (`[[:foo:]]`) as any one character; it keeps the folder unchanged after a cd to a path that is no folder, or that does not exist when the hook runs, so it denies a write that a failed cd skips (`cd /dev/null && printf x >> ledger.md`) and one into a folder an earlier command makes (`mkdir x && cd x`); it reads a `--help` after touch -d, -r or -t, truncate -s or -r, or mkdir -m as that option's value, so it denies the command though the tool rejects the value, and when it looks for that `--help` it does not skip the value of a long form (`--date`, `--reference`, `--size`, `--mode`); it reads a `{` after a process substitution as opening a group (`echo <(true) {`); it decodes a `$'...'` here-document delimiter one character per escape, so a delimiter of non-ASCII byte escapes (`$'\xC3\xA9'`) does not match the line bash ends on; and it does not join a here-document body that holds a command substitution with a line after it that ends in `&&` | none |
| Gates and widgets (D3, D33–D37, D52) | `ledger task gate plan`, `pr`, `merge`, `goal`, `abandon` and `finalize` print the question as JSON: at most three actions, each with a label and a one-line description, the first ending in "(Recommended)", then Close (`buildGate` in `tools/ledger/gates.ts`); the plan question carries the plan summary and step count and is refused without them (`planQuestion` in `tools/ledger/gates.ts`, `setPlanSummary` in `tools/ledger/notes.ts`); the plan-approval condition is in `rules/10-operating-model.md`, and the multi-select Close rule, the ❓ rule and the walkthrough exception are in `rules/20-writing.md` | none |
| Awareness (D26–D28) | the session start in a folder that owns a task gives a report of at most 20 lines in a fixed order: the task with its state, stage and kind; what needs the operator, in this order (what the PR check found, done tasks of its tree and of the task's own descendants, a merged PR named as such only when the task has one, open questions, blocked tasks of its path and siblings, tasks another session holds), at most 5 items; the path from the root; up to 8 siblings with their state; the Next step; and, for a task its parent lists, what the finalize question offers next in the tree, from the one decision function the report and the gate share (`nextInTree` in `tools/ledger/finalize.ts`; `sessionReport` in `tools/ledger/awareness.ts` maps its result to the line): the report asks it about the session's task at the session's checkout, as the gate does, with a `repoOf` that reads the store alone, so two checkouts whose repo key the store does not know are not one task; while the task has a child not retired, a child line with no ledger included, the child to start, else no line; otherwise, unless the parent has only an archive copy, which finalize does not count as a parent, the task to start next, else the siblings not yet retired, a child line with no ledger included, up to 8 and then how many more, that must be retired before the parent finalizes, else that the parent finalizes next; a bare child line marked started names a child even when no ledger has its slug, so it is such a line, not prose, while a bare line marked retired with no ledger left is a child whose archive copy was deleted and blocks nothing (`namedChildren` in `tools/ledger/tasks.ts`); a child counts as open by its ledger, not by the mark on its line under Children, as finalize counts it; the walk down a tree resolves each child line against the main its parent was resolved at, as finalize does, never against the main a child's record names, which may be relative, and a parent or root is walked at the main it was found at; a main checkout, or a folder that owns no task, gets what the PR check found, then the open trees of its repo, at most 12 and fewer when the PR lines need the room, each live task under a tree its parent lists it in or else heading its own, with lost children not counted as open, and the question to ask the operator, a new task or quick work alone when no tree is open (`openTreesReport`); the report reads every task from the store alone, with no git call per task (`storedTasks`), and finds a task in another repo by the main its record names, never by git there, so one the store cannot place counts as not found (`storedRepoOf`); a done task's line points to `ledger task gate finalize <slug>`, with `--` before a slug that starts with `-`, and for a task of another repo with `@<main>` only when the store knows a checkout of its repo: the checkout the walk down the tree found the task at, not the main its record names, which may be stale; for a task of another repo whose checkout the store does not know, the line says to ask that gate, with the slug alone, from a checkout of its repo (`finalizeAdvice` in `tools/ledger/awareness.ts`, which names the gate with `gateCommand` in `tools/ledger/write.ts`); hook failures, the sync notice and migration hints stay outside the report; `ledger statusline <folder>` prints `<slug> · <stage>`, with the state when it is parked, blocked, waiting or done, from the store alone: no pull, no gh (`statusLineText`), and `hooks/statusline.sh` shows it after the branch | `ledger session --tree` and the refresh at prompt submit (section 12) are not built; the session start gives the report itself |
| Finalize (D21, D49) | `ledger task gate finalize [<slug>]` prints the finalize question as JSON: retire the task when it has no child left, the other done tasks of the repo as one action, except those on another machine, then start the next child of its parent, or finalize the parent when every other child is retired; a parent with a child left offers to start that child instead; the retire says the session leaves the worktree first when it runs inside it (`finalizeQuestion` in `tools/ledger/finalize.ts`, `nextToStart` in `tools/ledger/write.ts`, `buildGate` in `tools/ledger/gates.ts`); the dry run before each retire and the repeat for the parent are in `rules/10-operating-model.md`; retire updates the parent and points to the parent's finalize question when no child is left (`parentActions` in `tools/ledger/retire.ts`) | none |
| PR waiting (D19, D20, D39) | not tracked | `ledger task pr`; waiting state refused without a PR link; GitHub check at session start |
| Proof (D40–D42) | unit tests (see [LLP 0000, Checks](0000-ledger-architecture.explainer.md#checks)); the rule in `rules/10-operating-model.md` that a run of zero tests is not a pass | scripted agent runs: full lifecycle, failed review, Close-then-resume; run on demand and before release |
| State storage (D7) | the location gives backlog, active or retired; inside active, the tool-written Location line `- status: <value>[ <date>][ — <detail>]` gives parked, blocked, waiting or done, and none is active (`parseStatus` and `statusText` in `tools/ledger/format.ts`, `toTask` in `tools/ledger/tasks.ts`); an old `Parked: <date> — <reason>` line under `## Next step`, or a `- state:` line with one of those values, reads as that status, and the next write saves it as the status line (`withStatus` in `tools/ledger/record.ts`); `ledger show` and `ledger list` mark a waiting task that names its PR done when `gh pr view` says the PR is merged, and say to finalize it with the question from `ledger task gate finalize <slug>`; they skip a task that has no live git worktree of its repo on this machine, such as one of another machine, one whose folder is gone, or one whose folder git does not list as a worktree, and a write of the done mark that fails is a warning on stderr (`markMergedDone` in `tools/ledger/write.ts`, `prState` in `tools/ledger/git.ts`); lost line (`- lost: <date> — folder <path> not found`, or `- lost: <date>` when no worktree is recorded; any other `- lost:` line is a note) | none |
| Task records (D8, D29) | Markdown files are the source; task list is a cache parsed from them; active ledger only in the worktree | one structured record per task in the store; Markdown rendered by `ledger show`; no worktree copy; one-time conversion |
| Task list (D9) | a query over the store: `findTasks` in `tools/ledger/tasks.ts` reads every task from it each time, scans no folders, and nothing caches the result; each active record names its repo and worktree; `ledger store repair` (`tools/ledger/repair.ts`) points a task whose folder moved to its new folder, or marks it lost | none |
| Repo identity (D10) | remote address, normalized by `remoteKey` in `tools/ledger/repo-key.ts` as D10 says, else the main checkout's path; a remote that is a local path keeps its case; `ledger store migrate --repo-ids` converts old tasks once and keeps an alias map; `ledger store repair --remote` files a renamed remote's tasks under the new key and keeps the old address as an alias; before a move starts, a task stays under the old key when its main checkout is gone or belongs to another repo, when it names no main and no alias exists yet, or when the new key has a live task with its title's slug; it refuses the whole command, moving nothing, when an alias of the old key files a live task whose slug the new key has, or when the new key is an alias of a third key already, as that would chain two aliases; it also moves evidence left under the old key whose archive copy is under the new key, and leaves an unreadable record there, names it and exits 1; it writes the aliases before the moves when the plan moves everything, so a run that stops after the moves leaves the alias a rerun finds, and takes them back when a move fails; evidence whose archive copy is under neither key stays and does not block the alias; on git storage a failed commit exits 1, keeps the aliases, which are never committed, and says to run `ledger store sync`, also when a move failed too; repair, commands and sync recognise pending moves when the alias points to the new key, the old HEAD path is gone on disk, HEAD has nothing at the new path or the same blob there under the same spelling, and the new file matches the new path by exact spelling and has the same blob; repair names an unreadable old evidence folder and exits 1; a rerun finishes a record or Markdown linked under both keys without checking the checkout again; it refuses an old key that shares the new key's store folder; file moves check the inode before removing a source or taking back a target, so a writer can reclaim a stale lock and keep its update, except in the limits LLP 0000 records; a dependency that names the old key names the task filed under the new one | none |
| Hook failures (D11) | allowed, error not visible | failure log at session start |
| LLP 0000 upkeep (D12) | the rule in `CONTRIBUTING.md`; the reviewer check in `agents/reviewer.md`; the `npm run llp` warning (`llp0000Warnings` in `tools/llp-refs.ts`); the other `npm run llp` checks, in [LLP 0000, Checks](0000-ledger-architecture.explainer.md#checks) | none |
| Design refs (D46) | `designRefs`, a field of the task record (`tools/ledger/record.ts`), set by `ledger task new --design-refs` with the LLPs that `/ledger:task` and `/ledger:go` pick | none |
| LLP decisions (D47) | the Plan gate in `rules/10-operating-model.md` reads the design refs before the plan and puts lasting decisions in an LLP in the same PR; `agents/reviewer.md` checks that they reached one | none |
| Deploy migration (D48) | `ledger store migrate --pending` lists the one-time moves from their own dry runs (`tools/ledger/pending.ts`); `bin/deploy` offers them after Deploy, has a Migrate menu entry, and runs them with `--migrate` (`tools/deploy.ts`, `tools/wizard.ts`) | none |
| Task kinds (D14) | none; every task is treated as code | `--kind`; stages per kind |
| Claims (D5, D17) | `ledger task claim` with expiry; `ledger go` claims on start | none |
| Clear points (D13) | rule text; operator types `/ledger:next` | offer after review and on size; agent starts `/ledger:next` after the widget choice |
| Start step (D18) | `ledger go` installs packages, claims the task, and files its active record under the repo's key, naming its worktree (`promote` in `tools/ledger/write.ts`) | none |
| Session start list | can be out of date when another session changes tasks | read the tree from the store at session start (D8, D9) |
| Failure handling (D22–D25) | each `ledger notes stage review fail` adds one to the record's `reviewRounds`, the `- review rounds: <n>` line under `## Location` (`tools/ledger/record.ts`); the second asks for the next round at higher effort and for the operator to be told, and from the third on the task is blocked on "review rejected three times" and the output says to ask the operator, while the stage moves as given (`recordStage` in `tools/ledger/notes.ts`); from the third on, a task that is blocked already keeps its block reason, one that is parked or waiting is refused, as it cannot move to blocked, a lost one is refused as by every `ledger notes` write, and a backlog task is not blocked, nor does the output say it is; `ledger task abandon [<slug>] --reason <text>` retires a task as retire does, but lets an unmerged branch through and keeps it; its first step adds the note `<date> abandoned: <reason>` to the live ledger, as the last line of its own `## Notes`, never under a child report copied into it, so the ledger is archived with it; a dry run and a check that stops the abandon write no note, and a ledger that holds an abandon note already gets no second one; when a retire archived the ledger already, it adds no note, leaves that copy as it is, finishes as a retire run again does and warns that the reason is not saved (`abandonTask` in `tools/ledger/retire.ts`); `ledger task gate abandon` asks the operator to confirm first; the Failure gate in `rules/10-operating-model.md` states the review limits, that a failed subagent is reported and not retried, and that a merge conflict goes back to build | none |
| Command groups (D30) | `task`, `notes`, `tree`, `store`, `worktrees` groups, with `go`, `list` and `show` as short forms (`tools/ledger/cli.ts`); the old names exit as unknown commands | none |
| Report size (D31) | every `ledger notes` write shortens the report of each reviewed or done step to one line; `ledger notes check` fails over 16,000 characters and names the three largest sections (`tools/ledger/notes.ts`) | none |
| Deploy permissions (D32) | `settings.policy.json` allows `ledger notes`, `go`, `list`, `show`, `tree show`, `tree next`, `tree ready` and every `task` command except `retire` and `abandon`; deploy merges the list into `~/.claude/settings.json` | none |
| Merge and goal gates (D4, D15) | `ledger task gate merge` asks *Merge now* and `ledger task gate goal` asks *Goal met* (`tools/ledger/gates.ts`); the PR check's line for a PR whose checks and review passed names the merge gate (`tools/ledger/pr-check.ts`); `ledger task done [<slug>]` marks a task done: one with no PR at once, one with a PR only once gh says it is merged, and it refuses a backlog task and every move the state table refuses (`doneTask` in `tools/ledger/write.ts`); the Merge and Goal met bullets in `rules/10-operating-model.md` run it, then End of task | none |
| Session name (D43) | renamed to `<icon> <slug>` on every task change and every state change: the prompt hook titles each `go <slug>` the session does not already claim, unless the title is already that; the turn end renames to the worktree's task, else to the task the session claimed, whenever the title differs from the last one it set | none |
| Worktree location (D6) | inside the main checkout | unchanged: the session-switch test failed (confirmation on every switch); D42 is the safeguard |
| Build folders (D44, D45) | `.claude/worktrees/.build/<name>/<configuration>`, from `bin/cc-dd-path`; `rules/90-builds.md` and `hooks/derived-data-gate.sh` use it; retire deletes the task's folder; `ledger worktrees derived-data` is gone; `prune-orphans` matches folder names to worktrees (`tools/ledger/worktrees.ts`) | none |
