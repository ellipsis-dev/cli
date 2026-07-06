import { resolveApiBase, resolveToken } from './config'
import { USER_AGENT } from './constants'
import type {
  AgentSession,
  AgentTemplate,
  AnalyticsMetricsQuery,
  AnalyticsPullRequestsQuery,
  AnalyticsReviewsQuery,
  BudgetSummary,
  CliAuthPoll,
  CliAuthStart,
  CreateAgentConfigRequest,
  CreatedAgentConfig,
  GetAnalyticsMetricsResponse,
  GetAnalyticsPullRequestsResponse,
  GetAnalyticsReviewsResponse,
  GetSandboxVariablesResponse,
  ListAgentConfigsResponse,
  ListAgentSessionsQuery,
  ListAgentSessionsResponse,
  ListAgentTemplatesResponse,
  ReplayAgentSessionRequest,
  SandboxVariableInput,
  SandboxVariableSummary,
  SyncAgentSessionRequest,
  SyncAgentSessionResponse,
  SavedAgentConfig,
  StartAgentSessionRequest,
  UsageDashboard,
  WhoAmI,
} from './types'

// Thin REST client over the public `/v1` API. The typed request/response
// surface mirrors ellipsis/src/public_api/routers/v1/v1_router.py and will move
// to @ellipsis/sdk (generated from the backend OpenAPI spec) once that package
// exists; this CLI then imports it instead of hand-rolling types.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly detail: string,
    // Per-request id the server stamps on every response; quote it to us so a
    // failure maps to an exact log line. Absent only for pre-request failures.
    readonly requestId?: string,
  ) {
    super(
      `${method} ${path} failed: ${status} ${detail}` +
        (requestId ? ` (request id: ${requestId})` : ''),
    )
    this.name = 'ApiError'
  }
}

export class ApiClient {
  private readonly base: string
  private readonly token?: string

  // Both args are optional overrides; when omitted, each is resolved through
  // the precedence chain (explicit → env → config → default) in config.ts.
  constructor(base?: string, token?: string) {
    this.base = resolveApiBase(base)
    this.token = resolveToken(token)
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, unknown>,
  ): Promise<T> {
    const url = this.base + path + buildQuery(query)
    const res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      const { detail, requestId } = await parseErrorResponse(res)
      throw new ApiError(res.status, method, path, detail, requestId)
    }
    // Some endpoints (DELETEs, acks) return empty bodies; tolerate that.
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  // ------------------------------- identity -------------------------------

  whoami(): Promise<WhoAmI> {
    return this.request('GET', '/v1/me')
  }

  // ----------------------------- usage / budget ---------------------------

  getBudget(): Promise<BudgetSummary> {
    return this.request('GET', '/v1/budget')
  }

  getUsage(): Promise<UsageDashboard> {
    return this.request('GET', '/v1/usage')
  }

  // ------------------------------- analytics ------------------------------
  // GitHub PR + review analytics — the same aggregation behind the app's
  // /analytics dashboard, scoped to the token's customer. Window: pass
  // start/end or days (server default: the last 30 days).

  getAnalyticsMetrics(
    query?: AnalyticsMetricsQuery,
  ): Promise<GetAnalyticsMetricsResponse> {
    return this.request(
      'GET',
      '/v1/analytics/metrics',
      undefined,
      query as Record<string, unknown> | undefined,
    )
  }

  getAnalyticsPullRequests(
    query?: AnalyticsPullRequestsQuery,
  ): Promise<GetAnalyticsPullRequestsResponse> {
    return this.request(
      'GET',
      '/v1/analytics/pull-requests',
      undefined,
      query as Record<string, unknown> | undefined,
    )
  }

  getAnalyticsReviews(
    query?: AnalyticsReviewsQuery,
  ): Promise<GetAnalyticsReviewsResponse> {
    return this.request(
      'GET',
      '/v1/analytics/reviews',
      undefined,
      query as Record<string, unknown> | undefined,
    )
  }

  // ---------------------------- agent sessions -----------------------------

  startAgentSession(req: StartAgentSessionRequest): Promise<AgentSession> {
    return this.request('POST', '/v1/sessions', req)
  }

  async listAgentSessions(query?: ListAgentSessionsQuery): Promise<AgentSession[]> {
    const res = await this.request<ListAgentSessionsResponse>(
      'GET',
      '/v1/sessions',
      undefined,
      query as Record<string, unknown> | undefined,
    )
    return res.sessions
  }

  getAgentSession(sessionId: string): Promise<AgentSession> {
    return this.request('GET', `/v1/sessions/${encodeURIComponent(sessionId)}`)
  }

  syncAgentSession(req: SyncAgentSessionRequest): Promise<SyncAgentSessionResponse> {
    return this.request('POST', '/v1/sessions/sync', req)
  }

  replayAgentSession(sessionId: string, req: ReplayAgentSessionRequest): Promise<AgentSession> {
    return this.request(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/replay`,
      req,
    )
  }

  stopAgentSession(sessionId: string): Promise<AgentSession> {
    return this.request('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/stop`)
  }

  // ----------------------------- agent configs ----------------------------

  async listAgentConfigs(): Promise<SavedAgentConfig[]> {
    const res = await this.request<ListAgentConfigsResponse>('GET', '/v1/configs')
    return res.configs
  }

  // Opens a pull request that adds the config's YAML to the repo's agents/
  // directory; the agent goes live once it merges and syncs.
  createAgentConfig(req: CreateAgentConfigRequest): Promise<CreatedAgentConfig> {
    return this.request('POST', '/v1/configs', req)
  }

  getAgentConfig(configId: string): Promise<SavedAgentConfig> {
    return this.request('GET', `/v1/configs/${encodeURIComponent(configId)}`)
  }

  // -------------------------- sandbox variables ---------------------------
  // All three return the full current list (the backend echoes it after every
  // mutation), so callers can render the resulting state.

  async listSandboxVariables(): Promise<SandboxVariableSummary[]> {
    const res = await this.request<GetSandboxVariablesResponse>(
      'GET',
      '/v1/sandboxes/variables',
    )
    return res.variables
  }

  async putSandboxVariables(
    variables: SandboxVariableInput[],
  ): Promise<SandboxVariableSummary[]> {
    const res = await this.request<GetSandboxVariablesResponse>(
      'PUT',
      '/v1/sandboxes/variables',
      { variables },
    )
    return res.variables
  }

  async deleteSandboxVariable(name: string): Promise<SandboxVariableSummary[]> {
    const res = await this.request<GetSandboxVariablesResponse>(
      'DELETE',
      `/v1/sandboxes/variables/${encodeURIComponent(name)}`,
    )
    return res.variables
  }

  // ---------------------------- agent templates ---------------------------

  async listAgentTemplates(): Promise<AgentTemplate[]> {
    const res = await this.request<ListAgentTemplatesResponse>('GET', '/v1/templates')
    return res.templates
  }

  getAgentTemplate(slug: string): Promise<AgentTemplate> {
    return this.request('GET', `/v1/templates/${encodeURIComponent(slug)}`)
  }

  // --------------------------- device-code auth ---------------------------
  // Unauthenticated: the CLI has no credential yet — that's what it's obtaining.

  startCliAuth(): Promise<CliAuthStart> {
    return this.request('POST', '/v1/cli-auth/start')
  }

  pollCliAuth(deviceCode: string): Promise<CliAuthPoll> {
    return this.request('POST', '/v1/cli-auth/poll', { device_code: deviceCode })
  }
}

export function buildQuery(query?: Record<string, unknown>): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    // Repeat the key for arrays (FastAPI's `Query()` list convention).
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item))
    } else {
      params.append(key, String(value))
    }
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

// Pull the server's `{"detail": ...}` message and request id off a non-2xx
// response. The detail keeps `agent` error output actionable instead of bare
// codes; the id comes from the `X-Request-ID` header (set on every API response)
// and falls back to the `request_id` field the server's 500 handler includes in
// its body, so an error carries something we can grep our logs for.
export async function parseErrorResponse(
  res: Response,
): Promise<{ detail: string; requestId?: string }> {
  const headerRequestId = res.headers.get('x-request-id') ?? undefined
  try {
    const body = (await res.json()) as { detail?: unknown; request_id?: unknown }
    const requestId =
      headerRequestId ??
      (typeof body.request_id === 'string' ? body.request_id : undefined)
    if (typeof body.detail === 'string') return { detail: body.detail, requestId }
    if (body.detail) return { detail: JSON.stringify(body.detail), requestId }
    return { detail: res.statusText, requestId }
  } catch {
    // not JSON
    return { detail: res.statusText, requestId: headerRequestId }
  }
}
