import { Command } from 'commander'
import { registerLogin } from './commands/login'
import { registerMe } from './commands/me'
import { registerRun } from './commands/run'
import { registerConfig } from './commands/config'
import { registerUsage } from './commands/usage'
import { registerPing } from './commands/ping'
import { VERSION } from './lib/constants'

const program = new Command()

program
  .name('agent')
  .description('Ellipsis agent CLI — drive the Ellipsis cloud from your terminal')
  .version(VERSION)

registerLogin(program)
registerMe(program)
registerRun(program)
registerConfig(program)
registerUsage(program)
registerPing(program)

await program.parseAsync(process.argv)
