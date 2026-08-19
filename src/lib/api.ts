// The CLI's entry point to @ellipsis-dev/sdk: the SDK owns the whole REST
// surface (every /v1 operation, its request/response types, retries, and error
// mapping), generated from the server's OpenAPI spec. This module owns only
// what is CLI-specific — resolving the credential and base URL through the
// config precedence chain, stamping the CLI's user agent on every request, and
// turning an SDK error into the sentence a terminal user should read.

import { Ellipsis, APIError } from '@ellipsis-dev/sdk'
import { resolveApiBase, resolveToken } from './config'
import { USER_AGENT } from './constants'

export { APIError }

// The SDK's Transport takes no custom headers, so the user agent rides in on an
// injected fetch — every CLI request stays attributable server-side.
function fetchWithUserAgent(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return globalThis.fetch(input, {
    ...init,
    headers: { ...(init?.headers as Record<string, string>), 'user-agent': USER_AGENT },
  })
}

// Both args are optional overrides; when omitted, each is resolved through the
// precedence chain (explicit → env → config → default) in config.ts. The token
// may legitimately be absent: the device-code auth routes are unauthenticated,
// and the server answers 401 for anything else, which reads as "run `agent
// login`" via friendlyErrorMessage.
export function api(base?: string, token?: string): Ellipsis {
  return new Ellipsis({
    apiKey: resolveToken(token) ?? '',
    baseUrl: resolveApiBase(base),
    fetch: fetchWithUserAgent,
  })
}

// The server's own sentence for a failed call. The SDK's APIError.message is
// prefixed with the status and code for library consumers; a terminal user wants
// the sentence alone (a 429's remedy reads badly behind "429 error:"), so read it
// back off the parsed error body and keep the prefixed form as the fallback.
export function errorDetail(err: unknown): string {
  if (!(err instanceof APIError)) return (err as Error).message
  const body = err.body
  if (body !== null && typeof body === 'object') {
    const envelope = (body as { error?: { message?: unknown } }).error
    if (envelope && typeof envelope.message === 'string') return envelope.message
    const detail = (body as { detail?: unknown }).detail
    if (typeof detail === 'string') return detail
  }
  return err.message
}

// The full one-line account of a failure: the status, the server's message, and
// the request id it stamped, so a user can quote an exact log line to us.
export function describeApiError(err: APIError): string {
  const requestId = err.requestId ? ` (request id: ${err.requestId})` : ''
  return `${err.status} ${errorDetail(err)}${requestId}`
}

// Await a provider listing, mapping its 404 (Slack/Linear not connected for
// this account) to a short friendly error instead of the raw HTTP failure.
// Anything else propagates unchanged.
export async function requireConnected<T>(provider: string, call: Promise<T>): Promise<T> {
  try {
    return await call
  } catch (err) {
    if (err instanceof APIError && err.status === 404) {
      throw new Error(
        `${provider} is not connected. Connect it in the Ellipsis dashboard, then retry.`,
      )
    }
    throw err
  }
}
