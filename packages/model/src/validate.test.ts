import { describe, expect, it } from 'vitest';
import {
  ModelError,
  assertDocument,
  buildDocument,
  indentWidth,
  labelText,
  validateDocument,
  type Document,
  type EditNode,
} from '.';

function find(doc: Document, text: string): EditNode {
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (node && labelText(doc, node) === text) return node;
  }
  throw new Error(`No node ${text}`);
}

function codes(doc: Document): string[] {
  return validateDocument(doc).map((issue) => issue.code);
}

function modelError(fn: () => void): ModelError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ModelError) return error;
    throw error;
  }
  throw new Error('Expected ModelError');
}

describe('validation', () => {
  it('[TC-1-2-10] reports a missing or misplaced root', () => {
    const missing = buildDocument('- a');
    missing.nodes.delete(missing.root);
    expect(codes(missing)).toContain('E_ROOT');

    const kind = buildDocument('- a');
    kind.nodes.get(kind.root)!.kind = 'heading';
    expect(codes(kind)).toContain('E_ROOT');

    const parent = buildDocument('- a');
    parent.nodes.get(parent.root)!.parent = parent.order[1];
    expect(codes(parent)).toContain('E_ROOT');
  });

  it('[TC-1-2-11] reports broken links and order', () => {
    const cycle = buildDocument('- a');
    cycle.nodes.get(cycle.root)!.children.push(cycle.root);
    expect(codes(cycle)).toContain('E_CYCLE');

    const missingChild = buildDocument('- a');
    missingChild.nodes.get(missingChild.root)!.children.push('missing');
    expect(codes(missingChild)).toContain('E_PARENT');

    const missingNode = buildDocument('- a');
    missingNode.order.push('missing');
    expect(codes(missingNode)).toContain('E_PARENT');

    const unreachable = buildDocument('- a');
    unreachable.nodes.set('orphan', { ...unreachable.nodes.get(unreachable.root)! });
    expect(codes(unreachable)).toContain('E_ORDER');

    const duplicate = buildDocument('- a');
    const root = duplicate.nodes.get(duplicate.root)!;
    root.children.push(root.children[0]);
    expect(codes(duplicate)).toContain('E_ORDER');

    const wrongParent = buildDocument('- a\n  - b\n');
    const child = find(wrongParent, 'b');
    child.parent = wrongParent.root;
    expect(codes(wrongParent)).toContain('E_PARENT');

    const unlinked = buildDocument('- a');
    const rootNode = unlinked.nodes.get(unlinked.root)!;
    rootNode.children = [];
    expect(codes(unlinked)).toContain('E_ORDER');
  });

  it('[TC-1-2-12] reports range and label problems', () => {
    const outside = buildDocument('- a');
    find(outside, 'a').block = { start: -1, end: 0 };
    expect(codes(outside)).toContain('E_RANGE');

    const noBlock = buildDocument('- a');
    const node = find(noBlock, 'a');
    node.block = null;
    node.opaque = false;
    expect(codes(noBlock)).toContain('E_RANGE');

    const fraction = buildDocument('- a');
    find(fraction, 'a').block = { start: 0.5, end: 2 };
    expect(codes(fraction)).toContain('E_RANGE');

    const labelOutside = buildDocument('- a');
    find(labelOutside, 'a').label = { start: 0, end: 20 };
    expect(codes(labelOutside)).toContain('E_LABEL');

    const labelBlock = buildDocument('- a');
    find(labelBlock, 'a').block = { start: 0, end: 2 };
    expect(codes(labelBlock)).toContain('E_LABEL');

    const headingNewline = buildDocument('# A\n\n- a\n');
    find(headingNewline, 'A').label = { start: 0, end: 8 };
    expect(codes(headingNewline).length).toBeGreaterThan(0);

    const childOutside = buildDocument('- a\n  - b\n');
    find(childOutside, 'a').block = { start: 0, end: 3 };
    expect(codes(childOutside)).toContain('E_RANGE');

    const parentMissing = buildDocument('- a\n  - b\n');
    find(parentMissing, 'b').parent = 'missing';
    expect(codes(parentMissing)).toContain('E_PARENT');

    const rootless = buildDocument('- a\n  - b\n');
    find(rootless, 'b').parent = null;
    expect(codes(rootless)).toContain('E_PARENT');
  });

  it('[TC-1-2-13] reports kind, level and indent problems', () => {
    const noList = buildDocument('- a');
    find(noList, 'a').list = null;
    expect(codes(noList)).toContain('E_KIND');

    const listOnHeading = buildDocument('# A\n');
    find(listOnHeading, 'A').list = { ordered: false, marker: '-', indent: '', checked: null };
    expect(codes(listOnHeading)).toContain('E_KIND');

    const deep = buildDocument('# A\n\n## B\n');
    find(deep, 'B').level = 1;
    expect(codes(deep)).toContain('E_LEVEL');

    const shallowRoot = buildDocument('# A\n');
    shallowRoot.nodes.get(shallowRoot.root)!.level = 0;
    expect(codes(shallowRoot)).toContain('E_LEVEL');

    const tooDeep = buildDocument('# A\n\n## B\n');
    find(tooDeep, 'B').level = 7;
    expect(codes(tooDeep)).toContain('E_LEVEL');

    const flat = buildDocument('- a\n  - b\n');
    find(flat, 'b').list!.indent = '';
    expect(codes(flat)).toContain('E_INDENT');

    const wrongLevel = buildDocument('- a\n  - b\n');
    find(wrongLevel, 'b').level = 3;
    expect(codes(wrongLevel)).toContain('E_LEVEL');

    const topLevel = buildDocument('- a\n');
    find(topLevel, 'a').level = 2;
    expect(codes(topLevel)).toContain('E_LEVEL');

    const headingUnderList = buildDocument('# A\n\n- x\n\n## B\n');
    const list = find(headingUnderList, 'x');
    const heading = find(headingUnderList, 'B');
    heading.parent = list.id;
    list.children.push(heading.id);
    expect(codes(headingUnderList)).toContain('E_KIND');

    const headingSibling = buildDocument('# A\n\n## B\n\n# C\n');
    find(headingSibling, 'B').level = 1;
    expect(codes(headingSibling)).toContain('E_LEVEL');
  });

  it('[TC-1-2-14] reports a mismatched source slice', () => {
    const heading = buildDocument('# A\n\n## B\n');
    find(heading, 'B').level = 3;
    expect(codes(heading)).toContain('E_SLICE');

    const list = buildDocument('- a\n');
    find(list, 'a').list!.marker = '*';
    expect(codes(list)).toContain('E_SLICE');

    const noMarker = buildDocument('- a\n');
    find(noMarker, 'a').block = { start: 0, end: 3 };
    find(noMarker, 'a').list!.marker = '#';
    expect(codes(noMarker)).toContain('E_SLICE');

    const headingNoMarker = buildDocument('# A\n');
    headingNoMarker.nodes.get(headingNoMarker.root)!.block = { start: 2, end: 3 };
    expect(codes(headingNoMarker)).toContain('E_SLICE');

    const listNoMarker = buildDocument('- a\n');
    find(listNoMarker, 'a').block = { start: 2, end: 3 };
    expect(codes(listNoMarker)).toContain('E_SLICE');
  });

  it('[TC-1-2-15] throws a model error with every issue', () => {
    const doc = buildDocument('- a');
    find(doc, 'a').level = 2;
    expect(() => assertDocument(doc)).toThrowError(ModelError);
    expect(modelError(() => assertDocument(doc)).issues.length).toBeGreaterThan(0);
    expect(() => assertDocument(buildDocument('- a'))).not.toThrow();
  });

  it('[TC-1-2-16] measures indentation with tabs', () => {
    expect(indentWidth('\t')).toBe(4);
    expect(indentWidth(' \t ')).toBe(6);
    expect(indentWidth('x')).toBe(0);
  });
});
