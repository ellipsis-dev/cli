import type { Command } from 'commander'
import { ApiClient } from '../lib/api'
import { loadConfig, saveConfig } from '../lib/config'
import { deviceLogin, openBrowser, persistToken } from '../lib/auth'

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
            console.log('To authenticate, open this URL and approve the request:')
            console.log(`  ${start.verification_uri_complete}`)
            console.log(`Verification code: ${start.user_code}`)
            if (opts.browser !== false) {
              openBrowser(start.verification_uri_complete)
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
      console.log('Logged out.')
    })
}
