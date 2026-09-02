import { describe, expect, it } from 'vitest'
import { formatSeconds, percentile, summarizeSamples } from '../src/lib/metrics'
import { joinPatches, omittedNote } from '../src/lib/sessionDiff'

describe('percentile', () => {
  it('is null on nothing', () => {
    expect(percentile([], 50)).toBeNull()
  })
  it('takes the nearest rank, unsorted input', () => {
    expect(percentile([30, 10, 20], 50)).toBe(20)
    expect(percentile([30, 10, 20, 40], 50)).toBe(20)
    expect(percentile([5], 50)).toBe(5)
    expect(percentile([1, 2, 3, 4], 100)).toBe(4)
    expect(percentile([1, 2, 3, 4], 0)).toBe(1)
  })
})

describe('summarizeSamples', () => {
  it('reports medians per axis', () => {
    expect(
      summarizeSamples([
        { duration_seconds: 10, cost: 100, tokens_total: 1 },
        { duration_seconds: 30, cost: 300, tokens_total: 3 },
        { duration_seconds: 20, cost: 200, tokens_total: 2 },
      ]),
    ).toEqual({ count: 3, duration_seconds_p50: 20, cost_millicents_p50: 200, tokens_p50: 2 })
  })
  it('is all-null with no sessions', () => {
    expect(summarizeSamples([])).toEqual({
      count: 0,
      duration_seconds_p50: null,
      cost_millicents_p50: null,
      tokens_p50: null,
    })
  })
})

describe('formatSeconds', () => {
  it('picks the unit by size', () => {
    expect(formatSeconds(45)).toBe('45s')
    expect(formatSeconds(192)).toBe('3m 12s')
    expect(formatSeconds(3840)).toBe('1h 04m')
    expect(formatSeconds(-3)).toBe('0s')
  })
})

describe('joinPatches', () => {
  it('concatenates sections with one trailing newline each', () => {
    expect(
      joinPatches([
        { full_name: 'o/r', path: 'a', patch: 'diff --git a/a b/a\n+x' },
        { full_name: 'o/r', path: 'b', patch: 'diff --git a/b b/b\n+y\n' },
      ]),
    ).toBe('diff --git a/a b/a\n+x\ndiff --git a/b b/b\n+y\n')
    expect(joinPatches([])).toBe('')
  })
})

describe('omittedNote', () => {
  it('names what was dropped', () => {
    expect(omittedNote([])).toBeNull()
    expect(omittedNote(['big.json'])).toBe('note: 1 file omitted (too large to store): big.json')
    expect(omittedNote(['a', 'b'])).toBe('note: 2 files omitted (too large to store): a, b')
  })
})
