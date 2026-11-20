import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileStore } from '../tools/ledger/file-store.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { sqliteStore } from '../tools/ledger/sqlite-store.js';
import type { LedgerStore } from '../tools/ledger/store.js';
import { shellWord } from '../tools/ledger/write.js';
import { REPO } from './helpers.js';
import { cannotHideSqlite, home, LEDGER_BIN, ledger, ledgerIn, ledgerText, lineWith, noSqlite, noSqliteOn, ok, repoKeyOf, repository, storeFolder, withoutSqlite, worktreeTask, type Ran } from './ledger-core-fixtures.js';

type Storage = 'file' | 'sqlite';

const settingsFile = (h: string): string => path.join(h, '.claude/ledger-settings.json');
const writeSettings = (h: string, settings: object): void => writeFileSync(settingsFile(h), JSON.stringify(settings));

/**
 * A HOME with the ledger template and the repos ~/repos/app and ~/repos/lib, whose untracked .claude/ folders git
 * ignores. The file store runs with no settings file, as every HOME did before the setting existed.
 */
function setup(t: TestContext, storage: Storage) {
  const h = home(t);
  copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
  if (storage === 'sqlite') writeSettings(h, { storage: 'sqlite' });
  const [app, lib] = ['app', 'lib'].map((name) => {
    const main = repository(h, path.join(h, 'repos', name));
    writeFileSync(path.join(main, '.git/info/exclude'), '.claude/\n');
    return main;
  });
  return { h, app, lib, store: (): LedgerStore => (storage === 'sqlite' ? sqliteStore({ home: h }) : fileStore(ledgerPaths(h))) };
}

/** The store key of the repo ~/repos/<name>. */
const keyOf = (h: string, name: string): string => repoKeyOf(path.join(h, 'repos', name));

/** The SQLite store keeps everything in ~/.claude/ledgers.db; the file store never makes that file. */
function keptIn(h: string, storage: Storage): void {
  const claude = path.join(h, '.claude');
  if (storage === 'file') return assert.equal(existsSync(path.join(claude, 'ledgers.db')), false, 'the file store made ledgers.db');
  for (const name of ['ledger-backlog', 'ledger-archive', 'ledgers.json']) assert.equal(existsSync(path.join(claude, name)), false, `the SQLite store made ~/.claude/${name}`);
  assert.ok(existsSync(path.join(claude, 'ledgers.db')), 'the SQLite store made no ~/.claude/ledgers.db');
}

function today(): string {
  const date = new Date();
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(2, '0')).join('-');
}

/** Every byte value once, so no text decoding can pass the bytes through unchanged. */
const BYTES = Buffer.from(Array.from({ length: 256 }, (_, byte) => byte));

/** The repo name app on its own, not as part of a path such as ~/repos/app or a word such as apps. */
const REPO_APP = /(?<![\w/.-])app(?![\w/-]|\.\w)/;

/** `ledger` with bytes on stdout, for output that must match a file exactly. */
function ledgerBytes(h: string, cwd: string, ...args: string[]): { status: number | null; stdout: Buffer; stderr: string } {
  const result = spawnSync(LEDGER_BIN, args, { cwd, env: { ...process.env, HOME: h, NO_COLOR: '1', GIT_CONFIG_GLOBAL: path.join(h, '.gitconfig') } });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr.toString() };
}

function failed(ran: Ran): string {
  assert.equal(ran.status, 1, `exit 1 expected; stdout:\n${ran.stdout}\nstderr:\n${ran.stderr}`);
  return ran.stderr;
}

/** The task fix-login started with `go`, given evidence, and retired with `retire`: its archive copy and evidence. */
function retiredWithEvidence(t: TestContext, storage: Storage) {
  const world = setup(t, storage);
  const { h, app } = world;
  ok(ledger(h, app, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.'));
  ok(ledger(h, app, 'go', 'fix-login'));
  const worktree = path.join(app, '.claude/worktrees/fix-login');
  const evidence = path.join(worktree, '.claude/evidence');
  mkdirSync(path.join(evidence, 'logs'), { recursive: true });
  writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
  writeFileSync(path.join(evidence, 'logs/trace.bin'), BYTES);
  const text = readFileSync(path.join(worktree, '.claude/ledger.md'), 'utf8');
  const stdout = ok(ledger(h, app, 'task', 'retire', 'fix-login'));
  return { ...world, worktree, text, stdout, name: `${today()}-fix-login` };
}

for (const storage of ['file', 'sqlite'] as const) {
  const skip = storage === 'sqlite' && noSqlite;
  test(`${storage} store: ledger task writes the backlog ledger to the store`, { skip }, (t) => {
    const { h, app, store } = setup(t, storage);
    ok(ledger(h, app, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.'));
    keptIn(h, storage);
    assert.match(store().backlog.read(keyOf(h, 'app'), 'fix-login')?.text ?? '', /Users cannot log in\./);
  });

  test(`${storage} store: ledger go moves the backlog ledger out of the store into the worktree's .claude/ledger.md`, { skip }, (t) => {
    const { h, app, store } = setup(t, storage);
    ok(ledger(h, app, 'task', 'new', 'fix-login', '--goal', 'Users cannot log in.'));
    ok(ledger(h, app, 'go', 'fix-login'));
    keptIn(h, storage);
    assert.match(readFileSync(path.join(app, '.claude/worktrees/fix-login/.claude/ledger.md'), 'utf8'), /Users cannot log in\./);
    assert.equal(store().backlog.has(keyOf(h, 'app'), 'fix-login'), false);
  });

  test(`${storage} store: ledger retire archives the ledger and its evidence folder to the store, and both read back`, { skip }, (t) => {
    const { h, worktree, store, text, stdout, name } = retiredWithEvidence(t, storage);
    keptIn(h, storage);
    assert.equal(existsSync(worktree), false);
    const archive = store().archive;
    assert.equal(archive.read(keyOf(h, 'app'), name)?.text, text);
    assert.ok(stdout.includes(`archived ${archive.location(keyOf(h, 'app'), name)}`), stdout);
    assert.deepEqual(archive.evidenceFiles(keyOf(h, 'app'), name), ['logs/trace.bin', 'red.txt']);
    assert.deepEqual(archive.readEvidence(keyOf(h, 'app'), name, 'red.txt'), Buffer.from('failing\n'));
    assert.deepEqual(archive.readEvidence(keyOf(h, 'app'), name, 'logs/trace.bin'), BYTES);
  });

  test(`${storage} store: ledger archive lists the retired task from the store`, { skip }, (t) => {
    const { h, app, store, name } = retiredWithEvidence(t, storage);
    assert.match(ok(ledger(h, app, 'task', 'archive')), /fix-login/);
    const { ledgers } = JSON.parse(ok(ledger(h, app, 'task', 'archive', '--json'))) as { ledgers: { date: string; slug: string; path: string }[] };
    assert.deepEqual(ledgers, [{ ...ledgers[0], date: today(), slug: 'fix-login', path: store().archive.location(keyOf(h, 'app'), name) }]);
    keptIn(h, storage);
  });

  test(`${storage} store: ledger list shows backlog tasks from the store, and retired ones with --archived`, { skip }, (t) => {
    const { h, app, store } = retiredWithEvidence(t, storage);
    ok(ledger(h, app, 'task', 'new', 'idea', '--goal', 'An idea.'));
    type Listed = { slug: string; status: string; path: string };
    const listed = (...args: string[]): Listed[] => (JSON.parse(ok(ledger(h, app, 'list', '--json', ...args))) as { tasks: Listed[] }).tasks;
    assert.deepEqual(
      listed().map(({ slug, status, path: location }) => ({ slug, status, location })),
      [{ slug: 'idea', status: 'backlog', location: store().backlog.location(keyOf(h, 'app'), 'idea') }],
    );
    assert.deepEqual(listed('--archived').map(({ slug }) => slug).sort(), ['fix-login', 'idea']);
    assert.match(ok(ledger(h, app, 'list')), /idea/);
    keptIn(h, storage);
  });

  test(`${storage} store: the SessionStart hook names a backlog child and an archived child with the status the store gives them`, { skip }, (t) => {
    const { h, app, store } = setup(t, storage);
    const epic = path.dirname(path.dirname(worktreeTask(h, app, { slug: 'epic', main: app, children: ['- idea', '- old'] })));
    ok(ledger(h, app, 'task', 'new', 'idea', '--goal', 'An idea.'));
    store().archive.write(keyOf(h, 'app'), '2026-10-01-old', ledgerText({ slug: 'old', main: app, worktree: path.join(app, '.claude/worktrees/old'), parent: 'epic' }));
    const input = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: epic });
    const result = spawnSync(LEDGER_BIN, ['hook', 'session-start'], { cwd: h, env: { ...process.env, HOME: h, GIT_CONFIG_GLOBAL: path.join(h, '.gitconfig') }, input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const { additionalContext } = (JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput;
    assert.match(additionalContext, /^Child task: idea \(backlog\)\.$/m);
    assert.match(additionalContext, /^Child task: old \(retired 2026-10-01\)\.$/m);
    keptIn(h, storage);
  });

  /** Backlog parent epic with child part started in a worktree, whose ## Report holds `report`; then part is retired. */
  function retiredChildOfBacklogParent(t: TestContext, report: string[]) {
    const { h, app, store } = setup(t, storage);
    ok(ledger(h, app, 'task', 'new', 'epic', '--goal', 'Ship the epic.'));
    ok(ledger(h, app, 'task', 'new', 'part', '--goal', 'Ship a part.'));
    ok(ledger(h, app, 'tree', 'add', 'epic', 'part'));
    ok(ledger(h, app, 'go', 'part'));
    const file = path.join(app, '.claude/worktrees/part/.claude/ledger.md');
    const text = readFileSync(file, 'utf8');
    const placeholder = '<3–5 lines for the parent task: outcome, PR link, what the parent must know>';
    assert.ok(text.includes(placeholder), text);
    writeFileSync(file, text.replace(placeholder, report.join('\n')));
    const ran = ledger(h, app, 'task', 'retire', 'part');
    assert.equal(ran.status, 0, ran.stderr);
    keptIn(h, storage);
    return { app, ran, parent: store().backlog.read(keyOf(h, 'app'), 'epic')?.text ?? assert.fail('the backlog parent epic is gone') };
  }

  test(`${storage} store: ledger retire marks the child retired in a backlog parent and copies its report there`, { skip }, (t) => {
    const { app, ran, parent } = retiredChildOfBacklogParent(t, ['PR #12 merged.', 'The parent must know X.']);
    assert.equal(lineWith(parent, '- part @'), `- part @ ${app} (retired ${today()})`);
    assert.match(parent, /## Child reports\n\n### part\nPR #12 merged\.\nThe parent must know X\.\n/);
    assert.doesNotMatch(ran.stderr, /^warning: .*(epic|parent|## Children|report)/im);
  });

  test(`${storage} store: ledger retire marks the child retired in a backlog parent and warns that an empty report is not copied`, { skip }, (t) => {
    const { app, ran, parent } = retiredChildOfBacklogParent(t, []);
    assert.equal(lineWith(parent, '- part @'), `- part @ ${app} (retired ${today()})`);
    assert.doesNotMatch(parent, /### part/);
    assert.match(ran.stderr, /^warning: .*has no report under ## Report, so none is copied to epic\.$/m);
  });

  // ledger show

  test(`${storage} store: ledger show prints this repo's backlog ledger exactly, before any archive copy of the slug`, { skip }, (t) => {
    const { h, app, store } = setup(t, storage);
    ok(ledger(h, app, 'task', 'new', 'idea', '--goal', 'An idea.'));
    store().archive.write(keyOf(h, 'app'), '2026-10-01-idea', 'an older task with the same slug\n');
    const text = store().backlog.read(keyOf(h, 'app'), 'idea')?.text;
    assert.ok(text);
    assert.equal(ok(ledger(h, app, 'show', 'idea')), text);
    keptIn(h, storage);
  });

  test(`${storage} store: ledger show prints the newest archive copy named <date>-<slug>, and no copy of another slug`, { skip }, (t) => {
    const { h, app, store } = setup(t, storage);
    const archive = store().archive;
    archive.write(keyOf(h, 'app'), '2026-10-01-old', 'older copy\n');
    archive.write(keyOf(h, 'app'), '2026-11-01-old', 'newest copy\n');
    archive.write(keyOf(h, 'app'), '2026-12-01-older', 'another slug\n');
    archive.write(keyOf(h, 'lib'), '2026-12-01-old', 'another repo\n');
    assert.equal(ok(ledger(h, app, 'show', 'old')), 'newest copy\n');
  });

  test(`${storage} store: ledger show of a full archive name <date>-<slug>[-N] prints that copy, also where the slug alone would pick another`, { skip }, (t) => {
    const { h, app, store } = setup(t, storage);
    const archive = store().archive;
    archive.write(keyOf(h, 'app'), '2026-10-01-old', 'october\n');
    archive.write(keyOf(h, 'app'), '2026-11-01-old', 'november, first\n');
    archive.write(keyOf(h, 'app'), '2026-11-01-old-2', 'november, second\n');
    archive.write(keyOf(h, 'app'), '2026-12-01-old-2', 'the task old-2\n');
    assert.equal(ok(ledger(h, app, 'show', '2026-10-01-old')), 'october\n');
    assert.equal(ok(ledger(h, app, 'show', '2026-11-01-old-2')), 'november, second\n');
    assert.equal(ok(ledger(h, app, 'show', '2026-11-01-old')), 'november, first\n');
    const { name } = JSON.parse(ok(ledger(h, app, 'show', '2026-11-01-old-2', '--json'))) as { name: string };
    assert.equal(name, '2026-11-01-old-2');
  });

  test(`${storage} store: ledger show without --repo does not print the backlog ledger of another repo`, { skip }, (t) => {
    const { h, app, lib } = setup(t, storage);
    ok(ledger(h, lib, 'task', 'new', 'lib-idea', '--goal', 'An idea for lib.'));
    const ran = ledger(h, app, 'show', 'lib-idea');
    const stderr = failed(ran);
    assert.match(stderr, /\blib-idea\b/);
    assert.equal(ran.stdout, '');
  });

  test(`${storage} store: ledger show counts the -N copies retire makes of a taken name, newest by date and then by N as a number`, { skip }, (t) => {
    const { h, app, store } = setup(t, storage);
    const archive = store().archive;
    archive.write(keyOf(h, 'app'), '2026-10-01-old-3', 'october, third\n');
    archive.write(keyOf(h, 'app'), '2026-11-01-old', 'november, first\n');
    archive.write(keyOf(h, 'app'), '2026-11-01-old-2', 'november, second\n');
    archive.write(keyOf(h, 'app'), '2026-11-01-old-10', 'november, tenth\n');
    archive.write(keyOf(h, 'app'), '2026-12-01-older', 'another slug\n');
    assert.equal(ok(ledger(h, app, 'show', 'old')), 'november, tenth\n');
    archive.write(keyOf(h, 'app'), '2026-12-01-old', 'december, first\n');
    assert.equal(ok(ledger(h, app, 'show', 'old')), 'december, first\n');
  });

  test(`${storage} store: ledger show --evidence of a slug only in the backlog exits 1 and says it has no archived copy`, { skip }, (t) => {
    const { h, app } = setup(t, storage);
    ok(ledger(h, app, 'task', 'new', 'idea', '--goal', 'An idea.'));
    const ran = ledger(h, app, 'show', 'idea', '--evidence');
    const stderr = failed(ran);
    assert.match(stderr, /\bidea\b/);
    assert.match(stderr, /no archived copy/i);
    assert.equal(ran.stdout, '');
  });

  test(`${storage} store: ledger show --evidence of an archive copy without evidence prints nothing and exits 0`, { skip }, (t) => {
    const { h, app, store } = setup(t, storage);
    store().archive.write(keyOf(h, 'app'), '2026-11-01-old', 'archived\n');
    assert.equal(ok(ledger(h, app, 'show', 'old', '--evidence')), '');
  });

  test(`${storage} store: ledger show --evidence <file> of a file that is not in the evidence exits 1, names the file and the slug, and prints nothing on stdout`, { skip }, (t) => {
    const { h, app, store } = setup(t, storage);
    const evidence = path.join(h, 'evidence');
    mkdirSync(evidence);
    writeFileSync(path.join(evidence, 'red.txt'), 'failing\n');
    store().archive.write(keyOf(h, 'app'), '2026-11-01-old', 'archived\n', evidence);
    const ran = ledger(h, app, 'show', 'old', '--evidence', 'green.txt');
    const stderr = failed(ran);
    assert.match(stderr, /green\.txt/);
    assert.match(stderr, /\bold\b/);
    assert.equal(ran.stdout, '');
  });

  test(`${storage} store: ledger show outside a repo without --repo exits 1 and says to pass --repo`, { skip }, (t) => {
    const { h, store } = setup(t, storage);
    store().archive.write(keyOf(h, 'app'), '2026-11-01-old', 'archived\n');
    const ran = ledger(h, h, 'show', 'old');
    assert.match(failed(ran), /--repo/);
    assert.equal(ran.stdout, '');
  });

  test(`${storage} store: ledger show --json of a slug that is not found exits 1 with the plain not-found message on stderr and nothing on stdout`, { skip }, (t) => {
    const { h, app } = setup(t, storage);
    const ran = ledger(h, app, 'show', 'ghost', '--json');
    const stderr = failed(ran);
    assert.match(stderr, /\bghost\b/);
    assert.match(stderr, REPO_APP);
    assert.doesNotMatch(stderr, /^\s*\{/);
    assert.equal(ran.stdout, '');
  });

  test(`${storage} store: ledger show --repo reads another repo folder, from any folder`, { skip }, (t) => {
    const { h, app, store } = setup(t, storage);
    store().archive.write(keyOf(h, 'lib'), '2026-11-01-lib-old', 'from lib\n');
    assert.equal(ok(ledger(h, app, 'show', 'lib-old', '--repo', 'lib')), 'from lib\n');
    assert.equal(ok(ledger(h, h, 'show', 'lib-old', '--repo', 'lib')), 'from lib\n');
  });

  test(`${storage} store: ledger show --evidence lists the archive copy's evidence files, one relative path per line`, { skip }, (t) => {
    const { h, app } = retiredWithEvidence(t, storage);
    assert.equal(ok(ledger(h, app, 'show', 'fix-login', '--evidence')), 'logs/trace.bin\nred.txt\n');
  });

  test(`${storage} store: ledger show --evidence <file> prints that file's bytes exactly`, { skip }, (t) => {
    const { h, app } = retiredWithEvidence(t, storage);
    for (const [file, bytes] of [['logs/trace.bin', BYTES], ['red.txt', Buffer.from('failing\n')]] as const) {
      const ran = ledgerBytes(h, app, 'show', 'fix-login', '--evidence', file);
      assert.equal(ran.status, 0, ran.stderr);
      assert.deepEqual(ran.stdout, bytes, file);
    }
  });

  test(`${storage} store: ledger show --json prints the repo, name, location and text`, { skip }, (t) => {
    const { h, app, store } = setup(t, storage);
    ok(ledger(h, app, 'task', 'new', 'idea', '--goal', 'An idea.'));
    store().archive.write(keyOf(h, 'app'), '2026-11-01-old', 'archived\n');
    type Shown = { repo: string; name: string; location: string; text: string };
    const shown = (slug: string): Shown => {
      const { repo, name, location, text } = JSON.parse(ok(ledger(h, app, 'show', slug, '--json'))) as Shown;
      return { repo, name, location, text };
    };
    const backlog = store().backlog;
    assert.deepEqual(shown('idea'), { repo: keyOf(h, 'app'), name: 'idea', location: backlog.location(keyOf(h, 'app'), 'idea'), text: backlog.read(keyOf(h, 'app'), 'idea')?.text });
    assert.deepEqual(shown('old'), { repo: keyOf(h, 'app'), name: '2026-11-01-old', location: store().archive.location(keyOf(h, 'app'), '2026-11-01-old'), text: 'archived\n' });
  });

  test(`${storage} store: ledger show refuses a slug or --repo that is empty or holds .., / or \\, exits 1 and names the value`, { skip }, (t) => {
    const { h, app, lib } = setup(t, storage);
    ok(ledger(h, lib, 'task', 'new', 'lib-idea', '--goal', 'An idea for lib.'));
    for (const args of [[''], ['..'], ['../lib/lib-idea'], ['lib\\lib-idea'], ['lib-idea', '--repo', ''], ['lib-idea', '--repo', '../lib'], ['lib-idea', '--repo', 'x/../lib'], ['lib-idea', '--repo', 'a\\b']]) {
      const bad = args.length === 1 ? args[0] : args[2];
      const ran = ledger(h, app, 'show', ...args);
      assert.ok(failed(ran).includes(`"${bad}"`), `${JSON.stringify(args)}: ${ran.stderr}`);
      assert.equal(ran.stdout, '');
    }
  });

  test(`${storage} store: ledger show of a full archive name prints that archive copy, even where a backlog task has that name as its slug`, { skip }, (t) => {
    const { h, app, store } = setup(t, storage);
    store().backlog.write(keyOf(h, 'app'), '2026-11-01-fix', 'the backlog task 2026-11-01-fix\n');
    store().archive.write(keyOf(h, 'app'), '2026-11-01-fix', 'archived fix\n');
    store().archive.write(keyOf(h, 'app'), '2026-11-01-fix-2', 'archived fix, second\n');
    assert.equal(ok(ledger(h, app, 'show', '2026-11-01-fix')), 'archived fix\n');
    assert.equal(ok(ledger(h, app, 'show', '2026-11-01-fix-2')), 'archived fix, second\n');
  });

  test(`${storage} store: ledger task --design-refs writes the numbers on the design refs line of the backlog ledger`, { skip }, (t) => {
    const { h, app, lib, store } = setup(t, storage);
    mkdirSync(path.join(app, 'llp'));
    ok(ledger(h, app, 'task', 'new', 'fix-login', '--design-refs', '3,12'));
    ok(ledger(h, app, 'task', 'new', 'no-refs'));
    ok(ledger(h, lib, 'task', 'new', 'lib-refs', '--design-refs', '7'));
    assert.match(store().backlog.read(keyOf(h, 'app'), 'fix-login')?.text ?? '', /^- design refs: 3,12$/m);
    assert.match(store().backlog.read(keyOf(h, 'app'), 'no-refs')?.text ?? '', /^- design refs: none$/m);
    assert.match(store().backlog.read(keyOf(h, 'lib'), 'lib-refs')?.text ?? '', /^- design refs: 7$/m);
  });

  test(`${storage} store: ledger task --design-refs adds the design refs line as the last item of ## Location when the template has none`, { skip }, (t) => {
    const { h, app, store } = setup(t, storage);
    const template = path.join(h, '.claude/ledger.template.md');
    writeFileSync(template, readFileSync(template, 'utf8').replace(/^- design refs:.*\n/m, ''));
    ok(ledger(h, app, 'task', 'new', 'fix-login', '--design-refs', '3,12'));
    const [, location] = /^## Location\n((?:- .*\n)+)/m.exec(store().backlog.read(keyOf(h, 'app'), 'fix-login')?.text ?? '') ?? [];
    assert.equal(location?.trimEnd().split('\n').at(-1), '- design refs: 3,12');
  });

  test(`${storage} store: ledger task --design-refs with a template that has no ## Location exits 1, names the template file, and writes no ledger`, { skip }, (t) => {
    const { h, app, store } = setup(t, storage);
    const template = path.join(h, '.claude/ledger.template.md');
    writeFileSync(template, readFileSync(template, 'utf8').replace(/^## Location\n(?:- .*\n)*\n/m, ''));
    assert.match(failed(ledger(h, app, 'task', 'new', 'fix-login', '--design-refs', '3,12')), /~\/\.claude\/ledger\.template\.md/);
    assert.equal(store().backlog.has(keyOf(h, 'app'), 'fix-login'), false);
  });

  test(`${storage} store: ledger task --design-refs refuses a value that is not comma-separated numbers, and writes no ledger`, { skip }, (t) => {
    const { h, app, store } = setup(t, storage);
    for (const refs of ['', 'none', '3;12', '3,', 'LLP-3']) {
      assert.ok(failed(ledger(h, app, 'task', 'new', 'fix-login', '--design-refs', refs)).includes(`"${refs}"`), refs);
      assert.equal(store().backlog.has(keyOf(h, 'app'), 'fix-login'), false);
    }
  });

  test(`${storage} store: ledger show of a slug in neither the backlog nor the archive exits 1, names the slug and repo, and prints nothing on stdout`, { skip }, (t) => {
    const { h, app, store } = setup(t, storage);
    store().archive.write(keyOf(h, 'lib'), '2026-11-01-ghost', 'in lib only\n');
    const ran = ledger(h, app, 'show', 'ghost');
    const stderr = failed(ran);
    assert.match(stderr, /\bghost\b/);
    assert.match(stderr, REPO_APP);
    assert.equal(ran.stdout, '');
  });
}

// The storage setting

test('with no ~/.claude/ledger-settings.json the ledgers stay in files, as before', (t) => {
  const { h, app } = setup(t, 'file');
  ok(ledger(h, app, 'task', 'new', 'fix-login'));
  assert.ok(existsSync(path.join(storeFolder(h, 'ledger-backlog', app), 'fix-login.md')));
  assert.equal(existsSync(path.join(h, '.claude/ledgers.db')), false);
});

for (const [what, settings] of [
  ['storage file', { storage: 'file' }],
  ['no storage key', { other: true }],
] as const) {
  test(`a settings file with ${what} keeps the ledgers in files`, (t) => {
    const { h, app } = setup(t, 'file');
    writeSettings(h, settings);
    ok(ledger(h, app, 'task', 'new', 'fix-login'));
    assert.ok(existsSync(path.join(storeFolder(h, 'ledger-backlog', app), 'fix-login.md')));
    assert.equal(existsSync(path.join(h, '.claude/ledgers.db')), false);
  });
}

test('an unknown storage value exits 1 and names the value and both allowed values, file and sqlite', (t) => {
  const { h, app } = setup(t, 'file');
  writeSettings(h, { storage: 'postgres' });
  const stderr = failed(ledger(h, app, 'list'));
  assert.match(stderr, /postgres/);
  // As one list, so the word file in "settings file" cannot stand in for the value.
  assert.match(stderr, /\bfile["'`]?,? (?:or |and )?["'`]?sqlite\b/);
});

test('a settings file that is not valid JSON exits 1 and names the settings file', (t) => {
  const { h, app } = setup(t, 'file');
  writeFileSync(settingsFile(h), '{"storage": sqlite');
  const stderr = failed(ledger(h, app, 'list'));
  assert.match(stderr, new RegExp(`(?:~|${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})/\\.claude/ledger-settings\\.json`));
});

test('a settings file that is not valid JSON names both allowed values, file and sqlite', (t) => {
  const { h, app } = setup(t, 'file');
  writeFileSync(settingsFile(h), '{"storage": sqlite');
  assert.match(failed(ledger(h, app, 'list')), /\bfile["'`]?,? (?:or |and )?["'`]?sqlite\b/);
});

test('the node:sqlite probe of the test fixtures ignores NODE_OPTIONS, so a flag meant for the tests does not skip them', { skip: noSqlite }, (t) => {
  const before = process.env.NODE_OPTIONS;
  t.after(() => {
    if (before === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = before;
  });
  process.env.NODE_OPTIONS = '--no-experimental-sqlite';
  assert.equal(noSqliteOn(process.execPath), false);
});

test('the node:sqlite probe of the test fixtures throws when its child cannot start, rather than skip the SQLite tests', () => {
  assert.throws(() => noSqliteOn(path.join(REPO, 'no-such-node')), { code: 'ENOENT' });
});

test('the node:sqlite probe of the test fixtures names the version of the Node it probed, not of the Node it runs on, from a folder with a $ in its path', (t) => {
  const h = path.join(home(t), 'a$b');
  mkdirSync(h);
  const preload = path.join(h, 'node-21.cjs');
  writeFileSync(
    preload,
    [
      "Object.defineProperty(process.versions, 'node', { value: '21.7.3' });",
      "const Module = require('node:module');",
      'const load = Module._load;',
      'Module._load = function (request, ...rest) {',
      "  if (request === 'node:sqlite') throw new Error('No such built-in module: node:sqlite');",
      '  return Reflect.apply(load, this, [request, ...rest]);',
      '};',
      '',
    ].join('\n'),
  );
  const node21 = path.join(h, 'node');
  writeFileSync(node21, `#!/bin/sh\nexec ${shellWord(process.execPath)} --require ${shellWord(preload)} "$@"\n`);
  chmodSync(node21, 0o755);
  assert.match(String(noSqliteOn(node21)), /this is Node 21\.7\.3$/);
});

test('with storage sqlite and no node:sqlite, ledger exits 1 and says SQLite storage needs Node 22.13, or 23.4 on Node 23, and names the settings file', { skip: cannotHideSqlite }, (t) => {
  const { h, app } = setup(t, 'sqlite');
  const stderr = failed(ledgerIn(withoutSqlite(h), app, 'list'));
  assert.match(stderr, /SQLite storage needs Node 22\.13 or later, and 23\.4 or later on Node 23\./);
  assert.doesNotMatch(stderr, /experimental-sqlite/);
  assert.match(stderr, /ledger-settings\.json/);
});

test('without node:sqlite the file store still works, so node:sqlite loads only for storage sqlite', { skip: cannotHideSqlite }, (t) => {
  const { h, app } = setup(t, 'file');
  ok(ledgerIn(withoutSqlite(h), app, 'list'));
});

/**
 * node:sqlite emits `warnings`, each a message and a type, when it loads, as Node 22.13 to 23 does. A --require preload
 * wraps Module._load, which the store's require goes through on every Node it runs on; module.registerHooks needs 22.15.
 */
function withSqliteWarnings(h: string, warnings: [message: string, type?: string][]): NodeJS.ProcessEnv {
  const preload = path.join(h, 'sqlite-warnings.cjs');
  writeFileSync(
    preload,
    [
      "const Module = require('node:module');",
      'const load = Module._load;',
      'Module._load = function (request, ...rest) {',
      `  if (request === 'node:sqlite') for (const [message, type] of ${JSON.stringify(warnings)}) process.emitWarning(message, type);`,
      '  return Reflect.apply(load, this, [request, ...rest]);',
      '};',
      '',
    ].join('\n'),
  );
  return { ...process.env, HOME: h, NO_COLOR: '1', GIT_CONFIG_GLOBAL: path.join(h, '.gitconfig'), NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}`.trim() };
}

test("with storage sqlite, node:sqlite's experimental warning stays off stderr, and other warnings still print", { skip: noSqlite }, (t) => {
  const { h, app } = setup(t, 'sqlite');
  const env = withSqliteWarnings(h, [
    ['SQLite is an experimental feature and might change at any time', 'ExperimentalWarning'],
    ['Other is an experimental feature and might change at any time', 'ExperimentalWarning'],
  ]);
  const ran = ledgerIn(env, app, 'list');
  assert.equal(ran.status, 0, ran.stderr);
  assert.doesNotMatch(ran.stderr, /SQLite is an experimental feature/);
  assert.match(ran.stderr, /Other is an experimental feature/);
});

test('with storage sqlite, a warning with the SQLite text but not of type ExperimentalWarning still prints', { skip: noSqlite }, (t) => {
  const { h, app } = setup(t, 'sqlite');
  const ran = ledgerIn(withSqliteWarnings(h, [['SQLite is an experimental feature and might change at any time', 'Warning']]), app, 'list');
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stderr, /^\(node:\d+\) Warning: SQLite is an experimental feature and might change at any time$/m);
});

test('with storage sqlite, an ExperimentalWarning that starts with the SQLite text but says more still prints', { skip: noSqlite }, (t) => {
  const { h, app } = setup(t, 'sqlite');
  const env = withSqliteWarnings(h, [['SQLite is an experimental feature and might change at any time, and so might this', 'ExperimentalWarning']]);
  const ran = ledgerIn(env, app, 'list');
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stderr, /ExperimentalWarning: SQLite is an experimental feature and might change at any time, and so might this/);
});
