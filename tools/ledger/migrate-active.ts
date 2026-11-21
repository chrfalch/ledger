import { rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fail, Failure } from './failure.js';
import { readTimedText } from './files.js';
import { parseLedger } from './format.js';
import { checkoutRoot, inMainCheckout, mainCheckout, worktrees } from './git.js';
import { withLock } from './lock.js';
import { notedLines } from './migrate-records.js';
import { realPath, samePath } from './paths.js';
import { recordToWrite, renderRecord } from './record.js';
import { parseRegistry } from './registry.js';
import { repoKey, repoLabel } from './repo-key.js';
import { noteOwnHost } from './settings.js';
import { keyAndAliases, readable, type LedgerStore } from './store.js';
import { plural } from './views.js';

const LEGACY_LEDGER = path.join('.claude', 'ledger.md');

/** A ledger from before active records: the .claude/ledger.md of `folder`, with the repo at `main` when `folder` is a linked worktree of it. */
type LegacyLedger = { file: string; folder: string; main?: string };

const isFile = (file: string): boolean => statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;

function isLinkedWorktree(folder: string): boolean {
  const root = checkoutRoot(folder);
  return root !== undefined && samePath(root, folder) && !inMainCheckout(folder);
}

/**
 * The .claude/ledger.md of each linked worktree of the main checkouts the registry names and of the repo of `cwd`, and
 * each one a registry entry names. A main checkout's own is never a task's ledger.
 */
function legacyLedgers(store: LedgerStore | undefined, cwd: string): LegacyLedger[] {
  const entries = parseRegistry(store?.registry.read() ?? '') ?? [];
  const mains = new Set(entries.flatMap(({ main }) => (typeof main === 'string' ? [main] : [])));
  const here = mainCheckout(cwd);
  if (here !== undefined) mains.add(here);
  const found = new Map<string, LegacyLedger>();
  const add = (folder: string, main: string | undefined): void => {
    const file = path.join(folder, LEGACY_LEDGER);
    if (isFile(file) && !found.has(realPath(file))) found.set(realPath(file), { file, folder, main });
  };
  for (const main of mains) for (const linked of worktrees(main).slice(1)) add(linked.path, main);
  for (const entry of entries) {
    if (!entry.path.endsWith(`${path.sep}${LEGACY_LEDGER}`)) continue;
    const folder = path.dirname(path.dirname(entry.path));
    const main = mainCheckout(folder);
    // The main the entry names is not trusted: the folder may have stopped being its worktree, and holds a plain file now.
    if (main === undefined || !samePath(folder, main)) add(folder, isLinkedWorktree(folder) ? main : undefined);
  }
  return [...found.values()];
}

/** Why the slug or the worktree of a ledger moving into `repo` is taken, by the one-name-per-repo rule of `ledger task new`. */
function takenReason(store: LedgerStore, repo: string, slug: string, folder: string): string | undefined {
  const repos = keyAndAliases(store.aliases.read(), repo);
  const active = repos.find((key) => store.active.has(key, slug));
  if (active !== undefined) return `the active task ${slug} exists already, at ${store.active.location(active, slug)}.`;
  let own: { repo: string; slug: string } | undefined;
  try {
    own = store.active.byWorktree(folder);
  } catch (error) {
    if (error instanceof Failure) return error.message;
    throw error;
  }
  if (own !== undefined) return `the active task ${own.slug} names this worktree already, at ${store.active.location(own.repo, own.slug)}.`;
  const backlog = repos.find((key) => store.backlog.has(key, slug));
  return backlog === undefined ? undefined : `a backlog task ${slug} exists already, at ${store.backlog.location(backlog, slug)}.`;
}

/** What became of one ledger: the task it moved to, with its lines to general notes, or why it stays. */
type Outcome = { moved: string } | { left: string };

type Run = { dryRun: boolean; home: string; reserved: Set<string> };

function moveLedger(store: LedgerStore | undefined, { file, folder, main }: LegacyLedger, { dryRun, home, reserved }: Run): Outcome {
  if (main === undefined) return { left: 'it is in no linked git worktree, so no repo can keep its task.' };
  const found = readTimedText(file, { followLinks: true });
  if (found === undefined) return { left: 'it cannot be read.' };
  const slug = parseLedger(found.text).slug;
  if (slug === undefined) return { left: 'its heading names no task slug. Make its first line "# Task ledger — <slug>", then run this again.' };
  const repo = repoKey(main);
  const text = renderRecord({ ...recordToWrite(found.text, file), worktree: folder, ...(store?.host === undefined ? {} : { host: store.host }) });
  // A run that stopped after it wrote the record left the file: this one finishes the move.
  const writtenBefore = store !== undefined && readable(() => store.active.read(repo, slug))?.text === text;
  const name = `${repo}\n${slug}`;
  const taken = writtenBefore ? undefined : ((store && takenReason(store, repo, slug, folder)) ?? (reserved.has(name) ? `another ledger this run moves takes the slug ${slug} first.` : undefined));
  if (taken !== undefined) return { left: `${taken} Keep one of the two: merge them by hand and remove the other, then run this again.` };
  reserved.add(name);
  const moved = `${repoLabel(repo)} ${slug}: ${plural(notedLines(found.text), 'line')} to general notes`;
  if (dryRun || store === undefined) return { moved };
  const location = store.active.location(repo, slug);
  if (!writtenBefore) {
    if (!store.active.create(repo, slug, text)) return { left: `another command made the active task ${slug} while this one ran.` };
    if (store.host !== undefined) noteOwnHost(home, store.host);
    store.active.setModified?.(repo, slug, found.mtimeMs);
    if (store.active.read(repo, slug)?.text !== text) fail(`The active record ${location} does not read back as ${file} converts, so ${file} was kept. Compare the two by hand.`);
  }
  try {
    store.commit?.([{ place: 'active', repo, name: slug, text }]);
  } catch (error) {
    return { left: `its active record ${location} is written, but the store could not commit it: ${error instanceof Error ? error.message : String(error)} The file was kept. Run this again.` };
  }
  // Under the lock an older ledger writes the file with, so no write of it lands between the check and the delete.
  let unchanged: boolean;
  try {
    unchanged = withLock(file, () => {
      if (readTimedText(file, { followLinks: true })?.text !== found.text) return false;
      rmSync(file);
      return true;
    });
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    return { left: `its active record ${location} is written, and the file was kept: ${error.message}` };
  }
  if (!unchanged) {
    return { left: `it changed after its active record ${location} was written, so it was kept. Merge the two by hand and remove the other, then run this again.` };
  }
  return { moved };
}

/**
 * Moves each .claude/ledger.md of a linked worktree into an active record for that worktree, converted as
 * `migrateRecords` converts a Markdown ledger, then deletes the file once the store has committed the record and the
 * file is still what was moved; .claude/evidence/ stays. A second run finds none left, and one after a run that stopped
 * between the record and the delete finishes the move. A ledger whose slug or worktree is taken stays as it is, for a
 * person to merge. `store` is undefined for a database that is not there. Prints one line per ledger to `line` and
 * returns how many it left, which a dry run counts the same. A ledger whose record would not read back the same stops it
 * with a Failure, a dry run too.
 */
export function migrateActive(store: LedgerStore | undefined, { dryRun, cwd, home }: { dryRun: boolean; cwd: string; home: string }, line: (text: string) => void): number {
  line(`Move the .claude/ledger.md of each linked worktree into an active record${dryRun ? ' · dry run, nothing changed' : ''}`);
  let moved = 0;
  let left = 0;
  const run: Run = { dryRun, home, reserved: new Set() };
  for (const ledger of legacyLedgers(store, cwd)) {
    const outcome = moveLedger(store, ledger, run);
    if ('left' in outcome) {
      line(`left ${ledger.file}: ${outcome.left}`);
      left++;
    } else {
      line(`${dryRun ? 'would move' : 'moved'} ${ledger.file} to active ${outcome.moved}`);
      moved++;
    }
  }
  line(`${dryRun ? 'Would move' : 'Moved'} ${plural(moved, 'ledger')}.`);
  if (left > 0) line(`Left ${plural(left, 'ledger')} in .claude/ledger.md; nothing of them changed.`);
  return left;
}
