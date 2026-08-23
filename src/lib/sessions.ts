import { sessionStatusWord } from '@ellipsis-dev/sdk/stream'
import type { Session as FrameSession } from '@ellipsis-dev/sdk'
import { theme } from './theme'
import type {
  AgentSession,
  AgentSessionSource,
  ListAgentSessionsQuery,
  ModelManufacturer,
  ModelRateCard,
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

// The row's one-line description: what the session is doing right now (its
// live summary), else what it was asked to do (prompt), else where it came
// from. Whitespace collapsed; the caller truncates to the column.
export function rowDescription(session: AgentSession): string {
  const summary = session.summary?.description
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

// The nav row's right-hand metadata: what the session cost and when it last
// moved. Spend is the server's millicent total, the same total the chat footer
// shows. No token count: it is a number you cannot act on from the launcher.
// A just-started session drops the empty spend rather than showing "$0.00". No
// source tag either: the nav lists cloud sessions only, so it would read the
// same on every row.
export function rowMeta(session: AgentSession, now: Date = new Date()): string {
  const bits: string[] = []
  const millicents = session.cost?.total ?? 0
  if (millicents > 0) bits.push(`$${(millicents / 100_000).toFixed(2)}`)
  bits.push(shortAge(lastEventAt(session), now))
  return bits.join(' · ')
}

// The agent identity to show for a session: the config's own name, else the id
// of the saved config its snapshot came from. Both are absent for inline,
// platform-default, and built-in configs, which have nothing to name.
export function sessionConfigName(session: AgentSession): string | null {
  return session.agent.config.ellipsis.name ?? session.agent.config_id ?? null
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

// The picker header's description of the bar's active filters — the answer to
// "where are the rest of my sessions?". Mirrors sessionBarQuery exactly: a
// clause appears here iff the matching filter went into the query. null when
// the list is unfiltered.
export function sessionBarFilterLabel(
  bar: {
    days: number
    repo: 'cwd' | 'any'
    statuses: 'all' | 'unfinished'
    sources: string[] | undefined
  },
  detectedRepo: string | null,
): string | null {
  const clauses: string[] = []
  if (bar.repo === 'cwd' && detectedRepo) clauses.push(detectedRepo)
  if (bar.days > 0) clauses.push(`last ${bar.days === 1 ? 'day' : `${bar.days} days`}`)
  if (bar.statuses === 'unfinished') clauses.push('unfinished')
  if (bar.sources) clauses.push(`source ${bar.sources.join('/')}`)
  if (clauses.length === 0) return null
  return `filtering to ${clauses.join(' · ')}`
}

// The launcher's live filter: which sessions match the typed text. Matches
// the summary and the prompt case-insensitively so a session is findable by
// what it is doing or by what it was asked; an empty query matches all.
export function filterSessions(
  sessions: readonly AgentSession[],
  query: string,
): readonly AgentSession[] {
  const q = query.trim().toLowerCase()
  if (!q) return sessions
  return sessions.filter((s) => {
    const summary = typeof s.summary?.description === 'string' ? s.summary.description : ''
    const prompt = typeof s.prompt === 'string' ? s.prompt : ''
    return `${summary}\n${prompt}`.toLowerCase().includes(q)
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

// One row of a composer picker. `group` and `rate` are what the model list
// uses and the other two pickers leave unset: repositories and agent configs
// are flat lists of names with no vendor to group under and no price to quote.
export type ComposerModel = {
  id: string | null
  label: string
  // The heading this row sits under. Consecutive rows sharing a group print
  // one heading between them; an unset group prints none.
  group?: string | null
  // The two price cells printed after the label, already formatted as dollars.
  // Unset when there is no rate to quote (see modelRate).
  rate?: { input: string; output: string } | null
}

// The vendor groups, in the order their headings appear, and the names those
// headings carry. Both are copies of the dashboard's rate-card table
// (frontend ModelsRateCardTab + manufacturerLabel), so a model sits under the
// same vendor with the same spelling in the terminal as on the web.
//
// Ranked, not sorted: alphabetical would put OpenAI above Anthropic, and price
// would reshuffle the groups every time one rate card moves. A manufacturer
// the server adds before this build knows about it lands last, under its raw
// enum name, which is wrong-looking but never missing.
const MANUFACTURER_ORDER: readonly string[] = [
  'anthropic',
  'openai',
  'zai',
  'minimax',
  'moonshot',
]
const MANUFACTURER_LABELS: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  zai: 'Z.ai',
  minimax: 'MiniMax',
  moonshot: 'Moonshot AI',
}

function manufacturerLabel(manufacturer: ModelManufacturer | string): string {
  return MANUFACTURER_LABELS[manufacturer] ?? manufacturer
}

function manufacturerRank(manufacturer: ModelManufacturer | string): number {
  const at = MANUFACTURER_ORDER.indexOf(manufacturer)
  return at === -1 ? MANUFACTURER_ORDER.length : at
}

// Rate-card cents per 1M tokens → "$5", "$0.75". Whole dollars drop the
// ".00": at a glance "$5" is a price, where "$5.00" reads as a table cell.
export function rateDollars(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`
}

// A model's price as two table cells: the two lanes that decide what a session
// costs, read and written. The three cache lanes are deliberately left out —
// five numbers on a picker row is a rate card, not a hint, and `agent model
// list` (plus the dashboard's Models tab) is where the full card belongs. Null
// when the server sent no card, which is the honest answer: a stale hardcoded
// price is worse than no price.
export function modelRate(
  rate: ModelRateCard | null | undefined,
): { input: string; output: string } | null {
  if (!rate) return null
  return {
    input: rateDollars(rate.input_cents_per_1m_tokens),
    output: rateDollars(rate.output_cents_per_1m_tokens),
  }
}

// The composer's model list when GET /models is unavailable (an older
// server): the agent-selectable set as of this build, most expensive first.
// `null` id = let the server pick (DEFAULT_AGENT_MODEL). Labels are the raw
// model ids — the CLI speaks the API's vocabulary, not marketing names. Every
// id here is Anthropic-built, so the one heading is hardcoded; no rates,
// because a price this list can't refresh would go stale silently.
export const COMPOSER_MODELS: ReadonlyArray<ComposerModel> = [
  { id: null, label: 'Default' },
  { id: 'claude-fable-5', label: 'claude-fable-5', group: 'Anthropic' },
  { id: 'claude-opus-5', label: 'claude-opus-5', group: 'Anthropic' },
  { id: 'claude-opus-4-8', label: 'claude-opus-4-8', group: 'Anthropic' },
  { id: 'claude-sonnet-5', label: 'claude-sonnet-5', group: 'Anthropic' },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'claude-haiku-4-5-20251001',
    group: 'Anthropic',
  },
]

// The composer's model options from the server's list, grouped by who BUILT
// each model (MANUFACTURER_ORDER) and, inside a group, left in the server's
// order — which is most expensive first, so every group reads down from its
// flagship. Labels are raw model ids, each carrying its rate as price cells.
//
// The account default's row carries the null "let the server pick" id, so
// leaving the picker alone keeps the server as the one resolving the model.
// It sits in its vendor's group like any other row: it is one entry in one
// table, marked by being the checked one, not by a heading of its own.
//
// Only when NO model claims the flag does a separate "Default" row appear at
// the top, because then there is no id to attach the null pick to.
export function composerModelOptions(models: readonly SupportedModel[]): ComposerModel[] {
  if (models.length === 0) return [...COMPOSER_MODELS]
  const hasDefault = models.some((m) => m.is_default_agent_model)
  const rows = models
    // Stable, so the server's within-vendor ordering survives the regroup.
    .slice()
    .sort((a, b) => manufacturerRank(a.manufacturer) - manufacturerRank(b.manufacturer))
    .map((m) => ({
      id: (m.is_default_agent_model ? null : m.id) as string | null,
      label: m.id,
      group: manufacturerLabel(m.manufacturer),
      rate: modelRate(m.rate_card),
    }))
  return hasDefault ? rows : [{ id: null, label: 'Default', group: null }, ...rows]
}

// A picker's display rows: each group's heading, then the options under it.
// Headings are DECORATION — they carry no index, ↑/↓ never lands on one, and
// activating a row can't select one — so the list scrolls over these rows
// while the highlight stays an option index. A heading therefore scrolls away
// with its group instead of pinning to the top of the window, which is what
// keeps this a plain list and not a sticky-header layout.
export type ComposerPickerRow =
  | { kind: 'group'; label: string }
  | { kind: 'option'; at: number }

export function composerPickerRows(
  options: readonly ComposerModel[],
): ComposerPickerRow[] {
  const rows: ComposerPickerRow[] = []
  let group: string | null = null
  options.forEach((option, at) => {
    const next = option.group ?? null
    if (next !== null && next !== group) rows.push({ kind: 'group', label: next })
    group = next
    rows.push({ kind: 'option', at })
  })
  return rows
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
