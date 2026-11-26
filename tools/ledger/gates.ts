import { fail } from './failure.js';
import type { TaskRef } from './format.js';
import { parseRecord } from './record.js';
import { findTasks, taskRef, theTask, type Task } from './tasks.js';
import { currentTask, readLedger, type Context } from './write.js';

// @ref LLP 0001#11-questions-to-the-operator — the widget rules, D33–D35.

/** One choice at a gate. The description says in plain words, on one line, what the choice changes. */
export type GateAction = { label: string; description: string };

/** An approval point in the lifecycle of a task. */
export type GateDefinition = {
  name: string;
  /** The widget's chip, 12 characters at most. */
  header: string;
  /** The question about `task`: the task's slug, or "this task" when none is known. */
  question: (task: string) => string;
  multiSelect: boolean;
  /** One to three actions, the recommended one first. Close is added after them. */
  actions: GateAction[];
};

export type GateQuestion = { question: string; header: string; multiSelect: boolean; options: GateAction[] };

const MAX_ACTIONS = 3;
const MAX_HEADER = 12;

const CLOSE = 'Save where the task stands and stop. Nothing else runs.';
const MULTI_SELECT_CLOSE = 'Save where the task stands and stop. Other ticked options run first; ticked alone, nothing else runs.';

/** The widget question of `gate` for the task `slug`. Throws when the definition breaks a widget rule (D33, D35). */
export function buildGate(gate: GateDefinition, slug?: string): GateQuestion {
  const refuse = (problem: string): never => {
    throw new Error(`The gate ${gate.name} ${problem}`);
  };
  if (gate.header.length === 0 || gate.header.length > MAX_HEADER) refuse(`needs a header of 1 to ${MAX_HEADER} characters, not "${gate.header}".`);
  if (gate.actions.length === 0) refuse('needs at least one action.');
  if (gate.actions.length > MAX_ACTIONS) refuse(`has ${gate.actions.length} actions; a gate gives at most three actions, plus Close.`);
  for (const { label, description } of gate.actions) {
    if (label.trim() === '') refuse('has an action with an empty label.');
    if (description.trim() === '') refuse(`has an empty description for "${label}".`);
    if (/[\r\n]/.test(description)) refuse(`needs a one line description for "${label}".`);
  }
  const [recommended, ...others] = gate.actions;
  return {
    question: gate.question(slug ?? 'this task'),
    header: gate.header,
    multiSelect: gate.multiSelect,
    options: [
      { label: `${recommended.label} (Recommended)`, description: recommended.description },
      ...others.map(({ label, description }) => ({ label, description })),
      { label: 'Close', description: gate.multiSelect ? MULTI_SELECT_CLOSE : CLOSE },
    ],
  };
}

const GATES: readonly GateDefinition[] = [
  {
    name: 'pr',
    header: 'Pull request',
    question: (task) => `Every step of ${task} is done. Open its pull request?`,
    multiSelect: false,
    actions: [
      { label: 'Commit, push and open the PR', description: 'Commit the changes, push the branch and open a pull request for review.' },
      { label: 'Not yet', description: 'Nothing is committed or pushed. The session waits for what you say next.' },
    ],
  },
  {
    name: 'merge',
    header: 'Merge',
    question: (task) => `The PR of ${task} passed its checks and review. Merge it now?`,
    multiSelect: false,
    actions: [
      { label: 'Merge now', description: 'Merge the pull request. The task becomes done and the finalize question follows.' },
      { label: 'Not yet', description: 'Nothing is merged. The PR stays open and the task stays waiting.' },
    ],
  },
  {
    name: 'goal',
    header: 'Goal',
    question: (task) => `Every stage of ${task} has passed. Is its goal met?`,
    multiSelect: false,
    actions: [
      { label: 'Goal met', description: 'Mark the task done. The finalize question follows.' },
      { label: 'Not yet', description: 'The task stays active. Say what is left to do.' },
    ],
  },
  {
    name: 'abandon',
    header: 'Abandon',
    question: (task) => `Abandon ${task}? Its ledger is archived and nothing is merged.`,
    multiSelect: false,
    actions: [
      { label: 'Abandon task', description: 'Archive the ledger with the reason and remove the worktree. An unmerged branch is kept.' },
      { label: 'Not yet', description: 'Nothing is archived or removed. The task stays as it is.' },
    ],
  },
];

/** The gates whose question is the same for every task, so `gateQuestion` builds it from the name alone. */
export const GATE_NAMES: readonly string[] = GATES.map(({ name }) => name);

/** The gate whose question names the plan's summary and step count, which `planQuestion` reads from the store. */
export const PLAN_GATE = 'plan';

/** The gate whose actions come from the task's tree and repo, which finalize.ts reads from the store. */
export const FINALIZE_GATE = 'finalize';

/** Every gate `ledger task gate` asks. */
export const ALL_GATE_NAMES: readonly string[] = [PLAN_GATE, ...GATE_NAMES, FINALIZE_GATE];

/** The task the gate `gate` asks about: `slug`, by default the task of the worktree `context.cwd` is in. */
export function gateTask(context: Context, gate: string, slug?: string): { task: Task; ref: Required<TaskRef>; tasks: Task[] } {
  const name = slug ?? currentTask(context.store, context.cwd)?.slug ?? fail(`No task has the worktree you are in, so name one: ledger task gate ${gate} <slug>`);
  const ref = taskRef(context.cwd, name);
  const tasks = findTasks(context.store);
  return { task: theTask(tasks, ref), ref, tasks };
}

/** The plan question for the task `slug`, which states the plan's summary and step count, as the widget hides the text above it. */
export function planQuestion(context: Context, slug?: string): GateQuestion {
  const { task } = gateTask(context, PLAN_GATE, slug);
  const { summary, steps } = parseRecord(readLedger(context, task)).plan;
  if (steps.length === 0) fail(`The plan of ${task.slug} has no steps. Add them first: ledger notes plan add "<step>" --owner <agent>`);
  if (summary === undefined) fail(`The plan of ${task.slug} has no summary. Set one first: ledger notes plan summary "<text>"`);
  const count = steps.length === 1 ? '1 step' : `${steps.length} steps`;
  return buildGate(
    {
      name: PLAN_GATE,
      header: 'Plan',
      question: (subject) => `Approve the plan for ${subject}? ${summary} (${count})`,
      multiSelect: false,
      actions: [
        { label: 'Approve plan', description: 'Start the work as planned, with the failing tests first.' },
        { label: 'Change plan', description: 'Nothing starts yet. Say what to change; the new plan comes back for approval.' },
      ],
    },
    task.slug,
  );
}

/** The widget question of the gate `name` for the task `slug`; fails for a name no gate has. */
export function gateQuestion(name: string, slug?: string): GateQuestion {
  const gate = GATES.find((candidate) => candidate.name === name) ?? fail(`No gate is named "${name}". Gates: ${ALL_GATE_NAMES.join(', ')}.`);
  return buildGate(gate, slug);
}
