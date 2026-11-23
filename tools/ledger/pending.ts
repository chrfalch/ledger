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

/** One task, evidence folder or alias a move takes `from` → `to`; `auto` is false for one it leaves, with the `reason`. */
export type Move = { kind: MoveKind; from: string; to: string; auto: boolean; reason?: string };
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
  migrateRepoIds(store, { dryRun: true }, quiet, add);
  migrateActive(store, { dryRun: true, cwd, home }, quiet, add);
  migrateRecords(store, { dryRun: true }, quiet, add);
  return moves;
}

export function pendingText(moves: Move[]): string {
  if (moves.length === 0) return 'Nothing to move.';
  return MOVE_KINDS.flatMap((kind) => {
    const ofKind = moves.filter((move) => move.kind === kind);
    return ofKind.length === 0 ? [] : [`${HEADINGS[kind]}:`, ...ofKind.map(({ from, to, auto, reason }) => `  ${auto ? `${from} → ${to}` : `${from} stays: ${reason}`}`)];
  }).join('\n');
}
