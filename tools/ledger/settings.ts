import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fail, Failure } from './failure.js';
import { exists, writeAtomic } from './files.js';
import { ledgerPaths } from './paths.js';

export const STORAGES = ['file', 'sqlite', 'git'] as const;
export type Storage = (typeof STORAGES)[number];

export const settingsFile = (home: string): string => path.join(home, '.claude', 'ledger-settings.json');

/** The settings file as a person reads it, with HOME as ~. */
export const shownSettingsFile = (home: string): string => ledgerPaths(home).tilde(settingsFile(home));

const isStorage = (value: unknown): value is Storage => STORAGES.some((storage) => storage === value);

const ALLOWED = STORAGES.map((value) => JSON.stringify(value)).join(' or ');

/** The object in the settings file; undefined without the file. `fix` is what to do about a file that is no JSON. */
function readSettings(home: string, fix: string): Record<string, unknown> | undefined {
  const shown = shownSettingsFile(home);
  let text: string;
  try {
    text = readFileSync(settingsFile(home), 'utf8');
  } catch (error) {
    // ENOTDIR: ~/.claude is not a folder, so no settings file can be there either.
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    return fail(`Could not read ${shown}: ${(error as Error).message}`);
  }
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return fail(`${shown} is not valid JSON. ${fix}`);
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return fail(`${shown} must hold one JSON object, such as {"storage": "file"}.`);
  return settings as Record<string, unknown>;
}

/** Where the ledgers are kept: "storage" in ~/.claude/ledger-settings.json, and files without the file or the key. */
export function readStorage(home: string): Storage {
  const storage = readSettings(home, `Fix it and use ${ALLOWED} for "storage", or delete it to keep the ledgers in files.`)?.storage;
  if (storage === undefined || isStorage(storage)) return storage ?? 'file';
  return fail(`Unknown storage ${JSON.stringify(storage)} in ${shownSettingsFile(home)}. Use ${ALLOWED}.`);
}

/** How long a claim lasts with no activity: "claimExpiryMinutes" in ~/.claude/ledger-settings.json, two hours without it. */
export function readClaimExpiryMinutes(home: string): number {
  const settings = readSettings(home, 'Fix it, or delete it to use the default settings.') ?? {};
  if (!('claimExpiryMinutes' in settings)) return 120;
  const minutes = settings.claimExpiryMinutes;
  if (typeof minutes === 'number' && Number.isInteger(minutes) && minutes > 0) return minutes;
  return fail(`"claimExpiryMinutes" in ${shownSettingsFile(home)} must be a whole number of minutes above 0, such as 120, not ${JSON.stringify(minutes)}.`);
}

/**
 * A host label, the name of a machine that an active record names, as a pattern that is both a JavaScript regular
 * expression and a POSIX extended one: the allowlist and the pre-push hook take the host folder of a copy from before
 * active records by it.
 */
export const HOST_LABEL = '[a-z0-9-]+';

const isHostLabel = (text: string): boolean => new RegExp(`^${HOST_LABEL}$`).test(text);

/** A host name as a host label: up to its first dot, in lowercase, with each character outside a-z, 0-9 and - as -, and no - at either end. */
export const hostLabel = (raw: string): string =>
  raw
    .split('.')[0]
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');

const SET_HOST = 'lowercase letters, digits and hyphens, such as "work-laptop"';

/**
 * The name of this machine, which each active record it starts names: "host" in ~/.claude/ledger-settings.json, else
 * the label of its host name. A "host" that is no label fails, and so does a host name that gives an empty label.
 */
export function readHost(home: string): string {
  const { host } = readSettings(home, 'Fix it, or delete it to use the default settings.') ?? {};
  const shown = shownSettingsFile(home);
  if (host === undefined) {
    const label = hostLabel(os.hostname());
    return label !== '' ? label : fail(`The host name ${JSON.stringify(os.hostname())} gives no host label for this machine. Set "host" in ${shown} to ${SET_HOST}.`);
  }
  if (typeof host === 'string' && isHostLabel(host)) return host;
  return fail(`"host" in ${shown} is ${JSON.stringify(host)}. Set "host" there to ${SET_HOST}.`);
}

/** Why readHost fails; undefined when it gives a host label. */
export function hostProblem(home: string): string | undefined {
  try {
    readHost(home);
    return undefined;
  } catch (error) {
    if (error instanceof Failure) return error.message;
    throw error;
  }
}

/** readHost, or undefined where it fails: then no active record counts as this machine's by its host. */
export const validHost = (home: string): string | undefined => (hostProblem(home) === undefined ? readHost(home) : undefined);

/** Sets "storage" in the settings file and keeps every other key. Call readStorage first: it refuses a broken file. */
export function writeStorage(home: string, storage: Storage): void {
  const file = settingsFile(home);
  const settings: object = exists(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  writeAtomic(file, `${JSON.stringify({ ...settings, storage }, null, 2)}\n`);
}
