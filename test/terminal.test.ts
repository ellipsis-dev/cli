import { describe, expect, it } from 'vitest'
import {
  buildTerminalUrl,
  describeTerminalClose,
  DETACH_KEY_CODE,
  isCleanClose,
  parseTtydServerMessage,
  ttydInitMessage,
  ttydInputMessage,
  ttydResizeMessage,
  WS_CLOSE_ACCESS_REVOKED,
  WS_CLOSE_AUTH_FAILED,
  WS_CLOSE_NORMAL,
  WS_CLOSE_SANDBOX_UNAVAILABLE,
  WS_CLOSE_SERVER_ERROR,
} from '../src/lib/terminal'

describe('buildTerminalUrl', () => {
  it('builds the /v1 terminal WebSocket path and trims a trailing slash', () => {
    expect(buildTerminalUrl('wss://api.ellipsis.dev', 'session_abc')).toBe(
      'wss://api.ellipsis.dev/v1/sessions/session_abc/terminal',
    )
    expect(buildTerminalUrl('ws://localhost:5000/', 'session_abc')).toBe(
      'ws://localhost:5000/v1/sessions/session_abc/terminal',
    )
  })

  it('url-encodes the session id', () => {
    expect(buildTerminalUrl('wss://api.ellipsis.dev', 'a/b c')).toBe(
      'wss://api.ellipsis.dev/v1/sessions/a%2Fb%20c/terminal',
    )
  })
})

describe('ttyd client frames', () => {
  it('init message is bare JSON with empty AuthToken and the window size', () => {
    const parsed = JSON.parse(ttydInitMessage(120, 40).toString())
    expect(parsed).toEqual({ AuthToken: '', columns: 120, rows: 40 })
  })

  it('input message is command byte "0" followed by the raw bytes', () => {
    const frame = ttydInputMessage(Buffer.from('ls\r'))
    expect(String.fromCharCode(frame[0])).toBe('0')
    expect(frame.subarray(1).toString()).toBe('ls\r')
  })

  it('input message preserves arbitrary binary (e.g. control bytes) verbatim', () => {
    const raw = Buffer.from([0x03, 0x1b, 0x5b, 0x41]) // Ctrl-C, ESC [ A
    const frame = ttydInputMessage(raw)
    expect(frame[0]).toBe('0'.charCodeAt(0))
    expect(frame.subarray(1).equals(raw)).toBe(true)
  })

  it('resize message is command byte "1" followed by columns/rows JSON', () => {
    const frame = ttydResizeMessage(80, 24)
    expect(String.fromCharCode(frame[0])).toBe('1')
    expect(JSON.parse(frame.subarray(1).toString())).toEqual({ columns: 80, rows: 24 })
  })
})

describe('parseTtydServerMessage', () => {
  it('splits an OUTPUT frame into its payload bytes', () => {
    const msg = parseTtydServerMessage(Buffer.concat([Buffer.from('0'), Buffer.from('hi there')]))
    expect(msg.kind).toBe('output')
    if (msg.kind === 'output') expect(msg.data.toString()).toBe('hi there')
  })

  it('classifies title and preferences frames (no payload surfaced)', () => {
    expect(parseTtydServerMessage(Buffer.from('1title')).kind).toBe('title')
    expect(parseTtydServerMessage(Buffer.from('2{}')).kind).toBe('preferences')
  })

  it('treats an empty or unknown-command frame as unknown', () => {
    expect(parseTtydServerMessage(Buffer.alloc(0)).kind).toBe('unknown')
    expect(parseTtydServerMessage(Buffer.from('9x')).kind).toBe('unknown')
  })
})

describe('describeTerminalClose / isCleanClose', () => {
  it('only a normal close is clean', () => {
    expect(isCleanClose(WS_CLOSE_NORMAL)).toBe(true)
    expect(isCleanClose(WS_CLOSE_SANDBOX_UNAVAILABLE)).toBe(false)
    expect(isCleanClose(WS_CLOSE_ACCESS_REVOKED)).toBe(false)
  })

  it('maps each close code to actionable guidance', () => {
    expect(describeTerminalClose(WS_CLOSE_AUTH_FAILED, '')).toMatch(/not authorized/i)
    expect(describeTerminalClose(WS_CLOSE_ACCESS_REVOKED, '')).toMatch(/access .* ended/i)
    expect(describeTerminalClose(WS_CLOSE_SERVER_ERROR, '')).toMatch(/server error/i)
  })

  it('prefers the server-sent reason for a sandbox-unavailable close', () => {
    expect(describeTerminalClose(WS_CLOSE_SANDBOX_UNAVAILABLE, 'wake it first')).toBe('wake it first')
    // ...and falls back to canned guidance when the server sent no reason.
    expect(describeTerminalClose(WS_CLOSE_SANDBOX_UNAVAILABLE, '')).toMatch(/not running/i)
  })

  it('renders an unknown code with whatever reason arrived', () => {
    expect(describeTerminalClose(4999, 'weird')).toBe('connection closed (4999): weird')
    expect(describeTerminalClose(4999, '')).toBe('connection closed (code 4999)')
  })
})

describe('detach key', () => {
  it('is Ctrl-] (GS, 0x1d)', () => {
    expect(DETACH_KEY_CODE).toBe(0x1d)
  })
})
