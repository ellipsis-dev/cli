import type { AgentSession, StartAgentSessionRequest } from './types'

// Pure session helpers shared by the session commands. No I/O here.

// Both REST sessions and start requests carry the prompt in the selected harness.
export function withSessionPrompt(req: StartAgentSessionRequest, prompt: string): StartAgentSessionRequest {
  return req.codex
    ? { ...req, codex: { ...req.codex, prompt } }
    : { ...req, claude_code: { ...req.claude_code, prompt } }
}

// The agent identity to show for a session: the automation's own name, else
// the id of the automation it was started from. Both are absent for raw
// sessions, which have nothing to name.
export function sessionConfigName(session: AgentSession): string | null {
  const automation = session.agent
  if (!automation) return null
  return automation.config.ellipsis.name ?? automation.id ?? null
}

// --------------------------- start request shaping -------------------------
// POST /v1/sessions is flat: the request IS a SessionConfig plus run settings
// (there is no base config and no merge; a saved automation is invoked with
// POST /v1/agents/{id}/sessions instead).

// Parse a repository value into an environment.repositories entry.
// "owner/name" sets both; a bare "name" omits owner so the server defaults it
// to the account.
export function parseRepo(value: string): { name: string; owner?: string } {
  const parts = value.split('/')
  if (parts.length === 1 && parts[0]) return { name: parts[0] }
  if (parts.length === 2 && parts[0] && parts[1]) return { owner: parts[0], name: parts[1] }
  throw new Error(`a repository must be "name" or "owner/name", got "${value}"`)
}

// The SessionConfig keys POST /v1/sessions accepts. An automation file nests
// them under `session:`; its other keys have no request-side equivalent —
// `trigger` and `input` (the contract, not the payload) describe an
// automation, and the `ellipsis:` block carries a name/enabled the request
// refuses — so they are dropped rather than sent to a 422. `budget` is a
// dollar number on the request where the file has a `budget.session`, so it
// is lifted.
const START_CONFIG_KEYS = [
  'claude_code',
  'codex',
  'environment',
  'output',
  'permissions',
  'skills',
] as const

export function assertCurrentHarnessKeys(config: Record<string, unknown>): void {
  if ('claude' in config || 'harness' in config || 'instructions' in config || 'prompt' in config) {
    throw new Error('use claude_code: {prompt: ...} or codex: {prompt: ...}; harness and instructions are no longer supported')
  }
}

// An inline config file (`session start -f/-t`) as a start request. The file
// is either an automation document (session keys under `session:`, as every
// template and `agent automation init` file is) or a bare session config;
// either way its per-session keys are spread onto the request body.
export function startRequestFromConfig(
  document: Record<string, unknown>,
): StartAgentSessionRequest {
  const nested = document.session
  const config: Record<string, unknown> =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : document
  assertCurrentHarnessKeys(config)
  const selected = [config.claude_code, config.codex].filter((v) => v != null)
  if (selected.length !== 1 || typeof selected[0] !== 'object' || Array.isArray(selected[0])) {
    throw new Error('session config must include exactly one claude_code or codex object')
  }
  const req: Record<string, unknown> = {}
  for (const key of START_CONFIG_KEYS) {
    if (config[key] !== undefined) req[key] = config[key]
  }
  const budget = config.budget
  if (budget && typeof budget === 'object' && !Array.isArray(budget)) {
    const session = (budget as { session?: unknown }).session
    if (typeof session === 'number') req.budget = session
  }
  return req as StartAgentSessionRequest
}

// The request with `repo` ("owner/name" or a bare name) in its top-level
// `repositories` key, added only when absent. That key is additive on the
// server: each entry joins the resolved environment's checkouts when it is not
// already there, whatever the environment (named, inline, or the default). The
// environment block itself is never touched — an environment OBJECT is the
// whole sandbox, so putting the repo there would drop the default.
export function withContextRepository(
  req: StartAgentSessionRequest,
  repo: string,
): StartAgentSessionRequest {
  parseRepo(repo)
  const repositories = req.repositories ?? []
  if (repositories.includes(repo)) return req
  return { ...req, repositories: [...repositories, repo] }
}
