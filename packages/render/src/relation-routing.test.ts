import type { Point, Rect } from '@markmap/core';
import { parse } from '@markmap/parse';
import { describe, expect, it } from 'vitest';
import { approximateMeasurer, classicTheme, renderTree } from '.';
import { renderRelationEdges } from './relation';
import { relationAnchorCandidates, routeRelationGeometry } from './relation-geometry';

function drawRelation(
  sourceRect: Rect,
  obstacleRect: Rect,
  targetRect: Rect,
  label: string | null = null,
  rootRect: Rect = { x: -300, y: -300, width: 40, height: 20 },
) {
  const result = drawRelations(sourceRect, [obstacleRect], targetRect, label, rootRect);
  const primaryObstacle = result.obstacleRects[0];
  if (!primaryObstacle) throw new Error('Obstacle missing');
  return { ...result, obstacleRect: primaryObstacle };
}

function drawRelations(
  sourceRect: Rect,
  obstacleRects: readonly Rect[],
  targetRect: Rect,
  label: string | null = null,
  rootRect: Rect = { x: -300, y: -300, width: 40, height: 20 },
) {
  const markdown = [
    '# Root',
    '',
    '- Source',
    ...obstacleRects.map((_, index) => `- Obstacle ${index + 1}`),
    '- Target',
  ].join('\n');
  const tree = parse(markdown).root;
  const sourceNode = tree.children[0];
  const targetNode = tree.children.at(-1);
  const obstacleNodes = tree.children.slice(1, -1);
  if (!sourceNode || !targetNode || obstacleNodes.length !== obstacleRects.length) {
    throw new Error('Nodes missing');
  }

  const base = renderTree(tree, { measurer: approximateMeasurer });
  const rectangles = new Map<string, Rect>([
    [sourceNode.id, sourceRect],
    [targetNode.id, targetRect],
    [tree.id, rootRect],
  ]);
  for (const [index, node] of obstacleNodes.entries()) {
    const rect = obstacleRects[index];
    if (rect) rectangles.set(node.id, rect);
  }
  const nodes = base.state.nodes.map((node) => ({
    ...node,
    rect: rectangles.get(node.node.id) ?? node.rect,
  }));
  const nodesById = new Map(nodes.map((node) => [node.node.id, node]));
  const primitives = renderRelationEdges({
    edges: [{ from: 'source', to: 'target', label }],
    identities: new Map([
      ['source', sourceNode.id],
      ['target', targetNode.id],
    ]),
    nodesById,
    rootId: tree.id,
    theme: classicTheme,
  });
  const relation = primitives.find(
    (primitive) => primitive.kind === 'group' && primitive.key === 'relation:source:target',
  );
  if (!relation || relation.kind !== 'group') throw new Error('Relation missing');
  const shaft = relation.children.find((child) => child.kind === 'path');
  if (!shaft || shaft.kind !== 'path') throw new Error('Shaft missing');

  return { relation, shaft, sourceRect, obstacleRects, targetRect, primitives };
}

function samplePath(d: string, steps = 120): Point[] {
  const points: Point[] = [];
  let current: Point = { x: 0, y: 0 };

  for (const [, command, raw] of d.matchAll(/([MLC])([^MLC]*)/g)) {
    const values = raw.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
    if (command === 'M' || command === 'L') {
      const x = values[0];
      const y = values[1];
      if (x === undefined || y === undefined) continue;
      current = { x, y };
      points.push(current);
      continue;
    }
    const [x1, y1, x2, y2, x3, y3] = values;
    if (
      x1 === undefined ||
      y1 === undefined ||
      x2 === undefined ||
      y2 === undefined ||
      x3 === undefined ||
      y3 === undefined
    ) {
      continue;
    }
    const start = current;
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      const u = 1 - t;
      points.push({
        x: u ** 3 * start.x + 3 * u ** 2 * t * x1 + 3 * u * t ** 2 * x2 + t ** 3 * x3,
        y: u ** 3 * start.y + 3 * u ** 2 * t * y1 + 3 * u * t ** 2 * y2 + t ** 3 * y3,
      });
    }
    current = { x: x3, y: y3 };
  }

  return points;
}

function entersRect(point: Point, rect: Rect, padding = 0): boolean {
  return (
    point.x > rect.x - padding &&
    point.x < rect.x + rect.width + padding &&
    point.y > rect.y - padding &&
    point.y < rect.y + rect.height + padding
  );
}

function midpoint(points: readonly Point[]): Point | undefined {
  let totalLength = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous && current)
      totalLength += Math.hypot(current.x - previous.x, current.y - previous.y);
  }

  let travelled = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) continue;
    const length = Math.hypot(current.x - previous.x, current.y - previous.y);
    if (travelled + length >= totalLength / 2) {
      const ratio = length > 0 ? (totalLength / 2 - travelled) / length : 0;
      return {
        x: previous.x + (current.x - previous.x) * ratio,
        y: previous.y + (current.y - previous.y) * ratio,
      };
    }
    travelled += length;
  }
  return points.at(-1);
}

function crossings(points: readonly Point[], rects: readonly Rect[]): Rect[] {
  return rects.filter((rect) => points.some((point) => entersRect(point, rect)));
}

function lengthInside(points: readonly Point[], rect: Rect): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (!start || !end) continue;
    const segmentLength = Math.hypot(end.x - start.x, end.y - start.y);
    for (let step = 0; step < 20; step += 1) {
      const ratio = (step + 0.5) / 20;
      const point = {
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio,
      };
      if (entersRect(point, rect)) length += segmentLength / 20;
    }
  }
  return length;
}

function routeAnchors(rect: Rect) {
  return relationAnchorCandidates(rect, (side) => {
    if (side === 'left') return { x: rect.x, y: rect.y + rect.height / 2, side };
    if (side === 'right') return { x: rect.x + rect.width, y: rect.y + rect.height / 2, side };
    if (side === 'top') return { x: rect.x + rect.width / 2, y: rect.y, side };
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height, side };
  });
}

describe('relationship routing geometry', () => {
  it('[TC-2-31-6] chooses off-center boundary contacts for a clear direct route', () => {
    const result = drawRelation(
      { x: 0, y: 0, width: 40, height: 40 },
      { x: 100, y: 18, width: 40, height: 24 },
      { x: 200, y: 0, width: 40, height: 40 },
    );
    const points = samplePath(result.shaft.d);
    const start = points[0];
    const end = points.at(-1);
    if (!start || !end) throw new Error('Route points missing');

    expect(start.y).toBe(0);
    expect(end.y).toBe(0);
    expect(points.some((point) => entersRect(point, result.obstacleRect, 8))).toBe(false);
  });

  it('[TC-2-31-7] routes around a blocking node with deterministic clearance', () => {
    const input = [
      { x: 0, y: 0, width: 40, height: 40 },
      { x: 90, y: -100, width: 60, height: 260 },
      { x: 200, y: 0, width: 40, height: 40 },
    ] as const;
    const first = drawRelation(...input);
    const second = drawRelation(...input);
    const points = samplePath(first.shaft.d);
    const curves = first.shaft.d.match(/C/g) ?? [];

    expect(points.some((point) => entersRect(point, first.obstacleRect, 8))).toBe(false);
    expect(curves.length).toBeGreaterThan(1);
    expect(curves.length).toBeLessThanOrEqual(4);
    expect(second.shaft.d).toBe(first.shaft.d);
  });

  it('[TC-2-31-8] keeps the route outside both endpoint interiors after departure', () => {
    const result = drawRelation(
      { x: 0, y: 0, width: 40, height: 40 },
      { x: 90, y: -100, width: 60, height: 260 },
      { x: 200, y: 0, width: 40, height: 40 },
    );
    const points = samplePath(result.shaft.d);

    expect(points.slice(1).some((point) => entersRect(point, result.sourceRect, 0))).toBe(false);
    expect(points.slice(0, -1).some((point) => entersRect(point, result.targetRect, 0))).toBe(
      false,
    );
  });

  it('[TC-2-31-9] centers a relationship label on the routed path', () => {
    const result = drawRelation(
      { x: 0, y: 0, width: 40, height: 40 },
      { x: 90, y: -100, width: 60, height: 260 },
      { x: 200, y: 0, width: 40, height: 40 },
      'connects',
    );
    const label = result.relation.children.find((child) => child.kind === 'rect');
    if (!label || label.kind !== 'rect') throw new Error('Label background missing');

    const routeMiddle = midpoint(samplePath(result.shaft.d));
    if (!routeMiddle) throw new Error('Route midpoint missing');
    expect(label.x + label.w / 2).toBeCloseTo(routeMiddle.x, 0);
    expect(label.y + label.h / 2).toBeCloseTo(routeMiddle.y, 0);
  });

  it('[TC-2-31-10] minimizes crossed node interiors when no clear departure exists', () => {
    const wall = { x: -100, y: -100, width: 400, height: 240 };
    const innerObstacle = { x: 90, y: 10, width: 60, height: 20 };
    const result = drawRelation(
      { x: 0, y: 0, width: 40, height: 40 },
      wall,
      { x: 200, y: 0, width: 40, height: 40 },
      null,
      innerObstacle,
    );
    const points = samplePath(result.shaft.d);

    expect(points.some((point) => entersRect(point, wall))).toBe(true);
    expect(points.some((point) => entersRect(point, innerObstacle))).toBe(false);
  });

  it('[TC-2-31-11] leaves the source outwards and reaches the target inwards', () => {
    const result = drawRelation(
      { x: 0, y: 0, width: 40, height: 40 },
      { x: 100, y: 18, width: 40, height: 24 },
      { x: 200, y: 0, width: 40, height: 40 },
    );
    const points = samplePath(result.shaft.d);
    const start = points[0];
    const next = points[1];
    const end = points.at(-1);
    const previous = points.at(-2);
    if (!start || !next || !end || !previous) throw new Error('Route tangents missing');

    expect(start.x).toBe(result.sourceRect.x + result.sourceRect.width);
    expect(start.y).toBe(result.sourceRect.y);
    expect(next.x).toBeGreaterThan(start.x);
    expect(end.x).toBe(result.targetRect.x);
    expect(end.y).toBe(result.targetRect.y);
    expect(previous.x).toBeLessThan(end.x);
  });

  it('[TC-2-31-12] aligns the arrowhead with the routed arrival tangent', () => {
    const result = drawRelation(
      { x: 0, y: 0, width: 40, height: 40 },
      { x: 90, y: -100, width: 60, height: 260 },
      { x: 200, y: 0, width: 40, height: 40 },
    );
    const arrow = result.relation.children.find(
      (child) => child.kind === 'path' && child.fill !== undefined,
    );
    if (!arrow || arrow.kind !== 'path') throw new Error('Arrowhead missing');
    const shaftPoints = samplePath(result.shaft.d);
    const arrowPoints = samplePath(arrow.d);
    const previous = shaftPoints.at(-2);
    const end = shaftPoints.at(-1);
    const tip = arrowPoints[0];
    const baseLeft = arrowPoints[1];
    const baseRight = arrowPoints[2];
    if (!previous || !end || !tip || !baseLeft || !baseRight) {
      throw new Error('Arrowhead tangent points missing');
    }
    const tangent = { x: end.x - previous.x, y: end.y - previous.y };
    const base = { x: (baseLeft.x + baseRight.x) / 2, y: (baseLeft.y + baseRight.y) / 2 };
    const direction = { x: tip.x - base.x, y: tip.y - base.y };
    const tangentLength = Math.hypot(tangent.x, tangent.y);
    const directionLength = Math.hypot(direction.x, direction.y);

    expect(tangent.x * direction.x + tangent.y * direction.y).toBeGreaterThan(0);
    expect(
      Math.abs(tangent.x * direction.y - tangent.y * direction.x) /
        (tangentLength * directionLength),
    ).toBeLessThan(0.03);
  });

  it('[TC-2-31-13] includes the routed shaft and hit width in group bounds', () => {
    const result = drawRelation(
      { x: 0, y: 0, width: 40, height: 40 },
      { x: 90, y: -100, width: 60, height: 260 },
      { x: 200, y: 0, width: 40, height: 40 },
    );
    const hit = result.relation.children.find(
      (child) => child.kind === 'group' && child.key === 'relation-hit:source:target',
    );
    if (!hit || hit.kind !== 'group' || !hit.bounds || !result.relation.bounds) {
      throw new Error('Route bounds missing');
    }
    const points = samplePath(result.shaft.d);
    const minX = Math.min(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxX = Math.max(...points.map((point) => point.x));
    const maxY = Math.max(...points.map((point) => point.y));

    expect(hit.bounds.x).toBeLessThanOrEqual(minX - 5);
    expect(hit.bounds.y).toBeLessThanOrEqual(minY - 5);
    expect(hit.bounds.x + hit.bounds.width).toBeGreaterThanOrEqual(maxX + 5);
    expect(hit.bounds.y + hit.bounds.height).toBeGreaterThanOrEqual(maxY + 5);
    expect(result.relation.bounds.x).toBeLessThanOrEqual(hit.bounds.x);
    expect(result.relation.bounds.y).toBeLessThanOrEqual(hit.bounds.y);
    expect(result.relation.bounds.x + result.relation.bounds.width).toBeGreaterThanOrEqual(
      hit.bounds.x + hit.bounds.width,
    );
    expect(result.relation.bounds.y + result.relation.bounds.height).toBeGreaterThanOrEqual(
      hit.bounds.y + hit.bounds.height,
    );
  });

  it('[TC-2-31-14] finds a clear outer route past an omitted blocker in a dense map', () => {
    const distractors = Array.from({ length: 34 }, (_, index) => ({
      x: 80 + index * 12,
      y: 18,
      width: 4,
      height: 4,
    }));
    const tallBlocker = { x: 500, y: -180, width: 40, height: 400 };
    const result = drawRelations(
      { x: 0, y: 0, width: 40, height: 40 },
      [...distractors, tallBlocker],
      { x: 1000, y: 0, width: 40, height: 40 },
      null,
      { x: -300, y: 0, width: 40, height: 20 },
    );
    const points = samplePath(result.shaft.d);

    expect(points.some((point) => entersRect(point, tallBlocker, 8))).toBe(false);
  });

  it('[TC-2-31-15] avoids extra nodes when every route crosses an endpoint-overlap node', () => {
    const unavoidable = { x: -10, y: -10, width: 60, height: 60 };
    const extraBlocker = { x: 100, y: -250, width: 60, height: 500 };
    const result = drawRelations(
      { x: 0, y: 0, width: 40, height: 40 },
      [unavoidable, extraBlocker],
      { x: 240, y: 0, width: 40, height: 40 },
      null,
      { x: -300, y: 0, width: 40, height: 20 },
    );
    const points = samplePath(result.shaft.d);

    expect(crossings(points, [unavoidable])).toHaveLength(1);
    expect(crossings(points, [extraBlocker])).toHaveLength(0);
    expect(result.shaft.d.match(/L/g)?.length).toBeGreaterThan(0);
  });

  it('[TC-2-31-16] minimizes overlap length after minimizing crossed nodes', () => {
    const containing = { x: -50, y: -150, width: 1300, height: 350 };
    const result = drawRelations(
      { x: 0, y: 0, width: 40, height: 40 },
      [containing],
      { x: 1200, y: 0, width: 40, height: 40 },
      null,
      { x: -300, y: 0, width: 40, height: 20 },
    );
    const points = samplePath(result.shaft.d);

    expect(crossings(points, [containing])).toHaveLength(1);
    expect(points.some((point) => point.y < containing.y)).toBe(true);
    expect(lengthInside(points, containing)).toBeLessThan(400);
  });

  it('[TC-2-31-17] exposes a top-level midpoint marker for label editing', () => {
    const result = drawRelation(
      { x: 0, y: 0, width: 40, height: 40 },
      { x: 90, y: -100, width: 60, height: 260 },
      { x: 200, y: 0, width: 40, height: 40 },
      'connects',
    );
    const marker = result.primitives.find(
      (primitive) =>
        primitive.kind === 'group' && primitive.key === 'relation-midpoint:source:target',
    );
    if (!marker || marker.kind !== 'group') throw new Error('Midpoint marker missing');
    const point = marker.children.find((child) => child.kind === 'rect');
    const label = result.relation.children.find((child) => child.kind === 'rect');
    if (!point || point.kind !== 'rect' || !label || label.kind !== 'rect') {
      throw new Error('Midpoint geometry missing');
    }

    expect(point.fill).toBe('none');
    expect(point.x + point.w / 2).toBeCloseTo(label.x + label.w / 2, 3);
    expect(point.y + point.h / 2).toBeCloseTo(label.y + label.h / 2, 3);
  });

  it('[TC-2-31-18] keeps dense routing bounded with one thousand visible obstacles', () => {
    const sourceRect = { x: 0, y: 0, width: 40, height: 40 };
    const targetRect = { x: 10000, y: 0, width: 40, height: 40 };
    const distractors = Array.from({ length: 999 }, (_, index) => ({
      x: 80 + index * 9,
      y: 18,
      width: 4,
      height: 4,
    }));
    const wall = { x: 5000, y: -500, width: 40, height: 1000 };
    const route = routeRelationGeometry(
      { rect: sourceRect, anchors: routeAnchors(sourceRect) },
      { rect: targetRect, anchors: routeAnchors(targetRect) },
      [...distractors, wall],
    );

    expect(route.d).not.toContain('NaN');
    expect(samplePath(route.d).some((point) => entersRect(point, wall, 8))).toBe(false);
  });
});
