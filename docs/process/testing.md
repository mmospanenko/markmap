# Testing

## Levels

| Level       | Where                             | What it proves                                       |
| ----------- | --------------------------------- | ---------------------------------------------------- |
| Unit        | `packages/*/src/**/*.test.ts`     | Pure model, validation, formatting and commands      |
| DOM         | `packages/edit-dom/src/*.test.ts` | Keyboard, selection, overlay and history             |
| Integration | same files                        | Commands against parsed Markdown and the render tree |
| Manual      | `/editor.html` in the playground  | Real browser layout, zoom, pan and IME               |

## Traceability

Every behavior test has a `[TC-N-M-K]` name. `N-M` is the requirement number in `docs/prd`, `K` is the case. `scripts/check-trace.mjs` fails when a requirement has no test, a test points to no requirement, or an id repeats.

## Coverage

Coverage is collected for the packages this fork adds:

- `packages/model/src`
- `packages/edit/src`
- `packages/edit-dom/src`
- `packages/parse/src/to-tree.ts`

The thresholds in `vitest.config.ts` are part of the gate:

| Metric     | Threshold |
| ---------- | --------- |
| Lines      | 98%       |
| Statements | 95%       |
| Functions  | 100%      |
| Branches   | 89%       |

Raise them when coverage rises; do not lower them to make a change pass. Upstream packages are excluded because their tests predate this fork. The remaining uncovered branches are defensive states that a parsed document cannot reach, such as a plugin tree whose source range points at no marker, or a heading level that would drop below one after an outdent.

## Case design

- **Equivalence classes:** node kind, position (first, middle, last), children and no children, notes, indent 2/4/tab, markers, ordered and unordered, checked and unchecked.
- **Boundaries:** start and end of file, trailing newline and no trailing newline, empty label, heading levels 1 and 6, empty document.
- **Errors:** missing capability, invalid label, invalid heading level, overlapping splices, invalid document shape.
- **Properties:** a command changes only its edit ranges; a failed command leaves the input snapshot untouched; a sequence of commands keeps the document valid.
- **Golden text:** command tests compare the exact Markdown output. Readable diffs beat structural assertions for source-preserving edits.

## Browser checklist

Run before a release of the editor layer:

1. Click a node, press Enter; type a label; press Enter again.
2. Press Tab for a child, Shift+Tab for an outdent.
3. Press Escape in the field; the source is unchanged.
4. Rename a folded node; it stays folded.
5. Zoom and pan while the editor is open; the field follows the node.
6. Type an IME composition in a label; Enter commits, not adds a node.
7. Undo and redo with Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z.
8. Open the source pane, change the Markdown, wait for the debounce; the map and selection follow.
