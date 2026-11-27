import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Git fixtures are built once per test process, in this folder, and copied into each test (LLP 0002). It is removed
 * when the process exits.
 */
let folder: string | undefined;
export function processFolder(): string {
  if (folder === undefined) {
    const made = realpathSync(mkdtempSync(path.join(tmpdir(), 'ledger-git-fixtures-')));
    process.once('exit', () => rmSync(made, { recursive: true, force: true }));
    folder = made;
  }
  return folder;
}

/** A directory has neither data nor link. */
type Entry = { mode: number; data?: Buffer; link?: string };
type Tree = Map<string, Entry>;

function tree(root: string): Tree {
  const entries: Tree = new Map();
  const visit = (relative: string): void => {
    const full = path.join(root, relative);
    const stat = lstatSync(full);
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) entries.set(relative, { mode, link: readlinkSync(full) });
    else if (stat.isDirectory()) {
      if (relative !== '') entries.set(relative, { mode });
      for (const name of readdirSync(full)) visit(path.join(relative, name));
    } else entries.set(relative, { mode, data: readFileSync(full) });
  };
  visit('');
  return entries;
}

/** Placeholders hold a NUL byte, so no file a fixture builds holds one by chance. */
const PLACEHOLDERS = ['\0LEDGER-FIXTURE-HOME\0', '\0LEDGER-FIXTURE-REMOTE-HOME\0'] as const;

function replaced(data: Buffer, from: string, to: string): Buffer {
  const needle = Buffer.from(from);
  const parts: Buffer[] = [];
  let start = 0;
  for (let at = data.indexOf(needle); at !== -1; at = data.indexOf(needle, start)) {
    parts.push(data.subarray(start, at), Buffer.from(to));
    start = at + needle.length;
  }
  return parts.length === 0 ? data : Buffer.concat([...parts, data.subarray(start)]);
}

const withPlaceholders = (data: Buffer, roots: readonly string[]): Buffer => roots.reduce((text, root, index) => replaced(text, root, PLACEHOLDERS[index]), data);
const withRoots = (data: Buffer, roots: readonly string[]): Buffer => roots.reduce((text, root, index) => replaced(text, PLACEHOLDERS[index], root), data);

/** A change to one root: the entry to write, or null to remove the path. Data holds placeholders for the roots. */
type Change = [string, Entry | null];

/** What a step changed under each root, given as placeholders; undefined when it cannot be copied safely. */
type Recorded = Change[][] | undefined;

/**
 * Whether `data` of a file under the roots names a root in a way a copy cannot rewrite: in a binary file, where its
 * length may count, or in any form other than the full path, such as only its folder name.
 */
function namesRootUnsafely(data: Buffer, roots: readonly string[]): boolean {
  const binary = data.includes(0);
  return roots.some((root) => (binary && data.includes(root)) || withPlaceholders(data, roots).includes(path.basename(root)));
}

function changes(before: Tree, after: Tree, roots: readonly string[]): Change[] | undefined {
  const changed: Change[] = [];
  for (const [relative, entry] of after) {
    const old = before.get(relative);
    if (entry.data !== undefined && namesRootUnsafely(entry.data, roots)) return undefined;
    if (entry.link !== undefined && roots.some((root) => entry.link?.includes(path.basename(root)))) return undefined;
    const same = old !== undefined && old.mode === entry.mode && old.link === entry.link && (old.data === undefined ? entry.data === undefined : entry.data !== undefined && old.data.equals(entry.data));
    if (!same) changed.push([relative, entry.data === undefined ? entry : { ...entry, data: withPlaceholders(entry.data, roots) }]);
  }
  for (const relative of before.keys()) if (!after.has(relative)) changed.push([relative, null]);
  return changed;
}

function apply(root: string, changed: Change[], roots: readonly string[]): void {
  const removals = changed.filter(([, entry]) => entry === null).map(([relative]) => relative);
  for (const relative of removals.sort().reverse()) rmSync(path.join(root, relative), { recursive: true, force: true });
  const writes = changed.flatMap(([relative, entry]) => (entry === null ? [] : [[relative, entry] as const]));
  for (const [relative, entry] of writes.sort(([a], [b]) => (a < b ? -1 : 1))) {
    const full = path.join(root, relative);
    if (entry.data === undefined && entry.link === undefined) {
      mkdirSync(full, { recursive: true });
      chmodSync(full, entry.mode);
      continue;
    }
    rmSync(full, { force: true });
    if (entry.link !== undefined) symlinkSync(entry.link, full);
    else {
      writeFileSync(full, withRoots(entry.data ?? Buffer.alloc(0), roots));
      chmodSync(full, entry.mode);
    }
  }
}

function fingerprint(step: string, trees: Tree[], roots: readonly string[]): string {
  const hash = createHash('sha256').update(step).update('\0');
  const environment = Object.entries(process.env).sort(([a], [b]) => (a < b ? -1 : 1));
  hash.update(JSON.stringify(environment));
  trees.forEach((entries, index) => {
    hash.update(`\0root ${index}\0`);
    for (const relative of [...entries.keys()].sort()) {
      const { mode, data, link } = entries.get(relative) as Entry;
      hash.update(`${relative}\0${mode}\0${link ?? ''}\0${data === undefined ? 'dir' : 'file'}\0`);
      if (data !== undefined) hash.update(withPlaceholders(data, roots));
    }
  });
  return hash.digest('hex');
}

const recorded = new Map<string, Recorded>();

const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}${path.sep}`);

export type Replay = { copied: true } | { copied: false; record: () => void };

/**
 * For a step named `name` that changes only files under `roots`: when it ran before in this process on the same files
 * under other roots, with the same environment, writes what it changed then, with each root's path rewritten, and
 * gives copied. Otherwise the caller runs the step, then calls `record`, so the next run of it on such files is a copy.
 * File times are not compared, so a step whose result depends on them must not be replayed. LEDGER_TEST_REAL_INIT=1
 * turns copying off, to check that a suite passes the same way with every step run for real.
 */
export function replay(name: string, roots: readonly string[]): Replay {
  const unrecorded: Replay = { copied: false, record: () => {} };
  if (process.env.LEDGER_TEST_REAL_INIT === '1') return unrecorded;
  if (roots.some((root, index) => roots.some((other, at) => at !== index && inside(root, other)))) return unrecorded;
  const before = roots.map(tree);
  const key = fingerprint(name, before, roots);
  if (recorded.has(key)) {
    const known = recorded.get(key);
    if (known === undefined) return unrecorded;
    roots.forEach((root, index) => apply(root, known[index], roots));
    return { copied: true };
  }
  return {
    copied: false,
    record: () => {
      const changed = roots.map((root, index) => changes(before[index], tree(root), roots));
      recorded.set(key, changed.every((list) => list !== undefined) ? (changed as Change[][]) : undefined);
    },
  };
}
