import type { MarkmapNode } from '@markmap/core';
import { describe, expect, it } from 'vitest';
import { buildFromTree, indentColumns, parseDocument } from '.';

function node(overrides: Partial<MarkmapNode>): MarkmapNode {
  return {
    id: '',
    type: 'custom',
    content: [],
    notes: [],
    data: {},
    children: [],
    ...overrides,
  };
}

function tree(children: MarkmapNode[]): MarkmapNode {
  return {
    id: 'root',
    type: 'root',
    content: [],
    notes: [],
    data: {},
    children,
  };
}

const meta = { hasTitle: false, bodyStart: 0 };

describe('custom trees', () => {
  it('[TC-1-2-17] marks an unknown node type opaque', () => {
    const doc = buildFromTree(
      '# A',
      tree([node({ id: 'x', source: { block: { start: 0, end: 3 } } })]),
      meta,
    );
    const custom = doc.nodes.get('x')!;
    expect(custom.kind).toBe('opaque');
    expect(custom.opaque).toBe(true);
    expect(custom.capabilities.delete).toBe(true);
    expect(custom.capabilities.move).toBe(true);
  });

  it('[TC-1-2-18] falls back for a list item without a marker', () => {
    const doc = buildFromTree(
      '# A',
      tree([
        node({
          id: 'x',
          type: 'listItem',
          data: { ordered: true, checked: true },
          source: { block: { start: 0, end: 3 } },
        }),
      ]),
      meta,
    );
    const item = doc.nodes.get('x')!;
    expect(item.kind).toBe('listItem');
    expect(item.opaque).toBe(true);
    expect(item.list).toEqual({ ordered: true, marker: '-', indent: '', checked: true });
  });

  it('[TC-1-2-19] falls back for a heading without a marker or source', () => {
    const wrong = buildFromTree(
      '- a',
      tree([node({ id: 'x', type: 'heading', source: { block: { start: 0, end: 3 } } })]),
      meta,
    );
    expect(wrong.nodes.get('x')!.opaque).toBe(true);

    const missing = buildFromTree('- a', tree([node({ id: 'x', type: 'heading' })]), meta);
    expect(missing.nodes.get('x')!.opaque).toBe(true);
  });

  it('[TC-1-2-20] marks a heading deeper than six opaque', () => {
    const doc = buildFromTree(
      '# A',
      tree([node({ id: 'x', type: 'heading', data: { depth: 7 } })]),
      meta,
    );
    expect(doc.nodes.get('x')!.level).toBe(7);
    expect(doc.nodes.get('x')!.opaque).toBe(true);
  });

  it('[TC-1-2-21] falls back to two spaces for equal indents', () => {
    const doc = buildFromTree(
      '- a\n- b\n',
      tree([
        node({
          id: 'a',
          type: 'listItem',
          source: { block: { start: 0, end: 3 } },
          children: [
            node({
              id: 'b',
              type: 'listItem',
              source: { block: { start: 4, end: 7 } },
            }),
          ],
        }),
      ]),
      meta,
    );
    expect(doc.unit).toBe('  ');
    expect(indentColumns(doc.nodes.get(doc.root)!)).toBe(0);
  });

  it('records frontmatterRange in parseDocument', () => {
    const { document: docWithFm } = parseDocument('---\ntitle: Sample\n---\n# Root\n');
    expect(docWithFm.frontmatterRange).toEqual({ start: 0, end: 21 });
    const { document: docNoFm } = parseDocument('# Root\n');
    expect(docNoFm.frontmatterRange).toBeNull();
  });
});
