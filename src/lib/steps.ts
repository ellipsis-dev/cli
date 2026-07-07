import { formatTs } from './output'
import type { AgentStep } from './types'

// Step-rendering helpers shared by `session steps` and `session connect`
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

// One transcript step as a single display line: index, timestamp, step type,
// and the first ~120 characters of its text content. Exported for tests.
export function formatStepLine(step: AgentStep): string {
  const type = step.step_subtype ? `${step.step_type}/${step.step_subtype}` : step.step_type
  return [
    String(step.step_index).padStart(4),
    formatTs(step.created_at),
    type.padEnd(16),
    oneLine(stepText(step), 120),
  ].join('  ')
}

// Best-effort display text for a stored step. `data` is the raw Claude Code
// stream event: a result step carries `result`, assistant/user steps carry an
// API message whose content is a string or a list of blocks (text, thinking,
// tool_use, tool_result). Anything unrecognized falls back to its JSON.
export function stepText(step: AgentStep): string {
  const data = step.data ?? {}
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
