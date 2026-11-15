import type { MarkmapNode } from '@markmap/core';
import {
  contentIndent,
  firstLine,
  labelText,
  lineEnd,
  lineStart,
  normalizeNoteText,
  notesText,
  parseDocument,
  validateDocument,
  type Document,
  type EditNode,
  type NoteRange,
  type Range,
} from '@markmap/model';
import { EditError } from './errors';
import {
  assertSingleLine,
  blockInsertion,
  childIndent,
  childMarker,
  cleanLabel,
  cutRange,
  dedentHeadings,
  dedentList,
  firstLineMarker,
  formatListText,
  headingLine,
  headingsToList,
  insertLine,
  lineEnding,
  listLine,
  newlineLengthAt,
  placeBlock,
  reindentList,
  shiftHeadings,
} from './format';
import { applySplices, mapOffset, type Splice } from './splice';

export type Command =
  | { type: 'setLabel'; node: string; text: string }
  | { type: 'setNotes'; node: string; text: string }
  | { type: 'insertFirst'; node: string; text: string }
  | { type: 'insertChild'; node: string; text?: string }
  | { type: 'insertSibling'; node: string; text?: string }
  | { type: 'insertBlock'; node: string; text: string }
  | { type: 'delete'; node: string }
  | { type: 'outdent'; node: string }
  | { type: 'toggleCheck'; node: string };

export interface EditResult {
  document: Document;
  tree: MarkmapNode;
  edits: Splice[];
  selection: number;
}

type SelectionPlan =
  | { kind: 'insert'; edit: number; offset: number }
  | { kind: 'source'; offset: number };

interface Plan {
  edits: Splice[];
  selection: SelectionPlan;
  verify: (next: Document, selection: number) => void;
}

export function applyCommand(doc: Document, command: Command): EditResult {
  const plan = planCommand(doc, command);
  const { text, starts } = applySplices(doc.source, plan.edits);
  const { document: next, tree } = parseDocument(text);
  const issues = validateDocument(next);
  if (issues.length) {
    throw new EditError(
      'E_SHAPE',
      `The edit produced an invalid document: ${issues[0].message}`,
      issues[0].nodeId,
    );
  }
  const selection =
    plan.selection.kind === 'insert'
      ? starts[plan.selection.edit] + plan.selection.offset
      : mapOffset(plan.edits, plan.selection.offset);
  plan.verify(next, selection);
  return { document: next, tree, edits: plan.edits, selection };
}

function planCommand(doc: Document, command: Command): Plan {
  const node = nodeOf(doc, command.node);
  switch (command.type) {
    case 'setLabel':
      return planSetLabel(doc, node, command.text);
    case 'setNotes':
      return planSetNotes(doc, node, command.text);
    case 'insertFirst':
      return planInsertFirst(doc, node, command.text);
    case 'insertChild':
      return planInsert(doc, node, command.text ?? '', 'child');
    case 'insertSibling':
      return planInsert(doc, node, command.text ?? '', 'sibling');
    case 'insertBlock':
      return planInsertBlock(doc, node, command.text);
    case 'delete':
      return planDelete(doc, node);
    case 'outdent':
      return planOutdent(doc, node);
    case 'toggleCheck':
      return planToggleCheck(doc, node);
  }
}

function planSetLabel(doc: Document, node: EditNode, raw: string): Plan {
  requireCapability(node, 'editLabel');
  if (!node.label) throw new EditError('E_LABEL', 'The node has no editable label', node.id);
  const text = cleanLabel(raw);
  let insert: string;
  if (node.kind === 'heading' || node.kind === 'root') {
    assertSingleLine(node, text);
    insert = text;
  } else {
    insert = formatListText(node, text, lineEnding(doc.source));
  }
  const blockStart = node.block?.start;
  return {
    edits: [{ from: node.label.start, to: node.label.end, insert }],
    selection: { kind: 'insert', edit: 0, offset: insert.length },
    verify(next) {
      if (next.nodes.size !== doc.nodes.size) throw shape('The node count changed');
      const found = blockStart == null ? undefined : nodeByBlockStart(next, blockStart);
      if (!found || found.kind !== node.kind || found.parent !== node.parent) {
        throw shape('The edited node changed shape');
      }
      if (!found.label || next.source.slice(found.label.start, found.label.end) !== insert) {
        throw shape('The label did not survive parsing');
      }
    },
  };
}

function planSetNotes(doc: Document, node: EditNode, raw: string): Plan {
  if (!node.capabilities.editNotes) {
    throw new EditError('E_CAPABILITY', 'The node cannot hold notes', node.id);
  }
  const text = normalizeNoteText(raw);
  const offset = noteAnchor(node);
  const notes = [...node.notes].toSorted((a, b) => a.range.start - b.range.start);
  const verify = (next: Document): void => verifyNotes(doc, node, next, text);

  if (!text) {
    const edits = noteCuts(doc.source, notes).map((cut) => ({
      from: cut.start,
      to: cut.end,
      insert: '',
    }));
    return { edits, selection: { kind: 'source', offset }, verify };
  }

  if (notes.length === 1 && notes[0]?.fence && notesText(doc, node) === text) {
    return { edits: [], selection: { kind: 'source', offset }, verify };
  }

  const ending = lineEnding(doc.source);
  const position = notesInsertion(doc, node);
  const fence = fenceText(text, contentIndent(node), ending);
  const atLineStart = position === 0 || doc.source[position - 1] === '\n';
  let insert = atLineStart ? fence : ending + fence;
  if (atLineStart || position < doc.source.length) insert += ending;

  const edits: Splice[] = [{ from: position, to: position, insert }];
  for (const cut of noteCuts(doc.source, notes)) {
    edits.push({ from: cut.start, to: cut.end, insert: '' });
  }
  return { edits, selection: { kind: 'source', offset }, verify };
}

function noteAnchor(node: EditNode): number {
  return node.label?.start ?? node.block?.start ?? 0;
}

function notesInsertion(doc: Document, node: EditNode): number {
  if (node.kind === 'root' && !node.block) {
    const first = node.children.length ? doc.nodes.get(node.children[0]) : undefined;
    return first?.block ? lineStart(doc.source, first.block.start) : doc.source.length;
  }
  const anchor = node.label?.end ?? node.block?.start ?? 0;
  const end = lineEnd(doc.source, anchor);
  if (end >= doc.source.length) return doc.source.length;
  return end + newlineLengthAt(doc.source, end);
}

function noteCuts(source: string, notes: readonly NoteRange[]): Range[] {
  const cuts = notes
    .map((note) => noteCut(source, note.range))
    .toSorted((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const cut of cuts) {
    const last = merged.at(-1);
    if (last && cut.start <= last.end) {
      last.end = Math.max(last.end, cut.end);
    } else {
      merged.push({ ...cut });
    }
  }
  return merged;
}

function noteCut(source: string, range: Range): Range {
  let start = lineStart(source, range.start);
  let end = lineEnd(source, range.end);
  const newline = newlineLengthAt(source, end);
  if (newline) end += newline;
  if (end < source.length) {
    const after = lineEnd(source, end);
    if (!source.slice(end, after).trim()) end = after + newlineLengthAt(source, after);
  } else if (start > 0) {
    const before = lineStart(source, start - 1);
    if (!source.slice(before, start).trim()) start = before;
  }
  return { start, end };
}

function fenceText(text: string, indent: string, ending: string): string {
  const fence = '`'.repeat(fenceLength(text));
  const lines = text.split('\n').map((line) => (line ? indent + line : ''));
  return [indent + fence + 'markmap-note', ...lines, indent + fence].join(ending);
}

function fenceLength(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/gu) ?? []) longest = Math.max(longest, run.length);
  return Math.max(3, longest + 1);
}

function verifyNotes(doc: Document, node: EditNode, next: Document, text: string): void {
  const found = node.block ? nodeByBlockStart(next, node.block.start) : next.nodes.get(next.root);
  const sameChildren =
    found !== undefined &&
    found.children.length === node.children.length &&
    found.children.every((id, index) => id === node.children[index]);
  const notes = found ? found.notes : [];
  const sameNotes = text ? notes.length === 1 && notes[0]?.fence === true : notes.length === 0;
  const sameText = !text || (found !== undefined && notesText(next, found) === text);
  if (!found || next.nodes.size !== doc.nodes.size || !sameChildren || !sameNotes || !sameText) {
    throw shape('The note change did not survive parsing');
  }
}

function planInsertFirst(doc: Document, node: EditNode, raw: string): Plan {
  if (node.kind !== 'root' || node.block || node.children.length > 0) {
    throw new EditError('E_CAPABILITY', 'The node is not an empty root', node.id);
  }
  const text = cleanLabel(raw);
  if (!text) throw new EditError('E_LABEL', 'The label cannot be empty', node.id);
  assertSingleLine(node, text);
  const line = headingLine(1, text);
  const verify = (next: Document, selection: number): void => {
    const created = nodeByLabelStart(next, selection);
    if (
      !created ||
      !created.block ||
      !created.label ||
      (created.kind !== 'root' && created.kind !== 'heading') ||
      created.level !== 1
    ) {
      throw shape('The first node is not an editable heading');
    }
    if (next.source.slice(created.label.start, created.label.end) !== text) {
      throw shape('The first label did not survive parsing');
    }
    if (next.nodes.size !== 1 && next.nodes.size !== 2) {
      throw shape('The first node changed the node count');
    }
  };

  if (doc.source.trim() === '') {
    return {
      edits: [{ from: 0, to: doc.source.length, insert: line }],
      selection: { kind: 'insert', edit: 0, offset: 2 },
      verify,
    };
  }

  const position = doc.source.length;
  const inserted = insertLine(doc.source, position, line, lineEnding(doc.source));
  return {
    edits: [{ from: position, to: position, insert: inserted.insert }],
    selection: { kind: 'insert', edit: 0, offset: inserted.leading + 2 },
    verify,
  };
}

function planInsert(doc: Document, node: EditNode, raw: string, mode: 'child' | 'sibling'): Plan {
  requireCapability(node, mode === 'child' ? 'addChild' : 'addSibling');
  const ending = lineEnding(doc.source);
  const text = cleanLabel(raw);
  let position: number;
  let line: string;
  let markerLength: number;
  let parentId: string;

  if (node.kind === 'root') {
    parentId = node.id;
    if (node.block) {
      position = node.block.end;
      if (node.level >= 1 && node.level < 6) {
        assertSingleLine(node, text);
        line = headingLine(node.level + 1, text);
        markerLength = node.level + 2;
      } else {
        line = listLine('', '-', text, ending);
        markerLength = 2;
      }
    } else {
      position = doc.source.length;
      const last = node.children.length
        ? doc.nodes.get(node.children[node.children.length - 1])
        : undefined;
      if (last?.kind === 'heading' && last.level >= 1) {
        assertSingleLine(node, text);
        line = headingLine(last.level, text);
        markerLength = last.level + 1;
      } else {
        const indent = last?.kind === 'listItem' ? (last.list?.indent ?? '') : '';
        const marker = last?.kind === 'listItem' ? (last.list?.marker ?? '-') : '-';
        line = listLine(indent, marker, text, ending);
        markerLength = indent.length + marker.length + 1;
      }
    }
  } else if (node.kind === 'heading') {
    if (!node.block) throw shape('The heading has no block');
    position = node.block.end;
    const level = mode === 'sibling' ? node.level : node.level + 1;
    if (level > 6) throw new EditError('E_LEVEL', 'Heading level cannot exceed six', node.id);
    assertSingleLine(node, text);
    line = headingLine(level, text);
    markerLength = level + 1;
    parentId = mode === 'sibling' ? (node.parent ?? node.id) : node.id;
  } else {
    if (!node.block || !node.list) throw shape('The list item has no block');
    position = node.block.end;
    const indent = mode === 'sibling' ? node.list.indent : childIndent(doc, node);
    const marker = mode === 'sibling' ? node.list.marker : childMarker(doc, node);
    line = listLine(indent, marker, text, ending);
    markerLength = indent.length + marker.length + 1;
    parentId = mode === 'sibling' ? (node.parent ?? node.id) : node.id;
  }

  const inserted = insertLine(doc.source, position, line, ending);
  const expectedLabel = line.slice(markerLength);
  return {
    edits: [{ from: position, to: position, insert: inserted.insert }],
    selection: { kind: 'insert', edit: 0, offset: inserted.leading + markerLength },
    verify(next, selection) {
      if (next.nodes.size !== doc.nodes.size + 1) throw shape('The node count did not grow');
      const created = nodeByLabelStart(next, selection);
      if (!created || created.parent !== parentId)
        throw shape('The new node landed in the wrong place');
      if (
        !created.label ||
        next.source.slice(created.label.start, created.label.end) !== expectedLabel
      ) {
        throw shape('The new label did not survive parsing');
      }
    },
  };
}

function normalizeBlockText(raw: string, ending: string): string {
  const trimmed = raw
    .replace(/\r\n?/g, '\n')
    .replace(/^(?:[ \t]*\n)+/u, '')
    .replace(/(?:\n[ \t]*)+$/u, '');
  return ending === '\n' ? trimmed : trimmed.replace(/\n/g, ending);
}

function planInsertBlock(doc: Document, node: EditNode, raw: string): Plan {
  requireCapability(node, 'addChild');
  const ending = lineEnding(doc.source);
  const block = normalizeBlockText(raw, ending);
  if (!block.trim()) throw new EditError('E_LABEL', 'The pasted text is empty', node.id);
  const fragment = parseDocument(block).document;
  const fragmentRoot = fragment.nodes.get(fragment.root);
  if (!fragmentRoot) throw shape('The pasted text has no root');
  const top = fragmentRoot.block
    ? fragmentRoot
    : fragmentRoot.children
        .map((id) => fragment.nodes.get(id))
        .find((child): child is EditNode => Boolean(child?.block));
  if (!top || !top.label) {
    throw new EditError('E_SHAPE', 'The pasted text has no editable node', node.id);
  }
  const count = fragment.nodes.size - (fragmentRoot.block ? 0 : 1);
  let moved: string;
  if (top.kind === 'heading' || top.kind === 'root') {
    if (node.kind === 'listItem') {
      moved = headingsToList(block, childIndent(doc, node), doc.unit, ending);
    } else {
      const parentLevel = node.kind === 'root' ? (node.block ? node.level : 0) : node.level;
      moved = shiftHeadings(block, parentLevel + 1 - top.level, ending);
    }
  } else if (top.kind === 'listItem') {
    if (!top.list) throw shape('The pasted list item has no list info');
    const indent = node.kind === 'listItem' ? childIndent(doc, node) : '';
    moved = reindentList(block, indent.length - top.list.indent.length, ending);
  } else {
    throw new EditError('E_SHAPE', 'The pasted text has no editable node', node.id);
  }
  const position = node.block ? node.block.end : doc.source.length;
  const placed = blockInsertion(doc.source, position, moved, ending);
  const expected = firstLine(fragment.source, top.label.start).replace(/\r$/u, '');
  const emptyRoot = node.kind === 'root' && !node.block && node.children.length === 0;
  return {
    edits: [{ from: position, to: position, insert: placed.insert }],
    selection: { kind: 'insert', edit: 0, offset: placed.leading + firstLineMarker(moved) },
    verify(next, selection) {
      const created = nodeByLabelStart(next, selection);
      if (!created) throw shape('The pasted root did not survive parsing');
      if (created.parent !== node.id && !(emptyRoot && created.id === next.root)) {
        throw shape('The pasted subtree landed in the wrong place');
      }
      if (countSubtree(next, created) !== count) throw shape('The pasted subtree changed shape');
      if (
        !created.label ||
        firstLine(next.source, created.label.start).replace(/\r$/u, '') !== expected
      ) {
        throw shape('The pasted label did not survive parsing');
      }
    },
  };
}

function planDelete(doc: Document, node: EditNode): Plan {
  requireCapability(node, 'delete');
  if (!node.block || !node.parent) throw shape('The node cannot be removed');
  const cut = cutRange(doc.source, node.block);
  const parent = nodeOf(doc, node.parent);
  const index = parent.children.indexOf(node.id);
  const previous = index > 0 ? doc.nodes.get(parent.children[index - 1]) : undefined;
  const target = previous?.label?.start ?? parent.label?.start ?? parent.block?.start ?? 0;
  const removed = countSubtree(doc, node);
  return {
    edits: [{ from: cut.start, to: cut.end, insert: '' }],
    selection: { kind: 'source', offset: target },
    verify(next) {
      if (next.nodes.size !== doc.nodes.size - removed)
        throw shape('The node count did not shrink');
      if (next.nodes.has(node.id)) throw shape('The removed node is still present');
    },
  };
}

function planOutdent(doc: Document, node: EditNode): Plan {
  requireCapability(node, 'outdent');
  if (!node.block || !node.parent) throw shape('The node cannot be outdented');
  const parent = nodeOf(doc, node.parent);
  const grand = parent.parent ? doc.nodes.get(parent.parent) : undefined;
  if (!grand) throw new EditError('E_CAPABILITY', 'The node has no grandparent', node.id);
  const ending = lineEnding(doc.source);
  const cut = cutRange(doc.source, node.block);
  const blockText = doc.source.slice(node.block.start, node.block.end);
  let moved: string;
  if (node.kind === 'listItem' && parent.kind === 'listItem') {
    if (!node.list || !parent.list) throw shape('The list item has no list info');
    moved = dedentList(blockText, node.list.indent, parent.list.indent, ending);
  } else if (node.kind === 'heading' && parent.kind === 'heading') {
    moved = dedentHeadings(doc, node, node.level - parent.level, ending);
  } else {
    throw new EditError('E_CAPABILITY', 'The node cannot be outdented', node.id);
  }
  const markerLength = firstLineMarker(moved);
  let target = parent.block ? parent.block.end : 0;
  const newline = newlineLengthAt(doc.source, target);
  if (newline) target += newline;
  if (target > cut.start && target < cut.end)
    throw shape('The move target is inside the source block');
  const before = target === cut.end ? cut.start - 1 : target - 1;
  const atLineStart = before < 0 || doc.source[before] === '\n';
  const following =
    target < doc.source.length || (target === doc.source.length && doc.source.endsWith(ending));
  const placed = placeBlock(moved, ending, atLineStart, following);
  return {
    edits: [
      { from: cut.start, to: cut.end, insert: '' },
      { from: target, to: target, insert: placed.insert },
    ],
    selection: { kind: 'insert', edit: 1, offset: placed.leading + markerLength },
    verify(next, selection) {
      if (next.nodes.size !== doc.nodes.size) throw shape('The node count changed');
      const found = nodeByLabelStart(next, selection);
      if (!found || found.parent !== grand.id)
        throw shape('The outdented node has the wrong parent');
      if (
        !found.label ||
        labelText(doc, node) !== next.source.slice(found.label.start, found.label.end)
      ) {
        throw shape('The outdented label changed');
      }
    },
  };
}

function planToggleCheck(doc: Document, node: EditNode): Plan {
  requireCapability(node, 'toggleCheck');
  if (!node.block || !node.label) throw shape('The task has no block');
  const line = doc.source.slice(node.block.start, lineEnd(doc.source, node.block.start));
  const match = /^([ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+)(\[[ xX]\])/.exec(line);
  if (!match) throw shape('The task checkbox is missing');
  const from = node.block.start + match[1].length;
  const insert = match[2] === '[ ]' ? '[x]' : '[ ]';
  return {
    edits: [{ from, to: from + 3, insert }],
    selection: { kind: 'source', offset: node.label.start },
    verify(next, selection) {
      if (next.nodes.size !== doc.nodes.size) throw shape('The node count changed');
      const found = nodeByLabelStart(next, selection);
      if (!found || found.block?.start !== node.block?.start) throw shape('The task changed shape');
    },
  };
}

function nodeOf(doc: Document, id: string): EditNode {
  const node = doc.nodes.get(id);
  if (!node) throw new EditError('E_NODE', `No node with id ${id}`, id);
  return node;
}

function requireCapability(node: EditNode, key: keyof EditNode['capabilities']): void {
  if (!node.capabilities[key]) {
    throw new EditError('E_CAPABILITY', `The node does not support ${key}`, node.id);
  }
}

function nodeByLabelStart(doc: Document, offset: number): EditNode | undefined {
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (node?.label?.start === offset) return node;
  }
  return undefined;
}

function nodeByBlockStart(doc: Document, offset: number): EditNode | undefined {
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (node?.block?.start === offset) return node;
  }
  return undefined;
}

function countSubtree(doc: Document, node: EditNode): number {
  let count = 1;
  for (const id of node.children) {
    const child = doc.nodes.get(id);
    if (child) count += countSubtree(doc, child);
  }
  return count;
}

function shape(message: string): EditError {
  return new EditError('E_SHAPE', message);
}
