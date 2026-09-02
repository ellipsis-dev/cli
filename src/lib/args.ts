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


function oneOf(kind: string, allowed: readonly string[], value: string): string {
  if (!allowed.includes(value)) {
    throw new InvalidArgumentError(`${kind} must be one of: ${allowed.join(', ')}`)
  }
  return value
}

// Repeatable, validated variants of `collect` for the list facets.
export function collectSource(value: string, previous: string[]): string[] {
  return [...previous, oneOf('source', SESSION_SOURCES, value)]
}

export function collectStatus(value: string, previous: string[]): string[] {
  return [...previous, oneOf('status', SESSION_STATUSES, value)]
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

// A bare `agent <text>` is shorthand for starting a session with that text as
// the prompt, so a mistyped subcommand like `agent sesion` would silently start
// a session instead of failing. Guard on shape rather than edit distance: a
// real prompt is a sentence, a typo is one word. So one bare word that is not a
// known command is treated as a mistake, even when nothing looks close to it.
// Anything with a space is a prompt, and `-p sesion` still forces it through.
export function looksLikeCommandTypo(args: string[]): boolean {
  if (args.length !== 1) return false
  const arg = args[0]
  if (arg === undefined || arg === '') return false
  // Options are commander's job, and `--` already means "the rest is a prompt".
  if (arg.startsWith('-')) return false
  return !/\s/.test(arg)
}

// The closest command names to a typo, for a "did you mean" hint. Returns the
// ties at the best distance, or nothing when the word resembles no command.
export function similarCommands(word: string, commands: string[]): string[] {
  const maxDistance = 3
  let best = maxDistance + 1
  let matches: string[] = []
  for (const command of commands) {
    // One-character names would match almost anything.
    if (command.length <= 1) continue
    const distance = editDistance(word, command)
    const length = Math.max(word.length, command.length)
    // Same bar commander uses: reject matches that share too little.
    if ((length - distance) / length <= 0.4) continue
    if (distance < best) {
      best = distance
      matches = [command]
    } else if (distance === best) {
      matches.push(command)
    }
  }
  return matches.sort((a, b) => a.localeCompare(b))
}

// Damerau-Levenshtein optimal string alignment distance.
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return Math.max(a.length, b.length)
  const d: number[][] = []
  for (let i = 0; i <= a.length; i++) d[i] = [i]
  for (let j = 0; j <= b.length; j++) d[0]![j] = j
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + cost,
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1)
      }
    }
  }
  return d[a.length]![b.length]!
}

// The message for a suspected typo. Names the fix both ways: the command they
// probably meant, and how to send the word as a prompt on purpose.
export function commandTypoMessage(word: string, commands: string[]): string {
  const similar = similarCommands(word, commands)
  const lines = [`error: unknown command "${word}"`]
  if (similar.length === 1) {
    lines.push(`  did you mean "agent ${similar[0]}"?`)
  } else if (similar.length > 1) {
    lines.push(`  did you mean one of: ${similar.map((c) => `agent ${c}`).join(', ')}?`)
  }
  lines.push(`  to start a session with that prompt: agent -p ${word}`)
  lines.push('  to see every command: agent --help')
  return lines.join('\n')
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
