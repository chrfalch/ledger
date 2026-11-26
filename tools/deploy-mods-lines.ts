/**
 * The lines tools/deploy.ts prints about what it did to the Claude Code plugins, and the reading of them by `ledger
 * deploy --latest`. One module, so a change to the wording reaches both. It imports nothing: deploy runs on Node 20.12,
 * and must not load the ledger.
 */

const PREFIX = 'mods     ';

export const modsLines = {
  installed: (mod: string, name: string): string => `${PREFIX}installed ${mod} (/${name})`,
  reinstalled: (mod: string, name: string): string => `${PREFIX}reinstalled ${mod} (installed copy differed from mods/${name})`,
  marketplaceElsewhere: (marketplace: string, location: string): string =>
    `${PREFIX}marketplace ${marketplace} points at ${location}, not this repo; to fix: claude plugin marketplace remove ${marketplace}, then run deploy again`,
  skippedInstall: (mods: string[]): string => `${PREFIX}skipped install of ${mods.join(', ')} until the marketplace points at this repo`,
  noClaude: (): string => `${PREFIX}skipped (no claude CLI on PATH)`,
};

const WARNINGS = [/^marketplace \S+ points at .+, not this repo; /, /^skipped install of .+ until /, /^skipped \(no claude CLI on PATH\)$/];

export type ModsChanges = { reinstalled: string[]; installed: string[]; warnings: string[] };

/** The mods that deploy's `stdout` says it installed or reinstalled, and its lines that warn of mods it could not deploy. */
export function readModsLines(stdout: string): ModsChanges {
  const texts = stdout.split('\n').flatMap((line) => (line.startsWith(PREFIX) ? [line.slice(PREFIX.length)] : []));
  const mods = (verb: string): string[] => texts.flatMap((text) => new RegExp(`^${verb} (\\S+) \\(`).exec(text)?.slice(1) ?? []);
  return {
    reinstalled: mods('reinstalled'),
    installed: mods('installed'),
    warnings: texts.filter((text) => WARNINGS.some((warning) => warning.test(text))),
  };
}
