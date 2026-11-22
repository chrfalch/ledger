// @ref LLP 0001#4-storage — D29: each task is one structured record; the Markdown is a view rendered from it.
import { isDeepStrictEqual } from 'node:util';
import { fail, Failure } from './failure.js';
import {
  claimText,
  findSection,
  isClaimTime,
  isParkedMarker,
  isReadableSlug,
  isRepoKeyShape,
  lostMark,
  lostText,
  parseClaim,
  parseDependencies,
  parseLedger,
  parseLost,
  parseOrder,
  parseRef,
  plainLine,
  showDependencies,
  titleText,
  type ChildMark,
  type Claim,
  type Dependency,
  type Lost,
  type Section,
  type TaskRef,
} from './format.js';

export type Step = { n: string; step: string; status: string; owner: string; note: string };
export type Decision = { text: string; reason?: string; tag?: string; date?: string };
export type Constraint = { text: string; source?: string; tag?: string };
/** `id` is the question's place in the list, from 1. */
export type Question = { id: number; text: string; blocks?: number; resolved?: boolean };
export type StepReport = { step?: string; text: string };
/** A line under ## Children. `suffix` is the text after the slug and main, as written; `mark` is read from it. */
export type ChildLine = { slug: string; main?: string; suffix: string; mark?: ChildMark };

/**
 * One task as the store keeps it. `notes` holds the general notes, then each line of the Markdown that fits no field,
 * after a copy of the heading it stood under, so nothing a person wrote is lost.
 */
export type TaskRecord = {
  version: 1;
  /** Empty for a ledger whose title names no slug, such as the template. */
  slug: string;
  title?: string;
  kind?: string;
  state?: string;
  stage?: string;
  parent?: TaskRef;
  order?: number;
  dependencies?: Dependency[];
  claim?: Claim;
  pr?: string;
  repo?: string;
  worktree?: string;
  /** The host label of the machine whose worktree an active task is in. */
  host?: string;
  branch?: string;
  base?: { ref: string; commit?: string };
  main?: string;
  /** 'none' is a task that touches no LLP; unset is a ledger with no design refs line, as in a repo without llp/. */
  designRefs?: string[] | 'none';
  parked?: { date: string; reason: string };
  lost?: Lost;
  goal: string;
  /** `exampleRow` is false for a plan without steps that lacks the template's example row too, which the plugin reads as a step. */
  plan: { approved?: string; steps: Step[]; exampleRow?: false };
  decisions: Decision[];
  constraints: Constraint[];
  questions: Question[];
  stepReports: StepReport[];
  /** The report to the parent task, line by line. */
  report: string[];
  children: ChildLine[];
  /** The text under ## Children that is no child line, written after the child lines, so sorting them keeps it there. */
  childNotes?: string[];
  notes: string[];
  next: string;
};

const FIELDS = [
  'version',
  'slug',
  'title',
  'kind',
  'state',
  'stage',
  'parent',
  'order',
  'dependencies',
  'claim',
  'pr',
  'repo',
  'worktree',
  'host',
  'branch',
  'base',
  'main',
  'designRefs',
  'parked',
  'lost',
  'goal',
  'plan',
  'decisions',
  'constraints',
  'questions',
  'stepReports',
  'report',
  'children',
  'childNotes',
  'notes',
  'next',
] as const satisfies readonly (keyof TaskRecord)[];

/**
 * A task record as a store keeps it, with `created`, when the task was created, as toISOString writes it, where the store
 * has no such time of its own: a file store sets it when a record replaces Markdown, as the new file would have that
 * moment as its birth time. The Markdown does not show it, so it is no field of the record; the store carries it from
 * one write of the record to the next.
 */
export type StoredRecord = { record: TaskRecord; created?: string };

const PREAMBLE = ['Read this first in every fresh session. Update it at every pipeline boundary.', 'Facts, not narrative. Keep under ~4k tokens.'];
const GOAL = '<one paragraph — what done looks like>';
const STEP_REPORTS = '<paste the structured report for each step; replace with one line once the step is reviewed>';
const REPORT = '<3–5 lines for the parent task: outcome, PR link, what the parent must know>';
const NEXT = '<exactly one action, with the agent and effort to use>';
const TABLE = ['| # | step | status | owner | note |', '|---|------|--------|-------|------|'];
const EXAMPLE_STEP = '| 1 | <step> | todo / red / green / reviewed / done | <agent> | <one line> |';
const EXAMPLE_DECISION = '- <decision> — because <reason> [observed|confirmed|inferred]';
const EXAMPLE_CONSTRAINT = '- <constraint> — found in <file/report> [observed]';
const EXAMPLE_QUESTION = '- <question> — blocks step <#>?';

const FIELD = /^- ([a-z][a-z ]*):[ \t]*(.*)$/;
const PLAN_HEADING = /^Plan(?: \(approved (.+)\))?$/;
// An item may span lines, so these match across them: [\s\S] is any character, and $ is the end of the item.
const DATED = /^(\d{4}-\d\d-\d\d): ([\s\S]+)$/;
const TAGGED = /^([\s\S]+?)[ \t]+\[((?:observed|confirmed|inferred)\b[^[\]\n]*)\]$/;
const RESOLVED = /^\(resolved\) ([\s\S]+)$/;
const BLOCKS = /^([\s\S]+) — blocks step ([1-9]\d*)$/;
const STEP_REPORT = /^step (\S+): ([\s\S]+)$/;

/** `object` without its undefined fields, so a record compares and serializes the same however it was built. */
const defined = <T extends object>(object: T): T => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)) as T;

/** Lines without blank lines at either end, and each run of blank lines inside as one. */
function tidy(lines: readonly string[]): string[] {
  const kept: string[] = [];
  for (const line of lines) if (line !== '' || (kept.length > 0 && kept.at(-1) !== '')) kept.push(line);
  if (kept.at(-1) === '') kept.pop();
  return kept;
}

type LocationKey = 'main' | 'worktree' | 'host' | 'branch' | 'base' | 'designRefs' | 'parent' | 'title' | 'kind' | 'state' | 'stage' | 'order' | 'dependencies' | 'claim' | 'pr' | 'repo' | 'lost';

/**
 * A `- <name>: <value>` bullet under ## Location. `template` is the value ledger.template.md gives it, which reads as
 * unset; it is written while the field is unset unless `written` is false, as a design refs line a repo without llp/
 * leaves out.
 */
type Bullet = { name: string; template?: string; written: boolean; read: (record: TaskRecord, value: string) => boolean; write: (record: TaskRecord) => string | undefined };

function bullet<K extends LocationKey>(
  name: string,
  key: K,
  parse: (value: string) => TaskRecord[K] | undefined,
  show: (value: NonNullable<TaskRecord[K]>) => string,
  { template, written = true }: { template?: string; written?: boolean } = {},
): Bullet {
  return {
    name,
    ...(template === undefined ? {} : { template }),
    written,
    // The first bullet that reads wins, as parseLedger reads Location.
    read: (record, value) => {
      const parsed = record[key] === undefined ? parse(value) : undefined;
      if (parsed !== undefined) record[key] = parsed;
      return parsed !== undefined;
    },
    write: (record) => (record[key] === undefined ? undefined : show(record[key] as NonNullable<TaskRecord[K]>)),
  };
}

const asText = (value: string): string => value;
const showRef = ({ slug, main }: TaskRef): string => (main === undefined ? slug : `${slug} @ ${main}`);

/** Each comma-separated item of `value` as `parse` reads it; undefined when any item does not read. */
function listOf<T>(value: string, parse: (item: string) => T | undefined): T[] | undefined {
  const items: T[] = [];
  for (const part of value.split(',')) {
    const item = parse(part.trim());
    if (item === undefined) return undefined;
    items.push(item);
  }
  return items;
}

/** Split as parseLedger splits it; a second ` @ ` stays in the commit, so no text is lost. */
function parseBase(value: string): TaskRecord['base'] {
  const [ref, ...commit] = value.split(/[ \t]+@[ \t]+/);
  return commit.length === 0 ? { ref } : { ref, commit: commit.join(' @ ') };
}

const BULLETS: Bullet[] = [
  bullet('main', 'main', asText, asText),
  bullet('worktree', 'worktree', asText, asText, { template: '<path>' }),
  {
    name: 'lost',
    written: true,
    read: (record, value) => {
      const lost = record.lost === undefined ? parseLost(value, record.worktree) : undefined;
      if (lost !== undefined) record.lost = lost;
      return lost !== undefined;
    },
    write: (record) => (record.lost === undefined ? undefined : lostText(record.lost, record.worktree)),
  },
  bullet('host', 'host', asText, asText),
  bullet('branch', 'branch', asText, asText, { template: '<name>' }),
  bullet('base', 'base', parseBase, ({ ref, commit }) => (commit === undefined ? ref : `${ref} @ ${commit}`), { template: '<branch/commit>' }),
  bullet('design refs', 'designRefs', (value) => (value === 'none' ? 'none' : listOf(value, (item) => item || undefined)), (refs) => (refs === 'none' ? refs : refs.join(',')), {
    template: '<LLP numbers, comma-separated, or none>',
    written: false,
  }),
  bullet('parent', 'parent', parseRef, showRef),
  bullet('title', 'title', asText, asText),
  bullet('kind', 'kind', asText, asText),
  bullet('state', 'state', asText, asText),
  bullet('stage', 'stage', asText, asText),
  bullet('order', 'order', parseOrder, String),
  bullet('depends on', 'dependencies', parseDependencies, showDependencies),
  bullet('claim', 'claim', parseClaim, claimText),
  bullet('pr', 'pr', asText, asText),
  bullet('repo', 'repo', asText, asText),
];

/** The bullets parseLedger reads, which skip a value that starts with <. */
const READ_BY_PLUGIN = ['main', 'worktree', 'branch', 'base', 'parent'];

/** Reads the Location bullets into `record`; gives the lines that fit none. A value parseLedger skips is kept as such a line. */
function readLocation(record: TaskRecord, lines: string[]): string[] {
  const fitsNone = (line: string): boolean => {
    const [, name, raw = ''] = FIELD.exec(line.trim()) ?? [];
    const field = BULLETS.find((each) => each.name === name);
    const value = raw.trim();
    if (field === undefined || value === '') return true;
    if (field.name === 'lost' && lostMark(line, record.worktree) === undefined) return true;
    if (value === field.template) return false;
    return (READ_BY_PLUGIN.includes(field.name) && value.startsWith('<')) || !field.read(record, value);
  };
  // A lost mark names the worktree, so it is read after the worktree bullet, wherever that stands.
  const isLost = (line: string): boolean => FIELD.exec(line.trim())?.[1] === 'lost';
  const order = [...lines.keys()].sort((a, b) => Number(isLost(lines[a])) - Number(isLost(lines[b])));
  const left = new Set(order.filter((index) => fitsNone(lines[index])));
  return lines.filter((_, index) => left.has(index));
}

const writeLocation = (record: TaskRecord): string[] =>
  BULLETS.flatMap(({ name, template, written, write }) => {
    const value = write(record) ?? (written ? template : undefined);
    return value === undefined ? [] : [`- ${name}: ${value}`];
  });

/** `body` split into its text, the part after `joiner`, and a trailing evidence tag such as `[observed]`. */
function annotated(body: string, joiner: string): { text: string; detail?: string; tag?: string } {
  const [, rest = body, tag] = TAGGED.exec(body) ?? [];
  const at = rest.indexOf(joiner);
  return defined({ text: at === -1 ? rest : rest.slice(0, at), detail: at === -1 ? undefined : rest.slice(at + joiner.length), tag });
}

function readDecision(body: string): Decision {
  const [, date, rest = body] = DATED.exec(body) ?? [];
  const { text, detail, tag } = annotated(rest, ' — because ');
  return defined({ text, reason: detail, tag, date });
}

function readConstraint(body: string): Constraint {
  const { text, detail, tag } = annotated(body, ' — found in ');
  return defined({ text, source: detail, tag });
}

function readQuestion(body: string, index: number): Question {
  const [, open = body] = RESOLVED.exec(body) ?? [];
  const [, text = open, blocks] = BLOCKS.exec(open) ?? [];
  return defined({ id: index + 1, text, blocks: blocks === undefined ? undefined : Number(blocks), resolved: open === body ? undefined : true });
}

function readStepReport(body: string): StepReport {
  const [, step, text = body] = STEP_REPORT.exec(body) ?? [];
  return defined({ step, text });
}

const tagged = (text: string, tag: string | undefined): string => (tag === undefined ? text : `${text} [${tag}]`);
const writeDecision = ({ text, reason, tag, date }: Decision): string => `- ${tagged(`${date === undefined ? '' : `${date}: `}${text}${reason === undefined ? '' : ` — because ${reason}`}`, tag)}`;
const writeConstraint = ({ text, source, tag }: Constraint): string => `- ${tagged(`${text}${source === undefined ? '' : ` — found in ${source}`}`, tag)}`;
const writeQuestion = ({ text, blocks, resolved }: Question): string => `- ${resolved ? '(resolved) ' : ''}${text}${blocks === undefined ? '' : ` — blocks step ${blocks}`}`;
const writeStepReport = ({ step, text }: StepReport): string => `- ${step === undefined ? '' : `step ${step}: `}${text}`;
const writeChild = ({ slug, main, suffix }: ChildLine): string => `- ${showRef({ slug, main })}${suffix ? ` ${suffix}` : ''}`;
/** The row of a plan step; the lines of its note after the first follow the row, as they were written. */
function writeStep({ n, step, status, owner, note }: Step): string {
  const [first, ...more] = note.split('\n');
  return [`|${[n, step, status, owner, first].map((cell) => (cell === '' ? ' ' : ` ${cell} `)).join('|')}|`, ...more].join('\n');
}

type Item<T> = { head: T; more: string[] };

/**
 * Groups a section's lines into items. A line `start` reads begins one. A line after it continues it while it is
 * indented, or follows the item with no blank line between, as Markdown continues a list item; blank lines inside an
 * item stay in it. A line `drop` names is left out, and any other line is left over.
 */
function readItems<T>(lines: string[], start: (line: string) => T | undefined, drop: (line: string) => boolean): { items: Item<T>[]; left: string[] } {
  const items: Item<T>[] = [];
  const left: string[] = [];
  let open = false;
  let blanks: string[] = [];
  for (const line of lines) {
    if (line === '') {
      (open ? blanks : left).push(line);
      continue;
    }
    const dropped = drop(line);
    const head = dropped ? undefined : start(line);
    const continues: boolean = head === undefined && open && !dropped && (/^\s/.test(line) || blanks.length === 0);
    if (head !== undefined) items.push({ head, more: [] });
    else if (continues) items[items.length - 1].more.push(...blanks, line);
    else if (!dropped) left.push(...blanks, line);
    open = head !== undefined || continues;
    blanks = [];
  }
  return { items, left };
}

/** The `- ` bullets of a section with the lines that continue each, as `read` gives them; `example` is dropped. */
function readBullets<T>(lines: string[], example: string, read: (body: string, index: number) => T): { items: T[]; left: string[] } {
  const { items, left } = readItems(lines, (line) => (line.startsWith('- ') ? line.slice(2).trim() : undefined), (line) => line.trim() === example);
  return { items: items.map(({ head, more }, index) => read([head, ...more].join('\n'), index)), left };
}

/** A bar that ends a table cell: one no backslash escapes, as a backslash before it may be escaped itself. */
const CELL_BAR = /(?<=(?:^|[^\\])(?:\\\\)*)\|/;

/**
 * A row of the plan table; 'skip' for the header, the separator and the template's example row. Only a row of five cells
 * is a step, as a step renders back as five cells.
 */
function readRow(line: string): Step | 'skip' | undefined {
  const trimmed = line.trim();
  if (trimmed === EXAMPLE_STEP) return 'skip';
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return undefined;
  const cells = trimmed.slice(1, -1).split(CELL_BAR).map((cell) => cell.trim());
  if (cells.length !== 5) return undefined;
  if (cells.join('|') === '#|step|status|owner|note' || cells.every((cell) => /^:?-+:?$/.test(cell))) return 'skip';
  const [n, step, status, owner, note] = cells;
  return n === '' ? undefined : { n, step, status, owner, note };
}

const KNOWN = ['Goal', 'Location', 'Children', 'Plan', 'Decisions', 'Constraints discovered', 'Subagent reports', 'Open questions', 'Report', 'Next step', 'Notes'] as const;
type Known = (typeof KNOWN)[number];

/** Reads a section's lines into `record`, and gives the lines it could not place. */
type Reader = (record: TaskRecord, lines: string[], context: { start: number; heading: string; parked?: number; children: ChildLine[]; childLines: number[] }) => string[];

/** The text of `lines`, without the template's `placeholder` line. */
const texts = (lines: string[], placeholder: string): string => tidy(lines.filter((line) => line.trim() !== placeholder)).join('\n');

function bulletReader<K extends 'decisions' | 'constraints' | 'stepReports' | 'questions'>(key: K, example: string, read: (body: string, index: number) => TaskRecord[K][number]): Reader {
  return (record, lines) => {
    const { items, left } = readBullets(lines, example, read);
    record[key] = items as TaskRecord[K];
    return left;
  };
}

const READERS: Record<Exclude<Known, 'Notes'>, Reader> = {
  Goal: (record, lines) => {
    record.goal = texts(lines, GOAL);
    return [];
  },
  Location: readLocation,
  Children: (record, lines, { start, children, childLines }) => {
    record.children = children;
    const notes = tidy(lines.filter((_, offset) => !childLines.includes(start + 1 + offset)));
    if (notes.length > 0) record.childNotes = notes;
    return [];
  },
  Plan: (record, lines, { heading }) => {
    const [, approved] = PLAN_HEADING.exec(heading) ?? [];
    const { items, left } = readItems(lines, (line) => {
      const row = readRow(line);
      return row === 'skip' ? undefined : row;
    }, (line) => readRow(line) === 'skip');
    const steps = items.map(({ head, more }) => ({ ...head, note: [head.note, ...more].join('\n') }));
    const exampleRow = steps.length > 0 || lines.some((line) => line.trim() === EXAMPLE_STEP) ? undefined : false;
    record.plan = defined({ approved: approved === '<date>' ? undefined : approved, steps, exampleRow });
    return left;
  },
  Decisions: bulletReader('decisions', EXAMPLE_DECISION, readDecision),
  'Constraints discovered': bulletReader('constraints', EXAMPLE_CONSTRAINT, readConstraint),
  'Subagent reports': bulletReader('stepReports', STEP_REPORTS, readStepReport),
  'Open questions': bulletReader('questions', EXAMPLE_QUESTION, readQuestion),
  Report: (record, lines) => {
    record.report = tidy(lines.filter((line) => line.trim() !== REPORT));
    return [];
  },
  'Next step': (record, lines, { start, parked }) => {
    record.next = texts(
      lines.filter((_, offset) => start + 1 + offset !== parked),
      NEXT,
    );
    return [];
  },
};

/** A heading the renderer writes back as it is: the section's name, or for the plan its approval date. */
const isCanonical = (name: Known, heading: string): boolean => (name === 'Plan' ? PLAN_HEADING.test(heading) : heading === name);

const knownName = (section: Section): Known | undefined => KNOWN.find((name) => findSection([section], name) !== undefined);

/** The record of a ledger in Markdown. It never fails: a line it cannot place goes to the notes. */
export function parseRecord(markdown: string): TaskRecord {
  const ledger = parseLedger(markdown);
  const plain = ledger.lines.map(plainLine);
  const record: TaskRecord = { version: 1, slug: ledger.slug ?? '', goal: '', plan: { steps: [], exampleRow: false }, decisions: [], constraints: [], questions: [], stepReports: [], report: [], children: [], notes: [], next: '' };
  if (ledger.parked !== undefined) record.parked = { date: ledger.parked.date, reason: ledger.parked.reason };
  const children = ledger.children.map(({ slug, main, suffix, mark }) => defined({ slug, main, suffix, mark }));
  const context = { parked: ledger.parked?.line, children, childLines: ledger.children.map(({ line }) => line) };

  const general: string[] = [];
  const groups: string[] = [];
  let titled = false;
  for (const line of plain.slice(0, ledger.sections[0]?.start ?? plain.length)) {
    const title = titleText(line);
    if (title !== undefined && !titled) {
      titled = true;
      if ((title !== '' && title === record.slug) || title === '<slug>') continue;
    }
    if (line.trim() !== '' && !PREAMBLE.includes(line.trim())) general.push(line);
  }

  const seen = new Set<Known>();
  for (const section of ledger.sections) {
    const heading = plain[section.start];
    const lines = plain.slice(section.start + 1, section.end);
    const name = knownName(section);
    if (name === undefined || seen.has(name)) {
      groups.push(heading, ...tidy(lines));
      continue;
    }
    seen.add(name);
    if (name === 'Notes') general.push(...tidy(lines));
    const left = name === 'Notes' ? [] : tidy(READERS[name](record, lines, { ...context, heading: section.heading, start: section.start }));
    if (!isCanonical(name, section.heading) || left.length > 0) groups.push(heading, ...left);
  }
  record.notes = [...tidy(general), ...groups];
  return ordered(record);
}

const ordered = (record: TaskRecord): TaskRecord => Object.fromEntries(FIELDS.flatMap((key) => (record[key] === undefined ? [] : [[key, record[key]]]))) as TaskRecord;

const orPlaceholder = (lines: string[], placeholder: string): string[] => (lines.length === 0 ? [placeholder] : lines);
const linesOf = (text: string): string[] => (text === '' ? [] : text.split('\n'));

/** A blank line before every heading that has none, as the template has; a copied heading in the notes gets one too. */
function spaced(lines: string[]): string[] {
  const starts = new Set(parseLedger(lines.join('\n')).sections.map(({ start }) => start));
  return lines.flatMap((line, index) => (starts.has(index) && index > 0 && lines[index - 1] !== '' ? ['', line] : [line]));
}

/** The record as a ledger in the layout of ledger.template.md, which parseLedger and the editors of edit.ts read. */
export function renderRecord(record: TaskRecord): string {
  const { parked, next, notes, plan } = record;
  const nextLines = linesOf(next);
  // Without the placeholder above it, a next step that reads like a parked marker would be read as one.
  const nextStep = [
    ...(parked === undefined ? [] : [`Parked: ${parked.date} —${parked.reason ? ` ${parked.reason}` : ''}`]),
    ...(parked === undefined && nextLines.length > 0 && isParkedMarker(nextLines[0]) ? [NEXT] : []),
    ...orPlaceholder(nextLines, NEXT),
  ];
  // A heading copied into the notes reads back as a repeat only after its own section, so that section is written even
  // when empty: ## Children, and ## Notes, which notes that start with a copied heading otherwise go without.
  const copies = parseLedger(notes.join('\n')).sections;
  const copied = (name: Known): boolean => findSection(copies, name) !== undefined;
  const noteLines = notes.length === 0 ? [] : [...(copies[0]?.start === 0 && !copied('Notes') ? [] : ['## Notes']), ...notes, ''];
  const planRows = plan.steps.length > 0 ? plan.steps.map(writeStep) : plan.exampleRow === false ? [] : [EXAMPLE_STEP];
  // An item of several lines is one entry here until the split at the end.
  return spaced([
    `# Task ledger — ${record.slug || '<slug>'}`,
    '',
    ...PREAMBLE,
    '',
    '## Goal',
    ...orPlaceholder(linesOf(record.goal), GOAL),
    '',
    '## Location',
    ...writeLocation(record),
    '',
    ...(record.children.length > 0 || record.childNotes !== undefined || copied('Children')
      ? ['## Children', ...record.children.map(writeChild), ...(record.childNotes === undefined ? [] : ['', ...record.childNotes]), '']
      : []),
    `## Plan (approved ${plan.approved ?? '<date>'})`,
    ...TABLE,
    ...planRows,
    '',
    '## Decisions',
    ...orPlaceholder(record.decisions.map(writeDecision), EXAMPLE_DECISION),
    '',
    '## Constraints discovered',
    ...orPlaceholder(record.constraints.map(writeConstraint), EXAMPLE_CONSTRAINT),
    '',
    '## Subagent reports',
    ...orPlaceholder(record.stepReports.map(writeStepReport), STEP_REPORTS),
    '',
    '## Open questions',
    ...orPlaceholder(record.questions.map(writeQuestion), EXAMPLE_QUESTION),
    '',
    '## Report',
    ...orPlaceholder(record.report, REPORT),
    '',
    '## Next step',
    ...nextStep,
    '',
    ...noteLines,
  ].flatMap((line) => line.split('\n'))).join('\n');
}

type Check = (value: unknown, where: string) => void;

function invalid(where: string, problem: string): never {
  return fail(`Not a task record: ${where || 'it'} ${problem}.`);
}
const at = (where: string, key: string): string => (where === '' ? key : `${where}.${key}`);

const passes = (test: (value: unknown) => boolean, problem: string): Check => (value, where) => {
  if (!test(value)) invalid(where, problem);
};
const isText = passes((value) => typeof value === 'string', 'is not a string');
const isWhole = passes(Number.isInteger, 'is not a whole number');
const isTrue = passes((value) => value === true, 'is not true');
const isSlug = passes((value) => typeof value === 'string' && isReadableSlug(value), 'is not a slug');
const isKey = passes((value) => typeof value === 'string' && isRepoKeyShape(value), 'is not a repo key such as github.com/owner/repo or the path of a main checkout');
const isTime = passes((value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, 'is not a time such as 2026-11-20T12:00:00.000Z');
const isClaimStamp = passes((value) => typeof value === 'string' && isClaimTime(value), 'is not a time such as 2026-11-20T10:00:00Z');
const isOne = (...allowed: unknown[]): Check => passes((value) => allowed.includes(value), `is not ${allowed.map((each) => JSON.stringify(each)).join(' or ')}`);
const listOfChecks = (item: Check): Check => (value, where) => {
  if (!Array.isArray(value)) return invalid(where, 'is not a list');
  value.forEach((each, index) => item(each, `${where}[${index}]`));
};
const isDesignRefs = passes((value) => value === 'none' || (Array.isArray(value) && value.every((ref) => typeof ref === 'string')), 'is not "none" or a list of strings');
function shape(required: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return (value, where) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(where, 'is not an object');
    const fields = new Map(Object.entries(value));
    for (const key of fields.keys()) if (!(key in required) && !(key in optional)) invalid(at(where, key), 'is no field it has');
    for (const [key, check] of Object.entries(required)) {
      if (!fields.has(key)) invalid(at(where, key), 'is missing');
      check(fields.get(key), at(where, key));
    }
    for (const [key, check] of Object.entries(optional)) if (fields.has(key)) check(fields.get(key), at(where, key));
  };
}

const isRef = shape({ slug: isText }, { main: isText });

const isRecord = shape(
  {
    version: isOne(1),
    slug: isText,
    goal: isText,
    plan: shape({ steps: listOfChecks(shape({ n: isText, step: isText, status: isText, owner: isText, note: isText })) }, { approved: isText, exampleRow: isOne(false) }),
    decisions: listOfChecks(shape({ text: isText }, { reason: isText, tag: isText, date: isText })),
    constraints: listOfChecks(shape({ text: isText }, { source: isText, tag: isText })),
    questions: listOfChecks(shape({ id: isWhole, text: isText }, { blocks: isWhole, resolved: isTrue })),
    stepReports: listOfChecks(shape({ text: isText }, { step: isText })),
    report: listOfChecks(isText),
    children: listOfChecks(shape({ slug: isText, suffix: isText }, { main: isText, mark: shape({ kind: isOne('retired', 'started'), date: isText }) })),
    notes: listOfChecks(isText),
    next: isText,
  },
  {
    ...Object.fromEntries((['title', 'kind', 'state', 'stage', 'pr', 'repo', 'worktree', 'host', 'branch', 'main'] as const).map((key) => [key, isText])),
    claim: shape({ session: isText, since: isClaimStamp, active: isClaimStamp }),
    parent: isRef,
    order: isWhole,
    childNotes: listOfChecks(isText),
    dependencies: listOfChecks(shape({ slug: isSlug }, { repo: isKey })),
    base: shape({ ref: isText }, { commit: isText }),
    designRefs: isDesignRefs,
    parked: shape({ date: isText, reason: isText }),
    lost: shape({ date: isText }),
  },
);

/** The first field of `record` that would not read back the same from the Markdown it renders to. */
function unstableField(record: TaskRecord): keyof TaskRecord | undefined {
  const back = parseRecord(renderRecord(record));
  return FIELDS.find((key) => !isDeepStrictEqual(back[key], record[key]));
}

/**
 * `value` as a task record, or a Failure that names what is wrong. Beyond its shape, the record must read back the same
 * from its Markdown, so a valid record survives every write through the store's Markdown API.
 */
export function validateRecord(value: unknown): TaskRecord {
  isRecord(value, '');
  const record = value as TaskRecord;
  const differs = unstableField(record);
  if (differs !== undefined) invalid(differs, 'does not read back the same from the Markdown the record renders to');
  return record;
}

/**
 * The record a store writes for a ledger written as `markdown`, at `where`. A record that would not read back the same
 * fails, before the store changes anything, as a write of it would lose text; a store never keeps an invalid record.
 */
export function recordToWrite(markdown: string, where: string): TaskRecord {
  const record = parseRecord(markdown);
  const differs = unstableField(record);
  if (differs !== undefined) fail(`Did not write the ledger ${where}: its task record would not read back the same (its ${differs} would change), so the write could lose text.`);
  return record;
}

/** The text a store keeps for `record`, its fields in a fixed order, and the `created` time it keeps beside them. */
export const recordJson = (record: TaskRecord, created?: string): string => `${JSON.stringify({ ...ordered(record), created }, null, 2)}\n`;

/** The record in `json`, which a store keeps at `where`, with its created time; a Failure that names `where` for anything else. */
export function readStoredRecord(json: string, where: string): StoredRecord {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return fail(`${where} is no task record: it is not valid JSON (${(error as Error).message}).`);
  }
  try {
    if (typeof value !== 'object' || value === null || !('created' in value)) return { record: validateRecord(value) };
    const { created, ...record } = value;
    isTime(created, 'created');
    return { record: validateRecord(record), created: created as string };
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    return fail(`${where}: ${error.message}`);
  }
}

/** The record in `json`, which a store keeps at `where`, without its created time. */
export const readRecordJson = (json: string, where: string): TaskRecord => readStoredRecord(json, where).record;

/** The text a store gives back for a ledger written as `markdown`. */
export const storedText = (markdown: string): string => renderRecord(parseRecord(markdown));
