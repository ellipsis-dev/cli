import {
  BRANCH_GLYPH,
  clampLines,
  gutterFor,
  isToolActivity,
  isToolFold,
  LIVE_GLYPH,
  USER_BAR,
  type ItemKind,
  type TranscriptItem,
} from '@ellipsis-dev/sdk/store'

// The layout itself — which line wears which mark, what nests under what —
// is the SDK's (@ellipsis-dev/sdk/store layout.ts), shared with the
// dashboard's chat so the two can only disagree in colour and typography.
// Re-exported here for the callers that grew up importing them from this file.
export {
  BRANCH_GLYPH,
  gutterFor,
  isToolActivity,
  layOutItems,
  LIVE_GLYPH,
  USER_BAR,
  type PlacedItem,
} from '@ellipsis-dev/sdk/store'
import { fitLines, hasMarkdown, renderMarkdown, visibleWidth } from '../lib/markdown'
import { theme } from '../lib/theme'

// The transcript as a flat list of SCREEN ROWS. Everything on screen (the
// startup block, messages, tool chatter, in-flight sends, the live activity
// lines) is flattened to rows before it renders, each row exactly one terminal
// line tall and no wider than the pane.
//
// Rows, not entries, because the live frame is capped in ROWS: an entry-granular
// cap could only keep or drop a whole message, so one long message would either
// overflow the frame or vanish from it.
//
// Rows are also EXACT: text is pre-wrapped here at the width it will occupy
// (fitLines) and the renderer truncates instead of wrapping, so a slice of N rows
// always paints N lines. That is what lets the live frame be budgeted precisely —
// an over-tall frame scrolls ink's render region and smears stale rows.

// The 2-column gutter a transcript line reserves for its sender glyph (▶/●/⎿),
// so a wrapped line's continuation aligns under its first.
export const GUTTER_COLS = 2

// Horizontal pad on EVERY transcript row — the text sits one cell off the
// pane's edge, like the composer's interior, so your messages and the agent's
// share one left edge instead of stepping in and out by a column.
export const MESSAGE_PAD = 1

// Long bodies collapse to this many lines. Nothing un-collapses them: the full
// text printed into the terminal's scrollback on its way past, which is where it
// is read.
const COLLAPSE_LINES = 6

// A run of same-styled text inside a row. Rows carry spans rather than one
// string because a single line mixes styles: a green ✓ before dim prose, a
// bold tool name before its dim "(3 files)" detail.
export type RowSpan = {
  text: string
  color?: string
  dim?: boolean
  bold?: boolean
  // This span is a LIVE mark: it pulses while the work it describes is in
  // flight (see TranscriptRow.pulse and LIVE_GLYPH).
  pulse?: boolean
}

// The colour a span actually paints in. Every span resolves to a brand hex —
// there is no "unstyled" span and no `dimColor` — because neither of the two
// things a bare span would fall back on belongs to us:
//
//   * NO COLOUR MEANS THE TERMINAL'S COLOUR, which is a colour we do not know:
//     most spans carry none of their own (the assistant's prose included, via
//     styleFor), so leaving them bare hands the bulk of the transcript to
//     whatever the user's theme happens to be. See theme.ts.
//   * DIM IS OPTIONAL, as far as terminals are concerned: \x1b[2m is dropped
//     outright by a fair number of them once a 24-bit foreground is also set.
//     That is the same reason a pulsing mark SWAPS its colour on the off beat
//     instead of dimming — bone → grey is a real colour change, so it reads
//     everywhere. `dim` resolving to `muted` applies that everywhere else.
export function spanColor(
  span: Pick<RowSpan, 'color' | 'dim' | 'pulse'>,
  pulseOn: boolean,
): string {
  if (span.pulse && !pulseOn) return theme.muted
  if (span.color) return span.color
  return span.dim ? theme.muted : theme.foreground
}

export type TranscriptRow = {
  // Unique per row, for React keys.
  id: string
  // The entry (a transcript item's key, or 'sandbox') this row belongs to: the
  // unit the scrollback flush is decided by, so an entry is printed once, whole.
  entryKey: string
  // The gutter glyph, set on an entry's FIRST row only — a multi-row item
  // shows one sender icon, and its continuation rows align under it.
  gutter?: RowSpan
  // Blank columns before the gutter: a nested tool line sits one level in, so it
  // reads as a branch off the message above.
  indent?: number
  // Extra blank columns BETWEEN the gutter and the text. Set on every row of a
  // ⎿ item, continuation rows included, so the whole body stays aligned — see
  // BRANCH_TEXT_PAD.
  textPad?: number
  spans: RowSpan[]
  // Right-aligned metadata (a ticking duration, a pipeline state). The row's
  // spans are fitted to the columns left over.
  right?: RowSpan
  // A blank separator row: the gap between blocks.
  spacer?: boolean
  // The "+N lines" count on the marker row under a clamped body.
  clampedLines?: number
  // A ticking duration, appended to the row's text at render time. Kept out of
  // the row's spans so the once-a-second tick repaints one line instead of
  // rebuilding (and re-wrapping) the entire transcript.
  tick?: 'elapsed' | 'tool'
  // This row contains a pulsing mark (its gutter, or one of its spans). Like
  // `tick`, the phase is resolved at RENDER time — the row only records that it
  // has one — so the blink repaints a glyph instead of rebuilding the
  // transcript's rows, and rows without one are memoized past it entirely.
  pulse?: boolean
}

// Extra columns between a ⎿ and its text. The glyph's ink runs right up to its
// cell's edge, so the one space every other mark gets is not enough — the body
// reads as touching the branch. Applied to every row of the item, so a wrapped
// result and its "+N lines" marker stay aligned under the first line.
export const BRANCH_TEXT_PAD = 1

// Columns a nested line shifts right, so its branch glyph sits under the
// parent's text rather than under the parent's own mark.
export const NEST_INDENT = 2

// Printable columns a row's text may occupy in a pane `cols` wide.
export function contentWidth(
  cols: number,
  opts: { indent?: number; textPad?: number } = {},
): number {
  const taken = MESSAGE_PAD * 2 + GUTTER_COLS + (opts.indent ?? 0) + (opts.textPad ?? 0)
  return Math.max(8, cols - taken)
}

export function spacerRow(entryKey: string, id: string): TranscriptRow {
  return { id, entryKey, spans: [], spacer: true }
}

// One transcript item as its screen rows: the separator above it, its body
// pre-wrapped to the column it occupies, and the "+N lines" marker when a long
// body is clamped.
export function itemRows(
  item: TranscriptItem,
  cols: number,
  opts: { indent?: number; nested?: boolean; attach?: boolean } = {},
): TranscriptRow[] {
  const indent = opts.indent ?? 0
  // Nested lines are marked by their INDENT, so each keeps the glyph that says
  // what it is: ● the call, ⎿ the result that came back. A collapsed fold (key
  // grp:*, "Ran 2 tool calls") takes the branch glyph only when it hangs off a
  // message — a turn-opening run branches off nothing, so it wears ● like any
  // other line the agent owns. Either way not ✦: that mark is the
  // infrastructure speaking, which a fold is not.
  const isFold = isToolFold(item)
  const gutter = isFold ? (opts.nested ? BRANCH_GLYPH : '●') : gutterFor(item)
  const textPad = gutter === BRANCH_GLYPH ? BRANCH_TEXT_PAD : 0
  const width = contentWidth(cols, { indent, textPad })
  const shown = withRenderedMarkdown(item, width)
  const clamped = isCollapsible(shown)
    ? clampLines(shown.text, COLLAPSE_LINES)
    : { body: shown.text, more: 0 }
  const { gutterColor, textColor, dim, bold } = styleFor(shown)

  const rows: TranscriptRow[] = []
  // `attach` overrides the item's own spacing: a nested line sits directly
  // under its parent, with no blank row to detach it.
  if (item.spaceBefore && !opts.attach) rows.push(spacerRow(item.key, `${item.key}:sp`))
  let bodyRows = 0
  const push = (spans: RowSpan[], extra: Partial<TranscriptRow> = {}): void => {
    rows.push({
      id: `${item.key}:r${rows.length}`,
      entryKey: item.key,
      gutter:
        bodyRows++ === 0 || gutter === USER_BAR
          ? { text: gutter, color: gutterColor, dim: dim && !shown.isError }
          : undefined,
      indent,
      textPad,
      spans,
      ...extra,
    })
  }

  const lines = fitLines(clamped.body, width)
  for (const [i, line] of lines.entries()) {
    // The detail ("(3 files)") trails the body's last line when it fits, and
    // takes rows of its own when it doesn't.
    const detail = i === lines.length - 1 && shown.detail ? shown.detail : null
    if (detail && visibleWidth(line) + visibleWidth(detail) <= width) {
      push([{ text: line, color: textColor, dim, bold }, { text: detail, dim: true }])
    } else {
      push([{ text: line, color: textColor, dim, bold }])
      if (detail) for (const l of fitLines(detail, width)) push([{ text: l, dim: true }])
    }
  }
  if (clamped.more > 0) push([], { clampedLines: clamped.more })
  return rows
}

// A live status line — "Generating…", "Running Bash(pytest…)…" — with its
// ticking readout in the right-hand metadata column. `hug` drops the spacer
// above so the line reads as part of the tool burst it belongs to. The duration is a `tick` marker rather
// than text: it changes every second, and baking it in here would re-wrap the
// transcript once a second.
export function activityRows(
  key: string,
  label: string,
  tick: 'elapsed' | 'tool',
  suffix: string,
  cols: number,
  hug: boolean,
  // The line describes a TOOL CALL in flight, so it nests under the message
  // that made the call, exactly where its ⎿ result will land a moment later. A
  // "Generating…"/"Working…" line describes the message itself and stays flat.
  nested = false,
): TranscriptRow[] {
  const indent = nested ? NEST_INDENT : 0
  // Reserve the widest the readout gets ("1h 3m 30s, 12.3k tokens") so the
  // label doesn't reflow as the clock ticks.
  const width = Math.max(8, contentWidth(cols, { indent }) - visibleWidth(suffix) - 16)
  const rows: TranscriptRow[] = hug || nested ? [] : [spacerRow(key, `${key}:sp`)]
  rows.push({
    id: `${key}:r`,
    entryKey: key,
    gutter: { text: LIVE_GLYPH, color: theme.foreground, pulse: true },
    indent,
    spans: [{ text: fitLines(label, width)[0] ?? '', dim: true }],
    right: { text: suffix, dim: true },
    tick,
    pulse: true,
  })
  return rows
}

// An in-flight send, or the streaming assistant response: laid out exactly like
// the committed record it becomes, so nothing shifts when that record lands.
// `pulse` marks the send as still in flight — the same breathing ⏺ a running
// tool wears, so a message the agent hasn't answered yet never reads as settled
// conversation.
export function pendingMessageRows(
  key: string,
  text: string,
  cols: number,
  opts: {
    gutter: string
    gutterColor?: string
    dim?: boolean
    bold?: boolean
    right?: string
    pulse?: boolean
  },
): TranscriptRow[] {
  const width = contentWidth(cols)
  const rows: TranscriptRow[] = [spacerRow(key, `${key}:sp`)]
  const lines = fitLines(text, width)
  for (const [i, line] of lines.entries()) {
    rows.push({
      id: `${key}:r${i}`,
      entryKey: key,
      gutter:
        (i === 0 || opts.gutter === USER_BAR) && opts.gutter
          ? {
              text: opts.gutter,
              color: opts.gutterColor ?? theme.foreground,
              dim: opts.dim,
              pulse: opts.pulse,
            }
          : undefined,
      spans: [{ text: line, dim: opts.dim, bold: opts.bold }],
      right: i === lines.length - 1 && opts.right ? { text: opts.right, dim: true } : undefined,
      pulse: i === 0 ? opts.pulse : undefined,
    })
  }
  return rows
}

// ---------------------------------------------------------------- scrollback
//
// The settled part of the transcript is printed ONCE, into the terminal's own
// scrollback, and never repainted (ink's <Static>). That buys native
// wheel/trackpad scrolling and native select/copy, and it costs mutability: a
// row that has been flushed can't re-wrap or re-fold. So the flush point has to
// be a row that CANNOT change again, and these two helpers are what decide it.

// The items whose rows are final. An item's rows can still change while a turn
// is in flight: a collapsed fold ("Ran 2 tool calls") grows as more tool activity
// lands under the same message. So the LAST message and everything after it stay
// live, and everything before it is final. With no turn in flight nothing can
// grow, so all of it is final.
//
// Note this is per-MESSAGE, not per-turn: the moment the agent starts a new
// message the previous one and its whole tool run flush together, which is what
// keeps the live frame about one message tall during a long turn. Pure, for
// tests.
export function settledItemKeys(
  items: readonly TranscriptItem[],
  turnLive: boolean,
): Set<string> {
  if (!turnLive) return new Set(items.map((i) => i.key))
  let lastSpeech = -1
  for (const [i, item] of items.entries()) if (!isToolActivity(item)) lastSpeech = i
  // A transcript that is nothing but an open tool run has no settled prefix.
  if (lastSpeech < 0) return new Set()
  return new Set(items.slice(0, lastSpeech).map((i) => i.key))
}

// How many rows off the FRONT of the list are final — the count handed to
// <Static>. A prefix, deliberately: rows are flushed in screen order, so the
// first row that can still change stops the scan even if later rows are
// settled. Pure, for tests.
export function settledRowCount(
  rows: readonly TranscriptRow[],
  settledKeys: ReadonlySet<string>,
): number {
  let n = 0
  for (const row of rows) {
    if (!settledKeys.has(row.entryKey)) break
    n++
  }
  return n
}

// Agent and user prose rendered as markdown (bold, headings, bullets, tables,
// fenced code), pre-wrapped to the column it will occupy. Only these two kinds
// go through it: tool lines and system notices are the SDK's own formatting,
// where a stray asterisk or pipe is literal text. Items without markdown come
// back untouched, so the common case allocates nothing. Pure, for tests.
export function withRenderedMarkdown(item: TranscriptItem, width: number): TranscriptItem {
  if (item.kind !== 'assistant' && item.kind !== 'user') return item
  if (!hasMarkdown(item.text)) return item
  const rendered = renderMarkdown(item.text, width)
  return rendered === item.text ? item : { ...item, text: rendered }
}

// Which items collapse when long: tool results and user turns (the latter carry
// the re-injected run context, which is bulky). Assistant prose stays full.
function isCollapsible(item: TranscriptItem): boolean {
  return (
    (item.kind === 'tool_result' || item.kind === 'user') &&
    item.text.split('\n').length > COLLAPSE_LINES
  )
}

// Colour + weight for each transcript item kind, matched loosely to Claude Code.
function styleFor(item: TranscriptItem): {
  gutterColor?: string
  textColor?: string
  dim: boolean
  bold: boolean
} {
  const kind: ItemKind = item.kind
  switch (kind) {
    case 'tool':
      return { gutterColor: theme.success, bold: true, dim: false }
    case 'tool_result':
      return {
        textColor: item.isError ? theme.error : undefined,
        dim: !item.isError,
        bold: false,
      }
    // User copy stays white like the assistant's — only the bar takes the cyan,
    // matching the composer's own left edge.
    case 'user':
      return { gutterColor: theme.cursor, bold: true, dim: false }
    case 'error':
      return { gutterColor: theme.error, textColor: theme.error, dim: false, bold: false }
    case 'summary':
      return {
        textColor: item.isError ? theme.error : undefined,
        dim: true,
        bold: false,
      }
    case 'thinking':
    case 'system':
    case 'notice':
      return { dim: true, bold: false }
    case 'assistant':
    default:
      return { dim: false, bold: false }
  }
}
