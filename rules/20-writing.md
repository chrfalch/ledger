## Writing for humans

Anything that leaves the session — PR descriptions and comments, issues, commit
messages, explanations to the operator — is read by a person first, an agent
second.
Brevity means few ideas, not compressed sentences. Two layers:

**Layer 1, summary, first.** For a reader who has not seen the ledger or this
session. Problem before solution. One idea per sentence, concrete nouns, no
idioms. One line on how to verify: the command and what it should print. No fleet
vocabulary — no agent names, step or ticket numbers as shorthand, "red/green",
"ledger", effort levels; define any unavoidable term in the same sentence. Test:
could someone who reads only this layer decide what to review?

**Layer 2, details.** Exact file paths, function names, invariants, the reproducing
test, what was ruled out and why. Short headings. Do not restate the summary.

Explanations to the operator default to layer 1; offer layer 2. Use plain words:
describe what happens step by step, explain each technical term the first time
you use it, and keep file paths and function names out. When the operator must
decide, say what changes compared with earlier decisions. If the operator asks for
layman's terms, the default was wrong — fix the default. Do not tell the operator to
run a command you have not seen exist in this environment; check first, or say it
is unverified.

### Asking the operator

Ask every question that has fixed answers with the question widget (the
AskUserQuestion tool), not as text. This includes yes/no questions, such as
whether to commit and open a PR.
- At a gate that `ledger task gate` knows (`plan` and `pr` today), show the
  question it prints as JSON. Do not write its options yourself. Write any
  other gate yourself, with at most three actions, plus Close.
- A request for approval of one proposed action ("Shall I commit, push and
  open the PR?", "Proceed?") is a yes/no question. It has fixed answers, so it
  goes in the widget. Give it three options: the action, labelled with what it
  does; "Not yet", which stops and waits; and Close, which saves where the task
  stands and stops.
- In a multi-select widget, Close ticked with other options runs those
  options, then stops. Close ticked alone runs nothing and stops.
- During an operator walkthrough of a document, ask in plain text, one point
  at a time. The widget returns at the next gate.
- When your report ends with a question that has fixed answers, end the turn with the widget
  call. Do not write the question as text first.
- Make each possible answer one option, two to four per question. The widget
  adds its own free-text answer, so do not add an "Other" option.
- Put your recommended option first, and end its label with "(Recommended)".
- In each option's description, say in plain words what that option changes.
- The widget can hide the text above it. Make each question complete on its own,
  and put what changes compared with earlier decisions in the question or the
  option descriptions.
- Where the widget is not available, such as in a subagent, end with the options
  as text and your recommendation.

## Result status marks

In your conversation with the user, mark each result with a status emoji. A
result is one row of a results table, one summary line, or one note about an
outcome: a test run, an experiment, a tuning run, a check, a finding.

- 🟢 good: every run passed, or the finding is confirmed. A run with zero
  tests is not a pass.
- 🔴 blocking: at least one run failed. 100 passes and 1 failure is 🔴.
- 🟡 the user must do something: clarify, decide or check. A result that is
  not confirmed is 🟡. Say what is missing.

Rules:
- Put a word or value after every mark: `🟢 PASSED`, `🟢 score 0.93`,
  `🔴 1 of 3 runs failed`. Never a mark alone; colour alone does not
  reach every reader. The word is the outcome, never "red" or "green".
- In a comparison table, give each row one mark.
- A question with fixed answers goes in the question widget (see Asking the
  operator), and so does a yes/no question, except during a walkthrough of a
  document. Start any other question you ask
  the user with ❓. Such a question has an open answer, such as a name or a
  value:
  `❓ What should the new command be called?`. Use ❓ only for a question the
  user must answer. 🟡 marks a result; ❓ marks a question.
- Next steps and recommendations stay plain text, without a mark.
- ⚠ stays a warning callout. It is not a result mark.
- Subagent reports stay plain text. Add the mark when you pass a result to the
  user.

## Code preferences

- TypeScript: never `any` unless 100% necessary or instructed.
- Concise, simple solutions. If a simpler way exists, propose it.
- Comments: write code that needs no explaining, then don't explain it. No
  what-comments (fix the name instead), no process narration ("// Added X",
  "// Step 1"). Keep only what code cannot carry: *why*, a workaround's reason, a
  spec link, a non-local consequence. Scope: only code you are already touching;
  removing comments elsewhere is a drive-by refactor that code review will block.
- If asked to do too much at once, stop and say so.
