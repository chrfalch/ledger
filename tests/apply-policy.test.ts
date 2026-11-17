// Proves foreign hooks and local keys survive, policy keys apply, repeat runs
// change nothing, and absent settings are created from the policy alone.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { applyJson, applyToml } from '../tools/apply-policy.js';
import { freshHome, REPO, run } from './helpers.js';

const APPLY_POLICY = [process.execPath, '--import', 'tsx', 'tools/apply-policy.ts'] as const;
const POLICY = path.join(REPO, 'settings.policy.json');
const LIVE = {
  model: 'sonnet',
  permissions: { allow: ['mcp__argent'] },
  tui: 'compact',
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo stale' }] }],
  },
};

function readSettings(target: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(target, 'utf8'));
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function hookEntries(settings: Record<string, unknown>, event: string): unknown[] {
  const hooks = settings.hooks;
  assert.ok(typeof hooks === 'object' && hooks !== null && !Array.isArray(hooks), 'hooks missing');
  const entries: unknown = (hooks as Record<string, unknown>)[event];
  assert.ok(Array.isArray(entries), `hooks.${event} missing`);
  return entries;
}

function policyReport(stdout: string): { changed: string[]; kept: string[] } {
  const applied = /^claude   policy keys applied: (.+)$/m.exec(stdout);
  assert.ok(applied, `Missing Claude policy report: ${stdout}`);
  const kept = /^         left alone: (.+)$/m.exec(stdout);
  return {
    changed: applied[1] === 'already current' ? [] : applied[1].split(', '),
    kept: kept ? kept[1].split(', ') : [],
  };
}

test('policy merge preserves foreign hooks and local keys while applying owned keys', (t) => {
  const home = freshHome(t);
  const target = path.join(home, '.claude/settings.json');
  writeFileSync(target, JSON.stringify(LIVE, null, 2));
  const result = run(home, APPLY_POLICY, '--backup-dir', path.join(home, 'backup'), '--no-codex');
  assert.equal(result.status, 0, result.stderr);
  const out = readSettings(target);
  const policy = readSettings(POLICY);
  assert.deepEqual(
    hookEntries(out, 'PreToolUse'),
    [...LIVE.hooks.PreToolUse, ...hookEntries(policy, 'PreToolUse')],
    'FOREIGN HOOK LOST OR ALTERED',
  );
  assert.deepEqual(hookEntries(out, 'SessionStart'), hookEntries(policy, 'SessionStart'), 'SessionStart not applied');
  assert.deepEqual(hookEntries(out, 'PreCompact'), hookEntries(policy, 'PreCompact'), 'PreCompact not added');
  assert.equal(out.model, 'sonnet', 'local model lost');
  assert.deepEqual(out.permissions, LIVE.permissions, 'local permissions lost');
  assert.equal(out.tui, 'fullscreen', 'tui not applied');
  assert.ok(existsSync(path.join(home, 'backup/.claude/settings.json')), 'no backup written');
  assert.ok(policyReport(result.stdout).changed.includes('hooks.PreToolUse'), 'owned gates not reported as applied');
});

function applyToHooks(t: TestContext, hooks: Record<string, unknown[]>): Record<string, unknown> {
  const home = freshHome(t);
  const target = path.join(home, '.claude/settings.json');
  writeFileSync(target, JSON.stringify({ hooks }, null, 2));
  const result = run(home, APPLY_POLICY, '--backup-dir', path.join(home, 'backup'), '--no-codex');
  assert.equal(result.status, 0, result.stderr);
  return readSettings(target);
}

const GATE = '"$HOME"/.claude/hooks/derived-data-gate.sh';
const RETRY = '"$HOME"/.claude/hooks/denied-read-retry.sh';

test('a group that mixes an owned command with a prompt hook is yours and survives unchanged', (t) => {
  const mixed = {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: GATE }, { type: 'prompt', prompt: 'Is this command safe?' }],
  };
  const out = applyToHooks(t, { PreToolUse: [mixed] });
  const policy = readSettings(POLICY);
  assert.deepEqual(hookEntries(out, 'PreToolUse'), [mixed, ...hookEntries(policy, 'PreToolUse')]);
});

test('an owned command under your own matcher survives unchanged', (t) => {
  const ownMatcher = { matcher: 'Bash|Edit', hooks: [{ type: 'command', command: GATE }] };
  const out = applyToHooks(t, { PreToolUse: [ownMatcher] });
  const policy = readSettings(POLICY);
  assert.deepEqual(hookEntries(out, 'PreToolUse'), [ownMatcher, ...hookEntries(policy, 'PreToolUse')]);
});

test('foreign entries keep their order and owned entries follow them', (t) => {
  const policy = readSettings(POLICY);
  const foreignPreToolUse = [
    { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo first' }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: GATE }, { type: 'command', command: 'echo mine' }] },
    { hooks: [{ type: 'command', command: 'echo third' }] },
  ];
  const foreignPermissionDenied = [
    { matcher: 'Read', hooks: [{ type: 'command', command: RETRY }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo denied' }] },
  ];
  const out = applyToHooks(t, {
    PreToolUse: [foreignPreToolUse[0]!, ...hookEntries(policy, 'PreToolUse'), ...foreignPreToolUse.slice(1)],
    PermissionDenied: foreignPermissionDenied,
  });
  assert.deepEqual(hookEntries(out, 'PreToolUse'), [...foreignPreToolUse, ...hookEntries(policy, 'PreToolUse')]);
  assert.deepEqual(hookEntries(out, 'PermissionDenied'), [
    ...foreignPermissionDenied,
    ...hookEntries(policy, 'PermissionDenied'),
  ]);
});

test('applying policy a second time reports no changes', (t) => {
  const home = freshHome(t);
  const target = path.join(home, '.claude/settings.json');
  writeFileSync(target, JSON.stringify(LIVE, null, 2));
  const first = run(home, APPLY_POLICY, '--backup-dir', path.join(home, 'backup'), '--no-codex');
  assert.equal(first.status, 0, first.stderr);
  const before = readFileSync(target, 'utf8');
  const second = run(home, APPLY_POLICY, '--backup-dir', path.join(home, 'backup2'), '--no-codex');
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(policyReport(second.stdout).changed, [], 'second run not idempotent');
  assert.equal(readFileSync(target, 'utf8'), before);
});

test('absent settings are created from policy with all keys changed and none kept', (t) => {
  const home = freshHome(t);
  const target = path.join(home, '.claude/settings.json');
  unlinkSync(target);
  const result = run(home, APPLY_POLICY, '--backup-dir', path.join(home, 'backup3'), '--no-codex');
  assert.equal(result.status, 0, result.stderr);
  const report = policyReport(result.stdout);
  const policy = readSettings(POLICY);
  assert.deepEqual(report.changed.sort(), Object.keys(policy).sort());
  assert.deepEqual(report.kept, []);
  assert.deepEqual(readSettings(target), policy);
});

test('policy CLI preserves dry-run and required or skipped Codex reports', (t) => {
  const home = freshHome(t);
  const policy = JSON.parse(readFileSync(POLICY, 'utf8')) as Record<string, unknown>;
  const target = path.join(home, '.claude/settings.json');
  writeFileSync(target, '{}\n');
  const backupDirectory = path.join(home, 'backup');
  const claude = `claude   policy keys would apply: ${Object.keys(policy).sort().join(', ')}\n`;
  const optional = run(home, APPLY_POLICY, '--backup-dir', backupDirectory, '--dry-run');
  assert.equal(optional.status, 0, optional.stderr);
  assert.equal(optional.stdout, `${claude}codex    skipped (no ~/.codex/config.toml; pass --codex to require it)\n`);
  assert.equal(optional.stderr, '');
  const required = run(home, APPLY_POLICY, '--backup-dir', backupDirectory, '--dry-run', '--codex');
  assert.equal(required.status, 1);
  assert.equal(required.stdout, claude);
  assert.equal(required.stderr, `codex    ERROR: ${path.join(home, '.codex/config.toml')} not found\n`);
  const skipped = run(home, APPLY_POLICY, '--backup-dir', backupDirectory, '--dry-run', '--codex', '--no-codex');
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(skipped.stdout, `${claude}codex    skipped (--no-codex)\n`);
  assert.equal(readFileSync(target, 'utf8'), '{}\n');
  assert.equal(existsSync(backupDirectory), false);
});

function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'apply-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('JSON output preserves merged values and backup metadata', (t) => {
  const directory = temporaryDirectory(t);
  const policy = path.join(directory, 'policy.json');
  const target = path.join(directory, 'live.json');
  const backupDirectory = path.join(directory, 'backup');
  const original = '{"7":"😀","é":{"3":false},"untouched":1.0}\n';
  writeFileSync(policy, '{"é":{"10":"☃","2":1.0},"owned":true}\n');
  writeFileSync(target, original);
  chmodSync(target, 0o640);
  const timestamp = new Date('2020-02-03T04:05:06.000Z');
  utimesSync(target, timestamp, timestamp);

  const [changed, kept] = applyJson(policy, target, backupDirectory);

  assert.deepEqual(changed, ['owned', 'é.10', 'é.2']);
  assert.deepEqual(kept, ['7', 'untouched', 'é.3']);
  assert.deepEqual(readSettings(target), {
    '7': '😀',
    é: { '3': false, '10': '☃', '2': 1 },
    untouched: 1,
    owned: true,
  });
  const backup = path.join(backupDirectory, path.basename(target));
  assert.equal(readFileSync(backup, 'utf8'), original);
  assert.equal(statSync(backup).mode & 0o777, 0o640);
  assert.equal(statSync(backup).mtimeMs, timestamp.getTime());
});

test('JSON dry run reports changes without writing or backing up', (t) => {
  const directory = temporaryDirectory(t);
  const policy = path.join(directory, 'policy.json');
  const target = path.join(directory, 'live.json');
  const backupDirectory = path.join(directory, 'backup');
  writeFileSync(policy, '{"missing":null,"changed":2}\n');
  writeFileSync(target, '{"changed":1}\n');

  assert.deepEqual(applyJson(policy, target, backupDirectory, true), [['changed'], []]);
  assert.equal(readFileSync(target, 'utf8'), '{"changed":1}\n');
  assert.equal(existsSync(backupDirectory), false);
});

test('TOML editing is line based, normalizes newlines, and preserves local tables', (t) => {
  const directory = temporaryDirectory(t);
  const target = path.join(directory, 'config.toml');
  const backupDirectory = path.join(directory, 'backup');
  const original = '  approval_policy = "old"\r\n# keep\r\n[projects.x]\r\ntrust_level = "trusted"\r\n';
  writeFileSync(target, original);

  const [changed, tables] = applyToml(
    path.join(REPO, 'codex/policy.toml'),
    target,
    backupDirectory,
  );

  assert.deepEqual(changed, ['approval_policy', 'sandbox_mode']);
  assert.equal(tables, 1);
  assert.equal(
    readFileSync(target, 'utf8'),
    'approval_policy = "on-request"\n# keep\nsandbox_mode = "workspace-write"\n\n[projects.x]\ntrust_level = "trusted"\n',
  );
  assert.equal(readFileSync(path.join(backupDirectory, path.basename(target)), 'utf8'), original);
});

test('TOML current policy does not create a backup', (t) => {
  const directory = temporaryDirectory(t);
  const target = path.join(directory, 'config.toml');
  const backupDirectory = path.join(directory, 'backup');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(
    target,
    'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n[plugins.example]\nenabled = true\n',
  );

  assert.deepEqual(
    applyToml(path.join(REPO, 'codex/policy.toml'), target, backupDirectory),
    [[], 1],
  );
  assert.equal(existsSync(backupDirectory), false);
});

test('TOML preserves large local integers and inserts compact arrays with distinct numeric types', (t) => {
  const directory = temporaryDirectory(t);
  const policy = path.join(directory, 'policy.toml');
  const target = path.join(directory, 'config.toml');
  writeFileSync(policy, 'items = [1, 2.0, "é"]\n');
  writeFileSync(target, 'local = 9007199254740993\n');
  assert.deepEqual(applyToml(policy, target, path.join(directory, 'backup')), [['items'], 0]);
  assert.equal(readFileSync(target, 'utf8'), 'local = 9007199254740993\nitems = [1, 2.0, "é"]\n');
});

test('policy rejects invalid UTF-8 in policy or live files without changing or backing up targets', (t) => {
  const directory = temporaryDirectory(t);
  for (const extension of ['json', 'toml']) {
    for (const invalidFile of ['policy', 'live']) {
      const policy = path.join(directory, `policy.${extension}`);
      const target = path.join(directory, `live.${extension}`);
      const backupDirectory = path.join(directory, 'backup');
      const valid = extension === 'json' ? '{"key":"value"}\n' : 'key = "value"\n';
      const invalid = Buffer.concat([Buffer.from(extension === 'json' ? '{"key":"' : 'key = "'), Buffer.from([0xff]), Buffer.from(extension === 'json' ? '"}\n' : '"\n')]);
      writeFileSync(policy, invalidFile === 'policy' ? invalid : valid);
      writeFileSync(target, invalidFile === 'live' ? invalid : '{}\n');
      const before = readFileSync(target);
      const apply = extension === 'json' ? applyJson : applyToml;
      assert.throws(() => apply(policy, target, backupDirectory), /encoded data was not valid/);
      assert.deepEqual(readFileSync(target), before);
      assert.equal(existsSync(backupDirectory), false);
    }
  }
});

test('invalid TOML refuses both a real apply and dry run without mutations', (t) => {
  const directory = temporaryDirectory(t);
  const target = path.join(directory, 'config.toml');
  const backupDirectory = path.join(directory, 'backup');
  const original = '[broken\n';
  writeFileSync(target, original);
  for (const dry of [false, true]) {
    assert.throws(() => applyToml(path.join(REPO, 'codex/policy.toml'), target, backupDirectory, dry));
    assert.equal(readFileSync(target, 'utf8'), original);
    assert.equal(existsSync(backupDirectory), false);
  }
});

test('applyToml writes string, integer and array values from a custom policy', (t) => {
  const directory = temporaryDirectory(t);
  const policy = path.join(directory, 'policy.toml');
  const target = path.join(directory, 'config.toml');
  writeFileSync(policy, "name = 'example'\ncount = 42\nitems = [1,2]\n");
  writeFileSync(target, '');
  assert.deepEqual(applyToml(policy, target, path.join(directory, 'backup')), [['name', 'count', 'items'], 0]);
  assert.equal(readFileSync(target, 'utf8'), 'name = "example"\ncount = 42\nitems = [1, 2]\n');
});
