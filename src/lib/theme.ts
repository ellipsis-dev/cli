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
// accent in dark mode is BONE, not brand blue. Brand ink #175173 scores 1.79:1
// on a dark surface — unreadable as terminal text. So emphasis is carried by
// brightness (bone against stone), not by hue. The ▶ cursor is the one
// exception, and takes `cursor` below.
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

export const theme = {
  // Type. `foreground` is body copy and doubles as the accent (see above);
  // `muted` is every secondary string (meta, hints, timestamps) — and, since
  // the rule above rules out a bare `dimColor`, it is also how a quiet line
  // reads quiet. 7.4:1 on the brand charcoal, so quiet still means legible.
  foreground: '#f0efe9',
  muted: '#a8a59c',

  // The ▶ cursor, and nothing else — which, with no highlight bar to fall back
  // on, is now the ONLY thing that says "you are here". Bone-on-stone was too
  // quiet a step to find at a glance, so the cursor carries HUE as well as
  // brightness: cyan is the one hue not already spoken for (green = done, amber
  // = working, red = failed), so it never reads as a status.
  cursor: '#5fd3e0',

  // Status.
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

// The composer's fill — the app's ONE painted surface (see the note above for why
// it is the only one that can be). The brand panel step, neutralized: chalk sends
// any hex whose channels differ to the 6x6x6 colour cube, whose darkest step
// above black is rgb(95,95,95), so the authored warm #262523 paints as a MID GREY
// slab on a terminal that does 256 colours but not truecolor (Terminal.app, tmux
// without RGB, mosh, conhost). Equal channels route to the greyscale ramp
// instead, where a near-black stays near-black. Truecolor terminals lose only the
// warmth, which is invisible at this brightness.
export const inputSurface = chalk.level >= 3 ? '#262523' : '#252525'
