import assert from 'node:assert/strict';
import test from 'node:test';
import { clearStatus, readStatus, recordProblem, SyncProblem, takeSyncNumber } from '../tools/ledger/clone.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { home } from './ledger-core-fixtures.js';

test('two syncs that start in the same millisecond still have an order: the problem of the earlier one does not replace the success of the later one', (t) => {
  const paths = ledgerPaths(home(t));
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);

  const earlier = takeSyncNumber(paths);
  const later = takeSyncNumber(paths);

  assert.ok(later > earlier, `${later} is not after ${earlier}`);
  clearStatus(paths, later);
  recordProblem(paths, new SyncProblem('network', 'earlier'), earlier);
  assert.equal(readStatus(paths), undefined);
});

test('two syncs that start in the same millisecond still have an order: the problem of the later one replaces the success of the earlier one', (t) => {
  const paths = ledgerPaths(home(t));
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);

  const earlier = takeSyncNumber(paths);
  const later = takeSyncNumber(paths);

  clearStatus(paths, earlier);
  recordProblem(paths, new SyncProblem('conflict', 'later'), later);
  assert.equal(readStatus(paths)?.message, 'later');
});

test('the problem of a sync replaces the success of one that started before it', (t) => {
  const paths = ledgerPaths(home(t));
  const earlier = takeSyncNumber(paths);
  const later = takeSyncNumber(paths);

  clearStatus(paths, earlier);
  recordProblem(paths, new SyncProblem('conflict', 'later'), later);

  assert.equal(readStatus(paths)?.message, 'later');
});
