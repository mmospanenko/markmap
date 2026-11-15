import type { MarkmapNode } from '@markmap/core';
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
}

export function parse(markdown: string, options: ParseOptions = {}): ParseResult {
  const { mdast, gfm } = parseMdast(markdown, options.plugins ?? []);
  const frontmatter = readFrontmatter(mdast);
  const title = typeof frontmatter.title === 'string' ? frontmatter.title : undefined;
  return { root: toTree(mdast, { title, plugins: options.plugins }), frontmatter, gfm };
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
