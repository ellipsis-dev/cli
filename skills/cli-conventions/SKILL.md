---
name: cli-conventions
description: How to name commands, arguments, and flags in the Ellipsis agent CLI, and how to write its --help text. Use when adding or renaming a command, adding a flag, writing or reviewing a command description, or changing anything under src/commands/ in the ellipsis-dev/cli repo.
---

# Ellipsis CLI conventions

The primary reader of `agent --help` is a coding agent deciding its next call.
It reads once, from a cold start, with no memory of the last release. Every
rule here follows from that: **one spelling per concept, intent over
transport, no clutter to scan past.**

Helpers live in `src/lib/help.ts`. Use them; do not hand-roll `.alias()` or
route text.

## Command names

Singular nouns, one verb per action.

```
agent file list           agent file delete <file-id>
agent session start       agent config edit <config-id>
```

- **The noun is singular, always.** `file`, not `files`. `hook`, not
  `hooks`. `analytics` is the sole exception: it is a mass noun with no
  singular form.
- **The plural still works, hidden.** Register it with `alsoKnownAs`, which
  keeps it callable but strips it from every help surface. `agent files list`
  runs and prints nothing extra.
- **A renamed command keeps its old name, hidden.** `agent file` was `agent
  asset`, so it registers `asset` and `assets` alongside `files`. A caller who
  learned the old spelling is never told it is wrong.
- **Read-only integration browsers use a bare plural leaf**: `github repos`,
  `slack channels`, `linear teams`, `sentry orgs`. They have no
  get/create/delete to disambiguate against, so the extra `list` is noise.
  Anything with more than one verb gets `<noun> <verb>`: `file list`,
  `file get`, `file upload`, `file delete`.
- **`delete` is the shown verb**, with `rm` as a hidden alias. Never the
  reverse.
- **`list` is the shown verb**, with `ls` hidden.

```ts
const file = alsoKnownAs(
  program.command('file').description('...'),
  'files',
  'asset',
  'assets',
)

apiRoutes(
  alsoKnownAs(file.command('delete <file-id>').description('...'), 'rm'),
  'DELETE /v1/files/{id}',
)
```

## Arguments

Kebab-case placeholders: `<session-id>`, `<config-id>`, `<file-id>`,
`<api-url>`, `<owner/name>`. Never camelCase, and never a bare `<id>` when the
type matters.

## Flags

One meaning per short flag, across the whole CLI. The reserved ones:

| Short | Long | Meaning |
| ----- | ---- | ------- |
| `-o` | `--output <path>` | a file to write to. Never a format. |
| `-d` | `--detach` | start and return. Never `--days`. |
| `-c` | `--config <config-id>` | a saved agent config |
| `-f` | `--file` / `--from-file` / `--config-file` | an input file. Never `--force`. |
| `-r` | `--repo` | a repository |
| `-s` | `--source` | a session source |
| `-a` | `--author` | a GitHub login |
| `-l` | `--limit <n>` | a result cap |
| `-t` | `--template <slug>` | a template |
| `-p` | `--prompt` / `--parent` | (context-dependent, both session-scoped) |
| `-w` | `--watch` | block and stream |
| `-m` | `--metadata` | repeatable key=value |
| `-n` | `--tail <n>` | tail N entries |
| `-i` | `--interactive` | open a conversation instead of printing |

Other rules:

- **`--json` is the only way to ask for JSON.** There is no `-o json`, no
  `--format`. Description: `output raw JSON`, plus a parenthetical when the
  JSON differs from the table (`output raw JSON (full record payloads)`).
- **Time windows are `--since` / `--until`, plus `--days <n>`.** Both accept
  ISO 8601 and `today`, `yesterday`, `N days ago` via `parseWhen`. `--start` /
  `--end` are dead; do not reintroduce them.
- **Repeatable flags say so**: `(repeatable)` at the end of the description.
- **Coerce and validate in `src/lib/args.ts`**, so a typo fails locally with
  the full list of valid values instead of a server 422.

## Descriptions

One line, imperative verb first, no trailing period.

- **Say what the caller gets, not which endpoint answers.** `List your stored
  files, newest first` — not `List files (GET /v1/files)`.
- **Routes go in the long help**, last, via `apiRoutes(cmd, 'GET /...')`.
  When a command also has an `addHelpText('after', ...)` usage note, chain the
  note *inside* the `apiRoutes()` call so the route line still lands last.
- **Name the concept the same way every time.** The object under `agent
  config` is an **agent config** — never "configuration", never bare "agent".
- **No em dashes or en dashes** in any new user-facing string. Use a colon, a
  comma, or two sentences. (Legacy table placeholders still hold `—`; do not
  add more, and prefer `-` for new ones.)
- **No `a|b` alias spellings in prose.** `model|models` tells the reader
  nothing and doubles the width of the term column.
- Point at the command that answers the follow-up question:
  `(see \`agent model list\`)`, `(see \`agent github members\`)`.

## Top-level help

`agent --help` is grouped, not flat: Sessions, Agents, Platform,
Integrations, Spend, Account. Groups live in `TOP_LEVEL_GROUPS` in
`src/lib/help.ts`. **A new top-level command must be added to a group** or it
falls through to "Other", which is the signal that someone forgot.

Every help page ends with the `agent help --interactive` hint, registered once
as an `afterAll` help text on the program in `src/lib/help.ts` (commander emits
that event up the ancestor chain, so subcommands inherit it). Do not re-add it
per command. Text added this way is not wrapped by commander, so it goes
through `wrapToHelpWidth` to match every other column.

## Checklist for a new command

1. Singular name; plural registered via `alsoKnownAs`.
2. Kebab-case argument placeholders.
3. Short flags match the reserved table, or have none.
4. Description: imperative, one line, no route, no em dash.
5. Routes via `apiRoutes`, chained outside any usage note.
6. `--json` if it prints structured data.
7. New top-level command added to `TOP_LEVEL_GROUPS`.
8. `npm run typecheck && npm test`, then read the actual `--help` output.
