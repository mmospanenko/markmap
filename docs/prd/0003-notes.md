# [PRD-3] Notes editing

## Context

Markmap renders a block that is not a heading or list item as a note on the node that owns it. The dot and the popover belong to `@markmap/view`. A note made of ordinary Markdown has two problems for editing:

- A paragraph is a note, but a list, heading or table inside it changes the map structure, so a note cannot always hold arbitrary Markdown.
- The editor needs a stable source range for the whole note, so replacing and removing it stays byte-preserving.

This layer adds one fenced block with the `markmap-note` info string. The content is parsed in isolation, so its headings, lists, tables and code never become map nodes. Paragraph notes keep working as legacy notes.

## Requirements

- [REQ-3-1] When Markdown contains a fence with the `markmap-note` info string under a heading, under a list item or before the first heading, the parser shall parse the fence content with the same remark pipeline, attach every top-level block as a note of the owning node, never turn a block inside the fence into a child node, and record the whole fence range and `fence: true` on each attached note. A legacy paragraph note shall record its own source range and `fence: false`, and promotion of a single top-level heading shall keep both fields.
- [REQ-3-2] The model shall expose `notes` on every node as source ranges with a fence flag, deduplicated by range and clamped to the source, and `capabilities.editNotes` shall be true for a root with a title, a heading or a list item with a block, and false for an opaque node or a node with no label and no block. It shall expose one normalized `noteText` per note, including fence de-indentation, and `notesText` shall compose it.
- [REQ-3-3] When the user sets notes, the command shall normalize line endings, trim trailing whitespace and newlines, remove every note range and one separating blank line, remove an empty text without touching children or markers, and otherwise write exactly one fence with the info string `markmap-note`, using a backtick run longer than any run in the text and the node content indent for a list item.
- [REQ-3-4] The command shall insert the fence directly below a label line, or before the first child of a title root, or at the end of the source for a childless title root, without touching frontmatter; unchanged text shall produce no splices; the result shall keep the children and their order and hold exactly one fence note; an opaque node or a node with an empty label and no block shall throw `EditError`. Verification shall find a promoted source root by mapping its old block start through the command splices, so replacing or removing an intro note keeps the root, its children and source bytes correct.
- [REQ-3-5] Copy, cut and paste shall carry the fence as part of the node block, and paste shall reindent the fence for a list item.
- [REQ-3-6] The editor shall expose `editNotes(nodeId?)` and `isEditingNotes`, commit an open label edit first, reject an opaque node or an empty label through `onError`, and open a floating notes panel with the existing fence content, the legacy slices joined by a blank line, or an empty value.
- [REQ-3-7] The notes panel shall be a `div.mm-editor-notes` with `role="dialog"`, `aria-label="Notes"`, a toolbar and a `textarea.mm-editor-notes-field`; it shall not scale with zoom, shall sit below the node when it fits and otherwise above, shall stay inside the container, and shall reposition on render and zoom. The panel shall carry a compact header with a pencil icon, the title `Notes` and a muted `Markdown` label.
- [REQ-3-8] The toolbar shall format the selection with bold, italic, inline code, link, quote and code block markers, keep the focus in the field, and use an empty selection by placing the caret between the markers. Each toolbar button shall keep its accessible name and add a matching `title` and a 16x16 outline SVG icon.
- [REQ-3-9] Escape shall close without a source change, Cmd/Ctrl+Enter shall commit and close, Enter shall insert a newline, Cmd/Ctrl+B and Cmd/Ctrl+I shall format, a click outside the panel shall commit and close, and clicks inside shall not select a node.
- [REQ-3-10] A snapshot during notes editing shall apply `setNotes` when the text changed, record one history entry, update the original text, keep the panel open and focused and return the source; a second snapshot without a change shall not add an entry. Destroy shall remove the panel, its listeners and its state.
- [REQ-3-11] The notes panel shall draw its surface, text, field, border, hover, focus and hint from the host theme tokens `--oc-elevated`, `--oc-fg`, `--oc-bg`, `--oc-border`, `--oc-hover`, `--oc-focus`, `--oc-radius` and `--oc-muted`, with theme-aware fallbacks, so it stays readable in light and dark modes.

## Acceptance tests

| Requirement | Tests                   |
| ----------- | ----------------------- |
| REQ-3-1     | TC-3-1-1 ... TC-3-1-6   |
| REQ-3-2     | TC-3-2-1 ... TC-3-2-6   |
| REQ-3-3     | TC-3-3-1 ... TC-3-3-5   |
| REQ-3-4     | TC-3-4-1 ... TC-3-4-10  |
| REQ-3-5     | TC-3-5-1 ... TC-3-5-4   |
| REQ-3-6     | TC-3-6-1 ... TC-3-6-8   |
| REQ-3-7     | TC-3-7-1 ... TC-3-7-5   |
| REQ-3-8     | TC-3-8-1 ... TC-3-8-8   |
| REQ-3-9     | TC-3-9-1 ... TC-3-9-8   |
| REQ-3-10    | TC-3-10-1 ... TC-3-10-5 |
| REQ-3-11    | TC-3-11-1               |

## Decisions

- A fence is the note container, not a note block. The parser unwraps it, so the view draws the same dot and popover as for a paragraph.
- The fence stays a plain Markdown code block. Any editor or renderer without this layer shows the note text as code.
- Link formatting inserts `[text](url)` and selects the `url` placeholder, so typing replaces it.
- The panel is outside the SVG and is not scaled: a note is prose, not a label.
- Legacy paragraph notes stay readable. The editor joins them with a blank line and the first save writes one fence.

## Out of scope

- Rich text, WYSIWYG marks, and a note toolbar inside the view popover.
- Multiple fences for one node. The command writes one.
- Notes on an opaque node or on an empty root without a title.
