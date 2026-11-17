import { resolveLabelStyle } from '@markmap/core';
import { resolvePaint, themeTokens } from '@markmap/render';
import type { Markmap } from '@markmap/view';
import { select } from 'd3-selection';
import type { EditLabelStyle, EditView } from './types';

const darkMode = (scheme: string | undefined): boolean => {
  if (scheme === 'dark') return true;
  if (scheme !== 'auto') return false;
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
};

export function createEditView(mm: Markmap): EditView {
  return {
    element: mm.element,
    get scale() {
      return mm.transform.k;
    },
    get transform() {
      return { k: mm.transform.k, x: mm.transform.x, y: mm.transform.y };
    },
    panBy: (dx, dy) => {
      const { k } = mm.transform;
      mm.zoomBehavior.transform(select(mm.element), mm.transform.translate(dx / k, dy / k));
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
    groupScreenRect: (id) => mm.groupScreenRect(id),
    direction: (id) => mm.result?.layout.byId.get(id)?.direction,
    labelStyle: (id): EditLabelStyle | undefined => {
      const result = mm.result;
      const ctx = result?.contexts?.get(id);
      const node = result?.state?.nodes.find((item) => item.node.id === id)?.node;
      if (!result || !ctx || !node) return undefined;
      const label = resolveLabelStyle(result.theme, node, ctx);
      const tokens = themeTokens(result.theme, darkMode(mm.options.colorScheme) ? 'dark' : 'light');
      return {
        ...label,
        fill: resolvePaint(label.fill, tokens) ?? label.fill,
        align: result.theme.node.textAlign?.(ctx) ?? 'start',
      };
    },
    hitAt: (x, y) => mm.hitAt(x, y),
    layoutPoint: (x, y) => mm.layoutPoint(x, y),
    on: (type, listener) => mm.on(type, listener),
  };
}
