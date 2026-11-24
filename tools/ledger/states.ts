// @ref LLP 0001#51-states — the moves between the states inside active; backlog and retired are where a ledger is kept.
import { fail } from './failure.js';
import type { Location } from './format.js';
import type { TaskStatus } from './tasks.js';

export type ActiveState = Exclude<TaskStatus, 'backlog' | 'retired'>;

const NEXT: Record<ActiveState, readonly ActiveState[]> = {
  active: ['parked', 'blocked', 'waiting', 'done', 'lost'],
  parked: ['active'],
  blocked: ['active'],
  waiting: ['active', 'done'],
  lost: ['active'],
  done: [],
};

/** The state a status line and a lost mark give a task, the lost mark first; active when it has neither. */
export const stateOf = ({ lost, status }: Location): ActiveState => (lost ? 'lost' : (status?.value ?? 'active'));

const either = (states: readonly string[]): string => (states.length < 2 ? states.join('') : `${states.slice(0, -1).join(', ')} or ${states.at(-1)}`);

/** Fails, naming the states `slug` can move to, unless the state table lets a task move from `from` to `to`. */
export function checkTransition(slug: string, from: ActiveState, to: ActiveState): void {
  const next = NEXT[from];
  if (next.includes(to)) return;
  const refused = `${slug} is ${from}, so it cannot become ${to}.`;
  fail(next.length === 0 ? `${refused} Finalize it with /ledger:retire ${slug}.` : `${refused} A ${from} task can become ${either(next)}.`);
}
