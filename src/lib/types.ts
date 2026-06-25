// TypeScript mirror of the backend `/v1` request/response models. These are
// hand-rolled for now and will be replaced by the generated @ellipsis/sdk
// package once it exists. Nested config/input/output payloads are typed loosely
// (the CLI only displays summary fields); the rest mirror the Pydantic models
// in ellipsis/src/public_api/routers/v1/v1_router.py and the shared services.

// ------------------------------- identity -------------------------------

export interface WhoAmI {
  customer_id: string
  customer_login: string
  user_id: string | null
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

// ------------------------------ agent runs ------------------------------

export type AgentRunSource = 'react' | 'manual' | 'api' | 'cli' | 'mention' | 'cron'

export type AgentRunStatus =
  | 'scheduled'
  | 'creating_sandbox'
  | 'running'
  | 'completed'
  | 'error'
  | 'cancelled'
  | 'stopped'

// Loosely typed: the CLI reads a handful of summary fields and otherwise treats
// the run as opaque JSON. See AgentRun in the backend for the full shape.
export interface AgentRun {
  id: string
  customer_id: string
  created_at: string
  updated_at: string
  status: AgentRunStatus
  status_reason: string | null
  source?: AgentRunSource
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
  last_job_run_id: string | null
  last_synced_commit_sha: string | null
  last_sync_error: string | null
  agent_config: Record<string, unknown>
  [key: string]: unknown
}

// Inline agent config payload accepted by POST /v1/agents/runs. Opaque to the
// CLI — passed straight through from a user-supplied JSON file.
export type AgentConfig = Record<string, unknown>

// --------------------------- request / response -------------------------

export interface StartAgentRunRequest {
  config_id?: string
  config?: AgentConfig
  source?: AgentRunSource
  metadata?: Record<string, string>
  budget_usd?: number
}

export interface ListAgentRunsResponse {
  runs: AgentRun[]
}

export interface ListAgentConfigsResponse {
  configs: SavedAgentConfig[]
}

export interface ListAgentRunsQuery {
  config_id?: string
  source?: AgentRunSource[]
  days?: number
  start?: string
  end?: string
  limit?: number
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
