import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { checkLlp } from '../tools/llp-refs.js';
import { REPO } from './helpers.js';

function repo(t: TestContext, files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'llp-refs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  return root;
}

function doc(number: string, header: string[], body = '## Summary\n\nText.\n'): string {
  return `# LLP ${number}: Title\n\n${header.join('\n')}\n\n${body}`;
}

function fields(type: string, ...extra: string[]): string[] {
  return [`**Type:** ${type}`, '**Status:** Active', '**Date:** 2026-11-19', ...extra];
}

// Built at run time: a literal reference in this file would be checked by the real-repo test.
function ref(target: string): string {
  return `@${'ref'} LLP ${target}`;
}

test('llp-refs accepts a valid corpus with references, anchors and links', (t) => {
  const root = repo(t, {
    'README.md': '# Readme\n',
    'llp/0000-architecture.explainer.md': doc('0000', fields('Explainer'), [
      '## Summary',
      '',
      'See [the plan](0001-workflow.plan.md#51-states), [the readme](../README.md), [a site](https://example.com) and [above](#summary).',
      '',
      '```md',
      '[not a link](missing.md)',
      '# Not a heading',
      '```',
      '',
    ].join('\n')),
    'llp/0001-workflow.plan.md': doc('0001', fields('plan', '**Related:** LLP 0000'), '## 5.1 States\n\n## Known gaps\n\n## Known gaps\n\n## `ledger hook` and _hooks_\n'),
    'tools/a.ts': `// ${ref('0001#51-states')}\n// ${ref('0001#known-gaps-1')}\n// ${ref('0001#ledger-hook-and-_hooks_')}\n`,
    'docs/notes.md': `${ref('0000')}\n`,
  });
  assert.deepEqual(checkLlp(root), []);
});

test('llp-refs rejects an unknown or missing type and a Type line that disagrees with the file name', (t) => {
  const root = repo(t, {
    'llp/0001-thing.notes.md': doc('0001', fields('Notes')),
    'llp/0002-thing.plan.md': doc('0002', fields('Guide')),
    'llp/0003-Bad_Name.md': doc('0003', fields('Plan')),
  });
  assert.deepEqual(checkLlp(root), [
    'llp/0001-thing.notes.md: type "notes" is not one of explainer, plan, guide, decision, issue, request, rfc',
    'llp/0002-thing.plan.md: **Type:** Guide does not match the file name type "plan"',
    'llp/0003-Bad_Name.md: file name is not NNNN-<slug>.<type>.md',
  ]);
});

test('llp-refs rejects a number used by two documents', (t) => {
  const root = repo(t, {
    'llp/0001-alpha.plan.md': doc('0001', fields('Plan')),
    'llp/0001-beta.guide.md': doc('0001', fields('Guide')),
  });
  assert.deepEqual(checkLlp(root), ['llp/0001-beta.guide.md: number 0001 is already used by llp/0001-alpha.plan.md']);
});

test('llp-refs rejects missing header lines, a bad date and a wrong or missing heading', (t) => {
  const root = repo(t, {
    'llp/0001-no-status.plan.md': doc('0001', ['**Type:** Plan', '**Date:** 2026-11-19']),
    'llp/0002-bad-date.plan.md': doc('0002', ['**Type:** Plan', '**Status:** Draft', '**Date:** 19.11.2026']),
    'llp/0003-wrong-number.plan.md': doc('0004', fields('Plan')),
    'llp/0005-no-heading.plan.md': `${fields('Plan').join('\n')}\n\n## Summary\n`,
    'llp/0006-late-fields.plan.md': doc('0006', [], `## Summary\n\n${fields('Plan').join('\n')}\n`),
  });
  assert.deepEqual(checkLlp(root), [
    'llp/0001-no-status.plan.md: missing **Status:** line',
    'llp/0002-bad-date.plan.md: **Date:** 19.11.2026 is not YYYY-MM-DD',
    'llp/0003-wrong-number.plan.md: heading number 0004 does not match the file name number 0003',
    'llp/0005-no-heading.plan.md: missing "# LLP 0005: <title>" heading',
    'llp/0006-late-fields.plan.md: missing **Type:** line',
    'llp/0006-late-fields.plan.md: missing **Status:** line',
    'llp/0006-late-fields.plan.md: missing **Date:** line',
  ]);
});

test('llp-refs rejects a Related line that names a missing document', (t) => {
  const root = repo(t, {
    'llp/0000-base.explainer.md': doc('0000', fields('Explainer')),
    'llp/0001-next.plan.md': doc('0001', fields('Plan', '**Related:** LLP 0000, LLP 0009')),
  });
  assert.deepEqual(checkLlp(root), ['llp/0001-next.plan.md: **Related:** names missing LLP 0009']);
});

test('llp-refs rejects references to missing documents and anchors in every scanned file type', (t) => {
  const root = repo(t, {
    'llp/0000-base.explainer.md': doc('0000', fields('Explainer')),
    'tools/a.ts': `ok ${ref('0000#summary')}\n// ${ref('0009')}\n// ${ref('0000#nope')}\n`,
    'bin/b.sh': `# ${ref('0007')}\n`,
    'c.js': `// ${ref('0000#summary-1')}\n`,
    'd.json': `{ "note": "${ref('0008')}" }\n`,
    'e.toml': `# ${ref('0006')} and ${ref('0000#gone')}\n`,
    'docs/f.md': `${ref('0005')}\n`,
    'notes.txt': `${ref('0004')}\n`,
    'node_modules/pkg/index.ts': `// ${ref('0003')}\n`,
    '.claude/ledger.md': `${ref('0003')}\n`,
    '.git/info.md': `${ref('0003')}\n`,
  });
  assert.deepEqual(checkLlp(root), [
    'bin/b.sh:1: @ref names missing LLP 0007',
    'c.js:1: @ref anchor #summary-1 is not a heading in llp/0000-base.explainer.md',
    'd.json:1: @ref names missing LLP 0008',
    'docs/f.md:1: @ref names missing LLP 0005',
    'e.toml:1: @ref names missing LLP 0006',
    'e.toml:1: @ref anchor #gone is not a heading in llp/0000-base.explainer.md',
    'tools/a.ts:2: @ref names missing LLP 0009',
    'tools/a.ts:3: @ref anchor #nope is not a heading in llp/0000-base.explainer.md',
  ]);
});

test('llp-refs rejects relative links in LLP documents that point to missing files', (t) => {
  const root = repo(t, {
    'llp/0000-base.explainer.md': doc('0000', fields('Explainer'), [
      '## Summary',
      '',
      'Read [this](missing.md), [that](../tools/gone.ts#L3 "Title") and `[code](ignored.md)`.',
      '![diagram](img/none.png)',
      '',
    ].join('\n')),
    'docs/outside.md': '[outside](missing.md)\n',
  });
  assert.deepEqual(checkLlp(root), [
    'llp/0000-base.explainer.md:9: link to missing file missing.md',
    'llp/0000-base.explainer.md:9: link to missing file ../tools/gone.ts',
    'llp/0000-base.explainer.md:10: link to missing file img/none.png',
  ]);
});

test('llp-refs reports nothing for a repo without an llp folder', (t) => {
  const root = repo(t, { 'README.md': '# Readme\n', 'tools/a.ts': 'export {};\n' });
  assert.deepEqual(checkLlp(root), []);
});

test('llp-refs still reports a dangling @ref in a repo without an llp folder', (t) => {
  const root = repo(t, { 'tools/a.ts': `// ${ref('0003')}\n` });
  assert.deepEqual(checkLlp(root), ['tools/a.ts:1: @ref names missing LLP 0003']);
});

test('llp-refs finds no problems in this repo', () => {
  assert.deepEqual(checkLlp(REPO), []);
});
