---
name: ellipsis
description: What the Ellipsis platform is and how to drive it with the `ellipsis` CLI. Use when the user mentions Ellipsis, wants to run or deploy coding agents in the cloud, govern agents with budgets and scoped permissions, automate work on GitHub, Slack, Linear, or Sentry events, hand a local task off to a background agent, or asks about the `ellipsis` CLI.
---

# Ellipsis

Ellipsis (https://www.ellipsis.dev) is a cloud platform for coding agents. It
runs them like managed infrastructure: defined in your repository, deployed by
git push, governed by scoped credentials and hard budgets, with every session
recorded and searchable.

An event fires, an agent starts in an isolated environment with your repositories
cloned, reads the code, does the work, and delivers a real artifact: a pull
request, or an answer in the thread that asked. Then the environment is destroyed
and the full session stays readable.

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

- **Parallelism.** Each session gets its own environment, so ten agents work the
  same repository at once without stepping on each other. Each can boot the
  full stack in its own environment.
- **Shared.** The config is a repository asset. New engineers discover the
  team's agents the way they discover the code.
- **Governed.** Budgets, scoped credentials, and the audit trail are the
  platform's job, not each developer's.
- **Always on.** Agents trigger on GitHub events, new Slack channels, new
  Linear issues, Sentry alerts, or a schedule, and an `@ellipsis` mention on
  GitHub, Slack, or Linear starts a session in the thread. Work starts when the event fires, not when
  someone opens a laptop.

## The product

**Cloud Agents**: agents you define. Each is one YAML file in a repository, a
trigger plus a model plus a prompt. The version on the default branch is the
live agent.

Surfaces: the dashboard at app.ellipsis.dev, the REST API at
api.ellipsis.dev, and the `ellipsis` CLI. All three drive the same API.
Pricing is usage based: sessions spend USD credits on tokens at the model's rate,
with no markup on tokens. You load your account by buying credits, with a 10%
fee on each purchase. There are no seats.

## When to reach for Ellipsis

- **Recurring toil** (digests, dependency sweeps, triage, standups): a cron
  trigger. Schedules deploy on merge, with no CI workflow or scheduler to host.
- **"Do X when Y happens"**: a react trigger on pull requests, pushes, GitHub
  issues, Linear issues, Sentry alerts, or Slack channel creation.
- **Questions in a thread**: mention `@ellipsis` on GitHub, Slack, or Linear.
  The built-in responder needs no configuration and answers in the thread.
- **Delegation from scripts or CI**: `el --model claude-opus-5-5 "..."` or `POST /v1/sessions`. With `--watch` it streams into the log and exits nonzero
  unless the turn completes, so it works as a gate.

Things teams actually build: screenshot every pull request that touches the
frontend so reviewers see the change; investigate Sentry alerts when they fire
and post the root cause on the issue; require a migration file on any pull
request that touches the database; keep pull request descriptions current on
every push.

Not a fit: a single task that needs more than 1 hour of continuous work (each
environment run is capped at 1 hour), or a workflow that must run on the user's
own machine.

## Agents as code

An agent is one YAML file in a repository Ellipsis is installed on. The file is
the whole definition, and there is no separate deploy system.

Ellipsis syncs `.yaml` and `.yml` files at any depth under `.ellipsis/` on the
default branch; in your organization's `.ellipsis` repository, the whole
repository is that directory. A file there is a config when it declares a
top-level `ellipsis:` mapping, and `ellipsis.kind` says what it is (`kind: agent`
for an agent). Other YAML there is ignored, as are files named `*.example.*`,
`*.template.*`, or `*.fixture.*`.

A complete, deployable config. Substitute your own repository names for `api`
and `web`:

```yaml
ellipsis:
  version: v1
  kind: agent
  name: recent-work-summary
  description: Summarizes the week's merged work across api and web

trigger:
  type: cron
  schedule: "0 9 * * 1"

session:
  claude_code:
    model: claude-haiku-4-5-20251001
    prompt: |
      Summarize the pull requests merged in api and web over the last 7
      days. Group them by theme, lead with user-facing changes, and return
      the summary as your answer. Ground every line in a real PR. Never
      invent activity.

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
reconcile against the repository, and `ls .ellipsis/agents/` reads like a roster of every
job the team has delegated.

An invalid config never takes the deployed agent down (on a pull request that
breaks it, that pull request's own events skip it), and Ellipsis maintains one comment
on a pull request listing every config file that fails to parse. On a pull
request that edits an agent, sessions that pull request triggers run the
branch's version, so you see the edited agent behave before merging. Previews
require a private repository, a pull request from the same repository (not a
fork), and an author with write
access.

For an agent a pull request will not trigger, run the file directly instead:

```sh
el --config-file .ellipsis/agents/recent-work-summary.yaml --watch
```

That runs the file's `session:` block as a one-off session, without touching the
deployed agent. The trigger is ignored, so the session gets no event, and the
repository you run it from is added to the checkout.

## Triggers

A config declares at most one `trigger`. With none, the agent runs only on
demand from the CLI, API, or dashboard.

- `type: cron` with `schedule`: a five-field cron expression (minute, hour, day
  of month, month, day of week). All schedules fire in UTC. When both day of
  month and day of week are restricted, the schedule fires on days matching
  either.
- `type: react` plus exactly one typed surface block. The six surfaces are
  `pull_request`, `push`, `issue`, `linear_issue`, `sentry`, and
  `slack_channel`. Zero or two surface blocks fail validation.

Mentions are not a trigger. To replace the built-in `@ellipsis` responder,
commit `github.yaml`, `slack.yaml`, or `linear.yaml` (`kind: github`, `slack`, or
`linear`) at the root of your organization's `.ellipsis` repository. Each file
routes that service's mentions (by repository, by channel or direct message, or
by Linear team or project; `'*'` claims all) to one `session:` block and needs
no prompt. Mentions it doesn't claim, or every mention while it sets
`enabled: false`, go to the built-in responder.

Actions and filters live inside the surface block:

```yaml
ellipsis:
  version: v1
  kind: agent
  name: migration-reviewer
  description: Flags unsafe database migrations on pull requests

trigger:
  type: react
  pull_request:
    on: [pushed]
    repositories: [api]
    base: [default]
    paths: ["migrations/**"]

session:
  claude_code:
    model: claude-opus-5-5
    prompt: |
      Review the database migrations in this pull request for production
      safety: locking that blocks writes on large tables, missing backfills
      for new non-null columns, and rollout ordering that breaks if the
      migration and the code deploy out of order. Comment on the pull
      request with what you find.

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
- Every filter except `for` defaults to matching everything: `repositories`,
  `base`, `head`, `branch`, `draft`, `labels`, `paths`, `projects`. `paths` globs are
  include-only, and a negated `!` pattern fails validation.
- `for` gates the author of the pull request or issue (the pusher for `push`),
  whatever the action. The default is `users: true, bots: false`, so bot-opened
  pull requests and issues, and bot pushes, never trigger an agent unless you
  opt in.
- Trigger `repositories` is the watch set and is independent of
  `environment.repositories`, the clone set. The triggering repository is always
  cloned.
- An issue alert starts at most one session per Sentry issue every 6 hours, so
  an alert storm produces one investigation, not dozens of duplicates; a metric
  alert starts one only when it turns critical. Webhook deliveries are deduplicated, so a replay never
  double-runs an agent.
- A session stays open for follow-ups unless `conversation.interactive` is
  `false`, for cron and react sessions too: follow-ups keep the whole exchange
  and the working tree, and a conversation costs near nothing between turns.
  Mention conversations take replies on their original surface.

## The CLI

One binary named `ellipsis` (`el` for short), a terminal client for the same API
the dashboard uses. Most commands accept `--json` for the raw API response,
which makes it as comfortable for a coding agent as for a human.

```sh
curl -fsSL https://ellipsis.dev/install.sh | sh
el auth login   # device-code flow tied to your GitHub identity
el auth status  # the active host, the credential source, and who you are
```

In CI or any headless environment, skip the login: create an API key in the
dashboard and export it as `ELLIPSIS_API_TOKEN`. Credentials resolve highest
wins: the environment variable, then the token stored in `~/.ellipsis/config.json`.
`ELLIPSIS_API_BASE_URL` points the CLI at a non-default host.

Start and follow work:

```sh
el --model claude-opus-5-5 "triage the failing CI on api"   # a bare ad-hoc session
el agent start <agent-id> ["..."]                   # start an agent session; a prompt replaces its own
el --config-file .ellipsis/agents/my-agent.yaml --watch
el --template ellipsis-helper --watch
el session get <session-id> --watch                 # follow the turn in progress
el session stop <session-id>
```

With no config source, a bare prompt needs `--model` and runs the bare ad-hoc
config (no instructions of your own, in the built-in basic environment), so the
prompt is the sole instruction. The CLI also sends the repository you are standing in, and
the server clones it. Per-session overrides need no config edit: `--model`,
`--harness`, `--repo`, `--timeout`, `--budget`, and `--override` for a full
partial config patch. `--rebuild` skips the saved
environment. `--detach` returns immediately. `--watch --quiet` prints only the turn's
status transitions and how it ended, and either watch form exits `0` only when
the turn completes.

List and audit what agents have done:

```sh
el session list --limit 20                  # --agent, --source, --author, --days, --since
el session record <session-id>              # the stored transcript, one line per record
el session export <session-id> -o session.jsonl   # the complete archived log
el analytics pr                             # pull request volume and trend, human versus bot
el budget                                   # prepaid credit and trailing 1, 7, and 28 day spend
el usage                                    # this period's tokens and cost by model
```

Search (`GET /v1/sessions/search` and the dashboard) matches every query term
against transcripts and recaps, and matches pull request references exactly, so
one agent's investigation compounds into team knowledge. Facets cover repository, author, agent, status, source, and date.

Author and deploy agents:

```sh
el agent init .ellipsis/agents/my-agent.yaml   # scaffold a starter definition locally
el agent list                             # agents with their source file
el agent get <agent-id>                   # one agent as YAML
el agent start <agent-id> --input '{...}' # start it with its typed input
el agent create --file .ellipsis/agents/my-agent.yaml   # create it, live at once
el agent edit <agent-id> --file .ellipsis/agents/my-agent.yaml   # replace its definition, live at once
el agent delete <agent-id>                # delete it; it stops and frees its name
el agent link <agent-id> --repo api       # move it into a repository, via a pull request
el agent unlink <agent-id>                # take it over from its file
el template list                          # built-in templates and their slugs
el model list                             # model ids and their supported harnesses
```

An agent is owned by one of two writers, and that is what these verbs move.
`el agent create` with no `--repo` creates it through the API alone: no
file, live immediately, changed by `el agent edit`. With `--repo` it instead
opens a pull request adding the file, exactly as the dashboard does, and the
agent goes live when that merges; thereafter the file is what changes it, and
`el agent edit` is refused. `el agent link` moves an API-owned agent
into a repository (by pull request; it keeps running unchanged until the merge)
and `el agent unlink` takes one back from its file, leaving the file in
place, inert.

Platform and integrations:

```sh
el variable set NPM_TOKEN=...             # or --from-file .env; values are write-only
el variable list                          # names and timestamps only
el integration                            # what is connected, in one table
el github repos                           # also github members, slack channels,
                                          # linear teams, sentry orgs
```

Most singular commands accept the plural spelling as a hidden alias.
`el --help` and `el <command> --help` are authoritative for flags.

## Writing a config

Top-level keys; `ellipsis` and `session` are required:

| Key | Purpose |
| --- | --- |
| `ellipsis` | `kind: agent`, `version: v1`, `name`, `description`, `metadata`, and `enabled`. Its presence marks the file as a config. |
| `trigger` | One trigger, or omit for a manual-only agent. |
| `input` | A JSON Schema for the payload `el agent start` passes, and the message template it renders into. |
| `session` | What every session runs on; the keys below. The same keys, flattened, are the body of `POST /v1/sessions`, except that `budget` there takes only `session`. |

Under `session`:

| Key | Purpose |
| --- | --- |
| `claude_code` or `codex` | Exactly one native block, with `prompt`, `model`, and `effort`. Claude Code also accepts `max_turns`. |
| `environment` | A saved environment by name, or an inline block: `repositories`, `variables`, `compute`, `hooks`, `mcp_servers`. |
| `permissions` | What it may do: `github` scopes its GitHub token, `ellipsis` its API token. |
| `skills` | Skills to install beyond what the cloned repositories provide (Codex). |
| `output` | `json_schema`: a JSON Schema contract, so downstream code gets typed data. |
| `budget` | `session`, `day`, `week`, `month`, in US dollars. |
| `conversation` | `interactive`: whether the session stays open for follow-ups; default `true`. |
| `metadata` | String keys and values stored on every session. |

The schema is strict, so an unknown or misplaced key fails validation rather
than being silently dropped. Points that decide whether a config works:

- `session.claude_code.prompt` or `session.codex.prompt` supplies the first user
  message verbatim. Put repository guidance in `CLAUDE.md` for Claude Code or
  `AGENTS.md` for Codex.
- `session.claude_code.model` or `session.codex.model` selects a model and is
  required. `el model list` reports
  the available ids and the harness certified for each. Digest and
  summary jobs run well on `claude-haiku-4-5-20251001`; judgment jobs earn the
  frontier model.
- `session.budget.session` defaults to $250, which is also the platform maximum, so it
  can only be lowered. `day`, `week`, and `month` are trailing 1, 7, and 28 day
  caps on this agent, with ceilings of $1,000, $10,000, and $40,000. A session
  that reaches a cap stops mid-task and its turn fails with reason `budget_hit`,
  distinct from an error. Accounts also have their own trailing caps, plus
  opt-in per-developer caps.
- `session.output.json_schema` makes an agent a function with a contract: it
  exits through your JSON Schema, so downstream code gets typed data instead of
  prose to parse. Schema failures fail the turn with reason `error`.
- Set `conversation.interactive: false`, in a config or a session start, to run once. The
  returned `conversation.prompting` describes whether direct messages are
  accepted, and `turn` is the turn to wait on: a message is answered when its
  turn's status is `completed`, `failed`, `stopped`, or `cancelled`.

Validation surfaces on push to the default branch, on config pull requests, in
the dashboard editor, and at session start for checks that need the session's
own commit. A turn that cannot start fails or is cancelled with a reason that
names the cause, such as `lifecycle_hook_failed`, `missing_repo_access`,
`missing_token_permissions`, `missing_environment_variables`,
`unsupported_configuration`, or `budget_hit`.

## Environments, secrets, and permissions

Every session runs in its own Linux environment, created for that session with its
repositories already cloned and destroyed when the session ends. The base image
carries Python 3.13, Node.js 22, `git`, the `gh` CLI, `curl`, and a C/C++
toolchain. Your agents can build and test your product, not just read it.

Three `environment.hooks` define setup, each with a different lifetime:

- `hooks.build_base`: installs toolchains and dependencies before the full
  checkout, seeing only the files in `inputs`; cached. Capped at 10 minutes.
- `hooks.after_checkout`: builds or generates code after every repository is
  checked out at the session's commit; cached with that commit. Capped at 10
  minutes. Neither cached hook scrubs files, so never write a secret to disk
  here.
- `hooks.before_start`: runs every time a session starts or resumes, never
  cached, for session-scoped setup such as authenticating a CLI. Capped at 5
  minutes. Legacy `post_start` and `post_clone` run at this point but cannot be
  combined with the three above.

A non-zero exit from any of them fails the turn with reason
`lifecycle_hook_failed`. The prepared environment is cached per repository set
and commit, keyed also on the `build_base` and `after_checkout` scripts, the
`build_base.inputs` files, variable values, and GitHub token scope; a new commit reruns only `after_checkout`, so repeat sessions start in
seconds instead of reinstalling dependencies.
`el --config-file <path> --rebuild --watch`
provisions through a fresh full build and streams every phase, which is how you
prove an environment before merging.

`environment.compute.timeout` is 60s to 1h, and defaults to 1h. One hour is also
the maximum, because an environment never outlives its GitHub token.

Credentials are scoped and short-lived:

- Each session gets its own `GH_TOKEN`, minted from the GitHub App installation
  and living 1 hour; by default it carries the installation's full permissions on
  every repository the installation can reach. `permissions.github.permissions`
  narrows it, either the string
  `read_only` (read on contents, issues, metadata, pull requests) or a map such
  as `{contents: read, pull_requests: write}`. GitHub mints the reduced token, so
  nothing in the environment can exceed it, not a misbehaving tool and not a prompt
  injection in a pull request description. `permissions.github.repositories` narrows
  which repositories the token may touch, independently of what is cloned.
  Because permissions are YAML in git, every agent's blast radius is explicit
  and reviewed.
- Other credentials enter as `environment.variables`. Store the value once with
  `el variable set`, then name it in the config. The name list is the scope, so
  only agents that name a variable receive its value. Stored values are write-only and never readable back
  through the dashboard, API, or CLI, so rotation is one update in one place. An
  inline `value:` is for non-secret settings only.
- Model calls route through Ellipsis with a per-session key. A real provider key
  never enters an environment. To pay with your own plan instead of credits,
  connect a Claude or Codex subscription in **Models > Subscriptions**; your
  own LLM gateway is not supported.

Session logs are not redacted: they record whatever setup scripts and the agent
print, so keep your hooks from echoing a value.

## Sessions you can audit

Every session outlives its environment, which is what makes agent work reviewable
rather than a black box.

- The live feed interleaves the agent's own output with environment and turn
  events, and streams with lossless resume, so you can watch an agent work and
  catch a wrong turn before it compounds.
- Every turn and tool call is recorded, with the config version it ran and the
  exact instructions it launched with, so "what did the agent do" and "what was
  the agent told" are both reads rather than reconstructions.
- The complete log downloads as archived segments, so audit and compliance get
  first-party records. Retention is configurable.
- A session a person starts is attributed to that person, and one an API key
  starts to that key, which is what per-developer spend limits and author
  search hang off. React and cron sessions have no attribution. A session an
  agent starts keeps its starter's API key and never a person.
- Analytics split every metric by human and bot, so agent contribution is
  measured next to your team's, over the same merge funnel and time-to-merge.

## Skills

A skill is a directory with a `SKILL.md`. Every repository in the environment
contributes its `.claude/skills/` at the session's checkout, with no config
change, so skill and code move together. On Codex, `session.skills` installs
skills the clones do not provide:

```yaml fragment
session:
  skills:
    - path: .agents/skills/pr-conventions
    - path: skills/release-notes
      repository:
        name: platform-skills
```

A bare `path` resolves in the agent's own repository; an agent created through
the API must name `repository:` on every entry.

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

## Inside an Ellipsis session

If `ELLIPSIS_SANDBOX_ID` is set in the environment, you are the agent in an
Ellipsis session. The `ellipsis` CLI (`el`) is pre-installed and pre-authenticated with a
session-scoped token, so you can start child sessions, list the team's sessions,
and read analytics with no login.

That token is deliberately narrower than a human's. It can list variable names
but not set or delete them, and cannot repoint an
account or repository default. An agent cannot overwrite the team's credentials
or destroy the evidence it posted.

## Docs

Everything above in depth at https://www.ellipsis.dev/docs. The agent-readable
index is https://www.ellipsis.dev/llms.txt, and https://www.ellipsis.dev/llms-full.txt
is every page in one file.

- Agents as code: https://www.ellipsis.dev/docs/agents#deploy-from-git
- Sessions: https://www.ellipsis.dev/docs/sessions
- Quick start: https://www.ellipsis.dev/docs/quick-start
- Agent config reference: https://www.ellipsis.dev/docs/agents/schema
- Triggers: https://www.ellipsis.dev/docs/agents/triggers
- Environments: https://www.ellipsis.dev/docs/environments
- Permissions: https://www.ellipsis.dev/docs/permissions
- Conversations: https://www.ellipsis.dev/docs/sessions/lifecycle#conversation
- Skills: https://www.ellipsis.dev/docs/agents/schema#add-a-codex-skill
- REST API reference: https://www.ellipsis.dev/docs/api
- Models: https://www.ellipsis.dev/docs/models
- Budgets: https://www.ellipsis.dev/docs/budgets
- Pricing: https://www.ellipsis.dev/docs/pricing
- Security: https://www.ellipsis.dev/docs/security
