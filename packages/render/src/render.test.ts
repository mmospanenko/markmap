import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Layout, type MarkmapNode, type Primitive, unionRects } from '@markmap/core';
import { parse } from '@markmap/parse';
import { describe, expect, it } from 'vitest';
import {
  approximateMeasurer,
  classicTheme,
  interpolateStates,
  layoutTree,
  orgChartLayout,
  primitiveBounds,
  primitivesToSVG,
  renderTree,
  toSVGString,
  twoSidedLayout,
} from '.';

const sample = readFileSync(join(import.meta.dirname, '../test/sample.md'), 'utf8');
const render = (md: string, folded?: Set<string>) =>
  renderTree(parse(md).root, { measurer: approximateMeasurer, folded, wrapWidth: 240 });

const overlaps = (a: { y: number; height: number }, b: { y: number; height: number }) =>
  a.y < b.y + b.height && b.y < a.y + a.height;

describe('layoutTree', () => {
  const { layout } = render(sample);

  it('places children to the right of their parent', () => {
    for (const item of layout.nodes) {
      for (const child of item.children) {
        expect(child.rect.x).toBeGreaterThanOrEqual(item.rect.x + item.rect.width + 80);
      }
    }
  });

  it('keeps nodes in the same column from overlapping', () => {
    const columns = Map.groupBy(layout.nodes, (item) => item.rect.x);
    for (const column of columns.values()) {
      const sorted = column.toSorted((a, b) => a.rect.y - b.rect.y);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(overlaps(sorted[i - 1].rect, sorted[i].rect)).toBe(false);
      }
    }
  });

  it('links every visible child to its parent and grows to the right', () => {
    for (const item of layout.nodes.slice(1)) {
      expect(item.parent?.children).toContain(item);
      expect(item.rect.x).toBeGreaterThan(item.parent!.rect.x + item.parent!.rect.width);
    }
    expect(layout.nodes.every((item) => item.direction === 'right')).toBe(true);
  });

  it('hides the children of folded nodes', () => {
    const root = parse(sample).root;
    const section = root.children[1];
    const folded = renderTree(root, {
      measurer: approximateMeasurer,
      folded: new Set([section.id]),
    });
    const item = folded.layout.byId.get(section.id)!;
    expect(item.folded).toBe(true);
    expect(item.children).toEqual([]);
    expect(folded.layout.byId.has(section.children[0].id)).toBe(false);
  });

  it('requires a size for every visible node', () => {
    const root: MarkmapNode = {
      id: 'root',
      type: 'root',
      content: [],
      notes: [],
      data: {},
      children: [],
    };
    expect(() => layoutTree(root, { sizes: new Map() })).toThrow(/Missing size/);
  });
});

describe('renderTree', () => {
  it('draws edges under nodes with stable keys', () => {
    const { primitives, layout } = render(sample);
    const keys = primitives.map((p) => (p.kind === 'group' ? p.key : undefined));
    const edgeCount = layout.nodes.length - 1;
    expect(keys.filter((k) => k?.startsWith('edge:'))).toHaveLength(edgeCount);
    expect(keys.slice(edgeCount).every((k) => k?.startsWith('node:'))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('draws fold circles only on nodes with children', () => {
    const { primitives } = render('- a\n  - b');
    const circles = (id: string) =>
      primitives
        .filter((p) => p.kind === 'group' && p.key === `node:${id}`)
        .flatMap((p) => (p as Extract<Primitive, { kind: 'group' }>).children)
        .filter((p) => p.kind === 'rect');
    const root = parse('- a\n  - b').root;
    expect(circles(root.children[0].id)).toHaveLength(1);
    expect(circles(root.children[0].children[0].id)).toHaveLength(0);
  });

  it('includes strokes and fold circles in the bounds', () => {
    const { bounds, layout } = render(sample);
    expect(bounds.x).toBeLessThanOrEqual(layout.bounds.x);
    expect(bounds.x + bounds.width).toBeGreaterThan(layout.bounds.x + layout.bounds.width);
  });

  it('measures path control points for bounds', () => {
    const bounds = primitiveBounds([
      {
        kind: 'group',
        transform: [1, 0, 0, 1, 10, 20],
        children: [{ kind: 'path', d: 'M0,0H5V7C1,2,3,4,9,-3', stroke: 'red', strokeWidth: 2 }],
      },
    ]);
    expect(bounds).toEqual({ x: 9, y: 16, width: 11, height: 12 });
  });
});

describe('toSVGString', () => {
  it('renders the sample', async () => {
    const svg = toSVGString(render(sample));
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).toContain('--mm-branch-0:#1f77b4;');
    expect(svg).not.toContain('NaN');
    await expect(svg).toMatchFileSnapshot('../test/snapshots/sample.svg');
  });

  it('[TC-1-23-16] serializes dash arrays only for stroked primitives', () => {
    const svg = primitivesToSVG([
      {
        kind: 'rect',
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        fill: 'red',
        stroke: 'blue',
        strokeDashArray: [5, 4],
      },
      { kind: 'path', d: 'M0,0H2', stroke: 'green' },
      { kind: 'rect', x: 2, y: 2, w: 1, h: 1, fill: 'red', strokeDashArray: [5, 4] },
    ]);
    expect(svg).toBe(
      '<rect x="0" y="0" width="1" height="1" style="fill:red;stroke:blue;stroke-dasharray:5 4"/><path d="M0,0H2" style="fill:none;stroke:green"/><rect x="2" y="2" width="1" height="1" style="fill:red"/>',
    );
  });

  it('escapes text and attributes', () => {
    const svg = toSVGString(render('- 1 < 2 & "a" \'b\' [x](https://a.b/?q=1&r=2)'));
    expect(svg).toContain('1 &lt; 2 &amp; &quot;a&quot; &#39;b&#39;');
    expect(svg).toContain('href="https://a.b/?q=1&amp;r=2"');
  });

  it('emits hit areas only when interactive', () => {
    const hit: Primitive = { kind: 'hit', action: 'x', rect: { x: 1, y: 2, width: 3, height: 4 } };
    expect(primitivesToSVG([hit])).toBe('');
    expect(primitivesToSVG([hit], { interactive: true })).toBe(
      '<rect x="1" y="2" width="3" height="4" data-action="x" style="fill:transparent;cursor:pointer"/>',
    );
  });

  it('finds bounds through scaled and flipped groups', () => {
    const path: Primitive = { kind: 'path', d: 'M0,0H1000V500', fill: 'red' };
    const group: Primitive = {
      kind: 'group',
      transform: [0.01, 0, 0, -0.01, 5, 20],
      children: [path],
    };
    const bounds = primitiveBounds([group]);
    expect(bounds.x).toBeCloseTo(5);
    expect(bounds.y).toBeCloseTo(15);
    expect(bounds.width).toBeCloseTo(10);
    expect(bounds.height).toBeCloseTo(5);
  });

  it('stops bounds at a clip', () => {
    const path: Primitive = { kind: 'path', d: 'M-500,0H500', fill: 'red' };
    const clip = { x: 0, y: 0, width: 10, height: 5 };
    expect(primitiveBounds([{ kind: 'group', clip, children: [path] }])).toEqual(clip);
  });

  it('clips groups with a nested svg', () => {
    const group: Primitive = {
      kind: 'group',
      clip: { x: 1, y: 2, width: 3, height: 4 },
      children: [{ kind: 'path', d: 'M0,0', stroke: 'red' }],
    };
    expect(primitivesToSVG([group])).toBe(
      '<g><svg x="1" y="2" width="3" height="4" viewBox="1 2 3 4"><path d="M0,0" style="fill:none;stroke:red"/></svg></g>',
    );
  });

  it('skips primitives for other backends and overlays', () => {
    const result = render('- a');
    result.primitives.push(
      { kind: 'rect', x: 0, y: 0, w: 1, h: 1, backends: ['canvas'] },
      {
        kind: 'overlay',
        rect: { x: 0, y: 0, width: 1, height: 1 },
        html: () => ({}) as HTMLElement,
      },
      { kind: 'custom', svg: () => '<circle id="custom"/>' },
    );
    const svg = toSVGString(result);
    expect(svg).toContain('<circle id="custom"/>');
    expect(svg).not.toContain('width="1"');
  });
});

describe('custom layouts', () => {
  it('uses the layout and its node directions for edges and fold toggles', () => {
    const root = parse('# R\n\n- a\n  - a1').root;
    // The tree layout, mirrored: everything grows to the left.
    const mirrored: Layout = {
      name: 'mirrored',
      layout(tree, options) {
        const result = layoutTree(tree, options);
        for (const item of result.nodes) {
          item.rect = { ...item.rect, x: -item.rect.x - item.rect.width };
          item.direction = 'left';
        }
        return { ...result, bounds: unionRects(result.nodes.map((n) => n.rect)) };
      },
    };
    const { layout, primitives } = renderTree(root, {
      measurer: approximateMeasurer,
      layout: mirrored,
    });
    const [r, a] = layout.nodes;
    expect(a.rect.x + a.rect.width).toBeLessThan(r.rect.x);
    const edge = primitives.find((p) => p.kind === 'group' && p.key === `edge:${a.node.id}`);
    const d = edge?.kind === 'group' && edge.children[0].kind === 'path' ? edge.children[0].d : '';
    // From the root's left end to the child's right end.
    expect(d.startsWith(`M${r.rect.x},`)).toBe(true);
    expect(d).toContain(`,${a.rect.x + a.rect.width},`);
  });
});

describe('group boundaries', () => {
  it('[TC-1-23-1] renders group boundary as underlay behind nodes and lines with label text', () => {
    const root = parse('# Root\n\n- A\n  - A1\n- B').root;
    const aNode = root.children[0];
    const { primitives } = renderTree(root, {
      measurer: approximateMeasurer,
      groups: [{ id: 'g1', roots: [aNode.id], label: 'Alpha' }],
    });
    const underlay = primitives[0];
    expect(underlay.kind).toBe('group');
    if (underlay.kind !== 'group') throw new Error('Not group');
    expect(underlay.key).toBe('group:g1');
    expect(underlay.groupId).toBe('g1');
    expect(underlay.children).toHaveLength(2);
    expect(underlay.children[0].kind).toBe('rect');
    expect(underlay.children[1].kind).toBe('text');
  });

  it('[TC-1-23-2] computes bounding box enclosing all visible nodes in group subtree', () => {
    const root = parse('# Root\n\n- A\n  - A1\n  - A2\n- B').root;
    const aNode = root.children[0];
    const { layout, state } = renderTree(root, {
      measurer: approximateMeasurer,
      groups: [{ id: 'g1', roots: [aNode.id] }],
    });
    const aItem = layout.byId.get(aNode.id);
    const a1Item = layout.byId.get(aNode.children[0].id);
    const a2Item = layout.byId.get(aNode.children[1].id);
    if (!aItem || !a1Item || !a2Item) throw new Error('Nodes missing in layout');
    const aRect = aItem.rect;
    const a1Rect = a1Item.rect;
    const a2Rect = a2Item.rect;
    const group = state.groups?.[0];
    if (!group) throw new Error('Group missing');
    expect(group.rect.x).toBeLessThan(aRect.x);
    expect(group.rect.x + group.rect.width).toBeGreaterThanOrEqual(
      Math.max(a1Rect.x + a1Rect.width, a2Rect.x + a2Rect.width),
    );
  });

  it('[TC-1-23-3] uses layout-aware padding for tree, two-sided and org-chart', () => {
    const root = parse('# Root\n\n- A\n  - A1').root;
    const aNode = root.children[0];
    const treeRes = renderTree(root, {
      measurer: approximateMeasurer,
      groups: [{ id: 'g1', roots: [aNode.id] }],
    });
    const orgRes = renderTree(root, {
      measurer: approximateMeasurer,
      layout: orgChartLayout,
      groups: [{ id: 'g1', roots: [aNode.id] }],
    });
    const twoRes = renderTree(root, {
      measurer: approximateMeasurer,
      layout: twoSidedLayout,
      groups: [{ id: 'g1', roots: [aNode.id] }],
    });
    const treeGroup = treeRes.state.groups?.[0];
    const orgGroup = orgRes.state.groups?.[0];
    const twoGroup = twoRes.state.groups?.[0];
    if (!treeGroup || !orgGroup || !twoGroup) throw new Error('Groups missing');
    expect(treeGroup.rect.height).not.toBe(orgGroup.rect.height);
    expect(twoGroup.rect).toBeDefined();
  });

  it('[TC-1-23-4] hides group boundary when root or ancestor is folded', () => {
    const root = parse('# Root\n\n- A\n  - A1\n- B').root;
    const aNode = root.children[0];
    const foldedRoot = renderTree(root, {
      measurer: approximateMeasurer,
      folded: new Set(['root']),
      groups: [{ id: 'g1', roots: [aNode.id] }],
    });
    expect(foldedRoot.state.groups).toHaveLength(0);

    const foldedA = renderTree(root, {
      measurer: approximateMeasurer,
      folded: new Set([aNode.id]),
      groups: [{ id: 'g1', roots: [aNode.id] }],
    });
    expect(foldedA.state.groups).toHaveLength(0);
  });

  it('[TC-1-23-5] draws rounded rectangle with accent border and semi-transparent fill tokens', () => {
    const root = parse('# Root\n\n- A').root;
    const aNode = root.children[0];
    const { primitives } = renderTree(root, {
      measurer: approximateMeasurer,
      groups: [{ id: 'g1', roots: [aNode.id] }],
    });
    const rect = primitives[0].kind === 'group' ? primitives[0].children[0] : null;
    expect(rect).toMatchObject({
      kind: 'rect',
      r: 8,
      fill: 'var(--mm-group-fill)',
      stroke: 'var(--mm-group-border)',
      strokeWidth: 1.5,
    });
  });

  it('[TC-1-23-15] draws group boundaries with a dashed border and preserves their fill', () => {
    const root = parse('# Root\n\n- A').root;
    const aNode = root.children[0];
    const { primitives } = renderTree(root, {
      measurer: approximateMeasurer,
      groups: [{ id: 'g1', roots: [aNode.id] }],
    });
    const rect = primitives[0].kind === 'group' ? primitives[0].children[0] : null;
    expect(rect).toMatchObject({
      kind: 'rect',
      fill: 'var(--mm-group-fill)',
      stroke: 'var(--mm-group-border)',
      strokeDashArray: [5, 4],
    });
  });

  it('[TC-1-23-6] interpolates group boundaries across animation frames', () => {
    const root = parse('# Root\n\n- A').root;
    const aNode = root.children[0];
    const state1 = renderTree(root, {
      measurer: approximateMeasurer,
      groups: [{ id: 'g1', roots: [aNode.id] }],
    }).state;
    const g1 = state1.groups?.[0];
    if (!g1) throw new Error('Missing group in state1');
    const state2 = {
      ...state1,
      groups: [{ ...g1, rect: { x: 100, y: 100, width: 200, height: 200 } }],
    };
    const interpolated = interpolateStates(state1, state2, 0.5, classicTheme);
    const interpGroup = interpolated.groups?.[0];
    if (!interpGroup) throw new Error('Missing group in interpolated state');
    expect(interpGroup.rect.x).toBe((g1.rect.x + 100) / 2);
  });
});

describe('relationship edges', () => {
  const tree = parse('# Root\n\n- Node A\n- Node B\n- Node C\n  - Sub C').root;
  const a = tree.children[0];
  const b = tree.children[1];
  const c = tree.children[2];
  const subC = c?.children[0];

  it('[TC-2-31-1] renders relationship arrow overlay with curve, arrowhead and centered label with tokens', () => {
    if (!a || !b) throw new Error('Nodes missing');
    const graph = {
      edges: [{ from: 'a', to: 'b', label: 'relates to' }],
      groups: [],
      block: null,
    };
    const identities = new Map([
      ['a', a.id],
      ['b', b.id],
    ]);
    const result = renderTree(tree, {
      measurer: approximateMeasurer,
      graph,
      identities,
    });
    const rel = result.primitives.find((p) => p.kind === 'group' && p.key === 'relation:a:b');
    expect(rel).toBeDefined();
    if (!rel || rel.kind !== 'group') throw new Error('No relation group');
    expect(rel.children.length).toBeGreaterThanOrEqual(3);
    const curve = rel.children[0];
    const hit = rel.children[1];
    const arrow = rel.children[2];
    const rect = rel.children[3];
    const text = rel.children[4];
    expect(curve.kind).toBe('path');
    const pathCurve = curve.kind === 'path' ? curve : undefined;
    expect(pathCurve?.d).toMatch(/^M\d+(\.\d+)?,.*C.*$/);
    expect(pathCurve?.stroke).toBe('var(--mm-edge-relation, #8c959f)');
    expect(pathCurve?.strokeDashArray).toEqual([5, 4]);
    expect(hit.kind).toBe('group');
    if (hit.kind !== 'group') throw new Error('No relation hit group');
    expect(hit.key).toBe('relation-hit:a:b');
    expect(hit.children[0]).toMatchObject({
      kind: 'path',
      stroke: 'transparent',
      strokeWidth: 10,
    });
    if (hit.children[0]?.kind !== 'path') throw new Error('No relation hit path');
    expect(hit.children[0].strokeDashArray).toBeUndefined();
    expect(arrow.kind).toBe('path');
    const pathArrow = arrow.kind === 'path' ? arrow : undefined;
    expect(pathArrow?.d).toMatch(/^M\d+(\.\d+)?,.*L.*L.*Z$/);
    expect(pathArrow?.fill).toBe('var(--mm-edge-relation, #8c959f)');
    expect(pathArrow?.strokeDashArray).toBeUndefined();
    expect(rect.kind).toBe('rect');
    const rectShape = rect.kind === 'rect' ? rect : undefined;
    expect(rectShape?.fill).toBe('var(--mm-bg, #ffffff)');
    expect(rectShape?.stroke).toBe('var(--mm-edge-relation, #8c959f)');
    expect(text.kind).toBe('text');
    const textShape = text.kind === 'text' ? text : undefined;
    expect(textShape?.runs[0]?.text).toBe('relates to');
    expect(textShape?.runs[0]?.fill).toBe('var(--mm-edge-relation-label, #57606a)');
    const svg = primitivesToSVG(result.primitives);
    expect(svg).toContain('stroke-dasharray:5 4');
    expect(svg).toContain('fill:var(--mm-edge-relation, #8c959f)');
  });

  it('[TC-2-31-2] hides relationship edge when endpoint is folded', () => {
    if (!a || !b) throw new Error('Nodes missing');
    const graph = {
      edges: [{ from: 'a', to: 'b', label: null }],
      groups: [],
      block: null,
    };
    const identities = new Map([
      ['a', a.id],
      ['b', b.id],
    ]);
    const result = renderTree(tree, {
      measurer: approximateMeasurer,
      graph,
      identities,
      folded: new Set([b.id]),
    });
    const rel = result.primitives.find((p) => p.kind === 'group' && p.key === 'relation:a:b');
    expect(rel).toBeUndefined();
  });

  it('[TC-2-31-3] hides relationship edge when ancestor of endpoint is folded', () => {
    if (!a || !c || !subC) throw new Error('Nodes missing');
    const graph = {
      edges: [{ from: 'a', to: 'sub', label: null }],
      groups: [],
      block: null,
    };
    const identities = new Map([
      ['a', a.id],
      ['sub', subC.id],
    ]);
    const result = renderTree(tree, {
      measurer: approximateMeasurer,
      graph,
      identities,
      folded: new Set([c.id]),
    });
    const rel = result.primitives.find((p) => p.kind === 'group' && p.key === 'relation:a:sub');
    expect(rel).toBeUndefined();
  });

  it('[TC-2-31-4] keys relationship group with relation:from:to', () => {
    if (!a || !b) throw new Error('Nodes missing');
    const graph = {
      edges: [{ from: 'a', to: 'b', label: null }],
      groups: [],
      block: null,
    };
    const identities = new Map([
      ['a', a.id],
      ['b', b.id],
    ]);
    const result = renderTree(tree, {
      measurer: approximateMeasurer,
      graph,
      identities,
    });
    const rel = result.primitives.find((p) => p.kind === 'group' && p.key?.startsWith('relation:'));
    expect(rel?.kind === 'group' ? rel.key : undefined).toBe('relation:a:b');
  });

  it('[TC-2-31-5] renders edge without label when label is null', () => {
    if (!a || !b) throw new Error('Nodes missing');
    const graph = {
      edges: [{ from: 'a', to: 'b', label: null }],
      groups: [],
      block: null,
    };
    const identities = new Map([
      ['a', a.id],
      ['b', b.id],
    ]);
    const result = renderTree(tree, {
      measurer: approximateMeasurer,
      graph,
      identities,
    });
    const rel = result.primitives.find((p) => p.kind === 'group' && p.key === 'relation:a:b');
    if (!rel || rel.kind !== 'group') throw new Error('No relation group');
    expect(rel.children).toHaveLength(3);
    expect(rel.children[1]?.kind).toBe('group');
    expect(rel.children.some((p) => p.kind === 'text')).toBe(false);
  });
});
