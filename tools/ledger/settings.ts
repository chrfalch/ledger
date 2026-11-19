import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fail } from './failure.js';
import { ledgerPaths } from './paths.js';

const STORAGES = ['file', 'sqlite'] as const;
export type Storage = (typeof STORAGES)[number];

export const settingsFile = (home: string): string => path.join(home, '.claude', 'ledger-settings.json');

/** The settings file as a person reads it, with HOME as ~. */
export const shownSettingsFile = (home: string): string => ledgerPaths(home).tilde(settingsFile(home));

const isStorage = (value: unknown): value is Storage => STORAGES.some((storage) => storage === value);

const ALLOWED = STORAGES.map((value) => JSON.stringify(value)).join(' or ');

/** Where the ledgers are kept: "storage" in ~/.claude/ledger-settings.json, and files without the file or the key. */
export function readStorage(home: string): Storage {
  const shown = shownSettingsFile(home);
  let text: string;
  try {
    text = readFileSync(settingsFile(home), 'utf8');
  } catch (error) {
    // ENOTDIR: ~/.claude is not a folder, so no settings file can be there either.
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'file';
    return fail(`Could not read ${shown}: ${(error as Error).message}`);
  }
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return fail(`${shown} is not valid JSON. Fix it and use ${ALLOWED} for "storage", or delete it to keep the ledgers in files.`);
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return fail(`${shown} must hold one JSON object, such as {"storage": "file"}.`);
  const { storage } = settings as { storage?: unknown };
  if (storage === undefined || isStorage(storage)) return storage ?? 'file';
  return fail(`Unknown storage ${JSON.stringify(storage)} in ${shown}. Use ${ALLOWED}.`);
}
