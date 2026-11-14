export type EditErrorCode =
  | 'E_NODE'
  | 'E_CAPABILITY'
  | 'E_LABEL'
  | 'E_SPLICE'
  | 'E_SHAPE'
  | 'E_LEVEL'
  | 'E_INDENT';

export class EditError extends Error {
  code: EditErrorCode;
  nodeId?: string;

  constructor(code: EditErrorCode, message: string, nodeId?: string) {
    super(message);
    this.name = 'EditError';
    this.code = code;
    if (nodeId) this.nodeId = nodeId;
  }
}
