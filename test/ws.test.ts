import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildStreamUrl,
  classifyCloseCode,
  decideReconnect,
  nextReconnectDelayMs,
  resolveWsBase,
  streamRun,
  StreamAuthError,
  StreamUnavailableError,
  type SocketFactory,
  type StreamFrame,
  type StreamSocket,
} from '../src/lib/ws'

// A controllable in-memory socket so the reconnect/resume/fallback machinery can
// be driven deterministically with fake timers — no real server.
class FakeSocket implements StreamSocket {
  private openCb?: () => void
  private msgCb?: (data: string) => void
  private closeCb?: (code: number) => void
  private errCb?: (err: Error) => void
  closed = false

  onOpen(cb: () => void): void {
    this.openCb = cb
  }
  onMessage(cb: (data: string) => void): void {
    this.msgCb = cb
  }
  onClose(cb: (code: number) => void): void {
    this.closeCb = cb
  }
  onError(cb: (err: Error) => void): void {
    this.errCb = cb
  }
  close(): void {
    this.closed = true
  }

  emitOpen(): void {
    this.openCb?.()
  }
  emitFrame(frame: StreamFrame): void {
    this.msgCb?.(JSON.stringify(frame))
  }
  emitClose(code: number): void {
    this.closeCb?.(code)
  }
  emitError(err: Error): void {
    this.errCb?.(err)
  }
}

function makeFactory(): { factory: SocketFactory; sockets: { url: string; sock: FakeSocket }[] } {
  const sockets: { url: string; sock: FakeSocket }[] = []
  const factory: SocketFactory = (url) => {
    const sock = new FakeSocket()
    sockets.push({ url, sock })
    return sock
  }
  return { factory, sockets }
}

// ------------------------------ pure helpers --------------------------------

describe('pure helpers', () => {
  it('classifies WebSocket close codes', () => {
    expect(classifyCloseCode(1000)).toBe('normal')
    expect(classifyCloseCode(1008)).toBe('auth')
    expect(classifyCloseCode(1003)).toBe('unsupported')
    expect(classifyCloseCode(1011)).toBe('retry')
    expect(classifyCloseCode(1006)).toBe('retry')
  })

  it('backs off exponentially up to a cap', () => {
    expect(nextReconnectDelayMs(1)).toBe(500)
    expect(nextReconnectDelayMs(2)).toBe(1000)
    expect(nextReconnectDelayMs(3)).toBe(2000)
    expect(nextReconnectDelayMs(99)).toBe(8000)
  })

  it('decides auth failures and unsupported closes without retrying', () => {
    const base = { everReceivedFrame: true, attempt: 1, maxReconnects: 5 }
    expect(decideReconnect({ ...base, closeKind: 'auth' }).action).toBe('fail-auth')
    expect(decideReconnect({ ...base, closeKind: 'unsupported' }).action).toBe('fallback')
  })

  it('retries persistently once streaming has worked, briefly otherwise', () => {
    // Seen a frame: retry up to maxReconnects, then fall back.
    expect(
      decideReconnect({ closeKind: 'retry', everReceivedFrame: true, attempt: 4, maxReconnects: 5 })
        .action,
    ).toBe('reconnect')
    expect(
      decideReconnect({ closeKind: 'retry', everReceivedFrame: true, attempt: 5, maxReconnects: 5 })
        .action,
    ).toBe('fallback')
    // Never connected: bail out after a couple of attempts so polling kicks in.
    expect(
      decideReconnect({ errored: true, everReceivedFrame: false, attempt: 1, maxReconnects: 5 })
        .action,
    ).toBe('reconnect')
    expect(
      decideReconnect({ errored: true, everReceivedFrame: false, attempt: 2, maxReconnects: 5 })
        .action,
    ).toBe('fallback')
  })

  it('builds the stream URL with an optional after_seq cursor', () => {
    expect(buildStreamUrl('wss://h', 'run 1', 0)).toBe('wss://h/v1/runs/run%201/stream')
    expect(buildStreamUrl('wss://h', 'r', 7)).toBe('wss://h/v1/runs/r/stream?after_seq=7')
  })

  it('resolves the ws base from env, then derives it from the api base', () => {
    process.env.ELLIPSIS_WS_BASE = 'wss://explicit.example'
    expect(resolveWsBase('https://ignored')).toBe('wss://explicit.example')
    delete process.env.ELLIPSIS_WS_BASE
    expect(resolveWsBase('https://api.example')).toBe('wss://api.example')
    expect(resolveWsBase('http://localhost:5000')).toBe('ws://localhost:5000')
  })
})

// ------------------------------ streamRun -----------------------------------

describe('streamRun', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    delete process.env.ELLIPSIS_WS_BASE
  })

  it('emits every frame and resolves on done', async () => {
    const { factory, sockets } = makeFactory()
    const frames: StreamFrame[] = []
    const p = streamRun({
      token: 't',
      runId: 'r',
      wsBase: 'ws://x',
      connect: factory,
      onFrame: (f) => frames.push(f),
    })
    sockets[0].sock.emitOpen()
    sockets[0].sock.emitFrame({ type: 'status', status: 'running' })
    sockets[0].sock.emitFrame({ type: 'stdout', data: 'hello', seq: 1 })
    sockets[0].sock.emitFrame({ type: 'done', status: 'completed', exit_status: 'completed' })

    const outcome = await p
    expect(outcome).toEqual({ type: 'done', status: 'completed', exitStatus: 'completed' })
    expect(frames.map((f) => f.type)).toEqual(['status', 'stdout', 'done'])
    expect(sockets[0].sock.closed).toBe(true)
  })

  it('reconnects after a drop and resumes from the last seq (no loss/dupes)', async () => {
    const { factory, sockets } = makeFactory()
    const p = streamRun({
      token: 't',
      runId: 'r',
      wsBase: 'ws://x',
      connect: factory,
      onFrame: () => {},
    })
    sockets[0].sock.emitOpen()
    sockets[0].sock.emitFrame({ type: 'stdout', data: 'one', seq: 1 })
    sockets[0].sock.emitFrame({ type: 'stdout', data: 'two', seq: 2 })
    sockets[0].sock.emitClose(1011) // server error: retryable drop

    await vi.advanceTimersByTimeAsync(500) // backoff for attempt 1
    expect(sockets).toHaveLength(2)
    expect(sockets[1].url).toBe('ws://x/v1/runs/r/stream?after_seq=2')

    sockets[1].sock.emitFrame({ type: 'done', status: 'completed', exit_status: null })
    const outcome = await p
    expect(outcome).toEqual({ type: 'done', status: 'completed', exitStatus: null })
  })

  it('surfaces a server error frame as an error outcome (not a fallback)', async () => {
    const { factory, sockets } = makeFactory()
    const p = streamRun({ token: 't', runId: 'r', wsBase: 'ws://x', connect: factory, onFrame: () => {} })
    sockets[0].sock.emitFrame({ type: 'error', message: 'boom' })
    expect(await p).toEqual({ type: 'error', message: 'boom' })
  })

  it('falls back (throws StreamUnavailableError) on an unsupported close', async () => {
    const { factory, sockets } = makeFactory()
    const p = streamRun({ token: 't', runId: 'r', wsBase: 'ws://x', connect: factory, onFrame: () => {} })
    sockets[0].sock.emitClose(1003)
    await expect(p).rejects.toBeInstanceOf(StreamUnavailableError)
  })

  it('falls back when the socket never connects after a couple of tries', async () => {
    const { factory, sockets } = makeFactory()
    const p = streamRun({ token: 't', runId: 'r', wsBase: 'ws://x', connect: factory, onFrame: () => {} })
    const rejection = expect(p).rejects.toBeInstanceOf(StreamUnavailableError)
    sockets[0].sock.emitError(new Error('ECONNREFUSED'))
    await vi.advanceTimersByTimeAsync(500)
    expect(sockets).toHaveLength(2)
    sockets[1].sock.emitError(new Error('ECONNREFUSED'))
    await rejection
  })

  it('fails hard (StreamAuthError) on an auth-rejected close', async () => {
    const { factory, sockets } = makeFactory()
    const p = streamRun({ token: 't', runId: 'r', wsBase: 'ws://x', connect: factory, onFrame: () => {} })
    sockets[0].sock.emitClose(1008)
    await expect(p).rejects.toBeInstanceOf(StreamAuthError)
  })
})
