import { describe, expect, it } from 'vitest'
import { connectability, resolveConnectSessionId } from '../src/commands/connect'
import type { AgentSession } from '../src/lib/types'

import { session } from './fixtures/session'

describe('resolveConnectSessionId', () => {
  it('prefers the positional argument', () => {
    expect(resolveConnectSessionId('session_abc', { ELLIPSIS_SESSION_ID: 'session_env' })).toBe(
      'session_abc',
    )
  })

  it('falls back to ELLIPSIS_SESSION_ID (the in-sandbox default)', () => {
    expect(resolveConnectSessionId(undefined, { ELLIPSIS_SESSION_ID: 'session_env' })).toBe(
      'session_env',
    )
  })

  it('errors with a hint when neither is available', () => {
    expect(() => resolveConnectSessionId(undefined, {})).toThrow(/agent session list/)
  })
})

describe('connectability', () => {
  it('sends when the server says prompting is enabled', () => {
    expect(connectability(session({ lifecycle: { prompting: { enabled: true } } }))).toEqual({ canSend: true })
  })

  it('is watch-only when the server refuses, quoting its reason', () => {
    const res = connectability(
      session({ lifecycle: { prompting: {
          enabled: false,
          blocked_reason: 'non_interactive',
          detail: 'This agent runs a workflow and takes no messages.',
        } } }),
    )
    expect(res.canSend).toBe(false)
    expect(res.reason).toContain('This agent runs a workflow')
    expect(res.reason).toMatch(/watch-only/)
  })

  it('falls back to a generic reason when the server sends no detail', () => {
    const res = connectability(session({ lifecycle: { prompting: { enabled: false } } }))
    expect(res.canSend).toBe(false)
    expect(res.reason).toMatch(/does not accept messages/)
  })
})
