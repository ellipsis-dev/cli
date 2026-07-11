import type { Command } from 'commander'
import { ApiClient } from '../lib/api'
import { loadConfig, resolveAppBase, saveConfig } from '../lib/config'
import { deviceLogin, openBrowser, persistToken } from '../lib/auth'
import { cliAuthUrl } from '../lib/urls'

export function registerLogin(program: Command): void {
  program
    .command('login')
    .description('Authenticate with Ellipsis via the device-code flow')
    .option('--no-browser', 'do not auto-open the verification URL (for headless / SSH)')
    .action(async (opts: { browser?: boolean }) => {
      const api = new ApiClient()
      try {
        const { token } = await deviceLogin(api, {
          onPrompt: (start) => {
            // Build the approval URL from the app base derived from OUR api base,
            // not the server's verification_uri_complete — the backend defaults
            // that to prod, so a beta/dev login would otherwise be sent to the
            // prod dashboard (where the code can't be approved). See cliAuthUrl.
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
    .description('Remove stored credentials')
    .action(() => {
      // Drop the token but keep apiBase so the next login targets the same API.
      const { apiBase } = loadConfig()
      saveConfig(apiBase ? { apiBase } : {})
      // logout only clears the on-disk token. A token supplied via
      // ELLIPSIS_API_TOKEN (e.g. inside a sandbox) lives in the environment and
      // keeps working — don't claim to have cleared what we can't.
      if (process.env.ELLIPSIS_API_TOKEN) {
        console.log(
          'Removed stored credentials. ELLIPSIS_API_TOKEN is still set in the environment, so that session stays active until it is unset.',
        )
      } else {
        console.log('Logged out.')
      }
    })
}
