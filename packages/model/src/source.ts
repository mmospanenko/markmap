export function lineStart(source: string, offset: number): number {
  const index = source.lastIndexOf('\n', offset - 1);
  return index === -1 ? 0 : index + 1;
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
export const HEADING_MARKER = /^[ \t]{0,3}(#{1,6})(?:[ \t]+|$)/;
