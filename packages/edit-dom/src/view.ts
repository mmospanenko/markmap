import type { Markmap } from '@markmap/view';
import type { EditView } from './types';

export function createEditView(mm: Markmap): EditView {
  return {
    element: mm.element,
    get scale() {
      return mm.transform.k;
    },
    get foldedIds() {
      return mm.foldedIds;
    },
    setTree: (root) => mm.setTree(root),
    setFolded: (id, folded) => mm.setFolded(id, folded),
    setFoldedIds: (ids, options) => mm.setFoldedIds(ids, options),
    toggle: (id) => mm.toggle(id),
    focusNode: (id, options) => mm.focusNode(id, options),
    screenRect: (id) => mm.screenRect(id),
    direction: (id) => mm.result?.layout.byId.get(id)?.direction,
    hitAt: (x, y) => mm.hitAt(x, y),
    layoutPoint: (x, y) => mm.layoutPoint(x, y),
    on: (type, listener) => mm.on(type, listener),
  };
}
