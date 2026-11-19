# LLP 0001: Ledger workflow

**Type:** Plan
**Status:** Draft
**Systems:** ledger CLI, ledger plugin, hooks, rules, subagents
**Author:** Christian Falch / Claude
**Date:** 2026-11-19
**Related:** LLP 0000

Not implemented. Section 14 lists the decisions; D6 is still open.

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
  offers a way to stop.

## 2. Terms

- **Task**: one unit of work with a goal and a ledger. It ships as one PR, or
  as no PR (an investigation, a parent).
- **Ledger**: the task's notes: goal, plan, decisions, constraints, reports,
  open questions, report to the parent, next step.
- **Parent task**: a task whose work is split into child tasks. It has no
  worktree and no PR of its own.
- **Tree**: a root task and all tasks below it. A tree can span repos.
- **State**: where a task is in its life (section 5.1). The tool stores it.
- **Stage**: where an active task is in the build loop (section 5.2). The tool
  stores it.
- **Gate**: a point where the agent stops for the operator's answer.
- **Close**: save the ledger, clear the session and stop. Nothing else changes.

## 3. Principles

1. **The tool is the source of truth.** State, stage, plan, decisions and the
   next step are read and written with `ledger`. The agent never infers them
   from conversation.
2. **Hooks enforce; rules explain.** A rule is advice. Anything that must
   never be skipped has a hook that blocks the wrong action and says the right
   command.
3. **The tool proposes; the agent asks.** At each gate the tool prints the
   valid next actions. The agent shows them in the widget. The operator never
   types a command that the agent already knows.
4. **Stop is always one choice away.** Every widget at a gate has a Close
   option.
5. **Small context.** The ledger stays under about 4k tokens. Subagent output
   goes into the ledger as a short report, not a transcript.

## 4. Storage

All tasks of all repos live in one store on the machine. The store holds:
every ledger (backlog, active and archived), evidence files, and the task list
with parent links, order, state and stage.

A worktree may hold a working copy of its ledger for reading, but the store is
the source of truth.

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

### 5.2 Stages of an active task

| Stage | Work | Who | Gate at the end |
|---|---|---|---|
| plan | Investigate, write the plan and the acceptance criteria | orchestrator, `researcher` | **Plan approval** |
| red | Write tests for the criteria and see them fail | implementer | — |
| build | Make the tests pass | implementer (lane per routing rule) | — |
| verify | Full test suite and type check; confirm a non-zero test count | `runner` | — |
| review | Review against the spec and criteria | `reviewer` (+ `astra-reviewer` on critical work) | — |
| pr | Offer the PR | orchestrator | **PR approval** |

A task that cannot have tests (docs, config, styling) skips red with a
recorded reason: `ledger stage red --skip "<reason>"`.

### 5.3 Child order

A parent lists its children in order. A child may name the siblings it depends
on. The next child is the first one in order whose dependencies are done.
Stacked PRs use the same dependency field.

### 5.4 Claims

A task is claimed by one session when the session starts work on it. Another
session that tries to start the same task gets a warning and a choice: take
over, or pick another task. The claim ends at close, park or retire.

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

1. **Create.** `ledger task <slug> --goal … [--parent <slug>] [--after <slug>]`.
   A split plan makes the parent first, then each child, in order.
2. **Start.** `ledger go <slug>`. A backlog task gets its worktree and branch.
   A parent starts its next child (section 5.3). The session moves into the
   worktree.
3. **Plan.** The agent writes the plan with `ledger plan`. For a task with more
   than one file or a design choice, widget: *Approve plan / Change plan /
   Close* (D3).
4. **Red, build, verify, review.** Delegated to subagents. After each, the
   agent records the outcome with `ledger stage <stage> <outcome>` and the
   report with `ledger report-step`.
5. **Clear point.** After each review verdict with work left, the tool prints
   the clear point. Widget: *Continue in a fresh session / Close*.
6. **PR.** Widget: *Commit, push and open the PR / Not yet / Close*. The task
   moves to waiting.
7. **Waiting.** When checks fail or review asks for changes, the task goes
   back to active at stage build. When checks and review pass, widget: *Merge
   now / Not yet / Close* (D4). When the PR merges, the task becomes done.
8. **Finalize.** Triggered when the task becomes done. The tool lists the
   valid actions: retire this task, retire other done tasks, start the next
   child, or, when every child is done, finalize the parent. Widget
   (multi-select): those actions + *Close*.
9. **Up the tree.** When the last child of a parent retires, the parent
   becomes done and step 8 runs for the parent. At the root, the agent says
   that the tree is done.

## 8. When a step fails

| Failure | Next |
|---|---|
| Plan not approved | Stay at plan; revise. |
| Tests do not fail at red | Stop: the test does not test the criteria. Fix the test. |
| A test seems wrong at build | The implementer does not change it. It becomes an open question; the task goes to blocked. |
| Verify fails | Back to build with the runner's verdict. |
| Review rejects | Back to build with the findings. Clear point first. |
| PR checks fail or review asks for changes | waiting → active, stage build. |
| Work outside the goal appears | `ledger task` makes a new backlog task. The current task goes on. |

## 9. Awareness

At session start, after a clear and after a compaction, a hook gives the agent:

- the tree as a short path: root › parent › **current task**, with each
  sibling's state;
- the current state and stage;
- the next step;
- open questions and blocks.

The status line shows the current task and stage.

A plain "go" lists the claimable tasks. With one, the agent continues. With
more, it asks in a widget.

## 10. Writing the ledger

The agent changes the ledger only through these commands:

| Command | Changes |
|---|---|
| `ledger plan` | Plan table (steps, owner) |
| `ledger stage <stage> <outcome>` | Stage and step status |
| `ledger decide "<text>" --because "<reason>" --tag <tag>` | Decisions |
| `ledger constraint "<text>" --source "<where>"` | Constraints |
| `ledger report-step <n> --file <path>` | Subagent report for a step |
| `ledger question "<text>" [--blocks <n>]` / `--resolve <id>` | Open questions |
| `ledger report "<text>"` | Report to the parent |
| `ledger next-step "<text>"` | Next step |
| `ledger check` | Structure and size check |

A PreToolUse hook blocks Edit and Write on any ledger file and names the
command to use. `ledger check` runs after each write. Retire refuses a child
task with no report to its parent.

## 11. Questions to the operator

- The tool prints the valid actions for the current gate as JSON. The agent
  turns them into a widget. The first option is the recommendation.
- Each widget at a gate includes Close.
- At most four questions per widget and four options per question. More
  choices are split across widgets.
- A subagent cannot show a widget. It returns the options as text, and the
  orchestrator asks.
- A question with an open answer (a name, a value) is asked as text.

## 12. Enforcement

| Requirement | Hook | Tool | Rule |
|---|---|---|---|
| A task exists unless quick work is declared | — | `ledger task` | offer a task before the first edit; remind when quick work grows (D2) |
| Ledger written only through the tool | blocks Edit/Write on ledgers | write commands | names the commands |
| Stages in order | — | `ledger stage` refuses to skip a stage without `--skip` | explains the loop |
| Plan and PR approval | — | gate actions as JSON | widget wording |
| Report to parent before retire | — | `ledger retire` refuses | — |
| Tree awareness | session start, compaction, prompt submit | `ledger session --tree` | — |
| Close always offered | — | every gate action list includes close | widget wording |

## 13. Proof that it works

- Unit and end-to-end tests for every command and hook.
- Scripted agent runs (`claude plugin eval`) that take a sample task through
  the full lifecycle: create, plan, red, build, verify, review, PR, finalize,
  retire, next child, tree done. Each run checks the commands called, the
  widgets shown and that no ledger file was edited by hand.

## 14. Open decisions

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

Open:

- **D6** Worktree location (separate note; decided later).

## 15. From today to this spec

| Area | Today | Work |
|---|---|---|
| States | backlog, active, parked, retired | add blocked, waiting, done; transitions in the tool |
| Stages | free text in the plan table | `ledger stage`, ordered and checked |
| Child order | free text in the parent goal | order and dependency fields |
| Ledger writes | hand edits | write commands + blocking hook |
| Gates and widgets | rule text | gate actions as JSON; widget rule |
| Awareness | current ledgers at session start | tree path, state, stage; status line |
| Finalize | rule text; retire updates parent | finalize action list; up-the-tree step |
| PR waiting | not tracked | waiting state; merge detection |
| Claims | none | claim on start |
| Proof | unit tests | scripted agent runs |
