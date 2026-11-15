import { buildDocument, labelText, type Document, type EditNode } from '@markmap/model';
import { describe, expect, it } from 'vitest';
import { applyCommand, EditError, type EditResult } from '.';

function find(doc: Document, text: string): EditNode {
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (node && labelText(doc, node) === text) return node;
  }
  throw new Error(`No node labelled ${text}`);
}

function paste(input: string, target: string, text: string): EditResult {
  const doc = buildDocument(input);
  const node = find(doc, target);
  return applyCommand(doc, { type: 'insertBlock', node: node.id, text });
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

describe('insert block', () => {
  it('[TC-1-12-1] pastes a list subtree under a list item and keeps its notes', () => {
    const input = '- a\n- b\n  - c\n';
    const result = paste(input, 'a', '- b\n  - c');
    expect(result.document.source).toBe('- a\n  - b\n    - c\n- b\n  - c\n');
    expect(labels(result)).toEqual(['', 'a', 'b', 'c', 'b', 'c']);
    const selected = result.document.order
      .map((id) => result.document.nodes.get(id))
      .find((node) => node?.label?.start === result.selection);
    expect(selected ? labelText(result.document, selected) : '').toBe('b');
    const withNote = paste('- a\n- b\n  - c\n\n    note\n', 'a', '- b\n  - c\n\n    note');
    expect(withNote.document.source).toBe(
      '- a\n  - b\n    - c\n\n      note\n- b\n  - c\n\n    note\n',
    );
  });

  it('[TC-1-12-2] pastes a heading subtree under a heading with renumbered levels', () => {
    const input = '# A\n## B\n### C\n';
    const result = paste(input, 'C', '## B\n### C');
    expect(result.document.source).toBe('# A\n## B\n### C\n#### B\n##### C\n');
    expect(labels(result)).toEqual(['A', 'B', 'C', 'B', 'C']);
  });

  it('[TC-1-12-3] dedents a list subtree pasted under a heading', () => {
    const input = '- a\n  - b\n    - c\n# H\n';
    const result = paste(input, 'H', '  - b\n    - c');
    expect(result.document.source).toBe('- a\n  - b\n    - c\n# H\n- b\n  - c\n');
    expect(labels(result)).toEqual(['', 'a', 'b', 'c', 'H', 'b', 'c']);
  });

  it('[TC-1-12-4] pastes a whole root heading under a nested heading', () => {
    const input = '# A\n\nnote a\n\n## B\n';
    const result = paste(input, 'B', '# A\n\nnote a\n');
    expect(result.document.source).toBe('# A\n\nnote a\n\n## B\n### A\n\nnote a\n');
  });

  it('[TC-1-12-5] rejects a heading under a list item and an excessive level', () => {
    const input = '- a\n# A\n##### E\n### C\n#### D\n';
    expect(() => paste(input, 'a', '# A')).toThrowError(/heading cannot be pasted/);
    expect(() => paste(input, 'E', '### C\n#### D')).toThrowError(/cannot exceed six/);
    expect(buildDocument(input).source).toBe(input);
  });

  it('[TC-1-12-6] rejects pasted text without a node', () => {
    const input = '- a\n';
    expect(() => paste(input, 'a', 'plain note')).toThrowError(/no editable node/);
    expect(() => paste(input, 'a', '   ')).toThrowError(/empty/);
  });

  it('[TC-1-12-7] preserves CRLF and placement at the end of the file', () => {
    const input = '- a\r\n- b\r\n';
    const result = paste(input, 'a', '- b\r\n');
    expect(result.document.source).toBe('- a\r\n  - b\r\n- b\r\n');
    const last = paste('- a', 'a', '- b');
    expect(last.document.source).toBe('- a\n  - b');
  });

  it('[TC-1-12-8] pastes into an empty root and promotes a first heading', () => {
    const doc = buildDocument('---\ntitle: T\n---\n');
    const root = doc.nodes.get(doc.root);
    if (!root) throw new Error('No root');
    const result = applyCommand(doc, { type: 'insertBlock', node: root.id, text: '# First' });
    expect(result.document.source).toBe('---\ntitle: T\n---\n# First\n');
    const selected = result.document.order
      .map((id) => result.document.nodes.get(id))
      .find((node) => node?.label?.start === result.selection);
    expect(selected ? labelText(result.document, selected) : '').toBe('First');
  });

  it('[TC-1-12-9] selects the pasted root label', () => {
    const result = paste('# A\n## B\n', 'A', '## B');
    expect(result.document.source).toBe('# A\n## B\n## B\n');
    const selected = result.document.order
      .map((id) => result.document.nodes.get(id))
      .find((node) => node?.label?.start === result.selection);
    expect(selected ? labelText(result.document, selected) : '').toBe('B');
    expect(editError(() => paste('- a\n# A\n', 'a', '# A'))).toBeInstanceOf(EditError);
    expect(editError(() => paste('# A\n', 'A', '# B\n# C'))).toBeInstanceOf(EditError);
  });
});
