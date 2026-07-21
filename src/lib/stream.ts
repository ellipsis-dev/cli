// The CLI's transport adapter for @ellipsis-dev/sdk/stream: the SDK owns the
// session-stream machinery (frames, reconnect/backoff, after_seq resume,
// heartbeat liveness); this module owns what is CLI-specific — resolving the
// WebSocket base URL from the environment/API base, building the bearer-door
// URL, and adapting the `ws` package to the SDK's injected socket surface.

import WebSocket from 'ws'
import type { OpenSocket, StreamSocket } from '@ellipsis-dev/sdk/stream'
import { resolveApiBase } from './config'
import { DEFAULT_WS_BASE, USER_AGENT } from './constants'

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

// The bearer door's stream URL: /v1/sessions/{id}/stream plus the SDK's
// handshake query (`protocol=2`, `after_seq` when resuming).
export function buildStreamUrl(wsBase: string, sessionId: string, query: string): string {
  return `${wsBase}/v1/sessions/${encodeURIComponent(sessionId)}/stream?${query}`
}

// An OpenSocket over the `ws` package with bearer auth — what every CLI
// stream consumer injects into the SDK's streamSession.
export function makeOpenSocket(token: string, wsBase?: string): OpenSocket {
  const base = wsBase ?? resolveWsBase()
  return ({ sessionId, query }): StreamSocket => {
    const ws = new WebSocket(buildStreamUrl(base, sessionId, query), {
      headers: { authorization: `Bearer ${token}`, 'user-agent': USER_AGENT },
    })
    return {
      onOpen: (cb) => ws.on('open', cb),
      onMessage: (cb) => ws.on('message', (raw: WebSocket.RawData) => cb(raw.toString())),
      onClose: (cb) => ws.on('close', (code: number) => cb(code)),
      // The `ws` package emits a real Error here; surface its message rather
      // than String(err) (which produced "[object ErrorEvent]" once).
      onError: (cb) =>
        ws.on('error', (err: unknown) =>
          cb(err instanceof Error ? err : new Error(String(err))),
        ),
      close: () => ws.close(),
    }
  }
}
