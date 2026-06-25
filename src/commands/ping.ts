import type { Command } from 'commander'
import { ApiClient, ApiError } from '../lib/api'

export function registerPing(program: Command): void {
  program
    .command('ping')
    .description('Check authenticated connectivity to the Ellipsis /v1 API')
    .action(async () => {
      // There's no unauthenticated health route on the public API, so we probe
      // the lightest authenticated endpoint (/v1/me): a 200 proves the API is
      // reachable AND the stored token is valid.
      const api = new ApiClient()
      try {
        const me = await api.whoami()
        console.log(`ok — ${me.customer_login} (${me.customer_id})`)
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          // Reachable, just not authenticated — point the user at login.
          console.error('reachable, but not authenticated. Run `agent login` first.')
        } else if (err instanceof ApiError) {
          console.error(`ping failed: ${err.status} ${err.message}`)
        } else {
          // Network/DNS/connection error: never got an HTTP response.
          console.error(`cannot reach the API: ${(err as Error).message}`)
        }
        process.exitCode = 1
      }
    })
}
