// Shared output helpers so every command formats money, errors, and --json
// output the same way.

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
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
