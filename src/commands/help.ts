import type { Command } from 'commander'
import { ApiClient, ApiError } from '../lib/api'
import { apiRoutes } from '../lib/help'
import { runAction } from '../lib/output'
import { repoFromCwd } from '../lib/laptop'
import { startConnect } from './session'
import type { StartAgentSessionRequest } from '../lib/types'

// The template behind `agent help --interactive`. Kebab-case like every other
// slug in the registry; it is not served yet, so a 404 here is expected and
// gets its own message rather than a raw HTTP failure.
const HELPER_TEMPLATE_SLUG = 'ellipsis-helper'

// Replaces commander's built-in `help` command so `--interactive` can hang off
// it. Everything the built-in did must keep working: `agent help` prints the
// top-level help, `agent help <command>` prints that subcommand's. Note the
// built-in only ever resolved ONE level ("help session start" printed
// session's help); this walks the whole path, which is a strict improvement.
export function registerHelp(program: Command): void {
  apiRoutes(
    program
      .command('help')
      .description('Show help for a command, or ask the help agent with --interactive'),
    'POST /v1/sessions with --interactive',
  )
    .argument('[command...]', 'command to show help for (e.g. `session start`)')
    .option(
      '-i, --interactive',
      'start a cloud session with the Ellipsis help agent and open the conversation',
    )
    .action(async (path: string[], opts: { interactive?: boolean }) => {
      if (opts.interactive) {
        if (path.length > 0) {
          console.error('error: --interactive takes no command argument')
          process.exitCode = 1
          return
        }
        await runAction(startHelperSession)
        return
      }
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
// too so `agent help sessions` resolves the same as `agent help session`.
export function resolveCommandPath(program: Command, path: string[]): Command | undefined {
  let cmd: Command = program
  for (const name of path) {
    const next = cmd.commands.find((c) => c.name() === name || c.aliases().includes(name))
    if (!next) return undefined
    cmd = next
  }
  return cmd
}

async function startHelperSession(): Promise<void> {
  const req: StartAgentSessionRequest = { template_id: HELPER_TEMPLATE_SLUG }
  // Same as `session start`: send the repo we're standing in so the helper can
  // answer questions about this checkout. Ignored server-side if unknown.
  const contextRepo = repoFromCwd(process.cwd())
  if (contextRepo) req.repository = contextRepo
  // No prompt: the helper opens idle and waits for the question, like a bare
  // `agent`, rather than running a workflow against a fabricated kickoff.
  req.idle_start = true

  const api = new ApiClient()
  try {
    const session = await api.startAgentSession(req)
    await startConnect(session, 'Ellipsis help agent')
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new Error(
        `the help agent is not available on this host yet (template "${HELPER_TEMPLATE_SLUG}" not found). Run \`agent template list\` to see what you can start.`,
      )
    }
    throw err
  }
}
