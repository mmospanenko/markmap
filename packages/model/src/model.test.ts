import { describe, expect, it } from 'vitest';
import {
  buildDocument,
  indentColumns,
  labelText,
  nodeAtOffset,
  parseDocument,
  validateDocument,
} from '.';
import type { Document, EditNode } from '.';

function find(doc: Document, text: string): EditNode {
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (node && labelText(doc, node) === text) return node;
  }
  throw new Error(`No node labelled ${text}`);
}

const sample = '# A\n\n## B\n\n- x\n  - y\n\n# C\n';

describe('model', () => {
  it('[TC-1-2-1] builds kinds, levels, labels and blocks', () => {
    const doc = buildDocument(sample);
    const root = doc.nodes.get(doc.root)!;
    const a = find(doc, 'A');
    const b = find(doc, 'B');
    const x = find(doc, 'x');
    const y = find(doc, 'y');
    expect(root.kind).toBe('root');
    expect(doc.order).toHaveLength(6);
    expect(a.kind).toBe('heading');
    expect(a.level).toBe(1);
    expect(a.parent).toBe(doc.root);
    expect(a.capabilities.addSibling).toBe(true);
    expect(a.capabilities.outdent).toBe(false);
    expect(b.level).toBe(2);
    expect(b.capabilities.outdent).toBe(true);
    expect(x.kind).toBe('listItem');
    expect(x.level).toBe(1);
    expect(x.list).toEqual({ ordered: false, marker: '-', indent: '', checked: null });
    expect(x.capabilities.outdent).toBe(false);
    expect(y.level).toBe(2);
    expect(y.list?.indent).toBe('  ');
    expect(y.capabilities.outdent).toBe(true);
    expect(doc.unit).toBe('  ');
  });

  it('[TC-1-2-2] promotes a single H1 to an editable root', () => {
    const doc = buildDocument('# A\n\n- x\n');
    const root = doc.nodes.get(doc.root)!;
    expect(root.kind).toBe('root');
    expect(root.level).toBe(1);
    expect(labelText(doc, root)).toBe('A');
    expect(root.block).toEqual({ start: 0, end: 9 });
    expect(root.capabilities.editLabel).toBe(true);
    expect(root.capabilities.addChild).toBe(true);
    expect(root.capabilities.addSibling).toBe(false);
    expect(root.capabilities.delete).toBe(false);
  });

  it('[TC-1-2-3] detects a four-space indent unit and tabs', () => {
    const spaced = buildDocument('- a\n    - b\n');
    expect(spaced.unit).toBe('    ');
    expect(indentColumns(find(spaced, 'b'))).toBe(4);
    const tabbed = buildDocument('- a\n\t- b\n');
    expect(tabbed.unit).toBe('\t');
  });

  it('[TC-1-2-4] marks a list item with a heading label opaque', () => {
    const doc = buildDocument('- # T\n- plain\n');
    const headingItem = find(doc, 'T');
    expect(headingItem.kind).toBe('listItem');
    expect(headingItem.opaque).toBe(true);
    expect(headingItem.capabilities.editLabel).toBe(false);
    expect(headingItem.capabilities.addChild).toBe(false);
    expect(headingItem.capabilities.delete).toBe(true);
  });

  it('[TC-1-2-5] gives an empty label a point range', () => {
    const doc = buildDocument('- \n- b\n');
    const first = doc.nodes.get(doc.order[1])!;
    expect(first.label).toEqual({ start: 2, end: 2 });
    expect(labelText(doc, first)).toBe('');
  });

  it('[TC-1-2-6] finds the deepest node at an offset', () => {
    const doc = buildDocument(sample);
    const offset = sample.indexOf('y');
    expect(labelText(doc, nodeAtOffset(doc, offset)!)).toBe('y');
    expect(labelText(doc, nodeAtOffset(doc, sample.indexOf('B'))!)).toBe('B');
  });

  it('[TC-1-2-7] accepts a valid document', () => {
    expect(validateDocument(buildDocument(sample))).toEqual([]);
  });

  it('[TC-1-2-8] reports structural issues', () => {
    const root = buildDocument(sample);
    root.nodes.get(root.root)!.kind = 'heading';
    expect(validateDocument(root).map((issue) => issue.code)).toContain('E_ROOT');

    const level = buildDocument(sample);
    find(level, 'B').level = 7;
    expect(validateDocument(level).map((issue) => issue.code)).toContain('E_LEVEL');

    const range = buildDocument(sample);
    find(range, 'B').block = { start: -1, end: 0 };
    expect(validateDocument(range).map((issue) => issue.code)).toContain('E_RANGE');

    const label = buildDocument(sample);
    find(label, 'B').label = { start: 0, end: 1 };
    expect(validateDocument(label).map((issue) => issue.code)).toContain('E_LABEL');

    const order = buildDocument(sample);
    order.order.reverse();
    expect(validateDocument(order).map((issue) => issue.code)).toContain('E_ORDER');

    const indent = buildDocument('- a\n  - b\n');
    indent.nodes.get(find(indent, 'b').id)!.list!.indent = '';
    expect(validateDocument(indent).map((issue) => issue.code)).toContain('E_INDENT');

    const nesting = buildDocument('# A\n\n## B\n');
    find(nesting, 'B').level = 1;
    expect(validateDocument(nesting).map((issue) => issue.code)).toContain('E_LEVEL');
  });

  it('[TC-1-2-9] returns the render tree with the document', () => {
    const { document, tree, frontmatter } = parseDocument('---\ntitle: T\n---\n\n- a\n');
    expect(frontmatter).toEqual({ title: 'T' });
    expect(tree.id).toBe(document.root);
    expect(tree.children[0]?.id).toBe(document.order[1]);
  });
});
