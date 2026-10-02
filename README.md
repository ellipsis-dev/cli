# Ellipsis CLI

Drive the [Ellipsis](https://ellipsis.dev) cloud from your terminal: start agent
sessions, stream their output live, and manage configurations.

This is a thin client. The agent runs in the Ellipsis cloud; the CLI
authenticates, opens a WebSocket, and streams results.

## Install

```sh
curl -fsSL https://ellipsis.dev/install.sh | sh
```

The script downloads the binary for your OS and CPU from GitHub Releases,
checks its SHA-256, and puts it at `~/.local/bin/ellipsis`, with `el` linked
next to it as a short alias. If that directory is
not on your PATH, it appends one line to your shell's startup file
(`--no-modify-path` to skip that). Pin a version with `ELLIPSIS_VERSION=2.30.0`
or `sh -s -- --version 2.30.0`; choose the directory with `--dir`.

In CI the same line works: inside GitHub Actions the directory is added to
`GITHUB_PATH`, and in a container `--dir /usr/local/bin` skips PATH setup
entirely. Alpine images get the musl build automatically.

```sh
ellipsis update       # replace the binary with the latest release (--check to only look)
ellipsis uninstall    # remove the binary and the PATH line (--purge to delete ~/.ellipsis too)
```

An installed binary checks for a newer release once a day, in the background,
and prints one line on stderr when it finds one. `ELLIPSIS_NO_UPDATE_CHECK=1`
turns that off; it is already off when `CI` is set or stderr is not a terminal.

## Teach your coding agent about Ellipsis

[`skills/ellipsis`](skills/ellipsis/SKILL.md) is an
[Agent Skill](https://agentskills.io) that teaches any coding agent (Claude
Code, Cursor, Codex, and others) what the Ellipsis platform is and how to
drive it with this CLI:

```sh
npx skills add ellipsis-dev/cli
```

Or copy `skills/ellipsis/` into your agent's skills directory
(`~/.claude/skills/` for Claude Code). Ellipsis agents can load it straight
from their config, no clone required:

```yaml fragment
session:
  skills:
    - path: skills/ellipsis
      repository:
        owner: ellipsis-dev
        name: cli
```

## Usage

```sh
ellipsis auth login                  # device-code auth against the active host
ellipsis auth logout                 # remove stored credentials (--all for every host)
ellipsis auth status                 # active host, where the token came from, and who you are

ellipsis host list                   # list configured hosts (the active one is marked *)
ellipsis host add beta https://beta-api.ellipsis.dev   # add a host and switch to it
ellipsis host use prod               # switch the active host
ellipsis host current                # show the active host and how it resolves
ellipsis host set beta --rename staging   # rename / re-point a host (--api-base / --app-base)
ellipsis host delete beta            # remove a host and its stored token

ellipsis session start --model claude-opus-5-5 -e backend "..."   # start a session in a saved environment
ellipsis session start --config-file f.json   # ...or from an inline config
ellipsis session start --template ellipsis-helper   # ...or from a maintained template
ellipsis session start --model claude-opus-5-5 --budget 5 "..."   # cap this session's spend, in dollars
ellipsis session start --model claude-opus-5-5 --image shot.png "..."   # the agent sees the picture on its first turn
ellipsis session start --model claude-opus-5-5 --watch "..."   # start and stream it until its opening turn ends
ellipsis session list --limit 20         # list recent sessions (filter by --source, --author, --since, …)
ellipsis session get <session-id>        # inspect one session (prints a dashboard link)
ellipsis session get <session-id> --watch  # follow the turn in progress until it ends
ellipsis session record <session-id>     # read a session's stored transcript, one line per record
ellipsis session stop <session-id>       # stop a session's turn in progress

ellipsis agent list                  # list your agents
ellipsis agent get <id>              # show one agent as YAML (--json for JSON)
el agent start <agent-id> ["..."]   # start a session from its saved settings; a prompt replaces its own
el agent start <agent-id> --input '{"issue": "ENG-42"}'   # start it with its typed input
ellipsis agent init [path]           # scaffold a starter definition (default: agents/my_agent.yaml)
ellipsis agent create --file agents/foo.yaml   # create one, live at once (or --template <slug>)
ellipsis agent create --repo api --file agents/foo.yaml   # instead define it as a file, via a pull request
ellipsis agent edit <id> --file agents/foo.yaml   # replace its definition, live at once
ellipsis agent delete <id>           # delete it; it stops and its name is freed
ellipsis agent link <id> --repo api  # move it into a repository, via a pull request
ellipsis agent unlink <id>           # take it over from its file, so the API changes it

ellipsis model list                  # list selectable agent models

ellipsis integration                 # every connected integration in one table
ellipsis github repos                # repositories connected to the GitHub installation
ellipsis github members              # org roster (the logins/ids --author accepts), with linked Slack identities
ellipsis slack channels              # channels in the connected Slack workspace
ellipsis slack members               # workspace members, with linked GitHub identities
ellipsis linear teams                # teams in the connected Linear organization
ellipsis sentry orgs                 # connected Sentry organizations

ellipsis variable list               # list sandbox env variable names (values are write-only)
ellipsis variable set A=1 B=2        # create/update variables (or --from-file .env/.json)
ellipsis variable delete K           # delete a variable

ellipsis budget                      # current budget summary
ellipsis usage                       # usage dashboard for the period

ellipsis analytics reviewer --account-type bot   # which apps review the most PRs
ellipsis analytics pr --days 30      # PR volume/trend with human vs bot splits
ellipsis analytics review --repo my-service      # review totals + top reviewers
ellipsis update                      # update the CLI to the latest release (--to <x.y.z> for a specific one)
ellipsis uninstall                   # remove the CLI from this machine (--purge to delete ~/.ellipsis too)
```

Every command shown is singular. The plural spelling of each (`ellipsis files`,
`ellipsis sessions`, `ellipsis analytics prs`) is a hidden alias that works but is
left out of `--help`.

Most commands accept `--json` to print the raw API response. The CLI talks to
the public REST API. Point it at a different instance durably with
`ellipsis host` (below), or per-invocation with `ELLIPSIS_API_BASE_URL` (or the
legacy `ELLIPSIS_API_BASE`).

`--watch` (on both `session start` and `session get`) streams the session's
output live over WebSocket until the turn it is waiting on ends (`completed`,
`failed`, `stopped`, or `cancelled`), falling back to polling the turn if the
live stream is unavailable. It exits 0 only for `completed`. Either way it
first prints a clickable dashboard link.

### Auth

`ellipsis auth login` uses the device-code flow: it requests a code pair, prints a
verification URL (and opens it unless `--no-browser`), and polls until you
approve the request in the dashboard. The issued user token is stored under
`~/.ellipsis/config.json` (mode 0600) and attributes sessions to you.

**Credentials resolve in this order (highest wins):** explicit argument →
environment (`ELLIPSIS_API_TOKEN` / `ELLIPSIS_API_BASE_URL`, with the legacy
`ELLIPSIS_API_BASE` accepted as a fallback) → the **active host** in the config
file → default (prod). This lets the CLI run headlessly — e.g. inside an
Ellipsis cloud sandbox where a per-sandbox token and base URL are injected into
the environment — with no `ellipsis auth login` and no config file on disk. `ellipsis auth logout` only clears the on-disk token (`--all` for every host); a token supplied
via `ELLIPSIS_API_TOKEN` lives in the environment and keeps working until you
unset it.

### Hosts

`ellipsis host` selects which Ellipsis instance the CLI targets — Ellipsis Cloud,
a preview environment, or a self-hosted deployment — so you can switch without
re-exporting env vars. `ellipsis host add <name> <api-url>` registers an instance
and makes it active; `ellipsis host use <name>` switches; `ellipsis host list` shows
them all (the active one marked `*`). Each host keeps its own token (so
switching doesn't re-authenticate) and its own dashboard/app URL. The app URL
is derived from the API URL by default (`api.` → `app.`); a self-hosted instance
whose dashboard host isn't a mechanical swap sets it explicitly with `ellipsis host
add … --app-base <url>` (or `ellipsis host set <name> --app-base <url>`). `ellipsis auth login` then authenticates the active host, and every link the CLI prints points
at that host's dashboard.

Hosts and tokens live in `~/.ellipsis/config.json` (mode 0600); set
`ELLIPSIS_CONFIG_DIR` to relocate it. A config file from before hosts existed
is migrated on first use — your existing login becomes a host named for its API
base.
