import { EditError, applyCommand, mapOffset, type Command, type EditResult } from '@markmap/edit';
import {
  labelText,
  nodeAtOffset,
  parseDocument,
  type Document as MarkdownDocument,
  type EditNode,
} from '@markmap/model';
import { History } from './history';
import type { EditView, EditorChange, HistoryEntry, MarkmapEditorOptions } from './types';

const STYLE_ID = 'mm-editor-style';
const EMPTY_LABEL = '\u200B';
const STYLE = `
.mm-editor-layer{position:absolute;inset:0;pointer-events:none;z-index:2}
.mm-editor-field{position:absolute;display:none;margin:0;padding:0 8px;border:0;background:transparent;color:inherit;font:inherit;line-height:1.25;text-align:center;white-space:pre-wrap;resize:none;overflow:hidden;outline:none;box-sizing:border-box;pointer-events:auto;transform-origin:top left}
.mm-editor-selection{position:absolute;display:none;pointer-events:none;box-sizing:border-box;border:2px solid var(--oc-focus,#0097e6);border-radius:6px}
.mm-editor-editing text{visibility:hidden}
`;
const styleUsers = new WeakMap<Document, number>();

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

interface Editing {
  nodeId: string;
  original: string;
  blank: boolean;
  first: boolean;
  field: HTMLTextAreaElement;
}

export class MarkmapEditor {
  private readonly view: EditView;
  private readonly container: HTMLElement;
  private readonly field: HTMLTextAreaElement;
  private readonly selectionBox: HTMLDivElement;
  private readonly layer: HTMLDivElement;
  private readonly history = new History();
  private readonly onChange?: (change: EditorChange) => void;
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
  private destroyed = false;

  constructor({ source, view, container, placeholder, onChange, onError }: MarkmapEditorOptions) {
    this.view = view;
    this.container = container;
    const parsed = parseDocument(source);
    this.doc = parsed.document;
    this.title = typeof parsed.frontmatter.title === 'string' ? parsed.frontmatter.title : '';
    this.onChange = onChange;
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
    this.field = doc.createElement('textarea');
    this.field.className = 'mm-editor-field';
    this.field.spellcheck = false;
    this.field.autocomplete = 'off';
    this.field.setAttribute('autocapitalize', 'off');
    this.field.setAttribute('wrap', 'soft');
    this.field.addEventListener('input', this.handleInput);
    this.layer.append(this.selectionBox, this.field);
    container.append(this.layer);

    container.addEventListener('keydown', this.handleKeyDown);
    container.addEventListener('click', this.handleClick);
    container.addEventListener('dblclick', this.handleDoubleClick);
    this.stops.push(this.view.on('render', this.handleViewChange));
    this.stops.push(this.view.on('zoom', this.handleViewChange));

    this.selectedId = this.doc.root;
    this.selectionOffset = this.doc.nodes.get(this.doc.root)?.label?.start ?? 0;
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
    this.stopEditingUi();
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
    initialText?: string,
    options: { selectAll?: boolean } = {},
  ): void {
    if (!nodeId) return;
    if (this.editing) {
      if (this.editing.nodeId === nodeId) return;
      if (this.commitEditing() === 'error') return;
    }
    const node = this.doc.nodes.get(nodeId);
    if (!node) return;
    const first = this.isEmptyRoot(node);
    if (!node.label && !first) {
      if (node.kind === 'root' && this.title) {
        this.onError?.(
          new EditError(
            'E_LABEL',
            'The root title comes from frontmatter; edit it in the source view',
            node.id,
          ),
        );
      }
      return;
    }
    const rect = this.view.screenRect(nodeId);
    if (!rect) return;
    const label = node.label ? labelText(this.doc, node) : '';
    const blank = first || label === EMPTY_LABEL;
    const text = initialText ?? (blank ? '' : label);
    this.field.value = text;
    this.field.style.display = 'block';
    this.editing = { nodeId, original: label, blank, first, field: this.field };
    this.paintEditing();
    this.positionEditing();
    this.paintSelection();
    this.field.focus({ preventScroll: true });
    if (options.selectAll) this.field.select();
    else this.field.setSelectionRange(text.length, text.length);
  }

  commit(): void {
    this.commitEditing();
  }

  undo(): boolean {
    const entry = this.history.undo(this.snapshot());
    if (!entry) return false;
    this.restore(entry);
    return true;
  }

  redo(): boolean {
    const entry = this.history.redo(this.snapshot());
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
    this.field.removeEventListener('input', this.handleInput);
    this.layer.remove();
    releaseStyle(this.container.ownerDocument);
    if (this.restorePosition) this.container.style.position = '';
    if (this.restoreTabIndex) this.container.removeAttribute('tabindex');
    this.editing = null;
    this.selectedId = null;
  }

  private handleInput = (): void => {
    if (!this.editing) return;
    this.positionEditing();
    this.paintSelection();
  };

  private handleViewChange = (): void => {
    if (this.editing) this.positionEditing();
    this.paintSelection();
    this.paintEditing();
  };

  private handleClick = (event: MouseEvent): void => {
    const target = event.target as Node | null;
    if (this.editing && target && this.editing.field.contains(target)) return;
    if (event.button !== 0) return;
    if (this.editing && this.commitEditing() === 'error') return;
    const hit = this.hitAt(event);
    if ((hit?.kind === 'node' || hit?.kind === 'toggle') && hit.nodeId) {
      this.select(hit.nodeId, { reveal: false });
      this.container.focus({ preventScroll: true });
    }
  };

  private handleDoubleClick = (event: MouseEvent): void => {
    if (this.editing) return;
    const hit = this.hitAt(event);
    if (hit?.kind === 'node' && hit.nodeId) {
      this.select(hit.nodeId, { reveal: false });
      this.startEditing(hit.nodeId);
      event.preventDefault();
    }
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    if (event.isComposing || event.keyCode === 229) return;
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
        if (this.isEmptyRoot(this.selectedNode())) return;
        this.runSelected({ type: 'delete' });
        return;
      case 'F2':
      case ' ':
        event.preventDefault();
        this.startEditing();
        return;
      case 'Escape':
        event.preventDefault();
        this.select(null);
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
        this.startEditing(this.selectedId, `${this.selectedLabel()}${event.key}`);
        event.preventDefault();
    }
  };

  private handleEditingKey(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'z') {
      if (this.editing && !event.shiftKey && this.editing.field.value !== this.editing.original) {
        event.preventDefault();
        const field = this.editing.field;
        field.value = this.editing.original;
        field.setSelectionRange(field.value.length, field.value.length);
        this.positionEditing();
        this.paintSelection();
        return;
      }
      if (this.editing && this.editing.field.value === this.editing.original) {
        event.preventDefault();
        this.stopEditingUi();
        if (event.shiftKey) this.redo();
        else this.undo();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelEditing();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.commitAndInsert('insertSibling');
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

  private insertAndEdit(kind: 'insertSibling' | 'insertChild'): void {
    const id = this.selectedId;
    if (!id) return;
    const node = this.doc.nodes.get(id);
    if (!node) return;
    if (kind === 'insertSibling' && node.kind === 'root') {
      if (this.isEmptyRoot(node)) {
        this.startEditing(id, '', { selectAll: true });
        return;
      }
      kind = 'insertChild';
    }
    const result = this.run({ type: kind, node: id, text: this.placeholder });
    if (!result) return;
    const created = nodeAtOffset(result.document, result.selection);
    if (created) {
      this.select(created.id);
      this.startEditing(created.id, undefined, { selectAll: true });
    }
  }

  private runSelected(command: { type: 'outdent' | 'delete' }): EditResult | null {
    const id = this.selectedId;
    if (!id) return null;
    return this.run({ ...command, node: id });
  }

  private run(command: Command): EditResult | null {
    const before = this.snapshot();
    const result = this.apply(command);
    if (result) this.history.push(before);
    return result;
  }

  private apply(command: Command): EditResult | null {
    const folds = this.captureFolds(this.doc);
    const editing = this.editing;
    try {
      const result = applyCommand(this.doc, command);
      this.doc = result.document;
      if (editing && command.type === 'setLabel' && command.node === editing.nodeId) {
        const target = nodeAtOffset(result.document, result.selection);
        if (target) editing.nodeId = target.id;
      }
      this.view.setTree(result.tree);
      this.restoreFolds(folds, result);
      this.selectAt(result.selection, { reveal: false });
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
      this.stopEditingUi();
      return 'none';
    }
    const before = this.snapshot();
    const result = editing.first
      ? this.apply({ type: 'insertFirst', node: editing.nodeId, text })
      : this.apply({ type: 'setLabel', node: editing.nodeId, text });
    if (!result) return 'error';
    if (options.history !== false) this.history.push(before);
    this.stopEditingUi();
    return 'changed';
  }

  private cancelEditing(): void {
    this.stopEditingUi();
  }

  private commitAndInsert(kind: 'insertSibling' | 'insertChild' | 'outdent'): void {
    const before = this.snapshot();
    const state = this.commitEditing({ history: false });
    if (state === 'error') return;
    const node = this.selectedNode();
    if (!node) return;
    if (kind === 'outdent') {
      const result = this.apply({ type: 'outdent', node: node.id });
      if (result || state === 'changed') this.history.push(before);
      return;
    }
    const result = this.apply({
      type: kind === 'insertSibling' && node.kind === 'root' ? 'insertChild' : kind,
      node: node.id,
      text: this.placeholder,
    });
    if (result || state === 'changed') this.history.push(before);
    if (!result) return;
    const created = nodeAtOffset(result.document, result.selection);
    if (created) {
      this.select(created.id);
      this.startEditing(created.id, undefined, { selectAll: true });
    }
  }

  private stopEditingUi(): void {
    if (!this.editing) return;
    this.editing.field.style.display = 'none';
    this.editing = null;
    this.paintEditing();
    this.paintSelection();
    this.container.focus({ preventScroll: true });
  }

  private positionEditing(): void {
    const editing = this.editing;
    if (!editing) return;
    const rect = this.view.screenRect(editing.nodeId);
    if (!rect) {
      this.stopEditingUi();
      return;
    }
    const box = this.container.getBoundingClientRect();
    const field = editing.field;
    const scale = this.view.scale;
    const fontSize = Number.parseFloat(getComputedStyle(field).fontSize) || 16;
    const lineHeight = 20;
    const context = field.ownerDocument.createElement('canvas').getContext('2d');
    if (context) context.font = getComputedStyle(field).font;
    const textWidth =
      field.value.split('\n').reduce((max, line) => {
        if (!context) return Math.max(max, line.length * fontSize * 0.85);
        return Math.max(max, context.measureText(line).width);
      }, 0) + 16;
    const width = Math.max(rect.width / scale, textWidth, 40);
    const rows = field.value.split('\n').length;
    const center = rect.x + rect.width / 2;
    field.style.left = `${center - (width * scale) / 2 - box.x}px`;
    field.style.top = `${rect.y - box.y}px`;
    field.style.width = `${width}px`;
    field.style.height = `${Math.max(1, rect.height / scale, rows * lineHeight)}px`;
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
      if (node.children.length && !this.view.foldedIds.has(node.id)) {
        this.view.setFolded(node.id, true);
        return;
      }
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

  private selectedLabel(): string {
    const node = this.selectedNode();
    if (!node) return '';
    const label = labelText(this.doc, node);
    return label === EMPTY_LABEL ? '' : label;
  }

  private isEmptyRoot(node: EditNode | undefined): boolean {
    return (
      node?.kind === 'root' &&
      !node.block &&
      !node.label &&
      this.doc.nodes.size === 1 &&
      !this.title
    );
  }

  private snapshot(): HistoryEntry {
    return {
      source: this.doc.source,
      selection: this.selectionOffset,
      folded: [...this.view.foldedIds],
    };
  }

  private restore(entry: HistoryEntry): void {
    const parsed = parseDocument(entry.source);
    this.stopEditingUi();
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
    if (!this.selectedId) {
      this.selectionBox.style.display = 'none';
      return;
    }
    const selected = this.doc.nodes.get(this.selectedId);
    if (!this.editing && this.isEmptyRoot(selected)) {
      this.selectionBox.style.display = 'none';
      return;
    }
    this.nodeGroup(this.selectedId)?.classList.add('mm-editor-selected');
    const rect = this.editing
      ? this.editing.field.getBoundingClientRect()
      : this.view.screenRect(this.selectedId);
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
    if (this.editing) this.nodeGroup(this.editing.nodeId)?.classList.add('mm-editor-editing');
  }

  private nodeGroup(id: string): Element | null {
    return this.view.element.querySelector(`[data-key="node:${id}"]`);
  }

  private hitAt(event: MouseEvent): { kind: string; nodeId?: string } | undefined {
    const [x, y] = this.view.layoutPoint(event.clientX, event.clientY);
    return this.view.hitAt(x, y);
  }

  private emitChange(): void {
    this.onChange?.({
      source: this.doc.source,
      selection: this.selectionOffset,
      document: this.doc,
    });
  }
}
