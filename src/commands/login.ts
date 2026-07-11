import type { Command } from 'commander'
import { ApiClient } from '../lib/api'
import {
  activeHostName,
  clearActiveHostToken,
  clearAllTokens,
  resolveAppBase,
} from '../lib/config'
import { deviceLogin, openBrowser, persistToken } from '../lib/auth'
import { cliAuthUrl } from '../lib/urls'

export function registerLogin(program: Command): void {
  program
    .command('login')
    .description('Authenticate with Ellipsis via the device-code flow (against the active host)')
    .option('--no-browser', 'do not auto-open the verification URL (for headless / SSH)')
    .action(async (opts: { browser?: boolean }) => {
      const api = new ApiClient()
      try {
        const { token } = await deviceLogin(api, {
          onPrompt: (start) => {
            // Build the approval URL from the app base of the host the CLI is
            // pointed at, NOT the server's verification_uri_complete — the
            // backend defaults that to prod, so a beta / self-hosted login would
            // otherwise be sent to the prod dashboard (where the code can't be
            // approved). See cliAuthUrl / resolveAppBase.
            const verificationUrl = cliAuthUrl(resolveAppBase(), start.user_code)
            console.log('To authenticate, open this URL and approve the request:')
            console.log(`  ${verificationUrl}`)
            console.log(`Verification code: ${start.user_code}`)
            if (opts.browser !== false) {
              openBrowser(verificationUrl)
            }
            console.log('Waiting for approval…')
          },
        })
        persistToken(token)
        console.log('✓ Logged in.')
      } catch (err) {
        console.error(`login failed: ${(err as Error).message}`)
        process.exitCode = 1
      }
    })

  program
    .command('logout')
    .description('Remove stored credentials (the active host, or --all hosts)')
    .option('--all', 'clear the stored token for every host, not just the active one')
    .action((opts: { all?: boolean }) => {
      // Clear only the on-disk token(s); the host entries (api/app base) stay so
      // the next `agent login` targets the same instance.
      if (opts.all) {
        clearAllTokens()
      } else {
        clearActiveHostToken()
      }
      // A token supplied via ELLIPSIS_API_TOKEN (e.g. inside a sandbox) lives in
      // the environment and keeps working — don't claim to have cleared what we
      // can't.
      const envNote = process.env.ELLIPSIS_API_TOKEN
        ? ' ELLIPSIS_API_TOKEN is still set in the environment, so that session stays active until it is unset.'
        : ''
      const scope = opts.all
        ? 'all hosts'
        : (activeHostName() ?? 'the active host')
      console.log(`Removed stored credentials for ${scope}.${envNote}`)
    })
}
