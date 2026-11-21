// @ref LLP 0000#the-notes-commands — where each notes command writes today, and what check finds.
import path from 'node:path';
import { fail, Failure } from './failure.js';
import { exists } from './files.js';
import { parseLedger } from './format.js';
import { sessionLedgers } from './hooks.js';
import { parseRecord, renderRecord, validateRecord, type Constraint, type Decision, type Question, type Step, type TaskRecord } from './record.js';
import { loadTasks } from './registry.js';
import type { Task } from './tasks.js';
import { liveTask, readLedger, today, updateLedger, type Context } from './write.js';

export const TAGS = ['observed', 'confirmed', 'inferred'] as const;
export type Tag = (typeof TAGS)[number];

/** The task `name` gives, else the one whose worktree holds the folder the command runs in. Never an archive copy. */
function notesTask(context: Context, name: string | undefined): Task {
  if (name !== undefined) return liveTask(context, name).task;
  const { tasks, own } = sessionLedgers(context.cwd);
  return own && tasks.length === 1 ? tasks[0] : fail('No task in this folder. Pass --task <slug>.');
}

/** `text` without the white space around it; a Failure that names `what` when nothing is left. */
function given(text: string, what: string): string {
  const trimmed = text.trim();
  return trimmed === '' ? fail(`${what} is empty.`) : trimmed;
}

/** `text` as a whole number from 1, such as a step or question number; a Failure that names `option` otherwise. */
export function positive(text: string, option: string): number {
  const trimmed = text.trim();
  return /^[1-9]\d*$/.test(trimmed) ? Number(trimmed) : fail(`${option} takes a whole number from 1, not "${text}".`);
}

/** The most characters of a rendered ledger: about 4k tokens, at 4 characters a token. */
export const LEDGER_SIZE_LIMIT = 16_000;

export const count = (n: number): string => n.toLocaleString('en-US');

function sizeProblem(record: TaskRecord): string[] {
  const markdown = renderRecord(record);
  if (markdown.length <= LEDGER_SIZE_LIMIT) return [];
  const { lines, sections } = parseLedger(markdown);
  const largest = sections
    .map(({ heading, start, end }) => ({ name: heading.replace(/ \(.*\)$/, ''), size: lines.slice(start, end).join('\n').length }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 3)
    .map(({ name, size }) => `${name} (${count(size)})`);
  return [`The ledger is ${count(markdown.length)} characters, over the limit of ${count(LEDGER_SIZE_LIMIT)}. Shorten the largest sections: ${largest.join(', ')}.`];
}

/** What `ledger notes check` finds beyond the record's shape. A resolved question blocks nothing. */
function problemsOf(record: TaskRecord): string[] {
  const steps = new Set(record.plan.steps.map(({ n }) => n));
  return [
    ...(record.goal.trim() === '' ? ['The goal is empty.'] : []),
    ...record.questions.flatMap(({ id, blocks, resolved }) =>
      blocks === undefined || resolved || steps.has(String(blocks)) ? [] : [`Question ${id} blocks step ${blocks}, which is not in the plan.`],
    ),
    ...record.stepReports.flatMap(({ step }) => (step === undefined || steps.has(step) ? [] : [`The report of step ${step} names a step that is not in the plan.`])),
    ...sizeProblem(record),
  ];
}

const REPORT_LINE_LIMIT = 160;
const isPastReview = (status: string): boolean => ['reviewed', 'done'].includes(status.trim().toLowerCase());

/** Shortens the report of each reviewed or done step to its first line: the full report is needed only until the review. */
function shortenReviewedReports({ plan, stepReports }: TaskRecord): void {
  const pastReview = new Set(plan.steps.filter(({ status }) => isPastReview(status)).map(({ n }) => n));
  for (const report of stepReports) {
    if (report.step === undefined || !pastReview.has(report.step)) continue;
    const first = report.text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
    // By code point, so the cut never splits a character such as an emoji.
    const characters = [...first];
    report.text = characters.length > REPORT_LINE_LIMIT ? `${characters.slice(0, REPORT_LINE_LIMIT - 1).join('')}…` : first;
  }
}

type Written<T> = T & { slug: string; ledger: string; warnings: string[] };

/**
 * Changes the record of a task with `apply`, which may refuse with a Failure, and writes it when the result is a valid
 * record; else nothing is written. The warnings are what `ledger notes check` finds in the written record.
 */
function write<T extends object>(context: Context, name: string | undefined, apply: (record: TaskRecord, task: Task) => T): Written<T> {
  const task = notesTask(context, name);
  let done: { details: T; record: TaskRecord } | undefined;
  updateLedger(context, task, (markdown) => {
    const record = parseRecord(markdown);
    const details = apply(record, task);
    shortenReviewedReports(record);
    try {
      validateRecord(record);
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      fail(`Did not write ${task.slug}: ${error.message}`);
    }
    done = { details, record };
    return renderRecord(record);
  });
  if (done === undefined) return fail(`The ledger ${task.file} is gone.`);
  // The task list caches each ledger's next step and state; reload it so `ledger list` shows this write.
  if (task.main !== undefined) loadTasks(context, [task.main]);
  return { ...done.details, slug: task.slug, ledger: task.file, warnings: problemsOf(done.record) };
}

const highestStep = (steps: Step[]): number => Math.max(0, ...steps.map(({ n }) => (/^\d+$/.test(n) ? Number(n) : 0)));

export function addStep(context: Context, name: string | undefined, text: string, owner: string, note?: string) {
  const fields = { step: given(text, 'The step'), status: 'todo', owner: given(owner, '--owner'), note: note === undefined ? '' : given(note, '--note') };
  return write(context, name, ({ plan }) => {
    const step: Step = { n: String(highestStep(plan.steps) + 1), ...fields };
    plan.steps.push(step);
    // A plan with steps reads back with no exampleRow, so a kept false would fail the round trip.
    delete plan.exampleRow;
    return { step };
  });
}

export const addStepText = ({ slug, step }: ReturnType<typeof addStep>): string => `Added step ${step.n} to ${slug}.`;

export const approvePlan = (context: Context, name: string | undefined) =>
  write(context, name, ({ plan }) => {
    plan.approved = today();
    return { approved: plan.approved };
  });

export const approvePlanText = ({ slug, approved }: ReturnType<typeof approvePlan>): string => `Approved the plan of ${slug} on ${approved}.`;

export function addDecision(context: Context, name: string | undefined, text: string, because: string, tag: Tag) {
  const decision: Decision = { text: given(text, 'The decision'), reason: given(because, '--because'), tag, date: today() };
  return write(context, name, ({ decisions }) => ({ number: decisions.push(decision), decision }));
}

export const addDecisionText = ({ slug, number }: ReturnType<typeof addDecision>): string => `Added decision ${number} to ${slug}.`;

export function addConstraint(context: Context, name: string | undefined, text: string, source: string, tag?: Tag) {
  const constraint: Constraint = { text: given(text, 'The constraint'), source: given(source, '--source'), ...(tag === undefined ? {} : { tag }) };
  return write(context, name, ({ constraints }) => ({ number: constraints.push(constraint), constraint }));
}

export const addConstraintText = ({ slug, number }: ReturnType<typeof addConstraint>): string => `Added constraint ${number} to ${slug}.`;

export function addQuestion(context: Context, name: string | undefined, text: string, blocks?: number) {
  const asked = given(text, 'The question');
  return write(context, name, ({ questions }) => {
    const question: Question = { id: questions.length + 1, text: asked, ...(blocks === undefined ? {} : { blocks }) };
    questions.push(question);
    return { question };
  });
}

export const addQuestionText = ({ slug, question }: ReturnType<typeof addQuestion>): string => `Added question ${question.id} to ${slug}.`;

export const resolveQuestion = (context: Context, name: string | undefined, id: number) =>
  write(context, name, ({ questions }, task) => {
    const question = questions.find((each) => each.id === id) ?? fail(`${task.slug} has no question ${id}.`);
    if (question.resolved) fail(`Question ${id} of ${task.slug} is already resolved.`);
    question.resolved = true;
    return { question };
  });

export const resolveQuestionText = ({ slug, question }: ReturnType<typeof resolveQuestion>): string => `Resolved question ${question.id} of ${slug}.`;

/** `file` as a step report names it: relative to the task's worktree when it lies inside, else absolute. */
function reportPath(task: Task, file: string): string {
  if (task.place !== 'worktree') return file;
  const relative = path.relative(path.dirname(path.dirname(task.file)), file);
  const outside = relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return outside ? file : relative;
}

/** Only the path is kept, not the file's text, so the ledger stays small. */
export function reportStep(context: Context, name: string | undefined, step: number, file: string) {
  const absolute = path.resolve(context.cwd, given(file, '--file'));
  if (!exists(absolute)) fail(`No file at ${absolute}.`);
  return write(context, name, ({ plan, stepReports }, task) => {
    const n = String(step);
    if (!plan.steps.some((each) => each.n === n)) fail(`${task.slug} has no step ${n} in its plan.`);
    const report = { step: n, text: reportPath(task, absolute) };
    const earlier = stepReports.findIndex((each) => each.step === n);
    if (earlier === -1) stepReports.push(report);
    else stepReports[earlier] = report;
    return { report };
  });
}

export const reportStepText = ({ slug, report }: ReturnType<typeof reportStep>): string => `Recorded ${report.text} as the report of step ${report.step} of ${slug}.`;

export function reportToParent(context: Context, name: string | undefined, text: string) {
  const report = given(text, '--parent').split('\n');
  return write(context, name, (record) => {
    record.report = report;
    return { report };
  });
}

export const reportToParentText = ({ slug }: ReturnType<typeof reportToParent>): string => `Recorded the report of ${slug} to its parent.`;

export function addNote(context: Context, name: string | undefined, text: string) {
  const note = given(text, 'The note');
  return write(context, name, ({ notes }) => {
    notes.push(...note.split('\n'));
    return { note };
  });
}

export const addNoteText = ({ slug }: ReturnType<typeof addNote>): string => `Added a note to ${slug}.`;

export function setNext(context: Context, name: string | undefined, text: string) {
  const next = given(text, 'The next step');
  return write(context, name, (record) => {
    record.next = next;
    return { next };
  });
}

export const setNextText = ({ slug }: ReturnType<typeof setNext>): string => `Set the next step of ${slug}.`;

export type CheckResult = { slug: string; ledger: string; problems: string[] };

/** Reads the task and changes nothing. */
export function checkTask(context: Context, name: string | undefined): CheckResult {
  const task = notesTask(context, name);
  const record = parseRecord(readLedger(context, task));
  let invalid: string[] = [];
  try {
    validateRecord(record);
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    invalid = [error.message];
  }
  return { slug: task.slug, ledger: task.file, problems: [...invalid, ...problemsOf(record)] };
}
