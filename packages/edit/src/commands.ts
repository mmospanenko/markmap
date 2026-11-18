import type { MarkmapNode } from '@markmap/core';
import {
  contentIndent,
  contentNodeCount,
  firstLine,
  labelText,
  lineEnd,
  lineStart,
  mintIdentity,
  newConventionIssues,
  normalizeNoteText,
  noteText,
  notesText,
  parseDocument,
  serializeGraphBlock,
  validateDocument,
  type Document,
  type EditNode,
  type GraphData,
  type GraphGroup,
  type GraphEdge,
  type NoteRange,
  type RandomSource,
  type Range,
} from '@markmap/model';
import { EditError } from './errors';
import {
  appendGraphSplice,
  graphBlockSplices,
  markerRemovalSplices,
  mergeGraphSplice,
  readPastedGraph,
  removeGraphNodes,
  subtreeIds,
  type GraphRemoval,
} from './graph';
import { planSetLayout } from './layout';
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
  listToHeadings,
  newlineLengthAt,
  placeBlock,
  reindentList,
  shiftHeadings,
} from './format';
import { applySplices, mapOffset, type Splice } from './splice';

export type Command =
  | { type: 'setLabel'; node: string; text: string }
  | { type: 'setNotes'; node: string; text: string }
  | { type: 'createRootHeading'; node: string; text: string }
  | { type: 'insertChild'; node: string; text?: string }
  | { type: 'insertSibling'; node: string; text?: string }
  | { type: 'insertBlock'; node: string; text: string; random?: RandomSource }
  | { type: 'delete'; node: string }
  | { type: 'deleteNodes'; nodes: string[] }
  | { type: 'outdent'; node: string }
  | { type: 'move'; node: string; parent: string; index: number }
  | { type: 'moveNodes'; nodes: string[]; parent: string; index: number }
  | { type: 'toggleCheck'; node: string }
  | { type: 'createGroup'; nodes: string[]; label?: string; random?: RandomSource }
  | { type: 'deleteGroup'; groupIndex: number }
  | { type: 'setGroupLabel'; groupIndex: number; text: string }
  | { type: 'createEdge'; from: string; to: string; label?: string | null; random?: RandomSource }
  | { type: 'deleteEdge'; from: string; to: string }
  | { type: 'setEdgeLabel'; from: string; to: string; label: string | null }
  | { type: 'setLayout'; layout: string; node?: string | null };

export interface EditResult {
  document: Document;
  tree: MarkmapNode;
  edits: Splice[];
  selection: number;
}

type SelectionPlan =
  | { kind: 'insert'; edit: number; offset: number }
  | { kind: 'source'; offset: number };

export interface Plan {
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

export function planCommand(doc: Document, command: Command): Plan {
  if (command.type === 'deleteNodes') return planDeleteNodes(doc, command.nodes);
  if (command.type === 'moveNodes') {
    return planMoveNodes(doc, command.nodes, command.parent, command.index);
  }
  if (command.type === 'createGroup') {
    return planCreateGroup(doc, command.nodes, command.label, command.random);
  }
  if (command.type === 'deleteGroup') {
    return planDeleteGroup(doc, command.groupIndex);
  }
  if (command.type === 'setGroupLabel') {
    return planSetGroupLabel(doc, command.groupIndex, command.text);
  }
  if (command.type === 'createEdge') {
    return planCreateEdge(doc, command.from, command.to, command.label ?? null, command.random);
  }
  if (command.type === 'deleteEdge') {
    return planDeleteEdge(doc, command.from, command.to);
  }
  if (command.type === 'setEdgeLabel') {
    return planSetEdgeLabel(doc, command.from, command.to, command.label);
  }
  if (command.type === 'setLayout') {
    return planSetLayout(doc, command.layout, command.node);
  }
  const node = nodeOf(doc, command.node);
  switch (command.type) {
    case 'setLabel':
      return planSetLabel(doc, node, command.text);
    case 'setNotes':
      return planSetNotes(doc, node, command.text);
    case 'createRootHeading':
      return planCreateRootHeading(doc, node, command.text);
    case 'insertChild':
      return planInsert(doc, node, command.text ?? '', 'child');
    case 'insertSibling':
      return planInsert(doc, node, command.text ?? '', 'sibling');
    case 'insertBlock':
      return planInsertBlock(doc, node, command.text, command.random);
    case 'delete':
      return planDelete(doc, node);
    case 'outdent':
      return planOutdent(doc, node);
    case 'move':
      return planMove(doc, node, command.parent, command.index);
    case 'toggleCheck':
      return planToggleCheck(doc, node);
  }
}

function planSetLabel(doc: Document, node: EditNode, raw: string): Plan {
  requireCapability(node, 'editLabel');
  if (!node.label) throw new EditError('E_LABEL', 'The node has no editable label', node.id);
  const text = cleanLabel(raw);
  let insert: string;
  let expected: string;
  if (node.kind === 'heading' || node.kind === 'root') {
    assertSingleLine(node, text);
    insert = headingLabelInsertion(doc, node, text);
    expected = text;
  } else {
    insert = formatListText(node, text, lineEnding(doc.source));
    expected = insert;
  }
  const blockStart = node.block?.start;
  return {
    edits: [{ from: node.label.start, to: node.label.end, insert }],
    selection: { kind: 'insert', edit: 0, offset: insert.length },
    verify(next) {
      if (contentNodeCount(next) !== contentNodeCount(doc)) throw shape('The node count changed');
      const found = blockStart == null ? undefined : nodeByBlockStart(next, blockStart);
      if (!found || found.kind !== node.kind || found.parent !== node.parent) {
        throw shape('The edited node changed shape');
      }
      if (!found.label || next.source.slice(found.label.start, found.label.end) !== expected) {
        throw shape('The label did not survive parsing');
      }
    },
  };
}

function headingLabelInsertion(doc: Document, node: EditNode, text: string): string {
  if (!node.label || node.label.start !== node.label.end) return text;
  const before = doc.source[node.label.start - 1];
  const after = doc.source[node.label.start];
  return before === '#' && after !== ' ' && after !== '\t' ? ` ${text}` : text;
}

function planSetNotes(doc: Document, node: EditNode, raw: string): Plan {
  if (!node.capabilities.editNotes) {
    throw new EditError('E_CAPABILITY', 'The node cannot hold notes', node.id);
  }
  const text = normalizeNoteText(raw);
  const offset = noteAnchor(node);
  const notes = [...node.notes].toSorted((a, b) => a.range.start - b.range.start);
  let edits: Splice[];

  if (!text) {
    edits = noteCuts(doc.source, notes).map((cut) => ({
      from: cut.start,
      to: cut.end,
      insert: '',
    }));
  } else if (notes.length === 1 && notes[0]?.fence && notesText(doc, node) === text) {
    edits = [];
  } else {
    const ending = lineEnding(doc.source);
    const position = notesInsertion(doc, node);
    const fence = fenceText(text, contentIndent(node), ending);
    const atLineStart = position === 0 || doc.source[position - 1] === '\n';
    let insert = atLineStart ? fence : ending + fence;
    if (atLineStart || position < doc.source.length) insert += ending;

    edits = [{ from: position, to: position, insert }];
    for (const cut of noteCuts(doc.source, notes)) {
      edits.push({ from: cut.start, to: cut.end, insert: '' });
    }
  }
  const verify = (next: Document): void => verifyNotes(doc, node, next, text, edits);
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

function verifyNotes(
  doc: Document,
  node: EditNode,
  next: Document,
  text: string,
  edits: Splice[],
): void {
  const found = node.block
    ? nodeByBlockStart(next, mapOffset(edits, node.block.start))
    : next.nodes.get(next.root);
  const sameChildren =
    found !== undefined &&
    found.children.length === node.children.length &&
    found.children.every((id, index) => id === node.children[index]);
  const notes = found ? found.notes : [];
  const sameNotes = text ? notes.length === 1 && notes[0]?.fence === true : notes.length === 0;
  const sameText = !text || (found !== undefined && notesText(next, found) === text);
  if (
    !found ||
    contentNodeCount(next) !== contentNodeCount(doc) ||
    !sameChildren ||
    !sameNotes ||
    !sameText
  ) {
    throw shape('The note change did not survive parsing');
  }
}

export function rootHeadingRefusal(doc: Document, nodeId?: string): EditError | null {
  const policy = doc.rootPolicy;
  if (policy.kind === 'source-heading') {
    return new EditError('E_ROOT_EXISTS', 'The document already has a root heading', nodeId);
  }
  if (policy.kind === 'title' && !policy.canCreateHeading) {
    return new EditError(
      'E_ROOT_TITLE',
      'Merge the body under one H1 to give the map a body root',
      nodeId,
    );
  }
  if (!policy.canCreateHeading) {
    return new EditError(
      'E_ROOT_H1',
      'Add a frontmatter title or group the document under one H1',
      nodeId,
    );
  }
  return null;
}

function bodyContentStart(doc: Document): number {
  const source = doc.source;
  let offset = doc.rootPolicy.bodyStart;
  while (offset < source.length) {
    const end = lineEnd(source, offset);
    if (source.slice(offset, end).trim()) return offset;
    offset = end + newlineLengthAt(source, end);
  }
  return source.length;
}

function planCreateRootHeading(doc: Document, node: EditNode, raw: string): Plan {
  if (node.kind !== 'root') {
    throw new EditError('E_CAPABILITY', 'Only the root can create a root heading', node.id);
  }
  const refusal = rootHeadingRefusal(doc, node.id);
  if (refusal) throw refusal;
  const text = cleanLabel(raw);
  if (!text) throw new EditError('E_LABEL', 'The label cannot be empty', node.id);
  assertSingleLine(node, text);
  const line = headingLine(1, text);
  const ending = lineEnding(doc.source);
  const position = bodyContentStart(doc);
  let edits: Splice[];
  let selectionOffset: number;

  if (position === doc.source.length) {
    const inserted = insertLine(doc.source, position, line, ending);
    edits = [{ from: position, to: position, insert: inserted.insert }];
    selectionOffset = inserted.leading + 2;
  } else {
    edits = [{ from: position, to: position, insert: line + ending + ending }];
    selectionOffset = 2;
  }

  const verify = (next: Document, selection: number): void => {
    if (contentNodeCount(next) !== contentNodeCount(doc) + 1) {
      throw shape('The root heading changed the content node count');
    }
    const created = nodeByLabelStart(next, selection);
    if (
      !created ||
      created.id !== next.root ||
      created.kind !== 'root' ||
      created.level !== 1 ||
      !created.block ||
      !created.label ||
      next.source.slice(created.label.start, created.label.end) !== text
    ) {
      throw shape('The first node is not an editable root heading');
    }
    const expected: string[] = [created.id];
    for (const id of doc.order) {
      if (id === doc.root) continue;
      const old = doc.nodes.get(id);
      if (!old?.block) throw shape('The original node has no block');
      const found = nodeByBlockStart(next, mapOffset(edits, old.block.start));
      if (!found) throw shape('The original node did not survive the root heading');
      expected.push(found.id);
      if (old.parent === doc.root) {
        if (found.parent !== created.id) {
          throw shape('The original node is not a child of the new root');
        }
      } else {
        const oldParent = old.parent ? doc.nodes.get(old.parent) : undefined;
        const newParent = found.parent ? next.nodes.get(found.parent) : undefined;
        if (
          !oldParent?.block ||
          !newParent?.block ||
          newParent.block.start !== mapOffset(edits, oldParent.block.start)
        ) {
          throw shape('The original parent edge changed');
        }
      }
    }
    if (expected.join('\u0000') !== next.order.join('\u0000')) {
      throw shape('The original node order changed');
    }
  };

  return { edits, selection: { kind: 'insert', edit: 0, offset: selectionOffset }, verify };
}

function headingContentInsertion(doc: Document, node: EditNode): number {
  for (const id of node.children) {
    const child = doc.nodes.get(id);
    if (child?.kind === 'heading' && child.block) return child.block.start;
  }
  return node.block?.end ?? doc.source.length;
}

function headingListLine(
  doc: Document,
  node: EditNode,
  text: string,
  ending: string,
): { line: string; markerLength: number } {
  const indent = childListIndent(doc, node);
  const marker = childMarker(doc, node);
  return {
    line: listLine(indent, marker, text, ending),
    markerLength: indent.length + marker.length + 1,
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
  let expectedKind: 'heading' | 'listItem' = 'listItem';
  let expectedLevel = 0;

  if (node.kind === 'root') {
    parentId = node.id;
    if (node.block) {
      if (node.level === 1) {
        position = node.block.end;
        expectedKind = 'heading';
        expectedLevel = 2;
        assertSingleLine(node, text);
        line = headingLine(expectedLevel, text);
        markerLength = expectedLevel + 1;
      } else {
        position = headingContentInsertion(doc, node);
        const list = headingListLine(doc, node, text, ending);
        line = list.line;
        markerLength = list.markerLength;
      }
    } else {
      const last = node.children.length
        ? doc.nodes.get(node.children[node.children.length - 1])
        : undefined;
      if (last?.kind === 'heading' && (last.level === 1 || last.level === 2)) {
        position = doc.source.length;
        expectedKind = 'heading';
        expectedLevel = last.level;
        assertSingleLine(node, text);
        line = headingLine(expectedLevel, text);
        markerLength = expectedLevel + 1;
      } else if (last?.kind === 'heading') {
        position = headingContentInsertion(doc, node);
        const list = headingListLine(doc, node, text, ending);
        line = list.line;
        markerLength = list.markerLength;
      } else {
        position = doc.source.length;
        const indent = last?.kind === 'listItem' ? (last.list?.indent ?? '') : '';
        const marker = last?.kind === 'listItem' ? (last.list?.marker ?? '-') : '-';
        line = listLine(indent, marker, text, ending);
        markerLength = indent.length + marker.length + 1;
      }
    }
  } else if (node.kind === 'heading') {
    if (!node.block) throw shape('The heading has no block');
    const level = mode === 'sibling' ? node.level : node.level + 1;
    if (level <= 2) {
      position = node.block.end;
      expectedKind = 'heading';
      expectedLevel = level;
      assertSingleLine(node, text);
      line = headingLine(level, text);
      markerLength = level + 1;
      parentId = mode === 'sibling' ? (node.parent ?? node.id) : node.id;
    } else {
      const parent =
        mode === 'sibling' ? (node.parent ? doc.nodes.get(node.parent) : undefined) : node;
      if (!parent || (parent.kind !== 'heading' && parent.kind !== 'root')) {
        throw shape('The list fallback has no heading parent');
      }
      position = headingContentInsertion(doc, parent);
      const list = headingListLine(doc, parent, text, ending);
      line = list.line;
      markerLength = list.markerLength;
      parentId = parent.id;
    }
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
      if (contentNodeCount(next) !== contentNodeCount(doc) + 1)
        throw shape('The node count did not grow');
      const created = nodeByLabelStart(next, selection);
      if (!created || created.kind !== expectedKind || created.parent !== parentId)
        throw shape('The new node landed in the wrong place');
      if (expectedKind === 'heading' && created.level !== expectedLevel)
        throw shape('The new heading has the wrong level');
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

function contentRootNode(doc: Document): EditNode | undefined {
  const root = doc.nodes.get(doc.root);
  if (!root) return undefined;
  if (root.block) return root;
  return root.children
    .map((id) => doc.nodes.get(id))
    .find((child): child is EditNode => Boolean(child?.block));
}

function removeRanges(text: string, ranges: readonly Range[]): string {
  let result = '';
  let last = 0;
  for (const range of ranges.toSorted((a, b) => a.start - b.start)) {
    result += text.slice(last, range.start);
    last = range.end;
  }
  return result + text.slice(last);
}

function attachLeadingNotes(
  moved: string,
  notes: readonly string[],
  indent: string | null,
  ending: string,
): string {
  if (!notes.length) return moved;
  const firstBreak = moved.indexOf(ending);
  const head = firstBreak === -1 ? moved : moved.slice(0, firstBreak);
  let rest = firstBreak === -1 ? '' : moved.slice(firstBreak + ending.length);
  while (rest.startsWith(ending)) rest = rest.slice(ending.length);
  const joined = notes.join(ending + ending);
  const text = indent === null ? joined : reindentList(joined, indent.length, ending);
  return `${head}${ending}${ending}${text}${rest ? ending + ending + rest : ''}`;
}

function planInsertBlock(
  doc: Document,
  node: EditNode,
  raw: string,
  random: RandomSource | undefined,
): Plan {
  requireCapability(node, 'addChild');
  const ending = lineEnding(doc.source);
  const normalized = normalizeBlockText(raw, ending);
  const graphRead = readPastedGraph(doc, normalized, ending, random ?? Math.random);
  const block = normalizeBlockText(graphRead.body, ending);
  if (!block.trim()) throw new EditError('E_LABEL', 'The pasted text is empty', node.id);
  const fragment = parseDocument(block).document;
  const fragmentRoot = fragment.nodes.get(fragment.root);
  if (!fragmentRoot) throw shape('The pasted text has no root');
  const top = fragmentRoot.block
    ? fragmentRoot
    : fragmentRoot.children
        .map((id) => fragment.nodes.get(id))
        .find((child): child is EditNode => Boolean(child?.block));
  if (
    !top ||
    !top.label ||
    (top.kind !== 'heading' && top.kind !== 'root' && top.kind !== 'listItem')
  ) {
    throw new EditError('E_SHAPE', 'The pasted text has no editable node', node.id);
  }
  const count = contentNodeCount(fragment);
  const blockStart = top.block?.start ?? 0;
  const prefixNotes = top.notes
    .filter((note) => note.range.end <= blockStart)
    .toSorted((a, b) => a.range.start - b.range.start);
  if (top.kind === 'heading' || top.kind === 'root') {
    const rest = removeRanges(
      block.slice(0, blockStart),
      prefixNotes.map((note) => note.range),
    );
    if (rest.trim()) {
      throw new EditError(
        'E_SHAPE',
        'The pasted prefix has content that cannot become a note',
        node.id,
      );
    }
  }
  const leading = prefixNotes.map((note) => block.slice(note.range.start, note.range.end));
  const body = top.kind === 'heading' || top.kind === 'root' ? block.slice(blockStart) : block;
  const prefixTexts = prefixNotes.map((note) => normalizeNoteText(noteText(fragment, top, note)));
  const prefixFences = prefixNotes.map((note) => note.fence);
  let converted: string;
  let moved: string;
  if (top.kind === 'heading' || top.kind === 'root') {
    if (node.kind === 'listItem') {
      const indent = childIndent(doc, node);
      converted = headingsToList(body, indent, doc.unit, ending);
      moved = attachLeadingNotes(converted, leading, indent + '  ', ending);
    } else {
      const parentLevel = node.kind === 'root' ? (node.block ? node.level : 0) : node.level;
      converted = shiftHeadings(body, parentLevel + 1 - top.level, ending);
      moved = attachLeadingNotes(converted, leading, null, ending);
    }
  } else {
    if (!top.list) throw shape('The pasted list item has no list info');
    const indent = node.kind === 'listItem' ? childIndent(doc, node) : '';
    converted = reindentList(body, indent.length - top.list.indent.length, ending);
    moved = converted;
  }
  const convertedDoc = parseDocument(converted).document;
  const convertedRoot = contentRootNode(convertedDoc);
  const bodyNotes = convertedRoot?.notes ?? [];
  const bodyTexts = convertedRoot
    ? bodyNotes.map((note) => normalizeNoteText(noteText(convertedDoc, convertedRoot, note)))
    : [];
  const bodyFences = bodyNotes.map((note) => note.fence);
  const movedDoc = parseDocument(moved).document;
  const movedRoot = contentRootNode(movedDoc);
  const movedNotes = movedRoot?.notes ?? [];
  const expectedTexts = [...prefixTexts, ...bodyTexts];
  const expectedFences = [...prefixFences, ...bodyFences];
  if (movedNotes.length !== expectedTexts.length) {
    throw shape('The moved root notes changed');
  }
  const position = node.block ? node.block.end : doc.source.length;
  const placed = blockInsertion(doc.source, position, moved, ending);
  const marker = firstLineMarker(moved);
  const expected = firstLine(fragment.source, top.label.start).replace(/\r$/u, '');
  const emptyRoot = node.kind === 'root' && !node.block && node.children.length === 0;
  const edits: Splice[] = [{ from: position, to: position, insert: placed.insert }];
  if (graphRead.edges.length > 0 || graphRead.groups.length > 0) {
    edits.push(mergeGraphSplice(doc.source, doc, graphRead.edges, graphRead.groups, ending));
  }
  return {
    edits,
    selection: { kind: 'insert', edit: 0, offset: placed.leading + marker },
    verify(next, selection) {
      const created = nodeByLabelStart(next, selection);
      if (!created) throw shape('The pasted root did not survive parsing');
      if (created.parent !== node.id && !(emptyRoot && created.id === next.root)) {
        throw shape('The pasted subtree landed in the wrong place');
      }
      if (countSubtree(next, created) !== count) throw shape('The pasted subtree changed shape');
      if (contentNodeCount(next) !== contentNodeCount(doc) + count) {
        throw shape('The pasted content changed the node count');
      }
      const insertedStart = selection - marker;
      if (next.source.slice(insertedStart, insertedStart + moved.length) !== moved) {
        throw shape('The pasted block changed');
      }
      const target = next.nodes.get(node.id);
      if (target && target.id !== created.id) {
        const sameNotes =
          target.notes.length === node.notes.length &&
          target.notes.every((note, index) => {
            const before = node.notes[index];
            return (
              before !== undefined &&
              note.range.start === before.range.start &&
              note.range.end === before.range.end &&
              note.fence === before.fence
            );
          });
        if (!sameNotes) throw shape('The pasted notes attached to the target');
      }
      const promoted = emptyRoot && created.id === next.root;
      const targetNotes = promoted ? node.notes : [];
      const expectedAllTexts = [
        ...targetNotes.map((note) => normalizeNoteText(noteText(doc, node, note))),
        ...expectedTexts,
      ];
      const expectedAllFences = [...targetNotes.map((note) => note.fence), ...expectedFences];
      const expectedRanges = [
        ...targetNotes.map((note) => note.range),
        ...movedNotes.map((note) => ({
          start: insertedStart + note.range.start,
          end: insertedStart + note.range.end,
        })),
      ];
      if (created.notes.length !== expectedAllTexts.length) {
        throw shape('The pasted root lost or gained notes');
      }
      for (let index = 0; index < created.notes.length; index += 1) {
        const note = created.notes[index];
        const range = expectedRanges[index];
        if (!note || !range || note.fence !== expectedAllFences[index]) {
          throw shape('The pasted note fences changed');
        }
        if (note.range.start !== range.start || note.range.end !== range.end) {
          throw shape('The pasted note ranges changed');
        }
        if (normalizeNoteText(noteText(next, created, note)) !== expectedAllTexts[index]) {
          throw shape('The pasted note text changed');
        }
        if (
          index >= targetNotes.length &&
          (note.range.start < insertedStart || note.range.end > insertedStart + moved.length)
        ) {
          throw shape('The pasted note is outside the inserted block');
        }
      }
      if (
        !created.label ||
        firstLine(next.source, created.label.start).replace(/\r$/u, '') !== expected
      ) {
        throw shape('The pasted label did not survive parsing');
      }
      const fresh = newConventionIssues(doc, next);
      if ((graphRead.edges.length > 0 || graphRead.groups.length > 0) && fresh.length > 0) {
        throw shape(`The paste produced invalid graph metadata: ${fresh[0]?.message ?? ''}`);
      }
    },
  };
}

interface SiblingSelection {
  nodes: EditNode[];
  parent: EditNode;
}

function selectedSiblings(
  doc: Document,
  ids: readonly string[],
  emptyMessage: string,
): SiblingSelection {
  if (!ids.length) throw new EditError('E_SHAPE', emptyMessage);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new EditError('E_SHAPE', 'The node set repeats a node', id);
    seen.add(id);
  }
  const nodes = ids.map((id) => nodeOf(doc, id));
  const parentId = nodes[0].parent;
  if (parentId === null) {
    throw new EditError('E_CAPABILITY', 'The root cannot be selected', doc.root);
  }
  if (nodes.some((node) => node.parent !== parentId)) {
    if (nodes.some((node) => node.parent === null)) {
      throw new EditError('E_CAPABILITY', 'The root cannot be selected', doc.root);
    }
    throw new EditError('E_SHAPE', 'The selected nodes have different parents', nodes[0].id);
  }
  return { nodes, parent: nodeOf(doc, parentId) };
}

function requireDeletable(node: EditNode): void {
  if (node.opaque) {
    throw new EditError('E_CAPABILITY', 'The node cannot be deleted in a batch', node.id);
  }
}

function requireMovable(node: EditNode): void {
  if (node.opaque) {
    throw new EditError('E_CAPABILITY', 'The node cannot be moved in a batch', node.id);
  }
}

function mergeCuts(cuts: readonly Range[]): Range[] {
  const merged: Range[] = [];
  for (const cut of cuts.toSorted((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && cut.start <= last.end) {
      last.end = Math.max(last.end, cut.end);
    } else {
      merged.push({ start: cut.start, end: cut.end });
    }
  }
  return merged;
}

function deleteSelectionOffset(
  doc: Document,
  selection: SiblingSelection,
  firstIndex: number,
  lastIndex: number,
): number {
  const parent = selection.parent;
  const previousId = firstIndex > 0 ? parent.children[firstIndex - 1] : undefined;
  const previous = previousId ? doc.nodes.get(previousId) : undefined;
  const previousLabel = previous?.label;
  if (previousLabel) return previousLabel.start;
  if (parent.label) return parent.label.start;
  const nextId = parent.children[lastIndex + 1];
  const next = nextId ? doc.nodes.get(nextId) : undefined;
  const nextLabel = next?.label;
  if (nextLabel) return nextLabel.start;
  return doc.source.length;
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
  const removal = removeGraphNodes(doc, subtreeIds(doc, node.id));
  const edits: Splice[] = [{ from: cut.start, to: cut.end, insert: '' }];
  edits.push(...graphBlockSplices(doc.source, doc, removal, cut));
  edits.push(...markerRemovalSplices(doc.source, removal));
  return {
    edits,
    selection: { kind: 'source', offset: target },
    verify(next) {
      if (contentNodeCount(next) !== contentNodeCount(doc) - removed)
        throw shape('The node count did not shrink');
      if (next.nodes.has(node.id)) throw shape('The removed node is still present');
      const fresh = newConventionIssues(doc, next);
      if (removal.changed && fresh.length > 0) {
        throw shape(`The delete produced invalid graph metadata: ${fresh[0]?.message ?? ''}`);
      }
    },
  };
}

function planDeleteNodes(doc: Document, ids: readonly string[]): Plan {
  const selection = selectedSiblings(doc, ids, 'The delete set is empty');
  for (const node of selection.nodes) requireDeletable(node);
  const indices = selection.nodes
    .map((node) => selection.parent.children.indexOf(node.id))
    .toSorted((left, right) => left - right);
  const target = deleteSelectionOffset(doc, selection, indices[0], indices[indices.length - 1]);
  const blocks = selection.nodes
    .map((node) => node.block)
    .filter((block): block is Range => Boolean(block));
  const cuts = mergeCuts(blocks.map((block) => cutRange(doc.source, block)));
  const removed = selection.nodes.reduce((total, node) => total + countSubtree(doc, node), 0);
  return {
    edits: cuts.map((cut) => ({ from: cut.start, to: cut.end, insert: '' })),
    selection: { kind: 'source', offset: target },
    verify(next) {
      const vanished = selection.nodes.every((node) => !next.nodes.has(node.id));
      if (contentNodeCount(next) !== contentNodeCount(doc) - removed || !vanished) {
        throw shape('The batch delete did not survive parsing');
      }
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
      if (contentNodeCount(next) !== contentNodeCount(doc)) throw shape('The node count changed');
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

function childHeadingLevel(parent: EditNode): number {
  if (parent.kind === 'root') return parent.block ? parent.level + 1 : 1;
  return parent.level + 1;
}

function childListIndent(doc: Document, parent: EditNode): string {
  for (const id of parent.children) {
    const child = doc.nodes.get(id);
    if (child?.kind === 'listItem' && child.list) return child.list.indent;
  }
  if (parent.kind !== 'listItem' || !parent.list) return '';
  const unit = doc.unit;
  const indent = parent.list.indent;
  if (unit === '\t' || unit.length >= parent.list.marker.length + 1) return indent + unit;
  return indent + ' '.repeat(parent.list.marker.length + 1);
}

function reindentListTo(
  text: string,
  fromIndent: string,
  toIndent: string,
  ending: string,
): string {
  if (fromIndent === toIndent) return text;
  return text
    .split(ending)
    .map((line) => {
      if (!line.trim()) return line;
      if (!line.startsWith(fromIndent)) return line;
      return toIndent + line.slice(fromIndent.length);
    })
    .join(ending);
}

function trimBlockEdges(block: string, ending: string): string {
  const lines = block.split(ending);
  while (!lines[0]?.trim()) lines.shift();
  while (!lines[lines.length - 1]?.trim()) lines.pop();
  return lines.join(ending);
}

function cutForMove(source: string, node: EditNode, block: Range): Range {
  const cut = cutRange(source, block);
  if (node.kind !== 'listItem') return cut;
  if (cut.end >= source.length) {
    const start = lineStart(source, cut.start);
    if (start === 0) return cut;
    const previous = lineStart(source, start - 1);
    if (!source.slice(previous, start).trim()) return { start: previous, end: cut.end };
    return cut;
  }
  const end = lineEnd(source, cut.end);
  if (source.slice(cut.end, end).trim()) return cut;
  return { start: cut.start, end: end + newlineLengthAt(source, end) };
}

function hasBlankBefore(source: string, position: number): boolean {
  return /(?:\r?\n)[ \t]*(?:\r?\n)$/u.test(source.slice(0, position));
}

function nextTextStartsWithHeading(source: string, position: number): boolean {
  const rest = source.slice(position).replace(/^(?:[ \t]*(?:\r\n|\n))*/u, '');
  return /^#{1,6}(?:[ \t]|$)/u.test(rest);
}

function isInSubtree(doc: Document, ancestorId: string, id: string): boolean {
  let cursor = doc.nodes.get(id);
  while (cursor) {
    if (cursor.id === ancestorId) return true;
    cursor = cursor.parent ? doc.nodes.get(cursor.parent) : undefined;
  }
  return false;
}

function planMove(doc: Document, node: EditNode, parentId: string, index: number): Plan {
  requireCapability(node, 'move');
  if (node.opaque || node.kind === 'opaque' || !node.block) {
    throw new EditError('E_CAPABILITY', 'The node cannot be moved', node.id);
  }
  const parent = nodeOf(doc, parentId);
  if (parent.opaque || parent.kind === 'opaque' || !parent.capabilities.addChild) {
    throw new EditError('E_CAPABILITY', 'The target cannot hold a child', parent.id);
  }
  if (isInSubtree(doc, node.id, parent.id)) {
    throw new EditError('E_CYCLE', 'A node cannot move under its own subtree', node.id);
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new EditError('E_SHAPE', 'The move index is invalid', node.id);
  }
  const siblings = parent.children.filter((id) => id !== node.id);
  if (index > siblings.length) {
    throw new EditError('E_SHAPE', 'The move index is outside the target', node.id);
  }
  if (node.parent === parent.id && parent.children.indexOf(node.id) === index) {
    return {
      edits: [],
      selection: { kind: 'source', offset: node.label?.start ?? node.block.start },
      verify() {},
    };
  }
  const list = node.list;
  if (node.kind === 'listItem' && !list) throw shape('The list item has no list info');
  const previous = index > 0 ? doc.nodes.get(siblings[index - 1]) : undefined;
  const next = index < siblings.length ? doc.nodes.get(siblings[index]) : undefined;
  const ending = lineEnding(doc.source);
  const block = doc.source.slice(node.block.start, node.block.end);
  let moved: string;
  if (node.kind === 'heading') {
    if (parent.kind === 'listItem') {
      moved = headingsToList(block, childIndent(doc, parent), doc.unit, ending);
    } else {
      moved = shiftHeadings(block, childHeadingLevel(parent) - node.level, ending);
    }
  } else if (node.kind === 'listItem' && list) {
    if (parent.kind === 'listItem') {
      moved = reindentListTo(block, list.indent, childListIndent(doc, parent), ending);
    } else if (previous?.kind === 'heading') {
      if (labelText(doc, node).includes('\n')) {
        throw new EditError('E_LABEL', 'A heading label cannot contain a line break', node.id);
      }
      moved = listToHeadings(block, childHeadingLevel(parent), ending);
    } else {
      moved = reindentListTo(block, list.indent, childListIndent(doc, parent), ending);
    }
  } else {
    throw new EditError('E_CAPABILITY', 'The node cannot be moved', node.id);
  }
  let position: number;
  if (next?.block) {
    position = next.block.start;
  } else if (previous?.block) {
    position = previous.block.end + newlineLengthAt(doc.source, previous.block.end);
  } else if (parent.block) {
    position = parent.block.end + newlineLengthAt(doc.source, parent.block.end);
  } else {
    position = doc.source.length;
  }
  const cut = cutForMove(doc.source, node, node.block);
  let gapEnd = position;
  while (gapEnd < doc.source.length) {
    const end = lineEnd(doc.source, gapEnd);
    if (doc.source.slice(gapEnd, end).trim()) break;
    gapEnd = end + newlineLengthAt(doc.source, end);
  }
  if (position < cut.end && gapEnd > cut.start) gapEnd = cut.start;
  const gap = gapEnd - position;
  let text = trimBlockEdges(moved, ending);
  const startsHeading = /^#{1,6}(?:[ \t]|$)/u.test(text);
  const blankBefore = gap === 0 && hasBlankBefore(doc.source, position);
  let leading = 0;
  if (startsHeading && parent.kind !== 'listItem' && !blankBefore) {
    text = ending + text;
    leading = ending.length;
  }
  const afterCut = gapEnd >= cut.start && gapEnd <= cut.end ? cut.end : gapEnd;
  if (afterCut < doc.source.length && nextTextStartsWithHeading(doc.source, afterCut)) {
    text += ending + ending;
  }
  const before = position === cut.end ? cut.start - 1 : position - 1;
  const atLineStart = before < 0 || doc.source[before] === '\n';
  const following =
    gapEnd < doc.source.length || (gapEnd === doc.source.length && doc.source.endsWith(ending));
  const placed = placeBlock(text, ending, atLineStart, following);
  const edits: Splice[] = [
    { from: cut.start, to: cut.end, insert: '' },
    gap > 0
      ? { from: position, to: gapEnd, insert: placed.insert }
      : { from: position, to: position, insert: placed.insert },
  ];
  return {
    edits,
    selection: {
      kind: 'insert',
      edit: 1,
      offset: placed.leading + leading + firstLineMarker(moved),
    },
    verify(nextDoc, selection) {
      if (contentNodeCount(nextDoc) !== contentNodeCount(doc)) {
        throw shape('The move changed the node count');
      }
      const target = parent.block
        ? nodeByBlockStart(nextDoc, mapOffset(edits, parent.block.start))
        : nextDoc.nodes.get(nextDoc.root);
      if (!target) throw shape('The target parent is missing');
      const found = nodeByLabelStart(nextDoc, selection);
      if (!found || found.parent !== target.id) throw shape('The moved node has the wrong parent');
      if (target.children.indexOf(found.id) !== index) {
        throw shape('The moved node has the wrong order');
      }
      if (
        !found.label ||
        labelText(doc, node) !== nextDoc.source.slice(found.label.start, found.label.end)
      ) {
        throw shape('The moved label changed');
      }
    },
  };
}

interface MovedBlock {
  text: string;
  heading: boolean;
}

interface MoveItem {
  node: EditNode;
  block: Range;
}

function moveNodeBlock(
  doc: Document,
  node: EditNode,
  range: Range,
  parent: EditNode,
  afterHeading: boolean,
  ending: string,
): MovedBlock {
  const block = doc.source.slice(range.start, range.end);
  if (node.kind === 'heading') {
    const text =
      parent.kind === 'listItem'
        ? headingsToList(block, childIndent(doc, parent), doc.unit, ending)
        : shiftHeadings(block, childHeadingLevel(parent) - node.level, ending);
    return { text: trimBlockEdges(text, ending), heading: parent.kind !== 'listItem' };
  }
  const indent = node.list?.indent ?? /^[ \t]*/u.exec(block)?.[0] ?? '';
  if (parent.kind === 'listItem') {
    const text = reindentListTo(block, indent, childListIndent(doc, parent), ending);
    return { text: trimBlockEdges(text, ending), heading: false };
  }
  if (afterHeading) {
    if (labelText(doc, node).includes('\n')) {
      throw new EditError('E_LABEL', 'A heading label cannot contain a line break', node.id);
    }
    const text = listToHeadings(block, childHeadingLevel(parent), ending);
    return { text: trimBlockEdges(text, ending), heading: true };
  }
  const text = reindentListTo(block, indent, childListIndent(doc, parent), ending);
  return { text: trimBlockEdges(text, ending), heading: false };
}

function joinMovedBlocks(blocks: readonly MovedBlock[], ending: string): string {
  let text = blocks[0].text;
  for (let index = 1; index < blocks.length; index += 1) {
    const block = blocks[index];
    const before = blocks[index - 1];
    text += before.heading || block.heading ? ending + ending : ending;
    text += block.text;
  }
  return text;
}

function comparableLabel(doc: Document, node: EditNode): string {
  return labelText(doc, node)
    .split(/\r?\n/u)
    .map((line) => line.trimStart())
    .join('\n');
}

function planMoveNodes(
  doc: Document,
  ids: readonly string[],
  parentId: string,
  index: number,
): Plan {
  const selection = selectedSiblings(doc, ids, 'The move set is empty');
  const parent = nodeOf(doc, parentId);
  if (parent.opaque) {
    throw new EditError('E_CAPABILITY', 'The target cannot hold a child', parent.id);
  }
  for (const node of selection.nodes) {
    requireMovable(node);
    if (isInSubtree(doc, node.id, parent.id)) {
      throw new EditError('E_CYCLE', 'A node cannot move under its own subtree', node.id);
    }
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new EditError('E_SHAPE', 'The move index is invalid', parent.id);
  }
  const selected = new Set(selection.nodes.map((node) => node.id));
  const siblings = parent.children.filter((id) => !selected.has(id));
  if (index > siblings.length) {
    throw new EditError('E_SHAPE', 'The move index is outside the target', parent.id);
  }
  const sourceParent = selection.parent;
  const orderedIds = sourceParent.children.filter((id) => selected.has(id));
  const items: MoveItem[] = orderedIds
    .map((id) => nodeOf(doc, id))
    .map((node) => ({ node, block: node.block }))
    .filter((item): item is MoveItem => Boolean(item.block));
  const first = items[0];
  const firstBlock = doc.source.slice(first.block.start, first.block.end);
  const labelOffset = first.block.start + firstLineMarker(firstBlock);
  const destinationPrevious = index > 0 ? doc.nodes.get(siblings[index - 1]) : undefined;
  const destinationNext = index < siblings.length ? doc.nodes.get(siblings[index]) : undefined;
  let position = doc.source.length;
  if (destinationNext?.block) {
    position = destinationNext.block.start;
  } else if (destinationPrevious?.block) {
    position =
      destinationPrevious.block.end + newlineLengthAt(doc.source, destinationPrevious.block.end);
  } else if (parent.block) {
    position = parent.block.end + newlineLengthAt(doc.source, parent.block.end);
  }
  const after = [...siblings.slice(0, index), ...orderedIds, ...siblings.slice(index)];
  if (sourceParent.id === parent.id && after.join('\u0000') === parent.children.join('\u0000')) {
    return { edits: [], selection: { kind: 'source', offset: labelOffset }, verify() {} };
  }
  const ending = lineEnding(doc.source);
  let afterHeading = destinationPrevious?.kind === 'heading';
  const blocks: MovedBlock[] = [];
  for (const item of items) {
    const block = moveNodeBlock(doc, item.node, item.block, parent, afterHeading, ending);
    blocks.push(block);
    afterHeading = block.heading;
  }
  const moved = joinMovedBlocks(blocks, ending);
  const cuts = mergeCuts(items.map((item) => cutForMove(doc.source, item.node, item.block)));
  for (const cut of cuts) {
    if (position > cut.start && position < cut.end) position = cut.start;
  }
  let gapEnd = position;
  while (gapEnd < doc.source.length) {
    const end = lineEnd(doc.source, gapEnd);
    if (doc.source.slice(gapEnd, end).trim()) break;
    gapEnd = end + newlineLengthAt(doc.source, end);
  }
  for (const cut of cuts) {
    if (gapEnd > cut.start && gapEnd <= cut.end && cut.start >= position) gapEnd = cut.start;
  }
  const gap = gapEnd - position;
  let afterCut = gapEnd;
  for (const cut of cuts) {
    if (gapEnd >= cut.start && gapEnd <= cut.end) afterCut = Math.max(afterCut, cut.end);
  }
  let text = moved;
  const startsHeading = /^#{1,6}(?:[ \t]|$)/u.test(text);
  const cutAtEnd = cuts.find((cut) => cut.end === position);
  const anchor = cutAtEnd ? cutAtEnd.start : position;
  const blankBefore = gap === 0 && hasBlankBefore(doc.source, anchor);
  let leading = 0;
  if (startsHeading && parent.kind !== 'listItem' && !blankBefore) {
    text = ending + text;
    leading = ending.length;
  }
  if (afterCut < doc.source.length && nextTextStartsWithHeading(doc.source, afterCut)) {
    text += ending + ending;
  }
  const before = cutAtEnd ? cutAtEnd.start - 1 : position - 1;
  const atLineStart = before < 0 || doc.source[before] === '\n';
  const following =
    gapEnd < doc.source.length || (gapEnd === doc.source.length && doc.source.endsWith(ending));
  const placed = placeBlock(text, ending, atLineStart, following);
  const edits: Splice[] = cuts.map((cut) => ({ from: cut.start, to: cut.end, insert: '' }));
  edits.push(
    gap > 0
      ? { from: position, to: gapEnd, insert: placed.insert }
      : { from: position, to: position, insert: placed.insert },
  );
  const insertion = cuts.length;
  return {
    edits,
    selection: {
      kind: 'insert',
      edit: insertion,
      offset: placed.leading + leading + firstLineMarker(blocks[0].text),
    },
    verify(next) {
      if (contentNodeCount(next) !== contentNodeCount(doc)) {
        throw shape('The batch move changed the node count');
      }
      if (items.length !== ids.length) {
        throw shape('The batch move lost a selected block');
      }
      const target = parent.block
        ? nodeByBlockStart(next, mapOffset(edits, parent.block.start))
        : next.nodes.get(next.root);
      if (!target) throw shape('The batch move lost the target');
      const children = target.children.slice(index, index + ids.length);
      if (children.length !== ids.length) {
        throw shape('The batch move did not place every moved node');
      }
      for (let offset = 0; offset < items.length; offset += 1) {
        const child = next.nodes.get(children[offset]);
        if (!child || child.parent !== target.id) {
          throw shape('The moved node has the wrong parent');
        }
        if (comparableLabel(next, child) !== comparableLabel(doc, items[offset].node)) {
          throw shape('The moved label changed');
        }
        if (countSubtree(next, child) !== countSubtree(doc, items[offset].node)) {
          throw shape('The moved subtree changed');
        }
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
      if (contentNodeCount(next) !== contentNodeCount(doc)) throw shape('The node count changed');
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

function resolveNode(doc: Document, ref: string): EditNode | undefined {
  const direct = doc.nodes.get(ref);
  if (direct) return direct;
  const targetId = doc.identities.get(ref);
  if (targetId !== undefined) return doc.nodes.get(targetId);
  return undefined;
}

function resolveIdentity(doc: Document, ref: string): string {
  if (ref === 'root' || ref === doc.root) return 'root';
  const node = doc.nodes.get(ref);
  if (node && node.identity && node.identity.range !== null) {
    return node.identity.id;
  }
  return ref;
}

function nodeLineInsertOffset(source: string, blockStart: number): number {
  let end = lineEnd(source, blockStart);
  if (end > blockStart && source[end - 1] === '\r') {
    end -= 1;
  }
  while (end > blockStart && (source[end - 1] === ' ' || source[end - 1] === '\t')) {
    end -= 1;
  }
  return end;
}

function hasGraphIssue(doc: Document): boolean {
  for (const issue of doc.conventionIssues) {
    if (issue.code === 'E_GRAPH') return true;
  }
  return false;
}

function hasConventionIssue(doc: Document): boolean {
  for (const issue of doc.conventionIssues) {
    if (issue.code === 'E_GRAPH' || issue.code === 'E_IDENTITY') return true;
  }
  return false;
}

function planCreateEdge(
  doc: Document,
  fromRef: string,
  toRef: string,
  rawLabel: string | null,
  random?: RandomSource,
): Plan {
  if (hasGraphIssue(doc)) {
    throw new EditError('E_SHAPE', 'The document graph metadata is invalid');
  }
  const fromNode = resolveNode(doc, fromRef);
  if (!fromNode) {
    throw new EditError('E_NODE', 'The source node does not exist', fromRef);
  }
  const toNode = resolveNode(doc, toRef);
  if (!toNode) {
    throw new EditError('E_NODE', 'The target node does not exist', toRef);
  }
  if (fromNode.opaque || !fromNode.block) {
    throw new EditError(
      'E_CAPABILITY',
      'The node does not support relationship edges',
      fromNode.id,
    );
  }
  if (toNode.opaque || !toNode.block) {
    throw new EditError('E_CAPABILITY', 'The node does not support relationship edges', toNode.id);
  }
  if (fromNode.id === toNode.id) {
    throw new EditError('E_SHAPE', 'Self-loops are not supported');
  }
  const label = rawLabel && rawLabel.trim().length > 0 ? rawLabel.trim() : null;
  if (label && (label.includes('<!--') || label.includes('-->'))) {
    throw new EditError('E_SHAPE', 'The edge label cannot contain HTML comments');
  }

  const taken = new Set(doc.identities.keys());
  for (const id of doc.order) {
    const identity = doc.nodes.get(id)?.identity;
    if (identity && identity.range !== null) taken.add(identity.id);
  }

  const splices: Splice[] = [];

  let fromIdentity: string;
  if (fromNode.id === doc.root) {
    fromIdentity = 'root';
  } else if (fromNode.identity && fromNode.identity.range !== null) {
    fromIdentity = fromNode.identity.id;
  } else {
    const minted = mintIdentity(taken, random ?? Math.random);
    if (!minted) {
      throw new EditError('E_SHAPE', 'No node identity characters remain');
    }
    fromIdentity = minted;
    taken.add(minted);
    const end = nodeLineInsertOffset(doc.source, fromNode.block.start);
    splices.push({ from: end, to: end, insert: ` <!-- ^${minted} -->` });
  }

  let toIdentity: string;
  if (toNode.id === doc.root) {
    toIdentity = 'root';
  } else if (toNode.identity && toNode.identity.range !== null) {
    toIdentity = toNode.identity.id;
  } else {
    const minted = mintIdentity(taken, random ?? Math.random);
    if (!minted) {
      throw new EditError('E_SHAPE', 'No node identity characters remain');
    }
    toIdentity = minted;
    taken.add(minted);
    const end = nodeLineInsertOffset(doc.source, toNode.block.start);
    splices.push({ from: end, to: end, insert: ` <!-- ^${minted} -->` });
  }

  if (doc.graph.edges.some((edge) => edge.from === fromIdentity && edge.to === toIdentity)) {
    throw new EditError('E_SHAPE', 'An edge already exists between these nodes');
  }

  const nextEdge: GraphEdge = { from: fromIdentity, to: toIdentity, label };
  const nextGraph: GraphData = {
    edges: [...doc.graph.edges, nextEdge],
    groups: doc.graph.groups,
    block: doc.graph.block,
  };
  const ending = doc.source.includes('\r\n') ? '\r\n' : '\n';

  if (doc.graph.block === null) {
    const append = appendGraphSplice(doc.source, nextGraph, ending);
    if (append) splices.push(append);
  } else {
    splices.push({
      from: doc.graph.block.start,
      to: doc.graph.block.end,
      insert: serializeGraphBlock(nextGraph, ending),
    });
  }

  const selectionOffset = fromNode.label ? fromNode.label.start : fromNode.block.start;
  return {
    edits: splices,
    selection: { kind: 'source', offset: selectionOffset },
    verify(next) {
      if (hasConventionIssue(next)) {
        throw new EditError('E_SHAPE', 'The created edge produced convention issues');
      }
      const created = next.graph.edges.find((e) => e.from === fromIdentity && e.to === toIdentity);
      if (!created || created.label !== label) {
        throw new EditError('E_SHAPE', 'The created edge did not survive parsing');
      }
    },
  };
}

function planDeleteEdge(doc: Document, fromRef: string, toRef: string): Plan {
  if (hasGraphIssue(doc)) {
    throw new EditError('E_SHAPE', 'The document graph metadata is invalid');
  }
  const fromNode = resolveNode(doc, fromRef);
  const fromIdentity = resolveIdentity(doc, fromRef);
  const toIdentity = resolveIdentity(doc, toRef);

  const edgeExists = doc.graph.edges.some(
    (edge) => edge.from === fromIdentity && edge.to === toIdentity,
  );
  if (!edgeExists) {
    throw new EditError('E_SHAPE', 'The edge does not exist');
  }

  const remainingEdges = doc.graph.edges.filter(
    (edge) => !(edge.from === fromIdentity && edge.to === toIdentity),
  );

  const referenced = new Set<string>();
  for (const edge of remainingEdges) {
    referenced.add(edge.from);
    referenced.add(edge.to);
  }
  for (const group of doc.graph.groups) {
    for (const root of group.roots) referenced.add(root);
  }

  const drop: { nodeId: string; range: Range }[] = [];
  for (const id of doc.order) {
    const identity = doc.nodes.get(id)?.identity;
    if (!identity || identity.range === null) continue;
    if (!referenced.has(identity.id)) drop.push({ nodeId: id, range: identity.range });
  }

  const removal: GraphRemoval = {
    graph: { edges: remainingEdges, groups: doc.graph.groups, block: doc.graph.block },
    drop,
    changed: true,
  };

  const markerSplices = markerRemovalSplices(doc.source, removal);
  const graphSplices = graphBlockSplices(doc.source, doc, removal, { start: 0, end: 0 });
  const splices = [...markerSplices, ...graphSplices];

  const selectionOffset = fromNode?.label ? fromNode.label.start : 0;
  return {
    edits: splices,
    selection: { kind: 'source', offset: selectionOffset },
    verify(next) {
      if (hasConventionIssue(next)) {
        throw new EditError('E_SHAPE', 'Deleting edge produced convention issues');
      }
      const found = next.graph.edges.some(
        (edge) => edge.from === fromIdentity && edge.to === toIdentity,
      );
      if (found) {
        throw new EditError('E_SHAPE', 'The edge was not deleted');
      }
    },
  };
}

function planSetEdgeLabel(
  doc: Document,
  fromRef: string,
  toRef: string,
  rawLabel: string | null,
): Plan {
  if (hasGraphIssue(doc)) {
    throw new EditError('E_SHAPE', 'The document graph metadata is invalid');
  }
  const fromNode = resolveNode(doc, fromRef);
  const fromIdentity = resolveIdentity(doc, fromRef);
  const toIdentity = resolveIdentity(doc, toRef);

  const edgeIndex = doc.graph.edges.findIndex(
    (edge) => edge.from === fromIdentity && edge.to === toIdentity,
  );
  if (edgeIndex === -1) {
    throw new EditError('E_SHAPE', 'The edge does not exist');
  }

  const label = rawLabel && rawLabel.trim().length > 0 ? rawLabel.trim() : null;
  if (label && (label.includes('<!--') || label.includes('-->'))) {
    throw new EditError('E_SHAPE', 'The edge label cannot contain HTML comments');
  }

  const nextEdges = doc.graph.edges.map((edge, index) =>
    index === edgeIndex ? { ...edge, label } : edge,
  );
  const nextGraph: GraphData = {
    edges: nextEdges,
    groups: doc.graph.groups,
    block: doc.graph.block,
  };
  const ending = doc.source.includes('\r\n') ? '\r\n' : '\n';

  const splices: Splice[] = [];
  if (doc.graph.block) {
    splices.push({
      from: doc.graph.block.start,
      to: doc.graph.block.end,
      insert: serializeGraphBlock(nextGraph, ending),
    });
  }

  const selectionOffset = fromNode?.label ? fromNode.label.start : 0;
  return {
    edits: splices,
    selection: { kind: 'source', offset: selectionOffset },
    verify(next) {
      if (hasConventionIssue(next)) {
        throw new EditError('E_SHAPE', 'Setting edge label produced convention issues');
      }
      const updated = next.graph.edges.find(
        (edge) => edge.from === fromIdentity && edge.to === toIdentity,
      );
      if (!updated || updated.label !== label) {
        throw new EditError('E_SHAPE', 'The edge label was not updated');
      }
    },
  };
}

function shape(message: string): EditError {
  return new EditError('E_SHAPE', message);
}

function planCreateGroup(
  doc: Document,
  nodeIds: string[],
  label?: string,
  random?: RandomSource,
): Plan {
  if (nodeIds.length === 0) {
    throw new EditError('E_SHAPE', 'A group must have at least one root');
  }
  for (const id of nodeIds) {
    if (!doc.nodes.has(id)) {
      throw new EditError('E_NODE', `No node with id ${id}`, id);
    }
  }
  if (nodeIds.length > 1) {
    const firstNode = doc.nodes.get(nodeIds[0]);
    const commonParent = firstNode?.parent;
    if (commonParent === null || commonParent === undefined) {
      throw new EditError('E_SHAPE', 'Group roots must share a common parent');
    }
    const sameParent = nodeIds.every((id) => doc.nodes.get(id)?.parent === commonParent);
    if (!sameParent) {
      throw new EditError('E_SHAPE', 'Group roots must share a common parent');
    }
    const parentNode = doc.nodes.get(commonParent);
    if (!parentNode) {
      throw new EditError('E_SHAPE', 'Group parent not found');
    }
    const indices = nodeIds.map((id) => parentNode.children.indexOf(id));
    const contiguous = indices.every((idx, i) => idx !== -1 && idx === indices[0] + i);
    if (!contiguous) {
      throw new EditError('E_SHAPE', 'Group roots must be contiguous siblings');
    }
  }

  const newSubtree = new Set<string>();
  for (const rootId of nodeIds) {
    for (const id of subtreeIds(doc, rootId)) newSubtree.add(id);
  }
  const resolve = (ref: string): string | undefined =>
    ref === 'root' ? doc.root : doc.identities.get(ref);
  for (const existing of doc.graph.groups) {
    for (const rootRef of existing.roots) {
      const resolved = resolve(rootRef);
      if (!resolved) continue;
      for (const id of subtreeIds(doc, resolved)) {
        if (newSubtree.has(id)) {
          throw new EditError('E_SHAPE', 'Group subtrees overlap');
        }
      }
    }
  }

  const ending = lineEnding(doc.source);
  const taken = new Set(doc.identities.keys());
  for (const node of doc.nodes.values()) {
    if (node.identity && node.identity.range !== null) taken.add(node.identity.id);
  }
  const rng = random ?? Math.random;
  const markerSplices: Splice[] = [];
  const roots: string[] = [];

  for (const id of nodeIds) {
    if (id === doc.root) {
      roots.push('root');
      continue;
    }
    const node = doc.nodes.get(id);
    if (!node || !node.block) {
      throw new EditError('E_NODE', `Node ${id} has no block`);
    }
    if (node.identity) {
      roots.push(node.identity.id);
    } else {
      const minted = mintIdentity(taken, rng);
      if (minted === null) {
        throw new EditError('E_SHAPE', 'No node identity characters remain');
      }
      taken.add(minted);
      roots.push(minted);
      const lineEndOffset = lineEnd(doc.source, node.block.start);
      markerSplices.push({
        from: lineEndOffset,
        to: lineEndOffset,
        insert: ` <!-- ^${minted} -->`,
      });
    }
  }

  const cleanedLabel = label ? cleanLabel(label) : '';
  if (cleanedLabel.includes('<!--') || cleanedLabel.includes('-->')) {
    throw new EditError('E_SHAPE', 'Group label cannot contain HTML comment markers');
  }
  const newGroup: GraphGroup = {
    roots,
    label: cleanedLabel ? cleanedLabel : null,
  };
  const nextGraph: GraphData = {
    edges: doc.graph.edges,
    groups: [...doc.graph.groups, newGroup],
    block: doc.graph.block,
  };

  const graphSplice =
    doc.graph.block === null
      ? appendGraphSplice(doc.source, nextGraph, ending)
      : {
          from: doc.graph.block.start,
          to: doc.graph.block.end,
          insert: doc.source.slice(doc.graph.block.start, doc.graph.block.end).endsWith('\r\n')
            ? `${serializeGraphBlock(nextGraph, ending)}\r\n`
            : doc.source.slice(doc.graph.block.start, doc.graph.block.end).endsWith('\n')
              ? `${serializeGraphBlock(nextGraph, ending)}\n`
              : serializeGraphBlock(nextGraph, ending),
        };
  if (graphSplice === null) {
    throw new EditError('E_SHAPE', 'Failed to generate graph block');
  }

  const edits = [...markerSplices, graphSplice].toSorted((a, b) => a.from - b.from);
  const targetNode = doc.nodes.get(nodeIds[0]);
  const offset = targetNode?.label?.start ?? 0;

  return {
    edits,
    selection: { kind: 'source', offset },
    verify(next) {
      if (next.graph.groups.length !== doc.graph.groups.length + 1) {
        throw shape('The group was not created');
      }
    },
  };
}

function planDeleteGroup(doc: Document, groupIndex: number): Plan {
  if (groupIndex < 0 || groupIndex >= doc.graph.groups.length) {
    throw new EditError('E_SHAPE', 'Group index out of range');
  }
  const nextGroups = doc.graph.groups.filter((_, i) => i !== groupIndex);
  const referenced = new Set<string>();
  for (const edge of doc.graph.edges) {
    referenced.add(edge.from);
    referenced.add(edge.to);
  }
  for (const group of nextGroups) {
    for (const root of group.roots) referenced.add(root);
  }
  const drop: { nodeId: string; range: Range }[] = [];
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    const identity = node?.identity;
    if (!identity || identity.range === null) continue;
    if (!referenced.has(identity.id)) {
      drop.push({ nodeId: id, range: identity.range });
    }
  }
  const removal: GraphRemoval = {
    graph: { edges: doc.graph.edges, groups: nextGroups, block: doc.graph.block },
    drop,
    changed: true,
  };
  const markerSplices = markerRemovalSplices(doc.source, removal);
  const graphSplices = graphBlockSplices(doc.source, doc, removal, { start: 0, end: 0 });
  const edits = [...markerSplices, ...graphSplices].toSorted((a, b) => a.from - b.from);
  return {
    edits,
    selection: { kind: 'source', offset: 0 },
    verify(next) {
      if (next.graph.groups.length !== doc.graph.groups.length - 1) {
        throw shape('The group was not deleted');
      }
    },
  };
}

function planSetGroupLabel(doc: Document, groupIndex: number, rawText: string): Plan {
  if (groupIndex < 0 || groupIndex >= doc.graph.groups.length) {
    throw new EditError('E_SHAPE', 'Group index out of range');
  }
  const text = cleanLabel(rawText);
  if (text.includes('<!--') || text.includes('-->')) {
    throw new EditError('E_SHAPE', 'Group label cannot contain HTML comment markers');
  }
  const ending = lineEnding(doc.source);
  const nextGroups = doc.graph.groups.map((group, i) =>
    i === groupIndex ? { ...group, label: text ? text : null } : group,
  );
  const nextGraph: GraphData = {
    edges: doc.graph.edges,
    groups: nextGroups,
    block: doc.graph.block,
  };
  if (doc.graph.block === null) {
    throw new EditError('E_SHAPE', 'The document has no graph block');
  }
  const edits: Splice[] = [
    {
      from: doc.graph.block.start,
      to: doc.graph.block.end,
      insert: serializeGraphBlock(nextGraph, ending),
    },
  ];
  return {
    edits,
    selection: { kind: 'source', offset: 0 },
    verify(next) {
      const updated = next.graph.groups[groupIndex];
      if (!updated || updated.label !== (text ? text : null)) {
        throw shape('The group label was not updated');
      }
    },
  };
}
