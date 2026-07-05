import { Command } from 'commander'
import { registerLogin } from './commands/login'
import { registerMe } from './commands/me'
import { registerSession } from './commands/session'
import { registerConfig } from './commands/config'
import { registerSandbox } from './commands/sandbox'
import { registerTemplate } from './commands/template'
import { registerUsage } from './commands/usage'
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
registerTemplate(program)
registerUsage(program)
registerPing(program)

await program.parseAsync(process.argv)
