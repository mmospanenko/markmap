import type { Root } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { type PluggableList, unified } from 'unified';
import { remarkHtmlImages } from './html-image';
import { remarkMark } from './mark';
import { remarkResolveReferences } from './plugins';

const BOM = '\uFEFF';

/**
 * GFM depends on the most third-party code, and old browsers reject syntax it may use, like
 * regex lookbehind before Safari 16.4. A map without GFM is better than no map at all.
 */
export function parseMdast(
  markdown: string,
  plugins: PluggableList,
  gfm = true,
): { mdast: Root; gfm: boolean } {
  const processor = unified()
    .use(remarkParse)
    .use(gfm ? [remarkGfm] : [])
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkHtmlImages)
    .use(remarkMark)
    .use(remarkResolveReferences)
    .use(plugins);
  try {
    const tree = processor.parse(markdown);
    if (markdown.startsWith(BOM)) shiftOffsets(tree);
    const mdast = processor.runSync(tree);
    if (!isRoot(mdast)) throw new SyntaxError('The parser did not return a root');
    return { mdast, gfm };
  } catch (error) {
    if (!gfm || !(error instanceof SyntaxError)) throw error;
    return parseMdast(markdown, plugins, false);
  }
}

function shiftOffsets(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) shiftOffsets(child);
    return;
  }
  if (!isRecord(value)) return;
  shiftPosition(value.position);
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'position') shiftOffsets(child);
  }
}

function shiftPosition(position: unknown): void {
  if (!isRecord(position)) return;
  shiftPoint(position.start);
  shiftPoint(position.end);
}

function shiftPoint(point: unknown): void {
  if (!isRecord(point)) return;
  if (typeof point.offset === 'number') point.offset += 1;
  if (point.line === 1 && typeof point.column === 'number') point.column += 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRoot(value: unknown): value is Root {
  if (typeof value !== 'object' || value === null) return false;
  if (!('type' in value) || value.type !== 'root') return false;
  return 'children' in value;
}
