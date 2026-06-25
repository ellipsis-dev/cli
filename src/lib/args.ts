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
