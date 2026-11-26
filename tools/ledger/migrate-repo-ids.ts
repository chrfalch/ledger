import { statSync } from 'node:fs';
import path from 'node:path';
import { exists, isEntryName } from './files.js';
import { parseLedger } from './format.js';
import { mainCheckout } from './git.js';
import { absoluteMain, mainOfTaskWorktree, realPath, samePath } from './paths.js';
import { repoKey, repoLabel } from './repo-key.js';
import type { Move, OnMove } from './pending.js';
import type { LedgerStore, StoredLedger } from './store.js';
import { parseOldTaskList, type OldTaskListEntry } from './unmoved.js';
import { joined, plural } from './views.js';

// @ref LLP 0001#4-storage — D10: the one-time conversion from folder-name keys to repo addresses.

export const places = ['backlog', 'active', 'archive'] as const;
export type Place = (typeof places)[number];
/** Why a ledger stays: no key for it is sure; `noRepo` when its repo is gone or unknown. */
type Left = { left: string; noRepo?: true };
/** Where a ledger goes, or why it stays. */
type Outcome = { to: string } | Left;
type Moved = { repo: string; location: string };

/** A key from before D10: the folder name of a main checkout. Every D10 key, an address or a path, holds a slash. */
const isFolderName = (repo: string): boolean => !repo.includes('/');

/** The main checkout a ledger names: its `- main:` line, ~ in `home`, else the repo of its worktree under .claude/worktrees. */
export function namedMain(text: string, home?: string): string | undefined {
  const { main, worktree } = parseLedger(text, { home }).location;
  return main ?? (worktree === undefined ? undefined : mainOfTaskWorktree(worktree));
}

/** Why a ledger whose saved main checkout is the relative path `main` stays: nothing tells which folder it meant. */
export const relativeMainReason = (main: string): string => `its saved main checkout "${main}" is a relative path, so its repo folder cannot be recovered`;

/**
 * The folder that holds an active entry's ledger, and its main checkout: the entry's `main`, else the one git
 * reports for the folder, else the repo whose .claude/worktrees holds it. Undefined for an entry with a relative path.
 */
function activeFolder(entry: OldTaskListEntry, home: string | undefined): { folder: string; main: string } | undefined {
  if (!path.isAbsolute(entry.path)) return undefined;
  const folder = path.dirname(path.dirname(entry.path));
  if (entry.main === undefined) return { folder, main: mainCheckout(folder) ?? mainOfTaskWorktree(folder) ?? folder };
  const main = absoluteMain(entry.main, home);
  return main === undefined ? undefined : { folder, main };
}

/** Where an entry says its ledger is: an archive copy's location, else its path. */
const entryLocation = (entry: OldTaskListEntry): string | undefined => (entry.status === 'archived' ? entry.archivePath : entry.path);

export const shown = (key: string): string => `${repoLabel(key)} (${key})`;

/** The name whose ledger of `place` under `repo` is at `location`, if any: a file store adds .json, or .md before task records, to a name; SQLite adds nothing. */
function nameAt(store: LedgerStore, place: Place, repo: string, location: string): string | undefined {
  const base = path.basename(location);
  return [base, base.replace(/\.(md|json)$/, '')].find((name) => isEntryName(name) && store[place].location(repo, name) === location);
}

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const taken = (key: string, name: string): string => `${shown(key)} already has ${name}`;

const itemName = (place: Place | 'evidence', old: string, name: string): string => `${place} ${old}/${name}`;
const ALIAS = 'alias ';

const MOUNT_DEPTH: Record<string, number> = { Volumes: 3, mnt: 3, media: 4 };

/** The root of the removable or network disk that holds `file`, by its path alone: /Volumes/<disk>, /mnt/<disk> or /media/<user>/<disk>. */
function volumeRoot(file: string): string | undefined {
  const parts = path.normalize(file).split('/');
  const depth = MOUNT_DEPTH[parts[1]];
  return depth === undefined || parts.length < depth ? undefined : parts.slice(0, depth).join('/');
}

/** The code `stat` fails with for `file`, or undefined when it is there. */
function statError(file: string): string | undefined {
  try {
    statSync(file);
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'an error';
  }
}

/**
 * Moves the ledger `name` of `place` from the repo key `old` to `to`, with an archive copy's evidence, or with `dryRun`
 * checks that it would, by the store's own checks. Gives why it stays where it is, or undefined when it moved.
 */
export function moveLedger(store: LedgerStore, place: Place, { old, name, to }: { old: string; name: string; to: string }, dryRun: boolean): string | undefined {
  const byHand = `on another disk, move by hand to ${store[place].location(to, name)}`;
  try {
    if (!store[place].canMove(old, name, to)) return taken(to, name);
    if (dryRun) return store[place].acrossDisks?.(old, name, to) ? byHand : undefined;
    return store[place].move(old, name, to) ? undefined : taken(to, name);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EXDEV' ? byHand : `the move ${dryRun ? 'would fail' : 'failed'}: ${messageOf(error)}`;
  }
}

/** `message`, with the conversion hint after it when the store needs one: a task may be missing only because of its key. */
export function withHint(store: LedgerStore, message: string): string {
  const hint = conversionHint(store);
  return hint === undefined ? message : `${message} ${hint}`;
}

type Item = { repo: string; what: string; finished: boolean };

/**
 * What the store still keeps under folder names: its ledgers and evidence with no archive copy, each by the folder name
 * it is under, and the folder names whose alias a task contradicts.
 */
function leftUnderFolderNames(store: LedgerStore): { ledgers: string[]; evidence: string[]; conflicts: string[] } {
  const ledgers = places.flatMap((place) => store[place].repos().filter(isFolderName).flatMap((repo) => store[place].list(repo).map(({ name }) => ({ repo, what: itemName(place, repo, name), finished: place === 'archive' }))));
  const evidence = store.archive.orphanEvidence().flatMap(({ repo, name }) => (isFolderName(repo) ? [{ repo, what: itemName('evidence', repo, name), finished: true }] : []));
  const moves: Move[] = [];
  // Only a finished task can be accepted, and only the conversion's own dry run knows which is: that takes git and the
  // old task list, too slow for every session start when nothing could be.
  if ([...ledgers, ...evidence].some(({ finished }) => finished)) migrateRepoIds(store, { dryRun: true }, () => {}, (move) => void moves.push(move));
  const accepted = new Set(moves.flatMap(({ from, accepted }) => (accepted ? [from] : [])));
  const kept = (items: Item[]): string[] => items.flatMap(({ repo, what }) => (accepted.has(what) ? [] : [repo]));
  const conflicts = moves.flatMap(({ from, auto }) => (!auto && from.startsWith(ALIAS) ? [from.slice(ALIAS.length)] : []));
  return { ledgers: kept(ledgers), evidence: kept(evidence), conflicts };
}

/** What the operator should fix in the store's repo keys: what is still kept under folder names, and aliases it ignores. */
export function conversionHint(store: LedgerStore): string | undefined {
  const { ledgers, evidence, conflicts } = leftUnderFolderNames(store);
  const kinds: [repos: string[], one: string, many: string][] = [
    [ledgers, 'ledger', 'ledgers'],
    [evidence, 'evidence folder', 'evidence folders'],
  ];
  const counts = kinds.filter(([repos]) => repos.length > 0).map(([repos, one, many]) => plural(repos.length, one, many));
  const count = ledgers.length + evidence.length;
  const old = [...new Set([...ledgers, ...evidence])].sort();
  const legacy = count === 0 ? undefined : `${joined(counts)} still use${count === 1 ? 's' : ''} folder names (${old.join(', ')}); run \`ledger store migrate --repo-ids\`.`;
  const one = conflicts.length === 1;
  const contradicted =
    conflicts.length === 0
      ? undefined
      : `The folder name${one ? '' : 's'} ${joined(conflicts)} ${one ? 'is an alias' : 'are aliases'} of one repo while a task of ${one ? 'it' : 'each'} is in another; run \`ledger store migrate --repo-ids\` to see ${one ? 'it' : 'them'}.`;
  const hints = [legacy, contradicted, store.aliases.problem()].filter((hint) => hint !== undefined);
  return hints.length === 0 ? undefined : hints.join('\n');
}

/**
 * `ledger store migrate --repo-ids [--dry-run]`: files each backlog ledger, active record and archive copy kept under a folder name
 * under its repo's D10 key, with its evidence, by a rename on one disk. The main checkout comes from the ledger itself,
 * else from the old task list and the other ledgers of that folder name when they name exactly one checkout, else from the
 * alias an earlier run recorded. Whatever is not that sure stays for a person to move: a ledger whose main is gone, one
 * whose folder name fits more than one checkout or none, one whose name the new key has in any form, and one on
 * another disk. The only part of a move it finishes is evidence a stopped run left beside a copy it had moved, to a key
 * that folder name was already recorded as an alias of.
 *
 * A folder name becomes an alias of its key only once a ledger of it moved there, when all its tasks are in that one
 * repo and the repo of each of its ledgers is known. An alias that names another key stays as it is, and is a conflict.
 * Each folder name is done whole before the next: its ledgers, then its alias. The old task list, which it only reads,
 * counts for the alias too: a ledger an earlier run moved, and the checkout of an active entry while its ledger is there.
 * An alias map that cannot be read stops the run before anything moves, in a dry run too.
 *
 * A finished task it leaves because its repo folder is not on disk or is unknown is accepted: an archive copy, or
 * evidence of a folder name that is no alias and whose ledger is nowhere in the store. Nobody can or needs to move it,
 * so it is no failure, and one line counts them all.
 *
 * `store` is undefined for a database that is not there. Prints one line per step to `line`, gives `onMove` each ledger,
 * evidence folder and alias conflict, and returns how many ledgers, evidence folders and alias conflicts it left, or
 * with `dryRun` would leave, under a folder name for a person to move.
 */
export function migrateRepoIds(store: LedgerStore | undefined, { dryRun, home }: { dryRun: boolean; home?: string }, line: (text: string) => void, onMove?: OnMove): number {
  line(`Convert repo keys from folder names to repo addresses${dryRun ? ' · dry run, nothing changed' : ''}`);
  const report = (from: string, to: string, reason?: string, accepted = false): void =>
    onMove?.({ kind: 'repo-ids', from, to, auto: reason === undefined, ...(reason === undefined ? {} : { reason }), ...(accepted ? { accepted } : {}) });
  const act = (done: string, planned: string): string => (dryRun ? `would ${planned}` : done);
  const nothing = (): number => (line(`${dryRun ? 'Would move' : 'Moved'} 0 ledgers; nothing uses a folder name.`), 0);
  if (store === undefined) return nothing();
  const filed = new Map<string, { place: Place; ledger: StoredLedger }[]>();
  for (const place of places) {
    for (const repo of store[place].repos().filter(isFolderName)) {
      filed.set(repo, [...(filed.get(repo) ?? []), ...store[place].list(repo).map((ledger) => ({ place, ledger }))]);
    }
  }
  const entries = parseOldTaskList(store.oldTaskList() ?? '') ?? [];
  const legacyEntries = entries.filter(({ repo }) => typeof repo === 'string' && isFolderName(repo));
  const orphans = store.archive.orphanEvidence().filter(({ repo }) => isFolderName(repo));
  const olds = [...new Set([...filed.keys(), ...legacyEntries.map(({ repo }) => repo), ...orphans.map(({ repo }) => repo)])].sort();
  if (olds.length === 0) return nothing();
  const aliasProblem = store.aliases.problem();
  if (aliasProblem !== undefined) {
    line(`Stopped before any move, as each move records an alias: ${aliasProblem}`);
    report(`folder names ${olds.join(', ')}`, 'repo addresses', aliasProblem);
    return [...filed.values()].flat().length + orphans.length;
  }

  const savedMain = (main: string | undefined): string | undefined => (main === undefined ? undefined : absoluteMain(main, home));
  const recorded = [
    ...entries.flatMap((entry) => [savedMain(entry.main), savedMain(entry.parentMain), entry.status === 'active' ? activeFolder(entry, home)?.main : undefined]),
    ...[...filed.values()].flat().map(({ ledger }) => namedMain(ledger.text, home)),
  ].filter((main) => main !== undefined);
  const keys = new Map<string, string | undefined>();
  const keyOf = (main: string): string | undefined => {
    if (!keys.has(main)) {
      // A folder that is not there needs no git, which keeps the hint's dry run cheap where the repos are gone.
      // One that is no main checkout any more may sit inside another repo, whose key it must not take.
      const checkout = exists(main) ? mainCheckout(main) : undefined;
      keys.set(main, checkout !== undefined && samePath(checkout, main) ? repoKey(checkout) : undefined);
    }
    return keys.get(main);
  };
  const aliases = store.aliases.read();
  /**
   * Why a ledger whose main has no key stays. A folder that is not there is gone, unless it is on a disk that is not
   * mounted; a whole missing home is the usual case on another machine. A folder that is there may be a git lookup that failed.
   */
  const noKey = (main: string): Left => {
    const error = statError(main);
    if (error === undefined) return { left: `its repo folder ${main} is no longer a git repo, or git did not answer` };
    if (error !== 'ENOENT') return { left: `its repo folder ${main} cannot be read (${error})` };
    const volume = volumeRoot(main);
    if (volume !== undefined && statError(volume) !== undefined) return { left: `its repo folder ${main} is on a disk that is not mounted` };
    return { left: `its repo folder ${main} is gone`, noRepo: true };
  };
  /** `unsaid` is why it stays when no record and no alias tells its repo. */
  const ownerless = (old: string, unsaid: Left): Outcome => {
    const candidates = [...new Map(recorded.filter((main) => path.basename(main) === old).map((main) => [realPath(main), main])).values()];
    const found = new Set(candidates.map(keyOf));
    const [key] = found;
    if (candidates.length === 0) {
      // An earlier run decided it, from records that may have moved on since: the ledgers it moved.
      const saved = aliases.get(old);
      return saved === undefined ? unsaid : { to: saved };
    }
    if (found.size === 1 && key !== undefined) return { to: key };
    if (candidates.length === 1) return noKey(candidates[0]);
    return { left: `ambiguous: ${old} was the folder name of ${candidates.length} checkouts, ${candidates.join(', ')}` };
  };
  /** The relative main checkout the ledger, or the old task list entry of it, saved. */
  const relativeMain = ({ text, location }: StoredLedger): string | undefined =>
    parseLedger(text, { home }).location.relativeMain ??
    entries.find((entry) => entryLocation(entry) === location && entry.main !== undefined && savedMain(entry.main) === undefined)?.main;
  const ledgerOutcome = (old: string, ledger: StoredLedger): Outcome => {
    const own = namedMain(ledger.text, home);
    if (own === undefined) {
      const relative = relativeMain(ledger);
      return ownerless(old, { left: relative === undefined ? 'its ledger does not say which repo folder it came from' : relativeMainReason(relative), noRepo: true });
    }
    const key = keyOf(own);
    return key === undefined ? noKey(own) : { to: key };
  };
  /** The key an active entry of the old task list says its folder name stands for, when it says one. */
  const activeTarget = (entry: OldTaskListEntry): string | undefined => {
    const active = exists(entry.path) ? activeFolder(entry, home) : undefined;
    if (active === undefined) return undefined;
    const { folder, main } = active;
    const checkout = mainCheckout(folder);
    if (checkout !== undefined) {
      if (path.basename(checkout) !== entry.repo) return undefined;
      const key = repoKey(checkout);
      return keyOf(main) === key ? key : undefined;
    }
    const key = keyOf(main);
    if (key !== undefined) return key;
    const inNoRepo = entry.main === undefined && mainOfTaskWorktree(folder) === undefined;
    return inNoRepo ? path.resolve(folder) : undefined;
  };
  /**
   * Where the evidence `name` left under `old` goes: to the key a stopped run moved its archive copy to, the one copy of
   * that name whose main had that folder name and has that key. Only a key `old` was already recorded as an alias of is
   * sure; a key another folder name is an alias of too may hold a copy moved from there.
   */
  const strayOutcome = (old: string, name: string): Outcome => {
    const found = store.archive.repos().filter((repo) => {
      const copy = isFolderName(repo) ? undefined : store.archive.read(repo, name);
      const main = copy && namedMain(copy.text, home);
      return main !== undefined && path.basename(main) === old && keyOf(main) === repo;
    });
    const [key] = found;
    if (key === undefined) {
      // A copy of its name under any key, a folder name too, may be its ledger, which a person can still bring it to.
      const holders = store.archive.repos().filter((repo) => store.archive.has(repo, name));
      if (holders.length > 0) {
        const where = joined(holders.map((repo) => (isFolderName(repo) ? repo : shown(repo))));
        return { left: `notes of a finished task, while a ledger of its name is under ${where}; move them by hand beside it if they are its notes` };
      }
      // The repo of its folder name is known once an alias names it, also one this run records for the ledgers it moves.
      const owners = [...new Set([
        aliases.get(old),
        ...(outcomes.get(old) ?? []).map(({ outcome }) => ('to' in outcome ? outcome.to : undefined)),
        ...resumed.flatMap((each) => (each.old === old ? [each.key] : [])),
      ].filter((key) => key !== undefined))];
      const notes = 'notes of a finished task whose ledger is not in the store';
      const [owner] = owners;
      if (owner === undefined) return { left: notes, noRepo: true };
      if (owners.length > 1) return { left: `${notes}, of one of the repos ${owners.map(shown).join(', ')}; move them by hand to the right one` };
      return { left: `${notes}, of the repo ${shown(owner)}; move them by hand to ${store.archive.evidenceLocation(owner, name)}` };
    }
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
  const earlierMove = (entry: OldTaskListEntry): Moved | undefined => {
    const location = entryLocation(entry);
    if (location === undefined || entry.status === 'active') return undefined;
    const place: Place = entry.status === 'archived' ? 'archive' : 'backlog';
    const name = nameAt(store, place, entry.repo, location);
    if (name === undefined || store[place].has(entry.repo, name)) return undefined;
    const recordedMain = savedMain(entry.main);
    const key = (recordedMain === undefined ? undefined : keyOf(recordedMain)) ?? aliases.get(entry.repo);
    const ledger = key === undefined ? undefined : store[place].read(key, name);
    // A ledger that names no main is placed by the records, this stale entry among them, so it is no proof of its own.
    const main = ledger && namedMain(ledger.text, home);
    if (key === undefined || main === undefined || keyOf(main) !== key) return undefined;
    const to = store[place].location(key, name);
    return entries.some((other) => entryLocation(other) === to) ? undefined : { repo: key, location: to };
  };
  // Planned before anything moves, so a dry run plans what the run does: a ledger this run moves is no sign of an earlier run.
  const outcomes = new Map([...filed].map(([old, list]) => [old, list.map((each) => ({ ...each, outcome: ledgerOutcome(old, each.ledger) }))]));
  const resumed = legacyEntries.flatMap((entry) => {
    const moved = earlierMove(entry);
    return moved === undefined ? [] : [{ old: entry.repo, key: moved.repo }];
  });
  const strays = orphans.map((orphan) => ({ ...orphan, outcome: strayOutcome(orphan.repo, orphan.name) }));

  const reserved = new Set<string>();
  let [moved, left, kept] = [0, 0, 0];
  const leave = (what: string, outcome: Left, finished: boolean): void => {
    const accepted = finished && outcome.noRepo === true;
    if (accepted) kept++;
    else left++;
    if (!accepted) line(`left ${what}: ${outcome.left}`);
    report(what, 'repo address', outcome.left, accepted);
  };
  /** Moves `name` of `place` from `old` to `to`, or in a dry run checks that it would, by the store's own checks; says why not. */
  const moves = (place: Place, old: string, name: string, to: string, what: string): boolean => {
    const slot = `${place}\0${to}\0${name}`;
    const why = reserved.has(slot) ? taken(to, name) : moveLedger(store, place, { old, name, to }, dryRun);
    if (why !== undefined) {
      leave(what, { left: why }, false);
      return false;
    }
    reserved.add(slot);
    return true;
  };

  for (const old of olds) {
    const ledgers = outcomes.get(old) ?? [];
    const actives = legacyEntries.filter(({ repo, status }) => repo === old && status === 'active').flatMap((entry) => activeTarget(entry) ?? []);
    const saved = aliases.get(old);

    const movedTo = new Map<string, Moved>();
    for (const { place, ledger, outcome } of ledgers) {
      const what = itemName(place, old, ledger.name);
      if ('left' in outcome) leave(what, outcome, place === 'archive');
      else if (moves(place, old, ledger.name, outcome.to, what)) {
        moved++;
        movedTo.set(ledger.location, { repo: outcome.to, location: store[place].location(outcome.to, ledger.name) });
        line(`${act('moved', 'move')} ${what} to ${shown(outcome.to)}`);
        report(what, shown(outcome.to));
      }
    }
    for (const { name, outcome } of strays.filter(({ repo }) => repo === old)) {
      const what = itemName('evidence', old, name);
      if ('left' in outcome) leave(what, outcome, true);
      else if (moves('archive', old, name, outcome.to, what)) {
        movedTo.set(store.archive.location(old, name), { repo: outcome.to, location: store.archive.location(outcome.to, name) });
        line(`${act('moved', 'move')} ${what} to ${shown(outcome.to)}, where a stopped run moved its archive copy`);
        report(what, shown(outcome.to));
      }
    }

    const movedKeys = new Set([...movedTo.values()].map(({ repo }) => repo).concat(resumed.flatMap((each) => (each.old === old ? [each.key] : []))));
    const targets = new Set([...movedKeys, ...ledgers.flatMap(({ outcome }) => ('to' in outcome ? [outcome.to] : [])), ...actives]);
    const [target] = targets;
    const elsewhere = saved === undefined ? undefined : [...targets].find((key) => key !== saved);
    if (saved !== undefined && elsewhere !== undefined) {
      left++;
      line(`kept the alias ${old} of ${shown(saved)} as it is, though a task of ${old} is in ${shown(elsewhere)}; an alias is never changed`);
      report(`${ALIAS}${old}`, shown(elsewhere), `it is an alias of ${shown(saved)}, and an alias is never changed`);
    } else if (saved === undefined && movedKeys.size > 0) {
      if (ledgers.some(({ outcome }) => 'left' in outcome)) line(`kept no alias for ${old}: the repo of a ledger left under it is not known`);
      else if (targets.size > 1) line(`kept no alias for ${old}: its tasks are in ${plural(targets.size, 'repo')}`);
      else {
        if (!dryRun) store.aliases.add(old, target);
        line(`${act('recorded', 'record')} ${old} as an alias of ${shown(target)}`);
      }
    }
  }
  // One line for them all: they need nobody, and `--pending` names each.
  if (kept > 0) {
    line(`${act('kept', 'keep')} ${plural(kept, 'finished task')} under ${kept === 1 ? 'its' : 'their'} old repo folder name, as that folder is gone or unknown; ledger store migrate --pending names ${kept === 1 ? 'it' : 'them'}.`);
  }
  line(`${dryRun ? 'Would move' : 'Moved'} ${plural(moved, 'ledger')}; ${dryRun ? 'would leave' : 'left'} ${left} as ${left === 1 ? 'it is' : 'they are'}.`);
  return left;
}
