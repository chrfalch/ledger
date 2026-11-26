import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import { fileStore } from '../tools/ledger/file-store.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { freshHome, REPO, run, runWithoutClaude, snapshot } from './helpers.js';
import { git, home as fixtureHome, ledgerText, repoKeyOf, repository, worktreeOf } from './ledger-core-fixtures.js';

const DEPLOY = [path.join(REPO, 'bin/deploy')] as const;

test('plain deploy links the ledger terminal command', (t) => {
  const home = freshHome(t);
  const result = run(home, DEPLOY);
  assert.equal(result.status, 0, result.stderr);
  const command = path.join(home, '.local/bin/ledger');
  assert.ok(lstatSync(command).isSymbolicLink());
  assert.equal(readlinkSync(command), path.join(REPO, 'bin/ledger'));
});

test('--dry-run names the ledger terminal link without creating it', (t) => {
  const home = freshHome(t);
  const result = run(home, DEPLOY, '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /link\s+~\/\.local\/bin\/ledger/);
  assert.equal(existsSync(path.join(home, '.local/bin/ledger')), false);
});

test('deploy reports a missing terminal command directory on PATH', (t) => {
  const home = freshHome(t);
  const directory = path.join(home, '.local/bin');
  for (const dry of [false, true]) {
    for (const suffix of [undefined, directory, `${directory}///`]) {
      const searchPath = (process.env.PATH ?? '').split(':')
        .filter((entry) => entry.replace(/\/+$/, '') !== directory);
      if (suffix !== undefined) searchPath.push(suffix);
      const result = spawnSync(DEPLOY[0], dry ? ['--dry-run'] : [], {
        cwd: REPO,
        env: { ...process.env, HOME: home, PATH: searchPath.join(':'), GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      if (suffix === undefined) {
        assert.match(result.stdout, /^path\s+~\/\.local\/bin is not on PATH; add to your shell profile: export PATH="\$HOME\/\.local\/bin:\$PATH"$/m);
      } else assert.doesNotMatch(result.stdout, /not on PATH/);
    }
  }
});

test('--revert removes the ledger terminal link', (t) => {
  const home = freshHome(t);
  assert.equal(run(home, DEPLOY).status, 0);
  const command = path.join(home, '.local/bin/ledger');
  assert.ok(lstatSync(command).isSymbolicLink());
  const result = run(home, DEPLOY, '--revert');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(lstatSync(command, { throwIfNoEntry: false }), undefined);
});

test('ledger ownership: own file survives revert when the prompt is declined', async (t) => {
  if (process.platform !== 'darwin') return t.skip('requires macOS script');
  const home = freshHome(t);
  const command = path.join(home, '.local/bin/ledger');
  mkdirSync(path.dirname(command), { recursive: true });
  writeFileSync(command, 'MINE\n');

  // script rejects Node's socket stdio, so cat gives it plain pipes on both sides.
  const child = spawn('/bin/sh', ['-c', 'cat | script -q /dev/null "$0" --no-codex | cat', DEPLOY[0]], {
    cwd: REPO,
    env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') },
  });
  let stdout = '';
  let answered = false;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    if (!answered && stdout.includes('[y/N]')) {
      answered = true;
      child.stdin.end('N\n');
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('deploy prompt timed out after 60 seconds'));
    }, 60_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  assert.ok(stdout.includes('[y/N]'), 'the ownership prompt appeared');
  let manifest = '';
  try {
    manifest = readFileSync(path.join(home, '.claude/.ledger-manifest'), 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  assert.ok(!manifest.includes(command), 'declined own file must not be in the manifest');
  const reverted = run(home, DEPLOY, '--revert');
  assert.equal(reverted.status, 0, reverted.stderr);
  assert.ok(lstatSync(command).isFile());
  assert.equal(readFileSync(command, 'utf8'), 'MINE\n');
});

test('ledger ownership: nonterminal deploy refuses a foreign symlink', (t) => {
  const home = freshHome(t);
  const command = path.join(home, '.local/bin/ledger');
  const target = path.join(home, 'foreign-ledger');
  mkdirSync(path.dirname(command), { recursive: true });
  writeFileSync(target, 'FOREIGN\n');
  symlinkSync(target, command);

  const refused = run(home, DEPLOY);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--force/);
  assert.equal(readlinkSync(command), target);
});

test('--dry-run after a filtered deploy does not report selected rules as removed', (t) => {
  const home = freshHome(t);
  const deployed = run(home, DEPLOY, '--no-codex');
  assert.equal(deployed.status, 0, deployed.stderr);

  const dry = run(home, DEPLOY, '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.doesNotMatch(dry.stdout, /^remove/m);
});

test('ledger ownership: first deploy accepts a symlink through a repo alias', (t) => {
  const home = freshHome(t);
  const alias = path.join(home, 'repo-alias');
  const command = path.join(home, '.local/bin/ledger');
  symlinkSync(REPO, alias, 'dir');
  mkdirSync(path.dirname(command), { recursive: true });
  symlinkSync(path.join(alias, 'bin/ledger'), command);

  const deployed = run(home, DEPLOY);
  assert.equal(deployed.status, 0, deployed.stderr);
  assert.equal(readlinkSync(command), path.join(REPO, 'bin/ledger'));
});

test('ledger ownership: dry-run reports REPLACE for a foreign symlink', (t) => {
  const home = freshHome(t);
  const command = path.join(home, '.local/bin/ledger');
  const target = path.join(home, 'foreign-ledger');
  mkdirSync(path.dirname(command), { recursive: true });
  writeFileSync(target, 'FOREIGN\n');
  symlinkSync(target, command);

  const dry = run(home, DEPLOY, '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^REPLACE\s+~\/\.local\/bin\/ledger/m);
});

test('ledger ownership: force backs up a foreign symlink before replacing it', (t) => {
  const home = freshHome(t);
  const command = path.join(home, '.local/bin/ledger');
  const target = path.join(home, 'foreign-ledger');
  mkdirSync(path.dirname(command), { recursive: true });
  writeFileSync(target, 'FOREIGN\n');
  symlinkSync(target, command);

  const forced = run(home, DEPLOY, '--force');
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(readlinkSync(command), path.join(REPO, 'bin/ledger'));
  const backups = path.join(home, '.claude/backups');
  assert.ok(existsSync(backups), 'creates a backup directory');
  assert.ok(readdirSync(backups).some((deployment) => {
    if (!deployment.startsWith('deploy-')) return false;
    const saved = path.join(backups, deployment, '.local/bin/ledger');
    return lstatSync(saved, { throwIfNoEntry: false })?.isSymbolicLink()
      && readlinkSync(saved) === target;
  }), 'preserves the original symlink target in the backup');
});

test('ledger ownership: previous manifest permits silent symlink replacement', (t) => {
  const home = freshHome(t);
  const command = path.join(home, '.local/bin/ledger');
  mkdirSync(path.dirname(command), { recursive: true });
  symlinkSync(path.join(home, 'old-repo/bin/ledger'), command);
  writeFileSync(path.join(home, '.claude/.ledger-manifest'), `${command}\n`);

  const deployed = run(home, DEPLOY);
  assert.equal(deployed.status, 0, deployed.stderr);
  assert.doesNotMatch(deployed.stdout, /\[y\/N\]/);
  assert.equal(readlinkSync(command), path.join(REPO, 'bin/ledger'));
  const backups = path.join(home, '.claude/backups');
  assert.ok(!existsSync(backups) || readdirSync(backups).every((deployment) =>
    lstatSync(path.join(backups, deployment, '.local/bin/ledger'), { throwIfNoEntry: false }) === undefined,
  ));
});

function markdownNames(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .sort();
}

function rulesIn(home: string): string[] {
  return markdownNames(path.join(home, '.claude', 'rules'));
}

function agentsIn(home: string): string[] {
  return markdownNames(path.join(home, '.claude', 'agents')).map((name) =>
    path.parse(name).name,
  );
}

function ruleHashes(): Record<string, string> {
  return Object.fromEntries(
    markdownNames(path.join(REPO, 'rules')).map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(path.join(REPO, 'rules', name)))
        .digest('hex'),
    ]),
  );
}

test('--dry-run leaves the temporary home unchanged', (t) => {
  const home = freshHome(t);
  const before = snapshot(home);

  run(home, DEPLOY, '--dry-run');

  assert.deepEqual(snapshot(home), before, '--dry-run changed nothing on disk');
});

test('a filtered --dry-run leaves the temporary home unchanged', (t) => {
  for (const flags of [['--no-codex'], ['--no-argent'], ['--no-stacks'], ['--agents', 'runner'], ['--models', 'opus-5.5']]) {
    const home = freshHome(t);
    const before = snapshot(home);

    const result = run(home, DEPLOY, '--dry-run', ...flags);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshot(home), before, `--dry-run ${flags.join(' ')} changed nothing on disk`);
  }
});

test('a filtered --dry-run that fails removes its temporary rules directory', (t) => {
  const home = freshHome(t);
  const temp = mkdtempSync(path.join(tmpdir(), 'ledger-tmpdir-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));

  const result = spawnSync(DEPLOY[0], ['--dry-run', '--models', 'unknown'], {
    cwd: REPO,
    env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), TMPDIR: temp },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0, result.stdout);
  // tsx keeps its own tsx-<uid> directory in TMPDIR, so only deploy's entries are checked.
  assert.deepEqual(readdirSync(temp).filter((name) => name.startsWith('ledger-')), []);
});

test('plain deploy links every rule without creating CLAUDE.md', (t) => {
  const home = freshHome(t);
  const allRules = markdownNames(path.join(REPO, 'rules'));

  const result = run(home, DEPLOY);
  const deployedRules = rulesIn(home);

  assert.deepEqual(
    { status: result.status, rules: deployedRules },
    { status: 0, rules: allRules },
    `deploy links every rule file: ${JSON.stringify(deployedRules)} ${result.stderr}`,
  );
  assert.ok(
    deployedRules.every((name) =>
      lstatSync(path.join(home, '.claude', 'rules', name)).isSymbolicLink(),
    ),
    'rules are symlinks when nothing is filtered',
  );
  assert.ok(
    !existsSync(path.join(home, '.claude', 'CLAUDE.md')),
    'the repo does not create a CLAUDE.md',
  );
});

test('filtered deploy generates only the requested rules and models', (t) => {
  const home = freshHome(t);

  run(home, DEPLOY);
  run(home, DEPLOY, '--no-argent', '--models', 'opus-5.5,sonnet-5.5');
  const deployedRules = rulesIn(home);

  assert.ok(
    !deployedRules.includes('80-ui-automation.md'),
    `--no-argent drops the UI automation rule: ${JSON.stringify(deployedRules)}`,
  );
  assert.ok(
    deployedRules.length > 0 &&
      !deployedRules.some((name) =>
        lstatSync(path.join(home, '.claude', 'rules', name)).isSymbolicLink(),
      ),
    'a filtered deploy writes real files, not links',
  );
  const routing = readFileSync(
    path.join(home, '.claude', 'rules', '40-model-routing.md'),
    'utf8',
  );
  assert.ok(
    !routing.includes('fable-5') &&
      !routing.includes('gpt-6.2-astra') &&
      routing.includes('opus-5.5'),
    '--models drops the rows not asked for',
  );
  assert.ok(!routing.includes('<!--'), 'no marker survives into a generated rule');
});

test('full deploy after a filtered deploy restores dropped rules', (t) => {
  const home = freshHome(t);
  const allRules = markdownNames(path.join(REPO, 'rules'));

  run(home, DEPLOY);
  run(home, DEPLOY, '--no-argent', '--models', 'opus-5.5,sonnet-5.5');
  run(home, DEPLOY);
  assert.deepEqual(
    rulesIn(home),
    allRules,
    'a later full deploy restores the dropped rule',
  );
});

test('--revert removes deployed rules, agents, and manifest', (t) => {
  const home = freshHome(t);
  run(home, DEPLOY);
  run(home, DEPLOY, '--no-argent', '--models', 'opus-5.5,sonnet-5.5');
  run(home, DEPLOY);

  const result = run(home, DEPLOY, '--revert');

  assert.deepEqual(
    {
      status: result.status,
      rules: rulesIn(home),
      agents: agentsIn(home),
      manifestExists: existsSync(path.join(home, '.claude', '.ledger-manifest')),
    },
    { status: 0, rules: [], agents: [], manifestExists: false },
    `--revert removes the rules and the manifest: ${result.stderr}`,
  );
});

test("deploy preserves a teammate's own CLAUDE.md", (t) => {
  const home = freshHome(t, true);
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');

  run(home, DEPLOY);
  assert.ok(
    readFileSync(claudeMd, 'utf8') === 'MY OWN CONTRACT\n' &&
      !lstatSync(claudeMd).isSymbolicLink(),
    'a CLAUDE.md of your own survives a deploy untouched',
  );
});

test('deploy retires an old CLAUDE.md symlink into the repository', (t) => {
  const home = freshHome(t, true);
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');

  run(home, DEPLOY);
  unlinkSync(claudeMd);
  symlinkSync(path.join(REPO, 'CLAUDE.md'), claudeMd);
  const result = run(home, DEPLOY);
  assert.ok(
    !existsSync(claudeMd) && result.stdout.includes('retire'),
    `an old CLAUDE.md symlink into this repo is retired: ${result.stdout.slice(-200)}`,
  );
});

test('--agents deploys only the named agents', (t) => {
  const home = freshHome(t);

  const selected = run(home, DEPLOY, '--agents', 'runner,reviewer');
  assert.deepEqual(
    { status: selected.status, agents: agentsIn(home) },
    { status: 0, agents: ['reviewer', 'runner'] },
    `--agents deploys only the agents named: ${selected.stderr}`,
  );
});

test('--agents rejects an unknown agent name', (t) => {
  const home = freshHome(t);
  run(home, DEPLOY, '--agents', 'runner,reviewer');

  const unknownAgent = run(home, DEPLOY, '--agents', 'no-such-agent');
  assert.ok(
    unknownAgent.status !== 0 && unknownAgent.stderr.includes('unknown agent'),
    '--agents rejects an unknown name',
  );
});

test('--models rejects an unknown model name', (t) => {
  const home = freshHome(t);
  run(home, DEPLOY, '--agents', 'runner,reviewer');
  run(home, DEPLOY, '--agents', 'no-such-agent');

  const unknownModel = run(home, DEPLOY, '--models', 'no-such-model');
  assert.ok(
    unknownModel.status !== 0 && unknownModel.stderr.includes('unknown feature'),
    '--models rejects an unknown name',
  );
});

test('nonterminal deploy refuses to replace an owned file', (t) => {
  const home = freshHome(t);
  const owned = path.join(home, '.claude', 'ledger.template.md');
  run(home, DEPLOY, '--agents', 'runner,reviewer');
  unlinkSync(owned);
  writeFileSync(owned, 'MINE\n');

  const refused = run(home, DEPLOY);
  assert.ok(
    refused.status !== 0 &&
      refused.stderr.includes('--force') &&
      readFileSync(owned, 'utf8') === 'MINE\n',
    'refuses to replace a file of your own without a terminal',
  );
});

test('--force replaces an owned file and backs it up after refusal', (t) => {
  const home = freshHome(t);
  const owned = path.join(home, '.claude', 'ledger.template.md');
  run(home, DEPLOY, '--agents', 'runner,reviewer');
  unlinkSync(owned);
  writeFileSync(owned, 'MINE\n');
  run(home, DEPLOY);

  const forced = run(home, DEPLOY, '--force');
  const backups = path.join(home, '.claude', 'backups');
  const preserved = readdirSync(backups).some((deployment) => {
    if (!deployment.startsWith('deploy-')) return false;
    const backup = path.join(backups, deployment, '.claude', 'ledger.template.md');
    return existsSync(backup) && readFileSync(backup, 'utf8') === 'MINE\n';
  });
  assert.ok(
    forced.status === 0 && lstatSync(owned).isSymbolicLink() && preserved,
    '--force replaces it and backs it up',
  );
});

test('--no-codex omits Codex agents and prose', (t) => {
  const home = freshHome(t);

  run(home, DEPLOY, '--no-codex');
  const mechanics = readFileSync(
    path.join(home, '.claude', 'rules', '60-subagent-mechanics.md'),
    'utf8',
  );
  const deployedAgents = agentsIn(home);

  assert.deepEqual(
    {
      agents: deployedAgents,
      hasCodexRunner: deployedAgents.includes('codex-runner'),
      hasCodexExec: mechanics.includes('codex exec'),
      hasCodexCli: mechanics.includes('Codex CLI'),
    },
    {
      agents: ['fable-implementer', 'opus-implementer', 'researcher', 'reviewer', 'runner', 'ui-runner'],
      hasCodexRunner: false,
      hasCodexExec: false,
      hasCodexCli: false,
    },
    `--no-codex drops its agents and its prose: ${JSON.stringify(deployedAgents)}`,
  );
});

test('plain deploy links every agent, the Codex agents included', (t) => {
  const home = freshHome(t);

  const result = run(home, DEPLOY);
  const deployedAgents = agentsIn(home);

  assert.deepEqual(
    { status: result.status, agents: deployedAgents },
    {
      status: 0,
      agents: [
        'astra-implementer',
        'astra-reviewer',
        'codex-runner',
        'fable-implementer',
        'opus-implementer',
        'researcher',
        'reviewer',
        'runner',
        'sol-implementer',
        'ui-runner',
      ],
    },
    `deploy links every agent: ${JSON.stringify(deployedAgents)} ${result.stderr}`,
  );
  assert.ok(
    lstatSync(path.join(home, '.claude', 'agents', 'codex-runner.md')).isSymbolicLink(),
    'codex-runner is linked, not generated',
  );
});

test('filtered deploy over linked rules does not modify repository sources', (t) => {
  const home = freshHome(t);
  run(home, DEPLOY);
  const before = ruleHashes();

  run(home, DEPLOY, '--models', 'opus-5.5');
  const after = ruleHashes();
  const changed = Object.keys(before).filter((name) => before[name] !== after[name]);

  assert.deepEqual(
    after,
    before,
    `a filtered deploy does not write through the symlinks into the repo: ${JSON.stringify(changed)}`,
  );
});

test('narrow deployment leaves no rule references to undeployed agent lanes', (t) => {
  const home = freshHome(t);
  run(
    home,
    DEPLOY,
    '--agents',
    'opus-implementer',
    '--models',
    'opus-5.5',
    '--no-codex',
    '--no-argent',
    '--no-stacks',
  );
  const blob = rulesIn(home)
    .map((name) => readFileSync(path.join(home, '.claude', 'rules', name), 'utf8'))
    .join('');
  const allAgents = [
    'researcher',
    'runner',
    'ui-runner',
    'opus-implementer',
    'fable-implementer',
    'sol-implementer',
    'astra-implementer',
    'astra-reviewer',
    'codex-runner',
    'reviewer',
  ];
  const dangling = allAgents.filter(
    (agent) => agent !== 'opus-implementer' && blob.includes(`\`${agent}\``),
  );

  assert.deepEqual(
    dangling,
    [],
    `no rule names a lane that was not deployed: ${JSON.stringify(dangling)}`,
  );
});

test('deploy installs usage hooks and preserves the prompt ledger hook', (t) => {
  const home = freshHome(t);
  const result = run(home, DEPLOY, '--no-codex', '--no-githooks');
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['statusline.sh', 'usage-pace.sh', 'logged.sh']) {
    const file = path.join(home, '.claude/hooks', name);
    assert.ok(lstatSync(file).isSymbolicLink());
    assert.ok(lstatSync(path.join(REPO, 'hooks', name)).mode & 0o111);
  }
  const settings = JSON.parse(readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
  assert.equal(settings.statusLine.command, '"$HOME"/.claude/hooks/statusline.sh');
  const commands = settings.hooks.UserPromptSubmit.flatMap((entry: { hooks: { command: string }[] }) => entry.hooks.map((hook) => hook.command));
  assert.ok(commands.includes('"$HOME"/.claude/bin/ledger hook prompt-submit'));
  assert.ok(commands.includes('"$HOME"/.claude/hooks/logged.sh usage-pace.sh'));
});

test('deploy links bin/ledger into ~/.claude/bin and wires the ledger hooks to it, not to the bash scripts', (t) => {
  const home = freshHome(t);
  const result = run(home, DEPLOY, '--no-codex', '--no-githooks');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readlinkSync(path.join(home, '.claude/bin/ledger')), path.join(REPO, 'bin/ledger'));
  type Entry = { matcher?: string; hooks: { command: string }[] };
  const settings = JSON.parse(readFileSync(path.join(home, '.claude/settings.json'), 'utf8')) as { hooks: Record<string, Entry[]> };
  const wired = Object.fromEntries(
    Object.entries(settings.hooks).map(([event, entries]) => [event, entries.flatMap(({ matcher, hooks }) => hooks.map(({ command }) => `${matcher ?? '*'}: ${command}`))]),
  );
  const ledger = '"$HOME"/.claude/bin/ledger hook';
  assert.deepEqual(wired, {
    PreToolUse: ['Bash: "$HOME"/.claude/hooks/logged.sh derived-data-gate.sh', `Write|Edit|MultiEdit|Bash: ${ledger} pre-tool-use`],
    PermissionDenied: ['Bash|Read|Grep|Glob|NotebookRead: "$HOME"/.claude/hooks/logged.sh denied-read-retry.sh'],
    PreCompact: [`*: ${ledger} pre-compact`],
    SessionStart: ['startup|resume|clear|fork: "$HOME"/.claude/hooks/logged.sh deploy-drift.sh', `*: ${ledger} session-start`],
    UserPromptSubmit: [`*: ${ledger} prompt-submit`, '*: "$HOME"/.claude/hooks/logged.sh usage-pace.sh'],
  });
});

/** A ~/.claude/hooks the manifest fully lists: a link to a repo hook that is gone, a file of your own, and a link of your own. */
function staleHooks(home: string) {
  const hooks = path.join(home, '.claude/hooks');
  const retired = path.join(hooks, 'retired-gate.sh');
  const ownFile = path.join(hooks, 'my-own-hook.sh');
  const ownLink = path.join(hooks, 'my-linked-hook.sh');
  const ownTarget = path.join(home, 'my-hooks/my-linked-hook.sh');
  mkdirSync(hooks, { recursive: true });
  symlinkSync(path.join(REPO, 'hooks/retired-gate.sh'), retired);
  writeFileSync(ownFile, '#!/bin/bash\n');
  symlinkSync(ownTarget, ownLink);
  writeFileSync(path.join(home, '.claude/.ledger-manifest'), `${[retired, ownFile, ownLink].join('\n')}\n`);
  return { retired, ownFile, ownLink, ownTarget };
}

test('deploy removes a manifest hook link into the repo whose hook is gone, and keeps a file or a link of your own', (t) => {
  const home = freshHome(t);
  const { retired, ownFile, ownLink, ownTarget } = staleHooks(home);

  const result = run(home, DEPLOY, '--no-codex', '--no-githooks');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(lstatSync(retired, { throwIfNoEntry: false }), undefined);
  assert.equal(readFileSync(ownFile, 'utf8'), '#!/bin/bash\n');
  assert.equal(readlinkSync(ownLink), ownTarget);
  assert.ok(!readFileSync(path.join(home, '.claude/.ledger-manifest'), 'utf8').includes(retired));
});

test('--dry-run names a manifest hook link whose hook is gone, and removes nothing', (t) => {
  const home = freshHome(t);
  const { retired } = staleHooks(home);

  const dry = run(home, DEPLOY, '--dry-run', '--no-codex', '--no-githooks');
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(dry.stdout.split('\n').filter((line) => line.startsWith('remove ')), ['remove   ~/.claude/hooks/retired-gate.sh   (no longer in the repo)']);
  assert.ok(lstatSync(retired).isSymbolicLink());
});

test('the drift hook reports a deployed hook link whose hook left the repo', (t) => {
  const home = freshHome(t);
  const deployed = run(home, DEPLOY, '--no-githooks');
  assert.equal(deployed.status, 0, deployed.stderr);
  const drift = path.join(home, '.claude/hooks/deploy-drift.sh');
  assert.equal(run(home, [drift]).stdout, '', 'a fresh deploy has no drift');

  symlinkSync(path.join(REPO, 'hooks/retired-gate.sh'), path.join(home, '.claude/hooks/retired-gate.sh'));
  assert.match(run(home, [drift]).stdout, /stale link: \.claude\/hooks\/retired-gate\.sh/);
});

/** A HOME whose old task list names the .claude/ledger.md of a linked worktree of ~/repos/app, from before active records. */
function homeWithUnmovedLedger(t: TestContext, markdown = ledgerText({ slug: 'task' })) {
  const home = fixtureHome(t);
  const app = repository(home, path.join(home, 'repos/app'));
  const folder = worktreeOf(app, 'task');
  git(home, app, 'worktree', 'add', '--quiet', '-b', 'me/task', folder);
  mkdirSync(path.join(folder, '.claude'));
  const file = path.join(folder, '.claude/ledger.md');
  writeFileSync(file, markdown);
  const entry = { repo: 'x', slug: 'task', path: file, branch: 'me/task', status: 'active', main: app, created: '2026-10-01T00:00:00.000Z', updated: '2026-10-01T00:00:00.000Z' };
  writeFileSync(path.join(home, '.claude/ledgers.json'), JSON.stringify([entry]));
  return { home, file, folder, app };
}

test('deploy moves each .claude/ledger.md into the ledger store once, and prints what moved', (t) => {
  const { home, file, folder } = homeWithUnmovedLedger(t);

  const deployed = runWithoutClaude(home, DEPLOY, '--no-codex');

  assert.equal(deployed.status, 0, deployed.stderr);
  assert.match(deployed.stdout, /^ledgers +moved .*\.claude\/ledger\.md to active app task/m);
  assert.equal(existsSync(file), false);
  assert.ok(fileStore(ledgerPaths(home)).active.byWorktree(folder), 'no active record names the worktree');
});

test('deploy --dry-run moves no .claude/ledger.md', (t) => {
  const { home, file } = homeWithUnmovedLedger(t);

  const deployed = runWithoutClaude(home, DEPLOY, '--dry-run', '--no-codex');

  assert.equal(deployed.status, 0, deployed.stderr);
  assert.ok(existsSync(file));
});

test('a deploy whose move of the ledgers leaves one says so, names the command to run again, and still exits 0', (t) => {
  const { home, file } = homeWithUnmovedLedger(t, '## Goal\nA ledger whose heading names no slug.\n');

  const deployed = runWithoutClaude(home, DEPLOY, '--no-codex');

  assert.equal(deployed.status, 0, deployed.stderr);
  assert.match(deployed.stdout, /^ledgers +left .*its heading names no task slug/m);
  assert.match(deployed.stdout, /ledger store migrate --active/);
  assert.ok(existsSync(file));
});

/** Adds a backlog ledger kept as Markdown, from before task records, to the store of `home`, for the repo at `app`. */
function addMarkdownBacklogLedger(home: string, app: string): string {
  const location = fileStore(ledgerPaths(home)).backlog.repoLocation(repoKeyOf(app));
  mkdirSync(location, { recursive: true });
  const file = path.join(location, 'stray.md');
  writeFileSync(file, ledgerText({ slug: 'stray', main: app }));
  return file;
}

test('--migrate runs each pending move, prints what moved, and deploys no files', (t) => {
  const { home, file, folder, app } = homeWithUnmovedLedger(t);
  const markdown = addMarkdownBacklogLedger(home, app);

  const migrated = runWithoutClaude(home, DEPLOY, '--migrate');

  assert.equal(migrated.status, 0, migrated.stderr);
  assert.match(migrated.stdout, /^ledgers +moved .*\.claude\/ledger\.md to active app task/m);
  assert.match(migrated.stdout, /^ledgers +converted backlog .* stray/m);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(markdown), false);
  assert.ok(fileStore(ledgerPaths(home)).active.byWorktree(folder), 'no active record names the worktree');
  assert.equal(existsSync(path.join(home, '.local/bin/ledger')), false);
  assert.equal(existsSync(path.join(home, '.claude/.ledger-manifest')), false);
});

test('--migrate --dry-run prints the pending moves and changes nothing', (t) => {
  const { home, file } = homeWithUnmovedLedger(t);
  const before = snapshot(home);

  const migrated = runWithoutClaude(home, DEPLOY, '--migrate', '--dry-run');

  assert.equal(migrated.status, 0, migrated.stderr);
  assert.ok(migrated.stdout.split('\n').some((line) => line.includes(`${file} → active app task`)), migrated.stdout);
  assert.doesNotMatch(migrated.stdout, /^ledgers +moved/m);
  assert.deepEqual(snapshot(home), before);
});

test('--migrate with nothing pending says so and exits 0', (t) => {
  const home = freshHome(t);
  const migrated = runWithoutClaude(home, DEPLOY, '--migrate');
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.match(migrated.stdout, /^Nothing to move\.$/m);
});

test('--migrate exits 0 when every task it can move moved, names each task that stays and why, and never runs a move with nothing it can do', (t) => {
  const { home, app, file } = homeWithUnmovedLedger(t);
  const stuck = worktreeOf(app, 'stuck');
  git(home, app, 'worktree', 'add', '--quiet', '-b', 'me/stuck', stuck);
  mkdirSync(path.join(stuck, '.claude'));
  writeFileSync(path.join(stuck, '.claude/ledger.md'), '## Goal\nA ledger whose heading names no slug.\n');

  const migrated = runWithoutClaude(home, DEPLOY, '--migrate');

  assert.equal(migrated.status, 0, migrated.stdout);
  assert.equal(existsSync(file), false);
  assert.match(migrated.stdout, /^ledgers +moved .* to active app task/m);
  assert.match(migrated.stdout, /^moves +active +.*stuck.* stays: its heading names no task slug/m);
  assert.doesNotMatch(migrated.stdout, /Convert (repo keys|backlog and archive)/);
});

/**
 * A HOME with three finished tasks under folder names whose repo is gone or unknown, as a second machine has them: notes
 * with no ledger, a ledger whose main is `.`, and one whose main is gone and carries a note. With `stuck`, also a backlog
 * ledger whose main is gone, which needs a person; with `movable`, also a backlog ledger of the live repo ~/repos/app.
 */
function homeWithFinishedLeftovers(t: TestContext, { stuck = false, movable = false } = {}) {
  const home = fixtureHome(t);
  const store = fileStore(ledgerPaths(home));
  const notes = store.archive.evidenceLocation('expo', '2026-10-14-core-only-evidence');
  mkdirSync(notes, { recursive: true });
  writeFileSync(path.join(notes, 'red.txt'), 'failing\n');
  store.archive.write('jev-sim-controller', '2026-10-12-keychain-keys', ledgerText({ slug: 'keychain-keys', main: '.' }));
  const gone = path.join(home, 'repos/react-native-netinfo/react-native-netinfo');
  mkdirSync(path.dirname(gone), { recursive: true });
  store.archive.write('react-native-netinfo', '2026-10-28-spm-package', ledgerText({ slug: 'spm-package', main: `${gone} (lib fork clone; ledger moved here 2026-10-27, operator option 1)` }));
  if (stuck) store.backlog.write('react-native-netinfo', 'later', ledgerText({ slug: 'later', main: gone }));
  if (movable) store.backlog.write('app', 'next', ledgerText({ slug: 'next', main: repository(home, path.join(home, 'repos/app')) }));
  return { home, gone };
}

const FINISHED = ['2026-10-14-core-only-evidence', '2026-10-12-keychain-keys', '2026-10-28-spm-package'];

const finishedLines = (gone: string): string[] => [
  'moves    3 finished tasks stay under their old repo folder name, as that folder is gone or unknown. Nothing to do: they stay readable in the archive.',
  'moves    expo/2026-10-14-core-only-evidence: notes of a finished task whose ledger is not in the store',
  'moves    jev-sim-controller/2026-10-12-keychain-keys: its saved main checkout "." is a relative path, so its repo folder cannot be recovered',
  `moves    react-native-netinfo/2026-10-28-spm-package: its repo folder ${gone} is gone`,
];

for (const dry of [false, true]) {
  test(`--migrate${dry ? ' --dry-run' : ''} names the finished tasks that stay under a gone folder name as nothing to do, and exits 0`, (t) => {
    const { home, gone } = homeWithFinishedLeftovers(t);

    const migrated = runWithoutClaude(home, DEPLOY, '--migrate', ...(dry ? ['--dry-run'] : []));

    assert.equal(migrated.status, 0, migrated.stdout);
    assert.deepEqual(migrated.stdout.trimEnd().split('\n'), finishedLines(gone));
  });
}

test('--migrate names the tasks that need a person apart from the finished tasks that stay, and exits 0', (t) => {
  const { home, gone } = homeWithFinishedLeftovers(t, { stuck: true });

  const migrated = runWithoutClaude(home, DEPLOY, '--migrate');

  assert.equal(migrated.status, 0, migrated.stdout);
  assert.deepEqual(migrated.stdout.trimEnd().split('\n'), [
    'moves    1 task needs a person to move it:',
    `moves    repo-ids backlog react-native-netinfo/later stays: its repo folder ${gone} is gone`,
    ...finishedLines(gone),
    'Nothing deploy can move: each task above stays for the reason it names.',
  ]);
});

test('--migrate that moves a task names each task that stays once, under one line for the finished ones, and exits 0', (t) => {
  const { home } = homeWithFinishedLeftovers(t, { movable: true, stuck: true });

  const migrated = runWithoutClaude(home, DEPLOY, '--migrate');

  assert.equal(migrated.status, 0, migrated.stdout);
  const lines = migrated.stdout.split('\n');
  assert.match(migrated.stdout, /^ledgers +moved backlog app\/next to /m);
  for (const name of [...FINISHED, 'react-native-netinfo/later']) assert.equal(lines.filter((line) => line.includes(name)).length, 1, `${name}:\n${migrated.stdout}`);
  assert.equal(lines.filter((line) => /\d+ finished tasks? /.test(line)).length, 1, migrated.stdout);
});

test('--migrate words its leftovers as ledger store migrate --pending does', (t) => {
  const { home } = homeWithFinishedLeftovers(t, { stuck: true });

  const pending = runWithoutClaude(home, [path.join(REPO, 'bin/ledger')], 'store', 'migrate', '--pending');
  const migrated = runWithoutClaude(home, DEPLOY, '--migrate', '--dry-run');

  assert.equal(pending.status, 0, pending.stderr);
  const unindented = (lines: string[]): string[] => lines.filter((line) => !line.startsWith(' '));
  assert.deepEqual(
    unindented(migrated.stdout.trimEnd().split('\n').filter((line) => /^moves +\d/.test(line)).map((line) => line.replace(/^moves +/, ''))),
    unindented(pending.stdout.trimEnd().split('\n')),
  );
  assert.deepEqual(
    migrated.stdout.split('\n').filter((line) => FINISHED.some((name) => line.includes(name))).map((line) => line.replace(/^moves +/, '')),
    pending.stdout.split('\n').filter((line) => FINISHED.some((name) => line.includes(name))).map((line) => line.trim()),
  );
});

for (const dry of [false, true]) {
  test(`plain deploy${dry ? ' --dry-run' : ''} prints nothing for finished tasks that stay under a gone folder name`, (t) => {
    const { home } = homeWithFinishedLeftovers(t);

    const deployed = runWithoutClaude(home, DEPLOY, '--no-codex', ...(dry ? ['--dry-run'] : []));

    assert.equal(deployed.status, 0, deployed.stderr);
    assert.doesNotMatch(deployed.stdout, /^moves /m);
    assert.doesNotMatch(deployed.stdout, /keychain-keys|spm-package|core-only-evidence/);
  });
}

/**
 * Runs deploy --migrate against a stub bin/ledger: --pending lists one records move, and the move exits `status`. After
 * the move, --pending lists nothing, unless `sticky`; with `once`, it lists nothing after its first answer.
 */
function migrateWithStubLedger(t: TestContext, status: number, { sticky = false, once = false } = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), 'ledger-stub-repo-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(path.join(repo, 'bin'));
  const move = { kind: 'records', from: 'Markdown backlog app stray', to: 'task record', auto: true };
  writeFileSync(path.join(repo, 'bin/pending.json'), JSON.stringify({ moves: [move] }));
  writeFileSync(path.join(repo, 'bin/status'), String(status));
  if (sticky) writeFileSync(path.join(repo, 'bin/sticky'), '');
  if (once) writeFileSync(path.join(repo, 'bin/once'), '');
  const nothing = `echo '{"moves":[]}' > "$here/pending.json"`;
  writeFileSync(
    path.join(repo, 'bin/ledger'),
    [
      '#!/bin/sh',
      'here=$(dirname "$0")',
      'case "$*" in',
      `  *--pending*) cat "$here/pending.json"; if [ -e "$here/once" ]; then ${nothing}; fi ;;`,
      `  *) echo "ran $*"; if [ ! -e "$here/sticky" ]; then ${nothing}; fi; exit "$(cat "$here/status")" ;;`,
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const deployModule = JSON.stringify(path.join(REPO, 'tools/deploy.ts'));
  const ran = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `const { main } = await import(${deployModule}); main(['--migrate']);`], {
    cwd: REPO,
    env: { ...process.env, HOME: freshHome(t), DEPLOY_REPO: repo },
    encoding: 'utf8',
  });
  return { ...ran, moved: /^ledgers +ran store migrate --records$/m.test(ran.stdout) };
}

test('--migrate exits 0 when a move exits 1 and leaves nothing it could move', (t) => {
  const ran = migrateWithStubLedger(t, 1);
  assert.equal(ran.status, 0, ran.stdout);
  assert.ok(ran.moved, ran.stdout);
});

test('--migrate exits 1 when a move exits above 1, and says so', (t) => {
  const ran = migrateWithStubLedger(t, 2);
  assert.equal(ran.status, 1, ran.stdout);
  assert.ok(ran.moved, ran.stdout);
  assert.match(ran.stdout, /ledger store migrate --records exited 2/);
});

test('--migrate exits 1 when a move it ran is still to do after the run', (t) => {
  const ran = migrateWithStubLedger(t, 0, { sticky: true });
  assert.equal(ran.status, 1, ran.stdout);
  assert.ok(ran.moved, ran.stdout);
  assert.match(ran.stdout, /^moves +records +Markdown backlog app stray → task record$/m);
});

test('--migrate checks again before each kind, and runs no move the fresh check no longer lists', (t) => {
  const ran = migrateWithStubLedger(t, 0, { once: true });
  assert.equal(ran.status, 0, ran.stdout);
  assert.ok(!ran.moved, ran.stdout);
});

for (const flag of [['--revert'], ['--force'], ['--no-codex'], ['--codex'], ['--agents', 'runner'], ['--models', 'opus-5.5']]) {
  test(`--migrate refuses ${flag[0]}`, (t) => {
    const migrated = runWithoutClaude(freshHome(t), DEPLOY, '--migrate', ...flag);
    assert.equal(migrated.status, 1);
    assert.match(migrated.stderr, new RegExp(`--migrate .*${flag[0]}`));
  });
}

test('plain deploy moves the .claude/ledger.md files, then names the other pending moves and how to run them', (t) => {
  const { home, file, app } = homeWithUnmovedLedger(t);
  const markdown = addMarkdownBacklogLedger(home, app);

  const deployed = runWithoutClaude(home, DEPLOY, '--no-codex');

  assert.equal(deployed.status, 0, deployed.stderr);
  assert.equal(existsSync(file), false);
  assert.ok(existsSync(markdown), 'deploy converted the Markdown ledger without being asked');
  assert.ok(deployed.stdout.split('\n').some((line) => line.includes('Markdown backlog app stray → task record')), deployed.stdout);
  assert.doesNotMatch(deployed.stdout, /\.claude\/ledger\.md → /);
  assert.match(deployed.stdout, /deploy --migrate to move them\./);
});

test('plain deploy with no other pending moves gives no --migrate hint', (t) => {
  const { home } = homeWithUnmovedLedger(t);
  const deployed = runWithoutClaude(home, DEPLOY, '--no-codex');
  assert.equal(deployed.status, 0, deployed.stderr);
  assert.doesNotMatch(deployed.stdout, /--migrate/);
});

test('deploy --dry-run lists the moves still to do', (t) => {
  const { home, file } = homeWithUnmovedLedger(t);

  const deployed = runWithoutClaude(home, DEPLOY, '--dry-run', '--no-codex');

  assert.equal(deployed.status, 0, deployed.stderr);
  assert.match(deployed.stdout, /^moves +still to do:$/m);
  assert.ok(deployed.stdout.split('\n').some((line) => line.includes(`${file} → active app task`)), deployed.stdout);
});
