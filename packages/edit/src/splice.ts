import { EditError } from './errors';

export interface Splice {
  from: number;
  to: number;
  insert: string;
}

export interface SpliceResult {
  text: string;
  starts: number[];
}

export function applySplices(source: string, splices: Splice[]): SpliceResult {
  const indexed = splices
    .map((splice, index) => ({ ...splice, index }))
    .toSorted((a, b) => a.from - b.from || a.to - b.to);
  const starts = Array.from({ length: splices.length }, () => 0);
  let text = '';
  let last = 0;
  for (const splice of indexed) {
    if (splice.from < last || splice.to < splice.from || splice.to > source.length) {
      throw new EditError('E_SPLICE', 'Splices overlap or fall outside the source');
    }
    text += source.slice(last, splice.from);
    starts[splice.index] = text.length;
    text += splice.insert;
    last = splice.to;
  }
  text += source.slice(last);
  return { text, starts };
}

export function mapOffset(splices: Splice[], offset: number): number {
  let delta = 0;
  for (const splice of splices.toSorted((a, b) => a.from - b.from || a.to - b.to)) {
    if (offset >= splice.to) {
      delta += splice.insert.length - (splice.to - splice.from);
    } else if (offset > splice.from) {
      return splice.from + delta + splice.insert.length;
    } else {
      break;
    }
  }
  return offset + delta;
}
