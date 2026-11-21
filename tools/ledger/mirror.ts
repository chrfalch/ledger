import { realpathSync } from 'node:fs';
import path from 'node:path';
import { readTimedText } from './files.js';
import { parseLedger } from './format.js';
import { mainCheckout, worktrees, type Worktree } from './git.js';
import { mainOfTaskWorktree, samePath } from './paths.js';
import { loadTasks, parseRegistry } from './registry.js';
import { repoKey } from './repo-key.js';
import type { StoredLedger } from './store.js';
import { plural } from './views.js';
import { below } from './worktrees.js';
import type { Context } from './write.js';

export type Mirrored = { written: number; removed: number };

let discoveredForTests: (() => void) | undefined;

/** For tests only: called once a mirror has read the worktree ledgers, before it writes a copy. A module the tests preload calls it. */
export function onMirrorDiscoveredForTests(called: () => void): void {
  discoveredForTests = called;
}

/**
 * Whether git says the worktree of `copy` is gone: its repo is a main checkout git reads, and none of the worktrees git
 * lists there is the copy's worktree, has its slug as folder name or has its branch checked out, as a moved one does.
 * A worktree outside .claude/worktrees names no repo in its ledger; `knownMain` gives the one of its repo folder. Anything
 * less, such as a repo on a disk that is not connected, keeps the copy.
 */
function worktreeGone(copy: StoredLedger, knownMain: (repo: string) => string | undefined): boolean {
  const { main: named, worktree, branch } = parseLedger(copy.text).location;
  const main = named ?? (worktree === undefined ? undefined : mainOfTaskWorktree(worktree)) ?? knownMain(copy.repo);
  const checkout = main === undefined ? undefined : mainCheckout(main);
  if (main === undefined || checkout === undefined || !samePath(checkout, main)) return false;
  // A listing always holds the main checkout, so an empty one is git failing.
  const listed = worktrees(main);
  const isItsWorktree = (listedWorktree: Worktree): boolean =>
    path.basename(listedWorktree.path) === copy.name || (worktree !== undefined && samePath(listedWorktree.path, worktree)) || (branch !== undefined && listedWorktree.branch === branch);
  return listed.length > 0 && !listed.some(isItsWorktree);
}

/** The one repo of `mains` with the key `repo`; undefined for none, or for two clones of one repo. */
function onlyMainIn(mains: string[], repo: string): string | undefined {
  const named = mains.filter((main) => repoKey(main) === repo);
  return named.length > 0 && named.every((main) => samePath(main, named[0])) ? named[0] : undefined;
}

/**
 * The text of the worktree ledger `file` as the mirror may copy it: a plain file, not a symbolic link, in a .claude
 * folder that is in its worktree. Anything else could hold text from outside the worktree.
 */
function copyableText(file: string): string | undefined {
  const real = (folder: string): string | undefined => {
    try {
      return realpathSync(folder);
    } catch {
      return undefined;
    }
  };
  const [worktree, claude] = [real(path.dirname(path.dirname(file))), real(path.dirname(file))];
  if (worktree === undefined || claude === undefined || below(worktree, claude) === undefined) return undefined;
  return readTimedText(file)?.text;
}

/**
 * `ledger store mirror`: brings this machine's copies in git storage in line with the ledgers of its git worktrees. It
 * writes each copy that differs, under the task's repo key and slug. It removes each copy whose worktree's ledger it just
 * copied under another repo key or slug, and each that matches no worktree task and no task the registry lists active by
 * repo key and slug, when its worktree is gone. It commits that, all under the clone lock; closing the store pushes it. A
 * worktree ledger that is a symbolic link, or whose .claude folder is outside its worktree, is not copied. Undefined for
 * a store that keeps no copies.
 */
export function mirrorLedgers(context: Context): Mirrored | undefined {
  const { active } = context.store;
  if (active === undefined) return undefined;
  return active.reconcile((host) => {
    // Before loadTasks, which drops from the registry an active task whose ledger it cannot read.
    const entries = parseRegistry(context.store.registry.read() ?? '') ?? [];
    const registered = entries.filter(({ status }) => status === 'active');
    const here = mainCheckout(context.cwd);
    // A folder outside git is a worktree task too, but with no main: only the ledgers of git worktrees are copied.
    const found = loadTasks(context, here === undefined ? [] : [here]).filter(({ place, main }) => place === 'worktree' && main !== undefined);
    const ledgers = found.flatMap((task) => {
      // One read gives both the slug and the text, so the copy is never named after another text than it holds.
      const text = copyableText(task.file);
      return text === undefined ? [] : [{ repo: task.repo, slug: parseLedger(text).slug ?? task.name, text, worktree: path.dirname(path.dirname(task.file)) }];
    });
    discoveredForTests?.();
    const written = ledgers.filter(({ repo, slug, text }) => active.write(repo, slug, text)).length;
    const kept = (repo: string, slug: string): boolean =>
      [...found, ...ledgers, ...registered].some((task) => task.repo === repo && task.slug === slug);
    // Such as a copy written under the folder name of its repo, from before repo keys, or under a slug its ledger has no longer.
    const copiedUnderAnotherName = (copy: StoredLedger): boolean => {
      // A worktree task keeps its copy even when its Location names the worktree of another task.
      if (ledgers.some(({ repo, slug }) => repo === copy.repo && slug === copy.name)) return false;
      const { worktree } = parseLedger(copy.text).location;
      return worktree !== undefined && ledgers.some((ledger) => (ledger.repo !== copy.repo || ledger.slug !== copy.name) && samePath(ledger.worktree, worktree));
    };
    const mains = [...(here === undefined ? [] : [here]), ...[...entries, ...found].flatMap(({ main }) => main ?? [])];
    const own = active.copiesOf(host);
    const stale = own
      .repos()
      .flatMap((repo) => own.list(repo))
      // A copy whose worktree's ledger was just copied under another name goes even when the registry lists it: the
      // registry still has the name the ledger had at the last command.
      .filter((copy) => copiedUnderAnotherName(copy) || (!kept(copy.repo, copy.name) && worktreeGone(copy, (repo) => onlyMainIn(mains, repo))));
    const removed = stale.filter((copy) => active.remove(copy.repo, copy.name) !== undefined).length;
    return { written, removed };
  });
}

export function mirrorText({ written, removed }: Mirrored): string {
  const lines = [
    ...(written > 0 ? [`Copied ${plural(written, 'worktree ledger')} to git storage.`] : []),
    ...(removed > 0 ? [`Removed ${plural(removed, 'copy', 'copies')} whose worktree ledger is gone from git storage.`] : []),
  ];
  return lines.length > 0 ? lines.join('\n') : 'Nothing to copy: git storage holds each worktree ledger of this machine as it is.';
}
