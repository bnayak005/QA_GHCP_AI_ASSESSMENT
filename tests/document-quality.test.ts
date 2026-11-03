import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  definitionIds,
  headingAnchors,
  markdownFindings,
  referenceFindings,
  taskGraphFindings,
} from '../scripts/document-quality';

describe('document verification rules', () => {
  it('defaults to packaged documents and rejects invalid explicit overrides', () => {
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'scripts/verify-documents.ts', ...args], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 10_000,
      });
    for (const args of [[], ['--documents-root', path.join(process.cwd(), 'docs')]]) {
      const result = run(args);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('6 documents');
      expect(result.stdout).toContain('0 findings');
    }
    for (const args of [
      ['--documents-root'],
      ['--documents-root', path.join(process.cwd(), '__missing_requirements__')],
    ]) {
      const result = run(args);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('Provide --documents-root');
    }
  }, 30_000);
  it('rejects empty, damaged, untitled, placeholder and unclosed-fence output', () => {
    for (const text of [
      '',
      'Untitled',
      '# Title\n\uFFFD',
      '# Title\nTODO',
      '# Title\n```ts\nconst value = 1;',
    ]) {
      expect(markdownFindings('test.md', text).length).toBeGreaterThan(0);
    }
    expect(
      markdownFindings(
        'test.md',
        '# Title\n## Scope\nValid content.\n```ts\nconst value = 1;\n```',
      ),
    ).toEqual([]);
  });
  it('checks table columns without treating code samples as prose tables', () => {
    expect(markdownFindings('test.md', '# Title\n| A | B |\n|---|---|\n| only one |')).not.toEqual(
      [],
    );
    expect(markdownFindings('test.md', '# Title\n```text\n| A | B |\n| only one |\n```')).toEqual(
      [],
    );
    expect(markdownFindings('test.md', '# Title\n```text\nvalue\n~~~')).not.toEqual([]);
  });
  it('resolves numbered Markdown section anchors', () => {
    expect(
      headingAnchors('# Title\n## 10. Separately approved local prototype').has(
        '10-separately-approved-local-prototype',
      ),
    ).toBe(true);
  });
  it('distinguishes definitions from references and detects undefined IDs', () => {
    expect(definitionIds('| FR-01 | Rule |\nAT-01 covers FR-01', 'FR')).toEqual(['FR-01']);
    expect(referenceFindings('test.md', 'FR-01 and FR-02', new Set(['FR-01']))).toEqual([
      { document: 'test.md', message: 'Undefined traceability reference FR-02.' },
    ]);
  });
  it('checks dependency order, status, owner and unique task IDs', () => {
    const rows = Array.from({ length: 29 }, (_, index) => {
      const id = `T${String(index + 1).padStart(2, '0')}`;
      return `| ${id} | P0 | ${index === 0 ? 'Ready' : 'Blocked'} | ${index === 0 ? 'None' : `T${String(index).padStart(2, '0')}`} | Task with exit evidence | Owner |`;
    }).join('\n');
    expect(taskGraphFindings(rows)).toEqual([]);
    expect(
      taskGraphFindings(rows.replace('| T01 | P0 | Ready | None', '| T01 | P0 | Blocked | T02')),
    ).not.toEqual([]);
    expect(taskGraphFindings(rows.replace('| T02 |', '| T01 |'))).not.toEqual([]);
    expect(taskGraphFindings(rows.replace('| Owner |', '| |'))).not.toEqual([]);
  });
});
