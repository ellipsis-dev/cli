import { describe, expect, it } from 'vitest'
import {
  cursorLineDown,
  cursorLineUp,
  deriveSandboxState,
  estimateItemRows,
  foldRun,
  hookPhrase,
  sandboxStepLine,
  viewportSlice,
  type SandboxStep,
} from '../src/ui/ConnectApp'
import type { TranscriptItem } from '@ellipsis-dev/sdk/store'

let seq = 0
function rec(recordType: string, payload: Record<string, unknown> = {}, source = 'lifecycle') {
  return { feed_seq: ++seq, source, record_type: recordType, payload }
}

describe('deriveSandboxState', () => {
  it('returns null before any lifecycle record', () => {
    expect(deriveSandboxState([], 0)).toBeNull()
    expect(deriveSandboxState([rec('assistant', {}, 'claude_code')], 0)).toBeNull()
  })

  it('builds the phase timeline from sandbox_phase transitions', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_starting', { repositories: ['o/r'] }),
        rec('sandbox_phase', { phase: 'image', status: 'started' }),
        rec('sandbox_phase', {
          phase: 'image',
          status: 'completed',
          duration_ms: 1200,
          detail: { cache_tier: 'exact' },
        }),
        rec('sandbox_phase', { phase: 'clone', status: 'started' }),
      ],
      0,
    )
    expect(state).not.toBeNull()
    expect(state?.ready).toBe(false)
    expect(state?.steps.map((s) => [s.key, s.status])).toEqual([
      ['image', 'done'],
      ['clone', 'running'],
    ])
    expect(state?.steps[0].label).toBe('Preparing image')
    expect(state?.steps[0].note).toBe('cached image · 1.2s')
  })

  it('attaches output chunks to the transition-opened step', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_phase', { phase: 'clone', status: 'started' }),
        rec('sandbox_output', { phase: 'clone', step: 'o/r', chunk: 0, lines: ['HEAD is now at x'] }),
        rec('sandbox_output', { phase: 'clone', step: 'o/r', chunk: 1, lines: ['done'] }),
      ],
      0,
    )
    expect(state?.steps).toHaveLength(1)
    expect(state?.steps[0].key).toBe('clone')
    expect(state?.steps[0].lines).toEqual(['HEAD is now at x', 'done'])
  })

  it('keys per-step transitions (hooks) separately and labels them as hooks', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_phase', { phase: 'hooks', step: 'post_clone', status: 'started' }),
        rec('sandbox_output', { phase: 'hooks', step: 'post_clone', chunk: 0, lines: ['npm ci'] }),
        rec('sandbox_phase', {
          phase: 'hooks',
          step: 'post_clone',
          status: 'completed',
          duration_ms: 800,
        }),
      ],
      0,
    )
    expect(state?.steps.map((s) => s.key)).toEqual(['hooks:post_clone'])
    expect(state?.steps[0].label).toBe('Post-clone setup')
    expect(state?.steps[0].status).toBe('done')
    expect(state?.steps[0].note).toBe('800ms')
    expect(state?.steps[0].lines).toEqual(['npm ci'])
  })

  it('marks a failed transition and keeps its duration', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_phase', { phase: 'setup', status: 'started' }),
        rec('sandbox_phase', { phase: 'setup', status: 'failed', duration_ms: 4000 }),
      ],
      0,
    )
    expect(state?.steps[0].status).toBe('failed')
    expect(sandboxStepLine(state!.steps[0])).toBe('Running setup failed · 4.0s')
  })

  it('renders unknown phases generically (open vocabulary)', () => {
    const state = deriveSandboxState(
      [rec('sandbox_phase', { phase: 'warmup', status: 'started' })],
      0,
    )
    expect(state?.steps[0].label).toBe('Warmup')
  })

  it('infers steps from bare output chunks (feeds without transitions)', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_starting'),
        rec('sandbox_output', { phase: 'setup', chunk: 0, lines: ['a'] }),
        rec('sandbox_output', { phase: 'setup', chunk: 1, lines: ['b', 'c'] }),
        rec('sandbox_output', { phase: 'hooks', step: 'post_clone', chunk: 0, lines: ['d'] }),
      ],
      0,
    )
    expect(state?.steps.map((s) => [s.key, s.status])).toEqual([
      ['setup', 'done'],
      ['post_clone', 'running'],
    ])
    expect(state?.steps[0].lines).toEqual(['a', 'b', 'c'])
    expect(state?.steps[0].label).toBe('Building image')
    expect(state?.steps[1].label).toBe('Post-clone setup')
  })

  it('collects session-subject notes and closes on sandbox_ready with a summary', () => {
    const state = deriveSandboxState(
      [
        rec('session_scheduled', { source: 'cli' }),
        rec('session_starting', { attempt: 0, wake_index: 0 }),
        rec('sandbox_starting', { repositories: ['o/r'] }),
        rec('sandbox_phase', { phase: 'image', status: 'started' }),
        rec('sandbox_ready', {
          repositories: ['o/r'],
          cache_tier: 'exact',
          phase_timings: { image: 1.5, clone: 27.5 },
        }),
      ],
      0,
    )
    expect(state?.notes.map((n) => n.text)).toEqual(['Session scheduled', 'Session starting…'])
    expect(state?.ready).toBe(true)
    expect(state?.readyLine).toBe('Sandbox ready · cached image · 29s')
    // A phase still open at ready closes as done.
    expect(state?.steps[0].status).toBe('done')
  })

  it('starts a fresh story on a wake and notes it', () => {
    const state = deriveSandboxState(
      [
        rec('session_scheduled', { source: 'cli' }),
        rec('session_starting', { attempt: 0, wake_index: 0 }),
        rec('sandbox_starting'),
        rec('sandbox_output', { phase: 'setup', chunk: 0, lines: ['old'] }),
        rec('sandbox_ready', {}),
        rec('session_idle', {}),
        rec('session_starting', { attempt: 0, wake_index: 1 }),
        rec('sandbox_starting'),
        rec('sandbox_phase', { phase: 'restore', status: 'started' }),
        rec('session_resumed', { wake_index: 1 }),
      ],
      0,
    )
    expect(state?.notes.map((n) => n.text)).toEqual([
      'Waking the session…',
      'Resumed the conversation',
    ])
    expect(state?.ready).toBe(false)
    expect(state?.steps.map((s) => s.key)).toEqual(['restore'])
    expect(state?.steps[0].label).toBe('Restoring workspace')
  })

  it('ignores records at or below the render cursor (--no-records)', () => {
    const starting = rec('sandbox_starting')
    const ready = rec('sandbox_ready', {})
    expect(deriveSandboxState([starting, ready], ready.feed_seq)).toBeNull()
  })
})

describe('sandboxStepLine', () => {
  const step = (over: Partial<SandboxStep>): SandboxStep => ({
    key: 'clone',
    label: 'Fetching repositories',
    status: 'running',
    note: null,
    lines: [],
    inferred: false,
    ...over,
  })

  it('shows a running step with its latest output line', () => {
    expect(sandboxStepLine(step({}))).toBe('Fetching repositories…')
    expect(sandboxStepLine(step({ lines: ['a', 'HEAD is now at x'] }))).toBe(
      'Fetching repositories… · HEAD is now at x',
    )
  })

  it('shows a done step with its closing note', () => {
    expect(sandboxStepLine(step({ status: 'done' }))).toBe('Fetching repositories')
    expect(sandboxStepLine(step({ status: 'done', note: 'cached image · 1.2s' }))).toBe(
      'Fetching repositories · cached image · 1.2s',
    )
  })

  it('says failed', () => {
    expect(sandboxStepLine(step({ status: 'failed', note: '4.0s' }))).toBe(
      'Fetching repositories failed · 4.0s',
    )
  })
})

describe('hookPhrase', () => {
  it('maps known step/phase keys and passes unknown ones through', () => {
    expect(hookPhrase('setup')).toBe('Building image')
    expect(hookPhrase('image.setup')).toBe('Building image')
    expect(hookPhrase('clone')).toBe('Fetching repositories')
    expect(hookPhrase('post_clone')).toBe('Post-clone setup')
    expect(hookPhrase('post_start')).toBe('Post-start setup')
    expect(hookPhrase('custom.step')).toBe('custom.step')
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
