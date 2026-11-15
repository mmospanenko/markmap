export interface Range {
  start: number;
  end: number;
}

export type NodeKind = 'root' | 'heading' | 'listItem' | 'opaque';

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
  opaque: boolean;
  capabilities: Capabilities;
}

export interface Document {
  source: string;
  root: string;
  nodes: Map<string, EditNode>;
  order: string[];
  unit: string;
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
  | 'E_CYCLE';

export interface Issue {
  code: IssueCode;
  message: string;
  nodeId?: string;
}
