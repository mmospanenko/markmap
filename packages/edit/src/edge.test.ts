import {
  buildDocument,
  buildFromTree,
  labelText,
  validateDocument,
  type Document,
  type EditNode,
} from '@markmap/model';
import { describe, expect, it } from 'vitest';
import { applyCommand, applySplices, EditError, mapOffset, type Command, type EditResult } from '.';

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

describe('edit edges', () => {
  it('[TC-1-8-1] works at end of file with and without a trailing newline', () => {
    expect(
      run('- a', 'a', (n) => ({ type: 'insertSibling', node: n.id, text: 'b' })).document.source,
    ).toBe('- a\n- b');
    expect(
      run('- a\n', 'a', (n) => ({ type: 'insertSibling', node: n.id, text: 'b' })).document.source,
    ).toBe('- a\n- b\n');
    expect(
      run('- a', 'a', (n) => ({ type: 'insertChild', node: n.id, text: 'b' })).document.source,
    ).toBe('- a\n  - b');
    expect(
      run('# A\n\n## B', 'B', (n) => ({ type: 'insertSibling', node: n.id, text: 'C' })).document
        .source,
    ).toBe('# A\n\n## B\n## C');
  });

  it('[TC-1-8-2] deletes the only node and the last node', () => {
    expect(run('- a', 'a', (n) => ({ type: 'delete', node: n.id })).document.source).toBe('');
    expect(run('- a\n- b', 'b', (n) => ({ type: 'delete', node: n.id })).document.source).toBe(
      '- a',
    );
  });

  it('[TC-1-8-3] outdents a middle child and preserves notes', () => {
    expect(
      run('- a\n  - b\n  - c\n- d\n', 'b', (n) => ({ type: 'outdent', node: n.id })).document
        .source,
    ).toBe('- a\n  - c\n- b\n- d\n');
    expect(
      run('- a\n  - b\n\n    note\n- c\n', 'b', (n) => ({ type: 'outdent', node: n.id })).document
        .source,
    ).toBe('- a\n- b\n\n  note\n- c\n');
  });

  it('[TC-1-8-4] preserves a trailing directive when renaming', () => {
    const result = run('- a <!-- markmap: fold -->\n', 'a', (n) => ({
      type: 'setLabel',
      node: n.id,
      text: 'alpha',
    }));
    expect(result.document.source).toBe('- alpha <!-- markmap: fold -->\n');
    expect(result.document.nodes.get(result.document.order[1])?.opaque).toBe(false);
  });

  it('[TC-1-8-5] rejects a label that would create a nested node', () => {
    expect(() =>
      run('- a\n', 'a', (n) => ({ type: 'setLabel', node: n.id, text: 'one\n- two' })),
    ).toThrowError(/node count|invalid document|did not survive/);
  });

  it('[TC-1-8-6] keeps frontmatter and appends a root child', () => {
    const result = run('---\ntitle: T\n---\n\n- a\n', '#root', (n) => ({
      type: 'insertChild',
      node: n.id,
      text: 'b',
    }));
    expect(result.document.source).toBe('---\ntitle: T\n---\n\n- a\n- b\n');
  });

  it('[TC-1-8-7] keeps the ordered list marker', () => {
    const result = run('1. one\n2. two\n', 'one', (n) => ({
      type: 'insertSibling',
      node: n.id,
      text: 'new',
    }));
    expect(result.document.source).toBe('1. one\n1. new\n2. two\n');
  });

  it('[TC-1-8-8] unchecks a task', () => {
    const result = run('- [x] b\n', 'b', (n) => ({ type: 'toggleCheck', node: n.id }));
    expect(result.document.source).toBe('- [ ] b\n');
  });

  it('[TC-1-8-9] validates after every command in a sequence', () => {
    let doc = buildDocument('# A\n\n- x\n  - y\n');
    const steps: Array<(current: Document) => Command> = [
      (current) => ({ type: 'insertChild', node: find(current, 'A').id, text: 'B' }),
      (current) => ({ type: 'setLabel', node: find(current, 'B').id, text: 'Beta' }),
      (current) => ({ type: 'insertSibling', node: find(current, 'Beta').id, text: 'Gamma' }),
      (current) => ({ type: 'insertChild', node: find(current, 'x').id, text: 'z' }),
      (current) => ({ type: 'outdent', node: find(current, 'z').id }),
      (current) => ({ type: 'delete', node: find(current, 'Gamma').id }),
    ];
    for (const step of steps) {
      const result = applyCommand(doc, step(doc));
      expect(validateDocument(result.document)).toEqual([]);
      doc = result.document;
    }
    expect(doc.source).toBe('# A\n\n- x\n  - y\n- z\n## Beta\n');
  });

  it('[TC-1-8-10] leaves the input document unchanged on failure', () => {
    const doc = buildDocument('# A\n');
    const node = find(doc, 'A');
    expect(() => applyCommand(doc, { type: 'setLabel', node: node.id, text: 'a\nb' })).toThrowError(
      /line break/,
    );
    expect(doc.source).toBe('# A\n');
    expect(doc.nodes.size).toBe(1);
  });

  it('[TC-1-8-11] inserts a multi-line list label', () => {
    const result = run('- a\n', 'a', (n) => ({
      type: 'insertSibling',
      node: n.id,
      text: 'one\ntwo',
    }));
    expect(result.document.source).toBe('- a\n- one\n  two\n');
  });

  it('[TC-1-8-12] rejects a label that turns into a block', () => {
    const doc = buildDocument('- a\n');
    const node = find(doc, 'a');
    expect(() =>
      applyCommand(doc, { type: 'setLabel', node: node.id, text: 'one\n# two' }),
    ).toThrowError(EditError);
  });

  it('[TC-1-8-13] survives a deterministic command fuzz', () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const texts = ['x', 'One\ntwo', '**bold**', ''];
    const types = ['setLabel', 'insertChild', 'insertSibling', 'delete', 'outdent', 'toggleCheck'];
    let doc = buildDocument('# A\n\n- x\n  - y\n\n# B\n');
    const failures: string[] = [];
    for (let step = 0; step < 60; step += 1) {
      const id = doc.order[Math.floor(random() * doc.order.length)];
      const type = types[Math.floor(random() * types.length)];
      const text = texts[Math.floor(random() * texts.length)];
      const command =
        type === 'setLabel' || type === 'insertChild' || type === 'insertSibling'
          ? { type, node: id, text }
          : { type, node: id };
      const before = doc.source;
      try {
        const result = applyCommand(doc, command as Command);
        expect(validateDocument(result.document)).toEqual([]);
        expect(result.tree.id).toBe(result.document.root);
        doc = result.document;
      } catch (error) {
        if (!(error instanceof EditError)) throw error;
        if (doc.source !== before) failures.push(`step ${step}: input changed after a failure`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('[TC-1-8-14] outdents a tab-indented item', () => {
    expect(
      run('- a\n\t- b\n- c\n', 'b', (n) => ({ type: 'outdent', node: n.id })).document.source,
    ).toBe('- a\n- b\n- c\n');
  });

  it('[TC-1-8-15] rejects unknown nodes and unsupported commands', () => {
    const doc = buildDocument('- a\n');
    expect(() => applyCommand(doc, { type: 'delete', node: 'missing' })).toThrowError(/No node/);
    expect(() => applyCommand(doc, { type: 'setLabel', node: doc.root, text: 'x' })).toThrowError(
      EditError,
    );
    const opaque = buildDocument('- # T\n');
    expect(() =>
      applyCommand(opaque, { type: 'insertChild', node: find(opaque, 'T').id, text: 'x' }),
    ).toThrowError(EditError);
    expect(() => applyCommand(doc, { type: 'toggleCheck', node: find(doc, 'a').id })).toThrowError(
      EditError,
    );
  });

  it('[TC-1-8-16] inserts into an empty and a titled root', () => {
    const empty = buildDocument('');
    const first = applyCommand(empty, { type: 'insertChild', node: empty.root, text: 'A' });
    expect(first.document.source).toBe('- A');

    const titled = buildDocument('---\ntitle: T\n---\n\n# A\n');
    const second = applyCommand(titled, { type: 'insertChild', node: titled.root, text: 'B' });
    expect(second.document.source).toBe('---\ntitle: T\n---\n\n# A\n# B\n');
  });

  it('[TC-1-8-17] deletes a CRLF item at end of file', () => {
    const doc = buildDocument('- a\r\n- b\r\n');
    const result = applyCommand(doc, { type: 'delete', node: find(doc, 'b').id });
    expect(result.document.source).toBe('- a\r\n');
  });

  it('[TC-1-8-18] inserts a child next to existing children', () => {
    const doc = buildDocument('- a\n  - b\n- c\n');
    const result = applyCommand(doc, {
      type: 'insertChild',
      node: find(doc, 'a').id,
      text: 'd',
    });
    expect(result.document.source).toBe('- a\n  - b\n  - d\n- c\n');
  });

  it('[TC-1-8-19] uses the list branch for a level-six root', () => {
    const tree = {
      id: 'root',
      type: 'root',
      content: [],
      notes: [],
      data: { depth: 6 },
      source: { block: { start: 0, end: 7 } },
      children: [],
    };
    const doc = buildFromTree('###### A', tree);
    expect(() => applyCommand(doc, { type: 'insertChild', node: 'root', text: 'B' })).toThrowError(
      EditError,
    );
  });

  it('[TC-1-8-20] rejects structure-changing insert labels', () => {
    const doc = buildDocument('- a\n- b\n');
    const a = find(doc, 'a').id;
    expect(() =>
      applyCommand(doc, { type: 'insertSibling', node: a, text: 'one\n- two' }),
    ).toThrowError(EditError);
    expect(() => applyCommand(doc, { type: 'insertSibling', node: a, text: '# two' })).toThrowError(
      EditError,
    );
  });
});

describe('splices', () => {
  it('[TC-1-10-1] applies and maps offsets', () => {
    const source = 'abcdef';
    const edits = [
      { from: 1, to: 3, insert: 'X' },
      { from: 4, to: 4, insert: 'Y' },
    ];
    const result = applySplices(source, edits);
    expect(result.text).toBe('aXdYef');
    expect(result.starts).toEqual([1, 3]);
    expect(mapOffset(edits, 0)).toBe(0);
    expect(mapOffset(edits, 2)).toBe(2);
    expect(mapOffset(edits, 4)).toBe(4);
    expect(mapOffset(edits, 6)).toBe(6);
  });

  it('[TC-1-10-2] rejects overlapping splices', () => {
    expect(() =>
      applySplices('abcdef', [
        { from: 1, to: 4, insert: 'X' },
        { from: 3, to: 5, insert: 'Y' },
      ]),
    ).toThrowError(/overlap/);
  });
});
