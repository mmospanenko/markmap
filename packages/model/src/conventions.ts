import { parse as parseYaml } from 'yaml';
import { lineEnd, lineStart } from './source';
import type {
  Document,
  EditNode,
  GraphData,
  GraphEdge,
  GraphGroup,
  HtmlBlockSource,
  Issue,
  IssueCode,
  NodeIdentity,
  RandomSource,
  Range,
} from './types';

const IDENTITY_COMMENT = /<!--[ \t]*\^([\s\S]*?)-->/g;
const GRAPH_ANY = /<!--[ \t]*markmap:[ \t]*graph\b/g;
const GRAPH_START = /^<!--[ \t]*markmap:[ \t]*graph(?=[ \t\r\n]|-->)/;
const ID = /^[A-Za-z0-9]{1,3}$/;
const REF = /^(?:root|[A-Za-z0-9]{1,3})$/;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const UNSAFE = /<!--|-->/;

export interface Conventions {
  identities: Map<string, string>;
  graph: GraphData;
  issues: Issue[];
}

type GraphParse =
  | { ok: true; edges: GraphEdge[]; groups: GraphGroup[] }
  | { ok: false; message: string };

class GraphShapeError extends Error {}

function emptyGraph(block: Range | null): GraphData {
  return { edges: [], groups: [], block };
}

function addIssue(
  issues: Issue[],
  code: IssueCode,
  message: string,
  range?: Range,
  nodeId?: string,
): void {
  const issue: Issue = { code, message };
  if (range !== undefined) issue.range = range;
  if (nodeId !== undefined) issue.nodeId = nodeId;
  issues.push(issue);
}

export function readConventions(
  source: string,
  nodes: Map<string, EditNode>,
  order: string[],
  rootId: string,
  bodyStart: number,
  htmlBlocks: HtmlBlockSource[],
): Conventions {
  const issues: Issue[] = [];
  const graphRead = readGraph(source, htmlBlocks, issues);
  const identityRead = readIdentities(
    source,
    nodes,
    order,
    rootId,
    bodyStart,
    graphRead.graph.block,
    issues,
  );
  for (const node of nodes.values()) {
    node.identity = identityRead.markers.get(node.id) ?? null;
  }
  validateGraph(graphRead.graph, graphRead.valid, identityRead.identities, nodes, rootId, issues);
  return { identities: identityRead.identities, graph: graphRead.graph, issues };
}

export function validateConventions(doc: Document): Issue[] {
  return [...doc.conventionIssues];
}

function issueKey(issue: Issue): string {
  return `${issue.code}|${issue.message}|${issue.nodeId ?? ''}|${issue.range?.start ?? ''}|${issue.range?.end ?? ''}`;
}

export function newConventionIssues(before: Document, after: Document): Issue[] {
  const known = new Set(before.conventionIssues.map(issueKey));
  return after.conventionIssues.filter((issue) => !known.has(issueKey(issue)));
}

function isGraphBlock(block: HtmlBlockSource): boolean {
  return GRAPH_START.test(block.value.trimStart());
}

function graphOccurrences(source: string): number[] {
  const starts: number[] = [];
  GRAPH_ANY.lastIndex = 0;
  let match: RegExpExecArray | null = GRAPH_ANY.exec(source);
  while (match !== null) {
    starts.push(match.index);
    match = GRAPH_ANY.exec(source);
  }
  return starts;
}

function readGraph(
  source: string,
  htmlBlocks: HtmlBlockSource[],
  issues: Issue[],
): { graph: GraphData; valid: boolean } {
  const candidates = htmlBlocks.filter(isGraphBlock);
  const occurrences = graphOccurrences(source);
  if (candidates.length > 1) {
    for (const extra of candidates.slice(1)) {
      addIssue(issues, 'E_GRAPH', 'The document has more than one graph block', extra.range);
    }
    const known = new Set(candidates.map((candidate) => candidate.range.start));
    for (const start of occurrences) {
      if (!known.has(start)) {
        addIssue(issues, 'E_GRAPH', 'The graph block must be a single root-level block', {
          start,
          end: start,
        });
      }
    }
    return { graph: emptyGraph(candidates[0].range), valid: false };
  }
  if (candidates.length === 0) {
    for (const start of occurrences) {
      addIssue(issues, 'E_GRAPH', 'The graph block must be a root-level HTML block', {
        start,
        end: start,
      });
    }
    return { graph: emptyGraph(null), valid: occurrences.length === 0 };
  }
  const candidate = candidates[0];
  const known = new Set([candidate.range.start]);
  for (const start of occurrences) {
    if (!known.has(start)) {
      addIssue(issues, 'E_GRAPH', 'The document has more than one graph block', {
        start,
        end: start,
      });
    }
  }
  const parsed = parseGraphBlock(candidate.value);
  if (!parsed.ok) {
    addIssue(issues, 'E_GRAPH', parsed.message, candidate.range);
    return { graph: emptyGraph(candidate.range), valid: false };
  }
  return {
    graph: { edges: parsed.edges, groups: parsed.groups, block: candidate.range },
    valid: true,
  };
}

function parseGraphBlock(value: string): GraphParse {
  const text = value.trim();
  if (!text.endsWith('-->')) {
    return { ok: false, message: 'The graph block is not a closed HTML comment' };
  }
  const open = text.indexOf('graph') + 'graph'.length;
  const payload = text.slice(open, text.length - 3).trim();
  if (UNSAFE.test(payload)) {
    return {
      ok: false,
      message: 'Graph metadata cannot contain an HTML comment delimiter',
    };
  }
  if (!payload) return { ok: true, edges: [], groups: [] };
  let data: unknown;
  try {
    data = parseYaml(payload);
  } catch {
    return { ok: false, message: 'The graph metadata is not valid YAML' };
  }
  try {
    return { ok: true, ...readGraphData(data) };
  } catch (error) {
    if (error instanceof GraphShapeError) return { ok: false, message: error.message };
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new GraphShapeError(`${label} has an unknown field "${key}"`);
    }
  }
}

function readGraphData(value: unknown): { edges: GraphEdge[]; groups: GraphGroup[] } {
  if (value === null || value === undefined) return { edges: [], groups: [] };
  if (!isRecord(value)) throw new GraphShapeError('The graph metadata must be a mapping');
  assertKeys(value, ['edges', 'groups'], 'The graph metadata');
  const edges = readEdges(value['edges']);
  const groups = readGroups(value['groups']);
  return { edges, groups };
}

function readEdges(value: unknown): GraphEdge[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new GraphShapeError('The edges must be a sequence');
  return value.map((entry, index) => readEdge(entry, index));
}

function readEdge(value: unknown, index: number): GraphEdge {
  const label = `Edge ${index + 1}`;
  if (!isRecord(value)) throw new GraphShapeError(`${label} must be a mapping`);
  assertKeys(value, ['from', 'to', 'label'], label);
  return {
    from: readRef(value['from'], `${label} from`),
    to: readRef(value['to'], `${label} to`),
    label: readLabel(value['label'], label),
  };
}

function readGroups(value: unknown): GraphGroup[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new GraphShapeError('The groups must be a sequence');
  return value.map((entry, index) => readGroup(entry, index));
}

function readGroup(value: unknown, index: number): GraphGroup {
  const label = `Group ${index + 1}`;
  if (!isRecord(value)) throw new GraphShapeError(`${label} must be a mapping`);
  assertKeys(value, ['roots', 'label'], label);
  const roots = value['roots'];
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new GraphShapeError(`${label} must have at least one root`);
  }
  return {
    roots: roots.map((root, rootIndex) => readRef(root, `${label} root ${rootIndex + 1}`)),
    label: readLabel(value['label'], label),
  };
}

function readRef(value: unknown, label: string): string {
  if (typeof value !== 'string' || !REF.test(value)) {
    throw new GraphShapeError(`${label} must be root or a one-to-three character node id`);
  }
  return value;
}

function readLabel(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new GraphShapeError(`${label} label must be a string`);
  return value;
}

interface IdentityComment {
  start: number;
  end: number;
  payload: string;
  multiline: boolean;
}

function identityComments(source: string): IdentityComment[] {
  const comments: IdentityComment[] = [];
  IDENTITY_COMMENT.lastIndex = 0;
  let match: RegExpExecArray | null = IDENTITY_COMMENT.exec(source);
  while (match !== null) {
    const payload = match[1];
    if (payload !== undefined) {
      comments.push({
        start: match.index,
        end: match.index + match[0].length,
        payload: payload.trim(),
        multiline: /[\r\n]/.test(match[0]),
      });
    }
    match = IDENTITY_COMMENT.exec(source);
  }
  return comments;
}

function readIdentities(
  source: string,
  nodes: Map<string, EditNode>,
  order: string[],
  rootId: string,
  bodyStart: number,
  graphBlock: Range | null,
  issues: Issue[],
): { identities: Map<string, string>; markers: Map<string, NodeIdentity> } {
  const identities = new Map<string, string>();
  const markers = new Map<string, NodeIdentity>();
  identities.set('root', rootId);
  if (nodes.has(rootId)) markers.set(rootId, { id: 'root', range: null });

  const lineNodes = new Map<number, EditNode>();
  for (const id of order) {
    const node = nodes.get(id);
    if (node?.block) lineNodes.set(node.block.start, node);
  }
  const comments = identityComments(source);
  const lineCounts = new Map<number, number>();
  for (const comment of comments) {
    const line = lineStart(source, comment.start);
    lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1);
  }
  const reportedLines = new Set<number>();
  for (const comment of comments) {
    const range = { start: comment.start, end: comment.end };
    const line = lineStart(source, comment.start);
    const node = lineNodes.get(line);
    if (comment.multiline) {
      addIssue(issues, 'E_IDENTITY', 'A node identity marker must stay on one line', range);
      continue;
    }
    if (comment.start < bodyStart && node === undefined) {
      addIssue(issues, 'E_IDENTITY', 'A node identity cannot live in frontmatter', range);
      continue;
    }
    if (insideGraph(comment.start, graphBlock)) {
      addIssue(issues, 'E_GRAPH', 'A node identity cannot live in the graph block', range);
      continue;
    }
    const owner = insideNote(comment.start, nodes);
    if (owner !== undefined) {
      addIssue(
        issues,
        'E_IDENTITY',
        owner
          ? 'A node identity cannot live in a note fence'
          : 'A node identity cannot live in a note',
        range,
      );
      continue;
    }
    if (node !== undefined) {
      if ((lineCounts.get(line) ?? 0) > 1) {
        if (!reportedLines.has(line)) {
          addIssue(issues, 'E_IDENTITY', 'A node line can carry only one marker', range, node.id);
          reportedLines.add(line);
        }
        continue;
      }
      if (node.kind === 'root' && node.block) {
        addIssue(issues, 'E_IDENTITY', 'The root identity is reserved', range, node.id);
        continue;
      }
      if (!ID.test(comment.payload)) {
        addIssue(
          issues,
          'E_IDENTITY',
          'A node identity is one to three alphanumeric characters',
          range,
          node.id,
        );
        continue;
      }
      if (!isFinalToken(source, comment)) {
        addIssue(
          issues,
          'E_IDENTITY',
          'A node identity marker must be the last token on the node line',
          range,
          node.id,
        );
        continue;
      }
      const identity: NodeIdentity = { id: comment.payload, range };
      markers.set(node.id, identity);
      if (identities.has(comment.payload)) {
        addIssue(
          issues,
          'E_IDENTITY',
          `The node identity "${comment.payload}" is declared more than once`,
          range,
          node.id,
        );
      } else {
        identities.set(comment.payload, node.id);
      }
      continue;
    }
    if (insideNode(comment.start, nodes)) {
      addIssue(issues, 'E_IDENTITY', 'A node identity must be on its own node line', range);
      continue;
    }
    addIssue(issues, 'E_IDENTITY', 'A node identity cannot stand alone', range);
  }
  return { identities, markers };
}

function isFinalToken(source: string, comment: IdentityComment): boolean {
  return source.slice(comment.end, lineEnd(source, comment.start)).trim() === '';
}

function insideGraph(offset: number, block: Range | null): boolean {
  return block !== null && offset >= block.start && offset < block.end;
}

function insideNote(offset: number, nodes: Map<string, EditNode>): boolean | undefined {
  for (const node of nodes.values()) {
    for (const note of node.notes) {
      if (offset >= note.range.start && offset < note.range.end) return note.fence;
    }
  }
  return undefined;
}

function insideNode(offset: number, nodes: Map<string, EditNode>): boolean {
  for (const node of nodes.values()) {
    if (node.block && offset >= node.block.start && offset < node.block.end) return true;
  }
  return false;
}

function validateGraph(
  graph: GraphData,
  valid: boolean,
  identities: Map<string, string>,
  nodes: Map<string, EditNode>,
  rootId: string,
  issues: Issue[],
): void {
  if (!valid) return;
  const resolve = (ref: string): string | undefined =>
    ref === 'root' ? rootId : identities.get(ref);
  for (const edge of graph.edges) {
    if (resolve(edge.from) === undefined) {
      addIssue(issues, 'E_GRAPH', `The edge endpoint "${edge.from}" has no node`);
    }
    if (resolve(edge.to) === undefined) {
      addIssue(issues, 'E_GRAPH', `The edge endpoint "${edge.to}" has no node`);
    }
  }
  const seenRoots = new Set<string>();
  const subtrees: Set<string>[] = [];
  for (const group of graph.groups) {
    if (new Set(group.roots).size !== group.roots.length) {
      addIssue(issues, 'E_GRAPH', 'A group repeats one of its roots');
    }
    const subtree = new Set<string>();
    for (const root of group.roots) {
      if (seenRoots.has(root)) {
        addIssue(issues, 'E_GRAPH', `The group root "${root}" is repeated across groups`);
      } else {
        seenRoots.add(root);
      }
      const id = resolve(root);
      if (id === undefined) {
        addIssue(issues, 'E_GRAPH', `The group root "${root}" has no node`);
        continue;
      }
      for (const descendant of descendants(nodes, id)) subtree.add(descendant);
    }
    subtrees.push(subtree);
  }
  for (let left = 0; left < subtrees.length; left += 1) {
    for (let right = left + 1; right < subtrees.length; right += 1) {
      const a = subtrees[left];
      const b = subtrees[right];
      if ([...a].some((id) => b.has(id))) {
        addIssue(issues, 'E_GRAPH', 'Group subtrees overlap');
      }
    }
  }
  if (issues.some((issue) => issue.code === 'E_GRAPH')) return;
  const referenced = new Set<string>();
  for (const edge of graph.edges) {
    referenced.add(edge.from);
    referenced.add(edge.to);
  }
  for (const group of graph.groups) {
    for (const root of group.roots) referenced.add(root);
  }
  for (const id of nodes.keys()) {
    const node = nodes.get(id);
    const identity = node?.identity;
    if (!identity || identity.range === null) continue;
    if (!referenced.has(identity.id)) {
      addIssue(
        issues,
        'E_IDENTITY',
        `The node identity "${identity.id}" is not referenced by an edge or a group`,
        identity.range,
        id,
      );
    }
  }
}

function descendants(nodes: Map<string, EditNode>, id: string): Set<string> {
  const result = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    result.add(current);
    const node = nodes.get(current);
    if (node) for (const child of node.children) stack.push(child);
  }
  return result;
}

export function mintIdentity(taken: ReadonlySet<string>, random: RandomSource): string | null {
  for (const length of [1, 2, 3]) {
    const total = ALPHABET.length ** length;
    const draw = Math.min(Math.max(random(), 0), 0.9999999999999999);
    const start = Math.floor(draw * total);
    for (let offset = 0; offset < total; offset += 1) {
      const candidate = encodeIdentity((start + offset) % total, length);
      if (!taken.has(candidate)) return candidate;
    }
  }
  return null;
}

function encodeIdentity(index: number, length: number): string {
  let value = index;
  let result = '';
  for (let position = 0; position < length; position += 1) {
    result = `${ALPHABET[value % ALPHABET.length]}${result}`;
    value = Math.floor(value / ALPHABET.length);
  }
  return result;
}

export function serializeGraphBlock(
  graph: Pick<GraphData, 'edges' | 'groups'>,
  ending: string,
): string {
  if (graph.edges.length === 0 && graph.groups.length === 0) return '';
  const lines = ['<!-- markmap: graph'];
  if (graph.edges.length > 0) {
    lines.push('edges:');
    for (const edge of graph.edges) {
      lines.push(`  - from: ${JSON.stringify(edge.from)}`);
      lines.push(`    to: ${JSON.stringify(edge.to)}`);
      if (edge.label !== null) lines.push(`    label: ${JSON.stringify(edge.label)}`);
    }
  }
  if (graph.groups.length > 0) {
    lines.push('groups:');
    for (const group of graph.groups) {
      lines.push(`  - roots: [${group.roots.map((root) => JSON.stringify(root)).join(', ')}]`);
      if (group.label !== null) lines.push(`    label: ${JSON.stringify(group.label)}`);
    }
  }
  lines.push('-->');
  return lines.join(ending);
}
