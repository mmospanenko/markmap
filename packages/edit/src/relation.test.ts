import { describe, expect, it } from 'vitest';
import { labelText, parseDocument, type Document, type EditNode } from '@markmap/model';
import { applyCommand, planCommand, EditError } from '.';

function find(doc: Document, label: string): EditNode {
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (node && labelText(doc, node) === label) return node;
  }
  throw new Error(`No node labelled ${label}`);
}

function makeIdentityIssueDoc(): Document {
  return parseDocument('- Node 1 <!-- ^dup -->\n- Node 2 <!-- ^dup -->\n').document;
}

describe('createEdge', () => {
  it('[TC-1-24-1] mints markers and creates graph block when nodes have no markers', () => {
    const doc = parseDocument('# Root\n\n- Node A\n- Node B\n').document;
    const a = find(doc, 'Node A');
    const b = find(doc, 'Node B');
    const result = applyCommand(doc, {
      type: 'createEdge',
      from: a.id,
      to: b.id,
      random: () => 0,
    });
    expect(result.document.graph.edges).toHaveLength(1);
    expect(result.document.source).toContain('<!-- markmap: graph');
    expect(result.document.source).toContain('Node A <!-- ^0 -->');
    expect(result.document.source).toContain('Node B <!-- ^1 -->');
    expect(result.document.graph.edges[0]).toEqual({
      from: '0',
      to: '1',
      label: null,
    });

    const invalidDoc = parseDocument(
      '<!-- markmap: graph\nedges:\n  - from: missing1\n    to: missing2\n-->\n- a\n',
    ).document;
    const createPlan = planCommand(doc, { type: 'createEdge', from: a.id, to: b.id });
    expect(() => createPlan.verify(makeIdentityIssueDoc(), 0)).toThrow(
      'The created edge produced convention issues',
    );
    expect(() => createPlan.verify(invalidDoc, 0)).toThrow(
      'The created edge produced convention issues',
    );
    expect(() => createPlan.verify(doc, 0)).toThrow('The created edge did not survive parsing');
  });

  it('[TC-1-24-2] reuses existing markers without minting duplicates', () => {
    const doc = parseDocument(
      '# Root\n\n- Node A <!-- ^a -->\n- Node B <!-- ^b -->\n- Node C <!-- ^c -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: c\n-->\n',
    ).document;
    const a = find(doc, 'Node A');
    const b = find(doc, 'Node B');
    const result = applyCommand(doc, {
      type: 'createEdge',
      from: a.id,
      to: b.id,
    });
    expect(result.document.graph.edges).toHaveLength(2);
    expect(result.document.source).toContain('Node A <!-- ^a -->');
    expect(result.document.source).toContain('Node B <!-- ^b -->');
    expect(result.document.graph.edges[1]).toEqual({
      from: 'a',
      to: 'b',
      label: null,
    });
  });

  it('[TC-1-24-3] uses implicit root identity without marker on root', () => {
    const doc = parseDocument(
      '# Root\n\n- Node A <!-- ^a -->\n- Node B <!-- ^b -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: b\n-->\n',
    ).document;
    const root = doc.nodes.get(doc.root);
    if (!root) throw new Error('No root');
    const a = find(doc, 'Node A');
    const result = applyCommand(doc, {
      type: 'createEdge',
      from: root.id,
      to: a.id,
    });
    expect(result.document.source).not.toContain('# Root <!--');
    expect(result.document.graph.edges.some((e) => e.from === 'root' && e.to === 'a')).toBe(true);

    const result2 = applyCommand(doc, {
      type: 'createEdge',
      from: a.id,
      to: root.id,
    });
    expect(result2.document.source).not.toContain('# Root <!--');
    expect(result2.document.graph.edges.some((e) => e.from === 'a' && e.to === 'root')).toBe(true);
  });

  it('[TC-1-24-4] serializes edge label in graph block', () => {
    const doc = parseDocument(
      '# Root\n\n- Node A <!-- ^a -->\n- Node B <!-- ^b -->\n- Node C <!-- ^c -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: c\n-->\n',
    ).document;
    const a = find(doc, 'Node A');
    const b = find(doc, 'Node B');
    const result = applyCommand(doc, {
      type: 'createEdge',
      from: a.id,
      to: b.id,
      label: 'depends on',
    });
    expect(result.document.graph.edges.find((e) => e.from === 'a' && e.to === 'b')?.label).toBe(
      'depends on',
    );
    expect(result.document.source).toContain('label: "depends on"');

    const crlfDoc = parseDocument('# Root\r\n\r\n- Node A   \r\n- Node B\r\n').document;
    const aCrlf = find(crlfDoc, 'Node A');
    const bCrlf = find(crlfDoc, 'Node B');
    const crlfResult = applyCommand(crlfDoc, {
      type: 'createEdge',
      from: aCrlf.id,
      to: bCrlf.id,
    });
    expect(crlfResult.document.source).toContain('\r\n');
  });

  it('[TC-1-24-5] rejects self-loops', () => {
    const doc = parseDocument('# Root\n\n- Node A\n').document;
    const a = find(doc, 'Node A');
    expect(() =>
      applyCommand(doc, {
        type: 'createEdge',
        from: a.id,
        to: a.id,
      }),
    ).toThrow(EditError);

    const issueDoc = parseDocument(
      '<!-- markmap: graph\nedges:\n  - from: missing1\n    to: missing2\n-->\n- a\n',
    ).document;
    expect(() =>
      applyCommand(issueDoc, {
        type: 'createEdge',
        from: 'a',
        to: 'a',
      }),
    ).toThrow('The document graph metadata is invalid');
  });

  it('[TC-1-24-6] rejects duplicate parallel edges', () => {
    const doc = parseDocument(
      '# Root\n\n- Node A <!-- ^a -->\n- Node B <!-- ^b -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: b\n-->\n',
    ).document;
    const a = find(doc, 'Node A');
    const b = find(doc, 'Node B');
    expect(() =>
      applyCommand(doc, {
        type: 'createEdge',
        from: a.id,
        to: b.id,
      }),
    ).toThrow(EditError);
  });

  it('[TC-1-24-7] rejects opaque nodes', () => {
    const doc = parseDocument('- Normal\n- # Opaque\n').document;
    const opaqueNode = find(doc, 'Opaque');
    const normal = find(doc, 'Normal');
    expect(() =>
      applyCommand(doc, {
        type: 'createEdge',
        from: opaqueNode.id,
        to: normal.id,
      }),
    ).toThrow(EditError);
    expect(() =>
      applyCommand(doc, {
        type: 'createEdge',
        from: normal.id,
        to: opaqueNode.id,
      }),
    ).toThrow(EditError);
  });

  it('[TC-1-24-8] rejects non-existent endpoints', () => {
    const doc = parseDocument('# Root\n\n- Node A\n').document;
    const a = find(doc, 'Node A');
    expect(() =>
      applyCommand(doc, {
        type: 'createEdge',
        from: a.id,
        to: 'non-existent',
      }),
    ).toThrow(EditError);
    expect(() =>
      applyCommand(doc, {
        type: 'createEdge',
        from: 'non-existent',
        to: a.id,
      }),
    ).toThrow(EditError);
  });

  it('[TC-1-24-9] rejects label containing HTML comments', () => {
    const doc = parseDocument('# Root\n\n- Node A\n- Node B\n').document;
    const a = find(doc, 'Node A');
    const b = find(doc, 'Node B');
    expect(() =>
      applyCommand(doc, {
        type: 'createEdge',
        from: a.id,
        to: b.id,
        label: 'invalid <!-- comment --> label',
      }),
    ).toThrow(EditError);
    expect(() =>
      applyCommand(doc, {
        type: 'createEdge',
        from: a.id,
        to: b.id,
        label: 'invalid --> label',
      }),
    ).toThrow(EditError);
  });
});

describe('deleteEdge and setEdgeLabel', () => {
  it('[TC-1-25-1] removes edge and removes graph block when empty', () => {
    const doc = parseDocument(
      '# Root\n\n- Node A <!-- ^a -->\n- Node B <!-- ^b -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: b\n-->\n',
    ).document;
    const a = find(doc, 'Node A');
    const b = find(doc, 'Node B');
    const result = applyCommand(doc, {
      type: 'deleteEdge',
      from: a.id,
      to: b.id,
    });
    expect(result.document.graph.edges).toHaveLength(0);
    expect(result.document.source).not.toContain('<!-- markmap: graph');

    const rootDoc = parseDocument(
      '# Root\n\n- Node A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: root\n    to: a\n-->\n',
    ).document;
    const aNode = find(rootDoc, 'Node A');
    const delRootResult = applyCommand(rootDoc, {
      type: 'deleteEdge',
      from: 'root',
      to: aNode.id,
    });
    expect(delRootResult.document.graph.edges).toHaveLength(0);

    const invalidDoc = parseDocument(
      '<!-- markmap: graph\nedges:\n  - from: missing1\n    to: missing2\n-->\n- a\n',
    ).document;
    const deletePlan = planCommand(doc, { type: 'deleteEdge', from: a.id, to: b.id });
    expect(() => deletePlan.verify(makeIdentityIssueDoc(), 0)).toThrow(
      'Deleting edge produced convention issues',
    );
    expect(() => deletePlan.verify(invalidDoc, 0)).toThrow(
      'Deleting edge produced convention issues',
    );
    expect(() => deletePlan.verify(doc, 0)).toThrow('The edge was not deleted');
  });

  it('[TC-1-25-2] removes edge and cleans unreferenced markers', () => {
    const doc = parseDocument(
      '# Root\n\n- Node A <!-- ^a -->\n- Node B <!-- ^b -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: b\n-->\n',
    ).document;
    const a = find(doc, 'Node A');
    const b = find(doc, 'Node B');
    const result = applyCommand(doc, {
      type: 'deleteEdge',
      from: a.id,
      to: b.id,
    });
    expect(result.document.source).not.toContain('<!-- ^a -->');
    expect(result.document.source).not.toContain('<!-- ^b -->');
  });

  it('[TC-1-25-3] keeps markers still referenced by other edges or groups', () => {
    const doc = parseDocument(
      '# Root\n\n- Node A <!-- ^a -->\n- Node B <!-- ^b -->\n- Node C <!-- ^c -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: b\n  - from: b\n    to: c\n-->\n',
    ).document;
    const a = find(doc, 'Node A');
    const b = find(doc, 'Node B');
    const result = applyCommand(doc, {
      type: 'deleteEdge',
      from: a.id,
      to: b.id,
    });
    expect(result.document.source).not.toContain('<!-- ^a -->');
    expect(result.document.source).toContain('Node B <!-- ^b -->');
    expect(result.document.source).toContain('Node C <!-- ^c -->');
    expect(result.document.graph.edges).toHaveLength(1);

    const groupDoc = parseDocument(
      '# Root\n\n- Node A <!-- ^a -->\n- Node B <!-- ^b -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: b\ngroups:\n  - roots: ["b"]\n-->\n',
    ).document;
    const ga = find(groupDoc, 'Node A');
    const gb = find(groupDoc, 'Node B');
    const groupResult = applyCommand(groupDoc, {
      type: 'deleteEdge',
      from: ga.id,
      to: gb.id,
    });
    expect(groupResult.document.source).not.toContain('<!-- ^a -->');
    expect(groupResult.document.source).toContain('Node B <!-- ^b -->');
  });

  it('[TC-1-25-4] rejects non-existent edge on delete', () => {
    const doc = parseDocument(
      '# Root\n\n- Node A <!-- ^a -->\n- Node B <!-- ^b -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: b\n-->\n',
    ).document;
    const a = find(doc, 'Node A');
    const b = find(doc, 'Node B');
    expect(() =>
      applyCommand(doc, {
        type: 'deleteEdge',
        from: b.id,
        to: a.id,
      }),
    ).toThrow(EditError);

    const issueDoc = parseDocument(
      '<!-- markmap: graph\nedges:\n  - from: missing1\n    to: missing2\n-->\n- a\n',
    ).document;
    expect(() =>
      applyCommand(issueDoc, {
        type: 'deleteEdge',
        from: 'a',
        to: 'b',
      }),
    ).toThrow('The document graph metadata is invalid');
    expect(() =>
      applyCommand(issueDoc, {
        type: 'setEdgeLabel',
        from: 'a',
        to: 'b',
        label: 'x',
      }),
    ).toThrow('The document graph metadata is invalid');
  });

  it('[TC-1-25-5] updates existing edge label in graph block', () => {
    const doc = parseDocument(
      '# Root\n\n- Node A <!-- ^a -->\n- Node B <!-- ^b -->\n- Node C <!-- ^c -->\n\n<!-- markmap: graph\nedges:\n  - from: b\n    to: c\n  - from: a\n    to: b\n    label: old\n-->\n',
    ).document;
    const a = find(doc, 'Node A');
    const b = find(doc, 'Node B');
    const result = applyCommand(doc, {
      type: 'setEdgeLabel',
      from: a.id,
      to: b.id,
      label: 'new label',
    });
    const edgeAB = result.document.graph.edges.find((e) => e.from === 'a' && e.to === 'b');
    expect(edgeAB?.label).toBe('new label');
    expect(result.document.source).toContain('label: "new label"');

    const invalidDoc = parseDocument(
      '<!-- markmap: graph\nedges:\n  - from: missing1\n    to: missing2\n-->\n- a\n',
    ).document;
    const setPlan = planCommand(doc, { type: 'setEdgeLabel', from: a.id, to: b.id, label: 'new' });
    expect(() => setPlan.verify(makeIdentityIssueDoc(), 0)).toThrow(
      'Setting edge label produced convention issues',
    );
    expect(() => setPlan.verify(invalidDoc, 0)).toThrow(
      'Setting edge label produced convention issues',
    );
    expect(() => setPlan.verify(doc, 0)).toThrow('The edge label was not updated');

    const crlfDoc2 = parseDocument(
      '# Root\r\n\r\n- Node A <!-- ^a -->\r\n- Node B <!-- ^b -->\r\n\r\n<!-- markmap: graph\r\nedges:\r\n  - from: a\r\n    to: b\r\n    label: old\r\n-->\r\n',
    ).document;
    const a2 = find(crlfDoc2, 'Node A');
    const b2 = find(crlfDoc2, 'Node B');
    const crlfResult2 = applyCommand(crlfDoc2, {
      type: 'setEdgeLabel',
      from: a2.id,
      to: b2.id,
      label: 'updated',
    });
    expect(crlfResult2.document.source).toContain('\r\n');

    const rootDoc = parseDocument(
      '# Root\n\n- Node A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: root\n    to: a\n-->\n',
    ).document;
    const aNode = find(rootDoc, 'Node A');
    const setRootResult = applyCommand(rootDoc, {
      type: 'setEdgeLabel',
      from: 'root',
      to: aNode.id,
      label: 'from root',
    });
    expect(setRootResult.document.graph.edges[0]?.label).toBe('from root');
  });

  it('[TC-1-25-6] clears label when passed null or empty string', () => {
    const doc = parseDocument(
      '# Root\n\n- Node A <!-- ^a -->\n- Node B <!-- ^b -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: b\n    label: existing\n-->\n',
    ).document;
    const a = find(doc, 'Node A');
    const b = find(doc, 'Node B');
    const result = applyCommand(doc, {
      type: 'setEdgeLabel',
      from: a.id,
      to: b.id,
      label: null,
    });
    expect(result.document.graph.edges[0]?.label).toBeNull();
    expect(result.document.source).not.toContain('label:');

    const result2 = applyCommand(doc, {
      type: 'setEdgeLabel',
      from: a.id,
      to: b.id,
      label: '   ',
    });
    expect(result2.document.graph.edges[0]?.label).toBeNull();
  });

  it('[TC-1-25-7] rejects label containing HTML comments on update', () => {
    const doc = parseDocument(
      '# Root\n\n- Node A <!-- ^a -->\n- Node B <!-- ^b -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: b\n-->\n',
    ).document;
    const a = find(doc, 'Node A');
    const b = find(doc, 'Node B');
    expect(() =>
      applyCommand(doc, {
        type: 'setEdgeLabel',
        from: a.id,
        to: b.id,
        label: 'test <!-- bad -->',
      }),
    ).toThrow(EditError);
  });

  it('[TC-1-25-8] rejects non-existent edge on setEdgeLabel', () => {
    const doc = parseDocument(
      '# Root\n\n- Node A <!-- ^a -->\n- Node B <!-- ^b -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: b\n-->\n',
    ).document;
    const a = find(doc, 'Node A');
    const b = find(doc, 'Node B');
    expect(() =>
      applyCommand(doc, {
        type: 'setEdgeLabel',
        from: b.id,
        to: a.id,
        label: 'new',
      }),
    ).toThrow(EditError);

    const invalidDoc = parseDocument(
      '<!-- markmap: graph\nedges:\n  - from: missing1\n    to: missing2\n-->\n- a\n',
    ).document;
    expect(() =>
      applyCommand(invalidDoc, {
        type: 'createEdge',
        from: a.id,
        to: b.id,
      }),
    ).toThrow(EditError);
    expect(() =>
      applyCommand(invalidDoc, {
        type: 'deleteEdge',
        from: 'missing1',
        to: 'missing2',
      }),
    ).toThrow(EditError);
    expect(() =>
      applyCommand(invalidDoc, {
        type: 'setEdgeLabel',
        from: 'missing1',
        to: 'missing2',
        label: 'x',
      }),
    ).toThrow(EditError);
  });

  it('rejects createEdge when identity space is exhausted', () => {
    const doc1 = parseDocument('# Root\n\n- Node A\n- Node B\n').document;
    const a1 = find(doc1, 'Node A');
    const b1 = find(doc1, 'Node B');
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    for (const first of alphabet) doc1.identities.set(first, 'x');
    for (const first of alphabet)
      for (const second of alphabet) doc1.identities.set(first + second, 'x');
    for (const first of alphabet)
      for (const second of alphabet)
        for (const third of alphabet) doc1.identities.set(first + second + third, 'x');
    expect(() =>
      planCommand(doc1, {
        type: 'createEdge',
        from: a1.id,
        to: b1.id,
      }),
    ).toThrow('No node identity characters remain');

    const doc2 = parseDocument('# Root\n\n- Node A <!-- ^a -->\n- Node B\n').document;
    const a2 = find(doc2, 'Node A');
    const b2 = find(doc2, 'Node B');
    for (const first of alphabet) doc2.identities.set(first, 'x');
    for (const first of alphabet)
      for (const second of alphabet) doc2.identities.set(first + second, 'x');
    for (const first of alphabet)
      for (const second of alphabet)
        for (const third of alphabet) doc2.identities.set(first + second + third, 'x');
    expect(() =>
      planCommand(doc2, {
        type: 'createEdge',
        from: a2.id,
        to: b2.id,
      }),
    ).toThrow('No node identity characters remain');
  });
});
