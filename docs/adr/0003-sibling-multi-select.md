# [ADR-3] Sibling range multi-selection over atomic batch commands

- Status: accepted
- Date: 2026-11-17

## Context

The editor has one selection offset and one selected node. Commands in `@markmap/edit` name one node. Issue #77 asks for a way to delete or reorder several siblings at once without changing Markdown format or breaking undo.

A free-form multi-selection across parents would need a mixed-parent command shape and a fallback selection for each parent. A loop of single-node commands would record several history entries and could leave a half-applied edit after a rejected node.

## Decision

Multi-selection is a sibling range under one parent. The editor keeps an anchor node and an ordered set of siblings that share the anchor's parent.

- A plain click selects one node and makes it the anchor.
- Cmd or Ctrl click toggles a sibling of the anchor and keeps the anchor.
- Shift click selects the inclusive range from the anchor.
- A click under another parent starts a new single-node selection.
- Escape clears the group and keeps the anchor.
- Selection lives only in the editor. It changes no Markdown, emits no change and records no history.
- A read-only map mounts no editor, so it has no multi-selection.

Group operations are two commands in `@markmap/edit`: batch delete and batch move. Each command takes the selected sibling ids, checks one parent and every capability before it plans splices, applies one plan, parses and validates once. A rejected set throws `EditError` and leaves the input snapshot untouched.

- Batch delete removes each selected block with descendants and notes. It selects the nearest previous unselected sibling, or the parent when none remains.
- Batch move treats the selected blocks as one contiguous block in their current order. The index is the final position after every selected node is removed. Heading levels and list indents follow the destination as in a single move.
- The editor records one history entry per group operation. A drag that starts on a selected node moves the group; a drag that starts elsewhere keeps the single-node path.
- The moved block stays selected with its first node as the anchor. History stores the selection of each state, so undo and redo restore the group that belonged to the restored source, including the group removed by a group delete.
- The anchor stays the primary node for block copy, insert, notes, markers and toolbar commands. Group clipboard actions are out of scope.

## Consequences

- A cross-parent selection never exists, so a command never needs a mixed-parent fallback.
- A mixed-parent, root, opaque, cycle or invalid-index set fails atomically before any splice.
- Selection highlights and the primary-node actions reuse the existing node ids and source offsets.
- Undo and redo restore the selection of the restored state, so a moved group stays selectable and a deleted group returns selected.
- The view and renderer stay unchanged; only `@markmap/edit` and `@markmap/edit-dom` gain behavior.

## Alternatives

- **A sequence of single-node commands.** Rejected: several history entries, no atomic failure, and the source moves under the selection between steps.
- **Cross-parent multi-selection.** Rejected: no single destination index and no single fallback selection, and the approved contract is sibling-only.
- **A new multi-selection document format.** Rejected: selection is not document state and must not reach Markdown.
