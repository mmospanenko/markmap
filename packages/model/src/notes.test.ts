import type { MarkmapNode, Note } from '@markmap/core';
import { describe, expect, it } from 'vitest';
import { buildDocument, buildFromTree, labelText, noteText, notesText, normalizeNoteText } from '.';
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
    const doc = buildFromTree('abc', tree, { hasTitle: false, bodyStart: 0 });
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

  it('[TC-3-2-4] keeps per-note partitions distinct when joined text collides', () => {
    const source = 'A\n\nB\n\nC';
    const doc = buildDocument(source);
    const root = doc.nodes.get(doc.root);
    if (!root) throw new Error('No root');
    const first = noteText(doc, root, { range: { start: 0, end: 4 }, fence: false });
    const second = noteText(doc, root, { range: { start: 6, end: 7 }, fence: false });
    const otherFirst = noteText(doc, root, { range: { start: 0, end: 1 }, fence: false });
    const otherSecond = noteText(doc, root, { range: { start: 3, end: 7 }, fence: false });
    expect([first, second]).toEqual(['A\n\nB', 'C']);
    expect([otherFirst, otherSecond]).toEqual(['A', 'B\n\nC']);
    expect([first, second].join('\n\n')).toBe([otherFirst, otherSecond].join('\n\n'));
  });

  it('[TC-3-2-5] de-indents one fenced note and composes notesText', () => {
    const doc = buildDocument('- a\n\n  ```markmap-note\n  first\n    second\n  ```\n');
    const node = find(doc, 'a');
    const note = node.notes[0];
    if (!note) throw new Error('No note');
    expect(noteText(doc, node, note)).toBe('first\n  second');
    expect(notesText(doc, node)).toBe('first\n  second');
  });

  it('[TC-3-2-6] keeps the old notesText join before one final normalize', () => {
    const doc = buildDocument('# A\n\n```markmap-note\nOne\n\n```\n\nTwo\n');
    const node = find(doc, 'A');
    const [fence, paragraph] = node.notes;
    if (!fence || !paragraph) throw new Error('No notes');
    expect(noteText(doc, node, fence)).toBe('One\n');
    expect(noteText(doc, node, paragraph)).toBe('Two');
    expect(notesText(doc, node)).toBe('One\n\n\nTwo');
    expect(normalizeNoteText(noteText(doc, node, fence))).toBe('One');
    expect(normalizeNoteText(noteText(doc, node, paragraph))).toBe('Two');
  });
});
