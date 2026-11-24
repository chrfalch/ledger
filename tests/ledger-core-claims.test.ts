import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { parseHookInput } from '../tools/ledger/hooks.js';
import { activeFile, archivedTask, backlogTask, commandEnv, home, LEDGER_BIN, readLedgerFile, repository, storeFolder, worktreeOf, worktreeTask, writeLedgerFile, type Ran } from './ledger-core-fixtures.js';

const T0 = '2026-11-20T10:00:00Z';
const later = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString().replace('.000Z', 'Z');
const claimLine = (session: string, since: string, active: string): string => `- claim: session ${session} since ${since}, active ${active}`;
const CLAIM_LINE = /^- claim: .*$/m;

/** ~/repos/app with the active task fix-login, whose .claude/ git ignores; `file` is its active record. */
function setup(t: TestContext) {
  const h = home(t);
  const app = repository(h, path.join(h, 'repos/app'));
  writeFileSync(path.join(app, '.git/info/exclude'), '.claude/\n');
  const file = worktreeTask(h, app, { slug: 'fix-login' });
  return { h, app, file, worktree: worktreeOf(app, 'fix-login') };
}

type Env = { now?: string; session?: string; input?: string };

/** `ledger` at the time `now`, in the session `session`; neither comes from the environment the tests run in. */
function run(h: string, cwd: string, { now, session, input }: Env, ...args: string[]): Ran {
  const env = commandEnv(h);
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.LEDGER_NOW;
  if (now !== undefined) env.LEDGER_NOW = now;
  if (session !== undefined) env.CLAUDE_CODE_SESSION_ID = session;
  const result = spawnSync(LEDGER_BIN, args, { cwd, env, encoding: 'utf8', input: input ?? '' });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function exits(ran: Ran, status: number): Ran {
  assert.equal(ran.status, status, `exit ${status} expected; stdout:\n${ran.stdout}\nstderr:\n${ran.stderr}`);
  return ran;
}

const claimOf = (file: string): string | undefined => CLAIM_LINE.exec(readLedgerFile(file))?.[0];

function withClaim(file: string, line: string): void {
  const text = readLedgerFile(file);
  writeLedgerFile(file, text.replace('- design refs: none\n', `- design refs: none\n${line}\n`));
}

test('claim with no claim writes one for this session, since and active now, and prints claimed <slug>', (t) => {
  const { h, app, file } = setup(t);
  const before = readLedgerFile(file);
  const ran = exits(run(h, app, { now: T0 }, 'task', 'claim', 'fix-login', '--session', 's1'), 0);
  assert.equal(ran.stdout, 'claimed fix-login\n');
  assert.equal(claimOf(file), claimLine('s1', T0, T0));
  assert.equal(readLedgerFile(file).replace(`${claimLine('s1', T0, T0)}\n`, ''), before, 'only the claim bullet is added');
});

test('claim with no slug claims the task of the worktree it runs in, and takes the session from CLAUDE_CODE_SESSION_ID', (t) => {
  const { h, file, worktree } = setup(t);
  exits(run(h, worktree, { now: T0, session: 'env-session' }, 'task', 'claim'), 0);
  assert.equal(claimOf(file), claimLine('env-session', T0, T0));
});

test('--session wins over CLAUDE_CODE_SESSION_ID; with neither, every claim command exits 2 with one line and writes nothing', (t) => {
  const { h, file, worktree } = setup(t);
  exits(run(h, worktree, { now: T0, session: 'env-session' }, 'task', 'claim', '--session', 'flag-session'), 0);
  assert.equal(claimOf(file), claimLine('flag-session', T0, T0));
  const text = readLedgerFile(file);
  for (const command of ['claim', 'touch', 'release']) {
    const ran = exits(run(h, worktree, { now: later(30) }, 'task', command), 2);
    assert.match(ran.stderr, /--session/);
    assert.equal(ran.stderr.trimEnd().split('\n').length, 1, ran.stderr);
    assert.equal(readLedgerFile(file), text, command);
  }
});

test('claim by the session that holds it keeps since and sets active to now', (t) => {
  const { h, app, file } = setup(t);
  withClaim(file, claimLine('s1', T0, later(20)));
  assert.equal(exits(run(h, app, { now: later(50) }, 'task', 'claim', 'fix-login', '--session', 's1'), 0).stdout, 'claimed fix-login\n');
  assert.equal(claimOf(file), claimLine('s1', T0, later(50)));
});

test('claim of a task another session holds live exits 3, names the holder, and writes nothing; --json gives the holder as "held"', (t) => {
  const { h, app, file } = setup(t);
  withClaim(file, claimLine('s1', T0, later(10)));
  const text = readLedgerFile(file);
  const ran = exits(run(h, app, { now: later(129) }, 'task', 'claim', 'fix-login', '--session', 's2'), 3);
  assert.match(ran.stdout + ran.stderr, new RegExp(`^held: session s1 since ${T0}, active ${later(10)}$`, 'm'));
  const json = JSON.parse(exits(run(h, app, { now: later(129) }, 'task', 'claim', 'fix-login', '--session', 's2', '--json'), 3).stdout);
  assert.equal(json.ok, false);
  assert.deepEqual(json.held, { session: 's1', since: T0, active: later(10) });
  assert.equal(readLedgerFile(file), text);
});

test('a claim expires 120 minutes after its last activity: another session then claims the task with no warning, since now', (t) => {
  const { h, app, file } = setup(t);
  withClaim(file, claimLine('s1', T0, later(10)));
  exits(run(h, app, { now: later(130) }, 'task', 'claim', 'fix-login', '--session', 's2'), 0);
  assert.equal(claimOf(file), claimLine('s2', later(130), later(130)));
});

test('--take-over replaces a live claim of another session with this one, since now, and names the session it took over from', (t) => {
  const { h, app, file } = setup(t);
  withClaim(file, claimLine('s1', T0, later(10)));
  const ran = exits(run(h, app, { now: later(20) }, 'task', 'claim', 'fix-login', '--session', 's2', '--take-over'), 0);
  assert.equal(ran.stdout, 'took over fix-login from session s1\n');
  assert.equal(claimOf(file), claimLine('s2', later(20), later(20)));
  assert.equal(readLedgerFile(file).match(/^- claim:/gm)?.length, 1);
});

test('claimExpiryMinutes in ~/.claude/ledger-settings.json sets the expiry; any value but a positive whole number fails and names the key and the file', (t) => {
  const { h, app, file } = setup(t);
  const settings = path.join(h, '.claude/ledger-settings.json');
  writeFileSync(settings, JSON.stringify({ claimExpiryMinutes: 30 }));
  withClaim(file, claimLine('s1', T0, T0));
  exits(run(h, app, { now: later(29) }, 'task', 'claim', 'fix-login', '--session', 's2'), 3);
  exits(run(h, app, { now: later(30) }, 'task', 'claim', 'fix-login', '--session', 's2'), 0);
  for (const value of [0, -5, 1.5, '60', null, true]) {
    writeFileSync(settings, JSON.stringify({ storage: 'file', claimExpiryMinutes: value }));
    const ran = run(h, app, { now: later(40) }, 'task', 'claim', 'fix-login', '--session', 's3');
    assert.notEqual(ran.status, 0, String(value));
    assert.match(ran.stderr, /claimExpiryMinutes/, String(value));
    assert.match(ran.stderr, /ledger-settings\.json/, String(value));
  }
  assert.equal(claimOf(file), claimLine('s2', later(30), later(30)));
});

test('a backlog or retired task cannot be claimed: exit 2, and the message says the task is not active', (t) => {
  const { h, app } = setup(t);
  backlogTask(h, app, { slug: 'idea' });
  archivedTask(h, app, '2026-10-01', { slug: 'shipped' });
  for (const slug of ['idea', 'shipped']) {
    for (const command of ['claim', 'touch', 'release']) {
      const ran = exits(run(h, app, { now: T0, session: 's1' }, 'task', command, slug), 2);
      assert.match(ran.stderr, /not active/, `${command} ${slug}`);
    }
  }
  assert.doesNotMatch(readLedgerFile(path.join(storeFolder(h, 'ledger-backlog', app), 'idea.md')), /claim/);
});

test('touch sets active to now only when this session holds the claim and its active is 15 minutes old or more', (t) => {
  const { h, app, file } = setup(t);
  withClaim(file, claimLine('s1', T0, T0));
  const touch = (now: string, session = 's1'): Ran => exits(run(h, app, { now, session }, 'task', 'touch', 'fix-login'), 0);
  assert.equal(touch(later(14)).stdout, '');
  assert.equal(claimOf(file), claimLine('s1', T0, T0));
  touch(later(15));
  assert.equal(claimOf(file), claimLine('s1', T0, later(15)));
});

test('touch never claims: a task held by another session, an expired claim and no claim stay as they are, and it prints nothing', (t) => {
  const { h, app, file } = setup(t);
  const touch = (now: string, session: string): void => assert.equal(exits(run(h, app, { now, session }, 'task', 'touch', 'fix-login'), 0).stdout, '');
  touch(T0, 's1');
  assert.equal(claimOf(file), undefined);
  withClaim(file, claimLine('s1', T0, T0));
  touch(later(30), 's2');
  touch(later(500), 's1');
  assert.equal(claimOf(file), claimLine('s1', T0, T0));
});

test('release removes the claim of this session; for a claim of another session or none it prints not held by this session and changes nothing', (t) => {
  const { h, app, file } = setup(t);
  withClaim(file, claimLine('s1', T0, T0));
  const text = readLedgerFile(file);
  const release = (session: string): string => exits(run(h, app, { now: later(5), session }, 'task', 'release', 'fix-login'), 0).stdout;
  assert.equal(release('s2'), 'not held by this session\n');
  assert.equal(readLedgerFile(file), text);
  release('s1');
  assert.equal(claimOf(file), undefined);
  assert.equal(release('s1'), 'not held by this session\n');
});

test('release removes this session\'s own expired claim too', (t) => {
  const { h, app, file } = setup(t);
  withClaim(file, claimLine('s1', T0, T0));
  exits(run(h, app, { now: later(500), session: 's1' }, 'task', 'release', 'fix-login'), 0);
  assert.equal(claimOf(file), undefined);
});

/** fix-login and other claimed by s1, third by s2, and unclaimed with no claim at all. */
function claimedBySessions(t: TestContext, active = T0) {
  const repo = setup(t);
  const other = worktreeTask(repo.h, repo.app, { slug: 'other' });
  const third = worktreeTask(repo.h, repo.app, { slug: 'third' });
  const unclaimed = worktreeTask(repo.h, repo.app, { slug: 'unclaimed' });
  withClaim(repo.file, claimLine('s1', T0, active));
  withClaim(other, claimLine('s1', T0, active));
  withClaim(third, claimLine('s2', T0, active));
  return { ...repo, other, third, unclaimed };
}

const json = (ran: Ran): Record<string, unknown> => JSON.parse(exits(ran, 0).stdout);

test('touch --all marks every claim of this session in the repo active, and leaves the claims of other sessions', (t) => {
  const { h, app, file, other, third, unclaimed } = claimedBySessions(t);
  const untouched = [readLedgerFile(third), readLedgerFile(unclaimed)];
  const answer = json(run(h, app, { now: later(20) }, 'task', 'touch', '--all', '--session', 's1', '--json'));
  assert.equal(answer.ok, true);
  assert.deepEqual([...(answer.touched as string[])].sort(), ['fix-login', 'other']);
  assert.equal(claimOf(file), claimLine('s1', T0, later(20)));
  assert.equal(claimOf(other), claimLine('s1', T0, later(20)));
  assert.deepEqual([readLedgerFile(third), readLedgerFile(unclaimed)], untouched);
});

test('touch --all prints one touched <slug> line per claim it marked, and nothing when it marked none', (t) => {
  const { h, app } = claimedBySessions(t);
  assert.equal(exits(run(h, app, { now: later(14) }, 'task', 'touch', '--all', '--session', 's1'), 0).stdout, '');
  const lines = exits(run(h, app, { now: later(15) }, 'task', 'touch', '--all', '--session', 's1'), 0).stdout.trimEnd().split('\n');
  assert.deepEqual(lines.sort(), ['touched fix-login', 'touched other']);
});

test('touch --all keeps the 15-minute rule and does not revive an expired claim', (t) => {
  const { h, app, file } = claimedBySessions(t);
  assert.deepEqual(json(run(h, app, { now: later(14) }, 'task', 'touch', '--all', '--session', 's1', '--json')).touched, []);
  assert.deepEqual(json(run(h, app, { now: later(500) }, 'task', 'touch', '--all', '--session', 's1', '--json')).touched, []);
  assert.equal(claimOf(file), claimLine('s1', T0, T0));
});

test('touch --all for a session that holds no claim touches nothing', (t) => {
  const { h, app } = claimedBySessions(t);
  assert.deepEqual(json(run(h, app, { now: later(20) }, 'task', 'touch', '--all', '--session', 's9', '--json')).touched, []);
});

test('release --all removes every claim of this session in the repo, and leaves the claims of other sessions', (t) => {
  const { h, app, file, other, third, unclaimed } = claimedBySessions(t);
  const untouched = [readLedgerFile(third), readLedgerFile(unclaimed)];
  const answer = json(run(h, app, { now: later(5) }, 'task', 'release', '--all', '--session', 's1', '--json'));
  assert.equal(answer.ok, true);
  assert.deepEqual([...(answer.released as string[])].sort(), ['fix-login', 'other']);
  assert.equal(claimOf(file), undefined);
  assert.equal(claimOf(other), undefined);
  assert.deepEqual([readLedgerFile(third), readLedgerFile(unclaimed)], untouched);
});

test('release --all removes expired claims of this session too, and prints one released <slug> line each', (t) => {
  const { h, app, file, other } = claimedBySessions(t);
  const lines = exits(run(h, app, { now: later(500), session: 's1' }, 'task', 'release', '--all'), 0).stdout.trimEnd().split('\n');
  assert.deepEqual(lines.sort(), ['released fix-login', 'released other']);
  assert.equal(claimOf(file), undefined);
  assert.equal(claimOf(other), undefined);
});

test('release --all for a session that holds no claim releases nothing and prints nothing', (t) => {
  const { h, app } = claimedBySessions(t);
  assert.deepEqual(json(run(h, app, { now: later(5) }, 'task', 'release', '--all', '--session', 's9', '--json')).released, []);
  assert.equal(exits(run(h, app, { now: later(5) }, 'task', 'release', '--all', '--session', 's9'), 0).stdout, '');
});

test('--all with a slug is a usage error: exit 2, and no claim changes', (t) => {
  const { h, app, file, other } = claimedBySessions(t);
  const before = [readLedgerFile(file), readLedgerFile(other)];
  for (const command of ['touch', 'release']) {
    const ran = exits(run(h, app, { now: later(20) }, 'task', command, 'fix-login', '--all', '--session', 's1'), 2);
    assert.match(ran.stderr, /--all/, command);
  }
  assert.deepEqual([readLedgerFile(file), readLedgerFile(other)], before);
});

test('--all needs a session too: with none it exits 2 and changes nothing', (t) => {
  const { h, app, file } = claimedBySessions(t);
  const before = readLedgerFile(file);
  for (const command of ['touch', 'release']) exits(run(h, app, { now: later(20) }, 'task', command, '--all'), 2);
  assert.equal(readLedgerFile(file), before);
});

type Broken = ReturnType<typeof setup> & { broken: string; good: string };

/**
 * fix-login, m-broken and z-good claimed by s1, while m-broken's lock is a folder, which no command can take, so no claim
 * can be written to its record. The records share one folder, so taking writes from that folder would break all three.
 */
function withOneBrokenBetweenTwo(t: TestContext, check: (repo: Broken) => void): void {
  const repo = setup(t);
  const broken = worktreeTask(repo.h, repo.app, { slug: 'm-broken' });
  const good = worktreeTask(repo.h, repo.app, { slug: 'z-good' });
  for (const file of [repo.file, broken, good]) withClaim(file, claimLine('s1', T0, T0));
  mkdirSync(`${broken}.lock`);
  check({ ...repo, broken, good });
}

for (const [command, key, at] of [
  ['touch', 'touched', later(20)],
  ['release', 'released', later(5)],
] as const) {
  test(`${command} --all goes on past a task it cannot write, then exits 1 naming it; --json lists the tasks it did change`, (t) => {
    withOneBrokenBetweenTwo(t, ({ h, app, file, broken, good }) => {
      const answer = JSON.parse(exits(run(h, app, { now: at }, 'task', command, '--all', '--session', 's1', '--json'), 1).stdout);
      assert.equal(answer.ok, false);
      assert.match(answer.error, /m-broken/);
      assert.deepEqual([...answer[key]].sort(), ['fix-login', 'z-good']);
      const expected = command === 'touch' ? claimLine('s1', T0, later(20)) : undefined;
      assert.equal(claimOf(file), expected);
      assert.equal(claimOf(good), expected);
      assert.equal(claimOf(broken), claimLine('s1', T0, T0));
    });
  });
}

test('release --all without --json prints the tasks it released, and the failure on stderr', (t) => {
  withOneBrokenBetweenTwo(t, ({ h, app }) => {
    const ran = exits(run(h, app, { now: later(5), session: 's1' }, 'task', 'release', '--all'), 1);
    assert.deepEqual(ran.stdout.trimEnd().split('\n').sort(), ['released fix-login', 'released z-good']);
    assert.match(ran.stderr, /m-broken/);
  });
});

test('park removes the claim, whichever session holds it', (t) => {
  const { h, app, file } = setup(t);
  withClaim(file, claimLine('s1', T0, T0));
  exits(run(h, app, { now: later(1), session: 's2' }, 'task', 'park', 'fix-login', '--reason', 'waiting'), 0);
  assert.equal(claimOf(file), undefined);
  assert.match(readLedgerFile(file), /^- status: parked /m);
});

test('retire removes the claim, whichever session holds it: the archive copy has none', (t) => {
  const { h, app, file, worktree } = setup(t);
  withClaim(file, claimLine('s1', T0, T0));
  const expected = readLedgerFile(file).replace(`${claimLine('s1', T0, T0)}\n`, '');
  exits(run(h, worktree, { now: later(1), session: 's2' }, 'task', 'retire'), 0);
  const [copy] = readdirSync(storeFolder(h, 'ledger-archive', app));
  assert.equal(readLedgerFile(path.join(storeFolder(h, 'ledger-archive', app), copy)), expected);
  assert.equal(existsSync(worktree), false);
});

test('go to a task another session holds live exits 3 with the holder, and changes nothing; --json adds "held"', (t) => {
  const { h, app, file } = setup(t);
  writeLedgerFile(file, readLedgerFile(file).replace('## Next step\n', '## Next step\nParked: 2026-11-19 — waiting\n'));
  withClaim(file, claimLine('s1', T0, later(10)));
  const text = readLedgerFile(file);
  for (const env of [{ session: 's2' }, {}]) {
    const ran = exits(run(h, app, { now: later(20), ...env }, 'go', 'fix-login'), 3);
    assert.match(ran.stdout + ran.stderr, new RegExp(`^held: session s1 since ${T0}, active ${later(10)}$`, 'm'));
  }
  exits(run(h, app, { now: later(20) }, 'go', 'fix-login', '--session', 's2'), 3);
  const json = JSON.parse(exits(run(h, app, { now: later(20), session: 's2' }, 'go', 'fix-login', '--json'), 3).stdout);
  assert.equal(json.ok, false);
  assert.deepEqual(json.held, { session: 's1', since: T0, active: later(10) });
  assert.equal(readLedgerFile(file), text, 'go changed the ledger');
});

test('go --take-over replaces the claim of the other session with its own and goes on as go does', (t) => {
  const { h, app, file } = setup(t);
  writeLedgerFile(file, readLedgerFile(file).replace('## Next step\n', '## Next step\nParked: 2026-11-19 — waiting\n'));
  withClaim(file, claimLine('s1', T0, later(10)));
  exits(run(h, app, { now: later(20), session: 's2' }, 'go', 'fix-login', '--take-over'), 0);
  assert.equal(claimOf(file), claimLine('s2', later(20), later(20)));
  assert.doesNotMatch(readLedgerFile(file), /^Parked: |^- status: /m);
});

test('go --take-over says whose claim it took over, in its output and as "tookOverFrom" in --json', (t) => {
  const { h, app, file } = setup(t);
  withClaim(file, claimLine('s1', T0, later(10)));
  const ran = exits(run(h, app, { now: later(20), session: 's2' }, 'go', 'fix-login', '--take-over'), 0);
  assert.match(ran.stdout, /^claim {4}took over from session s1$/m);
  writeLedgerFile(file, readLedgerFile(file).replace(CLAIM_LINE, claimLine('s1', T0, later(10))));
  const json = JSON.parse(exits(run(h, app, { now: later(20), session: 's2' }, 'go', 'fix-login', '--take-over', '--json'), 0).stdout);
  assert.deepEqual(json.tookOverFrom, { session: 's1', since: T0, active: later(10) });
});

test('go with a session claims nothing for a task of another repo than the one it runs in, and says so', (t) => {
  const { h, app, file } = setup(t);
  const other = repository(h, path.join(h, 'repos/other'));
  backlogTask(h, app, { slug: 'next-up' });
  const ran = exits(run(h, other, { now: T0, session: 's1' }, 'go', 'fix-login', '--repo', app), 0);
  assert.equal(claimOf(file), undefined);
  assert.match(ran.stdout, /^claim {4}not claimed: /m);
  const json = JSON.parse(exits(run(h, h, { now: T0, session: 's1' }, 'go', 'next-up', '--repo', app, '--json'), 0).stdout);
  assert.equal(claimOf(activeFile(h, app, 'next-up')), undefined);
  assert.match(json.unclaimed, /another repo/);
  const here = JSON.parse(exits(run(h, app, { now: T0, session: 's1' }, 'go', 'fix-login', '--json'), 0).stdout);
  assert.equal('unclaimed' in here, false);
});

test('go of a task of another repo still refuses while a session holds it live', (t) => {
  const { h, app, file } = setup(t);
  const other = repository(h, path.join(h, 'repos/other'));
  withClaim(file, claimLine('s2', T0, later(10)));
  exits(run(h, other, { now: later(20), session: 's1' }, 'go', 'fix-login', '--repo', app), 3);
  assert.equal(claimOf(file), claimLine('s2', T0, later(10)));
});

test('go --take-over with no session known removes the other claim and claims nothing', (t) => {
  const { h, app, file } = setup(t);
  withClaim(file, claimLine('s1', T0, later(10)));
  exits(run(h, app, { now: later(20) }, 'go', 'fix-login', '--take-over'), 0);
  assert.equal(claimOf(file), undefined);
});

test('go claims a task with a worktree for its session: its own claim keeps since, and an expired claim of another session is replaced', (t) => {
  const { h, app, file } = setup(t);
  exits(run(h, app, { now: T0, session: 's1' }, 'go', 'fix-login'), 0);
  assert.equal(claimOf(file), claimLine('s1', T0, T0));
  exits(run(h, app, { now: later(20), session: 's1' }, 'go', 'fix-login'), 0);
  assert.equal(claimOf(file), claimLine('s1', T0, later(20)));
  exits(run(h, app, { now: later(200), session: 's2' }, 'go', 'fix-login'), 0);
  assert.equal(claimOf(file), claimLine('s2', later(200), later(200)));
});

test('go with no session known claims nothing', (t) => {
  const { h, app, file } = setup(t);
  exits(run(h, app, { now: T0 }, 'go', 'fix-login'), 0);
  assert.equal(claimOf(file), undefined);
});

test('go of a backlog task claims its new worktree ledger for the session, and claims nothing with no session known', (t) => {
  const { h, app } = setup(t);
  backlogTask(h, app, { slug: 'next-up' });
  backlogTask(h, app, { slug: 'unclaimed' });
  exits(run(h, app, { now: T0, session: 's1' }, 'go', 'next-up'), 0);
  assert.equal(claimOf(activeFile(h, app, 'next-up')), claimLine('s1', T0, T0));
  exits(run(h, app, { now: T0 }, 'go', 'unclaimed'), 0);
  assert.equal(claimOf(activeFile(h, app, 'unclaimed')), undefined);
});

test('claim --from hands a claim of that session over to this one, live or expired, and prints claimed <slug>', (t) => {
  const { h, app, file } = setup(t);
  withClaim(file, claimLine('old', T0, later(10)));
  const ran = exits(run(h, app, { now: later(20) }, 'task', 'claim', 'fix-login', '--session', 'new', '--from', 'old'), 0);
  assert.equal(ran.stdout, 'claimed fix-login\n');
  assert.equal(claimOf(file), claimLine('new', later(20), later(20)));
  writeLedgerFile(file, readLedgerFile(file).replace(CLAIM_LINE, claimLine('old', T0, later(10))));
  exits(run(h, app, { now: later(500) }, 'task', 'claim', 'fix-login', '--session', 'new', '--from', 'old'), 0);
  assert.equal(claimOf(file), claimLine('new', later(500), later(500)));
});

test('claim --from refuses a live claim of a third session with exit 3, and writes nothing', (t) => {
  const { h, app, file } = setup(t);
  withClaim(file, claimLine('third', T0, later(10)));
  const text = readLedgerFile(file);
  const ran = exits(run(h, app, { now: later(20) }, 'task', 'claim', 'fix-login', '--session', 'new', '--from', 'old'), 3);
  assert.match(ran.stdout + ran.stderr, new RegExp(`^held: session third since ${T0}, active ${later(10)}$`, 'm'));
  assert.equal(readLedgerFile(file), text);
});

test('claim --from with no claim claims the task as claim does', (t) => {
  const { h, app, file } = setup(t);
  exits(run(h, app, { now: T0 }, 'task', 'claim', 'fix-login', '--session', 'new', '--from', 'old'), 0);
  assert.equal(claimOf(file), claimLine('new', T0, T0));
});

test('the hook input gives the session id', () => {
  assert.equal(parseHookInput(JSON.stringify({ cwd: '/x', session_id: 'abc-123' })).sessionId, 'abc-123');
  assert.equal(parseHookInput(JSON.stringify({ cwd: '/x' })).sessionId, '');
});

function sessionStart(h: string, cwd: string, now: string, sessionId: string): string {
  const ran = exits(run(h, h, { now, input: JSON.stringify({ cwd, session_id: sessionId }) }, 'hook', 'session-start'), 0);
  assert.equal(ran.stderr, '');
  return JSON.parse(ran.stdout).hookSpecificOutput.additionalContext;
}

test('session start adds one line for a ledger held live by another session; its own claim and an expired one add none', (t) => {
  const { h, file, worktree } = setup(t);
  withClaim(file, claimLine('s1', T0, later(10)));
  const line = `Held by another session: s1 since ${T0}, active ${later(10)}.`;
  assert.ok(sessionStart(h, worktree, later(20), 's2').includes(`${line}\n`));
  assert.ok(!sessionStart(h, worktree, later(20), 's1').includes('Held by another session'));
  assert.ok(!sessionStart(h, worktree, later(200), 's2').includes('Held by another session'));
});

test('in the summary of several ledgers, the line follows the ledger it is about', (t) => {
  const { h, app, file, worktree } = setup(t);
  worktreeTask(h, app, { slug: 'other' });
  withClaim(file, claimLine('s1', T0, later(10)));
  const context = sessionStart(h, app, later(20), 's2');
  const blocks = context.split('\n=== ').slice(1);
  const [heading, otherHeading] = [`fix-login in ${worktree}`, `other in ${worktreeOf(app, 'other')}`];
  assert.deepEqual(blocks.map((block) => block.split('\n')[0]).sort(), [heading, otherHeading].sort(), context);
  const held = blocks.filter((block) => block.includes('Held by another session'));
  assert.deepEqual(held.map((block) => block.split('\n')[0]), [heading]);
  assert.ok(held[0].includes(`\nHeld by another session: s1 since ${T0}, active ${later(10)}.\n`), held[0]);
});
