import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { isMain, parseArguments } from './cli.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOME = os.homedir();

function readText(filename: string): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    .decode(readFileSync(filename))
    .replace(/\r\n?/g, '\n');
}

function backup(source: string, backupDir: string): void {
  const relative = path.relative(HOME, source);
  const withinHome = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  const destination = path.join(backupDir, withinHome ? relative : path.basename(source));
  const metadata = statSync(source);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  chmodSync(destination, metadata.mode);
  utimesSync(destination, metadata.atime, metadata.mtime);
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown): JsonObject {
  if (!isObject(value)) throw new TypeError('Expected a JSON object');
  return value;
}

type MergeChild = (key: string, liveValue: unknown, policyValue: unknown) => unknown;

const takePolicy: MergeChild = (_key, _liveValue, policyValue) => policyValue;

// Earlier deploys wrote these events as inline scripts, so they are replaced
// whole rather than merged entry by entry.
const ASSERTED_HOOK_EVENTS = new Set(['PreCompact', 'SessionStart']);

const mergeHookEvent: MergeChild = (event, liveEntries, policyEntries) => {
  if (ASSERTED_HOOK_EVENTS.has(event) || !Array.isArray(liveEntries) || !Array.isArray(policyEntries)) {
    return policyEntries;
  }
  const isOwned = (entry: unknown): boolean => policyEntries.some((ownedEntry) => isDeepStrictEqual(entry, ownedEntry));
  return [...liveEntries.filter((entry) => !isOwned(entry)), ...policyEntries];
};

function mergeKey(
  liveValue: unknown,
  policyValue: unknown,
  mergeChild = takePolicy,
): [unknown, string[], string[]] {
  if (!(isObject(liveValue) && isObject(policyValue))) {
    return [policyValue, isDeepStrictEqual(liveValue ?? null, policyValue) ? [] : [''], []];
  }
  const merged = new Map(Object.entries(liveValue));
  const changed: string[] = [];
  for (const [key, value] of Object.entries(policyValue)) {
    const mergedValue = mergeChild(key, merged.get(key), value);
    if (!isDeepStrictEqual(merged.get(key) ?? null, mergedValue)) changed.push(key);
    merged.set(key, mergedValue);
  }
  const kept = Object.keys(liveValue).filter((key) => !Object.hasOwn(policyValue, key));
  return [Object.fromEntries(merged), changed, kept];
}

export function applyJson(
  policyPath: string,
  target: string,
  backupDir: string,
  dry = false,
): [string[], string[]] {
  const policy = requireObject(JSON.parse(readText(policyPath)));
  if (!existsSync(target)) {
    if (!dry) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(policy, null, 2)}\n`);
    }
    return [Object.keys(policy).sort(), []];
  }
  const live = requireObject(JSON.parse(readText(target)));
  const merged = new Map(Object.entries(live));
  const changed: string[] = [];
  const kept: string[] = [];
  for (const [key, value] of Object.entries(policy)) {
    const [newValue, subChanged, subKept] = mergeKey(
      Object.hasOwn(live, key) ? live[key] : undefined,
      value,
      key === 'hooks' ? mergeHookEvent : takePolicy,
    );
    merged.set(key, newValue);
    changed.push(...subChanged.map((subkey) => (subkey === '' ? key : `${key}.${subkey}`)));
    kept.push(...subKept.map((subkey) => `${key}.${subkey}`));
  }
  kept.push(...Object.keys(live).filter((key) => !Object.hasOwn(policy, key)));
  if (changed.length === 0) return [[], kept.sort()];
  if (!dry) {
    backup(target, backupDir);
    writeFileSync(target, `${JSON.stringify(Object.fromEntries(merged), null, 2)}\n`);
  }
  return [changed.sort(), kept.sort()];
}

function setTomlKey(lines: string[], key: string, rawValue: string): boolean {
  const found = lines.findIndex((line) => line.startsWith('['));
  const firstTable = found === -1 ? lines.length : found;
  for (let index = 0; index < firstTable; index++) {
    const stripped = lines[index]!.trimStart();
    if (stripped.startsWith(key) && stripped.slice(key.length).trimStart().startsWith('=')) {
      const replacement = `${key} = ${rawValue}\n`;
      if (lines[index] === replacement) return false;
      lines[index] = replacement;
      return true;
    }
  }
  lines.splice(firstTable, 0, `${key} = ${rawValue}\n`);
  if (firstTable + 1 < lines.length && lines[firstTable + 1]!.startsWith('[')) {
    lines.splice(firstTable + 1, 0, '\n');
  }
  return true;
}

function formatTomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(formatTomlValue).join(', ')}]`;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return '-0.0';
    const formatted = String(value);
    return /^-?\d+$/.test(formatted) ? `${formatted}.0` : formatted;
  }
  return JSON.stringify(value);
}

export function applyToml(
  policyPath: string,
  target: string,
  backupDir: string,
  dry = false,
): [string[] | null, number | null] {
  const policy: unknown = parseToml(readText(policyPath), { integersAsBigInt: true });
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    throw new TypeError('Expected a TOML table');
  }
  const flat = Object.entries(policy).filter((entry) => {
    const value: unknown = entry[1];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return true;
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype !== Object.prototype && prototype !== null;
  });
  if (!existsSync(target)) return [null, null];
  const lines = readText(target).match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const changed = flat
    .filter(([key, value]) => setTomlKey(lines, key, formatTomlValue(value)))
    .map(([key]) => key);
  const tables = lines.filter((line) => line.startsWith('[')).length;
  if (changed.length === 0) return [[], tables];
  const updated = lines.join('');
  parseToml(updated, { integersAsBigInt: true });
  if (!dry) {
    backup(target, backupDir);
    writeFileSync(target, updated);
  }
  return [changed, tables];
}

function applyPolicy({ backupDir, dry = false, noCodex = false, codex = false }: { backupDir: string; dry?: boolean; noCodex?: boolean; codex?: boolean }): number {
  const verb = dry ? 'would apply' : 'applied';
  const [changed, untouched] = applyJson(
    path.join(REPO, 'settings.policy.json'),
    path.join(HOME, '.claude/settings.json'),
    backupDir,
    dry,
  );
  console.log(`claude   policy keys ${verb}: ${changed.length > 0 ? changed.join(', ') : 'already current'}`);
  if (untouched.length > 0) console.log(`         left alone: ${untouched.join(', ')}`);

  const target = path.join(HOME, '.codex/config.toml');
  if (noCodex) {
    console.log('codex    skipped (--no-codex)');
    return 0;
  }
  if (!existsSync(target)) {
    if (codex) {
      console.error(`codex    ERROR: ${target} not found`);
      return 1;
    }
    console.log('codex    skipped (no ~/.codex/config.toml; pass --codex to require it)');
    return 0;
  }
  const [codexChanged, tables] = applyToml(path.join(REPO, 'codex/policy.toml'), target, backupDir, dry);
  console.log(
    `codex    policy keys ${verb}: ${codexChanged !== null && codexChanged.length > 0 ? codexChanged.join(', ') : 'already current'}`,
  );
  console.log(`         left alone: ${tables} tables of local state (projects, plugins, mcp_servers)`);
  return 0;
}

function main(): number {
  const args = parseArguments([
    { name: '--backup-dir', value: 'BACKUP_DIR', required: true },
    { name: '--no-codex' },
    { name: '--codex', help: 'fail if Codex is absent' },
    { name: '--dry-run', help: 'report changes, write nothing' },
  ]);
  const backupDir = args['--backup-dir'];
  if (typeof backupDir !== 'string') throw new TypeError('--backup-dir must be a string');
  return applyPolicy({
    backupDir,
    dry: args['--dry-run'] === true,
    noCodex: args['--no-codex'] === true,
    codex: args['--codex'] === true,
  });
}

if (isMain(import.meta.url)) {
  process.exitCode = main();
}
