import { fail } from './failure.js';
import { mainCheckout } from './git.js';
import { parseArchiveName, repoName } from './paths.js';
import type { Archive, StoredLedger } from './store.js';
import type { Context } from './write.js';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The newest archive copy of `slug`: by date, then by the -N that retire adds to a name already taken that day, as a
 * number. A copy of a task whose slug ends in -N matches too; a full archive name picks one copy exactly.
 */
function newestCopy(archive: Archive, repo: string, slug: string): StoredLedger | undefined {
  const copyOf = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})-${escapeRegExp(slug)}(?:-(\\d+))?$`);
  const copies = archive.list(repo).flatMap((ledger) => {
    const [, date, n] = copyOf.exec(ledger.name) ?? [];
    return date === undefined ? [] : [{ ledger, date, n: n === undefined ? 1 : Number(n) }];
  });
  copies.sort((a, b) => b.date.localeCompare(a.date) || b.n - a.n);
  return copies[0]?.ledger;
}

/** A name that stays one entry of the store: a file store joins it into a path. */
const isPlainName = (name: string): boolean => name !== '' && !/\.\.|[/\\]/.test(name);

/**
 * The ledger `ledger show <slug>` prints from the repo `repo`, or by default the repo that holds the folder you are in:
 * the archive copy named `slug`, else the backlog ledger of `slug`, else the newest archive copy of `slug`. With
 * `archived`, the backlog is skipped.
 */
export function shownLedger({ cwd, store }: Context, slug: string, { repo: named, archived = false }: { repo?: string; archived?: boolean }): StoredLedger {
  if (!isPlainName(slug)) fail(`"${slug}" cannot name a ledger. A name is not empty and holds no .., / or \\.`);
  if (named !== undefined && !isPlainName(named)) fail(`--repo "${named}" cannot name a repo folder. A name is not empty and holds no .., / or \\.`);
  const main = named === undefined ? mainCheckout(cwd) : undefined;
  const repo = named ?? (main === undefined ? fail(`Could not tell which repo ${cwd} is in. It is not inside a git repository. Pass --repo <name>.`) : repoName(main));
  const found =
    (parseArchiveName(slug) === undefined ? undefined : store.archive.read(repo, slug)) ??
    (archived ? undefined : store.backlog.read(repo, slug)) ??
    newestCopy(store.archive, repo, slug);
  if (found !== undefined) return found;
  if (archived && store.backlog.has(repo, slug)) fail(`${slug} has no archived copy in the repo ${repo}. It is only in the backlog.`);
  return fail(`No ledger named ${slug} is in the backlog or the archive of the repo ${repo}.`);
}
