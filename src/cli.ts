import { Command } from 'commander'
import { registerInstall } from './commands/install'
import { registerLogin } from './commands/login'
import { registerHost } from './commands/host'
import { registerMe } from './commands/me'
import { registerSession } from './commands/session'
import { registerReview } from './commands/review'
import { registerAutomation } from './commands/automation'
import { registerEnvironment } from './commands/environment'
import { registerVariable } from './commands/variable'
import { registerFile } from './commands/file'
import { registerTemplate } from './commands/template'
import { registerModel } from './commands/model'
import { registerIntegration } from './commands/integrations'
import { registerGithub } from './commands/github'
import { registerSlack } from './commands/slack'
import { registerLinear } from './commands/linear'
import { registerSentry } from './commands/sentry'
import { registerUsage } from './commands/usage'
import { registerAnalytics } from './commands/analytics'
import { registerPing } from './commands/ping'
import { registerHelp } from './commands/help'
import { commandTypoMessage, looksLikeCommandTypo } from './lib/args'
import { VERSION } from './lib/constants'
import { configureCliHelp } from './lib/help'

const program = new Command()

program
  .name('agent')
  .description('Ellipsis agent CLI: drive the Ellipsis cloud from your terminal')
  .version(VERSION)

// Set before the register* calls so every subcommand inherits the same help
// rendering (sorted, alias-free, grouped at the top level).
configureCliHelp(program)

registerInstall(program)
registerLogin(program)
registerHost(program)
registerMe(program)
registerSession(program)
registerReview(program)
registerAutomation(program)
registerEnvironment(program)
registerVariable(program)
registerFile(program)
registerTemplate(program)
registerModel(program)
registerIntegration(program)
registerGithub(program)
registerSlack(program)
registerLinear(program)
registerSentry(program)
registerUsage(program)
registerAnalytics(program)
registerPing(program)
registerHelp(program)

// A bare `agent` prints the top-level help, the same page as `agent --help`.
//
// Any other invocation that isn't a known subcommand or a top-level
// help/version request is shorthand for `agent session start ...`:
// `agent "fix the tests" --model ...` forwards the prompt and every trailing
// flag through to a fresh session, which starts and prints its dashboard
// link. `agent --help`, `agent --version`, `agent help`, and every subcommand
// dispatch unchanged.
//
// The exception is a single bare word (`agent sesion`): see
// looksLikeCommandTypo. Quoting does not help, since the shell strips the
// quotes. Use `agent -p word` or `agent -- word` to force it through.
const topLevelCommands = new Set([
  'help',
  ...program.commands.flatMap((c) => [c.name(), ...c.aliases()]),
])
// Hidden plural aliases dispatch, but a "did you mean" hint should only ever
// name the spelling we document.
const suggestableCommands = ['help', ...program.commands.map((c) => c.name())]
const first = process.argv[2]
const isTopLevel =
  first === '-h' ||
  first === '--help' ||
  first === '-V' ||
  first === '--version' ||
  (first !== undefined && topLevelCommands.has(first))
if (first === undefined) {
  program.outputHelp()
} else {
  if (!isTopLevel) {
    // One bare word is far more likely a mistyped command than a prompt, so
    // stop instead of starting a session nobody asked for.
    const rest = process.argv.slice(2)
    if (looksLikeCommandTypo(rest)) {
      console.error(commandTypoMessage(rest[0]!, suggestableCommands))
      process.exit(1)
    }
    process.argv.splice(2, 0, 'session', 'start')
  }
  await program.parseAsync(process.argv)
}
