import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { HELP } from '../mods/ledger/hooks/ledger.js';
import { REPO } from './helpers.js';

// Lives here, not in the mod's tests: `claude plugin test` gives a test file no filesystem.
test('/ledger:help lists the base /ledger and every markdown command of the ledger mod', () => {
  const listed = HELP.split('\n').map(line => line.match(/^- `\/([^` ]+)/)?.[1]);
  const files = readdirSync(path.join(REPO, 'mods/ledger/commands')).filter(file => file.endsWith('.md'));
  const expected = ['ledger', ...files.map(file => `ledger:${path.basename(file, '.md')}`)];
  assert.deepEqual([...listed].sort(), expected.sort());
});

test('/ledger:deploy deploys the latest main and tells the operator what to reload, here and on other machines', () => {
  const file = path.join(REPO, 'mods/ledger/commands/deploy.md');
  assert.ok(existsSync(file), 'mods/ledger/commands/deploy.md exists');
  const body = readFileSync(file, 'utf8');
  for (const expected of ['ledger deploy --latest --json', 't3_thread_list', '/reload-plugins', 't3_environment_links', '--machine']) {
    assert.ok(body.includes(expected), `deploy.md mentions ${expected}`);
  }
});
