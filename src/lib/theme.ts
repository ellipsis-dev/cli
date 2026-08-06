import chalk from 'chalk'

// The Ellipsis brand palette, dark mode — the CLI's one source of color.
//
// These hexes are COPIES of brand/tokens.json in the ellipsis monorepo (the
// canonical source). This repo can't reach that file, so when a brand color
// changes there, it has to be re-copied here by hand.
//
// Dark mode is the brand's main mode, which is what a terminal is, so the CLI
// only ever renders the dark palette — there is no light variant to switch to.
//
// One rule carried over from the web app (landing globals.css `.dark`): the
// accent in dark mode is BONE, not brand blue. Brand ink #175173 scores
// 1.79:1 on the panel — unreadable as terminal text. So emphasis is carried by
// brightness (bone against stone), not by hue. The ▶ cursor is the one
// exception, and takes `cursor` below.
//
// Because the CLI paints its own canvas, the palette only holds if it is used
// for EVERY cell of the frame. Two rules keep it whole on a terminal whose own
// theme is light:
//
//   1. Every glyph takes a color from this file. Ink leaves a `<Text>` with no
//      `color` prop on the terminal's DEFAULT foreground, which under a light
//      theme is near-black — the same near-black we just painted the canvas
//      with, so the text vanishes. `dimColor` on its own is that bug plus an
//      \x1b[2m: secondary copy takes `muted`, never a bare `dimColor`. (dim is
//      fine ON TOP of an explicit color, where it only shades a known hue.)
//   2. Surfaces reach ink already quantized for the terminal's color depth —
//      see `surfaceFor`, which is why the three surface entries below are
//      computed rather than literal.

// The surfaces as authored. Call sites never read these: they take the
// `theme.*` entries, which are these run through `surfaceFor`.
const BRAND_SURFACES = {
  canvas: '#1c1b1a',
  panel: '#262523',
  panelActive: '#343330',
} as const

// A surface hex ink can paint at `level` without losing the step between one
// surface and the next.
//
// chalk resolves a hex onto the 256-color palette two different ways: to the
// 24-rung GREYSCALE RAMP (indexes 232-255, ~10 units apart) when r, g and b
// are equal, and otherwise to the 6x6x6 COLOR CUBE, whose darkest step above
// black is rgb(95,95,95). The brand surfaces are WARM greys — their channels
// differ by a point or two — so on a terminal that does 256 colors but not
// truecolor (Terminal.app, tmux without RGB, mosh, plain conhost) all three
// land on cube index 59 simultaneously: the near-black canvas paints as a mid
// grey slab, and the panel and active steps disappear along with every "you
// are here" highlight that was carried by them.
//
// Averaging the channels is invisible at this brightness (a warm near-black
// and a neutral near-black are the same wall of dark) and puts each surface
// back on its own rung: 234, 235, 236. Truecolor terminals get the authored
// warmth untouched; a 16-color terminal renders both spellings as its palette
// black, so the substitution costs nothing there either.
export function surfaceFor(hex: string, level: number): string {
  if (level >= 3) return hex
  const value = hex.replace('#', '')
  const channels = [0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16))
  if (channels.some(Number.isNaN)) return hex
  const mean = Math.round((channels[0] + channels[1] + channels[2]) / 3)
  return `#${mean.toString(16).padStart(2, '0').repeat(3)}`
}

// `chalk.level` is read once, at import: ink colorizes through this very chalk
// instance (it is a hoisted single copy), so what it can render is what we
// quantize for.
const COLOR_LEVEL: number = chalk.level

export const theme = {
  // The app canvas and the lifted panel an input sits on. ~1.1:1 apart: barely
  // a lift, which is the point — a panel should separate, not stripe.
  canvas: surfaceFor(BRAND_SURFACES.canvas, COLOR_LEVEL),
  panel: surfaceFor(BRAND_SURFACES.panel, COLOR_LEVEL),
  // One step lighter than `panel`: the brand border hairline, doing duty as
  // the "you are here" surface (highlighted message, focused composer,
  // selected nav row). Selection is a brightness step between surfaces —
  // never the full inverse flash, which reads bone-white and far too loud.
  panelActive: surfaceFor(BRAND_SURFACES.panelActive, COLOR_LEVEL),

  // Type. `foreground` is body copy and doubles as the accent (see above);
  // `muted` is every secondary string (meta, hints, timestamps) — and, since
  // rule 1 above rules out a bare `dimColor`, it is also how a quiet line
  // reads quiet. 7.4:1 on the canvas, so quiet still means legible.
  foreground: '#f0efe9',
  muted: '#a8a59c',

  // The ▶ cursor, and nothing else. Bone-on-stone was too quiet a step to find
  // at a glance on a busy frame, so the cursor carries HUE as well as
  // brightness: cyan is the one hue not already spoken for (green = done,
  // amber = working, red = failed), so it never reads as a status. 9.7:1 on
  // the canvas and 7.2:1 on the active surface, so it holds up highlighted.
  cursor: '#5fd3e0',

  // Status. Tuned for the charcoal canvas, not the light one.
  success: '#4ebc7b',
  error: '#e5544b',
  // In-flight. brand/tokens.json has no dedicated "working" color; this is
  // syntaxLiteral, the warm amber, which is the only brand hue that reads as
  // activity without colliding with success green or error red.
  active: '#d9bd8d',

  // Syntax, for rendered markdown in a transcript. Same values the web apps
  // use for code blocks, so a snippet reads the same in the CLI as in the docs.
  syntaxLiteral: '#d9bd8d',
  syntaxString: '#c8c6bc',
}

// The elevated surface an input area sits on. Named separately from
// `theme.panel` because call sites mean "this is an input", not "this is
// #262523" — the composers in ConnectApp/SessionsApp both use it.
export const SURFACE_ELEVATED = theme.panel

// The elevated surface, active: the focused composer, the highlighted
// transcript message, the selected nav row. One brightness step above
// SURFACE_ELEVATED — enough to read "you are here" without the inverse flash.
export const SURFACE_ACTIVE = theme.panelActive
