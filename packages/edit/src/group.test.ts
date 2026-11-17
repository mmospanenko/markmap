import {
  buildDocument,
  contentNodeCount,
  labelText,
  type Document,
  type EditNode,
} from '@markmap/model';
import { describe, expect, it } from 'vitest';
import { applyCommand, EditError, type EditResult } from '.';

function find(doc: Document, text: string): EditNode {
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (node && labelText(doc, node) === text) return node;
  }
  throw new Error(`No node labelled ${text}`);
}

function labelAt(result: EditResult): string {
  for (const id of result.document.order) {
    const node = result.document.nodes.get(id);
    if (node?.label?.start === result.selection) return labelText(result.document, node);
  }
  throw new Error(`No node at offset ${result.selection}`);
}

function editError(run: () => unknown): EditError {
  try {
    run();
  } catch (error) {
    if (error instanceof EditError) return error;
    throw error;
  }
  throw new Error('Expected an EditError');
}

function deleteNodes(doc: Document, labels: string[]): EditResult {
  return applyCommand(doc, {
    type: 'deleteNodes',
    nodes: labels.map((label) => find(doc, label).id),
  });
}

function moveNodes(
  doc: Document,
  labels: string[],
  parentLabel: string,
  index: number,
): EditResult {
  const parent = parentLabel === '#root' ? doc.nodes.get(doc.root) : find(doc, parentLabel);
  if (!parent) throw new Error('No parent');
  return applyCommand(doc, {
    type: 'moveNodes',
    nodes: labels.map((label) => find(doc, label).id),
    parent: parent.id,
    index,
  });
}

describe('sibling group commands', () => {
  it('[TC-1-18-1] deletes non-contiguous siblings with descendants and notes', () => {
    const input = '- a\n  - a1\n\n  ```markmap-note\n  note a\n  ```\n- b\n- c\n  - c1\n- d\n';
    const doc = buildDocument(input);
    const result = deleteNodes(doc, ['a', 'c']);
    expect(result.document.source).toBe('- b\n- d\n');
    expect(contentNodeCount(result.document)).toBe(contentNodeCount(doc) - 4);
    expect(doc.source).toBe(input);
  });

  it('[TC-1-18-2] selects the previous sibling or the parent after a batch delete', () => {
    const siblings = deleteNodes(buildDocument('- a\n- b\n- c\n- d\n'), ['b', 'c']);
    expect(siblings.document.source).toBe('- a\n- d\n');
    expect(labelAt(siblings)).toBe('a');

    const parent = deleteNodes(buildDocument('- p\n  - a\n  - b\n- other\n'), ['a', 'b']);
    expect(parent.document.source).toBe('- p\n- other\n');
    expect(labelAt(parent)).toBe('p');
  });

  it('[TC-1-18-3] rejects a mixed-parent or opaque batch delete without changing the input', () => {
    const mixed = buildDocument('- p\n  - a\n- b\n');
    const mixedSource = mixed.source;
    expect(
      editError(() =>
        applyCommand(mixed, {
          type: 'deleteNodes',
          nodes: [find(mixed, 'a').id, find(mixed, 'b').id],
        }),
      ).code,
    ).toBe('E_SHAPE');
    expect(mixed.source).toBe(mixedSource);

    const opaque = buildDocument('- p\n  - x\n- # T\n- b\n');
    const opaqueSource = opaque.source;
    expect(
      editError(() =>
        applyCommand(opaque, {
          type: 'deleteNodes',
          nodes: [find(opaque, 'T').id, find(opaque, 'b').id],
        }),
      ).code,
    ).toBe('E_CAPABILITY');
    expect(opaque.source).toBe(opaqueSource);
  });

  it('[TC-1-18-4] rejects an empty, duplicate or root batch delete', () => {
    const doc = buildDocument('- a\n- b\n');
    expect(editError(() => applyCommand(doc, { type: 'deleteNodes', nodes: [] })).code).toBe(
      'E_SHAPE',
    );
    expect(
      editError(() =>
        applyCommand(doc, { type: 'deleteNodes', nodes: [find(doc, 'a').id, find(doc, 'a').id] }),
      ).code,
    ).toBe('E_SHAPE');
    expect(
      editError(() => applyCommand(doc, { type: 'deleteNodes', nodes: [doc.root] })).code,
    ).toBe('E_CAPABILITY');
    expect(
      editError(() =>
        applyCommand(doc, { type: 'deleteNodes', nodes: [find(doc, 'a').id, doc.root] }),
      ).code,
    ).toBe('E_CAPABILITY');
    expect(doc.source).toBe('- a\n- b\n');
  });

  it('[TC-1-18-5] selects a surviving sibling when the root has no label', () => {
    const sibling = deleteNodes(buildDocument('- a\n- b\n- c\n'), ['a']);
    expect(sibling.document.source).toBe('- b\n- c\n');
    expect(labelAt(sibling)).toBe('b');

    const empty = deleteNodes(buildDocument('- a\n'), ['a']);
    expect(empty.document.source).toBe('');
    expect(empty.selection).toBe(0);
  });

  it('[TC-1-18-6] rejects a delete that leaves a removed id in the result', () => {
    const doc = buildDocument('- a\n- a\n');
    expect(
      editError(() => applyCommand(doc, { type: 'deleteNodes', nodes: [find(doc, 'a').id] })).code,
    ).toBe('E_SHAPE');
    expect(doc.source).toBe('- a\n- a\n');
  });

  it('[TC-1-19-1] moves non-contiguous siblings as one contiguous block', () => {
    const input = '- p\n  - x\n- a\n  - a1\n- b\n- c\n  - c1\n- d\n';
    const doc = buildDocument(input);
    const result = moveNodes(doc, ['a', 'c'], 'x', 0);
    expect(result.document.source).toBe(
      '- p\n  - x\n    - a\n      - a1\n    - c\n      - c1\n- b\n- d\n',
    );
    expect(labelAt(result)).toBe('a');
    expect(contentNodeCount(result.document)).toBe(contentNodeCount(doc));
    expect(doc.source).toBe(input);
  });

  it('[TC-1-19-2] rejects a mixed-parent, cycle or opaque batch move without changing the input', () => {
    const mixed = buildDocument('- p\n  - a\n    - a1\n- b\n');
    const mixedSource = mixed.source;
    expect(editError(() => moveNodes(mixed, ['a', 'a1'], 'b', 0)).code).toBe('E_SHAPE');
    expect(mixed.source).toBe(mixedSource);

    const cycle = buildDocument('- p\n  - x\n- a\n  - a1\n- c\n');
    const cycleSource = cycle.source;
    expect(editError(() => moveNodes(cycle, ['a', 'c'], 'a1', 0)).code).toBe('E_CYCLE');
    expect(cycle.source).toBe(cycleSource);

    const opaque = buildDocument('- p\n  - x\n- # T\n- b\n');
    const opaqueSource = opaque.source;
    expect(editError(() => moveNodes(opaque, ['T', 'b'], 'x', 0)).code).toBe('E_CAPABILITY');
    expect(opaque.source).toBe(opaqueSource);
  });

  it('[TC-1-19-3] moves heading siblings as one block with re-leveled descendants', () => {
    const input = '# A\n\n## B\n\n### B1\n\n## C\n\n## D\n';
    const result = moveNodes(buildDocument(input), ['B', 'D'], 'C', 0);
    expect(result.document.source).toBe('# A\n\n## C\n\n### B\n\n#### B1\n\n### D\n');
    expect(labelAt(result)).toBe('B');
    expect(contentNodeCount(result.document)).toBe(contentNodeCount(buildDocument(input)));
    const afterList = moveNodes(
      buildDocument('# A\n\n## C\n- z\n\n## B\n\n## D\n'),
      ['B', 'D'],
      'C',
      1,
    );
    expect(afterList.document.source).toBe('# A\n\n## C\n- z\n\n### B\n\n### D\n');
  });

  it('[TC-1-19-4] moves heading siblings under a list item', () => {
    const input = '# A\n\n- x\n\n## B\n\n### B1\n\n- y\n\n## C\n';
    const result = moveNodes(buildDocument(input), ['B', 'C'], 'x', 0);
    expect(result.document.source).toBe('# A\n\n- x\n  - B\n\n    - B1\n\n      - y\n  - C\n');
    expect(labelAt(result)).toBe('B');
  });

  it('[TC-1-19-5] turns a list set into headings after a heading and keeps it a list before one', () => {
    const input = '# A\n\n## B\n\n- x\n- y\n';
    const after = moveNodes(buildDocument(input), ['x', 'y'], '#root', 1);
    expect(after.document.source).toBe('# A\n\n## B\n\n## x\n\n## y\n');
    const before = moveNodes(buildDocument(input), ['x', 'y'], '#root', 0);
    expect(before.document.source).toBe('# A\n\n- x\n- y\n\n## B\n\n');
  });

  it('[TC-1-19-6] reorders a non-contiguous set and leaves its current position untouched', () => {
    const reordered = moveNodes(buildDocument('- a\n- b\n- c\n- d\n'), ['a', 'c'], '#root', 1);
    expect(reordered.document.source).toBe('- b\n- a\n- c\n- d\n');
    expect(labelAt(reordered)).toBe('a');
    const unchanged = moveNodes(buildDocument('- a\n- b\n- c\n'), ['a', 'b'], '#root', 0);
    expect(unchanged.edits).toEqual([]);
    expect(unchanged.document.source).toBe('- a\n- b\n- c\n');
    expect(labelAt(unchanged)).toBe('a');
    const all = moveNodes(buildDocument('- a\n- b\n'), ['a', 'b'], '#root', 0);
    expect(all.edits).toEqual([]);
    expect(all.document.source).toBe('- a\n- b\n');
  });

  it('[TC-1-19-7] rejects an empty, duplicate, root, opaque-target or impossible set', () => {
    const doc = buildDocument('- a\n- b\n- # T\n');
    expect(editError(() => moveNodes(doc, [], 'a', 0)).code).toBe('E_SHAPE');
    expect(editError(() => moveNodes(doc, ['a', 'a'], 'b', 0)).code).toBe('E_SHAPE');
    expect(
      editError(() =>
        applyCommand(doc, {
          type: 'moveNodes',
          nodes: [doc.root],
          parent: find(doc, 'a').id,
          index: 0,
        }),
      ).code,
    ).toBe('E_CAPABILITY');
    expect(editError(() => moveNodes(doc, ['a', 'b'], 'T', 0)).code).toBe('E_CAPABILITY');
    expect(editError(() => moveNodes(doc, ['a', 'b'], '#root', -1)).code).toBe('E_SHAPE');
    expect(editError(() => moveNodes(doc, ['a', 'b'], '#root', 0.5)).code).toBe('E_SHAPE');
    expect(editError(() => moveNodes(doc, ['a', 'b'], '#root', 2)).code).toBe('E_SHAPE');
    const deep = buildDocument('# A\n\n## B\n\n## D\n\n###### E\n\n## F\n');
    const deepSource = deep.source;
    expect(editError(() => moveNodes(deep, ['B', 'F'], 'E', 0)).code).toBe('E_LEVEL');
    expect(deep.source).toBe(deepSource);
    const multiline = buildDocument('# A\n\n## B\n\n- [x] one\n  two\n- z\n\n## C\n');
    expect(editError(() => moveNodes(multiline, ['one\n  two', 'z'], '#root', 1)).code).toBe(
      'E_LABEL',
    );
  });

  it('[TC-1-19-8] keeps a mixed list and heading set in source order', () => {
    const input = '# A\n\n- x\n\n## B\n\n## C\n';
    const result = moveNodes(buildDocument(input), ['x', 'B'], 'C', 0);
    expect(result.document.source).toBe('# A\n\n## C\n- x\n\n### B\n');
    expect(labelAt(result)).toBe('x');
  });

  it('[TC-1-19-9] preserves CRLF and a source without a trailing newline', () => {
    const crlf = moveNodes(buildDocument('- a\r\n- b\r\n- c\r\n'), ['a', 'c'], 'b', 0);
    expect(crlf.document.source).toBe('- b\r\n  - a\r\n  - c\r\n');
    const noTrailing = moveNodes(buildDocument('- a\n- b\n- c'), ['a', 'c'], 'b', 0);
    expect(noTrailing.document.source).toBe('- b\n  - a\n  - c\n');
    expect(deleteNodes(buildDocument('- a\r\n- b\r\n- c\r\n'), ['a', 'c']).document.source).toBe(
      '- b\r\n',
    );
  });

  it('[TC-1-19-10] keeps notes, markers, continuation lines and document order', () => {
    const input =
      '- p\n- [ ] a\n  first line\n  second line\n\n  ```markmap-note\n  note a\n  ```\n- [x] c\n  c line\n- b\n';
    const result = moveNodes(
      buildDocument(input),
      ['c\n  c line', 'a\n  first line\n  second line'],
      'p',
      0,
    );
    expect(result.document.source).toBe(
      '- p\n  - [ ] a\n    first line\n    second line\n\n    ```markmap-note\n    note a\n    ```\n  - [x] c\n    c line\n- b\n',
    );
    expect(labelAt(result)).toBe('a\n    first line\n    second line');
    expect(contentNodeCount(result.document)).toBe(contentNodeCount(buildDocument(input)));
  });

  it('[TC-1-19-11] rejects a move when reparsing changes the node count', () => {
    const doc = buildDocument('- a\n- b\n');
    const stale: Document = { ...doc, source: '- a\n- b\n- c\n' };
    expect(
      editError(() =>
        applyCommand(stale, {
          type: 'moveNodes',
          nodes: [find(doc, 'a').id],
          parent: find(doc, 'b').id,
          index: 0,
        }),
      ).code,
    ).toBe('E_SHAPE');
  });

  it('[TC-1-19-12] nests a batch move under an ordered list item with a marker-width indent', () => {
    const result = moveNodes(buildDocument('1. p\n- a\n- b\n'), ['a', 'b'], 'p', 0);
    const parent = find(result.document, 'p');
    expect(result.document.source).toBe('1. p\n   - a\n   - b\n');
    expect(find(result.document, 'a').parent).toBe(parent.id);
    expect(find(result.document, 'b').parent).toBe(parent.id);
    expect(labelAt(result)).toBe('a');
  });

  it('[TC-1-19-13] keeps a tab-indented existing child under its parent in a batch move', () => {
    const result = moveNodes(buildDocument('- p\n\t- x\n- a\n- b\n'), ['a', 'b'], 'p', 0);
    const parent = find(result.document, 'p');
    expect(result.document.source).toBe('- p\n\t- a\n\t- b\n\t- x\n');
    expect(find(result.document, 'a').parent).toBe(parent.id);
    expect(find(result.document, 'b').parent).toBe(parent.id);
    expect(find(result.document, 'x').parent).toBe(parent.id);
    expect(labelAt(result)).toBe('a');
  });
});
