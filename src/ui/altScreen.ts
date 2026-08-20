import { useEffect, useRef, useState } from 'react'
import { useApp, useStdout } from 'ink'

// The alternate screen buffer (DECSET 1049), hand-rolled because ink 7 takes
// `alternateScreen` only as a render()-time option and this app has to hop
// buffers at runtime under ONE live ink instance: the default view lives in the
// primary buffer with its settled transcript flushed to real scrollback, and
// the full-frame screens (picker, composer, browser) take over the alt screen
// and hand the primary buffer back untouched on exit.
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

// Returns whether the app is ON the alt screen right now, trailing `active` by
// the hop: it flips only after the buffer switch has been written. Callers that
// print into the terminal's real scrollback (ink's <Static>) must wait for
// `false` before mounting — <Static> prints each row exactly once, so a row
// flushed while the alt screen still has the terminal is lost when it closes.
export function useAltScreen(active: boolean): boolean {
  const { suspendTerminal } = useApp()
  const { stdout } = useStdout()
  // Transitions are serialized: suspendTerminal throws if the terminal is
  // already suspended, and two fast toggles (ctrl+r then esc) would otherwise
  // overlap. Errors are swallowed — failing to hop buffers must not take the
  // session down.
  const queue = useRef<Promise<void>>(Promise.resolve())
  const hop = (write: string): Promise<void> => {
    if (!stdout?.isTTY) return Promise.resolve()
    queue.current = queue.current
      .then(() => suspendTerminal(() => void stdout.write(write)))
      .catch(() => {})
    return queue.current
  }
  // What the terminal is actually showing. `on` tracks the writes issued (so a
  // re-render never re-enters a buffer it is already in); `settled` follows the
  // completed hop and is what callers key rendering off.
  const on = useRef(false)
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (active === on.current) return
    on.current = active
    let alive = true
    void hop(active ? ENTER : LEAVE).then(() => {
      if (alive) setSettled(active)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, stdout, suspendTerminal])
  // The unmount path: quitting from inside an alt screen must give the primary
  // buffer back rather than leave the shell on the alt screen.
  useEffect(
    () => () => {
      if (on.current) void hop(LEAVE)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  return settled
}
