import { sessionStatusWord } from '@ellipsis-dev/sdk/stream'
import type { Session as FrameSession } from '@ellipsis-dev/sdk'
import { theme } from './theme'
import type {
  AgentSession,
  AgentSessionSource,
  ListAgentSessionsQuery,
  StartAgentSessionRequest,
  SupportedModel,
} from './types'

// Pure session-model helpers shared by the connect command and the
// multi-session UI (SessionsApp). No I/O here — everything is testable.

// THE selection marker, everywhere: the one character that says "you are here"
// — it replaces a sidebar row's status dot, a transcript line's gutter icon,
// and the focused composer's prompt. Always painted theme.cursor, the cyan that
// means nothing else, so the eye finds it instantly anywhere in the console.
// The thick right-arrow is reserved for selection alone; statuses are dots.
export const SELECTION_GLYPH = '▶'

// Whether the composer can send to this session, and — when it can't — why.
//
// The server decides: `prompting` (protocol §4.1) is the same projection
// POST /messages enforces, so the composer appears exactly where a send would
// succeed and we never open an input whose first Enter 409s. Its `detail` is
// the server's curated sentence, so a new refusal reason needs no CLI release
// to read well. A session that came from a surface (a Slack/GitHub/Linear
// mention) is steered THERE, not here, because that surface is where the
// agent's answers post.
export function connectability(session: AgentSession): {
  canSend: boolean
  reason?: string
} {
  if (session.prompting.enabled) return { canSend: true }
  const detail = session.prompting.detail?.trim()
  return {
    canSend: false,
    reason: detail
      ? `${detail} Opening watch-only.`
      : 'this session does not accept messages — opening watch-only',
  }
}

// The one-word display status for a session row (the SDK's surface-first
// projection over the raw status).
export function rowStatusWord(session: AgentSession): string {
  return sessionStatusWord(session as unknown as FrameSession)
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
//   ● amber: in flight   · ● bone: your move (waiting) · ● dim: sleeping
//   ● green: done/closed · ● red: failed · ● dim red: stopped/cancelled
export function rowGlyph(word: string): { glyph: string; color?: string; dim: boolean } {
  if (isActiveStatusWord(word)) return { glyph: '●', color: theme.active, dim: false }
  if (word === 'waiting') return { glyph: '●', color: theme.foreground, dim: false }
  if (word === 'sleeping' || word === 'idle') return { glyph: '●', dim: true }
  if (word === 'error' || word === 'failed') return { glyph: '●', color: theme.error, dim: false }
  if (word === 'stopped' || word === 'cancelled')
    return { glyph: '●', color: theme.error, dim: true }
  // closed / completed and anything unrecognized settles as done.
  return { glyph: '●', color: theme.success, dim: true }
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

// A token count in the tightest readable form: 840 -> "840", 84_200 -> "84.2k",
// 512_000 -> "512k", 1_240_000 -> "1.24M". One decimal only while it buys
// precision, so the column stays narrow.
export function compactTokens(n: number): string {
  if (!isFinite(n) || n < 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) {
    const k = n / 1000
    return k < 100 ? `${trimZero(k.toFixed(1))}k` : `${Math.round(k)}k`
  }
  return `${trimZero((n / 1_000_000).toFixed(2))}M`
}

function trimZero(s: string): string {
  return s.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')
}

// The nav row's right-hand metadata: how much work the agent did (tokens,
// spend) and when it last moved. Spend is the server's millicent total, the
// same total the chat footer shows. A just-started session drops the empty
// bits rather than showing "0 · $0.00". No source tag: the nav lists cloud
// sessions only, so it would read the same on every row.
export function rowMeta(session: AgentSession, now: Date = new Date()): string {
  const bits: string[] = []
  const tokens = session.tokens?.total ?? 0
  if (tokens > 0) bits.push(compactTokens(tokens))
  const millicents = session.cost?.total ?? 0
  if (millicents > 0) bits.push(`$${(millicents / 100_000).toFixed(2)}`)
  bits.push(shortAge(lastEventAt(session), now))
  return bits.join(' · ')
}

// Where the session runs — laptop syncs are the only non-cloud kind the nav
// distinguishes. Every session-returning route carries `source` top-level.
export function sessionSource(session: AgentSession): string {
  return session.source === 'laptop' ? 'laptop' : 'cloud'
}

// The sidebar's status bands, top to bottom: live conversations, then parked
// ones, then finished ones, with the dead ends last.
//
// `waiting` shares the top band with the in-flight statuses on purpose. A warm
// session crosses working → waiting → working on EVERY turn, so banding those
// apart would reorder the list on every agent response — exactly the churn
// created_at ordering exists to kill. Both mean "this conversation is live";
// which side of a turn it's on is the row's dot color, not its position.
export function statusBand(word: string): number {
  if (word === 'waiting' || isActiveStatusWord(word)) return 0
  if (word === 'sleeping' || word === 'idle') return 1
  if (['error', 'failed', 'stopped', 'cancelled'].includes(word)) return 3
  // closed / completed and anything unrecognized settles as done.
  return 2
}

// Sidebar order: status band, then oldest-last within the band (newest first).
//
// Deliberately NOT "most recent event first": with several sessions in flight
// every agent response is a new event, so a recency sort permutes the list on
// every poll and the row you were reading walks out from under you. Birth
// order is fixed for the life of a session, so a row only ever moves when its
// status band changes — a handful of times, not once per turn.
//
// Stable for equal keys (equal band + equal created_at keeps input order).
export function sortSidebarSessions(sessions: readonly AgentSession[]): AgentSession[] {
  const band = (s: AgentSession): number => statusBand(rowStatusWord(s))
  const born = (s: AgentSession): number => Date.parse(s.created_at) || 0
  return [...sessions].sort((a, b) => band(a) - band(b) || born(b) - born(a))
}

// The sidebar list: the polled snapshot plus composer-spawned sessions the
// poll has not returned yet. A session can sit in both for one poll cycle
// (a list read that lands mid-create, then the create response), so it is
// deduped by id with the polled copy winning — that one is fresher.
export function mergeSidebarSessions(
  polled: readonly AgentSession[],
  local: readonly AgentSession[],
): AgentSession[] {
  const byId = new Map<string, AgentSession>()
  for (const s of [...polled, ...local]) if (!byId.has(s.id)) byId.set(s.id, s)
  return sortSidebarSessions([...byId.values()])
}

// ---------------------------- session bar scope ---------------------------

// The list query behind the session bar, from the user's `sessionBar` settings.
// Age, repository, status, and source are all server-side filters, so the rows
// that come back are already the ones worth showing and the page is not spent
// on sessions the bar would drop.
//
// `repo: 'cwd'` outside a repository asks for every repository rather than a
// repo named "" — the bar is a way back into your work, so a shell in ~ should
// still show it.
export function sessionBarQuery(
  bar: {
    days: number
    repo: 'cwd' | 'any'
    statuses: 'all' | 'unfinished'
    sources: string[] | undefined
  },
  context: { authorId: number | null; detectedRepo: string | null },
): ListAgentSessionsQuery {
  const query: ListAgentSessionsQuery = {
    author_id: context.authorId ?? undefined,
    // Enough rows to band and scroll past a screenful, without paying for a page
    // nobody scrolls to.
    limit: SESSION_BAR_FETCH,
  }
  if (bar.days > 0) query.days = bar.days
  if (bar.repo === 'cwd' && context.detectedRepo) query.repo = context.detectedRepo
  if (bar.statuses === 'unfinished') query.unfinished = true
  if (bar.sources) query.source = bar.sources as AgentSessionSource[]
  return query
}

// How many rows the session list fetches to fill its screen from.
export const SESSION_BAR_FETCH = 50

// Attention transitions: a session that WAS in flight and now waits for a
// human (waiting/sleeping/idle) deserves the sidebar dot. Pure step function
// over consecutive poll snapshots.
export function attentionFlip(prevWord: string | undefined, nextWord: string): boolean {
  if (prevWord === undefined) return false
  if (!isActiveStatusWord(prevWord)) return false
  return nextWord === 'waiting' || nextWord === 'sleeping' || nextWord === 'idle'
}

// --------------------------- new-session picker ---------------------------

export type ComposerModel = { id: string | null; label: string }

// The composer's model list when GET /models is unavailable (an older
// server): the agent-selectable set as of this build, most expensive first.
// `null` id = let the server pick (DEFAULT_AGENT_MODEL). Labels are the raw
// model ids — the CLI speaks the API's vocabulary, not marketing names.
export const COMPOSER_MODELS: ReadonlyArray<ComposerModel> = [
  { id: null, label: 'Default' },
  { id: 'claude-fable-5', label: 'claude-fable-5' },
  { id: 'claude-opus-5', label: 'claude-opus-5' },
  { id: 'claude-opus-4-8', label: 'claude-opus-4-8' },
  { id: 'claude-sonnet-5', label: 'claude-sonnet-5' },
  { id: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5-20251001' },
]

// The composer's model options from the server's list, keeping its order.
// Labels are raw model ids; the null "let the server pick" entry IS the
// default model's row — labelled with the id it resolves to
// (DEFAULT_AGENT_MODEL), replacing that model's own entry so the id appears
// once in the list.
export function composerModelOptions(models: readonly SupportedModel[]): ComposerModel[] {
  if (models.length === 0) return [...COMPOSER_MODELS]
  const fallback = models.find((m) => m.is_default_agent_model)
  return [
    { id: null, label: fallback ? fallback.id : 'Default' },
    ...models
      .filter((m) => !m.is_default_agent_model)
      .map((m) => ({ id: m.id as string | null, label: m.id })),
  ]
}

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

// The composer's picks, as the new-session pane reports them. `repos` null =
// the Repository row was never touched, so the server's own resolution stands;
// an array is an explicit checkout set, and [] is the legitimate "no repository
// at all" sandbox.
export interface ComposerChoices {
  configId: string | null
  model: string | null
  repos: string[] | null
}

// The entry point's base request with the composer's picks layered on: a saved
// config as the source, the model + repositories as a per-run config override
// (the dashboard composer's shape).
export function applyComposerChoices(
  base: StartAgentSessionRequest,
  choices: ComposerChoices,
): StartAgentSessionRequest {
  const req: StartAgentSessionRequest = { ...base }
  if (choices.configId) req.config_id = choices.configId
  const override: Record<string, unknown> = {}
  if (choices.model) override.claude = { model: choices.model }
  if (choices.repos !== null) {
    // Lists replace wholesale in a config override, so this set becomes the
    // run's entire checkout — including the empty set, which a sandbox
    // supports (zero, one, or many repositories are all valid).
    override.environment = {
      repositories: choices.repos
        .map(repoOverrideEntry)
        .filter((e): e is { owner: string; name: string } => e !== null),
    }
    // The server merges the request's `repository` context into the checkout
    // unconditionally, even under an explicit config, so leaving it on would
    // re-add a repo the user just unchecked. Dropping it also moves default-
    // config resolution off that repo's rung, which is the honest reading of
    // "not this one".
    if (req.repository != null && !choices.repos.includes(req.repository)) {
      delete req.repository
    }
  }
  if (Object.keys(override).length > 0) req.config_override = override
  return req
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

// Which slice of the session list the vertical nav shows: the highlight walks
// down to the second-to-last visible row and parks there while the list
// scrolls under it, so there is always one row of lookahead. Only the true
// end of the list lets the highlight sit on the last row.
export function navSlice(
  count: number,
  capacity: number,
  selected: number,
): { start: number; end: number } {
  if (count <= capacity) return { start: 0, end: count }
  const cap = Math.max(2, capacity)
  const start = Math.min(Math.max(0, selected - (cap - 2)), count - cap)
  return { start, end: start + cap }
}
