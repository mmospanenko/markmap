import {
  assignIds,
  type NodeSource,
  type Note,
  type MarkmapNode,
  type MdastBlock,
  type SourceRange,
} from '@markmap/core';
import type {
  Code,
  Heading,
  List,
  ListItem,
  Node,
  PhrasingContent,
  Root,
  RootContent,
} from 'mdast';
import type { PluggableList } from 'unified';
import { parseMdast } from './pipeline';

export interface ToTreeOptions {
  /** Title for a synthesized root, usually from frontmatter. */
  title?: string;
  plugins?: PluggableList;
}

/**
 * Convert an mdast tree into a Markmap tree.
 *
 * - Headings nest by depth; list items nest under the heading or item that contains them.
 * - Other blocks become notes of the node that owns them. Blocks before the first
 *   heading attach to the root.
 * - A lone top-level heading at any level becomes the root. A `title` supplies
 *   the root label only when no heading promotion happens.
 * - Raw HTML, frontmatter and link definitions are dropped. A `<!-- markmap: … -->`
 *   comment in a label sets node options: `fold` folds the node, `foldAll` folds it
 *   and everything below.
 */
export function toTree(mdast: Root, options: ToTreeOptions = {}): MarkmapNode {
  const docEnd = mdast.position?.end.offset ?? 0;
  const sectionEnds = readSectionEnds(mdast.children, docEnd);
  let root = createNode('root', options.title ? [{ type: 'text', value: options.title }] : []);
  const stack: { depth: number; node: MarkmapNode }[] = [{ depth: 0, node: root }];

  for (const block of mdast.children) {
    if (block.type === 'heading') {
      while (stack.length > 1 && stack.at(-1)!.depth >= block.depth) stack.pop();
      const node = createNode('heading', block.children, block, sectionEnds.get(block));
      node.data.depth = block.depth;
      stack.at(-1)!.node.children.push(node);
      stack.push({ depth: block.depth, node });
    } else {
      addBlock(stack.at(-1)!.node, block, options);
    }
  }

  root = promoteSingleHeading(root);
  return assignIds(root);
}

function readSectionEnds(children: RootContent[], docEnd: number): Map<Heading, number> {
  const ends = new Map<Heading, number>();
  const open: { depth: number; node: Heading }[] = [];
  for (const block of children) {
    if (block.type !== 'heading') continue;
    while (open.length && open[open.length - 1].depth >= block.depth) {
      const closed = open.pop()!;
      ends.set(closed.node, block.position?.start.offset ?? docEnd);
    }
    open.push({ depth: block.depth, node: block });
  }
  for (const item of open) ends.set(item.node, docEnd);
  return ends;
}

function createNode(
  type: string,
  label: PhrasingContent[],
  source?: Node,
  blockEnd?: number,
): MarkmapNode {
  const { content, directives } = readLabel(label);
  const node: MarkmapNode = { id: '', type, content, notes: [], data: {}, children: [] };
  if (directives.has('fold')) node.data.fold = true;
  if (directives.has('foldAll')) node.data.foldAll = true;
  const start = source?.position?.start.offset;
  const end = source?.position?.end.offset;
  if (start != null && end != null) {
    const range: SourceRange = { start, end };
    const info: NodeSource = { block: { start, end: blockEnd ?? end } };
    const labelRange = inlineRange(label);
    if (labelRange) info.label = labelRange;
    node.position = range;
    node.source = info;
  }
  return node;
}

function inlineRange(label: PhrasingContent[]): SourceRange | undefined {
  const first = label.find((node) => node.type !== 'html' && node.position);
  const last = label.findLast((node) => node.type !== 'html' && node.position);
  if (!first?.position || !last?.position) return undefined;
  const startOffset = first.position.start.offset;
  const endOffset = last.position.end.offset;
  if (startOffset == null || endOffset == null) return undefined;
  let start = startOffset;
  let end = endOffset;
  if (first.type === 'text') start += first.value.length - first.value.trimStart().length;
  if (last.type === 'text') end -= last.value.length - last.value.trimEnd().length;
  return start <= end ? { start, end } : undefined;
}

function addBlock(parent: MarkmapNode, block: RootContent, options: ToTreeOptions) {
  if (isNoteFence(block)) {
    addFence(parent, block, options);
    return;
  }
  switch (block.type) {
    case 'list':
      addList(parent, block, options);
      return;
    case 'html':
    case 'yaml':
    case 'definition':
      return;
    default:
      if (isMdastBlock(block)) attach(parent, block, rangeOf(block), false);
  }
}

function isNoteFence(block: RootContent): block is Code {
  return block.type === 'code' && block.lang?.trim() === 'markmap-note';
}

function addFence(parent: MarkmapNode, fence: Code, options: ToTreeOptions): void {
  const source = rangeOf(fence);
  const { mdast } = parseMdast(fence.value, options.plugins ?? []);
  for (const block of mdast.children) {
    if (block.type === 'yaml') continue;
    if (isMdastBlock(block)) attach(parent, block, source, true);
  }
}

function addList(parent: MarkmapNode, list: List, options: ToTreeOptions) {
  for (const item of list.children) parent.children.push(fromListItem(item, list, options));
}

function fromListItem(item: ListItem, list: List, options: ToTreeOptions): MarkmapNode {
  const [first, ...rest] = item.children;
  // `- # Title` uses the heading as the label too.
  const hasLabel = first?.type === 'paragraph' || first?.type === 'heading';
  const node = createNode(
    'listItem',
    hasLabel ? first.children : [],
    item,
    item.position?.end.offset,
  );
  if (list.ordered) node.data.ordered = true;
  if (item.checked != null) node.data.checked = item.checked;
  for (const block of hasLabel ? rest : item.children) addBlock(node, block, options);
  return node;
}

function attach(
  node: MarkmapNode,
  block: MdastBlock,
  source: SourceRange | undefined,
  fence: boolean,
) {
  const note: Note = { block: stripPositions(block), after: node.children.length, fence };
  if (source) note.source = source;
  node.notes.push(note);
}

function rangeOf(node: Node): SourceRange | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start == null || end == null ? undefined : { start, end };
}

function isMdastBlock(block: RootContent): block is MdastBlock {
  switch (block.type) {
    case 'blockquote':
    case 'code':
    case 'definition':
    case 'footnoteDefinition':
    case 'heading':
    case 'html':
    case 'list':
    case 'paragraph':
    case 'table':
    case 'thematicBreak':
      return true;
    default:
      return false;
  }
}

function promoteSingleHeading(root: MarkmapNode): MarkmapNode {
  const [only] = root.children;
  if (root.children.length !== 1 || only.type !== 'heading') return root;
  const depth = typeof only.data.depth === 'number' ? only.data.depth : 0;
  if (depth < 1 || depth > 6) return root;
  // Blocks before the heading come first in source order.
  only.notes = [...root.notes.map((a) => ({ ...a, after: 0 })), ...only.notes];
  return only;
}

/** Drop mdast `position` fields so the tree stays small and serializable. */
function stripPositions<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripPositions) as T;
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'position') result[key] = stripPositions(child);
    }
    return result as T;
  }
  return value;
}

const DIRECTIVE = /^<!--\s*markmap:\s*([\s\S]*?)\s*-->$/;

/** Drop raw HTML from a label, collecting `<!-- markmap: … -->` directives on the way. */
function readLabel(label: PhrasingContent[]): {
  content: PhrasingContent[];
  directives: Set<string>;
} {
  const directives = new Set<string>();
  const clean = (nodes: PhrasingContent[]): PhrasingContent[] =>
    nodes.flatMap((node): PhrasingContent[] => {
      if (node.type === 'html') {
        const match = node.value.trim().match(DIRECTIVE);
        for (const word of match?.[1].split(/\s+/) ?? []) if (word) directives.add(word);
        return [];
      }
      if ('children' in node)
        return [
          { ...node, children: clean(node.children as PhrasingContent[]) } as PhrasingContent,
        ];
      return [node];
    });
  const content = stripPositions(clean(label));
  // `Label <!-- markmap: fold -->` leaves a trailing space behind.
  const last = content.at(-1);
  if (last?.type === 'text') {
    last.value = last.value.trimEnd();
    if (!last.value) content.pop();
  }
  return { content, directives };
}
