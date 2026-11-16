import { buildDocument, labelText, type Document, type EditNode } from '@markmap/model';
import { describe, expect, it } from 'vitest';
import { applyCommand, EditError, type EditResult } from '.';
import { listToHeadings } from './format';

function find(doc: Document, text: string): EditNode {
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (node && labelText(doc, node) === text) return node;
  }
  const available = doc.order.map((id) => {
    const node = doc.nodes.get(id);
    return node ? labelText(doc, node) : '';
  });
  throw new Error(`No node labelled ${text} in ${JSON.stringify(available)}`);
}

function move(input: string, label: string, parentLabel: string, index: number): EditResult {
  const doc = buildDocument(input);
  const node = label === '#root' ? doc.nodes.get(doc.root) : find(doc, label);
  const parent = parentLabel === '#root' ? doc.nodes.get(doc.root) : find(doc, parentLabel);
  if (!node) throw new Error('No node');
  if (!parent) throw new Error('No root');
  return applyCommand(doc, { type: 'move', node: node.id, parent: parent.id, index });
}

function labels(result: EditResult): string[] {
  return result.document.order.map((id) => {
    const node = result.document.nodes.get(id);
    return node ? labelText(result.document, node) : '';
  });
}

function editError(fn: () => unknown): EditError {
  try {
    fn();
  } catch (error) {
    if (error instanceof EditError) return error;
    throw error;
  }
  throw new Error('Expected an EditError');
}

describe('move', () => {
  it('[TC-1-13-1] reorders list siblings', () => {
    const input = '- a\n- b\n- c\n';
    expect(move(input, 'a', '#root', 2).document.source).toBe('- b\n- c\n- a\n');
    expect(move(input, 'c', '#root', 0).document.source).toBe('- c\n- a\n- b\n');
    expect(move(input, 'b', '#root', 1).document.source).toBe(input);
  });

  it('[TC-1-13-2] moves a list subtree under another list item', () => {
    const input = '- a\n- b\n  - b1\n';
    const result = move(input, 'a', 'b', 1);
    expect(result.document.source).toBe('- b\n  - b1\n  - a\n');
    expect(labels(result)).toEqual(['', 'b', 'b1', 'a']);
  });

  it('[TC-1-13-3] moves a heading subtree under another heading', () => {
    const input = '# A\n\n## B\n\n### C\n\n## D\n';
    const result = move(input, 'B', 'D', 0);
    expect(result.document.source).toBe('# A\n\n## D\n\n### B\n\n#### C\n');
    expect(labels(result)).toEqual(['A', 'D', 'B', 'C']);
  });

  it('[TC-1-13-4] moves a heading subtree under a list item', () => {
    const input = '# A\n\n- x\n\n## B\n\n### C\n';
    const result = move(input, 'B', 'x', 0);
    expect(result.document.source).toBe('# A\n\n- x\n  - B\n\n    - C\n');
    expect(labels(result)).toEqual(['A', 'x', 'B', 'C']);
  });

  it('[TC-1-13-5] turns a list item into headings after a heading sibling', () => {
    const input = '# A\n\n## B\n\n- x\n\n## C\n';
    const result = move(input, 'x', 'A', 1);
    expect(result.document.source).toBe('# A\n\n## B\n\n## x\n\n## C\n');
    expect(labels(result)).toEqual(['A', 'B', 'x', 'C']);
  });

  it('[TC-1-13-6] keeps a list item under a heading before a heading child', () => {
    const input = '# A\n\n## B\n\n- x\n\n## C\n';
    const result = move(input, 'x', 'C', 0);
    expect(result.document.source).toBe('# A\n\n## B\n\n## C\n- x\n');
    expect(labels(result)).toEqual(['A', 'B', 'C', 'x']);
  });

  it('[TC-1-13-7] preserves notes and frontmatter', () => {
    const input =
      '---\ntitle: Plan\n---\n# A\n\n- a\n\n  ```markmap-note\n  note a\n  ```\n\n- b\n';
    const result = move(input, 'a', 'b', 0);
    expect(result.document.source).toBe(
      '---\ntitle: Plan\n---\n# A\n\n- b\n  - a\n\n    ```markmap-note\n    note a\n    ```\n',
    );
  });

  it('[TC-1-13-8] moves a top-level block under a title root', () => {
    const input = '---\ntitle: Plan\n---\n## A\n\n- x\n\n## B\n';
    const result = move(input, 'x', '#root', 2);
    expect(result.document.source).toBe('---\ntitle: Plan\n---\n## A\n\n## B\n\n# x\n');
    expect(labels(result)).toEqual(['', 'A', 'B', 'x']);
  });

  it('[TC-1-13-9] rejects a root, a cycle, an opaque node and an invalid index', () => {
    const cycle = editError(() => move('- a\n  - b\n', 'a', 'b', 0));
    expect(cycle.code).toBe('E_CYCLE');
    const root = editError(() => move('- a\n', '#root', 'a', 0));
    expect(root.code).toBe('E_CAPABILITY');
    const opaque = editError(() => move('- # T\n- plain\n', 'T', 'plain', 0));
    expect(opaque.code).toBe('E_CAPABILITY');
    const index = editError(() => move('- a\n- b\n', 'a', '#root', 3));
    expect(index.code).toBe('E_SHAPE');
    expect(editError(() => move('- a\n- b\n', 'a', '#root', -1)).code).toBe('E_SHAPE');
    expect(editError(() => move('- a\n- b\n', 'a', '#root', 0.5)).code).toBe('E_SHAPE');
  });

  it('[TC-1-13-10] selects the moved label', () => {
    const result = move('- a\n- b\n', 'a', 'b', 0);
    expect(result.selection).toBe(result.document.source.indexOf('a\n'));
  });

  it('[TC-1-13-11] preserves CRLF and a file without a trailing newline', () => {
    const result = move('- a\r\n- b\r\n', 'a', 'b', 0);
    expect(result.document.source).toBe('- b\r\n  - a\r\n');
    const last = move('- a\n- b', 'a', 'b', 0);
    expect(last.document.source).toBe('- b\n  - a\n');
  });

  it('[TC-1-13-12] rejects a heading level beyond six', () => {
    const input = '# A\n\n## B\n\n### C\n\n## D\n\n##### E\n';
    const error = editError(() => move(input, 'B', 'E', 0));
    expect(error.code).toBe('E_LEVEL');
  });

  it('[TC-1-13-13] moves a list item between existing list siblings under a heading', () => {
    const input = '# A\n\n## B\n\n- x\n- y\n\n## C\n\n- z\n';
    const result = move(input, 'z', 'B', 1);
    expect(result.document.source).toBe('# A\n\n## B\n\n- x\n- z\n- y\n\n## C\n');
    expect(labels(result)).toEqual(['A', 'B', 'x', 'z', 'y', 'C']);
  });

  it('[TC-1-13-14] keeps a multi-line label in a list and rejects it in a heading', () => {
    const input = '# A\n\n## B\n\n- [x] one\n  two\n\n## C\n';
    const list = move(input, 'one\n  two', 'C', 0);
    expect(list.document.source).toBe('# A\n\n## B\n\n## C\n- [x] one\n  two\n');
    const heading = editError(() => move(input, 'one\n  two', 'A', 1));
    expect(heading.code).toBe('E_LABEL');
    const checked = move('# A\n\n## B\n\n- [x] one\n\n## C\n', 'one', 'A', 1);
    expect(checked.document.source).toBe('# A\n\n## B\n\n## one\n\n## C\n');
  });

  it('[TC-1-13-15] rejects an opaque target and a heading that cannot hold a child', () => {
    const opaque = editError(() => move('- a\n\n- # T\n', 'a', 'T', 0));
    expect(opaque.code).toBe('E_CAPABILITY');
    const deep = editError(() => move('# A\n\n###### B\n\n## C\n', 'C', 'B', 0));
    expect(deep.code).toBe('E_CAPABILITY');
  });

  it('[TC-1-13-16] converts several top-level list items and rejects other text', () => {
    expect(listToHeadings('- a\n- b\n', 2, '\n')).toBe('## a\n## b\n');
    expect(listToHeadings('- a\n  - b\n', 2, '\n')).toBe('## a\n### b\n');
    expect(listToHeadings('- a\n  continued\n', 2, '\n')).toBe('## a\ncontinued\n');
    expect(listToHeadings('- a\n\n  ```\n  x\n  ```\n', 2, '\n')).toBe('## a\n\n```\nx\n```\n');
    expect(() => listToHeadings('## A\n', 2, '\n')).toThrowError(/not a list/u);
    expect(() => listToHeadings('', 2, '\n')).toThrowError(/not a list/u);
    expect(() => listToHeadings('- a\n  - b\n', 6, '\n')).toThrowError(/exceed six/u);
  });

  it('[TC-1-13-17] moves a heading with a note and CRLF', () => {
    const input = '# A\r\n\r\n## B\r\n\r\n```markmap-note\r\nnote b\r\n```\r\n\r\n## C\r\n';
    const result = move(input, 'B', 'C', 0);
    expect(result.document.source).toBe(
      '# A\r\n\r\n## C\r\n\r\n### B\r\n\r\n```markmap-note\r\nnote b\r\n```\r\n',
    );
    expect(labels(result)).toEqual(['A', 'C', 'B']);
  });

  it('[TC-1-13-18] returns no edits for the same position', () => {
    const result = move('- a\n- b\n', 'b', '#root', 1);
    expect(result.edits).toEqual([]);
    expect(result.document.source).toBe('- a\n- b\n');
  });
});
