import {
  type ContentPlugin,
  type FrameNode,
  type GraphData,
  type GraphEdge,
  type InlineContext,
  type Layout,
  type LayoutNode,
  type LayoutResult,
  expandRect,
  type Matrix,
  multiply,
  type Point,
  oppositeSide,
  type PresenceStyle,
  type Measurer,
  type MarkmapNode,
  type MeasureContext,
  type NodeContext,
  type Primitive,
  type Rect,
  resolveLabelStyle,
  type ResolvedLabelStyle,
  type Size,
  type TextAlign,
  type Theme,
  translate,
  unionRects,
} from '@markmap/core';
import { treeLayout, visibleNodes } from './layouts/tree';
import { defaultContentPlugins } from './default-plugins';
import { renderRelationEdges } from './relation';
import { layoutText, type TextLayout, transformContent } from './text';
import { classicTheme } from './themes/classic';

export interface RenderGroup {
  id?: string;
  roots: readonly string[];
  label?: string | null;
}

export interface RenderOptions {
  measurer: Measurer;
  theme?: Theme;
  /** Where nodes go. Defaults to {@link treeLayout}. */
  layout?: Layout;
  /** Ids of collapsed nodes. */
  folded?: ReadonlySet<string>;
  /** Wrap labels wider than this, in px. `0` disables wrapping. */
  wrapWidth?: number;
  levelGap?: number;
  siblingGap?: number;
  /** Inline content renderers. Defaults to {@link defaultContentPlugins}. */
  plugins?: readonly ContentPlugin[];
  groups?: readonly RenderGroup[];
  graph?: GraphData;
  identities?: ReadonlyMap<string, string>;
}

export interface RenderResult {
  theme: Theme;
  layout: LayoutResult;
  /** Edges first, then nodes, so nodes draw on top. */
  primitives: Primitive[];
  /** Area covered by the drawing, including strokes and fold circles. */
  bounds: Rect;
  /** Theme context of every visible node, by id. */
  contexts: Map<string, NodeContext>;
  /** The final frame, as a starting point for animations. */
  state: DrawState;
  /**
   * Settles when content that was measured with a placeholder (such as an image of
   * unknown size) is ready. Render again then to get the final layout.
   */
  pending?: Promise<void>;
}

export interface MeasuredNode {
  text: TextLayout;
  box: Size;
  label: ResolvedLabelStyle;
}

/** Ids from the root to every node, both included. */
export function nodePaths(root: MarkmapNode): Map<string, readonly string[]> {
  const paths = new Map<string, readonly string[]>();
  const visit = (node: MarkmapNode, parent: readonly string[]) => {
    const path = [...parent, node.id];
    paths.set(node.id, path);
    for (const child of node.children) visit(child, path);
  };
  visit(root, []);
  return paths;
}

/** Lay out a node's label. Alignment does not change the size. */
function labelLayout(
  node: MarkmapNode,
  theme: Theme,
  options: RenderOptions,
  label: ResolvedLabelStyle,
  align?: TextAlign,
  defer?: (task: Promise<unknown>) => void,
): TextLayout {
  const plugins = options.plugins ?? defaultContentPlugins;
  const ctx: InlineContext = {
    theme,
    measurer: options.measurer,
    node,
    wrapWidth: options.wrapWidth,
    defer,
  };
  return layoutText(transformContent(plugins, ctx), {
    style: { font: label.font, fill: label.fill },
    wrapWidth: options.wrapWidth,
    plugins,
    ctx,
    align,
  });
}

/**
 * Measure the label and box of every visible node. Content that is not ready yet (see
 * {@link InlineContext.defer}) is reported to `defer`.
 */
export function measureTree(
  root: MarkmapNode,
  options: RenderOptions,
  defer?: (task: Promise<unknown>) => void,
): Map<string, MeasuredNode> {
  const theme = options.theme ?? classicTheme;
  const result = new Map<string, MeasuredNode>();
  const paths = nodePaths(root);
  for (const node of visibleNodes(root, options.folded)) {
    const path = paths.get(node.id)!;
    const depth = path.length - 1;
    const ctx: MeasureContext = {
      depth,
      path,
      hasChildren: node.children.length > 0,
      folded: !!options.folded?.has(node.id),
    };
    const label = resolveLabelStyle(theme, node, ctx);
    const [top, right, bottom, left] = label.padding;
    const text = labelLayout(node, theme, options, label, undefined, defer);
    const box = theme.node.measure
      ? theme.node.measure(text, node, ctx, label)
      : {
          width: text.width + left + right,
          height: Math.max(text.height + top + bottom, theme.node.minHeight ?? 0),
        };
    result.set(node.id, { text, box, label });
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRenderGroup(value: unknown): value is RenderGroup {
  if (!isRecord(value)) return false;
  return isStringArray(value['roots']);
}

function readGroups(data: Record<string, unknown>): readonly RenderGroup[] {
  const groups = data['groups'];
  if (!Array.isArray(groups)) return [];
  return groups.filter(isRenderGroup);
}

function groupPadding(layoutName: string | undefined): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  if (layoutName === 'org-chart') return { top: 16, right: 16, bottom: 20, left: 16 };
  if (layoutName === 'two-sided') return { top: 14, right: 20, bottom: 14, left: 20 };
  return { top: 14, right: 20, bottom: 14, left: 16 };
}

/** Measure, lay out and draw a tree as backend-neutral primitives. */
export function renderTree(root: MarkmapNode, options: RenderOptions): RenderResult {
  const theme = options.theme ?? classicTheme;
  const tasks: Promise<unknown>[] = [];
  const measured = measureTree(root, options, (task) => tasks.push(task));
  const paths = nodePaths(root);
  const contexts = new Map<string, NodeContext>();
  const branchOf = (item: LayoutNode): number => {
    let first = item;
    while (first.depth > 1 && first.parent) first = first.parent;
    return first.parent ? first.parent.children.indexOf(first) : 0;
  };
  const contextOf = (item: LayoutNode): NodeContext => {
    let ctx = contexts.get(item.node.id);
    if (!ctx) {
      ctx = {
        depth: item.depth,
        path: paths.get(item.node.id)!,
        branch: branchOf(item),
        hasChildren: item.node.children.length > 0,
        folded: item.folded,
        direction: item.direction,
      };
      contexts.set(item.node.id, ctx);
    }
    return ctx;
  };
  const layout = (options.layout ?? treeLayout).layout(root, {
    sizes: new Map([...measured].map(([id, { box }]) => [id, box])),
    folded: options.folded,
    levelGap: options.levelGap,
    siblingGap: options.siblingGap,
  });

  const rawGroups = options.groups ?? readGroups(root.data);
  const pad = groupPadding(options.layout?.name);
  const drawGroups: DrawGroup[] = [];
  rawGroups.forEach((group, index) => {
    if (group.roots.length === 0) return;
    const isHidden = group.roots.some((r) => {
      const p = paths.get(r);
      return !p || p.some((id) => options.folded?.has(id));
    });
    if (isHidden) return;
    const groupNodes = layout.nodes.filter((item) => {
      const path = paths.get(item.node.id);
      return path !== undefined && group.roots.some((r) => path.includes(r));
    });
    if (groupNodes.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of groupNodes) {
      if (node.rect.x < minX) minX = node.rect.x;
      if (node.rect.y < minY) minY = node.rect.y;
      if (node.rect.x + node.rect.width > maxX) maxX = node.rect.x + node.rect.width;
      if (node.rect.y + node.rect.height > maxY) maxY = node.rect.y + node.rect.height;
    }
    const rect: Rect = {
      x: minX - pad.left,
      y: minY - pad.top,
      width: maxX - minX + pad.left + pad.right,
      height: maxY - minY + pad.top + pad.bottom,
    };
    drawGroups.push({
      id: group.id ?? `group-${index}`,
      roots: [...group.roots],
      label: group.label ?? null,
      rect,
    });
  });

  const state: DrawState = {
    nodes: layout.nodes.map((item) => {
      const ctx = contextOf(item);
      const measuredNode = measured.get(item.node.id)!;
      let { text } = measuredNode;
      // Alignment depends on the direction, known only now; one line needs no alignment.
      const align = theme.node.textAlign?.(ctx) ?? 'start';
      if (align !== 'start' && text.lines > 1) {
        text = labelLayout(item.node, theme, options, measuredNode.label, align, (task) =>
          tasks.push(task),
        );
      }
      return {
        node: item.node,
        parentId: item.parent?.node.id,
        rect: item.rect,
        ctx,
        text,
        label: measuredNode.label,
        presence: 1,
      };
    }),
    groups: drawGroups,
    rootId: root.id,
    relations: options.graph?.edges,
    identities: options.identities,
    folded: options.folded,
  };
  const primitives = drawState(state, theme);
  const bounds = unionRects([layout.bounds, primitiveBounds(primitives)]);
  const pending = tasks.length ? Promise.allSettled(tasks).then(() => undefined) : undefined;
  return { theme, layout, primitives, bounds, contexts, state, ...(pending && { pending }) };
}

/**
 * Render, wait for content that was measured with a placeholder, and render again, until
 * everything is final (at most `rounds` times). Useful outside a live view, e.g. for
 * exporting SVG with images.
 */
export async function renderTreeAsync(
  root: MarkmapNode,
  options: RenderOptions,
  rounds = 3,
): Promise<RenderResult> {
  let result = renderTree(root, options);
  for (let i = 1; i < rounds && result.pending; i++) {
    await result.pending;
    result = renderTree(root, options);
  }
  return result;
}

/** A node as drawn in one frame: final, or somewhere along an animation. */
export interface DrawNode extends FrameNode {
  /** Parent in the same state; nodes without one get no edge. */
  parentId?: string;
  text: TextLayout;
  label?: ResolvedLabelStyle;
}

export interface DrawGroup {
  id: string;
  roots: string[];
  label: string | null;
  rect: Rect;
}

/** Everything needed to draw one frame. Parents come before their children. */
export interface DrawState {
  nodes: DrawNode[];
  groups?: DrawGroup[];
  rootId?: string;
  relations?: readonly GraphEdge[];
  identities?: ReadonlyMap<string, string>;
  folded?: ReadonlySet<string>;
}

/**
 * Draw a state as primitives: edges first, then nodes, each in a keyed group so
 * backends can patch them. Edge anchors come from the theme, so animating node rects
 * moves edges along with them.
 */
export function drawState(state: DrawState, theme: Theme): Primitive[] {
  const underlays: Primitive[] = (state.groups ?? []).map((group) => {
    const children: Primitive[] = [
      {
        kind: 'rect',
        x: group.rect.x,
        y: group.rect.y,
        w: group.rect.width,
        h: group.rect.height,
        r: 8,
        fill: 'var(--mm-group-fill)',
        stroke: 'var(--mm-group-border)',
        strokeWidth: 1.5,
        strokeDashArray: [5, 4],
      },
    ];
    if (group.label) {
      children.push({
        kind: 'text',
        x: group.rect.x + 8,
        y: group.rect.y - 6,
        runs: [
          {
            text: group.label,
            x: 0,
            y: 0,
            font: {
              family: theme.font.family,
              size: 12,
              weight: 600,
              style: 'normal',
              lineHeight: 14,
            },
            fill: 'var(--mm-text)',
          },
        ],
      });
    }
    return {
      kind: 'group',
      key: `group:${group.id}`,
      groupId: group.id,
      bounds: expandRect(group.rect, BOUNDS_MARGIN),
      children,
    };
  });
  const byId = new Map(state.nodes.map((item) => [item.node.id, item]));
  const looks = new Map<string, PresenceStyle>();
  const lookOf = (item: DrawNode): PresenceStyle => {
    if (item.presence >= 1) return {};
    let look = looks.get(item.node.id);
    if (!look) {
      const box = { width: item.rect.width, height: item.rect.height };
      look = theme.node.presence?.(item.presence, box, item.ctx) ?? { opacity: item.presence };
      looks.set(item.node.id, look);
    }
    return look;
  };
  const edges: Primitive[] = [];
  for (const target of state.nodes) {
    const source = target.parentId ? byId.get(target.parentId) : undefined;
    if (!source) continue;
    const from = theme.node.anchor(source.rect, target.ctx.direction, source.ctx);
    const to = theme.node.anchor(target.rect, oppositeSide(target.ctx.direction), target.ctx);
    edges.push({
      kind: 'group',
      key: `edge:${target.node.id}`,
      nodeId: target.node.id,
      bounds: edgeBounds(from, to),
      ...opacityOf(lookOf(target)),
      children: theme.edge.render(from, to, {
        source: source.node,
        target: target.node,
        node: target.ctx,
      }),
    });
  }

  const nodes: Primitive[] = state.nodes.map((item) => {
    const [top, , , left] = item.label?.padding ?? theme.node.padding;
    return {
      kind: 'group',
      key: `node:${item.node.id}`,
      nodeId: item.node.id,
      bounds: expandRect(item.rect, BOUNDS_MARGIN),
      transform: lookOf(item).transform
        ? multiply(translate(item.rect.x, item.rect.y), lookOf(item).transform!)
        : translate(item.rect.x, item.rect.y),
      ...opacityOf(lookOf(item)),
      children: [
        ...theme.node.render(
          item.node,
          { width: item.rect.width, height: item.rect.height },
          item.ctx,
        ),
        { kind: 'group', transform: translate(left, top), children: item.text.primitives },
      ],
    };
  });
  const relations = state.relations
    ? renderRelationEdges({
        edges: state.relations,
        identities: state.identities,
        nodesById: byId,
        rootId: state.rootId,
        folded: state.folded,
        theme,
      })
    : [];
  return [...underlays, ...edges, ...nodes, ...relations];
}

/** Room around a node or edge for what themes draw past it, such as fold circles. */
const BOUNDS_MARGIN = 24;

const edgeBounds = (a: Point, b: Point): Rect =>
  expandRect(
    {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    },
    BOUNDS_MARGIN,
  );

const opacityOf = ({ opacity }: PresenceStyle) =>
  opacity != null && opacity < 1 ? { opacity: Math.max(0, opacity) } : {};

/** Absolute points of a path made of `M`, `L`, `H`, `V` and `C` commands. */
function pathPoints(d: string): [number, number][] {
  const points: [number, number][] = [];
  let [x, y] = [0, 0];
  for (const [, cmd, args] of d.matchAll(/([MLHVC])([^MLHVC]*)/g)) {
    const values = args.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
    if (cmd === 'H') for (const v of values) points.push([(x = v), y]);
    else if (cmd === 'V') for (const v of values) points.push([x, (y = v)]);
    else
      for (let i = 0; i + 1 < values.length; i += 2)
        points.push([(x = values[i]), (y = values[i + 1])]);
  }
  return points;
}

/**
 * Bounding box of rects, paths and images, including stroke widths. Curve control
 * points are included, so curves give a safe over-estimate. Text is not included:
 * it sits inside node boxes, which callers add from the layout.
 */
export function primitiveBounds(primitives: Primitive[]): Rect {
  const rects: Rect[] = [];
  /** Add a box around a point, whose stroke scales with the matrix. */
  const addPoint = ([a, b, c, d, e, f]: Matrix, x: number, y: number, size: number) => {
    const s = size * Math.max(Math.hypot(a, b), Math.hypot(c, d));
    rects.push({
      x: a * x + c * y + e - s,
      y: b * x + d * y + f - s,
      width: 2 * s,
      height: 2 * s,
    });
  };
  const addBox = (matrix: Matrix, { x, y, width, height }: Rect, size: number) => {
    addPoint(matrix, x, y, size);
    addPoint(matrix, x + width, y, size);
    addPoint(matrix, x, y + height, size);
    addPoint(matrix, x + width, y + height, size);
  };
  const visit = (items: Primitive[], outer: Matrix) => {
    for (const p of items) {
      if (p.kind === 'group') {
        const matrix = p.transform ? multiply(outer, p.transform) : outer;
        // Nothing shows outside a clip, however far the content reaches.
        if (p.clip) addBox(matrix, p.clip, 0);
        else visit(p.children, matrix);
      } else if (p.kind === 'rect' || p.kind === 'image') {
        const box = { x: p.x, y: p.y, width: p.w, height: p.h };
        addBox(outer, box, p.kind === 'rect' ? strokeOf(p) : 0);
      } else if (p.kind === 'text') {
        for (const run of p.runs) {
          const width = run.width ?? run.text.length * run.font.size * 0.6;
          const box = {
            x: p.x + run.x,
            y: p.y + run.y - run.font.size,
            width,
            height: run.font.size,
          };
          addBox(outer, box, 0);
        }
      } else if (p.kind === 'path') {
        const s = strokeOf(p);
        for (const [x, y] of pathPoints(p.d)) addPoint(outer, x, y, s);
      }
    }
  };
  visit(primitives, translate(0, 0));
  return unionRects(rects);
}

function strokeOf(p: { stroke?: string; strokeWidth?: number }): number {
  return p.stroke ? (p.strokeWidth ?? 1) / 2 : 0;
}
