# Editable Markmap fork

This branch is a fork of [Markmap](https://github.com/markmap/markmap) for [Markmap for OpenChamber](https://github.com/mmospanenko/openchamber-markmap), a file editor that renders and edits Markmap Markdown as a mind map in place.

The upstream renderer, layout, view, toolbar, and themes stay unchanged. The fork adds an editing layer on top of the parsed tree:

- `@markmap/model` projects the Markmap tree over its Markdown source, with label and block ranges.
- `@markmap/edit` applies source-preserving label, sibling, child, move, delete, outdent, and checkbox commands.
- `@markmap/edit-dom` adds selection, keyboard handling, the overlay label field, pointer drag with a drop indicator, and undo/redo.
- `@markmap/parse` and the `@markmap/core` types carry the source ranges the editor needs.

The branch also supports an empty document, keeps a promoted heading root selected after a rename or undo, and uses a zero-width marker for empty nested labels.

The fork keeps the upstream MIT license. See [`LICENSE`](LICENSE).
