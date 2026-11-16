import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type MarkmapNode, toPlainText, walkTree } from '@markmap/core';
import type { Heading, Root } from 'mdast';
import { describe, expect, it } from 'vitest';
import { parse } from '.';

const fixtures = join(import.meta.dirname, '../test/fixtures');

/** A readable outline: one line per node, notes listed with their position. */
function outline(root: MarkmapNode): string {
  const lines: string[] = [];
  walkTree(root, (node, _parent, depth) => {
    const indent = '  '.repeat(depth);
    const data = Object.keys(node.data).length ? ` ${JSON.stringify(node.data)}` : '';
    lines.push(`${indent}- [${node.type}] ${toPlainText(node.content)}${data}`);
    for (const { block, after } of node.notes) {
      lines.push(`${indent}    @${after} ${block.type}`);
    }
  });
  return `${lines.join('\n')}\n`;
}

function idsByLabel(root: MarkmapNode): Map<string, string> {
  const map = new Map<string, string>();
  walkTree(root, (node) => void map.set(toPlainText(node.content), node.id));
  return map;
}

const copyHeadingPosition = () => (tree: Root) => {
  const headings = tree.children.filter((child): child is Heading => child.type === 'heading');
  const [source, target] = headings;
  if (!source || !target) return;
  target.position = source.position;
  target.children = source.children;
};

describe('fixtures', () => {
  const files = readdirSync(fixtures).filter((name) => name.endsWith('.md'));
  it.each(files)('%s', async (file) => {
    const { root } = parse(readFileSync(join(fixtures, file), 'utf8'));
    await expect(outline(root)).toMatchFileSnapshot(`../test/snapshots/${file}.txt`);
  });
});

describe('parse', () => {
  it('promotes a single H1 to the root', () => {
    const { root } = parse('Before.\n\n# Title\n\nAfter.\n\n## Child');
    expect(root.id).toBe('root');
    expect(toPlainText(root.content)).toBe('Title');
    expect(root.notes.map((a) => [toPlainText([a.block as never]), a.after])).toEqual([
      ['Before.', 0],
      ['After.', 0],
    ]);
  });

  it('synthesizes an empty root when there is no single H1', () => {
    const { root } = parse('- a\n- b');
    expect(root.type).toBe('root');
    expect(root.content).toEqual([]);
    expect(root.children).toHaveLength(2);
  });

  it('keeps frontmatter title bytes when a body heading wins', () => {
    const { root, frontmatter } = parse('---\ntitle: T\nfoo: 1\n---\n\n# H1');
    expect(frontmatter).toEqual({ title: 'T', foo: 1 });
    expect(root.type).toBe('heading');
    expect(toPlainText(root.content)).toBe('H1');
    expect(root.children).toHaveLength(0);
  });

  it('ignores invalid frontmatter', () => {
    expect(parse('---\n: [\n---\n\n- a').frontmatter).toEqual({});
  });

  it('keeps inline structure and drops mdast positions', () => {
    const { root } = parse('- **bold** `code`');
    expect(root.children[0].content).toEqual([
      { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
      { type: 'text', value: ' ' },
      { type: 'inlineCode', value: 'code' },
    ]);
  });

  it('records source ranges', () => {
    const md = '# A\n\n- item\n';
    const { root } = parse(md);
    const item = root.children[0];
    expect(md.slice(root.position!.start, root.position!.end)).toBe('# A');
    expect(md.slice(item.position!.start, item.position!.end)).toBe('- item');
  });

  it('[TC-1-1-1] records label and section ranges', () => {
    const md = '# A\n\n## B\n\nText.\n\n- x\n\n# C\n';
    const { root } = parse(md);
    const [a, c] = root.children;
    const b = a.children[0];
    const x = b.children[0];
    expect(a.position).toEqual({ start: 0, end: 3 });
    expect(a.source).toEqual({ label: { start: 2, end: 3 }, block: { start: 0, end: 23 } });
    expect(b.source).toEqual({ label: { start: 8, end: 9 }, block: { start: 5, end: 23 } });
    expect(x.source).toEqual({ label: { start: 20, end: 21 }, block: { start: 18, end: 21 } });
    expect(c.source?.block).toEqual({ start: 23, end: 27 });
  });

  it('[TC-1-1-2] excludes directives and trailing space from the label', () => {
    const md = '# A\n\n- a <!-- markmap: fold -->\n';
    const { root } = parse(md);
    expect(root.children[0].source?.label).toEqual({ start: 7, end: 8 });
    expect(root.children[0].data.fold).toBe(true);
  });

  it('[TC-1-1-3] leaves empty labels undefined', () => {
    const list = parse('- \n- b').root.children[0];
    expect(list.source).toEqual({ block: { start: 0, end: 2 } });
    const heading = parse('# A\n\n#').root.children[1];
    expect(heading.source).toEqual({ block: { start: 5, end: 6 } });
  });

  it('[TC-1-1-4] drops inline HTML and reads a directive', () => {
    const { root } = parse('- <b>x</b>\n\n- x <!-- markmap: fold -->\n');
    expect(toPlainText(root.children[0].content)).toBe('x');
    expect(root.children[1].data.fold).toBe(true);
    expect(toPlainText(root.children[1].content)).toBe('x');
  });

  it('keeps ids stable when unrelated content changes', () => {
    const before = parse('# T\n\n## A\n\n- x\n\n## B\n\n- y').root;
    const after = parse('# Renamed\n\n## New\n\n## A\n\nNote.\n\n- x\n\n## B\n\n- y').root;
    const [a, b] = [idsByLabel(before), idsByLabel(after)];
    for (const label of ['A', 'x', 'B', 'y']) expect(b.get(label)).toBe(a.get(label));
  });

  it('gives duplicate siblings and their subtrees distinct ids', () => {
    const { root } = parse(readFileSync(join(fixtures, 'duplicates.md'), 'utf8'));
    const ids: string[] = [];
    walkTree(root, (node) => void ids.push(node.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('serializes to JSON and back unchanged', () => {
    const { root } = parse(readFileSync(join(fixtures, 'notes.md'), 'utf8'));
    expect(JSON.parse(JSON.stringify(root))).toEqual(root);
  });

  it('accepts extra unified plugins', () => {
    const { root } = parse('- a', {
      plugins: [
        () => (tree: { children: { type: string }[] }) => {
          tree.children.push({ type: 'thematicBreak' });
        },
      ],
    });
    expect(root.notes[0].block.type).toBe('thematicBreak');
  });
});

/** Throw `error` from the first parse only, which is the one with GFM. */
function failOnce(error: Error) {
  let failed = false;
  return () => () => {
    if (failed) return;
    failed = true;
    throw error;
  };
}

const alwaysFail = () => () => {
  throw new SyntaxError('always');
};

describe('root promotion', () => {
  it('[TC-1-17-1] promotes exactly one top-level heading at any depth', () => {
    const cases = [
      ['# A\n', 1],
      ['## A\n', 2],
      ['### A\n', 3],
      ['###### A\n', 6],
    ] as const;
    for (const [markdown, depth] of cases) {
      const { root } = parse(markdown);
      expect(root.type).toBe('heading');
      expect(root.data.depth).toBe(depth);
      expect(toPlainText(root.content)).toBe('A');
      expect(root.source?.block).toEqual({ start: 0, end: markdown.length });
      expect(root.source?.label).toEqual({ start: depth + 1, end: depth + 2 });
    }
  });

  it('[TC-1-17-2] keeps children and notes of a promoted H2 or H3', () => {
    const markdown = '## A\n\nIntro.\n\n- x\n  - y\n';
    const { root } = parse(markdown);
    expect(root.type).toBe('heading');
    expect(root.data.depth).toBe(2);
    expect(toPlainText(root.content)).toBe('A');
    expect(root.children.map((child) => toPlainText(child.content))).toEqual(['x']);
    expect(root.notes).toHaveLength(1);
    const note = root.notes[0];
    if (!note?.source) throw new Error('No note source');
    expect(markdown.slice(note.source.start, note.source.end)).toBe('Intro.');

    const deep = parse('### A\n\n#### B\n').root;
    expect(deep.type).toBe('heading');
    expect(deep.data.depth).toBe(3);
    expect(deep.children[0]?.data.depth).toBe(4);
  });

  it('[TC-1-17-3] keeps a title without a heading, multiple headings and a leading list unpromoted', () => {
    const title = parse('---\ntitle: T\n---\n\n- a\n').root;
    expect(title.type).toBe('root');
    expect(toPlainText(title.content)).toBe('T');
    expect(title.children.map((child) => toPlainText(child.content))).toEqual(['a']);

    const titledTwo = parse('---\ntitle: T\n---\n\n## A\n\n## B\n').root;
    expect(titledTwo.type).toBe('root');
    expect(toPlainText(titledTwo.content)).toBe('T');
    expect(titledTwo.children.map((child) => toPlainText(child.content))).toEqual(['A', 'B']);

    const two = parse('## A\n\n## B\n').root;
    expect(two.type).toBe('root');
    expect(two.children.map((child) => toPlainText(child.content))).toEqual(['A', 'B']);

    const list = parse('- a\n\n## B\n').root;
    expect(list.type).toBe('root');
    expect(list.children.map((child) => toPlainText(child.content))).toEqual(['a', 'B']);
  });

  it('[TC-1-17-7] promotes a single heading even with a frontmatter title', () => {
    for (const [marker, depth] of [
      ['#', 1],
      ['##', 2],
      ['######', 6],
    ] as const) {
      const { root, frontmatter } = parse(`---\ntitle: T\n---\n\n${marker} A\n`);
      expect(frontmatter).toEqual({ title: 'T' });
      expect(root.type).toBe('heading');
      expect(root.data.depth).toBe(depth);
      expect(toPlainText(root.content)).toBe('A');
      expect(root.children).toHaveLength(0);
    }
  });

  it('[TC-1-17-8] treats an empty title as absent', () => {
    const promoted = parse("---\ntitle: ''\n---\n\n# A\n");
    expect(promoted.frontmatter).toEqual({ title: '' });
    expect(promoted.hasTitle).toBe(false);
    expect(promoted.root.type).toBe('heading');
    expect(toPlainText(promoted.root.content)).toBe('A');

    const list = parse("---\ntitle: ''\n---\n\n- a\n");
    expect(list.hasTitle).toBe(false);
    expect(list.root.type).toBe('root');
    expect(list.root.content).toEqual([]);
    expect(list.root.children).toHaveLength(1);
  });

  it('[TC-1-17-4] promotes a single Setext heading and keeps its underline', () => {
    const markdown = 'Title\n=====\n\nBody.\n';
    const { root } = parse(markdown);
    expect(root.type).toBe('heading');
    expect(root.data.depth).toBe(1);
    expect(toPlainText(root.content)).toBe('Title');
    const block = root.source?.block;
    if (!block) throw new Error('No block');
    expect(markdown.slice(block.start, block.end)).toBe(markdown);

    const sub = parse('Sub\n---\n').root;
    expect(sub.type).toBe('heading');
    expect(sub.data.depth).toBe(2);
  });

  it('[TC-1-17-5] ignores heading-like lines in code and note fences', () => {
    const code = parse('```\n# Not a heading\n```\n').root;
    expect(code.type).toBe('root');
    expect(code.children).toHaveLength(0);
    expect(code.notes).toHaveLength(1);

    const note = parse('# A\n\n```markmap-note\n# Not a heading\n```\n').root;
    expect(toPlainText(note.content)).toBe('A');
    expect(note.children).toHaveLength(0);
    expect(note.notes.map((item) => item.fence)).toEqual([true]);
  });

  it('[TC-1-17-6] exposes title presence and the body start', () => {
    expect(parse('- a\n')).toMatchObject({ hasTitle: false, bodyStart: 0 });
    expect(parse('').bodyStart).toBe(0);
    expect(parse('\n\n').bodyStart).toBe(2);

    const front = '---\nfoo: 1\n---\n# A\n';
    const parsed = parse(front);
    expect(parsed.hasTitle).toBe(false);
    expect(parsed.bodyStart).toBe(front.indexOf('# A'));

    expect(parse('---\ntitle: T\n---\n\n- a\n').hasTitle).toBe(true);
    expect(parse('---\nfoo: 1\n---\n').bodyStart).toBe('---\nfoo: 1\n---\n'.length);

    const crlf = '---\r\nfoo: 1\r\n---\r\n# A\r\n';
    expect(parse(crlf).bodyStart).toBe(crlf.indexOf('# A'));
  });
});

describe('source offsets', () => {
  it('[TC-1-14-1] normalizes offsets after a byte order mark', () => {
    const markdown = '\uFEFF# A\n\nNote.\n\n## B\n';
    const { root } = parse(markdown);
    expect(root.type).toBe('heading');
    expect(root.position).toEqual({ start: 1, end: 4 });
    expect(root.source?.block).toEqual({ start: 1, end: markdown.length });
    expect(root.source?.label).toEqual({ start: 3, end: 4 });
    const label = root.source?.label;
    if (!label) throw new Error('No label');
    expect(markdown.slice(label.start, label.end)).toBe('A');

    const note = root.notes[0];
    if (!note?.source) throw new Error('No note source');
    expect(markdown.slice(note.source.start, note.source.end)).toBe('Note.');

    const child = root.children[0];
    expect(child?.source?.label).toEqual({
      start: markdown.indexOf('B'),
      end: markdown.indexOf('B') + 1,
    });
    expect(child?.source?.block).toEqual({
      start: markdown.indexOf('## B'),
      end: markdown.length,
    });
  });

  it('[TC-1-14-2] normalizes offsets after a byte order mark and frontmatter', () => {
    const markdown = '\uFEFF---\nfoo: 1\n---\n# A\n';
    const parsed = parse(markdown);
    expect(parsed.hasTitle).toBe(false);
    expect(parsed.frontmatter).toEqual({ foo: 1 });
    expect(parsed.bodyStart).toBe(markdown.indexOf('# A'));
    expect(parsed.root.type).toBe('heading');
    expect(parsed.root.source?.label).toEqual({
      start: markdown.indexOf('A'),
      end: markdown.indexOf('A') + 1,
    });
    expect(parsed.root.source?.block?.start).toBe(markdown.indexOf('# A'));

    const titled = parse('\uFEFF---\ntitle: T\n---\n\n# A\n');
    expect(titled.hasTitle).toBe(true);
    expect(toPlainText(titled.root.content)).toBe('A');
    expect(titled.root.type).toBe('heading');
    expect(titled.root.source?.label?.start).toBe('\uFEFF---\ntitle: T\n---\n\n# A\n'.indexOf('A'));
  });

  it('[TC-1-14-11] shifts plugin-copied positions exactly once', () => {
    const markdown = '\uFEFF# A\n\n# B\n';
    const { root } = parse(markdown, { plugins: [copyHeadingPosition] });
    const second = root.children[1];
    expect(second?.source?.block?.start).toBe(1);
    expect(second?.source?.label).toEqual({ start: 3, end: 4 });
    const label = second?.source?.label;
    if (!label) throw new Error('No label');
    expect(markdown.slice(label.start, label.end)).toBe('A');
  });
});

describe('when GFM is not supported', () => {
  it('falls back to parsing without GFM on a SyntaxError', () => {
    const plugin = failOnce(new SyntaxError('invalid group specifier name'));
    const { root, gfm } = parse('# ~~a~~ **b**', { plugins: [plugin] });
    expect(toPlainText(root.content)).toBe('~~a~~ b');
    expect(gfm).toBe(false);
  });

  it('reports GFM as applied otherwise', () => {
    expect(parse('# a').gfm).toBe(true);
  });

  it('rethrows other errors', () => {
    const plugin = failOnce(new TypeError('a bug'));
    expect(() => parse('# a', { plugins: [plugin] })).toThrow('a bug');
  });

  it('rethrows a SyntaxError that does not come from GFM', () => {
    expect(() => parse('# a', { plugins: [alwaysFail] })).toThrow('always');
  });
});

describe('markmap options and directives', () => {
  it('leaves markmap options raw for the theme-aware resolver', () => {
    const { frontmatter } = parse('---\nmarkmap:\n  wrapWidth: 200\n  color: "#f00"\n---\n\n- a');
    expect(frontmatter.markmap).toEqual({ wrapWidth: 200, color: '#f00' });
  });

  it('applies fold directives from label comments', () => {
    const { root } = parse(
      '# Root\n\n## A <!-- markmap: fold -->\n\n- a1 <!--markmap:foldAll-->\n  - a2\n- b <!-- other -->',
    );
    const [a] = root.children;
    expect(a.data).toEqual({ depth: 2, fold: true });
    expect(a.content).toEqual([{ type: 'text', value: 'A' }]);
    expect(a.children[0].data).toEqual({ foldAll: true });
    expect(a.children[1].content).toEqual([{ type: 'text', value: 'b' }]);
  });

  it('drops raw HTML from labels but keeps the text inside', () => {
    const { root } = parse('- a <b>bold</b> c');
    expect(toPlainText(root.children[0].content)).toBe('a bold c');
    expect(JSON.stringify(root)).not.toContain('"html"');
  });
});
