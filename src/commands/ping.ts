import type { Command } from 'commander'
import { api, APIError } from '../lib/api'
import { apiRoutes } from '../lib/help'

export function registerPing(program: Command): void {
  apiRoutes(
    program
      .command('ping')
      .description('Check that the API is reachable and the credential is valid'),
    'GET /v1/me',
  )
    .action(async () => {
      // There's no unauthenticated health route on the public API, so we probe
      // the lightest authenticated endpoint (/me): a 200 proves the API is
      // reachable AND the stored token is valid.
      try {
        const me = await api().me()
        console.log(`ok: ${me.customer_login} (${me.customer_id})`)
      } catch (err) {
        if (err instanceof APIError && err.status === 401) {
          // Reachable, just not authenticated — point the user at login.
          console.error('reachable, but not authenticated. Run `agent login` first.')
        } else if (err instanceof APIError) {
          console.error(`ping failed: ${err.status} ${err.message}`)
        } else {
          // Network/DNS/connection error: never got an HTTP response.
          console.error(`cannot reach the API: ${(err as Error).message}`)
        }
        process.exitCode = 1
      }
    })
}
