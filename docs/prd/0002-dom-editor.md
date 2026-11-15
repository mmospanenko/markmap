# [PRD-2] Keyboard editor over a Markmap view

## Context

The core model and commands edit Markdown without touching the renderer. This layer binds them to a live `@markmap/view` map: selection, keyboard, an overlay text field, undo and fold preservation.

Markmap v1 draws text primitives, not editable DOM. The editor therefore keeps the field outside the SVG and positions it over the selected node.

## Requirements

- [REQ-2-1] When the editor starts and when the user clicks a node, the editor shall select it, highlight its SVG group and keep the root selected by default.
- [REQ-2-2] When the user presses Enter or Tab on a selected node, the editor shall insert a sibling or child with a placeholder label, select it and start editing.
- [REQ-2-3] When editing ends, the editor shall commit with Enter, Tab or a click elsewhere, cancel with Escape, reject line breaks in heading labels and keep the field open when a label is invalid.
- [REQ-2-4] When the user presses Shift+Tab or Delete, the editor shall outdent or remove the selected node through the core commands. When the open field of a newly inserted node is empty, Backspace or Delete shall remove that node and select the node before it.
- [REQ-2-5] When the user presses an arrow key, the editor shall move the selection to a sibling, parent or child, and fold or unfold where the arrow crosses a branch.
- [REQ-2-6] When the user presses Cmd/Ctrl+Z or Cmd/Ctrl+Shift+Z, the editor shall undo or redo a document change together with the selection.
- [REQ-2-7] When the view renders or zooms, the editor shall reposition the field over the edited node.
- [REQ-2-8] When a command succeeds, the editor shall emit the new source and selection; `setSource` shall load external Markdown and reset history.
- [REQ-2-9] When an edit renames or shifts a folded node, the editor shall keep the fold on the new node id.
- [REQ-2-10] When an input event is composing or when the editor is destroyed, the editor shall not edit the document, and destruction shall remove its listeners and DOM.
- [REQ-2-11] The editor shall provide an adapter from a `Markmap` instance to the `EditView` contract.
- [REQ-2-12] The history shall keep the last hundred entries and expose undo and redo state.
- [REQ-2-13] The editor shall handle boundary keys, clicks, source replacement, shared styles and repeated destruction without changing the document.
- [REQ-2-14] When the document is empty, the editor shall open an editable first node and keep the source unchanged until its label is committed, hide the empty selection frame, and report a notice instead of editing a root label that comes from the frontmatter title.
- [REQ-2-15] When the label grows while editing, the editor shall keep the node's text anchor fixed: a start-aligned node grows to the right, an end-aligned node grows to the left, and a centered node grows symmetrically.
- [REQ-2-16] While the field is open, the editor shall draw the in-progress label in the view without changing the document, so the node's width and its children follow the text. Cancelling shall restore the original layout; committing shall record one change.
- [REQ-2-17] In selection mode, a printable key shall not start editing on a non-empty node; on an empty selected node, the first printable key shall open the field and be inserted. F2 shall not be bound, Space or a double click shall open the field, Escape shall keep the selection, and arrows shall navigate without folding. Enter while editing shall commit and return to selection without inserting a node; a following Enter in selection mode shall insert a sibling and open its field. The container shall expose `mm-editor-mode-select` and `mm-editor-mode-edit`.
- [REQ-2-18] When the host requests a snapshot during editing, the editor shall include the current label and keep the field, focus and edit mode active so the user can continue typing after autosave.

## Acceptance tests

| Requirement | Tests                    |
| ----------- | ------------------------ |
| REQ-2-1     | TC-2-1-1, TC-2-1-2       |
| REQ-2-2     | TC-2-2-1 ... TC-2-2-3    |
| REQ-2-3     | TC-2-3-1 ... TC-2-3-3    |
| REQ-2-4     | TC-2-4-1 ... TC-2-4-8    |
| REQ-2-5     | TC-2-5-1, TC-2-5-2       |
| REQ-2-6     | TC-2-6-1 ... TC-2-6-3    |
| REQ-2-7     | TC-2-7-1                 |
| REQ-2-8     | TC-2-8-1                 |
| REQ-2-9     | TC-2-9-1                 |
| REQ-2-10    | TC-2-10-1 ... TC-2-10-3  |
| REQ-2-11    | TC-2-11-1                |
| REQ-2-12    | TC-2-12-1, TC-2-12-2     |
| REQ-2-13    | TC-2-13-1 ... TC-2-13-22 |
| REQ-2-14    | TC-2-14-1 ... TC-2-14-7  |
| REQ-2-15    | TC-2-15-1 ... TC-2-15-3  |
| REQ-2-16    | TC-2-16-1 ... TC-2-16-6  |
| REQ-2-17    | TC-2-17-1 ... TC-2-17-8  |
| REQ-2-18    | TC-2-18-1, TC-2-18-2     |

## Decisions

- New nodes use a visible placeholder, `New topic` by default, and the field selects it. Markmap drops an empty nested list item, so an empty label is not a valid insert target.
- The editor owns undo history for document commands. Typing inside the field keeps native undo until the label is committed.
- Enter while editing commits the label and inserts the next sibling, matching XMind fast entry. Tab does the same with a child.
- Shift+Enter is allowed only for list labels. A heading label stays on one line.

## Out of scope

- Drag and drop, multi-select, clipboard, and a WYSIWYG inline editor.
- Saving fold state to Markdown.
