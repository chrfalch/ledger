import { findSection, isPlaceholder, parseLedger, plainLine as plain, serializeLedger, type Child, type Ledger, type Section } from './format.js';

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
};

const PLACEHOLDER_TITLE = /^# Task ledger[ \t]*[—-][ \t]*<.*>$/;
const LOCATION_BULLET = /^- (main|worktree|branch|base|design refs):/;

/** Fills the template, or a backlog ledger on its way into a worktree. A given field replaces its bullet's value. */
export function fillLedger(text: string, fields: Filled): string {
  const ledger = parseLedger(text);
  const goal = findSection(ledger.sections, 'Goal');
  const location = findSection(ledger.sections, 'Location');
  const inSection = (section: Section | undefined, index: number): boolean => section !== undefined && index > section.start && index < section.end;
  const goalLine = ledger.lines.findIndex((line, index) => inSection(goal, index) && isPlaceholder(plain(line).trim()));
  const titleLine = ledger.lines.findIndex((line) => PLACEHOLDER_TITLE.test(plain(line)));
  const values: Record<string, string | null | undefined> = { main: null, worktree: fields.worktree, branch: fields.branch, base: fields.base, 'design refs': fields.designRefs };
  const cr = ending(ledger.lines);
  return ledger.lines
    .flatMap((line, index) => {
      if (index === titleLine) return [replaced(line, `# Task ledger — ${fields.slug}`)];
      if (index === goalLine && fields.goal) return [replaced(line, fields.goal)];
      const [, name] = inSection(location, index) ? (LOCATION_BULLET.exec(plain(line)) ?? []) : [];
      const value = name === undefined ? undefined : values[name];
      const kept = value === undefined ? [line] : value === null ? [] : [replaced(line, `- ${name}: ${value}`)];
      return index === location?.start && fields.main !== undefined ? [...kept, `- main: ${fields.main}${cr}`] : kept;
    })
    .join('\n');
}

export const addDecision = (text: string, line: string): string => appendTo(parseLedger(text), 'Decisions', [line]);

/** Puts `marker` first under ## Next step, in place of the marker there, and adds the section when there is none. */
export function park(text: string, marker: string): string {
  const unparked = parseLedger(unpark(text));
  const next = findSection(unparked.sections, 'Next step');
  return next ? insert(unparked, next.start + 1, [marker]) : appendTo(unparked, 'Next step', [marker]);
}

/** Drops the marker, the first text under ## Next step; a later `Parked:` line is a note and stays. */
export function unpark(text: string): string {
  const ledger = parseLedger(text);
  const marker = ledger.parked?.line;
  return marker === undefined ? text : without(ledger, (index) => index === marker);
}

/** Adds a bullet at the end of ## Location; undefined when the ledger has no such section. */
export function addLocationBullet(text: string, bullet: string): string | undefined {
  const ledger = parseLedger(text);
  const location = findSection(ledger.sections, 'Location');
  return location && insert(ledger, afterLastText(ledger, location), [bullet]);
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
