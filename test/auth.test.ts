import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deviceLogin } from '../src/lib/auth'
import type { ApiClient } from '../src/lib/api'
import type { CliAuthPoll, CliAuthStart } from '../src/lib/types'

const START: CliAuthStart = {
  device_code: 'dev_abc',
  user_code: 'WXYZ-1234',
  verification_uri: 'https://app.test/cli-auth',
  verification_uri_complete: 'https://app.test/cli-auth?code=WXYZ-1234',
  interval: 1, // 1s between polls (Math.max(1, …) floor)
  expires_in: 10,
}

// Minimal fake satisfying the two methods deviceLogin uses.
function fakeApi(pollResults: CliAuthPoll[]): {
  api: ApiClient
  poll: ReturnType<typeof vi.fn>
} {
  const poll = vi.fn()
  for (const r of pollResults) poll.mockResolvedValueOnce(r)
  const api = {
    startCliAuth: vi.fn(async () => START),
    pollCliAuth: poll,
  } as unknown as ApiClient
  return { api, poll }
}

describe('deviceLogin', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('prompts once, then returns the token after polling through pending', async () => {
    const { api, poll } = fakeApi([
      { status: 'pending' },
      { status: 'approved', access_token: 'ellipsis_user_tok' },
    ])
    const onPrompt = vi.fn()
    const onPending = vi.fn()

    const promise = deviceLogin(api, { onPrompt, onPending })
    await vi.advanceTimersByTimeAsync(1000) // first sleep -> pending
    await vi.advanceTimersByTimeAsync(1000) // second sleep -> approved

    await expect(promise).resolves.toEqual({ token: 'ellipsis_user_tok' })
    expect(onPrompt).toHaveBeenCalledTimes(1)
    expect(onPrompt).toHaveBeenCalledWith(START)
    expect(onPending).toHaveBeenCalledTimes(1)
    expect(poll).toHaveBeenCalledTimes(2)
    expect(poll).toHaveBeenCalledWith('dev_abc')
  })

  it('rejects when the request is denied', async () => {
    const { api } = fakeApi([{ status: 'denied' }])
    const promise = deviceLogin(api, { onPrompt: vi.fn() })
    const assertion = expect(promise).rejects.toThrow(/denied/)
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
  })

  it('rejects when the request expires server-side', async () => {
    const { api } = fakeApi([{ status: 'expired' }])
    const promise = deviceLogin(api, { onPrompt: vi.fn() })
    const assertion = expect(promise).rejects.toThrow(/expired/)
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
  })

  it('errors if approved without a token', async () => {
    const { api } = fakeApi([{ status: 'approved' }])
    const promise = deviceLogin(api, { onPrompt: vi.fn() })
    const assertion = expect(promise).rejects.toThrow(/no token/)
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
  })

  it('times out once the deadline passes with no approval', async () => {
    // Always pending; expires_in is 10s.
    const poll = vi.fn().mockResolvedValue({ status: 'pending' } satisfies CliAuthPoll)
    const api = {
      startCliAuth: vi.fn(async () => START),
      pollCliAuth: poll,
    } as unknown as ApiClient

    const promise = deviceLogin(api, { onPrompt: vi.fn() })
    const assertion = expect(promise).rejects.toThrow(/Timed out/)
    await vi.advanceTimersByTimeAsync(12_000) // past expires_in
    await assertion
  })
})
