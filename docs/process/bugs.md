# Bugs

A bug starts with a failing regression test, not with a patch.

## Steps

1. Reproduce the bug in a test named `[TC-N-M-K]`. If the behavior has no requirement, add one to the PRD first.
2. Run the test and confirm it fails for the reported reason, not for a setup error.
3. Fix the smallest cause. Do not change unrelated commands or formatting.
4. Run `pnpm verify`.
5. Keep the regression test. It is the record of the bug.

## Common causes

- A range points at the wrong line or the wrong side of a newline.
- A heading section ends at the heading line instead of the next heading with an equal or lower level.
- A list item has nested children and the insert point is inside the subtree.
- A rename changes node ids, so selection or fold is lost.
- An empty nested list item does not parse; the editor must use the placeholder.
- The view re-rendered and the editor's class or overlay position is stale.

## Debugging

- `applySplices` reports overlapping edits; check the splice ranges before the parse.
- `EditError` carries a code. `E_SHAPE` means the edit parsed into an unexpected tree.
- `nodeAtOffset` returns the deepest node; use it to inspect a selection offset.
- The trace script catches a renamed test id or a requirement with no test.
