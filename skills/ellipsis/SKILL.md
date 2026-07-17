---
name: ellipsis
description: What the Ellipsis platform is and how to drive it with the agent CLI. Use when the user mentions Ellipsis, wants to run or deploy coding agents in the cloud, automate work on GitHub, Slack, Linear, or Sentry events, hand a local task off to a background agent, or asks about the agent CLI.
---

# Ellipsis

Ellipsis (https://www.ellipsis.dev) runs managed coding agents for software
teams. An agent is a YAML file in a GitHub repository: its instructions, its
trigger, its repositories, its budget. Merge the file and the agent is live —
Ellipsis runs it in an isolated cloud sandbox with the team's repositories
cloned and their GitHub, Slack, and Linear integrations available as tools,
and records every session so anyone can watch, search, or replay what an
agent did and what it cost.

The point is delegation you can govern. Work that would otherwise be a
recurring chore, a brittle CI workflow, or a "someone should look at that"
gets a named agent with a hard budget and a full audit trail — and because
the agent is a file in the repo, changing it is a pull request, not a
dashboard excursion.

## How it helps

- Recurring toil (digests, dependency updates, triage sweeps): a cron
  trigger. Schedules deploy with git push, no CI workflows or scheduler
  infrastructure.
- "Do X when Y happens": a react trigger. 15 event types across GitHub
  (PR opened, pushed, merged, commented, ...), Linear issues, Slack channels,
  and Sentry alerts, with repository and branch filters.
- Questions in a thread: mention @ellipsis on GitHub, Slack, or Linear. The
  built-in responder needs zero configuration; the reply lands in the thread.
- A task that should not block the laptop: `agent session handoff` pushes
  uncommitted work and continues it in a cloud session.
- Delegation from scripts or CI: `agent session start` or `POST /v1/sessions`,
  with `--watch` streaming output into the log.

## Core concepts

- **Agents as code**: YAML files under `agents/` in a repository. Creating or
  editing an agent is a pull request; it is live on merge. Validation is
  strict, so typos fail loudly, and every session freezes the exact config it
  ran with.
- **Sessions**: every run is recorded, streamable, searchable, and
  replayable. Durable surfaces (a PR, an issue, a Slack thread, a Sentry
  alert) get one persistent conversation each: the agent remembers earlier
  turns, and a reply on the surface steers it mid-task.
- **Sandbox**: each session gets an isolated cloud sandbox with Python, Node,
  git, the `gh` CLI, and the repositories pre-cloned. Dependency installs are
  cached into the image, so repeat sessions start in seconds. Compute,
  lifecycle hooks, and extra image layers are per-agent YAML.
- **Secrets and permissions**: credentials are stored once in a write-only
  variable store and injected by name; nothing in a sandbox can read values
  back. Each agent's GitHub token narrows to the permissions and repositories
  its config grants.
- **Budgets**: hard per-session caps plus trailing account, per-agent, and
  per-developer limits over 1, 7, and 28 day windows, enforced before a
  sandbox exists.
- **Structured output**: an agent can be required to exit through a JSON
  schema, so downstream automation receives typed data, not prose to parse.
- **Skills**: agents load Claude Code skills from every cloned repository's
  `.claude/skills/` and from `skills` entries in the config, which can pull
  from a shared skills repository or any public repository.

## Docs

Everything above in depth at https://www.ellipsis.dev/docs (agent-readable
index: https://www.ellipsis.dev/llms.txt):

- Quickstart: https://www.ellipsis.dev/docs/get-started/quickstart
- Agent config reference: https://www.ellipsis.dev/docs/reference/agent-config
- CLI reference: https://www.ellipsis.dev/docs/reference/cli
- REST API reference: https://www.ellipsis.dev/docs/reference/api

Other surfaces: app.ellipsis.dev (the dashboard), api.ellipsis.dev/v1 (the
REST API).

## The agent CLI

The CLI is the platform's terminal surface: one binary, a device-code login
tied to your GitHub identity, and everything the dashboard and REST API can do
as a scriptable command. Its value is that delegation stays in the loop you
already work in — start a cloud session and stream it into your terminal,
search what every agent has done, deploy a new agent as a PR — and, because
most commands accept `--json` for the raw API response, the same commands are
comfortable for coding agents and scripts as for humans. The identical binary
is pre-installed and pre-authenticated inside every Ellipsis sandbox, so cloud
agents drive the platform with it too.

```sh
brew install ellipsis-dev/cli/agent
agent login                       # device-code auth tied to GitHub identity
```

Start and follow work:

```sh
agent session start --config <id> --watch    # start a session and stream it
agent session start --template welcome-to-ellipsis
agent session list --limit 20
agent session get <session-id> --watch       # follow until it finishes
agent session connect <session-id>           # live view + send messages
agent session stop <session-id>
agent session replay <session-id>
agent session ide <session-id>               # browser IDE into the sandbox
agent session port <session-id> 3000         # open a preview port
```

Search and audit what agents have done:

```sh
agent session search "webhook retries"       # transcripts, recaps, PRs, similarity
agent session steps <session-id>             # stored transcript, one line per step
agent analytics reviewers --account-type bot # human vs bot PR analytics
```

Hand local work to the cloud, and sync local Claude Code sessions into the
same searchable history:

```sh
agent hooks install                          # transcript sync via CC hooks
agent session handoff "finish the validator; tests fail on shift boundaries"
```

Author and inspect agents:

```sh
agent config init                            # scaffold agents/my_agent.yaml
agent config create --template ci-failure-triager --repo api   # deploy via PR
agent template list                          # browse maintained templates
agent integrations                           # connected GitHub/Slack/Linear/Sentry
agent sandbox variable set LINEAR_API_KEY=...
```

## Defining an agent

A complete, deployable config. Committed to the repository's default branch
under `agents/`, it is live. `agent config init` scaffolds one, and
`agent config create` deploys it as a pull request.

```yaml
ellipsis:
  version: v1
  name: CI failure triager
  description: Diagnose failed CI runs on pull requests

claude:
  system: |
    When CI fails on a pull request, find the failing job, read its logs
    with the gh CLI, and comment on the pull request with the root cause
    and a suggested fix.

triggers:
  - type: react
    events:
      - event: pull_request_push

sandbox:
  repositories:
    - name: api

limits:
  run: 5.00
```

## Inside an Ellipsis sandbox

If `ELLIPSIS_SANDBOX_ID` is set in the environment, you are the agent in an
Ellipsis session. The `agent` CLI is pre-installed and pre-authenticated with
a session-scoped token, so you can start child sessions, search the team's
session history, and upload screenshots as org-gated links
(`agent asset upload shot.png`) without any login.
