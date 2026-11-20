import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Failure } from '../tools/ledger/failure.js';
import { fileStore } from '../tools/ledger/file-store.js';
import { ledgerPaths } from '../tools/ledger/paths.js';
import { loadTasks, type RegistryEntry } from '../tools/ledger/registry.js';
import { sqliteStore } from '../tools/ledger/sqlite-store.js';
import type { LedgerStore } from '../tools/ledger/store.js';
import { pauseForTest } from '../tools/ledger/wait.js';
import { goTask, type Context } from '../tools/ledger/write.js';
import { REPO } from './helpers.js';
import { asCli, commandEnv, home, LEDGER_BIN, ledger, ledgerText, noSqlite, ok, repoKeyOf, repository, storeFolder, type Ran } from './ledger-core-fixtures.js';

type Storage = 'file' | 'sqlite';

/** Enough processes and rounds that, without atomic writes, at least one round loses a write. */
const PROCESSES = 8;
const ROUNDS = 3;

function setup(t: TestContext, storage: Storage) {
  const h = home(t);
  copyFileSync(path.join(REPO, 'ledger.template.md'), path.join(h, '.claude/ledger.template.md'));
  if (storage === 'sqlite') writeFileSync(path.join(h, '.claude/ledger-settings.json'), JSON.stringify({ storage: 'sqlite' }));
  const app = repository(h, path.join(h, 'repos', 'app'));
  writeFileSync(path.join(app, '.git/info/exclude'), '.claude/\n');
  /** Runs `look` on a store opened for it alone, so the test never holds the database open while a command runs. */
  const inStore = <T>(look: (store: LedgerStore) => T): T => {
    const store = storage === 'sqlite' ? sqliteStore({ home: h }) : fileStore(ledgerPaths(h));
    try {
      return look(store);
    } finally {
      store.close?.();
    }
  };
  return { h, app, key: repoKeyOf(app), inStore };
}

/**
 * `ledger` as a child process that runs alongside the others the caller starts. Each command pauses between a read and
 * the write that depends on it, so commands started together overlap there on every run, not only on a slow machine.
 */
function ledgerAsync(h: string, cwd: string, ...args: string[]): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(LEDGER_BIN, args, { cwd, env: { ...commandEnv(h), LEDGER_TEST_DELAY_MS: '300' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const together = (count: number, run: (index: number) => Promise<Ran>): Promise<Ran[]> => Promise.all(Array.from({ length: count }, (_, index) => run(index)));

const registryEntries = (store: LedgerStore): RegistryEntry[] => JSON.parse(store.registry.read() ?? '[]') as RegistryEntry[];

const shown = (runs: Ran[]): string => runs.map(({ status, stderr }, index) => `run ${index}: exit ${status} ${stderr.trim()}`).join('\n');

for (const storage of ['file', 'sqlite'] as const) {
  const skip = storage === 'sqlite' && noSqlite;

  test(`${storage} store: of ${PROCESSES} ledger task runs at once with one slug, exactly one makes the task and the others fail without writing`, { skip }, async (t) => {
    const { h, app, key, inStore } = setup(t, storage);
    for (let round = 0; round < ROUNDS; round++) {
      const slug = `same-${round}`;
      const runs = await together(PROCESSES, (index) => ledgerAsync(h, app, 'task', 'new', slug, '--goal', `Goal of run ${index}.`));
      const made = runs.flatMap((run, index) => (run.status === 0 ? [index] : []));
      assert.equal(made.length, 1, `round ${round}: one run makes the task\n${shown(runs)}`);
      for (const run of runs.filter(({ status }) => status !== 0)) {
        assert.equal(run.status, 1, run.stderr);
        assert.match(run.stderr, new RegExp(`A backlog task ${slug} already exists`));
      }
      inStore((store) => {
        assert.match(store.backlog.read(key, slug)?.text ?? '', new RegExp(`Goal of run ${made[0]}\\.`), 'the ledger is the one of the run that succeeded');
        assert.equal(registryEntries(store).filter((entry) => entry.slug === slug).length, 1);
      });
    }
  });

  test(`${storage} store: ${PROCESSES} ledger task runs at once with distinct slugs leave every ledger in the backlog and every entry in the registry`, { skip }, async (t) => {
    const { h, app, key, inStore } = setup(t, storage);
    for (let round = 0; round < ROUNDS; round++) {
      const slugs = Array.from({ length: PROCESSES }, (_, index) => `task-${round}-${index}`);
      const runs = await together(PROCESSES, (index) => ledgerAsync(h, app, 'task', 'new', slugs[index]));
      assert.deepEqual(runs.map(({ status }) => status), slugs.map(() => 0), shown(runs));
      inStore((store) => {
        const listed = new Set(store.backlog.list(key).map(({ name }) => name));
        const registered = new Set(registryEntries(store).map(({ slug }) => slug));
        for (const slug of slugs) {
          assert.ok(listed.has(slug), `round ${round}: ${slug} is in the backlog`);
          assert.ok(registered.has(slug), `round ${round}: ${slug} is in the registry`);
        }
      });
    }
  });

  test(`${storage} store: ledger parent add runs at once on one parent list every child`, { skip }, async (t) => {
    const { h, app, key, inStore } = setup(t, storage);
    const children = Array.from({ length: PROCESSES }, (_, index) => `part-${index}`);
    for (const slug of ['epic', ...children]) ok(ledger(h, app, 'task', 'new', slug));
    const runs = await together(PROCESSES, (index) => ledgerAsync(h, app, 'tree', 'add', 'epic', children[index]));
    assert.deepEqual(runs.map(({ status }) => status), children.map(() => 0), shown(runs));
    inStore((store) => {
      const parent = store.backlog.read(key, 'epic')?.text ?? '';
      for (const child of children) {
        assert.match(parent, new RegExp(`^- ${child}$`, 'm'), `epic lists ${child}`);
        assert.match(store.backlog.read(key, child)?.text ?? '', /^- parent: epic$/m, `${child} names its parent`);
      }
    });
  });

  test(`${storage} store: a registry another command wrote since it was read is rebuilt outside the registry update, and keeps that command's task`, { skip }, (t) => {
    const { h, app, key, real, context } = inProcess(t, storage);
    ok(ledger(h, app, 'task', 'new', 'first'));
    assert.ok(real.backlog.create(key, 'mine', ledgerText({ slug: 'mine', main: app, branch: 'mine' })));
    let updating = false;
    let interfered = false;
    const listedWhileUpdating: string[] = [];
    const store: LedgerStore = {
      ...real,
      backlog: { ...real.backlog, list: (repo) => (updating && listedWhileUpdating.push(repo), real.backlog.list(repo)) },
      registry: {
        ...real.registry,
        update: (change) => {
          if (!interfered) {
            interfered = true;
            assert.ok(real.backlog.create(key, 'other', ledgerText({ slug: 'other', main: app, branch: 'other' })));
            loadTasks({ ...context, store: real }, [app]);
          }
          updating = true;
          try {
            real.registry.update(change);
          } finally {
            updating = false;
          }
        },
      },
    };
    const tasks = loadTasks({ ...context, store }, [app]);
    assert.ok(interfered, 'the registry was updated');
    assert.deepEqual(listedWhileUpdating, [], 'no rebuild ran inside the registry update');
    assert.deepEqual(tasks.map(({ name }) => name).sort(), ['first', 'mine', 'other']);
    assert.deepEqual(registryEntries(real).map(({ slug }) => slug).sort(), ['first', 'mine', 'other']);
  });

  test(`${storage} store: a registry that other commands change on every try ends the rebuild with a message after a bounded number of tries`, { skip }, (t) => {
    const { h, app, key, real, context } = inProcess(t, storage);
    ok(ledger(h, app, 'task', 'new', 'first'));
    assert.ok(real.backlog.create(key, 'mine', ledgerText({ slug: 'mine', main: app, branch: 'mine' })));
    let tries = 0;
    const store: LedgerStore = {
      ...real,
      registry: {
        ...real.registry,
        update: (change) => {
          tries++;
          real.registry.write(`${' '.repeat(tries)}[]\n`);
          real.registry.update(change);
        },
      },
    };
    assert.throws(
      () => loadTasks({ ...context, store }, [app]),
      (error) => {
        assert.ok(error instanceof Failure, String(error));
        assert.match(error.message, new RegExp(`changed the task registry ${tries} times`));
        assert.match(error.message, /Try again\.$/);
        return true;
      },
    );
    assert.ok(tries > 1 && tries <= 20, `tries: ${tries}`);
  });

  test(`${storage} store: ledger go starts nothing, keeps the backlog ledger, and says to run it again, when the ledger changes while the worktree is made`, { skip }, (t) => {
    const { h, app, key, real, context } = inProcess(t, storage);
    ok(ledger(h, app, 'task', 'new', 'epic'));
    const late = '- a child added while the worktree was made';
    const store: LedgerStore = {
      ...real,
      backlog: {
        ...real.backlog,
        remove: (...args: Parameters<LedgerStore['backlog']['remove']>) => {
          real.backlog.update(key, 'epic', (text) => `${text}${late}\n`);
          return real.backlog.remove(...args);
        },
      },
    };
    const worktreeLedger = path.join(app, '.claude/worktrees/epic/.claude/ledger.md');
    const backlogLocation = real.backlog.location(key, 'epic');
    assert.throws(
      () => goTask({ ...context, store }, 'epic', undefined),
      (error) => {
        assert.ok(error instanceof Failure, String(error));
        assert.ok(error.message.includes(backlogLocation), error.message);
        assert.match(error.message, /Nothing was started\. Run ledger go epic again\.$/);
        return true;
      },
    );
    assert.ok(real.backlog.read(key, 'epic')?.text.includes(late), 'the backlog ledger keeps the late change');
    assert.ok(!existsSync(path.dirname(path.dirname(worktreeLedger))), 'the new worktree is removed');
    assert.equal(spawnSync('git', ['-C', app, 'branch', '--list', 'epic'], { encoding: 'utf8' }).stdout.trim(), '', 'the new branch is deleted');
  });
}

/** A HOME with the repo `app`, the store of `storage` open in this process, and git run as the CLI runs it. */
function inProcess(t: TestContext, storage: Storage) {
  const { h, app, key } = setup(t, storage);
  asCli(t, h);
  const paths = ledgerPaths(h);
  const real = storage === 'sqlite' ? sqliteStore({ home: h }) : fileStore(paths);
  t.after(() => real.close?.());
  const context: Context = { paths, cwd: app, store: real };
  return { h, app, key, real, context };
}

const parked = (text: string): boolean => /Parked: \d{4}-\d\d-\d\d — paused/.test(text);

/** The pid of a process that has exited. */
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid;

function lockedBacklogTask(t: TestContext, holder: { pid: number; since: string }) {
  const { h, app } = setup(t, 'file');
  ok(ledger(h, app, 'task', 'new', 'fix-login'));
  const file = path.join(storeFolder(h, 'ledger-backlog', app), 'fix-login.md');
  const lock = `${file}.lock`;
  writeFileSync(lock, JSON.stringify(holder));
  return { h, app, file, lock };
}

test('file store: a lock left by a process that is gone is taken over, and the change is written', (t) => {
  const { h, app, file, lock } = lockedBacklogTask(t, { pid: deadPid(), since: new Date().toISOString() });
  ok(ledger(h, app, 'task', 'park', 'fix-login', '--reason', 'paused'));
  assert.ok(parked(readFileSync(file, 'utf8')));
  assert.equal(existsSync(lock), false);
});

test('file store: a lock older than its time limit is taken over, even when its process still runs', (t) => {
  const { h, app, file, lock } = lockedBacklogTask(t, { pid: process.pid, since: new Date(Date.now() - 60 * 60_000).toISOString() });
  ok(ledger(h, app, 'task', 'park', 'fix-login', '--reason', 'paused'));
  assert.ok(parked(readFileSync(file, 'utf8')));
  assert.equal(existsSync(lock), false);
});

test('file store: a command that waits too long for a lock held by a live process exits 1, names the lock and its process, and writes nothing', (t) => {
  const { h, app, file, lock } = lockedBacklogTask(t, { pid: process.pid, since: new Date().toISOString() });
  const before = readFileSync(file, 'utf8');
  const ran = ledger(h, app, 'task', 'park', 'fix-login', '--reason', 'paused');
  assert.equal(ran.status, 1, ran.stderr);
  assert.ok(ran.stderr.includes(lock), ran.stderr);
  assert.ok(ran.stderr.includes(`process ${process.pid}`), ran.stderr);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.ok(existsSync(lock), 'the lock of a live process stays');
});

test('sqlite store: a command that waits too long for the database exits 1, says another command holds it, and writes nothing', { skip: noSqlite }, async (t) => {
  const { h, app, key, inStore } = setup(t, 'sqlite');
  ok(ledger(h, app, 'task', 'new', 'fix-login'));
  const before = inStore((store) => store.backlog.read(key, 'fix-login')?.text);
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const holder = new DatabaseSync(path.join(h, '.claude/ledgers.db'));
  holder.exec('BEGIN IMMEDIATE');
  let ran: Ran;
  try {
    ran = await ledgerAsync(h, app, 'task', 'park', 'fix-login', '--reason', 'paused');
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  assert.equal(ran.status, 1, ran.stderr);
  assert.match(ran.stderr, /another ledger command/i);
  assert.ok(ran.stderr.includes('ledgers.db'), ran.stderr);
  assert.equal(inStore((store) => store.backlog.read(key, 'fix-login')?.text), before);
});

/** Runs `call` on the SQLite store of HOME `h` in a child process, so this one is free while the child waits for the database. */
function storeCallAsync(h: string, call: string): Promise<Ran> {
  const script = `
    import { sqliteStore } from './tools/ledger/sqlite-store.ts';
    const store = sqliteStore({ home: ${JSON.stringify(h)} });
    try {
      ${call};
      console.log('done');
    } catch (error) {
      console.log(error.message);
    }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', '--input-type=module', '-e', script], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('sqlite store: every write that waits too long for the database says another command holds it, and writes nothing', { skip: noSqlite }, async (t) => {
  const { h, app, key, inStore } = setup(t, 'sqlite');
  ok(ledger(h, app, 'task', 'new', 'fix-login'));
  const before = inStore((store) => ({ ledger: store.backlog.read(key, 'fix-login')?.text, registry: store.registry.read() }));
  const calls = {
    'backlog.write': `store.backlog.write(${JSON.stringify(key)}, 'fix-login', 'changed\\n')`,
    'backlog.remove': `store.backlog.remove(${JSON.stringify(key)}, 'fix-login', store.backlog.read(${JSON.stringify(key)}, 'fix-login').text)`,
    'archive.write': `store.archive.write(${JSON.stringify(key)}, '2026-11-19-fix-login', 'archived\\n')`,
    'registry.write': `store.registry.write('[]\\n')`,
  };
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const holder = new DatabaseSync(path.join(h, '.claude/ledgers.db'));
  holder.exec('BEGIN IMMEDIATE');
  let runs: Ran[];
  try {
    runs = await Promise.all(Object.values(calls).map((call) => storeCallAsync(h, call)));
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  Object.keys(calls).forEach((name, index) => {
    const { stdout, stderr } = runs[index];
    assert.match(stdout, /^Another ledger command has been writing .*ledgers\.db for more than 5 seconds/, `${name}: ${stdout}${stderr}`);
  });
  inStore((store) => {
    assert.equal(store.backlog.read(key, 'fix-login')?.text, before.ledger);
    assert.equal(store.archive.has(key, '2026-11-19-fix-login'), false);
    assert.equal(store.registry.read(), before.registry);
  });
});

test('sqlite store: a write that fails, and whose rollback fails too, reports why the write failed', { skip: noSqlite }, (t) => {
  const { h } = setup(t, 'sqlite');
  const store = sqliteStore({ home: h });
  assert.throws(
    () =>
      store.registry.update(() => {
        store.close?.();
        throw new Error('the change failed');
      }),
    /^Error: the change failed$/,
  );
});

test('LEDGER_TEST_DELAY_MS pauses for at most a finite, non-negative value, capped at 10 s; any other value pauses not at all', (t) => {
  const pauses: number[] = [];
  t.mock.method(Atomics, 'wait', (_array: Int32Array, _index: number, _value: number, ms?: number) => {
    pauses.push(ms ?? Infinity);
    return 'timed-out';
  });
  t.mock.method(Math, 'random', () => 1);
  const before = process.env.LEDGER_TEST_DELAY_MS;
  try {
    for (const value of ['250', '1e9', 'Infinity', '1e400', 'NaN', '-5', '0', '']) {
      process.env.LEDGER_TEST_DELAY_MS = value;
      pauseForTest();
    }
  } finally {
    if (before === undefined) delete process.env.LEDGER_TEST_DELAY_MS;
    else process.env.LEDGER_TEST_DELAY_MS = before;
  }

  assert.deepEqual(pauses, [250, 10_000]);
});
