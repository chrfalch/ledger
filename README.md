# ledger

<img src="docs/ledger-icon.svg" width="106" align="left" alt="">

ledger cuts the cost of long Claude Code sessions. Each task keeps its goal,
plan and next step in a small ledger file, and works in its own git worktree.
So you can clear the session often, and a fresh session continues from the
file. Subagents do the verbose work, such as builds, code searches and
implementation, and return short reports.

<br clear="left">

<img src="docs/ledger-demo.svg" width="800" alt="A Claude Code session with ledger. You type /ledger:go offline-queue-loss. The agent moves into the task's worktree, loads the ledger and proposes a three-step plan. You type yes, and the plan goes into the ledger. Helper agents find the cause, write a test that fails, write the fix and review it. The agent stops at a clear point. You type /ledger:next, and a fresh session loads the ledger and finishes step 3. The agent asks to commit and open a pull request. You type yes, and the pull request opens.">

## How you use it

Most of the time you do four things. You start the task, approve the plan with
`yes`, type `/ledger:next` at each clear point, and type `/ledger:retire` after
the PR merges. The full loop:

1. Start a task in one sentence: `Start a new task: …`. If another task is
   open, the reply ends with a `start:` line, `/ledger:go <name>`. Type it.
2. Approve the plan. Answer `yes`, or ask to change a step.
3. The agent works. It writes failing tests first, makes the fix, and gets it
   reviewed.
4. At "Clear point", type `/ledger:next`. A fresh session continues from the
   ledger. Steps 3 and 4 repeat until the plan is done.
5. When the last review passes, the agent asks to commit and open a PR.
   Answer `yes`.
6. After the PR merges, type `/ledger:retire`. It archives the ledger and
   removes the worktree.

To stop for the day, type `/ledger:close`. The next day, type `go`, or
`go <name>` when several tasks are open.

### Example session

**You:** Start a new task: items in the offline queue disappear if the app is
killed during a sync.

**Agent:** (creates a worktree and a ledger, and moves the session into the
worktree) Plan: 1. Write a test that kills the app during a sync and fails.
2. Save each queue item to disk before the sync sends it. 3. Delete the saved
item only after the server confirms it. Do you approve?

**You:** yes

**Agent:** (writes failing tests, makes the fix, gets it reviewed)

**Agent:** Clear point. Ledger updated. Type `/ledger:next` to clear the session and continue, or `/ledger:close` to clear it and stop.

**You:** `/ledger:next`

**Agent:** (fresh session, reads the ledger, continues with step 3 in the plan)

### Things you can say

You write plain sentences, and the wording does not have to match these
examples.

| You type | What happens |
|---|---|
| `Start a new task: items in the offline queue disappear if the app is killed during a sync.` | The orchestrator runs `/ledger:task`. When another task is open, it replies with a `start:` line for you to type. The orchestrator then investigates, writes a plan, and asks you to approve it. Only a small single-file change is made without a plan. |
| `yes` | Approves the plan. The orchestrator writes the plan into the task's ledger and starts on step 1. |
| `Change step 2: keep the old API and add the new one next to it.` | The orchestrator rewrites the plan and asks again. |
| `What are we working on?` | It answers from the ledger: the goal, what is done, and the next step. If several tasks are open, it lists each one. |
| `go` | It continues from the next step in the ledger. Use this after `/ledger:close`, after a manual `/clear`, or in a new session the next day. |
| `go offline-queue-loss` | The same as `go`, when several tasks are open and you want to name one. The session moves into that task's worktree first. |
| `Why did we drop the retry counter?` | It answers from the decisions recorded in the ledger, with the reason for each. |
| `Explain that in more detail.` | Answers start as a short summary. This asks for file paths, function names, and what was ruled out. |
| `Commit and open a PR.` | The orchestrator does not commit on its own. When the last review passes it asks you, and this is the answer. |

[docs/usage.md](docs/usage.md) has the rest: a full task with the ledger at
each stage, the clear loop, several tasks at once with short examples, and
parent tasks for big work, also across repositories.

## From the terminal

Deploy links the `ledger` command into `~/.local/bin`, so it runs from any
folder. If `~/.local/bin` is not on your `PATH`, deploy prints the line to add
to your shell profile:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

The `ledger` command runs some `/ledger` commands without a Claude Code
session. It also runs deploy.

| You type | What happens |
|---|---|
| `ledger deploy [options]` | Runs `bin/deploy` from this repo. The options pass through, so `ledger deploy --dry-run` prints every change and writes nothing. |
| `ledger all [--scan]` | Lists every registered task and the backlog, like `/ledger:all`. `--scan` first rebuilds the list from the ledgers on disk. |
| `ledger archive [term] [--all]` | Lists this repo's archived ledgers, newest first, like `/ledger:archive`. A term keeps only the ledgers that contain it, in any case. `--all` lists the archive of every repo. |
| `ledger parent [slug]` | Shows a parent task and its child tasks, like `/ledger:parent`. Without a slug, it shows the family of the task in the current folder. |
| `ledger worktrees` | Lists this repo's linked worktrees, largest first, like `/ledger:worktrees`. |
| `ledger worktrees prune <name> [--dry-run]` | Deletes the build folders of one linked worktree, like `/ledger:worktrees prune`. It keeps `node_modules`, `Pods` and `.claude` folders. `--dry-run` only lists the folders. |
| `ledger worktrees prune --all [--dry-run]` | Deletes the build folders of every linked worktree, like `/ledger:worktrees prune --all`. It never touches the main checkout. A worktree that fails is reported, and the others are still pruned. `--dry-run` only lists the folders. |
| `ledger worktrees derived-data` | Lists the folders in Xcode DerivedData, grouped by the project they were built from, like `/ledger:worktrees derived-data`. |
| `ledger worktrees prune-orphans [--dry-run]` | Deletes the DerivedData folders whose project no longer exists on disk, like `/ledger:worktrees prune-orphans`. `--dry-run` only lists the folders. |
| `ledger help [command]` | Prints help for `ledger`, or for one of its commands. |

## Commands

The ledger mod adds these commands. Claude Code puts the plugin name in front
of every command that a plugin writes as a markdown file, so a plain `/task`
does not exist.

A hook answers `/ledger`, `/ledger:help`, `/ledger:worktrees`,
`/ledger:retire`, `/ledger:archive`, `/ledger:all`, `/ledger:parent` and
`/ledger:dashboard` directly, without a model turn. Most of them only print.
`/ledger:retire` and the three prune forms of `/ledger:worktrees` delete files.
Add `--dry-run` to see what they would delete first. The other commands run a
model turn, for example to write a ledger, start a task, or switch to one.

When every step of the session's task is done, the end of the turn deletes the
build folders of the task's worktree. It uses the checks of
`/ledger:worktrees prune`. The folders move at once to a trash folder, and a
background process deletes them. So the turn does not wait. The trash folder
goes in the worktree's git folder when that folder is on the same disk. Then
`git status` does not show it. Otherwise it goes next to the build folder.
There, `git status` shows it until the delete ends. A file
`.claude/build-folders-pruned` in the worktree stops a second prune. A failed
prune also writes this file, so the failure is shown once. The file names the
command to prune by hand. When the task has open steps again, the file is
removed, so the next finish prunes again.

### Daily use

| You type | What happens |
|---|---|
| `/ledger` | Prints each task ledger's goal, current step and next step. A parent task in this repo's backlog is listed too, marked `(backlog)`, with its child tasks under it; so is that task's own parent task in the backlog. Other backlog tasks are not listed. |
| `/ledger <name>` | Prints each ledger whose name contains `<name>`, in any case. More than one ledger can match. |
| `/ledger:help` | Prints one line for each `/ledger` command. |
| `/ledger:task <description>` | Starts a separate task. The agent picks a short name, writes the goal, and runs `bin/cc-task-new`. The script writes a ledger with the goal filled in to the backlog, `~/.claude/ledger-backlog/<repo>/<name>.md`, with no branch or worktree yet. When no task is open, the session moves into the new worktree and continues there. The agent makes that branch and worktree at once, the same way `/ledger:go` does. When another task is open, the ledger stays in the backlog, and the reply ends with a `start:` line, `/ledger:go <name>`. Type it to clear the session and continue in the new task. Either way, you do not open a new terminal. `--stack` makes the branch and worktree at once, on top of the current branch. |
| `/ledger:task --here [<slug>]` | Gives the linked worktree this session is in a ledger, instead of a new worktree. Without a slug, the task takes the branch name without its owner prefix. It refuses the main checkout and a worktree that already has a ledger. The reply is the path of the new ledger. |
| `/ledger:update` | Writes the step status, the subagent reports, the decisions and the next step to the task's ledger. After an implement-and-review cycle with work left, the reply is the clear point line. Otherwise it says only that the ledger is updated. With no ledger in the working directory, the agent creates nothing and tells you to use `/ledger:task`. |
| `/ledger:close` | Writes the ledger the same way, then clears the session. Type `go` later to continue. It never starts a task: with no ledger in the worktree, it prints why and does nothing. |
| `/ledger:next` | Writes the ledger the same way, clears the session, then sends `go <name>`, so the fresh session continues from the next step. When every step is done, it first says how to retire the task, and deletes its build folders as every finished turn does. Like `/ledger:close`, it never starts a task. |

### Switching and parking

| You type | What happens |
|---|---|
| `/ledger:go <slug>` | Switches to the task named `<slug>`; `/ledger` shows each name. If the session has a task ledger, the agent writes it first. The session then clears and `go <slug>` is sent, so the fresh session moves into that task's worktree. If that task was parked, the mark is removed. A backlog task first gets its branch and worktree. When no task has that name, the agent makes it: it writes the goal from the conversation, then makes the ledger, branch and worktree. If no ledger exists at the end of the turn, for example because it had to ask you what the task is, the session does not clear. The branch starts at the `--base` ref given when the task was written. Without one, it starts at the commit that `origin/HEAD` points to. Nothing fetches first, so that commit is from your last `git fetch`. Without `origin/HEAD`, the branch starts at the branch that the main checkout is on. A backlog task starts only from a session in its repo. From another repo, `/ledger:go` names the repo and changes nothing. For a parent task, `/ledger:go` starts its next child task instead: the first one under `## Children` that is not started yet and is still in the backlog. A child task in another repo is promoted there, and the session stays where it is. When you leave a task whose steps are all done, it first says how to retire it, and deletes its build folders as every finished turn does. |
| `/ledger:park [<slug>] <reason>` | Marks a task parked, with the date and the reason. With the slug of another task, it only marks that task. Without a slug, it writes this task's ledger, parks it, then clears the session. |

### Big work

| You type | What happens |
|---|---|
| `/ledger:parent [<name>]` | Prints a parent task and, for each child task, its status, next step and report. A retired child task's report comes from the parent ledger's `## Child reports`. Without a name it shows the task this session is in when it has child tasks, or else that task's parent task. |
| `/ledger:parent <name> add <child>` | Makes `<child>` a child task of `<name>`. It writes both ledgers. A parent task ties together tasks that ship separately, such as stacked PRs. Write `<child>@<path>` for a child task in the repo that holds `<path>`. See [Parent tasks](docs/usage.md#parent-tasks). |
| `/ledger:parent <name> remove <child>` | Removes that relation from both ledgers. |

### Cleanup and overview

| You type | What happens |
|---|---|
| `/ledger:retire [<slug>] [--force]` | Copies the task's ledger and its `.claude/evidence/` folder to `~/.claude/ledger-archive/<repo>/`, removes its worktree and deletes the local branch when every commit on it is in the default branch or in a merged PR. A branch with commits after its PR merged stays. Last, it deletes the worktree's build folders in the background, so a big folder does not hold up the retire. It needs `--force` for uncommitted changes, for a branch that has commits not in the default branch and no merged PR, and for a parent task with active child tasks. Retiring a child task marks it retired in its parent ledger, also when the parent is in another repo. It also copies the child task's `## Report` under `## Child reports` in the parent ledger, and warns when there is no report. A child task in another repo blocks its parent until it is retired there; a missing one blocks too. A backlog task of this repo has no worktree or branch: its ledger is archived, then deleted from the backlog. Without a slug it takes the task this session is in. |
| `/ledger:retire [<slug>] --dry-run` | Lists what retiring the task would do: its worktree, branch, uncommitted changes and archive path, or for a backlog task its ledger and archive path. It names any active child tasks, which need `--force`. It deletes nothing. |
| `/ledger:archive [<term>] [--all]` | Lists this repo's archived ledgers in `~/.claude/ledger-archive/`, newest first, one line each. A term keeps the ledgers that contain it, in any case, and shows the first matching line. `--all` lists every repo. |
| `/ledger:worktrees` | Prints a table of the repo's linked git worktrees, largest first, with size, last commit, changed files, ledger and PR. |
| `/ledger:worktrees prune <name>` | Deletes the build folders of that worktree. It keeps `node_modules`, `Pods`, `.claude` and the worktree itself. |
| `/ledger:worktrees prune <name> --dry-run` | Lists those build folders and their sizes. It deletes nothing. |
| `/ledger:worktrees prune --all` | Deletes the build folders of every linked worktree, never the main checkout. It shows one table per worktree and the total freed. A worktree that fails is reported, and the others are still pruned. |
| `/ledger:worktrees prune --all --dry-run` | Lists the build folders of every linked worktree and their sizes. It deletes nothing. |
| `/ledger:worktrees derived-data` | Lists every folder in `~/Library/Developer/Xcode/DerivedData` with its size. It groups them by where the project is: the main checkout, a linked worktree, another location, or gone. Folders with no source project, and shared caches, have their own groups. |
| `/ledger:worktrees prune-orphans` | Deletes the DerivedData folders whose project no longer exists. It never deletes shared caches or folders without a recorded project. |
| `/ledger:worktrees prune-orphans --dry-run` | Lists those folders. It deletes nothing. |
| `/ledger:all` | Prints a table of every task ledger on the machine, from every repo, active and archived, with its next step. Backlog tasks follow in their own section, **Backlog**. A parked task shows as `parked`. A child task follows its parent, also when the parent is in another repo. The list lives in `~/.claude/ledgers.json`. A new task, a retire and each session start add to it. |
| `/ledger:all --scan` | Rebuilds `~/.claude/ledgers.json` from the ledgers under `~/repos` and `~/issues` and the archive in `~/.claude/ledger-archive/`, then prints the table. |
| `/ledger:dashboard` | Starts a web page on this machine with the `/ledger:all` list, filters by repo and status, and a search of every ledger's text. You can select more than one status; with none selected it shows every task. A child task comes right after its parent, marked `↳`; a child that is not right under its parent, for example because a filter hides the parent, shows the parent's name, and a click on it opens the parent when its ledger is found. Click a task to read its ledger. Its buttons copy `go <slug>`, park and unpark the task, and retire it after a preview. It prints the page's address, which holds a new access key each start. It keeps running after the session ends. |
| `/ledger:dashboard stop` | Stops the dashboard. |

A build folder whose project is on a disk that is not connected goes in its own
group, **Disk not connected**, and is never deleted.

To remove a finished worktree, use `bin/cc-worktree-retire <worktree>`. It
archives the ledger first, then removes the worktree and its Xcode build
folders. Given a backlog ledger, `~/.claude/ledger-backlog/<repo>/<slug>.md`,
it archives that ledger, then deletes it.

## Install

```sh
git clone https://github.com/chrfalch/ledger.git
cd ledger
bin/deploy --dry-run   # print every change, write nothing
bin/deploy
```

A clone made before the project was called ledger can still be in a folder
named `agent-config`. Deploy works from any folder name.

You need Claude Code, Node.js 20.12 or later, `bash`, `git`, and `jq`. Deploy
runs on Node. `bash` runs the git hook dispatcher that deploy installs. Every
hook script and the status line use `jq`. Python is no longer needed. The
GitHub CLI, `gh`, finds merged PRs for `/ledger:retire` and for the retire hint
of `/ledger:next` and `/ledger:go`. `/ledger:worktrees` uses it for its PR
column. Without `gh`, these parts do not show. The first run of `bin/deploy`
runs `npm ci`, which installs dependencies into `node_modules` and writes the
npm cache in `~/.npm`. Codex CLI, the argent MCP server, and the `gh stack`
extension are optional; deploy has a flag to skip each one.

Run `bin/deploy` with no flags in a terminal to start an interactive wizard.
Flags work as before and skip the wizard.

Deploy also links the `ledger` command into `~/.local/bin`. If that folder is
not on your `PATH`, deploy prints the line to add. See
[From the terminal](#from-the-terminal).

Then add three variables to your shell profile:

```sh
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=30
export BASH_MAX_OUTPUT_LENGTH=10000
export MAX_MCP_OUTPUT_TOKENS=10000
```

That is the happy path. [docs/installation.md](docs/installation.md) has the
flags, what deploy owns, what it never touches, and how to undo it.

### Update

Claude Code reads the plugins in `mods/` directly from this checkout, not from
a copy. So a change that only touches a plugin needs no deploy. After it is
merged, run `git pull` here, then restart Claude Code or run `/reload-plugins`.

For any other change, run `git pull` in the clone, then run `ledger deploy`.
A copy deployed before the `ledger` command existed has no `ledger` on your
`PATH` yet; run `bin/deploy` once instead.

### First five minutes

Check that the install worked before you start real work. Open a new terminal
so the shell variables load, then start Claude Code in any repo.

1. In the terminal, run `ls ~/.claude/agents/`. The list should include
   `researcher.md`, `runner.md`, `reviewer.md`, and `opus-implementer.md`. The
   Codex and argent agents appear only if you did not skip them at deploy.
2. In the terminal, go to a folder outside the clone and run `ledger --help`.
   It should print the list of `ledger` commands. If the shell does not find
   `ledger`, add the `PATH` line that deploy printed to your shell profile.
3. In Claude Code, type `/ledger` and then `/ledger:help`. Both commands should
   run. If Claude Code does not know them, the ledger mod did not install.
4. Ask `What are we working on?`. It should say that no task is open, because
   this repo has no ledger yet.
5. Pick a small real task that touches more than one file, and type
   `Start a new task: …` with a sentence describing it. You should get a plan
   and a question asking you to approve it. Answer `yes` and follow along.

If step 1 or step 3 fails, run `bin/deploy --dry-run` again and read what it
would change.

## The problem

Claude Code re-reads the whole conversation on every turn. So a long session
costs more with each turn. You can clear the session to stop that cost, but
then the agent forgets the task: the goal, the plan, and what is done.

ledger solves this in three ways:

1. The task state lives in a ledger file, not in the conversation. A fresh
   session reads the file and continues.
2. Each task gets its own git worktree. Two tasks never share a checkout.
3. Subagents do different types of work when needed and return short reports.
   Build logs and wide code searches stay out of the main session.

## What it ships

A Claude Code multi-agent setup. It gives the top-level session a contract: plan
the work, delegate it to subagents, review the result, and keep the state in a
file instead of in the conversation. It ships five things:

- **An orchestrator contract** — rule files that load in every session and tell
  the top-level agent how to work.
- **Nine subagents** — investigation, execution, implementation, and review
  lanes, each pinned to a model.
- **A task ledger** — a small file that holds the task state, so a session can
  be cleared and restarted without losing anything.
- **Seven hook scripts across five hook events** — they put the ledger back
  into context when a session starts, and protect it when a session compacts.
  They block writes that would put a ledger in the wrong place or lose it, and
  Xcode builds into a wrong folder. They warn when the deployed config is old,
  and allow a retry of a denied read-only call. Usage pace warns when Claude
  runs ahead and guides model routing. A status line script records the usage
  snapshot. See [The hooks](docs/installation.md#the-hooks).
- **A ledger mod** — a Claude Code plugin that adds `/ledger` and thirteen
  `/ledger:` commands. [Commands](#commands) lists each one.

To set it up, see [Install](#install).

## Why it is shaped this way

One number drives the design. In eight weeks of one operator's sessions, 86% of
the spend was re-reading context, not generating output — 257 tokens read for
every one written. Everything you read stays in the session and is paid for
again on every later turn.

So the setup pushes verbose work out of the main session. A build log goes to
`runner`, which returns a verdict. A wide code search goes to `researcher`,
which returns a short report. Implementation goes to an implementer, which
returns a diff and a report. The main session stays small, and it stays the
place where planning, routing, and review happen.

## Documentation

| Document | What it covers |
|---|---|
| [docs/usage.md](docs/usage.md) | The daily loop, a worked example, the ledger, clear points |
| [docs/examples.md](docs/examples.md) | Two longer examples: a new task with `/ledger:next`, and a backlog task |
| [docs/installation.md](docs/installation.md) | Prerequisites, every flag, what deploy owns, revert |
| [docs/fleet.md](docs/fleet.md) | The nine agents, their models, and the routing rules |
| [docs/customizing.md](docs/customizing.md) | Changing models, gating rules, adding an agent, tests |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Forking, what to send back, what must never be committed |
| [DECISIONS.md](DECISIONS.md) | Why the setup is shaped this way |

## Layout

```
rules/                    the orchestrator contract, one file per topic
agents/                   the nine subagents
docs/                     this documentation
ledger.template.md        copied per task to .claude/ledger.md
notes/                    rationale, not rules
DECISIONS.md              why the setup is shaped this way
settings.policy.json      Claude Code keys this repo asserts
codex/policy.toml         Codex keys this repo asserts
mods/ledger/              the /ledger command and its /ledger: commands, /ledger:worktrees included (a Claude Code plugin)
.claude-plugin/           marketplace.json, which lists the plugins in mods/ for Claude Code
hooks/                    the seven hook scripts and status line that deploy installs
githooks/                 the git hook dispatcher that deploy installs
tools/                    the deploy code, its wizard and CLI, the settings merge and the rule filter
tests/                    the tests for tools/, bin/ and hooks/
bin/deploy                installs everything above
bin/ledger                the terminal command: the read-only /ledger commands, and deploy
bin/cc-dd-path            prints the shared Xcode build folder for a worktree
bin/cc-task-new           writes a backlog ledger, or makes a task's branch and worktree
bin/cc-worktree-retire    archives a worktree's ledger, then removes the worktree; or archives, then deletes a backlog ledger
bin/cc-ledgers            keeps ~/.claude/ledgers.json, the list of every task ledger
CONTRIBUTING.md           forking, what to send back, what must never be committed
```

## Notes

Agents you add under `~/.claude/agents/` that are not in this repo are left
alone by deploy. Keep private or employer-specific agents there, not here.

No secrets belong in this repo. Nothing here reads a key or a token.
