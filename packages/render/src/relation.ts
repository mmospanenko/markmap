import type {
  Anchor,
  GraphEdge,
  PathPrimitive,
  Point,
  Primitive,
  Rect,
  RectPrimitive,
  Side,
  TextPrimitive,
  Theme,
} from '@markmap/core';
import type { DrawNode } from './render';
import { SYSTEM_FONT } from './themes/shared';

export interface RelationCurve {
  p0: Point;
  p1: Point;
  p2: Point;
  p3: Point;
  d: string;
  arrowD: string;
  midX: number;
  midY: number;
  angle: number;
}

export function sideVector(side: Side): Point {
  if (side === 'left') return { x: -1, y: 0 };
  if (side === 'right') return { x: 1, y: 0 };
  if (side === 'top') return { x: 0, y: -1 };
  return { x: 0, y: 1 };
}

export function computeRelationCurve(
  p0: Anchor,
  p3: Anchor,
  srcSide: Side,
  tgtSide: Side,
): RelationCurve {
  const dist = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  const offset = Math.max(30, Math.min(dist * 0.4, 150));
  const v0 = sideVector(srcSide);
  const v3 = sideVector(tgtSide);
  const p1: Point = { x: p0.x + v0.x * offset, y: p0.y + v0.y * offset };
  const p2: Point = { x: p3.x + v3.x * offset, y: p3.y + v3.y * offset };
  const d = `M${p0.x},${p0.y}C${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`;

  let tanX = p3.x - p2.x;
  let tanY = p3.y - p2.y;
  if (Math.hypot(tanX, tanY) === 0) {
    tanX = p3.x - p0.x;
    tanY = p3.y - p0.y;
  }
  const angle = Math.atan2(tanY, tanX);
  const baseX = p3.x - 8 * Math.cos(angle);
  const baseY = p3.y - 8 * Math.sin(angle);
  const w1X = baseX - 4 * Math.sin(angle);
  const w1Y = baseY + 4 * Math.cos(angle);
  const w2X = baseX + 4 * Math.sin(angle);
  const w2Y = baseY - 4 * Math.cos(angle);
  const arrowD = `M${p3.x},${p3.y}L${w1X},${w1Y}L${w2X},${w2Y}Z`;

  const midX = 0.125 * p0.x + 0.375 * p1.x + 0.375 * p2.x + 0.125 * p3.x;
  const midY = 0.125 * p0.y + 0.375 * p1.y + 0.375 * p2.y + 0.125 * p3.y;

  return { p0, p1, p2, p3, d, arrowD, midX, midY, angle };
}

export interface RenderRelationParams {
  edges: readonly GraphEdge[];
  identities?: ReadonlyMap<string, string>;
  nodesById: ReadonlyMap<string, DrawNode>;
  rootId?: string;
  folded?: ReadonlySet<string>;
  theme: Theme;
}

export function renderRelationEdges({
  edges,
  identities,
  nodesById,
  rootId,
  folded,
  theme,
}: RenderRelationParams): Primitive[] {
  const primitives: Primitive[] = [];

  for (const edge of edges) {
    const sourceNodeId =
      edge.from === 'root' ? (rootId ?? '') : (identities?.get(edge.from) ?? edge.from);
    const targetNodeId =
      edge.to === 'root' ? (rootId ?? '') : (identities?.get(edge.to) ?? edge.to);

    if (folded?.has(sourceNodeId) || folded?.has(targetNodeId)) continue;

    const source = nodesById.get(sourceNodeId);
    const target = nodesById.get(targetNodeId);
    if (!source || !target) continue;
    if (source.ctx.folded || target.ctx.folded) continue;

    const srcCenter = {
      x: source.rect.x + source.rect.width / 2,
      y: source.rect.y + source.rect.height / 2,
    };
    const tgtCenter = {
      x: target.rect.x + target.rect.width / 2,
      y: target.rect.y + target.rect.height / 2,
    };
    const dx = tgtCenter.x - srcCenter.x;
    const dy = tgtCenter.y - srcCenter.y;

    let srcSide: Side;
    let tgtSide: Side;
    if (Math.abs(dx) >= Math.abs(dy)) {
      srcSide = dx >= 0 ? 'right' : 'left';
      tgtSide = dx >= 0 ? 'left' : 'right';
    } else {
      srcSide = dy >= 0 ? 'bottom' : 'top';
      tgtSide = dy >= 0 ? 'top' : 'bottom';
    }

    const p0 = theme.node.anchor(source.rect, srcSide, source.ctx);
    const p3 = theme.node.anchor(target.rect, tgtSide, target.ctx);
    const curve = computeRelationCurve(p0, p3, srcSide, tgtSide);

    const curvePath: PathPrimitive = {
      kind: 'path',
      d: curve.d,
      stroke: 'var(--mm-edge-relation, #8c959f)',
      strokeWidth: 1.5,
    };

    const arrowPath: PathPrimitive = {
      kind: 'path',
      d: curve.arrowD,
      fill: 'var(--mm-edge-relation, #8c959f)',
    };

    const children: Primitive[] = [curvePath, arrowPath];

    if (edge.label && edge.label.length > 0) {
      const labelText = edge.label;
      const labelWidth = Math.max(28, labelText.length * 7 + 14);
      const labelHeight = 20;
      const rect: RectPrimitive = {
        kind: 'rect',
        x: curve.midX - labelWidth / 2,
        y: curve.midY - labelHeight / 2,
        w: labelWidth,
        h: labelHeight,
        r: 4,
        fill: 'var(--mm-bg, #ffffff)',
        stroke: 'var(--mm-edge-relation, #8c959f)',
        strokeWidth: 1,
      };
      const text: TextPrimitive = {
        kind: 'text',
        x: 0,
        y: 0,
        runs: [
          {
            text: labelText,
            x: curve.midX - (labelText.length * 7) / 2,
            y: curve.midY + 4,
            font: SYSTEM_FONT,
            fill: 'var(--mm-edge-relation-label, #57606a)',
          },
        ],
      };
      children.push(rect, text);
    }

    const minX = Math.min(p0.x, p3.x, curve.midX - 30);
    const minY = Math.min(p0.y, p3.y, curve.midY - 15);
    const maxX = Math.max(p0.x, p3.x, curve.midX + 30);
    const maxY = Math.max(p0.y, p3.y, curve.midY + 15);
    const bounds: Rect = {
      x: minX - 10,
      y: minY - 10,
      width: maxX - minX + 20,
      height: maxY - minY + 20,
    };

    primitives.push({
      kind: 'group',
      key: `relation:${edge.from}:${edge.to}`,
      bounds,
      children,
    });
  }

  return primitives;
}
