import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../src/lib/api'
import {
  formatSearchResult,
  formatStepLine,
  resolveAuthorId,
  stepText,
} from '../src/commands/session'
import type {
  AgentSession,
  AgentStep,
  GithubAccountSnippet,
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

describe('getAgentSessionSteps', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('unwraps the steps array from the session-scoped path (encoded)', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ steps: [{ id: 'step_1' }] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const out = await new ApiClient('http://api.test', 't').getAgentSessionSteps('session/1')
    expect(out.map((s) => s.id)).toEqual(['step_1'])
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/v1/sessions/session%2F1/steps')
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

describe('stepText / formatStepLine', () => {
  const step = (data: Record<string, unknown>, overrides: Partial<AgentStep> = {}): AgentStep => ({
    id: 'step_1',
    created_at: '2026-07-03T12:00:00+00:00',
    step_index: 3,
    step_type: 'assistant',
    step_subtype: null,
    data,
    ...overrides,
  })

  it('reads a result step', () => {
    expect(stepText(step({ type: 'result', result: 'All tests pass.' }))).toBe('All tests pass.')
  })

  it('reads string message content', () => {
    expect(stepText(step({ message: { content: 'plain text' } }))).toBe('plain text')
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
    expect(stepText(step(data))).toBe(
      'check the auth flow Reading the file. [tool: Read] {"file_path":"src/auth.ts"}',
    )
  })

  it('unwraps nested tool_result content', () => {
    const data = {
      message: {
        content: [{ type: 'tool_result', content: [{ type: 'text', text: 'file contents' }] }],
      },
    }
    expect(stepText(step(data))).toBe('file contents')
  })

  it('falls back to the raw JSON for unknown payloads', () => {
    expect(stepText(step({ subtype: 'init' }))).toBe('{"subtype":"init"}')
  })

  it('formats one line with index, timestamp, type, and truncated text', () => {
    const line = formatStepLine(
      step(
        { message: { content: 'line one\nline two' } },
        { step_type: 'system', step_subtype: 'init' },
      ),
    )
    expect(line).toBe('   3  2026-07-03 12:00  system/init       line one line two')
  })

  it('truncates long text to about 120 characters', () => {
    const line = formatStepLine(step({ message: { content: 'x'.repeat(500) } }))
    expect(line.endsWith('...')).toBe(true)
    // 4 (index) + 16 (timestamp) + 16 (type) + separators + 120 of text.
    expect(line.length).toBe(42 + 120)
  })
})
