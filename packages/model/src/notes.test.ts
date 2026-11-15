import type { MarkmapNode, Note } from '@markmap/core';
import { describe, expect, it } from 'vitest';
import { buildDocument, buildFromTree, labelText } from '.';
import type { Document, EditNode } from '.';

function find(doc: Document, text: string): EditNode {
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (node && labelText(doc, node) === text) return node;
  }
  throw new Error(`No node labelled ${text}`);
}

function paragraphNote(start?: number, end?: number): Note {
  const note: Note = { block: { type: 'paragraph', children: [] }, after: 0, fence: true };
  if (start !== undefined && end !== undefined) note.source = { start, end };
  return note;
}

describe('model notes', () => {
  it('[TC-3-2-1] dedupes note ranges and clamps them to the source', () => {
    const tree: MarkmapNode = {
      id: 'root',
      type: 'root',
      content: [],
      notes: [paragraphNote(2, 999), paragraphNote(2, 999), paragraphNote()],
      data: {},
      children: [],
    };
    const doc = buildFromTree('abc', tree);
    const root = doc.nodes.get(doc.root);
    expect(root?.notes).toEqual([{ range: { start: 2, end: 3 }, fence: true }]);
  });

  it('[TC-3-2-2] exposes one range per fence and a range per legacy note', () => {
    const fence = buildDocument('# A\n\n```markmap-note\n- one\n\n## B\n```\n\n- child\n');
    const heading = find(fence, 'A');
    expect(heading.notes).toHaveLength(1);
    const range = heading.notes[0]?.range;
    if (!range) throw new Error('No note range');
    expect(heading.notes[0]?.fence).toBe(true);
    expect(fence.source.slice(range.start, range.end)).toContain('```markmap-note');

    const legacy = buildDocument('# A\n\nFirst.\n\nSecond.\n');
    const node = find(legacy, 'A');
    expect(node.notes.map((note) => note.fence)).toEqual([false, false]);
    expect(node.notes.map((note) => legacy.source.slice(note.range.start, note.range.end))).toEqual(
      ['First.', 'Second.'],
    );
  });

  it('[TC-3-2-3] marks nodes that can hold notes', () => {
    const title = buildDocument('---\ntitle: T\n---\n\n## B\n');
    const empty = buildDocument('');
    const opaque = buildDocument('- # T\n- plain\n');
    expect(title.nodes.get(title.root)?.capabilities.editNotes).toBe(true);
    expect(find(title, 'B').capabilities.editNotes).toBe(true);
    expect(find(buildDocument('- a\n'), 'a').capabilities.editNotes).toBe(true);
    expect(empty.nodes.get(empty.root)?.capabilities.editNotes).toBe(false);
    expect(find(opaque, 'T').capabilities.editNotes).toBe(false);
  });
});
