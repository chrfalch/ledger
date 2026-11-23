import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { FORMAT } from '../tools/ledger/clone.js';
import { openStore } from '../tools/ledger/open-store.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { sqliteFile } from '../tools/ledger/sqlite-store.js';
import { REPO } from './helpers.js';
import { commandEnv, git, home, LEDGER_BIN, ledger, ledgerText, noSqlite, ok, repoKeyOf, repository, worktreeOf } from './ledger-core-fixtures.js';

/** The rows of the table older versions kept the task list in, 0 when the database has no such table. */
function oldTaskListRows(h: string): number {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(sqliteFile(h), { readOnly: true });
  try {
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'registry'`).get() === undefined) return 0;
    return Number((db.prepare('SELECT count(*) AS rows FROM registry').get() as { rows: number }).rows);
  } finally {
    db.close();
  }
}

for (const storage of ['file', 'sqlite', 'git'] as const) {
  test(`${storage} store: a task list read, a write and a session start cache no task list`, { skip: storage === 'sqlite' && noSqlite }, (t) => {
    const h = home(t);
    copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
    if (storage !== 'file') writeFileSync(path.join(h, '.claude/ledger-settings.json'), JSON.stringify({ storage }));
    if (storage === 'git') {
      const clone = path.join(h, '.claude/ledger-data');
      git(h, h, 'init', '--quiet', clone);
      writeFileSync(path.join(clone, '.ledger-data'), `${JSON.stringify({ format: FORMAT })}\n`);
    }
    const app = repository(h, path.join(h, 'repos/app'));
    const worktree = worktreeOf(app, 'task');
    git(h, app, 'worktree', 'add', '--quiet', '-b', 'me/task', worktree, 'main');
    mkdirSync(path.join(worktree, '.claude'));
    const store = openStore(ledgerPaths(h), storage, { backgroundSync: false });
    store.active.create(repoKeyOf(app), 'task', ledgerText({ slug: 'task', worktree, branch: 'me/task' }));
    store.close?.();

    ok(ledger(h, app, 'list'));
    ok(ledger(h, app, 'task', 'new', 'idea', '--goal', 'An idea.'));
    ok(ledger(h, worktree, 'notes', 'note', 'A note.'));
    const started = spawnSync(LEDGER_BIN, ['hook', 'session-start'], { cwd: h, env: commandEnv(h), input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: worktree }), encoding: 'utf8' });
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /task/);

    for (const file of ['ledgers.json', 'ledgers-git.json']) assert.equal(existsSync(path.join(h, '.claude', file)), false, `~/.claude/${file} was written`);
    if (storage === 'sqlite') assert.equal(oldTaskListRows(h), 0);
  });
}
