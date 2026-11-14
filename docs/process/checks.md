# Checks

| Command                        | Covers                                                   |
| ------------------------------ | -------------------------------------------------------- |
| `npx -y pnpm@12 install`       | Install with the lockfile's pnpm major                   |
| `pnpm dev`                     | Playground at `/` and editor at `/editor.html`           |
| `pnpm typecheck`               | `tsc -p tsconfig.test.json` over sources and tests       |
| `pnpm lint`                    | Oxlint, including test rules                             |
| `pnpm fmt` / `pnpm fmt:check`  | Oxfmt write / verify                                     |
| `pnpm test`                    | Vitest without coverage                                  |
| `pnpm test:coverage`           | Vitest with V8 coverage and configured thresholds        |
| `node scripts/check-trace.mjs` | Requirement and test id coverage                         |
| `pnpm build:types`             | `tsc -b` project references and declarations             |
| `pnpm build:js`                | Vite library builds for every package                    |
| `pnpm verify`                  | Trace, types, lint, format, coverage and builds in order |

## Notes

- The lockfile is pnpm 12. A global pnpm 10 cannot read it; use `npx -y pnpm@12`.
- The CLI PNG tests import `@markmap/canvas/node` from `dist`. `pnpm verify` builds types and packages before it runs the tests; running `vitest` alone on a fresh checkout without a build fails those three tests.
- The trace script reads `docs/prd` and every `packages/*/src/**/*.test.ts`.
