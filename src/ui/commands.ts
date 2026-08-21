// The composer's slash commands, and the autocomplete menu over them.
//
// A slash command is an instruction to the CLI, not a message to the agent, so
// the two are kept apart by a rule rather than by guesswork: a line whose FIRST
// character is `/` is a command, and an unknown one is refused instead of being
// forwarded. Silently sending "/stpo" to the agent as prose is the failure mode
// that rule exists to prevent.

export type CommandId = 'stop' | 'sessions' | 'exit'

export type SlashCommand = {
  id: CommandId
  // What you type, without the leading slash.
  name: string
  // Extra spellings that select the same command. Not shown in the menu.
  aliases?: readonly string[]
  // The one-line description in the menu, lowercase and imperative.
  detail: string
}

// Every command, in menu order: the one that acts on the session first, then the
// screen, then the way out.
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: 'stop', name: 'stop', detail: 'interrupt the agent, keeping the conversation' },
  { id: 'sessions', name: 'sessions', detail: 'switch sessions (esc)' },
  { id: 'exit', name: 'exit', aliases: ['quit'], detail: 'leave the CLI; the session keeps running' },
]

// Whether this input is addressed to the CLI rather than the agent. Deliberately
// strict about position: a `/` anywhere else is ordinary prose ("check /tmp"),
// and only a leading one claims the line. Pure, for tests.
export function isCommandInput(text: string): boolean {
  return text.startsWith('/')
}

// The commands a partially typed `/word` should offer, in menu order.
//
// PREFIX matching, not fuzzy or substring: the list is short and the names are
// short, so a prefix is enough to get you there in two or three keystrokes, and
// it never surprises you with a command whose name you did not start typing.
// Aliases match too (so `/qu` finds exit) but the canonical name is what shows.
// A bare `/` offers everything. Pure, for tests.
export function matchCommands(text: string): SlashCommand[] {
  if (!isCommandInput(text)) return []
  const typed = text.slice(1).toLowerCase()
  // Only the first word is the command; once you have typed a space you have
  // committed to one, and the menu has nothing left to offer.
  if (/\s/.test(typed)) return []
  if (typed === '') return [...SLASH_COMMANDS]
  return SLASH_COMMANDS.filter((c) =>
    [c.name, ...(c.aliases ?? [])].some((n) => n.startsWith(typed)),
  )
}

// The command an entered line names, or null when it names none — which the
// caller reports as an error rather than sending on. Exact match on the name or
// an alias, case-insensitively; a prefix is NOT enough here, because running the
// wrong command is worse than being told to finish typing. Pure, for tests.
export function resolveCommand(text: string): SlashCommand | null {
  if (!isCommandInput(text)) return null
  const typed = text.slice(1).trim().toLowerCase()
  return (
    SLASH_COMMANDS.find((c) => [c.name, ...(c.aliases ?? [])].includes(typed)) ?? null
  )
}

// The text the composer holds after tab/enter completes `highlighted`: the whole
// command, with a trailing space so the line reads as finished. Pure, for tests.
export function completedText(command: SlashCommand): string {
  return `/${command.name} `
}
