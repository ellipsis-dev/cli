import { mkdtempSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildStartOverride,
  exitCodeForStatus,
  fetchLogSegment,
  pollTurn,
  readConfigFile,
  turnStatusText,
  watchTurn,
} from '../src/commands/session'
import type { Ellipsis } from '@ellipsis-dev/sdk'
import type { SessionLogSegment, TurnStatus } from '../src/lib/types'

import { session as makeSession, turn as makeTurn } from './fixtures/session'

// A client whose turns.get answers each poll with the next status in order.
function turnsClient(statuses: TurnStatus[]): { client: Ellipsis; get: ReturnType<typeof vi.fn> } {
  const get = vi.fn()
  for (const status of statuses) get.mockResolvedValueOnce({ turn: makeTurn({ status }) })
  return { client: { sessions: { turns: { get } } } as unknown as Ellipsis, get }
}

describe('pollTurn', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    process.exitCode = 0
  })

  it('polls the turn until a final status, then stops', async () => {
    const { client, get } = turnsClient(['pending', 'running', 'completed'])

    const promise = pollTurn(client, 'session_1', 'turn_1', 1, true)
    await vi.advanceTimersByTimeAsync(1000) // 1st poll pending -> sleep -> 2nd poll
    await vi.advanceTimersByTimeAsync(1000) // -> 3rd poll completed -> return
    await promise

    expect(get).toHaveBeenCalledTimes(3)
    expect(get).toHaveBeenCalledWith('session_1', 'turn_1')
  })

  it('returns at once when the turn is already final', async () => {
    const { client, get } = turnsClient(['failed'])
    await pollTurn(client, 'session_1', 'turn_1', 5, true) // no timer advance needed
    expect(get).toHaveBeenCalledTimes(1)
  })

  it.each(['failed', 'stopped', 'cancelled'] as const)(
    'sets a failure exit code when the turn ended %s',
    async (status) => {
      const { client } = turnsClient([status])
      await pollTurn(client, 'session_1', 'turn_1', 5, true)
      expect(process.exitCode).toBe(1)
    },
  )

  it('leaves the exit code clean when the turn completed', async () => {
    const { client } = turnsClient(['completed'])
    await pollTurn(client, 'session_1', 'turn_1', 5, true)
    expect(process.exitCode).toBe(0)
  })
})

describe('watchTurn', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = 0
  })

  it('has nothing to wait for when the session has no turn', async () => {
    const { client, get } = turnsClient([])
    await watchTurn(client, makeSession({ turn: null }), { quiet: true })
    expect(get).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(0)
  })

  it('answers with the latest turn, without polling, when none is in progress', async () => {
    const { client, get } = turnsClient([])
    const failed = makeTurn({ status: 'failed', reason: 'budget_hit', detail: 'over budget' })
    await watchTurn(client, makeSession({ turn: failed }), { quiet: true })
    expect(get).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('waits on the turn in progress', async () => {
    const { client, get } = turnsClient(['completed'])
    await watchTurn(client, makeSession({ turn: makeTurn({ status: 'running' }) }), { quiet: true })
    expect(get).toHaveBeenCalledWith('session_1', 'turn_1')
    expect(process.exitCode).toBe(0)
  })
})

describe('turnStatusText / exitCodeForStatus', () => {
  it('names the status, with the reason and detail a failed turn carries', () => {
    expect(turnStatusText(makeTurn({ status: 'running' }))).toBe('running')
    expect(
      turnStatusText(
        makeTurn({ status: 'failed', reason: 'budget_hit', detail: 'The session reached its budget.' }),
      ),
    ).toBe('failed (budget_hit): The session reached its budget.')
    expect(turnStatusText(makeTurn({ status: 'stopped', detail: 'Stopped by hbrooks.' }))).toBe(
      'stopped: Stopped by hbrooks.',
    )
    expect(turnStatusText(null)).toBe('none')
  })

  it('exits 0 only for a completed turn', () => {
    expect(exitCodeForStatus('completed')).toBe(0)
    for (const status of ['failed', 'stopped', 'cancelled', 'running', 'pending']) {
      expect(exitCodeForStatus(status)).toBe(1)
    }
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
        repo: ['ellipsis-dev/ellipsis', 'solo'],
        cpu: 2,
        memory: '8GB',
        timeout: '30m',
        budget: 0.5,
      }),
    ).toEqual({
      claude_code: { model: 'claude-opus-4-8' },
      environment: {
        compute: { cpu: 2, memory: '8GB', timeout: '30m' },
      },
      // --repo is the request's additive key, not part of the environment
      // block, so it joins whichever environment resolves (and composes with -e).
      repositories: ['ellipsis-dev/ellipsis', 'solo'],
      budget: 0.5,
    })
  })

  it('rejects a malformed --repo', () => {
    expect(() => buildStartOverride({ repo: ['a/b/c'] })).toThrow(/owner\/name/)
  })

  it('deep-merges sugar flags on top of a raw inline override (flags win)', () => {
    expect(
      buildStartOverride({
        override: 'claude_code:\n  model: claude-haiku-4-5-20251001\n  effort: high\n  prompt: base',
        model: 'claude-opus-4-8',
      }),
    ).toEqual({
      claude_code: { model: 'claude-opus-4-8', effort: 'high', prompt: 'base' },
    })
  })

  it('uses a file override as the base', () => {
    const path = write('base.yaml', 'budget:\n  session: 1\n')
    expect(buildStartOverride({ overrideFile: path, budget: 5 })).toEqual({
      budget: 5,
    })
  })

  it('rejects both inline and file override forms', () => {
    const path = write('both.yaml', 'enabled: false\n')
    expect(() =>
      buildStartOverride({ override: 'enabled: false', overrideFile: path }),
    ).toThrow(/only one of --override \/ --override-file/)
  })

  it('rejects a non-mapping inline override', () => {
    expect(() => buildStartOverride({ override: '- a\n- b\n' })).toThrow(
      /config override must be a mapping/,
    )
  })

  it('rejects a malformed --repo value', () => {
    expect(() => buildStartOverride({ repo: ['a/b/c'] })).toThrow(/must be "name" or "owner\/name"/)
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

// Regression: `[prompt]` was a single positional, so an unquoted
// `ellipsis fix the tests` sent just "fix" and dropped the rest silently.
describe('session start prompt positional', () => {
  async function startedPrompt(argv: string[]): Promise<string | undefined> {
    const { Command } = await import('commander')
    const { registerSession } = await import('../src/commands/session')
    // Read the prompt off the wire: the SDK client is generated, so the body it
    // POSTs is the only place the CLI's own assembly is observable.
    let seen: string | undefined
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen = JSON.parse(init?.body as string).claude_code?.prompt
      return new Response(JSON.stringify({ session: makeSession() }), { status: 201 })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const program = new Command()
    program.exitOverride()
    registerSession(program)
    try {
      await program.parseAsync(['node', 'ellipsis', 'session', 'start', ...argv, '--json'])
    } finally {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
    return seen
  }

  it('joins an unquoted multi-word prompt into one instruction', async () => {
    expect(await startedPrompt(['fix', 'the', 'tests'])).toBe('fix the tests')
  })

  it('keeps a quoted prompt intact', async () => {
    expect(await startedPrompt(['fix the tests'])).toBe('fix the tests')
  })

  it('still separates trailing flags from the prompt', async () => {
    expect(await startedPrompt(['fix', 'the', 'tests', '--model', 'claude-fable-5'])).toBe(
      'fix the tests',
    )
  })

  it('leaves a promptless start without a prompt', async () => {
    expect(await startedPrompt([])).toBeUndefined()
  })
})
