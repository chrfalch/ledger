// @ref LLP 0000#the-notes-commands — where each notes command writes today, and what check finds.
import path from 'node:path';
import { fail, Failure } from './failure.js';
import { exists } from './files.js';
import { parseLedger } from './format.js';
import { isKind, KINDS, STAGES } from './kinds.js';
import { CITATION_ADVICE, realPath, SESSION_CITATION } from './paths.js';
import { parseRecord, renderRecord, validateRecord, type Constraint, type Decision, type Question, type Step, type TaskRecord } from './record.js';
import { notOnThisMachine, type Task } from './tasks.js';
import { currentTask, liveTask, readLedger, today, updateLedger, type Context } from './write.js';

export const TAGS = ['observed', 'confirmed', 'inferred'] as const;
export type Tag = (typeof TAGS)[number];

/**
 * The task `name` gives, else the one whose worktree holds the folder the command runs in. Never an archive copy, and
 * never a task of another machine: that fails before its text is read.
 */
function notesTask(context: Context, name: string | undefined): Task {
  const task = name === undefined ? (currentTask(context.store, context.cwd) ?? fail('No task in this folder. Pass --task <slug>.')) : liveTask(context, name).task;
  return task.elsewhere ? fail(notOnThisMachine(task)) : task;
}

/** `text`; a Failure when it cites a file in a Claude Code session folder, which macOS deletes. */
const uncited = (text: string): string => (SESSION_CITATION.test(text) ? fail(`${CITATION_ADVICE} Nothing was written; run the command again with that path.`) : text);

/** `text` without the white space around it; a Failure that names `what` when nothing is left, or when it cites a session file. */
function given(text: string, what: string): string {
  const trimmed = uncited(text.trim());
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

const FINISHED = 'finished';

function stageProblems({ kind = 'code', stage }: TaskRecord): string[] {
  if (!isKind(kind)) return [`The kind ${kind} is not one of ${KINDS}.`];
  const stages = STAGES[kind];
  return stage === undefined || stage === FINISHED || stages.includes(stage) ? [] : [`The stage ${stage} is neither ${FINISHED} nor a stage of a ${kind} task: ${stages.join(', ')}.`];
}

/** What `ledger notes check` finds beyond the record's shape. A resolved question blocks nothing. */
function problemsOf(record: TaskRecord): string[] {
  const steps = new Set(record.plan.steps.map(({ n }) => n));
  return [
    ...(record.goal.trim() === '' ? ['The goal is empty.'] : []),
    ...stageProblems(record),
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

/** Sets the status of plan step `n`, or its note, or both; an empty note clears it. */
export function setStep(context: Context, name: string | undefined, n: number, { status, note }: { status?: string; note?: string }) {
  if (status === undefined && note === undefined) fail('ledger notes step needs --status <status>, --note <text>, or both.');
  const fields = { ...(status === undefined ? {} : { status: given(status, '--status') }), ...(note === undefined ? {} : { note: uncited(note.trim()) }) };
  return write(context, name, ({ plan }, task) => {
    const step = plan.steps.find((each) => each.n === String(n)) ?? fail(`${task.slug} has no step ${n} in its plan.`);
    Object.assign(step, fields);
    return { step };
  });
}

export const setStepText = ({ slug, step }: ReturnType<typeof setStep>): string => `Updated step ${step.n} of ${slug}.`;

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
  if (task.worktree === undefined) return file;
  const relative = path.relative(task.worktree, file);
  const outside = relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return outside ? file : relative;
}

/** Only the path is kept, not the file's text, so the ledger stays small. */
export function reportStep(context: Context, name: string | undefined, step: number, file: string) {
  const absolute = path.resolve(context.cwd, given(file, '--file'));
  if (!exists(absolute)) fail(`No file at ${absolute}.`);
  uncited(absolute);
  uncited(realPath(absolute));
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

export type StageCall = { outcome?: string; back?: string; skip?: string; step?: number };

const STEP_STATUS_AFTER: Readonly<Record<string, string>> = { red: 'red', build: 'green', review: 'reviewed' };

/**
 * Records the outcome of the stage the task is at, which must be `stage`, and moves the task on: to the next stage on
 * pass or skip, to `back` on fail with it. A record with no kind is code; one with no stage is at the first.
 */
export function recordStage(context: Context, name: string | undefined, stage: string, { outcome, back, skip, step }: StageCall) {
  return write(context, name, (record, task) => {
    const kind = record.kind ?? 'code';
    if (!isKind(kind)) fail(`${task.slug} has the kind ${kind}, which is not one of ${KINDS}.`);
    const stages = STAGES[kind];
    const current = record.stage ?? stages[0];
    const refuse = (problem: string): never =>
      fail(`${problem} ${current === FINISHED ? `${task.slug} is ${FINISHED}` : `${task.slug} is at stage ${current}`}; the stages of a ${kind} task are ${stages.join(', ')}.`);

    if (outcome !== undefined && skip !== undefined) refuse('Give pass or fail, or --skip, not both.');
    if (outcome === undefined && skip === undefined) refuse('Give pass or fail, or --skip "<reason>".');
    if (outcome !== undefined && outcome !== 'pass' && outcome !== 'fail') refuse(`The outcome is pass or fail, not "${outcome}".`);
    if (back !== undefined && outcome !== 'fail') refuse('--back goes only with fail.');
    if (step !== undefined && outcome === 'fail') refuse('--step goes only with pass or --skip.');
    const reason = skip?.trim();
    if (reason === '') refuse('The reason for --skip is empty.');
    if (reason?.includes('\n')) refuse('The reason for --skip must be one line.');

    if (!stages.includes(stage)) refuse(`${stage} is not a stage of a ${kind} task.`);
    if (current === FINISHED) refuse('Every stage has passed.');
    const at = stages.indexOf(current);
    if (at === -1) refuse(`The ledger's stage is not a stage of a ${kind} task.`);
    const asked = stages.indexOf(stage);
    if (asked > at) refuse(`Stage ${stage} comes after ${current}; skipping needs --skip at the current stage.`);
    if (asked < at) refuse(`Stage ${stage} has passed; to go back to it, use fail --back ${stage} at the current stage.`);
    if (back !== undefined && !stages.slice(0, at).includes(back)) refuse(`--back takes a stage before ${stage}, not ${back}.`);

    const planStep = step === undefined ? undefined : (record.plan.steps.find(({ n }) => n === String(step)) ?? refuse(`${task.slug} has no step ${step} in its plan.`));
    if (planStep !== undefined) planStep.status = STEP_STATUS_AFTER[stage] ?? 'done';

    const result = reason !== undefined ? 'skipped' : outcome === 'pass' ? 'passed' : 'failed';
    const next = result === 'failed' ? (back ?? stage) : (stages[at + 1] ?? FINISHED);
    record.stage = next;
    const note = reason !== undefined ? `skipped: ${reason}` : back !== undefined ? `fail, back to ${back}` : outcome;
    record.notes.push(`${today()} stage ${stage} ${note}`);
    return { stage, result, next };
  });
}

export function recordStageText({ slug, stage, result, next }: ReturnType<typeof recordStage>): string {
  const onward = next === FINISHED ? `${slug} is ${FINISHED}` : `next is ${next}`;
  if (result === 'skipped') return `Skipped stage ${stage} of ${slug}; ${onward}.`;
  if (result === 'passed') return `Stage ${stage} of ${slug} passed; ${onward}.`;
  return `Stage ${stage} of ${slug} failed; ${next === stage ? `it stays at ${stage}` : `back to ${next}`}.`;
}

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
