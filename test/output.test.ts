import { describe, expect, it } from 'vitest'
import { usd, usdFromMillicents } from '../src/lib/output'

describe('usdFromMillicents', () => {
  it('converts millicents to dollars (1 cent = 1000 millicents)', () => {
    expect(usdFromMillicents(0)).toBe('$0.00')
    expect(usdFromMillicents(100_000)).toBe('$1.00') // 100 cents
    expect(usdFromMillicents(12_345_000)).toBe('$123.45')
  })
})

describe('usd', () => {
  it('formats dollar amounts to two decimals', () => {
    expect(usd(0)).toBe('$0.00')
    expect(usd(9.5)).toBe('$9.50')
    expect(usd(100)).toBe('$100.00')
  })
})
