import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runLedger } from '../tools/ledger/cli.js';
import { fileStore } from '../tools/ledger/file-store.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { parseRecord, readRecordJson, recordJson, renderRecord } from '../tools/ledger/record.js';
import { repoKey } from '../tools/ledger/repo-key.js';
import { hostLabel } from '../tools/ledger/settings.js';
import { freshHome, REPO } from './helpers.js';

export const LEDGER_BIN = path.join(REPO, 'bin/ledger');

/** The host label every active record a command of these tests starts names, as no fixture sets "host". */
export const THIS_HOST = hostLabel(os.hostname());

/**
 * Why the SQLite store cannot run on the Node at `node`, or false where it can: the skip reason of its tests. A child
 * process loads node:sqlite through require, as the store does, so this process neither loads it nor prints its warning.
 */
export function noSqliteOn(node: string): string | false {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const probe = spawnSync(node, ['-e', "process.stdout.write(process.versions.node); require('node:sqlite')"], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (probe.error) throw probe.error;
  return probe.status !== 0 && `node:sqlite loads without a flag only from Node 22.13, and from 23.4 on Node 23; this is Node ${probe.stdout}`;
}

export const noSqlite = noSqliteOn(process.execPath);

export type Ran = { status: number | null; stdout: string; stderr: string };

export type Fields = {
  slug: string;
  goal?: string;
  worktree?: string;
  branch?: string;
  base?: string;
  main?: string;
  parent?: string;
  children?: string[];
  next?: string;
  report?: string[];
};

/** A ledger in the shape of ledger.template.md, filled in the way a real task fills it. */
export function ledgerText(fields: Fields): string {
  const location = [
    ...(fields.main === undefined ? [] : [`- main: ${fields.main}`]),
    `- worktree: ${fields.worktree ?? '<path>'}`,
    `- branch: ${fields.branch ?? '<name>'}`,
    `- base: ${fields.base ?? '<branch/commit>'}`,
    '- design refs: none',
    ...(fields.parent === undefined ? [] : [`- parent: ${fields.parent}`]),
  ];
  const children = fields.children === undefined ? [] : ['## Children', ...fields.children, ''];
  return [
    `# Task ledger — ${fields.slug}`,
    '',
    'Read this first in every fresh session. Update it at every pipeline boundary.',
    'Facts, not narrative. Keep under ~4k tokens.',
    '',
    '## Goal',
    fields.goal ?? `Goal of ${fields.slug}.`,
    '',
    '## Location',
    ...location,
    '',
    '## Plan (approved 2026-11-01)',
    '| # | step | status | owner | note |',
    '|---|------|--------|-------|------|',
    '| 1 | write the tests | done | opus-implementer | seen failing |',
    '| 2 | implement | todo | opus-implementer | |',
    '',
    '## Decisions',
    '- Keep the old format — because real ledgers use it [observed]',
    '',
    '## Constraints discovered',
    '- <constraint> — found in <file/report> [observed]',
    '',
    '## Subagent reports',
    '<paste the structured report for each step; replace with one line once the step is reviewed>',
    '',
    '## Open questions',
    '- <question> — blocks step <#>?',
    '',
    ...children,
    '## Report',
    ...(fields.report ?? ['<3–5 lines for the parent task: outcome, PR link, what the parent must know>']),
    '',
    '## Next step',
    fields.next ?? `Next step of ${fields.slug}.`,
    '',
  ].join('\n');
}

/** The environment of a command run against the fake HOME `home`, in no session: `ledger go` claims for a known one. */
export function commandEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    NO_COLOR: '1',
    PATH: `${path.join(home, 'stub-bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
  };
  delete env.CLAUDE_CODE_SESSION_ID;
  return env;
}

/** Runs git and gh in this process as the CLI runs them under the HOME `h`, with its stub gh first on PATH. */
export function asCli(t: TestContext, h: string): void {
  const saved = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  process.env.PATH = `${path.join(h, 'stub-bin')}${path.delimiter}${saved.PATH ?? ''}`;
  process.env.GIT_CONFIG_GLOBAL = path.join(h, '.gitconfig');
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

export function spawn(home: string, cwd: string, command: string, args: string[]): Ran {
  const result = spawnSync(command, args, {
    cwd,
    env: commandEnv(home),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function ledger(home: string, cwd: string, ...args: string[]): Ran {
  return spawn(home, cwd, LEDGER_BIN, args);
}

/** Runs the ledger command line as `ledger` does, but inside this process, without the cost of starting one. */
export async function runInProcess(home: string, cwd: string, ...args: string[]): Promise<Ran> {
  const { code, stdout, stderr } = await runLedger(args, { home, cwd, env: commandEnv(home) });
  return { status: code, stdout, stderr };
}

export function ok(ran: Ran): string {
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout;
}

export function git(home: string, cwd: string, ...args: string[]): string {
  const ran = spawn(home, cwd, 'git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout.trim();
}

/** A temporary HOME, as a real path because git reports /var as /private/var, with a `gh` that always fails. */
export function home(t: TestContext): string {
  const folder = realpathSync(freshHome(t));
  const stubs = path.join(folder, 'stub-bin');
  mkdirSync(stubs);
  writeFileSync(path.join(stubs, 'gh'), '#!/bin/sh\necho "gh: not logged in" >&2\nexit 4\n');
  chmodSync(path.join(stubs, 'gh'), 0o755);
  return folder;
}

/** A main checkout with one commit, pushed to a bare origin whose HEAD is main. */
export function repository(h: string, main: string): string {
  const origin = path.join(h, 'remotes', `${path.basename(main)}.git`);
  mkdirSync(origin, { recursive: true });
  git(h, origin, 'init', '--quiet', '--bare', '-b', 'main');
  mkdirSync(main, { recursive: true });
  git(h, main, 'init', '--quiet', '-b', 'main');
  git(h, main, 'commit', '--quiet', '--allow-empty', '-m', 'first');
  git(h, main, 'remote', 'add', 'origin', origin);
  git(h, main, 'push', '--quiet', '-u', 'origin', 'main');
  git(h, main, 'remote', 'set-head', 'origin', 'main');
  return main;
}

/** A linked worktree at <main>/.claude/worktrees/<slug> on branch me/<slug>, with a .claude folder and its active record in the file store; gives the record's file. */
export function worktreeTask(h: string, main: string, fields: Omit<Fields, 'worktree' | 'branch' | 'base'>): string {
  const worktree = worktreeOf(main, fields.slug);
  git(h, main, 'worktree', 'add', '--quiet', '-b', `me/${fields.slug}`, worktree, 'main');
  const short = git(h, main, 'rev-parse', '--short', 'main');
  mkdirSync(path.join(worktree, '.claude'));
  return putActive(h, main, fields.slug, ledgerText({ ...fields, worktree, branch: `me/${fields.slug}`, base: `origin/main @ ${short}` }));
}

/** Writes `markdown` as the new active record `slug` of the repo at `main`, or of the repo key `repo`, in the file store; gives its file. A slug that is taken fails, as in the store. */
export function putActive(h: string, main: string, slug: string, markdown: string, repo = repoKey(main)): string {
  const { active } = fileStore(ledgerPaths(h));
  assert.ok(active.create(repo, slug, markdown), `the active ledger ${slug} of ${repo} is taken`);
  return active.location(repo, slug);
}

/** The file of the active record `slug` of the repo at `main` in the file store. */
export const activeFile = (h: string, main: string, slug: string): string => fileStore(ledgerPaths(h)).active.location(repoKey(main), slug);

export const worktreeOf = (main: string, slug: string): string => path.join(main, '.claude/worktrees', slug);

/**
 * The store key of the repo at `main`: the address of its origin, which every fixture repo has as a local bare repo,
 * so that path without .git; the main path for a repo without origin or a folder that is gone.
 */
export function repoKeyOf(main: string): string {
  const origin = spawnSync('git', ['-C', main, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const url = origin.status === 0 ? origin.stdout.trim() : undefined;
  if (url === undefined) return main;
  assert.ok(path.isAbsolute(url), `the fixture knows only local origins, not ${url}`);
  return url.replace(/\.git$/, '');
}

/** The file store's folder of the repo at `main` in `place`. */
export const storeFolder = (h: string, place: 'ledger-backlog' | 'ledger-archive', main: string): string =>
  path.join(h, '.claude', place, encodeURIComponent(repoKeyOf(main)));

export function backlogTask(h: string, main: string, fields: Omit<Fields, 'main'>): string {
  const file = path.join(storeFolder(h, 'ledger-backlog', main), `${fields.slug}.md`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, ledgerText({ ...fields, main, branch: fields.branch ?? fields.slug }));
  return file;
}

/** An archive copy named <date>-<name>.md; `name` defaults to the slug. Its worktree is gone. */
export function archivedTask(h: string, main: string, date: string, fields: Fields, name = fields.slug): string {
  const file = path.join(storeFolder(h, 'ledger-archive', main), `${date}-${name}.md`);
  mkdirSync(path.dirname(file), { recursive: true });
  const worktree = path.join(main, '.claude/worktrees', name);
  writeFileSync(file, ledgerText({ worktree, branch: `me/${name}`, base: 'origin/main @ 1234567', ...fields }));
  const time = new Date(`${date}T12:00:00Z`);
  utimesSync(file, time, time);
  return file;
}

/** <name>.json, where the file store kept <name>.md before task records. */
export const recordFile = (file: string): string => file.replace(/\.md$/, '.json');

/**
 * The text of a ledger file as a reader of the store sees it: a task record <name>.json rendered to Markdown, and a
 * <name>.md that a record replaced read as that record. Any other file as it is.
 */
export function readLedgerFile(file: string): string {
  const record = file.endsWith('.json') ? file : recordFile(file);
  return existsSync(record) && (record !== file || file.endsWith('.json')) ? renderRecord(readRecordJson(readFileSync(record, 'utf8'), record)) : readFileSync(file, 'utf8');
}

/** Writes `markdown` to a ledger file of the file store as the store keeps it: a task record for <name>.json, else as it is. */
export function writeLedgerFile(file: string, markdown: string): void {
  writeFileSync(file, file.endsWith('.json') ? recordJson(parseRecord(markdown)) : markdown);
}

/** Whether the store holds the ledger of `file`, as <name>.md from before task records or as its record <name>.json. */
export const hasLedgerFile = (file: string): boolean => existsSync(file) || existsSync(recordFile(file));

export function touch(file: string, iso: string): void {
  const time = new Date(iso);
  utimesSync(file, time, time);
}

export const lineWith = (output: string, text: string): string =>
  output.split('\n').find((line) => line.includes(text)) ?? assert.fail(`no line contains "${text}" in:\n${output}`);

/**
 * The seam: the SQLite store loads node:sqlite with import() or require, never process.getBuiltinModule, so a module
 * resolve hook preloaded with NODE_OPTIONS=--import can make it fail to load, as an older Node would. An older Node
 * itself needs no hook.
 */
export function withoutSqlite(h: string): NodeJS.ProcessEnv {
  if (noSqlite) return { ...process.env, HOME: h, NO_COLOR: '1', GIT_CONFIG_GLOBAL: path.join(h, '.gitconfig') };
  const hook = path.join(h, 'no-sqlite.mjs');
  writeFileSync(
    hook,
    [
      "import { registerHooks } from 'node:module';",
      'registerHooks({',
      '  resolve(specifier, context, nextResolve) {',
      "    if (specifier === 'node:sqlite') throw Object.assign(new Error(`No such built-in module: ${specifier}`), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });",
      '    return nextResolve(specifier, context);',
      '  },',
      '});',
      '',
    ].join('\n'),
  );
  const env = { ...process.env, HOME: h, NO_COLOR: '1', GIT_CONFIG_GLOBAL: path.join(h, '.gitconfig'), NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(hook).href}`.trim() };
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('node:sqlite')"], { env, encoding: 'utf8' });
  assert.notEqual(probe.status, 0, 'the resolve hook did not stop node:sqlite from loading');
  return env;
}

export const ledgerIn = (env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): Ran => {
  const result = spawnSync(process.execPath, [LEDGER_BIN, ...args], { cwd, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const noRegisterHooks = typeof module.registerHooks !== 'function' && 'module.registerHooks, which the fixture needs, came in Node 22.15 and 23.5';
export const cannotHideSqlite = !noSqlite && noRegisterHooks;

