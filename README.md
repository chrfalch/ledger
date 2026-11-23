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
`yes`, pick "Save, clear and continue" at each clear point, and tick "retire"
after the PR merges. The full loop:

1. Start a task in one sentence: `Start a new task: …`. If another task is
   open, the reply ends with a `start:` line, `/ledger:go <name>`. Type it.
2. Approve the plan. Answer `yes`, or ask to change a step.
3. The agent works. It writes failing tests first, makes the fix, and gets it
   reviewed.
4. At a clear point, the agent asks one question. Pick "Save, clear and
   continue". The agent saves the ledger and clears the session. A fresh
   session continues from the ledger. Steps 3 and 4 repeat until the plan is
   done. The agent also asks at a clear point when the session grows past
   150,000 tokens. The plugin setting `clearPointTokens` changes that size;
   0 turns it off.
5. When the last review passes, the agent asks to commit and open a PR.
   Answer `yes`.
6. After the PR merges, the agent asks one question with check boxes: retire
   this task, retire other finished tasks, start the next task. Tick the ones
   you want. The agent retires first and starts the next task last. A retire
   archives the ledger and removes the worktree. The agent never forces a
   retire; when one would need `--force`, it fixes the cause or asks you.

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

**Agent:** (asks) Ledger updated. Save, clear the session and continue from
the next step?

**You:** (pick) Save, clear and continue (Recommended)

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

The `ledger` command reads and changes the task ledgers from a terminal,
without a Claude Code session. It also runs deploy. Its commands come in
groups: `task` for tasks, `tree` for parent and child tasks, `store` for where
the ledgers are kept, and `worktrees` for linked worktrees. `ledger go`,
`ledger list` and `ledger show` are short for `ledger task go`,
`ledger task list` and `ledger task show`. `task list`, `task archive`,
`task show`, `task gate`, `tree show` and `worktrees` only read. `task new`, `task go`,
`task park`, `task unpark`, `task retire` and the other `tree` commands change
ledgers; each edit changes only the lines it names.

| You type | What happens |
|---|---|
| `ledger task list [--json]` | Lists the tasks that are not retired, in every repo it knows: active, parked and backlog. It reads the status from the ledgers on disk. |
| `ledger task archive [term] [--all]` | Lists this repo's archived ledgers, newest first. A term keeps only the ledgers that contain it, in any case. `--all` lists the archive of every repo. |
| `ledger task show <slug> [--repo <repo>] [--json]` | Prints the task's worktree ledger in this clone, else its backlog ledger in this repo, else its newest archive copy, `<date>-<slug>`. A full archive name, such as `2026-11-01-fix-login-2`, prints that one copy. `--repo <repo>` reads another repo's ledgers; outside a repo it is required. It takes the repo's key, such as `github.com/me/app`, an old folder name kept as an alias, or the short label, such as `me/app`, when one repo has it. |
| `ledger task show <slug> --evidence [<file>]` | Lists the evidence files of the task's newest archive copy, one path per line. With a file, it prints that file's bytes. |
| `ledger task gate <plan\|pr> [<slug>]` | Prints the question the agent asks you at a gate, as JSON the question widget takes. `plan` asks to approve a plan, `pr` asks to open the pull request. The recommended action comes first and Close last. Without a slug, the question names the task of the worktree you are in; outside one, it says "this task". It exits 1 for a gate name it does not know. |
| `ledger tree show <slug> [--json]` | Shows a parent task and the status of each child task. Use `<slug>@<path>` for a parent in the repo at `<path>`. |
| `ledger tree add <slug> <child>` | Makes `<child>` a child task of `<slug>`. It writes `- parent:` in the child's ledger and a line under `## Children` in the parent's. A child in another repo is `<child>@<path>`. It refuses a task as its own parent, a child that has another parent, a cycle, and a retired child. |
| `ledger tree remove <slug> <child>` | Removes the link again. A `## Children` section with no child left is removed too. |
| `ledger tree start <slug> <child>` | Marks the child's line `(started <date>)`. Text written after the line's name stays. |
| `ledger tree next <slug>` | Prints the chain from the parent to its first child task that is still in the backlog, such as `epic part`. It prints nothing when no such child is left. |
| `ledger task new <slug> [--goal <text>]` | Writes a backlog ledger, `~/.claude/ledger-backlog/<repo>/<slug>.md`, from `~/.claude/ledger.template.md`, and prints the `start:` line. In a worktree with a ledger, it adds a line under that ledger's `## Decisions` that names the new task. `--stack` makes the branch and worktree at once, on top of the current branch. `--repo <path>` writes the task for the repo at `<path>`. |
| `ledger task new --here [<slug>]` | Gives the current linked worktree a ledger. Without a slug, the task takes the branch name without its owner prefix. It prints no `start:` line. |
| `ledger task go <slug> [--repo <path>]` | Starts a backlog task: it makes the branch and the worktree `.claude/worktrees/<slug>`, and moves the ledger into it with the worktree, branch and base filled in. The branch starts at the ledger's `- base:` when it names one, else at the default branch. |
| `ledger task park <slug> --reason <text>` | Marks a task parked: `Parked: <date> — <reason>` becomes the first line under `## Next step`. The reason is required. |
| `ledger task unpark <slug>` | Removes the parked mark. |
| `ledger task retire [<slug>] [--dry-run] [--force]` | Retires a task. Without a slug, it retires the task of the worktree you are in. It copies the ledger to `~/.claude/ledger-archive/<repo>/<date>-<slug>.md`, and `.claude/evidence/` to the folder of the same name. Then it removes the worktree, or the backlog ledger. It marks the task `(retired <date>)` in its parent and copies its `## Report` to the parent's `## Child reports`. It deletes the branch when the branch is merged: no commits ahead of the default branch, or a merged PR that ends at HEAD. Uncommitted changes, an unmerged branch and child tasks that are not retired each need `--force`. Evidence that cannot be archived whole stops it even with `--force`: a `.claude/evidence` that is not a folder or cannot be read, a symbolic link in it that leaves it, or an archive copy whose evidence differs. `--dry-run` prints the checks and steps; it fetches origin's default branch and changes nothing else. It exits 1 when a check stops it. |
| `ledger store migrate --to <file\|sqlite\|git> [--from <storage>] [--remove-source] [--dry-run]` | Moves the backlog ledgers, the archive with its evidence, and the repo aliases from the storage the setting names, or from `--from`, to the one you name. It copies everything, reads each copy back, and then sets `"storage"` in `~/.claude/ledger-settings.json`. The other storage keeps its ledgers unless you add `--remove-source`. It exits 1, with nothing changed, when the target already has a ledger of the same name. A move into git storage commits and pushes; a failed push is reported, and the setting still switches. `--dry-run` prints the plan and changes nothing. |
| `ledger store migrate --repo-ids [--dry-run]` | Once, for ledgers filed under the folder name of a checkout, as before repo keys: moves each to its repo's key, with its evidence, and keeps the folder name as an alias. It only renames on the same disk. A ledger whose checkout is gone or cannot be told, that lies on another disk, or whose name the key already has, stays where it is for you to move by hand, and the command exits 1. With git storage, it commits and pushes the moves; the aliases stay on the machine that ran it. `--dry-run` prints the plan, changes nothing, and exits the same way. |
| `ledger store migrate --pending [--json]` | Lists what `--repo-ids`, `--active` and `--records` would move, in the order they run: each task from where to where. A task a move would leave is marked with the reason. It prints `Nothing to move.` when nothing is left, and changes nothing. `--json` prints the list as one JSON object. `bin/deploy` reads this list to offer the moves. The list is a preview: each move checks again when it runs, so it can still leave a task the list showed as movable. |
| `ledger store sync init <url>` | Sets up git storage in `~/.claude/ledger-data` from a private GitHub repository. It asks `gh` whether the repository is private, and stops when it is not, or when `gh` cannot tell. An empty repository gets its layout, pushed at once; a repository another machine set up keeps its contents; any other repository is refused. It does not change the storage setting. |
| `ledger store sync [--quiet]` | With git storage: asks `gh` whether the repository is still private, commits the ledgers, pulls with a rebase, checks that the commits hold only ledgers and no secret-like text, and pushes. It exits 1, with nothing pushed, on a conflict, a check that fails, or a network failure, and names the file or `file:line`. `--quiet` prints nothing, asks `gh` once a day, and exits at once when another `--quiet` sync runs; the background push after each command uses it. |
| `ledger worktrees` | Shows each linked worktree of this repo: size, last commit, uncommitted files, ledger and PR, largest first. |
| `ledger worktrees prune <name>\|--all [--dry-run]` | Deletes the git-ignored build folders (`.build`, `.expo-prebuild`, `.cache`, `build`, `.DerivedData`) and the worktree's own Xcode build folder, `.claude/worktrees/.build/<name>` in the main checkout, each of 0.05 GB or more. It never deletes anything else in `.claude`, nor anything in `node_modules` or `Pods`. `--dry-run` only lists the folders. It exits 1 when a folder could not be deleted. |
| `ledger worktrees prune-orphans [--dry-run]` | Deletes the Xcode build folders in `.claude/worktrees/.build/` whose worktree git no longer lists. It keeps `.main`, the folder of the main checkout. `--dry-run` only lists the folders. It exits 1 when a folder could not be deleted. |
| `ledger deploy [options]` | Runs `bin/deploy` from this repo. The options pass through, so `ledger deploy --dry-run` prints every change and writes nothing. |
| `ledger help [command]` | Prints help for `ledger`, or for one of its commands. |

### Where the ledgers are kept

Every ledger is kept in the ledger store: the active ledgers, the backlog
ledgers and the archive. Read a ledger with `ledger show`, and write it one item
at a time with `ledger notes`. The ledgers are files by default, at the paths this README names.
An active ledger is `~/.claude/ledger-active/<repo>/<slug>.json`. To keep them in one SQLite
database, `~/.claude/ledgers.db`, write this to `~/.claude/ledger-settings.json`:

```json
{ "storage": "sqlite" }
```

SQLite storage needs Node.js 22.13 or later, and 23.4 or later on Node.js 23.
A settings file that is not valid
JSON, or names another storage, makes every command that uses the storage
exit 1; `ledger --help` still works, and hooks print the error and exit 0.
The database also holds the evidence files of each archive copy. Read a ledger or its evidence with
`ledger show`. A change of the setting by hand does not move the ledgers.
Use `ledger store migrate --to sqlite` or `ledger store migrate --to file`: it
copies the ledgers, checks the copy, and then changes the setting.

To share the backlog and the archive between machines, use git storage: a
clone of a private GitHub repository at `~/.claude/ledger-data`. Run
`ledger store sync init <url>` once on each machine, then `ledger store migrate --to git`.
Each command that changes a ledger commits it and pushes in the background,
and each session start pulls. Evidence stays on the
machine. Your other machines list a task you started here as
`active on <host>`, and read its ledger, but cannot change it. `"host"` in
`~/.claude/ledger-settings.json` names the machine; without it, the host name
does. A secret scan and an allowlist guard
every push, a manual `git push` in the clone too: the clone sets its own
`core.hooksPath`, so hooks from a global one do not run there.
`git push --no-verify` skips that pre-push hook, and with it the scan and the
allowlist.
[docs/usage.md](docs/usage.md) explains setup, what is pushed, what the scan
does not find, and what to do on a conflict.

#### Security limits of git storage

The secret scan looks for known key formats, line by line, in UTF-8 text. It
does not find a key split over two lines, a key in UTF-16 text, or a
random-looking string that matches no known key format: it has no entropy
check. These gaps are accepted. Keep keys out of ledgers; the repository must
stay private.

Do not run `git push` in the clone yourself: that is not supported. The
pre-push hook still checks such a push, but ledger puts a changed hook back
only when a ledger command, `ledger store sync` or a session start runs. Push with
`ledger store sync`.

## Commands

The ledger mod adds these commands. Claude Code puts the plugin name in front
of every command that a plugin writes as a markdown file, so a plain `/task`
does not exist.

A hook answers `/ledger`, `/ledger:help`, `/ledger:worktrees`,
`/ledger:retire`, `/ledger:archive`, `/ledger:all` and `/ledger:parent`
directly, without a model turn. Most of them only print.
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

When the first line under the task's `## Next step` starts with `Done`, a row
of buttons shows above the prompt box. **Retire &lt;slug&gt;** puts
`/ledger:retire <slug>` in the prompt box. For a child task whose parent has a
child task that has not started, **Next: &lt;child&gt;** puts
`/ledger:go <parent>` there. A click only fills the prompt box; you press Enter
to run the command. The text lines that name these commands stay, so hosts
without a prompt box, such as SDK hosts, still show them.

### Daily use

| You type | What happens |
|---|---|
| `/ledger` | Prints each task ledger's goal, current step and next step. A parent task in this repo's backlog is listed too, marked `(backlog)`, with its child tasks under it; so is that task's own parent task in the backlog. Other backlog tasks are not listed. |
| `/ledger <name>` | Prints each ledger whose name contains `<name>`, in any case. More than one ledger can match. |
| `/ledger:help` | Prints one line for each `/ledger` command. |
| `/ledger:task <description>` | Starts a separate task. The agent picks a short name, writes the goal, and runs `ledger task new`. The command writes a ledger with the goal filled in to the backlog, `~/.claude/ledger-backlog/<repo>/<name>.md`, with no branch or worktree yet. When no task is open, the session moves into the new worktree and continues there. The agent makes that branch and worktree at once, the same way `/ledger:go` does. When another task is open, the ledger stays in the backlog, and the reply ends with a `start:` line, `/ledger:go <name>`. Type it to clear the session and continue in the new task. Either way, you do not open a new terminal. `--stack` makes the branch and worktree at once, on top of the current branch. |
| `/ledger:task --here [<slug>]` | Gives the linked worktree this session is in a ledger, instead of a new worktree. Without a slug, the task takes the branch name without its owner prefix. It refuses the main checkout and a worktree that already has a ledger. The reply is the path of the new ledger. |
| `/ledger:update` | Writes the step status, the subagent reports, the decisions and the next step to the task's ledger. After a review with work left, the reply is the clear-point question: save, clear and continue, not now, or close. Otherwise it says only that the ledger is updated. With no ledger in the working directory, the agent creates nothing and tells you to use `/ledger:task`. |
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
| `/ledger:worktrees prune-orphans` | Deletes the Xcode build folders of worktrees that no longer exist. Each folder is named after its worktree, so a folder no worktree matches is an orphan. It never deletes `.main`, the folder of the main checkout. |
| `/ledger:worktrees prune-orphans --dry-run` | Lists those folders. It deletes nothing. |
| `/ledger:all` | Prints one table of every task ledger on the machine, from every repo, newest first, with its parent and next step. A status column gives each task's status: active, parked, backlog or retired. The title line counts the live tasks: active, parked and backlog. A child task follows its parent as `↳ <child>`, also when the parent is in another repo. It reads the ledgers of every known repo from the store each time. |

To remove a finished worktree, use `/ledger:retire <slug>` or
`ledger task retire <slug>`. It archives the ledger first, then removes the
worktree and its Xcode build folders. For a task in the backlog, it archives
the ledger, then deletes it from `~/.claude/ledger-backlog/<repo>/`.

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
Its menu has Deploy, Migrate, and Revert the last deploy. Every deploy moves
active ledgers into the store without asking. After Deploy, the wizard lists
any other stored task data still in an older format and asks whether to move it
now. It also lists each task that needs a person, with the reason; when only
such tasks are left, it asks nothing.
Migrate runs those moves, or switches the store type. Flags work as before and
skip the wizard; `bin/deploy --migrate` runs the pending moves without asking,
and does not offer to pull new commits first.
See [Moving stored task data](docs/installation.md#moving-stored-task-data).

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
- **Ten subagents** — investigation, execution, implementation, and review
  lanes, each pinned to a model.
- **A task ledger** — a small file that holds the task state, so a session can
  be cleared and restarted without losing anything.
- **Four hook scripts and `ledger hook` across five hook events** — they put
  the ledger back into context when a session starts, and protect it when a
  session compacts.
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
| [docs/fleet.md](docs/fleet.md) | The ten agents, their models, and the routing rules |
| [docs/customizing.md](docs/customizing.md) | Changing models, gating rules, adding an agent, tests |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Forking, what to send back, what must never be committed |
| [DECISIONS.md](DECISIONS.md) | Why the setup is shaped this way |
| [llp/](llp/) | Design documents: how the ledger system is built, and plans for it |

New design goes in `llp/`, one numbered document per topic. `DECISIONS.md`
stays as the history of past decisions. Run `npm run llp` to check the
documents and the links to them.

## Layout

```
rules/                    the orchestrator contract, one file per topic
agents/                   the ten subagents
docs/                     this documentation
ledger.template.md        the starting text of each new task ledger
notes/                    rationale, not rules
DECISIONS.md              why the setup is shaped this way
llp/                      design documents, checked by npm run llp
settings.policy.json      Claude Code keys this repo asserts
codex/policy.toml         Codex keys this repo asserts
mods/ledger/              the /ledger command and its /ledger: commands, /ledger:worktrees included (a Claude Code plugin)
.claude-plugin/           marketplace.json, which lists the plugins in mods/ for Claude Code
hooks/                    the hook scripts and status line that deploy installs
githooks/                 the git hook dispatcher that deploy installs
tools/                    the deploy code, its wizard and CLI, the settings merge and the rule filter
tests/                    the tests for tools/, bin/ and hooks/
bin/deploy                installs everything above
bin/ledger                the terminal command: lists tasks, the archive and parents; writes task, go, park, unpark and parent changes; retires tasks; shows and prunes worktrees; runs deploy
bin/cc-dd-path            prints and creates the Xcode build folder for a worktree and configuration
CONTRIBUTING.md           forking, what to send back, what must never be committed
```

## Notes

Agents you add under `~/.claude/agents/` that are not in this repo are left
alone by deploy. Keep private or employer-specific agents there, not here.

No secrets belong in this repo. Nothing here reads a key or a token.
