// @ref LLP 0001#7-the-lifecycle — D18: the start installs the repo's packages, so the first test run in a new worktree does not fail.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fail } from './failure.js';
import { exists } from './files.js';

/** The exit code of `ledger go` when the install fails, after the exit codes of promote and Held. */
export const INSTALL_FAILED = 5;

/** Each package manager, by the lockfiles that name it, in the order the first match wins. */
const INSTALLERS: { lockfiles: string[]; command: [string, ...string[]] }[] = [
  { lockfiles: ['bun.lock', 'bun.lockb'], command: ['bun', 'install', '--frozen-lockfile'] },
  { lockfiles: ['pnpm-lock.yaml'], command: ['pnpm', 'install', '--frozen-lockfile'] },
  { lockfiles: ['yarn.lock'], command: ['yarn', 'install', '--frozen-lockfile'] },
  { lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'], command: ['npm', 'ci'] },
];

const TAIL_LINES = 10;

/** Well under the plugin's 10-minute limit on all of `ledger go`, so a hung install still ends as exit 5. */
const INSTALL_TIMEOUT_MS = 8 * 60 * 1000;

function whyFailed(program: string, { error, status, signal }: SpawnSyncReturns<string>): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return `${program} is not installed or not on PATH`;
  if (code === 'ETIMEDOUT') return `it ran longer than ${INSTALL_TIMEOUT_MS / 60000} minutes`;
  if (error !== undefined) return error.message;
  return status === null ? `it was stopped by ${signal}` : `it exited ${status}`;
}

/** The install that `worktree` needs: none once it has node_modules, or when no lockfile is at its root. */
function installCommand(worktree: string): [string, ...string[]] | undefined {
  if (exists(path.join(worktree, 'node_modules'))) return undefined;
  return INSTALLERS.find(({ lockfiles }) => lockfiles.some((lockfile) => exists(path.join(worktree, lockfile))))?.command;
}

/**
 * Installs the packages of `worktree` when it needs it, and returns the command it ran. The output is kept for the
 * failure message only, which ends with `retry`: the worktree stays, so the same start installs again.
 */
export function installPackages(worktree: string, retry: string): string | undefined {
  const command = installCommand(worktree);
  if (command === undefined) return undefined;
  const [program, ...args] = command;
  const shown = command.join(' ');
  // An install can print more than the default 1 MB buffer, which would stop it partway.
  const result = spawnSync(program, args, {
    cwd: worktree,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
    timeout: INSTALL_TIMEOUT_MS,
  });
  if (result.status === 0) return shown;
  // A partial node_modules would make the next start skip the install. There was none before this install ran.
  const modules = path.join(worktree, 'node_modules');
  let leftover: string | undefined;
  try {
    rmSync(modules, { recursive: true, force: true });
  } catch (error) {
    leftover = `Could not remove the partial ${modules} (${(error as Error).message}); remove it before the retry.`;
  }
  const tail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
  return fail(
    [
      `Could not install the packages of ${worktree}: \`${shown}\` failed, as ${whyFailed(program, result)}.`,
      ...(tail === '' ? [] : [`Its last lines:\n${tail}`]),
      ...(leftover === undefined ? [] : [leftover]),
      `The worktree and its ledger are kept. Fix the cause, then run ${retry} again to install.`,
    ].join('\n'),
    INSTALL_FAILED,
  );
}
