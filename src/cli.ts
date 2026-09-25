import { Command } from 'commander'
import { registerAuth } from './commands/auth'
import { registerHost } from './commands/host'
import { registerSession } from './commands/session'
import { registerAutomation } from './commands/automation'
import { registerEnvironment } from './commands/environment'
import { registerVariable } from './commands/variable'
import { registerTemplate } from './commands/template'
import { registerModel } from './commands/model'
import { registerIntegration } from './commands/integrations'
import { registerGithub } from './commands/github'
import { registerSlack } from './commands/slack'
import { registerLinear } from './commands/linear'
import { registerSentry } from './commands/sentry'
import { registerUsage } from './commands/usage'
import { registerAnalytics } from './commands/analytics'
import { registerUpdate } from './commands/update'
import { registerUninstall } from './commands/uninstall'
import { registerHelp } from './commands/help'
import { commandTypoMessage, looksLikeCommandTypo } from './lib/args'
import { VERSION } from './lib/constants'
import { configureCliHelp } from './lib/help'
import { maybeNudgeUpdate } from './lib/update-check'

const program = new Command()

program
  .name('ellipsis')
  .description('Ellipsis CLI: drive the Ellipsis cloud from your terminal')
  .version(VERSION)

// Set before the register* calls so every subcommand inherits the same help
// rendering (sorted, alias-free, grouped at the top level).
configureCliHelp(program)

registerAuth(program)
registerHost(program)
registerSession(program)
registerAutomation(program)
registerEnvironment(program)
registerVariable(program)
registerTemplate(program)
registerModel(program)
registerIntegration(program)
registerGithub(program)
registerSlack(program)
registerLinear(program)
registerSentry(program)
registerUsage(program)
registerAnalytics(program)
registerUpdate(program)
registerUninstall(program)
registerHelp(program)

// A bare `ellipsis` prints the top-level help, the same page as `ellipsis --help`.
//
// Any other invocation that isn't a known subcommand or a top-level
// help/version request is shorthand for `ellipsis session start ...`:
// `ellipsis "fix the tests" --model ...` forwards the prompt and every trailing
// flag through to a fresh session, which starts and prints its dashboard
// link. `ellipsis --help`, `ellipsis --version`, `ellipsis help`, and every subcommand
// dispatch unchanged.
//
// The exception is a single bare word (`ellipsis sesion`): see
// looksLikeCommandTypo. Quoting does not help, since the shell strips the
// quotes. Use `ellipsis -p word` or `ellipsis -- word` to force it through.
const topLevelCommands = new Set([
  'help',
  ...program.commands.flatMap((c) => [c.name(), ...c.aliases()]),
])
// Hidden plural aliases dispatch, but a "did you mean" hint should only ever
// name the spelling we document.
const suggestableCommands = ['help', ...program.commands.map((c) => c.name())]
// One stderr line when a newer release is known, plus the daily background
// check that learns about it. Never blocks, never fails the command.
maybeNudgeUpdate(process.argv)

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
