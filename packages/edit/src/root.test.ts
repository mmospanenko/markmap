import {
  buildDocument,
  contentNodeCount,
  labelText,
  type Document,
  type EditNode,
} from '@markmap/model';
import { describe, expect, it } from 'vitest';
import { applyCommand, EditError, type EditResult } from '.';

function create(input: string, text = 'Root'): EditResult {
  const doc = buildDocument(input);
  return applyCommand(doc, { type: 'createRootHeading', node: doc.root, text });
}

function find(doc: Document, text: string): EditNode {
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (node && labelText(doc, node) === text) return node;
  }
  throw new Error(`No node labelled ${text}`);
}

function labels(doc: Document): string[] {
  return doc.order.map((id) => {
    const node = doc.nodes.get(id);
    return node ? labelText(doc, node) : '';
  });
}

function parentLabels(doc: Document): Array<string | null> {
  return doc.order.map((id) => {
    const node = doc.nodes.get(id);
    const parent = node?.parent ? doc.nodes.get(node.parent) : undefined;
    return parent ? labelText(doc, parent) : null;
  });
}

function editError(fn: () => unknown): EditError {
  try {
    fn();
  } catch (error) {
    if (error instanceof EditError) return error;
    throw error;
  }
  throw new Error('Expected an EditError');
}

describe('root heading creation', () => {
  it('[TC-1-15-3] creates a root heading above a list-only document', () => {
    const result = create('- a\n- b\n');
    expect(result.document.source).toBe('# Root\n\n- a\n- b\n');
    expect(result.edits).toEqual([{ from: 0, to: 0, insert: '# Root\n\n' }]);
    expect(result.selection).toBe(2);
    expect(result.document.nodes.size).toBe(3);
    expect(labels(result.document)).toEqual(['Root', 'a', 'b']);
    expect(parentLabels(result.document)).toEqual([null, 'Root', 'Root']);
  });

  it('[TC-1-15-4] creates a root heading above two top-level H2 headings', () => {
    const result = create('## A\n\n## B\n');
    expect(result.document.source).toBe('# Root\n\n## A\n\n## B\n');
    expect(labels(result.document)).toEqual(['Root', 'A', 'B']);
    expect(parentLabels(result.document)).toEqual([null, 'Root', 'Root']);
    expect(result.document.order.map((id) => result.document.nodes.get(id)?.level)).toEqual([
      1, 2, 2,
    ]);
  });

  it('[TC-1-15-5] inserts a root heading after frontmatter and before the first block', () => {
    const input = '---\nfoo: 1\n---\n\n- a\n';
    const result = create(input);
    expect(result.document.source).toBe('---\nfoo: 1\n---\n\n# Root\n\n- a\n');
    expect(result.edits).toHaveLength(1);
    const edit = result.edits[0];
    if (!edit) throw new Error('No edit');
    expect(edit.insert).toBe('# Root\n\n');
    expect(result.document.source.slice(0, edit.from)).toBe(input.slice(0, edit.from));
    expect(result.document.source.slice(edit.to + edit.insert.length)).toBe(input.slice(edit.to));
    expect(parentLabels(result.document)).toEqual([null, 'Root']);
  });

  it('[TC-1-15-6] creates a root heading in a frontmatter-only document', () => {
    expect(create('---\nfoo: 1\n---\n').document.source).toBe('---\nfoo: 1\n---\n# Root\n');
    expect(create('---\nfoo: 1\n---').document.source).toBe('---\nfoo: 1\n---\n# Root');
  });

  it('[TC-1-15-7] preserves CRLF line endings', () => {
    const input = '---\r\nfoo: 1\r\n---\r\n\r\n- a\r\n';
    const result = create(input);
    expect(result.document.source).toBe('---\r\nfoo: 1\r\n---\r\n\r\n# Root\r\n\r\n- a\r\n');
    expect(result.edits[0]?.insert).toBe('# Root\r\n\r\n');
  });

  it('[TC-1-15-8] refuses a title with headings, an existing source root or a top-level H1', () => {
    const title = buildDocument('---\ntitle: T\n---\n\n## A\n\n## B\n');
    const error = editError(() =>
      applyCommand(title, { type: 'createRootHeading', node: title.root, text: 'Root' }),
    );
    expect(error.code).toBe('E_ROOT_TITLE');
    expect(error.message).toContain('one H1');
    expect(title.source).toBe('---\ntitle: T\n---\n\n## A\n\n## B\n');

    const sourceRoot = buildDocument('# A\n');
    expect(
      editError(() =>
        applyCommand(sourceRoot, {
          type: 'createRootHeading',
          node: sourceRoot.root,
          text: 'Root',
        }),
      ).code,
    ).toBe('E_ROOT_EXISTS');
    expect(sourceRoot.source).toBe('# A\n');

    const h1 = buildDocument('# A\n# B\n');
    expect(
      editError(() => applyCommand(h1, { type: 'createRootHeading', node: h1.root, text: 'Root' }))
        .code,
    ).toBe('E_ROOT_H1');
    expect(h1.source).toBe('# A\n# B\n');
  });

  it('[TC-1-15-17] creates a body H1 from a title root without headings', () => {
    const list = create('---\ntitle: T\n---\n\n- a\n', 'Body');
    expect(list.document.source).toBe('---\ntitle: T\n---\n\n# Body\n\n- a\n');
    expect(list.edits).toHaveLength(1);
    expect(list.document.rootPolicy.kind).toBe('source-heading');
    const listedRoot = list.document.nodes.get(list.document.root);
    if (!listedRoot) throw new Error('No root');
    expect(labelText(list.document, listedRoot)).toBe('Body');
    expect(list.document.source.startsWith('---\ntitle: T\n---')).toBe(true);

    const empty = create('---\ntitle: T\n---\n', 'Body');
    expect(empty.document.source).toBe('---\ntitle: T\n---\n# Body\n');
    expect(empty.edits).toHaveLength(1);
    expect(labelText(empty.document, empty.document.nodes.get(empty.document.root)!)).toBe('Body');
  });

  it('[TC-1-15-18] creates a CRLF body H1 from a title root without headings', () => {
    const input = '---\r\ntitle: T\r\n---\r\n\r\n- a\r\n';
    const result = create(input, 'Body');
    expect(result.document.source).toBe('---\r\ntitle: T\r\n---\r\n\r\n# Body\r\n\r\n- a\r\n');
    expect(result.edits[0]?.insert).toBe('# Body\r\n\r\n');
    expect(labelText(result.document, result.document.nodes.get(result.document.root)!)).toBe(
      'Body',
    );
  });

  it('[TC-1-15-19] refuses a title root with a leading list and one heading child', () => {
    const input = '---\ntitle: T\n---\n\n- a\n\n## B\n';
    const doc = buildDocument(input);
    expect(doc.rootPolicy.kind).toBe('title');
    expect(doc.rootPolicy.hasHeadingChild).toBe(true);
    expect(doc.rootPolicy.canCreateHeading).toBe(false);

    const error = editError(() =>
      applyCommand(doc, { type: 'createRootHeading', node: doc.root, text: 'Body' }),
    );
    expect(error.code).toBe('E_ROOT_TITLE');
    expect(error.message).toContain('one H1');
    expect(doc.source).toBe(input);
  });

  it('[TC-1-15-20] treats an empty title as absent', () => {
    const promoted = buildDocument("---\ntitle: ''\n---\n\n# A\n");
    expect(promoted.rootPolicy.kind).toBe('source-heading');
    expect(promoted.rootPolicy.hasTitle).toBe(false);
    expect(labelText(promoted, promoted.nodes.get(promoted.root)!)).toBe('A');

    const list = buildDocument("---\ntitle: ''\n---\n\n- a\n");
    expect(list.rootPolicy.kind).toBe('synthetic');
    expect(list.rootPolicy.hasTitle).toBe(false);
    expect(list.rootPolicy.canCreateHeading).toBe(true);

    const empty = buildDocument("---\ntitle: ''\n---\n");
    expect(empty.rootPolicy.kind).toBe('synthetic');
    expect(empty.rootPolicy.canCreateHeading).toBe(true);
  });

  it('[TC-1-15-9] preserves node count, order and parent edges', () => {
    const input = '- a\n  - b\n## C\n- d\n';
    const result = create(input);
    const doc = result.document;
    expect(doc.source).toBe('# Root\n\n- a\n  - b\n## C\n- d\n');
    expect(doc.nodes.size).toBe(5);
    expect(labels(doc)).toEqual(['Root', 'a', 'b', 'C', 'd']);
    expect(parentLabels(doc)).toEqual([null, 'Root', 'a', 'Root', 'C']);
  });

  it('[TC-1-15-10] keeps a Setext root rename-only', () => {
    const doc = buildDocument('Title\n=====\n');
    const renamed = applyCommand(doc, { type: 'setLabel', node: doc.root, text: 'Renamed' });
    expect(renamed.document.source).toBe('Renamed\n=====\n');
    expect(
      editError(() =>
        applyCommand(renamed.document, {
          type: 'insertChild',
          node: renamed.document.root,
          text: 'Child',
        }),
      ).code,
    ).toBe('E_CAPABILITY');
  });

  it('[TC-1-15-11] rejects a non-root node and an empty label', () => {
    const list = buildDocument('- a\n');
    expect(
      editError(() =>
        applyCommand(list, {
          type: 'createRootHeading',
          node: find(list, 'a').id,
          text: 'Root',
        }),
      ).code,
    ).toBe('E_CAPABILITY');
    const empty = buildDocument('');
    expect(
      editError(() =>
        applyCommand(empty, { type: 'createRootHeading', node: empty.root, text: '  ' }),
      ).code,
    ).toBe('E_LABEL');
  });

  it('[TC-1-15-12] keeps a byte order mark before the created root', () => {
    const input = '\uFEFF- a\n';
    const result = create(input);
    expect(result.document.source).toBe('\uFEFF# Root\n\n- a\n');
    expect(result.edits[0]).toEqual({ from: 1, to: 1, insert: '# Root\n\n' });
  });

  it('[TC-1-15-13] keeps leading blank lines before the new root', () => {
    const input = '\n\n- a\n';
    const result = create(input);
    expect(result.document.source).toBe('\n\n# Root\n\n- a\n');
    expect(result.edits[0]).toEqual({ from: 2, to: 2, insert: '# Root\n\n' });
  });

  it('[TC-1-15-14] keeps blank lines after frontmatter before the new root', () => {
    const input = '---\nfoo: 1\n---\n\n\n- a\n';
    const result = create(input);
    expect(result.document.source).toBe('---\nfoo: 1\n---\n\n\n# Root\n\n- a\n');
    expect(result.edits[0]?.from).toBe(input.indexOf('- a'));
  });

  it('[TC-1-15-15] preserves whitespace and BOM bytes when creating a root', () => {
    const cases = [
      ['', '# Root'],
      ['\r\n\r\n', '\r\n\r\n# Root\r\n'],
      ['\n\n', '\n\n# Root\n'],
      ['  ', '  \n# Root'],
      ['\t', '\t\n# Root'],
      ['\uFEFF', '\uFEFF# Root'],
      ['\uFEFF\n', '\uFEFF\n# Root\n'],
    ] as const;
    for (const [source, expected] of cases) {
      const result = create(source);
      expect(result.document.source).toBe(expected);
      expect(result.document.source.startsWith(source)).toBe(true);
      const root = result.document.nodes.get(result.document.root);
      if (!root?.label) throw new Error('No root label');
      expect(result.selection).toBe(root.label.start);
      expect(result.document.source.slice(root.label.start, root.label.end)).toBe('Root');
    }
  });
});

describe('root-aware content counts', () => {
  it('[TC-1-16-2] deletes a heading when the remaining sibling becomes the root', () => {
    for (const marker of ['##', '###', '####', '#####', '######']) {
      const input = `${marker} A\n\n${marker} B\n`;
      const doc = buildDocument(input);
      expect(contentNodeCount(doc)).toBe(2);
      const result = applyCommand(doc, { type: 'delete', node: find(doc, 'B').id });
      expect(result.document.source).toBe(`${marker} A\n\n`);
      expect(result.document.nodes.size).toBe(1);
      expect(contentNodeCount(result.document)).toBe(1);
      expect(labelText(result.document, result.document.nodes.get(result.document.root)!)).toBe(
        'A',
      );
    }
  });

  it('[TC-1-16-3] deletes a heading subtree when the sibling becomes the root', () => {
    const doc = buildDocument('## A\n\n## B\n\n### C\n');
    expect(contentNodeCount(doc)).toBe(3);
    const result = applyCommand(doc, { type: 'delete', node: find(doc, 'B').id });
    expect(result.document.source).toBe('## A\n\n');
    expect(result.document.nodes.size).toBe(1);
    expect(contentNodeCount(result.document)).toBe(1);
  });

  it('[TC-1-16-4] pastes a heading under a synthetic root that promotes', () => {
    const doc = buildDocument('Note.\n');
    expect(contentNodeCount(doc)).toBe(0);
    const result = applyCommand(doc, { type: 'insertBlock', node: doc.root, text: '## B' });
    expect(result.document.source).toBe('Note.\n# B\n');
    expect(result.document.nodes.size).toBe(1);
    expect(contentNodeCount(result.document)).toBe(1);
    expect(labelText(result.document, result.document.nodes.get(result.document.root)!)).toBe('B');
  });
});

describe('empty ATX labels', () => {
  it('[TC-1-14-4] inserts the heading separator in one splice', () => {
    const cases = [
      ['##', '## Renamed'],
      ['## ', '## Renamed'],
      ['##  ', '##  Renamed'],
    ] as const;
    for (const [source, expected] of cases) {
      const doc = buildDocument(source);
      const root = doc.nodes.get(doc.root);
      if (!root) throw new Error('No root');
      expect(root.kind).toBe('root');
      expect(root.level).toBe(2);
      const result = applyCommand(doc, { type: 'setLabel', node: root.id, text: 'Renamed' });
      expect(result.document.source).toBe(expected);
      expect(result.edits).toHaveLength(1);
      expect(result.selection).toBe(expected.length);
    }
  });

  it('[TC-1-14-5] keeps a byte order mark outside the edit', () => {
    const input = '\uFEFF##\n';
    const doc = buildDocument(input);
    const result = applyCommand(doc, { type: 'setLabel', node: doc.root, text: 'Renamed' });
    expect(result.document.source).toBe('\uFEFF## Renamed\n');
    expect(result.edits[0]?.from).toBe(3);

    const heading = buildDocument('\uFEFF# A\n');
    const renamed = applyCommand(heading, { type: 'setLabel', node: heading.root, text: 'B' });
    expect(renamed.document.source).toBe('\uFEFF# B\n');
  });

  it('[TC-1-14-8] creates a root heading after a byte order mark only', () => {
    const cases = [
      ['\uFEFF', '\uFEFF# Root', 3],
      ['\uFEFF\n', '\uFEFF\n# Root\n', 4],
      ['\uFEFF  \n', '\uFEFF  \n# Root\n', 6],
    ] as const;
    for (const [input, expected, labelStart] of cases) {
      const result = create(input);
      expect(result.document.source).toBe(expected);
      const root = result.document.nodes.get(result.document.root);
      if (!root) throw new Error('No root');
      expect(root.label).toEqual({ start: labelStart, end: labelStart + 4 });
      expect(result.selection).toBe(labelStart);
      expect(result.document.nodes.size).toBe(1);
    }
  });

  it('[TC-1-14-9] recognizes empty ATX headings with CRLF', () => {
    const cases = [
      ['##\r\n', '## Renamed\r\n', 2],
      ['## \r\n', '## Renamed\r\n', 3],
      ['##  \r\n', '##  Renamed\r\n', 4],
    ] as const;
    for (const [source, expected, labelStart] of cases) {
      const doc = buildDocument(source);
      const root = doc.nodes.get(doc.root);
      if (!root) throw new Error('No root');
      expect(root.kind).toBe('root');
      expect(root.level).toBe(2);
      expect(root.label).toEqual({ start: labelStart, end: labelStart });
      expect(root.opaque).toBe(false);
      const result = applyCommand(doc, { type: 'setLabel', node: root.id, text: 'Renamed' });
      expect(result.document.source).toBe(expected);
      expect(result.edits).toHaveLength(1);
    }
  });

  it('[TC-1-14-10] recognizes empty ATX headings under a heading with CRLF', () => {
    const cases = [
      ['# A\r\n\r\n##\r\n', '# A\r\n\r\n## Renamed\r\n', 9],
      ['# A\r\n\r\n## \r\n', '# A\r\n\r\n## Renamed\r\n', 10],
      ['# A\r\n\r\n##  \r\n', '# A\r\n\r\n##  Renamed\r\n', 11],
    ] as const;
    for (const [source, expected, labelStart] of cases) {
      const doc = buildDocument(source);
      const root = doc.nodes.get(doc.root);
      if (!root) throw new Error('No root');
      const child = doc.nodes.get(root.children[0]);
      if (!child) throw new Error('No child');
      expect(child.kind).toBe('heading');
      expect(child.level).toBe(2);
      expect(child.label).toEqual({ start: labelStart, end: labelStart });
      expect(child.opaque).toBe(false);
      const result = applyCommand(doc, { type: 'setLabel', node: child.id, text: 'Renamed' });
      expect(result.document.source).toBe(expected);
      expect(result.edits).toHaveLength(1);
    }
  });
});
