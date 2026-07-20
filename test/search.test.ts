import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../src/lib/api'
import {
  formatSearchResult,
  formatStepLine,
  recordText,
  resolveAuthorId,
} from '../src/commands/session'
import type {
  AgentSession,
  GithubAccountSnippet,
  SessionRecord,
  SessionSearchResult,
} from '../src/lib/types'

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session_1',
    customer_id: 'c',
    created_at: '2026-07-03T12:00:00+00:00',
    updated_at: '2026-07-03T12:00:00+00:00',
    status: 'completed',
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

describe('searchSessions', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('GETs /v1/sessions/search with repeated facet keys', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ results: [], attributed_users: {} }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await new ApiClient('http://api.test', 't').searchSessions({
      q: 'shift trade webhook',
      scope: 'both',
      author_id: [5201153],
      source: ['laptop', 'cli'],
      session_ids: ['session_1', 'session_2'],
      limit: 20,
    })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('http://api.test/v1/sessions/search?')
    expect(url).toContain('q=shift+trade+webhook')
    expect(url).toContain('scope=both')
    expect(url).toContain('author_id=5201153')
    expect(url).toContain('source=laptop&source=cli')
    expect(url).toContain('session_ids=session_1&session_ids=session_2')
    expect(url).toContain('limit=20')
  })
})

describe('getAgentSessionRecords', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('unwraps the records array from the session-scoped path (encoded)', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ records: [{ id: 'rec_1' }] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const out = await new ApiClient('http://api.test', 't').getAgentSessionRecords('session/1')
    expect(out.map((s) => s.id)).toEqual(['rec_1'])
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/v1/sessions/session%2F1/records')
  })
})

describe('resolveAuthorId', () => {
  const members = (logins: Array<[number, string | null]>) => ({
    listGithubMembers: vi.fn(async () => ({
      members: logins.map(([id, login]) => ({
        id,
        login,
        name: null,
        avatar_url: null,
        role: null,
        slack: null,
      })),
    })),
  })

  it('resolves a login to its account id, case-insensitively', async () => {
    const api = members([
      [1, 'octocat'],
      [2, 'hbrooks'],
    ]) as unknown as ApiClient
    await expect(resolveAuthorId(api, 'HBrooks')).resolves.toBe(2)
  })

  it('rejects an unknown login listing the known ones', async () => {
    const api = members([
      [1, 'octocat'],
      [2, 'hbrooks'],
      [3, null], // roster rows without a cached login are skipped in the hint
    ]) as unknown as ApiClient
    await expect(resolveAuthorId(api, 'tony')).rejects.toThrow(
      'no GitHub member with login "tony" (known logins: octocat, hbrooks)',
    )
  })

  it('omits the hint when no logins are known', async () => {
    const api = members([[3, null]]) as unknown as ApiClient
    await expect(resolveAuthorId(api, 'tony')).rejects.toThrow(
      /no GitHub member with login "tony"$/,
    )
  })
})

describe('formatSearchResult', () => {
  const now = new Date('2026-07-06T12:00:00Z')
  const users: Record<string, GithubAccountSnippet> = {
    '5201153': { id: 5201153, login: 'hbrooks', type: 'User', avatar_url: '' },
  }

  it('renders header, author, age, matched arms, and the recap snippet', () => {
    const result: SessionSearchResult = {
      session: session({ attribution_id: '5201153' }),
      matched: ['recap', 'similar'],
      recap_snippet: 'looked into the shift trade webhook retries',
      step_hits: [],
      step_hit_count: 0,
    }
    expect(formatSearchResult(result, users, now)).toEqual([
      'session_1  completed  hbrooks  3 days ago  matched: recap, similar',
      '    looked into the shift trade webhook retries',
    ])
  })

  it('falls back to the best step snippet and shows the hit count', () => {
    const result: SessionSearchResult = {
      session: session(),
      matched: ['steps'],
      recap_snippet: null,
      step_hits: [
        {
          step_id: 'step_1',
          agent_session_id: 'session_1',
          step_index: 4,
          step_type: 'assistant',
          step_subtype: null,
          created_at: '2026-07-03T12:00:00+00:00',
          snippet: 'the webhook retries three times',
        },
      ],
      step_hit_count: 7,
    }
    expect(formatSearchResult(result, users, now)).toEqual([
      'session_1  completed  3 days ago  matched: steps',
      '    the webhook retries three times',
      '    7 matching steps',
    ])
  })

  it('omits the snippet line when no arm produced one (pr/similar only)', () => {
    const result: SessionSearchResult = {
      session: session(),
      matched: ['pr'],
      recap_snippet: null,
      step_hits: [],
      step_hit_count: 0,
    }
    expect(formatSearchResult(result, users, now)).toEqual([
      'session_1  completed  3 days ago  matched: pr',
    ])
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
    record_type: (payload.type as string) ?? 'assistant',
    record_format: 'claude_stream_json@2.0',
    payload,
    ...overrides,
  })

  it('reads a result record', () => {
    expect(recordText(record({ type: 'result', result: 'All tests pass.' }))).toBe(
      'All tests pass.',
    )
  })

  it('reads string message content', () => {
    expect(recordText(record({ message: { content: 'plain text' } }))).toBe('plain text')
  })

  it('joins text/thinking blocks and summarizes tool calls', () => {
    const data = {
      message: {
        content: [
          { type: 'thinking', thinking: 'check the auth flow' },
          { type: 'text', text: 'Reading the file.' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/auth.ts' } },
        ],
      },
    }
    expect(recordText(record(data))).toBe(
      'check the auth flow Reading the file. [tool: Read] {"file_path":"src/auth.ts"}',
    )
  })

  it('unwraps nested tool_result content', () => {
    const data = {
      message: {
        content: [{ type: 'tool_result', content: [{ type: 'text', text: 'file contents' }] }],
      },
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
        { subtype: 'init', message: { content: 'line one\nline two' } },
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
    expect(ready).toContain('Sandbox ready · acme/repo · full build')
    // A setup-output chunk reads as the script's latest non-empty line.
    const chunk = formatStepLine(
      record(
        { hook: 'image.setup', chunk: 3, lines: ['Installing pandas (3.0.3)', '  '] },
        { source: 'lifecycle', record_type: 'sandbox_setup_output', stream_seq: -3 },
      ),
    )
    expect(chunk).toContain('image.setup · Installing pandas (3.0.3)')
  })

  it('truncates long text to about 120 characters', () => {
    const line = formatStepLine(record({ message: { content: 'x'.repeat(500) } }))
    expect(line.endsWith('...')).toBe(true)
    // 4 (index) + 16 (timestamp) + 16 (type) + separators + 120 of text.
    expect(line.length).toBe(42 + 120)
  })
})
