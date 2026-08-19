import { useEffect, useRef } from 'react'
import { useApp, useStdout } from 'ink'

// The alternate screen buffer (DECSET 1049), hand-rolled because ink 7 takes
// `alternateScreen` only as a render()-time option and this app has to hop
// buffers at runtime under ONE live ink instance: the default view lives in the
// primary buffer with its settled transcript flushed to real scrollback, and
// the transcript browser takes over the alt screen and hands the primary buffer
// back untouched on exit.
//
// The switch goes through ink's suspendTerminal, which is the only way to keep
// ink's picture of the screen honest across it: suspend ERASES the current
// frame, and resume forces a full redraw with the frame bookkeeping reset
// (lastOutput/lastOutputHeight). Writing 1049h/l behind ink's back instead
// leaves ink diffing the next frame against one that is no longer on screen,
// which paints the new frame over the wrong rows. Input is paused for the
// duration and restored by resume, so the keyboard survives the hop.
const ENTER = '[?1049h[2J[H'
const LEAVE = '[?1049l'

export function useAltScreen(active: boolean): void {
  const { suspendTerminal } = useApp()
  const { stdout } = useStdout()
  // Transitions are serialized: suspendTerminal throws if the terminal is
  // already suspended, and two fast toggles (ctrl+r then esc) would otherwise
  // overlap. Errors are swallowed — failing to hop buffers must not take the
  // session down.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const hop = (write: string): void => {
    if (!stdout?.isTTY) return
    queue.current = queue.current
      .then(() => suspendTerminal(() => void stdout.write(write)))
      .catch(() => {})
  }
  useEffect(() => {
    if (!active) return
    hop(ENTER)
    // Also the unmount path: quitting from inside the browser must give the
    // primary buffer back rather than leave the shell on the alt screen.
    return () => hop(LEAVE)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, stdout, suspendTerminal])
}
