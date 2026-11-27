import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { limitCloneGitCalls } from '../tools/ledger/clone.js';
import { resetGitLimits } from '../tools/ledger/git.js';
import { limitLockWaits } from '../tools/ledger/lock.js';
import { fakeClock, home, LEDGER_BIN, repository, runInProcessWith, worktreeTask, type FakeClock, type Ran } from './ledger-core-fixtures.js';

const START = '2026-11-27T10:00:00Z';
const MINUTE = 60_000;

const marker = (h: string): string => path.join(h, '.claude/ledger-root.json');
const logFile = (h: string): string => path.join(h, '.claude/ledger-root.log');

function environment(h: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: h, GIT_CONFIG_GLOBAL: path.join(h, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: path.dirname(h) };
}

async function ledger(h: string, clock: FakeClock, args: string[], { cwd = h, input }: { cwd?: string; input?: string } = {}): Promise<Ran> {
  try {
    return await runInProcessWith(h, cwd, { env: environment(h), clock, input }, ...args);
  } finally {
    resetGitLimits();
    limitCloneGitCalls(Infinity);
    limitLockWaits(Infinity);
  }
}

async function ok(h: string, clock: FakeClock, ...args: string[]): Promise<string> {
  const ran = await ledger(h, clock, args);
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stderr, '');
  return ran.stdout;
}

const localTime = (iso: string): string => {
  const at = new Date(iso);
  return [at.getHours(), at.getMinutes()].map((part) => String(part).padStart(2, '0')).join(':');
};
const at = (clock: FakeClock, minutes: number): string => new Date(clock.now().getTime() + minutes * MINUTE).toISOString();
const onLine = (minutes: number, untilIso: string): string => `Root override is on for ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, until ${localTime(untilIso)}.\n`;
const OFF_LINE = 'Root override is off.\n';

// The CLI

test('ledger root on switches the override on for 30 minutes and writes the marker', async (t) => {
  const h = home(t);
  const clock = fakeClock(START);

  assert.equal(await ok(h, clock, 'root', 'on'), onLine(30, at(clock, 30)));
  assert.deepEqual(JSON.parse(readFileSync(marker(h), 'utf8')), { since: '2026-11-27T10:00:00.000Z', until: '2026-11-27T10:30:00.000Z', untilEpoch: Date.parse('2026-11-27T10:30:00Z') / 1000 });
});

test('ledger root on --minutes N takes a whole number from 1 to 240', async (t) => {
  const h = home(t);
  const clock = fakeClock(START);

  assert.equal(await ok(h, clock, 'root', 'on', '--minutes', '1'), onLine(1, at(clock, 1)));
  assert.equal(await ok(h, clock, 'root', 'on', '--minutes', '240'), onLine(240, at(clock, 240)));
});

for (const minutes of ['0', '241', 'abc', '1.5', '-3', '']) {
  test(`ledger root on --minutes "${minutes}" fails and writes no marker`, async (t) => {
    const h = home(t);
    const ran = await ledger(h, fakeClock(START), ['root', 'on', `--minutes=${minutes}`]);

    assert.notEqual(ran.status, 0);
    assert.equal(ran.stdout, '');
    assert.match(ran.stderr, /--minutes takes a whole number from 1 to 240/);
    assert.equal(existsSync(marker(h)), false);
  });
}

test('ledger root on again replaces the end time and keeps when it was switched on', async (t) => {
  const h = home(t);
  const clock = fakeClock(START);
  await ok(h, clock, 'root', 'on');
  clock.advance(10 * MINUTE);

  assert.equal(await ok(h, clock, 'root', 'on', '--minutes', '5'), onLine(5, at(clock, 5)));
  const written = JSON.parse(readFileSync(marker(h), 'utf8')) as { since: string; until: string };
  assert.equal(written.since, '2026-11-27T10:00:00.000Z');
  assert.equal(written.until, '2026-11-27T10:15:00.000Z');
  assert.equal(await ok(h, clock, 'root', 'status'), onLine(5, at(clock, 5)));
});

test('ledger root status gives the minutes left, rounded up, and is off once the time is up', async (t) => {
  const h = home(t);
  const clock = fakeClock(START);
  assert.equal(await ok(h, clock, 'root', 'status'), OFF_LINE);
  await ok(h, clock, 'root', 'on');
  const until = at(clock, 30);

  clock.advance(10 * MINUTE + 30_000);
  assert.equal(await ok(h, clock, 'root', 'status'), onLine(20, until));
  clock.advance(19 * MINUTE + 29_000);
  assert.equal(await ok(h, clock, 'root', 'status'), onLine(1, until));
  clock.advance(1_000);
  assert.equal(await ok(h, clock, 'root', 'status'), OFF_LINE);
});

test('an unreadable marker is off', async (t) => {
  const h = home(t);
  const clock = fakeClock(START);
  for (const text of ['not json', '{}', '{"untilEpoch":"soon"}', '[]']) {
    writeFileSync(marker(h), text);
    assert.equal(await ok(h, clock, 'root', 'status'), OFF_LINE, text);
  }
});

test('ledger root off removes the marker, and says so again when it is already off', async (t) => {
  const h = home(t);
  const clock = fakeClock(START);
  await ok(h, clock, 'root', 'on');

  assert.equal(await ok(h, clock, 'root', 'off'), OFF_LINE);
  assert.equal(existsSync(marker(h)), false);
  assert.equal(await ok(h, clock, 'root', 'off'), OFF_LINE);
  assert.equal(await ok(h, clock, 'root', 'status'), OFF_LINE);
});

test('ledger root --help explains on, off and status in plain words', async (t) => {
  const h = home(t);
  const help = await ok(h, fakeClock(START), 'root', '--help');
  for (const command of ['on', 'off', 'status']) assert.match(help, new RegExp(`^  ${command}\\b.*\\S`, 'm'), command);
  assert.match(await ok(h, fakeClock(START), 'root', 'on', '--help'), /--minutes <n>/);
  assert.match(await ok(h, fakeClock(START), '--help'), /^  root\b/m);
});

// The pre-tool-use gates

type ToolInput = { file_path: string; content?: string } | { command: string };
type LoggedAction = { at: string; tool: string; cwd: string; reason: string; command?: string; file?: string };

async function gate(h: string, clock: FakeClock, cwd: string, toolName: string, toolInput: ToolInput): Promise<string> {
  const ran = await ledger(h, clock, ['hook', 'pre-tool-use'], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, cwd }) });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stderr, '');
  return ran.stdout;
}

function denied(stdout: string): string {
  assert.notEqual(stdout, '', 'expected a deny decision, got silence');
  const output = (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'deny');
  return output.permissionDecisionReason;
}

const logged = (h: string): LoggedAction[] =>
  existsSync(logFile(h))
    ? readFileSync(logFile(h), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as LoggedAction)
    : [];

/** A main checkout <h>/main with the worktree of task `task`, whose ledger is not archived. */
function world(t: TestContext): { h: string; main: string; task: string } {
  const h = home(t);
  const main = repository(h, path.join(h, 'main'));
  worktreeTask(h, main, { slug: 'task', main });
  return { h, main, task: path.join(main, '.claude/worktrees/task') };
}

const removal = (task: string): ToolInput => ({ command: `git worktree remove ${task}` });
const STORE_COMMAND = 'touch ~/.claude/ledger-active/x.json';

const cases = [
  { gate: 'worktree removal', tool: 'Bash', input: ({ task }: { task: string; main: string }): ToolInput => removal(task), reason: /^This would remove a worktree whose task ledger is not archived/ },
  { gate: 'ledger write', tool: 'Write', input: ({ main }: { task: string; main: string }): ToolInput => ({ file_path: path.join(main, '.claude/ledger.md'), content: 'x' }), reason: /^Task ledgers are kept in the ledger store/ },
  { gate: 'store write', tool: 'Bash', input: (): ToolInput => ({ command: STORE_COMMAND }), reason: /^The ledger store is changed only by the ledger tool/ },
];

for (const { gate: name, tool, input, reason } of cases) {
  test(`the ${name} gate allows its call while root is on, and logs it`, async (t) => {
    const w = world(t);
    const clock = fakeClock(START);
    const toolInput = input(w);
    assert.match(denied(await gate(w.h, clock, w.main, tool, toolInput)), reason);
    assert.deepEqual(logged(w.h), []);

    await ok(w.h, clock, 'root', 'on');
    clock.advance(MINUTE);
    assert.equal(await gate(w.h, clock, w.main, tool, toolInput), '');

    const [entry, ...more] = logged(w.h);
    assert.deepEqual(more, []);
    assert.deepEqual(Object.keys(entry), ['at', 'tool', 'cwd', 'reason', 'command' in toolInput ? 'command' : 'file']);
    assert.equal(entry.at, '2026-11-27T10:01:00Z');
    assert.equal(entry.tool, tool);
    assert.equal(entry.cwd, w.main);
    assert.match(entry.reason, reason);
    if ('command' in toolInput) assert.equal(entry.command, toolInput.command);
    else assert.equal(entry.file, toolInput.file_path);
  });

  test(`the ${name} gate denies again once root has expired or is off`, async (t) => {
    const w = world(t);
    const clock = fakeClock(START);
    const toolInput = input(w);
    await ok(w.h, clock, 'root', 'on', '--minutes', '5');
    clock.advance(5 * MINUTE);
    assert.match(denied(await gate(w.h, clock, w.main, tool, toolInput)), reason);

    await ok(w.h, clock, 'root', 'on');
    await ok(w.h, clock, 'root', 'off');
    assert.match(denied(await gate(w.h, clock, w.main, tool, toolInput)), reason);
    assert.deepEqual(logged(w.h), []);
  });
}

const SWITCH_REASON = 'Only the operator can switch the ledger root override on, by typing /ledger:root. Ask the operator to type it.';

const SWITCH_COMMANDS = [
  'ledger root on',
  'ledger root on --minutes 60',
  `${LEDGER_BIN} root on`,
  '~/.claude/bin/ledger root on',
  '"$HOME"/.claude/bin/ledger root on',
  'bin/ledger root on',
  'cd /tmp && ledger root on',
  'echo hi; ledger   root   on',
  'FORCE=1 ledger root on',
  'env ledger root on',
  'sudo ledger root on',
  "ledger 'root' on",
  'echo "$(ledger root on)"',
];

const MARKER_WRITES = [
  `echo '{"untilEpoch":9999999999}' > ~/.claude/ledger-root.json`,
  'printf x | tee "$HOME/.claude/ledger-root.json"',
  'cp /tmp/x ~/.claude/ledger-root.json',
  'mv /tmp/x ~/.claude/ledger-root.json',
  'cp /tmp/ledger-root.json ~/.claude/',
  "sed -i '' s/1/2/ ~/.claude/ledger-root.json",
  'cd ~/.claude && printf x >ledger-root.json',
  'ln -s /tmp/x ~/.claude/ledger-root.json',
];

for (const rootOn of [false, true]) {
  const state = rootOn ? 'while root is on' : 'while root is off';

  test(`an agent's ledger root on is denied ${state}`, async (t) => {
    const h = home(t);
    const clock = fakeClock(START);
    if (rootOn) await ok(h, clock, 'root', 'on');
    for (const command of SWITCH_COMMANDS) assert.equal(denied(await gate(h, clock, h, 'Bash', { command })), SWITCH_REASON, command);
    assert.deepEqual(logged(h), []);
  });

  test(`a write of the root marker is denied ${state}, by a file tool or by Bash`, async (t) => {
    const h = home(t);
    const clock = fakeClock(START);
    if (rootOn) await ok(h, clock, 'root', 'on');
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      assert.equal(denied(await gate(h, clock, h, tool, { file_path: marker(h), content: '{}' })), SWITCH_REASON, tool);
      assert.equal(denied(await gate(h, clock, path.join(h, '.claude'), tool, { file_path: 'ledger-root.json', content: '{}' })), SWITCH_REASON, tool);
    }
    for (const command of MARKER_WRITES) assert.equal(denied(await gate(h, clock, h, 'Bash', { command })), SWITCH_REASON, command);
    assert.deepEqual(logged(h), []);
  });
}

test('ledger root off and status, a removal or read of the marker, and text that only names ledger root on are allowed', async (t) => {
  const h = home(t);
  const clock = fakeClock(START);
  await ok(h, clock, 'root', 'on');
  const commands = [
    'ledger root off',
    '~/.claude/bin/ledger root status',
    'rm ~/.claude/ledger-root.json',
    'rm -f "$HOME/.claude/ledger-root.json"',
    'cat ~/.claude/ledger-root.json',
    'echo ledger root on',
    'git commit -m "Add ledger root on"',
    'grep -n "ledger root on" README.md',
    'ledger root --help',
  ];
  for (const command of commands) assert.equal(await gate(h, clock, h, 'Bash', { command }), '', command);
  assert.equal(await gate(h, clock, h, 'Write', { file_path: path.join(h, '.claude/ledger-root.json.bak'), content: '' }), '');
  assert.deepEqual(logged(h), []);
});

// session-start

async function sessionStart(h: string, clock: FakeClock, cwd: string): Promise<string> {
  const ran = await ledger(h, clock, ['hook', 'session-start'], { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd }) });
  assert.equal(ran.status, 0, ran.stderr);
  if (ran.stdout === '') return '';
  return (JSON.parse(ran.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
}

test('session-start lists each call allowed only because root was on, once', async (t) => {
  const w = world(t);
  const clock = fakeClock(START);
  const plain = path.join(w.h, 'plain');
  mkdirSync(plain);
  assert.equal(await sessionStart(w.h, clock, plain), '');

  await ok(w.h, clock, 'root', 'on');
  const long = `${STORE_COMMAND} && echo ${'x'.repeat(120)}`;
  await gate(w.h, clock, w.main, 'Bash', removal(w.task));
  clock.advance(MINUTE);
  await gate(w.h, clock, w.main, 'Write', { file_path: path.join(w.main, '.claude/ledger.md'), content: 'x' });
  await gate(w.h, clock, w.main, 'Bash', { command: long });

  // A command keeps its start and a file its end, each at most 80 characters; a temp folder alone can be longer.
  const head = (text: string): string => (text.length <= 80 ? text : `${text.slice(0, 79)}…`);
  const tail = (text: string): string => (text.length <= 80 ? text : `…${text.slice(-79)}`);
  assert.equal(
    await sessionStart(w.h, clock, plain),
    [
      'Allowed only because ledger root was on:',
      `- 2026-11-27T10:00:00Z Bash: ${head(`git worktree remove ${w.task}`)} — This would remove a worktree whose task ledger is not archived: ${w.task}`,
      `- 2026-11-27T10:01:00Z Write: ${tail(path.join(w.main, '.claude/ledger.md'))} — Task ledgers are kept in the ledger store, not in .claude/ledger.md.`,
      `- 2026-11-27T10:01:00Z Bash: ${head(long)} — The ledger store is changed only by the ledger tool, not by hand.`,
    ].join('\n'),
  );
  assert.equal(await sessionStart(w.h, clock, plain), '');

  await gate(w.h, clock, w.main, 'Bash', { command: STORE_COMMAND });
  assert.equal(
    await sessionStart(w.h, clock, plain),
    ['Allowed only because ledger root was on:', `- 2026-11-27T10:01:00Z Bash: ${STORE_COMMAND} — The ledger store is changed only by the ledger tool, not by hand.`].join('\n'),
  );
});

// The status line

test('ledger statusline adds ROOT <minutes>m while root is on, after the task, and alone outside a task', async (t) => {
  const w = world(t);
  const clock = fakeClock(START);
  const task = await ok(w.h, clock, 'statusline', w.task);
  assert.notEqual(task, '');
  assert.equal(await ok(w.h, clock, 'statusline', w.h), '');

  await ok(w.h, clock, 'root', 'on');
  clock.advance(90_000);
  assert.equal(await ok(w.h, clock, 'statusline', w.task), `${task.trimEnd()} · ROOT 29m\n`);
  assert.equal(await ok(w.h, clock, 'statusline', w.h), 'ROOT 29m\n');

  clock.advance(29 * MINUTE);
  assert.equal(await ok(w.h, clock, 'statusline', w.task), task);
  assert.equal(await ok(w.h, clock, 'statusline', w.h), '');
});
