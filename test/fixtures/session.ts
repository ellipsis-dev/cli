import type { AgentSession, SessionTurn } from '../../src/lib/types'

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T

// One turn of the fixture session; override the status (and the reason and
// detail an ended turn carries) per test.
export function turn(overrides: Partial<SessionTurn> = {}): SessionTurn {
  return {
    id: 'turn_1',
    index: 0,
    status: 'running',
    reason: null,
    detail: null,
    stopped: null,
    created_at: '2026-07-07T00:00:00Z',
    started_at: '2026-07-07T00:00:01Z',
    ended_at: null,
    cost: { llm: 0, cpu: 0, memory: 0, fee: 0, total: 0 },
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0, model: '' },
    ...overrides,
  }
}

export function session(overrides: DeepPartial<AgentSession> = {}): AgentSession {
  return {
    id: 'session_1',
    agent: null,
    source: 'api',
    claude_code: {},
    codex: null,
    budget: 0,
    cost: { llm: 0, cpu: 0, memory: 0, fee: 0, total: 0 },
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0, model: '' },
    metadata: {},
    archived: null,
    created_at: '2026-07-07T00:00:00Z',
    updated_at: '2026-07-07T00:00:00Z',
    turn: turn(),
    ...overrides,
    conversation: {
      state: 'open',
      interactive: true,
      warm: true,
      ...overrides.conversation,
      prompting: {
        enabled: true,
        blocked_reason: null,
        detail: null,
        surface_name: null,
        ...overrides.conversation?.prompting,
      },
    },
  } as AgentSession
}
