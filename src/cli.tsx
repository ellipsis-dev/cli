import { Command } from 'commander'
import { registerLogin } from './commands/login'
import { registerRun } from './commands/run'
import { registerConfig } from './commands/config'
import { registerPing } from './commands/ping'
import { VERSION } from './lib/constants'

const program = new Command()

program
  .name('agent')
  .description('Ellipsis agent CLI — drive the Ellipsis cloud from your terminal')
  .version(VERSION)

registerLogin(program)
registerRun(program)
registerConfig(program)
registerPing(program)

await program.parseAsync(process.argv)
