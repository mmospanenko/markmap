import { type MarkmapNode, toPlainText, walkTree } from '@markmap/core';
import { describe, expect, it } from 'vitest';
import { parse } from '.';

function labelled(root: MarkmapNode, text: string): MarkmapNode {
  let found: MarkmapNode | undefined;
  walkTree(root, (node) => {
    if (!found && toPlainText(node.content) === text) found = node;
  });
  if (!found) throw new Error(`No node labelled ${text}`);
  return found;
}

function fenceSource(markdown: string, note: MarkmapNode['notes'][number]): string {
  const source = note.source;
  if (!source) throw new Error('The note has no source');
  return markdown.slice(source.start, source.end);
}

describe('note fences', () => {
  it('[TC-3-1-1] attaches every block in a fence as a note and adds no children', () => {
    const markdown = '# A\n\n```markmap-note\n- one\n- two\n\n## B\n```\n';
    const { root } = parse(markdown);
    expect(toPlainText(root.content)).toBe('A');
    expect(root.children).toHaveLength(0);
    expect(root.notes.map((note) => note.block.type)).toEqual(['list', 'heading']);
    expect(root.notes.map((note) => note.fence)).toEqual([true, true]);
    const first = root.notes[0];
    if (!first) throw new Error('No note');
    expect(fenceSource(markdown, first)).toBe('```markmap-note\n- one\n- two\n\n## B\n```');
    expect(fenceSource(markdown, root.notes[1] ?? first)).toBe(
      '```markmap-note\n- one\n- two\n\n## B\n```',
    );
  });

  it('[TC-3-1-2] keeps a fence under a list item on the item', () => {
    const markdown = '- a\n\n  ```markmap-note\n  - inner\n  ```\n\n  - child\n';
    const { root } = parse(markdown);
    const item = labelled(root, 'a');
    expect(item.children).toHaveLength(1);
    expect(item.notes).toHaveLength(1);
    const note = item.notes[0];
    if (!note) throw new Error('No note');
    expect(note.block.type).toBe('list');
    expect(note.fence).toBe(true);
    expect(fenceSource(markdown, note)).toBe('```markmap-note\n  - inner\n  ```');
  });

  it('[TC-3-1-3] attaches a fence before the first heading to the promoted root', () => {
    const markdown = '```markmap-note\nBefore.\n```\n\n# A\n\n## B\n';
    const { root } = parse(markdown);
    expect(toPlainText(root.content)).toBe('A');
    expect(root.children.map((child) => toPlainText(child.content))).toEqual(['B']);
    expect(root.notes).toHaveLength(1);
    const note = root.notes[0];
    if (!note) throw new Error('No note');
    expect(note.after).toBe(0);
    expect(note.fence).toBe(true);
    expect(note.block.type).toBe('paragraph');
    expect(fenceSource(markdown, note)).toBe('```markmap-note\nBefore.\n```');
  });

  it('[TC-3-1-4] records the source range of a legacy note and keeps it on promotion', () => {
    const markdown = 'Before.\n\n# A\n\nAfter.\n';
    const { root } = parse(markdown);
    expect(root.notes).toHaveLength(2);
    expect(root.notes.map((note) => note.fence)).toEqual([false, false]);
    const [before, after] = root.notes;
    if (!before || !after) throw new Error('No notes');
    expect(fenceSource(markdown, before)).toBe('Before.');
    expect(fenceSource(markdown, after)).toBe('After.');
    expect(before.after).toBe(0);
  });

  it('[TC-3-1-5] parses a fence with a longer backtick run and a nested code block', () => {
    const markdown = '# A\n\n````markmap-note\n```js\nconst a = 1;\n```\n````\n';
    const { root } = parse(markdown);
    expect(root.notes).toHaveLength(1);
    const note = root.notes[0];
    if (!note) throw new Error('No note');
    expect(note.block.type).toBe('code');
    expect(note.fence).toBe(true);
    expect(fenceSource(markdown, note)).toBe('````markmap-note\n```js\nconst a = 1;\n```\n````');
  });

  it('[TC-3-1-6] uses the document pipeline inside the fence', () => {
    const markdown =
      '# A\n\n```markmap-note\n---\nx: 1\n---\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n==hi== and --> stays\n```\n\n## B\n';
    const { root } = parse(markdown);
    expect(root.children.map((child) => toPlainText(child.content))).toEqual(['B']);
    expect(root.notes.map((note) => note.block.type)).toEqual(['table', 'paragraph']);
    const paragraph = root.notes[1]?.block;
    if (paragraph?.type !== 'paragraph') throw new Error('No paragraph note');
    expect(paragraph.children[0]?.type).toBe('mark');
    expect(toPlainText(paragraph.children)).toContain('-->');
  });
});
