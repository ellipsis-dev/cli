import { useState } from 'react'
import { useApp, useInput } from 'ink'

// ctrl+c, everywhere in the UI: the first press interrupts (whatever the pane
// decides that means — the chat stops a running turn) and arms the quit, the
// second press exits, any other key disarms. Ink's own exitOnCtrlC is turned
// off at both render calls so this runs instead of an immediate teardown: a
// running agent should be interruptible without ending the session.
//
// Every pane that owns the keyboard mounts this, and only the pane with focus
// is active — so the armed flag is per-pane, and one press can't arm a handler
// that a later press won't reach. Returns whether the quit is armed, for the
// pane to prompt with.
export function useCtrlCQuit(active: boolean, onInterrupt?: () => void): boolean {
  const { exit } = useApp()
  const [armed, setArmed] = useState(false)
  useInput(
    (ch, key) => {
      if (key.ctrl && ch === 'c') {
        if (armed) exit()
        else {
          setArmed(true)
          onInterrupt?.()
        }
        return
      }
      if (armed) setArmed(false)
    },
    { isActive: active },
  )
  return active && armed
}

export const CTRL_C_QUIT_HINT = 'press ctrl+c again to exit'
