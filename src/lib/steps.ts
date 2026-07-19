import { formatTs } from './output'
import type { SessionRecord } from './types'

// Record-rendering helpers shared by `session records` and `session connect`
// (moved out of commands/session.tsx so connect.ts can use them without an
// import cycle; session.tsx re-exports them for compatibility).

// Human one-liner for a source==='lifecycle' record — the spawn/respawn/idle
// notifications the transcript itself doesn't carry. null for a type we don't
// surface (falls back to the raw record_type).
export function lifecycleText(
  recordType: string,
  payload: Record<string, unknown>,
): string | null {
  switch (recordType) {
    case 'sandbox_starting':
      return 'Starting sandbox…'
    case 'sandbox_setup_output': {
      // One chunk of setup-script output ({hook, chunk, lines}): show the
      // script's latest line so the record view reads as install progress.
      const line = setupOutputLine(payload)
      return line ? `${setupOutputHook(payload)} · ${line}` : null
    }
    case 'sandbox_ready': {
      const repos = Array.isArray(payload.repositories)
        ? (payload.repositories as unknown[]).filter((r): r is string => typeof r === 'string')
        : []
      const parts = ['Sandbox ready']
      if (repos.length) parts.push(repos.join(', '))
      const tier = cacheTierLabel(payload.cache_tier)
      if (tier) parts.push(tier)
      return parts.join(' · ')
    }
    case 'session_resumed':
      return 'Resumed the conversation'
    case 'session_paused':
      return 'Sleeping — your next message wakes it'
    case 'session_closed':
      return 'Conversation closed'
    case 'session_cancelled': {
      const reason = typeof payload.reason === 'string' ? payload.reason : null
      return reason ? `Session cancelled · ${reason}` : 'Session cancelled'
    }
    default:
      return null
  }
}

// The customer script a sandbox_setup_output chunk came from (image.setup /
// post_start / post_clone).
export function setupOutputHook(payload: Record<string, unknown>): string {
  return typeof payload.hook === 'string' ? payload.hook : 'setup'
}

// The last non-empty output line of a sandbox_setup_output chunk — what the
// live "Starting sandbox" sub-line and the record view both show.
export function setupOutputLine(payload: Record<string, unknown>): string | null {
  const lines = Array.isArray(payload.lines)
    ? (payload.lines as unknown[]).filter(
        (l): l is string => typeof l === 'string' && l.trim().length > 0,
      )
    : []
  return lines.length ? lines[lines.length - 1].trim() : null
}

// Customer-facing wording for sandbox_ready's cache_tier, explaining why the
// start was fast or slow.
function cacheTierLabel(tier: unknown): string | null {
  switch (tier) {
    case 'exact':
      return 'cached image'
    case 'incremental':
      return 'incremental build'
    case 'full':
      return 'full build'
    default:
      return null
  }
}

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

// Collapse whitespace/newlines to one displayable line, truncated to `max`.
export function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 3)}...`
}
