# [PRD-2] Keyboard editor over a Markmap view

## Context

The core model and commands edit Markdown without touching the renderer. This layer binds them to a live `@markmap/view` map: selection, keyboard, an overlay text field, undo and fold preservation.

Markmap v1 draws text primitives, not editable DOM. The editor therefore keeps the field outside the SVG and positions it over the selected node.

## Requirements

- [REQ-2-1] When the editor starts and when the user clicks a node, the editor shall select it, highlight its SVG group and keep the root selected by default. A click on empty map space shall clear the selection, the highlight and the frame, and blur the editor surface; a later node click shall select again and focus the editor surface.
- [REQ-2-2] When the user presses Enter or Tab on a selected node, the editor shall insert a sibling or child with a placeholder label, select it and start editing. The created branch shall follow the REQ-1-3 heading cap: an H1 root or heading creates H2, an H2 or deeper heading creates a list item under itself for a child or under its parent heading for a sibling, and the selected node shall be the created branch with its real kind.
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
- [REQ-2-14] When the document is empty, the editor shall open an editable first node and keep the source unchanged until its label is committed, hide the empty selection frame. A title root without heading children shall create one body H1 through the root field; a title root with headings shall report the refusal notice from REQ-2-23.
- [REQ-2-15] When the label grows while editing, the editor shall keep the node's text anchor fixed: a start-aligned node grows to the right, an end-aligned node grows to the left, and a centered node grows symmetrically.
- [REQ-2-16] While the field is open, the editor shall draw the in-progress label in the view without changing the document, so the node's width and its children follow the text. Cancelling shall restore the original layout; committing shall record one change.
- [REQ-2-17] In selection mode, a printable key shall not start editing on a non-empty node; on an empty selected node, the first printable key shall open the field and be inserted. F2 shall not be bound, Space or a double click shall open the field, Escape shall keep the selection, and arrows shall navigate without folding. Enter while editing shall commit and return to selection without inserting a node; a following Enter in selection mode shall insert a sibling and open its field. The container shall expose `mm-editor-mode-select` and `mm-editor-mode-edit`.
- [REQ-2-18] When the host requests a snapshot during editing, the editor shall include the current label and keep the field, focus and edit mode active so the user can continue typing after autosave.
- [REQ-2-19] When the host asks the editor to insert a block, insert a label or delete the selection, the editor shall run the matching command, record one history entry, expose the new selection, and reject an unsupported operation without changing the document. It shall also return the selected node's Markdown block; for a root without a block, it shall return the frontmatter title as a level-one heading followed by every child block, without frontmatter. For a source-heading root it shall include root-owned notes that end before the block start and then the block, without frontmatter or child notes; title-root and ordinary-heading blocks shall stay unchanged.
- [REQ-2-20] When a pointer presses a node and moves four pixels, the editor shall lift the node and its subtree into a ghost that follows the pointer, dim the original subtree, and keep the map layout until the drop. The top quarter of a target shall insert before it, the bottom quarter after it, and the middle shall make the branch the last child; a gap between branches shall target that gap. One indicator shall show at a time: a two-pixel accent line for order and a rounded accent frame for a child drop. The node itself, its descendants, the root, an opaque node and an unsupported target shall show no indicator, and the release shall snap back. A folded target shall expand after four hundred milliseconds, and a cancelled drag shall restore the fold. Within sixty pixels of the stage edge the map shall pan automatically. Escape, a pointer cancel or a release over empty space shall cancel. After a drop the moved node shall stay selected and in view. A move shall be one history entry, and undo shall restore the exact bytes and the fold state. A read-only map shall have no drag. Touch pointers shall stay with the view gestures.
- [REQ-2-21] When the user presses Cmd or Ctrl+Shift+Up or Down, the editor shall move the selected node among its siblings; Left shall make it the last child of the previous sibling; Right shall move it after its parent. The pointer path's command, notices, history and level changes shall apply. A boundary move shall change nothing, an impossible move shall show a notice and leave the document unchanged, and a read-only map shall have no move keys.
- [REQ-2-22] When the host requests a snapshot while a label field is open, the editor shall return the current saveable draft without changing the committed document, history, redo stack or notification state; a label snapshot shall be a pure read. A notes snapshot shall still commit the notes and record history as before. A completed edit shall apply once and add at most one undo entry; an unchanged session or a command whose resulting source equals the input shall add none, emit no committed change and keep redo; a failed draft shall never be published; snapshot shall return the last reported draft source for invalid text and shall never return an unpublished stale draft. Focus, caret, preview and notes behavior shall stay unchanged.
- [REQ-2-23] When a synthetic root or a title root without heading children is eligible for creation, Space, a printable key and Enter shall open its label field; the label shall become a level-one heading in one history entry, snapshots shall include the draft while the field stays open, Escape and undo shall follow the session rules, the root selection frame shall stay visible for a non-empty synthetic root and hidden only for a truly empty document, and a title root with headings or a top-level H1 refusal shall report a notice without a source change. A title root with a single body heading is a source-heading root and edits in place without a notice. Root creation shall always insert H1 and shall never rewrite an existing H3-H6 heading. The root shall stay non-deletable.
- [REQ-2-24] When a label draft changes, the editor shall report the current saveable source through `onDraftChange` after a successful preview, when a preview returns to the session baseline, and when editing is cancelled. It shall emit only when the saveable source actually changes: an unchanged cancel and a commit of an already-emitted draft shall add no duplicate draft event. `onChange` shall stay the committed-document channel; a host save acknowledgment of an older draft shall not clear a newer draft; Escape and undo shall keep the committed baseline resavable; and typing shall notify the host before the first snapshot.
- [REQ-2-25] When an open label session loses its screen rect, the editor shall finish like Escape: restore the committed baseline and report that baseline once through `onDraftChange` when a different draft was emitted. It shall stay silent when nothing was emitted, on a file switch and on destroy, and a snapshot after the loss shall return the committed source.
- [REQ-2-26] When the user types in an open label, the editor shall publish each saveable draft through `onDraftChange` immediately and apply at most one preview render per animation frame with the latest valid draft. A pending preview shall be flushed or cancelled before commit, cancel, source replacement or destroy and shall never overwrite the committed document; snapshots, focus and undo shall keep the latest text.
- [REQ-2-27] When a label commit follows a valid preview for the same field text and document base, the editor shall reuse that preview result without re-planning the command and shall skip a view tree render whose source the view already draws. A draft invalidated by another command shall be recomputed against the current document, shall clear its preview flag and re-anchor the field to the committed node before the committed tree is drawn, and a pending preview frame shall not draw it; cancel and source replacement shall leave the committed source and its rendered tree intact; destroy shall cancel pending work and leave the committed source intact without drawing a draft, and the host then destroys the view; undo and redo shall restore exact sources; and the Tab commit shall reuse the draft and record one history entry. Label snapshots shall stay pure and return the current saveable source, and `onDraftChange` shall stay synchronous.

## Acceptance tests

| Requirement | Tests                                             |
| ----------- | ------------------------------------------------- |
| REQ-2-1     | TC-2-1-1 ... TC-2-1-4                             |
| REQ-2-2     | TC-2-2-1 ... TC-2-2-9                             |
| REQ-2-3     | TC-2-3-1 ... TC-2-3-3                             |
| REQ-2-4     | TC-2-4-1 ... TC-2-4-8                             |
| REQ-2-5     | TC-2-5-1, TC-2-5-2                                |
| REQ-2-6     | TC-2-6-1 ... TC-2-6-3                             |
| REQ-2-7     | TC-2-7-1                                          |
| REQ-2-8     | TC-2-8-1                                          |
| REQ-2-9     | TC-2-9-1                                          |
| REQ-2-10    | TC-2-10-1 ... TC-2-10-3                           |
| REQ-2-11    | TC-2-11-1                                         |
| REQ-2-12    | TC-2-12-1, TC-2-12-2                              |
| REQ-2-13    | TC-2-13-1 ... TC-2-13-22                          |
| REQ-2-14    | TC-2-14-1 ... TC-2-14-7                           |
| REQ-2-15    | TC-2-15-1 ... TC-2-15-3                           |
| REQ-2-16    | TC-2-16-1 ... TC-2-16-6                           |
| REQ-2-17    | TC-2-17-1 ... TC-2-17-8                           |
| REQ-2-18    | TC-2-18-1, TC-2-18-2                              |
| REQ-2-19    | TC-2-19-1 ... TC-2-19-10                          |
| REQ-2-20    | TC-2-20-1 ... TC-2-20-8                           |
| REQ-2-21    | TC-2-21-1 ... TC-2-21-5                           |
| REQ-2-22    | TC-2-22-1 ... TC-2-22-9                           |
| REQ-2-23    | TC-2-23-1 ... TC-2-23-10                          |
| REQ-2-24    | TC-2-24-1 ... TC-2-24-3, TC-2-24-5 ... TC-2-24-11 |
| REQ-2-25    | TC-2-25-1 ... TC-2-25-3                           |
| REQ-2-26    | TC-2-26-1, TC-2-26-2                              |
| REQ-2-27    | TC-2-27-1 ... TC-2-27-6                           |

## Decisions

- New nodes use a visible placeholder, `New topic` by default, and the field selects it. Markmap drops an empty nested list item, so an empty label is not a valid insert target.
- The editor owns undo history for document commands. Typing inside the field keeps native undo until the label is committed.
- Enter while editing commits the label and returns to selection. The next Enter in selection mode inserts a sibling and opens its field. Tab commits and inserts a child.
- Shift+Enter is allowed only for list labels. A heading label stays on one line.
- Block insertion is a model command. Clipboard detection, the transfer format, and the paste notice stay in the app.
- The drag ghost clones the moved node and its subtree, including internal edges, and leaves the original in place, dimmed.
- The root and a title root are targets only through an insertion line between their children, never through a child frame.
- A heading child gets one blank line before it when the destination has headings. A list child stays compact.
- A list item converted to a heading loses a GFM task checkbox because a heading is not a task; its label text stays.
- Touch pointers stay with the view gestures. The drag layer handles a mouse or pen pointer.
- A label draft reaches the host through `onDraftChange` while typing. `snapshot()` reads the saveable source without emitting or changing history for label drafts; a notes snapshot still commits the notes.
- The root field creates a level-one heading above the existing body for a synthetic root without a top-level H1 and for a title root without heading children. A title root with headings refuses with a merge-under-one-H1 notice. A body H1 wins over the title and becomes the root.
- A created root heading sits on the first non-blank body line, keeps the blank lines before it, separates the following content with one blank line, and leaves an empty body without a trailing blank line while preserving whitespace-only bytes.
- A source-root block copy includes root-owned notes before the heading and excludes frontmatter.
- A lost screen rect ends a label session like Escape; file switch and destroy stay silent.

## Label session state

An open label session owns six values:

- `doc`: the committed document. Only a committed command changes it.
- `draft`: the latest valid preview `EditResult`. It never changes `doc`, history or redo.
- `draftText`: the exact field text that produced `draft`.
- `draftBase`: the committed source that produced `draft`. The draft is current only while `draftText` matches the field and `draftBase` matches `doc`.
- `emitted`: the saveable draft source last reported through `onDraftChange`, or `null` after the baseline is reported.
- `preview`: whether the view draws the draft instead of the committed document. Another command that draws the committed tree clears it and anchors the field to the committed node.

Transitions:

- A successful preview whose saveable source differs calls `onDraftChange`; an identical preview and a repeated identical input publish nothing.
- Returning to the baseline, cancelling or losing the rect reports the committed source through `onDraftChange` only when a different draft was emitted. A lost rect behaves exactly like cancel.
- Committing changed text applies once and calls `onChange`. It adds no baseline draft event. A current draft reuses its preview result; a stale draft is recomputed against the current document, and the commit redraws only a source the view does not already show.
- `setSource` and history restores end the label session without a draft event; history restores still emit `onChange`. `destroy` is silent and does not restore the preview; the host discards the view.
- A label `snapshot()` is a pure read and never emits or changes history. It returns the current draft source, recomputes a stale draft without publishing it, returns the last reported draft source for invalid text on the same base, and falls back to the committed source when the base is stale. A notes `snapshot()` still commits the notes and records history as before.
- Label previews are scheduled once per animation frame. `onDraftChange`, snapshots and commit read the latest synchronous draft; the frame draws only the latest valid draft for the current document and is cancelled when the session ends.

## Migration

- `commitForSnapshot` is renamed to `snapshot`.
- The `insertFirst` command is replaced by `createRootHeading`.
- `buildFromTree` requires a `DocumentMeta` argument.
- Consumers must wire `onChange` for committed documents and `onDraftChange` for label drafts.

## Out of scope

- Touch drag, multi-select, clipboard detection, and a WYSIWYG inline editor.
- A topic created by dropping on empty space, free coordinates, and saving fold state to Markdown.
