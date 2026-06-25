import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchRun } from '../src/commands/run'
import type { ApiClient } from '../src/lib/api'
import type { AgentRun, AgentRunStatus } from '../src/lib/types'

function run(status: AgentRunStatus): AgentRun {
  return {
    id: 'run_1',
    customer_id: 'c',
    created_at: '2026-06-25T00:00:00+00:00',
    updated_at: '2026-06-25T00:00:00+00:00',
    status,
    status_reason: null,
    agent_config_id: null,
    cost_tokens: 0,
    cost_sandbox_cpu: 0,
    cost_sandbox_memory: 0,
    cost_fee: 0,
    tokens_total: 0,
    metadata: {},
  }
}

describe('watchRun', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('polls until a terminal status, then stops', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(run('running'))
      .mockResolvedValueOnce(run('running'))
      .mockResolvedValueOnce(run('completed'))
    const api = { getAgentRun: get } as unknown as ApiClient

    const promise = watchRun(api, 'run_1', 1, true)
    await vi.advanceTimersByTimeAsync(1000) // 1st poll running -> sleep -> 2nd poll
    await vi.advanceTimersByTimeAsync(1000) // -> 3rd poll completed -> return
    await promise

    expect(get).toHaveBeenCalledTimes(3)
    expect(get).toHaveBeenCalledWith('run_1')
  })

  it('returns immediately when the run is already terminal', async () => {
    const get = vi.fn().mockResolvedValueOnce(run('error'))
    const api = { getAgentRun: get } as unknown as ApiClient

    await watchRun(api, 'run_1', 5, true) // no timer advance needed
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('treats stopped/cancelled as terminal', async () => {
    for (const status of ['stopped', 'cancelled'] as AgentRunStatus[]) {
      const get = vi.fn().mockResolvedValueOnce(run(status))
      const api = { getAgentRun: get } as unknown as ApiClient
      await watchRun(api, 'run_1', 5, true)
      expect(get).toHaveBeenCalledTimes(1)
    }
  })
})
