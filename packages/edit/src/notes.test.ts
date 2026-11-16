import { buildDocument, labelText, notesText, type Document, type EditNode } from '@markmap/model';
import { describe, expect, it } from 'vitest';
import { applyCommand, EditError, type EditResult } from '.';

function find(doc: Document, text: string): EditNode {
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (node && labelText(doc, node) === text) return node;
  }
  throw new Error(`No node labelled ${text}`);
}

function root(doc: Document): EditNode {
  const node = doc.nodes.get(doc.root);
  if (!node) throw new Error('No root');
  return node;
}

function note(editor: 'root' | string, input: string, text: string): EditResult {
  const doc = buildDocument(input);
  const node = editor === 'root' ? root(doc) : find(doc, editor);
  return applyCommand(doc, { type: 'setNotes', node: node.id, text });
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

describe('setNotes', () => {
  it('[TC-3-3-1] writes a fence below a heading and indents a list item', () => {
    expect(note('A', '# A\n\n- x\n', 'alpha').document.source).toBe(
      '# A\n```markmap-note\nalpha\n```\n\n- x\n',
    );
    expect(note('a', '- a\n- b\n', 'note').document.source).toBe(
      '- a\n  ```markmap-note\n  note\n  ```\n- b\n',
    );
    expect(note('a', '- a\r\n- b\r\n', 'note').document.source).toBe(
      '- a\r\n  ```markmap-note\r\n  note\r\n  ```\r\n- b\r\n',
    );
    const child = note('a', '- a\n  - child\n', 'note');
    expect(child.document.source).toBe('- a\n  ```markmap-note\n  note\n  ```\n  - child\n');
    expect(find(child.document, 'a').children).toHaveLength(1);
  });

  it('[TC-3-3-2] replaces legacy notes with one fence', () => {
    const input = '# A\n\nFirst.\n\nSecond.\n\n- x\n';
    const result = note('A', input, 'All of it');
    expect(result.document.source).toBe('# A\n```markmap-note\nAll of it\n```\n\n- x\n');
    expect(result.document.nodes.get(result.document.root)?.notes).toHaveLength(1);
  });

  it('[TC-3-3-3] removes every note and one separating blank line', () => {
    const input = '# A\n\nFirst.\n\nSecond.\n\n- x\n';
    const result = note('A', input, '');
    expect(result.document.source).toBe('# A\n\n- x\n');
    expect(result.edits).toHaveLength(1);
    expect(result.document.nodes.get(result.document.root)?.notes).toEqual([]);
    const unchanged = note('A', '# A\n\n- x\n', '   \n');
    expect(unchanged.edits).toEqual([]);
    expect(unchanged.document.source).toBe('# A\n\n- x\n');
    expect(note('A', '# A\n\n\nnote', '').document.source).toBe('# A\n\n');
    expect(note('A', '# A\n\n```markmap-note\nnote\n```', '').document.source).toBe('# A\n');
  });

  it('[TC-3-3-4] uses a backtick run longer than the text', () => {
    const text = 'before\n```\nafter';
    const result = note('a', '- a\n', text);
    expect(result.document.source).toBe(
      '- a\n  ````markmap-note\n  before\n  ```\n  after\n  ````\n',
    );
    const node = find(result.document, 'a');
    expect(notesText(result.document, node)).toBe(text);
  });

  it('[TC-3-3-5] normalizes line endings and trailing whitespace', () => {
    const result = note('a', '- a\r\n', 'one  \r\ntwo\r\n\r\n');
    expect(result.document.source).toBe('- a\r\n  ```markmap-note\r\n  one\r\n  two\r\n  ```\r\n');
    expect(notesText(result.document, find(result.document, 'a'))).toBe('one\ntwo');
  });

  it('[TC-3-4-1] appends a fence to a childless title root', () => {
    expect(note('root', '---\ntitle: T\n---\n', 'note').document.source).toBe(
      '---\ntitle: T\n---\n```markmap-note\nnote\n```\n',
    );
    expect(note('root', '---\ntitle: T\n---', 'note').document.source).toBe(
      '---\ntitle: T\n---\n```markmap-note\nnote\n```',
    );
  });

  it('[TC-3-4-2] inserts a fence before the first child of a title root', () => {
    const input = '---\ntitle: T\n---\n\n## B\n\n## C\n';
    const result = note('root', input, 'note');
    expect(result.document.source).toBe(
      '---\ntitle: T\n---\n\n```markmap-note\nnote\n```\n## B\n\n## C\n',
    );
    expect(result.document.nodes.get(result.document.root)?.children).toHaveLength(2);
    expect(labelText(result.document, find(result.document, 'B'))).toBe('B');
    expect(labelText(result.document, find(result.document, 'C'))).toBe('C');
  });

  it('[TC-3-4-3] produces no splices for unchanged text', () => {
    const input = '# A\n\n```markmap-note\nnote\n```\n';
    const result = note('A', input, 'note');
    expect(result.edits).toEqual([]);
    expect(result.document.source).toBe(input);
    expect(note('A', input, 'note\n\n').edits).toEqual([]);
  });

  it('[TC-3-4-4] keeps children and their order and adds no nodes', () => {
    const input = '# A\n\n## B\n\n- x\n\n## C\n';
    const result = note('A', input, '## inner\n\n- also inner');
    const node = find(result.document, 'A');
    expect(
      node.children.map((id) => {
        const child = result.document.nodes.get(id);
        return child ? labelText(result.document, child) : '';
      }),
    ).toEqual(['B', 'C']);
    expect(result.document.nodes.size).toBe(buildDocument(input).nodes.size);
    expect(node.notes).toHaveLength(1);
    expect(node.notes[0]?.fence).toBe(true);
  });

  it('[TC-3-4-5] rejects opaque nodes and an empty root', () => {
    const opaque = editError(() => note('T', '- # T\n', 'note'));
    expect(opaque.code).toBe('E_CAPABILITY');
    expect(opaque.message).toMatch(/cannot hold notes/u);
    expect(editError(() => note('root', '', 'note')).code).toBe('E_CAPABILITY');
  });

  it('[TC-3-4-6] inserts directly below a label line without a trailing newline', () => {
    expect(note('A', '# A\n- x', 'note').document.source).toBe(
      '# A\n```markmap-note\nnote\n```\n- x',
    );
    expect(note('A', '# A', 'note').document.source).toBe('# A\n```markmap-note\nnote\n```');
  });

  it('[TC-3-4-7] keeps CRLF at the end of a heading section', () => {
    expect(note('A', '# A\r\n\r\n- x\r\n', 'note').document.source).toBe(
      '# A\r\n```markmap-note\r\nnote\r\n```\r\n\r\n- x\r\n',
    );
  });

  it('[TC-3-4-8] removes a fence from a title root and keeps the frontmatter', () => {
    const input = '---\ntitle: T\n---\n\n```markmap-note\nnote\n```\n\n## B\n';
    const result = note('root', input, '');
    expect(result.document.source).toBe('---\ntitle: T\n---\n\n## B\n');
    expect(result.document.nodes.get(result.document.root)?.notes).toEqual([]);
  });

  it('[TC-3-4-9] replaces and removes legacy intro notes on promoted roots', () => {
    for (const marker of ['#', '##']) {
      const input = `Intro.\n\n${marker} A\n\n- x\n`;
      const replaced = note('root', input, 'All');
      expect(replaced.document.source).toBe(
        `${marker} A\n\`\`\`markmap-note\nAll\n\`\`\`\n\n- x\n`,
      );
      const replacedRoot = replaced.document.nodes.get(replaced.document.root);
      if (!replacedRoot) throw new Error('No root');
      expect(replaced.document.order[0]).toBe(replaced.document.root);
      expect(labelText(replaced.document, replacedRoot)).toBe('A');
      expect(replacedRoot.block?.start).toBe(0);
      expect(
        replacedRoot.children.map((id) => {
          const child = replaced.document.nodes.get(id);
          return child ? labelText(replaced.document, child) : '';
        }),
      ).toEqual(['x']);

      const removed = note('root', input, '');
      expect(removed.document.source).toBe(`${marker} A\n\n- x\n`);
      const after = removed.document.nodes.get(removed.document.root);
      if (!after) throw new Error('No root');
      expect(labelText(removed.document, after)).toBe('A');
      expect(after.block?.start).toBe(0);
    }
  });

  it('[TC-3-4-10] replaces and removes fenced intro notes on promoted roots', () => {
    for (const marker of ['#', '##']) {
      const input = `\`\`\`markmap-note\nIntro.\n\`\`\`\n\n${marker} A\n\n- x\n`;
      const replaced = note('root', input, 'All');
      expect(replaced.document.source).toBe(
        `${marker} A\n\`\`\`markmap-note\nAll\n\`\`\`\n\n- x\n`,
      );
      const replacedRoot = replaced.document.nodes.get(replaced.document.root);
      if (!replacedRoot) throw new Error('No root');
      expect(labelText(replaced.document, replacedRoot)).toBe('A');
      expect(replacedRoot.block?.start).toBe(0);
      const removed = note('root', input, '');
      expect(removed.document.source).toBe(`${marker} A\n\n- x\n`);
      const after = removed.document.nodes.get(removed.document.root);
      if (!after) throw new Error('No root');
      expect(labelText(removed.document, after)).toBe('A');
      expect(after.block?.start).toBe(0);
    }
  });
});
