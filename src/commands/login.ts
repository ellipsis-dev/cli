import type { Command } from 'commander'
import { saveConfig } from '../lib/config'
import { APP_BASE } from '../lib/constants'

export function registerLogin(program: Command): void {
  program
    .command('login')
    .description('Authenticate with Ellipsis')
    .option('--device', 'use device-code flow (for headless / SSH sessions)')
    .action(async (opts: { device?: boolean }) => {
      // TODO(auth): real OAuth.
      //   default  -> open browser to APP_BASE/cli-auth, listen on a
      //               localhost callback, capture the returned token.
      //   --device -> print a user code + verification URL, poll for the token.
      // Token then goes through saveConfig() (and, later, the OS keychain).
      if (opts.device) {
        console.log(`Device login not implemented yet. Visit ${APP_BASE}/cli-auth`)
      } else {
        console.log(`Browser login not implemented yet. Would open ${APP_BASE}/cli-auth`)
      }
    })

  program
    .command('logout')
    .description('Remove stored credentials')
    .action(() => {
      saveConfig({})
      console.log('Logged out.')
    })
}
