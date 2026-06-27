import { describe, expect, it } from 'vitest'
import { parseEnvFile } from '../src/commands/sandbox'

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
