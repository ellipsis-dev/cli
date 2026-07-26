// marked-terminal ships no types. The CLI uses one export, and marked's
// `use()` takes an opaque extension object, so the shape only needs to be
// nominal.
declare module 'marked-terminal' {
  export function markedTerminal(options?: Record<string, unknown>): unknown
}
