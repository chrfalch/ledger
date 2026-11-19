import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './cli.js';

const TYPES = ['explainer', 'plan', 'guide', 'decision', 'issue', 'request', 'rfc'];
const SCANNED_EXTENSIONS = new Set(['.ts', '.js', '.sh', '.md', '.json', '.toml']);
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.claude']);

const DOC_NAME = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.([a-z]+)\.md$/;
const TITLE = /^# LLP (\d{4}): \S/;
const REF = /@ref\s+LLP\s+(\d{4})(?:#([\w.-]+))?/g;
const LINK = /!?\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g;

interface Doc {
  file: string;
  lines: string[];
  number?: string;
  type?: string;
  anchors: Set<string>;
}

/** Problems in the LLP corpus under `root` and in the `@ref LLP` comments that point into it; empty means valid. */
export function checkLlp(root: string): string[] {
  const docs = readDocs(root);
  const byNumber = new Map<string, Doc>();
  for (const doc of docs) {
    if (doc.number !== undefined && !byNumber.has(doc.number)) byNumber.set(doc.number, doc);
  }
  const problems = docs.flatMap((doc) => checkDoc(root, doc, byNumber));

  for (const file of scannedFiles(root)) {
    readFileSync(path.join(root, file), 'utf8').split('\n').forEach((line, index) => {
      for (const [, number, anchor] of line.matchAll(REF)) {
        const target = byNumber.get(number);
        const at = `${file}:${index + 1}`;
        if (!target) problems.push(`${at}: @ref names missing LLP ${number}`);
        else if (anchor !== undefined && !target.anchors.has(anchor)) problems.push(`${at}: @ref anchor #${anchor} is not a heading in ${target.file}`);
      }
    });
  }
  return problems;
}

/** Changed files that reference LLP 0000 while LLP 0000 itself is unchanged; `changed` holds repo-relative paths. */
export function llp0000Warnings(root: string, changed: string[]): string[] {
  const architecture = readDocs(root).find((doc) => doc.number === '0000');
  if (!architecture || changed.includes(architecture.file)) return [];
  return changed
    .filter((file) => !file.startsWith('llp/0000-') && SCANNED_EXTENSIONS.has(path.extname(file)))
    .filter((file) => statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile())
    .filter((file) =>
      readFileSync(path.join(root, file), 'utf8')
        .split('\n')
        .some((line) => [...line.matchAll(REF)].some(([, number]) => number === '0000')),
    )
    .map((file) => `${file}: references LLP 0000, but this branch does not change ${architecture.file}`);
}

function readDocs(root: string): Doc[] {
  const dir = path.join(root, 'llp');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d{4}-.*\.md$/.test(name))
    .sort()
    .map((name) => {
      const lines = readFileSync(path.join(dir, name), 'utf8').split('\n');
      const [, number, type] = DOC_NAME.exec(name) ?? [];
      return { file: `llp/${name}`, lines, number, type, anchors: anchors(lines) };
    });
}

function checkDoc(root: string, doc: Doc, byNumber: Map<string, Doc>): string[] {
  const { file, number, type } = doc;
  if (number === undefined || type === undefined) return [`${file}: file name is not NNNN-<slug>.<type>.md`];
  if (!TYPES.includes(type)) return [`${file}: type "${type}" is not one of ${TYPES.join(', ')}`];
  const owner = byNumber.get(number);
  if (owner !== doc) return [`${file}: number ${number} is already used by ${owner?.file}`];

  const problems: string[] = [];
  const title = doc.lines.find((line) => line.startsWith('# '));
  const titleNumber = title && TITLE.exec(title)?.[1];
  if (!titleNumber) problems.push(`${file}: missing "# LLP ${number}: <title>" heading`);
  else if (titleNumber !== number) problems.push(`${file}: heading number ${titleNumber} does not match the file name number ${number}`);

  const header = headerFields(doc.lines);
  for (const field of ['Type', 'Status', 'Date']) {
    if (!header.has(field)) problems.push(`${file}: missing **${field}:** line`);
  }
  const declaredType = header.get('Type');
  if (declaredType && declaredType.toLowerCase() !== type) problems.push(`${file}: **Type:** ${declaredType} does not match the file name type "${type}"`);
  const date = header.get('Date');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push(`${file}: **Date:** ${date} is not YYYY-MM-DD`);
  for (const [, related] of (header.get('Related') ?? '').matchAll(/LLP (\d{4})/g)) {
    if (!byNumber.has(related)) problems.push(`${file}: **Related:** names missing LLP ${related}`);
  }

  for (const [index, line] of proseLines(doc.lines)) {
    for (const [, target] of line.replace(/`[^`]*`/g, '').matchAll(LINK)) {
      if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) continue;
      const relative = target.replace(/[#?].*$/, '');
      if (!existsSync(path.resolve(root, 'llp', relative))) problems.push(`${file}:${index + 1}: link to missing file ${relative}`);
    }
  }
  return problems;
}

/** The `**Name:** value` lines above the first `##` section. */
function headerFields(lines: string[]): Map<string, string> {
  const end = lines.findIndex((line) => line.startsWith('## '));
  const fields = new Map<string, string>();
  for (const line of lines.slice(0, end === -1 ? undefined : end)) {
    const match = /^\*\*(\w+):\*\*\s*(.*?)\s*$/.exec(line);
    if (match) fields.set(match[1], match[2]);
  }
  return fields;
}

function* proseLines(lines: string[]): Generator<[number, string]> {
  let fenced = false;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) yield [index, line];
  }
}

/** Heading anchors as GitHub renders them, with `-1`, `-2` suffixes for repeats. */
function anchors(lines: string[]): Set<string> {
  const result = new Set<string>();
  const seen = new Map<string, number>();
  for (const [, line] of proseLines(lines)) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const slug = heading
      .replace(/<[^>]+>/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    result.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return result;
}

function scannedFiles(root: string, dir = ''): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((entry) => {
      const file = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : scannedFiles(root, file);
      return entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name)) ? [file] : [];
    });
}

function changedFiles(root: string): string[] {
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  try {
    const base = git('merge-base', 'HEAD', 'origin/main').trim();
    const tracked = git('diff', '-z', '--name-only', base);
    const untracked = git('ls-files', '-z', '--others', '--exclude-standard');
    return `${tracked}${untracked}`.split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

if (isMain(import.meta.url)) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const problems = checkLlp(root);
  for (const problem of problems) console.error(problem);
  for (const warning of llp0000Warnings(root, changedFiles(root))) console.error(`warning: ${warning}`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
