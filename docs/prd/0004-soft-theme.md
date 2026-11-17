# [PRD-4] Soft tree theme

## Context

The default map is a flat text tree: every level uses the same font and weight, and branch colors can change at every node. This theme gives the root, first-level topics and deeper labels three distinct visual levels without changing the Markdown document or the layout algorithms.

The theme lives in `@markmap/render`. The editor uses its resolved label metrics so an open label looks like the label it replaces.

## Requirements

- [REQ-4-1] When a map renders with the soft theme, the root shall use a dark filled rounded block with larger white semibold text, each first-level node shall use a pale branch-tinted rounded block with medium text, and deeper nodes shall use smaller unboxed neutral text with a branch-colored underline.
- [REQ-4-2] Each first-level branch shall get one muted color by default, shared by its descendants. The default palette shall use distinct, balanced hues in light and dark, keep brown as one accent rather than the dominant color, and stay legible on its background. `color` and `colorDepth` shall still change branch colors.
- [REQ-4-3] Root-to-first-level edges shall be smooth curves that taper within the edge, while deeper edges shall stay thin and use a long flat start and arrival.
- [REQ-4-4] The theme shall provide light and dark tokens for text, backgrounds, tints, toggles and branch colors.
- [REQ-4-5] When the editor opens a label, the overlay field shall use the selected node's resolved font family, size, weight, line height, text fill, padding and alignment. The field shall stay aligned at every zoom level and while the label grows. An empty topic label shall center the field on the visible topic block and draw the selection frame around that block, with the theme padding unchanged.

## Acceptance tests

| Requirement | Tests                 |
| ----------- | --------------------- |
| REQ-4-1     | TC-4-1-1, TC-4-1-2    |
| REQ-4-2     | TC-4-2-1 ... TC-4-2-3 |
| REQ-4-3     | TC-4-3-1              |
| REQ-4-4     | TC-4-4-1              |
| REQ-4-5     | TC-4-5-1 ... TC-4-5-3 |

## Decisions

- `Theme.label` is optional and resolves font, fill and padding before text measurement. The resolved style is kept on each measured node so drawing and the editor overlay use the same values.
- The overlay field keeps a 40 px minimum width. An empty topic field is centered on its block, and the selection frame follows the visible block rather than the field box.
- Branch colors follow the first-level sibling order by default, which keeps neighboring branches distinct. The default palette spreads six muted hues across the color circle; brown stays one accent at the fourth branch rather than the first colors. `colorDepth` values other than `2` keep the existing hash-based behavior.
- The root and first-level blocks use a tinted overlay instead of CSS `color-mix`, so the same tokens work in the SVG and canvas backends.
- Child edges use cubic control points at 0.75 of the gap, which gives a flat start and arrival and keeps the fan readable when child subtrees differ in height.
- The published view and toolbar stay unchanged. The fork vendors the render package that carries the theme and the label hook.

## Out of scope

- New layouts, node shapes beyond the root and first-level blocks, per-node styling controls, theme selection UI, and style values stored in Markdown.
