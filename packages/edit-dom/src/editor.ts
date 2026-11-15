import {
  EditError,
  applyCommand,
  lineEnding,
  mapOffset,
  type Command,
  type EditResult,
} from '@markmap/edit';
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
  first: boolean;
  preview: boolean;
  folds: string[];
  field: HTMLTextAreaElement;
}

interface NotesEditing {
  nodeId: string;
  original: string;
  panel: HTMLDivElement;
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
  private notes: NotesEditing | null = null;
  private previewing = false;
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
    this.stopEditingUi(false);
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
    const text = options.initialText ?? (blank ? '' : label);
    this.field.value = text;
    this.field.style.display = 'block';
    this.editing = {
      nodeId,
      previewId: nodeId,
      original: label,
      blank,
      first,
      preview: false,
      folds: [...this.view.foldedIds],
      field: this.field,
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

  commitForSnapshot(): string {
    if (this.notes) {
      this.commitNotes({ keepOpen: true });
      return this.doc.source;
    }
    const editing = this.editing;
    if (!editing) return this.doc.source;
    const text = editing.field.value;
    if (text === editing.original || (editing.blank && text === '')) return this.doc.source;
    const before = this.snapshot();
    const result = editing.first
      ? this.apply({ type: 'insertFirst', node: editing.nodeId, text })
      : this.apply({ type: 'setLabel', node: editing.nodeId, text });
    if (!result) return this.doc.source;
    this.history.push(before);
    const target = nodeAtOffset(result.document, result.selection);
    if (target) {
      editing.nodeId = target.id;
      editing.previewId = target.id;
    }
    editing.original = text;
    editing.blank = false;
    editing.first = false;
    editing.preview = false;
    editing.folds = [...this.view.foldedIds];
    return this.doc.source;
  }

  setLabel(nodeId: string, text: string): boolean {
    if (!this.doc.nodes.has(nodeId)) return false;
    const before = this.snapshot();
    const result = this.apply({ type: 'setLabel', node: nodeId, text });
    if (!result) return false;
    this.history.push(before);
    return true;
  }

  selectedBlock(): string | null {
    const node = this.selectedNode();
    if (!node) return null;
    if (node.block) return this.doc.source.slice(node.block.start, node.block.end);
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
  };

  private handleClick = (event: MouseEvent): void => {
    const target = event.target;
    if (this.notes) {
      if (target instanceof Node && this.notes.panel.contains(target)) return;
      if (this.commitNotes({ keepOpen: false }) === 'error') return;
    }
    if (this.editing && target instanceof Node && this.editing.field.contains(target)) return;
    if (event.button !== 0) return;
    if (this.editing && this.commitEditing() === 'error') return;
    const hit = this.hitAt(event);
    if ((hit?.kind === 'node' || hit?.kind === 'toggle') && hit.nodeId) {
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
      if (this.editing && !event.shiftKey && this.editing.field.value !== this.editing.original) {
        event.preventDefault();
        const field = this.editing.field;
        field.value = this.editing.original;
        field.setSelectionRange(field.value.length, field.value.length);
        this.previewEditing();
        this.positionEditing();
        this.paintSelection();
        this.paintEditing();
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
    const editing = this.editing;
    if (
      editing &&
      (event.key === 'Backspace' || event.key === 'Delete') &&
      editing.blank &&
      editing.field.value === ''
    ) {
      if (this.isEmptyRoot(this.doc.nodes.get(editing.nodeId))) return;
      event.preventDefault();
      this.stopEditingUi();
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
    const before = this.snapshot();
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
      if (this.isEmptyRoot(node)) {
        this.startEditing(id, { selectAll: true });
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
      this.stopEditingUi();
      return 'none';
    }
    const before = this.snapshot();
    const result = editing.first
      ? this.apply({ type: 'insertFirst', node: editing.nodeId, text })
      : this.apply({ type: 'setLabel', node: editing.nodeId, text });
    if (!result) return 'error';
    if (options.history !== false) this.history.push(before);
    this.stopEditingUi(false);
    return 'changed';
  }

  private cancelEditing(): void {
    this.stopEditingUi();
  }

  private commitAndInsert(kind: 'insertChild' | 'outdent'): void {
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
      type: kind,
      node: node.id,
      text: this.placeholder,
    });
    if (result || state === 'changed') this.history.push(before);
    if (result) this.editCreated(result);
  }

  private previewEditing(): void {
    const editing = this.editing;
    if (!editing) return;
    const text = editing.field.value;
    if (text === editing.original || (editing.blank && text === '')) {
      this.restorePreview(editing);
      return;
    }
    const folds = this.captureFolds(this.doc);
    try {
      const result = applyCommand(
        this.doc,
        editing.first
          ? { type: 'insertFirst', node: editing.nodeId, text }
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
    } catch {
      this.previewing = false;
    }
  }

  private restorePreview(editing: Editing): void {
    if (!editing.preview) return;
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

  private setMode(editing: boolean): void {
    this.container.classList.toggle(MODE_EDIT, editing);
    this.container.classList.toggle(MODE_SELECT, !editing);
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
    const direction = this.view.direction(editing.previewId);
    const align =
      direction === 'left'
        ? 'right'
        : direction === 'top' || direction === 'bottom'
          ? 'center'
          : 'left';
    const left =
      align === 'center'
        ? rect.x + rect.width / 2 - (width * scale) / 2
        : align === 'right'
          ? rect.x + rect.width - width * scale
          : rect.x;
    field.style.left = `${left - box.x}px`;
    field.style.top = `${rect.y - box.y}px`;
    field.style.width = `${width}px`;
    field.style.height = `${Math.max(1, rect.height / scale, rows * lineHeight)}px`;
    field.style.textAlign = align;
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

  private isEmptyRoot(node: EditNode | undefined): boolean {
    return (
      node?.kind === 'root' &&
      !node.block &&
      !node.label &&
      this.doc.nodes.size === 1 &&
      !this.title
    );
  }

  private isEmptyLabel(node: EditNode | undefined): boolean {
    return (
      this.isEmptyRoot(node) || (node !== undefined && labelText(this.doc, node) === EMPTY_LABEL)
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
    this.closeNotes(false);
    this.stopEditingUi(false);
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
    if (!this.editing && this.isEmptyRoot(selected)) {
      this.selectionBox.style.display = 'none';
      return;
    }
    this.nodeGroup(id)?.classList.add('mm-editor-selected');
    const rect = this.editing
      ? this.editing.field.getBoundingClientRect()
      : this.view.screenRect(id);
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
