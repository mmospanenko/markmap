# [PRD-5] Layout frontmatter persistence

## Context

Markmap supports tree, two-sided, and org-chart layouts. When a user selects a layout from the editor, persisting this choice in frontmatter ensures the selection is preserved across sessions and file saves while keeping existing frontmatter attributes, comments, and document structure intact.

## Requirements

- [REQ-5-1] When setLayout command is applied, the editor shall update or insert markmap.layout in frontmatter, preserving other frontmatter fields, comments, BOM, line endings, and body.
- [REQ-5-2] When setLayout selects the already active layout, it shall be a no-op without edits or history entry.
- [REQ-5-3] When frontmatter contains YAML errors, setLayout shall refuse the command and report an error without modifying the document.
- [REQ-5-4] When undo or redo restores a layout command, the document source and editor layout state shall restore atomically.
- [REQ-5-5] When setLayout receives an invalid layout string, it shall leave the document unchanged without producing edits.
- [REQ-5-6] When markmap is defined through a YAML alias or contains alias references, setLayout shall refuse the command and report an error without modifying the document.
- [REQ-5-7] When setLayout is applied, active selection shall be preserved across layout changes, including node selection, sibling group selection, and relationship arrow selection.
- [REQ-5-8] When frontmatter contains inline flow mapping, anchors, or non-mapping top-level structures, setLayout shall safely insert into flow mapping or refuse the command with an error without modifying the document.
- [REQ-5-9] When setLayout modifies frontmatter, it shall preserve empty layout comments and delimiters, refuse block scalars, support top-level flow mappings, and validate candidate YAML before applying.

## Acceptance tests

| Requirement | Tests                 |
| ----------- | --------------------- |
| REQ-5-1     | TC-5-1-1 ... TC-5-1-3 |
| REQ-5-2     | TC-5-2-1              |
| REQ-5-3     | TC-5-3-1              |
| REQ-5-4     | TC-5-4-1              |
| REQ-5-5     | TC-5-5-1              |
| REQ-5-6     | TC-5-6-1 ... TC-5-6-2 |
| REQ-5-7     | TC-5-7-1 ... TC-5-7-4 |
| REQ-5-8     | TC-5-8-1 ... TC-5-8-3 |
| REQ-5-9     | TC-5-9-1 ... TC-5-9-3 |
