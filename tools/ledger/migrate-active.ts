import { rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fail, Failure } from './failure.js';
import { readTimedText } from './files.js';
import { parseLedger } from './format.js';
import { mainCheckout, worktrees } from './git.js';
import { notedLines } from './migrate-records.js';
import { realPath, samePath } from './paths.js';
import { recordToWrite, renderRecord } from './record.js';
import { parseRegistry } from './registry.js';
import { repoKey, repoLabel } from './repo-key.js';
import { keyAndAliases, type LedgerStore } from './store.js';
import { plural } from './views.js';

const LEGACY_LEDGER = path.join('.claude', 'ledger.md');

/** A ledger from before active records: the .claude/ledger.md of the worktree `folder`, in the repo at `main` when one is known. */
type LegacyLedger = { file: string; folder: string; main?: string };

const isFile = (file: string): boolean => statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;

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
    const main = mainCheckout(folder) ?? entry.main;
    if (main === undefined || !samePath(folder, main)) add(folder, main);
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

function moveLedger(store: LedgerStore | undefined, { file, folder, main }: LegacyLedger, dryRun: boolean): Outcome {
  if (main === undefined) return { left: 'it is in no git repository, so no repo can keep its task.' };
  const found = readTimedText(file, { followLinks: true });
  if (found === undefined) return { left: 'it cannot be read.' };
  const slug = parseLedger(found.text).slug;
  if (slug === undefined) return { left: 'its heading names no task slug. Make its first line "# Task ledger — <slug>", then run this again.' };
  const repo = repoKey(main);
  const taken = store === undefined ? undefined : takenReason(store, repo, slug, folder);
  if (taken !== undefined) return { left: `${taken} Keep one of the two: merge them by hand and remove the other, then run this again.` };
  const text = renderRecord({ ...recordToWrite(found.text, file), worktree: folder, ...(store?.host === undefined ? {} : { host: store.host }) });
  const moved = `${repoLabel(repo)} ${slug}: ${plural(notedLines(found.text), 'line')} to general notes`;
  if (dryRun || store === undefined) return { moved };
  if (!store.active.create(repo, slug, text)) return { left: `another command made the active task ${slug} while this one ran.` };
  store.active.setModified?.(repo, slug, found.mtimeMs);
  if (store.active.read(repo, slug)?.text !== text) {
    fail(`The active record ${store.active.location(repo, slug)} does not read back as ${file} converts, so ${file} was kept. Compare the two by hand.`);
  }
  rmSync(file);
  return { moved };
}

/**
 * Moves each .claude/ledger.md of a linked worktree into an active record for that worktree, converted as
 * `migrateRecords` converts a Markdown ledger, then deletes the file; .claude/evidence/ stays. A second run finds none
 * left. A ledger whose slug or worktree is taken stays as it is, for a person to merge. `store` is undefined for a
 * database that is not there. Prints one line per ledger to `line` and returns how many it left, which a dry run counts
 * the same. A ledger whose record would not read back the same stops it with a Failure, a dry run too.
 */
export function migrateActive(store: LedgerStore | undefined, { dryRun, cwd }: { dryRun: boolean; cwd: string }, line: (text: string) => void): number {
  line(`Move the .claude/ledger.md of each linked worktree into an active record${dryRun ? ' · dry run, nothing changed' : ''}`);
  let moved = 0;
  let left = 0;
  for (const ledger of legacyLedgers(store, cwd)) {
    const outcome = moveLedger(store, ledger, dryRun);
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
