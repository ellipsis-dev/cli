import { describe, expect, it } from 'vitest'
import {
  collectInputs,
  parseAssignment,
  parseEnvFile,
  parseJsonVars,
} from '../src/commands/sandbox'

describe('parseJsonVars', () => {
  it('parses a flat object of name → value', () => {
    expect(parseJsonVars('{"A":"1","B":"two"}')).toEqual([
      { name: 'A', value: '1' },
      { name: 'B', value: 'two' },
    ])
  })

  it('accepts an empty object', () => {
    expect(parseJsonVars('{}')).toEqual([])
  })

  it('throws on invalid JSON', () => {
    expect(() => parseJsonVars('{not json}')).toThrow(/invalid JSON/)
  })

  it('rejects a top-level array', () => {
    expect(() => parseJsonVars('["A","B"]')).toThrow(/object of variable name/)
  })

  it('rejects non-string values', () => {
    expect(() => parseJsonVars('{"A":1}')).toThrow(/value for 'A' must be a string/)
    expect(() => parseJsonVars('{"A":{"nested":"x"}}')).toThrow(/value for 'A' must be a string/)
  })
})

describe('parseAssignment', () => {
  it('parses KEY=VALUE', () => {
    expect(parseAssignment('A=1')).toEqual({ name: 'A', value: '1' })
  })

  it('splits on the first = so values may contain =', () => {
    expect(parseAssignment('URL=https://x.test/?a=b')).toEqual({
      name: 'URL',
      value: 'https://x.test/?a=b',
    })
  })

  it('strips a leading `export ` and surrounding quotes', () => {
    expect(parseAssignment('export TOKEN="abc"')).toEqual({ name: 'TOKEN', value: 'abc' })
  })

  it('returns null when there is no =', () => {
    expect(parseAssignment('NOEQUALS')).toBeNull()
  })
})

describe('collectInputs', () => {
  it('collects multiple inline assignments', () => {
    expect(collectInputs(['A=1', 'B=2'], undefined)).toEqual([
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
    ])
  })

  it('throws on an inline arg with no =', () => {
    expect(() => collectInputs(['A=1', 'BAD'], undefined)).toThrow(/invalid assignment 'BAD'/)
  })

  it('throws when given nothing', () => {
    expect(() => collectInputs([], undefined)).toThrow(/provide KEY=VALUE/)
  })
})

describe('parseEnvFile', () => {
  it('parses KEY=VALUE pairs', () => {
    expect(parseEnvFile('A=1\nB=two')).toEqual([
      { name: 'A', value: '1' },
      { name: 'B', value: 'two' },
    ])
  })

  it('skips blank lines and # comments', () => {
    expect(parseEnvFile('\n# a comment\nA=1\n\n')).toEqual([{ name: 'A', value: '1' }])
  })

  it('strips a leading `export `', () => {
    expect(parseEnvFile('export TOKEN=abc')).toEqual([{ name: 'TOKEN', value: 'abc' }])
  })

  it('splits on the first = so values may contain =', () => {
    expect(parseEnvFile('URL=https://x.test/?a=b')).toEqual([
      { name: 'URL', value: 'https://x.test/?a=b' },
    ])
  })

  it('strips matching surrounding quotes', () => {
    expect(parseEnvFile(`A="quoted"\nB='single'\nC="mismatch'`)).toEqual([
      { name: 'A', value: 'quoted' },
      { name: 'B', value: 'single' },
      { name: 'C', value: `"mismatch'` },
    ])
  })

  it('ignores lines with no =', () => {
    expect(parseEnvFile('NOEQUALS\nA=1')).toEqual([{ name: 'A', value: '1' }])
  })
})
