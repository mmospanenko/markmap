import type { Anchor, LabelStyle, Point, Primitive, Theme } from '@markmap/core';
import { validators } from '@markmap/core';
import { type BranchColorOptions, branchColors, branchIndex, DEFAULT_COLORS } from './branch';
import {
  alignFor,
  CODE_FONT,
  CONTENT_TOKENS,
  DARK_CONTENT_TOKENS,
  sCurve,
  SYSTEM_FONT,
} from './shared';

const LIGHT_COLORS = ['#dc7768', '#9c6c9d', '#7369a1', '#cb9c40', '#77a76b', '#6c95bd'];

const DARK_COLORS = ['#e39487', '#c08bb6', '#9b93c9', '#dbb76c', '#93c287', '#86aed0'];

const LIGHT_TEXT = '#2b3138';
const DARK_TEXT = '#e8edf4';
const LIGHT_BG = '#ffffff';
const DARK_BG = '#1e1e1e';
const LIGHT_TINT = 'rgba(255,255,255,0.91)';
const DARK_TINT = 'rgba(30,30,30,0.88)';
const LIGHT_ROOT_BG = '#344456';
const DARK_ROOT_BG = '#405267';
const ROOT_TEXT = '#ffffff';
const LIGHT_TOGGLE = '#7b8798';
const DARK_TOGGLE = '#9aa6b6';

const ROOT_FONT: Theme['font'] = { ...SYSTEM_FONT, size: 20, weight: 600, lineHeight: 26 };
const TOPIC_FONT: Theme['font'] = { ...SYSTEM_FONT, size: 16, weight: 500, lineHeight: 22 };
const LEAF_FONT: Theme['font'] = { ...SYSTEM_FONT, size: 14, weight: 400, lineHeight: 20 };

const ROOT_PADDING: [number, number, number, number] = [14, 18, 14, 18];
const TOPIC_PADDING: [number, number, number, number] = [9, 14, 9, 14];
const LEAF_PADDING: [number, number, number, number] = [2, 4, 6, 4];

const ROOT_RADIUS = 7;
const TOPIC_RADIUS = 6;
const ROOT_EDGE_START = 5.3;
const ROOT_EDGE_END = 1.3;
const BRANCH_EDGE_WIDTH = 1.5;
const LEAF_UNDERLINE = 1.5;
const TOGGLE_RADIUS = 6;
const LEAF_BASELINE_INSET = 3;

const darkBranchTokens = Object.fromEntries(
  DARK_COLORS.map((color, index) => [`mm-branch-${index}`, color]),
);

const label = (depth: number): LabelStyle => {
  if (depth === 0) {
    return {
      font: ROOT_FONT,
      fill: 'var(--mm-soft-root-text)',
      padding: ROOT_PADDING,
    };
  }
  if (depth === 1) {
    return {
      font: TOPIC_FONT,
      fill: 'var(--mm-text)',
      padding: TOPIC_PADDING,
    };
  }
  return {
    font: LEAF_FONT,
    fill: 'var(--mm-text)',
    padding: LEAF_PADDING,
  };
};

const point = (x: number, y: number): Point => ({ x, y });

function taperedCurve(from: Anchor, to: Point, startWidth: number, endWidth: number): string {
  const vertical = from.side === 'top' || from.side === 'bottom';
  const middleX = (from.x + to.x) / 2;
  const middleY = (from.y + to.y) / 2;
  const first = vertical ? point(from.x, middleY) : point(middleX, from.y);
  const second = vertical ? point(to.x, middleY) : point(middleX, to.y);
  const left: string[] = [];
  const right: string[] = [];
  const steps = 32;
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const u = 1 - t;
    const x =
      u ** 3 * from.x + 3 * u ** 2 * t * first.x + 3 * u * t ** 2 * second.x + t ** 3 * to.x;
    const y =
      u ** 3 * from.y + 3 * u ** 2 * t * first.y + 3 * u * t ** 2 * second.y + t ** 3 * to.y;
    const dx =
      3 * u ** 2 * (first.x - from.x) +
      6 * u * t * (second.x - first.x) +
      3 * t ** 2 * (to.x - second.x);
    const dy =
      3 * u ** 2 * (first.y - from.y) +
      6 * u * t * (second.y - first.y) +
      3 * t ** 2 * (to.y - second.y);
    const length = Math.hypot(dx, dy) || 1;
    const half = (startWidth + (endWidth - startWidth) * t) / 2;
    const offsetX = (-dy / length) * half;
    const offsetY = (dx / length) * half;
    left.push(`${x + offsetX},${y + offsetY}`);
    right.push(`${x - offsetX},${y - offsetY}`);
  }
  return `M${left.join('L')}L${right.reverse().join('L')}Z`;
}

export type SoftThemeOptions = BranchColorOptions;

export function createSoftTheme(options: SoftThemeOptions = {}): Theme {
  const withDefaults = { color: LIGHT_COLORS, colorDepth: 2, ...options };
  const { tokens: branchTokens } = branchColors(withDefaults);
  const colors = withDefaults.color?.length ? withDefaults.color : DEFAULT_COLORS;
  const colorOf = (path: readonly string[], branch: number | undefined) =>
    `var(--mm-branch-${
      branch != null && withDefaults.colorDepth === 2
        ? branch % colors.length
        : branchIndex(path, colors.length, withDefaults.colorDepth)
    })`;
  const customColors = !!options.color?.length;

  return {
    name: 'soft',
    options: {
      color: validators.colors(),
      colorDepth: validators.number(0, true),
    },
    configure: (next) => createSoftTheme({ ...options, ...next }),
    tokens: {
      'mm-text': LIGHT_TEXT,
      'mm-bg': LIGHT_BG,
      'mm-soft-root-bg': LIGHT_ROOT_BG,
      'mm-soft-root-text': ROOT_TEXT,
      'mm-soft-tint': LIGHT_TINT,
      'mm-soft-toggle': LIGHT_TOGGLE,
      ...CONTENT_TOKENS,
      ...branchTokens,
    },
    darkTokens: {
      'mm-text': DARK_TEXT,
      'mm-bg': DARK_BG,
      'mm-soft-root-bg': DARK_ROOT_BG,
      'mm-soft-tint': DARK_TINT,
      'mm-soft-toggle': DARK_TOGGLE,
      ...DARK_CONTENT_TOKENS,
      ...(customColors ? {} : darkBranchTokens),
    },
    font: LEAF_FONT,
    codeFontFamily: CODE_FONT,
    textFill: 'var(--mm-text)',
    label: (_node, ctx) => label(ctx.depth),
    node: {
      padding: [...LEAF_PADDING],
      textAlign: (ctx) => (ctx.depth <= 1 ? 'center' : alignFor(ctx.direction)),
      render(node, box, ctx) {
        if (ctx.depth === 0 && node.content.length === 0) return [];
        const color = colorOf(ctx.path, ctx.branch);
        const toggle = ctx.depth === 0 ? 'var(--mm-soft-toggle)' : color;
        const chrome: Primitive[] = [];
        if (ctx.depth === 0) {
          chrome.push({
            kind: 'rect',
            x: 0,
            y: 0,
            w: box.width,
            h: box.height,
            r: ROOT_RADIUS,
            fill: 'var(--mm-soft-root-bg)',
          });
        } else if (ctx.depth === 1) {
          chrome.push(
            {
              kind: 'rect',
              x: 0,
              y: 0,
              w: box.width,
              h: box.height,
              r: TOPIC_RADIUS,
              fill: color,
            },
            {
              kind: 'rect',
              x: 0,
              y: 0,
              w: box.width,
              h: box.height,
              r: TOPIC_RADIUS,
              fill: 'var(--mm-soft-tint)',
              stroke: color,
              strokeWidth: 1.2,
            },
          );
        } else {
          const y = box.height - LEAF_BASELINE_INSET;
          chrome.push({
            kind: 'path',
            d: `M0,${y}H${box.width}`,
            stroke: color,
            strokeWidth: LEAF_UNDERLINE,
          });
        }
        if (!ctx.hasChildren) return chrome;
        const anchor =
          ctx.depth <= 1
            ? point(
                ctx.direction === 'left'
                  ? 0
                  : ctx.direction === 'right'
                    ? box.width
                    : box.width / 2,
                ctx.direction === 'top'
                  ? 0
                  : ctx.direction === 'bottom'
                    ? box.height
                    : box.height / 2,
              )
            : point(
                ctx.direction === 'left'
                  ? 0
                  : ctx.direction === 'right'
                    ? box.width
                    : box.width / 2,
                ctx.direction === 'top'
                  ? 0
                  : ctx.direction === 'bottom'
                    ? box.height
                    : box.height - LEAF_BASELINE_INSET,
              );
        chrome.push({
          kind: 'rect',
          x: anchor.x - TOGGLE_RADIUS,
          y: anchor.y - TOGGLE_RADIUS,
          w: TOGGLE_RADIUS * 2,
          h: TOGGLE_RADIUS * 2,
          r: TOGGLE_RADIUS,
          fill: ctx.folded ? toggle : 'var(--mm-bg)',
          stroke: toggle,
          strokeWidth: 1.4,
        });
        return chrome;
      },
      anchor(rect, side, ctx) {
        if (side === 'left' || side === 'right') {
          const y =
            ctx.depth <= 1 ? rect.y + rect.height / 2 : rect.y + rect.height - LEAF_BASELINE_INSET;
          return { x: side === 'left' ? rect.x : rect.x + rect.width, y, side };
        }
        return {
          x: rect.x + rect.width / 2,
          y: side === 'top' ? rect.y : rect.y + rect.height,
          side,
        };
      },
    },
    edge: {
      render: (from, to, ctx) =>
        ctx.node.depth === 1
          ? [
              {
                kind: 'path',
                d: taperedCurve(from, to, ROOT_EDGE_START, ROOT_EDGE_END),
                fill: colorOf(ctx.node.path, ctx.node.branch),
              },
            ]
          : [
              {
                kind: 'path',
                d: sCurve(from, to),
                stroke: colorOf(ctx.node.path, ctx.node.branch),
                strokeWidth: BRANCH_EDGE_WIDTH,
              },
            ],
    },
  };
}

export const softTheme: Theme = createSoftTheme();
