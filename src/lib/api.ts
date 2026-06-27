import { resolveApiBase, resolveToken } from './config'
import type {
  AgentRun,
  AgentTemplate,
  BudgetSummary,
  CliAuthPoll,
  CliAuthStart,
  CreateAgentConfigRequest,
  CreatedAgentConfig,
  ListAgentConfigsResponse,
  ListAgentRunsQuery,
  ListAgentRunsResponse,
  ListAgentTemplatesResponse,
  SavedAgentConfig,
  StartAgentRunRequest,
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
  ) {
    super(`${method} ${path} failed: ${status} ${detail}`)
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
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      throw new ApiError(res.status, method, path, await errorDetail(res))
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

  // ------------------------------ agent runs ------------------------------

  startAgentRun(req: StartAgentRunRequest): Promise<AgentRun> {
    return this.request('POST', '/v1/agents/runs', req)
  }

  async listAgentRuns(query?: ListAgentRunsQuery): Promise<AgentRun[]> {
    const res = await this.request<ListAgentRunsResponse>(
      'GET',
      '/v1/agents/runs',
      undefined,
      query as Record<string, unknown> | undefined,
    )
    return res.runs
  }

  getAgentRun(runId: string): Promise<AgentRun> {
    return this.request('GET', `/v1/agents/runs/${encodeURIComponent(runId)}`)
  }

  // ----------------------------- agent configs ----------------------------

  async listAgentConfigs(): Promise<SavedAgentConfig[]> {
    const res = await this.request<ListAgentConfigsResponse>(
      'GET',
      '/v1/agents/configs',
    )
    return res.configs
  }

  // Opens a pull request that adds the config's YAML to the repo's agents/
  // directory; the agent goes live once it merges and syncs.
  createAgentConfig(req: CreateAgentConfigRequest): Promise<CreatedAgentConfig> {
    return this.request('POST', '/v1/agents/configs', req)
  }

  getAgentConfig(configId: string): Promise<SavedAgentConfig> {
    return this.request('GET', `/v1/agents/configs/${encodeURIComponent(configId)}`)
  }

  // ---------------------------- agent templates ---------------------------

  async listAgentTemplates(): Promise<AgentTemplate[]> {
    const res = await this.request<ListAgentTemplatesResponse>(
      'GET',
      '/v1/agents/templates',
    )
    return res.templates
  }

  getAgentTemplate(slug: string): Promise<AgentTemplate> {
    return this.request('GET', `/v1/agents/templates/${encodeURIComponent(slug)}`)
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

// Surface the server's `{"detail": ...}` message when present; fall back to the
// status text. Keeps `agent` error output actionable instead of bare codes.
export async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown }
    if (typeof body.detail === 'string') return body.detail
    if (body.detail) return JSON.stringify(body.detail)
  } catch {
    // not JSON
  }
  return res.statusText
}
