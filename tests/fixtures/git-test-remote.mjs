// Preloaded with NODE_OPTIONS=--import into each ledger command of the git storage tests, so that the URL rewrite of
// their git config may send the GitHub URL to the bare repository LEDGER_TEST_REMOTE names, a test may shorten the
// wait for gh with LEDGER_TEST_GH_TIMEOUT_MS, and the pid of each background sync is noted in the file
// LEDGER_TEST_BACKGROUND_PIDS names. Only this file reads those variables: ledger itself accepts none of them.
import { appendFileSync } from 'node:fs';
import { register } from 'tsx/esm/api';

register();
const { allowRemoteForTests, limitGhWaitForTests } = await import(new URL('../../tools/ledger/sync.ts', import.meta.url).href);
const { onBackgroundSyncForTests } = await import(new URL('../../tools/ledger/git-store.ts', import.meta.url).href);
if (process.env.LEDGER_TEST_REMOTE) allowRemoteForTests(process.env.LEDGER_TEST_REMOTE);
if (process.env.LEDGER_TEST_GH_TIMEOUT_MS) limitGhWaitForTests(Number(process.env.LEDGER_TEST_GH_TIMEOUT_MS));
const pids = process.env.LEDGER_TEST_BACKGROUND_PIDS;
if (pids) onBackgroundSyncForTests((pid) => appendFileSync(pids, `${pid}\n`));
