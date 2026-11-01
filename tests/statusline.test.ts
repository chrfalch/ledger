import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { freshHome, REPO } from './helpers.js';

const pathBash = (process.env.PATH ?? '').split(path.delimiter)
  .map((directory) => path.join(directory, 'bash')).find((file) => existsSync(file));
assert.ok(pathBash, 'bash must be available on PATH');
const shells = [...new Set(['/bin/bash', pathBash].filter(existsSync).map((file) => realpathSync(file)))];

for (const shell of shells) {
  describe(shell, () => {

    function statusline(home: string, input: unknown) {
      const result = spawnSync(shell, [path.join(REPO, 'hooks/statusline.sh')], {
        cwd: home, env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' },
        input: JSON.stringify(input), encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      return result.stdout;
    }

    for (const limits of [undefined, {}, { five_hour: null, seven_day: null }, { five_hour: { used_percentage: 85.2, resets_at: 2000000000 }, seven_day: { used_percentage: 65.8, resets_at: 2000100000 } }]) {
      test(`status line preserves output and snapshots only populated limits: ${JSON.stringify(limits)}`, (t) => {
        const home = freshHome(t);
        const before = Math.floor(Date.now() / 1000);
        const output = statusline(home, { workspace: { current_dir: `${home}/project` }, model: { display_name: 'Opus' }, rate_limits: limits });
        const populated = Boolean(limits?.five_hour);
        assert.equal(output, `\x1b[0;34m~/project\x1b[0m [\x1b[0;36mOpus\x1b[0m${populated ? ' | session:85% week:66%' : ''}]`);
        const file = path.join(home, '.claude/state/usage-snapshot.json');
        assert.equal(existsSync(file), populated);
        assert.equal(existsSync(path.join(home, '.claude/state/rate-limits.json')), false);
        if (populated) {
          const snapshot = JSON.parse(readFileSync(file, 'utf8'));
          assert.deepEqual(snapshot.five_hour, limits?.five_hour);
          assert.deepEqual(snapshot.seven_day, limits?.seven_day);
          assert.ok(snapshot.captured_at >= before && snapshot.captured_at <= Math.floor(Date.now() / 1000));
          assert.deepEqual(readdirSync(path.dirname(file)), ['usage-snapshot.json']);
        }
      });
    }

    test('status line preserves branch, cwd fallback and a single window', (t) => {
      const home = freshHome(t);
      const git = spawnSync('git', ['init', '--quiet', '--initial-branch=sample'], { cwd: home, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') } });
      assert.equal(git.status, 0);
      assert.equal(statusline(home, { cwd: '/project', rate_limits: { seven_day: { used_percentage: 20, resets_at: 2000000000 } } }), '\x1b[0;34m/project\x1b[0m \x1b[0;32msample\x1b[0m [\x1b[0;36m\x1b[0m week:20%]');
      assert.equal(JSON.parse(readFileSync(path.join(home, '.claude/state/usage-snapshot.json'), 'utf8')).five_hour, null);
    });

    test('snapshot failure does not affect status line output', (t) => {
      const home = freshHome(t);
      writeFileSync(path.join(home, '.claude/state'), 'blocked');
      assert.equal(statusline(home, { cwd: '/project', rate_limits: { five_hour: { used_percentage: 85, resets_at: 2000000000 } } }), '\x1b[0;34m/project\x1b[0m [\x1b[0;36m\x1b[0m | session:85%]');
    });

    test('missing limits preserve the previous snapshot', (t) => {
      const home = freshHome(t);
      mkdirSync(path.join(home, '.claude/state'));
      const file = path.join(home, '.claude/state/usage-snapshot.json');
      writeFileSync(file, '{"captured_at":123}');
      statusline(home, {});
      assert.equal(readFileSync(file, 'utf8'), '{"captured_at":123}');
    });

    const oldCommand = "input=$(cat); dir=$(echo \"$input\" | jq -r '.workspace.current_dir // .cwd // \"\"'); dir=\"${dir/#$HOME/~}\"; model=$(echo \"$input\" | jq -r '.model.display_name // \"\"'); sess=$(echo \"$input\" | jq -r '.rate_limits.five_hour.used_percentage // empty'); week=$(echo \"$input\" | jq -r '.rate_limits.seven_day.used_percentage // empty'); sess_seg=\"\"; [ -n \"$sess\" ] && sess_seg=\" | session:$(printf '%.0f' \"$sess\")%\"; week_seg=\"\"; [ -n \"$week\" ] && week_seg=\" week:$(printf '%.0f' \"$week\")%\"; branch=\"\"; if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then branch=$(git branch --show-current 2>/dev/null); fi; branch_seg=\"\"; [ -n \"$branch\" ] && branch_seg=\" \\033[0;32m${branch}\\033[0m\"; printf '%b' \"\\033[0;34m${dir}\\033[0m${branch_seg} [\\033[0;36m${model}\\033[0m${sess_seg}${week_seg}]\"";

    for (const scenario of ['under HOME', 'outside HOME', 'with rate_limits', 'without rate_limits', 'git branch']) {
      test(`byte equality with the old inline status line: ${scenario}`, { skip: !existsSync('/bin/bash') }, (t) => {
        const home = freshHome(t);
        const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
        if (scenario === 'git branch') {
          assert.equal(spawnSync('git', ['init', '--quiet', '--initial-branch=sample'], { cwd: home, env }).status, 0);
        }
        const input = {
          workspace: { current_dir: scenario === 'outside HOME' ? '/outside/project' : `${home}/project` },
          model: { display_name: 'Opus' },
          ...(scenario === 'with rate_limits' ? { rate_limits: { five_hour: { used_percentage: 85.2 }, seven_day: { used_percentage: 65.8 } } } : {}),
        };
        const old = spawnSync('/bin/bash', ['-c', oldCommand], { cwd: home, env, input: JSON.stringify(input) });
        assert.equal(old.status, 0, old.stderr.toString());
        assert.deepEqual(Buffer.from(statusline(home, input)), old.stdout);
      });
    }

    test('snapshot write leaves no temporary files and preserves rate-limits.json bytes', (t) => {
      const home = freshHome(t);
      const state = path.join(home, '.claude/state');
      mkdirSync(state);
      const existing = Buffer.from('  {"sentinel": true}\n');
      writeFileSync(path.join(state, 'rate-limits.json'), existing);
      statusline(home, { rate_limits: { five_hour: { used_percentage: 85, resets_at: 2000000000 } } });
      assert.deepEqual(readFileSync(path.join(state, 'rate-limits.json')), existing);
      assert.deepEqual(readdirSync(state).sort(), ['rate-limits.json', 'usage-snapshot.json']);
    });
  });
}
