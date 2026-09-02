import { afterEach, describe, expect, it, vi } from 'vitest'
import { Ellipsis } from '@ellipsis-dev/sdk'
import { formatStepLine, recordText, resolveAuthorId } from '../src/commands/session'
import type { AgentSession, SessionRecord } from '../src/lib/types'

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session_1',
    created_at: '2026-07-03T12:00:00+00:00',
    updated_at: '2026-07-03T12:00:00+00:00',
    status: 'completed',
    status_reason: null,
    config_id: null,
    source: 'api',
    harness: 'claude_code',
    prompting: { enabled: true },
    budget: { cents: 0, source: 'system' },
    cost: { llm: 0, sandbox_cpu: 0, sandbox_memory: 0, fee: 0, total: 0 },
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0, model: '' },
    metadata: {},
    ...overrides,
  }
}

describe('getAgentSessionRecords', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('unwraps the records array from the session-scoped path (encoded)', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ records: [{ id: 'rec_1' }], messages: [], has_more: false }), {
          status: 200,
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const page = await new Ellipsis({
      apiKey: 't',
      baseUrl: 'http://api.test',
    }).sessions.records('session/1')
    expect(page.items.map((s) => s.id)).toEqual(['rec_1'])
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/v1/sessions/session%2F1/records')
  })
})

describe('resolveAuthorId', () => {
  const members = (logins: Array<[number, string | null]>) => ({
    integrations: {
      github: {
        members: vi.fn(async () => ({
          members: logins.map(([id, login]) => ({
            id,
            login,
            name: null,
            avatar_url: null,
            role: null,
            slack: null,
          })),
        })),
      },
    },
  })

  it('resolves a login to its account id, case-insensitively', async () => {
    const client = members([
      [1, 'octocat'],
      [2, 'hbrooks'],
    ]) as unknown as Ellipsis
    await expect(resolveAuthorId(client, 'HBrooks')).resolves.toBe(2)
  })

  it('rejects an unknown login listing the known ones', async () => {
    const client = members([
      [1, 'octocat'],
      [2, 'hbrooks'],
      [3, null], // roster rows without a cached login are skipped in the hint
    ]) as unknown as Ellipsis
    await expect(resolveAuthorId(client, 'tony')).rejects.toThrow(
      'no GitHub member with login "tony" (known logins: octocat, hbrooks)',
    )
  })

  it('omits the hint when no logins are known', async () => {
    const client = members([[3, null]]) as unknown as Ellipsis
    await expect(resolveAuthorId(client, 'tony')).rejects.toThrow(
      /no GitHub member with login "tony"$/,
    )
  })
})

describe('recordText / formatStepLine', () => {
  const record = (
    payload: Record<string, unknown>,
    overrides: Partial<SessionRecord> = {},
  ): SessionRecord => ({
    id: 'rec_1',
    agent_session_id: 'session_1',
    session_execution_id: 'exec_1',
    created_at: '2026-07-03T12:00:00+00:00',
    feed_seq: 3,
    stream_seq: 3,
    source: 'claude_code',
    record_type: (payload.kind as string) ?? 'assistant',
    record_format: 'claude_stream_json@2.0',
    payload,
    ...overrides,
  })

  it('reads a result record', () => {
    expect(recordText(record({ kind: 'result', result: 'All tests pass.' }))).toBe(
      'All tests pass.',
    )
  })

  it('reads string message content', () => {
    expect(recordText(record({ content: 'plain text' }))).toBe('plain text')
  })

  it('joins text/thinking blocks and summarizes tool calls', () => {
    const data = {
      content: [
        { type: 'thinking', thinking: 'check the auth flow' },
        { type: 'text', text: 'Reading the file.' },
        { type: 'tool_use', name: 'Read', input: { file_path: 'src/auth.ts' } },
      ],
    }
    expect(recordText(record(data))).toBe(
      'check the auth flow Reading the file. [tool: Read] {"file_path":"src/auth.ts"}',
    )
  })

  it('unwraps nested tool_result content', () => {
    const data = {
      content: [{ type: 'tool_result', content: [{ type: 'text', text: 'file contents' }] }],
    }
    expect(recordText(record(data))).toBe('file contents')
  })

  it('falls back to the raw JSON for unknown payloads', () => {
    expect(recordText(record({ subtype: 'init' }))).toBe('{"subtype":"init"}')
  })

  it('formats one line with index, timestamp, type, and truncated text', () => {
    // record_type + payload.subtype drive the type column; stream_seq the index.
    const line = formatStepLine(
      record(
        { subtype: 'init', content: 'line one\nline two' },
        { record_type: 'system' },
      ),
    )
    expect(line).toBe('   3  2026-07-03 12:00  system/init       line one line two')
  })

  it('renders a lifecycle record as its notification line', () => {
    const line = formatStepLine(
      record({}, { source: 'lifecycle', record_type: 'sandbox_ready', stream_seq: -2 }),
    )
    expect(line).toBe('  -2  2026-07-03 12:00  sandbox_ready     Sandbox ready')
  })

  it('renders sandbox_ready cache tier and setup-output chunks', () => {
    // sandbox_ready carries the image-cache tier so a slow start explains itself.
    const ready = formatStepLine(
      record(
        { repositories: ['acme/repo'], cache_tier: 'full' },
        { source: 'lifecycle', record_type: 'sandbox_ready', stream_seq: -2 },
      ),
    )
    expect(ready).toContain('Sandbox ready, acme/repo, full build')
    // A sandbox-output chunk reads as the script's latest non-empty line.
    const chunk = formatStepLine(
      record(
        { phase: 'setup', chunk: 3, lines: ['Installing pandas (3.0.3)', '  '] },
        { source: 'lifecycle', record_type: 'sandbox_output', stream_seq: -3 },
      ),
    )
    expect(chunk).toContain('setup, Installing pandas (3.0.3)')
  })

  it('truncates long text to about 120 characters', () => {
    const line = formatStepLine(record({ content: 'x'.repeat(500) }))
    expect(line.endsWith('...')).toBe(true)
    // 4 (index) + 16 (timestamp) + 16 (type) + separators + 120 of text.
    expect(line.length).toBe(42 + 120)
  })
})
