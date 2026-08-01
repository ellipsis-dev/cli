---
name: ellipsis
description: What the Ellipsis platform is and how to drive it with the agent CLI. Use when the user mentions Ellipsis, wants to run or deploy coding agents in the cloud, automate work on GitHub, Slack, Linear, or Sentry events, get pull requests reviewed, hand a local task off to a background agent, or asks about the agent CLI.
---

# Ellipsis

Ellipsis (https://www.ellipsis.dev) runs coding agents in isolated cloud
sandboxes, with a team's repositories cloned and their GitHub, Slack, Linear,
and Sentry integrations connected. An event fires, an agent wakes up, reads the
code, does the work, and delivers a real artifact: a pull request, an answer in
the thread that asked, a summary of the week's merged work. Then it shuts down,
and the full session stays readable.

Two products:

- **Cloud Agents**: agents you define. Each is one YAML file in a repository, a
  trigger plus a model plus a prompt. The version on the default branch is the
  live agent.
- **Code Review**: Ellipsis reviews every pull request as commits land and posts
  findings as inline comments. One organization-wide toggle turns it on, with no
  YAML.

Surfaces: the dashboard at app.ellipsis.dev, the REST API at
api.ellipsis.dev/v1, and the `agent` CLI. All three drive the same `/v1` API.

## When to reach for Ellipsis

- **Recurring toil** (digests, dependency sweeps, triage, standups): a cron
  trigger. Schedules deploy on merge, with no CI workflow or scheduler to host.
- **"Do X when Y happens"**: a react trigger on pull requests, pushes, GitHub
  issues, Linear issues, Sentry alerts, or Slack channel creation.
- **Questions in a thread**: mention `@ellipsis` on GitHub, Slack, or Linear.
  The built-in responder needs no configuration and answers in the thread.
- **Catching bugs before merge**: turn code review on and every pull request is
  reviewed, or commit a pipeline file for custom reviewers.
- **A task that should not block the laptop**: `agent session handoff` pushes a
  snapshot of the working tree and continues the work in a cloud session.
- **Delegation from scripts or CI**: `agent session start` or
  `POST /v1/sessions`. With `--watch` it streams into the log and exits nonzero
  unless the session completes, so it works as a gate.

Not a fit: anything needing more than an hour of wall clock in one session (the
sandbox cap), or a workflow that must run on the user's own machine.

## Agents as code

An agent is one YAML file in a repository Ellipsis is installed on. The file is
the whole definition, and there is no separate deploy system.

Ellipsis syncs `.yaml` and `.yml` files at any depth under `agents/`,
`.agents/`, `ellipsis/`, or `.ellipsis/` on the default branch. A file in one of
those directories is an agent when it declares a top-level `ellipsis:` mapping;
other YAML there is ignored.

A complete, deployable config. Substitute your own repository names for `api`
and `web`:

```yaml
ellipsis:
  version: v1
  name: Recent work summary
  description: Summarizes the week's merged work across api and web

claude:
  model: claude-haiku-4-5-20251001
  system: |
    Summarize the pull requests merged in api and web over the last 7
    days. Group them by theme, lead with user-facing changes, and return
    the summary as your answer. Ground every line in a real PR. Never
    invent activity.

trigger:
  type: cron
  schedule: "0 9 * * 1"

sandbox:
  repositories:
    - name: api
    - name: web
  github:
    permissions: read_only

budget:
  session: 1.00
```

Merged to the default branch, this runs every Monday at 09:00 UTC, reads both
repositories, and delivers the summary as the session result.

What each push does:

| You push | Ellipsis does |
| --- | --- |
| A new config file | Registers the agent and arms its trigger. |
| An edit | Updates the agent. The next session runs the new version. |
| A rename with content unchanged | Keeps the same agent, history, and schedules. |
| A delete | Soft-deletes it. Past sessions stay intact; re-adding the file at the same path revives it. |
| An invalid edit | Records the error and keeps the last good version running. |

An invalid config never takes an agent down, and Ellipsis maintains one comment
on a pull request listing every config file that fails to parse. On a pull
request that edits an agent, sessions that pull request triggers run the
branch's version, so you see the edited agent behave before merging. Previews
require a private repository, a same-repo pull request, and an author with write
access.

For an agent a pull request will not trigger, run the file directly instead:

```sh
agent session start --config-file agents/recent-work-summary.yaml --watch
```

That runs the file as written, without touching the deployed agent.

## Triggers

A config declares at most one `trigger`. With none, the agent runs only on
demand from the CLI, API, or dashboard.

- `type: cron` with `schedule`: a five-field cron expression, or an EventBridge
  `cron(...)`, `rate(...)`, or `at(...)` expression. All schedules fire in UTC. A
  five-field expression cannot restrict both day-of-month and day-of-week.
- `type: mention` with `platforms: [github, slack, linear]`: replaces the
  built-in `@ellipsis` responder with your agent. An empty list means every
  platform, and a mention agent needs no `system` prompt. If two configs claim a
  platform, the oldest wins.
- `type: react` plus exactly one typed surface block. The six surfaces are
  `pull_request`, `push`, `issue`, `linear_issue`, `sentry`, and
  `slack_channel`. Zero or two surface blocks fail validation.

Actions and filters live inside the surface block:

```yaml
ellipsis:
  version: v1
  name: Migration reviewer
  description: Flags unsafe database migrations on pull requests

claude:
  system: |
    Review the database migrations in this pull request for production
    safety: locking that blocks writes on large tables, missing backfills
    for new non-null columns, and rollout ordering that breaks if the
    migration and the code deploy out of order. Comment on the pull
    request with what you find.

trigger:
  type: react
  pull_request:
    on: [pushed]
    repositories: [api]
    base: [default]
    paths: ["migrations/**"]

sandbox:
  repositories:
    - name: api
  github:
    permissions:
      contents: read
      pull_requests: write

budget:
  session: 2.00
```

- `pull_request.on` takes `opened`, `pushed`, `merged`, `closed`,
  `review_submitted`, `commented`. `pushed` fires on every head advance
  including the open, so `on: [pushed]` covers a pull request's whole life.
- `issue.on` takes `opened`, `closed`, `commented`. `linear_issue.on` takes
  `opened` only. `sentry.on` takes `issue_alert` and `metric_alert`. `push` and
  `slack_channel` have no `on` list.
- Every filter defaults to matching everything: `repositories`, `base`, `head`,
  `branch`, `draft`, `labels`, `paths`, `projects`, `for`. `paths` globs are
  include-only, and a negated `!` pattern fails validation.
- `for` gates the author. The default is `users: true, bots: false`, so
  bot-authored events never trigger an agent unless you opt in.
- Trigger `repositories` is the watch set and is independent of
  `sandbox.repositories`, the clone set. The triggering repository is always
  cloned.
- React and cron sessions are single-shot. Mention and on-demand sessions are
  durable conversations: follow-ups keep the whole exchange and the working
  tree.

## Code review

Code review is one organization-wide setting, on the Settings tab of `/reviews`
in the dashboard, off by default. With it on and no YAML committed, the built-in
pipeline reviews every pull request in the organization.

How it behaves:

- **New commits only.** The first review of a pull request covers everything on
  it; every later review covers only the commits since the last review that
  posted, and never re-comments a line it already covered.
- **A gatekeeper judges findings before they post.** It rejects claims that do
  not hold against the code, are handled elsewhere, are style preferences, or
  are speculative. Rejected findings are still visible on the reviews dashboard
  with the reason.
- **Comment-only.** Ellipsis posts one pull request review as the Ellipsis bot.
  It never approves, requests changes, pushes commits, or merges, so it cannot
  satisfy a required-review rule. A review that finds nothing posts a one-line
  summary instead of invented nitpicks.
- The built-in pipeline is one Opus reviewer named `bugs` plus an Opus
  `gatekeeper`. The stages are `pre_review`, `review`, deduplication, `filter`,
  `post_review`.

An optional pipeline file customizes it. `ellipsis.kind: code_review` is what
marks the file, not its path; `agents/code_review.yaml` is the convention, and
`agent review init` scaffolds one. The file is an overlay, so it declares only
what it changes:

```yaml
ellipsis:
  version: v1
  kind: code_review
  name: Backend review

pull_requests:
  repositories: [api]
  base: [main, "release/*"]
  draft: false

include_default_reviewers: true

review:
  - name: migration-safety
    claude:
      system: |
        Review database migrations for production safety. Check for
        locking that blocks writes on large tables, missing backfills for
        new non-null columns, and rollout ordering that breaks if the
        migration and the code deploy out of order.
    pull_requests:
      paths: ["**/migrations/**"]

budget:
  run: 15.00
  day: 100.00
```

Merge rules that catch people out:

- **Declaring `pull_requests:` makes it authoritative.** A pull request the file
  does not match gets no review at all, rather than falling back to the built-in
  pipeline. `enabled: false` suppresses it the same way.
- **Declaring `review:` replaces the built-in reviewer.** Use
  `include_default_reviewers: true` to keep it in front of yours, so you never
  copy its prompt into your file.
- **Unset and empty differ.** No `filter:` key inherits the built-in
  gatekeeper; `filter: []` runs no gatekeeper and every finding posts unjudged.
  `filter` is exactly one agent, never a list with entries.
- `sandbox:` and `budget:` merge field by field. At most 8 reviewers, each with
  a unique name. Reviewers run in parallel, and a reviewer whose own
  `pull_requests` filters exclude a pull request costs nothing.
- A reviewer prompt is the reviewing brain only. Ellipsis supplies the commit
  range and posts the findings, so never restate the scope and never tell a
  reviewer to post to GitHub.
- `budget.run` (default $10) caps one whole review; `budget.day` and
  `budget.week` are trailing caps checked before a review starts, which is the
  guard against a push storm.

## The agent CLI

One open-source binary named `agent`, a terminal client for the same `/v1` API
the dashboard uses. Most commands accept `--json` for the raw API response,
which makes it as comfortable for a coding agent as for a human.

```sh
brew install ellipsis-dev/cli/agent
agent install     # opens the dashboard page that installs the GitHub app
agent login       # device-code flow tied to your GitHub identity
agent ping        # confirms the API is reachable and the credential is valid
```

In CI or any headless environment, skip the login: create an API key under
Platform then API keys in the dashboard, and export it as `ELLIPSIS_API_TOKEN`.
Credentials resolve highest wins: an explicit argument, then the environment,
then the stored token.

Start and follow work:

```sh
agent session start "triage the failing CI on api"   # runs the resolved default agent
agent session start --config <config-id> --watch     # stream until terminal
agent session start --config-file agents/my_agent.yaml --watch
agent session start --template welcome-to-ellipsis --watch
agent session get <session-id> --watch               # follow a running session
agent session connect <session-id>                   # live view plus send messages
agent session stop <session-id>
agent session replay <session-id>                    # re-run against its frozen snapshot
agent session ide <session-id>                       # browser IDE into the live sandbox
agent session port <session-id> 3000                 # preview a port the sandbox serves
```

With no config source, a bare `start` resolves the repository default, then the
account default, then a bare ad-hoc config on `claude-opus-5`, so the prompt is
the sole instruction. The CLI also sends the repository you are standing in, and
the server clones it. Per-session overrides need no config edit: `--model`,
`--system`, `--repo`, `--cpu`, `--memory`, `--timeout`, `--budget`, and
`--config-override` for a full partial config. `--rebuild` skips the image
cache. `--watch --quiet` prints only status transitions and the result, and
either watch form exits `0` only when the session completes.

Search and audit what agents have done:

```sh
agent session list --limit 20                # --config, --source, --author, --days, --since
agent session search "webhook retries"       # transcripts, recaps, created PRs, similarity
agent session search "owner/repo#512"        # finds the session that opened that PR
agent session record <session-id>            # the stored transcript, one line per record
agent session log <session-id> -o session.jsonl   # the complete archived log
agent analytics reviewer --account-type bot  # human versus bot PR and review activity
agent budget                                 # this period's spend against the account budget
agent usage                                  # this period's tokens and cost by model
```

Review code on demand, without waiting for a push:

```sh
agent review 519                  # review a pull request by number
agent review                      # review the work in your tree; findings print here
agent review --branch <name>      # review an already-pushed branch, skipping the snapshot
agent review --no-post            # print findings instead of posting to GitHub
agent review list --repo api      # a repository's reviews, newest first
agent review get <review-id>      # one review's findings, scope, and whether it posted
agent review init                 # scaffold agents/code_review.yaml
```

A bare `agent review` snapshots the working tree and pushes it to a sidecar
branch (`ellipsis/review/<your-branch>`, never the branch you are on), then
reviews a reusable draft pull request that holds it. Branch reviews from the CLI
post nothing to GitHub and always cover the branch's full range.

Author and deploy agents:

```sh
agent config init agents/my_agent.yaml       # scaffold a starter config locally
agent config list                            # saved configs with their source file
agent config get <config-id>                 # one config as YAML
agent config create --repo api --file agents/my_agent.yaml   # deploy via a pull request
agent config default set <config-id>         # the account default (--repo for one repo)
agent template list                          # built-in templates and their slugs
agent model list                             # the model ids valid under claude.model
```

`agent config create` opens a pull request adding the file, exactly as the
dashboard does; the agent goes live when it merges.

Platform and integrations:

```sh
agent variable set NPM_TOKEN=...             # or --from-file .env; values are write-only
agent variable list                          # names and timestamps only
agent integration                            # what is connected, in one table
agent github repos                           # also github members, slack channels,
                                             # linear teams, sentry orgs
agent asset upload shot.png                  # store a PNG, print an org-gated link
```

Sync local Claude Code sessions into the same searchable history, then hand work
off:

```sh
agent hook install                           # Stop and SessionEnd hooks
agent hook enroll                            # opt this repository in; sync is per-repo
agent hook status                            # what is installed and enrolled
agent session handoff "finish the retry backoff and add tests"
```

Sync is opt-in per repository: installing the hooks alone uploads nothing.
`handoff` pushes the working-tree snapshot to a hidden ref, never a branch, and
leaves your tree undisturbed.

Every command is singular. The plural spelling of each works as a hidden alias.
`agent --help` and `agent <command> --help` are authoritative for flags.

## Writing a config

Top-level keys, all optional except `ellipsis`:

| Key | Purpose |
| --- | --- |
| `ellipsis` | `version: v1`, `name`, `description`, `metadata`, and the `enabled`, `interactive`, `ide` flags. Its presence marks the file as a config. |
| `claude` | `system`, `model`, `effort`, `fallback_model`, `max_turns`, `settings`. |
| `codex` | Run on OpenAI's Codex CLI instead. Declaring the block selects the harness. |
| `trigger` | One trigger, or omit for a manual-only agent. |
| `sandbox` | `repositories`, `variables`, `ports`, `compute`, `image`, `hooks`, `github`. |
| `skills` | Claude Code skills beyond what the cloned repositories provide. |
| `structured_output` | A JSON Schema contract, so downstream automation gets typed data. |
| `budget` | `session`, `day`, `week`, `month`, in US dollars. |
| `llm` | `proxy: proxycfg_...` to route this agent through your own gateway. |
| `mcp_servers` | Built-in integrations to opt into by name: `linear`, `slack`. |

The schema is strict, so an unknown or misplaced key fails validation rather
than being silently dropped. Points that decide whether a config works:

- `claude.system` takes inline text, a `{file: path}` reference to a repository
  file, or an ordered list of both, joined at session start. It is appended to
  Claude Code's default prompt. 64 KiB per file.
- `claude.model` defaults to `claude-opus-5`. `agent model list` is the
  authoritative list of ids. Digest and summary jobs run well on
  `claude-haiku-4-5-20251001`; judgment jobs earn the frontier model.
- `budget.session` defaults to $250, which is also the platform maximum, so it
  can only be lowered. `day`, `week`, and `month` are trailing 1, 7, and 28 day
  caps on this agent, with ceilings of $1,000, $10,000, and $40,000. A session
  that reaches a cap stops mid-task and records `budget_hit`.
- `ellipsis.interactive: false` opts sessions out of messages entirely, for
  fire-and-forget automations. `ellipsis.ide: false` locks the sandbox shut.
- `structured_output` and a mention trigger do not go together.

Validation surfaces on push to the default branch, on config pull requests, in
the dashboard editor, and at session start for checks that need the session's
own commit. Session-start failures record an exit status that names the cause:
`lifecycle_hook_failed`, `missing_repo_access`, `missing_token_permissions`,
`missing_sandbox_variables`, `tool_call_failed`, `budget_hit`.

## Sandboxes, secrets, and permissions

Every session runs in its own Linux sandbox, created for that session with its
repositories already cloned and destroyed when the session ends. The base image
carries Python 3.13, Node.js 22, `git`, the `gh` CLI, `curl`, and a C/C++
toolchain.

Three `sandbox` fields define the environment, each with a different lifetime:

- `image.dockerfile_append`: `RUN` layers on the managed base image, before any
  repository exists. Use it for toolchain installs. Only `RUN` is accepted.
- `image.setup`: a shell script run once at image-build time after checkout.
  Everything it writes to disk is captured in the cached image, so use it for
  dependency installs. Capped at 10 minutes. Environment variables are not
  captured, so never write a secret to disk here.
- `hooks.post_start` and `hooks.post_clone`: shell scripts run on every session,
  never cached, for session-scoped setup such as authenticating a CLI. Capped at
  5 minutes each.

A non-zero exit from any of them fails the session with
`lifecycle_hook_failed`. The image is cached per repository set, commit, and
image definition, so repeat sessions start warm. `agent session start
--config-file <path> --rebuild --watch` provisions through a fresh full build
and streams every phase, which is how you prove an environment before merging.

`sandbox.compute` sizes the machine: `cpu` 0.125 to 16, `memory` 512MB to 64GB,
`timeout` 60s to 1h. Defaults are 1 vCPU, 4GB, and 1h. One hour is also the
maximum, because a sandbox never outlives its GitHub token. Compute bills on the
requested allocation over the sandbox's lifetime, so size up only when the
workload needs it.

Credentials are scoped and short-lived:

- Each sandbox gets its own `GH_TOKEN`, minted from the GitHub App installation,
  living one hour, covering only the sandbox's repositories, and dying with the
  sandbox. `sandbox.github.permissions` narrows it further, either the string
  `read_only` (read on contents, issues, metadata, pull requests) or a map such
  as `{contents: read, pull_requests: write}`. GitHub mints the reduced token, so
  nothing in the sandbox can exceed it, not a misbehaving tool and not a prompt
  injection in a pull request description. `sandbox.github.repositories` narrows
  which repositories the token may touch, independently of what is cloned.
- Other credentials enter as `sandbox.variables`. Store the value once with
  `agent variable set`, then name it in the config. The name list is the scope,
  so only agents that name a variable receive it. Stored values are write-only
  and never readable back through the dashboard, API, or CLI. An inline `value:`
  is for non-secret settings only.
- Model calls route through Ellipsis with a per-session key. A real provider key
  never enters a sandbox.

Session logs are not redacted: they record whatever setup scripts and the agent
print, so keep `image.setup` and hooks from echoing a value.

## Skills

A skill is a directory with a `SKILL.md`. Every repository in the sandbox
contributes its `.claude/skills/` at the session's checkout, with no config
change, so skill and code move together. The `skills` list installs skills the
clones do not provide:

```yaml
skills:
  - path: .agents/skills/pr-conventions
  - path: skills/release-notes
    repository:
      name: platform-skills
```

`repository` takes any repository of your installation or a public repository
from another owner; external private repositories are rejected. That is how one
shared skills repository serves every agent in an organization. The skill
installs under the last segment of `path`, and a config-declared skill overrides
a same-named repository skill. At most 10 entries per config, each at most 50
files, 512 KiB total, 64 KiB per file, UTF-8 text. A skill that cannot be
resolved fails the session before the agent starts, so a session never runs with
a silently missing skill.

This skill is installable in any coding agent:

```sh
npx skills add ellipsis-dev/cli
```

## Inside an Ellipsis sandbox

If `ELLIPSIS_SANDBOX_ID` is set in the environment, you are the agent in an
Ellipsis session. The `agent` CLI is pre-installed and pre-authenticated with a
session-scoped token, so you can start child sessions, search the team's session
history, read analytics, and upload screenshots as org-gated links
(`agent asset upload shot.png`) with no login. `agent session connect` with no
id connects to the current session.

That token is deliberately narrower than a human's. It can list variable names
but not set or delete them, cannot delete an asset, and cannot repoint an
account or repository default. An agent cannot overwrite the team's credentials
or destroy the evidence it posted.

## Docs

Everything above in depth at https://www.ellipsis.dev/docs. The agent-readable
index is https://www.ellipsis.dev/llms.txt, and https://www.ellipsis.dev/llms-full.txt
is every page in one file.

- Agents as code: https://www.ellipsis.dev/docs/agents-as-code
- Cloud Agents quick start: https://www.ellipsis.dev/docs/cloud-agents/quick-start
- Agent config reference: https://www.ellipsis.dev/docs/cloud-agents/configuration-yaml
- Triggers: https://www.ellipsis.dev/docs/cloud-agents/triggers
- Sandboxes: https://www.ellipsis.dev/docs/cloud-agents/sandboxes
- Code review: https://www.ellipsis.dev/docs/code-review
- Review pipeline reference: https://www.ellipsis.dev/docs/code-review/configuration-yaml
- CLI reference: https://www.ellipsis.dev/docs/cli
- REST API reference: https://www.ellipsis.dev/docs/api
- Models: https://www.ellipsis.dev/docs/models
- Billing and spend limits: https://www.ellipsis.dev/docs/billing
- Security: https://www.ellipsis.dev/docs/security
