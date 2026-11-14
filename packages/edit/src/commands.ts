import type { MarkmapNode } from '@markmap/core';
import {
  labelText,
  lineEnd,
  parseDocument,
  validateDocument,
  type Document,
  type EditNode,
} from '@markmap/model';
import { EditError } from './errors';
import {
  assertSingleLine,
  childIndent,
  childMarker,
  cleanLabel,
  cutRange,
  dedentHeadings,
  dedentList,
  firstLineMarker,
  formatListText,
  headingLine,
  insertLine,
  lineEnding,
  listLine,
  newlineLengthAt,
  placeBlock,
} from './format';
import { applySplices, mapOffset, type Splice } from './splice';

export type Command =
  | { type: 'setLabel'; node: string; text: string }
  | { type: 'insertChild'; node: string; text?: string }
  | { type: 'insertSibling'; node: string; text?: string }
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
    case 'insertChild':
      return planInsert(doc, node, command.text ?? '', 'child');
    case 'insertSibling':
      return planInsert(doc, node, command.text ?? '', 'sibling');
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
