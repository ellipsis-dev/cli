import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '../src/lib/api'
import {
  friendlyErrorMessage,
  relativeAge,
  usd,
  usdFromMillicents,
  usdNumberFromMillicents,
} from '../src/lib/output'

describe('usdFromMillicents', () => {
  it('converts millicents to dollars (1 cent = 1000 millicents)', () => {
    expect(usdFromMillicents(0)).toBe('$0.00')
    expect(usdFromMillicents(100_000)).toBe('$1.00') // 100 cents
    expect(usdFromMillicents(12_345_000)).toBe('$123.45')
  })
})

describe('usdNumberFromMillicents', () => {
  it('converts millicents to a USD number for math before formatting', () => {
    expect(usdNumberFromMillicents(0)).toBe(0)
    expect(usdNumberFromMillicents(100_000)).toBe(1)
    expect(usdNumberFromMillicents(12_345_000)).toBeCloseTo(123.45)
  })
})

describe('relativeAge', () => {
  const now = new Date('2026-07-06T12:00:00Z')

  it('renders coarse relative ages', () => {
    expect(relativeAge('2026-07-06T11:59:30Z', now)).toBe('just now')
    expect(relativeAge('2026-07-06T11:58:00Z', now)).toBe('2 minutes ago')
    expect(relativeAge('2026-07-06T09:00:00Z', now)).toBe('3 hours ago')
    expect(relativeAge('2026-07-05T11:00:00Z', now)).toBe('1 day ago')
    expect(relativeAge('2026-05-20T12:00:00Z', now)).toBe('1 month ago')
    expect(relativeAge('2024-07-06T12:00:00Z', now)).toBe('2 years ago')
  })

  it('clamps future timestamps (clock skew) to "just now"', () => {
    expect(relativeAge('2026-07-06T12:05:00Z', now)).toBe('just now')
  })
})

describe('usd', () => {
  it('formats dollar amounts to two decimals', () => {
    expect(usd(0)).toBe('$0.00')
    expect(usd(9.5)).toBe('$9.50')
    expect(usd(100)).toBe('$100.00')
  })
})

describe('friendlyErrorMessage', () => {
  beforeEach(() => {
    delete process.env.ELLIPSIS_API_TOKEN
  })
  afterEach(() => {
    delete process.env.ELLIPSIS_API_TOKEN
  })

  it('maps a 401 to a re-login hint instead of the raw HTTP failure', () => {
    const err = new ApiError(401, 'GET', '/v1/me', 'Unauthorized', 'req_1')
    expect(friendlyErrorMessage(err)).toBe(
      'Your login is invalid or has expired. Run `agent login` to re-authenticate.',
    )
  })

  it('blames ELLIPSIS_API_TOKEN when the rejected credential came from the env', () => {
    process.env.ELLIPSIS_API_TOKEN = 'stale_tok'
    const err = new ApiError(401, 'GET', '/v1/me', 'Unauthorized')
    expect(friendlyErrorMessage(err)).toMatch(/ELLIPSIS_API_TOKEN/)
  })

  it('passes other ApiErrors through with the server detail intact', () => {
    const err = new ApiError(409, 'POST', '/v1/sessions/s_1/messages', 'Session is closed')
    expect(friendlyErrorMessage(err)).toBe(
      'POST /v1/sessions/s_1/messages failed: 409 Session is closed',
    )
  })

  it('passes plain errors through unchanged', () => {
    expect(friendlyErrorMessage(new Error('boom'))).toBe('boom')
  })
})
