import type { Document, EditNode, NoteRange } from './types';

export function lineStart(source: string, offset: number): number {
  const index = source.lastIndexOf('\n', offset - 1);
  const start = index === -1 ? 0 : index + 1;
  return start === 0 && offset > 0 && source.startsWith('\uFEFF') ? 1 : start;
}

export function lineEnd(source: string, offset: number): number {
  const index = source.indexOf('\n', offset);
  return index === -1 ? source.length : index;
}

export function firstLine(source: string, offset: number): string {
  return source.slice(offset, lineEnd(source, offset));
}

export function indentWidth(indent: string): number {
  let width = 0;
  for (const char of indent) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 4;
    else break;
  }
  return width;
}

export const LIST_MARKER = /^([ \t]*)([-+*]|\d{1,9}[.)])(?:[ \t]+|$)(\[[ xX]\][ \t]+)?/;
export const HEADING_MARKER = /^[ \t]{0,3}(#{1,6})(?:[ \t]+|(?=\r?$))/;

export function contentIndent(node: EditNode): string {
  if (node.kind !== 'listItem' || !node.list) return '';
  return node.list.indent + ' '.repeat(node.list.marker.length + 1);
}

export function normalizeNoteText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n+$/u, '');
}

export function noteText(doc: Document, node: EditNode, note: NoteRange): string {
  const indent = contentIndent(node);
  const raw = doc.source.slice(note.range.start, note.range.end);
  if (!note.fence) return raw;
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .slice(1, -1)
    .map((line) => (indent && line.startsWith(indent) ? line.slice(indent.length) : line))
    .join('\n');
}

export function notesText(doc: Document, node: EditNode): string {
  const notes = [...node.notes].toSorted((a, b) => a.range.start - b.range.start);
  return normalizeNoteText(notes.map((note) => noteText(doc, node, note)).join('\n\n'));
}
