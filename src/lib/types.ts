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

// ------------------------------- analytics -------------------------------
// Mirrors of the /v1/analytics/* responses (analytics_service.py) — the same
// aggregation behind the app's /analytics dashboard, token-authed. The CLI
// renders the leaderboards and totals; feed items and day buckets it only
// passes through to --json are typed loosely.

// Shared window params: explicit start/end (ISO timestamps) or a `days`
// look-back (mutually exclusive with start; server default: last 30 days).
export interface AnalyticsWindowQuery {
  days?: number
  start?: string
  end?: string
}

// all = everyone, user = humans only, bot = apps/agents only.
export type AnalyticsAccountType = 'all' | 'user' | 'bot'

export interface AnalyticsMetricsQuery extends AnalyticsWindowQuery {
  repo?: string[] // "owner/name"
  author?: string[] // PR-author logins
  account_type?: AnalyticsAccountType
  status?: string[] // open | draft | merged | closed
}

// A person or app that reviewed PRs in the window.
export interface ReviewerUsage {
  login: string
  avatar_url: string | null
  reviews: number
  approved: number
  changes_requested: number
  comments: number
  lines_reviewed: number
}

// An author who merged a PR in the window.
export interface ContributorUsage {
  login: string
  avatar_url: string | null
  prs_merged: number
  reviews: number
  additions: number
  deletions: number
  ai_attributed_prs: number
}

export interface AnalyticsRepoUsage {
  repo_full_name: string
  prs_merged: number
  reviews: number
  active_contributors: number
  ai_attributed_prs: number
  additions: number
  deletions: number
}

export interface AnalyticsMetricsTotals {
  prs_opened: number
  prs_merged: number
  prs_closed: number
  reviews: number
  prs_reviewed: number
  approved: number
  changes_requested: number
  commented: number
  review_comments: number
  additions: number
  deletions: number
  commits: number
  active_contributors: number
  open_prs: number
  median_time_to_merge_hours: number
  median_time_to_first_review_hours: number
}

export interface GetAnalyticsMetricsResponse {
  series: Array<Record<string, unknown>>
  totals: AnalyticsMetricsTotals
  repositories: AnalyticsRepoUsage[]
  contributors: ContributorUsage[]
  reviewers: ReviewerUsage[]
  available_repos: Array<{ repo_full_name: string; prs: number }>
  available_authors: Array<{ login: string; prs: number }>
}

export interface AnalyticsPullRequestsQuery extends AnalyticsWindowQuery {
  // Raw GithubAccountType strings ("User", "Bot"), unlike the metrics/reviews
  // account_type enum — mirrors the backend filter.
  account_type?: string[]
  repository_id?: number[]
  author_id?: number[]
  status?: string[]
}

export interface PullRequestsDayBucket {
  date: string
  prs: number
  prs_human: number
  prs_bot: number
  merged: number
  closed: number
  lines: number
  lines_human: number
  lines_bot: number
  commits: number
  commits_human: number
  commits_bot: number
  authors: number
  authors_human: number
  authors_bot: number
  // merge_time percentiles pass through untyped.
  [key: string]: unknown
}

export interface PullRequestsTotals {
  prs: number
  merged: number
  lines: number
  commits: number
  active_authors: number
  merge_time_p50_hours: number
}

export interface GetAnalyticsPullRequestsResponse {
  series: PullRequestsDayBucket[]
  totals: PullRequestsTotals
  facets: Record<string, unknown>
  recent: Array<Record<string, unknown>>
  // True when the window hit the server's PR scan cap and figures undercount.
  truncated: boolean
}

export interface AnalyticsReviewsQuery extends AnalyticsWindowQuery {
  repo?: string[] // bare repo names (matching the review facet values)
  author?: string[] // reviewer logins
  account_type?: AnalyticsAccountType
  review_state?: string[] // APPROVED | CHANGES_REQUESTED | COMMENTED | ...
}

export interface ReviewsDayBucket {
  date: string
  reviews: number
  approved: number
  commented: number
  changes_requested: number
  reviewers_human: number
  reviewers_bot: number
  reviewers_total: number
  comments: number
  comments_human: number
  comments_bot: number
}

export interface ReviewsTotals {
  reviews: number
  reviewers: number
  prs: number
  comments: number
  comments_human: number
  comments_bot: number
  thumbs_up: number
  thumbs_down: number
}

export interface ReviewAuthorFacet {
  login: string
  avatar_url: string | null
  account_type: string | null
  reviews: number
}

export interface GetAnalyticsReviewsResponse {
  reviews: Array<Record<string, unknown>>
  review_comments: Array<Record<string, unknown>>
  series: ReviewsDayBucket[]
  totals: ReviewsTotals
  facets: {
    repos: Array<{ repository_name: string; reviews: number }>
    authors: ReviewAuthorFacet[]
  }
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
