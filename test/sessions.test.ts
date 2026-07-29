import { describe, expect, it } from 'vitest'
import {
  attentionFlip,
  compactTokens,
  COMPOSER_MODELS,
  composerModelOptions,
  connectability,
  isActiveStatusWord,
  lastEventAt,
  navSlice,
  rowDescription,
  rowGlyph,
  rowMeta,
  rowStatusWord,
  sessionSource,
  shortAge,
  sidebarSlice,
  sortSidebarSessions,
  statusBand,
  mergeSidebarSessions,
} from '../src/lib/sessions'
import { theme } from '../src/lib/theme'
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

describe('connectability', () => {
  it('opens keyed live sessions for sending', () => {
    expect(connectability(session({ session_key: 'api:x', session_state: 'running' }))).toEqual({
      canSend: true,
    })
  })

  it('is watch-only for single-shot sessions', () => {
    const c = connectability(session({ session_key: null }))
    expect(c.canSend).toBe(false)
    expect(c.reason).toMatch(/single-shot/)
  })

  it('is watch-only for closed conversations', () => {
    const c = connectability(session({ session_key: 'api:x', session_state: 'closed' }))
    expect(c.canSend).toBe(false)
    expect(c.reason).toMatch(/closed/)
  })

  it('honors the server prompting projection over the local keyed read', () => {
    // A Slack mention session is keyed and live — the old local rule called it
    // sendable — but its answers post back to the Slack thread, so the server
    // refuses direct messages and we open watch-only instead of offering a
    // composer whose first Enter would 409.
    const c = connectability(
      session({
        session_key: 'slack:D1:1.1',
        session_state: 'idle',
        prompting: {
          enabled: false,
          blocked_reason: 'mention_surface',
          detail: 'This conversation lives on Slack. Reply there to steer the agent.',
          surface_name: 'Slack',
        },
      }),
    )
    expect(c.canSend).toBe(false)
    // The server's own sentence is shown verbatim, so the reason names Slack.
    expect(c.reason).toContain('This conversation lives on Slack.')
    expect(c.reason).toMatch(/watch-only/)
  })

  it('sends when the server says prompting is enabled', () => {
    const c = connectability(
      session({
        session_key: 'api:x',
        session_state: 'idle',
        prompting: {
          enabled: true,
          blocked_reason: null,
          detail: null,
          surface_name: null,
        },
      }),
    )
    expect(c).toEqual({ canSend: true })
  })

  it('falls back to the local read against servers with no prompting field', () => {
    // Older deployments omit `prompting`; a keyed live session must still open
    // with a composer rather than silently going watch-only.
    expect(connectability(session({ session_key: 'api:x', session_state: 'idle' }))).toEqual({
      canSend: true,
    })
  })

  it('is watch-only with generic copy when the server sends no detail', () => {
    const c = connectability(
      session({
        session_key: 'api:x',
        session_state: 'idle',
        prompting: { enabled: false, blocked_reason: 'non_interactive', detail: null },
      }),
    )
    expect(c.canSend).toBe(false)
    expect(c.reason).toMatch(/does not accept messages/)
  })
})

describe('rowStatusWord / rowGlyph', () => {
  it('prefers the surface projection over the raw status', () => {
    const s = session({
      status: 'running',
      surface: { session: 'alive', run: 'working', status: 'waiting' },
    })
    expect(rowStatusWord(s)).toBe('waiting')
  })

  it('falls back to the raw status without a surface', () => {
    expect(rowStatusWord(session({ status: 'completed' }))).toBe('completed')
  })

  it('is always a dot — status is told by color, the arrow means selection', () => {
    for (const word of ['working', 'waiting', 'sleeping', 'failed', 'stopped', 'completed']) {
      expect(rowGlyph(word).glyph).toBe('●')
    }
  })

  it('colors in-flight amber, waiting with the accent, sleeping dim', () => {
    expect(rowGlyph('working')).toEqual({ glyph: '●', color: theme.active, dim: false })
    expect(isActiveStatusWord('working')).toBe(true)
    expect(rowGlyph('waiting').color).toBe(theme.foreground)
    expect(rowGlyph('sleeping')).toEqual({ glyph: '●', dim: true })
  })

  it('colors failures with the error token and settles the rest as done', () => {
    expect(rowGlyph('failed').color).toBe(theme.error)
    expect(rowGlyph('error')).toEqual({ glyph: '●', color: theme.error, dim: false })
    expect(rowGlyph('stopped')).toEqual({ glyph: '●', color: theme.error, dim: true })
    expect(rowGlyph('completed').color).toBe(theme.success)
    expect(rowGlyph('closed').color).toBe(theme.success)
  })
})

describe('rowDescription', () => {
  it('prefers the live summary, collapsed to one line', () => {
    const s = session({ live_summary: 'fixing the\n  webhook tests', prompt: 'do a thing' })
    expect(rowDescription(s)).toBe('fixing the webhook tests')
  })

  it('falls back to the prompt, then the source', () => {
    expect(rowDescription(session({ prompt: 'fix the tests' }))).toBe('fix the tests')
    expect(rowDescription(session({ source: 'react' }))).toBe('react session')
    expect(rowDescription(session({}))).toBe('session')
  })

  it('ignores whitespace-only summaries', () => {
    expect(rowDescription(session({ live_summary: '  \n ', prompt: 'p' }))).toBe('p')
  })
})

describe('lastEventAt / shortAge', () => {
  it('prefers last_activity_at, then last_message_at, then updated_at', () => {
    expect(
      lastEventAt(
        session({ last_activity_at: 'A', last_message_at: 'B', updated_at: 'C' } as never),
      ),
    ).toBe('A')
    expect(lastEventAt(session({ last_message_at: 'B', updated_at: 'C' } as never))).toBe('B')
    expect(lastEventAt(session({ updated_at: 'C' }))).toBe('C')
  })

  it('renders compact ages and never goes negative', () => {
    const now = new Date('2026-07-23T12:00:00Z')
    expect(shortAge('2026-07-23T11:59:48Z', now)).toBe('12s ago')
    expect(shortAge('2026-07-23T11:58:00Z', now)).toBe('2m ago')
    expect(shortAge('2026-07-23T09:00:00Z', now)).toBe('3h ago')
    expect(shortAge('2026-07-18T12:00:00Z', now)).toBe('5d ago')
    expect(shortAge('2026-07-23T12:00:05Z', now)).toBe('0s ago')
  })
})

describe('compactTokens', () => {
  it('scales the unit and drops noise decimals', () => {
    expect(compactTokens(0)).toBe('0')
    expect(compactTokens(840)).toBe('840')
    expect(compactTokens(4800)).toBe('4.8k')
    expect(compactTokens(84_200)).toBe('84.2k')
    expect(compactTokens(12_000)).toBe('12k')
    expect(compactTokens(512_000)).toBe('512k')
    expect(compactTokens(1_240_000)).toBe('1.24M')
    expect(compactTokens(2_000_000)).toBe('2M')
  })
})

describe('rowMeta', () => {
  const now = new Date('2026-07-23T12:00:00Z')

  it('reads turns, tokens, spend, and age', () => {
    const s = session({
      tokens_info: { num_turns: 12 },
      tokens_total: 84_200,
      cost_tokens: 30_000,
      cost_sandbox_cpu: 10_000,
      cost_sandbox_memory: 2_000,
      cost_fee: 0,
      updated_at: '2026-07-23T11:58:00Z',
    } as never)
    expect(rowMeta(s, now)).toBe('12 turns · 84.2k · $0.42 · 2m ago')
  })

  it('says "1 turn", not "1 turns"', () => {
    const s = session({
      tokens_info: { num_turns: 1 },
      updated_at: '2026-07-23T11:58:00Z',
    } as never)
    expect(rowMeta(s, now)).toBe('1 turn · 2m ago')
  })

  it('drops the work bits a fresh session has none of', () => {
    const s = session({ updated_at: '2026-07-23T11:59:48Z' })
    expect(rowMeta(s, now)).toBe('12s ago')
  })
})

describe('sessionSource', () => {
  it('reads laptop off the input blob, which is where the list row carries it', () => {
    expect(sessionSource(session({ input: { source: 'laptop' } } as never))).toBe('laptop')
    expect(sessionSource(session({ source: 'laptop' }))).toBe('laptop')
    expect(sessionSource(session({ input: { source: 'react' } } as never))).toBe('cloud')
    expect(sessionSource(session({}))).toBe('cloud')
  })
})

describe('statusBand / sortSidebarSessions', () => {
  // A row per band, deliberately born newest-first-is-wrong-order so a
  // recency sort can't accidentally pass.
  const waiting = session({
    id: 'waiting',
    created_at: '2026-07-20T00:00:00Z',
    surface: { session: 'alive', run: 'waiting', status: 'waiting' },
  })
  const working = session({
    id: 'working',
    created_at: '2026-07-21T00:00:00Z',
    surface: { session: 'alive', run: 'working', status: 'working' },
  })
  const sleeping = session({
    id: 'sleeping',
    created_at: '2026-07-22T00:00:00Z',
    surface: { session: 'sleeping', run: 'done', status: 'sleeping' },
  })
  const done = session({ id: 'done', created_at: '2026-07-23T00:00:00Z', status: 'completed' })
  const failed = session({ id: 'failed', created_at: '2026-07-24T00:00:00Z', status: 'error' })

  it('bands by status: live, parked, done, dead', () => {
    expect(sortSidebarSessions([failed, done, sleeping, waiting, working]).map((s) => s.id)).toEqual(
      ['working', 'waiting', 'sleeping', 'done', 'failed'],
    )
    expect(statusBand('completed')).toBe(statusBand('closed'))
  })

  it('bands waiting with in-flight, so a finished turn does not move the row', () => {
    // The same session either side of a turn boundary: same band, same
    // created_at, so it holds its slot instead of jumping on every response.
    expect(statusBand('waiting')).toBe(statusBand('working'))
    expect(statusBand('waiting')).toBe(statusBand('starting'))
    const mid = sortSidebarSessions([waiting, working, sleeping]).map((s) => s.id)
    const after = sortSidebarSessions([
      { ...waiting, surface: { session: 'alive', run: 'working', status: 'working' } },
      { ...working, surface: { session: 'alive', run: 'waiting', status: 'waiting' } },
      sleeping,
    ] as AgentSession[]).map((s) => s.id)
    expect(after).toEqual(mid)
  })

  it('orders within a band newest-born first, ignoring event recency', () => {
    const old = session({ id: 'old', created_at: '2026-07-20T00:00:00Z', status: 'running' })
    const fresh = session({ id: 'fresh', created_at: '2026-07-22T00:00:00Z', status: 'running' })
    // `old` just spoke; that must not lift it above the younger session.
    const chatty = { ...old, last_activity_at: '2026-07-23T00:00:00Z' } as AgentSession
    expect(sortSidebarSessions([chatty, fresh]).map((s) => s.id)).toEqual(['fresh', 'old'])
    expect(sortSidebarSessions([fresh, chatty]).map((s) => s.id)).toEqual(['fresh', 'old'])
  })
})

describe('mergeSidebarSessions', () => {
  it('keeps local sessions the poll has not returned yet', () => {
    const polled = session({ id: 'a', created_at: '2026-07-23T10:00:00Z' })
    const local = session({ id: 'b', created_at: '2026-07-23T11:00:00Z' })
    expect(mergeSidebarSessions([polled], [local]).map((s) => s.id)).toEqual(['b', 'a'])
  })

  it('emits one row when a session is in both lists, preferring the polled copy', () => {
    const polled = session({ id: 'a', status: 'completed', session_state: 'closed' })
    const local = session({ id: 'a', status: 'running' })
    const merged = mergeSidebarSessions([polled], [local])
    expect(merged.map((s) => s.id)).toEqual(['a'])
    expect(merged[0]?.status).toBe('completed')
  })
})

describe('attentionFlip', () => {
  it('flags active → waiting transitions', () => {
    expect(attentionFlip('working', 'waiting')).toBe(true)
    expect(attentionFlip('starting', 'idle')).toBe(true)
  })

  it('ignores first sightings, active continuations, and terminal flips', () => {
    expect(attentionFlip(undefined, 'waiting')).toBe(false)
    expect(attentionFlip('working', 'working')).toBe(false)
    expect(attentionFlip('waiting', 'waiting')).toBe(false)
    expect(attentionFlip('working', 'completed')).toBe(false)
  })
})

describe('sidebarSlice', () => {
  it('shows everything when it fits', () => {
    expect(sidebarSlice(3, 10, 0)).toEqual({ start: 0, end: 3 })
  })

  it('windows around the selection when it overflows', () => {
    expect(sidebarSlice(20, 6, 0)).toEqual({ start: 0, end: 6 })
    expect(sidebarSlice(20, 6, 10)).toEqual({ start: 7, end: 13 })
    expect(sidebarSlice(20, 6, 19)).toEqual({ start: 14, end: 20 })
  })
})

describe('navSlice', () => {
  it('shows everything when it fits', () => {
    expect(navSlice(3, 5, 0)).toEqual({ start: 0, end: 3 })
  })

  it('holds still until the highlight reaches the second-to-last row', () => {
    expect(navSlice(10, 5, 0)).toEqual({ start: 0, end: 5 })
    expect(navSlice(10, 5, 3)).toEqual({ start: 0, end: 5 })
  })

  it('scrolls with the highlight parked on the second-to-last row', () => {
    expect(navSlice(10, 5, 4)).toEqual({ start: 1, end: 6 })
    expect(navSlice(10, 5, 5)).toEqual({ start: 2, end: 7 })
    expect(navSlice(10, 5, 7)).toEqual({ start: 4, end: 9 })
  })

  it('lets the last row hold the highlight at the end of the list', () => {
    expect(navSlice(10, 5, 8)).toEqual({ start: 5, end: 10 })
    expect(navSlice(10, 5, 9)).toEqual({ start: 5, end: 10 })
  })
})

describe('composerModelOptions', () => {
  it('labels rows with raw model ids and folds the default model into the null entry', () => {
    const options = composerModelOptions([
      { id: 'claude-fable-5', display_name: 'Claude Fable 5', is_default_agent_model: false },
      { id: 'claude-opus-5', display_name: 'Claude Opus 5', is_default_agent_model: true },
    ])
    expect(options.map((o) => o.id)).toEqual([null, 'claude-fable-5'])
    expect(options[0].label).toBe('claude-opus-5')
    expect(options[1].label).toBe('claude-fable-5')
  })

  it('falls back to the built-in list when the server returns none', () => {
    expect(composerModelOptions([])).toEqual([...COMPOSER_MODELS])
  })

  it('leaves Default unnamed when no model claims the flag', () => {
    const options = composerModelOptions([
      { id: 'claude-opus-5', display_name: 'Claude Opus 5', is_default_agent_model: false },
    ])
    expect(options[0].label).toBe('Default')
    expect(options[1].label).toBe('claude-opus-5')
  })
})
