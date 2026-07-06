import { describe, expect, it } from 'vitest'
import { relativeAge, usd, usdFromMillicents } from '../src/lib/output'

describe('usdFromMillicents', () => {
  it('converts millicents to dollars (1 cent = 1000 millicents)', () => {
    expect(usdFromMillicents(0)).toBe('$0.00')
    expect(usdFromMillicents(100_000)).toBe('$1.00') // 100 cents
    expect(usdFromMillicents(12_345_000)).toBe('$123.45')
  })
})

describe('relativeAge', () => {
  const now = new Date('2026-07-06T12:00:00Z')

  it('renders coarse relative ages', () => {
    expect(relativeAge('2026-07-06T11:59:30Z', now)).toBe('just now')
    expect(relativeAge('2026-07-06T11:58:00Z', now)).toBe('2 minutes ago')
    expect(relativeAge('2026-07-06T09:00:00Z', now)).toBe('3 hours ago')
    expect(relativeAge('2026-07-05T11:00:00Z', now)).toBe('1 day ago')
    expect(relativeAge('2026-05-20T12:00:00Z', now)).toBe('1 month ago')
    expect(relativeAge('2024-07-06T12:00:00Z', now)).toBe('2 years ago')
  })

  it('clamps future timestamps (clock skew) to "just now"', () => {
    expect(relativeAge('2026-07-06T12:05:00Z', now)).toBe('just now')
  })
})

describe('usd', () => {
  it('formats dollar amounts to two decimals', () => {
    expect(usd(0)).toBe('$0.00')
    expect(usd(9.5)).toBe('$9.50')
    expect(usd(100)).toBe('$100.00')
  })
})
