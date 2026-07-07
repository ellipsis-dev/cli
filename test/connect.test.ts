import { describe, expect, it } from 'vitest'
import { connectability, resolveConnectSessionId } from '../src/commands/connect'
import type { AgentSession } from '../src/lib/types'

function session(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: 'session_1',
    customer_id: 'c1',
    created_at: '2026-07-07T00:00:00Z',
    updated_at: '2026-07-07T00:00:00Z',
    status: 'running',
    status_reason: null,
    agent_config_id: null,
    cost_tokens: 0,
    cost_sandbox_cpu: 0,
    cost_sandbox_memory: 0,
    cost_fee: 0,
    tokens_total: 0,
    metadata: {},
    ...overrides,
  }
}

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
  it('durable open sessions can be sent to', () => {
    expect(
      connectability(session({ session_key: 'api:session_1', session_state: 'idle' })),
    ).toEqual({ canSend: true })
  })

  it('single-shot sessions (no key) are watch-only', () => {
    const res = connectability(session({ session_key: null }))
    expect(res.canSend).toBe(false)
    expect(res.reason).toMatch(/single-shot/)
  })

  it('sessions from servers that predate keying are watch-only', () => {
    // An older backend omits the field entirely; same treatment as null.
    const res = connectability(session({}))
    expect(res.canSend).toBe(false)
  })

  it('closed conversations are watch-only', () => {
    const res = connectability(
      session({ session_key: 'github_pr:1:2', session_state: 'closed' }),
    )
    expect(res.canSend).toBe(false)
    expect(res.reason).toMatch(/closed/)
  })
})
