import type { MarkmapNode, Rect, ResolvedLabelStyle, Side, TextAlign } from '@markmap/core';
import type { Document, RandomSource } from '@markmap/model';

export interface EditLabelStyle extends ResolvedLabelStyle {
  align: TextAlign;
}

export interface EditView {
  readonly element: Element;
  readonly scale: number;
  readonly transform: { k: number; x: number; y: number };
  readonly foldedIds: ReadonlySet<string>;
  panBy(dx: number, dy: number): void;
  setTree(root: MarkmapNode): void;
  setFolded(id: string, folded: boolean): void;
  setFoldedIds(ids: Iterable<string>, options?: { animate?: boolean }): void;
  toggle(id: string): void;
  focusNode(id: string, options?: { animate?: boolean }): boolean;
  screenRect(id: string): Rect | undefined;
  direction(id: string): Side | undefined;
  labelStyle?(id: string): EditLabelStyle | undefined;
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
  random?: RandomSource;
  onChange?: (change: EditorChange) => void;
  onDraftChange?: (change: EditorChange) => void;
  onError?: (error: Error) => void;
}

export interface HistoryEntry {
  source: string;
  selection: number;
  folded: string[];
  group?: number[];
}
