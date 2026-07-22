import { describe, expect, it } from 'vitest'
import {
  collect,
  collectKeyValue,
  collectSource,
  collectStatus,
  parseScope,
  parseWhen,
  toInt,
} from '../src/lib/args'

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

describe('collectSource / collectStatus / parseScope', () => {
  it('accumulate valid values like collect', () => {
    expect(collectSource('cli', collectSource('laptop', []))).toEqual(['laptop', 'cli'])
    expect(collectStatus('completed', [])).toEqual(['completed'])
    expect(parseScope('recaps')).toBe('recaps')
    expect(parseScope('records')).toBe('records')
  })

  it('reject unknown values listing the valid ones', () => {
    expect(() => collectSource('slack', [])).toThrow(/source must be one of: laptop, react/)
    expect(() => collectStatus('done', [])).toThrow(/status must be one of: scheduled/)
    expect(() => parseScope('all')).toThrow(/scope must be one of: records, recaps, both/)
  })
})

describe('parseWhen', () => {
  // Fixed reference instant so the natural forms resolve deterministically.
  const now = new Date('2026-07-06T15:30:00')

  it('passes ISO 8601 timestamps through verbatim', () => {
    expect(parseWhen('2026-07-01T00:00:00+00:00', now)).toBe('2026-07-01T00:00:00+00:00')
    expect(parseWhen('2026-07-01', now)).toBe('2026-07-01')
  })

  it('resolves natural forms to the start of that day', () => {
    const startOfDay = (daysBack: number): string => {
      const d = new Date(now)
      d.setDate(d.getDate() - daysBack)
      d.setHours(0, 0, 0, 0)
      return d.toISOString()
    }
    expect(parseWhen('today', now)).toBe(startOfDay(0))
    expect(parseWhen('yesterday', now)).toBe(startOfDay(1))
    expect(parseWhen('3 days ago', now)).toBe(startOfDay(3))
    expect(parseWhen('1 day ago', now)).toBe(startOfDay(1))
    expect(parseWhen('YESTERDAY', now)).toBe(startOfDay(1)) // case-insensitive
  })

  it('rejects anything else', () => {
    expect(() => parseWhen('last tuesday', now)).toThrow(/ISO 8601/)
    expect(() => parseWhen('', now)).toThrow(/ISO 8601/)
  })
})
