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

const program = new Command()

program
  .name('agent')
  .description('Ellipsis agent CLI: drive the Ellipsis cloud from your terminal')
  .version(VERSION)

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

// Any invocation that isn't a known subcommand or a top-level help/version
// request is shorthand for `agent session start --connect ...`. So a bare
// `agent`, and `agent "fix the tests" --model ...`, both forward the prompt
// and every trailing flag through to a fresh connected session. A bare
// `agent` starts the session idle (idle_start): the sandbox spins up and
// Claude Code waits for the first thing typed into the composer, like a
// local `claude`. `agent --help`, `agent --version`, `agent help`, and every
// subcommand dispatch unchanged.
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
if (!isTopLevel) {
  process.argv.splice(2, 0, 'session', 'start', '--connect')
}

await program.parseAsync(process.argv)
