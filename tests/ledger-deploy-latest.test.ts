import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { commonDir, gitTimedOut, limitGitCalls, resetGitLimits } from '../tools/ledger/git.js';
import { freshHome, REPO } from './helpers.js';

type DeployRun = { code: number; stdout: string; stderr: string };
type DeployOptions = { repo: string; json?: boolean; timeLimitMs?: number };
type DeployLatest = (options: DeployOptions) => DeployRun | Promise<DeployRun>;
type Deployed = { commit: string; subject: string; from: string; to: string; reinstalled: string[]; installed: string[]; warnings: string[]; needsReload: boolean };
type Report = ({ ok: true } & Deployed) | { ok: false; error: string } | ({ ok: false; error: string } & Deployed);

// A computed specifier, so the suite type-checks and each test fails on its own until the module exists.
const DEPLOY_LATEST = new URL('../tools/ledger/deploy-latest.js', import.meta.url).href;

async function deployLatest(options: DeployOptions): Promise<DeployRun> {
  const module: { deployLatest: DeployLatest } = await import(DEPLOY_LATEST);
  return module.deployLatest(options);
}

async function deployLatestJson(repo: string, options: Omit<DeployOptions, 'repo' | 'json'> = {}): Promise<{ code: number; report: Report }> {
  const { code, stdout, stderr } = await deployLatest({ repo, json: true, ...options });
  assert.equal(stderr, '');
  return { code, report: JSON.parse(stdout) as Report };
}

function succeeded(run: { code: number; report: Report }): Extract<Report, { ok: true }> {
  assert.equal(run.code, 0, JSON.stringify(run.report));
  assert.equal(run.report.ok, true, JSON.stringify(run.report));
  return run.report as Extract<Report, { ok: true }>;
}

function stopped(run: { code: number; report: Report }): string {
  assert.notEqual(run.code, 0);
  assert.equal(run.report.ok, false, JSON.stringify(run.report));
  return (run.report as Extract<Report, { ok: false }>).error;
}

const oneLine = (text: string): void => assert.match(text, /^[^\n]+$/, JSON.stringify(text));

/** `child` is a shell script the stub runs and waits for, as tools/deploy.ts waits for claude plugin install. */
type StubConfig = { stdout?: string[]; stderr?: string[]; exitCode?: number; readStdin?: boolean; sleepMs?: number; child?: string; ignoreTerm?: boolean };
type StubRun = { cwd: string; argv: string[]; stdinTty: boolean; stdin?: string; pullCheck: string | null; repoVariables: string[] };

/**
 * Stands in for tools/deploy.ts. bin/deploy changes into its checkout first, so the stub finds its settings and logs
 * each run in the folder that holds the checkout, outside the repository it deploys.
 */
const STUB_DEPLOY = `import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isatty } from 'node:tty';

export function main(argv: string[]): void {
  const folder = path.dirname(process.cwd());
  const stub = JSON.parse(readFileSync(path.join(folder, 'deploy-stub.json'), 'utf8'));
  const stdin = stub.readStdin ? readFileSync(0, 'utf8') : undefined;
  if (stub.ignoreTerm) process.on('SIGTERM', () => {});
  const repoVariables = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].filter((name) => name in process.env);
  const run = { cwd: process.cwd(), argv, stdinTty: isatty(0), stdin, pullCheck: process.env.DEPLOY_PULL_CHECK ?? null, repoVariables };
  appendFileSync(path.join(folder, 'deploy-runs.jsonl'), JSON.stringify(run) + '\\n');
  for (const line of stub.stdout ?? []) console.log(line);
  for (const line of stub.stderr ?? []) console.error(line);
  if (stub.child) spawnSync('sh', ['-c', stub.child], { stdio: 'inherit' });
  if (stub.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stub.sleepMs);
  process.exitCode = stub.exitCode ?? 0;
}
`;

function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Deploy Test',
    GIT_AUTHOR_EMAIL: 'deploy@example.test',
    GIT_COMMITTER_NAME: 'Deploy Test',
    GIT_COMMITTER_EMAIL: 'deploy@example.test',
    DEPLOY_PULL_CHECK: undefined,
    DEPLOY_FROM_WORKTREE: undefined,
  };
}

/** Points this process's git and HOME at `home` for one test, since deployLatest runs git and bin/deploy from here. */
function useHome(t: TestContext, home: string): void {
  useEnv(t, gitEnv(home));
}

function useEnv(t: TestContext, overrides: NodeJS.ProcessEnv): void {
  const saved = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
  const apply = (values: NodeJS.ProcessEnv) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  apply(overrides);
  t.after(() => apply(saved));
}

/**
 * An origin, the main checkout `repo` cloned from it with bin/deploy over the stub tools/deploy.ts, and a peer clone
 * that pushes commits the main checkout has not fetched. `files` fills the checkout before its first commit.
 */
function deployRepo(t: TestContext, files: (repo: string) => void = stubFiles) {
  const home = freshHome(t);
  useHome(t, home);
  const env = { ...process.env, ...gitEnv(home) };
  const origin = path.join(home, 'origin.git');
  const repo = path.join(home, 'repo');
  const peer = path.join(home, 'peer');
  const git = (cwd: string, ...args: string[]): string => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(home, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(home, 'clone', '--quiet', origin, repo);
  files(repo);
  symlinkSync(path.join(REPO, 'node_modules'), path.join(repo, 'node_modules'));
  appendFileSync(path.join(repo, '.git/info/exclude'), '/node_modules\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'Initial deploy stub');
  git(repo, 'push', '--quiet', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  git(home, 'clone', '--quiet', origin, peer);
  const commit = (cwd: string, subject: string): string => {
    appendFileSync(path.join(cwd, 'history.txt'), `${subject}\n`);
    git(cwd, 'add', 'history.txt');
    git(cwd, 'commit', '--quiet', '-m', subject);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  const pushed = (subject: string): string => {
    const sha = commit(peer, subject);
    git(peer, 'push', '--quiet');
    return sha;
  };
  const stub = (config: StubConfig): void => writeFileSync(path.join(home, 'deploy-stub.json'), JSON.stringify(config));
  const runs = (): StubRun[] => {
    const log = path.join(home, 'deploy-runs.jsonl');
    return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as StubRun) : [];
  };
  stub({ stdout: ['mods     ledger@ledger already installed'] });
  const head = (): string => git(repo, 'rev-parse', 'HEAD');
  const short = (sha: string): string => git(repo, 'rev-parse', '--short', sha);
  return { home, origin, repo, peer, env, git, commit, pushed, stub, runs, head, short, initial: head() };
}

function stubFiles(repo: string): void {
  mkdirSync(path.join(repo, 'bin'));
  mkdirSync(path.join(repo, 'tools'));
  for (const file of ['package.json', 'bin/package.json', 'bin/deploy', 'tools/deploy-mods-lines.ts']) copyFileSync(path.join(REPO, file), path.join(repo, file));
  writeFileSync(path.join(repo, 'tools/deploy.ts'), STUB_DEPLOY);
  writeFileSync(path.join(repo, 'notes.txt'), 'tracked\n');
}

test('deploy --latest fast-forwards a main checkout that is behind and deploys the new commit', async (t) => {
  const fixture = deployRepo(t);
  const latest = fixture.pushed('Remote commit');
  const report = succeeded(await deployLatestJson(fixture.repo));
  assert.equal(fixture.head(), latest);
  assert.deepEqual(
    { commit: report.commit, subject: report.subject, from: report.from, to: report.to },
    { commit: fixture.short(latest), subject: 'Remote commit', from: fixture.short(fixture.initial), to: fixture.short(latest) },
  );
  assert.deepEqual(fixture.runs().map(({ cwd }) => cwd), [realpathSync(fixture.repo)]);
});

test('deploy --latest runs bin/deploy without --force, without a terminal on stdin, and without the pull check', async (t) => {
  const fixture = deployRepo(t);
  useEnv(t, { DEPLOY_PULL_CHECK: '1' });
  fixture.pushed('Remote commit');
  succeeded(await deployLatestJson(fixture.repo));
  const [run] = fixture.runs();
  assert.ok(!run.argv.includes('--force'), JSON.stringify(run.argv));
  assert.equal(run.stdinTty, false);
  assert.equal(run.pullCheck, null);
});

test('deploy --latest names the move from the old commit to the new one in plain words', async (t) => {
  const fixture = deployRepo(t);
  const latest = fixture.pushed('Remote commit');
  const { code, stdout } = await deployLatest({ repo: fixture.repo });
  assert.equal(code, 0);
  for (const expected of [fixture.short(fixture.initial), fixture.short(latest), 'Remote commit']) assert.ok(stdout.includes(expected), stdout);
});

test('deploy --latest deploys a main checkout that is already up to date and says so', async (t) => {
  const fixture = deployRepo(t);
  const report = succeeded(await deployLatestJson(fixture.repo));
  const initial = fixture.short(fixture.initial);
  assert.deepEqual({ commit: report.commit, subject: report.subject, from: report.from, to: report.to }, { commit: initial, subject: 'Initial deploy stub', from: initial, to: initial });
  const plain = await deployLatest({ repo: fixture.repo });
  assert.equal(plain.code, 0);
  assert.match(plain.stdout, /already up to date/);
  assert.ok(plain.stdout.includes(initial), plain.stdout);
  assert.equal(fixture.runs().length, 2);
});

for (const [change, staged] of [['an unstaged', false], ['a staged', true]] as const) {
  test(`deploy --latest stops on ${change} change to a tracked file and deploys nothing`, async (t) => {
    const fixture = deployRepo(t);
    fixture.pushed('Remote commit');
    writeFileSync(path.join(fixture.repo, 'notes.txt'), 'edited\n');
    if (staged) fixture.git(fixture.repo, 'add', 'notes.txt');
    const error = stopped(await deployLatestJson(fixture.repo));
    oneLine(error);
    assert.match(error, /uncommitted changes to tracked files/);
    assert.equal(fixture.git(fixture.repo, 'rev-parse', 'origin/main'), fixture.initial, 'nothing was fetched');
    assert.equal(fixture.head(), fixture.initial);
    assert.deepEqual(fixture.runs(), []);
  });
}

test('deploy --latest gives its reason to stop in one plain line on stderr', async (t) => {
  const fixture = deployRepo(t);
  writeFileSync(path.join(fixture.repo, 'notes.txt'), 'edited\n');
  const { code, stdout, stderr } = await deployLatest({ repo: fixture.repo });
  assert.notEqual(code, 0);
  assert.equal(stdout, '');
  oneLine(stderr.trimEnd());
  assert.deepEqual(fixture.runs(), []);
});

test('deploy --latest deploys past untracked files', async (t) => {
  const fixture = deployRepo(t);
  const latest = fixture.pushed('Remote commit');
  writeFileSync(path.join(fixture.repo, 'scratch.txt'), 'untracked\n');
  succeeded(await deployLatestJson(fixture.repo));
  assert.equal(fixture.head(), latest);
  assert.equal(fixture.runs().length, 1);
});

test('deploy --latest reads a git status of more than 1 MiB', async (t) => {
  const fixture = deployRepo(t);
  const latest = fixture.pushed('Remote commit');
  // git status gives each untracked file of the top folder a line of its own: here about 1.4 MB.
  for (let index = 0; index < 6000; index++) writeFileSync(path.join(fixture.repo, `${String(index).padStart(6, '0')}${'u'.repeat(230)}`), '');
  succeeded(await deployLatestJson(fixture.repo));
  assert.equal(fixture.head(), latest);
});

for (const shape of ['has diverged from', 'is ahead of'] as const) {
  test(`deploy --latest stops when local main ${shape} its upstream`, async (t) => {
    const fixture = deployRepo(t);
    if (shape === 'has diverged from') fixture.pushed('Remote commit');
    const local = fixture.commit(fixture.repo, 'Local commit');
    oneLine(stopped(await deployLatestJson(fixture.repo)));
    assert.equal(fixture.head(), local);
    assert.deepEqual(fixture.runs(), []);
  });
}

test('deploy --latest stops when the main checkout is on a branch other than the default one', async (t) => {
  const fixture = deployRepo(t);
  fixture.pushed('Remote commit');
  fixture.git(fixture.repo, 'checkout', '--quiet', '-b', 'feature', '--track', 'origin/main');
  const error = stopped(await deployLatestJson(fixture.repo));
  oneLine(error);
  assert.ok(error.includes('feature') && error.includes('main'), error);
  assert.equal(fixture.head(), fixture.initial);
  assert.deepEqual(fixture.runs(), []);
});

test('deploy --latest stops when the main checkout has a detached HEAD', async (t) => {
  const fixture = deployRepo(t);
  fixture.pushed('Remote commit');
  fixture.git(fixture.repo, 'checkout', '--quiet', '--detach');
  const error = stopped(await deployLatestJson(fixture.repo));
  oneLine(error);
  assert.match(error, /detached HEAD/);
  assert.equal(fixture.head(), fixture.initial);
  assert.deepEqual(fixture.runs(), []);
});

test('deploy --latest stops, and says how to set it, when the main checkout has no origin/HEAD', async (t) => {
  const fixture = deployRepo(t);
  fixture.pushed('Remote commit');
  fixture.git(fixture.repo, 'remote', 'set-head', 'origin', '--delete');
  const error = stopped(await deployLatestJson(fixture.repo));
  oneLine(error);
  assert.match(error, /git remote set-head origin --auto/);
  assert.equal(fixture.git(fixture.repo, 'rev-parse', 'origin/main'), fixture.initial, 'nothing was fetched');
  assert.equal(fixture.head(), fixture.initial);
  assert.deepEqual(fixture.runs(), []);
});

/** Serves the fetch from the real origin through a stand-in ssh, which first runs `meanwhile` in the main checkout. */
function fetchMeanwhile(t: TestContext, fixture: ReturnType<typeof deployRepo>, meanwhile: string): void {
  sshOrigin(t, fixture, `cd '${fixture.repo}' && ${meanwhile}\nexec git upload-pack '${fixture.origin}'\n`);
  // Otherwise git first runs the stand-in with -G, to learn whether it is OpenSSH, and `meanwhile` runs twice.
  useEnv(t, { GIT_SSH_VARIANT: 'simple' });
}

for (const [change, meanwhile, reason] of [
  ['switches to another branch', 'git checkout --quiet -b feature', /the branch feature/],
  ['gets a change to a tracked file', 'echo edited > notes.txt', /uncommitted changes to tracked files/],
] as const) {
  test(`deploy --latest stops when the main checkout ${change} during the fetch`, async (t) => {
    const fixture = deployRepo(t);
    fixture.pushed('Remote commit');
    fetchMeanwhile(t, fixture, meanwhile);
    const error = stopped(await deployLatestJson(fixture.repo));
    oneLine(error);
    assert.match(error, reason);
    assert.equal(fixture.head(), fixture.initial);
    assert.deepEqual(fixture.runs(), []);
  });
}

test('deploy --latest fetches the default branch also when the fetch refspecs of origin leave it out', async (t) => {
  const fixture = deployRepo(t);
  fixture.git(fixture.repo, 'config', 'remote.origin.fetch', '+refs/heads/elsewhere:refs/remotes/origin/elsewhere');
  const latest = fixture.pushed('Remote commit');
  const report = succeeded(await deployLatestJson(fixture.repo));
  assert.equal(report.commit, fixture.short(latest));
  assert.equal(fixture.head(), latest);
});

test('deploy --latest stops when the fetch fails', async (t) => {
  const fixture = deployRepo(t);
  fixture.git(fixture.repo, 'remote', 'set-url', 'origin', path.join(fixture.home, 'missing.git'));
  oneLine(stopped(await deployLatestJson(fixture.repo)));
  assert.deepEqual(fixture.runs(), []);
});

test('deploy --latest reports a reinstalled mod and that Claude Code needs a reload', async (t) => {
  const fixture = deployRepo(t);
  fixture.stub({ stdout: ['mods     marketplace ledger already added', 'mods     reinstalled ledger@ledger (installed copy differed from mods/ledger)'] });
  const report = succeeded(await deployLatestJson(fixture.repo));
  assert.deepEqual({ reinstalled: report.reinstalled, installed: report.installed, needsReload: report.needsReload }, { reinstalled: ['ledger@ledger'], installed: [], needsReload: true });
});

test('deploy --latest reports a newly installed mod and that Claude Code needs a reload', async (t) => {
  const fixture = deployRepo(t);
  fixture.stub({ stdout: ['mods     added marketplace ledger (this repo)', 'mods     installed ledger@ledger (/ledger)'] });
  const report = succeeded(await deployLatestJson(fixture.repo));
  assert.deepEqual({ reinstalled: report.reinstalled, installed: report.installed, needsReload: report.needsReload }, { reinstalled: [], installed: ['ledger@ledger'], needsReload: true });
});

test('deploy --latest warns when the marketplace points elsewhere, and asks for no reload', async (t) => {
  const fixture = deployRepo(t);
  const elsewhere = 'marketplace ledger points at /elsewhere/ledger, not this repo; to fix: claude plugin marketplace remove ledger, then run deploy again';
  const skipped = 'skipped install of ledger@ledger until the marketplace points at this repo';
  fixture.stub({ stdout: [`mods     ${elsewhere}`, `mods     ${skipped}`] });
  const report = succeeded(await deployLatestJson(fixture.repo));
  for (const warning of [elsewhere, skipped]) assert.ok(report.warnings.some((line) => line.includes(warning)), JSON.stringify(report.warnings));
  assert.deepEqual({ reinstalled: report.reinstalled, installed: report.installed, needsReload: report.needsReload }, { reinstalled: [], installed: [], needsReload: false });
});

test('deploy --latest warns when no claude CLI was found to install the mods', async (t) => {
  const fixture = deployRepo(t);
  fixture.stub({ stdout: ['mods     skipped (no claude CLI on PATH)'] });
  const report = succeeded(await deployLatestJson(fixture.repo));
  assert.ok(report.warnings.some((line) => line.includes('no claude CLI on PATH')), JSON.stringify(report.warnings));
});

test('deploy --latest reads more than 1 MiB of what bin/deploy printed', async (t) => {
  const fixture = deployRepo(t);
  fixture.stub({ stdout: ['x'.repeat(2 * 1024 * 1024), 'mods     reinstalled ledger@ledger (installed copy differed from mods/ledger)'] });
  const report = succeeded(await deployLatestJson(fixture.repo));
  assert.deepEqual(report.reinstalled, ['ledger@ledger']);
});

// A later tools/deploy-mods-lines.ts, which reads the other wording that the tools/deploy.ts of its commit would print.
const REWORDED_PARSER = `export function readModsLines(stdout: string) {
  return { reinstalled: [...stdout.matchAll(/^plugin refreshed (\\S+)$/gm)].map(([, mod]) => mod), installed: [], warnings: [] };
}
`;

test('deploy --latest reads what bin/deploy printed with the tools/deploy-mods-lines.ts that the fast-forward brought', async (t) => {
  const fixture = deployRepo(t);
  succeeded(await deployLatestJson(fixture.repo));
  writeFileSync(path.join(fixture.peer, 'tools/deploy-mods-lines.ts'), REWORDED_PARSER);
  fixture.git(fixture.peer, 'add', 'tools/deploy-mods-lines.ts');
  fixture.pushed('Reword the mods lines');
  fixture.stub({ stdout: ['plugin refreshed ledger@ledger'] });
  const report = succeeded(await deployLatestJson(fixture.repo));
  assert.deepEqual({ reinstalled: report.reinstalled, needsReload: report.needsReload }, { reinstalled: ['ledger@ledger'], needsReload: true });
});

test('deploy --latest deploys nothing, and leaves the main checkout where it was, when the new commit has no tools/deploy-mods-lines.ts', async (t) => {
  const fixture = deployRepo(t);
  fixture.git(fixture.peer, 'rm', '--quiet', 'tools/deploy-mods-lines.ts');
  fixture.pushed('Drop the mods lines');
  const error = stopped(await deployLatestJson(fixture.repo));
  oneLine(error);
  assert.match(error, /^Nothing deployed: .*tools\/deploy-mods-lines\.ts/);
  assert.equal(fixture.head(), fixture.initial);
  assert.deepEqual(fixture.runs(), []);
});

test('deploy --latest that cannot load the tools/deploy-mods-lines.ts of the new commit stops after the fast-forward, and says so', async (t) => {
  const fixture = deployRepo(t);
  writeFileSync(path.join(fixture.peer, 'tools/deploy-mods-lines.ts'), 'export const wording = 2;\n');
  fixture.git(fixture.peer, 'add', 'tools/deploy-mods-lines.ts');
  const latest = fixture.pushed('Break the mods lines');
  const run = await deployLatestJson(fixture.repo);
  assert.match(stopped(run), /^Nothing deployed: ledger could not load .*tools\/deploy-mods-lines\.ts: it has no readModsLines/);
  const report = run.report as Extract<Report, { ok: false }> & Partial<Deployed>;
  assert.deepEqual({ from: report.from, to: report.to }, { from: fixture.short(fixture.initial), to: fixture.short(latest) });
  assert.equal(fixture.head(), latest);
  assert.deepEqual(fixture.runs(), []);
});

test('deploy --latest fails with the error bin/deploy printed when it exits non-zero', async (t) => {
  const fixture = deployRepo(t);
  fixture.stub({ stdout: ['mods     marketplace ledger already added'], stderr: ['deploy: claude plugin install ledger@ledger failed: boom'], exitCode: 1 });
  const error = stopped(await deployLatestJson(fixture.repo));
  assert.ok(error.includes('deploy: claude plugin install ledger@ledger failed: boom'), error);
  assert.equal(fixture.runs().length, 1);
});

const PARTIAL_DEPLOY: StubConfig = {
  stdout: ['mods     reinstalled ledger@ledger (installed copy differed from mods/ledger)', 'mods     skipped (no claude CLI on PATH)'],
  stderr: ['deploy: links failed: boom'],
  exitCode: 1,
};

test('deploy --latest that fails after the fast-forward still reports the move and what bin/deploy did', async (t) => {
  const fixture = deployRepo(t);
  fixture.stub(PARTIAL_DEPLOY);
  const latest = fixture.pushed('Remote commit');
  const run = await deployLatestJson(fixture.repo);
  const error = stopped(run);
  assert.ok(error.includes('deploy: links failed: boom'), error);
  assert.deepEqual(run.report, {
    ok: false,
    error,
    commit: fixture.short(latest),
    subject: 'Remote commit',
    from: fixture.short(fixture.initial),
    to: fixture.short(latest),
    reinstalled: ['ledger@ledger'],
    installed: [],
    warnings: ['skipped (no claude CLI on PATH)'],
    needsReload: true,
  });
});

test('deploy --latest that fails after the fast-forward prints the move and the mods after the failure', async (t) => {
  const fixture = deployRepo(t);
  fixture.stub(PARTIAL_DEPLOY);
  const latest = fixture.pushed('Remote commit');
  const { code, stdout, stderr } = await deployLatest({ repo: fixture.repo });
  assert.notEqual(code, 0);
  assert.equal(stdout, '');
  const [failure, ...after] = stderr.trimEnd().split('\n');
  assert.match(failure, /bin\/deploy/);
  const rest = after.join('\n');
  for (const expected of [fixture.short(fixture.initial), fixture.short(latest), 'Reinstalled: ledger@ledger', '/reload-plugins', 'Warning: skipped (no claude CLI on PATH)']) {
    assert.ok(rest.includes(expected), stderr);
  }
});

test('deploy --latest that stops before the deploy reports only the error', async (t) => {
  const fixture = deployRepo(t);
  writeFileSync(path.join(fixture.repo, 'notes.txt'), 'edited\n');
  assert.deepEqual(Object.keys((await deployLatestJson(fixture.repo)).report), ['ok', 'error']);
});

/** Points origin at an ssh address served by `script`, a shell script run in place of ssh. */
function sshOrigin(t: TestContext, fixture: ReturnType<typeof deployRepo>, script: string): void {
  const ssh = path.join(fixture.home, 'fake-ssh.sh');
  writeFileSync(ssh, script);
  fixture.git(fixture.repo, 'remote', 'set-url', 'origin', 'ssh://deploy.invalid/origin.git');
  useEnv(t, { GIT_SSH_COMMAND: `sh '${ssh}'` });
}

test('deploy --latest fetches with git terminal prompts turned off', async (t) => {
  const fixture = deployRepo(t);
  const seen = path.join(fixture.home, 'terminal-prompt.txt');
  sshOrigin(t, fixture, `printf '%s' "\${GIT_TERMINAL_PROMPT-unset}" > '${seen}'\nexit 1\n`);
  stopped(await deployLatestJson(fixture.repo));
  assert.equal(readFileSync(seen, 'utf8'), '0');
});

test('deploy --latest stops and names the fetch when the fetch runs out of time', async (t) => {
  const fixture = deployRepo(t);
  sshOrigin(t, fixture, 'sleep 6\n');
  const started = Date.now();
  const error = stopped(await deployLatestJson(fixture.repo, { timeLimitMs: 2000 }));
  oneLine(error);
  assert.match(error, /^Nothing deployed: git fetch origin main ran out of time/);
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
  assert.deepEqual(fixture.runs(), []);
});

test('deploy --latest gives bin/deploy only the time the fetch left, and reports the move when it runs out', async (t) => {
  const fixture = deployRepo(t);
  fixture.stub({ sleepMs: 8000 });
  const latest = fixture.pushed('Remote commit');
  const started = Date.now();
  const run = await deployLatestJson(fixture.repo, { timeLimitMs: 3000 });
  assert.ok(Date.now() - started < 4000, `${Date.now() - started} ms`);
  assert.match(stopped(run), /bin\/deploy ran out of time/);
  const report = run.report as Extract<Report, { ok: false }> & Partial<Deployed>;
  assert.deepEqual({ from: report.from, to: report.to }, { from: fixture.short(fixture.initial), to: fixture.short(latest) });
});

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether `check` holds within `ms`, asked every 50 ms. */
async function eventually(check: () => boolean, ms = 3000): Promise<boolean> {
  for (const until = Date.now() + ms; Date.now() < until; await delay(50)) if (check()) return true;
  return check();
}

/** Makes the stub's bin/deploy wait for a child, as for claude plugin install; the child's pid is in `pidFile`. */
function stubWithChild(fixture: ReturnType<typeof deployRepo>): string {
  const pidFile = path.join(fixture.home, 'install.pid');
  fixture.stub({ child: `echo $$ > '${pidFile}'; exec sleep 30` });
  return pidFile;
}

function childStarted(t: TestContext, pidFile: string): number {
  const pid = Number(readFileSync(pidFile, 'utf8'));
  t.after(() => {
    if (running(pid)) process.kill(pid, 'SIGKILL');
  });
  return pid;
}

test('deploy --latest stops bin/deploy and every process it started when the time runs out', async (t) => {
  const fixture = deployRepo(t);
  const pidFile = stubWithChild(fixture);
  assert.match(stopped(await deployLatestJson(fixture.repo, { timeLimitMs: 4000 })), /bin\/deploy ran out of time/);
  const install = childStarted(t, pidFile);
  assert.ok(await eventually(() => !running(install)), `process ${install}, which bin/deploy started, still runs`);
});

test('deploy --latest kills what ignores SIGTERM at the time limit once a short grace is over', async (t) => {
  const fixture = deployRepo(t);
  const pidFile = path.join(fixture.home, 'install.pid');
  fixture.stub({ ignoreTerm: true, child: `trap '' TERM; echo $$ > '${pidFile}'; exec sleep 30` });
  const timeLimitMs = 4000;
  const started = Date.now();
  assert.match(stopped(await deployLatestJson(fixture.repo, { timeLimitMs })), /bin\/deploy ran out of time/);
  // The time limit, the grace of a tenth of it, and some slack.
  assert.ok(Date.now() - started < timeLimitMs * 1.1 + 1500, `${Date.now() - started} ms`);
  const install = childStarted(t, pidFile);
  assert.ok(await eventually(() => !running(install)), `process ${install}, which bin/deploy started, still runs`);
});

/** From the moment `marker` exists, Date.now, by which the time limit is kept, reads `jumpMs` later than the time is. */
function clockJumpsOnce(t: TestContext, marker: string, jumpMs: number): void {
  const now = Date.now;
  t.mock.method(Date, 'now', () => now() + (existsSync(marker) ? jumpMs : 0));
}

test('deploy --latest does not start bin/deploy when the fast-forward used up the time, and says so', async (t) => {
  const fixture = deployRepo(t);
  const latest = fixture.pushed('Remote commit');
  const merged = path.join(fixture.home, 'merged');
  writeFileSync(path.join(fixture.repo, '.git/hooks/post-merge'), `#!/bin/sh\ntouch '${merged}'\n`, { mode: 0o755 });
  clockJumpsOnce(t, merged, 120_000);
  const run = await deployLatestJson(fixture.repo, { timeLimitMs: 120_000 });
  const error = stopped(run);
  oneLine(error);
  assert.match(error, /^Nothing deployed: git fetch and git merge used up the 2 minutes .*bin\/deploy did not start/);
  const report = run.report as Extract<Report, { ok: false }> & Partial<Deployed>;
  assert.deepEqual({ from: report.from, to: report.to }, { from: fixture.short(fixture.initial), to: fixture.short(latest) });
  assert.equal(fixture.head(), latest);
  assert.deepEqual(fixture.runs(), []);
});

test('deploy --latest names the check after the fetch when the time runs out in it', async (t) => {
  const fixture = deployRepo(t);
  fixture.pushed('Remote commit');
  const fetched = path.join(fixture.home, 'fetched');
  fetchMeanwhile(t, fixture, `touch '${fetched}'`);
  clockJumpsOnce(t, fetched, 120_000);
  const error = stopped(await deployLatestJson(fixture.repo, { timeLimitMs: 120_000 }));
  assert.equal(error, 'Nothing deployed: git status ran out of time; ledger deploy --latest has 2 minutes in all.');
  assert.equal(fixture.head(), fixture.initial);
  assert.deepEqual(fixture.runs(), []);
});

/** Puts a git first on PATH that fails each call with `failing` among its arguments, and hands the others to git. */
function failGitCalls(t: TestContext, fixture: ReturnType<typeof deployRepo>, failing: string): void {
  const git = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(fixture.home, 'failing-git');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *' ${failing} '*) echo 'fatal: stand-in failure' >&2; exit 128 ;; esac\nexec '${git}' "$@"\n`, { mode: 0o755 });
  useEnv(t, { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` });
}

test('deploy --latest stops, rather than report HEAD as a commit, when git cannot read the commits', async (t) => {
  const fixture = deployRepo(t);
  fixture.pushed('Remote commit');
  failGitCalls(t, fixture, 'rev-parse --short');
  const run = await deployLatestJson(fixture.repo);
  oneLine(stopped(run));
  assert.ok(!JSON.stringify(run.report).includes('"HEAD"'), JSON.stringify(run.report));
  assert.equal(fixture.head(), fixture.initial);
  assert.deepEqual(fixture.runs(), []);
});

test('deploy --latest gives the git failure, not a detached HEAD, when git cannot name the branch of the main checkout', async (t) => {
  const fixture = deployRepo(t);
  fixture.pushed('Remote commit');
  failGitCalls(t, fixture, 'branch --show-current');
  const error = stopped(await deployLatestJson(fixture.repo));
  oneLine(error);
  assert.match(error, /git branch --show-current failed .*stand-in failure/);
  assert.doesNotMatch(error, /detached/);
  assert.equal(fixture.head(), fixture.initial);
  assert.deepEqual(fixture.runs(), []);
});

test('deploy --latest started in a linked worktree fast-forwards and deploys the main checkout', async (t) => {
  const fixture = deployRepo(t);
  const worktree = path.join(fixture.home, 'task worktree');
  fixture.git(fixture.repo, 'worktree', 'add', '--quiet', '-b', 'task', worktree, 'origin/main');
  const latest = fixture.pushed('Remote commit');
  const report = succeeded(await deployLatestJson(worktree));
  assert.equal(report.commit, fixture.short(latest));
  assert.equal(fixture.head(), latest);
  assert.equal(fixture.git(worktree, 'rev-parse', 'HEAD'), fixture.initial);
  assert.deepEqual(fixture.runs().map(({ cwd }) => cwd), [realpathSync(fixture.repo)]);
});

test('deploy --latest deploys the main checkout also with the GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE of a worktree, as in a git hook', async (t) => {
  const fixture = deployRepo(t);
  const worktree = path.join(fixture.home, 'task worktree');
  fixture.git(fixture.repo, 'worktree', 'add', '--quiet', '-b', 'task', worktree, 'origin/main');
  const latest = fixture.pushed('Remote commit');
  const gitDir = fixture.git(worktree, 'rev-parse', '--absolute-git-dir');
  useEnv(t, { GIT_DIR: gitDir, GIT_WORK_TREE: worktree, GIT_INDEX_FILE: path.join(gitDir, 'index') });
  const report = succeeded(await deployLatestJson(worktree));
  assert.equal(report.commit, fixture.short(latest));
  assert.equal(fixture.head(), latest);
  assert.deepEqual(fixture.runs().map(({ cwd, repoVariables }) => ({ cwd, repoVariables })), [{ cwd: realpathSync(fixture.repo), repoVariables: [] }]);
});

test('deploy --latest leaves the git limits of the process as it found them', async (t) => {
  const fixture = deployRepo(t);
  const elsewhere = path.join(fixture.home, 'elsewhere');
  mkdirSync(elsewhere);
  t.after(resetGitLimits);
  limitGitCalls(60_000, Date.now() - 1);
  assert.equal(commonDir(elsewhere), undefined);
  succeeded(await deployLatestJson(fixture.repo));
  assert.ok(gitTimedOut(elsewhere), 'a folder that did not answer before still counts as one');
  assert.equal(commonDir(fixture.repo), undefined, 'git calls still end at the deadline set before');
});

/** Copies this repo's files, uncommitted ones too, so a bin/ledger run from the copy acts on the copy and never on this repo. */
function ledgerCopy(repo: string): void {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  for (const file of listed.stdout.split('\0')) {
    if (!file || file.startsWith('.claude/') || !existsSync(path.join(REPO, file))) continue;
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    copyFileSync(path.join(REPO, file), path.join(repo, file));
  }
  writeFileSync(path.join(repo, 'tools/deploy.ts'), STUB_DEPLOY);
  writeFileSync(path.join(repo, 'notes.txt'), 'tracked\n');
}

function ledgerIn(fixture: ReturnType<typeof deployRepo>, args: string[], input: string) {
  const result = spawnSync(path.join(fixture.repo, 'bin/ledger'), args, { cwd: fixture.home, env: { ...fixture.env, NO_COLOR: '1' }, input, encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
}

test('ledger deploy --latest --json deploys the latest main of the checkout that holds bin/ledger, with stdin closed', async (t) => {
  const fixture = deployRepo(t, ledgerCopy);
  fixture.stub({ stdout: ['mods     ledger@ledger already installed'], readStdin: true });
  const latest = fixture.pushed('Remote commit');
  const result = ledgerIn(fixture, ['deploy', '--latest', '--json'], 'y\n');
  assert.equal(result.status, 0, result.stderr);
  const report = succeeded({ code: result.status ?? 1, report: JSON.parse(result.stdout) as Report });
  assert.equal(report.commit, fixture.short(latest));
  assert.equal(fixture.head(), latest);
  const [run, ...more] = fixture.runs();
  assert.deepEqual(more, []);
  assert.deepEqual({ cwd: run.cwd, stdin: run.stdin, force: run.argv.includes('--force') }, { cwd: realpathSync(fixture.repo), stdin: '', force: false });
});

test('ledger deploy without --latest passes its arguments to bin/deploy and pulls nothing', async (t) => {
  const fixture = deployRepo(t, ledgerCopy);
  fixture.pushed('Remote commit');
  const result = ledgerIn(fixture, ['deploy', '--agents', 'researcher,runner'], '');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.head(), fixture.initial);
  assert.deepEqual(fixture.runs().map(({ argv }) => argv), [['--agents', 'researcher,runner']]);
});

test('ledger deploy --latest refuses any option but --json, and deploys nothing', async (t) => {
  const fixture = deployRepo(t, ledgerCopy);
  fixture.pushed('Remote commit');
  const result = ledgerIn(fixture, ['deploy', '--latest', '--force'], '');
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr.trim(), 'ledger deploy --latest takes only --json, not --force.');
  assert.equal(fixture.head(), fixture.initial);
  assert.deepEqual(fixture.runs(), []);
});

test('ledger deploy --latest passes a signal it gets on to bin/deploy and every process bin/deploy started', async (t) => {
  const fixture = deployRepo(t, ledgerCopy);
  const pidFile = stubWithChild(fixture);
  const ledger = spawn(path.join(fixture.repo, 'bin/ledger'), ['deploy', '--latest', '--json'], { cwd: fixture.home, env: { ...fixture.env, NO_COLOR: '1' }, stdio: 'ignore' });
  t.after(() => ledger.kill('SIGKILL'));
  const exited = once(ledger, 'exit');
  assert.ok(await eventually(() => existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8')) > 0, 30_000), 'bin/deploy started its child');
  const install = childStarted(t, pidFile);
  ledger.kill('SIGINT');
  await exited;
  assert.ok(await eventually(() => !running(install)), `process ${install}, which bin/deploy started, still runs`);
});

test('/ledger:deploy reads the report by the names of its fields, all of them and no others', async (t) => {
  const fixture = deployRepo(t);
  // A deploy that fails after the fast-forward reports every field.
  fixture.stub(PARTIAL_DEPLOY);
  fixture.pushed('Remote commit');
  const { report } = await deployLatestJson(fixture.repo);
  const prompt = readFileSync(path.join(REPO, 'mods/ledger/commands/deploy.md'), 'utf8');
  // Steps 1 and 2 read the report, step 3 calls T3; `timeout` is the Bash parameter that step 1 sets.
  const reading = prompt.slice(0, prompt.indexOf('\n3. '));
  const named = new Set([...reading.matchAll(/`"?(\w+)"?(?::[^`]*)?`/g)].map(([, name]) => name).filter((name) => name !== 'timeout'));
  assert.deepEqual([...named].sort(), Object.keys(report).sort());
});
