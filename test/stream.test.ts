import { afterEach, describe, expect, it } from 'vitest'
import { buildStreamUrl, resolveWsBase } from '../src/lib/stream'

// The CLI-side transport adapter only: the stream machinery itself
// (reconnect/resume/backoff, frame parsing, close-code policy) lives in
// @ellipsis-dev/sdk/stream and is tested there.

describe('resolveWsBase', () => {
  afterEach(() => {
    delete process.env.ELLIPSIS_WS_BASE
  })

  it('prefers the explicit env, then derives from the api base', () => {
    process.env.ELLIPSIS_WS_BASE = 'wss://explicit.example'
    expect(resolveWsBase('https://ignored')).toBe('wss://explicit.example')
    delete process.env.ELLIPSIS_WS_BASE
    expect(resolveWsBase('https://api.example')).toBe('wss://api.example')
    expect(resolveWsBase('http://localhost:5000')).toBe('ws://localhost:5000')
  })
})

describe('buildStreamUrl', () => {
  it('builds the bearer-door URL with the SDK handshake query', () => {
    expect(buildStreamUrl('wss://h', 'session 1', 'protocol=2')).toBe(
      'wss://h/v1/sessions/session%201/stream?protocol=2',
    )
    expect(buildStreamUrl('wss://h', 's', 'protocol=2&after_seq=7')).toBe(
      'wss://h/v1/sessions/s/stream?protocol=2&after_seq=7',
    )
  })
})
