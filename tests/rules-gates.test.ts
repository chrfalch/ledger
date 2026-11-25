import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { buildRules } from '../tools/build-rules.js';
import { ALL_AGENTS, CODEX_AGENTS, MODELS } from '../tools/deploy.js';
import { REPO } from './helpers.js';

const LIST_GATED_RULES = ['40-model-routing.md', '60-subagent-mechanics.md'];
const GATED_RULES = ['10-operating-model.md', '20-writing.md', ...LIST_GATED_RULES];

// Mirrors the feature list deploy() passes to buildRules for a filtered deploy.
function deployFeatures({ agents, noCodex = false }: { agents?: string[]; noCodex?: boolean }): string[] {
  const deployed = agents ?? ALL_AGENTS.filter((agent) => !(noCodex && CODEX_AGENTS.includes(agent)));
  return [...deployed, MODELS, ...(noCodex ? [] : ['codex']), 'argent', 'gh-stack'];
}

const SELECTIONS: [string, string[]][] = [
  ['features codex,codex-runner,gpt-6.2-sol', ['codex', 'codex-runner', 'gpt-6.2-sol']],
  ['--no-codex', deployFeatures({ noCodex: true })],
  ...ALL_AGENTS.map((agent): [string, string[]] => [`--agents ${agent}`, deployFeatures({ agents: [agent] })]),
];

function render(t: TestContext, features: string[]): Map<string, string> {
  const out = mkdtempSync(path.join(tmpdir(), 'ledger-rules-gates-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  assert.equal(buildRules({ src: path.join(REPO, 'rules'), out, features: features.join(',') }), 0);
  return new Map(GATED_RULES.map((name) => [name, readFileSync(path.join(out, name), 'utf8')]));
}

function namedAgents(text: string): string[] {
  return ALL_AGENTS.filter((agent) => new RegExp(`(?<![\\w-])${agent}(?![\\w-])`, 'i').test(text));
}

function listHeadersWithoutItems(text: string): string[] {
  const lines = text.split('\n').filter((line) => line.trim());
  return lines.filter((line, index) => line.trimEnd().endsWith(':') && !/^\s*([-*|]|\d+\.)\s/.test(lines[index + 1] ?? ''));
}

test('a full render names every agent, so the gate checks below can see them', (t) => {
  const rendered = [...render(t, deployFeatures({})).values()].join('\n');
  assert.deepEqual(namedAgents(rendered), ALL_AGENTS);
});

for (const [label, features] of SELECTIONS) {
  test(`rules rendered for ${label} name only deployed agents`, (t) => {
    for (const [name, text] of render(t, features)) {
      const undeployed = namedAgents(text).filter((agent) => !features.includes(agent));
      assert.deepEqual(undeployed, [], `rules/${name} names undeployed agents`);
      if (LIST_GATED_RULES.includes(name)) {
        assert.deepEqual(listHeadersWithoutItems(text), [], `rules/${name} has a list header with no list under it`);
      }
      if (!features.includes('astra-implementer') && !features.includes('astra-reviewer')) {
        assert.doesNotMatch(text, /astra-impl/, `rules/${name} shows an Astra label example without an Astra agent`);
      }
    }
  });
}

const WRAPPER_RULE = /Every Codex run goes through a wrapper/;

for (const agent of ['researcher', 'sol-implementer']) {
  test(`rules rendered for --agents ${agent} omit the wrapper-only Codex rule without codex-runner`, (t) => {
    assert.doesNotMatch(render(t, deployFeatures({ agents: [agent] })).get('60-subagent-mechanics.md') ?? '', WRAPPER_RULE);
  });
}

test('rules rendered for --agents codex-runner keep the wrapper-only Codex rule', (t) => {
  assert.match(render(t, deployFeatures({ agents: ['codex-runner'] })).get('60-subagent-mechanics.md') ?? '', WRAPPER_RULE);
});

const RULES = path.join(REPO, 'rules');

function ruleSources(): Map<string, string> {
  const names = readdirSync(RULES).filter((name) => name.endsWith('.md')).sort();
  return new Map(names.map((name) => [name, readFileSync(path.join(RULES, name), 'utf8')]));
}

function ruleSource(name: string): string {
  return readFileSync(path.join(RULES, name), 'utf8');
}

/** The section that starts at `heading` and ends before the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `no "${heading}" heading`);
  const level = heading.indexOf(' ');
  const end = lines.findIndex((line, index) => index > start && /^#+ /.test(line) && line.indexOf(' ') <= level);
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

function tableHeaderCells(line: string): string {
  return line.split('|').map((cell) => cell.replace(/`/g, '').trim().toLowerCase()).filter(Boolean).join('|');
}

/** Rule 10 with each run of whitespace collapsed to one space, so a check can span wrapped lines. */
function flatRule10(): string {
  return ruleSource('10-operating-model.md').replace(/\s+/g, ' ');
}

const OLD_CLEAR_POINT = 'Clear point. Ledger updated.';

test('the ledger sections of rule 10 state policy in 300 to 575 words and point to ledger --help', () => {
  const text = ruleSource('10-operating-model.md');
  const sections = ['### Checkpoint gate', '### Archiving a ledger', '## Compact Instructions'].map((heading) => section(text, heading)).join('\n');
  const words = sections.split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 300 && words <= 575, `the three sections hold ${words} words`);
  assert.match(sections, /`ledger --help`/);
});

test('rule 10 asks the clear point with the question widget, not as a typed sentence', () => {
  const rule = flatRule10();
  assert.match(rule, /clear point is a question asked with the question widget \(AskUserQuestion\)/i);
  assert.ok(!rule.includes(OLD_CLEAR_POINT));
});

test('rule 10 offers the clear point after each review verdict with work left, rejected ones included', () => {
  const rule = flatRule10();
  assert.match(rule, /after each review verdict with work left/i);
  assert.match(rule, /rejected verdict/i);
});

test('rule 10 offers the clear point when a size reminder arrives', () => {
  assert.match(flatRule10(), /size reminder/i);
});

test('rule 10 names the three clear-point options in order', () => {
  const rule = flatRule10();
  const labels = ['"Save, clear and continue (Recommended)"', '"Not now"', '"Close"'];
  const positions = labels.map((label) => rule.indexOf(label));
  assert.ok(positions.every((position) => position >= 0), `missing a label: ${positions}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test('rule 10 has the agent run /ledger:next on "Save, clear and continue"', () => {
  assert.match(flatRule10(), /"Save, clear and continue \(Recommended\)"[^.]*runs `\/ledger:next` with the Skill tool/);
});

test('rule 10 has the operator type /ledger:close on "Close"', () => {
  assert.match(flatRule10(), /"Close"[^.]*tell the operator to type `\/ledger:close`/);
});

/** The sentences of the three ledger sections of rule 10, without headings and list markers. */
function ledgerSentences(): string[] {
  const text = ruleSource('10-operating-model.md');
  const prose = ['### Checkpoint gate', '### Archiving a ledger', '## Compact Instructions']
    .map((heading) => section(text, heading))
    .join('\n')
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .map((line) => line.replace(/^\s*(-|\d+\.)\s+/, '').replace(/\*\*/g, ''))
    .join(' ');
  return prose.split(/(?<=[.!?]"?)\s+/).map((sentence) => sentence.trim()).filter(Boolean);
}

test('each sentence of the ledger sections of rule 10 is under 20 words', () => {
  const long = ledgerSentences().filter((sentence) => sentence.split(/\s+/).length >= 20);
  assert.deepEqual(long, []);
});

test('rule 10 accepts and finishes after the last review verdict, with no clear point', () => {
  assert.match(flatRule10(), /After the last review verdict, accept; no clear point\./);
});

test('/ledger:update ends a cycle with work left on the clear-point widget question', () => {
  const update = readFileSync(path.join(REPO, 'mods/ledger/commands/update.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(!update.includes(OLD_CLEAR_POINT));
  assert.match(update, /AskUserQuestion/);
  assert.match(update, /"Save, clear and continue \(Recommended\)"/);
});

test('rule 10 tells the operator how to clear when /ledger:next cannot', () => {
  assert.match(flatRule10(), /If `\/ledger:next` or `\/ledger:close` fails to clear, tell the operator to type `\/clear`, then `go`\./);
});

test('rule 10 states each ledger rule in exact words', () => {
  const rule = flatRule10();
  for (const sentence of [
    'The ledger lives in the ledger store.',
    'Write it with `ledger notes`, one item per command.',
    "Keep cited files small, in the worktree's `.claude/evidence/`, never in the session scratchpad.",
    'Keep the ledger under ~4k tokens.',
    'Never pass `--force`.',
    'Never remove or delete a worktree whose ledger is unarchived.',
    "A ticked option is the operator's approval to run it.",
  ]) {
    assert.ok(rule.includes(sentence), `rule 10 lacks: ${sentence}`);
  }
  assert.ok(ruleSource('10-operating-model.md').split('\n').includes('## Compact Instructions'));
});

test('the Plan gate of rule 10 reads the design refs and puts lasting decisions in an LLP the reviewer checks (D47)', () => {
  const rule = ruleSource('10-operating-model.md');
  const plan = section(rule, '### Plan gate').replace(/\s+/g, ' ');
  for (const sentence of [
    "Before you write the plan, read the LLPs in the ledger's design refs.",
    'With `llp/` in the repo, a lasting design decision goes in an LLP document in the same PR.',
    'Review checks that the LLP records it.',
  ]) {
    assert.ok(plan.includes(sentence), `the Plan gate lacks: ${sentence}`);
  }
  assert.doesNotMatch(section(rule, '### Checkpoint gate'), /LLP/);
});

test('rule 10 writes every /ledger:go, /ledger:parent, /ledger:task and /ledger:retire with its argument', () => {
  const rule = ruleSource('10-operating-model.md');
  assert.doesNotMatch(rule, /`\/ledger:(go|parent|task|retire)`/);
  assert.match(rule.replace(/\s+/g, ' '), /`\/ledger:task <what the task is>`/);
  assert.doesNotMatch(rule, /"go <slug>"/);
});

test('rule 40 keeps the rows of deployed agents whose lines HEAD did not gate on a model', (t) => {
  const features = [...ALL_AGENTS, 'opus-5.5', 'gpt-6.2-sol', 'haiku-5.5', 'codex', 'argent', 'gh-stack'];
  const routing = render(t, features).get('40-model-routing.md') ?? '';
  for (const agent of ['researcher', 'runner', 'ui-runner', 'opus-implementer', 'sol-implementer', 'reviewer', 'codex-runner']) {
    assert.match(routing, new RegExp(`^\\| ${agent} `, 'm'), `no ${agent} row`);
  }
  for (const agent of ['fable-implementer', 'astra-implementer', 'astra-reviewer']) {
    assert.doesNotMatch(routing, new RegExp(`^\\| ${agent} `, 'm'), `${agent} row without its model`);
  }
});

/** Every rule file rendered for `features`, by file name. */
function renderAll(t: TestContext, features: string[]): Map<string, string> {
  const out = mkdtempSync(path.join(tmpdir(), 'ledger-rules-all-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  assert.equal(buildRules({ src: RULES, out, features: features.join(',') }), 0);
  return new Map(readdirSync(out).map((name) => [name, readFileSync(path.join(out, name), 'utf8')]));
}

for (const models of [['opus-5.5', 'sonnet-5.5'], ['opus-5.5', 'gpt-6.2-sol', 'haiku-5.5']]) {
  test(`with all agents and models ${models.join(',')}, no rule names an agent that rule 40 has no row for`, (t) => {
    const rules = renderAll(t, [...ALL_AGENTS, ...models, 'codex', 'argent', 'gh-stack']);
    const routing = rules.get('40-model-routing.md') ?? '';
    const rowless = ALL_AGENTS.filter((agent) => !new RegExp(`^\\| ${agent} `, 'm').test(routing));
    assert.ok(rowless.includes('astra-reviewer'));
    for (const [name, text] of rules) {
      assert.deepEqual(namedAgents(text).filter((agent) => rowless.includes(agent)), [], `rules/${name}`);
    }
  });
}

test('rule 10 sends reviews to reviewer, and astra-reviewer after it, only where both are deployed', (t) => {
  const reviews = 'Reviews go to `reviewer`.';
  const astraAfter = '`astra-reviewer` reviews after `reviewer` on critical work.';
  const full = render(t, deployFeatures({})).get('10-operating-model.md') ?? '';
  assert.ok(full.includes(reviews));
  assert.ok(full.includes(astraAfter));
  const astraOnly = render(t, deployFeatures({ agents: ['astra-reviewer'] })).get('10-operating-model.md') ?? '';
  assert.ok(!astraOnly.includes(reviews) && !astraOnly.includes(astraAfter));
});

test('rule 30 points to ledger tree --help for making a parent task', () => {
  const stacks = ruleSource('30-stacked-prs.md');
  assert.doesNotMatch(stacks, /Checkpoint gate says how/);
  assert.match(stacks, /`ledger tree --help`/);
});

test('the ui-runner row of rule 40 needs argent', (t) => {
  const withArgent = render(t, deployFeatures({})).get('40-model-routing.md') ?? '';
  const withoutArgent = render(t, deployFeatures({}).filter((feature) => feature !== 'argent')).get('40-model-routing.md') ?? '';
  assert.match(withArgent, /^\| ui-runner /m);
  assert.doesNotMatch(withoutArgent, /^\| ui-runner /m);
});

test('rule 10 says what a pipeline boundary is where it asks for a ledger update', () => {
  assert.match(flatRule10(), /Update the ledger with `\/ledger:update` at every pipeline boundary\. The boundaries are after plan approval, after red tests, after each implementer report and after each review verdict\./);
});

test('rule 10 keeps durable facts out of the ledger', () => {
  assert.match(flatRule10(), /A fact still true next week goes in a rule file or auto memory, not the ledger\./);
});

test('rule 10 sends one subagent per child task in another repo', () => {
  const rule = flatRule10();
  assert.match(rule, /Send a child task in another repo to its own subagent, with that worktree's absolute path\./);
  assert.match(rule, /`EnterWorktree` cannot enter another repo\./);
});

test('rule 10 says retire updates the parent ledger, so the child report is written first', () => {
  assert.match(flatRule10(), /Retiring a child updates the parent ledger\. Write its `## Report` first\./);
});

test('no rule names the retired ledger scripts or the dashboard', () => {
  for (const [name, text] of ruleSources()) {
    const hits = text.split('\n').filter((line) => /\b(cc-task-new|cc-worktree-retire|cc-ledger-parent|cc-ledgers|cc-ledger-dashboard)\b|bin\/lib\b|dashboard/i.test(line));
    assert.deepEqual(hits, [], `rules/${name}`);
  }
});

test('no rule maps a gate to its agent with "That context is"', () => {
  for (const [name, text] of ruleSources()) assert.doesNotMatch(text, /That context is/, `rules/${name}`);
});

const PIPELINE = 'Pipeline: investigate → resolve ambiguity → plan → ledger → red tests → implement (effort stated) → verify (runner) → review (reviewer) → clear point if more remains → you accept.';

test('the rules hold exactly one pipeline line, in rule 40, with its stages and agents in order', () => {
  const pipelines = [...ruleSources()].flatMap(([name, text]) => text.split('\n').filter((line) => line.startsWith('Pipeline:')).map((line) => `${name}: ${line}`));
  assert.equal(pipelines.length, 1, pipelines.join('\n'));
  const lines = ruleSource('40-model-routing.md').split('\n');
  const start = lines.findIndex((line) => line.startsWith('Pipeline:'));
  const end = lines.findIndex((line, index) => index > start && (!line.trim() || line.startsWith('<!--')));
  assert.equal(lines.slice(start, end).join(' ').replace(/\s+/g, ' '), PIPELINE);
});

test('the full rule 40 render holds every agent row of the former fleet reference rule', (t) => {
  assert.equal(existsSync(path.join(RULES, '50-fleet-reference.md')), false);
  assert.ok(!GATED_RULES.includes('50-fleet-reference.md'));
  const routing = render(t, deployFeatures({})).get('40-model-routing.md') ?? '';
  const rows = readFileSync(path.join(REPO, 'tests/fixtures/fleet-reference-rows.md'), 'utf8').trim().split('\n');
  assert.equal(rows.length, ALL_AGENTS.length);
  for (const row of rows) assert.ok(routing.split('\n').includes(row), `rule 40 lacks the row: ${row}`);
});

test('the Fable bullet of rule 40 forbids untrusted input and security- or biology-adjacent work', () => {
  const lines = ruleSource('40-model-routing.md').split('\n');
  const arrow = lines.findIndex((line) => line.includes('→ `fable-implementer`'));
  assert.notEqual(arrow, -1, 'no Fable bullet');
  let start = arrow;
  while (start > 0 && !lines[start].startsWith('  - ')) start--;
  const end = lines.findIndex((line, index) => index > start && (line.startsWith('  - ') || line.startsWith('- ') || line.startsWith('<!--')));
  const bullet = lines.slice(start, end).join(' ').replace(/\s+/g, ' ');
  assert.ok(bullet.includes('Never untrusted input, never security- or biology-adjacent work.'), bullet);
});

/** The line after the Codex wrapper rule when it continues the rule, or why the rule is missing. */
function wrapperRuleContinuation(text: string): string | undefined {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => WRAPPER_RULE.test(line));
  if (index === -1) return 'no Codex wrapper rule';
  const next = lines[index + 1] ?? '';
  return next.trim() === '' || /^<!--\s*\/needs\s*-->\s*$/.test(next) || next.startsWith('- ') ? undefined : next;
}

test('the wrapper-rule check rejects a rule that continues on an indented line', () => {
  const probe = '<!-- needs: codex -->\n- Every Codex run goes through a wrapper agent.\n  The orchestrator never runs it.\n<!-- /needs -->\n';
  assert.equal(wrapperRuleContinuation(probe), '  The orchestrator never runs it.');
  assert.equal(wrapperRuleContinuation(probe.replace('\n  The orchestrator never runs it.', '')), undefined);
});

test('the Codex wrapper rule in the rule 60 source is one line of short sentences', () => {
  const text = ruleSource('60-subagent-mechanics.md');
  assert.equal(wrapperRuleContinuation(text), undefined);
  const line = text.split('\n').find((candidate) => WRAPPER_RULE.test(candidate)) ?? '';
  for (const sentence of line.replace(/^- /, '').split(/(?<=\.)\s+/)) {
    assert.ok(sentence.split(/\s+/).length < 20, `sentence of 20 words or more: ${sentence}`);
  }
});

test('docs/fleet.md links to rules 10 and 40 instead of copying the agent table', () => {
  const fleet = readFileSync(path.join(REPO, 'docs/fleet.md'), 'utf8');
  assert.match(fleet, /\]\(\.\.\/rules\/40-model-routing\.md\)/);
  assert.match(fleet, /\]\(\.\.\/rules\/10-operating-model\.md\)/);
  assert.doesNotMatch(fleet, /every task passes/i);
  const agentHeader = ruleSource('40-model-routing.md').split('\n').find((line) => /^\|\s*agent\s*\|/i.test(line));
  assert.ok(agentHeader, 'rule 40 has no agent table');
  const fleetLines = fleet.split('\n');
  assert.ok(!fleetLines.includes(agentHeader), 'docs/fleet.md holds the agent-table header of rule 40');
  assert.ok(!fleetLines.filter((line) => line.startsWith('|')).map(tableHeaderCells).includes(tableHeaderCells(agentHeader)), 'docs/fleet.md copies the agent table of rule 40');
});

test('rule 10 ends a task with the question ledger task gate finalize prints, and repeats it up the tree', () => {
  const rule = flatRule10();
  assert.match(rule, /End of task\.[^]*ask the question `ledger task gate finalize` prints/);
  assert.match(rule, /`\/ledger:retire <slug> --dry-run` for each ticked retire/);
  assert.match(rule, /On "Finalize <parent>", ask `ledger task gate finalize <parent>`/);
  assert.match(rule, /At the top of the tree, say the tree is done\./);
  assert.doesNotMatch(rule, /one option per other finished task/);
});

test('rule 20 names every gate ledger task gate knows', () => {
  assert.match(ruleSource('20-writing.md').replace(/\s+/g, ' '), /\(`plan`, `pr`, `abandon` and `finalize` today\)/);
});

/** The Failure gate of rule 10 with each run of whitespace collapsed to one space. */
const failureGate = (): string => section(ruleSource('10-operating-model.md'), '### Failure gate').replace(/\s+/g, ' ');
const failureGateSentence = (pattern: RegExp): string | undefined => failureGate().split(/(?<=\.)\s+/).find((sentence) => pattern.test(sentence));

test('the Failure gate of rule 10 sends a rejected review back with ledger notes stage, which counts the rounds (D22)', () => {
  const sentence = failureGateSentence(/`ledger notes stage review fail --back build`/);
  assert.ok(sentence, 'no sentence names `ledger notes stage review fail --back build`');
  assert.match(sentence, /counts?\b[^]*\brounds?\b/i);
  assert.ok(sentence.includes('`--back investigate`'), sentence);
  assert.match(sentence, /investigation task/, sentence);
});

test('the Failure gate of rule 10 tells the operator what failed in a subagent and asks what to do in the widget, with no retry (D23)', () => {
  const sentence = failureGateSentence(/empty report/);
  assert.ok(sentence, 'no sentence names an empty report');
  for (const words of ['tell the operator what failed', 'ask what to do', 'question widget', 'do not retry']) assert.ok(sentence.includes(words), `"${sentence}" lacks "${words}"`);
});

test('the Failure gate of rule 10 sends a merge conflict back to build, then runs verify and review again (D24)', () => {
  const sentence = failureGateSentence(/merge conflict/i);
  assert.ok(sentence, 'no sentence names a merge conflict');
  assert.ok(sentence.includes('--back build'), sentence);
  assert.match(failureGate(), /merge conflict[^]*\bverify\b[^]*\breview\b/i);
});

test('the Failure gate of rule 10 names ledger task gate abandon, then ledger task abandon (D25)', () => {
  const gate = failureGate();
  const [question, abandon] = [gate.indexOf('`ledger task gate abandon'), gate.indexOf('`ledger task abandon')];
  assert.ok(question !== -1, gate);
  assert.ok(abandon !== -1, gate);
  assert.ok(question < abandon, `the gate's question must come before the abandon: ${gate}`);
});
