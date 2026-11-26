import assert from 'node:assert/strict';
import test from 'node:test';
import { ledgerText } from './ledger-core-fixtures.js';
import { parseLedger } from '../tools/ledger/format.js';
import { storedRepoOf, type Task } from '../tools/ledger/tasks.js';

function backlog(repo: string, text: string): Task {
  const ledger = parseLedger(text);
  const slug = ledger.slug ?? assert.fail('the ledger has no title');
  return { slug, repo, repoKeys: [repo], main: ledger.location.main, file: `${repo}/${slug}`, name: slug, place: 'backlog', status: 'backlog', ledger, mtimeMs: 0, birthtimeMs: 0 };
}

test('storedRepoOf prefers the main a ledger names over one a parent child line names for another task', () => {
  const [x, parentMain] = ['/r/x', '/r/parent'];
  // The parent still lists `kid @ /r/x` from when kid was a task of x; the kid now in repo y names no main.
  const kid = backlog('me/y', ledgerText({ slug: 'kid', branch: 'kid', parent: `p @ ${parentMain}` }));
  const parent = backlog('me/p', ledgerText({ slug: 'p', main: parentMain, branch: 'p', children: [`- kid @ ${x}`] }));
  const own = backlog('me/x', ledgerText({ slug: 'own', main: x, branch: 'own' }));
  assert.equal(storedRepoOf([kid, parent, own])(x), 'me/x');
});
