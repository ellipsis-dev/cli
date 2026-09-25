import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderIdentity, tokenSource } from '../src/commands/auth'
import type { WhoAmI } from '../src/lib/types'

function base(overrides: Partial<WhoAmI> = {}): WhoAmI {
  return {
    customer_id: 'cust_1',
    customer_login: 'ellipsis-dev',
    user_id: null,
    gh_user: null,
    api_key_id: null,
    sandbox_id: null,
    ...overrides,
  }
}

describe('tokenSource', () => {
  it('follows resolveToken precedence: the environment beats the config file', () => {
    expect(tokenSource(true, true)).toBe('env')
    expect(tokenSource(true, false)).toBe('env')
    expect(tokenSource(false, true)).toBe('config')
    expect(tokenSource(false, false)).toBe('none')
  })
})

describe('renderIdentity', () => {
  let lines: string[]
  beforeEach(() => {
    lines = []
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      lines.push(String(msg))
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('shows the gh_user login alongside the id when resolved', () => {
    renderIdentity(
      base({
        user_id: '24214708',
        gh_user: { id: 24214708, login: 'hbrooks', name: 'Hunter' },
      }),
    )
    expect(lines).toContain('user:      hbrooks (24214708)')
  })

  it('falls back to the bare user id when gh_user is null', () => {
    renderIdentity(base({ user_id: '24214708', gh_user: null }))
    expect(lines).toContain('user:      24214708')
  })

  it('omits the user line entirely for api-key principals', () => {
    renderIdentity(base({ api_key_id: 'eak_123' }))
    expect(lines.some((l) => l.startsWith('user:'))).toBe(false)
    expect(lines).toContain('api key:   eak_123')
  })
})
