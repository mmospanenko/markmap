// @vitest-environment happy-dom
import type { MarkmapNode, Rect } from '@markmap/core';
import { labelText, type Document } from '@markmap/model';
import type { Markmap } from '@markmap/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkmapEditor, createEditView } from '.';
import { History } from './history';
import type { EditView, HistoryEntry, MarkmapEditorOptions } from './types';

class FakeView implements EditView {
  element = document.createElement('div');
  scale = 1;
  folded = new Set<string>();
  tree?: MarkmapNode;
  hit: { kind: string; nodeId?: string } | undefined;
  focused: string[] = [];
  rects = new Map<string, Rect | undefined>();
  private listeners = new Map<string, Set<() => void>>();

  get foldedIds(): ReadonlySet<string> {
    return this.folded;
  }

  setTree(root: MarkmapNode): void {
    this.tree = root;
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
    if (this.rects.has(id)) return this.rects.get(id);
    return { x: 10, y: 20, width: 100, height: 30 };
  }

  hitAt(): { kind: string; nodeId?: string } | undefined {
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
  const changes: Array<{ source: string; selection: number; document: Document }> = [];
  const errors: Error[] = [];
  const editor = new MarkmapEditor({
    source,
    view,
    container,
    onChange: (change) => changes.push(change),
    onError: (error) => errors.push(error),
    ...options,
  });
  liveEditors.push(editor);
  for (const id of editor.document.order) {
    const node = document.createElement('div');
    node.dataset.key = `node:${id}`;
    view.element.append(node);
  }
  view.emit('render');
  return { container, view, editor, changes, errors };
}

function field(container: HTMLElement): HTMLTextAreaElement {
  const element = container.querySelector('textarea');
  if (!element) throw new Error('No field');
  return element;
}

function key(target: EventTarget, value: string, init: KeyboardEventInit = {}) {
  return target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, ...init }));
}

function clickNode(container: HTMLElement, view: FakeView, id: string) {
  view.hit = { kind: 'node', nodeId: id };
  container.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
}

function nodeId(editor: MarkmapEditor, text: string): string {
  for (const id of editor.document.order) {
    const node = editor.document.nodes.get(id);
    if (node && labelText(editor.document, node) === text) return id;
  }
  throw new Error(`No node ${text}`);
}

function type(container: HTMLElement, value: string) {
  const element = field(container);
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  for (const editor of liveEditors.splice(0)) editor.destroy();
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

  it('[TC-2-2-2] commits the label and inserts the next sibling', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Enter');
    type(container, 'c');
    key(field(container), 'Enter');
    expect(editor.source).toBe('- a\n- c\n- New topic\n- b\n');
    expect(editor.isEditing).toBe(true);
    expect(field(container).value).toBe('New topic');
  });

  it('[TC-2-2-3] inserts a child with Tab', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'Tab');
    type(container, 'child');
    key(field(container), 'Enter');
    expect(editor.source).toBe('- a\n  - child\n  - New topic\n- b\n');
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
    key(container, 'F2');
    type(container, 'changed');
    key(field(container), 'Escape');
    expect(editor.source).toBe('- a\n- b\n');
    expect(editor.isEditing).toBe(false);
    expect(editor.selected).toBe(id);
  });

  it('[TC-2-3-2] rejects a line break in a heading label', () => {
    const { container, view, editor, errors } = setup('# A\n');
    clickNode(container, view, editor.document.root);
    key(container, 'F2');
    key(field(container), 'Enter', { shiftKey: true });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('line break');
  });

  it('[TC-2-3-3] keeps editing when the label is invalid', () => {
    const { container, view, editor, errors } = setup('# A\n');
    clickNode(container, view, editor.document.root);
    key(container, 'F2');
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

  it('[TC-2-5-1] navigates siblings and children', () => {
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
    expect(view.folded.has(a)).toBe(true);
    key(container, 'ArrowLeft');
    expect(editor.selected).toBe(editor.document.root);
  });

  it('[TC-2-5-2] folds and unfolds with arrows', () => {
    const { container, view, editor } = setup('- a\n  - a1\n- b\n');
    const a = nodeId(editor, 'a');
    clickNode(container, view, a);
    key(container, 'ArrowLeft');
    expect(view.folded.has(a)).toBe(true);
    key(container, 'ArrowRight');
    expect(view.folded.has(a)).toBe(false);
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
    expect(editor.source).toBe('- a\n- c\n- New topic\n- b\n');
  });

  it('[TC-2-7-1] places the editor over the node', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'F2');
    const element = field(container);
    expect(element.style.display).toBe('block');
    expect(element.style.left).toBe('10px');
    expect(element.style.top).toBe('20px');
    expect(element.style.width).toBe('120px');
    expect(element.style.transform).toBe('scale(1)');
  });

  it('[TC-2-7-2] scales the field with the map zoom', () => {
    const { container, view, editor } = setup();
    view.scale = 2;
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'F2');
    const element = field(container);
    expect(element.style.width).toBe('60px');
    expect(element.style.height).toBe('15px');
    expect(element.style.transform).toBe('scale(2)');
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
    key(container, 'F2');
    type(container, 'c');
    editor.commit();
    expect(editor.source).toBe('- c\n- b\n');
    expect(editor.isEditing).toBe(false);
  });

  it('[TC-2-9-1] keeps a fold after a rename', () => {
    const { container, view, editor } = setup('- a\n  - a1\n- b\n');
    const a = nodeId(editor, 'a');
    view.folded.add(a);
    clickNode(container, view, a);
    key(container, 'F2');
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
    key(container, 'F2');
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
    key(container, 'F2');
    container.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(editor.isEditing).toBe(true);
    key(field(container), 'Escape');
    view.hit = undefined;
    container.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(editor.isEditing).toBe(false);
  });

  it('[TC-2-13-6] starts typing, ignores Alt and toggles folds', () => {
    const { container, view, editor } = setup();
    const a = nodeId(editor, 'a');
    clickNode(container, view, a);
    key(container, 'x');
    expect(editor.isEditing).toBe(true);
    expect(field(container).value).toBe('ax');
    key(field(container), 'Escape');
    key(container, 'y', { altKey: true });
    expect(editor.isEditing).toBe(false);
    key(container, '/', { metaKey: true });
    expect(view.folded.has(a)).toBe(true);
  });

  it('[TC-2-13-7] stops arrows at boundaries and folds the root', () => {
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
    expect(view.folded.has(editor.document.root)).toBe(true);
  });

  it('[TC-2-13-8] allows Shift+Enter in a list label', () => {
    const { container, view, editor } = setup('- a\n');
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'F2');
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
    key(container, 'F2');
    type(container, 'B');
    key(field(container), 'Tab', { shiftKey: true });
    expect(editor.source).toBe('- a\n- B\n- c\n');
    expect(editor.isEditing).toBe(false);
  });

  it('[TC-2-13-10] inserts after an unchanged field', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'F2');
    key(field(container), 'Enter');
    expect(editor.source).toBe('- a\n- New topic\n- b\n');
    expect(editor.isEditing).toBe(true);
  });

  it('[TC-2-13-11] guards editing without a label, a rect or a new node', () => {
    const { container, view, editor } = setup('- a\n');
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
    key(container, 'F2');
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
    const { container, editor } = setup();
    key(container, 'Escape');
    expect(editor.selected).toBeNull();
    key(container, 'Enter');
    expect(editor.source).toBe('- a\n- b\n');
    key(container, '/', { metaKey: true });
    expect(editor.isEditing).toBe(false);
  });

  it('[TC-2-13-19] ignores a prevented key', () => {
    const { container, editor } = setup();
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    event.preventDefault();
    container.dispatchEvent(event);
    expect(editor.source).toBe('- a\n- b\n');
  });

  it('[TC-2-13-20] replaces the source while editing', () => {
    const { container, view, editor } = setup();
    clickNode(container, view, nodeId(editor, 'a'));
    key(container, 'F2');
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
    key(container, 'F2');
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

describe('createEditView', () => {
  it('[TC-2-11-1] delegates to a Markmap instance', () => {
    const element = document.createElement('div');
    const mm = {
      element,
      foldedIds: new Set<string>(),
      setTree: vi.fn<(root: MarkmapNode) => void>(),
      setFolded: vi.fn<(id: string, folded: boolean) => void>(),
      setFoldedIds: vi.fn<(ids: Iterable<string>, options?: { animate?: boolean }) => void>(),
      toggle: vi.fn<(id: string) => void>(),
      focusNode: vi.fn<(id: string, options?: { animate?: boolean }) => boolean>(),
      screenRect: vi.fn<(id: string) => Rect | undefined>(),
      hitAt: vi.fn<(x: number, y: number) => { kind: string; nodeId?: string } | undefined>(),
      layoutPoint: vi.fn<(clientX: number, clientY: number) => [number, number]>(),
      on: vi.fn<(kind: string, listener: () => void) => () => void>(),
    };
    const view = createEditView(mm as unknown as Markmap);
    expect(view.element).toBe(element);
    expect(view.foldedIds).toBe(mm.foldedIds);
    view.setTree({ id: 'root' } as MarkmapNode);
    view.setFolded('a', true);
    view.setFoldedIds(['a']);
    view.toggle('a');
    view.focusNode('a', { animate: false });
    view.screenRect('a');
    view.hitAt(1, 2);
    view.layoutPoint(1, 2);
    view.on('render', () => {});
    expect(mm.setTree).toHaveBeenCalled();
    expect(mm.setFolded).toHaveBeenCalledWith('a', true);
    expect(mm.setFoldedIds).toHaveBeenCalledWith(['a'], undefined);
    expect(mm.toggle).toHaveBeenCalledWith('a');
    expect(mm.focusNode).toHaveBeenCalledWith('a', { animate: false });
    expect(mm.on).toHaveBeenCalledWith('render', expect.any(Function));
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
});
