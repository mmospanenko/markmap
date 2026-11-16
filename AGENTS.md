# Agent guide

Fork of [markmap](https://github.com/markmap/markmap) at `v1.1.1`. The renderer stays upstream-compatible. The fork adds source-preserving node editing for Markmap Markdown.

English is the repository language for code, tests, docs and commits. Chat replies follow the user's language.

## What the fork adds

- `packages/model` (`@markmap/model`): parse a document, build an immutable editable snapshot with source ranges, validate it, expose node capabilities and return the render tree.
- `packages/edit` (`@markmap/edit`): turn a command into non-overlapping splices, apply them, parse the result, validate it, check the shape and return the next snapshot, render tree and selection offset.
- `packages/edit-dom` (`@markmap/edit-dom`): selection, keyboard, pointer drag with a drop indicator, overlay field, undo and fold preservation over a live `Markmap` view.
- `packages/core` and `packages/parse` carry only the source ranges needed by the model.

## Commands

The lockfile is pnpm 12. Use `npx` when the global pnpm is older.

```bash
npx -y pnpm@12 install
pnpm dev
node_modules/.bin/vitest --run
pnpm test:coverage
pnpm typecheck
pnpm lint
pnpm fmt:check
node scripts/check-trace.mjs
pnpm verify
```

Run tests against sources, not stale builds. The Vitest config maps `@markmap/*` to `packages/*/src/index.ts`.

## Architecture

```text
Markdown -> @markmap/parse (remark) -> MarkmapNode tree with source ranges
         -> @markmap/model -> validated Document snapshot
         -> @markmap/edit  -> splices -> parse -> validate -> next snapshot
         -> @markmap/edit-dom -> selection, keyboard, overlay, history
         -> @markmap/render/view (unchanged)
```

- Markdown text is the only source of truth.
- A command returns splices and a selection offset. It never serializes the tree.
- `parseDocument(source)` returns `{ document, tree, frontmatter }`. The tree is the render input.
- `applyCommand(document, command)` returns `{ document, tree, edits, selection }`.
- `MarkmapEditor` takes an `EditView`, a container and the source. `createEditView(mm)` adapts a `Markmap`.
- A failed command throws `EditError` and leaves the input snapshot untouched.
- Selection is a source offset, because node ids are content hashes and change on rename.

## Non-negotiables

- Never add a full tree-to-Markdown serializer. It normalizes untouched Markdown and breaks byte preservation.
- Every command runs the same gate: capability check, splice plan, apply, parse, validate, shape check.
- Keep changes to `core`, `parse`, `render` and `view` minimal and upstream-friendly. New behavior belongs in `model` and `edit`.
- Do not publish under the `@markmap/*` scope. The fork is consumed through git.
- Do not write comments in code. Tests and docs carry the explanation.
- Docs are public. Use placeholders and synthetic examples; no local paths, usernames, sessions, or personal data.
- Every behavior test carries a `[TC-N-M-K]` name and maps to a `[REQ-N-M]` in `docs/prd`.
- Every change adds or updates tests. `pnpm verify` must pass. The changed files must have no uncovered lines or branches.
- Run `node scripts/check-trace.mjs` after adding or renaming a test or requirement.
- Mixed or unsupported structures are opaque and reject structural commands. Do not guess a structure for them.
- Preserve the document line ending style and every byte outside the edit ranges.
- Keep the overlay field outside the SVG. Position it from `screenRect`, hide the node text with a class and replay classes after every render.
- Markmap does not parse an empty nested list item. New nodes use the placeholder label and select it for typing.
- The view is read-only: never patch `@markmap/view` for editor behavior. Use the `EditView` contract.
- A node drag lifts a clone of the subtree, shows one insertion line or one child frame, and applies a single `move` command on drop. The pointer layer owns no layout and writes no Markdown itself.

## Workflow

1. Read `docs/index.yml`, the PRDs and the ADRs.
2. Add or change a requirement in `docs/prd` before changing behavior.
3. Write a failing test with a `[TC-N-M-K]` name.
4. Implement the smallest change that passes.
5. Run `pnpm verify`. For view or editor changes, also walk the browser checklist in `docs/process/testing.md`.
6. Update the PRD acceptance table and the ADR when a decision changes.

Process documents: `docs/process/sdlc.md`, `docs/process/testing.md`, `docs/process/bugs.md`, `docs/process/checks.md`.

## Worktrees and sync

All work happens in `.worktrees/<name>`, never in the main checkout; agents run in parallel. The directory is gitignored and the OpenCode project config points there.

When the work is done, push the worktree branch and open a PR into `feat/editable-model`. Merge through GitHub after CI. Do not commit or merge directly into `feat/editable-model`.

## Markmap facts

- `parse(markdown)` returns `{ root, frontmatter, gfm }`, where `root` is a `MarkmapNode`.
- `position` is the mdast range of the node. A heading position covers only the heading line.
- This fork adds `source.label` and `source.block`. A heading block ends at the next heading with an equal or lower level, or at the end of the document.
- Node ids are hashes of the parent id and the node text. A rename changes the id of the node and its descendants.
- `@markmap/view` renders text primitives. It has no per-node editable DOM.
- `screenRect(id)`, `hitAt(x, y)` and `layoutPoint(clientX, clientY)` connect the editor to the view.
- `setTree(root, options)` keeps folds for ids that still exist.
- Fold state is not persisted to Markdown. `<!-- markmap: fold -->` is read, not written.
- Empty nested list items are not parsed; the editor inserts a placeholder label instead.
