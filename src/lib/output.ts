// Shared output helpers so every command formats money, errors, tables, and
// structured output the same way.

import { stringify as stringifyYaml } from 'yaml'

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

export function printYaml(value: unknown): void {
  // Trailing newline is already added by console.log; trim yaml's own.
  process.stdout.write(stringifyYaml(value))
}

// Render an ISO-8601 timestamp as a compact `YYYY-MM-DD HH:MM` (UTC). The API
// returns microsecond + offset precision that's too noisy for a list.
export function formatTs(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ')
}

// Print rows as a left-aligned, space-padded table with a header row. Column
// widths fit the widest cell. Callers handle the empty case themselves.
export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  )
  const line = (cells: string[]) =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ').trimEnd()
  console.log(line(headers))
  for (const r of rows) console.log(line(r))
}

// Render an ISO-8601 timestamp as a coarse relative age ("3 days ago") for
// result lists where recency matters more than the exact instant. `now` is
// injectable for tests.
export function relativeAge(iso: string, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1000))
  if (seconds < 60) return 'just now'
  const units: Array<[number, string]> = [
    [60 * 60 * 24 * 365, 'year'],
    [60 * 60 * 24 * 30, 'month'],
    [60 * 60 * 24, 'day'],
    [60 * 60, 'hour'],
    [60, 'minute'],
  ]
  for (const [size, name] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size)
      return `${n} ${name}${n === 1 ? '' : 's'} ago`
    }
  }
  return 'just now'
}

// Backend costs are in millicents (1 cent = 1000 millicents). Render as USD.
export function usdFromMillicents(millicents: number): string {
  return `$${(millicents / 100_000).toFixed(2)}`
}

export function usd(amount: number): string {
  return `$${amount.toFixed(2)}`
}

// Wraps a command body so API/network failures print a clean message and set a
// non-zero exit code instead of dumping a stack trace.
export async function runAction(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    console.error(`error: ${(err as Error).message}`)
    process.exitCode = 1
  }
}
