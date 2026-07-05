import { describe, expect, it } from 'vitest'
import { configUrl, sessionUrl } from '../src/lib/urls'

describe('sessionUrl', () => {
  it('builds the session detail path scoped by account login', () => {
    expect(sessionUrl('https://app.ellipsis.dev', 'octocat', 'session_8f2c')).toBe(
      'https://app.ellipsis.dev/octocat/sessions/session_8f2c',
    )
  })

  it('encodes the login and session id', () => {
    expect(sessionUrl('https://app.ellipsis.dev', 'a/b', 's d')).toBe(
      'https://app.ellipsis.dev/a%2Fb/sessions/s%20d',
    )
  })
})

describe('configUrl', () => {
  it('builds the agent (config) detail path scoped by account login', () => {
    expect(configUrl('https://app.ellipsis.dev', 'octocat', 'cfg_123')).toBe(
      'https://app.ellipsis.dev/octocat/agents/configs/cfg_123',
    )
  })
})
