import { render } from 'ink'
import type { ReactElement } from 'react'
import { PassThrough } from 'node:stream'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Terminal } from '@xterm/headless'
import { Resvg } from '@resvg/resvg-js'

// The interactive-UI screenshot harness. An ink app renders against a fake
// TTY exactly as in connect-render.test.ts, but every byte it writes is fed
// through a REAL terminal emulator (@xterm/headless), so cursor moves,
// repaints and the alt-screen hop resolve into the final screen a user would
// see — not a stream of ANSI. Tests assert on `page.text()` (the grid as
// plain text, diffable in CI) and call `page.png(name)` to save a picture of
// the same grid for human/agent eyes. Fully offline: no PTY, no network.

const SCREENSHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__screenshots__',
)

// Named keys → the bytes a terminal sends for them. Anything not named is
// written verbatim (so page.press('n') just types n).
const KEYS: Record<string, string> = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  enter: '\r',
  escape: '\x1b',
  tab: '\t',
  backspace: '\x7f',
}

export interface Page {
  // Press a named key (or type a literal string), then settle.
  press(key: string): Promise<void>
  // Type a string into the app, then settle.
  type(text: string): Promise<void>
  // Change the fake window's size: the emulator and ink both hear about it.
  resize(cols: number, rows: number): Promise<void>
  // Wait for timers + the emulator to drain, so the grid is current.
  settle(): Promise<void>
  // The visible screen as plain text, one line per row, right-trimmed.
  text(): string
  // Save the visible screen as a PNG; returns the file path.
  png(name: string): Promise<string>
  unmount(): void
}

export async function launchPage(
  element: ReactElement,
  { cols = 80, rows = 24 }: { cols?: number; rows?: number } = {},
): Promise<Page> {
  // allowProposedApi: reading the buffer's cells (text() and the PNG) is
  // xterm's "proposed" API surface.
  // convertEol: a real TTY's driver turns \n into \r\n (ONLCR); ink relies on
  // that, and without it every line starts where the previous one ended.
  const term = new Terminal({ cols, rows, allowProposedApi: true, convertEol: true })

  // Writes into the emulator complete asynchronously; every chunk's callback
  // lands on this chain, so awaiting it means "the grid reflects everything
  // ink has written so far".
  let drained: Promise<void> = Promise.resolve()
  const feed = (data: string): void => {
    drained = drained.then(() => new Promise((resolve) => term.write(data, resolve)))
  }

  const stdout = new PassThrough() as unknown as NodeJS.WriteStream
  stdout.on('data', (chunk: Buffer) => feed(chunk.toString()))
  const outTty = stdout as unknown as { isTTY: boolean; columns: number; rows: number }
  outTty.isTTY = true
  outTty.columns = cols
  outTty.rows = rows

  // A stdin the app's useInput accepts: without raw-mode support ink throws
  // out of useInput before the app renders a frame of its own.
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  const inTty = stdin as unknown as {
    isTTY: boolean
    setRawMode: () => unknown
    ref: () => void
    unref: () => void
  }
  inTty.isTTY = true
  inTty.setRawMode = () => stdin
  inTty.ref = () => {}
  inTty.unref = () => {}

  // interactive pinned on: ink treats CI as non-interactive and would buffer
  // one final frame — no repaints, no alt-screen hop, nothing this harness is
  // for (same reason connect-render.test.ts pins it).
  const app = render(element, { stdout, stdin, patchConsole: false, interactive: true })

  const settle = async (): Promise<void> => {
    // Two beats: effects that queue work behind a resolved promise (the
    // alt-screen hop, seeded fetch stubs) need a second turn of the loop.
    await new Promise((resolve) => setTimeout(resolve, 60))
    await new Promise((resolve) => setTimeout(resolve, 60))
    await drained
  }

  const page: Page = {
    async press(key) {
      stdin.write(KEYS[key] ?? key)
      await settle()
    },
    async type(text) {
      stdin.write(text)
      await settle()
    },
    async resize(nextCols, nextRows) {
      outTty.columns = nextCols
      outTty.rows = nextRows
      term.resize(nextCols, nextRows)
      ;(stdout as unknown as NodeJS.EventEmitter).emit('resize')
      await settle()
    },
    settle,
    text() {
      const buffer = term.buffer.active
      const lines: string[] = []
      for (let y = 0; y < term.rows; y++) {
        lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '')
      }
      return lines.join('\n').replace(/\s+$/, '')
    },
    async png(name) {
      await settle()
      mkdirSync(SCREENSHOT_DIR, { recursive: true })
      const file = path.join(SCREENSHOT_DIR, `${name}.png`)
      writeFileSync(file, renderPng(term))
      return file
    },
    unmount() {
      app.unmount()
      term.dispose()
    },
  }

  await settle()
  return page
}

// ------------------------------- PNG render -------------------------------
// The grid drawn cell by cell into an SVG (explicit x per cell, so nothing
// depends on font metrics) and rasterized with resvg. Faithful to layout and
// color; the font and exact shades are the harness's, not any real terminal's.

const CELL_W = 8.4
const CELL_H = 18
const FONT_SIZE = 14
const PAD = 12
const DEFAULT_FG = '#e8e6e3'
const DEFAULT_BG = '#1a1a1a'

function renderPng(term: Terminal): Buffer {
  const width = term.cols * CELL_W + PAD * 2
  const height = term.rows * CELL_H + PAD * 2
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<rect width="${width}" height="${height}" fill="${DEFAULT_BG}"/>`,
  ]
  const buffer = term.buffer.active
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y)
    if (!line) continue
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x)
      if (!cell || cell.getWidth() === 0) continue
      let fg = cellColor(cell.isFgDefault(), cell.isFgRGB(), cell.getFgColor(), DEFAULT_FG)
      let bg = cellColor(cell.isBgDefault(), cell.isBgRGB(), cell.getBgColor(), DEFAULT_BG)
      if (cell.isInverse()) [fg, bg] = [bg, fg]
      const px = PAD + x * CELL_W
      const py = PAD + y * CELL_H
      if (bg !== DEFAULT_BG) {
        parts.push(
          `<rect x="${px}" y="${py}" width="${CELL_W * cell.getWidth()}" height="${CELL_H}" fill="${bg}"/>`,
        )
      }
      const chars = cell.getChars()
      if (!chars || chars === ' ') continue
      const weight = cell.isBold() ? ' font-weight="700"' : ''
      const dim = cell.isDim() ? ' opacity="0.55"' : ''
      const italic = cell.isItalic() ? ' font-style="italic"' : ''
      const deco = cell.isUnderline() ? ' text-decoration="underline"' : ''
      parts.push(
        `<text x="${px}" y="${py + FONT_SIZE}" font-family="Menlo, Consolas, monospace" ` +
          `font-size="${FONT_SIZE}" fill="${fg}"${weight}${dim}${italic}${deco}>${escapeXml(chars)}</text>`,
      )
    }
  }
  parts.push('</svg>')
  return Buffer.from(
    new Resvg(parts.join(''), {
      font: { loadSystemFonts: true, defaultFontFamily: 'Menlo' },
    })
      .render()
      .asPng(),
  )
}

function cellColor(isDefault: boolean, isRgb: boolean, color: number, fallback: string): string {
  if (isDefault) return fallback
  if (isRgb) return `#${color.toString(16).padStart(6, '0')}`
  return PALETTE_256[color] ?? fallback
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// The xterm 256-color palette: 16 ANSI colors (VS Code dark shades), the
// 6x6x6 color cube, then the 24-step grayscale ramp.
const PALETTE_256: string[] = (() => {
  const colors = [
    '#000000', '#cd3131', '#0dbc79', '#e5e510',
    '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
    '#666666', '#f14c4c', '#23d18b', '#f5f543',
    '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
  ]
  const steps = [0, 95, 135, 175, 215, 255]
  for (const r of steps)
    for (const g of steps)
      for (const b of steps)
        colors.push(
          `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b
            .toString(16)
            .padStart(2, '0')}`,
        )
  for (let i = 0; i < 24; i++) {
    const v = (8 + i * 10).toString(16).padStart(2, '0')
    colors.push(`#${v}${v}${v}`)
  }
  return colors
})()
