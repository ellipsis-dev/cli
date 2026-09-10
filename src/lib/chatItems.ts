import {
  chatTurnsToItems as sdkChatTurnsToItems,
  recordToItems,
  claudePayload,
  foldCosts,
  type ChatTurn,
  type TranscriptItem,
} from '@ellipsis-dev/sdk/store'
import type { SessionRecord } from './types'

// The chat's transcript items: the SDK's connect layout (chatTurnsToItems —
// the SAME items the dashboard's chat renders: tool calls paired with their
// results, the sandbox story dropped, a wake settling in place, a failed turn
// carrying isError), with the SDK's middot wording swapped for commas on the
// notice lines — the CLI writes plain sentences, the same convention
// src/lib/steps.ts applies to the other SDK derivations. Everything downstream
// (folds, layout, rows, the scrollback flush) is unchanged.
export function chatTurnsToItems(turns: readonly ChatTurn[]): TranscriptItem[] {
  return sdkChatTurnsToItems(turns).map((item) =>
    item.kind === 'notice' ? { ...item, text: item.text.replaceAll(' · ', ', ') } : item,
  )
}

// Native Claude events keep their original payloads; the SDK derives the
// legacy display view used by the last-turn cost footer.
export function foldRecordCosts(records: readonly SessionRecord[]) {
  return foldCosts(records.map(claudePayload).filter((payload) => payload !== null))
}

// Lifecycle and native bookkeeping records intentionally have no chat row.
// Unknown records still count, even when their producer or type looks familiar.
function isSilentRecord(record: SessionRecord): boolean {
  switch (record.kind) {
    case 'platform':
      return true
    case 'claude_sdk':
      return record.payload.kind === 'system' || record.payload.kind === 'rate_limit'
    case 'claude_code':
      return ['system', 'rate_limit_event', 'conversation_reset'].includes(
        record.payload.type,
      )
    case 'codex': {
      const event = record.payload
      return (
        [
          'thread.started',
          'turn.started',
          'turn.completed',
          'item.started',
          'item.updated',
        ].includes(event.type) ||
        (event.type === 'item.completed' && event.item.type === 'todo_list')
      )
    }
    case 'codex_app_server': {
      const event = record.payload
      if (event.method === 'turn/completed')
        return event.params.turn.status === 'completed'
      if (event.method === 'error') return event.params.willRetry
      if (event.method === 'item/completed')
        return event.params.item.type === 'userMessage'
      return true
    }
    default:
      return false
  }
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
    if (r.feed_seq <= minRenderFeedSeq || isSilentRecord(r)) continue
    let rendered: TranscriptItem[]
    try {
      rendered = recordToItems(r, `s${r.feed_seq}`) ?? []
    } catch {
      rendered = []
    }
    if (rendered.length === 0) undisplayed++
  }
  return undisplayed
}
