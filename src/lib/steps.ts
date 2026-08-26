import {
  deriveSandboxState as sdkDeriveSandboxState,
  lifecycleText as sdkLifecycleText,
  sessionLogText as sdkSessionLogText,
  oneLine,
  type SandboxState,
} from '@ellipsis-dev/sdk/store'
import { formatTs } from './output'
import type { SessionRecord } from './types'

// Re-exported for the record-view callers below and their historical
// importers; the implementations live in the SDK's store layer now.
export { oneLine, sandboxOutputStep, sandboxOutputLine } from '@ellipsis-dev/sdk/store'

// The SDK's wording, with its middot separators as commas — the CLI writes
// plain sentences.
const commas = (text: string): string => text.replaceAll(' · ', ', ')

export function lifecycleText(
  ...args: Parameters<typeof sdkLifecycleText>
): string | null {
  const text = sdkLifecycleText(...args)
  return text === null ? null : commas(text)
}

export function sessionLogText(
  ...args: Parameters<typeof sdkSessionLogText>
): string | null {
  const text = sdkSessionLogText(...args)
  return text === null ? null : commas(text)
}

export function deriveSandboxState(
  ...args: Parameters<typeof sdkDeriveSandboxState>
): SandboxState | null {
  const state = sdkDeriveSandboxState(...args)
  if (!state) return null
  return {
    ...state,
    headline: commas(state.headline),
    log: state.log.map((line) => ({ ...line, text: commas(line.text) })),
  }
}

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

// The payload as a loose bag. Every read below is best-effort display text
// across three harness formats (claude_sdk@1, codex_jsonl@1,
// ellipsis_lifecycle@1), so narrowing the SDK's per-format union at each field
// would buy nothing a `typeof` guard doesn't already give.
function fields(record: SessionRecord): Record<string, unknown> {
  return record.payload as Record<string, unknown>
}

// One session_record as a single display line: index, timestamp, record type,
// and the first ~120 characters of its text content. Exported for tests.
export function formatStepLine(record: SessionRecord): string {
  const raw = fields(record).subtype
  const subtype = typeof raw === 'string' ? raw : null
  const type = subtype ? `${record.record_type}/${subtype}` : record.record_type
  return [
    String(record.stream_seq).padStart(4),
    formatTs(record.created_at),
    type.padEnd(16),
    oneLine(recordText(record), 120),
  ].join('  ')
}

// Best-effort display text for a stored record. A lifecycle record shows its
// notification line; a claude_code record's `payload` is the raw agent stream
// event — a result step carries `result`, assistant/user steps carry `content`,
// a string or a list of blocks (text, thinking, tool_use, tool_result).
// Anything unrecognized falls back to its JSON.
export function recordText(record: SessionRecord): string {
  const data = fields(record)
  if (record.source === 'lifecycle') {
    return lifecycleText(record.record_type, data) ?? record.record_type
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
