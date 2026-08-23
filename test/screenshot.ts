import { render } from 'ink'
import type { ReactElement } from 'react'
import { PassThrough } from 'node:stream'
import { Terminal } from '@xterm/headless'

// The interactive-UI render harness. An ink app renders against a fake
// TTY exactly as in connect-render.test.ts, but every byte it writes is fed
// through a REAL terminal emulator (@xterm/headless), so cursor moves and
// repaints resolve into the final screen a user would see — not a stream of
// ANSI. Tests assert on `page.text()` (the grid as plain text, diffable in
// CI). Fully offline: no PTY, no network.

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
  unmount(): void
}

export async function launchPage(
  element: ReactElement,
  { cols = 80, rows = 24 }: { cols?: number; rows?: number } = {},
): Promise<Page> {
  // allowProposedApi: reading the buffer's cells (text()) is
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
  // one final frame — no repaints, nothing this harness is
  // for (same reason connect-render.test.ts pins it).
  const app = render(element, { stdout, stdin, patchConsole: false, interactive: true })

  const settle = async (): Promise<void> => {
    // Two beats: effects that queue work behind a resolved promise (seeded
    // fetch stubs) need a second turn of the loop.
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
    unmount() {
      app.unmount()
      term.dispose()
    },
  }

  await settle()
  return page
}
