import path from 'node:path';
import { exists, isEntryName } from './files.js';
import { parseLedger } from './format.js';
import { mainCheckout } from './git.js';
import { mainOfTaskWorktree, realPath, samePath } from './paths.js';
import { parseRegistry, type RegistryEntry } from './registry.js';
import { repoKey, repoLabel } from './repo-key.js';
import type { LedgerStore, StoredLedger } from './store.js';
import { joined, plural } from './views.js';

// @ref LLP 0001#4-storage — D10: the one-time conversion from folder-name keys to repo addresses.

export const places = ['backlog', 'active', 'archive'] as const;
export type Place = (typeof places)[number];
/** Where a ledger goes, or why it stays: no key for it is sure. */
type Outcome = { to: string } | { left: string };
type Moved = { repo: string; location: string };

/** A key from before D10: the folder name of a main checkout. Every D10 key, an address or a path, holds a slash. */
const isFolderName = (repo: string): boolean => !repo.includes('/');

/** The main checkout a ledger names: its `- main:` line, else the repo of its worktree under .claude/worktrees. */
export function namedMain(text: string): string | undefined {
  const { main, worktree } = parseLedger(text).location;
  return main ?? (worktree === undefined ? undefined : mainOfTaskWorktree(worktree));
}

/**
 * The folder that holds an active entry's ledger, and its main checkout: the entry's `main`, else the one git
 * reports for the folder, else the repo whose .claude/worktrees holds it.
 */
function activeFolder(entry: RegistryEntry): { folder: string; main: string } {
  const folder = path.dirname(path.dirname(entry.path));
  return { folder, main: entry.main ?? mainCheckout(folder) ?? mainOfTaskWorktree(folder) ?? folder };
}

/** Where an entry says its ledger is: an archive copy's location, else its path. */
const entryLocation = (entry: RegistryEntry): string | undefined => (entry.status === 'archived' ? entry.archivePath : entry.path);

export const shown = (key: string): string => `${repoLabel(key)} (${key})`;

/** The name whose ledger of `place` under `repo` is at `location`, if any: a file store adds .json, or .md before task records, to a name; SQLite adds nothing. */
function nameAt(store: LedgerStore, place: Place, repo: string, location: string): string | undefined {
  const base = path.basename(location);
  return [base, base.replace(/\.(md|json)$/, '')].find((name) => isEntryName(name) && store[place].location(repo, name) === location);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const taken = (key: string, name: string): string => `${shown(key)} already has ${name}`;

/**
 * Moves the ledger `name` of `place` from the repo key `old` to `to`, with an archive copy's evidence, or with `dryRun`
 * checks that it would, by the store's own checks. Gives why it stays where it is, or undefined when it moved.
 */
export function moveLedger(store: LedgerStore, place: Place, { old, name, to }: { old: string; name: string; to: string }, dryRun: boolean): string | undefined {
  if (!store[place].canMove(old, name, to)) return taken(to, name);
  if (dryRun) return undefined;
  try {
    return store[place].move(old, name, to) ? undefined : taken(to, name);
  } catch (error) {
    const otherDisk = (error as NodeJS.ErrnoException).code === 'EXDEV';
    return otherDisk ? `on another disk, move by hand to ${store[place].location(to, name)}` : `the move failed: ${messageOf(error)}`;
  }
}

/** `message`, with the conversion hint after it when the store needs one: a task may be missing only because of its key. */
export function withHint(store: LedgerStore, message: string): string {
  const hint = conversionHint(store);
  return hint === undefined ? message : `${message} ${hint}`;
}

/**
 * What the store still keeps under folder names: its ledgers, the registry entries that stand for no such ledger, and
 * evidence with no archive copy, each by the folder name it is under.
 */
function leftUnderFolderNames(store: LedgerStore): { ledgers: string[]; entries: string[]; evidence: string[] } {
  const ledgers = places.flatMap((place) => store[place].repos().filter(isFolderName).flatMap((repo) => store[place].list(repo)));
  const locations = new Set(ledgers.map(({ location }) => location));
  const entries = (parseRegistry(store.registry.read() ?? '') ?? []).filter((entry) => {
    const location = entryLocation(entry);
    return typeof entry.repo === 'string' && isFolderName(entry.repo) && (location === undefined || !locations.has(location));
  });
  return {
    ledgers: ledgers.map(({ repo }) => repo),
    entries: entries.map(({ repo }) => repo),
    evidence: store.archive.orphanEvidence().flatMap(({ repo }) => (isFolderName(repo) ? [repo] : [])),
  };
}

/** What the operator should fix in the store's repo keys: what is still kept under folder names, and aliases it ignores. */
export function conversionHint(store: LedgerStore): string | undefined {
  const { ledgers, entries, evidence } = leftUnderFolderNames(store);
  const kinds: [repos: string[], one: string, many: string][] = [
    [ledgers, 'ledger', 'ledgers'],
    [entries, 'registry entry', 'registry entries'],
    [evidence, 'evidence folder', 'evidence folders'],
  ];
  const counts = kinds.filter(([repos]) => repos.length > 0).map(([repos, one, many]) => plural(repos.length, one, many));
  const count = ledgers.length + entries.length + evidence.length;
  const old = [...new Set([...ledgers, ...entries, ...evidence])].sort();
  const legacy = count === 0 ? undefined : `${joined(counts)} still use${count === 1 ? 's' : ''} folder names (${old.join(', ')}); run \`ledger store migrate --repo-ids\`.`;
  const hints = [legacy, store.aliases.problem()].filter((hint) => hint !== undefined);
  return hints.length === 0 ? undefined : hints.join('\n');
}

/**
 * `ledger store migrate --repo-ids [--dry-run]`: files each backlog ledger, active record and archive copy kept under a folder name
 * under its repo's D10 key, with its evidence, by a rename on one disk. The main checkout comes from the ledger itself,
 * else from the registry and the other ledgers of that folder name when they name exactly one checkout, else from the
 * alias an earlier run recorded. Whatever is not that sure stays for a person to move: a ledger whose main is gone, one
 * whose folder name fits more than one checkout or none, one whose name the new key has in any form, and one on
 * another disk. The only part of a move it finishes is evidence a stopped run left beside a copy it had moved, to a key
 * that folder name was already recorded as an alias of.
 *
 * A folder name becomes an alias of its key only once a ledger of it moved there, when all its tasks are in that one
 * repo and the repo of each of its ledgers is known. An alias that names another key stays as it is, and is a conflict.
 * Each folder name is done whole before the next: its ledgers, its alias, then its registry entries. A registry entry
 * gets the key of its own ledger that moved, also in an earlier run; an active entry gets the key of its checkout, while its
 * ledger is there. An alias map that cannot be read stops the run before anything moves, in a dry run too.
 *
 * `store` is undefined for a database that is not there. Prints one line per step to `line`, and returns how many
 * ledgers, registry entries, evidence folders and alias conflicts it left, or with `dryRun` would leave, under a folder name.
 */
export function migrateRepoIds(store: LedgerStore | undefined, { dryRun }: { dryRun: boolean }, line: (text: string) => void): number {
  line(`Convert repo keys from folder names to repo addresses${dryRun ? ' · dry run, nothing changed' : ''}`);
  const act = (done: string, planned: string): string => (dryRun ? `would ${planned}` : done);
  const nothing = (): number => (line(`${dryRun ? 'Would move' : 'Moved'} 0 ledgers; nothing uses a folder name.`), 0);
  if (store === undefined) return nothing();
  const filed = new Map<string, { place: Place; ledger: StoredLedger }[]>();
  for (const place of places) {
    for (const repo of store[place].repos().filter(isFolderName)) {
      filed.set(repo, [...(filed.get(repo) ?? []), ...store[place].list(repo).map((ledger) => ({ place, ledger }))]);
    }
  }
  const entries = parseRegistry(store.registry.read() ?? '') ?? [];
  const legacyEntries = entries.filter(({ repo }) => typeof repo === 'string' && isFolderName(repo));
  const orphans = store.archive.orphanEvidence().filter(({ repo }) => isFolderName(repo));
  const olds = [...new Set([...filed.keys(), ...legacyEntries.map(({ repo }) => repo), ...orphans.map(({ repo }) => repo)])].sort();
  if (olds.length === 0) return nothing();
  const aliasProblem = store.aliases.problem();
  if (aliasProblem !== undefined) {
    line(`Stopped before any move, as each move records an alias: ${aliasProblem}`);
    return [...filed.values()].flat().length + legacyEntries.length + orphans.length;
  }

  const recorded = [
    ...entries.flatMap((entry) => [entry.main, entry.parentMain, entry.status === 'active' ? activeFolder(entry).main : undefined]),
    ...[...filed.values()].flat().map(({ ledger }) => namedMain(ledger.text)),
  ].filter((main) => main !== undefined);
  const keys = new Map<string, string | undefined>();
  const keyOf = (main: string): string | undefined => {
    if (!keys.has(main)) {
      // A folder that is no main checkout any more may sit inside another repo, whose key it must not take.
      const checkout = mainCheckout(main);
      keys.set(main, checkout !== undefined && samePath(checkout, main) ? repoKey(checkout) : undefined);
    }
    return keys.get(main);
  };
  const aliases = store.aliases.read();
  const gone = (main: string): Outcome => ({ left: `its main checkout ${main} is not one any more` });
  const ownerless = (old: string): Outcome => {
    const candidates = [...new Map(recorded.filter((main) => path.basename(main) === old).map((main) => [realPath(main), main])).values()];
    const found = new Set(candidates.map(keyOf));
    const [key] = found;
    if (candidates.length === 0) {
      // An earlier run decided it, from records that may have moved on since: the registry entries it re-keyed, the ledgers it moved.
      const saved = aliases.get(old);
      return saved === undefined ? { left: 'it names no main checkout, and no record names one' } : { to: saved };
    }
    if (found.size === 1 && key !== undefined) return { to: key };
    if (candidates.length === 1) return gone(candidates[0]);
    return { left: `ambiguous: ${old} was the folder name of ${candidates.length} checkouts, ${candidates.join(', ')}` };
  };
  const ledgerOutcome = (old: string, text: string): Outcome => {
    const own = namedMain(text);
    if (own === undefined) return ownerless(old);
    const key = keyOf(own);
    return key === undefined ? gone(own) : { to: key };
  };
  const activeOutcome = (entry: RegistryEntry): Outcome => {
    if (!exists(entry.path)) return { left: `its ledger ${entry.path} is missing` };
    const { folder, main } = activeFolder(entry);
    const checkout = mainCheckout(folder);
    if (checkout !== undefined) {
      if (path.basename(checkout) !== entry.repo) return { left: `its ledger is in ${checkout}, whose folder name is not ${entry.repo}` };
      const [key, named] = [repoKey(checkout), keyOf(main)];
      if (named === undefined) return gone(main);
      return named === key ? { to: key } : { left: `its ledger is in ${checkout}, a checkout of ${shown(key)}, but it names the main checkout ${main}, of ${shown(named)}` };
    }
    const key = keyOf(main);
    if (key !== undefined) return { to: key };
    const inNoRepo = entry.main === undefined && mainOfTaskWorktree(folder) === undefined;
    return inNoRepo ? { to: path.resolve(folder) } : gone(main);
  };
  /**
   * Where the evidence `name` left under `old` goes: to the key a stopped run moved its archive copy to, the one copy of
   * that name whose main had that folder name and has that key. Only a key `old` was already recorded as an alias of is
   * sure; a key another folder name is an alias of too may hold a copy moved from there.
   */
  const strayOutcome = (old: string, name: string): Outcome => {
    const found = store.archive.repos().filter((repo) => {
      const copy = isFolderName(repo) ? undefined : store.archive.read(repo, name);
      const main = copy && namedMain(copy.text);
      return main !== undefined && path.basename(main) === old && keyOf(main) === repo;
    });
    const [key] = found;
    if (key === undefined) return { left: 'no archive copy has its name' };
    if (found.length > 1) return { left: `ambiguous: ${found.length} repos have a copy of its name from a checkout named ${old}, ${found.map(shown).join(', ')}` };
    const other = [...aliases].find(([folder, to]) => folder !== old && to === key)?.[0];
    if (other !== undefined) return { left: `ambiguous: its copy in ${shown(key)} may have moved there from ${other}, an alias of that repo too` };
    if (aliases.get(old) !== key) return { left: `${old} is no alias of ${shown(key)}, which has its copy; move it by hand to ${store.archive.evidenceLocation(key, name)}` };
    return { to: key };
  };
  /**
   * Where a run that stopped moved the ledger of the backlog or archive `entry`: a ledger of its name under the key of its
   * main, or of the alias that run recorded, that names a main checkout with that key, and that no entry stands for yet.
   */
  const earlierMove = (entry: RegistryEntry): Moved | undefined => {
    const location = entryLocation(entry);
    if (location === undefined || entry.status === 'active') return undefined;
    const place: Place = entry.status === 'archived' ? 'archive' : 'backlog';
    const name = nameAt(store, place, entry.repo, location);
    if (name === undefined || store[place].has(entry.repo, name)) return undefined;
    const key = (entry.main === undefined ? undefined : keyOf(entry.main)) ?? aliases.get(entry.repo);
    const ledger = key === undefined ? undefined : store[place].read(key, name);
    // A ledger that names no main is placed by the records, this stale entry among them, so it is no proof of its own.
    const main = ledger && namedMain(ledger.text);
    if (key === undefined || main === undefined || keyOf(main) !== key) return undefined;
    const to = store[place].location(key, name);
    return entries.some((other) => entryLocation(other) === to) ? undefined : { repo: key, location: to };
  };
  // Planned before anything moves, so a dry run plans what the run does: a ledger this run moves is no sign of an earlier run.
  const strays = orphans.map((orphan) => ({ ...orphan, outcome: strayOutcome(orphan.repo, orphan.name) }));
  const resumable = new Map(
    legacyEntries.flatMap((entry) => {
      const [location, moved] = [entryLocation(entry), earlierMove(entry)];
      return location === undefined || moved === undefined ? [] : [[location, moved] as const];
    }),
  );

  const reserved = new Set<string>();
  let [moved, left, updated] = [0, 0, 0];
  const leave = (what: string, why: string): void => {
    left++;
    line(`left ${what}: ${why}`);
  };
  /** Moves `name` of `place` from `old` to `to`, or in a dry run checks that it would, by the store's own checks; says why not. */
  const moves = (place: Place, old: string, name: string, to: string, what: string): boolean => {
    const slot = `${place}\0${to}\0${name}`;
    const why = reserved.has(slot) ? taken(to, name) : moveLedger(store, place, { old, name, to }, dryRun);
    if (why !== undefined) {
      leave(what, why);
      return false;
    }
    reserved.add(slot);
    return true;
  };

  for (const old of olds) {
    const ledgers = (filed.get(old) ?? []).map((each) => ({ ...each, outcome: ledgerOutcome(old, each.ledger.text) }));
    const actives = new Map(legacyEntries.filter(({ repo, status }) => repo === old && status === 'active').map((entry) => [entry.path, activeOutcome(entry)]));
    const saved = aliases.get(old);

    const movedTo = new Map<string, Moved>();
    for (const { place, ledger, outcome } of ledgers) {
      const what = `${place} ${old}/${ledger.name}`;
      if ('left' in outcome) leave(what, outcome.left);
      else if (moves(place, old, ledger.name, outcome.to, what)) {
        moved++;
        movedTo.set(ledger.location, { repo: outcome.to, location: store[place].location(outcome.to, ledger.name) });
        line(`${act('moved', 'move')} ${what} to ${shown(outcome.to)}`);
      }
    }
    for (const { name, outcome } of strays.filter(({ repo }) => repo === old)) {
      const what = `evidence ${old}/${name}`;
      if ('left' in outcome) leave(what, outcome.left);
      else if (moves('archive', old, name, outcome.to, what)) {
        movedTo.set(store.archive.location(old, name), { repo: outcome.to, location: store.archive.location(outcome.to, name) });
        line(`${act('moved', 'move')} ${what} to ${shown(outcome.to)}, where a stopped run moved its archive copy`);
      }
    }

    const registry = registryChange(store, old, movedTo, resumable, actives, legacyEntries);
    const movedKeys = new Set([...movedTo.values()].map(({ repo }) => repo).concat(registry.resumed));
    const targets = new Set([...movedKeys, ...[...ledgers.map(({ outcome }) => outcome), ...actives.values()].flatMap((outcome) => ('to' in outcome ? [outcome.to] : []))]);
    const [target] = targets;
    const elsewhere = saved === undefined ? undefined : [...targets].find((key) => key !== saved);
    if (saved !== undefined && elsewhere !== undefined) {
      left++;
      line(`kept the alias ${old} of ${shown(saved)} as it is, though a task of ${old} is in ${shown(elsewhere)}; an alias is never changed`);
    } else if (saved === undefined && movedKeys.size > 0) {
      if (ledgers.some(({ outcome }) => 'left' in outcome)) line(`kept no alias for ${old}: the repo of a ledger left under it is not known`);
      else if (targets.size > 1) line(`kept no alias for ${old}: its tasks are in ${plural(targets.size, 'repo')}`);
      else {
        if (!dryRun) store.aliases.add(old, target);
        line(`${act('recorded', 'record')} ${old} as an alias of ${shown(target)}`);
      }
    }

    for (const why of registry.left) {
      left++;
      line(`left registry entry ${why}`);
    }
    if (registry.count > 0) {
      if (!dryRun) store.registry.update(registry.change);
      updated += registry.count;
    }
  }
  if (updated > 0) line(`${act('updated', 'update')} ${plural(updated, 'registry entry', 'registry entries')}`);
  line(`${dryRun ? 'Would move' : 'Moved'} ${plural(moved, 'ledger')}; ${dryRun ? 'would leave' : 'left'} ${left} as ${left === 1 ? 'it is' : 'they are'}.`);
  return left;
}

/**
 * The registry change for the entries of the folder name `old`. A moved ledger's entry gets its new key and location, so
 * the next load keeps its created time; so does one whose ledger an earlier run moved, by `earlier`, which `resumed`
 * lists. An active entry gets the key `actives` gives it. An entry whose ledger stays under `old` stays as it is.
 * Everything is decided before the registry is held, as git must not run then; `left` names each entry that cannot be
 * converted, such as a stale one, whose ledger is nowhere: no key is right for it.
 */
function registryChange(
  store: LedgerStore,
  old: string,
  movedTo: Map<string, Moved>,
  earlier: Map<string, Moved>,
  actives: Map<string, Outcome>,
  entries: RegistryEntry[],
): { count: number; left: string[]; resumed: string[]; change: (current: string | undefined) => string | undefined } {
  const decided = new Map<string, Partial<RegistryEntry>>();
  const left: string[] = [];
  const resumed: string[] = [];
  for (const entry of entries.filter(({ repo }) => repo === old)) {
    const location = entryLocation(entry);
    if (location === undefined) {
      left.push(`${old}/${entry.slug}: it is archived, but names no archive copy`);
      continue;
    }
    const place: Place = entry.status === 'archived' ? 'archive' : 'backlog';
    const relocated = (to: Moved): Partial<RegistryEntry> => ({ repo: to.repo, ...(place === 'archive' ? { archivePath: to.location } : { path: to.location }) });
    const outcome = actives.get(location);
    if (entry.status === 'active') {
      if (outcome !== undefined && 'to' in outcome) decided.set(location, { repo: outcome.to });
      else left.push(`${old}/${entry.slug}: ${outcome?.left ?? 'it names no ledger'}`);
      continue;
    }
    const moved = movedTo.get(location);
    if (moved !== undefined) {
      decided.set(location, relocated(moved));
      continue;
    }
    const name = nameAt(store, place, old, location);
    if (name !== undefined && store[place].has(old, name)) continue;
    const resumes = earlier.get(location);
    if (resumes !== undefined) {
      decided.set(location, relocated(resumes));
      resumed.push(resumes.repo);
    } else left.push(`${old}/${entry.slug}: its ledger is gone, so the next ledger command drops it`);
  }
  const change = (current: string | undefined): string | undefined => {
    const now = parseRegistry(current ?? '');
    if (now === undefined) return undefined;
    const next = now.map((entry) => {
      const location = entryLocation(entry);
      const fields = entry.repo === old && location !== undefined ? decided.get(location) : undefined;
      return fields === undefined ? entry : { ...entry, ...fields };
    });
    return `${JSON.stringify(next, null, 2)}\n`;
  };
  return { count: decided.size, left, resumed, change };
}
