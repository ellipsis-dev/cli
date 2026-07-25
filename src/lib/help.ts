import { Help, type Command } from 'commander'

// Help rendering rules for the whole CLI. The audience is a coding agent
// reading `--help` to decide its next call, so the surface it sees must be one
// spelling per concept: singular nouns, no alias clutter, no transport detail
// in the one-line description.

// The one shown spelling of every command is its singular name; plurals and
// short forms stay callable as aliases but are never rendered (see
// `alsoKnownAs`). Overriding these two Help methods is what makes an alias
// invisible: commander otherwise prints `name|alias` in both places.
function withoutAliases(term: string, cmd: Command): string {
  const alias = cmd.aliases()[0]
  return alias ? term.replace(`${cmd.name()}|${alias}`, cmd.name()) : term
}

// Top-level commands, grouped by what the caller is trying to do. A command
// missing from every group still renders (under "Other") rather than silently
// vanishing from help.
const TOP_LEVEL_GROUPS: ReadonlyArray<{ title: string; commands: readonly string[] }> = [
  { title: 'Sessions', commands: ['session', 'review'] },
  { title: 'Agents', commands: ['config', 'model', 'template'] },
  { title: 'Platform', commands: ['sandbox', 'asset', 'hook'] },
  { title: 'Integrations', commands: ['integration', 'github', 'slack', 'linear', 'sentry'] },
  { title: 'Spend', commands: ['budget', 'usage', 'analytics'] },
  { title: 'Account', commands: ['login', 'logout', 'me', 'host', 'ping'] },
]

export function configureCliHelp(program: Command): void {
  program.configureHelp({
    sortSubcommands: true,
    subcommandTerm(cmd: Command) {
      return withoutAliases(Help.prototype.subcommandTerm.call(this, cmd), cmd)
    },
    commandUsage(cmd: Command) {
      return withoutAliases(Help.prototype.commandUsage.call(this, cmd), cmd)
    },
    formatHelp(cmd: Command, helper: Help) {
      if (cmd.parent) return Help.prototype.formatHelp.call(helper, cmd, helper)
      return formatTopLevelHelp(cmd, helper)
    },
  })
}

// `agent --help`: same layout commander produces, except the flat 20-command
// list is split into task groups so a caller can find the right group without
// reading every description.
function formatTopLevelHelp(cmd: Command, helper: Help): string {
  const termWidth = helper.padWidth(cmd, helper)
  const indent = 2
  const gap = 2
  // `|| 80`, not `??`: a TTY can report columns as 0, which would disable
  // wrapping entirely rather than falling back to the default width.
  const helpWidth = helper.helpWidth || 80
  const item = (term: string, description: string): string =>
    description
      ? helper.wrap(
          `${term.padEnd(termWidth + gap)}${description}`,
          helpWidth - indent,
          termWidth + gap,
        )
      : term
  const block = (lines: string[]): string =>
    lines.join('\n').replace(/^/gm, ' '.repeat(indent))

  const out = [`Usage: ${helper.commandUsage(cmd)}`, '']
  const description = helper.commandDescription(cmd)
  if (description) out.push(helper.wrap(description, helpWidth, 0), '')

  const options = helper
    .visibleOptions(cmd)
    .map((o) => item(helper.optionTerm(o), helper.optionDescription(o)))
  if (options.length) out.push('Options:', block(options), '')

  const ungrouped = new Map(helper.visibleCommands(cmd).map((c) => [c.name(), c]))
  const rowsFor = (names: readonly string[]): string[] =>
    names.flatMap((name) => {
      const sub = ungrouped.get(name)
      if (!sub) return []
      ungrouped.delete(name)
      return [item(helper.subcommandTerm(sub), helper.subcommandDescription(sub))]
    })
  for (const group of TOP_LEVEL_GROUPS) {
    const rows = rowsFor(group.commands)
    if (rows.length) out.push(`${group.title}:`, block(rows), '')
  }
  const rest = rowsFor([...ungrouped.keys()])
  if (rest.length) out.push('Other:', block(rest), '')

  return out.join('\n')
}

// Extra spellings that keep working but never show in help: the plural of a
// singular command name, and the short forms people type from muscle memory.
export function alsoKnownAs(cmd: Command, ...aliases: string[]): Command {
  for (const alias of aliases) cmd.alias(alias)
  return cmd
}

// The REST routes a command calls, appended to its long help. Descriptions
// stay about intent; the transport detail is one `--help` away for a caller
// that needs to reach the same data directly.
export function apiRoutes(cmd: Command, ...routes: string[]): Command {
  return cmd.addHelpText('after', `\nAPI: ${routes.join(', ')}`)
}
