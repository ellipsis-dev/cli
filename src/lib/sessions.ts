import { sessionStatusWord } from '@ellipsis-dev/sdk/stream'
import type { Session as FrameSession } from '@ellipsis-dev/sdk'
import { SESSION_BAR_DEFAULTS } from './config'
import { theme } from './theme'
import type {
  AgentSession,
  AgentSessionSource,
  EnvironmentDefaults,
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
//   ● amber: in flight, ● bone: your move (waiting), ● dim: sleeping
//   ● green: done/closed, ● red: failed, ● dim red: stopped/cancelled
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
  return bits.join(', ')
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
// "where are the rest of my sessions?". Mirrors sessionBarQuery, with one
// exception: the default sources are not named, since "manual/cli/mention" is
// what everyone sees and answers no question. null when there is nothing to say.
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
  const sources = bar.sources?.join('/')
  if (sources && sources !== SESSION_BAR_DEFAULTS.sources?.join('/')) {
    clauses.push(`source ${sources}`)
  }
  if (clauses.length === 0) return null
  return `filtering to ${clauses.join(', ')}`
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

// Rate-card millicents per 1M tokens → "$5", "$0.75". Whole dollars drop the
// ".00": at a glance "$5" is a price, where "$5.00" reads as a table cell.
export function rateDollars(millicents: number): string {
  const dollars = millicents / 100_000
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
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
    input: rateDollars(rate.input_millicents_per_1m_tokens),
    output: rateDollars(rate.output_millicents_per_1m_tokens),
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

export const CUSTOM_ENVIRONMENT_DIVIDER = 'custom environment'
export const VARIABLES_HEADING = 'variables'
export const ADD_VARIABLE_LABEL = '+ new variable'

// The built-in "no environment at all" option's id. A sentinel, never sent: the
// launcher translates it into the cleared-list override, since the wire has no
// name for "empty" (omitting the environment would let the ladder resolve one).
export const EMPTY_ENVIRONMENT_ID = 'empty:builtin'
export const EMPTY_ENVIRONMENT_LABEL = '[empty]'

// The open Environment list, top to bottom: the saved environments and
// "[empty]" as options, a divider, then the custom section — one checkbox per
// stored secret, then the variables typed here, then the add button.
//
// `hover` is the index ↑/↓ walks; rows without one are DECORATION the highlight
// skips, which is what keeps this a plain list rather than a nested tree.
export type EnvironmentPickerRow =
  | { kind: 'option'; at: number; hover: number }
  | { kind: 'divider'; label: string }
  | { kind: 'heading'; label: string }
  | { kind: 'secret'; name: string; hover: number }
  | { kind: 'variable'; name: string; hover: number }
  | { kind: 'addVariable'; hover: number }

// What activating a hovered row does, without the renderer having to know the
// list's shape.
export type EnvironmentTarget =
  | { kind: 'option'; at: number }
  | { kind: 'secret'; name: string }
  | { kind: 'variable'; name: string }
  | { kind: 'addVariable' }

export interface EnvironmentPickerInput {
  optionCount: number
  // The account's stored secret names (values are write-only, so checking one
  // adds a variable with no value and the sandbox resolves it at start).
  secretNames: readonly string[]
  customVariables: readonly CustomVariable[]
}

export function environmentPickerRows(input: EnvironmentPickerInput): EnvironmentPickerRow[] {
  const rows: EnvironmentPickerRow[] = []
  let hover = 0
  for (let at = 0; at < input.optionCount; at++) rows.push({ kind: 'option', at, hover: hover++ })
  rows.push({ kind: 'divider', label: CUSTOM_ENVIRONMENT_DIVIDER })
  rows.push({ kind: 'heading', label: VARIABLES_HEADING })
  for (const name of input.secretNames) rows.push({ kind: 'secret', name, hover: hover++ })
  // A variable typed here whose name is also a secret rides that secret's row
  // instead of getting a second one: one name, one row, whichever way it got in.
  for (const v of input.customVariables) {
    if (input.secretNames.includes(v.name)) continue
    rows.push({ kind: 'variable', name: v.name, hover: hover++ })
  }
  rows.push({ kind: 'addVariable', hover: hover++ })
  return rows
}

// Where a hover index lands, clamped to the list.
export function environmentPickerAt(
  input: EnvironmentPickerInput,
  hover: number,
): EnvironmentTarget {
  const rows = environmentPickerRows(input)
  const landable = rows.filter(
    (r): r is Extract<EnvironmentPickerRow, { hover: number }> => 'hover' in r,
  )
  const row = landable[Math.min(Math.max(0, hover), landable.length - 1)]
  if (row.kind === 'option') return { kind: 'option', at: row.at }
  if (row.kind === 'secret') return { kind: 'secret', name: row.name }
  if (row.kind === 'variable') return { kind: 'variable', name: row.name }
  return { kind: 'addVariable' }
}

export function environmentPickerCount(input: EnvironmentPickerInput): number {
  return environmentPickerRows(input).filter((r) => 'hover' in r).length
}

// What the resting Environment row says: the picked environment, plus a count
// of whatever the custom section adds on top of it.
export function environmentRowSummary(
  label: string,
  customVariables: readonly CustomVariable[],
): string {
  if (customVariables.length === 0) return label
  const n = customVariables.length
  return `${label} +${n} variable${n === 1 ? '' : 's'}`
}

// How a variable reads in the custom section: the name alone when the sandbox
// resolves its value from stored secrets, otherwise the value as typed. The
// VARIABLES heading already says what these are, so a valueless row needs no
// note of its own.
export function variableRowLabel(name: string, value: string | null | undefined): string {
  return value === undefined || value === null ? name : `${name}=${value}`
}

// A variable the launcher's custom section adds on top of the picked
// environment. A null value means "resolve this name from the account's stored
// secrets", the same reading `agent variable set NAME` and the environment YAML
// give it.
export interface CustomVariable {
  name: string
  value: string | null
}

// The composer's picks, as the new-session pane reports them. environment and
// model null = that row was never touched, so the server resolves it (the
// environment ladder, the account's default model). `emptyEnvironment` is the
// built-in "[empty]" pick: no saved environment, and the resolved lists cleared.
export interface ComposerChoices {
  environment: string | null
  model: string | null
  emptyEnvironment: boolean
  // The picked environment's own variables, needed because an override array
  // REPLACES the resolved list rather than appending to it.
  baseVariables: readonly CustomVariable[]
  customVariables: readonly CustomVariable[]
}

// One variable list from the two that have to end up in the override, with a
// later name winning: a custom entry that repeats a base name is an edit of it,
// in place, not a duplicate the server would have to break the tie on.
export function mergeVariables(
  base: readonly CustomVariable[],
  custom: readonly CustomVariable[],
): CustomVariable[] {
  const merged: CustomVariable[] = []
  const at = new Map<string, number>()
  for (const v of [...base, ...custom]) {
    const seen = at.get(v.name)
    if (seen === undefined) {
      at.set(v.name, merged.length)
      merged.push(v)
    } else merged[seen] = v
  }
  return merged
}

// A variable in the shape an environment override takes: `value` omitted (not
// null) when the name resolves from stored secrets, since the config schema
// treats an absent value as the secret lookup.
function variableEntry(v: CustomVariable): { name: string; value?: string } {
  return v.value === null ? { name: v.name } : { name: v.name, value: v.value }
}

// The entry point's base request with the composer's picks layered on: the
// environment as the session's own choice, the model and any custom
// environment edits as a per-run override (the dashboard composer's shape).
//
// Every list in an override REPLACES the resolved one, so a custom variable
// ships alongside the picked environment's own — that is what makes the custom
// section additive rather than a silent wipe of the environment it sits under.
export function applyComposerChoices(
  base: StartAgentSessionRequest,
  choices: ComposerChoices,
): StartAgentSessionRequest {
  const req: StartAgentSessionRequest = { ...base }
  // Never combined with a config source: the launcher sends no config_id, so
  // the environment is always the session's to name (the server 400s both).
  if (choices.environment) req.environment = choices.environment
  const override: Record<string, unknown> = {}
  if (choices.model) override.claude = { model: choices.model }
  const environment: Record<string, unknown> = {}
  // "[empty]" names no environment, so the ladder would still resolve one:
  // clearing the lists is what actually empties the sandbox.
  if (choices.emptyEnvironment) {
    environment.repositories = []
    environment.mcp_servers = []
  }
  const variables = mergeVariables(
    choices.emptyEnvironment ? [] : choices.baseVariables,
    choices.customVariables,
  )
  if (choices.emptyEnvironment || choices.customVariables.length > 0) {
    environment.variables = variables.map(variableEntry)
  }
  if (Object.keys(environment).length > 0) override.environment = environment
  if (Object.keys(override).length > 0) req.override = override
  return req
}

// "NAME=value" / "NAME" as typed into the custom section's name field, or an
// error to show in place. A bare name resolves from stored secrets (null
// value); an empty value after the equals is a real empty string, which is a
// legitimate thing to set a variable to.
export function parseVariableEntry(input: string): CustomVariable | { error: string } {
  const text = input.trim()
  if (!text) return { error: 'name a variable' }
  const eq = text.indexOf('=')
  const name = (eq === -1 ? text : text.slice(0, eq)).trim()
  if (!name) return { error: 'name a variable' }
  // The sandbox exports these into a shell, so the name has to be a legal
  // shell identifier or the export silently does nothing.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return { error: `"${name}" is not a valid variable name` }
  }
  return { name, value: eq === -1 ? null : text.slice(eq + 1) }
}

// Which rungs of the defaults ladder point at one environment: the account
// rung, and every repository rung. An environment can hold several at once, so
// this is a list — "account default, default for acme/api".
export function environmentDefaultRungs(
  ladder: EnvironmentDefaults | null,
  id: string,
): string[] {
  if (!ladder) return []
  return [
    ...(ladder.account === id ? ['account default'] : []),
    ...Object.entries(ladder.repositories)
      .filter(([, envId]) => envId === id)
      .map(([repo]) => `default for ${repo}`),
  ]
}

// The Environment row's options: every saved environment, each labelled with
// the default rungs it holds, then the built-in "[empty]". `picked` is the row
// checked while the row is untouched — the environment the ladder resolves for
// the repo you are standing in, so the launcher can SEND what it shows instead
// of leaving the server to resolve something else.
//
// A "Default" row appears only when no rung resolves at all: then there is no
// name to show and the server's own resolution is the honest answer.
export function environmentOptions(
  environments: readonly { id: string; name: string }[],
  ladder: EnvironmentDefaults | null,
  detectedRepo: string | null,
): { options: { id: string | null; label: string }[]; picked: number } {
  const resolved = ladder ? effectiveEnvironmentDefault(ladder, detectedRepo)?.id : undefined
  const listed = environments.map((e) => {
    const rungs = environmentDefaultRungs(ladder, e.id)
    return {
      id: e.id as string | null,
      label: rungs.length > 0 ? `${e.name} (${rungs.join(', ')})` : e.name,
    }
  })
  const empty = { id: EMPTY_ENVIRONMENT_ID as string | null, label: EMPTY_ENVIRONMENT_LABEL }
  const at = resolved ? environments.findIndex((e) => e.id === resolved) : -1
  if (at !== -1) return { options: [...listed, empty], picked: at }
  return {
    options: [{ id: null as string | null, label: 'Default' }, ...listed, empty],
    picked: 0,
  }
}

// The environment a config-less session in `repo` resolves to: the repo rung of
// the defaults ladder, else the account rung, else null (the basic sandbox).
// Repo names compare case-insensitively, the way GitHub treats them.
export function effectiveEnvironmentDefault(
  ladder: EnvironmentDefaults,
  repo: string | null,
): { id: string; rung: 'repo' | 'account' } | null {
  const repoRung = repo
    ? Object.entries(ladder.repositories).find(
        ([name]) => name.toLowerCase() === repo.toLowerCase(),
      )?.[1]
    : undefined
  if (repoRung) return { id: repoRung, rung: 'repo' }
  if (ladder.account) return { id: ladder.account, rung: 'account' }
  return null
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
