import { describe, expect, it } from 'vitest'
import {
  awaitingAgentPhase,
  cursorLineDown,
  cursorLineUp,
  deliveredUnechoedSends,
  deriveSandboxState,
  lastLines,
  foldRun,
  hookPhrase,
  humanDuration,
  reshapeTranscript,
  sessionLogText,
} from '../src/ui/ConnectApp'
import {
  anchorAt,
  anchorIndex,
  entryRange,
  gutterFor,
  itemRows,
  layOutItems,
  rowViewport,
  snapAnchorForEntry,
  snapToEntry,
  spanColor,
  withRenderedMarkdown,
  type TranscriptRow,
} from '../src/ui/transcriptRows'
import stripAnsi from 'strip-ansi'
import { theme } from '../src/lib/theme'
import type { TranscriptItem } from '@ellipsis-dev/sdk/store'

let seq = 0
function rec(recordType: string, payload: Record<string, unknown> = {}, source = 'lifecycle') {
  return { feed_seq: ++seq, source, record_type: recordType, payload }
}

describe('deriveSandboxState', () => {
  // The whole startup story is ONE flat log, in feed order — the shape that
  // replaced the old session → sandbox → phase → per-phase-tail tree.
  const texts = (state: ReturnType<typeof deriveSandboxState>) =>
    (state?.log ?? []).map((l) => l.text)
  const kinds = (state: ReturnType<typeof deriveSandboxState>) =>
    (state?.log ?? []).map((l) => l.kind)

  it('returns null before any lifecycle record', () => {
    expect(deriveSandboxState([], 0)).toBeNull()
    expect(deriveSandboxState([rec('assistant', {}, 'claude_code')], 0)).toBeNull()
  })

  it('walks the session headline: scheduled → starting → ready', () => {
    const scheduled = deriveSandboxState([rec('session_scheduled', { source: 'cli' })], 0)
    expect(scheduled?.headline).toBe('Session scheduled…')
    expect(scheduled?.done).toBe(false)

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

  it('heads the log with the config, and keeps it across the starting transition', () => {
    const state = deriveSandboxState(
      [
        rec('session_scheduled', {
          source: 'cli',
          config_name: 'deployer',
          config_commit_sha: 'abc1234def5678',
        }),
        rec('session_starting', { attempt: 0, wake_index: 0 }),
      ],
      0,
    )
    // The config outlives the restart that clears the log below it.
    expect(state?.headline).toBe('Session starting…')
    expect(state?.configName).toBe('deployer')
    expect(texts(state)[0]).toBe('Using deployer @ abc1234')
  })

  it('logs each phase as ONE line, opened then closed in place', () => {
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
    // Not "Preparing image…" AND "Preparing image ✓" — the same line closes.
    expect(texts(state)).toEqual([
      'Starting sandbox…',
      'Preparing image · cached image (1.2s)',
      'Fetching repositories…',
    ])
    expect(kinds(state)).toEqual(['step', 'done', 'step'])
  })

  it('puts build and setup OUTPUT in the same flat log, in order', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_phase', { phase: 'image', step: 'build', status: 'started' }),
        rec('sandbox_output', { phase: 'image', step: 'build', chunk: 0, lines: ['#1 FROM base'] }),
        rec('sandbox_output', { phase: 'image', step: 'build', chunk: 1, lines: ['#2 RUN npm ci'] }),
        rec('sandbox_phase', {
          phase: 'image',
          step: 'build',
          status: 'completed',
          duration_ms: 42000,
        }),
        rec('sandbox_phase', { phase: 'hooks', step: 'post_clone', status: 'started' }),
        rec('sandbox_output', { phase: 'hooks', step: 'post_clone', chunk: 0, lines: ['npm ci'] }),
      ],
      0,
    )
    // This is the point of the flat log: the output you want while a session
    // is slow to start is right there, not three keystrokes deep.
    expect(texts(state)).toEqual([
      'Building image (42s)',
      '#1 FROM base',
      '#2 RUN npm ci',
      'Post-clone setup…',
      'npm ci',
    ])
    expect(kinds(state)).toEqual(['done', 'output', 'output', 'step', 'output'])
  })

  it('logs output that arrives with no phase transition to open it', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_starting'),
        rec('sandbox_output', { phase: 'setup', chunk: 0, lines: ['a'] }),
        rec('sandbox_output', { phase: 'setup', chunk: 1, lines: ['b', 'c'] }),
      ],
      0,
    )
    expect(texts(state)).toEqual(['Starting sandbox…', 'a', 'b', 'c'])
  })

  it('labels phases through the open vocabulary, unknown ones verbatim', () => {
    expect(
      texts(deriveSandboxState([rec('sandbox_phase', { phase: 'warmup', status: 'started' })], 0)),
    ).toEqual(['Warmup…'])
    expect(
      texts(
        deriveSandboxState(
          [rec('sandbox_phase', { phase: 'image', step: 'warm_cache', status: 'started' })],
          0,
        ),
      ),
    ).toEqual(['warm_cache…'])
  })

  it('marks a failed phase and keeps its duration', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_phase', { phase: 'setup', status: 'started' }),
        rec('sandbox_phase', { phase: 'setup', status: 'failed', duration_ms: 4000 }),
      ],
      0,
    )
    expect(texts(state)).toEqual(['Running setup failed (4s)'])
    expect(kinds(state)).toEqual(['failed'])
  })

  it('closes on sandbox_ready with the phase_timings total, not step durations', () => {
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
    expect(state?.sandboxDone).toBe(true)
    expect(texts(state)).toEqual([
      'Starting sandbox…',
      'Preparing image…',
      'Sandbox ready · cached image (29s)',
    ])
    // A phase still open when the box came up is no longer live.
    expect(kinds(state)).toEqual(['step', 'done', 'done'])
  })

  it('starts a fresh log on a wake, dropping the previous start', () => {
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
    expect(texts(state)).toEqual(['Starting sandbox…', 'Restoring workspace…'])

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
    expect(state?.headline).toBe('Session asleep')
    expect(state?.done).toBe(true)
  })

  it('shows Retrying as the headline and drops the failed start log', () => {
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
    expect(state?.log).toHaveLength(0)
  })

  it('ignores records at or below the render cursor (--no-records)', () => {
    const starting = rec('sandbox_starting')
    const ready = rec('sandbox_ready', {})
    expect(deriveSandboxState([starting, ready], ready.feed_seq)).toBeNull()
  })
})

describe('lastLines', () => {
  const log = Array.from({ length: 25 }, (_, i) => ({
    key: `k${i}`,
    kind: 'output' as const,
    text: `line ${i}`,
  }))

  it('keeps the NEWEST lines — the tail is what you watch during a build', () => {
    expect(lastLines(log, 10).map((l) => l.text)).toEqual([
      'line 15','line 16','line 17','line 18','line 19',
      'line 20','line 21','line 22','line 23','line 24',
    ])
  })

  it('returns everything when the log is shorter than the window', () => {
    expect(lastLines(log.slice(0, 3), 10)).toHaveLength(3)
    expect(lastLines([], 10)).toEqual([])
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
  const delivered = (id: string, turn = 't1') =>
    rec('message_delivered', { message_id: id, turn_id: turn })
  const requeued = (id: string) => rec('message_requeued', { message_id: id })
  const turnFailed = (turn = 't1') => rec('turn_failed', { turn_id: turn, turn_index: 0 })
  const echo = (id: string | null) => ({
    ...rec('user', {}, 'claude_code'),
    session_message_id: id,
  })

  it('bridges the gap between delivery and the user-echo record', () => {
    expect(deliveredUnechoedSends([received('m1', 'hi'), delivered('m1')])).toEqual([
      { id: 'm1', body: 'hi', cancelled: false },
    ])
  })

  it('marks a send cancelled when the turn that took it died unanswered', () => {
    expect(
      deliveredUnechoedSends([received('m1', 'hi'), delivered('m1', 't7'), turnFailed('t7')]),
    ).toEqual([{ id: 'm1', body: 'hi', cancelled: true }])
  })

  it('leaves a send waiting when a DIFFERENT turn failed', () => {
    expect(
      deliveredUnechoedSends([received('m1', 'hi'), delivered('m1', 't7'), turnFailed('t8')]),
    ).toEqual([{ id: 'm1', body: 'hi', cancelled: false }])
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
      { id: 'm1', body: 'first', cancelled: false },
      { id: 'm2', body: 'second', cancelled: false },
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

  it('drops a turn-closing summary entirely — duration and cost are not conversation', () => {
    const { items } = reshapeTranscript([assistant('done!'), result()], 0)
    expect(items.map((i) => i.kind)).toEqual(['assistant'])
  })

  it('drops every turn summary across a multi-turn transcript', () => {
    const { items } = reshapeTranscript(
      [
        assistant('one'),
        result({ total_cost_usd: 0.1 }),
        assistant('two'),
        result({ total_cost_usd: 0.25, duration_ms: 2000 }),
      ],
      0,
    )
    expect(items.map((i) => i.text)).toEqual(['one', 'two'])
  })

  it('drops a summary with no assistant message before it', () => {
    expect(reshapeTranscript([result()], 0).items).toEqual([])
  })

  it('skips records at or below the render cursor (--no-records)', () => {
    const hidden = [assistant('old'), result({ total_cost_usd: 0.1 })]
    const cursor = hidden[hidden.length - 1].feed_seq
    const { items } = reshapeTranscript(
      [...hidden, assistant('new'), result({ total_cost_usd: 0.18 })],
      cursor,
    )
    expect(items.map((i) => i.text)).toEqual(['new'])
  })

  it('keeps an error summary as its own line under a plain label', () => {
    const { items } = reshapeTranscript([assistant('oops'), result({ is_error: true })], 0)
    expect(items.map((i) => i.kind)).toEqual(['assistant', 'summary'])
    expect(items[1].text).toBe('turn ended with an error')
    expect(items[1].isError).toBe(true)
  })

  it('settles the waking line in place instead of logging the wake twice', () => {
    const records = [
      assistant('done for now'),
      rec('session_idle'),
      rec('session_starting', { wake_index: 1 }),
    ]
    const waking = reshapeTranscript(records, 0)
    expect(waking.items.map((i) => i.text)).toEqual([
      'done for now',
      'Session asleep',
      'Waking the session…',
    ])
    const awake = reshapeTranscript([...records, rec('session_resumed'), assistant('back')], 0)
    expect(awake.items.map((i) => i.text)).toEqual([
      'done for now',
      'Session asleep',
      'Session awake',
      'back',
    ])
    // Same key, so settling the line can't slide the scroll anchor.
    expect(awake.items[2].key).toBe(waking.items[2].key)
  })

  it('leaves startup detail out of the chat — that story is the startup block', () => {
    const { items } = reshapeTranscript(
      [
        rec('sandbox_starting'),
        rec('sandbox_phase', { phase: 'setup', status: 'started' }),
        rec('sandbox_output', { lines: ['installing…'] }),
        rec('sandbox_ready', { cache_tier: 'exact' }),
        rec('turn_started'),
        assistant('hello'),
      ],
      0,
    )
    expect(items.map((i) => i.text)).toEqual(['hello'])
  })
})

describe('sessionLogText', () => {
  const lc = (record_type: string, payload: Record<string, unknown> = {}) =>
    ({ feed_seq: 1, source: 'lifecycle', record_type, payload })

  it('does not log the FIRST start — the startup block tells that story', () => {
    expect(sessionLogText(lc('session_starting', {}))).toBeNull()
    expect(sessionLogText(lc('session_starting', { wake_index: 0 }))).toBeNull()
  })

  it('logs a wake, which happens long after the startup block settled', () => {
    expect(sessionLogText(lc('session_starting', { wake_index: 2 }))).toBe('Waking the session…')
  })

  it('logs an infra retry distinctly from a wake', () => {
    expect(sessionLogText(lc('session_starting', { attempt: 1 }))).toContain('transient error')
    expect(sessionLogText(lc('session_retrying', { reason: 'node lost' }))).toBe(
      'Retrying · node lost',
    )
  })

  it('logs a cancellation with its reason when there is one', () => {
    expect(sessionLogText(lc('session_cancelled', {}))).toBe('Session cancelled')
    expect(sessionLogText(lc('session_cancelled', { reason: 'budget' }))).toBe(
      'Session cancelled · budget',
    )
  })

  it('ignores provisioning chatter', () => {
    for (const t of ['sandbox_starting', 'sandbox_phase', 'sandbox_output', 'sandbox_ready', 'turn_started']) {
      expect(sessionLogText(lc(t))).toBeNull()
    }
  })
})

describe('layOutItems', () => {
  const prose = (key: string): TranscriptItem => ({ key, kind: 'assistant', text: 'hi' })
  const user = (key: string): TranscriptItem => ({ key, kind: 'user', text: 'do it' })
  const call = (key: string): TranscriptItem => ({ key, kind: 'tool', text: 'Bash' })
  const res = (key: string): TranscriptItem => ({ key, kind: 'tool_result', text: 'ok' })
  const fold = (key: string): TranscriptItem => ({ key: `grp:${key}`, kind: 'notice', text: 'Ran 2' })

  it('nests a call and its result under the message that made them', () => {
    const out = layOutItems([prose('a'), call('t1'), res('r1')])
    expect(out.map((p) => [p.item.key, p.indent, p.nested])).toEqual([
      ['a', 0, false],
      ['t1', 2, true],
      ['r1', 2, true],
    ])
  })

  it('attaches nested lines, so no blank row detaches them from the parent', () => {
    const out = layOutItems([prose('a'), call('t1'), res('r1')])
    expect(out.map((p) => p.attach)).toEqual([false, true, true])
  })

  it('nests a collapsed fold too — it stands in for the run', () => {
    const out = layOutItems([prose('a'), fold('t1')])
    expect(out[1]).toMatchObject({ indent: 2, nested: true })
  })

  it('nests a turn-opening tool call under the user message that prompted it', () => {
    const out = layOutItems([user('u'), call('t1')])
    expect(out[1]).toMatchObject({ indent: 2, nested: true })
  })

  it('leaves a run with no parent above it flat', () => {
    // Replayed history can start mid-burst; there is nothing to hang off.
    const out = layOutItems([call('t1'), res('r1'), prose('a')])
    expect(out.map((p) => p.nested)).toEqual([false, false, false])
  })

  it("indents an opened message's revealed calls one level FURTHER than the fold", () => {
    const out = layOutItems([prose('a'), fold('t1'), call('t1'), res('r1')], {
      openedKeys: new Set(['a']),
    })
    expect(out.map((p) => p.indent)).toEqual([0, 2, 4, 4])
  })

  it('makes a tool call part of its message block, not a stop of its own', () => {
    // ↑ lands on the message; the call and its result travel with it.
    const out = layOutItems([prose('a'), call('t1'), res('r1')])
    expect(out.map((p) => p.navKey)).toEqual([undefined, 'a', 'a'])
  })

  it('makes a collapsed fold part of the message block too', () => {
    const out = layOutItems([prose('a'), fold('t1')])
    expect(out[1].navKey).toBe('a')
  })

  it('promotes revealed calls to stops of their own, results still travelling with them', () => {
    const out = layOutItems([prose('a'), fold('t1'), call('t1'), res('r1')], {
      openedKeys: new Set(['a']),
    })
    // The fold stays part of the message; the call becomes its own stop and
    // owns its result.
    expect(out.map((p) => p.navKey)).toEqual([undefined, 'a', undefined, 't1'])
  })

  it('points a revealed call back at its message, so ← steps out', () => {
    const out = layOutItems([prose('a'), fold('t1'), call('t1'), res('r1')], {
      openedKeys: new Set(['a']),
    })
    expect(out[2].parentKey).toBe('a')
  })

  it('promotes every call when ctrl+r reveals the whole transcript', () => {
    const out = layOutItems([prose('a'), call('t1'), res('r1')], { revealAll: true })
    expect(out.map((p) => p.navKey)).toEqual([undefined, undefined, 't1'])
  })

  it('leaves an unopened message closed, so its calls stay off the walk', () => {
    const out = layOutItems([prose('a'), fold('t1'), prose('b'), fold('t2')], {
      openedKeys: new Set(['b']),
    })
    expect(out.map((p) => p.navKey)).toEqual([undefined, 'a', undefined, 'b'])
  })

  it('keeps prose, user messages and notices flat', () => {
    const notice: TranscriptItem = { key: 'n', kind: 'notice', text: 'Session asleep' }
    const out = layOutItems([prose('a'), user('u'), notice])
    expect(out.every((p) => !p.nested && p.indent === 0)).toBe(true)
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
  it('scales precision down with size: ms under 1s, one decimal under 5s', () => {
    expect(humanDuration(0.428)).toBe('428ms')
    expect(humanDuration(1.2)).toBe('1.2s')
    expect(humanDuration(4.7)).toBe('4.7s')
    expect(humanDuration(3)).toBe('3s')
  })

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
    expect(humanDuration(1.2)).toBe('1.2s')
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

describe('rowViewport', () => {
  it('follows the bottom by default, filling the window', () => {
    expect(rowViewport(10, 4, null)).toMatchObject({ start: 7, end: 10, hiddenBelow: 0 })
    // The "N above" marker costs a row, so only 3 content rows fit in 4.
    expect(rowViewport(10, 4, null).hiddenAbove).toBe(7)
  })

  it('shows everything when it fits, with no markers', () => {
    expect(rowViewport(3, 10, null)).toMatchObject({
      start: 0,
      end: 3,
      hiddenAbove: 0,
      hiddenBelow: 0,
    })
  })

  it('anchors a row to the top when scrolled', () => {
    // Rows 4..6 with both markers eating a row each out of the 5-row budget.
    expect(rowViewport(20, 5, 4)).toMatchObject({ start: 4, end: 7 })
  })

  it('packs the window full at the bottom edge instead of leaving dead rows', () => {
    // Anchoring row 18 of 20 in a 6-row budget would show 2 rows and waste 4;
    // it backs up so the frame is full.
    const view = rowViewport(20, 6, 18)
    expect(view.end).toBe(20)
    expect(view.end - view.start).toBe(5) // one row goes to the "above" marker
    expect(view.hiddenBelow).toBe(0)
  })

  it('handles an empty list', () => {
    expect(rowViewport(0, 5, null)).toMatchObject({ start: 0, end: 0 })
  })

  // The layout's load-bearing invariant: one row too many and ink's frame
  // outgrows the pane, which scrolls the render region and smears stale rows.
  it('never renders more rows than the budget, for any input', () => {
    const bad: string[] = []
    for (let total = 0; total <= 40; total++) {
      for (let budget = 1; budget <= 20; budget++) {
        const anchors: (number | null)[] = [null]
        for (let a = -2; a <= total + 2; a++) anchors.push(a)
        for (const anchor of anchors) {
          const v = rowViewport(total, budget, anchor)
          const rendered =
            v.end - v.start + (v.showAbove ? 1 : 0) + (v.showBelow ? 1 : 0)
          if (total > 0 && rendered > budget) {
            bad.push(`total=${total} budget=${budget} anchor=${anchor}: ${rendered} rows`)
          }
          if (v.hiddenAbove !== v.start || v.hiddenBelow !== total - v.end) {
            bad.push(`counts disagree with slice: ${JSON.stringify(v)}`)
          }
          if (v.start > v.end) bad.push(`inverted slice: ${JSON.stringify(v)}`)
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([])
  })

  it('can always reach the very top and the very bottom', () => {
    for (let total = 1; total <= 30; total++) {
      for (let budget = 1; budget <= 12; budget++) {
        // Anchored at row 0 the window starts at the top, with nothing hidden
        // above it; following the bottom, nothing is hidden below.
        expect(rowViewport(total, budget, 0).hiddenAbove).toBe(0)
        expect(rowViewport(total, budget, null).hiddenBelow).toBe(0)
      }
    }
  })
})

describe('itemRows', () => {
  it('spends no rows on vertical padding, so exchanges pack tightly', () => {
    const rows = itemRows({ key: 'a', kind: 'assistant', text: 'hi' }, 40, {
      clamp: false,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].panel).toBe(true)
  })

  it('emits one row per line of a multi-line body', () => {
    const rows = itemRows({ key: 'a', kind: 'assistant', text: 'one\ntwo\nthree' }, 40, {
      clamp: false,
    })
    expect(rows.map((r) => r.spans[0].text)).toEqual(['one', 'two', 'three'])
  })

  it('never emits a row wider than the pane', () => {
    const rows = itemRows({ key: 'a', kind: 'assistant', text: 'x'.repeat(200) }, 40, {
      clamp: false,
    })
    for (const row of rows) {
      const width = row.spans.reduce((n, s) => n + stripAnsi(s.text).length, 0)
      expect(width).toBeLessThanOrEqual(40)
    }
  })

  it('puts the gutter glyph on the first content row only', () => {
    const rows = itemRows({ key: 'a', kind: 'user', text: 'one\ntwo' }, 40, {
      clamp: false,
    })
    const withGutter = rows.filter((r) => r.gutter)
    expect(withGutter).toHaveLength(1)
    expect(withGutter[0].gutter?.text).toBe('◆')
  })

  it('leads with a spacer row when the item wants space before it', () => {
    const rows = itemRows({ key: 'a', kind: 'notice', text: 'note', spaceBefore: true }, 40, {
      clamp: false,
    })
    expect(rows[0].spacer).toBe(true)
  })

  it('clamps a long body, marking how many lines are hidden', () => {
    const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n')
    const item = { key: 'r', kind: 'tool_result' as const, text }
    const collapsed = itemRows(item, 40, { clamp: true })
    expect(collapsed).toHaveLength(7) // 6 lines + the "+N lines" marker
    // The row carries the COUNT; the renderer writes the hint, because which
    // key opens it (→ vs ctrl+r) depends on the highlight — a render concern.
    expect(collapsed[6].clampedLines).toBe(4)
    expect(itemRows(item, 40, { clamp: false })).toHaveLength(10)
  })

  it('measures visible columns, not escape sequences', () => {
    // A markdown-rendered line carries ANSI codes that occupy no columns.
    // Counting them would over-count rows and desync the window.
    const styled = `\u001b[1m${'x'.repeat(30)}\u001b[22m`
    const rows = itemRows({ key: 'a', kind: 'assistant', text: styled }, 40, {
      clamp: false,
    })
    expect(rows.filter((r) => r.spans.length > 0)).toHaveLength(1)
  })
})

describe('row anchors', () => {
  const rows: TranscriptRow[] = [
    { id: '0', entryKey: 'a', spans: [] },
    { id: '1', entryKey: 'b', spans: [], spacer: true },
    { id: '2', entryKey: 'b', spans: [] },
    { id: '3', entryKey: 'b', spans: [] },
    { id: '4', entryKey: 'c', spans: [] },
  ]

  it('round-trips a row index through an entry-relative anchor', () => {
    const anchor = anchorAt(rows, 3)
    expect(anchor).toEqual({ entryKey: 'b', rowOffset: 2 })
    expect(anchorIndex(rows, anchor!)).toBe(3)
  })

  it('survives rows being prepended above the anchor', () => {
    const anchor = anchorAt(rows, 3)!
    const grown = [{ id: 'x', entryKey: 'z', spans: [] }, ...rows]
    // Same content row, new flat index — this is what keeps a streamed
    // append from sliding the window.
    expect(anchorIndex(grown, anchor)).toBe(4)
  })

  it('reports a vanished entry so the caller can follow the bottom', () => {
    expect(anchorIndex(rows, { entryKey: 'gone', rowOffset: 0 })).toBeNull()
  })

  it('skips an entry leading spacer, which is a separator not content', () => {
    expect(entryRange(rows, 'b')).toEqual({ first: 2, last: 3 })
  })
})

describe('snapToEntry', () => {
  // Entry 'b' is 10 rows tall, taller than a 4-row window.
  const rows: TranscriptRow[] = [
    { id: 'a', entryKey: 'a', spans: [] },
    ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, entryKey: 'b', spans: [] })),
    { id: 'c', entryKey: 'c', spans: [] },
  ]

  it('brings an entry entered from above to the top of the window', () => {
    expect(snapToEntry(rows, 'a', { start: 5, end: 9 }, 4)).toBe(0)
  })

  it('shows a too-tall entry from its FIRST line, so it reads from the top', () => {
    expect(snapToEntry(rows, 'b', { start: 0, end: 4 }, 4)).toBe(1)
  })

  it('aligns an entry arriving from below to the bottom edge', () => {
    // 'c' is one row at index 11, entering a 4-row window that ends at 8.
    expect(snapToEntry(rows, 'c', { start: 4, end: 8 }, 4)).toBe(8)
  })

  it('leaves the window alone for an entry already fully in frame', () => {
    const short: TranscriptRow[] = [
      { id: 'a', entryKey: 'a', spans: [] },
      { id: 'b', entryKey: 'b', spans: [] },
      { id: 'c', entryKey: 'c', spans: [] },
    ]
    expect(snapToEntry(short, 'b', { start: 0, end: 3 }, 3)).toBeNull()
  })

  it('backs ↑ into a too-tall entry at its LAST line, keeping the walk going up', () => {
    // 'b' spans rows 1..10. Walking UP out of 'c' lands on 'b's bottom edge
    // (rows 7..10 on a 4-row window), not its far-away first line.
    expect(snapToEntry(rows, 'b', { start: 8, end: 12 }, 4, -1)).toBe(7)
  })

  it('walks ↓ into a too-tall entry at its FIRST line', () => {
    expect(snapToEntry(rows, 'b', { start: 0, end: 4 }, 4, 1)).toBe(1)
  })
})

describe('snapAnchorForEntry', () => {
  // A short entry, then one 10 rows tall — taller than the 4-row window.
  const shortThenLong: TranscriptRow[] = [
    { id: 'a', entryKey: 'a', spans: [] },
    ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, entryKey: 'b', spans: [] })),
  ]

  it('parks on the TOP of a trailing too-tall entry walked into from above', () => {
    // ↓ off the short entry onto the long last one: its first line, NOT the
    // bottom-follow that being the newest entry used to force.
    expect(snapAnchorForEntry(shortThenLong, 'b', { start: 0, end: 4 }, 4, 1)).toEqual({
      anchor: { entryKey: 'b', rowOffset: 0 },
    })
  })

  it('follows the bottom when the snap really does land on the last screenful', () => {
    // The same trailing entry, but short enough to fit: bottom-aligning it IS
    // the bottom of the log, so keep streaming content in view.
    const shortTail: TranscriptRow[] = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, entryKey: 'a', spans: [] })),
      { id: 'b0', entryKey: 'b', spans: [] },
    ]
    expect(snapAnchorForEntry(shortTail, 'b', { start: 0, end: 4 }, 4, 1)).toEqual({ anchor: null })
  })

  it('parks on the BOTTOM of a too-tall entry walked into from below', () => {
    // (short) (long) (short) with the highlight on the trailing short one: ↑
    // lands on the long entry's END — rows 7..10 of an 11-row block.
    const withTail: TranscriptRow[] = [...shortThenLong, { id: 'c', entryKey: 'c', spans: [] }]
    expect(snapAnchorForEntry(withTail, 'b', { start: 8, end: 12 }, 4, -1)).toEqual({
      anchor: { entryKey: 'b', rowOffset: 6 },
    })
  })

  it('reports no move for an entry already fully in frame', () => {
    expect(snapAnchorForEntry(shortThenLong, 'a', { start: 0, end: 4 }, 4, -1)).toBeNull()
  })
})

describe('withRenderedMarkdown', () => {
  it('styles assistant and user prose that contains markdown', () => {
    const item = { key: 'a', kind: 'assistant' as const, text: 'a **bold** word' }
    const out = withRenderedMarkdown(item, 60)
    expect(out.text).not.toBe(item.text)
    expect(stripAnsi(out.text)).toBe('a bold word')
  })

  it('leaves plain prose untouched, object identity included', () => {
    const item = { key: 'a', kind: 'assistant' as const, text: 'just plain prose' }
    expect(withRenderedMarkdown(item, 60)).toBe(item)
  })

  it('leaves tool and system lines alone — their asterisks and pipes are literal', () => {
    const tool = { key: 't', kind: 'tool' as const, text: 'Bash(ls *.ts | head)' }
    expect(withRenderedMarkdown(tool, 60)).toBe(tool)
    const system = { key: 's', kind: 'system' as const, text: '**not markdown**' }
    expect(withRenderedMarkdown(system, 60)).toBe(system)
  })

  it('pre-wraps to the given width so the height estimate is exact', () => {
    const long = `- ${'word '.repeat(40)}`
    const out = withRenderedMarkdown({ key: 'a', kind: 'assistant', text: long }, 40)
    for (const line of out.text.split('\n')) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(40)
    }
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

describe('spanColor', () => {
  // Nothing on a row may fall through to the terminal's own foreground: under a
  // light theme that is the same near-black as the canvas painted beneath it.
  it('gives an uncoloured span the brand foreground, never the terminal default', () => {
    expect(spanColor({}, true)).toBe(theme.foreground)
  })

  it('resolves dim to muted instead of leaning on the terminal honouring dim', () => {
    expect(spanColor({ dim: true }, true)).toBe(theme.muted)
  })

  it('keeps a span its own colour', () => {
    expect(spanColor({ color: theme.error, dim: true }, true)).toBe(theme.error)
  })

  it('swaps a pulsing mark to muted on the off beat, whatever it is coloured', () => {
    expect(spanColor({ color: theme.success, pulse: true }, false)).toBe(theme.muted)
    expect(spanColor({ color: theme.success, pulse: true }, true)).toBe(theme.success)
  })
})

describe('itemRows colours', () => {
  // styleFor leaves textColor off for most kinds, the assistant's prose (the
  // bulk of a transcript) included, so this is the path that used to reach ink
  // with no colour and render in the terminal's default foreground.
  // What each kind's body text lands on: prose and the work it describes read
  // primary, the infrastructure and a tool's output read quiet, a failure reads
  // error. Quiet is a COLOUR, so it survives a terminal that ignores dim.
  const bodyColor: Array<[TranscriptItem['kind'], string]> = [
    ['assistant', theme.foreground],
    ['user', theme.foreground],
    ['tool', theme.foreground],
    ['tool_result', theme.muted],
    ['thinking', theme.muted],
    ['system', theme.muted],
    ['notice', theme.muted],
    ['summary', theme.muted],
    ['error', theme.error],
  ]

  it('resolves each kind to its brand colour, never to the terminal default', () => {
    for (const [kind, expected] of bodyColor) {
      const rows = itemRows({ key: `k:${kind}`, kind, text: 'some text' }, 60, { clamp: false })
      const body = rows.filter((r) => r.spans.some((s) => s.text.includes('some text')))
      expect(body.length, kind).toBeGreaterThan(0)
      for (const row of body) {
        for (const span of row.spans) expect(spanColor(span, true), kind).toBe(expected)
        if (row.gutter) {
          expect(new Set<string>(Object.values(theme)), `${kind} gutter`).toContain(
            spanColor(row.gutter, true),
          )
        }
      }
    }
  })
})
