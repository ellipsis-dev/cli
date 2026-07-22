import { lifecycleText, oneLine } from '@ellipsis-dev/sdk/store'
import { formatTs } from './output'
import type { SessionRecord } from './types'

// Re-exported for the record-view callers below and their historical
// importers; the implementations live in the SDK's store layer now.
export { lifecycleText, oneLine, sandboxOutputStep, sandboxOutputLine } from '@ellipsis-dev/sdk/store'

// Record-rendering helpers shared by `session records` and `session connect`
// (moved out of commands/session.tsx so connect.ts can use them without an
// import cycle; session.tsx re-exports them for compatibility).

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

// One session_record as a single display line: index, timestamp, record type,
// and the first ~120 characters of its text content. Exported for tests.
export function formatStepLine(record: SessionRecord): string {
  const subtype =
    typeof record.payload.subtype === 'string' ? record.payload.subtype : null
  const type = subtype ? `${record.record_type}/${subtype}` : record.record_type
  return [
    String(record.stream_seq).padStart(4),
    formatTs(record.created_at),
    type.padEnd(16),
    oneLine(recordText(record), 120),
  ].join('  ')
}

// Best-effort display text for a stored record. A lifecycle record shows its
// notification line; a claude_code record's `payload` is the raw Claude Code
// stream event — a result step carries `result`, assistant/user steps carry an
// API message whose content is a string or a list of blocks (text, thinking,
// tool_use, tool_result). Anything unrecognized falls back to its JSON.
export function recordText(record: SessionRecord): string {
  if (record.source === 'lifecycle') {
    return lifecycleText(record.record_type, record.payload) ?? record.record_type
  }
  const data = record.payload ?? {}
  if (typeof data.result === 'string') return data.result
  const message = data.message as { content?: unknown } | undefined
  const text = contentText(message?.content)
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
