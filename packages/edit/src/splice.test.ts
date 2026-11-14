import { describe, expect, it } from 'vitest';
import { applySplices, mapOffset } from './splice';

describe('splice', () => {
  it('[TC-1-10-3] applies an insert and a delete at the same offset', () => {
    const result = applySplices('abc', [
      { from: 1, to: 1, insert: 'X' },
      { from: 1, to: 2, insert: 'Y' },
    ]);
    expect(result.text).toBe('aXYc');
    expect(result.starts).toEqual([1, 2]);
  });

  it('[TC-1-10-4] rejects a splice beyond the source', () => {
    expect(() => applySplices('abc', [{ from: 0, to: 4, insert: '' }])).toThrowError(/outside/);
  });

  it('[TC-1-10-5] maps offsets through a longer insert', () => {
    const edits = [{ from: 1, to: 2, insert: 'LONG' }];
    expect(mapOffset(edits, 0)).toBe(0);
    expect(mapOffset(edits, 1)).toBe(1);
    expect(mapOffset(edits, 2)).toBe(5);
    expect(mapOffset([{ from: 3, to: 4, insert: '' }], 1)).toBe(1);
  });
});
