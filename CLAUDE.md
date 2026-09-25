# Ellipsis CLI

## Tests are unit tests only

Every test in `test/` covers pure functions: input in, value out. Do not add a
test that drives a terminal: no fake TTY, no terminal emulator, no snapshot of
printed output. When output needs coverage, pull the logic into a pure
function in `src/lib/` and test that instead.

## Conventions

Command naming and `--help` text: see `skills/cli-conventions/SKILL.md`.
