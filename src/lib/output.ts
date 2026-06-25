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
