import { describe, expect, it } from 'vitest'
import { theme } from '../src/lib/theme'

describe('theme', () => {
  it('carries a color for every token, so no call site has to fall back', () => {
    for (const [name, value] of Object.entries(theme)) {
      expect(value, name).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  // The palette paints FOREGROUNDS only. Backgrounds are the terminal's, because
  // transcript rows print into its scrollback and are never repainted — a fill
  // there outlives the frame that drew it. No surface tokens means no call site
  // can reintroduce one by reaching for a plausible name.
  it('holds no surface colors', () => {
    for (const name of Object.keys(theme)) {
      expect(name).not.toMatch(/canvas|panel|surface|background/i)
    }
  })
})
