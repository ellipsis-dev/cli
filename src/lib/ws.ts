import WebSocket from 'ws'
import { resolveApiBase } from './config'
import { DEFAULT_WS_BASE, USER_AGENT } from './constants'
import type { AgentSession, SessionMessage, SessionRecord } from './types'

// The session stream protocol v2 (server -> client), one JSON object per
// message. Mirrors the frame DTOs in the backend's
// public_api/realtime/session_stream.py (documents/eng/SESSION_STREAM_PROTOCOL.md):
//
//   snapshot:       { type, protocol, earliest_feed_seq, session, messages }
//   records_append: { type, records }          — raw session_records, by feed_seq
//   messages:       { type, messages }         — the OPEN inbox slice (LWW)
//   session:        { type, session }          — the lean session, resent on change
//   delta:          { type, agent_turn_id, kind, text?, output_tokens? }
//   heartbeat:      { type, ts }
//   done:           { type }                    — conversation over; close 1000 follows
//   error:          { type, message }           — curated copy; close 1011 follows
//
// Delivery classes: records_append is cursored append-only — the ONE resume
// cursor (`?after_seq=` = the highest feed_seq seen in records_append frames;
// messages/session frames NEVER advance it). session/messages are
// last-writer-wins snapshots; delta/heartbeat are fire-and-forget; done/error
// are terminal. Unknown frame types (and unknown source/record_type/kind
// values) MUST be ignored — additive server changes are not a protocol break.
export const SESSION_STREAM_PROTOCOL_VERSION = 2

export type StreamFrame =
  | {
      type: 'snapshot'
      protocol: number
      // The retention head: the lowest feed_seq still stored, or null when the
      // session has no stored records. Replaying from before it means history
      // was truncated under the customer's log retention.
      earliest_feed_seq: number | null
      session: AgentSession
      messages: SessionMessage[]
    }
  | { type: 'records_append'; records: SessionRecord[] }
  | { type: 'messages'; messages: SessionMessage[] }
  | { type: 'session'; session: AgentSession }
  | {
      type: 'delta'
      agent_turn_id?: string | null
      // "text" today; "thinking" reserved — ignore unknown kinds.
      kind?: string
      text?: string | null
      output_tokens?: number | null
    }
  | { type: 'heartbeat'; ts?: string }
  | { type: 'done' }
  | { type: 'error'; message?: string }
  // Forward compatibility: an unrecognized frame type parses, is handed to
  // onFrame, and must be ignored by renderers.
  | { type: string; [key: string]: unknown }

// The display word for a session: the server-derived surface status
// (working/waiting/sleeping/starting/closed/…) when present, else the raw
// per-execution status. Shared by every frame consumer so the stream and the
// REST poll can never disagree about the word.
export function sessionStatusWord(session: AgentSession): string {
  return session.surface?.status ?? session.status
}

// How streamSession() finished. `done`/`error` are normal terminal outcomes
// (`status` is the last session frame's derived word); `aborted` means the
// caller cancelled via the AbortSignal.
export type StreamOutcome =
  | { type: 'done'; status: string; exitStatus?: string | null }
  | { type: 'error'; message: string }
  | { type: 'aborted' }

// Thrown when streaming isn't usable (no endpoint, unsupported protocol, or
// reconnects exhausted) — the caller should fall back to REST polling.
export class StreamUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StreamUnavailableError'
  }
}

// Thrown when the server rejects the credential for this session (close 1008).
// Polling would fail the same way, so this is not a fallback case.
export class StreamAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StreamAuthError'
  }
}

export interface StreamOptions {
  token: string
  sessionId: string
  onFrame: (frame: StreamFrame) => void
  wsBase?: string
  afterSeq?: number
  signal?: AbortSignal
  maxReconnects?: number
  // Socket factory, injectable for tests. Defaults to a real `ws` WebSocket.
  connect?: SocketFactory
}

// Minimal socket surface streamSession() depends on, so tests can drive the
// reconnect/resume logic without a real server.
export interface StreamSocket {
  onOpen(cb: () => void): void
  onMessage(cb: (data: string) => void): void
  onClose(cb: (code: number) => void): void
  onError(cb: (err: Error) => void): void
  close(): void
}
export type SocketFactory = (url: string, token: string) => StreamSocket

// Server heartbeat cadence is 20s; if we hear nothing for ~2x that the socket
// is presumed dead and we reconnect (the protocol's own liveness rule).
const HEARTBEAT_TIMEOUT_MS = 45_000
const DEFAULT_MAX_RECONNECTS = 5

const defaultFactory: SocketFactory = (url, token) => {
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}`, 'user-agent': USER_AGENT },
  })
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
    case 1002: // unsupported protocol version requested
    case 1003: // no ?protocol= param (shouldn't happen — we always send it)
      return 'unsupported'
    default:
      // 1011 server error, 1013 over capacity, 1006 abnormal, etc.
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

export function buildStreamUrl(wsBase: string, sessionId: string, afterSeq: number): string {
  // ?protocol= is REQUIRED by the v2 handshake: a server that doesn't see it
  // closes 1003 (how pre-v2 binaries degrade to polling); an unknown version
  // closes 1002 with the supported list in the reason.
  const url = `${wsBase}/v1/sessions/${encodeURIComponent(sessionId)}/stream?protocol=${SESSION_STREAM_PROTOCOL_VERSION}`
  return afterSeq > 0 ? `${url}&after_seq=${afterSeq}` : url
}

// ------------------------------ connection ---------------------------------

type ConnResult =
  | { kind: 'done' }
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
        finish({ kind: 'done' })
      } else if (frame.type === 'error') {
        finish({
          kind: 'frameError',
          message: (frame as { message?: string }).message ?? 'stream error',
        })
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

// Stream an agent session to completion, reconnecting with backoff and
// resuming from the last records_append feed_seq so a dropped socket loses no
// records (§3.4: ONLY records advance the cursor — session/messages snapshots
// are re-sent fresh on reconnect). Calls `onFrame` for every frame received.
// Resolves with the terminal outcome — `done`'s status/exitStatus come from
// the last session frame, which the server guarantees carries the end state
// before `done`. Throws StreamUnavailableError (caller should poll instead) /
// StreamAuthError.
export async function streamSession(opts: StreamOptions): Promise<StreamOutcome> {
  const wsBase = opts.wsBase ?? resolveWsBase()
  const factory = opts.connect ?? defaultFactory
  const maxReconnects = opts.maxReconnects ?? DEFAULT_MAX_RECONNECTS

  let afterSeq = opts.afterSeq ?? 0
  let everReceivedFrame = false
  let attempt = 0
  let lastStatusWord = ''
  let lastExitStatus: string | null | undefined

  const emit = (frame: StreamFrame) => {
    everReceivedFrame = true
    if (frame.type === 'records_append') {
      const records = (frame as { records: SessionRecord[] }).records
      for (const record of records) {
        if (typeof record.feed_seq === 'number') {
          afterSeq = Math.max(afterSeq, record.feed_seq)
        }
      }
    } else if (frame.type === 'snapshot' || frame.type === 'session') {
      const session = (frame as { session: AgentSession }).session
      lastStatusWord = sessionStatusWord(session)
      lastExitStatus = (session.exit_status as string | null | undefined) ?? null
    }
    opts.onFrame(frame)
  }

  for (;;) {
    if (opts.signal?.aborted) return { type: 'aborted' }
    const url = buildStreamUrl(wsBase, opts.sessionId, afterSeq)
    const res = await connectOnce(url, opts.token, factory, emit, opts.signal)

    if (res.kind === 'done') {
      return { type: 'done', status: lastStatusWord, exitStatus: lastExitStatus }
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
      throw new StreamAuthError('not authorized to stream this session')
    }
    if (decision.action === 'fallback') {
      const why =
        res.kind === 'error' ? res.err.message : `stream closed (code ${res.code})`
      throw new StreamUnavailableError(why)
    }
    await sleep(decision.delayMs ?? 0, opts.signal)
  }
}
