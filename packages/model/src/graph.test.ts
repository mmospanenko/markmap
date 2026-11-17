import { describe, expect, it } from 'vitest';
import {
  buildDocument,
  labelText,
  mintIdentity,
  newConventionIssues,
  parseDocument,
  serializeGraphBlock,
  validateConventions,
  type Document,
  type EditNode,
} from '.';

function find(doc: Document, label: string): EditNode {
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (node && labelText(doc, node) === label) return node;
  }
  throw new Error(`No node labelled ${label}`);
}

function codes(doc: Document): string[] {
  return validateConventions(doc).map((issue) => issue.code);
}

function messages(doc: Document): string {
  return validateConventions(doc)
    .map((issue) => issue.message)
    .join(' ');
}

const GRAPH = `# Root

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

describe('identity', () => {
  it('[TC-1-20-1] attaches one trailing marker and the implicit root identity', () => {
    const parsed = parseDocument(GRAPH);
    const doc = parsed.document;
    const a = find(doc, 'A');
    expect(a.identity?.id).toBe('a');
    expect(a.identity?.range).not.toBeNull();
    expect(labelText(doc, a)).toBe('A');
    expect(doc.nodes.get(doc.root)?.identity).toEqual({ id: 'root', range: null });
    expect(doc.identities.get('a')).toBe(a.id);
    expect(doc.identities.get('root')).toBe(doc.root);
    expect(validateConventions(doc)).toEqual([]);
  });

  it('[TC-1-20-2] accepts compact markers, trailing spaces, CRLF, BOM and a non-root heading', () => {
    const source =
      '\uFEFF# Root\r\n\r\n## H<!--^A9-->   \r\n\r\n<!-- markmap: graph\r\nedges:\r\n  - from: A9\r\n    to: root\r\n-->\r\n';
    const doc = parseDocument(source).document;
    expect(find(doc, 'H').identity?.id).toBe('A9');
    expect(doc.source).toBe(source);
    expect(validateConventions(doc)).toEqual([]);
  });

  it('[TC-1-20-3] rejects a marker that is not the final token', () => {
    const placement = parseDocument(
      '# Root\n\n- A <!-- ^a --> more\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\n-->\n',
    ).document;
    const placed = placement.nodes.get(placement.order[1]);
    expect(placed?.identity).toBeNull();
    expect(messages(placement)).toMatch(/last token/i);
    const repeated = parseDocument(
      '# Root\n\n- A <!-- ^a --> <!-- ^b -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\n-->\n',
    ).document;
    expect(messages(repeated)).toMatch(/one marker/i);
  });

  it('[TC-1-20-4] rejects markers in notes, fences, frontmatter and standalone lines', () => {
    const note = parseDocument('# Root\n\n- A\n\n  note <!-- ^a -->\n').document;
    expect(codes(note)).toContain('E_IDENTITY');
    const fence = parseDocument('# Root\n\n- A\n\n  ```\n  <!-- ^a -->\n  ```\n').document;
    expect(codes(fence)).toContain('E_IDENTITY');
    const frontmatter = parseDocument('---\ntitle: "<!-- ^a -->"\n---\n\n# Root\n').document;
    expect(codes(frontmatter)).toContain('E_IDENTITY');
    const standalone = parseDocument('# Root\n\n<!-- ^a -->\n\n- A\n').document;
    expect(codes(standalone)).toContain('E_IDENTITY');
    const orphan = parseDocument('- A\n\n<!-- ^a -->\n').document;
    expect(messages(orphan)).toMatch(/stand alone|cannot stand/i);
    const inGraph = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\n    label: "<!-- ^b -->"\n-->\n',
    ).document;
    expect(messages(inGraph)).toMatch(/graph block/i);
  });

  it('[TC-1-20-5] rejects malformed, duplicate and unreferenced identities and the id colon form', () => {
    for (const marker of ['<!-- ^abcd -->', '<!-- ^a-b -->', '<!-- ^ -->']) {
      const doc = parseDocument(`# Root\n\n- A ${marker}\n`).document;
      expect(find(doc, 'A').identity).toBeNull();
      expect(codes(doc)).toContain('E_IDENTITY');
    }
    const duplicate = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n- B <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\n-->\n',
    ).document;
    expect(codes(duplicate)).toContain('E_IDENTITY');
    const unreferenced = parseDocument('# Root\n\n- A <!-- ^a -->\n').document;
    expect(messages(unreferenced)).toMatch(/not referenced/i);
    const colon = parseDocument(
      '# Root\n\n- A <!-- id:a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\n-->\n',
    ).document;
    expect(find(colon, 'A').identity).toBeNull();
    expect(codes(colon)).toContain('E_GRAPH');
  });

  it('[TC-1-20-6] rejects a marker on the source-heading root', () => {
    const doc = parseDocument(
      '# Root <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\n-->\n',
    ).document;
    expect(doc.nodes.get(doc.root)?.identity).toEqual({ id: 'root', range: null });
    expect(messages(doc)).toMatch(/root/i);
  });

  it('[TC-1-20-7] rejects a marker spanning more than one line', () => {
    const doc = parseDocument('# Root\n\n- A <!-- ^a\n -->\n').document;
    expect(find(doc, 'A').identity).toBeNull();
    expect(messages(doc)).toMatch(/one line/i);
  });
});

describe('graph', () => {
  it('[TC-1-21-1] parses one hidden block into typed edges and groups without a note', () => {
    const parsed = parseDocument(GRAPH);
    expect(parsed.document.graph.edges).toEqual([{ from: 'a', to: 'b', label: 'depends' }]);
    expect(parsed.document.graph.groups).toEqual([{ roots: ['a'], label: 'Delivery' }]);
    expect(parsed.document.graph.block).not.toBeNull();
    expect(parsed.tree.notes).toHaveLength(0);
    for (const id of parsed.document.order) {
      expect(parsed.document.nodes.get(id)?.notes).toEqual([]);
    }
  });

  it('[TC-1-21-2] rejects duplicate and misplaced graph blocks', () => {
    const block = '<!-- markmap: graph\nedges:\n  - from: a\n    to: root\n-->\n';
    const duplicate = parseDocument(`# Root\n\n- A <!-- ^a -->\n\n${block}\n${block}`).document;
    expect(codes(duplicate)).toContain('E_GRAPH');
    const extra = parseDocument(
      `# Root\n\n- A <!-- ^a -->\n\n${block}\n${block}\n\`\`\`\n${block}\`\`\`\n`,
    ).document;
    expect(codes(extra)).toContain('E_GRAPH');
    const fenced = parseDocument(`# Root\n\n- A <!-- ^a -->\n\n\`\`\`\n${block}\`\`\`\n`).document;
    expect(codes(fenced)).toContain('E_GRAPH');
    const nested = parseDocument(`# Root\n\n- A\n  ${block}`).document;
    expect(codes(nested)).toContain('E_GRAPH');
    const mixed = parseDocument(
      `# Root\n\n- A <!-- ^a -->\n\n${block}\n\`\`\`\n${block}\`\`\`\n`,
    ).document;
    expect(codes(mixed)).toContain('E_GRAPH');
  });

  it('[TC-1-21-3] reports malformed YAML and unknown fields without throwing', () => {
    const malformed = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n\n<!-- markmap: graph\nedges: [\n-->\n',
    ).document;
    expect(codes(malformed)).toContain('E_GRAPH');
    expect(malformed.graph.edges).toEqual([]);
    const unknown = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\nstyle: bold\n-->\n',
    ).document;
    expect(codes(unknown)).toContain('E_GRAPH');
    const empty = parseDocument('# Root\n\n- A\n\n<!-- markmap: graph\n-->\n').document;
    expect(validateConventions(empty)).toEqual([]);
    const nullData = parseDocument('# Root\n\n- A\n\n<!-- markmap: graph\nnull\n-->\n').document;
    expect(validateConventions(nullData)).toEqual([]);
  });

  it('[TC-1-21-8] rejects each wrong graph value type', () => {
    const bodies = [
      '42',
      'edges: 1',
      'edges:\n  - 1',
      'edges:\n  - from: a\n    to: root\n    label: 1',
      'groups: 1',
      'groups:\n  - 1',
    ];
    for (const body of bodies) {
      const doc = parseDocument(
        `# Root\n\n- A <!-- ^a -->\n\n<!-- markmap: graph\n${body}\n-->\n`,
      ).document;
      expect(codes(doc)).toContain('E_GRAPH');
    }
  });

  it('[TC-1-21-4] rejects dangling edges, empty groups and repeated roots', () => {
    const dangling = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: z\n-->\n',
    ).document;
    expect(messages(dangling)).toMatch(/z/);
    const empty = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\ngroups:\n  - roots: []\n-->\n',
    ).document;
    expect(codes(empty)).toContain('E_GRAPH');
    const within = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\ngroups:\n  - roots: [a, a]\n-->\n',
    ).document;
    expect(codes(within)).toContain('E_GRAPH');
    const across = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\ngroups:\n  - roots: [a]\n  - roots: [a]\n-->\n',
    ).document;
    expect(codes(across)).toContain('E_GRAPH');
    const missing = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\ngroups:\n  - roots: [z]\n-->\n',
    ).document;
    expect(messages(missing)).toMatch(/"z"/);
  });

  it('[TC-1-21-5] rejects overlapping group subtrees', () => {
    const doc = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n  - B <!-- ^b -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\ngroups:\n  - roots: [a]\n  - roots: [b]\n-->\n',
    ).document;
    expect(messages(doc)).toMatch(/overlap/i);
  });

  it('[TC-1-21-6] rejects unsafe comment delimiters and wrong value types', () => {
    const unsafe = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\n    label: "x --> y"\n-->\n',
    ).document;
    expect(codes(unsafe)).toContain('E_GRAPH');
    const open = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: a\n    to: root\n    label: "x <!-- y"\n-->\n',
    ).document;
    expect(codes(open)).toContain('E_GRAPH');
    const wrong = parseDocument(
      '# Root\n\n- A <!-- ^a -->\n\n<!-- markmap: graph\nedges:\n  - from: 1\n    to: root\n-->\n',
    ).document;
    expect(codes(wrong)).toContain('E_GRAPH');
  });

  it('[TC-1-21-9] compares convention issues by their full identity', () => {
    const before = parseDocument('# Root\n\n- A <!-- ^a -->\n').document;
    const same = parseDocument('# Root\n\n- A <!-- ^a -->\n').document;
    expect(newConventionIssues(before, same)).toEqual([]);
    const more = parseDocument('# Root\n\n- A <!-- ^a -->\n- B <!-- ^b -->\n').document;
    expect(newConventionIssues(before, more).length).toBeGreaterThan(0);
  });

  it('[TC-1-21-7] serializes one canonical block and keeps the source bytes', () => {
    const doc = buildDocument(GRAPH);
    const block = serializeGraphBlock(doc.graph, '\n');
    expect(block.startsWith('<!-- markmap: graph\n')).toBe(true);
    expect(block.endsWith('-->')).toBe(true);
    const round = parseDocument(`# Root\n\n- A <!-- ^a -->\n\n${block}\n`).document;
    expect(round.graph.edges).toEqual([{ from: 'a', to: 'b', label: 'depends' }]);
    expect(round.graph.groups).toEqual([{ roots: ['a'], label: 'Delivery' }]);
    expect(serializeGraphBlock({ edges: [], groups: [] }, '\n')).toBe('');
  });
});

describe('identity generation', () => {
  it('[TC-1-22-1] mints deterministically and refuses an exhausted space', () => {
    expect(mintIdentity(new Set(['0', '1']), () => 0)).toBe('2');
    expect(mintIdentity(new Set(['0', '1']), () => 0)).toBe(
      mintIdentity(new Set(['0', '1']), () => 0),
    );
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const one = new Set(alphabet.split(''));
    expect(mintIdentity(one, () => 0)).toHaveLength(2);
    const all = new Set<string>();
    for (const first of alphabet) all.add(first);
    for (const first of alphabet) for (const second of alphabet) all.add(first + second);
    for (const first of alphabet)
      for (const second of alphabet) for (const third of alphabet) all.add(first + second + third);
    expect(mintIdentity(all, () => 0)).toBeNull();
  });
});
