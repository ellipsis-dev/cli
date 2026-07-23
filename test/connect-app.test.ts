import { describe, expect, it } from 'vitest'
import {
  awaitingAgentPhase,
  cursorLineDown,
  cursorLineUp,
  deliveredUnechoedSends,
  deriveSandboxState,
  estimateItemRows,
  foldRun,
  gutterFor,
  hookPhrase,
  humanDuration,
  reshapeTranscript,
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

  it('walks the session headline: scheduled → starting → ready', () => {
    const scheduled = deriveSandboxState([rec('session_scheduled', { source: 'cli' })], 0)
    expect(scheduled?.headline).toBe('Session scheduled…')
    expect(scheduled?.done).toBe(false)
    expect(scheduled?.sandboxLine).toBeNull()

    const starting = deriveSandboxState(
      [
        rec('session_scheduled', { source: 'cli', config_name: 'my-agent' }),
        rec('session_starting', { attempt: 0, wake_index: 0 }),
      ],
      0,
    )
    expect(starting?.headline).toBe('Session starting…')
    expect(starting?.done).toBe(false)

    const ready = deriveSandboxState(
      [
        rec('session_starting', { attempt: 0, wake_index: 0 }),
        rec('sandbox_starting', {}),
        rec('sandbox_ready', { cache_tier: 'exact' }),
      ],
      0,
    )
    expect(ready?.headline).toBe('Session ready!')
    expect(ready?.done).toBe(true)
    expect(ready?.sandboxDone).toBe(true)
  })

  it('carries the config name as its own child line, not in the headline', () => {
    const state = deriveSandboxState(
      [rec('session_scheduled', { source: 'cli', config_name: 'deployer' })],
      0,
    )
    expect(state?.headline).toBe('Session scheduled…')
    expect(state?.configName).toBe('deployer')
    expect(state?.configCommitSha).toBeNull()
  })

  it('carries the config commit sha when the backend sends it', () => {
    const state = deriveSandboxState(
      [
        rec('session_scheduled', {
          source: 'cli',
          config_name: 'deployer',
          config_commit_sha: 'abc1234def5678',
        }),
      ],
      0,
    )
    expect(state?.configCommitSha).toBe('abc1234def5678')
  })

  it('keeps the config name across the starting transition (no flash)', () => {
    const state = deriveSandboxState(
      [
        rec('session_scheduled', { source: 'cli', config_name: 'deployer' }),
        rec('session_starting', { attempt: 0, wake_index: 0 }),
      ],
      0,
    )
    expect(state?.headline).toBe('Session starting…')
    expect(state?.configName).toBe('deployer')
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
    expect(state?.done).toBe(false)
    expect(state?.sandboxLine).toBe('Sandbox starting…')
    expect(state?.steps.map((s) => [s.key, s.status])).toEqual([
      ['image', 'done'],
      ['clone', 'running'],
    ])
    expect(state?.steps[0].label).toBe('Preparing image')
    expect(state?.steps[0].note).toBe('cached image (1s)')
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
    expect(state?.steps[0].note).toBe('(800ms)')
    expect(state?.steps[0].lines).toEqual(['npm ci'])
    // No bare 'hooks' phase entry ever opens, so hook steps stay flat.
    expect(state?.steps[0].child).toBe(false)
  })

  it('nests the image build/container/smoke steps under Preparing image', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_starting', { repositories: ['o/r'] }),
        rec('sandbox_phase', { phase: 'image', status: 'started' }),
        rec('sandbox_phase', { phase: 'image', step: 'build', status: 'started' }),
        rec('sandbox_output', {
          phase: 'image',
          step: 'build',
          chunk: 0,
          lines: ['#1 FROM base'],
        }),
        rec('sandbox_output', {
          phase: 'image',
          step: 'build',
          chunk: 1,
          lines: ['#2 RUN npm ci'],
        }),
        rec('sandbox_phase', {
          phase: 'image',
          step: 'build',
          status: 'completed',
          duration_ms: 42000,
        }),
        rec('sandbox_phase', { phase: 'image', step: 'container', status: 'started' }),
        rec('sandbox_phase', {
          phase: 'image',
          step: 'container',
          status: 'completed',
          duration_ms: 829000,
        }),
        rec('sandbox_phase', { phase: 'image', step: 'smoke', status: 'started' }),
        rec('sandbox_phase', {
          phase: 'image',
          step: 'smoke',
          status: 'completed',
          duration_ms: 1200,
        }),
        rec('sandbox_phase', {
          phase: 'image',
          status: 'completed',
          duration_ms: 873000,
          detail: { cache_tier: 'full' },
        }),
      ],
      0,
    )
    expect(state?.steps.map((s) => [s.key, s.label, s.status, s.child])).toEqual([
      ['image', 'Preparing image', 'done', false],
      ['image:build', 'Building image', 'done', true],
      ['image:container', 'Starting container', 'done', true],
      ['image:smoke', 'Smoke check', 'done', true],
    ])
    // The live builder log attaches to the build step, not the bare phase.
    expect(state?.steps[0].lines).toEqual([])
    expect(state?.steps[1].lines).toEqual(['#1 FROM base', '#2 RUN npm ci'])
    expect(state?.steps[1].note).toBe('(42s)')
    expect(state?.steps[2].note).toBe('(13m 49s)')
    expect(state?.steps[3].note).toBe('(1s)')
    expect(state?.steps[0].note).toBe('full build (14m 33s)')
  })

  it('keeps the sandbox_ready total on phase_timings, never the step durations', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_starting', {}),
        rec('sandbox_phase', { phase: 'image', status: 'started' }),
        rec('sandbox_phase', { phase: 'image', step: 'build', status: 'started' }),
        rec('sandbox_phase', {
          phase: 'image',
          step: 'build',
          status: 'completed',
          duration_ms: 42000,
        }),
        rec('sandbox_phase', { phase: 'image', status: 'completed', duration_ms: 43000 }),
        rec('sandbox_ready', {
          cache_tier: 'full',
          phase_timings: { image: 43, clone: 17 },
        }),
      ],
      0,
    )
    expect(state?.sandboxLine).toBe('Sandbox ready · full build (1m)')
  })

  it('renders unknown image steps verbatim without nesting surprises (open vocabulary)', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_phase', { phase: 'image', step: 'warm_cache', status: 'started' }),
      ],
      0,
    )
    expect(state?.steps[0].label).toBe('warm_cache')
    // No bare image entry in this feed, so the step stays flat.
    expect(state?.steps[0].child).toBe(false)
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
    expect(sandboxStepLine(state!.steps[0])).toBe('Running setup failed (4s)')
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

  it('closes on sandbox_ready: sandbox summary line + Session ready! headline', () => {
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
    expect(state?.headline).toBe('Session ready!')
    expect(state?.done).toBe(true)
    expect(state?.sandboxLine).toBe('Sandbox ready · cached image (29s)')
    expect(state?.sandboxDone).toBe(true)
    // A phase still open at ready closes as done.
    expect(state?.steps[0].status).toBe('done')
  })

  it('starts a fresh story on a wake: Waking headline, ready via session_resumed', () => {
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
      ],
      0,
    )
    expect(state?.headline).toBe('Waking the session…')
    expect(state?.done).toBe(false)
    expect(state?.sandboxLine).toBe('Sandbox starting…')
    expect(state?.steps.map((s) => s.key)).toEqual(['restore'])
    expect(state?.steps[0].label).toBe('Restoring workspace')

    const resumed = deriveSandboxState(
      [
        rec('session_starting', { attempt: 0, wake_index: 1 }),
        rec('sandbox_starting'),
        rec('sandbox_ready', { cache_tier: 'exact' }),
        rec('session_resumed', { wake_index: 1 }),
      ],
      0,
    )
    expect(resumed?.headline).toBe('Session ready!')
    expect(resumed?.done).toBe(true)
  })

  it('parks the headline on session_idle', () => {
    const state = deriveSandboxState(
      [
        rec('session_starting', { attempt: 0, wake_index: 0 }),
        rec('sandbox_starting'),
        rec('sandbox_ready', {}),
        rec('session_idle', {}),
      ],
      0,
    )
    expect(state?.headline).toBe('Session idle — your next message wakes it')
    expect(state?.done).toBe(true)
  })

  it('shows Retrying as the headline on an infra retry', () => {
    const state = deriveSandboxState(
      [
        rec('session_starting', { attempt: 0, wake_index: 0 }),
        rec('sandbox_starting'),
        rec('session_retrying', { reason: 'sandbox provisioning failed', attempt: 1 }),
      ],
      0,
    )
    expect(state?.headline).toBe('Retrying · sandbox provisioning failed')
    expect(state?.done).toBe(false)
    // The failed start's sandbox children drop with the fresh story.
    expect(state?.sandboxLine).toBeNull()
    expect(state?.steps).toHaveLength(0)
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
    child: false,
    ...over,
  })

  it('shows a running step as its bare label (the log tail renders beneath, not inline)', () => {
    expect(sandboxStepLine(step({}))).toBe('Fetching repositories…')
    expect(sandboxStepLine(step({ lines: ['a', 'HEAD is now at x'] }))).toBe(
      'Fetching repositories…',
    )
  })

  it('shows a done step with its closing note', () => {
    expect(sandboxStepLine(step({ status: 'done' }))).toBe('Fetching repositories')
    expect(sandboxStepLine(step({ status: 'done', note: 'cached image (1s)' }))).toBe(
      'Fetching repositories · cached image (1s)',
    )
  })

  it('says failed', () => {
    expect(sandboxStepLine(step({ status: 'failed', note: '(4s)' }))).toBe(
      'Fetching repositories failed (4s)',
    )
  })
})

describe('awaitingAgentPhase', () => {
  it('is null with no turn in flight — including the bare interactive session', () => {
    expect(awaitingAgentPhase([])).toBeNull()
    // A no-prompt `agent` session sits at 'working' status waiting for its
    // first message: no turn, no Claude Code process, nothing to narrate.
    expect(awaitingAgentPhase([rec('session_starting'), rec('sandbox_ready')])).toBeNull()
  })

  it("reports 'boot' for a fresh execution's first turn (Claude Code starting)", () => {
    expect(
      awaitingAgentPhase([rec('session_starting'), rec('sandbox_ready'), rec('turn_started')]),
    ).toBe('boot')
  })

  it("reports 'turn' through a running turn's lull, even after the harness spoke", () => {
    expect(
      awaitingAgentPhase([
        rec('session_starting'),
        rec('turn_started'),
        rec('assistant', {}, 'claude_code'),
      ]),
    ).toBe('turn')
  })

  it('clears when the turn completes or fails', () => {
    const turn = [
      rec('turn_started'),
      rec('assistant', {}, 'claude_code'),
      rec('turn_completed'),
    ]
    expect(awaitingAgentPhase(turn)).toBeNull()
    expect(awaitingAgentPhase([rec('turn_started'), rec('turn_failed')])).toBeNull()
  })

  it('resets to boot on a wake (a fresh execution boots the harness again)', () => {
    expect(
      awaitingAgentPhase([
        rec('turn_started'),
        rec('assistant', {}, 'claude_code'),
        rec('turn_completed'),
        rec('session_starting'),
        rec('turn_started'),
      ]),
    ).toBe('boot')
  })
})

describe('deliveredUnechoedSends', () => {
  const received = (id: string, body: string) => rec('message_received', { message_id: id, body })
  const delivered = (id: string) => rec('message_delivered', { message_id: id })
  const requeued = (id: string) => rec('message_requeued', { message_id: id })
  const echo = (id: string | null) => ({
    ...rec('user', {}, 'claude_code'),
    session_message_id: id,
  })

  it('bridges the gap between delivery and the user-echo record', () => {
    expect(deliveredUnechoedSends([received('m1', 'hi'), delivered('m1')])).toEqual([
      { id: 'm1', body: 'hi' },
    ])
  })

  it('retires the send once its echo record lands', () => {
    expect(deliveredUnechoedSends([received('m1', 'hi'), delivered('m1'), echo('m1')])).toEqual([])
  })

  it('excludes pending (undelivered) and requeued messages', () => {
    expect(deliveredUnechoedSends([received('m1', 'hi')])).toEqual([])
    expect(
      deliveredUnechoedSends([received('m1', 'hi'), delivered('m1'), requeued('m1')]),
    ).toEqual([])
  })

  it('keeps delivery order and ignores unrelated echoes', () => {
    expect(
      deliveredUnechoedSends([
        received('m1', 'first'),
        received('m2', 'second'),
        delivered('m1'),
        delivered('m2'),
        echo(null),
      ]),
    ).toEqual([
      { id: 'm1', body: 'first' },
      { id: 'm2', body: 'second' },
    ])
  })
})

describe('reshapeTranscript', () => {
  const assistant = (text: string) =>
    rec('cc', { type: 'assistant', message: { content: [{ type: 'text', text }] } }, 'claude_code')
  const result = (over: Record<string, unknown> = {}) =>
    rec(
      'cc',
      { type: 'result', duration_ms: 4000, total_cost_usd: 0.1, is_error: false, ...over },
      'claude_code',
    )

  it('attaches the step meta to the closing assistant message and drops the summary row', () => {
    const { items, stepMeta } = reshapeTranscript([assistant('done!'), result()], 0)
    expect(items.map((i) => i.kind)).toEqual(['assistant'])
    expect(stepMeta.get(items[0].key)).toBe('(4s) · $0.10')
  })

  it('shows each step its own incremental cost, not the cumulative total', () => {
    const { items, stepMeta } = reshapeTranscript(
      [
        assistant('one'),
        result({ total_cost_usd: 0.1 }),
        assistant('two'),
        result({ total_cost_usd: 0.25, duration_ms: 2000 }),
      ],
      0,
    )
    expect(stepMeta.get(items[0].key)).toBe('(4s) · $0.10')
    expect(stepMeta.get(items[1].key)).toBe('(2s) · $0.15')
  })

  it('treats a lower total as a fresh process (wake reset): the step cost is the new total', () => {
    const { items, stepMeta } = reshapeTranscript(
      [
        assistant('before the wake'),
        result({ total_cost_usd: 0.25 }),
        assistant('after the wake'),
        result({ total_cost_usd: 0.05 }),
      ],
      0,
    )
    expect(stepMeta.get(items[1].key)).toBe('(4s) · $0.05')
  })

  it('subtracts history hidden below the render cursor (--no-records)', () => {
    const hidden = [assistant('old'), result({ total_cost_usd: 0.1 })]
    const cursor = hidden[hidden.length - 1].feed_seq
    const { items, stepMeta } = reshapeTranscript(
      [...hidden, assistant('new'), result({ total_cost_usd: 0.18, duration_ms: 3000 })],
      cursor,
    )
    expect(items.map((i) => i.kind)).toEqual(['assistant'])
    expect(stepMeta.get(items[0].key)).toBe('(3s) · $0.08')
  })

  it('keeps an error summary as its own line, label intact', () => {
    const { items, stepMeta } = reshapeTranscript(
      [assistant('oops'), result({ is_error: true })],
      0,
    )
    expect(items.map((i) => i.kind)).toEqual(['assistant', 'summary'])
    expect(items[1].text).toBe('turn ended with an error (4s) · $0.10')
    expect(items[1].isError).toBe(true)
    expect(stepMeta.size).toBe(0)
  })

  it('keeps the summary as its own line when no assistant message precedes it', () => {
    const { items, stepMeta } = reshapeTranscript([result()], 0)
    expect(items.map((i) => i.kind)).toEqual(['summary'])
    expect(items[0].text).toBe('(4s) · $0.10')
    expect(stepMeta.size).toBe(0)
  })
})

describe('gutterFor', () => {
  const item = (kind: TranscriptItem['kind'], gutter?: string): TranscriptItem =>
    ({ key: 'k', kind, text: 'x', spaceBefore: false, gutter }) as TranscriptItem

  it('marks user messages ◆, assistant prose ●, and system lines ✦, overriding the SDK gutter', () => {
    expect(gutterFor(item('user', '›'))).toBe('◆')
    expect(gutterFor(item('assistant'))).toBe('●')
    expect(gutterFor(item('system'))).toBe('✦')
    expect(gutterFor(item('notice'))).toBe('✦')
  })

  it('keeps the SDK glyph for tool activity and none for the rest', () => {
    expect(gutterFor(item('tool', '●'))).toBe('●')
    expect(gutterFor(item('tool_result', '⎿'))).toBe('⎿')
    expect(gutterFor(item('thinking', '✻'))).toBe('✻')
    expect(gutterFor(item('summary'))).toBe('')
  })
})

describe('humanDuration', () => {
  it('reads as compact h/m/s components, dropping zero parts', () => {
    expect(humanDuration(0)).toBe('0s')
    expect(humanDuration(3)).toBe('3s')
    expect(humanDuration(62)).toBe('1m 2s')
    expect(humanDuration(120)).toBe('2m')
    expect(humanDuration(3600)).toBe('1h')
    expect(humanDuration(3810)).toBe('1h 3m 30s')
    expect(humanDuration(5400)).toBe('1h 30m')
  })

  it('rounds fractional seconds and clamps negatives', () => {
    expect(humanDuration(1.2)).toBe('1s')
    expect(humanDuration(59.7)).toBe('1m')
    expect(humanDuration(-5)).toBe('0s')
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
