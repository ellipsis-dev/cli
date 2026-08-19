import { clampLines, type ItemKind, type TranscriptItem } from '@ellipsis-dev/sdk/store'
import { fitLines, hasMarkdown, renderMarkdown, visibleWidth } from '../lib/markdown'
import { theme } from '../lib/theme'

// The transcript as a flat list of SCREEN ROWS — the unit the chat window
// scrolls by. Everything in the window (the startup block, messages, tool
// chatter, in-flight sends, the live activity lines) is flattened to rows
// before it renders, each row exactly one terminal line tall and no wider
// than the pane.
//
// Rows, not entries, because a message can be taller than the window: an
// entry-granular viewport can only show an entry whole or not at all, so a
// long message becomes unreadable — it fills the frame, and one scroll notch
// throws all of it away. Row-granular, the window can sit anywhere inside it.
//
// Rows are also EXACT, which is what lets the window pack itself full: text is
// pre-wrapped here at the width it will occupy (fitLines) and the renderer
// truncates instead of wrapping, so a slice of N rows always paints N lines.
// An estimate-based budget has to leave slack for its own rounding errors, and
// that slack shows up as dead space and phantom "… 1 newer" markers.

// The 2-column gutter a transcript line reserves for its sender glyph (◆/●/⎿),
// so the selection marker can replace the glyph in place without the text
// shifting, and a wrapped line's continuation aligns under its first.
export const GUTTER_COLS = 2

// Horizontal pad on EVERY transcript row — the text sits one cell off the
// pane's edge, like the composer's interior. Universal, not panel-only: a
// panelled row is one the pad happens to be tinted on, so your messages and
// the agent's share one left edge instead of stepping in and out by a column.
// The VERTICAL pad is a blank tinted row above and below each panel block,
// added in one place (padPanelBlocks) after the rows are assembled.
export const MESSAGE_PAD = 1

// Long bodies collapse to this many lines until ctrl+r (or → on the line)
// expands them.
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
//   * NO COLOUR MEANS THE TERMINAL'S COLOUR. Ink leaves an uncoloured `<Text>`
//     on the terminal's default foreground, which under a LIGHT theme is the
//     same near-black as the canvas we paint beneath it. Most spans carry no
//     colour of their own (the assistant's prose included, via styleFor), so
//     the bulk of a transcript came out dark on dark. See theme.ts, rule 1.
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
  // The entry (a transcript item's key, or 'sandbox') this row belongs to:
  // what the scroll anchor holds onto so streamed appends and re-wraps can't
  // slide the window.
  entryKey: string
  // The entry ↑/↓ selects when this row is highlighted, when that is not the
  // row's own entry: a tool call nested under a message is part of THAT
  // message's block, so the walk lands on the message and the call comes with
  // it. Absent means the row is its own nav stop.
  navKey?: string
  // For a row that IS a stop nested inside another (a tool call revealed under
  // an opened message): the stop ← steps out to.
  parentKey?: string
  // The gutter glyph, set on an entry's FIRST row only — a multi-row item
  // shows one sender icon, and its continuation rows align under it.
  gutter?: RowSpan
  // Blank columns before the gutter: an opened fold's children sit one level
  // in, so they read as the fold's children.
  indent?: number
  // Extra blank columns BETWEEN the gutter and the text. Set on every row of a
  // ⎿ item, continuation rows included, so the whole body stays aligned — see
  // BRANCH_TEXT_PAD.
  textPad?: number
  spans: RowSpan[]
  // Right-aligned metadata (a ticking duration, a pipeline state). The row's
  // spans are fitted to the columns left over.
  right?: RowSpan
  // Sits on a message panel: the elevated tint. Only a message YOU sent does.
  panel?: boolean
  // A blank separator row. Off-panel it is bare canvas, so the gap between
  // blocks reads as a gap. On a panel (panel + spacer) it is the block's
  // vertical pad, and carries the tint.
  spacer?: boolean
  // The "+N lines" marker under a clamped body. The key that opens it depends
  // on whether the line is highlighted (→) or not (ctrl+r), which the renderer
  // knows and the row builder deliberately doesn't — otherwise every arrow
  // keypress would rebuild the whole transcript.
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

// The mark on a live line — a tool call running, tokens streaming, a sandbox
// coming up. It pulses (see TranscriptRow.pulse), which is the app's one
// "something is happening right now" signal; a settled line takes ✓, ● or ✦
// instead. Filled, because a pulsing outline reads as flicker rather than a
// heartbeat.
export const LIVE_GLYPH = '⏺'

// The mark on a line nested under the message that produced it: a tool call
// the agent made while writing that message, and the result that came back.
// It reads as a branch off the prose above, which is what the nesting means.
export const BRANCH_GLYPH = '⎿'

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

// The entry ↑/↓ lands on for a row: the block it belongs to, which for a
// nested tool line is the message (or the call) it hangs off rather than its
// own entry.
export function navKeyOf(row: TranscriptRow): string {
  return row.navKey ?? row.entryKey
}

// One blank tinted row above and below every maximal run of consecutive panel
// rows — the vertical pad around a message YOU sent, matching the composer's
// interior pad. Applied to the ASSEMBLED list rather than inside itemRows so a
// run of consecutive sends reads as one padded block instead of each bringing
// its own pad. Pure, for tests.
export function padPanelBlocks(rows: readonly TranscriptRow[]): TranscriptRow[] {
  const out: TranscriptRow[] = []
  // A pad row inherits the edge row's BLOCK, not just its entry: a pad added
  // below a message's nested tool line belongs to that message, and leaving
  // navKey off would make the tool line a ↑/↓ stop of its own again.
  const pad = (edge: TranscriptRow, side: string): TranscriptRow => ({
    id: `${edge.id}:${side}`,
    entryKey: edge.entryKey,
    navKey: edge.navKey,
    spans: [],
    panel: true,
    spacer: true,
  })
  for (const row of rows) {
    const prev = out[out.length - 1]
    if (row.panel && !prev?.panel) out.push(pad(row, 'padT'))
    if (!row.panel && prev?.panel) out.push(pad(prev, 'padB'))
    out.push(row)
  }
  const last = out[out.length - 1]
  if (last?.panel) out.push(pad(last, 'padB'))
  return out
}

// One transcript item as its screen rows: the separator above it, its body
// pre-wrapped to the column it occupies, and the "+N lines" marker when a long
// body is clamped.
export function itemRows(
  item: TranscriptItem,
  cols: number,
  opts: { indent?: number; clamp: boolean; nested?: boolean; attach?: boolean },
): TranscriptRow[] {
  // Only what YOU said sits on the lifted, padded panel the composer uses.
  // Everything the agent says or does — prose, tool chatter, notices — stays
  // bare on the canvas, so the transcript reads as dense output with your turns
  // marked out of it.
  const panel = item.kind === 'user'
  const indent = opts.indent ?? 0
  // Nested lines are marked by their INDENT, so each keeps the glyph that says
  // what it is: ● the call, ⎿ the result that came back. Only a collapsed fold
  // (key grp:*, "Ran 2 tool calls") takes the branch glyph — as a notice it
  // would otherwise wear ✦, the mark for the infrastructure speaking, which is
  // not what a fold is. Keyed on the fold itself, not on `nested`: a
  // turn-opening run is flat, and it is still a fold.
  const gutter = item.key.startsWith('grp:') ? BRANCH_GLYPH : gutterFor(item)
  const textPad = gutter === BRANCH_GLYPH ? BRANCH_TEXT_PAD : 0
  const width = contentWidth(cols, { indent, textPad })
  const shown = withRenderedMarkdown(item, width)
  const clamped =
    opts.clamp && isCollapsible(shown)
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
        bodyRows++ === 0
          ? { text: gutter, color: gutterColor, dim: dim && !shown.isError }
          : undefined,
      indent,
      textPad,
      spans,
      panel,
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

// How each visible item is placed in the chat: nested under the message that
// produced it, or standing on its own.
//
// A tool call is not a turn in the conversation — it is something the agent did
// while writing the message above it. So a run of tool activity (the ● call,
// its ⎿ result, and any collapsed "Ran N …" fold standing in for them) is
// indented under the preceding assistant message and marked with the branch
// glyph, attached with no blank row between. Prose, user messages and notices
// keep their own gutter mark and their spacing.
//
// INDENT and OWNERSHIP are decided separately, because they answer different
// questions. A run belongs to (is opened by, travels with) whatever message
// came last, YOURS INCLUDED — the agent often opens a turn with a tool call,
// and a run that belonged to nothing could not be reached with →. But it only
// INDENTS under something the AGENT said (isAgentSpeech: prose or ✻ thinking):
// your message is a lifted box, and a ⎿ branch under it would read as work YOU
// did, so a turn-opening run stays flat and separated by its own blank row.
// Only a run at the very top of the transcript, with no message above it at
// all, belongs to nothing.
//
// Ownership is what ↑/↓ can LAND on, because a tool call is not a stop of its
// own — it belongs to the message that made it. Three levels, each opened by →
// on the level above:
//
//   ● the message            a stop; ↑/↓ walk these
//     ⎿ Ran 3 tool calls     part of the message's block (navKey → the message)
//
// opened with → the fold is REPLACED by what it stood for, at the same indent:
//
//   ● the message            a stop
//     ● Bash(pytest)         a stop of its own now
//     ⎿ output               part of that call's block (navKey → the call)
//
// So ↑ lands on the message with its tool chatter in tow; → swaps the fold for
// the calls and ↑/↓ then step through them one at a time; → on a call opens its
// output; ← walks back out (parentKey). Pure, for tests.
export type PlacedItem = {
  item: TranscriptItem
  indent: number
  nested: boolean
  attach: boolean
  // The block this line belongs to, when that is not the line itself. Absent
  // means the line is its own ↑/↓ stop.
  navKey?: string
  // The stop ← steps out to, for a line that IS a stop nested inside another.
  parentKey?: string
}
export function layOutItems(
  items: readonly TranscriptItem[],
  // `openedKeys` are the lines opened with →: an opened MESSAGE reveals its
  // calls as stops. `revealAll` is ctrl+r, which reveals every one of them.
  opts: { openedKeys?: ReadonlySet<string>; revealAll?: boolean } = {},
): PlacedItem[] {
  const out: PlacedItem[] = []
  // The message the current run BELONGS to — what → opens and ↑/↓ land on.
  // Either sender's; null only at the head of the transcript.
  let parent: string | null = null
  // Whether that message was the agent's, which is what decides the visual
  // nesting: only what the agent said gets a ⎿ branch under it.
  let parentIsAgent = false
  // The call a ⎿ result belongs to, so a result travels with its own call.
  let call: string | null = null
  for (const item of items) {
    if (!isToolActivity(item)) {
      out.push({ item, indent: 0, nested: false, attach: false })
      parent = item.key
      parentIsAgent = isAgentSpeech(item)
      call = null
      continue
    }
    const nested = parent !== null && parentIsAgent
    const revealed =
      opts.revealAll === true || (parent !== null && opts.openedKeys?.has(parent) === true)
    if (item.kind === 'tool') call = item.key
    // Who owns this line — the stop it travels with, or null when it IS one.
    // Collapsed, everything belongs to the message. Revealed, each ● call
    // becomes a stop and its ⎿ result travels with it. A fold ("Ran N …") is
    // never a stop either way: it stands in for the run, so it reads as part of
    // the message, and → on the message is what opens it.
    let owner = parent
    if (revealed && item.kind === 'tool') owner = null
    else if (revealed && item.kind === 'tool_result') owner = call
    out.push({
      item,
      indent: nested ? NEST_INDENT : 0,
      nested,
      // Attach every line of the run: the first to its parent message, the
      // rest to the line above.
      attach: nested,
      navKey: owner ?? undefined,
      // ← on a revealed call steps back out to the message it hangs off.
      parentKey: owner === null ? (parent ?? undefined) : undefined,
    })
  }
  return out
}

// Lines that represent work the agent did rather than something it said: a
// tool call, its result, and the collapsed fold that stands in for a run of
// them (keyed grp:*, kind 'notice').
export function isToolActivity(item: TranscriptItem): boolean {
  return item.kind === 'tool' || item.kind === 'tool_result' || item.key.startsWith('grp:')
}

// Whether a message is one the AGENT said, which is what a tool run may branch
// off with its ⎿. Its prose and its ✻ thinking both count — with extended
// thinking on, thinking is what most runs actually follow. Your own message
// does not: it is a lifted box, and a branch under it reads as work YOU did.
export function isAgentSpeech(item: TranscriptItem): boolean {
  return item.kind === 'assistant' || item.kind === 'thinking'
}

// A live status line — "Generating…", "Running Bash(pytest…)…" — with its
// ticking readout in the right-hand metadata column. It is the agent working, so
// it stays bare on the canvas. `hug` drops the spacer above so the line reads as
// part of the tool burst it belongs to. The duration is a `tick` marker rather
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
// the committed record it becomes, so nothing shifts when that record lands —
// which is why `panel` is the caller's call (your send is panelled, the
// streaming response is not). `pulse` marks the send as still in flight — the
// same breathing ⏺ a running tool wears, so a message the agent hasn't answered
// yet never reads as settled conversation.
export function pendingMessageRows(
  key: string,
  text: string,
  cols: number,
  opts: {
    gutter: string
    dim?: boolean
    bold?: boolean
    right?: string
    pulse?: boolean
    panel?: boolean
  },
): TranscriptRow[] {
  const panel = opts.panel ?? false
  const width = contentWidth(cols)
  const rows: TranscriptRow[] = [spacerRow(key, `${key}:sp`)]
  const lines = fitLines(text, width)
  for (const [i, line] of lines.entries()) {
    rows.push({
      id: `${key}:r${i}`,
      entryKey: key,
      gutter:
        i === 0 && opts.gutter
          ? { text: opts.gutter, color: theme.foreground, dim: opts.dim, pulse: opts.pulse }
          : undefined,
      spans: [{ text: line, dim: opts.dim, bold: opts.bold }],
      right: i === lines.length - 1 && opts.right ? { text: opts.right, dim: true } : undefined,
      panel,
      pulse: i === 0 ? opts.pulse : undefined,
    })
  }
  return rows
}

// The window of rows on screen, and how many are hidden beyond each edge.
//
// `anchor` is the index of the row pinned to the TOP, or null to follow the
// bottom (the default, so streamed content stays in view). The window is
// always packed FULL: anchored near the end of the list it backs up to fill
// the budget rather than leaving the bottom of the frame empty.
//
// The "… N earlier/newer" markers live inside the budget, so their rows come
// out of the window that needs them — resolved by re-fitting until it stops
// changing (there are at most two, so it settles at once).
//
// GUARANTEE: content rows plus marker rows never exceed `budget`, for any
// input. The whole layout rests on it — one row too many and ink's frame
// outgrows the pane, which scrolls the render region and smears stale rows up
// the terminal. A budget with no room to spare drops a marker rather than
// overflow, which is why showAbove/showBelow are separate from the hidden
// counts. Pure, for tests.
export function rowViewport(
  total: number,
  budget: number,
  anchor: number | null,
): {
  start: number
  end: number
  capacity: number
  hiddenAbove: number
  hiddenBelow: number
  showAbove: boolean
  showBelow: boolean
} {
  const room = Math.max(1, budget)
  if (total === 0) {
    return {
      start: 0,
      end: 0,
      capacity: room,
      hiddenAbove: 0,
      hiddenBelow: 0,
      showAbove: false,
      showBelow: false,
    }
  }
  // One content row always shows, so the markers can claim what the budget has
  // beyond it and no more.
  const markerRoom = Math.max(0, room - 1)
  let markers = 0
  let start = 0
  let end = 0
  let capacity = room
  for (let pass = 0; pass < 3; pass++) {
    capacity = room - markers
    if (anchor === null) {
      end = total
      start = Math.max(0, end - capacity)
    } else {
      start = Math.max(0, Math.min(anchor, total - 1))
      end = Math.min(total, start + capacity)
      // Packed full against the bottom edge: back up rather than leave the
      // last rows of the frame blank.
      if (end === total) start = Math.max(0, total - capacity)
    }
    const want = (start > 0 ? 1 : 0) + (end < total ? 1 : 0)
    const next = Math.min(want, markerRoom)
    if (next === markers) break
    markers = next
  }
  // With room for only one marker, "earlier" wins: that there is history above
  // is the more useful fact, and following the bottom is the common case.
  const showAbove = start > 0 && markers >= 1
  const showBelow = end < total && markers >= (start > 0 ? 2 : 1)
  return {
    start,
    end,
    capacity,
    hiddenAbove: start,
    hiddenBelow: total - end,
    showAbove,
    showBelow,
  }
}

// ---------------------------------------------------------------- scrollback
//
// In scrollback mode the settled part of the transcript is printed ONCE, into
// the terminal's own scrollback, and never repainted (ink's <Static>). That
// buys native wheel/trackpad scrolling and native select/copy, and it costs
// mutability: a row that has been flushed can't re-wrap, re-fold, or take a
// selection marker. So the flush point has to be a row that CANNOT change
// again, and these two helpers are what decide it.

// The items whose rows are final. An item's rows can still change for two
// reasons: a collapsed fold ("Ran 2 tool calls") grows as more tool activity
// lands under the same message, and the message that owns the open run is the
// one → can still unfold. So while a turn is in flight the LAST message and
// everything after it stay live, and everything before it is final. With no
// turn in flight nothing can grow, so all of it is final.
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

// The scroll position as (entry, row within that entry) rather than a flat row
// index, so appends, re-wraps and expansions can't slide the window: the row
// you parked on stays the row on screen.
export type ScrollAnchor = { entryKey: string; rowOffset: number }

// The flat row index an anchor points at, or null when its entry is gone (the
// caller falls back to following the bottom).
export function anchorIndex(rows: readonly TranscriptRow[], anchor: ScrollAnchor): number | null {
  const first = rows.findIndex((r) => r.entryKey === anchor.entryKey)
  if (first < 0) return null
  return Math.max(0, Math.min(first + anchor.rowOffset, rows.length - 1))
}

// The anchor for a flat row index.
export function anchorAt(rows: readonly TranscriptRow[], index: number): ScrollAnchor | null {
  const row = rows[index]
  if (!row) return null
  const first = rows.findIndex((r) => r.entryKey === row.entryKey)
  return { entryKey: row.entryKey, rowOffset: Math.max(0, index - first) }
}

// The row range a nav BLOCK occupies — the entry's own rows plus any nested
// under it (a message's tool calls travel with it, so the snap brings the whole
// block into frame) — skipping its leading spacer: that blank row is a
// separator, so bringing a block to the top of the window should land on its
// first line of content, not on the gap above it. Pure, for tests.
export function entryRange(
  rows: readonly TranscriptRow[],
  entryKey: string,
): { first: number; last: number } | null {
  let first = -1
  let last = -1
  for (const [i, row] of rows.entries()) {
    if (navKeyOf(row) !== entryKey) continue
    if (first < 0 && row.spacer) continue
    if (first < 0) first = i
    last = i
  }
  return first < 0 ? null : { first, last }
}

// Where the window must sit for `entryKey` to be readable, given where it sits
// now and which way the highlight is travelling (`dir`: 1 for ↓, -1 for ↑) —
// the ↑/↓ snap.
//
// An entry already fully in frame doesn't move the window at all. One that
// FITS but sits off-frame comes in from the side it is on: from above to the
// top of the window, from below to the bottom edge. One TOO TALL to fit lands
// on the edge you are heading towards, so the walk keeps its direction of
// travel: ↓ lands on its FIRST line (you read a long message from its
// beginning) and ↑ on its LAST (you back into the end of it). From there
// ↑/↓ scroll THROUGH the rest of it a row at a time — see revealMore — so the
// two together read the entry continuously in whichever direction you started.
//
// Returns the flat row index to pin to the top, or null to leave the window
// alone. Pure, for tests.
export function snapToEntry(
  rows: readonly TranscriptRow[],
  entryKey: string,
  view: { start: number; end: number },
  capacity: number,
  dir: 1 | -1 = 1,
): number | null {
  const range = entryRange(rows, entryKey)
  if (!range) return null
  // Already readable whole: don't jostle the window.
  if (range.first >= view.start && range.last < view.end) return null
  const bottomAligned = Math.max(0, range.last - capacity + 1)
  const height = range.last - range.first + 1
  if (height >= capacity) return dir < 0 ? bottomAligned : range.first
  return range.first < view.start ? range.first : bottomAligned
}

// snapToEntry's row index as the scroll move to apply: null to leave the window
// where it is, or the anchor to park on — itself null when the snap lands on the
// last screenful, which means following the bottom again so streamed content
// keeps arriving in view.
//
// That bottom-follow is keyed on WHERE THE SNAP LANDS, not on the entry being
// the newest one: an entry taller than the window is snapped to an interior row
// (its first line, when walking down into it), and pinning to the bottom there
// would throw the snap away and show the entry's end instead of its beginning.
// Pure, for tests.
export function snapAnchorForEntry(
  rows: readonly TranscriptRow[],
  entryKey: string,
  view: { start: number; end: number },
  capacity: number,
  dir: 1 | -1 = 1,
): { anchor: ScrollAnchor | null } | null {
  const target = snapToEntry(rows, entryKey, view, capacity, dir)
  if (target === null) return null
  if (target >= rows.length - capacity) return { anchor: null }
  return { anchor: anchorAt(rows, target) }
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
export function isCollapsible(item: TranscriptItem): boolean {
  return (
    (item.kind === 'tool_result' || item.kind === 'user') &&
    item.text.split('\n').length > COLLAPSE_LINES
  )
}

// The sender icon in the 2-column gutter: ◆ (cyan) marks a message you sent
// (the --prompt initial message included — it's a user message), ● marks the
// assistant's prose (default foreground; the tool-call ● is green + bold, so
// the two never read the same), ✦ (dim) marks system/notice lines — the
// infrastructure speaking. Everything else keeps the SDK's glyph (⎿ results,
// ✻ thinking) or none. The ▶ selection highlight replaces the icon in the
// same slot, so a selected line always reads differently from its resting
// state. Pure, for tests.
export function gutterFor(item: TranscriptItem): string {
  if (item.kind === 'user') return '◆'
  if (item.kind === 'assistant') return '●'
  if (item.kind === 'system' || item.kind === 'notice') return '✦'
  return item.gutter ?? ''
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
    // User copy stays white like the assistant's (the ◆ icon marks the
    // sender); cyan text always and only means "the selection is here".
    case 'user':
      return { gutterColor: theme.foreground, bold: true, dim: false }
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
