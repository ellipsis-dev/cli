import WebSocket from 'ws'
import { resolveApiBase } from './config'
import { DEFAULT_WS_BASE } from './constants'

// The frame protocol spoken over the run WebSocket (server -> client). One JSON
// object per message. Mirrors run_stream.py in the backend.
//   status: { type, status, ts }
//   stdout/stderr: { type, data, seq, ts }
//   done: { type, status, exit_status }
//   error: { type, message }
// `seq` is a monotonic per-run cursor; the client resumes from the last seq it
// saw via `?after_seq=` so a dropped socket loses nothing.
export interface StreamFrame {
  type: 'stdout' | 'stderr' | 'status' | 'done' | 'error'
  data?: string
  status?: string
  seq?: number
  ts?: string
  message?: string
  exit_status?: string | null
}

// How streamRun() finished. `done`/`error` are normal terminal outcomes;
// `aborted` means the caller cancelled via the AbortSignal.
export type StreamOutcome =
  | { type: 'done'; status: string; exitStatus?: string | null }
  | { type: 'error'; message: string }
  | { type: 'aborted' }

// Thrown when streaming isn't usable (no endpoint, unsupported close, or
// reconnects exhausted) — the caller should fall back to REST polling.
export class StreamUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StreamUnavailableError'
  }
}

// Thrown when the server rejects the credential for this run (close 1008).
// Polling would fail the same way, so this is not a fallback case.
export class StreamAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StreamAuthError'
  }
}

export interface StreamOptions {
  token: string
  runId: string
  onFrame: (frame: StreamFrame) => void
  wsBase?: string
  afterSeq?: number
  signal?: AbortSignal
  maxReconnects?: number
  // Socket factory, injectable for tests. Defaults to a real `ws` WebSocket.
  connect?: SocketFactory
}

// Minimal socket surface streamRun() depends on, so tests can drive the
// reconnect/resume logic without a real server.
export interface StreamSocket {
  onOpen(cb: () => void): void
  onMessage(cb: (data: string) => void): void
  onClose(cb: (code: number) => void): void
  onError(cb: (err: Error) => void): void
  close(): void
}
export type SocketFactory = (url: string, token: string) => StreamSocket

// Server keepalive cadence is ~20s; if we hear nothing for this long the socket
// is presumed dead and we reconnect.
const HEARTBEAT_TIMEOUT_MS = 45_000
const DEFAULT_MAX_RECONNECTS = 5

const defaultFactory: SocketFactory = (url, token) => {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
  return {
    onOpen: (cb) => ws.on('open', cb),
    onMessage: (cb) => ws.on('message', (raw: WebSocket.RawData) => cb(raw.toString())),
    onClose: (cb) => ws.on('close', (code: number) => cb(code)),
    // The `ws` package emits a real Error here; surface its message rather than
    // String(err) (which produced "[object ErrorEvent]" against the old stub).
    onError: (cb) =>
      ws.on('error', (err: unknown) =>
        cb(err instanceof Error ? err : new Error(String(err))),
      ),
    close: () => ws.close(),
  }
}

// ----------------------------- pure helpers --------------------------------

export type CloseKind = 'normal' | 'auth' | 'unsupported' | 'retry'

export function classifyCloseCode(code: number): CloseKind {
  switch (code) {
    case 1000:
      return 'normal'
    case 1008:
      return 'auth'
    case 1003:
      return 'unsupported'
    default:
      // 1011 server error, 1006 abnormal (refused / no endpoint), etc.
      return 'retry'
  }
}

// Exponential backoff, capped. Deterministic (no jitter) so it's easy to test.
export function nextReconnectDelayMs(attempt: number): number {
  const base = 500
  const max = 8_000
  return Math.min(max, base * 2 ** Math.max(0, attempt - 1))
}

export interface ReconnectDecision {
  action: 'reconnect' | 'fallback' | 'fail-auth'
  delayMs?: number
}

// Decide what to do after a connection ends without a terminal frame. Pure, so
// the reconnect/resume/fallback policy is unit-tested directly.
export function decideReconnect(params: {
  closeKind?: CloseKind
  errored?: boolean
  everReceivedFrame: boolean
  attempt: number
  maxReconnects: number
}): ReconnectDecision {
  const { closeKind, everReceivedFrame, attempt, maxReconnects } = params
  if (closeKind === 'auth') return { action: 'fail-auth' }
  if (closeKind === 'unsupported') return { action: 'fallback' }
  // Retryable: a transport error, an abnormal close, or a normal close that
  // arrived before the `done` frame. Be persistent once we've seen the server
  // actually stream (it clearly supports it); bail out fast otherwise so a
  // backend without the endpoint falls back to polling promptly.
  const cap = everReceivedFrame ? maxReconnects : Math.min(2, maxReconnects)
  if (attempt >= cap) return { action: 'fallback' }
  return { action: 'reconnect', delayMs: nextReconnectDelayMs(attempt) }
}

// Resolve the WebSocket base URL: explicit env wins, else derive from the
// resolved API base (so http://localhost -> ws://localhost), else the default.
export function resolveWsBase(apiBase?: string): string {
  const explicit = process.env.ELLIPSIS_WS_BASE
  if (explicit) return explicit.replace(/\/+$/, '')
  const base = (apiBase ?? resolveApiBase()).replace(/\/+$/, '')
  if (base.startsWith('https://')) return 'wss://' + base.slice('https://'.length)
  if (base.startsWith('http://')) return 'ws://' + base.slice('http://'.length)
  if (base.startsWith('ws://') || base.startsWith('wss://')) return base
  return DEFAULT_WS_BASE
}

export function buildStreamUrl(wsBase: string, runId: string, afterSeq: number): string {
  const url = `${wsBase}/v1/runs/${encodeURIComponent(runId)}/stream`
  return afterSeq > 0 ? `${url}?after_seq=${afterSeq}` : url
}

// ------------------------------ connection ---------------------------------

type ConnResult =
  | { kind: 'done'; status: string; exitStatus?: string | null }
  | { kind: 'frameError'; message: string }
  | { kind: 'closed'; code: number }
  | { kind: 'error'; err: Error }
  | { kind: 'aborted' }

// One WebSocket connection. Resolves when the stream reaches a terminal frame,
// the socket closes/errors, the heartbeat lapses, or the signal aborts.
function connectOnce(
  url: string,
  token: string,
  factory: SocketFactory,
  emit: (frame: StreamFrame) => void,
  signal?: AbortSignal,
): Promise<ConnResult> {
  return new Promise((resolve) => {
    const sock = factory(url, token)
    let settled = false
    let heartbeat: ReturnType<typeof setTimeout> | undefined

    const finish = (result: ConnResult) => {
      if (settled) return
      settled = true
      if (heartbeat) clearTimeout(heartbeat)
      if (signal) signal.removeEventListener('abort', onAbort)
      sock.close()
      resolve(result)
    }
    const onAbort = () => finish({ kind: 'aborted' })
    const bumpHeartbeat = () => {
      if (heartbeat) clearTimeout(heartbeat)
      heartbeat = setTimeout(
        () => finish({ kind: 'error', err: new Error('heartbeat timeout') }),
        HEARTBEAT_TIMEOUT_MS,
      )
    }

    if (signal) {
      if (signal.aborted) {
        finish({ kind: 'aborted' })
        return
      }
      signal.addEventListener('abort', onAbort)
    }

    sock.onOpen(() => bumpHeartbeat())
    sock.onMessage((data) => {
      bumpHeartbeat()
      let frame: StreamFrame
      try {
        frame = JSON.parse(data) as StreamFrame
      } catch {
        return // ignore non-JSON keepalives / garbage
      }
      emit(frame)
      if (frame.type === 'done') {
        finish({ kind: 'done', status: frame.status ?? '', exitStatus: frame.exit_status })
      } else if (frame.type === 'error') {
        finish({ kind: 'frameError', message: frame.message ?? frame.data ?? 'stream error' })
      }
    })
    sock.onClose((code) => finish({ kind: 'closed', code }))
    sock.onError((err) => finish({ kind: 'error', err }))
  })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

// ------------------------------ public API ---------------------------------

// Stream an agent run's output to completion, reconnecting with backoff and
// resuming from the last seen `seq` so a dropped socket loses no frames. Calls
// `onFrame` for every frame received. Resolves with the terminal outcome, or
// throws StreamUnavailableError (caller should poll instead) / StreamAuthError.
export async function streamRun(opts: StreamOptions): Promise<StreamOutcome> {
  const wsBase = opts.wsBase ?? resolveWsBase()
  const factory = opts.connect ?? defaultFactory
  const maxReconnects = opts.maxReconnects ?? DEFAULT_MAX_RECONNECTS

  let afterSeq = opts.afterSeq ?? 0
  let everReceivedFrame = false
  let attempt = 0

  const emit = (frame: StreamFrame) => {
    everReceivedFrame = true
    if (typeof frame.seq === 'number') afterSeq = Math.max(afterSeq, frame.seq)
    opts.onFrame(frame)
  }

  for (;;) {
    if (opts.signal?.aborted) return { type: 'aborted' }
    const url = buildStreamUrl(wsBase, opts.runId, afterSeq)
    const res = await connectOnce(url, opts.token, factory, emit, opts.signal)

    if (res.kind === 'done') {
      return { type: 'done', status: res.status, exitStatus: res.exitStatus }
    }
    if (res.kind === 'frameError') return { type: 'error', message: res.message }
    if (res.kind === 'aborted') return { type: 'aborted' }

    attempt++
    const decision = decideReconnect({
      closeKind: res.kind === 'closed' ? classifyCloseCode(res.code) : undefined,
      errored: res.kind === 'error',
      everReceivedFrame,
      attempt,
      maxReconnects,
    })
    if (decision.action === 'fail-auth') {
      throw new StreamAuthError('not authorized to stream this run')
    }
    if (decision.action === 'fallback') {
      const why =
        res.kind === 'error' ? res.err.message : `stream closed (code ${res.code})`
      throw new StreamUnavailableError(why)
    }
    await sleep(decision.delayMs ?? 0, opts.signal)
  }
}
