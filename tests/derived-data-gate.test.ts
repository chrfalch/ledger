import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { REPO } from './helpers.js';

const DERIVED_DATA_GATE = path.join(REPO, 'hooks/derived-data-gate.sh');
const CC_DD_PATH = path.join(REPO, 'bin/cc-dd-path');

function environment(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    GIT_CONFIG_GLOBAL: path.join(root, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: path.dirname(root),
  };
}

function run(root: string, cwd: string, command: string, args: string[], input?: string) {
  return spawnSync(command, args, { cwd, env: environment(root), input, encoding: 'utf8' });
}

function ccDdPath(root: string, cwd: string, ...args: string[]) {
  return run(root, cwd, 'bash', [CC_DD_PATH, ...args]);
}

function printedPath(root: string, cwd: string, config = 'Debug-sim'): string {
  const result = ccDdPath(root, cwd, config);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A git repository at <root>/<name> on which cc-dd-path has not run yet. */
function initialized(root: string, name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir);
  assert.equal(run(root, dir, 'git', ['init', '--quiet']).status, 0);
  return dir;
}

function repository(root: string, name: string): { dir: string; buildFolder: string } {
  const dir = initialized(root, name);
  return { dir, buildFolder: printedPath(root, dir) };
}

/** A linked worktree of `main` at <main>/.claude/worktrees/<name>. */
function worktree(root: string, main: string, name: string): { dir: string; buildFolder: string } {
  const identity = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
  assert.equal(run(root, main, 'git', [...identity, 'commit', '--quiet', '--allow-empty', '-m', 'first']).status, 0);
  const dir = path.join(main, '.claude/worktrees', name);
  const added = run(root, main, 'git', ['worktree', 'add', '--quiet', '-b', name, dir]);
  assert.equal(added.status, 0, added.stderr);
  return { dir, buildFolder: printedPath(root, dir) };
}

const EXCLUDE_LINE = '/.claude/worktrees/.build/';

const excludeLines = (main: string): string[] => readFileSync(path.join(main, '.git/info/exclude'), 'utf8').split('\n');

/** A session repository and a separate app repository, both inside one temp HOME. */
function repositories(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ledger-derived-data-gate-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, '.gitconfig'), '');
  return { root, session: repository(root, 'session'), app: repository(root, 'app') };
}

function gate(root: string, cwd: string, command: string): string {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
  const result = run(root, root, 'bash', [DERIVED_DATA_GATE], input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

function assertDenied(stdout: string): string {
  assert.notEqual(stdout, '', 'expected a deny decision, got silence');
  const output = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PreToolUse');
  assert.equal(output.permissionDecision, 'deny');
  return output.permissionDecisionReason;
}

function assertAllowed(stdout: string): void {
  assert.equal(stdout, '', `expected silence, got ${stdout}`);
}

test('cc-dd-path in a main checkout prints and creates <main>/.claude/worktrees/.build/.main/<configuration>', (t) => {
  const { session } = repositories(t);
  assert.equal(session.buildFolder, path.join(session.dir, '.claude/worktrees/.build/.main/Debug-sim'));
  assert.ok(statSync(session.buildFolder).isDirectory());
});

test('cc-dd-path in a linked worktree names the folder after the worktree, beside the worktrees of the main checkout', (t) => {
  const { root, session } = repositories(t);
  const linked = worktree(root, session.dir, 'fix-login');
  assert.equal(linked.buildFolder, path.join(session.dir, '.claude/worktrees/.build/fix-login/Debug-sim'));
  assert.ok(statSync(linked.buildFolder).isDirectory());
  mkdirSync(path.join(linked.dir, 'ios/App'), { recursive: true });
  assert.equal(printedPath(root, path.join(linked.dir, 'ios/App'), 'Release-sim'), path.join(session.dir, '.claude/worktrees/.build/fix-login/Release-sim'));
});

test('cc-dd-path gives each repository its own folder', (t) => {
  const { session, app } = repositories(t);
  assert.equal(app.buildFolder, path.join(app.dir, '.claude/worktrees/.build/.main/Debug-sim'));
  assert.notEqual(app.buildFolder, session.buildFolder);
});

test('cc-dd-path run only in a linked worktree hides the build folders from git through the shared info/exclude, and adds the line only once', (t) => {
  const { root } = repositories(t);
  const main = initialized(root, 'fresh');
  const linked = worktree(root, main, 'fix-login');
  writeFileSync(path.join(printedPath(root, linked.dir, 'Release-sim'), 'info.plist'), '');
  assert.equal(excludeLines(main).filter((line) => line === EXCLUDE_LINE).length, 1);
  for (const checkout of [main, linked.dir]) {
    const status = run(root, checkout, 'git', ['status', '--porcelain', '--untracked-files=all']);
    assert.doesNotMatch(status.stdout, /\.build/);
  }
});

test('cc-dd-path creates info/exclude when it is missing, and keeps the last line of one without a final newline', (t) => {
  const { root, session, app } = repositories(t);
  rmSync(path.join(session.dir, '.git/info'), { recursive: true, force: true });
  printedPath(root, session.dir);
  assert.deepEqual(excludeLines(session.dir), [EXCLUDE_LINE, '']);
  writeFileSync(path.join(app.dir, '.git/info/exclude'), 'build/');
  printedPath(root, app.dir);
  assert.deepEqual(excludeLines(app.dir), ['build/', EXCLUDE_LINE, '']);
});

test('cc-dd-path without a configuration prints its usage and exits 1', (t) => {
  const { root, session } = repositories(t);
  const result = ccDdPath(root, session.dir);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'usage: cc-dd-path <configuration>\n');
  assert.equal(result.stdout, '');
});

test('cc-dd-path refuses a configuration that is not one plain folder name, and creates nothing', (t) => {
  const { root, session } = repositories(t);
  const buildRoot = path.join(session.dir, '.claude/worktrees/.build');
  for (const config of ['../sibling', '.', '..', '.hidden', 'Debug/sim', 'Debug sim', '$D']) {
    const result = ccDdPath(root, session.dir, config);
    assert.notEqual(result.status, 0, config);
    assert.equal(result.stdout, '', config);
    assert.match(result.stderr, /usage: cc-dd-path <configuration>/, config);
  }
  assert.deepEqual(readdirSync(buildRoot), ['.main']);
  assert.deepEqual(readdirSync(path.join(buildRoot, '.main')), ['Debug-sim']);
  assert.equal(printedPath(root, session.dir, 'Release_1.2-sim'), path.join(buildRoot, '.main/Release_1.2-sim'));
});

test('the session build folder is allowed', (t) => {
  const { root, session } = repositories(t);
  assertAllowed(gate(root, session.dir, `xcodebuild -derivedDataPath ${session.buildFolder}`));
});

test('a build folder elsewhere is denied, and the reason names the folder to use', (t) => {
  const { root, session } = repositories(t);
  const reason = assertDenied(gate(root, session.dir, 'xcodebuild -derivedDataPath /tmp/x'));
  const own = path.join(session.dir, '.claude/worktrees/.build/.main');
  assert.ok(reason.includes(`${own}/<configuration>`), reason);
  assert.ok(reason.includes(`${own}/Debug-sim`), reason);
});

test('a build folder in Xcode DerivedData is denied', (t) => {
  const { root, session } = repositories(t);
  const old = 'Library/Developer/Xcode/DerivedData/cc-session-123abc-Debug-sim';
  assertDenied(gate(root, session.dir, `xcodebuild -derivedDataPath ${path.join(root, old)}`));
  assertDenied(gate(root, session.dir, `xcodebuild -derivedDataPath ~/${old}`));
});

test('a linked worktree build folder is allowed in that worktree, and the main checkout folder is denied there', (t) => {
  const { root, session } = repositories(t);
  const linked = worktree(root, session.dir, 'fix-login');
  assertAllowed(gate(root, linked.dir, `xcodebuild -derivedDataPath ${linked.buildFolder}`));
  const reason = assertDenied(gate(root, linked.dir, `xcodebuild -derivedDataPath ${session.buildFolder}`));
  assert.ok(reason.includes(path.join(session.dir, '.claude/worktrees/.build/fix-login/Debug-sim')), reason);
  assertDenied(gate(root, session.dir, `xcodebuild -derivedDataPath ${linked.buildFolder}`));
});

test('only a configuration folder inside the own build folder is allowed', (t) => {
  const { root, session } = repositories(t);
  const own = path.dirname(session.buildFolder);
  assertAllowed(gate(root, session.dir, `xcodebuild -derivedDataPath ${own}/Release-device`));
  const others = [own, `${own}/`, `${own}/../fix-login/Debug-sim`, `${own}/..`, `${own}-other/Debug-sim`, path.join(path.dirname(own), 'fix-login/Debug-sim')];
  for (const other of others) assertDenied(gate(root, session.dir, `xcodebuild -derivedDataPath ${other}`));
});

test('a build folder that is not one plain configuration folder in the own build folder is denied', (t) => {
  const { root, session } = repositories(t);
  const own = path.dirname(session.buildFolder);
  const others = [`${own}/.`, `${own}/.hidden`, `${own}/Debug-sim/Build`, `${own}//Debug-sim`, `${session.buildFolder}/`, `${own}/$CONFIG`, `${own}/\`echo Debug-sim\``, `'${own}/$CONFIG'`];
  for (const other of others) assertDenied(gate(root, session.dir, `xcodebuild -derivedDataPath ${other}`));
});

test('every -derivedDataPath in the command is checked, in each spelling of the flag and its value', (t) => {
  const { root, session } = repositories(t);
  const own = session.buildFolder;
  const allowed = [`-derivedDataPath=${own}`, `-derivedDataPath="${own}"`, `-derivedDataPath='${own}'`, `-derivedDataPath\t${own}`, `-derivedDataPath ${own} -derivedDataPath ${own}`, `-derivedDataPath ${own}; echo done`];
  for (const flags of allowed) assertAllowed(gate(root, session.dir, `xcodebuild ${flags}`));
  const denied = [
    `-derivedDataPath ${own} -derivedDataPath /tmp/x`,
    `-derivedDataPath=${own} -derivedDataPath=/tmp/x`,
    `-derivedDataPath ${own} -derivedDataPath='/tmp/x'`,
    `-derivedDataPath ${own} -derivedDataPath="/tmp/x"`,
    `-derivedDataPath\t/tmp/x`,
    `-derivedDataPath ${own} "-derivedDataPath" /tmp/x`,
    `-derivedDataPath ${own} '-derivedDataPath' /tmp/x`,
  ];
  for (const flags of denied) assertDenied(gate(root, session.dir, `xcodebuild ${flags}`));
});

test('the app build folder is allowed when -workspace names the app', (t) => {
  const { root, session, app } = repositories(t);
  const workspace = path.join(app.dir, 'App.xcworkspace');
  assertAllowed(gate(root, session.dir, `xcodebuild -workspace ${workspace} -derivedDataPath ${app.buildFolder}`));
});

test('the app build folder is allowed when -project names the app', (t) => {
  const { root, session, app } = repositories(t);
  const project = path.join(app.dir, 'App.xcodeproj');
  assertAllowed(gate(root, session.dir, `xcodebuild -project ${project} -derivedDataPath ${app.buildFolder}`));
});

test('the app build folder is allowed after a leading cd into the app', (t) => {
  const { root, session, app } = repositories(t);
  const command = `cd ${app.dir} && xcodebuild -project App.xcodeproj -derivedDataPath ${app.buildFolder}`;
  assertAllowed(gate(root, session.dir, command));
});

test('the session build folder is denied when -workspace names the app', (t) => {
  const { root, session, app } = repositories(t);
  const workspace = path.join(app.dir, 'App.xcworkspace');
  assertDenied(gate(root, session.dir, `xcodebuild -workspace ${workspace} -derivedDataPath ${session.buildFolder}`));
});

test('a build folder in a shell variable is denied with the reason', (t) => {
  const { root, session } = repositories(t);
  const reason = assertDenied(gate(root, session.dir, 'xcodebuild -derivedDataPath $D'));
  assert.match(reason, /in full/);
  assert.match(reason, /shell variable/);
});

test('a command without -derivedDataPath is allowed', (t) => {
  const { root, session } = repositories(t);
  assertAllowed(gate(root, session.dir, 'xcodebuild -workspace /tmp/App.xcworkspace build'));
});

test('a build folder elsewhere is denied when -workspace names a shell variable', (t) => {
  const { root, session } = repositories(t);
  assertDenied(gate(root, session.dir, 'xcodebuild -workspace $APP/A.xcworkspace -derivedDataPath /tmp/x'));
});

test('a build folder elsewhere is denied when -workspace names a missing folder', (t) => {
  const { root, session } = repositories(t);
  assertDenied(gate(root, session.dir, 'xcodebuild -workspace /nonexistent/A.xcworkspace -derivedDataPath /tmp/x'));
});

test('the app build folder is allowed when -workspace starts with ~', (t) => {
  const { root, session, app } = repositories(t);
  const command = `xcodebuild -workspace ~/app/App.xcworkspace -derivedDataPath ${app.buildFolder}`;
  assertAllowed(gate(root, session.dir, command));
});

test('the app build folder is allowed after a leading cd into a path that starts with ~', (t) => {
  const { root, session, app } = repositories(t);
  const command = `cd ~/app && xcodebuild -project App.xcodeproj -derivedDataPath ${app.buildFolder}`;
  assertAllowed(gate(root, session.dir, command));
});

test('the app build folder is allowed when a quoted -workspace path has a space', (t) => {
  const { root, session } = repositories(t);
  const app = repository(root, 'my app');
  const workspace = path.join(app.dir, 'App.xcworkspace');
  assertAllowed(gate(root, session.dir, `xcodebuild -workspace "${workspace}" -derivedDataPath "${app.buildFolder}"`));
  assertAllowed(gate(root, session.dir, `xcodebuild -workspace '${workspace}' -derivedDataPath '${app.buildFolder}'`));
});

const nowEpoch = (): number => Math.floor(Date.now() / 1000);

/** The marker `ledger root on` writes, switched on now and ending at `untilEpoch`, or `text` as the marker, in the .claude folder of HOME `root`. */
function rootMarker(root: string, untilEpoch: number | string): void {
  mkdirSync(path.join(root, '.claude'), { recursive: true });
  const iso = (epoch: number): string => new Date(epoch * 1000).toISOString();
  const sinceEpoch = nowEpoch();
  const text = typeof untilEpoch === 'string' ? untilEpoch : JSON.stringify({ since: iso(sinceEpoch), sinceEpoch, until: iso(untilEpoch), untilEpoch });
  writeFileSync(path.join(root, '.claude/ledger-root.json'), text);
}

const rootLog = (root: string): string => path.join(root, '.claude/ledger-root.log');

test('a build folder elsewhere is allowed while ledger root is on, and the call is logged', (t) => {
  const { root, session } = repositories(t);
  rootMarker(root, Math.floor(Date.now() / 1000) + 3600);
  const command = 'xcodebuild -derivedDataPath /tmp/x';
  const before = Math.floor(Date.now() / 1000) * 1000;

  assertAllowed(gate(root, session.dir, command));

  const lines = readFileSync(rootLog(root), 'utf8').split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(entry), ['at', 'tool', 'cwd', 'reason', 'command']);
  assert.match(entry.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.ok(Date.parse(entry.at) >= before && Date.parse(entry.at) <= Date.now(), entry.at);
  assert.equal(entry.tool, 'Bash');
  assert.equal(entry.cwd, session.dir);
  assert.match(entry.reason, /^Build folder is not reusable: \/tmp\/x/);
  assert.equal(entry.command, command);
});

for (const [name, marker] of [
  ['has expired', Math.floor(Date.now() / 1000) - 60],
  ['is not JSON', 'not json'],
  ['has no untilEpoch', '{"until":"2999-01-01T00:00:00Z"}'],
  ['has an untilEpoch that is not a number', '{"untilEpoch":"9999999999"}'],
  ['ends more than 240 minutes after sinceEpoch', JSON.stringify({ sinceEpoch: nowEpoch(), untilEpoch: nowEpoch() + 241 * 60 })],
  ['has no sinceEpoch', JSON.stringify({ untilEpoch: nowEpoch() + 60 })],
  ['has a sinceEpoch that is not a number', JSON.stringify({ sinceEpoch: String(nowEpoch()), untilEpoch: nowEpoch() + 60 })],
  ['has a sinceEpoch in the future', JSON.stringify({ sinceEpoch: nowEpoch() + 600, untilEpoch: nowEpoch() + 1200 })],
  ['has an untilEpoch that is not finite', `{"sinceEpoch":${nowEpoch()},"untilEpoch":1e999}`],
] as const) {
  test(`a build folder elsewhere is still denied when the ledger root marker ${name}`, (t) => {
    const { root, session } = repositories(t);
    rootMarker(root, marker);
    assertDenied(gate(root, session.dir, 'xcodebuild -derivedDataPath /tmp/x'));
    assert.throws(() => readFileSync(rootLog(root)), { code: 'ENOENT' });
  });
}
