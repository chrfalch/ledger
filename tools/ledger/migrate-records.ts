// @ref LLP 0001#4-storage — D29: existing Markdown ledgers are converted once; text that fits no list goes to general notes.
import { parseLedger } from './format.js';
import { parseRecord, recordToWrite } from './record.js';
import { repoLabel } from './repo-key.js';
import type { LedgerCollection, LedgerStore } from './store.js';
import { plural } from './views.js';

/** The lines of `text` that went to its record's general notes, without the copies of the headings they stood under. */
function notedLines(text: string): number {
  const { notes } = parseRecord(text);
  const headings = new Set(parseLedger(notes.join('\n')).sections.map(({ start }) => start));
  return notes.filter((line, index) => line.trim() !== '' && !headings.has(index)).length;
}

/**
 * Converts the Markdown ledger `name`; false when it is not kept as Markdown. A dry run changes nothing, but checks the
 * text toRecord would convert as toRecord checks it, so it fails where the conversion would.
 */
function convert(collection: LedgerCollection, repo: string, name: string, dryRun: boolean): boolean {
  if (!dryRun) return collection.toRecord?.(repo, name) ?? false;
  const markdown = collection.markdownText?.(repo, name);
  if (markdown !== undefined) recordToWrite(markdown, collection.location(repo, name));
  return markdown !== undefined;
}

/**
 * Rewrites each backlog ledger and archive copy the store still keeps as Markdown as a task record. A second run finds
 * none left. A task kept both as a record and as Markdown is a conflict: it stays as it is, for a person to merge.
 * `store` is undefined for a database that is not there. Prints one line per ledger to `line`, with how many of its
 * lines went to the general notes, and returns how many conflicts it left, which a dry run counts the same. A ledger
 * whose record would not read back the same stops it with a Failure, a dry run too.
 */
export function migrateRecords(store: LedgerStore | undefined, { dryRun }: { dryRun: boolean }, line: (text: string) => void): number {
  line(`Convert backlog and archive ledgers to task records${dryRun ? ' · dry run, nothing changed' : ''}`);
  let converted = 0;
  let conflicts = 0;
  for (const place of ['backlog', 'archive'] as const) {
    const collection = store?.[place];
    if (collection === undefined) continue;
    for (const repo of collection.repos()) {
      for (const name of collection.markdownNames?.(repo) ?? []) {
        const ledger = collection.read(repo, name);
        if (ledger === undefined || !convert(collection, repo, name, dryRun)) continue;
        line(`${dryRun ? 'would convert' : 'converted'} ${place} ${repoLabel(repo)} ${name}: ${plural(notedLines(ledger.text), 'line')} to general notes`);
        converted++;
      }
      for (const name of collection.hiddenMarkdown?.(repo) ?? []) {
        line(`left ${place} ${repoLabel(repo)} ${name}: it has both a record and Markdown from before records, at ${collection.location(repo, name)}. Merge the two by hand, then remove the Markdown.`);
        conflicts++;
      }
    }
  }
  line(`${dryRun ? 'Would convert' : 'Converted'} ${plural(converted, 'ledger')}.`);
  if (conflicts > 0) line(`Left ${plural(conflicts, 'ledger')} kept both ways; nothing of them changed.`);
  return conflicts;
}
