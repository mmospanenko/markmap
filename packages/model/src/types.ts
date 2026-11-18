import type { SourceRange } from '@markmap/core';

export interface Range {
  start: number;
  end: number;
}

export type NodeKind = 'root' | 'heading' | 'listItem' | 'opaque';

export type RootKind = 'source-heading' | 'title' | 'synthetic';

export interface RootPolicy {
  kind: RootKind;
  hasTitle: boolean;
  bodyStart: number;
  hasHeadingChild: boolean;
  canCreateHeading: boolean;
}

export interface DocumentMeta {
  hasTitle: boolean;
  bodyStart: number;
  htmlBlocks?: HtmlBlockSource[];
  frontmatterRange?: SourceRange | null;
}

export interface ListInfo {
  ordered: boolean;
  marker: string;
  indent: string;
  checked: boolean | null;
}

export interface Capabilities {
  editLabel: boolean;
  editNotes: boolean;
  addChild: boolean;
  addSibling: boolean;
  outdent: boolean;
  delete: boolean;
  move: boolean;
  toggleCheck: boolean;
}

export interface NoteRange {
  range: Range;
  fence: boolean;
}

export interface NodeIdentity {
  id: string;
  range: Range | null;
}

export interface HtmlBlockSource {
  range: Range;
  value: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label: string | null;
}

export interface GraphGroup {
  roots: string[];
  label: string | null;
}

export interface GraphData {
  edges: GraphEdge[];
  groups: GraphGroup[];
  block: Range | null;
}

export type RandomSource = () => number;

export interface EditNode {
  id: string;
  kind: NodeKind;
  parent: string | null;
  children: string[];
  level: number;
  label: Range | null;
  block: Range | null;
  list: ListInfo | null;
  notes: NoteRange[];
  identity: NodeIdentity | null;
  opaque: boolean;
  capabilities: Capabilities;
}

export interface Document {
  source: string;
  root: string;
  nodes: Map<string, EditNode>;
  order: string[];
  unit: string;
  rootPolicy: RootPolicy;
  identities: Map<string, string>;
  graph: GraphData;
  conventionIssues: Issue[];
  frontmatterRange: SourceRange | null;
}

export type IssueCode =
  | 'E_ROOT'
  | 'E_KIND'
  | 'E_PARENT'
  | 'E_ORDER'
  | 'E_RANGE'
  | 'E_LABEL'
  | 'E_LEVEL'
  | 'E_INDENT'
  | 'E_SLICE'
  | 'E_CYCLE'
  | 'E_IDENTITY'
  | 'E_GRAPH';

export interface Issue {
  code: IssueCode;
  message: string;
  nodeId?: string;
  range?: Range;
}
