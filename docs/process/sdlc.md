# SDLC

The fork follows the same lifecycle as upstream: a requirement, a failing test, the smallest implementation, and a green gate.

## Stages

1. **Requirement.** Add or change a `[REQ-N-M]` in `docs/prd` and a matching row in the acceptance table.
2. **Test.** Write a `[TC-N-M-K]` test that fails for the missing behavior.
3. **Implementation.** Change the smallest package that owns the behavior.
4. **Local gate.** Run `pnpm verify`. It runs traceability, types, lint, formatting, coverage and builds.
5. **Acceptance.** For view or editor changes, run `pnpm dev`, open `/editor.html`, and walk the keyboard checklist in [testing](testing.md).
6. **Commit.** One logical change per commit. The message names the behavior, not the files.
7. **Review.** A review checks the requirement, the failing test, coverage of the new branch, and that no upstream package was changed without need.

## Rules

- The PRD is the source of truth for behavior. If code and PRD disagree, fix one of them in the same change.
- New behavior belongs in `@markmap/model`, `@markmap/edit` or `@markmap/edit-dom`. Changes to `core`, `parse`, `render` and `view` stay small and upstream-friendly.
- A command never edits Markdown directly. It returns splices and the next snapshot.
- Tests are named `[TC-N-M-K]` and map to exactly one requirement. The trace script enforces both directions.
- The repository is an internal fork. Do not publish under `@markmap/*`.

## Gates

| Gate        | Command                        | Blocks on                                 |
| ----------- | ------------------------------ | ----------------------------------------- |
| Trace       | `node scripts/check-trace.mjs` | Missing, orphan or duplicate test ids     |
| Types       | `pnpm typecheck`               | Type errors, including tests              |
| Lint        | `pnpm lint`                    | Oxlint errors                             |
| Format      | `pnpm fmt:check`               | Unformatted files                         |
| Build types | `pnpm build:types`             | Broken declarations                       |
| Build JS    | `pnpm build:js`                | Broken package output                     |
| Tests       | `pnpm test:coverage`           | Failed tests or coverage below thresholds |

`pnpm verify` runs all gates in order. Tests run after the builds because the CLI imports a built canvas entry.
