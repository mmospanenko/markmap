import {
  mintIdentity,
  parseDocument,
  serializeGraphBlock,
  type Document,
  type EditNode,
  type GraphData,
  type GraphEdge,
  type GraphGroup,
  type Issue,
  type RandomSource,
  type Range,
} from '@markmap/model';
import { EditError } from './errors';
import { applySplices, type Splice } from './splice';

export interface CopyBlockOptions {
  title?: string;
  random: RandomSource;
}

interface CopyPlan {
  mapping: Map<string, string>;
  edges: GraphEdge[];
  groups: GraphGroup[];
}

export interface GraphRemoval {
  graph: GraphData;
  drop: { nodeId: string; range: Range }[];
  changed: boolean;
}

export function copyBlock(doc: Document, nodeId: string, options: CopyBlockOptions): string | null {
  const node = doc.nodes.get(nodeId);
  if (!node) return null;
  const ending = doc.source.includes('\r\n') ? '\r\n' : '\n';
  const slice = copySlice(doc, node, options.title ?? '');
  if (slice === null) return null;
  if (nodeId === doc.root) return copyStandalone(doc, slice, ending);
  const subtree = subtreeIds(doc, nodeId);
  const plan = copyPlan(doc, subtree, options.random);
  const text = slice.start === slice.end ? '' : doc.source.slice(slice.start, slice.end);
  const splices: Splice[] = [];
  const graph = doc.graph.block;
  let graphRemoved = false;
  if (graph !== null) {
    const from = Math.max(graph.start, slice.start);
    const to = Math.min(graph.end, slice.end);
    if (from < to) {
      splices.push({ from: from - slice.start, to: to - slice.start, insert: '' });
      graphRemoved = true;
    }
  }
  for (const id of doc.order) {
    if (!subtree.has(id)) continue;
    const identity = doc.nodes.get(id)?.identity;
    if (!identity || identity.range === null) continue;
    const from = identity.range.start - slice.start;
    const to = identity.range.end - slice.start;
    const mapped = plan.mapping.get(identity.id);
    if (mapped !== undefined) {
      splices.push({ from, to, insert: `<!-- ^${mapped} -->` });
    } else {
      let start = from;
      while (start > 0) {
        const char = text[start - 1];
        if (char !== ' ' && char !== '\t') break;
        start -= 1;
      }
      splices.push({ from: start, to, insert: '' });
    }
  }
  let body = applySplices(text, splices).text;
  if (graphRemoved) body = body.replace(/(?:\r?\n[ \t]*)+$/u, '');
  let result = slice.prefix
    ? body
      ? `${slice.prefix}${ending}${ending}${body}`
      : slice.prefix
    : body;
  const graphText = serializeGraphBlock(plan, ending);
  if (graphText) {
    const separator = result.endsWith(ending) ? ending : ending + ending;
    result = `${result}${separator}${graphText}`;
  }
  return result;
}

function copyStandalone(
  doc: Document,
  slice: { start: number; end: number; prefix: string },
  ending: string,
): string {
  const text = slice.start === slice.end ? '' : doc.source.slice(slice.start, slice.end);
  let result = slice.prefix
    ? text
      ? `${slice.prefix}${ending}${ending}${text}`
      : slice.prefix
    : text;
  const graph = doc.graph.block;
  if (graph === null) return result;
  if (graph.start >= slice.start && graph.end <= slice.end) return result;
  const block = doc.source.slice(graph.start, graph.end);
  const separator = result.endsWith(ending) ? ending : ending + ending;
  result = `${result}${separator}${block}`;
  return result;
}

function copySlice(
  doc: Document,
  node: EditNode,
  rawTitle: string,
): { start: number; end: number; prefix: string } | null {
  if (node.block) {
    let start = node.block.start;
    if (node.id === doc.root) {
      const before = node.notes.filter((note) => note.range.end <= (node.block?.start ?? 0));
      if (before.length > 0) {
        start = Math.min(...before.map((note) => note.range.start));
      }
    }
    return { start, end: node.block.end, prefix: '' };
  }
  if (node.id !== doc.root) return null;
  const ranges: Range[] = node.notes.map((note) => note.range);
  for (const id of node.children) {
    const child = doc.nodes.get(id);
    if (child?.block) ranges.push(child.block);
  }
  const start = ranges.length ? Math.min(...ranges.map((range) => range.start)) : 0;
  const end = ranges.length ? Math.max(...ranges.map((range) => range.end)) : 0;
  const title = rawTitle.replace(/\s+/gu, ' ').trim();
  if (!title && start === end) return null;
  return { start, end, prefix: title ? `# ${title}` : '' };
}

export function subtreeIds(doc: Document, nodeId: string): Set<string> {
  const result = new Set<string>();
  const stack = [nodeId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    result.add(current);
    const node = doc.nodes.get(current);
    if (node) for (const child of node.children) stack.push(child);
  }
  return result;
}

export function readPastedGraph(
  doc: Document,
  raw: string,
  ending: string,
  random: RandomSource,
): { body: string; edges: GraphEdge[]; groups: GraphGroup[] } {
  const parsed = parseDocument(raw);
  const block = parsed.document.graph.block;
  if (block === null) {
    if (parsed.document.conventionIssues.some((issue) => issue.code === 'E_IDENTITY')) {
      throw new EditError('E_SHAPE', 'The pasted text has an identity without graph metadata');
    }
    return { body: raw, edges: [], groups: [] };
  }
  if (parsed.document.conventionIssues.length > 0) {
    throw new EditError('E_SHAPE', 'The pasted graph metadata is invalid');
  }
  const refs = new Set<string>();
  for (const edge of parsed.document.graph.edges) {
    refs.add(edge.from);
    refs.add(edge.to);
  }
  for (const group of parsed.document.graph.groups) {
    for (const root of group.roots) refs.add(root);
  }
  const taken = new Set(doc.identities.keys());
  const mapping = new Map<string, string>();
  for (const ref of refs) {
    if (ref === 'root') continue;
    if (!taken.has(ref)) continue;
    const minted = mintIdentity(taken, random);
    if (minted === null) throw new EditError('E_SHAPE', 'No node identity characters remain');
    mapping.set(ref, minted);
    taken.add(minted);
  }
  const splices: Splice[] = [{ from: block.start, to: block.end, insert: '' }];
  for (const id of parsed.document.order) {
    const identity = parsed.document.nodes.get(id)?.identity;
    const mapped = identity ? mapping.get(identity.id) : undefined;
    if (!identity || identity.range === null || mapped === undefined) continue;
    splices.push({
      from: identity.range.start,
      to: identity.range.end,
      insert: `<!-- ^${mapped} -->`,
    });
  }
  const body = applySplices(raw, splices).text;
  const ref = (value: string): string => mapping.get(value) ?? value;
  return {
    body,
    edges: parsed.document.graph.edges.map((edge) => ({
      ...edge,
      from: ref(edge.from),
      to: ref(edge.to),
    })),
    groups: parsed.document.graph.groups.map((group) => ({
      ...group,
      roots: group.roots.map(ref),
    })),
  };
}

function copyPlan(doc: Document, subtree: Set<string>, random: RandomSource): CopyPlan {
  const mapping = new Map<string, string>();
  if (doc.conventionIssues.some((issue: Issue) => issue.code === 'E_GRAPH')) {
    return { mapping, edges: [], groups: [] };
  }
  const copied = (ref: string): boolean => {
    if (ref === 'root') return false;
    const id = doc.identities.get(ref);
    return id !== undefined && subtree.has(id);
  };
  const edges = doc.graph.edges.filter((edge) => copied(edge.from) && copied(edge.to));
  const groups = doc.graph.groups.filter(
    (group) => group.roots.length > 0 && group.roots.every((root) => copied(root)),
  );
  const required = new Set<string>();
  for (const edge of edges) {
    required.add(edge.from);
    required.add(edge.to);
  }
  for (const group of groups) {
    for (const root of group.roots) required.add(root);
  }
  const taken = new Set(doc.identities.keys());
  for (const id of doc.order) {
    const identity = doc.nodes.get(id)?.identity;
    if (identity && identity.range !== null) taken.add(identity.id);
  }
  for (const id of doc.order) {
    if (!subtree.has(id)) continue;
    const identity = doc.nodes.get(id)?.identity;
    if (!identity || identity.range === null) continue;
    if (!required.has(identity.id) || mapping.has(identity.id)) continue;
    const minted = mintIdentity(taken, random);
    if (minted === null) {
      throw new EditError('E_SHAPE', 'No node identity characters remain');
    }
    mapping.set(identity.id, minted);
    taken.add(minted);
  }
  const mapEdge = (edge: GraphEdge): GraphEdge | null => {
    const from = mapping.get(edge.from);
    const to = mapping.get(edge.to);
    return from === undefined || to === undefined ? null : { ...edge, from, to };
  };
  const mapGroup = (group: GraphGroup): GraphGroup | null => {
    const roots = group.roots.map((root) => mapping.get(root));
    if (roots.some((root) => root === undefined)) return null;
    return { ...group, roots: roots.filter((root): root is string => root !== undefined) };
  };
  return {
    mapping,
    edges: edges.flatMap((edge) => {
      const mapped = mapEdge(edge);
      return mapped === null ? [] : [mapped];
    }),
    groups: groups.flatMap((group) => {
      const mapped = mapGroup(group);
      return mapped === null ? [] : [mapped];
    }),
  };
}

export function removeGraphNodes(doc: Document, removed: ReadonlySet<string>): GraphRemoval {
  if (doc.conventionIssues.some((issue) => issue.code === 'E_GRAPH')) {
    return { graph: doc.graph, drop: [], changed: false };
  }
  const removedIds = new Set<string>();
  for (const id of removed) {
    const identity = doc.nodes.get(id)?.identity;
    if (identity && identity.range !== null) removedIds.add(identity.id);
  }
  const edges = doc.graph.edges.filter(
    (edge) => !removedIds.has(edge.from) && !removedIds.has(edge.to),
  );
  const groups = doc.graph.groups.flatMap((group) => {
    const roots = group.roots.filter((root) => !removedIds.has(root));
    return roots.length === 0 ? [] : [{ ...group, roots }];
  });
  const referenced = new Set<string>();
  for (const edge of edges) {
    referenced.add(edge.from);
    referenced.add(edge.to);
  }
  for (const group of groups) {
    for (const root of group.roots) referenced.add(root);
  }
  const drop: { nodeId: string; range: Range }[] = [];
  for (const id of doc.order) {
    if (removed.has(id)) continue;
    const identity = doc.nodes.get(id)?.identity;
    if (!identity || identity.range === null) continue;
    if (!referenced.has(identity.id)) drop.push({ nodeId: id, range: identity.range });
  }
  const changed =
    JSON.stringify(edges) !== JSON.stringify(doc.graph.edges) ||
    JSON.stringify(groups) !== JSON.stringify(doc.graph.groups);
  return { graph: { edges, groups, block: doc.graph.block }, drop, changed };
}

export function graphBlockSplices(
  source: string,
  doc: Document,
  removal: GraphRemoval,
  cut: Range,
): Splice[] {
  if (!removal.changed) return [];
  const block = doc.graph.block;
  const empty = removal.graph.edges.length === 0 && removal.graph.groups.length === 0;
  const ending = source.includes('\r\n') ? '\r\n' : '\n';
  if (block === null) {
    const append = appendGraphSplice(source, removal.graph, ending);
    return append === null ? [] : [append];
  }
  const inside = block.start < cut.end && block.end > cut.start;
  if (inside) {
    const append = appendGraphSplice(source, removal.graph, ending);
    return append === null ? [] : [append];
  }
  if (empty) return [removeGraphSplice(source, block)];
  if (!source.slice(block.start, block.end).endsWith('\n')) {
    return [
      { from: block.start, to: block.end, insert: serializeGraphBlock(removal.graph, ending) },
    ];
  }
  const trailing = source.slice(block.start, block.end).endsWith('\r\n') ? '\r\n' : '\n';
  return [
    {
      from: block.start,
      to: block.end,
      insert: `${serializeGraphBlock(removal.graph, ending)}${trailing}`,
    },
  ];
}

export function markerRemovalSplices(source: string, removal: GraphRemoval): Splice[] {
  return removal.drop.flatMap((entry) => {
    let from = entry.range.start;
    while (from > 0) {
      const char = source[from - 1];
      if (char !== ' ' && char !== '\t') break;
      from -= 1;
    }
    return [{ from, to: entry.range.end, insert: '' }];
  });
}

export function mergeGraphSplice(
  source: string,
  doc: Document,
  edges: GraphEdge[],
  groups: GraphGroup[],
  ending: string,
): Splice {
  const merged: GraphData = {
    edges: [...doc.graph.edges, ...edges],
    groups: [...doc.graph.groups, ...groups],
    block: doc.graph.block,
  };
  if (doc.conventionIssues.some((issue) => issue.code === 'E_GRAPH')) {
    throw new EditError('E_SHAPE', 'The document graph metadata is invalid');
  }
  if (doc.graph.block === null) {
    const append = appendGraphSplice(source, merged, ending);
    if (append === null) throw new EditError('E_SHAPE', 'The graph metadata is empty');
    return append;
  }
  const original = source.slice(doc.graph.block.start, doc.graph.block.end);
  const trailing = original.endsWith('\r\n') ? '\r\n' : original.endsWith('\n') ? '\n' : '';
  return {
    from: doc.graph.block.start,
    to: doc.graph.block.end,
    insert: `${serializeGraphBlock(merged, ending)}${trailing}`,
  };
}

export function appendGraphSplice(source: string, graph: GraphData, ending: string): Splice | null {
  const block = serializeGraphBlock(graph, ending);
  if (!block) return null;
  const prefix = source.length === 0 ? '' : source.endsWith(ending) ? ending : ending + ending;
  const insert = `${prefix}${block}${ending}`;
  return { from: source.length, to: source.length, insert };
}

function removeGraphSplice(source: string, block: Range): Splice {
  let start = block.start;
  let end = block.end;
  if (source.startsWith('\r\n', end)) end += 2;
  else if (source[end] === '\n') end += 1;
  if (start > 0) {
    const previous = source.lastIndexOf('\n', start - 2);
    const previousStart = previous === -1 ? 0 : previous + 1;
    if (source.slice(previousStart, start).trim() === '') start = previousStart;
  }
  return { from: start, to: end, insert: '' };
}
