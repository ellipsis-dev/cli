import { describe, expect, it } from 'vitest'
import { cursorLineDown, cursorLineUp, reshapeTranscript } from '../src/ui/ConnectApp'
import { deriveSandboxState, sessionLogText } from '../src/lib/steps'
import {
  gutterFor,
  itemRows,
  layOutItems,
  settledItemKeys,
  settledRowCount,
  spanColor,
  withRenderedMarkdown,
  type TranscriptRow,
} from '../src/ui/transcriptRows'
import stripAnsi from 'strip-ansi'
import { theme } from '../src/lib/theme'
import type { TranscriptItem } from '@ellipsis-dev/sdk/store'

let seq = 0
// `record_format` is what recordToItems switches on, so a fixture carries the
// same token the wire does: claude_sdk@1 for agent records, ellipsis_lifecycle@1
// for platform ones.
function rec(recordType: string, payload: Record<string, unknown> = {}, source = 'lifecycle') {
  return {
    feed_seq: ++seq,
    source,
    record_type: recordType,
    record_format: source === 'lifecycle' ? 'ellipsis_lifecycle@1' : 'claude_sdk@1',
    payload,
  }
}

// The derivations themselves (deriveSandboxState, awaitingAgentPhase,
// deliveredUnechoedSends, lastLines, humanDuration, hookPhrase, …) are the
// SDK's now, tested there with its middot wording. What the CLI owns is the
// comma wording: src/lib/steps.ts wraps the SDK functions and swaps ' · '
// separators for ', ', so the terminal reads plain sentences.
describe('deriveSandboxState comma wording', () => {
  const texts = (state: ReturnType<typeof deriveSandboxState>) =>
    (state?.log ?? []).map((l) => l.text)

  it('writes phase readouts comma-separated, not middot-separated', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_starting', { repositories: ['o/r'] }),
        rec('sandbox_phase', {
          phase: 'image',
          status: 'completed',
          duration_ms: 1200,
          detail: { cache_tier: 'exact' },
        }),
        rec('sandbox_ready', {
          cache_tier: 'exact',
          phase_timings: { image: 1.5, clone: 27.5 },
        }),
      ],
      0,
    )
    expect(texts(state)).toEqual([
      'Starting sandbox…',
      'Preparing image, cached image, 1.2s',
      'Sandbox ready, cached image, 29s',
    ])
  })

  it('writes the retry headline comma-separated', () => {
    const state = deriveSandboxState(
      [
        rec('session_starting', { attempt: 0, wake_index: 0 }),
        rec('session_retrying', { reason: 'sandbox provisioning failed', attempt: 1 }),
      ],
      0,
    )
    expect(state?.headline).toBe('Retrying, sandbox provisioning failed')
  })

  it('passes null through — no lifecycle records means no block', () => {
    expect(deriveSandboxState([], 0)).toBeNull()
  })
})

describe('reshapeTranscript', () => {
  const assistant = (text: string) =>
    rec('cc', { kind: 'assistant', content: [{ type: 'text', text }] }, 'claude_code')
  const result = (over: Record<string, unknown> = {}) =>
    rec(
      'cc',
      { kind: 'result', duration_ms: 4000, cost_usd: 0.1, is_error: false, ...over },
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
        result({ cost_usd: 0.1 }),
        assistant('two'),
        result({ cost_usd: 0.25, duration_ms: 2000 }),
      ],
      0,
    )
    expect(items.map((i) => i.text)).toEqual(['one', 'two'])
  })

  it('drops a summary with no assistant message before it', () => {
    expect(reshapeTranscript([result()], 0).items).toEqual([])
  })

  it('skips records at or below the render cursor (--no-records)', () => {
    const hidden = [assistant('old'), result({ cost_usd: 0.1 })]
    const cursor = hidden[hidden.length - 1].feed_seq
    const { items } = reshapeTranscript(
      [...hidden, assistant('new'), result({ cost_usd: 0.18 })],
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

  it('counts agent records that render nothing, so a shape it cannot read is visible', () => {
    // A payload this build's reader returns nothing for.
    const shapeless = rec('assistant', { kind: 'assistant', content: [] }, 'claude_code')
    expect(reshapeTranscript([shapeless], 0)).toEqual({ items: [], undisplayed: 1 })
    expect(reshapeTranscript([assistant('fine'), shapeless], 0).undisplayed).toBe(1)
    // A harness this build has no reader for at all: recordToItems returns
    // undefined for an unknown record_format, which must count, not throw.
    const future = {
      ...rec('assistant', { kind: 'assistant' }, 'grok'),
      record_format: 'grok_native@1',
    }
    expect(reshapeTranscript([future], 0)).toEqual({ items: [], undisplayed: 1 })
    // A payload the reader THROWS on (an unknown kind reaches blocksOf) costs
    // one row, never the whole transcript.
    const hostile = rec('assistant', { kind: 'video' }, 'claude_code')
    expect(reshapeTranscript([assistant('before'), hostile], 0)).toEqual({
      items: [expect.objectContaining({ text: 'before' })],
      undisplayed: 1,
    })
    // A readable transcript never warns, and a silent-by-design init doesn't count.
    expect(reshapeTranscript([assistant('fine'), result()], 0).undisplayed).toBe(0)
    expect(
      reshapeTranscript([rec('system', { type: 'system', subtype: 'init' }, 'claude_code')], 0)
        .undisplayed,
    ).toBe(0)
  })
})

describe('sessionLogText comma wording', () => {
  it('writes reasons comma-separated, not middot-separated', () => {
    expect(sessionLogText('session_retrying', { reason: 'node lost' })).toBe(
      'Retrying, node lost',
    )
    expect(sessionLogText('session_cancelled', { reason: 'budget' })).toBe(
      'Session cancelled, budget',
    )
  })

  it('passes plain lines and nulls through unchanged', () => {
    expect(sessionLogText('session_idle', {})).toBe('Session asleep')
    expect(sessionLogText('session_starting', { wake_index: 0 })).toBeNull()
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

  it('leaves a turn-opening tool call flat, never branching off YOUR message', () => {
    // Your message is a lifted box; a ⎿ branch under it would read as work you
    // did rather than work the agent did.
    const out = layOutItems([user('u'), call('t1'), res('r1')])
    expect(out.map((p) => [p.item.key, p.indent, p.nested])).toEqual([
      ['u', 0, false],
      ['t1', 0, false],
      ['r1', 0, false],
    ])
  })

  it('nests under a ✻ thinking block too — thinking is the agent speaking', () => {
    // With extended thinking on, thinking → tool_use → tool_result is the usual
    // turn shape, so treating thinking as not-the-agent would flatten almost
    // every run in the transcript.
    const think: TranscriptItem = { key: 'th', kind: 'thinking', text: 'hmm', gutter: '✻' }
    const out = layOutItems([think, fold('t1')])
    expect(out[1]).toMatchObject({ indent: 2, nested: true, attach: true })
  })

  it('leaves a run with no parent above it flat', () => {
    // Replayed history can start mid-burst; there is nothing to hang off.
    const out = layOutItems([call('t1'), res('r1'), prose('a')])
    expect(out.map((p) => p.nested)).toEqual([false, false, false])
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

  it('bars user messages, marks assistant prose ● and system lines ✦, overriding the SDK gutter', () => {
    expect(gutterFor(item('user', '›'))).toBe('┃')
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

describe('settledItemKeys', () => {
  const item = (key: string, kind: TranscriptItem['kind'], text = 'x'): TranscriptItem => ({
    key,
    kind,
    text,
  })

  it('settles everything when no turn is in flight', () => {
    const items = [item('a', 'user'), item('b', 'assistant'), item('c', 'tool')]
    expect([...settledItemKeys(items, false)]).toEqual(['a', 'b', 'c'])
  })

  it('holds back the last message and its tool run while a turn is live', () => {
    // 'b' is the message the open run hangs off, so → can still unfold it and
    // its fold row can still grow: neither may be flushed yet.
    const items = [item('a', 'user'), item('b', 'assistant'), item('c', 'tool')]
    expect([...settledItemKeys(items, true)]).toEqual(['a'])
  })

  it('flushes a finished message once the agent moves on to the next', () => {
    const items = [
      item('a', 'user'),
      item('b', 'assistant'),
      item('c', 'tool'),
      item('d', 'assistant'),
    ]
    expect([...settledItemKeys(items, true)]).toEqual(['a', 'b', 'c'])
  })

  it('settles nothing when the transcript is only an open tool run', () => {
    expect(settledItemKeys([item('c', 'tool')], true).size).toBe(0)
  })
})

describe('settledRowCount', () => {
  const row = (id: string, entryKey: string): TranscriptRow => ({ id, entryKey, spans: [] })

  it('counts the settled PREFIX, stopping at the first live row', () => {
    const rows = [row('1', 'a'), row('2', 'a'), row('3', 'b'), row('4', 'c')]
    // 'c' is settled too, but it sits behind live 'b' — rows flush in screen
    // order, so the scan stops there.
    expect(settledRowCount(rows, new Set(['a', 'c']))).toBe(2)
  })

  it('is 0 when the first row is live and everything when all are settled', () => {
    const rows = [row('1', 'a'), row('2', 'b')]
    expect(settledRowCount(rows, new Set(['b']))).toBe(0)
    expect(settledRowCount(rows, new Set(['a', 'b']))).toBe(2)
  })
})

describe('itemRows', () => {
  it('spends no rows on vertical padding, so exchanges pack tightly', () => {
    const rows = itemRows({ key: 'a', kind: 'assistant', text: 'hi' }, 40)
    expect(rows).toHaveLength(1)
  })

  // Every row is unpainted: a row prints into the terminal's scrollback and is
  // never repainted, so a fill on it would outlive the frame that drew it. The
  // sender is carried by the gutter glyph alone.
  it('marks the sender with a gutter glyph and paints no background', () => {
    const gutterOf = (kind: TranscriptItem['kind'], nested = false): string | undefined =>
      itemRows({ key: 'a', kind, text: 'x' } as TranscriptItem, 40, { nested })[0]
        .gutter?.text
    expect(gutterOf('user')).toBe('┃')
    expect(gutterOf('assistant')).toBe('●')
    expect(gutterOf('notice')).toBe('✦')
    for (const row of itemRows({ key: 'a', kind: 'user', text: 'x' }, 40)) {
      expect(row).not.toHaveProperty('panel')
    }
  })

  it('emits one row per line of a multi-line body', () => {
    const rows = itemRows({ key: 'a', kind: 'assistant', text: 'one\ntwo\nthree' }, 40)
    expect(rows.map((r) => r.spans[0].text)).toEqual(['one', 'two', 'three'])
  })

  it('never emits a row wider than the pane', () => {
    const rows = itemRows({ key: 'a', kind: 'assistant', text: 'x'.repeat(200) }, 40)
    for (const row of rows) {
      const width = row.spans.reduce((n, s) => n + stripAnsi(s.text).length, 0)
      expect(width).toBeLessThanOrEqual(40)
    }
  })

  it('puts the gutter glyph on the first content row only', () => {
    const rows = itemRows({ key: 'a', kind: 'assistant', text: 'one\ntwo' }, 40)
    const withGutter = rows.filter((r) => r.gutter)
    expect(withGutter).toHaveLength(1)
    expect(withGutter[0].gutter?.text).toBe('●')
  })

  // The one exception: a user message's bar is an EDGE, so it repeats down every
  // row of the body rather than marking only the first.
  it('runs the user bar down every row of a multi-line message', () => {
    const rows = itemRows({ key: 'a', kind: 'user', text: 'one\ntwo' }, 40)
    expect(rows.map((r) => r.gutter?.text)).toEqual(['┃', '┃'])
  })

  it('marks a fold ⎿ only when it branches off a message, ● when it opens a turn', () => {
    const foldItem: TranscriptItem = { key: 'grp:t1', kind: 'notice', text: 'Ran 1 shell command' }
    expect(itemRows(foldItem, 40, { nested: true })[0].gutter?.text).toBe('⎿')
    expect(itemRows(foldItem, 40, { nested: false })[0].gutter?.text).toBe('●')
    // A real ✦ notice keeps its own mark either way.
    const notice: TranscriptItem = { key: 'n', kind: 'notice', text: 'Session asleep' }
    expect(itemRows(notice, 40, { nested: true })[0].gutter?.text).toBe('✦')
  })

  it('pads every row of a ⎿ item, so a wrapped body stays aligned', () => {
    const rows = itemRows({ key: 'r', kind: 'tool_result', text: 'a\nb', gutter: '⎿' }, 40)
    expect(rows.map((r) => r.textPad)).toEqual([1, 1])
    // And nothing else gets it.
    expect(itemRows({ key: 'a', kind: 'assistant', text: 'hi' }, 40)[0].textPad)
      .toBe(0)
  })

  it('leads with a spacer row when the item wants space before it', () => {
    const rows = itemRows({ key: 'a', kind: 'notice', text: 'note', spaceBefore: true }, 40)
    expect(rows[0].spacer).toBe(true)
  })

  it('clamps a long body, marking how many lines are hidden', () => {
    const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n')
    const rows = itemRows({ key: 'r', kind: 'tool_result' as const, text }, 40)
    expect(rows).toHaveLength(7) // 6 lines + the "+N lines" marker
    // The row carries the COUNT; the renderer writes the text around it.
    expect(rows[6].clampedLines).toBe(4)
  })

  it('measures visible columns, not escape sequences', () => {
    // A markdown-rendered line carries ANSI codes that occupy no columns.
    // Counting them would over-count rows and desync the window.
    const styled = `\u001b[1m${'x'.repeat(30)}\u001b[22m`
    const rows = itemRows({ key: 'a', kind: 'assistant', text: styled }, 40)
    expect(rows.filter((r) => r.spans.length > 0)).toHaveLength(1)
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
      const rows = itemRows({ key: `k:${kind}`, kind, text: 'some text' }, 60)
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
