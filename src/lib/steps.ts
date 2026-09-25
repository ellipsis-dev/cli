import { claudePayload, lifecycleText, oneLine, recordToItems } from '@ellipsis-dev/sdk/store'
import { formatTs } from './output'
import type { SessionRecord } from './types'

// Record-rendering helpers for `session record` and the `--watch` log
// (commands/session.ts re-exports them for compatibility).

// A content block of a Claude Code stream event, typed loosely: the CLI only
// extracts display text and names, never interprets the payload.
interface StepContentBlock {
  type?: string
  text?: string
  thinking?: string
  name?: string
  input?: unknown
  content?: unknown
}

// Display reads a derived Claude view; the stored native payload stays intact.
function fields(record: SessionRecord): Record<string, unknown> {
  return (claudePayload(record) ?? record.payload) as Record<string, unknown>
}

// One session_record as a single display line: feed position, timestamp,
// record type, and the first ~120 characters of its text content. Exported
// for tests.
export function formatStepLine(record: SessionRecord): string {
  const raw = fields(record).subtype
  const subtype = typeof raw === 'string' ? raw : null
  const type = subtype ? `${record.record_type}/${subtype}` : record.record_type
  return [
    String(record.feed_seq).padStart(4),
    formatTs(record.created_at),
    type.padEnd(16),
    oneLine(recordText(record), 120),
  ].join('  ')
}

// Best-effort display text for a stored record. A platform record shows its
// notification line (a record type the SDK has no copy for, including types
// the platform no longer emits, shows its bare type); a claude_code record's
// `payload` is the raw agent stream event — a result step carries `result`,
// assistant/user steps carry `content`, a string or a list of blocks (text,
// thinking, tool_use, tool_result). Anything unrecognized falls back to its
// JSON.
export function recordText(record: SessionRecord): string {
  const data = fields(record)
  if (record.kind === 'platform') {
    return lifecycleText(record.record_type, data) ?? record.record_type
  }
  if (record.kind === 'codex' || record.kind === 'codex_app_server') {
    const items = recordToItems(record, record.id)
    if (items.length) {
      return items
        .map((item) => [item.text, item.detail].filter(Boolean).join(' '))
        .join(' ')
    }
  }
  if (typeof data.result === 'string') return data.result
  const text = contentText(data.content)
  if (text) return text
  return JSON.stringify(data)
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as StepContentBlock[]) {
    if (typeof block.text === 'string' && block.text) parts.push(block.text)
    else if (typeof block.thinking === 'string' && block.thinking) parts.push(block.thinking)
    else if (block.type === 'tool_use') {
      parts.push(`[tool: ${block.name ?? '?'}] ${JSON.stringify(block.input ?? {})}`)
    } else if (block.type === 'tool_result') {
      const inner = contentText(block.content)
      parts.push(inner || JSON.stringify(block.content ?? ''))
    }
  }
  return parts.join(' ')
}
