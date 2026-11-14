import { buildDocument, labelText, type Document, type EditNode } from '@markmap/model';
import { describe, expect, it } from 'vitest';
import { applyCommand, EditError, type Command, type EditResult } from '.';

function find(doc: Document, text: string): EditNode {
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (node && labelText(doc, node) === text) return node;
  }
  throw new Error(`No node labelled ${text}`);
}

function root(doc: Document): EditNode {
  return doc.nodes.get(doc.root)!;
}

function run(input: string, label: string, command: (node: EditNode) => Command): EditResult {
  const doc = buildDocument(input);
  const node = label === '#root' ? root(doc) : find(doc, label);
  return applyCommand(doc, command(node));
}

function textAt(result: EditResult): string {
  const node = result.document.nodes.get(result.document.root);
  if (!node) return '';
  for (const id of result.document.order) {
    const candidate = result.document.nodes.get(id);
    if (candidate?.label?.start === result.selection) return labelText(result.document, candidate);
  }
  return '';
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

describe('edit', () => {
  it('[TC-1-3-1] renames a heading, a list item and the root', () => {
    expect(
      run('# A\n\n## B\n', 'B', (node) => ({ type: 'setLabel', node: node.id, text: 'Bee' }))
        .document.source,
    ).toBe('# A\n\n## Bee\n');
    expect(
      run('# A\n\n- x\n', 'A', (node) => ({ type: 'setLabel', node: node.id, text: 'Root' }))
        .document.source,
    ).toBe('# Root\n\n- x\n');
    expect(
      run('- a\n- b\n', 'a', (node) => ({ type: 'setLabel', node: node.id, text: 'alpha' }))
        .document.source,
    ).toBe('- alpha\n- b\n');
  });

  it('[TC-1-3-2] keeps a multi-line list label indented', () => {
    const result = run('- a\n- b\n', 'a', (node) => ({
      type: 'setLabel',
      node: node.id,
      text: 'one\ntwo',
    }));
    expect(result.document.source).toBe('- one\n  two\n- b\n');
  });

  it('[TC-1-3-3] rejects a line break in a heading label', () => {
    expect(
      editError(() =>
        run('# A\n', 'A', (node) => ({ type: 'setLabel', node: node.id, text: 'a\nb' })),
      ).code,
    ).toBe('E_LABEL');
  });

  it('[TC-1-3-4] inserts a sibling after the whole subtree', () => {
    const heading = run('# A\n\n## B\n\n- x\n\n# C\n', 'B', (node) => ({
      type: 'insertSibling',
      node: node.id,
      text: 'New',
    }));
    expect(heading.document.source).toBe('# A\n\n## B\n\n- x\n\n## New\n# C\n');
    expect(textAt(heading)).toBe('New');

    const list = run('- a\n  - b\n- c\n', 'a', (node) => ({
      type: 'insertSibling',
      node: node.id,
      text: 'new',
    }));
    expect(list.document.source).toBe('- a\n  - b\n- new\n- c\n');
    expect(textAt(list)).toBe('new');
    expect(heading.tree.id).toBe(heading.document.root);
    expect(list.tree.id).toBe(list.document.root);
  });

  it('[TC-1-3-5] inserts a child at the end of the node', () => {
    const heading = run('# A\n\n## B\n', 'B', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'C',
    }));
    expect(heading.document.source).toBe('# A\n\n## B\n### C\n');

    const list = run('- a\n', 'a', (node) => ({ type: 'insertChild', node: node.id, text: 'b' }));
    expect(list.document.source).toBe('- a\n  - b\n');

    const spaced = run('- a\n    - b\n', 'a', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'c',
    }));
    expect(spaced.document.source).toBe('- a\n    - b\n    - c\n');
  });

  it('[TC-1-3-6] inserts a child of a synthetic root', () => {
    const list = run('- a\n- b\n', '#root', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'c',
    }));
    expect(list.document.source).toBe('- a\n- b\n- c\n');

    const heading = run('# A\n\n# B\n', '#root', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'C',
    }));
    expect(heading.document.source).toBe('# A\n\n# B\n# C\n');
  });

  it('[TC-1-3-7] rejects invalid capabilities', () => {
    expect(
      editError(() =>
        run('- a\n', '#root', (node) => ({ type: 'insertSibling', node: node.id, text: 'x' })),
      ).code,
    ).toBe('E_CAPABILITY');
    expect(
      editError(() =>
        run('###### A\n', 'A', (node) => ({ type: 'insertChild', node: node.id, text: 'x' })),
      ).code,
    ).toBe('E_CAPABILITY');
    expect(
      editError(() => run('- a\n', '#root', (node) => ({ type: 'delete', node: node.id }))).code,
    ).toBe('E_CAPABILITY');
    expect(
      editError(() => run('# A\n', 'A', (node) => ({ type: 'outdent', node: node.id }))).code,
    ).toBe('E_CAPABILITY');
    expect(
      editError(() =>
        run('- # T\n', 'T', (node) => ({ type: 'setLabel', node: node.id, text: 'x' })),
      ).code,
    ).toBe('E_CAPABILITY');
  });

  it('[TC-1-4-1] deletes a leaf, a subtree and a heading section', () => {
    expect(
      run('- a\n- b\n', 'a', (node) => ({ type: 'delete', node: node.id })).document.source,
    ).toBe('- b\n');
    expect(
      run('- a\n  - b\n- c\n', 'a', (node) => ({ type: 'delete', node: node.id })).document.source,
    ).toBe('- c\n');
    const heading = run('# A\n\n## B\n\n- x\n\n# C\n', 'B', (node) => ({
      type: 'delete',
      node: node.id,
    }));
    expect(heading.document.source).toBe('# A\n\n# C\n');
    expect(textAt(heading)).toBe('A');
  });

  it('[TC-1-5-1] outdents the last list child', () => {
    const result = run('- a\n  - b\n- c\n', 'b', (node) => ({ type: 'outdent', node: node.id }));
    expect(result.document.source).toBe('- a\n- b\n- c\n');
    expect(textAt(result)).toBe('b');
  });

  it('[TC-1-5-2] outdents a list branch with descendants', () => {
    const result = run('- a\n  - b\n    - d\n  - e\n- f\n', 'b', (node) => ({
      type: 'outdent',
      node: node.id,
    }));
    expect(result.document.source).toBe('- a\n  - e\n- b\n  - d\n- f\n');
    expect(textAt(result)).toBe('b');
  });

  it('[TC-1-5-3] outdents a heading branch and its descendants', () => {
    const result = run('# A\n\n## B\n\n### C\n\n# D\n', 'B', (node) => ({
      type: 'outdent',
      node: node.id,
    }));
    expect(result.document.source).toBe('# A\n\n# B\n\n## C\n\n# D\n');
    expect(textAt(result)).toBe('B');
  });

  it('[TC-1-5-4] rejects outdent of a depth-one list item', () => {
    expect(
      editError(() => run('# A\n\n- b\n', 'b', (node) => ({ type: 'outdent', node: node.id })))
        .code,
    ).toBe('E_CAPABILITY');
  });

  it('[TC-1-6-1] toggles a task checkbox', () => {
    const result = run('- [ ] a\n- [x] b\n', 'a', (node) => ({
      type: 'toggleCheck',
      node: node.id,
    }));
    expect(result.document.source).toBe('- [x] a\n- [x] b\n');
    expect(textAt(result)).toBe('a');
  });

  it('[TC-1-7-1] preserves CRLF line endings', () => {
    const renamed = run('- a\r\n- b\r\n', 'a', (node) => ({
      type: 'setLabel',
      node: node.id,
      text: 'x',
    }));
    expect(renamed.document.source).toBe('- x\r\n- b\r\n');
    const child = run('- a\r\n', 'a', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'b',
    }));
    expect(child.document.source).toBe('- a\r\n  - b\r\n');
  });

  it('[TC-1-9-1] leaves bytes outside the edit untouched', () => {
    const input = 'Before.\n\n# A\n\n## B\n\n```\n# not a heading\n```\n\n- x\n';
    const result = run(input, 'B', (node) => ({ type: 'setLabel', node: node.id, text: 'Bee' }));
    const edit = result.edits[0];
    expect(result.document.source.slice(0, edit.from)).toBe(input.slice(0, edit.from));
    const tail = input.length - edit.to;
    expect(result.document.source.slice(-tail)).toBe(input.slice(edit.to));
  });
});
