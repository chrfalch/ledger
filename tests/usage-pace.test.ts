import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { freshHome, REPO } from './helpers.js';

function freshAgentHome(t: TestContext) {
  const home = freshHome(t);
  mkdirSync(path.join(home, '.claude/agents'));
  writeFileSync(path.join(home, '.claude/agents/sol-implementer.md'), '');
  return home;
}

const pathBash = (process.env.PATH ?? '').split(path.delimiter)
  .map((directory) => path.join(directory, 'bash')).find((file) => existsSync(file));
assert.ok(pathBash, 'bash must be available on PATH');
const shells = [...new Set(['/bin/bash', pathBash].filter(existsSync).map((file) => realpathSync(file)))];

for (const shell of shells) {
  describe(shell, () => {

    const NOW = 2000000000;
    const WEEK = 7 * 86400;
    const week = (used = 65, reset = NOW + WEEK / 2) => ({ used_percentage: used, resets_at: reset });
    const five = (used = 85, reset = NOW + 9000) => ({ used_percentage: used, resets_at: reset });

    function snapshot(home: string, value: unknown) {
      mkdirSync(path.join(home, '.claude/state'), { recursive: true });
      writeFileSync(path.join(home, '.claude/state/usage-snapshot.json'), JSON.stringify(value));
    }

    function run(home: string, json = false, searchPath = process.env.PATH) {
      const result = spawnSync(shell, [path.join(REPO, 'hooks/usage-pace.sh'), ...(json ? ['--json'] : [])], {
        cwd: home, env: { ...process.env, PATH: searchPath, HOME: home, USAGE_PACE_NOW: String(NOW) }, input: '{}', encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      return result.stdout;
    }

    function line(home: string, searchPath = process.env.PATH) {
      const output = JSON.parse(run(home, false, searchPath)).hookSpecificOutput;
      assert.equal(output.hookEventName, 'UserPromptSubmit');
      assert.equal(typeof output.additionalContext, 'string');
      return output.additionalContext as string;
    }

    function codex(home: string, entries: unknown[], name = 'latest', age = 0) {
      const directory = path.join(home, '.codex/sessions/2033/05/18');
      mkdirSync(directory, { recursive: true });
      const file = path.join(directory, `${name}.jsonl`);
      writeFileSync(file, entries.map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n') + '\n');
      const time = new Date(Date.now() - age * 1000);
      utimesSync(file, time, time);
    }

    const limits = (used: number, minutes = 10080, reset = NOW + minutes * 30) => ({ payload: { rate_limits: { primary: { used_percent: used, window_minutes: minutes, resets_at: reset }, secondary: null } } });

    for (const [name, value] of [
      ['missing', undefined],
      ['on pace', { captured_at: NOW, seven_day: week(50), five_hour: five(80) }],
      ['weekly threshold is strict', { captured_at: NOW, seven_day: week(60) }],
      ['stale', { captured_at: NOW - 43201, seven_day: week(), five_hour: five() }],
      ['reset passed', { captured_at: NOW, seven_day: week(90, NOW - 1), five_hour: five(90, NOW) }],
      ['five hour stale', { captured_at: NOW - 3601, five_hour: five() }],
      ['invalid capture time', { captured_at: 'invalid', seven_day: week() }],
    ] as const) {
      test(`silent when ${name}`, (t) => {
        const home = freshAgentHome(t);
        if (value !== undefined) snapshot(home, value);
        assert.equal(run(home), '');
      });
    }

    test('weekly threshold is strict at an even pace of 20 percent', (t) => {
      const home = freshAgentHome(t);
      snapshot(home, { captured_at: NOW, seven_day: week(30, 2000483840) });
      assert.equal(run(home), '');
    });

    test('Codex weekly at an even pace of 20 percent permits routing', (t) => {
      const home = freshAgentHome(t);
      snapshot(home, { captured_at: NOW, five_hour: five(85) });
      codex(home, [limits(20, 10080, 2000483840)]);
      assert.equal(line(home), 'Usage pace: Claude is ahead of pace (5-hour 85% used). Codex: week 20% used, even pace 20%. Route implementation to sol-implementer or astra-implementer, as rules/40-model-routing.md says, and tell the operator.');
    });

    test('weekly ahead routes with unknown Codex and valid prompt JSON', (t) => {
      const home = freshAgentHome(t);
      snapshot(home, { captured_at: NOW, seven_day: week() });
      assert.equal(line(home), 'Usage pace: Claude is ahead of pace (week 65% used, even pace 50%). Codex usage unknown. Route implementation to sol-implementer or astra-implementer, as rules/40-model-routing.md says, and tell the operator.');
      const result = JSON.parse(run(home, true));
      assert.deepEqual(result.claude.week, { used: 65, even: 50 });
      assert.equal(result.claude.five_hour, null);
      assert.equal(result.claude.ahead, true);
      assert.deepEqual(result.codex, { windows: [], high: false, unknown: true });
    });

    test('five hour ahead routes and includes both valid Claude windows', (t) => {
      const home = freshAgentHome(t);
      snapshot(home, { captured_at: NOW, seven_day: week(40), five_hour: five() });
      assert.match(line(home), /week 40% used, even pace 50%; 5-hour 85% used/);
      assert.deepEqual(JSON.parse(run(home, true)).claude.five_hour, { used: 85, even: 50 });
    });

    test('stale five hour is omitted while weekly data remains actionable', (t) => {
      const home = freshAgentHome(t);
      snapshot(home, { captured_at: NOW - 3601, seven_day: week(), five_hour: five() });
      assert.doesNotMatch(line(home), /5-hour/);
    });

    for (const [name, used, minutes, high] of [
      ['weekly ahead', 51, 10080, true], ['weekly at pace', 50, 10080, false],
      ['short high', 81, 300, true], ['short threshold', 80, 300, false],
      ['long window', 51, 301, true],
    ] as const) {
      test(`Codex ${name}`, (t) => {
        const home = freshAgentHome(t);
        snapshot(home, { captured_at: NOW, seven_day: week() });
        codex(home, [limits(used, minutes)]);
        const message = line(home);
        assert.equal(message.includes('Do not switch models.'), high);
        assert.equal(message.includes('Route implementation'), !high);
        if (high) assert.match(message, /both plans are high and ask what to do/);
        if (minutes === 10080 && !high) assert.match(message, /Codex: week 50% used, even pace 50%/);
        const result = JSON.parse(run(home, true));
        assert.equal(result.codex.high, high);
        assert.equal(result.codex.unknown, false);
        assert.equal(result.codex.windows.length, 1);
      });
    }

    test('Codex uses newest mtime and last non-null rate limits', (t) => {
      const home = freshAgentHome(t);
      snapshot(home, { captured_at: NOW, seven_day: week() });
      codex(home, [limits(99)], 'z-old', 60);
      codex(home, [limits(99), limits(30), { payload: { rate_limits: null } }, { payload: { other: true } }, '{partial'], 'a new');
      assert.match(line(home), /Codex: week 30% used, even pace 50%/);
    });

    for (const branch of ['BSD', 'GNU'] as const) {
      test(`Codex newest file with pinned ${branch} stat`, (t) => {
        const originalPath = process.env.PATH ?? '';
        const stat = branch === 'BSD' ? '/usr/bin/stat' : originalPath.split(path.delimiter)
          .map((directory) => path.resolve(directory, 'gstat'))
          .find((file) => spawnSync(file, ['--version']).status === 0);
        if (!stat || !existsSync(stat)) {
          t.skip(branch === 'BSD' ? '/usr/bin/stat does not exist' : 'No executable gstat with successful --version found on PATH');
          return;
        }
        const directory = freshHome(t);
        symlinkSync(stat, path.join(directory, 'stat'));
        const home = freshAgentHome(t);
        snapshot(home, { captured_at: NOW, seven_day: week() });
        codex(home, [limits(99)], 'old', 60);
        codex(home, [limits(30)], 'newest');
        assert.match(line(home, directory + path.delimiter + originalPath), /Codex: week 30% used, even pace 50%/);
      });
    }

    test('Codex secondary window can be high when primary is empty', (t) => {
      const home = freshAgentHome(t);
      snapshot(home, { captured_at: NOW, five_hour: five() });
      codex(home, [{ payload: { rate_limits: { primary: {}, secondary: { used_percent: 90, window_minutes: 300, resets_at: NOW + 1000 } } } }]);
      assert.match(line(home), /Do not switch models/);
    });

    for (const [name, entry, age] of [
      ['expired', limits(90, 300, NOW), 0],
      ['unpopulated', { payload: { rate_limits: { primary: {}, secondary: null } } }, 0],
      ['old file', limits(90), 9 * 86400],
    ] as const) {
      test(`Codex unknown when ${name}`, (t) => {
        const home = freshAgentHome(t);
        snapshot(home, { captured_at: NOW, seven_day: week() });
        codex(home, [entry], 'session', age);
        assert.match(line(home), /Codex usage unknown/);
      });
    }

    test('malformed snapshot never blocks prompt', (t) => {
      const home = freshAgentHome(t);
      snapshot(home, {});
      writeFileSync(path.join(home, '.claude/state/usage-snapshot.json'), '{broken');
      assert.equal(run(home), '');
      assert.equal(JSON.parse(run(home, true)).claude.ahead, false);
    });

    test('even pace is clamped at zero before the window starts', (t) => {
      const home = freshAgentHome(t);
      snapshot(home, { captured_at: NOW, seven_day: week(20, NOW + WEEK * 2) });
      assert.deepEqual(JSON.parse(run(home, true)).claude.week, { used: 20, even: 0 });
    });

    for (const json of [false]) {
      test(`no agent files means no output even when ahead (json=${json})`, (t) => {
        const home = freshHome(t);
        snapshot(home, { captured_at: NOW, seven_day: week(), five_hour: five() });
        codex(home, [limits(30)]);
        assert.equal(run(home, json), '');
      });
    }

    test('json mode prints computed fields without agent files', (t) => {
      const home = freshHome(t);
      snapshot(home, { captured_at: NOW, seven_day: week() });
      const result = JSON.parse(run(home, true));
      assert.equal(result.claude.ahead, true);
      assert.notEqual(result.claude.week, null);
      assert.equal(result.codex.unknown, true);
    });

    test('astra implementer alone enables routing', (t) => {
      const home = freshHome(t);
      mkdirSync(path.join(home, '.claude/agents'));
      writeFileSync(path.join(home, '.claude/agents/astra-implementer.md'), '');
      snapshot(home, { captured_at: NOW, seven_day: week() });
      assert.match(line(home), /Route implementation/);
    });

    for (const entries of [[], [{ payload: { other: true } }]]) {
      test(`Codex unknown without a rate limits line: ${JSON.stringify(entries)}`, (t) => {
        const home = freshHome(t);
        mkdirSync(path.join(home, '.claude/agents'));
        writeFileSync(path.join(home, '.claude/agents/sol-implementer.md'), '');
        snapshot(home, { captured_at: NOW, seven_day: week() });
        mkdirSync(path.join(home, '.codex/sessions'), { recursive: true });
        if (entries.length) codex(home, entries);
        assert.match(line(home), /Codex usage unknown/);
      });
    }
  });
}
