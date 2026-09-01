---
name: ellipsis
description: What the Ellipsis platform is and how to drive it with the agent CLI. Use when the user mentions Ellipsis, wants to run or deploy coding agents in the cloud, govern agents with budgets and scoped permissions, automate work on GitHub, Slack, Linear, or Sentry events, get pull requests reviewed, hand a local task off to a background agent, or asks about the agent CLI.
---

# Ellipsis

Ellipsis (https://www.ellipsis.dev) is a cloud platform for coding agents. It
runs them like managed infrastructure: defined in your repository, deployed by
git push, governed by scoped credentials and hard budgets, with every session
recorded and searchable.

An event fires, an agent wakes in an isolated sandbox with your repositories
cloned, reads the code, does the work, and delivers a real artifact: a pull
request, an answer in the thread that asked, a review on the diff. Then the
sandbox is destroyed and the full session stays readable.

## The problem it solves

Teams run a lot of agents now, and nothing manages the fleet.

- Agents run on a developer's own credentials, so an agent's blast radius is a
  person's blast radius.
- Spend is unbounded and invisible until the invoice arrives.
- Setup lives in one engineer's dotfiles, so only that engineer benefits.
- No transcript outlives the session, so a bad pull request has no audit trail.

Every other kind of compute a team runs is defined in code, scoped, budgeted,
and logged. Agents are not, yet.

Individual developers feel a different half of it. Agents clobber each other's
work even with git worktrees. Agents die when the laptop closes. Nobody can read
the logs of a session they do not own.

## Why cloud beats laptop

- **Parallelism.** Each session gets its own sandbox, so ten agents work the
  same repository at once without stepping on each other. Each can boot the
  full stack in its own box.
- **Shared.** The config is a repository asset. New engineers discover the
  team's automation the way they discover the code.
- **Governed.** Budgets, scoped credentials, and the audit trail are the
  platform's job, not each developer's.
- **Always on.** Agents trigger on GitHub events, Slack and Linear mentions,
  Sentry alerts, or a schedule. Work starts when the event fires, not when
  someone opens a laptop.

## The two products

- **Cloud Agents**: agents you define. Each is one YAML file in a repository, a
  trigger plus a model plus a prompt. The version on the default branch is the
  live agent.
- **Code Review**: Ellipsis reviews every pull request as commits land and posts
  findings as inline comments. One organization-wide toggle turns it on, with no
  YAML.

Surfaces: the dashboard at app.ellipsis.dev, the REST API at
api.ellipsis.dev, and the `agent` CLI. All three drive the same API.
Pricing is usage based, the tokens and compute a session spent plus a platform
fee. There are no seats.

## When to reach for Ellipsis

- **Recurring toil** (digests, dependency sweeps, triage, standups): a cron
  trigger. Schedules deploy on merge, with no CI workflow or scheduler to host.
- **"Do X when Y happens"**: a react trigger on pull requests, pushes, GitHub
  issues, Linear issues, Sentry alerts, or Slack channel creation.
- **Questions in a thread**: mention `@ellipsis` on GitHub, Slack, or Linear.
  The built-in responder needs no configuration and answers in the thread.
- **Catching bugs before merge**: turn code review on and every pull request is
  reviewed, or commit a pipeline file to scope and customize it.
- **Delegation from scripts or CI**: `agent session start` or
  `POST /v1/sessions`. With `--watch` it streams into the log and exits nonzero
  unless the session completes, so it works as a gate.

Things teams actually build: screenshot every pull request that touches the
frontend so reviewers see the change; investigate Sentry alerts when they fire
and post the root cause on the issue; require a migration file on any pull
request that touches the database; keep pull request descriptions current on
every push.

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

environment:
  repositories:
    - name: api
    - name: web

permissions:
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

Why this matters: an agent change is a pull request, so a teammate reads the new
prompt and the new permissions before they go live. `git log` on the file is the
agent's changelog. A bad change is `git revert`. There is no console state to
reconcile against the repository, and `ls agents/` reads like a roster of every
job the team has delegated.

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

environment:
  repositories:
    - name: api

permissions:
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
  `environment.repositories`, the clone set. The triggering repository is always
  cloned.
- Sentry re-fires inside a 6 hour per-issue window append to the existing
  conversation, so an alert storm produces one investigation, not dozens of
  duplicates. Webhook deliveries are deduplicated, so a replay never
  double-runs an agent.
- React and cron sessions are single-shot. Mention and on-demand sessions are
  durable conversations: follow-ups keep the whole exchange and the working
  tree, and an idle conversation costs near nothing between turns.

## Code review

Code review is one organization-wide setting, on the Settings tab of `/reviews`
in the dashboard, off by default. With it on and no YAML committed, the built-in
pipeline reviews every pull request in the organization.

How it behaves:

- **New commits only.** The first review of a pull request covers everything on
  it; every later review covers only the commits since the last review that
  posted, and never re-comments a line it already covered.
- **Only confirmed defects.** The reviewer files a finding only when it can
  point at the wrong line and name the input or state that breaks it, so a
  review is a short list of real problems rather than a page of "consider
  whether". It reads the surrounding code, not the diff alone, because most real
  findings depend on a caller or a guard the diff does not show.
- **Comment-only.** Ellipsis posts one pull request review as the Ellipsis bot,
  anchored to the commit it reviewed. It never approves, requests changes,
  pushes commits, or merges, so it cannot satisfy a required-review rule. A
  review that finds nothing posts a one-line summary instead of invented
  nitpicks.
- **Bots are reviewed too**, minus dependabot and renovate. A dependency bump is
  exactly the change nobody reads closely.
- The built-in pipeline is two agents: a Haiku `pr-description` agent that keeps
  the pull request description's summary current, and one Opus reviewer named
  `bugs`. The stages are `pre_review`, `description`, `review`, deduplication,
  `filter`, `post_review`; only `description` and `review` are populated by
  default.
- Reviewers never post. Each writes findings to a file, and the platform posts.
  A reviewer prompt is the reviewing brain only: Ellipsis supplies the commit
  range, so never restate the scope and never tell a reviewer to post to GitHub.

### The pipeline file

One optional file customizes the review. **There is one filename,
`code_review.yaml`, and where you commit it decides what it governs:**

- At the root of a repository: governs that repository. `.ellipsis/code_review.yaml`
  also works for its own repository, and the root path wins if both exist.
- At the root of the repository literally named `.ellipsis`: governs every
  repository in the organization. That repository is never itself reviewed.
- Anywhere else: a configuration error, not a file that silently reviews
  nothing.

First hit wins, and a repository's own file **replaces** the organization-wide
one rather than merging with it, so copy across whatever you meant to keep. That
also means an organization file's filters are not a ceiling: a repository the
organization file excluded can review itself by committing its own file.

The file is an overlay on the built-in pipeline, so it declares only what it
changes:

```yaml
# code_review.yaml at the root of the .ellipsis repository
ellipsis:
  version: v1
  kind: code_review
  name: Backend review

pull_requests:
  repositories: [api]        # valid only in the .ellipsis repository's copy
  base: [main, "release/*"]
  draft: false

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

filter:
  name: strict-gate
  claude:
    system: |
      Approve only findings a staff engineer would raise in review.
      Reject style opinions and anything a linter catches.

budget:
  run: 15.00
  day: 100.00
```

Merge rules that catch people out:

- **`ellipsis.kind: code_review` marks the file**, and the path decides its
  scope. A pipeline file is not an agent config and is not synced from `agents/`.
- **Declaring `pull_requests:` makes it authoritative.** A pull request the
  governing file does not match gets no review at all, rather than falling back
  to the built-in pipeline. It also narrows the audience to humans unless the
  block writes `for` back out, because the block replaces the default wholesale.
- **Declaring a stage list replaces that stage wholesale.** There is no
  "append to the built-in reviewers" knob. A file wanting a specialist beside a
  general pass declares both reviewers itself.
- **Unset and empty differ where the built-in ships a stage.** No `review:` key
  inherits the built-in reviewer. No `description:` key inherits the built-in
  description agent, and `description: []` is the only way to stop it. For
  `filter:` both unset and `[]` mean no gatekeeper, since nothing gates findings
  unless you declare one.
- **`enabled: false` does not suppress review.** It marks the file inactive, so
  Ellipsis reads it as no policy and continues to the organization file, then the
  built-in pipeline. To stop reviews in one repository, commit a file whose
  `pull_requests:` matches nothing, such as `for: {users: false, bots: false}`.
- `description` and `filter` are each exactly one agent, never a list with
  entries. At most 8 reviewers, each with a unique name. Reviewers run in
  parallel, and a reviewer whose own `pull_requests` filters exclude a pull
  request costs nothing.
- `environment:` and `budget:` merge field by field.
- `budget.run` (default $10) caps one whole review across every stage, divided
  among its agents. `budget.day` and `budget.week` are trailing caps checked
  before a review starts, which is the guard against a push storm.

An optional `filter` gatekeeper judges every finding before it posts and rejects
claims that do not hold against the code, are handled elsewhere, are style
preferences, or are speculative. Rejected findings stay visible on the reviews
dashboard with the reason. It is off by default because one careful reviewer
leaves a second pass little to arbitrate, and that pass doubles every review's
cost and latency.

## The agent CLI

One open-source binary named `agent`, a terminal client for the same API
the dashboard uses. Most commands accept `--json` for the raw API response,
which makes it as comfortable for a coding agent as for a human.

```sh
brew install ellipsis-dev/cli/agent
agent install     # opens the dashboard page that installs the GitHub app
agent login       # device-code flow tied to your GitHub identity
agent ping        # confirms the API is reachable and the credential is valid
agent me          # the identity behind the current credential
```

In CI or any headless environment, skip the login: create an API key in the
dashboard and export it as `ELLIPSIS_API_TOKEN`. Credentials resolve highest
wins: the environment variable, then the token stored in `~/.ellipsis/config.json`.
`ELLIPSIS_API_BASE_URL` points the CLI at a non-default host.

Start and follow work:

```sh
agent session start "triage the failing CI on api"   # a bare ad-hoc session
agent automation run <automation-id> --input '{...}'   # invoke an automation as defined
agent session start --config-file agents/my_agent.yaml --watch
agent session start --template ellipsis-helper --watch
agent session get <session-id> --watch               # follow a running session
agent session connect <session-id>                   # live view plus send messages
agent session stop <session-id>
agent session ide <session-id>                       # browser IDE into the live sandbox
agent session port <session-id> 3000                 # preview a port the sandbox serves
```

With no config source, a bare `start` runs the bare ad-hoc config — an empty
system prompt on the account's default model in the basic sandbox — so the
prompt is the sole instruction. The CLI also sends the repository you are standing in, and
the server clones it. Per-session overrides need no config edit: `--model`,
`--system`, `--repo`, `--cpu`, `--memory`, `--timeout`, `--budget`, and
`--override` for a full partial config patch. `--rebuild` skips the image
cache. `--detach` returns immediately. `--watch --quiet` prints only status
transitions and the result, and either watch form exits `0` only when the session
completes.

Search and audit what agents have done:

```sh
agent session list --limit 20                # --automation, --source, --author, --days, --since
agent session search "webhook retries"       # transcripts, recaps, created PRs, similarity
agent session search "owner/repo#512"        # finds the session that opened that PR
agent session record <session-id>            # the stored transcript, one line per record
agent session log <session-id> -o session.jsonl   # the complete archived log
agent analytics reviewer --account-type bot  # human versus bot PR and review activity
agent budget                                 # this period's spend against the account budget
agent usage                                  # this period's tokens and cost by model
```

Search covers transcripts, recaps, and pull request references, with embedding
similarity alongside full text, so one agent's investigation compounds into team
knowledge. Facets cover repository, author, agent, status, source, and date.

Review pull requests on demand, without waiting for a push:

```sh
agent review 519                  # review a pull request by number
agent review 519 --full           # re-review the whole PR, ignoring earlier reviews
agent review 519 --no-post        # print findings instead of posting to GitHub
agent review list --repo api      # a repository's reviews, newest first
agent review get <review-id>      # one review's findings, scope, and whether it posted
agent review init                 # scaffold code_review.yaml for this repository
```

Which pipeline runs is not a parameter. An explicit review resolves the same
pipeline by location that the webhook does, so the two entry points can never
disagree. A review with nothing new to cover returns a `skipped` review rather
than an error.

Author and deploy agents:

```sh
agent automation init agents/my_agent.yaml   # scaffold a starter definition locally
agent automation list                        # automations with their source file
agent automation get <id>                    # one automation as YAML
agent automation run <id> --input '{...}'    # invoke it exactly as defined
agent automation create --file agents/my_agent.yaml   # create it, live at once
agent automation edit <id> --file agents/my_agent.yaml   # replace its definition, live at once
agent automation delete <id>                 # delete it; it stops and frees its name
agent automation link <id> --repo api        # move it into a repo, via a pull request
agent automation unlink <id>                 # take it over from its file
agent template list                          # built-in templates and their slugs
agent model list                             # the model ids valid under claude.model
```

An agent is owned by one of two writers, and that is what these verbs move.
`agent automation create` with no `--repo` creates it through the API alone: no
file, live immediately, changed by `config edit`. With `--repo` it instead
opens a pull request adding the file, exactly as the dashboard does, and the
agent goes live when that merges — thereafter the file is what changes it, and
`config edit` is refused. `config link` moves an API-owned agent into a
repository (by pull request; it keeps running unchanged until the merge) and
`config unlink` takes one back from its file, leaving the file in place, inert.

Platform and integrations:

```sh
agent variable set NPM_TOKEN=...             # or --from-file .env; values are write-only
agent variable list                          # names and timestamps only
agent integration                            # what is connected, in one table
agent github repos                           # also github members, slack channels,
                                             # linear teams, sentry orgs
agent file upload shot.png                   # store a PNG, print an org-gated link
```

Most singular commands accept the plural spelling as a hidden alias, and
`review` also answers to `cr`. `agent --help` and `agent <command> --help` are
authoritative for flags.

## Writing a config

Top-level keys, all optional except `ellipsis`:

| Key | Purpose |
| --- | --- |
| `ellipsis` | `version: v1`, `name`, `description`, `metadata`, and the `enabled`, `interactive`, `ide` flags. Its presence marks the file as a config. |
| `claude` | `system`, `model`, `effort`, `fallback_model`, `max_turns`, `settings`. |
| `codex` | Run on OpenAI's Codex CLI instead. Declaring the block selects the harness. |
| `trigger` | One trigger, or omit for a manual-only agent. |
| `environment` | Where the agent runs: `repositories`, `variables`, `ports`, `compute`, `image`, `hooks`. |
| `permissions` | What it may do: `github` scopes its GitHub token, `ellipsis` its API token. |
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
- `claude.model` defaults to `claude-opus-5`. Claude, GPT, and GLM models are
  available, and `agent model list` is the authoritative list of ids. Digest and
  summary jobs run well on `claude-haiku-4-5-20251001`; judgment jobs earn the
  frontier model.
- `budget.session` defaults to $250, which is also the platform maximum, so it
  can only be lowered. `day`, `week`, and `month` are trailing 1, 7, and 28 day
  caps on this agent, with ceilings of $1,000, $10,000, and $40,000. A session
  that reaches a cap stops mid-task and records `budget_hit`, which is a distinct
  exit status from an error. Accounts also have their own trailing caps, plus
  opt-in per-developer caps.
- `structured_output` makes an agent a function with a contract: it exits through
  your JSON Schema, so downstream automation gets typed data instead of prose to
  parse. Schema failures exit loudly as `tool_call_failed`. It does not go
  together with a mention trigger.
- `ellipsis.interactive: false` opts sessions out of messages entirely, for
  fire-and-forget automations. `ellipsis.ide: false` locks the sandbox shut.

Validation surfaces on push to the default branch, on config pull requests, in
the dashboard editor, and at session start for checks that need the session's
own commit. Session-start failures record an exit status that names the cause:
`lifecycle_hook_failed`, `missing_repo_access`, `missing_token_permissions`,
`missing_sandbox_variables`, `tool_call_failed`, `budget_hit`.

## Sandboxes, secrets, and permissions

Every session runs in its own Linux sandbox, created for that session with its
repositories already cloned and destroyed when the session ends. The base image
carries Python 3.13, Node.js 22, `git`, the `gh` CLI, `curl`, and a C/C++
toolchain. Your agents can build and test your product, not just read it.

Three `environment` fields define the sandbox, each with a different lifetime:

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
image definition, so repeat sessions start in seconds instead of reinstalling
dependencies. `agent session start --config-file <path> --rebuild --watch`
provisions through a fresh full build and streams every phase, which is how you
prove an environment before merging.

`environment.compute` sizes the machine: `cpu` 0.125 to 16, `memory` 512MB to 64GB,
`timeout` 60s to 1h. Defaults are 1 vCPU, 4GB, and 1h. One hour is also the
maximum, because a sandbox never outlives its GitHub token. Compute bills on the
requested allocation over the sandbox's lifetime, so size up only when the
workload needs it.

Credentials are scoped and short-lived:

- Each sandbox gets its own `GH_TOKEN`, minted from the GitHub App installation,
  living one hour, covering only the sandbox's repositories, and dying with the
  sandbox. `permissions.github.permissions` narrows it further, either the string
  `read_only` (read on contents, issues, metadata, pull requests) or a map such
  as `{contents: read, pull_requests: write}`. GitHub mints the reduced token, so
  nothing in the sandbox can exceed it, not a misbehaving tool and not a prompt
  injection in a pull request description. `permissions.github.repositories` narrows
  which repositories the token may touch, independently of what is cloned.
  Because permissions are YAML in git, every agent's blast radius is explicit
  and reviewed.
- Other credentials enter as `environment.variables`. Store the value once with
  `agent variable set`, then name it in the config. The name list is the scope,
  so only agents that name a variable receive it, and a compromised agent never
  sees the inventory. Stored values are write-only and never readable back
  through the dashboard, API, or CLI, so rotation is one update in one place. An
  inline `value:` is for non-secret settings only.
- Model calls route through Ellipsis with a per-session key. A real provider key
  never enters a sandbox. You can bring your own Anthropic key so token spend
  lands on your own account, or route an agent through your own LLM gateway with
  `llm.proxy`.

Session logs are not redacted: they record whatever setup scripts and the agent
print, so keep `image.setup` and hooks from echoing a value.

## Sessions you can audit

Every session outlives its sandbox, which is what makes agent work reviewable
rather than a black box.

- The live feed interleaves the agent's own output with lifecycle events, and
  streams with lossless resume, so you can watch an agent work and catch a wrong
  turn before it compounds.
- Every turn and tool call is recorded, with the config version it ran and the
  exact instructions it launched with, so "what did the agent do" and "what was
  the agent told" are both reads rather than reconstructions.
- The complete log downloads as archived segments, so audit and compliance get
  first-party records. Retention is configurable.
- Every session is attributed to a person, an API key, or the parent session
  that spawned it, which is what per-developer spend limits and author search
  hang off.
- Screenshots persist past the sandbox as organization-gated links, so agents
  attach evidence to pull requests that outlives the session.
- Analytics split every metric by human and bot, so agent contribution is
  measured next to your team's, over the same merge funnel and time-to-merge.

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
shared skills repository serves every agent in an organization, so rolling out
new expertise is one commit instead of the same guidance pasted into a dozen
prompts. The skill installs under the last segment of `path`, and a
config-declared skill overrides a same-named repository skill. At most 10 entries
per config, each at most 50 files, 512 KiB total, 64 KiB per file, UTF-8 text. A
skill that cannot be resolved fails the session before the agent starts, so a
session never runs with a silently missing skill.

This skill is installable in any coding agent:

```sh
npx skills add ellipsis-dev/cli
```

## Inside an Ellipsis sandbox

If `ELLIPSIS_SANDBOX_ID` is set in the environment, you are the agent in an
Ellipsis session. The `agent` CLI is pre-installed and pre-authenticated with a
session-scoped token, so you can start child sessions, search the team's session
history, read analytics, and upload screenshots as org-gated links
(`agent file upload shot.png`) with no login. `agent session connect` with no
id connects to the current session, via `ELLIPSIS_SESSION_ID`.

That token is deliberately narrower than a human's. It can list variable names
but not set or delete them, cannot delete a file, and cannot repoint an
account or repository default. An agent cannot overwrite the team's credentials
or destroy the evidence it posted.

## Docs

Everything above in depth at https://www.ellipsis.dev/docs. The agent-readable
index is https://www.ellipsis.dev/llms.txt, and https://www.ellipsis.dev/llms-full.txt
is every page in one file.

- Agents as code: https://www.ellipsis.dev/docs/agents-as-code
- Cloud Agents: https://www.ellipsis.dev/docs/cloud-agents
- Quick start: https://www.ellipsis.dev/docs/cloud-agents/quick-start
- Agent config reference: https://www.ellipsis.dev/docs/cloud-agents/configuration-yaml
- Triggers: https://www.ellipsis.dev/docs/cloud-agents/triggers
- Sandboxes: https://www.ellipsis.dev/docs/cloud-agents/sandboxes
- Permissions: https://www.ellipsis.dev/docs/cloud-agents/permissions
- Conversations: https://www.ellipsis.dev/docs/cloud-agents/conversations
- Skills: https://www.ellipsis.dev/docs/cloud-agents/skills
- Code review: https://www.ellipsis.dev/docs/code-review
- Review pipeline reference: https://www.ellipsis.dev/docs/code-review/configuration-yaml
- Which PRs get reviewed: https://www.ellipsis.dev/docs/code-review/which-prs-get-reviewed
- CLI reference: https://www.ellipsis.dev/docs/cli
- REST API reference: https://www.ellipsis.dev/docs/api
- Models: https://www.ellipsis.dev/docs/models
- Billing and spend limits: https://www.ellipsis.dev/docs/billing
- Security: https://www.ellipsis.dev/docs/security
