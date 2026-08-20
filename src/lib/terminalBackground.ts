import { applyThemeMode, type ThemeMode } from './theme'

// Which palette to render: ask the terminal what its background is, the same
// way Claude Code's "auto" theme does. Order of trust:
//
//   1. OSC 11 — the terminal reports its actual background color. Supported
//      by every mainstream emulator (iTerm2, Terminal.app, kitty, WezTerm,
//      Ghostty, Windows Terminal, VS Code); tmux passes it through.
//   2. COLORFGBG — a legacy env hint ("15;0" = light-on-dark) set by rxvt and
//      a few others. Stale after a mid-session theme change, but better than
//      guessing.
//   3. dark — the brand's main mode and the safe default when nothing answers.
//
// Called once at each UI entry point, BEFORE the first Ink render, so no frame
// ever paints in the wrong palette and nothing needs to re-render on the
// answer.

// OSC 11 reply: `\x1b]11;rgb:RRRR/GGGG/BBBB` terminated by BEL or ST, where
// each channel is 1-4 hex digits scaled to 16 bits.
const OSC_REPLY = /\x1b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i

function channelToUnit(hex: string): number {
  return parseInt(hex, 16) / (16 ** hex.length - 1)
}

export function modeFromOscReply(reply: string): ThemeMode | null {
  const m = OSC_REPLY.exec(reply)
  if (!m) return null
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map(channelToUnit) as [number, number, number]
  // Perceived luminance (Rec. 601). The cut is the midpoint: a background
  // brighter than half is a light theme.
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.5 ? 'light' : 'dark'
}

// COLORFGBG is "fg;bg" or "fg;default;bg"; the LAST field is the background's
// ANSI-16 index. 7 and 15 are the whites; everything else is dark or unknown.
export function modeFromColorFgBg(value: string | undefined): ThemeMode | null {
  const bg = value?.trim().split(';').pop()
  if (!bg || !/^\d+$/.test(bg)) return null
  return bg === '7' || bg === '15' ? 'light' : 'dark'
}

function queryOsc11(timeoutMs = 200): Promise<ThemeMode | null> {
  return new Promise((resolve) => {
    const { stdin, stdout } = process
    if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
      resolve(null)
      return
    }
    const wasRaw = stdin.isRaw
    let buffer = ''
    let settled = false
    const finish = (mode: ThemeMode | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stdin.off('data', onData)
      stdin.setRawMode(wasRaw)
      // Ink attaches its own stdin handling after this; leave the stream
      // paused so a bare detection doesn't hold the process open.
      stdin.pause()
      resolve(mode)
    }
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('latin1')
      const mode = modeFromOscReply(buffer)
      if (mode) finish(mode)
      else if (buffer.length > 64) finish(null)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
    stdout.write('\x1b]11;?\x1b\\')
  })
}

// Detect and apply, once, at a UI entry point. Never throws — a terminal that
// answers strangely just keeps the dark default.
export async function applyDetectedThemeMode(): Promise<ThemeMode> {
  let mode: ThemeMode | null = null
  try {
    mode = await queryOsc11()
  } catch {
    mode = null
  }
  mode ??= modeFromColorFgBg(process.env.COLORFGBG)
  mode ??= 'dark'
  applyThemeMode(mode)
  return mode
}
