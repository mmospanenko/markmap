import type { Root } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { type PluggableList, unified } from 'unified';
import { remarkHtmlImages } from './html-image';
import { remarkMark } from './mark';
import { remarkResolveReferences } from './plugins';

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
    const mdast = processor.runSync(processor.parse(markdown));
    if (!isRoot(mdast)) throw new SyntaxError('The parser did not return a root');
    return { mdast, gfm };
  } catch (error) {
    if (!gfm || !(error instanceof SyntaxError)) throw error;
    return parseMdast(markdown, plugins, false);
  }
}

function isRoot(value: unknown): value is Root {
  if (typeof value !== 'object' || value === null) return false;
  if (!('type' in value) || value.type !== 'root') return false;
  return 'children' in value;
}
