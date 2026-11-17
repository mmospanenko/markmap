import type { Anchor, Point, Rect, Side } from '@markmap/core';

const SIDES: readonly Side[] = ['right', 'left', 'bottom', 'top'];
const CONTACT_FRACTIONS = [0, 0.5, 1] as const;
const ROUTE_CLEARANCE = 8;
const ROUTE_CORNER_RADIUS = 12;
const GRAPH_OBSTACLE_LIMITS = [16, 32, 48] as const;
const DIRECT_BLOCKER_SAMPLE_LIMIT = 24;
const EPSILON = 1e-8;

export interface RelationRouteEndpoint {
  rect: Rect;
  anchors: readonly Anchor[];
}

export interface RelationRouteGeometry {
  d: string;
  p0: Anchor;
  p3: Anchor;
  midX: number;
  midY: number;
  angle: number;
  bounds: Rect;
  length: number;
}

interface CubicSegment {
  kind: 'cubic';
  start: Point;
  control1: Point;
  control2: Point;
  end: Point;
}

interface LineSegment {
  kind: 'line';
  start: Point;
  end: Point;
}

type PathSegment = CubicSegment | LineSegment;

interface RouteCandidate {
  geometry: RelationRouteGeometry;
  samples: Point[];
  lines: LineSegment[];
  segments: PathSegment[];
}

interface SegmentInterval {
  start: number;
  end: number;
}

interface GraphEdge {
  to: number;
  length: number;
}

interface CollisionScore {
  crossed: number;
  insideLength: number;
  length: number;
}

interface RankedObstacle {
  rect: Rect;
  directBlockers: number;
  distance: number;
  index: number;
}

export function relationAnchorCandidates(
  rect: Rect,
  anchorForSide: (side: Side) => Anchor,
): Anchor[] {
  const anchors: Anchor[] = [];
  for (const side of SIDES) {
    const base = anchorForSide(side);
    for (const fraction of CONTACT_FRACTIONS) {
      if (side === 'left' || side === 'right') {
        anchors.push({
          x: base.x,
          y: rect.y + rect.height * fraction,
          side,
        });
      } else {
        anchors.push({
          x: rect.x + rect.width * fraction,
          y: base.y,
          side,
        });
      }
    }
  }
  return anchors;
}

export function routeRelationGeometry(
  source: RelationRouteEndpoint,
  target: RelationRouteEndpoint,
  obstacles: readonly Rect[],
): RelationRouteGeometry {
  const directRoutes = directCandidates(source, target).toSorted((a, b) => compareRoute(a, b));
  for (const route of directRoutes) {
    if (routeIsClear(route, source.rect, target.rect, obstacles, ROUTE_CLEARANCE)) {
      return route.geometry;
    }
  }

  const blockers = rankObstacles(directRoutes, source, target, obstacles, ROUTE_CLEARANCE);
  const corridors = outerCorridorCandidates(source, target, obstacles, blockers);
  const paddedRoutes = [
    ...adaptiveVisibilityRoutes(source, target, blockers, obstacles, ROUTE_CLEARANCE).filter(
      (route) => routeIsClear(route, source.rect, target.rect, obstacles, ROUTE_CLEARANCE),
    ),
    ...corridors.filter((route) =>
      routeIsClear(route, source.rect, target.rect, obstacles, ROUTE_CLEARANCE),
    ),
  ];
  const bestPadded = paddedRoutes.toSorted((a, b) => compareRoute(a, b)).at(0);
  if (bestPadded) return bestPadded.geometry;

  const boundaryRoutes = [
    ...adaptiveVisibilityRoutes(source, target, blockers, obstacles, 0).filter((route) =>
      routeIsClear(route, source.rect, target.rect, obstacles, 0),
    ),
    ...corridors.filter((route) => routeIsClear(route, source.rect, target.rect, obstacles, 0)),
  ];
  const bestBoundary = boundaryRoutes.toSorted((a, b) => compareRoute(a, b)).at(0);
  if (bestBoundary) return bestBoundary.geometry;

  const safeDirect = directRoutes.filter((route) =>
    routeIsEndpointSafe(route, source.rect, target.rect),
  );
  const safeCorridors = corridors.filter((route) =>
    routeIsEndpointSafe(route, source.rect, target.rect),
  );
  const fallbackRoutes =
    safeDirect.length || safeCorridors.length
      ? [...safeDirect, ...safeCorridors]
      : [...directRoutes, ...corridors];
  const fallback = fallbackRoutes
    .map((route) => ({ route, score: scoreCollisions(route, obstacles) }))
    .toSorted((a, b) => compareCollisionScore(a.score, b.score))
    .at(0);
  if (fallback) return fallback.route.geometry;

  const sourceAnchor = source.anchors[0];
  const targetAnchor = target.anchors[0];
  if (!sourceAnchor || !targetAnchor) {
    throw new Error('Relationship endpoints need boundary anchors');
  }
  return makeRoute(
    [
      {
        kind: 'cubic',
        start: sourceAnchor,
        control1: sourceAnchor,
        control2: targetAnchor,
        end: targetAnchor,
      },
    ],
    sourceAnchor,
    targetAnchor,
  ).geometry;
}

function directCandidates(
  source: RelationRouteEndpoint,
  target: RelationRouteEndpoint,
): RouteCandidate[] {
  const routes: RouteCandidate[] = [];
  for (const sourceAnchor of source.anchors) {
    for (const targetAnchor of target.anchors) {
      const span = Math.hypot(targetAnchor.x - sourceAnchor.x, targetAnchor.y - sourceAnchor.y);
      const offset = Math.max(24, Math.min(span * 0.35, 110));
      const sourceVector = sideVector(sourceAnchor.side);
      const targetVector = sideVector(targetAnchor.side);
      routes.push(
        makeRoute(
          [
            {
              kind: 'cubic',
              start: sourceAnchor,
              control1: {
                x: sourceAnchor.x + sourceVector.x * offset,
                y: sourceAnchor.y + sourceVector.y * offset,
              },
              control2: {
                x: targetAnchor.x + targetVector.x * offset,
                y: targetAnchor.y + targetVector.y * offset,
              },
              end: targetAnchor,
            },
          ],
          sourceAnchor,
          targetAnchor,
        ),
      );
    }
  }
  return routes;
}

function adaptiveVisibilityRoutes(
  source: RelationRouteEndpoint,
  target: RelationRouteEndpoint,
  ranked: readonly RankedObstacle[],
  obstacles: readonly Rect[],
  clearance: number,
): RouteCandidate[] {
  const routes: RouteCandidate[] = [];
  const promoted = new Set<Rect>();
  const graphPadding = clearance > 0 ? clearance + ROUTE_CORNER_RADIUS + 2 : 0.5;
  for (const limit of GRAPH_OBSTACLE_LIMITS) {
    const selected = [
      ...ranked.filter((item) => promoted.has(item.rect)),
      ...ranked.filter((item) => !promoted.has(item.rect)),
    ]
      .slice(0, limit)
      .map((item) => item.rect);
    const route = visibilityRoute(
      source,
      target,
      selected,
      graphPadding,
      clearance,
      ROUTE_CORNER_RADIUS,
    );
    if (!route) continue;
    routes.push(route);
    for (const rect of routeBlockingRects(route, obstacles, clearance)) {
      if (!selected.includes(rect)) promoted.add(rect);
    }
  }
  return routes;
}

function visibilityRoute(
  source: RelationRouteEndpoint,
  target: RelationRouteEndpoint,
  routingObstacles: readonly Rect[],
  graphPadding: number,
  validationPadding: number,
  cornerRadius: number,
): RouteCandidate | undefined {
  const endpointRects = [source.rect, target.rect];
  const routingRects = [...routingObstacles, ...endpointRects];
  const paddedRects = routingRects.map((rect) => expand(rect, graphPadding));
  const stageDistance = graphPadding + 2;
  const vertices: Point[] = [];
  const sourceIndexes = new Map<number, Anchor>();
  const targetIndexes = new Map<number, Anchor>();

  for (const anchor of source.anchors) {
    const vector = sideVector(anchor.side);
    const point = {
      x: anchor.x + vector.x * stageDistance,
      y: anchor.y + vector.y * stageDistance,
    };
    const index = vertices.length;
    vertices.push(point);
    sourceIndexes.set(index, anchor);
  }
  for (const anchor of target.anchors) {
    const vector = sideVector(anchor.side);
    const point = {
      x: anchor.x + vector.x * stageDistance,
      y: anchor.y + vector.y * stageDistance,
    };
    const index = vertices.length;
    vertices.push(point);
    targetIndexes.set(index, anchor);
  }
  for (const rect of paddedRects) {
    vertices.push(...corners(rect));
  }

  const usableVertices = vertices
    .map((point, index) => ({ point, index }))
    .filter(({ point }) => !paddedRects.some((rect) => strictlyContains(rect, point)));
  const oldToNew = new Map(usableVertices.map(({ index }, nextIndex) => [index, nextIndex]));
  const points = usableVertices.map(({ point }) => point);
  const sourcePorts = new Map<number, Anchor>();
  const targetPorts = new Map<number, Anchor>();
  for (const [oldIndex, anchor] of sourceIndexes) {
    const nextIndex = oldToNew.get(oldIndex);
    if (nextIndex !== undefined) sourcePorts.set(nextIndex, anchor);
  }
  for (const [oldIndex, anchor] of targetIndexes) {
    const nextIndex = oldToNew.get(oldIndex);
    if (nextIndex !== undefined) targetPorts.set(nextIndex, anchor);
  }
  if (sourcePorts.size === 0 || targetPorts.size === 0) return undefined;

  const graph: GraphEdge[][] = points.map(() => []);
  for (let from = 0; from < points.length; from += 1) {
    const pointA = points[from];
    if (!pointA) continue;
    for (let to = from + 1; to < points.length; to += 1) {
      const pointB = points[to];
      if (!pointB || !segmentIsClear(pointA, pointB, paddedRects)) continue;
      const length = distance(pointA, pointB);
      graph[from]?.push({ to, length });
      graph[to]?.push({ to: from, length });
    }
  }

  const distances = points.map(() => Infinity);
  const previous = points.map(() => -1);
  const visited = points.map(() => false);
  for (const index of sourcePorts.keys()) {
    const anchor = sourcePorts.get(index);
    const point = points[index];
    if (!anchor || !point) continue;
    distances[index] = distance(anchor, point);
  }

  for (let pass = 0; pass < points.length; pass += 1) {
    let current = -1;
    let currentDistance = Infinity;
    for (let index = 0; index < distances.length; index += 1) {
      const candidate = distances[index];
      if (candidate === undefined || visited[index] || candidate >= currentDistance) continue;
      current = index;
      currentDistance = candidate;
    }
    if (current < 0) break;
    visited[current] = true;
    for (const edge of graph[current] ?? []) {
      const nextDistance = currentDistance + edge.length;
      if (nextDistance + EPSILON >= (distances[edge.to] ?? Infinity)) continue;
      distances[edge.to] = nextDistance;
      previous[edge.to] = current;
    }
  }

  let targetIndex = -1;
  let totalDistance = Infinity;
  for (const [index, anchor] of targetPorts) {
    const point = points[index];
    const graphDistance = distances[index];
    if (!point || graphDistance === undefined) continue;
    const candidate = graphDistance + distance(point, anchor);
    if (candidate + EPSILON >= totalDistance) continue;
    targetIndex = index;
    totalDistance = candidate;
  }
  if (targetIndex < 0) return undefined;

  const indices: number[] = [];
  let pathIndex = targetIndex;
  while (pathIndex >= 0) {
    indices.unshift(pathIndex);
    pathIndex = previous[pathIndex] ?? -1;
  }
  const sourceIndex = indices[0];
  const sourceAnchor = sourceIndex === undefined ? undefined : sourcePorts.get(sourceIndex);
  const targetAnchor = targetPorts.get(targetIndex);
  if (!sourceAnchor || !targetAnchor) return undefined;
  const pathPoints = indices
    .map((index) => points[index])
    .filter((point): point is Point => point !== undefined);
  const rawPoints = [sourceAnchor, ...pathPoints, targetAnchor];
  const candidates = [cornerRadius, cornerRadius / 2, cornerRadius / 4, 0]
    .map((radius) => makeRoute(roundedSegments(rawPoints, radius), sourceAnchor, targetAnchor))
    .filter((route) =>
      routeIsClear(route, source.rect, target.rect, routingObstacles, validationPadding),
    );
  return candidates.toSorted((a, b) => compareRoute(a, b))[0];
}

function rankObstacles(
  routes: readonly RouteCandidate[],
  source: RelationRouteEndpoint,
  target: RelationRouteEndpoint,
  obstacles: readonly Rect[],
  padding: number,
): RankedObstacle[] {
  const sample = routes.filter(
    (_, index) =>
      index === 0 ||
      index === routes.length - 1 ||
      index % Math.max(1, Math.floor(routes.length / DIRECT_BLOCKER_SAMPLE_LIMIT)) === 0,
  );
  const sourceCenter = center(source.rect);
  const targetCenter = center(target.rect);
  return obstacles
    .map((rect, index) => ({
      rect,
      index,
      directBlockers: sample.filter((route) => routeIntersectsRect(route, expand(rect, padding)))
        .length,
      distance: Math.max(
        0,
        distanceToSegment(center(rect), sourceCenter, targetCenter) -
          Math.hypot(rect.width, rect.height) / 2,
      ),
    }))
    .toSorted((a, b) => {
      if (a.directBlockers !== b.directBlockers) return b.directBlockers - a.directBlockers;
      if (a.distance !== b.distance) return a.distance - b.distance;
      return a.index - b.index;
    });
}

function outerCorridorCandidates(
  source: RelationRouteEndpoint,
  target: RelationRouteEndpoint,
  obstacles: readonly Rect[],
  ranked: readonly RankedObstacle[],
): RouteCandidate[] {
  const blockingRects = ranked.filter((item) => item.directBlockers > 0).map((item) => item.rect);
  const boundsRects = [
    ...(blockingRects.length > 0 ? blockingRects : obstacles),
    source.rect,
    target.rect,
  ];
  const bounds = rectBounds(boundsRects);
  const margin = ROUTE_CLEARANCE + ROUTE_CORNER_RADIUS + 2;
  const corridorCoordinates = new Map<Side, number>([
    ['top', bounds.y - margin],
    ['bottom', bounds.y + bounds.height + margin],
    ['left', bounds.x - margin],
    ['right', bounds.x + bounds.width + margin],
  ]);
  const routes: RouteCandidate[] = [];
  for (const side of SIDES) {
    const sourceAnchor = centerAnchor(source.anchors, side, source.rect);
    const targetAnchor = centerAnchor(target.anchors, side, target.rect);
    const corridor = corridorCoordinates.get(side);
    if (!sourceAnchor || !targetAnchor || corridor === undefined) continue;
    const vector = sideVector(side);
    const stageDistance = margin;
    const sourceStage = {
      x: sourceAnchor.x + vector.x * stageDistance,
      y: sourceAnchor.y + vector.y * stageDistance,
    };
    const targetStage = {
      x: targetAnchor.x + vector.x * stageDistance,
      y: targetAnchor.y + vector.y * stageDistance,
    };
    const firstCorner =
      side === 'top' || side === 'bottom'
        ? { x: sourceStage.x, y: corridor }
        : { x: corridor, y: sourceStage.y };
    const secondCorner =
      side === 'top' || side === 'bottom'
        ? { x: targetStage.x, y: corridor }
        : { x: corridor, y: targetStage.y };
    const points = [
      sourceAnchor,
      sourceStage,
      firstCorner,
      secondCorner,
      targetStage,
      targetAnchor,
    ];
    for (const radius of [ROUTE_CORNER_RADIUS, ROUTE_CORNER_RADIUS / 2, 0]) {
      routes.push(makeRoute(roundedSegments(points, radius), sourceAnchor, targetAnchor));
    }
  }
  return routes;
}

function centerAnchor(anchors: readonly Anchor[], side: Side, rect: Rect): Anchor | undefined {
  const centerPoint = center(rect);
  return anchors
    .filter((anchor) => anchor.side === side)
    .toSorted(
      (a, b) =>
        Math.hypot(a.x - centerPoint.x, a.y - centerPoint.y) -
        Math.hypot(b.x - centerPoint.x, b.y - centerPoint.y),
    )[0];
}

function rectBounds(rects: readonly Rect[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function roundedSegments(points: readonly Point[], radius: number): PathSegment[] {
  const compact = points.filter(
    (point, index) => index === 0 || distance(point, points[index - 1] ?? point) > EPSILON,
  );
  if (compact.length < 2) return [];
  const segments: PathSegment[] = [];
  let current = compact[0];
  if (!current) return segments;

  for (let index = 1; index < compact.length - 1; index += 1) {
    const previous = compact[index - 1];
    const corner = compact[index];
    const next = compact[index + 1];
    if (!previous || !corner || !next) continue;
    const incomingLength = distance(previous, corner);
    const outgoingLength = distance(corner, next);
    if (incomingLength <= EPSILON || outgoingLength <= EPSILON) continue;
    const incoming = {
      x: (corner.x - previous.x) / incomingLength,
      y: (corner.y - previous.y) / incomingLength,
    };
    const outgoing = {
      x: (next.x - corner.x) / outgoingLength,
      y: (next.y - corner.y) / outgoingLength,
    };
    const dot = incoming.x * outgoing.x + incoming.y * outgoing.y;
    const radiusAtCorner =
      dot > 0.999 || dot < -0.999 || radius <= EPSILON
        ? 0
        : Math.min(radius, incomingLength * 0.35, outgoingLength * 0.35);
    if (radiusAtCorner <= EPSILON) {
      if (current && distance(current, corner) > EPSILON) {
        segments.push({ kind: 'line', start: current, end: corner });
      }
      current = corner;
      continue;
    }
    const entry = {
      x: corner.x - incoming.x * radiusAtCorner,
      y: corner.y - incoming.y * radiusAtCorner,
    };
    const exit = {
      x: corner.x + outgoing.x * radiusAtCorner,
      y: corner.y + outgoing.y * radiusAtCorner,
    };
    if (current && distance(current, entry) > EPSILON) {
      segments.push({ kind: 'line', start: current, end: entry });
    }
    segments.push({
      kind: 'cubic',
      start: entry,
      control1: {
        x: entry.x + ((corner.x - entry.x) * 2) / 3,
        y: entry.y + ((corner.y - entry.y) * 2) / 3,
      },
      control2: {
        x: exit.x + ((corner.x - exit.x) * 2) / 3,
        y: exit.y + ((corner.y - exit.y) * 2) / 3,
      },
      end: exit,
    });
    current = exit;
  }

  const last = compact.at(-1);
  if (current && last && distance(current, last) > EPSILON) {
    segments.push({ kind: 'line', start: current, end: last });
  }
  return segments;
}

function makeRoute(
  segments: PathSegment[],
  sourceAnchor?: Anchor,
  targetAnchor?: Anchor,
): RouteCandidate {
  const first = segments[0];
  const last = segments.at(-1);
  const points = routeSamples(segments);
  const lines = sampleLines(points);
  const start = first?.start ?? { x: 0, y: 0 };
  const end = last?.end ?? start;
  const anchors: [Anchor, Anchor] = [
    sourceAnchor ?? { ...start, side: 'right' },
    targetAnchor ?? { ...end, side: 'left' },
  ];
  const middle = arcMidpoint(points);
  const angle = finalAngle(last);
  return {
    geometry: {
      d: pathData(segments),
      p0: anchors[0],
      p3: anchors[1],
      midX: middle.x,
      midY: middle.y,
      angle,
      bounds: segmentBounds(segments),
      length: pathLength(points),
    },
    samples: points,
    lines,
    segments,
  };
}

function routeIsClear(
  route: RouteCandidate,
  source: Rect,
  target: Rect,
  obstacles: readonly Rect[],
  padding: number,
): boolean {
  if (!routeIsEndpointSafe(route, source, target)) return false;
  const relevant = obstacles
    .map((rect) => expand(rect, padding))
    .filter((rect) => rectIntersects(rect, route.geometry.bounds));
  return route.lines.every((segment) =>
    relevant.every((rect) => !segmentIntersectsRect(segment.start, segment.end, rect)),
  );
}

function routeIsEndpointSafe(route: RouteCandidate, source: Rect, target: Rect): boolean {
  return route.lines.every(
    (segment) =>
      !segmentIntersectsRect(segment.start, segment.end, source) &&
      !segmentIntersectsRect(segment.start, segment.end, target),
  );
}

function routeBlockingRects(
  route: RouteCandidate,
  obstacles: readonly Rect[],
  padding: number,
): Rect[] {
  return obstacles.filter((rect) => routeIntersectsRect(route, expand(rect, padding)));
}

function routeIntersectsRect(route: RouteCandidate, rect: Rect): boolean {
  if (!rectIntersects(route.geometry.bounds, rect)) return false;
  return route.lines.some((segment) => segmentIntersectsRect(segment.start, segment.end, rect));
}

function scoreCollisions(route: RouteCandidate, obstacles: readonly Rect[]): CollisionScore {
  const segments = route.lines;
  let crossed = 0;
  let insideLength = 0;
  for (const rect of obstacles) {
    let crossedRect = false;
    for (const segment of segments) {
      const interval = segmentRectInterval(segment.start, segment.end, rect);
      if (!interval) continue;
      crossedRect = true;
      insideLength += distance(segment.start, segment.end) * (interval.end - interval.start);
    }
    if (crossedRect) crossed += 1;
  }
  return { crossed, insideLength, length: route.geometry.length };
}

function compareCollisionScore(a: CollisionScore, b: CollisionScore): number {
  if (a.crossed !== b.crossed) return a.crossed - b.crossed;
  if (Math.abs(a.insideLength - b.insideLength) > EPSILON) return a.insideLength - b.insideLength;
  return a.length - b.length;
}

function compareRoute(a: RouteCandidate, b: RouteCandidate): number {
  if (Math.abs(a.geometry.length - b.geometry.length) > EPSILON) {
    return a.geometry.length - b.geometry.length;
  }
  return a.segments.length - b.segments.length;
}

function routeSamples(segments: readonly PathSegment[]): Point[] {
  const samples: Point[] = [];
  for (const segment of segments) {
    const points = sampleSegment(segment);
    for (const point of points) {
      if (samples.length === 0 || distance(samples.at(-1) ?? point, point) > EPSILON) {
        samples.push(point);
      }
    }
  }
  return samples;
}

function sampleLines(points: readonly Point[]): LineSegment[] {
  return points.slice(1).flatMap((point, index) => {
    const start = points[index];
    return start ? [{ kind: 'line' as const, start, end: point }] : [];
  });
}

function sampleSegment(segment: PathSegment): Point[] {
  if (segment.kind === 'line') return [segment.start, segment.end];
  const length =
    distance(segment.start, segment.control1) +
    distance(segment.control1, segment.control2) +
    distance(segment.control2, segment.end);
  const steps = Math.min(256, Math.max(16, Math.ceil(length / 2)));
  const points = [segment.start];
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const u = 1 - t;
    points.push({
      x:
        u ** 3 * segment.start.x +
        3 * u ** 2 * t * segment.control1.x +
        3 * u * t ** 2 * segment.control2.x +
        t ** 3 * segment.end.x,
      y:
        u ** 3 * segment.start.y +
        3 * u ** 2 * t * segment.control1.y +
        3 * u * t ** 2 * segment.control2.y +
        t ** 3 * segment.end.y,
    });
  }
  return points;
}

function pathData(segments: readonly PathSegment[]): string {
  const first = segments[0];
  if (!first) return '';
  let d = `M${number(first.start.x)},${number(first.start.y)}`;
  for (const segment of segments) {
    if (segment.kind === 'line') {
      d += `L${number(segment.end.x)},${number(segment.end.y)}`;
    } else {
      d += `C${number(segment.control1.x)},${number(segment.control1.y)} ${number(segment.control2.x)},${number(segment.control2.y)} ${number(segment.end.x)},${number(segment.end.y)}`;
    }
  }
  return d;
}

function segmentBounds(segments: readonly PathSegment[]): Rect {
  const points = segments.flatMap((segment) =>
    segment.kind === 'line'
      ? [segment.start, segment.end]
      : [segment.start, segment.control1, segment.control2, segment.end],
  );
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function finalAngle(segment: PathSegment | undefined): number {
  if (!segment) return 0;
  const tangent =
    segment.kind === 'cubic'
      ? { x: segment.end.x - segment.control2.x, y: segment.end.y - segment.control2.y }
      : { x: segment.end.x - segment.start.x, y: segment.end.y - segment.start.y };
  return Math.atan2(tangent.y, tangent.x);
}

function arcMidpoint(points: readonly Point[]): Point {
  const total = pathLength(points);
  let travelled = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) continue;
    const segmentLength = distance(previous, current);
    if (travelled + segmentLength >= total / 2) {
      const ratio = segmentLength > 0 ? (total / 2 - travelled) / segmentLength : 0;
      return {
        x: previous.x + (current.x - previous.x) * ratio,
        y: previous.y + (current.y - previous.y) * ratio,
      };
    }
    travelled += segmentLength;
  }
  return points.at(-1) ?? { x: 0, y: 0 };
}

function pathLength(points: readonly Point[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous && current) length += distance(previous, current);
  }
  return length;
}

function segmentIsClear(a: Point, b: Point, obstacles: readonly Rect[]): boolean {
  return obstacles.every((rect) => !segmentIntersectsRect(a, b, rect));
}

function segmentIntersectsRect(a: Point, b: Point, rect: Rect): boolean {
  const interval = segmentRectInterval(a, b, rect);
  return interval !== undefined && interval.start < interval.end;
}

function segmentRectInterval(a: Point, b: Point, rect: Rect): SegmentInterval | undefined {
  const xInterval = axisInterval(a.x, b.x - a.x, rect.x, rect.x + rect.width);
  const yInterval = axisInterval(a.y, b.y - a.y, rect.y, rect.y + rect.height);
  if (!xInterval || !yInterval) return undefined;
  const start = Math.max(0, xInterval.start, yInterval.start);
  const end = Math.min(1, xInterval.end, yInterval.end);
  return start < end ? { start, end } : undefined;
}

function axisInterval(
  start: number,
  delta: number,
  min: number,
  max: number,
): SegmentInterval | undefined {
  if (Math.abs(delta) <= EPSILON) {
    return start > min && start < max
      ? { start: Number.NEGATIVE_INFINITY, end: Number.POSITIVE_INFINITY }
      : undefined;
  }
  const first = (min - start) / delta;
  const second = (max - start) / delta;
  return first < second ? { start: first, end: second } : { start: second, end: first };
}

function rectIntersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function strictlyContains(rect: Rect, point: Point): boolean {
  return (
    point.x > rect.x &&
    point.x < rect.x + rect.width &&
    point.y > rect.y &&
    point.y < rect.y + rect.height
  );
}

function expand(rect: Rect, padding: number): Rect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}

function corners(rect: Rect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

function center(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPSILON) return distance(point, start);
  const projection = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  );
  return Math.hypot(point.x - (start.x + dx * projection), point.y - (start.y + dy * projection));
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function sideVector(side: Side): Point {
  if (side === 'left') return { x: -1, y: 0 };
  if (side === 'right') return { x: 1, y: 0 };
  if (side === 'top') return { x: 0, y: -1 };
  return { x: 0, y: 1 };
}

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}
