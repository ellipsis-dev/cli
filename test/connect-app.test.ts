import { describe, expect, it } from 'vitest'
import {
  cursorLineDown,
  cursorLineUp,
  deriveSandboxState,
  estimateItemRows,
  foldRun,
  hookPhrase,
  sandboxPhaseLine,
  viewportSlice,
} from '../src/ui/ConnectApp'
import type { TranscriptItem } from '@ellipsis-dev/sdk/store'

let seq = 0
function rec(recordType: string, payload: Record<string, unknown> = {}, source = 'lifecycle') {
  return { feed_seq: ++seq, source, record_type: recordType, payload }
}

describe('deriveSandboxState', () => {
  it('returns null before any sandbox lifecycle record', () => {
    expect(deriveSandboxState([], 0)).toBeNull()
    expect(deriveSandboxState([rec('assistant', {}, 'claude_code')], 0)).toBeNull()
  })

  it('accumulates chunked setup output into one step per hook, in order', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_starting'),
        rec('sandbox_setup_output', { hook: 'image.setup', chunk: 0, lines: ['a'] }),
        rec('sandbox_setup_output', { hook: 'image.setup', chunk: 1, lines: ['b', 'c'] }),
        rec('sandbox_setup_output', { hook: 'post_clone', chunk: 0, lines: ['d'] }),
      ],
      0,
    )
    expect(state).not.toBeNull()
    expect(state?.ready).toBe(false)
    expect(state?.steps.map((s) => s.hook)).toEqual(['image.setup', 'post_clone'])
    expect(state?.steps[0].lines).toEqual(['a', 'b', 'c'])
    expect(state?.steps[0].label).toBe('Building image')
    expect(state?.steps[1].lines).toEqual(['d'])
  })

  it('marks ready and keeps the steps once sandbox_ready lands', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_starting'),
        rec('sandbox_setup_output', { hook: 'post_clone', chunk: 0, lines: ['x'] }),
        rec('sandbox_ready', { repositories: ['o/r'], cache_tier: 'exact' }),
      ],
      0,
    )
    expect(state?.ready).toBe(true)
    expect(state?.steps).toHaveLength(1)
  })

  it('resets on a new sandbox_starting so a wake tells a fresh story', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_starting'),
        rec('sandbox_setup_output', { hook: 'image.setup', chunk: 0, lines: ['old'] }),
        rec('sandbox_ready', {}),
        rec('sandbox_starting'),
        rec('sandbox_setup_output', { hook: 'post_start', chunk: 0, lines: ['new'] }),
      ],
      0,
    )
    expect(state?.ready).toBe(false)
    expect(state?.steps.map((s) => s.hook)).toEqual(['post_start'])
    expect(state?.steps[0].lines).toEqual(['new'])
  })

  it('ignores records at or below the render cursor (--no-records)', () => {
    const starting = rec('sandbox_starting')
    const ready = rec('sandbox_ready', {})
    expect(deriveSandboxState([starting, ready], ready.feed_seq)).toBeNull()
  })
})

describe('sandboxPhaseLine', () => {
  it('is null with no state or no steps yet', () => {
    expect(sandboxPhaseLine(null)).toBeNull()
    expect(sandboxPhaseLine({ steps: [], ready: false })).toBeNull()
  })

  it('shows only the current phase with its latest log line', () => {
    expect(
      sandboxPhaseLine({
        steps: [
          { hook: 'image.setup', label: 'Building image', lines: ['a'] },
          { hook: 'post_clone', label: 'Post-clone setup', lines: ['bun install', 'done'] },
        ],
        ready: false,
      }),
    ).toBe('Post-clone setup… · done')
  })

  it('rewrites to Ready! once the box is up', () => {
    expect(sandboxPhaseLine({ steps: [], ready: true })).toBe('Ready!')
  })
})

describe('hookPhrase', () => {
  it('maps known hooks and passes unknown ones through', () => {
    expect(hookPhrase('image.setup')).toBe('Building image')
    expect(hookPhrase('post_clone')).toBe('Post-clone setup')
    expect(hookPhrase('custom.hook')).toBe('custom.hook')
  })
})

describe('cursorLineUp', () => {
  it('is null on the first line — the signal to enter transcript navigation', () => {
    expect(cursorLineUp('', 0)).toBeNull()
    expect(cursorLineUp('hello', 3)).toBeNull()
    expect(cursorLineUp('ab\ncd', 2)).toBeNull()
  })

  it('keeps the column when the previous line is long enough', () => {
    expect(cursorLineUp('ab\ncd', 4)).toBe(1)
    expect(cursorLineUp('ab\ncd', 3)).toBe(0)
  })

  it('clamps to the previous line end when it is shorter', () => {
    expect(cursorLineUp('a\nbcd', 5)).toBe(1)
    expect(cursorLineUp('\nabc', 3)).toBe(0)
  })

  it('walks middle lines of a three-line input', () => {
    // "one\ntwo\nthree", cursor at 'r' (line 3 col 2) -> line 2 col 2.
    expect(cursorLineUp('one\ntwo\nthree', 10)).toBe(6)
  })
})

describe('cursorLineDown', () => {
  it('is null on the last line', () => {
    expect(cursorLineDown('', 0)).toBeNull()
    expect(cursorLineDown('hello', 2)).toBeNull()
    expect(cursorLineDown('ab\ncd', 4)).toBeNull()
  })

  it('keeps the column and clamps to a shorter next line', () => {
    expect(cursorLineDown('ab\ncd', 1)).toBe(4)
    expect(cursorLineDown('abcd\nx', 3)).toBe(6)
  })

  it('moves from a line-end newline to the next line', () => {
    expect(cursorLineDown('ab\ncd', 2)).toBe(5)
  })
})

describe('viewportSlice', () => {
  const heights = [2, 3, 1, 1]

  it('follows the bottom, fitting as many entries as the budget allows', () => {
    expect(viewportSlice(heights, 5, { type: 'bottom' })).toEqual({ start: 1, end: 4 })
    expect(viewportSlice(heights, 100, { type: 'bottom' })).toEqual({ start: 0, end: 4 })
  })

  it('anchors to a top entry when scrolled', () => {
    expect(viewportSlice(heights, 4, { type: 'top', index: 1 })).toEqual({ start: 1, end: 3 })
    expect(viewportSlice(heights, 2, { type: 'top', index: 0 })).toEqual({ start: 0, end: 1 })
  })

  it('anchors an entry to the bottom edge for the ↓-snap', () => {
    expect(viewportSlice(heights, 4, { type: 'end', index: 2 })).toEqual({ start: 1, end: 3 })
  })

  it('always includes the anchor entry, even when it alone overflows', () => {
    expect(viewportSlice([10], 3, { type: 'bottom' })).toEqual({ start: 0, end: 1 })
    expect(viewportSlice([10], 3, { type: 'top', index: 0 })).toEqual({ start: 0, end: 1 })
  })

  it('handles an empty list', () => {
    expect(viewportSlice([], 5, { type: 'bottom' })).toEqual({ start: 0, end: 0 })
  })
})

describe('estimateItemRows', () => {
  it('counts plain lines plus the spacer row', () => {
    expect(estimateItemRows({ key: 'a', kind: 'assistant', text: 'hi' }, 80, false)).toBe(1)
    expect(
      estimateItemRows(
        { key: 'a', kind: 'assistant', text: 'hi\nthere', spaceBefore: true },
        80,
        false,
      ),
    ).toBe(3)
  })

  it('accounts for wrapping at the given width', () => {
    expect(estimateItemRows({ key: 'a', kind: 'assistant', text: 'x'.repeat(100) }, 40, false)).toBe(3)
  })

  it('counts the clamped body and the +N marker for collapsible items', () => {
    const item = {
      key: 'r',
      kind: 'tool_result' as const,
      text: Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n'),
    }
    expect(estimateItemRows(item, 80, true)).toBe(7) // 6 clamped lines + marker
    expect(estimateItemRows(item, 80, false)).toBe(10)
  })
})

describe('foldRun', () => {
  const tool = (key: string): TranscriptItem => ({ key, kind: 'tool', text: 'Bash' })
  const result = (key: string): TranscriptItem => ({ key, kind: 'tool_result', text: 'ok' })
  const prose = (key: string): TranscriptItem => ({ key, kind: 'assistant', text: 'hi' })

  it('returns the consecutive tool run starting at the fold anchor', () => {
    const items = [prose('a'), tool('t1'), result('r1'), tool('t2'), result('r2'), prose('b')]
    expect(foldRun('grp:t1', items).map((i) => i.key)).toEqual(['t1', 'r1', 't2', 'r2'])
  })

  it('is empty when the anchor is gone from the unfolded list', () => {
    expect(foldRun('grp:missing', [prose('a')])).toEqual([])
  })
})
