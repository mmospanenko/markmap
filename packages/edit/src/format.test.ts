import { buildDocument } from '@markmap/model';
import { describe, expect, it } from 'vitest';
import {
  cleanLabel,
  dedentHeadings,
  dedentList,
  firstLineMarker,
  insertLine,
  listLine,
  placeBlock,
} from './format';

describe('format', () => {
  it('[TC-1-11-1] formats and dedents list content', () => {
    expect(dedentList('    - a\n  note', '    ', '', '\n')).toBe('- a\n  note');
    expect(dedentList('  - a', '  ', '', '\n')).toBe('- a');
    expect(dedentList('- a', '', '', '\n')).toBe('- a');
    expect(listLine('  ', '-', 'one\ntwo', '\n')).toBe('  - one\n    two');
    expect(cleanLabel(' a\r\nb ')).toBe('a\nb');
    expect(firstLineMarker('## A')).toBe(3);
    expect(firstLineMarker('- a')).toBe(2);
    expect(firstLineMarker('text')).toBe(0);
  });

  it('[TC-1-11-2] places blocks with and without line breaks', () => {
    expect(placeBlock('a', '\n', true, false)).toEqual({ insert: 'a', leading: 0 });
    expect(placeBlock('a', '\n', false, true)).toEqual({ insert: '\na\n', leading: 1 });
    expect(placeBlock('a\n', '\n', true, true)).toEqual({ insert: 'a\n', leading: 0 });
  });

  it('[TC-1-11-3] inserts lines at boundaries', () => {
    expect(insertLine('a\n', 2, '- b', '\n')).toEqual({ insert: '- b\n', leading: 0 });
    expect(insertLine('a', 1, '- b', '\n')).toEqual({ insert: '\n- b', leading: 1 });
    expect(insertLine('a\n', 1, '- b', '\n')).toEqual({ insert: '\n- b', leading: 1 });
  });

  it('[TC-1-11-4] dedents headings and rejects an invalid level', () => {
    const doc = buildDocument('# A\n\n## B\n\n### C\n');
    const b = doc.nodes.get(doc.order[1])!;
    const moved = dedentHeadings(doc, b, 1, '\n');
    expect(moved.startsWith('# B')).toBe(true);
    expect(moved).toContain('## C');
    const root = doc.nodes.get(doc.root)!;
    expect(() => dedentHeadings(doc, root, 1, '\n')).toThrowError(/below one/);
  });
});
