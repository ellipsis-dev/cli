import { DEFAULT_API_BASE } from './constants'
import { loadConfig } from './config'

// Thin REST client. The typed request/response surface will move to
// @ellipsis/sdk (generated from the backend OpenAPI spec) once that
// package exists; this CLI then imports it instead of hand-rolling types.
export class ApiClient {
  private readonly base: string
  private readonly token?: string

  constructor(base?: string, token?: string) {
    const config = loadConfig()
    this.base = base ?? config.apiBase ?? DEFAULT_API_BASE
    this.token = token ?? config.token
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`${method} ${path} failed: ${res.status} ${res.statusText}`)
    }
    return (await res.json()) as T
  }
}
