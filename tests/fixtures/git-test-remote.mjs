// Preloaded with NODE_OPTIONS=--import into each ledger command of the git storage tests, and of the tests of a hang,
// so that the URL rewrite of their git config may send the GitHub URL to the bare repository LEDGER_TEST_REMOTE names,
// a test may shorten the wait for gh with LEDGER_TEST_GH_TIMEOUT_MS and the time limits of `shortened` with their
// variables, and the pid of each background sync is noted in the file LEDGER_TEST_BACKGROUND_PIDS names. Only this file
// reads those variables: ledger itself accepts none of them.
import { appendFileSync } from 'node:fs';
import { register } from 'tsx/esm/api';

register();
const { allowRemoteForTests, limitGhWaitForTests } = await import(new URL('../../tools/ledger/sync.ts', import.meta.url).href);
const { onBackgroundSyncForTests } = await import(new URL('../../tools/ledger/git-store.ts', import.meta.url).href);
const { limitHookTimeForTests } = await import(new URL('../../tools/ledger/hooks.ts', import.meta.url).href);
const { limitPrCheckTimeForTests } = await import(new URL('../../tools/ledger/pr-check.ts', import.meta.url).href);
const { limitLockWaitForTests } = await import(new URL('../../tools/ledger/lock.ts', import.meta.url).href);
const { limitBusyWaitForTests } = await import(new URL('../../tools/ledger/sqlite-store.ts', import.meta.url).href);
const shortened = {
  LEDGER_TEST_HOOK_TIME_MS: limitHookTimeForTests,
  LEDGER_TEST_PR_CHECK_TIME_MS: limitPrCheckTimeForTests,
  LEDGER_TEST_LOCK_WAIT_MS: limitLockWaitForTests,
  LEDGER_TEST_BUSY_WAIT_MS: limitBusyWaitForTests,
};
if (process.env.LEDGER_TEST_REMOTE) allowRemoteForTests(process.env.LEDGER_TEST_REMOTE);
if (process.env.LEDGER_TEST_GH_TIMEOUT_MS) limitGhWaitForTests(Number(process.env.LEDGER_TEST_GH_TIMEOUT_MS));
for (const [variable, limit] of Object.entries(shortened)) if (process.env[variable]) limit(Number(process.env[variable]));
const pids = process.env.LEDGER_TEST_BACKGROUND_PIDS;
if (pids) onBackgroundSyncForTests((pid) => appendFileSync(pids, `${pid}\n`));
