// TypeScript mirror of the backend `/v1` request/response models. These are
// hand-rolled for now and will be replaced by the generated @ellipsis/sdk
// package once it exists. Nested config/input/output payloads are typed loosely
// (the CLI only displays summary fields); the rest mirror the Pydantic models
// in ellipsis/src/public_api/routers/v1/v1_router.py and the shared services.

// ------------------------------- identity -------------------------------

// The GitHub user behind a user_id, when we have it cached. Loosely typed: the
// CLI only reads `login`; the rest of the GithubUser fields are passed through.
export interface GhUser {
  id: number
  login: string
  name: string | null
  [key: string]: unknown
}

export interface WhoAmI {
  customer_id: string
  customer_login: string
  user_id: string | null
  gh_user: GhUser | null
  api_key_id: string | null
  sandbox_id: string | null
}

// ----------------------------- usage / budget ---------------------------

export interface BudgetWindow {
  start: string | null
  end: string | null
}

export interface BudgetSummary {
  period: string
  window: BudgetWindow
  budget_usd: number
  spent_usd: number
  remaining_usd: number
  fraction_used: number
  pause_at_limit: boolean
}

export interface UsageDailyPoint {
  date: string
  tokens: number
  tokens_input: number
  tokens_output: number
  tokens_cache_read: number
  tokens_cache_creation: number
  cost_tokens_millicents: number
  cost_sandbox_cpu_millicents: number
  cost_sandbox_memory_millicents: number
  cost_fee_millicents: number
}

export interface ModelUsageBreakdown {
  model_id: string
  tokens: number
  cost_tokens_millicents: number
  cost_sandbox_cpu_millicents: number
  cost_sandbox_memory_millicents: number
  cost_fee_millicents: number
}

export interface UsageDashboard {
  period_start: string
  period_end: string
  total_tokens: number
  total_cost_millicents: number
  prior_total_tokens: number
  prior_total_cost_millicents: number
  daily: UsageDailyPoint[]
  by_model: ModelUsageBreakdown[]
}

// ----------------------------- agent sessions ----------------------------

export type AgentSessionSource =
  | 'react'
  | 'manual'
  | 'api'
  | 'cli'
  | 'mention'
  | 'cron'
  // A Claude Code session ingested from a developer laptop via `agent session sync`.
  | 'laptop'

export type AgentSessionStatus =
  | 'scheduled'
  | 'creating_sandbox'
  | 'running'
  | 'retrying'
  | 'completed'
  | 'error'
  | 'cancelled'
  | 'stopped'

// Loosely typed: the CLI reads a handful of summary fields and otherwise treats
// the session as opaque JSON. See AgentSession in the backend for the full shape.
export interface AgentSession {
  id: string
  customer_id: string
  created_at: string
  updated_at: string
  status: AgentSessionStatus
  status_reason: string | null
  source?: AgentSessionSource
  agent_config_id: string | null
  cost_tokens: number
  cost_sandbox_cpu: number
  cost_sandbox_memory: number
  cost_fee: number
  tokens_total: number
  metadata: Record<string, string>
  [key: string]: unknown
}

export interface SavedAgentConfig {
  id: string
  customer_id: string
  created_at: string
  updated_at: string
  deleted: boolean
  last_agent_session_id: string | null
  last_agent_session_created_at: string | null
  last_synced_commit_sha: string | null
  last_sync_error: string | null
  agent_config: Record<string, unknown>
  [key: string]: unknown
}

// Inline agent config payload accepted by POST /v1/sessions. Opaque to the
// CLI — passed straight through from a user-supplied JSON file.
export type AgentConfig = Record<string, unknown>

// --------------------------- request / response -------------------------

// Laptop -> cloud handoff params: start a fresh session on the built-in
// handoff config, chained to the handed-off session (parent_kind=handoff).
// Mutually exclusive with config_id / config / template_id.
export interface HandoffAgentSessionParams {
  parent_session_id: string
  repo: string
  // The WIP commit pushed to refs/ellipsis/handoff/<short> — the sandbox
  // checkout target.
  sha: string
  ref?: string
}

export interface StartAgentSessionRequest {
  config_id?: string
  config?: AgentConfig
  template_id?: string
  handoff?: HandoffAgentSessionParams
  // No `source`: the server derives a session's provenance from the credential
  // (a user token => `cli`), so it can't be spoofed by the request body.
  metadata?: Record<string, string>
  // A partial agent config merged onto the chosen config and re-validated
  // server-side, e.g. raise just this session's budget. Supply it as a
  // structured mapping (config_override) or a YAML/JSON string
  // (config_override_yaml) — not both. Only meaningful with config_id/template_id.
  config_override?: Record<string, unknown>
  config_override_yaml?: string
  // Per-session instructions appended to the initial user query at build time,
  // after the config's shared `claude.system` system prompt. Distinct from the
  // system prompt, which is identical for every session of a config.
  prompt?: string
}

// Replay payload for POST /v1/sessions/{id}/replay. Re-runs an existing
// session's trigger input. Reuses the original session's frozen config
// snapshot unless config_id is given. The override fields behave exactly as on
// StartAgentSessionRequest (mapping or string, not both). `prompt` is omitted
// to inherit the original session's prompt, set to "" to clear it.
export interface ReplayAgentSessionRequest {
  config_id?: string
  config_override?: Record<string, unknown>
  config_override_yaml?: string
  prompt?: string
}

// One hook-driven transcript sync from this laptop (POST /v1/sessions/sync).
// The transcript is redacted client-side, gzipped, then base64-encoded.
export interface SyncAgentSessionRequest {
  cc_session_id: string
  transcript_gzip_b64: string
  // Which Claude Code hook fired the sync: Stop (mid-session, once per turn)
  // or SessionEnd (the process terminated).
  reason: 'stop' | 'session_end'
  // The enrolled repository ("owner/name", from the cwd's git remote), the
  // cwd, and the checked-out branch — laptop-side context for the session row.
  repo?: string
  cwd?: string
  git_branch?: string
}

export interface SyncAgentSessionResponse {
  session_id: string
  process_id: string
  event_count: number
  // False when the server already stored a snapshot at least this long
  // (longest-snapshot-wins) — acknowledged, nothing written. Still success.
  accepted: boolean
}

export interface ListAgentSessionsResponse {
  sessions: AgentSession[]
}

export interface ListAgentConfigsResponse {
  configs: SavedAgentConfig[]
}

// Create-config payload for POST /v1/configs. Exactly one of `config` (inline)
// or `template_id` (a gallery template slug). `repository` is a bare repo name
// in the caller's account — the owner is always the account.
export interface CreateAgentConfigRequest {
  config?: AgentConfig
  template_id?: string
  repository: string
  // File path within the repo. Omit for the default agents/<slug>.yaml; if set
  // it must be a location Ellipsis syncs (.yaml/.yml under agents/, .agents/,
  // ellipsis/, or .ellipsis/ at any depth).
  path?: string
}

// Result of creating a config: the pending row plus the pull request that adds
// its YAML file. The agent goes live once that PR merges and syncs.
export interface CreatedAgentConfig {
  config: SavedAgentConfig
  path: string
  pull_request_url: string
}

// A built-in starter template served by GET /v1/templates. `yaml` is the
// schema-valid agent config the CLI writes to disk; the rest is display copy.
export interface AgentTemplate {
  slug: string
  name: string
  description: string
  tags: string[]
  summary: string
  use_case: string
  yaml: string
}

export interface ListAgentTemplatesResponse {
  templates: AgentTemplate[]
  // The verbatim config of the run-on-demand template behind the dashboard's
  // first-run CTA (`recent-work-summary`), served with the gallery so the hero
  // can show the exact agent it starts.
  first_run_yaml: string
}

export interface ListAgentSessionsQuery {
  config_id?: string
  source?: AgentSessionSource[]
  days?: number
  start?: string
  end?: string
  limit?: number
  // A GitHub account id (GET /v1/github/members); scopes the list to sessions
  // attributed to that developer. The CLI resolves it from a --author login.
  author_id?: number
}

// ------------------------------ session steps ----------------------------

// One stored transcript event, from GET /v1/sessions/{id}/steps. Loosely
// typed: `data` is the raw Claude Code stream event (assistant turn, tool
// call, tool result, final result); the CLI only extracts display text.
export interface AgentStep {
  id: string
  created_at: string
  step_index: number
  step_type: string
  step_subtype: string | null
  data: Record<string, unknown>
  [key: string]: unknown
}

export interface ListSessionStepsResponse {
  steps: AgentStep[]
}

// ----------------------------- session search ----------------------------

export type SessionSearchScope = 'steps' | 'recaps' | 'both'

export interface SearchSessionsQuery {
  q: string
  scope?: SessionSearchScope
  source?: AgentSessionSource[]
  author_id?: number[]
  agent_config_id?: string[]
  session_ids?: string[]
  repo?: string
  status?: AgentSessionStatus[]
  start?: string
  end?: string
  limit?: number
}

// One agent step matching the search, denormalized with enough session
// context to render a result row (backend LogSearchHit).
export interface StepSearchHit {
  step_id: string
  agent_session_id: string
  step_index: number
  step_type: string
  step_subtype: string | null
  created_at: string
  snippet: string
  [key: string]: unknown
}

// One search result session. `matched` lists which arms hit:
// "steps" | "recap" | "pr" | "similar".
export interface SessionSearchResult {
  session: AgentSession
  matched: string[]
  recap_snippet: string | null
  step_hits: StepSearchHit[]
  // Total step hits within the search window; may exceed step_hits.length
  // (which the server caps), so "and N more" can render.
  step_hit_count: number
}

// The GITHUB_USER attributions among the results, keyed by attribution_id, so
// the CLI can show author logins without a second lookup.
export interface GithubAccountSnippet {
  id: number
  login: string
  type: string
  avatar_url: string
}

export interface SearchSessionsResponse {
  results: SessionSearchResult[]
  attributed_users: Record<string, GithubAccountSnippet>
}

// -------------------------- integration discovery ------------------------
// Read-only views of what's connected for the account (GET /v1/integrations
// and the per-provider listings). Responses never include secrets.

export interface GithubIntegrationSummary {
  account_login: string
  account_type: string
  repository_selection: 'all' | 'selected'
  suspended: boolean
  repository_count: number
}

export interface SlackIntegrationSummary {
  team_id: string
  team_name: string
  operations_channel_id: string | null
}

export interface LinearTeamSummary {
  id: string
  name: string
  key: string | null
  // Whether Ellipsis is enabled for this team.
  is_enabled: boolean
}

export interface LinearIntegrationSummary {
  organization_id: string
  teams: LinearTeamSummary[]
}

export interface JiraIntegrationSummary {
  cloud_id: string
}

export interface SentryOrganizationSummary {
  integration_id: string
  organization_slug: string
}

// A key is null (or an empty list for sentry) when that integration is not
// connected, so the response always shows the full universe of integrations.
export interface GetIntegrationsResponse {
  github: GithubIntegrationSummary | null
  slack: SlackIntegrationSummary | null
  linear: LinearIntegrationSummary | null
  jira: JiraIntegrationSummary | null
  sentry: SentryOrganizationSummary[]
}

// A repository connected to the installation: a valid `repository` for
// POST /v1/configs and for repository lists in an agent config.
export interface RepositorySummary {
  id: number
  name: string
  full_name: string
  private: boolean
  default_branch: string | null
  description: string | null
}

export interface ListGithubRepositoriesResponse {
  repositories: RepositorySummary[]
}

export interface LinkedSlackIdentity {
  slack_user_id: string
  slack_email: string | null
}

export interface LinkedGithubIdentity {
  id: number
  login: string | null
}

// An org member (or the account itself for a personal customer). `id` is the
// universe of author_id values for session list/search queries.
export interface GithubMemberSummary {
  id: number
  login: string | null
  name: string | null
  avatar_url: string | null
  // null for a personal (user) account, which has no org roles.
  role: string | null
  slack: LinkedSlackIdentity | null
}

export interface ListGithubMembersResponse {
  members: GithubMemberSummary[]
}

export interface SlackMemberSummary {
  id: string
  name: string | null
  real_name: string | null
  display_name: string | null
  email: string | null
  github: LinkedGithubIdentity | null
}

export interface ListSlackMembersResponse {
  team_id: string
  team_name: string
  members: SlackMemberSummary[]
}

export interface SlackChannelSummary {
  id: string
  name: string | null
  is_private: boolean | null
  is_member: boolean | null
}

export interface ListSlackChannelsResponse {
  team_id: string
  team_name: string
  channels: SlackChannelSummary[]
}

export interface ListLinearTeamsResponse {
  organization_id: string
  teams: LinearTeamSummary[]
}

export interface ListSentryOrganizationsResponse {
  organizations: SentryOrganizationSummary[]
}

// -------------------------- sandbox variables ---------------------------
// Customer-scoped environment variables injected into a sandbox when an agent
// config names them. Values are write-only: the API accepts them but never
// returns them, so the summary carries only the name and timestamps.

export interface SandboxVariableSummary {
  name: string
  created_at: string
  updated_at: string
}

export interface GetSandboxVariablesResponse {
  variables: SandboxVariableSummary[]
}

export interface SandboxVariableInput {
  name: string
  value: string
}

export interface PutSandboxVariablesRequest {
  variables: SandboxVariableInput[]
}

// ------------------------------ cli auth --------------------------------

export interface CliAuthStart {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  interval: number
  expires_in: number
}

export type CliAuthPollStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'already_claimed'

export interface CliAuthPoll {
  status: CliAuthPollStatus
  access_token?: string
}
