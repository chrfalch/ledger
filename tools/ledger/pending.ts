import { migrateActive } from './migrate-active.js';
import { migrateRecords } from './migrate-records.js';
import { migrateRepoIds } from './migrate-repo-ids.js';
import type { LedgerStore } from './store.js';

/**
 * The one-time moves of `ledger store migrate`, in the order they run: --active checks a slug against the aliases
 * --repo-ids records, and --records converts only backlog and archive ledgers, which neither other move writes as Markdown.
 */
export const MOVE_KINDS = ['repo-ids', 'active', 'records'] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];

/**
 * One task, evidence folder or alias a move takes `from` → `to`; `auto` is false for one it leaves, with the `reason`.
 * `accepted` marks one it leaves that needs no person: a finished task whose repo is gone or unknown, `from` being
 * `archive <folder name>/<name>` or `evidence <folder name>/<name>`.
 */
export type Move = { kind: MoveKind; from: string; to: string; auto: boolean; reason?: string; accepted?: true };
export type OnMove = (move: Move) => void;

const HEADINGS: Record<MoveKind, string> = {
  'repo-ids': 'Repo keys from folder names to repo addresses (--repo-ids)',
  active: 'Ledgers in .claude/ledger.md into active records (--active)',
  records: 'Markdown ledgers into task records (--records)',
};

/** What each move would do now, by its own dry run. `store` is undefined for a database that is not there. */
export function pendingMoves(store: LedgerStore | undefined, { cwd, home }: { cwd: string; home: string }): Move[] {
  const moves: Move[] = [];
  const add = (move: Move): void => void moves.push(move);
  const quiet = (): void => {};
  migrateRepoIds(store, { dryRun: true, home }, quiet, add);
  migrateActive(store, { dryRun: true, cwd, home }, quiet, add);
  migrateRecords(store, { dryRun: true }, quiet, add);
  return moves;
}

// printLeftovers in tools/deploy.ts prints the same three texts, as deploy cannot import this module; keep them in step.
const needsPersonText = (count: number): string => (count === 1 ? '1 task needs a person to move it:' : `${count} tasks need a person to move them:`);

const acceptedText = (count: number): string =>
  count === 1
    ? '1 finished task stays under its old repo folder name, as that folder is gone or unknown. Nothing to do: it stays readable in the archive.'
    : `${count} finished tasks stay under their old repo folder name, as that folder is gone or unknown. Nothing to do: they stay readable in the archive.`;

/** An accepted move's task: its `from` without the place it starts with, `archive` or `evidence`, which means nothing to a reader. */
const acceptedName = ({ from }: Move): string => from.slice(from.indexOf(' ') + 1);

export function pendingText(moves: Move[]): string {
  if (moves.length === 0) return 'Nothing to move.';
  const stuck = moves.filter(({ auto, accepted }) => !auto && !accepted);
  const accepted = moves.filter((move) => move.accepted);
  return [
    ...MOVE_KINDS.flatMap((kind) => {
      const ofKind = moves.filter((move) => move.auto && move.kind === kind);
      return ofKind.length === 0 ? [] : [`${HEADINGS[kind]}:`, ...ofKind.map(({ from, to }) => `  ${from} → ${to}`)];
    }),
    ...(stuck.length === 0 ? [] : [needsPersonText(stuck.length), ...stuck.map(({ from, reason }) => `  ${from} stays: ${reason}`)]),
    ...(accepted.length === 0 ? [] : [acceptedText(accepted.length), ...accepted.map((move) => `  ${acceptedName(move)}: ${move.reason}`)]),
  ].join('\n');
}
