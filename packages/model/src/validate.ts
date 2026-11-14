import { firstLine, HEADING_MARKER, indentWidth, LIST_MARKER } from './source';
import type { Document, EditNode, Issue, IssueCode, Range } from './types';

export class ModelError extends Error {
  issues: Issue[];

  constructor(issues: Issue[]) {
    super(issues.map((issue) => issue.message).join('; '));
    this.name = 'ModelError';
    this.issues = issues;
  }
}

export function validateDocument(doc: Document): Issue[] {
  const issues: Issue[] = [];
  const add = (code: IssueCode, message: string, nodeId?: string) => {
    issues.push(nodeId ? { code, message, nodeId } : { code, message });
  };

  const root = doc.nodes.get(doc.root);
  if (!root) {
    add('E_ROOT', 'Root node is missing');
    return issues;
  }
  if (root.kind !== 'root') add('E_ROOT', 'Root node is not a root', root.id);
  if (root.parent) add('E_ROOT', 'Root node has a parent', root.id);

  const traversal: string[] = [];
  const visited = new Set<string>();
  const stack = [doc.root];
  while (stack.length) {
    const id = stack.pop();
    if (id == null) continue;
    if (visited.has(id)) {
      add('E_CYCLE', `Node ${id} is reachable twice`, id);
      continue;
    }
    visited.add(id);
    traversal.push(id);
    const node = doc.nodes.get(id);
    if (!node) {
      add('E_PARENT', `Node ${id} is missing`, id);
      continue;
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]);
    }
  }

  if (traversal.length !== doc.order.length) add('E_ORDER', 'Node order does not match the tree');
  for (let index = 0; index < Math.min(traversal.length, doc.order.length); index += 1) {
    if (traversal[index] !== doc.order[index]) {
      add('E_ORDER', `Node order differs at index ${index}`);
      break;
    }
  }
  if (visited.size !== doc.nodes.size) add('E_ORDER', 'Some nodes are not reachable from the root');

  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (!node) {
      add('E_PARENT', `Node ${id} is missing`, id);
      continue;
    }
    validateNode(doc, node, add);
  }

  return issues;
}

function validateNode(
  doc: Document,
  node: EditNode,
  add: (code: IssueCode, message: string, nodeId?: string) => void,
): void {
  const sourceLength = doc.source.length;
  if (node.kind === 'listItem' && !node.list)
    add('E_KIND', 'A list item has no list info', node.id);
  if (node.kind !== 'listItem' && node.list)
    add('E_KIND', 'A non-list node has list info', node.id);

  if (node.block) {
    if (!isRange(node.block, sourceLength)) {
      add('E_RANGE', 'Block range is outside the source', node.id);
    } else {
      validateSlice(doc, node, add);
    }
  } else if (node.kind !== 'root' && !node.opaque) {
    add('E_RANGE', 'A non-root node has no block range', node.id);
  }

  if (node.label) {
    if (!isRange(node.label, sourceLength)) {
      add('E_LABEL', 'Label range is outside the source', node.id);
    } else if (node.block && !contains(node.block, node.label)) {
      add('E_LABEL', 'Label range is outside the block', node.id);
    } else if (
      node.kind !== 'listItem' &&
      doc.source.slice(node.label.start, node.label.end).includes('\n')
    ) {
      add('E_LABEL', 'A heading label must stay on one line', node.id);
    }
  }

  if (node.parent) {
    const parent = doc.nodes.get(node.parent);
    if (!parent) {
      add('E_PARENT', 'Parent node is missing', node.id);
    } else {
      if (!parent.children.includes(node.id))
        add('E_PARENT', 'Parent does not list this child', node.id);
      if (parent.block && node.block && !contains(parent.block, node.block)) {
        add('E_RANGE', 'Child block is outside the parent block', node.id);
      }
      if (node.kind === 'heading') {
        if (parent.kind === 'heading' && node.level <= parent.level) {
          add('E_LEVEL', 'Child heading must be deeper than its parent', node.id);
        } else if (parent.kind === 'root' && parent.level > 0 && node.level <= parent.level) {
          add('E_LEVEL', 'Child heading must be deeper than the root heading', node.id);
        } else if (parent.kind !== 'heading' && parent.kind !== 'root') {
          add('E_KIND', 'A heading cannot be a child of a list item', node.id);
        }
      }
      if (node.kind === 'listItem') {
        if (parent.kind === 'listItem' && parent.list && node.list) {
          if (indentWidth(node.list.indent) <= indentWidth(parent.list.indent)) {
            add('E_INDENT', 'Nested list item must be indented deeper than its parent', node.id);
          }
          if (node.level !== parent.level + 1) {
            add('E_LEVEL', 'Nested list item has the wrong level', node.id);
          }
        } else if (node.level !== 1) {
          add('E_LEVEL', 'A top-level list item must have level 1', node.id);
        }
      }
    }
  } else if (node.id !== doc.root) {
    add('E_PARENT', 'Only the root may have no parent', node.id);
  }

  if (node.kind === 'heading' && (node.level < 1 || node.level > 6)) {
    add('E_LEVEL', 'Heading level must be between 1 and 6', node.id);
  }
  if (node.kind === 'root' && node.block && (node.level < 1 || node.level > 6)) {
    add('E_LEVEL', 'Root heading level must be between 1 and 6', node.id);
  }

  const seen = new Set<string>();
  let previousEnd: number | null = null;
  for (const childId of node.children) {
    if (seen.has(childId)) add('E_ORDER', 'Duplicate child id', node.id);
    seen.add(childId);
    const child = doc.nodes.get(childId);
    if (!child) {
      add('E_PARENT', `Child ${childId} is missing`, node.id);
      continue;
    }
    if (child.parent !== node.id) add('E_PARENT', 'Child points to another parent', childId);
    if (child.block) {
      if (previousEnd != null && child.block.start < previousEnd) {
        add('E_RANGE', 'Sibling blocks overlap or are out of order', childId);
      }
      previousEnd = child.block.end;
    }
  }
}

function validateSlice(
  doc: Document,
  node: EditNode,
  add: (code: IssueCode, message: string, nodeId?: string) => void,
): void {
  if (!node.block || node.opaque) return;
  const line = firstLine(doc.source, node.block.start);
  if (node.kind === 'heading' || node.kind === 'root') {
    const match = HEADING_MARKER.exec(line);
    if (!match) {
      add('E_SLICE', 'Heading block does not start with hashes', node.id);
      return;
    }
    if (match[1].length !== node.level) {
      add('E_SLICE', 'Heading level does not match the source', node.id);
    }
    return;
  }
  if (node.kind === 'listItem') {
    const match = LIST_MARKER.exec(line);
    if (!match) {
      add('E_SLICE', 'List item block does not start with a marker', node.id);
      return;
    }
    if (!node.list || match[1] !== node.list.indent || match[2] !== node.list.marker) {
      add('E_SLICE', 'List marker does not match the source', node.id);
    }
  }
}

function isRange(range: Range, length: number): boolean {
  return (
    Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start >= 0 &&
    range.end <= length &&
    range.start <= range.end
  );
}

function contains(outer: Range, inner: Range): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

export function assertDocument(doc: Document): void {
  const issues = validateDocument(doc);
  if (issues.length) throw new ModelError(issues);
}
