import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { parseDeployArguments } from '../tools/deploy.js';
import { claudeCalls, claudeConfig, claudeInstallPath, claudeLists, failClaude, freshHome, REPO, run, runWithoutClaude } from './helpers.js';

const DEPLOY = [path.join(REPO, 'bin/deploy')] as const;
const REPO_ARGUMENT = REPO.replace(/\/+$/, '');
const LIST_MARKETPLACES = 'plugin marketplace list --json';
const LIST_PLUGINS = 'plugin list --json';
const ADD = `plugin marketplace add ${REPO_ARGUMENT} --scope user`;
const INSTALL_LEDGER = 'plugin install ledger@ledger --scope user';

const changesState = (call: string): boolean => / (add|install|uninstall) /.test(call);

test('the repo ships a marketplace that lists only the ledger mod', () => {
  const marketplace = JSON.parse(readFileSync(path.join(REPO, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(marketplace.name, 'ledger');
  assert.deepEqual(
    marketplace.plugins.map(({ name, source }: { name: string; source: string }) => ({ name, source })),
    [{ name: 'ledger', source: './mods/ledger' }],
  );
});

test('parseDeployArguments maps --no-mods to noMods', () => {
  assert.deepEqual(parseDeployArguments(['--no-mods']), { options: { noMods: true }, help: false });
});

test('deploy adds this repo as a marketplace, then installs the ledger mod and nothing else', (t) => {
  const home = freshHome(t);

  const result = run(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home), [LIST_MARKETPLACES, ADD, LIST_PLUGINS, INSTALL_LEDGER]);
  assert.match(result.stdout, /^mods {5}installed ledger@ledger \(\/ledger\)$/m);
  assert.doesNotMatch(result.stdout, /worktrees/);
});

test('a second deploy finds the marketplace and the mod and changes neither', (t) => {
  const home = freshHome(t);
  run(home, DEPLOY);
  const before = claudeCalls(home).length;

  const result = run(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home).slice(before), [LIST_MARKETPLACES, LIST_PLUGINS]);
});

test('--dry-run names the ledger mod and neither adds nor installs', (t) => {
  const home = freshHome(t);

  const result = run(home, DEPLOY, '--dry-run');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home).filter(changesState), []);
  assert.match(result.stdout, /^(would )?mods\b.*\bledger\b/m);
});

test('--no-mods runs no claude command and says the step was skipped', (t) => {
  const home = freshHome(t);

  const result = run(home, DEPLOY, '--no-mods');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home), []);
  assert.match(result.stdout, /^mods {5}skipped \(--no-mods\)$/m);
});

test('without claude on PATH deploy skips the mods step and succeeds', (t) => {
  const home = freshHome(t);

  const result = runWithoutClaude(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^mods {5}skipped/m);
});

for (const step of ['add', 'install'] as const) {
  test(`a failing ${step} fails deploy with a message on stderr`, (t) => {
    const home = freshHome(t);
    failClaude(home, step);

    const result = run(home, DEPLOY);

    assert.equal(result.status, 1, result.stdout);
    assert.notEqual(result.stderr.trim(), '');
  });
}

test('--revert runs no claude command and prints how to remove the mods', (t) => {
  const home = freshHome(t);
  run(home, DEPLOY);
  const before = claudeCalls(home).length;

  const result = run(home, DEPLOY, '--revert');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home).slice(before), []);
  assert.ok(result.stdout.includes('claude plugin uninstall ledger'), result.stdout);
  assert.ok(!result.stdout.includes('worktrees'), result.stdout);
  assert.ok(result.stdout.includes('claude plugin marketplace remove ledger'), result.stdout);
});

const registeredAt = (location: string): string =>
  JSON.stringify([{ name: 'ledger', source: 'directory', path: location, installLocation: location }]);

const installed = (...plugins: { id: string; scope: string }[]): string => JSON.stringify(plugins);
const LEDGER_AT_USER = { id: 'ledger@ledger', scope: 'user', installPath: path.join(REPO, 'mods/ledger') };

test('deploy reports the ledger mod as already installed', (t) => {
  const home = freshHome(t);
  claudeLists(home, { marketplaces: registeredAt(REPO_ARGUMENT), plugins: installed(LEDGER_AT_USER) });

  const result = run(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home), [LIST_MARKETPLACES, LIST_PLUGINS]);
  assert.match(result.stdout, /^mods {5}ledger@ledger already installed$/m);
});

test('deploy installs the ledger mod when the marketplace is already registered', (t) => {
  const home = freshHome(t);
  claudeLists(home, { marketplaces: registeredAt(REPO_ARGUMENT), plugins: installed() });

  const result = run(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home), [LIST_MARKETPLACES, LIST_PLUGINS, INSTALL_LEDGER]);
});

test('--dry-run makes no changes when the ledger mod is already installed', (t) => {
  const home = freshHome(t);
  claudeLists(home, { marketplaces: registeredAt(REPO_ARGUMENT), plugins: installed(LEDGER_AT_USER) });

  const result = run(home, DEPLOY, '--dry-run');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home).filter(changesState), []);
});

test('deploy installs the ledger mod at user scope when it is installed only at another scope', (t) => {
  const home = freshHome(t);
  claudeLists(home, {
    marketplaces: registeredAt(REPO_ARGUMENT),
    plugins: installed({ id: 'ledger@ledger', scope: 'local' }),
  });

  const result = run(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home), [LIST_MARKETPLACES, LIST_PLUGINS, INSTALL_LEDGER]);
});

test('a marketplace already added from this repo is reported and not added again', (t) => {
  const home = freshHome(t);
  claudeLists(home, { marketplaces: registeredAt(REPO_ARGUMENT) });

  const result = run(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^mods {5}marketplace ledger already added$/m);
  assert.deepEqual(claudeCalls(home).filter((call) => call.startsWith('plugin marketplace ') && call !== LIST_MARKETPLACES), []);
});

test('a marketplace named ledger at another path is reported with the fix and left alone', (t) => {
  const home = freshHome(t);
  claudeLists(home, { marketplaces: registeredAt('/elsewhere/ledger') });

  const result = run(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    result.stdout.includes(
      'mods     marketplace ledger points at /elsewhere/ledger, not this repo; to fix: claude plugin marketplace remove ledger, then run deploy again\n' +
        'mods     skipped install of ledger@ledger until the marketplace points at this repo\n',
    ),
    result.stdout,
  );
  assert.deepEqual(claudeCalls(home).filter((call) => call.startsWith('plugin marketplace ') && call !== LIST_MARKETPLACES), []);
  assert.deepEqual(claudeCalls(home).filter((call) => call.startsWith('plugin ') && !call.startsWith('plugin marketplace ')), []);
});

for (const [list, command] of [['marketplaces', LIST_MARKETPLACES], ['plugins', LIST_PLUGINS]] as const) {
  test(`output from claude ${command} that is not JSON fails deploy with a message naming the command`, (t) => {
    const home = freshHome(t);
    claudeLists(home, { marketplaces: registeredAt(REPO_ARGUMENT), [list]: 'Loading plugins...' });

    const result = run(home, DEPLOY);

    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stderr.includes(`claude ${command}`), result.stderr);
    assert.ok(!result.stderr.includes('SyntaxError'), result.stderr);
  });
}

test('a marketplace added from the real path of a repo deploy reaches through a symlink counts as this repo', (t) => {
  const home = freshHome(t);
  const links = mkdtempSync(path.join(tmpdir(), 'ledger-link-'));
  t.after(() => rmSync(links, { recursive: true, force: true }));
  const linked = path.join(links, 'ledger');
  symlinkSync(realpathSync(REPO), linked);
  claudeLists(home, { marketplaces: registeredAt(realpathSync(REPO)) });

  const result = run(home, [path.join(linked, 'bin/deploy')]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^mods {5}marketplace ledger already added$/m);
  assert.doesNotMatch(result.stdout, /points at/);
});

for (const [list, command] of [['marketplaces', LIST_MARKETPLACES], ['plugins', LIST_PLUGINS]] as const) {
  test(`JSON from claude ${command} that is not a list fails deploy with a message naming the command`, (t) => {
    const home = freshHome(t);
    claudeLists(home, { marketplaces: registeredAt(REPO_ARGUMENT), [list]: '{"error":"not signed in"}' });

    const result = run(home, DEPLOY);

    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stderr.includes(`claude ${command}`), result.stderr);
    assert.ok(!result.stderr.includes('TypeError'), result.stderr);
  });
}

const UNINSTALL_LEDGER = 'plugin uninstall ledger@ledger --scope user --keep-data';
const CONFIGURE_LEDGER = 'plugin configure ledger@ledger --json';

const deployWithStaleCopy = (t: TestContext): string => {
  const home = freshHome(t);
  run(home, DEPLOY);
  appendFileSync(path.join(claudeInstallPath(home, 'ledger@ledger'), '.claude-plugin/plugin.json'), '\n');
  return home;
};

test('deploy reinstalls the ledger mod when its installed copy differs from mods/ledger', (t) => {
  const home = deployWithStaleCopy(t);
  const before = claudeCalls(home).length;

  const result = run(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home).slice(before), [LIST_MARKETPLACES, LIST_PLUGINS, CONFIGURE_LEDGER, UNINSTALL_LEDGER, INSTALL_LEDGER]);
  assert.match(result.stdout, /^mods {5}reinstalled ledger@ledger \(installed copy differed from mods\/ledger\)$/m);
  assert.equal(readFileSync(path.join(claudeInstallPath(home, 'ledger@ledger'), '.claude-plugin/plugin.json'), 'utf8'),
    readFileSync(path.join(REPO, 'mods/ledger/.claude-plugin/plugin.json'), 'utf8'));
});

test('deploy reinstalls the ledger mod when its installed copy is missing', (t) => {
  const home = freshHome(t);
  const missing = { ...LEDGER_AT_USER, installPath: path.join(home, 'no-such-copy') };
  claudeLists(home, { marketplaces: registeredAt(REPO_ARGUMENT), plugins: installed(missing) });

  const result = run(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home), [LIST_MARKETPLACES, LIST_PLUGINS, CONFIGURE_LEDGER, UNINSTALL_LEDGER, INSTALL_LEDGER]);
  assert.match(result.stdout, /^mods {5}reinstalled ledger@ledger /m);
});

test('a reinstall carries each saved config value to the new install', (t) => {
  const home = deployWithStaleCopy(t);
  claudeConfig(home, 'ledger@ledger', { clearPointTokens: '12345' });

  const result = run(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(claudeCalls(home).at(-1), `${INSTALL_LEDGER} --config clearPointTokens=12345`);
});

test('--dry-run with a stale installed copy names the reinstall and makes no change', (t) => {
  const home = deployWithStaleCopy(t);
  const before = claudeCalls(home).length;

  const result = run(home, DEPLOY, '--dry-run');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home).slice(before).filter(changesState), []);
  assert.match(result.stdout, /^mods {5}would reinstall ledger@ledger \(installed copy differs from mods\/ledger\)$/m);
});

test('a failing install after the uninstall tells the operator to run deploy again', (t) => {
  const home = deployWithStaleCopy(t);
  failClaude(home, 'install');

  const result = run(home, DEPLOY);

  assert.equal(result.status, 1, result.stdout);
  assert.ok(claudeCalls(home).includes(UNINSTALL_LEDGER));
  assert.match(result.stderr, /run deploy again/);
});
