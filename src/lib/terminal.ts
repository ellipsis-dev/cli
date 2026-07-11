import WebSocket, { type RawData } from 'ws'
import { USER_AGENT } from './constants'

// The raw-PTY attach behind `agent session connect --raw` and `agent session
// start --connect`: bridge the sandbox's ttyd terminal (a WebSocket over the
// agent's live tmux) to this local terminal, so the agent's pixel-perfect
// Claude Code TUI runs inside your shell.
//
// This is a pure /v1 client. It opens WS /v1/sessions/{id}/terminal with the
// ordinary Bearer login token; the API authenticates it, mints the Modal
// connect token server-side, and relays ttyd byte-for-byte (see the backend's
// session_terminal.py). The CLI never sees a sandbox URL, a Modal token, or a
// cookie — it only speaks ttyd's wire protocol over an already-authenticated
// socket.
//
// Contrast `agent session connect` (no --raw): that is the message-based line
// composer (POST /v1/sessions/{id}/messages) — single-writer-safe and usable
// headless / from inside a sandbox. The raw attach needs a real local TTY and
// is a second writer into the tmux, so it races the worker's inbox send-keys
// until the exclusive write-baton ships (INTERACTIVE_SESSIONS.md §6; accepted
// pre-GA).

// ttyd's WebSocket subprotocol (v1.7.x). Both legs — CLI<->API and API<->ttyd
// — negotiate it; the backend echoes it upstream.
export const TTYD_SUBPROTOCOL = 'tty'

// ttyd wire protocol command bytes (v1.7.x, protocol.c). The first byte of
// every framed message is the command; the rest is its payload.
const CLIENT_INPUT = '0' // stdin bytes -> PTY
const CLIENT_RESIZE = '1' // JSON {columns, rows}
const SERVER_OUTPUT = '0' // PTY bytes -> stdout
const SERVER_SET_TITLE = '1'
const SERVER_SET_PREFERENCES = '2'

// The detach key: Ctrl-] (GS, 0x1d) — the telnet escape, effectively never
// used inside a TUI, so it's a safe "let go of the terminal" chord. Ctrl-C is
// deliberately NOT a detach: it passes through to the agent (raw mode), so the
// remote sees the interrupt.
export const DETACH_KEY_CODE = 0x1d
export const DETACH_KEY_LABEL = 'Ctrl-]'

// Close codes mirrored from session_terminal.py — the protocol contract. The
// 45xx codes are application-defined (RFC 6455 §7.4.2) so we can print the
// right guidance instead of a bare number.
export const WS_CLOSE_NORMAL = 1000
export const WS_CLOSE_AUTH_FAILED = 1008
export const WS_CLOSE_SERVER_ERROR = 1011
export const WS_CLOSE_SANDBOX_UNAVAILABLE = 4409
export const WS_CLOSE_ACCESS_REVOKED = 4403

// ------------------------------ pure helpers -------------------------------

export function buildTerminalUrl(wsBase: string, sessionId: string): string {
  return `${wsBase.replace(/\/+$/, '')}/v1/sessions/${encodeURIComponent(sessionId)}/terminal`
}

// ttyd's first client message is the init/auth JSON (no command byte): an empty
// AuthToken (the API is the perimeter; ttyd runs without --credential) plus the
// initial window size.
export function ttydInitMessage(columns: number, rows: number): Buffer {
  return Buffer.from(JSON.stringify({ AuthToken: '', columns, rows }))
}

export function ttydInputMessage(data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(CLIENT_INPUT), data])
}

export function ttydResizeMessage(columns: number, rows: number): Buffer {
  return Buffer.concat([Buffer.from(CLIENT_RESIZE), Buffer.from(JSON.stringify({ columns, rows }))])
}

export type TtydServerMessage =
  | { kind: 'output'; data: Buffer }
  | { kind: 'title' | 'preferences' | 'unknown' }

// Split a server frame into its command + payload. Only OUTPUT carries terminal
// bytes; title/preferences are cosmetic and ignored by a raw attach.
export function parseTtydServerMessage(buf: Buffer): TtydServerMessage {
  if (buf.length === 0) return { kind: 'unknown' }
  const command = String.fromCharCode(buf[0])
  switch (command) {
    case SERVER_OUTPUT:
      return { kind: 'output', data: buf.subarray(1) }
    case SERVER_SET_TITLE:
      return { kind: 'title' }
    case SERVER_SET_PREFERENCES:
      return { kind: 'preferences' }
    default:
      return { kind: 'unknown' }
  }
}

// Human-readable one-liner for a terminal close, keyed on the code the backend
// sent (and its reason string, when it curated one).
export function describeTerminalClose(code: number, reason: string): string {
  switch (code) {
    case WS_CLOSE_NORMAL:
      return 'terminal closed'
    case WS_CLOSE_AUTH_FAILED:
      return 'not authorized to attach to this session'
    case WS_CLOSE_ACCESS_REVOKED:
      return 'access to this session ended'
    case WS_CLOSE_SANDBOX_UNAVAILABLE:
      return (
        reason ||
        'the session sandbox is not running — send it a message to wake it, then reconnect'
      )
    case WS_CLOSE_SERVER_ERROR:
      return reason ? `terminal server error: ${reason}` : 'terminal server error'
    default:
      return reason ? `connection closed (${code}): ${reason}` : `connection closed (code ${code})`
  }
}

// True for a close that ended the attach cleanly (normal close = the user
// detached or the agent's tmux ended). Everything else is a failure the caller
// should exit non-zero on.
export function isCleanClose(code: number): boolean {
  return code === WS_CLOSE_NORMAL
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data as ArrayBuffer)
}

// ------------------------------- the bridge --------------------------------

export interface AttachResult {
  code: number
  reason: string
}

export interface AttachOptions {
  token: string
  sessionId: string
  wsBase: string
  // Streams + signal handlers, injectable for tests; default to the process's.
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
}

// Attach this terminal to the session's ttyd over the API relay. Resolves with
// the close code/reason when the socket ends (user detach, agent exit, or a
// server-side revoke). Requires an interactive TTY: it takes over raw stdin.
export function attachTerminal(opts: AttachOptions): Promise<AttachResult> {
  const stdin = opts.stdin ?? process.stdin
  const stdout = opts.stdout ?? process.stdout

  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(
      new Error(
        'connect --raw needs an interactive terminal (a real TTY). ' +
          'Use `agent session connect` (message mode) for headless/scripted use.',
      ),
    )
  }

  const url = buildTerminalUrl(opts.wsBase, opts.sessionId)
  const ws = new WebSocket(url, [TTYD_SUBPROTOCOL], {
    headers: { authorization: `Bearer ${opts.token}`, 'user-agent': USER_AGENT },
  })

  return new Promise<AttachResult>((resolve, reject) => {
    let settled = false
    let rawEngaged = false

    const cols = (): number => stdout.columns ?? 80
    const rows = (): number => stdout.rows ?? 24

    const onStdin = (chunk: Buffer): void => {
      // A lone detach chord releases the terminal; anything else (including
      // Ctrl-C) is forwarded to the agent verbatim.
      if (chunk.length === 1 && chunk[0] === DETACH_KEY_CODE) {
        ws.close(WS_CLOSE_NORMAL)
        return
      }
      ws.send(ttydInputMessage(chunk))
    }
    const onResize = (): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(ttydResizeMessage(cols(), rows()))
    }

    const engageRaw = (): void => {
      if (rawEngaged) return
      rawEngaged = true
      stdin.setRawMode(true)
      stdin.resume()
      stdin.on('data', onStdin)
      process.on('SIGWINCH', onResize)
    }
    const restore = (): void => {
      if (!rawEngaged) return
      rawEngaged = false
      stdin.removeListener('data', onStdin)
      process.removeListener('SIGWINCH', onResize)
      stdin.setRawMode(false)
      stdin.pause()
    }

    const finish = (result: AttachResult): void => {
      if (settled) return
      settled = true
      restore()
      resolve(result)
    }

    ws.on('open', () => {
      ws.send(ttydInitMessage(cols(), rows()))
      stdout.write(`── attached (detach: ${DETACH_KEY_LABEL}) ──\r\n`)
      engageRaw()
    })
    ws.on('message', (data: RawData) => {
      const message = parseTtydServerMessage(toBuffer(data))
      if (message.kind === 'output') stdout.write(message.data)
    })
    ws.on('close', (code: number, reasonBuf: Buffer) => {
      finish({ code, reason: reasonBuf.toString() })
    })
    ws.on('error', (err: Error) => {
      if (settled) return
      settled = true
      restore()
      // A handshake rejection (e.g. HTTP 401/403 before upgrade) surfaces here;
      // the close handler won't fire, so reject with the transport error.
      reject(err)
    })
  })
}
