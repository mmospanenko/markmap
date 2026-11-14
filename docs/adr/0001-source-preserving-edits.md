# [ADR-1] Source-preserving edits over a validated model

- Status: accepted
- Date: 2026-11-14

## Context

Markmap v1 parses Markdown with remark into a tree with character offsets. The renderer draws that tree and does not edit it. Node ids are content hashes, and a full Markdown serializer does not exist upstream.

Two extremes are possible. A tree-only editor with a serializer rewrites the whole file on every save. A text-only editor with regexes cannot guarantee structure. Neither keeps arbitrary Markdown intact.

## Decision

Markdown remains the source of truth. The editable model is an immutable snapshot that adds node kind, level, list metadata, source ranges, capabilities and validation on top of the parsed tree. A command returns a plan of non-overlapping splices. The next snapshot comes from parsing the spliced text, not from serializing the tree.

Every command follows one gate:

```text
capability check
  -> splice plan
  -> apply splices
  -> parse
  -> validate
  -> shape check
  -> commit or error
```

The command fails closed. The caller keeps the previous snapshot if an edit error is raised.

## Consequences

- Untouched bytes, formatting, frontmatter and inline Markdown survive every edit.
- The renderer needs no changes beyond the optional source ranges on the tree.
- A command must reason about Markdown boundaries, and every operation needs fixture coverage.
- Mixed or unsupported structures are marked opaque and stay read-only for structural commands.
- Node identity for selection is a source offset, not a content-hash id.

## Alternatives

- **Full tree-to-Markdown serialization.** Rejected: it normalizes bullets, emphasis and spacing, breaks diffs, and cannot round-trip arbitrary Markdown.
- **Editing the rendered SVG in place.** Rejected for the core: Markmap v1 renders text primitives, not editable DOM. The DOM layer uses an overlay editor outside the SVG.
- **Basing the fork on 0.18.** Rejected: line-based positions, foreignObject rendering and no source offsets. v1 exposes character ranges and a hit-testing API.
- **A canonical JSON document with Markdown import and export.** Rejected for this library: the product must render arbitrary existing Markdown unchanged.
