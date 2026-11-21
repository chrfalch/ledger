// Not starting with a dot, so a slug never names ., .. or a hidden folder when it becomes a worktree folder.
const READABLE_SLUG = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const NEW_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** A slug an existing ledger may carry. */
export const isReadableSlug = (slug: string): boolean => READABLE_SLUG.test(slug);

/** A host name or IPv6 address in brackets, and an optional port: no scheme, user or other colon. */
const HOST = /^(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d+)?$/;

/** A repo key in the shape repoKey gives it: `host[:port]/path`, or a main checkout's absolute path; no folder is empty, . or .., and none holds a \. */
export function isRepoKeyShape(key: string): boolean {
  const [host, ...folders] = key.split('/');
  return folders.length > 0 && !key.includes('\\') && (host === '' || HOST.test(host)) && folders.every((folder) => folder !== '' && folder !== '.' && folder !== '..');
}

/** A slug a new task may take. */
export const isNewSlug = (slug: string): boolean => NEW_SLUG.test(slug);

/** A task by slug; `main` is its main checkout when the ledger names one. */
export type TaskRef = { slug: string; main?: string };

/**
 * A task that must be done before another starts. `repo` is the key of its repo (D10), such as github.com/o/r; it is
 * left out for a task in the repo of the task that waits for it.
 */
export type Dependency = { slug: string; repo?: string };

/** `start` is the heading line; `end` is the next heading line, or the line count. */
export type Section = { heading: string; start: number; end: number };

/** `since` and `active` are UTC times to the second, as 2026-11-20T10:00:00Z. */
export type Claim = { session: string; since: string; active: string };

export type Location = {
  worktree?: string;
  host?: string;
  branch?: string;
  base?: { ref: string; commit?: string };
  main?: string;
  parent?: TaskRef & { line: number };
  claim?: Claim;
  state?: string;
  order?: number;
  dependencies?: Dependency[];
};

export type ChildMark = { kind: 'retired' | 'started'; date: string };

/** A line under ## Children. `suffix` is the text after the slug and main, as written. `mark` is only a hint. */
export type Child = TaskRef & { line: number; suffix: string; mark?: ChildMark };

export type Parked = { line: number; date: string; reason: string };

/**
 * One ledger file. `lines` is the text split on \n, each line keeping its own \r, so serializing is a join and an edit
 * that replaces one line leaves every other byte as it was.
 */
export type Ledger = {
  lines: readonly string[];
  slug?: string;
  sections: readonly Section[];
  location: Location;
  children: readonly Child[];
  parked?: Parked;
  goal: string;
  next: string;
  report: readonly string[];
};

const TITLE = /^# Task ledger[ \t]*[—-][ \t]*(.*)$/;
const HEADING = /^## (.*)$/;
const FIELD = /^- ([a-z][a-z ]*):[ \t]*(.*)$/;
const REF = /^([A-Za-z0-9._-]+)(?:[ \t]*@[ \t]*(\/\S*))?$/;
const DEPENDENCY = /^([A-Za-z0-9._-]+)(?:[ \t]*@[ \t]*([^\s,]+))?$/;
const ORDER = /^(0|[1-9]\d*)$/;
// The text after a child's slug and main is a mark or note in parentheses; any other text makes the bullet prose.
const CHILD = /^- ([A-Za-z0-9._-]+)(?:[ \t]*@[ \t]*(\/\S*))?(?:[ \t]+(\(.*))?$/;
const MARK = /^\((retired|started) (\d{4}-\d\d-\d\d)\b/;
const PARKED = /^Parked:[ \t]*(\d{4}-\d{2}-\d{2})[ \t]*[—-][ \t]*(.*)$/;
const CLAIM = /^session (\S+) since (\S+), active (\S+)$/;

export const isPlaceholder = (text: string): boolean => /^<.*>$/.test(text);

/** The text after `# Task ledger —` on a title line; undefined for any other line. */
export const titleText = (line: string): string | undefined => TITLE.exec(line)?.[1].trim();

/** `slug` or `slug @ /main`, as a `- parent:` bullet names a task. */
export function parseRef(text: string): TaskRef | undefined {
  const [, slug, main] = REF.exec(text) ?? [];
  return slug === undefined ? undefined : { slug, ...(main === undefined ? {} : { main }) };
}

/** A UTC time to the second that names a real moment, such as 2026-11-20T10:00:00Z. */
export function isClaimTime(text: string): boolean {
  const time = Date.parse(text);
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(text) && !Number.isNaN(time) && new Date(time).toISOString() === text.replace('Z', '.000Z');
}

/** The value of a `- claim:` bullet, `session <id> since <time>, active <time>`; undefined for any other text. */
export function parseClaim(text: string): Claim | undefined {
  const [, session, since, active] = CLAIM.exec(text) ?? [];
  return session !== undefined && isClaimTime(since) && isClaimTime(active) ? { session, since, active } : undefined;
}

export const claimText = ({ session, since, active }: Claim): string => `session ${session} since ${since}, active ${active}`;

/** The value of an `- order:` bullet: a whole number. */
export const parseOrder = (text: string): number | undefined => (ORDER.test(text) ? Number(text) : undefined);

/** `a, b @ github.com/o/r`, as a `- depends on:` bullet names tasks; undefined when any item is no dependency. */
export function parseDependencies(text: string): Dependency[] | undefined {
  const dependencies: Dependency[] = [];
  for (const item of text.split(',')) {
    const [, slug, repo] = DEPENDENCY.exec(item.trim()) ?? [];
    if (slug === undefined || !isReadableSlug(slug) || (repo !== undefined && !isRepoKeyShape(repo))) return undefined;
    dependencies.push(repo === undefined ? { slug } : { slug, repo });
  }
  return dependencies;
}

export const showDependencies = (dependencies: readonly Dependency[]): string => dependencies.map(({ slug, repo }) => (repo === undefined ? slug : `${slug} @ ${repo}`)).join(', ');

/** Whether `line` reads as the parked marker when it is the first text under ## Next step. */
export const isParkedMarker = (line: string): boolean => PARKED.test(line.trim());

/** A line as the parser reads it: without its \r and trailing whitespace. */
export const plainLine = (line: string): string => line.replace(/\r$/, '').trimEnd();

/** `## Plan (approved 2026-11-01)` is the Plan section: a heading may add a parenthesised note. */
const isNamed = (heading: string, name: string): boolean => heading === name || heading.startsWith(`${name} (`);

export const findSection = (sections: readonly Section[], name: string): Section | undefined => sections.find(({ heading }) => isNamed(heading, name));

export function parseLedger(text: string): Ledger {
  const lines = text.split('\n');
  const plain = lines.map(plainLine);
  const sections = findSections(plain);
  const range = (name: string): number[] => {
    const section = findSection(sections, name);
    return section ? Array.from({ length: section.end - section.start - 1 }, (_, offset) => section.start + 1 + offset) : [];
  };
  const texts = (name: string, skipped?: number): string[] =>
    range(name)
      .filter((index) => index !== skipped)
      .map((index) => plain[index].trim())
      .filter((line) => line !== '' && !isPlaceholder(line));
  const titled = plain.map((line) => TITLE.exec(line)?.[1].trim()).find((slug) => slug !== undefined);
  const { parked } = parseParked(plain, range('Next step'));
  return {
    lines,
    ...(titled !== undefined && isReadableSlug(titled) ? { slug: titled } : {}),
    sections,
    location: parseLocation(plain, range('Location')),
    children: parseChildren(plain, range('Children')),
    ...(parked === undefined ? {} : { parked }),
    goal: texts('Goal')[0] ?? '',
    next: texts('Next step', parked?.line)[0] ?? '',
    report: range('Report').map((index) => plain[index]).filter((line) => line.trim() !== '' && !isPlaceholder(line.trim())),
  };
}

export const serializeLedger = (ledger: Ledger): string => ledger.lines.join('\n');

export type PlanStep = { number: string; step: string; status: string };

/** `current` is the first plan row not finished; `finished` holds when the plan has rows and every one is finished. */
export type PlanProgress = { current: PlanStep | null; finished: boolean };

const FINISHED_STEP = /^(done|accepted|reviewed|dropped|skipped)\b/i;

/** The numbered rows of the ## Plan table, read as the ledger plugin reads them. */
export function planProgress({ lines, sections }: Ledger): PlanProgress {
  const plan = findSection(sections, 'Plan');
  const rows = (plan === undefined ? [] : lines.slice(plan.start + 1, plan.end))
    .map(plainLine)
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .map(([number = '', step = '', status = '']) => ({ number, step, status }))
    .filter(({ number }) => /^\d+$/.test(number));
  const current = rows.find(({ status }) => !FINISHED_STEP.test(status)) ?? null;
  return { current, finished: rows.length > 0 && current === null };
}

/** The fence run that opens a CommonMark code fence; a backtick fence's info text holds no backtick. */
function openingFence(line: string): string | undefined {
  const [, run, info] = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line) ?? [];
  return run === undefined || (run[0] === '`' && info.includes('`')) ? undefined : run;
}

const closesFence = (line: string, run: string): boolean => {
  const [, closing] = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line) ?? [];
  return closing !== undefined && closing[0] === run[0] && closing.length >= run.length;
};

/** Unlike CommonMark, an unclosed fence ends at the next heading, so a stray fence cannot hide the rest of a ledger. */
function findSections(plain: string[]): Section[] {
  const starts: number[] = [];
  for (let index = 0; index < plain.length; index++) {
    const run = openingFence(plain[index]);
    if (run === undefined) {
      if (HEADING.test(plain[index])) starts.push(index);
      continue;
    }
    const close = plain.findIndex((line, after) => after > index && closesFence(line, run));
    if (close !== -1) index = close;
    else {
      const heading = plain.findIndex((line, after) => after > index && HEADING.test(line));
      index = heading === -1 ? plain.length : heading - 1;
    }
  }
  return starts.map((start, position) => ({
    heading: (HEADING.exec(plain[start])?.[1] ?? '').trim(),
    start,
    end: starts[position + 1] ?? plain.length,
  }));
}

function parseLocation(plain: string[], range: number[]): Location {
  const location: Location = {};
  for (const index of range) {
    const [, name, raw] = FIELD.exec(plain[index].trim()) ?? [];
    const value = raw?.trim();
    if (name === undefined || !value || value.startsWith('<')) continue;
    if (name === 'worktree' || name === 'host' || name === 'branch' || name === 'main') location[name] ??= value;
    else if (name === 'base' && location.base === undefined) {
      const [ref, commit] = value.split(/[ \t]+@[ \t]+/);
      location.base = commit === undefined ? { ref } : { ref, commit };
    } else if (name === 'parent' && location.parent === undefined) {
      const [, slug, main] = REF.exec(value) ?? [];
      if (slug !== undefined) location.parent = { slug, ...(main === undefined ? {} : { main }), line: index };
    } else if (name === 'claim') location.claim ??= parseClaim(value);
    else if (name === 'state') location.state ??= value;
    else if (name === 'order' && location.order === undefined) {
      const order = parseOrder(value);
      if (order !== undefined) location.order = order;
    } else if (name === 'depends on' && location.dependencies === undefined) {
      const dependencies = parseDependencies(value);
      if (dependencies !== undefined) location.dependencies = dependencies;
    }
  }
  return location;
}

function parseMark(suffix: string): ChildMark | undefined {
  const [, kind, date] = MARK.exec(suffix) ?? [];
  return kind === 'retired' || kind === 'started' ? { kind, date } : undefined;
}

function parseChildren(plain: string[], range: number[]): Child[] {
  return range.flatMap((index): Child[] => {
    const [, slug, main, suffix = ''] = CHILD.exec(plain[index].trim()) ?? [];
    if (slug === undefined) return [];
    const mark = parseMark(suffix);
    return [{ slug, ...(main === undefined ? {} : { main }), line: index, suffix, ...(mark === undefined ? {} : { mark }) }];
  });
}

/** Parked only counts as the first text under ## Next step. */
function parseParked(plain: string[], range: number[]): { parked?: Parked } {
  const line = range.find((index) => plain[index].trim() !== '');
  if (line === undefined) return {};
  const [, date, reason] = PARKED.exec(plain[line].trim()) ?? [];
  return date === undefined ? {} : { parked: { line, date, reason: reason.trim() } };
}
