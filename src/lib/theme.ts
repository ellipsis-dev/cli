import chalk from 'chalk'

// The Ellipsis brand palette — the CLI's one source of color.
//
// These hexes are COPIES of brand/tokens.json in the ellipsis monorepo (the
// canonical source). This repo can't reach that file, so when a brand color
// changes there, it has to be re-copied here by hand.
//
// The CLI carries BOTH brand modes and picks one at startup by asking the
// terminal for its background (OSC 11, then COLORFGBG, then dark — see
// lib/terminalBackground.ts). Dark is the default because it is the brand's
// main mode and the safe guess when the terminal won't say.
//
// TEXT emphasis is carried by brightness, not by hue: brand ink #175173 scores
// 1.79:1 on a dark surface, so no copy is ever set in it — dark emphasis is bone
// against stone. The one thing that IS brand ink in both modes is `cursor`, and
// only because nothing it paints is read as text: a ▶, a left edge, a bar. Those
// are shapes you locate, not words, and a located shape survives a contrast a
// sentence would not.
//
// EXACTLY ONE SURFACE IS PAINTED: the composer's (`inputSurface` below). The CLI
// used to paint a canvas behind everything and lift panels onto it, which worked
// while the app owned every cell of a fixed frame. It no longer does — the
// transcript is printed into the terminal's own scrollback, where a row is never
// repainted, so a fill there outlives the frame that drew it and stale bands
// survive a resize or a shorter frame with nothing able to clean them up.
//
// The composer is the exception because it is the one region that is ALWAYS
// repainted and NEVER flushed: it lives in the live frame for the whole session,
// so its fill is redrawn on every frame and disappears with the app. Transcript
// rows, the header, and list highlights are all either printed or sized around
// printed rows, so they carry no fill.
//
// One rule survives from the canvas days, and it still matters: every glyph takes
// a colour from this file. Ink leaves a `<Text>` with no `color` prop on the
// terminal's DEFAULT foreground, so a hardcoded assumption either way breaks one
// theme; `dimColor` on its own is that bug plus an \x1b[2m, so secondary copy
// takes `muted`, never a bare `dimColor`. (dim is fine ON TOP of an explicit
// colour, where it only shades a known hue.)

export interface Palette {
  // Type. `foreground` is body copy and doubles as the accent; `muted` is
  // every secondary string (meta, hints, timestamps) — and, since the rule
  // above rules out a bare `dimColor`, it is also how a quiet line reads
  // quiet, while staying legible on its canvas.
  foreground: string
  muted: string

  // The ▶ cursor, the composer's left edge, and the bar down your own messages —
  // which, with no highlight bar to fall back on, is the ONLY thing that says
  // "you are here". Brand ink in both modes: it is the accent the web apps use
  // for exactly this (interactive, never status), and it is a hue no status owns
  // (green = done, amber = working, red = failed).
  cursor: string

  // Status.
  success: string
  error: string
  // In-flight. brand/tokens.json has no dedicated "working" color; this is
  // syntaxLiteral, the warm amber, which is the only brand hue that reads as
  // activity without colliding with success green or error red.
  active: string

  // Syntax, for rendered markdown in a transcript. Same values the web apps
  // use for code blocks, so a snippet reads the same in the CLI as in the docs.
  syntaxLiteral: string
  syntaxString: string
}

// brand/tokens.json `dark` values. muted is 7.4:1 on the brand charcoal.
export const darkPalette: Palette = {
  foreground: '#f0efe9',
  muted: '#a8a59c',
  cursor: '#175173',
  success: '#4ebc7b',
  error: '#e5544b',
  active: '#d9bd8d',
  syntaxLiteral: '#d9bd8d',
  syntaxString: '#c8c6bc',
}

// brand/tokens.json `light` values. active mirrors dark by borrowing
// syntaxLiteral.
export const lightPalette: Palette = {
  foreground: '#1c1b17',
  muted: '#706f66',
  cursor: '#175173',
  success: '#10b981',
  error: '#dc2626',
  active: '#8a6d2a',
  syntaxLiteral: '#8a6d2a',
  syntaxString: '#56544b',
}

// The live palette. MUTATED IN PLACE by applyThemeMode so every existing
// `theme.foreground` call site follows the mode with no plumbing; the mode is
// set once at startup, before the first render, and never after.
export const theme: Palette = { ...darkPalette }

// The composer's fill — the app's ONE painted surface (see the note above for
// why it is the only one that can be). The brand panel step, neutralized: chalk
// sends any hex whose channels differ to the 6x6x6 colour cube, whose darkest
// step above black is rgb(95,95,95), so the authored warm dark #262523 paints
// as a MID GREY slab on a terminal that does 256 colours but not truecolor
// (Terminal.app, tmux without RGB, mosh, conhost). Equal channels route to the
// greyscale ramp instead, where a near-black stays near-black — and, in light
// mode, a near-white sand (brand border #e3e1d8) stays near-white. Truecolor
// terminals lose only the warmth, which is invisible at this brightness.
export let inputSurface = chalk.level >= 3 ? '#262523' : '#252525'

export type ThemeMode = 'light' | 'dark'

export function applyThemeMode(mode: ThemeMode): void {
  Object.assign(theme, mode === 'light' ? lightPalette : darkPalette)
  inputSurface =
    mode === 'light'
      ? chalk.level >= 3
        ? '#e3e1d8'
        : '#e4e4e4'
      : chalk.level >= 3
        ? '#262523'
        : '#252525'
}
