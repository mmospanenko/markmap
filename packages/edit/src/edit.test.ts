import {
  buildDocument,
  contentNodeCount,
  labelText,
  type Document,
  type EditNode,
} from '@markmap/model';
import { describe, expect, it } from 'vitest';
import { applyCommand, EditError, type Command, type EditResult } from '.';

function find(doc: Document, text: string): EditNode {
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (node && labelText(doc, node) === text) return node;
  }
  throw new Error(`No node labelled ${text}`);
}

function root(doc: Document): EditNode {
  return doc.nodes.get(doc.root)!;
}

function run(input: string, label: string, command: (node: EditNode) => Command): EditResult {
  const doc = buildDocument(input);
  const node = label === '#root' ? root(doc) : find(doc, label);
  return applyCommand(doc, command(node));
}

function textAt(result: EditResult): string {
  const node = result.document.nodes.get(result.document.root);
  if (!node) return '';
  for (const id of result.document.order) {
    const candidate = result.document.nodes.get(id);
    if (candidate?.label?.start === result.selection) return labelText(result.document, candidate);
  }
  return '';
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

describe('edit', () => {
  it('[TC-1-3-1] renames a heading, a list item and the root', () => {
    expect(
      run('# A\n\n## B\n', 'B', (node) => ({ type: 'setLabel', node: node.id, text: 'Bee' }))
        .document.source,
    ).toBe('# A\n\n## Bee\n');
    expect(
      run('# A\n\n- x\n', 'A', (node) => ({ type: 'setLabel', node: node.id, text: 'Root' }))
        .document.source,
    ).toBe('# Root\n\n- x\n');
    expect(
      run('- a\n- b\n', 'a', (node) => ({ type: 'setLabel', node: node.id, text: 'alpha' }))
        .document.source,
    ).toBe('- alpha\n- b\n');
  });

  it('[TC-1-3-2] keeps a multi-line list label indented', () => {
    const result = run('- a\n- b\n', 'a', (node) => ({
      type: 'setLabel',
      node: node.id,
      text: 'one\ntwo',
    }));
    expect(result.document.source).toBe('- one\n  two\n- b\n');
  });

  it('[TC-1-3-3] rejects a line break in a heading label', () => {
    expect(
      editError(() =>
        run('# A\n', 'A', (node) => ({ type: 'setLabel', node: node.id, text: 'a\nb' })),
      ).code,
    ).toBe('E_LABEL');
  });

  it('[TC-1-3-4] inserts a sibling after the whole subtree', () => {
    const heading = run('# A\n\n## B\n\n- x\n\n# C\n', 'B', (node) => ({
      type: 'insertSibling',
      node: node.id,
      text: 'New',
    }));
    expect(heading.document.source).toBe('# A\n\n## B\n\n- x\n\n## New\n# C\n');
    expect(textAt(heading)).toBe('New');

    const list = run('- a\n  - b\n- c\n', 'a', (node) => ({
      type: 'insertSibling',
      node: node.id,
      text: 'new',
    }));
    expect(list.document.source).toBe('- a\n  - b\n- new\n- c\n');
    expect(textAt(list)).toBe('new');
    expect(heading.tree.id).toBe(heading.document.root);
    expect(list.tree.id).toBe(list.document.root);
  });

  it('[TC-1-3-5] inserts a child at the end of the node', () => {
    const heading = run('# A\n\n## B\n', 'B', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'C',
    }));
    expect(heading.document.source).toBe('# A\n\n## B\n- C\n');
    const created = find(heading.document, 'C');
    expect(created.kind).toBe('listItem');
    expect(created.parent).toBe(find(heading.document, 'B').id);

    const list = run('- a\n', 'a', (node) => ({ type: 'insertChild', node: node.id, text: 'b' }));
    expect(list.document.source).toBe('- a\n  - b\n');

    const spaced = run('- a\n    - b\n', 'a', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'c',
    }));
    expect(spaced.document.source).toBe('- a\n    - b\n    - c\n');
  });

  it('[TC-1-3-6] inserts a child of a synthetic root', () => {
    const list = run('- a\n- b\n', '#root', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'c',
    }));
    expect(list.document.source).toBe('- a\n- b\n- c\n');

    const heading = run('# A\n\n# B\n', '#root', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'C',
    }));
    expect(heading.document.source).toBe('# A\n\n# B\n# C\n');
  });

  it('[TC-1-3-7] rejects invalid capabilities', () => {
    expect(
      editError(() =>
        run('- a\n', '#root', (node) => ({ type: 'insertSibling', node: node.id, text: 'x' })),
      ).code,
    ).toBe('E_CAPABILITY');
    expect(
      editError(() => run('- a\n', '#root', (node) => ({ type: 'delete', node: node.id }))).code,
    ).toBe('E_CAPABILITY');
    expect(
      editError(() => run('# A\n', 'A', (node) => ({ type: 'outdent', node: node.id }))).code,
    ).toBe('E_CAPABILITY');
    expect(
      editError(() =>
        run('- # T\n', 'T', (node) => ({ type: 'setLabel', node: node.id, text: 'x' })),
      ).code,
    ).toBe('E_CAPABILITY');
  });

  it('[TC-1-3-14] inserts an H2 child under a heading root with list children', () => {
    const input = '# Products\n\n- A\n- B\n';
    const result = run(input, '#root', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'C',
    }));
    expect(result.document.source).toBe('# Products\n\n- A\n- B\n## C\n');
    const created = find(result.document, 'C');
    expect(created.kind).toBe('heading');
    expect(created.parent).toBe(result.document.root);
    expect(contentNodeCount(result.document)).toBe(contentNodeCount(buildDocument(input)) + 1);
  });

  it('[TC-1-3-15] caps a child of an H1 root or an H1 heading at H2', () => {
    const rootResult = run('# A\n', '#root', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'B',
    }));
    expect(rootResult.document.source).toBe('# A\n## B\n');
    const rootChild = find(rootResult.document, 'B');
    expect(rootChild.kind).toBe('heading');
    expect(rootChild.level).toBe(2);
    expect(rootChild.parent).toBe(rootResult.document.root);

    const heading = run('# A\n\n# B\n', 'A', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'C',
    }));
    expect(heading.document.source).toBe('# A\n\n## C\n# B\n');
    const headingChild = find(heading.document, 'C');
    expect(headingChild.kind).toBe('heading');
    expect(headingChild.level).toBe(2);
    expect(headingChild.parent).toBe(find(heading.document, 'A').id);
  });

  it('[TC-1-3-16] falls back to a list under an H2 root, an H2, H3 or H6 heading', () => {
    const h2Root = run('## B\n', '#root', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'c',
    }));
    expect(h2Root.document.source).toBe('## B\n- c\n');
    expect(find(h2Root.document, 'c').kind).toBe('listItem');
    expect(find(h2Root.document, 'c').parent).toBe(h2Root.document.root);

    const h2 = run('# A\n\n## B\n', 'B', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'c',
    }));
    expect(h2.document.source).toBe('# A\n\n## B\n- c\n');
    expect(find(h2.document, 'c').kind).toBe('listItem');
    expect(find(h2.document, 'c').parent).toBe(find(h2.document, 'B').id);

    const h3 = run('# A\n\n## B\n\n### C\n', 'C', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'd',
    }));
    expect(h3.document.source).toBe('# A\n\n## B\n\n### C\n- d\n');
    expect(find(h3.document, 'd').kind).toBe('listItem');
    expect(find(h3.document, 'd').parent).toBe(find(h3.document, 'C').id);

    const input = '# A\n\n## B\n\n### C\n\n#### D\n\n##### E\n\n###### F\n';
    const h6 = run(input, 'F', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'G',
    }));
    expect(h6.document.source).toBe('# A\n\n## B\n\n### C\n\n#### D\n\n##### E\n\n###### F\n- G\n');
    expect(find(h6.document, 'G').kind).toBe('listItem');
    expect(find(h6.document, 'G').parent).toBe(find(h6.document, 'F').id);
  });

  it('[TC-1-3-17] falls back to a list for an H3 or H6 sibling', () => {
    const h3 = run('# A\n\n## B\n\n### C\n', 'C', (node) => ({
      type: 'insertSibling',
      node: node.id,
      text: 'D',
    }));
    expect(h3.document.source).toBe('# A\n\n## B\n\n- D\n### C\n');
    const h3Sibling = find(h3.document, 'D');
    expect(h3Sibling.kind).toBe('listItem');
    expect(h3Sibling.parent).toBe(find(h3.document, 'B').id);

    const input = '# A\n\n## B\n\n### C\n\n#### D\n\n##### E\n\n###### F\n';
    const h6 = run(input, 'F', (node) => ({
      type: 'insertSibling',
      node: node.id,
      text: 'G',
    }));
    expect(h6.document.source).toBe('# A\n\n## B\n\n### C\n\n#### D\n\n##### E\n\n- G\n###### F\n');
    const h6Sibling = find(h6.document, 'G');
    expect(h6Sibling.kind).toBe('listItem');
    expect(h6Sibling.parent).toBe(find(h6.document, 'E').id);
  });

  it('[TC-1-3-18] keeps H1 and H2 siblings as headings', () => {
    const h2 = run('# A\n\n## B\n', 'B', (node) => ({
      type: 'insertSibling',
      node: node.id,
      text: 'C',
    }));
    expect(h2.document.source).toBe('# A\n\n## B\n## C\n');
    expect(find(h2.document, 'C').kind).toBe('heading');
    expect(find(h2.document, 'C').level).toBe(2);
    expect(find(h2.document, 'C').parent).toBe(find(h2.document, 'A').id);

    const h1 = run('# A\n\n# B\n', 'A', (node) => ({
      type: 'insertSibling',
      node: node.id,
      text: 'C',
    }));
    expect(h1.document.source).toBe('# A\n\n# C\n# B\n');
    expect(find(h1.document, 'C').kind).toBe('heading');
    expect(find(h1.document, 'C').level).toBe(1);
    expect(find(h1.document, 'C').parent).toBe(h1.document.root);
  });

  it('[TC-1-3-19] reuses the direct list indent and marker under an H2 heading', () => {
    const unordered = run('# A\n\n## B\n\n- x\n', 'B', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'y',
    }));
    expect(unordered.document.source).toBe('# A\n\n## B\n\n- x\n- y\n');
    expect(find(unordered.document, 'y').kind).toBe('listItem');

    const ordered = run('# A\n\n## B\n\n1. x\n2. y\n', 'B', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'z',
    }));
    expect(ordered.document.source).toBe('# A\n\n## B\n\n1. x\n2. y\n1. z\n');
    expect(find(ordered.document, 'z').kind).toBe('listItem');

    const nested = run('# A\n\n## B\n\n- x\n  - y\n', 'B', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'z',
    }));
    expect(nested.document.source).toBe('# A\n\n## B\n\n- x\n  - y\n- z\n');
    expect(find(nested.document, 'z').parent).toBe(find(nested.document, 'B').id);

    const spaced = run('# A\n\n## B\n\n  - x\n    - y\n', 'B', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'z',
    }));
    expect(spaced.document.source).toBe('# A\n\n## B\n\n  - x\n    - y\n  - z\n');
    expect(find(spaced.document, 'z').kind).toBe('listItem');
    expect(find(spaced.document, 'z').parent).toBe(find(spaced.document, 'B').id);
  });

  it('[TC-1-3-20] appends a list before the heading children of an H2 heading', () => {
    const plain = run('# A\n\n## B\n\n### C\n', 'B', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'D',
    }));
    expect(plain.document.source).toBe('# A\n\n## B\n\n- D\n### C\n');
    expect(find(plain.document, 'D').kind).toBe('listItem');
    expect(find(plain.document, 'D').parent).toBe(find(plain.document, 'B').id);

    const withList = run('# A\n\n## B\n\n- x\n\n### C\n', 'B', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'y',
    }));
    expect(withList.document.source).toBe('# A\n\n## B\n\n- x\n\n- y\n### C\n');
    expect(find(withList.document, 'y').parent).toBe(find(withList.document, 'B').id);
  });

  it('[TC-1-3-21] keeps existing H3-H6 headings readable and editable in place', () => {
    const source = '# A\n\n## B\n\n### C\n\n#### D\n\n##### E\n\n###### F\n';
    const doc = buildDocument(source);
    expect(find(doc, 'C').level).toBe(3);
    expect(find(doc, 'F').level).toBe(6);
    expect(find(doc, 'F').capabilities.addChild).toBe(true);
    expect(find(doc, 'F').capabilities.addSibling).toBe(true);

    const renamed = applyCommand(doc, {
      type: 'setLabel',
      node: find(doc, 'C').id,
      text: 'C2',
    });
    expect(renamed.document.source).toBe(
      '# A\n\n## B\n\n### C2\n\n#### D\n\n##### E\n\n###### F\n',
    );
    const deep = applyCommand(renamed.document, {
      type: 'setLabel',
      node: find(renamed.document, 'F').id,
      text: 'F2',
    });
    expect(deep.document.source).toBe('# A\n\n## B\n\n### C2\n\n#### D\n\n##### E\n\n###### F2\n');
  });

  it('[TC-1-3-22] preserves CRLF for a capped heading and list', () => {
    const child = run('# A\r\n\r\n## B\r\n', 'B', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'c',
    }));
    expect(child.document.source).toBe('# A\r\n\r\n## B\r\n- c\r\n');
    expect(find(child.document, 'c').kind).toBe('listItem');

    const rootResult = run('# A\r\n', '#root', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'B',
    }));
    expect(rootResult.document.source).toBe('# A\r\n## B\r\n');
    expect(find(rootResult.document, 'B').kind).toBe('heading');
  });

  it('[TC-1-3-23] builds the capped Products hierarchy', () => {
    let doc = buildDocument('# Products\n\n- A\n- B\n');
    const one = applyCommand(doc, {
      type: 'insertChild',
      node: doc.root,
      text: 'one',
    });
    doc = one.document;
    expect(doc.source).toBe('# Products\n\n- A\n- B\n## one\n');
    expect(find(doc, 'one').kind).toBe('heading');
    expect(find(doc, 'one').level).toBe(2);

    const two = applyCommand(doc, {
      type: 'insertChild',
      node: find(doc, 'one').id,
      text: 'two',
    });
    doc = two.document;
    expect(doc.source).toBe('# Products\n\n- A\n- B\n## one\n- two\n');
    expect(find(doc, 'two').kind).toBe('listItem');
    expect(find(doc, 'two').parent).toBe(find(doc, 'one').id);

    const twoOne = applyCommand(doc, {
      type: 'insertSibling',
      node: find(doc, 'two').id,
      text: 'two-one',
    });
    doc = twoOne.document;
    expect(doc.source).toBe('# Products\n\n- A\n- B\n## one\n- two\n- two-one\n');
    expect(find(doc, 'two-one').kind).toBe('listItem');
    expect(find(doc, 'two-one').parent).toBe(find(doc, 'one').id);

    const three = applyCommand(doc, {
      type: 'insertChild',
      node: find(doc, 'two-one').id,
      text: 'three',
    });
    doc = three.document;
    expect(doc.source).toBe('# Products\n\n- A\n- B\n## one\n- two\n- two-one\n  - three\n');
    expect(find(doc, 'three').kind).toBe('listItem');
    expect(find(doc, 'three').parent).toBe(find(doc, 'two-one').id);
  });

  it('[TC-1-3-24] caps a child of a synthetic or title root by its last heading level', () => {
    const deep = run('### A\n\n### B\n', '#root', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'C',
    }));
    expect(deep.document.source).toBe('- C\n### A\n\n### B\n');
    expect(find(deep.document, 'C').kind).toBe('listItem');
    expect(find(deep.document, 'C').parent).toBe(deep.document.root);

    const titled = run('---\ntitle: T\n---\n\n## A\n\n## B\n', '#root', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'C',
    }));
    expect(titled.document.source).toBe('---\ntitle: T\n---\n\n## A\n\n## B\n## C\n');
    expect(find(titled.document, 'C').kind).toBe('heading');
    expect(find(titled.document, 'C').level).toBe(2);
    expect(find(titled.document, 'C').parent).toBe(titled.document.root);
  });

  it('[TC-1-3-25] caps a BOM and CRLF H2 child at a list item', () => {
    const input = '\uFEFF## B\r\n\r\n### C\r\n';
    const result = run(input, '#root', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'c',
    }));
    expect(result.document.source).toBe('\uFEFF## B\r\n\r\n- c\r\n### C\r\n');
    const created = find(result.document, 'c');
    expect(created.kind).toBe('listItem');
    expect(created.parent).toBe(result.document.root);
  });

  it.each<[string, string, number, string]>([
    ['H3 without title', '### A\n', 3, '### A\n- x\n'],
    ['H6 without title', '###### A\n', 6, '###### A\n- x\n'],
    ['H3 with title', '---\ntitle: T\n---\n\n### A\n', 3, '---\ntitle: T\n---\n\n### A\n- x\n'],
    [
      'H6 with title',
      '---\ntitle: T\n---\n\n###### A\n',
      6,
      '---\ntitle: T\n---\n\n###### A\n- x\n',
    ],
  ])('[TC-1-3-26] inserts a list under a promoted %s root', (_, input, level, expected) => {
    const result = run(input, '#root', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'x',
    }));
    expect(result.document.source).toBe(expected);
    expect(result.document.source.startsWith(input)).toBe(true);
    expect(result.document.nodes.get(result.document.root)?.level).toBe(level);
    const created = find(result.document, 'x');
    expect(created.kind).toBe('listItem');
    expect(created.parent).toBe(result.document.root);
  });

  it('[TC-1-3-27] inserts a capped branch at the end of a source without a trailing newline', () => {
    const h1 = run('# A', '#root', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'B',
    }));
    expect(h1.document.source).toBe('# A\n## B');
    expect(find(h1.document, 'B').kind).toBe('heading');

    const h2 = run('## B', '#root', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'c',
    }));
    expect(h2.document.source).toBe('## B\n- c');
    expect(find(h2.document, 'c').kind).toBe('listItem');
    expect(find(h2.document, 'c').parent).toBe(h2.document.root);

    const heading = run('# A\n\n## B', 'B', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'c',
    }));
    expect(heading.document.source).toBe('# A\n\n## B\n- c');
    expect(find(heading.document, 'c').kind).toBe('listItem');
  });

  it('[TC-1-4-1] deletes a leaf, a subtree and a heading section', () => {
    expect(
      run('- a\n- b\n', 'a', (node) => ({ type: 'delete', node: node.id })).document.source,
    ).toBe('- b\n');
    expect(
      run('- a\n  - b\n- c\n', 'a', (node) => ({ type: 'delete', node: node.id })).document.source,
    ).toBe('- c\n');
    const heading = run('# A\n\n## B\n\n- x\n\n# C\n', 'B', (node) => ({
      type: 'delete',
      node: node.id,
    }));
    expect(heading.document.source).toBe('# A\n\n# C\n');
    expect(textAt(heading)).toBe('A');
  });

  it('[TC-1-5-1] outdents the last list child', () => {
    const result = run('- a\n  - b\n- c\n', 'b', (node) => ({ type: 'outdent', node: node.id }));
    expect(result.document.source).toBe('- a\n- b\n- c\n');
    expect(textAt(result)).toBe('b');
  });

  it('[TC-1-5-2] outdents a list branch with descendants', () => {
    const result = run('- a\n  - b\n    - d\n  - e\n- f\n', 'b', (node) => ({
      type: 'outdent',
      node: node.id,
    }));
    expect(result.document.source).toBe('- a\n  - e\n- b\n  - d\n- f\n');
    expect(textAt(result)).toBe('b');
  });

  it('[TC-1-5-3] outdents a heading branch and its descendants', () => {
    const result = run('# A\n\n## B\n\n### C\n\n# D\n', 'B', (node) => ({
      type: 'outdent',
      node: node.id,
    }));
    expect(result.document.source).toBe('# A\n\n# B\n\n## C\n\n# D\n');
    expect(textAt(result)).toBe('B');
  });

  it('[TC-1-5-4] rejects outdent of a depth-one list item', () => {
    expect(
      editError(() => run('# A\n\n- b\n', 'b', (node) => ({ type: 'outdent', node: node.id })))
        .code,
    ).toBe('E_CAPABILITY');
  });

  it('[TC-1-6-1] toggles a task checkbox', () => {
    const result = run('- [ ] a\n- [x] b\n', 'a', (node) => ({
      type: 'toggleCheck',
      node: node.id,
    }));
    expect(result.document.source).toBe('- [x] a\n- [x] b\n');
    expect(textAt(result)).toBe('a');
  });

  it('[TC-1-7-1] preserves CRLF line endings', () => {
    const renamed = run('- a\r\n- b\r\n', 'a', (node) => ({
      type: 'setLabel',
      node: node.id,
      text: 'x',
    }));
    expect(renamed.document.source).toBe('- x\r\n- b\r\n');
    const child = run('- a\r\n', 'a', (node) => ({
      type: 'insertChild',
      node: node.id,
      text: 'b',
    }));
    expect(child.document.source).toBe('- a\r\n  - b\r\n');
  });

  it('[TC-1-9-1] leaves bytes outside the edit untouched', () => {
    const input = 'Before.\n\n# A\n\n## B\n\n```\n# not a heading\n```\n\n- x\n';
    const result = run(input, 'B', (node) => ({ type: 'setLabel', node: node.id, text: 'Bee' }));
    const edit = result.edits[0];
    expect(result.document.source.slice(0, edit.from)).toBe(input.slice(0, edit.from));
    const tail = input.length - edit.to;
    expect(result.document.source.slice(-tail)).toBe(input.slice(edit.to));
  });
});
