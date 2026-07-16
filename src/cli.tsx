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

// Bare `agent` (no args at all) drops into a fresh connected session, as a
// shorthand for `agent session start --connect`. Everything else parses
// untouched — `agent --help`/`--version` still print the full top-level help,
// and every subcommand dispatches normally.
if (process.argv.length === 2) {
  process.argv.push('session', 'start', '--connect')
}

await program.parseAsync(process.argv)
