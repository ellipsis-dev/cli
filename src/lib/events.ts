// Turn the semantic event stream `agent session connect` receives into
// structured, renderable transcript items — the parsing/shaping layer behind
// the Claude-Code-like connect UI (src/ui/ConnectApp.tsx).
//
// The session WebSocket relays the agent's Claude Code stream-json: one JSON
// object per line, carried in `stdout` frames (see docs/RUN_STREAMING_SPEC.md
// and src/lib/ws.ts). Each object is a `CCEvent` — a discriminated union of
// assistant turns (text / thinking / tool_use blocks), user turns (tool
// results, or a human message), a system init, and a final result. This module
// is pure (no ANSI, no Ink) so it can be unit-tested directly; colours and
// layout live in the UI component.

import { lifecycleText, oneLine } from './steps'
import type { SessionRecord } from './types'

// A loosely-typed content block of a Claude Code message. We only read the
// fields we display and never interpret the rest of the payload.
export interface CCContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  content?: unknown
  tool_use_id?: string
  is_error?: boolean
}

// One Claude Code stream-json event. `message.content` is a string or a list
// of blocks; `result` (with cost/duration) caps a turn. Everything the CLI
// doesn't render is passed through untyped.
export interface CCEvent {
  type?: string
  subtype?: string
  message?: { role?: string; content?: unknown }
  result?: string
  duration_ms?: number
  total_cost_usd?: number
  num_turns?: number
  is_error?: boolean
  model?: string
  cwd?: string
  [key: string]: unknown
}

// A single line of the rendered transcript. `kind` selects the colour/glyph in
// the UI; `gutter` is the leading marker (● tool, ⎿ result, › you, ✻ thinking).
// `spaceBefore` opens a blank line above to separate message-level blocks;
// grouped sub-lines (a tool's result under its call) set it false so they hug.
export type ItemKind =
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'tool_result'
  | 'summary'
  | 'system'
  | 'user'
  | 'notice'
  | 'error'

export interface TranscriptItem {
  key: string
  kind: ItemKind
  text: string
  // Secondary, dimmed text shown after `text` on the same logical block (a
  // tool call's argument summary, a result's body).
  detail?: string
  gutter?: string
  spaceBefore?: boolean
  isError?: boolean
}

// Reassembles the byte chunks of `stdout`/`stderr` frames into whole lines: a
// single JSON event can be split across frames, so we only emit a line once its
// terminating newline has arrived. `flush()` releases any trailing partial at
// stream end.
export class LineBuffer {
  private buf = ''

  push(chunk: string): string[] {
    this.buf += chunk
    const parts = this.buf.split('\n')
    this.buf = parts.pop() ?? ''
    return parts
  }

  flush(): string[] {
    const rest = this.buf.trim()
    this.buf = ''
    return rest ? [rest] : []
  }
}

// Parse one relayed line into a CCEvent, or null if it isn't a JSON object (a
// blank keepalive line, or plain non-event text the caller renders verbatim).
export function parseEventLine(line: string): CCEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const value = JSON.parse(trimmed) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as CCEvent
    }
  } catch {
    // Not JSON — the caller shows it as raw text.
  }
  return null
}

// Claude-Code-style one-line summary of a tool call's arguments: the salient
// field for the common tools (a path, a command, a pattern), else compact JSON.
export function summarizeToolInput(name: string, input: unknown): string {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  const tool = name.toLowerCase()

  const path = str(args.file_path) ?? str(args.path) ?? str(args.notebook_path)
  if (['read', 'write', 'edit', 'multiedit', 'notebookedit'].includes(tool) && path) {
    return oneLine(path, 100)
  }
  if (tool === 'bash' && str(args.command)) return oneLine(str(args.command)!, 100)
  if ((tool === 'grep' || tool === 'glob') && str(args.pattern)) {
    const where = str(args.path) ?? str(args.glob)
    return oneLine(str(args.pattern)! + (where ? ` in ${where}` : ''), 100)
  }
  if ((tool === 'task' || tool === 'agent') && str(args.description)) {
    return oneLine(str(args.description)!, 100)
  }
  if (tool === 'webfetch' && str(args.url)) return oneLine(str(args.url)!, 100)
  if (tool === 'websearch' && str(args.query)) return oneLine(str(args.query)!, 100)

  const keys = Object.keys(args)
  if (keys.length === 0) return ''
  return oneLine(JSON.stringify(args), 100)
}

// Human-readable duration from seconds, Claude Code style: "42s" under a
// minute, then "3m 21s". Whole seconds only ("200.7s" reads as noise).
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

// Flatten a message's `content` to a block list (a bare string becomes one
// text block), so assistant and user turns share one iteration path.
function blocksOf(content: unknown): CCContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) return content as CCContentBlock[]
  return []
}

// Best-effort display text for a tool_result block: its content is a string, a
// list of text blocks, or arbitrary JSON. Whitespace is preserved (results are
// shown as a small indented body), only trimmed at the ends.
function toolResultText(block: CCContentBlock): string {
  const c = block.content
  if (typeof c === 'string') return c.trim()
  if (Array.isArray(c)) {
    const parts: string[] = []
    for (const inner of c as CCContentBlock[]) {
      if (typeof inner.text === 'string') parts.push(inner.text)
      else parts.push(JSON.stringify(inner))
    }
    return parts.join('\n').trim()
  }
  if (c === undefined || c === null) return ''
  return JSON.stringify(c)
}

// Render a whole event into transcript items (usually one, sometimes several
// for a multi-block assistant turn). `keyBase` makes React keys unique across
// the stream; blank when the event carries nothing worth showing.
export function eventToItems(event: CCEvent, keyBase: string): TranscriptItem[] {
  const items: TranscriptItem[] = []
  const push = (item: Omit<TranscriptItem, 'key'>): void => {
    items.push({ ...item, key: `${keyBase}:${items.length}` })
  }
  const type = event.type

  // A final result event: a dim one-liner capping the turn (cost + duration).
  if (type === 'result') {
    const bits: string[] = []
    if (typeof event.duration_ms === 'number') bits.push(formatDuration(event.duration_ms / 1000))
    if (typeof event.total_cost_usd === 'number') bits.push(`$${event.total_cost_usd.toFixed(2)}`)
    const label = event.is_error ? 'turn ended with an error' : 'turn complete'
    push({
      kind: 'summary',
      text: bits.length ? `${label} · ${bits.join(' · ')}` : label,
      spaceBefore: true,
      isError: event.is_error,
    })
    return items
  }

  // System events (the per-query init with model/cwd, and any informational
  // notices) render NOTHING in connect: Claude Code emits an init for every
  // user message it processes in stream-json mode, so rendering it printed
  // "session started" once per turn — pure noise. The model lives in the
  // banner; the raw records stay visible via `agent session records`.
  if (type === 'system') {
    return items
  }

  const blocks = blocksOf(event.message?.content)

  // A user turn is either tool results (grouped under the calls above) or a
  // human message injected into the conversation.
  if (type === 'user') {
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        const body = toolResultText(block)
        push({
          kind: 'tool_result',
          gutter: '⎿',
          text: body || '(no output)',
          spaceBefore: false,
          isError: block.is_error,
        })
      } else if (typeof block.text === 'string' && block.text.trim()) {
        push({ kind: 'user', gutter: '›', text: block.text.trim(), spaceBefore: true })
      }
    }
    return items
  }

  // Assistant turn (and any other event carrying message content): text,
  // thinking, and tool calls, in order.
  for (const block of blocks) {
    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
      push({ kind: 'thinking', gutter: '✻', text: block.thinking.trim(), spaceBefore: true })
    } else if (block.type === 'tool_use') {
      const name = block.name ?? 'tool'
      const summary = summarizeToolInput(name, block.input)
      push({
        kind: 'tool',
        gutter: '●',
        text: name,
        detail: summary ? `(${summary})` : undefined,
        spaceBefore: true,
      })
    } else if (typeof block.text === 'string' && block.text.trim()) {
      push({ kind: 'assistant', text: block.text.trim(), spaceBefore: true })
    }
  }
  return items
}

// Render one native session_record into transcript items. A claude_code
// record's payload is a CCEvent (assistant/user/result — expanded by
// eventToItems); a lifecycle record becomes a single dim notice line (the
// spawn/respawn/idle notifications). `keyBase` makes React keys unique.
export function recordToItems(record: SessionRecord, keyBase: string): TranscriptItem[] {
  if (record.source === 'lifecycle') {
    const text = lifecycleText(record.record_type, record.payload)
    return text ? [{ key: keyBase, kind: 'notice', text, spaceBefore: true }] : []
  }
  return eventToItems(record.payload as CCEvent, keyBase)
}

// Which records the connect transcript renders. Claude Code records are the
// conversation; lifecycle records are filtered EXCEPT sandbox_ready — the one
// moment worth a conversation note (the box is up, work can start). The other
// lifecycle rows (starting, paused, closed, resumed) are carried by the live
// activity line / footer / exit notice instead.
export function isConnectVisibleRecord(record: SessionRecord): boolean {
  return record.source !== 'lifecycle' || record.record_type === 'sandbox_ready'
}

// The tool calls that are executing RIGHT NOW, inferred from the committed
// transcript: a `tool` item whose `tool_result` hasn't arrived yet is a tool
// in flight (CC's headless stream emits nothing between the call committing
// and its result landing — this inference is the only live signal). Matching
// is FIFO within the current burst; any non-tool item (prose, thinking, a
// turn's result summary, a user message) means earlier calls resolved, so the
// pending set resets — a stale unmatched call from an errored old turn can
// never read as "running" forever.
export function pendingToolCalls(items: TranscriptItem[]): TranscriptItem[] {
  let pending: TranscriptItem[] = []
  for (const item of items) {
    if (item.kind === 'tool') pending.push(item)
    else if (item.kind === 'tool_result') pending.shift()
    else pending = []
  }
  return pending
}

// Collapse each maximal run of consecutive tool activity (tool calls + their
// results) into one dim summary line — the Claude-Code-app treatment ("Ran 8
// shell commands") — so a burst of shell work reads as one beat of the
// conversation. ctrl+r (the caller's `expanded` state) renders the original
// items instead, restoring the full ● call / ⎿ result blocks. Labels: all-Bash
// runs count shell commands, all-Read runs count files read, mixed runs name
// the tools involved.
export function collapseToolRuns(items: TranscriptItem[]): TranscriptItem[] {
  const out: TranscriptItem[] = []
  let group: TranscriptItem[] = []
  const flush = (): void => {
    if (group.length === 0) return
    const names = [...new Set(group.filter((i) => i.kind === 'tool').map((i) => i.text))]
    const n = group.filter((i) => i.kind === 'tool').length || group.length
    const plural = n === 1 ? '' : 's'
    let label: string
    if (names.length === 1 && names[0] === 'Bash') label = `Ran ${n} shell command${plural}`
    else if (names.length === 1 && names[0] === 'Read') label = `Read ${n} file${plural}`
    else if (names.length === 0) label = `Ran ${n} tool call${plural}`
    else {
      const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : '')
      label = `Ran ${n} tool call${plural} (${shown})`
    }
    out.push({ key: `grp:${group[0].key}`, kind: 'notice', text: label, spaceBefore: true })
    group = []
  }
  for (const item of items) {
    if (item.kind === 'tool' || item.kind === 'tool_result') group.push(item)
    else {
      flush()
      out.push(item)
    }
  }
  flush()
  return out
}

// Clamp a multi-line body to `maxLines`, appending a dim "+N lines" marker when
// truncated — used for tool-result bodies so a huge file read stays compact.
export function clampLines(text: string, maxLines: number): { body: string; more: number } {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { body: text, more: 0 }
  return { body: lines.slice(0, maxLines).join('\n'), more: lines.length - maxLines }
}

// The cumulative session cost (USD) a Claude Code `result` event carries: each
// result caps a turn and reports the running total for the whole session (not
// the turn alone). null for non-result events or a result without a cost.
export function resultCostUsd(event: CCEvent): number | null {
  if (event.type !== 'result') return null
  return typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null
}

// Fold a chronological event list into the spend the footer shows: `total` is
// the latest result's cumulative cost; `lastStep` is the delta from the result
// before it — i.e. the cost of the most recent completed turn. Both null until
// the first result lands; for the first result, lastStep equals total.
export function foldCosts(events: CCEvent[]): {
  total: number | null
  lastStep: number | null
} {
  let prev: number | null = null
  let total: number | null = null
  for (const event of events) {
    const cost = resultCostUsd(event)
    if (cost == null) continue
    prev = total
    total = cost
  }
  const lastStep = total != null && prev != null ? Math.max(0, total - prev) : total
  return { total, lastStep }
}

// The concrete label for the ✻ activity line during INFRASTRUCTURE phases —
// the sandbox spawning/waking — where nothing else on screen moves. It
// re-renders in place as the status changes; statuses never append transcript
// lines (that was the old, noisy model). null for `working` (the UI shows a
// whimsical Claude-Code-style gerund there instead) and for calm states
// (waiting, sleeping, terminal), where the line hides entirely.
export function statusActivityText(status: string): string | null {
  switch (status) {
    case 'scheduled':
      return 'Waiting for a worker'
    case 'starting':
      return 'Starting sandbox'
    case 'retrying':
      return 'Retrying after a transient error'
    default:
      return null
  }
}
