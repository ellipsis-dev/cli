import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APIError } from '@ellipsis-dev/sdk'
import { api, describeApiError, errorDetail } from '../src/lib/api'
import { USER_AGENT } from '../src/lib/constants'

// The REST surface itself is the SDK's, generated from the OpenAPI spec and
// tested there. What belongs to the CLI is this module: how a client gets its
// credential and base URL, that every request is attributable, and how an SDK
// error becomes something a terminal user can act on.

// A throwaway config dir per test, so resolveToken/resolveApiBase read a known
// (empty) config rather than the developer's real ~/.ellipsis.
let dir: string
const ENV_KEYS = ['ELLIPSIS_API_TOKEN', 'ELLIPSIS_API_BASE_URL', 'ELLIPSIS_API_BASE'] as const

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ellipsis-api-'))
  process.env.ELLIPSIS_CONFIG_DIR = dir
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  delete process.env.ELLIPSIS_CONFIG_DIR
  for (const k of ENV_KEYS) delete process.env[k]
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

function stubOk(body: unknown = { ok: true }): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('api', () => {
  it('sends the resolved bearer token and hits the resolved base', async () => {
    const fetchMock = stubOk({ customer_login: 'acme' })
    await api('http://api.test', 'tok_123').me()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://api.test/me')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok_123' })
  })

  it('resolves the token and base from the environment when not passed', async () => {
    process.env.ELLIPSIS_API_TOKEN = 'env_tok'
    process.env.ELLIPSIS_API_BASE_URL = 'http://env.test'
    const fetchMock = stubOk()
    await api().budget()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://env.test/budget')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer env_tok' })
  })

  it('stamps the CLI user agent on every request, so calls stay attributable', async () => {
    const fetchMock = stubOk()
    await api('http://api.test', 't').usage()

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ 'user-agent': USER_AGENT })
    expect(USER_AGENT).toMatch(/^ellipsis-cli\//)
  })

  it('builds a client with no credential at all, for the unauthenticated auth routes', async () => {
    const fetchMock = stubOk({ device_code: 'dev_1' })
    await api('http://api.test').auth.cli.start()

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://api.test/auth/cli/start')
  })
})

describe('errorDetail', () => {
  it("reads the server's sentence out of the error envelope", () => {
    const err = new APIError({
      status: 409,
      code: 'session_closed',
      message: 'Session is closed',
      requestId: 'request_1',
      body: { error: { message: 'Session is closed', code: 'session_closed' } },
    })
    expect(errorDetail(err)).toBe('Session is closed')
  })

  it("reads FastAPI's own `detail` shape, which auth and validation still use", () => {
    const err = new APIError({
      status: 401,
      code: null,
      message: 'Invalid credentials',
      requestId: null,
      body: { detail: 'Invalid credentials' },
    })
    expect(errorDetail(err)).toBe('Invalid credentials')
  })

  it("falls back to the SDK's message when the body carries no sentence", () => {
    const err = new APIError({
      status: 502,
      code: null,
      message: 'Bad Gateway',
      requestId: null,
      body: '<html>oops</html>',
    })
    expect(errorDetail(err)).toBe('502 error: Bad Gateway')
  })

  it('passes a plain Error through unchanged', () => {
    expect(errorDetail(new Error('boom'))).toBe('boom')
  })
})

describe('describeApiError', () => {
  it('quotes the status, the message, and the request id we can grep for', () => {
    const err = new APIError({
      status: 500,
      code: null,
      message: 'Internal Server Error',
      requestId: 'request_deadbeef',
      body: { error: { message: 'Internal Server Error' } },
    })
    expect(describeApiError(err)).toBe(
      '500 Internal Server Error (request id: request_deadbeef)',
    )
  })

  it('omits the request id when the server stamped none', () => {
    const err = new APIError({
      status: 404,
      code: null,
      message: 'nope',
      requestId: null,
      body: { detail: 'nope' },
    })
    expect(describeApiError(err)).toBe('404 nope')
  })
})
