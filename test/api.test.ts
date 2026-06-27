import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError, buildQuery, errorDetail } from '../src/lib/api'

describe('buildQuery', () => {
  it('returns empty string for no/empty query', () => {
    expect(buildQuery()).toBe('')
    expect(buildQuery({})).toBe('')
  })

  it('skips undefined and null values', () => {
    expect(buildQuery({ a: 1, b: undefined, c: null })).toBe('?a=1')
  })

  it('repeats the key for array values (FastAPI list convention)', () => {
    expect(buildQuery({ source: ['cli', 'api'] })).toBe('?source=cli&source=api')
  })

  it('encodes values', () => {
    expect(buildQuery({ start: '2026-01-01T00:00:00+00:00' })).toContain(
      'start=2026-01-01T00%3A00%3A00%2B00%3A00',
    )
  })
})

describe('errorDetail', () => {
  it('extracts a string detail', async () => {
    const res = new Response(JSON.stringify({ detail: 'Invalid credentials' }), {
      status: 401,
    })
    expect(await errorDetail(res)).toBe('Invalid credentials')
  })

  it('stringifies a structured detail (FastAPI 422)', async () => {
    const res = new Response(JSON.stringify({ detail: [{ loc: ['query', 'limit'] }] }), {
      status: 422,
    })
    expect(await errorDetail(res)).toContain('limit')
  })

  it('falls back to status text for non-JSON bodies', async () => {
    const res = new Response('<html>oops</html>', { status: 502, statusText: 'Bad Gateway' })
    expect(await errorDetail(res)).toBe('Bad Gateway')
  })
})

describe('ApiClient.request', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends the bearer token and parses JSON', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const api = new ApiClient('http://api.test', 'tok_123')
    const out = await api.request<{ ok: boolean }>('GET', '/v1/me')

    expect(out).toEqual({ ok: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://api.test/v1/me')
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok_123' })
  })

  it('appends the query string', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ runs: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await new ApiClient('http://api.test', 't').listAgentRuns({ limit: 5, source: ['cli'] })
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/v1/agents/runs?limit=5&source=cli')
  })

  it('throws ApiError carrying status + server detail on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ detail: 'nope' }), { status: 403 })),
    )
    const api = new ApiClient('http://api.test', 't')
    await expect(api.whoami()).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
    })
    await expect(api.whoami()).rejects.toThrow(/403 nope/)
  })

  it('tolerates empty response bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    const api = new ApiClient('http://api.test', 't')
    await expect(api.request('DELETE', '/v1/whatever')).resolves.toBeUndefined()
  })

  it('exposes ApiError as an Error subclass', () => {
    const err = new ApiError(500, 'GET', '/x', 'boom')
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('GET /x failed: 500 boom')
  })
})

describe('ApiClient sandbox variables', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists variables and unwraps the response envelope', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ variables: [{ name: 'A', created_at: '', updated_at: '' }] }), {
          status: 200,
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const out = await new ApiClient('http://api.test', 't').listSandboxVariables()
    expect(out).toEqual([{ name: 'A', created_at: '', updated_at: '' }])
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/v1/sandboxes/variables')
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('GET')
  })

  it('PUTs the variables batch and returns the echoed list', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ variables: [] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await new ApiClient('http://api.test', 't').putSandboxVariables([{ name: 'TOKEN', value: 'x' }])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://api.test/v1/sandboxes/variables')
    expect((init as RequestInit).method).toBe('PUT')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      variables: [{ name: 'TOKEN', value: 'x' }],
    })
  })

  it('URL-encodes the name on delete', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ variables: [] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await new ApiClient('http://api.test', 't').deleteSandboxVariable('MY/VAR')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://api.test/v1/sandboxes/variables/MY%2FVAR')
    expect((init as RequestInit).method).toBe('DELETE')
  })
})
