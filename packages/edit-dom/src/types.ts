import type { MarkmapNode, Rect } from '@markmap/core';
import type { Document } from '@markmap/model';

export interface EditView {
  readonly element: Element;
  readonly foldedIds: ReadonlySet<string>;
  setTree(root: MarkmapNode): void;
  setFolded(id: string, folded: boolean): void;
  setFoldedIds(ids: Iterable<string>, options?: { animate?: boolean }): void;
  toggle(id: string): void;
  focusNode(id: string, options?: { animate?: boolean }): boolean;
  screenRect(id: string): Rect | undefined;
  hitAt(x: number, y: number): { kind: string; nodeId?: string } | undefined;
  layoutPoint(clientX: number, clientY: number): [number, number];
  on(type: 'render' | 'zoom' | 'fold', listener: () => void): () => void;
}

export interface EditorChange {
  source: string;
  selection: number;
  document: Document;
}

export interface MarkmapEditorOptions {
  source: string;
  view: EditView;
  container: HTMLElement;
  placeholder?: string;
  onChange?: (change: EditorChange) => void;
  onError?: (error: Error) => void;
}

export interface HistoryEntry {
  source: string;
  selection: number;
  folded: string[];
}
