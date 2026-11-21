import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fail } from './failure.js';
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

/** Sets "storage" in the settings file and keeps every other key. Call readStorage first: it refuses a broken file. */
export function writeStorage(home: string, storage: Storage): void {
  const file = settingsFile(home);
  const settings: object = exists(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  writeAtomic(file, `${JSON.stringify({ ...settings, storage }, null, 2)}\n`);
}
