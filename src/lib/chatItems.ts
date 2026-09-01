import {
  chatTurnsToItems as sdkChatTurnsToItems,
  recordToItems,
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
