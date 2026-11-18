import type { Document } from '@markmap/model';
import { isAlias, isMap, isScalar, parseDocument as parseYamlDocument } from 'yaml';
import type { Plan } from './commands';
import { EditError } from './errors';

const VALID_LAYOUTS = new Set(['tree', 'two-sided', 'org-chart']);

function noopVerify(): void {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  return {};
}

function extractYamlContent(raw: string): { content: string; openLen: number } {
  let content = raw;
  const openMatch = /^---[ \t]*(?:\r?\n|$)/.exec(content);
  const openLen = openMatch ? openMatch[0].length : 0;
  if (openMatch) {
    content = content.slice(openMatch[0].length);
  }
  const closeMatch = /(?:\r?\n|^)---[ \t]*$/.exec(content);
  if (closeMatch) {
    content = content.slice(0, closeMatch.index);
  }
  return { content, openLen };
}

export function validateCandidate(
  doc: Document,
  edits: Array<{ from: number; to: number; insert: string }>,
  targetLayout: string,
): void {
  if (edits.length === 0) {
    return;
  }
  let candidate = doc.source;
  const sorted = edits.toSorted((a, b) => b.from - a.from);
  for (const edit of sorted) {
    candidate = candidate.slice(0, edit.from) + edit.insert + candidate.slice(edit.to);
  }

  const bomLen = candidate.startsWith('\uFEFF') ? 1 : 0;
  const withoutBom = candidate.slice(bomLen);
  const openMatch = /^---[ \t]*(?:\r?\n|$)/.exec(withoutBom);
  if (!openMatch) {
    throw new EditError('E_INVALID_COMMAND', 'Candidate frontmatter delimiter missing');
  }
  const afterOpen = withoutBom.slice(openMatch[0].length);
  const closeMatch = /(?:\r?\n|^)---[ \t]*(?:\r?\n|$)/.exec(afterOpen);
  if (!closeMatch) {
    throw new EditError('E_INVALID_COMMAND', 'Candidate frontmatter closing delimiter missing');
  }
  const candidateYaml = afterOpen.slice(0, closeMatch.index);
  const candidateDoc = parseYamlDocument(candidateYaml);
  if (candidateDoc.errors.length > 0 || candidateDoc.warnings.length > 0) {
    throw new EditError('E_INVALID_COMMAND', 'Layout change produces invalid YAML');
  }

  const resolvedLayout = candidateDoc.getIn(['markmap', 'layout']);
  if (String(resolvedLayout ?? '') !== targetLayout) {
    throw new EditError('E_INVALID_COMMAND', 'Layout change does not resolve to target layout');
  }

  const candBody = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  const origWithoutBom = doc.source.slice(doc.source.startsWith('\uFEFF') ? 1 : 0);

  if (doc.frontmatterRange !== null) {
    const origOpenMatch = /^---[ \t]*(?:\r?\n|$)/.exec(origWithoutBom);
    if (!origOpenMatch) {
      throw new EditError('E_INVALID_COMMAND', 'Original frontmatter delimiter missing');
    }
    const origAfterOpen = origWithoutBom.slice(origOpenMatch[0].length);
    const origCloseMatch = /(?:\r?\n|^)---[ \t]*(?:\r?\n|$)/.exec(origAfterOpen);
    if (!origCloseMatch) {
      throw new EditError('E_INVALID_COMMAND', 'Original frontmatter closing delimiter missing');
    }
    const origBody = origAfterOpen.slice(origCloseMatch.index + origCloseMatch[0].length);
    if (candBody !== origBody) {
      throw new EditError('E_INVALID_COMMAND', 'Layout change modified document body');
    }

    const origRaw = doc.source.slice(doc.frontmatterRange.start, doc.frontmatterRange.end);
    const { content: origYaml } = extractYamlContent(origRaw);
    const origDoc = parseYamlDocument(origYaml);
    const origJson = toRecord(origDoc.toJSON());
    const candJson = toRecord(candidateDoc.toJSON());

    for (const [key, val] of Object.entries(origJson)) {
      if (key === 'markmap') {
        const origMm = toRecord(val);
        const candMm = toRecord(candJson[key]);
        for (const [mmKey, mmVal] of Object.entries(origMm)) {
          if (mmKey === 'layout') {
            continue;
          }
          if (JSON.stringify(candMm[mmKey]) !== JSON.stringify(mmVal)) {
            throw new EditError('E_INVALID_COMMAND', `Layout change modified markmap.${mmKey}`);
          }
        }
      } else {
        if (JSON.stringify(candJson[key]) !== JSON.stringify(val)) {
          throw new EditError('E_INVALID_COMMAND', `Layout change modified frontmatter key ${key}`);
        }
      }
    }
  } else {
    const newline = doc.source.includes('\r\n') ? '\r\n' : '\n';
    const expectedBody =
      origWithoutBom.length > 0 &&
      !origWithoutBom.startsWith('\r\n') &&
      !origWithoutBom.startsWith('\n')
        ? `${newline}${origWithoutBom}`
        : origWithoutBom;
    if (candBody !== expectedBody) {
      throw new EditError('E_INVALID_COMMAND', 'Layout change modified document body');
    }
  }
}

function createCandidatePlan(
  doc: Document,
  edits: Array<{ from: number; to: number; insert: string }>,
  selection: Plan['selection'],
  targetLayout: string,
): Plan {
  validateCandidate(doc, edits, targetLayout);
  return {
    edits,
    selection,
    verify: () => validateCandidate(doc, edits, targetLayout),
  };
}

export function planSetLayout(doc: Document, layout: string, nodeId?: string | null): Plan {
  const node = nodeId ? doc.nodes.get(nodeId) : undefined;
  const offset = node?.label ? node.label.start : doc.rootPolicy.bodyStart;
  const selection: Plan['selection'] = { kind: 'source', offset };

  if (!VALID_LAYOUTS.has(layout)) {
    return {
      edits: [],
      selection,
      verify: noopVerify,
    };
  }

  if (doc.frontmatterRange !== null) {
    const raw = doc.source.slice(doc.frontmatterRange.start, doc.frontmatterRange.end);
    const newline = raw.includes('\r\n') ? '\r\n' : '\n';
    const { content: yamlContent, openLen } = extractYamlContent(raw);
    const yamlDoc = parseYamlDocument(yamlContent);
    if (yamlDoc.errors.length > 0) {
      throw new EditError('E_INVALID_COMMAND', 'Frontmatter contains YAML errors');
    }
    if (isAlias(yamlDoc.contents)) {
      throw new EditError('E_INVALID_COMMAND', 'Cannot modify layout through YAML alias');
    }
    if (
      typeof yamlDoc.contents === 'object' &&
      yamlDoc.contents !== null &&
      'anchor' in yamlDoc.contents &&
      Boolean(yamlDoc.contents.anchor)
    ) {
      throw new EditError('E_INVALID_COMMAND', 'Cannot modify anchored frontmatter');
    }
    if (yamlDoc.contents !== null && yamlDoc.contents !== undefined && !isMap(yamlDoc.contents)) {
      throw new EditError('E_INVALID_COMMAND', 'Top-level frontmatter must be a mapping');
    }

    const markmapNode = yamlDoc.get('markmap', true);
    if (isAlias(markmapNode)) {
      throw new EditError('E_INVALID_COMMAND', 'Cannot modify layout through YAML alias');
    }
    if (
      typeof markmapNode === 'object' &&
      markmapNode !== null &&
      'anchor' in markmapNode &&
      Boolean(markmapNode.anchor)
    ) {
      throw new EditError('E_INVALID_COMMAND', 'Cannot modify anchored markmap mapping');
    }
    if (
      markmapNode !== undefined &&
      markmapNode !== null &&
      !isMap(markmapNode) &&
      !(isScalar(markmapNode) && markmapNode.value === null)
    ) {
      throw new EditError('E_INVALID_COMMAND', 'markmap is not a mapping');
    }

    if (isMap(markmapNode) || (isScalar(markmapNode) && markmapNode.value === null)) {
      const layoutNode = isMap(markmapNode)
        ? yamlDoc.getIn(['markmap', 'layout'], true)
        : undefined;
      if (isAlias(layoutNode)) {
        throw new EditError('E_INVALID_COMMAND', 'Cannot modify layout through YAML alias');
      }
      if (
        typeof layoutNode === 'object' &&
        layoutNode !== null &&
        'anchor' in layoutNode &&
        Boolean(layoutNode.anchor)
      ) {
        throw new EditError('E_INVALID_COMMAND', 'Cannot modify anchored layout');
      }
      if (layoutNode !== undefined && layoutNode !== null) {
        if (!isScalar(layoutNode)) {
          throw new EditError('E_INVALID_COMMAND', 'markmap.layout is not a scalar');
        }
        if (layoutNode.tag !== undefined) {
          throw new EditError('E_INVALID_COMMAND', 'Cannot modify tagged layout');
        }
        if (layoutNode.type === 'BLOCK_LITERAL' || layoutNode.type === 'BLOCK_FOLDED') {
          throw new EditError('E_INVALID_COMMAND', 'Cannot modify block scalar layout');
        }
        const activeLayout = String(layoutNode.value ?? '');
        if (activeLayout === layout) {
          return {
            edits: [],
            selection,
            verify: noopVerify,
          };
        }
        const range = layoutNode.range ?? [0, 0];
        const absFrom = doc.frontmatterRange.start + openLen + range[0];
        const absTo = doc.frontmatterRange.start + openLen + range[1];
        const before = yamlContent.slice(0, range[0]);
        const after = yamlContent.slice(range[1]);
        let insert = layout;
        if (!/\s$/.test(before)) {
          insert = ` ${insert}`;
        }
        if (after.startsWith('#')) {
          insert = `${insert} `;
        }
        return createCandidatePlan(doc, [{ from: absFrom, to: absTo, insert }], selection, layout);
      }

      if (layout === 'two-sided') {
        return {
          edits: [],
          selection,
          verify: noopVerify,
        };
      }

      if (isMap(markmapNode) && markmapNode.items.length > 0) {
        const firstItem = markmapNode.items[0];
        const firstKey = firstItem.key;
        if (isScalar(firstKey) && firstKey.range) {
          if (markmapNode.flow) {
            const absInsert = doc.frontmatterRange.start + openLen + firstKey.range[0];
            const insert = `layout: ${layout}, `;
            return createCandidatePlan(
              doc,
              [{ from: absInsert, to: absInsert, insert }],
              selection,
              layout,
            );
          }
          const keyStart = firstKey.range[0];
          const lastNl = yamlContent.lastIndexOf('\n', keyStart);
          const lineStart = lastNl >= 0 ? lastNl + 1 : 0;
          const linePrefix = yamlContent.slice(lineStart, keyStart);
          const indentMatch = /^[ \t]*/.exec(linePrefix);
          const indent = indentMatch && indentMatch[0].length > 0 ? indentMatch[0] : '  ';
          const insert = `${indent}layout: ${layout}${newline}`;
          const absInsert = doc.frontmatterRange.start + openLen + lineStart;
          return createCandidatePlan(
            doc,
            [{ from: absInsert, to: absInsert, insert }],
            selection,
            layout,
          );
        }
      }

      const pair =
        yamlDoc.contents && isMap(yamlDoc.contents)
          ? yamlDoc.contents.items.find(
              (it) => it.key && isScalar(it.key) && it.key.value === 'markmap',
            )
          : undefined;
      const keyNode = pair?.key;
      if (isScalar(keyNode) && keyNode.range) {
        const valNode = pair?.value;
        if (
          valNode &&
          'range' in valNode &&
          Array.isArray(valNode.range) &&
          valNode.range[1] > valNode.range[0]
        ) {
          const colonIdx = yamlContent.indexOf(':', keyNode.range[1]);
          const startIdx = colonIdx >= 0 ? colonIdx + 1 : valNode.range[0];
          const absFrom = doc.frontmatterRange.start + openLen + startIdx;
          const absTo = doc.frontmatterRange.start + openLen + valNode.range[1];
          const insert = `${newline}  layout: ${layout}`;
          return createCandidatePlan(
            doc,
            [{ from: absFrom, to: absTo, insert }],
            selection,
            layout,
          );
        }
        const nextNl = yamlContent.indexOf('\n', keyNode.range[1]);
        if (nextNl >= 0) {
          const absInsert = doc.frontmatterRange.start + openLen + nextNl + 1;
          const insert = `  layout: ${layout}${newline}`;
          return createCandidatePlan(
            doc,
            [{ from: absInsert, to: absInsert, insert }],
            selection,
            layout,
          );
        }
        const absInsert = doc.frontmatterRange.start + openLen + yamlContent.length;
        const insert = `${newline}  layout: ${layout}`;
        return createCandidatePlan(
          doc,
          [{ from: absInsert, to: absInsert, insert }],
          selection,
          layout,
        );
      }
    }

    if (layout === 'two-sided') {
      return {
        edits: [],
        selection,
        verify: noopVerify,
      };
    }

    if (yamlDoc.contents && isMap(yamlDoc.contents) && yamlDoc.contents.flow) {
      if (yamlDoc.contents.items.length > 0) {
        const firstKey = yamlDoc.contents.items[0]?.key;
        if (isScalar(firstKey) && firstKey.range) {
          const absInsert = doc.frontmatterRange.start + openLen + firstKey.range[0];
          const insert = `markmap: {layout: ${layout}}, `;
          return createCandidatePlan(
            doc,
            [{ from: absInsert, to: absInsert, insert }],
            selection,
            layout,
          );
        }
      } else if (yamlDoc.contents.range) {
        const absInsert = doc.frontmatterRange.start + openLen + yamlDoc.contents.range[0] + 1;
        const insert = `markmap: {layout: ${layout}}`;
        return createCandidatePlan(
          doc,
          [{ from: absInsert, to: absInsert, insert }],
          selection,
          layout,
        );
      }
    }

    const closeIndex = raw.lastIndexOf('---');
    const beforeClose = raw.slice(0, closeIndex);
    const insertPoint = doc.frontmatterRange.start + closeIndex;
    const prefix = beforeClose.endsWith('\n') ? '' : newline;
    const insert = `${prefix}markmap:${newline}  layout: ${layout}${newline}`;
    return createCandidatePlan(
      doc,
      [{ from: insertPoint, to: insertPoint, insert }],
      selection,
      layout,
    );
  }

  if (layout === 'two-sided') {
    return {
      edits: [],
      selection,
      verify: noopVerify,
    };
  }

  const newline = doc.source.includes('\r\n') ? '\r\n' : '\n';
  const start = doc.source.startsWith('\uFEFF') ? 1 : 0;
  const rest = doc.source.slice(start);
  let insert: string;
  if (rest.length === 0) {
    insert = `---${newline}markmap:${newline}  layout: ${layout}${newline}---${newline}`;
  } else if (rest.startsWith('\r\n') || rest.startsWith('\n')) {
    insert = `---${newline}markmap:${newline}  layout: ${layout}${newline}---${newline}`;
  } else {
    insert = `---${newline}markmap:${newline}  layout: ${layout}${newline}---${newline}${newline}`;
  }
  return createCandidatePlan(doc, [{ from: start, to: start, insert }], selection, layout);
}
