// TypeScript types for the backend `/v1` request/response models.
//
// The session-stream surface (records, inbox messages, turns, the enriched
// session wire shape, and their request/response DTOs) comes from
// @ellipsis-dev/sdk — generated from the server's schema, never hand-written —
// re-exported below under the CLI's historical names. Everything else (the
// endpoints outside the SDK's REST surface: session list/start, configs,
// sandboxes, integrations, …) remains a hand-rolled mirror of the Pydantic
// models in ellipsis's v1_router until the SDK's OpenAPI surface widens.
// Nested config/input/output payloads are typed loosely (the CLI only
// displays summary fields).

import type {
  AgentSessionSource,
  AgentSessionStatus,
  SessionMessageWire,
  SessionRecordWire,
  SessionState,
  SessionSurface,
} from '@ellipsis-dev/sdk'

export type {
  AgentSessionSource,
  AgentSessionStatus,
  AgentSessionWire,
  ListSessionRecordsResponse,
  ListSessionTurnsResponse,
  SendSessionMessageRequest,
  SessionState,
  SessionSurface,
} from '@ellipsis-dev/sdk'

// The CLI's historical names for the SDK's wire models.
export type SessionRecord = SessionRecordWire
export type SessionMessage = SessionMessageWire

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

// Loosely typed: the CLI reads a handful of summary fields and otherwise treats
// the session as opaque JSON. See AgentSession in the backend for the full shape.
export interface AgentSession {
  id: string
  customer_id: string
  created_at: string
  updated_at: string
  status: AgentSessionStatus
  status_reason: string | null
  // Why the session ended, finer than status; null until terminal.
  exit_status?: string | null
  source?: AgentSessionSource
  agent_config_id: string | null
  // Durable-conversation identity (stateful sessions): a keyed session runs
  // the cloud session loop and accepts /messages; null = single-shot.
  session_key?: string | null
  session_state?: 'idle' | 'running' | 'closed' | null
  // Customer-facing status surface (session_surface.py). `status` is the derived
  // single word to display (working/waiting/sleeping/starting/…); `session` +
  // `run` are the two raw axes. null for un-keyed (laptop) sessions and on list
  // rows that don't populate it. Prefer surface.status over the raw `status`.
  surface?: {
    session: 'alive' | 'sleeping' | 'closed' | null
    run: string | null
    status: string | null
  } | null
  cost_tokens: number
  cost_sandbox_cpu: number
  cost_sandbox_memory: number
  cost_fee: number
  tokens_total: number
  metadata: Record<string, string>
  // Present on the POST /v1/sessions response only (StartAgentSessionResponse):
  // which config the session runs under and which rung of the defaults ladder
  // chose it (null when an explicit config/template bypassed resolution).
  resolved_config_name?: string | null
  resolution_source?: 'repo_default' | 'account_default' | 'none' | null
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
  // The "owner/name" repository the CLI is standing in (origin remote). With
  // no explicit config source it selects the repo rung of the server's
  // default-config ladder (repo default -> account default -> bare config),
  // and it is always merged into the sandbox repository set (cloned at the
  // default branch), even alongside --config. Unknown/foreign repos are
  // ignored server-side.
  repository?: string
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
  // Start with no initial message: the sandbox spins up, Claude Code sits idle
  // at the prompt, and the first message sent to the session opens turn 0,
  // exactly like a local `claude`. Sent for a promptless --connect start (a
  // bare `agent`). Mutually exclusive with prompt; the server ignores it when
  // the resolved config is not interactive (that session runs its workflow).
  idle_start?: boolean
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

// One rung of the default-config ladder (GET /v1/defaults). Rungs are
// addressed by `repository`: "owner/name" for a repo default, null for the
// account-wide default — never by row id.
export interface AgentDefaultView {
  id: string
  repository: string | null
  config_id: string
  // The pointed-at config's name; null when the config is gone (see broken).
  config_name: string | null
  // Why this rung can't serve sessions (config_deleted | config_disabled |
  // config_pending_pr | repo_inaccessible); null when healthy.
  broken: string | null
  updated_at: string
}

export interface ListAgentDefaultsResponse {
  defaults: AgentDefaultView[]
}

// Body of PUT /v1/defaults: point a rung at a config. `repository` omitted
// sets the account default; "owner/name" sets that repo's default.
export interface PutAgentDefaultRequest {
  repository?: string
  config_id: string
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

// ----------------------------- session records ---------------------------

// The render switch on a session_record (session_records.source). The CLI
// renders claude_code records natively and lifecycle records as system lines.
// One process's raw transcript from GET /v1/sessions/{id}/transcripts: the
// pointer metadata plus a short-lived presigned S3 GET for the .jsonl.gz
// object itself (expires after expires_in seconds — fetch it immediately).
export interface SessionTranscript {
  process_id: string
  // "claude_stream_json" (cloud) or "claude_transcript" (synced laptop).
  format: string
  event_count: number | null
  bytes: number | null
  written_at: string | null
  // null = only periodic flushes so far (session still running); "failed" =
  // the final write failed, so the tail past the last flush may be missing.
  write_status: 'ok' | 'failed' | null
  download_url: string
  expires_in: number
}

export interface ListSessionTranscriptsResponse {
  session_id: string
  transcripts: SessionTranscript[]
}

// GET /v1/sessions/{id}/ide (`agent session ide`): the live sandbox's
// code-server tunnel URL. Unguessable, customer-scoped at discovery, and dead
// once the sandbox is torn down — fetch it fresh on every open, never store it.
export interface GetSessionIdeResponse {
  url: string
}

// GET /v1/sessions/{id}/ports/{port} (`agent session port`): the tunnel URL
// for one of the sandbox's preview ports (a dev server the agent or the IDE
// user started). Same lifetime/gating as the IDE URL.
export interface GetSessionPortResponse {
  url: string
  port: number
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

// ---------------------------- sandbox builds -----------------------------
// "docker build" for the Ellipsis sandbox: run a config's environment
// definition (dockerfile_append + clone + image.setup [+ hooks]) with
// streamed logs and no agent, pre-warming the image cache on success.

export type SandboxBuildStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type SandboxBuildPhase = 'image' | 'clone' | 'setup' | 'snapshot' | 'hooks'
export type SandboxBuildCacheTier = 'exact' | 'incremental' | 'full'

export interface SandboxBuild {
  id: string
  created_at: string
  updated_at: string
  config_id: string | null
  config_sha: string
  hooks_requested: boolean
  status: SandboxBuildStatus
  phase: SandboxBuildPhase | null
  cache_tier: SandboxBuildCacheTier | null
  phase_timings: Record<string, number>
  failing_phase: SandboxBuildPhase | null
  exit_code: number | null
  status_reason: string | null
  sandbox_id: string | null
  result_image_id: string | null
  started_at: string | null
  finished_at: string | null
}

export interface StartSandboxBuildRequest {
  config_yaml?: string
  config_id?: string
  hooks?: boolean
}

export interface ListSandboxBuildsResponse {
  builds: SandboxBuild[]
}

export interface SandboxBuildLogLine {
  build_id: string
  seq: number
  ts: string
  phase: SandboxBuildPhase
  line: string
}

export interface GetSandboxBuildLogsResponse {
  build_id: string
  lines: SandboxBuildLogLine[]
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

// --------------------------------- assets --------------------------------
// Agent asset storage (ellipsis: documents/eng/AGENT_ASSET_STORAGE.md): files
// an agent persists beyond its sandbox's lifetime — v1 is PNG screenshots
// posted as org-gated links on PRs. Mirrors assets_service.py.

// Caller-facing asset metadata — no storage internals (S3 key, sha, owner).
export interface AssetView {
  id: string
  filename: string
  content_type: string
  size_bytes: number
  created_at: string
  // The originating session, when the upload came from a sandbox.
  agent_session_id: string | null
}

export interface CreateAssetRequest {
  // Original basename, display only (the S3 key derives from the server-side
  // asset id, never from this).
  filename: string
  // v1: must be image/png; the server magic-byte-checks the decoded bytes.
  content_type: string
  // The raw file bytes, base64-encoded (same JSON-body precedent as session
  // transcript sync).
  data_b64: string
}

export interface CreateAssetResponse {
  asset: AssetView
  // The fully-formed org-gated dashboard URL (app.ellipsis.dev/assets/{id}) —
  // the link an agent pastes into a PR comment.
  url: string
}

export interface ListAssetsQuery {
  // Scope to one run's uploads.
  agent_session_id?: string
  limit?: number
}

export interface ListAssetsResponse {
  assets: AssetView[]
}

export interface GetAssetResponse {
  asset: AssetView
  // The gated dashboard URL (same link the upload returned).
  url: string
  // Short-lived (60s) presigned S3 GET for the actual bytes — fetch it
  // immediately; the JSON API never carries the file itself.
  download_url: string
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
