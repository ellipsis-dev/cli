import { Command } from 'commander'
import { registerLogin } from './commands/login'
import { registerHost } from './commands/host'
import { registerMe } from './commands/me'
import { registerSession } from './commands/session'
import { registerConfig } from './commands/config'
import { registerSandbox } from './commands/sandbox'
import { registerAsset } from './commands/asset'
import { registerHooks } from './commands/hooks'
import { registerTemplate } from './commands/template'
import { registerIntegrations } from './commands/integrations'
import { registerGithub } from './commands/github'
import { registerSlack } from './commands/slack'
import { registerLinear } from './commands/linear'
import { registerSentry } from './commands/sentry'
import { registerUsage } from './commands/usage'
import { registerAnalytics } from './commands/analytics'
import { registerPing } from './commands/ping'
import { VERSION } from './lib/constants'
import { canHostSessionsUi, defaultStartRequest, runSessionsUi } from './ui/launch'

const program = new Command()

program
  .name('agent')
  .description('Ellipsis agent CLI: drive the Ellipsis cloud from your terminal')
  .version(VERSION)
  // Set before the register* calls so every subcommand inherits it and lists
  // its own subcommands alphabetically too.
  .configureHelp({ sortSubcommands: true })

registerLogin(program)
registerHost(program)
registerMe(program)
registerSession(program)
registerConfig(program)
registerSandbox(program)
registerAsset(program)
registerHooks(program)
registerTemplate(program)
registerIntegrations(program)
registerGithub(program)
registerSlack(program)
registerLinear(program)
registerSentry(program)
registerUsage(program)
registerAnalytics(program)
registerPing(program)

// A bare `agent` opens the multi-session UI: the sidebar of your running
// sessions beside a new-session composer — nothing starts until you type a
// task and hit enter. (Headless callers with no TTY get the old behavior of
// an idle connected start via the shorthand below.)
//
// Any other invocation that isn't a known subcommand or a top-level
// help/version request is shorthand for `agent session start --connect ...`:
// `agent "fix the tests" --model ...` forwards the prompt and every trailing
// flag through to a fresh connected session, which opens in the same UI.
// `agent --help`, `agent --version`, `agent help`, and every subcommand
// dispatch unchanged.
const topLevelCommands = new Set([
  'help',
  ...program.commands.flatMap((c) => [c.name(), ...c.aliases()]),
])
const first = process.argv[2]
const isTopLevel =
  first === '-h' ||
  first === '--help' ||
  first === '-V' ||
  first === '--version' ||
  (first !== undefined && topLevelCommands.has(first))
if (first === undefined && canHostSessionsUi()) {
  const { runAction } = await import('./lib/output')
  await runAction(() =>
    runSessionsUi({ buildStartRequest: defaultStartRequest }),
  )
} else {
  if (!isTopLevel) {
    process.argv.splice(2, 0, 'session', 'start', '--connect')
  }
  await program.parseAsync(process.argv)
}
