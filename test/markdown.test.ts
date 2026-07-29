import { describe, expect, it } from 'vitest'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import { fitLines, hasMarkdown, renderMarkdown, visibleWidth } from '../src/lib/markdown'
import { theme } from '../src/lib/theme'

const lines = (text: string): string[] => text.split('\n')
const plain = (text: string): string => stripAnsi(text)

describe('hasMarkdown', () => {
  it('detects the constructs worth parsing', () => {
    expect(hasMarkdown('**bold**')).toBe(true)
    expect(hasMarkdown('a `code` span')).toBe(true)
    expect(hasMarkdown('## heading')).toBe(true)
    expect(hasMarkdown('- bullet')).toBe(true)
    expect(hasMarkdown('1. ordered')).toBe(true)
    expect(hasMarkdown('> quote')).toBe(true)
    expect(hasMarkdown('| a | b |')).toBe(true)
    expect(hasMarkdown('[label](https://x.com)')).toBe(true)
  })

  it('passes on plain prose so the parser stays off the hot path', () => {
    expect(hasMarkdown('just some ordinary prose, 2 * 3 = 6')).toBe(false)
    expect(hasMarkdown('a sentence\nacross two lines')).toBe(false)
  })
})

describe('renderMarkdown', () => {
  it('styles inline runs without changing the words', () => {
    expect(plain(renderMarkdown('a **bold** and `code` word', 60))).toBe('a bold and code word')
  })

  it('drops the literal hashes from a heading', () => {
    expect(plain(renderMarkdown('## Summary', 60))).toBe('Summary')
  })

  it('keeps inline styling INSIDE list items (marked-terminal drops it unpatched)', () => {
    const out = renderMarkdown('- a bullet with **bold** and `code`', 60)
    expect(plain(out)).toContain('a bullet with bold and code')
    expect(out).not.toContain('**')
    expect(out).not.toContain('`')
  })

  it('draws a table', () => {
    const out = plain(renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |', 60))
    expect(out).toContain('│')
    expect(out).toContain('A')
    expect(out).toContain('2')
  })

  it('sizes a wide table to the pane and wraps its cells', () => {
    // cli-table3 sizes columns to their content by default, which pushed a
    // wide table past the pane and smeared its rows across the frame.
    const wide = [
      '| Step | Detail |',
      '|------|--------|',
      `| +5.1s | ${'a very long cell value '.repeat(6)} |`,
    ].join('\n')
    for (const width of [40, 60, 96]) {
      for (const line of lines(renderMarkdown(wide, width))) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width)
      }
    }
  })

  it('keeps inline styling inside table cells', () => {
    const out = renderMarkdown('| A | B |\n|---|---|\n| **hi** | `x` |', 60)
    expect(out).not.toContain('**')
    expect(plain(out)).toContain('hi')
  })

  it('wraps every line to the width, list continuations included', () => {
    const src = `- ${'word '.repeat(60)}`
    for (const line of lines(renderMarkdown(src, 40))) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40)
    }
  })

  it('hangs a wrapped bullet under its text, not its marker', () => {
    const out = lines(renderMarkdown(`- ${'word '.repeat(20)}`, 40)).map(plain)
    const marker = out[0].indexOf('*')
    expect(marker).toBeGreaterThanOrEqual(0)
    expect(out.length).toBeGreaterThan(1)
    expect(out[1].match(/^ */)?.[0].length).toBeGreaterThan(marker)
  })

  it('has no leading or trailing blank line — the transcript owns spacing', () => {
    const out = renderMarkdown('**hi**', 60)
    expect(out.startsWith('\n')).toBe(false)
    expect(out.endsWith('\n')).toBe(false)
  })

  it('is stable across calls at the same width (cached)', () => {
    expect(renderMarkdown('**hi**', 60)).toBe(renderMarkdown('**hi**', 60))
  })

  it('re-renders for a different width rather than reusing the cached wrap', () => {
    const src = `- ${'word '.repeat(30)}`
    expect(lines(renderMarkdown(src, 30)).length).toBeGreaterThan(
      lines(renderMarkdown(src, 90)).length,
    )
  })
})

describe('visibleWidth', () => {
  it('ignores escape sequences', () => {
    expect(visibleWidth('[1mbold[22m')).toBe(4)
    expect(visibleWidth('plain')).toBe(5)
  })
})

describe('fitLines', () => {
  it('returns the exact lines the text occupies, none wider than the width', () => {
    const out = fitLines('word '.repeat(30).trim(), 20)
    expect(out.length).toBeGreaterThan(1)
    for (const line of out) expect(visibleWidth(line)).toBeLessThanOrEqual(20)
  })

  it('keeps a short line as one line, and splits on existing newlines', () => {
    expect(fitLines('hi', 20)).toEqual(['hi'])
    expect(fitLines('a\nb\nc', 20)).toEqual(['a', 'b', 'c'])
  })

  it('measures visible columns, so escapes cost no width', () => {
    // 30 visible chars in a 40-column pane: one line, despite the escapes.
    expect(fitLines(`\u001b[1m${'x'.repeat(30)}\u001b[22m`, 40)).toHaveLength(1)
  })

  it('truncates a table row instead of reflowing it', () => {
    // Box-drawing rows can't move their columns, so they're cut to fit.
    const row = `│ ${'a'.repeat(40)} │`
    const out = fitLines(row, 20)
    expect(out).toHaveLength(1)
    expect(visibleWidth(out[0])).toBeLessThanOrEqual(20)
  })
})

// Everything a table draws used to resolve through the terminal's OWN 16-colour
// palette: chalk.red on the header cells, and cli-table3's `border: ['gray']`,
// which only takes a colour NAME. Whatever the user's theme mapped those two
// slots to was what a table came out as.
describe('renderMarkdown colours', () => {
  const table = '| Name | Status |\n| --- | --- |\n| alpha | ok |'

  // Rendered escapes only exist when chalk is actually emitting colour, which
  // it isn't under a test runner's pipe. Force a level, and vary the width so
  // the (width, source)-keyed cache can't hand back an uncoloured render.
  const coloured = (source: string, width: number): string => {
    const level = chalk.level
    chalk.level = 3
    try {
      return renderMarkdown(source, width)
    } finally {
      chalk.level = level
    }
  }

  it('draws the header in brand bone, not the palette red', () => {
    const out = coloured(table, 41)
    expect(out).not.toContain('[31m')
    expect(out).toContain(chalk.hex(theme.foreground).bold('Name'))
  })

  it('draws the rules in brand muted, not the palette grey', () => {
    const out = coloured(table, 42)
    expect(out).not.toContain('[90m')
    // Every box-drawing run carries the muted foreground.
    for (const run of out.match(/[│┌┐└┘├┤┬┴┼─]+/g) ?? []) {
      expect(out).toContain(chalk.hex(theme.muted)(run))
    }
  })

  it('leaves cell text uncoloured so the row it lands on supplies the brand fg', () => {
    // The transcript wraps each row in an explicit colour (see spanColor), and
    // chalk re-opens it after a nested reset, so a cell needs no colour of its
    // own — but it must not carry a full [0m either, which would drop the
    // row's background tint for the rest of the line.
    const out = coloured(table, 43)
    expect(out).not.toContain('[0m')
  })
})
