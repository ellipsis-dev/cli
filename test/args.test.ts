import { describe, expect, it } from 'vitest'
import { collect, collectKeyValue, toInt } from '../src/lib/args'

describe('toInt', () => {
  it('parses base-10 integers', () => {
    expect(toInt('42')).toBe(42)
    expect(toInt('0')).toBe(0)
    expect(toInt('-7')).toBe(-7)
  })

  // Regression: a bare `parseInt` used as a commander coercion receives the
  // previous value as the radix, so `--limit 3` (default 50) yielded NaN.
  it('rejects non-integers instead of producing NaN', () => {
    expect(() => toInt('abc')).toThrow(/expected an integer/)
    expect(() => toInt('3.5')).toThrow(/expected an integer/)
    expect(() => toInt('')).toThrow(/expected an integer/)
  })
})

describe('collect', () => {
  it('accumulates repeated values into an array', () => {
    let acc: string[] = []
    acc = collect('cli', acc)
    acc = collect('api', acc)
    expect(acc).toEqual(['cli', 'api'])
  })
})

describe('collectKeyValue', () => {
  it('accumulates key=value pairs into an object', () => {
    let acc: Record<string, string> = {}
    acc = collectKeyValue('env=prod', acc)
    acc = collectKeyValue('team=billing', acc)
    expect(acc).toEqual({ env: 'prod', team: 'billing' })
  })

  it('keeps everything after the first = (values may contain =)', () => {
    expect(collectKeyValue('url=a=b', {})).toEqual({ url: 'a=b' })
  })

  it('rejects values without an =', () => {
    expect(() => collectKeyValue('novalue', {})).toThrow(/key=value/)
  })
})
