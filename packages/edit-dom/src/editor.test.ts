// @vitest-environment happy-dom
import type { GraphData, MarkmapNode, Rect, Side } from '@markmap/core';
import { labelText, notesText, parseDocument, type Document } from '@markmap/model';
import { softTheme } from '@markmap/render';
import type { Markmap } from '@markmap/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkmapEditor, createEditView } from '.';
import { History } from './history';
import type { EditLabelStyle, EditView, HistoryEntry, MarkmapEditorOptions } from './types';

class FakeView implements EditView {
  element = document.createElement('div');
  scale = 1;
  transform = { k: 1, x: 0, y: 0 };
  pans: Array<[number, number]> = [];
  folded = new Set<string>();
  tree?: MarkmapNode;
  graph?: GraphData;
  identities?: ReadonlyMap<string, string>;
  hit: { kind: string; nodeId?: string; groupId?: string } | undefined;
  focused: string[] = [];
  rects = new Map<string, Rect | undefined>();
  groupRects = new Map<string | number, Rect | undefined>();
  directions = new Map<string, Side>();
  labels = new Map<string, EditLabelStyle>();
  defaultDirection: Side | undefined;
  known = new Set<string>();
  hidden = new Set<string>();
  private listeners = new Map<string, Set<() => void>>();

  get foldedIds(): ReadonlySet<string> {
    return this.folded;
  }

  setGraph(
    graph: GraphData | undefined,
    identities: ReadonlyMap<string, string> | undefined,
  ): void {
    this.graph = graph;
    this.identities = identities;
  }

  panBy(dx: number, dy: number): void {
    this.pans.push([dx, dy]);
  }

  setTree(root: MarkmapNode): void {
    this.tree = root;
    const ids = new Set<string>();
    const visit = (node: MarkmapNode): void => {
      ids.add(node.id);
      for (const child of node.children) visit(child);
    };
    visit(root);
    this.known = ids;
    this.folded = new Set([...this.folded].filter((id) => ids.has(id)));
    this.emit('render');
  }

  setFolded(id: string, folded: boolean): void {
    if (folded) this.folded.add(id);
    else this.folded.delete(id);
    this.emit('render');
  }

  setFoldedIds(ids: Iterable<string>): void {
    this.folded = new Set(ids);
    this.emit('render');
  }

  toggle(id: string): void {
    this.setFolded(id, !this.folded.has(id));
  }

  focusNode(id: string): boolean {
    this.focused.push(id);
    return true;
  }

  screenRect(id: string): Rect | undefined {
    if (!this.known.has(id) || this.hidden.has(id)) return undefined;
    if (this.rects.has(id)) return this.rects.get(id);
    return { x: 10, y: 20, width: 100, height: 30 };
  }

  groupScreenRect(id: string | number): Rect | undefined {
    if (this.groupRects.has(id)) return this.groupRects.get(id);
    return { x: 50, y: 60, width: 200, height: 100 };
  }

  direction(id: string): Side | undefined {
    return this.directions.get(id) ?? this.defaultDirection;
  }

  labelStyle(id: string): EditLabelStyle | undefined {
    return this.labels.get(id);
  }

  hitAt(): { kind: string; nodeId?: string; groupId?: string } | undefined {
    return this.hit;
  }

  layoutPoint(): [number, number] {
    return [0, 0];
  }

  on(kind: 'render' | 'zoom' | 'fold', listener: () => void): () => void {
    let set = this.listeners.get(kind);
    if (!set) this.listeners.set(kind, (set = new Set()));
    set.add(listener);
    return () => set?.delete(listener);
  }

  emit(kind: string): void {
    for (const listener of this.listeners.get(kind) ?? []) listener();
  }
}

const liveEditors: MarkmapEditor[] = [];

function setup(source = '- a\n- b\n', options: Partial<MarkmapEditorOptions> = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const view = new FakeView();
  container.append(view.element);
  view.tree = parseDocument(source).tree;
  const changes: Array<{ source: string; selection: number; document: Document }> = [];
  const drafts: Array<{ source: string; selection: number; document: Document }> = [];
  const errors: Error[] = [];
  const { onChange, onDraftChange, onError, ...rest } = options;
  const editor = new MarkmapEditor({
    source,
    view,
    container,
    onChange: (change) => {
      changes.push(change);
      onChange?.(change);
    },
    onDraftChange: (change) => {
      drafts.push(change);
      onDraftChange?.(change);
    },
    onError: (error) => {
      errors.push(error);
      onError?.(error);
    },
    ...rest,
  });
  liveEditors.push(editor);
  view.known = new Set(editor.document.order);
  for (const id of editor.document.order) {
    const node = document.createElement('div');
    node.dataset.key = `node:${id}`;
    view.element.append(node);
  }
  for (const edge of editor.document.graph?.edges ?? []) {
    const rel = document.createElement('div');
    rel.dataset.key = `relation:${edge.from}:${edge.to}`;
    const line = document.createElement('div');
    line.className = 'mm-relation-line';
    const arrow = document.createElement('div');
    arrow.className = 'mm-relation-arrow';
    rel.append(line, arrow);
    if (edge.label) {
      const label = document.createElement('div');
      label.className = 'mm-relation-label';
      rel.append(label);
    }
    view.element.append(rel);
  }
  view.emit('render');
  return { container, view, editor, changes, drafts, errors };
}

function connectHandle(container: HTMLElement): HTMLDivElement | null {
  return container.querySelector<HTMLDivElement>('.mm-editor-connect-handle');
}

function connectPreview(container: HTMLElement): SVGElement | null {
  return container.querySelector<SVGElement>('.mm-editor-connect-preview');
}

function relationField(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('.mm-editor-relation-field');
}

function syncRelationElements(view: FakeView, editor: MarkmapEditor): void {
  for (const edge of editor.document.graph?.edges ?? []) {
    const relationKey = `relation:${edge.from}:${edge.to}`;
    let rel = view.element.querySelector(`[data-key="${relationKey}"]`);
    if (!rel) {
      rel = document.createElement('div');
      rel.setAttribute('data-key', relationKey);
      const line = document.createElement('div');
      line.className = 'mm-relation-line';
      const arrow = document.createElement('div');
      arrow.className = 'mm-relation-arrow';
      rel.append(line, arrow);
      view.element.append(rel);
    }
    const existingLabel = rel.querySelector('.mm-relation-label');
    if (edge.label && !existingLabel) {
      const label = document.createElement('div');
      label.className = 'mm-relation-label';
      rel.append(label);
    } else if (!edge.label && existingLabel) {
      existingLabel.remove();
    }
  }
}

function field(container: HTMLElement): HTMLTextAreaElement {
  const element = container.querySelector('textarea');
  if (!element) throw new Error('No field');
  return element;
}

function key(target: EventTarget, value: string, init: KeyboardEventInit = {}) {
  return target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, ...init }));
}

function clickNode(container: HTMLElement, view: FakeView, id: string, init: MouseEventInit = {}) {
  view.hit = { kind: 'node', nodeId: id };
  container.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ...init }));
}

function selectedId(editor: MarkmapEditor): string {
  if (!editor.selected) throw new Error('No selected node');
  return editor.selected;
}

function nodeId(editor: MarkmapEditor, text: string): string {
  for (const id of editor.document.order) {
    const node = editor.document.nodes.get(id);
    if (node && labelText(editor.document, node) === text) return id;
  }
  throw new Error(`No node ${text}`);
}

function selectedLabels(view: FakeView, editor: MarkmapEditor): string[] {
  for (const id of editor.document.order) {
    if (view.element.querySelector(`[data-key="node:${id}"]`)) continue;
    const node = document.createElement('div');
    node.dataset.key = `node:${id}`;
    view.element.append(node);
  }
  view.emit('render');
  const labels: string[] = [];
  for (const id of editor.document.order) {
    const selected = view.element.querySelector(`[data-key="node:${id}"]`);
    if (!selected?.classList.contains('mm-editor-selected')) continue;
    const node = editor.document.nodes.get(id);
    if (node) labels.push(labelText(editor.document, node));
  }
  return labels;
}

function type(container: HTMLElement, value: string) {
  const element = field(container);
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function captureFrames() {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  return {
    frames,
    flush() {
      for (const frame of frames.splice(0)) frame(0);
    },
  };
}

function pointer(
  target: EventTarget,
  kind: string,
  x: number,
  y: number,
  init: PointerEventInit = {},
): boolean {
  return target.dispatchEvent(
    new PointerEvent(kind, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      isPrimary: true,
      ...init,
    }),
  );
}

function stack(view: FakeView, editor: MarkmapEditor): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  editor.document.order.forEach((id, index) => {
    rects.set(id, { x: 10, y: 10 + index * 60, width: 100, height: 30 });
  });
  for (const [id, rect] of rects) view.rects.set(id, rect);
  return rects;
}

function treeLabel(node: MarkmapNode | undefined): string {
  if (!node) return '';
  return node.content.map((item) => ('value' in item ? item.value : '')).join('');
}

function notesPanel(container: HTMLElement): HTMLDivElement | null {
  return container.querySelector<HTMLDivElement>('.mm-editor-notes');
}

function notesField(container: HTMLElement): HTMLTextAreaElement {
  const element = container.querySelector<HTMLTextAreaElement>('.mm-editor-notes-field');
  if (!element) throw new Error('No notes field');
  return element;
}

function notesButton(container: HTMLElement, name: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(
    `.mm-editor-notes-toolbar button[aria-label="${name}"]`,
  );
  if (!element) throw new Error(`No notes button ${name}`);
  return element;
}

function setLayout(container: HTMLElement, width = 800, height = 600): void {
  container.getBoundingClientRect = () => new DOMRect(0, 0, width, height);
}

function dropElement(container: HTMLElement): HTMLElement | null {
  const element = container.querySelector('.mm-editor-drop');
  return element instanceof HTMLElement ? element : null;
}

function clickNotesButton(container: HTMLElement, name: string): void {
  const button = notesButton(container, name);
  button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function openNotes(
  container: HTMLElement,
  view: FakeView,
  editor: MarkmapEditor,
  label: string,
): HTMLTextAreaElement {
  clickNode(container, view, nodeId(editor, label));
  expect(editor.editNotes()).toBe(true);
  return notesField(container);
}

afterEach(() => {
  for (const editor of liveEditors.splice(0)) editor.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('MarkmapEditor', () => {
  it('[TC-2-1-1] selects the root and paints it', () => {
    const { view, editor } = setup();
    expect(editor.selected).toBe(editor.document.root);
    const group = view.element.querySelector(`[data-key="node:${editor.document.root}"]`);
    expect(group?.classList.contains('mm-editor-selected')).toBe(true);
  });

  it('[TC-2-1-3] draws a selection frame around the selected node', () => {
    const { container } = setup();
    const box = container.querySelector<HTMLDivElement>('.mm-editor-selection');
    expect(box?.style.display).toBe('block');
    expect(box?.style.left).toBe('8px');
    expect(box?.style.top).toBe('18px');
    expect(box?.style.width).toBe('104px');
    expect(box?.style.height).toBe('34px');
  });

  it('[TC-2-1-2] selects a node on click and highlights it', () => {
    const { container, view, editor } = setup();
    const id = nodeId(editor, 'b');
    clickNode(container, view, id);
    expect(editor.selected).toBe(id);
    expect(
      view.element
        .querySelector(`[data-key="node:${id}"]`)
        ?.classList.contains('mm-editor-selected'),
    ).toBe(true);
  });

  it('[TC-2-1-4] clears selection and focus on an empty canvas click and restores both on a node click', () => {
    const { container, view, editor } = setup();
    const b = nodeId(editor, 'b');
    clickNode(container, view, b);
    expect(editor.selected).toBe(b);
    expect(document.activeElement).toBe(container);

    view.hit = { kind: 'action', nodeId: b };
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(editor.selected).toBe(b);

    view.hit = { kind: 'toggle', nodeId: b };
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(editor.selected).toBe(b);

    view.hit = undefined;
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(editor.selected).toBeNull();
    expect(view.element.querySelector('.mm-editor-selected')).toBeNull();
    expect(container.querySelector<HTMLElement>('.mm-editor-selection')?.style.display).toBe(
      'none',
    );
    expect(document.activeElement).not.toBe(container);

    clickNode(container, view, b);
    expect(editor.selected).toBe(b);
    expect(
      view.element
        .querySelector(`[data-key="node:${b}"]`)
        ?.classList.contains('mm-editor-selected'),
    ).toBe(true);
    expect(container.querySelector<HTMLElement>('.mm-editor-selection')?.style.display).toBe(
      'block',
    );
    expect(document.activeElement).toBe(container);
  });

  it('[TC-2-2-1] inserts a sibling and starts editing', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Enter');
    expect(editor.source).toBe('- a\n- New topic\n- b\n');
    expect(editor.isEditing).toBe(true);
    expect(field(container).value).toBe('New topic');
    expect(field(container).selectionStart).toBe(0);
    expect(field(container).selectionEnd).toBe('New topic'.length);
  });

  it('[TC-2-17-5] commits the label and returns to selection', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Enter');
    type(container, 'c');
    key(field(container), 'Enter');
    expect(editor.source).toBe('- a\n- c\n- b\n');
    expect(editor.isEditing).toBe(false);
    expect(editor.selected).toBe(nodeId(editor, 'c'));
  });

  it('[TC-2-17-6] inserts a sibling on the next Enter from selection', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Enter');
    type(container, 'c');
    key(field(container), 'Enter');
    key(container, 'Enter');
    expect(editor.source).toBe('- a\n- c\n- New topic\n- b\n');
    expect(editor.isEditing).toBe(true);
    expect(field(container).value).toBe('New topic');
  });

  it('[TC-2-17-7] commits and inserts a child when Tab is pressed while editing', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'A');
    key(field(container), 'Tab');
    expect(editor.source).toBe('- A\n  - New topic\n- b\n');
    expect(editor.isEditing).toBe(true);
    expect(field(container).value).toBe('New topic');
  });

  it('[TC-2-17-8] starts editing with the first typed character on an empty node', () => {
    const { container, view, editor } = setup('- a\n- b\n', { placeholder: '\u200B' });
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Tab');
    const emptyId = editor.selected;
    key(field(container), 'Escape');

    key(container, 'x');

    expect(editor.selected).toBe(emptyId);
    expect(editor.isEditing).toBe(true);
    expect(field(container).value).toBe('x');
    expect(editor.source).toBe('- a\n  - \u200B\n- b\n');
  });

  it('[TC-2-2-3] inserts a child with Tab', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Tab');
    type(container, 'child');
    key(field(container), 'Enter');
    expect(editor.source).toBe('- a\n  - child\n- b\n');
    expect(editor.isEditing).toBe(false);
  });

  it('[TC-2-2-6] makes a Tab child of an H1 root H2', () => {
    const { container, editor } = setup('# A\n');
    key(container, 'Tab');
    type(container, 'B');
    key(field(container), 'Enter');
    expect(editor.source).toBe('# A\n## B\n');
    const created = editor.document.nodes.get(selectedId(editor));
    expect(created?.kind).toBe('heading');
    expect(created?.level).toBe(2);
    expect(created?.parent).toBe(editor.document.root);
  });

  it('[TC-2-2-7] makes a Tab child of an H2 heading a list item', () => {
    const { container, view, editor } = setup('# A\n\n## B\n');
    clickNode(container, view, nodeId(editor, 'B'));
    key(container, 'Tab');
    type(container, 'c');
    key(field(container), 'Enter');
    expect(editor.source).toBe('# A\n\n## B\n- c\n');
    const created = editor.document.nodes.get(selectedId(editor));
    expect(created?.kind).toBe('listItem');
    expect(created?.parent).toBe(nodeId(editor, 'B'));
  });

  it('[TC-2-2-8] makes an Enter sibling of an H3 heading a list item under the parent', () => {
    const { container, view, editor } = setup('# A\n\n## B\n\n### C\n');
    clickNode(container, view, nodeId(editor, 'C'));
    key(container, 'Enter');
    type(container, 'D');
    key(field(container), 'Enter');
    expect(editor.source).toBe('# A\n\n## B\n\n- D\n### C\n');
    const created = editor.document.nodes.get(selectedId(editor));
    expect(created?.kind).toBe('listItem');
    expect(created?.parent).toBe(nodeId(editor, 'B'));
  });

  it('[TC-2-2-9] makes a Tab child of an H6 heading a list item', () => {
    const { container, view, editor } = setup(
      '# A\n\n## B\n\n### C\n\n#### D\n\n##### E\n\n###### F\n',
    );
    clickNode(container, view, nodeId(editor, 'F'));
    key(container, 'Tab');
    type(container, 'G');
    key(field(container), 'Enter');
    expect(editor.source).toBe('# A\n\n## B\n\n### C\n\n#### D\n\n##### E\n\n###### F\n- G\n');
    const created = editor.document.nodes.get(selectedId(editor));
    expect(created?.kind).toBe('listItem');
    expect(created?.parent).toBe(nodeId(editor, 'F'));
  });

  it('[TC-2-2-5] starts a new node with an empty label', () => {
    const { container, view, editor } = setup('- a\n- b\n', { placeholder: '\u200B' });
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Enter');
    expect(field(container).value).toBe('');
    expect(editor.source).toContain('\u200B');
    type(container, 'c');
    editor.commit();
    expect(editor.source).toBe('- a\n- c\n- b\n');
    expect(editor.isEditing).toBe(false);
  });

  it('[TC-2-2-4] reveals a new node when it has no screen rect', () => {
    const { container, view, editor } = setup();
    view.screenRect = () => undefined;
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Enter');
    expect(view.focused.length).toBeGreaterThan(0);
  });

  it('[TC-2-3-1] cancels editing with Escape', () => {
    const { container, view, editor } = setup();
    const id = nodeId(editor, 'a');
    clickNode(container, view, id);
    key(container, ' ');
    type(container, 'changed');
    key(field(container), 'Escape');
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.isEditing).toBe(false);
    expect(editor.selected).toBe(id);
  });

  it('[TC-2-3-2] rejects a line break in a heading label', () => {
    const { container, view, editor, errors } = setup('# A\n');
    clickNode(container, view, editor.document.root);
    key(container, ' ');
    key(field(container), 'Enter', { shiftKey: true });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('line break');
  });

  it('[TC-2-3-3] keeps editing when the label is invalid', () => {
    const { container, view, editor, errors } = setup('# A\n');
    clickNode(container, view, editor.document.root);
    key(container, ' ');
    type(container, 'a\nb');
    key(field(container), 'Enter');
    expect(editor.isEditing).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    expect(editor.source).toBe('# A\n');
  });

  it('[TC-2-4-1] outdents with Shift+Tab', () => {
    const { container, view, editor } = setup('- a\n  - b\n- c\n');
    clickNode(container, view, nodeId(editor, 'b'));
    key(container, 'Tab', { shiftKey: true });
    expect(editor.source).toBe('- a\n- b\n- c\n');
  });

  it('[TC-2-4-2] deletes the selected node', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Delete');
    expect(editor.source).toBe('- b\n');
  });

  it('[TC-2-4-3] removes a new empty node with Backspace and selects the node before it', () => {
    const { container, view, editor } = setup('- a\n- b\n', { placeholder: '\u200B' });
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Enter');
    expect(editor.isEditing).toBe(true);
    expect(editor.source).toBe('- a\n- \u200B\n- b\n');

    key(field(container), 'Backspace');
    expect(editor.isEditing).toBe(false);
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.selected).toBe(nodeId(editor, 'a'));
  });

  it('[TC-2-4-4] removes a new empty child with Delete and selects its parent', () => {
    const { container, view, editor } = setup('- a\n- b\n', { placeholder: '\u200B' });
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Tab');
    expect(editor.source).toBe('- a\n  - \u200B\n- b\n');

    key(field(container), 'Delete');
    expect(editor.isEditing).toBe(false);
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.selected).toBe(nodeId(editor, 'a'));
  });

  it('[TC-2-4-5] keeps a label with text when Backspace is pressed in its field', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    expect(field(container).value).toBe('a');

    key(field(container), 'Backspace');
    expect(editor.isEditing).toBe(true);
    expect(editor.source).toBe('- a\n- b\n');
  });

  it('[TC-2-4-6] restores the removed empty node with undo', () => {
    const { container, view, editor } = setup('- a\n- b\n', { placeholder: '\u200B' });
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Enter');
    key(field(container), 'Backspace');
    expect(editor.source).toBe('- a\n- b\n');

    expect(editor.undo()).toBe(true);
    expect(editor.source).toBe('- a\n- \u200B\n- b\n');
    expect(editor.isEditing).toBe(false);
    expect(editor.selected).toBe(nodeId(editor, '\u200B'));
  });

  it('[TC-2-4-8] keeps a new node with typed text when Backspace is pressed', () => {
    const { container, view, editor } = setup('- a\n- b\n', { placeholder: '\u200B' });
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Enter');
    type(container, 'x');

    key(field(container), 'Backspace');
    expect(editor.isEditing).toBe(true);
    expect(editor.source).toBe('- a\n- \u200B\n- b\n');
  });

  it('[TC-2-4-7] keeps the empty root when Backspace is pressed in its field', () => {
    const { container, editor, errors } = setup('');
    key(container, ' ');
    expect(editor.isEditing).toBe(true);

    key(field(container), 'Backspace');
    expect(editor.isEditing).toBe(true);
    expect(editor.source).toBe('');
    expect(errors).toHaveLength(0);
  });

  it('[TC-2-5-1] navigates siblings, parents, and children', () => {
    const { container, view, editor } = setup('- a\n  - a1\n- b\n');
    const a = nodeId(editor, 'a');
    const a1 = nodeId(editor, 'a1');
    const b = nodeId(editor, 'b');
    clickNode(container, view, a);
    key(container, 'ArrowDown');
    expect(editor.selected).toBe(b);
    key(container, 'ArrowUp');
    expect(editor.selected).toBe(a);
    key(container, 'ArrowRight');
    expect(editor.selected).toBe(a1);
    key(container, 'ArrowLeft');
    expect(editor.selected).toBe(a);
    key(container, 'ArrowLeft');
    expect(editor.selected).toBe(editor.document.root);
    expect(view.folded.has(a)).toBe(false);
  });

  it('[TC-2-5-2] unfolds and enters a folded child with arrows', () => {
    const { container, view, editor } = setup('- a\n  - a1\n- b\n');
    const a = nodeId(editor, 'a');
    view.folded.add(a);
    clickNode(container, view, a);
    key(container, 'ArrowRight');
    expect(view.folded.has(a)).toBe(false);
    expect(editor.selected).toBe(a);
    key(container, 'ArrowRight');
    expect(editor.selected).toBe(nodeId(editor, 'a1'));
  });

  it('[TC-2-17-1] leaves F2 and modified Space unbound in selection mode', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'F2');
    expect(editor.isEditing).toBe(false);
    key(container, ' ', { metaKey: true });
    expect(editor.isEditing).toBe(false);
    expect(editor.source).toBe('- a\n- b\n');
  });

  it('[TC-2-17-2] enters with Space, exits with Escape, and keeps the selection', () => {
    const { container, view, editor } = setup();
    const a = nodeId(editor, 'a');
    clickNode(container, view, a);
    expect(container.classList.contains('mm-editor-mode-select')).toBe(true);
    key(container, ' ');
    expect(editor.isEditing).toBe(true);
    expect(container.classList.contains('mm-editor-mode-edit')).toBe(true);
    key(field(container), 'Escape');
    expect(editor.isEditing).toBe(false);
    expect(container.classList.contains('mm-editor-mode-select')).toBe(true);
    expect(editor.selected).toBe(a);
    expect(editor.source).toBe('- a\n- b\n');
    key(container, 'Escape');
    expect(editor.selected).toBe(a);
  });

  it('[TC-2-17-3] sets a label programmatically', () => {
    const { editor, changes } = setup();
    expect(editor.setLabel(nodeId(editor, 'a'), 'A')).toBe(true);
    expect(editor.source).toBe('- A\n- b\n');
    expect(changes).toHaveLength(1);
    expect(editor.setLabel('missing', 'x')).toBe(false);
  });

  it('[TC-2-19-1] inserts a pasted block and selects its root', () => {
    const { container, view, editor, changes, errors } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    expect(editor.insertBlock('- b\n  - c')).toBe(true);
    expect(editor.source).toBe('- a\n  - b\n    - c\n- b\n');
    expect(editor.selected).toBe(nodeId(editor, 'b'));
    expect(changes).toHaveLength(1);
    expect(editor.canUndo).toBe(true);
    expect(editor.insertBlock('plain note')).toBe(false);
    expect(errors).toHaveLength(1);
    expect(editor.undo()).toBe(true);
    expect(editor.source).toBe('- a\n- b\n');
  });

  it('[TC-2-19-2] inserts a label as a child', () => {
    const { container, view, editor, changes } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    expect(editor.insertLabel('New label')).toBe(true);
    expect(editor.source).toBe('- a\n  - New label\n- b\n');
    expect(editor.selected).toBe(nodeId(editor, 'New label'));
    expect(changes).toHaveLength(1);
  });

  it('[TC-2-19-4] exposes the selected block and a synthesized title root', () => {
    const { container, view, editor } = setup('- a\n  - b\n- c\n');
    clickNode(container, view, nodeId(editor, 'a'));
    expect(editor.selectedBlock()).toBe('- a\n  - b');
    clickNode(container, view, editor.document.root);
    expect(editor.selectedBlock()).toBe('- a\n  - b\n- c');

    const title = setup('---\ntitle: Root title\n---\n\n## Branch\n\n- Leaf\n');
    clickNode(title.container, title.view, title.editor.document.root);
    expect(title.editor.selectedBlock()).toBe('## Branch\n\n- Leaf\n');

    const emptyTitle = setup('---\ntitle: Root title\n---\n');
    clickNode(emptyTitle.container, emptyTitle.view, emptyTitle.editor.document.root);
    expect(emptyTitle.editor.selectedBlock()).toBe('# Root title');

    const empty = setup('');
    clickNode(empty.container, empty.view, empty.editor.document.root);
    expect(empty.editor.selectedBlock()).toBeNull();
  });

  it('[TC-2-19-5] copies intro notes with a promoted H1 or H2 root', () => {
    const h1 = setup('Intro.\n\n# A\n\n- x\n');
    clickNode(h1.container, h1.view, h1.editor.document.root);
    expect(h1.editor.selectedBlock()).toBe('Intro.\n\n# A\n\n- x\n');

    const h2 = setup('Intro.\n\n## A\n\n- x\n');
    clickNode(h2.container, h2.view, h2.editor.document.root);
    expect(h2.editor.selectedBlock()).toBe('Intro.\n\n## A\n\n- x\n');
  });

  it('[TC-2-19-6] copies a fenced intro note with a promoted H1 or H2 root', () => {
    const h1 = setup('```markmap-note\nIntro.\n```\n\n# A\n\n- x\n');
    clickNode(h1.container, h1.view, h1.editor.document.root);
    expect(h1.editor.selectedBlock()).toBe('```markmap-note\nIntro.\n```\n\n# A\n\n- x\n');

    const h2 = setup('```markmap-note\nIntro.\n```\n\n## A\n\n- x\n');
    clickNode(h2.container, h2.view, h2.editor.document.root);
    expect(h2.editor.selectedBlock()).toBe('```markmap-note\nIntro.\n```\n\n## A\n\n- x\n');
  });

  it('[TC-2-19-7] excludes frontmatter from a promoted root block', () => {
    const { container, view, editor } = setup('---\nfoo: 1\n---\n\nIntro.\n\n# A\n\n- x\n');
    clickNode(container, view, editor.document.root);
    expect(editor.selectedBlock()).toBe('Intro.\n\n# A\n\n- x\n');
  });

  it('[TC-2-19-8] pastes a copied promoted root with a paragraph intro note', () => {
    const source = setup('Intro.\n\n## A\n\n- x\n');
    const copied = source.editor.selectedBlock();
    if (!copied) throw new Error('No copied block');
    expect(copied).toBe('Intro.\n\n## A\n\n- x\n');

    const target = setup('# Target\n');
    expect(target.editor.insertBlock(copied)).toBe(true);
    expect(target.editor.source).toBe('# Target\n## A\n\nIntro.\n\n- x\n');
    const pastedId = nodeId(target.editor, 'A');
    const pasted = target.editor.document.nodes.get(pastedId);
    if (!pasted) throw new Error('No pasted node');
    expect(notesText(target.editor.document, pasted)).toBe('Intro.');
    expect(pasted.notes).toHaveLength(1);
    expect(target.editor.document.nodes.get(nodeId(target.editor, 'x'))?.parent).toBe(pastedId);
    expect(target.editor.selected).toBe(pastedId);
  });

  it('[TC-2-19-9] pastes a copied promoted root with a fenced intro note', () => {
    const source = setup('```markmap-note\nIntro.\n```\n\n## A\n\n- x\n');
    const copied = source.editor.selectedBlock();
    if (!copied) throw new Error('No copied block');
    expect(copied).toBe('```markmap-note\nIntro.\n```\n\n## A\n\n- x\n');

    const target = setup('# Target\n');
    expect(target.editor.insertBlock(copied)).toBe(true);
    expect(target.editor.source).toBe('# Target\n## A\n\n```markmap-note\nIntro.\n```\n\n- x\n');
    const pastedId = nodeId(target.editor, 'A');
    const pasted = target.editor.document.nodes.get(pastedId);
    if (!pasted) throw new Error('No pasted node');
    expect(notesText(target.editor.document, pasted)).toBe('Intro.');
    expect(pasted.notes.map((note) => note.fence)).toEqual([true]);
    expect(target.editor.document.nodes.get(nodeId(target.editor, 'x'))?.parent).toBe(pastedId);
    expect(target.editor.selected).toBe(pastedId);
  });

  it('[TC-2-19-10] rejects an unsupported prefix without changing history or redo', () => {
    const { container, view, editor, errors, changes } = setup('# Target\n');
    expect(editor.setLabel(editor.document.root, 'B')).toBe(true);
    expect(editor.undo()).toBe(true);
    expect(editor.canRedo).toBe(true);
    clickNode(container, view, editor.document.root);
    const before = changes.length;

    expect(editor.insertBlock('[ref]: https://example.com\n\n## A\n\n[Link][ref]\n')).toBe(false);
    expect(errors.at(-1)?.message).toContain('cannot become a note');
    expect(editor.source).toBe('# Target\n');
    expect(editor.canUndo).toBe(false);
    expect(editor.canRedo).toBe(true);
    expect(changes).toHaveLength(before);
  });

  it('[TC-2-19-3] deletes the selected subtree and rejects the root', () => {
    const { container, view, editor, errors } = setup('- a\n  - b\n- c\n');
    clickNode(container, view, nodeId(editor, 'a'));
    expect(editor.deleteSelected()).toBe(true);
    expect(editor.source).toBe('- c\n');
    expect(editor.selected).toBe(nodeId(editor, 'c'));
    clickNode(container, view, editor.document.root);
    expect(editor.deleteSelected()).toBe(false);
    expect(editor.source).toBe('- c\n');
    expect(errors).toHaveLength(1);
  });

  it('[TC-2-17-4] adds a child when Enter is pressed on a source-heading root', () => {
    const { container, editor } = setup('# A\n');
    key(container, 'Enter');
    expect(editor.isEditing).toBe(true);
    expect(editor.source).toContain('## New topic');
  });

  it('[TC-2-6-1] undoes and redoes an edit', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Enter');
    type(container, 'c');
    key(field(container), 'Enter');
    expect(editor.canUndo).toBe(true);
    key(container, 'z', { metaKey: true });
    expect(editor.source).toBe('- a\n- New topic\n- b\n');
    key(container, 'z', { metaKey: true, shiftKey: true });
    expect(editor.source).toBe('- a\n- c\n- b\n');
  });

  it('[TC-2-7-1] places the editor over the node', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    const element = field(container);
    expect(element.style.display).toBe('block');
    expect(element.style.left).toBe('10px');
    expect(element.style.top).toBe('20px');
    expect(element.style.width).toBe('100px');
    expect(element.style.transform).toBe('scale(1)');
  });

  it('[TC-2-7-2] scales the field with the map zoom', () => {
    const { container, view, editor } = setup();
    view.scale = 2;
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    const element = field(container);
    expect(element.style.width).toBe('50px');
    expect(element.style.height).toBe('20px');
    expect(element.style.transform).toBe('scale(2)');
  });

  it('[TC-2-15-1] grows a start-aligned field to the right', () => {
    const { container, view, editor } = setup();
    view.directions.set(nodeId(editor, 'a'), 'right');
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'a much longer label');
    const element = field(container);
    expect(element.style.textAlign).toBe('left');
    expect(element.style.left).toBe('10px');
    expect(parseFloat(element.style.width)).toBeGreaterThan(100);
  });

  it('[TC-2-15-2] grows an end-aligned field to the left', () => {
    const { container, view, editor } = setup();
    view.defaultDirection = 'left';
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'a much longer label');
    const element = field(container);
    expect(element.style.textAlign).toBe('right');
    expect(parseFloat(element.style.left) + parseFloat(element.style.width)).toBeCloseTo(110);
    expect(parseFloat(element.style.width)).toBeGreaterThan(100);
  });

  it('[TC-2-15-3] grows a centered field from its center', () => {
    const { container, view, editor } = setup();
    view.defaultDirection = 'top';
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'a much longer label');
    const element = field(container);
    expect(element.style.textAlign).toBe('center');
    expect(parseFloat(element.style.left) + parseFloat(element.style.width) / 2).toBeCloseTo(60);
    expect(parseFloat(element.style.width)).toBeGreaterThan(100);
  });

  it('[TC-2-8-1] emits changes and accepts a new source', () => {
    const { container, view, editor, changes } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Delete');
    expect(changes).toHaveLength(1);
    expect(changes[0].source).toBe('- b\n');
    editor.setSource('- x\n');
    expect(editor.source).toBe('- x\n');
    expect(editor.selected).toBe(editor.document.root);
    expect(editor.canUndo).toBe(false);
  });

  it('[TC-2-8-2] commits an in-progress label on demand', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'c');
    editor.commit();
    expect(editor.source).toBe('- c\n- b\n');
    expect(editor.isEditing).toBe(false);
  });

  it('[TC-2-16-1] previews the label in the view while typing', () => {
    const { container, view, editor, changes } = setup();
    const frames = captureFrames();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'a much longer label');
    frames.flush();
    expect(treeLabel(view.tree?.children[0])).toBe('a much longer label');
    expect(editor.source).toBe('- a\n- b\n');
    expect(changes).toHaveLength(0);
  });

  it('[TC-2-16-2] restores the layout when editing is cancelled', () => {
    const { container, view, editor } = setup();
    const frames = captureFrames();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'a much longer label');
    frames.flush();
    key(field(container), 'Escape');
    expect(treeLabel(view.tree?.children[0])).toBe('a');
    expect(editor.isEditing).toBe(false);
    expect(editor.source).toBe('- a\n- b\n');
  });

  it('[TC-2-16-3] keeps one change after previewing a label', () => {
    const { container, view, editor, changes } = setup();
    const frames = captureFrames();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'a much longer label');
    frames.flush();
    editor.commit();
    expect(editor.source).toBe('- a much longer label\n- b\n');
    expect(changes).toHaveLength(1);
    expect(treeLabel(view.tree?.children[0])).toBe('a much longer label');
  });

  it('[TC-2-16-4] restores the preview when the text returns to the original', () => {
    const { container, view, editor } = setup();
    const frames = captureFrames();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'a much longer label');
    frames.flush();
    type(container, 'a');
    expect(treeLabel(view.tree?.children[0])).toBe('a');
    expect(editor.source).toBe('- a\n- b\n');
  });

  it('[TC-2-16-5] previews the first heading in an empty document', () => {
    const { container, view, editor, changes } = setup('');
    const frames = captureFrames();
    key(container, ' ');
    type(container, 'First note');
    frames.flush();
    expect(treeLabel(view.tree)).toBe('First note');
    expect(editor.source).toBe('');
    expect(changes).toHaveLength(0);
  });

  it('[TC-2-16-6] keeps the last valid preview for an invalid label', () => {
    const { container, view, editor } = setup('# a\n');
    const frames = captureFrames();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'ab');
    type(container, 'a\nb');
    frames.flush();
    expect(treeLabel(view.tree)).toBe('ab');
    expect(editor.isEditing).toBe(true);
    expect(editor.source).toBe('# a\n');
  });

  it('[TC-2-26-1] coalesces input previews into one frame with the latest label', () => {
    const { container, view, editor, drafts } = setup();
    const frames = captureFrames();
    const setTree = vi.spyOn(view, 'setTree');
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'one');
    type(container, 'two');
    type(container, 'three');

    expect(document.activeElement).toBe(field(container));
    expect(drafts.map((change) => change.source)).toEqual([
      '- one\n- b\n',
      '- two\n- b\n',
      '- three\n- b\n',
    ]);
    expect(editor.snapshot()).toBe('- three\n- b\n');
    expect(setTree).not.toHaveBeenCalled();
    expect(frames.frames).toHaveLength(1);

    const frame = frames.frames[0];
    if (frame) frame(0);
    expect(setTree).toHaveBeenCalledTimes(1);
    expect(treeLabel(view.tree?.children[0])).toBe('three');

    editor.commit();
    expect(editor.source).toBe('- three\n- b\n');
  });

  it('[TC-2-26-2] discards a pending preview on commit, cancel, source replacement and destroy', () => {
    const frames = captureFrames();

    const committed = setup();
    clickNode(committed.container, committed.view, nodeId(committed.editor, 'a'));
    key(committed.container, ' ');
    type(committed.container, 'draft');
    expect(frames.frames).toHaveLength(1);
    committed.editor.commit();
    const first = frames.frames[0];
    if (first) first(0);
    expect(committed.editor.source).toBe('- draft\n- b\n');
    expect(treeLabel(committed.view.tree?.children[0])).toBe('draft');

    const switched = setup();
    clickNode(switched.container, switched.view, nodeId(switched.editor, 'a'));
    key(switched.container, ' ');
    type(switched.container, 'stale');
    const second = frames.frames[1];
    switched.editor.setSource('- z\n');
    if (second) second(0);
    expect(switched.editor.source).toBe('- z\n');
    expect(treeLabel(switched.view.tree?.children[0])).toBe('z');

    const cancelled = setup();
    clickNode(cancelled.container, cancelled.view, nodeId(cancelled.editor, 'a'));
    key(cancelled.container, ' ');
    type(cancelled.container, 'hidden');
    const third = frames.frames[2];
    key(field(cancelled.container), 'Escape');
    if (third) third(0);
    expect(cancelled.editor.source).toBe('- a\n- b\n');
    expect(cancelled.editor.isEditing).toBe(false);
    expect(treeLabel(cancelled.view.tree?.children[0])).toBe('a');

    const destroyed = setup();
    clickNode(destroyed.container, destroyed.view, nodeId(destroyed.editor, 'a'));
    key(destroyed.container, ' ');
    type(destroyed.container, 'gone');
    const fourth = frames.frames[3];
    destroyed.editor.destroy();
    if (fourth) fourth(0);
    expect(destroyed.editor.source).toBe('- a\n- b\n');
    expect(treeLabel(destroyed.view.tree?.children[0])).toBe('a');
  });

  it('[TC-2-18-1] snapshots the current label without leaving editing', () => {
    const { container, view, editor, changes, drafts } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'a revised label');

    expect(editor.snapshot()).toBe('- a revised label\n- b\n');
    expect(drafts.at(-1)?.source).toBe('- a revised label\n- b\n');
    expect(changes).toHaveLength(0);
    expect(editor.isEditing).toBe(true);
    expect(container.classList.contains('mm-editor-mode-edit')).toBe(true);
    expect(field(container).value).toBe('a revised label');
    expect(document.activeElement).toBe(field(container));

    type(container, 'a revised label continued');
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.snapshot()).toBe('- a revised label continued\n- b\n');
    expect(drafts.at(-1)?.source).toBe('- a revised label continued\n- b\n');
    expect(editor.isEditing).toBe(true);
  });

  it('[TC-2-18-2] keeps an empty new field open during a snapshot', () => {
    const { container, view, editor } = setup('- a\n- b\n', { placeholder: '\u200B' });
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Tab');

    expect(editor.snapshot()).toBe('- a\n  - \u200B\n- b\n');
    expect(editor.isEditing).toBe(true);
    expect(field(container).value).toBe('');
  });

  it('[TC-2-9-1] keeps a fold after a rename', () => {
    const { container, view, editor } = setup('- a\n  - a1\n- b\n');
    const a = nodeId(editor, 'a');
    view.folded.add(a);
    clickNode(container, view, a);
    key(container, ' ');
    type(container, 'A');
    key(field(container), 'Enter');
    const renamed = nodeId(editor, 'A');
    expect(view.folded.has(renamed)).toBe(true);
  });

  it('[TC-2-10-1] ignores IME composition', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(event, 'isComposing', { value: true });
    container.dispatchEvent(event);
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.isEditing).toBe(false);
  });

  it('[TC-2-10-2] edits on double click', () => {
    const { container, view, editor } = setup();
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'b') };
    container.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(editor.isEditing).toBe(true);
    expect(field(container).value).toBe('b');
  });

  it('[TC-2-10-3] destroys listeners and DOM', () => {
    const { container, view, editor } = setup();
    editor.destroy();
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.hasAttribute('tabindex')).toBe(false);
    clickNode(container, view, nodeId(editor, 'a'));
    expect(editor.selected).toBeNull();
  });
});

describe('Commit path', () => {
  it('[TC-2-27-1] reuses the current preview and skips a redraw on commit', () => {
    const { container, view, editor, changes, drafts } = setup();
    const frames = captureFrames();
    const setTree = vi.spyOn(view, 'setTree');
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'draft');
    frames.flush();
    const draft = drafts.at(-1);
    if (!draft) throw new Error('No draft');
    expect(setTree).toHaveBeenCalledTimes(1);

    editor.commit();

    expect(editor.source).toBe('- draft\n- b\n');
    expect(setTree).toHaveBeenCalledTimes(1);
    expect(changes.at(-1)?.document).toBe(draft.document);
    expect(editor.isEditing).toBe(false);
    expect(editor.undo()).toBe(true);
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.redo()).toBe(true);
    expect(editor.source).toBe('- draft\n- b\n');
  });

  it('[TC-2-27-2] recomputes a draft invalidated by another command', () => {
    const { container, view, editor, changes, drafts } = setup();
    const frames = captureFrames();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'draft');
    const stale = drafts.at(-1);
    if (!stale) throw new Error('No draft');

    expect(editor.setLabel(nodeId(editor, 'b'), 'changed')).toBe(true);
    frames.flush();
    expect(treeLabel(view.tree?.children[0])).toBe('a');
    expect(treeLabel(view.tree?.children[1])).toBe('changed');
    expect(editor.snapshot()).toBe('- draft\n- changed\n');
    expect(editor.source).toBe('- a\n- changed\n');

    key(field(container), 'Enter');

    expect(editor.source).toBe('- draft\n- changed\n');
    expect(changes.at(-1)?.document).not.toBe(stale.document);
    expect(treeLabel(view.tree?.children[0])).toBe('draft');
    expect(treeLabel(view.tree?.children[1])).toBe('changed');

    const rendered = setup();
    const renderedFrames = captureFrames();
    const setTree = vi.spyOn(rendered.view, 'setTree');
    clickNode(rendered.container, rendered.view, nodeId(rendered.editor, 'a'));
    key(rendered.container, ' ');
    type(rendered.container, 'draft');
    renderedFrames.flush();
    expect(treeLabel(rendered.view.tree?.children[0])).toBe('draft');
    const drawn = setTree.mock.calls.length;

    expect(rendered.editor.setLabel(nodeId(rendered.editor, 'b'), 'changed')).toBe(true);
    expect(treeLabel(rendered.view.tree?.children[0])).toBe('a');
    expect(rendered.editor.isEditing).toBe(true);
    key(field(rendered.container), 'Escape');
    expect(setTree).toHaveBeenCalledTimes(drawn + 1);
    expect(treeLabel(rendered.view.tree?.children[0])).toBe('a');
    expect(treeLabel(rendered.view.tree?.children[1])).toBe('changed');
    expect(rendered.editor.source).toBe('- a\n- changed\n');
    expect(rendered.editor.isEditing).toBe(false);
  });

  it('[TC-2-27-3] commits a pending preview without a late overwrite', () => {
    const { container, view, editor, changes, drafts } = setup();
    const frames = captureFrames();
    const setTree = vi.spyOn(view, 'setTree');
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'draft');
    const draft = drafts.at(-1);
    if (!draft) throw new Error('No draft');
    expect(setTree).not.toHaveBeenCalled();
    const pending = frames.frames[0];

    editor.commit();

    expect(editor.source).toBe('- draft\n- b\n');
    expect(changes.at(-1)?.document).toBe(draft.document);
    expect(setTree).toHaveBeenCalledTimes(1);

    if (pending) pending(0);
    expect(setTree).toHaveBeenCalledTimes(1);
    expect(treeLabel(view.tree?.children[0])).toBe('draft');
    expect(editor.isEditing).toBe(false);
  });

  it('[TC-2-27-4] keeps cancel, source replacement and destroy correct after a rendered preview', () => {
    const frames = captureFrames();

    const cancelled = setup();
    const cancelTree = vi.spyOn(cancelled.view, 'setTree');
    clickNode(cancelled.container, cancelled.view, nodeId(cancelled.editor, 'a'));
    key(cancelled.container, ' ');
    type(cancelled.container, 'draft');
    frames.flush();
    key(field(cancelled.container), 'Escape');
    expect(treeLabel(cancelled.view.tree?.children[0])).toBe('a');
    key(cancelled.container, ' ');
    type(cancelled.container, 'draft');
    cancelled.editor.commit();
    expect(cancelled.editor.source).toBe('- draft\n- b\n');
    expect(treeLabel(cancelled.view.tree?.children[0])).toBe('draft');
    expect(cancelTree).toHaveBeenCalledTimes(3);

    const switched = setup();
    const switchTree = vi.spyOn(switched.view, 'setTree');
    clickNode(switched.container, switched.view, nodeId(switched.editor, 'a'));
    key(switched.container, ' ');
    type(switched.container, 'draft');
    frames.flush();
    switched.editor.setSource('- z\n');
    clickNode(switched.container, switched.view, nodeId(switched.editor, 'z'));
    key(switched.container, ' ');
    type(switched.container, 'w');
    switched.editor.commit();
    expect(switched.editor.source).toBe('- w\n');
    expect(treeLabel(switched.view.tree?.children[0])).toBe('w');
    expect(switchTree).toHaveBeenCalledTimes(3);

    const destroyed = setup();
    const destroyTree = vi.spyOn(destroyed.view, 'setTree');
    clickNode(destroyed.container, destroyed.view, nodeId(destroyed.editor, 'a'));
    key(destroyed.container, ' ');
    type(destroyed.container, 'draft');
    frames.flush();
    type(destroyed.container, 'gone');
    const pending = frames.frames.at(-1);
    destroyed.editor.destroy();
    if (pending) pending(0);
    expect(destroyed.editor.source).toBe('- a\n- b\n');
    expect(destroyTree).toHaveBeenCalledTimes(1);
  });

  it('[TC-2-27-5] reuses the draft for a Tab commit and records one history entry', () => {
    const { container, view, editor, changes, drafts } = setup();
    const frames = captureFrames();
    const setTree = vi.spyOn(view, 'setTree');
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'draft');
    frames.flush();
    const draft = drafts.at(-1);
    if (!draft) throw new Error('No draft');

    key(field(container), 'Tab');

    expect(editor.source).toBe('- draft\n  - New topic\n- b\n');
    expect(changes[0]?.document).toBe(draft.document);
    expect(setTree).toHaveBeenCalledTimes(2);
    expect(editor.isEditing).toBe(true);
    expect(field(container).value).toBe('New topic');

    key(field(container), 'Escape');
    expect(editor.undo()).toBe(true);
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.canUndo).toBe(false);
  });

  it('[TC-2-27-6] never returns a stale draft source after another command', () => {
    const { container, view, editor, errors } = setup('# A\n\n- b\n');
    clickNode(container, view, editor.document.root);
    key(container, ' ');
    type(container, 'AB');
    expect(editor.snapshot()).toBe('# AB\n\n- b\n');
    expect(editor.setLabel(nodeId(editor, 'b'), 'changed')).toBe(true);

    type(container, 'A\nB');

    expect(editor.snapshot()).toBe('# A\n\n- changed\n');
    expect(editor.source).toBe('# A\n\n- changed\n');
    key(field(container), 'Enter');
    expect(editor.source).toBe('# A\n\n- changed\n');
    expect(editor.isEditing).toBe(true);
    expect(errors.at(-1)?.message).toContain('line break');
  });
});

describe('MarkmapEditor edges', () => {
  it('[TC-2-13-1] exposes selection, focus and empty history', () => {
    const { container, editor } = setup();
    expect(editor.selection).toBe(0);
    editor.focus();
    expect(document.activeElement).toBe(container);
    expect(editor.undo()).toBe(false);
    expect(editor.redo()).toBe(false);
    expect(editor.canRedo).toBe(false);
  });

  it('[TC-2-13-2] accepts a custom placeholder', () => {
    const { container, view, editor } = setup('- a\n- b\n', { placeholder: 'Topic' });
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Enter');
    expect(editor.source).toBe('- a\n- Topic\n- b\n');
    expect(field(container).value).toBe('Topic');
  });

  it('[TC-2-13-3] loads a source with a selection and emits', () => {
    const { editor, changes } = setup();
    editor.setSource('- x\n', { selection: 2, emit: true });
    expect(editor.selected).toBe(nodeId(editor, 'x'));
    expect(changes).toHaveLength(1);
  });

  it('[TC-2-13-4] handles field, secondary and committing clicks', () => {
    const { container, view, editor } = setup();
    const a = nodeId(editor, 'a');
    const b = nodeId(editor, 'b');
    clickNode(container, view, a);
    key(container, ' ');
    type(container, 'z');
    field(container).dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(editor.isEditing).toBe(true);
    expect(editor.source).toBe('- a\n- b\n');
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 2 }));
    expect(editor.isEditing).toBe(true);
    view.hit = { kind: 'node', nodeId: b };
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(editor.source).toBe('- z\n- b\n');
    expect(editor.selected).toBe(b);
    expect(editor.isEditing).toBe(false);
  });

  it('[TC-2-13-5] ignores a double click while editing or away from a node', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    container.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(editor.isEditing).toBe(true);
    key(field(container), 'Escape');
    view.hit = undefined;
    container.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(editor.isEditing).toBe(false);
  });

  it('[TC-2-13-6] ignores printable keys in selection mode and toggles folds', () => {
    const { container, view, editor } = setup();
    const a = nodeId(editor, 'a');
    clickNode(container, view, a);
    key(container, 'x');
    expect(editor.isEditing).toBe(false);
    expect(editor.source).toBe('- a\n- b\n');
    key(container, ' ');
    expect(editor.isEditing).toBe(true);
    expect(field(container).value).toBe('a');
    key(field(container), 'Escape');
    key(container, '/', { metaKey: true });
    expect(view.folded.has(a)).toBe(true);
  });

  it('[TC-2-13-7] stops arrows at boundaries', () => {
    const { container, view, editor } = setup();
    const a = nodeId(editor, 'a');
    const b = nodeId(editor, 'b');
    clickNode(container, view, a);
    key(container, 'ArrowUp');
    expect(editor.selected).toBe(a);
    clickNode(container, view, b);
    key(container, 'ArrowDown');
    expect(editor.selected).toBe(b);
    key(container, 'ArrowRight');
    expect(editor.selected).toBe(b);
    key(container, 'ArrowLeft');
    expect(editor.selected).toBe(editor.document.root);
    key(container, 'ArrowLeft');
    expect(editor.selected).toBe(editor.document.root);
    expect(view.folded.has(editor.document.root)).toBe(false);
  });

  it('[TC-2-13-8] allows Shift+Enter in a list label', () => {
    const { container, view, editor } = setup('- a\n');
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
    });
    field(container).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(editor.isEditing).toBe(true);
  });

  it('[TC-2-13-9] outdents from the field with Shift+Tab', () => {
    const { container, view, editor } = setup('- a\n  - b\n- c\n');
    clickNode(container, view, nodeId(editor, 'b'));
    key(container, ' ');
    type(container, 'B');
    key(field(container), 'Tab', { shiftKey: true });
    expect(editor.source).toBe('- a\n- B\n- c\n');
    expect(editor.isEditing).toBe(false);
  });

  it('[TC-4-5-1] styles the overlay field from the selected node label', () => {
    const { container, view, editor } = setup('# Root\n\n- a\n');
    const root = editor.document.root;
    view.labels.set(root, {
      font: {
        family: 'Inter, sans-serif',
        size: 20,
        weight: 600,
        style: 'normal',
        lineHeight: 26,
      },
      fill: '#ffffff',
      padding: [14, 18, 14, 18],
      align: 'center',
    });
    editor.startEditing(root);

    const field = container.querySelector<HTMLTextAreaElement>('.mm-editor-field')!;
    expect(field.style.fontFamily).toBe('Inter, sans-serif');
    expect(field.style.fontSize).toBe('20px');
    expect(field.style.fontWeight).toBe('600');
    expect(field.style.lineHeight).toBe('26px');
    expect(field.style.color).toBe('#ffffff');
    expect(field.style.padding).toBe('14px 18px');
    expect(field.style.textAlign).toBe('center');

    view.scale = 2;
    view.emit('zoom');
    expect(field.style.transform).toBe('scale(2)');
    expect(field.style.height).toBe('54px');

    const label = view.labels.get(root);
    if (!label) throw new Error('Missing label style');
    view.labels.set(root, { ...label, align: 'start' });
    view.emit('render');
    expect(field.style.textAlign).toBe('left');
    view.labels.set(root, { ...label, align: 'end' });
    view.emit('render');
    expect(field.style.textAlign).toBe('right');
  });

  it('[TC-4-5-3] centers an empty topic field on its visible block', () => {
    const { container, view, editor } = setup('# Root\n', { placeholder: '\u200B' });
    key(container, 'Enter');
    const topic = selectedId(editor);
    expect(field(container).value).toBe('');
    view.rects.set(topic, { x: 120, y: 40, width: 28, height: 40 });
    view.directions.set(topic, 'right');
    view.labels.set(topic, {
      font: {
        family: 'Inter, sans-serif',
        size: 16,
        weight: 500,
        style: 'normal',
        lineHeight: 22,
      },
      fill: '#2b3138',
      padding: [9, 14, 9, 14],
      align: 'center',
    });
    view.emit('render');

    const element = field(container);
    expect(element.style.padding).toBe('9px 14px');
    expect(element.style.left).toBe('114px');
    expect(element.style.top).toBe('40px');
    expect(element.style.width).toBe('40px');
    expect(element.style.height).toBe('40px');
    expect(element.style.textAlign).toBe('center');
    expect(parseFloat(element.style.left) + parseFloat(element.style.width) / 2).toBe(134);

    const box = container.querySelector<HTMLElement>('.mm-editor-selection');
    expect(box?.style.left).toBe('118px');
    expect(box?.style.top).toBe('38px');
    expect(box?.style.width).toBe('32px');
    expect(box?.style.height).toBe('44px');
  });

  it('[TC-2-13-10] exits an unchanged field on Enter', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    key(field(container), 'Enter');
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.isEditing).toBe(false);
  });

  it('[TC-2-13-11] guards editing without a label, a rect or a new node', () => {
    const { container, view, editor } = setup('---\ntitle: T\n---\n\n- a\n\n## B\n');
    editor.startEditing(editor.document.root);
    expect(editor.isEditing).toBe(false);
    const a = nodeId(editor, 'a');
    view.rects.set(a, undefined);
    editor.startEditing(a);
    expect(editor.isEditing).toBe(false);
    view.rects.delete(a);
    editor.startEditing(a);
    expect(editor.isEditing).toBe(true);
    editor.startEditing(a);
    expect(editor.isEditing).toBe(true);
    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  it('[TC-2-13-12] stops editing when the node loses its rect', () => {
    const { container, view, editor } = setup();
    const a = nodeId(editor, 'a');
    clickNode(container, view, a);
    key(container, ' ');
    view.rects.set(a, undefined);
    view.emit('render');
    expect(editor.isEditing).toBe(false);
    expect(field(container).style.display).toBe('none');
  });

  it('[TC-2-13-13] reveals a selection without a rect', () => {
    const { container, view, editor } = setup();
    const a = nodeId(editor, 'a');
    view.rects.set(a, undefined);
    key(container, 'ArrowRight');
    expect(editor.selected).toBe(a);
    expect(view.focused).toContain(a);
  });

  it('[TC-2-13-14] drops a fold whose node is deleted', () => {
    const { container, view, editor } = setup();
    const a = nodeId(editor, 'a');
    view.folded.add(a);
    clickNode(container, view, a);
    key(container, 'Delete');
    expect(editor.source).toBe('- b\n');
  });

  it('[TC-2-13-15] shares one style between editors', () => {
    const first = setup();
    const second = setup();
    expect(document.getElementById('mm-editor-style')).not.toBeNull();
    first.editor.destroy();
    expect(document.getElementById('mm-editor-style')).not.toBeNull();
    second.editor.destroy();
    expect(document.getElementById('mm-editor-style')).toBeNull();
  });

  it('[TC-2-13-16] restores a positioned container', () => {
    const container = document.createElement('div');
    container.style.position = 'relative';
    container.tabIndex = 0;
    document.body.append(container);
    const editor = new MarkmapEditor({ source: '- a\n', view: new FakeView(), container });
    editor.destroy();
    expect(container.style.position).toBe('relative');
    expect(container.getAttribute('tabindex')).toBe('0');
  });

  it('[TC-2-13-17] ignores input outside editing', () => {
    const { container } = setup();
    field(container).dispatchEvent(new Event('input', { bubbles: true }));
    expect(field(container).value).toBe('');
  });

  it('[TC-2-13-18] ignores keys without a selection', () => {
    const source = '---\ntitle: T\n---\n\n- a\n- b\n';
    const { container, editor } = setup(source);
    editor.setSource(source, { selection: 0 });
    expect(editor.selected).toBeNull();
    key(container, 'Enter');
    expect(editor.source).toBe(source);
    key(container, '/', { metaKey: true });
    expect(editor.isEditing).toBe(false);
    key(container, 'Escape');
    expect(editor.selected).toBeNull();
  });

  it('[TC-2-13-19] ignores a prevented key', () => {
    const { container, editor } = setup();
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    container.dispatchEvent(event);
    expect(editor.source).toBe('- a\n- b\n');
  });

  it('[TC-2-13-20] replaces the source while editing', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'x');
    editor.setSource('- z\n');
    expect(editor.isEditing).toBe(false);
    expect(editor.source).toBe('- z\n');
    expect(editor.selected).toBe(editor.document.root);
  });

  it('[TC-2-13-21] switches the edit target and commits the first', () => {
    const { container, view, editor } = setup();
    const a = nodeId(editor, 'a');
    const b = nodeId(editor, 'b');
    clickNode(container, view, a);
    key(container, ' ');
    type(container, 'A');
    editor.startEditing(b);
    expect(editor.source).toBe('- A\n- b\n');
    expect(editor.isEditing).toBe(true);
    expect(field(container).value).toBe('b');
  });

  it('[TC-2-13-22] undoes from the container after editing', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Enter');
    key(field(container), 'Escape');
    key(container, 'z', { metaKey: true });
    expect(editor.source).toBe('- a\n- b\n');
  });
});

describe('MarkmapEditor notes', () => {
  it('[TC-3-6-1] opens a notes panel with the fence text and accessible controls', () => {
    const { container, view, editor } = setup('# A\n\n```markmap-note\nhello\n```\n');
    const notes = openNotes(container, view, editor, 'A');
    expect(editor.isEditingNotes).toBe(true);
    expect(notes.value).toBe('hello');
    const panel = notesPanel(container);
    expect(panel?.getAttribute('role')).toBe('dialog');
    expect(panel?.getAttribute('aria-label')).toBe('Notes');
    expect(panel?.querySelector('.mm-editor-notes-toolbar')).not.toBeNull();
    expect(
      Array.from(panel?.querySelectorAll('button') ?? []).map((button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual(['Bold', 'Italic', 'Inline code', 'Link', 'Quote', 'Code block']);
  });

  it('[TC-3-6-2] joins legacy notes and opens an empty panel for a node without notes', () => {
    const legacy = setup('# A\n\nFirst.\n\nSecond.\n');
    const notes = openNotes(legacy.container, legacy.view, legacy.editor, 'A');
    expect(notes.value).toBe('First.\n\nSecond.');
    key(notes, 'Escape');
    const empty = setup('- a\n');
    expect(openNotes(empty.container, empty.view, empty.editor, 'a').value).toBe('');
  });

  it('[TC-3-6-3] commits an open label before opening notes', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'A');
    expect(editor.editNotes()).toBe(true);
    expect(editor.isEditing).toBe(false);
    expect(editor.isEditingNotes).toBe(true);
    expect(editor.source).toBe('- A\n- b\n');
    expect(notesField(container).value).toBe('');
  });

  it('[TC-3-6-4] rejects an opaque node and an empty root', () => {
    const opaque = setup('- # T\n');
    clickNode(opaque.container, opaque.view, nodeId(opaque.editor, 'T'));
    expect(opaque.editor.editNotes()).toBe(false);
    expect(opaque.errors).toHaveLength(1);
    expect(notesPanel(opaque.container)).toBeNull();

    const empty = setup('');
    clickNode(empty.container, empty.view, empty.editor.document.root);
    expect(empty.editor.editNotes()).toBe(false);
    expect(empty.errors).toHaveLength(1);
    expect(notesPanel(empty.container)).toBeNull();

    const blank = setup('#\n');
    clickNode(blank.container, blank.view, blank.editor.document.root);
    expect(blank.editor.editNotes()).toBe(false);
    expect(blank.errors).toHaveLength(1);
    expect(notesPanel(blank.container)).toBeNull();
  });

  it('[TC-3-6-5] reads and opens notes on a title root', () => {
    const { container, view, editor } = setup(
      '---\ntitle: T\n---\n\n```markmap-note\nroot note\n```\n\n## B\n',
    );
    clickNode(container, view, editor.document.root);
    expect(editor.editNotes()).toBe(true);
    expect(notesField(container).value).toBe('root note');
  });

  it('[TC-3-7-1] places the panel below the node without scaling it', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    setLayout(container);
    openNotes(container, view, editor, 'a');
    const panel = notesPanel(container);
    expect(panel?.style.left).toBe('8px');
    expect(panel?.style.top).toBe('58px');
    expect(panel?.style.width).toBe('400px');
    expect(panel?.style.maxHeight).toBe('300px');
    expect(panel?.style.transform).toBe('');
  });

  it('[TC-3-7-2] places the panel above the node when it does not fit below', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    setLayout(container);
    view.rects.set(nodeId(editor, 'a'), { x: 100, y: 500, width: 100, height: 30 });
    openNotes(container, view, editor, 'a');
    expect(notesPanel(container)?.style.top).toBe('272px');
  });

  it('[TC-3-7-3] repositions the panel on render and zoom', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    setLayout(container);
    openNotes(container, view, editor, 'a');
    view.rects.set(nodeId(editor, 'a'), { x: 300, y: 200, width: 100, height: 30 });
    view.emit('render');
    expect(notesPanel(container)?.style.left).toBe('150px');
    expect(notesPanel(container)?.style.top).toBe('238px');
    view.rects.set(nodeId(editor, 'a'), { x: 100, y: 100, width: 100, height: 30 });
    view.emit('zoom');
    expect(notesPanel(container)?.style.left).toBe('8px');
    expect(notesPanel(container)?.style.top).toBe('138px');
  });

  it('[TC-3-8-1] wraps bold and italic selections and places an empty caret', () => {
    const { container, view, editor } = setup('- a\n');
    const notes = openNotes(container, view, editor, 'a');
    notes.value = 'hello';
    notes.setSelectionRange(0, 5);
    clickNotesButton(container, 'Bold');
    expect(notes.value).toBe('**hello**');
    expect([notes.selectionStart, notes.selectionEnd]).toEqual([2, 7]);
    notes.setSelectionRange(0, notes.value.length);
    clickNotesButton(container, 'Italic');
    expect(notes.value).toBe('_**hello**_');
    notes.value = '';
    notes.setSelectionRange(0, 0);
    clickNotesButton(container, 'Bold');
    expect(notes.value).toBe('****');
    expect(notes.selectionStart).toBe(2);
  });

  it('[TC-3-8-2] wraps inline code with a longer backtick run', () => {
    const { container, view, editor } = setup('- a\n');
    const notes = openNotes(container, view, editor, 'a');
    notes.value = 'a `b` c';
    notes.setSelectionRange(2, 5);
    clickNotesButton(container, 'Inline code');
    expect(notes.value).toBe('a ```b``` c');
    notes.value = '';
    notes.setSelectionRange(0, 0);
    clickNotesButton(container, 'Inline code');
    expect(notes.value).toBe('``');
    expect(notes.selectionStart).toBe(1);
  });

  it('[TC-3-8-3] inserts a link and selects its url', () => {
    const { container, view, editor } = setup('- a\n');
    const notes = openNotes(container, view, editor, 'a');
    notes.value = 'text';
    notes.setSelectionRange(0, 4);
    clickNotesButton(container, 'Link');
    expect(notes.value).toBe('[text](url)');
    expect([notes.selectionStart, notes.selectionEnd]).toEqual([7, 10]);
    expect(document.activeElement).toBe(notes);
  });

  it('[TC-3-8-4] quotes every selected line', () => {
    const { container, view, editor } = setup('- a\n');
    const notes = openNotes(container, view, editor, 'a');
    notes.value = 'one\ntwo';
    notes.setSelectionRange(0, 7);
    clickNotesButton(container, 'Quote');
    expect(notes.value).toBe('> one\n> two');
    expect([notes.selectionStart, notes.selectionEnd]).toEqual([0, 11]);
    notes.value = 'one';
    notes.setSelectionRange(1, 1);
    clickNotesButton(container, 'Quote');
    expect(notes.value).toBe('> one');
    expect(notes.selectionStart).toBe(3);
  });

  it('[TC-3-8-5] wraps a code block with a longer fence and puts the caret inside', () => {
    const { container, view, editor } = setup('- a\n');
    const notes = openNotes(container, view, editor, 'a');
    notes.value = 'a\n```\nb';
    notes.setSelectionRange(0, notes.value.length);
    clickNotesButton(container, 'Code block');
    expect(notes.value).toBe('````\na\n```\nb\n````');
    expect(notes.selectionStart).toBe(5);
  });

  it('[TC-3-8-6] inserts an empty code block with the caret inside', () => {
    const { container, view, editor } = setup('- a\n');
    const notes = openNotes(container, view, editor, 'a');
    notes.setSelectionRange(0, 0);
    clickNotesButton(container, 'Code block');
    expect(notes.value).toBe('```\n\n```');
    expect(notes.selectionStart).toBe(4);
  });

  it('[TC-3-8-7] keeps the focus in the field after a toolbar action', () => {
    const { container, view, editor } = setup('- a\n');
    const notes = openNotes(container, view, editor, 'a');
    clickNotesButton(container, 'Bold');
    expect(document.activeElement).toBe(notes);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    notesButton(container, 'Bold').dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it('[TC-3-8-8] gives every toolbar button a matching outline icon and title', () => {
    const { container, view, editor } = setup('- a\n');
    openNotes(container, view, editor, 'a');
    const buttons = Array.from(notesPanel(container)?.querySelectorAll('button') ?? []);
    expect(buttons).toHaveLength(6);
    for (const button of buttons) {
      const name = button.getAttribute('aria-label');
      expect(button.getAttribute('title')).toBe(name);
      const icon = button.querySelector('svg');
      expect(icon?.getAttribute('viewBox')).toBe('0 0 16 16');
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
      const path = icon?.querySelector('path');
      expect(path?.getAttribute('fill')).toBe('none');
      expect(path?.getAttribute('stroke')).toBe('currentColor');
      expect(path?.getAttribute('stroke-linecap')).toBe('round');
      expect(path?.getAttribute('stroke-linejoin')).toBe('round');
    }
  });

  it('[TC-3-9-1] cancels notes with Escape without a source change', () => {
    const { container, view, editor, changes } = setup('- a\n');
    const notes = openNotes(container, view, editor, 'a');
    notes.value = 'note';
    key(notes, 'Escape');
    expect(editor.isEditingNotes).toBe(false);
    expect(notesPanel(container)).toBeNull();
    expect(editor.source).toBe('- a\n');
    expect(changes).toHaveLength(0);
  });

  it('[TC-3-9-2] commits notes with Cmd/Ctrl+Enter and closes the panel', () => {
    const { container, view, editor, changes } = setup('- a\n');
    const notes = openNotes(container, view, editor, 'a');
    notes.value = 'note';
    key(notes, 'Enter', { metaKey: true });
    expect(editor.source).toBe('- a\n  ```markmap-note\n  note\n  ```\n');
    expect(editor.isEditingNotes).toBe(false);
    expect(editor.canUndo).toBe(true);
    expect(changes).toHaveLength(1);
  });

  it('[TC-3-9-3] leaves Enter to the textarea and inserts no sibling', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    const notes = openNotes(container, view, editor, 'a');
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    notes.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    const undo = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    notes.dispatchEvent(undo);
    expect(undo.defaultPrevented).toBe(false);
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.isEditingNotes).toBe(true);
  });

  it('[TC-3-9-4] formats with Cmd/Ctrl+B and Cmd/Ctrl+I', () => {
    const { container, view, editor } = setup('- a\n');
    const notes = openNotes(container, view, editor, 'a');
    notes.value = 'x';
    notes.setSelectionRange(0, 1);
    key(notes, 'b', { metaKey: true });
    expect(notes.value).toBe('**x**');
    key(notes, 'i', { ctrlKey: true });
    expect(notes.value).toBe('**_x_**');
  });

  it('[TC-3-9-5] commits on an outside click and keeps clicks inside the panel', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    const notes = openNotes(container, view, editor, 'a');
    notes.value = 'note';
    notes.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(editor.isEditingNotes).toBe(true);
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.selected).toBe(nodeId(editor, 'a'));

    clickNode(container, view, nodeId(editor, 'b'));
    expect(editor.isEditingNotes).toBe(false);
    expect(editor.source).toBe('- a\n  ```markmap-note\n  note\n  ```\n- b\n');
    expect(editor.selected).toBe(nodeId(editor, 'b'));
  });

  it('[TC-3-10-1] keeps the panel and one history entry across snapshots', () => {
    const { container, view, editor, changes } = setup('- a\n- b\n');
    const notes = openNotes(container, view, editor, 'a');
    notes.value = 'note';
    const source = editor.snapshot();
    expect(source).toBe('- a\n  ```markmap-note\n  note\n  ```\n- b\n');
    expect(editor.isEditingNotes).toBe(true);
    expect(document.activeElement).toBe(notes);
    expect(changes).toHaveLength(1);
    expect(editor.snapshot()).toBe(source);
    expect(changes).toHaveLength(1);
    expect(editor.undo()).toBe(true);
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.isEditingNotes).toBe(false);
  });

  it('[TC-3-10-2] destroys the panel and its state', () => {
    const { container, view, editor } = setup('- a\n');
    openNotes(container, view, editor, 'a');
    editor.destroy();
    expect(notesPanel(container)).toBeNull();
    expect(editor.isEditingNotes).toBe(false);
  });

  it('[TC-3-10-3] commits notes with commit and drops them on setSource', () => {
    const first = setup('- a\n');
    const notes = openNotes(first.container, first.view, first.editor, 'a');
    notes.value = 'note';
    first.editor.commit();
    expect(first.editor.isEditingNotes).toBe(false);
    expect(first.editor.source).toBe('- a\n  ```markmap-note\n  note\n  ```\n');

    const second = setup('- a\n');
    const open = openNotes(second.container, second.view, second.editor, 'a');
    open.value = 'note';
    second.editor.setSource('- z\n');
    expect(second.editor.isEditingNotes).toBe(false);
    expect(second.editor.source).toBe('- z\n');
  });

  it('[TC-3-6-6] guards notes without a selection, a node or a rect', () => {
    const source = '---\ntitle: T\n---\n\n- a\n';
    const { view, editor } = setup(source);
    editor.setSource(source, { selection: 0 });
    expect(editor.selected).toBeNull();
    expect(editor.editNotes()).toBe(false);
    const id = nodeId(editor, 'a');
    expect(editor.editNotes('missing')).toBe(false);
    view.rects.set(id, undefined);
    expect(editor.editNotes(id)).toBe(false);
    view.rects.delete(id);
    expect(editor.editNotes(id)).toBe(true);
  });

  it('[TC-3-6-7] returns for the open node and switches to another node', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    openNotes(container, view, editor, 'a');
    expect(editor.editNotes()).toBe(true);
    const b = nodeId(editor, 'b');
    expect(editor.editNotes(b)).toBe(true);
    expect(editor.selected).toBe(b);
    expect(notesField(container).value).toBe('');
  });

  it('[TC-3-6-8] stops when the open label cannot be committed', () => {
    const { container, view, editor, errors } = setup('# A\n');
    clickNode(container, view, editor.document.root);
    key(container, ' ');
    type(container, 'a\nb');
    expect(editor.editNotes()).toBe(false);
    expect(editor.isEditing).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('[TC-3-7-4] closes the panel when the node loses its rect', () => {
    const { container, view, editor } = setup('- a\n');
    const id = nodeId(editor, 'a');
    openNotes(container, view, editor, 'a');
    view.rects.set(id, undefined);
    view.emit('render');
    expect(editor.isEditingNotes).toBe(false);
    expect(notesPanel(container)).toBeNull();
  });

  it('[TC-3-7-5] adds a compact header with a pencil icon and a muted label', () => {
    const { container, view, editor } = setup('- a\n');
    openNotes(container, view, editor, 'a');
    const header = notesPanel(container)?.querySelector<HTMLElement>('.mm-editor-notes-header');
    const icon = header?.querySelector('svg[aria-hidden="true"]');
    expect(icon?.getAttribute('viewBox')).toBe('0 0 16 16');
    const path = icon?.querySelector('path');
    expect(path?.getAttribute('d')).toBe(
      'M3 13l1-3.4L11 2.6a1.7 1.7 0 0 1 2.4 2.4L6.4 12 3 13zM9.9 3.7l2.4 2.4',
    );
    expect(path?.getAttribute('d')).not.toBe('M4 2.5h5l3 3v8H4zM9 2.5v3h3M6.2 8h3.6M6.2 10.5h3.6');
    expect(header?.querySelector('.mm-editor-notes-title')?.textContent).toBe('Notes');
    expect(header?.querySelector('.mm-editor-notes-label')?.textContent).toBe('Markdown');
    const style = document.getElementById('mm-editor-style')?.textContent ?? '';
    expect(style).toContain('.mm-editor-notes-icon{flex:none;width:16px;height:16px;');
  });

  it('[TC-3-11-1] draws the panel from host theme tokens with theme-aware fallbacks', () => {
    setup();
    const style = document.getElementById('mm-editor-style')?.textContent ?? '';
    for (const token of [
      '--oc-elevated',
      '--oc-fg',
      '--oc-bg',
      '--oc-border',
      '--oc-hover',
      '--oc-focus',
      '--oc-radius',
      '--oc-muted',
    ]) {
      expect(style).toContain(token);
    }
    for (const alias of [
      '--oc-editor-background',
      '--oc-background',
      '--oc-foreground',
      '--oc-button-background',
      '--oc-input-background',
    ]) {
      expect(style).not.toContain(alias);
    }
    expect(style).toContain('background:var(--oc-elevated,light-dark(#fff,#1f1f1f))');
    expect(style).toContain('background:var(--oc-bg,light-dark(#fff,#141414))');
  });

  it('[TC-3-9-6] routes container keys into the notes field', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    const notes = openNotes(container, view, editor, 'a');
    key(container, 'Enter');
    expect(document.activeElement).toBe(notes);
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.isEditingNotes).toBe(true);
  });

  it('[TC-3-9-7] commits on a document mousedown outside the panel', () => {
    const { container, view, editor, changes } = setup('- a\n');
    const notes = openNotes(container, view, editor, 'a');
    notes.value = 'note';
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(editor.isEditingNotes).toBe(false);
    expect(editor.source).toBe('- a\n  ```markmap-note\n  note\n  ```\n');
    expect(changes).toHaveLength(1);
  });

  it('[TC-3-9-8] closes unchanged notes without a change', () => {
    const { container, view, editor, changes } = setup('- a\n');
    openNotes(container, view, editor, 'a');
    editor.commit();
    expect(editor.isEditingNotes).toBe(false);
    expect(editor.source).toBe('- a\n');
    expect(changes).toHaveLength(0);
  });

  it('[TC-3-10-4] returns the source for a snapshot outside editing', () => {
    const { editor } = setup('- a\n');
    expect(editor.snapshot()).toBe('- a\n');
  });

  it('[TC-3-10-5] drops a whitespace-only note without a history entry', () => {
    const { container, view, editor } = setup('- a\n');
    const notes = openNotes(container, view, editor, 'a');
    notes.value = '   ';
    editor.commit();
    expect(editor.isEditingNotes).toBe(false);
    expect(editor.source).toBe('- a\n');
    expect(editor.canUndo).toBe(false);
  });

  it('[TC-3-5-4] copies and cuts a block with its fence', () => {
    const { container, view, editor } = setup('- a\n\n  ```markmap-note\n  note\n  ```\n- b\n');
    clickNode(container, view, nodeId(editor, 'a'));
    expect(editor.selectedBlock()).toBe('- a\n\n  ```markmap-note\n  note\n  ```');
    expect(editor.deleteSelected()).toBe(true);
    expect(editor.source).toBe('- b\n');

    const title = setup('---\ntitle: T\n---\n\n```markmap-note\nroot note\n```\n\n## B\n\n## C\n');
    clickNode(title.container, title.view, title.editor.document.root);
    expect(title.editor.selectedBlock()).toBe(
      '# T\n\n```markmap-note\nroot note\n```\n\n## B\n\n## C\n',
    );
  });
});

describe('createEditView', () => {
  it('[TC-2-11-1] delegates to a Markmap instance', () => {
    const element = document.createElement('div');
    const mm = {
      element,
      transform: {
        k: 2,
        x: 5,
        y: 6,
        translate: (x: number, y: number) => ({ k: 2, x: 5 + x * 2, y: 6 + y * 2 }),
      },
      zoomBehavior: { transform: vi.fn<(selection: unknown, transform: unknown) => void>() },
      foldedIds: new Set<string>(),
      setTree: vi.fn<(root: MarkmapNode) => void>(),
      setFolded: vi.fn<(id: string, folded: boolean) => void>(),
      setFoldedIds: vi.fn<(ids: Iterable<string>, options?: { animate?: boolean }) => void>(),
      toggle: vi.fn<(id: string) => void>(),
      focusNode: vi.fn<(id: string, options?: { animate?: boolean }) => boolean>(),
      screenRect: vi.fn<(id: string) => Rect | undefined>(),
      groupScreenRect: vi.fn<(id: string | number) => Rect | undefined>(),
      result: { layout: { byId: new Map([['a', { direction: 'left' as const }]]) } },
      hitAt: vi.fn<(x: number, y: number) => { kind: string; nodeId?: string } | undefined>(),
      layoutPoint: vi.fn<(clientX: number, clientY: number) => [number, number]>(),
      on: vi.fn<(kind: string, listener: () => void) => () => void>(),
      setGraph: vi.fn<(graph?: GraphData, identities?: ReadonlyMap<string, string>) => void>(),
    };
    const view = createEditView(mm as unknown as Markmap);
    expect(view.element).toBe(element);
    expect(view.scale).toBe(2);
    expect(view.transform).toEqual({ k: 2, x: 5, y: 6 });
    view.panBy(10, 20);
    expect(mm.zoomBehavior.transform).toHaveBeenCalled();
    expect(view.foldedIds).toBe(mm.foldedIds);
    expect(view.direction('a')).toBe('left');
    expect(view.direction('b')).toBeUndefined();
    const emptyView = createEditView({ ...mm, result: undefined } as unknown as Markmap);
    expect(emptyView.direction('a')).toBeUndefined();
    view.setTree({ id: 'root' } as MarkmapNode);
    view.setGraph?.({ edges: [], groups: [], block: null }, new Map());
    view.setFolded('a', true);
    view.setFoldedIds(['a']);
    view.toggle('a');
    view.focusNode('a', { animate: false });
    view.screenRect('a');
    view.groupScreenRect?.('group-0');
    view.hitAt(1, 2);
    view.layoutPoint(1, 2);
    view.on('render', () => {});
    expect(mm.setTree).toHaveBeenCalled();
    expect(mm.setGraph).toHaveBeenCalled();
    expect(mm.setFolded).toHaveBeenCalledWith('a', true);
    expect(mm.setFoldedIds).toHaveBeenCalledWith(['a'], undefined);
    expect(mm.toggle).toHaveBeenCalledWith('a');
    expect(mm.focusNode).toHaveBeenCalledWith('a', { animate: false });
    expect(mm.groupScreenRect).toHaveBeenCalledWith('group-0');
    expect(mm.on).toHaveBeenCalledWith('render', expect.any(Function));
  });
});

describe('createEditView label style', () => {
  it('[TC-4-5-2] resolves the selected node style and its dark fill', () => {
    const element = document.createElement('div');
    const node = {
      id: 'root',
      type: 'heading',
      content: [],
      notes: [],
      data: {},
      children: [],
    } as unknown as MarkmapNode;
    const ctx = {
      depth: 0,
      path: ['root'],
      branch: 0,
      hasChildren: false,
      folded: false,
      direction: 'right' as const,
    };
    const result = {
      theme: softTheme,
      layout: {
        byId: new Map([['root', { node, ctx, rect: { x: 0, y: 0, width: 20, height: 30 } }]]),
        nodes: [],
        bounds: { x: 0, y: 0, width: 20, height: 30 },
      },
      contexts: new Map([['root', ctx]]),
      state: {
        nodes: [
          {
            node,
            ctx,
            rect: { x: 0, y: 0, width: 20, height: 30 },
            text: { width: 20, height: 30, lines: 1, runs: [], primitives: [] },
            label: { font: softTheme.font, fill: 'var(--mm-text)', padding: [0, 0, 0, 0] },
            presence: 1,
          },
        ],
      },
      primitives: [],
      bounds: { x: 0, y: 0, width: 20, height: 30 },
    };
    const mm = {
      element,
      transform: { k: 1, x: 0, y: 0 },
      options: { colorScheme: 'dark' },
      result,
    };
    const view = createEditView(mm as unknown as Markmap);

    expect(view.labelStyle?.('missing')).toBeUndefined();
    expect(view.labelStyle?.('root')).toMatchObject({
      font: { size: 20, weight: 600 },
      fill: '#ffffff',
      padding: [14, 18, 14, 18],
      align: 'center',
    });
    const autoView = createEditView({
      ...mm,
      options: { colorScheme: 'auto' },
    } as unknown as Markmap);
    expect(autoView.labelStyle?.('root')?.font.size).toBe(20);
  });
});

describe('Empty document', () => {
  it('[TC-2-14-1] types the first heading', () => {
    const { container, editor, changes } = setup('');
    expect(editor.selected).toBe(editor.document.root);

    key(container, 'F');
    expect(field(container).value).toBe('F');
    expect(editor.source).toBe('');

    editor.commit();
    expect(editor.source).toBe('# F');
    expect(editor.selected).toBe(editor.document.root);
    expect(changes.at(-1)?.source).toBe('# F');
  });

  it('[TC-2-14-2] cancels the first label without a change', () => {
    const { container, editor, changes } = setup('');
    key(container, ' ');
    expect(editor.isEditing).toBe(true);
    key(field(container), 'Escape');
    expect(editor.isEditing).toBe(false);
    expect(editor.source).toBe('');
    expect(changes).toHaveLength(0);
  });

  it('[TC-2-14-3] opens the first label and exits on Enter', () => {
    const { container, editor } = setup('', { placeholder: '\u200B' });
    key(container, 'Enter');
    expect(editor.isEditing).toBe(true);
    type(container, 'First note');
    key(field(container), 'Enter');
    expect(editor.source).toBe('# First note');
    expect(editor.isEditing).toBe(false);
    key(container, 'Enter');
    expect(editor.source).toBe('# First note\n## \u200B');
    expect(editor.isEditing).toBe(true);
    key(field(container), 'Escape');
  });

  it('[TC-2-14-4] undoes the first heading and keeps the root selected', () => {
    const { container, editor } = setup('');
    key(container, ' ');
    type(container, 'First note');
    editor.commit();
    expect(editor.source).toBe('# First note');

    expect(editor.undo()).toBe(true);
    expect(editor.source).toBe('');
    expect(editor.selected).toBe(editor.document.root);
    key(container, ' ');
    type(container, 'N');
    expect(field(container).value).toBe('N');
  });

  it('[TC-2-14-5] keeps a promoted root selected after a rename', () => {
    const { container, editor } = setup('# A\n');
    key(container, ' ');
    type(container, 'B');
    editor.commit();
    expect(editor.source).toBe('# B\n');
    expect(editor.selected).toBe(editor.document.root);
  });

  it('[TC-2-14-6] hides the empty frame and ignores Delete', () => {
    const { container, editor, errors } = setup('');
    expect(container.querySelector<HTMLElement>('.mm-editor-selection')?.style.display).toBe(
      'none',
    );

    key(container, 'Backspace');
    expect(errors).toHaveLength(0);
    expect(editor.source).toBe('');
  });

  it('[TC-2-14-7] creates a first heading from a title root without headings', () => {
    const { container, editor, errors } = setup('---\ntitle: T\n---\n');
    key(container, ' ');
    expect(editor.isEditing).toBe(true);
    type(container, 'First');
    key(field(container), 'Enter');
    expect(errors).toHaveLength(0);
    expect(editor.source).toBe('---\ntitle: T\n---\n# First\n');
    expect(editor.document.nodes.get(editor.document.root)?.label).toBeDefined();
    expect(labelText(editor.document, editor.document.nodes.get(editor.document.root)!)).toBe(
      'First',
    );
  });
});

describe('Label snapshots', () => {
  it('[TC-2-22-1] snapshots twice and commits one undo entry', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'one');
    expect(editor.snapshot()).toBe('- one\n- b\n');
    type(container, 'two');
    expect(editor.snapshot()).toBe('- two\n- b\n');
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.isEditing).toBe(true);

    editor.commit();
    expect(editor.source).toBe('- two\n- b\n');
    expect(editor.undo()).toBe(true);
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.canUndo).toBe(false);
    expect(editor.redo()).toBe(true);
    expect(editor.source).toBe('- two\n- b\n');
  });

  it('[TC-2-22-2] keeps redo after an unchanged snapshot session', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Delete');
    expect(editor.undo()).toBe(true);
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.canRedo).toBe(true);

    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    expect(editor.snapshot()).toBe('- a\n- b\n');
    key(field(container), 'Escape');
    expect(editor.canRedo).toBe(true);
    expect(editor.canUndo).toBe(false);
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.redo()).toBe(true);
    expect(editor.source).toBe('- b\n');
  });

  it('[TC-2-22-3] restores the baseline on Escape after zero, one or many snapshots', () => {
    for (const copies of [0, 1, 3]) {
      const { container, view, editor, changes, drafts } = setup();
      clickNode(container, view, nodeId(editor, 'a'));
      key(container, ' ');
      type(container, 'draft');
      for (let index = 0; index < copies; index += 1) {
        type(container, `draft-${index}`);
        expect(editor.snapshot()).toContain(`draft-${index}`);
      }
      key(field(container), 'Escape');
      expect(editor.source).toBe('- a\n- b\n');
      expect(editor.isEditing).toBe(false);
      expect(editor.canUndo).toBe(false);
      expect(drafts.at(-1)?.source).toBe('- a\n- b\n');
      expect(changes).toHaveLength(0);
    }
  });

  it('[TC-2-22-4] keeps the field, focus and caret during snapshots', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'draft');
    const input = field(container);
    input.setSelectionRange(2, 4);
    expect(editor.snapshot()).toBe('- draft\n- b\n');
    expect(editor.snapshot()).toBe('- draft\n- b\n');
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(4);
    expect(editor.isEditing).toBe(true);
    expect(container.classList.contains('mm-editor-mode-edit')).toBe(true);
  });

  it('[TC-2-22-5] never publishes a failed draft', () => {
    const { container, editor, changes, drafts } = setup('# A\n');
    key(container, ' ');
    type(container, 'AB');
    expect(editor.snapshot()).toBe('# AB\n');
    type(container, 'A\nB');
    expect(editor.snapshot()).toBe('# AB\n');
    expect(drafts.at(-1)?.source).toBe('# AB\n');
    expect(changes).toHaveLength(0);
    key(field(container), 'Escape');
    expect(editor.source).toBe('# A\n');
    expect(drafts.at(-1)?.source).toBe('# A\n');
    expect(changes).toHaveLength(0);
  });

  it('[TC-2-22-6] resets the field with Cmd+Z and republishes the baseline', () => {
    const { container, view, editor, changes, drafts } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'draft');
    expect(editor.snapshot()).toBe('- draft\n- b\n');
    key(field(container), 'z', { metaKey: true });
    expect(field(container).value).toBe('a');
    expect(editor.isEditing).toBe(true);
    expect(editor.source).toBe('- a\n- b\n');
    expect(drafts.at(-1)?.source).toBe('- a\n- b\n');
    expect(changes).toHaveLength(0);
  });
});

describe('No-op label sessions', () => {
  it('[TC-2-22-7] closes trailing-space and leading-space no-ops without history', () => {
    for (const text of ['A ', ' A']) {
      const { container, editor, changes, drafts } = setup('# A\n');
      key(container, ' ');
      type(container, text);
      key(field(container), 'Enter');
      expect(editor.source).toBe('# A\n');
      expect(editor.isEditing).toBe(false);
      expect(editor.canUndo).toBe(false);
      expect(changes).toHaveLength(0);
      expect(drafts).toHaveLength(0);
    }
  });

  it('[TC-2-22-8] keeps redo after a normalized no-op session', () => {
    const { container, view, editor } = setup('# A\n');
    expect(editor.setLabel(editor.document.root, 'B')).toBe(true);
    expect(editor.source).toBe('# B\n');
    expect(editor.undo()).toBe(true);
    expect(editor.source).toBe('# A\n');
    expect(editor.canRedo).toBe(true);

    clickNode(container, view, editor.document.root);
    key(container, ' ');
    type(container, 'A ');
    key(field(container), 'Enter');
    expect(editor.source).toBe('# A\n');
    expect(editor.canUndo).toBe(false);
    expect(editor.canRedo).toBe(true);
    expect(editor.redo()).toBe(true);
    expect(editor.source).toBe('# B\n');
  });

  it('[TC-2-22-9] keeps redo after a no-op programmatic label', () => {
    const { editor } = setup('# A\n');
    expect(editor.setLabel(editor.document.root, 'B')).toBe(true);
    expect(editor.undo()).toBe(true);
    expect(editor.canRedo).toBe(true);
    expect(editor.setLabel(editor.document.root, 'A ')).toBe(true);
    expect(editor.source).toBe('# A\n');
    expect(editor.canUndo).toBe(false);
    expect(editor.canRedo).toBe(true);
    expect(editor.redo()).toBe(true);
    expect(editor.source).toBe('# B\n');
  });
});

describe('Draft notifications', () => {
  it('[TC-2-24-1] emits a draft before the first snapshot', () => {
    const { container, view, editor, drafts, changes } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'draft');
    expect(drafts.map((change) => change.source)).toEqual(['- draft\n- b\n']);
    expect(changes).toHaveLength(0);
    expect(editor.source).toBe('- a\n- b\n');
  });

  it('[TC-2-24-2] returns the draft without a second event', () => {
    const { container, view, editor, drafts, changes } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'draft');
    expect(editor.snapshot()).toBe('- draft\n- b\n');
    expect(editor.snapshot()).toBe('- draft\n- b\n');
    expect(drafts).toHaveLength(1);
    expect(changes).toHaveLength(0);
  });

  it('[TC-2-24-3] emits a newer draft after a snapshot', () => {
    const { container, view, editor, drafts } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'one');
    expect(editor.snapshot()).toBe('- one\n- b\n');
    type(container, 'two');
    expect(drafts.map((change) => change.source)).toEqual(['- one\n- b\n', '- two\n- b\n']);
    expect(editor.snapshot()).toBe('- two\n- b\n');
  });

  it('[TC-2-24-5] never publishes stale text for an invalid draft', () => {
    const { container, editor, drafts, changes } = setup('# A\n');
    key(container, ' ');
    type(container, 'AB');
    expect(drafts.map((change) => change.source)).toEqual(['# AB\n']);
    type(container, 'A\nB');
    expect(editor.snapshot()).toBe('# AB\n');
    expect(drafts).toHaveLength(1);
    expect(changes).toHaveLength(0);
    key(field(container), 'Escape');
    expect(drafts.at(-1)?.source).toBe('# A\n');
    expect(editor.source).toBe('# A\n');
  });

  it('[TC-2-24-6] emits the baseline when editing is cancelled', () => {
    const { container, view, editor, drafts, changes } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'draft');
    expect(drafts.at(-1)?.source).toBe('- draft\n- b\n');
    key(field(container), 'Escape');
    expect(drafts.at(-1)?.source).toBe('- a\n- b\n');
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.canUndo).toBe(false);
    expect(changes).toHaveLength(0);
  });

  it('[TC-2-24-7] keeps one history entry after draft notifications', () => {
    const { container, view, editor, changes } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'one');
    expect(editor.snapshot()).toBe('- one\n- b\n');
    type(container, 'two');
    editor.commit();
    expect(editor.source).toBe('- two\n- b\n');
    expect(changes.at(-1)?.source).toBe('- two\n- b\n');
    expect(editor.undo()).toBe(true);
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.canUndo).toBe(false);
  });

  it('[TC-2-24-8] keeps notes snapshots on the committed channel', () => {
    const { container, view, editor, drafts, changes } = setup('- a\n- b\n');
    const notes = openNotes(container, view, editor, 'a');
    notes.value = 'note';
    const source = editor.snapshot();
    expect(source).toBe('- a\n  ```markmap-note\n  note\n  ```\n- b\n');
    expect(editor.isEditingNotes).toBe(true);
    expect(editor.canUndo).toBe(true);
    expect(changes).toHaveLength(1);
    expect(drafts).toHaveLength(0);
    expect(editor.snapshot()).toBe(source);
    expect(editor.canUndo).toBe(true);
    expect(editor.undo()).toBe(true);
    expect(editor.source).toBe('- a\n- b\n');
  });

  it('[TC-2-24-9] emits no draft for an unchanged cancelled session', () => {
    const { container, view, editor, drafts, changes } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    key(field(container), 'Escape');
    expect(drafts).toHaveLength(0);
    expect(changes).toHaveLength(0);
    expect(editor.source).toBe('- a\n- b\n');
  });

  it('[TC-2-24-10] does not repeat a committed draft', () => {
    const { container, view, editor, drafts, changes } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'draft');
    expect(drafts.map((change) => change.source)).toEqual(['- draft\n- b\n']);
    editor.commit();
    expect(drafts).toHaveLength(1);
    expect(changes.at(-1)?.source).toBe('- draft\n- b\n');
    expect(editor.source).toBe('- draft\n- b\n');
  });

  it('[TC-2-24-11] ignores repeated identical input', () => {
    const { container, view, editor, drafts } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'draft');
    type(container, 'draft');
    expect(drafts.map((change) => change.source)).toEqual(['- draft\n- b\n']);
  });
});

describe('Session completion', () => {
  it('[TC-2-25-1] publishes the baseline when the edited node loses its rect', () => {
    const { container, view, editor, drafts } = setup('- a\n- b\n');
    const frames = captureFrames();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'draft');
    frames.flush();
    expect(drafts.map((change) => change.source)).toEqual(['- draft\n- b\n']);
    const preview = view.tree?.children.find((child) => treeLabel(child) === 'draft');
    if (!preview) throw new Error('No draft node');
    const saved = drafts[0]?.source;

    view.hidden.add(preview.id);
    view.emit('render');

    expect(drafts.map((change) => change.source)).toEqual(['- draft\n- b\n', '- a\n- b\n']);
    expect(editor.isEditing).toBe(false);
    expect(editor.snapshot()).toBe('- a\n- b\n');
    expect(editor.source).toBe('- a\n- b\n');
    expect(saved).not.toBe(editor.snapshot());
  });

  it('[TC-2-25-2] keeps file switch and destroy silent', () => {
    const switched = setup('- a\n- b\n');
    clickNode(switched.container, switched.view, nodeId(switched.editor, 'a'));
    key(switched.container, ' ');
    type(switched.container, 'draft');
    expect(switched.drafts).toHaveLength(1);
    switched.editor.setSource('- z\n');
    expect(switched.drafts).toHaveLength(1);
    expect(switched.editor.source).toBe('- z\n');

    const destroyed = setup('- a\n- b\n');
    clickNode(destroyed.container, destroyed.view, nodeId(destroyed.editor, 'a'));
    key(destroyed.container, ' ');
    type(destroyed.container, 'draft');
    expect(destroyed.drafts).toHaveLength(1);
    destroyed.editor.destroy();
    expect(destroyed.drafts).toHaveLength(1);
  });

  it('[TC-2-25-3] emits no draft when a draftless session loses its rect', () => {
    const { container, view, editor, drafts, changes } = setup('- a\n');
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    expect(editor.isEditing).toBe(true);
    view.hidden.add(nodeId(editor, 'a'));
    view.emit('render');
    expect(drafts).toHaveLength(0);
    expect(changes).toHaveLength(0);
    expect(editor.isEditing).toBe(false);
    expect(editor.source).toBe('- a\n');
  });
});

describe('Root heading', () => {
  it('[TC-2-23-1] opens a root field with Space and typing', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    clickNode(container, view, editor.document.root);
    key(container, ' ');
    expect(editor.isEditing).toBe(true);
    expect(field(container).value).toBe('');
    expect(editor.source).toBe('- a\n- b\n');
    key(field(container), 'Escape');

    key(container, 'R');
    expect(editor.isEditing).toBe(true);
    expect(field(container).value).toBe('R');
    expect(editor.source).toBe('- a\n- b\n');
    key(field(container), 'Enter');
    expect(editor.source).toBe('# R\n\n- a\n- b\n');
  });

  it('[TC-2-23-2] creates a root heading with Enter in one history entry', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    clickNode(container, view, editor.document.root);
    key(container, 'Enter');
    expect(editor.isEditing).toBe(true);
    expect(field(container).value).toBe('');
    type(container, 'Root');
    key(field(container), 'Enter');
    expect(editor.source).toBe('# Root\n\n- a\n- b\n');

    expect(editor.undo()).toBe(true);
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.canUndo).toBe(false);
    expect(editor.redo()).toBe(true);
    expect(editor.source).toBe('# Root\n\n- a\n- b\n');
  });

  it('[TC-2-23-3] snapshots the draft heading and keeps typing', () => {
    const { container, view, editor, drafts } = setup('- a\n- b\n');
    clickNode(container, view, editor.document.root);
    key(container, 'Enter');
    type(container, 'Roo');
    expect(editor.snapshot()).toBe('# Roo\n\n- a\n- b\n');
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.isEditing).toBe(true);
    expect(document.activeElement).toBe(field(container));
    expect(drafts.at(-1)?.source).toBe('# Roo\n\n- a\n- b\n');

    type(container, 'Root');
    expect(editor.snapshot()).toBe('# Root\n\n- a\n- b\n');
    key(field(container), 'Enter');
    expect(editor.source).toBe('# Root\n\n- a\n- b\n');
    expect(editor.undo()).toBe(true);
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.canUndo).toBe(false);
  });

  it('[TC-2-23-4] cancels a reported root draft and restores the baseline', () => {
    const { container, view, editor, drafts } = setup('- a\n- b\n');
    clickNode(container, view, editor.document.root);
    key(container, 'Enter');
    type(container, 'Root');
    expect(editor.snapshot()).toBe('# Root\n\n- a\n- b\n');
    key(field(container), 'Escape');
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.isEditing).toBe(false);
    expect(editor.canUndo).toBe(false);
    expect(drafts.at(-1)?.source).toBe('- a\n- b\n');
  });

  it('[TC-1-14-7] types into an empty source root at its level', () => {
    const { container, editor } = setup('##\n');
    key(container, 'R');
    expect(editor.isEditing).toBe(true);
    expect(field(container).value).toBe('R');
    expect(editor.source).toBe('##\n');
    editor.commit();
    expect(editor.source).toBe('## R\n');
  });

  it('[TC-2-23-5] shows the frame for a non-empty synthetic root', () => {
    const list = setup('- a\n');
    expect(list.container.querySelector<HTMLElement>('.mm-editor-selection')?.style.display).toBe(
      'block',
    );
    const empty = setup('');
    expect(empty.container.querySelector<HTMLElement>('.mm-editor-selection')?.style.display).toBe(
      'none',
    );
    const heading = setup('##');
    expect(
      heading.container.querySelector<HTMLElement>('.mm-editor-selection')?.style.display,
    ).toBe('block');
    const note = setup('A note.\n');
    expect(note.container.querySelector<HTMLElement>('.mm-editor-selection')?.style.display).toBe(
      'block',
    );
  });

  it('[TC-2-23-6] reports a title or top-level H1 refusal without a source change', () => {
    const title = setup('---\ntitle: T\n---\n\n## A\n\n## B\n');
    key(title.container, ' ');
    expect(title.editor.isEditing).toBe(false);
    expect(title.errors[0]?.message).toContain('one H1');
    key(title.container, 'Enter');
    expect(title.errors).toHaveLength(2);
    expect(title.errors[1]?.message).toContain('one H1');
    expect(title.editor.source).toBe('---\ntitle: T\n---\n\n## A\n\n## B\n');

    const h1 = setup('# A\n# B\n');
    key(h1.container, 'R');
    expect(h1.editor.isEditing).toBe(false);
    expect(h1.errors[0]?.message).toContain('group the document under one H1');
    key(h1.container, 'Enter');
    expect(h1.editor.isEditing).toBe(false);
    expect(h1.errors).toHaveLength(2);
    expect(h1.errors[1]?.message).toContain('group the document under one H1');
    expect(h1.editor.source).toBe('# A\n# B\n');
  });

  it('[TC-2-23-7] keeps the root non-deletable', () => {
    const { container, view, editor, errors } = setup('- a\n- b\n');
    clickNode(container, view, editor.document.root);
    key(container, 'Delete');
    expect(errors).toHaveLength(0);
    expect(editor.source).toBe('- a\n- b\n');

    key(container, 'Enter');
    expect(editor.isEditing).toBe(true);
    key(field(container), 'Backspace');
    expect(editor.isEditing).toBe(true);
    expect(editor.source).toBe('- a\n- b\n');
    expect(errors).toHaveLength(0);
    key(field(container), 'Escape');
  });

  it('[TC-2-23-8] edits a title root with a single body heading in place', () => {
    const { container, editor, errors } = setup('---\ntitle: T\n---\n\n## A\n');
    key(container, ' ');
    expect(editor.isEditing).toBe(true);
    expect(field(container).value).toBe('A');
    type(container, 'B');
    key(field(container), 'Enter');
    expect(errors).toHaveLength(0);
    expect(editor.source).toBe('---\ntitle: T\n---\n\n## B\n');
    expect(editor.selected).toBe(editor.document.root);
    expect(labelText(editor.document, editor.document.nodes.get(editor.document.root)!)).toBe('B');
  });

  it('[TC-2-23-9] creates and cancels a body H1 from a title root with a list', () => {
    const created = setup('---\ntitle: T\n---\n\n- a\n');
    key(created.container, ' ');
    expect(created.editor.isEditing).toBe(true);
    type(created.container, 'Body');
    expect(created.editor.snapshot()).toBe('---\ntitle: T\n---\n\n# Body\n\n- a\n');
    expect(created.editor.source).toBe('---\ntitle: T\n---\n\n- a\n');
    key(field(created.container), 'Enter');
    expect(created.editor.source).toBe('---\ntitle: T\n---\n\n# Body\n\n- a\n');
    expect(
      labelText(
        created.editor.document,
        created.editor.document.nodes.get(created.editor.document.root)!,
      ),
    ).toBe('Body');
    expect(created.editor.undo()).toBe(true);
    expect(created.editor.source).toBe('---\ntitle: T\n---\n\n- a\n');
    expect(created.editor.redo()).toBe(true);
    expect(created.editor.source).toBe('---\ntitle: T\n---\n\n# Body\n\n- a\n');

    const cancelled = setup('---\ntitle: T\n---\n\n- a\n');
    key(cancelled.container, ' ');
    type(cancelled.container, 'Body');
    key(field(cancelled.container), 'Escape');
    expect(cancelled.editor.source).toBe('---\ntitle: T\n---\n\n- a\n');
    expect(cancelled.editor.canUndo).toBe(false);
  });

  it('[TC-2-23-10] refuses a title root with a leading list and one heading child', () => {
    const source = '---\ntitle: T\n---\n\n- a\n\n## B\n';
    const { container, editor, errors } = setup(source);
    key(container, ' ');
    expect(editor.isEditing).toBe(false);
    expect(errors[0]?.message).toContain('one H1');
    key(container, 'Enter');
    expect(errors).toHaveLength(2);
    expect(errors[1]?.message).toContain('one H1');
    expect(editor.source).toBe(source);
    expect(editor.canUndo).toBe(false);
    expect(editor.canRedo).toBe(false);
  });
});

describe('History', () => {
  it('[TC-2-12-1] pushes, undoes and redoes', () => {
    const history = new History();
    const first = { source: 'a', selection: 0, folded: [] };
    const second = { source: 'b', selection: 0, folded: [] };
    history.push(first);
    expect(history.canUndo).toBe(true);
    expect(history.undo(second)).toBe(first);
    expect(history.canRedo).toBe(true);
    expect(history.redo(first)).toBe(second);
    history.clear();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });

  it('[TC-2-12-2] keeps the last hundred entries', () => {
    const history = new History();
    for (let index = 0; index < 101; index += 1) {
      history.push({ source: String(index), selection: 0, folded: [] });
    }
    let count = 0;
    let current: HistoryEntry = { source: 'now', selection: 0, folded: [] };
    while (history.canUndo) {
      const entry = history.undo(current);
      if (entry) {
        current = entry;
        count += 1;
      }
    }
    expect(count).toBe(100);
  });

  it('[TC-2-6-2] resets the field with Cmd+Z before undoing the document', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, ' ');
    type(container, 'ab');

    key(field(container), 'z', { metaKey: true });
    expect(field(container).value).toBe('a');
    expect(editor.isEditing).toBe(true);
    expect(editor.source).toBe('- a\n- b\n');
  });

  it('[TC-2-6-3] undoes and redoes a document change from an unchanged edit field', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Delete');
    clickNode(container, view, nodeId(editor, 'b'));
    key(container, ' ');
    key(field(container), 'z', { metaKey: true });
    expect(editor.isEditing).toBe(false);
    expect(editor.source).toBe('- a\n- b\n');

    clickNode(container, view, nodeId(editor, 'b'));
    key(container, ' ');
    key(field(container), 'z', { metaKey: true, shiftKey: true });
    expect(editor.isEditing).toBe(false);
    expect(editor.source).toBe('- b\n');
  });
});

describe('move', () => {
  it('[TC-2-20-1] keeps a press below four pixels a click', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    setLayout(container);
    stack(view, editor);
    const a = nodeId(editor, 'a');
    view.hit = { kind: 'node', nodeId: a };

    pointer(container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 62, 86);
    pointer(window, 'pointerup', 62, 86);

    expect(view.element.querySelector('.mm-editor-drag-ghost')).toBeNull();
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(editor.selected).toBe(a);
  });

  it('[TC-2-20-2] lifts a subtree after four pixels and drops it as a child', () => {
    const { container, view, editor, changes } = setup('- a\n- b\n');
    setLayout(container);
    stack(view, editor);
    const a = nodeId(editor, 'a');
    view.hit = { kind: 'node', nodeId: a };

    pointer(container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 66, 90);

    expect(view.element.querySelector('.mm-editor-drag-ghost')).not.toBeNull();
    expect(
      view.element
        .querySelector(`[data-key="node:${a}"]`)
        ?.classList.contains('mm-editor-drag-source'),
    ).toBe(true);
    expect(container.classList.contains('mm-editor-dragging')).toBe(true);

    pointer(window, 'pointermove', 60, 145);
    expect(dropElement(container)?.className).toContain('mm-editor-drop-frame');
    expect(dropElement(container)?.style.display).toBe('block');

    pointer(window, 'pointerup', 60, 145);

    expect(editor.source).toBe('- b\n  - a\n');
    expect(editor.selected).toBe(nodeId(editor, 'a'));
    expect(changes).toHaveLength(1);
    expect(view.element.querySelector('.mm-editor-drag-ghost')).toBeNull();
    expect(dropElement(container)?.style.display).toBe('none');
  });

  it('[TC-2-20-3] inserts before a target in its top quarter', () => {
    const { container, view, editor } = setup('- a\n- b\n- c\n');
    setLayout(container);
    stack(view, editor);
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'c') };

    pointer(container, 'pointerdown', 60, 205);
    pointer(window, 'pointermove', 66, 205);
    pointer(window, 'pointermove', 60, 133);
    expect(dropElement(container)?.className).toContain('mm-editor-drop-line');
    pointer(window, 'pointerup', 60, 133);

    expect(editor.source).toBe('- a\n- c\n- b\n');
  });

  it('[TC-2-20-4] cancels a drag with Escape', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    setLayout(container);
    stack(view, editor);
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'a') };

    pointer(container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 66, 90);
    pointer(window, 'pointermove', 60, 145);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(editor.source).toBe('- a\n- b\n');
    expect(container.classList.contains('mm-editor-dragging')).toBe(false);
    expect(dropElement(container)?.style.display).toBe('none');
  });

  it('[TC-2-20-5] ignores a press on an invalid target', () => {
    const { container, view, editor } = setup('- a\n  - b\n- c\n');
    setLayout(container);
    stack(view, editor);
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'a') };

    pointer(container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 66, 90);
    pointer(window, 'pointermove', 60, 145);

    expect(dropElement(container)?.style.display).not.toBe('block');
    pointer(window, 'pointerup', 60, 145);
    expect(editor.source).toBe('- a\n  - b\n- c\n');
  });

  it('[TC-2-20-6] expands a folded target after four hundred milliseconds', () => {
    vi.useFakeTimers();
    const { container, view, editor } = setup('- a\n- b\n  - d\n- c\n');
    setLayout(container);
    stack(view, editor);
    const b = nodeId(editor, 'b');
    view.folded.add(b);
    view.rects.set(nodeId(editor, 'd'), undefined);
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'a') };

    pointer(container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 66, 90);
    pointer(window, 'pointermove', 60, 145);
    expect(view.folded.has(b)).toBe(true);

    vi.advanceTimersByTime(400);
    expect(view.folded.has(b)).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(view.folded.has(b)).toBe(true);
    vi.runOnlyPendingTimers();
  });

  it('[TC-2-20-7] pans the map near the stage edge', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    setLayout(container);
    stack(view, editor);
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'a') };
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

    pointer(container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 790, 85);
    expect(frames).toHaveLength(1);

    const frame = frames[0];
    if (frame) frame(0);
    expect(view.pans).toHaveLength(1);
    expect(view.pans[0]?.[0]).toBeLessThan(0);

    pointer(window, 'pointerup', 790, 85);
    raf.mockRestore();
    caf.mockRestore();
  });

  it('[TC-2-20-8] ignores touch pointers', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    setLayout(container);
    stack(view, editor);
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'a') };

    pointer(container, 'pointerdown', 60, 85, { pointerType: 'touch' });
    pointer(window, 'pointermove', 60, 145, { pointerType: 'touch' });
    pointer(window, 'pointerup', 60, 145, { pointerType: 'touch' });

    expect(view.element.querySelector('.mm-editor-drag-ghost')).toBeNull();
    expect(editor.source).toBe('- a\n- b\n');
  });

  it('[TC-2-21-1] moves among siblings with Cmd/Ctrl+Shift+Up and Down', () => {
    const { container, view, editor } = setup('- a\n- b\n- c\n');
    clickNode(container, view, nodeId(editor, 'b'));

    key(container, 'ArrowUp', { metaKey: true, shiftKey: true });
    expect(editor.source).toBe('- b\n- a\n- c\n');
    key(container, 'ArrowDown', { metaKey: true, shiftKey: true });
    expect(editor.source).toBe('- a\n- b\n- c\n');
  });

  it('[TC-2-21-2] makes a node the last child of its previous sibling', () => {
    const { container, view, editor } = setup('- a\n- b\n- c\n');
    clickNode(container, view, nodeId(editor, 'c'));
    key(container, 'ArrowLeft', { metaKey: true, shiftKey: true });
    expect(editor.source).toBe('- a\n- b\n  - c\n');
  });

  it('[TC-2-21-3] outdents a node after its parent', () => {
    const { container, view, editor } = setup('- a\n  - b\n    - c\n');
    clickNode(container, view, nodeId(editor, 'c'));
    key(container, 'ArrowRight', { metaKey: true, shiftKey: true });
    expect(editor.source).toBe('- a\n  - b\n  - c\n');
  });

  it('[TC-2-21-4] leaves a boundary move unchanged', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'ArrowUp', { metaKey: true, shiftKey: true });
    expect(editor.source).toBe('- a\n- b\n');
    clickNode(container, view, nodeId(editor, 'b'));
    key(container, 'ArrowDown', { metaKey: true, shiftKey: true });
    expect(editor.source).toBe('- a\n- b\n');
  });

  it('[TC-2-21-5] undoes a keyboard move as one history entry', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    clickNode(container, view, nodeId(editor, 'b'));
    key(container, 'ArrowUp', { metaKey: true, shiftKey: true });
    expect(editor.source).toBe('- b\n- a\n');
    key(container, 'z', { metaKey: true });
    expect(editor.source).toBe('- a\n- b\n');
  });

  it('[TC-2-20-9] targets the gap between two branches', () => {
    const { container, view, editor } = setup('- a\n- b\n- c\n');
    setLayout(container);
    stack(view, editor);
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'c') };

    pointer(container, 'pointerdown', 60, 205);
    pointer(window, 'pointermove', 66, 205);
    pointer(window, 'pointermove', 60, 115);
    expect(dropElement(container)?.className).toContain('mm-editor-drop-line');
    pointer(window, 'pointerup', 60, 115);

    expect(editor.source).toBe('- a\n- c\n- b\n');
  });

  it('[TC-2-20-10] draws and drops sideways in an org chart', () => {
    const { container, view, editor } = setup('- a\n- b\n- c\n');
    setLayout(container);
    stack(view, editor);
    view.directions.set(nodeId(editor, 'a'), 'bottom');
    view.directions.set(nodeId(editor, 'b'), 'bottom');
    view.directions.set(nodeId(editor, 'c'), 'bottom');
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'c') };

    pointer(container, 'pointerdown', 60, 205);
    pointer(window, 'pointermove', 66, 205);
    pointer(window, 'pointermove', 13, 145);
    expect(dropElement(container)?.className).toContain('mm-editor-drop-line');
    expect(dropElement(container)?.style.width).toBe('2px');
    pointer(window, 'pointerup', 13, 145);

    expect(editor.source).toBe('- a\n- c\n- b\n');
  });

  it('[TC-2-20-11] falls back to order when a target cannot hold a child', () => {
    const { container, view, editor } = setup('# A\n\n###### B\n\n## C\n');
    setLayout(container);
    stack(view, editor);
    const b = nodeId(editor, 'B');
    const c = nodeId(editor, 'C');
    const rect = view.rects.get(b);
    if (!rect) throw new Error('No rect');
    view.directions.set(b, 'bottom');
    view.directions.set(c, 'bottom');
    view.hit = { kind: 'node', nodeId: c };

    pointer(container, 'pointerdown', rect.x + 2, rect.y + rect.height / 2);
    pointer(window, 'pointermove', rect.x + 8, rect.y + rect.height / 2);
    pointer(window, 'pointermove', rect.x + 2, rect.y + rect.height / 2);
    pointer(window, 'pointerup', rect.x + 2, rect.y + rect.height / 2);

    expect(editor.source).not.toBe('# A\n\n###### B\n\n## C\n');
    expect(editor.source.indexOf('## C')).toBeLessThan(editor.source.indexOf('###### B'));
  });

  it('[TC-2-20-12] drops on the root through a child slot', () => {
    const { container, view, editor } = setup('- a\n- b\n- c\n');
    setLayout(container);
    stack(view, editor);
    view.directions.set(nodeId(editor, 'a'), 'right');
    view.directions.set(nodeId(editor, 'b'), 'right');
    view.directions.set(nodeId(editor, 'c'), 'left');
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'a') };

    pointer(container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 66, 90);
    pointer(window, 'pointermove', 20, 25);
    pointer(window, 'pointerup', 20, 25);

    expect(editor.source).toBe('- b\n- a\n- c\n');
  });

  it('[TC-2-20-13] pans in both axes and stops away from the edge', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    setLayout(container);
    stack(view, editor);
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'a') };
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

    pointer(container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 10, 10);
    const first = frames[0];
    if (first) first(0);
    expect(view.pans[0]?.[0]).toBeGreaterThan(0);
    expect(view.pans[0]?.[1]).toBeGreaterThan(0);
    pointer(window, 'pointermove', 10, 10);

    pointer(window, 'pointermove', 400, 300);
    const second = frames[1];
    if (second) second(0);
    expect(view.pans).toHaveLength(1);

    pointer(window, 'pointermove', 400, 595);
    const third = frames[2];
    if (third) third(0);
    expect(view.pans).toHaveLength(2);
    expect(view.pans[1]?.[1]).toBeLessThan(0);

    pointer(window, 'pointerup', 400, 595);
    const fourth = frames[3];
    if (fourth) fourth(0);
    expect(view.pans).toHaveLength(2);

    raf.mockRestore();
    caf.mockRestore();
  });

  it('[TC-2-20-14] clears a pending expand when the target changes', () => {
    vi.useFakeTimers();
    const { container, view, editor } = setup('- a\n- b\n  - d\n- c\n');
    setLayout(container);
    stack(view, editor);
    const b = nodeId(editor, 'b');
    view.folded.add(b);
    view.rects.set(nodeId(editor, 'd'), undefined);
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'a') };

    pointer(container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 66, 90);
    pointer(window, 'pointermove', 60, 145);
    pointer(window, 'pointermove', 60, 205);
    vi.advanceTimersByTime(400);

    expect(view.folded.has(b)).toBe(true);
    pointer(window, 'pointerup', 60, 205);
    vi.runOnlyPendingTimers();
  });

  it('[TC-2-20-15] cancels a drag when the editor is destroyed', () => {
    vi.useFakeTimers();
    const { container, view, editor } = setup('- a\n- b\n  - d\n- c\n');
    setLayout(container);
    stack(view, editor);
    const b = nodeId(editor, 'b');
    view.folded.add(b);
    view.rects.set(nodeId(editor, 'd'), undefined);
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'a') };

    pointer(container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 66, 90);
    pointer(window, 'pointermove', 60, 145);
    editor.destroy();
    vi.advanceTimersByTime(400);

    expect(view.element.querySelector('.mm-editor-drag-ghost')).toBeNull();
    expect(container.classList.contains('mm-editor-dragging')).toBe(false);
    expect(editor.source).toBe('- a\n- b\n  - d\n- c\n');
    expect(view.folded.has(b)).toBe(true);
    vi.runOnlyPendingTimers();
  });

  it('[TC-2-20-16] treats a drop in the current position as no change', () => {
    const { container, view, editor } = setup('- p\n  - c\n- q\n');
    setLayout(container);
    stack(view, editor);
    const p = nodeId(editor, 'p');
    const c = nodeId(editor, 'c');
    const rect = view.rects.get(p);
    if (!rect) throw new Error('No rect');
    view.hit = { kind: 'node', nodeId: c };

    pointer(container, 'pointerdown', rect.x + 50, rect.y + 15);
    pointer(window, 'pointermove', rect.x + 56, rect.y + 18);
    pointer(window, 'pointermove', rect.x + 50, rect.y + 15);
    pointer(window, 'pointerup', rect.x + 50, rect.y + 15);

    expect(editor.source).toBe('- p\n  - c\n- q\n');
    expect(editor.canUndo).toBe(false);
  });

  it('[TC-2-20-17] reports an impossible move and keeps the document', () => {
    const { container, view, editor, errors } = setup('# A\n\n## B\n\n### C\n\n## D\n\n##### E\n');
    setLayout(container);
    stack(view, editor);
    const e = nodeId(editor, 'E');
    const rect = view.rects.get(e);
    if (!rect) throw new Error('No rect');
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'B') };

    pointer(container, 'pointerdown', rect.x + 50, rect.y + 15);
    pointer(window, 'pointermove', rect.x + 56, rect.y + 18);
    pointer(window, 'pointermove', rect.x + 50, rect.y + 15);
    pointer(window, 'pointerup', rect.x + 50, rect.y + 15);

    expect(errors).toHaveLength(1);
    expect(editor.source).toBe('# A\n\n## B\n\n### C\n\n## D\n\n##### E\n');
  });

  it('[TC-2-20-18] cancels with a pointer cancel and ignores other keys', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    setLayout(container);
    stack(view, editor);
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'a') };

    pointer(container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 66, 90);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(container.classList.contains('mm-editor-dragging')).toBe(true);
    pointer(window, 'pointercancel', 66, 90);

    expect(container.classList.contains('mm-editor-dragging')).toBe(false);
    expect(editor.source).toBe('- a\n- b\n');
  });

  it('[TC-2-20-19] leaves a press inside the open field to the field', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    setLayout(container);
    stack(view, editor);
    const a = nodeId(editor, 'a');
    clickNode(container, view, a);
    key(container, ' ');
    const fieldElement = field(container);
    const rect = view.rects.get(a);
    if (!rect) throw new Error('No rect');

    view.hit = { kind: 'node', nodeId: a };
    pointer(fieldElement, 'pointerdown', rect.x + 50, rect.y + 15);
    pointer(window, 'pointermove', rect.x + 60, rect.y + 25);

    expect(view.element.querySelector('.mm-editor-drag-ghost')).toBeNull();
  });

  it('[TC-2-20-20] inserts after a target in its bottom quarter', () => {
    const { container, view, editor } = setup('- a\n- b\n- c\n');
    setLayout(container);
    stack(view, editor);
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'a') };

    pointer(container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 66, 90);
    pointer(window, 'pointermove', 60, 157);
    pointer(window, 'pointerup', 60, 157);

    expect(editor.source).toBe('- b\n- a\n- c\n');
  });

  it('[TC-2-20-21] inserts after and as a child in an org chart', () => {
    const after = setup('- a\n- b\n- c\n');
    setLayout(after.container);
    stack(after.view, after.editor);
    for (const id of after.editor.document.order) after.view.directions.set(id, 'bottom');
    after.view.hit = { kind: 'node', nodeId: nodeId(after.editor, 'a') };
    pointer(after.container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 66, 90);
    pointer(window, 'pointermove', 107, 145);
    pointer(window, 'pointerup', 107, 145);
    expect(after.editor.source).toBe('- b\n- a\n- c\n');

    const child = setup('- a\n- b\n- c\n');
    setLayout(child.container);
    stack(child.view, child.editor);
    for (const id of child.editor.document.order) child.view.directions.set(id, 'bottom');
    child.view.hit = { kind: 'node', nodeId: nodeId(child.editor, 'a') };
    pointer(child.container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 66, 90);
    pointer(window, 'pointermove', 60, 145);
    pointer(window, 'pointerup', 60, 145);
    expect(child.editor.source).toBe('- b\n  - a\n- c\n');
  });

  it('[TC-2-20-22] leaves a child drop on a full heading unchanged', () => {
    const { container, view, editor } = setup('# A\n\n###### B\n\n## C\n');
    setLayout(container);
    stack(view, editor);
    const b = nodeId(editor, 'B');
    const c = nodeId(editor, 'C');
    const rect = view.rects.get(b);
    if (!rect) throw new Error('No rect');
    view.directions.set(b, 'bottom');
    view.directions.set(c, 'bottom');
    view.hit = { kind: 'node', nodeId: c };

    pointer(container, 'pointerdown', rect.x + 50, rect.y + 15);
    pointer(window, 'pointermove', rect.x + 56, rect.y + 18);
    pointer(window, 'pointermove', rect.x + 50, rect.y + 15);
    pointer(window, 'pointerup', rect.x + 50, rect.y + 15);

    expect(editor.source).toBe('# A\n\n###### B\n\n## C\n');
  });

  it('[TC-2-20-23] ignores a root with no other child or no visible child', () => {
    const single = setup('- a\n');
    setLayout(single.container);
    stack(single.view, single.editor);
    single.view.hit = { kind: 'node', nodeId: nodeId(single.editor, 'a') };
    pointer(single.container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 66, 90);
    pointer(window, 'pointermove', 60, 25);
    pointer(window, 'pointerup', 60, 25);
    expect(single.editor.source).toBe('- a\n');

    const hidden = setup('- a\n- b\n');
    setLayout(hidden.container);
    stack(hidden.view, hidden.editor);
    hidden.view.rects.set(nodeId(hidden.editor, 'b'), undefined);
    hidden.view.hit = { kind: 'node', nodeId: nodeId(hidden.editor, 'a') };
    pointer(hidden.container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 66, 90);
    pointer(window, 'pointermove', 20, 25);
    pointer(window, 'pointerup', 20, 25);
    expect(hidden.editor.source).toBe('- a\n- b\n');
  });

  it('[TC-2-20-24] clears a pending expand when the drag ends early', () => {
    vi.useFakeTimers();
    const { container, view, editor } = setup('- a\n- b\n  - d\n- c\n');
    setLayout(container);
    stack(view, editor);
    const b = nodeId(editor, 'b');
    view.folded.add(b);
    view.rects.set(nodeId(editor, 'd'), undefined);
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'a') };

    pointer(container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 66, 90);
    pointer(window, 'pointermove', 60, 145);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    vi.advanceTimersByTime(400);

    expect(view.folded.has(b)).toBe(true);
    vi.runOnlyPendingTimers();
  });

  it('[TC-2-20-25] ignores a press on the notes panel', () => {
    const { container, view, editor } = setup('# A\n\n## B\n');
    setLayout(container);
    stack(view, editor);
    clickNode(container, view, nodeId(editor, 'B'));
    expect(editor.editNotes()).toBe(true);
    const panel = notesPanel(container);
    if (!panel) throw new Error('No notes panel');
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'B') };

    pointer(panel, 'pointerdown', 20, 20);
    pointer(window, 'pointermove', 30, 30);

    expect(view.element.querySelector('.mm-editor-drag-ghost')).toBeNull();
  });

  it('[TC-2-20-26] retargets after an automatic pan', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    setLayout(container);
    stack(view, editor);
    const b = nodeId(editor, 'b');
    view.rects.set(b, { x: 800, y: 70, width: 100, height: 30 });
    const pan = view.panBy.bind(view);
    view.panBy = (dx, dy) => {
      pan(dx, dy);
      for (const [id, rect] of view.rects) {
        if (rect) view.rects.set(id, { ...rect, x: rect.x + dx, y: rect.y + dy });
      }
    };
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'a') };
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

    pointer(container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 790, 85);
    const frame = frames[0];
    if (frame) frame(0);
    expect(view.pans).toHaveLength(1);
    expect(dropElement(container)?.className).toContain('mm-editor-drop-frame');

    pointer(window, 'pointerup', 790, 85);
    raf.mockRestore();
    caf.mockRestore();
  });

  it('[TC-2-20-27] hides the indicator when a target disappears', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    setLayout(container);
    stack(view, editor);
    const b = nodeId(editor, 'b');
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'a') };

    pointer(container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 66, 90);
    pointer(window, 'pointermove', 60, 145);
    expect(dropElement(container)?.className).toContain('mm-editor-drop-frame');

    view.rects.set(b, undefined);
    view.emit('render');
    expect(dropElement(container)?.style.display).toBe('none');

    pointer(window, 'pointerup', 60, 145);
    expect(editor.source).toBe('- a\n- b\n');
  });

  it('[TC-2-20-28] ignores a secondary pointer button', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    setLayout(container);
    stack(view, editor);
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'a') };

    pointer(container, 'pointerdown', 60, 85, { button: 2 });
    pointer(window, 'pointermove', 66, 90);

    expect(view.element.querySelector('.mm-editor-drag-ghost')).toBeNull();
    expect(editor.source).toBe('- a\n- b\n');
  });

  it('[TC-2-20-29] restores folded branches when undoing a move', () => {
    const { container, view, editor } = setup('- a\n  - b\n    - c\n- d\n');
    setLayout(container);
    stack(view, editor);
    const oldB = nodeId(editor, 'b');
    view.folded.add(oldB);
    view.rects.set(nodeId(editor, 'c'), undefined);
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'a') };

    pointer(container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 66, 90);
    pointer(window, 'pointermove', 60, 265);
    pointer(window, 'pointerup', 60, 265);

    expect(editor.source).toBe('- d\n  - a\n    - b\n      - c\n');
    expect(view.folded.has(oldB)).toBe(false);
    key(container, 'z', { metaKey: true });
    expect(editor.source).toBe('- a\n  - b\n    - c\n- d\n');
    expect(view.folded.has(oldB)).toBe(true);
  });

  it('[TC-2-21-6] ignores move keys on the root', () => {
    const { container, view, editor } = setup('- a\n');
    clickNode(container, view, editor.document.root);
    key(container, 'ArrowUp', { metaKey: true, shiftKey: true });
    expect(editor.source).toBe('- a\n');
  });
});

describe('sibling multi-selection', () => {
  it('[TC-2-28-1] toggles a sibling with Cmd/Ctrl click', () => {
    const { container, view, editor, changes } = setup('- a\n- b\n- c\n');
    clickNode(container, view, nodeId(editor, 'a'));
    clickNode(container, view, nodeId(editor, 'b'), { metaKey: true });
    clickNode(container, view, nodeId(editor, 'a'), { metaKey: true });
    expect(selectedLabels(view, editor)).toEqual(['a', 'b']);
    clickNode(container, view, nodeId(editor, 'b'), { metaKey: true });
    expect(editor.source).toBe('- a\n- b\n- c\n');
    expect(changes).toHaveLength(0);

    key(container, 'Delete');
    expect(editor.source).toBe('- b\n- c\n');
  });

  it('[TC-2-28-2] selects the inclusive sibling range from the anchor with Shift click', () => {
    const { container, view, editor } = setup('- a\n- b\n- c\n- d\n');
    clickNode(container, view, nodeId(editor, 'b'));
    clickNode(container, view, nodeId(editor, 'c'), { shiftKey: true });
    key(container, 'Delete');
    expect(editor.source).toBe('- a\n- d\n');
  });

  it('[TC-2-28-3] clears the group to one node with a plain click', () => {
    const { container, view, editor } = setup('- a\n- b\n- c\n');
    clickNode(container, view, nodeId(editor, 'a'));
    clickNode(container, view, nodeId(editor, 'c'), { metaKey: true });
    clickNode(container, view, nodeId(editor, 'b'));
    clickNode(container, view, nodeId(editor, 'a'), { metaKey: true });
    key(container, 'Delete');
    expect(editor.source).toBe('- c\n');
  });

  it('[TC-2-28-4] starts a new selection on a node under another parent', () => {
    const { container, view, editor } = setup('- a\n  - a1\n- b\n- c\n');
    clickNode(container, view, nodeId(editor, 'a'));
    clickNode(container, view, nodeId(editor, 'c'), { metaKey: true });
    clickNode(container, view, nodeId(editor, 'a1'), { metaKey: true });
    clickNode(container, view, nodeId(editor, 'b'), { ctrlKey: true });
    clickNode(container, view, nodeId(editor, 'c'), { ctrlKey: true });
    key(container, 'Delete');
    expect(editor.source).toBe('- a\n  - a1\n');
  });

  it('[TC-2-28-5] clears the group and keeps the anchor on Escape', () => {
    const { container, view, editor } = setup('- a\n- b\n- c\n');
    clickNode(container, view, nodeId(editor, 'a'));
    clickNode(container, view, nodeId(editor, 'c'), { metaKey: true });
    key(container, 'Escape');
    key(container, 'Delete');
    expect(editor.source).toBe('- b\n- c\n');
  });

  it('[TC-2-28-6] changes no source or history while the selection changes', () => {
    const { container, view, editor, changes } = setup('- a\n- b\n- c\n');
    const anchor = nodeId(editor, 'a');
    clickNode(container, view, anchor);
    clickNode(container, view, nodeId(editor, 'c'), { metaKey: true });
    expect(editor.selected).toBe(anchor);
    clickNode(container, view, 'missing');
    expect(editor.selected).toBe(anchor);
    expect(editor.source).toBe('- a\n- b\n- c\n');
    expect(changes).toHaveLength(0);
    expect(editor.canUndo).toBe(false);
  });

  it('[TC-2-28-7] draws a frame around every selected sibling', () => {
    const { container, view, editor } = setup('- a\n- b\n- c\n');
    view.rects.set(nodeId(editor, 'a'), { x: 10, y: 20, width: 100, height: 30 });
    view.rects.set(nodeId(editor, 'c'), { x: 10, y: 70, width: 100, height: 30 });
    clickNode(container, view, nodeId(editor, 'a'));
    clickNode(container, view, nodeId(editor, 'c'), { metaKey: true });

    const frames = container.querySelectorAll<HTMLElement>('.mm-editor-selection');
    expect(Array.from(frames, (frame) => frame.style.display)).toEqual(['block', 'block']);
    expect(Array.from(frames, (frame) => frame.style.top)).toEqual(['18px', '68px']);

    key(container, 'Escape');
    expect(container.querySelectorAll('.mm-editor-selection')).toHaveLength(1);
  });

  it('[TC-2-29-1] records one history entry for a group delete', () => {
    const { container, view, editor, changes } = setup('- a\n- b\n- c\n- d\n');
    clickNode(container, view, nodeId(editor, 'b'));
    clickNode(container, view, nodeId(editor, 'c'), { metaKey: true });
    key(container, 'Backspace');
    expect(editor.source).toBe('- a\n- d\n');
    expect(changes).toHaveLength(1);
    expect(editor.canUndo).toBe(true);

    key(container, 'z', { metaKey: true });
    expect(editor.source).toBe('- a\n- b\n- c\n- d\n');
  });

  it('[TC-2-29-2] records one history entry for a keyboard group move', () => {
    const { container, view, editor, changes } = setup('- a\n- b\n- c\n- d\n');
    clickNode(container, view, nodeId(editor, 'b'));
    clickNode(container, view, nodeId(editor, 'c'), { metaKey: true });
    key(container, 'ArrowUp', { metaKey: true, shiftKey: true });
    expect(editor.source).toBe('- b\n- c\n- a\n- d\n');
    expect(changes).toHaveLength(1);

    key(container, 'z', { metaKey: true });
    expect(editor.source).toBe('- a\n- b\n- c\n- d\n');
  });

  it('[TC-2-29-3] records one history entry for a pointer group move', () => {
    const { container, view, editor, changes } = setup('- a\n- b\n- c\n');
    setLayout(container);
    stack(view, editor);
    const a = nodeId(editor, 'a');
    clickNode(container, view, a);
    clickNode(container, view, nodeId(editor, 'c'), { metaKey: true });
    view.hit = { kind: 'node', nodeId: a };

    pointer(container, 'pointerdown', 60, 25);
    pointer(window, 'pointermove', 66, 30);
    pointer(window, 'pointermove', 60, 71);
    pointer(window, 'pointerup', 60, 71);

    expect(editor.source).toBe('- a\n- c\n- b\n');
    expect(changes).toHaveLength(1);

    key(container, 'z', { metaKey: true });
    expect(editor.source).toBe('- a\n- b\n- c\n');
  });

  it('[TC-2-29-4] keeps a block action on the anchor node', () => {
    const { container, view, editor } = setup('- a\n  - a1\n- b\n- c\n');
    clickNode(container, view, nodeId(editor, 'a'));
    clickNode(container, view, nodeId(editor, 'c'), { metaKey: true });
    expect(editor.selectedBlock()).toBe('- a\n  - a1');
  });

  it('[TC-2-29-5] keeps the moved group selected in its new order after a keyboard move', () => {
    const { container, view, editor } = setup('- a\n- b\n- c\n- d\n');
    clickNode(container, view, nodeId(editor, 'b'));
    clickNode(container, view, nodeId(editor, 'c'), { metaKey: true });
    expect(selectedLabels(view, editor)).toEqual(['b', 'c']);

    key(container, 'ArrowUp', { metaKey: true, shiftKey: true });
    expect(editor.source).toBe('- b\n- c\n- a\n- d\n');
    expect(selectedLabels(view, editor)).toEqual(['b', 'c']);
    expect(editor.selected).toBe(nodeId(editor, 'b'));

    key(container, 'ArrowDown', { metaKey: true, shiftKey: true });
    expect(editor.source).toBe('- a\n- b\n- c\n- d\n');
    expect(selectedLabels(view, editor)).toEqual(['b', 'c']);
    expect(editor.selected).toBe(nodeId(editor, 'b'));
  });

  it('[TC-2-29-6] restores the group selection with undo and redo', () => {
    const { container, view, editor } = setup('- a\n- b\n- c\n- d\n');
    clickNode(container, view, nodeId(editor, 'b'));
    clickNode(container, view, nodeId(editor, 'c'), { metaKey: true });
    key(container, 'ArrowUp', { metaKey: true, shiftKey: true });
    expect(editor.source).toBe('- b\n- c\n- a\n- d\n');

    key(container, 'z', { metaKey: true });
    expect(editor.source).toBe('- a\n- b\n- c\n- d\n');
    expect(selectedLabels(view, editor)).toEqual(['b', 'c']);
    expect(editor.selected).toBe(nodeId(editor, 'b'));

    key(container, 'z', { metaKey: true, shiftKey: true });
    expect(editor.source).toBe('- b\n- c\n- a\n- d\n');
    expect(selectedLabels(view, editor)).toEqual(['b', 'c']);
    expect(editor.selected).toBe(nodeId(editor, 'b'));
  });

  it('[TC-2-29-7] restores the deleted group selection with undo', () => {
    const { container, view, editor } = setup('- a\n- b\n- c\n- d\n');
    clickNode(container, view, nodeId(editor, 'b'));
    clickNode(container, view, nodeId(editor, 'c'), { metaKey: true });
    key(container, 'Backspace');
    expect(editor.source).toBe('- a\n- d\n');

    key(container, 'z', { metaKey: true });
    expect(editor.source).toBe('- a\n- b\n- c\n- d\n');
    expect(selectedLabels(view, editor)).toEqual(['b', 'c']);
    expect(editor.selected).toBe(nodeId(editor, 'b'));
  });

  it('[TC-2-29-8] keeps a cross-parent group selected after its ids change', () => {
    const { container, view, editor } = setup('- p\n  - x\n- a\n- b\n');
    setLayout(container);
    stack(view, editor);
    clickNode(container, view, nodeId(editor, 'a'));
    clickNode(container, view, nodeId(editor, 'b'), { metaKey: true });
    const a = nodeId(editor, 'a');
    view.hit = { kind: 'node', nodeId: a };

    pointer(container, 'pointerdown', 60, 205);
    pointer(window, 'pointermove', 66, 210);
    pointer(window, 'pointermove', 60, 145);
    pointer(window, 'pointerup', 60, 145);

    expect(editor.source).toBe('- p\n  - x\n    - a\n    - b\n');
    expect(selectedLabels(view, editor)).toEqual(['a', 'b']);
    expect(editor.selected).toBe(nodeId(editor, 'a'));
    expect(editor.selected).not.toBe(a);
  });

  it('[TC-2-29-9] restores the post-delete fallback selection on redo', () => {
    const { container, view, editor } = setup('- a\n- b\n- c\n- d\n');
    clickNode(container, view, nodeId(editor, 'b'));
    clickNode(container, view, nodeId(editor, 'c'), { metaKey: true });
    key(container, 'Backspace');
    expect(editor.source).toBe('- a\n- d\n');
    expect(selectedLabels(view, editor)).toEqual(['a']);

    key(container, 'z', { metaKey: true });
    expect(editor.source).toBe('- a\n- b\n- c\n- d\n');
    expect(selectedLabels(view, editor)).toEqual(['b', 'c']);

    key(container, 'z', { metaKey: true, shiftKey: true });
    expect(editor.source).toBe('- a\n- d\n');
    expect(selectedLabels(view, editor)).toEqual(['a']);
    expect(editor.selected).toBe(nodeId(editor, 'a'));
  });

  it('[TC-2-29-10] leaves a group move at the boundary unchanged', () => {
    const { container, view, editor } = setup('- a\n- b\n- c\n');
    clickNode(container, view, nodeId(editor, 'a'));
    clickNode(container, view, nodeId(editor, 'b'), { metaKey: true });
    key(container, 'ArrowUp', { metaKey: true, shiftKey: true });
    expect(editor.source).toBe('- a\n- b\n- c\n');
    expect(selectedLabels(view, editor)).toEqual(['a', 'b']);
    expect(editor.canUndo).toBe(false);

    clickNode(container, view, nodeId(editor, 'c'), { metaKey: true });
    key(container, 'ArrowDown', { metaKey: true, shiftKey: true });
    expect(editor.source).toBe('- a\n- b\n- c\n');
    expect(selectedLabels(view, editor)).toEqual(['a', 'b', 'c']);
    expect(editor.canUndo).toBe(false);
  });

  it('[TC-2-29-11] reports a failed group move and keeps the document', () => {
    const source = '# A\n\n## B\n\n### C\n\n## D\n\n## F\n\n##### E\n';
    const { container, view, editor, errors } = setup(source);
    setLayout(container);
    stack(view, editor);
    clickNode(container, view, nodeId(editor, 'B'));
    clickNode(container, view, nodeId(editor, 'D'), { metaKey: true });
    view.hit = { kind: 'node', nodeId: nodeId(editor, 'B') };

    pointer(container, 'pointerdown', 60, 85);
    pointer(window, 'pointermove', 66, 90);
    pointer(window, 'pointermove', 60, 325);
    pointer(window, 'pointerup', 60, 325);

    expect(errors).toHaveLength(1);
    expect(editor.source).toBe(source);
    expect(selectedLabels(view, editor)).toEqual(['B', 'D']);
    expect(editor.selected).toBe(nodeId(editor, 'B'));
    expect(editor.canUndo).toBe(false);
  });

  it('[TC-2-32-1] displays connect handle on single selected non-opaque node and hides it otherwise', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    const aId = nodeId(editor, 'a');
    clickNode(container, view, aId);
    const handle = connectHandle(container);
    expect(handle?.style.display).toBe('block');

    const bId = nodeId(editor, 'b');
    clickNode(container, view, bId, { metaKey: true });
    expect(handle?.style.display).toBe('none');

    editor.selectRelation(null);
    expect(handle?.style.display).toBe('none');

    const { container: c2, view: v2, editor: e2 } = setup('- a\n- # Opaque\n');
    const opaqueId = e2.document.order.find((id) => e2.document.nodes.get(id)?.opaque);
    if (!opaqueId) throw new Error('No opaque node');
    clickNode(c2, v2, opaqueId);
    expect(connectHandle(c2)?.style.display).toBe('none');
  });

  it('[TC-2-32-2] dragging from connect handle initiates connect gesture and renders preview curve following pointer', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    stack(view, editor);
    const aId = nodeId(editor, 'a');
    clickNode(container, view, aId);
    const handle = connectHandle(container);
    if (!handle) throw new Error('No handle');
    expect(handle.style.display).toBe('block');

    handle.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
    handle.dispatchEvent(new PointerEvent('pointerdown', { button: 2, bubbles: true }));

    pointer(handle, 'pointerdown', 110, 25);
    pointer(window, 'pointermove', 112, 26);
    const preview = connectPreview(container);
    expect(preview?.style.display).toBe('none');

    pointer(window, 'pointermove', 125, 35);
    expect(preview?.style.display).toBe('block');
    const line = preview?.querySelector('path');
    expect(line?.getAttribute('d')).toContain('C');

    const origScreenRect = view.screenRect.bind(view);
    view.screenRect = () => undefined;
    pointer(window, 'pointermove', 130, 40);
    expect(preview?.style.display).toBe('none');
    view.screenRect = origScreenRect;

    pointer(window, 'pointercancel', 0, 0);

    pointer(handle, 'pointerdown', 110, 25);
    pointer(window, 'pointerup', 110, 25);
    expect(connectPreview(container)?.style.display).toBe('none');
  });

  it('[TC-2-32-3] connect gesture validates candidate target: rejects self-loop, opaque node, and duplicate edge', () => {
    const source =
      '<!-- markmap: graph\nedges:\n  - from: a\n    to: b\n-->\n- a <!-- ^a -->\n- b <!-- ^b -->\n- # Opaque\n- c <!-- ^c -->\n';
    const { container, view, editor } = setup(source);
    stack(view, editor);
    const aId = nodeId(editor, 'a');
    const bId = nodeId(editor, 'b');
    const cId = nodeId(editor, 'c');
    const opaqueId = editor.document.order.find((id) => editor.document.nodes.get(id)?.opaque);
    if (!opaqueId) throw new Error('No opaque node');

    clickNode(container, view, aId);
    const handle = connectHandle(container);
    if (!handle) throw new Error('No handle');
    pointer(handle, 'pointerdown', 110, 25);
    pointer(window, 'pointermove', 125, 35);

    view.hit = { kind: 'node', nodeId: aId };
    pointer(window, 'pointermove', 50, 25);
    expect(
      view.element
        .querySelector(`[data-key="node:${aId}"]`)
        ?.classList.contains('mm-editor-connect-target'),
    ).toBe(false);

    view.hit = { kind: 'node', nodeId: bId };
    pointer(window, 'pointermove', 50, 85);
    expect(
      view.element
        .querySelector(`[data-key="node:${bId}"]`)
        ?.classList.contains('mm-editor-connect-target'),
    ).toBe(false);

    view.hit = { kind: 'node', nodeId: opaqueId };
    pointer(window, 'pointermove', 50, 145);
    expect(
      view.element
        .querySelector(`[data-key="node:${opaqueId}"]`)
        ?.classList.contains('mm-editor-connect-target'),
    ).toBe(false);

    view.hit = { kind: 'node', nodeId: cId };
    pointer(window, 'pointermove', 50, 205);
    expect(
      view.element
        .querySelector(`[data-key="node:${cId}"]`)
        ?.classList.contains('mm-editor-connect-target'),
    ).toBe(true);

    const origDir = view.direction.bind(view);
    view.direction = () => 'left';
    pointer(window, 'pointermove', 50, 205);
    expect(
      view.element
        .querySelector(`[data-key="node:${cId}"]`)
        ?.classList.contains('mm-editor-connect-target'),
    ).toBe(true);
    view.direction = origDir;

    pointer(window, 'pointercancel', 0, 0);

    pointer(handle, 'pointerdown', 110, 25);
    pointer(window, 'pointerup', 110, 25);
    expect(connectPreview(container)?.style.display).toBe('none');
  });

  it('[TC-2-32-4] connect gesture snaps to valid candidate target node on hover', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    stack(view, editor);
    const aId = nodeId(editor, 'a');
    const bId = nodeId(editor, 'b');
    clickNode(container, view, aId);
    const handle = connectHandle(container);
    if (!handle) throw new Error('No handle');

    pointer(handle, 'pointerdown', 110, 25);
    pointer(window, 'pointermove', 130, 40);

    view.hit = undefined;
    pointer(window, 'pointermove', 200, 200);
    expect(view.element.querySelector('.mm-editor-connect-target')).toBeNull();

    view.hit = { kind: 'node', nodeId: bId };
    pointer(window, 'pointermove', 50, 85);
    expect(
      view.element
        .querySelector(`[data-key="node:${bId}"]`)
        ?.classList.contains('mm-editor-connect-target'),
    ).toBe(true);

    view.hit = undefined;
    const origElementFromPoint = document.elementFromPoint.bind(document);
    const bNodeEl = view.element.querySelector(`[data-key="node:${bId}"]`);
    document.elementFromPoint = () => bNodeEl;
    pointer(window, 'pointermove', 50, 85);
    expect(
      view.element
        .querySelector(`[data-key="node:${bId}"]`)
        ?.classList.contains('mm-editor-connect-target'),
    ).toBe(true);
    document.elementFromPoint = origElementFromPoint;

    view.hit = undefined;
    pointer(window, 'pointermove', 300, 300);
    expect(
      view.element
        .querySelector(`[data-key="node:${bId}"]`)
        ?.classList.contains('mm-editor-connect-target'),
    ).toBe(false);

    pointer(window, 'pointercancel', 0, 0);

    pointer(handle, 'pointerdown', 110, 25);
    pointer(window, 'pointerup', 110, 25);
    expect(connectPreview(container)?.style.display).toBe('none');
  });

  it('[TC-2-32-5] releasing connect gesture over valid target node creates relationship edge via createEdge command and selects it', () => {
    const { container, view, editor, changes } = setup('- a\n- b\n');
    stack(view, editor);
    const aId = nodeId(editor, 'a');
    const bId = nodeId(editor, 'b');
    clickNode(container, view, aId);
    const handle = connectHandle(container);
    if (!handle) throw new Error('No handle');

    pointer(handle, 'pointerdown', 110, 25);
    pointer(window, 'pointermove', 130, 40);
    view.hit = { kind: 'node', nodeId: bId };
    pointer(window, 'pointermove', 50, 85);
    pointer(window, 'pointerup', 50, 85);

    expect(editor.document.graph?.edges).toHaveLength(1);
    expect(editor.canUndo).toBe(true);
    expect(changes).toHaveLength(1);
    expect(editor.selectedRelation).not.toBeNull();
    const rf = relationField(container);
    expect(rf?.style.display).toBe('block');
    rf?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(rf?.style.display).toBe('none');
  });

  it('[TC-2-32-6] releasing connect gesture over empty space or pressing Escape cancels the connect gesture', () => {
    const { container, view, editor } = setup('- a\n- b\n');
    stack(view, editor);
    const aId = nodeId(editor, 'a');
    clickNode(container, view, aId);
    const handle = connectHandle(container);
    if (!handle) throw new Error('No handle');

    pointer(handle, 'pointerdown', 110, 25);
    pointer(window, 'pointermove', 130, 40);
    view.hit = undefined;
    pointer(window, 'pointerup', 200, 200);
    expect(editor.document.graph?.edges).toHaveLength(0);
    expect(connectPreview(container)?.style.display).toBe('none');

    pointer(handle, 'pointerdown', 110, 25);
    pointer(window, 'pointermove', 130, 40);
    expect(connectPreview(container)?.style.display).toBe('block');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(connectPreview(container)?.style.display).toBe('none');
    expect(editor.document.graph?.edges).toHaveLength(0);
  });

  it('[TC-2-32-7] clicking a relationship arrow selects it and clicking empty space deselects it', () => {
    const source =
      '<!-- markmap: graph\nedges:\n  - from: a\n    to: b\n-->\n- a <!-- ^a -->\n- b <!-- ^b -->\n';
    const { container, view, editor } = setup(source);
    syncRelationElements(view, editor);
    const relEl = view.element.querySelector('[data-key="relation:a:b"]');
    if (!relEl) throw new Error('No relation element');

    relEl.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(editor.selectedRelation).toEqual({ from: 'a', to: 'b' });
    expect(editor.selected).toBeNull();
    expect(relEl.classList.contains('mm-editor-relation-selected')).toBe(true);

    view.hit = undefined;
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(editor.selectedRelation).toBeNull();
    expect(relEl.classList.contains('mm-editor-relation-selected')).toBe(false);
  });

  it('[TC-2-32-8] pressing Delete or Backspace while relationship arrow is selected deletes the arrow without deleting endpoint nodes', () => {
    const source =
      '<!-- markmap: graph\nedges:\n  - from: a\n    to: b\n-->\n- a <!-- ^a -->\n- b <!-- ^b -->\n';
    const { container, view, editor } = setup(source);
    syncRelationElements(view, editor);
    const relEl = view.element.querySelector('[data-key="relation:a:b"]');
    if (!relEl) throw new Error('No relation element');

    relEl.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(editor.selectedRelation).toEqual({ from: 'a', to: 'b' });

    key(container, 'Delete');
    expect(editor.document.graph?.edges).toHaveLength(0);
    expect(editor.document.nodes.size).toBe(3);
    expect(editor.source).not.toContain('<!-- ^a -->');
    expect(editor.source).not.toContain('<!-- ^b -->');
    expect(editor.source).not.toContain('markmap: graph');
    expect(editor.selectedRelation).toBeNull();
    expect(editor.canUndo).toBe(true);

    const aId = nodeId(editor, 'a');
    const bId = nodeId(editor, 'b');
    editor.createEdge(aId, bId);
    const edge = editor.document.graph?.edges[0];
    if (!edge) {
      throw new Error('No edge');
    }
    editor.setEdgeLabel(edge.from, edge.to, 'direct call');
    expect(editor.document.graph?.edges[0]?.label).toBe('direct call');
    editor.deleteEdge(edge.from, edge.to);
    expect(editor.document.graph?.edges).toHaveLength(0);
  });

  it('[TC-2-32-9] pressing Enter, Space, or double-clicking arrow opens inline label editor overlay and updates label via setEdgeLabel', () => {
    const source =
      '<!-- markmap: graph\nedges:\n  - from: a\n    to: b\n-->\n- a <!-- ^a -->\n- b <!-- ^b -->\n';
    const { container, view, editor } = setup(source);
    syncRelationElements(view, editor);
    const relEl = view.element.querySelector('[data-key="relation:a:b"]');
    if (!relEl) throw new Error('No relation element');

    relEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
    expect(editor.selectedRelation).toEqual({ from: 'a', to: 'b' });
    const rf = relationField(container);
    if (!rf) throw new Error('No relation field');
    expect(rf.style.display).toBe('block');

    rf.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(rf.style.display).toBe('none');
    expect(editor.document.graph?.edges[0]?.label ?? null).toBeNull();

    key(container, 'Enter');
    expect(rf.style.display).toBe('block');
    rf.value = 'depends on';
    rf.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(rf.style.display).toBe('none');
    expect(editor.document.graph?.edges[0]?.label).toBe('depends on');
    expect(editor.source).toContain('depends on');
    expect(editor.canUndo).toBe(true);

    key(container, ' ');
    expect(rf.style.display).toBe('block');
    rf.value = '';
    rf.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(editor.document.graph?.edges[0]?.label ?? null).toBeNull();
    expect(editor.source).not.toContain('label:');

    key(container, 'Enter');
    expect(rf.style.display).toBe('block');
    rf.value = 'blurred';
    rf.dispatchEvent(new FocusEvent('blur'));
    expect(rf.style.display).toBe('none');
    expect(editor.document.graph?.edges[0]?.label).toBe('blurred');

    key(container, 'Enter');
    expect(rf.style.display).toBe('block');
    rf.value = 'blurred';
    rf.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(rf.style.display).toBe('none');

    const firstId = editor.document.order[0];
    if (!firstId) {
      throw new Error('No first node');
    }
    view.hidden.add(firstId);
    editor.startEditingRelationLabel();
    expect(rf.style.display).toBe('block');
    rf.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    view.hidden.delete(firstId);

    editor.setEdgeLabel('a', 'b', 'labeled');
    syncRelationElements(view, editor);
    const updatedRelEl = view.element.querySelector('[data-key="relation:a:b"]');
    const labelGroup = updatedRelEl?.querySelector('.mm-relation-label');
    if (!labelGroup) {
      throw new Error('No label group');
    }
    labelGroup.getBoundingClientRect = () => ({
      x: 100,
      y: 100,
      width: 50,
      height: 20,
      top: 100,
      left: 100,
      right: 150,
      bottom: 120,
      toJSON: () => {},
    });
    editor.startEditingRelationLabel();
    expect(rf.style.display).toBe('block');
    rf.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    labelGroup.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      toJSON: () => {},
    });
    const origScreenRect = view.screenRect.bind(view);
    view.screenRect = () => undefined;
    editor.startEditingRelationLabel();
    expect(rf.style.left).toBe('50%');
    expect(rf.style.top).toBe('50%');
    view.screenRect = origScreenRect;
    rf.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    editor.selectRelation({ from: 'root', to: 'b' });
    editor.startEditingRelationLabel();
    expect(rf.style.display).toBe('block');
    rf.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    editor.selectRelation({ from: 'a', to: 'root' });
    editor.startEditingRelationLabel();
    expect(rf.style.display).toBe('block');
    rf.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    editor.selectRelation(null);
    rf.style.display = 'block';
    rf.dispatchEvent(new FocusEvent('blur'));
    expect(rf.style.display).toBe('none');
  });
});

describe('group boundary selection and editing', () => {
  it('[TC-2-30-1] creates group boundary for selected node and contiguous siblings', () => {
    const { container, view, editor } = setup('- a\n- b\n- c\n');
    view.hit = undefined;
    container.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(editor.createGroup()).toBe(false);
    clickNode(container, view, nodeId(editor, 'b'));
    clickNode(container, view, nodeId(editor, 'c'), { metaKey: true });
    const created = editor.createGroup('My Group');
    expect(created).toBe(true);
    expect(editor.document.graph.groups).toHaveLength(1);
    expect(editor.document.graph.groups[0].label).toBe('My Group');
    expect(editor.selectedBoundary).toBe(0);
  });

  it('[TC-2-30-2] selects group boundary on click and highlights group', () => {
    const source =
      '# Root\n\n- a <!-- ^a -->\n\n<!-- markmap: graph\ngroups:\n  - roots: [a]\n    label: G1\n-->\n';
    const { container, view, editor } = setup(source);
    const groupEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    groupEl.setAttribute('data-group-id', 'group-0');
    view.element.append(groupEl);
    view.hit = { kind: 'group', groupId: 'group-0' };
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 55, clientY: 65 }));
    expect(editor.selectedBoundary).toBe(0);
    expect(editor.selected).toBeNull();
    expect(groupEl.classList.contains('mm-editor-group-selected')).toBe(true);

    editor.selectBoundary(0);
    view.hit = undefined;
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 0, clientY: 0 }));
    expect(editor.selectedBoundary).toBeNull();
    expect(groupEl.classList.contains('mm-editor-group-selected')).toBe(false);

    editor.selectBoundary(null);
    editor.selectBoundary(0);
    editor.selectBoundary(0);
    view.hit = { kind: 'group', groupId: 'group-99' };
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 55, clientY: 65 }));
  });

  it('[TC-2-30-3] deletes group boundary on Delete or Backspace without deleting nodes', () => {
    const source =
      '# Root\n\n- a <!-- ^a -->\n\n<!-- markmap: graph\ngroups:\n  - roots: [a]\n    label: G1\n-->\n';
    const { container, editor } = setup(source);
    expect(editor.deleteGroup()).toBe(false);
    expect(editor.deleteGroup(99)).toBe(false);
    editor.selectBoundary(0);
    expect(editor.selectedBoundary).toBe(0);
    key(container, 'Delete');
    expect(editor.document.graph.groups).toHaveLength(0);
    expect(editor.document.nodes.size).toBe(2);
    expect(editor.selectedBoundary).toBeNull();
  });

  it('[TC-2-30-4] clears group boundary selection on Escape', () => {
    const source =
      '# Root\n\n- a <!-- ^a -->\n\n<!-- markmap: graph\ngroups:\n  - roots: [a]\n    label: G1\n-->\n';
    const { container, view, editor } = setup(source);
    const groupEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    groupEl.setAttribute('data-group-id', 'group-0');
    view.element.append(groupEl);
    editor.selectBoundary(0);
    expect(editor.selectedBoundary).toBe(0);
    expect(groupEl.classList.contains('mm-editor-group-selected')).toBe(true);
    key(container, 'Escape');
    expect(editor.selectedBoundary).toBeNull();
    expect(groupEl.classList.contains('mm-editor-group-selected')).toBe(false);
  });

  it('[TC-2-30-5] edits group label with inline overlay on Enter or double click', () => {
    const source =
      '# Root\n\n- a <!-- ^a -->\n\n<!-- markmap: graph\ngroups:\n  - roots: [a]\n    label: G1\n-->\n';
    const { container, view, editor } = setup(source);
    expect(editor.setGroupLabel(-1, 'X')).toBe(false);
    expect(editor.setGroupLabel(99, 'X')).toBe(false);
    editor.editGroupLabel(-1);
    editor.editGroupLabel(undefined);
    view.hit = { kind: 'group', groupId: 'group-99' };
    container.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, clientX: 55, clientY: 65 }),
    );
    editor.selectBoundary(0);
    key(container, 'Enter');
    expect(editor.isEditing).toBe(true);
    view.emit('render');
    const input = field(container);
    expect(input.value).toBe('G1');
    input.value = 'Updated G1';
    key(input, 'Enter');
    expect(editor.document.graph.groups[0].label).toBe('Updated G1');
    expect(editor.isEditing).toBe(false);

    view.hit = { kind: 'group', groupId: 'group-0' };
    container.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, clientX: 55, clientY: 65 }),
    );
    expect(editor.isEditing).toBe(true);
    expect(input.value).toBe('Updated G1');
  });

  it('[TC-2-30-6] cancels group label editing on Escape', () => {
    const source =
      '# Root\n\n- a <!-- ^a -->\n\n<!-- markmap: graph\ngroups:\n  - roots: [a]\n    label: G1\n-->\n';
    const { container, view, editor } = setup(source);
    editor.selectBoundary(0);
    key(container, 'Enter');
    expect(editor.isEditing).toBe(true);
    view.groupRects.set(0, undefined);
    view.emit('render');
    expect(editor.isEditing).toBe(false);

    view.groupRects.delete(0);
    editor.selectBoundary(0);
    key(container, 'Enter');
    expect(editor.isEditing).toBe(true);
    const input = field(container);
    input.value = 'Cancelled Label';
    key(input, 'Escape');
    expect(editor.isEditing).toBe(false);
    expect(editor.document.graph.groups[0].label).toBe('G1');
  });

  it('[TC-2-30-7] restores group boundary selection and document on undo and redo', () => {
    const source =
      '# Root\n\n- a <!-- ^a -->\n\n<!-- markmap: graph\ngroups:\n  - roots: [a]\n    label: G1\n-->\n';
    const { container, editor } = setup(source);
    editor.selectBoundary(0);
    key(container, 'Backspace');
    expect(editor.document.graph.groups).toHaveLength(0);

    key(container, 'z', { metaKey: true });
    expect(editor.document.graph.groups).toHaveLength(1);
    expect(editor.document.graph.groups[0].label).toBe('G1');
    expect(editor.selectedBoundary).toBe(0);

    key(container, 'z', { metaKey: true, shiftKey: true });
    expect(editor.document.graph.groups).toHaveLength(0);
    expect(editor.selectedBoundary).toBeNull();
  });
});
