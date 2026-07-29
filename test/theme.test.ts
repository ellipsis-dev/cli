import { describe, expect, it } from 'vitest'
import { Chalk } from 'chalk'
import { surfaceFor, theme } from '../src/lib/theme'

// The 256-color index chalk resolves a hex to, which is what ink paints with
// on a terminal that does 256 colors but not truecolor.
const ansi256 = (hex: string): number => {
  const match = new Chalk({ level: 2 }).bgHex(hex)('x').match(/48;5;(\d+)/)
  return Number(match?.[1])
}

describe('surfaceFor', () => {
  it('leaves the authored warmth alone on a truecolor terminal', () => {
    expect(surfaceFor('#1c1b1a', 3)).toBe('#1c1b1a')
    expect(surfaceFor('#262523', 3)).toBe('#262523')
  })

  it('neutralizes the channels below truecolor', () => {
    expect(surfaceFor('#1c1b1a', 2)).toBe('#1b1b1b')
    expect(surfaceFor('#262523', 2)).toBe('#252525')
    expect(surfaceFor('#343330', 2)).toBe('#323232')
    expect(surfaceFor('#1c1b1a', 1)).toBe('#1b1b1b')
  })

  it('passes a malformed hex through rather than painting garbage', () => {
    expect(surfaceFor('nonsense', 2)).toBe('nonsense')
  })

  // The bug this exists for: chalk sends any hex whose channels differ to the
  // 6x6x6 color cube, whose darkest step above black is rgb(95,95,95). All
  // three warm brand surfaces landed on that ONE index, so the near-black
  // canvas painted mid grey and every surface step (and with it every "you are
  // here" highlight) disappeared on a 256-color terminal.
  it('keeps the three surfaces three distinct steps on a 256-color terminal', () => {
    const authored = [ansi256('#1c1b1a'), ansi256('#262523'), ansi256('#343330')]
    expect(new Set(authored).size).toBe(1)
    expect(authored[0]).toBe(59)

    const painted = [
      ansi256(surfaceFor('#1c1b1a', 2)),
      ansi256(surfaceFor('#262523', 2)),
      ansi256(surfaceFor('#343330', 2)),
    ]
    expect(new Set(painted).size).toBe(3)
    // On the greyscale ramp (232-255), where a near-black stays near-black.
    expect(painted.every((index) => index >= 232)).toBe(true)
    expect(painted).toEqual([...painted].sort((a, b) => a - b))
  })
})

describe('theme', () => {
  it('carries a color for every token, so no call site has to fall back', () => {
    for (const [name, value] of Object.entries(theme)) {
      expect(value, name).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})
