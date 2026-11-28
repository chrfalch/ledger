// @ref LLP 0001#55-labels — D53: label colours are store-wide, so a label looks the same in every listing and on every machine.
import { fail } from './failure.js';

const LABEL = /^[a-z0-9][a-z0-9._-]*$/;
const LABEL_MAX = 40;

export const isLabel = (text: string): boolean => text.length <= LABEL_MAX && LABEL.test(text);

/** `given` as labels: trimmed, lowercased and without repeats, in the order given. A Failure names the first that is no label. */
export function labelsOf(given: readonly string[]): string[] {
  const labels = given.map((raw) => {
    const label = raw.trim().toLowerCase();
    return isLabel(label)
      ? label
      : fail(`"${raw}" is no label. A label is 1 to ${LABEL_MAX} lowercase letters, digits, dots, underscores and hyphens, and starts with a letter or digit.`);
  });
  return [...new Set(labels)];
}

export const hasLabels = (labels: readonly string[] | undefined, wanted: readonly string[]): boolean => wanted.every((label) => labels?.includes(label) ?? false);

// Never 🟩, 🟥 or 🟨: those mark results in the operator's conversation.
type Square = '🟦' | '🟪' | '🟧' | '🟫' | '⬜' | '⬛';
export type PaletteColour = { hex: string; ansi256: number; square: Square };

export const PALETTE: readonly PaletteColour[] = [
  { hex: '#4a90d9', ansi256: 68, square: '🟦' },
  { hex: '#9b6bd6', ansi256: 98, square: '🟪' },
  { hex: '#e8893a', ansi256: 208, square: '🟧' },
  { hex: '#a9774d', ansi256: 137, square: '🟫' },
  { hex: '#c8cdd2', ansi256: 252, square: '⬜' },
  { hex: '#6c7a89', ansi256: 66, square: '⬛' },
  { hex: '#3fb8c9', ansi256: 74, square: '🟦' },
  { hex: '#d96bb0', ansi256: 169, square: '🟪' },
  { hex: '#f0b04a', ansi256: 215, square: '🟧' },
  { hex: '#c9a27e', ansi256: 180, square: '🟫' },
];

/** A label's entry in the registry: its place in the palette, and when a task first got it, as toISOString writes it. */
export type LabelColour = { colour: number; firstUsed: string };
export type LabelRegistry = ReadonlyMap<string, LabelColour>;

const isColour = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < PALETTE.length;
const isTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

/** `value` as a registry entry; undefined for anything else, which a reader skips. */
export function asLabelColour(value: unknown): LabelColour | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { colour, firstUsed } = value as Record<string, unknown>;
  return isColour(colour) && isTime(firstUsed) ? { colour, firstUsed } : undefined;
}

/** The registry entry a file holds as `text`; undefined for a file that holds none. */
export function parseLabelColour(text: string): LabelColour | undefined {
  try {
    return asLabelColour(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export const labelColourJson = ({ colour, firstUsed }: LabelColour): string => `${JSON.stringify({ colour, firstUsed }, null, 2)}\n`;

/**
 * The entries to add to `registry` for each of `labels` it lacks, first used at `firstUsed`: each gets the palette colour
 * the fewest labels have, the lowest index on a tie, counting the ones added before it.
 */
export function newLabelColours(registry: LabelRegistry, labels: readonly string[], firstUsed: string): [string, LabelColour][] {
  const uses = PALETTE.map(() => 0);
  for (const { colour } of registry.values()) uses[colour]++;
  return labels.flatMap((label): [string, LabelColour][] => {
    if (registry.has(label)) return [];
    const colour = uses.indexOf(Math.min(...uses));
    uses[colour]++;
    return [[label, { colour, firstUsed }]];
  });
}

/** Of two entries of one label, as two machines that first used it at once wrote them: the earlier, the lower colour on a tie. */
export const earlier = (a: LabelColour, b: LabelColour): LabelColour => (a.firstUsed < b.firstUsed || (a.firstUsed === b.firstUsed && a.colour <= b.colour) ? a : b);

/** The colour a label's name gives it while the registry has no entry for it, as one a ledger of another machine brought. */
export function fallbackColour(label: string): number {
  // FNV-1a, so the colour is the same in every process and on every machine.
  let hash = 0x811c9dc5;
  for (let index = 0; index < label.length; index++) hash = Math.imul(hash ^ label.charCodeAt(index), 0x01000193);
  return (hash >>> 0) % PALETTE.length;
}

const colourOf = (registry: LabelRegistry, label: string): PaletteColour => PALETTE[registry.get(label)?.colour ?? fallbackColour(label)];

/** How labels are shown: as escape codes of 256 colours or of true colour, for a terminal, or after the square of their colour. */
export type LabelStyle = 'ansi256' | 'truecolor' | 'square';

/** Colour for a terminal unless NO_COLOR is set, as no-color.org asks; true colour where COLORTERM says the terminal has it. */
export function labelStyle(tty: boolean, env: NodeJS.ProcessEnv): LabelStyle {
  if (!tty || env.NO_COLOR) return 'square';
  return env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit' ? 'truecolor' : 'ansi256';
}

const rgb = (hex: string): string => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(';');

/** A task's labels as the text after its name: '' for none. */
export type PaintLabels = (labels: readonly string[] | undefined) => string;

export function labelPainter(registry: LabelRegistry, style: LabelStyle): PaintLabels {
  const paint = (label: string): string => {
    const { hex, ansi256, square } = colourOf(registry, label);
    if (style === 'square') return `${square} ${label}`;
    return `\x1b[38;${style === 'truecolor' ? `2;${rgb(hex)}` : `5;${ansi256}`}m${label}\x1b[39m`;
  };
  return (labels) => (labels ?? []).map(paint).join(' ');
}

/** `name` followed by its labels, as a table cell shows a task. */
export const withLabels = (name: string, labels: readonly string[] | undefined, paint: PaintLabels): string => [name, paint(labels)].filter(Boolean).join(' ');

/** The colour of each of `labels`, for JSON: its square and its hex code. */
export const labelColours = (registry: LabelRegistry, labels: Iterable<string>): Record<string, { square: Square; hex: string }> =>
  Object.fromEntries([...new Set(labels)].sort().map((label) => {
    const { square, hex } = colourOf(registry, label);
    return [label, { square, hex }];
  }));
