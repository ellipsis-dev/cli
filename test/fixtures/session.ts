import type { AgentSession } from '../../src/lib/types'

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T

export function session(overrides: DeepPartial<AgentSession> = {}): AgentSession {
  return {
    id: 'session_1',
    agent: null,
    source: 'api',
    claude_code: {},
    codex: null,
    budget: 0,
    cost: { llm: 0, sandbox_cpu: 0, sandbox_memory: 0, fee: 0, total: 0 },
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0, model: '' },
    metadata: {},
    ...overrides,
    lifecycle: {
      status: 'working',
      conversation: 'open',
      interactive: true,
      detail: null,
      last_execution_result: null,
      archived: null,
      stopped: null,
      ...overrides.lifecycle,
      prompting: { enabled: true, blocked_reason: null, detail: null, surface_name: null, ...overrides.lifecycle?.prompting },
      timestamps: {
        created_at: '2026-07-07T00:00:00Z',
        updated_at: '2026-07-07T00:00:00Z',
        last_activity_at: null,
        last_message_at: null,
        ...overrides.lifecycle?.timestamps,
      },
    },
  } as AgentSession
}
