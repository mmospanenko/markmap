---
title: Writing maps
---

Markmap reads ordinary Markdown, with [GFM](https://github.github.com/gfm/) extensions, so a document you already have is usually a map already.

## Branches

Only headings and list items become nodes. When the only top-level node is a heading at H1-H6, it becomes the root even if a non-empty `title` is present. A leading list means there are multiple top-level nodes, so no promotion happens. The `title` supplies the root label only when no promotion happens. Otherwise the root stays empty.

New branches use heading markers only at H1 and H2: a child of an H1 root or heading becomes H2, and a child of an H2 or deeper heading becomes a list item, as does a sibling of an H3-H6 heading. Existing H3-H6 headings in a file still render and edit in place.

```md
---
title: Used when the body has no single top-level heading
---

## A heading is a branch

- So is a list item
  - Nest them as deep as you like
```

## Labels

A label can hold:

| Syntax                     | Shows                                              |
| -------------------------- | -------------------------------------------------- |
| `**bold**`, `*italic*`     | Bold, italic                                       |
| `~~strike~~`               | Strikethrough                                      |
| `==highlight==`            | Highlight                                          |
| `` `code` ``               | Inline code                                        |
| `[text](url)`              | A link                                             |
| `- [x] done`, `- [ ] open` | A task list checkbox                               |
| `![alt](url)`              | An image                                           |
| `$e^{i\pi}$`               | Math, with [plugin-math](../packages/view.md#math) |

Raw HTML is dropped, with two exceptions: [magic comments](magic-comments.md) and a single `<img>` tag, described below.

## Notes

Anything else, such as paragraphs, code blocks, tables and quotes, becomes a **note** on the node that owns it. A note is a small dot beside the label. Click it to read the note in a popover.

- A paragraph under a heading belongs to that heading.
- In a list item with several paragraphs, the first is the label and the rest are notes.
- Blocks before the first heading belong to the root.

````markmap
# Release

## Checklist

Run these in order, and stop if one fails.

- Tag the version

  ```sh
  git tag v1.0.0
  ```

- Tell people

````

Notes keep the map small and leave your document whole. Code in a note is highlighted, and exported images keep the dot but not the note's content.

### Note blocks

A fenced block with the `markmap-note` info string is a note too, and its content is parsed on its own. Headings, lists, tables and code inside it stay inside the note and never become branches.

````md
- Release

  ```markmap-note
  Ship on a Tuesday.

  - This list is part of the note
  ```

  - This is a child branch
````

Indent the fence to the node's content when the node is a list item. A paragraph note, like the ones above, still works; saving a note from the editor writes one `markmap-note` fence.

## Images

`![alt](url)` loads the image to find its size. To lay it out at once, give the size with an `<img>` tag:

```md
- Logo <img src="logo.png" width="120" height="80" alt="Logo">
```

Only `src`, `alt`, `width` and `height` are kept. Every image is capped at the wrap width and keeps its aspect ratio. An image that fails to load shows its alt text.

## Math

Math works in labels and in notes, on the website and with the [CLI](../packages/cli.md). In your own code, add [@markmap/plugin-math](../packages/view.md#math).

```markmap
# Math

- Euler: $e^{i\pi} + 1 = 0$
- Sum: $\sum_{k=1}^{n} k = \frac{n(n+1)}{2}$
```
