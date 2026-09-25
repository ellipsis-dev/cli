import type { Command } from 'commander'

// Replaces commander's built-in `help` command. Everything the built-in did
// must keep working: `ellipsis help` prints the top-level help, `ellipsis help
// <command>` prints that subcommand's. Note the built-in only ever resolved
// ONE level ("help session start" printed session's help); this walks the
// whole path, which is a strict improvement.
export function registerHelp(program: Command): void {
  program
    .command('help')
    .description('Show help for a command')
    .argument('[command...]', 'command to show help for (e.g. `session start`)')
    .action((path: string[]) => {
      const target = resolveCommandPath(program, path)
      if (!target) {
        console.error(`error: unknown command '${path.join(' ')}'`)
        process.exitCode = 1
        return
      }
      // outputHelp(), not helpInformation(): the latter renders only the
      // built-in sections and would silently drop every command's trailing
      // `API:` line, which addHelpText contributes.
      target.outputHelp()
    })
}

// Walk a command path ("session start") down the tree, matching hidden aliases
// too so `ellipsis help sessions` resolves the same as `ellipsis help session`.
export function resolveCommandPath(program: Command, path: string[]): Command | undefined {
  let cmd: Command = program
  for (const name of path) {
    const next = cmd.commands.find((c) => c.name() === name || c.aliases().includes(name))
    if (!next) return undefined
    cmd = next
  }
  return cmd
}
