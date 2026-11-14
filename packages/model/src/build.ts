import type { MarkmapNode } from '@markmap/core';
import { parse } from '@markmap/parse';
import { firstLine, HEADING_MARKER, indentWidth, lineStart, LIST_MARKER } from './source';
import type { Capabilities, Document, EditNode, ListInfo, NodeKind, Range } from './types';

export interface ParseDocumentResult {
  document: Document;
  tree: MarkmapNode;
  frontmatter: Record<string, unknown>;
}

export function parseDocument(source: string): ParseDocumentResult {
  const { root, frontmatter } = parse(source);
  return { document: buildFromTree(source, root), tree: root, frontmatter };
}

export function buildDocument(source: string): Document {
  return parseDocument(source).document;
}

function buildFromTree(source: string, root: MarkmapNode): Document {
  const nodes = new Map<string, EditNode>();
  const order: string[] = [];

  const visit = (tree: MarkmapNode, parent: EditNode | null) => {
    const node = buildNode(source, tree, parent);
    nodes.set(node.id, node);
    order.push(node.id);
    for (const child of tree.children) visit(child, node);
  };

  visit(root, null);
  const unit = detectUnit(nodes, order);
  return { source, root: root.id, nodes, order, unit };
}

function buildNode(source: string, tree: MarkmapNode, parent: EditNode | null): EditNode {
  const kind: NodeKind =
    tree.id === 'root'
      ? 'root'
      : tree.type === 'heading'
        ? 'heading'
        : tree.type === 'listItem'
          ? 'listItem'
          : 'opaque';
  const rawBlock = tree.source?.block ? clampRange(tree.source.block, source.length) : null;
  const block = rawBlock ? normalizeBlock(source, rawBlock) : null;
  const opaqueByKind = kind === 'opaque' || (kind !== 'root' && !block);
  const depth = typeof tree.data.depth === 'number' ? tree.data.depth : null;

  let list: ListInfo | null = null;
  let label: Range | null = tree.source?.label
    ? clampRange(tree.source.label, source.length)
    : null;
  let level = 0;
  let opaque = opaqueByKind;

  if (kind === 'listItem' && block) {
    const line = firstLine(source, block.start);
    const match = LIST_MARKER.exec(line);
    const ordered = tree.data.ordered === true;
    const checked = typeof tree.data.checked === 'boolean' ? tree.data.checked : null;
    if (!match) {
      opaque = true;
      list = { ordered, marker: '-', indent: '', checked };
    } else {
      const rest = line.slice(match[0].length);
      if (/^#{1,6}(?:[ \t]+|$)/.test(rest)) opaque = true;
      list = { ordered, marker: match[2], indent: match[1], checked };
      if (!label) {
        const point = block.start + match[0].length;
        label = { start: point, end: point };
      }
    }
    level = parent?.kind === 'listItem' ? parent.level + 1 : 1;
  } else if (kind === 'heading' || kind === 'root') {
    level = depth ?? 0;
    if (block) {
      const line = firstLine(source, block.start);
      const match = HEADING_MARKER.exec(line);
      if (!match) {
        opaque = true;
      } else {
        level = match[1].length;
        if (!label) {
          const point = block.start + match[0].length;
          label = { start: point, end: point };
        }
      }
    } else if (kind === 'heading') {
      opaque = true;
    }
  }

  if (kind === 'heading' && (level < 1 || level > 6)) opaque = true;

  const node: EditNode = {
    id: tree.id,
    kind,
    parent: parent?.id ?? null,
    children: tree.children.map((child) => child.id),
    level,
    label,
    block,
    list,
    opaque,
    capabilities: emptyCapabilities(),
  };
  node.capabilities = readCapabilities(node, parent);
  return node;
}

function readCapabilities(node: EditNode, parent: EditNode | null): Capabilities {
  const base: Capabilities = {
    editLabel: false,
    addChild: false,
    addSibling: false,
    outdent: false,
    delete: false,
    move: false,
    toggleCheck: false,
  };
  if (node.kind === 'opaque') {
    return { ...base, delete: Boolean(parent && node.block), move: Boolean(parent && node.block) };
  }
  if (node.kind === 'root') {
    return { ...base, editLabel: Boolean(node.label && node.block), addChild: !node.opaque };
  }
  if (node.opaque) {
    return { ...base, delete: Boolean(parent), move: Boolean(parent) };
  }
  if (node.kind === 'heading') {
    return {
      ...base,
      editLabel: Boolean(node.label && node.block),
      addChild: node.level < 6,
      addSibling: Boolean(parent),
      outdent: parent?.kind === 'heading',
      delete: Boolean(parent),
      move: Boolean(parent),
    };
  }
  return {
    ...base,
    editLabel: Boolean(node.label && node.block),
    addChild: true,
    addSibling: Boolean(parent),
    outdent: parent?.kind === 'listItem',
    delete: Boolean(parent),
    move: Boolean(parent),
    toggleCheck: node.list?.checked != null,
  };
}

function emptyCapabilities(): Capabilities {
  return {
    editLabel: false,
    addChild: false,
    addSibling: false,
    outdent: false,
    delete: false,
    move: false,
    toggleCheck: false,
  };
}

function clampRange(range: Range, length: number): Range {
  const start = Math.max(0, Math.min(range.start, length));
  const end = Math.max(start, Math.min(range.end, length));
  return { start, end };
}

function normalizeBlock(source: string, range: Range): Range {
  const start = lineStart(source, range.start);
  let end = range.end;
  if (end < source.length) {
    const endLine = lineStart(source, end);
    if (/^[ \t]{0,3}$/.test(source.slice(endLine, end))) end = endLine;
  }
  return { start, end };
}

function detectUnit(nodes: Map<string, EditNode>, order: string[]): string {
  for (const id of order) {
    const node = nodes.get(id);
    if (node?.kind !== 'listItem' || !node.list || !node.parent) continue;
    const parent = nodes.get(node.parent);
    if (parent?.kind !== 'listItem' || !parent.list) continue;
    if (node.list.indent.length > parent.list.indent.length) {
      return node.list.indent.slice(parent.list.indent.length);
    }
  }
  return '  ';
}

export function nodeAtOffset(doc: Document, offset: number): EditNode | undefined {
  let best: EditNode | undefined;
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (!node?.block || node.kind === 'root') continue;
    if (offset < node.block.start || offset > node.block.end) continue;
    const nodeSize = node.block.end - node.block.start;
    const bestSize = best?.block ? best.block.end - best.block.start : Infinity;
    if (nodeSize <= bestSize) best = node;
  }
  return best;
}

export function labelText(doc: Document, node: EditNode): string {
  if (!node.label) return '';
  return doc.source.slice(node.label.start, node.label.end);
}

export function indentColumns(node: EditNode): number {
  return node.list ? indentWidth(node.list.indent) : 0;
}
