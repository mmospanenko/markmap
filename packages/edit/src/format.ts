import type { Document, EditNode, Range } from '@markmap/model';
import { firstLine, HEADING_MARKER, LIST_MARKER } from '@markmap/model';
import { EditError } from './errors';

export function lineEnding(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

export function newlineLengthAt(source: string, offset: number): number {
  if (source.startsWith('\r\n', offset)) return 2;
  if (source[offset] === '\n') return 1;
  return 0;
}

export function cutRange(source: string, block: Range): Range {
  let start = block.start;
  let end = block.end;
  const newline = newlineLengthAt(source, end);
  if (newline) {
    end += newline;
  } else if (end === source.length && source[end - 1] !== '\n') {
    if (source[start - 1] === '\n') start -= 1;
    if (source[start - 1] === '\r') start -= 1;
  }
  return { start, end };
}

export interface InsertedLine {
  insert: string;
  leading: number;
}

export function insertLine(
  source: string,
  position: number,
  line: string,
  ending: string,
): InsertedLine {
  const atLineStart = position === 0 || source[position - 1] === '\n';
  if (atLineStart) {
    const suffix = position < source.length || source.endsWith('\n') ? ending : '';
    return { insert: line + suffix, leading: 0 };
  }
  const prefix = ending;
  const suffix = position === source.length && source.endsWith('\n') ? ending : '';
  return { insert: prefix + line + suffix, leading: prefix.length };
}

export function placeBlock(
  block: string,
  ending: string,
  atLineStart: boolean,
  following: boolean,
): InsertedLine {
  const prefix = atLineStart ? '' : ending;
  let text = block;
  const hasNewline = text.endsWith('\n') || text.endsWith('\r\n');
  if (!hasNewline && (following || prefix)) text += ending;
  return { insert: prefix + text, leading: prefix.length };
}

export function headingLine(level: number, text: string): string {
  return `${'#'.repeat(level)} ${text}`;
}

export function listLine(indent: string, marker: string, text: string, ending: string): string {
  if (!text.includes('\n')) return `${indent}${marker} ${text}`;
  const continuation = indent + ' '.repeat(marker.length + 1);
  return text
    .split('\n')
    .map((line, index) => {
      if (index === 0) return line;
      return line ? continuation + line : '';
    })
    .join(ending)
    .replace(/^/, `${indent}${marker} `);
}

export function cleanLabel(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

export function listContinuation(node: EditNode): string {
  if (!node.list) return '';
  return node.list.indent + ' '.repeat(node.list.marker.length + 1);
}

export function formatListText(node: EditNode, text: string, ending: string): string {
  const continuation = listContinuation(node);
  return text
    .split('\n')
    .map((line, index) => (index === 0 ? line : line ? continuation + line : ''))
    .join(ending);
}

export function assertSingleLine(node: EditNode, text: string): void {
  if (text.includes('\n')) {
    throw new EditError('E_LABEL', 'A heading label cannot contain a line break', node.id);
  }
}

export function childIndent(doc: Document, node: EditNode): string {
  const children = node.children
    .map((id) => doc.nodes.get(id))
    .filter((child): child is EditNode => child?.kind === 'listItem');
  const first = children.find((child) => child.list);
  if (first?.list) return first.list.indent;
  const indent = node.list?.indent ?? '';
  return indent + doc.unit;
}

export function childMarker(doc: Document, node: EditNode): string {
  for (const id of node.children) {
    const child = doc.nodes.get(id);
    if (child?.kind === 'listItem' && child.list) return child.list.marker;
  }
  return '-';
}

export function dedentList(
  text: string,
  fromIndent: string,
  toIndent: string,
  ending: string,
): string {
  const delta = fromIndent.length - toIndent.length;
  if (delta <= 0) return text;
  return text
    .split(ending)
    .map((line, index) => {
      if (index === 0) {
        return line.startsWith(fromIndent) ? toIndent + line.slice(fromIndent.length) : line;
      }
      if (!line.trim()) return line;
      const match = /^[ \t]*/.exec(line);
      const prefix = match ? match[0] : '';
      if (prefix.length >= delta) return prefix.slice(delta) + line.slice(prefix.length);
      return line;
    })
    .join(ending);
}

export function dedentHeadings(
  doc: Document,
  node: EditNode,
  delta: number,
  ending: string,
): string {
  if (!node.block) throw new EditError('E_SHAPE', 'The node has no block', node.id);
  const levels = new Map<number, number>();
  const collect = (parent: EditNode) => {
    for (const id of parent.children) {
      const child = doc.nodes.get(id);
      if (!child?.block) continue;
      if (child.kind === 'heading') {
        const level = child.level - delta;
        if (level < 1)
          throw new EditError('E_LEVEL', 'Heading level would drop below one', child.id);
        levels.set(child.block.start - node.block!.start, level);
      }
      collect(child);
    }
  };
  const own = node.level - delta;
  if (own < 1) throw new EditError('E_LEVEL', 'Heading level would drop below one', node.id);
  levels.set(0, own);
  collect(node);

  const block = doc.source.slice(node.block.start, node.block.end);
  let offset = 0;
  return block
    .split(ending)
    .map((line) => {
      const level = levels.get(offset);
      offset += line.length + ending.length;
      if (level == null) return line;
      return line.replace(/^([ \t]{0,3})(#{1,6})(?=[ \t]|$)/, (_, space: string) => {
        return `${space}${'#'.repeat(level)}`;
      });
    })
    .join(ending);
}

export function firstLineMarker(text: string): number {
  const line = firstLine(text, 0);
  const list = LIST_MARKER.exec(line);
  if (list) return list[0].length;
  const heading = HEADING_MARKER.exec(line);
  return heading ? heading[0].length : 0;
}
