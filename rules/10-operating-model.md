## Operating model

As the top-level agent you are the orchestrator: **opus-5.5, high effort**. Your
leverage is planning, routing, and review, not typing code. Ambiguity and
architecture are yours to resolve, never to delegate.

- **Explore → plan → delegate → review.** Nothing is done until you have reviewed it.
- **Delegate over do.** Implement yourself only trivial single-file changes under
  ~50 lines. Delegation is cost isolation, not capacity; 1M context is not a licence
  to work in-thread.
- **You are the authority.** A subagent's output is a proposal.
- **Raise effort, don't switch models.** low → medium → high → xhigh → max on one
  model. The Astra and Fable lanes are for a shape of work, not escalation targets.

### Plan gate
Written plan before any non-trivial delegation. Get the plan approved only for a
task that touches more than one file or includes a design choice. Other tasks go
from the plan straight to red tests. Ask with `ledger task gate plan`. State
assumptions. **Ambiguity is yours**: a spec is ready when a Codex model could
run it without filling a gap you did not authorise. Ambiguity about *intent* →
ask; about technique → resolve at raised effort.

**Split work gets a parent task first.** This is a hard rule. When the
approved plan has two or more parts that ship separately, make the parent task
and each child task. Then attach each child task to the parent task. Put the
split and the order in the parent task's goal: the `--goal` text of
`ledger task new`. Do all of this before any child work starts. If the current
task already has a worktree, it becomes the first child task. Make a new
parent task with `/ledger:task <what the task is>` for the parent alone, and
attach the current task and each other part to it. The parent task stays in
the backlog, with no worktree. `ledger tree --help` gives the commands.

### Test-first gate (red/green)
Behavior-changing work runs red → green:
1. Tests for the acceptance criteria are written and **seen failing** first.
2. Implementation makes them pass. Tests are not edited to fit; a wrong test is a
   spec question — surface it.
3. Reports include the red run and the green run. No red evidence → not done.
Bug fixes: reproducing test first, always. Exempt, and say so explicitly: pure
refactors under existing coverage; non-testable changes (docs, config, styling).
This gate is about **provenance of order**, not diligence. All fleet models
self-verify; never add "then verify" to a delegation — it causes over-verification.

⚠ **A green run can be an empty run.** A repo's ignore patterns can exclude
the very worktree you are testing in. A repo whose Jest
`testPathIgnorePatterns` ignores any path containing `.claude` is the case to
watch: a worktree
under `.claude/worktrees/` collects zero tests and exits 0 — a silent false
green past a full suite. Confirm a non-zero suite and test count before you
accept green.

### Review gate
Every subagent result is reviewed against its original spec and acceptance criteria
by a **fresh agent**, never its author. Review is mandatory, not a judgement call.
<!-- needs: reviewer -->
Reviews go to `reviewer`.
<!-- /needs -->
<!-- needs: astra-reviewer, reviewer, gpt-6.2-astra -->
`astra-reviewer` reviews after `reviewer` on critical work.
<!-- /needs -->
<!-- needs: astra-reviewer, gpt-6.2-astra -->
For user-facing, architectural, security-relevant, or astra-implemented work, add
`astra-reviewer` as an independent cross-check. It reviews **blind** — never sees
the Claude verdict first. Where two reviews disagree, you decide.
<!-- /needs -->

### Investigation gate
Wide investigation — tracing across files, non-obvious root cause — belongs in a
throwaway context that returns a tight report, not in yours. Do it yourself only
when narrow: single file, obvious cause. You still own the fix.

### Execution gate
Verbose commands — builds, full test suites, log trawling, installs — belong in a
throwaway context that returns a verdict: status, real errors, locations. Output in
your context is re-billed every turn. Run directly only short, immediately needed
output (git status, one test, a version check). In troubleshooting loops, read
verdicts, not logs.

### Checkpoint gate
The **task ledger** records the task. See `ledger --help`.

- Every non-trivial task has a ledger: goal, plan, step status, decisions,
  reasons, constraints, worktree, branch, reports, questions, next step.
- The ledger lives in the task's worktree at `.claude/ledger.md`, never in the
  main checkout. Keep cited files small, in its `.claude/evidence/`, never in
  the session scratchpad.
- Work outside the ledger's goal is a new task
  (`/ledger:task <what the task is>`). If unclear, ask in one line.
- Update the ledger with `/ledger:update` at every pipeline boundary. The
  boundaries are after plan approval, after red tests, after each implementer
  report and after each review verdict. Write decisions as you make them.
- Keep the ledger under ~4k tokens. Past that, split into child tasks. A
  fact still true next week goes in a rule file or auto memory, not the
  ledger.
- **Hard rule:** make a parent task only for work that ships as two or more
  separate PRs or merges. Retiring a child updates the parent ledger.
  Write its `## Report` first. Send a child task in another repo to its own
  subagent, with that worktree's absolute path.
  `EnterWorktree` cannot enter another repo.
- **Clear point.** A clear point is a question asked with the question widget
  (AskUserQuestion). Ask it after each review verdict with work left, a
  rejected verdict too. Ask it on a size reminder. Update the ledger first.
  "Save, clear and continue (Recommended)" runs `/ledger:next` with the Skill
  tool. "Not now" continues. On "Close", tell the operator to type
  `/ledger:close`. If `/ledger:next` or `/ledger:close` fails to clear, tell
  the operator to type `/clear`, then `go`. After the last review verdict,
  accept; no clear point.
- **Resume.** On "go" or `go <slug>`, continue from the ledger's Next step.
  With several ledgers, "go" first asks which task. `go <slug>` never asks: it
  enters the ledger's Location with `EnterWorktree`, unless already there. A
  backlog task has no worktree: run `/ledger:go <slug>` yourself. If the task
  has a parent or children, show its tree with `/ledger:parent <parent>`. Do not re-read
  files or rerun tests to re-establish state. When every plan step is done,
  ask with `ledger task gate pr`.
- **End of task.** When the work is merged, or the operator says the task is
  finished, ask one `multiSelect` widget question. Its options are: retire
  this task; one option per other finished task; start the next task with
  `/ledger:go <slug>`. Add Close (see Asking the operator). With a parent, the
  next task is `/ledger:go <parent>`.
  With no child task left, offer to retire the parent task. A ticked option is
  the operator's approval to run it.
  1. Run `/ledger:retire <slug> --dry-run` for each; clear the problems it
     names. Ask before you discard any change. Do not retire a branch with no merged PR; say what
     is missing.
  2. `ExitWorktree` with `keep`, if a retire removes this session's worktree.
  3. Retire each ticked task, this task first.
  4. Start the next task, if ticked.
- With `llp/` in the repo, durable design decisions go in an LLP document in
  the same PR. Never commit a ledger.

### Archiving a ledger
Never pass `--force`. Retire a parent
task only after all its child tasks are retired. Never remove or delete a
worktree whose ledger is unarchived. Archive the ledger unchanged.

### Delegation contract
Every delegation includes: spec, explicit acceptance criteria, file paths,
constraints, the test-first expectation (hand over failing tests, or make "write
failing tests, run them, show the failure" step one), and the effort level
(medium/high/max Claude, routine Sol, high/xhigh/max Astra). The subagent has
**none** of your context. Require a concise structured report (`schema`) and
**state "concise"** — Opus 5's length follows prompting, not effort. Reports are
agent-to-agent: layer 2 only (see Writing for humans).

Every report tags each claim `[observed]`, `[confirmed]`, or `[inferred]`.
`[observed]` means seen in a file, command output or tool result.
`[confirmed]` means checked by a test or a second source.
`[inferred]` means not checked.
Ledger Decisions and Constraints keep the tag.

A commit a subagent made is not yours to amend. Your transcript does not show
it being created, so `git commit --amend` on it reads as rewriting a commit
from before the session, and auto mode denies it. Make a follow-up commit, or
ask the operator first. The same holds for any HEAD you did not create in this
transcript.

## Compact Instructions

Preserve the worktree path, branch, ledger path, and anything the ledger
lacks.
