import { describe, expect, it } from 'vitest'
import {
  attentionFlip,
  connectability,
  isActiveStatusWord,
  isOpenConversation,
  lastEventAt,
  rowDescription,
  rowGlyph,
  rowStatusWord,
  shortAge,
  sidebarSlice,
  sortSidebarSessions,
} from '../src/lib/sessions'
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

  it('colors in-flight yellow, waiting cyan, sleeping dim', () => {
    expect(rowGlyph('working')).toEqual({ glyph: '●', color: 'yellow', dim: false })
    expect(isActiveStatusWord('working')).toBe(true)
    expect(rowGlyph('waiting').color).toBe('cyan')
    expect(rowGlyph('sleeping')).toEqual({ glyph: '●', dim: true })
  })

  it('colors failures red and settles the rest as done green', () => {
    expect(rowGlyph('failed').color).toBe('red')
    expect(rowGlyph('error')).toEqual({ glyph: '●', color: 'red', dim: false })
    expect(rowGlyph('stopped')).toEqual({ glyph: '●', color: 'red', dim: true })
    expect(rowGlyph('completed').color).toBe('green')
    expect(rowGlyph('closed').color).toBe('green')
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

describe('sortSidebarSessions', () => {
  it('puts open conversations first, each group newest-event first', () => {
    const open1 = session({ id: 'open1', session_state: 'idle', updated_at: '2026-07-23T10:00:00Z' })
    const open2 = session({
      id: 'open2',
      session_state: 'running',
      updated_at: '2026-07-23T11:00:00Z',
    })
    const closed = session({
      id: 'closed',
      session_state: 'closed',
      updated_at: '2026-07-23T12:00:00Z',
    })
    const done = session({ id: 'done', status: 'completed', updated_at: '2026-07-23T13:00:00Z' })
    expect(sortSidebarSessions([closed, open1, done, open2]).map((s) => s.id)).toEqual([
      'open2',
      'open1',
      'done',
      'closed',
    ])
  })

  it('treats non-terminal stateless sessions as open', () => {
    expect(isOpenConversation(session({ status: 'running' }))).toBe(true)
    expect(isOpenConversation(session({ status: 'completed' }))).toBe(false)
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
