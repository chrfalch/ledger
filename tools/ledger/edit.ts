import path from 'node:path';
import { fail } from './failure.js';
import {
  claimText,
  findSection,
  isPlaceholder,
  LOST_BULLET,
  lostMark,
  lostText,
  parseLedger,
  plainLine as plain,
  serializeLedger,
  statusText,
  type Child,
  type Claim,
  type Ledger,
  type Lost,
  type Section,
  type Status,
  type StatusValue,
} from './format.js';

/**
 * Line edits of a ledger. Each one returns the new text, changes only the lines it names, and gives every line it adds
 * the file's own line ending.
 */

const ending = (lines: readonly string[]): string => (lines.some((line) => line.endsWith('\r')) ? '\r' : '');
/** `text` in place of `line`, keeping the \r of `line`. */
const replaced = (line: string, text: string): string => text + (line.endsWith('\r') ? '\r' : '');

function insert(ledger: Ledger, index: number, added: string[]): string {
  const cr = ending(ledger.lines);
  return [...ledger.lines.slice(0, index), ...added.map((line) => line + cr), ...ledger.lines.slice(index)].join('\n');
}

const without = (ledger: Ledger, drop: (index: number) => boolean): string => ledger.lines.filter((_, index) => !drop(index)).join('\n');

/** The line after the last text of `section`, so an addition sits above the blank lines that close it. */
function afterLastText(ledger: Ledger, { start, end }: Section): number {
  let index = end;
  while (index > start + 1 && plain(ledger.lines[index - 1]) === '') index--;
  return index;
}

const wholeFile = (ledger: Ledger): Section => ({ heading: '', start: -1, end: ledger.lines.length });

/** Adds `lines` at the end of the section `name`, or a new section with them at the end of the file. */
function appendTo(ledger: Ledger, name: string, lines: string[]): string {
  const section = findSection(ledger.sections, name);
  return section ? insert(ledger, afterLastText(ledger, section), lines) : insert(ledger, afterLastText(ledger, wholeFile(ledger)), ['', `## ${name}`, ...lines]);
}

export type Filled = {
  slug: string;
  goal?: string;
  /** Written as the first Location bullet; any other `- main:` bullet is dropped, as a worktree ledger has none. */
  main?: string;
  worktree?: string;
  branch?: string;
  base?: string;
  /** null drops the bullet, for a repo with no llp/ folder. */
  designRefs?: string | null;
  /** Replaces the value of the `- kind:` bullet, or is added at the end of ## Location. */
  kind?: string;
  /** The `- labels:` bullet, written as `kind` is; none for an empty list. */
  labels?: readonly string[];
};

const PLACEHOLDER_TITLE = /^# Task ledger[ \t]*[—-][ \t]*<.*>$/;
const LOCATION_BULLET = /^- (main|worktree|branch|base|design refs):/;

/**
 * Fills the template, or a backlog ledger on its way into a worktree. A given field replaces its bullet's value. A main
 * that is no absolute path fails, as it would name the folder of whoever reads the ledger.
 */
export function fillLedger(text: string, fields: Filled): string {
  if (fields.main !== undefined && !path.isAbsolute(fields.main)) fail(`The main checkout "${fields.main}" is no absolute path, so no ledger of ${fields.slug} was written.`);
  const ledger = parseLedger(text);
  const goal = findSection(ledger.sections, 'Goal');
  const location = findSection(ledger.sections, 'Location');
  const inSection = (section: Section | undefined, index: number): boolean => section !== undefined && index > section.start && index < section.end;
  const goalLine = ledger.lines.findIndex((line, index) => inSection(goal, index) && isPlaceholder(plain(line).trim()));
  const titleLine = ledger.lines.findIndex((line) => PLACEHOLDER_TITLE.test(plain(line)));
  const values: Record<string, string | null | undefined> = { main: null, worktree: fields.worktree, branch: fields.branch, base: fields.base, 'design refs': fields.designRefs };
  const cr = ending(ledger.lines);
  const filled = ledger.lines
    .flatMap((line, index) => {
      if (index === titleLine) return [replaced(line, `# Task ledger — ${fields.slug}`)];
      if (index === goalLine && fields.goal) return [replaced(line, fields.goal)];
      const [, name] = inSection(location, index) ? (LOCATION_BULLET.exec(plain(line)) ?? []) : [];
      const value = name === undefined ? undefined : values[name];
      const kept = value === undefined ? [line] : value === null ? [] : [replaced(line, `- ${name}: ${value}`)];
      return index === location?.start && fields.main !== undefined ? [...kept, `- main: ${fields.main}${cr}`] : kept;
    })
    .join('\n');
  const bullets: [string, string | undefined][] = [
    ['kind', fields.kind],
    ['labels', fields.labels?.length ? fields.labels.join(', ') : undefined],
  ];
  return bullets.reduce((text, [name, value]) => (value === undefined ? text : (setLocationBullet(text, name, value) ?? text)), filled);
}

/** `text` with a `- design refs:` bullet at the end of ## Location when that section has none; undefined without the section. */
export function withDesignRefsBullet(text: string): string | undefined {
  const ledger = parseLedger(text);
  const location = findSection(ledger.sections, 'Location');
  if (location === undefined) return undefined;
  const hasBullet = ledger.lines.slice(location.start + 1, location.end).some((line) => plain(line).startsWith('- design refs:'));
  return hasBullet ? text : insert(ledger, afterLastText(ledger, location), ['- design refs: <LLP numbers, comma-separated, or none>']);
}

export const addDecision = (text: string, line: string): string => appendTo(parseLedger(text), 'Decisions', [line]);

/** `ledger` without the line its status is read from, a legacy `- state:` bullet or `Parked:` marker included. */
const withoutStatus = (ledger: Ledger): Ledger => (ledger.statusLine === undefined ? ledger : parseLedger(without(ledger, (index) => index === ledger.statusLine)));

/**
 * `text` with `status` as its `- status:` bullet: in place of the bullet its status is read from, else at the end of
 * ## Location, a legacy form of it dropped. Undefined when the ledger has no ## Location.
 */
export function setStatus(text: string, status: Status): string | undefined {
  const ledger = parseLedger(text);
  const bullet = `- status: ${statusText(status)}`;
  const { statusLine } = ledger;
  if (statusLine !== undefined && /^\s*- status:/.test(ledger.lines[statusLine])) {
    const lines = [...ledger.lines];
    lines[statusLine] = replaced(lines[statusLine], bullet);
    return lines.join('\n');
  }
  const cleared = withoutStatus(ledger);
  const location = findSection(cleared.sections, 'Location');
  return location && insert(cleared, afterLastText(cleared, location), [bullet]);
}

/** Drops the status `value`, of a legacy form too, and leaves any other status as it is. */
export function clearStatus(text: string, value: StatusValue): string {
  const ledger = parseLedger(text);
  return ledger.location.status?.value === value ? serializeLedger(withoutStatus(ledger)) : text;
}

/** Drops a parked status, of a legacy form too; a later `Parked:` line under ## Next step is a note and stays. */
export const unpark = (text: string): string => clearStatus(text, 'parked');

/** Adds a bullet at the end of ## Location; undefined when the ledger has no such section. */
export function addLocationBullet(text: string, bullet: string): string | undefined {
  const ledger = parseLedger(text);
  const location = findSection(ledger.sections, 'Location');
  return location && insert(ledger, afterLastText(ledger, location), [bullet]);
}

const claimLines = (ledger: Ledger, location: Section | undefined): number[] =>
  location === undefined ? [] : ledger.lines.flatMap((line, index) => (index > location.start && index < location.end && plain(line).startsWith('- claim:') ? [index] : []));

/** `- claim: <claim>` in place of every claim bullet under ## Location, or at its end; undefined without the section. */
export function withClaim(text: string, claim: Claim): string | undefined {
  const ledger = parseLedger(text);
  const location = findSection(ledger.sections, 'Location');
  if (location === undefined) return undefined;
  const [first, ...more] = claimLines(ledger, location);
  const bullet = `- claim: ${claimText(claim)}`;
  if (first === undefined) return insert(ledger, afterLastText(ledger, location), [bullet]);
  const lines = [...ledger.lines];
  lines[first] = replaced(lines[first], bullet);
  return lines.filter((_, index) => !more.includes(index)).join('\n');
}

/** Drops every claim bullet under ## Location, whatever session it names and whether it reads as a claim. */
export function withoutClaim(text: string): string {
  const ledger = parseLedger(text);
  const claims = claimLines(ledger, findSection(ledger.sections, 'Location'));
  return claims.length === 0 ? text : without(ledger, (index) => claims.includes(index));
}

/**
 * `text` with the `- <name>:` bullet of ## Location set to `value`: in place of the first such bullet, else at the end
 * of the section; undefined `value` drops each such bullet. Undefined when the ledger has no ## Location.
 */
export function setLocationBullet(text: string, name: string, value: string | undefined): string | undefined {
  const ledger = parseLedger(text);
  const location = findSection(ledger.sections, 'Location');
  if (location === undefined) return undefined;
  const named = ledger.lines.flatMap((line, index) => (index > location.start && index < location.end && plain(line).trim().startsWith(`- ${name}:`) ? [index] : []));
  if (value === undefined) return without(ledger, (index) => named.includes(index));
  if (named.length === 0) return insert(ledger, afterLastText(ledger, location), [`- ${name}: ${value}`]);
  const lines = [...ledger.lines];
  lines[named[0]] = replaced(lines[named[0]], `- ${name}: ${value}`);
  return lines.join('\n');
}

/**
 * `text` with its lost mark set to `lost`, for the worktree it records, or dropped for undefined: only the `- lost:`
 * line lostMark reads is the mark, so every other one, a person's note, stays as it is. Undefined without ## Location.
 */
export function setLostMark(text: string, lost: Lost | undefined): string | undefined {
  const ledger = parseLedger(text);
  const location = findSection(ledger.sections, 'Location');
  if (location === undefined) return undefined;
  const { worktree } = ledger.location;
  const isMark = (line: string, index: number): boolean => index > location.start && index < location.end && lostMark(plain(line), worktree) !== undefined;
  const [first, ...more] = ledger.lines.flatMap((line, index) => (isMark(line, index) ? [index] : []));
  if (lost === undefined) return first === undefined ? text : without(ledger, (index) => index === first || more.includes(index));
  const bullet = `${LOST_BULLET}${lostText(lost, worktree)}`;
  if (first === undefined) return insert(ledger, afterLastText(ledger, location), [bullet]);
  const lines = [...ledger.lines];
  lines[first] = replaced(lines[first], bullet);
  return lines.filter((_, index) => !more.includes(index)).join('\n');
}

/** `text` with the lines of `children` in the order given, in the places those lines take now; every other line stays. */
export function placeChildren(text: string, children: readonly Child[]): string {
  const ledger = parseLedger(text);
  const places = children.map(({ line }) => line).sort((a, b) => a - b);
  const lines = [...ledger.lines];
  children.forEach((child, index) => {
    lines[places[index]] = ledger.lines[child.line];
  });
  return lines.join('\n');
}

export function removeLine(text: string, index: number): string {
  return without(parseLedger(text), (at) => at === index);
}

/** Adds a child line at the end of ## Children; a new section goes right after ## Location. */
export function addChild(text: string, line: string): string {
  const ledger = parseLedger(text);
  const children = findSection(ledger.sections, 'Children');
  if (children) return insert(ledger, afterLastText(ledger, children), [line]);
  const location = findSection(ledger.sections, 'Location');
  return location ? insert(ledger, afterLastText(ledger, location), ['', '## Children', line]) : appendTo(ledger, 'Children', [line]);
}

/** Drops the child lines at `indexes`, and ## Children with them when no text is left in it. */
export function removeChildren(text: string, indexes: readonly number[]): string {
  const ledger = parseLedger(without(parseLedger(text), (index) => indexes.includes(index)));
  const children = findSection(ledger.sections, 'Children');
  if (children === undefined || afterLastText(ledger, children) > children.start + 1) return serializeLedger(ledger);
  return without(ledger, (index) => index >= children.start && index < children.end);
}

/** The child's line with `suffix` in place of the text after its slug and main. */
function withSuffix(text: string, child: Child, suffix: string): string {
  const ledger = parseLedger(text);
  const line = ledger.lines[child.line];
  const [, indent, body] = /^(\s*)(.*)$/.exec(plain(line)) ?? ['', '', ''];
  const named = body.slice(0, body.length - child.suffix.length).trimEnd();
  const lines = [...ledger.lines];
  lines[child.line] = replaced(line, `${indent}${named} ${suffix}`);
  return lines.join('\n');
}

/** The child's line as `- <slug> @ <main>`, its suffix as it was. */
export function withChildMain(text: string, child: Child, main: string): string {
  const ledger = parseLedger(text);
  const line = ledger.lines[child.line];
  const [, indent] = /^(\s*)/.exec(plain(line)) ?? ['', ''];
  const lines = [...ledger.lines];
  lines[child.line] = replaced(line, `${indent}- ${child.slug} @ ${main}${child.suffix ? ` ${child.suffix}` : ''}`);
  return lines.join('\n');
}

const markedBefore = (mark: string, child: Child): string => `(${mark})${child.suffix ? ` ${child.suffix}` : ''}`;

/** `- <slug> (started <date>)`; a hand-written suffix stays after the mark, as it was. */
export const markStarted = (text: string, child: Child, date: string): string => withSuffix(text, child, markedBefore(`started ${date}`, child));

/** `- <slug> (retired <date>)`, in place of a started mark; `(started <date>; <note>)` keeps its note. */
export function markRetired(text: string, child: Child, date: string): string {
  const suffix = child.mark?.kind === 'started' ? child.suffix.replace(/^\(started \d{4}-\d\d-\d\d/, `(retired ${date}`) : markedBefore(`retired ${date}`, child);
  return withSuffix(text, child, suffix);
}

/** A copied line that starts with # would be a heading in the parent; one that starts with \# gets a \ too, so each reads back as written. */
const escapeHeading = (line: string): string => (/^\\*#/.test(line) ? `\\${line}` : line);

/**
 * Puts `### <heading>` and the report under ## Child reports, in place of the copy under the same heading, so a second
 * copy replaces the first. The section is added at the end of the file when there is none.
 */
export function putChildReport(text: string, heading: string, report: readonly string[]): string {
  const ledger = parseLedger(text);
  const copied = [`### ${heading}`, ...report.map(escapeHeading)];
  const section = findSection(ledger.sections, 'Child reports');
  const inSection = (index: number): boolean => section !== undefined && index > section.start && index < section.end;
  const start = ledger.lines.findIndex((line, index) => inSection(index) && plain(line).trim() === copied[0]);
  if (start === -1) return appendTo(ledger, 'Child reports', ['', ...copied]);
  const next = ledger.lines.findIndex((line, index) => index > start && inSection(index) && plain(line).startsWith('### '));
  const end = afterLastText(ledger, { heading, start, end: next === -1 ? (section?.end ?? ledger.lines.length) : next });
  const cr = ending(ledger.lines);
  return [...ledger.lines.slice(0, start), ...copied.map((line) => line + cr), ...ledger.lines.slice(end)].join('\n');
}
