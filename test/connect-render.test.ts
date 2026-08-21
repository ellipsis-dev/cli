import { describe, expect, it } from 'vitest'
import React from 'react'
import { render } from 'ink'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { SessionTranscriptStore } from '@ellipsis-dev/sdk/store'
import { SESSION_STREAM_PROTOCOL_VERSION } from '@ellipsis-dev/sdk/stream'
import { ConnectApp } from '../src/ui/ConnectApp'

// End-to-end render of the real chat against a fake TTY: the scrollback view is
// a claim about what reaches the TERMINAL (settled rows printed once, above a
// repainting live frame), and only an actual render can check it. The stream and
// API are stubbed — nothing here talks to a network.

const h = React.createElement

function fakeTty(): { stream: NodeJS.WriteStream; output: () => string } {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream
  let out = ''
  stream.on('data', (chunk: Buffer) => {
    out += chunk.toString()
  })
  const tty = stream as unknown as { isTTY: boolean; columns: number; rows: number }
  tty.isTTY = true
  tty.columns = 80
  tty.rows = 24
  return { stream, output: () => out }
}

// A stdin the app's keyboard handlers will accept: without raw-mode support ink
// throws out of useInput and the app never gets to render its own frame.
function fakeStdin(): NodeJS.ReadStream {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  const tty = stdin as unknown as {
    isTTY: boolean
    setRawMode: () => unknown
    ref: () => void
    unref: () => void
  }
  tty.isTTY = true
  tty.setRawMode = () => stdin
  tty.ref = () => {}
  tty.unref = () => {}
  return stdin
}

// How many times a string was written to the terminal. The unit of the whole
// scrollback claim: a FLUSHED row is written once and then belongs to the
// terminal, while a live row is rewritten by every repaint. Comparing the two
// counts in one render is what distinguishes them — and it is why each test
// forces a repaint, so "once" means "survived repaints", not "never repainted".
function writes(raw: string, needle: string): number {
  return stripAnsi(raw).split(needle).length - 1
}

// A cost tick, which changes the footer's total and so forces a real repaint of
// the live region without touching the transcript. (An IDENTICAL frame is
// skipped by ink, so the value has to actually differ.)
function costTick(store: SessionTranscriptStore, cents: number): void {
  store.ingest({
    type: 'session',
    session: {
      id: 'session_render',
      status: 'waiting',
      cost: { llm: cents, sandbox_cpu: 0, sandbox_memory: 0, fee: 0, total: cents },
      tokens: {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_creation: 0,
        total: cents,
        model: 'claude-fable-5',
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40))

// The render options every test here uses. `interactive: true` is not optional:
// ink treats CI as non-interactive (is-in-ci), and a non-interactive render
// buffers everything and emits ONE final frame — no erases, no repaints, no
// <Static> flush as it happens. Every claim in this file is about the difference
// between a flushed row and a repainted one, so the whole file measures nothing
// under CI without it. The real app pins the same flag for the same reason (see
// runConnect).
const OPTIONS = { patchConsole: false, interactive: true } as const

let seq = 0
// A claude_code assistant-message record — the shape recordToItems turns into a
// ● prose row.
function say(text: string): Record<string, unknown> {
  return {
    feed_seq: ++seq,
    source: 'claude_code',
    record_type: 'event',
    payload: {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  }
}

function lifecycle(recordType: string, payload: Record<string, unknown> = {}) {
  return { feed_seq: ++seq, source: 'lifecycle', record_type: recordType, payload }
}

function seededStore(records: Record<string, unknown>[], status: string) {
  const store = new SessionTranscriptStore()
  const session = {
    id: 'session_render',
    status,
    cost: { llm: 0, sandbox_cpu: 0, sandbox_memory: 0, fee: 0, total: 0 },
    tokens: {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_creation: 0,
      total: 0,
      model: 'claude-fable-5',
    },
  }
  store.ingest({
    type: 'snapshot',
    protocol: SESSION_STREAM_PROTOCOL_VERSION,
    earliest_feed_seq: null,
    session,
    messages: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store.ingest({ type: 'records_append', records } as any)
  return store
}

// The app with its network edges stubbed: the socket factory never connects, so
// the render is driven entirely by the seeded store.
function chat(store: SessionTranscriptStore, extra: Record<string, unknown> = {}) {
  return h(ConnectApp, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api: {} as any,
    sessionId: 'session_render',
    store,
    // Never resolves: no stream, no frames, no timers of its own.
    openSocket: () => new Promise(() => {}),
    canSend: true,
    minRenderFeedSeq: 0,
    sessionUrl: 'https://app.ellipsis.dev/acme?session=session_render',
    model: 'claude-fable-5',
    ...extra,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

describe('ConnectApp — the scrollback view', () => {
  it('prints a settled transcript once, and keeps printing it once as the frame repaints', async () => {
    // 'waiting' = no turn in flight, so every message is settled and flushes.
    const store = seededStore(
      [lifecycle('sandbox_ready', {}), say('first message'), say('second message')],
      'waiting',
    )
    const { stream, output } = fakeTty()
    const app = render(chat(store), { stdout: stream, stdin: fakeStdin(), ...OPTIONS })
    await settle()
    // Two more repaints of the live region, so "written once" below is a real
    // claim about the flush rather than an artifact of a single frame.
    // Big enough to move the dollar figure in the footer: $0.00 -> $0.50 -> $1.50.
    costTick(store, 50_000)
    await settle()
    costTick(store, 150_000)
    await settle()
    app.unmount()
    const raw = output()
    // The live region demonstrably repainted...
    expect(writes(raw, 'total')).toBeGreaterThan(1)
    // ...and the settled rows were written once anyway: they are the terminal's
    // now, which is what makes the wheel scroll them.
    expect(writes(raw, 'first message')).toBe(1)
    expect(writes(raw, 'second message')).toBe(1)
  })

  it('holds the last message in the live frame while a turn is in flight', async () => {
    // A live turn means the newest message can still grow a tool run under it, so
    // it must NOT be flushed — it stays in the repainting region, and the older
    // message flushes without it.
    const store = seededStore(
      [
        lifecycle('sandbox_ready', {}),
        say('older message'),
        say('newest message'),
        lifecycle('turn_started', { turn_id: 't1' }),
      ],
      'working',
    )
    const { stream, output } = fakeTty()
    const app = render(chat(store), { stdout: stream, stdin: fakeStdin(), ...OPTIONS })
    await settle()
    costTick(store, 50_000)
    await settle()
    app.unmount()
    const raw = output()
    // The older message settled and flushed: written once despite the repaint.
    expect(writes(raw, 'older message')).toBe(1)
    // The newest one is still live — a tool run can still land under it — so it
    // is rewritten by each repaint instead.
    expect(writes(raw, 'newest message')).toBeGreaterThan(1)
  })

  it('opens with a rule naming the session when it follows another chat', async () => {
    const store = seededStore([lifecycle('sandbox_ready', {}), say('hello')], 'waiting')
    const { stream, output } = fakeTty()
    const app = render(chat(store, { scrollbackBreak: true }), {
      stdout: stream,
      stdin: fakeStdin(),
      ...OPTIONS,
    })
    await settle()
    app.unmount()
    const text = stripAnsi(output())
    expect(text).toContain('session_render')
    expect(text).toContain('─')
  })

  it('paints no background on a FLUSHED row, so scrollback carries no stale fill', async () => {
    // A row printed into scrollback is never repainted, so a fill on it outlives
    // the frame that drew it: stale bands survive a resize or a shorter frame
    // with nothing able to clean them up. The composer is the one painted
    // surface, and it lives in the live frame — so the assertion is about the
    // flushed rows specifically, not about the byte stream as a whole.
    const store = seededStore(
      [lifecycle('sandbox_ready', {}), say('hello'), say('and again')],
      'waiting',
    )
    const { stream, output } = fakeTty()
    const app = render(chat(store), { stdout: stream, stdin: fakeStdin(), ...OPTIONS })
    await settle()
    app.unmount()
    // The flushed rows are everything written before the live frame's first
    // cursor-hide, which is where ink starts painting the region it owns.
    const raw = output()
    const flushed = raw.slice(0, raw.indexOf('\u001B[?25l'))
    expect(flushed).toContain('hello')
    expect(flushed).not.toMatch(/\u001B\[[0-9;]*4[0-7]m/)
    expect(flushed).not.toMatch(/\u001B\[[0-9;]*10[0-7]m/)
    expect(flushed).not.toContain('48;2;')
    expect(flushed).not.toContain('48;5;')
  })

  it('opens the slash-command menu as you type, and completes with tab', async () => {
    const store = seededStore([lifecycle('sandbox_ready', {}), say('hi')], 'waiting')
    const { stream, output } = fakeTty()
    const stdin = fakeStdin()
    const app = render(chat(store), { stdout: stream, stdin, ...OPTIONS })
    await settle()
    const before = output().length

    // A bare slash offers every command, with its description.
    stdin.write('/')
    await settle()
    let frame = stripAnsi(output().slice(before))
    expect(frame).toContain('/stop')
    expect(frame).toContain('/sessions')
    expect(frame).toContain('interrupt the agent')

    // Typing narrows it to one. Measured from HERE, not from the start: the byte
    // stream keeps every earlier frame, so a cumulative slice would still hold
    // the full list printed a moment ago.
    const beforeNarrow = output().length
    stdin.write('se')
    await settle()
    frame = stripAnsi(output().slice(beforeNarrow))
    expect(frame).toContain('/sessions')
    expect(frame).not.toContain('/stop')

    // Tab completes the highlighted command into the input.
    const beforeTab = output().length
    stdin.write('\t')
    await settle()
    expect(stripAnsi(output().slice(beforeTab))).toContain('/sessions')
    app.unmount()
  })

  it('does not capture the mouse in the chat, so the terminal keeps the wheel', async () => {
    // The point of the whole exercise: no SGR mouse reporting (1000h/1006h) is
    // armed while the chat is the view, which is what leaves wheel scrolling and
    // select/copy to the terminal.
    const store = seededStore([lifecycle('sandbox_ready', {}), say('hello')], 'waiting')
    const { stream, output } = fakeTty()
    const app = render(chat(store), { stdout: stream, stdin: fakeStdin(), ...OPTIONS })
    await settle()
    app.unmount()
    expect(output()).not.toContain('[?1000h')
    expect(output()).not.toContain('[?1049h')
  })
})
