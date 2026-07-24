import { mkdtempSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyConfigOverride,
  buildStartOverride,
  fetchLogSegment,
  readConfigFile,
  watchSession,
} from '../src/commands/session'
import type { ApiClient } from '../src/lib/api'
import type { AgentSession, AgentSessionStatus, SessionLogSegment } from '../src/lib/types'

function session(status: AgentSessionStatus): AgentSession {
  return {
    id: 'session_1',
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

describe('watchSession', () => {
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
      .mockResolvedValueOnce(session('running'))
      .mockResolvedValueOnce(session('running'))
      .mockResolvedValueOnce(session('completed'))
    const api = { getAgentSession: get } as unknown as ApiClient

    const promise = watchSession(api, 'session_1', 1, true)
    await vi.advanceTimersByTimeAsync(1000) // 1st poll running -> sleep -> 2nd poll
    await vi.advanceTimersByTimeAsync(1000) // -> 3rd poll completed -> return
    await promise

    expect(get).toHaveBeenCalledTimes(3)
    expect(get).toHaveBeenCalledWith('session_1')
  })

  it('returns immediately when the session is already terminal', async () => {
    const get = vi.fn().mockResolvedValueOnce(session('error'))
    const api = { getAgentSession: get } as unknown as ApiClient

    await watchSession(api, 'session_1', 5, true) // no timer advance needed
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('treats stopped/cancelled as terminal', async () => {
    for (const status of ['stopped', 'cancelled'] as AgentSessionStatus[]) {
      const get = vi.fn().mockResolvedValueOnce(session(status))
      const api = { getAgentSession: get } as unknown as ApiClient
      await watchSession(api, 'session_1', 5, true)
      expect(get).toHaveBeenCalledTimes(1)
    }
  })

  it('sets a failure exit code on a non-completed terminal status (for --wait)', async () => {
    process.exitCode = 0
    const get = vi.fn().mockResolvedValueOnce(session('error'))
    const api = { getAgentSession: get } as unknown as ApiClient
    await watchSession(api, 'session_1', 5, true)
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it('leaves the exit code clean on a completed status', async () => {
    process.exitCode = 0
    const get = vi.fn().mockResolvedValueOnce(session('completed'))
    const api = { getAgentSession: get } as unknown as ApiClient
    await watchSession(api, 'session_1', 5, true)
    expect(process.exitCode).toBe(0)
    process.exitCode = 0
  })
})

describe('readConfigFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'))
  const write = (name: string, body: string): string => {
    const path = join(dir, name)
    writeFileSync(path, body)
    return path
  }

  it('parses a .yaml file', () => {
    const path = write('cfg.yaml', 'name: demo\nbudget:\n  session: 5\n')
    expect(readConfigFile(path)).toEqual({ name: 'demo', budget: { session: 5 } })
  })

  it('parses a .yml file', () => {
    const path = write('cfg.yml', 'name: demo\n')
    expect(readConfigFile(path)).toEqual({ name: 'demo' })
  })

  it('parses a .json file', () => {
    const path = write('cfg.json', '{"name":"demo","budget":{"session":5}}')
    expect(readConfigFile(path)).toEqual({ name: 'demo', budget: { session: 5 } })
  })

  it('falls back to YAML for unknown extensions (JSON is valid YAML)', () => {
    const path = write('cfg.txt', '{"name":"demo"}')
    expect(readConfigFile(path)).toEqual({ name: 'demo' })
  })

  it('rejects a JSON file containing invalid JSON', () => {
    const path = write('bad.json', 'name: demo')
    expect(() => readConfigFile(path)).toThrow(/could not parse JSON config file/)
  })

  it('rejects a non-mapping top-level value', () => {
    const path = write('list.yaml', '- a\n- b\n')
    expect(() => readConfigFile(path)).toThrow(/could not parse YAML config file/)
  })

  it('errors clearly when the file is missing', () => {
    expect(() => readConfigFile(join(dir, 'nope.yaml'))).toThrow(/could not read config file/)
  })
})

describe('applyConfigOverride', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-override-'))
  const write = (name: string, body: string): string => {
    const path = join(dir, name)
    writeFileSync(path, body)
    return path
  }

  it('passes an inline override through as the YAML/JSON string', () => {
    const req: { config_override?: Record<string, unknown>; config_override_yaml?: string } = {}
    applyConfigOverride(req, { configOverride: 'claude:\n  model: claude-opus-4-8' })
    expect(req).toEqual({ config_override_yaml: 'claude:\n  model: claude-opus-4-8' })
  })

  it('reads and parses a file override into the structured mapping', () => {
    const path = write('override.yaml', 'budget:\n  session: 5\n')
    const req: { config_override?: Record<string, unknown>; config_override_yaml?: string } = {}
    applyConfigOverride(req, { configOverrideFile: path })
    expect(req).toEqual({ config_override: { budget: { session: 5 } } })
  })

  it('rejects passing both inline and file forms', () => {
    const path = write('both.yaml', 'enabled: false\n')
    expect(() =>
      applyConfigOverride({}, { configOverride: 'enabled: false', configOverrideFile: path }),
    ).toThrow(/only one of --config-override \/ --config-override-file/)
  })

  it('is a no-op when neither form is given', () => {
    const req: { config_override?: Record<string, unknown>; config_override_yaml?: string } = {}
    applyConfigOverride(req, {})
    expect(req).toEqual({})
  })

  it('surfaces an override-specific error when the file is missing', () => {
    expect(() => applyConfigOverride({}, { configOverrideFile: join(dir, 'nope.yaml') })).toThrow(
      /could not read config override file/,
    )
  })

  it('surfaces an override-specific error for a non-mapping file', () => {
    const path = write('list.yaml', '- a\n- b\n')
    expect(() => applyConfigOverride({}, { configOverrideFile: path })).toThrow(
      /could not parse YAML config override file/,
    )
  })
})

describe('buildStartOverride', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-start-override-'))
  const write = (name: string, body: string): string => {
    const path = join(dir, name)
    writeFileSync(path, body)
    return path
  }

  it('returns undefined when nothing is set', () => {
    expect(buildStartOverride({})).toBeUndefined()
  })

  it('maps each sugar flag to its config path', () => {
    expect(
      buildStartOverride({
        model: 'claude-opus-4-8',
        system: 'do the thing',
        repo: ['ellipsis-dev/ellipsis', 'solo'],
        cpu: 2,
        memory: '8GB',
        timeout: '30m',
        budget: 0.5,
      }),
    ).toEqual({
      claude: { model: 'claude-opus-4-8', system: 'do the thing' },
      sandbox: {
        compute: { cpu: 2, memory: '8GB', timeout: '30m' },
        repositories: [{ owner: 'ellipsis-dev', name: 'ellipsis' }, { name: 'solo' }],
      },
      budget: { session: 0.5 },
    })
  })

  it('deep-merges sugar flags on top of a raw inline override (flags win)', () => {
    expect(
      buildStartOverride({
        configOverride: 'claude:\n  model: claude-haiku-4-5-20251001\n  system: base\nenabled: false',
        model: 'claude-opus-4-8',
      }),
    ).toEqual({
      claude: { model: 'claude-opus-4-8', system: 'base' },
      enabled: false,
    })
  })

  it('uses a file override as the base', () => {
    const path = write('base.yaml', 'budget:\n  session: 1\n')
    expect(buildStartOverride({ configOverrideFile: path, budget: 5 })).toEqual({
      budget: { session: 5 },
    })
  })

  it('rejects both inline and file override forms', () => {
    const path = write('both.yaml', 'enabled: false\n')
    expect(() =>
      buildStartOverride({ configOverride: 'enabled: false', configOverrideFile: path }),
    ).toThrow(/only one of --config-override \/ --config-override-file/)
  })

  it('rejects a non-mapping inline override', () => {
    expect(() => buildStartOverride({ configOverride: '- a\n- b\n' })).toThrow(
      /config override must be a mapping/,
    )
  })

  it('rejects a malformed --repo value', () => {
    expect(() => buildStartOverride({ repo: ['a/b/c'] })).toThrow(/--repo must be/)
  })
})

describe('fetchLogSegment', () => {
  const segment = (overrides: Partial<SessionLogSegment> = {}): SessionLogSegment => ({
    start_feed_seq: 1,
    end_feed_seq: 10,
    record_count: 10,
    bytes: 100,
    download_url: 'https://s3.example.com/signed',
    expires_in: 60,
    ...overrides,
  })
  const gzipped = gzipSync(Buffer.from('{"a":1}\n{"b":2}\n'))

  afterEach(() => vi.unstubAllGlobals())

  it('returns the raw gzip bytes as-is (concatenation + gunzip is the caller)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(gzipped), { status: 200 })),
    )
    const out = await fetchLogSegment(segment())
    expect(Buffer.compare(out, gzipped)).toBe(0)
  })

  it('maps a storage 404 to the retention explanation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    await expect(fetchLogSegment(segment())).rejects.toThrow(/log retention/)
  })

  it('maps a 403 to the expired-URL hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })))
    await expect(fetchLogSegment(segment())).rejects.toThrow(/presigned URL likely expired/)
  })
})
