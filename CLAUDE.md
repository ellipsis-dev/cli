# Ellipsis CLI

## Tests are unit tests only

Every test in `test/` covers pure functions: input in, value out. Do not add a
test that renders the Ink UI. No fake TTY, no terminal emulator, no snapshot of
a painted screen, no `render()` from ink.

The UI is verified by running it, not by asserting on frames. When a rendering
claim needs coverage, pull the logic out of the component into a pure function
in `src/lib/` or `src/ui/*Rows.ts` and test that instead.

`test/screenshot.ts`, `test/screenshot.test.ts`, `test/connect-render.test.ts`,
and `test/scrollback.test.ts` were deleted for this reason. Do not bring them
back.

## Conventions

Command naming and `--help` text: see `skills/cli-conventions/SKILL.md`.
