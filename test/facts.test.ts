import { describe, expect, it } from 'vitest'
import { FACTS, randomFact } from '../src/lib/facts'

describe('FACTS', () => {
  it('holds exactly 100 facts', () => {
    expect(FACTS).toHaveLength(100)
  })

  it('has no duplicates or blank entries', () => {
    expect(new Set(FACTS).size).toBe(FACTS.length)
    for (const fact of FACTS) expect(fact.trim().length).toBeGreaterThan(0)
  })

  it('keeps every fact to a single line', () => {
    for (const fact of FACTS) expect(fact).not.toContain('\n')
  })
})

describe('randomFact', () => {
  it('returns a member of FACTS', () => {
    for (let i = 0; i < 50; i++) expect(FACTS).toContain(randomFact())
  })
})
