import {
  recordToItems,
  type ChatTurn,
  type TranscriptItem,
} from '@ellipsis-dev/sdk/store'
import type { SessionRecord } from './types'
import { sessionLogText } from './steps'

// The chat's transcript items, derived from the SDK's shared ChatTurn shape —
// the SAME grouped turns the dashboard's chat renders (store.chatTurns()):
// tool calls paired with their results, turns closed by their result records,
// a failed turn carrying isError. This file maps those turns onto the
// terminal renderer's TranscriptItem vocabulary; everything downstream
// (folds, layout, rows, the scrollback flush) is unchanged.

// The sandbox spawn family: the startup block up top narrates these, so the
// chat skips their turns entirely. Logging them here would bury the
// conversation in provisioning noise.
const SANDBOX_RECORD_TYPES = new Set([
  'sandbox_starting',
  'sandbox_phase',
  'sandbox_output',
  'sandbox_ready',
])

// ChatTurns as flat transcript items, in turn order.
//
// Lifecycle turns are reworded through sessionLogText (the SHORT list of
// milestones worth a chat line — asleep, waking, retrying, cancelled), so the
// chat log and the old item path read the same. A wake is ONE line, not two:
// "Waking the session…" settles in place to "Session awake" when the resumed
// record lands, KEEPING ITS KEY, so the scroll anchor and the scrollback
// flush never move.
//
// A turn's closing result record is not itself rendered (its duration and
// cost are bookkeeping; the footer carries the spend), but a failed turn is
// content: turn.isError becomes a red "turn ended with an error" line at the
// turn's end. Pure, for tests.
export function chatTurnsToItems(turns: readonly ChatTurn[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  // Index of the "Waking the session…" line still awaiting its outcome.
  let wakeAt = -1
  for (const turn of turns) {
    if (turn.role === 'lifecycle') {
      for (const node of turn.nodes) {
        if (node.kind !== 'lifecycle') continue
        if (SANDBOX_RECORD_TYPES.has(node.recordType)) continue
        if (node.recordType === 'session_resumed' && wakeAt >= 0) {
          items[wakeAt] = { ...items[wakeAt], text: 'Session awake' }
          wakeAt = -1
          continue
        }
        const text = sessionLogText(node.recordType, node.payload ?? {})
        if (!text) continue
        items.push({ key: node.key, kind: 'notice', text, spaceBefore: true })
        wakeAt = text === 'Waking the session…' ? items.length - 1 : -1
      }
      continue
    }
    if (turn.role === 'user') {
      for (const node of turn.nodes) {
        if (node.kind === 'user') {
          items.push({ key: node.key, kind: 'user', text: node.text, spaceBefore: true })
        }
      }
      continue
    }
    for (const node of turn.nodes) {
      if (node.kind === 'assistant') {
        items.push({ key: node.key, kind: 'assistant', text: node.text, spaceBefore: true })
      } else if (node.kind === 'thinking') {
        items.push({ key: node.key, kind: 'thinking', gutter: '✻', text: node.text, spaceBefore: true })
      } else if (node.kind === 'tool') {
        // An orphaned result (its call was never seen — replay can start
        // mid-burst) renders as the ⎿ result alone, not under a made-up call.
        const orphan = node.name === 'tool' && node.input === null && node.startedAt === null
        if (!orphan) {
          items.push({
            key: node.key,
            kind: 'tool',
            gutter: '●',
            text: node.name,
            detail: node.summary ? `(${node.summary})` : undefined,
            spaceBefore: true,
            tool: { name: node.name, input: node.input ?? undefined },
          })
        }
        // The result rides directly under its call — the pairing is the
        // point of the ChatTurn shape. A call still running has none, which
        // is what pendingToolCalls keys the live activity line off.
        if (node.result !== null) {
          items.push({
            key: `${node.key}:r`,
            kind: 'tool_result',
            gutter: '⎿',
            text: node.result || '(no output)',
            spaceBefore: false,
            isError: node.isError || undefined,
          })
        }
      }
    }
    if (turn.isError) {
      items.push({
        key: `${turn.key}:err`,
        kind: 'summary',
        text: 'turn ended with an error',
        spaceBefore: true,
        isError: true,
      })
    }
  }
  return items
}

// Agent records that arrived and would render NOTHING — the signal for a
// payload shape this build cannot read (a harness change on the server, an
// out-of-date CLI). Without it such a record is invisible twice over: no row,
// and no hint that a row is missing. Init events are excluded: they are
// deliberately silent. A record the reader THROWS on must cost one count, not
// the whole transcript. Pure, for tests.
export function undisplayedRecordCount(
  records: readonly SessionRecord[],
  minRenderFeedSeq: number,
): number {
  let undisplayed = 0
  for (const r of records) {
    if (r.feed_seq <= minRenderFeedSeq || r.source === 'lifecycle') continue
    let rendered: TranscriptItem[]
    try {
      rendered = recordToItems(r, `s${r.feed_seq}`) ?? []
    } catch {
      rendered = []
    }
    if (rendered.length === 0 && r.record_type !== 'system') undisplayed++
  }
  return undisplayed
}
