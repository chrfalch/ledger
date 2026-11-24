import { fail } from './failure.js';
import { mainCheckout } from './git.js';
import { parseArchiveName } from './paths.js';
import { withHint } from './migrate-repo-ids.js';
import { isRepoKey, repoKey, repoLabel } from './repo-key.js';
import { keyAndAliases, type Archive, type LedgerStore, type StoredLedger } from './store.js';
import { asActiveTask } from './tasks.js';
import { currentTask, markMergedDone, type Context } from './write.js';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The newest archive copy of `slug`: by date, then by the -N that retire adds to a name already taken that day, as a
 * number. A copy of a task whose slug ends in -N matches too; a full archive name picks one copy exactly.
 */
function newestCopy(archive: Archive, repos: string[], slug: string): StoredLedger | undefined {
  const copyOf = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})-${escapeRegExp(slug)}(?:-(\\d+))?$`);
  const copies = repos.flatMap((repo) => archive.list(repo)).flatMap((ledger) => {
    const [, date, n] = copyOf.exec(ledger.name) ?? [];
    return date === undefined ? [] : [{ ledger, date, n: n === undefined ? 1 : Number(n) }];
  });
  copies.sort((a, b) => b.date.localeCompare(a.date) || b.n - a.n);
  return copies[0]?.ledger;
}

/** A name that stays one entry of the store: a file store joins it into a path. */
const isPlainName = (name: string): boolean => name !== '' && !/\.\.|[/\\]/.test(name);

/**
 * The repo `named` means, the key it is an alias of or the key itself, else the one key with that label, of the store,
 * its active tasks of other machines included, or of the clone `main`; with its old keys, so a ledger the conversion left
 * under one is found too.
 */
function namedRepos(store: LedgerStore, named: string, main: string | undefined): string[] {
  const aliases = store.aliases.read();
  const keys = [...new Set([...store.backlog.repos(), ...store.active.repos(), ...store.archive.repos(), ...aliases.values(), ...(main === undefined ? [] : [repoKey(main)])])];
  const labelled = (): string => {
    const found = keys.filter((key) => repoLabel(key) === named);
    if (found.length > 1) fail(`--repo ${named} names ${found.length} repos: ${found.join(', ')}. Pass the one you mean.`);
    return found[0] ?? named;
  };
  const key = keys.includes(named) || aliases.has(named) ? named : labelled();
  return keyAndAliases(aliases, aliases.get(key) ?? key);
}

/** The ledger `ledger show` prints without a slug: that of the active task of the worktree you are in. */
export function ownLedger(context: Context): ShownLedger {
  const { cwd, store } = context;
  const task = currentTask(store, cwd) ?? fail('No active task has the worktree you are in, so name one: ledger show <slug>');
  return shownActive(context, store.active.read(task.repo, task.name) ?? fail(`The ledger ${task.file} is gone.`));
}

/**
 * `host` names the machine whose worktree holds the ledger of an active task that is not on this one. `notice` is the
 * stderr line of the merged-PR check: that showing it marked the task done, or why it did not.
 */
export type ShownLedger = StoredLedger & { host?: string; notice?: string };

/** `entry`, an active record, marked done when its merged PR makes it so, with the machine its task is on when that is another one. */
function shownActive(context: Context, entry: StoredLedger): ShownLedger {
  const task = asActiveTask(context.store, entry);
  const { marked, notice } = markMergedDone(context, task);
  const shown = marked ? (context.store.active.read(entry.repo, entry.name) ?? entry) : entry;
  return { ...shown, ...(task.host === undefined ? {} : { host: task.host }), ...(notice === undefined ? {} : { notice }) };
}

/**
 * The ledger `ledger show <slug>` prints from the repo `repo`, or by default the repo that holds the folder you are in:
 * the archive copy named `slug`, else the active ledger of `slug`, else the backlog ledger of `slug`, else the newest
 * archive copy of `slug`. The store is searched under the repo's key and its old keys together. With `archived`, the
 * active and backlog ledgers are skipped.
 */
export function shownLedger(context: Context, slug: string, { repo: named, archived = false }: { repo?: string; archived?: boolean }): ShownLedger {
  const { cwd, store } = context;
  const active = (repo: string): ShownLedger | undefined => {
    const entry = store.active.read(repo, slug);
    return entry && shownActive(context, entry);
  };
  if (!isPlainName(slug)) fail(`"${slug}" cannot name a ledger. A name is not empty and holds no .., / or \\.`);
  if (named !== undefined && !isRepoKey(named)) fail(`--repo "${named}" cannot name a repo. A repo is not empty, holds no \\, and has no . or .. between slashes.`);
  const main = mainCheckout(cwd);
  const repos =
    named === undefined
      ? keyAndAliases(store.aliases.read(), main === undefined ? fail(`Could not tell which repo ${cwd} is in. It is not inside a git repository. Pass --repo <repo>.`) : repoKey(main))
      : namedRepos(store, named, main);
  const firstIn = (read: (repo: string) => StoredLedger | undefined): StoredLedger | undefined => repos.map(read).find((found) => found !== undefined);
  const found =
    (parseArchiveName(slug) === undefined ? undefined : firstIn((repo) => store.archive.read(repo, slug))) ??
    (archived ? undefined : firstIn(active)) ??
    (archived ? undefined : firstIn((repo) => store.backlog.read(repo, slug))) ??
    newestCopy(store.archive, repos, slug);
  if (found !== undefined) return found;
  const [repo] = repos;
  if (archived && repos.some((each) => store.backlog.has(each, slug))) fail(`${slug} has no archived copy in the repo ${repoLabel(repo)}. It is only in the backlog.`);
  const searched = archived ? 'the backlog or the archive' : 'the active tasks, the backlog or the archive';
  return fail(withHint(store, `No ledger named ${slug} is in ${searched} of the repo ${repoLabel(repo)}.`));
}
