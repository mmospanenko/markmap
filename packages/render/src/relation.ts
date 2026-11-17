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
import {
  relationAnchorCandidates,
  routeRelationGeometry,
  type RelationRouteGeometry,
} from './relation-geometry';
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
  const arrowD = arrowPathData(p3, angle);

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

const ROUTE_CACHE_LIMIT = 256;
const routeCache = new Map<string, RelationRouteGeometry>();

export function renderRelationEdges({
  edges,
  identities,
  nodesById,
  rootId,
  folded,
  theme,
}: RenderRelationParams): Primitive[] {
  const primitives: Primitive[] = [];
  const visibleNodes = [...nodesById.values()];
  const obstacleKey = visibleNodes
    .map((node) => {
      const { x, y, width, height } = node.rect;
      return `${node.node.id},${x},${y},${width},${height}`;
    })
    .join(';');

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

    const sourceAnchors = relationAnchorCandidates(source.rect, (side) =>
      theme.node.anchor(source.rect, side, source.ctx),
    );
    const targetAnchors = relationAnchorCandidates(target.rect, (side) =>
      theme.node.anchor(target.rect, side, target.ctx),
    );
    const obstacles = visibleNodes
      .filter((node) => node.node.id !== sourceNodeId && node.node.id !== targetNodeId)
      .map((node) => node.rect);
    const anchorKey = [...sourceAnchors, ...targetAnchors]
      .map((anchor) => `${anchor.side},${anchor.x},${anchor.y}`)
      .join(';');
    const cacheKey = `${edge.from},${edge.to}|${obstacleKey}|${anchorKey}`;
    const cached = routeCache.get(cacheKey);
    let geometry: RelationRouteGeometry;
    if (cached) {
      routeCache.delete(cacheKey);
      routeCache.set(cacheKey, cached);
      geometry = cached;
    } else {
      geometry = routeRelationGeometry(
        { rect: source.rect, anchors: sourceAnchors },
        { rect: target.rect, anchors: targetAnchors },
        obstacles,
      );
      routeCache.set(cacheKey, geometry);
      if (routeCache.size > ROUTE_CACHE_LIMIT) {
        const oldest = routeCache.keys().next().value;
        if (oldest !== undefined) routeCache.delete(oldest);
      }
    }
    const arrowD = arrowPathData(geometry.p3, geometry.angle);

    const curvePath: PathPrimitive = {
      kind: 'path',
      d: geometry.d,
      stroke: 'var(--mm-edge-relation, #8c959f)',
      strokeWidth: 1.5,
      strokeDashArray: [5, 4],
    };

    const hitPath: PathPrimitive = {
      kind: 'path',
      d: geometry.d,
      stroke: 'transparent',
      strokeWidth: 10,
    };

    const hitGroup = {
      kind: 'group' as const,
      key: `relation-hit:${edge.from}:${edge.to}`,
      bounds: expandBounds(geometry.bounds, 6),
      children: [hitPath],
    };

    const arrowPath: PathPrimitive = {
      kind: 'path',
      d: arrowD,
      fill: 'var(--mm-edge-relation, #8c959f)',
    };

    const children: Primitive[] = [curvePath, hitGroup, arrowPath];
    let labelBounds: Rect | undefined;

    if (edge.label && edge.label.length > 0) {
      const labelText = edge.label;
      const labelWidth = Math.max(28, labelText.length * 7 + 14);
      const labelHeight = 20;
      labelBounds = {
        x: geometry.midX - labelWidth / 2,
        y: geometry.midY - labelHeight / 2,
        width: labelWidth,
        height: labelHeight,
      };
      const rect: RectPrimitive = {
        kind: 'rect',
        x: labelBounds.x,
        y: labelBounds.y,
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
            x: geometry.midX - (labelText.length * 7) / 2,
            y: geometry.midY + 4,
            font: SYSTEM_FONT,
            fill: 'var(--mm-edge-relation-label, #57606a)',
          },
        ],
      };
      children.push(rect, text);
    }

    const bounds = expandBounds(
      labelBounds ? unionBounds(geometry.bounds, labelBounds) : geometry.bounds,
      12,
    );

    const relation: Primitive = {
      kind: 'group',
      key: `relation:${edge.from}:${edge.to}`,
      bounds,
      children,
    };
    const midpointBounds: Rect = {
      x: geometry.midX - 0.5,
      y: geometry.midY - 0.5,
      width: 1,
      height: 1,
    };
    const midpoint = {
      kind: 'group' as const,
      key: `relation-midpoint:${edge.from}:${edge.to}`,
      bounds: midpointBounds,
      children: [
        {
          kind: 'rect' as const,
          x: midpointBounds.x,
          y: midpointBounds.y,
          w: midpointBounds.width,
          h: midpointBounds.height,
          fill: 'none',
        },
      ],
    };
    primitives.push(relation, midpoint);
  }

  return primitives;
}

function arrowPathData(p3: Anchor, angle: number): string {
  const baseX = p3.x - 8 * Math.cos(angle);
  const baseY = p3.y - 8 * Math.sin(angle);
  const w1X = baseX - 4 * Math.sin(angle);
  const w1Y = baseY + 4 * Math.cos(angle);
  const w2X = baseX + 4 * Math.sin(angle);
  const w2Y = baseY - 4 * Math.cos(angle);
  return `M${p3.x},${p3.y}L${w1X},${w1Y}L${w2X},${w2Y}Z`;
}

function expandBounds(rect: Rect, padding: number): Rect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}

function unionBounds(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}
