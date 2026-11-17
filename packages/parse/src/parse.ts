import type { MarkmapNode, SourceRange } from '@markmap/core';
import type { Root } from 'mdast';
import { type PluggableList } from 'unified';
import { parse as parseYaml } from 'yaml';
import { parseMdast } from './pipeline';
import { toTree } from './to-tree';

export interface ParseOptions {
  /** Extra unified plugins, applied after the built-in ones (gfm, frontmatter, highlight, references). */
  plugins?: PluggableList;
}

export interface ParseResult {
  root: MarkmapNode;
  /** Parsed YAML frontmatter. Markmap options live under `markmap`; validate them with the theme in use. */
  frontmatter: Record<string, unknown>;
  /** Whether GFM was applied. It is skipped when the browser cannot run it, see `parseMdast`. */
  gfm: boolean;
  /** Whether a non-empty frontmatter title exists. A promoted body heading still wins for the root label. */
  hasTitle: boolean;
  /** First offset after frontmatter, or the source length when the body is empty. */
  bodyStart: number;
  /** Top-level raw HTML blocks with their source ranges. */
  htmlBlocks: HtmlBlock[];
}

export interface HtmlBlock {
  range: SourceRange;
  value: string;
}

export function parse(markdown: string, options: ParseOptions = {}): ParseResult {
  const { mdast, gfm } = parseMdast(markdown, options.plugins ?? []);
  const frontmatter = readFrontmatter(mdast);
  const title = typeof frontmatter.title === 'string' ? frontmatter.title : undefined;
  return {
    root: toTree(mdast, { title, plugins: options.plugins }),
    frontmatter,
    gfm,
    hasTitle: Boolean(title),
    bodyStart: readBodyStart(markdown, mdast),
    htmlBlocks: readHtmlBlocks(mdast),
  };
}

function readBodyStart(markdown: string, mdast: Root): number {
  let start = markdown.startsWith('\uFEFF') ? 1 : 0;
  const frontmatter = mdast.children.find((child) => child.type === 'yaml');
  if (frontmatter) {
    const end = frontmatter.position?.end.offset ?? start;
    start = end;
    if (markdown.startsWith('\r\n', start)) start += 2;
    else if (markdown[start] === '\n') start += 1;
  }
  const offset = Math.max(0, Math.min(start, markdown.length));
  return markdown.slice(offset).trim() ? offset : markdown.length;
}

function readHtmlBlocks(mdast: Root): HtmlBlock[] {
  const blocks: HtmlBlock[] = [];
  for (const child of mdast.children) {
    if (child.type !== 'html') continue;
    const start = child.position?.start.offset;
    const end = child.position?.end.offset;
    if (start == null || end == null) continue;
    blocks.push({ range: { start, end }, value: child.value });
  }
  return blocks;
}

function readFrontmatter(mdast: Root): Record<string, unknown> {
  const node = mdast.children.find((child) => child.type === 'yaml');
  if (!node) return {};
  try {
    const data: unknown = parseYaml(node.value);
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
