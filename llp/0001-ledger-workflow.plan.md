# LLP 0001: Ledger workflow

**Type:** Plan
**Status:** Draft
**Systems:** ledger CLI, ledger plugin, hooks, rules, subagents
**Author:** Christian Falch / Claude
**Date:** 2026-11-19
**Related:** LLP 0000

Not implemented. Section 14 lists the decisions; none is open.

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
whose recorded folder is gone or moved, and asks whether to point the task to
a new folder or mark it lost. Only this command searches the disk, in folders
the operator names.

**Decision D10 (2026-11-19):** the store identifies a repo by its remote
address, such as `github.com/chrfalch/ledger`, not by its folder name. A repo
with no remote falls back to the absolute path of its main checkout. Two
checkouts of one repo share one task tree; each task records its own worktree
path (D9). A renamed remote is kept as an alias, and `ledger store repair` updates
it. A one-time conversion moves existing tasks from folder names to repo
addresses; `ledger store migrate` does this step.

**Decision D1 (2026-11-19):** the store is a technical setting, outside this
spec. The tool supports Markdown files and SQLite, and GitHub support is in
progress. Every rule in this spec must work the same with each store.

## 5. Task model

### 5.1 States

| State | Meaning | Next states |
|---|---|---|
| backlog | Defined, not started. No worktree. | active, retired |
| active | Work in progress in a worktree. | parked, blocked, waiting, done |
| parked | Stopped on purpose, with a date and a reason. | active |
| blocked | Cannot continue: waits for an operator answer or another task. Names what it waits for. | active |
| waiting | PR open; waits for checks, review or merge. | active (fixes needed), done |
| done | PR merged, or no PR and the goal is met. | retired |
| retired | Ledger archived, worktree and branch removed. | — |

A parent task's state follows its children: active while any child is not
retired; done when all children are retired.

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
D16). The tool reads its state from the store like any other task.

### 5.4 Claims

A task is claimed by one session when the session starts work on it. Another
session that tries to start the same task gets a warning and a choice: take
over, or pick another task. The claim ends at close, park or retire.

**Expiry (D17).** A claim whose session shows no activity for a set time ends
by itself. The time is a setting, with a default of two hours. A later session
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
   - installs the repo's packages in the new worktree, so the first test run
     does not fail;
   - claims the task for this session (D5);
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
   task in the tree and reports what changed (D20):
   - checks failed or review asked for changes: the task goes back to active
     at stage build;
   - checks and review passed: widget *Merge now / Not yet / Close* (D4);
   - PR merged, here or elsewhere: the task becomes done and step 8 runs.
   
   A child whose PR is stacked on its parent's branch is rebased onto the
   default branch after the parent merges. Stacked PRs merge bottom-up.
8. **Finalize.** Triggered when the task becomes done. The tool lists the
   valid actions: retire this task, retire other done tasks, start the next
   child, or, when every child is done, finalize the parent. Widget
   (multi-select): those actions + *Close*. Before each retire, the tool runs
   a dry run and stops on any problem. When the session is inside the worktree
   it retires, the session leaves the worktree first (D21).
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
| Review rejects | Back to build with the findings. Clear point first. After two rejected rounds, the next round runs at higher effort and the agent tells the operator. After a third rejection, the task goes to blocked and the agent asks the operator what to do (D22). |
| A subagent fails, times out or returns an empty report | The agent tells the operator what failed and asks what to do. It does not retry on its own (D23). |
| PR checks fail or review asks for changes | waiting → active, stage build. |
| Merge conflict when the branch is updated | Back to build. The agent resolves the conflict; verify and review run again (D24). |
| The task is no longer needed | Abandon: the operator confirms in a widget; the ledger is archived with the reason "abandoned"; nothing is merged. `--force` stays for emergencies (D25). |
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

**The session name** is always the slug of the task the session works on. It
changes each time the session creates, enters or switches to a task, so the
session list shows which task each session holds (D43). How the tool sets
the name is a technical choice; the operator never renames by hand.

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
| `ledger notes` | `plan` | Plan steps and owners |
| | `stage <stage> <outcome>` | Stage and step status |
| | `decide "<text>" --because "<reason>" --tag <tag>` | Decisions |
| | `constraint "<text>" --source "<where>"` | Constraints |
| | `question "<text>" [--blocks <n>]` / `question --resolve <id>` | Open questions |
| | `report --step <n> --file <path>` / `report --parent "<text>"` | Step reports; the report to the parent |
| | `note "<text>"` | General notes (D29) |
| | `next "<text>"` | Next step |
| | `check` | Structure and size check |
| `ledger tree` | `show [<slug>]`, `add`, `remove`, `order`, `depends` | Parents, children, order, dependencies (D16) |
| `ledger store` | `migrate`, `repair`, `check`, `sync` | The store (D1, D9) |
| `ledger worktrees` | as today | Worktree and build folders |

`ledger go`, `ledger list` and `ledger show` stay as short forms of the `task`
commands. `hook` and `session` are for Claude Code and stay out of the normal
help. Today's `ledger task <slug>` becomes `ledger task new <slug>`, and
`ledger parent` becomes `ledger tree`. Every caller (plugin prompts, rules,
tests, hook settings) changes at once; no other old names are kept.

There is no ledger file to edit (D8). A PreToolUse hook catches an agent that
tries to write `.claude/ledger.md` from habit and names the command to use.
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
- During an operator walkthrough of a document, questions are plain text, one
  point at a time. The widget returns at the next gate (D36).

## 12. Enforcement

| Requirement | Hook | Tool | Rule |
|---|---|---|---|
| A task exists unless quick work is declared | — | `ledger task new` | offer a task before the first edit; remind when quick work grows (D2) |
| Ledger written only through the tool (D38) | blocks Edit/Write and shell commands that change the store; `ledger` itself is allowed; a failed hook lets the action through and logs it (D11) | write commands | names the commands |
| Stages in order | — | `ledger notes stage` refuses to skip a stage without `--skip` | explains the loop |
| Plan and PR approval (D33, D35) | — | gate actions as JSON: at most three plus Close, each with label and description | widget wording; walkthrough exception (D36) |
| PR link before waiting (D39) | — | refuses to set a code task to waiting until `ledger task pr` recorded the link | — |
| Report to parent before retire | — | `ledger retire` refuses | — |
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
- **D10** Repos are identified by remote address, with the main checkout's
  path as fallback; existing tasks are converted once (section 4).
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
- **D43** The session name is always the current task's slug, set on every
  task change (section 9).
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
- **D44** (decided 2026-11-19, same task as D6, only if D6's test passes)
  Xcode build folders move to `<repo>.worktrees/.build/<slug>/<configuration>`:
  next to the worktrees, never inside a worktree or the main checkout.
  `bin/cc-dd-path`, the build rule and the build-path hook change with it;
  retire deletes the task's folder. Old folders in Xcode's DerivedData are
  deleted once during the move. If D6's test fails, build folders stay in
  Xcode's DerivedData.
- **D45** With D44, `ledger worktrees derived-data` and `ledger worktrees
  prune-orphans` are removed, with their docs and tests: build folders no
  longer collect in Xcode's DerivedData.
- **D46** In a repo with `llp/`, the task record keeps the LLP numbers the task
  touches (design refs), picked when the task is made; none when no LLP
  matches (section 4, step 1). Keeps today's `--design-refs` behaviour.
- **D47** The plan stage reads the design refs; a lasting design decision goes
  into an LLP in the same PR; the reviewer checks it (step 3). Replaces the
  LLP line in the operating-model rule.

## 15. From today to this spec

| Area | Today | Work |
|---|---|---|
| States | backlog, active, parked, retired | add blocked, waiting, done; transitions in the tool |
| Stages | free text in the plan table | `ledger notes stage`, ordered and checked |
| Child order (D16) | free text in the parent goal | order and dependency fields; a dependency may name a task in another repo |
| Ledger writes (D38) | hand edits | write commands + hook that blocks Edit/Write and shell writes to the store |
| Gates and widgets (D3, D33–D37) | rule text | gate actions as JSON with label and description, at most three plus Close; multi-select Close rule; walkthrough exception in the rule |
| Awareness (D26–D28) | current ledgers at session start | ordered report under ~20 lines; outside-task prompt; store-only status line |
| Finalize (D21) | rule text; retire updates parent | finalize action list; up-the-tree step |
| PR waiting (D19, D20, D39) | not tracked | `ledger task pr`; waiting state refused without a PR link; GitHub check at session start |
| Proof (D40–D42) | unit tests | scripted agent runs: full lifecycle, failed review, Close-then-resume; zero-test runs fail; run on demand and before release |
| State storage (D7) | location only; parked line | tool-written `- status:` line; GitHub check |
| Task records (D8, D29) | Markdown files are the source; task list is a cache parsed from them; active ledger only in the worktree | one structured record per task in the store; Markdown rendered by `ledger show`; no worktree copy; one-time conversion |
| Task list (D9) | cache rebuilt by scanning `~/repos`, `~/issues` | view of the store; `ledger store repair` |
| Repo identity (D10) | folder name | remote address; one-time conversion |
| Hook failures (D11) | allowed, error not visible | failure log at session start |
| LLP 0000 upkeep (D12) | none | CONTRIBUTING rule; reviewer check; `npm run llp` warning |
| Design refs (D46) | `- design refs:` line in the Markdown ledger, picked by `/ledger:task` and `/ledger:go` | a field of the task record; converted once with the other ledgers |
| LLP decisions (D47) | one line in the operating-model rule | plan stage reads the refs; reviewer checks that lasting decisions reached an LLP |
| Task kinds (D14) | none; every task is treated as code | `--kind`; stages per kind |
| Claims (D5, D17) | none | claim with expiry |
| Clear points (D13) | rule text; operator types `/ledger:next` | offer after review and on size; agent starts `/ledger:next` after the widget choice |
| Start step (D18) | worktree has no packages; first test run fails | `ledger go` installs packages, claims, records paths |
| Session start list | can be out of date when another session changes tasks | read the tree from the store at session start (D8, D9) |
| Failure handling (D22–D25) | rule text | review round count and escalation; failed subagent reported, no retry; merge conflict back to build; abandon as a confirmed retire with reason |
| Command groups (D30) | flat command names | `task`, `notes`, `tree`, `store`, `worktrees` groups; every caller changes at once |
| Report size (D31) | none | one-line reports after review; `ledger notes check` size limit |
| Deploy permissions (D32) | permission prompt on ledger writes | deploy allows the `ledger` commands |
| Merge and goal gates (D4, D15) | rule text | *Merge now* gate after checks and review; *Goal met* gate for tasks with no PR |
| Session name (D43) | operator renames by hand with `/rename` | session renamed to the task slug on every task change |
| Worktree location (D6) | inside the main checkout | separate task: test the session switch first; then `<repo>.worktrees/<slug>`, main checkout found through git, existing worktrees moved |
| Build folders (D44, D45) | Xcode's DerivedData, named by worktree path hash | same task as D6: `<repo>.worktrees/.build/<slug>/<configuration>`; `cc-dd-path`, build rule and hook changed; old folders deleted once; `derived-data` and `prune-orphans` removed |
