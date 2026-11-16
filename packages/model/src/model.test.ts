import { describe, expect, it } from 'vitest';
import {
  buildDocument,
  contentNodeCount,
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

  it('[TC-1-2-23] keeps an H6 heading extensible through the list fallback', () => {
    const doc = buildDocument('# A\n\n###### F\n');
    const deep = find(doc, 'F');
    expect(deep.level).toBe(6);
    expect(deep.capabilities.addChild).toBe(true);
    expect(deep.capabilities.addSibling).toBe(true);
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

  it('[TC-1-2-10] finds a promoted root at its own label', () => {
    const doc = buildDocument('# A\n');
    const node = nodeAtOffset(doc, doc.source.indexOf('A'));
    expect(node?.kind).toBe('root');
    expect(labelText(doc, node!)).toBe('A');
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

  it('[TC-1-14-3] keeps an empty ATX source root editable', () => {
    const doc = buildDocument('##');
    const root = doc.nodes.get(doc.root)!;
    expect(root.kind).toBe('root');
    expect(root.level).toBe(2);
    expect(root.label).toEqual({ start: 2, end: 2 });
    expect(root.opaque).toBe(false);
    expect(root.capabilities.editLabel).toBe(true);
    expect(labelText(doc, root)).toBe('');
  });

  it('[TC-1-14-6] keeps BOM block and note ranges in the model', () => {
    const input = '\uFEFF# A\n\nNote.\n';
    const doc = buildDocument(input);
    const root = doc.nodes.get(doc.root)!;
    expect(root.block).toEqual({ start: 1, end: input.length });
    expect(root.notes).toHaveLength(1);
    const range = root.notes[0]?.range;
    if (!range) throw new Error('No note range');
    expect(doc.source.slice(range.start, range.end)).toBe('Note.');
    expect(labelText(doc, root)).toBe('A');
  });

  it('[TC-1-15-1] classifies root sources and creation eligibility', () => {
    const sourceHeading = buildDocument('# A\n');
    expect(sourceHeading.rootPolicy).toEqual({
      kind: 'source-heading',
      hasTitle: false,
      bodyStart: 0,
      hasHeadingChild: false,
      canCreateHeading: false,
    });

    const title = buildDocument('---\ntitle: T\n---\n\n- a\n');
    expect(title.rootPolicy.kind).toBe('title');
    expect(title.rootPolicy.hasTitle).toBe(true);
    expect(title.rootPolicy.hasHeadingChild).toBe(false);
    expect(title.rootPolicy.canCreateHeading).toBe(true);

    const synthetic = buildDocument('- a\n');
    expect(synthetic.rootPolicy.kind).toBe('synthetic');
    expect(synthetic.rootPolicy.hasTitle).toBe(false);
    expect(synthetic.rootPolicy.canCreateHeading).toBe(true);

    const h1 = buildDocument('# A\n# B\n');
    expect(h1.rootPolicy.kind).toBe('synthetic');
    expect(h1.rootPolicy.canCreateHeading).toBe(false);

    const front = buildDocument('---\nfoo: 1\n---\n# A\n');
    expect(front.rootPolicy.kind).toBe('source-heading');
    expect(front.rootPolicy.bodyStart).toBe(front.source.indexOf('# A'));

    const empty = buildDocument('');
    expect(empty.rootPolicy.canCreateHeading).toBe(true);
    expect(empty.rootPolicy.bodyStart).toBe(0);

    const root = front.nodes.get(front.root)!;
    for (const capability of ['addSibling', 'outdent', 'delete', 'move'] as const) {
      expect(root.capabilities[capability]).toBe(false);
    }
  });

  it('[TC-1-15-2] keeps a Setext root label-editable and structurally opaque', () => {
    const doc = buildDocument('Title\n=====\n');
    const root = doc.nodes.get(doc.root)!;
    expect(doc.rootPolicy.kind).toBe('source-heading');
    expect(root.level).toBe(1);
    expect(root.opaque).toBe(true);
    expect(root.capabilities.editLabel).toBe(true);
    expect(root.capabilities.addChild).toBe(false);
    expect(root.capabilities.delete).toBe(false);
  });

  it('[TC-1-15-16] classifies title roots and their heading eligibility', () => {
    for (const marker of ['#', '##', '######']) {
      const single = buildDocument(`---\ntitle: T\n---\n\n${marker} A\n`);
      expect(single.rootPolicy.kind).toBe('source-heading');
      expect(single.rootPolicy.hasTitle).toBe(true);
      expect(single.rootPolicy.canCreateHeading).toBe(false);
      expect(labelText(single, single.nodes.get(single.root)!)).toBe('A');
    }

    const list = buildDocument('---\ntitle: T\n---\n\n- a\n');
    expect(list.rootPolicy.kind).toBe('title');
    expect(list.rootPolicy.hasHeadingChild).toBe(false);
    expect(list.rootPolicy.canCreateHeading).toBe(true);

    const two = buildDocument('---\ntitle: T\n---\n\n## A\n\n## B\n');
    expect(two.rootPolicy.kind).toBe('title');
    expect(two.rootPolicy.hasHeadingChild).toBe(true);
    expect(two.rootPolicy.canCreateHeading).toBe(false);

    const empty = buildDocument('---\ntitle: T\n---\n');
    expect(empty.rootPolicy.kind).toBe('title');
    expect(empty.rootPolicy.hasHeadingChild).toBe(false);
    expect(empty.rootPolicy.canCreateHeading).toBe(true);
  });

  it('[TC-1-16-1] counts content nodes without a synthetic or title root', () => {
    expect(contentNodeCount(buildDocument('## A\n'))).toBe(1);
    expect(contentNodeCount(buildDocument('## A\n## B\n'))).toBe(2);
    expect(contentNodeCount(buildDocument('---\ntitle: T\n---\n\n- a\n'))).toBe(1);
    expect(contentNodeCount(buildDocument(''))).toBe(0);
  });

  it('[TC-1-2-9] returns the render tree with the document', () => {
    const { document, tree, frontmatter } = parseDocument('---\ntitle: T\n---\n\n- a\n');
    expect(frontmatter).toEqual({ title: 'T' });
    expect(tree.id).toBe(document.root);
    expect(tree.children[0]?.id).toBe(document.order[1]);
  });
});
