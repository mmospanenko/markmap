import { describe, expect, it } from 'vitest';
import {
  labelText,
  parseDocument,
  validateConventions,
  type Document,
  type EditNode,
} from '@markmap/model';
import { applyCommand, appendGraphSplice, copyBlock, EditError, graphBlockSplices } from '.';

function find(doc: Document, label: string): EditNode {
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (node && labelText(doc, node) === label) return node;
  }
  throw new Error(`No node labelled ${label}`);
}

function blocks(source: string): number {
  return source.match(/<!--\s*markmap:\s*graph\b/g)?.length ?? 0;
}

const SOURCE = `# Root

- Group
  - A <!-- ^a -->
  - B <!-- ^b -->
- Target

<!-- markmap: graph
edges:
  - from: a
    to: b
    label: depends
groups:
  - roots: [a]
    label: Delivery
-->
`;

describe('copy', () => {
  it('[TC-1-22-2] mints only referenced identities and keeps one graph block', () => {
    const doc = parseDocument(SOURCE).document;
    const copied = copyBlock(doc, find(doc, 'Group').id, { random: () => 0 });
    expect(copied).not.toBeNull();
    if (copied === null) throw new Error('No copied block');
    expect(blocks(copied)).toBe(1);
    expect(copied).not.toContain('<!-- ^a -->');
    expect(copied).not.toContain('<!-- ^b -->');
    const fragment = parseDocument(copied).document;
    expect(fragment.graph.edges).toHaveLength(1);
    expect(fragment.graph.groups).toHaveLength(1);
    expect(validateConventions(fragment)).toEqual([]);
  });

  it('[TC-1-22-3] omits an external edge and a partial group and drops their markers', () => {
    const edge = parseDocument(
      '# Root\n\n- Group\n  - A <!-- ^a -->\n- B <!-- ^b -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: b\n-->\n',
    ).document;
    expect(copyBlock(edge, find(edge, 'Group').id, { random: () => 0 })).toBe('- Group\n  - A');
    const group = parseDocument(
      '# Root\n\n- Group\n  - A <!-- ^a -->\n- Outside <!-- ^o -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: o\ngroups:\n  - roots: [a, o]\n-->\n',
    ).document;
    expect(copyBlock(group, find(group, 'Group').id, { random: () => 0 })).toBe('- Group\n  - A');
  });

  it('[TC-1-22-4] copies a root without duplicating the document graph block', () => {
    const doc = parseDocument(SOURCE).document;
    const copied = copyBlock(doc, doc.root, { random: () => 0 });
    expect(copied).not.toBeNull();
    if (copied === null) throw new Error('No copied block');
    expect(blocks(copied)).toBe(1);
    expect(validateConventions(parseDocument(copied).document)).toEqual([]);
    expect(copyBlock(doc, 'missing', { random: () => 0 })).toBeNull();
  });

  it('[TC-1-22-11] drops all metadata for an invalid graph and an external root', () => {
    const invalid = parseDocument(
      '# Root\n\n- Group\n  - A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: z\n-->\n',
    ).document;
    expect(copyBlock(invalid, find(invalid, 'Group').id, { random: () => 0 })).toBe(
      '- Group\n  - A',
    );
    const rootEdge = parseDocument(
      '# Root\n\n- Group\n  - A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\n-->\n',
    ).document;
    expect(copyBlock(rootEdge, find(rootEdge, 'Group').id, { random: () => 0 })).toBe(
      '- Group\n  - A',
    );
  });

  it('[TC-1-22-12] returns null for a node without a block', () => {
    const doc = parseDocument('# Root\n\n- A\n').document;
    const node = find(doc, 'A');
    node.block = null;
    expect(copyBlock(doc, node.id, { random: () => 0 })).toBeNull();
  });

  it('[TC-1-22-23] omits root references from a subtree copy', () => {
    const doc = parseDocument(
      '# Root\n\n- Group\n  - A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\ngroups:\n  - roots: [a, root]\n-->\n',
    ).document;
    expect(copyBlock(doc, find(doc, 'Group').id, { random: () => 0 })).toBe('- Group\n  - A');
  });

  it('[TC-1-22-24] keeps the original root graph block exactly once', () => {
    const heading = `# Root\n\n- Group\n  - A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\n-->\n`;
    const title = `---\ntitle: Root\n---\n\n- Group\n  - A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\n-->\n`;
    for (const source of [heading, title]) {
      const doc = parseDocument(source).document;
      const copied = copyBlock(doc, doc.root, {
        random: () => 0,
        ...(source.startsWith('---') ? { title: 'Root' } : {}),
      });
      expect(copied).not.toBeNull();
      expect(copied?.match(/<!--\s*markmap:\s*graph\b/g) ?? []).toHaveLength(1);
      expect(copied).toContain('from: a');
      expect(copied).toContain('to: root');
      expect(copied).toContain('<!-- ^a -->');
    }
  });

  it('[TC-1-22-25] copies a root without a graph or body', () => {
    const doc = parseDocument('---\ntitle: Root\n---\n').document;
    expect(copyBlock(doc, doc.root, { random: () => 0, title: 'Root' })).toBe('# Root');
  });

  it('[TC-1-22-26] copies a CRLF subtree and drops an unused marker', () => {
    const doc = parseDocument('# Root\r\n\r\n- Group\r\n  - A <!-- ^a -->\r\n').document;
    expect(copyBlock(doc, find(doc, 'Group').id, { random: () => 0 })).toBe('- Group\r\n  - A');
  });

  it('[TC-1-22-27] drops a document graph block inside a copied section', () => {
    const doc = parseDocument(
      '# Root\n\n## A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\n-->\n',
    ).document;
    expect(copyBlock(doc, find(doc, 'A').id, { random: () => 0 })).toBe('## A');
  });
});

describe('paste', () => {
  it('[TC-1-22-5] merges copied metadata into the one target block', () => {
    const doc = parseDocument(SOURCE).document;
    const copied = copyBlock(doc, find(doc, 'Group').id, { random: () => 0 });
    if (copied === null) throw new Error('No copied block');
    const pasted = applyCommand(doc, {
      type: 'insertBlock',
      node: find(doc, 'Target').id,
      text: copied,
    });
    expect(blocks(pasted.document.source)).toBe(1);
    expect(pasted.document.graph.edges).toHaveLength(2);
    expect(pasted.document.graph.groups).toHaveLength(2);
    expect(validateConventions(pasted.document)).toEqual([]);
  });

  it('[TC-1-22-6] remints a pasted identity that collides with the target', () => {
    const target = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\n-->\n',
    ).document;
    const pastedText =
      '- P <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\n-->';
    const result = applyCommand(target, {
      type: 'insertBlock',
      node: find(target, 'A').id,
      text: pastedText,
      random: () => 0,
    });
    expect(result.document.graph.edges).toHaveLength(2);
    const refs = result.document.graph.edges.map((edge) => edge.from);
    expect(new Set(refs).size).toBe(2);
    expect(validateConventions(result.document)).toEqual([]);
  });

  it('[TC-1-22-13] appends the first graph block and rejects invalid target metadata', () => {
    const target = parseDocument('# Root\n\n- A\n').document;
    const pasted = '- P <!-- ^p -->\n\n<!-- markmap: graph\nedges:\n  - from: p\n    to: root\n-->';
    const result = applyCommand(target, {
      type: 'insertBlock',
      node: find(target, 'A').id,
      text: pasted,
    });
    expect(blocks(result.document.source)).toBe(1);
    expect(result.document.graph.edges).toHaveLength(1);
    expect(validateConventions(result.document)).toEqual([]);

    const invalid = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: z\n-->\n',
    ).document;
    expect(() =>
      applyCommand(invalid, {
        type: 'insertBlock',
        node: find(invalid, 'A').id,
        text: pasted,
      }),
    ).toThrow(EditError);
  });

  it('[TC-1-22-14] returns no append splice for an empty graph', () => {
    expect(appendGraphSplice('# Root\n', { edges: [], groups: [], block: null }, '\n')).toBeNull();
  });

  it('[TC-1-22-20] appends a remaining graph when the document has no block', () => {
    const doc = parseDocument('# Root\n\n- A <!-- ^a -->\n').document;
    const splices = graphBlockSplices(
      doc.source,
      doc,
      {
        graph: { edges: [{ from: 'a', to: 'root', label: null }], groups: [], block: null },
        drop: [],
        changed: true,
      },
      { start: 0, end: 0 },
    );
    expect(splices).toHaveLength(1);
    expect(splices[0]?.insert).toContain('<!-- markmap: graph');
  });

  it('[TC-1-22-22] keeps a trailing line ending when the block range includes it', () => {
    const doc = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\n-->\n',
    ).document;
    const block = doc.graph.block;
    if (block === null) throw new Error('No graph block');
    const extended = { start: block.start, end: block.end + 2 };
    doc.graph.block = extended;
    const splices = graphBlockSplices(
      doc.source,
      doc,
      {
        graph: { edges: [{ from: 'a', to: 'root', label: null }], groups: [], block: extended },
        drop: [],
        changed: true,
      },
      { start: 0, end: 0 },
    );
    expect(splices[0]?.insert.endsWith('\r\n') || splices[0]?.insert.endsWith('\n')).toBe(true);
  });

  it('[TC-1-22-28] rejects a pasted marker without graph metadata', () => {
    const doc = parseDocument('# Root\n\n- A\n').document;
    const before = doc.source;
    expect(() =>
      applyCommand(doc, {
        type: 'insertBlock',
        node: find(doc, 'A').id,
        text: '- P <!-- ^p -->',
      }),
    ).toThrow(EditError);
    expect(doc.source).toBe(before);
  });
});

describe('delete', () => {
  it('[TC-1-22-7] removes edges, group roots and unused markers', () => {
    const doc = parseDocument(SOURCE).document;
    const deleted = applyCommand(doc, { type: 'delete', node: find(doc, 'A').id });
    expect(deleted.document.source).toBe('# Root\n\n- Group\n  - B\n- Target\n');
    expect(blocks(deleted.document.source)).toBe(0);
    expect(validateConventions(deleted.document)).toEqual([]);
  });

  it('[TC-1-22-8] keeps a group with a remaining root and removes the block when empty', () => {
    const doc = parseDocument(SOURCE).document;
    const withoutB = applyCommand(doc, { type: 'delete', node: find(doc, 'B').id });
    expect(withoutB.document.graph.edges).toEqual([]);
    expect(withoutB.document.graph.groups).toEqual([{ roots: ['a'], label: 'Delivery' }]);
    expect(find(withoutB.document, 'A').identity?.id).toBe('a');
    expect(validateConventions(withoutB.document)).toEqual([]);
    const withoutA = applyCommand(withoutB.document, {
      type: 'delete',
      node: find(withoutB.document, 'A').id,
    });
    expect(blocks(withoutA.document.source)).toBe(0);
    expect(validateConventions(withoutA.document)).toEqual([]);
  });

  it('[TC-1-22-9] removes a graph block inside the deleted section', () => {
    const doc = parseDocument(
      '# Root\n\n## A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\n-->\n',
    ).document;
    const result = applyCommand(doc, { type: 'delete', node: find(doc, 'A').id });
    expect(result.document.source).toBe('# Root\n\n');
    expect(validateConventions(result.document)).toEqual([]);
  });

  it('[TC-1-22-15] keeps a graph that the cut removes and re-appends it', () => {
    const doc = parseDocument(
      '# Root\n\n## A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: b\n  - from: b\n    to: root\n-->\n\n## B <!-- ^b -->\n',
    ).document;
    const result = applyCommand(doc, { type: 'delete', node: find(doc, 'A').id });
    expect(result.document.graph.edges).toEqual([{ from: 'b', to: 'root', label: null }]);
    expect(result.document.source).toContain('<!-- markmap: graph');
    expect(validateConventions(result.document)).toEqual([]);
  });

  it('[TC-1-22-16] keeps an edge that does not name the deleted subtree', () => {
    const doc = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n- B <!-- ^b -->\n- C <!-- ^c -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: b\n  - from: b\n    to: c\n-->\n',
    ).document;
    const result = applyCommand(doc, { type: 'delete', node: find(doc, 'C').id });
    expect(result.document.graph.edges).toEqual([{ from: 'a', to: 'b', label: null }]);
    expect(find(result.document, 'A').identity?.id).toBe('a');
    expect(find(result.document, 'B').identity?.id).toBe('b');
    expect(validateConventions(result.document)).toEqual([]);
  });

  it('[TC-1-22-17] leaves an invalid graph untouched and keeps the edit non-fatal', () => {
    const doc = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n- B\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: z\n-->\n',
    ).document;
    const result = applyCommand(doc, { type: 'delete', node: find(doc, 'A').id });
    expect(result.document.graph.block).not.toBeNull();
    expect(result.document.conventionIssues.some((issue) => issue.code === 'E_GRAPH')).toBe(true);
  });

  it('[TC-1-22-18] removes a CRLF graph block and its blank line', () => {
    const doc = parseDocument(
      '# Root\r\n\r\n- A <!-- ^a -->\r\n\r\n<!-- markmap: graph\r\nedges:\r\n  - from: a\r\n    to: root\r\n-->\r\n',
    ).document;
    const result = applyCommand(doc, { type: 'delete', node: find(doc, 'A').id });
    expect(result.document.source).toBe('# Root\r\n\r\n');
    expect(validateConventions(result.document)).toEqual([]);
  });

  it('[TC-1-22-19] replaces a graph block without a trailing newline', () => {
    const doc = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n- B <!-- ^b -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: b\n  - from: b\n    to: root\n-->',
    ).document;
    const result = applyCommand(doc, { type: 'delete', node: find(doc, 'A').id });
    expect(result.document.graph.edges).toEqual([{ from: 'b', to: 'root', label: null }]);
    expect(validateConventions(result.document)).toEqual([]);
  });

  it('[TC-1-22-21] replaces a CRLF graph block that keeps data', () => {
    const doc = parseDocument(
      '# Root\r\n\r\n- A <!-- ^a -->\r\n- B <!-- ^b -->\r\n\r\n<!-- markmap: graph\r\nedges:\r\n  - from: a\r\n    to: b\r\n  - from: b\r\n    to: root\r\n-->\r\n',
    ).document;
    const result = applyCommand(doc, { type: 'delete', node: find(doc, 'A').id });
    expect(result.document.graph.edges).toEqual([{ from: 'b', to: 'root', label: null }]);
    expect(validateConventions(result.document)).toEqual([]);
  });
});

describe('graph errors', () => {
  it('[TC-1-22-10] leaves the document unchanged for an invalid pasted graph', () => {
    const doc = parseDocument(SOURCE).document;
    const source = doc.source;
    const invalid = '<!-- markmap: graph\nedges: [\n-->';
    let error: unknown;
    try {
      applyCommand(doc, { type: 'insertBlock', node: find(doc, 'Target').id, text: invalid });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EditError);
    expect(doc.source).toBe(source);
  });

  it('[TC-1-22-29] keeps existing convention issues without failing on offset shifts', () => {
    const doc = parseDocument(
      '# Root\n\n- DeleteMe <!-- ^d -->\n- Target <!-- ^t -->\n- Bad <!-- ^x --> <!-- ^y -->\n\n<!-- markmap: graph\nedges:\n  - from: d\n    to: t\n-->\n',
    ).document;
    const deleted = applyCommand(doc, { type: 'delete', node: find(doc, 'DeleteMe').id });
    expect(deleted.document.source).not.toContain('DeleteMe');
    expect(deleted.document.conventionIssues.some((issue) => issue.code === 'E_IDENTITY')).toBe(
      true,
    );

    const pasteTarget = parseDocument(
      '# Root\n\n- Target\n- Bad <!-- ^x --> <!-- ^y -->\n',
    ).document;
    const pasted = applyCommand(pasteTarget, {
      type: 'insertBlock',
      node: find(pasteTarget, 'Target').id,
      text: '- P <!-- ^p -->\n\n<!-- markmap: graph\nedges:\n  - from: p\n    to: root\n-->',
    });
    expect(pasted.document.graph.edges).toHaveLength(1);
    expect(pasted.document.conventionIssues.some((issue) => issue.code === 'E_IDENTITY')).toBe(
      true,
    );
  });
});

describe('group commands', () => {
  it('[TC-1-23-7] creates group boundary for single subtree, mints identity', () => {
    const doc = parseDocument('# Root\n\n- A\n- B\n').document;
    const aNode = find(doc, 'A');
    const result = applyCommand(doc, {
      type: 'createGroup',
      nodes: [aNode.id],
      label: 'Group A',
      random: () => 0,
    });
    expect(result.document.graph.groups).toHaveLength(1);
    expect(result.document.graph.groups[0].label).toBe('Group A');
    const aIdentity = find(result.document, 'A').identity?.id;
    expect(aIdentity).toBeDefined();
    expect(result.document.graph.groups[0].roots).toEqual([aIdentity]);
    expect(result.document.source).toContain(`<!-- ^${aIdentity} -->`);
    expect(validateConventions(result.document)).toEqual([]);

    const rootResult = applyCommand(doc, {
      type: 'createGroup',
      nodes: [doc.root],
      label: 'Root Group',
    });
    expect(rootResult.document.graph.groups[0].roots).toEqual(['root']);

    const withExisting = applyCommand(result.document, {
      type: 'createGroup',
      nodes: [find(result.document, 'B').id],
      label: 'Group B',
      random: () => 0,
    });
    expect(withExisting.document.graph.groups).toHaveLength(2);

    expect(() => applyCommand(doc, { type: 'createGroup', nodes: [] })).toThrow(EditError);
    expect(() => applyCommand(doc, { type: 'createGroup', nodes: ['missing'] })).toThrow(EditError);

    const docExistingId = parseDocument('# Root\n\n- A <!-- ^a -->\n').document;
    const noLabelResult = applyCommand(docExistingId, {
      type: 'createGroup',
      nodes: [find(docExistingId, 'A').id],
    });
    expect(noLabelResult.document.graph.groups[0].roots).toEqual(['a']);
    expect(noLabelResult.document.graph.groups[0].label).toBeNull();

    const noBlockDoc = parseDocument('# Root\n\n- A\n').document;
    const noBlockNode = find(noBlockDoc, 'A');
    noBlockNode.block = null;
    expect(() =>
      applyCommand(noBlockDoc, { type: 'createGroup', nodes: [noBlockNode.id] }),
    ).toThrow(EditError);

    const crlfDoc = parseDocument(
      '# Root\r\n\r\n- A <!-- ^a -->\r\n- B\r\n\r\n<!-- markmap: graph\r\ngroups:\n  - roots: [a]\r\n-->\r\n',
    ).document;
    const crlfResult = applyCommand(crlfDoc, {
      type: 'createGroup',
      nodes: [find(crlfDoc, 'B').id],
      random: () => 0,
    });
    expect(crlfResult.document.graph.groups).toHaveLength(2);

    const noNewlineDoc = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n- B\n\n<!-- markmap: graph\ngroups:\n  - roots: [a]\n-->',
    ).document;
    const noNewlineResult = applyCommand(noNewlineDoc, {
      type: 'createGroup',
      nodes: [find(noNewlineDoc, 'B').id],
      random: () => 0,
    });
    expect(noNewlineResult.document.graph.groups).toHaveLength(2);
  });

  it('[TC-1-23-8] creates group boundary for contiguous siblings under common parent', () => {
    const doc = parseDocument('# Root\n\n- A\n- B\n- C\n').document;
    const bNode = find(doc, 'B');
    const cNode = find(doc, 'C');
    const result = applyCommand(doc, {
      type: 'createGroup',
      nodes: [bNode.id, cNode.id],
      label: 'Siblings',
      random: () => 0,
    });
    expect(result.document.graph.groups).toHaveLength(1);
    expect(result.document.graph.groups[0].label).toBe('Siblings');
    const bId = find(result.document, 'B').identity?.id;
    const cId = find(result.document, 'C').identity?.id;
    expect(result.document.graph.groups[0].roots).toEqual([bId, cId]);
    expect(validateConventions(result.document)).toEqual([]);
  });

  it('[TC-1-23-9] rejects group with roots under different parents or non-contiguous siblings', () => {
    const doc = parseDocument('# Root\n\n- P1\n  - A\n- P2\n  - B\n- A2\n- Mid\n- A3\n').document;
    const aNode = find(doc, 'A');
    const bNode = find(doc, 'B');
    expect(() =>
      applyCommand(doc, {
        type: 'createGroup',
        nodes: [aNode.id, bNode.id],
      }),
    ).toThrow(EditError);

    const a2 = find(doc, 'A2');
    const a3 = find(doc, 'A3');
    expect(() =>
      applyCommand(doc, {
        type: 'createGroup',
        nodes: [a2.id, a3.id],
      }),
    ).toThrow(EditError);

    expect(() =>
      applyCommand(doc, {
        type: 'createGroup',
        nodes: [doc.root, aNode.id],
      }),
    ).toThrow(EditError);
  });

  it('[TC-1-23-10] rejects group whose subtree overlaps an existing group', () => {
    const doc = parseDocument(
      '# Root\n\n- P\n  - A <!-- ^a -->\n\n<!-- markmap: graph\ngroups:\n  - roots: [a]\n    label: Inner\n-->\n',
    ).document;
    const pNode = find(doc, 'P');
    expect(() =>
      applyCommand(doc, {
        type: 'createGroup',
        nodes: [pNode.id],
        label: 'Outer',
      }),
    ).toThrow(EditError);

    const rootDoc = parseDocument(
      '# Root\n\n- P\n\n<!-- markmap: graph\ngroups:\n  - roots: [root]\n    label: Top\n-->\n',
    ).document;
    expect(() =>
      applyCommand(rootDoc, {
        type: 'createGroup',
        nodes: [find(rootDoc, 'P').id],
      }),
    ).toThrow(EditError);

    const danglingDoc = parseDocument(
      '# Root\n\n- P\n\n<!-- markmap: graph\ngroups:\n  - roots: [z]\n    label: Top\n-->\n',
    ).document;
    const danglingResult = applyCommand(danglingDoc, {
      type: 'createGroup',
      nodes: [find(danglingDoc, 'P').id],
      random: () => 0,
    });
    expect(danglingResult.document.graph.groups).toHaveLength(2);
  });

  it('[TC-1-23-11] rejects group label with HTML comment markers', () => {
    const doc = parseDocument('# Root\n\n- A\n').document;
    const aNode = find(doc, 'A');
    expect(() =>
      applyCommand(doc, {
        type: 'createGroup',
        nodes: [aNode.id],
        label: 'Bad <!-- label -->',
      }),
    ).toThrow(EditError);
  });

  it('[TC-1-23-12] deletes group boundary and removes unreferenced markers', () => {
    const doc = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n- B <!-- ^b -->\n\n<!-- markmap: graph\nedges:\n  - from: b\n    to: root\ngroups:\n  - roots: [a]\n    label: DelMe\n-->\n',
    ).document;
    const result = applyCommand(doc, {
      type: 'deleteGroup',
      groupIndex: 0,
    });
    expect(result.document.graph.groups).toHaveLength(0);
    expect(result.document.graph.edges).toHaveLength(1);
    expect(find(result.document, 'A').identity).toBeNull();
    expect(find(result.document, 'B').identity?.id).toBe('b');
    expect(validateConventions(result.document)).toEqual([]);
    expect(() => applyCommand(doc, { type: 'deleteGroup', groupIndex: 99 })).toThrow(EditError);

    const twoGroupsDoc = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n- B <!-- ^b -->\n\n<!-- markmap: graph\ngroups:\n  - roots: [a]\n  - roots: [b]\n-->\n',
    ).document;
    const delOne = applyCommand(twoGroupsDoc, {
      type: 'deleteGroup',
      groupIndex: 0,
    });
    expect(delOne.document.graph.groups).toHaveLength(1);
    expect(find(delOne.document, 'A').identity).toBeNull();
    expect(find(delOne.document, 'B').identity?.id).toBe('b');
  });

  it('[TC-1-23-13] deletes group boundary and removes graph block when no data remains', () => {
    const doc = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n\n<!-- markmap: graph\ngroups:\n  - roots: [a]\n    label: DelMe\n-->\n',
    ).document;
    const result = applyCommand(doc, {
      type: 'deleteGroup',
      groupIndex: 0,
    });
    expect(result.document.graph.groups).toHaveLength(0);
    expect(result.document.graph.block).toBeNull();
    expect(result.document.source).toBe('# Root\n\n- A\n');
    expect(validateConventions(result.document)).toEqual([]);
  });

  it('[TC-1-23-14] sets group label in graph metadata', () => {
    const doc = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n\n<!-- markmap: graph\ngroups:\n  - roots: [a]\n    label: Old\n-->\n',
    ).document;
    const result = applyCommand(doc, {
      type: 'setGroupLabel',
      groupIndex: 0,
      text: 'New Label',
    });
    expect(result.document.graph.groups[0].label).toBe('New Label');
    expect(validateConventions(result.document)).toEqual([]);
    const cleared = applyCommand(result.document, {
      type: 'setGroupLabel',
      groupIndex: 0,
      text: '',
    });
    expect(cleared.document.graph.groups[0].label).toBeNull();
    expect(() =>
      applyCommand(result.document, {
        type: 'setGroupLabel',
        groupIndex: 0,
        text: 'Bad <!-- -->',
      }),
    ).toThrow(EditError);
    expect(() =>
      applyCommand(result.document, {
        type: 'setGroupLabel',
        groupIndex: 99,
        text: 'X',
      }),
    ).toThrow(EditError);
    const noGraph = parseDocument('# Root\n\n- A\n').document;
    expect(() =>
      applyCommand(noGraph, {
        type: 'setGroupLabel',
        groupIndex: 0,
        text: 'X',
      }),
    ).toThrow(EditError);

    const crlfLabelDoc = parseDocument(
      '# Root\r\n\r\n- A <!-- ^a -->\r\n\r\n<!-- markmap: graph\r\ngroups:\r\n  - roots: [a]\r\n    label: Old\r\n-->\r\n',
    ).document;
    const crlfLabelResult = applyCommand(crlfLabelDoc, {
      type: 'setGroupLabel',
      groupIndex: 0,
      text: 'CRLF New',
    });
    expect(crlfLabelResult.document.graph.groups[0].label).toBe('CRLF New');
  });
});
