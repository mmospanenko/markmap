import { oppositeSide, type Primitive, type Theme } from '@markmap/core';
import { parse } from '@markmap/parse';
import { describe, expect, it } from 'vitest';
import { interpolateStates } from '../animate';
import { orgChartLayout } from '../layouts/org-chart';
import { twoSidedLayout } from '../layouts/two-sided';
import { approximateMeasurer } from '../measure';
import { builtinThemes, resolveRenderOptions } from '../options';
import { drawState, renderTree } from '../render';
import { themeCSS, toSVGString } from '../svg';
import { branchIndex } from './branch';
import { cardsTheme } from './cards';
import { classicTheme } from './classic';
import { minimalTheme } from './minimal';
import { createSoftTheme, softTheme } from './soft';

const md = '# Root\n\n- a\n  - a1\n- b\n  - b1\n- c\n  - c1';
const render = (theme: Theme, layout = twoSidedLayout, folded: string[] = []) =>
  renderTree(parse(md).root, {
    measurer: approximateMeasurer,
    theme,
    layout,
    folded: new Set(folded),
  });
const group = (primitives: Primitive[], key: string) =>
  primitives.find((p) => p.kind === 'group' && p.key === key);
const pathD = (p?: Primitive) =>
  p?.kind === 'group' && p.children[0].kind === 'path' ? p.children[0].d : '';
const branchValues = (tokens: Record<string, string>) =>
  Object.keys(tokens)
    .filter((name) => name.startsWith('mm-branch-'))
    .toSorted((left, right) => Number(left.slice(10)) - Number(right.slice(10)))
    .map((name) => tokens[name]);
const hsl = (hex: string) => {
  const channels = (hex.slice(1).match(/../gu) ?? []).map(
    (part) => Number.parseInt(part, 16) / 255,
  );
  const [red, green, blue] = channels;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (delta !== 0) {
    if (max === red) h = 60 * (((green - blue) / delta) % 6);
    else if (max === green) h = 60 * ((blue - red) / delta + 2);
    else h = 60 * ((red - green) / delta + 4);
  }
  return { h: (h + 360) % 360, s, l };
};
const luminance = (hex: string) => {
  const [red, green, blue] = (hex.slice(1).match(/../gu) ?? []).map((part) => {
    const value = Number.parseInt(part, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};
const contrast = (left: string, right: string) => {
  const [bright, dark] = [luminance(left), luminance(right)].toSorted((a, b) => b - a);
  return (bright + 0.05) / (dark + 0.05);
};
const hueBucket = ({ h }: { h: number }) => Math.floor(h / 60);
const isBrown = ({ h, s, l }: { h: number; s: number; l: number }) =>
  h >= 25 && h <= 50 && s >= 0.3 && l >= 0.35 && l <= 0.7;

describe.each([classicTheme, cardsTheme, minimalTheme])('$name theme', (theme) => {
  it('connects every edge to the anchors on both nodes, in every layout', () => {
    for (const layout of [twoSidedLayout, orgChartLayout]) {
      const result = render(theme, layout);
      for (const item of result.layout.nodes.slice(1)) {
        const ctx = result.contexts.get(item.node.id)!;
        const parent = result.contexts.get(item.parent!.node.id)!;
        const from = theme.node.anchor(item.parent!.rect, ctx.direction, parent);
        const d = pathD(group(result.primitives, `edge:${item.node.id}`));
        expect(d.startsWith(`M${from.x},${from.y}`)).toBe(true);
      }
    }
  });

  it('has dark tokens for every color that changes', () => {
    expect(Object.keys(theme.darkTokens ?? {}).length).toBeGreaterThan(0);
    for (const name of Object.keys(theme.darkTokens!)) expect(theme.tokens).toHaveProperty(name);
  });

  it('is registered under its name', () => {
    expect(builtinThemes[theme.name]).toBe(theme);
  });
});

describe('cards theme', () => {
  it('puts the fold toggle on the outer side of the card', () => {
    const result = render(cardsTheme);
    const left = result.layout.nodes.find((n) => n.direction === 'left' && n.children.length)!;
    const g = group(result.primitives, `node:${left.node.id}`);
    const toggle = g?.kind === 'group' ? g.children[1] : undefined;
    expect(toggle?.kind === 'rect' && toggle.x + toggle.w / 2).toBe(0);
  });

  it('scales nodes in and out around their center', () => {
    const open = render(cardsTheme).state;
    const a = open.nodes[1];
    const closed = render(cardsTheme, twoSidedLayout, [a.node.id]).state;
    const frame = interpolateStates(open, closed, 0.5, cardsTheme, twoSidedLayout);
    const leaving = frame.nodes.find((n) => n.presence === 0.5)!;
    const g = group(drawState(frame, cardsTheme), `node:${leaving.node.id}`);
    expect(g?.kind === 'group' && g.opacity).toBe(0.5);
    // Scale 0.8 around the center, then the node's position.
    const k = g?.kind === 'group' ? g.transform![0] : 0;
    expect(k).toBeCloseTo(0.8);
  });
});

describe('text alignment', () => {
  const long =
    '# Root\n\n- first branch\n- second branch\n- a label long enough to wrap onto lines';
  const runsX = (theme: Theme) => {
    const result = renderTree(parse(long).root, {
      measurer: approximateMeasurer,
      theme,
      layout: twoSidedLayout,
      wrapWidth: 120,
    });
    const item = result.state.nodes.find((n) => n.text.lines > 1)!;
    return { item, xs: item.text.runs.map((r) => r.x) };
  };

  it('right-aligns wrapped labels on the left side', () => {
    const { item, xs } = runsX(classicTheme);
    expect(item.ctx.direction).toBe('left');
    expect(new Set(xs).size).toBeGreaterThan(1);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
  });
});

describe('theme CSS', () => {
  it('emits light, forced dark, or a media query', () => {
    expect(themeCSS(classicTheme)).not.toContain('#1e1e1e');
    expect(themeCSS(classicTheme, 'dark')).toMatch(
      /\.markmap\{[^}]*--mm-bg:#fff;[^}]*\}\.markmap\{[^}]*--mm-bg:#1e1e1e;/,
    );
    expect(themeCSS(classicTheme, 'auto')).toContain(
      '@media (prefers-color-scheme: dark){.markmap{',
    );
    const svg = toSVGString(render(cardsTheme), { colorScheme: 'auto' });
    expect(svg).toContain('prefers-color-scheme');
  });
});

describe('soft theme', () => {
  const nodeAt = (result: ReturnType<typeof render>, depth: number) =>
    result.state.nodes.find((item) => item.ctx.depth === depth)!;
  const chromeOf = (result: ReturnType<typeof render>, id: string) => {
    const item = group(result.primitives, `node:${id}`);
    return item?.kind === 'group' ? item.children : [];
  };
  const edgeOf = (result: ReturnType<typeof render>, id: string) => {
    const item = group(result.primitives, `edge:${id}`);
    return item?.kind === 'group' ? item.children[0] : undefined;
  };
  const colorOfEdge = (edge: Primitive | undefined) =>
    edge?.kind === 'path' ? (edge.fill ?? edge.stroke) : undefined;

  it('[TC-4-1-1] resolves label font, fill and padding by depth before measurement', () => {
    const result = render(softTheme);
    const root = nodeAt(result, 0);
    const topic = nodeAt(result, 1);
    const leaf = nodeAt(result, 2);

    expect(root.text.runs[0]).toMatchObject({
      font: { size: 20, weight: 600, lineHeight: 26 },
      fill: 'var(--mm-soft-root-text)',
    });
    expect(topic.text.runs[0]).toMatchObject({
      font: { size: 16, weight: 500, lineHeight: 22 },
      fill: 'var(--mm-text)',
    });
    expect(leaf.text.runs[0]).toMatchObject({
      font: { size: 14, weight: 400, lineHeight: 20 },
      fill: 'var(--mm-text)',
    });
    expect(root.rect.height).toBeGreaterThan(topic.rect.height);
    expect(topic.rect.height).toBeGreaterThan(leaf.rect.height);
  });

  it('[TC-4-1-2] draws root and topic blocks and a leaf underline', () => {
    const result = render(softTheme);
    const root = nodeAt(result, 0);
    const topic = nodeAt(result, 1);
    const leaf = nodeAt(result, 2);
    const rootChrome = chromeOf(result, root.node.id);
    const topicChrome = chromeOf(result, topic.node.id);
    const leafChrome = chromeOf(result, leaf.node.id);

    expect(rootChrome[0]).toMatchObject({
      kind: 'rect',
      fill: 'var(--mm-soft-root-bg)',
      r: 7,
    });
    expect(topicChrome[0]).toMatchObject({ kind: 'rect', r: 6 });
    expect(topicChrome[1]).toMatchObject({
      kind: 'rect',
      fill: 'var(--mm-soft-tint)',
      strokeWidth: 1.2,
    });
    expect(leafChrome[0]).toMatchObject({ kind: 'path', strokeWidth: 1.5 });
    expect(leafChrome[0].kind === 'path' ? leafChrome[0].fill : 'set').toBeUndefined();

    const empty = renderTree(parse('').root, {
      measurer: approximateMeasurer,
      theme: softTheme,
    });
    const emptyRoot = empty.state.nodes[0];
    expect(
      emptyRoot && chromeOf(empty, emptyRoot.node.id).filter((item) => item.kind !== 'group'),
    ).toEqual([]);
  });

  it('[TC-4-2-1] gives each first-level branch one inherited color', () => {
    const result = render(softTheme);
    const topics = result.state.nodes.filter((item) => item.ctx.depth === 1);
    const first = topics[0];
    const second = topics[1];
    const child = result.state.nodes.find(
      (item) => item.ctx.depth === 2 && item.ctx.path[1] === first.node.id,
    )!;

    expect(colorOfEdge(edgeOf(result, first.node.id))).toBe('var(--mm-branch-0)');
    expect(colorOfEdge(edgeOf(result, second.node.id))).toBe('var(--mm-branch-1)');
    expect(colorOfEdge(edgeOf(result, child.node.id))).toBe('var(--mm-branch-0)');
  });

  it('[TC-4-2-3] balances the default branch palette with brown as one accent', () => {
    const light = branchValues(softTheme.tokens);
    const dark = branchValues(softTheme.darkTokens ?? {});
    expect(light).toHaveLength(6);
    expect(dark).toHaveLength(6);

    for (const colors of [light, dark]) {
      const measures = colors.map(hsl);
      expect(new Set(colors).size).toBe(colors.length);
      expect(new Set(measures.map(hueBucket)).size).toBe(colors.length);
      expect(measures.filter(isBrown)).toHaveLength(1);
    }
    expect(dark.map(hsl).map(hueBucket)).toEqual(light.map(hsl).map(hueBucket));
    for (const color of light) expect(contrast(color, '#ffffff')).toBeGreaterThanOrEqual(3);
    for (const color of dark) expect(contrast(color, '#1e1e1e')).toBeGreaterThanOrEqual(4.5);
  });

  it('[TC-4-3-1] tapers the root edge and keeps deeper edges thin', () => {
    const result = render(softTheme);
    const topic = nodeAt(result, 1);
    const child = result.state.nodes.find(
      (item) => item.ctx.depth === 2 && item.ctx.path[1] === topic.node.id,
    )!;
    const rootEdge = edgeOf(result, topic.node.id);
    const childEdge = edgeOf(result, child.node.id);

    expect(rootEdge).toMatchObject({ kind: 'path', fill: expect.any(String) });
    expect(rootEdge?.kind === 'path' ? rootEdge.d : '').toContain('Z');
    expect(childEdge).toMatchObject({
      kind: 'path',
      stroke: expect.any(String),
      strokeWidth: 1.5,
    });
    expect(childEdge?.kind === 'path' ? childEdge.fill : 'set').toBeUndefined();
    const source = result.state.nodes.find((item) => item.node.id === child.parentId);
    if (!source) throw new Error('Missing parent');
    const from = softTheme.node.anchor(source.rect, child.ctx.direction, source.ctx);
    const to = softTheme.node.anchor(child.rect, oppositeSide(child.ctx.direction), child.ctx);
    expect(childEdge?.kind === 'path' ? childEdge.d : '').toBe(
      `M${from.x},${from.y}C${from.x + (to.x - from.x) * 0.75},${from.y},${
        to.x - (to.x - from.x) * 0.75
      },${to.y},${to.x},${to.y}`,
    );
  });

  it('[TC-4-4-1] provides dark tokens for every branch color and the tint', () => {
    for (const name of Object.keys(softTheme.darkTokens ?? {})) {
      expect(softTheme.tokens).toHaveProperty(name);
    }
    expect(softTheme.darkTokens?.['mm-branch-0']).not.toBe(softTheme.tokens['mm-branch-0']);
    expect(softTheme.darkTokens?.['mm-soft-tint']).not.toBe(softTheme.tokens['mm-soft-tint']);
    expect(softTheme.darkTokens?.['mm-soft-root-bg']).not.toBe(softTheme.tokens['mm-soft-root-bg']);
    expect(softTheme.darkTokens?.['mm-soft-toggle']).not.toBe(softTheme.tokens['mm-soft-toggle']);
  });

  it('[TC-4-2-2] keeps color and colorDepth options on the configured theme', () => {
    const themed = createSoftTheme({ color: ['#112233'], colorDepth: 0 });
    expect(themed.tokens['mm-branch-0']).toBe('#112233');

    const rootOnly = renderTree(parse(md).root, {
      measurer: approximateMeasurer,
      theme: createSoftTheme({ colorDepth: 1 }),
    });
    const rootColor = `var(--mm-branch-${branchIndex(
      rootOnly.contexts.get(rootOnly.layout.nodes[0]?.node.id ?? '')?.path ?? [],
      6,
      1,
    )})`;
    const topics = rootOnly.state.nodes.filter((item) => item.ctx.depth === 1);
    expect(colorOfEdge(edgeOf(rootOnly, topics[0]?.node.id ?? ''))).toBe(rootColor);
    expect(colorOfEdge(edgeOf(rootOnly, topics[1]?.node.id ?? ''))).toBe(rootColor);

    const { options, warnings } = resolveRenderOptions({}, { theme: 'soft' });
    expect(options.theme?.name).toBe('soft');
    expect(warnings).toEqual([]);
  });
});

describe('theme option', () => {
  it('picks a theme by name and applies its options on top', () => {
    const { options, warnings } = resolveRenderOptions({}, { theme: 'cards', color: ['#123456'] });
    expect(options.theme?.name).toBe('cards');
    expect(options.theme?.tokens['mm-branch-0']).toBe('#123456');
    expect(warnings).toEqual([]);
  });

  it('warns about unknown themes and options the theme does not have', () => {
    expect(resolveRenderOptions({}, { theme: 'fancy' }).warnings).toEqual([
      'Unknown theme `fancy`; available: `classic`, `cards`, `minimal`, `soft`',
    ]);
    expect(resolveRenderOptions({}, { theme: 'minimal', color: '#fff' }).warnings).toEqual([
      'Unknown option `color`',
    ]);
  });
});
