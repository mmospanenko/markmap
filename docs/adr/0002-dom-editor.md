# [ADR-2] A keyboard editor as an overlay over the SVG

- Status: accepted
- Date: 2026-11-14

## Context

The model and commands are headless. The view draws text primitives and exposes `screenRect`, `hitAt`, `layoutPoint`, `setTree`, folds and view events. Markmap has no editable DOM per node.

An editor could render its own HTML nodes or patch the view. Both would duplicate layout and theme work and lose upstream compatibility.

## Decision

Keep the view unchanged. A new `@markmap/edit-dom` package owns selection, keyboard, an overlay text field and history, and talks to the view through a small `EditView` interface.

The editor:

- positions a `<textarea>` over `screenRect(id)` in a layer inside the host container;
- hides the node's text while editing with a class on the SVG group;
- highlights the selection with a class on the group;
- replays selection and editing classes after every render;
- maps the keyboard to `@markmap/edit` commands;
- keeps history as source snapshots and restores folds by id.

## Consequences

- The renderer stays untouched and the editor is testable with a fake view in happy-dom.
- The host gives the container a size and, when needed, the editor sets `position: relative` and restores it on destroy.
- The field styling is approximate: it inherits the host font and uses a small default padding. A host can override the field class.
- Empty nested list items are not parsed by Markmap. The editor inserts a placeholder label instead.
- An outdent moves a node between source ranges, so a fold on the moved node resets. Folds on other nodes survive through the offset map.
- Undo inside the field is native until the label is committed; document undo uses the editor history.

## Alternatives

- **Editing SVG text with `contenteditable`.** Rejected: v1 text is composed of primitives, and browsers do not provide a reliable caret inside `<foreignObject>`.
- **A separate HTML mind map.** Rejected: it duplicates layout, themes, folding and export.
- **Serializing the tree after every keystroke.** Rejected in ADR-1 for the same reasons.
