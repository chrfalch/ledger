import { existsSync, readdirSync } from 'node:fs';

// The real-process files that only `npm run test:full` runs (LLP 0002, section 4).
const FULL_RUN_ONLY = [
  'tests/ledger-git-store.test.ts',
  'tests/ledger-git-sync-lock.test.ts',
  'tests/ledger-git-sync-rebase.test.ts',
  'tests/ledger-other-machines.test.ts',
  'tests/ledger-deploy-latest.test.ts',
  'tests/deploy-runtime.test.ts',
  'tests/ledger-core-concurrency.test.ts',
  'tests/usage-pace.test.ts',
  'tests/derived-data-gate.test.ts',
  'tests/wizard-pty.test.ts',
];

const missing = FULL_RUN_ONLY.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error(`tools/quick-tests.ts lists files that do not exist: ${missing.join(', ')}`);
  process.exit(1);
}

const quick = readdirSync('tests')
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => `tests/${name}`)
  .filter((file) => !FULL_RUN_ONLY.includes(file))
  .sort();

if (quick.length === 0) {
  console.error('tools/quick-tests.ts found no quick test files in tests/');
  process.exit(1);
}

console.log(quick.join('\n'));
