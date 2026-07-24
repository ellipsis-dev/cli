import { sessionStatusWord } from '@ellipsis-dev/sdk/stream'
import type { AgentSessionWire } from '@ellipsis-dev/sdk'
import type { AgentSession } from './types'

// Pure session-model helpers shared by the connect command and the
// multi-session UI (SessionsApp). No I/O here — everything is testable.

// THE selection marker, everywhere: the one cyan character that says "you
// are here" — it replaces a sidebar row's status dot, a transcript line's
// gutter icon, and the focused composer's prompt. One char, always cyan, so
// the eye finds the cursor instantly anywhere in the console. The thick
// right-arrow is reserved for selection alone; statuses are colored dots.
export const SELECTION_GLYPH = '▶'

// Whether the composer can send to this session, and — when it can't — why.
// Only durable (keyed) sessions have an inbox loop to attend a message;
// single-shot and closed sessions open watch-only.
export function connectability(session: AgentSession): {
  canSend: boolean
  reason?: string
} {
  if (!session.session_key) {
    return {
      canSend: false,
      reason: 'this session is single-shot (no durable conversation) — opening watch-only',
    }
  }
  if (session.session_state === 'closed') {
    return {
      canSend: false,
      reason:
        'this conversation is closed (a new event on its surface starts a successor) — opening watch-only',
    }
  }
  return { canSend: true }
}

// The one-word display status for a session row (the SDK's surface-first
// projection over the raw status).
export function rowStatusWord(session: AgentSession): string {
  return sessionStatusWord(session as unknown as AgentSessionWire)
}

// Statuses in which the agent is actively doing something (the sidebar's
// "in flight" read; mirrors the chat's spinner statuses).
export function isActiveStatusWord(word: string): boolean {
  return ['scheduled', 'starting', 'working', 'retrying', 'running', 'creating_sandbox'].includes(
    word,
  )
}

// The sidebar row's status marker: one dot, status told by color alone (the
// arrow shape belongs to the selection cursor):
//   ● yellow: in flight  · ● cyan: your move (waiting)  · ● dim: sleeping
//   ● green: done/closed · ● red: failed  · ● dim red: stopped/cancelled
export function rowGlyph(word: string): { glyph: string; color?: string; dim: boolean } {
  if (isActiveStatusWord(word)) return { glyph: '●', color: 'yellow', dim: false }
  if (word === 'waiting') return { glyph: '●', color: 'cyan', dim: false }
  if (word === 'sleeping' || word === 'idle') return { glyph: '●', dim: true }
  if (word === 'error' || word === 'failed') return { glyph: '●', color: 'red', dim: false }
  if (word === 'stopped' || word === 'cancelled') return { glyph: '●', color: 'red', dim: true }
  // closed / completed and anything unrecognized settles as done.
  return { glyph: '●', color: 'green', dim: true }
}

// The row's one-line description: what the session is doing right now
// (live_summary), else what it was asked to do (prompt), else where it came
// from. Whitespace collapsed; the caller truncates to the column.
export function rowDescription(session: AgentSession): string {
  const summary = session.live_summary
  if (typeof summary === 'string' && summary.trim()) return oneLineText(summary)
  const prompt = session.prompt
  if (typeof prompt === 'string' && prompt.trim()) return oneLineText(prompt)
  const source = typeof session.source === 'string' ? session.source : null
  return source ? `${source} session` : 'session'
}

function oneLineText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// The instant the session last did anything visible — what the row's age
// line counts from.
export function lastEventAt(session: AgentSession): string {
  const last = session.last_activity_at
  if (typeof last === 'string' && last) return last
  const msg = session.last_message_at
  if (typeof msg === 'string' && msg) return msg
  return session.updated_at
}

// Compact age for the row's second line: "12s ago", "2m ago", "3h ago",
// "5d ago". Never negative.
export function shortAge(iso: string, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

// Whether the conversation is still open (alive/idle) — the sidebar's top
// group. Terminal-status single-shot sessions and closed conversations sink
// to the bottom group.
export function isOpenConversation(session: AgentSession): boolean {
  if (session.session_state === 'closed') return false
  if (session.session_state === 'running' || session.session_state === 'idle') return true
  // No session_state (older rows, laptop syncs): treat non-terminal raw
  // statuses as open.
  return !['completed', 'error', 'cancelled', 'stopped'].includes(session.status)
}

// Sidebar order: open conversations first, then the rest, each group by most
// recent event first. Stable for equal keys.
export function sortSidebarSessions(sessions: readonly AgentSession[]): AgentSession[] {
  const key = (s: AgentSession): number => Date.parse(lastEventAt(s)) || 0
  return [...sessions].sort((a, b) => {
    const openA = isOpenConversation(a)
    const openB = isOpenConversation(b)
    if (openA !== openB) return openA ? -1 : 1
    return key(b) - key(a)
  })
}

// Attention transitions: a session that WAS in flight and now waits for a
// human (waiting/sleeping/idle) deserves the sidebar dot. Pure step function
// over consecutive poll snapshots.
export function attentionFlip(prevWord: string | undefined, nextWord: string): boolean {
  if (prevWord === undefined) return false
  if (!isActiveStatusWord(prevWord)) return false
  return nextWord === 'waiting' || nextWord === 'sleeping' || nextWord === 'idle'
}

// --------------------------- new-session picker ---------------------------

// The agent-selectable models for the new-session composer, most capable
// first (the dashboard's GET /models ordering). Static because /models is a
// dashboard-cookie route the CLI's bearer token can't call; keep in sync
// with model_registry.py's agent_selectable set. `null` id = let the server
// pick (DEFAULT_AGENT_MODEL).
export const COMPOSER_MODELS: ReadonlyArray<{ id: string | null; label: string }> = [
  { id: null, label: 'Default (Claude Opus 4.8)' },
  { id: 'claude-fable-5', label: 'Claude Fable 5' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
]

// A saved config's display name (the YAML's ellipsis.name), falling back to
// the row id.
export function configDisplayName(config: {
  id: string
  agent_config: Record<string, unknown>
}): string {
  const ellipsis = config.agent_config?.ellipsis
  if (ellipsis && typeof ellipsis === 'object') {
    const name = (ellipsis as Record<string, unknown>).name
    if (typeof name === 'string' && name.trim()) return name
  }
  return config.id
}

// "owner/name" -> the config-override repository shape.
export function repoOverrideEntry(fullName: string): { owner: string; name: string } | null {
  const [owner, name] = fullName.split('/')
  if (!owner || !name) return null
  return { owner, name }
}

// ------------------------------- layout ---------------------------------

// Which slice of the session cells renders when the list overflows the
// nav (or a dropdown its pane): a window of `capacity` cells keeping
// `selected` in frame, preferring to fill from the start.
export function sidebarSlice(
  count: number,
  capacity: number,
  selected: number,
): { start: number; end: number } {
  if (count <= capacity) return { start: 0, end: count }
  const cap = Math.max(1, capacity)
  let start = Math.min(Math.max(0, selected - Math.floor(cap / 2)), count - cap)
  if (selected < start) start = selected
  return { start, end: start + cap }
}
