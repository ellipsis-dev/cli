import { describe, expect, it } from 'vitest'
import React, { useEffect, useState } from 'react'
import { Box, Static, Text, render, useApp } from 'ink'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { useAltScreen } from '../src/ui/altScreen'

// Offline render harness for the two terminal mechanisms the scrollback view
// rests on: ink's <Static> flush and the alternate-screen hop. Neither is
// observable in the React tree — the difference is in the BYTES written — so
// both are driven against a fake TTY stream and asserted on its output.
// createElement rather than JSX: the suite is .ts by convention.
const h = React.createElement

// A stdout ink will treat as an interactive terminal, recording what is written.
function fakeTty(): { stream: NodeJS.WriteStream; output: () => string } {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream
  let out = ''
  stream.on('data', (chunk: Buffer) => {
    out += chunk.toString()
  })
  const tty = stream as unknown as { isTTY: boolean; columns: number; rows: number }
  tty.isTTY = true
  tty.columns = 80
  tty.rows = 24
  return { stream, output: () => out }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25))

describe('<Static> flush — the scrollback view', () => {
  it('prints each settled row ONCE and never reprints it', async () => {
    // The invariant the whole scrollback view rests on: a flushed row is printed
    // and then belongs to the terminal. Reprinting shows up as a duplicated
    // transcript, which is what makes this worth pinning down.
    const { stream, output } = fakeTty()
    function App(): React.ReactElement {
      const [rows, setRows] = useState(['alpha'])
      useEffect(() => {
        // A second row settles, exactly as a second message would.
        const t = setTimeout(() => setRows(['alpha', 'bravo']), 5)
        return () => clearTimeout(t)
      }, [])
      return h(
        Box,
        { flexDirection: 'column' },
        h(Static, { items: rows }, (row: string) => h(Text, { key: row }, row)),
        h(Text, null, 'live'),
      )
    }
    const app = render(h(App), { stdout: stream, patchConsole: false })
    await settle()
    app.unmount()
    const text = stripAnsi(output())
    expect(text.match(/alpha/g)?.length).toBe(1)
    expect(text.match(/bravo/g)?.length).toBe(1)
  })

  it('reprints from the start when the item list SHRINKS', async () => {
    // Why ConnectApp holds flushed rows in an append-only ref instead of
    // re-deriving them each frame: <Static> re-syncs its printed count from
    // items.length, so a shorter list (what withholding the flush for the alt
    // screen would produce) makes the next full list reprint what was already on
    // screen.
    const { stream, output } = fakeTty()
    function App(): React.ReactElement {
      const [rows, setRows] = useState(['alpha'])
      useEffect(() => {
        const shrink = setTimeout(() => setRows([]), 5)
        const grow = setTimeout(() => setRows(['alpha']), 15)
        return () => {
          clearTimeout(shrink)
          clearTimeout(grow)
        }
      }, [])
      return h(Static, { items: rows }, (row: string) => h(Text, { key: row }, row))
    }
    const app = render(h(App), { stdout: stream, patchConsole: false })
    await settle()
    app.unmount()
    expect(stripAnsi(output()).match(/alpha/g)?.length).toBe(2)
  })
})

describe('useAltScreen', () => {
  it('enters the alt buffer on open and restores the primary one on close', async () => {
    const { stream, output } = fakeTty()
    function App({ open }: { open: boolean }): React.ReactElement {
      useAltScreen(open)
      return h(Text, null, 'frame')
    }
    const app = render(h(App, { open: false }), { stdout: stream, patchConsole: false })
    await settle()
    expect(output()).not.toContain('[?1049h')

    app.rerender(h(App, { open: true }))
    await settle()
    expect(output()).toContain('[?1049h')

    app.rerender(h(App, { open: false }))
    await settle()
    expect(output()).toContain('[?1049l')
    app.unmount()
  })

  it('writes nothing to a non-TTY stdout — the headless --no-input follow', async () => {
    const stream = new PassThrough() as unknown as NodeJS.WriteStream
    let out = ''
    stream.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    function App(): React.ReactElement {
      useAltScreen(true)
      return h(Text, null, 'frame')
    }
    const app = render(h(App), { stdout: stream, patchConsole: false, interactive: true })
    await settle()
    app.unmount()
    expect(out).not.toContain('[?1049')
  })

  it('restores the primary buffer when the app exits while open', async () => {
    // Quitting from inside the browser must not strand the shell on the alt
    // screen.
    const { stream, output } = fakeTty()
    function App(): React.ReactElement {
      useAltScreen(true)
      const { exit } = useApp()
      useEffect(() => {
        const t = setTimeout(() => exit(), 5)
        return () => clearTimeout(t)
      }, [exit])
      return h(Text, null, 'frame')
    }
    const app = render(h(App), { stdout: stream, patchConsole: false })
    await settle()
    app.unmount()
    await settle()
    expect(output()).toContain('[?1049l')
  })
})
