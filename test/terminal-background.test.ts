import { describe, expect, it } from 'vitest'
import { modeFromColorFgBg, modeFromOscReply } from '../src/lib/terminalBackground'
import { applyThemeMode, darkPalette, lightPalette, theme } from '../src/lib/theme'

describe('modeFromOscReply', () => {
  it('reads a light background from a 16-bit-per-channel reply', () => {
    expect(modeFromOscReply('\x1b]11;rgb:ffff/ffff/ffff\x07')).toBe('light')
    expect(modeFromOscReply('\x1b]11;rgb:fdfd/f6f6/e3e3\x1b\\')).toBe('light')
  })

  it('reads a dark background', () => {
    expect(modeFromOscReply('\x1b]11;rgb:1c1c/1b1b/1a1a\x07')).toBe('dark')
    expect(modeFromOscReply('\x1b]11;rgb:0000/0000/0000\x07')).toBe('dark')
  })

  it('handles short channel widths', () => {
    expect(modeFromOscReply('\x1b]11;rgb:ff/ff/ff\x07')).toBe('light')
    expect(modeFromOscReply('\x1b]11;rgb:0/0/0\x07')).toBe('dark')
  })

  it('rejects anything that is not an OSC 11 color reply', () => {
    expect(modeFromOscReply('')).toBeNull()
    expect(modeFromOscReply('\x1b[6n')).toBeNull()
    expect(modeFromOscReply('\x1b]11;?\x07')).toBeNull()
  })
})

describe('modeFromColorFgBg', () => {
  it('reads the background from the last field', () => {
    expect(modeFromColorFgBg('0;15')).toBe('light')
    expect(modeFromColorFgBg('15;0')).toBe('dark')
    expect(modeFromColorFgBg('0;default;7')).toBe('light')
  })

  it('returns null when unset or malformed', () => {
    expect(modeFromColorFgBg(undefined)).toBeNull()
    expect(modeFromColorFgBg('')).toBeNull()
    expect(modeFromColorFgBg('default')).toBeNull()
  })
})

describe('applyThemeMode', () => {
  it('swaps the live palette in place, so existing imports follow', () => {
    applyThemeMode('light')
    expect(theme.foreground).toBe(lightPalette.foreground)
    applyThemeMode('dark')
    expect(theme.foreground).toBe(darkPalette.foreground)
  })
})
