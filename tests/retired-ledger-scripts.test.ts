import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { REPO } from './helpers.js';

const DELETED = [
  'bin/cc-task-new',
  'bin/cc-worktree-retire',
  'bin/cc-ledger-parent',
  'bin/cc-ledgers',
  'bin/lib',
  'hooks/ledger-gate.sh',
  'hooks/ledger-list.sh',
  'hooks/worktree-gate.sh',
  'tests/task-new.test.ts',
  'tests/worktree-retire.test.ts',
  'tests/ledger-parent.test.ts',
  'tests/ledgers.test.ts',
  'tests/ledger-gate.test.ts',
  'tests/ledger-list.test.ts',
];

const RETIRED_NAME = /\b(cc-task-new|cc-worktree-retire|cc-ledger-parent|cc-ledgers|cc-ledger-dashboard|archived-main)\b|\bbin\/lib\b|\b(ledger-gate|ledger-list|worktree-gate)\.sh\b/;

const MAY_NAME_RETIRED = new Set([
  // History.
  'DECISIONS.md',
  // Removes the old hook commands from settings.json files that an earlier deploy wrote.
  'tools/apply-policy.ts',
  'tests/apply-policy.test.ts',
  'tests/retired-ledger-scripts.test.ts',
]);

/** Lines, trimmed, that name a retired script to assert that it is absent or that the gate denies it. */
const ASSERTS_ABSENCE: Record<string, readonly string[]> = {
  'tests/rules-gates.test.ts': [
    String.raw`const hits = text.split('\n').filter((line) => /\b(cc-task-new|cc-worktree-retire|cc-ledger-parent|cc-ledgers|cc-ledger-dashboard)\b|bin\/lib\b|dashboard/i.test(line));`,
  ],
  'tests/ledger-task-command.test.ts': [
    'assert.doesNotMatch(update, /cc-task-new/);',
    'assert.doesNotMatch(read(`mods/ledger/commands/${file}`), /cc-task-new|cc-ledger-parent|cc-ledgers|cc-worktree-retire|cc-ledger-dashboard/, file);',
  ],
  'tests/ledger-core-hooks.test.ts': [
    "test('a removal that names the deleted cc-worktree-retire script is denied', (t) => {",
    'assert.equal(assertDenied(gate(main, \'Bash\', { command: `bin/cc-worktree-retire ${task}; rm -rf ${task}` }, h)), removalReason(main, task));',
  ],
};

test('the retired ledger scripts, hooks and their tests are gone', () => {
  assert.deepEqual(DELETED.filter((file) => existsSync(path.join(REPO, file))), []);
});

test('no file outside the history and the settings cleanup names a retired ledger script or hook', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file && !file.startsWith('.claude/') && !MAY_NAME_RETIRED.has(file) && existsSync(path.join(REPO, file)));
  assert.ok(files.length > 0);
  const hits = files.flatMap((file) =>
    readFileSync(path.join(REPO, file), 'utf8')
      .split('\n')
      .flatMap((line, index) => (RETIRED_NAME.test(line) && !ASSERTS_ABSENCE[file]?.includes(line.trim()) ? [`${file}:${index + 1}: ${line.trim()}`] : [])),
  );
  assert.deepEqual(hits, []);
});
