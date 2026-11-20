import { fail } from './failure.js';

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
    name: 'plan',
    header: 'Plan',
    question: (task) => `Approve the plan for ${task}?`,
    multiSelect: false,
    actions: [
      { label: 'Approve plan', description: 'Start the work as planned, with the failing tests first.' },
      { label: 'Change plan', description: 'Nothing starts yet. Say what to change; the new plan comes back for approval.' },
    ],
  },
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
];

export const GATE_NAMES: readonly string[] = GATES.map(({ name }) => name);

/** The widget question of the gate `name` for the task `slug`; fails for a name no gate has. */
export function gateQuestion(name: string, slug?: string): GateQuestion {
  const gate = GATES.find((candidate) => candidate.name === name) ?? fail(`No gate is named "${name}". Gates: ${GATE_NAMES.join(', ')}.`);
  return buildGate(gate, slug);
}
