import {
  buildDocument,
  labelText,
  noteText,
  notesText,
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

  it('[TC-1-12-5] rejects an excessive heading level', () => {
    const input = '# A\n##### E\n### C\n#### D\n';
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
    expect(editError(() => paste('# A\n', 'A', '# B\n# C'))).toBeInstanceOf(EditError);
  });

  it('[TC-1-12-10] converts a heading subtree pasted under a list item', () => {
    const input = '# A\n## B\nnote b\n- x\n  note x\n  - y\n- a\n';
    const result = paste(input, 'a', '## B\nnote b\n- x\n  note x\n  - y');
    expect(result.document.source).toBe(
      '# A\n## B\nnote b\n- x\n  note x\n  - y\n- a\n  - B\n    note b\n    - x\n      note x\n      - y\n',
    );
    const selected = result.document.order
      .map((id) => result.document.nodes.get(id))
      .find((node) => node?.label?.start === result.selection);
    expect(selected ? labelText(result.document, selected) : '').toMatch(/^B\n/u);
  });

  it('[TC-1-12-11] keeps ordered and task markers and target children', () => {
    const input = '# A\n## B\n1. [x] one\n2. [ ] two\n- target\n  - existing\n';
    const result = paste(input, 'target', '## B\n1. [x] one\n2. [ ] two');
    expect(result.document.source).toBe(
      '# A\n## B\n1. [x] one\n2. [ ] two\n- target\n  - existing\n  - B\n    1. [x] one\n    2. [ ] two\n',
    );
  });

  it('[TC-1-12-12] converts with CRLF line endings', () => {
    const input = '# A\r\n## B\r\n- x\r\n- a\r\n';
    const result = paste(input, 'a', '## B\r\n- x');
    expect(result.document.source).toBe('# A\r\n## B\r\n- x\r\n- a\r\n  - B\r\n    - x\r\n');
  });

  it('[TC-1-12-13] converts nested heading levels into list depth', () => {
    const input = '# A\n## B\n### C\n#### D\n- a\n';
    const result = paste(input, 'a', '## B\n### C\n#### D');
    expect(result.document.source).toBe(
      '# A\n## B\n### C\n#### D\n- a\n  - B\n    - C\n      - D\n',
    );
  });

  it('[TC-1-12-14] rejects an empty heading converted under a list item', () => {
    expect(() => paste('- a\n', 'a', '##')).toThrowError(/did not survive/u);
  });

  it('[TC-3-5-1] reindents a pasted fence with the list item block', () => {
    const input = '- a\n- b\n\n  ```markmap-note\n  note\n  ```\n';
    const result = paste(input, 'a', '- b\n\n  ```markmap-note\n  note\n  ```');
    expect(result.document.source).toBe(
      '- a\n  - b\n\n    ```markmap-note\n    note\n    ```\n- b\n\n  ```markmap-note\n  note\n  ```\n',
    );
    const pasted = find(result.document, 'b');
    expect(pasted.notes.map((note) => note.fence)).toEqual([true]);
  });

  it('[TC-3-5-2] keeps a fence in a pasted heading subtree', () => {
    const input = '# A\n\n```markmap-note\nnote a\n```\n\n# C\n';
    const result = paste(input, 'C', '## B\n\n```markmap-note\nnote b\n```');
    expect(result.document.source).toBe(
      '# A\n\n```markmap-note\nnote a\n```\n\n# C\n## B\n\n```markmap-note\nnote b\n```\n',
    );
    expect(find(result.document, 'B').notes.map((note) => note.fence)).toEqual([true]);
  });

  it('[TC-3-5-3] reindents a fence in a heading subtree pasted under a list item', () => {
    const input = '# A\n- a\n## B\n\n```markmap-note\nnote b\n```\n';
    const result = paste(input, 'a', '## B\n\n```markmap-note\nnote b\n```');
    expect(result.document.source).toBe(
      '# A\n- a\n  - B\n\n    ```markmap-note\n    note b\n    ```\n## B\n\n```markmap-note\nnote b\n```\n',
    );
    expect(find(result.document, 'a').children).toHaveLength(1);
  });

  it('[TC-1-12-16] keeps a paragraph intro note on a pasted heading root', () => {
    const result = paste('# Target\n', 'Target', 'Intro.\n\n## A\n\n- x\n');
    expect(result.document.source).toBe('# Target\n## A\n\nIntro.\n\n- x\n');
    const pasted = find(result.document, 'A');
    expect(notesText(result.document, pasted)).toBe('Intro.');
    expect(find(result.document, 'x').parent).toBe(pasted.id);
    expect(result.selection).toBe(pasted.label?.start);
  });

  it('[TC-1-12-17] keeps a fenced intro note on a pasted heading root', () => {
    const result = paste('# Target\n', 'Target', '```markmap-note\nIntro.\n```\n\n## A\n\n- x\n');
    expect(result.document.source).toBe('# Target\n## A\n\n```markmap-note\nIntro.\n```\n\n- x\n');
    const pasted = find(result.document, 'A');
    expect(notesText(result.document, pasted)).toBe('Intro.');
    expect(pasted.notes.map((note) => note.fence)).toEqual([true]);
    expect(find(result.document, 'x').parent).toBe(pasted.id);
    expect(result.selection).toBe(pasted.label?.start);
  });

  it('[TC-1-12-18] attaches an intro note to a pasted list root', () => {
    const paragraph = paste('- target\n', 'target', 'Intro.\n\n## A\n\n- x\n');
    expect(paragraph.document.source).toBe('- target\n  - A\n\n    Intro.\n\n    - x\n');
    const pasted = find(paragraph.document, 'A');
    expect(notesText(paragraph.document, pasted)).toBe('Intro.');
    expect(find(paragraph.document, 'x').parent).toBe(pasted.id);
    expect(paragraph.selection).toBe(pasted.label?.start);

    const fenceText = '```markmap-note\nIntro.\n```\n\n## A\n\n- x\n';
    const fenced = paste('- target\n', 'target', fenceText);
    expect(fenced.document.source).toBe(
      '- target\n  - A\n\n    ```markmap-note\n    Intro.\n    ```\n\n    - x\n',
    );
    const fencedRoot = find(fenced.document, 'A');
    expect(notesText(fenced.document, fencedRoot)).toBe('Intro.');
    expect(fencedRoot.notes.map((note) => note.fence)).toEqual([true]);
    expect(find(fenced.document, 'x').parent).toBe(fencedRoot.id);
  });

  it('[TC-1-12-19] keeps multiple leading notes on a childless pasted root', () => {
    const result = paste(
      '# Target\n',
      'Target',
      'First.\n\n```markmap-note\nSecond.\n```\n\n## A\n',
    );
    expect(result.document.source).toBe(
      '# Target\n## A\n\nFirst.\n\n```markmap-note\nSecond.\n```\n',
    );
    const pasted = find(result.document, 'A');
    expect(pasted.notes).toHaveLength(2);
    expect(notesText(result.document, pasted)).toBe('First.\n\nSecond.');
    expect(result.selection).toBe(pasted.label?.start);
  });

  it('[TC-1-12-20] rejects an unsupported link reference prefix', () => {
    const input = '# Target\n';
    const doc = buildDocument(input);
    const error = editError(() =>
      applyCommand(doc, {
        type: 'insertBlock',
        node: doc.root,
        text: '[ref]: https://example.com\n\n## A\n\n[Link][ref]\n',
      }),
    );
    expect(error.message).toContain('cannot become a note');
    expect(doc.source).toBe(input);
    expect(doc.nodes.size).toBe(1);
  });

  it('[TC-1-12-21] rejects an unsupported raw HTML prefix', () => {
    const input = '# Target\n';
    const doc = buildDocument(input);
    const error = editError(() =>
      applyCommand(doc, {
        type: 'insertBlock',
        node: doc.root,
        text: '<!-- hidden -->\n\n## A\n\n- x\n',
      }),
    );
    expect(error.message).toContain('cannot become a note');
    expect(doc.source).toBe(input);
  });

  it('[TC-1-12-22] rejects unsupported content mixed with a supported note prefix', () => {
    const input = '# Target\n';
    const doc = buildDocument(input);
    const error = editError(() =>
      applyCommand(doc, {
        type: 'insertBlock',
        node: doc.root,
        text: 'Intro.\n\n<!-- hidden -->\n\n## A\n\n- x\n',
      }),
    );
    expect(error.message).toContain('cannot become a note');
    expect(doc.source).toBe(input);
  });

  it('[TC-1-12-23] keeps the target notes when pasting a root with an intro note', () => {
    const result = paste('# Target\n\nTarget note.\n', 'Target', 'Intro.\n\n## A\n\n- x\n');
    expect(result.document.source).toBe('# Target\n\nTarget note.\n## A\n\nIntro.\n\n- x\n');
    const target = find(result.document, 'Target');
    expect(target.notes).toHaveLength(1);
    expect(notesText(result.document, target)).toBe('Target note.');
    const pasted = find(result.document, 'A');
    expect(notesText(result.document, pasted)).toBe('Intro.');
    expect(result.selection).toBe(pasted.label?.start);
  });

  it('[TC-1-12-24] keeps mixed leading notes in order on heading and list targets', () => {
    const fragment = 'First.\n\n```markmap-note\nSecond.\n```\n\nThird.\n\n## A\n\n- x\n';

    const heading = paste('# Target\n', 'Target', fragment);
    expect(heading.document.source).toBe(
      '# Target\n## A\n\nFirst.\n\n```markmap-note\nSecond.\n```\n\nThird.\n\n- x\n',
    );
    const headingRoot = find(heading.document, 'A');
    expect(headingRoot.notes.map((note) => note.fence)).toEqual([false, true, false]);
    expect(notesText(heading.document, headingRoot)).toBe('First.\n\nSecond.\n\nThird.');
    expect(find(heading.document, 'x').parent).toBe(headingRoot.id);

    const list = paste('- target\n', 'target', fragment);
    expect(list.document.source).toBe(
      '- target\n  - A\n\n    First.\n\n    ```markmap-note\n    Second.\n    ```\n\n    Third.\n\n    - x\n',
    );
    const listRoot = find(list.document, 'A');
    expect(listRoot.notes.map((note) => note.fence)).toEqual([false, true, false]);
    expect(notesText(list.document, listRoot)).toBe('First.\n\nSecond.\n\nThird.');
    expect(find(list.document, 'x').parent).toBe(listRoot.id);
  });

  it('[TC-1-12-25] distinguishes per-note partitions that join to the same text', () => {
    const fragment = '```markmap-note\nA\n\nB\n```\n\nC\n\n## Root\n\n- x\n';
    const result = paste('# Target\n', 'Target', fragment);
    expect(result.document.source).toBe(
      '# Target\n## Root\n\n```markmap-note\nA\n\nB\n```\n\nC\n\n- x\n',
    );
    const root = find(result.document, 'Root');
    const notes = root.notes.map((note) => noteText(result.document, root, note));
    expect(notes).toEqual(['A\n\nB', 'C']);
    expect(notes.join('\n\n')).toBe('A\n\nB\n\nC');
    expect(['A', 'B\n\nC'].join('\n\n')).toBe(notes.join('\n\n'));
  });
});
