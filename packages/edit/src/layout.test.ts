import { buildDocument } from '@markmap/model';
import { describe, expect, it } from 'vitest';
import { applyCommand, EditError, planCommand } from '.';
import { validateCandidate } from './layout';

function editError(fn: () => unknown): EditError {
  try {
    fn();
  } catch (error) {
    if (error instanceof EditError) return error;
    throw error;
  }
  throw new Error('Expected an EditError');
}

describe('layout command', () => {
  it('[TC-5-1-1] updates markmap.layout in existing frontmatter preserving other fields, comments, and CRLF line endings', () => {
    const source =
      '---\r\ntitle: Sample\r\n# Useful note\r\nmarkmap:\r\n  colorScheme: dark\r\n---\r\n# Topic\r\n- Item\r\n';
    const doc = buildDocument(source);
    const result = applyCommand(doc, { type: 'setLayout', layout: 'org-chart' });
    expect(result.document.source).toBe(
      '---\r\ntitle: Sample\r\n# Useful note\r\nmarkmap:\r\n  layout: org-chart\r\n  colorScheme: dark\r\n---\r\n# Topic\r\n- Item\r\n',
    );
    expect(result.document.frontmatterRange).toEqual({
      start: 0,
      end: 90,
    });

    const frontmatterWithoutMarkmap = '---\ntitle: Simple\n---\n# Topic\n';
    const doc2 = buildDocument(frontmatterWithoutMarkmap);
    const result2 = applyCommand(doc2, { type: 'setLayout', layout: 'tree' });
    expect(result2.document.source).toBe(
      '---\ntitle: Simple\nmarkmap:\n  layout: tree\n---\n# Topic\n',
    );

    const frontmatterWithExistingLayout =
      '---\ntitle: Sample\n# Top comment\n\nmarkmap:\n  # Indented comment\n  colorScheme: light\n  layout: tree # on-line comment\n\nother: 123\n---\n# Topic\n';
    const doc3 = buildDocument(frontmatterWithExistingLayout);
    const result3 = applyCommand(doc3, { type: 'setLayout', layout: 'org-chart' });
    expect(result3.document.source).toBe(
      '---\ntitle: Sample\n# Top comment\n\nmarkmap:\n  # Indented comment\n  colorScheme: light\n  layout: org-chart # on-line comment\n\nother: 123\n---\n# Topic\n',
    );

    const frontmatterEmpty = '---\n---\n# Topic\n';
    const doc4 = buildDocument(frontmatterEmpty);
    const result4 = applyCommand(doc4, { type: 'setLayout', layout: 'org-chart' });
    expect(result4.document.source).toBe('---\nmarkmap:\n  layout: org-chart\n---\n# Topic\n');
  });

  it('[TC-5-1-2] inserts frontmatter with markmap.layout when document has no frontmatter', () => {
    const doc1 = buildDocument('# Topic\n- Item\n');
    const result1 = applyCommand(doc1, { type: 'setLayout', layout: 'org-chart' });
    expect(result1.document.source).toBe(
      '---\nmarkmap:\n  layout: org-chart\n---\n\n# Topic\n- Item\n',
    );

    const doc2 = buildDocument('');
    const result2 = applyCommand(doc2, { type: 'setLayout', layout: 'tree' });
    expect(result2.document.source).toBe('---\nmarkmap:\n  layout: tree\n---\n');

    const doc3 = buildDocument('\n# Topic\n');
    const result3 = applyCommand(doc3, { type: 'setLayout', layout: 'org-chart' });
    expect(result3.document.source).toBe('---\nmarkmap:\n  layout: org-chart\n---\n\n# Topic\n');

    const doc4 = buildDocument('# Topic\r\n- Item\r\n');
    const result4 = applyCommand(doc4, { type: 'setLayout', layout: 'org-chart' });
    expect(result4.document.source).toBe(
      '---\r\nmarkmap:\r\n  layout: org-chart\r\n---\r\n\r\n# Topic\r\n- Item\r\n',
    );

    const doc5 = buildDocument('\r\n# Topic\r\n');
    const result5 = applyCommand(doc5, { type: 'setLayout', layout: 'org-chart' });
    expect(result5.document.source).toBe(
      '---\r\nmarkmap:\r\n  layout: org-chart\r\n---\r\n\r\n# Topic\r\n',
    );
  });

  it('[TC-5-1-3] preserves BOM and body when modifying or inserting frontmatter', () => {
    const withBomNoFrontmatter = '\uFEFF# Topic\n- Item\n';
    const doc1 = buildDocument(withBomNoFrontmatter);
    const result1 = applyCommand(doc1, { type: 'setLayout', layout: 'org-chart' });
    expect(result1.document.source).toBe(
      '\uFEFF---\nmarkmap:\n  layout: org-chart\n---\n\n# Topic\n- Item\n',
    );
    expect(result1.document.source.startsWith('\uFEFF')).toBe(true);

    const withBomAndFrontmatter = '\uFEFF---\ntitle: Preserved\n---\n# Topic\n';
    const doc2 = buildDocument(withBomAndFrontmatter);
    const result2 = applyCommand(doc2, { type: 'setLayout', layout: 'tree' });
    expect(result2.document.source).toBe(
      '\uFEFF---\ntitle: Preserved\nmarkmap:\n  layout: tree\n---\n# Topic\n',
    );
    expect(result2.document.source.startsWith('\uFEFF')).toBe(true);
  });

  it('[TC-5-2-1] produces no edits when layout is already active', () => {
    const doc1 = buildDocument('# Topic\n- Item\n');
    const plan1 = planCommand(doc1, { type: 'setLayout', layout: 'two-sided' });
    expect(plan1.edits).toEqual([]);
    plan1.verify(doc1, 0);
    const result1 = applyCommand(doc1, { type: 'setLayout', layout: 'two-sided' });
    expect(result1.edits).toEqual([]);
    expect(result1.document.source).toBe(doc1.source);

    const doc2 = buildDocument('---\ntitle: Sample\n---\n# Topic\n');
    const plan2 = planCommand(doc2, { type: 'setLayout', layout: 'two-sided' });
    expect(plan2.edits).toEqual([]);
    plan2.verify(doc2, 0);

    const doc3 = buildDocument('---\nmarkmap:\n  layout: org-chart\n---\n# Topic\n');
    const plan3 = planCommand(doc3, { type: 'setLayout', layout: 'org-chart' });
    expect(plan3.edits).toEqual([]);
    plan3.verify(doc3, 0);
  });

  it('[TC-5-3-1] throws EditError with E_INVALID_COMMAND when frontmatter contains YAML errors', () => {
    const broken = '---\nfoo: : bar\n  [invalid\n---\n# Topic\n';
    const doc = buildDocument(broken);
    const error = editError(() => applyCommand(doc, { type: 'setLayout', layout: 'org-chart' }));
    expect(error.code).toBe('E_INVALID_COMMAND');
    expect(error.message).toBe('Frontmatter contains YAML errors');
  });

  it('[TC-5-5-1] ignores invalid layout string without modifying document', () => {
    const source = '---\ntitle: Sample\nmarkmap:\n  layout: tree\n---\n# Topic\n';
    const doc = buildDocument(source);
    const plan = planCommand(doc, { type: 'setLayout', layout: 'invalid-layout' });
    expect(plan.edits).toEqual([]);
    const result = applyCommand(doc, { type: 'setLayout', layout: 'invalid-layout' });
    expect(result.document.source).toBe(source);
  });

  it('[TC-5-6-1] safely refuses command when markmap is a YAML alias or non-mapping', () => {
    const aliasSource =
      '---\ncommon: &common\n  colorScheme: dark\nmarkmap: *common\n---\n# Topic\n';
    const doc1 = buildDocument(aliasSource);
    const error1 = editError(() => applyCommand(doc1, { type: 'setLayout', layout: 'org-chart' }));
    expect(error1.code).toBe('E_INVALID_COMMAND');
    expect(error1.message).toBe('Cannot modify layout through YAML alias');

    const scalarSource = '---\nmarkmap: bad\n---\n# Topic\n';
    const doc2 = buildDocument(scalarSource);
    const error2 = editError(() => applyCommand(doc2, { type: 'setLayout', layout: 'org-chart' }));
    expect(error2.code).toBe('E_INVALID_COMMAND');
    expect(error2.message).toBe('markmap is not a mapping');

    const nonScalarLayout = '---\nmarkmap:\n  layout: [1, 2]\n---\n# Topic\n';
    const doc3 = buildDocument(nonScalarLayout);
    const error3 = editError(() => applyCommand(doc3, { type: 'setLayout', layout: 'org-chart' }));
    expect(error3.code).toBe('E_INVALID_COMMAND');
    expect(error3.message).toBe('markmap.layout is not a scalar');

    const aliasLayoutSource =
      '---\ncommon: &common tree\nmarkmap:\n  layout: *common\n---\n# Topic\n';
    const doc4 = buildDocument(aliasLayoutSource);
    const error4 = editError(() => applyCommand(doc4, { type: 'setLayout', layout: 'org-chart' }));
    expect(error4.code).toBe('E_INVALID_COMMAND');
    expect(error4.message).toBe('Cannot modify layout through YAML alias');
  });

  it('[TC-5-6-2] supports empty markmap mapping formats', () => {
    const docEmptyMap = buildDocument('---\nmarkmap: {}\n---\n# Topic\n');
    const resultEmptyMap = applyCommand(docEmptyMap, { type: 'setLayout', layout: 'org-chart' });
    expect(resultEmptyMap.document.source).toBe(
      '---\nmarkmap:\n  layout: org-chart\n---\n# Topic\n',
    );

    const docEmptyMarkmap = buildDocument('---\ntitle: Test\nmarkmap:\n---\n# Topic\n');
    const resultEmptyMarkmap = applyCommand(docEmptyMarkmap, {
      type: 'setLayout',
      layout: 'org-chart',
    });
    expect(resultEmptyMarkmap.document.source).toBe(
      '---\ntitle: Test\nmarkmap:\n  layout: org-chart\n---\n# Topic\n',
    );

    const docNoNl = buildDocument('---\ntitle: Test\nmarkmap:---\n# Topic\n');
    const resultNoNl = applyCommand(docNoNl, { type: 'setLayout', layout: 'org-chart' });
    expect(resultNoNl.document.source).toContain('layout: org-chart');

    const planTwoSided = planCommand(docEmptyMap, { type: 'setLayout', layout: 'two-sided' });
    expect(planTwoSided.edits).toEqual([]);
  });

  it('[TC-5-8-1] inserts layout into nonempty inline mapping preserving style and other keys', () => {
    const docInline = buildDocument('---\nmarkmap: {theme: soft}\n---\n# Root\n');
    const result = applyCommand(docInline, { type: 'setLayout', layout: 'org-chart' });
    expect(result.document.source).toBe(
      '---\nmarkmap: {layout: org-chart, theme: soft}\n---\n# Root\n',
    );
  });

  it('[TC-5-8-2] refuses command when layout or markmap mapping has a YAML anchor', () => {
    const docAnchoredLayout = buildDocument(
      '---\nmarkmap:\n  layout: &chosen tree\ntheme: *chosen\n---\n# Root\n',
    );
    const errLayout = editError(() =>
      applyCommand(docAnchoredLayout, { type: 'setLayout', layout: 'org-chart' }),
    );
    expect(errLayout.code).toBe('E_INVALID_COMMAND');
    expect(errLayout.message).toContain('anchor');

    const docAnchoredMap = buildDocument(
      '---\nmarkmap: &shared\n  theme: soft\nother: *shared\n---\n# Root\n',
    );
    const errMap = editError(() =>
      applyCommand(docAnchoredMap, { type: 'setLayout', layout: 'org-chart' }),
    );
    expect(errMap.code).toBe('E_INVALID_COMMAND');
    expect(errMap.message).toContain('anchor');
  });

  it('[TC-5-8-3] refuses command when top-level frontmatter is a list or scalar', () => {
    const docList = buildDocument('---\n- one\n- two\n---\n# Root\n');
    const errList = editError(() =>
      applyCommand(docList, { type: 'setLayout', layout: 'org-chart' }),
    );
    expect(errList.code).toBe('E_INVALID_COMMAND');
    expect(errList.message).toBe('Top-level frontmatter must be a mapping');

    const docScalar = buildDocument('---\njust a string\n---\n# Root\n');
    const errScalar = editError(() =>
      applyCommand(docScalar, { type: 'setLayout', layout: 'org-chart' }),
    );
    expect(errScalar.code).toBe('E_INVALID_COMMAND');
    expect(errScalar.message).toBe('Top-level frontmatter must be a mapping');
  });

  it('[TC-5-9-1] handles empty layout values preserving spacing and comments', () => {
    const docWithComment = buildDocument(
      '---\nmarkmap:\n  layout: # keep this comment\n---\n# Root\n',
    );
    const resultWithComment = applyCommand(docWithComment, {
      type: 'setLayout',
      layout: 'org-chart',
    });
    expect(resultWithComment.document.source).toBe(
      '---\nmarkmap:\n  layout: org-chart # keep this comment\n---\n# Root\n',
    );

    const docBare = buildDocument('---\nmarkmap:\n  layout:\n---\n# Root\n');
    const resultBare = applyCommand(docBare, {
      type: 'setLayout',
      layout: 'org-chart',
    });
    expect(resultBare.document.source).toBe('---\nmarkmap:\n  layout: org-chart\n---\n# Root\n');
  });

  it('[TC-5-9-2] refuses command when layout is a block scalar', () => {
    const docBlock = buildDocument(
      '---\nmarkmap:\n  layout: |- # block comment\n    tree\n  theme: soft\n---\n# Root\n',
    );
    const errBlock = editError(() =>
      applyCommand(docBlock, { type: 'setLayout', layout: 'org-chart' }),
    );
    expect(errBlock.code).toBe('E_INVALID_COMMAND');
    expect(errBlock.message).toBe('Cannot modify block scalar layout');
  });

  it('[TC-5-9-3] inserts layout into top-level flow mapping and validates candidate', () => {
    const docFlow = buildDocument('---\n{title: Root, theme: soft}\n---\n# Root\n');
    const resultFlow = applyCommand(docFlow, {
      type: 'setLayout',
      layout: 'org-chart',
    });
    expect(resultFlow.document.source).toBe(
      '---\n{markmap: {layout: org-chart}, title: Root, theme: soft}\n---\n# Root\n',
    );

    const docEmptyFlow = buildDocument('---\n{}\n---\n# Root\n');
    const resultEmptyFlow = applyCommand(docEmptyFlow, {
      type: 'setLayout',
      layout: 'org-chart',
    });
    expect(resultEmptyFlow.document.source).toBe(
      '---\n{markmap: {layout: org-chart}}\n---\n# Root\n',
    );
  });

  it('[TC-5-9-4] handles tagged-null refusal, top-level alias/anchor, and anchor key indentation', () => {
    const docTaggedNull = buildDocument('---\nmarkmap:\n  layout: !!null # keep\n---\n# Root\n');
    const errTaggedNull = editError(() =>
      applyCommand(docTaggedNull, { type: 'setLayout', layout: 'org-chart' }),
    );
    expect(errTaggedNull.code).toBe('E_INVALID_COMMAND');
    expect(errTaggedNull.message).toBe('Cannot modify tagged layout');

    const docUntaggedNull = buildDocument('---\nmarkmap:\n  layout: null # keep\n---\n# Root\n');
    const resultUntaggedNull = applyCommand(docUntaggedNull, {
      type: 'setLayout',
      layout: 'org-chart',
    });
    expect(resultUntaggedNull.document.source).toBe(
      '---\nmarkmap:\n  layout: org-chart # keep\n---\n# Root\n',
    );

    const docTopAlias = buildDocument('---\n*shared\n---\n# Root\n');
    const errTopAlias = editError(() =>
      applyCommand(docTopAlias, { type: 'setLayout', layout: 'org-chart' }),
    );
    expect(errTopAlias.code).toBe('E_INVALID_COMMAND');
    expect(errTopAlias.message).toBe('Cannot modify layout through YAML alias');

    const docTopAnchor = buildDocument('---\n&shared\ntitle: Root\n---\n# Root\n');
    const errTopAnchor = editError(() =>
      applyCommand(docTopAnchor, { type: 'setLayout', layout: 'org-chart' }),
    );
    expect(errTopAnchor.code).toBe('E_INVALID_COMMAND');
    expect(errTopAnchor.message).toBe('Cannot modify anchored frontmatter');

    const docFollowed = buildDocument('---\nmarkmap:\ntitle: Followed\n---\n# Root\n');
    const resultFollowed = applyCommand(docFollowed, {
      type: 'setLayout',
      layout: 'org-chart',
    });
    expect(resultFollowed.document.source).toBe(
      '---\nmarkmap:\n  layout: org-chart\ntitle: Followed\n---\n# Root\n',
    );

    const docAnchorKey = buildDocument('---\nmarkmap:\n  &anchor theme: soft\n---\n# Root\n');
    const resultAnchorKey = applyCommand(docAnchorKey, {
      type: 'setLayout',
      layout: 'org-chart',
    });
    expect(resultAnchorKey.document.source).toBe(
      '---\nmarkmap:\n  layout: org-chart\n  &anchor theme: soft\n---\n# Root\n',
    );

    const doc = buildDocument('---\ntitle: Sample\nmarkmap:\n  colorScheme: dark\n---\n# Topic\n');
    validateCandidate(doc, [], 'org-chart');

    const errNoOpen = editError(() =>
      validateCandidate(doc, [{ from: 0, to: 4, insert: '' }], 'org-chart'),
    );
    expect(errNoOpen.message).toBe('Candidate frontmatter delimiter missing');

    const errNoClose = editError(() =>
      validateCandidate(
        doc,
        [
          {
            from: 0,
            to: doc.frontmatterRange?.end ?? 0,
            insert: '---\nmarkmap:\n  layout: org-chart\n',
          },
        ],
        'org-chart',
      ),
    );
    expect(errNoClose.message).toBe('Candidate frontmatter closing delimiter missing');

    const errInvalidYaml = editError(() =>
      validateCandidate(doc, [{ from: 4, to: 4, insert: '  [bad yaml\n' }], 'org-chart'),
    );
    expect(errInvalidYaml.message).toBe('Layout change produces invalid YAML');

    const errWrongLayout = editError(() =>
      validateCandidate(
        doc,
        [
          {
            from: 0,
            to: doc.frontmatterRange?.end ?? 0,
            insert: '---\ntitle: Sample\nmarkmap:\n  layout: tree\n---\n',
          },
        ],
        'org-chart',
      ),
    );
    expect(errWrongLayout.message).toBe('Layout change does not resolve to target layout');

    const errModBody = editError(() =>
      validateCandidate(
        doc,
        [
          {
            from: 0,
            to: doc.frontmatterRange?.end ?? 0,
            insert: '---\ntitle: Sample\nmarkmap:\n  colorScheme: dark\n  layout: org-chart\n---\n',
          },
          { from: doc.source.length - 2, to: doc.source.length, insert: 'modified' },
        ],
        'org-chart',
      ),
    );
    expect(errModBody.message).toBe('Layout change modified document body');

    const errModMm = editError(() =>
      validateCandidate(
        doc,
        [
          {
            from: 0,
            to: doc.frontmatterRange?.end ?? 0,
            insert: '---\ntitle: Sample\nmarkmap:\n  colorScheme: light\n  layout: org-chart\n---',
          },
        ],
        'org-chart',
      ),
    );
    expect(errModMm.message).toContain('modified markmap.colorScheme');

    const errModKey = editError(() =>
      validateCandidate(
        doc,
        [
          {
            from: 0,
            to: doc.frontmatterRange?.end ?? 0,
            insert: '---\ntitle: Changed\nmarkmap:\n  colorScheme: dark\n  layout: org-chart\n---',
          },
        ],
        'org-chart',
      ),
    );
    expect(errModKey.message).toContain('modified frontmatter key title');

    const docNoFm = buildDocument('# Topic\n');
    const errNoFmBody = editError(() =>
      validateCandidate(
        docNoFm,
        [{ from: 0, to: 0, insert: '---\nmarkmap:\n  layout: org-chart\n---\nmodified\n' }],
        'org-chart',
      ),
    );
    expect(errNoFmBody.message).toBe('Layout change modified document body');

    const synthDoc1 = { ...doc, source: 'invalid' };
    const errOrigOpen = editError(() =>
      validateCandidate(
        synthDoc1,
        [{ from: 0, to: 7, insert: '---\nmarkmap:\n  layout: org-chart\n---\n' }],
        'org-chart',
      ),
    );
    expect(errOrigOpen.message).toBe('Original frontmatter delimiter missing');

    const synthDoc2 = { ...doc, source: '---\nno close\n' };
    const errOrigClose = editError(() =>
      validateCandidate(
        synthDoc2,
        [{ from: 0, to: 17, insert: '---\nmarkmap:\n  layout: org-chart\n---\n' }],
        'org-chart',
      ),
    );
    expect(errOrigClose.message).toBe('Original frontmatter closing delimiter missing');
  });

  it('preserves node selection offset when node parameter is provided', () => {
    const doc = buildDocument('# Topic\n- Item\n');
    const itemNode = [...doc.nodes.values()].find((n) => n.kind === 'listItem');
    expect(itemNode).toBeDefined();
    if (!itemNode) throw new Error('Missing node');
    const result = applyCommand(doc, {
      type: 'setLayout',
      layout: 'org-chart',
      node: itemNode.id,
    });
    expect(result.selection).toBe(result.document.source.indexOf('- Item') + 2);

    const docWithFrontmatter = buildDocument('---\ntitle: Sample\n---\n# Topic\n- Item\n');
    const itemNode2 = [...docWithFrontmatter.nodes.values()].find((n) => n.kind === 'listItem');
    expect(itemNode2).toBeDefined();
    if (!itemNode2) throw new Error('Missing node');
    const result2 = applyCommand(docWithFrontmatter, {
      type: 'setLayout',
      layout: 'tree',
      node: itemNode2.id,
    });
    expect(result2.selection).toBe(result2.document.source.indexOf('- Item') + 2);

    const resultWithoutNode = applyCommand(docWithFrontmatter, {
      type: 'setLayout',
      layout: 'org-chart',
    });
    expect(resultWithoutNode.selection).toBe(resultWithoutNode.document.source.indexOf('# Topic'));
  });
});
