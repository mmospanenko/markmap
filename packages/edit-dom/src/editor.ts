import {
  EditError,
  applyCommand,
  lineEnding,
  mapOffset,
  rootHeadingRefusal,
  type Command,
  type EditResult,
} from '@markmap/edit';
import type { Rect } from '@markmap/core';
import {
  labelText,
  nodeAtOffset,
  notesText,
  parseDocument,
  type Document as MarkdownDocument,
  type EditNode,
} from '@markmap/model';
import { History } from './history';
import type { EditView, EditorChange, HistoryEntry, MarkmapEditorOptions } from './types';

const STYLE_ID = 'mm-editor-style';
const MODE_SELECT = 'mm-editor-mode-select';
const MODE_EDIT = 'mm-editor-mode-edit';
const EMPTY_LABEL = '\u200B';
const DRAG_THRESHOLD = 4;
const DRAG_EDGE = 60;
const DRAG_PAN_MAX = 14;
const DRAG_EXPAND_MS = 400;
const SNAP_BACK_MS = 140;

type CommandWithoutNode = {
  [K in Command['type']]: Omit<Extract<Command, { type: K }>, 'node'>;
}[Command['type']];
const STYLE = `
.mm-editor-layer{position:absolute;inset:0;pointer-events:none;z-index:2}
.mm-editor-field{position:absolute;display:none;margin:0;padding:0 8px;border:0;background:transparent;color:inherit;font:inherit;line-height:1.25;text-align:center;white-space:pre-wrap;resize:none;overflow:hidden;outline:none;box-sizing:border-box;pointer-events:auto;transform-origin:top left}
.mm-editor-selection{position:absolute;display:none;pointer-events:none;box-sizing:border-box;border:2px solid var(--oc-focus,#0097e6);border-radius:6px}
.mm-editor-editing text{visibility:hidden}
.mm-editor-notes{position:absolute;display:flex;flex-direction:column;gap:8px;padding:10px;box-sizing:border-box;background:var(--oc-elevated,light-dark(#fff,#1f1f1f));color:var(--oc-fg,light-dark(#1f2328,#e6e3df));border:1px solid var(--oc-border,light-dark(rgba(0,0,0,.14),rgba(255,255,255,.16)));border-radius:var(--oc-radius,8px);box-shadow:0 10px 28px rgba(0,0,0,.18);pointer-events:auto;z-index:3;font:inherit;text-align:left;overflow:hidden}
.mm-editor-notes-header{display:flex;align-items:center;gap:6px;min-height:20px;padding:0 2px 8px;border-bottom:1px solid var(--oc-border,light-dark(rgba(0,0,0,.1),rgba(255,255,255,.12)))}
.mm-editor-notes-icon{flex:none;width:16px;height:16px;color:var(--oc-muted,light-dark(#656d76,#9aa0a6))}
.mm-editor-notes-title{font-size:.9em;font-weight:600;line-height:1.2}
.mm-editor-notes-label{margin-left:auto;color:var(--oc-muted,light-dark(#656d76,#9aa0a6));font-size:.75em;line-height:1.2;letter-spacing:.02em}
.mm-editor-notes-toolbar{display:flex;flex-wrap:wrap;gap:4px}
.mm-editor-notes-toolbar button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;margin:0;padding:0;border:1px solid transparent;border-radius:calc(var(--oc-radius,8px) - 2px);background:transparent;color:inherit;font:inherit;line-height:1;cursor:pointer}
.mm-editor-notes-toolbar button:hover{background:var(--oc-hover,light-dark(rgba(0,0,0,.06),rgba(255,255,255,.08)));border-color:var(--oc-border,light-dark(rgba(0,0,0,.14),rgba(255,255,255,.16)))}
.mm-editor-notes-toolbar button:focus-visible{outline:2px solid var(--oc-focus,#0097e6);outline-offset:1px}
.mm-editor-notes-toolbar svg{display:block;width:16px;height:16px}
.mm-editor-notes-field{flex:1 1 auto;min-height:96px;margin:0;padding:8px 10px;border:1px solid var(--oc-border,light-dark(rgba(0,0,0,.14),rgba(255,255,255,.16)));border-radius:calc(var(--oc-radius,8px) - 2px);background:var(--oc-bg,light-dark(#fff,#141414));color:inherit;font:inherit;line-height:1.45;resize:none;overflow:auto;outline:none;box-sizing:border-box}
.mm-editor-notes-field:focus{border-color:var(--oc-focus,#0097e6);box-shadow:0 0 0 2px color-mix(in srgb,var(--oc-focus,#0097e6) 20%,transparent)}
.mm-editor-drag-ghost{pointer-events:none}
.mm-editor-drag-ghost [data-key]{opacity:.92;filter:drop-shadow(0 6px 16px rgba(0,0,0,.28))}
.mm-editor-drag-source{opacity:.35}
.mm-editor-drop{position:absolute;display:none;pointer-events:none;box-sizing:border-box;z-index:2}
.mm-editor-drop-line{background:var(--oc-focus,#0097e6);border-radius:999px}
.mm-editor-drop-frame{border:2px solid var(--oc-focus,#0097e6);border-radius:8px}
.mm-editor-dragging{cursor:grabbing;user-select:none}
`;
const styleUsers = new WeakMap<Document, number>();

type NoteFormat = 'bold' | 'italic' | 'code' | 'link' | 'quote' | 'block';

const NOTE_ICON = 'M3 13l1-3.4L11 2.6a1.7 1.7 0 0 1 2.4 2.4L6.4 12 3 13zM9.9 3.7l2.4 2.4';

const NOTE_ACTIONS: ReadonlyArray<{ format: NoteFormat; name: string; icon: string }> = [
  {
    format: 'bold',
    name: 'Bold',
    icon: 'M5 3h3.3a2.35 2.35 0 0 1 0 4.7H5zM5 7.7h3.9a2.65 2.65 0 0 1 0 5.3H5z',
  },
  { format: 'italic', name: 'Italic', icon: 'M6.8 3h4.7M4.5 13h4.7M9.6 3 7 13' },
  { format: 'code', name: 'Inline code', icon: 'M5.8 5.2 3 8l2.8 2.8M10.2 5.2 13 8l-2.8 2.8' },
  {
    format: 'link',
    name: 'Link',
    icon: 'M6.7 9.3a2.4 2.4 0 0 0 3.4 0l1.8-1.8A2.4 2.4 0 0 0 8.5 4.1L7.4 5.2M9.3 6.7a2.4 2.4 0 0 0-3.4 0L4.1 8.5a2.4 2.4 0 0 0 3.4 3.4l1.1-1.1',
  },
  { format: 'quote', name: 'Quote', icon: 'M3.5 4v8M6.5 5h6M6.5 8h6M6.5 11h4' },
  {
    format: 'block',
    name: 'Code block',
    icon: 'M2.8 3.8h10.4v8.4H2.8zM6.4 6.6 4.8 8l1.6 1.4M9.6 6.6 11.2 8l-1.6 1.4',
  },
];

function noteIcon(doc: Document, path: string): SVGElement {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const shape = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  shape.setAttribute('fill', 'none');
  shape.setAttribute('stroke', 'currentColor');
  shape.setAttribute('stroke-width', '1.5');
  shape.setAttribute('stroke-linecap', 'round');
  shape.setAttribute('stroke-linejoin', 'round');
  svg.append(shape);
  return svg;
}

function acquireStyle(doc: Document): void {
  const count = styleUsers.get(doc) ?? 0;
  if (!count && !doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE;
    doc.head.append(style);
  }
  styleUsers.set(doc, count + 1);
}

function releaseStyle(doc: Document): void {
  const count = (styleUsers.get(doc) ?? 1) - 1;
  if (count > 0) {
    styleUsers.set(doc, count);
    return;
  }
  styleUsers.delete(doc);
  doc.getElementById(STYLE_ID)?.remove();
}

function backtickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/gu) ?? []) longest = Math.max(longest, run.length);
  return longest + 1;
}

interface Editing {
  nodeId: string;
  previewId: string;
  original: string;
  blank: boolean;
  createRoot: boolean;
  preview: boolean;
  folds: string[];
  field: HTMLTextAreaElement;
  draft: EditResult | null;
  draftText: string | null;
  emitted: string | null;
}

interface NotesEditing {
  nodeId: string;
  original: string;
  panel: HTMLDivElement;
  field: HTMLTextAreaElement;
}

type DropKind = 'before' | 'after' | 'child';

interface DropTarget {
  parentId: string;
  index: number;
  kind: DropKind;
  targetId: string;
}

interface DragState {
  nodeId: string;
  pointerId: number;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  active: boolean;
  ghost: SVGElement | null;
  sourceIds: string[];
  folds: string[];
  target: DropTarget | null;
  hover: number | null;
  pan: number | null;
  win: Window;
}

function sameTarget(left: DropTarget | null, right: DropTarget | null): boolean {
  if (!left || !right) return left === right;
  return (
    left.parentId === right.parentId &&
    left.index === right.index &&
    left.kind === right.kind &&
    left.targetId === right.targetId
  );
}

export class MarkmapEditor {
  private readonly view: EditView;
  private readonly container: HTMLElement;
  private readonly field: HTMLTextAreaElement;
  private readonly selectionBox: HTMLDivElement;
  private readonly indicator: HTMLDivElement;
  private readonly layer: HTMLDivElement;
  private readonly history = new History();
  private readonly onChange?: (change: EditorChange) => void;
  private readonly onDraftChange?: (change: EditorChange) => void;
  private readonly onError?: (error: Error) => void;
  private readonly placeholder: string;
  private readonly restorePosition: boolean;
  private readonly restoreTabIndex: boolean;
  private readonly stops: Array<() => void> = [];
  private doc: MarkdownDocument;
  private title = '';
  private selectedId: string | null = null;
  private selectionOffset = 0;
  private editing: Editing | null = null;
  private notes: NotesEditing | null = null;
  private drag: DragState | null = null;
  private suppressClick = false;
  private previewing = false;
  private destroyed = false;

  constructor({
    source,
    view,
    container,
    placeholder,
    onChange,
    onDraftChange,
    onError,
  }: MarkmapEditorOptions) {
    this.view = view;
    this.container = container;
    const parsed = parseDocument(source);
    this.doc = parsed.document;
    this.title = typeof parsed.frontmatter.title === 'string' ? parsed.frontmatter.title : '';
    this.onChange = onChange;
    this.onDraftChange = onDraftChange;
    this.onError = onError;
    this.placeholder = placeholder?.trim() || 'New topic';

    const doc = container.ownerDocument;
    acquireStyle(doc);
    const position = doc.defaultView?.getComputedStyle(container).position;
    this.restorePosition = !position || position === 'static';
    if (this.restorePosition) container.style.position = 'relative';
    this.restoreTabIndex = !container.hasAttribute('tabindex');
    if (this.restoreTabIndex) container.tabIndex = 0;

    this.layer = doc.createElement('div');
    this.layer.className = 'mm-editor-layer';
    this.selectionBox = doc.createElement('div');
    this.selectionBox.className = 'mm-editor-selection';
    this.indicator = doc.createElement('div');
    this.indicator.className = 'mm-editor-drop';
    this.field = doc.createElement('textarea');
    this.field.className = 'mm-editor-field';
    this.field.spellcheck = false;
    this.field.autocomplete = 'off';
    this.field.setAttribute('autocapitalize', 'off');
    this.field.setAttribute('wrap', 'soft');
    this.field.addEventListener('input', this.handleInput);
    this.layer.append(this.selectionBox, this.indicator, this.field);
    container.append(this.layer);

    container.addEventListener('keydown', this.handleKeyDown);
    container.addEventListener('click', this.handleClick);
    container.addEventListener('dblclick', this.handleDoubleClick);
    container.addEventListener('pointerdown', this.handlePointerDown, true);
    container.addEventListener('mousedown', this.handleMouseDown, true);
    this.stops.push(this.view.on('render', this.handleViewChange));
    this.stops.push(this.view.on('zoom', this.handleViewChange));

    this.selectedId = this.doc.root;
    this.selectionOffset = this.doc.nodes.get(this.doc.root)?.label?.start ?? 0;
    this.setMode(false);
    this.paintSelection();
  }

  get source(): string {
    return this.doc.source;
  }

  get document(): MarkdownDocument {
    return this.doc;
  }

  get selected(): string | null {
    return this.selectedId;
  }

  get selection(): number {
    return this.selectionOffset;
  }

  get isEditing(): boolean {
    return this.editing !== null;
  }

  get isEditingNotes(): boolean {
    return this.notes !== null;
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  focus(): void {
    this.container.focus({ preventScroll: true });
  }

  setSource(source: string, options: { selection?: number; emit?: boolean } = {}): void {
    const parsed = parseDocument(source);
    this.closeNotes(false);
    this.completeEditing('switch', false);
    this.doc = parsed.document;
    this.title = typeof parsed.frontmatter.title === 'string' ? parsed.frontmatter.title : '';
    this.history.clear();
    this.view.setTree(parsed.tree);
    const offset = options.selection ?? this.doc.nodes.get(this.doc.root)?.label?.start ?? 0;
    if (options.selection == null) {
      this.selectionOffset = offset;
      this.select(this.doc.root, { reveal: false });
    } else {
      this.selectAt(offset, { reveal: false });
    }
    if (options.emit) this.emitChange();
  }

  startEditing(
    nodeId: string | null = this.selectedId,
    options: { selectAll?: boolean; initialText?: string } = {},
  ): void {
    if (!nodeId) return;
    if (this.editing) {
      if (this.editing.nodeId === nodeId) return;
      if (this.commitEditing() === 'error') return;
    }
    const node = this.doc.nodes.get(nodeId);
    if (!node) return;
    const createRoot = this.canCreateRoot(node);
    if (!node.label && !createRoot) {
      const refusal = this.rootRefusal(node);
      if (refusal) this.onError?.(refusal);
      return;
    }
    const rect = this.view.screenRect(nodeId);
    if (!rect) return;
    const label = node.label ? labelText(this.doc, node) : '';
    const blank = createRoot || label === EMPTY_LABEL;
    const text = options.initialText ?? (blank ? '' : label);
    this.field.value = text;
    this.field.style.display = 'block';
    this.editing = {
      nodeId,
      previewId: nodeId,
      original: label,
      blank,
      createRoot,
      preview: false,
      folds: [...this.view.foldedIds],
      field: this.field,
      draft: null,
      draftText: null,
      emitted: null,
    };
    this.setMode(true);
    if (options.initialText !== undefined) this.previewEditing();
    this.paintEditing();
    this.positionEditing();
    this.paintSelection();
    this.field.focus({ preventScroll: true });
    if (options.selectAll) this.field.select();
    else this.field.setSelectionRange(text.length, text.length);
  }

  editNotes(nodeId?: string | null): boolean {
    const requested = nodeId ?? this.selectedId;
    if (!requested) return false;
    if (this.notes) {
      if (this.notes.nodeId === requested) return true;
      if (this.commitNotes({ keepOpen: false }) === 'error') return false;
    }
    if (this.editing && this.commitEditing() === 'error') return false;
    const id = nodeId ?? this.selectedId;
    if (!id) return false;
    const node = this.doc.nodes.get(id);
    if (!node) return false;
    if (node.opaque || !node.capabilities.editNotes) {
      this.onError?.(new EditError('E_CAPABILITY', 'The node cannot hold notes', node.id));
      return false;
    }
    const label = node.label ? labelText(this.doc, node) : '';
    if (!label.trim() && !(node.kind === 'root' && this.title)) {
      this.onError?.(new EditError('E_LABEL', 'The node has no label', node.id));
      return false;
    }
    if (!this.view.screenRect(node.id)) return false;
    this.select(node.id, { reveal: false });
    this.openNotes(node);
    return true;
  }

  snapshot(): string {
    if (this.notes) {
      this.commitNotes({ keepOpen: true });
      return this.doc.source;
    }
    const editing = this.editing;
    if (!editing) return this.doc.source;
    const text = editing.field.value;
    if (text === editing.original || (editing.blank && text === '')) return this.doc.source;
    if (editing.draft && editing.draftText === text) return editing.draft.document.source;
    return editing.emitted ?? this.doc.source;
  }

  setLabel(nodeId: string, text: string): boolean {
    if (!this.doc.nodes.has(nodeId)) return false;
    const before = this.historyEntry();
    const result = this.apply({ type: 'setLabel', node: nodeId, text });
    if (!result) return false;
    if (this.doc.source !== before.source) this.history.push(before);
    return true;
  }

  selectedBlock(): string | null {
    const node = this.selectedNode();
    if (!node) return null;
    if (node.block) {
      const block = node.block;
      if (node.kind !== 'root') return this.doc.source.slice(block.start, block.end);
      const before = node.notes.filter((note) => note.range.end <= block.start);
      const start = before.length
        ? Math.min(...before.map((note) => note.range.start))
        : block.start;
      return this.doc.source.slice(start, block.end);
    }
    if (node.id !== this.doc.root) return null;
    const children = node.children
      .map((id) => this.doc.nodes.get(id))
      .filter((child): child is EditNode => Boolean(child?.block));
    const first = children[0];
    const last = children[children.length - 1];
    const ranges = node.notes.map((note) => note.range);
    if (first?.block) ranges.push(first.block);
    if (last?.block) ranges.push(last.block);
    const start = ranges.length ? Math.min(...ranges.map((range) => range.start)) : null;
    const end = ranges.length ? Math.max(...ranges.map((range) => range.end)) : null;
    const body = start == null || end == null ? '' : this.doc.source.slice(start, end);
    const title = this.title.replace(/\s+/gu, ' ').trim();
    if (!title) return body || null;
    const heading = `# ${title}`;
    const ending = lineEnding(this.doc.source);
    return body ? `${heading}${ending}${ending}${body}` : heading;
  }

  insertBlock(text: string): boolean {
    return this.runSelected({ type: 'insertBlock', text }) !== null;
  }

  insertLabel(text: string): boolean {
    return this.runSelected({ type: 'insertChild', text }) !== null;
  }

  deleteSelected(): boolean {
    return this.runSelected({ type: 'delete' }) !== null;
  }

  commit(): void {
    if (this.notes) {
      this.commitNotes({ keepOpen: false });
      return;
    }
    this.commitEditing();
  }

  undo(): boolean {
    const entry = this.history.undo(this.historyEntry());
    if (!entry) return false;
    this.restore(entry);
    return true;
  }

  redo(): boolean {
    const entry = this.history.redo(this.historyEntry());
    if (!entry) return false;
    this.restore(entry);
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const stop of this.stops) stop();
    this.stops.length = 0;
    this.container.removeEventListener('keydown', this.handleKeyDown);
    this.container.removeEventListener('click', this.handleClick);
    this.container.removeEventListener('dblclick', this.handleDoubleClick);
    this.container.removeEventListener('pointerdown', this.handlePointerDown, true);
    this.container.removeEventListener('mousedown', this.handleMouseDown, true);
    this.field.removeEventListener('input', this.handleInput);
    this.cancelDrag();
    this.closeNotes(false);
    this.layer.remove();
    releaseStyle(this.container.ownerDocument);
    if (this.restorePosition) this.container.style.position = '';
    if (this.restoreTabIndex) this.container.removeAttribute('tabindex');
    this.container.classList.remove(MODE_SELECT, MODE_EDIT);
    this.editing = null;
    this.selectedId = null;
  }

  private handleInput = (): void => {
    if (!this.editing) return;
    this.previewEditing();
    this.positionEditing();
    this.paintSelection();
    this.paintEditing();
  };

  private handleViewChange = (): void => {
    if (this.notes) this.positionNotes();
    if (this.previewing) return;
    if (this.editing) this.positionEditing();
    this.paintSelection();
    this.paintEditing();
    const drag = this.drag;
    if (drag?.active) {
      this.paintDragSource(drag);
      this.paintDropTarget(drag);
    }
  };

  private handleClick = (event: MouseEvent): void => {
    if (this.suppressClick) {
      this.suppressClick = false;
      event.preventDefault();
      return;
    }
    const target = event.target;
    if (this.notes) {
      if (target instanceof Node && this.notes.panel.contains(target)) return;
      if (this.commitNotes({ keepOpen: false }) === 'error') return;
    }
    if (this.editing && target instanceof Node && this.editing.field.contains(target)) return;
    if (event.button !== 0) return;
    if (this.editing && this.commitEditing() === 'error') return;
    const hit = this.hitAt(event);
    if (!hit) {
      this.select(null, { reveal: false });
      this.container.blur();
      return;
    }
    if ((hit.kind === 'node' || hit.kind === 'toggle') && hit.nodeId) {
      this.select(hit.nodeId, { reveal: false });
      this.container.focus({ preventScroll: true });
    }
  };

  private handleDoubleClick = (event: MouseEvent): void => {
    if (this.editing || this.notes) return;
    const hit = this.hitAt(event);
    if (hit?.kind === 'node' && hit.nodeId) {
      this.select(hit.nodeId, { reveal: false });
      this.startEditing(hit.nodeId);
      event.preventDefault();
    }
  };

  private handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    if (this.notes) {
      const target = event.target;
      if (!(target instanceof Node) || !this.notes.panel.contains(target)) {
        if (this.commitNotes({ keepOpen: false }) === 'error') {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
    }
    if (!this.dragNodeAt(event)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    if (event.button !== 0 || event.isPrimary === false) return;
    if (this.destroyed) return;
    if (this.notes) {
      const target = event.target;
      if (!(target instanceof Node) || !this.notes.panel.contains(target)) {
        if (this.commitNotes({ keepOpen: false }) === 'error') return;
      }
    }
    const nodeId = this.dragNodeAt(event);
    if (!nodeId) return;
    const node = this.doc.nodes.get(nodeId);
    if (!node?.capabilities.move) return;
    if (this.editing && this.commitEditing() === 'error') return;
    const win = this.container.ownerDocument.defaultView;
    if (!win) return;
    this.drag = {
      nodeId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      active: false,
      ghost: null,
      sourceIds: this.subtreeIds(nodeId),
      folds: [...this.view.foldedIds],
      target: null,
      hover: null,
      pan: null,
      win,
    };
    win.addEventListener('pointermove', this.handlePointerMove, true);
    win.addEventListener('pointerup', this.handlePointerUp, true);
    win.addEventListener('pointercancel', this.handlePointerCancel, true);
    win.addEventListener('keydown', this.handleDragKey, true);
  };

  private handlePointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD) {
        return;
      }
      this.startDrag(drag);
      return;
    }
    this.updateDrag(drag);
  };

  private handlePointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      this.finishDrag(false);
      return;
    }
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    this.updateDrag(drag);
    this.finishDrag(drag.target !== null);
  };

  private handlePointerCancel = (): void => {
    this.finishDrag(false);
  };

  private handleDragKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.finishDrag(false);
  };

  private dragNodeAt(event: {
    target: EventTarget | null;
    clientX: number;
    clientY: number;
  }): string | null {
    const target = event.target;
    if (target instanceof Node) {
      if (this.field.contains(target)) return null;
      if (this.notes?.panel.contains(target)) return null;
    }
    const hit = this.hitAt(event);
    return hit?.kind === 'node' && hit.nodeId ? hit.nodeId : null;
  }

  private startDrag(drag: DragState): void {
    drag.active = true;
    this.select(drag.nodeId, { reveal: false });
    this.container.classList.add('mm-editor-dragging');
    if (typeof this.container.setPointerCapture === 'function') {
      this.container.setPointerCapture(drag.pointerId);
    }
    const ghost = this.buildGhost(drag.nodeId, drag.sourceIds);
    drag.ghost = ghost;
    this.view.element.append(ghost);
    this.paintDragSource(drag);
    this.updateDrag(drag);
  }

  private updateDrag(drag: DragState): void {
    if (drag.ghost) {
      drag.ghost.style.transform = `translate(${drag.clientX - drag.startX}px, ${
        drag.clientY - drag.startY
      }px)`;
    }
    const next = this.dropTargetAt(drag, drag.clientX, drag.clientY);
    if (!sameTarget(drag.target, next)) {
      drag.target = next;
      this.paintDropTarget(drag);
      this.scheduleHover(drag);
    }
    this.updateAutoPan(drag);
  }

  private buildGhost(nodeId: string, ids: string[]): SVGElement {
    const svg = this.view.element;
    const ghost = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
    ghost.classList.add('mm-editor-drag-ghost');
    const content = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
    const { k, x, y } = this.view.transform;
    content.setAttribute('transform', `matrix(${k} 0 0 ${k} ${x} ${y})`);
    const keys = new Set<string>();
    for (const id of ids) {
      keys.add(`node:${id}`);
      if (id !== nodeId) keys.add(`edge:${id}`);
    }
    for (const element of svg.querySelectorAll('[data-key]')) {
      const key = element.getAttribute('data-key');
      if (key && keys.has(key)) content.append(element.cloneNode(true));
    }
    ghost.append(content);
    return ghost;
  }

  private paintDragSource(drag: DragState): void {
    this.clearDragSource();
    for (const id of drag.sourceIds) {
      this.view.element
        .querySelector(`[data-key="node:${id}"]`)
        ?.classList.add('mm-editor-drag-source');
      this.view.element
        .querySelector(`[data-key="edge:${id}"]`)
        ?.classList.add('mm-editor-drag-source');
    }
  }

  private clearDragSource(): void {
    for (const element of this.view.element.querySelectorAll('.mm-editor-drag-source')) {
      element.classList.remove('mm-editor-drag-source');
    }
  }

  private paintDropTarget(drag: DragState): void {
    const target = drag.target;
    const rect = target ? this.view.screenRect(target.targetId) : undefined;
    if (!target || !rect) {
      this.indicator.style.display = 'none';
      return;
    }
    const box = this.container.getBoundingClientRect();
    const style = this.indicator.style;
    this.indicator.className = 'mm-editor-drop';
    if (target.kind === 'child') {
      this.indicator.classList.add('mm-editor-drop-frame');
      style.left = `${rect.x - box.x - 3}px`;
      style.top = `${rect.y - box.y - 3}px`;
      style.width = `${rect.width + 6}px`;
      style.height = `${rect.height + 6}px`;
    } else {
      this.indicator.classList.add('mm-editor-drop-line');
      if (this.isVertical(target.targetId)) {
        const left = target.kind === 'before' ? rect.x - 6 : rect.x + rect.width + 4;
        style.left = `${left - box.x}px`;
        style.top = `${rect.y - box.y}px`;
        style.width = '2px';
        style.height = `${Math.max(rect.height, 24)}px`;
      } else {
        const top = target.kind === 'before' ? rect.y - 6 : rect.y + rect.height + 4;
        style.left = `${rect.x - box.x}px`;
        style.top = `${top - box.y}px`;
        style.width = `${Math.max(rect.width, 24)}px`;
        style.height = '2px';
      }
    }
    style.display = 'block';
  }

  private dropTargetAt(drag: DragState, x: number, y: number): DropTarget | null {
    const dragged = this.doc.nodes.get(drag.nodeId);
    if (!dragged) return null;
    const excluded = new Set(drag.sourceIds);
    const boxes: Array<{ node: EditNode; rect: Rect }> = [];
    for (const id of this.doc.order) {
      const node = this.doc.nodes.get(id);
      if (!node || node.id === this.doc.root || excluded.has(node.id) || node.opaque) continue;
      const rect = this.view.screenRect(node.id);
      if (rect) boxes.push({ node, rect });
    }
    for (const box of boxes) {
      if (
        x >= box.rect.x - 4 &&
        x <= box.rect.x + box.rect.width + 4 &&
        y >= box.rect.y - 4 &&
        y <= box.rect.y + box.rect.height + 4
      ) {
        return this.zoneTarget(dragged, box.node, box.rect, x, y, false);
      }
    }
    const root = this.doc.nodes.get(this.doc.root);
    if (root) {
      const rootRect = this.view.screenRect(root.id);
      if (
        rootRect &&
        x >= rootRect.x - 48 &&
        x <= rootRect.x + rootRect.width + 48 &&
        y >= rootRect.y - 48 &&
        y <= rootRect.y + rootRect.height + 48
      ) {
        return this.rootTarget(root, dragged, rootRect, x, y);
      }
    }
    let nearest: { node: EditNode; rect: Rect } | null = null;
    let distance = 24;
    for (const box of boxes) {
      const dx = Math.max(box.rect.x - x, 0, x - box.rect.x - box.rect.width);
      const dy = Math.max(box.rect.y - y, 0, y - box.rect.y - box.rect.height);
      const current = Math.hypot(dx, dy);
      if (current <= distance) {
        distance = current;
        nearest = box;
      }
    }
    return nearest ? this.zoneTarget(dragged, nearest.node, nearest.rect, x, y, true) : null;
  }

  private zoneTarget(
    dragged: EditNode,
    node: EditNode,
    rect: Rect,
    x: number,
    y: number,
    gap: boolean,
  ): DropTarget | null {
    const vertical = this.isVertical(node.id);
    let kind: DropKind;
    if (gap) {
      const before = vertical ? x < rect.x + rect.width / 2 : y < rect.y + rect.height / 2;
      kind = before ? 'before' : 'after';
    } else if (vertical) {
      const quarter = Math.max(4, rect.width / 4);
      if (x < rect.x + quarter) kind = 'before';
      else if (x > rect.x + rect.width - quarter) kind = 'after';
      else kind = 'child';
    } else {
      const quarter = Math.max(4, rect.height / 4);
      if (y < rect.y + quarter) kind = 'before';
      else if (y > rect.y + rect.height - quarter) kind = 'after';
      else kind = 'child';
    }
    if (kind === 'child') {
      if (!node.capabilities.addChild) {
        kind = vertical
          ? x < rect.x + rect.width / 2
            ? 'before'
            : 'after'
          : y < rect.y + rect.height / 2
            ? 'before'
            : 'after';
      } else {
        return {
          parentId: node.id,
          index: node.children.filter((id) => id !== dragged.id).length,
          kind,
          targetId: node.id,
        };
      }
    }
    const parentId = node.parent;
    if (!parentId) return null;
    const parent = this.doc.nodes.get(parentId);
    if (!parent) return null;
    const siblings = parent.children.filter((id) => id !== dragged.id);
    const base = siblings.indexOf(node.id);
    return {
      parentId,
      index: kind === 'before' ? base : base + 1,
      kind,
      targetId: node.id,
    };
  }

  private rootTarget(
    root: EditNode,
    dragged: EditNode,
    rootRect: Rect,
    x: number,
    y: number,
  ): DropTarget | null {
    const siblings = root.children.filter((id) => id !== dragged.id);
    if (!siblings.length) return null;
    const wanted = x < rootRect.x + rootRect.width / 2 ? 'left' : 'right';
    const sided = siblings.filter((id) => this.view.direction(id) === wanted);
    const pool = sided.length ? sided : siblings;
    let nearest = pool[0];
    let nearestRect = this.view.screenRect(nearest);
    let best = Infinity;
    for (const id of pool) {
      const rect = this.view.screenRect(id);
      if (!rect) continue;
      const distance = Math.hypot(x - (rect.x + rect.width / 2), y - (rect.y + rect.height / 2));
      if (distance < best) {
        best = distance;
        nearest = id;
        nearestRect = rect;
      }
    }
    if (!nearestRect) return null;
    const vertical = this.isVertical(nearest);
    const before = vertical
      ? x < nearestRect.x + nearestRect.width / 2
      : y < nearestRect.y + nearestRect.height / 2;
    const base = siblings.indexOf(nearest);
    return {
      parentId: root.id,
      index: before ? base : base + 1,
      kind: before ? 'before' : 'after',
      targetId: nearest,
    };
  }

  private isVertical(id: string): boolean {
    const direction = this.view.direction(id);
    return direction === 'top' || direction === 'bottom';
  }

  private scheduleHover(drag: DragState): void {
    if (drag.hover !== null) {
      drag.win.clearTimeout(drag.hover);
      drag.hover = null;
    }
    const target = drag.target;
    if (!target || target.kind !== 'child' || !this.view.foldedIds.has(target.targetId)) return;
    drag.hover = drag.win.setTimeout(() => {
      drag.hover = null;
      this.view.setFolded(target.targetId, false);
      this.updateDrag(drag);
    }, DRAG_EXPAND_MS);
  }

  private updateAutoPan(drag: DragState): void {
    if (this.edgeVector(drag.clientX, drag.clientY) === null) {
      this.stopAutoPan();
      return;
    }
    if (drag.pan !== null) return;
    const step = (): void => {
      const current = this.drag;
      if (!current?.active) {
        this.stopAutoPan();
        return;
      }
      const vector = this.edgeVector(current.clientX, current.clientY);
      if (!vector) {
        this.stopAutoPan();
        return;
      }
      this.view.panBy(vector.x, vector.y);
      current.pan = current.win.requestAnimationFrame(step);
      this.afterPan(current);
    };
    drag.pan = drag.win.requestAnimationFrame(step);
  }

  private stopAutoPan(): void {
    const drag = this.drag;
    if (!drag || drag.pan === null) return;
    drag.win.cancelAnimationFrame(drag.pan);
    drag.pan = null;
  }

  private edgeVector(x: number, y: number): { x: number; y: number } | null {
    const box = this.container.getBoundingClientRect();
    const left = x - box.x;
    const right = box.x + box.width - x;
    const top = y - box.y;
    const bottom = box.y + box.height - y;
    const closest = Math.min(left, right, top, bottom);
    if (closest > DRAG_EDGE) return null;
    const speed = Math.max(1, ((DRAG_EDGE - Math.max(0, closest)) / DRAG_EDGE) * DRAG_PAN_MAX);
    const vector = { x: 0, y: 0 };
    if (left < DRAG_EDGE) vector.x = speed;
    else if (right < DRAG_EDGE) vector.x = -speed;
    if (top < DRAG_EDGE) vector.y = speed;
    else if (bottom < DRAG_EDGE) vector.y = -speed;
    return vector;
  }

  private afterPan(drag: DragState): void {
    const next = this.dropTargetAt(drag, drag.clientX, drag.clientY);
    if (!sameTarget(drag.target, next)) {
      drag.target = next;
      this.paintDropTarget(drag);
      this.scheduleHover(drag);
    }
  }

  private finishDrag(drop: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    this.stopAutoPan();
    if (drag.hover !== null) {
      drag.win.clearTimeout(drag.hover);
      drag.hover = null;
    }
    drag.win.removeEventListener('pointermove', this.handlePointerMove, true);
    drag.win.removeEventListener('pointerup', this.handlePointerUp, true);
    drag.win.removeEventListener('pointercancel', this.handlePointerCancel, true);
    drag.win.removeEventListener('keydown', this.handleDragKey, true);
    if (drag.active) {
      if (typeof this.container.releasePointerCapture === 'function') {
        this.container.releasePointerCapture(drag.pointerId);
      }
      this.suppressClick = true;
      this.applyFoldState(drag.folds);
      if (drop && drag.target) {
        this.moveTo(drag.target.parentId, drag.target.index, drag.nodeId);
      }
    }
    const ghost = drag.ghost;
    if (ghost) {
      if (drag.active && !drop) {
        ghost.style.transition = `transform ${SNAP_BACK_MS}ms ease, opacity ${SNAP_BACK_MS}ms ease`;
        ghost.style.transform = 'translate(0px, 0px)';
        ghost.style.opacity = '0';
        drag.win.setTimeout(() => ghost.remove(), SNAP_BACK_MS);
      } else {
        ghost.remove();
      }
    }
    drag.ghost = null;
    this.container.classList.remove('mm-editor-dragging');
    this.clearDragSource();
    this.indicator.style.display = 'none';
    this.drag = null;
    this.paintSelection();
    this.container.focus({ preventScroll: true });
  }

  private cancelDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.stopAutoPan();
    if (drag.hover !== null) drag.win.clearTimeout(drag.hover);
    drag.win.removeEventListener('pointermove', this.handlePointerMove, true);
    drag.win.removeEventListener('pointerup', this.handlePointerUp, true);
    drag.win.removeEventListener('pointercancel', this.handlePointerCancel, true);
    drag.win.removeEventListener('keydown', this.handleDragKey, true);
    if (typeof this.container.releasePointerCapture === 'function') {
      this.container.releasePointerCapture(drag.pointerId);
    }
    drag.ghost?.remove();
    this.container.classList.remove('mm-editor-dragging');
    this.clearDragSource();
    this.indicator.style.display = 'none';
    this.drag = null;
  }

  private applyFoldState(ids: string[]): void {
    this.view.setFoldedIds(ids, { animate: false });
  }

  private subtreeIds(id: string): string[] {
    const ids: string[] = [];
    const visit = (nodeId: string): void => {
      ids.push(nodeId);
      const node = this.doc.nodes.get(nodeId);
      if (!node) return;
      for (const child of node.children) visit(child);
    };
    visit(id);
    return ids;
  }

  private moveByKey(key: string): void {
    const node = this.selectedNode();
    if (!node?.parent) return;
    const parent = this.doc.nodes.get(node.parent);
    if (!parent) return;
    const index = parent.children.indexOf(node.id);
    if (key === 'ArrowUp' && index > 0) {
      this.moveTo(parent.id, index - 1, node.id);
      return;
    }
    if (key === 'ArrowDown' && index < parent.children.length - 1) {
      this.moveTo(parent.id, index + 1, node.id);
      return;
    }
    if (key === 'ArrowLeft' && index > 0) {
      const previous = this.doc.nodes.get(parent.children[index - 1]);
      if (previous) this.moveTo(previous.id, previous.children.length, node.id);
      return;
    }
    if (key === 'ArrowRight' && parent.parent) {
      const grand = this.doc.nodes.get(parent.parent);
      if (grand) this.moveTo(grand.id, grand.children.indexOf(parent.id) + 1, node.id);
    }
  }

  private moveTo(parentId: string, index: number, nodeId: string): boolean {
    const node = this.doc.nodes.get(nodeId);
    if (!node) return false;
    if (node.parent === parentId) {
      const parent = this.doc.nodes.get(parentId);
      if (parent && parent.children.indexOf(node.id) === index) return false;
    }
    const result = this.run({ type: 'move', node: node.id, parent: parentId, index });
    if (!result) return false;
    if (this.selectedId) this.ensureVisible(this.selectedId);
    return true;
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    if (event.isComposing || event.keyCode === 229) return;
    if (this.notes) {
      this.handleNotesKey(event);
      return;
    }
    if (this.editing) {
      this.handleEditingKey(event);
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && event.key === '/') {
      event.preventDefault();
      if (this.selectedId) this.view.toggle(this.selectedId);
      return;
    }
    if (!this.selectedId) return;
    if (mod && event.shiftKey && event.key.startsWith('Arrow')) {
      event.preventDefault();
      this.moveByKey(event.key);
      return;
    }
    switch (event.key) {
      case 'Enter':
        event.preventDefault();
        this.insertAndEdit('insertSibling');
        return;
      case 'Tab':
        event.preventDefault();
        if (event.shiftKey) this.runSelected({ type: 'outdent' });
        else this.insertAndEdit('insertChild');
        return;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        if (this.selectedNode()?.kind === 'root') return;
        this.runSelected({ type: 'delete' });
        return;
      case ' ':
        if (event.altKey || mod || event.shiftKey) return;
        event.preventDefault();
        this.startEditing();
        return;
      case 'Escape':
        event.preventDefault();
        return;
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
        event.preventDefault();
        this.navigate(event.key);
        return;
      default:
        if (event.altKey || mod || event.key.length !== 1) return;
        if (!this.isEmptyLabel(this.selectedNode())) return;
        event.preventDefault();
        this.startEditing(this.selectedId, { initialText: event.key });
    }
  };

  private handleEditingKey(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'z') {
      const editing = this.editing;
      const changed =
        editing !== null &&
        !(
          editing.field.value === editing.original ||
          (editing.blank && editing.field.value === '')
        );
      if (editing && !event.shiftKey && changed) {
        event.preventDefault();
        const field = editing.field;
        field.value = editing.original;
        field.setSelectionRange(field.value.length, field.value.length);
        this.previewEditing();
        this.positionEditing();
        this.paintSelection();
        this.paintEditing();
        return;
      }
      if (editing && !changed) {
        event.preventDefault();
        const emitted = editing.emitted;
        this.completeEditing('switch');
        const undone = event.shiftKey ? this.redo() : this.undo();
        if (!undone) this.publishBaseline(emitted);
      }
      return;
    }
    const editing = this.editing;
    if (
      editing &&
      (event.key === 'Backspace' || event.key === 'Delete') &&
      editing.blank &&
      editing.field.value === ''
    ) {
      const node = this.doc.nodes.get(editing.nodeId);
      if (node?.kind === 'root') return;
      event.preventDefault();
      this.completeEditing('switch');
      this.select(editing.nodeId, { reveal: false });
      this.runSelected({ type: 'delete' });
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelEditing();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.commitEditing();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      this.commitAndInsert(event.shiftKey ? 'outdent' : 'insertChild');
      return;
    }
    if (event.key === 'Enter' && event.shiftKey) {
      const node = this.editing ? this.doc.nodes.get(this.editing.nodeId) : undefined;
      if (node && (node.kind === 'heading' || node.kind === 'root')) {
        event.preventDefault();
        this.onError?.(
          new EditError('E_LABEL', 'A heading label cannot contain a line break', node.id),
        );
      }
    }
  }

  private handleNotesKey(event: KeyboardEvent): void {
    const notes = this.notes;
    if (!notes) return;
    const target = event.target;
    if (!(target instanceof Node) || !notes.panel.contains(target)) {
      notes.field.focus({ preventScroll: true });
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeNotes();
      return;
    }
    if (event.key === 'Enter' && mod) {
      event.preventDefault();
      this.commitNotes({ keepOpen: false });
      return;
    }
    if (mod && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      this.formatNotes('bold');
      return;
    }
    if (mod && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      this.formatNotes('italic');
    }
  }

  private openNotes(node: EditNode): void {
    const doc = this.container.ownerDocument;
    const panel = doc.createElement('div');
    panel.className = 'mm-editor-notes';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Notes');

    const header = doc.createElement('div');
    header.className = 'mm-editor-notes-header';
    const icon = noteIcon(doc, NOTE_ICON);
    icon.classList.add('mm-editor-notes-icon');
    const title = doc.createElement('span');
    title.className = 'mm-editor-notes-title';
    title.textContent = 'Notes';
    const label = doc.createElement('span');
    label.className = 'mm-editor-notes-label';
    label.textContent = 'Markdown';
    header.append(icon, title, label);

    const toolbar = doc.createElement('div');
    toolbar.className = 'mm-editor-notes-toolbar';
    toolbar.addEventListener('mousedown', (event) => event.preventDefault());
    for (const action of NOTE_ACTIONS) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'mm-editor-notes-button';
      button.setAttribute('aria-label', action.name);
      button.setAttribute('title', action.name);
      button.append(noteIcon(doc, action.icon));
      button.addEventListener('click', () => this.formatNotes(action.format));
      toolbar.append(button);
    }

    const field = doc.createElement('textarea');
    field.className = 'mm-editor-notes-field';
    field.setAttribute('aria-label', 'Note text');
    field.spellcheck = false;
    field.value = notesText(this.doc, node);

    panel.append(header, toolbar, field);
    this.layer.append(panel);
    this.notes = { nodeId: node.id, original: field.value, panel, field };
    doc.addEventListener('mousedown', this.handleDocumentMouseDown);
    this.positionNotes();
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  }

  private handleDocumentMouseDown = (event: MouseEvent): void => {
    const notes = this.notes;
    if (!notes) return;
    const target = event.target;
    if (target instanceof Node && notes.panel.contains(target)) return;
    this.commitNotes({ keepOpen: false });
  };

  private closeNotes(focus = true): void {
    const notes = this.notes;
    if (!notes) return;
    this.container.ownerDocument.removeEventListener('mousedown', this.handleDocumentMouseDown);
    notes.panel.remove();
    this.notes = null;
    if (focus && !this.destroyed) this.container.focus({ preventScroll: true });
  }

  private commitNotes(options: { keepOpen: boolean }): 'none' | 'changed' | 'error' {
    const notes = this.notes;
    if (!notes) return 'none';
    const text = notes.field.value;
    if (text === notes.original) {
      if (!options.keepOpen) this.closeNotes();
      return 'none';
    }
    const before = this.historyEntry();
    const result = this.apply({ type: 'setNotes', node: notes.nodeId, text });
    if (!result) return 'error';
    notes.original = text;
    if (result.edits.length) this.history.push(before);
    if (options.keepOpen) {
      notes.field.focus({ preventScroll: true });
      this.positionNotes();
    } else {
      this.closeNotes();
    }
    return result.edits.length ? 'changed' : 'none';
  }

  private positionNotes(): void {
    const notes = this.notes;
    if (!notes) return;
    const rect = this.view.screenRect(notes.nodeId);
    if (!rect) {
      this.closeNotes();
      return;
    }
    const box = this.container.getBoundingClientRect();
    const margin = 8;
    const width = Math.max(0, Math.min(400, box.width - margin * 2));
    notes.panel.style.width = `${width}px`;
    notes.panel.style.maxHeight = `${Math.max(80, box.height / 2)}px`;
    const height = notes.panel.getBoundingClientRect().height || 220;
    const below = rect.y + rect.height + margin;
    const above = rect.y - margin - height;
    const preferred = below + height <= box.y + box.height ? below : above;
    const top = Math.max(box.y + margin, Math.min(preferred, box.y + box.height - margin - height));
    const left = Math.max(
      box.x + margin,
      Math.min(rect.x + rect.width / 2 - width / 2, box.x + box.width - margin - width),
    );
    notes.panel.style.left = `${left - box.x}px`;
    notes.panel.style.top = `${top - box.y}px`;
  }

  private formatNotes(format: NoteFormat): void {
    const notes = this.notes;
    if (!notes) return;
    const field = notes.field;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const value = field.value;
    const selected = value.slice(start, end);
    if (format === 'bold') {
      this.wrapNotes(field, '**', '**');
      return;
    }
    if (format === 'italic') {
      this.wrapNotes(field, '_', '_');
      return;
    }
    if (format === 'code') {
      const run = '`'.repeat(backtickRun(selected));
      this.wrapNotes(field, run, run);
      return;
    }
    if (format === 'link') {
      const url = start + selected.length + 3;
      field.value = `${value.slice(0, start)}[${selected}](url)${value.slice(end)}`;
      field.focus({ preventScroll: true });
      field.setSelectionRange(url, url + 3);
      this.positionNotes();
      return;
    }
    if (format === 'quote') {
      if (!selected) {
        const from = value.lastIndexOf('\n', start - 1) + 1;
        const caret = start + 2;
        field.value = `${value.slice(0, from)}> ${value.slice(from)}`;
        field.focus({ preventScroll: true });
        field.setSelectionRange(caret, caret);
        this.positionNotes();
        return;
      }
      const from = value.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = value.indexOf('\n', end);
      const to = lineEnd === -1 ? value.length : lineEnd;
      const quoted = value
        .slice(from, to)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      field.value = value.slice(0, from) + quoted + value.slice(to);
      field.focus({ preventScroll: true });
      field.setSelectionRange(from, from + quoted.length);
      this.positionNotes();
      return;
    }
    const fence = '`'.repeat(Math.max(3, backtickRun(selected)));
    const body = selected
      ? `${fence}\n${selected}${selected.endsWith('\n') ? '' : '\n'}${fence}`
      : `${fence}\n\n${fence}`;
    const caret = start + fence.length + 1;
    field.value = value.slice(0, start) + body + value.slice(end);
    field.focus({ preventScroll: true });
    field.setSelectionRange(caret, caret);
    this.positionNotes();
  }

  private wrapNotes(field: HTMLTextAreaElement, prefix: string, suffix: string): void {
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const value = field.value;
    const selected = value.slice(start, end);
    field.value = `${value.slice(0, start)}${prefix}${selected}${suffix}${value.slice(end)}`;
    const caret = start + prefix.length;
    field.focus({ preventScroll: true });
    field.setSelectionRange(caret, selected ? caret + selected.length : caret);
    this.positionNotes();
  }

  private insertAndEdit(kind: 'insertSibling' | 'insertChild'): void {
    const id = this.selectedId;
    if (!id) return;
    const node = this.doc.nodes.get(id);
    if (!node) return;
    if (kind === 'insertSibling' && node.kind === 'root') {
      if (this.canCreateRoot(node)) {
        this.startEditing(id, { selectAll: true });
        return;
      }
      if (!node.block) {
        const refusal = this.rootRefusal(node);
        if (refusal) this.onError?.(refusal);
        return;
      }
      kind = 'insertChild';
    }
    const result = this.run({ type: kind, node: id, text: this.placeholder });
    if (result) this.editCreated(result);
  }

  private editCreated(result: EditResult): void {
    const created = nodeAtOffset(result.document, result.selection);
    if (!created) return;
    this.select(created.id);
    this.startEditing(created.id, { selectAll: true });
  }

  private runSelected(command: CommandWithoutNode): EditResult | null {
    const id = this.selectedId;
    if (!id) return null;
    return this.run({ ...command, node: id });
  }

  private run(command: Command): EditResult | null {
    const before = this.historyEntry();
    const result = this.apply(command);
    if (result && this.doc.source !== before.source) this.history.push(before);
    return result;
  }

  private apply(command: Command): EditResult | null {
    const folds = this.captureFolds(this.doc);
    const editing = this.editing;
    try {
      const source = this.doc.source;
      const result = applyCommand(this.doc, command);
      this.doc = result.document;
      if (this.doc.source === source) return result;
      if (!result.edits.length) return result;
      if (editing && command.type === 'setLabel' && command.node === editing.nodeId) {
        const target = nodeAtOffset(result.document, result.selection);
        if (target) {
          editing.nodeId = target.id;
          editing.previewId = target.id;
        }
      }
      this.view.setTree(result.tree);
      this.restoreFolds(folds, result);
      this.selectAt(result.selection, { reveal: false });
      if (command.type === 'setNotes') this.select(command.node, { reveal: false });
      this.emitChange();
      return result;
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  private commitEditing(options: { history?: boolean } = {}): 'none' | 'changed' | 'error' {
    const editing = this.editing;
    if (!editing) return 'none';
    const text = editing.field.value;
    if (text === editing.original || (editing.blank && text === '')) {
      this.completeEditing('cancel');
      return 'none';
    }
    const before = this.historyEntry();
    const source = this.doc.source;
    const result = editing.createRoot
      ? this.apply({ type: 'createRootHeading', node: editing.nodeId, text })
      : this.apply({ type: 'setLabel', node: editing.nodeId, text });
    if (!result) return 'error';
    if (this.doc.source === source) {
      this.completeEditing('cancel');
      return 'none';
    }
    if (options.history !== false) this.history.push(before);
    this.completeEditing('commit', false);
    return 'changed';
  }

  private cancelEditing(): void {
    this.completeEditing('cancel');
  }

  private commitAndInsert(kind: 'insertChild' | 'outdent'): void {
    const before = this.historyEntry();
    const source = this.doc.source;
    const state = this.commitEditing({ history: false });
    if (state === 'error') return;
    const node = this.selectedNode();
    if (!node) return;
    if (kind === 'outdent') {
      this.apply({ type: 'outdent', node: node.id });
      if (this.doc.source !== source) this.history.push(before);
      return;
    }
    const result = this.apply({
      type: kind,
      node: node.id,
      text: this.placeholder,
    });
    if (this.doc.source !== source) this.history.push(before);
    if (result) this.editCreated(result);
  }

  private previewEditing(): void {
    const editing = this.editing;
    if (!editing) return;
    const text = editing.field.value;
    if (text === editing.original || (editing.blank && text === '')) {
      this.restorePreview(editing, true);
      return;
    }
    const folds = this.captureFolds(this.doc);
    try {
      const result = applyCommand(
        this.doc,
        editing.createRoot
          ? { type: 'createRootHeading', node: editing.nodeId, text }
          : { type: 'setLabel', node: editing.nodeId, text },
      );
      this.previewing = true;
      try {
        this.view.setTree(result.tree);
        this.restoreFolds(folds, result);
      } finally {
        this.previewing = false;
      }
      const target = nodeAtOffset(result.document, result.selection);
      editing.previewId = target?.id ?? editing.previewId;
      editing.preview = true;
      editing.draft = result;
      editing.draftText = text;
      const source = result.document.source;
      if (source === this.doc.source) {
        const emitted = editing.emitted;
        editing.emitted = null;
        this.publishBaseline(emitted);
      } else if (editing.emitted !== source) {
        editing.emitted = source;
        this.emitDraftChange({
          source,
          selection: result.selection,
          document: result.document,
        });
      }
    } catch {
      this.previewing = false;
    }
  }

  private restorePreview(editing: Editing, notifyBaseline = false): void {
    if (editing.preview) {
      const parsed = parseDocument(this.doc.source);
      this.previewing = true;
      try {
        this.view.setTree(parsed.tree);
        this.view.setFoldedIds(editing.folds, { animate: false });
      } finally {
        this.previewing = false;
      }
      editing.preview = false;
      editing.previewId = editing.nodeId;
      this.selectedId = editing.nodeId;
    }
    editing.draft = null;
    editing.draftText = null;
    const emitted = editing.emitted;
    editing.emitted = null;
    if (notifyBaseline) this.publishBaseline(emitted);
  }

  private setMode(editing: boolean): void {
    this.container.classList.toggle(MODE_EDIT, editing);
    this.container.classList.toggle(MODE_SELECT, !editing);
  }

  private completeEditing(reason: 'commit' | 'cancel' | 'lost' | 'switch', restore = true): void {
    const editing = this.editing;
    if (!editing) return;
    const emitted = editing.emitted;
    this.stopEditingUi(restore);
    if ((reason === 'cancel' || reason === 'lost') && emitted !== null) {
      this.publishBaseline(emitted);
    }
  }

  private publishBaseline(emitted: string | null): void {
    if (emitted === null || emitted === this.doc.source) return;
    this.emitDraftChange(this.committedChange());
  }

  private stopEditingUi(restore = true): void {
    if (!this.editing) return;
    if (restore) this.restorePreview(this.editing);
    this.editing.field.style.display = 'none';
    this.editing = null;
    this.setMode(false);
    this.paintEditing();
    this.paintSelection();
    this.container.focus({ preventScroll: true });
  }

  private positionEditing(): void {
    const editing = this.editing;
    if (!editing) return;
    const rect = this.view.screenRect(editing.previewId);
    if (!rect) {
      this.completeEditing('lost');
      return;
    }
    const box = this.container.getBoundingClientRect();
    const field = editing.field;
    const scale = this.view.scale;
    const label = this.view.labelStyle?.(editing.previewId);
    const fontSize =
      label?.font.size ?? (Number.parseFloat(getComputedStyle(field).fontSize) || 16);
    const lineHeight = label?.font.lineHeight ?? 20;
    const padding = label?.padding ?? [0, 8, 0, 8];
    if (label) {
      field.style.fontFamily = label.font.family;
      field.style.fontSize = `${label.font.size}px`;
      field.style.fontWeight = String(label.font.weight);
      field.style.fontStyle = label.font.style;
      field.style.lineHeight = `${label.font.lineHeight}px`;
      field.style.color = label.fill;
    }
    field.style.padding = `${padding[0]}px ${padding[1]}px ${padding[2]}px ${padding[3]}px`;
    const context = field.ownerDocument.createElement('canvas').getContext('2d');
    if (context) context.font = getComputedStyle(field).font;
    const textWidth =
      field.value.split('\n').reduce((max, line) => {
        if (!context) return Math.max(max, line.length * fontSize * 0.85);
        return Math.max(max, context.measureText(line).width);
      }, 0) +
      padding[1] +
      padding[3];
    const width = Math.max(rect.width / scale, textWidth, 40);
    const rows = field.value.split('\n').length;
    const direction = this.view.direction(editing.previewId);
    const align =
      label?.align ??
      (direction === 'left'
        ? 'right'
        : direction === 'top' || direction === 'bottom'
          ? 'center'
          : 'left');
    const textAlign = align === 'start' ? 'left' : align === 'end' ? 'right' : align;
    const left =
      textAlign === 'center'
        ? rect.x + rect.width / 2 - (width * scale) / 2
        : textAlign === 'right'
          ? rect.x + rect.width - width * scale
          : rect.x;
    field.style.left = `${left - box.x}px`;
    field.style.top = `${rect.y - box.y}px`;
    field.style.width = `${width}px`;
    field.style.height = `${Math.max(
      1,
      rect.height / scale,
      rows * lineHeight + padding[0] + padding[2],
    )}px`;
    field.style.textAlign = textAlign;
    field.style.transform = `scale(${scale})`;
  }

  private navigate(key: string): void {
    const node = this.selectedNode();
    if (!node) return;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const parent = node.parent ? this.doc.nodes.get(node.parent) : undefined;
      if (!parent) return;
      const index = parent.children.indexOf(node.id);
      const next = parent.children[index + (key === 'ArrowUp' ? -1 : 1)];
      if (next) this.select(next);
      return;
    }
    if (key === 'ArrowLeft') {
      if (node.parent) this.select(node.parent);
      return;
    }
    if (this.view.foldedIds.has(node.id)) {
      this.view.setFolded(node.id, false);
      return;
    }
    const child = node.children[0];
    if (child) this.select(child);
  }

  private selectAt(offset: number, options: { reveal?: boolean } = {}): void {
    this.selectionOffset = offset;
    const node = nodeAtOffset(this.doc, offset);
    const fallback = this.doc.nodes.size === 1 ? this.doc.root : null;
    this.select(node?.id ?? fallback, options);
  }

  private select(id: string | null, options: { reveal?: boolean } = {}): void {
    this.selectedId = id;
    this.paintSelection();
    if (id && options.reveal !== false) this.ensureVisible(id);
  }

  private ensureVisible(id: string): void {
    const rect = this.view.screenRect(id);
    const box = this.container.getBoundingClientRect();
    if (!rect) {
      this.view.focusNode(id, { animate: false });
      return;
    }
    const margin = 8;
    const outside =
      rect.x < box.x + margin ||
      rect.y < box.y + margin ||
      rect.x + rect.width > box.x + box.width - margin ||
      rect.y + rect.height > box.y + box.height - margin;
    if (outside) this.view.focusNode(id, { animate: false });
  }

  private selectedNode(): EditNode | undefined {
    return this.selectedId ? this.doc.nodes.get(this.selectedId) : undefined;
  }

  private canCreateRoot(node: EditNode | undefined): boolean {
    return node?.kind === 'root' && this.doc.rootPolicy.canCreateHeading;
  }

  private rootRefusal(node: EditNode): EditError | null {
    return node.kind === 'root' ? rootHeadingRefusal(this.doc, node.id) : null;
  }

  private isEmptyLabel(node: EditNode | undefined): boolean {
    if (node === undefined) return false;
    const label = labelText(this.doc, node);
    const empty = label === EMPTY_LABEL || label.trim() === '';
    return empty && (node.kind === 'root' || node.capabilities.editLabel);
  }

  private historyEntry(): HistoryEntry {
    return {
      source: this.doc.source,
      selection: this.selectionOffset,
      folded: [...this.view.foldedIds],
    };
  }

  private restore(entry: HistoryEntry): void {
    const parsed = parseDocument(entry.source);
    this.closeNotes(false);
    this.completeEditing('switch', false);
    this.doc = parsed.document;
    this.title = typeof parsed.frontmatter.title === 'string' ? parsed.frontmatter.title : '';
    this.view.setTree(parsed.tree);
    this.view.setFoldedIds(entry.folded, { animate: false });
    this.selectAt(entry.selection, { reveal: false });
    this.emitChange();
  }

  private captureFolds(doc: MarkdownDocument): Array<{ offset: number }> {
    const anchors: Array<{ offset: number }> = [];
    for (const id of this.view.foldedIds) {
      const node = doc.nodes.get(id);
      if (node?.block) anchors.push({ offset: node.block.start });
    }
    return anchors;
  }

  private restoreFolds(anchors: Array<{ offset: number }>, result: EditResult): void {
    const ids = new Set<string>();
    for (const anchor of anchors) {
      if (result.edits.some((edit) => anchor.offset >= edit.from && anchor.offset < edit.to)) {
        continue;
      }
      const offset = mapOffset(result.edits, anchor.offset);
      const node = nodeAtOffset(result.document, offset);
      if (node?.block?.start === offset) ids.add(node.id);
    }
    if (!ids.size) return;
    this.view.setFoldedIds(new Set([...this.view.foldedIds, ...ids]), { animate: false });
  }

  private paintSelection(): void {
    this.view.element.querySelectorAll('.mm-editor-selected').forEach((element) => {
      element.classList.remove('mm-editor-selected');
    });
    const id = this.editing?.previewId ?? this.selectedId;
    if (!id) {
      this.selectionBox.style.display = 'none';
      return;
    }
    const selected = this.doc.nodes.get(id);
    if (!this.editing && selected?.kind === 'root' && this.doc.source.trim() === '') {
      this.selectionBox.style.display = 'none';
      return;
    }
    this.nodeGroup(id)?.classList.add('mm-editor-selected');
    if (this.drag?.active) {
      this.selectionBox.style.display = 'none';
      return;
    }
    const rect = this.view.screenRect(id);
    const box = this.container.getBoundingClientRect();
    if (!rect) {
      this.selectionBox.style.display = 'none';
      return;
    }
    this.selectionBox.style.display = 'block';
    this.selectionBox.style.left = `${rect.x - box.x - 2}px`;
    this.selectionBox.style.top = `${rect.y - box.y - 2}px`;
    this.selectionBox.style.width = `${rect.width + 4}px`;
    this.selectionBox.style.height = `${rect.height + 4}px`;
  }

  private paintEditing(): void {
    this.view.element.querySelectorAll('.mm-editor-editing').forEach((element) => {
      element.classList.remove('mm-editor-editing');
    });
    if (this.editing) this.nodeGroup(this.editing.previewId)?.classList.add('mm-editor-editing');
  }

  private nodeGroup(id: string): Element | null {
    return this.view.element.querySelector(`[data-key="node:${id}"]`);
  }

  private hitAt(event: { clientX: number; clientY: number }):
    | {
        kind: string;
        nodeId?: string;
      }
    | undefined {
    const [x, y] = this.view.layoutPoint(event.clientX, event.clientY);
    return this.view.hitAt(x, y);
  }

  private committedChange(): EditorChange {
    return {
      source: this.doc.source,
      selection: this.selectionOffset,
      document: this.doc,
    };
  }

  private emitDraftChange(change: EditorChange): void {
    this.onDraftChange?.(change);
  }

  private emitChange(change?: EditorChange): void {
    this.onChange?.(change ?? this.committedChange());
  }
}
