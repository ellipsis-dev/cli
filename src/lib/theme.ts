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
// 1.79:1 on the panel — unreadable as terminal text. So "you are here" is
// carried by brightness (bone against stone), not by hue.

export const theme = {
  // The app canvas and the lifted panel an input sits on. ~1.1:1 apart: barely
  // a lift, which is the point — a panel should separate, not stripe.
  canvas: '#1c1b1a',
  panel: '#262523',
  // One step lighter than `panel`: the brand border hairline, doing duty as
  // the "you are here" surface (highlighted message, focused composer,
  // selected nav row). Selection is a brightness step between surfaces —
  // never the full inverse flash, which reads bone-white and far too loud.
  panelActive: '#343330',

  // Type. `foreground` is body copy and doubles as the accent (see above);
  // `muted` is every secondary string (meta, hints, timestamps).
  foreground: '#f0efe9',
  muted: '#a8a59c',

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
} as const

// The elevated surface an input area sits on. Named separately from
// `theme.panel` because call sites mean "this is an input", not "this is
// #262523" — the composers in ConnectApp/SessionsApp both use it.
export const SURFACE_ELEVATED = theme.panel

// The elevated surface, active: the focused composer, the highlighted
// transcript message, the selected nav row. One brightness step above
// SURFACE_ELEVATED — enough to read "you are here" without the inverse flash.
export const SURFACE_ACTIVE = theme.panelActive
