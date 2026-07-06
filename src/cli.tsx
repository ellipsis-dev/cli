import { Command } from 'commander'
import { registerLogin } from './commands/login'
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

await program.parseAsync(process.argv)
