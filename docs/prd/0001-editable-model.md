# [PRD-1] Editable Markmap model

## Context

Markmap renders Markdown as a mind map. Upstream treats Markdown as the only source of truth and does not edit nodes. This fork adds an editable projection without rewriting untouched Markdown.

The projection is a validated snapshot of the tree over the original text. Commands change only the affected source ranges. The Markmap renderer keeps working with the same tree and never sees a custom document format.

## Requirements

- [REQ-1-1] When Markdown is parsed, each tree node shall expose its label and block character ranges, and a heading block shall cover the whole section.
- [REQ-1-2] When a document is built, the model shall expose node kind, level, list info, parent, children and capabilities, shall return the render tree, and the validator shall report structural issues.
- [REQ-1-3] When a node is renamed or a sibling or child is inserted, the command shall change only the affected source ranges, return a selection offset and reject a label that breaks the tree shape.
- [REQ-1-4] When a node is deleted, its whole block, including descendants and notes, shall be removed.
- [REQ-1-5] When a node is outdented, the node and its descendants shall move after the parent block with the parent level or indent.
- [REQ-1-6] When a task checkbox is toggled, only the checkbox marker shall change.
- [REQ-1-7] Commands shall preserve the document line ending style.
- [REQ-1-8] Commands shall handle end of file, frontmatter, ordered lists, multi-line labels and invalid labels, and a failed command shall leave the input document unchanged.
- [REQ-1-9] A command shall not change bytes outside its edit ranges.
- [REQ-1-10] The splice engine shall apply non-overlapping edits and map source offsets through them.
- [REQ-1-11] Formatting helpers shall insert, indent, dedent and place blocks at line boundaries.
- [REQ-1-12] When a Markdown block is pasted under a node, the command shall insert the whole block after the node's block, renumber heading levels or reindent list items to the child depth, keep notes and descendants, return the label selection of the pasted root, and reject a level beyond six without changing the input. When the target is a list item, a heading subtree shall become a list subtree with the same nodes, notes, continuation lines, and markers.
- [REQ-1-13] When a node is moved to a parent at an index, the command shall keep the whole block with its notes, markers and continuation lines, change heading levels and list indents for the destination, return the moved label selection, accept the root as a parent, and reject the root, an opaque node, a cycle, an impossible heading level or an out-of-range index without changing the input. The index shall be the final position after the node is removed, and a move to its current position shall change no bytes.

## Acceptance tests

Tests carry `[TC-1-N-K]` names where `N` is the requirement number and `K` the case number. `scripts/check-trace.mjs` verifies coverage in both directions.

| Requirement | Tests                    |
| ----------- | ------------------------ |
| REQ-1-1     | TC-1-1-1 ... TC-1-1-4    |
| REQ-1-2     | TC-1-2-1 ... TC-1-2-22   |
| REQ-1-3     | TC-1-3-1 ... TC-1-3-7    |
| REQ-1-4     | TC-1-4-1                 |
| REQ-1-5     | TC-1-5-1 ... TC-1-5-4    |
| REQ-1-6     | TC-1-6-1                 |
| REQ-1-7     | TC-1-7-1                 |
| REQ-1-8     | TC-1-8-1 ... TC-1-8-20   |
| REQ-1-9     | TC-1-9-1                 |
| REQ-1-10    | TC-1-10-1 ... TC-1-10-5  |
| REQ-1-11    | TC-1-11-1 ... TC-1-11-7  |
| REQ-1-12    | TC-1-12-1 ... TC-1-12-14 |
| REQ-1-13    | TC-1-13-1 ... TC-1-13-18 |

## Out of scope

- Clipboard detection and transfer format; the app owns them.
- Multi-select, saving fold state to Markdown.
- Publishing the fork to npm.

The DOM layer is specified in [PRD-2](0002-dom-editor.md). Notes editing is specified in [PRD-3](0003-notes.md).
