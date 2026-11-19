import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { logHookFailure } from '../tools/ledger/hook-failures.js';
import { REPO } from './helpers.js';

const LOGGED = path.join(REPO, 'hooks/logged.sh');
const TIME = '\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ';

/** A HOME whose ~/.claude/hooks links logged.sh as deploy does, beside the given hook scripts. */
function hooksHome(t: TestContext, scripts: Record<string, string>): string {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'ledger-logged-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const hooks = path.join(home, '.claude/hooks');
  mkdirSync(hooks, { recursive: true });
  symlinkSync(LOGGED, path.join(hooks, 'logged.sh'));
  for (const [name, body] of Object.entries(scripts)) writeFileSync(path.join(hooks, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return home;
}

function logged(home: string, args: string[], input = '') {
  const result = spawnSync(path.join(home, '.claude/hooks/logged.sh'), args, { cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin' }, input, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

const logOf = (home: string): string | undefined => {
  const file = path.join(home, '.claude/ledger-hook-failures.log');
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
};

test('logged.sh is executable', () => {
  assert.ok(statSync(LOGGED).mode & 0o111);
});

test('logged.sh passes stdin, arguments, stdout and exit 0 through and logs nothing', (t) => {
  const home = hooksHome(t, { 'ok.sh': 'cat; echo "args: $*"; exit 0' });

  const result = logged(home, ['ok.sh', 'one', 'two words'], '{"tool":"Bash"}\n');

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '{"tool":"Bash"}\nargs: one two words\n');
  assert.equal(logOf(home), undefined);
});

test('logged.sh passes exit 2 and its stderr through unchanged and logs nothing', (t) => {
  const home = hooksHome(t, { 'deny.sh': 'echo "partial"; printf "denied: use the shared folder\\n\\n" >&2; exit 2' });

  const result = logged(home, ['deny.sh']);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, 'partial\n');
  assert.equal(result.stderr, 'denied: use the shared folder\n\n');
  assert.equal(logOf(home), undefined);
});

test('logged.sh logs any other exit with the last non-empty stderr line and exits 0 with nothing on stderr', (t) => {
  const home = hooksHome(t, { 'broken.sh': 'echo first >&2; printf "  last \\t  words  \\n\\n   \\n" >&2; exit 1' });

  const result = logged(home, ['broken.sh']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(logOf(home) ?? '', new RegExp(`^${TIME}\\tbroken\\.sh\\tlast words\\n$`));
});

test('logged.sh logs exit <code> for a failure with no stderr, and appends', (t) => {
  const home = hooksHome(t, { 'quiet.sh': 'exit 3' });
  writeFileSync(path.join(home, '.claude/ledger-hook-failures.log'), 'earlier\n');

  assert.equal(logged(home, ['quiet.sh']).status, 0);

  assert.match(logOf(home) ?? '', new RegExp(`^earlier\\n${TIME}\\tquiet\\.sh\\texit 3\\n$`));
});

test('logged.sh logs a missing script and a script killed by a signal, and exits 0 with nothing on stderr', (t) => {
  const home = hooksHome(t, { 'killed.sh': 'kill -TERM $$' });

  for (const name of ['missing.sh', 'killed.sh']) {
    const result = logged(home, [name]);
    assert.equal(result.status, 0, name);
    assert.equal(result.stderr, '', name);
  }

  const lines = (logOf(home) ?? '').split('\n');
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.match(lines[0], new RegExp(`^${TIME}\\tmissing\\.sh\\t.*missing\\.sh.*$`));
  assert.match(lines[1], new RegExp(`^${TIME}\\tkilled\\.sh\\t\\S.*$`));
});

test('logged.sh creates ~/.claude for the log, and exits 0 when the log cannot be written', (t) => {
  const home = hooksHome(t, { 'broken.sh': 'exit 1' });
  const outside = path.join(home, 'elsewhere');
  mkdirSync(outside);
  const linked = (h: string) => spawnSync(path.join(home, '.claude/hooks/logged.sh'), ['broken.sh'], { cwd: h, env: { HOME: h, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });

  const created = linked(outside);
  assert.equal(created.status, 0);
  assert.match(readFileSync(path.join(outside, '.claude/ledger-hook-failures.log'), 'utf8'), /\tbroken\.sh\texit 1\n$/);

  rmSync(path.join(outside, '.claude'), { recursive: true });
  writeFileSync(path.join(outside, '.claude'), 'a file, so no log can be written under it');
  const unwritable = linked(outside);
  assert.equal(unwritable.status, 0);
  assert.equal(unwritable.stderr, '');
});

test('logHookFailure writes one tab-separated line with the message on one line, cut to 500 characters', (t) => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'ledger-logged-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  logHookFailure(home, 'ledger hook session-start', `  a\t\tb\n\n c  ${'x'.repeat(600)}`, new Date('2026-11-19T08:00:00.123Z'));

  const line = readFileSync(path.join(home, '.claude/ledger-hook-failures.log'), 'utf8');
  const message = `a b c ${'x'.repeat(600)}`.slice(0, 500);
  assert.equal(line, `2026-11-19T08:00:00Z\tledger hook session-start\t${message}\n`);
});
