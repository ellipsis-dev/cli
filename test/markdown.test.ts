import { describe, expect, it } from 'vitest'
import stripAnsi from 'strip-ansi'
import { hasMarkdown, renderMarkdown, visibleWidth } from '../src/lib/markdown'

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
