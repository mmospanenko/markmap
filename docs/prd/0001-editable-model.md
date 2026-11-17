# [PRD-1] Editable Markmap model

## Context

Markmap renders Markdown as a mind map. Upstream treats Markdown as the only source of truth and does not edit nodes. This fork adds an editable projection without rewriting untouched Markdown.

The projection is a validated snapshot of the tree over the original text. Commands change only the affected source ranges. The Markmap renderer keeps working with the same tree and never sees a custom document format.

## Requirements

- [REQ-1-1] When Markdown is parsed, each tree node shall expose its label and block character ranges, and a heading block shall cover the whole section.
- [REQ-1-2] When a document is built, the model shall expose node kind, level, list info, parent, children and capabilities, shall return the render tree, and the validator shall report structural issues.
- [REQ-1-3] When a node is renamed or a sibling or child is inserted, the command shall change only the affected source ranges, return a selection offset and reject a label that breaks the tree shape. A new branch shall use a heading marker only at level one or two: a child of an H1 root or H1 heading shall be H2, a child of an H2 or deeper heading shall be a list item at the direct list indent and marker of that heading or `- ` at indent zero when it has none, a sibling of an H1 or H2 heading shall be a heading at the same level, and a sibling of an H3-H6 heading shall be a list item under the same parent heading. The command shall verify the created kind, level and parent edge. Existing H3-H6 headings shall stay readable and editable in place and shall never be migrated or rewritten.
- [REQ-1-4] When a node is deleted, its whole block, including descendants and notes, shall be removed.
- [REQ-1-5] When a node is outdented, the node and its descendants shall move after the parent block with the parent level or indent.
- [REQ-1-6] When a task checkbox is toggled, only the checkbox marker shall change.
- [REQ-1-7] Commands shall preserve the document line ending style.
- [REQ-1-8] Commands shall handle end of file, frontmatter, ordered lists, multi-line labels and invalid labels, and a failed command shall leave the input document unchanged.
- [REQ-1-9] A command shall not change bytes outside its edit ranges.
- [REQ-1-10] The splice engine shall apply non-overlapping edits and map source offsets through them.
- [REQ-1-11] Formatting helpers shall insert, indent, dedent and place blocks at line boundaries.
- [REQ-1-12] When a Markdown block is pasted under a node, the command shall insert the whole block after the node's block, renumber heading levels or reindent list items to the child depth, keep notes and descendants, return the label selection of the pasted root, and reject a level beyond six without changing the input. When the target is a list item, a heading subtree shall become a list subtree with the same nodes, notes, continuation lines, and markers. Leading root-owned blocks of a promoted fragment shall become notes of the pasted root, not of the target, and the selection shall come from the inserted heading label. Any prefix content left after removing those supported note ranges shall reject the paste with a clear notice and leave the document unchanged.
- [REQ-1-13] When a node is moved to a parent at an index, the command shall keep the whole block with its notes, markers and continuation lines, change heading levels and list indents for the destination, return the moved label selection, accept the root as a parent, and reject the root, an opaque node, a cycle, an impossible heading level or an out-of-range index without changing the input. The index shall be the final position after the node is removed, and a move to its current position shall change no bytes.
- [REQ-1-14] When the source begins with a UTF-8 BOM, the parser shall normalize every mdast offset by one at the parse boundary before transformer plugins run, so source, label, block, note and position ranges index the raw string and a copied position is shifted exactly once. A heading whose label is empty shall accept a rename through one splice that inserts the separator space before the label, including an ATX heading that ends with CRLF, without changing its source ranges. Root creation after a BOM-only source shall select the created label at the insertion start.
- [REQ-1-15] When a document is built, the model shall expose one root policy computed from the parse result that names a source-heading root first, then a frontmatter-title root, then a synthetic root, reports title presence, body start and whether a direct heading child exists, and allows root-heading creation for a synthetic root with no direct top-level H1 child and for a title root with no direct heading child. A root-heading command shall insert one level-one heading at the first non-blank body line, preserve leading blank lines, separate following content with one blank line, keep every byte outside one splice and the file line ending, make the old top-level nodes its children, prove node count, order and parent edges through its own mapped offsets, and refuse a source root or an ineligible title or synthetic root without changing the document. A whitespace-only source shall keep every original byte and the file EOL with the heading appended, a truly empty source shall produce only the heading, and a BOM shall stay before the heading. A Setext source root shall stay label-editable and structurally opaque. Existing H3-H6 headings shall stay read and edited in place; a new branch under an H2-H6 root shall fall back to a list item under the REQ-1-3 cap.
- [REQ-1-16] When a document is built, the model shall expose a content node count that excludes a synthetic or title root. Every structural command verification shall compare content counts: root creation and child or sibling insertion add one, paste adds the fragment content count, deletion subtracts the removed subtree, and label, notes, checkbox, outdent and move keep it unchanged.
- [REQ-1-17] When a document has exactly one top-level heading at any level from one to six, the parser shall promote it to the root even when a non-empty frontmatter title exists, preserve its real depth, source label and block ranges, children and notes, keep Setext underline syntax, and ignore heading-like lines inside code and `markmap-note` fences. The title shall stay byte-for-byte in the frontmatter and shall supply the root label only when no promotion happens. The parse result shall expose title presence and the body start offset, which shall be the source length for an empty body. A promoted H3-H6 root shall keep its level and shall stay edited in place; a new child under an H2-H6 root shall be a list item under the REQ-1-3 cap.
- [REQ-1-18] When a batch delete command names several sibling nodes, it shall remove each selected node's whole block with its descendants and notes, treat the set as one atomic command, keep every byte outside the removed blocks and the file line ending, and return the selection of the nearest previous unselected sibling before the first removed node, the parent when it has a source label or block, otherwise the next surviving sibling or the document end. It shall reject an empty set, the root, a mixed-parent set, an opaque node or a node without a block without changing the input, and it shall verify that the content node count falls by every removed subtree.
- [REQ-1-19] When a batch move command names several sibling nodes, a destination parent and an index, it shall move the selected blocks with their descendants, notes, markers and continuation lines as one contiguous block in their current order, change only the affected source ranges and the necessary heading levels and list indents for the destination, return the label selection of the first moved node, and reject an empty set, the root, a mixed-parent set, an opaque selected node or target, a cycle, an impossible heading level or an out-of-range index without changing the input. The index shall be the final position after every selected node is removed, the relative order and subtree content shall survive, and moving the set to its current position shall change no bytes.

## Acceptance tests

Tests carry `[TC-1-N-K]` names where `N` is the requirement number and `K` the case number. `scripts/check-trace.mjs` verifies coverage in both directions.

| Requirement | Tests                    |
| ----------- | ------------------------ |
| REQ-1-1     | TC-1-1-1 ... TC-1-1-4    |
| REQ-1-2     | TC-1-2-1 ... TC-1-2-23   |
| REQ-1-3     | TC-1-3-1 ... TC-1-3-27   |
| REQ-1-4     | TC-1-4-1                 |
| REQ-1-5     | TC-1-5-1 ... TC-1-5-4    |
| REQ-1-6     | TC-1-6-1                 |
| REQ-1-7     | TC-1-7-1                 |
| REQ-1-8     | TC-1-8-1 ... TC-1-8-25   |
| REQ-1-9     | TC-1-9-1                 |
| REQ-1-10    | TC-1-10-1 ... TC-1-10-5  |
| REQ-1-11    | TC-1-11-1 ... TC-1-11-7  |
| REQ-1-12    | TC-1-12-1 ... TC-1-12-25 |
| REQ-1-13    | TC-1-13-1 ... TC-1-13-19 |
| REQ-1-14    | TC-1-14-1 ... TC-1-14-11 |
| REQ-1-15    | TC-1-15-1 ... TC-1-15-20 |
| REQ-1-16    | TC-1-16-1 ... TC-1-16-4  |
| REQ-1-17    | TC-1-17-1 ... TC-1-17-8  |
| REQ-1-18    | TC-1-18-1 ... TC-1-18-6  |
| REQ-1-19    | TC-1-19-1 ... TC-1-19-13 |

## Out of scope

- Clipboard detection and transfer format; the app owns them.
- Saving fold state to Markdown.
- Publishing the fork to npm.

The DOM layer is specified in [PRD-2](0002-dom-editor.md). Notes editing is specified in [PRD-3](0003-notes.md).
