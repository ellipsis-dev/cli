import { InvalidArgumentError } from 'commander'

// commander option coercions. These get called as (value, previous), so a bare
// `parseInt` would treat `previous` as the radix — hence the explicit parsers.
// Kept out of the command modules so they're unit-testable without pulling in
// ink/React.

// Append a repeated `--flag a --flag b` option into an array.
export function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

// Parse a base-10 integer, rejecting anything non-integer up front.
export function toInt(value: string): number {
  // Number('') and Number('  ') are 0, which would silently swallow an empty
  // flag value — reject it explicitly rather than defaulting to zero.
  const n = value.trim() === '' ? NaN : Number(value)
  if (!Number.isInteger(n)) {
    throw new InvalidArgumentError(`expected an integer, got "${value}"`)
  }
  return n
}

// Parse a decimal number (allows fractions, e.g. cpu 0.5 or a 0.50 budget),
// rejecting non-numeric input up front.
export function toNumber(value: string): number {
  const n = value.trim() === '' ? NaN : Number(value)
  if (!Number.isFinite(n)) {
    throw new InvalidArgumentError(`expected a number, got "${value}"`)
  }
  return n
}

// Values the server accepts for the session facets, mirrored here so a typo
// fails fast with the full list instead of a server-side 422.
export const SESSION_SOURCES = [
  'laptop',
  'react',
  'manual',
  'api',
  'cli',
  'mention',
  'cron',
] as const

export const SESSION_STATUSES = [
  'scheduled',
  'creating_sandbox',
  'running',
  'retrying',
  'completed',
  'error',
  'cancelled',
  'stopped',
] as const

export const SEARCH_SCOPES = ['steps', 'recaps', 'both'] as const

function oneOf(kind: string, allowed: readonly string[], value: string): string {
  if (!allowed.includes(value)) {
    throw new InvalidArgumentError(`${kind} must be one of: ${allowed.join(', ')}`)
  }
  return value
}

// Repeatable, validated variants of `collect` for the search facets.
export function collectSource(value: string, previous: string[]): string[] {
  return [...previous, oneOf('source', SESSION_SOURCES, value)]
}

export function collectStatus(value: string, previous: string[]): string[] {
  return [...previous, oneOf('status', SESSION_STATUSES, value)]
}

export function parseScope(value: string): string {
  return oneOf('scope', SEARCH_SCOPES, value)
}

// Parse a time-window flag: an ISO 8601 timestamp passed through verbatim, or
// the natural forms "today", "yesterday", and "N days ago" resolved to the
// start of that day (local time). `now` is injectable for tests.
export function parseWhen(value: string, now: Date = new Date()): string {
  const text = value.trim().toLowerCase()
  let daysBack: number | undefined
  if (text === 'today') daysBack = 0
  if (text === 'yesterday') daysBack = 1
  const match = text.match(/^(\d+) days? ago$/)
  if (match) daysBack = Number(match[1])
  if (daysBack !== undefined) {
    const day = new Date(now)
    day.setDate(day.getDate() - daysBack)
    day.setHours(0, 0, 0, 0)
    return day.toISOString()
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new InvalidArgumentError(
      `expected an ISO 8601 timestamp, "today", "yesterday", or "N days ago", got "${value}"`,
    )
  }
  return value
}

// Accumulate repeated `key=value` options into an object.
export function collectKeyValue(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const eq = value.indexOf('=')
  if (eq === -1) {
    throw new InvalidArgumentError(`metadata must be key=value, got "${value}"`)
  }
  return { ...previous, [value.slice(0, eq)]: value.slice(eq + 1) }
}
