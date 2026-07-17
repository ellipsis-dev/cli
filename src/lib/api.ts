import { resolveApiBase, resolveToken } from './config'
import { USER_AGENT } from './constants'
import type {
  AgentSession,
  AgentTemplate,
  AnalyticsMetricsQuery,
  AnalyticsPullRequestsQuery,
  AnalyticsReviewsQuery,
  AssetView,
  BudgetSummary,
  CliAuthPoll,
  CliAuthStart,
  CreateAgentConfigRequest,
  CreateAssetRequest,
  CreateAssetResponse,
  CreatedAgentConfig,
  GetAssetResponse,
  GetAnalyticsMetricsResponse,
  GetAnalyticsPullRequestsResponse,
  GetAnalyticsReviewsResponse,
  GetIntegrationsResponse,
  GetSandboxVariablesResponse,
  GetSessionIdeResponse,
  GetSessionPortResponse,
  ListAgentConfigsResponse,
  ListAgentSessionsQuery,
  ListAgentSessionsResponse,
  ListAgentTemplatesResponse,
  ListAssetsQuery,
  ListAssetsResponse,
  ListGithubMembersResponse,
  ListGithubRepositoriesResponse,
  ListLinearTeamsResponse,
  ListSentryOrganizationsResponse,
  ListSessionRecordsResponse,
  ListSessionTurnsResponse,
  ListSessionTranscriptsResponse,
  ListSlackChannelsResponse,
  ListSlackMembersResponse,
  ReplayAgentSessionRequest,
  SendSessionMessageRequest,
  SandboxVariableInput,
  SandboxVariableSummary,
  SearchSessionsQuery,
  SearchSessionsResponse,
  SessionRecord,
  SyncAgentSessionRequest,
  SyncAgentSessionResponse,
  SavedAgentConfig,
  StartAgentSessionRequest,
  UsageDashboard,
  WhoAmI,
  GetSandboxBuildLogsResponse,
  ListSandboxBuildsResponse,
  SandboxBuild,
  SandboxBuildLogLine,
  StartSandboxBuildRequest,
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

  // Session-grouped search over step text, recap text, created PRs, and
  // recap-embedding similarity. Each result says which arms matched.
  searchSessions(query: SearchSessionsQuery): Promise<SearchSessionsResponse> {
    return this.request(
      'GET',
      '/v1/sessions/search',
      undefined,
      query as unknown as Record<string, unknown>,
    )
  }

  // The session's full stored transcript as native session_records (transcript
  // + lifecycle), ordered by feed_seq.
  async getAgentSessionRecords(sessionId: string): Promise<SessionRecord[]> {
    const res = await this.request<ListSessionRecordsResponse>(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/records`,
    )
    return res.records
  }

  // The session's conversation structure — turns and inbox messages, each
  // message carrying its pending/delivered status (the server-side "queued"
  // truth). Empty lists for single-shot sessions.
  getAgentSessionTurns(sessionId: string): Promise<ListSessionTurnsResponse> {
    return this.request('GET', `/v1/sessions/${encodeURIComponent(sessionId)}/turns`)
  }

  // The session's raw transcripts — one .jsonl.gz per process — each with a
  // short-lived presigned download URL. Fetch the URL immediately; the JSON
  // API never carries the bytes.
  getSessionTranscripts(sessionId: string): Promise<ListSessionTranscriptsResponse> {
    return this.request(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/transcripts`,
    )
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

  // Post a human message into a durable (keyed) session's conversation. The
  // inbox delivers it to the agent's Claude Code stdin at the next turn
  // boundary, or wakes the session when idle. 409 for single-shot / closed
  // sessions (no inbox loop to attend it).
  sendSessionMessage(sessionId: string, message: string): Promise<AgentSession> {
    return this.request('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      message,
    } satisfies SendSessionMessageRequest)
  }

  // The session's browser-IDE link: the membership-gated dashboard page for
  // the live sandbox (app.ellipsis.dev/sandboxes/{id}) — the page starts
  // code-server and does the sandbox-proxy handoff itself, so the URL carries
  // no credential and is safe to share with any org member. 409 when the
  // sandbox isn't running (send the session a message to wake it first).
  getSessionIde(sessionId: string): Promise<GetSessionIdeResponse> {
    return this.request('GET', `/v1/sessions/${encodeURIComponent(sessionId)}/ide`)
  }

  // A preview port's link (a dev server running in the sandbox): the same
  // dashboard page, deep-linked to the port. Same gate as the IDE URL.
  getSessionPort(sessionId: string, port: number): Promise<GetSessionPortResponse> {
    return this.request(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/ports/${port}`,
    )
  }

  // --------------------------------- assets --------------------------------
  // Agent asset storage: persist a file to the platform and get back an
  // org-membership-gated link (documents/eng/AGENT_ASSET_STORAGE.md in the
  // ellipsis repo). v1 is PNG-only with a 10 MiB cap, enforced server-side.

  uploadAsset(req: CreateAssetRequest): Promise<CreateAssetResponse> {
    return this.request('POST', '/v1/assets', req)
  }

  // Newest-first metadata for the credential's customer's assets. Metadata
  // only — presigned download URLs are minted per explicit getAsset.
  async listAssets(query?: ListAssetsQuery): Promise<AssetView[]> {
    const res = await this.request<ListAssetsResponse>(
      'GET',
      '/v1/assets',
      undefined,
      query as Record<string, unknown> | undefined,
    )
    return res.assets
  }

  // Metadata + the gated URL + a short-lived presigned `download_url`. To pull
  // the bytes locally, GET download_url immediately (it expires in ~60s; if it
  // lapses, just call this again for a fresh one).
  getAsset(assetId: string): Promise<GetAssetResponse> {
    return this.request('GET', `/v1/assets/${encodeURIComponent(assetId)}`)
  }

  // Delete an asset: it disappears from every read path and its gated link
  // stops resolving (the server soft-deletes; storage accounting keeps
  // charging for everything ever written). The
  // server returns 204 with an empty body on success; 404 when the id is
  // unknown to the credential's customer, 403 when the token isn't allowed to
  // delete (e.g. a sandbox token).
  deleteAsset(assetId: string): Promise<void> {
    return this.request('DELETE', `/v1/assets/${encodeURIComponent(assetId)}`)
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

  // ----------------------------- sandbox builds ---------------------------
  // "docker build" for the Ellipsis sandbox (test a config's environment
  // definition, streamed logs, cache pre-warm on success).

  startSandboxBuild(request: StartSandboxBuildRequest): Promise<SandboxBuild> {
    return this.request('POST', '/v1/sandboxes/builds', request)
  }

  async listSandboxBuilds(limit?: number): Promise<SandboxBuild[]> {
    const res = await this.request<ListSandboxBuildsResponse>(
      'GET',
      '/v1/sandboxes/builds',
      undefined,
      { limit },
    )
    return res.builds
  }

  getSandboxBuild(buildId: string): Promise<SandboxBuild> {
    return this.request('GET', `/v1/sandboxes/builds/${encodeURIComponent(buildId)}`)
  }

  async getSandboxBuildLogs(
    buildId: string,
    afterSeq?: number,
    limit?: number,
  ): Promise<SandboxBuildLogLine[]> {
    const res = await this.request<GetSandboxBuildLogsResponse>(
      'GET',
      `/v1/sandboxes/builds/${encodeURIComponent(buildId)}/logs`,
      undefined,
      { after_seq: afterSeq, limit },
    )
    return res.lines
  }

  // ---------------------------- agent templates ---------------------------

  async listAgentTemplates(): Promise<AgentTemplate[]> {
    const res = await this.request<ListAgentTemplatesResponse>('GET', '/v1/templates')
    return res.templates
  }

  getAgentTemplate(slug: string): Promise<AgentTemplate> {
    return this.request('GET', `/v1/templates/${encodeURIComponent(slug)}`)
  }

  // ------------------------ integration discovery -------------------------
  // Read-only views of what's connected for the account. Slack and Linear
  // listings 404 when that integration isn't connected; GitHub always works
  // (an Ellipsis account is a GitHub account) and Sentry returns an empty list.

  getIntegrations(): Promise<GetIntegrationsResponse> {
    return this.request('GET', '/v1/integrations')
  }

  listGithubRepositories(): Promise<ListGithubRepositoriesResponse> {
    return this.request('GET', '/v1/github/repos')
  }

  listGithubMembers(): Promise<ListGithubMembersResponse> {
    return this.request('GET', '/v1/github/members')
  }

  listSlackChannels(): Promise<ListSlackChannelsResponse> {
    return this.request('GET', '/v1/slack/channels')
  }

  listSlackMembers(): Promise<ListSlackMembersResponse> {
    return this.request('GET', '/v1/slack/members')
  }

  listLinearTeams(): Promise<ListLinearTeamsResponse> {
    return this.request('GET', '/v1/linear/teams')
  }

  listSentryOrganizations(): Promise<ListSentryOrganizationsResponse> {
    return this.request('GET', '/v1/sentry/organizations')
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

// Await a provider listing, mapping its 404 (Slack/Linear not connected for
// this account) to a short friendly error instead of the raw HTTP failure.
// Anything else propagates unchanged.
export async function requireConnected<T>(provider: string, call: Promise<T>): Promise<T> {
  try {
    return await call
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new Error(
        `${provider} is not connected. Connect it in the Ellipsis dashboard, then retry.`,
      )
    }
    throw err
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
